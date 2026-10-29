"""Within-run observation identity and complete, lossless payload equality.

The raw relation is diagnostic evidence. Only this module promotes observations
to the analytical relation; hashes never supply source or refresh authority.
"""
from __future__ import annotations

import csv
import json
from contextvars import ContextVar
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from tempfile import TemporaryDirectory
from functools import lru_cache

from duckdb import IOException

from app.pipeline.savings_plans import timestamp, usage_timestamp
from app.pipeline.types import canonical_column

RAW = "_commitops_raw"
STATS = "_commitops_canonical_stats"
ROW = "_commitops_canonical_row"
RECOVERY = "Select one authoritative export refresh with all its chunks for each affected billing period, including line-item IDs, billing-period dates and payer scope, then rerun."
MONEY = {
    "line_item_unblended_rate", "line_item_blended_rate", "line_item_net_unblended_cost",
    "lineItem/UnblendedCost", "lineItem/BlendedCost", "lineItem/NetUnblendedCost",
    "lineItem/UnblendedRate", "lineItem/BlendedRate", "lineItem/UsageAmount", "lineItem/NormalizedUsageAmount",
    "savingsPlan/TotalCommitmentToDate", "savingsPlan/UsedCommitment", "savingsPlan/SavingsPlanEffectiveCost",
    "savingsPlan/AmortizedUpfrontCommitmentForBillingPeriod", "savingsPlan/RecurringCommitmentForBillingPeriod",
    "reservation/EffectiveCost", "reservation/UnusedRecurringFee", "reservation/UnusedAmortizedUpfrontFeeForBillingPeriod",
    "reservation/AmortizedUpfrontFeeForBillingPeriod", "reservation/AmortizedUpfrontCostForUsage", "reservation/RecurringFeeForUsage",
}
UTC_FIELDS = {"lineItem/UsageStartDate", "lineItem/UsageEndDate", "bill/BillingPeriodStartDate", "bill/BillingPeriodEndDate"}
TERM_FIELDS = {"savingsPlan/StartTime", "savingsPlan/EndTime", "reservation/StartTime", "reservation/EndTime"}
PAYLOAD_STAGE_BYTES = 8 * 1024 * 1024
MAX_INLINE_DECIMAL_CHARS = 4096


class CanonicalConflict(ValueError):
    def __init__(self, diagnostics):
        self.diagnostics = diagnostics
        super().__init__(diagnostics["message"] + " " + diagnostics["recovery"])


class PayloadStagingError(OSError):
    """The temporary payload transfer could not use its processing storage."""


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def _nested(value):
    if isinstance(value, dict):
        return ["map", [[key, _nested(value[key])] for key in sorted(value)]]
    if isinstance(value, list):
        return ["array", [_nested(v) for v in value]]
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, (int, Decimal)):
        return ["number", str(value)]
    if isinstance(value, str):
        return ["string", value]
    if isinstance(value, float):
        return ["float", value.hex()]
    if isinstance(value, bytes):
        return ["bytes", value.hex()]
    return [type(value).__name__, str(value)]


def _value(name, value, dtype):
    if value is None:
        return ["null"]
    if name == "product/Region" and str(value) == "":
        # Optional region attribution can be blank on fee/global records.
        # A populated regioncode supplies this missing dimension, rather than
        # contradicting it. Two different supplied codes remain a conflict.
        return ["null"]
    if name in MONEY:
        try:
            number = Decimal(str(value))
            if number.is_finite():
                if number == 0:
                    return ['decimal', '0']
                # A tiny malformed exponent must not allocate millions of
                # padding zeroes before the financial range checks run. Keep
                # ordinary canonical bytes; represent extreme values exactly
                # using a trailing-zero-normalized coefficient and exponent.
                parts = number.as_tuple()
                digits = ''.join(str(digit) for digit in parts.digits)
                coefficient = digits.rstrip('0')
                exponent = parts.exponent + len(digits) - len(coefficient)
                split = len(coefficient) + exponent
                if exponent >= 0:
                    rendered = split
                elif split > 0:
                    rendered = len(coefficient) + 1
                else:
                    rendered = 2 - exponent
                if rendered + parts.sign > MAX_INLINE_DECIMAL_CHARS:
                    return ['decimal', ('-' if parts.sign else '') + coefficient + 'e' + str(exponent)]
                # Decimal.normalize uses the ambient precision; format without
                # rounding and trim only insignificant fractional zeroes.
                number_text = format(number, "f")
                if "." in number_text:
                    number_text = number_text.rstrip("0").rstrip(".")
                return ["decimal", "0" if number == 0 else number_text]
        except (ValueError, InvalidOperation):
            pass
    if name in UTC_FIELDS | TERM_FIELDS:
        source = value
        if name in UTC_FIELDS and dtype.startswith("TIMESTAMP"):
            try:
                source = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except ValueError:
                pass
        parsed = usage_timestamp(source) if name in UTC_FIELDS else timestamp(source)
        if parsed is not None:
            return ["instant", parsed.astimezone(timezone.utc).isoformat()]
    return [dtype, _nested(value)]


