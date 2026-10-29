import { CheckHistoryMore } from '@/components/check-history-more'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { useChecks } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'

/** A scope selector only: amounts still come from the selected check's API. */
export function CheckScopePicker({ id, query, selected, onChange, disabled = false }: {
  id: string
  query: ReturnType<typeof useChecks>
  selected?: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const eligible = (query.data ?? []).filter(check => check.status === 'completed' && !check.archived_at)
  return <div className="space-y-2">
    <Field id={id} label="Check" className="max-w-xl">
      {control => <Select {...control} value={selected ?? ''} disabled={disabled || query.isPending}
        onChange={event => onChange(event.target.value)}>
        <option value="">Latest completed check</option>
        {selected && !eligible.some(check => check.id === selected) &&
          <option value={selected}>Requested check {selected}</option>}
        {eligible.map(check => <option key={check.id} value={check.id}>
          {formatDateTime(check.created_at)} · {check.window_start} → {check.window_end} · {check.id.slice(0, 8)}
        </option>)}
      </Select>}
    </Field>
    {query.isPending && <p role="status" className="text-caption text-muted-foreground">Loading check choices…</p>}
    {query.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-danger">
      Check choices could not be loaded. The requested scope is unchanged.
      <Button variant="outline" size="sm" loading={query.isRefetching} onClick={() => void query.refetch()}>Retry check choices</Button>
    </div>}
    <CheckHistoryMore query={query} />
  </div>
}
