/**
 * Turning a rejected-upload message into something a person can act on
 * (Task F.1b-fix).
 *
 * The backend already says exactly what is wrong. This does not restate it -
 * it removes the parts that are about the server's internals rather than the
 * user's file, and keeps everything that is actionable. The full text is still
 * shown verbatim underneath; this is the one-line version.
 *
 * Kept in its own module (not inline in the page) so it can be tested without a
 * DOM, which this suite deliberately has none of.
 */

/**
 * Noise the backend prefixes for the worker's benefit, not the user's:
 *
 *   "check failed: could not read uploads/<32-hex>.csv: <the real reason>"
 *
 * The internal object key changes on every attempt, so showing it is noise that
 * also makes two identical failures look like two different problems. The real
 * reason always begins after the last "could not read uploads/".
 *
 * Only the FIRST line of the remainder is kept, and that is the point: the
 * server's message is five lines long (reason, missing columns, required
 * headers, accepted shapes, what the file actually had). This produces the
 * one-line headline; the columns are listed separately and the whole message is
 * shown verbatim underneath. Taking the whole remainder here would render all
 * five lines collapsed into a single paragraph directly above the verbatim
 * block - duplicating the entire message, reflowed, which is the original
 * unreadable problem with extra steps.
 *
 * Returns the message unchanged when the shape is not recognised, because a
 * message we do not understand is better shown whole than guessed at.
 */
export function summariseRejection(message: string): string {
  const internal = message.match(/could not read [^\n]*?\.(?:csv(?:\.gz)?|parquet|gz):\s*([^\n]*)/i)
  if (internal && internal[1]) {
    return `This file was rejected: ${internal[1].trim()}`
  }
  return message.trim().split(/\r?\n/)[0]
}

/** Changing analysis dates cannot repair a malformed export or missing columns. */
export function isInspectionFormatError(message: string): boolean {
  return isUploadRejection(message) || Boolean(missingColumns(message)) ||
    /missing .*column|invalid csv|missing or invalid usage start date|unsupported.*(?:format|file)/i.test(message)
}

/** True when the message is a rejected-upload rather than a failed run. */
export function isUploadRejection(message: string): boolean {
  return /This file is not an AWS Cost and Usage Report export/i.test(message)
}

export function isSafetyRefusal(message: string): boolean {
  return /processing safety limit|this file is too large|expanded export is too large|(?:request|body) (?:is )?too large/i.test(message)
}

/**
 * The machine-readable body of a plan-limit refusal (Task 6).
 *
 * The API returns HTTP 402 with a JSON detail: {reason, detail, limit, tier,
 * upgrade_to}. The API client stringifies that dict into the error message,
 * so this parses it back out - the human sentence is the message, the
 * machine reason is the branch. Returns null when the message is not a plan
 * refusal, which is every other failure this page knows about.
 */
export interface PlanRefusal {
  reason: string
  detail: string
  tier: string
  upgrade_to: string | null
}

export function parsePlanRefusal(message: string): PlanRefusal | null {
  if (!message.trimStart().startsWith('{')) return null
  try {
    const parsed = JSON.parse(message) as Partial<PlanRefusal>
    if (typeof parsed.reason !== 'string' || typeof parsed.detail !== 'string') {
      return null
    }
    return {
      reason: parsed.reason,
      detail: parsed.detail,
      tier: typeof parsed.tier === 'string' ? parsed.tier : '',
      upgrade_to: typeof parsed.upgrade_to === 'string' ? parsed.upgrade_to : null,
    }
  } catch {
    return null
  }
}

/**
 * The message from an unknown throw, as a string.
 *
 * `ApiError.message` is the human half and `status`/`kind` are the machine half.
 * The page shows the message but a status-code-only error would otherwise render
 * as a blank card, so the status is folded in when there is no message.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.trim() || 'an unknown error'
  if (err === null || err === undefined) return 'an unknown error'
  return String(err)
}

/**
 * The columns the file was missing, in the order the server listed them.
 * Returns null when the message does not carry that list, so a caller never
 * renders an empty "missing columns" section.
 */
export function missingColumns(message: string): string[] | null {
  const match = message.match(/^Missing:\s*(.+)$/m)
  if (!match) return null
  const cols = match[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  return cols.length > 0 ? cols : null
}
