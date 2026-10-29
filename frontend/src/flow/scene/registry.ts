export type SceneKind = 'globe' | 'ribbon'
type Slot = { canvas: HTMLCanvasElement; host: HTMLElement | null; ready: boolean; visible: boolean; width: number; height: number; dpr: number; initializing: boolean; failed: boolean }
const slots = new Map<SceneKind, Slot>()
let worker: Worker | undefined
let installed = false
let scrolling = false
let typing = false
let manualPaused = false
let pageInactive = false
let lastActivityPaused:boolean|undefined
let ribbonView = 0
const motionSubscribers = new Set<() => void>()
const activitySubscribers = new Set<() => void>()
const pointerSubscribers = new Set<(event:PointerEvent|null)=>void>()
let scrollTimer: ReturnType<typeof setTimeout>
let inputTimer: ReturnType<typeof setTimeout>
const listeners: (() => void)[] = []
function listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) {
  target.addEventListener(type, listener, options)
  listeners.push(() => target.removeEventListener(type, listener, options))
}
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const isInput = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=true]')
const control = () => {
  worker?.postMessage({ type: 'activity', hidden: document.hidden || pageInactive, paused: scrolling || typing || isInput(document.activeElement) || reduced() || manualPaused })
  const nextPaused=getActivityPaused()
  if(nextPaused!==lastActivityPaused){lastActivityPaused=nextPaused;for(const callback of activitySubscribers)callback()}
  if (!getActivityPaused()) for (const [kind, slot] of slots) start(kind, slot)
}

export function getActivityPaused(){return pageInactive || (typeof document!=='undefined'&&document.hidden) || scrolling || typing || (typeof document!=='undefined'&&isInput(document.activeElement)) || getMotionPaused()}
export function subscribeActivity(callback:()=>void){install();if(typing&&!isInput(document.activeElement)){typing=false;control()}activitySubscribers.add(callback);return()=>{activitySubscribers.delete(callback)}}
export function subscribePointer(callback:(event:PointerEvent|null)=>void) { install();pointerSubscribers.add(callback);return()=>{pointerSubscribers.delete(callback)} }
export function getMotionPaused() { return manualPaused || reduced() }
export function subscribeMotion(callback: () => void) { install(); motionSubscribers.add(callback); return () => { motionSubscribers.delete(callback) } }
export function setMotionPaused(value: boolean) {
  if (manualPaused === value) return
  manualPaused = value
  if (value) document.documentElement.dataset.flowPaused = 'true'
  else delete document.documentElement.dataset.flowPaused
  control()
  for (const callback of motionSubscribers) callback()
  window.dispatchEvent(new Event('flow-motion-change'))
}
export function setRibbonView(index: number) {
  ribbonView = Number.isFinite(index) ? Math.max(0, Math.min(2, Math.round(index))) : 0
  worker?.postMessage({ type: 'view', kind: 'ribbon', index: ribbonView })
}
export function resetRibbonView() { ribbonView = 0; worker?.postMessage({ type: 'reset', kind: 'ribbon' }) }
export function getRibbonView() { return ribbonView }

function install() {
  if (installed) return
  installed = true
  // One passive pointer source, throttled to worker cadence only while hovering.
  // No RAF, React updates, transforms, attributes or DOM writes on this path.
  let pointerTimer: ReturnType<typeof setTimeout> | undefined
  let point: {host:HTMLElement;x:number;y:number} | null = null
  let hovered = false
  const flushPointer = () => {
    pointerTimer = undefined
    const slot=slots.get('ribbon')
    if (point && slot?.host===point.host && slot.visible && !document.hidden && !pageInactive && !scrolling && !typing && !reduced() && !manualPaused) {
      const box=point.host.getBoundingClientRect()
      if(box.width && box.height) {worker?.postMessage({type:'pointer',kind:'ribbon',x:(point.x-box.left)/box.width*2-1,y:(point.y-box.top)/box.height*2-1});hovered=true}
    } else if(hovered) {worker?.postMessage({type:'pointer',kind:'ribbon',x:0,y:0});hovered=false}
  }
  listen(document,'pointermove',((event:PointerEvent)=>{
    for(const callback of pointerSubscribers)callback(event)
    const host=event.target instanceof Element?event.target.closest<HTMLElement>('.flow-scene-ribbon'):null
    point=host&&event.pointerType!=='touch'?{host,x:event.clientX,y:event.clientY}:null
    if((point||hovered)&&!pointerTimer)pointerTimer=setTimeout(flushPointer,1000/24)
  }) as EventListener,{passive:true})
  listen(document,'pointerleave',()=>{for(const callback of pointerSubscribers)callback(null);point=null;if(!pointerTimer)pointerTimer=setTimeout(flushPointer,1000/24)},{passive:true})
  listeners.push(()=>{clearTimeout(pointerTimer);point=null})
  listen(window, 'scroll', () => {
    if (!scrolling) { scrolling = true; control() }
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => { scrolling = false; control() }, 180)
  }, { passive: true, capture: true })
  listen(document, 'focusin', event => { if (isInput(event.target)) { typing = true; control() } })
  listen(document, 'focusout', event => { if (isInput(event.target)) { clearTimeout(inputTimer); inputTimer = setTimeout(() => { typing = isInput(document.activeElement); control() }, 450) } })
  listen(document, 'visibilitychange', control)
  // `matchMedia` is absent in server-side/test DOMs and a few embedded webviews.
  // Motion remains controllable there; only the operating-system preference
  // listener is unavailable.
  if (typeof matchMedia === 'function') {
    listen(matchMedia('(prefers-reduced-motion: reduce)'), 'change', () => { control(); for (const callback of motionSubscribers) callback() })
  }
  listen(window, 'pagehide', () => {pageInactive=true;control()})
  listen(window, 'pageshow', () => {pageInactive=false;control()})
  lastActivityPaused=getActivityPaused()
}

