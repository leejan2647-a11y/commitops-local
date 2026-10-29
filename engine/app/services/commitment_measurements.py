"""Read-time safety for versioned commitment observations and legacy findings."""

import re
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock


from app.pipeline.reserved_instances import VERSION as RI_VERSION
from app.pipeline.savings_plans import VERSION, cents, money_metric

FAMILIES = {
    "savings-plan": (VERSION, "savingsPlanMeasurements", "savingsPlans"),
    "reserved-instance": (RI_VERSION, "reservedInstanceMeasurements", "reservedInstances"),
}
RI_INSTANT = r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?Z$"

LEGACY = {
    "code": "commitment_measurement_unavailable",
    "message": "Historical commitment amounts lack validated interval provenance and are withheld.",
    "recovery": "Rerun this check with complete purchaser fee and beneficiary records for the selected dates.",
}
HISTORY = {
    "code": "sp_history_overlap_unresolved",
    "message": "Savings Plan observations across checks may overlap; a full-history monetary total is unavailable.",
    "recovery": "Select one check to inspect its measured window.",
}
COMMITMENT_HISTORY = {
    "code": "commitment_history_overlap_unresolved",
    "message": "Commitment observations across checks may overlap; a full-history breakdown is unavailable.",
    "recovery": "Select one check to inspect its measured window.",
}
MIXED = {
    "code": "commitment_basis_incompatible",
    "message": "Savings Plan and reservation amounts do not yet establish a compatible combined measurement.",
    "recovery": "Inspect each plan separately for its window and measurement status.",
}


_VISIBLE_PREDICATE = None
_VISIBLE_LOCK = Lock()






def finding_is_visible(finding, validation, check=None):
    if finding.detector_type != "unused-commitment":
        return True
    validation = mapping(validation)
    p = mapping(mapping(validation.get("commitmentFindings")).get(str(finding.id)))
    m = p.get("measurement")
    family = p.get("family")
    if family not in FAMILIES:
        return False
    version, canonical_key, assessment_key = FAMILIES[family]
    return (
        p.get("validated") is True
        and p.get("calculation_version") == version
        and valid_measurement(m, check)
        and m["family"] == family
        and m.get("consistent") is True
        and m.get("coverage", {}).get("status") == "complete"
        and all(
            m["metrics"][key]["state"] == "available"
            for key in ("purchased", "used", "unused", "utilization")
        )
        and m == mapping(validation.get(canonical_key)).get(m["plan_id"])
        and isinstance(mapping(validation.get(assessment_key)).get("plans"), list)
        and m["plan_id"] in mapping(validation.get(assessment_key))["plans"]
        and finding.impact_cents == m["metrics"]["unused"]["value_cents"]
    )


def valid_measurement(m, check=None):
    try:
        if (
            not isinstance(m, dict)
            or m.get("family") not in FAMILIES
            or m.get("calculation_version") != FAMILIES[m["family"]][0]
        ):
            return False
        if (
            m.get("basis") != "gross_amortized"
            or m.get("currency") != "USD"
            or m.get("population") != "selected_primary_files"
        ):
            return False
        if (
            not isinstance(m.get("plan_id"), str)
            or not m["plan_id"]
            or not isinstance(m.get("reasons"), list)
        ):
            return False
        if any(
            not isinstance(r, dict)
            or not isinstance(r.get("message"), str)
            or not isinstance(r.get("recovery"), str)
            for r in m["reasons"]
        ):
            return False
        if not isinstance(m.get("coverage"), dict) or not isinstance(m.get("window"), dict):
            return False
        start, end = [
            datetime.fromisoformat(m["window"][k].replace("Z", "+00:00")) for k in ("start", "end")
        ]
        if start.tzinfo is None or end.tzinfo is None or start >= end:
            return False
        if check is not None and (
            check.window_start is None
            or check.window_end is None
            or start != datetime.combine(check.window_start, time.min, timezone.utc)
            or end != datetime.combine(check.window_end + timedelta(days=1), time.min, timezone.utc)
        ):
            return False
        if m.get("consistent") not in (True, False) or type(m.get("consistent")) is not bool:
            return False
        for key in ("purchased", "used", "unused"):
            metric = m["metrics"][key]
            if metric["state"] not in {"available", "unavailable", "observed_only", "invalid"}:
                return False
            value, exact = metric["value_cents"], metric["exact"]
            if metric["state"] == "available":
                if not isinstance(exact, str):
                    return False
                raw = Decimal(exact)
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or not raw.is_finite()
                    or raw < 0
                    or cents(raw) != value
                ):
                    return False
            elif value is not None or exact is not None:
                return False
            observed, observed_exact = metric.get("observed_cents"), metric.get("observed_exact")
            if observed is not None:
                if type(observed) is not int or not isinstance(observed_exact, str):
                    return False
                raw_observed = Decimal(observed_exact)
                if (
                    not raw_observed.is_finite()
                    or raw_observed < 0
                    or cents(raw_observed) != observed
                ):
                    return False
            elif observed_exact is not None:
                return False
        metric = m["metrics"]["utilization"]
        if metric["state"] == "available":
            if not isinstance(metric["value"], str) or m.get("consistent") is not True:
                return False
            ratio = Decimal(metric["value"])
            if not ratio.is_finite() or ratio < 0 or ratio > 1:
                return False
        elif metric["value"] is not None:
            return False
        p, u, x = [m["metrics"][k]["exact"] for k in ("purchased", "used", "unused")]
        if x is not None and (
            p is None or u is None or Decimal(x) != max(Decimal(p) - Decimal(u), Decimal(0))
        ):
            return False
        if metric["value"] is not None and (
            p is None
            or u is None
            or Decimal(p) <= 0
            or abs(Decimal(metric["value"]) * Decimal(p) - Decimal(u)) > Decimal("1e-20")
        ):
            return False
        if m.get("consistent") is False and (x is not None or metric["value"] is not None):
            return False
        if m["family"] == "reserved-instance" and not _valid_ri_control(m, start, end):
            return False
        return True
    except (KeyError, TypeError, ValueError, InvalidOperation, AttributeError):
        return False


