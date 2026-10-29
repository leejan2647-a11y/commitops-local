"""Local job/persistence adapter for the main canonical Teams History engine."""
import hashlib,json
from datetime import date,datetime,timezone
from pathlib import Path
from uuid import uuid4
from app.core.resources import analysis_connection
from app.pipeline.teams_history import build_ledger


def root_for(con):return Path(con.execute('PRAGMA database_list').fetchone()[2]).parent

def load(con,identifier):
 row=con.execute('SELECT document FROM local_history_reports WHERE id=?',(identifier,)).fetchone()
 if not row:raise ValueError('History report unavailable')
 return json.loads(row[0])

def public(doc):return {k:v for k,v in doc.items() if not k.startswith('_')}

def accept(con,value,key):
 import manual_api
 if not isinstance(key,str) or not key or len(key)>128:raise ValueError('A submission identity is required')
 existing=con.execute('SELECT document FROM local_history_reports WHERE json_extract(document,\'$._key\')=?',(key,)).fetchone()
 if existing:
  doc=json.loads(existing[0])
  if doc['_request']!=value:raise ValueError('Submission identity already used with different inputs')
  return public(doc)
 selected=value.get('check_ids')
 if selected is None:selected=[r[0] for r in con.execute("SELECT r.id FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id WHERE r.status='completed' AND COALESCE(f.archived,0)=0 ORDER BY r.created,r.id")]
 if not isinstance(selected,list) or not selected or len(set(selected))!=len(selected):raise ValueError('Select distinct completed checks')
 start=date.fromisoformat(value['start']) if value.get('start') else None;end=date.fromisoformat(value['end']) if value.get('end') else None
 if start and end and start>end:raise ValueError('Invalid history period')
 scopes=[];sources={};root=root_for(con)
 for identifier in selected:
  run=manual_api.load(con,identifier)
  if run['status']!='completed' or run['archived']:raise ValueError('A selected check is unavailable')
  w=run['result']['window'];a=max(date.fromisoformat(w['start']),start) if start else date.fromisoformat(w['start']);b=min(date.fromisoformat(w['end']),end) if end else date.fromisoformat(w['end'])
  if a>b:continue
  paths=[]
  for source in run['result'].get('input_files',[]):
   if source['role']!='primary':continue
   row=con.execute('SELECT data FROM uploads WHERE id=?',(source['id'],)).fetchone()
   if not row:raise ValueError('Original files missing; upload and check them again')
   saved=json.loads(row[0]);p=Path(saved['path'])
   if p.is_symlink() or p.resolve().parent!=(root/'uploads').resolve() or saved['sha256']!=source['sha256']:raise ValueError('Original file identity changed')
   paths.append(str(p));sources[str(p)]={'sha256':source['sha256'],'bytes':saved['bytes']}
  if not paths:raise ValueError('Original sources unavailable')
  scopes.append({'check_id':identifier,'start':str(a),'end':str(b),'sources':paths})
 if not scopes:raise ValueError('No selected check overlaps this period')
 identifier=str(uuid4());stamp=datetime.now(timezone.utc).isoformat();token=str(uuid4())
 doc={'id':identifier,'status':'queued','created_at':stamp,'updated_at':stamp,'check_ids':selected,'start':str(start) if start else None,'end':str(end) if end else None,'coverage':{'observed_start':None,'observed_end':None,'observed_dates':[],'check_count':len(scopes)},'excluded_checks':[],'reasons':[],'total_cents':None,'currency':None,'basis':'unblended','root_scope_id':token,'recovery':None,'_scopes':scopes,'_sources':sources,'_tokens':{token:[]},'_key':key,'_request':value}
 con.execute('INSERT INTO local_history_reports VALUES (?,?,?)',(identifier,stamp,json.dumps(doc)))
 return public(doc)

