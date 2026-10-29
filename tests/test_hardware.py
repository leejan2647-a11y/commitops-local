import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
from email.message import Message
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import local_hardware
import local_app


class HardwareTests(unittest.TestCase):
    def test_budget_scales_with_available_hardware_not_a_product_tier(self):
        with patch.object(local_hardware, 'memory', return_value=(40_000_000_000, 64_000_000_000)), patch.object(local_hardware, 'threads', return_value=24), patch.object(local_hardware, 'disk', return_value={'usable_bytes': 500_000_000_000, 'reserve_bytes': 50_000_000_000}):
            budget = local_hardware.budget('.')
        self.assertEqual(budget['cpu_threads'], 24)
        self.assertEqual(budget['duckdb_memory_bytes'], 28_000_000_000)
        self.assertEqual(budget['spill_bytes'], 500_000_000_000)
        self.assertIsNone(budget['input_size_cap_bytes'])

    def test_small_devices_get_proportional_headroom_not_an_eight_gib_barrier(self):
        with patch.object(local_hardware.shutil, 'disk_usage', return_value=SimpleNamespace(free=500_000_000)):
            budget = local_hardware.disk('.')
        self.assertEqual(budget['usable_bytes'], 450_000_000)
        self.assertEqual(budget['reserve_bytes'], 50_000_000)

    def test_cpu_quota_is_respected(self):
        with patch.object(local_hardware.os, 'cpu_count', return_value=64), patch.object(local_hardware.psutil, 'Process', return_value=SimpleNamespace(cpu_affinity=lambda: list(range(32)))), patch.object(local_hardware.Path, 'read_text', return_value='200000 100000'):
            self.assertEqual(local_hardware.threads(), 2)

    def test_five_gb_declared_upload_is_admitted_when_disk_can_hold_it(self):
        headers = Message()
        headers['Content-Length'] = '5000000000'
        handler = SimpleNamespace(headers=headers)
        self.assertEqual(local_app.Handler.body(handler, 10_000_000_000, hardware=True), 5_000_000_000)
        with self.assertRaisesRegex(ValueError, 'device'):
            local_app.Handler.body(handler, 4_000_000_000, hardware=True)

    def test_memory_pressure_interrupts_processing_and_reports_device_failure(self):
        from app.core.analysis_storage import AnalysisConnection, AnalysisStorageError
        working = tempfile.TemporaryDirectory()
        lease = (Path(working.name)/'.lease').open('wb')
        interrupted = []
        fake = SimpleNamespace(interrupt=lambda: interrupted.append(True), close=lambda: None)
        with patch.object(local_hardware, 'memory', return_value=(0, 1000)):
            connection = AnalysisConnection(fake, working, lease, memory_reserve=100)
            try:
                until = time.monotonic()+3
                while not connection._storage_failed and time.monotonic() < until:
                    time.sleep(.02)
                with self.assertRaisesRegex(AnalysisStorageError, 'device'):
                    connection._ensure_available()
            finally:
                connection.close()
        self.assertTrue(interrupted)

    def test_ingest_reports_typed_device_failures_instead_of_a_product_limit(self):
        import duckdb
        from app.pipeline.ingest import ingest_many
        from app.core.analysis_storage import AnalysisStorageError
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'tiny.csv'
            source.write_text('a,b\n1,2\n')
            for error, code in [(duckdb.OutOfMemoryException('synthetic pressure'), 'device_memory'), (AnalysisStorageError('synthetic pressure'), 'device_storage')]:
                con = Mock()
                con.execute.side_effect = error
                with self.assertLogs('app.pipeline.ingest', level='ERROR'):
                    result = ingest_many([str(source)], con=con)
                self.assertEqual(result.diagnostics['code'], code)
                self.assertIn('device', result.error)


if __name__ == '__main__':
    unittest.main()
