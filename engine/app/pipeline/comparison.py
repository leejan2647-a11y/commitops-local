"""Task 2 - the comparison core: one key, one cost column, one zero-fill rule.

The check compares two time periods - an older baseline and a recent window -
and every downstream finding is only as trustworthy as the two sides being
*comparable*. Everything the two sides share therefore lives in this one
module, and both sides are computed by the same functions over the same
inputs:

* **One grouping key** - :data:`COMPARISON_FIELDS`: the service code, the AWS
  account, the region code and the usage type. The individual resource id is
  excluded: it belongs to attribution (Task 4), and an ephemeral resource
  never accumulates enough history to be modelled at its own grain.
* **One cost column** - :data:`~app.pipeline.ingest.COST_CENTS_SQL`, imported
  rather than re-spelled, so both sides sum the same money the same way.
* **One zero-fill rule** - :func:`period_daily`: a group with no line items on
  a given day has cost zero, because skipping missing days distorts the
  percentiles and averages the comparison is made of.
* **One window contract** - :func:`comparison_guard`: the baseline ends
  exactly where the window begins (no overlap, no gap), and both periods
  carry a minimum day count whose violation is visible in the result.

The refusal rule is absolute: if the two sides were measured differently -
a different key, a different cost column, a different zero-fill rule, or
overlapping ranges - the check emits **nothing** and records the reason,
because a comparison between numbers produced by different code is not a
comparison at all.

Query-shape note (the bug this module exists to prevent): the service slot
is a *derivation* (``service_expr``), so it is projected **once** in the
innermost SELECT and aliased to its canonical field name. The outer query
references only the projected aliases. Re-deriving the expression at the
outer level references base columns the subquery does not carry, which is a
DuckDB binder error - the crash that made every real CUR 2.0 check fail
with "internal error" in production while every test (whose fixture carries
``product/ProductName``) kept passing.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING

from app.pipeline.baseline import (
    MIN_HISTORY_DAYS,
    GroupKey,
    _group_names,
    _names,
)
from app.pipeline.ingest import COST_CENTS_SQL, TABLE, day_predicate, resolve_role_scope
from app.pipeline.ingest import text as _s

if TYPE_CHECKING:  # pragma: no cover - import cycle guard for typing only
    import duckdb

from app.pipeline.money import precise

log = logging.getLogger(__name__)

#: The one grouping key both sides of the comparison are measured at, in
#: GroupKey slot order: service, account, region, usage type.
#:
#: Task 2's recommended key: AWS account, service code, region code and
#: usage type. ``operation`` is deliberately out - two line items that differ
#: only by operation are the same spend pattern, and splitting them halves
#: each side's history - and the resource id is attribution's to add later
#: (Task 4), never the baseline's to group by.
COMPARISON_FIELDS: tuple[str, ...] = (
    "product/ProductName",
    "lineItem/UsageAccountId",
    "product/Region",
    "lineItem/UsageType",
)

#: A window shorter than this cannot support a daily-average comparison.
MIN_WINDOW_DAYS = 7

#: The percentile of the group's zero-filled baseline daily totals that a
#: window value must exceed before it is called abnormal.
BASELINE_UPPER_PERCENTILE = Decimal("0.95")


def _round_cents(value: Decimal | float) -> int:
    """Round a computed money figure to whole cents, half-up.

    Same rule as :func:`app.pipeline.detectors._cents` so no figure is rounded
    two different ways depending on which module produced it.
    """
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


@precise
def quantile_cont(values: Sequence[int | Decimal], q: Decimal | float) -> Decimal:
    """The continuous (linear-interpolation) q-quantile of ``values``.

    Matches DuckDB's ``quantile_cont`` on the same input, so a percentile
    computed here is the same number the SQL engine would have produced -
    the equivalence is pinned by a test that queries DuckDB for the answer.
    """
    if not values:
        return Decimal(0)
    ordered = sorted(Decimal(str(v)) for v in values)
    if len(ordered) == 1:
        return ordered[0]
    pos = Decimal(str(q)) * (len(ordered) - 1)
    lower = int(pos)
    frac = pos - lower
    if lower + 1 >= len(ordered):
        return ordered[lower]
    return ordered[lower] + (ordered[lower + 1] - ordered[lower]) * frac


@dataclass
class DailySeries:
    """One group's daily cost over one period, zero-filled.

    ``by_day`` carries an entry for **every** calendar day of the period; a
    day the group had no line items is 0, not absent, because a missing day
    is not missing data - it is a day the spend did not happen. ``observed``
    records which days actually had rows, so a genuinely zero-cost day (a
    $0.00 line item) is never confused with a filled-in one.
    """

    by_day: dict[date, Decimal]
    observed: set[date] = field(default_factory=set)

    @property
    def days(self) -> int:
        """Calendar days in the period - the denominator of every average."""
        return len(self.by_day)


#: Maps a canonical field name to the GroupKey slot it feeds. Keys are built
#: BY NAME, never by position: the attribution grain appends the resource id
#: after the comparison key, and a positional pad would land it in the
#: operation slot - reading every contributor's resource as empty. Pinned by
#: tests/test_attribution.py.
_SLOT_BY_FIELD: dict[str, str] = {
    "product/ProductName": "service",
    "lineItem/UsageAccountId": "account",
    "product/Region": "region",
    "lineItem/UsageType": "usage_type",
    "lineItem/Operation": "operation",
    "lineItem/ResourceId": "resource",
    "lineItem/LineItemType": "line_item_type",
}


def _key_from_row(fields: tuple[str, ...], values) -> GroupKey:
    """A GroupKey from one row's grouping values, at any grain up to 7 fields."""
    slots = dict.fromkeys(_SLOT_BY_FIELD.values(), "")
    for grouping_field, value in zip(fields, values):
        slot = _SLOT_BY_FIELD.get(grouping_field)
        if slot is not None:
            slots[slot] = _s(value)
    return GroupKey(**slots)


