/**
 * Chip identities and display helpers for the baseline picker (Features 4/6).
 *
 * Pure functions in their own module because a `.tsx` file that mixes
 * components with plain exports silently disables React Fast Refresh - the
 * symptom ("my change did nothing until I reloaded") reads as a stale build
 * cache, and the rule is cheaper than the debugging.
 */

export interface BaselineChip {
  /** Stable identity: the same selection twice is the same chip, not two. */
  key: string
  /** What the user reads. */
  label: string
  /** 'upload' = a library row; 'file' = a device file riding along. */
  kind: 'upload' | 'file'
  /** The library id, when kind is 'upload'. */
  uploadId?: string
  /** The File, when kind is 'file'. */
  file?: File
}

export function chipFromUpload(upload: { id: string; filename: string }): BaselineChip {
  return { key: `upload:${upload.id}`, label: upload.filename, kind: 'upload', uploadId: upload.id }
}

export function chipFromFile(file: File): BaselineChip {
  // Keyed on name AND size, not name alone: two months' exports both called
  // export.csv - the normal state of an AWS downloads folder - would collide
  // on a name-only key, and the picker would deselect-and-reselect instead
  // of deduplicating.
  return { key: `file:${file.name}:${file.size}`, label: file.name, kind: 'file', file }
}

/**
 * Merge selections without duplicates, newest last. A chip already present
 * (same identity) is not added twice - choosing the same library file from
 * the picker twice is one baseline, and ingesting it twice would halve
 * every finding.
 */
export function mergeChips(existing: BaselineChip[], added: BaselineChip[]): BaselineChip[] {
  const seen = new Set(existing.map((c) => c.key))
  const out = [...existing]
  for (const chip of added) {
    if (seen.has(chip.key)) continue
    seen.add(chip.key)
    out.push(chip)
  }
  return out
}

/** The span a file covers, as one readable string - or the honest "no date
 * range" (D-116: a blank in a column where every other row has dates reads
 * as a layout bug; the string is what the user can act on). */
export function describeSpan(min: string | null, max: string | null): string {
  if (!min || !max) return 'no date range'
  return `${min} → ${max}`
}

/** Binary units with the decimal dropped above ten: 128.0 MB implies a
 * precision a file size does not have. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const text = value >= 10 || Number.isInteger(value) ? `${Math.round(value)}` : value.toFixed(1)
  return `${text} ${units[unit]}`
}
