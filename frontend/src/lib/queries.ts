import { uploadResumable, submitResumableCheck } from './resumable-upload'
/**
 * Typed query and mutation hooks (Task F.1b-fix).
 *
 * Every page used to own a `useEffect` that fetched on mount and threw the
 * result into local state. Nothing was shared between pages, so a back-and-forth
 * navigation re-fetched data the app already had. The queries below replace that
 * one-at-a-time fetching with a single cache, which is what makes a return visit
 * free.
 *
 * Conventions worth knowing before editing:
 *
 * - Keys are built by `keys`, never written inline. Invalidation is by prefix,
 *   so `queryClient.invalidateQueries({ queryKey: keys.findings.root })` reaches
 *   every findings variant (any check, any limit) without enumerating them.
 * - Every `queryFn` goes through `apiFetch`, so the 401-redirect and the
 *   403 evidence-freeze behaviour are unchanged from the hand-rolled client.
 * - A `useQuery` for data that is not mounted is kept for `gcTime` and then
 *   dropped, so a page visited once does not pin its payload for the session.
 */
import { useEffect, useRef } from 'react'
import {
  useQuery as usePublicQuery,
  useMutation as useHistoryMutation,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { publicFetch } from './api'
import { useAuth } from './use-auth'
import { assertIdentity, privateKey } from './private-identity'
import { usePrivateApi, usePrivateInfiniteQuery, usePrivateQuery as useQuery, usePrivateMutation as useMutation, usePrivateQueryClient as useQueryClient } from './private-queries'
import { reportFilename } from './report-download'
import { decodeGrowth } from './monthly-growth'
import type {
  Allocation,
  HistoryReport,
  HistoryReportInput,
  HistoryBreakdown,
  HistoryBreakdownInput,
  AwsConnection,
  AwsConnectionCreated,
  AwsSyncRequest,
  AwsSyncResponse,
  AwsTestReport,
  CheckDetail,
  CheckStatusResponse,
  CheckSummary,
  CommitmentsResponse,
  CommitmentAssessment,
  DashboardSummary,
  DashboardSpendHistory,
  DataSource,
  DataSourceInput,
  DataSourceStatusInput,
  Finding,
  FindingState,
  NotificationRule,
  NotificationRuleInput,
  Integration,
  IntegrationInput,
  Plan,
  ReportPayload,
  ReportShare,
  Retention,
  SavedReport,
  SavedReportConfig,
  SubscriptionPayload,
  Team,
  TeamMapping,
  TeamMappingInput,
  LibraryUploadInput,
  Upload,
  TenantSettings,
  TrialBilling,
} from './types'
import type { FileSpan } from './window-choice'

/**
 * Query key factory.
 *
 * Hierarchical on purpose: react-query invalidates by prefix, so a mutation
 * that changes findings can invalidate the whole subtree with one call.
 */
export const keys = {
  history: {
    root: ['allocation-history'] as const,
    reports: () => ['allocation-history', 'reports'] as const,
    status: (id: string) => ['allocation-history', 'status', id] as const,
    breakdown: (id: string, input: HistoryBreakdownInput) => ['allocation-history', 'breakdown', id, input] as const,
  },
  checks: {
    root: ['checks'] as const,
    /** Every `list` variant, whatever its limit - and *not* status/detail/
     *  allocation. Invalidating `checks.root` on completion would also
     *  invalidate the status query that triggered it, which refetches the very
     *  answer that just arrived. */
    lists: ['checks', 'list'] as const,
    list: (limit = 100) => ['checks', 'list', { limit, mode: 'pages' }] as const,
    detail: (id: string) => ['checks', 'detail', id] as const,
    status: (id: string) => ['checks', 'status', id] as const,
    allocation: (id: string) => ['checks', 'allocation', id] as const,
  },
  findings: {
    root: ['findings'] as const,
    // `all` is a key dimension: the history list and the one-check list are
    // different answers to different questions and must never share a cache
    // entry - a cached history shown for a chosen check (or the reverse) is
    // the page quietly lying about what it is displaying.
    list: (checkId?: string, limit = 100, all = false, includeArchived = false) =>
      ['findings', 'list', { checkId, limit, all, includeArchived }] as const,
    detail: (id: string) => ['findings', 'detail', id] as const,
  },
  dashboard: {
    root: ['dashboard'] as const,
    summary: (checkId?: string) => ['dashboard', 'summary', { checkId }] as const,
    spendHistory: (checkId?: string) => ['dashboard', 'spend-history', { checkId }] as const,
    growth: (checkId?: string) => ['dashboard', 'growth', { checkId }] as const,
  },
  commitments: {
    root: ['commitments'] as const,
    list: (checkId?: string, aggregate = false) =>
      ['commitments', 'list', { checkId, aggregate }] as const,
  },
  reports: {
    root: ['reports'] as const,
    list: () => ['reports', 'list'] as const,
  },
  /** A shared report read by token (Task 3). Not under `reports.root`: this is
   *  the only cached document in the app that anyone on the internet may see,
   *  and prefix-invalidating the owner's report list should never throw it away
   *  - or, the other way round, let a public document sit under a key that also
   *  serves private data. */
  sharedReport: {
    root: ['shared-report'] as const,
    byToken: (token: string) => ['shared-report', token] as const,
  },
  dataSources: {
    root: ['data-sources'] as const,
    list: () => ['data-sources', 'list'] as const,
  },
  awsConnections: {
    root: ['aws-connections'] as const,
    list: () => ['aws-connections', 'list'] as const,
  },
  settings: {
    root: ['settings'] as const,
    tenant: () => ['settings', 'tenant'] as const,
    notificationRules: () => ['settings', 'notification-rules'] as const,
    integrations: () => ['settings', 'integrations'] as const,
    teamMappings: () => ['settings', 'team-mappings'] as const,
    retention: () => ['settings', 'retention'] as const,
    plan: () => ['settings', 'plan'] as const,
  },
  /** Teams (Feature 1). Its own subtree, not under settings: a team is a
   *  tenant-wide attribution, and the findings page invalidates it when a
   *  team is edited just as the settings page does - prefix-invalidating
   *  `settings.root` from the teams hooks would evict unrelated settings. */
  teams: {
    root: ['teams'] as const,
  },
  /** The uploads library (Features 4/6). Its own subtree: the picker is a
   *  tenant's whole file history and is invalidated when a check lands (new
   * rows) - neither `checks` nor `settings` should pay for that. */
  uploads: {
    root: ['uploads'] as const,
    list: (search: string, from: string, to: string) =>
      ['uploads', 'list', { search, from, to }] as const,
  },
} as const

/** How often the running-check poll hits the status endpoint. */
export const CHECK_POLL_MS = 2_000

/** Submission is an explicit action: no automatic mutation retries. The caller
 * retains its idempotency key after an uncertain transport failure. */
export function useBuildHistoryReport() {
  const { apiFetch } = usePrivateApi()
  const { identity } = useAuth()
  const qc = useQueryClient()
  return useHistoryMutation({
    mutationKey: privateKey(identity, ['history-build']),
    retry: false,
    mutationFn: async ({ input, idempotencyKey }: { input: HistoryReportInput; idempotencyKey: string }) => {
      assertIdentity(identity)
      const result = await apiFetch<HistoryReport>('/api/allocation/history/reports', {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
      })
      assertIdentity(identity)
      return result
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.history.reports() }) },
  })
}

