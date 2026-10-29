import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { ApiError, formatCents } from '@/lib/api'
import { useAuth } from '@/lib/use-auth'
import { useBuildHistoryReport, useChecks, useHistoryBreakdown, useHistoryReport, useHistoryReports, usePlan } from '@/lib/queries'
import type { HistoryGroup, HistoryReport, HistoryReportInput, HistoryRow, HistorySort } from '@/lib/types'

const groups: { value: HistoryGroup; label: string }[] = [
  { value: 'teams', label: 'Teams' }, { value: 'accounts', label: 'Accounts' },
  { value: 'services', label: 'Services' }, { value: 'resources', label: 'Resources' },
  { value: 'principals', label: 'IAM identities' },
]
const money = (cents: number | null) => cents == null ? 'Unavailable' : formatCents(cents)
const nextGroup: Partial<Record<HistoryGroup, HistoryGroup>> = { teams: 'accounts', accounts: 'services', services: 'resources', principals: 'services' }
const groupSingular: Record<HistoryGroup, string> = { teams: 'team', accounts: 'account', services: 'service', resources: 'resource', principals: 'IAM identity' }

/** Unmount all local selection and pending submission state at an auth boundary.
 * Transport and query keys also capture the verified private identity. */
export function TeamsHistory() {
  const { identity } = useAuth()
  const plan = usePlan()
  if (plan.isPending) return <PageSkeleton label="Checking Teams History access" />
  if (plan.error) return <ErrorState error={plan.error} title="Could not verify Teams History access" onRetry={() => void plan.refetch()} isRetrying={plan.isFetching} />
  return <HistoryWorkspace key={`${identity?.userId}:${identity?.tenantId}:${identity?.generation}`} />
}

