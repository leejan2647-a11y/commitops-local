/** Wire shapes from the backend (integer-cents money, snake_case). */

export type HistoryGroup = 'teams' | 'accounts' | 'services' | 'resources' | 'principals'
export type HistorySort = 'amount_desc' | 'amount_asc' | 'name'
export interface HistoryReportInput { check_ids?: string[]; start?: string; end?: string }
export interface HistoryCoverage {
  observed_start: string | null
  observed_end: string | null
  observed_dates: string[]
  check_count: number
}
export interface HistoryReport {
  id: string
  status: 'queued' | 'running' | 'ready' | 'partial' | 'unavailable' | 'failed' | 'stale'
  created_at: string
  updated_at: string
  check_ids: string[]
  requested_check_ids?: string[] | null
  conflicting_check_ids?: string[]
  start: string | null
  end: string | null
  coverage: HistoryCoverage
  excluded_checks: { check_id: string; reason: string }[]
  reasons: string[]
  total_cents: number | null
  currency: 'USD' | null
  basis: 'unblended'
  root_scope_id: string | null
  recovery: string | null
}
export interface HistoryRow {
  scope_id: string
  label: string
  amount_cents: number | null
  percent: number | null
  account_ids: string[]
  names: string[]
  finding_ids: string[]
  resource_id?: string | null
  account_id?: string | null
  region?: string | null
  service?: string | null
  aliases?: { name: string; start?: string | null; end?: string | null }[]
  aliases_has_more?: boolean
}
export interface HistoryBreakdown {
  report_id: string
  group_by: HistoryGroup
  scope_id: string
  rows: HistoryRow[]
  total_cents: number | null
  count: number
  offset: number
  limit: number
  has_more: boolean
  coverage: HistoryCoverage
  reasons: string[]
}
export interface HistoryBreakdownInput {
  group_by: HistoryGroup
  scope_id?: string
  offset: number
  limit: number
  search: string
  sort: HistorySort
}

export type CheckStatusValue = 'queued' | 'running' | 'completed' | 'failed' | 'archived' | 'cancelled'

export interface CommitmentAssessment {
  code: string
  message: string
  recovery: string
  check_id?: string
  status?: string
  count?: number
}

export type CommitmentHistoryCoverage = {
  status: 'available'
  observed_intervals: { start: string; end: string }[]
  observed_hours: number
  plan_hours: number
  envelope: { start: string; end: string }
  gaps: { start: string; end: string }[]
} | { status: 'unavailable'; reason: CommitmentAssessment }

export interface CommitmentMeasurement {
  calculation_version: string
  reasons: CommitmentAssessment[]
  plan_id?: string
  metrics?: Record<'purchased' | 'used' | 'unused', {
    state: string; value_cents: number | null; observed_cents: number | null
  }>
  coverage?: { status: string; start: string; end: string; count: number }
  history_coverage?: CommitmentHistoryCoverage
}

export interface CommitmentFamilyTotal {
  purchased: number | null
  used: number | null
  unused: number | null
  utilization_pct: number | null
  status: string
  family: string
  population: string
  basis: string | null
  currency: string | null
  reasons: CommitmentAssessment[]
  metrics?: CommitmentMeasurement['metrics']
  allocation?: { status: string; consumed_by_account: Record<string, number>; reasons?: CommitmentAssessment[] }
  history_coverage?: CommitmentHistoryCoverage
}

export interface FindingState {
  finding_id: string
  status: 'open' | 'investigating' | 'resolved' | 'archived'
  note: string
  updated_at: string
}

export interface Label {
  id: string
  finding_id: string
  label: string
  created_at: string
}

export interface EvidenceRow {
  id: string
  finding_id: string
  row_reference: string
  amount_cents: number | null
  raw_cost_cents?: number | null
  usage_date?: string | null
}

export interface EvidenceMeasurement {
  version: 'exact_cost_v1'
  scope: 'full_window_positive_excess' | 'spike_run_positive_excess'
  period?: { start: string; end: string }
  source_row_count: number
  raw_positive_row_count: number
  zero_cost_row_count: number
  positive_allocated_row_count: number
  displayed_row_count: number
  evidence_total_cents: number
  displayed_contribution_cents: number
  explained_not_displayed_cents: number
  impact_comparison: { version: string; status: 'comparable' | 'unavailable'; proof: string | null; reason: string }
  unexplained_remainder_cents: number | null
}

