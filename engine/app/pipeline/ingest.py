"""Step 1 - get the customer's CUR 2.0 data in.

One uniform read path for every delivery mechanism, so the rest of the pipeline
never learns whether the data arrived as a CSV, a gzipped CSV, a Parquet file, or
a remote object. DuckDB does the reading because it handles all four with a
single SQL call and pushes the IO/filtering down instead of materialising the
whole file in Python memory.

The caller gets back a DuckDB table plus the column set that was actually
present, which is what :mod:`app.pipeline.validate` needs in order to tell
"this file has no savings plan data" apart from "this customer has no savings
plans".
"""

from __future__ import annotations

import csv
import gzip
import logging
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import duckdb

from app.core.analysis_storage import AnalysisStorageError
from app.pipeline.money import cents, precise
from app.pipeline.types import (
    REQUIRED_COLUMNS,
    canonical_column,
    tag_columns,
)

log = logging.getLogger(__name__)

#: Name of the DuckDB table every downstream step reads from.
TABLE = "cur"

#: Full-payload fingerprint for diagnostics. Canonical observation identity,
#: source occurrence and structural equality decide copies before analysis.
HASH_COLUMN = "_commitops_row_hash"

#: The source-role column (Features 3/4): when a check carries baseline FILES
#: alongside its window files, every row is stamped 'primary' or 'baseline' at
#: load time, BEFORE the two sides are unioned. Stamping only the primary side
#: and defaulting the rest via COALESCE was tried in an earlier implementation
#: and produced two same-named columns where DuckDB kept the bare ``*`` copy -
#: every primary row came out NULL, the role filter matched nothing, and the
#: check ran with a window that had no data at all.
ROLE_COLUMN = "_source_role"
ROLE_PRIMARY = "primary"
ROLE_BASELINE = "baseline"

#: Exact fractional cents, after money.validate_costs establishes representability.
#: Keep these fractions through calculations; cents() rounds reporting boundaries.
COST_CENTS_SQL = (
    "(CAST(NULLIF(CAST(\"lineItem/UnblendedCost\" AS VARCHAR), '') AS DECIMAL(38,10)) * 100)"
)


def text(value: object) -> str:
    """Normalise a grouping field to a string.

    DuckDB's CSV reader turns an empty unquoted field into NULL, and a CUR export
    has many legitimately empty columns. Without this the same resource forms two
    groups depending on whether one month was blank (``''``) and the next was
    absent (``NULL``), splitting a customer's history in half.
    """
    return "" if value is None else str(value)


def day_predicate(start, end) -> str:
    """SQL predicate for an inclusive UsageStartDate range."""
    return (
        f"TRY_CAST(\"lineItem/UsageStartDate\" AS DATE) "
        f"BETWEEN DATE '{start}' AND DATE '{end}'"
    )


@dataclass
class IngestResult:
    """Outcome of a read attempt.

    ``columns`` is populated even when ``row_count`` is 0, because an empty but
    correctly-shaped CUR export is valid input and means "no charges in this
    window", not "broken file".
    """

    table: str
    row_count: int
    columns: frozenset[str]
    source: str
    #: Set when the file could not be read at all.
    error: str | None = None
    #: True when the loaded table carries :data:`ROLE_COLUMN` - i.e. this was
    #: a multi-role load with baseline files. Window-scoped readers use this
    #: (or :func:`role_filter`) rather than guessing.
    role_column: bool = False
    #: Rows stamped 'baseline'. 0 when no role column exists. A baseline that
    #: was requested but contributed nothing is the caller's fallback signal.
    baseline_rows: int = 0
    diagnostics: dict | None = None
    #: Original primary-source header conventions, not a claimed AWS export
    #: version: Athena CUR1 and Data Exports can both use underscore names.
    source_formats: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def missing_required(self) -> frozenset[str]:
        return REQUIRED_COLUMNS - self.columns

    @property
    def tag_columns(self) -> list[str]:
        return tag_columns(self.columns)


