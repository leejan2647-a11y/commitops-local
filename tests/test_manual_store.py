import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import manual_store


class ManualStoreTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(':memory:')
        self.con.execute('PRAGMA foreign_keys=ON')
        self.con.execute('CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,result TEXT,created TEXT)')
        manual_store.initialise(self.con)
        self.document = json.dumps({'findings': [{'id': 'finding-1', 'impact_cents': 1250}]})
        for i in range(103):
            self.con.execute('INSERT INTO runs VALUES (?,?,?,?)', (str(i).zfill(3), 'completed', self.document, '2026-10-28'))

    def tearDown(self):
        self.con.close()

    def test_review_never_rewrites_financial_result(self):
        manual_store.update_finding(self.con, {'run_id': '001', 'finding_id': 'finding-1', 'status': 'resolved', 'note': '<script>text</script>', 'archived': True})
        self.assertEqual(self.con.execute('SELECT result FROM runs WHERE id=?', ('001',)).fetchone()[0], self.document)
        self.assertEqual(manual_store.updates(self.con, '001')['finding-1']['status'], 'resolved')
        self.assertEqual(manual_store.updates(self.con, '002'), {})

    def test_unknown_findings_invalid_status_and_note_are_refused(self):
        for fields in [{'finding_id': 'missing'}, {'status': 'scheduled'}, {'note': 'x'*4097}, {'archived': 'false'}]:
            with self.assertRaises(ValueError):
                manual_store.update_finding(self.con, {'run_id': '001', 'finding_id': 'finding-1', 'status': 'open', **fields})

    def test_history_keyset_covers_every_run_once_including_tied_timestamps(self):
        ids, cursor = [], None
        while True:
            result = manual_store.history(self.con, cursor, 17)
            ids.extend(row['id'] for row in result['runs'])
            cursor = result['next_cursor']
            if not cursor:
                break
        self.assertEqual(len(ids), 103)
        self.assertEqual(len(set(ids)), 103)

    def test_archived_history_remains_accessible(self):
        self.con.execute('INSERT INTO run_flags VALUES (?,?)', ('102', 1))
        row = manual_store.history(self.con, limit=1)['runs'][0]
        self.assertEqual(row['id'], '102')
        self.assertTrue(row['archived'])


if __name__ == '__main__':
    unittest.main()