@precise
def period_daily(
    con: "duckdb.DuckDBPyConnection",
    *,
    start: date,
    end: date,
    columns: frozenset[str] | None,
    table: str = TABLE,
    where: str | None = None,
    fields: tuple[str, ...] = COMPARISON_FIELDS,
) -> dict[GroupKey, DailySeries]:
    """Per-group daily cost in exact cents, zero-filled across the period.

    Both sides of the comparison call this same function: the baseline for
    ``[baseline_start, baseline_end]`` and the window for
    ``[window_start, window_end]`` - one key, one cost column, one zero-fill
    rule, by construction rather than by convention.

    ``where`` scopes the rows (the checked files' role on a file-baseline
    check, ``"TRUE"`` otherwise).
    """
    where = resolve_role_scope(con, where, table=table)
    names = _names(fields, columns)
    inner = (
        f"SELECT {names}, "
        f"       CAST(\"lineItem/UsageStartDate\" AS DATE) AS day, "
        f"       {COST_CENTS_SQL} AS cost_cents "
        f"  FROM {table} "
        f" WHERE {day_predicate(start, end)} AND ({where})"
    )
    # Outer scope: ONLY the aliases the inner query projects, aggregated to
    # one row per group per day - the day's total across every line item in
    # the group. Re-deriving {names} at this level is the production crash
    # (see the module docstring); skipping the GROUP BY silently keeps one
    # row per line item, and a same-day overwrite then reads as a lower total.
    rows = con.execute(
        f"SELECT {_group_names(fields)}, day, SUM(cost_cents) AS cost_cents "
        f"FROM ({inner}) "
        f"GROUP BY {_group_names(fields)}, day"
    ).fetchall()

    n = len(fields)
    all_days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    out: dict[GroupKey, DailySeries] = {}
    for r in rows:
        key = _key_from_row(fields, r[:n])
        entry = out.get(key)
        if entry is None:
            entry = out[key] = DailySeries(
                by_day={d: 0 for d in all_days}, observed=set()
            )
        entry.by_day[r[n]] = Decimal(r[n + 1] or 0)
        entry.observed.add(r[n])
    return out


@dataclass(frozen=True)
class PeriodStats:
    """One group's comparable numbers over one period.

    The baseline's ``p95_cents`` is the *upper limit* - the 95th percentile of
    the group's zero-filled daily totals, computed on group totals and never
    per resource. The window's ``avg_daily_cents`` / ``max_day_cents`` /
    ``days`` are the same three measurements on the other side.
    """

    key: GroupKey
    #: Calendar days in the period (the zero-filled denominator).
    days: int
    #: Days the group actually had line items.
    observed_days: int
    total_cents: Decimal
    avg_daily_cents: Decimal
    max_day_cents: Decimal
    #: The baseline upper limit, over zero-filled group daily totals.
    p95_cents: Decimal

    @property
    def sufficient(self) -> bool:
        """Enough observed history to model a distribution."""
        return self.observed_days >= MIN_HISTORY_DAYS

    def insufficient_reason(self) -> str | None:
        if self.sufficient:
            return None
        return (
            f"only {self.observed_days} day(s) of history for {self.key.label()} "
            f"(need {MIN_HISTORY_DAYS} to model a distribution)"
        )


