import type { Event } from 'nostr-tools'
import type { ChatInvite, GroupInvite, GroupJoinRequest, GroupListEntry, GroupSummary, InvitesInboxItem } from '../types.js'
import { parseGroupIdentifier, parseGroupInviteEvent, parseGroupMetadataEvent } from '../../lib/groups.js'
import {
  getBaseRelayUrl,
  HYPERPIPE_IDENTIFIER_TAG,
  parseHyperpipeRelayEvent30166
} from '../../lib/hyperpipe-group-events.js'

function toGroupKey(groupId: string, relay?: string): string {
  const normalizedGroupId = String(groupId || '').trim()
  const normalizedRelay = relay ? getBaseRelayUrl(relay) : ''
  return `${normalizedRelay}|${normalizedGroupId}`
}

function hasTag(event: Event, key: string, value?: string): boolean {
  return event.tags.some((tag) => {
    if (tag[0] !== key) return false
    if (typeof value === 'undefined') return true
    return tag[1] === value
  })
}

export function isHyperpipeTaggedEvent(event: Event): boolean {
  return hasTag(event, 'i', HYPERPIPE_IDENTIFIER_TAG) || hasTag(event, 'hyperpipe')
}

export function buildRelayUrlByPublicIdentifier(relayEvents: Event[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const event of relayEvents) {
    const parsed = parseHyperpipeRelayEvent30166(event)
    if (!parsed) continue
    map.set(parsed.publicIdentifier, getBaseRelayUrl(parsed.wsUrl))
  }
  return map
}

export function applyGroupDiscoveryParity(args: {
  metadataEvents: Event[]
  relayEvents: Event[]
}): GroupSummary[] {
  const relayUrlById = buildRelayUrlByPublicIdentifier(args.relayEvents)
  const deduped = new Map<string, GroupSummary>()

  for (const event of args.metadataEvents) {
    const parsedId = parseGroupIdentifier(event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '')
    const metadata = parseGroupMetadataEvent(event, parsedId.relay)
    if (!metadata.id) continue

    let relay = metadata.relay
    if (isHyperpipeTaggedEvent(event)) {
      const mapped = relayUrlById.get(metadata.id)
      if (mapped) relay = mapped
    }

    const normalized: GroupSummary = {
      ...metadata,
      relay
    }
    const key = toGroupKey(normalized.id, normalized.relay)
    const existing = deduped.get(key)
    if (!existing || (existing.event?.created_at || 0) < (normalized.event?.created_at || 0)) {
      deduped.set(key, normalized)
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) => (right.event?.created_at || 0) - (left.event?.created_at || 0)
  )
}

export function parseJoinRequestEvent(event: Event): GroupJoinRequest | null {
  if (!event || event.kind !== 9021) return null
  const groupId = event.tags.find((tag) => tag[0] === 'h')?.[1]
  if (!groupId) return null
  const code = event.tags.find((tag) => tag[0] === 'code')?.[1]

  return {
    id: event.id,
    groupId,
    pubkey: event.pubkey,
    createdAt: event.created_at || 0,
    reason: event.content || undefined,
    code
  }
}

export function filterActionableJoinRequests(args: {
  requests: GroupJoinRequest[]
  handledKeys?: Set<string>
  currentMembers?: Set<string>
}): GroupJoinRequest[] {
  const handled = args.handledKeys || new Set<string>()
  const members = args.currentMembers || new Set<string>()
  const latestByPubkey = new Map<string, GroupJoinRequest>()

  for (const request of args.requests) {
    const existing = latestByPubkey.get(request.pubkey)
    if (!existing || existing.createdAt < request.createdAt) {
      latestByPubkey.set(request.pubkey, request)
    }
  }

  const filtered = Array.from(latestByPubkey.values()).filter((request) => {
    if (members.has(request.pubkey)) return false
    const handledKey = `${request.pubkey}:${request.createdAt}`
    if (handled.has(handledKey)) return false
    return true
  })

  filtered.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return left.pubkey.localeCompare(right.pubkey)
  })
  return filtered
}

