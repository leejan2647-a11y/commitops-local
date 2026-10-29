"""One retained byte store; upload records keep their own role and provenance."""
import hashlib
import json
from pathlib import Path


def retain(con, root, incoming):
    """Reuse only verified, same-format bytes; never merge primary/baseline IDs."""
    directory = (root / 'uploads').resolve()
    candidate = None
    for raw, in con.execute("SELECT data FROM uploads WHERE json_extract(data,'$.sha256')=? AND json_extract(data,'$.bytes')=?", (incoming['sha256'], incoming['bytes'])):
        saved = json.loads(raw)
        if (saved.get('sha256'), saved.get('bytes')) != (incoming['sha256'], incoming['bytes']):
            continue
        path = Path(saved['path'])
        if ''.join(path.suffixes) != ''.join(Path(incoming['path']).suffixes):
            continue
        try:
            if path.is_symlink() or path.resolve().parent != directory or path.stat().st_size != incoming['bytes']:
                continue
            with path.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != incoming['sha256']:
                    continue
        except OSError:
            continue
        candidate = candidate or saved
        if saved['name'] == incoming['name'] and saved['role'] == incoming['role']:
            merged = {**saved, 'inspection': incoming['inspection'], 'origins': sorted(set(saved.get('origins', [])) | set(incoming['origins']))}
            if incoming.get('description'):
                merged['description'] = incoming['description']
            con.execute('UPDATE uploads SET data=? WHERE id=?', (json.dumps(merged), saved['id']))
            return merged
    if candidate:
        incoming = {**incoming, 'path': candidate['path']}
    con.execute('INSERT INTO uploads VALUES (?,?)', (incoming['id'], json.dumps(incoming)))
    return incoming


def remove(con, root, identifier):
    row = con.execute('SELECT data FROM uploads WHERE id=?', (identifier,)).fetchone()
    if not row:
        raise ValueError('File unavailable')
    source = Path(json.loads(row[0])['path'])
    if source.is_symlink() or source.resolve().parent != (root / 'uploads').resolve():
        raise ValueError('Unsafe retained source')
    used = con.execute("""SELECT 1 FROM runs, json_each(runs.result, '$.input_files') AS file
        WHERE json_extract(file.value, '$.id')=? LIMIT 1""", (identifier,)).fetchone()
    if used:
        raise ValueError('This file is used by saved checks. Keep it to preserve their evidence and history.')
    con.execute('DELETE FROM uploads WHERE id=?', (identifier,))
    # Separate roles/names can share bytes. Return a path only for the last owner.
    shared = con.execute("SELECT 1 FROM uploads WHERE json_extract(data,'$.path')=? LIMIT 1", (str(source),)).fetchone()
    return None if shared else source
