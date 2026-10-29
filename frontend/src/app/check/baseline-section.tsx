/**
 * The "Compare with previous data" section of the check page (Features 4/6).
 *
 * Everything below the toggle: the two ways to choose history (the tenant's
 * library, or files from this device), the chips that show what was chosen,
 * and the library dialog with its search and covered-date filters.
 *
 * Props-driven and exported so the SSR tests can render the branches a click
 * would reach (`renderToStaticMarkup` cannot click a toggle): the closed
 * state, the open-with-selection state, and the empty library.
 */
import { useState } from 'react'
import { FileUp, FolderOpen, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { Upload } from '@/lib/types'
import type { PageInfo } from '@/lib/queries'
import {
  type BaselineChip,
  chipFromFile,
  chipFromUpload,
  describeSpan,
  formatBytes,
  mergeChips,
} from '@/lib/baseline-chips'

export interface BaselineSectionProps {
  useFiles: boolean
  onUseFilesChange: (v: boolean) => void
  chips: BaselineChip[]
  onChipsChange: (chips: BaselineChip[]) => void
  /** The library query, gated by the caller on `libraryOpen`. */
  uploads: Upload[]
  uploadsLoading: boolean
  uploadsError: string | null
  /** The dialog's open state, controlled by the page: the page needs it to
   *  gate the uploads query on (`useUploads(..., enabled=libraryOpen)`), and
   *  a state this component hides from its parent is a state the parent
   *  cannot gate anything on. */
  libraryOpen: boolean
  onLibraryOpenChange: (open: boolean) => void
  libraryFilters?: { search: string; from: string; to: string }
  onLibraryFiltersChange?: (filters: { search: string; from: string; to: string }) => void
  pagination?: PageInfo
  onLibraryPageChange?: (offset: number) => void
  onLibraryRetry?: () => void
}

export function BaselineSection({
  useFiles,
  onUseFilesChange,
  chips,
  onChipsChange,
  uploads,
  uploadsLoading,
  uploadsError,
  libraryOpen,
  onLibraryOpenChange,
  libraryFilters, onLibraryFiltersChange, pagination, onLibraryPageChange, onLibraryRetry,
}: BaselineSectionProps) {
  const [localFilters, setLocalFilters] = useState({ search: '', from: '', to: '' })
  const { search, from, to } = libraryFilters ?? localFilters
  const changeFilter = (key: 'search' | 'from' | 'to', value: string) => {
    const next = { search, from, to, [key]: value }
    if (onLibraryFiltersChange) onLibraryFiltersChange(next); else setLocalFilters(next)
  }
  // The picker's working selection: confirmed into `chips` only on Confirm,
  // so a Cancel is a real cancel rather than a "close the box, keep the
  // damage".
  const [picked, setPicked] = useState<Record<string, BaselineChip>>({})

  const openLibrary = () => {
    const empty = { search: '', from: '', to: '' }
    if (onLibraryFiltersChange) onLibraryFiltersChange(empty); else setLocalFilters(empty)
    const carry: Record<string, BaselineChip> = {}
    for (const chip of chips) if (chip.kind === 'upload') carry[chip.key] = chip
    setPicked(carry)
    onLibraryOpenChange(true)
  }

  const confirmLibrary = () => {
    const deviceChips = chips.filter((c) => c.kind === 'file')
    onChipsChange(mergeChips(deviceChips, Object.values(picked)))
    onLibraryOpenChange(false)
  }

  const toggleOff = (next: boolean) => {
    // Turning the toggle OFF discards the selection, on purpose: the payload
    // is built from state, and chips that survived being switched off would
    // be files the user believes they removed and the server would ingest.
    if (!next) onChipsChange([])
    onUseFilesChange(next)
  }

  const invalidRange = Boolean(from && to && from > to)
  const visible = uploads.filter((u) => !invalidRange &&
    u.filename.toLowerCase().includes(search.trim().toLowerCase()) &&
    (!from || Boolean(u.max_date && u.max_date >= from)) &&
    (!to || Boolean(u.min_date && u.min_date <= to)),
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          id="check-use-file-baseline"
          type="checkbox"
          checked={useFiles}
          onChange={(e) => toggleOff(e.target.checked)}
          className="h-4 w-4"
        />
        <label htmlFor="check-use-file-baseline" className="text-body">
          Compare with previous data
        </label>
      </div>

      {useFiles ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={openLibrary}>
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Choose from library
            </Button>
            {/* A label wrapping the input, so the control has a name and the
                whole button-sized target activates the OS file picker. */}
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-2 text-body focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-base">
              <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
              Upload from device
              <input
                type="file"
                multiple
                accept=".csv,.gz,.parquet"
                className="sr-only"
                aria-label="Add baseline files from this device"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length) onChipsChange(mergeChips(chips, files.map(chipFromFile)))
                  // Reset the value so re-choosing the same file still fires
                  // onChange - the picker's quirk, not a choice.
                  e.target.value = ''
                }}
              />
            </label>
          </div>

          {chips.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Selected baseline files">
              {chips.map((chip) => (
                <li key={chip.key}>
                  <Badge variant="neutral" className="gap-1">
                    <span className="max-w-56 truncate">{chip.label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${chip.label} from the baseline`}
                      onClick={() => onChipsChange(chips.filter((c) => c.key !== chip.key))}
                      className="rounded-sm hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-muted-foreground">
              Pick one or more old exports - they become the history this check
              compares against, within the baseline dates above.
            </p>
          )}
        </>
      ) : null}

      <Dialog
        open={libraryOpen}
        onOpenChange={onLibraryOpenChange}
        title="Choose baseline files"
        description="Every file this account has uploaded or synced. Filters match the span a file covers, not when it arrived."
        confirmLabel={`Use ${Object.keys(picked).length} file${Object.keys(picked).length === 1 ? '' : 's'}`}
        onConfirm={confirmLibrary}
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="baseline-search" label="Search">
              {(control) => (
                <Input
                  {...control}
                  placeholder="filename"
                  value={search}
                  onChange={(e) => changeFilter('search', e.target.value)}
                />
              )}
            </Field>
            <Field id="baseline-from" label="Covered from">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={from}
                  onChange={(e) => changeFilter('from', e.target.value)}
                />
              )}
            </Field>
            <Field id="baseline-to" label="Covered to">
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={to}
                  onChange={(e) => changeFilter('to', e.target.value)}
                />
              )}
            </Field>
          </div>

          {invalidRange ? <p role="alert" className="text-body text-danger">Covered from must be on or before Covered to.</p> : null}
          {from || to ? <p className="text-caption text-muted-foreground">Files with unknown dates are excluded while a date filter is set.</p> : null}
          {uploadsError ? (
            <p role="alert" className="text-body text-danger">
              {uploadsError}
              {onLibraryRetry ? <Button variant="secondary" size="sm" onClick={onLibraryRetry}>Retry library</Button> : null}
            </p>
          ) : uploadsLoading ? (
            <p role="status" className="text-body text-muted-foreground">
              Loading the library…
            </p>
          ) : visible.length === 0 ? (
            <p className="text-body text-muted-foreground">
              {uploads.length || search || from || to ? 'No files match these filters. Clear or change the dates and search.' : 'No files yet. Upload a CUR on the check page or sync from AWS and it will be here.'}
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {visible.map((u) => {
                const chip = chipFromUpload(u)
                const checked = Boolean(picked[chip.key])
                return (
                  <li key={u.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-body">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = { ...picked }
                          if (e.target.checked) next[chip.key] = chip
                          else delete next[chip.key]
                          setPicked(next)
                        }}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{u.filename}</span>
                        <span className="block text-caption text-muted-foreground">
                          {describeSpan(u.min_date, u.max_date)} · {formatBytes(u.size_bytes)}
                          {u.row_count ? ` · ${u.row_count.toLocaleString()} rows` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {pagination && onLibraryPageChange ? <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-caption text-muted-foreground">{pagination.total ? `${pagination.offset + 1}–${pagination.offset + pagination.returned}` : '0'} of {pagination.total} matching files</p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={uploadsLoading || pagination.offset === 0} onClick={() => onLibraryPageChange(Math.max(0, pagination.offset - pagination.limit))}>Previous library page</Button>
              <Button variant="secondary" size="sm" disabled={uploadsLoading || !pagination.has_more} onClick={() => onLibraryPageChange(pagination.offset + pagination.limit)}>Next library page</Button>
            </div>
          </div> : null}
          <p className="text-caption text-muted-foreground">
            {Object.keys(picked).length} selected
          </p>
        </div>
      </Dialog>
    </div>
  )
}
