"""Step 5 - go back to the rows that caused the finding.

This is the module that carries the product's central promise:

> Don't just flag it. Show the evidence, and if the evidence does not add up,
> say so. Never claim "AWS made an error" - only show evidence and let the
> customer judge.

Keep each row's original cost separate from its calculated contribution.
Contributions describe excess over the daily baseline across the window;
detector amounts can describe a peak day or a trend instead, so they are not
automatically comparable or additive. The UI names those measurement periods.
"""

from __future__ import annotations

import logging
import heapq
import pickle
from contextlib import ExitStack, closing
from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import duckdb

from app.pipeline.baseline import GroupKey, service_expr
from app.pipeline.comparison import COMPARISON_FIELDS
from app.pipeline.ingest import COST_CENTS_SQL, TABLE, day_predicate, resolve_role_scope, text
from app.pipeline.money import cents, precise
from app.pipeline.types import EvidenceSummary, from_cents

log = logging.getLogger(__name__)

#: How many contributing rows to keep for display. The sum is always over *all*
#: contributing rows; this only bounds what the UI renders.
MAX_TOP_ROWS = 25

# Python objects never grow with the finding population. DuckDB owns the daily
# aggregate/join/sort and can spill under the analysis connection's memory limit.
_BATCH_ROWS = 1024
_SORT_CHUNK_BYTES = 4 * 1024 * 1024
_MERGE_FAN_IN = 16
_SHARE_CACHE_SIZE = 4096


class _TopRow:
    """A heap whose root is the least desirable displayed contribution."""

    def __init__(self, contribution, stable, ordinal, row):
        self.rank = (-contribution, stable, ordinal)
        self.row = row

    def __lt__(self, other):
        return self.rank > other.rank


def _records(path):
    with path.open("rb") as handle:
        while True:
            # EOF between records is normal. EOF inside a record must fail;
            # treating a truncated pickle as completion could lose money.
            if not handle.peek(1):
                return
            yield pickle.load(handle)


class _RemainderSort:
    """Private exact external sort; files are produced here, never user input.

    Leveled merges bound both descriptors and the manifest. Each record uses
    (-Fraction(remainder), original stable tuple, stream ordinal), preserving
    Hamilton's global order without a fixed precision approximation.
    """

    def __init__(self, directory, checkpoint):
        self.directory = Path(directory)
        self.checkpoint = checkpoint
        self.chunk = []
        self.chunk_bytes = 0
        self.levels = []
        self.sequence = 0

    def _path(self):
        self.sequence += 1
        return self.directory / f"run-{self.sequence}.bin"

    def _merge(self, paths):
        target = self._path()
        self.checkpoint()
        with ExitStack() as stack, target.open("wb") as output:
            streams = []
            for path in paths:
                stream = _records(path)
                stack.callback(stream.close)
                streams.append(stream)
            for index, record in enumerate(heapq.merge(*streams)):
                if index % _BATCH_ROWS == 0:
                    self.checkpoint()
                pickle.dump(record, output, protocol=pickle.HIGHEST_PROTOCOL)
        for path in paths:
            path.unlink()
        return target

    def _add_run(self, path, level=0):
        while len(self.levels) <= level:
            self.levels.append([])
        self.levels[level].append(path)
        if len(self.levels[level]) == _MERGE_FAN_IN:
            merged = self._merge(self.levels[level])
            self.levels[level] = []
            self._add_run(merged, level + 1)

    def add(self, record):
        # Serialized length includes customer strings; a row-count-only chunk
        # cap would allow wide rows to defeat the Python memory bound.
        encoded = pickle.dumps(record, protocol=pickle.HIGHEST_PROTOCOL)
        self.chunk.append((record, encoded))
        self.chunk_bytes += len(encoded)
        if self.chunk_bytes >= _SORT_CHUNK_BYTES:
            self.flush()

    def flush(self):
        if not self.chunk:
            return
        self.checkpoint()
        path = self._path()
        self.chunk.sort(key=lambda item: item[0][:3])
        with path.open("wb") as output:
            for _, encoded in self.chunk:
                output.write(encoded)
        self.chunk.clear()
        self.chunk_bytes = 0
        self._add_run(path)

    def ordered(self):
        self.flush()
        paths = [path for level in self.levels for path in level]
        while len(paths) > _MERGE_FAN_IN:
            paths = [self._merge(paths[i:i + _MERGE_FAN_IN])
                     for i in range(0, len(paths), _MERGE_FAN_IN)]
        with ExitStack() as stack:
            streams = []
            for path in paths:
                stream = _records(path)
                stack.callback(stream.close)
                streams.append(stream)
            yield from heapq.merge(*streams)


