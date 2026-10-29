"""Focused exported engine, isolation and local application checks."""
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
import local_app
from local_analysis import analyse
from fixture import build_cur_rows, write_cur_csv, write_cur_gz, write_cur_parquet


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_engine_formats_exact_parity_and_detector_reachability(self):
        outputs = []
        for suffix, writer in [('.csv', write_cur_csv), ('.csv.gz', write_cur_gz), ('.parquet', write_cur_parquet)]:
            path = self.root / ('fixture' + suffix)
            rows = build_cur_rows(with_duplicates=8)
            from fixture import CUR_COLUMNS
            if 'bill/PayerAccountId' not in CUR_COLUMNS: CUR_COLUMNS.append('bill/PayerAccountId')
            for row in rows:
                row['bill/PayerAccountId'] = '999999999999'
                from datetime import date, timedelta
                month = date.fromisoformat(row['bill/BillingPeriodStartDate'])
                row['bill/BillingPeriodEndDate'] = ((month.replace(day=28)+timedelta(days=4)).replace(day=1)).isoformat()
            writer(rows, path)
            identifier = str(uuid4())
            import hashlib
            item = {'id': identifier, 'name': path.name, 'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'role': 'primary'}
            output = analyse({'files':[identifier], 'start':'2024-08-25','end':'2024-09-24','baseline_start':'2024-04-01','baseline_end':'2024-08-24', 'expectations':[{'service':'AmazonCloudFront','amount':'1.00','note':'agreed'}]}, {identifier:item}, {'111111111111':'Platform'})
            kinds = {finding['type'] for finding in output['findings']}
            self.assertTrue({'unexpected-charge','spike','gradual-creep','new-charge','usage-cost-mismatch','marketplace','expectation-mismatch'} <= kinds)
            self.assertIn('sp_inventory_unknown', {item['code'] for item in output['sp_assessment']['reasons']})
            self.assertEqual(output['validation']['duplicate_rows'], 8)
            self.assertNotIn(str(self.root), json.dumps(output))
            self.assertIn('spend_history', output['validation'])
            outputs.append((output['validation']['computed_total_cents'], sorted((item['type'], str(item['impact_cents'])) for item in output['findings']), output['allocation']))
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])

    def test_unused_commitment_and_team_consumption(self):
        import hashlib
        path = ROOT/'tests'/'fixtures'/'sp_idle.csv.gz'
        identifier = str(uuid4())
        item = {'id':identifier,'name':path.name,'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'role':'primary'}
        output = analyse({'files':[identifier],'start':'2025-03-01','end':'2025-03-31','baseline_start':'2025-02-01','baseline_end':'2025-02-28'}, {identifier:item},{'111111111111':'Platform'})
        self.assertIn('unused-commitment',{finding['type'] for finding in output['findings']})
        self.assertEqual(sum(item['impact_cents'] for item in output['findings'] if item['type']=='unused-commitment'),74400)
        self.assertIsNone(output['allocation']['totalUnusedCents'])  # RI inventory is unknown; don't invent a reconciled combined total.

    def test_data_directory_has_exclusive_lifetime_lease(self):
        first = local_app.data_lease(self.root)
        try:
            with self.assertRaises(OSError): local_app.data_lease(self.root)
        finally: first.close()

    def test_source_ordinals_follow_global_canonical_order(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        paths = [('a.csv','comparison'),('b.csv','primary'),('c.csv','comparison')]
        files = {}
        for name, role in paths:
            identifier = str(uuid4()); path = self.root/name; path.write_text('test')
            files[identifier] = {'id':identifier,'name':name,'path':str(path),'bytes':4,'sha256':'a'*64,'role':role}
        fake = SimpleNamespace(allocation=None,monthly_growth=None)
        with patch('local_analysis.run_check', return_value=fake) as run, patch('local_analysis.serial',return_value={}):
            analyse({'files':list(files),'start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-08-01','baseline_end':'2026-08-31'},files,{})
        sources = run.call_args.kwargs['growth_sources']
        self.assertEqual([(item.ordinal,item.filename,item.role) for item in sources],[(0,'a.csv','baseline'),(1,'b.csv','primary'),(2,'c.csv','baseline')])

    def test_remote_sources_refused_before_any_read(self):
        from app.pipeline.run import run_check, CheckFailed
        from app.pipeline.types import DataWindow
        from datetime import date
        window = DataWindow(date(2026,9,1),date(2026,9,30),date(2026,8,1),date(2026,8,31))
        for path in ['https://example.com/private.csv','s3://bucket/key','//host/share/file.csv',r'\\host\share\file.csv']:
            with self.assertRaises(CheckFailed): run_check(path, window, 'local')

    def test_offline_guard_and_duckdb_configuration(self):
        code = "import local_app,socket;local_app.deny_outbound();socket.create_connection(('example.com',443))"
        result = subprocess.run([sys.executable,'-c',code], cwd=ROOT/'engine', capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Outbound connections are disabled', result.stderr)
        from app.core.resources import analysis_connection
        with analysis_connection() as con:
            self.assertFalse(con.execute("SELECT current_setting('autoinstall_known_extensions')").fetchone()[0])
            self.assertFalse(con.execute("SELECT current_setting('autoload_known_extensions')").fetchone()[0])

    def test_loopback_token_origin_upload_and_cancel(self):
        local_app.initialise(self.root)
        server = local_app.Server(0, self.root)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def call(method, path, body=None, extra=None, token=True):
            con = http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=10)
            headers = {'X-Local-Token':server.token} if token else {}
            headers.update(extra or {})
            con.request(method,path,body=body,headers=headers)
            response = con.getresponse();data=response.read();code=response.status;con.close()
            return code, json.loads(data)
        try:
            self.assertEqual(call('GET','/api/state',token=False)[0],403)
            self.assertEqual(call('GET','/api/state',extra={'Origin':'https://example.com'})[0],403)
            self.assertEqual(call('GET','/api/state',extra={'Host':'attacker.example'})[0],403)
            self.assertEqual(call('PUT','/api/upload?name=../file.csv',b'x')[0],400)
            self.assertEqual(call('POST','/api/analyse',b'{bad')[0],400)
            self.assertEqual(call('POST','/api/analyse',json.dumps({'files':['https://example.com']}))[0],400)
            code, uploaded = call('PUT','/api/upload?name=bad.csv&role=primary',b'not,a,cur\n1,2,3')
            self.assertEqual(code,201)
            state = call('GET','/api/state')[1]
            self.assertNotIn('path',state['files'][0]);self.assertNotIn(str(self.root),json.dumps(state))
            body = json.dumps({'files':[uploaded['id']],'start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-08-01','baseline_end':'2026-08-31'})
            code, run = call('POST','/api/analyse',body);self.assertEqual(code,202)
            self.assertEqual(call('POST','/api/cancel','{}')[0],200)
            self.assertIn(call('GET','/api/runs/'+run['id'])[1]['status'],('cancelled','failed'))
            self.assertEqual(call('POST','/api/mappings',json.dumps({'mappings':{'111111111111':'<script>team</script>'}}))[0],200)
            self.assertEqual(call('GET','/api/state')[1]['mappings']['111111111111'],'<script>team</script>')
        finally:
            if server.active and server.active[1].is_alive():server.active[1].terminate();server.active[1].join()
            server.shutdown();server.server_close();thread.join()


if __name__ == '__main__': unittest.main()
