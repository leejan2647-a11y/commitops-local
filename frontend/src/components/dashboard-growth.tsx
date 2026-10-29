import { useId } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/page-states'
import { RefreshingIndicator } from '@/components/page-skeleton'
import { formatCents } from '@/lib/api'
import { GROWTH_NOTICE, isGrowthDashboard, type GrowthPeriod, type GrowthReason } from '@/lib/monthly-growth'
import { useDashboardGrowth, usePrepareGrowth } from '@/lib/queries'

const stamp = (value: string) => `${new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false })} UTC`
const monthName = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const decimal = (value: string | null) => value === null ? 'Unavailable' : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
function Reasons({ items }: { items: GrowthReason[] }) {
  return <>{items.map((r, i) => <p key={`${r.code}-${i}`} className="text-sm text-muted-foreground">{r.message} <span>{r.recovery}</span></p>)}</>
}
function UsageScope({ group }: { group: string[] }) {
  return <span className="mt-1 block text-xs text-muted-foreground">Payer {group[0] || 'not supplied'} · Account {group[1]} · Region {group[3] || 'not supplied'} · Operation {group[5] || 'not supplied'}{group[6] ? <> · SKU {group[6]}</> : null} · {group[8]}</span>
}
function MonthCard({ value }: { value: GrowthPeriod }) {
  const comp = value.comparison
  const index = value.kind === 'current' ? null : comp.usage_change_percent
  return <Card className="min-w-0">
    <CardHeader>
      <CardDescription>{value.kind === 'current' ? 'Month to date · no completed-month growth estimate' : value.kind === 'historical' ? 'Historical observation · newer complete data unavailable' : 'Previous calendar month'}</CardDescription>
      <CardTitle>{monthName(value.month)}</CardTitle>
      <CardDescription>{value.start} – {value.end} · {value.observed_days.length} dates observed</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <dl className="space-y-4">
        <div><dt className="text-sm text-muted-foreground">Reported AWS charges</dt><dd className="text-2xl font-semibold tabular-nums">{value.charge_cents === null ? 'Unavailable' : formatCents(value.charge_cents)}</dd></div>
        <div><dt className="text-sm text-muted-foreground">Reported spending change</dt><dd className="font-medium tabular-nums">{value.kind === 'current' || comp.spending_change_percent === null ? 'Comparison unavailable' : `${comp.spending_change_percent}%`}</dd></div>
        <div><dt className="text-sm text-muted-foreground">Estimated change in comparable daily cloud usage</dt><dd className="text-xl font-semibold tabular-nums">{index === null ? 'Comparison unavailable' : `${index}%`}</dd></div>
      </dl>
      {value.kind !== 'current' && comp.baseline_month && <p className="text-sm text-muted-foreground">Compared with {monthName(comp.baseline_month)}. Daily usage is adjusted for month length; reported monthly charges are not.</p>}
      {index !== null && <p className="text-sm text-muted-foreground">Usage estimate represents {comp.represented_groups} matching groups at baseline rates.</p>}
      <Reasons items={[...value.reasons, ...comp.reasons]} />
      <details className="min-w-0 rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">Evidence and source files</summary>
        <div className="mt-4 space-y-3 text-sm [overflow-wrap:anywhere]">
          <p>Export completeness unverified. Calendar coverage does not prove complete AWS delivery or account-wide inventory.</p>
          <p>Captured: <time dateTime={value.captured_at}>{stamp(value.captured_at)}</time></p>
          <p>Latest supported source timestamp: {value.latest_source_at ? <time dateTime={value.latest_source_at}>{stamp(value.latest_source_at)}</time> : 'Unavailable'}</p>
          <p>{value.raw_rows} raw observations · {value.canonical_rows} canonical · {value.removed_copy_rows} copies removed.</p>
          {value.missing_days.length > 0 && <p>Dates without complete observations: {value.missing_days.join(', ')}. Missing dates are not zero.</p>}
          <p>Originating check: <code>{value.check_id}</code></p>
          {comp.baseline_check_id && <p>Comparison check: <code>{comp.baseline_check_id}</code></p>}
          {comp.comparison_id && <p>Comparison evidence: <code>{comp.comparison_id}</code></p>}
          <ul className="space-y-3">{value.sources.map(s => <li key={`${s.upload_id}-${s.role}`}>
            <strong>{s.filename}</strong> · {s.role}<br />Upload: <code>{s.upload_id}</code><br />SHA-256: <code>{s.sha256}</code><br />
            {s.raw_rows} raw / {s.canonical_rows} canonical / {s.removed_copy_rows} copies removed
          </li>)}</ul>
          {value.usage_observations.length > 0 && <div>
            <p>Source-observed usage · showing {value.usage_observations.length} of {value.usage_group_count} groups; units are not added together</p>
            <ul className="mt-3 space-y-4 sm:hidden">{value.usage_observations.map((g,i) => <li key={i}>
              <p className="font-medium">{g.key[2]} / {g.key[4]}</p>
              <p className="tabular-nums">Supplied quantity: {g.valid ? decimal(g.quantity) : 'Unavailable'} {g.unit || '(unknown unit)'}</p>
              <UsageScope group={g.key} />
            </li>)}</ul>
            <div className="mt-2 hidden overflow-x-auto sm:block"><table className="w-full text-left text-sm">
              <caption className="sr-only">Source-observed usage quantities and units</caption>
              <thead><tr><th className="p-2">Service / usage type</th><th className="whitespace-nowrap p-2">Supplied quantity</th><th className="whitespace-nowrap p-2">Unit</th></tr></thead>
              <tbody>{value.usage_observations.map((g, i) => <tr key={i}><td className="p-2">{g.key[2]} / {g.key[4]}<UsageScope group={g.key} /></td><td className="whitespace-nowrap p-2 tabular-nums">{g.valid ? decimal(g.quantity) : 'Unavailable'}</td><td className="whitespace-nowrap p-2">{g.unit || 'Unknown'}</td></tr>)}</tbody>
            </table></div>
          </div>}
          {comp.drivers.length > 0 && <ul aria-label="Comparable usage drivers">{comp.drivers.map((d, i) => <li key={i}>{d.key[2]} / {d.key[4]} ({d.key[7]}): {d.usage_change_percent}% daily usage change, {d.weight_percent}% baseline weight.<UsageScope group={d.key} /></li>)}</ul>}
          {comp.other_driver_count > 0 && <p>{comp.other_driver_count} additional groups contribute to the calculation.</p>}
        </div>
      </details>
    </CardContent>
  </Card>
}