function HistoryWorkspace() {
  const { identity } = useAuth()
  const [params, setParams] = useSearchParams()
  const reportId = params.get('history_report') || undefined
  const checks = useChecks(100)
  const reports = useHistoryReports()
  const build = useBuildHistoryReport()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [allChecks, setAllChecks] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)
  const [reviewVersion, setReviewVersion] = useState(0)
  const checkPicker = useRef<HTMLFieldSetElement>(null)
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  const submissionLock = useRef(false)
  const selectionVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; selectionVersion.current += 1 }
  }, [])
  useEffect(() => { if (reviewVersion > 0) checkPicker.current?.focus() }, [reviewVersion])
  const usableChecks = (checks.data ?? []).filter(check => check.status === 'completed' && !check.archived_at)
  const invalid = Boolean(start && end && start > end) || (!allChecks && selected.length === 0)

  const selectReport = (id: string | undefined) => {
    selectionVersion.current += 1
    const next = new URLSearchParams(params)
    if (id) next.set('history_report', id); else next.delete('history_report')
    setParams(next)
  }
  const submit = async (restoredInput?: HistoryReportInput) => {
    if (submissionLock.current || (!restoredInput && invalid)) return
    submissionLock.current = true
    setSubmitting(true)
    setError(null)
    const input: HistoryReportInput = restoredInput ?? {
      ...(!allChecks ? { check_ids: [...selected].sort() } : {}),
      ...(start ? { start } : {}), ...(end ? { end } : {}),
    }
    const fingerprint = JSON.stringify(input)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() }
    const version = ++selectionVersion.current
    try {
      const report = await build.mutateAsync({ input, idempotencyKey: pending.current.key })
      if (!mounted.current || !identity?.isCurrent() || identity.signal.aborted || selectionVersion.current !== version) return
      pending.current = null
      selectReport(report.id)
    } catch (failure) {
      if (mounted.current && identity?.isCurrent() && !identity.signal.aborted && selectionVersion.current === version) setError(failure)
    } finally {
      submissionLock.current = false
      if (mounted.current && identity?.isCurrent() && !identity.signal.aborted) setSubmitting(false)
    }
  }
  const rebuild = (report?: HistoryReport) => {
    pending.current = null
    if (!report) { void submit(); return }
    // Preserve the original requested membership, including unavailable inputs.
    // Old responses without request metadata conservatively retain their known
    // check IDs; they must never silently widen a scoped report to all checks.
    const ids = report.requested_check_ids === undefined ? report.check_ids : report.requested_check_ids
    const input: HistoryReportInput = {
      ...(ids !== null ? { check_ids: [...ids].sort() } : {}),
      ...(report.start ? { start: report.start } : {}), ...(report.end ? { end: report.end } : {}),
    }
    setAllChecks(ids === null); setSelected(ids ?? []); setStart(report.start ?? ''); setEnd(report.end ?? '')
    void submit(input)
  }
  const reviewCheckSelection = (report: HistoryReport) => {
    selectionVersion.current += 1
    setAllChecks(false)
    setSelected(report.requested_check_ids ?? [...new Set([...report.check_ids, ...(report.conflicting_check_ids ?? [])])])
    setStart(report.start ?? ''); setEnd(report.end ?? '')
    setReviewVersion(version => version + 1)
  }

  return <div className="min-w-0 space-y-6">
    <PageHeader title="Teams History" description="Who spent what across retained billing evidence" />
    <Card>
      <CardHeader><CardTitle>Build a billing history report</CardTitle>
        <CardDescription>By default, use every retained completed, nonarchived check and all its covered dates. Building runs in the background.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-body">From (inclusive, optional)<Input type="date" aria-label="History start date" value={start} onChange={event => setStart(event.target.value)} /></label>
            <label className="space-y-1 text-body">Through (inclusive, optional)<Input type="date" aria-label="History end date" value={end} onChange={event => setEnd(event.target.value)} /></label>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-body"><input type="checkbox" checked={allChecks} onChange={event => setAllChecks(event.target.checked)} />Use all retained completed checks</label>
          {!allChecks && <fieldset ref={checkPicker} tabIndex={-1} className="space-y-2 rounded-lg border border-border p-3"><legend className="px-1 text-body font-medium">Choose completed checks</legend>
            {checks.isPending ? <p role="status">Loading checks…</p> : null}
            {checks.error ? <ErrorState error={checks.error} onRetry={() => { void checks.refetch() }} /> : null}
            {usableChecks.map(check => <label className="flex min-h-11 items-center gap-2 break-words text-caption" key={check.id}>
              <input type="checkbox" checked={selected.includes(check.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, check.id] : ids.filter(id => id !== check.id))} />
              {check.id} · {check.window_start} → {check.window_end}
            </label>)}
            {!checks.isPending && !checks.error && usableChecks.length === 0 ? <p>No completed checks in this page of history.</p> : null}
            {checks.hasNextPage ? <Button type="button" variant="outline" loading={checks.isFetchingNextPage} onClick={() => { void checks.fetchNextPage() }}>Load more checks</Button> : null}
          </fieldset>}
          {invalid ? <p role="alert" className="text-caption text-danger">{start && end && start > end ? 'The start date must be on or before the end date.' : 'Choose at least one completed check, or use all retained checks.'}</p> : null}
          <Button type="submit" disabled={invalid} loading={submitting} loadingLabel="Submitting report">Build report</Button>
        </form>
        {error ? <><ErrorState error={error} title="Report submission was not confirmed" onRetry={() => { void submit() }} isRetrying={submitting} />
          <p className="text-caption text-muted-foreground">Try again with the same selection to safely recover the same request. A report may already have been accepted.</p></> : null}
      </CardContent>
    </Card>
    <label className="block space-y-1 text-body">Recent reports<Select aria-label="Recent history reports" value={reportId ?? ''} onChange={event => selectReport(event.target.value || undefined)}>
      <option value="">Choose a report</option>
      {reportId && !(reports.data?.reports ?? []).some(report => report.id === reportId) ? <option value={reportId}>Selected report {reportId.slice(0, 8)}</option> : null}
      {(reports.data?.reports ?? []).map(report => <option key={report.id} value={report.id}>{report.created_at} · {report.status} · {report.check_ids.length} checks</option>)}
    </Select></label>
    {reports.error ? <ErrorState title="Could not load recent reports" error={reports.error} onRetry={() => { void reports.refetch() }} /> : null}
    {reportId ? <HistoryReportView key={reportId} id={reportId} onRebuild={rebuild} onReviewSelection={reviewCheckSelection} /> : <EmptyState icon={Users} title="Choose or build a history report" description="History measures observed billing spend. It never adds finding impacts together." />}
  </div>
}

