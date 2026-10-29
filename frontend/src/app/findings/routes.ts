/**
 * URL builders for the findings pages (live-testing Task 1).
 *
 * The URL is the source of truth for which check the findings page shows, so
 * every control that changes it - the check selector, the show-all toggle,
 * every row's check link - builds its target through these functions rather
 * than by hand. One place knows the shape; the tests assert the shape here
 * rather than through a click the DOM-free suite cannot make.
 *
 * These live outside `page.tsx` on purpose: a page file must export only
 * components or it breaks React fast refresh, and `detector-types.ts` next
 * door is the established home for a page-adjacent module of pure functions.
 */

/**
 * `/findings?check=<id>` with every other parameter (severity, search, ...)
 * preserved. `null` means "no check chosen": the parameter is removed rather
 * than guessed, and the page re-resolves its default on render.
 *
 * `all` is always dropped: `?check=<id>&all=1` is two answers to one
 * question, and the API would silently answer only the `all` half.
 */
export function checkRoute(checkId: string | null, base?: URLSearchParams): string {
  const params = new URLSearchParams(base ?? '')
  params.delete('all')
  params.delete('offset')
  if (checkId) params.set('check', checkId)
  else params.delete('check')
  const qs = params.toString()
  return qs ? `/findings?${qs}` : '/findings'
}

/**
 * `/findings?all=1` - history mode - with every other parameter preserved and
 * the `check` parameter removed, for the same reason `checkRoute` drops
 * `all`: the two modes are exclusive and the URL must not claim both.
 */
export function allRoute(base?: URLSearchParams): string {
  const params = new URLSearchParams(base ?? '')
  params.delete('check')
  params.delete('offset')
  params.set('all', '1')
  return `/findings?${params.toString()}`
}
