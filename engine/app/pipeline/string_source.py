"""Bounded columnar decoding for string-only, unambiguous provider schemas.

Native typed values and colliding aliases keep the scalar reference path. Only
encoded components travel through Arrow; original provider columns stay native.
"""
import json

from duckdb import IOException, OutOfMemoryException

BATCH_ROWS = 128


def supports(encoder):
    return (all(dtype == 'VARCHAR' for _, dtype, _ in encoder.fields)
            and len({name for _, _, name in encoder.fields}) == len(encoder.fields))


def values(reader, schema, encoder):
    from pyarrow import ArrowMemoryError
    from app.pipeline.canonical import PayloadStagingError

    positions = {name: index + 1 for index, name in enumerate(schema)}
    stream = None
    try:
        stream = reader.to_arrow_reader(batch_size=BATCH_ROWS)
        for batch in stream:
            if batch.num_rows > BATCH_ROWS:
                raise RuntimeError('Source decoder exceeded its bounded batch')
            columns = {}
            for original, dtype, name in encoder.fields:
                dictionary = batch.column(positions[original]).dictionary_encode()
                raw = dictionary.dictionary.to_pylist()
                entries = [(value, *encoder.encoded(name, value, dtype)) for value in raw]
                null_index = len(entries)
                if dictionary.null_count:
                    entries.append((None, *encoder.encoded(name, None, dtype)))
                indices = [null_index if index is None else index
                           for index in dictionary.indices.to_pylist()]
                columns[name] = (indices, entries)
            # Compile a complete field once per dictionary entry, not once per
            # row. Exact scalar JSON and field ordering stay unchanged. The
            # dictionaries remain bounded by the existing 128-row batch.
            compiled = [(columns[name][0],
                         [encoder.keys[name] + ':' + entry[2] for entry in columns[name][1]])
                        for name in sorted(columns)]
            identity = columns.get('identity/LineItemId')
            identity_text = [str(entry[0] or '').strip() for entry in identity[1]] if identity else None
            payer = columns.get('bill/PayerAccountId')
            payer_json = [json.dumps(None if entry[0] is None else str(entry[0]).strip(),
                                    separators=(',', ':')) for entry in payer[1]] if payer else None
            start = columns.get('bill/BillingPeriodStartDate')
            end = columns.get('bill/BillingPeriodEndDate')
            periods = {None: 'null'}
            for index, ordinal in enumerate(batch.column(0).to_pylist()):
                payload = '{' + ','.join(fragments[indices[index]]
                                         for indices, fragments in compiled) + '}'
                period_key = (start[0][index], end[0][index]) if start and end else None
                if period_key not in periods:
                    first, last = start[1][period_key[0]][1], end[1][period_key[1]][1]
                    period = [first[1], last[1]] if first[0] == last[0] == 'instant' else None
                    if period and period[0] >= period[1]:
                        period = None
                    periods[period_key] = json.dumps(period, separators=(',', ':'))
                yield (ordinal, payload,
                       identity_text[identity[0][index]] if identity else '',
                       periods[period_key], payer_json[payer[0][index]] if payer else 'null', '[]')
    except (MemoryError, ArrowMemoryError) as exc:
        raise OutOfMemoryException('Columnar source decoding exhausted processing memory') from exc
    except (OSError, IOException) as exc:
        raise PayloadStagingError('Temporary columnar source storage failed') from exc
    finally:
        if stream is not None:
            stream.close()
