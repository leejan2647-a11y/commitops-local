/**
 * The window picker (owner spec Part 2).
 *
 * Opens when the customer chooses a window, and exists because the four date fields
 * were previously seeded from the browser's clock: a customer with an August
 * export got an October window, three weeks of which are not in the file, and
 * a result that said "no anomalies" about the wrong period. The first line of
 * this dialog states the file's real span so the choice is made against facts.
 *
 * Props-driven and exported so the SSR tests can render every branch a click
 * would reach (`renderToStaticMarkup` cannot click a radio): each option, the
 * short-file case where the presets are hidden, and the "not enough history"
 * warning.
 *
 * It decides nothing itself: the dates come back through `onChoiceChange` and
 * the page applies them. That keeps the arithmetic in one tested place
 * (`lib/window-choice`) instead of inside a render.
 */
import { AlertTriangle } from 'lucide-react'

import { Dialog } from '@/components/ui/dialog'
import {
  type ChoiceSummary,
  type FileSpan,
  type WindowChoice,
  availableChoices,
  daysInFile,
  defaultChoice,
  describeChoice,
  hasEnoughHistory,
} from '@/lib/window-choice'

export interface WindowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm?: () => void
  /** Null while the file is being measured, or if the measurement failed. */
  span: FileSpan | null
  /** True while /api/uploads/inspect is in flight. */
  inspecting: boolean
  /** The measurement's failure, if it failed. */
  inspectError: string | null
  choice: WindowChoice
  onChoiceChange: (choice: WindowChoice) => void
}

const LABELS: Record<WindowChoice, string> = {
  d7: 'Last 7 days',
  d30: 'Last 30 days',
  d60: 'Last 60 days',
  d90: 'Last 90 days',
  d180: 'Last 180 days',
  full: 'Full range (whole file)',
  manual: 'Set dates manually',
}

const HINTS: Partial<Record<WindowChoice, string>> = {
  manual: 'Choose “Use these dates” to close this picker, then edit the window and baseline in the form. This does not submit a check.',
}

export function WindowDialog({
  open,
  onOpenChange,
  onConfirm,
  span,
  inspecting,
  inspectError,
  choice,
  onChoiceChange,
}: WindowDialogProps) {
  const days = span ? daysInFile(span.minDate, span.maxDate) : 0
  const choices = availableChoices(days)
  const effective = choices.includes(choice) ? choice : defaultChoice(days)
  // The owner's rule (2026-10-09): the warning fires when the BASELINE for
  // the selected choice is under 14 days - never because the window or the
  // file is short while the baseline still has history in it.
  const short =
    span !== null && !hasEnoughHistory(days, effective, span.minDate, span.maxDate)

  // A choice that is no longer offered must not stay selected: picking a file
  // with 60 days after a file with 200 would otherwise silently keep the
  // 90-day window and analyse 30 days that are not there.
  const summaries: Record<string, ChoiceSummary> = {}
  if (span) {
    for (const c of choices) summaries[c] = describeChoice(c, span.minDate, span.maxDate)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="How would you like to analyze?"
      description={
        inspecting
          ? 'Reading your file…'
          : span
            ? `Your file spans: ${span.minDate} → ${span.maxDate} (${days} day${days === 1 ? '' : 's'})`
            : 'We could not read the dates in this file.'
      }
      confirmLabel="Use these dates"
      onConfirm={onConfirm ?? (() => onOpenChange(false))}
    >
      <div className="space-y-4">
        {inspectError ? (
          <p role="alert" className="text-body text-danger">
            {inspectError} Using your saved date range instead — check the dates
            below before running the check.
          </p>
        ) : null}
        {short ? (
          <p role="status" className="flex items-start gap-2 text-body text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>The baseline for this choice is under 14 days — the comparison may be unreliable. A longer file (or a baseline file) gives a more reliable result.</span>
          </p>
        ) : null}

        <p className="text-body-sm text-muted-foreground">
          Preset windows include both the start date and the end date.
        </p>

        <fieldset className="space-y-2">
          <legend className="sr-only">Analysis window</legend>
          {choices.map((c) => {
            const summary = summaries[c]
            const id = `window-choice-${c}`
            return (
              <label
                key={c}
                htmlFor={id}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
              >
                <input
                  id={id}
                  type="radio"
                  name="window-choice"
                  className="mt-1"
                  checked={effective === c}
                  onChange={() => onChoiceChange(c)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">{LABELS[c]}</span>
                  {summary ? (
                    <>
                      <span className="block text-caption text-muted-foreground">
                        Window: {summary.window}
                      </span>
                      <span className="block text-caption text-muted-foreground">
                        Baseline: {summary.baseline}
                      </span>
                    </>
                  ) : null}
                  {summary?.warning ? (
                    <span className="block text-caption text-warning">{summary.warning}</span>
                  ) : null}
                  {HINTS[c] ? (
                    <span className="block text-caption text-muted-foreground">{HINTS[c]}</span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </fieldset>

      </div>
    </Dialog>
  )
}