class _SourceEncoder:
    """Source-local schema plan and bounded cache of repeated scalar values.

    Short repeated strings cache both normalization and their exact JSON value.
    Native floats, nested values and long opaque values use the lossless path
    without caching. All caches are cleared when this source finishes.
    """

    def __init__(self, schema):
        self.schema = schema
        self.fields = tuple((original, dtype, canonical_column(original, schema))
                            for original, dtype in sorted(schema.items()))
        self.names = {original: name for original, _, name in self.fields}
        self.keys = {name: json.dumps(name) for original, _, name in self.fields}
        self.keys.update({original: json.dumps(original) for original, _, _ in self.fields})
        self.parsed = lru_cache(maxsize=8192)(self._encoded)

    @staticmethod
    def _encoded(name, value, dtype):
        normalized = _value(name, value, dtype)
        return normalized, json.dumps(normalized, sort_keys=True, separators=(",", ":"))

    def encoded(self, name, value, dtype):
        if isinstance(value, str) and len(value) <= 128:
            return self.parsed(name, value, dtype)
        return self._encoded(name, value, dtype)


_SOURCE_ENCODER = ContextVar("commitops_source_encoder", default=None)


def _record_components(raw, schema):
    """Encode one row without rounding, implicit omission or lossy casts."""
    values = raw
    types = schema
    encoder = _SOURCE_ENCODER.get()
    if encoder is None or encoder.schema is not schema:
        encoder = _SourceEncoder(schema)
    fields, encoded_fields, conflicts = {}, {}, []
    for original, dtype, name in encoder.fields:
        value, encoded = encoder.encoded(name, values.get(original), dtype)
        if name in fields and fields[name] != value:
            if name == "product/Region":
                if value == ["null"]:
                    continue
                if fields[name] == ["null"]:
                    fields[name] = value
                    encoded_fields[name] = encoded
                    continue
            conflicts.append(name)
            # Keep both supplied values for equality diagnosis; no precedence.
            fields[original] = value
            encoded_fields[original] = encoded
        else:
            fields[name] = value
            encoded_fields[name] = encoded
    # Find both raw identity fields in one pass. First-supplied precedence
    # (including an explicitly supplied null) must match the reference path.
    missing = object()
    raw_identifier = payer = missing
    for key, value in values.items():
        resolved = encoder.names[key] if key in encoder.names else canonical_column(key, types)
        if resolved == "identity/LineItemId" and raw_identifier is missing:
            raw_identifier = value
        elif resolved == "bill/PayerAccountId" and payer is missing:
            payer = value
        if raw_identifier is not missing and payer is not missing:
            break
    identifier = str((None if raw_identifier is missing else raw_identifier) or "").strip()
    bounds = [fields.get(k) for k in ("bill/BillingPeriodStartDate", "bill/BillingPeriodEndDate")]
    partition = [v[1] for v in bounds] if all(v and v[0] == "instant" for v in bounds) else None
    if partition and partition[0] >= partition[1]:
        partition = None
    payer = None if payer is missing else payer
    payer = str(payer).strip() if payer is not None else None
    # Match json.dumps(sort_keys=True, separators=(',', ':')) byte for byte,
    # reusing only independently encoded, immutable scalar representations.
    payload = "{" + ",".join(encoder.keys[name] + ":" + encoded_fields[name]
                              for name in sorted(encoded_fields)) + "}"
    return {"payload": payload,
                       "identity": identifier, "partition": partition, "payer": payer,
                       "aliases": sorted(set(conflicts))}


def record_json(raw, schema):
    """The original packed representation, also used by frozen controls."""
    return json.dumps(_record_components(raw, schema), separators=(",", ":"))