function start(kind: SceneKind, slot: Slot) {
  if (slot.initializing || slot.failed || !slot.host || !slot.visible || getActivityPaused()) return
  if (!HTMLCanvasElement.prototype.transferControlToOffscreen || typeof Worker === 'undefined') return
  slot.initializing = true
  const initialize = () => {
    // An idle callback can outlive the host. Never create an invisible context.
    if (!slot.host || !slot.visible || getActivityPaused()) { slot.initializing = false; return }
    try {
    if (!worker) {
      worker = new Worker(new URL('./scene.worker.js', import.meta.url), { type: 'module', name: 'flow-scenes' })
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') {
          const target = slots.get(data.kind)
          if (target?.host) delete target.host.dataset.ready
          return
        }
        if (data.type !== 'ready') return
        const target = slots.get(data.kind)
        if (!target) return
        target.ready = true
        if (target.host) target.host.dataset.ready = 'true'
      }
      worker.onerror = () => {
        for (const target of slots.values()) { target.failed = true; if (target.host) delete target.host.dataset.ready }
        worker?.terminate(); worker = undefined
      }
      control()
    }
    const canvas = slot.canvas.transferControlToOffscreen()
    worker.postMessage({ type: 'init', kind, canvas, width: slot.width, height: slot.height, dpr: slot.dpr, visible: slot.visible, viewIndex: kind === 'ribbon' ? ribbonView : 0 }, [canvas])
    } catch { slot.failed = true; if (slot.host) delete slot.host.dataset.ready }
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(initialize, { timeout: 1200 })
  else setTimeout(initialize, 100)
}

// Vite replaces this module while editing. Dispose that development instance;
// ordinary route navigation never reaches this path or tears a scene down.
if (import.meta.hot) import.meta.hot.dispose(() => {
  worker?.terminate(); worker = undefined
  clearTimeout(scrollTimer); clearTimeout(inputTimer)
  for (const dispose of listeners) dispose()
  for (const slot of slots.values()) { slot.canvas.remove(); if (slot.host) delete slot.host.dataset.ready }
  slots.clear(); installed = false
  motionSubscribers.clear();pointerSubscribers.clear();activitySubscribers.clear();lastActivityPaused=undefined;pageInactive=false; delete document.documentElement.dataset.flowPaused
})

export function attachScene(kind: SceneKind, host: HTMLElement) {
  install()
  // Decoration must never prevent a form/page from mounting. Without the
  // visibility/size observers retain the poster rather than running uncullable 3D.
  if (typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined') return
  // Removing a focused field during navigation need not dispatch focusout.
  // Do not carry that old route's input pause into the next scene host.
  if (typing && !isInput(document.activeElement)) { clearTimeout(inputTimer); typing = false }
  let slot = slots.get(kind)
  if (!slot) {
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    slot = { canvas, host: null, ready: false, visible: false, width: 0, height: 0, dpr: devicePixelRatio || 1, initializing: false, failed: false }
    slots.set(kind, slot)
  }
  const current = slot
  // The retained frame is attached before paint on return navigation.
  current.host = host
  host.append(current.canvas)
  if (current.ready) host.dataset.ready = 'true'
  const resize = () => {
    if (current.host !== host) return
    const { width, height } = host.getBoundingClientRect()
    const w = Math.round(width), h = Math.round(height)
    const dpr = devicePixelRatio || 1
    if (w === current.width && h === current.height && dpr === current.dpr) return
    current.width = w; current.height = h; current.dpr = dpr
    if (current.initializing && worker) worker.postMessage({ type: 'resize', kind, width: w, height: h, dpr })
  }
  resize()
  const size = new ResizeObserver(resize)
  size.observe(host)
  window.addEventListener('resize', resize, { passive: true })
  const intersection = new IntersectionObserver(entries => {
    if (current.host !== host) return
    const visible = entries.some(entry => entry.isIntersecting)
    if (visible === current.visible) return
    current.visible = visible
    if (worker && current.initializing) worker.postMessage({ type: 'visibility', kind, visible })
    if (visible) start(kind, current)
  }, { threshold: 0.01 })
  intersection.observe(host)
  // Visibility can change while idle initialization was postponed in a hidden tab.
  const resume = () => { if (!document.hidden && current.host === host) start(kind, current) }
  document.addEventListener('visibilitychange', resume)
  control()
  return () => {
    size.disconnect(); intersection.disconnect()
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', resume)
    if (current.host !== host) return
    if(kind==='ribbon')worker?.postMessage({type:'pointer',kind:'ribbon',x:0,y:0})
    current.host = null; current.visible = false
    worker?.postMessage({ type: 'visibility', kind, visible: false })
    // Detach the canvas; keep worker/context and its last frame for the next route.
    current.canvas.remove()
  }
}
