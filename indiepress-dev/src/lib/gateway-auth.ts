import type { TDraftEvent } from '@/types'

type SignEventFn = (draftEvent: TDraftEvent) => Promise<any>

const GATEWAY_AUTH_EVENT_KIND = 22242
const GATEWAY_TOKEN_REFRESH_SKEW_MS = 30_000
const GATEWAY_TOKEN_DEFAULT_TTL_SEC = 120

type GatewayTokenCacheEntry = {
  token: string
  expiresAtMs: number
}

const gatewayTokenCache = new Map<string, GatewayTokenCacheEntry>()

function parseResponseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string' && error.trim()) return error
  const reason = (payload as { reason?: unknown }).reason
  if (typeof reason === 'string' && reason.trim()) return reason
  return fallback
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function normalizeGatewayOrigin(value: string): string {
  const origin = String(value || '').trim()
  if (!origin) return ''
  try {
    return new URL(origin).origin
  } catch {
    return origin.replace(/\/+$/, '')
  }
}

function buildGatewayTokenCacheKey(args: {
  origin: string
  pubkey: string
  scope: string
  relayKey?: string | null
}): string {
  const origin = normalizeGatewayOrigin(args.origin).toLowerCase()
  const pubkey = String(args.pubkey || '').trim().toLowerCase()
  const scope = String(args.scope || '').trim()
  const relayKey = String(args.relayKey || '').trim().toLowerCase()
  return `${origin}|${pubkey}|${scope}|${relayKey}`
}

function pruneGatewayTokenCache(nowMs = Date.now()): void {
  for (const [key, entry] of gatewayTokenCache.entries()) {
    if (!entry.token || entry.expiresAtMs <= nowMs) {
      gatewayTokenCache.delete(key)
    }
  }
}

function parseVerifyExpirySeconds(payload: any): number {
  const numeric = Number(payload?.expiresIn ?? payload?.expires_in)
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric)
  return GATEWAY_TOKEN_DEFAULT_TTL_SEC
}

export function invalidateGatewayBearerToken(args: {
  origin: string
  pubkey: string
  scope: string
  relayKey?: string | null
}): void {
  const cacheKey = buildGatewayTokenCacheKey(args)
  if (cacheKey) {
    gatewayTokenCache.delete(cacheKey)
  }
}

export async function requestGatewayBearerToken(args: {
  origin: string
  pubkey: string
  scope: string
  signEvent: SignEventFn
  relayKey?: string | null
  forceRefresh?: boolean
}): Promise<string> {
  const origin = normalizeGatewayOrigin(args.origin)
  const pubkey = String(args.pubkey || '').trim().toLowerCase()
  const scope = String(args.scope || '').trim()
  if (!origin) throw new Error('gateway origin is required')
  if (!pubkey) throw new Error('pubkey is required')
  if (!scope) throw new Error('scope is required')

  const cacheKey = buildGatewayTokenCacheKey({
    origin,
    pubkey,
    scope,
    relayKey: args.relayKey
  })
  const now = Date.now()
  pruneGatewayTokenCache(now)
  if (!args.forceRefresh) {
    const cached = gatewayTokenCache.get(cacheKey)
    if (cached && cached.expiresAtMs - GATEWAY_TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token
    }
  }

  const challengeResponse = await fetch(`${origin}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pubkey,
      scope,
      relayKey: args.relayKey || null
    })
  })
  const challengePayload = await readJson(challengeResponse)
  if (!challengeResponse.ok) {
    throw new Error(parseResponseError(challengePayload, `challenge failed (${challengeResponse.status})`))
  }
  const challengeId = String(challengePayload?.challengeId || challengePayload?.challenge_id || '').trim()
  const nonce = String(challengePayload?.nonce || '').trim()
  if (!challengeId || !nonce) {
    throw new Error('challenge response missing challengeId/nonce')
  }

  const tags: string[][] = [
    ['challenge', nonce],
    ['scope', scope]
  ]
  if (args.relayKey) {
    tags.push(['relay', String(args.relayKey)])
  }
  const authEvent = await args.signEvent({
    kind: GATEWAY_AUTH_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  })

  const verifyResponse = await fetch(`${origin}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      authEvent
    })
  })
  const verifyPayload = await readJson(verifyResponse)
  if (!verifyResponse.ok) {
    throw new Error(parseResponseError(verifyPayload, `auth verify failed (${verifyResponse.status})`))
  }
  const token = String(verifyPayload?.token || '').trim()
  if (!token) {
    throw new Error('auth verify response missing token')
  }
  const expiresInSec = parseVerifyExpirySeconds(verifyPayload)
  gatewayTokenCache.set(cacheKey, {
    token,
    expiresAtMs: Date.now() + expiresInSec * 1000
  })
  return token
}