export function useHistoryReports() {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.history.reports(),
    queryFn: ({ signal }) => apiFetch<{ reports: HistoryReport[] }>('/api/allocation/history/reports?limit=20', { signal }),
  })
}

export function useHistoryReport(id: string | undefined) {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.history.status(id ?? ''),
    queryFn: ({ signal }) => apiFetch<HistoryReport>(`/api/allocation/history/reports/${encodeURIComponent(id!)}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status ?? '') ? CHECK_POLL_MS : false,
    retry: false,
  })
}

export function useHistoryBreakdown(id: string | undefined, input: HistoryBreakdownInput, enabled = true) {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.history.breakdown(id ?? '', input),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        group_by: input.group_by, offset: String(input.offset), limit: String(input.limit),
        search: input.search, sort: input.sort,
      })
      if (input.scope_id) params.set('scope_id', input.scope_id)
      return apiFetch<HistoryBreakdown>(`/api/allocation/history/reports/${encodeURIComponent(id!)}/breakdown?${params}`, { signal })
    },
    enabled: Boolean(id) && enabled,
    retry: false,
  })
}

export interface PageInfo {
  total: number
  offset: number
  limit: number
  returned: number
  has_more: boolean
}
interface PageEnvelope<T> extends PageInfo { items: T[] }
interface ChecksPage extends PageEnvelope<CheckSummary> { latestCompleted?: CheckSummary }
export interface FindingsPageFilters {
  offset: number
  severity?: string
  detector_type?: string
  state?: string
  search?: string
}

// --- checks ---------------------------------------------------------------

export function useChecks(limit = 100) {
  const { apiFetch } = usePrivateApi()
  const query = usePrivateInfiniteQuery<ChecksPage>({
    queryKey: keys.checks.list(limit),
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) => {
      const page = await apiFetch<ChecksPage>(`/api/checks?paginated=true&include_archived=true&offset=${pageParam}&limit=${limit}`, { signal })
      if (!Array.isArray(page.items)) throw new Error('Check history could not be read. Please retry.')
      if (pageParam === 0 && page.has_more && !page.items.some(check => check.status === 'completed' && !check.archived_at)) {
        const latest = await apiFetch<PageEnvelope<CheckSummary>>('/api/checks?paginated=true&include_archived=false&status=completed&offset=0&limit=1', { signal })
        if (!Array.isArray(latest.items)) throw new Error('The latest completed check could not be read. Please retry.')
        return { ...page, latestCompleted: latest.items[0] }
      }
      return page
    },
    getNextPageParam: page => page.has_more && page.items.length ? page.offset + page.items.length : undefined,
  })
  const rows = query.data?.pages.flatMap(page => [...page.items, ...(page.latestCompleted ? [page.latestCompleted] : [])])
  return { ...query, data: rows ? [...new Map(rows.map(check => [check.id, check])).values()] : undefined }
}

/**
 * `when` is for the case where the id is known but the record is not worth
 * fetching yet: a check that is still running has no findings, so asking for its
 * detail during the run returns a half-built object and wastes a round trip.
 * Defaults to "fetch as soon as there is an id".
 */
export function useCheck(
  id: string | undefined,
  when: boolean = true,
): UseQueryResult<CheckDetail> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.checks.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<CheckDetail>(`/api/checks/${id}`, { signal }),
    enabled: Boolean(id) && when,
  })
}

/**
 * How long to wait before asking again, given what we currently know.
 *
 * Pure on purpose: the "no data means keep going" rule below was a real bug and
 * it needs to be assertable without a DOM or a live check.
 *
 * The rule that is easy to get wrong: a query with no data is not finished.
 * `refetchInterval` returning `false` cancels the timer, and only a *successful*
 * fetch restarts it. So returning `false` whenever `data` is absent means the
 * first failed request stops the poll permanently, and the page - which has no
 * data either - then renders the absence as "still queued" and sits there
 * indefinitely, with no reason shown and no way out but a reload.
 *
 * That is a hazard, not the cause of the frozen progress bar first seen in
 * production. That one had a different cause, recorded honestly: the interval
 * was being suppressed because the document was hidden
 * (`queryObserver.cjs` gates the callback on `focusManager.isFocused()`), which
 * is fixed by `refetchIntervalInBackground` below. This rule is the second,
 * independent way the same freeze can happen, and it is the one that bites a
 * real user in a visible tab after a single dropped request.
 */
export function checkPollInterval(data: { status?: string } | undefined,
  options: { errors?: number; hidden?: boolean; random?: number } = {}): number | false {
  const status = data?.status
  if (status && status !== 'queued' && status !== 'running') return false
  const base = options.hidden ? 15_000 : status === 'queued' ? 5_000 : CHECK_POLL_MS
  const backoff = Math.min(base * 2 ** Math.min(options.errors ?? 0, 4), 30_000)
  return Math.round(backoff * (0.9 + (options.random ?? 0.5) * 0.2))
}

/**
 * Poll only while the check is actually moving.
 *
 * Returning `false` from `refetchInterval` stops the timer entirely, so a
 * finished check costs zero requests. A fixed interval would keep hammering
 * the endpoint every 2 s for the rest of the session, which is the same mistake
 * this whole change exists to fix. See checkPollInterval() for the case that
 * made this a bug rather than an optimisation.
 */
/**
 * Mark everything a finished check invalidates as stale.
 *
 * Split out of `useCheckStatus` and exported so it can be tested against a real
 * QueryClient. The wiring (an effect keyed on the terminal status) cannot be
 * covered here: this repo's component tests are SSR via `renderToStaticMarkup`,
 * and React does not run effects while server-rendering. Recorded as an
 * unverified area in the F.1d audit (see FINALREPORT.md §4) rather than
 * papered over with a mock.
 *
 * `checks.lists`, not `checks.root`: the status query that calls this lives
 * under `checks.root`, so invalidating the root would invalidate the very query
 * that just delivered the answer, refetching it for nothing.
 */
export function invalidateAfterCheckSettled(qc: Pick<QueryClient, 'invalidateQueries'>): void {
  void qc.invalidateQueries({ queryKey: keys.checks.lists })
  void qc.invalidateQueries({ queryKey: keys.findings.root })
  void qc.invalidateQueries({ queryKey: keys.dashboard.root })
  void qc.invalidateQueries({ queryKey: keys.commitments.root })
  void qc.invalidateQueries({ queryKey: keys.settings.plan() })
}

export function useCheckStatus(id: string | undefined): UseQueryResult<CheckStatusResponse> {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: keys.checks.status(id ?? ''),
    queryFn: ({ signal }) => apiFetch<CheckStatusResponse>(`/api/checks/${id}/status`, { signal }),
    enabled: Boolean(id),
    refetchInterval: (query) => checkPollInterval(query.state.data, {
      errors: query.state.fetchFailureCount,
      hidden: typeof document !== 'undefined' && document.hidden,
      random: Math.random(),
    }),
    // Keep polling when the tab is in the background.
    //
    // React Query suppresses the interval callback entirely when the document is
    // hidden (`queryObserver.cjs`: `if (refetchIntervalInBackground ||
    // focusManager.isFocused()) executeFetch()`). Left at the default, a user
    // who switches tabs during a check comes back to a progress bar frozen at
    // whatever it last showed - "Validating data, 40%" for a check that
    // finished two minutes ago - because the resume depends entirely on the
    // focus refetch landing. A check takes tens of seconds and a background tab
    // is a completely normal place to be while it runs.
    //
    // The cost is one request every 2 s, and only while a check is actually
    // queued or running: checkPollInterval() returns false the moment it is
    // terminal, so a finished check costs nothing. Deliberately NOT set as a
    // client-wide default - the list and summary queries have no business
    // refetching on a timer in the background.
    refetchIntervalInBackground: true,
  })

  // A finished check changes every number on every other page, and nothing else
  // in the app knows it finished (audit F.1d).
  //
  // Measured: `POST /api/checks` invalidated `checks.root` immediately, which
  // refetched the list while the check was still `queued`. From then until the
  // 30 s staleTime expired, the Checks list showed "queued", Findings served
  // whatever it had cached (nothing, for a first run), and the Dashboard served
  // the previous run's totals - with zero requests, because fresh data is
  // served without refetching. The user runs a check, watches it finish, clicks
  // Dashboard, and sees the numbers from before the run.
  //
  // The ref makes this once per check id, so a terminal status re-observed (a
  // focus refetch, say) does not re-invalidate on every render.
  const settled = useRef<string | null>(null)
  useEffect(() => {
    const status = query.data?.status
    if (!id || (status !== 'completed' && status !== 'failed')) return
    if (settled.current === id) return
    settled.current = id
    invalidateAfterCheckSettled(qc)
    // `qc` is in the deps because the rule is right that it is one, not because
    // it varies: `useQueryClient()` returns the one instance the provider built,
    // so listing it costs nothing and does not re-run this effect per render.
  }, [id, query.data?.status, qc])

  return query
}

