import { TFeedSubRequest } from '@/types'
import { Filter } from '@nostr/tools/filter'

export const DEFAULT_WARM_HYDRATION_OVERLAP_SECONDS = 10

export function buildFeedFilterSignature(filter: Record<string, unknown>) {
  return JSON.stringify(filter)
}

export function extendFeedSubRequestsWithLocal(
  subRequests: TFeedSubRequest[]
): TFeedSubRequest[] {
  const localBySignature = new Map<string, Extract<TFeedSubRequest, { source: 'local' }>>()
  const relayRequests: Extract<TFeedSubRequest, { source: 'relays' }>[] = []

  for (const request of subRequests) {
    if (request.source === 'local') {
      localBySignature.set(buildFeedFilterSignature(request.filter), request)
      continue
    }
    relayRequests.push(request)
  }

  for (const request of relayRequests) {
    const signature = buildFeedFilterSignature(request.filter)
    if (localBySignature.has(signature)) continue
    localBySignature.set(signature, {
      source: 'local',
      filter: request.filter
    })
  }

  return [...localBySignature.values(), ...relayRequests]
}

export function applyWarmHydrationCursorToRelayFilter(
  filter: Filter,
  newestLocalCreatedAt: number | null | undefined,
  overlapSeconds = DEFAULT_WARM_HYDRATION_OVERLAP_SECONDS
): Filter {
  if (!Number.isFinite(newestLocalCreatedAt)) {
    return filter
  }

  const normalizedOverlap = Math.max(0, Math.floor(overlapSeconds))
  const nextSince = Math.max(0, Number(newestLocalCreatedAt) - normalizedOverlap)
  const existingSince = typeof filter.since === 'number' ? filter.since : null

  if (existingSince !== null && existingSince >= nextSince) {
    return filter
  }

  return {
    ...filter,
    since: existingSince === null ? nextSince : Math.max(existingSince, nextSince)
  }
}
