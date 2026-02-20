import type { Event } from 'nostr-tools'

export const PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE = 'ht-private-leave:v1'
export const KIND_GATEWAY_EVENT = 30078
export const GATEWAY_EVENT_KIND_METADATA = 'hypertuna_gateway:metadata'
export const GATEWAY_EVENT_KIND_INVITE = 'hypertuna_gateway:invite'
export const GATEWAY_EVENT_KIND_JOIN_REQUEST = 'hypertuna_gateway:join_request'

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

function normalizeGatewayOrigin(candidate: string | undefined): string | null {
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch (_err) {
    return null
  }
}

function normalizePubkey(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null
  return trimmed
}

function normalizeGatewayPolicy(value: string | undefined): 'OPEN' | 'CLOSED' {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return upper === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

function parseGatewayTags(tags: string[][]) {
  const gateways: Array<{ origin: string; operatorPubkey: string; policy: 'OPEN' | 'CLOSED' }> = []
  const seen = new Set<string>()
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'gateway') continue
    const origin = normalizeGatewayOrigin(tag[1])
    const operatorPubkey = normalizePubkey(tag[2])
    if (!origin || !operatorPubkey || seen.has(origin)) continue
    seen.add(origin)
    gateways.push({
      origin,
      operatorPubkey,
      policy: normalizeGatewayPolicy(tag[3])
    })
  }
  return gateways
}

function parseGatewayDTag(tags: string[][]): string | null {
  return tags.find((tag) => tag[0] === 'd' && tag[1])?.[1] || null
}

function parseGatewayHTag(tags: string[][]): string | null {
  return tags.find((tag) => tag[0] === 'h' && tag[1])?.[1] || null
}

function parseGatewayAllowList(tags: string[][]): string[] {
  const allowTag = tags.find((tag) => tag[0] === 'allow-list')
  if (!allowTag) return []
  const seen = new Set<string>()
  const allowList: string[] = []
  allowTag.slice(1).forEach((value) => {
    const normalized = normalizePubkey(String(value || ''))
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    allowList.push(normalized)
  })
  return allowList
}

function parseGatewayDiscoveryRelays(tags: string[][]): string[] {
  const seen = new Set<string>()
  const relays: string[] = []
  tags.forEach((tag) => {
    if (tag[0] !== 'r' || !tag[1]) return
    const relay = String(tag[1] || '').trim()
    if (!relay || seen.has(relay)) return
    seen.add(relay)
    relays.push(relay)
  })
  return relays
}

function parseSwarmTopicTag(tags: string[][]): string | null {
  const tag = tags.find((entry) => entry[0] === 'swarm-topic' && entry[1])
  if (!tag?.[1]) return null
  const value = String(tag[1]).trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(value)) return null
  return value
}

function parseHostPeerTags(tags: string[][]): string[] {
  const peers = new Set<string>()
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'host-peer' || !tag[1]) continue
    const normalized = normalizePubkey(String(tag[1]))
    if (!normalized) continue
    peers.add(normalized)
  }
  return Array.from(peers)
}

function parseWriterIssuerTag(tags: string[][]): string | null {
  const tag = tags.find((entry) => entry[0] === 'writer-issuer' && entry[1])
  if (!tag?.[1]) return null
  return normalizePubkey(String(tag[1]))
}

export function parseGroupMetadataEvent(event: Event, relay?: string) {
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''
  const name = event.tags.find((tag) => tag[0] === 'name')?.[1] ?? (d || 'Untitled Group')
  const about = event.tags.find((tag) => tag[0] === 'about')?.[1]
  const picture = event.tags.find((tag) => tag[0] === 'picture')?.[1]
  const isPublic = event.tags.some((tag) => tag[0] === 'public')
  const isOpen = event.tags.some((tag) => tag[0] === 'open')
  const gateways = parseGatewayTags(event.tags)
  const discoveryTopic = parseSwarmTopicTag(event.tags)
  const hostPeerKeys = parseHostPeerTags(event.tags)
  const writerIssuerPubkey = parseWriterIssuerTag(event.tags)

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    gateways,
    discoveryTopic,
    hostPeerKeys,
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

  return {
    id: event.id,
    groupId,
    relay,
    groupName: name,
    groupPicture: picture,
    isPublic,
    fileSharing,
    about,
    event
  }
}

export function parseGatewayMetadataEvent(event: Event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT) return null
  const h = parseGatewayHTag(event.tags)
  if (h !== GATEWAY_EVENT_KIND_METADATA) return null
  const d = parseGatewayDTag(event.tags)
  const originFromD =
    typeof d === 'string' && d.startsWith('hypertuna_gateway:')
      ? d.slice('hypertuna_gateway:'.length)
      : null
  const origin = normalizeGatewayOrigin(originFromD || undefined)
  if (!origin) return null
  const operatorTag = event.tags.find((tag) => tag[0] === 'operator' && tag[1])?.[1]
  const operatorPubkey = normalizePubkey(operatorTag || event.pubkey || undefined)
  if (!operatorPubkey) return null
  const policyTag = event.tags.find((tag) => tag[0] === 'policy' && tag[1])?.[1]
  return {
    id: event.id,
    origin,
    operatorPubkey,
    policy: normalizeGatewayPolicy(policyTag),
    allowList: parseGatewayAllowList(event.tags),
    discoveryRelays: parseGatewayDiscoveryRelays(event.tags),
    content: typeof event.content === 'string' ? event.content : '',
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    event
  }
}

export function parseGatewayInviteEvent(event: Event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT) return null
  const h = parseGatewayHTag(event.tags)
  if (h !== GATEWAY_EVENT_KIND_INVITE) return null
  const d = parseGatewayDTag(event.tags)
  const originFromD =
    typeof d === 'string' && d.startsWith('hypertuna_gateway:')
      ? d.slice('hypertuna_gateway:'.length)
      : null
  const origin = normalizeGatewayOrigin(originFromD || undefined)
  if (!origin) return null
  const inviteePubkey = normalizePubkey(event.tags.find((tag) => tag[0] === 'p' && tag[1])?.[1])
  const inviteToken = event.tags.find((tag) => tag[0] === 'INVITE' && tag[1])?.[1]
  if (!inviteePubkey || !inviteToken) return null
  return {
    id: event.id,
    origin,
    inviteePubkey,
    inviteToken: String(inviteToken),
    operatorPubkey: normalizePubkey(event.pubkey),
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    event
  }
}

export function parseGatewayJoinRequestEvent(event: Event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT) return null
  const h = parseGatewayHTag(event.tags)
  if (h !== GATEWAY_EVENT_KIND_JOIN_REQUEST) return null
  const d = parseGatewayDTag(event.tags)
  const originFromD =
    typeof d === 'string' && d.startsWith('hypertuna_gateway:')
      ? d.slice('hypertuna_gateway:'.length)
      : null
  const origin = normalizeGatewayOrigin(originFromD || undefined)
  if (!origin) return null
  const requesterTag = event.tags.find((tag) => tag[0] === 'p' && tag[1])?.[1]
  const requesterPubkey = normalizePubkey(requesterTag || event.pubkey || undefined)
  if (!requesterPubkey) return null
  return {
    id: event.id,
    origin,
    requesterPubkey,
    content: typeof event.content === 'string' ? event.content : '',
    createdAt: Number.isFinite(event.created_at) ? event.created_at : 0,
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