def _stage_payloads(con, path, records, longest_line):
    """Transfer exact payload strings through one bounded native CSV read."""
    try:
        with path.open("w", encoding="utf-8", newline="") as stream:
            csv.writer(stream, quoting=csv.QUOTE_ALL, lineterminator="\n").writerows(records)
        source = path.as_posix().replace("'", "''")
        # These lengths include UTF-8 encoding and CSV's doubled quotes. Do not
        # infer types, skip malformed rows or silently pad a partial record.
        con.execute(
            "INSERT INTO _commitops_payloads SELECT ordinal, payload FROM read_csv("
            f"'{source}', auto_detect=false, header=false, "
            "columns={'ordinal':'BIGINT','payload':'VARCHAR'}, "
            "delim=',', quote='\"', escape='\"', compression='none', "
            "parallel=false, hive_partitioning=false, strict_mode=true, "
            "ignore_errors=false, null_padding=false, "
            f"max_line_size={longest_line + 1}, "
            f"buffer_size={max(65536, 4 * (longest_line + 1))})"
        )
        path.unlink()
    except (OSError, IOException) as exc:
        raise PayloadStagingError("Temporary payload storage failed") from exc


def _stage_arrow_payloads(con, path, records, longest_line):
    """Transfer already encoded strings without a write/CSV-parse round trip."""
    import pyarrow as pa

    names = ("ordinal", "payload") if len(records[0]) == 2 else (
        "ordinal", "payload", "identity", "partition", "payer", "aliases")
    batch = pa.table({name: pa.array([row[index] for row in records],
                                   type=pa.int64() if index == 0 else pa.string())
                      for index, name in enumerate(names)})
    con.register("_commitops_payload_batch", batch)
    try:
        con.execute("INSERT INTO _commitops_payloads SELECT " + ", ".join(names) + " FROM _commitops_payload_batch")
    except (OSError, IOException) as exc:
        raise PayloadStagingError("Temporary payload transfer failed") from exc
    finally:
        con.unregister("_commitops_payload_batch")


def prepare_source(con, table, *, transport="csv"):
    if transport not in ("csv", "arrow", "columns"):
        raise ValueError("Unsupported payload transport")
    structured = transport == "columns"
    stage = _stage_arrow_payloads if transport != "csv" else _stage_payloads
    schema = {r[0]: r[1] for r in con.execute(f"DESCRIBE {quoted(table)}").fetchall()}
    if any(c.lower().startswith("_commitops") or c.lower() == "_source_role" for c in schema):
        raise ValueError("The export contains reserved application metadata columns. Remove those columns and rerun with the original provider export.")
    con.execute(f"CREATE OR REPLACE TABLE {quoted(table)} AS SELECT *, row_number() OVER () AS _commitops_source_row FROM {quoted(table)}")
    extras = ", identity VARCHAR, partition VARCHAR, payer VARCHAR, aliases VARCHAR" if structured else ""
    con.execute("CREATE OR REPLACE TEMP TABLE _commitops_payloads (ordinal BIGINT, payload VARCHAR" + extras + ")")
    metadata = ", ".join(f"CAST(NULL AS VARCHAR) AS _commitops_{name}" for name in
                          ("payload", "identity", "partition", "payer", "aliases")) if structured else "CAST(NULL AS VARCHAR) AS _commitops_record"
    con.execute(f"CREATE OR REPLACE TABLE _commitops_prepared_source AS "
                f"SELECT *, {metadata} FROM {quoted(table)} WHERE FALSE")

    def attach_batch(first, last):
        # Hash only this byte-bounded transport batch. Building a join over all
        # payload strings pins a whole export's wide values at once. Source-row
        # predicates also let stored row-group statistics prune unrelated rows.
        selected = ", ".join("p." + name for name in ("payload", "identity", "partition", "payer", "aliases")) if structured else "p.payload AS _commitops_record"
        con.execute("INSERT INTO _commitops_prepared_source SELECT source.*, " + selected + " "
                    f"FROM {quoted(table)} source JOIN _commitops_payloads p "
                    "ON source._commitops_source_row=p.ordinal "
                    "WHERE source._commitops_source_row BETWEEN ? AND ?", [first, last])
        con.execute("DELETE FROM _commitops_payloads")

    def flush(path, records, longest_line):
        stage(con, path, records, longest_line)
        attach_batch(min(row[0] for row in records), max(row[0] for row in records))
    reader = con.cursor()
    encoder = _SourceEncoder(schema)
    token = _SOURCE_ENCODER.set(encoder)

    def scalar_values():
        while batch := reader.fetchmany(512):
            for row in batch:
                if structured:
                    parts = _record_components(dict(zip(schema, row[1:])), schema)
                    yield (row[0], parts['payload'], parts['identity'],
                           *(json.dumps(parts[name], separators=(',', ':')) for name in ('partition', 'payer', 'aliases')))
                else:
                    yield row[0], record_json(dict(zip(schema, row[1:])), schema)

    try:
        reader.execute(f"SELECT _commitops_source_row, {','.join(quoted(c) for c in schema)} FROM {quoted(table)}")
        try:
            directory = Path(con.execute("SELECT current_setting('temp_directory')").fetchone()[0] or ".").resolve()
            directory.mkdir(parents=True, exist_ok=True)
            private = TemporaryDirectory(prefix="_commitops_payload_", dir=directory)
        except OSError as exc:
            raise PayloadStagingError("Temporary payload storage failed") from exc
        # Keep only one private staging file, independent of DuckDB's managed
        # spill setting. The finally block removes it on normal and error exits.
        try:
            path = Path(private.name) / "payload.csv"
            records, staged_bytes, longest_line = [], 0, 0
            from app.pipeline import string_source
            iterator = string_source.values(reader, schema, encoder) if structured and string_source.supports(encoder) else scalar_values()
            try:
                for values in iterator:
                    payload = ''.join(values[1:]) if structured else values[1]
                    # CSV transport needs doubled-quote room. The same bound
                    # conservatively limits Arrow's encoded string population.
                    size = len(str(values[0])) + len(payload.encode('utf-8')) + payload.count('"') + 6
                    if records and staged_bytes + size > PAYLOAD_STAGE_BYTES:
                        flush(path, records, longest_line)
                        records, staged_bytes, longest_line = [], 0, 0
                    if size > PAYLOAD_STAGE_BYTES:
                        con.execute('INSERT INTO _commitops_payloads VALUES (' + ','.join('?' for _ in values) + ')', list(values))
                        attach_batch(values[0], values[0])
                    else:
                        records.append(values)
                        staged_bytes += size
                        longest_line = max(longest_line, size)
                if records:
                    flush(path, records, longest_line)
            finally:
                iterator.close()
        finally:
            try:
                private.cleanup()
            except OSError as exc:
                raise PayloadStagingError("Temporary payload storage cleanup failed") from exc
    finally:
        try:
            reader.close()
        finally:
            encoder.parsed.cache_clear()
            _SOURCE_ENCODER.reset(token)
    original_count = con.execute(f"SELECT count(*) FROM {quoted(table)}").fetchone()[0]
    prepared_count = con.execute("SELECT count(*) FROM _commitops_prepared_source").fetchone()[0]
    if prepared_count != original_count:
        raise PayloadStagingError("Temporary payload transport did not retain every source row")
    # Both tables belong to this disposable analysis. After validating the
    # completed transfer, move its catalog entry instead of copying every wide
    # payload a second time. No retained source file is changed.
    con.execute(f"DROP TABLE {quoted(table)}")
    con.execute(f"ALTER TABLE _commitops_prepared_source RENAME TO {quoted(table)}")
    con.execute("DROP TABLE _commitops_payloads")
    return frozenset(schema)