function HistoryReportView({ id, onRebuild, onReviewSelection }: { id: string; onRebuild: (report?: HistoryReport) => void; onReviewSelection: (report: HistoryReport) => void }) {
  const reportQuery = useHistoryReport(id)
  const report = reportQuery.data
  if (reportQuery.error) return <div className="space-y-3"><ErrorState error={reportQuery.error} title="History report unavailable" onRetry={() => { void reportQuery.refetch() }} /><p className="text-body">The report may have expired or been removed. Its original selection could not be loaded. Review the dates and checks in the form above before building.</p><Button variant="outline" onClick={() => onRebuild()}>Build from form selection</Button></div>
  if (!report || reportQuery.isPending) return <PageSkeleton label="Loading history report" />
  if (['queued', 'running'].includes(report.status)) return <Card><CardContent className="space-y-3 py-6"><p role="status">{report.status === 'queued' ? 'Report queued' : 'Building billing history'} — this page checks progress automatically.</p><p className="text-caption text-muted-foreground">You can leave this tab and choose the report from Recent reports later.</p></CardContent></Card>
  if (!['ready', 'partial'].includes(report.status)) return <Card><CardHeader><CardTitle>{report.status === 'stale' ? 'This report needs a rebuild' : 'Billing history unavailable'}</CardTitle></CardHeader><CardContent className="space-y-3"><Reasons reasons={report.reasons} /><p>{report.recovery ?? 'Build a new report using retained completed checks.'}</p>
    {report.conflicting_check_ids?.length ? <section aria-label="Conflicting billing checks" className="space-y-2">
      <h3 className="text-body font-medium">Conflicting check revisions</h3>
      <ul className="list-disc space-y-1 break-all pl-5 text-caption">{report.conflicting_check_ids.map(id => <li key={id}>{id}</li>)}</ul>
      <p className="text-body">Deselect conflicting revisions in Choose completed checks above, keeping one authoritative check/source set for each overlap. The newest revision is never chosen automatically.</p>
      <Button onClick={() => onReviewSelection(report)}>Review check selection</Button>
    </section> : <><p className="text-caption text-muted-foreground">Rebuilding keeps this report’s original requested dates and check selection.</p><Button onClick={() => onRebuild(report)}>Rebuild this selection</Button></>}
  </CardContent></Card>
  return <HistoryExplorer key={report.root_scope_id ?? id} report={report} onRefreshScope={() => { void reportQuery.refetch() }} />
}

