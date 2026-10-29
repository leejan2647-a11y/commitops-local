import { useEffect, useState } from 'react'
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorState, PageHeader } from '@/components/page-states'
import { PageSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import {
  useCreateTeam,
  useDeleteTeam,
  useSettings,
  useTeams,
  useUpdateSettings,
  useUpdateTeam,
} from '@/lib/queries'

/** Exactly 12 digits - the same rule the backend CHECKs, stated here so the
 *  form can say what a valid AWS account id looks like before the round trip. */
const ACCOUNT_ID_RE = /^\d{12}$/
const POSITIVE_DECIMAL_RE = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

export function Settings() {
  // Cached (Task F.1b-fix). Three independent endpoints, one round trip.
  const tenantQuery = useSettings()
  const teamsQuery = useTeams()
  const updateSettings = useUpdateSettings()
  const createTeam = useCreateTeam()
  const updateTeam = useUpdateTeam()
  const deleteTeam = useDeleteTeam()

  const [savedFlash, setSavedFlash] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [newTeam, setNewTeam] = useState({ name: '', aws_account_id: '' })
  /** The row being edited, and its working copy. `null` = no row is being
   *  edited; an empty-string name means "the user cleared it", which is a
   *  save-time error, not a "nothing is being edited" sentinel. */
  const [editing, setEditing] = useState<{ id: string; name: string; aws_account_id: string } | null>(null)

  const tenant = tenantQuery.data ?? null

  // Same draft pattern as the finding detail form: read from the server until
  // the user changes something. With staleTime and refetchOnWindowFocus, the
  // tenant query re-delivers itself on focus, and copying that into state with
  // an effect would either clobber an in-progress edit or need a `seeded` guard
  // to avoid doing exactly that. Deriving instead removes the hazard: an
  // untouched field follows the server, an edited field does not.
  const serverSettings = (tenant?.settings ?? {}) as Record<string, string>
  const savedCreepSensitivity = Object.prototype.hasOwnProperty.call(serverSettings, 'creepMonthlyGrowthPercent')
    ? String(serverSettings.creepMonthlyGrowthPercent)
    : '10'
  const [draft, setDraft] = useState<{
    name: string
    defaultDateRange: string
    creepMonthlyGrowthPercent: string
  } | null>(null)
  const companyName = draft?.name ?? tenant?.name ?? ''
  const defaultDateRange = draft?.defaultDateRange ?? serverSettings.defaultDateRange ?? '30'
  const creepMonthlyGrowthPercent = draft?.creepMonthlyGrowthPercent ?? savedCreepSensitivity
  const setCompanyName = (v: string) =>
    setDraft({ name: v, defaultDateRange, creepMonthlyGrowthPercent })
  const setDefaultDateRange = (v: string) =>
    setDraft({ name: companyName, defaultDateRange: v, creepMonthlyGrowthPercent })
  const setCreepMonthlyGrowthPercent = (v: string) =>
    setDraft({ name: companyName, defaultDateRange, creepMonthlyGrowthPercent: v })

  const teams = teamsQuery.data ?? []
  const error = tenantQuery.error
  const isFetching =
    tenantQuery.isFetching || teamsQuery.isFetching

  // The old code called `setTimeout(() => setSavedFlash(false), 2000)` inline
  // and never cleared it. Navigating away inside those two seconds left a
  // timer that fired `setState` on an unmounted component, and every subsequent
  // save stacked another one. An effect owns the timer and cancels it.
  useEffect(() => {
    if (!savedFlash) return
    const timer = setTimeout(() => setSavedFlash(false), 2500)
    return () => clearTimeout(timer)
  }, [savedFlash])

  // Unsaved = the draft exists and differs from what the server holds. Drives
  // the Discard button and stops the page claiming to be saved while it is not.
  const dirty =
    draft !== null &&
    (draft.name !== (tenant?.name ?? '') ||
      draft.defaultDateRange !== (serverSettings.defaultDateRange ?? '30') ||
      draft.creepMonthlyGrowthPercent !== savedCreepSensitivity)

  const saveTenant = async () => {
    setFormError(null)
    const sensitivity = creepMonthlyGrowthPercent.trim()
    const coefficient = sensitivity.split(/[eE]/)[0]
    if (!POSITIVE_DECIMAL_RE.test(sensitivity) || !/[1-9]/.test(coefficient)) {
      setFormError('Creep monthly growth percentage must be a positive finite number.')
      return
    }
    try {
      await updateSettings.mutateAsync({
        name: companyName,
        settings: {
          defaultDateRange,
          creepMonthlyGrowthPercent,
        },
      })
      // Drop the draft so the form follows the server again. Without this the
      // inputs would keep rendering the draft copy forever, and a later
      // refetch-driven value (someone else changed the tenant) would never show.
      setDraft(null)
      setSavedFlash(true)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    }
  }

  const addTeam = async () => {
    setFormError(null)
    // Named-field checks, not a generic "something is missing": the account id
    // rule (exactly 12 digits) is checked here so the user gets the shape
    // before paying a round trip for the same answer.
    const name = newTeam.name.trim()
    const accountId = newTeam.aws_account_id.trim()
    if (!name) {
      setFormError('A team needs a name.')
      return
    }
    if (!ACCOUNT_ID_RE.test(accountId)) {
      setFormError('The AWS account id must be exactly 12 digits, e.g. 111111111111.')
      return
    }
    try {
      await createTeam.mutateAsync({ name, aws_account_id: accountId })
      setNewTeam({ name: '', aws_account_id: '' })
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    }
  }

  const saveTeam = async () => {
    if (!editing) return
    setFormError(null)
    const name = editing.name.trim()
    const accountId = editing.aws_account_id.trim()
    if (!name) {
      setFormError('A team needs a name.')
      return
    }
    if (!ACCOUNT_ID_RE.test(accountId)) {
      setFormError('The AWS account id must be exactly 12 digits, e.g. 111111111111.')
      return
    }
    try {
      await updateTeam.mutateAsync({ id: editing.id, name, aws_account_id: accountId })
      setEditing(null)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    }
  }

  const removeTeam = async (team: { id: string; name: string; aws_account_id: string }) => {
    setFormError(null)
    // Confirm before the hard delete - a team is configuration, but a
    // mis-click should not spend the user the re-typing. `window.confirm`
    // is unreachable under `renderToStaticMarkup` (no DOM), which is fine:
    // the action only exists behind a click.
    if (typeof window !== 'undefined' && !window.confirm(`Delete the team "${team.name}" (${team.aws_account_id})?`)) {
      return
    }
    setDeletingId(team.id)
    try {
      await deleteTeam.mutateAsync(team.id)
    } catch (err) {
      setFormError(String(err instanceof Error ? err.message : err))
    } finally {
      setDeletingId(null)
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Settings"
          description="Configure your account, teams, and check defaults"
        />
        
        <ErrorState
          error={error}
          title="Could not load settings"
          onRetry={() => {
            void tenantQuery.refetch()
            void teamsQuery.refetch()
          }}
          isRetrying={isFetching}
        />
      </div>
    )
  }

  if (!tenant || tenantQuery.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Settings"
          description="Configure your account, teams, and check defaults"
        />
        
        <PageSkeleton label="Loading settings" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configure your account, teams, and check defaults"
        actions={<RefreshingIndicator show={isFetching} />}
      />
      

      {formError ? (
        <p role="alert" className="text-body text-danger">
          {formError}
        </p>
      ) : null}

      {/* Account */}
      <Card>
        <CardHeader>
          <CardTitle>Account information</CardTitle>
          <CardDescription>
            Your company name
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Five `<label className="text-sm font-medium">` above five controls
              with no ids: clicking a label focused nothing and a screen reader
              announced every field as an unnamed text box. */}
          <Field id="settings-company" label="Company name">
            {(control) => (
              <Input
                {...control}
                value={companyName}
                disabled={updateSettings.isPending}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            )}
          </Field>
        </CardContent>
      </Card>

      {/* Check Defaults — limits stored as strings, Decimal on read */}
      <Card>
        <CardHeader>
          <CardTitle>Check defaults</CardTitle>
          <CardDescription>Default values for new checks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="settings-range" label="Default date lookback"
              hint="Preset windows include both the start date and the end date.">
              {(control) => (
                <Select
                  {...control}
                  value={defaultDateRange}
                  disabled={updateSettings.isPending}
                  onChange={(e) => setDefaultDateRange(e.target.value)}
                >
                  <option value="7">7-day lookback (8 inclusive calendar days)</option>
                  <option value="30">30-day lookback (31 inclusive calendar days)</option>
                  <option value="60">60-day lookback (61 inclusive calendar days)</option>
                  <option value="90">90-day lookback (91 inclusive calendar days)</option>
                </Select>
              )}
            </Field>
            <Field id="settings-creep" label="Creep monthly growth threshold (%)">
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  step="any"
                  value={creepMonthlyGrowthPercent}
                  disabled={updateSettings.isPending}
                  onChange={(e) => setCreepMonthlyGrowthPercent(e.target.value)}
                  aria-describedby="settings-creep-help"
                />
              )}
            </Field>
          </div>
          <p id="settings-creep-help" className="text-sm text-muted-foreground">
            Default 10%. Lower values catch smaller growth but may flag normal variation;
            higher values reduce alerts but may miss gradual growth. Applies to future checks.
            The 56-day detector uses a linear 30-day normalization: 10% monthly means
            about 18.7% over 56 days. For scale, sustained monthly growth compounded for
            a year is approximately 43% at 3%, 214% at 10%, and 435% at 15%.
          </p>

          {/* One Save for the two cards above it.
              The button used to live inside "Check Defaults" and save the
              company name and notification email too, so a user who edited
              their company name in the first card had to scroll to a card
              titled something else to find the button that committed it. It is
              here now: after both sections, saying what it covers. */}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button
              onClick={() => void saveTenant()}
              loading={updateSettings.isPending}
              loadingLabel="Saving"
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              Save account and defaults
            </Button>
            {dirty && !updateSettings.isPending ? (
              <>
                <span className="text-caption text-warning">Unsaved changes</span>
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              </>
            ) : null}
            {/* `role="status"` so the confirmation is announced. A button that
                silently changes its own label to "Saved!" is invisible to a
                screen reader user. */}
            <span role="status" className="text-caption text-success">
              {savedFlash ? 'Saved.' : ''}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Teams (Feature 1.7): an AWS account id attributed to a named team.
          Replaces the tag-based "Team mappings" section - findings carry the
          account id in their coarse key, so the account id is the one key both
          sides of the attribution actually have. */}
      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>
            AWS accounts attributed to teams — findings show the team name
            instead of the raw 12-digit account id
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {teamsQuery.error ? (
            <ErrorState
              error={teamsQuery.error}
              title="Could not load teams"
              onRetry={() => void teamsQuery.refetch()}
              isRetrying={teamsQuery.isFetching}
            />
          ) : teamsQuery.isPending ? (
            <PageSkeleton label="Loading teams" />
          ) : (
            <>
          {teams.length > 0 ? (
            <Table density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>AWS account ID</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.map((team) => (
                  <TableRow key={team.id}>
                    {editing?.id === team.id ? (
                      <>
                        {/* The row becomes its own edit form: the two fields a
                            PATCH may change, nothing else (the backend refuses
                            unknown fields with the standard 403, and this form
                            never sends any). */}
                        <TableCell>
                          <Input
                            aria-label={`Team name for ${team.aws_account_id}`}
                            value={editing.name}
                            disabled={updateTeam.isPending}
                            onChange={(e) =>
                              setEditing({ ...editing, name: e.target.value })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={`AWS account id for ${team.name}`}
                            className="font-mono"
                            value={editing.aws_account_id}
                            disabled={updateTeam.isPending}
                            onChange={(e) =>
                              setEditing({ ...editing, aws_account_id: e.target.value })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void saveTeam()}
                            loading={updateTeam.isPending}
                            aria-label={`Save changes to ${team.name}`}
                          >
                            <Save className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(null)}
                            disabled={updateTeam.isPending}
                            aria-label={`Discard changes to ${team.name}`}
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell>{team.name}</TableCell>
                        <TableCell className="font-mono">{team.aws_account_id}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setEditing({
                                id: team.id,
                                name: team.name,
                                aws_account_id: team.aws_account_id,
                              })
                            }
                            aria-label={`Edit the team ${team.name} (${team.aws_account_id})`}
                            disabled={updateTeam.isPending}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeTeam(team)}
                            loading={deletingId === team.id}
                            aria-label={`Delete the team ${team.name} (${team.aws_account_id})`}
                            disabled={updateTeam.isPending}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-body text-muted-foreground">
              No teams yet — register an AWS account id to see its name on
              findings instead of the raw number.
            </p>
          )}

          {/* Add Team: an inline form, labels over placeholders for the same
              reason as every other form here (a placeholder vanishes on the
              first keystroke and is not a control's name). */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
            <Field id="new-team-name" label="Team name">
              {(control) => (
                <Input
                  {...control}
                  placeholder="Platform"
                  value={newTeam.name}
                  disabled={createTeam.isPending}
                  onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })}
                />
              )}
            </Field>
            <Field
              id="new-team-account"
              label="AWS account ID"
              hint="12 digits, e.g. 111111111111"
            >
              {(control) => (
                <Input
                  {...control}
                  placeholder="111111111111"
                  className="font-mono"
                  inputMode="numeric"
                  value={newTeam.aws_account_id}
                  disabled={createTeam.isPending}
                  onChange={(e) =>
                    setNewTeam({ ...newTeam, aws_account_id: e.target.value })
                  }
                />
              )}
            </Field>
            <Button
              variant="outline"
              onClick={() => void addTeam()}
              loading={createTeam.isPending}
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add team
            </Button>
          </div>
            </>
          )}
        </CardContent>
      </Card>



      <p>Settings and team mappings stay on this device. Reports are downloaded locally.</p>
    </div>
  )
}