def _from_clause(source: str) -> str:
    """Build the DuckDB ``FROM`` clause for a source.

    Two details that are easy to get wrong:

    * ``all_varchar`` is a **CSV-reader** option. Passing it to ``read_parquet``
      is an error, so the option has to travel with the reader.
    * CUR delivered to S3/R2 is normally gzipped CSV, which ``read_csv_auto``
      handles transparently, so remote sources use the same reader as local ones
      and are distinguished only by their URI scheme.
    """
    lowered = source.lower()
    if lowered.endswith((".parquet", ".pq")):
        reader, options = "read_parquet", ""
    else:
        # .csv, .csv.gz, and any remote source that is not parquet.
        # all_varchar keeps CUR's text-typed costs exact; we parse them in
        # to_cents rather than letting a type guesser round them to DOUBLE.
        reader, options = "read_csv_auto", ", all_varchar=true"
    return f"{reader}('{_sql_quote(source)}'{options})"


def _is_parquet(path: str) -> bool:
    return path.lower().endswith((".parquet", ".pq"))


def _from_clause_list(paths: list[str]) -> str:
    """The FROM clause for a *list* of same-reader paths (Feature 3).

    ``union_by_name`` matters for the CSV reader: DuckDB binds a multi-file CSV
    read by position by default, and two monthly exports whose columns arrive
    in a different order would silently swap meanings row-block by row. By
    name is the only safe binding for billing data, and it costs nothing when
    the schemas already agree.

    Parquet needs no such option - its schema carries the names - and does not
    accept the CSV-only ones, so the reader keeps travelling with its options.
    """
    quoted = ", ".join(f"'{_sql_quote(p)}'" for p in paths)
    if _is_parquet(paths[0]):
        return f"read_parquet([{quoted}])"
    return f"read_csv_auto([{quoted}], all_varchar=true, union_by_name=true)"


def _install_extensions(con):
    """Offline edition: extension downloads and remote readers are disabled."""
    return None


def _rename_cur2_columns(
    con: duckdb.DuckDBPyConnection, columns: frozenset[str], table: str = TABLE
) -> int:
    """Normalize supported CUR spellings after capturing raw alias equality.

    When two spellings target one field, keep both columns: canonicalize()
    verifies their exact semantic equality and refuses conflicts before any
    money reader runs. In particular, this must never silently prefer an ARN,
    cost, region, or tag supplied under a different spelling.
    """
    existing = set(columns)
    renamed = 0
    def quote(name):
        return '"' + name.replace('"', '""') + '"'

    pairs = [(source, canonical_column(source, columns)) for source in columns]
    pairs.sort()
    for source, target in pairs:
        if source == target:
            continue
        if target in existing:
            if target == "product/Region":
                con.execute(f'UPDATE {quote(table)} SET {quote(target)} = '
                            f"COALESCE(NULLIF({quote(target)}, ''), NULLIF({quote(source)}, ''))")
            continue
        con.execute(f'ALTER TABLE {quote(table)} RENAME COLUMN {quote(source)} TO {quote(target)}')
        existing.discard(source)
        existing.add(target)
        renamed += 1
    return renamed


def _missing_columns_error(
    missing: frozenset[str], columns: frozenset[str]
) -> str:
    """Explain a rejected file in terms the person holding it can act on.

    The previous message was "missing 9 required CUR 2.0 column(s): <names>".
    That is accurate and useless: it does not say which shape of file was
    expected, so the only available response is to guess. It now names the
    nine columns, says which of the two AWS export shapes is wanted, shows the
    exact header spelling, and reports what the file actually looked like -
    because "0 of 9 matched" and "8 of 9 matched, you are missing one" call for
    completely different fixes.
    """
    # Counted, never hardcoded: a message that says "9" when the requirement
    # changed to 10 is worse than no message, because it looks authoritative.
    total = len(REQUIRED_COLUMNS)
    found = total - len(missing)
    header = ", ".join(sorted(REQUIRED_COLUMNS))
    return (
        f"This file is not an AWS Cost and Usage Report export: "
        f"{len(missing)} of the {total} required columns are missing "
        f"({found} of {total} found).\n"
        f"Missing: {', '.join(sorted(missing))}\n"
        f"Required headers: {header}\n"
        f"Both AWS export shapes are accepted - classic CUR "
        f"(e.g. 'lineItem/UnblendedCost') and CUR 2.0 / AWS Data Exports "
        f"(e.g. 'line_item_unblended_cost'). Other columns may be present and "
        f"are ignored.\n"
        f"This file's first headers: "
        f"{', '.join(sorted(columns)[:6]) if columns else '(none)'}"
    )