def _valid_ri_control(m, start, end):
    def instant(value):
        if not isinstance(value, str) or re.fullmatch(RI_INSTANT, value) is None:
            raise ValueError("Invalid canonical UTC instant")
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    if m["coverage"].get("basis") != "same_period_fee_usage_reconciliation":
        return False
    periods = m.get("period_observations")
    if not isinstance(periods, list):
        return False
    # Validate even unavailable diagnostic numbers before exposing them.
    fields = (
        "fee_obligation_exact",
        "observed_used_exact",
        "reported_unused_exact",
        "selected_used_exact",
        "balance_difference_exact",
    )
    for period in periods:
        if not isinstance(period, dict) or period.get("status") not in {
            "reconciled",
            "unavailable",
        }:
            return False
        for field in fields:
            raw = period.get(field)
            if raw is not None:
                if not isinstance(raw, str):
                    return False
                value = Decimal(raw)
                if not value.is_finite() or (field != "balance_difference_exact" and value < 0):
                    return False
        if instant(period.get("start")) >= instant(period.get("end")):
            return False
    available = any(
        m["metrics"][k]["state"] == "available" for k in ("purchased", "used", "unused")
    )
    if not available:
        return True
    if not periods or m["consistent"] is not True:
        return False
    term = mapping(m.get("term"))
    term_start = instant(term["start"]) if term.get("start") is not None else None
    term_end = instant(term["end"]) if term.get("end") is not None else None
    lower, upper = (
        max(start, term_start) if term_start else start,
        min(end, term_end) if term_end else end,
    )
    if lower >= upper:
        return False
    sums = {k: Decimal(0) for k in ("purchased", "used", "unused")}
    selected_used = Decimal(0)
    previous_end = None
    for period in periods:
        if period["status"] != "reconciled":
            return False
        a, b = instant(period["start"]), instant(period["end"])
        ba, bb = instant(period.get("billing_start")), instant(period.get("billing_end"))
        next_month = (ba.replace(day=28) + timedelta(days=4)).replace(day=1)
        if ba.day != 1 or ba.time() != time.min or bb != next_month:
            return False
        if a != (max(ba, term_start) if term_start else ba) or b != (
            min(bb, term_end) if term_end else bb
        ):
            return False
        if b <= lower or a >= upper or (previous_end is not None and a != previous_end):
            return False
        if previous_end is None and a > lower:
            return False
        previous_end = b
        for field, metric in (
            ("fee_obligation_exact", "purchased"),
            ("observed_used_exact", "used"),
            ("reported_unused_exact", "unused"),
        ):
            if period.get(field) is None:
                return False
            sums[metric] += Decimal(period[field])
        if Decimal(period["fee_obligation_exact"]) != Decimal(
            period["observed_used_exact"]
        ) + Decimal(period["reported_unused_exact"]):
            return False
        selected = period.get("selected_used_exact")
        if selected is None or Decimal(selected) > Decimal(period["observed_used_exact"]):
            return False
        selected_used += Decimal(selected)
        if start <= a and b <= end and Decimal(selected) != Decimal(period["observed_used_exact"]):
            return False
        if m["metrics"]["purchased"]["state"] == "available" and (a < start or b > end):
            return False
    if previous_end < upper:
        return False
    for metric in ("purchased", "used", "unused"):
        exact = m["metrics"][metric]["exact"]
        if exact is not None and Decimal(exact) != (
            selected_used if metric == "used" else sums[metric]
        ):
            return False
    return True


