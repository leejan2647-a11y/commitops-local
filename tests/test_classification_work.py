import sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import duckdb
from app.pipeline import canonical
class ClassificationWorkTests(unittest.TestCase):
 def test_small_population_uses_one_partition_and_wide_or_large_keeps_existing_bound(self):
  with duckdb.connect(':memory:') as con:
   con.execute('CREATE TABLE _commitops_raw(_commitops_payload VARCHAR,_commitops_occurrence BIGINT)')
   con.execute("INSERT INTO _commitops_raw VALUES ('small',0)")
   self.assertEqual(canonical._classification_bucket_count(con,1),1)
   self.assertEqual(canonical._classification_bucket_count(con,1025),canonical.CLASSIFICATION_BUCKETS)
   with patch.object(canonical,'PAYLOAD_STAGE_BYTES',4):
    self.assertEqual(canonical._classification_bucket_count(con,1),canonical.CLASSIFICATION_BUCKETS)
   with patch.object(canonical,'CLASSIFICATION_BUCKETS',1):
    self.assertEqual(canonical._classification_bucket_count(con,1025),1)
if __name__=='__main__':unittest.main()