def build(root,identifier):
 from local_app import database,deny_outbound
 from local_hardware import budget
 deny_outbound()
 with database(root) as con:
  doc=load(con,identifier);doc['status']='running';con.execute('UPDATE local_history_reports SET document=? WHERE id=?',(json.dumps(doc),identifier))
 target=root/'history'/(identifier+'.parquet')
 try:
  for path,proof in doc['_sources'].items():
   p=Path(path)
   if p.is_symlink() or p.resolve().parent!=(root/'uploads').resolve() or p.stat().st_size!=proof['bytes']:raise ValueError('Source changed')
   with p.open('rb') as stream:
    if hashlib.file_digest(stream,'sha256').hexdigest()!=proof['sha256']:raise ValueError('Source changed')
  resource=budget(root)
  result=build_ledger(list(doc['_sources']),target,scopes=doc['_scopes'],memory_limit=str(resource['duckdb_memory_bytes'])+'B',threads=resource['cpu_threads'],spill_limit=str(resource['spill_bytes'])+'B')
  doc.update(status='ready' if result['status']=='available' else 'unavailable',total_cents=result['total_cents'],currency=result['currency'],reasons=[r['message'] for r in result.get('reasons',[])],_digest=result.get('artifact_sha256'))
  doc['coverage'].update({k:result[k] for k in ('observed_start','observed_end','observed_dates')})
 except Exception:
  doc.update(status='failed',reasons=['Retained source verification or local history processing failed.'],recovery='Restore original files or run a new manual check. Check free memory and disk.')
 doc['updated_at']=datetime.now(timezone.utc).isoformat()
 with database(root) as con:
  old=load(con,identifier)
  if old['status']!='cancelled':con.execute('UPDATE local_history_reports SET document=? WHERE id=?',(json.dumps(doc),identifier))

