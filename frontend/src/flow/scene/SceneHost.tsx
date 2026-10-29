import { useLayoutEffect, useRef } from 'react'
import { attachScene, type SceneKind } from './registry'
import './scene.css'

/** Decorative only. React receives no frame, angle, or rendering state. */
export function SceneHost({ kind, className = '' }: { kind: SceneKind; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => host.current ? attachScene(kind, host.current) : undefined, [kind])
  return <div ref={host} className={`flow-scene flow-scene-${kind} ${className}`} aria-hidden="true">
    <img className="flow-scene-poster" src={`/scenes/${kind}-poster.${kind === 'globe' ? 'svg' : 'png'}`} alt="" width={kind === 'globe' ? 600 : 1000} height={600} decoding="async" />
  </div>
}
