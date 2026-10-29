"""Loopback-only, file-upload application. No hosted application dependencies."""
import argparse
import hashlib
import json
import multiprocessing
import os
import re
import secrets
import shutil
import socket
import sqlite3
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from uuid import uuid4
from contextlib import contextmanager

WEB = Path(__file__).resolve().parents[1] / 'web'


def deny_outbound():
    def refused(*args, **kwargs):
        raise OSError('Outbound connections are disabled in the local edition')
    socket.socket.connect = refused
    socket.socket.connect_ex = refused
    socket.create_connection = refused
    socket.getaddrinfo = refused


@contextmanager
def database(root):
    con = sqlite3.connect(root / 'local.sqlite3', timeout=5)
    try:
        con.execute('PRAGMA foreign_keys=ON')
        con.execute('PRAGMA journal_mode=WAL')
        with con:
            yield con
    finally:
        con.close()


def data_lease(root):
    """One app process owns a private data directory for its entire lifetime."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or (root / '.app-lease').is_symlink():
        raise OSError('Unsafe data directory')
    handle = (root / '.app-lease').open('a+b')
    if handle.tell() == 0:
        handle.write(b'0'); handle.flush()
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise OSError('Another local app already owns this data directory') from None
    return handle


def initialise(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise ValueError('Data directory cannot be a symbolic link')
    if os.name != 'nt':
        root.chmod(0o700)
    (root / 'uploads').mkdir(exist_ok=True, mode=0o700)
    with database(root) as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS local_upload_content ON uploads(json_extract(data,'$.sha256'),json_extract(data,'$.bytes'));
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mappings (account TEXT PRIMARY KEY, team TEXT NOT NULL);
        ''')
        con.execute("UPDATE runs SET status='interrupted',result=COALESCE(result,?) WHERE status='running'",
                    (json.dumps({'error': 'The previous analysis stopped before completion. Check available memory and disk, then retry. No complete result was saved.', 'reason': 'worker_interrupted'}),))
        import manual_store
        manual_store.initialise(con)
        import manual_settings
        manual_settings.initialise(con)
        import manual_api
        manual_api.initialise(con)
        con.execute("UPDATE local_history_reports SET document=json_set(document,'$.status','failed','$.recovery','The previous worker stopped. Rebuild history from retained files.') WHERE json_extract(document,'$.status') IN ('running','queued')")
    for part in (root / 'uploads').glob('*.part'):
        part.unlink()


def job(root, run_id, request, files, mappings):
    deny_outbound()
    try:
        from local_analysis import analyse
        result = json.dumps(analyse(request, files, mappings), ensure_ascii=True, allow_nan=False)
        status = 'completed'
    except BaseException as error:
        # Engine diagnostic text may contain a local storage path. Keep failure private.
        diagnostics = getattr(error, 'diagnostics', None) or {}
        resource_failure = type(error).__name__ in {'MemoryError', 'ArrowMemoryError', 'OutOfMemoryException', 'AnalysisStorageError'} or diagnostics.get('code') in {'device_memory', 'device_storage'} or 'no space left' in str(error).lower()
        message = ('Your device could not complete this check with its available memory or disk. Close other apps or use a drive with more free space, then retry. No complete result was saved.' if resource_failure else 'Analysis could not complete. Check CUR format, dates, input columns and available disk/memory.')
        result = json.dumps({'error': message, 'type': type(error).__name__, 'reason': 'device_resources' if resource_failure else 'analysis_failed'})
        status = 'failed'
    with database(root) as con:
        con.execute("UPDATE runs SET status=?, result=? WHERE id=? AND status='running'", (status, result, run_id))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, port, root):
        super().__init__(('127.0.0.1', port), Handler)
        self.root = root
        self.token = secrets.token_urlsafe(32)
        self.operation_lock = threading.Lock()
        self.upload_lock = threading.Lock()
        self.connections = threading.BoundedSemaphore(16)
        self.active = None
        self.history_active = None

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *args):
        pass  # URLs and local billing identifiers never enter HTTP logs.

    def respond(self, status, value, content_type='application/json'):
        body = json.dumps(value, ensure_ascii=True, allow_nan=False).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def guard(self, authenticated=True):
        port = self.server.server_port
        host = self.headers.get('Host')
        origin = self.headers.get('Origin')
        expected = f'127.0.0.1:{port}'
        if host != expected or (origin and origin != f'http://{expected}'):
            self.respond(403, {'error': 'Only the local application origin is allowed'})
            return False
        supplied = self.headers.get('X-Local-Token', '')
        if authenticated and not secrets.compare_digest(supplied, self.server.token):
            self.respond(403, {'error': 'Open the launch URL containing your local access token'})
            return False
        return True

    def body(self, limit=None, *, hardware=False):
        if limit is None:
            import local_hardware
            limit = max(65536, local_hardware.memory()[0]//100)  # Keep small cancellation/control requests usable under pressure.
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('Chunked transfer is unsupported')
        values = self.headers.get_all('Content-Length', [])
        if len(values) != 1 or not re.fullmatch(r'[0-9]+', values[0]):
            raise ValueError('A single exact content length is required')
        size = int(values[0])
        if size > limit:
            raise ValueError('Your device currently has insufficient free disk for this file' if hardware else 'Your device has insufficient available memory for this request')
        return size

    def read_json(self):
        size = self.body()
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError('Incomplete request')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('Expected an object')
        return value

    def do_GET(self):
        try:
            self._get()
        except (sqlite3.Error, MemoryError, OSError, ValueError):
            try:
                self.respond(503, {'error': 'Your device could not read local data or resource information. Check available memory/disk and retry.'})
            except OSError:
                pass

    def _get(self):
        parsed = urlsplit(self.path)
        if not parsed.path.startswith('/api/'):
            if not self.guard(False): return
            import mimetypes
            from urllib.parse import unquote
            requested=unquote(parsed.path).lstrip('/')
            target=(WEB/requested).resolve()
            if not target.is_relative_to(WEB.resolve()) or '\\' in requested:
                self.respond(404, {'error':'Unknown asset'});return
            if not target.is_file():
                if '.' in requested.rsplit('/',1)[-1]:
                    self.respond(404, {'error':'Unknown asset'});return
                target=WEB/'index.html'
            body=target.read_bytes();kind=mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
            if target.name=='index.html':
                kind='text/html; charset=utf-8'
                body=body.replace(b'</head>',('<meta name="local-session" content="'+self.server.token+'"></head>').encode())
            self.respond(200,body,kind);return
        if parsed.path.startswith('/api/workspace/'):
            self.workspace_request('GET');return
        if not self.guard():
            return
        with database(self.server.root) as con:
            if parsed.path == '/api/resources':
                import local_hardware
                from tempfile import gettempdir
                self.respond(200, {'processing': local_hardware.budget(gettempdir()), 'uploads': local_hardware.disk(self.server.root), 'notice': 'No fixed file-size or batch-byte cap. Available hardware can prevent completion; compressed size does not predict processing needs.'})
                return
            if parsed.path in {'/api/settings', '/api/reports'} or parsed.path.startswith('/api/reports/'):
                import manual_settings
                try:
                    if parsed.path == '/api/settings':
                        data = {'settings': manual_settings.settings(con), 'teams': dict(con.execute('SELECT account,team FROM mappings'))}
                    elif parsed.path == '/api/reports':
                        data = manual_settings.reports(con, parse_qs(parsed.query).get('before', [None])[0])
                    else:
                        data = manual_settings.report(con, parsed.path.removeprefix('/api/reports/'))
                    self.respond(200, data)
                except (ValueError, TypeError):
                    self.respond(400, {'error': 'Requested local settings or report unavailable'})
                return
            if parsed.path == '/api/history':
                import manual_store
                try:
                    query = parse_qs(parsed.query)
                    self.respond(200, manual_store.history(con, query.get('before', [None])[0], int(query.get('limit', ['50'])[0])))
                except ValueError:
                    self.respond(400, {'error': 'Invalid history cursor or page size'})
                return
            if parsed.path == '/api/state':
                active = self.server.active
                if active and not active[1].is_alive():
                    con.execute("UPDATE runs SET status='interrupted',result=COALESCE(result,?) WHERE id=? AND status='running'",
                                (json.dumps({'error': 'The analysis process stopped unexpectedly. Your operating system may have stopped it because of resource pressure. Check available memory/disk and retry. No complete result was saved.', 'reason': 'worker_interrupted'}), active[0]))
                uploads = [{key: item.get(key) for key in ('id', 'name', 'bytes', 'role', 'sha256', 'inspection')} for (raw,) in con.execute('SELECT data FROM uploads') for item in [json.loads(raw)]]
                runs = [{'id': row[0], 'status': row[1], 'created': row[2]} for row in con.execute('SELECT id,status,created FROM runs ORDER BY created DESC LIMIT 100')]
                self.respond(200, {'files': uploads, 'runs': runs, 'mappings': dict(con.execute('SELECT account,team FROM mappings'))})
            elif parsed.path.startswith('/api/runs/'):
                run_id = parsed.path.removeprefix('/api/runs/')
                row = con.execute('SELECT status,result FROM runs WHERE id=?', (run_id,)).fetchone()
                if not row:
                    self.respond(404, {'error': 'Run unavailable'})
                else:
                    import manual_store
                    self.respond(200, {'status': row[0], 'result': json.loads(row[1]) if row[1] else None, 'finding_updates': manual_store.updates(con, run_id)})
            else:
                self.respond(404, {'error': 'Unknown route'})

    def do_PATCH(self):
        self.workspace_request('PATCH')

    def do_DELETE(self):
        self.workspace_request('DELETE')

    def workspace_request(self, method):
        if not self.guard(): return
        parsed=urlsplit(self.path)
        if not parsed.path.startswith('/api/workspace/'):
            self.respond(404,{'detail':'Unknown route'});return
        path=parsed.path.removeprefix('/api/workspace')
        query={k:v[0] for k,v in parse_qs(parsed.query).items()}
        try:
            import manual_api
            from urllib.parse import unquote
            path=unquote(path)
            if method=='DELETE' and path.startswith('/uploads/'):
                self.path='/api/files/remove'
                import io
                raw=json.dumps({'id':path.split('/')[-1]}).encode();self.rfile=io.BytesIO(raw)
                del self.headers['Content-Length'];self.headers['Content-Length']=str(len(raw))
                self.do_POST();return
            value={} if method in ('GET','DELETE') else self.read_json()
            if method=='POST' and path=='/allocation/history/reports':
                import manual_history
                with self.server.operation_lock:
                    busy=any(job and job[1].is_alive() for job in (self.server.active,self.server.history_active))
                    if busy:
                        self.respond(409,{'detail':'Another local analysis is running. Wait or cancel it first.'});return
                    with database(self.server.root) as con:
                        data=manual_history.accept(con,value,self.headers.get('Idempotency-Key',''))
                    if data['status']=='queued':
                        process=multiprocessing.get_context('spawn').Process(target=manual_history.build,args=(self.server.root,data['id']),daemon=True)
                        process.start();self.server.history_active=(data['id'],process)
                self.respond(202,data);return

            with self.server.operation_lock:
                with database(self.server.root) as con:
                    active=self.server.active
                    if active and not active[1].is_alive():
                        con.execute("UPDATE runs SET status='interrupted',result=COALESCE(result,?) WHERE id=? AND status='running'",(json.dumps({'error':'Local worker stopped. Check memory and disk, then retry.'}),active[0]))
                    data=manual_api.read(con,path,query) if method=='GET' else manual_api.mutate(con,path,method,value)
            if isinstance(data,str):self.respond(200,data.encode(),'text/html; charset=utf-8' if path.endswith('/print.html') else 'text/csv; charset=utf-8')
            else:self.respond(200,data)
        except (ValueError,KeyError,TypeError,StopIteration) as error:
            self.respond(400,{'detail':str(error) if isinstance(error,ValueError) else 'Invalid manual request'})
        except (sqlite3.Error,OSError,MemoryError):
            self.respond(503,{'detail':'Local storage or device resources unavailable. Retry after checking free memory and disk.'})

    def do_PUT(self):
        if not self.guard():
            return
        parsed = urlsplit(self.path)
        if parsed.path != '/api/upload':
            self.respond(404, {'error': 'Unknown route'})
            return
        if not self.server.upload_lock.acquire(blocking=False):
            self.respond(409, {'error': 'Another upload is in progress'})
            return
        path = None
        try:
            import local_hardware
            capacity = local_hardware.disk(self.server.root)
            size = self.body(capacity['usable_bytes'], hardware=True)
            query = parse_qs(parsed.query)
            name = query.get('name', [''])[0]
            role = query.get('role', ['primary'])[0]
            origin = query.get('origin', ['manual_check'])[0]
            description = query.get('description', [''])[0].strip()
            if origin not in ('manual_check', 'library') or len(description) > 500:
                raise ValueError('Invalid local file origin or description')
            if role not in ('primary', 'comparison') or not name or len(name) > 512 or '/' in name or '\\' in name or not name.lower().endswith(('.csv', '.csv.gz', '.parquet')):
                raise ValueError('Choose a local CSV, CSV.gz or Parquet file and a valid role')
            if size > local_hardware.disk(self.server.root)['usable_bytes']:
                raise ValueError('Your device does not have enough free disk for this upload. Choose another drive or free space, then retry.')
            identifier = str(uuid4())
            suffix = '.parquet' if name.lower().endswith('.parquet') else '.csv.gz' if name.lower().endswith('.gz') else '.csv'
            path = self.server.root / 'uploads' / (identifier + suffix + '.part')
            digest = hashlib.sha256()
            with path.open('xb') as stream:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Upload interrupted')
                    stream.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                    if shutil.disk_usage(self.server.root).free < capacity['reserve_bytes']:
                        raise ValueError('Upload stopped because your device is running low on free disk. No partial upload was saved.')
            final = path.with_suffix('')
            path.rename(final)
            path = final
            item = {'id': identifier, 'name': name, 'bytes': size, 'role': role, 'sha256': digest.hexdigest(), 'path': str(final), 'origins': [origin], 'description': description or None, 'created': datetime.now(timezone.utc).isoformat()}
            from local_dates import inspect
            item['inspection'] = inspect(final)
            import local_files
            with self.server.operation_lock:
                with database(self.server.root) as con:
                    item = local_files.retain(con, self.server.root, item)
                if Path(item['path']) != final:
                    final.unlink(missing_ok=True)
            path = None
            self.respond(201, {'id': item['id'], 'inspection': item['inspection']})
        except (ValueError, OSError) as error:
            self.respond(400, {'error': str(error) if isinstance(error, ValueError) else 'Upload storage unavailable'})
        finally:
            if path:
                path.unlink(missing_ok=True)
            self.server.upload_lock.release()

    def do_POST(self):
        if self.path.startswith('/api/workspace/'):
            self.workspace_request('POST');return
        if not self.guard():
            return
        try:
            value = self.read_json()
            with self.server.operation_lock:
                active = self.server.active
                running = active is not None and active[1].is_alive()
                if self.path in {'/api/settings', '/api/settings/teams', '/api/reports/update'}:
                    import manual_settings
                    try:
                        with database(self.server.root) as con:
                            if self.path == '/api/settings':
                                data = manual_settings.save_settings(con, value)
                            elif self.path == '/api/settings/teams':
                                manual_settings.save_team(con, value)
                                data = {'saved': True}
                            else:
                                data = manual_settings.update_report(con, value)
                    except ValueError as error:
                        self.respond(400, {'error': str(error)})
                        return
                    self.respond(200, data)
                    return
                if self.path == '/api/findings/update':
                    import manual_store
                    with database(self.server.root) as con:
                        manual_store.update_finding(con, value)
                    self.respond(200, {'saved': True})
                    return
                if self.path == '/api/runs/archive':
                    if type(value.get('archived')) is not bool:
                        raise ValueError('Invalid archive state')
                    with database(self.server.root) as con:
                        row = con.execute('SELECT status FROM runs WHERE id=?', (value.get('id'),)).fetchone()
                        if not row or row[0] == 'running':
                            raise ValueError('Only finished runs can be archived')
                        con.execute('INSERT INTO run_flags VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET archived=excluded.archived', (value['id'], int(value['archived'])))
                    self.respond(200, {'saved': True})
                    return
                if self.path == '/api/files/remove':
                    if running or (self.server.history_active and self.server.history_active[1].is_alive()):
                        raise ValueError('Wait for the active analysis before removing source files')
                    with database(self.server.root) as con:
                        import local_files
                        try:
                            source = local_files.remove(con, self.server.root, value.get('id'))
                        except ValueError as error:
                            self.respond(400, {'detail': str(error)})
                            return
                    if source:
                        source.unlink(missing_ok=True)
                    self.respond(200, {'removed': True, 'saved_results_preserved': True})
                    return
                if self.path == '/api/cancel':
                    if running:
                        active[1].terminate()
                        active[1].join(timeout=5)
                        if active[1].is_alive():
                            active[1].kill()
                            active[1].join()
                        with database(self.server.root) as con:
                            con.execute("UPDATE runs SET status='cancelled',result=NULL WHERE id=? AND status='running'", (active[0],))
                            outcome = con.execute('SELECT status FROM runs WHERE id=?', (active[0],)).fetchone()[0]
                    self.respond(200, {'status': outcome if running else 'idle'})
                    return
                if self.path == '/api/mappings':
                    mappings = value.get('mappings')
                    if not isinstance(mappings, dict) or len(mappings) > 10000 or any(not re.fullmatch(r'\d{12}', account) or not isinstance(team, str) or not team.strip() or len(team) > 255 for account, team in mappings.items()):
                        raise ValueError('Mappings need a 12-digit account and a team name')
                    with database(self.server.root) as con:
                        con.execute('DELETE FROM mappings')
                        con.executemany('INSERT INTO mappings VALUES (?,?)', mappings.items())
                    self.respond(200, {'saved': True})
                    return
                if self.path != '/api/analyse':
                    self.respond(404, {'error': 'Unknown route'})
                    return
                if running or (self.server.history_active and self.server.history_active[1].is_alive()):
                    self.respond(409, {'error': 'An analysis is already running'})
                    return
                from datetime import date
                from app.pipeline.types import DataWindow
                DataWindow(**{key: date.fromisoformat(value[key]) for key in ('start', 'end', 'baseline_start', 'baseline_end')})
                primary_ids = value.get('files')
                if not isinstance(primary_ids, list) or not primary_ids or any(not isinstance(item, str) for item in primary_ids) or len(set(primary_ids)) != len(primary_ids):
                    raise ValueError('Select distinct primary file identifiers')
                mode = value.get('comparison_mode', 'history')
                if mode not in ('history', 'device', 'previous'):
                    raise ValueError('Invalid comparison mode')
                with database(self.server.root) as con:
                    files = {identifier: json.loads(raw) for identifier, raw in con.execute('SELECT id,data FROM uploads')}
                    mappings = dict(con.execute('SELECT account,team FROM mappings'))
                    import manual_settings
                    value['_settings'] = manual_settings.settings(con)
                baseline_ids = value.get('baseline_ids', [])
                if not isinstance(baseline_ids, list) or any(not isinstance(identifier, str) for identifier in baseline_ids):
                    raise ValueError('Invalid comparison files')
                if mode != 'device' and baseline_ids or mode != 'previous' and value.get('comparison_check'):
                    raise ValueError('Comparison source must match the chosen mode')
                if value.get('comparison_mode') == 'device' and not baseline_ids:
                    raise ValueError('Select comparison files')
                previous = value.get('comparison_check')
                if value.get('comparison_mode') == 'previous' and not previous:
                    raise ValueError('Select a previous comparison check')
                if previous:
                    with database(self.server.root) as con:
                        row = con.execute("SELECT r.result FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id WHERE r.id=? AND r.status='completed' AND COALESCE(f.archived,0)=0", (previous,)).fetchone()
                    if not row:
                        raise ValueError('Previous comparison check unavailable')
                    saved = json.loads(row[0])
                    value['baseline_start'] = saved['window']['start']
                    value['baseline_end'] = saved['window']['end']
                    DataWindow(**{key: date.fromisoformat(value[key]) for key in ('start','end','baseline_start','baseline_end')})
                    references = [item for item in saved.get('input_files', []) if item.get('role') == 'primary']
                    if not references:
                        raise ValueError('Previous check source identities unavailable; upload comparison files')
                    for item in references:
                        if item['id'] not in files or files[item['id']]['sha256'] != item['sha256']:
                            raise ValueError('Retained comparison files missing or changed; upload them again')
                    baseline_ids = [item['id'] for item in references]
                if set(baseline_ids) & set(primary_ids):
                    raise ValueError('The same source cannot supply primary and explicitly selected comparison data')
                for identifier in baseline_ids:
                    if identifier not in files:
                        raise ValueError('Comparison file unavailable')
                    files[identifier] = {**files[identifier], 'role': 'comparison'}
                if any(identifier not in files or files[identifier]['role'] != 'primary' for identifier in primary_ids):
                    raise ValueError('Primary files must be uploaded as primary data')
                value['files'] = primary_ids + baseline_ids
                selected = value.get('files')
                if not isinstance(selected, list) or not selected or any(not isinstance(item, str) or item not in files for item in selected) or len(set(selected)) != len(selected):
                    raise ValueError('Select distinct uploaded file identifiers')
                for identifier in selected:
                    item = files[identifier]
                    path = Path(item['path'])
                    if path.is_symlink() or path.resolve().parent != (self.server.root / 'uploads').resolve() or path.stat().st_size != item['bytes']:
                        raise ValueError('Stored source identity changed; upload again')
                    # Streaming verification protects local retained identity without retaining file bytes.
                    with path.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    if digest != item['sha256']:
                        raise ValueError('Stored source identity changed; upload again')
                submission=value.get('submission_key')
                fingerprint=json.dumps({k:v for k,v in value.items() if k not in ('submission_key','_settings')},sort_keys=True)
                if submission:
                    if not isinstance(submission,str) or len(submission)>128:raise ValueError('Invalid submission identity')
                    with database(self.server.root) as con:
                        saved=con.execute('SELECT request,run_id FROM local_submissions WHERE key=?',(submission,)).fetchone()
                    if saved:
                        if saved[0]!=fingerprint:raise ValueError('Submission identity reused with different inputs')
                        self.respond(202,{'id':saved[1]});return
                run_id = str(uuid4())
                with database(self.server.root) as con:
                    for identifier in selected:
                        original = json.loads(con.execute('SELECT data FROM uploads WHERE id=?', (identifier,)).fetchone()[0])
                        original['origins'] = sorted(set(original.get('origins', [])) | {'manual_check'})
                        con.execute('UPDATE uploads SET data=? WHERE id=?', (json.dumps(original), identifier))
                    con.execute('INSERT INTO runs VALUES (?,?,NULL,?)', (run_id, 'running', datetime.now(timezone.utc).isoformat()))
                    if submission:con.execute('INSERT INTO local_submissions VALUES (?,?,?)',(submission,fingerprint,run_id))
                process = multiprocessing.get_context('spawn').Process(target=job, args=(self.server.root, run_id, value, files, mappings), daemon=True)
                process.start()
                self.server.active = (run_id, process)
                self.respond(202, {'id': run_id})
        except (ValueError, KeyError, TypeError, OSError, sqlite3.Error):
            self.respond(400, {'error': 'Invalid request or unavailable local storage; check the selected files, dates and mappings'})


def main():
    parser = argparse.ArgumentParser(description='Offline local AWS billing analysis')
    parser.add_argument('--port', type=int, default=43187, help='Local HTTP port (default: 43187)')
    parser.add_argument('--data', type=Path, default=Path.home() / '.commitops-local')
    parser.add_argument('--work-dir', type=Path, help='Trusted local CLI choice for processing storage on another drive')
    args = parser.parse_args()
    if args.work_dir:
        import tempfile
        if args.work_dir.is_symlink():
            parser.error('Working directory cannot be a symbolic link')
        args.work_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        tempfile.tempdir = str(args.work_dir.resolve())
    if args.data.is_symlink():
        parser.error('Data directory cannot be a symbolic link')
    root = args.data.resolve()
    try:
        lease = data_lease(root)
    except OSError as error:
        parser.error(str(error))
    initialise(root)
    deny_outbound()
    server = Server(args.port, root)
    print(f'Open http://127.0.0.1:{server.server_port}/#token={server.token}', flush=True)
    print('Local files only. Press Ctrl+C to stop. Keep the launch URL private.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server.active and server.active[1].is_alive():
            server.active[1].terminate()
            server.active[1].join(timeout=5)
        server.server_close()
        lease.close()


if __name__ == '__main__':
    multiprocessing.freeze_support()
    main()
