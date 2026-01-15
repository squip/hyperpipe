import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import {
  deriveMembershipStatus,
  parseGroupAdminsEvent,
  parseGroupIdentifier,
  parseGroupInviteEvent,
  parseGroupJoinRequestEvent,
  parseGroupListEvent,
  parseGroupMembersEvent,
  parseGroupMetadataEvent,
  buildGroupIdForCreation
} from '@/lib/groups'
import {
  buildHypertunaAdminBootstrapDraftEvents,
  buildHypertunaDiscoveryDraftEvents,
  getBaseRelayUrl,
  HYPERTUNA_IDENTIFIER_TAG,
  isHypertunaTaggedEvent,
  KIND_HYPERTUNA_RELAY,
  parseHypertunaRelayEvent30166
} from '@/lib/hypertuna-group-events'
import { TDraftEvent } from '@/types'
import {
  TGroupAdmin,
  TGroupInvite,
  TGroupListEntry,
  TGroupMembershipStatus,
  TGroupMetadata,
  TJoinRequest
} from '@/types/groups'
import client from '@/services/client.service'
import localStorageService from '@/services/local-storage.service'
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useNostr } from './NostrProvider'
import { randomString } from '@/lib/random'
import { useWorkerBridge } from './WorkerBridgeProvider'
import type { TPublishOptions } from '@/types'
import * as nip19 from '@nostr/tools/nip19'

// Prevent repeated bootstrap publishes per group/relay when admin snapshots are missing.
const adminRecoveryAttempts = new Set<string>()
const DEFAULT_PUBLIC_GATEWAY_BASE = 'https://hypertuna.com'

type TGroupsContext = {
  discoveryGroups: TGroupMetadata[]
  invites: TGroupInvite[]
  joinRequests: Record<string, TJoinRequest[]>
  favoriteGroups: string[]
  myGroupList: TGroupListEntry[]
  isLoadingDiscovery: boolean
  discoveryError: string | null
  invitesError: string | null
  joinRequestsError: string | null
  refreshDiscovery: () => Promise<void>
  refreshInvites: () => Promise<void>
  loadJoinRequests: (groupId: string, relay?: string) => Promise<void>
  resolveRelayUrl: (relay?: string) => string | undefined
  toggleFavorite: (groupKey: string) => void
  saveMyGroupList: (entries: TGroupListEntry[], options?: TPublishOptions) => Promise<void>
  sendJoinRequest: (groupId: string, relay?: string, code?: string, reason?: string) => Promise<void>
  sendLeaveRequest: (groupId: string, relay?: string, reason?: string) => Promise<void>
  fetchGroupDetail: (
    groupId: string,
    relay?: string,
    opts?: { preferRelay?: boolean; discoveryOnly?: boolean }
  ) => Promise<{
    metadata: TGroupMetadata | null
    admins: TGroupAdmin[]
    members: string[]
    membershipStatus: TGroupMembershipStatus
  }>
  sendInvites: (groupId: string, invitees: string[], relay?: string, options?: SendInviteOptions) => Promise<void>
  updateMetadata: (groupId: string, data: Partial<{ name: string; about: string; picture: string; isPublic: boolean; isOpen: boolean }>, relay?: string) => Promise<void>
  grantAdmin: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  approveJoinRequest: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  rejectJoinRequest: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  addUser: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  removeUser: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  deleteGroup: (groupId: string, relay?: string) => Promise<void>
  deleteEvent: (groupId: string, eventId: string, relay?: string) => Promise<void>
  createGroup: (data: {
    name: string
    about?: string
    picture?: string
    isPublic: boolean
    isOpen: boolean
    relays?: string[]
  }) => Promise<{ groupId: string; relay: string }>
  createHypertunaRelayGroup: (data: {
    name: string
    about?: string
    isPublic: boolean
    isOpen: boolean
    picture?: string
    fileSharing?: boolean
  }) => Promise<{ groupId: string; relay: string }>
}

const GroupsContext = createContext<TGroupsContext | undefined>(undefined)

export const useGroups = () => {
  const context = useContext(GroupsContext)
  if (!context) {
    console.warn('useGroups called outside GroupsProvider; returning fallback context')
    return {
      discoveryGroups: [],
      invites: [],
       joinRequests: {},
      favoriteGroups: [],
      myGroupList: [],
      isLoadingDiscovery: false,
      discoveryError: null,
      invitesError: null,
      joinRequestsError: null,
      refreshDiscovery: async () => {},
      refreshInvites: async () => {},
      loadJoinRequests: async () => {},
      resolveRelayUrl: (r?: string) => r,
      toggleFavorite: () => {},
      saveMyGroupList: async () => {},
      sendJoinRequest: async () => {},
      sendLeaveRequest: async () => {},
      fetchGroupDetail: async () => ({
        metadata: null,
        admins: [],
        members: [],
        membershipStatus: 'not-member' as TGroupMembershipStatus
      }),
      sendInvites: async () => {},
      updateMetadata: async () => {},
      grantAdmin: async () => {},
      approveJoinRequest: async () => {},
      rejectJoinRequest: async () => {},
      addUser: async () => {},
      removeUser: async () => {},
      deleteGroup: async () => {},
      deleteEvent: async () => {},
      createGroup: async () => {
        throw new Error('GroupsProvider not available')
      },
      createHypertunaRelayGroup: async () => {
        throw new Error('GroupsProvider not available')
      }
    }
  }
  return context
}

const defaultDiscoveryRelays = BIG_RELAY_URLS

const toGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

type InviteMirrorMetadata = {
  blindPeer?: {
    publicKey?: string | null
    encryptionKey?: string | null
    replicationTopic?: string | null
    maxBytes?: number | null
  } | null
  cores?: { key: string; role?: string | null }[]
} | null

type SendInviteOptions = {
  isOpen?: boolean
  name?: string
  about?: string
}

const buildInvitePayload = (args: {
  token: string
  relayUrl: string | null
  relayKey?: string | null
  meta?: TGroupMetadata | null
  mirrorMetadata?: InviteMirrorMetadata
  writerInfo?: {
    writerCore?: string
    writerCoreHex?: string
    autobaseLocal?: string
    writerSecret?: string
  } | null
}) => ({
  relayUrl: args.relayUrl,
  token: args.token,
  relayKey: args.relayKey ?? null,
  isPublic: args.meta?.isPublic !== false,
  name: args.meta?.name,
  about: args.meta?.about,
  fileSharing: args.meta?.isOpen !== false,
  blindPeer: args.mirrorMetadata?.blindPeer,
  cores: args.mirrorMetadata?.cores,
  writerCore: args.writerInfo?.writerCore || null,
  writerCoreHex: args.writerInfo?.writerCoreHex || args.writerInfo?.autobaseLocal || null,
  autobaseLocal: args.writerInfo?.autobaseLocal || args.writerInfo?.writerCoreHex || null,
  writerSecret: args.writerInfo?.writerSecret || null
})

const buildOpenInvitePayload = (args: { relayUrl: string | null; relayKey?: string | null }) => ({
  relayUrl: args.relayUrl,
  relayKey: args.relayKey ?? null
})

