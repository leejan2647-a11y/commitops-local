"""Run in separate processes against exported and original engine module roots.

The verification operator supplies ENGINE_ROOT; this helper is not in the npm tarball.
"""
import hashlib
import json
import os
import sys
import types
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
sys.path.insert(0, os.environ['ENGINE_ROOT'])
# Keep original-engine verification independent of hosted settings/auth/database.
import duckdb
resources = types.ModuleType('app.core.resources')
resources.analysis_connection = lambda: duckdb.connect(config={'threads':1,'memory_limit':'256MB','autoinstall_known_extensions':False,'autoload_known_extensions':False})
sys.modules['app.core.resources'] = resources
from app.pipeline import ingest
ingest._install_extensions = lambda con: None
from app.pipeline.run import run_check
from app.pipeline.types import DataWindow, ServiceExpectation
from app.growth.contracts import GrowthSource
from local_analysis import serial
from fixture import CUR_COLUMNS, build_cur_rows, write_cur_csv

target = Path(os.environ['PARITY_FIXTURE'])
if not target.exists():
    rows = build_cur_rows(with_duplicates=8)
    if 'bill/PayerAccountId' not in CUR_COLUMNS: CUR_COLUMNS.append('bill/PayerAccountId')
    for row in rows:
        row['bill/PayerAccountId'] = '999999999999'
        month = date.fromisoformat(row['bill/BillingPeriodStartDate'])
        row['bill/BillingPeriodEndDate'] = ((month.replace(day=28)+timedelta(days=4)).replace(day=1)).isoformat()
    write_cur_csv(rows,target)
source = GrowthSource(ordinal=0, upload_id='11111111-1111-4111-8111-111111111111',filename='synthetic.csv',sha256=hashlib.sha256(target.read_bytes()).hexdigest(),role='primary')
result = run_check(str(target),DataWindow(date(2024,8,25),date(2024,9,24),date(2024,4,1),date(2024,8,24)), 'local',expectations=[ServiceExpectation('AmazonCloudFront','agreed',100)],as_of=date(2024,10,26),growth_sources=[source],growth_as_of=datetime(2024,10,26,tzinfo=timezone.utc))
def scrub(value):
    if isinstance(value,dict): return {key:scrub(item) for key,item in value.items() if key not in {'observation_id','comparison_id','captured_at','generated_at','detected_at'}}
    if isinstance(value,list): return [scrub(item) for item in value]
    return value
print(json.dumps(scrub(serial(result)),sort_keys=True,separators=(',',':')))
