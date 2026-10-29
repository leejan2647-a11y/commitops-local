import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Card.
 *
 * Hand-rolled, Task F.1c Step 2.
 *
 * The card is the landing's `.pain-card` / `.outcome-card` rule: a 13px radius
 * (D-55), a 1px `--border`, and **no drop shadow** - the landing separates
 * surfaces with the border alone, and the reason is D-51: a black shadow on a
 * `#07111f` page is invisible because the shadow and the surface are the same
 * colour. `shadow-card` exists but is off by default, for the case where a card
 * is genuinely floating (a dialog, a dropdown).
 *
 * Two parts are stricter than the old versions:
 *
 * - `CardTitle` renders an `h3` and previously claimed to be an
 *   `HTMLParagraphElement` in its ref type while being an `h3`, so a ref typed
 *   as a paragraph would have thrown. The ref type is now the element it
 *   actually is.
 * - `Card` takes `asChild`-free plain props, and the header/footer no longer
 *   force a `p-6 pt-0` that fought the content padding. `CardContent` has its
 *   own padding and a caller can drop it with `p-0` when the card is a table
 *   shell, which is what `/allocation` and `/reports` both want.
 */

export type CardProps = React.HTMLAttributes<HTMLDivElement>

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'observatory-panel rounded-lg border border-border bg-surface text-foreground',
        className,
      )}
      {...props}
    />
  )
})

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn('flex flex-col gap-1 p-6 pb-4', className)} {...props} />
  },
)

/**
 * Rendered as an `h3` and typed as an `h3`.
 *
 * The previous version declared `React.forwardRef<HTMLParagraphElement, ...>`
 * on an `h3` element, so a caller passing a paragraph-typed ref got a runtime
 * type error for something that was structurally fine.
 */
export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <h3
      ref={ref}
      className={cn('text-h3 font-extrabold leading-tight tracking-tight text-foreground', className)}
      {...props}
    />
  )
})

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn('text-body text-muted-foreground', className)} {...props} />
})

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
  },
)

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex items-center gap-2 border-t border-border p-4', className)}
        {...props}
      />
    )
  },
)
