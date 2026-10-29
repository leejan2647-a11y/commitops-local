export interface FileInspection {
  minDate: string
  maxDate: string
  rowCount: number | null
  method: 'local-csv' | 'backend'
}

function validDate(cell: string): string | null {
  const match = cell.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/)
  if (!match) return null
  const date = match[1]
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date : null
}

/** Scan all CSV records in bounded chunks, including unsorted exports.
 * Quotes, escaped quotes, CRLF and embedded newlines survive chunk boundaries.
 * Only header cells and the date cell are retained; billing rows stay local.
 */
export async function inspectFile(file: File, signal?: AbortSignal): Promise<FileInspection> {
  if (file.size > 16 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.csv')) throw new Error('FALLBACK_TO_BACKEND')
  let header: string[] | null = null
  let dateColumn = -1
  let column = 0
  let cell = ''
  let rowDate: string | null = null
  let rowHasContent = false
  let inQuotes = false
  let afterQuote = false
  let atCellStart = true
  let skipLf = false
  let minDate: string | null = null
  let maxDate: string | null = null
  let rowCount = 0
  let headerCells: string[] = []
  const append = (char: string) => {
    if (!header || column === dateColumn) cell += char
  }
  const endCell = () => {
    if (!header) headerCells.push(cell.trim().replace(/^\uFEFF/, '').toLowerCase())
    else if (column === dateColumn) rowDate = validDate(cell)
    column++
    cell = ''
    atCellStart = true
    afterQuote = false
  }
  const endRow = () => {
    endCell()
    if (!header) {
      header = headerCells
      headerCells = []
      dateColumn = header.findIndex((name) =>
        name === 'line_item_usage_start_date' || name === 'lineitem/usagestartdate')
      if (dateColumn < 0) throw new Error('Missing usage start date column in this CSV.')
    } else if (rowHasContent) {
      rowCount++
      if (!rowDate) throw new Error('A CSV row has a missing or invalid usage start date.')
      if (!minDate || rowDate < minDate) minDate = rowDate
      if (!maxDate || rowDate > maxDate) maxDate = rowDate
    }
    column = 0
    rowDate = null
    rowHasContent = false
  }
  const consume = (text: string) => {
    for (const char of text) {
      if (skipLf) {
        skipLf = false
        if (char === '\n') continue
      }
      if (inQuotes) {
        if (char === '"') { inQuotes = false; afterQuote = true }
        else append(char)
        continue
      }
      if (afterQuote && char === '"') {
        append('"')
        inQuotes = true
        afterQuote = false
        continue
      }
      if (char === ',') { rowHasContent = true; endCell(); continue }
      if (char === '\n' || char === '\r') {
        endRow()
        skipLf = char === '\r'
        continue
      }
      if (afterQuote) {
        if (char === ' ' || char === '\t') continue
        throw new Error('Invalid CSV: unexpected text after a quoted field.')
      }
      if (char === '"') {
        if (!atCellStart) throw new Error('Invalid CSV: unexpected quote in a field.')
        inQuotes = true
      } else append(char)
      atCellStart = false
      rowHasContent = true
    }
  }
  const chunkSize = 256 * 1024
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    signal?.throwIfAborted()
    const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer()
    signal?.throwIfAborted()
    consume(decoder.decode(bytes, { stream: true }))
  }
  consume(decoder.decode())
  if (inQuotes) throw new Error('Invalid CSV: unterminated quoted field.')
  if (rowHasContent || column > 0 || cell) endRow()
  if (!minDate || !maxDate) throw new Error('Could not read dates from file.')
  return { minDate, maxDate, rowCount, method: 'local-csv' }
}

export async function inspectFileLocal(file: File) {
  const result = await inspectFile(file)
  return { minDate: result.minDate, maxDate: result.maxDate, usedLocal: true }
}