/**
 * The allocation breakdown for one check.
 *
 * The check's id is the whole key: two checks are two different breakdowns, and
 * showing one while the other is loading would be a data-correctness bug, not a
 * cosmetic one.
 */
export function useAllocation(checkId: string | undefined): UseQueryResult<Allocation> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.checks.allocation(checkId ?? ''),
    queryFn: ({ signal }) => apiFetch<Allocation>(`/api/checks/${checkId}/allocation`, { signal }),
    enabled: Boolean(checkId),
  })
}

// --- findings -------------------------------------------------------------

/**
 * `limit` is part of the key, so the dashboard's top-5 and the findings page's
 * full list are cached independently.
 *
 * They are deliberately NOT unified. The dashboard needs 5 rows and the findings
 * page needs 200, and sharing one key would mean either the dashboard fetching
 * 200 rows it will not render, or a key that lies about which rows it holds.
 * Both pages still get a cache hit on return navigation, which is the goal.
 */
export function useFindings(
  checkId?: string,
  limit = 100,
  all = false,
  enabled = true,
  includeArchived = false,
  filters?: FindingsPageFilters,
 ) {
  const { apiFetch } = usePrivateApi()
  const parts: string[] = []
  if (all) parts.push('all=1')
  else if (checkId) parts.push(`check=${checkId}`)
  parts.push(`limit=${limit}`)
  if (includeArchived) parts.push('include_archived=true')
  parts.push('include_assessments=true')
  if (filters) {
    parts.push('paginated=true', `offset=${filters.offset}`)
    for (const name of ['severity', 'detector_type', 'state', 'search'] as const) {
      const value = filters[name]
      if (value && value !== 'all') parts.push(`${name}=${encodeURIComponent(value)}`)
    }
  }
  const query = useQuery({
    queryKey: [...keys.findings.list(checkId, limit, all, includeArchived), ...(filters ? [filters] : [])],
    queryFn: ({ signal }) => apiFetch<Partial<PageEnvelope<Finding>> & { findings?: Finding[]; assessments: CommitmentAssessment[] }>(`/api/findings?${parts.join('&')}`, { signal }),
    // `enabled` is deliberately NOT a key dimension: it is a loading-state
    // fact, not a data fact. The findings page holds the query back until the
    // checks list resolves which check is the default, so the first fetch is
    // the right one rather than an unfiltered flash followed by a correction.
    enabled,
  })
  return { ...query, data: query.data?.items ?? query.data?.findings, assessments: query.data?.assessments ?? [],
    pagination: filters && query.data ? query.data as PageInfo : undefined }
}