export function GroupsProvider({ children }: { children: ReactNode }) {
  const { pubkey, publish, relayList, nip04Decrypt, nip04Encrypt } = useNostr()
  const { relays: workerRelays, joinFlows, createRelay, sendToWorker } = useWorkerBridge()
  const [discoveryGroups, setDiscoveryGroups] = useState<TGroupMetadata[]>([])
  const [invites, setInvites] = useState<TGroupInvite[]>([])
  const [joinRequests, setJoinRequests] = useState<Record<string, TJoinRequest[]>>({})
  const [favoriteGroups, setFavoriteGroups] = useState<string[]>([])
  const [myGroupList, setMyGroupList] = useState<TGroupListEntry[]>([])
  const [isLoadingDiscovery, setIsLoadingDiscovery] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [invitesError, setInvitesError] = useState<string | null>(null)
  const [joinRequestsError, setJoinRequestsError] = useState<string | null>(null)
  const [discoveryRelays, setDiscoveryRelays] = useState<string[]>(() => {
    const stored = localStorageService.getGroupDiscoveryRelays()
    return stored.length ? stored : defaultDiscoveryRelays
  })
  const [rejectedJoinRequests, setRejectedJoinRequests] = useState<Record<string, Set<string>>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem('hypertuna_join_rejections')
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, string[]>
      const asSets: Record<string, Set<string>> = {}
      Object.entries(parsed).forEach(([k, v]) => {
        asSets[k] = new Set(v)
      })
      return asSets
    } catch (_err) {
      return {}
    }
  })

  const workerRelayUrlMap = useMemo(() => {
    const map = new Map<string, string>()

    const withAuth = (url?: string, token?: string) => {
      if (!url) return url
      try {
        const u = new URL(url)
        if (token && !u.searchParams.has('token')) {
          u.searchParams.set('token', token)
          return u.toString()
        }
        return url
      } catch (_err) {
        return url
      }
    }

    const addKey = (key?: string, value?: string) => {
      if (!key || !value) return
      map.set(key, value)
    }

    const addUrlVariants = (targetUrl?: string, valueUrl?: string) => {
      if (!targetUrl || !valueUrl) return
      const base = getBaseRelayUrl(targetUrl)
      addKey(targetUrl, valueUrl)
      addKey(base, valueUrl)
      try {
        const parsed = new URL(base)
        const hostPath = `${parsed.host}${parsed.pathname}`
        const pathOnly = parsed.pathname.replace(/^\/+/, '')
        addKey(hostPath, valueUrl)
        addKey(pathOnly, valueUrl)
      } catch (_err) {
        // non-URL strings: attempt a lightweight path-only fallback
        const pathOnly = base.replace(/^[a-z]+:\/\/[^/]+\/?/, '')
        addKey(pathOnly, valueUrl)
      }
    }

    workerRelays.forEach((r) => {
      const token = r.userAuthToken || (r as any)?.authToken
      const authUrl = withAuth(r.connectionUrl, token)
      addUrlVariants(authUrl, authUrl)
      if (r.relayKey && authUrl) addKey(r.relayKey, authUrl)
      if (r.publicIdentifier && authUrl) {
        addKey(r.publicIdentifier, authUrl)
        addKey(r.publicIdentifier.replace(':', '/'), authUrl)
      }
    })
    console.info('[GroupsProvider] workerRelays', workerRelays)
    console.info('[GroupsProvider] relayUrlMap', Array.from(map.entries()))
    return map
  }, [workerRelays])

  const resolveRelayUrl = useCallback(
    (relay?: string) => {
      if (!relay) return relay
      const direct = workerRelayUrlMap.get(relay)
      if (direct) return direct

      const base = getBaseRelayUrl(relay)
      const baseHit = workerRelayUrlMap.get(base)
      if (baseHit) return baseHit

      try {
        const parsed = new URL(base)
        const hostPath = `${parsed.host}${parsed.pathname}`
        const pathOnly = parsed.pathname.replace(/^\/+/, '')
        const hostHit = workerRelayUrlMap.get(hostPath)
        if (hostHit) return hostHit
        const pathHit = workerRelayUrlMap.get(pathOnly)
        if (pathHit) return pathHit
      } catch (_err) {
        const pathOnly = base.replace(/^[a-z]+:\/\/[^/]+\/?/, '')
        const pathHit = workerRelayUrlMap.get(pathOnly)
        if (pathHit) return pathHit
      }

      return relay
    },
    [workerRelayUrlMap]
  )

  const getRelayEntryForGroup = useCallback(
    (groupId: string) => {
      if (!groupId) return null
      const candidates = new Set([groupId, groupId.replace(':', '/'), groupId.replace('/', ':')])
      return (
        workerRelays.find(
          (r) =>
            (r.publicIdentifier && candidates.has(r.publicIdentifier)) ||
            (r.relayKey && candidates.has(r.relayKey))
        ) || null
      )
    },
    [workerRelays]
  )

  const fetchInviteMirrorMetadata = useCallback(async (relayIdentifier: string, resolved?: string | null) => {
    const origins: string[] = [DEFAULT_PUBLIC_GATEWAY_BASE]
    if (resolved) {
      try {
        const baseUrl = new URL(resolved)
        baseUrl.protocol = baseUrl.protocol === 'wss:' ? 'https:' : 'http:'
        const hostOrigin = baseUrl.origin
        if (!origins.includes(hostOrigin)) {
          origins.push(hostOrigin)
        }
      } catch (_err) {
        // fall back to default only
      }
    }

    for (const origin of origins) {
      try {
        const resp = await fetch(`${origin}/api/relays/${encodeURIComponent(relayIdentifier)}/mirror`)
        if (!resp.ok) {
          console.warn('[GroupsProvider] Mirror metadata request failed', {
            origin,
            status: resp.status,
            statusText: resp.statusText
          })
          continue
        }
        const data = await resp.json()
        const cores = Array.isArray(data?.cores)
          ? data.cores
              .filter((c: any) => c && typeof c === 'object' && c.key)
              .map((c: any) => ({
                key: String(c.key),
                role: typeof c.role === 'string' ? c.role : null
              }))
          : undefined
        const blindPeer = data?.blindPeer && typeof data.blindPeer === 'object'
          ? {
              publicKey: data.blindPeer.publicKey ?? null,
              encryptionKey: data.blindPeer.encryptionKey ?? null,
              replicationTopic: data.blindPeer.replicationTopic ?? null,
              maxBytes: typeof data.blindPeer.maxBytes === 'number' ? data.blindPeer.maxBytes : null
            }
          : undefined
        return { blindPeer, cores }
      } catch (err) {
        console.warn('[GroupsProvider] Failed to fetch relay mirror metadata', {
          origin,
          err: err instanceof Error ? err.message : err
        })
      }
    }

    return null
  }, [])

  useEffect(() => {
    setFavoriteGroups(localStorageService.getFavoriteGroups(pubkey))
  }, [pubkey])

  useEffect(() => {
    // Clear per-account volatile state on account switch
    setJoinRequests({})
    setRejectedJoinRequests({})
  }, [pubkey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const serialized: Record<string, string[]> = {}
    Object.entries(rejectedJoinRequests).forEach(([k, v]) => {
      serialized[k] = Array.from(v)
    })
    try {
      window.localStorage.setItem('hypertuna_join_rejections', JSON.stringify(serialized))
    } catch (_err) {
      // best effort
    }
  }, [rejectedJoinRequests])

  const refreshDiscovery = useCallback(async () => {
    setIsLoadingDiscovery(true)
    setDiscoveryError(null)
    try {
      const [metadataEvents, relayEvents] = await Promise.all([
        client.fetchEvents(discoveryRelays, {
          kinds: [ExtendedKind.GROUP_METADATA],
          '#i': [HYPERTUNA_IDENTIFIER_TAG],
          since: 1764892800, // 2025-12-05T00:00:00Z - temporary cutoff to filter legacy noise
          limit: 200
        }),
        client.fetchEvents(discoveryRelays, {
          kinds: [KIND_HYPERTUNA_RELAY],
          '#i': [HYPERTUNA_IDENTIFIER_TAG],
          limit: 300
        })
      ])

      const hypertunaRelayUrlById = new Map<string, string>()
      relayEvents.forEach((evt) => {
        const parsed = parseHypertunaRelayEvent30166(evt)
        if (!parsed) return
        hypertunaRelayUrlById.set(parsed.publicIdentifier, getBaseRelayUrl(parsed.wsUrl))
      })

      const parsed = metadataEvents.map((evt) => {
        const parsedId = parseGroupIdentifier(evt.tags.find((t) => t[0] === 'd')?.[1] ?? '')
        const meta = parseGroupMetadataEvent(evt, parsedId.relay)
        if (isHypertunaTaggedEvent(evt)) {
          const relayUrl = hypertunaRelayUrlById.get(meta.id)
          if (relayUrl) {
            return { ...meta, relay: relayUrl }
          }
        }
        return meta
      })

      const seen = new Set<string>()
      const deduped = parsed.filter((g) => {
        const key = toGroupKey(g.id, g.relay)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setDiscoveryGroups(deduped)
    } catch (error) {
      console.warn('Failed to refresh discovery groups', error)
      setDiscoveryError((error as Error).message)
    } finally {
      setIsLoadingDiscovery(false)
    }
  }, [discoveryRelays])

  const refreshInvites = useCallback(async () => {
    if (!pubkey) {
      setInvites([])
      return
    }
    try {
      const events = await client.fetchEvents(discoveryRelays, {
        kinds: [9009],
        '#p': [pubkey],
        limit: 200
      })
      const parsed = await Promise.all(
        events.map(async (evt) => {
          const invite = parseGroupInviteEvent(evt)
          if (!evt.content) return invite
          try {
            const decrypted = await nip04Decrypt(evt.pubkey, evt.content)
            let token: string | undefined
            let relayUrl: string | null | undefined
            let relayKey: string | null | undefined
            let fileSharing: boolean | undefined = invite.fileSharing
            let blindPeer: TGroupInvite['blindPeer'] | null | undefined
            let cores: TGroupInvite['cores'] | undefined
            let writerCore: string | null | undefined
            let writerCoreHex: string | null | undefined
            let autobaseLocal: string | null | undefined
            let writerSecret: string | null | undefined
            try {
              const payload = JSON.parse(decrypted)
              if (payload && typeof payload === 'object') {
                token = typeof payload.token === 'string' ? payload.token : undefined
                relayUrl = typeof payload.relayUrl === 'string' ? payload.relayUrl : null
                relayKey = typeof payload.relayKey === 'string' ? payload.relayKey : null
                if (typeof payload.fileSharing === 'boolean') {
                  fileSharing = payload.fileSharing
                }
                if (typeof payload.writerCore === 'string') {
                  writerCore = payload.writerCore
                }
                if (typeof payload.writerCoreHex === 'string') {
                  writerCoreHex = payload.writerCoreHex
                } else if (typeof payload.writer_core_hex === 'string') {
                  writerCoreHex = payload.writer_core_hex
                }
                if (typeof payload.autobaseLocal === 'string') {
                  autobaseLocal = payload.autobaseLocal
                } else if (typeof payload.autobase_local === 'string') {
                  autobaseLocal = payload.autobase_local
                }
                if (typeof payload.writerSecret === 'string') {
                  writerSecret = payload.writerSecret
                }
                if (payload.blindPeer && typeof payload.blindPeer === 'object') {
                  blindPeer = {
                    publicKey: payload.blindPeer.publicKey ?? payload.blindPeer.public_key ?? null,
                    encryptionKey: payload.blindPeer.encryptionKey ?? payload.blindPeer.encryption_key ?? null,
                    replicationTopic: payload.blindPeer.replicationTopic ?? payload.blindPeer.replication_topic ?? null,
                    maxBytes: typeof payload.blindPeer.maxBytes === 'number' ? payload.blindPeer.maxBytes : null
                }
              }
              if (Array.isArray(payload.cores)) {
                cores = payload.cores
                  .filter((c: any) => c && typeof c === 'object' && c.key)
                  .map((c: any) => ({
                    key: String(c.key),
                    role: typeof c.role === 'string' ? c.role : null
                  }))
              }
            }
            } catch {
              token = decrypted
            }
            if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
            if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal
            return {
              ...invite,
              token,
              relayUrl,
              relayKey,
              fileSharing,
              blindPeer,
              cores,
              writerCore,
              writerCoreHex,
              autobaseLocal,
              writerSecret
            }
          } catch (_err) {
            return invite
          }
        })
      )
      console.info('[GroupsProvider] Refreshed invites writer stats', {
        total: parsed.length,
        withWriterSecret: parsed.filter((p) => (p as any).writerSecret).length,
        withWriterCore: parsed.filter((p) => (p as any).writerCore).length,
        withWriterCoreHex: parsed.filter((p) => (p as any).writerCoreHex).length
      })
      setInvites(parsed)
    } catch (error) {
      console.warn('Failed to refresh group invites', error)
      setInvitesError((error as Error).message)
    }
  }, [discoveryRelays, nip04Decrypt, pubkey])

  const loadJoinRequests = useCallback(
    async (groupId: string, relay?: string) => {
      if (!groupId) return
      setJoinRequestsError(null)
      const groupKey = toGroupKey(groupId, relay)
      try {
        const resolved = relay ? resolveRelayUrl(relay) : undefined
        const relayUrls = resolved ? [resolved] : discoveryRelays

        const [joinEvents, membershipEvents] = await Promise.all([
          client.fetchEvents(relayUrls, {
            kinds: [9021],
            '#h': [groupId],
            limit: 200
          }),
          client
            .fetchEvents(relayUrls, {
              kinds: [9000, 9001],
              '#h': [groupId],
              limit: 200
            })
            .catch(() => [])
        ])

        // Compute membership from 9000/9001 sets
        const memberAdds = new Map<string, number>()
        const memberRemoves = new Map<string, number>()
        membershipEvents.forEach((evt) => {
          evt.tags
            .filter((t) => t[0] === 'p' && t[1])
            .forEach((t) => {
              const pk = t[1]
              if (evt.kind === 9000) {
                memberAdds.set(pk, evt.created_at)
              } else if (evt.kind === 9001) {
                memberRemoves.set(pk, evt.created_at)
              }
            })
        })
        const currentMembers = new Set<string>()
        memberAdds.forEach((ts, pk) => {
          const removedAt = memberRemoves.get(pk)
          if (!removedAt || removedAt < ts) currentMembers.add(pk)
        })

        const rejected = rejectedJoinRequests[groupKey] || new Set<string>()
        const parsed = joinEvents
          .map(parseGroupJoinRequestEvent)
          .filter((jr) => !currentMembers.has(jr.pubkey) && !rejected.has(jr.pubkey))
        setJoinRequests((prev) => ({ ...prev, [groupKey]: parsed }))
      } catch (error) {
        setJoinRequestsError((error as Error).message)
      }
    },
    [discoveryRelays, rejectedJoinRequests, resolveRelayUrl]
  )

  const loadMyGroupList = useCallback(async () => {
    if (!pubkey) {
      setMyGroupList([])
      return
    }

    try {
      const relays = relayList?.read?.length ? relayList.read : BIG_RELAY_URLS
      const events = await client.fetchEvents(relays, {
        kinds: [10009],
        authors: [pubkey],
        limit: 1
      })
      const sorted = events.sort((a, b) => b.created_at - a.created_at)
      const latest = sorted[0]
      if (!latest) {
        setMyGroupList([])
        return
      }
      const entries = parseGroupListEvent(latest)
      setMyGroupList(entries)
    } catch (error) {
      console.warn('Failed to load group list (10009)', error)
    }
  }, [pubkey, relayList])

  useEffect(() => {
    loadMyGroupList()
  }, [loadMyGroupList])

  useEffect(() => {
    localStorageService.setGroupDiscoveryRelays(discoveryRelays)
  }, [discoveryRelays])

  const toggleFavorite = useCallback(
    (groupKey: string) => {
      if (localStorageService.isFavoriteGroup(groupKey, pubkey)) {
        localStorageService.removeFavoriteGroup(groupKey, pubkey)
      } else {
        localStorageService.addFavoriteGroup(groupKey, pubkey)
      }
      setFavoriteGroups(localStorageService.getFavoriteGroups(pubkey))
    },
    [pubkey]
  )

  const fetchGroupDetail = useCallback(
    async (
      groupId: string,
      relay?: string,
      opts?: { preferRelay?: boolean; discoveryOnly?: boolean }
    ) => {
      const relayFromList = myGroupList.find((entry) => entry.groupId === groupId)?.relay
      const targetRelay = relay || relayFromList || undefined
      const resolved = targetRelay ? resolveRelayUrl(targetRelay) : null
      const isInMyGroups = myGroupList.some((entry) => entry.groupId === groupId)
      const preferRelay = (!opts?.discoveryOnly && (opts?.preferRelay || isInMyGroups) && !!resolved)

      // Default: discovery only for list/facepile; if member/admin, stick to the resolved group relay only.
      const groupRelays = preferRelay && resolved ? [resolved] : defaultDiscoveryRelays
      const resolvedRelayList = resolved ? [resolved] : []
      const metadataRelays = opts?.discoveryOnly
        ? discoveryRelays
        : Array.from(new Set([...resolvedRelayList, ...discoveryRelays]))

      const time = () => performance.now()
      const logDuration = (label: string, start: number) => {
        console.info(`[GroupsProvider] fetch ${label} took ${(performance.now() - start).toFixed(0)}ms`, {
          groupId,
          relays: preferRelay && resolved ? 'group-relay-only' : 'discovery',
          resolved
        })
      }

      const fetchLatestByTags = async (relays: string[], kind: number, tagKeys: Array<'d' | 'h'>) => {
        const start = time()
        const results = await Promise.all(
          tagKeys.map(async (tagKey) => {
            const filter: any = { kinds: [kind], limit: 10 }
            filter[`#${tagKey}`] = [groupId]
            const events = await client.fetchEvents(relays, filter)
            return { tagKey, events }
          })
        )
        logDuration(`${kind}#${tagKeys.join(',')}`, start)
        results.forEach(({ tagKey, events }) => {
          console.info('[GroupsProvider] fetched events batch', {
            groupId,
            kind,
            tagKey,
            relayTargets: relays,
            count: events.length,
            createdAts: events.map((e) => e.created_at).sort((a, b) => b - a)
          })
        })
        const flat = results.flatMap((r) => r.events)
        const sorted = flat.sort((a, b) => b.created_at - a.created_at)
        return sorted[0] || null
      }

      // Fetch metadata/admins/members in parallel (two tag variants), plus membership events.
      const metadataPromise = (async () => {
        try {
          const evtDAndH = await fetchLatestByTags(metadataRelays, ExtendedKind.GROUP_METADATA, ['d', 'h'])
          const candidates = [evtDAndH].filter(Boolean).sort((a, b) => (b!.created_at || 0) - (a!.created_at || 0))
          const evt = candidates[0] || null
          console.info('[GroupsProvider] metadata candidates', {
            groupId,
            preferRelay,
            metadataRelays,
            candidates: candidates.map((c) => ({
              created_at: c?.created_at,
              id: c?.id,
              kind: c?.kind,
              picture: c?.tags?.find?.((t: any) => t[0] === 'picture')?.[1]
            })),
            chosen: evt
              ? {
                  created_at: evt.created_at,
                  id: evt.id,
                  kind: evt.kind,
                  picture: evt.tags?.find?.((t: any) => t[0] === 'picture')?.[1]
                }
              : null
          })
          console.info('[GroupsProvider] fetched metadata evt', {
            groupId,
            kind: evt?.kind,
            created_at: (evt as any)?.created_at,
            tags: evt?.tags,
            relayTargets: metadataRelays,
            raw: evt
          })
          return evt
        } catch (error) {
          console.warn('Failed to fetch group metadata', error)
          return null
        }
      })()

      const adminsPromise = (async () => {
        try {
          return await fetchLatestByTags(groupRelays, 39001, ['d', 'h'])
        } catch (_e) {
          return null
        }
      })()

      const membersPromise = (async () => {
        try {
          return await fetchLatestByTags(groupRelays, 39002, ['d', 'h'])
        } catch (_e) {
          return null
        }
      })()

      const membershipPromise = (async () => {
        try {
          const start = time()
          const events = await client.fetchEvents(groupRelays, {
            kinds: [9000, 9001],
            '#h': [groupId],
            limit: 50
          })
          logDuration('9000/9001', start)
          return events
        } catch (_e) {
          return []
        }
      })()

      const joinRequestsPromise = pubkey
        ? (async () => {
            try {
              const start = time()
              const events = await client.fetchEvents(groupRelays, {
                kinds: [9021],
                authors: [pubkey],
                '#h': [groupId],
                limit: 10
              })
              logDuration('9021', start)
              return events
            } catch (_e) {
              return []
            }
          })()
        : Promise.resolve([])

      const [metadataEvt, adminsEvt, membersEvt, membershipEvents, joinRequests] = await Promise.all([
        metadataPromise,
        adminsPromise,
        membersPromise,
        membershipPromise,
        joinRequestsPromise
      ])

      const membershipStatus = pubkey
        ? deriveMembershipStatus(pubkey, membershipEvents, joinRequests)
        : 'not-member'

      // Fallback: if membership events are missing but the member list includes the user, treat as member
      const membersFromEvent = membersEvt ? parseGroupMembersEvent(membersEvt) : []
      const groupIdPubkey = (() => {
        try {
          if (groupId?.startsWith('npub')) {
            const decoded = nip19.decode(groupId)
            if (decoded.type === 'npub') return decoded.data as string
          }
          const dTag = metadataEvt?.tags?.find((t) => t[0] === 'd')?.[1]
          if (dTag?.startsWith?.('npub')) {
            const decoded = nip19.decode(dTag)
            if (decoded.type === 'npub') return decoded.data as string
          }
        } catch (_err) {
          // ignore decode failures
        }
        return undefined
      })()
      const creatorPubkey = metadataEvt?.pubkey
      const isCreator =
        !!pubkey &&
        ((!!creatorPubkey && creatorPubkey === pubkey) || (!!groupIdPubkey && groupIdPubkey === pubkey))
      let coercedMembershipStatus =
        membershipStatus === 'not-member' && pubkey && membersFromEvent.includes(pubkey)
          ? 'member'
          : membershipStatus

      // If this group is in my list, default to member unless explicitly removed
      if (coercedMembershipStatus === 'not-member' && isInMyGroups) {
        coercedMembershipStatus = 'member'
      }
      if (isCreator) {
        coercedMembershipStatus = 'member'
      }

      // If we believe we're a member but members list is empty, include self so UI doesn't zero out
      let members = membersFromEvent
      if (coercedMembershipStatus === 'member' && pubkey) {
        if (!members.includes(pubkey)) members = [...members, pubkey]
      }

      const metadata = metadataEvt ? parseGroupMetadataEvent(metadataEvt, relay) : null
      let admins = adminsEvt ? parseGroupAdminsEvent(adminsEvt) : []

      const shouldInjectCreatorAdmin = isCreator && pubkey && admins.length === 0
      if (shouldInjectCreatorAdmin) {
        const relayForBootstrap = resolved || targetRelay || null
        const recoveryKey = `${relayForBootstrap || 'unknown-relay'}|${groupId}`
        console.warn('[GroupsProvider] creator detected but no admin snapshot; injecting self', {
          groupId,
          relay: relayForBootstrap,
          recoveryAttempted: adminRecoveryAttempts.has(recoveryKey)
        })
        admins = [{ pubkey, roles: ['admin'] }]

        if (relayForBootstrap && !adminRecoveryAttempts.has(recoveryKey)) {
          adminRecoveryAttempts.add(recoveryKey)
          try {
            const { adminListEvent, memberListEvent } = buildHypertunaAdminBootstrapDraftEvents({
              publicIdentifier: groupId,
              adminPubkeyHex: pubkey,
              name: metadata?.name || groupId
            })
            // Best-effort republish to the group relay so subsequent fetches have a 39001 snapshot.
            publish(adminListEvent, { specifiedRelayUrls: [relayForBootstrap] }).catch(() => {})
            publish(memberListEvent, { specifiedRelayUrls: [relayForBootstrap] }).catch(() => {})
          } catch (err) {
            console.warn('[GroupsProvider] failed to bootstrap admin/member snapshot', { groupId, err })
          }
        }
      }

      console.info('[GroupsProvider] membership derivation', {
        groupId,
        relay: targetRelay,
        membershipEventsCount: membershipEvents.length,
        joinRequestsCount: joinRequests.length,
        initialStatus: membershipStatus,
        membersFromEventCount: membersFromEvent.length,
        isInMyGroups,
        isCreator,
        creatorPubkey,
        groupIdPubkey,
        coercedStatus: coercedMembershipStatus
      })

      console.info('[GroupsProvider] fetchGroupDetail result', {
        groupId,
        relay: targetRelay,
        resolved,
        preferRelay,
        isInMyGroups,
        isCreator,
        metadataFound: !!metadataEvt,
        metadataCreatedAt: metadataEvt?.created_at,
        metadataPicture: metadata?.picture,
        adminsCount: admins.length,
        membersCount: members.length,
        membershipStatus: coercedMembershipStatus
      })

      return { metadata, admins, members, membershipStatus: coercedMembershipStatus }
    },
    [discoveryRelays, pubkey, resolveRelayUrl, myGroupList]
  )

  const saveMyGroupList = useCallback(
    async (entries: TGroupListEntry[], options?: TPublishOptions) => {
      if (!pubkey) throw new Error('Not logged in')
      const tags: string[][] = [['d', 'groups']]
      entries.forEach((entry) => {
        const tagValue = entry.relay ? `${entry.relay}'${entry.groupId}` : entry.groupId
        tags.push(['g', tagValue])
      })

      const draftEvent: TDraftEvent = {
        kind: 10009,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }

      await publish(draftEvent, options)
      setMyGroupList(entries)
    },
    [pubkey, publish]
  )

  const processedJoinFlowsRef = useMemo(() => new Set<string>(), [])

  useEffect(() => {
    processedJoinFlowsRef.clear()
  }, [processedJoinFlowsRef, pubkey])

  useEffect(() => {
    if (!pubkey) return

    Object.values(joinFlows || {}).forEach((flow) => {
      if (!flow || flow.phase !== 'success') return
      const identifier = flow.publicIdentifier
      if (!identifier) return
      if (processedJoinFlowsRef.has(identifier)) return

      const relayUrl = flow.relayUrl
      if (typeof relayUrl !== 'string' || !relayUrl) return
      const baseUrl = getBaseRelayUrl(relayUrl)
      if (!baseUrl) return

      const already = myGroupList.some((e) => e.groupId === identifier && e.relay === baseUrl)
      if (already) {
        processedJoinFlowsRef.add(identifier)
        return
      }

      processedJoinFlowsRef.add(identifier)
      const updated = [...myGroupList, { groupId: identifier, relay: baseUrl }]
      saveMyGroupList(updated, { specifiedRelayUrls: BIG_RELAY_URLS }).catch(() => {})
    })
  }, [joinFlows, myGroupList, pubkey, saveMyGroupList, processedJoinFlowsRef])

  useEffect(() => {
    if (!pubkey) return
    if (!workerRelays.length) return

    const desired = new Map<string, string>()
    workerRelays.forEach((relay) => {
      const publicIdentifier = relay.publicIdentifier
      const connectionUrl = relay.connectionUrl
      if (!publicIdentifier || !connectionUrl) return
      if (!publicIdentifier.includes(':')) return
      const baseUrl = getBaseRelayUrl(connectionUrl)
      if (!baseUrl) return
      desired.set(publicIdentifier, baseUrl)
    })

    if (!desired.size) return

    let changed = false
    const next = myGroupList.map((entry) => {
      const targetRelay = desired.get(entry.groupId)
      if (!targetRelay) return entry
      const currentRelay = entry.relay ? getBaseRelayUrl(entry.relay) : null
      if (currentRelay === targetRelay) return entry
      changed = true
      return { ...entry, relay: targetRelay }
    })

    desired.forEach((relay, groupId) => {
      const exists = next.some((e) => e.groupId === groupId && getBaseRelayUrl(e.relay || '') === relay)
      if (!exists) {
        changed = true
        next.push({ groupId, relay })
      }
    })

    if (!changed) return

    // Don’t force BIG_RELAY_URLS here; use normal publish routing (privacy-preserving for token-joins).
    saveMyGroupList(next).catch(() => {})
  }, [myGroupList, pubkey, saveMyGroupList, workerRelays])

  const createHypertunaRelayGroup = useCallback(
    async ({
      name,
      about,
      isPublic,
      isOpen,
      picture,
      fileSharing
    }: {
      name: string
      about?: string
      isPublic: boolean
      isOpen: boolean
      picture?: string
      fileSharing?: boolean
    }) => {
      if (!pubkey) throw new Error('Not logged in')
      const result = await createRelay({
        name,
        description: about || undefined,
        isPublic,
        isOpen,
        fileSharing
      })
      if (!result?.success) throw new Error(result?.error || 'Failed to create relay')

      const publicIdentifier = result.publicIdentifier
      const authenticatedRelayUrl = result.relayUrl
      if (!publicIdentifier || !authenticatedRelayUrl) {
        throw new Error('Worker did not return a publicIdentifier/relayUrl')
      }

      const relayWsUrl = getBaseRelayUrl(authenticatedRelayUrl)

      const { groupCreateEvent, metadataEvent, hypertunaEvent } = buildHypertunaDiscoveryDraftEvents({
        publicIdentifier,
        name,
        about,
        isPublic,
        isOpen,
        fileSharing,
        relayWsUrl,
        pictureTagUrl: picture
      })

      if (isPublic) {
        await Promise.all([
          publish(groupCreateEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
          publish(metadataEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
          publish(hypertunaEvent, { specifiedRelayUrls: BIG_RELAY_URLS })
        ])
      }

      const updatedList = [
        ...myGroupList.filter((entry) => entry.groupId !== publicIdentifier),
        { groupId: publicIdentifier, relay: relayWsUrl }
      ]
      await saveMyGroupList(
        updatedList,
        isPublic ? { specifiedRelayUrls: BIG_RELAY_URLS } : undefined
      )

      // Publish the same discovery events to the group relay itself (authenticated URL).
      await Promise.all([
        publish(groupCreateEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(metadataEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(hypertunaEvent, { specifiedRelayUrls: [authenticatedRelayUrl] })
      ])

      // Bootstrap admin/member snapshots on the group relay.
      const { adminListEvent, memberListEvent } = buildHypertunaAdminBootstrapDraftEvents({
        publicIdentifier,
        adminPubkeyHex: pubkey,
        name
      })
      await Promise.all([
        publish(adminListEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(memberListEvent, { specifiedRelayUrls: [authenticatedRelayUrl] })
      ])

      return { groupId: publicIdentifier, relay: relayWsUrl }
    },
    [createRelay, myGroupList, pubkey, publish, saveMyGroupList]
  )

  const sendJoinRequest = useCallback(
    async (groupId: string, relay?: string, code?: string, reason?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const tags: string[][] = [['h', groupId]]
      if (code) {
        tags.push(['code', code])
      }
      const draftEvent: TDraftEvent = {
        kind: 9021,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: reason ?? ''
      }

      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const sendLeaveRequest = useCallback(
    async (groupId: string, relay?: string, reason?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9022,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: reason ?? ''
      }

      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const sendInvites = useCallback(
    async (groupId: string, invitees: string[], relay?: string, options?: SendInviteOptions) => {
      if (!pubkey) throw new Error('Not logged in')
      if (!invitees.length) return

      const resolved = relay ? resolveRelayUrl(relay) : null
      // Send invites to both the group relay (if provided) and discovery relays so non-members can see them.
      const relayUrls = Array.from(new Set([...(resolved ? [resolved] : []), ...defaultDiscoveryRelays]))
      const meta =
        discoveryGroups.find(
          (g) => g.id === groupId && (!relay || !g.relay || g.relay === relay || g.relay === resolved)
        ) || null
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedIsOpen = typeof options?.isOpen === 'boolean' ? options.isOpen : meta?.isOpen
      const isOpenGroup = resolvedIsOpen === true
      const inviteName = options?.name ?? meta?.name
      const inviteAbout = options?.about ?? meta?.about

      let mirrorMetadata: InviteMirrorMetadata = null

      const inviteRelayUrl = getBaseRelayUrl(resolved || relay || '') || resolved || relay || null
      const canProvisionWriter = !isOpenGroup && sendToWorker && relayEntry?.relayKey
      const mergeWriterCoreIntoMirror = (current: InviteMirrorMetadata, writerCoreKey: string | null) => {
        if (!writerCoreKey) return current
        const nextCores = Array.isArray(current?.cores) ? [...current.cores] : []
        if (!nextCores.some((core) => core?.key === writerCoreKey)) {
          nextCores.push({ key: writerCoreKey, role: 'autobase-writer' })
        }
        return current ? { ...current, cores: nextCores } : { cores: nextCores }
      }

      for (const invitee of invitees) {
        let writerInfo: {
          writerCore?: string
          writerCoreHex?: string
          autobaseLocal?: string
          writerSecret?: string
        } | null = null
        if (canProvisionWriter) {
          try {
            const res = await sendToWorker({
              type: 'provision-writer-for-invitee',
              data: { relayKey: relayEntry?.relayKey, publicIdentifier: groupId, inviteePubkey: invitee }
            })
            if (res && typeof res === 'object') {
              writerInfo = {
                writerCore: (res as any).writerCore,
                writerCoreHex: (res as any).writerCoreHex,
                autobaseLocal: (res as any).autobaseLocal,
                writerSecret: (res as any).writerSecret
              }
            }
            console.info('[GroupsProvider] Writer provisioning result (invite)', {
              groupId,
              invitee,
              relayKey: relayEntry?.relayKey,
              hasWriterCore: !!writerInfo?.writerCore,
              hasWriterCoreHex: !!writerInfo?.writerCoreHex,
              hasAutobaseLocal: !!writerInfo?.autobaseLocal,
              hasWriterSecret: !!writerInfo?.writerSecret
            })
          } catch (err) {
            console.warn('[GroupsProvider] Failed to provision writer for invitee', err)
          }
        }

        const writerCoreKey =
          writerInfo?.writerCoreHex || writerInfo?.autobaseLocal || writerInfo?.writerCore || null
        let inviteMirrorMetadata = mirrorMetadata
        if (!isOpenGroup) {
          const refreshedMirror = await fetchInviteMirrorMetadata(relayEntry?.relayKey || groupId, resolved)
          inviteMirrorMetadata = mergeWriterCoreIntoMirror(refreshedMirror || mirrorMetadata, writerCoreKey)
          mirrorMetadata = inviteMirrorMetadata
        }

        const token = isOpenGroup ? null : randomString(24)
        const payload = isOpenGroup
          ? buildOpenInvitePayload({
              relayUrl: inviteRelayUrl,
              relayKey: relayEntry?.relayKey || null
            })
          : buildInvitePayload({
              token: token as string,
              relayUrl: inviteRelayUrl,
              relayKey: relayEntry?.relayKey || null,
              meta,
              mirrorMetadata: inviteMirrorMetadata,
              writerInfo
            })
        const encryptedPayload = await nip04Encrypt(invitee, JSON.stringify(payload))
        console.info('[GroupsProvider] Invite payload built', {
          groupId,
          invitee,
          openInvite: isOpenGroup,
          hasWriterCore: !!writerInfo?.writerCore,
          hasWriterCoreHex: !!writerInfo?.writerCoreHex,
          hasAutobaseLocal: !!writerInfo?.autobaseLocal,
          hasWriterSecret: !!writerInfo?.writerSecret,
          writerSecretLen: writerInfo?.writerSecret ? String(writerInfo.writerSecret).length : 0,
          relayKey: relayEntry?.relayKey ? String(relayEntry.relayKey).slice(0, 16) : null,
          relayUrl: inviteRelayUrl ? String(inviteRelayUrl).slice(0, 80) : null,
          mirrorCoresCount: Array.isArray(inviteMirrorMetadata?.cores) ? inviteMirrorMetadata.cores.length : 0,
          fileSharing: resolvedIsOpen === false ? false : true
        })
        const inviteTags: string[][] = [
          ['h', groupId],
          ['p', invitee],
          ['i', 'hypertuna']
        ]
        if (inviteName) inviteTags.push(['name', inviteName])
        if (inviteAbout) inviteTags.push(['about', inviteAbout])
        inviteTags.push([resolvedIsOpen === false ? 'file-sharing-off' : 'file-sharing-on'])

        if (!isOpenGroup && token) {
          // Add 9000 put-user so membership/auth is consistent with legacy flow
          const putUser: TDraftEvent = {
            kind: 9000,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['h', groupId],
              ['p', invitee, 'member', token]
            ],
            content: ''
          }
          await publish(putUser, { specifiedRelayUrls: relayUrls })
        }

        const draftEvent: TDraftEvent = {
          kind: 9009,
          created_at: Math.floor(Date.now() / 1000),
          tags: inviteTags,
          content: encryptedPayload
        }
        await publish(draftEvent, { specifiedRelayUrls: relayUrls })

        if (!isOpenGroup && token) {
          try {
            if (sendToWorker) {
              const memberTs = Date.now()
              await sendToWorker({
                type: 'update-auth-data',
                data: {
                  relayKey: relayEntry?.relayKey,
                  publicIdentifier: groupId,
                  pubkey: invitee,
                  token
                }
              })
              await sendToWorker({
                type: 'update-members',
                data: {
                  relayKey: relayEntry?.relayKey,
                  publicIdentifier: groupId,
                  member_adds: [{ pubkey: invitee, ts: memberTs }]
                }
              })
            }
          } catch (_err) {
            // best effort
          }
        }
      }
    },
    [discoveryGroups, fetchInviteMirrorMetadata, getRelayEntryForGroup, nip04Encrypt, pubkey, publish, resolveRelayUrl, sendToWorker]
  )

  const approveJoinRequest = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const groupKey = toGroupKey(groupId, relay)
      const token = randomString(24)
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      const relayUrls = resolved ? [resolved] : discoveryRelays
      const timestamp = Math.floor(Date.now() / 1000)

      // Build put-user (9000) with token
      const putUser: TDraftEvent = {
        kind: 9000,
        created_at: timestamp,
        tags: [
          ['h', groupId],
          ['p', targetPubkey, 'member', token]
        ],
        content: ''
      }
      await publish(putUser, { specifiedRelayUrls: relayUrls })

      // Resolve metadata for invite tags/payload
      let meta =
        discoveryGroups.find(
          (g) => g.id === groupId && (!relay || !g.relay || g.relay === relay || g.relay === resolved)
        ) || null
      if (!meta) {
        try {
          const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
          meta = detail?.metadata || null
        } catch (_err) {
          // ignore
        }
      }

      const baseRelayUrl = resolved ? getBaseRelayUrl(resolved) : undefined
      const relayEntry = getRelayEntryForGroup(groupId)

      let writerInfo: {
        writerCore?: string
        writerCoreHex?: string
        autobaseLocal?: string
        writerSecret?: string
      } | null = null
      if (sendToWorker && relayEntry?.relayKey) {
        try {
          const res = await sendToWorker({
            type: 'provision-writer-for-invitee',
            data: { relayKey: relayEntry.relayKey, publicIdentifier: groupId, inviteePubkey: targetPubkey }
          })
          if (res && typeof res === 'object') {
            writerInfo = {
              writerCore: (res as any).writerCore,
              writerCoreHex: (res as any).writerCoreHex,
              autobaseLocal: (res as any).autobaseLocal,
              writerSecret: (res as any).writerSecret
            }
          }
          console.info('[GroupsProvider] Writer provisioning result (approval)', {
            groupId,
            targetPubkey,
            relayKey: relayEntry.relayKey,
            hasWriterCore: !!writerInfo?.writerCore,
            hasWriterCoreHex: !!writerInfo?.writerCoreHex,
            hasAutobaseLocal: !!writerInfo?.autobaseLocal,
            hasWriterSecret: !!writerInfo?.writerSecret
          })
        } catch (err) {
          console.warn('[GroupsProvider] Failed to provision writer for approval', err)
        }
      }

      let mirrorMetadata = await fetchInviteMirrorMetadata(relayEntry?.relayKey || groupId, resolved)
      const writerCoreKey =
        writerInfo?.writerCoreHex || writerInfo?.autobaseLocal || writerInfo?.writerCore
      if (writerCoreKey) {
        if (!mirrorMetadata) mirrorMetadata = {}
        const cores = Array.isArray(mirrorMetadata.cores) ? [...mirrorMetadata.cores] : []
        cores.push({ key: writerCoreKey, role: 'autobase-writer' })
        mirrorMetadata.cores = cores
      }
      const payload = buildInvitePayload({
        token,
        relayUrl: baseRelayUrl || resolved || relay || null,
        relayKey: relayEntry?.relayKey || null,
        meta,
        mirrorMetadata,
        writerInfo
      })
      console.info('[GroupsProvider] Approval invite payload built', {
        groupId,
        targetPubkey,
        hasWriterCore: !!writerInfo?.writerCore,
        hasWriterCoreHex: !!writerInfo?.writerCoreHex,
        hasAutobaseLocal: !!writerInfo?.autobaseLocal,
        hasWriterSecret: !!writerInfo?.writerSecret
      })

      // Build encrypted invite (9009)
      const tags: string[][] = [
        ['h', groupId],
        ['p', targetPubkey],
        ['i', 'hypertuna']
      ]
      if (meta?.name) tags.push(['name', meta.name])
      if (meta?.about) tags.push(['about', meta.about])
      tags.push([payload.fileSharing === false ? 'file-sharing-off' : 'file-sharing-on'])

      const encryptedPayload = await nip04Encrypt(targetPubkey, JSON.stringify(payload))
      const inviteEvent: TDraftEvent = {
        kind: 9009,
        created_at: timestamp,
        tags,
        content: encryptedPayload
      }
      await publish(inviteEvent, { specifiedRelayUrls: relayUrls })

      // Notify worker about auth/membership so relay profile is synced
      try {
        if (sendToWorker) {
          const memberTs = Date.now()
          await sendToWorker({
            type: 'update-auth-data',
            data: {
              relayKey: relayEntry?.relayKey,
              publicIdentifier: groupId,
              pubkey: targetPubkey,
              token
            }
          })
          await sendToWorker({
            type: 'update-members',
            data: {
              relayKey: relayEntry?.relayKey,
              publicIdentifier: groupId,
              member_adds: [{ pubkey: targetPubkey, ts: memberTs }]
            }
          })
        }
      } catch (_err) {
        // best effort; worker may not be available in web mode
      }

      setJoinRequests((prev) => {
        const next = { ...prev }
        next[groupKey] = (prev[groupKey] || []).filter((req) => req.pubkey !== targetPubkey)
        return next
      })
      setRejectedJoinRequests((prev) => {
        const next = { ...prev }
        const set = new Set(next[groupKey] || [])
        set.delete(targetPubkey)
        next[groupKey] = set
        return next
      })
    },
    [discoveryGroups, discoveryRelays, fetchGroupDetail, fetchInviteMirrorMetadata, getRelayEntryForGroup, nip04Encrypt, publish, pubkey, resolveRelayUrl, sendToWorker]
  )

  const rejectJoinRequest = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      const groupKey = toGroupKey(groupId, relay)
      setJoinRequests((prev) => {
        const next = { ...prev }
        next[groupKey] = (prev[groupKey] || []).filter((req) => req.pubkey !== targetPubkey)
        return next
      })
      setRejectedJoinRequests((prev) => {
        const next = { ...prev }
        const set = new Set(next[groupKey] || [])
        set.add(targetPubkey)
        next[groupKey] = set
        return next
      })
    },
    []
  )

  const updateMetadata = useCallback(
    async (
      groupId: string,
      data: Partial<{ name: string; about: string; picture: string; isPublic: boolean; isOpen: boolean }>,
      relay?: string
    ) => {
      if (!pubkey) throw new Error('Not logged in')
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      const baseTagValue = (value?: string) => (typeof value === 'string' ? value.trim() : undefined)

      const commandTags: string[][] = [['h', groupId]]
      const name = baseTagValue(data.name)
      const about = baseTagValue(data.about)
      const picture = baseTagValue(data.picture)

      if (name !== undefined) commandTags.push(['name', name])
      if (about !== undefined) commandTags.push(['about', about])
      if (picture) commandTags.push(['picture', picture])
      if (typeof data.isPublic === 'boolean') commandTags.push([data.isPublic ? 'public' : 'private'])
      if (typeof data.isOpen === 'boolean') commandTags.push([data.isOpen ? 'open' : 'closed'])

      if (commandTags.length > 1) {
        const draftEvent: TDraftEvent = {
          kind: 9002,
          created_at: Math.floor(Date.now() / 1000),
          tags: commandTags,
          content: ''
        }
        console.info('[GroupsProvider] updateMetadata command 9002', draftEvent)
        await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
      }

      // Publish a 39000 snapshot so clients render the updated metadata
      const metadataTags: string[][] = [
        ['h', groupId],
        ['d', groupId]
      ]
      if (name !== undefined) metadataTags.push(['name', name])
      if (about !== undefined) metadataTags.push(['about', about])
      if (picture) metadataTags.push(['picture', picture])
      if (typeof data.isPublic === 'boolean') metadataTags.push([data.isPublic ? 'public' : 'private'])
      if (typeof data.isOpen === 'boolean') metadataTags.push([data.isOpen ? 'open' : 'closed'])

      const isHypertuna = groupId.includes(':')
      if (isHypertuna) {
        metadataTags.push(['hypertuna', groupId])
        metadataTags.push(['i', HYPERTUNA_IDENTIFIER_TAG])
      }

      if (metadataTags.length > 2) {
        const metadataEvent: TDraftEvent = {
          kind: ExtendedKind.GROUP_METADATA,
          created_at: Math.floor(Date.now() / 1000),
          tags: metadataTags,
          content: ''
        }
        console.info('[GroupsProvider] updateMetadata 39000', metadataEvent)
        const relayUrls = resolved ? Array.from(new Set([resolved, ...discoveryRelays])) : discoveryRelays
        await publish(metadataEvent, { specifiedRelayUrls: relayUrls })

        // Optimistically update discoveryGroups cache
        setDiscoveryGroups((prev) =>
          prev.map((g) => {
            if (g.id !== groupId) return g
            if (relay && g.relay) {
              const baseRelay = getBaseRelayUrl(relay)
              const baseExisting = getBaseRelayUrl(g.relay)
              if (baseRelay !== baseExisting) return g
            }
            return {
              ...g,
              name: name ?? g.name,
              about: about ?? g.about,
              picture: picture ?? g.picture,
              isPublic: typeof data.isPublic === 'boolean' ? data.isPublic : g.isPublic,
              isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : g.isOpen
            }
          })
        )

        // Refresh discovery list to propagate to other views/cards
        refreshDiscovery().catch(() => {})
      }
    },
    [discoveryRelays, pubkey, publish, refreshDiscovery, resolveRelayUrl]
  )

  const addUser = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const grantAdmin = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9003,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey, 'admin']
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const removeUser = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const deleteGroup = useCallback(
    async (groupId: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9008,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const deleteEvent = useCallback(
    async (groupId: string, eventId: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9005,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['e', eventId]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const value = useMemo<TGroupsContext>(
    () => ({
      discoveryGroups,
      invites,
      joinRequests,
      favoriteGroups,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      refreshDiscovery,
      refreshInvites,
      loadJoinRequests,
      resolveRelayUrl,
      toggleFavorite,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      sendInvites,
      updateMetadata,
      grantAdmin,
      approveJoinRequest,
      rejectJoinRequest,
      addUser,
      removeUser,
      deleteGroup,
      deleteEvent,
    createGroup: async (data) => {
      const { name, about, picture, isPublic, isOpen, relays } = data
      if (!pubkey) throw new Error('Not logged in')

        const discoveryTargets = discoveryRelays
        const localTargets = relays?.length ? relays : discoveryRelays
        const groupId = buildGroupIdForCreation(pubkey, name)
        const createdAt = Math.floor(Date.now() / 1000)

        const creationEvent: TDraftEvent = {
          kind: 9007,
          created_at: createdAt,
          tags: [['h', groupId]],
          content: ''
        }

      const metadataTags: string[][] = [['h', groupId]]
      metadataTags.push(['name', name])
      if (about) metadataTags.push(['about', about])
      if (picture) metadataTags.push(['picture', picture])
      metadataTags.push([isPublic ? 'public' : 'private'])
      metadataTags.push([isOpen ? 'open' : 'closed'])
      metadataTags.push(['i', HYPERTUNA_IDENTIFIER_TAG])

      const metadataEvent: TDraftEvent = {
        kind: 39000,
        created_at: createdAt,
        tags: metadataTags,
        content: ''
      }
      console.info('[GroupsProvider] createGroup metadata event', metadataEvent)

        // Admins (self)
        const adminsEvent: TDraftEvent = {
          kind: 39001,
          created_at: createdAt,
          tags: [
            ['h', groupId],
            ['p', pubkey, 'admin']
          ],
          content: ''
        }

        // Members (self)
        const membersEvent: TDraftEvent = {
          kind: 39002,
          created_at: createdAt,
          tags: [
            ['h', groupId],
            ['p', pubkey]
          ],
          content: ''
        }

        // Roles placeholder
        const rolesEvent: TDraftEvent = {
          kind: 39003,
          created_at: createdAt,
          tags: [['h', groupId]],
          content: ''
        }

        // Publish per public/private rules
        await publish(creationEvent, { specifiedRelayUrls: localTargets })

        // 39000 always to discovery + local
        await publish(metadataEvent, { specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets])) })

        if (isPublic) {
          await publish(adminsEvent, { specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets])) })
          await publish(membersEvent, { specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets])) })
          await publish(rolesEvent, { specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets])) })
        } else {
          // private: 39001/02/03 only to local
          await publish(adminsEvent, { specifiedRelayUrls: localTargets })
          await publish(membersEvent, { specifiedRelayUrls: localTargets })
          await publish(rolesEvent, { specifiedRelayUrls: localTargets })
        }

        setDiscoveryRelays(discoveryTargets)
        const updatedList = [...myGroupList, { groupId, relay: localTargets[0] }]
        setMyGroupList(updatedList)
        await saveMyGroupList(updatedList)
        return { groupId, relay: localTargets[0] }
      },
      createHypertunaRelayGroup
    }),
    [
      discoveryGroups,
      favoriteGroups,
      invites,
      joinRequests,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      refreshDiscovery,
      refreshInvites,
      loadJoinRequests,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      sendInvites,
      updateMetadata,
      grantAdmin,
      approveJoinRequest,
      rejectJoinRequest,
      addUser,
      removeUser,
      deleteGroup,
      deleteEvent,
      toggleFavorite,
      pubkey,
      discoveryRelays,
      publish,
      resolveRelayUrl,
      createHypertunaRelayGroup
    ]
  )

  useEffect(() => {
    refreshDiscovery()
  }, [refreshDiscovery])

  useEffect(() => {
    refreshInvites()
  }, [refreshInvites])

  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>
}
