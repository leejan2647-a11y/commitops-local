"""Local preferences and report snapshots. No provider or automatic workflows."""
import hashlib
import json
import re
from datetime import datetime, timezone
from uuid import uuid4
from app.pipeline.creep_policy import monthly_percent
import manual_store

DEFAULTS = {'name': 'Local workspace', 'defaultDateRange': '30', 'creepMonthlyGrowthPercent': '10'}


def initialise(con):
    con.executescript('''
    CREATE TABLE IF NOT EXISTS local_settings (id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_reports (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),name TEXT NOT NULL,created TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,document TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS local_reports_order ON local_reports(created DESC,id DESC);
    ''')


def settings(con):
    row = con.execute('SELECT document FROM local_settings WHERE id=1').fetchone()
    return validate(json.loads(row[0])) if row else dict(DEFAULTS)


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValueError('Invalid settings')
    name, days, growth = value['name'], value['defaultDateRange'], value['creepMonthlyGrowthPercent']
    if not isinstance(name, str) or not name.strip() or len(name) > 255 or any(ord(c) < 32 for c in name):
        raise ValueError('Invalid company name')
    if days not in {'7', '30', '60', '90'} or not isinstance(growth, str) or len(growth) > 128:
        raise ValueError('Invalid check defaults')
    monthly_percent(growth)
    return {'name': name.strip(), 'defaultDateRange': days, 'creepMonthlyGrowthPercent': growth.strip()}


def save_settings(con, value):
    document = validate(value)
    con.execute('INSERT INTO local_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document', (json.dumps(document),))
    return document


def save_team(con, value):
    action, account = value.get('action'), value.get('account')
    if not isinstance(account, str) or not re.fullmatch(r'\d{12}', account):
        raise ValueError('AWS account id must be exactly 12 digits')
    if action == 'delete':
        con.execute('DELETE FROM mappings WHERE account=?', (account,))
        return
    name = value.get('name')
    if action not in {'add', 'edit'} or not isinstance(name, str) or not name.strip() or len(name) > 255:
        raise ValueError('Invalid team')
    if action == 'edit':
        previous = value.get('previous_account')
        if not isinstance(previous, str) or not con.execute('SELECT 1 FROM mappings WHERE account=?', (previous,)).fetchone():
            raise ValueError('Team unavailable')
        if previous != account and con.execute('SELECT 1 FROM mappings WHERE account=?', (account,)).fetchone():
            raise ValueError('Account already mapped')
        con.execute('DELETE FROM mappings WHERE account=?', (previous,))
    if con.execute('SELECT 1 FROM mappings WHERE account=?', (account,)).fetchone():
        raise ValueError('Account already mapped')
    con.execute('INSERT INTO mappings VALUES (?,?)', (account, name.strip()))


def reports(con, before=None):
    params, where = [], ''
    if before:
        row = con.execute('SELECT created,id FROM local_reports WHERE id=?', (before,)).fetchone()
        if not row:
            raise ValueError('Invalid report cursor')
        where = 'WHERE (created,id)<(?,?)'
        params.extend(row)
    rows = con.execute('SELECT id,run_id,name,created,archived FROM local_reports '+where+' ORDER BY created DESC,id DESC LIMIT 51', params).fetchall()
    return {'reports': [dict(zip(['id', 'run_id', 'name', 'created', 'archived'], row)) for row in rows[:50]], 'next_cursor': rows[49][0] if len(rows) > 50 else None}


def report(con, identifier):
    row = con.execute('SELECT document,digest FROM local_reports WHERE id=?', (identifier,)).fetchone()
    if not row or hashlib.sha256(row[0].encode()).hexdigest() != row[1]:
        raise ValueError('Report unavailable or integrity check failed')
    document = json.loads(row[0])
    if document.get('storage_version') != 2:
        return document
    from local_hardware import memory
    sizes = [con.execute("SELECT length(result) FROM runs WHERE id=? AND status='completed'", (reference['check_id'],)).fetchone() for reference in document['checks']]
    if any(not size or not size[0] for size in sizes):
        raise ValueError('Report source unavailable. Restore the original saved check.')
    if sum(size[0] for size in sizes) > memory()[0]//4:
        raise ValueError('Your device currently has insufficient available memory to open this complete report. Free memory and retry.')
    snapshots = []
    for reference in document['checks']:
        saved = con.execute("SELECT result FROM runs WHERE id=? AND status='completed'", (reference['check_id'],)).fetchone()
        if not saved or saved[0] is None or hashlib.sha256(saved[0].encode()).hexdigest() != reference['result_sha256']:
            raise ValueError('Report source unavailable or integrity check failed. Restore the original saved check.')
        snapshots.append({'check_id': reference['check_id'], 'result': json.loads(saved[0]), 'local_review': reference['local_review']})
    return snapshots[0] if len(snapshots) == 1 else {'checks': snapshots, 'basis': document['basis']}


def update_report(con, value):
    action, identifier = value.get('action'), value.get('id')
    if action == 'create':
        name = value.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 255:
            raise ValueError('A report needs a name')
        selected = value.get('run_ids', [value.get('run_id')])
        if not isinstance(selected, list) or not selected or any(not isinstance(item, str) for item in selected) or len(set(selected)) != len(selected):
            raise ValueError('Select distinct completed checks')
        snapshots = []
        for run_id in selected:
            row = con.execute("SELECT result FROM runs WHERE id=? AND status='completed'", (run_id,)).fetchone()
            if not row or not row[0]:
                raise ValueError('A completed check is required for every selected snapshot')
            snapshots.append({'check_id': run_id, 'result_sha256': hashlib.sha256(row[0].encode()).hexdigest(), 'local_review': manual_store.updates(con, run_id)})
        payload = {'storage_version': 2, 'checks': snapshots, 'basis': 'Individual check snapshots; totals and finding impacts are not additive'}
        run_id = selected[0]
        document = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False)
        identifier = str(uuid4())
        con.execute('INSERT INTO local_reports VALUES (?,?,?,?,0,?,?)', (identifier, run_id, name.strip(), datetime.now(timezone.utc).isoformat(), document, hashlib.sha256(document.encode()).hexdigest()))
    elif action in {'rename', 'archive', 'delete'}:
        if not con.execute('SELECT 1 FROM local_reports WHERE id=?', (identifier,)).fetchone():
            raise ValueError('Report unavailable')
        if action == 'delete':
            con.execute('DELETE FROM local_reports WHERE id=?', (identifier,))
        elif action == 'archive':
            if type(value.get('archived')) is not bool:
                raise ValueError('Invalid archive state')
            con.execute('UPDATE local_reports SET archived=? WHERE id=?', (int(value['archived']), identifier))
        else:
            name = value.get('name')
            if not isinstance(name, str) or not name.strip() or len(name) > 255:
                raise ValueError('Invalid report name')
            con.execute('UPDATE local_reports SET name=? WHERE id=?', (name.strip(), identifier))
    else:
        raise ValueError('Invalid report action')
    return {'id': identifier}
