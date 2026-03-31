import { getBaseRelayUrl } from './hyperpipe-group-events.js'

function normalizeLoopbackPath(pathname: string): string {
  const trimmed = String(pathname || '').trim()
  if (!trimmed) return '/'
  const collapsed = trimmed.replace(/\/+$/, '')
  return collapsed || '/'
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = String(hostname || '').trim().toLowerCase()
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
}

export function normalizeGroupScopeRelay(relay?: string | null): string {
  const trimmed = String(relay || '').trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (isLoopbackHostname(parsed.hostname)) {
      return `loopback:${normalizeLoopbackPath(parsed.pathname)}`
    }
  } catch {
    // Fall through to base relay normalization for non-URL inputs.
  }
  return getBaseRelayUrl(trimmed).trim()
}

export function groupScopeKey(groupId: string, relay?: string | null): string {
  const normalizedGroupId = String(groupId || '').trim()
  return `${normalizeGroupScopeRelay(relay)}|${normalizedGroupId}`
}
