import type { Event, EventTemplate } from 'nostr-tools'

export const HYPERTUNA_IDENTIFIER_TAG = 'hypertuna:relay'

export const KIND_GROUP_CREATE = 9007
export const KIND_GROUP_METADATA = 39000
export const KIND_GROUP_ADMIN_LIST = 39001
export const KIND_GROUP_MEMBER_LIST = 39002
export const KIND_HYPERTUNA_RELAY = 30166
export const HYPERTUNA_GATEWAY_TAG = 'gateway'
export const HYPERTUNA_TOPIC_TAG = 'hypertuna-topic'
export const HYPERTUNA_HOST_PEER_TAG = 'hypertuna-host-peer'
export const HYPERTUNA_WRITER_ISSUER_TAG = 'hypertuna-writer-issuer'
export const HYPERTUNA_LEASE_REPLICA_PEER_TAG = 'hypertuna-lease-replica-peer'

export function normalizeGatewayOrigin(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.origin
  } catch (_err) {
    return null
  }
}

export function getBaseRelayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('token')
    return parsed.toString().replace(/\?$/, '')
  } catch {
    return String(url || '').split('?')[0]
  }
}

function tagValue(tags: string[][], name: string): string | null {
  const found = tags.find((tag) => tag[0] === name)
  return typeof found?.[1] === 'string' ? found[1] : null
}

export function parseHypertunaRelayEvent30166(event: Pick<Event, 'kind' | 'tags'>): { publicIdentifier: string; wsUrl: string } | null {
  if (event.kind !== KIND_HYPERTUNA_RELAY) return null
  const wsUrl = tagValue(event.tags as string[][], 'd')
  const publicIdentifier =
    tagValue(event.tags as string[][], 'h')
    || tagValue(event.tags as string[][], 'hypertuna')

  if (!wsUrl || !publicIdentifier) return null

  return {
    publicIdentifier,
    wsUrl
  }
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
  gatewayOrigin?: string | null
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  leaseReplicaPeerKeys?: string[]
}): { groupCreateEvent: EventTemplate; metadataEvent: EventTemplate; hypertunaEvent: EventTemplate } {
  const now = Math.floor(Date.now() / 1000)
  const fileSharingEnabled = args.fileSharing !== false

  const groupTags: string[][] = [
    ['h', args.publicIdentifier],
    ['name', args.name],
    ['about', args.about || ''],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    groupTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
  }

  const metadataTags: string[][] = [
    ['d', args.publicIdentifier],
    ['h', args.publicIdentifier],
    ['name', args.name],
    ['about', args.about || ''],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    metadataTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
  }
  const rawGatewayRoute =
    typeof args.gatewayOrigin === 'string'
      ? args.gatewayOrigin.trim()
      : args.gatewayOrigin === null
        ? 'none'
        : ''
  const normalizedGatewayOrigin = normalizeGatewayOrigin(rawGatewayRoute)
  if (/^(none|null|disabled|direct-only)$/i.test(rawGatewayRoute)) {
    metadataTags.push([HYPERTUNA_GATEWAY_TAG, 'none'])
  } else if (normalizedGatewayOrigin) {
    metadataTags.push([HYPERTUNA_GATEWAY_TAG, normalizedGatewayOrigin])
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

  return {
    groupCreateEvent: {
      kind: KIND_GROUP_CREATE,
      created_at: now,
      tags: groupTags,
      content: `Created group: ${args.name}`
    },
    metadataEvent: {
      kind: KIND_GROUP_METADATA,
      created_at: now,
      tags: metadataTags,
      content: `Group metadata for: ${args.name}`
    },
    hypertunaEvent: {
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
  }
}

export function buildHypertunaAdminBootstrapDraftEvents(args: {
  publicIdentifier: string
  adminPubkeyHex: string
  name: string
}): { adminListEvent: EventTemplate; memberListEvent: EventTemplate } {
  const now = Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['h', args.publicIdentifier],
    ['d', args.publicIdentifier],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    ['p', args.adminPubkeyHex, 'admin']
  ]

  return {
    adminListEvent: {
      kind: KIND_GROUP_ADMIN_LIST,
      created_at: now,
      tags,
      content: `Admin list for group: ${args.name}`
    },
    memberListEvent: {
      kind: KIND_GROUP_MEMBER_LIST,
      created_at: now,
      tags,
      content: `Member list for group: ${args.name}`
    }
  }
}
