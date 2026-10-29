import { formatCents } from '@/lib/api'
import { hasVerifiedUsd } from '@/lib/finding-amount'
import type { FindingAmountMeasurement } from '@/lib/types'

export function FindingAmountNote({ measurement, shared = false }: { measurement?: FindingAmountMeasurement | null; shared?: boolean }) {
  if (!hasVerifiedUsd({ amount_measurement: measurement })) return <p className="text-caption text-muted-foreground">
    Amount unavailable. Currency unverified or measurement provenance unavailable. {measurement?.reason}{' '}
    {measurement?.recovery ?? (shared ? 'Ask the report owner to rerun the check and regenerate this report.' : 'Rerun with supported currency and complete billing fields to verify this amount.')}
  </p>
  const amount = measurement!
  const previousRate = amount.reference?.type === 'current_usage_at_previous_effective_rate'
  const namedLabels: Record<string, string> = { daily_excess_cents: 'Daily excess', peak_day_excess_cents: 'Peak-day excess',
    actual_total_cents: 'Actual total', counterfactual_total_cents: 'Counterfactual total', trend_endpoint_change_cents: 'Trend endpoint change',
    final_day_cents: 'Final day', used_commitment_cents: 'Used commitment' }
  return <div className="space-y-1 text-caption text-muted-foreground" aria-label="Finding amount measurement">
    <p>{amount.cost_basis === 'gross_amortized' ? 'Gross amortized' : 'Unblended'} USD · {amount.population === 'selected_primary_and_reference_files' ? 'selected primary and reference files' : 'selected primary files'}.</p>
    <p>Measured period: {amount.period!.start} → {amount.period!.end} (UTC, start inclusive, end exclusive).</p>
    {amount.reference && <p>Reference: {amount.reference.type.replace(/_/g, ' ')}
      {amount.reference.value_cents == null ? '' : ` · ${formatCents(amount.reference.value_cents)}${previousRate ? ' for the measured window at the previous effective rate' : amount.reference.unit === 'daily_cents' ? ' per day' : amount.reference.unit === 'window_cents' ? ' across the reference window' : ''}`}
      {amount.reference.period ? ` · ${previousRate ? 'Rate observation period: ' : 'Reference period: '}${amount.reference.period.start} → ${amount.reference.period.end}` : ''}.</p>}
    {Object.entries(amount.named_quantities).map(([key, cents]) => Number.isSafeInteger(cents)
      ? <p key={key}>{namedLabels[key] ?? key.replace(/_/g, ' ')}: {formatCents(cents)}</p> : null)}
    <p>Findings may overlap; amounts are not additive.</p>
  </div>
}
