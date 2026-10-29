from collections import defaultdict
from decimal import Decimal
from app.pipeline.commitments import UNASSESSED_ALLOCATION_CATEGORIES
from app.pipeline.savings_plans import apportion,cents
from app.schemas.schemas import CommitmentOut
from app.services import commitment_measurements as measurements
def _plan_out(p, check=None):
    m = measurements.measurement(p, check)
    if m:
        metrics = m["metrics"]
        amount, used, unused = [metrics[k]["value_cents"] for k in ("purchased", "used", "unused")]
        ratio = metrics["utilization"].get("value")
        utilization = float(Decimal(ratio) * 100) if ratio is not None else None
    else:
        amount, used = p.amount_cents, p.used_cents
        unused = max(amount - used, 0) if amount is not None and used is not None else None
        utilization = used / amount * 100 if amount and used is not None else None
    return CommitmentOut(
        id=p.id,
        check_id=p.check_id,
        category=p.category,
        name=p.name,
        service=p.service,
        amount_cents=amount,
        used_cents=used,
        unused_cents=unused,
        utilization_pct=utilization,
        region=p.region,
        account=p.account,
        end_date=p.end_date,
        measurement=m,
    )


def _family_limits(total, assessment):
    if any(
        a.get("code")
        in {
            "sp_identifier_missing",
            "sp_inventory_unknown",
            "ri_identifier_missing",
            "ri_inventory_unknown",
        }
        for a in assessment
    ):
        for key in ("purchased", "used", "unused", "utilization_pct"):
            total[key] = None
        total["exact"] = {key: None for key in ("purchased", "used", "unused")}
    return total


def _ri_evidence(rows, check):
    evidence = []
    for row in rows:
        if row.category != "reserved-instance":
            continue
        m = measurements.measurement(row, check)
        facts = measurements.mapping((m or {}).get("ri_evidence"))
        if not facts or m.get("consistent") is not True:
            continue
        unused = m["metrics"]["unused"]["exact"]
        if unused is None or Decimal(unused) <= 0:
            continue
        evidence.append({
            "plan_id": m["plan_id"],
            **{key: facts[key] for key in ("expired_since", "purchase_region", "consumed_regions")
               if key in facts},
        })
    return sorted(evidence, key=lambda item: item["plan_id"])


def allocation_out(check, rows, assessment):
    """Legacy or mixed-basis snapshots cannot silently contribute zero."""
    a = measurements.mapping(check.allocation_json)
    families = measurements.family_totals(rows, checks={check.id: check}, assessment=assessment)
    assessment = measurements.unique_reasons(
        assessment
        + [
            r
            for f in families.values()
            for r in f["reasons"]
            if r.get("code") in {"sp_inventory_unknown", "ri_inventory_unknown"}
        ]
    )
    stored_reasons = measurements.mapping(a.get("assessment")).get("reasons", [])
    stored_reasons = (
        [
            r
            for r in stored_reasons
            if isinstance(r, dict)
            and isinstance(r.get("message"), str)
            and isinstance(r.get("recovery"), str)
        ]
        if isinstance(stored_reasons, list)
        else []
    )
    reasons = measurements.unique_reasons(assessment + stored_reasons)
    total = measurements.totals(rows, checks={check.id: check})
    reasons = measurements.unique_reasons(reasons + total["reasons"])
    legacy = any(r.get("code") == measurements.LEGACY["code"] for r in reasons)
    inventory_unknown = any(
        r.get("code")
        in {
            "sp_identifier_missing",
            "sp_inventory_unknown",
            "ri_identifier_missing",
            "ri_inventory_unknown",
        }
        for r in reasons
    )
    missing = not a or legacy or inventory_unknown
    if not a:
        reasons = measurements.unique_reasons(reasons + [measurements.LEGACY])
    value = None if missing else total["unused"]
    # Rebuild supported categories from canonical decimals; even an equal-sum
    # stored snapshot cannot establish a region-mismatch diagnosis.
    raw_categories = defaultdict(Decimal)
    if value is not None:
        for row in rows:
            m = measurements.measurement(row, check)
            unused = Decimal(m["metrics"]["unused"]["exact"])
            if unused > 0:
                category = (
                    "unused" if Decimal(m["metrics"]["used"]["exact"]) == 0 else "underutilised"
                )
                raw_categories[category] += unused
    categories = apportion(raw_categories, value) if value is not None else {}
    consumed_available = not missing and all(
        f["allocation"]["status"] == "available" for f in families.values()
    )
    raw_accounts = defaultdict(Decimal)
    for row in rows:
        m = measurements.measurement(row, check)
        allocation = measurements.safe_allocation(m or {})
        for account, raw in allocation["exact_by_account"].items():
            raw_accounts[account] += Decimal(raw)
    return dict(
        total_unused_cents=value,
        by_category={} if value is None else categories,
        consumed_by_account=apportion(raw_accounts, cents(sum(raw_accounts.values(), Decimal(0))))
        if consumed_available
        else {},
        observed_consumed_by_account={}
        if legacy
        else {k: cents(v) for k, v in raw_accounts.items()},
        consumed_available=consumed_available,
        assessment=reasons,
        family_totals=families,
        non_derivable_categories=list(UNASSESSED_ALLOCATION_CATEGORIES),
        ri_evidence=_ri_evidence(rows, check),
    )
