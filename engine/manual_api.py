"""Main manual API contracts over local SQLite; no hosted or automatic integrations."""
import csv
import io
import json
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace as NS
from uuid import uuid4, uuid5, NAMESPACE_URL, UUID
import manual_settings, manual_store
from app.services import commitment_measurements as cm
from app.services.local_commitment_projection import allocation_out, _plan_out, _family_limits
from app.services import spend_history


def now(): return datetime.now(timezone.utc).isoformat()

def initialise(con):
    con.executescript('''CREATE TABLE IF NOT EXISTS local_labels(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),finding_id TEXT NOT NULL,label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_submissions(key TEXT PRIMARY KEY,request TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id));
    CREATE INDEX IF NOT EXISTS local_labels_run ON local_labels(run_id,finding_id);
    CREATE TABLE IF NOT EXISTS local_history_reports(id TEXT PRIMARY KEY,created TEXT NOT NULL,document TEXT NOT NULL);''')


def load(con, identifier):
    row=con.execute('SELECT r.id,r.status,r.created,r.result,COALESCE(f.archived,0) FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id WHERE r.id=?',(identifier,)).fetchone()
    if not row: raise ValueError('Check unavailable')
    return {'id':row[0],'status':row[1],'created':row[2],'result':json.loads(row[3] or '{}'),'archived':bool(row[4])}


def latest(con):
    row=con.execute("SELECT r.id FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id WHERE r.status='completed' AND COALESCE(f.archived,0)=0 ORDER BY r.created DESC,r.id DESC LIMIT 1").fetchone()
    return load(con,row[0]) if row else None


def validation(run):
    r=run['result'];v=r.get('validation') or {}
    def camel(s):
        head,*tail=s.split('_');return head+''.join(x.title() for x in tail)
    out={camel(k):v for k,v in v.items()}
    out['currencyProof']=r.get('currency_proof',{})
    out['schemaOk']=not v.get('missing_required')
    out['savingsPlanMeasurements']=r.get('sp_assessment',{})
    out['reservedInstanceMeasurements']=r.get('ri_assessment',{})
    return out


def check_object(run):
    w=run['result'].get('window') or {}
    return NS(id=run['id'],window_start=date.fromisoformat(w['start']) if w.get('start') else None,window_end=date.fromisoformat(w['end']) if w.get('end') else None,validation_report=validation(run),allocation_json=run['result'].get('allocation'),created_at=datetime.fromisoformat(run['created']))


def assessments(run):
    return cm.unique_reasons([reason for key in ('sp_assessment','ri_assessment') for reason in run['result'].get(key,{}).get('reasons',[])])


def plans(run):
    return [NS(**{**p,'id':uuid5(NAMESPACE_URL,run['id']+':'+p['id']),'check_id':UUID(run['id']),'category':p['type'],'amount_cents':p['purchased_cents']}) for p in run['result'].get('commitments',[])]


def findings(con,run):
    if run['status']!='completed':return []
    updates=manual_store.updates(con,run['id']);teams=dict(con.execute('SELECT account,team FROM mappings'));output=[]
    labels=defaultdict(list)
    for finding_id,label_id,label in con.execute('SELECT finding_id,id,label FROM local_labels WHERE run_id=?',(run['id'],)):
        labels[finding_id].append((label_id,label))
    for item in run['result'].get('findings',[]):
        fid=run['id']+':'+item['id'];u=updates.get(item['id'],{});e=item.get('evidence') or {};rows=[]
        for i,row in enumerate(e.get('top_line_items',[])):
            rows.append({'id':str(i),'finding_id':fid,'row_reference':str(row.get('row_reference',row.get('rowReference',row.get('line_item_id',i)))),'amount_cents':row.get('amount_cents',row.get('contribution_cents')),'raw_cost_cents':row.get('raw_cost_cents'),'usage_date':row.get('usage_date')})
        m=item.get('amount_measurement');impact=m.get('value_cents') if m else None
        output.append({**item,'id':fid,'detector_type':item['type'],'subject':item.get('service') or item['title'],'impact_cents':impact,'amount_measurement':m,'impact_basis':(m or {}).get('basis'),'evidence_total_cents':int(Decimal(e['evidence_total'])*100) if e.get('evidence_total') is not None else None,'evidence':rows,'evidence_measurement':None,'attribution':item.get('stats',{}).get('resourceAttribution'),'aws_account_id':item.get('account') or None,'team_name':teams.get(item.get('account')),'check_id':run['id'],'check_created_at':run['created'],'check_window_start':run['result'].get('window',{}).get('start'),'check_window_end':run['result'].get('window',{}).get('end'),'state':{'finding_id':fid,'status':'archived' if u.get('archived') else u.get('status','open'),'note':u.get('note',''),'updated_at':run['created']},'labels':[{'id':a,'finding_id':fid,'label':b,'created_at':run['created']} for a,b in labels[item['id']]]})
    return output


