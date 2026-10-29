import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The design system's type and colour names, declared to tailwind-merge so it
 * can tell them apart.
 *
 * `twMerge` resolves conflicts by class *group*, and it infers the group from
 * the utility prefix plus the theme. Its default theme does not know this
 * system's names, so it classified every `text-*` class as a font size - the
 * `font-size` group matches `text-{size}` and `accent` is not a known size, so
 * it fell through to the same catch-all the sizes used.
 *
 * The result was silent and total: the last `text-*` class won, so combining a
 * size with a colour deleted the colour. Every `Button` lost its text colour -
 * `<Button>Run check</Button>` rendered `bg-accent` with no foreground class at
 * all, and `text-body` was thrown away instead. The build was green, the type
 * check was green, and the only symptom was cyan-on-cyan text in a browser.
 *
 * The keys are tailwind-merge's *theme bucket* names (`text` and `color`), not
 * its class-group names (`font-size` and `text-color`). The class-group names
 * are what the buckets are called in `classGroups`; passing those to `theme` is
 * accepted and does nothing, which is a second way to believe this is fixed
 * when it is not.
 *
 * Both lists are asserted against `tailwind.config.js` and `tokens.ts` by
 * `src/styles/tokens.test.ts`, so adding a colour or a size without declaring
 * it here fails a test rather than a visual review.
 */
export const MERGE_FONT_SIZES = [
  'display-1',
  'display-2',
  'h1',
  'h2',
  'h3',
  'body',
  'caption',
  'mono',
] as const

export const MERGE_COLORS = [
  'accent',
  'accent-border',
  'accent-foreground',
  'accent-hover',
  'accent-tint',
  'base',
  'base-raised',
  // `background`/`background-foreground` and `primary`/`primary-foreground`
  // were here while the transitional alias blocks existed; both blocks were
  // deleted at the end of Step 3, so both names are gone from the config and
  // from this list. `cn.test.ts` asserts the two agree in both directions, so
  // re-adding either name without re-adding the block fails a test rather than
  // leaving tailwind-merge classifying a colour that does not resolve.
  'border',
  'card',
  'card-foreground',
  'danger',
  'danger-foreground',
  'danger-tint',
  'foreground',
  'info',
  'info-tint',
  'input',
  'muted',
  'muted-foreground',
  'popover',
  'popover-foreground',
  'ring',
  'subtle',
  'success',
  'success-tint',
  'surface',
  'surface-alt',
  'surface-hover',
  'surface-raised',
  'violet',
  'warning',
  'warning-tint',
] as const

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // The type scale, from `fontSize` in tokens.ts.
      text: [...MERGE_FONT_SIZES],
      // Every colour utility the Tailwind config defines.
      color: [...MERGE_COLORS],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(date: Date | string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date))
}

export function formatDateTime(date: Date | string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date))
}