def _col(column: str, columns: frozenset[str] | None) -> str:
    """A display column, tolerating one the file does not have.

    ``identity/LineItemId``, ``lineItem/UsageStartDate``, the account, usage type
    and operation are all required at ingest, so only the ``product/*`` and
    resource columns can be missing - and CUR 2.0 has no flat
    ``product/ProductName`` to map. Referencing it anyway is a binder error, which
    a finding's evidence card would have surfaced as a failed check.
    """
    if columns is None or column in columns:
        return f"COALESCE(\"{column}\", '')"
    return "''"


def _key_predicate(
    key: GroupKey, fields: tuple[str, ...], columns: frozenset[str] | None = None
) -> tuple[str, list[str]]:
    """Match the exact grouping.

    ``fields`` selects the grain. It defaults to
    :data:`~app.pipeline.comparison.COMPARISON_FIELDS` because a
    finding is *detected* at the coarse grain, and evidence gathered at a
    different grain than the finding was measured at selects the wrong rows -
    requiring ``resource = ''`` for a spike that was measured across many
    resources returns nothing at all, and an evidence total of zero presented
    next to a non-zero impact is worse than no evidence card.

    NULL-safe on purpose: DuckDB's ``=`` against NULL yields NULL, so a column
    that is empty in this month would silently drop every row.

    A field absent from the file becomes a tautology rather than being skipped.
    The key slot for a missing field is ``""`` (the baseline grouped that
    dimension as a constant), so it must constrain nothing - but dropping the
    clause outright would also drop it for a *present* column that merely happens
    to be empty everywhere, which is a different case and a much narrower match.
    """
    parts, parameters = [], []
    for field, value in zip(fields, key.as_tuple()):
        if field == "product/ProductName":
            # The service slot is a derivation, not a column (Feature 1.6), and
            # the predicate must compare the *same* expression the grouping
            # used. Matching against the raw ProductName while the finding was
            # detected against a ServiceCode grouping selects no rows - an
            # evidence total of zero next to a non-zero impact, which is worse
            # than no evidence card. A key built when the file had no chain
            # column at all carries '' here, and service_expr returns a
            # constant '' for that file, so '' = '' holds as the tautology
            # below intends.
            service = service_expr(columns)
            if service == "''":
                parts.append("'' = ''")
                continue
            parts.append(f"{service} = ?")
            parameters.append(value)
            continue
        if columns is not None and field not in columns:
            parts.append("'' = ''")  # the key slot for an absent field is always ''
            continue
        parts.append(f"COALESCE(\"{field}\", '') = ?")
        parameters.append(value)
    if not parts:
        raise ValueError("evidence needs at least one grouping field")
    return " AND ".join(parts), parameters


