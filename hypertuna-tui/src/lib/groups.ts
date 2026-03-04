import type { Event } from 'nostr-tools'
import { normalizeGatewayOrigin } from './hypertuna-group-events.js'

export const PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE = 'ht-private-leave:v1'

function extractCanonicalGatewayTagValue(tags: string[][]): string | undefined {
  for (const tag of tags || []) {
    if (!Array.isArray(tag) || tag[0] !== 'gateway') continue
    const rawValue = typeof tag[1] === 'string' ? tag[1].trim() : ''
    if (!rawValue) continue
    if (/^(none|null|disabled|direct-only)$/i.test(rawValue)) {
      return 'none'
    }
    const normalized = normalizeGatewayOrigin(rawValue)
    if (normalized) return normalized
  }
  return undefined
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
  const gatewayOrigin = extractCanonicalGatewayTagValue(event.tags as string[][])
  const discoveryTopic = event.tags.find((tag) => tag[0] === 'hypertuna-topic')?.[1] ?? null
  const hostPeerKeys = event.tags
    .filter((tag) => tag[0] === 'hypertuna-host-peer' && tag[1])
    .map((tag) => tag[1])
  const leaseReplicaPeerKeys = event.tags
    .filter((tag) => tag[0] === 'hypertuna-lease-replica-peer' && tag[1])
    .map((tag) => tag[1])
  const writerIssuerPubkey = event.tags.find((tag) => tag[0] === 'hypertuna-writer-issuer')?.[1] ?? null

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    gatewayOrigin,
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
  const gatewayOrigin = extractCanonicalGatewayTagValue(event.tags as string[][])

  return {
    id: event.id,
    groupId,
    relay,
    groupName: name,
    groupPicture: picture,
    gatewayOrigin,
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