export function useArchiveCheck() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, archived_at }: { id: string; archived_at: string | null }) =>
      apiFetch<CheckSummary>(`/api/checks/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived_at }),
      }),
    onSuccess: () => {
      for (const key of [keys.checks.root, keys.findings.root, keys.dashboard.root, keys.commitments.root]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export function useRestoreCheck() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<CheckSummary>(`/api/checks/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived_at: null }),
    }),
    onSuccess: () => {
      for (const key of [keys.checks.root, keys.findings.root, keys.dashboard.root, keys.commitments.root]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

/** Task 8: archive findings in bulk by date cutoff - checks created before the
 * cutoff are archived (never deleted), and the counts come back for the
 * confirmation message. */
export function useBulkArchiveFindings() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cutoff: string) =>
      apiFetch<{ cutoff: string; checks_archived: number; findings_archived: number }>(
        '/api/findings/archive-bulk',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cutoff }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.findings.root })
      void qc.invalidateQueries({ queryKey: keys.checks.root })
      void qc.invalidateQueries({ queryKey: keys.dashboard.root })
      void qc.invalidateQueries({ queryKey: keys.commitments.root })
    },
  })
}

/** Task 8: remove an AWS connection - a purge in place; the stub stays in the
 * list with removed_at set and the credential material blank. */

