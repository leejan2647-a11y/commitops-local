"""Pure tenant-configurable detector sensitivity; no monetary calculations."""
from decimal import MAX_EMAX, MIN_EMIN, Decimal, InvalidOperation, localcontext

SETTING_KEY = "creepMonthlyGrowthPercent"
DEFAULT_MONTHLY_PERCENT = Decimal("10")


def monthly_percent(value: object) -> Decimal:
    """Accept a strictly positive finite numeric percentage, never booleans."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("Creep monthly growth percentage must be a positive finite number.")
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise ValueError("Creep monthly growth percentage must be a positive finite number.") from None
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError("Creep monthly growth percentage must be a positive finite number.")
    return parsed


def required_growth(value: object, days: int) -> Decimal:
    """Linear 30-day normalization: percent /100 * observed days /30."""
    with localcontext() as context:
        context.Emax = MAX_EMAX
        context.Emin = MIN_EMIN
        return monthly_percent(value) / Decimal(100) * Decimal(days) / Decimal(30)