function Reasons({ reasons }: { reasons: string[] }) {
  return reasons.length ? <ul className="list-disc space-y-1 pl-5 text-caption text-muted-foreground">{reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul> : null
}

type Crumb = { label: string; scopeId: string; group: HistoryGroup }
function HistoryExplorer({ report, onRefreshScope }: { report: HistoryReport; onRefreshScope: () => void }) {
  const [group, setGroup] = useState<HistoryGroup>('teams')
  const [path, setPath] = useState<Crumb[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<HistorySort>('amount_desc')
  const [offset, setOffset] = useState(0)
  const current = path[path.length - 1]
  const activeGroup = current?.group ?? group
  const scopeId = current?.scopeId ?? report.root_scope_id ?? undefined
  const breakdown = useHistoryBreakdown(report.id, { group_by: activeGroup, scope_id: scopeId, offset, limit: 50, search, sort }, Boolean(scopeId))
  const winner = useHistoryBreakdown(report.id, { group_by: activeGroup, scope_id: scopeId, offset: 0, limit: 1, search: '', sort: 'amount_desc' }, Boolean(scopeId))
  const highest = winner.data?.rows[0]
  const resetFilters = () => { setSearch(''); setOffset(0) }
  const drill = (row: HistoryRow) => {
    const next = nextGroup[activeGroup]
    if (next) { setPath([...path, { label: row.label, scopeId: row.scope_id, group: next }]); resetFilters() }
  }
  const expiredScope = breakdown.error instanceof ApiError && [404, 409, 410].includes(breakdown.error.status ?? 0)
  const data = breakdown.data

  return <div className="min-w-0 space-y-6">
    <div className="grid gap-4 sm:grid-cols-2">
      <StatTile className="min-w-0 break-words" label={report.status === 'partial' ? 'Partial observed subtotal' : 'Observed period spend'} value={money(report.total_cents)} caption="USD · unblended billing costs · signed fees and credits included" />
      <StatTile className="min-w-0 break-words" label={`Highest-spending ${groupSingular[activeGroup]}`} value={winner.error ? 'Unavailable' : winner.isPending ? 'Loading…' : highest ? highest.label : 'Unavailable'} caption={highest ? money(highest.amount_cents) + ' · USD observed spend in this scope' : 'Requires attributable billing evidence'} />
    </div>
    {winner.error ? <ErrorState title={`Could not load highest-spending ${groupSingular[activeGroup]}`} error={winner.error} onRetry={() => { void winner.refetch() }} /> : null}
    <Card className={report.status === 'partial' ? 'border-warning/40' : undefined}>
      <CardHeader><CardTitle>{report.status === 'partial' ? 'Partial observed coverage' : 'Observed coverage'}</CardTitle><CardDescription>Observed dates: {report.coverage.observed_start ?? 'Unavailable'} → {report.coverage.observed_end ?? 'Unavailable'} · {report.coverage.observed_dates.length} observed dates · {report.coverage.check_count} checks. Dates are UTC and inclusive.</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-caption text-muted-foreground">
        <p>These retained files establish observed spend for their covered dates, not a complete AWS invoice or all-time spend. Overlapping evidence is deduplicated by the server. Finding impacts are nonadditive and are never used as spend.</p>
        <p>The report total is rounded once to cents. Fractional cents are balanced across billing ledger rows so complete breakdowns reconcile to that total.</p>
        <p>Teams use current Settings → Team Mappings, combining accounts with the same exact trimmed team name. Unassigned is separate. Account ownership does not establish who made an API request.</p>
        <p>IAM identities are available only where the supplied billing rows contain a caller principal. AWS supports Amazon Bedrock caller attribution in CUR 2.0 exports with caller identity data enabled (INCLUDE_IAM_PRINCIPAL_DATA and line_item_iam_principal). Other rows remain not attributed to an IAM identity; an account or resource owner does not identify a human caller.</p>
        <a className="inline-flex min-h-11 items-center text-accent hover:underline" href="https://docs.aws.amazon.com/us_en/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html" target="_blank" rel="noreferrer">AWS IAM principal cost allocation documentation</a>
        <Link className="inline-flex min-h-11 items-center text-accent hover:underline" to="/settings">Manage team mappings</Link>
        <Reasons reasons={report.reasons} />
        {report.status === 'partial' ? <p>To recover missing or expired inputs, upload the original exports and complete a new check, then build history including that check. Unrecoverable inputs remain excluded. <Link className="inline-flex min-h-11 items-center text-accent hover:underline" to="/check">Check original exports</Link></p> : null}
        {report.excluded_checks.length ? <details><summary className="min-h-11 cursor-pointer">Checks with unavailable or excluded inputs ({report.excluded_checks.length})</summary><p>Retained inputs from a partially available check may still contribute.</p><ul>{report.excluded_checks.map((item, index) => <li key={`${item.check_id}:${index}`} className="break-all">{item.check_id}: {item.reason}</li>)}</ul></details> : null}
        <details><summary className="min-h-11 cursor-pointer">Covered dates and source checks</summary><p className="break-words">{report.coverage.observed_dates.join(', ') || 'No observed dates'}</p><ul>{report.check_ids.map(id => <li key={id}><Link className="inline-flex min-h-11 items-center break-all text-accent hover:underline" to={`/findings?check=${encodeURIComponent(id)}`}>Check {id}</Link></li>)}</ul></details>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Spend breakdown <RefreshingIndicator show={breakdown.isFetching} /></CardTitle>
        <CardDescription>Costs are measured from retained primary billing rows. Missing resource identifiers remain visible; signed fees and credits keep their original amounts.</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-caption">Group by<Select aria-label="History group by" value={group} onChange={event => { setGroup(event.target.value as HistoryGroup); setPath([]); resetFilters() }}>{groups.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></label>
          <label className="space-y-1 text-caption">Search<Input aria-label="Search history breakdown" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setOffset(0) }} /></label>
          <label className="space-y-1 text-caption">Sort<Select aria-label="History sort" value={sort} onChange={event => { setSort(event.target.value as HistorySort); setOffset(0) }}><option value="amount_desc">Highest spend first</option><option value="amount_asc">Lowest spend first</option><option value="name">Name</option></Select></label>
        </div>
        {path.length ? <nav aria-label="History drilldown" className="flex flex-wrap items-center gap-1"><Button variant="ghost" onClick={() => { setPath([]); resetFilters() }}>All {group}</Button>{path.map((crumb, index) => <Button key={`${index}:${crumb.scopeId}`} variant="ghost" onClick={() => { setPath(path.slice(0, index + 1)); resetFilters() }}>{crumb.label}</Button>)}</nav> : null}
        {current ? <p className="break-words text-body">{groups.find(item => item.value === activeGroup)?.label} for {current.label}</p> : null}
        {!scopeId ? <p role="status">Billing scope unavailable. Build a new report from retained evidence.</p> : breakdown.error ? <div className="space-y-3"><ErrorState error={breakdown.error} title="Could not load spend breakdown" onRetry={() => { void breakdown.refetch() }} />{expiredScope ? <><p className="text-caption">The selection expired, the mapping changed, or its source was removed. Return to the report root and refresh its scope.</p><Button variant="outline" onClick={() => { setPath([]); resetFilters(); onRefreshScope(); void winner.refetch() }}>Refresh report scope</Button></> : null}</div> : breakdown.isPending ? <PageSkeleton label="Loading spend breakdown" /> : data ? <>
          <Reasons reasons={data.reasons} />
          <p className="text-caption text-muted-foreground">Selected scope: {money(data.total_cents)} USD · {data.count} groups{data.total_cents != null && data.total_cents <= 0 ? ' · percentages unavailable for a nonpositive total' : ''}.</p>
          {data.rows.length === 0 ? <EmptyState icon={Users} title={search ? 'No matching groups' : 'No attributable billing rows'} description={activeGroup === 'principals' ? 'IAM attribution is unavailable without a supplied caller principal. Use a supported CUR 2.0 export with caller identity data enabled; costs remain visible in other billing breakdowns.' : 'Try a different search, grouping, or retained date/check selection.'} /> : <Table>
            <TableCaption>USD unblended observed spend. Percentages use this scope’s signed total. Related findings are supporting links only.</TableCaption>
            <TableHeader><TableRow><TableHead>Group / identity</TableHead><TableHead numeric>Observed spend</TableHead><TableHead numeric>Share</TableHead></TableRow></TableHeader>
            <TableBody>{data.rows.map(row => <TableRow key={row.scope_id}><TableCell className="min-w-48 max-w-xl break-words">
              {nextGroup[activeGroup] ? <Button variant="ghost" className="h-auto min-h-11 max-w-full whitespace-normal text-left" onClick={() => drill(row)} aria-label={`Explore ${row.label}`}>{row.label}</Button> : <p className="break-all font-mono text-caption">{row.label}</p>}
              <RowIdentity row={row} />
              {row.finding_ids.length ? <details><summary className="min-h-11 cursor-pointer text-caption">Related findings ({row.finding_ids.length})</summary><ul>{row.finding_ids.map(id => <li key={id}><Link className="inline-flex min-h-11 items-center break-all text-caption text-accent hover:underline" to={`/findings/${encodeURIComponent(id)}`}>Finding {id.slice(0, 8)}</Link></li>)}</ul></details> : null}
            </TableCell><TableCell numeric>{money(row.amount_cents)}</TableCell><TableCell numeric>{row.percent == null ? 'Unavailable' : `${row.percent.toFixed(1)}%`}</TableCell></TableRow>)}</TableBody>
          </Table>}
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption" aria-live="polite">{data.count ? `${data.offset + 1}–${data.offset + data.rows.length} of ${data.count}` : '0 groups'}</p><div className="flex gap-2"><Button variant="outline" disabled={offset === 0 || breakdown.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button variant="outline" disabled={!data.has_more || breakdown.isFetching} onClick={() => setOffset(offset + 50)}>Next</Button></div></div>
        </> : null}
      </CardContent>
    </Card>
  </div>
}

function RowIdentity({ row }: { row: HistoryRow }) {
  return <div className="space-y-1 break-all text-caption text-muted-foreground">
    {row.account_ids.length ? <p>Accounts: {row.account_ids.join(', ')}</p> : null}
    {row.resource_id ? <p>Resource: {row.resource_id}</p> : null}
    {row.region ? <p>Region: {row.region}</p> : null}
    {row.service ? <p>Service: {row.service}</p> : null}
    {row.names.length ? <p>Names: {row.names.join(', ')}</p> : null}
    {row.aliases?.length ? <details><summary className="min-h-11 cursor-pointer">Observed name history</summary><ul>{row.aliases.map((alias, index) => <li key={`${index}:${alias.name}`}>{alias.name} · {alias.start ?? 'date unavailable'} → {alias.end ?? 'date unavailable'}</li>)}</ul>{row.aliases_has_more ? <p>Showing the first 100 observed names. Additional names remain in the retained evidence.</p> : null}</details> : null}
  </div>
}