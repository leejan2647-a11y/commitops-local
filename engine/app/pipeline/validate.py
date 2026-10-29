"""Step 2 - validate before trusting anything.

Four checks, and a deliberate policy decision that shapes the whole module:

> If it doesn't reconcile, don't block the check — record and surface it.

A customer whose file is 3 cents off the manifest still wants to know what is
wrong with their AWS bill. Blocking them would make us useless exactly when we
are needed. So nothing here raises or short-circuits: every problem becomes a
field on :class:`ValidationReport` and the caller decides what to do.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

import duckdb

from app.pipeline.canonical import statistics
from app.pipeline.ingest import TABLE, cost_sum_cents
from app.pipeline.types import REQUIRED_COLUMNS, to_cents

log = logging.getLogger(__name__)

#: Reconciliation tolerance per the product rule: the looser of a flat $1 or
#: 0.01% of the total. Below the flat $1 the tolerance is dominated by rounding
#: in CUR itself, so anything under a dollar is noise.
RELATIVE_TOLERANCE = Decimal("0.0001")
FLAT_TOLERANCE_CENTS = 100

RECONCILIATION_COMPLETE = "complete"
RECONCILIATION_PARTIAL = "partial"
RECONCILIATION_FAILED = "failed"
#: Used when no manifest exists. A CSV upload carries no stated total, so there
#: is nothing to compare against and we say so rather than implying we checked.
RECONCILIATION_UNAVAILABLE = "unavailable"

DEDUPED_TABLE = "cur_deduped"


@dataclass
class ValidationReport:
    """Everything we learned about the file's trustworthiness."""

    total_rows: int
    unique_rows: int
    duplicate_rows: int
    duplicate_rate: Decimal

    missing_required: list[str] = field(default_factory=list)
    optional_columns_present: list[str] = field(default_factory=list)

    data_min_date: date | None = None
    data_max_date: date | None = None
    #: Days between the newest charge in the file and ``as_of``.
    freshness_days: int | None = None
    is_fresh: bool = False

    computed_total_cents: int | None = 0
    # File reconciliation and selected-window spend are different measurements.
    window_total_cents: int | None = None
    window_rows: int | None = None
    baseline_rows: int | None = None
    assessment_status: str = "unknown"
    declared_total_cents: int | None = None
    variance_cents: int | None = None
    tolerance_cents: int = FLAT_TOLERANCE_CENTS
    reconciliation_status: str = RECONCILIATION_UNAVAILABLE

    caveats: list[str] = field(default_factory=list)
    canonicalization: dict = field(default_factory=dict)
    #: Immutable source-observed daily series, captured before DuckDB closes.
    spend_history: dict | None = None

    @property
    def schema_ok(self) -> bool:
        return not self.missing_required

    def to_dict(self) -> dict:
        """JSON-ready form. Decimals become strings so no float rounding leaks
        into the API response."""
        return {
            "totalRows": self.total_rows,
            "uniqueRows": self.unique_rows,
            "duplicateRows": self.duplicate_rows,
            "duplicateRate": str(self.duplicate_rate),
            "schemaOk": self.schema_ok,
            "missingRequired": self.missing_required,
            "dataMinDate": self.data_min_date.isoformat() if self.data_min_date else None,
            "dataMaxDate": self.data_max_date.isoformat() if self.data_max_date else None,
            "freshnessDays": self.freshness_days,
            "isFresh": self.is_fresh,
            "computedTotalCents": self.computed_total_cents,
            "windowTotalCents": self.window_total_cents,
            "windowRows": self.window_rows,
            "baselineRows": self.baseline_rows,
            "assessmentStatus": self.assessment_status,
            "declaredTotalCents": self.declared_total_cents,
            "varianceCents": self.variance_cents,
            "toleranceCents": self.tolerance_cents,
            "reconciliationStatus": self.reconciliation_status,
            "caveats": self.caveats,
            "canonicalization": self.canonicalization,
            **({"spendHistory": self.spend_history} if self.spend_history is not None else {}),
        }


def duplicate_stats(con: duckdb.DuckDBPyConnection) -> tuple[int, int, int]:
    """Return ``(total, unique, duplicate)`` row counts.

    Ingestion establishes observation identity and full-payload equality before
    analysis. Conflicting versions are refused there; this reads its counts.
    """
    stats = statistics(con)
    if stats:
        return stats["rawRows"], stats["canonicalRows"], stats["removedCopyRows"]
    total = int(con.execute(f"SELECT count(*) FROM {TABLE}").fetchone()[0])
    return total, total, 0


