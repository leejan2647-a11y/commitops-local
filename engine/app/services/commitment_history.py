"""Verified equivalent or disjoint commitment observations; ambiguous is null."""

import json
from collections import defaultdict
from decimal import Decimal

from app.pipeline import reserved_instances as ri
from app.pipeline import savings_plans as sp
from app.pipeline.history_facts import MAX_BYTES, MAX_RECORDS, VERSION, decode
from app.pipeline.money import precise

REASON = {
    "code": "commitment_history_overlap_unresolved",
    "message": "History lacks a bounded proof of equivalent or disjoint canonical commitment observations.",
    "recovery": "Select one check, or rerun complete compatible windows from one authoritative delivery; overlapping revisions are not selected by their date or amount.",
}
LIMIT = {
    "code": "commitment_history_proof_limit_exceeded",
    "message": "The complete history exceeds the bounded verification workload; no partial history total is asserted.",
    "recovery": "Select one check or a smaller complete history population.",
}
MAX_OBSERVATIONS = 128
MAX_TOTAL_RECORDS = 40000
MAX_TOTAL_BYTES = 8 * 1024 * 1024


def intervals(m):
    if m["family"] == "savings-plan":
        return [
            (sp.timestamp(p["start"]), sp.timestamp(p["end"])) for p in m["coverage"]["intervals"]
        ]
    return [(sp.timestamp(p["start"]), sp.timestamp(p["end"])) for p in m["period_observations"]]


def verify(m):
    manifest = m.get("history_facts")
    if (
        not isinstance(manifest, dict)
        or manifest.get("version") != VERSION
        or manifest.get("status") != "complete"
    ):
        raise ValueError("No complete canonical facts")
    raw = manifest.get("records")
    if (
        not isinstance(raw, list)
        or not raw
        or len(raw) > MAX_RECORDS
        or not all(isinstance(r, str) for r in raw)
        or sum(len(r.encode("utf-8")) for r in raw) > MAX_BYTES
        or len(set(raw)) != len(raw)
    ):
        raise ValueError("Invalid bounded fact population")
    rows = []
    identities = {}
    family = m["family"]
    field = sp.ID if family == "savings-plan" else ri.ID
    start, end = [sp.timestamp(m["window"][k]) for k in ("start", "end")]
    for payload in raw:
        row, identity = decode(payload)
        if row.get(field) != m["plan_id"] or row.get("lineItem/CurrencyCode") != "USD":
            raise ValueError("Wrong plan or currency population")
        if identity in identities and identities[identity] != payload:
            raise ValueError("Conflicting canonical observations")
        identities[identity] = payload
        for key in (ri.ID, ri.ACCOUNT, ri.PAYER, ri.CURRENCY, ri.LINE_ID):
            row[key] = str(row.get(key) or "").strip()
        rows.append(row)
    rebuilt = (sp._plan if family == "savings-plan" else ri._plan)(m["plan_id"], rows, start, end)
    if (
        rebuilt is None
        or rebuilt["coverage"]["status"] != "complete"
        or rebuilt.get("consistent") is not True
    ):
        raise ValueError("Raw facts do not reestablish the complete measurement")
    for key in (
        "family",
        "plan_id",
        "calculation_version",
        "purchaser",
        "payer",
        "term",
        "basis",
        "currency",
        "population",
        "window",
    ):
        if rebuilt.get(key) != m.get(key):
            raise ValueError("Fact scope disagrees with measurement")
    for key in ("purchased", "used", "unused"):
        if rebuilt["metrics"][key]["state"] != "available" or Decimal(
            rebuilt["metrics"][key]["exact"]
        ) != Decimal(m["metrics"][key]["exact"]):
            raise ValueError("Raw facts do not reproduce the exact amount")
    periods = intervals(rebuilt)
    if not periods or any(a is None or b is None or not a < b for a, b in periods):
        raise ValueError("Invalid observed intervals")
    return tuple(sorted(raw)), identities, periods, rebuilt


def merged(periods):
    result = []
    for a, b in sorted(periods):
        if result and a <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], b))
        else:
            result.append((a, b))
    return result