@precise
def build_evidence(
    con: duckdb.DuckDBPyConnection,
    *,
    key: GroupKey,
    start: date,
    end: date,
    impact_cents: int,
    allowance_cents: int = 0,
    columns: frozenset[str] | None = None,
    table: str = TABLE,
    fields: tuple[str, ...] = COMPARISON_FIELDS,
    primary_where: str | None = None,
    impact_scope: dict | None = None,
    source_filter: tuple[str, list[str]] | None = None,
) -> EvidenceSummary:
    """Sum the billing rows responsible for a finding.

    :param allowance_cents: the normal daily cost, subtracted once from each day
        before allocating excess to its positive-cost rows. For a spike this is the
        group's baseline daily p95, so a $50 day against a $10 baseline
        contributes $40 - the increase - not $50. For a genuinely new charge
        pass 0, because the whole row is new.
    :param impact_cents: the detector's amount, used only for diagnostic logging.
        The returned contribution total is calculated independently from rows.
    :param primary_where: scopes the rows to the checked files when a
        file-baseline check is running (a baseline file may contain rows inside
        the check window; evidence is money, so the source role is a filter).
        ``"TRUE"`` on every single-source table.
    """
    primary_where = resolve_role_scope(con, primary_where, table=table)
    actual_columns = {r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall()}
    identity_columns = (
        "_commitops_role",
        "_commitops_partition",
        "_commitops_payer",
        "_commitops_identity",
        "_commitops_row_hash",
    )
    tie_sql = ", " + ", ".join(
        '"' + name + '"' if name in actual_columns else "''" for name in identity_columns
    )
    grouping, parameters = _key_predicate(key, fields, columns)
    if source_filter:
        grouping += f" AND ({source_filter[0]})"
        parameters.extend(source_filter[1])
    selected_sql = (
        f'SELECT "identity/LineItemId", '
        f'       CAST("lineItem/UsageStartDate" AS DATE) AS day, '
        f"       {service_expr(columns)} AS service, "
        f"       {_col('lineItem/UsageAccountId', columns)} AS account, "
        f"       {_col('product/Region', columns)} AS region, "
        f"       {_col('lineItem/ResourceId', columns)} AS resource, "
        f"       {_col('lineItem/UsageType', columns)} AS usage_type, "
        f"       {_col('lineItem/Operation', columns)} AS operation, "
        f"       {COST_CENTS_SQL} AS cost_cents {tie_sql} "
        f"FROM {table} "
        f"WHERE {grouping} "
        f"  AND {day_predicate(start, end)} "
        f"  AND {primary_where}"
    )
    # Ingest validates the absolute sum below 10**26 dollars before this step;
    # SUM(DECIMAL(38,10) cents) therefore has the same exact value as the former
    # Decimal(precision=80) Python daily sums, with no overflow or rounding.
    daily_table = "_evidence_daily_" + uuid4().hex
    daily_sql = f"""
        CREATE TEMP TABLE {daily_table} AS
        WITH selected AS ({selected_sql})
            SELECT day, SUM(cost_cents) AS net,
                   SUM(CASE WHEN cost_cents > 0 THEN cost_cents ELSE 0 END) AS weight,
                   COUNT(*) AS source_count,
                   COUNT(*) FILTER (WHERE cost_cents = 0) AS zero_count,
                   COUNT(*) FILTER (WHERE cost_cents > 0) AS positive_count
            FROM selected GROUP BY day
    """
    query = f"""
        WITH selected AS ({selected_sql})
        SELECT selected.*, daily.net, daily.weight
        FROM selected JOIN {daily_table} daily
             ON selected.day IS NOT DISTINCT FROM daily.day
    """
    allowance = max(Decimal(allowance_cents), Decimal(0))
    raw_target, floor_total = Decimal(0), 0
    zero_cost, raw_positive, source_count, contributor_count = 0, 0, 0, 0
    streamed_count, fractional_count, allocated_total = 0, 0, 0
    positive_excess_days = []  # only min/max are needed for the run-bound proof
    top_heap = []

    @lru_cache(maxsize=_SHARE_CACHE_SIZE)
    def allocation_for(net, weight, cost):
        excess = max(net - allowance, Decimal(0))
        if not excess or not weight or cost <= 0:
            return None
        share = Fraction(excess) * Fraction(cost) / Fraction(weight)
        floor = share.numerator // share.denominator
        return floor, share - floor

    def contribute(contribution, stable, ordinal, row):
        nonlocal contributor_count, allocated_total
        allocated_total += contribution
        if contribution:
            contributor_count += 1
            candidate = _TopRow(contribution, stable, ordinal, row)
            if len(top_heap) < MAX_TOP_ROWS:
                heapq.heappush(top_heap, candidate)
            elif candidate.rank < top_heap[0].rank:
                heapq.heapreplace(top_heap, candidate)

    def checkpoint():
        # Production AnalysisConnection checks its disk-reserve failure flag
        # here as well as during SQL. A separate row cursor keeps its stream.
        con.execute("SELECT 1").fetchone()

    temp_root = Path(con.execute("SELECT current_setting('temp_directory')").fetchone()[0] or ".")
    temp_root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="evidence-", dir=temp_root) as directory:
        sorter = _RemainderSort(directory, checkpoint)
        reader = con.cursor()
        try:
            reader.execute(daily_sql, parameters)
            reader.execute(f"SELECT * FROM {daily_table}")
            while batch := reader.fetchmany(_BATCH_ROWS):
                checkpoint()
                for day, net, weight, count, zeros, positives in batch:
                    source_count += count
                    zero_cost += zeros
                    raw_positive += positives
                    excess = max(net - allowance, Decimal(0))
                    if excess and weight:
                        raw_target += excess
                        if not positive_excess_days:
                            positive_excess_days[:] = [day, day]
                        else:
                            positive_excess_days[0] = min(positive_excess_days[0], day)
                            positive_excess_days[1] = max(positive_excess_days[1], day)
            reader.execute(query, parameters)
            ordinal = 0
            while batch := reader.fetchmany(_BATCH_ROWS):
                checkpoint()
                for packed in batch:
                    streamed_count += 1
                    row = packed[:14]
                    ordinal += 1
                    net, weight = packed[14:]
                    allocation = allocation_for(net, weight, row[8])
                    if allocation is None:
                        continue
                    floor, remainder = allocation
                    floor_total += floor
                    stable = tuple(str(v or "") for v in row[9:]) + tuple(str(v or "") for v in row[:9])
                    if remainder:
                        fractional_count += 1
                        sorter.add((-remainder, stable, ordinal, floor, row))
                    else:
                        contribute(floor, stable, ordinal, row)
        finally:
            try:
                reader.execute(f"DROP TABLE IF EXISTS {daily_table}")
            finally:
                reader.close()
        total_cents = cents(raw_target)
        awards = total_cents - floor_total
        if streamed_count != source_count or not 0 <= awards <= fractional_count:
            raise RuntimeError("Evidence allocation population or remainder count is inconsistent")
        ranked_count = 0
        with closing(sorter.ordered()) as ordered:
            for rank, (_, stable, ordinal, floor, row) in enumerate(ordered):
                ranked_count += 1
                if rank % _BATCH_ROWS == 0:
                    checkpoint()
                contribute(floor + int(rank < awards), stable, ordinal, row)
        if ranked_count != fractional_count or allocated_total != total_cents:
            raise RuntimeError("Evidence allocation spool or monetary total is inconsistent")

    top = []
    for item in sorted(top_heap, key=lambda item: item.rank):
        r = item.row
        contribution = -item.rank[0]
        top.append({
            "lineItemId": text(r[0]),
            "date": r[1].isoformat() if r[1] else None,
            "service": text(r[2]),
            "account": text(r[3]),
            "region": text(r[4]),
            "resource": text(r[5]),
            "usageType": text(r[6]),
            "operation": text(r[7]),
            "costCents": cents(r[8]),
            "contributionCents": contribution,
        })

    proof = None
    if impact_scope and impact_scope.get("kind") == "unexpected-charge":
        proof = "full_window_same_formula"
    elif impact_scope and impact_scope.get("kind") == "spike":
        try:
            first = date.fromisoformat(impact_scope["runFirstDay"])
            days = impact_scope["runDays"]
            if (
                type(days) is int
                and days > 0
                and all(first <= day < first + timedelta(days=days) for day in positive_excess_days)
            ):
                proof = "spike_excess_days_within_run"
        except (ValueError, TypeError, KeyError):
            pass
    comparison = {
        "version": "same_population_v1",
        "status": "comparable" if proof else "unavailable",
        "proof": proof,
        "reason": "The detector amount and contribution use the same positive-excess population."
        if proof
        else "The detector amount and full-check contribution do not have a proven matching period and calculation basis. Review their scopes separately; no unexplained remainder is asserted.",
    }
    evidence = EvidenceSummary(
        evidence_total=from_cents(total_cents),
        line_item_count=contributor_count,
        top_line_items=top,
        zero_cost_line_items=zero_cost,
        source_row_count=source_count,
        raw_positive_row_count=raw_positive,
        impact_comparison=comparison,
        displayed_contribution_cents=sum(item["contributionCents"] for item in top),
        explained_not_displayed_cents=total_cents - sum(item["contributionCents"] for item in top),
        scope="spike_run_positive_excess"
        if impact_scope and impact_scope.get("selectedRun")
        else "full_window_positive_excess",
        period={
            "start": f"{start.isoformat()}T00:00:00Z",
            "end": f"{(end + timedelta(days=1)).isoformat()}T00:00:00Z",
        },
    )
    remainder = max(impact_cents - total_cents, 0)
    log.info(
        "evidence for %s: %d contributing rows, %d cents explained, %d cents unexplained",
        key.label(),
        contributor_count,
        total_cents,
        remainder,
    )
    return evidence


def evidence_covers(evidence: EvidenceSummary, impact_cents: int) -> bool:
    """True when the rows fully account for the claimed impact."""
    return int(evidence.evidence_total * 100) >= impact_cents
