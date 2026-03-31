import type { GatewayStatus, PublicGatewayStatus } from '@/services/electron-ipc.service'

type GatewayAccessCatalogEntry = NonNullable<PublicGatewayStatus['gatewayAccessCatalog']>[number]
type DiscoveredGatewayEntry = NonNullable<PublicGatewayStatus['discoveredGateways']>[number]
type AuthorizedGatewayEntry = NonNullable<PublicGatewayStatus['authorizedGateways']>[number]
type PublicGatewayRelayEntry = NonNullable<PublicGatewayStatus['relays']>[string]

export type PublicGatewayRelaySummary = {
  key: string
  label: string
  subtitle: string | null
  statusLabel: string
  lastSyncedAt: number | null
  error: string | null
}

export type PublicGatewayCard = {
  key: string
  title: string
  subtitle: string | null
  statusLabel: 'Approved' | 'Not approved' | 'Unavailable'
  badgeVariant: 'default' | 'destructive' | 'outline'
  detail: string | null
  lastCheckedAt: number | null
  relays: PublicGatewayRelaySummary[]
}

export type PublicGatewayPanelModel = {
  approvedCount: number
  lastUpdatedAt: number | null
  warning: string | null
  cards: PublicGatewayCard[]
}

type GatewayCardSeed = {
  key: string
  title: string
  subtitle: string | null
  statusLabel: PublicGatewayCard['statusLabel']
  badgeVariant: PublicGatewayCard['badgeVariant']
  detail: string | null
  lastCheckedAt: number | null
  relays: PublicGatewayRelaySummary[]
}

function getRelayStatusRank(statusLabel: string) {
  switch (String(statusLabel || '').trim().toLowerCase()) {
    case 'connected':
      return 0
    case 'pending':
      return 1
    case 'offline':
      return 2
    case 'error':
      return 3
    default:
      return 4
  }
}

function normalizeGatewayKey(gatewayId?: string | null, gatewayOrigin?: string | null) {
  const origin = String(gatewayOrigin || '').trim().toLowerCase().replace(/\/$/, '')
  if (origin) return `origin:${origin}`
  const id = String(gatewayId || '').trim().toLowerCase()
  if (id) return `id:${id}`
  return null
}

function isInternalPublicGatewayRelay(relayKey?: string | null, entry?: PublicGatewayRelayEntry | null) {
  const normalizedRelayKey = String(relayKey || '').trim().toLowerCase()
  const publicIdentifier = String(entry?.publicIdentifier || '').trim().toLowerCase()
  return normalizedRelayKey.startsWith('public-gateway:') || publicIdentifier.startsWith('public-gateway:')
}

function formatGatewayStatus(hostingState?: string | null): Pick<PublicGatewayCard, 'statusLabel' | 'badgeVariant' | 'detail'> {
  const value = String(hostingState || '').trim().toLowerCase()
  if (value === 'approved') {
    return {
      statusLabel: 'Approved',
      badgeVariant: 'default',
      detail: 'Approved for group hosting'
    }
  }
  if (value === 'denied') {
    return {
      statusLabel: 'Not approved',
      badgeVariant: 'destructive',
      detail: 'Not approved for group hosting'
    }
  }
  return {
    statusLabel: 'Unavailable',
    badgeVariant: 'outline',
    detail: 'Unavailable right now'
  }
}

function formatRelayStatus(status?: string | null) {
  const value = String(status || '').trim().toLowerCase()
  switch (value) {
    case 'registered':
      return 'Connected'
    case 'offline':
      return 'Offline'
    case 'error':
      return 'Error'
    case 'pending':
      return 'Pending'
    default:
      return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Unknown'
  }
}

function getGatewayTitle(entry: {
  displayName?: string | null
  publicUrl?: string | null
  gatewayOrigin?: string | null
  gatewayId?: string | null
}) {
  return (
    String(entry.displayName || '').trim()
    || String(entry.publicUrl || '').trim()
    || String(entry.gatewayOrigin || '').trim()
    || String(entry.gatewayId || '').trim()
    || 'Unknown gateway'
  )
}

function getGatewaySubtitle(entry: {
  displayName?: string | null
  publicUrl?: string | null
  gatewayOrigin?: string | null
}) {
  const title = String(entry.displayName || '').trim()
  const origin = String(entry.publicUrl || entry.gatewayOrigin || '').trim()
  if (!origin) return null
  if (title && title === origin) return null
  return origin
}

