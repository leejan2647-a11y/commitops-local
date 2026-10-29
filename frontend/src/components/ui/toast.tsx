import * as React from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Toast.
 *
 * Hand-rolled, Task F.1c Step 2. No toast library.
 *
 * The one part that is not optional is the live region. A toast that appears
 * without `role="status"` (or `role="alert"`) is a message a screen reader user
 * never receives - it is rendered, it is visible, and it is announced to nobody.
 * That is the difference between a notification and decoration, so the region
 * ships with the component rather than being something each caller remembers.
 *
 * **`aria-live` is polite for success and info, assertive for danger.** A failed
 * check should interrupt; a CSV parsed should not.
 *
 * **Errors get a longer timeout, and `danger` errors do not auto-dismiss at
 * all** unless given one. A message about a bill that disappeared after four
 * seconds is worse than no message, because the user now believes something
 * they were told is fine.
 *
 * The shape is the landing's icon-chip: a 10% tint of the status hue with the
 * hue itself as the foreground - the same `--success-tint` / `--danger-tint`
 * pairs the Badge uses, so a toast and a badge of the same status are the same
 * colour by construction.
 */

export type ToastVariant = 'success' | 'warning' | 'danger' | 'info'

const VARIANTS: Record<ToastVariant, { chip: string; icon: React.ComponentType<{ className?: string }> }> = {
  success: { chip: 'bg-success-tint text-success', icon: CheckCircle2 },
  warning: { chip: 'bg-warning-tint text-warning', icon: AlertTriangle },
  danger: { chip: 'bg-danger-tint text-danger', icon: XCircle },
  info: { chip: 'bg-info-tint text-info', icon: Info },
}

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: ToastVariant
  title: string
  description?: string
  /** 0 keeps it until dismissed. The default depends on the variant. */
  durationMs?: number
  onDismiss?: () => void
}

/** Danger defaults to sticky; the rest expire. See the note above. */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  danger: 0,
}

export function Toast({
  variant = 'info',
  title,
  description,
  durationMs,
  onDismiss,
  className,
  ...props
}: ToastProps) {
  const { chip, icon: Icon } = VARIANTS[variant]
  const ms = durationMs ?? DEFAULT_DURATION[variant]

  React.useEffect(() => {
    if (ms <= 0 || !onDismiss) return
    const timer = window.setTimeout(onDismiss, ms)
    return () => window.clearTimeout(timer)
  }, [ms, onDismiss])

  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      // `polite` waits for a pause; `assertive` interrupts. Danger interrupts.
      aria-live={variant === 'danger' ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border',
        'bg-surface-raised p-4 shadow-panel',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-sm', chip)}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mt-0.5 break-words text-caption text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss: ${title}`}
          className={cn(
            'shrink-0 rounded-sm p-1 text-muted-foreground transition-colors duration-fast',
            'hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export interface ToastRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Top-right on desktop, full-width at the top on a phone. */
  position?: 'top-right' | 'bottom-right'
}

/**
 * The container toasts are rendered into.
 *
 * `role="region"` is what makes the `aria-label` mean anything - a `div` with an
 * `aria-label` and no role is announced as nothing, so the landmark a screen
 * reader user would use to jump back to a message that was truncated or scrolled
 * away did not exist.
 *
 * `pointer-events-none` on the region with `pointer-events-auto` on each toast,
 * so the stack never swallows a click meant for the page behind it - a region
 * covering a corner of the screen with a full-size hit area is a real bug on
 * touch devices, where it blocks the thing underneath. Each `Toast` therefore
 * needs `pointer-events-auto` on itself; `ToastRegion` cannot do it, because the
 * property does not inherit in a way that survives a child's own background.
 */
export function ToastRegion({ className, position = 'top-right', ...props }: ToastRegionProps) {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className={cn(
        'pointer-events-none fixed z-[60] flex w-full max-w-sm flex-col gap-2 p-4',
        position === 'top-right'
          ? 'inset-x-0 top-0 items-center sm:inset-x-auto sm:right-0 sm:items-end'
          : 'inset-x-0 bottom-0 items-center sm:inset-x-auto sm:bottom-0 sm:right-0 sm:items-end',
        className,
      )}
      {...props}
    />
  )
}
