import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/page-states'
import type { Plan } from '@/lib/types'

export function EntitlementStatus({ plan, error, onRetry, busy = false }: {
  plan?: Plan | null; error?: unknown; onRetry: () => void; busy?: boolean
}) {
  if (error) return <ErrorState title="Could not verify plan access" error={error} onRetry={onRetry} isRetrying={busy} />
  if (!plan) return <p role="status" className="text-body text-muted-foreground">Verifying plan access…</p>
  const access = plan.entitlement
  const label = access?.source === 'operator' ? plan.tier === 'owner' ? 'Owner plan' : 'Operator access' : plan.tier === 'trial' ? 'Seven-day Trial' : 'Access'
  const expiry = access?.ends_at ? new Date(access.ends_at) : null
  const readableExpiry = expiry && Number.isFinite(expiry.getTime()) ? new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(expiry) : null
  if (access?.state === 'active') return access.ends_at ? (
    <p className="text-caption text-muted-foreground">{label} ends {readableExpiry
      ? <time dateTime={access.ends_at}>{readableExpiry}</time> : 'at an unverified time'}.
      {' '}Access must still be active when you submit new work.</p>
  ) : access.source === 'operator' ? <p className="text-caption text-muted-foreground">{label} is active.</p> : null
  return <div role="status" className="space-y-3 rounded-md border border-border p-4">
    <p className="text-body font-medium">{access?.state === 'expired' ? 'Trial expired' : access?.state === 'pending' ? 'Purchase pending' : access?.state === 'not_started' ? 'Trial has not started' : 'No active plan access'}</p>
    <p className="text-body text-muted-foreground">{access?.recovery ?? 'Plan access is unverified. Retry verification before submitting work.'}</p>
    {access?.starts_at && <p className="text-caption">Starts {access.starts_at}</p>}
    {access?.ends_at && <p className="text-caption">Ends {access.ends_at} (exclusive)</p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" loading={busy} onClick={onRetry}>Retry verification</Button>
      <p className="text-caption text-muted-foreground">Subscription offers are currently unavailable.</p>
    </div>
  </div>
}
