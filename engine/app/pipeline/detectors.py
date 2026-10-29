"""Step 4 - run the detectors.

Each detector is a pure function of the baseline plus the check window, and each
returns a list of :class:`~app.pipeline.types.Finding`. They are deliberately
independent functions rather than a plugin registry: eight detectors is a fixed,
known set, and a dispatch table would be indirection with nothing to dispatch.

Shared rules every detector obeys:

* **Thin history is not a finding.** If the baseline has too few days to model a
  distribution, the group is skipped and the reason recorded. A detector that
  fires on two data points is noise, and noise destroys trust in the tool.
* **Impact is the excess, not the total.** What the customer can act on is the
  money above normal.
* **Nothing here knows about HTTP, auth or the database.**
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from app.pipeline import attribution, finding_amounts
from app.pipeline.baseline import Baseline, DailyPoint, GroupKey
from app.pipeline.comparison import PeriodStats
from app.pipeline.creep_policy import DEFAULT_MONTHLY_PERCENT, monthly_percent, required_growth
from app.pipeline.money import cents, precise
from app.pipeline.types import (
    DetectorType,
    Finding,
    FindingStatus,
    ServiceExpectation,
    Severity,
    make_finding_id,
)

log = logging.getLogger(__name__)

#: --- Detection thresholds (Task 4) ------------------------------------------
#: These are the documented defaults; every one of them exists to keep small
#: fluctuations from producing findings. Tune them here, not in a detector.
#:
#: The baseline upper limit both detection types measure against is the
#: group's zero-filled p95 (app.pipeline.comparison - the Task 2 numbers).

#: A spike day must exceed the upper limit by at least this many cents ...
SPIKE_MIN_DAILY_EXCESS_CENTS = 100  # $1
#: ... and by at least this fraction of the limit, so a $1 bump on a $500
#: baseline stays quiet.
SPIKE_MIN_DAILY_RATIO = Decimal("0.20")  # 20%
#: A group needs at least this many baseline days before its p95 means
#: anything. Below this the group is left to the new-charge path instead.
SPIKE_MIN_DAYS = 14

#: A sustained increase: the window's average daily cost must exceed the
#: upper limit by at least this many cents per day ...
UNEXPECTED_MIN_CENTS = 100  # $1
#: ... and by at least this fraction of the limit.
UNEXPECTED_MIN_RATIO = Decimal("0.20")  # 20%

#: Severity follows the size of the *total* excess - the money above the
#: upper limit across the attributed period, in whole cents.
SEVERITY_CRITICAL_TOTAL_CENTS = 25_000  # $250 and up
SEVERITY_HIGH_TOTAL_CENTS = 5_000  # $50
SEVERITY_MEDIUM_TOTAL_CENTS = 500  # $5

#: Gradual creep: a monotone weekly trend over this many weeks.
CREEP_WEEKS = 8
#: Materiality floor, not a noise gate. Noise is rejected by the fractional-rise
#: and R-squared tests below, which are both scale-free; a second, larger
#: absolute floor here would only hide real creep on a small account. The test
#: fixture's injected creep is $3 over eight weeks, which this accepts.
CREEP_MIN_TOTAL_CENTS = 100  # $1
#: Fraction of the variance a straight line must explain. A trend fitted through
#: noise is not creep, and 0.5 is the point where a line carries more information
#: than the scatter around it.
CREEP_MIN_R2 = Decimal("0.5")
#: The rise must still be happening over the closing fortnight. This is what
#: separates a creep from a step change that merely looks linear in hindsight.
CREEP_TAIL_DAYS = 14

#: A new charge must be worth at least this much in the window.
NEW_CHARGE_MIN_CENTS = 100  # $1
#: ...and must have had this little prior spend to count as "new".
NEW_CHARGE_PRIOR_CENTS = 100  # $1

#: Cost growing this much faster than usage is a pricing/plan problem, not a
#: usage problem.
MISMATCH_COST_RATIO = Decimal("1.5")
MISMATCH_USAGE_RATIO = Decimal("1.2")
#: Materiality floor only - the same $1/day used by every other detector. The
#: noise gate for this detector is the pair of ratios below, not the absolute
#: size, so a small-but-4x rate change is still reported.
MISMATCH_MIN_COST_CENTS = 100
MISMATCH_MIN_USAGE = Decimal("1")

#: A marketplace charge must be worth reporting.
MARKETPLACE_MIN_CENTS = 1000  # $10

#: An expectation must be exceeded by this fraction before we say it was.
EXPECTATION_MIN_RATIO = Decimal("0.10")  # 10%


def _sev_from_ratio(ratio: Decimal) -> Severity:
    if ratio >= Decimal("5"):
        return Severity.CRITICAL
    if ratio >= Decimal("2"):
        return Severity.HIGH
    if ratio >= Decimal("1.2"):
        return Severity.MEDIUM
    return Severity.LOW


def _pct(actual: Decimal, normal: Decimal) -> Decimal:
    if normal <= 0:
        return Decimal(0)
    return ((actual - normal) / normal * 100).quantize(Decimal("0.01"))


def _cents(value: float) -> int:
    """Round a float derived from cent amounts back to whole cents.

    Some statistics here are genuine reals - a trailing mean, a standard
    deviation, a z-score - but the money they imply has to be a whole number of
    cents before it reaches a finding, because every downstream part of the
    pipeline treats ``impact_cents`` as an integer: it is summed into totals,
    compared at persistence, and rendered as a currency amount.

    The explicit application HALF_UP policy matches
    :func:`app.pipeline.types.to_cents`, so the same figure is not rounded two
    different ways depending on which module produced it. ``Decimal(str(...))``
    rather than ``Decimal(...)`` because the latter exposes the binary
    representation of the float, so ``0.145`` would become 0.14499999999999999.
    """
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _reported_stats(value):
    if isinstance(value, dict):
        return {
            key: cents(item)
            if key.lower().endswith("cents")
            and isinstance(item, (Decimal, int))
            and not isinstance(item, bool)
            else _reported_stats(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_reported_stats(item) for item in value]
    return str(value) if isinstance(value, Decimal) else value


@precise
def _f(
    detector: DetectorType,
    tenant_id: str,
    key: GroupKey,
    window,
    *,
    impact_cents: int,
    normal_cents: int,
    title: str,
    description: str,
    stats: dict | None = None,
    caveats: list[str] | None = None,
    identity_scope: str | None = None,
) -> Finding:
    subject = "|".join(key.as_tuple())
    if identity_scope is not None:
        subject += "|" + identity_scope
    return Finding(
        id=make_finding_id(tenant_id, detector, subject, window.start, window.end),
        type=detector,
        title=title,
        description=description,
        severity=Severity.LOW,
        status=FindingStatus.OPEN,
        service=key.service,
        account=key.account,
        region=key.region,
        resource=key.resource,
        usage_type=key.usage_type,
        # The grain the detector actually measured at, recorded here so the
        # orchestrator can gather evidence at the same grain instead of
        # re-deriving one from the fields above. ``Finding`` does not carry
        # ``operation`` or ``lineItemType``, so re-deriving is not merely
        # redundant, it is impossible - and getting it wrong selects the wrong
        # rows. All seven usage detectors funnel through this factory, which is
        # why populating it in one place is sufficient.
        coarse_key=key.coarse,
        impact_cents=cents(impact_cents),
        normal_cents=cents(normal_cents),
        delta_percent=_pct(Decimal(impact_cents), Decimal(normal_cents)),
        detected_at=None,
        first_seen=None,
        stats=_reported_stats(stats or {}),
        amount_measurement=finding_amounts.from_calculation(
            detector, impact_cents, normal_cents, window, stats or {}
        ),
        caveats=caveats or [],
    )


def _sev_from_total_excess(total_excess_cents: int) -> Severity:
    """Severity from the size of the total excess (Task 4).

    The money above the upper limit across the attributed period is the
    number the customer acts on, so it is the number that decides how loud
    the finding is: under $5 is low, $50 is medium, $250 is high, and beyond
    that critical.
    """
    if total_excess_cents >= SEVERITY_CRITICAL_TOTAL_CENTS:
        return Severity.CRITICAL
    if total_excess_cents >= SEVERITY_HIGH_TOTAL_CENTS:
        return Severity.HIGH
    if total_excess_cents >= SEVERITY_MEDIUM_TOTAL_CENTS:
        return Severity.MEDIUM
    return Severity.LOW


# ---------------------------------------------------------------------------
# 1. Unexpected charge - a sustained increase in the daily run-rate
# ---------------------------------------------------------------------------


@precise
def detect_unexpected_charge(
    tenant_id: str,
    baseline: Baseline,
    baseline_numbers: dict[GroupKey, PeriodStats],
    window_numbers: dict[GroupKey, PeriodStats],
    window,
) -> list[Finding]:
    """A sustained increase in the daily run-rate above the baseline upper limit.

    Task 4: both sides of this comparison come from
    :mod:`app.pipeline.comparison` - the same grouping key, the same cost
    column, the same zero-fill rule - so the two numbers below are two
    measurements of the same thing:

    * **Same grain on both sides.** Both sides are measured at
      :data:`~app.pipeline.comparison.COMPARISON_FIELDS` (service, account,
      region, usage type). Ephemeral resources never accumulate enough
      history to model, so a resource-grained comparison finds nothing.
    * **Same units on both sides.** The window's *daily average* over its
      zero-filled calendar against the baseline's *daily* p95 - the upper
      limit. The check window and the baseline are different lengths (31 days
      against 146 in the test fixture), so comparing period totals to a daily
      percentile would hold a month of spend up against one day's typical
      spend and flag every steady service in the account.

    A group fires only when it exceeds the limit by **both** a minimum
    daily excess and a minimum ratio (the two ``UNEXPECTED_*`` thresholds),
    so small fluctuations stay out. Spikes are a separate finding
    (:func:`detect_spike`); a group can produce one, the other, or both.

    The finding's impact is the **total excess over the window** - the sum of
    each day's cost above the limit - which is the same money the evidence
    card attributes, and severity follows that total.
    """
    findings: list[Finding] = []
    for key, wstats in window_numbers.items():
        bstats = baseline_numbers.get(key)
        if bstats is None or not bstats.sufficient:
            continue
        daily_excess = wstats.avg_daily_cents - bstats.p95_cents
        if daily_excess < UNEXPECTED_MIN_CENTS:
            continue
        ratio = (Decimal(daily_excess) / bstats.p95_cents) if bstats.p95_cents else Decimal(0)
        if ratio < UNEXPECTED_MIN_RATIO:
            continue
        points = baseline.series.get(key.coarse, [])
        total_excess = sum(
            max(p.cost_cents - bstats.p95_cents, 0)
            for p in points
            if window.start <= p.day <= window.end
        )
        f = _f(
            DetectorType.UNEXPECTED_CHARGE,
            tenant_id,
            key,
            window,
            impact_cents=total_excess,
            normal_cents=bstats.p95_cents,
            title=f"Unexpected charge: {key.label()}",
            description=(
                f"The average daily cost in this window was {wstats.avg_daily_cents} cents, "
                f"{ratio * 100:.0f}% above the baseline upper limit of {bstats.p95_cents} "
                f"cents/day (the group's 95th percentile over {bstats.observed_days} "
                f"baseline days). That is {total_excess} cents of spend above normal "
                f"across the window, before any one-day spikes are accounted for."
            ),
            stats={
                "detection": "sustained-increase",
                "windowCents": wstats.total_cents,
                "windowDays": wstats.days,
                "dailyMeanCents": wstats.avg_daily_cents,
                "p95Cents": bstats.p95_cents,
                "dailyExcessCents": daily_excess,
                "totalExcessCents": total_excess,
                "meanCents": bstats.avg_daily_cents,
                "ratio": str(ratio),
                "baselineDays": bstats.observed_days,
                "baselineCalendarDays": bstats.days,
                "baselineZeroFilledDays": bstats.days - bstats.observed_days,
            },
        )
        f.severity = _sev_from_total_excess(total_excess)
        findings.append(f)
    return findings


# ---------------------------------------------------------------------------
# 2. Spike - a window day above the baseline upper limit
# ---------------------------------------------------------------------------


@precise
def detect_spike(
    tenant_id: str,
    baseline: Baseline,
    window,
    baseline_numbers: dict[GroupKey, PeriodStats],
) -> list[Finding]:
    """A single window day - or a run of them - above the baseline upper limit.

    Task 4 redefined the rule: a spike is a window day exceeding the group's
    baseline upper limit (the zero-filled p95 from
    :mod:`app.pipeline.comparison`) by **both** a minimum daily excess and a
    minimum ratio. The old z-score test answered a different question ("how
    unusual is this against the rolling mean?") and went blind on a flat
    baseline, where a single-cent move was infinitely significant; the
    upper-limit test answers the one the customer asks: "how far above
    normal was this day, in money?"

    Two things keep this from drowning the customer in its own output:

    * **Runs are coalesced.** A sustained level shift trips the day test on
      every day it lasts, so a 31-day shift produced 31 near-identical
      findings. The shift *as a whole* is :func:`detect_unexpected_charge`'s
      finding; a spike is the days it lasted, so consecutive days become one
      finding for the worst day in the run, carrying the run's total excess
      as its impact.
    * **Materiality, twice.** The excess must clear ``$1`` *and* ``20%`` of
      the limit, so a $1 bump on a $500 baseline is not a spike and a
      rounding-level wobble on a $2 baseline is not either.

    Severity follows the size of the total excess.
    """
    findings: list[Finding] = []
    for coarse, points in baseline.series.items():
        # The lookup key is the comparison grain with the resource and line
        # item type blanked - the same shape comparison.period_stats keys its
        # dicts by, so the group's upper limit is findable. (The finding
        # identity carries the same key's coarse projection.)
        key = GroupKey(*coarse, "", "", "")
        bstats = baseline_numbers.get(key)
        if bstats is None or not bstats.sufficient:
            continue
        limit = bstats.p95_cents
        observed_by_day = {p.day: p for p in points if window.start <= p.day <= window.end}

        hits: list[dict] = []
        for p in points:
            if p.day < window.start or p.day > window.end:
                continue
            excess = p.cost_cents - limit
            if excess < SPIKE_MIN_DAILY_EXCESS_CENTS:
                continue
            ratio = (Decimal(excess) / limit) if limit else Decimal("999")
            if ratio < SPIKE_MIN_DAILY_RATIO:
                continue
            hits.append(
                {
                    "day": p.day,
                    "dayCents": p.cost_cents,
                    "excess": excess,
                    "ratio": ratio,
                }
            )

        for run in _consecutive_runs(hits):
            peak = max(run, key=lambda h: h["dayCents"])
            total = sum(h["excess"] for h in run)
            days = len(run)
            following_day = run[-1]["day"] + timedelta(days=1)
            # build_baseline's series contains observed primary rows in the
            # check window, not calendar zero-fill. An absent or out-of-window
            # day cannot establish that the cost returned to normal.
            following = observed_by_day.get(following_day)
            if following is None:
                following_description = "There is no following-day observation in the selected window."
            elif following.cost_cents <= limit:
                following_description = "The following day was within the baseline upper limit."
            else:
                following_description = "The following day remained above the baseline upper limit."
            f = _f(
                DetectorType.SPIKE,
                tenant_id,
                key,
                window,
                identity_scope=f"spike-run:{run[0]['day'].isoformat()}:{(run[-1]['day'] + timedelta(days=1)).isoformat()}",
                impact_cents=total,
                normal_cents=limit,
                title=(
                    f"Cost spike: {key.label()} from {run[0]['day'].isoformat()}"
                    if days > 1
                    else f"Cost spike: {key.label()} on {run[0]['day'].isoformat()}"
                ),
                description=(
                    f"Daily cost peaked at {peak['dayCents']} cents on "
                    f"{peak['day'].isoformat()}, {peak['excess']} cents above the "
                    f"baseline upper limit of {limit} cents/day (the group's 95th "
                    f"percentile over {bstats.observed_days} baseline days). "
                    + (
                        f"The elevated level held for {days} consecutive days, "
                        f"{total} cents in total above the limit."
                        if days > 1
                        else following_description
                    )
                ),
                stats={
                    "detection": "spike",
                    "day": peak["day"].isoformat(),
                    "dayCents": peak["dayCents"],
                    "limitCents": limit,
                    "peakExcessCents": peak["excess"],
                    "runDays": days,
                    "runFirstDay": run[0]["day"].isoformat(),
                    "runTotalExcessCents": total,
                },
            )
            f.severity = _sev_from_total_excess(total)
            findings.append(f)
    return findings


def _consecutive_runs(hits: list[dict]) -> list[list[dict]]:
    """Group ordered hits into runs of consecutive days."""
    runs: list[list[dict]] = []
    for h in hits:
        if runs and h["day"] - runs[-1][-1]["day"] == timedelta(days=1):
            runs[-1].append(h)
        else:
            runs.append([h])
    return runs


# ---------------------------------------------------------------------------
# 3. Gradual creep - the one AWS Cost Anomaly Detection misses
# ---------------------------------------------------------------------------


@precise
def _linear_slope(points: list[DailyPoint]) -> tuple[Decimal, Decimal]:
    """Least-squares slope and intercept of cost against day index."""
    n = len(points)
    if n < 3:
        return Decimal(0), Decimal(0)
    xs = list(range(n))
    ys = [Decimal(p.cost_cents) for p in points]
    mean_x = Decimal(sum(xs)) / n
    mean_y = sum(ys) / n
    num = sum((Decimal(x) - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((Decimal(x) - mean_x) ** 2 for x in xs)
    if den == 0:
        return Decimal(0), mean_y
    slope = num / den
    return slope, mean_y - slope * mean_x


@precise
def detect_gradual_creep(tenant_id: str, baseline: Baseline, window, *,
                       creep_monthly_growth_percent: object = None) -> list[Finding]:
    """A slow, steady rise that never trips a point anomaly.

    Fitted over the trailing :data:`CREEP_WEEKS` weeks ending at the window end,
    because the thing being detected is the trend inside the period under review.

    The test that separates this from a step change is the one at the end:
    creep is *still rising* when the window closes, a jump is flat once it has
    happened. Over a trailing window a step looks like a ramp - 25 flat days then
    31 high days fits a straight line with a high R-squared - so R-squared alone
    cannot tell the two apart, and without this check every step change in the
    account is also reported as creep.
    """
    findings: list[Finding] = []
    min_days = CREEP_WEEKS * 7
    sensitivity = monthly_percent(DEFAULT_MONTHLY_PERCENT if creep_monthly_growth_percent is None else creep_monthly_growth_percent)
    for coarse, points in baseline.series.items():
        if len(points) < min_days:
            continue
        lookback_start = window.end - timedelta(days=min_days - 1)
        segment = [p for p in points if lookback_start <= p.day <= window.end]
        if len(segment) < min_days:
            continue
        slope, intercept = _linear_slope(segment)
        if slope <= 0:
            continue
        weekly = slope * 7
        first, last = segment[0].cost_cents, segment[-1].cost_cents
        rise = last - first
        if rise < CREEP_MIN_TOTAL_CENTS:
            continue
        if first <= 0:
            continue
        rate = Decimal(rise) / first
        # Monthly sensitivity is normalized linearly to the 56-day sample.
        min_total_rate = required_growth(sensitivity, min_days)
        if rate < min_total_rate:
            continue
        # R^2: a "trend" through noise is not creep. Cheap to compute at n=56.
        ys = [Decimal(p.cost_cents) for p in segment]
        mean_y = sum(ys) / len(ys)
        ss_tot = sum((y - mean_y) ** 2 for y in ys)
        ss_res = sum((y - (slope * i + intercept)) ** 2 for i, y in enumerate(ys))
        r2 = (Decimal(1) - ss_res / ss_tot) if ss_tot > 0 else Decimal(0)
        if r2 < CREEP_MIN_R2:
            continue
        # Still rising at the end of the window? A step change is flat over the
        # closing fortnight and is not creep.
        tail = segment[-CREEP_TAIL_DAYS:]
        tail_rise = tail[-1].cost_cents - tail[0].cost_cents
        if tail_rise <= 0:
            continue
        key = GroupKey(*coarse, "", "", "Usage")
        expected = intercept + slope * (len(segment) - 1)
        impact = max(last - expected, 0)
        amount_basis = "final_day_trend_residual"
        if impact < CREEP_MIN_TOTAL_CENTS:
            impact = rise
            amount_basis = "daily_trend_change"
        f = _f(
            DetectorType.GRADUAL_CREEP,
            tenant_id,
            key,
            window,
            impact_cents=impact,
            normal_cents=first,
            title=f"Gradual cost creep: {key.label()}",
            description=(
                f"Cost has risen steadily for {min_days // 7} weeks, from {first} to {last} cents "
                f"(~{weekly:.1f} cents/week, R^2={r2:.2f}). This trend can overlap with "
                f"spike findings; their amounts measure different periods and must not be added."
            ),
            stats={
                "days": len(segment),
                "firstCents": first,
                "lastCents": last,
                "riseCents": rise,
                "amountBasis": amount_basis,
                "trendStart": segment[0].day.isoformat(),
                "trendEnd": segment[-1].day.isoformat(),
                "fittedFinalDayCents": expected,
                "weeklyCents": str(weekly),
                "r2": str(r2.quantize(Decimal("0.001"))),
            },
        )
        f.severity = _sev_from_ratio(Decimal(last) / Decimal(expected or 1))
        f.caveats.append(f"Detected at {sensitivity}% monthly sensitivity.")
        findings.append(f)
    return findings


# ---------------------------------------------------------------------------
# 4. New charge
# ---------------------------------------------------------------------------


@precise
def detect_new_charge(
    tenant_id: str,
    baseline_numbers: dict[GroupKey, PeriodStats],
    totals: dict[GroupKey, int],
    window,
) -> list[Finding]:
    """A usage pattern that has no baseline at all.

    ``totals`` is the check-window totals at the comparison grain
    (:data:`~app.pipeline.comparison.COMPARISON_FIELDS`), so the prior is
    looked up at the same grain, from the same comparison numbers the other
    charge detectors use. Reading it from the per-resource index instead makes
    every lookup miss, and every service in the account then reports as brand
    new - which is what a missing index lookup looks like from the outside.
    """
    findings: list[Finding] = []
    for key, actual in totals.items():
        if actual < NEW_CHARGE_MIN_CENTS:
            continue
        bstats = baseline_numbers.get(key)
        prior = bstats.total_cents if bstats else 0
        if prior > NEW_CHARGE_PRIOR_CENTS:
            continue
        f = _f(
            DetectorType.NEW_CHARGE,
            tenant_id,
            key,
            window,
            impact_cents=actual,
            normal_cents=0,
            title=f"New charge: {key.label()}",
            description=(
                f"This charge has no baseline history at all - the service, account, region "
                f"and usage type combination did not appear in the prior period. It accounts "
                f"for {actual} cents in the window."
            ),
            stats={"windowCents": actual, "priorCents": prior},
        )
        f.severity = _sev_from_ratio(Decimal(10))
        findings.append(f)
    return findings


# ---------------------------------------------------------------------------
# 5. Usage-to-cost mismatch
# ---------------------------------------------------------------------------


@precise
def detect_usage_cost_mismatch(
    tenant_id: str,
    con,
    baseline: Baseline,
    window,
    *,
    columns: frozenset[str] | None = None,
    table: str | None = None,
) -> list[Finding]:
    """Cost grew much faster than actual usage.

    Compared as *daily rates*, not period totals. The baseline and the check
    window are different lengths by construction, so a 4x daily price increase
    inside a 31-day window sits against 146 days of baseline and looks like a
    24% *decrease* in total spend. Rate is also the thing a customer actually
    reasons about - "what does this cost me per unit" - so it is the same number
    the description quotes.

    Needs a usage column; when the file has none, the detector reports itself
    unavailable rather than returning a reassuring zero.
    """
    from app.pipeline.ingest import TABLE as DEFAULT_TABLE

    table = table or DEFAULT_TABLE
    has_usage = columns is None or "lineItem/UsageAmount" in columns
    if not has_usage:
        log.info("usage-to-cost mismatch skipped: no lineItem/UsageAmount column")
        return []

    findings: list[Finding] = []
    check_days = Decimal(window.check_days)
    baseline_days = Decimal(window.baseline_days)
    for coarse, points in baseline.series.items():
        check = [p for p in points if window.start <= p.day <= window.end]
        prior = [p for p in points if window.baseline_start <= p.day <= window.baseline_end]
        if not check or not prior:
            continue
        cost_per_day_now = Decimal(sum(p.cost_cents for p in check)) / check_days
        cost_per_day_before = Decimal(sum(p.cost_cents for p in prior)) / baseline_days
        usage_per_day_now = sum((p.usage for p in check), Decimal(0)) / check_days
        usage_per_day_before = sum((p.usage for p in prior), Decimal(0)) / baseline_days
        if (
            cost_per_day_before < MISMATCH_MIN_COST_CENTS
            or usage_per_day_before < MISMATCH_MIN_USAGE
        ):
            continue
        if usage_per_day_now < MISMATCH_MIN_USAGE:
            continue
        cost_ratio = cost_per_day_now / cost_per_day_before
        usage_ratio = usage_per_day_now / usage_per_day_before
        if cost_ratio < MISMATCH_COST_RATIO or usage_ratio > MISMATCH_USAGE_RATIO:
            continue
        rate_now = (cost_per_day_now / 100) / usage_per_day_now
        rate_before = (cost_per_day_before / 100) / usage_per_day_before
        key = GroupKey(*coarse, "", "", "Usage")
        # The recoverable amount is the spend the old rate would have cost at
        # today's usage - not the whole bill, which the customer is still using.
        at_old_rate = usage_per_day_now * check_days * (rate_before * 100)
        impact = max(sum(p.cost_cents for p in check) - at_old_rate, 0)
        f = _f(
            DetectorType.USAGE_COST_MISMATCH,
            tenant_id,
            key,
            window,
            impact_cents=impact,
            normal_cents=cost_per_day_before * check_days,
            title=f"Usage-to-cost mismatch: {key.label()}",
            description=(
                f"Daily cost rose {cost_ratio:.2f}x while daily usage rose only "
                f"{usage_ratio:.2f}x. The effective rate moved from {rate_before:.6f} to "
                f"{rate_now:.6f} per unit, which points at a change in rate or coverage "
                f"rather than in consumption. At the previous rate this usage would have "
                f"cost about {at_old_rate} cents instead of "
                f"{sum(p.cost_cents for p in check)}."
            ),
            stats={
                "costRatio": f"{cost_ratio:.3f}",
                "usageRatio": f"{usage_ratio:.3f}",
                "rateBefore": f"{rate_before:.8f}",
                "rateNow": f"{rate_now:.8f}",
                "dailyCostBeforeCents": cost_per_day_before,
                "dailyCostNowCents": cost_per_day_now,
                "windowCents": sum(p.cost_cents for p in check),
                "counterfactualCents": at_old_rate,
            },
        )
        f.severity = _sev_from_ratio(cost_ratio / max(usage_ratio, Decimal("0.01")))
        findings.append(f)
    return findings


# ---------------------------------------------------------------------------
# 6. Marketplace charge
# ---------------------------------------------------------------------------


@precise
def detect_marketplace(
    tenant_id: str,
    con,
    baseline: Baseline,
    window,
    *,
    columns: frozenset[str] | None = None,
    table: str | None = None,
    primary_where: str | None = None,
) -> list[Finding]:
    from app.pipeline.ingest import TABLE as DEFAULT_TABLE
    from app.pipeline.ingest import resolve_role_scope

    table = table or DEFAULT_TABLE
    primary_where = resolve_role_scope(con, primary_where, table=table)
    columns = columns or frozenset(r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall())
    if not ({"bill/BillingEntity", "marketplace/ProviderName"} & set(columns)):
        log.info("marketplace detector skipped: no marketplace columns")
        return []

    from app.pipeline.baseline import service_expr
    from app.pipeline.ingest import COST_CENTS_SQL, day_predicate, text

    def optional(name):
        return f'COALESCE("{name}", \'\')' if name in columns else "''"

    provider_sql = optional("marketplace/ProviderName")
    product_sql = optional("marketplace/ProductName")
    entity_sql = optional("bill/BillingEntity")
    marketplace_sql = f"({entity_sql} = 'AWS Marketplace' OR {provider_sql} <> '')"

    # Grouped by the real billing dimensions, not just by vendor.
    #
    # This used to GROUP BY provider, product, account and then pack
    # `marketplace/ProductName` into the GroupKey's *usage_type* slot, which
    # made the finding's grouping unresolvable against the billing rows: the
    # key said usage_type='Datadog Hosted Agent' and operation='' while the rows
    # said lineItem/UsageType='BoxUsage:m5.xlarge' and operation='RunInstances'.
    # Nothing noticed, because for six months of detector testing the only
    # assertion was that marketplace *fired* - nothing ever looked rows up by a
    # marketplace finding's key. The orchestrator did, and got an evidence total
    # of 0 next to a $480 claim, which is the one thing this product must never
    # show.
    #
    # Grouping at the true dimensions also makes this detector consistent with
    # the other seven, which all emit one finding per account and region. The
    # vendor identity is not lost: it stays in the title, the description and
    # ``stats``. The money is redistributed across more findings, not changed -
    # the parts still sum to the same total.
    rows = con.execute(
        f"SELECT {provider_sql} AS provider, "
        f"       {product_sql} AS product, "
        f"       COALESCE(\"lineItem/UsageAccountId\", '') AS account, "
        f"       {optional('product/Region')} AS region, "
        f"       COALESCE(\"lineItem/UsageType\", '') AS usage_type, "
        f"       COALESCE(\"lineItem/Operation\", '') AS operation, "
        f"       COALESCE(\"lineItem/LineItemType\", '') AS line_item_type, "
        f"       SUM({COST_CENTS_SQL}) AS total_cents, "
        f"       {service_expr(columns)} AS service "
        f"FROM {table} WHERE ({primary_where}) AND {day_predicate(window.start, window.end)} "
        f"  AND {marketplace_sql} "
        f"GROUP BY provider, product, account, region, usage_type, operation, line_item_type, service"
    ).fetchall()

    findings: list[Finding] = []
    for r in rows:
        total = Decimal(r[7] or 0)
        if total < MARKETPLACE_MIN_CENTS:
            continue
        provider, product, account = text(r[0]), text(r[1]), text(r[2])
        region, usage_type, operation = text(r[3]), text(r[4]), text(r[5])
        key = GroupKey(text(r[8]), account, region, usage_type, operation, "", text(r[6]))
        vendor_label = provider or "vendor unavailable"
        product_label = product or key.service or "product unavailable"
        f = _f(
            DetectorType.MARKETPLACE,
            tenant_id,
            key,
            window,
            impact_cents=total,
            normal_cents=0,
            # Region is in the title because this detector now emits one finding
            # per account *and* region. Without it two findings for the same
            # vendor look identical, and the customer cannot tell which to act
            # on - the same reasoning as GroupKey.label().
            title=f"Marketplace charge: {vendor_label} / {product_label} / {account}"
            + (f" / {region}" if region else ""),
            description=(
                f"{total} cents of AWS Marketplace charges appear in this window. "
                + (f"The export names vendor {provider!r}. " if provider else
                   "The export does not identify the vendor. ")
                + "Review the source rows and your Marketplace subscriptions before changing a purchase."
            ),
            stats={"provider": provider, "product": product, "windowCents": total,
                   "operation": operation, "lineItemType": text(r[6])},
            identity_scope="marketplace:" + repr((provider, product)),
        )
        f.severity = _sev_from_ratio(Decimal(5))
        findings.append(f)
    return findings


def marketplace_evidence_filter(columns, stats):
    """Bind evidence to the exact recognized Marketplace source population."""
    provider = 'COALESCE("marketplace/ProviderName", \'\')' if "marketplace/ProviderName" in columns else "''"
    product = 'COALESCE("marketplace/ProductName", \'\')' if "marketplace/ProductName" in columns else "''"
    entity = 'COALESCE("bill/BillingEntity", \'\')' if "bill/BillingEntity" in columns else "''"
    return (
        f"({entity} = 'AWS Marketplace' OR {provider} <> '') AND {provider} = ? AND {product} = ? "
        "AND COALESCE(\"lineItem/Operation\", '') = ? AND COALESCE(\"lineItem/LineItemType\", '') = ?",
        [stats.get("provider", ""), stats.get("product", ""), stats.get("operation", ""), stats.get("lineItemType", "")],
    )


# ---------------------------------------------------------------------------
# 7. Expectation mismatch
# ---------------------------------------------------------------------------


def unsupported_expectation_period(note: str) -> bool:
    import re

    return bool(
        re.search(
            r"(?:/|per\s+)(?:day|month|week|year|hour)|\b(?:daily|monthly|weekly|yearly|hourly)\b|€|£|\b(?:EUR|GBP)\b",
            note,
            re.IGNORECASE,
        )
    )


def parse_expected_amount(note: str) -> tuple[int | None, bool]:
    """Read one unambiguous, nonnegative USD amount for the selected window.

    Returns ``(cents, unparsed)``. Unsupported periods/currencies, malformed
    amounts and qualitative notes return no money; the caller reports the note
    without inventing a variance. Ordinary sentence punctuation is permitted,
    but fractional cents, negative values and partial numeric tokens are not.
    """
    import re

    if not note:
        return None, False
    if unsupported_expectation_period(note):
        return None, True
    matches = list(
        re.finditer(
            r"(?P<currency>\$|\bUSD)(?P<gap>\s*)(?P<prefix_sign>[+-]?)\s*(?P<prefix_number>[\d,.]+)"
            r"|(?<![\w.,])(?P<suffix_sign>[+-]?)\s*(?P<suffix_number>[\d,.]+)\s+(?:USD|dollars?)\b",
            note,
            re.IGNORECASE,
        )
    )
    # Count malformed candidates too, rather than choosing a valid substring
    # from an ambiguous note or restarting after a decimal/grouping separator.
    if len(matches) != 1:
        return None, True
    match = matches[0]
    if match.group("prefix_sign") or match.group("suffix_sign") or re.search(r"-\s*$", note[:match.start()]):
        return None, True
    raw = match.group("prefix_number") or match.group("suffix_number")
    if match.group("currency"):
        # Keep the existing wrappers: '$31', 'USD 31', or '31 USD/dollars'.
        if (match.group("currency") == "$" and match.group("gap")) or (
            match.group("currency").upper() == "USD" and not match.group("gap")
        ):
            return None, True
        remainder = note[match.end():]
        if re.match(r"\w", remainder):
            return None, True
        if raw[-1] in ".,":
            if re.match(r"\s*\d", remainder):
                return None, True
            raw = raw[:-1]
    if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?", raw):
        return None, True
    whole, _, fraction = raw.replace(",", "").partition(".")
    return int(whole) * 100 + int(fraction.ljust(2, "0")), False


@precise
def detect_expectation_mismatch(
    tenant_id: str,
    baseline: Baseline,
    totals: dict[GroupKey, int],
    window,
    expectations: list[ServiceExpectation],
) -> list[Finding]:
    findings: list[Finding] = []
    for exp in expectations:
        service_rows = {k: v for k, v in totals.items() if k.service == exp.service}
        actual = sum(service_rows.values())
        if exp.stated_amount_cents is None:
            # No parseable number: surface the note, claim no variance.
            if actual > 0:
                key = GroupKey(exp.service, "", "", "", "", "", "Usage")
                f = _f(
                    DetectorType.EXPECTATION_MISMATCH,
                    tenant_id,
                    key,
                    window,
                    impact_cents=0,
                    normal_cents=0,
                    title=f"Expectation recorded for {exp.service}",
                    description=(
                        f"You wrote: {exp.note!r}. No amount could be read from that, so no "
                        f"variance is claimed. Actual spend in the window was {actual} cents."
                    ),
                    stats={"note": exp.note, "windowCents": actual, "parsed": False},
                    caveats=["expectation text contained no parseable amount"],
                )
                f.severity = Severity.LOW
                findings.append(f)
            continue

        stated = exp.stated_amount_cents
        if actual <= stated:
            continue
        excess = actual - stated
        ratio = Decimal(excess) / Decimal(stated) if stated else Decimal(0)
        if ratio < EXPECTATION_MIN_RATIO:
            continue
        key = next(iter(service_rows), GroupKey(exp.service, "", "", "", "", "", "Usage"))
        f = _f(
            DetectorType.EXPECTATION_MISMATCH,
            tenant_id,
            key,
            window,
            impact_cents=excess,
            normal_cents=stated,
            title=f"Expectation mismatch: {exp.service}",
            description=(
                f"You stated: {exp.note!r} (parsed as {stated} cents). Actual spend in the "
                f"window was {actual} cents, which is {ratio * 100:.0f}% above your stated "
                f"expectation. This compares your expectation to the billing data; it is not a "
                f"claim that either is wrong."
            ),
            stats={
                "note": exp.note,
                "statedCents": stated,
                "actualCents": actual,
                "ratio": str(ratio),
            },
        )
        f.severity = _sev_from_ratio(ratio)
        findings.append(f)
    return findings


# ---------------------------------------------------------------------------
# 8. Unused commitment (delegated to the commitment module, which owns the math)
# ---------------------------------------------------------------------------


@precise
def run_all(
    tenant_id: str,
    con,
    baseline: Baseline,
    window,
    *,
    totals: dict[GroupKey, int] | None = None,
    baseline_numbers: dict[GroupKey, PeriodStats] | None = None,
    window_numbers: dict[GroupKey, PeriodStats] | None = None,
    expectations: list[ServiceExpectation] | None = None,
    columns: frozenset[str] | None = None,
    table: str | None = None,
    baseline_where: str | None = None,
    primary_where: str | None = None,
    sp_commitments=None,
    commitment_summaries=None,
    creep_monthly_growth_percent: object = None,
) -> list[Finding]:
    """Run every detector and return the combined findings.

    :param totals: pre-computed check-window totals at the comparison grain.
        Passed in because two detectors need them and recomputing per detector
        would rescan the table twice.
    :param baseline_numbers: the baseline side of the comparison, from
        :func:`app.pipeline.comparison.period_stats`, and
    :param window_numbers: the window side. The orchestrator computes both
        once and also runs the refusal guard over them. A direct caller that
        omits them gets them computed here - from the same one module, never
        re-derived ad hoc, because the two sides of every charge-jump
        comparison must come from the same code path.
    :param baseline_where: / :param primary_where: the row scopes the
        orchestrator used for the two sides (file-baseline checks split the
        table by role). Detection attributes and the attribution records
        must read the same halves the numbers were measured on.
    """
    from app.pipeline import comparison
    from app.pipeline.baseline import check_window_totals as _cwt
    from app.pipeline.commitments import detect_unused_commitment
    from app.pipeline.ingest import ROLE_BASELINE, resolve_role_scope
    from app.pipeline.ingest import TABLE as DEFAULT_TABLE

    # Resolve once, here. Passing ``table=None`` straight through to a function
    # whose default is ``TABLE`` does *not* fall back to the default - it sets it
    # to None, and the query is built as "FROM None". That is how the whole
    # unused-commitment detector was running and reporting nothing at all.
    table = table or DEFAULT_TABLE
    primary_where = resolve_role_scope(con, primary_where, table=table)
    baseline_where = resolve_role_scope(con, baseline_where, table=table, role=ROLE_BASELINE)

    if totals is None:
        totals = _cwt(
            con,
            window,
            columns=columns,
            table=table,
            fields=comparison.COMPARISON_FIELDS,
            where=primary_where,
        )
    if baseline_numbers is None:
        baseline_numbers = comparison.period_stats(
            con,
            start=window.baseline_start,
            end=window.baseline_end,
            columns=columns,
            table=table,
            where=baseline_where,
        )
    if window_numbers is None:
        window_numbers = comparison.period_stats(
            con,
            start=window.start,
            end=window.end,
            columns=columns,
            table=table,
            where=primary_where,
        )

    findings: list[Finding] = []
    findings += detect_unexpected_charge(
        tenant_id, baseline, baseline_numbers, window_numbers, window
    )
    findings += detect_spike(tenant_id, baseline, window, baseline_numbers)
    findings += detect_gradual_creep(tenant_id, baseline, window,
        creep_monthly_growth_percent=creep_monthly_growth_percent)
    findings += detect_new_charge(tenant_id, baseline_numbers, totals, window)
    findings += detect_usage_cost_mismatch(
        tenant_id, con, baseline, window, columns=columns, table=table
    )
    findings += detect_marketplace(
        tenant_id, con, baseline, window, columns=columns, table=table, primary_where=primary_where
    )
    findings += detect_expectation_mismatch(tenant_id, baseline, totals, window, expectations or [])
    findings += detect_unused_commitment(
        tenant_id,
        con,
        window,
        columns=columns,
        table=table,
        sp_commitments=sp_commitments,
        summaries=commitment_summaries,
        where=primary_where,
    )

    # --- attribution records (Task 4) ---------------------------------------
    # Every spike and sustained-increase finding carries the auditable record:
    # which resources caused it, each against its own baseline, ranked by
    # excess. Scoped to the same halves of the table the numbers were
    # measured on.
    for f in findings:
        if f.type not in (DetectorType.SPIKE, DetectorType.UNEXPECTED_CHARGE):
            continue
        if not f.coarse_key:
            continue
        fkey = GroupKey.from_coarse(f.coarse_key)
        spike_day = date.fromisoformat(f.stats["day"]) if f.type == DetectorType.SPIKE else None
        f.stats["attribution"] = attribution.build_attribution(
            con,
            key=fkey,
            window=window,
            columns=columns,
            table=table,
            where=primary_where,
            baseline_where=baseline_where,
            detection=(
                attribution.DETECTION_SPIKE
                if spike_day is not None
                else attribution.DETECTION_SUSTAINED
            ),
            baseline_upper_limit_cents=f.normal_cents,
            excess_cents=f.impact_cents,
            spike_day=spike_day,
            run_start=date.fromisoformat(f.stats["runFirstDay"]) if spike_day else None,
            run_end=date.fromisoformat(f.stats["runFirstDay"])
            + timedelta(days=f.stats["runDays"] - 1)
            if spike_day
            else None,
            window_values=(
                None
                if spike_day is not None
                else {
                    "days": f.stats.get("windowDays"),
                    "totalCents": f.stats.get("windowCents"),
                    "avgDailyCents": f.stats.get("dailyMeanCents"),
                    "maxDayCents": f.stats.get("dayCents"),
                }
            ),
        )

    # Total order, and the id is the final tiebreaker on purpose. DuckDB makes no
    # promise about the order it returns rows in - it may vary between runs on
    # identical input - so any sort key that can tie leaves the output order up
    # to that variation, and the same window would come back in a different
    # sequence each time it is processed.
    findings.sort(key=lambda f: (f.severity.rank, -f.impact_cents, f.id))
    log.info("detectors produced %d findings for tenant=%s", len(findings), tenant_id)
    return findings
