import type { Event } from 'nostr-tools'

export const PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE = 'ht-private-leave:v1'
const HYPERPIPE_GATEWAY_ID_TAG = 'hyperpipe-gateway-id'
const HYPERPIPE_GATEWAY_ORIGIN_TAG = 'hyperpipe-gateway-origin'
const HYPERPIPE_GATEWAY_AUTH_METHOD_TAG = 'hyperpipe-gateway-auth-method'
const HYPERPIPE_GATEWAY_DELEGATION_TAG = 'hyperpipe-gateway-delegation'
const HYPERPIPE_GATEWAY_SPONSOR_TAG = 'hyperpipe-gateway-sponsor'
const HYPERPIPE_DIRECT_JOIN_ONLY_TAG = 'hyperpipe-direct-join-only'

function normalizeHttpOrigin(value?: string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

export type GroupIdentifier = {
  rawId: string
  groupId: string
  relay?: string
}

export function parseGroupIdentifier(rawId: string): GroupIdentifier {
  if (rawId.includes("'")) {
    const [relay, groupId] = rawId.split("'")
    return {
      rawId,
      relay,
      groupId
    }
  }
  return {
    rawId,
    groupId: rawId
  }
}

export function buildGroupIdForCreation(creatorNpub: string, name: string): string {
  const sanitizedName = name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9-_]/g, '')
  return `${creatorNpub}-${sanitizedName}`
}

export function parseGroupMetadataEvent(event: Event, relay?: string) {
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
  const name = event.tags.find((tag) => tag[0] === 'name')?.[1] ?? (d || 'Untitled Group')
  const about = event.tags.find((tag) => tag[0] === 'about')?.[1]
  const picture = event.tags.find((tag) => tag[0] === 'picture')?.[1]
  const isPublic = event.tags.some((tag) => tag[0] === 'public')
  const isOpen = event.tags.some((tag) => tag[0] === 'open')
  const discoveryTopic = event.tags.find((tag) => tag[0] === 'hyperpipe-topic')?.[1] ?? null
  const hostPeerKeys = event.tags
    .filter((tag) => tag[0] === 'hyperpipe-host-peer' && tag[1])
    .map((tag) => tag[1])
  const leaseReplicaPeerKeys = event.tags
    .filter((tag) => tag[0] === 'hyperpipe-lease-replica-peer' && tag[1])
    .map((tag) => tag[1])
  const writerIssuerPubkey = event.tags.find((tag) => tag[0] === 'hyperpipe-writer-issuer')?.[1] ?? null
  const gatewayId = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_ID_TAG)?.[1] ?? null
  const gatewayOrigin = normalizeHttpOrigin(
    event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_ORIGIN_TAG)?.[1] ?? null
  )
  const gatewayAuthMethod = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_AUTH_METHOD_TAG)?.[1] ?? null
  const gatewayDelegation = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_DELEGATION_TAG)?.[1] ?? null
  const gatewaySponsorPubkey = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_SPONSOR_TAG)?.[1] ?? null
  const directJoinOnly = event.tags.some(
    (tag) => tag[0] === HYPERPIPE_DIRECT_JOIN_ONLY_TAG && (tag[1] === '1' || tag[1] === 'true')
  )

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    gatewayId: gatewayId ? gatewayId.toLowerCase() : null,
    gatewayOrigin,
    gatewayAuthMethod,
    gatewayDelegation,
    gatewaySponsorPubkey,
    directJoinOnly,
    discoveryTopic,
    hostPeerKeys,
    leaseReplicaPeerKeys,
    writerIssuerPubkey,
    event
  }
}

export function parseGroupInviteEvent(event: Event, relay?: string) {
  const groupId = event.tags.find((tag) => tag[0] === 'h')?.[1] || ''
  const name = event.tags.find((tag) => tag[0] === 'name')?.[1]
  const picture = event.tags.find((tag) => tag[0] === 'picture')?.[1]
  const about = event.tags.find((tag) => tag[0] === 'about')?.[1]
  const isPublic = event.tags.some((tag) => tag[0] === 'public')
  const fileSharing = event.tags.some((tag) => tag[0] === 'file-sharing-on')
  const gatewayId = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_ID_TAG)?.[1] ?? null
  const gatewayOrigin = normalizeHttpOrigin(
    event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_ORIGIN_TAG)?.[1] ?? null
  )
  const gatewayAuthMethod = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_AUTH_METHOD_TAG)?.[1] ?? null
  const gatewayDelegation = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_DELEGATION_TAG)?.[1] ?? null
  const gatewaySponsorPubkey = event.tags.find((tag) => tag[0] === HYPERPIPE_GATEWAY_SPONSOR_TAG)?.[1] ?? null
  const directJoinOnly = event.tags.some(
    (tag) => tag[0] === HYPERPIPE_DIRECT_JOIN_ONLY_TAG && (tag[1] === '1' || tag[1] === 'true')
  )

  return {
    id: event.id,
    groupId,
    relay,
    gatewayId: gatewayId ? gatewayId.toLowerCase() : null,
    gatewayOrigin,
    gatewayAuthMethod,
    gatewayDelegation,
    gatewaySponsorPubkey,
    directJoinOnly,
    groupName: name,
    groupPicture: picture,
    isPublic,
    fileSharing,
    about,
    event
  }
}

export function parseGroupListEvent(event: Event): Array<{ groupId: string; relay?: string }> {
  const entries: Array<{ groupId: string; relay?: string }> = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || !tag[0]) continue

    if (tag[0] === 'g' && tag[1]) {
      const { groupId, relay } = parseGroupIdentifier(tag[1])
      entries.push({ groupId, relay })
      continue
    }

    if (tag[0] === 'group' && tag[1]) {
      entries.push({
        groupId: tag[1],
        relay: tag[2] || undefined
      })
    }
  }

  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.relay || ''}|${entry.groupId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parseGroupMembersEvent(event: Event): string[] {
  return event.tags
    .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
    .map((tag) => tag[1])
}

export function parseGroupAdminsEvent(event: Event): Array<{ pubkey: string; roles: string[] }> {
  return event.tags
    .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
    .map((tag) => ({
      pubkey: tag[1],
      roles: tag.slice(2)
    }))
}

export async function buildPrivateGroupLeaveShadowRef(args: {
  groupId: string
  relayKey?: string | null
  publicIdentifier?: string | null
}): Promise<string | null> {
  const groupId = String(args.groupId || '').trim()
  if (!groupId) return null

  const privacySalt = String(
    args.publicIdentifier || args.relayKey || groupId
  )
    .trim()
    .toLowerCase()

  if (!privacySalt) return null

  return `${PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE}:${privacySalt}:${groupId}`
}