export function parseGroupInviteWithPayload(args: {
  event: Event
  decryptedPayload?: Record<string, unknown> | null
}): GroupInvite {
  const parsed = parseGroupInviteEvent(args.event)
  const payload = args.decryptedPayload || {}

  const groupName =
    typeof payload.groupName === 'string'
      ? payload.groupName
      : typeof payload.name === 'string'
        ? payload.name
        : parsed.groupName
  const groupPicture =
    typeof payload.groupPicture === 'string'
      ? payload.groupPicture
      : typeof payload.picture === 'string'
        ? payload.picture
        : parsed.groupPicture
  const relayUrl =
    typeof payload.relayUrl === 'string'
      ? payload.relayUrl
      : typeof payload.relay_url === 'string'
        ? payload.relay_url
        : typeof payload.relay === 'string'
          ? payload.relay
          : null
  const relay = relayUrl || parsed.relay
  const relayKey =
    typeof payload.relayKey === 'string'
      ? payload.relayKey
      : typeof payload.relay_key === 'string'
        ? payload.relay_key
        : null
  const gatewayId =
    typeof payload.gatewayId === 'string'
      ? payload.gatewayId.trim().toLowerCase()
      : typeof payload.gateway_id === 'string'
        ? payload.gateway_id.trim().toLowerCase()
        : parsed.gatewayId || null
  const normalizeHttpOrigin = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const parsed = new URL(value.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.origin
    } catch {
      return null
    }
  }
  const gatewayOrigin =
    normalizeHttpOrigin(payload.gatewayOrigin)
    || normalizeHttpOrigin(payload.gateway_origin)
    || parsed.gatewayOrigin
    || null
  const gatewayAuthMethod =
    typeof payload.gatewayAuthMethod === 'string'
      ? payload.gatewayAuthMethod.trim() || null
      : typeof payload.gateway_auth_method === 'string'
        ? payload.gateway_auth_method.trim() || null
        : parsed.gatewayAuthMethod || null
  const gatewayDelegation =
    typeof payload.gatewayDelegation === 'string'
      ? payload.gatewayDelegation.trim() || null
      : typeof payload.gateway_delegation === 'string'
        ? payload.gateway_delegation.trim() || null
        : parsed.gatewayDelegation || null
  const directJoinOnly =
    payload.directJoinOnly === true
    || payload.gatewayDirectJoinOnly === true
    || parsed.directJoinOnly === true
  const token = typeof payload.token === 'string' ? payload.token : undefined
  const isOpen = typeof payload.isOpen === 'boolean' ? payload.isOpen : parsed.isOpen
  const fileSharing = typeof payload.fileSharing === 'boolean' ? payload.fileSharing : parsed.fileSharing
  const isPublic = typeof payload.isPublic === 'boolean' ? payload.isPublic : parsed.isPublic
  const about =
    typeof payload.about === 'string'
      ? payload.about
      : parsed.about
  const discoveryTopic =
    typeof payload.discoveryTopic === 'string'
      ? payload.discoveryTopic
      : null
  const hostPeerKeys = Array.isArray(payload.hostPeerKeys)
    ? payload.hostPeerKeys
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
    : []
  const leaseReplicaPeerKeys = Array.isArray(payload.leaseReplicaPeerKeys)
    ? payload.leaseReplicaPeerKeys
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
    : []
  const writerIssuerPubkey =
    typeof payload.writerIssuerPubkey === 'string'
      ? payload.writerIssuerPubkey.trim().toLowerCase()
      : null
  const writerLeaseEnvelope =
    payload.writerLeaseEnvelope && typeof payload.writerLeaseEnvelope === 'object'
      ? payload.writerLeaseEnvelope as Record<string, unknown>
      : null
  const gatewayAccessPayload =
    payload.gatewayAccess && typeof payload.gatewayAccess === 'object'
      ? payload.gatewayAccess as Record<string, unknown>
      : payload.gateway_access && typeof payload.gateway_access === 'object'
        ? payload.gateway_access as Record<string, unknown>
        : null
  const gatewayAccess = gatewayAccessPayload
    ? {
        version:
          typeof gatewayAccessPayload.version === 'string'
            ? gatewayAccessPayload.version
            : null,
        authMethod:
          typeof gatewayAccessPayload.authMethod === 'string'
            ? gatewayAccessPayload.authMethod
            : typeof gatewayAccessPayload.auth_method === 'string'
              ? gatewayAccessPayload.auth_method
              : null,
        grantId:
          typeof gatewayAccessPayload.grantId === 'string'
            ? gatewayAccessPayload.grantId
            : typeof gatewayAccessPayload.grant_id === 'string'
              ? gatewayAccessPayload.grant_id
              : null,
        gatewayId:
          typeof gatewayAccessPayload.gatewayId === 'string'
            ? gatewayAccessPayload.gatewayId.trim().toLowerCase()
            : typeof gatewayAccessPayload.gateway_id === 'string'
              ? gatewayAccessPayload.gateway_id.trim().toLowerCase()
              : gatewayId,
        gatewayOrigin:
          normalizeHttpOrigin(gatewayAccessPayload.gatewayOrigin)
          || normalizeHttpOrigin(gatewayAccessPayload.gateway_origin)
          || gatewayOrigin,
        scopes: Array.isArray(gatewayAccessPayload.scopes)
          ? Array.from(new Set(
              gatewayAccessPayload.scopes
                .map((entry) => String(entry || '').trim())
                .filter(Boolean)
            ))
          : undefined
      }
    : null

  const authorizedMemberPubkeysRaw = Array.isArray(payload.authorizedMemberPubkeys)
    ? payload.authorizedMemberPubkeys
    : Array.isArray(payload.authorizedMembers)
      ? payload.authorizedMembers
      : Array.isArray(payload.memberPubkeys)
        ? payload.memberPubkeys
        : []
  const authorizedMemberPubkeys = authorizedMemberPubkeysRaw
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))

  const normalizeBlindPeer = (value: unknown): GroupInvite['blindPeer'] => {
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    const maxBytesRaw = Number(candidate.maxBytes)
    return {
      publicKey: typeof candidate.publicKey === 'string'
        ? candidate.publicKey
        : typeof candidate.public_key === 'string'
          ? candidate.public_key
          : null,
      encryptionKey: typeof candidate.encryptionKey === 'string'
        ? candidate.encryptionKey
        : typeof candidate.encryption_key === 'string'
          ? candidate.encryption_key
          : null,
      replicationTopic: typeof candidate.replicationTopic === 'string'
        ? candidate.replicationTopic
        : typeof candidate.replication_topic === 'string'
          ? candidate.replication_topic
          : null,
      maxBytes: Number.isFinite(maxBytesRaw) ? maxBytesRaw : null
    }
  }

  const blindPeer = normalizeBlindPeer(payload.blindPeer)
  const cores = Array.isArray(payload.cores)
    ? payload.cores
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const row = entry as Record<string, unknown>
        const key = String(row.key || '').trim()
        if (!key) return null
        return {
          key,
          role: typeof row.role === 'string' ? row.role : null
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    : undefined

  const writerCore = typeof payload.writerCore === 'string' ? payload.writerCore : null
  let writerCoreHex =
    typeof payload.writerCoreHex === 'string'
      ? payload.writerCoreHex
      : typeof payload.writer_core_hex === 'string'
        ? payload.writer_core_hex
        : null
  let autobaseLocal =
    typeof payload.autobaseLocal === 'string'
      ? payload.autobaseLocal
      : typeof payload.autobase_local === 'string'
        ? payload.autobase_local
        : null
  if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
  if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal
  const writerSecret = typeof payload.writerSecret === 'string' ? payload.writerSecret : null

  const fastForwardPayload =
    payload.fastForward && typeof payload.fastForward === 'object'
      ? payload.fastForward as Record<string, unknown>
      : payload.fast_forward && typeof payload.fast_forward === 'object'
        ? payload.fast_forward as Record<string, unknown>
        : null
  const fastForward = fastForwardPayload
    ? {
        key: typeof fastForwardPayload.key === 'string' ? fastForwardPayload.key : null,
        length: Number.isFinite(Number(fastForwardPayload.length)) ? Number(fastForwardPayload.length) : null,
        signedLength: Number.isFinite(Number(fastForwardPayload.signedLength))
          ? Number(fastForwardPayload.signedLength)
          : null,
        timeoutMs: Number.isFinite(Number(fastForwardPayload.timeoutMs))
          ? Number(fastForwardPayload.timeoutMs)
          : Number.isFinite(Number(fastForwardPayload.timeout))
            ? Number(fastForwardPayload.timeout)
            : null
      }
    : null

  return {
    ...parsed,
    relay,
    relayUrl: relayUrl || null,
    relayKey,
    gatewayId,
    gatewayOrigin,
    gatewayAuthMethod,
    gatewayDelegation,
    directJoinOnly,
    groupName,
    groupPicture,
    name: groupName,
    about,
    isOpen,
    fileSharing,
    isPublic,
    discoveryTopic,
    hostPeerKeys: hostPeerKeys.length ? hostPeerKeys : undefined,
    leaseReplicaPeerKeys: leaseReplicaPeerKeys.length ? leaseReplicaPeerKeys : undefined,
    writerIssuerPubkey,
    writerLeaseEnvelope,
    gatewayAccess,
    authorizedMemberPubkeys: authorizedMemberPubkeys.length ? authorizedMemberPubkeys : undefined,
    blindPeer,
    cores,
    writerCore,
    writerCoreHex,
    autobaseLocal,
    writerSecret,
    fastForward,
    token
  }
}