export function useFinding(id: string | undefined): UseQueryResult<Finding> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.findings.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<Finding>(`/api/findings/${id}`, { signal }),
    enabled: Boolean(id),
  })
}

// --- the rest of the read surface -----------------------------------------

export function useDashboardSummary(checkId?: string): UseQueryResult<DashboardSummary> {
  const { apiFetch } = usePrivateApi()
  const query = checkId ? `?check=${checkId}` : ''
  return useQuery({
    queryKey: keys.dashboard.summary(checkId),
    queryFn: ({ signal }) => apiFetch<DashboardSummary>(`/api/dashboard/summary${query}`, { signal }),
  })
}

/** Bind source history to the same completed check as the summary. */
export function useDashboardSpendHistory(checkId?: string): UseQueryResult<DashboardSpendHistory> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.dashboard.spendHistory(checkId),
    queryFn: ({ signal }) => apiFetch<DashboardSpendHistory>(`/api/dashboard/spend-history?check=${encodeURIComponent(checkId!)}`, { signal }),
    enabled: Boolean(checkId),
  })
}

export function useDashboardGrowth(checkId?: string) {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.dashboard.growth(checkId),
    queryFn: async ({ signal }) => decodeGrowth(await apiFetch<unknown>(`/api/dashboard/growth?check=${encodeURIComponent(checkId!)}`, { signal })),
    enabled: Boolean(checkId), staleTime: 60_000, refetchOnWindowFocus: 'always',
    refetchInterval: query => query.state.data?.status === 'preparing' ? 2_000 : 60_000,
    refetchIntervalInBackground: false,
  })
}

export function usePrepareGrowth(checkId: string) {
  const { apiFetch } = usePrivateApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<{ status: string }>('/api/dashboard/growth/prepare', { method: 'POST', body: JSON.stringify({ check_id: checkId }) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: keys.dashboard.growth(checkId) }) },
  })
}

export function useCommitments(
  checkId?: string,
  aggregate = false
): UseQueryResult<CommitmentsResponse> {
  const { apiFetch } = usePrivateApi()
  const params = new URLSearchParams()
  if (checkId) params.set('check', checkId)
  if (aggregate) params.set('aggregate', 'true')
  const query = params.size > 0 ? `?${params.toString()}` : ''
  return useQuery({
    queryKey: keys.commitments.list(checkId, aggregate),
    queryFn: ({ signal }) => apiFetch<CommitmentsResponse>(`/api/commitments${query}`, { signal }),
  })
}

