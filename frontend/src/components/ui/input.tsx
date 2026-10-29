import * as React from 'react'

import { cn } from '@/lib/utils'
import { controlClasses } from '@/components/ui/control-classes'

/**
 * Input, Textarea and Select.
 *
 * Hand-rolled, Task F.1c Step 2. The three share `controlClasses` from
 * `field.tsx`; what differs is the element and the sizing, and that is all.
 *
 * The `error` prop is what makes these three worth rebuilding. Previously the
 * only way to show an invalid field was to pass a className, which meant every
 * call site that forgot it showed a grey border next to a red sentence - and
 * `aria-invalid` was never set at all, so a screen reader user was told the
 * form was fine. Now the error sets the border, the ring and `aria-invalid`
 * together, and there is no way to get one without the others.
 *
 * `Textarea` did not exist before; `/check`'s "what went wrong" server message
 * and the notes fields want one.
 */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Sets the danger border and `aria-invalid`. Pair with a `Field` for the message. */
  error?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error = false, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={error || undefined}
      className={cn(
        controlClasses(error),
        // Touch height first, desktop height from `md` up - see SIZES in
        // button-classes.ts for why it is one breakpoint and why the order
        // matters. `h-11 md:h-10`, not `h-10`: Step 6 measured this field at
        // 40px in a 375px frame.
        'h-11 md:h-10',
        // Tailwind's preflight kills the native file button, which leaves a
        // file input looking like a plain text field with no affordance. /check
        // uploads a CSV here, so the button is put back rather than removed.
        'file:mr-3 file:rounded-sm file:border-0 file:bg-accent-tint file:px-2 file:py-1',
        'file:text-caption file:font-medium file:text-accent',
        className,
      )}
      {...props}
    />
  )
})

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, error = false, rows = 4, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={error || undefined}
      className={cn(controlClasses(error), 'leading-relaxed', className)}
      {...props}
    />
  )
})
