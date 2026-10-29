/**
 * The vocabularies the findings filters offer.
 *
 * These are data, not decoration, and they are half of a cross-boundary
 * contract: the backend decides which detectors, severities and states exist
 * (`DetectorType` and `Severity` in `commitops-api/app/pipeline/types.py`), and
 * this file decides what the user is offered to filter by.
 *
 * Nothing connected the two, which is the same failure as D-48 on the allocation
 * page, where the frontend described four categories the pipeline has never
 * emitted. `detector-types.test.ts` reads the backend source rather than
 * restating the list here, because a hand-copied list is a fourth copy of a
 * contract and would drift the same way.
 *
 * A detector the backend can emit but this page does not offer is not a cosmetic
 * gap: it is a class of finding that cannot be filtered for and reads as absent.
 *
 * These are its own module because `page.tsx` is a component file, and
 * `react/only-export-components` objects to a module exporting both. Same reason
 * `/allocation`'s category table lives in `categories.ts`.
 */

/**
 * Every detector the pipeline can run.
 *
 * The API returns the raw kebab-case `detector_type` and does not expose the
 * backend's `DETECTOR_LABELS` table, so the filter option is the wire value
 * humanised. Deriving the label mechanically rather than keeping a second label
 * table here is deliberate: a hand-written label map is a second vocabulary, and
 * the allocation page already shipped one that described things the pipeline
 * could not produce. If richer labels are wanted, they should come from the API
 * rather than be retyped on the frontend.
 */
export const DETECTOR_TYPES = [
  'unexpected-charge',
  'spike',
  'gradual-creep',
  'new-charge',
  'usage-cost-mismatch',
  'marketplace',
  'expectation-mismatch',
  'unused-commitment',
] as const

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

/** `FindingState.status` on the backend. */
export const FINDING_STATUSES = ['open', 'investigating', 'resolved', 'archived'] as const

export type DetectorType = (typeof DETECTOR_TYPES)[number]

/**
 * `usage-cost-mismatch`, not "usage cost-mismatch".
 *
 * The first draft used `t.replace('-', ' ')` in one place and
 * `replace(/-/g, ' ')` in another, so the type filter read "usage
 * cost-mismatch" while the table read "usage cost mismatch" for the same value.
 * One transform, applied everywhere.
 */
export const humanise = (value: string): string => value.replace(/-/g, ' ')