function ensureGatewayCard(
  cards: Map<string, GatewayCardSeed>,
  key: string,
  seed: Omit<GatewayCardSeed, 'key' | 'relays'> & { relays?: PublicGatewayRelaySummary[] }
) {
  const existing = cards.get(key)
  if (existing) {
    const nextStatus = existing.statusLabel === 'Approved'
      ? existing
      : seed.statusLabel === 'Approved'
        ? {
          ...existing,
          statusLabel: seed.statusLabel,
          badgeVariant: seed.badgeVariant,
          detail: seed.detail || existing.detail
        }
        : seed.statusLabel === 'Not approved' && existing.statusLabel === 'Unavailable'
          ? {
            ...existing,
            statusLabel: seed.statusLabel,
            badgeVariant: seed.badgeVariant,
            detail: seed.detail || existing.detail
          }
          : existing
    cards.set(key, {
      ...nextStatus,
      title:
        existing.title === 'Unknown gateway'
        || /^https?:\/\//i.test(existing.title)
        || (existing.subtitle && existing.title === existing.subtitle)
          ? seed.title || existing.title
          : existing.title || seed.title,
      subtitle:
        existing.subtitle
        && !/^https?:\/\//i.test(existing.subtitle)
          ? existing.subtitle
          : existing.subtitle || seed.subtitle,
      lastCheckedAt: seed.lastCheckedAt ?? existing.lastCheckedAt,
      relays: existing.relays
    })
    return
  }

  cards.set(key, {
    key,
    title: seed.title,
    subtitle: seed.subtitle,
    statusLabel: seed.statusLabel,
    badgeVariant: seed.badgeVariant,
    detail: seed.detail,
    lastCheckedAt: seed.lastCheckedAt,
    relays: seed.relays || []
  })
}

function addGatewayFromAccessCatalog(cards: Map<string, GatewayCardSeed>, entry: GatewayAccessCatalogEntry) {
  const key = normalizeGatewayKey(entry?.gatewayId, entry?.gatewayOrigin)
  if (!key) return
  const status = formatGatewayStatus(entry?.hostingState)
  ensureGatewayCard(cards, key, {
    title: getGatewayTitle({
      displayName: null,
      publicUrl: entry?.gatewayOrigin || null,
      gatewayOrigin: entry?.gatewayOrigin || null,
      gatewayId: entry?.gatewayId || null
    }),
    subtitle: getGatewaySubtitle({
      displayName: null,
      publicUrl: entry?.gatewayOrigin || null,
      gatewayOrigin: entry?.gatewayOrigin || null
    }),
    statusLabel: status.statusLabel,
    badgeVariant: status.badgeVariant,
    detail: status.detail,
    lastCheckedAt: typeof entry?.lastCheckedAt === 'number' ? entry.lastCheckedAt : null
  })
}

function addGatewayFromCatalog(
  cards: Map<string, GatewayCardSeed>,
  entry: DiscoveredGatewayEntry | AuthorizedGatewayEntry,
  approved = false
) {
  const key = normalizeGatewayKey(entry?.gatewayId, entry?.publicUrl || null)
  if (!key) return
  const status = approved ? formatGatewayStatus('approved') : formatGatewayStatus(null)
  ensureGatewayCard(cards, key, {
    title: getGatewayTitle(entry),
    subtitle: getGatewaySubtitle(entry),
    statusLabel: status.statusLabel,
    badgeVariant: status.badgeVariant,
    detail: status.detail,
    lastCheckedAt: null
  })
}