export interface FindingAmountMeasurement {
  version: 'finding_amount_v1'
  status: 'available' | 'unavailable'
  basis: string | null
  value_cents: number | null
  currency: 'USD' | null
  cost_basis: 'unblended' | 'gross_amortized' | null
  population: 'selected_primary_files' | 'selected_primary_and_reference_files' | null
  period: { start: string; end: string; convention: 'start_inclusive_end_exclusive_utc' } | null
  reference: { type: string; period?: { start: string; end: string }; value_cents?: number; unit?: 'daily_cents' | 'window_cents' } | null
  named_quantities: Record<string, number>
  additivity: 'non_additive'
  reason?: string
  recovery?: string
}

export interface ResourceAttribution {
  contributionBasis: 'resource_mean_comparison'
  measurementPeriod: { start: string; end: string }
  contributors: { resource: string; isNew: boolean; baseline: { totalCents: number; avgDailyCents: number }; window: { totalCents: number; days: number; avgDailyCents: number }; excessCents: number }[]
  contributorCount: number
  spikingDay?: { day: string; dayCents: number }
}

export interface Finding {
  id: string
  detector_type: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  impact_cents: number | null
  impact_basis?: string
  amount_measurement?: FindingAmountMeasurement | null
  attribution?: ResourceAttribution | null
  evidence_total_cents: number | null
  evidence_measurement?: EvidenceMeasurement | null
  coarse_key: string[]
  subject: string
  title: string
  description: string
  caveats: string[]
  evidence: EvidenceRow[]
  /** The derived service name (Feature 1.6): coarse-key slot 0, filled by the
   *  pipeline's ServiceCode -> ProductCode -> ProductName -> UsageType ->
   *  Operation chain. The Service column renders this - never a subject
   *  split, which showed the account id when the slot was empty. */
  service: string
  /** The AWS account id the finding was measured against (coarse-key slot 1),
   *  present only when it is a real 12-digit id; null otherwise, never a
   *  fabricated placeholder. */
  aws_account_id: string | null
  /** The tenant's team name for aws_account_id, when one is registered
   *  (Feature 1.4). Joined server-side in one scan per request. */
  team_name: string | null
  current_owners?: { email: string; mapping_id: string; match_key: string }[]
  /** The check this finding came from, and when that check ran. Present in
   * every list mode and in the detail payload, so a finding can link back to
   * its run from anywhere; null only in fixtures that predate the field. */
  check_id: string | null
  check_created_at: string | null
  check_window_start?: string | null
  check_window_end?: string | null
  state: FindingState | null
  labels: Label[]
}

export interface CheckDetail {
  id: string
  status: CheckStatusValue
  window_start: string | null
  window_end: string | null
  source_hash: string | null
  reconciliation_status: string | null
  validation_report: Record<string, unknown> & { caveats?: string[] }
  created_at: string
  findings_count: number
  findings: Finding[]
}

export interface CheckStatusResponse {
  check_id: string
  status: CheckStatusValue
  progress: number | null
  message?: string | null
  current_step: string | null
  error: string | null
  failure?: unknown
  canonicalization?: unknown
}

export interface CheckCreated {
  check_id: string
  status: string
  findings_count: number
  job_id: string | null
}

export interface CheckSummary {
  commitment_assessments?: CommitmentAssessment[]
  id: string
  status: CheckStatusValue
  window_start: string | null
  window_end: string | null
  created_at: string
  findings_count: number
  archived_at: string | null
  /** Unavailable: findings overlap and their amounts use different periods. */
  total_impact_cents: number | null
}

// ---------------------------------------------------------------------------
// Task D payloads
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  check_id: string | null
  check_created_at: string | null
  window_start: string | null
  window_end: string | null
  /** The CUR total for the check window (windowTotalCents); null when no
   * completed check exists — the honest answer, never a fabricated 30-day
   * rolling number. */
  total_spend_cents: number | null
  active_findings: number
  /** Unavailable across findings with different time bases. */
  unexpected_spend_cents: number | null
  unused_commitments_cents: number | null
  commitment_family_totals?: Record<string, CommitmentFamilyTotal>
  commitment_assessments?: CommitmentAssessment[]
  unexplained_remainder_cents: number | null
  findings_by_severity: Record<string, number>
  assessment_status?: string
  top_services: { service: string; impact_cents: number | null; findings: number }[]
}