def mapping(value):
    return value if isinstance(value, dict) else {}


def measurement(row, check=None):
    if row.category not in FAMILIES:
        return None
    m = getattr(row, "measurement_json", None)
    if valid_measurement(m, check) and m["family"] == row.category:
        return {
            **{k: v for k, v in m.items() if k != "history_facts"},
            "allocation": safe_allocation(m),
        }
    return {
        "calculation_version": "legacy_unverified",
        "family": row.category,
        "metrics": {
            **{key: money_metric(None, None) for key in ("purchased", "used", "unused")},
            "utilization": {"state": "unavailable", "value": None, "observed_value": None},
        },
        "reasons": [LEGACY],
        "delivery_completeness": "unknown",
        "reconciliation": "unavailable",
    }


def safe_allocation(m):
    """Attribution can fail independently of validated plan money."""
    failure = {
        "status": "unavailable",
        "exact_by_account": {},
        "reasons": [
            {
                "code": "commitment_attribution_unavailable",
                "message": "Stored beneficiary amounts do not establish a complete allocation of validated usage.",
                "recovery": "Rerun with valid usage-account identifiers and effective costs for all beneficiary records.",
            }
        ],
    }
    a = mapping(m.get("allocation"))
    values = a.get("exact_by_account")
    if not isinstance(values, dict) or a.get("status") not in {"available", "unavailable"}:
        return failure
    try:
        total = Decimal(0)
        for account, raw in values.items():
            if (
                not isinstance(account, str)
                or len(account) != 12
                or not account.isascii()
                or not account.isdigit()
                or not isinstance(raw, str)
            ):
                return failure
            value = Decimal(raw)
            if not value.is_finite() or value < 0:
                return failure
            total += value
        if a["status"] == "available":
            used = m["metrics"]["used"]
            if used["state"] != "available" or total != Decimal(used["exact"]):
                return failure
        elif values:
            observed = m["metrics"]["used"].get("observed_exact")
            if observed is None or total > Decimal(observed):
                return failure
        return a
    except (KeyError, TypeError, InvalidOperation, ValueError):
        return failure


def totals(rows, *, history=False, checks=None):
    """Round same-check exact SP sums once; never sum overlapping snapshots."""
    kinds = {r.category for r in rows}
    if history and kinds:
        from app.services.commitment_history import total

        result = total(rows, checks)
        return {k: v for k, v in result.items() if k != "observations"}
    reasons = []
    if kinds and history:
        reasons.append(HISTORY if "savings-plan" in kinds else COMMITMENT_HISTORY)
    if len(kinds) > 1 and any(
        not valid_measurement(
            getattr(r, "measurement_json", None), checks.get(r.check_id) if checks else None
        )
        for r in rows
    ):
        reasons.append(MIXED)
    exact = {key: Decimal(0) for key in ("purchased", "used", "unused")}
    known = dict.fromkeys(exact, bool(rows))
    ratio_known = bool(rows)
    for row in rows:
        m = measurement(row, checks.get(row.check_id) if checks else None)
        if m:
            ratio_known = (
                ratio_known
                and m.get("consistent") is True
                and m["metrics"]["utilization"]["state"] == "available"
            )
            reasons.extend(m.get("reasons", []))
            for key in exact:
                value = m.get("metrics", {}).get(key, {}).get("exact")
                if value is None:
                    known[key] = False
                else:
                    exact[key] += Decimal(value)
        else:
            p, u = row.amount_cents, row.used_cents
            values = {
                "purchased": p,
                "used": u,
                "unused": max(p - u, 0) if p is not None and u is not None else None,
            }
            for key, value in values.items():
                if value is None:
                    known[key] = False
                else:
                    exact[key] += Decimal(value) / 100
    blocked = HISTORY in reasons or COMMITMENT_HISTORY in reasons or MIXED in reasons
    values = {k: cents(v) if known[k] and not blocked else None for k, v in exact.items()}
    ratio = (
        float(exact["used"] / exact["purchased"] * 100)
        if not blocked
        and ratio_known
        and known["purchased"]
        and known["used"]
        and exact["purchased"] > 0
        and exact["used"] <= exact["purchased"]
        else None
    )
    return {
        **values,
        "utilization_pct": ratio,
        "reasons": unique_reasons(reasons),
        "exact": {k: str(v) if known[k] and not blocked else None for k, v in exact.items()},
    }


