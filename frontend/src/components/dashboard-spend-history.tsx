import { useEffect, useId, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkButton } from '@/components/ui/link-button'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState } from '@/components/page-states'
import { ListSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { formatCents } from '@/lib/api'
import type { DashboardSpendHistory as SpendHistoryData } from '@/lib/types'

const knownCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/** Chart geometry uses ratios only. Every displayed financial value is supplied
 * by the saved read model, including the historical daily average. */
function SpendChart({ history }: { history: SpendHistoryData }) {
  const id = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [chartWidth, setChartWidth] = useState(640)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    // Match the viewBox to the CSS width: 12 SVG units then remain 12px.
    // Mobile CSS deliberately supplies a wider, contained scrolling plot.
    const measure = (width = svg.getBoundingClientRect().width) => {
      if (Number.isFinite(width) && width > 0) setChartWidth(Math.max(1, Math.round(width)))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        measure(entries.find(entry => entry.target === svg)?.contentRect.width)
      })
      observer.observe(svg)
      return () => observer.disconnect()
    }
    const resize = () => measure()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const baseline = history.baseline.status === 'available' && knownCents(history.baseline.daily_average_cents)
    ? history.baseline.daily_average_cents : null
  const amounts = history.daily.flatMap(point => knownCents(point.amount_cents) ? [point.amount_cents] : [])
  const min = Math.min(0, ...amounts, ...(baseline === null ? [] : [baseline]))
  const max = Math.max(0, ...amounts, ...(baseline === null ? [] : [baseline]))
  const spread = max - min || 1
  const ticks = [...new Set([max, 0, min])].sort((a, b) => b - a)
  const left = Math.max(72, ...ticks.map(value => formatCents(value).length * 7.5 + 16))
  const right = chartWidth - 24
  const x = (index: number) => left + (history.daily.length <= 1 ? (right - left) / 2 : index * (right - left) / (history.daily.length - 1))
  const y = (value: number) => 192 - (value - min) / spread * 168
  // Break each segment at an unknown date; do not draw a line across a gap.
  const segments: string[][] = []
  history.daily.forEach((point, index) => {
    if (!knownCents(point.amount_cents)) { segments.push([]); return }
    if (!segments.length) segments.push([])
    segments[segments.length - 1].push(`${x(index)},${y(point.amount_cents)}`)
  })
  return <figure className="observatory-spend-figure">
    <div className="observatory-spend-key" aria-label="Chart legend">
      <span><i />Observed spend</span>
      {baseline !== null && <span><i className="is-baseline" />Historical daily average</span>}
    </div>
    <div className="observatory-spend-viewport" tabIndex={0} role="region" aria-label="Daily spend chart, scroll horizontally on small screens">
    <svg ref={svgRef} viewBox={`0 0 ${chartWidth} 236`} role="img" aria-labelledby={`${id}-title ${id}-description`} className="observatory-spend-chart">
      <title id={`${id}-title`}>Daily selected-source spend</title>
      <desc id={`${id}-description`}>Unblended USD for the selected primary files. Gaps mean no observed rows, not zero spend. Exact amounts are in the daily figures table below.</desc>
      {ticks.map(value => <g key={value}>
        <line x1={left} x2={right} y1={y(value)} y2={y(value)} className="observatory-spend-grid" />
        <text x={left - 8} y={y(value) + 4} textAnchor="end">{formatCents(value)}</text>
      </g>)}
      {baseline !== null && <line x1={left} x2={right} y1={y(baseline)} y2={y(baseline)} className="observatory-spend-baseline" />}
      {segments.filter(segment => segment.length > 1).map((segment, index) => <polyline key={index} points={segment.join(' ')} className="observatory-spend-line" />)}
      {history.daily.map((point, index) => knownCents(point.amount_cents) && <circle key={point.date} cx={x(index)} cy={y(point.amount_cents)} r="3" className="observatory-spend-point">
        <title>{`${point.date}: ${formatCents(point.amount_cents)}`}</title>
      </circle>)}
      {history.daily.length > 0 && <text x={left} y="222">{history.daily[0].date}</text>}
      {history.daily.length > 1 && <text x={right} y="222" textAnchor="end">{history.daily[history.daily.length - 1].date}</text>}
    </svg>
    </div>
    <figcaption className="text-caption text-muted-foreground">Solid: observed spend. {baseline !== null ? 'Dashed: historical daily average, not a detector threshold or forecast. ' : ''}Missing dates remain gaps; credits and refunds may produce negative amounts.</figcaption>
  </figure>
}