/** Saved canonical source observations, not invoice/delivery completeness. */
export interface DashboardSpendHistory {
  version: 'daily_spend_v1'
  check_id: string
  status: 'available' | 'partial' | 'unavailable'
  basis: 'unblended'
  currency: 'USD' | null
  population: 'selected_primary_files'
  /** Date endpoints are inclusive UTC calendar days. */
  window: { start: string | null; end: string | null; days: number | null; observed_days: number | null }
  daily: { date: string; amount_cents: number | null; observed_rows: number }[]
  baseline: {
    status: 'available' | 'unavailable'
    daily_average_cents: number | null
    start: string | null
    end: string | null
    days: number | null
    observed_days: number | null
    source: 'selected_baseline_files' | 'in_file_history' | null
  }
  total_cents: number | null
  reconciliation_status: string
  delivery_completeness: 'unverified'
  reasons: CommitmentAssessment[]
  rounding: 'balanced_daily_cents'
  source_formats: string[]
  caveats: string[]
}

export interface Commitment {
  id: string
  /** The check the plan was observed in. Null on an aggregate row (Task 5):
   * a plan totalled across the tenant's history names no single check. */
  check_id: string | null
  category: string
  name: string | null
  service: string | null
  amount_cents: number | null
  measurement?: CommitmentMeasurement | null
  used_cents: number | null
  /** null when consumption is unknown - never a fabricated 0. */
  unused_cents: number | null
  utilization_pct: number | null
  region: string | null
  account: string | null
  end_date: string | null
}

/** The unused-commitment breakdown, aggregated on the commitments surface
 * (Task 5, moved from the allocation page). */
export interface CommitmentBreakdown {
  total_unused_cents: number | null
  assessment?: CommitmentAssessment[]
  by_category: Record<string, number>
  /** Categories this file cannot answer (2026-10-10): the UI labels them
   * "not derivable from this file" instead of implying a checked-and-zero
   * $0. Absent from older checks, so the field is optional. */
  non_derivable_categories?: string[]
}

/** One team's commitment totals, from the tenant's team configuration.
 * The nullables are null when any contributing row lacks consumption. */
export interface CommitmentTeam {
  name: string
  accounts: string[]
  committed_cents: number | null
  assessment?: CommitmentAssessment[]
  used_cents: number | null
  remaining_cents: number | null
  utilisation_pct: number | null
  waste_cents: number | null
}

export interface CommitmentsResponse {
  family_totals?: Record<string, CommitmentFamilyTotal>
  assessment?: CommitmentAssessment[]
  totals?: { purchased: number | null; used: number | null; unused: number | null; utilization_pct: number | null }
  check_id: string | null
  /** Which source produced this payload: one named/latest check, or the
   * tenant's full history (Task 5). */
  mode: 'check' | 'aggregate'
  commitments: Commitment[]
  /** Utilization across REAL completed checks; utilization_pct is null for
   * a check whose commitments include unknown consumption. */
  trend: { check_id: string; date: string; utilization_pct: number | null }[]
  breakdown: CommitmentBreakdown
  teams: CommitmentTeam[]
}

/** The plan in force and the limits a check submission spends (Task 6).
 * Read through the same tier resolver the enforcement uses, so what this
 * shows and what the endpoint refuses cannot disagree. */
/** A subscription row, as the billing endpoints report it (Task 10). */
export interface SubscriptionPayload {
  provider: string
  plan: string
  status: string
  current_period_end: string | null
  trial_ends_at: string | null
}

export interface TrialBilling {
  purchased: boolean
  paid_at: string | null
  ends_at: string | null
  fully_refunded_at: string | null
  refund_eligible: boolean
  refund_state: 'none' | 'sending' | 'uncertain' | 'failed' | 'confirmed'
  repurchase_allowed: boolean
  reconciliation_required: boolean
}

export interface Plan {
  tier: string | null
  files_per_batch: number | null
  files_per_day: number | null
  files_per_day_used: number
  checks_per_day?: number | null
  checks_per_day_used?: number
  checks_remaining?: number | null
  max_file_bytes?: number | null
  effective_max_file_bytes?: number | null
  max_check_bytes?: number | null
  max_daily_bytes?: number | null
  daily_bytes_used?: number | null
  base_bytes_remaining?: number | null
  prepaid_bytes_remaining?: number | null
  effective_bytes_remaining?: number | null
  max_upload_bytes?: number | null
  max_request_bytes?: number | null
  lines_per_file: number | null
  aws_direct?: boolean | null
  aws_accounts?: number | null
  retention_days?: number | null
  upgrade_to: string | null
  pending_plan: string | null
  entitlement: {
    state: 'active' | 'none' | 'pending' | 'expired' | 'not_started' | 'unavailable'
    source: string | null
    starts_at: string | null
    ends_at: string | null
    reason: string
    recovery: string
  }
}

