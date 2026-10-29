import type { PrivateIdentity } from './private-identity'
const controller=new AbortController()
const identity:PrivateIdentity={userId:'local',tenantId:'local',token:document.querySelector<HTMLMetaElement>('meta[name=local-session]')?.content??'',generation:1,signal:controller.signal,isCurrent:()=>true}
export function useAuth(){return {identity,user:{id:'local',email:'Local workspace'},session:null,loading:false,error:null,retryIdentity:()=>{},signOut:async()=>{}}}
export function useIdentityGuard(){return ()=>!identity.signal.aborted}
