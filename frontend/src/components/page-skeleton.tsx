/**
 * Loading and refreshing affordances (Task F.1b-fix).
 *
 * Two states that used to be conflated, and the difference matters:
 *
 * - `PageSkeleton` is for the *first* load, when there is genuinely nothing to
 *   show. It mimics the shape of the real content so the page does not jump
 *   when the data lands.
 * - `RefreshingIndicator` is for a *background* refetch, when cached data is
 *   already on screen. The data stays; a small marker says it is being updated.
 *
 * A page that blanks during a background refetch is the bug this exists to
 * prevent: with a 30 s staleTime the common case is a refetch the user did not
 * ask for, and replacing the content with a spinner makes the app feel slower
 * than no cache at all.
 */
import { Loader2 } from 'lucide-react'

function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />
}

/**
 * A page-shaped skeleton: title, a row of stat tiles, then a content block.
 *
 * Deliberately not a centred spinner. A spinner says "wait"; this says "this is
 * roughly what is coming", which is the actual information available.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-6">
      <div className="space-y-2">
        <Block className="h-9 w-48" />
        <Block className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-4">
            <Block className="h-3 w-20" />
            <Block className="h-7 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <Block className="h-4 w-40" />
        <Block className="h-24 w-full" />
        <Block className="h-24 w-full" />
        <Block className="h-24 w-3/4" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  )
}

/** A tighter skeleton for pages that are one list, e.g. findings. */
export function ListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div role="status" className="space-y-4">
      <div className="space-y-2">
        <Block className="h-9 w-48" />
        <Block className="h-4 w-64" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Block className="h-4 w-16" />
            <Block className="h-4 w-24" />
          </div>
          <Block className="h-5 w-2/3" />
          <Block className="h-3 w-full" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

/**
 * The background-refetch marker.
 *
 * Rendered only when data is already on screen and a refetch is in flight, so it
 * never appears on a first load and never replaces content.
 */
export function RefreshingIndicator({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      Refreshing&hellip;
    </span>
  )
}
