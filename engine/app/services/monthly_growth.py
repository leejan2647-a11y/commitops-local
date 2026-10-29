"""Validate immutable evidence and compare source observations, never businesses."""
from __future__ import annotations

import calendar
import hashlib
import json
from datetime import timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from pydantic import ValidationError

from app.growth.contracts import (
    MAX_BYTES, MAX_SAFE_CENTS, VERSION, GrowthComparison, GrowthDriver,
    GrowthMonthObservation, month_end, reason, shift_month,
)
from app.pipeline.money import cents, precise


def _digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


@precise
def validate_observation(raw, *, summary_only=False) -> GrowthMonthObservation | None:
    """Validate saved invariants even when the caller passes an existing model."""
    try:
        raw=raw.model_dump(mode='json') if isinstance(raw,GrowthMonthObservation) else raw
        if not isinstance(raw,dict) or len(json.dumps(raw).encode())>MAX_BYTES: return None
        value=GrowthMonthObservation.model_validate(raw)
        if value.status=='unavailable':
            return value if value.reasons and value.charge_cents is None and not value.complete else None
        if not summary_only and value.usage_group_count!=len(value.groups):return None
        if not summary_only and value.basket_hash!=_digest(sorted(g.key for g in value.groups)):return None
        if value.charge_cents is None or value.exact_charge_cents is None or value.currency!='USD': return None
        if cents(Decimal(value.exact_charge_cents))!=value.charge_cents: return None
        expected={value.month+timedelta(days=n) for n in range(calendar.monthrange(value.month.year,value.month.month)[1])}
        observed,missing=set(value.observed_days),set(value.missing_days)
        if observed & missing or observed|missing != expected or len(missing)!=len(value.missing_days): return None
        if value.complete!=(value.status=='available') or (value.complete and missing): return None
        if value.raw_rows-value.canonical_rows!=value.removed_copy_rows: return None
        if not value.sources or value.raw_rows!=sum(s.raw_rows for s in value.sources): return None
        if value.canonical_rows!=sum(s.canonical_rows for s in value.sources): return None
        if any(s.role!=value.role or s.raw_rows-s.canonical_rows!=s.removed_copy_rows for s in value.sources): return None
        if len({s.ordinal for s in value.sources})!=len(value.sources): return None
        if value.source_digest!=_digest(sorted((str(s.upload_id),s.sha256,s.role) for s in value.sources)): return None
        if value.scope_hash!=_digest([value.account_scope,value.payer_scope,'USD','unblended']): return None
        if value.account_scope!=sorted(set(value.account_scope)) or not value.account_scope: return None
        if value.payer_scope!=sorted(set(value.payer_scope)): return None
        ordinals={s.ordinal for s in value.sources}
        keys=set()
        for group in value.groups:
            if group.key in keys or group.key[1] not in value.account_scope: return None
            keys.add(group.key)
            if value.payer_scope and group.key[0] not in value.payer_scope: return None
            if not group.source_ordinals or not set(group.source_ordinals)<=ordinals: return None
            if group.valid and (group.quantity is None or Decimal(group.quantity)<0 or not all(group.key[i] for i in (1,2,4,7))): return None
        if sum(g.rows for g in value.groups)>value.canonical_rows: return None
        return value
    except (ValidationError,ValueError,TypeError,KeyError,InvalidOperation,OverflowError):
        return None


def _compatible(current,baseline):
    return (baseline.complete and baseline.month==shift_month(current.month,-1)
        and baseline.currency==current.currency=='USD' and baseline.basis==current.basis
        and baseline.version==current.version==VERSION and baseline.scope_hash==current.scope_hash)


def choose_comparison(observation, candidates, explicit_baseline=None):
    current=validate_observation(observation,summary_only=True)
    if current is None:return None
    valid=[value for raw in candidates if (value:=validate_observation(raw,summary_only=True)) is not None
        and _compatible(current,value) and value.basket_hash==current.basket_hash]
    if explicit_baseline is not None:
        valid=[v for v in valid if str(v.check_id)==str(explicit_baseline) and v.role=='primary']
    elif current.explicit_baseline:
        valid=[v for v in valid if v.check_id==current.check_id and v.role=='baseline']
    else:
        valid=[v for v in valid if v.role=='primary']
    return max(valid,key=lambda v:(current.check_id is not None and v.check_id==current.check_id,
                                  v.captured_at,str(v.observation_id)),default=None)


