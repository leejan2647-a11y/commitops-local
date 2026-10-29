import http.client
import json
import sys
import tempfile
import threading
import unittest
import hashlib
import os
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import local_app


class ManualHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        local_app.initialise(self.root)
        self.result = json.dumps({'findings': [{'id': 'f', 'impact_cents': 125}], 'validation': {'window_total_cents': 999}})
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('run', 'completed', self.result, '2026-10-28'))
        self.server = local_app.Server(0, self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, authenticated=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'X-Local-Token': self.server.token} if authenticated else {}
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        response = connection.getresponse()
        code, result = response.status, json.loads(response.read())
        connection.close()
        return code, result

    def test_manual_reviews_archives_and_complete_history_preserve_financial_evidence(self):
        self.assertEqual(self.request('GET', '/api/history', authenticated=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/findings/update', {'run_id': 'run', 'finding_id': 'f', 'status': 'resolved', 'note': 'reviewed'})[0], 200)
        code, data = self.request('GET', '/api/runs/run')
        self.assertEqual(code, 200)
        self.assertEqual(data['result'], json.loads(self.result))
        self.assertEqual(data['finding_updates']['f']['status'], 'resolved')
        self.assertEqual(self.request('POST', '/api/runs/archive', {'id': 'run', 'archived': True})[0], 200)
        self.assertTrue(self.request('GET', '/api/history')[1]['runs'][0]['archived'])

    def test_no_automatic_or_delivery_endpoints_exist(self):
        for path in ['/api/schedules', '/api/reporting/rules', '/api/delivery/connections', '/api/aws/connections']:
            self.assertEqual(self.request('GET', path)[0], 404)
            self.assertEqual(self.request('POST', path, {})[0], 404)

    def upload(self, name, raw, role='primary'):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=15)
        connection.request('PUT','/api/upload?name='+name+'&role='+role,body=raw,headers={'X-Local-Token':self.server.token})
        response=connection.getresponse();result=(response.status,json.loads(response.read()));connection.close()
        return result

    def test_real_upload_dates_and_legacy_state(self):
        code,uploaded=self.upload('month.csv',b'lineItem/UsageStartDate\n2026-09-01\n2026-09-30')
        self.assertEqual(code,201)
        self.assertEqual(uploaded['inspection']['max_date'],'2026-09-30')
        self.assertEqual(self.request('GET','/api/state')[1]['files'][0]['inspection'],uploaded['inspection'])
        self.assertEqual(self.upload('../escape.csv',b'x')[0],400)
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO uploads VALUES (?,?)',('legacy',json.dumps({'id':'legacy','name':'old.csv','role':'primary','bytes':1,'sha256':'a'*64})))
        state=self.request('GET','/api/state')[1]
        self.assertIsNone(next(f for f in state['files'] if f['id']=='legacy')['inspection'])
        self.assertNotIn(str(self.root),json.dumps(state))

    def test_page_bootstrap_and_team_creation(self):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        connection.request('GET','/')
        response=connection.getresponse();page=response.read().decode();connection.close()
        self.assertEqual(response.status,200)
        self.assertIn('name="local-session" content="'+self.server.token+'"',page)
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        connection.request('GET','/',headers={'Origin':'https://untrusted.example'})
        response=connection.getresponse();page=response.read().decode();connection.close()
        self.assertEqual(response.status,403);self.assertNotIn(self.server.token,page)
        self.assertEqual(self.request('POST','/api/settings/teams',{'action':'add','account':'111111111111','name':'Platform'})[0],200)
        self.assertEqual(self.request('GET','/api/settings')[1]['teams']['111111111111'],'Platform')

    def test_explicit_comparison_provenance_dates_and_separation(self):
        primary=self.upload('new.csv',b'lineItem/UsageStartDate\n2026-09-01\n2026-09-30')[1]['id']
        previous=self.upload('old.csv',b'lineItem/UsageStartDate\n2026-08-01\n2026-08-31')[1]['id']
        state=self.request('GET','/api/state')[1]
        metadata=next(f for f in state['files'] if f['id']==previous)
        saved={'window':{'start':'2026-08-01','end':'2026-08-31'},'input_files':[metadata]}
        with local_app.database(self.root) as con:
            con.execute('UPDATE runs SET result=? WHERE id=?',(json.dumps(saved),'run'))
        received=[]
        def process(**kwargs):
            received.append(kwargs['args'])
            return SimpleNamespace(start=lambda:None,is_alive=lambda:False)
        body={'files':[primary],'comparison_mode':'previous','comparison_check':'run','start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-07-01','baseline_end':'2026-07-31'}
        with patch.object(local_app.multiprocessing,'get_context',return_value=SimpleNamespace(Process=process)):
            self.assertEqual(self.request('POST','/api/analyse',body)[0],202)
        request,files=received[0][2:4]
        self.assertEqual((request['baseline_start'],request['baseline_end']),('2026-08-01','2026-08-31'))
        self.assertEqual(files[primary]['role'],'primary');self.assertEqual(files[previous]['role'],'comparison')
        self.assertEqual(next(f for f in self.request('GET','/api/state')[1]['files'] if f['id']==previous)['role'],'primary')
        self.assertEqual(self.request('POST','/api/analyse',{**body,'files':[previous]})[0],400)
        self.request('POST','/api/runs/archive',{'id':'run','archived':True})
        self.assertEqual(self.request('POST','/api/analyse',body)[0],400)
        self.request('POST','/api/runs/archive',{'id':'run','archived':False})
        with local_app.database(self.root) as con:
            raw=json.loads(con.execute('SELECT data FROM uploads WHERE id=?',(previous,)).fetchone()[0])
        Path(raw['path']).write_bytes(b'changed')
        self.assertEqual(self.request('POST','/api/analyse',body)[0],400)
        self.assertEqual(self.request('POST','/api/analyse',{**body,'comparison_mode':'device','comparison_check':None,'baseline_ids':[]})[0],400)
        self.assertEqual(self.request('POST','/api/analyse',{**body,'comparison_mode':'history'})[0],400)

    def test_source_removal_cannot_follow_substituted_paths(self):
        sentinel = self.root / 'preserve.txt'
        sentinel.write_text('private unchanged')
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO uploads VALUES (?,?)', ('bad', json.dumps({'path': str(sentinel)})))
        self.assertEqual(self.request('POST', '/api/files/remove', {'id': 'bad'})[0], 400)
        self.assertEqual(sentinel.read_text(), 'private unchanged')
        source = self.root / 'uploads' / 'valid.csv'
        source.write_text('fixture')
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO uploads VALUES (?,?)', ('good', json.dumps({'path': str(source)})))
        self.assertEqual(self.request('POST', '/api/files/remove', {'id': 'good'})[0], 200)
        self.assertFalse(source.exists())
        self.assertEqual(self.request('GET', '/api/runs/run')[1]['result'], json.loads(self.result))

    def test_settings_reports_and_hardware_only_batch_admission(self):
        settings = {'name': 'Local company', 'defaultDateRange': '60', 'creepMonthlyGrowthPercent': '5'}
        self.assertEqual(self.request('POST', '/api/settings', settings)[0], 200)
        self.assertEqual(self.request('GET', '/api/settings')[1]['settings'], settings)
        code, report = self.request('POST', '/api/reports/update', {'action': 'create', 'name': 'Review', 'run_id': 'run'})
        self.assertEqual(code, 200)
        self.assertEqual(self.request('GET', '/api/reports/'+report['id'])[1]['result'], json.loads(self.result))
        self.assertIn('processing', self.request('GET', '/api/resources')[1])
        selected, paths = [], []
        for i in range(2):
            identifier = str(uuid4())
            source = self.root/'uploads'/(identifier+'.csv')
            source.write_bytes(b'tiny test data')
            selected.append(identifier)
            paths.append(source)
            metadata = {'id': identifier, 'path': str(source), 'name': source.name, 'role': 'primary', 'bytes': 3_000_000_000, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}
            with local_app.database(self.root) as con:
                con.execute('INSERT INTO uploads VALUES (?,?)', (identifier, json.dumps(metadata)))
        native = Path.stat
        def measured(path, *args, **kwargs):
            result = native(path, *args, **kwargs)
            if path in paths:
                values = list(result)
                values[6] = 3_000_000_000
                return os.stat_result(values)
            return result
        received = []
        def process(**kwargs):
            received.append(kwargs['args'])
            return SimpleNamespace(start=lambda: None, is_alive=lambda: False)
        context = SimpleNamespace(Process=process)
        # Only metadata is simulated; the test reads two tiny files, never 6 GB.
        with patch.object(Path, 'stat', measured), patch.object(local_app.multiprocessing, 'get_context', return_value=context):
            code, _ = self.request('POST', '/api/analyse', {'files': selected, 'start': '2026-09-01', 'end': '2026-09-30', 'baseline_start': '2026-08-01', 'baseline_end': '2026-08-31', '_settings': {'creepMonthlyGrowthPercent': '999'}})
        self.assertEqual(code, 202)
        self.assertEqual(received[0][2]['_settings'], settings)


if __name__ == '__main__':
    unittest.main()
