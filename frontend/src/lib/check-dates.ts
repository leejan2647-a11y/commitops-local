/**
 * The check window's default dates (Feature 5), pure.
 *
 * Extracted for the same reason every other page logic in this repo is: the
 * component tests are SSR via `renderToStaticMarkup`, so a component that
 * computes its own dates in render is untestable, and the interesting part
 * of this feature is entirely arithmetic - "today minus N days" across month
 * boundaries and leap years, and the rule that the baseline must end
 * strictly before the window starts.
 *
 * The example the owner specified, and the one the test pins verbatim:
 * today = 2026-10-02, default_date_range = 30 ->
 *   window  2026-09-02 .. 2026-10-02
 *   baseline 2026-08-03 .. 2026-09-01
 *
 * The arithmetic itself lives in `lib/window-choice` (`datesFromAnchor`), which
 * the check page's window dialog also uses anchored on the FILE's last day
 * rather than on today. One implementation, because two copies of "the baseline
 * ends the day before the window starts" is one copy that will eventually
 * disagree with the other - and which spelling of `baseline_start` is correct
 * has already changed once (D-119, then D-122).
 *
 * @param today injected so the arithmetic is testable without freezing the
 * clock - the page passes `new Date()`, the tests pass the spec's example.
 */
import { datesFromAnchor } from '@/lib/window-choice'

/** `YYYY-MM-DD`, which is what the API and `<input type="date">` both want.
 * Local, not UTC: customers think in local time, and a UTC midnight can be
 * yesterday or tomorrow depending on where they sit. */
export function isoDate(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export interface CheckDates {
  windowStart: string
  windowEnd: string
  baselineStart: string
  baselineEnd: string
}

/**
 * The four dates a check needs, from the browser's clock and the tenant's
 * configured range.
 *
 * windowEnd    = today
 * windowStart  = today - rangeDays days
 * baselineEnd  = windowStart - 1 day (the pipeline's own DataWindow refuses
 *               a baseline that ends on or after the window's first day, so
 *               this is the latest legal baseline, not a preference)
 * baselineStart = baselineEnd - rangeDays days
 *
 * The arithmetic itself now lives in `lib/window-choice` (`datesFromAnchor`),
 * which the check page's window dialog also uses anchored on the FILE's last
 * day. One implementation, because two copies of "baseline ends one day before
 * the window starts" is one copy that will eventually disagree with the other
 * and produce a 422 the user cannot see the cause of.
 *
 * @param today injected so the arithmetic is testable without freezing the
 * clock - the page passes `new Date()`, the tests pass the spec's example.
 */
export function resolveCheckDates(today: Date, rangeDays: number): CheckDates {
  return datesFromAnchor(isoDate(today), rangeDays)
}

/**
 * The tenant's `defaultDateRange` setting as a usable number of days.
 *
 * The settings page stores the string a `<select>` produces ("7" | "30" |
 * "60" | "90"); a hand-written value or a future rename may differ, so the
 * accepted spellings are the camelCase key the page writes, the snake_case
 * the API's own docs use, and anything unparseable or out of range falls
 * back to 30 - the same default the page shows, and the same fallback
 * decision, as the backend's sync endpoint.
 */
export const DEFAULT_RANGE_DAYS = 30

export function parseRangeDays(raw: unknown): number {
  const days = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(days) || days <= 0 || days > 366) return DEFAULT_RANGE_DAYS
  return days
}
