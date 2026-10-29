"""Bounded, lossless canonical facts for future commitment history proofs.

No source path/hash claims refresh authority. Exceeding the bound withholds
history; it never stores a truncated population as a complete observation.
"""

import json

from app.pipeline.savings_plans import timestamp, usage_timestamp

VERSION = "commitment_history_facts_v1"
MAX_RECORDS = 20000
MAX_BYTES = 4 * 1024 * 1024


def capture(rows, lower, upper):
    records = []
    size = 0
    for row in rows:
        a = usage_timestamp(row.get("lineItem/UsageStartDate"))
        b = usage_timestamp(row.get("lineItem/UsageEndDate"))
        if a is None or b is None or not a < b or b <= lower or a >= upper:
            continue
        raw = row.get("_commitops_payload")
        if not isinstance(raw, str) or row.get("_commitops_role") != "primary":
            return {
                "version": VERSION,
                "status": "unavailable",
                "reason": "Canonical source facts are unavailable.",
            }
        records.append(raw)
        size += len(raw.encode("utf-8"))
        if len(records) > MAX_RECORDS or size > MAX_BYTES:
            return {
                "version": VERSION,
                "status": "unavailable",
                "reason": "The complete fact population exceeds the bounded history proof limit.",
            }
    return {"version": VERSION, "status": "complete", "records": sorted(records)}


def scalar(encoded):
    if encoded == ["null"]:
        return None
    if isinstance(encoded, list) and len(encoded) == 2:
        if encoded[0] in {"decimal", "instant"} and isinstance(encoded[1], str):
            return encoded[1]
        nested = encoded[1]
        if (
            isinstance(nested, list)
            and len(nested) == 2
            and nested[0] in {"string", "number", "boolean"}
        ):
            return nested[1]
    # Extensions remain in the equality payload even if no formula reads them.
    return None


def decode(raw):
    fields = json.loads(raw)
    if not isinstance(fields, dict):
        raise ValueError("Expected a complete canonical payload")
    row = {key: scalar(value) for key, value in fields.items()}
    identifier = str(row.get("identity/LineItemId") or "").strip()
    ba = timestamp(row.get("bill/BillingPeriodStartDate"))
    bb = timestamp(row.get("bill/BillingPeriodEndDate"))
    payer = str(row.get("bill/PayerAccountId") or "").strip()
    if not identifier or ba is None or bb is None or not ba < bb or not payer:
        raise ValueError(
            "History equivalence requires usable partition-scoped identities and payer"
        )
    return row, (identifier, ba, bb, payer)