def _drop_raw(con):
    view = con.execute("SELECT 1 FROM duckdb_views() WHERE view_name=? AND schema_name='main' "
                       "AND database_name=current_database()", [RAW]).fetchone()
    con.execute(f"DROP {'VIEW' if view else 'TABLE'} IF EXISTS {quoted(RAW)}")


def release_sources(con):
    """Begin a new ingestion on an owned/reused analysis connection."""
    _drop_raw(con)
    names = con.execute("SELECT table_name FROM duckdb_tables() WHERE schema_name='main' "
                        "AND database_name=current_database()").fetchall()
    for (name,) in names:
        if name.startswith('_commitops_input_') and name[len('_commitops_input_'):].isdigit():
            con.execute(f"DROP TABLE {quoted(name)}")


CLASSIFICATION_BUCKETS = 64


def _sql_path(path):
    return "'" + str(path).replace("'", "''") + "'"


def _partition_copy(con, query, path, *, wide=False):
    """Native streaming staging; restore connection tuning even on refusal."""
    settings = ("partitioned_write_max_open_files", "partitioned_write_flush_threshold")
    previous = [con.execute(f"SELECT current_setting('{name}')").fetchone()[0] for name in settings]
    try:
        # Narrow metadata can keep one small row group per bucket open. Wide
        # repeated payloads limit open writers instead. Neither changes quotas.
        con.execute(f"SET partitioned_write_max_open_files={4 if wide else CLASSIFICATION_BUCKETS}")
        con.execute(f"SET partitioned_write_flush_threshold={131072 if wide else 8192}")
        return con.execute(f"COPY ({query}) TO {_sql_path(path)} "
                    "(FORMAT PARQUET, PARTITION_BY (_commitops_bucket), ROW_GROUP_SIZE 2048)").fetchone()[0]
    finally:
        for name, value in zip(settings, previous):
            con.execute(f"SET {name}={int(value)}")


