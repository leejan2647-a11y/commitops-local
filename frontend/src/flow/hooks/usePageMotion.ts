import { useLayoutEffect, type RefObject } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
let lastPage: {path:string;key:string}|undefined

/** One CSS entrance for committed main content; header/navigation stay still. No per-element hiding,
 * scrolling observers, stagger queues or per-frame JavaScript. */
export function usePageMotion(ref:RefObject<HTMLDivElement|null>){
 const {pathname,key,hash}=useLocation(),type=useNavigationType()
 useLayoutEffect(()=>{
  const previous=lastPage;lastPage={path:pathname,key}
  if(type!=='POP'&&!hash&&previous?.path!==pathname)window.scrollTo({top:0,left:0,behavior:'instant'})
  const host=ref.current;if(!host)return
  const preference=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):undefined
  const settle=()=>{
   const paused=!!preference?.matches||document.documentElement.dataset.flowPaused==='true'
   for(const page of host.querySelectorAll('.flow-route'))page.classList.toggle('flow-route-settled',paused)
  }
  // CSS's resting state is visible, even if JS/observers fail. The single
  // entrance ends at 650ms, with no animation-fill hidden state to get stuck in.
  document.documentElement.classList.remove('flow-motion')
  ;(window as Window&{__flowMotionReady?:boolean}).__flowMotionReady=true
  settle()
  const changes=new MutationObserver(settle);changes.observe(host,{childList:true,subtree:true})
  preference?.addEventListener('change',settle);window.addEventListener('flow-motion-change',settle)
  return()=>{changes.disconnect();preference?.removeEventListener('change',settle);window.removeEventListener('flow-motion-change',settle)}
 },[pathname,key,hash,type,ref])
}
