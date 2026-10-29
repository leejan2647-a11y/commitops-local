import { Button } from '@/components/ui/button'
export function CheckHistoryMore({ query }: { query: { hasNextPage?: boolean; isFetchingNextPage?: boolean; fetchNextPage?: () => unknown; data?: unknown[]; isFetchNextPageError?: boolean } }) {
  if (!query.hasNextPage) return null
  return <div className="mt-3 flex items-center gap-3"><span className="text-caption text-muted-foreground">Showing {query.data?.length ?? 0} checks. Older checks are available.</span><Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage?.()}>{query.isFetchingNextPage ? 'Loading older checks...' : query.isFetchNextPageError ? 'Retry older checks' : 'Load older checks'}</Button></div>
}
