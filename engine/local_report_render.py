"""Standalone printable local report, with escaped evidence and exact-cent money."""
from html import escape

def render_document(data):
 def e(value):return escape(str(value if value is not None else 'Unavailable'))
 def money(value):
  if type(value) is not int:return 'Unavailable'
  sign='-' if value<0 else '';v=abs(value)
  return f'{sign}USD {v//100:,}.{v%100:02d} ({value} cents)'
 def table(headings,rows):
  return '<table><thead><tr>'+''.join('<th>'+e(h)+'</th>' for h in headings)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+e(v)+'</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table>'
 findings=data['findings'];commitments=data['commitments'];window=data['window']
 body='<h1>Local cost review</h1><p class="muted">Source-observed AWS charges and investigation evidence</p>'
 body+='<section><h2>Review scope</h2>'+table(['Check','Analysis dates','Calculated UTC','Outcome'],[[data['check_id'],str(window.get('start'))+' to '+str(window.get('end')),data.get('generated_at'),data['outcome']]])+'</section>'
 body+='<section><h2>Reported AWS charges</h2><p class="amount">'+e(money(data.get('reported_charges_cents')))+'</p><p>Uploaded rows do not establish complete delivery or final invoice reconciliation. Missing evidence is unavailable, never assumed zero.</p></section>'
 body+='<section><h2>Findings</h2><p>Finding amounts can overlap and measure different periods. Do not add them into a bill or savings total.</p>'
 if not findings:body+='<p>No findings were saved for the observed scope. This does not prove the export is complete.</p>'
 for f in findings:
  m=f.get('amount_measurement') or {};body+='<article><h3>'+e(f['title'])+'</h3>'+table(['Detector','Severity','Amount','Measurement basis'],[[f.get('detector'),f['severity'],money(m.get('value_cents')),m.get('basis')]])+'<p>'+e(f['description'])+'</p>'
  body+=''.join('<p class="caveat">'+e(c)+'</p>' for c in f.get('caveats',[]))
  if f.get('evidence'):body+=table(['Reference','Amount','Date'],[[r['reference'],money(r['amount_cents']),r['date']] for r in f['evidence']])
  body+='</article>'
 body+='</section><section><h2>Commitments</h2>'+table(['Name / plan','Family','Purchased','Used','Unused','Account'],[[p.get('name',p.get('id')),p.get('type'),money(p.get('purchased_cents')),money(p.get('used_cents')),money(p.get('unused_cents')),p.get('account')] for p in commitments])+'</section>'
 body+='<section><h2>Source evidence</h2>'+table(['Filename','Upload ID','SHA-256'],[[f['filename'],f['id'],f.get('sha256')] for f in data['sources']])+'</section>'
 body+='<section><h2>Interpretation and next steps</h2><p>Estimates use only the AWS data provided. Cloud usage does not establish company or revenue growth. Verify source coverage, inspect each finding and confirm commitments against the original billing export before acting.</p></section>'
 style='body{font:15px/1.55 system-ui,sans-serif;color:#162338;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:34px}h2{margin-top:32px}h3{font-size:18px}.muted{color:#536375}.amount{font-size:26px;font-weight:700}table{border-collapse:collapse;width:100%;margin:14px 0;table-layout:fixed}td,th{text-align:left;vertical-align:top;border:1px solid #cdd5df;padding:10px;overflow-wrap:anywhere}th{background:#edf2f7}article{border-top:2px solid #dae1eb;padding:12px 0}.caveat{color:#745315}@media print{body{margin:0;font-size:11px}article,tr{break-inside:avoid}h2{break-after:avoid}}'
 html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>Local cost review</title><style>'+style+'</style></head><body>'+body+'</body></html>'
 return {**data,'html':html,'text':'Local cost review: '+data['check_id'],'state':data['outcome']}