def family_totals(rows, *, history=False, checks=None, assessment=None):
    """Selected-file family subtotals; an absent family is not a zero inventory."""
    from app.pipeline.savings_plans import apportion

    out = {}
    for family in FAMILIES:
        group = [r for r in rows if r.category == family]
        value = totals(group, history=history, checks=checks)
        prefix = "sp_" if family == "savings-plan" else "ri_"
        reasons = value["reasons"] + [
            r for r in (assessment or []) if r.get("code", "").startswith(prefix)
        ]
        missing = not group or any(
            r.get("code") in {prefix + "identifier_missing", prefix + "inventory_unknown"}
            for r in reasons
        )
        if not group:
            reasons.append(
                {
                    "code": prefix + "inventory_unknown",
                    "message": f"Selected files do not establish the {family.replace('-', ' ')} population.",
                    "recovery": "Include the family's complete purchaser fee and beneficiary records for the selected dates.",
                }
            )
        metrics = {}
        for key in ("purchased", "used", "unused"):
            exact = value["exact"][key] if not missing else None
            observations = [
                measurement(r, checks.get(r.check_id) if checks else None)["metrics"][key].get(
                    "observed_exact"
                )
                for r in group
            ]
            observed = (
                sum((Decimal(v) for v in observations if v is not None), Decimal(0))
                if any(v is not None for v in observations) and not history
                else None
            )
            metrics[key] = money_metric(Decimal(exact) if exact is not None else None, observed)
            if missing:
                value[key] = None
                value["exact"][key] = None
        if missing:
            value["utilization_pct"] = None
        raw_accounts = {}
        source_measurements = [
            measurement(row, checks.get(row.check_id) if checks else None) for row in group
        ]
        if history:
            from app.services.commitment_history import total

            source_measurements = total(group, checks)["observations"]
        money_proven = bool(source_measurements) and all(
            valid_measurement(m) for m in source_measurements
        )
        attribution = bool(source_measurements) and not missing
        for m in source_measurements:
            a = safe_allocation(m)
            attribution = (
                attribution
                and a.get("status") == "available"
                and m["metrics"]["used"]["state"] == "available"
            )
            if a.get("status") == "available":
                for account, raw in mapping(a.get("exact_by_account")).items():
                    raw_accounts[account] = raw_accounts.get(account, Decimal(0)) + Decimal(raw)
        out[family] = {
            **value,
            "family": family,
            "population": "selected_primary_files",
            "basis": "gross_amortized" if money_proven else None,
            "currency": "USD" if money_proven else None,
            "window": next(
                (
                    measurement(r, checks.get(r.check_id) if checks else None).get("window")
                    for r in group
                ),
                None,
            )
            if not history
            else None,
            "metrics": metrics,
            "reasons": unique_reasons(reasons),
            "status": "available"
            if all(value[k] is not None for k in ("purchased", "used", "unused"))
            else "limited",
            "allocation": {
                "status": "available" if attribution else "unavailable",
                "consumed_by_account": apportion(
                    raw_accounts, cents(sum(raw_accounts.values(), Decimal(0)))
                )
                if attribution
                else {},
                "reasons": [] if attribution else safe_allocation({})["reasons"],
            },
        }
    return out


def unique_reasons(reasons):
    return list({(r.get("code"), r.get("message"), r.get("recovery")): r for r in reasons}.values())




def validation_with_assessments(validation, assessment, check=None):
    result = dict(mapping(validation))
    # Internal linkage is required for eligibility, not a customer measurement.
    # In particular, malformed/legacy numerical payloads must not leak here.
    result.pop("commitmentFindings", None)
    result.pop("findingEvidence", None)
    result.pop("findingAttribution", None)
    result.pop("findingAmounts", None)
    from app.services import finding_measurements as fm

    result["windowTotalCents"] = fm.window_total(result, check)
    whole_file = mapping(mapping(result.get("currencyProof")).get("whole_file"))
    if (
        whole_file.get("status") != "verified"
        or whole_file.get("currency") != "USD"
        or type(whole_file.get("observed_rows")) is not int
        or whole_file["observed_rows"] <= 0
    ):
        result["computedTotalCents"] = None
        result["varianceCents"] = None
        result["reconciliationStatus"] = "unavailable"
    result.pop("savingsPlanMeasurements", None)
    result.pop("reservedInstanceMeasurements", None)
    result["commitmentAssessments"] = assessment
    if assessment:
        result["assessmentStatus"] = "limited"
        result["caveats"] = list(
            dict.fromkeys(
                list(result.get("caveats", []))
                + [f"{a['message']} {a['recovery']}" for a in assessment]
            )
        )
    return result