export function filterActionableGroupInvites(args: {
  invites: GroupInvite[]
  myGroupList: GroupListEntry[]
  dismissedInviteIds?: Set<string>
  acceptedInviteIds?: Set<string>
  acceptedInviteGroupIds?: Set<string>
}): GroupInvite[] {
  const dismissed = args.dismissedInviteIds || new Set<string>()
  const accepted = args.acceptedInviteIds || new Set<string>()
  const acceptedGroups = args.acceptedInviteGroupIds || new Set<string>()
  const joinedGroupIds = new Set(args.myGroupList.map((entry) => entry.groupId))

  const filtered = args.invites.filter((invite) => {
    const inviteId = invite.id || invite.event?.id
    if (inviteId && dismissed.has(inviteId)) return false
    if (inviteId && accepted.has(inviteId)) return false
    if (acceptedGroups.has(invite.groupId)) return false
    if (joinedGroupIds.has(invite.groupId)) return false
    return true
  })

  filtered.sort((left, right) => {
    const leftAt = left.event?.created_at || 0
    const rightAt = right.event?.created_at || 0
    if (leftAt !== rightAt) return rightAt - leftAt
    return left.id.localeCompare(right.id)
  })
  return filtered
}

export function buildInvitesInbox(args: {
  groupInvites: GroupInvite[]
  chatInvites: ChatInvite[]
}): InvitesInboxItem[] {
  const rows: InvitesInboxItem[] = []

  for (const invite of args.groupInvites) {
    rows.push({
      type: 'group',
      id: invite.id,
      createdAt: invite.event?.created_at || 0,
      groupId: invite.groupId,
      title: invite.groupName || invite.groupId,
      relay: invite.relay,
      token: invite.token
    })
  }

  for (const invite of args.chatInvites) {
    rows.push({
      type: 'chat',
      id: invite.id,
      createdAt: invite.createdAt || 0,
      conversationId: invite.conversationId || null,
      title: invite.title || invite.id,
      senderPubkey: invite.senderPubkey,
      status: invite.status
    })
  }

  rows.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return left.id.localeCompare(right.id)
  })

  return rows
}
