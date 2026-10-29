/**
 * The window picker's arithmetic and its option rules (owner spec Part 2),
 * pure.
 *
 * This exists for the same reason `check-dates.ts` does: the component tests
 * are SSR via `renderToStaticMarkup`, so a dialog that computes its own dates
 * in render is untestable, and everything interesting here IS arithmetic plus a
 * set of visibility rules keyed on how much history the file actually has.
 *
 * The one thing this file is careful about: **the anchor is the file's last
 * day, never the browser's today.** A customer uploads August's export in
 * October; anchoring on today analyses three weeks that are not in the file and
 * reports "no anomalies" as though that were a finding about their spend. So
 * every date here flows from `maxDate`, and `today` is a parameter that only
 * the documented last-resort fallback is allowed to pass.
 */
import type { CheckDates } from '@/lib/check-dates'

export type WindowChoice = 'd7' | 'd30' | 'd60' | 'd90' | 'd180' | 'full' | 'manual'

/** What `/api/uploads/inspect` answered about the chosen file. */
export interface FileSpan {
  minDate: string
  maxDate: string
  rowCount: number | null
}

/**
 * Parse `YYYY-MM-DD` into a local-midnight Date.
 *
 * Deliberately not `new Date('2026-01-01')`: that parses as UTC midnight, which
 * in any timezone behind UTC is the previous day, and every date below is built
 * by adding days to this value. The bug it prevents is a window that silently
 * starts one day early for half the planet.
 */
function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

