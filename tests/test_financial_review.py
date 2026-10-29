"""Small independent ledgers for local signed charges and comparison scope."""
import sys, tempfile, unittest, hashlib
from pathlib import Path
from uuid import uuid4
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from local_analysis import analyse
from fixture import _row, write_cur_csv, write_cur_gz, write_cur_parquet, CUR_COLUMNS

class FinancialReviewTests(unittest.TestCase):
    def test_signed_money_rounding_duplicates_formats_and_explicit_baseline(self):
        rows=[]
        def row(identifier,day,charge,kind='Usage'):
            value=_row(row_id=identifier,day=day,account='111111111111',region='us-east-1',service='AmazonEC2',usage_type='BoxUsage',operation='RunInstances',cost=Decimal('0'),usage=Decimal('24'))
            value['lineItem/UnblendedCost']=charge;value['lineItem/LineItemType']=kind
            value['bill/PayerAccountId']='999999999999'
            value['bill/BillingPeriodEndDate']=((day.replace(day=28)+timedelta(days=4)).replace(day=1)).isoformat()
            return value
        for index in range(30):rows.append(row('primary-'+str(index),date(2026,9,1)+timedelta(days=index),'1.005'))
        for index,(charge,kind) in enumerate([('-2.225','Credit'),('3.999','Fee'),('-1.005','Refund')]):rows.append(row('adjustment-'+str(index),date(2026,9,15),charge,kind))
        expected=int((sum(Decimal(r['lineItem/UnblendedCost']) for r in rows)*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
        self.assertEqual(expected,3092)  # Independent ledger: 30.15 - 2.225 + 3.999 - 1.005 = 30.919.
        history=[row('old-'+str(i),date(2026,8,1)+timedelta(days=i),'100.00') for i in range(31)]
        if 'bill/PayerAccountId' not in CUR_COLUMNS:CUR_COLUMNS.append('bill/PayerAccountId')
        request={'start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-08-01','baseline_end':'2026-08-31'}
        with tempfile.TemporaryDirectory() as directory:
            for ext,writer in [('.csv',write_cur_csv),('.csv.gz',write_cur_gz),('.parquet',write_cur_parquet)]:
                files={}
                for name,values,role in [('current',rows+rows[:3],'primary'),('prior',history,'comparison')]:
                    p=Path(directory)/(name+ext);writer(values,p);identifier=str(uuid4());files[identifier]={'id':identifier,'name':p.name,'path':str(p),'role':role,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
                output=analyse({**request,'files':list(files)},files,{})
                self.assertEqual(output['validation']['window_total_cents'],expected)
                self.assertEqual(output['validation']['duplicate_rows'],3)
                self.assertEqual([f['role'] for f in output['input_files']].count('comparison'),1)
                with self.assertRaises(ValueError):analyse({**request,'files':list(files),'expectations':[{'service':'EC2','amount':'NaN'}]},files,{})

if __name__=='__main__':unittest.main()
