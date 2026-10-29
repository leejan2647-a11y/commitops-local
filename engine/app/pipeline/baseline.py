"""Step 3 - build a baseline of what "normal" looks like.

For every combination of service, account, region, usage type, operation,
resource and line item type, summarise the prior period into the statistics the
detectors need: daily mean, p50, p95, standard deviation and effective rate.

Two design points that matter more than the formulas:

* **No leakage.** The baseline is built strictly from ``window.baseline_start ..
  window.baseline_end`` and :class:`~app.pipeline.types.DataWindow` refuses to be
  constructed with an overlap. A baseline that included the spike would explain
  the spike with itself.
* **Honest about thin history.** A group seen twice in six months has no usable
  distribution, so it is marked ``sufficient=False`` and detectors skip it with
  a recorded reason. Inventing a standard deviation of 0 from two samples is how
  a detector ends up firing on everything.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

import duckdb

from app.pipeline.ingest import (
    COST_CENTS_SQL,
    ROLE_BASELINE,
    TABLE,
    day_predicate,
    resolve_role_scope,
)
from app.pipeline.ingest import text as _s
from app.pipeline.money import precise
from app.pipeline.types import DataWindow

log = logging.getLogger(__name__)

#: Below this many distinct days of history a group is treated as unmodellable.
#: Two weeks is the point where a p95 stops being "the only value we have".
MIN_HISTORY_DAYS = 14

#: The grouping the product specifies for a baseline.
BASELINE_FIELDS = (
    "product/ProductName",
    "lineItem/UsageAccountId",
    "product/Region",
    "lineItem/UsageType",
    "lineItem/Operation",
    "lineItem/ResourceId",
    "lineItem/LineItemType",
)

#: The grain the *detectors* compare at.
#:
#: ``resource`` has to stay out of it. A CUR export gives EC2 rows a resource id
#: per instance, and instances are ephemeral, so a resource-level group holds a
#: single day of history and can never reach the minimum sample size. Measured
#: on the test fixture, grouping by the full 7-tuple left 584 of 600 groups
#: (97%) with exactly one day of history and none modellable - the detector would
#: have been structurally blind to the service it most needs to catch.
#:
#: The comparison key itself (Task 2) is :data:`app.pipeline.comparison.
#: COMPARISON_FIELDS`: the service, account, region and usage type slots,
#: without the operation. It lives in the comparison module, which both
#: sides of the check import, so there is exactly one definition of the key
#: the two periods are compared at.
#:
#: The 7-tuple statistics are still computed here, because that is the grain
#: at which a customer investigates one specific resource. Detectors compare
#: at the comparison grain and treat the resource as an attribute of the
#: finding.

#: How the service slot of the grouping is derived (Feature 1.6).
#:
#: ``BASELINE_FIELDS[0]`` has always been ``product/ProductName``, and that was
#: the bug: a genuine CUR 2.0 export **cannot** carry that column (AWS nests it
#: in a map column a flat CSV cannot expose), so every real CUR 2.0 upload grouped
#: with an empty service slot - and because ``GroupKey.label()`` joins only the
#: non-empty bits, the finding's subject started with the *account id*. The
#: findings table then showed ``111111111111`` in its Service column.
#:
#: The slot is therefore a derivation, in priority order, over the columns the
#: file actually has:
#:
#:   1. ``product/ServiceCode``  - the short machine code (``AmazonEC2``).
#:   2. ``lineItem/ProductCode``  - the line-item level code; flat in CUR 2.0.
#:   3. ``product/ProductName``  - the long display name; classic CUR only.
#:   4. ``lineItem/UsageType``   - ``BoxUsage:m5.large``: a shape, not a
#:                                 name, but it identifies the service.
#:   5. ``lineItem/Operation``   - the last thing that names anything.
#:
#: ProductName sits third, not first, so a classic file that carries both keeps
#: the short ServiceCode - and third, not absent, because the test fixture and
#: every classic export carries only ProductName, and without this slot the
#: fixture would regress to UsageType strings and every detector test that
#: asserts ``service == "AmazonEC2"`` would fail for a cosmetic preference.
SERVICE_CHAIN: tuple[str, ...] = (
    "product/ServiceCode",
    "lineItem/ProductCode",
    "product/ProductName",
    "lineItem/UsageType",
    "lineItem/Operation",
)


def service_expr(columns: frozenset[str] | None = None) -> str:
    """SQL for the service slot: the first non-empty chain column the file has.

    Every grouping query (baseline series, both statistic grains, the window
    totals) and the evidence predicate must derive the service **identically** -
    a finding detected against a ``ServiceCode`` grouping and evidenced against
    the raw ``ProductName`` column selects no rows at all, and an evidence total
    of zero next to a non-zero impact is worse than no evidence card.

    ``columns=None`` keeps the pre-existing behaviour for synthetic test tables
    that were built with only the grouping columns: quoting the ProductName
    they do have is semantically identical to the old ``"product/ProductName"``
    reference, while referencing a chain column they lack would be a binder
    error.
    """
    if columns is None:
        return 'COALESCE("product/ProductName", \'\')'
    present = [c for c in SERVICE_CHAIN if c in columns]
    if not present:
        return "''"
    return "COALESCE(" + ", ".join(f"NULLIF(\"{c}\", '')" for c in present) + ", '')"


@dataclass(frozen=True)
class GroupKey:
    """The full baseline grouping."""

    service: str
    account: str
    region: str
    usage_type: str
    operation: str
    resource: str
    line_item_type: str

    @property
    def coarse(self) -> tuple[str, str, str, str]:
        """Identity at the comparison grain.

        Task 2 made the comparison key the service, account, region and
        usage type - ``operation`` is no longer part of it, because two line
        items that differ only by operation are the same spend pattern, and
        splitting them halves each side's history. The width and order here
        are pinned to :data:`app.pipeline.comparison.COMPARISON_FIELDS` by
        ``tests/test_comparison.py``.
        """
        return (self.service, self.account, self.region, self.usage_type)

    @classmethod
    def from_coarse(cls, values: tuple[str, ...]) -> "GroupKey":
        """Rebuild a key from a :attr:`coarse` 4-tuple.

        The inverse of :attr:`coarse`, used by the orchestrator to turn a
        finding's recorded ``coarse_key`` back into a :class:`GroupKey` that
        ``build_evidence`` can query at the comparison grain.

        ``resource`` and ``line_item_type`` are left empty on purpose. Evidence
        is gathered at the coarse grain, so those two are not part of the match;
        filling them in from a finding would silently narrow the row selection to
        a single resource, which is the exact failure the coarse grain exists to
        avoid.

        A 5-wide tuple is accepted and truncated: findings recorded before the
        comparison key dropped the operation slot (Task 2) are archived, never
        deleted, and their recorded keys must keep resolving to evidence. A
        tuple of any other width raises, because a mis-shaped key that quietly
        truncated would produce evidence that looks like evidence.

        :raises ValueError: if the tuple is not 4 (or legacy 5) wide.
        """
        if len(values) == 5:
            values = values[:4]
        if len(values) != 4:
            raise ValueError(
                "coarse key must be 4 values "
                "(service, account, region, usage type), "
                f"got {len(values)}"
            )
        service, account, region, usage_type = values
        return cls(service, account, region, usage_type, "", "", "")

    def label(self) -> str:
        """Short human-readable identity, used in finding titles.

        Includes the account. Detectors emit one finding per account and region,
        so a label without it is identical for all of them and the customer sees
        several indistinguishable rows with no way to tell which to act on.
        """
        bits = [self.service, self.account, self.region, self.usage_type or self.operation]
        return " / ".join(b for b in bits if b)

    def as_tuple(self) -> tuple[str, ...]:
        """Positional form matching :data:`BASELINE_FIELDS` order."""
        return (
            self.service,
            self.account,
            self.region,
            self.usage_type,
            self.operation,
            self.resource,
            self.line_item_type,
        )


@dataclass
class BaselineStats:
    """Historical statistics for one group."""

    key: GroupKey
    n_days: int
    total_cents: Decimal
    mean_cents: Decimal
    p50_cents: Decimal
    p95_cents: Decimal
    stddev_cents: Decimal
    total_usage: Decimal
    effective_rate: Decimal | None

    @property
    def sufficient(self) -> bool:
        return self.n_days >= MIN_HISTORY_DAYS

    def insufficient_reason(self) -> str | None:
        if self.sufficient:
            return None
        return (
            f"only {self.n_days} day(s) of history for {self.key.label()} "
            f"(need {MIN_HISTORY_DAYS} to model a distribution)"
        )

    def excess_over_p95(self, actual_cents: int) -> int:
        """How far an actual total sits above the historical p95."""
        return max(actual_cents - self.p95_cents, 0)


@dataclass
class DailyPoint:
    day: date
    cost_cents: Decimal
    usage: Decimal


@dataclass
class Baseline:
    """Everything step 4 needs, computed once."""

    #: Per-resource statistics, keyed by the full 7-tuple grouping.
    stats: dict[GroupKey, BaselineStats] = field(default_factory=dict)
    #: Daily totals per comparison key, covering baseline *and* check window,
    #: so a detector can look back and forward in one pass. Keyed at the
    #: comparison grain (see :attr:`GroupKey.coarse`).
    series: dict[tuple[str, str, str, str], list[DailyPoint]] = field(default_factory=dict)
    insufficient_groups: int = 0

    def get(self, key: GroupKey) -> BaselineStats | None:
        return self.stats.get(key)

    def daily(self, coarse: tuple[str, str, str, str], start: date, end: date) -> list[DailyPoint]:
        """Daily points for a coarse key within an inclusive date range."""
        points = self.series.get(coarse, [])
        return [p for p in points if start <= p.day <= end]

    def observed_days(self, coarse: tuple[str, str, str, str], start: date, end: date) -> int:
        return len(self.daily(coarse, start, end))


def _cost_expr() -> str:
    return COST_CENTS_SQL


def _usage_expr(has_usage: bool) -> str:
    if not has_usage:
        return "CAST(0 AS DECIMAL(38,10))"
    return (
        "COALESCE(CAST(NULLIF(CAST(\"lineItem/UsageAmount\" AS VARCHAR), '') AS DECIMAL(38,10)), 0)"
    )


def _day_predicate(start: date, end: date) -> str:
    return day_predicate(start, end)


#: Stands in for a grouping column the file does not contain.
#:
#: A constant, not an error, and not a fabricated value. Referencing a missing
#: column is a DuckDB binder error, which surfaced as "check failed: internal
#: error" on a perfectly valid file. Grouping by a constant collapses that one
#: dimension, so the remaining dimensions still separate groups correctly and the
#: key slot comes back as ``NULL`` - which :func:`app.pipeline.ingest.text`
#: normalises to ``""``, exactly as it would for a present-but-empty column.
MISSING_COLUMN = "CAST(NULL AS VARCHAR)"


def _names(fields: tuple[str, ...], columns: frozenset[str] | None = None) -> str:
    """Projection expressions for a grouping, one slot per field.

    ``columns`` is the set the loaded file actually has. A field outside it
    becomes :data:`MISSING_COLUMN` rather than a reference that fails to bind.
    The **slot count is preserved**: callers unpack rows positionally into
    :class:`GroupKey`, so dropping a field would shift every later field one to
    the left and silently attribute a finding to the wrong service.

    ``columns=None`` means "not inspected, every field is present" - the
    pre-existing behaviour, and what tests that load synthetic tables rely on.

    Slot 0 is special: it is the service, derived by :func:`service_expr`
    rather than read from one column (Feature 1.6). Every slot is **aliased to
    its canonical field name**, because these projections are used inside
    subqueries whose output the outer ``GROUP BY`` binds against - and the
    outer level must reference a projected column, not re-derive the
    expression. Both grains this function serves put the service first, so the
    condition is on the field name rather than an index.
    """
    exprs: list[str] = []
    for f in fields:
        if f == BASELINE_FIELDS[0]:
            exprs.append(f'{service_expr(columns)} AS "{f}"')
        elif columns is None or f in columns:
            exprs.append(f'"{f}"')
        else:
            exprs.append(f"{MISSING_COLUMN} AS \"{f}\"")
    return ", ".join(exprs)


def _group_names(fields: tuple[str, ...]) -> str:
    """Grouping keys for the level *above* a :func:`_names` projection.

    Always the canonical field names, never the derivation: the queries this
    pairs with project ``_names`` in a subquery and group over its output, and
    the output's columns are named after the fields (the projection aliases
    them so). Re-spelling the service derivation here would reference base
    columns the subquery does not expose - the exact binder error the aliasing
    exists to prevent, found by ``test_baseline.py`` the first time this was
    written without it.
    """
    return ", ".join(f'"{f}"' for f in fields)


@precise
def build_baseline(
    con: duckdb.DuckDBPyConnection,
    window: DataWindow,
    *,
    columns: frozenset[str] | None = None,
    table: str = TABLE,
    baseline_where: str | None = None,
    primary_where: str | None = None,
) -> Baseline:
    """Build baseline statistics plus the daily series for both windows.

    The series is fetched over the *union* of baseline and check windows. It is
    not baseline data leaking into a baseline statistic - the statistics below
    are windowed separately - it is so a single query can serve both the
    lookback (spike z-score) and the current period (creep regression).

    History uses only its resolved baseline role and dates; current points use
    only the primary role and check dates. Gaps between the intervals are not
    observations. Omitted scopes resolve from the table's role metadata; a
    single-file table without roles keeps date-scoped history and current data.
    """
    baseline_where = resolve_role_scope(con, baseline_where, table=table, role=ROLE_BASELINE)
    primary_where = resolve_role_scope(con, primary_where, table=table)
    has_usage = columns is None or "lineItem/UsageAmount" in columns
    names = _names(BASELINE_FIELDS, columns)

    # --- daily series across both windows --------------------------------
    # Aggregation happens in a subquery because DuckDB will not re-aggregate a
    # computed alias in the same SELECT.
    #
    # The outer SELECT lists ONLY the aliases the subquery projects. The old
    # query re-spelled the full {names} projection - service derivation
    # included - at the outer level, and the outer scope sees the subquery's
    # projected columns, not the base table: for a real CUR 2.0 export, whose
    # service slot derives from "product/ServiceCode" rather than
    # "product/ProductName", that re-derivation referenced a column the
    # subquery does not expose and DuckDB refused to bind the query at all.
    # Every test passed because the fixture's files carry ProductName and the
    # re-derivation happens to be identical to the alias it binds against.
    series_scope = (
        f"(({baseline_where}) AND {_day_predicate(window.baseline_start, window.baseline_end)}) OR "
        f"(({primary_where}) AND {_day_predicate(window.start, window.end)})"
    )
    # Row layout: 0-6 grouping, 7 day, 8 cost_cents, 9 usage
    rows = con.execute(
        f"SELECT {_group_names(BASELINE_FIELDS)}, day, SUM(cost_cents) AS cost_cents, SUM(usage) AS usage "
        f"FROM ("
        f"  SELECT {names}, CAST(\"lineItem/UsageStartDate\" AS DATE) AS day, "
        f"         {_cost_expr()} AS cost_cents, {_usage_expr(has_usage)} AS usage "
        f"  FROM {table} WHERE ({series_scope})"
        f") GROUP BY {_group_names(BASELINE_FIELDS)}, day"
    ).fetchall()

    series: dict[tuple, list[DailyPoint]] = defaultdict(list)
    # One point per comparison key per day. The SQL groups by the full
    # 7-tuple + day, so a coarse key with several resources (an injected
    # spike resource beside the daily rollup, or two line items that differ
    # only by operation) produced MULTIPLE points for the same day here -
    # and every detector consumed them as consecutive time steps:
    #
    # - the spike detector compared each RESOURCE's day against the coarse
    #   p95 and reported the largest resource's cost as "Daily cost peaked
    #   at" (measured on the owner's 14-month file: a $184.97 group-day
    #   reported as $120.00 - one injected resource's own row - with the
    #   run's total excess understated by the missing resources);
    # - same-day hits from different resources became separate runs, whose
    #   findings share one make_finding_id (same coarse key, same window) -
    #   the upsert silently dropped the second finding, and with it real
    #   money;
    # - the creep regression treated each resource-day as its own time step,
    #   corrupting the slope and R-squared for every multi-resource group;
    # - the unexpected-charge impact summed per-resource excesses and
    #   subtracted the p95 once per resource instead of once per day.
    #
    # The documented contract (the docstring above) is ONE total per key per
    # day; this is where it is actually kept.
    per_day: dict[tuple, DailyPoint] = {}
    for r in rows:
        key = GroupKey(*(_s(v) for v in r[:7]))
        slot = (key.coarse, r[7])
        cost = Decimal(r[8] or 0)
        usage = Decimal(str(r[9] or 0))
        prev = per_day.get(slot)
        if prev is not None:
            per_day[slot] = DailyPoint(
                day=r[7], cost_cents=prev.cost_cents + cost, usage=prev.usage + usage
            )
        else:
            per_day[slot] = DailyPoint(day=r[7], cost_cents=cost, usage=usage)
    for (coarse, _day), point in per_day.items():
        series[coarse].append(point)
    for points in series.values():
        points.sort(key=lambda p: p.day)

    # --- baseline statistics, baseline window only, at the investigation grain
    # The comparison numbers (the ones detectors compare window against
    # baseline with) live in app.pipeline.comparison and are computed by
    # the orchestrator; these per-resource statistics are the grain a
    # customer investigates one specific resource at.
    stats, insufficient = _stats_at(
        con, BASELINE_FIELDS, window.baseline_start, window.baseline_end,
        has_usage, table, columns, baseline_where=baseline_where,
    )

    log.info(
        "baseline: %d per-resource groups (%d with thin history), "
        "series %s..%s",
        len(stats),
        insufficient,
        window.baseline_start,
        window.baseline_end,
    )
    return Baseline(
        stats=stats,
        series=dict(series),
        insufficient_groups=insufficient,
    )


@precise
def _stats_at(
    con: duckdb.DuckDBPyConnection,
    fields: tuple[str, ...],
    start: date,
    end: date,
    has_usage: bool,
    table: str,
    columns: frozenset[str] | None = None,
    *,
    baseline_where: str = "TRUE",
) -> tuple[dict[GroupKey, BaselineStats], int]:
    """Daily distribution statistics per grouping, over one date range.

    Row layout: 0..n-1 grouping, then the seven aggregates.
    """
    names = _names(fields, columns)
    # The outer SELECT references only the subquery's projected aliases;
    # re-spelling the service derivation here is the CUR 2.0 binder error -
    # see build_baseline.
    # Keep the existing row-statistic population (not a new daily grain).
    # DuckDB AVG/stddev can return DOUBLE; compute from exact decimal rows.
    from app.pipeline.comparison import quantile_cont
    rows = con.execute(
        f"SELECT {_group_names(fields)}, list(cost_cents), SUM(usage) FROM ("
        f"SELECT {names}, {_cost_expr()} AS cost_cents, {_usage_expr(has_usage)} AS usage "
        f"FROM {table} WHERE {_day_predicate(start, end)} AND ({baseline_where})"
        f") GROUP BY {_group_names(fields)}"
    ).fetchall()
    n = len(fields)
    out, insufficient = {}, 0
    for r in rows:
        padded = tuple(_s(v) for v in r[:n]) + ("",) * (7 - n)
        key = GroupKey(*padded)
        values = [Decimal(value) for value in r[n]]
        total, count = sum(values, Decimal(0)), len(values)
        mean = total / count if count else Decimal(0)
        deviation = (sum(((v-mean)**2 for v in values), Decimal(0))/count).sqrt() if count else Decimal(0)
        usage = Decimal(r[n+1] or 0)
        stat = BaselineStats(key, count, total, mean,
            quantile_cont(values, Decimal('.5')), quantile_cont(values, Decimal('.95')),
            deviation, usage, (total/100)/usage if usage > 0 else None)
        out[key] = stat
        insufficient += int(not stat.sufficient)
    return out, insufficient


@precise
def check_window_totals(
    con: duckdb.DuckDBPyConnection,
    window: DataWindow,
    *,
    columns: frozenset[str] | None = None,
    table: str = TABLE,
    fields: tuple[str, ...] = BASELINE_FIELDS,
    where: str | None = None,
) -> dict[GroupKey, int]:
    """Total cost per group inside the check window, in cents.

    Defaults to the per-resource grain. Detectors pass the comparison grain
    (:data:`~app.pipeline.comparison.COMPARISON_FIELDS`) so
    the window total is measured at the same grain as the baseline it is compared
    against - a per-resource total has no per-resource baseline to compare it to.

    ``where`` scopes the rows (the checked files' role on a file-baseline
    check, ``"TRUE"`` otherwise); appended unconditionally so callers do not
    have to branch on how the table was loaded.
    """
    where = resolve_role_scope(con, where, table=table)
    names = _names(fields, columns)
    n = len(fields)
    # Row layout: 0..n-1 grouping, n total
    # The outer SELECT references only the subquery's projected aliases -
    # see build_baseline for why re-spelling {names} at the outer level is a
    # binder error on a real CUR 2.0 export.
    rows = con.execute(
        f"SELECT {_group_names(fields)}, SUM(cost_cents) AS total_cents "
        f"FROM ("
        f"  SELECT {names}, {_cost_expr()} AS cost_cents "
        f"  FROM {table} WHERE {_day_predicate(window.start, window.end)} AND ({where})"
        f") GROUP BY {_group_names(fields)}"
    ).fetchall()
    out = {}
    for r in rows:
        padded = tuple(_s(v) for v in r[:n]) + ("",) * (7 - n)
        out[GroupKey(*padded)] = Decimal(r[n] or 0)
    return out