def _percent(numerator,denominator):
    if denominator<=0:return None
    number=(numerator/denominator-1)*100
    if not number.is_finite() or abs(number)>=Decimal('1e28'):return None
    return format(number.quantize(Decimal('.01'),rounding=ROUND_HALF_UP),'f')


@precise
def compare_months(current,baseline) -> GrowthComparison:
    current=validate_observation(current)
    baseline=validate_observation(baseline) if baseline is not None else None
    out=GrowthComparison()
    if current is None:
        out.reasons=[reason('growth_snapshot_invalid','Saved monthly evidence failed its consistency checks.')]
        return out
    out.observation_id=current.observation_id
    if baseline is None:
        out.reasons=[reason('growth_baseline_missing','A compatible complete immediately preceding month is unavailable.',
            'Select earlier comparison files or analyse compatible retained data. Current supplied amounts remain available.')]
        return out
    if not current.complete or not _compatible(current,baseline):
        out.reasons=[reason('growth_comparison_incompatible','Only complete adjacent months with matching account scope and measurement basis can be compared.')]
        return out
    out.baseline_observation_id=baseline.observation_id;out.baseline_check_id=baseline.check_id;out.baseline_month=baseline.month
    out.comparison_id=_digest([VERSION,str(current.observation_id),str(baseline.observation_id),current.source_digest,baseline.source_digest])
    delta=current.charge_cents-baseline.charge_cents
    if abs(delta)<=MAX_SAFE_CENTS:out.spending_delta_cents=delta
    else:out.reasons.append(reason('growth_delta_out_of_range','The charge change exceeds the exact browser integer range.'))
    out.spending_change_percent=_percent(Decimal(current.exact_charge_cents),Decimal(baseline.exact_charge_cents))
    before={g.key:g for g in baseline.groups};after={g.key:g for g in current.groups}
    if set(before)!=set(after) or not before:
        out.reasons.append(reason('growth_basket_changed','Usage groups are new, missing or unavailable; no overall operational index was inferred.'))
        return out
    if any(not g.valid for g in [*before.values(),*after.values()]):
        out.reasons.append(reason('growth_units_unsupported','Missing, conflicting or unsupported quantities/units prevent an overall usage comparison.'))
        return out
    d0=Decimal(calendar.monthrange(baseline.month.year,baseline.month.month)[1]);d1=Decimal(calendar.monthrange(current.month.year,current.month.month)[1])
    weighted0=Decimal(0);weighted1=Decimal(0);terms=[]
    for key,g0 in before.items():
        g1=after[key];q0=Decimal(g0.quantity);q1=Decimal(g1.quantity);c0=Decimal(g0.charge_cents);c1=Decimal(g1.charge_cents)
        if q0<=0 or c0<=0 or c1<0:
            out.excluded_groups+=1
            continue
        p0=c0/q0;v0=p0*q0/d0;v1=p0*q1/d1
        weighted0+=v0;weighted1+=v1
        terms.append((key,q0/d0,q1/d1,v0,v1))
    # Exclusions are not silently accepted as a representative whole basket.
    if out.excluded_groups or weighted0<=0:
        out.reasons.append(reason('growth_baseline_nonpositive','Zero/negative paid baselines or adjustments prevent a representative aggregate usage index.'))
        return out
    out.usage_change_percent=_percent(weighted1,weighted0)
    if out.usage_change_percent is None:
        out.reasons.append(reason('growth_percentage_out_of_range','The supported percentage range is exceeded.'))
        return out
    out.status='available';out.represented_groups=len(terms)
    ordered=sorted(terms,key=lambda t:(-abs(t[4]-t[3]),t[0]))
    for key,q0,q1,v0,_ in ordered[:20]:
        out.drivers.append(GrowthDriver(key=key,baseline_daily_quantity=str(q0),current_daily_quantity=str(q1),
            usage_change_percent=_percent(q1,q0),weight_percent=format((v0/weighted0*100).quantize(Decimal('.01')),'f')))
    out.other_driver_count=max(0,len(terms)-20)
    return out
