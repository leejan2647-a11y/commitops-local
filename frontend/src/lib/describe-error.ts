/**
 * Turns whatever the API layer threw into a sentence a user can act on.
 *
 * The failure this fixes: the pages rendered `String(error)`, which for a
 * connection failure produces "TypeError: Failed to fetch". That is technically
 * what happened and it is useless to the person reading it - it does not say
 * whether their connection dropped, whether they have been signed out, or
 * whether the server is down, and those three need three different responses.
 *
 * The server's own message is preferred whenever there is one. `/check` rejects
 * a bad CSV with a specific reason ("missing columns: line_item_usage_type,
 * resource_id"), and replacing that with a generic string throws away the only
 * information the user can act on. That is the whole point of the error being
 * specific: it was written for them.
 *
 * Its own module because `page-states.tsx` renders it, and
 * `react/only-export-components` objects to a file that exports both a component
 * and a plain function.
 */
export interface DescribedError {
  message: string
  /** A second line, only when there is something useful to add. */
  hint: string
}

/** The browser's various names for "the request never arrived". */
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed|failed to lookup/i

/** A 401 the API layer did not already handle by signing the user out. */
const UNAUTHORISED = /\b(401|unauthorized|unauthenticated|token (has )?expired)\b/i

export function describeError(error: unknown): DescribedError {
  if (error == null) {
    return { message: 'Something went wrong.', hint: '' }
  }

  // An axios-shaped error: the server answered, and said why.
  const response = (error as { response?: { status?: number; data?: { detail?: string; message?: string } } })
    ?.response
  const detail = response?.data?.detail ?? response?.data?.message
  if (typeof detail === 'string' && detail.trim().length > 0) {
    return { message: detail.trim(), hint: '' }
  }

  if (error instanceof Error) {
    const raw = error.message.trim()

    if (NETWORK_FAILURE.test(raw)) {
      return {
        message: 'Could not reach CommitOps.',
        hint: 'Check your connection and try again. Nothing was lost - a check that is already running keeps running.',
      }
    }

    if (UNAUTHORISED.test(raw) || response?.status === 401) {
      return {
        message: 'Your session has expired.',
        hint: 'Sign in again to continue. Any check you started is still running.',
      }
    }

    if (raw.length > 0) {
      return { message: raw, hint: '' }
    }
  }

  return { message: 'Something went wrong.', hint: '' }
}
