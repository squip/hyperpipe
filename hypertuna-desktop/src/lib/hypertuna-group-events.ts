import { Event } from '@nostr/tools/wasm'
import { TDraftEvent } from '@/types'

export const HYPERTUNA_IDENTIFIER_TAG = 'hypertuna:relay'

export const KIND_GROUP_CREATE = 9007
export const KIND_GROUP_METADATA = 39000
export const KIND_GROUP_ADMIN_LIST = 39001
export const KIND_GROUP_MEMBER_LIST = 39002
export const KIND_HYPERTUNA_RELAY = 30166
export const HYPERTUNA_TOPIC_TAG = 'hypertuna-topic'
export const HYPERTUNA_HOST_PEER_TAG = 'hypertuna-host-peer'
export const HYPERTUNA_WRITER_ISSUER_TAG = 'hypertuna-writer-issuer'
export const HYPERTUNA_LEASE_REPLICA_PEER_TAG = 'hypertuna-lease-replica-peer'
export const HYPERTUNA_GATEWAY_ID_TAG = 'hypertuna-gateway-id'
export const HYPERTUNA_GATEWAY_ORIGIN_TAG = 'hypertuna-gateway-origin'
export const HYPERTUNA_GATEWAY_AUTH_METHOD_TAG = 'hypertuna-gateway-auth-method'
export const HYPERTUNA_GATEWAY_DELEGATION_TAG = 'hypertuna-gateway-delegation'
export const HYPERTUNA_GATEWAY_SPONSOR_TAG = 'hypertuna-gateway-sponsor'
export const HYPERTUNA_DIRECT_JOIN_ONLY_TAG = 'hypertuna-direct-join-only'

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
  return tags.some((t) => t[0] === 'i' && t[1] === HYPERTUNA_IDENTIFIER_TAG)
}

export function isHypertunaTaggedEvent(event: Pick<Event, 'tags'> | null | undefined): boolean {
  const tags = event?.tags
  if (!Array.isArray(tags)) return false
  return hasIdentifierTag(tags as any)
}

function getTagValue(event: Pick<Event, 'tags'>, tagName: string): string | null {
  const tags = (event.tags || []) as any
  const found = tags.find((t: any) => Array.isArray(t) && t[0] === tagName)
  return typeof found?.[1] === 'string' ? found[1] : null
}

export function parseHypertunaRelayEvent30166(
  event: Pick<Event, 'kind' | 'tags'>
): { publicIdentifier: string; wsUrl: string } | null {
  if (event.kind !== KIND_HYPERTUNA_RELAY) return null
  const wsUrl = getTagValue(event, 'd')
  const publicIdentifier = getTagValue(event, 'h') || getTagValue(event, 'hypertuna')
  if (!wsUrl || !publicIdentifier) return null
  return { publicIdentifier, wsUrl }
}

export function buildHypertunaDiscoveryDraftEvents(args: {
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
}): { groupCreateEvent: TDraftEvent; metadataEvent: TDraftEvent; hypertunaEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const fileSharingEnabled = args.fileSharing !== false

  const groupTags: string[][] = [
    ['h', args.publicIdentifier],
    ['name', String(args.name)],
    ['about', args.about ? String(args.about) : ''],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    groupTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
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
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    metadataTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
  }
  const gatewayId = typeof args.gatewayId === 'string' ? args.gatewayId.trim().toLowerCase() : ''
  const gatewayOrigin = normalizeHttpOrigin(args.gatewayOrigin || null)
  if (gatewayId) {
    metadataTags.push([HYPERTUNA_GATEWAY_ID_TAG, gatewayId])
  }
  if (gatewayOrigin) {
    metadataTags.push([HYPERTUNA_GATEWAY_ORIGIN_TAG, gatewayOrigin])
  }
  const gatewayAuthMethod = typeof args.gatewayAuthMethod === 'string' ? args.gatewayAuthMethod.trim() : ''
  const gatewayDelegation = typeof args.gatewayDelegation === 'string' ? args.gatewayDelegation.trim() : ''
  const gatewaySponsorPubkey = typeof args.gatewaySponsorPubkey === 'string'
    ? args.gatewaySponsorPubkey.trim().toLowerCase()
    : ''
  if (gatewayAuthMethod) {
    metadataTags.push([HYPERTUNA_GATEWAY_AUTH_METHOD_TAG, gatewayAuthMethod])
  }
  if (gatewayDelegation) {
    metadataTags.push([HYPERTUNA_GATEWAY_DELEGATION_TAG, gatewayDelegation])
  }
  if (gatewaySponsorPubkey) {
    metadataTags.push([HYPERTUNA_GATEWAY_SPONSOR_TAG, gatewaySponsorPubkey])
  }
  if (args.directJoinOnly === true) {
    metadataTags.push([HYPERTUNA_DIRECT_JOIN_ONLY_TAG, '1'])
  }
  if (args.isPublic && args.isOpen) {
    if (typeof args.discoveryTopic === 'string' && args.discoveryTopic.trim()) {
      metadataTags.push([HYPERTUNA_TOPIC_TAG, args.discoveryTopic.trim()])
    }
    const hostPeerKeys = Array.from(
      new Set(
        (Array.isArray(args.hostPeerKeys) ? args.hostPeerKeys : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
      )
    )
    hostPeerKeys.forEach((peerKey) => {
      metadataTags.push([HYPERTUNA_HOST_PEER_TAG, peerKey])
    })
    const writerIssuer = typeof args.writerIssuerPubkey === 'string'
      ? args.writerIssuerPubkey.trim().toLowerCase()
      : ''
    if (writerIssuer) {
      metadataTags.push([HYPERTUNA_WRITER_ISSUER_TAG, writerIssuer])
    }
    const leaseReplicaPeers = Array.from(
      new Set(
        (Array.isArray(args.leaseReplicaPeerKeys) ? args.leaseReplicaPeerKeys : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
      )
    ).slice(0, 8)
    leaseReplicaPeers.forEach((peerKey) => {
      metadataTags.push([HYPERTUNA_LEASE_REPLICA_PEER_TAG, peerKey])
    })
  }

  const metadataEvent: TDraftEvent = {
    kind: KIND_GROUP_METADATA,
    created_at: now,
    tags: metadataTags,
    content: `Group metadata for: ${args.name}`
  }

  const hypertunaEvent: TDraftEvent = {
    kind: KIND_HYPERTUNA_RELAY,
    created_at: now,
    tags: [
      ['d', args.relayWsUrl],
      ['hypertuna', args.publicIdentifier],
      ['h', args.publicIdentifier],
      ['i', HYPERTUNA_IDENTIFIER_TAG]
    ],
    content: `Hypertuna relay for group: ${args.name}`
  }

  return { groupCreateEvent, metadataEvent, hypertunaEvent }
}

export function buildHypertunaAdminBootstrapDraftEvents(args: {
  publicIdentifier: string
  adminPubkeyHex: string
  name: string
}): { adminListEvent: TDraftEvent; memberListEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['h', args.publicIdentifier],
    ['d', args.publicIdentifier],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
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
