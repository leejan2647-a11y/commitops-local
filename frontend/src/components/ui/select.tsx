import * as React from 'react'

import { cn } from '@/lib/utils'
import { controlClasses } from '@/components/ui/control-classes'

/**
 * Select.
 *
 * Hand-rolled, Task F.1c Step 2. Shares `controlClasses` with `Input` and
 * `Textarea`; what it adds is the chevron.
 *
 * **The chevron is drawn, not native.** A `<select>` cannot take a
 * `::after`, and the browser's own arrow is a black glyph - on a `#0f1e32`
 * field it is close to invisible, which is a real defect rather than a
 * cosmetic one: the control reads as a text field, so nothing signals that it
 * opens a list. The arrow is an inline SVG data URI in `--muted-foreground`
 * (`#9bb0c7`), which is a token value rather than a literal.
 *
 * `appearance-none` is what makes the drawn arrow replace the native one rather
 * than sit beside it.
 */

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Sets the danger border and `aria-invalid`. Pair with a `Field` for the message. */
  error?: boolean
}

/** `stroke='%239bb0c7'` is `#9bb0c7` URL-encoded - `--muted-foreground`. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' " +
  "viewBox='0 0 24 24' fill='none' stroke='%239bb0c7' stroke-width='2.5' stroke-linecap='round' " +
  "stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, error = false, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={error || undefined}
      className={cn(
        controlClasses(error),
        'h-11 cursor-pointer appearance-none bg-no-repeat pr-9 md:h-10',
        className,
      )}
      style={{
        backgroundImage: CHEVRON,
        backgroundPosition: 'right 0.625rem center',
        backgroundSize: '1rem',
      }}
      {...props}
    >
      {children}
    </select>
  )
})
