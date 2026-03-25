import { getBaseRelayUrl } from '@/lib/hyperpipe-group-events'
import { isWebsocketUrl, normalizeUrl } from '@/lib/url'
import type { TGroupListEntry, TGroupMetadata } from '@/types/groups'

export type RelayDisplayMeta = {
  label?: string | null
  imageUrl?: string | null
  subtitle?: string | null
  hideUrl?: boolean
  isGroupRelay?: boolean
}

export type RelayTarget = {
  relayUrl: string
  relayIdentity: string
}

export type GroupRelayTarget = RelayTarget & {
  groupId: string
  label: string
  imageUrl?: string | null
}

export type BuildGroupRelayTargetsArgs = {
  myGroupList: TGroupListEntry[]
  resolveRelayUrl: (relay?: string) => string | undefined
  getProvisionalGroupMetadata: (groupId: string, relay?: string) => TGroupMetadata | null
  discoveryGroups?: TGroupMetadata[]
}

export type ResolvePublishRelayUrlsArgs = {
  relayUrls: string[]
  resolveRelayUrl: (relay?: string) => string | undefined
  groupRelayTargets?: GroupRelayTarget[]
  refreshGroupRelay?: (
    groupId: string,
    ctx: { relayUrl: string; relayIdentity: string }
  ) => Promise<void>
  requireGroupRelayToken?: boolean
}

const UNNAMED_GROUP_LABEL = 'Unnamed group'

export function normalizeRelayTransportUrl(relay: string): string | null {
  if (typeof relay !== 'string') return null
  const normalized = normalizeUrl(relay)
  if (!normalized || !isWebsocketUrl(normalized)) return null
  return normalized
}

export function getRelayIdentity(relay: string): string | null {
  const normalized = normalizeRelayTransportUrl(relay)
  if (!normalized) return null
  const base = getBaseRelayUrl(normalized)
  return normalizeRelayTransportUrl(base) || normalized
}

export function relayHasAuthToken(relay: string): boolean {
  try {
    const url = new URL(relay)
    const token = url.searchParams.get('token')
    return typeof token === 'string' && token.trim().length > 0
  } catch (_err) {
    return false
  }
}

function preferRelayUrl(current: string, next: string): string {
  const currentHasToken = relayHasAuthToken(current)
  const nextHasToken = relayHasAuthToken(next)
  if (!currentHasToken && nextHasToken) return next
  return current
}

export function dedupeRelayUrlsByIdentity(relays: string[]): string[] {
  const relayByIdentity = new Map<string, string>()
  const relayIdentities: string[] = []

  for (const relay of relays) {
    const normalizedRelay = normalizeRelayTransportUrl(relay)
    if (!normalizedRelay) continue
    const identity = getRelayIdentity(normalizedRelay)
    if (!identity) continue
    const existing = relayByIdentity.get(identity)
    if (!existing) {
      relayByIdentity.set(identity, normalizedRelay)
      relayIdentities.push(identity)
      continue
    }
    relayByIdentity.set(identity, preferRelayUrl(existing, normalizedRelay))
  }

  return relayIdentities.map((identity) => relayByIdentity.get(identity) || '').filter(Boolean)
}

export function dedupeRelayTargetsByIdentity(relays: string[]): RelayTarget[] {
  return dedupeRelayUrlsByIdentity(relays)
    .map((relayUrl) => {
      const relayIdentity = getRelayIdentity(relayUrl)
      if (!relayIdentity) return null
      return {
        relayUrl,
        relayIdentity
      }
    })
    .filter((target): target is RelayTarget => !!target)
}

function normalizeGroupName(name?: string | null): string {
  const trimmed = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) return UNNAMED_GROUP_LABEL
  return trimmed
}

function findDiscoveryMetadata(
  groupId: string,
  relay?: string,
  discoveryGroups: TGroupMetadata[] = []
): TGroupMetadata | null {
  if (!discoveryGroups.length) return null
  const relayIdentity = relay ? getRelayIdentity(relay) : null

  const exact = discoveryGroups.find((group) => {
    if (group.id !== groupId) return false
    if (!relayIdentity || !group.relay) return false
    return getRelayIdentity(group.relay) === relayIdentity
  })
  if (exact) return exact

  return discoveryGroups.find((group) => group.id === groupId) || null
}

