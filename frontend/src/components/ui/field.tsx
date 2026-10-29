import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Field: label, control, hint and error, wired together.
 *
 * Hand-rolled, Task F.1c Step 2. No component library.
 *
 * This exists because the three form controls needed the same four things and
 * each was doing them slightly differently, which is how a form ends up with an
 * error message that is red text next to a field with a grey border and no
 * `aria-invalid` - a user who cannot see the field is red and a screen reader
 * that is not told anything is wrong.
 *
 * What it guarantees, for every control that uses it:
 *
 * 1. `id` is generated once and shared by the label, the control and both
 *    messages, so the label is genuinely associated with the control. A
 *    `<label>` with no `htmlFor` and no wrapping control associates with
 *    nothing, and clicking the label does not focus the field.
 * 2. `aria-invalid` is set on the control whenever there is an error, and
 *    `aria-describedby` points at whichever message exists. If the hint is
 *    replaced by the error, the reference must change too or the description
 *    silently becomes the old text.
 * 3. The error is `role="alert"`, so it is announced when it appears rather
 *    than waiting to be found.
 * 4. The error is `danger`, and the border is `danger` - the same colour, so
 *    the state is legible from the border alone without reading the message.
 *
 * The hint and the error never both render: two stacked messages under a field
 * on a 375px screen push the submit button below the fold, and the error is the
 * one that matters.
 */

let sequence = 0

/**
 * A stable id for a field with no explicit one.
 *
 * A module-level counter rather than `useId()` because `useId` is React 18+ and
 * the control's id has to be readable in a server-rendered snapshot, where
 * `useId` produces different values on the client and the hydration mismatch is
 * noise in a test that is trying to assert something else.
 */
function useFieldId(explicit?: string): string {
  const generated = React.useMemo(() => `field-${++sequence}`, [])
  return explicit ?? generated
}

export interface FieldProps {
  /** Passed to the control's `id`; also wires label, hint and error. */
  id?: string
  label: string
  /** A short hint under the control. Hidden when there is an error. */
  hint?: string
  /** The error. Replaces the hint and sets `aria-invalid` on the control. */
  error?: string
  /** Appends a visible and announced "required" marker. */
  required?: boolean
  className?: string
  children: (control: {
    id: string
    'aria-invalid': true | undefined
    'aria-describedby': string | undefined
  }) => React.ReactNode
}

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const controlId = useFieldId(id)
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  // The error replaces the hint, so the description follows whichever exists.
  // Pointing at both would read the stale hint out loud after a failure.
  const describedBy = error ? errorId : hint ? hintId : undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className="text-caption font-medium text-muted-foreground">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      {children({
        id: controlId,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })}

      {error ? (
        <p id={errorId} role="alert" className="text-caption font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-caption text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
