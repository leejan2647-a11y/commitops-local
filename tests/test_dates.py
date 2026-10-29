import sys, tempfile, unittest, gzip
from pathlib import Path
from datetime import date, timedelta
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'engine'))
from local_dates import inspect, windows

class DateTests(unittest.TestCase):
    def test_exact_inclusive_windows_and_no_fabricated_baseline(self):
        options=windows('2026-09-01','2026-09-30')
        self.assertEqual([item['days'] for item in options],[7,30])
        self.assertEqual(options[0]['start'],'2026-09-24')
        self.assertEqual(options[0]['baseline_end'],'2026-09-23')
        self.assertTrue(options[0]['baseline_available'])
        self.assertFalse(options[1]['baseline_available'])
        self.assertEqual([item['days'] for item in windows('2024-01-01','2024-06-28')],[7,30,90,180])
        self.assertEqual(windows('2024-02-01','2024-03-01')[1]['start'],'2024-02-01')
        self.assertEqual(windows('2025-12-01','2026-01-01')[0]['start'],'2025-12-26')
        self.assertEqual(windows('2026-01-01','2026-01-02'),[])
        with self.assertRaises(ValueError):windows('2026-01-02','2026-01-01')

    def test_cur_aliases_csv_gzip_parquet_and_conflicts(self):
        import pyarrow as pa, pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            for alias in ['lineItem/UsageStartDate','line_item_usage_start_date']:
                values=['2026-09-01T00:00:00Z','bad','2026-09-30T23:00:00Z']
                for ext in ['.csv','.csv.gz','.parquet']:
                    path=root/('dates'+ext)
                    if ext=='.parquet':pq.write_table(pa.table({alias:values}),path)
                    else:
                        raw=(alias+'\n'+'\n'.join(values)).encode()
                        path.write_bytes(gzip.compress(raw) if ext.endswith('.gz') else raw)
                    result=inspect(path)
                    self.assertEqual(result['status'],'available',result)
                    self.assertEqual((result['rows'],result['min_date'],result['max_date']),(3,'2026-09-01','2026-09-30'))
            path=root/'conflict.csv'
            path.write_text('lineItem/UsageStartDate,line_item_usage_start_date\n2026-09-01,2026-09-02',encoding='utf-8')
            self.assertEqual(inspect(path)['status'],'unavailable')
            path.write_text('x,y\n1,2',encoding='utf-8')
            self.assertEqual(inspect(path)['status'],'unavailable')

if __name__=='__main__':unittest.main()
