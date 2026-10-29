import type { Plan } from './types'

/**
 * How a plan tier is written for a customer (Task 4).
 *
 * The backend speaks in identifiers (`connected`, `team`); the retention note
 * on `/findings` and the billing page speak to a person. This is the one place
 * that converts, so those two surfaces cannot render the same plan two
 * different ways.
 *
 * It is deliberately not `humanise` from the findings table: that only replaces
 * hyphens, which is right for detector types ("usage cost mismatch") and wrong
 * for a plan name ("connected" has to read "Connected").
 */
export function planLabel(tier: string): string {
  return tier
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Retention days alone do not establish how access was granted. */
export function retentionPlanLabel(tier: string | null, plan?: Plan | null): string | null {
  if (plan?.entitlement?.state !== 'active') return null
  if (plan.entitlement.source === 'operator') return tier === 'owner' && plan.tier === 'owner' ? 'Owner plan' : 'Operator access'
  if (plan.entitlement.source === 'verified_payment' && tier && tier !== 'free' && tier === plan.tier) {
    return `${planLabel(tier)} plan`
  }
  return null
}
