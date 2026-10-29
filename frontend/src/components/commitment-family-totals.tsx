import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { CommitmentHistoryCoverage } from '@/components/commitment-history-coverage'
import { formatCents } from '@/lib/api'
import type { CommitmentFamilyTotal } from '@/lib/types'

export function CommitmentFamilyTotals({ families, beneficiaries = false, showReasons = true }: {
  families?: Record<string, CommitmentFamilyTotal>
  beneficiaries?: boolean
  showReasons?: boolean
}) {
  if (!families || !Object.keys(families).length) return null
  return <div className="grid gap-4 lg:grid-cols-2">
    {Object.entries(families).map(([family, total]) => {
      const verifiedUsd = total.currency === 'USD' && total.basis === 'gross_amortized'
      const money = (value: number | null | undefined) => !verifiedUsd || value == null ? 'Unavailable' : formatCents(value)
      // Use the server's exact-cost utilization, never a ratio of rounded cents.
      const utilization = verifiedUsd && total.status === 'available'
        && Number.isSafeInteger(total.purchased) && total.purchased! > 0
        && Number.isSafeInteger(total.used) && total.used! >= 0 && total.used! <= total.purchased!
        && typeof total.utilization_pct === 'number' && Number.isFinite(total.utilization_pct)
        && total.utilization_pct >= 0 && total.utilization_pct <= 100 ? total.utilization_pct : null
      const familyName = family === 'savings-plan' ? 'Savings Plans' : 'Reserved Instances'
      return <Card key={family}>
      <CardHeader>
        <CardTitle>{familyName} in selected files</CardTitle>
        <CardDescription>{verifiedUsd ? 'Gross amortized USD' : 'Currency and cost basis unverified'} · {total.history_coverage ? 'observed history' : 'selected window'} · family subtotal</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <CommitmentHistoryCoverage coverage={total.history_coverage} />
        {utilization !== null && <div className="space-y-2">
          <p className="text-body-sm font-mono">{utilization.toLocaleString('en-US', { maximumFractionDigits: 1 })}% used</p>
          <div role="meter" aria-label={`${familyName} utilization`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={utilization} className="observatory-utilization-track">
            <span style={{ width: `${utilization}%` }} />
          </div>
        </div>}
        <dl className="grid grid-cols-3 gap-3">
          {(['purchased', 'used', 'unused'] as const).map(key => <div key={key}>
            <dt className="capitalize text-caption text-muted-foreground">{key}</dt>
            <dd className="font-semibold">{money(total[key])}</dd>
          </div>)}
        </dl>
        {total.status !== 'available' && total.metrics && <details className="text-body-sm">
          <summary className="cursor-pointer">Observed components only</summary>
          <p className="text-muted-foreground">These supplied components do not establish a complete family total. {family === 'reserved-instance' ? 'Monthly unused fees are not prorated to partial windows.' : 'Supplied fee intervals do not establish missing intervals.'}</p>
          {(['purchased', 'used', 'unused'] as const).map(key => <p key={key} className="capitalize">
            Observed {key}: {money(total.metrics?.[key]?.observed_cents)}
          </p>)}
        </details>}
        {beneficiaries && <div>
          <p className="font-medium">Beneficiary accounts for this family</p>
          {total.allocation?.status === 'available'
            ? Object.entries(total.allocation.consumed_by_account).map(([account, amount]) => <p key={account} className="font-mono">{account}: {money(amount)}</p>)
            : <p className="text-muted-foreground">Complete beneficiary allocation unavailable.</p>}
        </div>}
        {beneficiaries && <CommitmentAssessment items={total.allocation?.reasons} />}
        {showReasons && <CommitmentAssessment items={total.reasons} />}
      </CardContent>
    </Card>})}
  </div>
}
