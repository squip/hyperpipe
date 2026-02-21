import { Event } from '@nostr/tools/wasm'
import {
  TGroupAdmin,
  TGatewayDescriptor,
  TGatewayInvite,
  TGatewayJoinRequest,
  TGatewayMetadata,
  TGroupIdentifier,
  TGroupInvite,
  TGroupListEntry,
  TGroupMetadata,
  TGroupMembershipStatus,
  TGroupRoles,
  TJoinRequest
} from '@/types/groups'

export const PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE = 'ht-private-leave:v1'
export const KIND_GATEWAY_EVENT = 30078
export const GATEWAY_EVENT_KIND_METADATA = 'hypertuna_gateway:metadata'
export const GATEWAY_EVENT_KIND_INVITE = 'hypertuna_gateway:invite'
export const GATEWAY_EVENT_KIND_JOIN_REQUEST = 'hypertuna_gateway:join_request'

export function parseGroupIdentifier(rawId: string): TGroupIdentifier {
  if (rawId.includes("'")) {
    const [relay, groupId] = rawId.split("'")
    return { rawId, relay, groupId }
  }
  return { rawId, groupId: rawId }
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

function parseGatewayTags(tags: string[][]): TGatewayDescriptor[] {
  const gateways: TGatewayDescriptor[] = []
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

function parseGatewayAllowList(tags: string[][]): string[] {
  const allowTag = tags.find((tag) => tag[0] === 'allow-list')
  if (!allowTag) return []
  const seen = new Set<string>()
  const allowList: string[] = []
  allowTag.slice(1).forEach((entry) => {
    const normalized = normalizePubkey(String(entry || ''))
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    allowList.push(normalized)
  })
  return allowList
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

function parseMemberPeerTags(tags: string[][]): string[] {
  const peers = new Set<string>()
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'member-peer' || !tag[1]) continue
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

export function parseGroupMetadataEvent(event: Event, relay?: string): TGroupMetadata {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  const name = event.tags.find((t) => t[0] === 'name')?.[1] ?? (d || 'Untitled Group')
  const about = event.tags.find((t) => t[0] === 'about')?.[1]
  const picture = event.tags.find((t) => t[0] === 'picture')?.[1]
  const isPublic = event.tags.some((t) => t[0] === 'public')
  const isOpen = event.tags.some((t) => t[0] === 'open')
  const tags = event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1])
  const gateways = parseGatewayTags(event.tags)
  const discoveryTopic = parseSwarmTopicTag(event.tags)
  const hostPeerKeys = parseHostPeerTags(event.tags)
  const memberPeerKeys = parseMemberPeerTags(event.tags)
  const writerIssuerPubkey = parseWriterIssuerTag(event.tags)

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    tags,
    gateways,
    discoveryTopic,
    hostPeerKeys,
    memberPeerKeys,
    writerIssuerPubkey,
    event
  }
}

export function parseGroupAdminsEvent(event: Event): TGroupAdmin[] {
  return event.tags
    .filter((t) => t[0] === 'p' && t[1])
    .map((t) => ({
      pubkey: t[1],
      roles: t.slice(2)
    }))
}

export function parseGroupMembersEvent(event: Event): string[] {
  return event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
}

type MembershipAction = 'member' | 'removed'

type MembershipState = {
  action: MembershipAction
  createdAt: number
}

const membershipActionForKind = (kind: number): MembershipAction | null => {
  if (kind === 9000) return 'member'
  if (kind === 9001) return 'removed'
  if (kind === 9022) return 'removed'
  return null
}

const getMembershipTargetsForEvent = (event: Event): string[] => {
  const targets = event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
  if (targets.length > 0) return targets
  if (event.kind === 9022 && event.pubkey) {
    return [event.pubkey]
  }
  return []
}

const shouldReplaceMembershipState = (
  existing: MembershipState | undefined,
  nextAction: MembershipAction,
  nextCreatedAt: number
) => {
  if (!existing) return true
  if (nextCreatedAt > existing.createdAt) return true
  if (nextCreatedAt < existing.createdAt) return false
  // If timestamps are identical, prefer removal to avoid false-positive membership.
  if (nextAction === 'removed' && existing.action !== 'removed') return true
  return false
}

export function resolveGroupMembersFromSnapshotAndOps(args: {
  snapshotMembers?: string[]
  snapshotCreatedAt?: number | null
  membershipEvents?: Event[]
}): string[] {
  const { snapshotMembers = [], snapshotCreatedAt = null, membershipEvents = [] } = args

  const stateByPubkey = new Map<string, MembershipState>()
  const snapshotTs = Number.isFinite(snapshotCreatedAt as number)
    ? Number(snapshotCreatedAt)
    : Number.NEGATIVE_INFINITY

  for (const member of snapshotMembers) {
    if (!member) continue
    if (!stateByPubkey.has(member)) {
      stateByPubkey.set(member, {
        action: 'member',
        createdAt: snapshotTs
      })
    }
  }

  for (const evt of membershipEvents) {
    const action = membershipActionForKind(evt.kind)
    if (!action) continue
    const createdAt = Number.isFinite(evt.created_at) ? evt.created_at : 0
    const targets = getMembershipTargetsForEvent(evt)
    for (const target of targets) {
      const existing = stateByPubkey.get(target)
      if (!shouldReplaceMembershipState(existing, action, createdAt)) continue
      stateByPubkey.set(target, { action, createdAt })
    }
  }

  const members: string[] = []
  stateByPubkey.forEach((state, pubkey) => {
    if (state.action === 'member') members.push(pubkey)
  })
  return members
}