def ingest(
    source: str,
    *,
    con: duckdb.DuckDBPyConnection | None = None,
) -> IngestResult:
    """Load a CUR 2.0 export into DuckDB and return the table plus its schema.

    :param source: a local path to ``.csv``/``.csv.gz``/``.parquet``, or a
        ``s3://`` / ``r2://`` / ``https://`` URI.
    :param con: an existing connection to reuse. A fresh in-memory connection is
        created and closed if omitted, which is what tests and one-shot CLI runs
        want.
    """
    return ingest_many([source], con=con)


# ---------------------------------------------------------------------------
# Multi-file and multi-role loads (Features 3/4)
# ---------------------------------------------------------------------------


def role_filter(
    con: duckdb.DuckDBPyConnection,
    *,
    table: str = TABLE,
    role: str = ROLE_PRIMARY,
) -> str:
    """SQL predicate selecting one source role - or TRUE when there are none.

    Returns ``"TRUE"`` when the table carries no :data:`ROLE_COLUMN`, which is
    the single-source path every pre-Feature-3 caller takes: appending this
    predicate unconditionally is then a no-op, so no reader has to branch on
    "was this a file-baseline check?" to stay backwards compatible.

    The role value is a module constant, never caller input; it is interpolated
    as a literal only after that check.
    """
    if role not in (ROLE_PRIMARY, ROLE_BASELINE):
        raise ValueError(f"unknown source role: {role!r}")
    cols = frozenset(r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall())
    if ROLE_COLUMN not in cols:
        return "TRUE"
    return f'"{ROLE_COLUMN}" = \'{role}\''


def resolve_role_scope(con, where: str | None, *, table: str = TABLE, role: str = ROLE_PRIMARY) -> str:
    """Omitted business-reader scopes select a role; explicit SQL stays explicit."""
    return role_filter(con, table=table, role=role) if where is None else where


def _check_local(source: str) -> str | None:
    """An error string when a local source is missing or empty, else None.

    Remote sources used by trusted pipeline callers are not checked here.
    Public check submissions accept only streamed uploads or the tenant-owned
    AWS connection flow. Customer-facing errors never include worker paths.
    """
    if "://" in source or source.startswith(("\\\\", "//")):
        return "Only local files are supported"
    path = Path(source)
    if not path.exists():
        return "file not found: upload the export again and start a new check"
    if path.stat().st_size == 0:
        return "file is empty: upload a valid billing export"
    return None


def _describe(con: duckdb.DuckDBPyConnection, table: str) -> frozenset[str]:
    return frozenset(r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall())


def _original_headers(con, source):
    """Read names before DuckDB disambiguates case-only duplicates as *_1.

    A case-only duplicate could otherwise conceal a conflicting official ARN
    or amount. Reject this ambiguous export instead of picking the first value.
    Tag keys remain case-sensitive; duplicates cannot be safely represented by
    DuckDB's case-insensitive column namespace either.
    """
    if _is_parquet(source):
        schema = con.execute("SELECT name, num_children FROM parquet_schema(?)", [source]).fetchall()
        names, index = [], 1
        for _ in range(schema[0][1]):
            names.append(schema[index][0])
            pending = schema[index][1] or 0
            index += 1
            while pending:
                pending += (schema[index][1] or 0) - 1
                index += 1
        return names
    if source.lower().startswith(("s3://", "r2://", "http://", "https://")):
        # Trusted remote CSV readers cannot expose the unmodified header here.
        return None
    open_text = gzip.open if source.lower().endswith(".gz") else open
    with open_text(source, "rt", newline="", encoding="utf-8-sig") as stream:
        return next(csv.reader(stream), [])