@precise
def _stats_from_series(key: GroupKey, series: DailySeries) -> PeriodStats:
    values = list(series.by_day.values())
    total = sum(values)
    days = series.days
    return PeriodStats(
        key=key,
        days=days,
        observed_days=len(series.observed),
        total_cents=total,
        avg_daily_cents=Decimal(total) / days if days else Decimal(0),
        max_day_cents=max(values, default=0),
        p95_cents=(
            quantile_cont(values, BASELINE_UPPER_PERCENTILE)
            if values
            else 0
        ),
    )


@precise
def period_stats(
    con: "duckdb.DuckDBPyConnection",
    *,
    start: date,
    end: date,
    columns: frozenset[str] | None,
    table: str = TABLE,
    where: str | None = None,
    fields: tuple[str, ...] = COMPARISON_FIELDS,
) -> dict[GroupKey, PeriodStats]:
    """One group's comparable numbers for one period, keyed by the one key.

    The baseline side and the window side differ only in the dates and the
    row scope they are handed; the key, the cost column and the zero-fill
    rule cannot differ because they are not parameters.
    """
    daily = period_daily(
        con, start=start, end=end, columns=columns, table=table,
        where=where, fields=fields,
    )
    return {key: _stats_from_series(key, s) for key, s in daily.items()}


@dataclass(frozen=True)
class GuardResult:
    """The refusal guard's decision.

    ``refusals`` mean the two sides were not measured identically and the
    comparison must not emit anything. ``confidence`` means the comparison
    ran but on less history than it needs, which the result says out loud
    instead of absorbing.
    """

    refusals: list[str] = field(default_factory=list)
    confidence: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.refusals


def comparison_guard(
    window,
    *,
    fields: tuple[str, ...] = COMPARISON_FIELDS,
    cost_sql: str = COST_CENTS_SQL,
    zero_fill: bool = True,
    file_baseline: bool = False,
) -> GuardResult:
    """Verify the two sides of the comparison are the same measurement.

    Runs before any result is emitted. A violation is a refusal with a
    machine-readable reason the caller records in the check result; a short
    period is a confidence note, because a thin comparison is still an
    honest one as long as it says so.

    ``file_baseline`` waives the **gap** requirement only, for the file-baseline
    path (Task 6): a baseline the customer brings as files is the history
    they have, and it ends where it ends - the derived range is disclosed in
    the result rather than refused. Overlap stays a hard error in every
    mode; the role separation that protects the window read is verified
    elsewhere and the derived window is clamped so it can never overlap.
    """
    refusals: list[str] = []
    confidence: list[str] = []

    if fields != COMPARISON_FIELDS:
        refusals.append(
            "comparison-key: the two sides were not measured with the same "
            f"grouping key ({', '.join(fields)} != {', '.join(COMPARISON_FIELDS)})"
        )
    if cost_sql != COST_CENTS_SQL:
        refusals.append(
            "cost-column: the two sides did not aggregate the same cost column"
        )
    if not zero_fill:
        refusals.append(
            "zero-fill: the two sides did not share one missing-day rule"
        )

    if window.baseline_end >= window.start:
        refusals.append(
            f"overlap: the baseline ends {window.baseline_end.isoformat()} but "
            f"the window starts {window.start.isoformat()}; the baseline would "
            "explain the data under test with itself"
        )
    elif not file_baseline and window.baseline_end + timedelta(days=1) != window.start:
        refusals.append(
            f"gap: the baseline ends {window.baseline_end.isoformat()} but the "
            f"window starts {window.start.isoformat()}; the two periods must "
            "touch with no day unaccounted for"
        )

    if window.check_days < MIN_WINDOW_DAYS:
        confidence.append(
            f"window-too-short: the window covers {window.check_days} day(s) "
            f"(need {MIN_WINDOW_DAYS} for a daily comparison)"
        )
    if window.baseline_days < MIN_HISTORY_DAYS:
        confidence.append(
            f"baseline-too-short: the baseline covers {window.baseline_days} "
            f"day(s) (need {MIN_HISTORY_DAYS} to model a distribution)"
        )

    return GuardResult(refusals=refusals, confidence=confidence)
