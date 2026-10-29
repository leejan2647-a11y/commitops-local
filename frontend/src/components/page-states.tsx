import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { describeError } from '@/lib/describe-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EvidenceLock } from '@/components/evidence-lock'

/**
 * The three states every data page has to be able to show.
 *
 * Loading and refreshing already live in `page-skeleton.tsx`. Empty and error did
 * not exist as shared components, which is why the nine pages each invented
 * their own - and they were not the same. Some showed a bare sentence, some an
 * icon, one had a retry and eight did not, and the error copy was variously
 * "Something went wrong", the raw `Error.message`, or a stack-trace-shaped
 * string from an axios error object.
 *
 * These two exist so that answer is not per-page.
 */

export interface ErrorStateProps {
  error: unknown
  /** `refetch` from the React Query result. Omit to hide the retry. */
  onRetry?: () => void
  /** True while a retry is in flight, so the button cannot be double-fired. */
  isRetrying?: boolean
  /** Overrides the sentence. Use when the page knows more than the error does. */
  title?: string
  className?: string
}

/**
 * An honest error: what happened, what to do, and a way to do it.
 *
 * `role="alert"` so it is announced rather than silently replacing content - a
 * page that swaps its table for an error box and says nothing is the case this
 * exists for.
 */
export function ErrorState({ error, onRetry, isRetrying = false, title, className }: ErrorStateProps) {
  const { message, hint } = describeError(error)
  return (
    <Card className={cn('border-danger/40', className)}>
      <CardContent className="flex flex-col items-start gap-4 py-8 sm:flex-row sm:items-center">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-danger-tint text-danger"
        >
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-h3 font-bold text-foreground">
            {title ?? 'Could not load this page'}
          </h2>
          {/* `break-words`, not `truncate`: a backend error is one long token -
              a file path, a SQL fragment - and truncating it hides the part that
              identifies which file was wrong. */}
          <p className="mt-1 break-words text-body text-muted-foreground">{message}</p>
          {hint ? <p className="mt-1 text-caption text-subtle">{hint}</p> : null}
          <a href="/contact" className="mt-2 inline-flex min-h-11 items-center text-caption text-accent hover:underline">Contact us</a>
        </div>
        {onRetry ? (
          <Button
            variant="secondary"
            size="lg"
            className="w-full shrink-0 sm:w-auto"
            loading={isRetrying}
            loadingLabel="Retrying"
            onClick={onRetry}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

export interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>
  /** What is missing, in the user's terms. "No findings yet", not "0 rows". */
  title: string
  /** Why it is empty and what to do about it. One or two sentences. */
  description: string
  /** The action that fills it. Omit for a state with no action available. */
  action?: React.ReactNode
  className?: string
}

/**
 * An empty state with an icon, a reason and a way out.
 *
 * The reason an empty state needs a CTA is that "No findings yet" on its own is
 * indistinguishable from a failed query that returned nothing. The user cannot
 * tell whether there is genuinely nothing to fix or whether the thing that would
 * have found something is broken.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed',
        'border-border px-6 py-12 text-center',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid h-11 w-11 place-items-center rounded-lg bg-surface-alt text-subtle"
      >
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="text-h3 font-bold text-foreground">{title}</h3>
      <p className="max-w-prose text-body text-muted-foreground">{description}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export interface StatTileProps {
  label: string
  /** The number. Already formatted - `formatCents` and friends own that. */
  value: React.ReactNode
  /** The unit or the period, e.g. "Last check window". */
  caption?: string
  /** Shown when the value is AWS billing evidence. See below. */
  evidence?: boolean
  icon?: React.ComponentType<{ className?: string }>
  className?: string
}

/**
 * One number, with the label that says what it is and the evidence mark if it
 * came from AWS.
 *
 * The evidence lock is a prop rather than something each page adds by hand,
 * because it is a *claim*: "this number is traceable to a row in your AWS
 * billing data, it is not our estimate." Adding it manually is how one of the
 * four tiles on the dashboard ends up without one, which is worse than not
 * having the feature.
 *
 * The value is `text-display-2`-sized rather than a new step, because a KPI
 * number is a number, and the landing's own metric treatment is the display
 * scale. `tabular-nums` matters more than usual here: four money figures sit in
 * a row and are compared against each other constantly.
 */
export function StatTile({ label, value, caption, evidence = false, icon: Icon, className }: StatTileProps) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="observatory-stat-label font-medium text-muted-foreground">
            {label}
            {evidence ? <EvidenceLock className="ml-1 inline-block align-middle" /> : null}
          </p>
          {Icon ? <Icon className="h-4 w-4 shrink-0 text-subtle" /> : null}
        </div>
        <p className="observatory-stat-value mt-3 tabular-nums text-foreground">{value}</p>
        {caption ? <p className="mt-1 text-caption text-subtle">{caption}</p> : null}
      </CardContent>
    </Card>
  )
}

export interface PageHeaderProps {
  title: string
  description?: string
  /** Buttons or links on the right. Stacks below the title at 375px. */
  actions?: React.ReactNode
  /** The background-refetch marker, from `RefreshingIndicator`. */
  children?: React.ReactNode
  className?: string
}

/**
 * The title block every one of the nine pages opens with.
 *
 * `size="lg"` on the page title because these are the only `h1`s a user reaches
 * in normal navigation - the landing has its own display scale, and the auth
 * pages are not part of the product. D-57's rule applies: one `h1` per page,
 * settled on the destination's own heading.
 */
export function PageHeader({ title, description, actions, children, className }: PageHeaderProps) {
  return (
    <div className={cn('flow-page-heading flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <p className="observatory-eyebrow">Workspace intelligence</p>
        <h1 className="observatory-page-title text-h1 tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1 text-body text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? (
        // Wraps rather than overflows: a 375px screen plus a two-button header
        // row is the other way this page scrolls sideways.
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
