/**
 * Naming the report file (Task 3).
 *
 * The spec asks for `<report-name>-<date>.json`, and the browser is what writes
 * the file - the API serves JSON and has no opinion about names, because it
 * does not know its own public hostname and, more to the point, does not know
 * which of the tenant's checks the reader will look at first. So the name lives
 * here, next to the click that uses it.
 *
 * The sanitising is not decoration. A report name is the tenant's own text and
 * it lands in a filename the browser will act on, so the three classes of damage
 * are handled rather than trusted:
 *
 * - path separators: a name of `../../etc/passwd` must not escape the
 *   downloads directory it lands in.
 * - quotes and backslashes: these terminate the `filename="..."` parameter the
 *   browser reconstructs, so an unescaped one lets a name inject a second
 *   parameter - `a"; src="https://evil/` is a name, and a hijacked download.
 * - CR/LF: a newline in a name is header injection the moment it reaches a
 *   Content-Disposition, and is a filename the filesystem may reject outright.
 *
 * Everything outside a conservative set collapses to a dash, runs of dashes
 * collapse, and the result is capped - a 300-character name is not a name anyone
 * can find in a downloads folder, and it is one more thing to get wrong on some
 * filesystem.
 */

const MAX_NAME = 80;

/** The slug a report name becomes. Never empty: callers get `report`. */
export function reportNameSlug(reportName: string): string {
  const slug = reportName
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '');
  return slug.slice(0, MAX_NAME).replace(/[-. ]+$/g, '') || 'report';
}

/**
 * `<report-name>-<date>.json`.
 *
 * @param generatedAt ISO timestamp from the payload. The *generation* date, not
 *   today's: a report downloaded next month should say when the report was
 *   made, which is the date a reader comparing two files needs.
 */
export function reportFilename(reportName: string, generatedAt: string): string {
  const date = isoDate(generatedAt);
  return `${reportNameSlug(reportName)}-${date}.json`;
}

/** `2026-10-01` from an ISO timestamp, without a Date round trip.
 *
 * The payload's timestamps are UTC with a `Z`, so the date part of the string is
 * already the date. Slicing it avoids the local-timezone shift that
 * `new Date(...).toISOString().slice(0, 10)` cannot have but
 * `new Date(...).toLocaleDateString()` can - and where that shift would put
 * yesterdays date on a file. An unparseable value falls back to the raw string
 * trimmed, so the file still has a date-shaped tail rather than `Invalid Date`.
 */
function isoDate(generatedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(generatedAt);
  if (match) return match[1];
  return generatedAt.slice(0, 10).replace(/[^0-9A-Za-z-]/g, '') || 'unknown-date';
}