function addRelayToCard(
  cards: Map<string, GatewayCardSeed>,
  key: string,
  relayKey: string,
  entry: PublicGatewayRelayEntry
) {
  const existing = cards.get(key)
  const relayName = String(entry?.name || '').trim()
  const publicIdentifier = String(entry?.publicIdentifier || '').trim()
  const canonicalRelayKey = publicIdentifier || relayKey
  const relayLabel = relayName || publicIdentifier || relayKey
  const relaySummary: PublicGatewayRelaySummary = {
    key: canonicalRelayKey,
    label: relayLabel,
    subtitle: relayName && publicIdentifier && relayName !== publicIdentifier ? publicIdentifier : null,
    statusLabel: formatRelayStatus(entry?.status),
    lastSyncedAt: typeof entry?.lastSyncedAt === 'number' ? entry.lastSyncedAt : null,
    error: String(entry?.error || entry?.message || '').trim() || null
  }

  if (existing) {
    const duplicateIndex = existing.relays.findIndex((candidate) => candidate.key === canonicalRelayKey)
    if (duplicateIndex >= 0) {
      const previous = existing.relays[duplicateIndex]
      existing.relays[duplicateIndex] = {
        ...previous,
        label:
          previous.label === previous.key && relaySummary.label !== relaySummary.key
            ? relaySummary.label
            : previous.label || relaySummary.label,
        subtitle: previous.subtitle || relaySummary.subtitle,
        statusLabel:
          getRelayStatusRank(relaySummary.statusLabel) < getRelayStatusRank(previous.statusLabel)
            ? relaySummary.statusLabel
            : previous.statusLabel,
        lastSyncedAt: Math.max(previous.lastSyncedAt || 0, relaySummary.lastSyncedAt || 0) || null,
        error: previous.error || relaySummary.error
      }
    } else {
      existing.relays.push(relaySummary)
    }
    cards.set(key, existing)
    return
  }

  cards.set(key, {
    key,
    title: 'Unknown gateway',
    subtitle: null,
    statusLabel: 'Unavailable',
    badgeVariant: 'outline',
    detail: 'Unavailable right now',
    lastCheckedAt: null,
    relays: [relaySummary]
  })
}

export function deriveLocalProxyHost(status: GatewayStatus | null | undefined) {
  const hostname = String(status?.urls?.hostname || '').trim()
  if (hostname) {
    return hostname.replace(/^wss?:\/\//i, (value) => (value.toLowerCase() === 'wss://' ? 'https://' : 'http://'))
  }

  const host = String(status?.hostname || status?.host || '').trim()
  const port = Number.isFinite(Number(status?.port)) ? Number(status?.port) : null
  if (host && port) {
    return `http://${host}:${port}`
  }
  return null
}

export function buildPublicGatewayPanelModel(status: PublicGatewayStatus | null | undefined): PublicGatewayPanelModel {
  const cards = new Map<string, GatewayCardSeed>()
  const accessCatalog = Array.isArray(status?.gatewayAccessCatalog) ? status.gatewayAccessCatalog : []
  const authorizedGateways = Array.isArray(status?.authorizedGateways) ? status.authorizedGateways : []
  const discoveredGateways = Array.isArray(status?.discoveredGateways) ? status.discoveredGateways : []
  const relayEntries = status?.relays ? Object.entries(status.relays) : []

  accessCatalog.forEach((entry) => addGatewayFromAccessCatalog(cards, entry))
  discoveredGateways.forEach((entry) => addGatewayFromCatalog(cards, entry, false))
  authorizedGateways.forEach((entry) => addGatewayFromCatalog(cards, entry, true))

  relayEntries.forEach(([relayKey, entry]) => {
    if (isInternalPublicGatewayRelay(relayKey, entry)) return
    const key =
      normalizeGatewayKey(entry?.gatewayId, entry?.gatewayOrigin)
      || 'unknown-gateway'
    addRelayToCard(cards, key, relayKey, entry)
  })

  const cardList = Array.from(cards.values())
    .map((entry) => ({
      ...entry,
      relays: [...entry.relays].sort((left, right) => left.label.localeCompare(right.label))
    }))
    .sort((left, right) => {
      const statusRank = (statusLabel: PublicGatewayCard['statusLabel']) => {
        if (statusLabel === 'Approved') return 0
        if (statusLabel === 'Not approved') return 1
        return 2
      }
      const byStatus = statusRank(left.statusLabel) - statusRank(right.statusLabel)
      if (byStatus !== 0) return byStatus
      return left.title.localeCompare(right.title)
    })

  const warning =
    String(status?.discoveryWarning || status?.discoveryUnavailableReason || status?.disabledReason || '').trim() || null

  return {
    approvedCount: cardList.filter((card) => card.statusLabel === 'Approved').length,
    lastUpdatedAt: typeof status?.lastUpdatedAt === 'number' ? status.lastUpdatedAt : null,
    warning,
    cards: cardList
  }
}