interface Props {
  checkId: string; data: unknown; error: unknown; isPending: boolean; isFetching: boolean;
  onRetry: () => void; onPrepare: () => void; preparing: boolean; prepareError: unknown
}
export function GrowthInsights({ checkId, data, error, isPending, isFetching, onRetry, onPrepare, preparing, prepareError }: Props) {
  const id = useId()
  const valid = isGrowthDashboard(data) && data.check_id === checkId ? data : null
  return <section aria-labelledby={id} className="space-y-4 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id={id} className="text-xl font-semibold">Monthly growth insights</h2><p className="text-sm text-muted-foreground">AWS spending and comparable operational activity, measured separately.</p></div><RefreshingIndicator show={isFetching} /></div>
    <p className="rounded-lg border p-4 text-sm text-muted-foreground">{GROWTH_NOTICE}</p>
    {error ? <ErrorState error={error} onRetry={onRetry} isRetrying={isFetching} /> : isPending ? <p role="status">Loading monthly observations for this check…</p> : !valid ? <Card><CardContent className="py-5"><p>Monthly evidence unavailable. Retry or run a new check with complete original exports.</p><Button variant="outline" onClick={onRetry}>Retry monthly observations</Button></CardContent></Card> : <>
      <p className="text-xs text-muted-foreground">View calculated: <time dateTime={valid.calculated_at}>{stamp(valid.calculated_at)}</time> · calendar evaluated using the server UTC clock.</p>
      <Reasons items={valid.reasons} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">{valid.periods.map(p => <MonthCard key={p.observation_id} value={p} />)}</div>
      {valid.periods.length === 0 && <p>No monthly observations are available yet. Normal check results remain available above.</p>}
      {(valid.can_prepare || valid.status === 'preparing') && <div className="space-y-2"><Button variant="outline" onClick={onPrepare} disabled={preparing || valid.status === 'preparing'}>{preparing || valid.status === 'preparing' ? 'Analysing retained data…' : 'Analyse retained data'}</Button><p className="text-xs text-muted-foreground">Only verified original files can supply new growth evidence. This does not rewrite your saved check.</p></div>}
    </>}
    {prepareError ? <ErrorState error={prepareError} onRetry={onPrepare} isRetrying={preparing} /> : null}
  </section>
}

export function DashboardGrowth({ checkId }: { checkId: string }) {
  const query = useDashboardGrowth(checkId)
  const prepare = usePrepareGrowth(checkId)
  return <GrowthInsights checkId={checkId} data={query.data} error={query.error} isPending={query.isPending} isFetching={query.isFetching}
    onRetry={() => { void query.refetch() }} onPrepare={() => prepare.mutate()} preparing={prepare.isPending} prepareError={prepare.error} />
}
