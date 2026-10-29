"""Exact internal fractional cents and explicit reporting boundaries.

Delivered native floats use Python's shortest round-trip decimal rendering;
this does not reconstruct an earlier decimal price. CSV and native DECIMAL
values never take a float detour. Inputs support ten fractional dollar digits
and an absolute-sum budget below 10**26 dollars, reserving SQL cent-sum headroom.
"""
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from functools import wraps


def precise(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        with localcontext() as context:
            context.prec = 80
            return fn(*args, **kwargs)
    return call


@precise
def cents(value) -> int:
    """Round one independently reported fractional-cent result, HALF_UP."""
    return int(Decimal(value).quantize(Decimal(1), rounding=ROUND_HALF_UP))


class MoneyInputError(ValueError):
    def __init__(self, count, reasons):
        self.diagnostics = {
            "code": "cur_money_unavailable", "invalidRows": count,
            "column": "lineItem/UnblendedCost", "differingFields": ["lineItem/UnblendedCost"],
            "message": f"Exact billing cost is unavailable for {count} observation(s): {', '.join(sorted(reasons))}.",
            "recovery": "Supply lineItem/UnblendedCost (CUR2 line_item_unblended_cost) for every selected observation, including explicit zero where applicable. Use finite values with at most 10 fractional dollar digits and an absolute sum below 10^26 USD; correct the export and rerun.",
        }
        super().__init__(self.diagnostics["message"] + " " + self.diagnostics["recovery"])


@precise
def validate_costs(con, table="cur"):
    """Validate before any fixed-width cast can silently round or omit money."""
    reader = con.cursor()
    invalid, reasons, absolute = 0, set(), Decimal(0)
    try:
        reader.execute(f'SELECT "lineItem/UnblendedCost" FROM "{table}"')
        while batch := reader.fetchmany(1024):
            for (raw,) in batch:
                try:
                    if raw is None or isinstance(raw, bool) or not str(raw).strip():
                        raise ValueError("missing required cost")
                    amount = Decimal(str(raw))
                    if not amount.is_finite():
                        raise ValueError("nonfinite cost")
                    if abs(amount) >= Decimal('1e26'):
                        raise ValueError("cost exceeds supported magnitude")
                    if amount != amount.quantize(Decimal('0.0000000001')):
                        raise ValueError("unsupported cost precision")
                    absolute += abs(amount)
                except (InvalidOperation, ValueError) as exc:
                    invalid += 1
                    reasons.add(str(exc) if isinstance(exc, ValueError) else "invalid decimal cost")
    finally:
        reader.close()
    if absolute >= Decimal('1e26'):
        reasons.add("aggregate exceeds exact sum capacity")
        invalid += 1
    if reasons:
        raise MoneyInputError(invalid, reasons)


class MoneyRangeError(MoneyInputError):
    def __init__(self, fields):
        self.diagnostics = {
            "code": "cur_money_unavailable", "invalidOutputs": len(fields),
            "differingFields": sorted(fields)[:20],
            "message": "A reported amount exceeds the supported storage or browser integer range; no monetary results were accepted.",
            "recovery": "Check the source cost units and values. Stored amounts support -2147483648 through 2147483647 cents; other reported integer amounts support -9007199254740991 through 9007199254740991 cents. Correct invalid source values or select a narrower valid check window, then rerun. Large exact inputs may still be used when all resulting reported amounts fit.",
        }
        ValueError.__init__(self, self.diagnostics["message"] + " " + self.diagnostics["recovery"])


def validate_reported_costs(result):
    """Guard actual output boundaries, not individual raw observations that net."""
    failures = set()
    def bounded(value, field, low=-(2**31), high=2**31-1):
        if value is not None and (type(value) is not int or not low <= value <= high):
            failures.add(field)
    def json_numbers(value, path):
        if type(value) is int:
            bounded(value, path, -(2**53-1), 2**53-1)
        elif isinstance(value, dict):
            for key, item in value.items():
                json_numbers(item, path + "." + str(key))
        elif isinstance(value, (list, tuple)):
            for item in value:
                json_numbers(item, path + "[]")
    if result.validation:
        json_numbers(result.validation.to_dict(), "validation")
    for finding in result.findings:
        bounded(finding.impact_cents, "finding.impact_cents")
        json_numbers(finding.normal_cents, "finding.normal_cents")
        json_numbers(finding.stats, "finding.stats")
        if finding.evidence:
            e = finding.evidence
            bounded(int(e.evidence_total * 100), "finding.evidence_total_cents")
            json_numbers(e.displayed_contribution_cents, "evidence.displayed_contribution_cents")
            json_numbers(e.explained_not_displayed_cents, "evidence.explained_not_displayed_cents")
            for row in e.top_line_items:
                bounded(row.get("contributionCents"), "evidence.amount_cents")
                bounded(row.get("costCents"), "evidence.raw_cost_cents")
    for row in result.baselines:
        bounded(row.daily_p95_cents, "baseline.daily_p95_cents")
    for row in result.commitments:
        bounded(row.purchased_cents, "commitment.amount_cents")
        bounded(row.used_cents, "commitment.used_cents")
        json_numbers(row.measurement_json, "commitment.measurement")
    if result.allocation:
        json_numbers(result.allocation.to_dict(), "allocation")
    if failures:
        raise MoneyRangeError(failures)
