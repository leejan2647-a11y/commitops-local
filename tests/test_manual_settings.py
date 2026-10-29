import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import manual_settings
import manual_store


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(':memory:')
        self.con.execute('PRAGMA foreign_keys=ON')
        self.con.executescript('CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,result TEXT,created TEXT);CREATE TABLE mappings(account TEXT PRIMARY KEY,team TEXT);')
        manual_store.initialise(self.con)
        manual_settings.initialise(self.con)
        self.original = json.dumps({'findings': [{'id': 'f', 'impact_cents': 125}]})
        self.con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('run', 'completed', self.original, '2026-10-28'))
        self.con.commit()

    def tearDown(self):
        self.con.close()

    def test_defaults_round_trip_and_invalid_values_refused(self):
        self.assertEqual(manual_settings.settings(self.con), manual_settings.DEFAULTS)
        value = {'name': 'Local company', 'defaultDateRange': '60', 'creepMonthlyGrowthPercent': '2.5'}
        manual_settings.save_settings(self.con, value)
        self.assertEqual(manual_settings.settings(self.con), value)
        for growth in ['0', '-1', 'NaN', 'Infinity', '', True]:
            with self.assertRaises(ValueError):
                manual_settings.save_settings(self.con, {**value, 'creepMonthlyGrowthPercent': growth})
        self.assertEqual(self.con.execute('SELECT result FROM runs').fetchone()[0], self.original)

    def test_team_crud_does_not_silently_replace_an_account(self):
        manual_settings.save_team(self.con, {'action': 'add', 'account': '111111111111', 'name': 'Engineering'})
        with self.assertRaises(ValueError):
            manual_settings.save_team(self.con, {'action': 'add', 'account': '111111111111', 'name': 'Other'})
        manual_settings.save_team(self.con, {'action': 'edit', 'previous_account': '111111111111', 'account': '222222222222', 'name': 'Platform'})
        self.assertEqual(dict(self.con.execute('SELECT account,team FROM mappings')), {'222222222222': 'Platform'})
        manual_settings.save_team(self.con, {'action': 'delete', 'account': '222222222222'})
        self.assertEqual(self.con.execute('SELECT count(*) FROM mappings').fetchone()[0], 0)

    def test_report_is_a_snapshot_and_metadata_changes_preserve_it(self):
        created = manual_settings.update_report(self.con, {'action': 'create', 'name': 'Review', 'run_id': 'run'})['id']
        original = manual_settings.report(self.con, created)
        manual_store.update_finding(self.con, {'run_id': 'run', 'finding_id': 'f', 'status': 'resolved'})
        manual_settings.update_report(self.con, {'action': 'rename', 'id': created, 'name': 'Meeting'})
        manual_settings.update_report(self.con, {'action': 'archive', 'id': created, 'archived': True})
        self.assertEqual(manual_settings.report(self.con, created), original)
        self.assertTrue(manual_settings.reports(self.con)['reports'][0]['archived'])
        manual_settings.update_report(self.con, {'action': 'delete', 'id': created})
        self.assertEqual(self.con.execute('SELECT result FROM runs').fetchone()[0], self.original)

    def test_corrupt_reports_are_refused_and_incomplete_checks_cannot_generate(self):
        created = manual_settings.update_report(self.con, {'action': 'create', 'name': 'Review', 'run_id': 'run'})['id']
        self.con.execute('UPDATE local_reports SET document=? WHERE id=?', ('{}', created))
        with self.assertRaises(ValueError):
            manual_settings.report(self.con, created)
        self.con.execute("UPDATE runs SET status='running'")
        with self.assertRaises(ValueError):
            manual_settings.update_report(self.con, {'action': 'create', 'name': 'Review', 'run_id': 'run'})

    def test_multi_check_report_keeps_snapshots_separate_without_adding_totals(self):
        self.con.execute('INSERT INTO runs VALUES (?,?,?,?)', ('second', 'completed', self.original, '2026-10-29'))
        identifier = manual_settings.update_report(self.con, {'action': 'create', 'name': 'Meeting', 'run_ids': ['run', 'second']})['id']
        snapshot = manual_settings.report(self.con, identifier)
        self.assertEqual([item['check_id'] for item in snapshot['checks']], ['run', 'second'])
        self.assertNotIn('total_cents', snapshot)
        self.assertEqual([item['result'] for item in snapshot['checks']], [json.loads(self.original)]*2)
        with self.assertRaises(ValueError):
            manual_settings.update_report(self.con, {'action': 'create', 'name': 'Duplicate', 'run_ids': ['run', 'run']})


if __name__ == '__main__':
    unittest.main()
