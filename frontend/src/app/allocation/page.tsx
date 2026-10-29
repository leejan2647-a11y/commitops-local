import { CheckScopePicker } from '@/components/check-scope-picker'
import { Tabs } from '@/components/ui/tabs'
import { TeamsHistory } from './teams-history'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, PieChart, Users } from 'lucide-react'

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
import { EmptyState, ErrorState, PageHeader } from '@/components/page-states'
import { PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { CommitmentFamilyTotals } from '@/components/commitment-family-totals'
import { formatCents } from '@/lib/api'
import { useAllocation, useCheck, useChecks } from '@/lib/queries'
import { explainMissing, resolveAllocationTarget } from '@/app/allocation/target'

export function Allocation() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'history' ? 'history' : 'commitments'
  return <Tabs id="allocation-sections" aria-label="Allocation sections" value={tab}
    items={[{ value: 'commitments', label: 'Commitment allocation' }, { value: 'history', label: 'Teams History' }]}
    onValueChange={value => {
      const next = new URLSearchParams(params)
      if (value === 'history') next.set('tab', 'history'); else next.delete('tab')
      setParams(next)
    }}>
    {value => value === 'history' ? <TeamsHistory /> : <CommitmentAllocation />}
  </Tabs>
}

function CommitmentAllocation() {
  // Cached (Task F.1b-fix), and the dependency chain the old code hid is now
  // explicit: the check list decides WHICH check, and the id it yields is the
  // key for the two dependent queries. Until that id exists the dependent
  // queries stay disabled, which is why `enabled: Boolean(id)` matters here.
  //
  // The original permanent-spinner bug was two defects: `checks.find(status ===
  // 'completed')` returned undefined for a tenant whose only check had failed,
  // and the loading branch (`check === null && allocation === null`) was still
  // true while the effect was still in flight, so no state ever settled it.
  const checksQuery = useChecks(100)
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedCheck = searchParams.get('check') || undefined
  const target = resolveAllocationTarget(checksQuery.data ?? [])
  const checkId = requestedCheck ?? (target.kind === 'usable' ? target.check.id : undefined)
  const picker = <CheckScopePicker id="allocation-check" query={checksQuery} selected={requestedCheck} onChange={id => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('check', id); else next.delete('check')
    setSearchParams(next)
  }} />

  const checkQuery = useCheck(checkId)
  const allocationQuery = useAllocation(checkId)

  const error = (!requestedCheck ? checksQuery.error : null) ?? checkQuery.error ?? allocationQuery.error

  // Refetch the request that failed. Refreshing the list alone does not retry
  // a failed dependent query when its selected check id stays the same.
  const retry = () => {
    if (checksQuery.error) void checksQuery.refetch()
    if (checkId && checkQuery.error) void checkQuery.refetch()
    if (checkId && allocationQuery.error) void allocationQuery.refetch()
  }
  const isRetrying = checksQuery.isRefetching || checkQuery.isRefetching || allocationQuery.isRefetching

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Allocation"
          description="Which accounts consume shared commitments"
        />
        {picker}
        <ErrorState error={error} title="Could not load allocation" onRetry={retry} isRetrying={isRetrying} />
      </div>
    )
  }

  // Loading means: either the list is still in flight, or the list resolved to a
  // usable check whose detail/allocation are still in flight. Both are honest
  // "waiting", and both end in one of the three states below.
  if ((!requestedCheck && checksQuery.isPending) || (checkId && (checkQuery.isPending || allocationQuery.isPending))) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Allocation"
          description="Which accounts consume shared commitments"
        />
        {picker}
        <PageSkeleton label="Loading allocation" />
      </div>
    )
  }

  if (!requestedCheck && target.kind !== 'usable') {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Allocation"
          description="Which accounts consume shared commitments"
        />
        {picker}
        {target.kind === 'unusable' ? (
          <Card className="border-warning/40">
            <CardContent className="flex flex-col items-start gap-4 py-8 sm:flex-row sm:items-center">
              <span
                aria-hidden="true"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-warning-tint text-warning"
              >
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-h3 font-bold text-foreground">
                  This check cannot be broken down yet
                </h2>
                <p className="mt-1 text-body text-muted-foreground">{explainMissing(target.check)}</p>
              </div>
              <LinkButton
                to="/check"
                variant="secondary"
                size="lg"
                className="w-full shrink-0 sm:w-auto"
              >
                Run another check
              </LinkButton>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={PieChart}
            title="No completed checks yet"
            description="Allocation is computed from a finished check: it needs the billing rows loaded and reconciled. Run one and this page will show which accounts drew on shared commitments."
            action={<LinkButton to="/check">Run your first check</LinkButton>}
          />
        )}
      </div>
    )
  }

  const check = checkQuery.data
  const allocation = allocationQuery.data
  if (!check || !allocation) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Allocation"
          description="Which accounts consume shared commitments"
        />
        {picker}
        <PageSkeleton label="Loading allocation" />
      </div>
    )
  }

  const accounts = Object.entries(allocation.consumed_by_account)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Allocation"
        description="Which accounts consume shared commitments"
        actions={
          <RefreshingIndicator show={checkQuery.isFetching || allocationQuery.isFetching} />
        }
      >
        <p className="mt-1 text-caption text-subtle">
          Check {check.id.slice(0, 8)}… · {check.window_start} → {check.window_end}
        </p>
      </PageHeader>
      {picker}
      <LinkButton to={`/commitments?check=${check.id}`} variant="outline">View commitments for this check</LinkButton>
      <CommitmentAssessment items={allocation.assessment} />
      <CommitmentFamilyTotals families={allocation.family_totals} beneficiaries />

      {allocation.ri_evidence && allocation.ri_evidence.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reserved Instance source facts</CardTitle>
            <CardDescription>Source dates and regions for Reserved Instances with unused money.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {allocation.ri_evidence.map((row) => (
                <li key={row.plan_id} className="space-y-1 text-body">
                  <p className="break-all font-mono text-caption">{row.plan_id}</p>
                  {row.expired_since && <p>Expired since {row.expired_since}</p>}
                  {row.purchase_region && <p>Purchase region: {row.purchase_region}</p>}
                  {row.consumed_regions && row.consumed_regions.length > 0 && (
                    <p>Observed consumption regions: {row.consumed_regions.join(', ')}</p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Task 5 moved the unused-commitment breakdown to the Commitments page.
          This page keeps the one question that is allocation's own: which
          AWS accounts drew on the shared commitments. The breakdown of why
          commitments went unused lives with the commitments it describes. */}

      {/* Consumption by account — real billing data, no invented team names */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Consumption by account <EvidenceLock />
          </CardTitle>
          <CardDescription>
            Which AWS accounts drew on shared commitments identified in the selected files (team names come from
            Settings → Team Mappings, applied later — the data here is what the
            billing rows say)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {allocation.consumed_available === false ? (
            <p>Beneficiary allocation unavailable across both commitment families. Review the family subtotals above for independently measured plans and the missing-data guidance. Selected files do not establish account-wide plan inventory.</p>
          ) : <>
          {accounts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No shared-plan consumption in this window"
              description="Nothing in this check drew on a Savings Plan or Reserved Instance. If you expect shared usage, the report may not cover the commitment line items, or the window may sit outside the plan's term."
              action={<LinkButton to="/check">Run a check over a different window</LinkButton>}
            />
          ) : (
            <>
              <Table density="compact">
                <TableCaption className="px-4 pb-2">
                  Account ids and amounts are read from your AWS billing data.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead numeric>Consumed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map(([account, cents]) => (
                    <TableRow key={account}>
                      <TableCell className="font-mono">{account}</TableCell>
                      {/* `numeric`, not a `flex` <td>. `display:flex` takes the
                          cell out of the table layout algorithm, so it stops
                          contributing to column widths and the row stops
                          lining up. */}
                      <TableCell numeric>{formatCents(cents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
          </>}
          {allocation.consumed_available === false && Object.keys(allocation.observed_consumed_by_account ?? {}).length > 0 && (
            <div className="mt-4">
              <h3 className="font-medium">Observed contributions only</h3>
              <p className="text-caption text-muted-foreground">These supplied rows are incomplete or unreconciled and are excluded from allocation totals.</p>
              <Table><TableHeader><TableRow><TableHead>Account</TableHead><TableHead numeric>Observed</TableHead></TableRow></TableHeader>
                <TableBody>{Object.entries(allocation.observed_consumed_by_account ?? {}).map(([account, value]) =>
                  <TableRow key={account}><TableCell>{account}</TableCell><TableCell numeric>{formatCents(value)}</TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
