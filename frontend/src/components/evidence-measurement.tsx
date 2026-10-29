import { formatCents } from '@/lib/api'
import type { EvidenceMeasurement } from '@/lib/types'

export function EvidenceMeasurementNote({ measurement, shared = false, commitment = false }: { measurement?: EvidenceMeasurement | null; shared?: boolean; commitment?: boolean }) {
  if (commitment) return <p className="text-caption text-muted-foreground">Commitment fee measurement supports the unused amount above. Usage-row contributions are not applicable; review the recorded commitment amount basis and coverage.</p>
  if (!measurement) return <p className="text-caption text-muted-foreground">Evidence row counts and the explained amount outside this table were not recorded or could not be validated. {shared ? 'Ask the report owner to rerun the check and regenerate this report.' : 'Rerun the check to record this breakdown.'}</p>
  return <div className="space-y-1 text-caption text-muted-foreground" aria-label="Evidence calculation breakdown">
    <p>{measurement.source_row_count} matching source rows · {measurement.raw_positive_row_count} with positive raw cost · {measurement.zero_cost_row_count} with actual zero cost.</p>
    <p>{measurement.positive_allocated_row_count} rows received a positive allocated contribution; {measurement.raw_positive_row_count - measurement.positive_allocated_row_count} positive-cost rows received no whole-cent share. This does not make their source cost zero.</p>
    <p>Displayed contribution: {formatCents(measurement.displayed_contribution_cents)} across {measurement.displayed_row_count} rows. Explained but not displayed: {formatCents(measurement.explained_not_displayed_cents)}. {measurement.unexplained_remainder_cents == null ? 'Unexplained remainder unavailable.' : `Unexplained remainder: ${formatCents(measurement.unexplained_remainder_cents)}.`}</p>
    {measurement.unexplained_remainder_cents == null && <p>{measurement.impact_comparison.reason}</p>}
    <p>{measurement.scope === 'spike_run_positive_excess'
      ? `Contributions cover this spike run: ${measurement.period?.start ?? 'start unavailable'} → ${measurement.period?.end ?? 'end unavailable'} (UTC, start inclusive, end exclusive).`
      : 'Contributions use the full check window after each day\'s baseline and credits.'} Exact amounts are summed before rounding once, then whole cents are allocated across contributors. A nonzero subcent source cost can display as $0.00 while its allocated contribution is $0.01.</p>
  </div>
}
