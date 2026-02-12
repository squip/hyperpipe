import type { Event } from 'nostr-tools'
import type { ChatInvite, GroupInvite, GroupJoinRequest, GroupListEntry, GroupSummary, InvitesInboxItem } from '../types.js'
import { parseGroupIdentifier, parseGroupInviteEvent, parseGroupMetadataEvent } from '../../lib/groups.js'
import {
  getBaseRelayUrl,
  HYPERTUNA_IDENTIFIER_TAG,
  parseHypertunaRelayEvent30166
} from '../../lib/hypertuna-group-events.js'

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

export function isHypertunaTaggedEvent(event: Event): boolean {
  return hasTag(event, 'i', HYPERTUNA_IDENTIFIER_TAG) || hasTag(event, 'hypertuna')
}

export function buildRelayUrlByPublicIdentifier(relayEvents: Event[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const event of relayEvents) {
    const parsed = parseHypertunaRelayEvent30166(event)
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
    if (isHypertunaTaggedEvent(event)) {
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
  const relay =
    typeof payload.relayUrl === 'string'
      ? payload.relayUrl
      : typeof payload.relay === 'string'
        ? payload.relay
        : parsed.relay
  const token = typeof payload.token === 'string' ? payload.token : undefined
  const fileSharing = typeof payload.fileSharing === 'boolean' ? payload.fileSharing : parsed.fileSharing
  const isPublic = typeof payload.isPublic === 'boolean' ? payload.isPublic : parsed.isPublic

  return {
    ...parsed,
    relay,
    groupName,
    groupPicture,
    fileSharing,
    isPublic,
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