export function useReports(): UseQueryResult<SavedReport[]> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.reports.list(),
    queryFn: ({ signal }) => apiFetch<SavedReport[]>('/api/reports?include_archived=true', { signal }),
  })
}


/** The tenant's AWS connections. Separate from `useDataSources` on purpose -
 *  a different table with a different contract (write-once identity, a secret
 *  the browser never sees, mutable test status) and a different key, so
 *  invalidating one cannot blank the other's list. */

export function useSettings(): UseQueryResult<TenantSettings> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.settings.tenant(),
    queryFn: ({ signal }) => apiFetch<TenantSettings>('/api/settings/tenant', { signal }),
  })
}

/** The plan in force and the limits a submission spends (Task 6). */
export function usePlan(): UseQueryResult<Plan> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.settings.plan(),
    queryFn: ({ signal }) => apiFetch<Plan>('/api/plan', { signal }),
  })
}

/** Task 9: record the plan the customer chose - a claim on the account until
 * payment completes. */

/** Task 9: record a Trial refund request with its reason. */



/** The payment page's purchase button: the provider's checkout URL (Task 10's
 * endpoint), opened immediately - the URL is provider-side and short-lived. */

/** The tenant's live subscription (Task 10's read endpoint). Null when they
 * have none - the billing page renders the upgrade path in that case. */

/** Cancel the live subscription (Task 10's endpoint). The provider's
 * confirmed status comes back in the response; the queries are invalidated
 * so the page shows what the provider actually said. */







// --- teams (Feature 1) ------------------------------------------------------

export function useTeams(): UseQueryResult<Team[]> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.teams.root,
    queryFn: ({ signal }) => apiFetch<Team[]>('/api/teams', { signal }),
  })
}

// --- the uploads library (Features 4/6) ---------------------------------------

/**
 * The baseline picker's list.
 *
 * `enabled` is the gate the check page passes as "the library dialog is
 * open" - a tenant's whole file history is not worth a request on every
 * visit to a page whose job is uploading one file.
 */
export function useUploads(
  search = '',
  from = '',
  to = '',
  enabled = true,
  offset = 0,
  knownDates = true,
) {
  const { apiFetch } = usePrivateApi()
  const params = new URLSearchParams()
  if (search.trim()) params.set('search', search.trim())
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (knownDates && (from || to)) params.set('known_dates', 'true')
  params.set('offset', String(offset)); params.set('limit', '50')
  const query = useQuery({
    queryKey: [...keys.uploads.list(search.trim(), from, to), { offset, knownDates }],
    queryFn: ({ signal }) =>
      apiFetch<PageEnvelope<Upload> & { uploads: Upload[] }>(`/api/uploads?${params}`, { signal }),
    enabled,
  })
  return { ...query, data: query.data?.uploads, pagination: query.data as PageInfo | undefined }
}

/** Store one file, without creating a check. POST has no idempotency key:
 * mutations never automatically retry; an uncertain result refreshes the
 * library and usage before the user decides whether to submit again. */
export function useCreateUpload() {
  const { apiFetch } = usePrivateApi()
  const { identity } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, source, description }: LibraryUploadInput) => {
      const finalized = await uploadResumable(file, source === 'baseline_only' ? 'baseline' : 'primary',
        `${identity?.userId}:${identity?.tenantId}`, apiFetch, description?.trim(), 'library')
      if (!finalized.upload) throw new Error('Upload validation did not return the stored export')
      return finalized.upload
    },
    onSettled: (_data, _error, input) => {
      void qc.invalidateQueries({ queryKey: keys.uploads.root })
      if (input.source === 'manual') {
        void qc.invalidateQueries({ queryKey: keys.settings.plan() })
      }
    },
  })
}

export function useDeleteUpload() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.uploads.root }) },
  })
}

/**
 * Measure a file the user just chose, without storing it.
 *
 * A mutation, not a query: it takes a File, and the file is the request. It
 * also deliberately invalidates nothing - no row is created, so no cached list
 * is stale because of it.
 */
export function useInspectUpload() {
  const { apiFetch } = usePrivateApi()
  const { identity } = useAuth()
  return useMutation({
    mutationFn: async (file: File): Promise<FileSpan> => {
      const finalized = await uploadResumable(file, 'primary', `${identity?.userId}:${identity?.tenantId}`, apiFetch)
      const body = finalized.upload
      if (!body) throw new Error('Upload validation did not return file dates')
      // The endpoint 422s rather than answering nulls, so both dates are
      // present here. The check is kept anyway: it is the difference between
      // "the file has no dates" and "the response was not what we asked for",
      // and only the second should fall back silently.
      if (!body.min_date || !body.max_date) {
        throw new Error('the file has no readable usage dates')
      }
      return { minDate: body.min_date, maxDate: body.max_date, rowCount: body.row_count }
    },
  })
}

