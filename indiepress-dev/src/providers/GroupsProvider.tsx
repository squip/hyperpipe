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
  resolveGroupMembersFromSnapshotAndOps,
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
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from './NostrProvider'
import { randomString } from '@/lib/random'
import { useWorkerBridge } from './WorkerBridgeProvider'
import type { TPublishOptions } from '@/types'
import * as nip19 from '@nostr/tools/nip19'

// Prevent repeated bootstrap publishes per group/relay when admin snapshots are missing.
const adminRecoveryAttempts = new Set<string>()
const DEFAULT_PUBLIC_GATEWAY_BASE = 'https://hypertuna.com'
const INVITE_DISMISSED_STORAGE_PREFIX = 'hypertuna_group_invites_dismissed_v1'
const INVITE_ACCEPTED_STORAGE_PREFIX = 'hypertuna_group_invites_accepted_v1'
const INVITE_ACCEPTED_GROUPS_STORAGE_PREFIX = 'hypertuna_group_invites_accepted_groups_v1'
const JOIN_REQUESTS_HANDLED_STORAGE_KEY = 'hypertuna_join_requests_handled_v1'
const GROUP_MEMBER_PREVIEW_TTL_MS = 2 * 60 * 1000

type GroupMemberPreviewEntry = {
  members: string[]
  updatedAt: number
  authoritative: boolean
  source: 'group-relay' | 'fallback-discovery' | 'group-relay-empty' | 'authoritative-promotion' | 'unknown'
}

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
  dismissInvite: (inviteId: string) => void
  markInviteAccepted: (inviteId: string, groupId?: string) => void
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
    membershipAuthoritative: boolean
    membershipEventsCount: number
    membersFromEventCount: number
    membersSnapshotCreatedAt: number | null
    membershipFetchTimedOutLike: boolean
    membershipFetchSource: 'group-relay' | 'fallback-discovery' | 'group-relay-empty'
  }>
  getGroupMemberPreview: (
    groupId: string,
    relay?: string
  ) => { members: string[]; updatedAt: number; authoritative: boolean; source: GroupMemberPreviewEntry['source'] } | null
  groupMemberPreviewVersion: number
  refreshGroupMemberPreview: (
    groupId: string,
    relay?: string,
    opts?: { force?: boolean; reason?: string }
  ) => Promise<string[]>
  invalidateGroupMemberPreview: (groupId: string, relay?: string, opts?: { reason?: string }) => void
  sendInvites: (groupId: string, invitees: string[], relay?: string, options?: SendInviteOptions) => Promise<void>
  updateMetadata: (groupId: string, data: Partial<{ name: string; about: string; picture: string; isPublic: boolean; isOpen: boolean }>, relay?: string) => Promise<void>
  grantAdmin: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  approveJoinRequest: (
    groupId: string,
    targetPubkey: string,
    relay?: string,
    requestCreatedAt?: number
  ) => Promise<void>
  rejectJoinRequest: (
    groupId: string,
    targetPubkey: string,
    relay?: string,
    requestCreatedAt?: number
  ) => Promise<void>
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
      dismissInvite: () => {},
      markInviteAccepted: () => {},
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
        membershipStatus: 'not-member' as TGroupMembershipStatus,
        membershipAuthoritative: false,
        membershipEventsCount: 0,
        membersFromEventCount: 0,
        membersSnapshotCreatedAt: null,
        membershipFetchTimedOutLike: false,
        membershipFetchSource: 'group-relay' as const
      }),
      getGroupMemberPreview: () => null,
      groupMemberPreviewVersion: 0,
      refreshGroupMemberPreview: async () => [],
      invalidateGroupMemberPreview: () => {},
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
const toJoinRequestHandledKey = (pubkey: string, createdAt: number) => `${pubkey}:${createdAt}`
const toGroupMemberPreviewKey = (groupId: string, relay?: string) =>
  `${relay ? getBaseRelayUrl(relay) : ''}|${groupId}`

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
  picture?: string
  authorizedMemberPubkeys?: string[]
}

const normalizePubkeyList = (values?: string[] | null) =>
  Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )

const areSameMemberLists = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, idx) => value === right[idx])

const readInviteCache = (key: string): Set<string> => {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map((entry) => String(entry || '').trim()).filter(Boolean))
  } catch (_err) {
    return new Set()
  }
}

const buildInvitePayload = (args: {
  token: string
  relayUrl: string | null
  relayKey?: string | null
  meta?: TGroupMetadata | null
  groupName?: string
  groupPicture?: string
  authorizedMemberPubkeys?: string[]
  mirrorMetadata?: InviteMirrorMetadata
  fastForward?: {
    key?: string | null
    length?: number | null
    signedLength?: number | null
    timeoutMs?: number | null
  } | null
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
  groupName: args.groupName || args.meta?.name,
  groupPicture: args.groupPicture || args.meta?.picture || null,
  authorizedMemberPubkeys: normalizePubkeyList(args.authorizedMemberPubkeys),
  name: args.groupName || args.meta?.name,
  about: args.meta?.about,
  fileSharing: args.meta?.isOpen !== false,
  blindPeer: args.mirrorMetadata?.blindPeer,
  cores: args.mirrorMetadata?.cores,
  fastForward: args.fastForward ?? null,
  writerCore: args.writerInfo?.writerCore || null,
  writerCoreHex: args.writerInfo?.writerCoreHex || args.writerInfo?.autobaseLocal || null,
  autobaseLocal: args.writerInfo?.autobaseLocal || args.writerInfo?.writerCoreHex || null,
  writerSecret: args.writerInfo?.writerSecret || null
})

const buildOpenInvitePayload = (args: {
  relayUrl: string | null
  relayKey?: string | null
  groupName?: string
  groupPicture?: string
  authorizedMemberPubkeys?: string[]
}) => ({
  relayUrl: args.relayUrl,
  relayKey: args.relayKey ?? null,
  groupName: args.groupName || null,
  groupPicture: args.groupPicture || null,
  authorizedMemberPubkeys: normalizePubkeyList(args.authorizedMemberPubkeys)
})

const extractRelayKeyFromUrl = (value?: string | null) => {
  if (!value) return null
  try {
    const parsed = new URL(value)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const maybeKey = parts[0] || null
    if (maybeKey && /^[0-9a-fA-F]{64}$/.test(maybeKey)) {
      return maybeKey.toLowerCase()
    }
  } catch (_err) {
    const parts = String(value).split('/').filter(Boolean)
    const maybeKey = parts[0] || null
    if (maybeKey && /^[0-9a-fA-F]{64}$/.test(maybeKey)) {
      return maybeKey.toLowerCase()
    }
  }
  return null
}

