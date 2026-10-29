import { formatCents } from '@/lib/api'
import type { ResourceAttribution as Attribution } from '@/lib/types'

export function ResourceAttribution({ attribution, verifiedUsd, shared = false }: { attribution?: Attribution | null; verifiedUsd: boolean; shared?: boolean }) {
  if (!verifiedUsd || attribution?.contributionBasis !== 'resource_mean_comparison' || !Array.isArray(attribution.contributors)) return <p className="text-caption text-muted-foreground">
    Resource attribution unavailable; {shared ? 'ask the report owner to rerun' : 'rerun'} with resource identifiers and comparison history.
  </p>
  return <div className="space-y-2 text-body-sm" aria-label="Resource attribution">
    <p className="font-medium">Resource baseline comparison</p>
    <p className="text-muted-foreground">Inspect the named resources, their usage and configuration during the billed interval, and compare each resource with its own baseline.</p>
    <p className="text-caption text-muted-foreground">{attribution.measurementPeriod.start} → {attribution.measurementPeriod.end} (UTC, start inclusive, end exclusive). These use resource daily means; do not add these resource comparisons to the finding amount.</p>
    {attribution.contributors.map((item, index) => <div key={`${item.resource}-${index}`} className="rounded-md border border-border p-3">
      <p className="break-all font-mono">{item.resource}{item.isNew ? ' · new in this comparison' : ''}</p>
      <p>Baseline daily mean: {formatCents(item.baseline.avgDailyCents)} · measured daily mean: {formatCents(item.window.avgDailyCents)} across {item.window.days} days.</p>
      <p>Resource mean comparison: {formatCents(item.excessCents)}.</p>
    </div>)}
    {attribution.spikingDay && <p className="text-caption text-muted-foreground">Peak day: {attribution.spikingDay.day} · {formatCents(attribution.spikingDay.dayCents)} source group cost.</p>}
  </div>
}
