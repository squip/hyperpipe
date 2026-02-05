import { Event } from '@nostr/tools/wasm'
import {
  TGroupAdmin,
  TGroupIdentifier,
  TGroupInvite,
  TGroupListEntry,
  TGroupMetadata,
  TGroupMembershipStatus,
  TGroupRoles,
  TJoinRequest
} from '@/types/groups'

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

export function parseGroupMetadataEvent(event: Event, relay?: string): TGroupMetadata {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  const name = event.tags.find((t) => t[0] === 'name')?.[1] ?? (d || 'Untitled Group')
  const about = event.tags.find((t) => t[0] === 'about')?.[1]
  const picture = event.tags.find((t) => t[0] === 'picture')?.[1]
  const isPublic = event.tags.some((t) => t[0] === 'public')
  const isOpen = event.tags.some((t) => t[0] === 'open')
  const tags = event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1])

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    tags,
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
  return null
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
  const {
    snapshotMembers = [],
    snapshotCreatedAt = null,
    membershipEvents = []
  } = args

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
    const targets = evt.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
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
  const fileSharingOn = event.tags.some((t) => t[0] === 'file-sharing-on')
  return {
    groupId,
    relay,
    groupName: name,
    groupPicture: picture,
    name,
    about,
    fileSharing: fileSharingOn,
    // Token is encrypted in content per requirements; decrypted elsewhere
    token: undefined,
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
    if (evt.kind !== 9000 && evt.kind !== 9001) continue
    const targetsPubkey = evt.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey)
    if (!targetsPubkey) continue
    if (!latestMembershipEvent || evt.created_at > latestMembershipEvent.created_at) {
      latestMembershipEvent = evt
      continue
    }
    if (
      latestMembershipEvent &&
      evt.created_at === latestMembershipEvent.created_at &&
      evt.kind === 9001 &&
      latestMembershipEvent.kind !== 9001
    ) {
      latestMembershipEvent = evt
    }
  }

  if (latestMembershipEvent) {
    if (latestMembershipEvent.kind === 9000) return 'member'
    if (latestMembershipEvent.kind === 9001) return 'removed'
  }

  const latestRequest = joinRequests
    .filter((evt) => evt.kind === 9021 && evt.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0]

  if (latestRequest) {
    return 'pending'
  }

  return 'not-member'
}