def breakdown(con,identifier,q):
 doc=load(con,identifier)
 if doc['status']!='ready':raise ValueError('History is not ready')
 group=q.get('group_by','teams');sort=q.get('sort','amount_desc');offset=int(q.get('offset',0));limit=int(q.get('limit',100))
 definitions={'teams':(['team_key','team_label'],'team_label'),'accounts':(['account_id'],"coalesce(nullif(account_id,''),'Unknown account')"),'services':(['service'],"coalesce(nullif(service,''),'Unknown service')"),'resources':(['account_id','service','region','resource_id'],"coalesce(nullif(resource_id,''),'Unattributed charges')"),'principals':(['account_id','principal_arn'],"coalesce(nullif(principal_arn,''),'No supplied IAM identity')")}
 orders={'amount_desc':'amount_cents DESC','amount_asc':'amount_cents ASC','name':'label ASC'}
 if group not in definitions or sort not in orders or offset<0 or not 1<=limit<=1000:raise ValueError('Invalid history query')
 scope=q.get('scope_id') or doc['root_scope_id'];criteria=doc['_tokens'].get(scope)
 if criteria is None:raise ValueError('Unknown history scope')
 clauses=[];params=[]
 for criterion in criteria:
  for key,val in criterion.items():
   if key not in {'team_key','account_id','service','region','resource_id','principal_arn'}:raise ValueError('Invalid scope')
   clauses.append(key+'=?');params.append(val)
 where=' AND '.join(clauses) or 'TRUE';fields,label=definitions[group];columns=','.join(fields);path=root_for(con)/'history'/(identifier+'.parquet')
 if path.is_symlink():raise ValueError('History artifact changed')
 with path.open('rb') as stream:
  if hashlib.file_digest(stream,'sha256').hexdigest()!=doc['_digest']:raise ValueError('History artifact changed; rebuild it')
 with analysis_connection() as db:
  db.execute('CREATE TABLE team_map(account_id VARCHAR,team_key VARCHAR,team_label VARCHAR)')
  mappings=list(con.execute('SELECT account,team FROM mappings'))
  if mappings:db.executemany('INSERT INTO team_map VALUES (?,?,?)',[(a,'named:'+b,b) for a,b in mappings])
  db.read_parquet(str(path)).create_view('ledger')
  db.execute("CREATE VIEW history AS SELECT l.*,coalesce(t.team_key,'unmapped:') AS team_key,coalesce(t.team_label,'Unassigned') AS team_label FROM ledger l LEFT JOIN team_map t USING(account_id)")
  total=int(db.execute('SELECT coalesce(sum(amount_cents),0) FROM history WHERE '+where,params).fetchone()[0])
  cte=f'WITH scoped AS (SELECT * FROM history WHERE {where}), grouped AS (SELECT {columns},{label} AS label,sum(amount_cents)::BIGINT AS amount_cents,list_distinct(list(account_id)) AS account_ids FROM scoped GROUP BY {columns}) '
  search=q.get('search','');count=db.execute(cte+'SELECT count(*) FROM grouped WHERE strpos(lower(label),lower(?))>0',params+[search]).fetchone()[0]
  cursor=db.execute(cte+'SELECT * FROM grouped WHERE strpos(lower(label),lower(?))>0 ORDER BY '+orders[sort]+','+columns+' LIMIT ? OFFSET ?',params+[search,limit,offset]);names=[r[0] for r in cursor.description];rows=[]
  groups=[dict(zip(names,values)) for values in cursor.fetchall()]
  page_aliases={}
  if group=='resources' and len(groups)>3:
   db.execute('CREATE TABLE alias_page(page_index INTEGER,account_id VARCHAR,service VARCHAR,region VARCHAR,resource_id VARCHAR)')
   db.executemany('INSERT INTO alias_page VALUES (?,?,?,?,?)',[(index,item['account_id'],item['service'],item['region'],item['resource_id']) for index,item in enumerate(groups)])
   observations=db.execute("WITH observations AS (SELECT page_index,date,unnest(names) AS alias FROM history JOIN alias_page USING(account_id,service,region,resource_id) WHERE "+where+"), grouped AS (SELECT page_index,alias,min(date) AS first,max(date) AS last FROM observations GROUP BY page_index,alias) SELECT * FROM grouped QUALIFY row_number() OVER(PARTITION BY page_index ORDER BY alias)<=101 ORDER BY page_index,alias",params).fetchall()
   for index,name,first,last in observations:
    page_aliases.setdefault(index,[]).append({'name':name,'start':str(first),'end':str(last)})
  for index,item in enumerate(groups):
   child=criteria+[{k:item[k] for k in fields if k!='team_label'}];token=next((k for k,v in doc['_tokens'].items() if v==child),None) or str(uuid4());doc['_tokens'][token]=child
   aliases=page_aliases.get(index,[])
   if group=='resources' and len(groups)<=3:
    filters=' AND '.join(k+'=?' for k in ('account_id','service','region','resource_id'))
    observations=db.execute("WITH x AS (SELECT date,unnest(names) AS name FROM history WHERE "+where+' AND '+filters+") SELECT name,min(date),max(date) FROM x GROUP BY name ORDER BY name LIMIT 101",params+[item[k] for k in ('account_id','service','region','resource_id')]).fetchall()
    aliases=[{'name':n,'start':str(start),'end':str(end)} for n,start,end in observations]
   finding_ids=[]
   rows.append({**item,'scope_id':token,'percent':round(item['amount_cents']*100/total,4) if total>0 else None,'names':[a['name'] for a in aliases[:100]],'aliases':aliases[:100],'aliases_has_more':len(aliases)>100,'finding_ids':finding_ids})

 # Read each check and its labels once per page, then route findings to page
 # groups. Retain at most the existing 100 associations per displayed row;
 # do not keep a cross-request cache that could hide edited state or sources.
 if group in {'teams','accounts','services'} and not any(set(c)&{'resource_id','principal_arn','region'} for c in criteria):
  import manual_api
  by_account={}
  for index,row in enumerate(rows):
   for account in row['account_ids']:by_account.setdefault(account,[]).append(index)
  services=[c['service'] for c in criteria if 'service' in c]
  if rows:
   for check_id in doc['check_ids']:
    run=manual_api.load(con,check_id)
    for finding in manual_api.findings(con,run):
     if any(finding['service']!=service for service in services):continue
     for index in by_account.get(finding['aws_account_id'],[]):
      row=rows[index]
      if group=='services' and finding['service']!=row['service']:continue
      if len(row['finding_ids'])<100:row['finding_ids'].append(finding['id'])

 con.execute('UPDATE local_history_reports SET document=? WHERE id=?',(json.dumps(doc),identifier))
 return {'report_id':identifier,'group_by':group,'scope_id':scope,'rows':rows,'total_cents':total,'count':count,'offset':offset,'limit':limit,'has_more':offset+len(rows)<count,'coverage':doc['coverage'],'reasons':doc['reasons']}
