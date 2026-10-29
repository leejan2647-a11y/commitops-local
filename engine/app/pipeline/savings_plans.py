"""Savings Plan interval observations, independent of comparison history.

Only recurring fees establish the amortized obligation. Coverage concerns a
known plan in the selected files, never the customer's entire AWS inventory.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation

from app.pipeline.ingest import resolve_role_scope
from app.pipeline.types import COLUMN_ALIASES

VERSION = "sp_interval_v1"
ID = "savingsPlan/SavingsPlanId"
P = "savingsPlan/TotalCommitmentToDate"
U = "savingsPlan/UsedCommitment"
EFFECTIVE = "savingsPlan/SavingsPlanEffectiveCost"
START = "lineItem/UsageStartDate"
END = "lineItem/UsageEndDate"
TYPE = "lineItem/LineItemType"
ACCOUNT = "lineItem/UsageAccountId"
CURRENCY = "lineItem/CurrencyCode"
TERM_START = "savingsPlan/StartTime"
TERM_END = "savingsPlan/EndTime"
METRICS = ["purchased", "used", "unused", "utilization"]


def cents(value: Decimal) -> int:
    return int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def issue(code, message, recovery, metrics=None, **details):
    return dict(
        code=code,
        message=message,
        recovery=recovery,
        metrics=metrics if metrics is not None else METRICS,
        **details,
    )


def timestamp(value):
    if not value:
        return None
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        # Classic CUR date-only rows explicitly denote midnight UTC.
        if result.tzinfo is None:
            if len(str(value)) != 10:
                return None
            result = result.replace(tzinfo=timezone.utc)
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def usage_timestamp(value):
    # CUR2 usage start/end are UTC fields, including native Parquet TIMESTAMP
    # values without a timezone. This does not relax the separate term strings.
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return timestamp(value)


def iso(value):
    return value.isoformat().replace("+00:00", "Z") if value else None


def amount(value):
    try:
        parsed = Decimal(str(value))
        return parsed if parsed.is_finite() and parsed >= 0 else None
    except (InvalidOperation, TypeError, ValueError):
        return None


def money_metric(value, observed, state="unavailable"):
    return dict(
        state="available" if value is not None else state,
        value_cents=cents(value) if value is not None else None,
        exact=str(value) if value is not None else None,
        observed_cents=cents(observed) if observed is not None else None,
        observed_exact=str(observed) if observed is not None else None,
    )


def apportion(values: dict[str, Decimal], total: int) -> dict[str, int]:
    """Largest remainder; stable account/category names break exact ties."""
    floors = {
        key: int((value * 100).to_integral_value(rounding=ROUND_FLOOR))
        for key, value in values.items()
    }
    order = sorted(values, key=lambda key: (-(values[key] * 100 - floors[key]), key))
    for key in order[: max(total - sum(floors.values()), 0)]:
        floors[key] += 1
    return floors


def analyse(con, window, *, table="cur", where=None):
    # Runtime import avoids the canonical module's timestamp helper dependency.
    # Use its signed exact-decimal semantics for all recognized monetary aliases;
    # amount() remains the separate nonnegative commitment-metric validator.
    from app.pipeline import canonical as observation

    where = resolve_role_scope(con, where, table=table)
    columns = [r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall()]
    rows = [
        dict(zip(columns, row))
        for row in con.execute(
            f'SELECT * FROM "{table}" WHERE ({where}) AND "{TYPE}" LIKE \'SavingsPlan%\''
        ).fetchall()
    ]
    # Ingested rows already have canonical occurrence identity. Preserve their
    # multiplicity; standalone callers retain the existing exact-row fallback.
    unique = {}
    for row in rows:
        if str(row.get(TYPE) or "").startswith("SavingsPlan"):
            conflicts = []
            for alias, canonical in COLUMN_ALIASES.items():
                if (
                    alias not in row
                    or canonical not in row
                    or not canonical.startswith(("savingsPlan/", "lineItem/", "bill/"))
                ):
                    continue
                left, right = row[alias], row[canonical]
                if canonical in observation.MONEY:
                    equal = observation._value(canonical, left, "VARCHAR") == observation._value(canonical, right, "VARCHAR")
                elif canonical in (START, END, TERM_START, TERM_END):
                    parse = usage_timestamp if canonical in (START, END) else timestamp
                    equal = parse(left) == parse(right) and (
                        parse(left) is not None
                        or str(left or "").strip() == str(right or "").strip()
                    )
                else:
                    equal = str(left or "").strip() == str(right or "").strip()
                if not equal:
                    conflicts.append(canonical)
            row["_commitops_sp_alias_conflicts"] = conflicts
            for field in (ID, ACCOUNT, "bill/PayerAccountId", CURRENCY):
                if row.get(field) is not None:
                    row[field] = str(row[field]).strip()
            key = row.get(
                "_commitops_canonical_row",
                tuple(
                    (k, str(v)) for k, v in sorted(row.items()) if not k.startswith("_commitops")
                ),
            )
            unique[key] = row
    rows = list(unique.values())
    start = datetime.combine(window.start, time.min, timezone.utc)
    end = datetime.combine(window.end + timedelta(days=1), time.min, timezone.utc)
    assessment = dict(
        calculation_version=VERSION,
        family="savings-plan",
        population="selected_primary_files",
        basis="gross_amortized",
        currency="USD",
        window=dict(start=iso(start), end=iso(end)),
        delivery_completeness="unknown",
        reconciliation="unavailable",
        reasons=[],
        plans=[],
    )
    if not rows:
        assessment["reasons"].append(
            issue(
                "sp_inventory_unknown",
                "Selected files contain no identifiable Savings Plan observations.",
                "Include purchaser-account Savings Plan fee and benefit records for the selected dates.",
            )
        )
        return [], assessment
    grouped = defaultdict(list)
    for row in rows:
        if not row.get(ID):
            assessment["reasons"].append(
                issue(
                    "sp_identifier_missing",
                    "Savings Plan records lack the plan ARN.",
                    "Include savingsPlan/SavingsPlanArn (CUR 1.0) or savings_plan_savings_plan_a_r_n (CUR 2.0), and all recurring fee records.",
                    column=ID,
                )
            )
        else:
            grouped[str(row[ID])].append(row)
    plans = []
    for plan_id, records in sorted(grouped.items()):
        plan = _plan(plan_id, records, start, end)
        if plan is not None:
            plans.append(plan)
            assessment["plans"].append(plan_id)
            assessment["reasons"].extend(plan["reasons"])
    # Distinguish a proved out-of-term plan from an unknown empty inventory.
    assessment["reasons"] = compact_reasons(assessment["reasons"])
    assessment["status"] = "available" if not assessment["reasons"] else "limited"
    return plans, assessment


def _plan(plan_id, rows, start, end):
    reasons = []
    recover = "Upload one authoritative export delivery with complete recurring fee intervals for this plan and window."
    terms = {}
    structural = any(r.get("_commitops_sp_alias_conflicts") for r in rows)
    if structural:
        reasons.append(
            issue(
                "sp_alias_conflict",
                "Native and classic Savings Plan fields disagree in the same source record.",
                "Provide one authoritative value for each field; conflicting aliases cannot select an amount.",
            )
        )
    for field in (TERM_START, TERM_END):
        values = {str(r[field]) for r in rows if r.get(field)}
        parsed = {timestamp(v) for v in values}
        if None in parsed or len(parsed) > 1:
            structural = True
            reasons.append(
                issue(
                    "sp_term_conflict",
                    "Savings Plan term timestamps conflict or cannot be parsed.",
                    recover,
                    column=field,
                )
            )
        terms[field] = next(iter(parsed)) if len(parsed) == 1 and None not in parsed else None
    lower = max(start, terms[TERM_START]) if terms[TERM_START] else start
    upper = min(end, terms[TERM_END]) if terms[TERM_END] else end
    if terms[TERM_START] and terms[TERM_END] and terms[TERM_START] >= terms[TERM_END]:
        structural = True
        reasons.append(issue("sp_term_invalid", "Plan term ends before it starts.", recover))
    if lower >= upper and not structural:
        return None
    fee_rows = [r for r in rows if r.get(TYPE) == "SavingsPlanRecurringFee"]
    owners = {str(r.get(ACCOUNT) or "") for r in fee_rows}
    payers = {str(r.get("bill/PayerAccountId") or "") for r in fee_rows}
    currencies = {str(r.get(CURRENCY) or "") for r in rows}
    if len(owners) > 1 or (fee_rows and "" in owners) or len(payers) > 1:
        structural = True
        reasons.append(
            issue(
                "sp_owner_conflict",
                "Fee records do not establish one consistent purchaser and payer.",
                recover,
            )
        )
    if currencies != {"USD"}:
        structural = True
        reasons.append(
            issue(
                "sp_currency_unsupported",
                "Savings Plan monetary analysis requires consistently declared USD.",
                "Provide a USD export for this scope; do not change currency labels or mix currencies.",
            )
        )
    selected, intervals, grains = [], [], set()
    for row in fee_rows:
        a, b = usage_timestamp(row.get(START)), usage_timestamp(row.get(END))
        if a is None or b is None or a >= b:
            structural = True
            reasons.append(
                issue(
                    "sp_interval_invalid",
                    "A fee interval has invalid UTC start/end timestamps.",
                    recover,
                )
            )
            continue
        if b <= lower or a >= upper:
            continue
        seconds = (b - a).total_seconds()
        grain = "hourly" if seconds == 3600 else "daily" if seconds == 86400 else None
        if grain is None:
            structural = True
            reasons.append(
                issue(
                    "sp_grain_unsupported",
                    "This Savings Plan fee interval is not supported hourly or daily data.",
                    "Supply documented hourly or daily fee observations without prorating amounts.",
                )
            )
        else:
            grains.add(grain)
        if a < lower or b > upper:
            structural = True
            reasons.append(
                issue(
                    "sp_partial_interval",
                    "The selected window or term cuts through a reported fee interval.",
                    "Select the complete fee interval or supply finer-grained authoritative observations.",
                )
            )
            continue
        selected.append(row)
        intervals.append((a, b))
    pairs = sorted(zip(intervals, selected), key=lambda pair: pair[0])
    if len(grains) > 1:
        structural = True
        reasons.append(
            issue(
                "sp_grain_conflict",
                "Alternative hourly and daily fee observations overlap this plan's population.",
                recover,
            )
        )
    cursor, gaps = lower, []
    for (a, b), _ in pairs:
        if a < cursor:
            structural = True
            reasons.append(
                issue(
                    "sp_interval_conflict",
                    "Multiple fee observations cover the same interval without revision authority.",
                    "Choose one authoritative export delivery/version and time grain; amounts cannot select a revision.",
                )
            )
        if a > cursor:
            gaps.append(dict(start=iso(cursor), end=iso(a)))
        cursor = max(cursor, b)
    if cursor < upper:
        gaps.append(dict(start=iso(cursor), end=iso(upper)))
    if not selected:
        reasons.append(
            issue(
                "sp_fee_missing",
                "No complete recurring fee observations establish this plan's obligation in the window.",
                recover,
            )
        )
    elif gaps:
        missing = "; ".join(f"{gap['start']} to {gap['end']}" for gap in gaps[:3])
        if len(gaps) > 3:
            missing += f"; and {len(gaps) - 3} more gaps"
        reasons.append(
            issue(
                "sp_coverage_gap",
                f"Recurring fee intervals do not cover the selected plan window. Missing UTC intervals: {missing}.",
                "Upload all files for the missing intervals, or choose a completely covered window.",
                gaps=gaps,
            )
        )
    complete = not structural and bool(selected) and not gaps
    sums, bad, observed = {}, {}, {}
    for metric, field in (("purchased", P), ("used", U)):
        parsed = [amount(r.get(field)) for r in selected]
        bad[metric] = any(v is None for v in parsed)
        valid = [v for v in parsed if v is not None]
        observed[metric] = sum(valid, Decimal(0)) if valid and not structural else None
        sums[metric] = observed[metric] if complete and not bad[metric] else None
        if bad[metric]:
            reasons.append(
                issue(
                    "sp_required_amount_missing_or_invalid",
                    f"An applicable {field} value is blank, negative or invalid.",
                    f"Obtain the corrected export with {field} populated for every applicable fee interval; do not replace blanks with zero.",
                    [metric, "unused", "utilization"],
                    column=field,
                )
            )
    p, u = sums["purchased"], sums["used"]
    po, uo = observed["purchased"], observed["used"]
    pair_complete = not bad.get("purchased") and not bad.get("used")
    xo = max(po - uo, Decimal(0)) if po is not None and uo is not None and pair_complete else None
    x = max(p - u, Decimal(0)) if p is not None and u is not None else None
    ratio = u / p if p is not None and u is not None and p > 0 else None
    observed_ratio = (
        uo / po if po is not None and po > 0 and uo is not None and pair_complete else None
    )
    overused = (p is not None and u is not None and u > p) or any(
        amount(r.get(P)) is not None
        and amount(r.get(U)) is not None
        and amount(r[U]) > amount(r[P])
        for r in selected
    )
    if overused:
        reasons.append(
            issue(
                "sp_overused",
                "Recorded usage exceeds the recorded commitment; reconciliation is inconsistent.",
                recover,
            )
        )
        ratio = None
        x = None
        xo = None
        observed_ratio = None
    status = "invalid" if structural else "observed_only" if not complete else "unavailable"
    metrics = {
        name: money_metric(value, obs, status)
        for name, value, obs in (("purchased", p, po), ("used", u, uo), ("unused", x, xo))
    }
    metrics["utilization"] = dict(
        state="available" if ratio is not None else status,
        value=str(ratio) if ratio is not None else None,
        observed_value=str(observed_ratio) if observed_ratio is not None else None,
    )
    allocation = _allocation(
        rows, lower, upper, u, not structural and complete and not overused, pairs
    )
    from app.pipeline.history_facts import capture

    return dict(
        calculation_version=VERSION,
        family="savings-plan",
        plan_id=plan_id,
        history_facts=capture(rows, lower, upper),
        purchaser=next(iter(owners)) if len(owners) == 1 else None,
        payer=next(iter(payers)) if len(payers) == 1 else None,
        service=str(rows[0].get("savingsPlan/SavingsPlanType") or "Compute"),
        basis="gross_amortized",
        currency="USD" if currencies == {"USD"} else None,
        population="selected_primary_files",
        window=dict(start=iso(start), end=iso(end)),
        term=dict(start=iso(terms[TERM_START]), end=iso(terms[TERM_END])),
        coverage=dict(
            status="complete" if complete else "invalid" if structural else "incomplete",
            start=iso(lower),
            end=iso(upper),
            grains=sorted(grains),
            intervals=[dict(start=iso(a), end=iso(b)) for a, b in sorted(set(intervals))],
            count=len(intervals),
            gaps=gaps,
        ),
        delivery_completeness="unknown",
        reconciliation="unavailable",
        metrics=metrics,
        reasons=compact_reasons(reasons),
        allocation=allocation,
        consistent=not overused and not structural,
        balance_difference_exact=str(po - uo)
        if overused and po is not None and uo is not None
        else None,
    )


def compact_reasons(reasons):
    grouped = {}
    for reason in reasons:
        key = (reason["code"], tuple(reason["metrics"]), reason.get("column"))
        if key in grouped:
            grouped[key]["count"] += 1
        else:
            grouped[key] = dict(reason, count=1)
    return list(grouped.values())


def _allocation(rows, lower, upper, used, fee_complete, fee_pairs):
    values = defaultdict(Decimal)
    interval_values = defaultdict(Decimal)
    fee_usage = {(a, b): amount(row.get(U)) for (a, b), row in fee_pairs}
    identities = set()
    valid = fee_complete and used is not None
    for row in rows:
        if row.get(TYPE) != "SavingsPlanCoveredUsage":
            continue
        a, b = usage_timestamp(row.get(START)), usage_timestamp(row.get(END))
        if a is None or b is None or a >= b:
            valid = False
            continue
        if b <= lower or a >= upper:
            continue
        v, account = amount(row.get(EFFECTIVE)), str(row.get(ACCOUNT) or "")
        if a < lower or b > upper or v is None or not account or row.get(CURRENCY) != "USD":
            valid = False
            continue
        values[account] += v
        identity = row.get("identity/LineItemId")
        if identity:
            key = (str(identity), a, b)
            if key in identities:
                valid = False
            identities.add(key)
        matching = [(fa, fb) for fa, fb in fee_usage if fa <= a and b <= fb]
        if len(matching) != 1:
            valid = False
        else:
            interval_values[matching[0]] += v
    observed = sum(values.values(), Decimal(0))
    valid = valid and observed == used
    valid = valid and all(
        value is not None and interval_values[interval] == value
        for interval, value in fee_usage.items()
    )
    reason = (
        []
        if valid
        else [
            issue(
                "sp_beneficiary_incomplete",
                "Covered-usage effective costs do not establish complete beneficiary allocation matching fee usage.",
                "Include all beneficiary accounts and savings_plan_savings_plan_effective_cost for the same plan and intervals.",
                ["allocation"],
            )
        ]
    )
    return dict(
        status="available" if valid else "unavailable",
        consumed_by_account=apportion(dict(values), cents(used)) if valid else None,
        exact_by_account={k: str(v) for k, v in values.items()},
        observed_by_account={k: cents(v) for k, v in values.items()},
        reasons=reason,
    )
