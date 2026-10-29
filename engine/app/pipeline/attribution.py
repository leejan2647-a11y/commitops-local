"""Task 4 - attribution: who caused a flagged jump, and by how much.

Detection answers "did this group jump?"; this module answers the customer's
actual next question: **which resource caused it**. The rules the task pins:

* **Every resource is compared to its own baseline, never to the group's.**
  A resource that quietly ran at $2/day inside a group that ran at $10/day
  would look like an $8 jump against the group's figures; against its own
  baseline the same resource that rose to $12/day is a $10 jump, and that is
  the number that attributes the finding.
* **A resource absent from the baseline is new**, and its baseline is zero:
  the whole window cost is excess.
* **Contributors are ranked by excess, largest first.**

The output is one auditable record per finding - the group, the detection
type, the baseline upper limit, the window figures (or the spiking day), the
excess, the ranked contributors with their baseline and window figures and
whether each is new, and the dates involved - stored on the finding's
``stats["attribution"]`` where it persists and renders like every other
statistic.

The comparison machinery is :mod:`app.pipeline.comparison`'s - the same cost
column, the same zero-fill - at one grain finer: the resource id joins the
grouping key, which is the field detection deliberately excluded and exactly
whose turn it is here. A resource's "normal" is its own baseline **daily
average**: attribution ranks growth, and a resource's own average is the
fair baseline for that question; the group's p95 stays what detection
measured against.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from app.pipeline.baseline import GroupKey, service_expr
from app.pipeline.comparison import COMPARISON_FIELDS, period_daily
from app.pipeline.ingest import ROLE_BASELINE, TABLE, resolve_role_scope
from app.pipeline.money import cents, precise

if TYPE_CHECKING:  # pragma: no cover - typing only
    import duckdb

    from app.pipeline.types import DataWindow

log = logging.getLogger(__name__)

#: The attribution grain: the comparison key plus the resource id.
ATTRIBUTION_FIELDS: tuple[str, ...] = COMPARISON_FIELDS + ("lineItem/ResourceId",)

#: How many contributors the record carries. The ranking is computed over
#: every resource in the group; this bounds what a payload renders, and
#: ``contributorCount`` keeps the truth about how many there were.
MAX_CONTRIBUTORS = 25

#: The detection names an evidence record reports, so the payload is
#: self-describing without importing the detector vocabulary.
DETECTION_SPIKE = "spike"
DETECTION_SUSTAINED = "sustained-increase"


def _group_predicate(key: GroupKey, columns: frozenset[str] | None) -> str:
    """SQL scoping the rows to the flagged group, at the comparison grain.

    The service slot is a derivation, so it is compared as one; every other
    slot is a literal. Same shape as the evidence module's predicate, for
    the same reason: a derived column cannot be matched by name.
    """
    service = key.service.replace("'", "''")
    parts = [f"{service_expr(columns)} = '{service}'"]
    for column, value in (
        ("lineItem/UsageAccountId", key.account),
        ("product/Region", key.region),
        ("lineItem/UsageType", key.usage_type),
    ):
        if not value:
            continue
        if columns is not None and column not in columns:
            continue
        parts.append(f"\"{column}\" = '{value.replace(chr(39), chr(39) * 2)}'")
    return " AND ".join(parts)


def _half_up(numerator: int, denominator: int) -> int:
    """Legacy integer reporting helper using application HALF_UP policy."""
    if denominator <= 0:
        return 0
    return (2 * numerator + denominator) // (2 * denominator)


@precise
def build_attribution(
    con: "duckdb.DuckDBPyConnection",
    *,
    key: GroupKey,
    window: "DataWindow",
    columns: frozenset[str] | None,
    table: str = TABLE,
    where: str | None = None,
    baseline_where: str | None = None,
    detection: str = DETECTION_SUSTAINED,
    baseline_upper_limit_cents: int = 0,
    excess_cents: int = 0,
    spike_day: date | None = None,
    window_values: dict | None = None,
    run_start: date | None = None,
    run_end: date | None = None,
) -> dict:
    """The auditable record for one flagged group.

    ``spike_day`` narrows the window side to that single day - a spike is
    about the day it happened - and without it the whole window is attributed.
    ``window_values`` is the detection's own window summary, carried verbatim
    so the record and the finding can never disagree.

    ``where`` scopes the window side and ``baseline_where`` the baseline side,
    exactly as the comparison numbers were scoped: on a file-baseline check
    the two halves of the record read different halves of the table.
    """
    where = resolve_role_scope(con, where, table=table)
    baseline_where = resolve_role_scope(con, baseline_where, table=table, role=ROLE_BASELINE)
    scope = f"({_group_predicate(key, columns)}) AND ({where})"
    baseline_scope = f"({_group_predicate(key, columns)}) AND ({baseline_where})"

    start = run_start or spike_day or window.start
    end = run_end or spike_day or window.end
    window_days = (end - start).days + 1
    baseline_days = (window.baseline_end - window.baseline_start).days + 1

    window_daily = period_daily(
        con,
        start=start,
        end=end,
        columns=columns,
        table=table,
        where=scope,
        fields=ATTRIBUTION_FIELDS,
    )
    baseline_daily = period_daily(
        con,
        start=window.baseline_start,
        end=window.baseline_end,
        columns=columns,
        table=table,
        where=baseline_scope,
        fields=ATTRIBUTION_FIELDS,
    )

    contributors: list[dict] = []
    for wkey, wseries in window_daily.items():
        window_total = sum(wseries.by_day.values())
        bseries = baseline_daily.get(wkey)
        if bseries is None:
            # Absent from the baseline: new, and every cent is excess.
            baseline_total = 0
            is_new = True
        else:
            baseline_total = sum(bseries.by_day.values())
            is_new = False
        # The resource's own normal: its baseline total spread over the
        # attributed period, so a 146-day baseline is compared against a
        # 31-day window (or one day) without either distorting the other.
        normal = Decimal(baseline_total) * window_days / baseline_days
        contributors.append(
            {
                "resource": wkey.resource,
                "isNew": is_new,
                "baseline": {
                    "totalCents": cents(baseline_total),
                    "avgDailyCents": cents(Decimal(baseline_total) / baseline_days),
                },
                "window": {
                    "totalCents": cents(window_total),
                    "days": window_days,
                    "avgDailyCents": cents(Decimal(window_total) / window_days),
                },
                "excessCents": cents(max(window_total - normal, 0)),
            }
        )

    contributors.sort(key=lambda c: (-c["excessCents"], c["resource"]))
    contributor_count = len(contributors)

    record: dict = {
        "contributionBasis": "resource_mean_comparison",
        "measurementPeriod": {
            "start": f"{start.isoformat()}T00:00:00Z",
            "end": f"{(end + timedelta(days=1)).isoformat()}T00:00:00Z",
        },
        "group": {
            "service": key.service,
            "account": key.account,
            "region": key.region,
            "usageType": key.usage_type,
        },
        "detection": detection,
        "baselineUpperLimitCents": baseline_upper_limit_cents,
        "excessCents": excess_cents,
        "contributors": contributors[:MAX_CONTRIBUTORS],
        "contributorCount": contributor_count,
        "dates": {
            "baselineStart": window.baseline_start.isoformat(),
            "baselineEnd": window.baseline_end.isoformat(),
            "windowStart": window.start.isoformat(),
            "windowEnd": window.end.isoformat(),
        },
    }
    if spike_day is not None:
        day_total = sum(s.by_day.get(spike_day, 0) for s in window_daily.values())
        record["spikingDay"] = {
            "day": spike_day.isoformat(),
            "dayCents": cents(day_total),
        }
    else:
        record["window"] = window_values or {}
    return record
