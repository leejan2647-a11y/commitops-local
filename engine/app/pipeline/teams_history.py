"""Private, immutable, source-observed Teams spending ledger.

This is independent of saved detector impacts. Each original source is read
once; only its union of authorized primary check intervals enters the existing
complete-payload canonical rules. Source payloads are captured before any
alias folding or dimension projection. No export completeness is inferred.

Balanced rounding uses date/account/service/region/resource/principal atoms.
Charge-type subrows retain provenance and partition each atom's fixed cents.
Empty IDs remain explicit empty strings; supplied resource IDs are never
replaced by labels. Names and account aliases are observations on that date.
Every reader must sum amount_cents, including subtotals and filtered totals.
"""
from __future__ import annotations

import csv
import hashlib
import os
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from app.pipeline import canonical, currency, ingest
from app.pipeline.money import MoneyInputError, validate_costs
from app.pipeline.types import REQUIRED_COLUMNS

VERSION = "teams_history_v1"
MAX_INTEGER = 2**53 - 1
ATOMIC_GRAIN = "date, account_id, service, region, resource_id, principal_arn"
GRAIN = ATOMIC_GRAIN + ", charge_type"


class LedgerInputError(ValueError):
    def __init__(self, code, message):
        self.diagnostics = {"code": code, "message": message,
                            "recovery": "Use the retained primary exports and valid completed-check date scopes, then rebuild history."}
        super().__init__(message)


def _literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def _summary():
    return {"version": VERSION, "status": "unavailable", "currency": None,
            "basis": "unblended", "total_cents": None, "observed_start": None,
            "observed_end": None, "observed_dates": [], "check_provenance": [],
            "rounding": "balanced_atomic_cents", "reasons": [],
            "population": "observed_completed_check_primary_rows",
            "delivery_completeness": "unverified"}


def _local_path(value):
    raw = str(value)
    if "://" in raw:
        raise LedgerInputError("history_source_unavailable", "History requires retained local primary exports.")
    return os.path.normcase(str(Path(raw).resolve()))


def _scopes(sources, scopes):
    available = {_local_path(path) for path in sources}
    allowed, provenance = {}, []
    for scope in scopes:
        try:
            check_id = str(scope["check_id"])
            start, end = date.fromisoformat(str(scope["start"])), date.fromisoformat(str(scope["end"]))
            if not check_id or start > end or not scope["sources"]:
                raise ValueError("invalid scope")
            selected = {_local_path(path) for path in scope["sources"]}
            if not selected <= available:
                raise ValueError("scope source is not retained")
        except (KeyError, TypeError, ValueError) as exc:
            raise LedgerInputError("history_scope_invalid", "A completed-check primary source or date interval is unavailable.") from exc
        for source in selected:
            allowed.setdefault(source, set()).add((start.isoformat(), end.isoformat()))
        provenance.append({"check_id": check_id, "start": start.isoformat(), "end": end.isoformat()})
    if not allowed:
        raise LedgerInputError("history_sources_unavailable", "No completed-check primary sources are available.")
    # Preserve every participating check, while making repeated caller scopes deterministic.
    unique = {(p["check_id"], p["start"], p["end"]) for p in provenance}
    return allowed, [dict(check_id=c, start=s, end=e) for c, s, e in sorted(unique)]


def _text(columns, name):
    return f"NULLIF(TRIM(CAST({canonical.quoted(name)} AS VARCHAR)), '')" if name in columns else "NULL"


def _first(columns, names):
    return "COALESCE(" + ", ".join([_text(columns, name) for name in names] + ["''"]) + ")"


def _json(columns, name):
    if name not in columns:
        return "NULL"
    expression = canonical.quoted(name)
    # CSV maps may be JSON text; native Parquet MAP/STRUCT retains its types.
    return f"CASE WHEN typeof({expression}) = 'VARCHAR' THEN TRY_CAST({expression} AS JSON) ELSE to_json({expression}) END"


def _labels(columns, *, account=False):
    if account:
        candidates = [_text(columns, name) for name in (
            "line_item_usage_account_name", "lineItem/UsageAccountName",
            "line_item_usage_account_alias", "lineItem/UsageAccountAlias")]
    else:
        candidates = [_text(columns, name) for name in sorted(columns)
                      if name.startswith("tags/user:") and name[len("tags/user:"):].lower() == "name"]
        for name in ("resource_tags", "tags"):
            for key in ("user:Name", "Name", "user:name", "name"):
                candidates.append(f"NULLIF(json_extract_string({_json(columns, name)}, {_literal('$.' + key)}), '')")
    return "list_sort(list_distinct(list_filter([" + ", ".join(candidates + ["NULL::VARCHAR"]) + "], x -> x IS NOT NULL)))"