def summary(run):
    w=run['result'].get('window') or {}
    return {'id':run['id'],'status':'failed' if run['status']=='interrupted' else run['status'],'created_at':run['created'],'window_start':w.get('start'),'window_end':w.get('end'),'findings_count':len(run['result'].get('findings',[])),'archived_at':run['created'] if run['archived'] else None,'total_impact_cents':None,'commitment_assessments':assessments(run)}


def page(items,q):
    offset=int(q.get('offset','0'));limit=int(q.get('limit','100'))
    if offset<0 or not 1<=limit<=1000:raise ValueError('Invalid page')
    part=items[offset:offset+limit]
    return {'items':part,'total':len(items),'offset':offset,'limit':limit,'returned':len(part),'has_more':offset+len(part)<len(items)}


def commitment_response(con,run,aggregate=False):
    selected=[run] if run else []
    if aggregate:selected=[load(con,r[0]) for r in con.execute("SELECT r.id FROM runs r LEFT JOIN run_flags f ON f.run_id=r.id WHERE status='completed' AND COALESCE(f.archived,0)=0")]
    rows=[p for r in selected for p in plans(r)];checks={UUID(r['id']):check_object(r) for r in selected};a=cm.unique_reasons([v for r in selected for v in assessments(r)])
    families=cm.family_totals(rows,history=aggregate,checks=checks,assessment=a);total=_family_limits(cm.totals(rows,history=aggregate,checks=checks),a)
    allocation=allocation_out(check_object(run),rows,a) if run and not aggregate else {'total_unused_cents':None,'by_category':{},'assessment':a,'non_derivable_categories':[]}
    teams=[]
    for account,name in con.execute('SELECT account,team FROM mappings'):
        group=[r for r in rows if r.account==account]
        if not group:continue
        t=_family_limits(cm.totals(group,history=aggregate,checks=checks),a)
        teams.append({'name':name,'accounts':[account],'committed_cents':t['purchased'],'used_cents':t['used'],'remaining_cents':t['unused'],'waste_cents':t['unused'],'utilisation_pct':t['utilization_pct'],'assessment':t['reasons']})
    return {'check_id':run['id'] if run and not aggregate else None,'mode':'aggregate' if aggregate else 'check','commitments':[_plan_out(p,checks[p.check_id]).model_dump(mode='json') for p in rows],'trend':[],'breakdown':allocation,'teams':teams,'assessment':a,'totals':total,'family_totals':families}


