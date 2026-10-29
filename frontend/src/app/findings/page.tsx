import { SendReport } from './send-report-dialog'
import { CheckHistoryMore } from '@/components/check-history-more'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Archive, Filter, History as HistoryIcon, Inbox, SearchX } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Toast } from '@/components/ui/toast'
import { cutoffError } from './bulk-archive'
import { LinkButton } from '@/components/ui/link-button'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { ListSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import { evidenceAmount, findingAmount, impactLabel, usesCommitmentMeasurement } from '@/lib/finding-amount'
import { retentionPlanLabel } from '@/lib/plan-label'
import { formatDateTime } from '@/lib/utils'
import { useBulkArchiveFindings, useChecks, useFindings, usePlan, useRetention } from '@/lib/queries'
import {
  DETECTOR_TYPES,
  FINDING_STATUSES,
  SEVERITIES,
  humanise,
} from '@/app/findings/detector-types'
import { allRoute, checkRoute } from '@/app/findings/routes'

/**
 * A filter value from the URL, if it is one this page can actually filter on.
 *
 * Validated against the vocabulary rather than passed through. An unvalidated
 * `?severity=sevre` would filter everything out while the select still displayed
 * "All severities": the list would be empty, the controls would claim no filter
 * was active, and the "Clear all filters" button that state depends on would
 * not be there. A junk parameter is ignored, which is the only response that
 * leaves the page telling the truth about itself.
 */
function vocabParam(params: URLSearchParams, key: string, allowed: readonly string[]): string {
  const value = params.get(key)
  return value !== null && allowed.includes(value) ? value : 'all'
}

export function Findings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const checkFilter = searchParams.get('check')
  const allMode = searchParams.get('all') === '1'

  const filterSeverity = vocabParam(searchParams, 'severity', SEVERITIES)
  const filterType = vocabParam(searchParams, 'type', DETECTOR_TYPES)
  const filterStatus = vocabParam(searchParams, 'status', FINDING_STATUSES)
  const searchQuery = searchParams.get('q') ?? ''
  const includeArchived = searchParams.get('archived') === '1'
  const requestedOffset = Number(searchParams.get('offset') ?? 0)
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (!value || value === 'all') next.delete(key); else next.set(key, value)
    next.delete('offset')
    setSearchParams(next, { replace: key === 'q' })
  }
  const goToPage = (nextOffset: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextOffset) next.set('offset', String(nextOffset)); else next.delete('offset')
    setSearchParams(next)
  }

  // Task 8: the bulk archive. A date cutoff and a confirmation - archiving
  // is reversible only by un-archiving checks one by one, and the date is
  // the tenant saying how much history they are willing to put away.
  const bulkArchive = useBulkArchiveFindings()
  const [archiveOpen, setArchiveOpen] = useState(true)
  const [archiveCutoff, setArchiveCutoff] = useState('')
  const [archiveConfirming, setArchiveConfirming] = useState(false)
  const [archiveResult, setArchiveResult] = useState<string | null>(null)
  const [archiveFailure, setArchiveFailure] = useState(false)
  const dateError = cutoffError(archiveCutoff)

  const submitBulkArchive = async () => {
    if (cutoffError(archiveCutoff) || bulkArchive.isPending) return
    setArchiveResult(null)
    setArchiveFailure(false)
    try {
      const result = await bulkArchive.mutateAsync(archiveCutoff)
      setArchiveResult(
        `Archived ${result.findings_archived} finding${result.findings_archived === 1 ? '' : 's'} ` +
        `from ${result.checks_archived} check${result.checks_archived === 1 ? '' : 's'} ` +
        `run before ${result.cutoff}. Nothing was deleted.`,
      )
      setArchiveOpen(false)
      setArchiveConfirming(false)
    } catch (err) {
      setArchiveFailure(true)
      setArchiveConfirming(false)
      setArchiveResult(String(err instanceof Error ? err.message : err))
    }
  }

  // Retention (Task 4). A property of the plan, not of the current filter, so
  // it is fetched once and rendered above the list. Deliberately a separate
  // request from the findings: nothing the user filters by changes it, and
  // folding it into the findings payload would re-send it on every keystroke's
  // refetch.
  const retention = useRetention()
  const plan = usePlan()
  const retentionLabel = retentionPlanLabel(retention.data?.tier ?? null, plan.error ? null : plan.data)

  // History (live-testing Task 1). The checks list is newest-first, so the
  // default check is the first *completed* one - not checks[0], which is the
  // newest by timestamp and can be the run that just failed. Opening a
  // findings page on a half-finished run shows one partial finding and calls
  // it the state of the account.
  const checksQuery = useChecks()
  const checks = checksQuery.data ?? []
  const newestCompleted = checks.find((c) => c.status === 'completed' && !c.archived_at)
  const effectiveCheck = allMode ? undefined : (checkFilter ?? newestCompleted?.id)

  // The default has to be resolved from the checks list, so the findings
  // query waits for it - and only for it. An explicit `?check=` or history
  // mode needs nothing else and loads immediately; the alternative is an
  // unfiltered flash of every finding followed by a correction.
  const needsChecks = !allMode && checkFilter === null
  const { data, assessments, pagination, isPending, error, isFetching, refetch, isRefetching } = useFindings(
    effectiveCheck,
    100,
    allMode,
    allMode || checkFilter !== null || checksQuery.isSuccess,
    includeArchived,
    { offset, severity: filterSeverity, detector_type: filterType, state: filterStatus, search: searchQuery },
  )
  const findings = data ?? []

  if (error || (needsChecks && checksQuery.isError)) {
    return (
      <div className="space-y-6">
        <PageHeader title="Findings" />
        <ErrorState
          error={error ?? checksQuery.error}
          onRetry={() => {
            void refetch()
            void checksQuery.refetch()
          }}
          isRetrying={isRefetching}
        />
      <CheckHistoryMore query={checksQuery} />
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title="Findings" />
        <ListSkeleton label="Loading findings" />
      </div>
    )
  }

  const filteredFindings = findings.filter((f) => {
    if (filterSeverity !== 'all' && f.severity !== filterSeverity) return false
    if (filterType !== 'all' && f.detector_type !== filterType) return false
    if (filterStatus !== 'all' && (f.state?.status ?? 'open') !== filterStatus) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (!f.title.toLowerCase().includes(q) && !f.subject.toLowerCase().includes(q)) return false
    }
    return true
  })


  // Whether anything is filtering, which is what distinguishes "there is nothing
  // here" from "your filters hid everything". They look identical in a table and
  // need opposite responses from the user.
  const filtersActive =
    filterSeverity !== 'all' || filterType !== 'all' || filterStatus !== 'all' || searchQuery !== ''

  const clearFilters = () => {
    // The URL too. Leaving `?severity=high` behind would let the selects say
    // "All" while a reload silently re-applied the filter - the controls and
    // the link would disagree. `replace` rather than `push`, because undoing a
    // filter is not a navigation anyone needs to step back through.
    const next = new URLSearchParams(searchParams)
    for (const key of ['severity', 'type', 'status', 'q', 'offset']) next.delete(key)
    setSearchParams(next, { replace: true })
  }

  // What the header should call the check being viewed: its date when the
  // checks list knows it (the readable answer), the id prefix otherwise (the
  // honest answer when the list is unavailable), never a guess.
  const viewedCheck = checks.find((c) => c.id === effectiveCheck)
  // "Your full history" was dropped from the history-mode description by Task
  // 4, and that is the fix rather than a rewording: retention now bounds the
  // history, so the claim is no longer true, and a page that says "full
  // history" directly above a note saying "the last 90 days" contradicts
  // itself. "Every finding" is scoped by the note below the list.
  const description = allMode
    ? 'Every finding from every completed check'
    : effectiveCheck
      ? viewedCheck
        ? `Unusual charges and commitment waste from your check on ${formatDateTime(viewedCheck.created_at)}`
        : `Unusual charges and commitment waste, filtered to check ${effectiveCheck.slice(0, 8)}`
      : 'All unusual charges and commitment waste detected'

  // What the check selector displays. In history mode the selector still
  // names a real check - the one the page would return to - because a select
  // whose value matches no option is a control lying about its own state;
  // choosing any option turns history mode off (checkRoute drops `all`).
  const selectedInControl = allMode ? (newestCompleted?.id ?? '') : (effectiveCheck ?? '')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Findings"
        description={description}
        actions={<><RefreshingIndicator show={isFetching} />{effectiveCheck && checks.some(c => c.id === effectiveCheck && c.status === 'completed' && !c.archived_at) && <SendReport checkId={effectiveCheck} />}</>}
      />
      <CommitmentAssessment items={assessments} />

      {/* Check history (live-testing Task 1). Past checks were reachable only
          through /reports, and tenants did not find them there; this puts the
          runs themselves at the top of the findings page. The URL stays the
          source of truth: the selector and the toggle both navigate, so what
          you see is always what the address says. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="h-4 w-4 text-subtle" aria-hidden="true" />
            Check history
          </CardTitle>
          <CardDescription>
            Findings are kept for every check you have run. Pick a run, or show them all at once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="findings-check" label="Check">
              {(control) => (
                <Select
                  {...control}
                  value={selectedInControl}
                  onChange={(e) => navigate(checkRoute(e.target.value || null, searchParams))}
                >
                  {/* Only when there is nothing to choose: a select with zero
                      options is a broken control, and the empty state below
                      says the rest. */}
                  {checks.length === 0 ? (
                    <option value="">No checks yet</option>
                  ) : null}
                  {selectedInControl && !checks.some(c => c.id === selectedInControl) ? <option value={selectedInControl}>Check {selectedInControl.slice(0, 8)} (outside loaded history)</option> : null}
                  {checks.map((c) => (
                    <option key={c.id} value={c.id}>
                      {formatDateTime(c.created_at)} — {c.findings_count}{' '}
                      {c.findings_count === 1 ? 'finding' : 'findings'}
                      {c.archived_at ? ' (archived)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {/* The toggle and its label are one tap target (the signup page's
                pattern), because a 16px checkbox is not. */}
            <div className="flex items-end pb-1.5">
              <label
                htmlFor="findings-show-all"
                className="flex min-h-11 w-fit cursor-pointer items-center gap-2 py-1"
              >
                <input
                  id="findings-show-all"
                  type="checkbox"
                  checked={allMode}
                  onChange={() =>
                    navigate(
                      allMode
                        ? checkRoute(newestCompleted?.id ?? null, searchParams)
                        : allRoute(searchParams),
                    )
                  }
                  className="h-4 w-4 shrink-0 rounded border-border accent-[var(--accent)]"
                />
                <span className="text-body text-muted-foreground">
                  Show all findings across every check
                </span>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="Findings shown"
          value={filteredFindings.length}
          caption={pagination ? `of ${pagination.total} matching findings` : filtersActive ? `of ${findings.length} total` : 'matching the current filters'}
        />
        <StatTile
          label="Open items on this page"
          value={filteredFindings.filter((f) => (f.state?.status ?? 'open') === 'open').length}
          caption="Not yet resolved or archived"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-subtle" aria-hidden="true" />
            Filters
          </CardTitle>
          <CardDescription>
            Filters apply to all matching findings before the server selects this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* `Field` rather than a bare `<label>` above each control. The four
              filters used to be `<label className="text-sm">Search</label>`
              followed by an `<Input>` with no id: the label was associated with
              nothing, so clicking it did not focus the field and a screen reader
              announced the control with no name. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="findings-search" label="Search">
              {(control) => (
                <Input
                  {...control}
                  type="search"
                  placeholder="Title or subject"
                  value={searchQuery}
                  onChange={(e) => updateFilter('q', e.target.value)}
                />
              )}
            </Field>

            <Field id="findings-severity" label="Severity">
              {(control) => (
                <Select
                  {...control}
                  value={filterSeverity}
                  onChange={(e) => updateFilter('severity', e.target.value)}
                >
                  <option value="all">All severities</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field id="findings-type" label="Type">
              {(control) => (
                <Select {...control} value={filterType} onChange={(e) => updateFilter('type', e.target.value)}>
                  <option value="all">All types</option>
                  {DETECTOR_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {humanise(t)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field id="findings-status" label="Status">
              {(control) => (
                <Select
                  {...control}
                  value={filterStatus}
                  onChange={(e) => updateFilter('status', e.target.value)}
                >
                  <option value="all">All statuses</option>
                  {FINDING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          {/* Task 8: show/hide archived, beside the filters it belongs with.
              One tap target, the same pattern as the show-all toggle above. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label
              htmlFor="findings-include-archived"
              className="flex min-h-11 w-fit cursor-pointer items-center gap-2"
            >
              <input
                id="findings-include-archived"
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => updateFilter('archived', e.target.checked ? '1' : '')}
                className="h-4 w-4 shrink-0 rounded border-border accent-[var(--accent)]"
              />
              <span className="text-body text-muted-foreground">
                Show archived findings
              </span>
            </label>

            {/* Task 8: the bulk archive, gated by a confirmation. Archiving
                puts whole check runs away - reversible only by un-archiving
                checks one by one - so the button opens the choice rather
                than acting. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setArchiveOpen(!archiveOpen)
                setArchiveConfirming(false)
                setArchiveResult(null)
              }}
            >
              <Archive className="h-4 w-4" aria-hidden="true" />
              Bulk actions
            </Button>
          </div>

          {archiveOpen ? (
            <div
              role="group"
              aria-label="Bulk archive"
              className="mt-4 rounded-md border border-border bg-surface-alt p-4 space-y-3"
            >
              <p className="text-body text-muted-foreground">
                Archive whole completed checks created strictly before the cutoff (UTC), including their findings. Nothing is deleted.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field id="findings-archive-cutoff" label="Cutoff date (UTC)" error={archiveCutoff ? dateError : undefined} required>
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      required
                      max={new Date().toISOString().slice(0, 10)}
                      value={archiveCutoff}
                      onChange={(e) => {
                        setArchiveCutoff(e.target.value)
                        setArchiveConfirming(false)
                      }}
                    />
                  )}
                </Field>
                  <Button
                    variant="secondary"
                    disabled={!!dateError || bulkArchive.isPending}
                    onClick={() => setArchiveConfirming(true)}
                    aria-label={`Start archiving findings from checks run before ${archiveCutoff}`}
                  >
                    Archive older than
                  </Button>
                <Button variant="ghost" size="sm" onClick={() => setArchiveOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {/* The archive's answer: what moved, or why nothing did. Rendered
              outside the panel so it survives the panel closing. */}
          {archiveResult ? (
            <Toast title={archiveResult} variant={archiveFailure ? 'danger' : 'success'} onDismiss={() => setArchiveResult(null)} data-testid="archive-result" />
          ) : null}
          <Dialog open={archiveConfirming} onOpenChange={open => { if (!bulkArchive.isPending) setArchiveConfirming(open) }} title="Archive older checks?"
            description={`Archive whole completed checks created before ${archiveCutoff} at 00:00 UTC, including their findings. This affects all matching checks, not only the current filters. Nothing is deleted; unarchive individual checks from Reports.`}>
            <Button variant="danger" loading={bulkArchive.isPending} onClick={() => void submitBulkArchive()}>Confirm archive</Button>
          </Dialog>

          {filtersActive ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-caption text-muted-foreground">
                Showing {filteredFindings.length} of {pagination?.total ?? findings.length} matching findings.
              </p>
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Task 4: how long findings are kept is a property of the plan, and a
          list that quietly drops older rows without a word is exactly the kind
          of silent behaviour this project treats as a bug. The note is rendered
          only once the window is *known*: a "90 days" guessed in the browser
          would explain a retention policy that might not be in force, which is
          worse than saying nothing at all. */}
      {retention.data ? (
        <p
          className="text-caption text-muted-foreground"
          data-testid="retention-note"
        >
          {retention.data.retention_days === -1 ? 'Showing retained findings with no automatic expiry (Owner plan).' : retention.data.retention_days != null ? `Showing findings from the last ${retention.data.retention_days} days${retentionLabel ? ` (${retentionLabel})` : ''}.` : (retention.data.recovery ?? 'Retention policy is unknown; existing data is preserved.')}
        </p>
      ) : null}

      {pagination ? <div className="flex flex-wrap items-center justify-between gap-3" aria-label="Findings pagination">
        <p role="status" className="text-caption text-muted-foreground">
          {isFetching ? 'Updating matching results… ' : ''}
          {pagination.total ? `${pagination.offset + 1}–${pagination.offset + pagination.returned}` : '0'} of {pagination.total} matching findings
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={offset === 0 || isFetching} onClick={() => goToPage(Math.max(0, offset - 100))}>Previous page</Button>
          <Button variant="secondary" disabled={!pagination.has_more || isFetching} onClick={() => goToPage(offset + 100)}>Next page</Button>
        </div>
      </div> : null}

      <Card>
        <CardHeader>
          <CardTitle>
            {filtersActive ? 'Matching findings' : 'All findings'} ({filteredFindings.length})
          </CardTitle>
          <CardDescription>Select a finding to see its evidence and history</CardDescription>
        </CardHeader>
        <CardContent className={filteredFindings.length === 0 ? 'pt-0' : 'p-0'}>
          {filteredFindings.length === 0 ? (
            // Two different empty states, because they need opposite responses.
            // "No findings" when nothing is filtered means the checks found
            // nothing; "nothing matches" when filters are active means the
            // filters are too narrow, and telling the user to run a check would
            // be actively wrong advice.
            filtersActive ? (
              <EmptyState
                icon={SearchX}
                title="Nothing matches these filters"
                description="No findings match the current filters. Widen or clear the filters to see other findings."
                action={
                  <Button variant="secondary" size="lg" onClick={clearFilters}>
                    Clear all filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title="No findings"
                description="No findings were recorded in this window. Review check coverage and limitations before drawing a conclusion."
              />
            )
          ) : (
            // `maxHeight` is what makes the sticky header do anything. Without a
            // cap the wrapper grows to fit and the header never sticks, because
            // there is nothing to scroll past - and 200 findings is a lot of
            // scrolling.
            <Table maxHeight="32rem">
              <TableCaption className="px-4 pb-2">
                Impact and evidence figures come from AWS billing data and are read-only.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Finding</TableHead>
                  <TableHead>Check</TableHead>
                  <TableHead>Type</TableHead>
                  {/* Feature 1.5: the team this finding's AWS account is
                      attributed to - the name when a team is registered, the
                      raw account id when one is not (still more actionable
                      than a blank), nothing when the coarse key carries no
                      account. */}
                  <TableHead>Team</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead numeric>Impact</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFindings.map((finding) => (
                  <TableRow key={finding.id}>
                    <TableCell>
                      <Link
                        to={`/findings/${finding.id}`}
                        className="block min-h-11 font-medium text-foreground hover:text-accent"
                      >
                        {finding.title}
                      </Link>
                      <p className="mt-0.5 max-w-prose text-caption text-muted-foreground">
                        {finding.description}
                      </p>
                    </TableCell>
                    {/* The check this finding came from, linked (1.3). The
                        column exists in every mode, not only "show all": in
                        one-check mode every row names the same run, and that
                        is the honest picture - the row's evidence belongs to
                        that run whether or not the view is filtered to it. A
                        LinkButton, not a button that navigates: the check is
                        a destination (it opens a filtered view), and a real
                        anchor can be middle-clicked, copied and announced as
                        a link. */}
                    <TableCell>
                      {finding.check_id ? (
                        <LinkButton
                          to={checkRoute(finding.check_id)}
                          variant="link"
                          size="sm"
                        >
                          {finding.check_created_at
                            ? formatDateTime(finding.check_created_at)
                            : `check ${finding.check_id.slice(0, 8)}`}
                        </LinkButton>
                      ) : (
                        <span className="text-caption text-subtle">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral">{humanise(finding.detector_type)}</Badge>
                    </TableCell>
                    <TableCell muted>
                      {/* Feature 1.5: the registered team name, else the raw
                          account id, else nothing - the mapping the spec
                          ordered, and each step is a real answer rather than a
                          blank that looks like a layout bug. */}
                      {finding.team_name ?? finding.aws_account_id ?? '—'}
                      {finding.current_owners?.map(owner => <span key={owner.mapping_id} className="block break-all text-caption" title={`Current ownership: ${owner.match_key}`}>{owner.email}</span>)}
                    </TableCell>
                    {/* Feature 1.6: the derived service the pipeline attached
                        to the finding - never `subject.split(' / ')[0]`,
                        which showed the account id whenever optional product
                        metadata left the service slot empty. */}
                    <TableCell muted>{finding.service || '—'}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          finding.severity === 'critical'
                            ? 'danger'
                            : finding.severity === 'high'
                              ? 'warning'
                              : finding.severity === 'medium'
                                ? 'info'
                                : 'neutral'
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
                      <span className="mt-0.5 block text-caption text-subtle">
                        {usesCommitmentMeasurement(finding) ? 'Commitment fee measurement' : `evidence ${evidenceAmount(finding, finding.evidence_total_cents)}`}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          finding.state?.status === 'resolved'
                            ? 'success'
                            : finding.state?.status === 'archived'
                              ? 'neutral'
                              : 'info'
                        }
                      >
                        {finding.state?.status ?? 'open'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
