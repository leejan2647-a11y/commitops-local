"""Immutable monetary provenance shared by every customer projection."""

import re
from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal

from app.pipeline.finding_amounts import CONVENTION, VERSION, period, unavailable
from app.pipeline.money import cents

BASES = {
    "window_excess",
    "spike_run_excess",
    "daily_trend_change",
    "final_day_trend_residual",
    "window_counterfactual_excess",
    "window_charge",
    "expectation_variance",
    "unused_commitment",
}


def capture(finding, check_id, finding_id, window):
    return {
        "version": VERSION,
        "check_id": str(check_id),
        "finding_id": str(finding_id),
        "window_start": window.start.isoformat(),
        "window_end": window.end.isoformat(),
        "reference_period": period(window.baseline_start, window.baseline_end),
        "record": deepcopy(finding.amount_measurement or unavailable()),
    }


def valid_period(value):
    if not isinstance(value, dict) or value.get("convention") != CONVENTION:
        return False
    try:
        start, end = (
            datetime.fromisoformat(value[k].replace("Z", "+00:00")) for k in ("start", "end")
        )
        return (
            start.tzinfo is not None
            and end.tzinfo is not None
            and start.utcoffset() == timedelta(0)
            and end.utcoffset() == timedelta(0)
            and start < end
        )
    except (TypeError, ValueError, KeyError, AttributeError):
        return False


def project(validation, finding, check):
    try:
        envelope = validation["findingAmounts"][str(finding.id)]
        if (
            envelope["version"] != VERSION
            or envelope["check_id"] != str(finding.check_id)
            or envelope["finding_id"] != str(finding.id)
            or str(check.id) != str(finding.check_id)
        ):
            return unavailable()
        if (
            envelope["window_start"] != check.window_start.isoformat()
            or envelope["window_end"] != check.window_end.isoformat()
        ):
            return unavailable()
        value = envelope["record"]
        if window_total(validation, check) is None:
            return unavailable()
        if value.get("status") == "unavailable":
            return unavailable(
                value.get("reason") if isinstance(value.get("reason"), str) else None
            )
        if (
            value["version"] != VERSION
            or value["status"] != "available"
            or value["basis"] not in BASES
            or value["currency"] != "USD"
            or value["cost_basis"] not in {"unblended", "gross_amortized"}
        ):
            return unavailable()
        if (
            type(value["value_cents"]) is not int
            or value["value_cents"] != finding.impact_cents
            or value["value_cents"] < 0
            or not valid_period(value["period"])
            or value["additivity"] != "non_additive"
        ):
            return unavailable()
        if (
            value["population"]
            not in {"selected_primary_files", "selected_primary_and_reference_files"}
            or not isinstance(value["named_quantities"], dict)
            or not all(
                isinstance(k, str) and type(v) is int for k, v in value["named_quantities"].items()
            )
        ):
            return unavailable()
        check_period = period(check.window_start, check.window_end)
        measured = value["period"]
        basis = value["basis"]
        if basis == "spike_run_excess":
            if (
                not check_period["start"]
                <= measured["start"]
                < measured["end"]
                <= check_period["end"]
            ):
                return unavailable()
        elif basis == "daily_trend_change":
            if measured != period(check.window_end - timedelta(days=55), check.window_end):
                return unavailable()
        elif basis == "final_day_trend_residual":
            if measured != period(check.window_end, check.window_end):
                return unavailable()
        elif measured != check_period:
            return unavailable()
        ref = value["reference"]
        if ref is not None and (
            not isinstance(ref, dict)
            or not isinstance(ref.get("type"), str)
            or type(ref.get("value_cents")) is not int
            or not valid_period(ref.get("period"))
            or ref.get("unit") not in {"daily_cents", "window_cents"}
        ):
            return unavailable()
        if ref is not None:
            if basis in {
                "window_excess",
                "spike_run_excess",
                "window_counterfactual_excess",
                "window_charge",
            }:
                if ref["period"] != envelope["reference_period"] or not valid_period(
                    envelope["reference_period"]
                ):
                    return unavailable()
            elif (
                basis in {"expectation_variance", "unused_commitment", "final_day_trend_residual"}
                and ref["period"] != measured
            ):
                return unavailable()
            elif basis == "daily_trend_change" and ref["period"] != period(
                check.window_end - timedelta(days=55), check.window_end - timedelta(days=55)
            ):
                return unavailable()
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, AttributeError):
        return unavailable()


def fields(validation, finding, check):
    value = project(validation, finding, check)
    known = value["status"] == "available"
    return {
        "amount_measurement": value,
        "impact_cents": value["value_cents"],
        "evidence_total_cents": finding.evidence_total_cents if known else None,
        **text(finding, value),
    }


def text(finding, value):
    if value["status"] == "available":
        # Older single-day spike narratives claimed recovery unconditionally.
        # Their saved monetary provenance does not establish the following
        # day's observation. Correct that exact legacy phrase on read without
        # rewriting history or discarding the current observed-day wording.
        description = finding.description.replace(
            "The following day returned to normal.",
            "The following day's cost is not established by this finding.",
        )
        description = description.replace(
            "No single day is anomalous, which is why a point-anomaly detector would not have flagged it.",
            "This trend can overlap with spike findings; their amounts measure different periods and must not be added.",
        )
        return {
            "title": finding.title,
            # The saved narrative contains exact intermediate decimals. Apply
            # the same declared integer-cent boundary as its metadata display.
            "description": re.sub(
                r"(?<![\w.])([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?) cents\b",
                lambda match: f"{cents(Decimal(match[1]))} cents",
                description,
            ),
            "caveats": list(finding.caveats),
        }
    return {
        "title": "Observation needs a verified monetary measurement",
        "description": f"{value['reason']} {value['recovery']}",
        "caveats": [value["reason"], value["recovery"]],
    }


def window_total(validation, check):
    """A saved number alone is not evidence of the currency or its population."""
    try:
        proof = validation["currencyProof"]
        total = validation["windowTotalCents"]
        if (
            proof["version"] != "check_currency_v1"
            or proof["status"] != "verified"
            or proof["currency"] != "USD"
            or type(proof["observed_rows"]) is not int
            or proof["observed_rows"] <= 0
            or type(validation.get("windowRows")) is not int
            or proof["observed_rows"] != validation["windowRows"]
            or type(total) is not int
        ):
            return None
        start = f"{check.window_start.isoformat()}T00:00:00Z"
        end = f"{(check.window_end + timedelta(days=1)).isoformat()}T00:00:00Z"
        if proof["period"] != {"start": start, "end": end, "convention": CONVENTION}:
            return None
        return total
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