def growth(run):
    from app.growth.contracts import GrowthDashboardResponse,GrowthMonthObservation,GrowthPeriodView,GrowthUsageView,month_end,resolve_growth_periods
    from app.services.monthly_growth import choose_comparison,compare_months
    current=datetime.now(timezone.utc);response=GrowthDashboardResponse(check_id=run['id'],view_as_of=current,calculated_at=current)
    observations=[]
    for raw in (run['result'].get('monthly_growth') or {}).get('observations',[]):
        raw={**raw,'check_id':run['id'],'observation_id':str(uuid5(NAMESPACE_URL,run['id']+raw['month']+raw['role']))}
        observations.append(GrowthMonthObservation.model_validate(raw))
    periods=resolve_growth_periods(current);primary=[v for v in observations if v.role=='primary'];previous=[v for v in primary if v.month<periods.current]
    selected=([max(previous,key=lambda v:v.month)] if previous else [])+[v for v in primary if v.month==periods.current]
    for v in selected:
        baseline=choose_comparison(v,observations)
        comparison=compare_months(v,baseline)
        response.periods.append(GrowthPeriodView(observation_id=v.observation_id,check_id=run['id'],month=v.month,start=v.month,end=month_end(v.month),kind='current' if v.month==periods.current else 'previous' if v.month==periods.previous else 'historical',status=v.status,complete=v.complete,currency=v.currency,charge_cents=v.charge_cents,captured_at=v.captured_at,latest_source_at=v.latest_source_at,observed_days=v.observed_days,missing_days=v.missing_days,sources=v.sources,raw_rows=v.raw_rows,canonical_rows=v.canonical_rows,removed_copy_rows=v.removed_copy_rows,usage_group_count=v.usage_group_count,usage_observations=[GrowthUsageView(key=g.key,quantity=g.quantity,unit=g.key[7],valid=g.valid,source_upload_ids=[s.upload_id for s in v.sources if s.ordinal in g.source_ordinals]) for g in v.usage_samples],comparison=comparison,reasons=v.reasons))
    response.status='available' if response.periods else 'unavailable'
    return response.model_dump(mode='json')


def report_row(row):
    identifier,run_id,name,created,archived,document=row;doc=json.loads(document);ids=[r['check_id'] for r in doc.get('checks',[])] or [doc.get('check_id',run_id)]
    return {'id':identifier,'name':name,'created_at':created,'updated_at':created,'archived_at':created if archived else None,'config_json':{'check_ids':ids},'share_token':None,'share_created_at':None}


