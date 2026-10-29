import type { Upload, CheckCreated } from './types'
type Fetcher=<T>(path:string,init?:RequestInit)=>Promise<T>
const uploaded=new WeakMap<File,Map<string,Promise<{upload:Upload}>>>()
export function uploadResumable(file:File,role:string,_identity:string,api:Fetcher,description?:string,origin='manual_check'):Promise<{upload:Upload}>{
 let roles=uploaded.get(file);if(!roles){roles=new Map();uploaded.set(file,roles)}
 const key=JSON.stringify([role,origin,description??'']);const prior=roles.get(key);if(prior)return prior
 const task=api<{id:string;inspection:{min_date:string;max_date:string;rows:number}}>('/api/upload?'+new URLSearchParams({name:file.name,role:role==='baseline'?'comparison':'primary',origin,description:description??''}),{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream'}}).then(result=>({upload:{id:result.id,filename:file.name,size_bytes:file.size,min_date:result.inspection?.min_date,max_date:result.inspection?.max_date,row_count:result.inspection?.rows} as Upload}));roles.set(key,task);task.catch(()=>roles!.delete(key));return task
}
export async function submitResumableCheck(form:FormData,identity:string,api:Fetcher):Promise<CheckCreated>{
 const files:string[]=[];for(const item of form.getAll('files'))files.push((await uploadResumable(item as File,'primary',identity,api)).upload.id)
 const baseline=JSON.parse(String(form.get('baseline_upload_ids')??'[]')) as string[]
 for(const item of form.getAll('baseline_files'))baseline.push((await uploadResumable(item as File,'baseline',identity,api)).upload.id)
 const result=await api<{id:string}>('/api/analyse',{method:'POST',body:JSON.stringify({submission_key:form.get('submission_key'),files:[...new Set(files)],start:form.get('window_start'),end:form.get('window_end'),baseline_start:form.get('baseline_start'),baseline_end:form.get('baseline_end'),comparison_mode:form.get('compare_previous')==='true'?'device':'history',baseline_ids:[...new Set(baseline)]})})
 return {check_id:result.id,status:'running',findings_count:0,job_id:null}
}
