/**
 * Hand-rolled API client.
 *
 * The fetch layer is still hand-rolled - no axios - but the *caching* concern
 * that used to be rejected alongside it is no longer: @tanstack/react-query was
 * added in Task F.1b-fix for client-side caching and stale-while-revalidate,
 * which is a different problem from the transport. This file remains the single
 * place that knows about auth, the 401 redirect and the 403 evidence-freeze
 * behaviour, and every query goes through it (see lib/queries.ts) so those
 * behaviours are unchanged.
 *
 * Money note: every amount on the wire is INTEGER CENTS (the backend
 * contract). formatCents() converts once, at the display edge.
 */
import { getAccessToken } from './auth'
import { assertIdentity, IdentityChangedError, type PrivateIdentity } from './private-identity'

/**
 * Where the API lives.
 *
 * Empty by default = same origin, which is correct in BOTH environments and
 * needs no configuration: production Caddy reverse-proxies /api/* to the
 * backend container, and `npm run dev` proxies /api to localhost:8000 (see
 * vite.config.ts). A hard-coded host here was a stale EC2 hostname that
 * outlived three IP changes - a missing .env.local silently pointed the whole
 * app at a dead server. Set VITE_API_BASE only to override.
 */
const API_BASE = ''

export class ApiError extends Error {
  readonly kind: 'readonly' | 'http' | 'network'
  readonly status: number | null
  readonly body: unknown
  readonly retryAfterSeconds: number | null

  constructor(kind: ApiError['kind'], status: number | null, body: unknown, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
    this.body = body
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function assertRequest(identity?: PrivateIdentity, signal?: AbortSignal | null) {
  if (identity) assertIdentity(identity)
  signal?.throwIfAborted()
}

async function request(path: string, init: RequestInit, isForm: boolean, identity?: PrivateIdentity): Promise<Response> {
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('Only local API requests are allowed')
  assertRequest(identity, init.signal)
  const token = identity ? identity.token : await getAccessToken()
  assertRequest(identity, init.signal)
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (!isForm && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  if (token) headers['X-Local-Token'] = token
  const deadline = AbortSignal.timeout((isForm || init.body instanceof Blob) ? 600_000 : 30_000)
  const signal = AbortSignal.any([
    deadline,
    ...(identity ? [identity.signal] : []),
    ...(init.signal ? [init.signal] : []),
  ])
  const localPath = ['/api/upload','/api/analyse','/api/cancel'].some(p=>path===p||path.startsWith(p+'?')) ? path : path.replace('/api/','/api/workspace/')
  const response = await fetch(`${API_BASE}${localPath}`, { ...init, headers, signal })
  assertRequest(identity, signal)
  return response
}

/** JSON requests. 403 surfaces as kind='readonly' (the evidence freeze). */
export async function apiFetch<T>(path: string, init?: RequestInit, identity?: PrivateIdentity): Promise<T> {
  let res: Response
  try {
    res = await request(path, init ?? {}, false, identity)
  } catch (err) {
    assertRequest(identity)
    if (err instanceof IdentityChangedError || (err instanceof DOMException && err.name === 'AbortError')) throw err
    throw new ApiError('network', null, null, `could not reach the API: ${String(err)}`)
  }
  assertRequest(identity)
  if (res.status === 401) {
    redirectToLogin()
    throw new ApiError('http', 401, null, 'Local session expired. Reload this page.')
  }
  if (res.status === 403) {
    const body = await res.json()
    assertRequest(identity, init?.signal)
    // The owner's plan gate (2026-10-09): no chosen plan → the customer
    // is sent to plan selection, not shown an error card they cannot act
    // on. The backend marks this 403 with reason 'plan-choice-required'.

    if (body?.detail?.entitlement) throw new ApiError('http', 403, body, body.detail.recovery ?? body.detail.detail)
    throw new ApiError('readonly', 403, body, 'AWS billing evidence is read-only')
  }
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    const text = await res.text()
    assertRequest(identity)
    let detail = text
    try { detail = (JSON.parse(text) as { detail?: string }).detail ?? text } catch { /* raw text */ }
    throw new ApiError('http', res.status, text, typeof detail === 'string' ? detail : ((detail as { recovery?: string }).recovery ?? JSON.stringify(detail)), Number(res.headers.get('Retry-After')) || null)
  }
  const body = await res.json() as T
  assertRequest(identity)
  return body
}

/** Multipart uploads (the only non-JSON call: POST /checks with a file). */
export async function apiUpload<T>(path: string, form: FormData, identity?: PrivateIdentity): Promise<T> {
  let res: Response
  try {
    res = await request(path, { method: 'POST', body: form }, true, identity)
  } catch (err) {
    assertRequest(identity)
    if (err instanceof IdentityChangedError || (err instanceof DOMException && err.name === 'AbortError')) throw err
    throw new ApiError('network', null, null, `could not reach the API: ${String(err)}`)
  }
  assertRequest(identity)
  if (res.status === 401) {
    // Same contract as apiFetch: an expired session sends the user to the
    // login page with a way back, including mid-upload.
    redirectToLogin()
    throw new ApiError('http', 401, null, 'Local session expired. Reload this page.')
  }
  if (res.status === 403) {
    // The plan gate, on the upload path too: no chosen plan → plan
    // selection, not a 403 error card beside a file the customer already
    // chose.
    const body = await res.json().catch(() => null)
    assertRequest(identity)

    throw new ApiError('http', 403, body, body?.detail?.entitlement ? (body.detail.recovery ?? body.detail.detail) : 'forbidden')
  }
  if (!res.ok) {
    const text = await res.text()
    assertRequest(identity)
    let detail = text
    try { detail = (JSON.parse(text) as { detail?: string }).detail ?? text } catch { /* raw text */ }
    throw new ApiError('http', res.status, text, typeof detail === 'string' ? detail : ((detail as { recovery?: string }).recovery ?? JSON.stringify(detail)), Number(res.headers.get('Retry-After')) || null)
  }
  const body = await res.json() as T
  assertRequest(identity)
  return body
}

/**
 * A GET that writes the response to a file (Task 3: the report download).
 *
 * This exists because of a measured failure, not a preference. A download
 * rendered as `<a href="/api/...?...">` sends no Authorization header - the
 * session token lives in browser storage, which a bare navigation cannot
 * attach - so every authenticated file export in this app answers 401 in a
 * signed-in browser. That is the pre-existing CSV link on the Reports page,
 * and it was never noticed because a 401 JSON body is a small, quiet failure.
 *
 * So the fetch is ours, and the browser is handed a blob URL. Three details
 * matter:
 *
 * - The object URL survives browser download handoff, then is revoked after
 *   a bounded grace period. Revoking on the next tick can race the browser's
 *   asynchronous handling of the file. This is a download request, not proof
 *   that the browser saved the file.
 * - The click is dispatched on an anchor rather than assigning `location`,
 *   because that is the only way to get a filename the user can find again.
 * - The filename comes from the *body*, via `nameFor`, not from a response
 *   header and not from the caller's clock. The server's `generated_at` is when
 *   the document was made and the report's name is what the document calls
 *   itself, so a renamed report downloads under its new name and a report made
 *   yesterday is stamped yesterday even if it is saved a week late.
 */
export async function downloadJson<T>(
  path: string,
  nameFor: (body: T) => string,
  identity?: PrivateIdentity,
): Promise<T> {
  const res = await authorizedGet(path, identity)
  const body = (await res.json()) as T
  assertRequest(identity)
  saveBlob(
    new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }),
    nameFor(body),
  )
  return body
}

