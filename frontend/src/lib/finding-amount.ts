import { formatCents } from '@/lib/api'
import type { FindingAmountMeasurement } from '@/lib/types'

type AmountFinding = { amount_measurement?: FindingAmountMeasurement | null }

export function hasVerifiedUsd(finding: AmountFinding): boolean {
  const amount = finding.amount_measurement
  return amount?.version === 'finding_amount_v1' && amount.status === 'available'
    && amount.currency === 'USD' && Number.isSafeInteger(amount.value_cents)
    && !!amount.period && amount.period.convention === 'start_inclusive_end_exclusive_utc'
    && !!amount.cost_basis && (amount.population === 'selected_primary_files' || amount.population === 'selected_primary_and_reference_files')
}

export function findingAmount(finding: AmountFinding): string {
  return hasVerifiedUsd(finding) ? formatCents(finding.amount_measurement!.value_cents!) : 'Unavailable'
}

export function evidenceAmount(finding: AmountFinding, value: number | null | undefined): string {
  return !hasVerifiedUsd(finding) ? 'Currency unverified' : value == null ? 'Unavailable' : formatCents(value)
}

export function impactLabel(finding: AmountFinding): string {
  if (!hasVerifiedUsd(finding)) return 'Amount unavailable'
  const labels: Record<string, string> = {
    window_excess: 'Window excess', spike_run_excess: 'Spike-run excess', daily_trend_change: 'Daily trend change',
    final_day_trend_residual: 'Final-day trend residual', window_charge: 'Window charge',
    window_counterfactual_excess: 'Window counterfactual excess', expectation_variance: 'Expectation variance', unused_commitment: 'Unused commitment',
  }
  return labels[finding.amount_measurement!.basis ?? ''] ?? 'Recorded amount'
}

export function investigationHint(type: string): string {
  const hints: Record<string, string> = {
    'unexpected-charge': 'Compare this service and account with recent deployments and expected daily usage.',
    spike: 'Review the peak date and affected resources in your AWS billing export, then check deployment and scaling activity.',
    'new-charge': 'Confirm whether the service was intentionally enabled and identify its owner.',
    'gradual-creep': 'Review daily usage growth and resource sizing across this window.',
    'unused-commitment': 'Compare purchased and used commitment capacity before changing a reservation or Savings Plan.',
    marketplace: 'Check the subscription, seller and renewal terms in AWS Marketplace.',
  }
  return hints[type] ?? 'Review the billing rows and caveats with the owner of this AWS account.'
}


/** Commitment waste is measured from fee facts, not allocated usage-row contributions. */
export function usesCommitmentMeasurement(finding: AmountFinding): boolean {
  return hasVerifiedUsd(finding) && finding.amount_measurement?.basis === 'unused_commitment'
}
