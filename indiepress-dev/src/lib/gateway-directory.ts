import { normalizeGatewayPolicy, normalizeGatewayPubkey } from '@/lib/hypertuna-group-events'
import {
  TGatewayDirectoryEntry,
  TGatewayMetadata,
  TGroupMetadata
} from '@/types/groups'

type TGatewayProfileSummary = {
  name?: string | null
  nip05?: string | null
  picture?: string | null
}

const normalizePubkey = (value?: string | null) => {
  const normalized = normalizeGatewayPubkey(value)
  return normalized || null
}

const normalizeCreatedAt = (entry?: { createdAt?: number | null; event?: { created_at?: number | null } } | null) => {
  const eventCreatedAt = Number(entry?.event?.created_at || 0)
  const createdAt = Number(entry?.createdAt || 0)
  return Math.max(eventCreatedAt, createdAt)
}

export function buildGatewayDirectory(args: {
  discoveryGroups: TGroupMetadata[]
  gatewayMetadata: TGatewayMetadata[]
  currentPubkey?: string | null
  followedPubkeys?: string[]
  operatorProfiles?: Record<string, TGatewayProfileSummary>
}): TGatewayDirectoryEntry[] {
  const currentPubkey = normalizePubkey(args.currentPubkey)
  const followedSet = new Set(
    (Array.isArray(args.followedPubkeys) ? args.followedPubkeys : [])
      .map((entry) => normalizePubkey(entry))
      .filter((entry): entry is string => !!entry)
  )

  const metadataByOrigin = new Map<string, TGatewayMetadata>()
  for (const entry of Array.isArray(args.gatewayMetadata) ? args.gatewayMetadata : []) {
    const origin = String(entry?.origin || '').trim()
    if (!origin) continue
    const existing = metadataByOrigin.get(origin)
    if (!existing || normalizeCreatedAt(entry) >= normalizeCreatedAt(existing)) {
      metadataByOrigin.set(origin, entry)
    }
  }

  const popularityByOrigin = new Map<string, number>()
  const fallbackByOrigin = new Map<
    string,
    {
      operatorPubkey: string
      policy: 'OPEN' | 'CLOSED'
    }
  >()

  for (const group of Array.isArray(args.discoveryGroups) ? args.discoveryGroups : []) {
    for (const gateway of Array.isArray(group?.gateways) ? group.gateways : []) {
      const origin = String(gateway?.origin || '').trim()
      const operatorPubkey = normalizePubkey(gateway?.operatorPubkey)
      if (!origin || !operatorPubkey) continue
      popularityByOrigin.set(origin, Number(popularityByOrigin.get(origin) || 0) + 1)
      if (!fallbackByOrigin.has(origin)) {
        fallbackByOrigin.set(origin, {
          operatorPubkey,
          policy: normalizeGatewayPolicy(gateway?.policy)
        })
      } else if (normalizeGatewayPolicy(gateway?.policy) === 'CLOSED') {
        const current = fallbackByOrigin.get(origin)
        if (current) {
          fallbackByOrigin.set(origin, {
            ...current,
            policy: 'CLOSED'
          })
        }
      }
    }
  }

  const candidateOrigins = new Set<string>([
    ...Array.from(metadataByOrigin.keys()),
    ...Array.from(fallbackByOrigin.keys())
  ])

  const directory: TGatewayDirectoryEntry[] = []
  for (const origin of candidateOrigins) {
    const metadata = metadataByOrigin.get(origin)
    const fallback = fallbackByOrigin.get(origin)
    const operatorPubkey = normalizePubkey(metadata?.operatorPubkey || fallback?.operatorPubkey)
    if (!operatorPubkey) continue

    const policy = normalizeGatewayPolicy(metadata?.policy || fallback?.policy)
    const allowList = new Set(
      (Array.isArray(metadata?.allowList) ? metadata.allowList : [])
        .map((entry) => normalizePubkey(entry))
        .filter((entry): entry is string => !!entry)
    )
    const banList = new Set(
      (Array.isArray(metadata?.banList) ? metadata.banList : [])
        .map((entry) => normalizePubkey(entry))
        .filter((entry): entry is string => !!entry)
    )
    if (currentPubkey && banList.has(currentPubkey)) continue
    const allowListed = policy === 'OPEN' ? true : !!currentPubkey && allowList.has(currentPubkey)
    if (policy === 'CLOSED' && !allowListed) continue

    const profile = args.operatorProfiles?.[operatorPubkey]
    directory.push({
      origin,
      operatorPubkey,
      policy,
      allowListed,
      popularityCount: Number(popularityByOrigin.get(origin) || 0),
      followedOperator: followedSet.has(operatorPubkey),
      operatorName: profile?.name || null,
      operatorNip05: profile?.nip05 || null,
      operatorPicture: profile?.picture || null
    })
  }

  return directory.sort((left, right) => {
    if (left.followedOperator !== right.followedOperator) {
      return left.followedOperator ? -1 : 1
    }
    if (left.popularityCount !== right.popularityCount) {
      return right.popularityCount - left.popularityCount
    }
    if (left.policy !== right.policy) {
      return left.policy === 'OPEN' ? -1 : 1
    }
    return left.origin.localeCompare(right.origin)
  })
}
