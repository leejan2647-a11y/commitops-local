import sys,tempfile,unittest,json,hashlib
from pathlib import Path
from datetime import date,timedelta
from decimal import Decimal
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from fixture import _row,write_cur_csv
from local_analysis import analyse
from local_app import initialise,database
import manual_api

class MainManualContractTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name);initialise(cls.root)
  rows=[_row(row_id=str(i),day=date(2026,9,1)+timedelta(days=i),account='111111111111',region='us-east-1',service=['AmazonEC2','AmazonS3','AmazonRDS','AmazonDynamoDB','AmazonEKS','AmazonCloudWatch'][i%6],usage_type='BoxUsage',operation='RunInstances',cost=Decimal('1.005'),usage=Decimal(24)) for i in range(30)]
  from fixture import CUR_COLUMNS
  if 'tags/user:Name' not in CUR_COLUMNS:CUR_COLUMNS.append('tags/user:Name')
  for index,row in enumerate(rows):
   row['lineItem/UnblendedCost']='1.005'
   row['tags/user:Name']='Resource '+str(index%6)
  cls.uid=str(uuid4());cls.rid=str(uuid4());p=cls.root/'uploads'/(cls.uid+'.csv');write_cur_csv(rows,p)
  cls.file={'id':cls.uid,'name':'test.csv','path':str(p),'role':'primary','sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
  cls.result=analyse({'files':[cls.uid],'start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-08-01','baseline_end':'2026-08-31'},{cls.uid:cls.file},{})
  with database(cls.root) as con:
   con.execute('INSERT INTO runs VALUES (?,?,?,?)',(cls.rid,'completed',json.dumps(cls.result),'2026-10-28T00:00:00+00:00'));con.execute('INSERT INTO uploads VALUES (?,?)',(cls.uid,json.dumps(cls.file)))
 @classmethod
 def tearDownClass(cls):cls.temp.cleanup()
 def test_read_contracts_and_exact_money(self):
  with database(self.root) as c:
   for path in ['/checks','/checks/'+self.rid,'/checks/'+self.rid+'/status','/checks/'+self.rid+'/allocation','/findings','/commitments','/dashboard/summary','/dashboard/spend-history','/dashboard/growth','/uploads','/reports','/teams','/settings/tenant']:
    with self.subTest(path=path):
     result=manual_api.read(c,path,{'check':self.rid});json.dumps(result,allow_nan=False)
   self.assertEqual(manual_api.read(c,'/dashboard/summary',{})['total_spend_cents'],3015)
   self.assertEqual(manual_api.read(c,'/dashboard/spend-history',{'check':self.rid})['total_cents'],3015)
 def test_canonical_history(self):
  import manual_history
  with database(self.root) as c:
   other=str(uuid4())
   c.execute('INSERT INTO runs VALUES (?,?,?,?)',(other,'completed',json.dumps(self.result),'2026-10-28T00:00:01+00:00'))
   report=manual_history.accept(c,{'check_ids':[self.rid,other]},'history-test')
  # Run in a child so its outbound-network prohibition stays isolated.
  import multiprocessing
  worker=multiprocessing.get_context('spawn').Process(target=manual_history.build,args=(self.root,report['id']))
  worker.start();worker.join(30);self.assertFalse(worker.is_alive());self.assertEqual(worker.exitcode,0)
  with database(self.root) as c:
   saved=manual_history.load(c,report['id']);self.assertEqual(saved['status'],'ready',saved['reasons']);self.assertEqual(saved['total_cents'],3015)
   result=manual_history.breakdown(c,report['id'],{'group_by':'accounts'})
   self.assertEqual(result['rows'][0]['amount_cents'],3015)
   from unittest.mock import patch
   statements=[];c.set_trace_callback(statements.append)
   with patch('manual_api.load',wraps=manual_api.load) as reads:
    service_page=manual_history.breakdown(c,report['id'],{'group_by':'services'})
    self.assertGreaterEqual(len(service_page['rows']),2)
    self.assertEqual(reads.call_count,2)
   self.assertEqual(sum('FROM local_labels WHERE run_id=' in sql for sql in statements),2)
   c.set_trace_callback(None)
   for group in ['teams','services','resources','principals']:

    result=manual_history.breakdown(c,report['id'],{'group_by':group})
    self.assertEqual(sum(r['amount_cents'] for r in result['rows']),3015)
   batch=manual_history.breakdown(c,report['id'],{'group_by':'resources'})
   self.assertGreater(len(batch['rows']),3)
   for index,row in enumerate(batch['rows']):
    scalar=manual_history.breakdown(c,report['id'],{'group_by':'resources','offset':str(index),'limit':'1'})['rows'][0]
    self.assertTrue(row['aliases'])
    self.assertEqual(row['aliases'],scalar['aliases'])
    self.assertEqual(row['amount_cents'],scalar['amount_cents'])
   # Workflow-only finding fixture; it contributes no monetary evidence to history.
   review_id='00000000-0000-4000-8000-000000000099';first='review-only'
   review={'findings':[{'id':first,'type':'new-charge','severity':'low','service':'AmazonEC2','title':'Review fixture','description':'Nonfinancial annotation fixture'}]}
   c.execute('INSERT INTO runs VALUES (?,?,?,?)',(review_id,'completed',json.dumps(review),'2026-10-28T00:00:02+00:00'))
   try:
    c.execute('INSERT INTO local_labels VALUES (?,?,?,?)',('label-one',review_id,first,'Reviewed'))
    rendered=manual_api.findings(c,manual_api.load(c,review_id))
    self.assertEqual(rendered[0]['labels'][0]['label'],'Reviewed')
    c.execute('DELETE FROM local_labels WHERE id=?',('label-one',))
    rendered=manual_api.findings(c,manual_api.load(c,review_id))
    self.assertFalse(rendered[0]['labels'])
   finally:
    # This annotation-only row must not become the next test's latest check.
    c.execute('DELETE FROM local_labels WHERE run_id=?',(review_id,))
    c.execute('DELETE FROM runs WHERE id=?',(review_id,))
   manual_api.mutate(c,'/teams','POST',{'aws_account_id':'111111111111','name':'History test'})
   self.assertEqual(manual_history.load(c,report['id'])['status'],'stale')
   manual_api.mutate(c,'/teams/111111111111','DELETE',{})
 def test_team_settings_reports(self):
  with database(self.root) as c:
   manual_api.mutate(c,'/teams','POST',{'aws_account_id':'111111111111','name':'Platform'})
   self.assertEqual(manual_api.read(c,'/teams',{})[0]['name'],'Platform')
   manual_api.mutate(c,'/teams/111111111111','PATCH',{'name':'Ops'})
   self.assertEqual(manual_api.read(c,'/teams',{})[0]['name'],'Ops')
   manual_api.mutate(c,'/teams/111111111111','DELETE',{})
   self.assertEqual(manual_api.read(c,'/teams',{}),[])
   saved=manual_api.mutate(c,'/reports','POST',{'name':'Review','config':{'check_ids':[self.rid]}})
   self.assertEqual(manual_api.read(c,'/reports/'+saved['id']+'/download',{})['check_count'],1)
   html=manual_api.read(c,'/reports/'+saved['id']+'/print.html',{})
   self.assertIn('3015 cents',html)
   self.assertNotIn(str(self.root),html)
   with self.assertRaises(ValueError):manual_api.mutate(c,'/schedules','POST',{})

if __name__=='__main__':unittest.main()