def _parquet(path):
    return f"read_parquet({_sql_path(Path(path) / '*.parquet')}, hive_partitioning=false)"


def _verify_repeated_payloads(con, metadata, payloads, scope, expected_count):
    message = "Canonical payload staging did not preserve every repeated observation exactly once"
    if not payloads.exists() or not any(payloads.glob("*.parquet")):
        if expected_count:
            raise PayloadStagingError(message)
        return
    try:
        invalid, expected_keys = con.execute(f"""
            WITH expected AS (
                SELECT m.{ROW}, count(*) AS n FROM {_parquet(metadata)} m
                JOIN _commitops_groups g USING ({scope})
                WHERE g.n>1 AND _commitops_partition!='null' GROUP BY m.{ROW}
            ), actual AS (
                SELECT {ROW}, count(*) AS n, count(_commitops_payload) AS present
                FROM {_parquet(payloads)} GROUP BY {ROW}
            )
            SELECT count(*) FILTER (WHERE e.n IS NULL OR a.n IS NULL OR e.n!=1
                                         OR a.n!=1 OR a.present!=1),
                   count(*) FILTER (WHERE e.n IS NOT NULL)
            FROM expected e FULL JOIN actual a USING ({ROW})
        """).fetchone()
    except IOException as exc:
        raise PayloadStagingError(message) from exc
    if invalid or expected_keys != expected_count:
        raise PayloadStagingError(message)


@contextmanager
def _classification_workspace(con, root):
    with TemporaryDirectory(prefix="classification-", dir=root) as working:
        try:
            yield Path(working)
        finally:
            # Keep complete RAW available for refusal evidence and subsequent
            # retries, even if a staging/query/storage failure interrupted us.
            con.execute(f"CREATE OR REPLACE TEMP VIEW _commitops_candidates AS SELECT * FROM {RAW} WHERE _commitops_occurrence=0")


def _conflict_queries(scope):
    return (
        f"SELECT c.{ROW}, 'observation_conflict' AS code FROM _commitops_candidates c JOIN _commitops_groups g USING ({scope}) WHERE _commitops_partition != 'null' AND g.variants > 1 "
        , "SELECT c."+ROW+", 'uncertain_identity' FROM _commitops_candidates c JOIN "
        "(SELECT _commitops_role, _commitops_identity FROM _commitops_candidates WHERE _commitops_identity != '' GROUP BY ALL "
        "HAVING count(*) > 1 AND bool_or(_commitops_partition = 'null')) u USING (_commitops_role, _commitops_identity) "
        , "SELECT c."+ROW+", 'uncertain_identity' FROM _commitops_candidates c JOIN "
        "(SELECT _commitops_role, _commitops_identity, _commitops_partition FROM _commitops_candidates WHERE _commitops_identity != '' GROUP BY ALL "
        "HAVING count(*) > 1 AND min(_commitops_payer)!=max(_commitops_payer) AND bool_or(_commitops_payer IN ('null', '\"\"'))) p "
        "USING (_commitops_role, _commitops_identity, _commitops_partition) "
        , "SELECT c."+ROW+f", 'uncertain_identity' FROM _commitops_candidates c JOIN _commitops_groups g USING ({scope}) "
        "WHERE g.n > 1 AND g.multiple_sources AND _commitops_payer IN ('null', '\"\"') "
        , "SELECT c."+ROW+", 'uncertain_identity' FROM _commitops_candidates c JOIN "
        "(SELECT _commitops_role, _commitops_payload FROM _commitops_candidates WHERE _commitops_identity = '' "
        "GROUP BY ALL HAVING min(_commitops_source) != max(_commitops_source)) b USING (_commitops_role, _commitops_payload) "
        , "SELECT "+ROW+", 'alias_conflict' FROM _commitops_candidates WHERE json_array_length(_commitops_aliases)>0")


def _classification_bucket_count(con, candidate_count):
    """Avoid partition setup for small, byte-bounded complete populations.

    This only chooses work placement. Exact identity/payload comparisons and
    every staging-integrity check still run. Larger or wide inputs retain the
    existing partition count; payload strings never leave DuckDB for this probe.
    """
    if candidate_count > 1024 or CLASSIFICATION_BUCKETS == 1:
        return CLASSIFICATION_BUCKETS
    size = con.execute(
        f"SELECT coalesce(sum(octet_length(encode(_commitops_payload))),0) "
        f"FROM {RAW} WHERE _commitops_occurrence=0"
    ).fetchone()[0]
    return 1 if size <= PAYLOAD_STAGE_BYTES else CLASSIFICATION_BUCKETS