export function parseGroupRolesEvent(event: Event): TGroupRoles {
  const roles = event.tags
    .filter((t) => t[0] === 'role' && t[1])
    .map((t) => ({ name: t[1], description: t[2] }))

  return { roles, event }
}

export function parseGroupInviteEvent(event: Event, relay?: string): TGroupInvite {
  const groupId = event.tags.find((t) => t[0] === 'h')?.[1] || ''
  const name = event.tags.find((t) => t[0] === 'name')?.[1]
  const picture = event.tags.find((t) => t[0] === 'picture')?.[1]
  const about = event.tags.find((t) => t[0] === 'about')?.[1]
  const isPublic = event.tags.some((t) => t[0] === 'public')
  const fileSharingOn = event.tags.some((t) => t[0] === 'file-sharing-on')
  return {
    groupId,
    relay,
    groupName: name,
    groupPicture: picture,
    name,
    about,
    isPublic,
    fileSharing: fileSharingOn,
    // Token is encrypted in content per requirements; decrypted elsewhere
    token: undefined,
    event
  }
}

export function parseGatewayMetadataEvent(event: Event): TGatewayMetadata | null {
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
    origin,
    operatorPubkey,
    policy: normalizeGatewayPolicy(policyTag),
    allowList: parseGatewayAllowList(event.tags),
    discoveryRelays: parseGatewayDiscoveryRelays(event.tags),
    content: typeof event.content === 'string' ? event.content : '',
    createdAt: Number.isFinite(event.created_at) ? event.created_at : null,
    event
  }
}

export function parseGatewayInviteEvent(event: Event): TGatewayInvite | null {
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
    origin,
    inviteePubkey,
    inviteToken: String(inviteToken),
    operatorPubkey: normalizePubkey(event.pubkey),
    createdAt: Number.isFinite(event.created_at) ? event.created_at : null,
    event
  }
}

export function parseGatewayJoinRequestEvent(event: Event): TGatewayJoinRequest | null {
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
    origin,
    requesterPubkey,
    content: typeof event.content === 'string' ? event.content : '',
    createdAt: Number.isFinite(event.created_at) ? event.created_at : null,
    event
  }
}

export function parseGroupJoinRequestEvent(event: Event): TJoinRequest {
  const groupId = event.tags.find((t) => t[0] === 'h')?.[1] || ''
  const inviteCode = event.tags.find((t) => t[0] === 'code')?.[1]
  return {
    groupId,
    pubkey: event.pubkey,
    created_at: event.created_at,
    content: event.content || '',
    inviteCode,
    event
  }
}

export function parseGroupListEvent(event: Event): TGroupListEntry[] {
  const entries: TGroupListEntry[] = []

  for (const tag of event.tags) {
    if (!Array.isArray(tag) || !tag[0]) continue

    // Indiepress format: ['g', "relay'groupId"] or ['g', "groupId"]
    if (tag[0] === 'g' && tag[1]) {
      const { groupId, relay } = parseGroupIdentifier(tag[1])
      entries.push({ groupId, relay })
      continue
    }

    // Legacy Hypertuna format: ['group', publicIdentifier, baseRelayUrl, groupName?, 'hypertuna:relay']
    if (tag[0] === 'group' && tag[1]) {
      const groupId = tag[1]
      const relay = tag[2] || undefined
      entries.push({ groupId, relay })
      continue
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

export function deriveMembershipStatus(
  pubkey: string,
  events: Event[],
  joinRequests: Event[] = []
): TGroupMembershipStatus {
  let latestMembershipEvent: Event | null = null
  for (const evt of events) {
    if (evt.kind !== 9000 && evt.kind !== 9001 && evt.kind !== 9022) continue
    const targetsPubkey = getMembershipTargetsForEvent(evt).includes(pubkey)
    if (!targetsPubkey) continue
    if (!latestMembershipEvent || evt.created_at > latestMembershipEvent.created_at) {
      latestMembershipEvent = evt
      continue
    }
    if (
      latestMembershipEvent &&
      evt.created_at === latestMembershipEvent.created_at &&
      (evt.kind === 9001 || evt.kind === 9022) &&
      latestMembershipEvent.kind === 9000
    ) {
      latestMembershipEvent = evt
    }
  }

  if (latestMembershipEvent) {
    if (latestMembershipEvent.kind === 9000) return 'member'
    if (latestMembershipEvent.kind === 9001 || latestMembershipEvent.kind === 9022) return 'removed'
  }

  const latestRequest = joinRequests
    .filter((evt) => evt.kind === 9021 && evt.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0]

  if (latestRequest) {
    return 'pending'
  }

  return 'not-member'
}

export async function buildPrivateGroupLeaveShadowRef(args: {
  groupId: string
  relayKey?: string | null
  publicIdentifier?: string | null
}): Promise<string | null> {
  const groupId = String(args.groupId || '').trim()
  if (!groupId) return null

  const relayKey = typeof args.relayKey === 'string' ? args.relayKey.trim().toLowerCase() : ''
  const publicIdentifier =
    typeof args.publicIdentifier === 'string' ? args.publicIdentifier.trim() : ''
  const privacySalt = relayKey || publicIdentifier || groupId
  const payload = `${PRIVATE_GROUP_LEAVE_SHADOW_NAMESPACE}:${privacySalt}:${groupId}`

  const subtle = globalThis?.crypto?.subtle
  if (!subtle) return null

  try {
    const bytes = new TextEncoder().encode(payload)
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch (_err) {
    return null
  }
}
