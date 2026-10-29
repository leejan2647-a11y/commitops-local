import { useEffect,useRef } from 'react'

/** Kokonut Background Paths inspired motion on the existing Flow curves.
 * One persistent 2D worker paints travelling strokes; it never drives the DOM.
 * Unlike foreground scenes, this background ignores scroll, form and manual pause.
 */
export function BackgroundPathsMotion(){
 const hostRef=useRef<HTMLDivElement>(null)
 useEffect(()=>{
  const host=hostRef.current
  if(!host||typeof Worker==='undefined'||typeof matchMedia!=='function'||typeof ResizeObserver==='undefined'||!HTMLCanvasElement.prototype.transferControlToOffscreen)return
  const reduced=matchMedia('(prefers-reduced-motion: reduce)')
  let worker:Worker|undefined,canvas:HTMLCanvasElement|undefined,disposed=false,lastSize='',timer:ReturnType<typeof setTimeout>|undefined
  const size=()=>{
   if(!worker)return
   const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight),mobile=innerWidth<=650
   const key=`${width}:${height}:${mobile}`
   if(key!==lastSize){lastSize=key;worker.postMessage({type:'resize',width,height,mobile})}
  }
  const start=()=>{
   timer=undefined
   if(disposed||document.hidden||reduced.matches||worker)return
   try{
    canvas=document.createElement('canvas');canvas.className='flow-path-canvas';canvas.setAttribute('aria-hidden','true')
    const offscreen=canvas.transferControlToOffscreen()
    worker=new Worker(new URL('./background-paths.worker.ts',import.meta.url),{type:'module'})
    lastSize=''
    worker.onmessage=(event:MessageEvent)=>{if(event.data?.type==='ready'&&!disposed)host.dataset.ready='true'}
    worker.onerror=()=>{worker?.terminate();worker=undefined;canvas?.remove();delete host.dataset.ready}
    host.appendChild(canvas)
    worker.postMessage({type:'init',canvas:offscreen},[offscreen]);size()
    worker.postMessage({type:'active',value:true})
   }catch{worker?.terminate();worker=undefined;canvas?.remove();delete host.dataset.ready}
  }
  const sync=()=>{
   const active=!document.hidden&&!reduced.matches
   if(worker)worker.postMessage({type:'active',value:active})
   else if(active&&timer===undefined)timer=setTimeout(start,0)
  }
  // Deferral cancels the development StrictMode probe before transferring a canvas.
  document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync)
  const resize=new ResizeObserver(size);resize.observe(host);sync()
  return()=>{disposed=true;clearTimeout(timer);resize.disconnect();document.removeEventListener('visibilitychange',sync);reduced.removeEventListener('change',sync);worker?.terminate();canvas?.remove();delete host.dataset.ready}
 },[])
 return <div ref={hostRef} className="flow-path-motion" aria-hidden="true"/>
}
