import { Link } from 'react-router-dom'
import { AlertCircle, ArrowUpRight, CalendarClock, Database, DollarSign, Inbox, ShieldCheck, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LinkButton } from '@/components/ui/link-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { ListSkeleton, PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { CommitmentFamilyTotals } from '@/components/commitment-family-totals'
import { DashboardSpendHistory } from '@/components/dashboard-spend-history'
import { DashboardGrowth } from '@/components/dashboard-growth'
import { findingAmount, impactLabel } from '@/lib/finding-amount'
import { formatCents } from '@/lib/api'
import { useDashboardSummary, useDashboardSpendHistory, useFindings } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { SceneHost } from '@/flow/scene/SceneHost'

export function Dashboard() {
  // The preview and its measurement warnings describe the same check as the
  // summary. An unscoped preview mixed older findings and missing-data warnings
  // into newly validated totals, while claiming to describe this window.
  const summaryQuery = useDashboardSummary()
  const summary = summaryQuery.data ?? null
  const spendQuery = useDashboardSpendHistory(summary?.check_id ?? undefined)
  const recentQuery = useFindings(summary?.check_id ?? undefined, 5, false, Boolean(summary?.check_id))
  const recent = recentQuery.data ?? []
  // Either failure blanks the page, matching the old all-or-nothing
  // Promise.all. One endpoint erroring while the other succeeded was previously
  // indistinguishable from total failure, and showing half a dashboard was not
  // an option that was ever taken.
  const error = summaryQuery.error ?? recentQuery.error
  const isFetching = summaryQuery.isFetching || recentQuery.isFetching

  // Both queries, not just the one that failed. The page shows neither without
  // the summary, so retrying only the findings list would leave it blank.
  const retry = () => {
    void summaryQuery.refetch()
    void recentQuery.refetch()
  }
  const isRetrying = (summaryQuery.isFetching || recentQuery.isFetching) && summary !== null

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <ErrorState error={error} onRetry={retry} isRetrying={isRetrying} />
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <PageSkeleton label="Loading dashboard" />
      </div>
    )
  }

  const noChecks = summary.check_id === null
  const spUnused = summary.commitment_family_totals?.['savings-plan']?.unused
  const riUnused = summary.commitment_family_totals?.['reserved-instance']?.unused
  const onlySp = summary.unused_commitments_cents == null && typeof spUnused === 'number' && typeof riUnused !== 'number'
  const onlyRi = summary.unused_commitments_cents == null && typeof riUnused === 'number' && typeof spUnused !== 'number'
  const unused = onlySp ? spUnused : onlyRi ? riUnused : summary.unused_commitments_cents
  const observedWindow = spendQuery.data?.check_id === summary.check_id ? spendQuery.data.window : undefined

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="AWS cost overview and recent findings"
        actions={<RefreshingIndicator show={isFetching} />}
      />

      {noChecks ? (
        // The very first thing a new user sees, so it is the real empty state
        // rather than a banner above four tiles that are all "—". Showing the
        // tiles before there is a check meant showing four zeroes, which reads
        // as "you spent nothing" rather than "we do not know yet".
        <EmptyState
          icon={Inbox}
          title="No checks yet"
          description="Run your first analysis to populate this dashboard. Check results come from supplied data; operational growth estimates are labelled separately."
          action={
            <LinkButton to="/check" size="lg" className="w-full sm:w-auto">
              Check AWS Charges
            </LinkButton>
          }
        />
      ) : (
        <>
          <section className="flow-dashboard-stage" aria-labelledby="flow-latest-check-title">
            <div>
              <p className="observatory-eyebrow">Latest completed check</p>
              <h2 id="flow-latest-check-title">Follow this check to its evidence.</h2>
              <p>{summary.window_start && summary.window_end ? `Measured window: ${summary.window_start} to ${summary.window_end}.` : 'Open the completed check to review its measured window and limitations.'}</p>
              <Link to={`/check?check=${summary.check_id}`}>Review check and coverage <ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
            <SceneHost kind="ribbon" className="flow-dashboard-ribbon" />
            <div className="flow-stage-facts" aria-label="Check evidence properties">
              <span><Database size={15} aria-hidden="true" /> Source billing rows retained</span>
              <span><ShieldCheck size={15} aria-hidden="true" /> AWS read-only evidence</span>
            </div>
          </section>
          {/* KPI tiles. Every money field is AWS billing evidence, so each one
              is marked; `evidence` is a prop so a tile cannot quietly lose it. */}
          <div className="flow-stat-grid grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Total AWS spend"
              value={summary.total_spend_cents !== null ? formatCents(summary.total_spend_cents) : '—'}
              caption="Last check window"
              evidence
              icon={DollarSign}
            />
            <StatTile
              label="Needs attention"
              value={summary.active_findings}
              caption="Active findings"
              icon={AlertCircle}
            />
            <StatTile
              label="Data coverage"
              value={observedWindow?.observed_days != null && observedWindow.days != null ? `${observedWindow.observed_days} / ${observedWindow.days}` : summary.assessment_status === 'complete' ? 'History available' : summary.assessment_status === 'no_data' ? 'No window data' : 'Review limitations'}
              caption="Days with source rows · delivery completeness unverified"
              icon={TrendingUp}
            />
            <StatTile
              label={onlySp ? 'Unused Savings Plans' : onlyRi ? 'Unused Reserved Instances' : 'Unused commitments'}
              value={typeof unused === 'number' ? formatCents(unused) : 'Unavailable'}
              caption={onlySp ? 'Savings Plans only · Reserved Instances unavailable' : onlyRi ? 'Reserved Instances only · Savings Plans unavailable' : unused == null ? 'Review commitment measurement limitations' : 'Unused RI and Savings Plan amortized commitment'}
              evidence
              icon={CalendarClock}
            />
          </div>
          <CommitmentAssessment compact items={[
            ...(summary.commitment_assessments ?? []), ...(recentQuery.assessments ?? []),
            ...Object.values(summary.commitment_family_totals ?? {}).flatMap(family => family.reasons ?? []),
          ]} />
          <CommitmentFamilyTotals families={summary.commitment_family_totals} showReasons={false} />

          <LinkButton to={`/check?check=${summary.check_id}`} variant="link">Review latest check and coverage</LinkButton>
          <DashboardSpendHistory checkId={summary.check_id!} data={spendQuery.data} error={spendQuery.error}
            isPending={spendQuery.isPending} isFetching={spendQuery.isFetching} onRetry={() => { void spendQuery.refetch() }} />
          <DashboardGrowth checkId={summary.check_id!} />
          <div>
            <Card>
              <CardHeader>
                <CardTitle>Findings by severity</CardTitle>
                <CardDescription>Finding counts in this completed check, not daily spending or additive savings.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="observatory-count-bars">
                  {Object.entries(summary.findings_by_severity).map(([severity, count]) => <div key={severity} className="observatory-count-row">
                    <dt className="capitalize">{severity}</dt>
                    <div className="observatory-count-track" aria-hidden="true"><span style={{ width: `${count / Math.max(1, ...Object.values(summary.findings_by_severity)) * 100}%` }} /></div>
                    <dd className="text-right font-mono">{count}</dd>
                  </div>)}
                </dl>
                {Object.keys(summary.findings_by_severity).length === 0 && <p className="text-body text-muted-foreground">No findings were recorded in this check.</p>}
              </CardContent>
            </Card>
          </div>
          {summary.top_services.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Services with findings</CardTitle>
                <CardDescription>
                  Finding counts in the last check window; amounts may overlap
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table density="compact">
                  <TableCaption className="px-4 pb-2">
                    Counts group the findings by AWS service.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Service</TableHead>
                      <TableHead numeric>Findings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.top_services.map((t) => (
                      <TableRow key={t.service}>
                        <TableCell className="font-medium">{t.service}</TableCell>
                        <TableCell numeric muted={t.findings === 0}>
                          {t.findings}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle>Recent findings</CardTitle>
              <CardDescription>Findings from the latest completed check</CardDescription>
            </div>
            {recent.length > 0 ? (
              <LinkButton to="/findings" variant="secondary" size="sm" className="shrink-0">
                View all
              </LinkButton>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className={recent.length === 0 ? 'pt-0' : 'p-0'}>
          {recentQuery.isPending && !noChecks ? <ListSkeleton label="Loading latest findings" /> : recent.length === 0 ? (
            // Not "No findings yet" on its own. An empty findings list and a
            // broken check look identical from here, so the state says which one
            // it is and offers the action that resolves it.
            <EmptyState
              icon={Inbox}
              title={noChecks ? 'Nothing to show yet' : 'No findings in this window'}
              description={
                noChecks
                  ? 'Findings appear here once a check finishes. Run one and this fills in.'
                  : 'No findings were recorded in this window. Review check coverage and limitations before drawing a conclusion.'
              }
              action={
                <LinkButton
                  to={noChecks ? '/check' : '/findings'}
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                >
                  {noChecks ? 'Run a check' : 'See all findings'}
                </LinkButton>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Finding</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead numeric>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((finding) => (
                  <TableRow key={finding.id}>
                    <TableCell>
                      <Link
                        to={`/findings/${finding.id}`}
                        className="block min-h-11 font-medium text-foreground hover:text-accent"
                      >
                        {finding.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          finding.severity === 'critical' || finding.severity === 'high'
                            ? 'danger'
                            : finding.severity === 'medium'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {finding.severity}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>
                      <span className="inline-flex items-center gap-1">
                        {findingAmount(finding)} <span className="text-caption text-muted-foreground">{impactLabel(finding)}</span>
                        <EvidenceLock />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral">{finding.state?.status ?? 'open'}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!noChecks ? (
        <Card className="border-accent-border">
          <CardHeader>
            <CardTitle>Run another check</CardTitle>
            <CardDescription>
              Analyse your AWS billing data for unusual charges and commitment waste.
              {summary.check_created_at
                ? ` Last check: ${formatDateTime(summary.check_created_at)}`
                : ''}
              {summary.window_start
                ? ` · window ${summary.window_start} to ${summary.window_end}`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LinkButton to="/check" size="lg" className="w-full sm:w-auto">
              Check AWS Charges
            </LinkButton>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

