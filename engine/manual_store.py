"""Local workflow annotations are separate from immutable financial results."""
import json

STATUSES = {'open', 'investigating', 'resolved'}


def initialise(con):
    con.executescript('''
    CREATE TABLE IF NOT EXISTS finding_updates (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      finding_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,finding_id));
    CREATE TABLE IF NOT EXISTS run_flags (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      archived INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS local_runs_period ON runs(created DESC,id DESC);
    ''')


def updates(con, run_id):
    return {row[0]: {'status': row[1], 'note': row[2], 'archived': bool(row[3])}
            for row in con.execute('SELECT finding_id,status,note,archived FROM finding_updates WHERE run_id=?', (run_id,))}


def update_finding(con, value):
    run_id, finding_id = value.get('run_id'), value.get('finding_id')
    status, note, archived = value.get('status'), value.get('note', ''), value.get('archived', False)
    if status not in STATUSES or not isinstance(note, str) or len(note) > 4096 or type(archived) is not bool:
        raise ValueError('Invalid finding status, note or archive state')
    row = con.execute("SELECT result FROM runs WHERE id=? AND status='completed'", (run_id,)).fetchone()
    if not row or not any(item.get('id') == finding_id for item in json.loads(row[0] or '{}').get('findings', [])):
        raise ValueError('Finding unavailable')
    con.execute('INSERT INTO finding_updates VALUES (?,?,?,?,?) ON CONFLICT(run_id,finding_id) DO UPDATE SET status=excluded.status,note=excluded.note,archived=excluded.archived',
                (run_id, finding_id, status, note, int(archived)))


def history(con, before=None, limit=50):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('Invalid history page size')
    params, where = [], ''
    if before:
        anchor = con.execute('SELECT created,id FROM runs WHERE id=?', (before,)).fetchone()
        if not anchor:
            raise ValueError('History cursor unavailable')
        where = 'WHERE (r.created,r.id)<(?,?)'
        params.extend(anchor)
    rows = con.execute('SELECT r.id,r.status,r.created,COALESCE(f.archived,0) FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id '+where+' ORDER BY r.created DESC,r.id DESC LIMIT ?', (*params, limit+1)).fetchall()
    return {'runs': [{'id': r[0], 'status': r[1], 'created': r[2], 'archived': bool(r[3])} for r in rows[:limit]],
            'next_cursor': rows[limit-1][0] if len(rows) > limit else None}