def deduplicate(con: duckdb.DuckDBPyConnection) -> int:
    """Expose a compatibility copy of the already canonical analytical table."""
    con.execute(f"CREATE OR REPLACE TABLE {DEDUPED_TABLE} AS SELECT * FROM {TABLE}")
    return int(con.execute(f"SELECT count(*) FROM {DEDUPED_TABLE}").fetchone()[0])


def date_range(con: duckdb.DuckDBPyConnection) -> tuple[date | None, date | None]:
    """Min/max ``lineItem/UsageStartDate`` in the file."""
    row = con.execute(
        f'SELECT min(TRY_CAST("lineItem/UsageStartDate" AS DATE)), '
        f'max(TRY_CAST("lineItem/UsageStartDate" AS DATE)) FROM {TABLE}'
    ).fetchone()
    if not row or row[0] is None:
        return None, None
    return row[0], row[1]


def validate(
    con: duckdb.DuckDBPyConnection,
    columns: frozenset[str],
    *,
    as_of: date,
    declared_total: object = None,
    primary_where: str = "TRUE",
) -> ValidationReport:
    """Run all four checks and return a report.

    :param declared_total: the total the CUR manifest claims, if one exists. For
        a file upload there is no manifest and this stays ``None``, which yields
        ``reconciliation_status = "unavailable"``. We never fabricate a stated
        total from the data itself — that would make reconciliation circular.
    :param primary_where: scopes the *money* (the computed total) to the checked
        files' rows when a file-baseline check is running. A baseline month's
        spend is history, not this window's bill, and the row/duplicate/date
        statistics deliberately stay unscoped: they describe the dataset the
        check actually loaded.
    """
    total_rows, unique_rows, duplicate_rows = duplicate_stats(con)
    duplicate_rate = (
        (Decimal(duplicate_rows) / Decimal(total_rows)).quantize(Decimal("0.000001"))
        if total_rows
        else Decimal(0)
    )
    min_date, max_date = date_range(con)
    computed_total = cost_sum_cents(con, primary_where)

    report = ValidationReport(
        total_rows=total_rows,
        unique_rows=unique_rows,
        duplicate_rows=duplicate_rows,
        duplicate_rate=duplicate_rate,
        missing_required=sorted(REQUIRED_COLUMNS - columns),
        data_min_date=min_date,
        data_max_date=max_date,
        computed_total_cents=computed_total,
        canonicalization=statistics(con) or {},
    )

    if duplicate_rows:
        report.caveats.append(
            f"{duplicate_rows} exact duplicate row(s) removed "
            f"({duplicate_rate * 100:.4f}% of the file)"
        )

    # --- freshness -------------------------------------------------------
    if max_date is None:
        report.caveats.append("no parseable lineItem/UsageStartDate found; cannot assess freshness")
    else:
        report.freshness_days = (as_of - max_date).days
        # A month is the CUR delivery cadence, so anything inside that is normal.
        report.is_fresh = report.freshness_days <= 31
        if not report.is_fresh:
            report.caveats.append(
                f"newest charge is {report.freshness_days} days old; the file may be a stale export"
            )

    # --- reconciliation --------------------------------------------------
    report.tolerance_cents = max(
        FLAT_TOLERANCE_CENTS,
        int(Decimal(computed_total) * RELATIVE_TOLERANCE),
    )
    if declared_total is None:
        report.reconciliation_status = RECONCILIATION_UNAVAILABLE
        report.caveats.append(
            "no CUR manifest available for this source, so the row total could not be "
            "reconciled against a stated total"
        )
    else:
        report.declared_total_cents = to_cents(declared_total)
        variance = report.computed_total_cents - report.declared_total_cents
        report.variance_cents = variance
        if abs(variance) <= report.tolerance_cents:
            report.reconciliation_status = RECONCILIATION_COMPLETE
        else:
            ratio = (
                (Decimal(abs(variance)) / Decimal(report.declared_total_cents)).quantize(
                    Decimal("0.0001")
                )
                if report.declared_total_cents
                else Decimal(0)
            )
            # "Partial" is a real category, not a euphemism: close enough to be
            # an exchange-rate or rounding artefact, far enough to be worth
            # telling the customer about.
            report.reconciliation_status = (
                RECONCILIATION_PARTIAL if ratio <= Decimal("0.01") else RECONCILIATION_FAILED
            )
            report.caveats.append(
                f"row total differs from the manifest by {variance} cents "
                f"({ratio * 100:.4f}%), tolerance {report.tolerance_cents} cents"
            )

    log.info(
        "validation: %d rows (%d dup), %s..%s, reconciliation=%s",
        total_rows,
        duplicate_rows,
        min_date,
        max_date,
        report.reconciliation_status,
    )
    return report
