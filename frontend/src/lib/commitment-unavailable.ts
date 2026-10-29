import { ApiError } from './api'
import type { CommitmentAssessment } from './types'

export function commitmentUnavailable(error: unknown): CommitmentAssessment | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  try {
    const body = typeof error.body === 'string' ? JSON.parse(error.body) : error.body
    const detail = body?.detail
    if (detail?.code !== 'commitment_measurement_unavailable' || typeof detail.reason !== 'string'
      || typeof detail.recovery !== 'string' || typeof detail.check_id !== 'string') return null
    return { code: detail.code, message: detail.reason, recovery: detail.recovery, check_id: detail.check_id }
  } catch { return null }
}