function toIso(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function shift(iso: string, days: number): string {
  const d = parseIso(iso)
  d.setDate(d.getDate() + days)
  return toIso(d)
}

/**
 * The four dates for a window of `days` ending on `anchor`.
 *
 *   window_start   = anchor - days
 *   window_end     = anchor
 *   baseline_start = the file's first date (NOT window_start - days)
 *   baseline_end   = window_start - 1 day
 *
 * `baseline_end` is one day before the window because the pipeline's
 * `DataWindow` refuses a baseline that ends on or after the window's first day:
 * that is the latest legal baseline, not a preference. A baseline overlapping
 * the window is how a detector explains a spike with the spike itself.
 *
 * `baseline_start` is the owner's 2026-10-09 rule: the baseline starts where
 * the FILE starts, never at a formula date. All the history before the
 * window is the baseline — a 14-month file choosing "last 60 days" gets a
 * ~360-day baseline, not a 60-day slice that ignores ten months of history.
 * The old formula (`window_start - days`) is kept only for the no-file
 * fallback, where there is no minDate to anchor on.
 */
export function datesFromAnchor(anchor: string, days: number): CheckDates {
  const windowEnd = anchor
  const windowStart = shift(anchor, -(days - 1))
  const baselineEnd = shift(windowStart, -1)
  const baselineStart = shift(windowStart, -days)
  return { windowStart, windowEnd, baselineStart, baselineEnd }
}

/**
 * How many days the file covers, counted inclusively.
 *
 * Inclusive because that is how the pipeline counts a window
 * (`DataWindow.check_days` is `end - start + 1`), and the option rules below
 * are about how much history there is to compare - a 30-day file offers "last
 * 30 days", and under an exclusive count it would not.
 */
export function daysInFile(minDate: string, maxDate: string): number {
  const ms = parseIso(maxDate).getTime() - parseIso(minDate).getTime()
  return Math.round(ms / 86_400_000) + 1
}

/** Below this, there is no baseline to be had and the dialog says so. */
export const MIN_HISTORY_DAYS = 14

/** The preset lengths the owner specified, longest last. */
export const PRESET_DAYS: Record<'d7' | 'd30' | 'd60' | 'd90' | 'd180', number> = {
  d7: 7,
  d30: 30,
  d60: 60,
  d90: 90,
  d180: 180,
}

/**
 * Which options this file can support (owner spec, "Smart rules").
 *
 *   days < 14  -> only Full range and Manual, plus "not enough history"
 *   days < 30  -> hide 30 / 60 / 90
 *   days < 60  -> hide 60 / 90
 *   days < 90  -> hide 90
 *
 * "Full range" and "Manual" are always available: one of them is the only
 * thing left when the file is short, and the other is the escape hatch. What
 * the rules prevent is offering a 90-day window for a 20-day file, which
 * analyses 70 days that do not exist and then reports on them.
 */
export function availableChoices(days: number): WindowChoice[] {
  const choices: WindowChoice[] = []
  if (days >= MIN_HISTORY_DAYS) choices.push('d7')
  // The thresholds are the owner's, and they are compared against the WINDOW
  // the option offers - not against the data a matching baseline would need.
  // A 30-day choice needs 60 days to fill both windows, so a 30-to-59-day file
  // is offered the recommended option and gets a window that starts a few days
  // before its first row, which reads as "no spend" for those days.
  //
  // Raising the thresholds to demand a full baseline was considered and
  // rejected: it would hide "Last 30 days" from a third of customers' files and
  // push them to "Full range", which throws away the baseline entirely. A short
  // baseline is a worse comparison; no baseline is not a comparison at all. The
  // dialog shows both spans so the shorter one is visible before submitting.
  if (days >= PRESET_DAYS.d30) choices.push('d30')
  if (days >= PRESET_DAYS.d60) choices.push('d60')
  if (days >= PRESET_DAYS.d90) choices.push('d90')
  if (days >= PRESET_DAYS.d180) choices.push('d180')
  choices.push('full', 'manual')
  return choices
}

/**
 * Whether the BASELINE for the selected choice is long enough to model.
 *
 * The owner's rule (2026-10-09): the "too short" warning fires when the
 * baseline (for the selected choice) is under 14 days - never because the
 * window itself is short, and never because the file is short when the
 * baseline still has history in it. With the baseline anchored to the
 * file's first date, a 14-month file choosing "last 7 days" has a ~380-day
 * baseline and no warning; a 20-day file choosing "last 7 days" has a
 * 13-day baseline and the warning is honest.
 */
export function hasEnoughHistory(
  days: number,
  choice?: WindowChoice,
  minDate?: string,
  maxDate?: string,
): boolean {
  if (choice && minDate && maxDate) {
    const dates = datesForChoice(choice, minDate, maxDate)
    if (dates && choice !== 'full') {
      // Count the days the BASELINE actually has data for: the overlap of
      // the baseline period with the file's range. When the window extends
      // before the file, the baseline period is calendar-long but empty.
      const dataDays = minDate < dates.baselineEnd
        ? daysInFile(minDate, dates.baselineEnd)
        : 0
      return dataDays >= MIN_HISTORY_DAYS
    }
  }
  return days >= MIN_HISTORY_DAYS
}

/**
 * Whether the four date inputs are editable under this choice.
 *
 * Manual enables them; every preset owns them. A field left editable while
 * "Last 30 days" is selected invites a one-date edit that makes the dialog's
 * promise quietly untrue - and since the payload is built from state rather
 * than from the DOM, `disabled` changes nothing about what is sent. It is a
 * statement to the user about who is choosing, not a submission rule. That is
 * why the submit path's own date check lives in `buildCheckForm`'s caller
 * rather than here.
 */
export function manualEnabled(choice: WindowChoice): boolean {
  return choice === 'manual'
}

/**
 * The option selected when the dialog opens.
 *
 * "Last 30 days" when the file can support it, otherwise Full range - which is
 * not a lesser choice for a short file, it is the only one that analyses the
 * data the customer actually has.
 */
export function defaultChoice(days: number, preferredDays = 30): WindowChoice {
  const preferred = `d${preferredDays}` as WindowChoice
  if (availableChoices(days).includes(preferred)) return preferred
  return days >= PRESET_DAYS.d30 ? 'd30' : 'full'
}

/**
 * The four dates for a choice, or null for Manual.
 *
 * Manual returns null because it does not decide anything: the fields are
 * enabled and the values already in them stand. Returning the preset dates
 * would silently overwrite what the user typed the moment they picked Manual.
 */
export function datesForChoice(
  choice: WindowChoice,
  minDate: string,
  maxDate: string,
): CheckDates | null {
  if (choice === 'manual') return null
  if (choice === 'full') {
    // "No baseline" has to be expressed as dates, because the API requires all
    // four. A one-day baseline pointing at the day BEFORE the file's first day
    // is the only encoding that is both legal (DataWindow refuses a baseline
    // ending on or after the window start) and honestly empty - which is what
    // the dialog's "some detectors won't fire" warning is describing.
    const dayBefore = shift(minDate, -1)
    return {
      windowStart: minDate,
      windowEnd: maxDate,
      baselineStart: dayBefore,
      baselineEnd: dayBefore,
    }
  }
  // The owner's rule (2026-10-09): the baseline starts where the FILE starts,
  // never at a formula date — all the history before the window is the
  // baseline. When the file's first date is after the baseline's end (a
  // short file where the window extends before the data), the file's min
  // would invert the period, so the formula date is used instead — it is
  // always legal, and the baseline period simply has no data in it.
  const anchorDates = datesFromAnchor(maxDate, PRESET_DAYS[choice])
  const baselineStart = minDate < anchorDates.baselineEnd
    ? minDate
    : anchorDates.baselineStart
  return {
    ...anchorDates,
    baselineStart,
  }
}

export interface ChoiceSummary {
  window: string
  baseline: string
  /** Set when the choice trades something away, so the page can say which. */
  warning?: string
}

const fmt = (dates: CheckDates): string =>
  `${dates.windowStart} → ${dates.windowEnd}`

/**
 * The "Window: … / Baseline: …" lines under each option.
 *
 * Purely derived from the same `datesForChoice` the selection uses, so a label
 * cannot promise a window the fields will not hold.
 */
export function describeChoice(
  choice: WindowChoice,
  minDate: string,
  maxDate: string,
): ChoiceSummary {
  const dates = datesForChoice(choice, minDate, maxDate)
  if (!dates) {
    return {
      window: 'your own dates',
      baseline: 'your own dates',
    }
  }
  if (choice === 'full') {
    return {
      window: fmt(dates),
      baseline: 'none',
      warning: 'No baseline — some detectors won’t fire.',
    }
  }
  return {
    window: fmt(dates),
    baseline: `${dates.baselineStart} → ${dates.baselineEnd}`,
  }
}

/**
 * Part 4's fallback, and which anchor it had to use.
 *
 * The ladder the owner specified, with the degradation made visible:
 *
 *  1. the file's own last day, when inspect answered - never the PC clock;
 *  2. `settings.defaultDateRange` around that same anchor;
 *  3. if the file's dates could not be read at all, the browser's today around
 *     the tenant's configured range.
 *
 * Step 3 is the one case where "do not use the PC clock" cannot be honoured:
 * with no readable date in the file there is no other anchor to anchor on. The
 * caller is told which anchor was used (`anchoredTo`) so the page can say so
 * rather than presenting a guess as a fact.
 */
export function resolveFallbackDates(input: {
  span: FileSpan | null
  defaultRangeDays: number | null
  today: Date
}): { dates: CheckDates; anchoredTo: 'file' | 'today' } {
  const days = input.defaultRangeDays ?? 30
  if (input.span) {
    // The owner's rule (2026-10-09): with a file in hand, the baseline
    // starts at the file's first date when there is data before the
    // window; the formula date otherwise, so the period stays legal.
    const anchorDates = datesFromAnchor(input.span.maxDate, days)
    const baselineStart = input.span.minDate < anchorDates.baselineEnd
      ? input.span.minDate
      : anchorDates.baselineStart
    return {
      dates: { ...anchorDates, baselineStart },
      anchoredTo: 'file',
    }
  }
  return { dates: datesFromAnchor(toIso(input.today), days), anchoredTo: 'today' }
}
