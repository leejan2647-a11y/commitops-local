"""Optional monthly facts over canonical rows, independent of normal check windows."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import duckdb

from app.growth.contracts import (
    MAX_BYTES, MAX_GROUPS, MAX_SAFE_CENTS, MAX_SOURCES, GrowthCapture, GrowthGroup,
    GrowthMonthObservation, GrowthSource, month_end, reason, resolve_growth_periods,
    shift_month, utc,
)
from app.pipeline.money import cents, precise

USAGE_TYPES = ('Usage', 'DiscountedUsage', 'SavingsPlanCoveredUsage')


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _quoted(name):
    return '"' + name.replace('"', '""') + '"'


def _text(columns, *names):
    present = [f"NULLIF(trim(CAST({_quoted(n)} AS VARCHAR)), '')" for n in names if n in columns]
    return 'COALESCE(' + ', '.join(present + ["''"]) + ')' if present else "''"


def _view(con):
    columns = {r[0] for r in con.execute('DESCRIBE cur').fetchall()}
    fields = {
        'account':('lineItem/UsageAccountId',), 'payer':('bill/PayerAccountId',),
        'service':('product/ServiceCode','lineItem/ProductCode','product/ProductName'),
        'region':('product/Region','product/region'), 'usage_type':('lineItem/UsageType',),
        'operation':('lineItem/Operation',), 'sku':('product/Sku','product/sku'),
        'unit':('pricing/unit','pricing_unit','product/PricingUnit'),
        'kind':('lineItem/LineItemType',), 'currency':('lineItem/CurrencyCode',),
    }
    units = [_text(columns, n) for n in fields['unit'] if n in columns]
    conflicts = [f"({a}<>'' AND {b}<>'' AND {a}<>{b})" for i,a in enumerate(units) for b in units[i+1:]]
    parts = [f'{_text(columns,*names)} AS {alias}' for alias,names in fields.items()]
    # DuckDB rounds casts with excess fractional precision. Check the exact
    # effective scale, including scientific notation, before the bounded cast.
    quantity='NULL::DECIMAL(38,18)'
    if 'lineItem/UsageAmount' in columns:
        raw='trim(CAST("lineItem/UsageAmount" AS VARCHAR))'
        fraction=f"length(regexp_extract({raw}, '[.]([0-9]*)', 1))"
        digits=f"replace(regexp_extract({raw}, '^[+-]?([0-9]*[.]?[0-9]*)', 1), '.', '')"
        trailing=f"(length({digits})-length(rtrim({digits}, '0')))"
        exponent=f"COALESCE(TRY_CAST(NULLIF(regexp_extract({raw}, '[eE]([+-]?[0-9]+)', 1), '') AS INTEGER), 0)"
        quantity=(f"CASE WHEN regexp_full_match({raw}, '[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]{{1,3}})?') "
            f"AND (regexp_full_match({digits}, '0+') OR {fraction}-({exponent})-{trailing}<=18) "
            'THEN TRY_CAST("lineItem/UsageAmount" AS DECIMAL(38,18)) END')
    con.execute('CREATE OR REPLACE TEMP VIEW _growth_input AS SELECT '+','.join(parts)+', '
        'TRY_CAST("lineItem/UsageStartDate" AS TIMESTAMPTZ) AT TIME ZONE \'UTC\' AS starts, '
        'TRY_CAST("lineItem/UsageEndDate" AS TIMESTAMPTZ) AT TIME ZONE \'UTC\' AS ends, '
        'TRY_CAST("lineItem/UnblendedCost" AS DECIMAL(38,10))*100 AS cost, '
        f'{quantity} AS qty, '+(' OR '.join(conflicts) if conflicts else 'false')+' AS unit_conflict, '
        '_commitops_source AS src, _commitops_role AS role FROM cur')


def _unavailable(month, code, message):
    # No incomplete evidence list or truncated number masquerades as a result.
    return GrowthMonthObservation(month=month.month, role=month.role, captured_at=month.captured_at,
        explicit_baseline=month.explicit_baseline, source_digest=month.source_digest,
        reasons=[reason(code,message)])


@precise
def _month(con, source_map, month, role, as_of, explicit_baseline):
    end = shift_month(month,1)
    start_at = datetime(month.year,month.month,1)
    end_at = datetime(end.year,end.month,1)
    clock = utc(as_of).replace(tzinfo=None)
    clause = 'role=? AND starts>=? AND starts<?'
    params = [role,start_at,end_at]
    stats = con.execute('SELECT count(*),sum(cost),count(*) FILTER(WHERE cost IS NULL),'
        "count(*) FILTER(WHERE currency<>'USD'),"
        'count(*) FILTER(WHERE ends IS NULL OR ends<=starts OR ends>? OR starts>?),'
        'max(ends) FILTER(WHERE ends<=?),list(DISTINCT account),list(DISTINCT payer) '
        'FROM _growth_input WHERE '+clause,[end_at,clock,clock]+params).fetchone()
    count,exact,bad_cost,bad_currency,bad_intervals,latest,accounts,payers = stats
    if not count: return None
    value = GrowthMonthObservation(month=month,role=role,captured_at=as_of,
        explicit_baseline=explicit_baseline, canonical_rows=count,
        latest_source_at=latest.replace(tzinfo=timezone.utc) if latest else None,
        account_scope=sorted(set(accounts or [])),payer_scope=sorted(p for p in set(payers or []) if p))
    source_stats = dict(con.execute('SELECT src,count(*) FROM _growth_input WHERE '+clause+' GROUP BY src',params).fetchall())
    raw = con.execute('SELECT _commitops_source,count(*) FROM _commitops_raw '
        "WHERE _commitops_role=? AND TRY_CAST(\"lineItem/UsageStartDate\" AS TIMESTAMPTZ) AT TIME ZONE 'UTC'>=? "
        "AND TRY_CAST(\"lineItem/UsageStartDate\" AS TIMESTAMPTZ) AT TIME ZONE 'UTC'<? GROUP BY _commitops_source",params).fetchall()
    if len(raw)>MAX_SOURCES:
        return _unavailable(value,'growth_source_limit','Monthly source evidence exceeds the 256-file bound.')
    sources=[]
    for ordinal,raw_count in sorted(raw):
        source=source_map.get((role,ordinal))
        if source is None:
            return _unavailable(value,'growth_source_unverified','A contributing file has no verified upload identity.')
        retained=source_stats.get(ordinal,0)
        sources.append(source.model_copy(update={'raw_rows':raw_count,'canonical_rows':retained,
            'removed_copy_rows':raw_count-retained}))
    value.sources=sources
    value.raw_rows=sum(s.raw_rows for s in sources)
    value.removed_copy_rows=value.raw_rows-count
    value.source_digest=digest(sorted((str(s.upload_id),s.sha256,s.role) for s in sources))
    value.scope_hash=digest([value.account_scope,value.payer_scope,'USD','unblended'])
    if bad_cost or bad_currency or bad_intervals:
        code='growth_currency_unsupported' if bad_currency else 'growth_interval_unsupported' if bad_intervals else 'growth_money_invalid'
        value.reasons=[reason(code,'Monthly amounts require valid USD rows with supported non-crossing source intervals.')]
        return value
    money=cents(exact)
    if abs(money)>MAX_SAFE_CENTS:
        value.reasons=[reason('growth_amount_out_of_range','Monthly charges exceed the exact browser integer range.')]
        return value
    value.currency='USD';value.charge_cents=money;value.exact_charge_cents=str(exact)
    # Coverage is per account and uses actual intervals; never fills absent dates.
    covered={account:set() for account in value.account_scope}
    usage_sql="kind IN ('Usage','DiscountedUsage','SavingsPlanCoveredUsage')"
    intervals=con.execute('SELECT account,CAST(starts AS DATE),CAST(ends-INTERVAL 1 MICROSECOND AS DATE) '
        'FROM _growth_input WHERE '+clause+' AND '+usage_sql+' AND ends<=? GROUP BY ALL',params+[clock]).fetchall()
    for account,first,last in intervals:
        for offset in range((last-first).days+1): covered[account].add(first+timedelta(days=offset))
    expected={month+timedelta(days=i) for i in range((end-month).days)}
    observed=set.intersection(*covered.values()) if covered else set()
    value.observed_days=sorted(observed & expected)
    value.missing_days=sorted(expected-observed)
    complete=not value.missing_days and as_of.date()>=end and bool(covered)
    value.status='available' if complete else 'partial'
    value.complete=complete
    if not value.complete:
        value.reasons.append(reason('growth_period_incomplete',
            'A completed calendar month with observations on every measured account/date is required for growth.'))
    group_rows=con.execute('SELECT payer,account,service,region,usage_type,operation,sku,unit,kind,'
        'sum(qty),sum(cost),count(*),list(DISTINCT src),'
        "count(*) FILTER(WHERE qty IS NULL OR qty<0 OR unit='' OR unit_conflict OR account='' OR service='' OR usage_type='') "
        'FROM _growth_input WHERE '+clause+' AND '+usage_sql+
        ' GROUP BY payer,account,service,region,usage_type,operation,sku,unit,kind '
        'ORDER BY payer,account,service,region,usage_type,operation,sku,unit,kind LIMIT ?',params+[MAX_GROUPS+1]).fetchall()
    if len(group_rows)>MAX_GROUPS:
        return _unavailable(value,'growth_group_limit','Monthly usage evidence exceeds the 10,000-group bound.')
    value.groups=[GrowthGroup(key=tuple(r[:9]),quantity=str(r[9]) if r[9] is not None and not r[13] else None,
        charge_cents=str(r[10]),rows=r[11],source_ordinals=sorted(r[12]),valid=not bool(r[13])) for r in group_rows]
    value.usage_samples=sorted(value.groups,key=lambda g:(-abs(Decimal(g.charge_cents)),g.key))[:20]
    value.usage_group_count=len(value.groups)
    value.basket_hash=digest(sorted(g.key for g in value.groups))
    if any(not group.valid for group in value.groups):
        value.reasons.append(reason('growth_usage_unsupported','Some usage quantities or pricing units cannot be compared. Reported charges remain separate.'))
    if not value.groups:
        value.reasons.append(reason('growth_usage_absent','No supported usage observations were supplied; fees alone do not establish operational activity.'))
    # Use the storage validator's serialization and reserve the check UUID
    # supplied at persistence, so a near-bound snapshot becomes explicitly
    # unavailable here rather than disappearing in the optional savepoint.
    bounded=value.model_dump(mode='json')
    bounded['check_id']='00000000-0000-0000-0000-000000000000'
    if len(json.dumps(bounded).encode())>MAX_BYTES:
        return _unavailable(value,'growth_evidence_limit','Monthly evidence exceeds the 4 MiB bound; no truncated measurement was accepted.')
    return value


def capture_months(con, *, sources, primary_where, baseline_where, as_of) -> GrowthCapture:
    """Only this optional result may become unavailable; canonical rows are untouched.

    Predicates name the existing role scopes; internal role metadata is the final
    authority rather than interpolating caller-controlled SQL into this module.
    """
    periods=resolve_growth_periods(as_of)
    result=GrowthCapture(captured_at=periods.as_of)
    if not sources or len(sources)>MAX_SOURCES:
        result.reasons=[reason('growth_source_unverified','Verified file identities are required for monthly evidence.')]
        return result
    try:
        sources=[GrowthSource.model_validate(s) for s in sources]
        source_map={(s.role,s.ordinal):s for s in sources}
        if len(source_map)!=len(sources): raise ValueError('Duplicate source-role ordinal')
        _view(con)
        if con.execute('SELECT count(*) FROM _growth_input WHERE starts IS NULL').fetchone()[0]:
            result.reasons=[reason('growth_timestamp_invalid','Some source timestamps cannot establish monthly membership.')]
            return result
        explicit=any(s.role=='baseline' for s in sources)
        latest=con.execute("SELECT max(CAST(date_trunc('month',starts) AS DATE)) FROM _growth_input WHERE role='primary' AND starts<?",
            [datetime(periods.current.year,periods.current.month,1)]).fetchone()[0]
        months=set(periods.months)
        if latest and latest<periods.baseline:
            months.update((shift_month(latest,-1),latest))
        for role in ('primary','baseline'):
            if not any(s.role==role for s in sources): continue
            for month in sorted(months):
                value=_month(con,source_map,month,role,periods.as_of,explicit)
                if value is not None: result.observations.append(value)
    except (duckdb.Error,OSError,ValueError,TypeError,OverflowError,InvalidOperation):
        return GrowthCapture(captured_at=periods.as_of,reasons=[reason('growth_measurement_unavailable',
            'Monthly evidence could not be measured within the supported data/resource contract. Normal check results remain independent.')])
    finally:
        try:
            con.execute('DROP VIEW IF EXISTS _growth_input')
        except (duckdb.Error,OSError):
            pass  # A resource failure must not discard the established check.
    return result
