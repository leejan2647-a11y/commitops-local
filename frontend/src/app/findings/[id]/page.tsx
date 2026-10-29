import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Inbox } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { LinkButton } from '@/components/ui/link-button'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/input'
import { EmptyState, ErrorState, PageHeader, StatTile } from '@/components/page-states'
import { PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { EvidenceLock } from '@/components/evidence-lock'
import { EvidenceMeasurementNote } from '@/components/evidence-measurement'
import { FindingAmountNote } from '@/components/finding-amount-measurement'
import { ResourceAttribution } from '@/components/resource-attribution'
import { evidenceAmount, findingAmount, hasVerifiedUsd, impactLabel, investigationHint, usesCommitmentMeasurement } from '@/lib/finding-amount'
import { commitmentUnavailable } from '@/lib/commitment-unavailable'
import { CommitmentAssessment } from '@/components/commitment-assessment'
import {
  useAddFindingLabel,
  useFinding,
  useRemoveFindingLabel,
  useUpdateFindingState,
} from '@/lib/queries'
import { FINDING_STATUSES, humanise } from '@/app/findings/detector-types'
import { checkRoute } from '@/app/findings/routes'
import { formatDateTime } from '@/lib/utils'

type StatusOption = (typeof FINDING_STATUSES)[number]

export function FindingDetail() {
  const { id } = useParams<{ id: string }>()

  // Cached (Task F.1b-fix). This is the page that most needed it: clicking
  // through the findings list and back to a previous finding used to re-fetch
  // both the list and the detail. `reloadKey` is gone - the mutations invalidate
  // the query themselves, which is what made the old manual counter necessary.
  const { data: finding, error, isFetching, refetch, isRefetching } = useFinding(id)
  const updateState = useUpdateFindingState(id ?? '')
  const addLabelMutation = useAddFindingLabel(id ?? '')
  const removeLabelMutation = useRemoveFindingLabel(id ?? '')

  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [actionError, setActionError] = useState<unknown>(null)

  // The form is a *draft*: it reads from the server until the user changes
  // something, and from local state only after that. Deriving the displayed
  // value beats copying the server value into state with an effect, because
  // there is no copy to go stale - a background refetch (staleTime expiry, tab
  // regaining focus) updates the server value and an untouched field follows it,
  // while a field the user has edited is left alone. An effect-based copy would
  // either reset an in-progress edit or need a `seeded` guard to avoid it.
  const [draft, setDraft] = useState<{ status: StatusOption; note: string } | null>(null)
  const serverStatus = (finding?.state?.status ?? 'open') as StatusOption
  const serverNote = finding?.state?.note ?? ''
  const status = draft?.status ?? serverStatus
  const note = draft?.note ?? serverNote
  const setStatus = (v: StatusOption) => setDraft({ status: v, note })
  const setNote = (v: string) => setDraft({ status, note: v })

  const dirty = draft !== null && (draft.status !== serverStatus || draft.note !== serverNote)

  const saveState = async () => {
    if (!id) return
    setSaving(true)
    setActionError(null)
    try {
      const updated = await updateState.mutateAsync({ status, note })
      setSavedAt(updated.updated_at)
      // The draft is dropped, not kept: the server value is now the truth, and
      // keeping the draft would leave the form "dirty" against its own save.
      setDraft(null)
    } catch (err) {
      setActionError(err)
    } finally {
      setSaving(false)
    }
  }

  const addLabel = async () => {
    if (!id || !newLabel.trim()) return
    setActionError(null)
    try {
      await addLabelMutation.mutateAsync(newLabel.trim())
      setNewLabel('')
    } catch (err) {
      setActionError(err)
    }
  }

  const removeLabel = async (labelId: string) => {
    if (!id) return
    setActionError(null)
    try {
      await removeLabelMutation.mutateAsync(labelId)
    } catch (err) {
      setActionError(err)
    }
  }

  const backLink = (
    <Link
      to={finding?.check_id ? `/findings?check=${finding.check_id}` : "/findings"}
      className="inline-flex items-center gap-2 text-body text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Findings
    </Link>
  )

  if (error) {
    const unavailable = commitmentUnavailable(error)
    if (unavailable) return <div className="space-y-6">{backLink}
      <PageHeader title="Commitment finding unavailable" />
      <CommitmentAssessment items={[unavailable]} />
    </div>
    return (
      <div className="space-y-6">
        {backLink}
        <PageHeader title="Finding" />
        <ErrorState
          error={error}
          title="Could not load this finding"
          onRetry={() => void refetch()}
          isRetrying={isRefetching}
        />
      </div>
    )
  }

  if (!finding) {
    return (
      <div className="space-y-6">
        {backLink}
        <PageHeader title="Finding" />
        <PageSkeleton label="Loading finding" />
      </div>
    )
  }

  const evidenceTotal = finding.evidence.every(row => row.amount_cents !== null)
    ? finding.evidence.reduce((sum, row) => sum + row.amount_cents!, 0) : null
  const verifiedUsd = hasVerifiedUsd(finding)

  return (
    <div className="space-y-6">
      {backLink}
      <PageHeader
        title={finding.title}
        description={finding.description}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <RefreshingIndicator show={isFetching} />
            {/* The check this finding came from, linked (live-testing Task 1):
                a finding is evidence *from a run*, and the run is where its
                siblings live. Same LinkButton the list rows use, so the two
                views navigate identically. */}
            {finding.check_id ? (
              <LinkButton
                to={checkRoute(finding.check_id)}
                variant="link"
                size="sm"
                className="shrink-0"
              >
                Check of{' '}
                {finding.check_created_at
                  ? formatDateTime(finding.check_created_at)
                  : finding.check_id.slice(0, 8)}
              </LinkButton>
            ) : null}
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
            {/* Feature 1.5: the team this account is attributed to, with the
                account id beside it. Both available = both shown, per the
                spec; the account id is the join key the reader may need to
                look up in their own AWS console. */}
            {finding.team_name && finding.aws_account_id ? (
              <Badge variant="neutral">
                {finding.team_name} · {finding.aws_account_id}
              </Badge>
            ) : null}
          </div>
        }
      />

      {/* Mutation failures surface here rather than replacing the page: the
          finding is still real data, and blanking the whole view because a label
          could not be saved would lose the user's context. */}
      {actionError ? (
        <p role="alert" className="text-body text-danger">
          {actionError instanceof Error ? actionError.message : String(actionError)}
        </p>
      ) : null}

      {finding.current_owners !== undefined && <div className="rounded-lg border border-border p-4 text-body"><h3 className="font-medium">Current owners</h3><p className="text-caption text-muted-foreground">Current routing metadata; saved financial evidence is unchanged.</p>{finding.current_owners.length ? finding.current_owners.map(owner => <p key={owner.mapping_id} className="break-all">{owner.email} <span className="text-caption text-muted-foreground">({owner.match_key})</span></p>) : <p>No matching owner mapping.</p>}</div>}

      {/* Key metrics - all AWS evidence, all locked. `evidence` is a prop so a
          tile cannot quietly lose its lock, which is the failure mode of adding
          them by hand. */}
      {finding.check_window_start && finding.check_window_end ? <p className="text-body text-muted-foreground">Check window: {finding.check_window_start} → {finding.check_window_end}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile label={impactLabel(finding)} value={findingAmount(finding)} evidence />
        <StatTile label="Calculated contribution" value={usesCommitmentMeasurement(finding) ? 'Not applicable' : evidenceAmount(finding, finding.evidence_total_cents)} caption={usesCommitmentMeasurement(finding) ? 'The unused amount is measured from commitment records, not allocated usage-row contributions.' : 'Across all matching rows for this evidence scope; the table shows the largest contributors'} evidence />
      </div>
      <FindingAmountNote measurement={finding.amount_measurement} />
      <p className="text-body text-muted-foreground">Findings can overlap and use different periods. Their amounts are not added together.</p>
      <Card><CardHeader><CardTitle>What to review next</CardTitle></CardHeader>
        <CardContent className="space-y-3"><p className="text-body">{investigationHint(finding.detector_type)}</p>
          {!usesCommitmentMeasurement(finding) && <ResourceAttribution attribution={finding.attribution} verifiedUsd={verifiedUsd} />}
        </CardContent>
      </Card>

      {/* Subject / grouping (evidence) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Subject <EvidenceLock />
          </CardTitle>
          <CardDescription>The billing grouping this finding was measured at</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="break-all font-mono text-body">{finding.subject || '—'}</p>
          {finding.coarse_key.length > 0 ? (
            <p className="mt-1 text-caption text-muted-foreground">
              {finding.coarse_key.filter(Boolean).join(' · ')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <EvidenceMeasurementNote measurement={verifiedUsd ? finding.evidence_measurement : null} commitment={usesCommitmentMeasurement(finding)} />

      {/* Evidence line items - locked */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Evidence line items <EvidenceLock />
          </CardTitle>
          <CardDescription>
            {usesCommitmentMeasurement(finding) ? 'Usage-row contributions do not apply to this commitment fee measurement.' : <>
            Billing row references with their calculated contributions (calculation total:{' '}
            {evidenceAmount(finding, finding.evidence_total_cents)}
            {verifiedUsd && evidenceTotal !== null && evidenceTotal !== finding.evidence_total_cents &&
              ` · showing top ${finding.evidence.length} rows: ${evidenceAmount(finding, evidenceTotal)}`}
            )</>}
          </CardDescription>
        </CardHeader>
        <CardContent className={finding.evidence.length === 0 ? 'pt-0' : 'p-0'}>
          {finding.evidence.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No usage line items"
              description={usesCommitmentMeasurement(finding) ? "This finding uses commitment measurements. Review purchased, used and unused amounts on Commitments, and beneficiary accounts on Allocation." : finding.evidence_measurement ? "No rows received a positive whole-cent contribution for this calculation. Source-row counts and any remainder are shown above." : "This finding was not measured against a grouping, so no billing rows were selected for it. The caveats below may say why."}
            />
          ) : (
            <Table density="compact" maxHeight="24rem">
              <TableCaption className="px-4 pb-2">
                CUR cost is the source cost rounded to cents. Contribution is calculated after the daily baseline and credits; it is not the original charge. Older checks may not have recorded source costs or dates.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Line item</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead numeric>CUR cost</TableHead>
                  <TableHead numeric>Calculated contribution</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {finding.evidence.map((row) => (
                  <TableRow key={row.id}>
                    {/* `break-all`, not `truncate`. A row reference is one long
                        opaque token, and truncating it hides the only part that
                        identifies *which* row the money came from - the very
                        thing an audit view exists to show. */}
                    <TableCell className="break-all font-mono">
                      {row.row_reference}
                    </TableCell>
                    <TableCell>{row.usage_date ?? 'Not recorded'}</TableCell>
                    <TableCell numeric>{!verifiedUsd ? 'Currency unverified' : row.raw_cost_cents == null ? 'Not recorded' : evidenceAmount(finding, row.raw_cost_cents)}</TableCell>
                    <TableCell numeric className="font-mono">
                      {evidenceAmount(finding, row.amount_cents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Caveats. `warning`, not `orange-500`: the token system exists so that a
          status has one colour everywhere, and a raw palette class renders fine
          while being outside it. */}
      {finding.caveats.length > 0 ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
              Caveats
            </CardTitle>
            <CardDescription>Non-fatal problems the detector reported</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-body text-muted-foreground">
              {finding.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Labels - user configuration, the opposite of evidence */}
      <Card>
        <CardHeader>
          <CardTitle>Labels</CardTitle>
          <CardDescription>Your own grouping tags — editable, unlike the AWS evidence above</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {finding.labels.map((lbl) => (
              <Badge key={lbl.id} variant="neutral" className="pl-2 pr-1">
                {lbl.label}
                <button
                  type="button"
                  className="-mr-1 ml-1 grid h-6 w-6 place-items-center rounded-sm text-subtle hover:text-danger"
                  onClick={() => removeLabel(lbl.id)}
                  aria-label={`Remove label ${lbl.label}`}
                >
                  <span aria-hidden="true" className="text-body leading-none">
                    ×
                  </span>
                </button>
              </Badge>
            ))}
          </div>

          <Field
            id="finding-new-label"
            label="Add a label"
            hint="Enter or the Add button both save it"
            className="max-w-sm"
          >
            {(control) => (
              <div className="flex gap-2">
                <Input
                  {...control}
                  placeholder="e.g. held-for-audit"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void addLabel()
                    }
                  }}
                />
                <Button size="md" variant="secondary" className="shrink-0" onClick={() => void addLabel()}>
                  Add
                </Button>
              </div>
            )}
          </Field>
        </CardContent>
      </Card>

      {/* State + note - the editable side. `Field` on both, because the status
          Select previously had no label at all: a screen reader announced it as
          an unnamed combobox, and there was nothing to click to focus it. */}
      <Card>
        <CardHeader>
          <CardTitle>Status & note</CardTitle>
          <CardDescription>
            Your workflow state — the AWS evidence above is never modified
            {savedAt ? ` · saved at ${formatDateTime(savedAt)}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start">
            <Field id="finding-status" label="Status">
              {(control) => (
                <Select
                  {...control}
                  value={status}
                  disabled={saving}
                  onChange={(e) => setStatus(e.target.value as StatusOption)}
                >
                  {FINDING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {humanise(s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field id="finding-note" label="Note">
              {(control) => (
                <Textarea
                  {...control}
                  rows={4}
                  placeholder="Why this was flagged, what you found, why it's held..."
                  value={note}
                  disabled={saving}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* `loading`, not a hand-rolled spinner: the prop also sets
                `disabled` and `aria-busy`, which a spinner alone does not. A
                second click during the first save would post the same state
                twice. */}
            <Button onClick={() => void saveState()} loading={saving} loadingLabel="Saving">
              Save state
            </Button>
            {dirty && !saving ? (
              <span className="text-caption text-muted-foreground">Unsaved changes</span>
            ) : null}
            {draft !== null && !dirty ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(null)
                }}
              >
                Discard
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
