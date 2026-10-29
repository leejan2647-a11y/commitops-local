import { useRef, useState } from 'react'
import { FileUp, Library, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState } from '@/components/page-states'
import { ListSkeleton, RefreshingIndicator } from '@/components/page-skeleton'
import { ApiError } from '@/lib/api'
import { useCreateUpload, useDeleteUpload, useUploads, useRetention, usePlan } from '@/lib/queries'
import { formatPlanBytes, primaryFilesError } from '@/lib/plan-limits'
import { formatDateTime } from '@/lib/utils'
import type { Upload } from '@/lib/types'

export function FileLibrary() {
  const [filters, setFilters] = useState({ search: '', from: '', to: '' })
  const [offset, setOffset] = useState(0)
  const dateProblem = filters.from && filters.to && filters.from > filters.to
    ? 'The covered date from must be on or before the covered date to.' : null
  // The management library includes unknown date spans; the comparison
  // picker's stricter known-dates behavior remains its existing default.
  const library = useUploads(filters.search, filters.from, filters.to, !dateProblem, offset, false)
  const create = useCreateUpload()
  const retention = useRetention()
  const plan = usePlan()
  const remove = useDeleteUpload()
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [inputVersion, setInputVersion] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<Upload | null>(null)
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null)
  const uploading = useRef(false)
  const deletingNow = useRef(false)
  const changeFilter = (key: keyof typeof filters, value: string) => {
    setFilters(current => ({ ...current, [key]: value })); setOffset(0)
  }
  const upload = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (uploading.current || uncertain) return
    setProblem(null); setNotice('')
    if (!file) { setProblem('Choose one file to store.'); return }
    const preflight = primaryFilesError([file], plan.data)
    if (preflight) { setProblem(preflight); return }
    uploading.current = true
    try {
      await create.mutateAsync({ file, source: 'manual', description: description.trim() })
      setFile(null); setDescription(''); setInputVersion(value => value + 1); setOffset(0)
      setNotice('File stored in the library. No check was started.')
    } catch (error) {
      const unknownResult = error instanceof ApiError && (error.kind === 'network' || (error.status !== null && error.status >= 500))
      setUncertain(unknownResult)
      setProblem(`${error instanceof Error ? error.message : String(error)}${unknownResult ? ' The file may already have been stored. Refresh the library and check for it before uploading again.' : ''}`)
    } finally { uploading.current = false }
  }
  const refresh = async () => {
    if (dateProblem) return
    const result = await library.refetch()
    if (!result.error) setUncertain(false)
  }
  const deleteFile = async () => {
    if (!deleting || deletingNow.current) return
    deletingNow.current = true; setDeleteProblem(null)
    try {
      await remove.mutateAsync(deleting.id)
      setDeleting(null); setOffset(0); setNotice('File removed from the library. Saved checks and accepted check usage are unchanged.')
    } catch (error) { setDeleteProblem(error instanceof Error ? error.message : String(error)) }
    finally { deletingNow.current = false }
  }
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><Library className="h-5 w-5 text-accent" aria-hidden="true" />File library</CardTitle>
      <CardDescription>One library for manual check files and files added directly. Identical retained content is reused; adding a file does not run a check.</CardDescription></CardHeader>
    <CardContent className="space-y-6">
      <form aria-label="Store library file" className="space-y-4 rounded-lg border border-dashed border-border p-4" onSubmit={event => void upload(event)}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="library-upload-file" label="CUR file" hint="One CSV, compressed CSV or Parquet file" required>{control => <Input {...control} key={inputVersion} type="file" accept=".csv,.csv.gz,.gz,.parquet" disabled={create.isPending} onChange={event => setFile(event.target.files?.[0] ?? null)} />}</Field>
          <Field id="library-upload-purpose" label="Description (optional)" hint="Why are you keeping this file? Up to 500 characters.">{control => <Input {...control} value={description} maxLength={500} disabled={create.isPending} onChange={event => setDescription(event.target.value)} placeholder="For example: March comparison export" />}</Field>
        </div>
        <p className="text-caption text-muted-foreground">Library uploads and inspections alone do not use checks. Selecting Library files for an accepted analysis uses one check regardless of primary file count. Technical file and processing safety limits still apply. Add comparison history with the baseline picker in Check Charges. Deleting a file does not refund an accepted check.</p>
        {problem && <p role="alert" className="text-body text-danger">{problem}</p>}
        <div className="flex flex-wrap gap-3"><Button type="submit" loading={create.isPending} loadingLabel="Storing file" disabled={uncertain}><FileUp className="h-4 w-4" aria-hidden="true" />Store file in library</Button>
          {uncertain && <Button type="button" variant="outline" loading={library.isFetching} disabled={!!dateProblem} onClick={() => void refresh()}>Refresh library before retrying</Button>}</div>
      </form>
      <p className="text-body text-muted-foreground" role="status">{retention.data?.retention_days === -1 ? 'Library files have no automatic expiry under the Owner plan. Keep your own backup.' : retention.data?.retention_days != null ? `Library files are retained for ${retention.data.retention_days} days from upload, under your current plan. After expiry, their source files are removed and history depending on them may become unavailable. Keep your own copy.` : 'Library files follow your plan retention policy. The current retention window is unavailable; no expiry date is assumed. Keep your own copy.'}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="library-search" label="Search filenames">{control => <Input {...control} value={filters.search} onChange={event => changeFilter('search', event.target.value)} />}</Field>
        <Field id="library-from" label="Covered date from">{control => <Input {...control} type="date" value={filters.from} onChange={event => changeFilter('from', event.target.value)} />}</Field>
        <Field id="library-to" label="Covered date to" error={dateProblem ?? undefined}>{control => <Input {...control} type="date" value={filters.to} onChange={event => changeFilter('to', event.target.value)} />}</Field>
      </div>
      <p className="text-caption text-muted-foreground">Date filters match a file's covered period, not when it was uploaded. Files with unknown dates remain listed.</p>
      {dateProblem ? null : library.error ? <ErrorState error={library.error} title="Could not load file library" onRetry={() => void refresh()} isRetrying={library.isFetching} />
        : library.isPending ? <ListSkeleton label="Loading file library" />
        : !library.data?.length ? <EmptyState icon={Library} title="No matching library files" description="Store a file above or change the filename and covered-date filters." />
        : <><RefreshingIndicator show={library.isFetching} /><Table><TableHeader><TableRow>{['File', 'Size', 'Covered period', 'Description / source', 'Stored', 'Actions'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{library.data.map(item => <TableRow key={item.id}>
            <TableCell><span className="break-all font-medium">{item.filename}</span><span className="block text-caption text-muted-foreground">{item.row_count == null ? 'Row count unavailable' : `${item.row_count.toLocaleString()} rows`}</span></TableCell>
            <TableCell className="whitespace-nowrap font-mono">{formatPlanBytes(item.size_bytes)}</TableCell>
            <TableCell className="whitespace-nowrap">{item.min_date && item.max_date ? `${item.min_date} – ${item.max_date}` : 'Dates unavailable'}</TableCell>
            <TableCell><span className="block break-words">{item.description || 'No description'}</span><span className="text-caption text-muted-foreground">{item.origins?.length ? item.origins.map(origin => origin === 'library' ? 'Added to Library' : 'Manual check file').join(' · ') : item.source === 's3_sync' ? 'Automatic AWS file' : 'Previously stored file'}{item.source === 'baseline_only' ? ' · Comparison / baseline' : ''}</span></TableCell>
            <TableCell className="whitespace-nowrap">{formatDateTime(item.created_at)}</TableCell>
            <TableCell><Button variant="ghost" onClick={() => { setDeleting(item); setDeleteProblem(null) }} aria-label={`Delete library file ${item.filename}`}><Trash2 className="h-4 w-4" aria-hidden="true" />Delete</Button></TableCell>
          </TableRow>)}</TableBody></Table></>}
      {library.pagination && !dateProblem && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-caption text-muted-foreground">{library.pagination.total === 0 ? '0 files' : `Files ${library.pagination.offset + 1}–${library.pagination.offset + library.pagination.returned} of ${library.pagination.total}`}</p><div className="flex gap-2"><Button variant="outline" disabled={offset === 0 || library.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous files</Button><Button variant="outline" disabled={!library.pagination.has_more || library.isFetching} onClick={() => setOffset(offset + library.pagination!.returned)}>Next files</Button></div></div>}
      {notice && <p role="status" className="text-body text-success">{notice}</p>}
    </CardContent>
    <Dialog open={!!deleting} onOpenChange={open => { if (!remove.isPending && !open) setDeleting(null) }} title="Delete library file?" description={`Remove ${deleting?.filename ?? 'this file'}? Completed findings and reports remain; usage is not refunded. In-use files cannot be deleted.`}>
      {deleteProblem && <p role="alert" className="mb-4 text-danger">{deleteProblem}</p>}<Button variant="danger" loading={remove.isPending} loadingLabel="Deleting" onClick={() => void deleteFile()}>Confirm delete file</Button>
    </Dialog>
  </Card>
}
