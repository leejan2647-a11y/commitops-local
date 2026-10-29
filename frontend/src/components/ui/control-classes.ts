import { cn } from '@/lib/utils'

/**
 * The shared control styling for `Input`, `Textarea` and `Select`.
 *
 * Its own module because `field.tsx` exports `Field` alongside it, and
 * `react/only-export-components` objects to a file that exports both a
 * component and a plain function - the rule exists because a module exporting
 * both cannot be hot-reloaded without invalidating consumers. That is the same
 * reason `/allocation`'s category table lives in `categories.ts` rather than in
 * `page.tsx`.
 *
 * The focus treatment is a 2px cyan ring *plus* a cyan border, not an outline.
 * The global `:focus-visible` rule in `index.css` gives every focusable element
 * an outline (D-56), and that is right for buttons and links - but on a text
 * field an outline sits outside the border and reads as a separate artefact,
 * whereas a ring reads as the border getting brighter, which is what focusing a
 * field actually means.
 *
 * `min-h-11` is the 44px touch floor, and it is a *min* so a `Textarea` with
 * `rows={6}` grows instead of being pinned. Step 6 measured these fields at
 * 40px tall in a 375px-wide frame against production: `py-2` plus a one-line
 * `text-body` is 40px, which looks right on a desktop and is 4px under the
 * minimum on a phone. `Input` and `Select` set their own height on top of this,
 * but they need the floor too - an `Input` with a custom className must not be
 * able to opt out of it by accident.
 */
export const controlClasses = (invalid: boolean): string =>
  cn(
    'flow-control',
    'w-full min-h-11 rounded-md border bg-surface-alt px-3 py-2 text-body text-foreground',
    'placeholder:text-subtle',
    'transition-[border-color,box-shadow] duration-landing ease-landing',
    'focus:outline-none focus:ring-2',
    'disabled:cursor-not-allowed disabled:opacity-50',
    invalid
      ? 'border-danger focus:border-danger focus:ring-danger/40'
      : 'border-input focus:border-accent focus:ring-accent/40',
  )