def _classify_partitions(con):
    """Bound identity state without using hashes as observation identity.

    All observations for (role, ID) share a staging bucket, including different
    periods/payers. Identityless payloads route by (role, exact payload). Hash
    collisions only enlarge a bucket; every comparison below uses exact keys.
    """
    if not 1 <= CLASSIFICATION_BUCKETS <= 1024:
        raise ValueError("Invalid internal classification partition count")
    scope = "_commitops_role, _commitops_identity, _commitops_partition, _commitops_payer"
    root = Path(con.execute("SELECT current_setting('temp_directory')").fetchone()[0] or ".").resolve()
    root.mkdir(parents=True, exist_ok=True)
    con.execute(f"CREATE OR REPLACE TEMP TABLE _commitops_conflicts ({ROW} BIGINT, code VARCHAR)")
    con.execute(f"CREATE OR REPLACE TEMP TABLE _commitops_retained_ids ({ROW} BIGINT)")
    con.execute(f"CREATE OR REPLACE TEMP TABLE _commitops_repeated_ids ({ROW} BIGINT, _commitops_bucket INTEGER)")
    conflict_groups = 0
    expected_candidates = con.execute(f"SELECT count(*) FROM {RAW} WHERE _commitops_occurrence=0").fetchone()[0]
    bucket_count = _classification_bucket_count(con, expected_candidates)
    staged_candidates = 0
    expected_repeated = {}
    with _classification_workspace(con, root) as working:
        metadata = working / "metadata"
        payloads = working / "payloads"
        _partition_copy(con,
            f"SELECT {ROW}, {scope}, _commitops_source, _commitops_aliases, "
            "CASE WHEN _commitops_identity='' THEN _commitops_payload ELSE NULL END AS _commitops_payload, "
            f"hash(_commitops_role, CASE WHEN _commitops_identity!='' THEN _commitops_identity ELSE _commitops_payload END) % {bucket_count} AS _commitops_bucket "
            f"FROM {RAW} WHERE _commitops_occurrence=0", metadata)
        buckets = sorted(metadata.glob("_commitops_bucket=*"))
        # Pass one groups only narrow metadata. Persist each bucket's small
        # grouping result; unique known IDs never need another wide payload read.
        for bucket in buckets:
            number = int(bucket.name.split("=", 1)[1])
            con.execute(f"CREATE OR REPLACE TEMP VIEW _commitops_candidates AS SELECT * FROM {_parquet(bucket)}")
            staged_candidates += con.execute("SELECT count(*) FROM _commitops_candidates").fetchone()[0]
            con.execute(f"CREATE OR REPLACE TEMP TABLE _commitops_groups AS SELECT {scope}, count(*) AS n, "
                f"1 AS variants, (min(_commitops_source) != max(_commitops_source)) AS multiple_sources, min({ROW}) AS first_row "
                "FROM _commitops_candidates WHERE _commitops_identity != '' GROUP BY ALL")
            expected_repeated[number] = con.execute(f"INSERT INTO _commitops_repeated_ids SELECT c.{ROW}, {number} "
                f"FROM _commitops_candidates c JOIN _commitops_groups g USING ({scope}) "
                "WHERE g.n>1 AND _commitops_partition!='null'").fetchone()[0]
            con.execute(f"COPY _commitops_groups TO {_sql_path(working / f'groups-{number}.parquet')} "
                        "(FORMAT PARQUET, ROW_GROUP_SIZE 2048)")
        if staged_candidates != expected_candidates:
            raise PayloadStagingError("Canonical metadata staging did not retain every candidate row")
        repeated = con.execute("SELECT count(*) FROM _commitops_repeated_ids").fetchone()[0]
        if repeated:
            # One wide scan for all repeats, rather than one RAW scan per bucket.
            _partition_copy(con, f"SELECT r.{ROW}, r._commitops_payload, i._commitops_bucket "
                f"FROM {RAW} r JOIN _commitops_repeated_ids i USING ({ROW})", payloads, wide=True)
            staged_repeated = con.execute("SELECT count(*) FROM read_parquet(" +
                _sql_path(payloads / "_commitops_bucket=*" / "*.parquet") + ", hive_partitioning=false)").fetchone()[0]
            if staged_repeated != repeated:
                raise PayloadStagingError("Canonical payload staging did not retain every repeated observation")
        con.execute("DROP TABLE _commitops_repeated_ids")
        for bucket in buckets:
            number = int(bucket.name.split("=", 1)[1])
            con.execute(f"CREATE OR REPLACE TEMP TABLE _commitops_groups AS SELECT * FROM "
                        f"read_parquet({_sql_path(working / f'groups-{number}.parquet')})")
            repeated_bucket = payloads / bucket.name
            _verify_repeated_payloads(con, bucket, repeated_bucket, scope, expected_repeated[number])
            if repeated_bucket.exists():
                con.execute(f"CREATE OR REPLACE TEMP VIEW _commitops_candidates AS "
                    f"SELECT m.* EXCLUDE (_commitops_payload), coalesce(p._commitops_payload,m._commitops_payload) AS _commitops_payload "
                    f"FROM {_parquet(bucket)} m LEFT JOIN {_parquet(repeated_bucket)} p USING ({ROW})")
                con.execute("CREATE OR REPLACE TEMP TABLE _commitops_repeated_variants AS "
                    f"SELECT {scope}, CASE WHEN min(c._commitops_payload)=max(c._commitops_payload) THEN 1 ELSE 2 END AS variants "
                    f"FROM _commitops_candidates c JOIN _commitops_groups g USING ({scope}) "
                    f"WHERE g.n>1 AND _commitops_partition!='null' GROUP BY {scope}")
                con.execute("UPDATE _commitops_groups AS g SET variants=v.variants FROM _commitops_repeated_variants v WHERE "
                    + " AND ".join(f"g.{key}=v.{key}" for key in scope.split(", ")))
            else:
                con.execute(f"CREATE OR REPLACE TEMP VIEW _commitops_candidates AS SELECT * FROM {_parquet(bucket)}")
            for query in _conflict_queries(scope):
                con.execute("INSERT INTO _commitops_conflicts " + query)
            conflicts = con.execute("SELECT count(*) FROM _commitops_groups WHERE variants>1 "
                                    "AND _commitops_partition!='null'").fetchone()[0]
            conflict_groups += conflicts
            con.execute(f"INSERT INTO _commitops_retained_ids SELECT {ROW} FROM _commitops_candidates "
                "WHERE _commitops_identity='' OR _commitops_partition='null' "
                "UNION ALL SELECT first_row FROM _commitops_groups WHERE _commitops_partition!='null' AND variants=1")
            if conflicts:
                # A hot conflicting ID can have arbitrarily many different
                # payloads. Further route these by payload hash, then establish
                # equality using full payload text inside each subpartition.
                variants = working / f"variants-{number}"
                copied_variants = _partition_copy(con, f"SELECT c.{ROW}, {scope}, c._commitops_payload, "
                    f"hash(c._commitops_payload)%{CLASSIFICATION_BUCKETS} AS _commitops_bucket "
                    f"FROM _commitops_candidates c JOIN _commitops_groups g USING ({scope}) "
                    "WHERE g.variants>1 AND _commitops_partition!='null'", variants, wide=True)
                staged_variants = 0
                try:
                    for variant_bucket in sorted(variants.glob("_commitops_bucket=*")):
                        staged_variants += con.execute(f"SELECT count(*) FROM {_parquet(variant_bucket)}").fetchone()[0]
                        con.execute(f"INSERT INTO _commitops_retained_ids SELECT min({ROW}) FROM {_parquet(variant_bucket)} "
                                    f"GROUP BY {scope}, _commitops_payload")
                except IOException as exc:
                    raise PayloadStagingError("Canonical variant staging did not retain every conflicting observation") from exc
                if staged_variants != copied_variants:
                    raise PayloadStagingError("Canonical variant staging did not retain every conflicting observation")
    return conflict_groups