export function buildGroupRelayTargets({
  myGroupList,
  resolveRelayUrl,
  getProvisionalGroupMetadata,
  discoveryGroups = []
}: BuildGroupRelayTargetsArgs): GroupRelayTarget[] {
  const targetByIdentity = new Map<string, GroupRelayTarget>()
  const order: string[] = []

  for (const entry of myGroupList) {
    const resolvedRelay = entry.relay ? resolveRelayUrl(entry.relay) || entry.relay : ''
    const relayUrl = normalizeRelayTransportUrl(resolvedRelay)
    if (!relayUrl) continue
    const relayIdentity = getRelayIdentity(relayUrl)
    if (!relayIdentity) continue

    const metadata =
      getProvisionalGroupMetadata(entry.groupId, entry.relay || relayUrl)
      || findDiscoveryMetadata(entry.groupId, entry.relay || relayUrl, discoveryGroups)

    const nextTarget: GroupRelayTarget = {
      groupId: entry.groupId,
      relayUrl,
      relayIdentity,
      label: normalizeGroupName(metadata?.name),
      imageUrl: metadata?.picture || null
    }

    const existing = targetByIdentity.get(relayIdentity)
    if (!existing) {
      targetByIdentity.set(relayIdentity, nextTarget)
      order.push(relayIdentity)
      continue
    }

    targetByIdentity.set(relayIdentity, {
      ...existing,
      relayUrl: preferRelayUrl(existing.relayUrl, nextTarget.relayUrl),
      label: existing.label === UNNAMED_GROUP_LABEL ? nextTarget.label : existing.label,
      imageUrl: existing.imageUrl || nextTarget.imageUrl
    })
  }

  return order
    .map((identity) => targetByIdentity.get(identity))
    .filter((target): target is GroupRelayTarget => !!target)
}

function appendMeta(target: Record<string, RelayDisplayMeta>, relay: string, meta: RelayDisplayMeta) {
  const normalized = normalizeRelayTransportUrl(relay)
  if (!normalized) return
  target[normalized] = meta
  const identity = getRelayIdentity(normalized)
  if (identity) {
    target[identity] = meta
  }
  const base = getBaseRelayUrl(normalized)
  const normalizedBase = normalizeRelayTransportUrl(base)
  if (normalizedBase) {
    target[normalizedBase] = meta
  }
}

export function buildGroupRelayDisplayMetaMap(groupRelayTargets: GroupRelayTarget[]) {
  const relayDisplayMeta: Record<string, RelayDisplayMeta> = {}

  for (const relayTarget of groupRelayTargets) {
    const meta: RelayDisplayMeta = {
      label: relayTarget.label,
      imageUrl: relayTarget.imageUrl || null,
      hideUrl: true,
      isGroupRelay: true
    }
    appendMeta(relayDisplayMeta, relayTarget.relayUrl, meta)
  }

  return relayDisplayMeta
}

export function mergeRelayDisplayMetaMaps(
  ...maps: Array<Record<string, RelayDisplayMeta> | undefined | null>
): Record<string, RelayDisplayMeta> {
  const merged: Record<string, RelayDisplayMeta> = {}
  for (const map of maps) {
    if (!map) continue
    for (const [relay, meta] of Object.entries(map)) {
      appendMeta(merged, relay, meta || {})
    }
  }
  return merged
}

export async function resolvePublishRelayUrls({
  relayUrls,
  resolveRelayUrl,
  groupRelayTargets = [],
  refreshGroupRelay,
  requireGroupRelayToken = true
}: ResolvePublishRelayUrlsArgs): Promise<string[]> {
  const targetsByIdentity = new Map<string, GroupRelayTarget>()
  groupRelayTargets.forEach((target) => {
    targetsByIdentity.set(target.relayIdentity, target)
  })

  const resolvedByIdentity = new Map<string, string>()
  const order: string[] = []

  for (const inputRelay of relayUrls) {
    const initialRelay = normalizeRelayTransportUrl(resolveRelayUrl(inputRelay) || inputRelay)
    if (!initialRelay) continue
    const initialIdentity = getRelayIdentity(initialRelay)
    if (!initialIdentity) continue

    let resolvedRelay = initialRelay
    const groupTarget = targetsByIdentity.get(initialIdentity)

    if (groupTarget && requireGroupRelayToken && !relayHasAuthToken(resolvedRelay)) {
      if (refreshGroupRelay) {
        await refreshGroupRelay(groupTarget.groupId, {
          relayUrl: groupTarget.relayUrl,
          relayIdentity: groupTarget.relayIdentity
        })
      }

      resolvedRelay =
        normalizeRelayTransportUrl(
          resolveRelayUrl(inputRelay)
          || resolveRelayUrl(groupTarget.relayUrl)
          || groupTarget.relayUrl
        ) || resolvedRelay

      if (!relayHasAuthToken(resolvedRelay)) {
        throw new Error(`Missing auth token for group relay: ${groupTarget.label}`)
      }
    }

    const resolvedIdentity = getRelayIdentity(resolvedRelay) || initialIdentity
    if (!resolvedByIdentity.has(resolvedIdentity)) {
      resolvedByIdentity.set(resolvedIdentity, resolvedRelay)
      order.push(resolvedIdentity)
      continue
    }

    resolvedByIdentity.set(
      resolvedIdentity,
      preferRelayUrl(resolvedByIdentity.get(resolvedIdentity) || resolvedRelay, resolvedRelay)
    )
  }

  return order.map((identity) => resolvedByIdentity.get(identity) || '').filter(Boolean)
}
