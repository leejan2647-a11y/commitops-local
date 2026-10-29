"""Small, bounded hardware observation; never a maximum-capacity certification."""
import sys,json,time,tempfile,hashlib,multiprocessing,os
from pathlib import Path
from datetime import date,timedelta
from decimal import Decimal
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import psutil

def worker(path,target,threads):
 import local_hardware
 if threads:local_hardware.threads=lambda:threads
 from local_analysis import analyse
 file={'id':'00000000-0000-4000-8000-000000000001','path':str(path),'name':path.name,'role':'primary','bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
 start=time.perf_counter();result=analyse({'files':['00000000-0000-4000-8000-000000000001'],'start':'2026-09-01','end':'2026-09-30','baseline_start':'2026-08-01','baseline_end':'2026-08-31','_settings':{'creepMonthlyGrowthPercent':'20'}},{'00000000-0000-4000-8000-000000000001':file},{})
 Path(target).write_text(json.dumps({'elapsed_seconds':time.perf_counter()-start,'total_cents':result['validation']['window_total_cents'],'budget':result['resource_budget']}))

def main():
 from fixture import _row,write_cur_csv
 receipt=[]
 with tempfile.TemporaryDirectory() as directory:
  root=Path(directory);path=root/'bounded.csv';rows=[]
  for i in range(5000):
   r=_row(row_id=str(i),day=date(2026,9,1)+timedelta(days=i%30),account='111111111111',region='us-east-1',service='AmazonEC2',usage_type='BoxUsage',operation='RunInstances',cost=Decimal('0.01'),usage=Decimal(1));rows.append(r)
  write_cur_csv(rows,path);del rows
  for label,threads in [('one_thread',1),('available_threads',None)]:
   target=root/(label+'.json');p=multiprocessing.get_context('spawn').Process(target=worker,args=(path,target,threads));p.start();process=psutil.Process(p.pid);peak=0;cpu=0;io={};started=time.monotonic()
   while p.is_alive():
    try:
     rss=process.memory_info().rss;peak=max(peak,rss);times=process.cpu_times();cpu=max(cpu,times.user+times.system);c=process.io_counters();io={'read_bytes':c.read_bytes,'write_bytes':c.write_bytes}
     if time.monotonic()-started>45 or psutil.virtual_memory().available<512*1024**2:
      reason='time_limit' if time.monotonic()-started>45 else 'available_memory_below_512MiB'
      p.terminate();p.join()
      receipt.append({'mode':label,'status':'stopped','reason':reason,'wall_seconds':time.monotonic()-started,'peak_rss_bytes':peak,'cpu_seconds_sampled':cpu,'disk_io_sampled':io})
      print(json.dumps(receipt,indent=2));return
    except psutil.NoSuchProcess:break
    time.sleep(.05)
   p.join();assert p.exitcode==0
   result=json.loads(target.read_text());assert result['total_cents']==5000
   receipt.append({'mode':label,'input_bytes':path.stat().st_size,'rows':5000,'peak_rss_bytes':peak,'cpu_seconds_sampled':cpu,'average_cpu_percent_one_core':round(cpu/result['elapsed_seconds']*100,2),'disk_io_sampled':io,**result})
 print(json.dumps(receipt,indent=2))
if __name__=='__main__':main()
