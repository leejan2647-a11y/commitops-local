/**
 * The Allocation page's five categories, and what each one means.
 *
 * These live outside `page.tsx` for the same reason `REQUIRED_COLUMNS` lives
 * outside its component: `react/only-export-components` forbids a module that
 * exports both components and plain data, and a category table *is* data, not
 * decoration.
 *
 * `CATEGORIES` is the frontend half of a contract whose authority is the
 * backend's `ALLOCATION_CATEGORIES`. The two drifted apart silently: the map
 * used to list `intentionally-held`, `data-incomplete`, `cross-account` and
 * `coverage-gap`, none of which the pipeline has ever emitted, while the real
 * `unused`, `unallocated`, `expired` and `mismatched-region` had no entry. Four
 * of the five rows therefore rendered as "Pipeline-derived category" - verified
 * live, where the `unused` row did exactly that.
 *
 * `categories.test.ts` reads the backend source and fails if the two lists ever
 * stop matching, so this cannot rot again unnoticed.
 */
export const CATEGORIES = [
  {
    key: 'unused',
    description: 'Bought and never consumed at all',
  },
  {
    key: 'underutilised',
    description: 'Purchased capacity not actively consumed',
  },
  {
    key: 'unallocated',
    description: 'Consumed, but not attributable to a single account',
  },
  {
    key: 'expired',
    description: 'Term ended with unused commitment',
  },
  {
    key: 'mismatched-region',
    description: 'Consumed outside the region it was bought for',
  },
] as const

export const CATEGORY_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.description]),
)

/**
 * Explain unsupported classifications without claiming that fields or
 * reservations are absent from every export. Validated unused money remains
 * accounted for in the supported categories.
 */
export const NON_DERIVABLE_EXPLANATIONS: Record<string, string> = {
  expired:
    'Expiry is not currently assessed. CUR exports may include term-end dates; measured unused money remains in the supported categories.',
  'mismatched-region':
    'Region mismatch is not currently assessed. This does not imply that your export has no Reserved Instances; measured unused money remains in the supported categories.',
}

/**
 * The honest label for a category not assessed. Never a $0: a $0
 * would claim the category was checked and found zero.
 */
export const NON_DERIVABLE_LABEL = 'Classification unavailable'