def read(con,path,q):
    if path=='/plan':return {'tier':'local','files_per_batch':-1,'files_per_day':-1,'files_per_day_used':0,'checks_per_day':-1,'checks_per_day_used':0,'lines_per_file':None,'max_file_bytes':None,'max_check_bytes':None,'upgrade_to':None,'pending_plan':None,'entitlement':{'state':'active','source':'local','starts_at':None,'ends_at':None,'reason':'Local workspace','recovery':''}}
    if path=='/settings/retention':return {'tier':'local','retention_days':None,'status':'preserved'}
    if path=='/settings/tenant':
        s=manual_settings.settings(con);return {'id':'local','name':s['name'],'settings':{k:v for k,v in s.items() if k!='name'}}
    if path=='/teams':return [{'id':a,'aws_account_id':a,'name':b} for a,b in con.execute('SELECT account,team FROM mappings ORDER BY team,account')]
    if path=='/uploads':
        items=[]
        for raw, in con.execute("SELECT data FROM uploads ORDER BY json_extract(data,'$.created') DESC,id DESC"):
            v=json.loads(raw);i=v.get('inspection') or {};item={'id':v['id'],'filename':v['name'],'size_bytes':v['bytes'],'row_count':i.get('rows'),'min_date':i.get('min_date'),'max_date':i.get('max_date'),'source':'baseline_only' if v['role']=='comparison' else 'manual','created_at':v.get('created',now()),'description':v.get('description')}
            item['origins']=v.get('origins', [])
            if q.get('search','').lower() not in item['filename'].lower():continue
            if q.get('known_dates')=='true' and not item['min_date']:continue
            if q.get('from') and item['max_date'] and item['max_date']<q['from']:continue
            if q.get('to') and item['min_date'] and item['min_date']>q['to']:continue
            items.append(item)
        result=page(items,q);return {**result,'uploads':result['items']}
    if path=='/checks':
        items=[summary(load(con,r[0])) for r in con.execute('SELECT id FROM runs ORDER BY created DESC,id DESC')]
        if q.get('include_archived')!='true':items=[r for r in items if not r['archived_at']]
        if q.get('status'):items=[r for r in items if r['status']==q['status']]
        return page(items,q)
    if path.startswith('/checks/'):
        parts=path.split('/');run=load(con,parts[2]);s=summary(run)
        if len(parts)==3:return {**s,'findings':findings(con,run),'validation_report':validation(run),'source_hash':None,'reconciliation_status':validation(run).get('reconciliationStatus')}
        if parts[3]=='status':return {'check_id':run['id'],'status':s['status'],'progress':100 if run['status']=='completed' else None,'current_step':'Analysing local files' if run['status']=='running' else None,'error':run['result'].get('error')}
        if parts[3]=='allocation':return allocation_out(check_object(run),plans(run),assessments(run))
        if parts[3]=='export.csv':
            out=io.StringIO();writer=csv.writer(out);writer.writerow(['detector','severity','title','impact_cents']);writer.writerows([[f['detector_type'],f['severity'],f['title'],f['impact_cents']] for f in findings(con,run)]);return out.getvalue()
    if path=='/findings':
        if q.get('all')=='1':runs=[load(con,r[0]) for r in con.execute("SELECT id FROM runs WHERE status='completed' ORDER BY created DESC")]
        else:r=load(con,q['check']) if q.get('check') else latest(con);runs=[r] if r else []
        runs=[r for r in runs if q.get('include_archived')=='true' or not r['archived']];items=[f for r in runs for f in findings(con,r)]
        for key in ('severity','detector_type'):
            if q.get(key):items=[f for f in items if f[key]==q[key]]
        if q.get('state'):items=[f for f in items if f['state']['status']==q['state']]
        if q.get('search'):items=[f for f in items if q['search'].lower() in (f['title']+' '+f['description']+' '+f['service']).lower()]
        return {**page(items,q),'assessments':cm.unique_reasons([a for r in runs for a in assessments(r)])}
    if path.startswith('/findings/'):
        run_id,fid=path.split('/')[2].split(':',1)
        return next(f for f in findings(con,load(con,run_id)) if f['id']==run_id+':'+fid)
    if path.startswith('/dashboard/') or path=='/commitments':
        run=load(con,q['check']) if q.get('check') else latest(con)
        if run and (run['status']!='completed' or run['archived']):raise ValueError('Choose a completed available check')
        if path=='/commitments':return commitment_response(con,run,q.get('aggregate')=='true')
        if path.endswith('/growth'):return growth(run) if run else None
        if path.endswith('/spend-history'):return spend_history.read(check_object(run)).model_dump(mode='json')
        fs=findings(con,run) if run else [];counts=Counter(f['severity'] for f in fs);service=Counter(f['service'] for f in fs if f['service']);v=validation(run) if run else {};cr=commitment_response(con,run)
        return {'check_id':run['id'] if run else None,'check_created_at':run['created'] if run else None,'window_start':(run['result'].get('window') or {}).get('start') if run else None,'window_end':(run['result'].get('window') or {}).get('end') if run else None,'total_spend_cents':v.get('windowTotalCents'),'active_findings':sum(f['state']['status'] not in ('resolved','archived') for f in fs),'unexpected_spend_cents':None,'unused_commitments_cents':cr['breakdown']['total_unused_cents'],'unexplained_remainder_cents':None,'findings_by_severity':dict(counts),'top_services':[{'service':k,'findings':v,'impact_cents':None} for k,v in service.most_common(5)],'commitment_family_totals':cr['family_totals'],'commitment_assessments':cr['assessment']}
    if path=='/reports':return [report_row(row) for row in con.execute('SELECT id,run_id,name,created,archived,document FROM local_reports ORDER BY created DESC')]
    if path.startswith('/reports/'):
        identifier=path.split('/')[2];doc=manual_settings.report(con,identifier);row=con.execute('SELECT id,run_id,name,created,archived,document FROM local_reports WHERE id=?',(identifier,)).fetchone();meta=report_row(row)
        if path.endswith('/print.html'):
            from local_report_render import render_document
            snapshots=doc.get('checks',[doc]);documents=[]
            for snapshot in snapshots:
                result=snapshot['result'];v=result.get('validation') or {};fs=result.get('findings',[])
                data={'outcome':'completed','check_id':snapshot['check_id'],'window':result.get('window',{}),'sources':[{**f,'filename':f['name']} for f in result.get('input_files',[])],'findings':[{**f,'detector':f['type'],'evidence':[]} for f in fs],'commitments':result.get('commitments',[]),'reported_charges_cents':v.get('window_total_cents'),'generated_at':now()}
                documents.append(render_document(data)['html'])
            return '\n'.join(documents)
        return {'report':meta,'generated_at':now(),'generated_by':'commitops','check_count':len(meta['config_json']['check_ids']),'checks':doc.get('checks',[doc]),'basis':'Immutable individual check snapshots; financial totals are not added across checks.'}
    if path.startswith('/allocation/history/reports'):
        import manual_history
        if path=='/allocation/history/reports':return {'reports':[manual_history.public(json.loads(row[0])) for row in con.execute('SELECT document FROM local_history_reports ORDER BY created DESC LIMIT 20')]}
        identifier=path.split('/')[4]
        if path.endswith('/breakdown'):return manual_history.breakdown(con,identifier,q)
        return manual_history.public(manual_history.load(con,identifier))
    raise ValueError('Unknown manual route')