def _fold_cur2(con: duckdb.DuckDBPyConnection, table: str) -> frozenset[str]:
    """Fold a loaded table's CUR 2.0 spellings to the classic contract.

    Returns the table's post-rename column set. A no-op for classic files.
    """
    columns = _describe(con, table)
    renamed = _rename_cur2_columns(con, columns, table)
    if renamed:
        columns = _describe(con, table)
    return columns


def ingest_many(
    sources: list[str],
    *,
    baseline_sources: list[str] | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
) -> IngestResult:
    """Load several CUR exports into ONE table (Features 3 and 4).

    ``sources`` are the window's files (an S3 sync's downloads); the optional
    ``baseline_sources`` are history files the caller chose explicitly. All of
    them land in :data:`TABLE` so every downstream step stays single-table.

    The rules, each one measured or bitten somewhere before:

    * **Deterministic order.** Paths are sorted before anything touches them,
      so two runs over the same inputs produce byte-identical findings ids.
    * **Each original source is read once.** Its schema and full payload are
      captured before alias folding and union, preserving absent fields and
      repeated observations. Repeated arguments reuse this same occurrence.
      Sources are then unioned by name and canonicalized within each role.
    * **Roles are stamped before the union** when baseline files exist. The
      earlier attempt stamped one side and COALESCEd the other, which left two
      same-named columns and a window with no rows in it.
    * **Baseline files are shape-checked individually**, after their CUR 2.0
      fold and *before* the union. A union merges column *sets*, so a
      non-CUR baseline would otherwise ride in on the checked file's columns
      and validate - a completed check with a silently empty history.
    * **No baseline files, no role column** - a multi-file window looks
      exactly like today's single-file table to every reader, and
      :func:`role_filter` answers TRUE for it.

    :raises nothing: errors are reported on :class:`IngestResult`, matching
        :func:`ingest`, so the orchestrator can turn them into one CheckFailed
        that names the file.
    """
    from app.pipeline import canonical
    owned = con is None
    con = con or duckdb.connect(":memory:")
    primary = [str(s) for s in sources]
    baseline = [str(s) for s in (baseline_sources or [])]
    label = ",".join(primary)
    try:
        if not primary:
            return IngestResult(TABLE, 0, frozenset(), label, error="no sources to analyse")
        _install_extensions(con)
        canonical.release_sources(con)
        source_tables = {}
        provider_columns = set()
        source_formats = set()
        for index, source in enumerate(sorted(set(primary + baseline))):
            problem = _check_local(source)
            if problem:
                return IngestResult(TABLE, 0, frozenset(), source, error=problem)
            headers = _original_headers(con, source)
            if headers and len({h.lower() for h in headers}) != len(headers):
                message = "The export contains duplicate headers that differ only by case or repeat the same name."
                recovery = "Export one unambiguous set of CUR columns, removing duplicate header spellings, then rerun."
                return IngestResult(TABLE, 0, frozenset(headers), source, error=message + " " + recovery,
                    diagnostics={"status": "refused", "code": "cur_header_ambiguous",
                                 "message": message, "recovery": recovery})
            side = f"_commitops_input_{index}"
            con.execute(f'CREATE OR REPLACE TABLE "{side}" AS SELECT * FROM {_from_clause(source)}')
            if source in primary:
                original = headers or _describe(con, side)
                if any(name.startswith("lineItem/") for name in original):
                    source_formats.add("CUR-style slash headers")
                elif any(name.startswith("line_item_") for name in original):
                    source_formats.add("Athena/Data Exports underscore headers")
                else:
                    source_formats.add("Unknown header convention")
            canonical.prepare_source(con, side, transport="columns")
            columns = _fold_cur2(con, side)
            columns = frozenset(c for c in columns if not c.startswith("_commitops"))
            missing = REQUIRED_COLUMNS-columns
            if missing:
                return IngestResult(TABLE, 0, columns, source, error=_missing_columns_error(missing, columns))
            provider_columns.update(columns)
            source_tables[source] = (side, index, con.execute(f'SELECT count(*) FROM "{side}"').fetchone()[0])
        parts = []
        offset = 0
        for role, paths in ((ROLE_PRIMARY, primary), (ROLE_BASELINE, baseline)):
            occurrences = {}
            for source in sorted(paths):
                side, index, count = source_tables[source]
                occurrence = occurrences.get(source, 0)
                occurrences[source] = occurrence+1
                # The same argument reuses the same read, preserving original
                # multiplicity. Different paths never acquire this proof.
                role_column = f", '{role}' AS {ROLE_COLUMN}" if baseline else ""
                parts.append(f'SELECT *, {index} AS _commitops_source, {occurrence} AS _commitops_occurrence, '
                             f"'{role}' AS _commitops_role{role_column}, "
                             f"_commitops_source_row + {offset} AS {canonical.ROW} FROM \"{side}\"")
                # Every emitted occurrence gets a disjoint range. A view-time
                # ROW_NUMBER would be unstable across parallel query plans.
                offset += count
        raw_count = offset
        try:
            stats = canonical.canonicalize(con, raw_query=" UNION ALL BY NAME ".join(parts))
        except canonical.CanonicalConflict as exc:
            return IngestResult(TABLE, raw_count, frozenset(provider_columns), label,
                                error=str(exc), diagnostics=exc.diagnostics, role_column=bool(baseline))
        return IngestResult(TABLE, stats["canonicalRows"], frozenset(provider_columns), label,
                            role_column=bool(baseline), baseline_rows=stats["roles"]["baseline"]["canonicalRows"],
                            diagnostics=stats, source_formats=tuple(sorted(source_formats)))
    except duckdb.OutOfMemoryException:
        log.exception("processing resources exhausted while reading billing input")
        return IngestResult(
            TABLE, 0, frozenset(), label,
            error="Your device could not complete this analysis with its available memory.",
            diagnostics={'code': 'device_memory', 'message': 'Insufficient available device memory', 'recovery': 'Close other applications or use a device with more available memory, then retry.'},
        )
    except (canonical.PayloadStagingError, AnalysisStorageError):
        log.exception("temporary processing storage unavailable while reading billing input")
        return IngestResult(
            TABLE, 0, frozenset(), label,
            error="Your device could not use the required temporary processing storage. Check free disk and permissions, or choose another working drive.",
            diagnostics={'code': 'device_storage', 'message': 'Device working storage unavailable', 'recovery': 'Free disk space or select another working drive, then retry.'},
        )
    except (duckdb.Error, ValueError, OSError, csv.Error):
        log.exception("failed to read billing input")
        return IngestResult(
            TABLE, 0, frozenset(), label,
            error="read failed: upload a valid CSV, CSV.gz or Parquet export and retry",
        )
    finally:
        if owned:
            con.close()