export function useCreateTeam() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    // The snake_case keys are the backend's TeamIn field names, not a
    // frontend convention - typed so a caller cannot send {name} alone and
    // get a 422 from a field it never named.
    mutationFn: (input: { name: string; aws_account_id: string }) =>
      apiFetch<Team>('/api/teams', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      // Findings carry team_name, so a new team changes what every findings
      // list already shows - both caches are stale the moment this lands.
      void qc.invalidateQueries({ queryKey: keys.teams.root })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
      void qc.invalidateQueries({ queryKey: keys.history.root })
    },
  })
}

export function useUpdateTeam() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<{ name: string; aws_account_id: string }>) =>
      apiFetch<Team>(`/api/teams/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.teams.root })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
      void qc.invalidateQueries({ queryKey: keys.history.root })
    },
  })
}

export function useDeleteTeam() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.teams.root })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
      void qc.invalidateQueries({ queryKey: keys.history.root })
    },
  })
}

/**
 * The findings-retention window for this tenant (Task 4).
 *
 * Its own key, not part of `keys.settings.tenant()`: the tenant *settings*
 * are editable and invalidated whenever one is saved, and a save must not
 * evict a plan fact that saving cannot change.
 */
export function useRetention(): UseQueryResult<Retention> {
  const { apiFetch } = usePrivateApi()
  return useQuery({
    queryKey: keys.settings.retention(),
    queryFn: ({ signal }) => apiFetch<Retention>('/api/settings/retention', { signal }),
  })
}

// --- mutations ------------------------------------------------------------

/**
 * A completed check changes what every other page shows, so the upload
 * invalidates the checks list and lets the running check's own status poll pick
 * up the result. It does not optimistically update anything: a check that has
 * not run yet has no findings, and inventing them would be a lie the user has
 * to notice and dismiss.
 */
export function useCreateCheck() {
  const { apiFetch } = usePrivateApi()
  const { identity } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (form: FormData) => submitResumableCheck(form, `${identity?.userId}:${identity?.tenantId}`, apiFetch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.checks.root })
      void qc.invalidateQueries({ queryKey: keys.uploads.root })
      void qc.invalidateQueries({ queryKey: keys.settings.plan() })
    },
  })
}

export function useUpdateFindingState(id: string) {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { status: string; note?: string }) =>
      apiFetch<FindingState>(`/api/findings/${id}/state`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => {
      // The detail view and the list both carry the state, so both go.
      void qc.invalidateQueries({ queryKey: keys.findings.detail(id) })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
      // ...and so does the dashboard: its `active_findings` is the count of
      // findings NOT in state resolved/archived (dashboard.py), so resolving
      // one is exactly the change that number reports. Without this the
      // Dashboard showed the pre-resolution count for up to staleTime (30 s)
      // and cost zero requests to do it, because fresh cached data is served
      // without refetching. Audit F.1d.
      void qc.invalidateQueries({ queryKey: keys.dashboard.root })
      void variables
    },
  })
}

export function useAddFindingLabel(id: string) {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (label: string) =>
      apiFetch(`/api/findings/${id}/labels`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.findings.detail(id) })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
    },
  })
}

export function useRemoveFindingLabel(id: string) {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (labelId: string) =>
      apiFetch(`/api/findings/${id}/labels/${labelId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.findings.detail(id) })
      void qc.invalidateQueries({ queryKey: keys.findings.root })
    },
  })
}

export function useCreateReport() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; config: SavedReportConfig }) =>
      apiFetch<SavedReport>('/api/reports', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.reports.root })
    },
  })
}

/**
 * Give a report its public link, or hand back the one it has (Task 3).
 *
 * The server is idempotent here on purpose - see the endpoint's docstring - so
 * this invalidates the list and lets the server answer, rather than trying to
 * keep a token in client state that a refetch would contradict.
 *
 * Task 7: the call may carry an expiry - whole days from now, or nothing for
 * "never". The token stays the same either way; only the lifetime moves.
 */

/**
 * Fetch a shared report by token. No session, no session key (Task 3).
 *
 * Its own query key and its own fetch, because it is the only request in the app
 * that goes out without credentials: sharing it with the authenticated cache
 * would put a public document behind a key that also serves private data.
 */