export function DashboardSpendHistory({ checkId, data, error, isPending, isFetching, onRetry }: {
  checkId: string
  data?: SpendHistoryData
  error: unknown
  isPending: boolean
  isFetching: boolean
  onRetry: () => void
}) {
  // A stale payload must never be relabelled as a different summary check.
  const history = data?.check_id === checkId ? data : undefined
  const verifiedUsd = history?.currency === 'USD' && history.basis === 'unblended'
  const hasObservations = Boolean(verifiedUsd && history?.status !== 'unavailable' && history?.daily.some(point => knownCents(point.amount_cents)))
  const money = (value: unknown) => verifiedUsd && knownCents(value) ? formatCents(value) : 'Unavailable'
  return <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>The shape of your spend</CardTitle><RefreshingIndicator show={isFetching && Boolean(history)} /></div>
        <CardDescription>Daily selected-source charges · {verifiedUsd ? 'unblended USD' : 'currency and basis unavailable'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <ErrorState error={error} onRetry={onRetry} isRetrying={isFetching} />
          : isPending || !history ? <ListSkeleton label="Loading daily spend observations" />
            : <>
              {hasObservations ? <>
                <SpendChart history={history} />
                <p className="text-body-sm">Selected-source total: <strong>{money(history.total_cents)}</strong></p>
                <details className="observatory-daily-figures">
                  <summary>View the daily figures</summary>
                  <Table density="compact" maxHeight="24rem" tabIndex={0} role="region" aria-label="Daily selected-source spend table">
                    <TableCaption>Saved daily charges · unblended USD · inclusive UTC dates. Missing observations are unavailable, not zero.</TableCaption>
                    <TableHeader><TableRow><TableHead>Date (UTC)</TableHead><TableHead numeric>Observed spend</TableHead><TableHead numeric>Source rows</TableHead></TableRow></TableHeader>
                    <TableBody>{history.daily.map(point => <TableRow key={point.date}>
                      <TableCell>{point.date}</TableCell><TableCell numeric>{money(point.amount_cents)}</TableCell><TableCell numeric>{point.observed_rows}</TableCell>
                    </TableRow>)}</TableBody>
                  </Table>
                </details>
              </> : <p className="text-body text-muted-foreground">Daily spend is unavailable for this saved check. Its existing summary and findings remain available.</p>}
              <div className="border-t border-border pt-3 text-body-sm">
                <p>Historical daily average: <strong>{history.baseline.status === 'available' ? money(history.baseline.daily_average_cents) : 'Unavailable'}</strong></p>
                {history.baseline.status === 'available' && <p className="text-muted-foreground">{history.baseline.start} to {history.baseline.end} · {history.baseline.days} observed calendar days · {history.baseline.source === 'selected_baseline_files' ? 'selected comparison files' : 'earlier rows in the selected primary files'}.</p>}
              </div>
              {history.reasons.length > 0 && <ul className="space-y-3 text-body-sm">{history.reasons.map(reason => <li key={`${reason.code}:${reason.message}:${reason.recovery}`}><p className="font-medium">{reason.message}</p><p className="text-muted-foreground">{reason.recovery}</p></li>)}</ul>}
              {history.caveats.map(caveat => <p key={caveat} className="text-caption text-muted-foreground">{caveat}</p>)}
            </>}
        <LinkButton to={`/check?check=${checkId}`} variant="link" className="max-w-full h-auto min-h-11 whitespace-normal py-2 text-center md:h-auto">Review this check and evidence</LinkButton>
      </CardContent>
    </Card>
    <Card className="min-w-0">
      <CardHeader><CardTitle>What the data establishes</CardTitle><CardDescription>Observed source coverage, not delivery completeness.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <dl className="observatory-coverage-facts">
          <div><dt>Analysis window</dt><dd>{history?.window.start && history.window.end ? `${history.window.start} to ${history.window.end}` : 'Unavailable'}</dd></div>
          <div><dt>Days with observed rows</dt><dd>{history?.window.observed_days != null && history.window.days != null ? `${history.window.observed_days} / ${history.window.days}` : 'Unavailable'}</dd></div>
          <div><dt>Comparison history</dt><dd>{history?.baseline.observed_days != null && history.baseline.days != null ? `${history.baseline.observed_days} / ${history.baseline.days} days observed` : 'Unavailable'}</dd></div>
          <div><dt>Primary source headers</dt><dd>{history?.source_formats.length ? history.source_formats.join('; ') : 'Unavailable'}</dd></div>
          <div><dt>Currency &amp; basis</dt><dd>{verifiedUsd ? 'USD · unblended' : 'Unavailable'}</dd></div>
        </dl>
        <p className="text-body-sm text-muted-foreground">These measurements describe the selected files and saved check window. They do not establish account-wide inventory or complete AWS delivery. Observed days count dates with source rows, including zero-cost rows.</p>
        <LinkButton to={`/check?check=${checkId}`} variant="outline" className="max-w-full h-auto min-h-11 whitespace-normal py-2 text-center md:h-auto">View check scope and evidence</LinkButton>
        {!isPending && (!hasObservations || history?.status === 'partial') && <LinkButton to="/check" variant="secondary" className="max-w-full h-auto min-h-11 whitespace-normal py-2 text-center md:h-auto">Run a new check with complete source files</LinkButton>}
      </CardContent>
    </Card>
  </div>
}
