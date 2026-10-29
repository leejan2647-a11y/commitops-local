import * as React from 'react'
import { Loader2 } from 'lucide-react'

import {
  buttonClasses,
  type ButtonSize,
  type ButtonVariant,
  type LegacySize,
} from '@/components/ui/button-classes'

/**
 * Button.
 *
 * Hand-rolled, Task F.1c Step 2. No component library.
 *
 * Three decisions worth stating, because each of them is a place the obvious
 * implementation is wrong:
 *
 * **The loading state is `disabled` AND `aria-busy`, not just a spinner.**
 * A button that shows a spinner but stays clickable will fire its handler again
 * on a second click, and `/check` posts a job - a double-submit there means two
 * checks, two sets of findings, and a bill for both. `aria-busy` is what tells a
 * screen reader the control is working rather than broken.
 *
 * **`loading` keeps the label in the DOM and hides it visually.** Replacing the
 * text with "Loading..." makes the button change width, which moves every
 * control next to it. The `sr-only` span carries the state to assistive tech and
 * the visible label is retained at zero size.
 *
 * **The primary variant uses the landing's cyan glow, not a flat fill.** The
 * landing's `.button` is `box-shadow: 0 10px 25px #22d3ee1e` over a cyan fill,
 * and the reason is D-51: on a `#07111f` page a flat fill and the background are
 * close enough in luminance that the button does not read as raised. The glow is
 * what separates it.
 *
 * The variants and sizes live in `button-classes.ts` so that `link-button.tsx`
 * can render a react-router `<Link>` with identical styling. Nesting a `<Button>`
 * inside a `<Link>` is what these pages used to do and it is invalid HTML; the
 * long version of that argument is in `link-button.tsx`.
 */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize | LegacySize
  /** Shows a spinner, marks the button busy, and blocks further clicks. */
  loading?: boolean
  /** Announced to assistive tech while `loading`. Defaults to "Loading". */
  loadingLabel?: string
  /** Renders a square icon-only button. Requires an accessible `aria-label`. */
  'aria-label'?: string
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, loadingLabel, disabled, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // A submit button inside a form is the default for <button>, and
      // /check is a form: leaving this implicit meant a stray Enter keypress
      // submitted the upload form from the date field.
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          {/* The label stays in the DOM so the button does not resize mid-request. */}
          <span className="sr-only">{loadingLabel ?? 'Loading'}</span>
          <span className="invisible" aria-hidden="true">
            {children}
          </span>
        </>
      ) : (
        children
      )}
    </button>
  )
})

export type { ButtonSize, ButtonVariant } from '@/components/ui/button-classes'
