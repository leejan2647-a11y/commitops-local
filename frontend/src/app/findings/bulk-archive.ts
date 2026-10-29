export function cutoffError(value: string, today = new Date().toISOString().slice(0, 10)): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Choose a cutoff date.'
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return 'Choose a valid cutoff date.'
  if (value > today) return 'The cutoff cannot be in the future (UTC).'
}
