import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkButton } from '@/components/ui/link-button'
import type { CommitmentAssessment as Assessment } from '@/lib/types'

export function CommitmentAssessment({ items = [], compact = false }: { items?: Assessment[]; compact?: boolean }) {
  if (!items.length) return null
  const unique = [...new Map(items.map((a) => [`${a.code}:${a.message}:${a.recovery}:${a.check_id ?? ''}`, a])).values()]
  const reasons = unique.map((a, i) => <div key={i} className="text-body">
    <p>{a.message}{a.count && a.count > 1 ? ` (${a.count} occurrences)` : ''}</p>
    <p className="text-muted-foreground">{a.recovery}</p>
    {a.check_id && <LinkButton variant="link" to={`/check?check=${a.check_id}`}>View check {a.check_id.slice(0, 8)}</LinkButton>}
  </div>)
  return <Card className="border-warning/40" role="status">
    <CardHeader><CardTitle>Commitment measurement is limited</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {compact ? <details>
        <summary className="cursor-pointer text-body">Show missing data and recovery ({unique.length})</summary>
        <div className="mt-3 space-y-3">{reasons}</div>
      </details> : reasons}
      <LinkButton to="/check" variant="secondary">Run a check with complete data</LinkButton>
    </CardContent>
  </Card>
}
