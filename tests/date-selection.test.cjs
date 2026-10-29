const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
test('upload, file-anchored periods, baseline controls and dashboard-only files',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'web/index.html'),'utf8'),{url:'http://127.0.0.1:8080/#token=synthetic',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 let files=[],sent=null;let pickerClicks=0;w.HTMLInputElement.prototype.click=function(){if(this.id==='upload')pickerClicks++;};
 w.fetch=async(url,options={})=>{
  assert.equal(options.headers['X-Local-Token'],'fresh');let body={};
  if(url.startsWith('/api/upload')){const comparison=url.includes('role=comparison');const id=comparison?'baseline':'primary';const inspection={status:'available',min_date:comparison?'2026-08-01':'2026-09-01',max_date:comparison?'2026-08-31':'2026-09-30'};files.push({id,role:comparison?'comparison':'primary',name:'safe.csv',bytes:42,sha256:'a'.repeat(64),inspection});body={id,inspection};}
  else if(url==='/api/state')body={files,runs:[],mappings:{}};
  else if(url.startsWith('/api/history'))body={runs:[],next_cursor:null};
  else if(url==='/api/settings')body={settings:{name:'Local',defaultDateRange:'30',creepMonthlyGrowthPercent:'10'},teams:{}};
  else if(url==='/api/analyse'){sent=JSON.parse(options.body);return {ok:false,status:400,json:async()=>({error:'synthetic stopped before execution'})};}
  return {ok:true,json:async()=>body};
 };
 try{
  w.document.head.insertAdjacentHTML('beforeend','<meta name="local-session" content="fresh">');w.sessionStorage.setItem('local-token','stale');
  w.eval(fs.readFileSync(path.join(root,'web/app.js'),'utf8'));await new Promise(r=>setTimeout(r,30));
  assert.equal(w.document.querySelector('[data-view="files"]'),null);assert.equal($('upload').closest('section').hidden,true);
  $('new-check').click();assert.equal(pickerClicks,1);assert.equal($('upload').closest('section').hidden,false);assert.equal(w.document.querySelector('.metrics').hidden,true);
  await $('upload').onchange({target:{files:[new w.File(['data'],'safe.csv')],value:''}});
  assert.equal($('upload').closest('section').hidden,false);
  assert.deepEqual(Array.from($('period-choice').options,o=>o.value),['7','30','manual']);
  assert.equal($('start').value,'2026-09-01');assert.equal($('end').value,'2026-09-30');assert.match($('date-notice').textContent,/No earlier rows/);
  $('period-choice').value='7';$('period-choice').dispatchEvent(new w.Event('change'));
  assert.equal($('start').value,'2026-09-24');assert.equal($('baseline_start').value,'2026-09-01');assert.equal($('baseline_end').value,'2026-09-23');
  assert($('baseline_end').compareDocumentPosition($('compare-device'))&w.Node.DOCUMENT_POSITION_FOLLOWING);
  $('compare-device').click();await $('comparison-upload').onchange({target:{files:[new w.File(['old'],'old.csv')],value:''}});
  assert.equal($('baseline_start').value,'2026-08-01');assert.equal($('baseline_end').value,'2026-08-31');
  await $('analyse').onclick();assert.deepEqual(sent.files,['primary']);assert.deepEqual(sent.baseline_ids,['baseline']);assert.equal(sent.comparison_mode,'device');
  $('compare-history').click();assert.equal($('baseline_start').value,'2026-09-01');
  $('compare-device').click();assert.equal($('baseline_start').value,'2026-08-01');assert.equal($('baseline_end').value,'2026-08-31');
  $('start').value='2026-09-26';$('start').dispatchEvent(new w.Event('input'));assert.equal($('period-choice').value,'manual');
  files[0].inspection.min_date='2026-06-01';const selected=$('files').querySelector('input');selected.checked=false;selected.onchange();selected.checked=true;selected.onchange();assert.equal($('period-choice').value,'manual');assert.equal($('start').value,'2026-09-26');assert.deepEqual(Array.from($('period-choice').options,o=>o.value),['7','30','90','manual']);
  w.document.querySelector('[data-view=overview]').click();assert.equal($('upload').closest('section').hidden,true);
  for(const file of ['web/index.html','web/app.js'])assert(!/[\u00e2\u2014\u2013]/.test(fs.readFileSync(path.join(root,file),'utf8')));
 }finally{w.close();}
});