def _sql_quote(value: str) -> str:
    """Escape a value for safe interpolation into a DuckDB string literal.

    Source URIs are customer-supplied. Rejecting the quote character outright is
    simpler and safer than trying to escape it correctly, and no legitimate
    local path or S3 key contains one.
    """
    if "'" in value:
        raise ValueError("source may not contain a single quote")
    return value


@precise
def cost_sum_cents(con: duckdb.DuckDBPyConnection, where: str = "TRUE") -> int:
    """Sum raw ``lineItem/UnblendedCost``, then report integer cents once.

    This is the single place money is aggregated, so the exactness guarantee
    holds everywhere: no intermediate float ever touches a cost.
    """
    row = con.execute(
        f"SELECT COALESCE(SUM({COST_CENTS_SQL}), 0) FROM {TABLE} WHERE {where}"
    ).fetchone()
    return cents(row[0] or 0)


def usage_amount_sum(con: duckdb.DuckDBPyConnection, where: str = "TRUE") -> Decimal:
    """Sum ``lineItem/UsageAmount`` for the usage-to-cost detector."""
    row = con.execute(
        f"SELECT COALESCE(SUM(CAST(NULLIF(CAST(\"lineItem/UsageAmount\" AS VARCHAR), '') AS DECIMAL(38,10))), 0) "
        f"FROM {TABLE} WHERE {where}"
    ).fetchone()
    return Decimal(str(row[0] or 0))
