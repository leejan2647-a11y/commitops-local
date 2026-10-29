import * as React from 'react'

/**
 * One piece of state that works controlled or uncontrolled.
 *
 * Used by `Tabs`, `Dialog` and `DropdownMenu`, all of which need the same
 * answer to the same question: who owns this value?
 *
 * The reason it is not just `useState` is testability without a new dependency.
 * The suite is server-rendered (`renderToStaticMarkup`) because F.1c adds no
 * packages, and there is no DOM to fire events in. A controlled primitive
 * renders identically on the server and the client, so its initial output -
 * which tab is selected, whether a dialog is open - is assertable from a
 * snapshot. An uncontrolled one is not: its first render is whatever
 * `useState` was seeded with, and nothing in an SSR test can move it.
 *
 * The one behaviour worth being careful about: when a component switches from
 * uncontrolled to controlled it warns, and React only warns if the *initial*
 * `controlled` argument changes identity. Passing `value={undefined}` then
 * later a real value is the case that bites, so the flag is tracked explicitly
 * rather than inferred.
 */
export interface ControllableOptions<T> {
  /** The controlled value. `undefined` means "this component owns it". */
  value?: T
  /** The uncontrolled seed. Ignored once `value` is provided. */
  defaultValue?: T
  onChange?: (value: T) => void
}

export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: ControllableOptions<T>): [T, (next: T) => void] {
  const [uncontrolled, setUncontrolled] = React.useState<T>(defaultValue as T)
  const isControlled = value !== undefined
  const onChangeRef = React.useRef(onChange)
  const wasControlled = React.useRef(isControlled)

  // Both refs are synced in an effect rather than assigned during render.
  //
  // Assigning a ref during render is a side effect in the render phase, and a
  // render can be discarded - React throws away the work of a component whose
  // render was interrupted, or whose output it never committed - so the ref can
  // end up holding a value from a render that did not happen. Here the write is
  // idempotent, so nothing is actually corrupted, which is exactly why it is
  // worth fixing: an idempotent violation is the kind that survives review and
  // then gets copied into a hook where the write is not idempotent.
  //
  // An effect is not too late. React flushes passive effects before it handles
  // a discrete event, so by the time a click reaches `set` both refs are
  // current. Neither hook is ever called during server rendering, where effects
  // do not run, which is why the SSR tests in `tabs.test.tsx` and
  // `overlays.test.tsx` are unaffected.
  React.useEffect(() => {
    onChangeRef.current = onChange
    wasControlled.current = isControlled
  })

  const current = isControlled ? (value as T) : uncontrolled

  // `[]` deliberately: `set` must keep one identity for the component's life, so
  // it reads the live values through the refs above rather than closing over the
  // props from whichever render created it.
  const set = React.useCallback((next: T) => {
    if (!wasControlled.current) setUncontrolled(next)
    onChangeRef.current?.(next)
  }, [])

  return [current, set]
}
