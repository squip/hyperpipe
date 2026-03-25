export function shortId(value: string | null | undefined, size = 8): string {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  if (raw.length <= size * 2) return raw
  return `${raw.slice(0, size)}…${raw.slice(-size)}`
}

export function clampList<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  return items.slice(0, max)
}

export function normalizeBool(value: string): boolean {
  const lower = value.trim().toLowerCase()
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'y' || lower === 'on'
}

export function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
