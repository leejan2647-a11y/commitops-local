/** Preserve backend field locations without guessing channel/config validation. */
export function formErrors(error: unknown): { message: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  let body = (error as { body?: unknown } | null)?.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* use the error message */ } }
  const detail = (body as { detail?: unknown } | null)?.detail
  if (Array.isArray(detail)) {
    for (const issue of detail) {
      if (issue && Array.isArray(issue.loc) && typeof issue.msg === 'string') {
        const field = issue.loc[0] === 'body' ? issue.loc[1] : issue.loc[0]
        if (typeof field === 'string') fields[field] = issue.msg
      }
    }
  }
  return { fields, message: typeof detail === 'string' ? detail : error instanceof Error ? error.message : 'The request failed. Please try again.' }
}