/**
 * Download one report as JSON (Task 3).
 *
 * A mutation, not a query, for a reason worth stating: the result is a file, not
 * state. Caching it would put a report document in the query cache - which is
 * in memory, and would keep a whole billing document alive after the tab that
 * downloaded it is gone. `downloadJson` writes the file as a side effect and
 * returns the payload, and nothing keeps it.
 *
 * It invalidates nothing, correctly: a download does not change anything, and
 * the report it fetched is identical to what the list already describes.
 */
export function useDownloadReport() {
  const { downloadText } = usePrivateApi()
  return useMutation({mutationFn: (report: SavedReport) => downloadText(`/api/reports/${report.id}/print.html`, `${report.name.replace(/[^a-zA-Z0-9_-]/g,'-') || 'cost-report'}.html`, 'text/html')})
}

/**
 * The check-history CSV export (Task 3).
 *
 * The page used to render this as `<a href>` and it answered 401 to every
 * signed-in user - see `downloadJson` for the measurement and the reason (the
 * session token is in sessionStorage, so a navigation cannot carry it). Routing
 * it through the same authenticated download is the fix, and the filename is the
 * check's own date, not today's: the file is the check, and two exports a month
 * apart should not look like the same file.
 */
export function useDownloadCheckCsv() {
  const { downloadText } = usePrivateApi()
  return useMutation({
    mutationFn: (check: CheckSummary) =>
      downloadText(
        `/api/checks/${check.id}/export.csv`,
        `${check.created_at.slice(0, 10)}-findings.csv`,
      ),
  })
}

/**
 * Archive or restore a saved report (Task 3).
 *
 * Archiving is a soft delete, and the interesting part is what it does to a
 * share link: the public lookup refuses an archived report, so archiving is the
 * revocation path for a link that has already been sent. That is the reason this
 * is a PATCH and not a DELETE - the row has to survive for the token to be
 * found and refused.
 *
 * A toggle rather than two hooks, because the two directions are one field:
 * `archived_at` set, or cleared. Archived reports stay in the list (the page
 * already fetches `include_archived=true`) and the button reads "Restore", so
 * archiving is not a one-way door the user cannot see.
 */
export function useRenameReport() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => {
      if (!name.trim()) throw new Error('Name is required')
      return apiFetch<SavedReport>(`/api/reports/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      })
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.reports.root }) },
  })
}

export function useArchiveReport() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiFetch<SavedReport>(`/api/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived_at: archived ? new Date().toISOString() : null }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.reports.root })
    },
  })
}

export function useDeleteReport() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/reports/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.reports.root })
    },
  })
}



// --- AWS connections (Task H) ---------------------------------------------

/** The body for creating a connection. `external_id` is write-only - there is
 *  no read path for it, and there is deliberately no PATCH. */
export interface AwsConnectionInput {
  role_arn: string
  external_id: string
  bucket: string
  prefix?: string
  region?: string
}

/**
 * Register a connection.
 *
 * The response carries the row *and* the test result, and the row is saved even
 * when the test fails. So a failed create is a resolved promise with
 * `test.ok === false`, not a rejection - `mutateAsync` does not throw and the
 * caller must read `test.hint`. A caller that only checks for a throw will
 * report success for a connection that does not work.
 */

/**
 * Re-run the connection test. Same contract as create: `ok: false` arrives as a
 * 200, not a rejection.
 */

/**
 * Sync a connection: download every new CUR file and queue a check over them.
 *
 * The body is the three-field contract (Feature 3) - optional LastModified
 * date filters and the skip-ingested toggle. Invalidates the checks list (a
 * real sync queued one) and the connections list (nothing on the row changes,
 * but the toast the caller shows is the response's own message, so the caller
 * needs no stale-state repair at all).
 */

/**
 * Disconnect. Soft, and not reversible through the API: the backend has no PATCH
 * on a connection's identity and no hard delete, so "undo" means registering a
 * new one. The UI says so rather than offering a Reconnect button that would
 * have to lie.
 */

/**
 * Reconnect a disconnected AWS connection (live-testing Task 2). The server
 * clears the disconnect stamp *and* the stale test verdict - the status badge
 * returns to "never" until the next Test - so the invalidated list is the
 * whole story: there is no client-side patch to apply on top of it.
 */

export function useUpdateSettings() {
  const { apiFetch } = usePrivateApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<TenantSettings>) =>
      apiFetch<TenantSettings>('/api/settings/tenant', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.settings.root })
    },
  })
}



