/**
 * The check form's multipart payload (Features 4/6), pure.
 *
 * The payload is a pure function of state because a missing field is not an
 * error: a baseline that was not sent produces a well-formed request, a
 * created check, findings, and nothing anywhere red - the report simply
 * compares the wrong period, and the only way to notice is to already know
 * what the baseline should have been. `renderToStaticMarkup` runs no
 * handlers, so that failure was untestable in the page; against a real
 * FormData it is one assertion.
 *
 * Two rules with teeth:
 *
 * - **Baseline fields are OMITTED when the toggle is off, not sent empty.**
 *   The no-baseline request must be byte-identical to one made before the
 *   feature existed, or every "just a normal check" regression test becomes
 *   a test of a different request.
 * - **`baseline_files` is repeated under exactly the declared name.**
 *   FastAPI binds `baseline_files[]` and the bare name to a list
 *   inconsistently and only the exact name receives all of them - the
 *   bracketed spelling silently delivers the LAST file. Asserted, because
 *   "the same code with one different string" is how it regresses.
 */

export interface CheckFormInput {
  /** The check's own files (the plan's batch limit): one or more. */
  files: File[]
  windowStart: string
  windowEnd: string
  baselineStart: string
  baselineEnd: string
  /** True when the user switched "Compare with previous data" on. */
  useFileBaseline: boolean
  /** Library ids chosen in the picker. */
  baselineUploadIds: string[]
  /** Device files chosen to compare against - NOT part of the batch. */
  baselineFiles: File[]
}

export function buildCheckForm(input: CheckFormInput): FormData {
  const form = new FormData()
  for (const f of input.files) form.append('files', f)
  form.append('window_start', input.windowStart)
  form.append('window_end', input.windowEnd)
  // The baseline DATES are always sent, even with a file baseline: they
  // still decide which days of the selected files are summarised, and the
  // backend needs them to build the window at all.
  form.append('baseline_start', input.baselineStart)
  form.append('baseline_end', input.baselineEnd)

  if (input.useFileBaseline) {
    // Task 6: the toggle is an explicit request, and the backend treats it as
    // one - submitting it without a baseline is a 422 there, so the field has
    // to be on the wire for the promise to be checkable.
    form.append('compare_previous', 'true')
    if (input.baselineUploadIds.length > 0) {
      form.append('baseline_upload_ids', JSON.stringify(input.baselineUploadIds))
    }
    for (const part of input.baselineFiles) {
      form.append('baseline_files', part, part.name)
    }
  }
  return form
}

/** The decoded shape of the check's file fields, for asserting against. */
export function decodeBaselineFields(form: FormData): {
  uploadIds: string[]
  files: string[]
  hasUploadIds: boolean
  checkFiles: string[]
} {
  const raw = form.get('baseline_upload_ids')
  const uploadIds = typeof raw === 'string' && raw ? (JSON.parse(raw) as string[]) : []
  const files = form.getAll('baseline_files').map((f) => (f as File).name)
  const checkFiles = form.getAll('files').map((f) => (f as File).name)
  return { uploadIds, files, hasUploadIds: form.has('baseline_upload_ids'), checkFiles }
}
