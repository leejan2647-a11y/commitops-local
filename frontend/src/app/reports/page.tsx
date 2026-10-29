import { usePrivateApi } from '@/lib/private-queries'
import { CheckHistoryMore } from '@/components/check-history-more'
import { Fragment, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Download, FileText, Plus, Share2, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Toast } from '@/components/ui/toast'
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
import { CommitmentAssessment } from '@/components/commitment-assessment'
import { ListSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import {
  useArchiveReport,
  useChecks,
  useCreateReport,
  useDeleteReport,
  useDownloadCheckCsv,
  useDownloadReport,
  useReports,
  useRestoreCheck,
  useArchiveCheck,
  useRenameReport,
} from '@/lib/queries'
import type { CheckSummary, SavedReport } from '@/lib/types'
import { formatDateTime } from '@/lib/utils'
import { formErrors } from '@/lib/form-errors'

/**
 * The report's check selection, read out of the stored config (Task 3).
 *
 * Returns `string[]` rather than trusting the shape: reports created before
 * Task 3 stored `{"type": "check"}` and have no `check_ids` at all, and a report
 * whose config cannot be read must render as "no checks" - visibly - rather than
 * throwing inside a table row and taking the page down with it.
 */
function selectedCheckIds(report: SavedReport): string[] {
  const raw = (report.config_json as { check_ids?: unknown }).check_ids
  return Array.isArray(raw) ? raw.map(String) : []
}

/** `2026-08-01 → 2026-08-31`, or a dash when the check recorded no window. */
function checkWindow(check: CheckSummary): string {
  return check.window_start && check.window_end
    ? `${check.window_start} → ${check.window_end}`
    : 'no window recorded'
}

export function Reports() {
  const {downloadText}=usePrivateApi()
  // Cached (Task F.1b-fix). Both lists are independent, so they load
  // concurrently; every mutation below invalidates them, replacing the old
  // reloadSaved() that each call site had to remember.
  const checksQuery = useChecks(100)
  const reportsQuery = useReports()
  const createReportMutation = useCreateReport()
  const deleteReportMutation = useDeleteReport()
  const downloadReportMutation = useDownloadReport()
  const archiveReportMutation = useArchiveReport()
  const downloadCsvMutation = useDownloadCheckCsv()
  const restoreCheckMutation = useRestoreCheck()
  const archiveCheckMutation = useArchiveCheck()
  const renameReportMutation = useRenameReport()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState<string | undefined>()
  const [archiveCheckTarget, setArchiveCheckTarget] = useState<CheckSummary | null>(null)
  const [checkNotice, setCheckNotice] = useState<{ title: string; danger?: boolean } | null>(null)
  const [restoringCheck, setRestoringCheck] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const createInFlight = useRef(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  // The selection is what makes a report useful (Task 3). Kept as an ordered
  // array, not a Set: the order the user ticked the boxes is the order the
  // report reads in, and serialising a Set would lose it.
  const [selected, setSelected] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  // Which row is mid-delete, so only that row's button is disabled. A single
  // boolean would grey out the whole table and a second click on a *different*
  // row would be silently swallowed.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // Per-row busy ids, for the same reason: a download or a share in flight on
  // one row must not disable the other rows' controls.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [archivingId, setArchivingId] = useState<string | null>(null)
  // Report id -> the share path the server just returned. The row also renders
  // the link from `share_token` when it loads, so a report shared in a previous
  // session still offers its link; this state only covers the press that had not
  // been refetched yet.
  // Task 7: the share dialog. The Share button opens it with the report it is
  // sharing; the expiry choice is state so a re-opened dialog shows the last
  // choice rather than resetting to seven days.

  const checks = checksQuery.data ?? []
  const saved = reportsQuery.data ?? []
  const error = checksQuery.error ?? reportsQuery.error
  const isFetching = checksQuery.isFetching || reportsQuery.isFetching

  // Completed and not archived: a failed run's half-finished analysis is not a
  // report input, and an archived check is history the user put away.
  const completed = checks.filter((c) => c.status === 'completed' && c.archived_at === null)

  const toggleCheck = (id: string, include: boolean) => {
    setSelected((prev) =>
      include ? [...prev, id] : prev.filter((existing) => existing !== id),
    )
  }

  const createReport = async () => {
    // Enter can fire twice before React Query's pending render reaches the DOM.
    if (createInFlight.current) return
    setFormError(null)
    if (!name.trim()) {
      setFormError('name is required')
      return
    }
    if (selected.length === 0) {
      // Reachable, not dead code: pressing Enter in the name field calls this
      // directly and never touches the disabled Save button. Three layers of the
      // same rule (here, the button, the server) is deliberate - they guard
      // three different callers, and the one that matters is the server's,
      // because a stale browser bundle still sends whatever it was built with.
      setFormError('Select at least one check')
      return
    }
    createInFlight.current = true
    setCreating(true)
    try {
      await createReportMutation.mutateAsync({
        name: name.trim(),
        config: { check_ids: selected },
      })
      setName('')
      setSelected([])
      setAdding(false)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      createInFlight.current = false
      setCreating(false)
    }
  }

  const renameReport = async () => {
    if (!renaming || renameReportMutation.isPending) return
    if (!renameName.trim()) { setRenameError('Name is required'); return }
    setRenameError(undefined); setFormError(null)
    try {
      await renameReportMutation.mutateAsync({ id: renaming, name: renameName.trim() })
      setRenaming(null); setCheckNotice({ title: 'Report renamed' })
    } catch (err) {
      const parsed = formErrors(err)
      setRenameError(parsed.fields.name ?? parsed.message)
      setFormError(parsed.message)
    }
  }

  const removeReport = async (id: string) => {
    setFormError(null)
    setDeletingId(id)
    try {
      await deleteReportMutation.mutateAsync(id)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      setDeletingId(null)
    }
  }

  const downloadReport = async (report: SavedReport) => {
    setFormError(null)
    setBusyId(report.id)
    try {
      await downloadReportMutation.mutateAsync(report)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusyId(null)
    }
  }


  const archiveReport = async (report: SavedReport) => {
    setFormError(null)
    setArchivingId(report.id)
    try {
      await archiveReportMutation.mutateAsync({
        id: report.id,
        archived: report.archived_at === null,
      })
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      setArchivingId(null)
    }
  }

  const downloadCsv = async (check: CheckSummary) => {
    setFormError(null)
    setBusyId(check.id)
    try {
      await downloadCsvMutation.mutateAsync(check)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusyId(null)
    }
  }

  const restoreCheck = async (id: string) => {
    setFormError(null); setRestoringCheck(id)
    try { await restoreCheckMutation.mutateAsync(id); setCheckNotice({ title: 'Check unarchived' }) }
    catch (err) { setFormError(err instanceof Error ? err.message : String(err)); setCheckNotice({ title: err instanceof Error ? err.message : String(err), danger: true }) }
    finally { setRestoringCheck(null) }
  }

  const archiveCheck = async () => {
    if (!archiveCheckTarget || archiveCheckMutation.isPending) return
    try {
      await archiveCheckMutation.mutateAsync({ id: archiveCheckTarget.id, archived_at: new Date().toISOString() })
      setArchiveCheckTarget(null)
      setCheckNotice({ title: 'Check archived. Its findings are preserved.' })
    } catch (err) { setArchiveCheckTarget(null); setCheckNotice({ title: err instanceof Error ? err.message : String(err), danger: true }) }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" description="History of checks and saved reports" />
        <ErrorState
          error={error}
          title="Could not load reports"
          onRetry={() => {
            void checksQuery.refetch()
            void reportsQuery.refetch()
          }}
          isRetrying={isFetching}
        />
        <CheckHistoryMore query={checksQuery} />
      </div>
    )
  }

  if (checksQuery.isPending || reportsQuery.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" description="History of checks and saved reports" />
        <ListSkeleton label="Loading reports" />
      </div>
    )
  }

  const totalFindings = completed.reduce((s, c) => s + c.findings_count, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="History of checks and saved reports"
        actions={
          <>
            <RefreshingIndicator show={isFetching} />
            <Button onClick={() => setAdding(true)} disabled={creating}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New report
            </Button>
          </>
        }
      />
        <CheckHistoryMore query={checksQuery} />

      {/* A failed delete used to be written into `formError`, which is only
          rendered inside the create form - so deleting a report and having it
          fail showed nothing at all. The error now lives above the cards, where
          every operation on this page can be seen failing. */}
      {formError ? (
        <p role="alert" className="text-body text-danger">
          {formError}
        </p>
      ) : null}

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>New report</CardTitle>
            <CardDescription>
              Name it, then choose the checks it should contain
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* A raw `<input>` with a placeholder and no label was the old
                shape: the placeholder disappears the moment the user types, so
                the control was unnamed to a screen reader and to a screenshot. */}
            <Field
              id="report-name"
              label="Report name"
              hint="Something you will recognise in a list, e.g. “September overrun review”"
              error={formError ?? undefined}
              required
              className="max-w-sm"
            >
              {(control) => (
                <Input
                  {...control}
                  placeholder="report name..."
                  value={name}
                  disabled={creating}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createReport()
                  }}
                />
              )}
            </Field>

            {/* The selection is the report (Task 3). Before this, saving a
                report stored `{"type": "check"}` and produced a document with
                no checks in it at all. */}
            <fieldset className="space-y-2" disabled={creating}>
              <legend className="text-body font-medium">Checks to include</legend>
              <p className="text-body text-muted-foreground">
                The report carries each selected check&apos;s findings and the
                evidence rows behind them.
              </p>
              {completed.length === 0 ? (
                <p className="text-body text-muted-foreground">
                  No completed checks yet — a report needs at least one.
                </p>
              ) : (
                <ul className="space-y-1">
                  {completed.map((c) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                          checked={selected.includes(c.id)}
                          onChange={(e) => toggleCheck(c.id, e.target.checked)}
                          aria-label={`Include the check of ${formatDateTime(c.created_at)}`}
                        />
                        <span className="text-body">
                          {formatDateTime(c.created_at)}
                          <span className="text-muted-foreground">
                            {' — '}
                            {c.findings_count} available finding{c.findings_count === 1 ? '' : 's'}
                            {!!c.commitment_assessments?.length && ' · commitment measurement limited'}
                            {' · '}
                            {checkWindow(c)}
                          </span>
                        </span>
                      </label>
                      {selected.includes(c.id) && <CommitmentAssessment items={c.commitment_assessments} />}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-body text-muted-foreground">
                {selected.length} of {completed.length} selected
              </p>
              {/* The button below is disabled while this is true, so this is the
                  only place the rule is *told*; the disabled button is the place
                  it is enforced. A disabled button with no explanation is a
                  control that looks broken, so the sentence sits next to the
                  count it is about rather than on the button. */}
              {selected.length === 0 && completed.length > 0 ? (
                <p className="text-body text-muted-foreground" data-testid="report-needs-checks">
                  Select at least one check
                </p>
              ) : null}
            </fieldset>

            <div className="flex gap-2">
              {/* Disabled with nothing selected. The old shape let the click
                  through, POSTed, and came back with a 422 the page rendered as
                  a raw validation array - a round trip to be told what the page
                  already knew. The server check is deliberately still there: it
                  is the backstop for a stale bundle or a hand-written request. */}
              <Button
                onClick={() => void createReport()}
                loading={creating || createReportMutation.isPending}
                disabled={selected.length === 0}
              >
                Save
              </Button>
              <Button
                variant="secondary"
                disabled={creating}
                onClick={() => {
                  setAdding(false)
                  setSelected([])
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Completed checks loaded" value={completed.length} />
        <StatTile label="Findings across checks" value={totalFindings}
          caption={completed.some((c) => c.commitment_assessments?.length) ? 'Available findings; some commitment measurements are withheld' : undefined} />
        <StatTile label="Saved reports" value={saved.length} />
      </div>

      {/* Saved reports */}
      <Card>
        <CardHeader>
          <CardTitle>Saved reports</CardTitle>
          <CardDescription>
            Download the document, or archive it
          </CardDescription>
        </CardHeader>
        <CardContent>
          {saved.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No saved reports yet"
              description="A report is a named set of checks you can download as a document for local use. Nothing is created automatically — save one when you want a particular review to be easy to come back to."
              action={
                <Button onClick={() => setAdding(true)} disabled={creating}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New report
                </Button>
              }
            />
          ) : (
            <Table density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead numeric>Checks</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {saved.map((r) => {
                  const ids = selectedCheckIds(r)
                  return (
                    <Fragment key={r.id}>
                      <TableRow>
                        {/* The icon and the name live in one cell, but the cell
                            is not `display:flex` - that takes it out of the
                            table layout algorithm and the row stops lining up
                            with the ones above and below. An inline-flex wrapper
                            is the same visual result without breaking the table. */}
                        <TableCell className="font-medium">
                          <div className="inline-flex items-center gap-2">
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            {renaming === r.id ? <form onSubmit={e => { e.preventDefault(); void renameReport() }} className="space-y-2">
                              <Field id={`rename-report-${r.id}`} label="Report name" required error={renameError}>
                                {control => <Input {...control} required value={renameName} onChange={e => setRenameName(e.target.value)} disabled={renameReportMutation.isPending} />}
                              </Field>
                              <Button size="sm" type="submit" loading={renameReportMutation.isPending}>Save name</Button>
                              <Button size="sm" variant="ghost" disabled={renameReportMutation.isPending} onClick={() => setRenaming(null)}>Cancel rename</Button>
                            </form> : r.name}
                          </div>
                        </TableCell>
                        <TableCell numeric>
                          {ids.length > 0 ? (
                            ids.length
                          ) : (
                            // Named, not blanked: a report created before Task 3
                            // has no selection and would otherwise download as an
                            // empty document with nothing on screen to say why.
                            <span className="text-muted-foreground">none</span>
                          )}
                        </TableCell>
                        <TableCell>{formatDateTime(r.created_at)}</TableCell>
                        <TableCell>
                          {r.archived_at ? (
                            <Badge variant="neutral">archived</Badge>
                          ) : (
                            <Badge variant="info">active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <Button variant="ghost" size="sm" disabled={renameReportMutation.isPending} onClick={() => { setRenaming(r.id); setRenameName(r.name); setRenameError(undefined); setFormError(null) }} aria-label={`Rename report ${r.name}`}>Rename</Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void downloadReport(r)}
                              loading={busyId === r.id}
                              aria-label={`Download the report “${r.name}” as a printable report`}
                            >
                              <Download className="h-4 w-4" aria-hidden="true" />
                              Download report
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void archiveReport(r)}
                              loading={archivingId === r.id}
                              aria-label={
                                r.archived_at
                                  ? `Restore the report “${r.name}”`
                                  : `Archive the report “${r.name}”`
                              }
                            >
                              {r.archived_at ? (
                                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <Archive className="h-4 w-4" aria-hidden="true" />
                              )}
                              {r.archived_at ? 'Restore' : 'Archive'}
                            </Button>
                            {/* `aria-label`: the button is an icon, and without a
                                name the accessibility tree contains a control
                                whose only content is a drawing. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void removeReport(r.id)}
                              loading={deletingId === r.id}
                              aria-label={`Delete the saved report “${r.name}”`}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Check history — real completed checks, exportable as CSV */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Check history <EvidenceLock />
          </CardTitle>
          <CardDescription>
            Every analysis, including checks in progress and failed attempts. Reopen a check to view its status and coverage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {checks.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No checks yet"
              description="Check history is the audit trail: one row per finished analysis, with the findings it produced and a CSV of the evidence behind them. It fills up as you run checks."
              action={<LinkButton to="/check">Run your first check</LinkButton>}
            />
          ) : (
            <Table density="compact">
              <TableCaption className="px-4 pb-2">
                Findings become available when a check completes. Running checks can be reopened safely.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead numeric>Findings</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id}>
                    {/* Every row used to link to `/findings` with no
                        distinction, so a table of twenty checks offered twenty
                        identical links and the row told you nothing about which
                        check it was. It goes to that check's findings. */}
                    <TableCell>
                      <LinkButton
                        to={`/check?check=${c.id}`}
                        variant="link"
                        size="sm"
                        className="h-auto px-0"
                      >
                        {formatDateTime(c.created_at)}
                      </LinkButton>
                    </TableCell>
                    <TableCell>
                      {c.window_start && c.window_end ? `${c.window_start} → ${c.window_end}` : '—'}
                    </TableCell>
                    <TableCell numeric>{c.findings_count}
                      {!!c.commitment_assessments?.length && <details className="mt-1 text-left text-caption">
                        <summary>Commitment measurement limited</summary>
                        <CommitmentAssessment items={c.commitment_assessments} />
                      </details>}
                    </TableCell>
                    <TableCell>
                      {c.archived_at ? (
                        <Badge variant="neutral">archived</Badge>
                      ) : (
                        <Badge variant="info">{c.status}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.archived_at ? <Button variant="secondary" size="sm" loading={restoringCheck === c.id}
                        onClick={() => void restoreCheck(c.id)} aria-label={`Unarchive check ${c.id}`}>
                        <ArchiveRestore className="h-4 w-4" aria-hidden="true" /> Unarchive
                      </Button> : <Button variant="ghost" size="sm" onClick={() => setArchiveCheckTarget(c)} aria-label={`Archive check ${c.id}`}>
                        <Archive className="h-4 w-4" aria-hidden="true" /> Archive
                      </Button>}
                      {c.status === 'completed' && (
                        /* A button, not the `<a href>` this used to be. That
                           anchor could not carry the session token (it lives in
                           sessionStorage), so it answered 401 to every signed-in
                           user - a broken export nobody noticed because the
                           failure was a small JSON body in a new tab. */
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void downloadCsv(c)}
                          loading={busyId === c.id}
                          aria-label={`Download the findings for the check of ${formatDateTime(c.created_at)} as CSV`}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          CSV
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Task 7: Share opens a dialog, not a request - the expiry is a choice
          made at share time. The dialog carries the report's name so the
          choice is made against the thing being shared. */}
      {checkNotice && <Toast title={checkNotice.title} variant={checkNotice.danger ? 'danger' : 'success'} onDismiss={() => setCheckNotice(null)} />}
      <Dialog open={!!archiveCheckTarget} onOpenChange={open => { if (!archiveCheckMutation.isPending && !open) setArchiveCheckTarget(null) }} title="Archive this check?"
        description="This hides the whole check and its findings from default views. Nothing is deleted; use Unarchive to restore it.">
        <Button variant="danger" loading={archiveCheckMutation.isPending} onClick={() => void archiveCheck()}>Confirm archive</Button>
      </Dialog>

    </div>
  )
}