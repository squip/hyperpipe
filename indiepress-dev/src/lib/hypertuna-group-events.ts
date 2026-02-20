import { Event } from '@nostr/tools/wasm'
import { TDraftEvent } from '@/types'

export const HYPERTUNA_IDENTIFIER_TAG = 'hypertuna:relay'

export const KIND_GROUP_CREATE = 9007
export const KIND_GROUP_METADATA = 39000
export const KIND_GROUP_ADMIN_LIST = 39001
export const KIND_GROUP_MEMBER_LIST = 39002
export const KIND_HYPERTUNA_RELAY = 30166

export type HypertunaGatewayTag = {
  origin: string
  operatorPubkey: string
  policy: 'OPEN' | 'CLOSED'
}

export function getBaseRelayUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('token')
    return u.toString().replace(/\?$/, '')
  } catch {
    return String(url || '').split('?')[0]
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

export function normalizeGatewayOrigin(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch (_err) {
    return null
  }
}

export function normalizeGatewayPolicy(value: string | null | undefined): 'OPEN' | 'CLOSED' {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return upper === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

export function normalizeGatewayPubkey(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null
  return trimmed
}

export function normalizeGatewayTags(tags: string[][] | null | undefined): HypertunaGatewayTag[] {
  const gateways: HypertunaGatewayTag[] = []
  const seen = new Set<string>()
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!Array.isArray(tag) || tag[0] !== 'gateway') continue
    const origin = normalizeGatewayOrigin(tag[1])
    const operatorPubkey = normalizeGatewayPubkey(tag[2])
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

export function buildGatewayTags(gateways: HypertunaGatewayTag[] | undefined): string[][] {
  const tags: string[][] = []
  for (const gateway of Array.isArray(gateways) ? gateways : []) {
    const origin = normalizeGatewayOrigin(gateway?.origin)
    const operatorPubkey = normalizeGatewayPubkey(gateway?.operatorPubkey)
    if (!origin || !operatorPubkey) continue
    tags.push(['gateway', origin, operatorPubkey, normalizeGatewayPolicy(gateway?.policy)])
  }
  return tags
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
  gateways?: HypertunaGatewayTag[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  writerIssuerPubkey?: string | null
}): { groupCreateEvent: TDraftEvent; metadataEvent: TDraftEvent; hypertunaEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const fileSharingEnabled = args.fileSharing !== false
  const discoveryTopic =
    typeof args.discoveryTopic === 'string' && /^[a-f0-9]{64}$/i.test(args.discoveryTopic.trim())
      ? args.discoveryTopic.trim().toLowerCase()
      : null
  const hostPeerKeys = Array.from(
    new Set(
      (Array.isArray(args.hostPeerKeys) ? args.hostPeerKeys : [])
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
    )
  )
  const writerIssuerPubkey =
    typeof args.writerIssuerPubkey === 'string' && /^[a-f0-9]{64}$/i.test(args.writerIssuerPubkey.trim())
      ? args.writerIssuerPubkey.trim().toLowerCase()
      : null

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
  if (discoveryTopic) groupTags.push(['swarm-topic', discoveryTopic])
  hostPeerKeys.forEach((peerKey) => groupTags.push(['host-peer', peerKey]))
  if (writerIssuerPubkey) groupTags.push(['writer-issuer', writerIssuerPubkey])
  groupTags.push(...buildGatewayTags(args.gateways))

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
  if (discoveryTopic) metadataTags.push(['swarm-topic', discoveryTopic])
  hostPeerKeys.forEach((peerKey) => metadataTags.push(['host-peer', peerKey]))
  if (writerIssuerPubkey) metadataTags.push(['writer-issuer', writerIssuerPubkey])
  metadataTags.push(...buildGatewayTags(args.gateways))

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
