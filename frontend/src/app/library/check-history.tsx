import { Link } from 'react-router-dom'
import { useChecks } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { CheckHistoryMore } from '@/components/check-history-more'
import { ErrorState } from '@/components/page-states'
import { ListSkeleton } from '@/components/page-skeleton'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** A view of the same query/check records used by Reports and the other pages. */
export function LibraryCheckHistory() {
  const checks = useChecks()
  return <Card><CardHeader><CardTitle>Check history</CardTitle><CardDescription>All local manual checks. Reports, Findings and Dashboard read these same saved checks; viewing them here creates no copies.</CardDescription></CardHeader>
    <CardContent>
      {checks.error ? <ErrorState error={checks.error} onRetry={() => void checks.refetch()} /> : checks.isPending ? <ListSkeleton label="Loading check history" /> : checks.data?.length ? <Table>
        <TableHeader><TableRow>{['Check', 'Origin', 'Window', 'Status', 'Saved'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{checks.data.map(check => <TableRow key={check.id}>
          <TableCell><Link className="underline" to={check.status === 'completed' ? `/findings?check=${encodeURIComponent(check.id)}${check.archived_at ? '&archived=1' : ''}` : '/reports'}>{check.id.slice(0, 8)}</Link></TableCell>
          <TableCell>Manual check</TableCell><TableCell>{check.window_start && check.window_end ? `${check.window_start} – ${check.window_end}` : 'Dates unavailable'}</TableCell>
          <TableCell>{check.status}{check.archived_at ? ' · Archived' : ''}</TableCell><TableCell>{formatDateTime(check.created_at)}</TableCell>
        </TableRow>)}</TableBody>
      </Table> : <p className="text-body text-muted-foreground">No checks yet. Run a manual check from Check Charges.</p>}
      <CheckHistoryMore query={checks} />
    </CardContent></Card>
}
