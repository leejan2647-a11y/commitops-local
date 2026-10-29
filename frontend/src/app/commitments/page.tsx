import { useSearchParams } from 'react-router-dom'
import { CheckScopePicker } from '@/components/check-scope-picker'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { PieChart, PiggyBank, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkButton } from '@/components/ui/link-button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState, ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { CommitmentHistoryCoverage } from '@/components/commitment-history-coverage'
import { CommitmentFamilyTotals } from '@/components/commitment-family-totals'
import { formatCents } from '@/lib/api'
import { useChecks, useCommitments } from '@/lib/queries'
import { formatDate } from '@/lib/utils'
import { CATEGORY_DESCRIPTIONS, NON_DERIVABLE_EXPLANATIONS, NON_DERIVABLE_LABEL } from '@/app/allocation/categories'

type SourceMode = 'check' | 'aggregate'

export function Commitments() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedMode: SourceMode = searchParams.get('aggregate') === 'true' ? 'aggregate' : 'check'
  const aggregateRequest = selectedMode === 'aggregate'
  // A history request never sends a check ID, including for conflicting URLs.
  const selectedCheck = aggregateRequest ? undefined : searchParams.get('check') || undefined
  const checksQuery = useChecks(100)
  const setSelectedMode = (mode: SourceMode) => {
    const next = new URLSearchParams(searchParams)
    next.delete('check')
    if (mode === 'aggregate') next.set('aggregate', 'true'); else next.delete('aggregate')
    setSearchParams(next)
  }
  const picker = <CheckScopePicker id="commitments-check" query={checksQuery} selected={selectedCheck} disabled={aggregateRequest} onChange={id => {
    const next = new URLSearchParams(searchParams)
    next.delete('aggregate')
    if (id) next.set('check', id); else next.delete('check')
    setSearchParams(next)
  }} />
  const modeSelector = <ModeSelector mode={selectedMode} onChange={setSelectedMode} hasSelection={!!selectedCheck} />

  // Cached (Task F.1b-fix). This page was the second-slowest in the audit at
  // 1,292 ms; a return visit inside the stale window is now free.
  const { data, isPending, error, isFetching, refetch, isRefetching } =
    useCommitments(selectedCheck, aggregateRequest)

  if (error) {
    return (
      <div className="space-y-6">
        {/* The header stays in the error branch. Losing the `h1` means the
            destination's own title is the only heading a screen reader has,
            which is the D-57 rule this page used to break. */}
        <PageHeader
          title="Commitments"
          description="Reserved Instances and Savings Plans utilization"
          actions={modeSelector}
        />
        {picker}
        <ErrorState
          error={error}
          title="Could not load commitments"
          onRetry={() => void refetch()}
          isRetrying={isRefetching}
        />
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Commitments"
          description="Reserved Instances and Savings Plans utilization"
          actions={modeSelector}
        />
        {picker}
        <PageSkeleton label="Loading commitments" />
      </div>
    )
  }

  const plans = data.commitments
  const totalPurchased = data.totals?.purchased ?? null
  const totalUsed = data.totals?.used ?? null
  const totalUnused = data.totals?.unused ?? null
  const avgUtilization = data.totals?.utilization_pct ?? null

  // The copy follows the payload's own mode, not the selector state: the
  // selector sets what to REQUEST, the payload says what is SHOWN - so a
  // response can never be described by a mode it was not produced by.
  const aggregate = data.mode === 'aggregate'

  const breakdown = data.breakdown
  const categories = Object.entries(breakdown.by_category)
  const breakdownTotal = breakdown.total_unused_cents
  const categorized = categories.reduce((sum, [, cents]) => sum + cents, 0)
  const uncategorized = breakdownTotal === null ? 0 : breakdownTotal - categorized
  // Categories this file cannot answer: shown with the honest label, never
  // a $0. Only the ones the backend names - a category the backend did NOT
  // name was checked and genuinely contributed nothing, and stays absent.
  const nonDerivable = breakdown.non_derivable_categories ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Commitments"
        description="Reserved Instances and Savings Plans utilization"
        actions={
          <div className="flex items-center gap-3">
            {modeSelector}
            <RefreshingIndicator show={isFetching} />
          </div>
        }
      >
        <p className="mt-1 text-caption text-subtle">
          {aggregate
            ? 'Observed commitment history across completed checks. Totals require proven equivalent or disjoint observations; coverage and gaps are recorded below.'
            : data.check_id
              ? `Commitments in selected files, measured over the ${selectedCheck ? 'selected' : 'latest'} completed check window.`
              : null}
        </p>
      </PageHeader>
      {picker}
      {!aggregate && data.check_id && <LinkButton to={`/allocation?check=${data.check_id}`} variant="outline">View allocation for this check</LinkButton>}
      <CommitmentAssessment items={data.assessment} />
      {data.family_totals && <p className="text-caption text-muted-foreground">Combined totals below require both families to be established. Supported family subtotals remain available separately.</p>}

      {/* Summary tiles — every figure here is AWS billing evidence, so all four
          carry the lock. `evidence` is a prop rather than a child because the
          failure mode of adding it by hand is one tile out of four quietly
          losing it. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total purchased"
          value={totalPurchased === null ? 'Unavailable' : formatCents(totalPurchased)}
          caption={aggregate ? 'Amortized commitment over observed history' : 'Amortized commitment in the selected window'}
          evidence
        />
        <StatTile label="Amount used" value={totalUsed === null ? 'Unavailable' : formatCents(totalUsed)} caption={aggregate ? 'Measured fee usage over observed history' : 'Measured fee usage for the selected window'} evidence />
        <StatTile
          label="Amount unused"
          value={totalUnused === null ? 'Unavailable' : formatCents(totalUnused)}
          caption={totalUnused === null ? 'Review measurement coverage below' : 'Unused amortized commitment'}
          evidence
        />
        <StatTile
          label="Avg utilization"
          value={avgUtilization !== null ? `${avgUtilization.toFixed(1)}%` : '—'}
          caption={avgUtilization !== null ? 'Across all commitments' : 'Unknown for some plans'}
        />
      </div>

      <CommitmentFamilyTotals families={data.family_totals} />

      <p className="text-caption text-muted-foreground">
        Commitment amounts use a gross amortized USD basis. Savings Plans sum recurring-fee intervals; Reserved Instances reconcile effective usage and both unused fee components for complete active billing periods.
        Complete interval coverage applies to plans in these files; omitted plans, source delivery
        completeness and invoice reconciliation remain unverified. Observed amounts below describe
        only supplied intervals and cannot substitute for an unavailable {aggregate ? 'history' : 'whole-window'} total.
        Each metric and total is rounded once from exact amounts, so displayed plan values or
        purchased minus used may differ from displayed unused by a cent.
      </p>

      {/* Per-team view (Task 5): committed / used / remaining / utilisation /
          waste, from the tenant's own team configuration. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Commitments by plan-owner team <EvidenceLock />
          </CardTitle>
          <CardDescription>
            Teams identify the purchaser accounts that own plans. Used amounts describe
            those plans; consuming accounts are shown separately on Allocation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.teams.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No teams with commitments"
              description="Either no team maps the accounts your commitments sit on, or you have not configured teams yet. The plans table below shows the per-account truth either way."
            />
          ) : (
            <Table density="compact">
              <TableCaption className="px-4 pb-2">
                {aggregate
                  ? 'Proven observations across completed checks, grouped by plan-owner team.'
                  : 'Totals for this check, grouped by team.'}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>Accounts</TableHead>
                  <TableHead numeric>Committed</TableHead>
                  <TableHead numeric>Used</TableHead>
                  <TableHead numeric>Remaining</TableHead>
                  <TableHead numeric>Utilization</TableHead>
                  <TableHead numeric>Waste</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.teams.map((team) => (
                  <TableRow key={team.name}>
                    <TableCell className="font-medium">{team.name}</TableCell>
                    <TableCell className="font-mono">{team.accounts.join(', ')}</TableCell>
                    <TableCell numeric>{team.committed_cents === null ? 'Unavailable' : formatCents(team.committed_cents)}</TableCell>
                    <TableCell numeric>
                      {team.used_cents !== null ? formatCents(team.used_cents) : '—'}
                    </TableCell>
                    <TableCell numeric>
                      {team.remaining_cents !== null ? formatCents(team.remaining_cents) : '—'}
                    </TableCell>
                    <TableCell numeric>
                      {team.utilisation_pct !== null ? (
                        <Badge variant={utilizationVariant(team.utilisation_pct)}>
                          {team.utilisation_pct}%
                        </Badge>
                      ) : (
                        <span className="text-caption text-muted-foreground">unknown</span>
                      )}
                    </TableCell>
                    <TableCell numeric className="text-danger">
                      {team.waste_cents !== null ? formatCents(team.waste_cents) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Utilization trend — across REAL checks, never fabricated months */}
      {data.trend.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Utilization across checks</CardTitle>
            <CardDescription>
              Real history: one point per completed check (no fabricated 12-month series)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Recharts draws to SVG and measures its container, so it is
                meaningless to a screen reader and to an SSR render alike. The
                prose alternative is therefore not a nicety here: it is the only
                version of this information that exists for anyone who cannot
                see it. The chart keeps the aria-hidden so the two are not read
                as duplicates. */}
            <p className="sr-only">{describeTrend(data.trend)}</p>
            <div aria-hidden="true" className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data.trend.map((t) => ({
                    date: formatDate(t.date),
                    utilization: t.utilization_pct,
                  }))}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  {/* Token variables, not recharts' `#ccc` default. A chart
                      that draws its grid at the library's default grey is a
                      chart that ignores the palette. */}
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    stroke="var(--subtle-foreground)"
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    unit="%"
                    stroke="var(--subtle-foreground)"
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--border)' }}
                    contentStyle={{
                      background: 'var(--surface-raised)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      color: 'var(--foreground)',
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="utilization"
                    name="Utilization %"
                    connectNulls={false}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={{ r: 3, fill: 'var(--accent)' }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commitments Table */}
      <Card>
        <CardHeader>
          <CardTitle>{aggregate ? 'All commitments, aggregated' : 'All commitments'}</CardTitle>
          <CardDescription>
            {aggregate ? 'Every plan across your check history' : 'Plans observed in the check window'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No commitments detected in this check"
              description="A check only finds commitments if your AWS Cost and Usage Report covers the Savings Plans or Reserved Instances line items. If you hold reserved capacity, run a check over a window that includes it."
              action={<LinkButton to="/check">Run a check</LinkButton>}
            />
          ) : (
            <>
              <Table density="compact">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead numeric>Purchased</TableHead>
                    <TableHead numeric>Used</TableHead>
                    <TableHead numeric>Unused</TableHead>
                    <TableHead numeric>Utilization</TableHead>
                    <TableHead>Ends</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.name ?? '—'}
                        {p.measurement && <details className="mt-2 text-caption font-normal">
                          <summary>Measurement and coverage</summary>
                          <CommitmentHistoryCoverage coverage={p.measurement.history_coverage} />
                          {p.measurement.coverage && <p>{p.measurement.coverage.status} interval coverage:
                            {' '}{p.measurement.coverage.start} to {p.measurement.coverage.end}</p>}
                          {(['purchased', 'used', 'unused'] as const).map((key) => {
                            const metric = p.measurement?.metrics?.[key]
                            return metric && metric.value_cents === null && metric.observed_cents !== null
                              ? <p key={key}>Observed {key}: {formatCents(metric.observed_cents)} (supplied intervals only)</p> : null
                          })}
                          <CommitmentAssessment items={p.measurement.reasons} />
                        </details>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="neutral" className="capitalize">
                          {p.category.replace(/-/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell>{p.service ?? '—'}</TableCell>
                      {/* `numeric`, not a hand-rolled `text-right font-mono`
                          with a `flex` on the <td>. `display:flex` on a table
                          cell takes it out of the table layout algorithm, so
                          the cell stops participating in column widths and
                          the row stops lining up - which is why the amount
                          column here is the only one that is out. */}
                      <TableCell numeric>{p.amount_cents === null ? 'Unavailable' : formatCents(p.amount_cents)}</TableCell>
                      <TableCell numeric>{p.used_cents !== null ? formatCents(p.used_cents) : '—'}</TableCell>
                      <TableCell numeric className="text-danger">
                        {p.unused_cents !== null ? formatCents(p.unused_cents) : '—'}
                      </TableCell>
                      <TableCell numeric>
                        {p.utilization_pct !== null ? (
                          <Badge variant={utilizationVariant(p.utilization_pct)}>
                            {p.utilization_pct}%
                          </Badge>
                        ) : (
                          <span className="text-caption text-muted-foreground">unknown</span>
                        )}
                      </TableCell>
                      <TableCell>{p.end_date ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-3 text-caption text-subtle">
                Amounts are read from your AWS billing data. &ldquo;Unknown&rdquo;
                means the export did not carry consumption for that plan, not
                that it was unused.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Unused Breakdown — moved here from the allocation page (Task 5).
          It is commitment money, so it is commitment analysis; the allocation
          page keeps what consumed the commitments, not why they were unused. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Unused commitment breakdown <EvidenceLock />
          </CardTitle>
          <CardDescription>
            Why commitments were not fully utilised — computed by the pipeline
            from the billing rows, never estimated
          </CardDescription>
        </CardHeader>
        <CardContent>
          {breakdownTotal === null ? (
            <><p className="mb-3">Unused commitment breakdown unavailable for this scope.</p>
              <CommitmentAssessment items={breakdown.assessment} /></>
          ) : categories.length === 0 && nonDerivable.length === 0 ? (
            <EmptyState
              icon={PieChart}
              title="No unused commitment money in this view"
              description="Every commitment was fully consumed, or the window does not overlap one. The tables above still show what was committed and by whom."
              action={<LinkButton to="/check">Check a different window</LinkButton>}
            />
          ) : (
            <>
              <Table>
                <TableCaption className="px-4 pb-2">
                  Percentages are of the {formatCents(breakdownTotal)} total unused, not
                  of your bill. Categories this file cannot answer are labelled, not
                  shown as $0.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>What it means</TableHead>
                    <TableHead numeric>Amount</TableHead>
                    <TableHead numeric>% of total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories.map(([category, cents]) => (
                    <TableRow key={category}>
                      <TableCell className="font-medium capitalize">
                        {category.replace(/-/g, ' ')}
                      </TableCell>
                      <TableCell muted>{CATEGORY_DESCRIPTIONS[category] ?? 'Pipeline-derived category'}</TableCell>
                      <TableCell numeric>{formatCents(cents)}</TableCell>
                      <TableCell numeric>
                        {breakdownTotal > 0 ? Math.round((cents / breakdownTotal) * 100) : 0}%
                      </TableCell>
                    </TableRow>
                  ))}
                  {nonDerivable.map((category) => (
                    // A category the file cannot answer is LABELLED, never
                    // shown as $0: a $0 would claim it was checked and found
                    // zero. The tooltip carries the reason so the customer
                    // can tell "we could not know" from "we did not look".
                    <TableRow key={`nd-${category}`}>
                      <TableCell className="font-medium capitalize">
                        {category.replace(/-/g, ' ')}
                      </TableCell>
                      <TableCell muted>
                        {CATEGORY_DESCRIPTIONS[category] ?? 'Pipeline-derived category'}
                        {NON_DERIVABLE_EXPLANATIONS[category] ? (
                          <span className="block text-caption text-subtle">
                            {NON_DERIVABLE_EXPLANATIONS[category]}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell numeric>
                        <span title={NON_DERIVABLE_EXPLANATIONS[category] ?? undefined}>
                          {NON_DERIVABLE_LABEL}
                        </span>
                      </TableCell>
                      <TableCell numeric>—</TableCell>
                    </TableRow>
                  ))}
                  {categorized !== breakdownTotal ? (
                    // Only rendered when the two disagree. A total row that
                    // says "these figures do not add up" is more useful than one
                    // that silently rounds the difference away.
                    <TableRow className="bg-surface-alt">
                      <TableCell className="font-medium">Unattributed remainder</TableCell>
                      <TableCell muted>
                        Reported as unused but not placed in a category by the pipeline
                      </TableCell>
                      <TableCell numeric>{formatCents(uncategorized)}</TableCell>
                      <TableCell numeric>
                        {breakdownTotal > 0 ? Math.round((uncategorized / breakdownTotal) * 100) : 0}%
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              {uncategorized !== 0 ? (
                <div className="mt-3">
                  <Badge variant="warning">
                    The category breakdown does not account for the full unused total
                  </Badge>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** The two source modes (Task 5): one check, or the tenant's full history. */
function ModeSelector({
  mode,
  onChange,
  hasSelection = false,
}: {
  mode: SourceMode
  onChange: (mode: SourceMode) => void
  hasSelection?: boolean
}) {
  return (
    <div
      role="group"
      aria-label="Source mode"
      className="inline-flex overflow-hidden rounded-lg border border-border"
    >
      <button
        type="button"
        aria-pressed={mode === 'check'}
        onClick={() => onChange('check')}
        className={
          mode === 'check'
            ? 'min-h-11 bg-accent text-accent-foreground px-3 py-1.5 text-body-sm font-medium'
            : 'min-h-11 bg-surface text-foreground px-3 py-1.5 text-body-sm hover:bg-surface-alt'
        }
      >
        {hasSelection ? 'Selected check' : 'Latest check'}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'aggregate'}
        onClick={() => onChange('aggregate')}
        className={
          mode === 'aggregate'
            ? 'min-h-11 bg-accent text-accent-foreground px-3 py-1.5 text-body-sm font-medium'
            : 'min-h-11 bg-surface text-foreground px-3 py-1.5 text-body-sm hover:bg-surface-alt'
        }
      >
        Full history
      </button>
    </div>
  )
}

/**
 * Thresholds for the utilization badge.
 *
 * The middle band is `warning`, not a neutral grey. The previous mapping had
 * 70-90% rendering as `secondary` - a neutral - on the reasoning that it is
 * "not bad". But on this page a number under 90% is precisely the number that
 * represents capacity you are paying for and not using, which is the thing the
 * product exists to surface. A neutral badge said "fine" about the one figure
 * that is not.
 */
function utilizationVariant(pct: number): 'success' | 'warning' | 'danger' {
  if (pct >= 90) return 'success'
  if (pct >= 70) return 'warning'
  return 'danger'
}

/** The chart's prose equivalent, for the `sr-only` paragraph beside it. */
function describeTrend(trend: { date: string; utilization_pct: number | null }[]): string {
  const points = trend
    .map((t) => `${formatDate(t.date)}: ${t.utilization_pct == null ? 'unknown' : `${t.utilization_pct}%`}`)
    .join(', ')
  return `Utilization across ${trend.length} completed checks. ${points}.`
}
