"""Gross RI amortization from reconciled primary-file billing periods.

Effective usage is already amortized. Unused recurring and upfront components
belong to RIFee periods; a partial window cannot prorate those observations.
"""

from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal

from app.pipeline.ingest import resolve_role_scope
from app.pipeline.savings_plans import (
    amount,
    compact_reasons,
    iso,
    issue,
    money_metric,
    timestamp,
    usage_timestamp,
)
from app.pipeline.types import COLUMN_ALIASES

VERSION = "ri_period_v1"
ID = "reservation/ReservationId"
TYPE = "lineItem/LineItemType"
START, END = "lineItem/UsageStartDate", "lineItem/UsageEndDate"
BSTART, BEND = "bill/BillingPeriodStartDate", "bill/BillingPeriodEndDate"
TSTART, TEND = "reservation/StartTime", "reservation/EndTime"
ACCOUNT, PAYER = "lineItem/UsageAccountId", "bill/PayerAccountId"
CURRENCY = "lineItem/CurrencyCode"
EFFECTIVE = "reservation/EffectiveCost"
UNUSED_RECURRING = "reservation/UnusedRecurringFee"
UNUSED_UPFRONT = "reservation/UnusedAmortizedUpfrontFeeForBillingPeriod"
FEE_UPFRONT = "reservation/AmortizedUpfrontFeeForBillingPeriod"
CASH = "lineItem/UnblendedCost"
LINE_ID = "identity/LineItemId"
RECOVERY = "Upload complete purchaser RIFee and DiscountedUsage records for the affected billing periods from one authoritative delivery, then rerun."
MONEY = {EFFECTIVE, UNUSED_RECURRING, UNUSED_UPFRONT, FEE_UPFRONT, CASH}


def _clean(value):
    return str(value or "").strip()


def _date(value, field):
    # Both identified billing dates and usage dates have documented UTC meaning.
    return usage_timestamp(value) if field in (START, END, BSTART, BEND) else timestamp(value)


def analyse(con, window, *, table="cur", where=None):
    from app.pipeline import canonical as observation

    where = resolve_role_scope(con, where, table=table)
    columns = [r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall()]
    raw = con.execute(
        f"SELECT * FROM \"{table}\" WHERE ({where}) AND \"{TYPE}\" IN ('RIFee','DiscountedUsage','Fee')"
    ).fetchall()
    unique = {}
    for values in raw:
        row = dict(zip(columns, values))
        if row.get(TYPE) == "Fee" and not _clean(row.get(ID)):
            continue
        conflicts = []
        for alias, canonical in COLUMN_ALIASES.items():
            if (
                alias not in row
                or canonical not in row
                or canonical
                not in observation.MONEY
                | {
                    ID,
                    TYPE,
                    START,
                    END,
                    BSTART,
                    BEND,
                    TSTART,
                    TEND,
                    ACCOUNT,
                    PAYER,
                    CURRENCY,
                    LINE_ID,
                }
            ):
                continue
            left, right = row[alias], row[canonical]
            if canonical in observation.MONEY:
                equal = observation._value(canonical, left, "VARCHAR") == observation._value(canonical, right, "VARCHAR")
            elif canonical in (START, END, BSTART, BEND, TSTART, TEND):
                equal = _date(left, canonical) == _date(right, canonical) and (
                    _date(left, canonical) is not None or _clean(left) == _clean(right)
                )
            else:
                equal = _clean(left) == _clean(right)
            if not equal:
                conflicts.append(canonical)
        row["_commitops_ri_alias_conflicts"] = conflicts
        for field in (ID, ACCOUNT, PAYER, CURRENCY, LINE_ID):
            row[field] = _clean(row.get(field))
        key = row.get(
            "_commitops_canonical_row",
            tuple((k, str(v)) for k, v in sorted(row.items()) if not k.startswith("_commitops")),
        )
        unique[key] = row
    rows = list(unique.values())
    start = datetime.combine(window.start, time.min, timezone.utc)
    end = datetime.combine(window.end + timedelta(days=1), time.min, timezone.utc)
    assessment = dict(
        calculation_version=VERSION,
        family="reserved-instance",
        population="selected_primary_files",
        basis="gross_amortized",
        currency="USD",
        window=dict(start=iso(start), end=iso(end)),
        delivery_completeness="unknown",
        reconciliation="unavailable",
        reasons=[],
        plans=[],
    )
    groups = defaultdict(list)
    for row in rows:
        if not row[ID]:
            assessment["reasons"].append(
                issue(
                    "ri_identifier_missing",
                    "Reservation fee or discounted-usage records lack the reservation ARN.",
                    "Include reservation/ReservationARN (CUR 1.0) or reservation_reservation_a_r_n (CUR 2.0), and complete affected fee periods.",
                )
            )
        else:
            groups[row[ID]].append(row)
    if not rows:
        assessment["reasons"].append(
            issue(
                "ri_inventory_unknown",
                "Selected files contain no identifiable reservation observations.",
                RECOVERY,
            )
        )
    plans = []
    for identifier, records in sorted(groups.items()):
        plan = _plan(identifier, records, start, end)
        if plan is not None:
            plans.append(plan)
            assessment["plans"].append(identifier)
            assessment["reasons"].extend(plan["reasons"])
    assessment["reasons"] = compact_reasons(assessment["reasons"])
    assessment["status"] = "limited" if assessment["reasons"] else "available"
    return plans, assessment