const buildMembershipPublishTargets = (resolvedRelay: string | null | undefined, isPublicGroup: boolean) => {
  const targets = new Set<string>()
  if (resolvedRelay) targets.add(resolvedRelay)
  if (isPublicGroup) {
    defaultDiscoveryRelays.forEach((url) => targets.add(url))
  }
  return Array.from(targets)
}

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
  const [handledJoinRequests, setHandledJoinRequests] = useState<Record<string, Set<string>>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(JOIN_REQUESTS_HANDLED_STORAGE_KEY)
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
  const [dismissedInviteIds, setDismissedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteIds, setAcceptedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteGroupIds, setAcceptedInviteGroupIds] = useState<Set<string>>(new Set())
  const [groupMemberPreviewByKey, setGroupMemberPreviewByKey] = useState<Record<string, GroupMemberPreviewEntry>>({})
  const [groupMemberPreviewVersion, setGroupMemberPreviewVersion] = useState(0)
  const dismissedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteGroupIdsRef = useRef<Set<string>>(new Set())
  const groupMemberPreviewByKeyRef = useRef<Record<string, GroupMemberPreviewEntry>>({})
  const groupMemberPreviewInFlightRef = useRef<Map<string, Promise<string[]>>>(new Map())

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

  const fetchInviteMirrorMetadata = useCallback(async (relayIdentifier: string, resolved?: string | null): Promise<InviteMirrorMetadata> => {
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
    if (!pubkey || typeof window === 'undefined') {
      const empty = new Set<string>()
      setDismissedInviteIds(empty)
      dismissedInviteIdsRef.current = empty
      setAcceptedInviteIds(empty)
      acceptedInviteIdsRef.current = empty
      setAcceptedInviteGroupIds(empty)
      acceptedInviteGroupIdsRef.current = empty
      return
    }

    const dismissed = readInviteCache(`${INVITE_DISMISSED_STORAGE_PREFIX}:${pubkey}`)
    const accepted = readInviteCache(`${INVITE_ACCEPTED_STORAGE_PREFIX}:${pubkey}`)
    const acceptedGroups = readInviteCache(`${INVITE_ACCEPTED_GROUPS_STORAGE_PREFIX}:${pubkey}`)
    setDismissedInviteIds(dismissed)
    dismissedInviteIdsRef.current = dismissed
    setAcceptedInviteIds(accepted)
    acceptedInviteIdsRef.current = accepted
    setAcceptedInviteGroupIds(acceptedGroups)
    acceptedInviteGroupIdsRef.current = acceptedGroups
  }, [pubkey])

  useEffect(() => {
    dismissedInviteIdsRef.current = dismissedInviteIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        `${INVITE_DISMISSED_STORAGE_PREFIX}:${pubkey}`,
        JSON.stringify(Array.from(dismissedInviteIds))
      )
    } catch (_err) {
      // best effort
    }
  }, [dismissedInviteIds, pubkey])

  useEffect(() => {
    acceptedInviteIdsRef.current = acceptedInviteIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        `${INVITE_ACCEPTED_STORAGE_PREFIX}:${pubkey}`,
        JSON.stringify(Array.from(acceptedInviteIds))
      )
    } catch (_err) {
      // best effort
    }
  }, [acceptedInviteIds, pubkey])

  useEffect(() => {
    acceptedInviteGroupIdsRef.current = acceptedInviteGroupIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        `${INVITE_ACCEPTED_GROUPS_STORAGE_PREFIX}:${pubkey}`,
        JSON.stringify(Array.from(acceptedInviteGroupIds))
      )
    } catch (_err) {
      // best effort
    }
  }, [acceptedInviteGroupIds, pubkey])

  useEffect(() => {
    groupMemberPreviewByKeyRef.current = groupMemberPreviewByKey
  }, [groupMemberPreviewByKey])

  useEffect(() => {
    setGroupMemberPreviewByKey({})
    setGroupMemberPreviewVersion(0)
    groupMemberPreviewByKeyRef.current = {}
    groupMemberPreviewInFlightRef.current.clear()
  }, [pubkey])

  useEffect(() => {
    // Clear per-account volatile state on account switch
    setJoinRequests({})
    setHandledJoinRequests({})
  }, [pubkey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const serialized: Record<string, string[]> = {}
    Object.entries(handledJoinRequests).forEach(([k, v]) => {
      serialized[k] = Array.from(v)
    })
    try {
      window.localStorage.setItem(JOIN_REQUESTS_HANDLED_STORAGE_KEY, JSON.stringify(serialized))
    } catch (_err) {
      // best effort
    }
  }, [handledJoinRequests])

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

  const dismissInvite = useCallback((inviteId: string) => {
    const normalizedInviteId = String(inviteId || '').trim()
    if (!normalizedInviteId) return
    setDismissedInviteIds((prev) => {
      if (prev.has(normalizedInviteId)) return prev
      const next = new Set(prev)
      next.add(normalizedInviteId)
      return next
    })
    setInvites((prev) => prev.filter((invite) => invite.event?.id !== normalizedInviteId))
  }, [])

  const markInviteAccepted = useCallback((inviteId: string, groupId?: string) => {
    const normalizedInviteId = String(inviteId || '').trim()
    const normalizedGroupId = String(groupId || '').trim()
    if (normalizedInviteId) {
      setAcceptedInviteIds((prev) => {
        if (prev.has(normalizedInviteId)) return prev
        const next = new Set(prev)
        next.add(normalizedInviteId)
        return next
      })
    }
    if (normalizedGroupId) {
      setAcceptedInviteGroupIds((prev) => {
        if (prev.has(normalizedGroupId)) return prev
        const next = new Set(prev)
        next.add(normalizedGroupId)
        return next
      })
    }
    setInvites((prev) =>
      prev.filter((invite) => {
        if (normalizedInviteId && invite.event?.id === normalizedInviteId) return false
        if (normalizedGroupId && invite.groupId === normalizedGroupId) return false
        return true
      })
    )
  }, [])

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
            let groupName: string | undefined = invite.groupName || invite.name
            let groupPicture: string | undefined = invite.groupPicture
            let authorizedMemberPubkeys: string[] | undefined
            let fileSharing: boolean | undefined = invite.fileSharing
            let blindPeer: TGroupInvite['blindPeer'] | null | undefined
            let cores: TGroupInvite['cores'] | undefined
            let writerCore: string | null | undefined
            let writerCoreHex: string | null | undefined
            let autobaseLocal: string | null | undefined
            let writerSecret: string | null | undefined
            let fastForward: { key?: string | null; length?: number | null; signedLength?: number | null; timeoutMs?: number | null } | null | undefined
            try {
              const payload = JSON.parse(decrypted)
              if (payload && typeof payload === 'object') {
                token = typeof payload.token === 'string' ? payload.token : undefined
                relayUrl = typeof payload.relayUrl === 'string' ? payload.relayUrl : null
                relayKey = typeof payload.relayKey === 'string' ? payload.relayKey : null
                if (typeof payload.groupName === 'string') {
                  groupName = payload.groupName
                } else if (typeof payload.name === 'string') {
                  groupName = payload.name
                }
                if (typeof payload.groupPicture === 'string') {
                  groupPicture = payload.groupPicture
                } else if (typeof payload.picture === 'string') {
                  groupPicture = payload.picture
                }
                const payloadAuthorizedMembers = Array.isArray(payload.authorizedMemberPubkeys)
                  ? payload.authorizedMemberPubkeys
                  : Array.isArray(payload.authorizedMembers)
                    ? payload.authorizedMembers
                    : Array.isArray(payload.memberPubkeys)
                      ? payload.memberPubkeys
                      : null
                if (payloadAuthorizedMembers) {
                  authorizedMemberPubkeys = normalizePubkeyList(payloadAuthorizedMembers)
                }
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
                const fastForwardPayload =
                  (payload.fastForward && typeof payload.fastForward === 'object')
                    ? payload.fastForward
                    : (payload.fast_forward && typeof payload.fast_forward === 'object')
                      ? payload.fast_forward
                      : null
                if (fastForwardPayload) {
                  fastForward = {
                    key: typeof fastForwardPayload.key === 'string' ? fastForwardPayload.key : null,
                    length: typeof fastForwardPayload.length === 'number' ? fastForwardPayload.length : null,
                    signedLength: typeof fastForwardPayload.signedLength === 'number' ? fastForwardPayload.signedLength : null,
                    timeoutMs: typeof fastForwardPayload.timeoutMs === 'number'
                      ? fastForwardPayload.timeoutMs
                      : typeof fastForwardPayload.timeout === 'number'
                        ? fastForwardPayload.timeout
                        : null
                  }
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
              groupName,
              groupPicture,
              authorizedMemberPubkeys,
              token,
              relayUrl,
              relayKey,
              fileSharing,
              blindPeer,
              cores,
              writerCore,
              writerCoreHex,
              autobaseLocal,
              writerSecret,
              fastForward
            }
          } catch (_err) {
            return invite
          }
        })
      )
      console.info('[GroupsProvider] Refreshed invites writer stats', {
        total: parsed.length,
        withGroupName: parsed.filter((p) => (p as any).groupName || (p as any).name).length,
        withGroupPicture: parsed.filter((p) => (p as any).groupPicture).length,
        withAuthorizedMembers: parsed.filter((p) => Array.isArray((p as any).authorizedMemberPubkeys) && (p as any).authorizedMemberPubkeys.length > 0).length,
        withWriterSecret: parsed.filter((p) => (p as any).writerSecret).length,
        withWriterCore: parsed.filter((p) => (p as any).writerCore).length,
        withWriterCoreHex: parsed.filter((p) => (p as any).writerCoreHex).length,
        withFastForward: parsed.filter((p) => (p as any).fastForward).length
      })
      const joinedGroupIds = new Set(myGroupList.map((entry) => entry.groupId))
      const filtered = parsed.filter((invite) => {
        const inviteId = invite.event?.id
        if (inviteId && dismissedInviteIdsRef.current.has(inviteId)) return false
        if (inviteId && acceptedInviteIdsRef.current.has(inviteId)) return false
        if (acceptedInviteGroupIdsRef.current.has(invite.groupId)) return false
        if (joinedGroupIds.has(invite.groupId)) return false
        return true
      })
      setInvites(filtered)
    } catch (error) {
      console.warn('Failed to refresh group invites', error)
      setInvitesError((error as Error).message)
    }
  }, [discoveryRelays, myGroupList, nip04Decrypt, pubkey])

  const loadJoinRequests = useCallback(
    async (groupId: string, relay?: string) => {
      if (!groupId) return
      setJoinRequestsError(null)
      const groupKey = toGroupKey(groupId, relay)
      try {
        const relayUrls = discoveryRelays
        console.info('[GroupsProvider] Fetching join requests', {
          groupId,
          relay,
          relayUrlsCount: relayUrls.length,
          relayUrlsPreview: relayUrls.slice(0, 4)
        })

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

        const currentMembers = new Set(
          resolveGroupMembersFromSnapshotAndOps({
            membershipEvents
          })
        )

        const handled = handledJoinRequests[groupKey] || new Set<string>()
        const dedupedLatestByPubkey = new Map<string, TJoinRequest>()
        joinEvents
          .map(parseGroupJoinRequestEvent)
          .forEach((jr) => {
            const existing = dedupedLatestByPubkey.get(jr.pubkey)
            if (!existing || jr.created_at > existing.created_at) {
              dedupedLatestByPubkey.set(jr.pubkey, jr)
            }
          })
        const parsed = Array.from(dedupedLatestByPubkey.values()).filter((jr) => {
          if (currentMembers.has(jr.pubkey)) return false
          const handledKey = toJoinRequestHandledKey(jr.pubkey, jr.created_at)
          if (handled.has(handledKey)) return false
          return true
        })
        console.info('[GroupsProvider] Join requests resolved', {
          groupId,
          fetched: joinEvents.length,
          deduped: dedupedLatestByPubkey.size,
          filteredCurrentMembers: Array.from(dedupedLatestByPubkey.values()).filter((jr) =>
            currentMembers.has(jr.pubkey)
          ).length,
          filteredHandled: Array.from(dedupedLatestByPubkey.values()).filter((jr) =>
            handled.has(toJoinRequestHandledKey(jr.pubkey, jr.created_at))
          ).length,
          finalCount: parsed.length
        })
        setJoinRequests((prev) => ({ ...prev, [groupKey]: parsed }))
      } catch (error) {
        setJoinRequestsError((error as Error).message)
      }
    },
    [discoveryRelays, handledJoinRequests]
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
    const joinedGroupIds = new Set(myGroupList.map((entry) => entry.groupId))
    setInvites((prev) =>
      prev.filter((invite) => {
        const inviteId = invite.event?.id
        if (inviteId && dismissedInviteIdsRef.current.has(inviteId)) return false
        if (inviteId && acceptedInviteIdsRef.current.has(inviteId)) return false
        if (acceptedInviteGroupIdsRef.current.has(invite.groupId)) return false
        if (joinedGroupIds.has(invite.groupId)) return false
        return true
      })
    )
  }, [myGroupList])

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

  const fetchMembershipPreview = useCallback(
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
      const groupRelays = preferRelay && resolved ? [resolved] : defaultDiscoveryRelays

      const time = () => performance.now()
      let primaryMembershipDuration = 0

      const fetchLatestMembersSnapshot = async () => {
        const results = await Promise.all(
          ['d', 'h'].map(async (tagKey) => {
            const filter: any = { kinds: [39002], limit: 10 }
            filter[`#${tagKey}`] = [groupId]
            const events = await client.fetchEvents(groupRelays, filter)
            return events
          })
        )
        const flat = results.flat().sort((a, b) => b.created_at - a.created_at)
        return flat[0] || null
      }

      const membersPromise = fetchLatestMembersSnapshot().catch(() => null)
      const membershipPromise = (async () => {
        const start = time()
        try {
          return await client.fetchEvents(groupRelays, {
            kinds: [9000, 9001],
            '#h': [groupId],
            limit: 50
          })
        } catch (_err) {
          return []
        } finally {
          primaryMembershipDuration = performance.now() - start
        }
      })()

      const [membersEvt, membershipEvents] = await Promise.all([membersPromise, membershipPromise])

      let effectiveMembershipEvents = membershipEvents
      let membershipFetchSource: 'group-relay' | 'fallback-discovery' | 'group-relay-empty' = 'group-relay'
      const membershipFetchTimedOutLike = primaryMembershipDuration >= 9000
      const hasRelayAuthToken = (() => {
        if (!resolved) return false
        try {
          const parsed = new URL(resolved)
          return parsed.searchParams.has('token')
        } catch (_err) {
          return /[?&]token=/.test(resolved)
        }
      })()
      const shouldFallbackMembershipFetch =
        preferRelay &&
        resolved &&
        membershipEvents.length === 0 &&
        !membersEvt &&
        (membershipFetchTimedOutLike || (!hasRelayAuthToken && isInMyGroups))

      if (shouldFallbackMembershipFetch) {
        let fallbackMembershipEvents: typeof membershipEvents = []
        try {
          fallbackMembershipEvents = await client.fetchEvents(defaultDiscoveryRelays, {
            kinds: [9000, 9001],
            '#h': [groupId],
            limit: 50
          })
        } catch (_err) {
          fallbackMembershipEvents = []
        }
        if (fallbackMembershipEvents.length > 0) {
          effectiveMembershipEvents = fallbackMembershipEvents
          membershipFetchSource = 'fallback-discovery'
        } else {
          membershipFetchSource = 'group-relay-empty'
        }
        console.info('[GroupsProvider] membership preview fallback retry', {
          groupId,
          relay: targetRelay,
          resolved,
          isInMyGroups,
          membershipFetchTimedOutLike,
          hasRelayAuthToken,
          fallbackMembershipCount: fallbackMembershipEvents.length,
          source: membershipFetchSource
        })
      }

      const membersFromEvent = membersEvt ? parseGroupMembersEvent(membersEvt) : []
      const resolvedMembers = resolveGroupMembersFromSnapshotAndOps({
        snapshotMembers: membersFromEvent,
        snapshotCreatedAt: membersEvt?.created_at,
        membershipEvents: effectiveMembershipEvents
      })

      const members = normalizePubkeyList(resolvedMembers)
      const membershipAuthoritativeRaw =
        !!membersEvt || membersFromEvent.length > 0 || effectiveMembershipEvents.length > 0
      const fallbackDiscoveryProvisional =
        membershipFetchSource === 'fallback-discovery' && isInMyGroups && !hasRelayAuthToken
      const membershipAuthoritative = fallbackDiscoveryProvisional
        ? false
        : membershipAuthoritativeRaw

      console.info('[GroupsProvider] membership preview fetch', {
        groupId,
        relay: targetRelay,
        resolved,
        preferRelay,
        membersCount: members.length,
        membershipAuthoritative,
        membershipAuthoritativeRaw,
        fallbackDiscoveryProvisional,
        hasRelayAuthToken,
        membershipFetchTimedOutLike,
        membershipFetchSource
      })

      return {
        members,
        membershipAuthoritative,
        membershipFetchSource,
        membershipFetchTimedOutLike,
        resolved,
        isInMyGroups
      }
    },
    [myGroupList, resolveRelayUrl]
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
      const fetchDurations: Record<string, number> = {}
      const logDuration = (label: string, start: number) => {
        const elapsed = performance.now() - start
        fetchDurations[label] = elapsed
        console.info(`[GroupsProvider] fetch ${label} took ${elapsed.toFixed(0)}ms`, {
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

      let effectiveMembershipEvents = membershipEvents
      let membershipFetchSource: 'group-relay' | 'fallback-discovery' | 'group-relay-empty' = 'group-relay'
      const primaryMembershipDuration = fetchDurations['9000/9001'] ?? 0
      const membershipFetchTimedOutLike = primaryMembershipDuration >= 9000
      if (preferRelay && resolved && membershipEvents.length === 0 && membershipFetchTimedOutLike) {
        const fallbackStart = time()
        let fallbackMembershipEvents: typeof membershipEvents = []
        try {
          fallbackMembershipEvents = await client.fetchEvents(defaultDiscoveryRelays, {
            kinds: [9000, 9001],
            '#h': [groupId],
            limit: 50
          })
        } catch (_error) {
          fallbackMembershipEvents = []
        }
        logDuration('9000/9001-fallback-discovery', fallbackStart)
        if (fallbackMembershipEvents.length > 0) {
          effectiveMembershipEvents = fallbackMembershipEvents
          membershipFetchSource = 'fallback-discovery'
        } else {
          membershipFetchSource = 'group-relay-empty'
        }
        console.info('[GroupsProvider] membership fallback retry', {
          groupId,
          relay: targetRelay,
          resolved,
          primaryMembershipDurationMs: Math.round(primaryMembershipDuration),
          fallbackMembershipCount: fallbackMembershipEvents.length,
          source: membershipFetchSource
        })
      }

      const membershipStatus = pubkey
        ? deriveMembershipStatus(pubkey, effectiveMembershipEvents, joinRequests)
        : 'not-member'
      const latestMembershipEvent = effectiveMembershipEvents.reduce((latest, evt) => {
        if (!latest) return evt
        if (evt.created_at > latest.created_at) return evt
        if (evt.created_at < latest.created_at) return latest
        if (evt.kind === 9001 && latest.kind !== 9001) return evt
        return latest
      }, null as (typeof membershipEvents)[number] | null)
      const latestMembershipTargetsPreview = latestMembershipEvent
        ? latestMembershipEvent.tags
            .filter((tag) => tag[0] === 'p' && tag[1])
            .map((tag) => tag[1])
            .slice(0, 5)
        : []

      // Resolve current member set from snapshot + membership ops.
      const membersFromEvent = membersEvt ? parseGroupMembersEvent(membersEvt) : []
      const resolvedMembers = resolveGroupMembersFromSnapshotAndOps({
        snapshotMembers: membersFromEvent,
        snapshotCreatedAt: membersEvt?.created_at,
        membershipEvents: effectiveMembershipEvents
      })
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
        membershipStatus === 'not-member' && pubkey && resolvedMembers.includes(pubkey)
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
      let members = resolvedMembers
      if (coercedMembershipStatus === 'member' && pubkey) {
        if (!members.includes(pubkey)) members = [...members, pubkey]
      }

      const membersSnapshotCreatedAt = membersEvt?.created_at ?? null
      const membersFromEventCount = membersFromEvent.length
      const membershipEventsCount = effectiveMembershipEvents.length
      const membershipAuthoritative =
        !!membersEvt ||
        membersFromEventCount > 0 ||
        membershipEventsCount > 0

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
        membershipEventsCount,
        joinRequestsCount: joinRequests.length,
        initialStatus: membershipStatus,
        membersFromEventCount,
        membersSnapshotCreatedAt,
        membersSnapshotId: membersEvt?.id ?? null,
        resolvedMembersCount: resolvedMembers.length,
        latestMembershipEventKind: latestMembershipEvent?.kind ?? null,
        latestMembershipEventCreatedAt: latestMembershipEvent?.created_at ?? null,
        latestMembershipTargetsPreview,
        isInMyGroups,
        isCreator,
        creatorPubkey,
        groupIdPubkey,
        membershipAuthoritative,
        membershipFetchTimedOutLike,
        membershipFetchSource,
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
        membershipAuthoritative,
        membershipEventsCount,
        membersFromEventCount,
        membersSnapshotCreatedAt,
        membershipFetchTimedOutLike,
        membershipFetchSource,
        membershipStatus: coercedMembershipStatus
      })

      // Keep GroupsPage facepile/count in sync with authoritative GroupPage detail.
      if (membershipAuthoritative) {
        const previewMembers = normalizePubkeyList(members)
        const previewKeys = Array.from(
          new Set(
            [
              toGroupMemberPreviewKey(groupId),
              targetRelay ? toGroupMemberPreviewKey(groupId, targetRelay) : null,
              resolved ? toGroupMemberPreviewKey(groupId, resolved) : null
            ].filter((key): key is string => !!key)
          )
        )

        if (previewKeys.length > 0) {
          let changed = false
          setGroupMemberPreviewByKey((prev) => {
            const next = { ...prev }
            const nextEntry: GroupMemberPreviewEntry = {
              members: previewMembers,
              updatedAt: Date.now(),
              authoritative: true,
              source: 'authoritative-promotion'
            }
            previewKeys.forEach((key) => {
              const current = next[key]
              const same =
                !!current &&
                current.authoritative === nextEntry.authoritative &&
                current.source === nextEntry.source &&
                areSameMemberLists(current.members, nextEntry.members)
              if (!same) {
                next[key] = nextEntry
                changed = true
              }
            })
            if (changed) {
              console.info('[GroupsProvider] Promoted authoritative members to preview cache', {
                groupId,
                relay: targetRelay || null,
                resolved,
                membersCount: previewMembers.length,
                keyCount: previewKeys.length
              })
            }
            return changed ? next : prev
          })
          if (changed) {
            setGroupMemberPreviewVersion((prev) => prev + 1)
          }
        }
      }

      return {
        metadata,
        admins,
        members,
        membershipStatus: coercedMembershipStatus,
        membershipAuthoritative,
        membershipEventsCount,
        membersFromEventCount,
        membersSnapshotCreatedAt,
        membershipFetchTimedOutLike,
        membershipFetchSource
      }
    },
    [discoveryRelays, pubkey, resolveRelayUrl, myGroupList]
  )

  const getGroupMemberPreview = useCallback((groupId: string, relay?: string) => {
    const normalizedGroupId = String(groupId || '').trim()
    if (!normalizedGroupId) return null
    const relayKey = relay ? toGroupMemberPreviewKey(normalizedGroupId, relay) : null
    const fallbackKey = toGroupMemberPreviewKey(normalizedGroupId)
    const fromRelay = relayKey ? groupMemberPreviewByKey[relayKey] : null
    const fromFallback = groupMemberPreviewByKey[fallbackKey]
    return fromRelay || fromFallback || null
  }, [groupMemberPreviewByKey])

  const invalidateGroupMemberPreview = useCallback(
    (groupId: string, relay?: string, opts?: { reason?: string }) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return
      const reason = opts?.reason || 'unknown'
      const suffix = `|${normalizedGroupId}`
      const explicitKey = relay ? toGroupMemberPreviewKey(normalizedGroupId, relay) : null
      let invalidated = false
      setGroupMemberPreviewByKey((prev) => {
        const keys = Object.keys(prev)
        if (!keys.length) return prev
        let changed = false
        const next: Record<string, GroupMemberPreviewEntry> = {}
        keys.forEach((key) => {
          const shouldDelete =
            key.endsWith(suffix) ||
            (explicitKey ? key === explicitKey : false)
          if (shouldDelete) {
            changed = true
            return
          }
          next[key] = prev[key]
        })
        if (changed) {
          console.info('[GroupsProvider] Invalidated member preview cache', {
            groupId: normalizedGroupId,
            relay: relay || null,
            reason
          })
        }
        invalidated = changed
        return changed ? next : prev
      })
      if (invalidated) {
        setGroupMemberPreviewVersion((prev) => prev + 1)
      }
      Array.from(groupMemberPreviewInFlightRef.current.keys()).forEach((key) => {
        if (key.includes(suffix)) {
          groupMemberPreviewInFlightRef.current.delete(key)
        }
      })
    },
    []
  )

  const refreshGroupMemberPreview = useCallback(
    async (
      groupId: string,
      relay?: string,
      opts?: { force?: boolean; reason?: string }
    ) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return []
      const reason = opts?.reason || 'unspecified'
      const cacheKeys = relay
        ? [toGroupMemberPreviewKey(normalizedGroupId, relay), toGroupMemberPreviewKey(normalizedGroupId)]
        : [toGroupMemberPreviewKey(normalizedGroupId)]
      const relayCacheKey = cacheKeys[0]
      const cached =
        groupMemberPreviewByKeyRef.current[relayCacheKey] ||
        groupMemberPreviewByKeyRef.current[toGroupMemberPreviewKey(normalizedGroupId)]
      const now = Date.now()
      if (!opts?.force && cached && now - cached.updatedAt < GROUP_MEMBER_PREVIEW_TTL_MS) {
        return cached.members
      }

      const inFlightKey = `${relayCacheKey}|${opts?.force ? 'force' : 'normal'}`
      const existingPromise = groupMemberPreviewInFlightRef.current.get(inFlightKey)
      if (existingPromise) return existingPromise

      const fetchPromise = (async () => {
        try {
          const preview = await fetchMembershipPreview(normalizedGroupId, relay, {
            discoveryOnly: !myGroupList.some((entry) => entry.groupId === normalizedGroupId),
            preferRelay: true
          })
          let members = normalizePubkeyList(preview.members || [])
          const isMember = preview.isInMyGroups

          if (isMember && pubkey && !members.includes(pubkey)) {
            members = [...members, pubkey]
          }

          const shouldBlockMembershipDowngrade =
            !!cached &&
            cached.members.length > 0 &&
            members.length < cached.members.length &&
            !preview.membershipAuthoritative &&
            (preview.membershipFetchTimedOutLike ||
              members.length === 0 ||
              (members.length === 1 && pubkey ? members[0] === pubkey : false))

          if (shouldBlockMembershipDowngrade) {
            console.info('[GroupsProvider] member preview downgrade blocked', {
              groupId: normalizedGroupId,
              relay: relay || null,
              reason,
              prevMembersCount: cached?.members.length || 0,
              nextMembersCount: members.length,
              membershipAuthoritative: preview.membershipAuthoritative,
              membershipFetchTimedOutLike: preview.membershipFetchTimedOutLike,
              membershipFetchSource: preview.membershipFetchSource
            })
            members = cached?.members || members
          }

          const entry: GroupMemberPreviewEntry = {
            members,
            updatedAt: Date.now(),
            authoritative: !!preview.membershipAuthoritative,
            source: preview.membershipFetchSource || 'unknown'
          }
          let changed = false
          let blockedByAuthoritative = 0
          let resolvedMembers = entry.members
          setGroupMemberPreviewByKey((prev) => {
            const next = { ...prev }
            cacheKeys.forEach((key) => {
              const current = next[key]
              const blockNonAuthoritativeDowngrade =
                !!current &&
                current.authoritative &&
                !entry.authoritative &&
                current.members.length >= entry.members.length
              if (blockNonAuthoritativeDowngrade) {
                blockedByAuthoritative += 1
                if (current && current.members.length >= resolvedMembers.length) {
                  resolvedMembers = current.members
                }
                return
              }
              const same =
                !!current &&
                current.authoritative === entry.authoritative &&
                current.source === entry.source &&
                areSameMemberLists(current.members, entry.members)
              if (same) {
                resolvedMembers = current.members
                return
              }
              next[key] = entry
              changed = true
              resolvedMembers = entry.members
            })
            return changed ? next : prev
          })
          if (changed) {
            setGroupMemberPreviewVersion((prev) => prev + 1)
          }
          if (blockedByAuthoritative > 0) {
            console.info('[GroupsProvider] member preview overwrite blocked by authoritative cache', {
              groupId: normalizedGroupId,
              relay: relay || null,
              reason,
              blockedKeys: blockedByAuthoritative,
              incomingMembersCount: members.length,
              incomingAuthoritative: entry.authoritative,
              incomingSource: entry.source
            })
          }
          console.info('[GroupsProvider] Refreshed member preview cache', {
            groupId: normalizedGroupId,
            relay: relay || null,
            reason,
            membersCount: members.length,
            isMember,
            source: preview.membershipFetchSource,
            membershipAuthoritative: preview.membershipAuthoritative
          })
          return resolvedMembers
        } catch (err) {
          console.warn('[GroupsProvider] Failed to refresh member preview cache', {
            groupId: normalizedGroupId,
            relay: relay || null,
            reason,
            err: err instanceof Error ? err.message : err
          })
          return cached?.members || []
        } finally {
          groupMemberPreviewInFlightRef.current.delete(inFlightKey)
        }
      })()

      groupMemberPreviewInFlightRef.current.set(inFlightKey, fetchPromise)
      return fetchPromise
    },
    [fetchMembershipPreview, myGroupList, pubkey]
  )

  const tokenizedPreviewRefreshByGroupRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (!pubkey) return
    if (!myGroupList.length) return
    if (!workerRelays.length) return

    const hasTokenInRelayUrl = (relayUrl?: string | null) => {
      if (!relayUrl) return false
      try {
        return new URL(relayUrl).searchParams.has('token')
      } catch (_err) {
        return /[?&]token=/.test(relayUrl)
      }
    }

    const nextByGroup = new Map<string, string>()

    myGroupList.forEach((entry) => {
      const relayEntry =
        workerRelays.find((r) => r.publicIdentifier === entry.groupId) ||
        workerRelays.find((r) => r.relayKey === entry.groupId) ||
        null
      if (!relayEntry?.connectionUrl) return

      const resolvedRelay = resolveRelayUrl(relayEntry.connectionUrl) || relayEntry.connectionUrl
      if (!hasTokenInRelayUrl(resolvedRelay)) return

      nextByGroup.set(entry.groupId, resolvedRelay)
      const prevRelay = tokenizedPreviewRefreshByGroupRef.current.get(entry.groupId)
      if (prevRelay === resolvedRelay) return

      console.info('[GroupsProvider] tokenized relay observed; forcing member preview refresh', {
        groupId: entry.groupId,
        relay: resolvedRelay
      })

      invalidateGroupMemberPreview(entry.groupId, resolvedRelay, {
        reason: 'worker-relay-tokenized-update'
      })
      refreshGroupMemberPreview(entry.groupId, resolvedRelay, {
        force: true,
        reason: 'worker-relay-tokenized-update'
      }).catch(() => {})
    })

    tokenizedPreviewRefreshByGroupRef.current = nextByGroup
  }, [
    invalidateGroupMemberPreview,
    myGroupList,
    pubkey,
    refreshGroupMemberPreview,
    resolveRelayUrl,
    workerRelays
  ])

  const republishMemberSnapshot39002 = useCallback(
    async (params: { groupId: string; relay?: string; isPublicGroup?: boolean; reason: string }) => {
      const { groupId, relay, isPublicGroup, reason } = params
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      let members: string[] = []
      let resolvedIsPublic = typeof isPublicGroup === 'boolean' ? isPublicGroup : true
      try {
        const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        members = normalizePubkeyList(detail?.members || [])
        if (typeof isPublicGroup !== 'boolean') {
          resolvedIsPublic = detail?.metadata?.isPublic !== false
        }
      } catch (err) {
        console.warn('[GroupsProvider] Failed to resolve members for 39002 republish', {
          groupId,
          reason,
          err: err instanceof Error ? err.message : err
        })
        return
      }

      const relayUrls = buildMembershipPublishTargets(resolved, resolvedIsPublic)
      if (!relayUrls.length) {
        console.warn('[GroupsProvider] Skipping 39002 republish: no targets', {
          groupId,
          reason,
          resolved
        })
        return
      }

      const tags: string[][] = [
        ['h', groupId],
        ['d', groupId]
      ]
      if (groupId.includes(':')) {
        tags.push(['hypertuna', groupId], ['i', HYPERTUNA_IDENTIFIER_TAG])
      }
      members.forEach((memberPubkey) => {
        tags.push(['p', memberPubkey])
      })

      const membersEvent: TDraftEvent = {
        kind: 39002,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }

      await publish(membersEvent, { specifiedRelayUrls: relayUrls })
      console.info('[GroupsProvider] Republished 39002 members snapshot', {
        groupId,
        reason,
        membersCount: members.length,
        targets: relayUrls.length,
        isPublicGroup: resolvedIsPublic
      })
      invalidateGroupMemberPreview(groupId, resolved || relay || undefined, {
        reason: `republish-39002:${reason}`
      })
      refreshGroupMemberPreview(groupId, resolved || relay || undefined, {
        force: true,
        reason: `republish-39002:${reason}`
      }).catch(() => {})

      let latestSnapshotCreatedAt: number | null = null
      let latestSnapshotId: string | null = null
      try {
        const snapshots = await client.fetchEvents(relayUrls, {
          kinds: [39002],
          '#h': [groupId],
          limit: 10
        })
        const latestSnapshot = snapshots.sort((a, b) => b.created_at - a.created_at)[0] || null
        latestSnapshotCreatedAt = latestSnapshot?.created_at ?? null
        latestSnapshotId = latestSnapshot?.id ?? null
      } catch (err) {
        console.warn('[GroupsProvider] Failed to verify latest 39002 snapshot after republish', {
          groupId,
          reason,
          err: err instanceof Error ? err.message : err
        })
      }

      let postPublishMembersCount: number | null = null
      try {
        const postDetail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        postPublishMembersCount = Array.isArray(postDetail?.members) ? postDetail.members.length : 0
      } catch (_err) {
        postPublishMembersCount = null
      }

      console.info('[GroupsProvider] 39002 republish verification', {
        groupId,
        reason,
        membersCountBeforePublish: members.length,
        latestSnapshotCreatedAt,
        latestSnapshotId,
        postPublishMembersCount,
        targets: relayUrls.length
      })
    },
    [fetchGroupDetail, invalidateGroupMemberPreview, publish, refreshGroupMemberPreview, resolveRelayUrl]
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
  const announcedOpenJoinMembershipRef = useMemo(() => new Set<string>(), [])

  useEffect(() => {
    processedJoinFlowsRef.clear()
    announcedOpenJoinMembershipRef.clear()
  }, [announcedOpenJoinMembershipRef, processedJoinFlowsRef, pubkey])

  useEffect(() => {
    if (!pubkey) return

    const announceOpenJoinMembership = (flow: (typeof joinFlows)[string], baseUrl: string) => {
      const identifier = flow?.publicIdentifier
      if (!identifier) return
      const dedupeKey = `${identifier}|${pubkey}`
      if (announcedOpenJoinMembershipRef.has(dedupeKey)) return
      const flowMode = typeof flow?.mode === 'string' ? flow.mode.toLowerCase() : ''
      const isOpenJoinMode = flowMode.includes('open')
      if (!isOpenJoinMode) return
      announcedOpenJoinMembershipRef.add(dedupeKey)

      ;(async () => {
        let isPublicGroup = true
        try {
          const fromDiscovery = discoveryGroups.find((g) => g.id === identifier)
          if (fromDiscovery) {
            isPublicGroup = fromDiscovery.isPublic !== false
          } else {
            const detail = await fetchGroupDetail(identifier, baseUrl, { preferRelay: true })
            isPublicGroup = detail?.metadata?.isPublic !== false
          }
        } catch (_err) {
          isPublicGroup = true
        }
        if (!isPublicGroup) return

        const targets = buildMembershipPublishTargets(baseUrl, true)
        if (!targets.length) return
        const memberEvent: TDraftEvent = {
          kind: 9000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['h', identifier],
            ['p', pubkey]
          ],
          content: ''
        }
        try {
          await publish(memberEvent, { specifiedRelayUrls: targets })
          console.info('[GroupsProvider] Published open-join member announce', {
            groupId: identifier,
            relay: baseUrl,
            targets: targets.length
          })
          invalidateGroupMemberPreview(identifier, baseUrl, { reason: 'open-join-member-announce' })
          refreshGroupMemberPreview(identifier, baseUrl, {
            force: true,
            reason: 'open-join-member-announce'
          }).catch(() => {})
        } catch (err) {
          console.warn('[GroupsProvider] Failed open-join member announce', {
            groupId: identifier,
            relay: baseUrl,
            err: err instanceof Error ? err.message : err
          })
          announcedOpenJoinMembershipRef.delete(dedupeKey)
        }
      })()
    }

    Object.values(joinFlows || {}).forEach((flow) => {
      if (!flow || flow.phase !== 'success') return
      const identifier = flow.publicIdentifier
      if (!identifier) return
      if (processedJoinFlowsRef.has(identifier)) return

      const relayUrl = flow.relayUrl
      if (typeof relayUrl !== 'string' || !relayUrl) return
      const baseUrl = getBaseRelayUrl(relayUrl)
      if (!baseUrl) return

      announceOpenJoinMembership(flow, baseUrl)

      const already = myGroupList.some((e) => e.groupId === identifier && e.relay === baseUrl)
      if (already) {
        processedJoinFlowsRef.add(identifier)
        invalidateGroupMemberPreview(identifier, baseUrl, { reason: 'join-flow-success-existing' })
        refreshGroupMemberPreview(identifier, baseUrl, {
          force: true,
          reason: 'join-flow-success-existing'
        }).catch(() => {})
        return
      }

      processedJoinFlowsRef.add(identifier)
      const updated = [...myGroupList, { groupId: identifier, relay: baseUrl }]
      saveMyGroupList(updated, { specifiedRelayUrls: BIG_RELAY_URLS }).catch(() => {})
      invalidateGroupMemberPreview(identifier, baseUrl, { reason: 'join-flow-success-added' })
      refreshGroupMemberPreview(identifier, baseUrl, {
        force: true,
        reason: 'join-flow-success-added'
      }).catch(() => {})
    })
  }, [
    announcedOpenJoinMembershipRef,
    discoveryGroups,
    fetchGroupDetail,
    invalidateGroupMemberPreview,
    joinFlows,
    myGroupList,
    processedJoinFlowsRef,
    pubkey,
    publish,
    refreshGroupMemberPreview,
    saveMyGroupList
  ])

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
      const membershipSnapshotTargets = isPublic
        ? Array.from(new Set([authenticatedRelayUrl, ...BIG_RELAY_URLS]))
        : [authenticatedRelayUrl]
      await Promise.all([
        publish(adminListEvent, { specifiedRelayUrls: membershipSnapshotTargets }),
        publish(memberListEvent, { specifiedRelayUrls: membershipSnapshotTargets })
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

      const relayUrls = discoveryRelays
      console.info('[GroupsProvider] Publishing join request', {
        groupId,
        relay,
        relayUrlsCount: relayUrls.length,
        relayUrlsPreview: relayUrls.slice(0, 4),
        hasInviteCode: !!code
      })
      await publish(draftEvent, { specifiedRelayUrls: relayUrls })
    },
    [discoveryRelays, pubkey, publish]
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
      // Publish invite envelopes to discovery relays only.
      const relayUrls = defaultDiscoveryRelays
      let meta =
        discoveryGroups.find(
          (g) => g.id === groupId && (!relay || !g.relay || g.relay === relay || g.relay === resolved)
        ) || null
      if (!meta) {
        try {
          const detail = await fetchGroupDetail(groupId, resolved || relay || undefined, {
            preferRelay: true
          })
          meta = detail?.metadata || null
        } catch (_err) {
          meta = null
        }
      }
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedIsOpen = typeof options?.isOpen === 'boolean' ? options.isOpen : meta?.isOpen
      const isOpenGroup = resolvedIsOpen === true
      const isPublicGroup = meta?.isPublic !== false
      const inviteName = options?.name ?? meta?.name
      const inviteAbout = options?.about ?? meta?.about
      const invitePicture = options?.picture ?? meta?.picture
      const baseAuthorizedMemberPubkeys = normalizePubkeyList(options?.authorizedMemberPubkeys)
      const membershipRelayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)

      const inviteRelayUrl = getBaseRelayUrl(resolved || relay || '') || resolved || relay || null
      const inviteRelayKey =
        relayEntry?.relayKey || extractRelayKeyFromUrl(inviteRelayUrl) || null
      if (!isOpenGroup && !inviteRelayKey) {
        console.warn('[GroupsProvider] Missing relayKey for closed invite payload', {
          groupId,
          relayUrl: inviteRelayUrl ? String(inviteRelayUrl).slice(0, 80) : null
        })
      }

      const provisionWriterInfo = async (invitee: string) => {
        if (isOpenGroup) return null
        if (!sendToWorker || !relayEntry?.relayKey) return null
        try {
          const res = await sendToWorker({
            type: 'provision-writer-for-invitee',
            data: {
              relayKey: relayEntry.relayKey,
              publicIdentifier: groupId,
              inviteePubkey: invitee,
              useWriterPool: true
            }
          })
          if (res && typeof res === 'object') {
            const writerInfo = {
              writerCore: (res as any).writerCore,
              writerCoreHex: (res as any).writerCoreHex,
              autobaseLocal: (res as any).autobaseLocal,
              writerSecret: (res as any).writerSecret,
              poolCoreRefs: Array.isArray((res as any).poolCoreRefs) ? (res as any).poolCoreRefs : undefined,
              fastForward: (res as any).fastForward || null
            }
            console.info('[GroupsProvider] Writer provisioning result (invite)', {
              groupId,
              invitee,
              relayKey: relayEntry.relayKey,
              hasWriterCore: !!writerInfo?.writerCore,
              hasWriterCoreHex: !!writerInfo?.writerCoreHex,
              hasAutobaseLocal: !!writerInfo?.autobaseLocal,
              hasWriterSecret: !!writerInfo?.writerSecret,
              hasPoolCoreRefs: Array.isArray(writerInfo?.poolCoreRefs) && writerInfo.poolCoreRefs.length > 0,
              hasFastForward: !!writerInfo?.fastForward
            })
            return writerInfo
          }
        } catch (err) {
          console.warn('[GroupsProvider] Failed to provision writer for invitee', err)
        }
        return null
      }

      const baseMirrorMetadata: InviteMirrorMetadata = !isOpenGroup
        ? await fetchInviteMirrorMetadata(inviteRelayKey || relayEntry?.relayKey || groupId, resolved)
        : null

      const buildInviteMirrorMetadata = (writerInfo: {
        writerCore?: string
        writerCoreHex?: string
        autobaseLocal?: string
        writerSecret?: string
        poolCoreRefs?: string[]
      } | null) => {
        if (isOpenGroup) return null
        const writerCoreKey =
          writerInfo?.writerCoreHex || writerInfo?.autobaseLocal || writerInfo?.writerCore
        const extraRefs = [
          ...(Array.isArray(writerInfo?.poolCoreRefs) ? writerInfo.poolCoreRefs : []),
          writerCoreKey
        ].filter(Boolean) as string[]

        if (!extraRefs.length) return baseMirrorMetadata

        const next: InviteMirrorMetadata = baseMirrorMetadata ? { ...baseMirrorMetadata } : {}
        const cores = Array.isArray(baseMirrorMetadata?.cores) ? [...baseMirrorMetadata.cores] : []
        extraRefs.forEach((ref) => {
          if (!cores.some((entry) => entry.key === ref)) {
            cores.push({ key: ref, role: 'autobase-writer' })
          }
        })
        next.cores = cores
        return next
      }

      await Promise.all(
        invitees.map(async (invitee) => {
          const writerInfo = await provisionWriterInfo(invitee)
          const inviteMirrorMetadata = buildInviteMirrorMetadata(writerInfo)
          const token = isOpenGroup ? null : randomString(24)
          const payload = isOpenGroup
            ? buildOpenInvitePayload({
                relayUrl: inviteRelayUrl,
                relayKey: inviteRelayKey,
                groupName: inviteName,
                groupPicture: invitePicture,
                authorizedMemberPubkeys: baseAuthorizedMemberPubkeys
              })
            : buildInvitePayload({
                token: token as string,
                relayUrl: inviteRelayUrl,
                relayKey: inviteRelayKey,
                meta,
                groupName: inviteName,
                groupPicture: invitePicture,
                authorizedMemberPubkeys: normalizePubkeyList([...baseAuthorizedMemberPubkeys, invitee]),
                mirrorMetadata: inviteMirrorMetadata,
                writerInfo,
                fastForward: writerInfo?.fastForward || null
              })
          const encryptedPayload = await nip04Encrypt(
            invitee,
            JSON.stringify(payload)
          )
          console.info('[GroupsProvider] Invite payload built', {
            groupId,
            invitee,
            openInvite: isOpenGroup,
            hasWriterCore: !!writerInfo?.writerCore,
            hasWriterCoreHex: !!writerInfo?.writerCoreHex,
            hasAutobaseLocal: !!writerInfo?.autobaseLocal,
            hasWriterSecret: !!writerInfo?.writerSecret,
            writerSecretLen: writerInfo?.writerSecret ? String(writerInfo.writerSecret).length : 0,
            hasFastForward: !!writerInfo?.fastForward,
            relayKey: inviteRelayKey ? String(inviteRelayKey).slice(0, 16) : null,
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
          if (invitePicture) inviteTags.push(['picture', invitePicture])
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
            if (membershipRelayUrls.length) {
              await publish(putUser, { specifiedRelayUrls: membershipRelayUrls })
            }
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
        })
      )

      if (!isOpenGroup) {
        await republishMemberSnapshot39002({
          groupId,
          relay: resolved || relay || undefined,
          isPublicGroup,
          reason: 'send-invites'
        })
      }
    },
    [
      discoveryGroups,
      fetchGroupDetail,
      fetchInviteMirrorMetadata,
      getRelayEntryForGroup,
      nip04Encrypt,
      pubkey,
      publish,
      republishMemberSnapshot39002,
      resolveRelayUrl,
      sendToWorker
    ]
  )

  const approveJoinRequest = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string, requestCreatedAt?: number) => {
      if (!pubkey) throw new Error('Not logged in')
      const groupKey = toGroupKey(groupId, relay)
      const resolved = relay ? resolveRelayUrl(relay) : undefined

      let detailMembers: string[] = []
      let detailName: string | undefined
      let detailPicture: string | undefined
      let detailAbout: string | undefined
      try {
        const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        detailMembers = normalizePubkeyList(detail?.members || [])
        detailName = detail?.metadata?.name
        detailPicture = detail?.metadata?.picture
        detailAbout = detail?.metadata?.about
      } catch (_err) {
        detailMembers = []
      }

      const authorizedMemberPubkeys = normalizePubkeyList([...detailMembers, targetPubkey])
      console.info('[GroupsProvider] Join request approval handoff to sendInvites', {
        groupId,
        targetPubkey,
        relay,
        resolved,
        requestCreatedAt: requestCreatedAt ?? null,
        authorizedMemberPubkeysCount: authorizedMemberPubkeys.length
      })

      await sendInvites(groupId, [targetPubkey], relay, {
        isOpen: false,
        name: detailName,
        about: detailAbout,
        picture: detailPicture,
        authorizedMemberPubkeys
      })

      const requestsForGroup = joinRequests[groupKey] || []
      const matchingRequests = requestsForGroup.filter((req) =>
        req.pubkey === targetPubkey &&
        (typeof requestCreatedAt !== 'number' || req.created_at === requestCreatedAt)
      )
      const handledKeys = matchingRequests.map((req) => toJoinRequestHandledKey(req.pubkey, req.created_at))
      if (typeof requestCreatedAt === 'number' && handledKeys.length === 0) {
        handledKeys.push(toJoinRequestHandledKey(targetPubkey, requestCreatedAt))
      }

      setHandledJoinRequests((prev) => {
        const next = { ...prev }
        const set = new Set(next[groupKey] || [])
        handledKeys.forEach((k) => set.add(k))
        next[groupKey] = set
        return next
      })
      setJoinRequests((prev) => {
        const next = { ...prev }
        next[groupKey] = (prev[groupKey] || []).filter((req) => {
          if (req.pubkey !== targetPubkey) return true
          if (typeof requestCreatedAt === 'number') return req.created_at !== requestCreatedAt
          return false
        })
        return next
      })
    },
    [fetchGroupDetail, joinRequests, pubkey, resolveRelayUrl, sendInvites]
  )

  const rejectJoinRequest = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string, requestCreatedAt?: number) => {
      const groupKey = toGroupKey(groupId, relay)
      const requestsForGroup = joinRequests[groupKey] || []
      const matchingRequests = requestsForGroup.filter((req) =>
        req.pubkey === targetPubkey &&
        (typeof requestCreatedAt !== 'number' || req.created_at === requestCreatedAt)
      )
      const handledKeys = matchingRequests.map((req) => toJoinRequestHandledKey(req.pubkey, req.created_at))
      if (typeof requestCreatedAt === 'number' && handledKeys.length === 0) {
        handledKeys.push(toJoinRequestHandledKey(targetPubkey, requestCreatedAt))
      }

      setHandledJoinRequests((prev) => {
        const next = { ...prev }
        const set = new Set(next[groupKey] || [])
        handledKeys.forEach((k) => set.add(k))
        next[groupKey] = set
        return next
      })
      setJoinRequests((prev) => {
        const next = { ...prev }
        next[groupKey] = (prev[groupKey] || []).filter((req) => {
          if (req.pubkey !== targetPubkey) return true
          if (typeof requestCreatedAt === 'number') return req.created_at !== requestCreatedAt
          return false
        })
        return next
      })
    },
    [joinRequests]
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
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      let isPublicGroup = true
      try {
        const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        isPublicGroup = detail?.metadata?.isPublic !== false
      } catch (_err) {
        isPublicGroup = true
      }
      const relayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)
      if (!relayUrls.length) {
        console.warn('[GroupsProvider] addUser skipped: no publish targets', { groupId, relay, resolved })
        return
      }
      const draftEvent: TDraftEvent = {
        kind: 9000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      await publish(draftEvent, { specifiedRelayUrls: relayUrls })
      await republishMemberSnapshot39002({
        groupId,
        relay: resolved || relay || undefined,
        isPublicGroup,
        reason: 'add-user'
      })
    },
    [fetchGroupDetail, pubkey, publish, republishMemberSnapshot39002, resolveRelayUrl]
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
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      let isPublicGroup = true
      try {
        const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        isPublicGroup = detail?.metadata?.isPublic !== false
      } catch (_err) {
        isPublicGroup = true
      }
      const relayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)
      if (!relayUrls.length) {
        console.warn('[GroupsProvider] removeUser skipped: no publish targets', { groupId, relay, resolved })
        return
      }
      const draftEvent: TDraftEvent = {
        kind: 9001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      await publish(draftEvent, { specifiedRelayUrls: relayUrls })
      await republishMemberSnapshot39002({
        groupId,
        relay: resolved || relay || undefined,
        isPublicGroup,
        reason: 'remove-user'
      })
    },
    [fetchGroupDetail, pubkey, publish, republishMemberSnapshot39002, resolveRelayUrl]
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
      dismissInvite,
      markInviteAccepted,
      loadJoinRequests,
      resolveRelayUrl,
      toggleFavorite,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      getGroupMemberPreview,
      groupMemberPreviewVersion,
      refreshGroupMemberPreview,
      invalidateGroupMemberPreview,
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
      dismissInvite,
      markInviteAccepted,
      loadJoinRequests,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      getGroupMemberPreview,
      groupMemberPreviewVersion,
      refreshGroupMemberPreview,
      invalidateGroupMemberPreview,
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
