import { Event } from '@nostr/tools/wasm'
import { TDraftEvent } from '@/types'

export const HYPERPIPE_IDENTIFIER_TAG = 'hyperpipe:relay'

export const KIND_GROUP_CREATE = 9007
export const KIND_GROUP_METADATA = 39000
export const KIND_GROUP_ADMIN_LIST = 39001
export const KIND_GROUP_MEMBER_LIST = 39002
export const KIND_HYPERPIPE_RELAY = 30166
export const HYPERPIPE_TOPIC_TAG = 'hyperpipe-topic'
export const HYPERPIPE_HOST_PEER_TAG = 'hyperpipe-host-peer'
export const HYPERPIPE_WRITER_ISSUER_TAG = 'hyperpipe-writer-issuer'
export const HYPERPIPE_LEASE_REPLICA_PEER_TAG = 'hyperpipe-lease-replica-peer'
export const HYPERPIPE_GATEWAY_ID_TAG = 'hyperpipe-gateway-id'
export const HYPERPIPE_GATEWAY_ORIGIN_TAG = 'hyperpipe-gateway-origin'
export const HYPERPIPE_GATEWAY_AUTH_METHOD_TAG = 'hyperpipe-gateway-auth-method'
export const HYPERPIPE_GATEWAY_DELEGATION_TAG = 'hyperpipe-gateway-delegation'
export const HYPERPIPE_GATEWAY_SPONSOR_TAG = 'hyperpipe-gateway-sponsor'
export const HYPERPIPE_DIRECT_JOIN_ONLY_TAG = 'hyperpipe-direct-join-only'

export function getBaseRelayUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('token')
    return u.toString().replace(/\?$/, '')
  } catch {
    return String(url || '').split('?')[0]
  }
}

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

function hasIdentifierTag(tags: string[][]): boolean {
  return tags.some((t) => t[0] === 'i' && t[1] === HYPERPIPE_IDENTIFIER_TAG)
}

export function isHyperpipeTaggedEvent(event: Pick<Event, 'tags'> | null | undefined): boolean {
  const tags = event?.tags
  if (!Array.isArray(tags)) return false
  return hasIdentifierTag(tags as any)
}

function getTagValue(event: Pick<Event, 'tags'>, tagName: string): string | null {
  const tags = (event.tags || []) as any
  const found = tags.find((t: any) => Array.isArray(t) && t[0] === tagName)
  return typeof found?.[1] === 'string' ? found[1] : null
}

export function parseHyperpipeRelayEvent30166(
  event: Pick<Event, 'kind' | 'tags'>
): { publicIdentifier: string; wsUrl: string } | null {
  if (event.kind !== KIND_HYPERPIPE_RELAY) return null
  const wsUrl = getTagValue(event, 'd')
  const publicIdentifier = getTagValue(event, 'h') || getTagValue(event, 'hyperpipe')
  if (!wsUrl || !publicIdentifier) return null
  return { publicIdentifier, wsUrl }
}

