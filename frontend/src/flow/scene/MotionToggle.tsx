import { useSyncExternalStore } from 'react'
import { Pause, Play } from 'lucide-react'
import { getMotionPaused, setMotionPaused, subscribeMotion } from './registry'

// Include the OS preference even when manual pause already makes the combined
// pause value true; the button's disabled state must still rerender on that change.
const readMotionState=()=> (getMotionPaused()?1:0) | (typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches?2:0)

/** One state change per click; this component never subscribes to frame data. */
export function MotionToggle() {
  const state = useSyncExternalStore(subscribeMotion, readMotionState, () => 0)
  const paused = !!(state & 1)
  const systemReduced = !!(state & 2)
  const label = systemReduced ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion'
  return <button className="flow-motion-toggle" type="button" aria-label={label} aria-pressed={paused} disabled={systemReduced}
    title={systemReduced ? 'Reduced motion is enabled in your system settings' : undefined}
    onClick={() => setMotionPaused(!paused)}>
    {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
    <span>{label}</span>
  </button>
}