export interface Allocation {
  ri_evidence?: {
    plan_id: string
    expired_since?: string
    purchase_region?: string
    consumed_regions?: string[]
  }[]
  family_totals?: Record<string, CommitmentFamilyTotal>
  total_unused_cents: number | null
  assessment?: CommitmentAssessment[]
  consumed_available?: boolean
  observed_consumed_by_account?: Record<string, number>
  by_category: Record<string, number>
  consumed_by_account: Record<string, number>
  /** Categories this file cannot answer; see CommitmentBreakdown. */
  non_derivable_categories?: string[]
}

export interface SavedReport {
  id: string
  name: string
  config_json: Record<string, unknown>
  created_at: string
  updated_at: string
  archived_at: string | null
  /** Task 3: null until Share is pressed. The public link is `/r/<token>`. */
  share_token: string | null
  share_created_at: string | null
}

/** The checks a saved report names. Task 3 made the selection the whole point
 *  of a report, so it is read rather than assumed: a report whose config has no
 *  `check_ids` predates the feature and would otherwise download as an empty
 *  document with nothing on screen to say why. */
export interface SavedReportConfig {
  check_ids?: string[]
}

/** The findings-retention window in force (Task 4).
 *
 *  Read-only: it is derived from the plan, not a setting, and the same answer
 *  drives the nightly cleanup - so the number printed on `/findings` is the
 *  one the job actually enforces, not a second copy that agrees today. */
export interface Retention {
  tier: string | null
  retention_days: number | null
  status?: 'known' | 'preserved'
  recovery?: string | null
}

/**
 * The report document (Task 3). One shape for the download and the public page
 * - the server builds it once, so these two cannot drift apart.
 *
 * `tenant_id` is deliberately absent, and so is anything from
 * aws_connections: a share link is a capability and must not double as a way to
 * learn whose account it belongs to.
 */
export interface ReportPayload {
  report: {
    id: string
    name: string
    created_at: string
    shared_at: string | null
  }
  generated_at: string
  generated_by: string
  check_count: number
  checks: ReportCheck[]
  /** Config-named checks that no longer resolve. Named, not dropped: a document
   *  that silently lost one of three checks reads as complete. */
  missing_check_ids: string[]
  /** Present only on the public read. */
  share_url?: string | null
  /** Task 7: when this link stops working, on the public read. The resolver
   *  refuses expired tokens outright, so a payload carrying a value is always
   *  a link still in its lifetime. Null = never expires. */
  share_expires_at?: string | null
}

export interface ReportCheck {
  id: string
  status: string
  window_start: string | null
  window_end: string | null
  created_at: string
  archived_at: string | null
  caveats: string[]
  canonicalization?: {
    status: 'canonical' | 'refused'
    rawRows: number
    canonicalRows: number
    removedCopyRows: number
    conflictRows: number
    conflictGroups: number
    roles: Record<'primary' | 'baseline', { rawRows: number; canonicalRows: number; removedCopyRows: number }>
    definition: string
  } | null
  findings_count: number
  total_impact_cents: number | null
  findings: ReportFinding[]
}

export interface ReportFinding {
  id: string
  detector_type: string
  severity: string
  impact_cents: number | null
  impact_basis?: string
  amount_measurement?: FindingAmountMeasurement | null
  attribution?: ResourceAttribution | null
  evidence_total_cents: number | null
  evidence_measurement?: EvidenceMeasurement | null
  coarse_key: string[]
  subject: string
  title: string
  description: string
  caveats: string[]
  evidence: { row_reference: string; amount_cents: number | null; raw_cost_cents?: number | null; usage_date?: string | null }[]
}

/** What POST /api/reports/{id}/share returns. */
export interface ReportShare {
  report_id: string
  share_token: string
  share_created_at: string | null
  /** Task 7: when the link stops working; null = never. */
  share_expires_at: string | null
  /** A path, not an absolute URL: the API does not know its own public
   *  hostname, and the browser resolves it against its own origin. */
  url: string
}

export interface DataSource {
  id: string
  kind: string
  config_json: Record<string, unknown>
  connected_at: string
  disconnected_at: string | null
}

export interface DataSourceInput {
  kind: 'upload' | 's3' | 'r2'
  config: Record<string, unknown>
}

export interface DataSourceStatusInput {
  id: string
  disconnected_at: string | null
}

export interface NotificationRule {
  id: string
  name: string
  condition_json: Record<string, unknown>
  channel: string
  target: string | null
  enabled: boolean
  active?: boolean
  inactive_reason?: string | null
  created_at: string
  updated_at: string
}