def coverage(periods, plan_hours):
    spans = merged(periods)
    return {
        "status": "available",
        "observed_intervals": [{"start": sp.iso(a), "end": sp.iso(b)} for a, b in spans],
        "observed_hours": sum((b - a).total_seconds() / 3600 for a, b in spans),
        "plan_hours": plan_hours,
        "envelope": {"start": sp.iso(spans[0][0]), "end": sp.iso(spans[-1][1])},
        "gaps": [
            {"start": sp.iso(a[1]), "end": sp.iso(b[0])}
            for a, b in zip(spans, spans[1:])
            if a[1] < b[0]
        ],
    }


@precise
def total(rows, checks):
    from app.services.commitment_measurements import valid_measurement

    unavailable = {
        **dict.fromkeys(("purchased", "used", "unused", "utilization_pct")),
        "exact": dict.fromkeys(("purchased", "used", "unused")),
        "reasons": [REASON],
        "history_coverage": {"status": "unavailable", "reason": REASON},
        "observations": [],
    }
    if not rows:
        return unavailable
    if len(rows) > MAX_OBSERVATIONS:
        return {
            **unavailable,
            "reasons": [LIMIT],
            "history_coverage": {"status": "unavailable", "reason": LIMIT},
        }
    try:
        grouped = defaultdict(list)
        record_count = byte_count = 0
        for row in rows:
            m = getattr(row, "measurement_json", None)
            if (
                not checks
                or row.check_id not in checks
                or not valid_measurement(m, checks[row.check_id])
            ):
                raise ValueError("Invalid persisted measurement")
            records = m.get("history_facts", {}).get("records", [])
            if not isinstance(records, list) or not all(isinstance(r, str) for r in records):
                raise ValueError("Invalid history manifest")
            record_count += len(records)
            byte_count += sum(len(r.encode("utf-8")) for r in records)
            if record_count > MAX_TOTAL_RECORDS or byte_count > MAX_TOTAL_BYTES:
                return {
                    **unavailable,
                    "reasons": [LIMIT],
                    "history_coverage": {"status": "unavailable", "reason": LIMIT},
                }
            verified = verify(m)
            grouped[(m["family"], m["plan_id"])].append((m, verified))
        totals = {k: Decimal(0) for k in ("purchased", "used", "unused")}
        all_intervals = []
        plan_hours = 0
        retained = []
        for key, observations in grouped.items():
            scope = None
            seen = set()
            prior = []
            identities = {}
            for m, (raw, facts, periods, rebuilt) in observations:
                current = json.dumps(
                    {
                        k: m.get(k)
                        for k in (
                            "calculation_version",
                            "purchaser",
                            "payer",
                            "term",
                            "basis",
                            "currency",
                            "population",
                        )
                    },
                    sort_keys=True,
                )
                if scope is not None and scope != current:
                    raise ValueError("Incompatible plan scope")
                scope = current
                signature = (raw, tuple(periods))
                if signature in seen:
                    continue
                for identity, payload in facts.items():
                    if identity in identities and identities[identity] != payload:
                        raise ValueError("Unresolved revision")
                spans = merged(periods)
                if any(a < d and c < b for a, b in spans for c, d in merged(prior)):
                    raise ValueError(
                        "Partial overlap is unsupported without a complete union proof"
                    )
                seen.add(signature)
                identities.update(facts)
                prior.extend(periods)
                retained.append(rebuilt)
                for metric in totals:
                    totals[metric] += Decimal(m["metrics"][metric]["exact"])
            plan_spans = merged(prior)
            plan_hours += sum((b - a).total_seconds() / 3600 for a, b in plan_spans)
            all_intervals.extend(prior)
        ratio = (
            float(totals["used"] / totals["purchased"] * 100) if totals["purchased"] > 0 else None
        )
        return {
            **{k: sp.cents(v) for k, v in totals.items()},
            "exact": {k: str(v) for k, v in totals.items()},
            "utilization_pct": ratio,
            "reasons": [],
            "history_coverage": coverage(all_intervals, plan_hours),
            "observations": retained,
        }
    except (KeyError, TypeError, ValueError, ArithmeticError, AttributeError):
        return unavailable