def _plan(identifier, rows, start, end):
    reasons = []

    def fail(code, message, recovery=RECOVERY, **details):
        reasons.append(issue(code, message, recovery, **details))

    fees = [r for r in rows if r[TYPE] == "RIFee"]
    terms = {}
    structural = False
    for field in (TSTART, TEND):
        raw = {_clean(r.get(field)) for r in fees if _clean(r.get(field))}
        parsed = {timestamp(v) for v in raw}
        if None in parsed or len(parsed) > 1:
            structural = True
            fail(
                "ri_term_conflict",
                "Reservation lease timestamps conflict or cannot be parsed.",
                column=field,
            )
        terms[field] = next(iter(parsed)) if len(parsed) == 1 and None not in parsed else None
    if terms[TSTART] and terms[TEND] and terms[TSTART] >= terms[TEND]:
        structural = True
        fail("ri_term_invalid", "Reservation lease ends before it starts.")
    lower, upper = (
        max(start, terms[TSTART]) if terms[TSTART] else start,
        min(end, terms[TEND]) if terms[TEND] else end,
    )
    if lower >= upper and not structural:
        return None
    owners = {r[ACCOUNT] for r in fees}
    payers = {r[PAYER] for r in rows}
    if len(owners) > 1 or (fees and "" in owners) or len(payers) > 1:
        structural = True
        fail(
            "ri_owner_conflict",
            "Fee records do not establish one consistent reservation purchaser and payer.",
        )
    if {r[CURRENCY] for r in rows} != {"USD"}:
        structural = True
        fail("ri_currency_unsupported", "Reservation amounts require consistently declared USD.")
    if any(r.get("_commitops_ri_alias_conflicts") for r in rows):
        structural = True
        fail(
            "ri_alias_conflict",
            "Native and classic reservation fields disagree in the same source record.",
        )
    identities = defaultdict(list)
    for row in rows:
        if row[LINE_ID]:
            identities[
                (
                    row[TYPE],
                    row[LINE_ID],
                    _date(row.get(BSTART), BSTART),
                    _date(row.get(BEND), BEND),
                    row[PAYER],
                )
            ].append(row)
    if any(len(group) > 1 for group in identities.values()):
        structural = True
        fail(
            "ri_revision_conflict",
            "Different observations reuse a reservation line-item identity; revision authority is unresolved.",
        )
        for group in identities.values():
            if len(group) > 1:
                for row in group:
                    row["_commitops_ri_revision_conflict"] = True
    periods = []
    for row in fees:
        a, b, ba, bb = [_date(row.get(field), field) for field in (START, END, BSTART, BEND)]
        if not all((a, b, ba, bb)) or not ba <= a < b <= bb:
            structural = True
            fail(
                "ri_period_invalid",
                "RIFee requires a valid active interval within its billing period.",
                "Include bill_billing_period_start_date/end_date and UTC line_item_usage_start_date/end_date on RIFee.",
            )
            continue
        expected_a = max(ba, terms[TSTART]) if terms[TSTART] else ba
        expected_b = min(bb, terms[TEND]) if terms[TEND] else bb
        next_month = (ba.replace(day=28) + timedelta(days=4)).replace(day=1)
        if (
            ba.day != 1
            or ba.time() != time.min
            or bb != next_month
            or (a, b) != (expected_a, expected_b)
        ):
            structural = True
            fail(
                "ri_period_scope_unsupported",
                "The fee interval does not establish a full monthly or documented initial/final active period.",
            )
        if b <= lower or a >= upper:
            continue
        alias_conflicts = set(row.get("_commitops_ri_alias_conflicts", []))
        ambiguous_fee = (
            row.get("_commitops_ri_revision_conflict")
            or row[CURRENCY] != "USD"
            or bool(
                alias_conflicts
                & {ID, TYPE, START, END, BSTART, BEND, ACCOUNT, PAYER, CURRENCY, LINE_ID}
            )
        )
        components = {
            field: amount(row.get(field))
            if not ambiguous_fee and field not in alias_conflicts
            else None
            for field in (CASH, FEE_UPFRONT, UNUSED_RECURRING, UNUSED_UPFRONT)
        }
        for field, value in components.items():
            if value is None:
                native = next(
                    (alias for alias, target in COLUMN_ALIASES.items() if target == field),
                    field,
                )
                fail(
                    "ri_required_amount_missing",
                    f"Required RIFee field {native} is missing, ambiguous, negative or nonfinite.",
                    f"Include a valid {native} value on the affected RIFee; do not replace missing values with zero. "
                    + RECOVERY,
                    column=field,
                )
        periods.append(
            dict(start=a, end=b, billing_start=ba, billing_end=bb, components=components, usage=[])
        )
    periods.sort(key=lambda p: p["start"])
    for i, p in enumerate(periods):
        for other in periods[i + 1 :]:
            if other["start"] < p["end"]:
                p["components"] = dict.fromkeys(p["components"])
                other["components"] = dict.fromkeys(other["components"])
    cursor = lower
    gaps = []
    for p in periods:
        if p["start"] < cursor and cursor != lower:
            structural = True
            fail(
                "ri_period_conflict",
                "Overlapping or multiple fee observations lack a canonical period authority.",
            )
        if p["start"] > cursor:
            gaps.append(dict(start=iso(cursor), end=iso(p["start"])))
        cursor = max(cursor, p["end"])
    if cursor < upper:
        gaps.append(dict(start=iso(cursor), end=iso(upper)))
    if not periods:
        fail("ri_fee_missing", "No complete RIFee period supports the selected reservation usage.")
    elif gaps:
        fail(
            "ri_period_gap",
            "Reservation fee coverage is missing UTC intervals: "
            + ", ".join(g["start"] + " to " + g["end"] for g in gaps[:3])
            + ".",
        )
    selected_usage = []
    overlaps = defaultdict(list)
    for row in rows:
        if row[TYPE] != "DiscountedUsage":
            continue
        a, b = usage_timestamp(row.get(START)), usage_timestamp(row.get(END))
        if not a or not b or a >= b:
            structural = True
            fail("ri_usage_interval_invalid", "DiscountedUsage has an invalid UTC interval.")
            continue
        in_window = a < upper and b > lower
        support = [p for p in periods if p["start"] <= a and b <= p["end"]]
        alias_conflicts = set(row.get("_commitops_ri_alias_conflicts", []))
        ambiguous_use = (
            row.get("_commitops_ri_revision_conflict")
            or row[CURRENCY] != "USD"
            or bool(
                alias_conflicts
                & {ID, TYPE, START, END, BSTART, BEND, ACCOUNT, PAYER, CURRENCY, LINE_ID, EFFECTIVE}
            )
        )
        value = amount(row.get(EFFECTIVE)) if not ambiguous_use else None
        record = dict(row=row, start=a, end=b, value=value)
        if in_window:
            selected_usage.append(record)
            if a < lower or b > upper:
                record["value"] = None
                structural = True
                fail(
                    "ri_usage_window_cut",
                    "A usage interval crosses the requested boundary; no unsupported fraction is assigned.",
                )
            if not support:
                fail(
                    "ri_usage_unsupported",
                    "Selected DiscountedUsage lacks a canonical supporting fee period.",
                )
        if len(support) == 1:
            period = support[0]
            for field, boundary in ((BSTART, "billing_start"), (BEND, "billing_end")):
                if _clean(row.get(field)) and _date(row[field], field) != period[boundary]:
                    structural = True
                    fail(
                        "ri_usage_billing_period_conflict",
                        "DiscountedUsage billing-period metadata contradicts its supporting RIFee period.",
                    )
            support[0]["usage"].append(record)
            key = tuple(
                _clean(row.get(k))
                for k in (
                    ACCOUNT,
                    "lineItem/ResourceId",
                    "lineItem/UsageType",
                    "lineItem/Operation",
                    "lineItem/ProductCode",
                )
            )
            overlaps[key].append(record)
        if (in_window or support) and value is None:
            fail(
                "ri_effective_cost_missing",
                "Applicable reservation_effective_cost is missing, negative or nonfinite.",
                "Include valid EffectiveCost on every DiscountedUsage row; net or unit columns cannot replace gross effective cost.",
            )
    for intervals in overlaps.values():
        active = []
        for record in sorted(intervals, key=lambda r: (r["start"], r["end"])):
            active = [prior for prior in active if record["start"] < prior["end"]]
            if active:
                structural = True
                record["value"] = None
                for prior in active:
                    prior["value"] = None
                fail(
                    "ri_usage_overlap",
                    "Overlapping usage observations may duplicate a resource's reservation benefit.",
                )
            active.append(record)
    period_details = []
    reconciled = bool(periods) and not structural and not gaps
    for p in periods:
        comp = p["components"]
        valid = all(v is not None for v in comp.values()) and all(
            r["value"] is not None for r in p["usage"]
        )
        used = (
            sum((r["value"] for r in p["usage"] if r["value"] is not None), Decimal(0))
            if any(r["value"] is not None for r in p["usage"])
            else Decimal(0)
            if not p["usage"]
            else None
        )
        fee = (
            comp[CASH] + comp[FEE_UPFRONT]
            if comp[CASH] is not None and comp[FEE_UPFRONT] is not None
            else None
        )
        unused = (
            comp[UNUSED_RECURRING] + comp[UNUSED_UPFRONT]
            if comp[UNUSED_RECURRING] is not None and comp[UNUSED_UPFRONT] is not None
            else None
        )
        balanced = valid and used is not None and fee == used + unused
        p["unused"], p["reconciled"] = unused, balanced
        if valid and not balanced:
            fail(
                "ri_period_unreconciled",
                f"Reservation observations for {iso(p['start'])} to {iso(p['end'])} do not reconcile to the fee obligation.",
                RECOVERY + " Missing usage is not imputed from the balance.",
            )
        reconciled = reconciled and balanced
        selected = [r for r in p["usage"] if lower <= r["start"] and r["end"] <= upper]
        selected_used = (
            sum((r["value"] for r in selected if r["value"] is not None), Decimal(0))
            if any(r["value"] is not None for r in selected)
            else Decimal(0)
            if balanced and not structural and not selected
            else None
        )
        period_details.append(
            dict(
                start=iso(p["start"]),
                end=iso(p["end"]),
                billing_start=iso(p["billing_start"]),
                billing_end=iso(p["billing_end"]),
                selected_used_exact=str(selected_used) if selected_used is not None else None,
                fee_obligation_exact=str(fee) if fee is not None else None,
                observed_used_exact=str(used)
                if used is not None and (p["usage"] or balanced)
                else None,
                reported_unused_exact=str(unused) if unused is not None else None,
                balance_difference_exact=str(fee - used - unused)
                if fee is not None and unused is not None and used is not None
                else None,
                status="reconciled" if balanced and not structural else "unavailable",
            )
        )
    observed_u = (
        sum((r["value"] for r in selected_usage if r["value"] is not None), Decimal(0))
        if any(r["value"] is not None for r in selected_usage)
        else Decimal(0)
        if reconciled and not selected_usage
        else None
    )
    supported = all(
        any(p["start"] <= r["start"] and r["end"] <= p["end"] for p in periods)
        for r in selected_usage
    )
    complete_u = reconciled and supported and all(r["value"] is not None for r in selected_usage)
    full_periods = bool(periods) and all(start <= p["start"] and p["end"] <= end for p in periods)
    if periods and not full_periods:
        fail(
            "ri_partial_fee_period",
            "Unused reservation fees cover a full active billing period, beyond the selected dates.",
            "Select complete affected billing periods to measure purchased and unused amounts; supported usage remains scoped to the selected dates.",
            metrics=["purchased", "unused", "utilization"],
        )
    used = observed_u if complete_u else None
    unused = (
        sum((p["unused"] for p in periods), Decimal(0)) if complete_u and full_periods else None
    )
    purchased = used + unused if used is not None and unused is not None else None
    observed_x = (
        sum((p["unused"] for p in periods if p["unused"] is not None), Decimal(0))
        if full_periods and any(p["unused"] is not None for p in periods)
        else None
    )
    ratio = used / purchased if purchased is not None and purchased > 0 else None
    contributions = defaultdict(Decimal)
    attribution = complete_u
    for r in selected_usage:
        account = r["row"][ACCOUNT]
        if not account:
            attribution = False
        elif r["value"] is not None:
            contributions[account] += r["value"]
    allocation_reasons = (
        []
        if attribution
        else [
            issue(
                "ri_attribution_unavailable",
                "Reservation beneficiaries cannot be completely attributed from validated usage.",
                RECOVERY,
            )
        ]
    )
    reasons = compact_reasons(reasons)
    from app.pipeline.commitments import _arn_region
    from app.pipeline.history_facts import capture

    ri_evidence = {}
    if reconciled and unused is not None and unused > 0:
        purchase_region = _arn_region(identifier)
        if purchase_region:
            ri_evidence["purchase_region"] = purchase_region
        consumed_regions = sorted({
            _clean(r["row"].get("product/Region"))
            for r in selected_usage
            if r["value"] is not None and _clean(r["row"].get("product/Region"))
        })
        if consumed_regions:
            ri_evidence["consumed_regions"] = consumed_regions
        if terms[TEND] is not None and terms[TEND] < end:
            ri_evidence["expired_since"] = terms[TEND].date().isoformat()

    return dict(
        calculation_version=VERSION,
        family="reserved-instance",
        plan_id=identifier,
        history_facts=capture(rows, lower, upper),
        purchaser=next(iter(owners)) if len(owners) == 1 else None,
        payer=next(iter(payers)) if len(payers) == 1 else None,
        service=next(
            (
                _clean(r.get("lineItem/ProductCode"))
                for r in fees
                if _clean(r.get("lineItem/ProductCode"))
            ),
            "Reserved Instance",
        ),
        basis="gross_amortized",
        currency="USD",
        population="selected_primary_files",
        window=dict(start=iso(start), end=iso(end)),
        term=dict(start=iso(terms[TSTART]), end=iso(terms[TEND])),
        delivery_completeness="unknown",
        reconciliation="unavailable",
        consistent=bool(reconciled),
        coverage=dict(
            status="complete"
            if purchased is not None
            else "partial"
            if used is not None
            else "unavailable",
            basis="same_period_fee_usage_reconciliation",
            gaps=gaps,
            period_count=len(periods),
        ),
        period_observations=period_details,
        reasons=reasons,
        metrics=dict(
            purchased=money_metric(purchased, purchased),
            used=money_metric(used, observed_u),
            unused=money_metric(unused, observed_x),
            utilization=dict(
                state="available" if ratio is not None else "unavailable",
                value=str(ratio) if ratio is not None else None,
                observed_value=None,
            ),
        ),
        allocation=dict(
            status="available" if attribution else "unavailable",
            exact_by_account={k: str(v) for k, v in sorted(contributions.items())},
            reasons=allocation_reasons,
        ),
        **({"ri_evidence": ri_evidence} if ri_evidence else {}),
    )
