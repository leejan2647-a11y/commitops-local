/**
 * The lock-icon convention (FINALREPORT.md §4 "Permissions"): every AWS-evidence field in the UI
 * carries this icon, because the visual language mirrors the database truth -
 * those fields are frozen server-side and are not editable in the product.
 *
 * It is a claim, and the two halves of it have to stay together: the icon says
 * "this came from AWS", the accessible name says what that means. An icon with
 * no name is decoration to a screen reader, and the fields it marks are exactly
 * the ones a user is most likely to want an explanation for.
 *
 * `aria-hidden` is deliberately *not* set. The previous version was
 * `aria-label` plus an SVG `<title>` with the same string, so the text was
 * present twice in the source and the two copies had drifted - the title had a
 * mojibake byte in it where an em-dash had been, which is how a file gets
 * written with the wrong encoding and never noticed.
 */
import { Lock } from 'lucide-react'

const LABEL = 'AWS billing evidence, read-only'

export function EvidenceLock({ className }: { className?: string }) {
  return (
    <Lock
      className={className ?? 'inline h-3.5 w-3.5 align-baseline text-subtle'}
      aria-label={LABEL}
    >
      <title>{LABEL}</title>
    </Lock>
  )
}