def mutate(con,path,method,v):
    if path=='/settings/tenant':
        old=manual_settings.settings(con);manual_settings.save_settings(con,{**old,**v.get('settings',{}),**({'name':v['name']} if 'name'in v else {})});return read(con,path,{})
    if path=='/teams' or path.startswith('/teams/'):
        identifier=path.split('/')[-1];old=con.execute('SELECT team FROM mappings WHERE account=?',(identifier,)).fetchone();account=v.get('aws_account_id',identifier)
        manual_settings.save_team(con,{'action':'delete' if method=='DELETE' else 'add' if path=='/teams' else 'edit','account':account,'previous_account':identifier,'name':v.get('name',old[0] if old else None)})
        con.execute("UPDATE local_history_reports SET document=json_set(document,'$.status','stale','$.recovery','Team mappings changed. Rebuild history to refresh drilldown scopes.') WHERE json_extract(document,'$.status')='ready'")
        return {'id':account,'aws_account_id':account,'name':v.get('name')}
    if path.startswith('/checks/') and len(path.split('/'))==3:
        run=load(con,path.split('/')[2])
        if run['status']=='running':raise ValueError('Wait for completion before archiving')
        con.execute('INSERT INTO run_flags VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET archived=excluded.archived',(run['id'],int(v.get('archived_at') is not None)));return summary(load(con,run['id']))
    if path=='/findings/archive-bulk':
        cutoff=date.fromisoformat(v['cutoff']);ids=[r[0] for r in con.execute("SELECT id FROM runs WHERE created<? AND status!='running'",(str(cutoff),))]
        for identifier in ids:con.execute('INSERT INTO run_flags VALUES (?,1) ON CONFLICT(run_id) DO UPDATE SET archived=1',(identifier,))
        return {'cutoff':str(cutoff),'checks_archived':len(ids),'findings_archived':sum(len(findings(con,load(con,i))) for i in ids)}
    if path.startswith('/findings/'):
        parts=path.split('/');run_id,fid=parts[2].split(':',1);run=load(con,run_id)
        if not any(f['id']==fid for f in run['result'].get('findings',[])):raise ValueError('Finding unavailable')
        if parts[3]=='state':
            old=manual_store.updates(con,run_id).get(fid,{});manual_store.update_finding(con,{'run_id':run_id,'finding_id':fid,'status':'open' if v['status']=='archived' else v['status'],'archived':v['status']=='archived','note':v.get('note',old.get('note',''))});return {'finding_id':parts[2],**v,'updated_at':now()}
        if parts[3]=='labels':
            if method=='DELETE':con.execute('DELETE FROM local_labels WHERE id=? AND run_id=? AND finding_id=?',(parts[4],run_id,fid));return {}
            label=v['label']
            if not isinstance(label,str) or not label.strip() or len(label)>80:raise ValueError('Invalid label')
            identifier=str(uuid4());con.execute('INSERT INTO local_labels VALUES (?,?,?,?)',(identifier,run_id,fid,label.strip()));return {'id':identifier,'label':label.strip()}
    if path=='/reports' or (path.startswith('/reports/') and len(path.split('/'))==3):
        if path=='/reports':return manual_settings.update_report(con,{'action':'create','name':v['name'],'run_ids':v['config']['check_ids']})
        identifier=path.split('/')[2];action='delete' if method=='DELETE' else 'rename' if 'name'in v else 'archive'
        return manual_settings.update_report(con,{'id':identifier,'action':action,'name':v.get('name'),'archived':v.get('archived_at') is not None})
    raise ValueError('Unknown manual action')
