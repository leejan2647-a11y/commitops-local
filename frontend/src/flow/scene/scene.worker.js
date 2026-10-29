// The only recurring scheduler. The main thread receives one readiness message,
// never frames, angles, bitmap transfers, or DOM instructions.
const scenes = new Map()
const pending = new Map()
let hidden = false, paused = false, timer = 0, previous = 0
const interval = 1000 / 24
const stats = { starts: 0, frames: 0, maxDrawMs: 0, errors: [] }

function schedule() {
  if (timer || hidden || paused || ![...scenes.values()].some(scene => scene.visible)) return
  previous = performance.now()
  timer = setTimeout(tick, interval)
}
function tick() {
  timer = 0
  if (hidden || paused) return
  const now = performance.now(), delta = Math.min((now - previous) / 1000, 0.1)
  previous = now
  let active = false
  for (const scene of scenes.values()) {
    if (!scene.visible) continue
    active = true
    const start = performance.now()
    scene.draw(delta)
    stats.frames++
    stats.maxDrawMs = Math.max(stats.maxDrawMs, performance.now() - start)
  }
  if (active) timer = setTimeout(tick, Math.max(0, interval - (performance.now() - now)))
}
function stop() { clearTimeout(timer); timer = 0; previous = 0 }

self.onmessage = async ({ data }) => {
  if (data.type === 'activity') {
    hidden = data.hidden; paused = data.paused
    if(paused) scenes.get('ribbon')?.setPointer?.(0,0)
    stop(); schedule(); return
  }
  if (data.type === 'stats') {
    self.postMessage({ type: 'stats', ...stats, scenes: [...scenes.keys()] }); return
  }
  if (data.type === 'init') {
    if (scenes.has(data.kind) || pending.has(data.kind)) return
    pending.set(data.kind, data)
    try {
      const module = data.kind === 'globe' ? await import('./globe-renderer.js') : await import('./ribbon-renderer.js')
      const scene = await module.createScene(data)
      const latest = pending.get(data.kind)
      scene.visible = latest.visible
      scene.setView?.(latest.viewIndex || 0, paused)
      scene.resize(latest.width, latest.height, latest.dpr)
      scene.draw(0)
      scenes.set(data.kind, scene); pending.delete(data.kind)
      stats.starts++
      // Let the initial drawing task commit before hiding the static poster.
      // This is one handoff, not another recurring animation loop.
      await new Promise(resolve => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(resolve) : setTimeout(resolve, 32))
      self.postMessage({ type: 'ready', kind: data.kind })
      schedule()
    } catch (error) {
      stats.errors.push(String(error)); pending.delete(data.kind)
      self.postMessage({ type: 'error', kind: data.kind, message: String(error) })
    }
    return
  }
  const loading = pending.get(data.kind)
  if (loading) {
    if (data.type === 'visibility') loading.visible = data.visible
    if (data.type === 'resize') Object.assign(loading, { width: data.width, height: data.height, dpr: data.dpr })
    if (data.type === 'view') loading.viewIndex = data.index
    if (data.type === 'reset') loading.viewIndex = 0
  }
  const scene = scenes.get(data.kind)
  if (!scene) return
  if (data.type === 'pointer' && ((data.x===0 && data.y===0) || (!paused && !hidden && scene.visible))) scene.setPointer?.(data.x, data.y)
  if (data.type === 'visibility') { scene.visible = data.visible; stop(); schedule() }
  if (data.type === 'resize') { scene.resize(data.width, data.height, data.dpr); if (scene.visible && !hidden) scene.draw(0) }
  if (data.type === 'view') { scene.setView?.(data.index, paused); if (scene.visible && !hidden) scene.draw(0); schedule() }
  if (data.type === 'reset') { scene.reset?.(paused); if (scene.visible && !hidden) scene.draw(0); schedule() }
}
