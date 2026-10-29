import { cn } from '@/lib/utils'

/**
 * A button's class list, as data.
 *
 * Its own module so `button.tsx` exports only the component, and so
 * `link-button.tsx` can style a react-router `<Link>` with exactly the same
 * classes. The nine pages previously wrote `<Link><Button/></Link>`, which is a
 * `<button>` inside an `<a>` - invalid HTML, two controls in the accessibility
 * tree where there is one, and a link that cannot be opened in a new tab. See
 * `link-button.tsx` for the whole argument.
 *
 * `only-export-components` is why this is separate: a module exporting both a
 * component and a plain function cannot be hot-reloaded without invalidating its
 * consumers. Same reason `/allocation`'s category table lives in `categories.ts`.
 */

export type ButtonVariant =
  /** Observatory's high-contrast primary action. */
  | 'primary'
  /** A raised surface. Secondary actions, and things adjacent to a primary. */
  | 'secondary'
  /** No fill until hover. Tertiary actions, toolbar buttons, row actions. */
  | 'ghost'
  /** Rose. Destructive and irreversible: delete, cancel a check, wipe. */
  | 'danger'
  /** A bordered control. Filters, and anywhere a fill would be too loud. */
  | 'outline'
  /** Text only, with an underline on hover. Inline actions in prose. */
  | 'link'
  /**
   * @deprecated Use `primary`. `default` was the shadcn name and is kept so the
   * pages keep compiling until every call site is migrated; deleted after that.
   */
  | 'default'
  /**
   * @deprecated Use `secondary` or `outline`. Kept for the same reason.
   */
  | 'secondary-legacy'
  /**
   * @deprecated Use `danger`.
   */
  | 'destructive'

export type ButtonSize =
  /** 44px on touch layouts, 32px from `md` up. Dense toolbars and table row
   *  actions. */
  | 'sm'
  /** 44px on touch layouts, 40px from `md` up. The default. */
  | 'md'
  /** 48px. Primary calls to action. */
  | 'lg'
  /** Square: 44x44 on touch layouts, 40x40 from `md` up. Icon-only buttons. */
  | 'icon'

/** @deprecated Use `md`. */
export type LegacySize = 'default'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-foreground text-accent-foreground hover:opacity-90',
  secondary: 'bg-surface-raised text-foreground border border-border hover:bg-surface-hover',
  ghost: 'text-muted-foreground hover:bg-surface-raised hover:text-foreground',
  danger: 'bg-danger text-danger-foreground shadow-card hover:brightness-110',
  outline: 'border border-border bg-transparent text-foreground hover:bg-surface-raised',
  link: 'text-accent underline-offset-4 hover:underline',
  // Transitional aliases. See the @deprecated notes on ButtonVariant.
  default: 'bg-foreground text-accent-foreground hover:opacity-90',
  'secondary-legacy': 'bg-surface-raised text-foreground border border-border hover:bg-surface-hover',
  destructive: 'bg-danger text-danger-foreground shadow-card hover:brightness-110',
}

/**
 * Every size carries a touch height and a desktop height, in that order.
 *
 * The `h-11` is not decoration: Step 6 measured real rendered geometry in a
 * 375px-wide frame against production and found 40px buttons and 40px form
 * fields - 4px under the 44px minimum, on every CTA in the app. The `md:`
 * override is the other half of the same finding. `md` is where this app grows
 * its sidebar (`hidden md:flex` in `layout.tsx`), and from there the pointer is
 * a mouse, so the dense sizes are allowed to be dense. One breakpoint, and it is
 * the same one the layout already uses, so the button density and the shell
 * change shape at exactly the same width.
 *
 * `h-11` before `md:h-N` in the string matters twice over: tailwind-merge keeps
 * both because the modifiers differ (D-58 - the keys are tailwind-merge's theme
 * buckets, so an unrecognised `md:h-8` would be dropped and the touch size would
 * win forever), and the *first* `h-N` in the class list is the touch height,
 * which is what the sizing test reads.
 */
const SIZES: Record<ButtonSize | LegacySize, string> = {
  sm: 'h-11 gap-1.5 rounded-md px-3 text-caption md:h-8',
  md: 'h-11 gap-2 rounded-md px-4 text-body md:h-10',
  lg: 'h-12 gap-2 rounded-md px-6 text-body',
  icon: 'h-11 w-11 rounded-md text-body md:h-10 md:w-10',
  default: 'h-11 gap-2 rounded-md px-4 text-body md:h-10',
}

/**
 * `no-underline` is in the base, not the `link` variant, because a react-router
 * `<Link>` carries the UA's default underline and a button-shaped link with an
 * underline under it is not a button.
 */
const BASE = [
  'inline-flex select-none items-center justify-center whitespace-nowrap font-medium no-underline',
  'transition-[background-color,box-shadow,color,filter] duration-landing ease-landing',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ')

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize | LegacySize = 'md',
  className?: string,
): string {
  return cn('flow-button', `flow-button-${variant}`, BASE, VARIANTS[variant], SIZES[size], className)
}
