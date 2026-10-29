"""Capture calculation facts while exact detector inputs still exist."""

from datetime import date, timedelta
from decimal import Decimal

from app.pipeline.money import cents

VERSION = "finding_amount_v1"
CONVENTION = "start_inclusive_end_exclusive_utc"


def unavailable(reason="This finding has no validated monetary calculation provenance."):
    reason = (
        reason
        if isinstance(reason, str) and reason
        else "This finding has no validated monetary calculation provenance."
    )
    return {
        "version": VERSION,
        "status": "unavailable",
        "basis": None,
        "value_cents": None,
        "currency": None,
        "cost_basis": None,
        "population": None,
        "period": None,
        "reference": None,
        "named_quantities": {},
        "additivity": "non_additive",
        "reason": reason,
        "recovery": "Rerun this check with complete consistently declared USD observations and the required reference data.",
    }


def period(start, end):
    return {
        "start": f"{start.isoformat()}T00:00:00Z",
        "end": f"{(end + timedelta(days=1)).isoformat()}T00:00:00Z",
        "convention": CONVENTION,
    }


def from_calculation(kind, impact, normal, window, stats):
    kind = getattr(kind, "value", kind)
    if window is None:
        return unavailable()
    p = period(window.start, window.end)
    baseline = period(window.baseline_start, window.baseline_end)
    reference = None
    named = {}
    cost_basis = "unblended"
    try:
        if kind == "unexpected-charge":
            assert Decimal(stats["totalExcessCents"]) == Decimal(impact)
            basis = "window_excess"
            reference = {
                "type": "baseline_daily_p95",
                "period": baseline,
                "value_cents": cents(stats["p95Cents"]),
                "unit": "daily_cents",
            }
            named = {
                "daily_excess_cents": cents(stats["dailyExcessCents"]),
                "actual_total_cents": cents(stats["windowCents"]),
            }
        elif kind == "spike":
            assert Decimal(stats["runTotalExcessCents"]) == Decimal(impact)
            basis = "spike_run_excess"
            first = date.fromisoformat(stats["runFirstDay"])
            days = stats["runDays"]
            assert type(days) is int and days > 0
            p = period(first, first + timedelta(days=days - 1))
            reference = {
                "type": "baseline_daily_p95",
                "period": baseline,
                "value_cents": cents(stats["limitCents"]),
                "unit": "daily_cents",
            }
            named = {"peak_day_excess_cents": cents(stats["peakExcessCents"])}
        elif kind == "gradual-creep":
            basis = stats["amountBasis"]
            assert basis in {"daily_trend_change", "final_day_trend_residual"}
            first, last = [date.fromisoformat(stats[k]) for k in ("trendStart", "trendEnd")]
            if basis == "daily_trend_change":
                assert Decimal(impact) == Decimal(stats["riseCents"])
                p = period(first, last)
                reference = {
                    "type": "trend_first_day",
                    "period": period(first, first),
                    "value_cents": cents(stats["firstCents"]),
                    "unit": "daily_cents",
                }
            else:
                assert Decimal(impact) == max(
                    Decimal(stats["lastCents"]) - Decimal(stats["fittedFinalDayCents"]), 0
                )
                p = period(last, last)
                reference = {
                    "type": "fitted_final_day",
                    "period": p,
                    "value_cents": cents(stats["fittedFinalDayCents"]),
                    "unit": "daily_cents",
                }
            named = {
                "trend_endpoint_change_cents": cents(stats["riseCents"]),
                "final_day_cents": cents(stats["lastCents"]),
            }
        elif kind == "usage-cost-mismatch":
            assert Decimal(impact) == max(
                Decimal(stats["windowCents"]) - Decimal(stats["counterfactualCents"]), 0
            )
            basis = "window_counterfactual_excess"
            reference = {
                "type": "current_usage_at_previous_effective_rate",
                "period": baseline,
                "value_cents": cents(stats["counterfactualCents"]),
                "unit": "window_cents",
            }
            named = {
                "actual_total_cents": cents(stats["windowCents"]),
                "counterfactual_total_cents": cents(stats["counterfactualCents"]),
            }
        elif kind in {"new-charge", "marketplace"}:
            assert Decimal(impact) == Decimal(stats["windowCents"])
            basis = "window_charge"
            if kind == "new-charge":
                reference = {
                    "type": "observed_prior_charge",
                    "period": baseline,
                    "value_cents": cents(stats["priorCents"]),
                    "unit": "window_cents",
                }
        elif kind == "expectation-mismatch":
            if "statedCents" not in stats:
                return unavailable(
                    "The expectation has no supported numeric amount for this check window; no variance is claimed."
                )
            assert Decimal(impact) == max(
                Decimal(stats["actualCents"]) - Decimal(stats["statedCents"]), 0
            )
            basis = "expectation_variance"
            reference = {
                "type": "customer_stated_window_amount",
                "period": p,
                "value_cents": cents(stats["statedCents"]),
                "unit": "window_cents",
            }
            named = {"actual_total_cents": cents(stats["actualCents"])}
        elif kind == "unused-commitment":
            m = stats["measurement"]
            metric = m["metrics"]["unused"]
            assert (
                m["currency"] == "USD"
                and m["basis"] == "gross_amortized"
                and metric["state"] == "available"
                and metric["value_cents"] == cents(impact)
            )
            basis = "unused_commitment"
            cost_basis = "gross_amortized"
            p = {**m["window"], "convention": CONVENTION}
            reference = {
                "type": "measured_plan_obligation",
                "period": p,
                "value_cents": m["metrics"]["purchased"]["value_cents"],
                "unit": "window_cents",
            }
            named = {"used_commitment_cents": m["metrics"]["used"]["value_cents"]}
        else:
            return unavailable()
        return {
            "version": VERSION,
            "status": "available",
            "basis": basis,
            "value_cents": cents(impact),
            "currency": None,
            "cost_basis": cost_basis,
            "population": "selected_primary_and_reference_files"
            if kind == "gradual-creep"
            else "selected_primary_files",
            "period": p,
            "reference": reference,
            "named_quantities": named,
            "additivity": "non_additive",
        }
    except (AssertionError, KeyError, TypeError, ValueError, ArithmeticError):
        return unavailable()


def finalize(result, currency_proof):
    for finding in result.findings:
        m = finding.amount_measurement
        if m is None and finding.type.value == "unused-commitment":
            m = from_calculation(
                finding.type,
                finding.impact_cents,
                finding.normal_cents,
                result.window,
                finding.stats,
            )
        if (
            m is not None
            and m["status"] == "available"
            and currency_proof.get("status") == "verified"
            and currency_proof.get("observed_rows", 0) > 0
        ):
            # Called only after the orchestrator verified applicable currency.
            m = {**m, "currency": "USD"}
        elif m is not None and m["status"] == "available":
            m = unavailable("The applicable observations do not establish a supported currency.")
        finding.amount_measurement = m or unavailable()
    return result
