"""Bounded source-observed dashboard facts, independent of detector money.

Dates without observations stay unknown. A row on every day establishes only
source-observed days, never export completeness, invoice reconciliation or a
complete account inventory. The historical mean is not a detector threshold.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

import duckdb

from app.pipeline import comparison, currency, ingest
from app.pipeline.money import cents, precise
from app.pipeline.savings_plans import apportion

VERSION = "daily_spend_v1"
MAX_DAYS = 3660
CAVEATS = [
    "Observed days describe selected billing rows, not delivery completeness or account-wide inventory.",
    "Daily cents use deterministic balanced rounding so their sum equals the selected-source window total; a day's rounded value can differ by one cent from independent rounding.",
    "The historical daily mean is a descriptive reference, not a detector's p95 threshold or a forecast.",
]
log = logging.getLogger(__name__)


def reason(code, message, recovery):
    return {"code": code, "message": message, "recovery": recovery}


def empty(window, *, source_formats=(), file_baseline=False, reconciliation_status="unavailable"):
    return {
        "version": VERSION,
        "status": "unavailable",
        "currency": None,
        "basis": "unblended",
        "population": "selected_primary_files",
        "window": {"start": window.start.isoformat(), "end": window.end.isoformat(),
                   "days": window.check_days, "observed_days": None},
        "daily": [],
        "baseline": {"status": "unavailable", "daily_average_cents": None,
                     "start": window.baseline_start.isoformat(),
                     "end": window.baseline_end.isoformat(), "days": window.baseline_days,
                     "observed_days": None,
                     "source": "selected_baseline_files" if file_baseline else "in_file_history"},
        "source_formats": list(source_formats),
        "total_cents": None,
        "reconciliation_status": reconciliation_status,
        "delivery_completeness": "unverified",
        "rounding": "balanced_daily_cents",
        "reasons": [],
        "caveats": list(CAVEATS),
    }


@precise
def capture(con, window, *, primary_where, baseline_where, source_formats=(),
            file_baseline=False, baseline_unavailable=False, reconciliation_status="unavailable"):
    """Read the existing canonical relation, retaining exact signed cents.

    A resource failure in this optional visualization must not prevent the
    established analysis from continuing or fabricate a partially read chart.
    """
    result = empty(window, source_formats=source_formats, file_baseline=file_baseline,
                   reconciliation_status=reconciliation_status)
    try:
        return _capture(con, window, result, primary_where=primary_where,
                        baseline_where=baseline_where, file_baseline=file_baseline,
                        baseline_unavailable=baseline_unavailable)
    except duckdb.Error:
        log.exception("Optional daily dashboard snapshot could not be measured")
        result = empty(window, source_formats=source_formats, file_baseline=file_baseline,
                       reconciliation_status=reconciliation_status)
        result["reasons"].append(reason("series_measurement_unavailable", "Daily source observations could not be measured for this check.", "Run a new check with a smaller complete export or ask the operator to review analysis resources. Other saved check results remain available."))
        return result


def _capture(con, window, result, *, primary_where, baseline_where, file_baseline, baseline_unavailable):
    if window.check_days > MAX_DAYS:
        result["reasons"].append(reason("series_too_long", "Daily history exceeds the dashboard's 3660-day display limit.", "Run a new check with a narrower window of at most 3660 days; the existing check's other results remain available."))
        return result
    rows = con.execute(
        f'SELECT CAST("lineItem/UsageStartDate" AS DATE) AS day, '
        f'SUM({ingest.COST_CENTS_SQL}), count(*) FROM {ingest.TABLE} '
        f'WHERE ({primary_where}) AND {ingest.day_predicate(window.start, window.end)} '
        "GROUP BY day ORDER BY day"
    ).fetchall()
    result["window"]["observed_days"] = len(rows)
    if not rows:
        result["reasons"].append(reason("no_window_rows", "No source rows were observed in this check window.", "Select dates covered by the primary export and run a new check."))
        return result

    raw = {day.isoformat(): exact / Decimal(100) for day, exact, _ in rows}
    total = cents(sum((exact for _, exact, _ in rows), Decimal(0)))
    balanced = apportion(raw, total)
    if any(abs(value) > 2**53 - 1 for value in balanced.values()):
        result["reasons"].append(reason("daily_amount_out_of_range", "A daily amount exceeds the supported exact browser integer range.", "Use a narrower check window with supported daily amounts, then run a new check. Other check calculations are unchanged."))
        return result
    counts = {day.isoformat(): count for day, _, count in rows}
    result.update(status="available" if len(rows) == window.check_days else "partial",
                  currency="USD", total_cents=total)
    for offset in range(window.check_days):
        day = (window.start + timedelta(days=offset)).isoformat()
        result["daily"].append({"date": day, "amount_cents": balanced.get(day),
                                "observed_rows": counts.get(day, 0)})
    if len(rows) < window.check_days:
        result["reasons"].append(reason("missing_window_days", f"Billing rows were observed on {len(rows)} of {window.check_days} requested days; other dates have unknown spend.", "Include every data part from the authoritative delivery and run a new check. Missing dates are not assumed to be zero."))

    history = con.execute(
        f'SELECT count(DISTINCT CAST("lineItem/UsageStartDate" AS DATE)), '
        f'SUM({ingest.COST_CENTS_SQL}), count(*) FROM {ingest.TABLE} '
        f'WHERE ({baseline_where}) AND '
        f'{ingest.day_predicate(window.baseline_start, window.baseline_end)}'
    ).fetchone()
    days, exact, observed_rows = history
    result["baseline"]["observed_days"] = days
    guard = comparison.comparison_guard(window, file_baseline=file_baseline)
    if (not baseline_unavailable and not guard.refusals
            and days == window.baseline_days and days >= comparison.MIN_HISTORY_DAYS
            and abs(cents(exact / Decimal(days))) <= 2**53 - 1):
        result["baseline"].update(status="available", daily_average_cents=cents(exact / Decimal(days)))
        # Private saved proof: the API validates the rounded mean without
        # exposing fractional-cent money or reconstructing from today's files.
        result["baseline_exact_total_cents"] = str(exact)
        result["baseline_observed_rows"] = observed_rows
        result["baseline_currency_proof"] = currency.validate(
            con, f"({baseline_where}) AND {ingest.day_predicate(window.baseline_start, window.baseline_end)}"
        )
    else:
        result["reasons"].append(reason("baseline_unavailable", f"A comparable fully observed historical daily mean is unavailable ({days} observed days in {window.baseline_days} requested days).", f"Supply at least {comparison.MIN_HISTORY_DAYS} days of earlier history with observations on every comparison date, in a non-overlapping comparable period, then run a new check."))
    return result