def _source(con, path, index, intervals):
    problem = ingest._check_local(path)
    if problem:
        raise LedgerInputError("history_source_unavailable", "A retained completed-check primary export is missing or empty.")
    headers = ingest._original_headers(con, path)
    if headers and len({name.lower() for name in headers}) != len(headers):
        raise LedgerInputError("cur_header_ambiguous", "A primary export contains ambiguous duplicate headers.")
    table = f"_history_source_{index}"
    con.execute(f"CREATE TABLE {table} AS SELECT * FROM {ingest._from_clause(path)}")
    canonical.prepare_source(con, table)
    columns = ingest._fold_cur2(con, table)
    if REQUIRED_COLUMNS - columns:
        raise LedgerInputError("history_source_invalid", "A retained primary export lacks required CUR fields.")
    # Bad dates cannot be safely classified as inside or outside an allowed scope.
    day = 'TRY_CAST(TRY_CAST("lineItem/UsageStartDate" AS TIMESTAMPTZ) AS DATE)'
    if con.execute(f"SELECT count(*) FROM {table} WHERE {day} IS NULL").fetchone()[0]:
        raise LedgerInputError("history_date_invalid", "A primary export contains an unclassifiable usage date.")
    predicate = " OR ".join(f"({day} BETWEEN DATE '{start}' AND DATE '{end}')" for start, end in sorted(intervals))
    # Build no new observation identity. Metadata is appended after the original payload capture.
    con.execute(f"CREATE TABLE _history_selected_{index} AS SELECT *, "
                f"{index} AS _commitops_source, 0 AS _commitops_occurrence, 'primary' AS _commitops_role "
                f"FROM {table} WHERE {predicate}")
    con.execute(f"DROP TABLE {table}")
    return f"_history_selected_{index}"


def _build(con, allowed, result, target, source_checks):
    tables = [_source(con, path, i, intervals) for i, (path, intervals) in enumerate(sorted(allowed.items()))]
    con.execute("CREATE TABLE cur AS " + " UNION ALL BY NAME ".join(f"SELECT * FROM {table}" for table in tables))
    for table in tables:
        con.execute(f"DROP TABLE {table}")
    try:
        result["canonical"] = canonical.canonicalize(con)
    except canonical.CanonicalConflict as exc:
        # Associate only conflicting observations with the saved check windows
        # that authorized them. Return check IDs, never private source paths.
        observations = con.execute(f'''SELECT DISTINCT c._commitops_source,
            CAST(TRY_CAST(c."lineItem/UsageStartDate" AS TIMESTAMPTZ) AS DATE)
            FROM _commitops_candidates c JOIN _commitops_conflicts f
            USING({canonical.ROW})''').fetchall()
        indexed_sources = sorted(allowed)
        affected = set()
        for index, day in observations:
            for check_id, start, end in source_checks[indexed_sources[index]]:
                if start <= day <= end:
                    affected.add(check_id)
        exc.diagnostics["conflicting_check_ids"] = sorted(affected)
        raise
    proof = currency.validate(con, "TRUE")
    if not proof["observed_rows"]:
        raise LedgerInputError("history_no_rows", "No primary spending observations occur within the completed-check intervals.")
    validate_costs(con)
    columns = ingest._describe(con, "cur")
    service = _first(columns, ("product/ServiceCode", "lineItem/ProductCode", "product/ProductName"))
    principal = _text(columns, "line_item_iam_principal")
    # Explicit full principal ARNs only. A user_identifier is never a principal.
    principal = f"CASE WHEN regexp_full_match({principal}, 'arn:[^:]+:(iam|sts)::[0-9]{{12}}:.+') THEN {principal} ELSE '' END"
    con.execute(f"""CREATE TABLE _history_dimensions AS SELECT
        CAST(TRY_CAST("lineItem/UsageStartDate" AS TIMESTAMPTZ) AS DATE) AS date,
        {_first(columns, ('lineItem/UsageAccountId',))} AS account_id,
        {service} AS service, {_first(columns, ('product/Region',))} AS region,
        {_first(columns, ('lineItem/ResourceId',))} AS resource_id,
        {principal} AS principal_arn,
        {_first(columns, ('lineItem/LineItemType',))} AS charge_type,
        {_labels(columns)} AS names, {_labels(columns, account=True)} AS account_aliases,
        {ingest.COST_CENTS_SQL} AS exact_cents FROM cur""")
    con.execute(f"""CREATE TABLE _history_atomic AS SELECT {GRAIN}, SUM(exact_cents) AS exact_cents,
        list_sort(list_distinct(flatten(list(names)))) AS names,
        list_sort(list_distinct(flatten(list(account_aliases)))) AS account_aliases
        FROM _history_dimensions GROUP BY {GRAIN}""")
    con.execute(f"CREATE TABLE _history_resource_atoms AS SELECT {ATOMIC_GRAIN}, "
                f"SUM(exact_cents) AS exact_cents FROM _history_atomic GROUP BY {ATOMIC_GRAIN}")
    total, floors = con.execute("SELECT ROUND(SUM(exact_cents), 0), SUM(FLOOR(exact_cents)) FROM _history_resource_atoms").fetchone()
    total, remainder = int(total), int(total - floors)
    # Largest remainders work for signed costs because FLOOR is toward -infinity.
    con.execute(f"""CREATE TABLE _history_balanced AS SELECT {ATOMIC_GRAIN},
        CAST(FLOOR(exact_cents) + CASE WHEN row_number() OVER
          (ORDER BY exact_cents - FLOOR(exact_cents) DESC, {ATOMIC_GRAIN}) <= ? THEN 1 ELSE 0 END AS BIGINT) AS amount_cents
        FROM _history_resource_atoms""", [remainder])
    # Charge types must never compete with another resource/account for a cent.
    # Apportion only the already fixed parent amount among its signed subrows.
    con.execute(f"""CREATE TABLE _history_parts AS SELECT a.*,
        b.amount_cents - SUM(FLOOR(a.exact_cents)) OVER(PARTITION BY {ATOMIC_GRAIN}) AS remaining_cents,
        row_number() OVER(PARTITION BY {ATOMIC_GRAIN}
            ORDER BY a.exact_cents - FLOOR(a.exact_cents) DESC, charge_type) AS charge_rank
        FROM _history_atomic a JOIN _history_balanced b USING({ATOMIC_GRAIN})""")
    con.execute(f"""CREATE TABLE _history_ledger AS SELECT {GRAIN},
        CAST(FLOOR(exact_cents) + CASE WHEN charge_rank <= remaining_cents THEN 1 ELSE 0 END AS BIGINT) AS amount_cents,
        names, account_aliases FROM _history_parts""")
    absolute = con.execute("SELECT SUM(ABS(CAST(amount_cents AS HUGEINT))) FROM _history_ledger").fetchone()[0]
    if abs(total) > MAX_INTEGER or absolute > MAX_INTEGER:
        raise LedgerInputError("history_money_out_of_range", "History totals or grouped amounts exceed supported exact integer cents.")
    dates = [row[0].isoformat() for row in con.execute("SELECT DISTINCT date FROM _history_ledger ORDER BY date").fetchall()]
    con.execute(f"COPY (SELECT * FROM _history_ledger ORDER BY {GRAIN}) TO {_literal(target.as_posix())} (FORMAT PARQUET, COMPRESSION ZSTD)")
    result.update(status="available", currency="USD", total_cents=total,
                  observed_dates=dates, observed_start=dates[0], observed_end=dates[-1])


