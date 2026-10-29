import { useRef, type ReactNode } from 'react'

import { BackgroundPathsMotion } from './components/BackgroundPathsMotion'
import { usePageMotion } from './hooks/usePageMotion'
import primaryPaths from './styles/flow-paths-primary.svg?url'
import secondaryPaths from './styles/flow-paths-secondary.svg?url'
import primaryMobile from './styles/flow-paths-primary-mobile.svg?url'
import secondaryMobile from './styles/flow-paths-secondary-mobile.svg?url'

/** Persistent Flow artwork plus a single route entrance around the real app. */
export function FlowFrame({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  usePageMotion(host)

  return (
    <>
      <div className="flow-background" aria-hidden="true">
        <div className="flow-background-haze" />
        <div className="flow-path-plane">
          <picture><source media="(max-width:650px)" srcSet={primaryMobile} /><img src={primaryPaths} alt="" /></picture>
          <picture><source media="(max-width:650px)" srcSet={secondaryMobile} /><img src={secondaryPaths} alt="" /></picture>
          <BackgroundPathsMotion />
        </div>
        <div className="flow-background-vignette" />
      </div>
      <div ref={host} className="flow-route-host">
        <div className="flow-route">{children}</div>
      </div>
    </>
  )
}
