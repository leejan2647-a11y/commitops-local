import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Badge.
 *
 * Hand-rolled, Task F.1c Step 2.
 *
 * The shape is the landing's `.trend`, which is a genuine badge and not a chip:
 * 6px radius (`radii.sm`), `padding: 4px 8px`, `font: 500 0.68rem 'DM Mono'`,
 * and a background of the status hue at 10%. The token system widens the type
 * from 0.68rem to 0.75rem and the radius from 6px to the same 6px - see
 * `tokens.ts` on why the landing's eight mono sizes were not copied.
 *
 * **Every variant is a hue plus its own 10% tint, from the palette.** That is the
 * whole reason `--success-tint` and friends exist. The previous badge had three
 * solid fills and no tint at all, and there is no way to render a solid success
 * green at 10px type on a navy card without the text contrast falling apart.
 *
 * **`neutral` is a real variant, not a fallback.** `/allocation` and
 * `/commitments` both render categories the pipeline has not classified, and
 * "we do not know" is a state with its own colour. It is muted text on a muted
 * fill - deliberately the quietest thing on the page, because the alternative is
 * a category that looks as certain as one that is.
 *
 * **A badge is a `span`, not a `div`.** It sits inside table cells and headings;
 * a `div` inside a `td` or an `h3` is invalid HTML and breaks the heading
 * outline that screen readers use to navigate a long findings list.
 */

export type BadgeVariant =
  /** Confirmed, reconciled, passing. */
  | 'success'
  /** Needs attention but is not wrong. Under-utilised, approaching a limit. */
  | 'warning'
  /** Wrong, or irreversible. An error state, a failed check. */
  | 'danger'
  /** Neutral, factual. A category, an account id, a status with no opinion. */
  | 'info'
  /** Unclassified. The pipeline emitted this and nothing claimed it. */
  | 'neutral'
  /**
   * @deprecated Use `info`. Kept so the existing pages keep compiling until
   * Step 3 migrates them.
   */
  | 'secondary'
  /**
   * @deprecated Use `info` or `danger` as appropriate.
   */
  | 'destructive'
  /**
   * @deprecated Use `info`.
   */
  | 'default'
  /**
   * @deprecated Use `neutral`.
   */
  | 'outline'

/**
 * Hue and tint, paired. The pairing is the invariant: a variant that has a
 * foreground but no background would force a caller to invent one, which is how
 * the allocation page ended up describing four categories the pipeline cannot
 * emit (D-48). `tokens.test.ts` asserts every status has both.
 */
const VARIANTS: Record<BadgeVariant, string> = {
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  info: 'bg-info-tint text-info',
  neutral: 'bg-muted text-muted-foreground',
  // Transitional aliases. See the @deprecated notes on BadgeVariant.
  secondary: 'bg-muted text-muted-foreground',
  destructive: 'bg-danger-tint text-danger',
  default: 'bg-info-tint text-info',
  outline: 'bg-muted text-muted-foreground',
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  /** A small filled dot in the variant's hue, for a status with no text. */
  dot?: boolean
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = 'neutral', dot = false, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-transparent px-2 py-0.5',
        'font-mono text-mono font-medium leading-normal',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current shadow-halo"
        />
      ) : null}
      {children}
    </span>
  )
})