def build_ledger(sources, output_path, *, scopes, memory_limit="256MB", threads=1, spill_limit="1GB"):
    """Build all authorized primary observations into a new private Parquet file.

    ``sources`` may contain baseline files, but only paths explicitly listed in
    ``scopes[*].sources`` participate. Dates are inclusive. Callers provide only
    completed checks and enforce tenant ownership. This pure function has no
    database, network, detector or entitlement dependencies. An existing output
    is never modified; unavailable results never publish partial artifacts.
    """
    result = _summary()
    try:
        allowed, result["check_provenance"] = _scopes(sources, scopes)
        source_checks = {path: [] for path in allowed}
        for scope in scopes:
            for path in scope["sources"]:
                source_checks[_local_path(path)].append((str(scope["check_id"]),
                    date.fromisoformat(str(scope["start"])), date.fromisoformat(str(scope["end"]))))
        output = Path(output_path).resolve()
        if output.exists():
            raise LedgerInputError("history_artifact_exists", "History artifacts are immutable; select a new private artifact path.")
        output.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="_teams_history_", dir=output.parent) as directory:
            private = Path(directory)
            target = private / "ledger.parquet"
            config = {"memory_limit": memory_limit, "threads": threads,
                      "max_temp_directory_size": spill_limit, "temp_directory": str(private / "spill")}
            with duckdb.connect(":memory:", config=config) as con:
                con.execute("SET TimeZone='UTC'")
                _build(con, allowed, result, target, source_checks)
            # Atomic hard-link publication refuses races without replacing an artifact.
            os.chmod(target, 0o600)
            with target.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            os.link(target, output)
            result["artifact_sha256"] = digest
        return result
    except (canonical.CanonicalConflict, MoneyInputError, LedgerInputError) as exc:
        diagnostics = exc.diagnostics
        result.update(status="unavailable", currency=None, total_cents=None)
        result["reasons"] = [{key: diagnostics[key] for key in ("code", "message", "recovery") if key in diagnostics}]
        if isinstance(exc, canonical.CanonicalConflict):
            result["canonical"] = diagnostics
            result["conflicting_check_ids"] = diagnostics.get("conflicting_check_ids", [])
    except (duckdb.Error, OSError, ValueError, TypeError, csv.Error):
        # Never return source paths, raw payloads or exception strings to callers.
        result.update(status="unavailable", currency=None, total_cents=None)
        result["reasons"] = [{"code": "history_build_unavailable", "message": "Retained primary spending history could not be built within the configured processing resources.",
                              "recovery": "Retry with available retained exports or ask the operator to inspect private storage and processing resources."}]
    return result