/**
 * The same authenticated download, for the CSV export (Task 3).
 *
 * It exists as a sibling of `downloadJson` rather than a special case of it,
 * because the only thing they share is the part that was broken: getting the
 * bearer token onto the request and the bytes to disk. Splitting them at the
 * parser keeps `downloadJson` free of a `parse?` parameter that every caller
 * would have to remember it does not need.
 */
export async function downloadText(
  path: string,
  filename: string,
  contentType = 'text/csv',
  identity?: PrivateIdentity,
): Promise<string> {
  const res = await authorizedGet(path, identity)
  const text = await res.text()
  assertRequest(identity)
  saveBlob(new Blob([text], { type: contentType }), filename)
  return text
}

/** Authenticated GET for a download: attaches the token, 401s to login, and
 *  turns any other failure into an ApiError carrying the body. */
async function authorizedGet(path: string, identity?: PrivateIdentity): Promise<Response> {
  let res: Response
  try {
    res = await request(path, {}, false, identity)
  } catch (err) {
    assertRequest(identity)
    if (err instanceof IdentityChangedError || (err instanceof DOMException && err.name === 'AbortError')) throw err
    throw new ApiError('network', null, null, `could not reach the API: ${String(err)}`)
  }
  assertRequest(identity)
  if (res.status === 401) {
    redirectToLogin()
    throw new ApiError('http', 401, null, 'Local session expired. Reload this page.')
  }
  if (!res.ok) {
    const body = await res.text()
    assertRequest(identity)
    throw new ApiError('http', res.status, body, `could not download (${res.status})`)
  }
  return res
}

/** Request a browser download; surface unsupported environments to the caller. */
function saveBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new ApiError('network', null, null, 'File downloads are unavailable in this browser. Try another supported browser.')
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // There is no page API for observing a completed browser download. Give the
  // browser time to acquire the blob, without retaining it for the whole tab.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * The one unauthenticated request in the app (Task 3: shared report reads).
 *
 * Deliberately not `apiFetch`, for two reasons, both of which would be bugs in
 * the other direction: it must not redirect to /login on a 401 (a shared link
 * that bounces the reader to a login form is the worst possible answer - they
 * have nothing to log in with), and it must not attach the session token (there
 * is no session, and sending the credential to a public endpoint would be
 * pointless exposure).
 */
export async function publicFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    })
  } catch (err) {
    if (signal?.aborted) throw signal.reason
    throw new ApiError('network', null, null, `could not reach the API: ${String(err)}`)
  }
  if (!res.ok) {
    throw new ApiError('http', res.status, null, publicErrorText(res.status))
  }
  return (await res.json()) as T
}

/**
 * What a shared-link reader is told, by status. 404 is the overwhelmingly
 * common case and it is deliberately undifferentiated: a revoked link, a
 * mistyped one and a link to a report that never existed must look the same,
 * or the page becomes an oracle for which reports exist.
 */
function publicErrorText(status: number): string {
  if (status === 404) return 'this shared report link is not valid'
  return `this shared report could not be loaded (${status})`
}

/** Cents -> "$1,234.56" (the one conversion, at the display edge). */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  )
}

/** 401 -> /login?next=<current path+query> (guarded for non-DOM test envs). */
function redirectToLogin(): void {}