def canonicalize(con, *, table="cur", raw_query=None):
    # raw_query is generated only by ingest from owned table names, constant
    # roles and validated row-count offsets; it never accepts customer SQL.
    _drop_raw(con)
    columns = set() if raw_query is not None else {row[0] for row in con.execute(f"DESCRIBE {quoted(table)}").fetchall()}
    if raw_query is not None:
        supplied_columns = {row[0] for row in con.execute("DESCRIBE SELECT * FROM (" + raw_query + ") supplied").fetchall()}
        if '_commitops_record' in supplied_columns:
            # Legacy callers may still prepare packed CSV records. Keep their
            # transport/error contract while the production path supplies the
            # already separated, exact components.
            if '_commitops_payload' in supplied_columns:
                raise ValueError('Mixed payload transport representations')
            raw_query = ("SELECT * EXCLUDE (_commitops_record), "
                "json_extract_string(_commitops_record, '$.payload') AS _commitops_payload, "
                "json_extract_string(_commitops_record, '$.identity') AS _commitops_identity, "
                "json_extract(_commitops_record, '$.partition') AS _commitops_partition, "
                "json_extract(_commitops_record, '$.payer') AS _commitops_payer, "
                "json_extract(_commitops_record, '$.aliases') AS _commitops_aliases FROM (" + raw_query + ") supplied")
        con.execute(f"CREATE VIEW {RAW} AS " + raw_query)
    elif "_commitops_payload" in columns:
        con.execute(f"CREATE OR REPLACE TABLE {RAW} AS SELECT *, row_number() OVER () AS {ROW} FROM {quoted(table)}")
    else:
        con.execute(f"CREATE OR REPLACE TABLE {RAW} AS SELECT * EXCLUDE (_commitops_record), row_number() OVER () AS {ROW}, "
        "json_extract_string(_commitops_record, '$.payload') AS _commitops_payload, "
        "json_extract_string(_commitops_record, '$.identity') AS _commitops_identity, "
        "json_extract(_commitops_record, '$.partition') AS _commitops_partition, "
        "json_extract(_commitops_record, '$.payer') AS _commitops_payer, "
        f"json_extract(_commitops_record, '$.aliases') AS _commitops_aliases FROM {quoted(table)}")
    # RAW owns all source rows and exact payloads, including refused ones.
    # In the view path its prepared backing tables stay alive for raw evidence.
    con.execute(f"DROP TABLE IF EXISTS {quoted(table)}")
    groups = _classify_partitions(con)
    con.execute(f"CREATE OR REPLACE TEMP VIEW _commitops_retained AS SELECT c.* FROM _commitops_candidates c "
        f"JOIN _commitops_retained_ids i USING ({ROW})")
    roles = {}
    for role in ("primary", "baseline"):
        raw = con.execute(f"SELECT count(*) FROM {RAW} WHERE _commitops_role=?", [role]).fetchone()[0]
        retained = con.execute("SELECT count(*) FROM _commitops_retained WHERE _commitops_role=?", [role]).fetchone()[0]
        roles[role] = dict(rawRows=raw, canonicalRows=retained, removedCopyRows=raw-retained)
    conflicts = con.execute("SELECT count(DISTINCT "+ROW+") FROM _commitops_conflicts").fetchone()[0]
    stats = dict(status="refused" if conflicts else "canonical", rawRows=sum(v["rawRows"] for v in roles.values()),
                 canonicalRows=sum(v["canonicalRows"] for v in roles.values()), removedCopyRows=sum(v["removedCopyRows"] for v in roles.values()),
                 roles=roles, conflictRows=conflicts, conflictGroups=groups,
                 definition="Raw observations, retained canonical observations and proven copies removed within each input role; conflict rows are separate.")
    if conflicts:
        alias_fields = set()
        for (aliases,) in con.execute("SELECT DISTINCT _commitops_aliases FROM _commitops_candidates "
                                      "WHERE json_array_length(_commitops_aliases)>0").fetchall():
            alias_fields.update(json.loads(aliases))
        code = "cur_observation_conflict" if groups else "cur_alias_conflict" if alias_fields else "cur_identity_uncertain"
        examples = con.execute("SELECT DISTINCT _commitops_payload FROM _commitops_candidates WHERE "+ROW+" IN (SELECT "+ROW+" FROM _commitops_conflicts) LIMIT 8").fetchall()
        payloads = [json.loads(r[0]) for r in examples]
        keys = set().union(*(p.keys() for p in payloads)) if payloads else set()
        fields = sorted(alias_fields | {k for k in keys if len({json.dumps(p.get(k, ["absent"]), sort_keys=True) for p in payloads}) > 1})[:20]
        message = (f"Conflicting versions of {groups} billing observation group(s) prevent a reliable total."
                   if groups else "Equivalent CUR header spellings disagree within a billing record; a reliable total cannot be established."
                   if alias_fields else "Repeated billing observations lack sufficient source identity to establish a reliable total.")
        recovery = "Keep one authoritative set of CUR field values or correct the conflicting spellings, then rerun the original export." if alias_fields and not groups else RECOVERY
        stats.update(code=code, message=message, recovery=recovery, differingFields=fields)
    con.execute(f"CREATE OR REPLACE TEMP TABLE {STATS} AS SELECT ? AS report", [json.dumps(stats)])
    if conflicts:
        raise CanonicalConflict(stats)
    con.execute(f"CREATE OR REPLACE TABLE {quoted(table)} AS SELECT *, sha256(_commitops_payload) AS _commitops_row_hash FROM _commitops_retained")
    return stats


def statistics(con):
    try:
        return json.loads(con.execute(f"SELECT report FROM {STATS}").fetchone()[0])
    except Exception:
        return None
