"""Shared retained files and reference-only reports, using disposable local state."""
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import local_app
import manual_settings


class SharedStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        local_app.initialise(self.root)
        self.server = local_app.Server(0, self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        connection.request(method, path, body, {'X-Local-Token': self.server.token})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def upload(self, query='role=primary&origin=manual_check', payload=b'not,a,cur\n1,2,3'):
        code, data = self.call('PUT', '/api/upload?name=fixture.csv&'+query, payload)
        self.assertEqual(code, 201, data)
        return data['id']

    def test_reupload_reuses_identity_and_preserves_origins_description(self):
        first = self.upload()
        second = self.upload('role=primary&origin=library&description=Monthly')
        self.assertEqual(first, second)
        self.assertEqual(len(list((self.root/'uploads').iterdir())), 1)
        item = self.call('GET', '/api/workspace/uploads')[1]['items'][0]
        self.assertEqual(set(item['origins']), {'manual_check', 'library'})
        self.assertEqual(item['description'], 'Monthly')
        self.assertIsNotNone(item['created_at'])

    def test_distinct_roles_share_bytes_and_deletion_preserves_other_reference(self):
        first = self.upload()
        baseline = self.upload('role=comparison&origin=manual_check')
        self.assertNotEqual(first, baseline)
        self.assertEqual(len(list((self.root/'uploads').iterdir())), 1)
        self.assertEqual(self.call('DELETE', '/api/workspace/uploads/'+first)[0], 200)
        self.assertEqual(len(list((self.root/'uploads').iterdir())), 1)
        self.assertEqual(self.call('DELETE', '/api/workspace/uploads/'+baseline)[0], 200)
        self.assertEqual(list((self.root/'uploads').iterdir()), [])

    def test_legacy_upload_without_inspection_reuses_verified_bytes(self):
        identifier = self.upload()
        with local_app.database(self.root) as con:
            saved = json.loads(con.execute('SELECT data FROM uploads WHERE id=?', (identifier,)).fetchone()[0])
            saved.pop('inspection')
            saved.pop('origins')
            con.execute('UPDATE uploads SET data=? WHERE id=?', (json.dumps(saved), identifier))
        self.assertEqual(self.upload('role=primary&origin=library'), identifier)
        self.assertEqual(len(list((self.root/'uploads').iterdir())), 1)

    def test_changed_content_is_distinct_and_tampered_retained_bytes_are_not_reused(self):
        first = self.upload()
        other = self.upload(payload=b'not,a,cur\n1,2,4')
        self.assertNotEqual(first, other)
        with local_app.database(self.root) as con:
            item = json.loads(con.execute('SELECT data FROM uploads WHERE id=?', (first,)).fetchone()[0])
        Path(item['path']).write_bytes(b'tampered bytes')
        repaired = self.upload()
        self.assertNotEqual(repaired, first)
        with local_app.database(self.root) as con:
            fresh = json.loads(con.execute('SELECT data FROM uploads WHERE id=?', (repaired,)).fetchone()[0])
        self.assertEqual(Path(fresh['path']).read_bytes(), b'not,a,cur\n1,2,3')

    def test_in_use_source_cannot_be_removed(self):
        identifier = self.upload()
        with local_app.database(self.root) as con:
            result = json.dumps({'input_files': [{'id': identifier}]})
            con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('check-one', 'completed', result, '2026-10-28'))
        code, problem = self.call('DELETE', '/api/workspace/uploads/'+identifier)
        self.assertEqual(code, 400)
        self.assertIn('saved checks', problem['detail'])
        self.assertEqual(len(list((self.root/'uploads').iterdir())), 1)

    def test_invalid_origin_cannot_claim_automatic_source(self):
        self.assertEqual(self.call('PUT', '/api/upload?name=x.csv&origin=automatic_check', b'content')[0], 400)
        self.assertEqual(list((self.root/'uploads').iterdir()), [])

    def test_reports_reference_canonical_results_but_freeze_review_and_verify_integrity(self):
        original = json.dumps({'validation': {'window_total_cents': 3092}, 'input_files': [], 'findings': [], 'evidence': 'immutable evidence '*1000})
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('check-one', 'completed', original, '2026-10-28'))
            con.execute('INSERT INTO finding_updates VALUES (?,?,?,?,?)', ('check-one', 'f1', 'open', 'original note', 0))
            one = manual_settings.update_report(con, {'action': 'create', 'name': 'One', 'run_id': 'check-one'})['id']
            two = manual_settings.update_report(con, {'action': 'create', 'name': 'Two', 'run_id': 'check-one'})['id']
            for identifier in (one, two):
                stored = json.loads(con.execute('SELECT document FROM local_reports WHERE id=?', (identifier,)).fetchone()[0])
                self.assertNotIn('result', stored.get('checks', [stored])[0])
                self.assertLess(len(json.dumps(stored)), len(original)//10)
                self.assertEqual(manual_settings.report(con, identifier)['result']['validation']['window_total_cents'], 3092)
            con.execute("UPDATE finding_updates SET note='changed note'")
            self.assertEqual(manual_settings.report(con, one)['local_review']['f1']['note'], 'original note')
            con.execute("INSERT INTO run_flags VALUES ('check-one',1)")
            self.assertEqual(manual_settings.report(con, one)['result'], json.loads(original))
            con.execute("UPDATE runs SET result='{}' WHERE id='check-one'")
            with self.assertRaises(ValueError):
                manual_settings.report(con, one)

    def test_multi_check_report_keeps_separate_results_and_refuses_missing_source(self):
        with local_app.database(self.root) as con:
            for identifier, cents in [('one', 3092), ('two', 3015)]:
                con.execute('INSERT INTO runs VALUES (?,?,?,?)', (identifier, 'completed', json.dumps({'validation': {'window_total_cents': cents}}), '2026-10-28'))
            identifier = manual_settings.update_report(con, {'action': 'create', 'name': 'Both', 'run_ids': ['one', 'two']})['id']
            document = manual_settings.report(con, identifier)
            self.assertEqual([item['result']['validation']['window_total_cents'] for item in document['checks']], [3092, 3015])
            self.assertIn('not additive', document['basis'])
            con.execute("DELETE FROM runs WHERE id='two'")
            with self.assertRaises(ValueError):
                manual_settings.report(con, identifier)

    def test_legacy_report_stays_readable_without_rewriting(self):
        doc = json.dumps({'check_id': 'check-one', 'result': {'validation': {'window_total_cents': 3092}}})
        with local_app.database(self.root) as con:
            con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('check-one', 'completed', '{}', '2026-10-28'))
            con.execute('INSERT INTO local_reports VALUES (?,?,?,?,0,?,?)', ('legacy', 'check-one', 'Legacy', '2026-10-28', doc, hashlib.sha256(doc.encode()).hexdigest()))
            self.assertEqual(manual_settings.report(con, 'legacy')['result']['validation']['window_total_cents'], 3092)
            self.assertEqual(con.execute("SELECT document FROM local_reports WHERE id='legacy'").fetchone()[0], doc)


if __name__ == '__main__':
    unittest.main()
