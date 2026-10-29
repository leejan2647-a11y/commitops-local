import type { Plan } from './types'

/** Published limits use decimal MB/GB. These are not process memory/spill budgets. */
export function formatPlanBytes(value: number | null | undefined): string {
  if (value == null) return 'Unavailable'
  if (value < 0) return 'Unlimited'
  return value >= 1_000_000_000 ? `${value / 1_000_000_000} GB` : `${value / 1_000_000} MB`
}

/** The server's effective ceiling, bounded again by any known plan/safety facts. */
export function effectiveFileLimit(plan: Plan | null | undefined): number | null {
  const limits = [plan?.max_file_bytes, plan?.max_upload_bytes, plan?.effective_max_file_bytes]
    .filter((value): value is number => value != null && value >= 0)
  return limits.length ? Math.min(...limits) : null
}

export function primaryFilesError(files: ReadonlyArray<{ size: number }>, plan: Plan | null | undefined): string | null {
  if (!plan || plan.entitlement?.state !== 'active') return null
  if (plan.files_per_batch != null && plan.files_per_batch >= 0 && files.length > plan.files_per_batch)
    return `Your plan allows ${plan.files_per_batch} files per check. Comparison files are exempt.`
  const fileLimit = effectiveFileLimit(plan)
  if (fileLimit != null && files.some(f => f.size > fileLimit))
    return `${plan.max_upload_bytes != null && plan.max_upload_bytes === fileLimit ? 'Processing safety limit' : 'Plan technical limit'}: ${formatPlanBytes(fileLimit)} per file. Choose a smaller export.`
  if (plan.max_check_bytes != null && plan.max_check_bytes >= 0 && files.reduce((total, f) => total + f.size, 0) > plan.max_check_bytes)
    return `Plan limit: ${formatPlanBytes(plan.max_check_bytes)} total per check, including comparison files.`
  if (plan.max_request_bytes != null && plan.max_request_bytes >= 0 && files.reduce((total, f) => total + f.size, 0) > plan.max_request_bytes)
    return `Processing safety limit: ${formatPlanBytes(plan.max_request_bytes)} per request. Choose fewer or smaller exports.`
  // Rolling check usage changes while cached. Atomic server admission decides
  // whether one accepted check fits the current rolling window.
  return null
}
