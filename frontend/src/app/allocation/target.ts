/**
 * Which check the Allocation page should show, and why it sometimes cannot show
 * one.
 *
 * Split out of page.tsx so it can be tested directly: this is the decision that
 * was wrong, and testing it needs no DOM, which matters because this project
 * adds no test dependencies (no jsdom, no testing-library). A file that exports
 * both a component and helpers also breaks React Fast Refresh, which is what
 * the lint rule was objecting to.
 */
export type CheckSummaryLite = {
  id: string
  status: string
  archived_at: string | null
}

export type AllocationTarget =
  | { kind: 'usable'; check: CheckSummaryLite }
  | { kind: 'unusable'; check: CheckSummaryLite }
  | { kind: 'none' }

export function resolveAllocationTarget(
  checks: CheckSummaryLite[],
): AllocationTarget {
  const usable = checks.find(
    (c) => c.status === 'completed' && c.archived_at === null,
  )
  if (usable) return { kind: 'usable', check: usable }
  // Explain against the newest live check, so the message names what actually
  // happened instead of a generic "no completed checks".
  const newest = checks.find((c) => c.archived_at === null) ?? checks[0]
  if (!newest) return { kind: 'none' }
  return { kind: 'unusable', check: newest }
}

/**
 * Why there is nothing to show, in terms of what actually happened.
 *
 * The page used to render a spinner forever in this situation. "Loading" and
 * "no data" were both expressed as `check === null && allocation === null`, so
 * a tenant whose only check had failed saw a spinner that never resolved - and
 * the empty-state message below it was unreachable dead code. Naming the reason
 * is the whole fix; which reason applies depends on the check's status.
 */
export function explainMissing(check: CheckSummaryLite): string {
  switch (check.status) {
    case 'failed':
      return 'Your most recent check failed, so it produced no allocation to show. Open Checks for the reason, then run it again.'
    case 'queued':
    case 'running':
      return 'Your most recent check is still running. Allocation appears once it completes.'
    case 'archived':
      return 'Your most recent check is archived. Run a new check to see allocation for the current window.'
    default:
      return `Your most recent check is "${check.status}", so it has no allocation data yet.`
  }
}