export interface NotificationRuleInput {
  name: string
  condition: Record<string, unknown>
  channel: 'email' | 'webhook' | 'slack'
  target?: string | null
  enabled?: boolean
}

export interface Integration {
  id: string
  kind: string
  config_json: Record<string, unknown>
  enabled: boolean
  active?: boolean
  inactive_reason?: string | null
  created_at: string
}

export interface IntegrationInput {
  kind: 'slack' | 'jira' | 'webhook'
  config: Record<string, unknown>
  enabled?: boolean
}

export interface TeamMapping {
  id: string
  match_key: string
  match_value: string
  owner_email: string
  created_at: string
  active?: boolean
  inactive_reason?: string | null
}

export interface TeamMappingInput {
  match_key: string
  match_value: string
  owner_email: string
}

export interface LibraryUploadInput {
  file: File
  source: 'manual' | 'baseline_only'
  description?: string
}

/** An AWS account id attributed to a named team (Feature 1). */
export interface Team {
  id: string
  name: string
  /** Exactly 12 digits; the join key findings carry in coarse_key[1]. */
  aws_account_id: string
  created_at: string
  updated_at: string
}

/** One library file (Features 4/6). `storage_path` is deliberately absent -
 *  a server filesystem path the browser has no use for. */
export interface Upload {
  id: string
  filename: string
  size_bytes: number
  /** Measured by the worker after the owning check completes; null until
   *  then and never fabricated - "no date range" is the honest rendering. */
  row_count: number | null
  min_date: string | null
  max_date: string | null
  source: 'manual' | 's3_sync' | 'baseline_only'
  description?: string | null
  origins?: ('manual_check' | 'library')[]
  created_at: string
}

export interface TenantSettings {
  id: string
  name: string
  settings: Record<string, unknown>
}

/**
 * What `POST /api/uploads/inspect` answered about a file that was not stored.
 *
 * The backend names are the endpoint's own (`snake_case`), unlike
 * `UploadInspect` in lib/window-choice, which is the camelCase shape the dialog
 * works in. Two shapes for one payload is deliberate: the wire format is not
 * this file's invention to rename, and the conversion happens once, at the
 * query, where a mismatch would be visible.
 */
export interface UploadInspect {
  row_count: number | null
  min_date: string | null
  max_date: string | null
}

/**
 * A tenant's AWS account, reached by assuming a role they created.
 *
 * There is deliberately no `external_id` or `external_id_encrypted` field here.
 * The API does not send the secret to the browser in any form, and a type that
 * named it would be an invitation to start sending it. The server's contract is
 * the proof: `AwsConnectionOut` has no such attribute, so serialisation drops
 * it even if one were added here by mistake.
 */
export interface AwsConnection {
  id: string
  role_arn: string
  bucket: string
  prefix: string | null
  region: string | null
  last_tested_at: string | null
  last_test_status: string | null
  last_test_error: string | null
  disconnected_at: string | null
  /** Task 8: set when the connection was removed in place - the purge
   *  blanked the credential material and the row is now an audit stub. */
  removed_at?: string | null
  created_at: string
}

/**
 * The result of trying to use a connection.
 *
 * `ok: false` is a *successful* API call reporting a failure - a 200 or 201
 * carrying this. It is not an error state, and the UI must render `message` and
 * `hint` as instructions rather than showing a generic failure. The distinction
 * matters: "your trust policy does not name CommitOps" is the single most
 * common thing that happens when someone sets this up, and it needs its own
 * text, not "something went wrong".
 */
export interface AwsTestReport {
  ok: boolean
  role_arn: string
  bucket: string
  prefix: string
  region: string
  file_count: number
  newest_file: string | null
  newest_file_modified: string | null
  error: string | null
  code: string | null
  message: string | null
  hint: string | null
}

export interface AwsConnectionCreated {
  connection: AwsConnection
  test: AwsTestReport
}

export interface AwsSyncResponse {
  check_id: string | null
  status: string
  /** How many new files were downloaded and fed to the check. 0 = noop. */
  files: number | null
  /** "N new file(s) synced" or "Nothing new to sync" - shown verbatim. */
  message: string
  /** Where the data came from (the download directory). */
  source: string
}

/** What POST /api/aws/connections/:id/sync accepts (Feature 3). Both date
 *  filters are optional LastModified bounds; skip_ingested defaults to true
 *  because "give me what is new" is the common case. */
export interface AwsSyncRequest {
  since?: string | null
  until?: string | null
  skip_ingested: boolean
}
