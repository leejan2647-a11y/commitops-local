export interface CanonicalRefusal {
  code: 'cur_observation_conflict' | 'cur_identity_uncertain' | 'cur_money_unavailable' | 'cur_currency_unavailable'
  message: string
  recovery: string
  differingFields: string[]
  invalidRows?: number
  conflictRows?: number
  conflictGroups?: number
}

/** Sync 422 detail and persisted async status carry the same typed refusal. */
export function parseCanonicalRefusal(value: unknown): CanonicalRefusal | null {
  try {
    const body = typeof value === 'string' ? JSON.parse(value) : value
    if (!body || typeof body !== 'object') return null
    const candidate = 'detail' in body ? body.detail : body
    if (!candidate || typeof candidate !== 'object'
      || !['cur_observation_conflict', 'cur_identity_uncertain', 'cur_money_unavailable', 'cur_currency_unavailable'].includes(candidate.code)
      || typeof candidate.message !== 'string' || typeof candidate.recovery !== 'string') return null
    return {
      code: candidate.code, message: candidate.message, recovery: candidate.recovery,
      differingFields: Array.isArray(candidate.differingFields)
        ? candidate.differingFields.filter((field: unknown): field is string => typeof field === 'string').slice(0, 20) : [],
      invalidRows: Number.isSafeInteger(candidate.invalidRows) && candidate.invalidRows >= 0 ? candidate.invalidRows : undefined,
      conflictRows: Number.isSafeInteger(candidate.conflictRows) && candidate.conflictRows >= 0 ? candidate.conflictRows : undefined,
      conflictGroups: Number.isSafeInteger(candidate.conflictGroups) && candidate.conflictGroups >= 0 ? candidate.conflictGroups : undefined,
    }
  } catch {
    return null
  }
}
