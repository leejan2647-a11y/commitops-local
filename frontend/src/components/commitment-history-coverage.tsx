import type { CommitmentHistoryCoverage as Coverage } from '@/lib/types'

export function CommitmentHistoryCoverage({ coverage }: { coverage?: Coverage }) {
  if (!coverage) return null
  if (coverage.status !== 'available') return <p className="text-caption text-muted-foreground">
    Observed history coverage unavailable. {coverage.reason.message} {coverage.reason.recovery}
  </p>
  return <div className="space-y-1 text-caption text-muted-foreground">
    <p>{coverage.observed_hours} observed hours · {coverage.plan_hours} plan-hours across supplied plans.</p>
    <p>Envelope: {coverage.envelope.start} → {coverage.envelope.end}. The envelope includes any gaps; it is not continuous observed coverage.</p>
    <p>{coverage.gaps.length} gap{coverage.gaps.length === 1 ? '' : 's'} in observed history.</p>
    {coverage.gaps.map(gap => <p key={`${gap.start}/${gap.end}`}>{gap.start} → {gap.end}</p>)}
    <details><summary className="cursor-pointer">Observed intervals (UTC, start inclusive, end exclusive)</summary>
      {coverage.observed_intervals.map(interval => <p key={`${interval.start}/${interval.end}`}>{interval.start} → {interval.end}</p>)}
    </details>
  </div>
}
