import { usePrivateApi } from '@/lib/private-queries'
import { effectiveFileLimit, formatPlanBytes, primaryFilesError } from '@/lib/plan-limits'
import type { Plan } from '@/lib/types'
import { EntitlementStatus } from '@/components/entitlement-status'
import { useIdentityGuard } from '@/lib/use-auth'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Upload } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LinkButton } from '@/components/ui/link-button'
import { ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { PageSkeleton } from '@/components/page-skeleton'
import { formatCents } from '@/lib/api'
import { useCheck, useCheckStatus, useCreateCheck, useInspectUpload, usePlan, useSettings, useUploads } from '@/lib/queries'
import { CheckFailureCard } from '@/app/check/failure-card'
import type { FailureKind } from '@/app/check/failure-card'
import { parseCanonicalRefusal } from './canonical-refusal'
import { describeError, isInspectionFormatError, isSafetyRefusal, isUploadRejection, parsePlanRefusal, summariseRejection } from '@/app/check/rejection'
import { BaselineSection } from '@/app/check/baseline-section'
import { WindowDialog } from '@/app/check/window-dialog'
import { submissionKeys } from '@/lib/submission-key'
import { buildCheckForm } from '@/lib/check-form'
import { parseRangeDays, resolveCheckDates } from '@/lib/check-dates'
import type { BaselineChip } from '@/lib/baseline-chips'
import { inspectFile, type FileInspection } from '@/lib/inspect-file'
import {
  type FileSpan,
  type WindowChoice,
  datesForChoice,
  defaultChoice,
  daysInFile,
  manualEnabled,
  resolveFallbackDates,
} from '@/lib/window-choice'

type RunStep = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'archived'

/**
 * The plan's submission limits, as one sentence (Task 6).
 *
 * `-1` is the backend's "unlimited" sentinel; rendering it as a number would
 * read as a real limit of minus one.
 */
function describePlanLimits(plan: Plan): string {
  const batch =
    plan.files_per_batch! < 0 ? 'unlimited files' : `${plan.files_per_batch} file${plan.files_per_batch === 1 ? '' : 's'}`
  const day =
    plan.checks_per_day == null ? 'Check allowance unavailable' : plan.checks_per_day < 0
      ? 'unlimited checks per rolling 24 hours'
      : `${plan.checks_per_day} checks per rolling 24 hours (${plan.checks_per_day_used ?? 'unavailable'} accepted)`
  return `${batch} per check · ${day} · plan technical ceiling ${formatPlanBytes(plan.max_file_bytes)} per primary file · effective primary file limit ${formatPlanBytes(effectiveFileLimit(plan))}`

}

/**
 * The action a low-confidence result implies (Task 6): one sentence the
 * customer can act on, chosen by the recorded assessment - the caveats list
 * under it keeps the specifics.
 */
function lowConfidenceAdvice(assessment: string | undefined, caveats: string[]): string {
  if (assessment === 'no_data') {
    return 'What you can do: choose window dates your export actually covers, then run the check again.'
  }
  if (assessment === 'refused') {
    return 'What you can do: the baseline must end the day before the window starts - adjust the dates, or upload a baseline file so its own history is used.'
  }
  if (assessment === 'limited') {
    if (caveats.some(note => /manifest/i.test(note))) {
      const baselineLimited = caveats.some(note => /baseline.*(?:short|insufficient|no |missing)|(?:few|insufficient).*days/i.test(note))
      return `What you can do: verify the export manifest and its file list to establish whether the selected export is complete.${baselineLimited ? ' Also supply the missing baseline history described below.' : ''}`
    }
    return 'What you can do: upload a baseline file with more history (or widen the baseline dates) so the comparison is reliable.'
  }
  return 'What you can do: review the notes below before drawing a conclusion from this check.'
}

/** Clarify two different coverage measures without changing saved diagnostics. */
function coverageCaveat(note: string): string {
  return note
    .replace(/^Only (\d+) days of comparison data are available\./, (_match, days: string) =>
      `Observed comparison data covers ${days} ${days === '1' ? 'day' : 'days'}.`)
    .replace(/^baseline-too-short: the baseline covers (\d+) day\(s\)/, (_match, days: string) =>
      `Requested baseline calendar span covers ${days} ${days === '1' ? 'day' : 'days'}`)
}

/** Backend phases mapped onto the three visual steps. */
const PHASE_TO_STEP: Record<string, number> = {
  ingest: 0,
  validate: 0,
  baseline: 1,
  detect: 1,
  evidence: 2,
  commitments: 2,
}

const STEP_LABELS = ['Validating data', 'Analyzing billing patterns', 'Detecting anomalies']

export function CheckCharges() {
  const {apiFetch}=usePrivateApi()
  const isCurrentIdentity = useIdentityGuard()
  // Feature 5: the four dates default to the tenant's own range around
  // TODAY, computed when the settings resolve and until the user edits one.
  // Feature 2 of the current spec replaces that with the chosen FILE's own
  // span the moment a file is picked (see `onFileChosen`); this seed is what
  // the page shows before that, and what Part 4's fallback falls back to.
  // The literals this state used to hold were pinned to August 2024 - two
  // years stale and invisible until submit. Empty until seeded: an empty
  // date input renders as "pick a date", which is honest, unlike a 2024
  // prefill that would analyse the wrong window looking deliberate.
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [baselineStart, setBaselineStart] = useState('')
  const [baselineEnd, setBaselineEnd] = useState('')
  const datesTouched = useRef(false)

  // Features 4/6: the file-baseline selection and its library picker.
  const [useFiles, setUseFiles] = useState(false)
  const [chips, setChips] = useState<BaselineChip[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryFilters, setLibraryFilters] = useState({ search: '', from: '', to: '' })
  const [libraryOffset, setLibraryOffset] = useState(0)

  // Choosing a file detects dates; the customer opens the picker, anchored to
  // the dates the FILE covers rather than to today. Declared with the other
  // state and above the seeding effect below, which writes `anchoredTo`.
  const [windowOpen, setWindowOpen] = useState(false)
  const [choice, setChoice] = useState<WindowChoice>('d30')
  // Which anchor the four dates came from. 'today' means the settings seed or
  // the Part 4 fallback produced them from the browser's clock - the page says
  // so rather than letting a guess about an old export look like a fact about
  // it.
  const [anchoredTo, setAnchoredTo] = useState<'file' | 'today' | null>(null)
  const inspect = useInspectUpload()
  const [fileInspection, setFileInspection] = useState<FileInspection | null>(null)
  const span: FileSpan | null = fileInspection
  const [inspectionError, setInspectionError] = useState<string | null>(null)
  const [windowConfirmed, setWindowConfirmed] = useState(false)
  const confirmedChoice = useRef<WindowChoice>('d30')
  const inspectionRequest = useRef(0)
  const inspectionAbort = useRef<AbortController | null>(null)
  useEffect(() => () => {
    inspectionRequest.current++
    inspectionAbort.current?.abort()
  }, [])
  const [isInspecting, setIsInspecting] = useState(false)

  const settingsQuery = useSettings()
  const uploadsQuery = useUploads(libraryFilters.search, libraryFilters.from, libraryFilters.to,
    libraryOpen && !(libraryFilters.from && libraryFilters.to && libraryFilters.from > libraryFilters.to), libraryOffset)
  // Task 6: the plan's limits, shown next to the file picker BEFORE the
  // customer submits - the boundary is learned from the form, not from a
  // 402 after choosing the files.
  const planQuery = usePlan()
  const plan = planQuery.error ? null : (planQuery.data ?? null)

  useEffect(() => {
    if (datesTouched.current || !settingsQuery.data) return
    const days = parseRangeDays((settingsQuery.data.settings ?? {}).defaultDateRange)
    const resolved = resolveCheckDates(new Date(), days)
    setStartDate(resolved.windowStart)
    setEndDate(resolved.windowEnd)
    setBaselineStart(resolved.baselineStart)
    setBaselineEnd(resolved.baselineEnd)
    // Label where these came from. They are the browser's clock, which is
    // exactly what choosing a file replaces - so the page can say "using your
    // saved range around today" and mean it.
    setAnchoredTo('today')
  }, [settingsQuery.data])

  const touchDates = () => {
    datesTouched.current = true
  }

  const [searchParams, setSearchParams] = useSearchParams()
  const activeCheckId = searchParams.get('check')
  const setActiveCheckId = (id: string | null) => setSearchParams(id ? { check: id } : {}, { replace: true })
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** Why the four dates are unusable. Kept apart from `uploadError` because
   *  that one is about the file and renders a failure card, while this is a
   *  form-validation message the user can fix in place. */
  const [datesError, setDatesError] = useState<string | null>(null)
  const createCheck = useCreateCheck()

  /** Write the four fields from the file's own span. */
  const applyChoice = (next: WindowChoice, from: FileSpan | null) => {
    setChoice(next)
    // Any preset other than Manual resolves four complete dates, so the
    // validation message cannot still be true. Cleared here rather than at
    // submit so it disappears the moment the user fixes the problem, instead
    // of surviving a successful submit attempt.
    if (next !== 'manual') setDatesError(null)
    if (!from) return
    const resolved = datesForChoice(next, from.minDate, from.maxDate)
    if (!resolved) return // Manual: the fields are the user's to fill.
    setStartDate(resolved.windowStart)
    setEndDate(resolved.windowEnd)
    setBaselineStart(resolved.baselineStart)
    setBaselineEnd(resolved.baselineEnd)
    datesTouched.current = true
    // The one place 'file' is set. Dates that came out of the file's own span
    // are facts about the export, and saying so is what removes the "these
    // come from today" warning under the inputs.
    setAnchoredTo('file')
  }

  /**
   * Owner spec Part 4's fallback, in priority order and always explicit about
   * which rung it used:
   *
   *  1. the file's own last day - what a successful inspect gives us;
   *  2. the tenant's `defaultDateRange` around that same anchor;
   *  3. the browser's today, only when the file's dates are unreadable and
   *     there is no other anchor to use.
   *
   * Rung 3 is the one deviation from "do not use the PC clock", and it is
   * logged as D-121: with no readable date anywhere in the file, today is the
   * only anchor left. `anchoredTo` is what lets the UI admit it.
   */
  const applyFallback = (from: FileSpan | null) => {
    const days = parseRangeDays((settingsQuery.data?.settings ?? {}).defaultDateRange)
    const { dates, anchoredTo: how } = resolveFallbackDates({
      span: from,
      defaultRangeDays: days,
      today: new Date(),
    })
    setStartDate(dates.windowStart)
    setEndDate(dates.windowEnd)
    setBaselineStart(dates.baselineStart)
    setBaselineEnd(dates.baselineEnd)
    setAnchoredTo(how)
    datesTouched.current = true
    setDatesError(null)
  }

  /** Detect on selection; opening and confirming the window are user actions. */
  // Task 6/owner decision: the check's own upload control takes SEVERAL
  // files (limited by available hardware); baseline files are chosen in the
  // baseline section below and are comparison files, not the batch.
  const [files, setFiles] = useState<File[]>([])
  const onFilesChosen = async (chosen: FileList | null) => {
    const list = chosen ? Array.from(chosen) : []
    const request = ++inspectionRequest.current
    inspectionAbort.current?.abort()
    const controller = new AbortController()
    inspectionAbort.current = controller
    setFiles(list)
    setFileInspection(null)
    setInspectionError(null)
    setWindowConfirmed(false)
    setWindowOpen(false)
    setUploadError(null)
    setDatesError(null)
    setActiveCheckId(null)
    setAnchoredTo(null)
    setIsInspecting(list.length > 0)
    if (list.length === 0) return
    const limitError = primaryFilesError(list, plan)
    if (limitError) { setIsInspecting(false); setDatesError(limitError); return }

    try {
      const measurements = await Promise.all(list.map(async (file): Promise<FileInspection> => {
        try {
          return await inspectFile(file, controller.signal)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'FALLBACK_TO_BACKEND') throw error
          const measured = await inspect.mutateAsync(file)
          return { ...measured, method: 'backend' }
        }
      }))
      if (request !== inspectionRequest.current) return
      // The primary batch's envelope is independent of browser selection order.
      // Baseline library files are comparison data and are not in this list.
      const result: FileInspection = {
        minDate: measurements.reduce((date, item) => item.minDate < date ? item.minDate : date, measurements[0].minDate),
        maxDate: measurements.reduce((date, item) => item.maxDate > date ? item.maxDate : date, measurements[0].maxDate),
        rowCount: measurements.every(item => item.rowCount !== null)
          ? measurements.reduce((total, item) => total + (item.rowCount ?? 0), 0) : null,
        method: measurements.some(item => item.method === 'backend') ? 'backend' : 'local-csv',
      }
      setFileInspection(result)
      const picked = defaultChoice(daysInFile(result.minDate, result.maxDate), parseRangeDays(settingsQuery.data?.settings?.defaultDateRange))
      setChoice(picked)
      confirmedChoice.current = picked
      // Seed manual editing from this file, while still requiring confirmation.
      applyChoice(picked, result)
    } catch (error) {
      if (request !== inspectionRequest.current) return
      setInspectionError(error instanceof Error ? error.message : 'Could not read file dates.')
      setChoice('manual')
      confirmedChoice.current = 'manual'
      applyFallback(null)
    } finally {
      if (request === inspectionRequest.current) setIsInspecting(false)
    }
  }

  const openWindow = () => {
    setChoice(confirmedChoice.current)
    setWindowOpen(true)
  }

  const confirmWindow = () => {
    applyChoice(choice, span)
    confirmedChoice.current = choice
    setWindowConfirmed(true)
    setWindowOpen(false)
  }

  // The 2s poll now lives in the query (refetchInterval returns false the moment
  // the check is no longer queued/running), so a finished check stops costing
  // requests instead of polling forever. The old setTimeout loop also had to be
  // hand-cancelled on unmount and could re-enter after the component was gone.
  const statusQuery = useCheckStatus(activeCheckId ?? undefined)
  const status = statusQuery.data

  // A status request that failed is NOT "still queued", and the difference is
  // the whole point: with `status?.status ?? 'queued'` a failed request rendered
  // identically to a pending one, so the page said "Queued / 0% - polling every
  // 2s" indefinitely, and the user was told to wait for something that had
  // already finished with the reason never shown. Measured in the browser: one
  // /status request, then silence, while the server recorded the check as
  // `failed`. An error is its own state.
  const statusUnreadable = statusQuery.isError

  // 'idle' is the local answer to "no check has been submitted yet". Once there
  // is a check, its own status is the truth - including 'failed', which is a
  // real outcome the user must see rather than a generic error.
  const step: RunStep = !activeCheckId
    ? uploadError
      ? 'failed'
      : 'idle'
    : statusUnreadable
      ? 'failed'
      : ((status?.status ?? 'queued') as RunStep)

  const progress = status?.progress ?? (activeCheckId ? 0 : null)
  const currentPhase = status?.current_step ?? (activeCheckId ? 'queued' : null)
  const resultQuery = useCheck(activeCheckId ?? undefined, step === 'completed')
  const result = resultQuery.data ?? null

  // `failure` is the message to show, or null when there is nothing to show. It
  // is a separate const rather than reusing `error` so the render can narrow on
  // it directly: a `step === 'failed'` guard does not prove `error` is
  // non-null to the type checker.
  //
  // Three different failures need three different things said about them, so
  // the card is told which one this is rather than pattern-matching the text.
  // The three actions are incompatible: fix the file, change nothing, or retry.
  const statusErrorText = statusUnreadable ? describeError(statusQuery.error) : null
  const error =
    uploadError ?? statusErrorText ?? (step === 'failed' ? (status?.error ?? 'the check failed') : null)
  const failure = step === 'failed' ? (error ?? 'the check failed') : null
  // Task 6: a plan-limit refusal is neither a bad file nor a failed run -
  // the fix is the selection or the plan, so the card is told which.
  const planRefusal = failure ? parsePlanRefusal(failure) : null
  const sourceRefusal = parseCanonicalRefusal(status?.failure) ?? parseCanonicalRefusal(failure)
  const failureKind: FailureKind = statusErrorText
    ? 'connection'
    : sourceRefusal
      ? 'source'
    : failure && isSafetyRefusal(failure)
      ? 'safety'
    : planRefusal
      ? 'plan'
      : failure && isUploadRejection(failure)
        ? 'rejection'
        : 'run'

  const retryKeys = useRef(submissionKeys())
  const handleCheck = async () => {
    if (files.length === 0 || !windowConfirmed || isInspecting || plan?.entitlement?.state !== 'active' || planQuery.isError) return
    const limitError = primaryFilesError(files, plan)
    if (limitError) { setDatesError(limitError); return }
    if (useFiles && chips.length === 0) {
      setDatesError('Choose at least one baseline file, or turn off Compare with previous data.')
      return
    }
    // The reported symptom was a 422 "Field required: window_start,
    // window_end, baseline_start, baseline_end". Lazy provisioning removes the
    // cause, but the check is kept: these four are the only fields on this form
    // the API cannot do without, so an empty one is a guaranteed rejection, and
    // a message naming the window beats a 422 naming four fields the user
    // never saw.
    if (!startDate || !endDate || !baselineStart || !baselineEnd) {
      setDatesError(
        'Choose an analysis window first - the window and baseline dates are all required.',
      )
      return
    }
    if (startDate > endDate) {
      setDatesError('Window end must be on or after Window start.')
      return
    }
    if (baselineStart > baselineEnd) {
      setDatesError('Baseline end must be on or after Baseline start.')
      return
    }
    if (baselineEnd >= startDate) {
      setDatesError('Baseline end must be before Window start.')
      return
    }
    setDatesError(null)
    setUploadError(null)
    setActiveCheckId(null)
    try {
      // The payload is a pure function of the page's state (lib/check-form):
      // a baseline that is not chosen is OMITTED, so the ordinary no-baseline
      // request is byte-identical to the one this page made before the
      // feature existed.
      const form = buildCheckForm({
        files,
        windowStart: startDate,
        windowEnd: endDate,
        baselineStart,
        baselineEnd,
        useFileBaseline: useFiles,
        baselineUploadIds: chips
          .filter((c) => c.kind === 'upload' && c.uploadId)
          .map((c) => c.uploadId as string),
        baselineFiles: chips
          .filter((c) => c.kind === 'file' && c.file)
          .map((c) => c.file as File),
      })
      form.set('submission_key', retryKeys.current.key(JSON.stringify([startDate, endDate,
        baselineStart, baselineEnd, useFiles, chips.filter(c => c.kind === 'upload').map(c => c.uploadId)]),
        [...files, ...chips.filter(c => c.kind === 'file' && c.file).map(c => c.file as File)]))
      const created = await createCheck.mutateAsync(form)
      retryKeys.current.acknowledged()
      if (isCurrentIdentity()) setActiveCheckId(created.check_id)
    } catch (err) {
      if (isCurrentIdentity()) void planQuery.refetch()
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }

  // Queued or unrecognised phases establish no completed analysis step.
  const visualStep = currentPhase ? (PHASE_TO_STEP[currentPhase] ?? -1) : -1
  const busy = step === 'queued' || step === 'running'
  const assessment = result?.validation_report?.assessmentStatus as
    | string
    | undefined
  const caveats = result?.validation_report?.caveats ?? []
  const limited = assessment !== 'complete' || caveats.length > 0
  const windowTotal = result?.validation_report?.windowTotalCents
  const findingsCount = result?.findings_count ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Check AWS Charges"
        description="Upload your AWS billing export to trace reported charges, unusual spending, commitments and team allocation. Comparisons use the dates and evidence in your files; missing data stays unknown. Review coverage before acting on a finding."
      />
      {status?.message ? <p role="status" className="text-body text-muted-foreground">{status.message}</p> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Analysis Configuration</CardTitle>
            <CardDescription>Upload a CUR 1.0 or CUR 2.0 export and set the analysis window</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* `Field` rather than a bare `<label>`: five of these were labels
                with no `htmlFor` above inputs with no `id`, so clicking a label
                focused nothing and a screen reader announced every control
                nameless. */}
            <Field
              id="check-file"
              label="CUR 1.0 or CUR 2.0 export"
              hint=".csv / .csv.gz / .parquet — select several to check them in one run (limited by available hardware)"
              required
            >
              {(control) => (
                <Input
                  {...control}
                  type="file"
                  multiple
                  disabled={busy || createCheck.isPending}
                  accept=".csv,.gz,.parquet"
                  error={uploadError !== null && isUploadRejection(uploadError)}
                  onChange={(e) => void onFilesChosen(e.target.files)}
                />
              )}
            </Field>
            {files.length > 0 ? (
              <p className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-1 text-caption text-muted-foreground">
                <Upload className="h-3 w-3" aria-hidden="true" />
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="font-mono">{f.name}</span>
                ))}
                <span>
                  {files.length === 1 ? '1 file for this check' : `${files.length} files for this check`}
                </span>
              </p>
            ) : null}
            {files.length > 0 && isInspecting ? (
              <p className="-mt-2 pl-1 text-caption text-muted-foreground">Detecting dates...</p>
            ) : null}
            {files.length > 0 && fileInspection && !isInspecting ? (
              <p className="-mt-2 pl-1 text-caption text-muted-foreground">
                Detected: {fileInspection.minDate} → {fileInspection.maxDate} ({daysInFile(fileInspection.minDate, fileInspection.maxDate)} days)
              </p>
            ) : null}
            {/* Task 6 + the owner's decision: the plan's limits, from the
                same endpoint the enforcement answers to. The BATCH counts the
                check's own files; baseline files are comparison files and
                never count toward it. */}
            <p className="pl-1 text-caption text-muted-foreground">No plan file-size, batch or check limits. Available device memory and disk determine what can complete. Resource failures are reported without saving partial financial results.</p>
            {inspectionError ? (
              <p role="alert" className="text-body text-danger">
                {summariseRejection(inspectionError)}{' '}
                {isInspectionFormatError(inspectionError) ? <>
                  Export a valid AWS Cost and Usage Report and choose that file.{' '}
                  <Link to="/docs/cur-format" className="text-accent underline">Required file format</Link>
                </> : 'Choose a window and set the dates manually before checking.'}
              </p>
            ) : null}
            {/* Name both supported AWS export versions before file selection. */}
            <p className="pl-1 text-caption text-muted-foreground">
              Must be an AWS Cost and Usage Report export, not a custom CSV. Both
              formats work: CUR 2.0 from AWS Data Exports (
              <code className="font-mono">line_item_unblended_cost</code>) or CUR 1.0
              (classic CUR) (<code className="font-mono">lineItem/UnblendedCost</code>).{' '}
              <a
                href="/sample-cur-2.0.csv"
                download
                className="text-accent underline underline-offset-2 hover:text-accent-hover"
              >
                Download a valid example
              </a>
              .
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="check-window-start" label="Window start" required>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={startDate}
                    // Disabled unless the user asked for Manual in the picker.
                    // A preset owns these four fields: leaving them editable
                    // under "Last 30 days" invites a change that makes the
                    // dialog's promise quietly untrue. Manual is the only state
                    // where the dates are the user's to set.
                    disabled={!manualEnabled(choice)}
                    onChange={(e) => {
                      touchDates()
                      setStartDate(e.target.value)
                    }}
                  />
                )}
              </Field>
              <Field id="check-window-end" label="Window end" required>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={endDate}
                    disabled={!manualEnabled(choice)}
                    onChange={(e) => {
                      touchDates()
                      setEndDate(e.target.value)
                    }}
                  />
                )}
              </Field>
            </div>
            {/* Where the four dates came from. The distinction is the whole
                point of the picker: dates anchored on the file are facts about
                the export, dates anchored on today are a guess that is wrong
                for any file that is not from this month. */}
            {anchoredTo === 'today' ? (
              <p className="-mt-2 pl-1 text-caption text-muted-foreground">
                These dates come from today and your saved range, not from the
                file. Choose a window in the picker to anchor them on the
                export's own last day.
              </p>
            ) : null}
            <details className="pl-1 text-body">
              <summary className="cursor-pointer text-muted-foreground">
                Baseline window (history to compare against)
              </summary>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <Field id="check-baseline-start" label="Baseline start">
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={baselineStart}
                      // DISABLED, not hidden, in two cases, and for different
                      // reasons. When files are the baseline: a hidden input
                      // still submits its value, and these dates still decide
                      // which days of the selected files are summarised -
                      // removing them from the payload would 422. When a preset
                      // window is chosen: the dialog computed them.
                      disabled={!manualEnabled(choice)}
                      onChange={(e) => {
                        touchDates()
                        setBaselineStart(e.target.value)
                      }}
                    />
                  )}
                </Field>
                <Field id="check-baseline-end" label="Baseline end">
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      value={baselineEnd}
                      disabled={!manualEnabled(choice)}
                      onChange={(e) => {
                        touchDates()
                        setBaselineEnd(e.target.value)
                      }}
                    />
                  )}
                </Field>
              </div>
              {useFiles ? (
                <p className="mt-1 text-caption text-muted-foreground">
                  The baseline dates select which days of your chosen history files
                  are compared. Choose Manual to change them.
                </p>
              ) : null}
            </details>

            {/* Features 4/6: the file-baseline picker, below the dates it can
                replace. The component owns the toggle's copy, the chips and
                the library dialog; this page owns the selection state so
                the submit payload is built from one place. */}
            <BaselineSection
              useFiles={useFiles}
              onUseFilesChange={setUseFiles}
              chips={chips}
              onChipsChange={setChips}
              uploads={uploadsQuery.data ?? []}
              uploadsLoading={uploadsQuery.isPending}
              uploadsError={
                uploadsQuery.error instanceof Error
                  ? uploadsQuery.error.message
                  : uploadsQuery.error
                    ? String(uploadsQuery.error)
                    : null
              }
              libraryOpen={libraryOpen}
              onLibraryOpenChange={setLibraryOpen}
              libraryFilters={libraryFilters}
              onLibraryFiltersChange={filters => { setLibraryFilters(filters); setLibraryOffset(0) }}
              pagination={uploadsQuery.pagination}
              onLibraryPageChange={setLibraryOffset}
              onLibraryRetry={() => void uploadsQuery.refetch()}
            />

            {/* Owner spec Part 2. Rendered always, open-state controlled by the
                page: the page holds the span and the choice, and the dialog
                holds neither. */}
            <WindowDialog
              open={windowOpen}
              onOpenChange={(open) => {
                setWindowOpen(open)
                if (!open) setChoice(confirmedChoice.current)
              }}
              span={span}
              inspecting={isInspecting}
              inspectError={inspectionError}
              onConfirm={confirmWindow}
              choice={choice}
              onChoiceChange={setChoice}
            />

            {/* Set on submit, not on render: the four dates are empty for the
                first moment of the page's life (they arrive with the settings
                query), so rendering this eagerly would flash an error at a user
                who has done nothing wrong. */}
            {datesError ? (
              <p role="alert" className="text-body text-danger">
                {datesError}
              </p>
            ) : null}

            {/* `loading`, not a hand-rolled spinner: the prop also disables the
                button and sets aria-busy, so a second click during the POST
                cannot start a second check. A spinner alone was clickable. */}
            {files.length === 0 ? (
              <Button disabled className="w-full" size="lg">Choose File</Button>
            ) : (
              <div className="space-y-2">
                <Button
                  onClick={openWindow}
                  disabled={isInspecting || windowOpen || busy || createCheck.isPending}
                  loading={isInspecting}
                  loadingLabel="Detecting dates"
                  variant={windowConfirmed ? 'secondary' : 'primary'}
                  className="w-full"
                  size="lg"
                >
                  {windowConfirmed ? 'Change analysis window' : 'Choose analysis window'}
                </Button>
                {windowConfirmed ? (
                  <Button
                    onClick={() => void handleCheck()}
                    disabled={isInspecting || windowOpen || busy || planQuery.isError || plan?.entitlement?.state !== 'active'}
                    loading={createCheck.isPending}
                    loadingLabel="Submitting check"
                    className="w-full"
                    size="lg"
                  >Check AWS Charges</Button>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {busy ? (
            <Card>
              <CardHeader>
                <CardTitle>Analysis Progress</CardTitle><Button variant="outline" onClick={()=>void apiFetch('/api/cancel',{method:'POST',body:'{}'}).then(()=>statusQuery.refetch()).catch(error=>setUploadError(String(error)))}>Cancel check</Button>
                {currentPhase ? (
                  <CardDescription className="font-mono capitalize">{currentPhase}</CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4">
                <ol className="space-y-3">
                  {STEP_LABELS.map((label, index) => {
                    const isComplete = index < visualStep
                    const isCurrent = index === visualStep
                    return (
                      <li key={label} className="flex items-center gap-3">
                        <CheckCircle2
                          className={
                            isComplete
                              ? 'h-5 w-5 text-success'
                              : isCurrent
                                ? 'h-5 w-5 text-accent'
                                : 'h-5 w-5 text-subtle'
                          }
                          aria-hidden="true"
                        />
                        <span
                          className={
                            isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground'
                          }
                        >
                          {label}
                        </span>
                        {isComplete ? <span className="sr-only">(complete)</span> : null}
                      </li>
                    )
                  })}
                </ol>
                {/* A progress bar announces itself. The visual one existed with
                    no ARIA at all, so a screen reader user got three static
                    labels and silence while the percentages climbed. */}
                <div
                  role="progressbar"
                  aria-label="Analysis progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress ?? 0}
                  className="h-2 w-full overflow-hidden rounded-full bg-surface-alt"
                >
                  <div
                    className="h-full bg-accent transition-[width] duration-base ease-landing"
                    style={{ width: `${Math.max(progress ?? 0, 3)}%` }}
                  />
                </div>
                <p className="text-caption text-muted-foreground" aria-live="polite">
                  {progress ?? 0}% — polling every 2s
                </p>
              </CardContent>
            </Card>
          ) : null}

          {failure ? <CheckFailureCard message={failure} kind={failureKind} refusal={sourceRefusal} /> : null}

          {step === 'completed' && !result ? resultQuery.error
            ? <ErrorState title="Analysis finished, but results could not load" error={resultQuery.error}
              onRetry={() => void resultQuery.refetch()} isRetrying={resultQuery.isFetching} />
            : <PageSkeleton label="Analysis finished. Loading results" />
            : null}
          {result && step === 'completed' ? (
            // `warning` / `success`, not `orange-500` / `green-500`: the token
            // system gives each status one colour, and this card is the one
            // place in the app where the two outcomes sit side by side in the
            // user's memory - "the orange one" has to be the same orange as
            // the caveat card on the finding they clicked through to.
            <Card
              className={
                findingsCount > 0 || limited ? 'border-warning/40' : 'border-success/40'
              }
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {findingsCount > 0 ? (
                    <>
                      <Badge variant="warning" dot>
                        Things need attention
                      </Badge>
                    </>
                  ) : (
                    <>
                      <Badge variant={limited ? "warning" : "success"} dot>
                        {assessment === 'no_data' ? 'No data in this window' : limited ? 'Limited assessment' : 'No findings detected'}
                      </Badge>
                    </>
                  )}
                </CardTitle>
                <CardDescription>
                  {findingsCount > 0
                    ? 'The analysis finished and found charges worth reviewing.'
                    : limited ? 'Review the data coverage before drawing a conclusion.' : 'No unusual charges detected in the available data for this window.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-body">Analysis window: {result.window_start} → {result.window_end}</p>
                {caveats.length > 0 ? <div role="status" className="rounded-md border border-warning/40 p-3">
                  <p className="font-medium">Coverage and limitations</p>
                  {/* Task 6: a low-confidence reason gets the action it implies,
                      not just the observation. The sentence names what to do
                      next; the list below stays for the specifics. */}
                  <p className="mt-1 text-body">{lowConfidenceAdvice(assessment, caveats)}</p>
                  <ul className="list-disc space-y-1 pl-5 text-body">{caveats.map((c, i) => <li key={i}>{coverageCaveat(c)}</li>)}</ul>
                </div> : null}
                {assessment === undefined ? <p className="text-body text-warning">Coverage was not recorded for this older check. Run a new check to verify it.</p> : null}
                {findingsCount > 0 ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <StatTile label="Findings detected" value={findingsCount} />
                      <StatTile label="Window spend" value={typeof windowTotal === 'number' ? formatCents(windowTotal) : 'Not recorded'} evidence />
                    </div>
                    {/* A link, not a navigate() call behind a button: "view
                        findings" is navigation, and a real link can be
                        opened in a new tab, which is exactly what someone
                        comparing a finding against the check wants. */}
                    <LinkButton
                      to={`/findings?check=${result.id}`}
                      size="lg"
                      className="w-full"
                    >
                      View findings
                    </LinkButton>
                  </>
                ) : (
                  <p className="text-body text-muted-foreground">
                    {assessment === 'no_data' ? 'Choose dates covered by the file(s), then run another check.' : 'Results depend on the history and billing fields available in your export.'}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <LinkButton to={`/commitments?check=${result.id}`} variant="outline">View commitments</LinkButton>
                  <LinkButton to={`/allocation?check=${result.id}`} variant="outline">View allocation</LinkButton>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
