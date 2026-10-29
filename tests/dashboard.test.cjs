const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const root=path.resolve(__dirname,'..');
test('manual dashboard filters, evidence, safe output and manual-only navigation',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'web/index.html'),'utf8'),{url:'http://127.0.0.1:8080/#token=synthetic',runScripts:'outside-only'}),w=dom.window;
 const result={window:{start:'2026-09-01',end:'2026-09-30'},validation:{window_total_cents:1250,unique_rows:31},findings:[{id:'f',title:'<img src=x onerror=alert(1)>',type:'spike',severity:'high',status:'open',service:'EC2',account:'111111111111',impact_cents:500,evidence:{top_line_items:[{lineItemId:'row',date:'2026-09-03',contributionCents:500}]}}],commitments:[{name:'Plan',purchased_cents:1000,used_cents:600,unused_cents:400}],allocation:{totalUnusedCents:null},teams:[],comparisons:[],monthly_growth:{observations:[]}};
 const paths=[],downloads=[];
 w.Blob=Blob;w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:synthetic';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 const preferences={name:'Local company',defaultDateRange:'30',creepMonthlyGrowthPercent:'10'};
 w.fetch=async(url,options={})=>{paths.push(url);return{ok:true,json:async()=>url==='/api/settings'?{settings:preferences,teams:{'111111111111':'Engineering'}}:url==='/api/resources'?{processing:{cpu_threads:8,available_memory_bytes:8e9,duckdb_memory_bytes:5.6e9,spill_bytes:50e9},uploads:{usable_bytes:50e9}}:url.startsWith('/api/reports')&&options.method!=='POST'?{reports:[],next_cursor:null}:url==='/api/state'?{files:[],runs:[{id:'run',status:'completed'}],mappings:{}}:url.startsWith('/api/history')?{runs:[{id:'run',status:'completed',created:'2026-10-28'}],next_cursor:null}:options.method==='POST'?{saved:true}:{status:'completed',result,finding_updates:{}}};};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 try{
  w.eval(fs.readFileSync(path.join(root,'web/app.js'),'utf8'));await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(w.document.querySelector('#metric-charges').textContent,'$12.50');assert.equal(w.document.querySelector('#finding-table img'),null);
  w.document.querySelector('[data-view=findings]').click();assert.equal(w.document.querySelector('[data-only=findings]').hidden,false);
  const severity=w.document.querySelector('#finding-severity');severity.value='low';severity.dispatchEvent(new w.Event('change'));assert.equal(w.document.querySelectorAll('#finding-table tbody tr').length,0);
  severity.value='';severity.dispatchEvent(new w.Event('change'));w.document.querySelector('#finding-table .link-button').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(w.document.querySelector('#finding-dialog').open,true);assert.match(w.document.querySelector('#finding-evidence').textContent,/\$5\.00/);
  w.document.querySelector('#edit-status').value='resolved';w.document.querySelector('#save-finding').click();await new Promise(resolve=>setTimeout(resolve,0));assert(paths.includes('/api/findings/update'));
  w.document.querySelector('[data-view=commitments]').click();assert.match(w.document.querySelector('#manual-tables').textContent,/\$4\.00/);
  w.document.querySelector('[data-view=allocation]').click();assert.match(w.document.querySelector('#manual-tables').textContent,/Unavailable/);
  w.document.querySelector('#html-report').click();const html=await downloads.pop().text();assert.match(html,/&lt;img/);assert(!html.includes('<img src=x'));assert.match(html,/Complete check evidence/);
  result.findings[0].title='=1+2';w.document.querySelector('#csv-report').click();const csv=await downloads.pop().text();assert.match(csv,/Impact cents/);assert.match(csv,/resolved/);assert.match(csv,/"'=1\+2"/);
  w.document.querySelector('[data-view=settings]').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(w.document.querySelector('#settings-company').value,'Local company');assert.match(w.document.querySelector('#team-list').textContent,/Engineering/);assert.equal(w.document.querySelector('#hardware-info'),null);assert.equal(w.document.querySelector('#mappings'),null);w.document.querySelector('#save-settings').click();await new Promise(resolve=>setTimeout(resolve,0));assert(paths.includes('/api/settings'));assert(!fs.readFileSync(path.join(root,'web/style.css'),'utf8').includes('#07090c'));
  assert.equal(w.document.querySelectorAll('[data-view=schedules],[data-view=rules],[data-view=delivery]').length,0);
  assert(paths.every(url=>url.startsWith('/api/')));assert.equal(w.document.querySelector('script[src^="http"]'),null);
 }finally{w.close();}
});
