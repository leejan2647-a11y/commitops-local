"""Validate the saved daily observation snapshot before exposing money."""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError

from app.pipeline.comparison import MIN_HISTORY_DAYS, comparison_guard
from app.pipeline.finding_amounts import period
from app.pipeline.money import cents, precise
from app.pipeline.spend_history import CAVEATS, MAX_DAYS, VERSION, reason
from app.pipeline.types import DataWindow
from app.schemas.schemas import DashboardSpendHistory
from app.services.finding_measurements import window_total


def unavailable(check, code="snapshot_unavailable", message=None):
    start, end = check.window_start, check.window_end
    return DashboardSpendHistory(
        check_id=check.id, status="unavailable", currency=None,
        window={"start": start, "end": end,
                "days": (end - start).days + 1 if start and end and end >= start else None,
                "observed_days": None},
        daily=[], total_cents=None,
        baseline={"status": "unavailable", "daily_average_cents": None,
                  "start": None, "end": None, "days": None, "observed_days": None,
                  "source": None},
        source_formats=[], reconciliation_status="unavailable",
        reasons=[reason(code, message or "This saved check has no verified daily observation snapshot.",
                        "Run a new check from the original authoritative files. Earlier checks are not recomputed or backfilled.")],
        caveats=list(CAVEATS),
    )


def require(condition):
    # These checks protect financial provenance in optimized Python as well.
    if not condition:
        raise ValueError("Unverified daily observation snapshot")


@precise
def read(check):
    """Reject malformed/legacy snapshots rather than relabeling old numbers."""
    validation = check.validation_report
    if not isinstance(validation, dict):
        return unavailable(check)
    raw = validation.get("spendHistory")
    if not isinstance(raw, dict):
        return unavailable(check)
    try:
        # Defaults in the wire model are convenient for unavailable responses,
        # but saved provenance must explicitly supply every invariant.
        require(raw["version"] == VERSION)
        require(raw["basis"] == "unblended")
        require(raw["population"] == "selected_primary_files")
        require(raw["rounding"] == "balanced_daily_cents")
        require(raw["delivery_completeness"] == "unverified")
        value = DashboardSpendHistory.model_validate({**raw, "check_id": check.id})
        start, end = check.window_start, check.window_end
        require(start and end and end >= start)
        days = (end - start).days + 1
        require(value.window.start == start and value.window.end == end)
        require(value.window.days == days)
        if value.status == "unavailable":
            require(value.total_cents is None and not value.daily and value.currency is None)
            require(value.baseline.status == "unavailable" and value.baseline.daily_average_cents is None)
            require(value.reasons)
            # Unavailable money cannot vouch for accompanying coverage facts.
            # Derive the requested period from the Check and withhold unknown
            # counts, reference history and formats rather than echoing an
            # unverified snapshot's plausible-looking metadata.
            require(all(item.code in {
                "series_too_long", "no_window_rows", "daily_amount_out_of_range",
                "series_measurement_unavailable",
            } and item.message.strip() and item.recovery.strip() for item in value.reasons))
            safe = unavailable(check)
            safe.reasons = value.reasons
            proof = validation.get("currencyProof")
            if (value.window.observed_days == 0
                    and type(validation.get("windowRows")) is int
                    and validation["windowRows"] == 0
                    and isinstance(proof, dict)
                    and proof.get("version") == "check_currency_v1"
                    and proof.get("status") == "unavailable"
                    and proof.get("currency") is None
                    and type(proof.get("observed_rows")) is int
                    and proof["observed_rows"] == 0
                    and proof.get("period") == period(start, end)):
                safe.window.observed_days = 0
            return safe
        require(days <= MAX_DAYS and value.currency == "USD")
        require(len(value.daily) == days)
        require(value.total_cents == window_total(validation, check))
        require(value.total_cents is not None)
        observed = 0
        row_count = 0
        total = 0
        for offset, point in enumerate(value.daily):
            require(point.date == start + timedelta(days=offset))
            if point.observed_rows:
                require(point.amount_cents is not None)
                total += point.amount_cents
                observed += 1
                row_count += point.observed_rows
            else:
                require(point.amount_cents is None)
        require(observed > 0 and observed == value.window.observed_days)
        require(row_count == validation["windowRows"])
        require(type(validation["windowRows"]) is int)
        require(total == value.total_cents)
        require(value.status == ("available" if observed == days else "partial"))
        require(value.reconciliation_status == validation.get("reconciliationStatus"))
        require(bool(value.source_formats) and set(value.source_formats) <= {
            "CUR-style slash headers", "Athena/Data Exports underscore headers",
            "Unknown header convention",
        })
        baseline = value.baseline
        require(baseline.start and baseline.end and baseline.end >= baseline.start)
        require(baseline.end < start)
        require(baseline.days == (baseline.end - baseline.start).days + 1)
        require(baseline.observed_days is not None and 0 <= baseline.observed_days <= baseline.days)
        require(baseline.source in {"selected_baseline_files", "in_file_history"})
        if baseline.status == "available":
            require(baseline.days >= MIN_HISTORY_DAYS)
            require(baseline.observed_days == baseline.days)
            require(type(raw["baseline_observed_rows"]) is int and raw["baseline_observed_rows"] >= baseline.days)
            proof = raw["baseline_currency_proof"]
            require(isinstance(proof, dict) and proof.get("status") == "verified"
                    and proof.get("currency") == "USD"
                    and type(proof.get("observed_rows")) is int
                    and proof["observed_rows"] == raw["baseline_observed_rows"])
            # Exact scalar is private to persistence. Never accept NaN/Infinity
            # or a source scalar too large for the established decimal budget.
            exact = Decimal(raw["baseline_exact_total_cents"])
            require(exact.is_finite() and abs(exact) < Decimal("1e28"))
            require(baseline.daily_average_cents == cents(exact / Decimal(baseline.days)))
            guard = comparison_guard(
                DataWindow(start, end, baseline.start, baseline.end),
                file_baseline=baseline.source == "selected_baseline_files",
            )
            require(not guard.refusals)
        else:
            require(baseline.daily_average_cents is None)
        return value
    except (ValidationError, KeyError, TypeError, ValueError, InvalidOperation, OverflowError):
        return unavailable(check, "snapshot_invalid", "The saved daily snapshot does not establish consistent source-observed amounts.")