export function buildHyperpipeDiscoveryDraftEvents(args: {
  publicIdentifier: string
  name: string
  about?: string
  isPublic: boolean
  isOpen: boolean
  fileSharing?: boolean
  relayWsUrl: string
  pictureTagUrl?: string
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  leaseReplicaPeerKeys?: string[]
  gatewayId?: string | null
  gatewayOrigin?: string | null
  gatewayAuthMethod?: string | null
  gatewayDelegation?: string | null
  gatewaySponsorPubkey?: string | null
  directJoinOnly?: boolean
}): { groupCreateEvent: TDraftEvent; metadataEvent: TDraftEvent; hyperpipeEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const fileSharingEnabled = args.fileSharing !== false

  const groupTags: string[][] = [
    ['h', args.publicIdentifier],
    ['name', String(args.name)],
    ['about', args.about ? String(args.about) : ''],
    ['hyperpipe', args.publicIdentifier],
    ['i', HYPERPIPE_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    groupTags.push(['picture', args.pictureTagUrl, 'hyperpipe:drive:pfp'])
  }

  const groupCreateEvent: TDraftEvent = {
    kind: KIND_GROUP_CREATE,
    created_at: now,
    tags: groupTags,
    content: `Created group: ${args.name}`
  }

  const metadataTags: string[][] = [
    ['d', args.publicIdentifier],
    ['h', args.publicIdentifier],
    ['name', String(args.name)],
    ['about', args.about ? String(args.about) : ''],
    ['hyperpipe', args.publicIdentifier],
    ['i', HYPERPIPE_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    metadataTags.push(['picture', args.pictureTagUrl, 'hyperpipe:drive:pfp'])
  }
  const gatewayId = typeof args.gatewayId === 'string' ? args.gatewayId.trim().toLowerCase() : ''
  const gatewayOrigin = normalizeHttpOrigin(args.gatewayOrigin || null)
  if (gatewayId) {
    metadataTags.push([HYPERPIPE_GATEWAY_ID_TAG, gatewayId])
  }
  if (gatewayOrigin) {
    metadataTags.push([HYPERPIPE_GATEWAY_ORIGIN_TAG, gatewayOrigin])
  }
  const gatewayAuthMethod = typeof args.gatewayAuthMethod === 'string' ? args.gatewayAuthMethod.trim() : ''
  const gatewayDelegation = typeof args.gatewayDelegation === 'string' ? args.gatewayDelegation.trim() : ''
  const gatewaySponsorPubkey = typeof args.gatewaySponsorPubkey === 'string'
    ? args.gatewaySponsorPubkey.trim().toLowerCase()
    : ''
  if (gatewayAuthMethod) {
    metadataTags.push([HYPERPIPE_GATEWAY_AUTH_METHOD_TAG, gatewayAuthMethod])
  }
  if (gatewayDelegation) {
    metadataTags.push([HYPERPIPE_GATEWAY_DELEGATION_TAG, gatewayDelegation])
  }
  if (gatewaySponsorPubkey) {
    metadataTags.push([HYPERPIPE_GATEWAY_SPONSOR_TAG, gatewaySponsorPubkey])
  }
  if (args.directJoinOnly === true) {
    metadataTags.push([HYPERPIPE_DIRECT_JOIN_ONLY_TAG, '1'])
  }
  if (args.isPublic && args.isOpen) {
    if (typeof args.discoveryTopic === 'string' && args.discoveryTopic.trim()) {
      metadataTags.push([HYPERPIPE_TOPIC_TAG, args.discoveryTopic.trim()])
    }
    const hostPeerKeys = Array.from(
      new Set(
        (Array.isArray(args.hostPeerKeys) ? args.hostPeerKeys : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
      )
    )
    hostPeerKeys.forEach((peerKey) => {
      metadataTags.push([HYPERPIPE_HOST_PEER_TAG, peerKey])
    })
    const writerIssuer = typeof args.writerIssuerPubkey === 'string'
      ? args.writerIssuerPubkey.trim().toLowerCase()
      : ''
    if (writerIssuer) {
      metadataTags.push([HYPERPIPE_WRITER_ISSUER_TAG, writerIssuer])
    }
    const leaseReplicaPeers = Array.from(
      new Set(
        (Array.isArray(args.leaseReplicaPeerKeys) ? args.leaseReplicaPeerKeys : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
      )
    ).slice(0, 8)
    leaseReplicaPeers.forEach((peerKey) => {
      metadataTags.push([HYPERPIPE_LEASE_REPLICA_PEER_TAG, peerKey])
    })
  }

  const metadataEvent: TDraftEvent = {
    kind: KIND_GROUP_METADATA,
    created_at: now,
    tags: metadataTags,
    content: `Group metadata for: ${args.name}`
  }

  const hyperpipeEvent: TDraftEvent = {
    kind: KIND_HYPERPIPE_RELAY,
    created_at: now,
    tags: [
      ['d', args.relayWsUrl],
      ['hyperpipe', args.publicIdentifier],
      ['h', args.publicIdentifier],
      ['i', HYPERPIPE_IDENTIFIER_TAG]
    ],
    content: `Hyperpipe relay for group: ${args.name}`
  }

  return { groupCreateEvent, metadataEvent, hyperpipeEvent }
}

export function buildHyperpipeAdminBootstrapDraftEvents(args: {
  publicIdentifier: string
  adminPubkeyHex: string
  name: string
}): { adminListEvent: TDraftEvent; memberListEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['h', args.publicIdentifier],
    ['d', args.publicIdentifier],
    ['hyperpipe', args.publicIdentifier],
    ['i', HYPERPIPE_IDENTIFIER_TAG],
    ['p', args.adminPubkeyHex, 'admin']
  ]

  const adminListEvent: TDraftEvent = {
    kind: KIND_GROUP_ADMIN_LIST,
    created_at: now,
    tags,
    content: `Admin list for group: ${args.name}`
  }

  const memberListEvent: TDraftEvent = {
    kind: KIND_GROUP_MEMBER_LIST,
    created_at: now,
    tags,
    content: `Member list for group: ${args.name}`
  }

  return { adminListEvent, memberListEvent }
}
