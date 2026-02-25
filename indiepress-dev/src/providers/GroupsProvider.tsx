import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import {
  buildPrivateGroupLeaveShadowRef,
  deriveMembershipStatus,
  parseGroupAdminsEvent,
  parseGatewayInviteEvent,
  parseGatewayJoinRequestEvent,
  parseGatewayMetadataEvent,
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
  buildGatewayTags,
  buildHypertunaDiscoveryDraftEvents,
  getBaseRelayUrl,
  HYPERTUNA_IDENTIFIER_TAG,
  isHypertunaTaggedEvent,
  KIND_HYPERTUNA_RELAY,
  normalizeGatewayTags,
  parseHypertunaRelayEvent30166
} from '@/lib/hypertuna-group-events'
import { TDraftEvent } from '@/types'
import {
  TGroupAdmin,
  TGatewayDirectoryEntry,
  TGatewayDescriptor,
  TGatewayInvite,
  TGatewayJoinRequest,
  TGatewayMetadata,
  TGatewayReachabilityEntry,
  TGroupInvite,
  TGroupListEntry,
  TGroupMembershipStatus,
  TGroupMetadata,
  TJoinRequest,
  WriterLeaseEnvelope
} from '@/types/groups'
import { buildGatewayDirectory } from '@/lib/gateway-directory'
import client from '@/services/client.service'
import localStorageService, {
  ArchivedGroupFilesEntry,
  GroupLeavePublishRetryEntry
} from '@/services/local-storage.service'
import { electronIpc } from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
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
const LEAVE_PUBLISH_RETRY_BASE_DELAY_MS = 5000
const LEAVE_PUBLISH_RETRY_MAX_DELAY_MS = 60 * 60 * 1000
const GROUP_GATEWAY_SYNC_THROTTLE_MS = 1500
const GATEWAY_POLICY_CACHE_TTL_MS = 5 * 60 * 1000
const GATEWAY_POLICY_FETCH_TIMEOUT_MS = 5000
const GATEWAY_REACHABILITY_TTL_MS = 30 * 1000
const GATEWAY_REACHABILITY_TIMEOUT_MS = 3500

type GroupMemberPreviewEntry = {
  members: string[]
  updatedAt: number
  authoritative: boolean
  source:
    | 'group-relay'
    | 'fallback-discovery'
    | 'group-relay-empty'
    | 'authoritative-promotion'
    | 'unknown'
}

type ProvisionalGroupMetadataEntry = {
  metadata: TGroupMetadata
  source: 'invite' | 'create' | 'update'
  updatedAt: number
}

type GatewayPolicySnapshot = {
  origin: string
  operatorPubkey: string
  policy: 'OPEN' | 'CLOSED'
  allowList: string[]
  banList: string[]
  discoveryRelays: string[]
  updatedAt: number
}

export type LeaveGroupOptions = {
  saveRelaySnapshot?: boolean
  saveSharedFiles?: boolean
  reason?: string
}

type LeaveGroupWorkerResult = {
  relayKey?: string | null
  publicIdentifier?: string | null
  archiveRelaySnapshot?: {
    status: 'saved' | 'removed' | 'skipped' | 'error'
    archivePath?: string | null
    error?: string | null
  }
  sharedFiles?: {
    status: 'saved' | 'removed' | 'skipped' | 'error'
    recoveredCount?: number
    failedCount?: number
    deletedCount?: number
    error?: string | null
  }
}

export type LeaveGroupResult = {
  worker: LeaveGroupWorkerResult | null
  queuedRetry: boolean
  publishErrors: string[]
  recoveredCount: number
  failedCount: number
}

type TGroupsContext = {
  discoveryGroups: TGroupMetadata[]
  invites: TGroupInvite[]
  gatewayMetadata: TGatewayMetadata[]
  gatewayDirectory: TGatewayDirectoryEntry[]
  gatewayReachabilityByOrigin: Record<string, TGatewayReachabilityEntry>
  gatewayInvites: TGatewayInvite[]
  gatewayJoinRequests: TGatewayJoinRequest[]
  pendingInviteCount: number
  joinRequests: Record<string, TJoinRequest[]>
  favoriteGroups: string[]
  myGroupList: TGroupListEntry[]
  isLoadingDiscovery: boolean
  discoveryError: string | null
  invitesError: string | null
  joinRequestsError: string | null
  refreshDiscovery: () => Promise<void>
  refreshGatewayDirectory: () => Promise<void>
  refreshGatewayReachability: (origins?: string[]) => Promise<void>
  refreshInvites: () => Promise<void>
  dismissInvite: (inviteId: string) => void
  markInviteAccepted: (inviteId: string, groupId?: string) => void
  getInviteByEventId: (eventId: string) => TGroupInvite | null
  loadJoinRequests: (groupId: string, relay?: string) => Promise<void>
  resolveRelayUrl: (relay?: string) => string | undefined
  toggleFavorite: (groupKey: string) => void
  saveMyGroupList: (entries: TGroupListEntry[], options?: TPublishOptions) => Promise<void>
  sendJoinRequest: (
    groupId: string,
    relay?: string,
    code?: string,
    reason?: string
  ) => Promise<void>
  sendLeaveRequest: (
    groupId: string,
    relay?: string,
    reason?: string,
    options?: {
      isPublicGroup?: boolean
      relayKey?: string | null
      publicIdentifier?: string | null
      publishPrivateShadow?: boolean
      shadowRelayUrls?: string[]
    }
  ) => Promise<void>
  leaveGroup: (
    groupId: string,
    relay?: string,
    options?: LeaveGroupOptions
  ) => Promise<LeaveGroupResult>
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
  getProvisionalGroupMetadata: (groupId: string, relay?: string) => TGroupMetadata | null
  getGroupMemberPreview: (
    groupId: string,
    relay?: string
  ) => {
    members: string[]
    updatedAt: number
    authoritative: boolean
    source: GroupMemberPreviewEntry['source']
  } | null
  groupMemberPreviewVersion: number
  refreshGroupMemberPreview: (
    groupId: string,
    relay?: string,
    opts?: { force?: boolean; reason?: string }
  ) => Promise<string[]>
  invalidateGroupMemberPreview: (
    groupId: string,
    relay?: string,
    opts?: { reason?: string }
  ) => void
  sendInvites: (
    groupId: string,
    invitees: string[],
    relay?: string,
    options?: SendInviteOptions
  ) => Promise<void>
  updateMetadata: (
    groupId: string,
    data: Partial<{
      name: string
      about: string
      picture: string
      isPublic: boolean
      isOpen: boolean
      gateways: TGatewayDescriptor[]
    }>,
    relay?: string
  ) => Promise<void>
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
    gateways?: TGatewayDescriptor[]
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
      gatewayMetadata: [],
      gatewayDirectory: [],
      gatewayReachabilityByOrigin: {},
      gatewayInvites: [],
      gatewayJoinRequests: [],
      pendingInviteCount: 0,
      joinRequests: {},
      favoriteGroups: [],
      myGroupList: [],
      isLoadingDiscovery: false,
      discoveryError: null,
      invitesError: null,
      joinRequestsError: null,
      refreshDiscovery: async () => {},
      refreshGatewayDirectory: async () => {},
      refreshGatewayReachability: async () => {},
      refreshInvites: async () => {},
      dismissInvite: () => {},
      markInviteAccepted: () => {},
      getInviteByEventId: () => null,
      loadJoinRequests: async () => {},
      resolveRelayUrl: (r?: string) => r,
      toggleFavorite: () => {},
      saveMyGroupList: async () => {},
      sendJoinRequest: async () => {},
      sendLeaveRequest: async () => {},
      leaveGroup: async () => ({
        worker: null,
        queuedRetry: false,
        publishErrors: [],
        recoveredCount: 0,
        failedCount: 0
      }),
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
      getProvisionalGroupMetadata: () => null,
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
const toProvisionalGroupMetadataKey = (groupId: string, relay?: string | null) =>
  `${relay ? getBaseRelayUrl(relay) : ''}|${groupId}`
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const getLeavePublishRetryDelayMs = (attempts: number) =>
  Math.min(
    LEAVE_PUBLISH_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts),
    LEAVE_PUBLISH_RETRY_MAX_DELAY_MS
  )

const createProvisionalGroupMetadata = (args: {
  groupId: string
  relay?: string | null
  name?: string | null
  about?: string | null
  picture?: string | null
  isPublic?: boolean
  isOpen?: boolean
  gateways?: TGatewayDescriptor[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  createdAt?: number
}): TGroupMetadata | null => {
  const groupId = String(args.groupId || '').trim()
  if (!groupId) return null
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const about = typeof args.about === 'string' ? args.about.trim() : ''
  const picture = typeof args.picture === 'string' ? args.picture.trim() : ''
  const discoveryTopic =
    typeof args.discoveryTopic === 'string' && /^[a-f0-9]{64}$/i.test(args.discoveryTopic.trim())
      ? args.discoveryTopic.trim().toLowerCase()
      : null
  const hostPeerKeys = normalizePubkeyList(args.hostPeerKeys || [])
  const memberPeerKeys = normalizePubkeyList(args.memberPeerKeys || [])
  const writerIssuerPubkey =
    typeof args.writerIssuerPubkey === 'string' && /^[a-f0-9]{64}$/i.test(args.writerIssuerPubkey.trim())
      ? args.writerIssuerPubkey.trim().toLowerCase()
      : null
  const hasGatewayInput = Array.isArray(args.gateways)
  const normalizedGateways = hasGatewayInput ? normalizeGatewayTags(buildGatewayTags(args.gateways)) : []
  const hasHintMetadata =
    !!discoveryTopic
    || hostPeerKeys.length > 0
    || memberPeerKeys.length > 0
    || !!writerIssuerPubkey
  const hasAnyMetadata =
    !!name ||
    !!about ||
    !!picture ||
    typeof args.isPublic === 'boolean' ||
    typeof args.isOpen === 'boolean' ||
    hasGatewayInput ||
    hasHintMetadata
  if (!hasAnyMetadata) return null
  const createdAt =
    Number.isFinite(args.createdAt) && (args.createdAt as number) > 0
      ? Math.floor(args.createdAt as number)
      : Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['d', groupId],
    ['h', groupId],
    ['i', HYPERTUNA_IDENTIFIER_TAG]
  ]
  if (name) tags.push(['name', name])
  if (about) tags.push(['about', about])
  if (picture) tags.push(['picture', picture])
  if (typeof args.isPublic === 'boolean') tags.push([args.isPublic ? 'public' : 'private'])
  if (typeof args.isOpen === 'boolean') tags.push([args.isOpen ? 'open' : 'closed'])
  if (discoveryTopic) tags.push(['swarm-topic', discoveryTopic])
  hostPeerKeys.forEach((peerKey) => tags.push(['host-peer', peerKey]))
  memberPeerKeys.forEach((peerKey) => tags.push(['member-peer', peerKey]))
  if (writerIssuerPubkey) tags.push(['writer-issuer', writerIssuerPubkey])
  tags.push(...buildGatewayTags(normalizedGateways))
  const event = {
    id: `provisional:${groupId}:${createdAt}`,
    pubkey: '',
    created_at: createdAt,
    kind: ExtendedKind.GROUP_METADATA,
    tags,
    content: '',
    sig: ''
  } as any
  return {
    id: groupId,
    relay: args.relay ? getBaseRelayUrl(args.relay) : undefined,
    name: name || groupId,
    about: about || undefined,
    picture: picture || undefined,
    isPublic: typeof args.isPublic === 'boolean' ? args.isPublic : undefined,
    isOpen: typeof args.isOpen === 'boolean' ? args.isOpen : undefined,
    tags: [],
    gateways: normalizedGateways,
    discoveryTopic,
    hostPeerKeys,
    memberPeerKeys,
    writerIssuerPubkey,
    event
  }
}

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

function normalizePubkeyList(values?: string[] | null) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
}

const normalizeGatewayOriginsFromDescriptors = (
  gateways?: Array<{ origin?: string | null } | string> | null
) =>
  Array.from(
    new Set(
      (Array.isArray(gateways) ? gateways : [])
        .map((entry) => {
          if (typeof entry === 'string') return entry
          return entry?.origin || null
        })
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )

const normalizeGatewayOrigin = (value?: string | null): string | null => {
  if (!value) return null
  try {
    const parsed = new URL(String(value).trim())
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch (_err) {
    return null
  }
}

const normalizeGatewayPubkeyHex = (value?: string | null): string | null => {
  if (!value) return null
  const normalized = String(value).trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null
  return normalized
}

const normalizeGatewayPolicy = (value?: string | null): 'OPEN' | 'CLOSED' => {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return upper === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

const isLikelyRelayUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^(wss?|https?):\/\//i.test(value.trim())

const normalizeWriterLeaseEnvelope = (value: unknown): WriterLeaseEnvelope | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const version = Number.isFinite(raw.version) ? Number(raw.version) : null
  const issuedAt = Number.isFinite(raw.issuedAt) ? Number(raw.issuedAt) : null
  const expiresAt = Number.isFinite(raw.expiresAt) ? Number(raw.expiresAt) : null

  const leaseId = typeof raw.leaseId === 'string' ? raw.leaseId.trim() : ''
  const relayKey = typeof raw.relayKey === 'string' ? raw.relayKey.trim() : ''
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : ''
  const inviteePubkey = typeof raw.inviteePubkey === 'string' ? raw.inviteePubkey.trim() : ''
  const tokenHash = typeof raw.tokenHash === 'string' ? raw.tokenHash.trim() : ''
  const writerSecret = typeof raw.writerSecret === 'string' ? raw.writerSecret.trim() : ''
  const issuerPubkey = typeof raw.issuerPubkey === 'string' ? raw.issuerPubkey.trim() : ''
  const signature = typeof raw.signature === 'string' ? raw.signature.trim() : ''

  if (
    version == null
    || !leaseId
    || !relayKey
    || !scope
    || !inviteePubkey
    || !tokenHash
    || !writerSecret
    || issuedAt == null
    || expiresAt == null
    || !issuerPubkey
    || !signature
  ) {
    return null
  }

  return {
    version,
    leaseId,
    relayKey,
    publicIdentifier:
      typeof raw.publicIdentifier === 'string' && raw.publicIdentifier.trim()
        ? raw.publicIdentifier.trim()
        : null,
    scope,
    inviteePubkey,
    tokenHash,
    writerCore:
      typeof raw.writerCore === 'string' && raw.writerCore.trim() ? raw.writerCore.trim() : null,
    writerCoreHex:
      typeof raw.writerCoreHex === 'string' && raw.writerCoreHex.trim()
        ? raw.writerCoreHex.trim()
        : null,
    autobaseLocal:
      typeof raw.autobaseLocal === 'string' && raw.autobaseLocal.trim()
        ? raw.autobaseLocal.trim()
        : null,
    writerSecret,
    issuedAt,
    expiresAt,
    issuerPubkey,
    issuerPeerKey:
      typeof raw.issuerPeerKey === 'string' && raw.issuerPeerKey.trim()
        ? raw.issuerPeerKey.trim()
        : null,
    signature
  }
}

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
  gatewayOrigins?: string[]
  meta?: TGroupMetadata | null
  groupName?: string
  groupPicture?: string
  authorizedMemberPubkeys?: string[]
  mirrorMetadata?: InviteMirrorMetadata
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
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
    writerLease?: WriterLeaseEnvelope | null
  } | null
}) => ({
  relayUrl: args.relayUrl,
  token: args.token,
  relayKey: args.relayKey ?? null,
  gatewayOrigins: normalizeGatewayOriginsFromDescriptors(args.gatewayOrigins || args.meta?.gateways),
  discoveryTopic: args.discoveryTopic || args.meta?.discoveryTopic || null,
  hostPeerKeys: normalizePubkeyList(args.hostPeerKeys || args.meta?.hostPeerKeys),
  memberPeerKeys: normalizePubkeyList(args.memberPeerKeys),
  writerIssuerPubkey:
    args.writerInfo?.writerLease?.issuerPubkey
    || args.meta?.writerIssuerPubkey
    || null,
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
  writerSecret: args.writerInfo?.writerSecret || null,
  writerLease: args.writerInfo?.writerLease || null
})

const buildOpenInvitePayload = (args: {
  relayUrl: string | null
  relayKey?: string | null
  gatewayOrigins?: string[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  groupName?: string
  groupPicture?: string
  authorizedMemberPubkeys?: string[]
}) => ({
  relayUrl: args.relayUrl,
  relayKey: args.relayKey ?? null,
  gatewayOrigins: normalizeGatewayOriginsFromDescriptors(args.gatewayOrigins),
  discoveryTopic: args.discoveryTopic || null,
  hostPeerKeys: normalizePubkeyList(args.hostPeerKeys),
  memberPeerKeys: normalizePubkeyList(args.memberPeerKeys),
  writerIssuerPubkey: args.writerIssuerPubkey || null,
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

const hasRelayAuthToken = (relayUrl?: string | null) => {
  if (!relayUrl) return false
  try {
    return new URL(relayUrl).searchParams.has('token')
  } catch (_err) {
    return /[?&]token=/.test(relayUrl)
  }
}

const buildMembershipPublishTargets = (
  resolvedRelay: string | null | undefined,
  isPublicGroup: boolean
) => {
  const targets = new Set<string>()
  if (resolvedRelay) targets.add(resolvedRelay)
  if (isPublicGroup) {
    defaultDiscoveryRelays.forEach((url) => targets.add(url))
  }
  return Array.from(targets)
}

const mergeMembershipEvents = <T extends { id?: string | null }>(primary: T[], shadow: T[]) => {
  if (!shadow.length) return primary
  const seenIds = new Set(primary.map((event) => event?.id).filter((id): id is string => !!id))
  const merged = [...primary]
  shadow.forEach((event) => {
    const eventId = event?.id || null
    if (eventId && seenIds.has(eventId)) return
    if (eventId) seenIds.add(eventId)
    merged.push(event)
  })
  return merged
}

export function GroupsProvider({ children }: { children: ReactNode }) {
  const { pubkey, publish, relayList, nip04Decrypt, nip04Encrypt, followList } = useNostr()
  const {
    relays: workerRelays,
    gatewayStatus,
    publicGatewayStatus,
    joinFlows,
    createRelay,
    sendToWorker
  } = useWorkerBridge()
  const [discoveryGroups, setDiscoveryGroups] = useState<TGroupMetadata[]>([])
  const [invites, setInvites] = useState<TGroupInvite[]>([])
  const [gatewayMetadata, setGatewayMetadata] = useState<TGatewayMetadata[]>([])
  const [gatewayPolicyByOrigin, setGatewayPolicyByOrigin] = useState<Record<string, GatewayPolicySnapshot>>({})
  const [gatewayDirectory, setGatewayDirectory] = useState<TGatewayDirectoryEntry[]>([])
  const [gatewayReachabilityByOrigin, setGatewayReachabilityByOrigin] = useState<
    Record<string, TGatewayReachabilityEntry>
  >({})
  const [gatewayInvites, setGatewayInvites] = useState<TGatewayInvite[]>([])
  const [gatewayJoinRequests, setGatewayJoinRequests] = useState<TGatewayJoinRequest[]>([])
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
  const [handledJoinRequests, setHandledJoinRequests] = useState<Record<string, Set<string>>>(
    () => {
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
    }
  )
  const [dismissedInviteIds, setDismissedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteIds, setAcceptedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteGroupIds, setAcceptedInviteGroupIds] = useState<Set<string>>(new Set())
  const [groupMemberPreviewByKey, setGroupMemberPreviewByKey] = useState<
    Record<string, GroupMemberPreviewEntry>
  >({})
  const [groupMemberPreviewVersion, setGroupMemberPreviewVersion] = useState(0)
  const [provisionalGroupMetadataByKey, setProvisionalGroupMetadataByKey] = useState<
    Record<string, ProvisionalGroupMetadataEntry>
  >({})
  const dismissedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteGroupIdsRef = useRef<Set<string>>(new Set())
  const gatewayOperatorProfilesRef = useRef<
    Record<
      string,
      {
        name?: string | null
        nip05?: string | null
        picture?: string | null
      }
    >
  >({})
  const groupMemberPreviewByKeyRef = useRef<Record<string, GroupMemberPreviewEntry>>({})
  const groupMemberPreviewInFlightRef = useRef<Map<string, Promise<string[]>>>(new Map())
  const inviteRefreshInFlightRef = useRef(false)
  const gatewayPolicyByOriginRef = useRef<Record<string, GatewayPolicySnapshot>>({})
  const gatewayPolicyRefreshInFlightRef = useRef(false)
  const gatewayReachabilityByOriginRef = useRef<Record<string, TGatewayReachabilityEntry>>({})
  const gatewayReachabilityRefreshInFlightRef = useRef(false)
  const groupGatewaySyncSenderRef = useRef(sendToWorker)
  const groupGatewaySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const groupGatewaySyncPendingRef = useRef<
    | {
        signature: string
        entries: Array<{
          groupId: string
          gatewayOrigins: string[]
          sourceEventId?: string
          updatedAt?: number
        }>
      }
    | null
  >(null)
  const groupGatewaySyncLastSignatureRef = useRef<string | null>(null)
  const groupGatewaySyncLastSentAtRef = useRef(0)

  useEffect(() => {
    gatewayPolicyByOriginRef.current = gatewayPolicyByOrigin
  }, [gatewayPolicyByOrigin])

  useEffect(() => {
    gatewayReachabilityByOriginRef.current = gatewayReachabilityByOrigin
  }, [gatewayReachabilityByOrigin])

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

  useEffect(() => {
    groupGatewaySyncSenderRef.current = sendToWorker
  }, [sendToWorker])

  useEffect(() => {
    return () => {
      if (groupGatewaySyncTimerRef.current) {
        clearTimeout(groupGatewaySyncTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isElectron()) return

    const flushGroupGatewaySync = () => {
      const pending = groupGatewaySyncPendingRef.current
      const sender = groupGatewaySyncSenderRef.current
      if (!pending || !sender) return
      groupGatewaySyncPendingRef.current = null
      groupGatewaySyncLastSignatureRef.current = pending.signature
      groupGatewaySyncLastSentAtRef.current = Date.now()
      sender({
        type: 'sync-group-gateway-origins',
        data: pending.entries
      }).catch((error) => {
        console.warn('[GroupsProvider] Failed to sync group gateway origins to worker', error)
      })
    }

    const groupGatewaySync = new Map<
      string,
      {
        groupId: string
        gatewayOrigins: string[]
        sourceEventId?: string
        updatedAt?: number
      }
    >()

    const upsertGroup = (group: { id?: string; gateways?: TGatewayDescriptor[]; event?: any } | null) => {
      if (!group?.id) return
      const groupId = String(group.id || '').trim()
      if (!groupId) return
      const gatewayOrigins = normalizeGatewayOriginsFromDescriptors(group.gateways)
      if (!gatewayOrigins.length) return
      const sourceEventId =
        typeof group.event?.id === 'string' && group.event.id.trim() ? group.event.id.trim() : undefined
      const updatedAt =
        Number.isFinite(group.event?.created_at) && group.event.created_at > 0
          ? Math.trunc(group.event.created_at * 1000)
          : Number.isFinite((group as any)?.updatedAt) && (group as any).updatedAt > 0
            ? Math.trunc((group as any).updatedAt)
            : 0
      const existing = groupGatewaySync.get(groupId)
      if (!existing || (existing.updatedAt || 0) <= updatedAt) {
        groupGatewaySync.set(groupId, {
          groupId,
          gatewayOrigins,
          sourceEventId,
          updatedAt
        })
      }
    }

    discoveryGroups.forEach((group) => upsertGroup(group))
    Object.values(provisionalGroupMetadataByKey).forEach((entry) => upsertGroup(entry?.metadata || null))

    const entries = Array.from(groupGatewaySync.values())
      .map((entry) => ({
        ...entry,
        gatewayOrigins: [...entry.gatewayOrigins].sort()
      }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
    if (!entries.length) {
      groupGatewaySyncPendingRef.current = null
      if (groupGatewaySyncTimerRef.current) {
        clearTimeout(groupGatewaySyncTimerRef.current)
        groupGatewaySyncTimerRef.current = null
      }
      return
    }
    const signature = JSON.stringify(
      entries.map((entry) => [
        entry.groupId,
        entry.sourceEventId || '',
        entry.updatedAt || 0,
        entry.gatewayOrigins
      ])
    )

    if (signature === groupGatewaySyncLastSignatureRef.current) {
      return
    }

    groupGatewaySyncPendingRef.current = { signature, entries }
    if (groupGatewaySyncTimerRef.current) {
      return
    }

    const elapsedMs = Date.now() - groupGatewaySyncLastSentAtRef.current
    const delayMs = Math.max(0, GROUP_GATEWAY_SYNC_THROTTLE_MS - elapsedMs)
    if (delayMs === 0) {
      flushGroupGatewaySync()
      return
    }

    groupGatewaySyncTimerRef.current = setTimeout(() => {
      groupGatewaySyncTimerRef.current = null
      flushGroupGatewaySync()
    }, delayMs)
  }, [discoveryGroups, provisionalGroupMetadataByKey])

  const upsertProvisionalGroupMetadata = useCallback(
    (args: {
      groupId: string
      relay?: string | null
      name?: string | null
      about?: string | null
      picture?: string | null
      isPublic?: boolean
      isOpen?: boolean
      gateways?: TGatewayDescriptor[]
      discoveryTopic?: string | null
      hostPeerKeys?: string[]
      memberPeerKeys?: string[]
      writerIssuerPubkey?: string | null
      createdAt?: number
      source: ProvisionalGroupMetadataEntry['source']
    }) => {
      const groupId = String(args.groupId || '').trim()
      if (!groupId) return
      const relayCandidates = new Set<string | null>([null])
      if (args.relay) relayCandidates.add(args.relay)
      const resolvedRelay = args.relay ? resolveRelayUrl(args.relay || undefined) : undefined
      if (resolvedRelay) relayCandidates.add(resolvedRelay)
      const entryRelay = Array.from(relayCandidates).find((value) => !!value) || undefined
      const metadata = createProvisionalGroupMetadata({
        groupId,
        relay: entryRelay,
        name: args.name,
        about: args.about,
        picture: args.picture,
        isPublic: args.isPublic,
        isOpen: args.isOpen,
        gateways: args.gateways,
        discoveryTopic: args.discoveryTopic,
        hostPeerKeys: args.hostPeerKeys,
        memberPeerKeys: args.memberPeerKeys,
        writerIssuerPubkey: args.writerIssuerPubkey,
        createdAt: args.createdAt
      })
      if (!metadata) return

      const keys = new Set<string>([toProvisionalGroupMetadataKey(groupId)])
      relayCandidates.forEach((candidate) => {
        if (!candidate) return
        keys.add(toProvisionalGroupMetadataKey(groupId, candidate))
      })

      setProvisionalGroupMetadataByKey((prev) => {
        let changed = false
        const next = { ...prev }
        keys.forEach((key) => {
          const current = next[key]
          const currentTs = current?.metadata?.event?.created_at || 0
          const incomingTs = metadata?.event?.created_at || 0
          if (current && currentTs > incomingTs) return
          if (
            current &&
            currentTs === incomingTs &&
            current.metadata.name === metadata.name &&
            (current.metadata.about || '') === (metadata.about || '') &&
            (current.metadata.picture || '') === (metadata.picture || '') &&
            current.metadata.isPublic === metadata.isPublic &&
            current.metadata.isOpen === metadata.isOpen &&
            (current.metadata.discoveryTopic || '') === (metadata.discoveryTopic || '') &&
            JSON.stringify(current.metadata.hostPeerKeys || []) ===
              JSON.stringify(metadata.hostPeerKeys || []) &&
            JSON.stringify(current.metadata.memberPeerKeys || []) ===
              JSON.stringify(metadata.memberPeerKeys || []) &&
            (current.metadata.writerIssuerPubkey || '') === (metadata.writerIssuerPubkey || '') &&
            JSON.stringify(current.metadata.gateways || []) === JSON.stringify(metadata.gateways || [])
          ) {
            return
          }
          changed = true
          next[key] = {
            metadata,
            source: args.source,
            updatedAt: Date.now()
          }
        })
        return changed ? next : prev
      })
    },
    [resolveRelayUrl]
  )

  const getProvisionalGroupMetadata = useCallback(
    (groupId: string, relay?: string) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const keys = new Set<string>([toProvisionalGroupMetadataKey(normalizedGroupId)])
      if (relay) {
        keys.add(toProvisionalGroupMetadataKey(normalizedGroupId, relay))
        const resolved = resolveRelayUrl(relay)
        if (resolved) {
          keys.add(toProvisionalGroupMetadataKey(normalizedGroupId, resolved))
        }
      }
      let best: ProvisionalGroupMetadataEntry | null = null
      for (const key of keys) {
        const candidate = provisionalGroupMetadataByKey[key]
        if (!candidate) continue
        if (
          !best ||
          (candidate.metadata.event?.created_at || 0) > (best.metadata.event?.created_at || 0)
        ) {
          best = candidate
        }
      }
      return best ? best.metadata : null
    },
    [provisionalGroupMetadataByKey, resolveRelayUrl]
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

  const fetchPrivateLeaveShadowEvents = useCallback(
    async ({
      groupId,
      relayKey,
      publicIdentifier,
      relayUrls = defaultDiscoveryRelays,
      limit = 200
    }: {
      groupId: string
      relayKey?: string | null
      publicIdentifier?: string | null
      relayUrls?: string[]
      limit?: number
    }) => {
      const shadowRef = await buildPrivateGroupLeaveShadowRef({
        groupId,
        relayKey,
        publicIdentifier
      })
      if (!shadowRef) return []
      try {
        return await client.fetchEvents(relayUrls, {
          kinds: [9022],
          '#h': [shadowRef],
          limit
        })
      } catch (_error) {
        return []
      }
    },
    []
  )

  const fetchInviteMirrorMetadata = useCallback(
    async (relayIdentifier: string, resolved?: string | null): Promise<InviteMirrorMetadata> => {
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
          const resp = await fetch(
            `${origin}/api/relays/${encodeURIComponent(relayIdentifier)}/mirror`
          )
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
          const blindPeer =
            data?.blindPeer && typeof data.blindPeer === 'object'
              ? {
                  publicKey: data.blindPeer.publicKey ?? null,
                  encryptionKey: data.blindPeer.encryptionKey ?? null,
                  replicationTopic: data.blindPeer.replicationTopic ?? null,
                  maxBytes:
                    typeof data.blindPeer.maxBytes === 'number' ? data.blindPeer.maxBytes : null
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
    },
    []
  )

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
    setProvisionalGroupMetadataByKey({})
    setGatewayPolicyByOrigin({})
    setGatewayReachabilityByOrigin({})
  }, [pubkey])

  useEffect(() => {
    // Clear per-account volatile state on account switch
    setJoinRequests({})
    setGatewayInvites([])
    setGatewayJoinRequests([])
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
      const [metadataEvents, relayEvents, gatewayMetadataEvents] = await Promise.all([
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
        }),
        client.fetchEvents(discoveryRelays, {
          kinds: [30078],
          '#h': ['hypertuna_gateway:metadata'],
          limit: 400
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

      const gatewayByOrigin = new Map<string, TGatewayMetadata>()
      gatewayMetadataEvents
        .map((evt) => parseGatewayMetadataEvent(evt))
        .filter((entry): entry is TGatewayMetadata => !!entry)
        .forEach((entry) => {
          const current = gatewayByOrigin.get(entry.origin)
          const currentTs = current?.event?.created_at || 0
          const nextTs = entry?.event?.created_at || 0
          if (!current || nextTs >= currentTs) {
            gatewayByOrigin.set(entry.origin, entry)
          }
        })
      setGatewayMetadata(
        Array.from(gatewayByOrigin.values()).sort(
          (left, right) => (right.event?.created_at || 0) - (left.event?.created_at || 0)
        )
      )
    } catch (error) {
      console.warn('Failed to refresh discovery groups', error)
      setDiscoveryError((error as Error).message)
    } finally {
      setIsLoadingDiscovery(false)
    }
  }, [discoveryRelays])

  const collectGatewayCandidateOrigins = useCallback(() => {
    const origins = new Set<string>()
    origins.add(DEFAULT_PUBLIC_GATEWAY_BASE)
    gatewayMetadata.forEach((entry) => {
      const normalized = normalizeGatewayOrigin(entry?.origin || null)
      if (normalized) origins.add(normalized)
    })
    discoveryGroups.forEach((group) => {
      ;(Array.isArray(group?.gateways) ? group.gateways : []).forEach((gateway) => {
        const normalized = normalizeGatewayOrigin(gateway?.origin || null)
        if (normalized) origins.add(normalized)
      })
    })
    const discoveredGateways = Array.isArray(publicGatewayStatus?.discoveredGateways)
      ? publicGatewayStatus.discoveredGateways
      : []
    discoveredGateways.forEach((entry) => {
      const normalized = normalizeGatewayOrigin(entry?.publicUrl || null)
      if (normalized) origins.add(normalized)
    })
    const selectedOrResolved = [
      publicGatewayStatus?.baseUrl,
      publicGatewayStatus?.preferredBaseUrl
    ]
    selectedOrResolved.forEach((candidate) => {
      const normalized = normalizeGatewayOrigin(candidate || null)
      if (normalized) origins.add(normalized)
    })
    Object.keys(gatewayPolicyByOriginRef.current).forEach((origin) => {
      const normalized = normalizeGatewayOrigin(origin)
      if (normalized) origins.add(normalized)
    })
    return Array.from(origins)
  }, [discoveryGroups, gatewayMetadata, publicGatewayStatus])

  const refreshGatewayPolicyDirectorySources = useCallback(async () => {
    if (typeof window === 'undefined') return
    if (gatewayPolicyRefreshInFlightRef.current) return
    gatewayPolicyRefreshInFlightRef.current = true
    try {
      const origins = collectGatewayCandidateOrigins()
      if (!origins.length) return

      const now = Date.now()
      const existingFromMetadata = new Set(
        gatewayMetadata
          .map((entry) => normalizeGatewayOrigin(entry?.origin || null))
          .filter((entry): entry is string => !!entry)
      )
      const cached = gatewayPolicyByOriginRef.current

      const targets = origins.filter((origin) => {
        const snapshot = cached[origin]
        if (snapshot && now - snapshot.updatedAt < GATEWAY_POLICY_CACHE_TTL_MS) {
          return false
        }
        if (existingFromMetadata.has(origin) && snapshot && now - snapshot.updatedAt < GATEWAY_POLICY_CACHE_TTL_MS) {
          return false
        }
        return true
      })
      if (!targets.length) return

      const fetched = await Promise.allSettled(
        targets.slice(0, 40).map(async (origin) => {
          const controller = new AbortController()
          const timeoutId = window.setTimeout(() => controller.abort(), GATEWAY_POLICY_FETCH_TIMEOUT_MS)
          try {
            const response = await fetch(`${origin}/api/gateway/policy`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              cache: 'no-store',
              signal: controller.signal
            })
            if (!response.ok) return null
            const payload = await response.json().catch(() => null)
            const operatorPubkey = normalizeGatewayPubkeyHex(payload?.operatorPubkey || null)
            if (!operatorPubkey) return null
            const allowList = Array.from(
              new Set(
                (Array.isArray(payload?.allowList) ? payload.allowList : [])
                  .map((value: unknown) => normalizeGatewayPubkeyHex(String(value || '')))
                  .filter((value: string | null): value is string => !!value)
              )
            )
            const banList = Array.from(
              new Set(
                (Array.isArray(payload?.banList) ? payload.banList : [])
                  .map((value: unknown) => normalizeGatewayPubkeyHex(String(value || '')))
                  .filter((value: string | null): value is string => !!value)
              )
            )
            const discoveryRelays = Array.from(
              new Set(
                (Array.isArray(payload?.discoveryRelays) ? payload.discoveryRelays : [])
                  .map((value: unknown) => String(value || '').trim())
                  .filter(Boolean)
              )
            )
            return {
              origin,
              operatorPubkey,
              policy: normalizeGatewayPolicy(payload?.policy),
              allowList,
              banList,
              discoveryRelays,
              updatedAt: Date.now()
            } as GatewayPolicySnapshot
          } catch (_error) {
            return null
          } finally {
            window.clearTimeout(timeoutId)
          }
        })
      )

      const valid = fetched
        .map((entry) => (entry.status === 'fulfilled' ? entry.value : null))
        .filter((entry): entry is GatewayPolicySnapshot => !!entry)
      if (!valid.length) return

      setGatewayPolicyByOrigin((prev) => {
        const next = { ...prev }
        valid.forEach((entry) => {
          next[entry.origin] = entry
        })
        return next
      })
    } finally {
      gatewayPolicyRefreshInFlightRef.current = false
    }
  }, [collectGatewayCandidateOrigins, gatewayMetadata])

  const refreshGatewayDirectory = useCallback(async () => {
    const operatorPubkeys = new Set<string>()
    gatewayMetadata.forEach((entry) => {
      const normalized = String(entry?.operatorPubkey || '').trim().toLowerCase()
      if (/^[a-f0-9]{64}$/i.test(normalized)) operatorPubkeys.add(normalized)
    })
    discoveryGroups.forEach((group) => {
      ;(Array.isArray(group?.gateways) ? group.gateways : []).forEach((gateway) => {
        const normalized = String(gateway?.operatorPubkey || '').trim().toLowerCase()
        if (/^[a-f0-9]{64}$/i.test(normalized)) operatorPubkeys.add(normalized)
      })
    })
    Object.values(gatewayPolicyByOrigin).forEach((entry) => {
      const normalized = normalizeGatewayPubkeyHex(entry?.operatorPubkey || null)
      if (normalized) operatorPubkeys.add(normalized)
    })

    const nextProfiles = { ...gatewayOperatorProfilesRef.current }
    const missing = Array.from(operatorPubkeys).filter((pubkeyValue) => !nextProfiles[pubkeyValue])
    if (missing.length) {
      await Promise.allSettled(
        missing.slice(0, 160).map(async (operatorPubkey) => {
          try {
            const profile = await client.fetchProfile(operatorPubkey)
            const metadata = profile?.metadata || {}
            nextProfiles[operatorPubkey] = {
              name:
                typeof metadata.display_name === 'string' && metadata.display_name.trim()
                  ? metadata.display_name.trim()
                  : typeof metadata.name === 'string' && metadata.name.trim()
                    ? metadata.name.trim()
                    : null,
              nip05:
                typeof metadata.nip05 === 'string' && metadata.nip05.trim()
                  ? metadata.nip05.trim()
                  : null,
              picture:
                typeof metadata.picture === 'string' && metadata.picture.trim()
                  ? metadata.picture.trim()
                  : null
            }
          } catch (_err) {
            nextProfiles[operatorPubkey] = {
              name: null,
              nip05: null,
              picture: null
            }
          }
        })
      )
      gatewayOperatorProfilesRef.current = nextProfiles
    }

    const followedPubkeys = (Array.isArray(followList) ? followList : [])
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean)

    const fromDiscovery = buildGatewayDirectory({
      discoveryGroups,
      gatewayMetadata,
      currentPubkey: pubkey || undefined,
      followedPubkeys,
      operatorProfiles: gatewayOperatorProfilesRef.current
    })

    const popularityByOrigin = new Map<string, number>()
    discoveryGroups.forEach((group) => {
      ;(Array.isArray(group?.gateways) ? group.gateways : []).forEach((gateway) => {
        const normalizedOrigin = normalizeGatewayOrigin(gateway?.origin || null)
        if (!normalizedOrigin) return
        popularityByOrigin.set(normalizedOrigin, Number(popularityByOrigin.get(normalizedOrigin) || 0) + 1)
      })
    })

    const normalizedCurrentPubkey = normalizeGatewayPubkeyHex(pubkey || null)
    const followedSet = new Set(
      followedPubkeys
        .map((entry) => normalizeGatewayPubkeyHex(entry))
        .filter((entry): entry is string => !!entry)
    )
    const directoryByOrigin = new Map<string, TGatewayDirectoryEntry>()
    fromDiscovery.forEach((entry) => directoryByOrigin.set(entry.origin, entry))

    if (normalizedCurrentPubkey) {
      Array.from(directoryByOrigin.keys()).forEach((origin) => {
        const policySnapshot = gatewayPolicyByOrigin[origin]
        if (!policySnapshot) return
        const banList = new Set(
          (Array.isArray(policySnapshot.banList) ? policySnapshot.banList : [])
            .map((value) => normalizeGatewayPubkeyHex(value))
            .filter((value): value is string => !!value)
        )
        if (banList.has(normalizedCurrentPubkey)) {
          directoryByOrigin.delete(origin)
          return
        }
        const policy = normalizeGatewayPolicy(policySnapshot.policy)
        if (policy !== 'CLOSED') return
        const allowList = new Set(
          (Array.isArray(policySnapshot.allowList) ? policySnapshot.allowList : [])
            .map((value) => normalizeGatewayPubkeyHex(value))
            .filter((value): value is string => !!value)
        )
        if (!allowList.has(normalizedCurrentPubkey)) {
          directoryByOrigin.delete(origin)
        }
      })
    }

    Object.values(gatewayPolicyByOrigin).forEach((entry) => {
      const origin = normalizeGatewayOrigin(entry?.origin || null)
      if (!origin || directoryByOrigin.has(origin)) return
      const operatorPubkey = normalizeGatewayPubkeyHex(entry?.operatorPubkey || null)
      if (!operatorPubkey) return
      const policy = normalizeGatewayPolicy(entry?.policy)
      const banList = new Set(
        (Array.isArray(entry?.banList) ? entry.banList : [])
          .map((value) => normalizeGatewayPubkeyHex(value))
          .filter((value): value is string => !!value)
      )
      if (normalizedCurrentPubkey && banList.has(normalizedCurrentPubkey)) return
      const allowList = new Set(
        (Array.isArray(entry?.allowList) ? entry.allowList : [])
          .map((value) => normalizeGatewayPubkeyHex(value))
          .filter((value): value is string => !!value)
      )
      const allowListed = policy === 'OPEN'
        ? true
        : !!normalizedCurrentPubkey && allowList.has(normalizedCurrentPubkey)
      if (policy === 'CLOSED' && !allowListed) return
      const profile = gatewayOperatorProfilesRef.current[operatorPubkey]
      directoryByOrigin.set(origin, {
        origin,
        operatorPubkey,
        policy,
        allowListed,
        popularityCount: Number(popularityByOrigin.get(origin) || 0),
        followedOperator: followedSet.has(operatorPubkey),
        operatorName: profile?.name || null,
        operatorNip05: profile?.nip05 || null,
        operatorPicture: profile?.picture || null
      })
    })

    const merged = Array.from(directoryByOrigin.values()).sort((left, right) => {
      if (left.followedOperator !== right.followedOperator) {
        return left.followedOperator ? -1 : 1
      }
      if (left.popularityCount !== right.popularityCount) {
        return right.popularityCount - left.popularityCount
      }
      if (left.policy !== right.policy) {
        return left.policy === 'OPEN' ? -1 : 1
      }
      return left.origin.localeCompare(right.origin)
    })

    setGatewayDirectory(merged)
  }, [discoveryGroups, followList, gatewayMetadata, gatewayPolicyByOrigin, pubkey])

  const refreshGatewayReachability = useCallback(async (origins?: string[]) => {
    if (typeof window === 'undefined') return
    if (gatewayReachabilityRefreshInFlightRef.current) return
    gatewayReachabilityRefreshInFlightRef.current = true
    try {
      const candidates = new Set<string>()
      ;(Array.isArray(origins) ? origins : []).forEach((entry) => {
        const normalized = normalizeGatewayOrigin(entry)
        if (normalized) candidates.add(normalized)
      })
      gatewayDirectory.forEach((entry) => {
        const normalized = normalizeGatewayOrigin(entry?.origin || null)
        if (normalized) candidates.add(normalized)
      })
      collectGatewayCandidateOrigins().forEach((origin) => candidates.add(origin))

      const allOrigins = Array.from(candidates)
      if (!allOrigins.length) return

      const now = Date.now()
      const current = gatewayReachabilityByOriginRef.current
      const toProbe = allOrigins.filter((origin) => {
        const existing = current[origin]
        if (!existing?.checkedAt) return true
        return now - existing.checkedAt > GATEWAY_REACHABILITY_TTL_MS
      })
      if (!toProbe.length) return

      setGatewayReachabilityByOrigin((prev) => {
        const next = { ...prev }
        toProbe.forEach((origin) => {
          next[origin] = {
            ...(next[origin] || {}),
            status: 'checking'
          }
        })
        return next
      })

      const probe = async (origin: string): Promise<[string, TGatewayReachabilityEntry]> => {
        const withTimeout = async (requestInit?: RequestInit) => {
          const controller = new AbortController()
          const timeoutId = window.setTimeout(() => controller.abort(), GATEWAY_REACHABILITY_TIMEOUT_MS)
          try {
            return await fetch(`${origin}/health`, {
              method: 'GET',
              cache: 'no-store',
              signal: controller.signal,
              ...requestInit
            })
          } finally {
            window.clearTimeout(timeoutId)
          }
        }

        const startedAt = Date.now()
        try {
          const response = await withTimeout()
          const latencyMs = Date.now() - startedAt
          return [
            origin,
            {
              status: 'online',
              checkedAt: Date.now(),
              latencyMs,
              error: response.ok ? null : `http-${response.status}`
            }
          ]
        } catch (firstError) {
          try {
            await withTimeout({ mode: 'no-cors' })
            return [
              origin,
              {
                status: 'online',
                checkedAt: Date.now(),
                latencyMs: Date.now() - startedAt,
                error: 'opaque-response'
              }
            ]
          } catch (secondError) {
            const errorMessage = String(
              (secondError as Error)?.message || (firstError as Error)?.message || 'request-failed'
            )
            return [
              origin,
              {
                status: 'offline',
                checkedAt: Date.now(),
                latencyMs: null,
                error: errorMessage
              }
            ]
          }
        }
      }

      const results = await Promise.allSettled(toProbe.map((origin) => probe(origin)))
      setGatewayReachabilityByOrigin((prev) => {
        const next = { ...prev }
        results.forEach((result) => {
          if (result.status !== 'fulfilled') return
          const [origin, entry] = result.value
          next[origin] = entry
        })
        return next
      })
    } finally {
      gatewayReachabilityRefreshInFlightRef.current = false
    }
  }, [collectGatewayCandidateOrigins, gatewayDirectory])

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
    setGatewayInvites((prev) => prev.filter((invite) => invite.event?.id !== normalizedInviteId))
  }, [])

  const markInviteAccepted = useCallback(
    (inviteId: string, groupId?: string) => {
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
      setInvites((prev) => {
        const matchedInvite = prev.find((invite) => {
          if (normalizedInviteId && invite.event?.id === normalizedInviteId) return true
          if (normalizedGroupId && invite.groupId === normalizedGroupId) return true
          return false
        })
        if (matchedInvite) {
          upsertProvisionalGroupMetadata({
            groupId: matchedInvite.groupId,
            relay: matchedInvite.relayUrl || matchedInvite.relay,
            name: matchedInvite.groupName || matchedInvite.name,
            about: matchedInvite.about,
            picture: matchedInvite.groupPicture,
            isPublic: matchedInvite.isPublic,
            isOpen: matchedInvite.fileSharing,
            discoveryTopic: matchedInvite.discoveryTopic || null,
            hostPeerKeys: matchedInvite.hostPeerKeys,
            memberPeerKeys: matchedInvite.memberPeerKeys,
            writerIssuerPubkey: matchedInvite.writerIssuerPubkey || null,
            createdAt: matchedInvite.event?.created_at,
            source: 'invite'
          })
        }
        return prev.filter((invite) => {
          if (normalizedInviteId && invite.event?.id === normalizedInviteId) return false
          if (normalizedGroupId && invite.groupId === normalizedGroupId) return false
          return true
        })
      })
      if (normalizedInviteId) {
        setGatewayInvites((prev) => prev.filter((invite) => invite.event?.id !== normalizedInviteId))
      }
    },
    [upsertProvisionalGroupMetadata]
  )

  const getInviteByEventId = useCallback(
    (eventId: string) => {
      const normalizedEventId = String(eventId || '').trim()
      if (!normalizedEventId) return null
      return invites.find((invite) => invite.event?.id === normalizedEventId) || null
    },
    [invites]
  )

  const pendingInviteCount = invites.length + gatewayInvites.length

  const refreshInvites = useCallback(async () => {
    if (!pubkey) {
      setInvites([])
      setGatewayInvites([])
      setGatewayJoinRequests([])
      return
    }
    setInvitesError(null)
    try {
      const [events, gatewayInviteEvents, gatewayJoinRequestEvents] = await Promise.all([
        client.fetchEvents(discoveryRelays, {
          kinds: [9009],
          '#p': [pubkey],
          limit: 200
        }),
        client.fetchEvents(discoveryRelays, {
          kinds: [30078],
          '#h': ['hypertuna_gateway:invite'],
          '#p': [pubkey],
          limit: 200
        }),
        client.fetchEvents(discoveryRelays, {
          kinds: [30078],
          '#h': ['hypertuna_gateway:join_request'],
          '#p': [pubkey],
          limit: 200
        })
      ])
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
            let isPublic: boolean | undefined = invite.isPublic
            let blindPeer: TGroupInvite['blindPeer'] | null | undefined
            let cores: TGroupInvite['cores'] | undefined
            let writerCore: string | null | undefined
            let writerCoreHex: string | null | undefined
            let autobaseLocal: string | null | undefined
            let writerSecret: string | null | undefined
            let gatewayOrigins: string[] | undefined
            let discoveryTopic: string | null | undefined
            let hostPeerKeys: string[] | undefined
            let memberPeerKeys: string[] | undefined
            let writerIssuerPubkey: string | null | undefined
            let writerLease: WriterLeaseEnvelope | null | undefined
            let fastForward:
              | {
                  key?: string | null
                  length?: number | null
                  signedLength?: number | null
                  timeoutMs?: number | null
                }
              | null
              | undefined
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
                if (typeof payload.isPublic === 'boolean') {
                  isPublic = payload.isPublic
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
                if (Array.isArray((payload as any).gatewayOrigins)) {
                  gatewayOrigins = normalizeGatewayOriginsFromDescriptors(
                    (payload as any).gatewayOrigins
                  )
                }
                if (typeof (payload as any).discoveryTopic === 'string') {
                  const topic = String((payload as any).discoveryTopic).trim().toLowerCase()
                  if (/^[a-f0-9]{64}$/i.test(topic)) {
                    discoveryTopic = topic
                  }
                }
                if (Array.isArray((payload as any).hostPeerKeys)) {
                  hostPeerKeys = normalizePubkeyList((payload as any).hostPeerKeys as string[])
                }
                if (Array.isArray((payload as any).memberPeerKeys)) {
                  memberPeerKeys = normalizePubkeyList((payload as any).memberPeerKeys as string[])
                }
                if (typeof (payload as any).writerIssuerPubkey === 'string') {
                  const issuer = String((payload as any).writerIssuerPubkey).trim().toLowerCase()
                  if (/^[a-f0-9]{64}$/i.test(issuer)) {
                    writerIssuerPubkey = issuer
                  }
                }
                if ((payload as any).writerLease && typeof (payload as any).writerLease === 'object') {
                  writerLease = normalizeWriterLeaseEnvelope((payload as any).writerLease)
                }
                const fastForwardPayload =
                  payload.fastForward && typeof payload.fastForward === 'object'
                    ? payload.fastForward
                    : payload.fast_forward && typeof payload.fast_forward === 'object'
                      ? payload.fast_forward
                      : null
                if (fastForwardPayload) {
                  fastForward = {
                    key: typeof fastForwardPayload.key === 'string' ? fastForwardPayload.key : null,
                    length:
                      typeof fastForwardPayload.length === 'number'
                        ? fastForwardPayload.length
                        : null,
                    signedLength:
                      typeof fastForwardPayload.signedLength === 'number'
                        ? fastForwardPayload.signedLength
                        : null,
                    timeoutMs:
                      typeof fastForwardPayload.timeoutMs === 'number'
                        ? fastForwardPayload.timeoutMs
                        : typeof fastForwardPayload.timeout === 'number'
                          ? fastForwardPayload.timeout
                          : null
                  }
                }
                if (payload.blindPeer && typeof payload.blindPeer === 'object') {
                  blindPeer = {
                    publicKey: payload.blindPeer.publicKey ?? payload.blindPeer.public_key ?? null,
                    encryptionKey:
                      payload.blindPeer.encryptionKey ?? payload.blindPeer.encryption_key ?? null,
                    replicationTopic:
                      payload.blindPeer.replicationTopic ??
                      payload.blindPeer.replication_topic ??
                      null,
                    maxBytes:
                      typeof payload.blindPeer.maxBytes === 'number'
                        ? payload.blindPeer.maxBytes
                        : null
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
              isPublic,
              blindPeer,
              cores,
              writerCore,
              writerCoreHex,
              autobaseLocal,
              writerSecret,
              writerLease,
              discoveryTopic,
              hostPeerKeys,
              memberPeerKeys,
              writerIssuerPubkey,
              gatewayOrigins,
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
        withAuthorizedMembers: parsed.filter(
          (p) =>
            Array.isArray((p as any).authorizedMemberPubkeys) &&
            (p as any).authorizedMemberPubkeys.length > 0
        ).length,
        withWriterSecret: parsed.filter((p) => (p as any).writerSecret).length,
        withWriterCore: parsed.filter((p) => (p as any).writerCore).length,
        withWriterCoreHex: parsed.filter((p) => (p as any).writerCoreHex).length,
        withFastForward: parsed.filter((p) => (p as any).fastForward).length
      })
      parsed.forEach((invite) => {
        upsertProvisionalGroupMetadata({
          groupId: invite.groupId,
          relay: invite.relayUrl || invite.relay,
          name: invite.groupName || invite.name,
          about: invite.about,
          picture: invite.groupPicture,
          isPublic: invite.isPublic,
          isOpen: invite.fileSharing,
          discoveryTopic: invite.discoveryTopic || null,
          hostPeerKeys: invite.hostPeerKeys,
          memberPeerKeys: invite.memberPeerKeys,
          writerIssuerPubkey: invite.writerIssuerPubkey || null,
          createdAt: invite.event?.created_at,
          source: 'invite'
        })
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

      const parsedGatewayInvites = gatewayInviteEvents
        .map((event) => parseGatewayInviteEvent(event))
        .filter((event): event is TGatewayInvite => !!event)
      const gatewayById = new Map<string, TGatewayInvite>()
      parsedGatewayInvites.forEach((invite) => {
        const id = String(invite.event?.id || '').trim()
        if (!id) return
        const existing = gatewayById.get(id)
        const existingTs = existing?.event?.created_at || 0
        const nextTs = invite?.event?.created_at || 0
        if (!existing || nextTs >= existingTs) {
          gatewayById.set(id, invite)
        }
      })
      const filteredGatewayInvites = Array.from(gatewayById.values())
        .filter((invite) => {
          const inviteId = String(invite.event?.id || '').trim()
          if (!inviteId) return false
          if (dismissedInviteIdsRef.current.has(inviteId)) return false
          if (acceptedInviteIdsRef.current.has(inviteId)) return false
          return true
        })
        .sort((left, right) => (right.event?.created_at || 0) - (left.event?.created_at || 0))
      setGatewayInvites(filteredGatewayInvites)

      const parsedGatewayJoinRequests = gatewayJoinRequestEvents
        .map((event) => parseGatewayJoinRequestEvent(event))
        .filter((event): event is TGatewayJoinRequest => !!event)
        .sort((left, right) => (right.event?.created_at || 0) - (left.event?.created_at || 0))
      setGatewayJoinRequests(parsedGatewayJoinRequests)
    } catch (error) {
      console.warn('Failed to refresh group invites', error)
      setInvitesError((error as Error).message)
    }
  }, [discoveryRelays, myGroupList, nip04Decrypt, pubkey, upsertProvisionalGroupMetadata])

  const loadJoinRequests = useCallback(
    async (groupId: string, relay?: string) => {
      if (!groupId) return
      setJoinRequestsError(null)
      const groupKey = toGroupKey(groupId, relay)
      try {
        const relayUrls = discoveryRelays
        const relayEntry = getRelayEntryForGroup(groupId)
        console.info('[GroupsProvider] Fetching join requests', {
          groupId,
          relay,
          relayUrlsCount: relayUrls.length,
          relayUrlsPreview: relayUrls.slice(0, 4)
        })

        const [joinEvents, membershipEvents, shadowLeaveEvents] = await Promise.all([
          client.fetchEvents(relayUrls, {
            kinds: [9021],
            '#h': [groupId],
            limit: 200
          }),
          client
            .fetchEvents(relayUrls, {
              kinds: [9000, 9001, 9022],
              '#h': [groupId],
              limit: 200
            })
            .catch(() => []),
          fetchPrivateLeaveShadowEvents({
            groupId,
            relayKey: relayEntry?.relayKey || null,
            publicIdentifier: relayEntry?.publicIdentifier || groupId,
            relayUrls,
            limit: 200
          }).catch(() => [])
        ])
        const effectiveMembershipEvents = mergeMembershipEvents(membershipEvents, shadowLeaveEvents)

        const currentMembers = new Set(
          resolveGroupMembersFromSnapshotAndOps({
            membershipEvents: effectiveMembershipEvents
          })
        )

        const handled = handledJoinRequests[groupKey] || new Set<string>()
        const dedupedLatestByPubkey = new Map<string, TJoinRequest>()
        joinEvents.map(parseGroupJoinRequestEvent).forEach((jr) => {
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
          membershipEventsFetched: membershipEvents.length,
          membershipShadowEventsFetched: shadowLeaveEvents.length,
          membershipEventsEffective: effectiveMembershipEvents.length,
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
    [discoveryRelays, fetchPrivateLeaveShadowEvents, getRelayEntryForGroup, handledJoinRequests]
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
      const relayEntry = getRelayEntryForGroup(groupId)
      const isInMyGroups = myGroupList.some((entry) => entry.groupId === groupId)
      const relayHasAuthToken = hasRelayAuthToken(resolved)
      const preferRelay =
        !opts?.discoveryOnly &&
        !!resolved &&
        (isInMyGroups || (!!opts?.preferRelay && relayHasAuthToken))
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
            kinds: [9000, 9001, 9022],
            '#h': [groupId],
            limit: 50
          })
        } catch (_err) {
          return []
        } finally {
          primaryMembershipDuration = performance.now() - start
        }
      })()
      const shadowLeaveEventsPromise = fetchPrivateLeaveShadowEvents({
        groupId,
        relayKey: relayEntry?.relayKey || null,
        publicIdentifier: relayEntry?.publicIdentifier || groupId,
        relayUrls: defaultDiscoveryRelays,
        limit: 50
      }).catch(() => [])

      const [membersEvt, membershipEvents, shadowLeaveEvents] = await Promise.all([
        membersPromise,
        membershipPromise,
        shadowLeaveEventsPromise
      ])

      let effectiveMembershipEvents = membershipEvents
      let membershipFetchSource: 'group-relay' | 'fallback-discovery' | 'group-relay-empty' =
        'group-relay'
      const membershipFetchTimedOutLike = primaryMembershipDuration >= 9000
      const shouldFallbackMembershipFetch =
        preferRelay && resolved && membershipEvents.length === 0 && !membersEvt

      if (shouldFallbackMembershipFetch) {
        let fallbackMembershipEvents: typeof membershipEvents = []
        try {
          fallbackMembershipEvents = await client.fetchEvents(defaultDiscoveryRelays, {
            kinds: [9000, 9001, 9022],
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
          hasRelayAuthToken: relayHasAuthToken,
          fallbackMembershipCount: fallbackMembershipEvents.length,
          source: membershipFetchSource
        })
      }
      effectiveMembershipEvents = mergeMembershipEvents(
        effectiveMembershipEvents,
        shadowLeaveEvents
      )

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
        membershipFetchSource === 'fallback-discovery' && isInMyGroups && !relayHasAuthToken
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
        hasRelayAuthToken: relayHasAuthToken,
        membershipFetchTimedOutLike,
        membershipFetchSource,
        membershipEventsFetched: membershipEvents.length,
        membershipShadowEventsFetched: shadowLeaveEvents.length,
        membershipEventsEffective: effectiveMembershipEvents.length
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
    [fetchPrivateLeaveShadowEvents, getRelayEntryForGroup, myGroupList, resolveRelayUrl]
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
      const relayEntry = getRelayEntryForGroup(groupId)
      const isInMyGroups = myGroupList.some((entry) => entry.groupId === groupId)
      const relayHasAuthToken = hasRelayAuthToken(resolved)
      const preferRelay =
        !opts?.discoveryOnly &&
        !!resolved &&
        (isInMyGroups || (!!opts?.preferRelay && relayHasAuthToken))
      const provisionalMetadata = getProvisionalGroupMetadata(
        groupId,
        targetRelay || resolved || undefined
      )
      const discoveryPrivate = discoveryGroups.some((entry) => {
        if (entry.id !== groupId) return false
        if (entry.isPublic !== false) return false
        if (!targetRelay) return true
        if (!entry.relay) return true
        return getBaseRelayUrl(entry.relay) === getBaseRelayUrl(targetRelay)
      })
      const knownPrivateGroup = provisionalMetadata?.isPublic === false || discoveryPrivate

      // Default: discovery only for list/facepile; if member/admin, stick to the resolved group relay only.
      const groupRelays = preferRelay && resolved ? [resolved] : defaultDiscoveryRelays
      const resolvedRelayList = resolved ? [resolved] : []
      const metadataRelays = opts?.discoveryOnly
        ? discoveryRelays
        : (preferRelay && resolved) || (knownPrivateGroup && resolved)
          ? [resolved]
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

      const fetchLatestByTags = async (
        relays: string[],
        kind: number,
        tagKeys: Array<'d' | 'h'>
      ) => {
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
          const evtDAndH = await fetchLatestByTags(metadataRelays, ExtendedKind.GROUP_METADATA, [
            'd',
            'h'
          ])
          const candidates = [evtDAndH]
            .filter(Boolean)
            .sort((a, b) => (b!.created_at || 0) - (a!.created_at || 0))
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
            kinds: [9000, 9001, 9022],
            '#h': [groupId],
            limit: 50
          })
          logDuration('9000/9001', start)
          return events
        } catch (_e) {
          return []
        }
      })()
      const shadowLeaveEventsPromise = fetchPrivateLeaveShadowEvents({
        groupId,
        relayKey: relayEntry?.relayKey || null,
        publicIdentifier: relayEntry?.publicIdentifier || groupId,
        relayUrls: defaultDiscoveryRelays,
        limit: 50
      }).catch(() => [])

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

      const [
        metadataEvt,
        adminsEvt,
        membersEvt,
        membershipEvents,
        joinRequests,
        shadowLeaveEvents
      ] = await Promise.all([
        metadataPromise,
        adminsPromise,
        membersPromise,
        membershipPromise,
        joinRequestsPromise,
        shadowLeaveEventsPromise
      ])

      let effectiveMembershipEvents = membershipEvents
      let membershipFetchSource: 'group-relay' | 'fallback-discovery' | 'group-relay-empty' =
        'group-relay'
      const primaryMembershipDuration = fetchDurations['9000/9001'] ?? 0
      const membershipFetchTimedOutLike = primaryMembershipDuration >= 9000
      const shouldFallbackMembershipFetch = preferRelay && resolved && membershipEvents.length === 0
      if (shouldFallbackMembershipFetch) {
        const fallbackStart = time()
        let fallbackMembershipEvents: typeof membershipEvents = []
        try {
          fallbackMembershipEvents = await client.fetchEvents(defaultDiscoveryRelays, {
            kinds: [9000, 9001, 9022],
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
      effectiveMembershipEvents = mergeMembershipEvents(
        effectiveMembershipEvents,
        shadowLeaveEvents
      )

      const membershipStatus = pubkey
        ? deriveMembershipStatus(pubkey, effectiveMembershipEvents, joinRequests)
        : 'not-member'
      const latestMembershipEvent = effectiveMembershipEvents.reduce(
        (latest, evt) => {
          if (!latest) return evt
          if (evt.created_at > latest.created_at) return evt
          if (evt.created_at < latest.created_at) return latest
          if ((evt.kind === 9001 || evt.kind === 9022) && latest.kind === 9000) return evt
          return latest
        },
        null as (typeof membershipEvents)[number] | null
      )
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
        ((!!creatorPubkey && creatorPubkey === pubkey) ||
          (!!groupIdPubkey && groupIdPubkey === pubkey))
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
        !!membersEvt || membersFromEventCount > 0 || membershipEventsCount > 0

      const metadata = metadataEvt
        ? parseGroupMetadataEvent(metadataEvt, relay)
        : provisionalMetadata
      let admins = adminsEvt ? parseGroupAdminsEvent(adminsEvt) : []

      // Persist authoritative metadata so My Groups rows can render name/about/avatar
      // even when initial row fetch happened before relay tokenization completed.
      if (metadataEvt && metadata) {
        upsertProvisionalGroupMetadata({
          groupId,
          relay: resolved || targetRelay || undefined,
          name: metadata.name,
          about: metadata.about,
          picture: metadata.picture,
          isPublic: metadata.isPublic,
          isOpen: metadata.isOpen,
          discoveryTopic: metadata.discoveryTopic || null,
          hostPeerKeys: metadata.hostPeerKeys,
          memberPeerKeys: metadata.memberPeerKeys,
          writerIssuerPubkey: metadata.writerIssuerPubkey || null,
          createdAt: metadata.event?.created_at,
          source: 'update'
        })
      }

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
            console.warn('[GroupsProvider] failed to bootstrap admin/member snapshot', {
              groupId,
              err
            })
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
        membershipEventsFetched: membershipEvents.length,
        membershipShadowEventsFetched: shadowLeaveEvents.length,
        membershipEventsEffective: effectiveMembershipEvents.length,
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
    [
      discoveryGroups,
      discoveryRelays,
      fetchPrivateLeaveShadowEvents,
      getProvisionalGroupMetadata,
      getRelayEntryForGroup,
      myGroupList,
      pubkey,
      resolveRelayUrl,
      upsertProvisionalGroupMetadata
    ]
  )

  const getGroupMemberPreview = useCallback(
    (groupId: string, relay?: string) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const relayKey = relay ? toGroupMemberPreviewKey(normalizedGroupId, relay) : null
      const fallbackKey = toGroupMemberPreviewKey(normalizedGroupId)
      const fromRelay = relayKey ? groupMemberPreviewByKey[relayKey] : null
      const fromFallback = groupMemberPreviewByKey[fallbackKey]
      return fromRelay || fromFallback || null
    },
    [groupMemberPreviewByKey]
  )

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
          const shouldDelete = key.endsWith(suffix) || (explicitKey ? key === explicitKey : false)
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
    async (groupId: string, relay?: string, opts?: { force?: boolean; reason?: string }) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return []
      const reason = opts?.reason || 'unspecified'
      const isMyGroup = myGroupList.some((entry) => entry.groupId === normalizedGroupId)
      const cacheKeys = relay
        ? [
            toGroupMemberPreviewKey(normalizedGroupId, relay),
            toGroupMemberPreviewKey(normalizedGroupId)
          ]
        : [toGroupMemberPreviewKey(normalizedGroupId)]
      const relayCacheKey = cacheKeys[0]
      const cached =
        groupMemberPreviewByKeyRef.current[relayCacheKey] ||
        groupMemberPreviewByKeyRef.current[toGroupMemberPreviewKey(normalizedGroupId)]
      const now = Date.now()
      if (!opts?.force && cached && now - cached.updatedAt < GROUP_MEMBER_PREVIEW_TTL_MS) {
        return cached.members
      }
      if (reason === 'groups-page-row-list' && !isMyGroup) {
        return cached?.members || []
      }

      const inFlightKey = `${relayCacheKey}|${opts?.force ? 'force' : 'normal'}`
      const existingPromise = groupMemberPreviewInFlightRef.current.get(inFlightKey)
      if (existingPromise) return existingPromise

      const fetchPromise = (async () => {
        try {
          const preview = await fetchMembershipPreview(normalizedGroupId, relay, {
            discoveryOnly: !isMyGroup,
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
            console.info(
              '[GroupsProvider] member preview overwrite blocked by authoritative cache',
              {
                groupId: normalizedGroupId,
                relay: relay || null,
                reason,
                blockedKeys: blockedByAuthoritative,
                incomingMembersCount: members.length,
                incomingAuthoritative: entry.authoritative,
                incomingSource: entry.source
              }
            )
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

  type TokenizedPreviewRefreshState = {
    relayUrl: string
    baseRelayUrl: string
    token: string
    lastRefreshAt: number
  }

  const tokenizedPreviewRefreshByGroupRef = useRef<Map<string, TokenizedPreviewRefreshState>>(new Map())
  const tokenizedPreviewRefreshInFlightRef = useRef<Map<string, Promise<void>>>(new Map())
  const TOKENIZED_PREVIEW_REFRESH_DEBOUNCE_MS = 15_000

  useEffect(() => {
    if (!pubkey) return
    if (!myGroupList.length) return
    if (!workerRelays.length) return

    const parseRelayTokenState = (relayUrl?: string | null) => {
      if (!relayUrl) return null
      try {
        const parsed = new URL(relayUrl)
        const token = parsed.searchParams.get('token')
        if (!token?.trim()) return null
        parsed.searchParams.delete('token')
        return {
          token: token.trim(),
          baseRelayUrl: parsed.toString()
        }
      } catch (_err) {
        const match = relayUrl.match(/[?&]token=([^&]+)/i)
        if (!match?.[1]) return null
        let tokenValue = match[1]
        try {
          tokenValue = decodeURIComponent(match[1])
        } catch {
          tokenValue = match[1]
        }
        const baseRelayUrl = relayUrl
          .replace(/([?&])token=[^&]*&?/i, '$1')
          .replace(/\?&/, '?')
          .replace(/[?&]$/, '')
        return {
          token: tokenValue.trim(),
          baseRelayUrl: baseRelayUrl || relayUrl
        }
      }
    }

    const nextByGroup = new Map<string, TokenizedPreviewRefreshState>()
    const now = Date.now()

    myGroupList.forEach((entry) => {
      const relayEntry =
        workerRelays.find((r) => r.publicIdentifier === entry.groupId) ||
        workerRelays.find((r) => r.relayKey === entry.groupId) ||
        null
      if (!relayEntry?.connectionUrl) return

      const resolvedRelay = resolveRelayUrl(relayEntry.connectionUrl) || relayEntry.connectionUrl
      const tokenState = parseRelayTokenState(resolvedRelay)
      if (!tokenState?.token) return

      const prevState = tokenizedPreviewRefreshByGroupRef.current.get(entry.groupId)
      const sameRelayUrl = prevState?.relayUrl === resolvedRelay
      const sameBaseRelay = prevState?.baseRelayUrl === tokenState.baseRelayUrl
      const tokenChanged = !!prevState && prevState.token !== tokenState.token
      const tokenOnlyChange = sameBaseRelay && tokenChanged
      const recentlyRefreshed =
        tokenOnlyChange
        && Number.isFinite(prevState?.lastRefreshAt)
        && now - Number(prevState?.lastRefreshAt) < TOKENIZED_PREVIEW_REFRESH_DEBOUNCE_MS

      const shouldRefresh =
        !prevState
        || !sameBaseRelay
        || (tokenOnlyChange && !recentlyRefreshed)

      nextByGroup.set(entry.groupId, {
        relayUrl: resolvedRelay,
        baseRelayUrl: tokenState.baseRelayUrl,
        token: tokenState.token,
        lastRefreshAt: shouldRefresh ? now : (prevState?.lastRefreshAt || now)
      })

      if (!shouldRefresh || sameRelayUrl) return
      if (tokenizedPreviewRefreshInFlightRef.current.has(entry.groupId)) return

      console.info('[GroupsProvider] tokenized relay observed; forcing member preview refresh', {
        groupId: entry.groupId,
        relay: resolvedRelay,
        baseRelay: tokenState.baseRelayUrl,
        tokenChanged
      })

      const refreshTask = Promise.resolve()
        .then(() => {
          invalidateGroupMemberPreview(entry.groupId, resolvedRelay, {
            reason: 'worker-relay-tokenized-update'
          })
          return refreshGroupMemberPreview(entry.groupId, resolvedRelay, {
            force: true,
            reason: 'worker-relay-tokenized-update'
          })
        })
        .then(() => fetchGroupDetail(entry.groupId, resolvedRelay, { preferRelay: true }))
        .then(() => undefined)
        .catch(() => {})
        .finally(() => {
          tokenizedPreviewRefreshInFlightRef.current.delete(entry.groupId)
        })

      tokenizedPreviewRefreshInFlightRef.current.set(entry.groupId, refreshTask)
    })

    tokenizedPreviewRefreshByGroupRef.current = nextByGroup
  }, [
    fetchGroupDetail,
    invalidateGroupMemberPreview,
    myGroupList,
    pubkey,
    refreshGroupMemberPreview,
    resolveRelayUrl,
    workerRelays
  ])

  const republishMemberSnapshot39002 = useCallback(
    async (params: {
      groupId: string
      relay?: string
      isPublicGroup?: boolean
      reason: string
      ensureMemberPubkey?: string
    }) => {
      const { groupId, relay, isPublicGroup, reason, ensureMemberPubkey } = params
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      let members: string[] = []
      let resolvedIsPublic = typeof isPublicGroup === 'boolean' ? isPublicGroup : true
      try {
        const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
        members = normalizePubkeyList(detail?.members || [])
        if (ensureMemberPubkey) {
          members = normalizePubkeyList([...members, ensureMemberPubkey])
        }
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
    [
      fetchGroupDetail,
      invalidateGroupMemberPreview,
      publish,
      refreshGroupMemberPreview,
      resolveRelayUrl
    ]
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

  const leaveGroupListPublishOptions = useMemo<TPublishOptions | undefined>(() => {
    const targets = Array.from(
      new Set([...(relayList?.write || []), ...(relayList?.read || []), ...BIG_RELAY_URLS])
    ).filter((relayUrl) => typeof relayUrl === 'string' && relayUrl.length > 0)
    if (!targets.length) return undefined
    return { specifiedRelayUrls: targets }
  }, [relayList?.read, relayList?.write])

  const sendLeaveRequest = useCallback(
    async (
      groupId: string,
      relay?: string,
      reason?: string,
      options?: {
        isPublicGroup?: boolean
        relayKey?: string | null
        publicIdentifier?: string | null
        publishPrivateShadow?: boolean
        shadowRelayUrls?: string[]
      }
    ) => {
      if (!pubkey) throw new Error('Not logged in')
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      const draftEvent: TDraftEvent = {
        kind: 9022,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: reason ?? ''
      }
      const provisional = getProvisionalGroupMetadata(groupId, resolved || relay || undefined)
      const discoveryMetadata =
        discoveryGroups.find((entry) => {
          if (entry.id !== groupId) return false
          if (!relay) return true
          if (!entry.relay) return true
          return getBaseRelayUrl(entry.relay) === getBaseRelayUrl(relay)
        }) || null
      const isPublicGroup =
        typeof options?.isPublicGroup === 'boolean'
          ? options.isPublicGroup
          : (provisional?.isPublic ?? discoveryMetadata?.isPublic) !== false
      const canonicalRelayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)
      if (!canonicalRelayUrls.length) {
        throw new Error('No relay targets available for leave request publish')
      }
      await publish(draftEvent, { specifiedRelayUrls: canonicalRelayUrls })

      const shouldPublishPrivateShadow = !isPublicGroup && options?.publishPrivateShadow !== false
      if (!shouldPublishPrivateShadow) return

      const shadowRef = await buildPrivateGroupLeaveShadowRef({
        groupId,
        relayKey: options?.relayKey || null,
        publicIdentifier: options?.publicIdentifier || groupId
      })
      if (!shadowRef) {
        throw new Error('Failed to derive private leave shadow reference')
      }
      const shadowLeaveEvent: TDraftEvent = {
        kind: 9022,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', shadowRef]],
        content: ''
      }
      const shadowTargets =
        Array.isArray(options?.shadowRelayUrls) && options.shadowRelayUrls.length
          ? options.shadowRelayUrls
          : defaultDiscoveryRelays
      await publish(shadowLeaveEvent, { specifiedRelayUrls: shadowTargets })
    },
    [discoveryGroups, getProvisionalGroupMetadata, pubkey, publish, resolveRelayUrl]
  )

  const enqueueLeavePublishRetry = useCallback(
    (entry: Omit<GroupLeavePublishRetryEntry, 'attempts' | 'nextAttemptAt' | 'updatedAt'>) => {
      if (!pubkey) return
      localStorageService.upsertGroupLeavePublishRetryEntry(
        {
          ...entry,
          attempts: 0,
          nextAttemptAt: Date.now() + getLeavePublishRetryDelayMs(0),
          updatedAt: Date.now()
        },
        pubkey
      )
    },
    [pubkey]
  )

  const flushLeavePublishRetryQueue = useCallback(
    async (reason: string) => {
      if (!pubkey) return
      const queue = localStorageService.getGroupLeavePublishRetryQueue(pubkey)
      if (!queue.length) return

      let workingMyGroups = [...myGroupList]
      const now = Date.now()
      const nextQueue: GroupLeavePublishRetryEntry[] = []

      for (const item of queue) {
        if (item.nextAttemptAt > now) {
          nextQueue.push(item)
          continue
        }

        let needs9022 = !!item.needs9022
        let needs10009 = !!item.needs10009
        let lastError: string | null = null

        if (needs9022) {
          try {
            await sendLeaveRequest(item.groupId, item.relay, `retry:${reason}`, {
              isPublicGroup: item.isPublicGroup,
              relayKey: item.relayKey || null,
              publicIdentifier: item.publicIdentifier || item.groupId,
              publishPrivateShadow: true
            })
            needs9022 = false
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
          }
        }

        if (needs10009) {
          try {
            workingMyGroups = workingMyGroups.filter((entry) => entry.groupId !== item.groupId)
            await saveMyGroupList(workingMyGroups, leaveGroupListPublishOptions)
            needs10009 = false
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
          }
        }

        if (needs9022 || needs10009) {
          const attempts = (item.attempts || 0) + 1
          nextQueue.push({
            ...item,
            needs9022,
            needs10009,
            attempts,
            nextAttemptAt: Date.now() + getLeavePublishRetryDelayMs(attempts),
            updatedAt: Date.now(),
            lastError
          })
        }
      }

      localStorageService.setGroupLeavePublishRetryQueue(nextQueue, pubkey)
    },
    [leaveGroupListPublishOptions, myGroupList, pubkey, saveMyGroupList, sendLeaveRequest]
  )

  useEffect(() => {
    if (!pubkey) return
    flushLeavePublishRetryQueue('provider-mount').catch(() => {})
  }, [flushLeavePublishRetryQueue, pubkey])

  useEffect(() => {
    if (!pubkey) return
    const onOnline = () => {
      flushLeavePublishRetryQueue('network-online').catch(() => {})
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flushLeavePublishRetryQueue, pubkey])

  const leaveGroup = useCallback(
    async (
      groupId: string,
      relay?: string,
      options?: LeaveGroupOptions
    ): Promise<LeaveGroupResult> => {
      if (!pubkey) throw new Error('Not logged in')

      const saveRelaySnapshot = options?.saveRelaySnapshot !== false
      const saveSharedFiles = options?.saveSharedFiles !== false
      const relayFromList = myGroupList.find((entry) => entry.groupId === groupId)?.relay
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedRelay = resolveRelayUrl(
        relay || relayFromList || relayEntry?.connectionUrl || undefined
      )
      const relayKey =
        relayEntry?.relayKey ||
        extractRelayKeyFromUrl(relay || relayFromList || relayEntry?.connectionUrl || null) ||
        null

      if (saveSharedFiles) {
        try {
          const targetRelays = resolvedRelay ? [resolvedRelay] : defaultDiscoveryRelays
          await client.fetchEvents(targetRelays, {
            kinds: [1063],
            '#h': [groupId],
            limit: 4000
          })
        } catch (_error) {
          // best effort prefetch only
        }
      }

      const provisionalMeta = getProvisionalGroupMetadata(
        groupId,
        resolvedRelay || relay || undefined
      )
      const discoveryMeta = discoveryGroups.find((entry) => {
        if (entry.id !== groupId) return false
        if (!relay) return true
        if (!entry.relay) return true
        return getBaseRelayUrl(entry.relay) === getBaseRelayUrl(relay)
      })
      let leaveDetail: Awaited<ReturnType<typeof fetchGroupDetail>> | null = null
      let isPublicGroup = (provisionalMeta?.isPublic ?? discoveryMeta?.isPublic) !== false
      try {
        leaveDetail = await fetchGroupDetail(groupId, resolvedRelay || relay || undefined, {
          preferRelay: true
        })
        isPublicGroup = leaveDetail?.metadata?.isPublic !== false
      } catch (_error) {
        leaveDetail = null
      }
      const isAdminLeaving =
        !!pubkey &&
        !!leaveDetail?.admins?.some((admin) => String(admin?.pubkey || '').trim() === pubkey)

      let needs9022 = true
      let needs10009 = true
      const publishErrors: string[] = []

      try {
        await sendLeaveRequest(groupId, resolvedRelay || relayFromList || relay, options?.reason, {
          isPublicGroup,
          relayKey,
          publicIdentifier: groupId,
          publishPrivateShadow: true
        })
        needs9022 = false
      } catch (error) {
        publishErrors.push(error instanceof Error ? error.message : String(error))
      }

      if (isAdminLeaving) {
        const snapshotRelayUrls = buildMembershipPublishTargets(
          resolvedRelay || relayFromList || relay || undefined,
          isPublicGroup
        )
        if (snapshotRelayUrls.length > 0) {
          const baseTags: string[][] = [
            ['h', groupId],
            ['d', groupId]
          ]
          if (groupId.includes(':')) {
            baseTags.push(['hypertuna', groupId], ['i', HYPERTUNA_IDENTIFIER_TAG])
          }

          const adminRoleByPubkey = new Map<string, string[]>()
          ;(leaveDetail?.admins || []).forEach((admin) => {
            const targetPubkey = String(admin?.pubkey || '').trim()
            if (!targetPubkey || targetPubkey === pubkey) return
            const roles = Array.isArray(admin?.roles)
              ? admin.roles.map((role) => String(role || '').trim()).filter(Boolean)
              : []
            adminRoleByPubkey.set(targetPubkey, roles.length ? roles : ['admin'])
          })
          const nextAdmins = normalizePubkeyList(Array.from(adminRoleByPubkey.keys()))
          const nextMembers = normalizePubkeyList(
            (leaveDetail?.members || []).filter((memberPubkey) => memberPubkey !== pubkey)
          )

          const adminsTags = [...baseTags]
          nextAdmins.forEach((adminPubkey) => {
            const roles = adminRoleByPubkey.get(adminPubkey) || ['admin']
            adminsTags.push(['p', adminPubkey, ...roles])
          })
          const membersTags = [...baseTags]
          nextMembers.forEach((memberPubkey) => {
            membersTags.push(['p', memberPubkey])
          })

          const createdAt = Math.floor(Date.now() / 1000)
          const adminsEvent: TDraftEvent = {
            kind: 39001,
            created_at: createdAt,
            tags: adminsTags,
            content: ''
          }
          const membersEvent: TDraftEvent = {
            kind: 39002,
            created_at: createdAt,
            tags: membersTags,
            content: ''
          }

          try {
            await Promise.all([
              publish(adminsEvent, { specifiedRelayUrls: snapshotRelayUrls }),
              publish(membersEvent, { specifiedRelayUrls: snapshotRelayUrls })
            ])
          } catch (error) {
            publishErrors.push(
              `admin snapshot publish failed: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        } else {
          publishErrors.push('admin snapshot publish skipped: no relay targets')
        }
      }

      let workerResult: LeaveGroupWorkerResult | null = null
      if (isElectron()) {
        const workerResponse = await electronIpc.sendToWorkerAwait({
          message: {
            type: 'leave-group',
            data: {
              relayKey,
              publicIdentifier: groupId,
              saveRelaySnapshot,
              saveSharedFiles
            }
          },
          timeoutMs: 180_000
        })
        if (!workerResponse?.success) {
          throw new Error(workerResponse?.error || 'Failed to process leave-group worker cleanup')
        }
        workerResult = (workerResponse?.data || null) as LeaveGroupWorkerResult | null
      }

      const archiveRelay = resolvedRelay || relayFromList || relay || undefined
      if (saveSharedFiles) {
        const archiveEntry: ArchivedGroupFilesEntry = {
          groupId,
          relay: archiveRelay,
          archivedAt: Date.now()
        }
        localStorageService.upsertArchivedGroupFilesEntry(archiveEntry, pubkey)
      } else {
        localStorageService.removeArchivedGroupFilesEntry(groupId, undefined, pubkey)
      }

      const nextMyGroups = myGroupList.filter((entry) => entry.groupId !== groupId)
      setMyGroupList(nextMyGroups)

      try {
        await saveMyGroupList(nextMyGroups, leaveGroupListPublishOptions)
        needs10009 = false
      } catch (error) {
        publishErrors.push(error instanceof Error ? error.message : String(error))
      }

      let queuedRetry = false
      if (needs9022 || needs10009) {
        enqueueLeavePublishRetry({
          groupId,
          relay: resolvedRelay || relayFromList || relay,
          relayKey,
          publicIdentifier: groupId,
          isPublicGroup,
          needs9022,
          needs10009,
          lastError: publishErrors.join(' | ')
        })
        queuedRetry = true
      }

      invalidateGroupMemberPreview(groupId, resolvedRelay || relayFromList || relay || undefined, {
        reason: 'leave-group'
      })
      refreshGroupMemberPreview(groupId, resolvedRelay || relayFromList || relay || undefined, {
        force: true,
        reason: 'leave-group'
      }).catch(() => {})

      flushLeavePublishRetryQueue('post-leave').catch(() => {})

      const recoveredCount = Number(workerResult?.sharedFiles?.recoveredCount || 0)
      const failedCount = Number(workerResult?.sharedFiles?.failedCount || 0)
      return {
        worker: workerResult,
        queuedRetry,
        publishErrors,
        recoveredCount,
        failedCount
      }
    },
    [
      discoveryGroups,
      enqueueLeavePublishRetry,
      fetchGroupDetail,
      flushLeavePublishRetryQueue,
      getProvisionalGroupMetadata,
      getRelayEntryForGroup,
      invalidateGroupMemberPreview,
      myGroupList,
      publish,
      pubkey,
      refreshGroupMemberPreview,
      resolveRelayUrl,
      leaveGroupListPublishOptions,
      saveMyGroupList,
      sendLeaveRequest
    ]
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
        const targets = buildMembershipPublishTargets(baseUrl, isPublicGroup)
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
            targets: targets.length,
            isPublicGroup
          })
          try {
            await republishMemberSnapshot39002({
              groupId: identifier,
              relay: baseUrl,
              isPublicGroup,
              reason: 'open-join-member-announce',
              ensureMemberPubkey: pubkey
            })
          } catch (republishErr) {
            console.warn(
              '[GroupsProvider] Failed 39002 republish after open-join member announce',
              {
                groupId: identifier,
                relay: baseUrl,
                err: republishErr instanceof Error ? republishErr.message : republishErr
              }
            )
          }
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

    const hydrateProvisionalFromRelay = (groupId: string, baseRelayUrl: string) => {
      fetchGroupDetail(groupId, baseRelayUrl, { preferRelay: true })
        .then((detail) => {
          const metadata = detail?.metadata
          if (!metadata) return
          upsertProvisionalGroupMetadata({
            groupId,
            relay: baseRelayUrl,
            name: metadata.name,
            about: metadata.about,
            picture: metadata.picture,
            isPublic: metadata.isPublic,
            isOpen: metadata.isOpen,
            discoveryTopic: metadata.discoveryTopic || null,
            hostPeerKeys: metadata.hostPeerKeys,
            memberPeerKeys: metadata.memberPeerKeys,
            writerIssuerPubkey: metadata.writerIssuerPubkey || null,
            createdAt: metadata.event?.created_at,
            source: 'update'
          })
        })
        .catch(() => {})
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
        hydrateProvisionalFromRelay(identifier, baseUrl)
        invalidateGroupMemberPreview(identifier, baseUrl, { reason: 'join-flow-success-existing' })
        refreshGroupMemberPreview(identifier, baseUrl, {
          force: true,
          reason: 'join-flow-success-existing'
        }).catch(() => {})
        return
      }

      processedJoinFlowsRef.add(identifier)
      hydrateProvisionalFromRelay(identifier, baseUrl)
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
    republishMemberSnapshot39002,
    refreshGroupMemberPreview,
    saveMyGroupList,
    upsertProvisionalGroupMetadata
  ])

  useEffect(() => {
    if (!pubkey) return
    if (!workerRelays.length) return

    const desired = new Map<string, string>()
    workerRelays.forEach((relay) => {
      if (relay.isActive === false) return
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

    if (!changed) return

    // Keep local relay URLs aligned with worker connection state without publishing a new 10009.
    setMyGroupList(next)
  }, [myGroupList, pubkey, workerRelays])

  useEffect(() => {
    if (!pubkey) return
    const archived = localStorageService.getArchivedGroupFiles(pubkey)
    if (!archived.length) return
    const joined = new Set(myGroupList.map((entry) => entry.groupId))
    const next = archived.filter((entry) => !joined.has(entry.groupId))
    if (next.length !== archived.length) {
      localStorageService.setArchivedGroupFiles(next, pubkey)
    }
  }, [myGroupList, pubkey])

  const waitForRelayBootstrapReady = useCallback(
    async ({
      groupId,
      relayKey,
      fallbackRelayUrl,
      maxAttempts = 8
    }: {
      groupId: string
      relayKey?: string | null
      fallbackRelayUrl: string
      maxAttempts?: number
    }) => {
      let bestRelayUrl = resolveRelayUrl(fallbackRelayUrl) || fallbackRelayUrl
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const relayEntry = getRelayEntryForGroup(groupId)
        const candidateRelayUrl =
          (relayEntry?.connectionUrl ? resolveRelayUrl(relayEntry.connectionUrl) : null) ||
          resolveRelayUrl(fallbackRelayUrl) ||
          fallbackRelayUrl
        if (candidateRelayUrl) {
          bestRelayUrl = candidateRelayUrl
        }

        if (sendToWorker) {
          sendToWorker({
            type: 'refresh-relay-subscriptions',
            data: {
              relayKey: relayKey || relayEntry?.relayKey || null,
              publicIdentifier: groupId,
              reason: 'create-group-bootstrap-await'
            }
          }).catch(() => {})
        }

        try {
          await client.fetchEvents([bestRelayUrl], {
            kinds: [39000, 39002],
            '#h': [groupId],
            limit: 1
          })
          return bestRelayUrl
        } catch (_err) {
          if (attempt < maxAttempts - 1) {
            await sleep(Math.min(400 * (attempt + 1), 1500))
          }
        }
      }
      return bestRelayUrl
    },
    [getRelayEntryForGroup, resolveRelayUrl, sendToWorker]
  )

  const verifyGroupRelayBootstrapState = useCallback(
    async ({
      groupId,
      relayUrl,
      maxAttempts = 6,
      delayMs = 450
    }: {
      groupId: string
      relayUrl: string
      maxAttempts?: number
      delayMs?: number
    }) => {
      const targetRelayUrl = resolveRelayUrl(relayUrl) || relayUrl
      const state = {
        metadataFound: false,
        membersFound: false,
        adminsFound: false,
        groupCreateFound: false,
        hypertunaFound: false,
        error: null as string | null
      }

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const [
            metadataByD,
            metadataByH,
            adminsByD,
            adminsByH,
            membersByD,
            membersByH,
            groupCreateByH,
            hypertunaByH
          ] = await Promise.all([
            client.fetchEvents([targetRelayUrl], { kinds: [39000], '#d': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [39000], '#h': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [39001], '#d': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [39001], '#h': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [39002], '#d': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [39002], '#h': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [9007], '#h': [groupId], limit: 1 }),
            client.fetchEvents([targetRelayUrl], { kinds: [30166], '#h': [groupId], limit: 1 })
          ])

          state.metadataFound = metadataByD.length > 0 || metadataByH.length > 0
          state.adminsFound = adminsByD.length > 0 || adminsByH.length > 0
          state.membersFound = membersByD.length > 0 || membersByH.length > 0
          state.groupCreateFound = groupCreateByH.length > 0
          state.hypertunaFound = hypertunaByH.length > 0
          state.error = null

          if (state.metadataFound && state.membersFound) {
            return {
              ok: true,
              relayUrl: targetRelayUrl,
              attempt: attempt + 1,
              ...state
            }
          }
        } catch (err) {
          state.error = err instanceof Error ? err.message : String(err)
        }

        if (attempt < maxAttempts - 1) {
          await sleep(delayMs)
        }
      }

      return {
        ok: false,
        relayUrl: targetRelayUrl,
        attempt: maxAttempts,
        ...state
      }
    },
    [resolveRelayUrl]
  )

  const publishBootstrapEventsToGroupRelay = useCallback(
    async ({
      groupId,
      relayKey,
      fallbackRelayUrl,
      events
    }: {
      groupId: string
      relayKey?: string | null
      fallbackRelayUrl: string
      events: TDraftEvent[]
    }) => {
      console.info('[GroupsProvider] create bootstrap fallback publish start', {
        groupId,
        relayKey,
        fallbackRelayUrl
      })
      let lastError: unknown = null
      let targetRelayUrl = resolveRelayUrl(fallbackRelayUrl) || fallbackRelayUrl
      for (let attempt = 0; attempt < 3; attempt += 1) {
        targetRelayUrl = await waitForRelayBootstrapReady({
          groupId,
          relayKey,
          fallbackRelayUrl: targetRelayUrl,
          maxAttempts: attempt === 0 ? 8 : 4
        })
        try {
          await Promise.all(
            events.map((draftEvent) =>
              publish(draftEvent, { specifiedRelayUrls: [targetRelayUrl] })
            )
          )
          const verify = await verifyGroupRelayBootstrapState({
            groupId,
            relayUrl: targetRelayUrl,
            maxAttempts: 4,
            delayMs: 300
          })
          if (!verify.ok) {
            lastError = new Error(
              `bootstrap verification failed (attempt=${verify.attempt}, metadata=${verify.metadataFound}, members=${verify.membersFound})`
            )
            await sleep(350 * (attempt + 1))
            continue
          }
          console.info('[GroupsProvider] create bootstrap fallback publish complete', {
            groupId,
            relayKey,
            relayUrl: targetRelayUrl,
            attempt: attempt + 1,
            metadataFound: verify.metadataFound,
            membersFound: verify.membersFound,
            adminsFound: verify.adminsFound
          })
          return targetRelayUrl
        } catch (err) {
          lastError = err
          await sleep(400 * (attempt + 1))
        }
      }
      if (lastError) throw lastError
      return targetRelayUrl
    },
    [publish, resolveRelayUrl, verifyGroupRelayBootstrapState, waitForRelayBootstrapReady]
  )

  const createHypertunaRelayGroup = useCallback(
    async ({
      name,
      about,
      isPublic,
      isOpen,
      picture,
      fileSharing,
      gateways
    }: {
      name: string
      about?: string
      isPublic: boolean
      isOpen: boolean
      picture?: string
      fileSharing?: boolean
      gateways?: TGatewayDescriptor[]
    }) => {
      if (!pubkey) throw new Error('Not logged in')
      const result = await createRelay({
        name,
        description: about || undefined,
        isPublic,
        isOpen,
        fileSharing,
        picture,
        gateways
      })
      if (!result?.success) throw new Error(result?.error || 'Failed to create relay')

      const publicIdentifier = result.publicIdentifier
      const authenticatedRelayUrl = (() => {
        const rawRelayUrl = typeof result.relayUrl === 'string' ? result.relayUrl.trim() : ''
        const authToken = typeof result.authToken === 'string' ? result.authToken.trim() : ''
        if (!rawRelayUrl || !authToken) return rawRelayUrl
        try {
          const parsed = new URL(rawRelayUrl)
          if (!parsed.searchParams.has('token')) {
            parsed.searchParams.set('token', authToken)
          }
          return parsed.toString()
        } catch (_err) {
          return rawRelayUrl
        }
      })()
      const relayKey = result.relayKey || null
      const discoveryTopic =
        typeof result.discoveryTopic === 'string' && result.discoveryTopic.trim()
          ? result.discoveryTopic.trim().toLowerCase()
          : null
      const hostPeerKeys = normalizePubkeyList(result.hostPeerKeys || [])
      const writerIssuerPubkey =
        typeof result.writerIssuerPubkey === 'string' && /^[a-f0-9]{64}$/i.test(result.writerIssuerPubkey.trim())
          ? result.writerIssuerPubkey.trim().toLowerCase()
          : (pubkey || null)
      if (!publicIdentifier || !authenticatedRelayUrl) {
        throw new Error('Worker did not return a publicIdentifier/relayUrl')
      }

      const relayWsUrl = getBaseRelayUrl(authenticatedRelayUrl)
      upsertProvisionalGroupMetadata({
        groupId: publicIdentifier,
        relay: relayWsUrl,
        name,
        about,
        picture,
        isPublic,
        isOpen,
        gateways,
        discoveryTopic,
        hostPeerKeys,
        writerIssuerPubkey,
        source: 'create'
      })

      const { groupCreateEvent, metadataEvent, hypertunaEvent } =
        buildHypertunaDiscoveryDraftEvents({
          publicIdentifier,
          name,
          about,
          isPublic,
          isOpen,
          fileSharing,
          relayWsUrl,
          pictureTagUrl: picture,
          gateways,
          discoveryTopic,
          hostPeerKeys,
          writerIssuerPubkey
        })
      const { adminListEvent, memberListEvent } = buildHypertunaAdminBootstrapDraftEvents({
        publicIdentifier,
        adminPubkeyHex: pubkey,
        name
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

      const workerBootstrap = result?.bootstrapPublish
      const workerBootstrapRelayUrl =
        [
          resolveRelayUrl(authenticatedRelayUrl),
          authenticatedRelayUrl,
          publicIdentifier ? resolveRelayUrl(publicIdentifier) : null,
          relayKey ? resolveRelayUrl(relayKey) : null,
          resolveRelayUrl(workerBootstrap?.relayWsUrl || ''),
          workerBootstrap?.relayWsUrl || null
        ].find(isLikelyRelayUrl) || authenticatedRelayUrl
      console.info('[GroupsProvider] create bootstrap worker status', {
        groupId: publicIdentifier,
        relayKey,
        status: workerBootstrap?.status || 'unknown',
        attempt: workerBootstrap?.attempt ?? null,
        publishedKinds: workerBootstrap?.publishedKinds || [],
        error: workerBootstrap?.error || null
      })

      console.info('[GroupsProvider] create bootstrap verify start', {
        groupId: publicIdentifier,
        relayKey,
        relayUrl: workerBootstrapRelayUrl
      })

      let bootstrapRelayUrl = workerBootstrapRelayUrl
      let bootstrapSource: 'worker' | 'worker-trusted' | 'renderer-fallback' = 'worker'
      const workerVerification = await verifyGroupRelayBootstrapState({
        groupId: publicIdentifier,
        relayUrl: workerBootstrapRelayUrl,
        maxAttempts: workerBootstrap?.status === 'success' ? 8 : 4,
        delayMs: 450
      })

      if (!workerVerification.ok) {
        if (workerBootstrap?.status === 'success') {
          // Worker already published bootstrap events; renderer relay access can be unavailable.
          // Trust worker success here and avoid blocking the create flow on renderer websocket reachability.
          console.warn(
            '[GroupsProvider] create bootstrap worker verification failed; trusting worker bootstrap result',
            {
              groupId: publicIdentifier,
              relayKey,
              status: workerBootstrap?.status || 'unknown',
              workerError: workerBootstrap?.error || null,
              verifyAttempt: workerVerification.attempt,
              metadataFound: workerVerification.metadataFound,
              membersFound: workerVerification.membersFound,
              verifyError: workerVerification.error
            }
          )
          bootstrapSource = 'worker-trusted'
        } else {
          console.warn(
            '[GroupsProvider] create bootstrap worker verification failed, using renderer fallback',
            {
              groupId: publicIdentifier,
              relayKey,
              status: workerBootstrap?.status || 'unknown',
              workerError: workerBootstrap?.error || null,
              verifyAttempt: workerVerification.attempt,
              metadataFound: workerVerification.metadataFound,
              membersFound: workerVerification.membersFound,
              verifyError: workerVerification.error
            }
          )
          bootstrapRelayUrl = await publishBootstrapEventsToGroupRelay({
            groupId: publicIdentifier,
            relayKey,
            fallbackRelayUrl: workerBootstrapRelayUrl,
            events: [groupCreateEvent, metadataEvent, hypertunaEvent, adminListEvent, memberListEvent]
          })
          bootstrapSource = 'renderer-fallback'
        }
      }

      console.info('[GroupsProvider] create bootstrap verify complete', {
        groupId: publicIdentifier,
        relayKey,
        relayUrl: bootstrapRelayUrl,
        source: bootstrapSource,
        metadataFound: workerVerification.metadataFound,
        membersFound: workerVerification.membersFound,
        adminsFound: workerVerification.adminsFound
      })

      // Bootstrap admin/member snapshots on the group relay.
      const membershipSnapshotTargets = !workerVerification.ok && workerBootstrap?.status === 'success'
        ? (isPublic ? Array.from(new Set(BIG_RELAY_URLS)) : [])
        : (isPublic ? Array.from(new Set([bootstrapRelayUrl, ...BIG_RELAY_URLS])) : [bootstrapRelayUrl])
      if (membershipSnapshotTargets.length > 0) {
        await Promise.all([
          publish(adminListEvent, { specifiedRelayUrls: membershipSnapshotTargets }),
          publish(memberListEvent, { specifiedRelayUrls: membershipSnapshotTargets })
        ])
      } else {
        console.info('[GroupsProvider] create bootstrap membership snapshot skipped (worker trusted)', {
          groupId: publicIdentifier,
          relayKey,
          isPublic
        })
      }

      return { groupId: publicIdentifier, relay: relayWsUrl }
    },
    [
      createRelay,
      myGroupList,
      pubkey,
      publish,
      resolveRelayUrl,
      publishBootstrapEventsToGroupRelay,
      saveMyGroupList,
      upsertProvisionalGroupMetadata,
      verifyGroupRelayBootstrapState
    ]
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

  const sendInvites = useCallback(
    async (groupId: string, invitees: string[], relay?: string, options?: SendInviteOptions) => {
      if (!pubkey) throw new Error('Not logged in')
      if (!invitees.length) return

      const resolved = relay ? resolveRelayUrl(relay) : null
      // Publish invite envelopes to discovery relays only.
      const relayUrls = defaultDiscoveryRelays
      let meta =
        discoveryGroups.find(
          (g) =>
            g.id === groupId && (!relay || !g.relay || g.relay === relay || g.relay === resolved)
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
      if (!meta) {
        meta = getProvisionalGroupMetadata(groupId, resolved || relay || undefined)
      }
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedIsOpen = typeof options?.isOpen === 'boolean' ? options.isOpen : meta?.isOpen
      const isOpenGroup = resolvedIsOpen === true
      const isPublicGroup = meta?.isPublic !== false
      const inviteName = options?.name ?? meta?.name
      const inviteAbout = options?.about ?? meta?.about
      const invitePicture = options?.picture ?? meta?.picture
      let inviteHostPeerKeys = normalizePubkeyList([
        ...(Array.isArray(meta?.hostPeerKeys) ? meta.hostPeerKeys : []),
        typeof gatewayStatus?.ownPeerPublicKey === 'string' ? gatewayStatus.ownPeerPublicKey : ''
      ])
      if (!inviteHostPeerKeys.length && sendToWorker) {
        try {
          const status = (await sendToWorker({ type: 'get-gateway-status' })) as
            | { ownPeerPublicKey?: string; data?: { ownPeerPublicKey?: string } }
            | null
          const ownPeerKey =
            typeof status?.ownPeerPublicKey === 'string'
              ? status.ownPeerPublicKey
              : typeof status?.data?.ownPeerPublicKey === 'string'
                ? status.data.ownPeerPublicKey
                : null
          if (ownPeerKey) {
            inviteHostPeerKeys = normalizePubkeyList([ownPeerKey])
          }
        } catch (_err) {
          // best effort fallback
        }
      }
      const baseAuthorizedMemberPubkeys = normalizePubkeyList(options?.authorizedMemberPubkeys)
      const membershipRelayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)

      const inviteRelayUrl = getBaseRelayUrl(resolved || relay || '') || resolved || relay || null
      const inviteRelayKey = relayEntry?.relayKey || extractRelayKeyFromUrl(inviteRelayUrl) || null
      if (!isOpenGroup && !inviteRelayKey) {
        console.warn('[GroupsProvider] Missing relayKey for closed invite payload', {
          groupId,
          relayUrl: inviteRelayUrl ? String(inviteRelayUrl).slice(0, 80) : null
        })
      }

      const provisionWriterInfo = async (invitee: string, inviteToken?: string | null) => {
        if (isOpenGroup) return null
        if (!sendToWorker || !relayEntry?.relayKey) return null
        try {
          const res = await sendToWorker({
            type: 'provision-writer-for-invitee',
            data: {
              relayKey: relayEntry.relayKey,
              publicIdentifier: groupId,
              inviteePubkey: invitee,
              inviteToken: inviteToken || null,
              useWriterPool: inviteToken ? false : true,
              discoveryTopic: meta?.discoveryTopic || null,
              hostPeerKeys: inviteHostPeerKeys,
              memberPeerKeys: normalizePubkeyList([
                ...baseAuthorizedMemberPubkeys,
                invitee
              ]),
              writerIssuerPubkey: meta?.writerIssuerPubkey || pubkey
            }
          })
          if (res && typeof res === 'object') {
            const writerInfo = {
              writerCore: (res as any).writerCore,
              writerCoreHex: (res as any).writerCoreHex,
              autobaseLocal: (res as any).autobaseLocal,
              writerSecret: (res as any).writerSecret,
              writerLease: normalizeWriterLeaseEnvelope((res as any).writerLease),
              poolCoreRefs: Array.isArray((res as any).poolCoreRefs)
                ? (res as any).poolCoreRefs
                : undefined,
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
              hasWriterLease: !!writerInfo?.writerLease,
              hasPoolCoreRefs:
                Array.isArray(writerInfo?.poolCoreRefs) && writerInfo.poolCoreRefs.length > 0,
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
        ? await fetchInviteMirrorMetadata(
            inviteRelayKey || relayEntry?.relayKey || groupId,
            resolved
          )
        : null

      const buildInviteMirrorMetadata = (
        writerInfo: {
          writerCore?: string
          writerCoreHex?: string
          autobaseLocal?: string
          writerSecret?: string
          poolCoreRefs?: string[]
        } | null
      ) => {
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
          const token = isOpenGroup ? null : randomString(24)
          const writerInfo = await provisionWriterInfo(invitee, token)
          const inviteMirrorMetadata = buildInviteMirrorMetadata(writerInfo)
          const payload = isOpenGroup
              ? buildOpenInvitePayload({
                  relayUrl: inviteRelayUrl,
                  relayKey: inviteRelayKey,
                  gatewayOrigins: normalizeGatewayOriginsFromDescriptors(meta?.gateways),
                  discoveryTopic: meta?.discoveryTopic || null,
                  hostPeerKeys: inviteHostPeerKeys,
                  memberPeerKeys: normalizePubkeyList([
                    ...baseAuthorizedMemberPubkeys,
                    invitee
                  ]),
                  writerIssuerPubkey: meta?.writerIssuerPubkey || pubkey,
                  groupName: inviteName,
                  groupPicture: invitePicture,
                  authorizedMemberPubkeys: baseAuthorizedMemberPubkeys
                })
              : buildInvitePayload({
                token: token as string,
                relayUrl: inviteRelayUrl,
                relayKey: inviteRelayKey,
                gatewayOrigins: normalizeGatewayOriginsFromDescriptors(meta?.gateways),
                discoveryTopic: meta?.discoveryTopic || null,
                hostPeerKeys: inviteHostPeerKeys,
                memberPeerKeys: normalizePubkeyList([
                  ...baseAuthorizedMemberPubkeys,
                  invitee
                ]),
                meta,
                groupName: inviteName,
                groupPicture: invitePicture,
                authorizedMemberPubkeys: normalizePubkeyList([
                  ...baseAuthorizedMemberPubkeys,
                  invitee
                ]),
                mirrorMetadata: inviteMirrorMetadata,
                writerInfo,
                fastForward: writerInfo?.fastForward || null
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
            hasFastForward: !!writerInfo?.fastForward,
            relayKey: inviteRelayKey ? String(inviteRelayKey).slice(0, 16) : null,
            relayUrl: inviteRelayUrl ? String(inviteRelayUrl).slice(0, 80) : null,
            mirrorCoresCount: Array.isArray(inviteMirrorMetadata?.cores)
              ? inviteMirrorMetadata.cores.length
              : 0,
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
      gatewayStatus,
      getProvisionalGroupMetadata,
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
      const matchingRequests = requestsForGroup.filter(
        (req) =>
          req.pubkey === targetPubkey &&
          (typeof requestCreatedAt !== 'number' || req.created_at === requestCreatedAt)
      )
      const handledKeys = matchingRequests.map((req) =>
        toJoinRequestHandledKey(req.pubkey, req.created_at)
      )
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
      const matchingRequests = requestsForGroup.filter(
        (req) =>
          req.pubkey === targetPubkey &&
          (typeof requestCreatedAt !== 'number' || req.created_at === requestCreatedAt)
      )
      const handledKeys = matchingRequests.map((req) =>
        toJoinRequestHandledKey(req.pubkey, req.created_at)
      )
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
      data: Partial<{
        name: string
        about: string
        picture: string
        isPublic: boolean
        isOpen: boolean
        gateways: TGatewayDescriptor[]
      }>,
      relay?: string
    ) => {
      if (!pubkey) throw new Error('Not logged in')
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      const baseTagValue = (value?: string) =>
        typeof value === 'string' ? value.trim() : undefined
      const cachedMetadata =
        getProvisionalGroupMetadata(groupId, resolved || relay || undefined) ||
        discoveryGroups.find((g) => {
          if (g.id !== groupId) return false
          if (!relay) return true
          if (!g.relay) return true
          return getBaseRelayUrl(g.relay) === getBaseRelayUrl(relay)
        }) ||
        null
      const existingMetadataTags = Array.isArray(cachedMetadata?.event?.tags)
        ? (cachedMetadata?.event?.tags as string[][]).filter((tag) => Array.isArray(tag) && tag[0])
        : []
      const existingGatewayTags = normalizeGatewayTags(existingMetadataTags)
      const preservedMetadataTags = existingMetadataTags.filter((tag) => {
        const key = tag[0]
        return ![
          'h',
          'd',
          'name',
          'about',
          'picture',
          'public',
          'private',
          'open',
          'closed',
          'gateway'
        ].includes(key)
      })
      const shouldUpdateGateways = Array.isArray(data.gateways)
      const nextGatewayTags = shouldUpdateGateways
        ? normalizeGatewayTags(buildGatewayTags(data.gateways))
        : existingGatewayTags

      const commandTags: string[][] = [['h', groupId]]
      const name = baseTagValue(data.name)
      const about = baseTagValue(data.about)
      const picture = baseTagValue(data.picture)

      if (name !== undefined) commandTags.push(['name', name])
      if (about !== undefined) commandTags.push(['about', about])
      if (picture) commandTags.push(['picture', picture])
      if (typeof data.isPublic === 'boolean')
        commandTags.push([data.isPublic ? 'public' : 'private'])
      if (typeof data.isOpen === 'boolean') commandTags.push([data.isOpen ? 'open' : 'closed'])
      if (shouldUpdateGateways) commandTags.push(...buildGatewayTags(nextGatewayTags))

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
      if (typeof data.isPublic === 'boolean')
        metadataTags.push([data.isPublic ? 'public' : 'private'])
      if (typeof data.isOpen === 'boolean') metadataTags.push([data.isOpen ? 'open' : 'closed'])

      const isHypertuna = groupId.includes(':')
      if (isHypertuna) {
        metadataTags.push(['hypertuna', groupId])
        metadataTags.push(['i', HYPERTUNA_IDENTIFIER_TAG])
      }

      const shouldPublishMetadataSnapshot = metadataTags.length > 2 || shouldUpdateGateways
      if (shouldPublishMetadataSnapshot) {
        metadataTags.push(...preservedMetadataTags)
        metadataTags.push(...buildGatewayTags(nextGatewayTags))
        const metadataEvent: TDraftEvent = {
          kind: ExtendedKind.GROUP_METADATA,
          created_at: Math.floor(Date.now() / 1000),
          tags: metadataTags,
          content: ''
        }
        console.info('[GroupsProvider] updateMetadata 39000', metadataEvent)
        const isPublicGroup =
          typeof data.isPublic === 'boolean' ? data.isPublic : cachedMetadata?.isPublic !== false
        const relayUrls = buildMembershipPublishTargets(resolved, isPublicGroup)
        if (!relayUrls.length) {
          throw new Error('No relay targets available to publish metadata snapshot')
        }
        await publish(metadataEvent, { specifiedRelayUrls: relayUrls })
        upsertProvisionalGroupMetadata({
          groupId,
          relay: resolved || relay || undefined,
          name,
          about,
          picture,
          isPublic: typeof data.isPublic === 'boolean' ? data.isPublic : cachedMetadata?.isPublic,
          isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : cachedMetadata?.isOpen,
          gateways: nextGatewayTags,
          discoveryTopic: cachedMetadata?.discoveryTopic || null,
          hostPeerKeys: cachedMetadata?.hostPeerKeys || [],
          memberPeerKeys: cachedMetadata?.memberPeerKeys || [],
          writerIssuerPubkey: cachedMetadata?.writerIssuerPubkey || null,
          source: 'update'
        })

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
              isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : g.isOpen,
              gateways: shouldUpdateGateways
                ? nextGatewayTags
                : (nextGatewayTags.length ? nextGatewayTags : g.gateways)
            }
          })
        )

        // Refresh discovery list to propagate to other views/cards
        refreshDiscovery().catch(() => {})
      }
    },
    [
      discoveryGroups,
      getProvisionalGroupMetadata,
      pubkey,
      publish,
      refreshDiscovery,
      resolveRelayUrl,
      upsertProvisionalGroupMetadata
    ]
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
        console.warn('[GroupsProvider] addUser skipped: no publish targets', {
          groupId,
          relay,
          resolved
        })
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
        console.warn('[GroupsProvider] removeUser skipped: no publish targets', {
          groupId,
          relay,
          resolved
        })
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
      gatewayMetadata,
      gatewayDirectory,
      gatewayReachabilityByOrigin,
      gatewayInvites,
      gatewayJoinRequests,
      pendingInviteCount,
      joinRequests,
      favoriteGroups,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      refreshDiscovery,
      refreshGatewayDirectory,
      refreshGatewayReachability,
      refreshInvites,
      dismissInvite,
      markInviteAccepted,
      getInviteByEventId,
      loadJoinRequests,
      resolveRelayUrl,
      toggleFavorite,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      leaveGroup,
      fetchGroupDetail,
      getProvisionalGroupMetadata,
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

        const metadataTargets = isPublic
          ? Array.from(new Set([...localTargets, ...discoveryTargets]))
          : localTargets
        await publish(metadataEvent, { specifiedRelayUrls: metadataTargets })

        if (isPublic) {
          await publish(adminsEvent, {
            specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets]))
          })
          await publish(membersEvent, {
            specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets]))
          })
          await publish(rolesEvent, {
            specifiedRelayUrls: Array.from(new Set([...localTargets, ...discoveryTargets]))
          })
        } else {
          // private: 39001/02/03 only to local
          await publish(adminsEvent, { specifiedRelayUrls: localTargets })
          await publish(membersEvent, { specifiedRelayUrls: localTargets })
          await publish(rolesEvent, { specifiedRelayUrls: localTargets })
        }

        setDiscoveryRelays(discoveryTargets)
        const updatedList = [...myGroupList, { groupId, relay: localTargets[0] }]
        setMyGroupList(updatedList)
        upsertProvisionalGroupMetadata({
          groupId,
          relay: localTargets[0],
          name,
          about,
          picture,
          isPublic,
          isOpen,
          createdAt,
          source: 'create'
        })
        await saveMyGroupList(updatedList)
        return { groupId, relay: localTargets[0] }
      },
      createHypertunaRelayGroup
    }),
    [
      discoveryGroups,
      favoriteGroups,
      invites,
      gatewayMetadata,
      gatewayDirectory,
      gatewayReachabilityByOrigin,
      gatewayInvites,
      gatewayJoinRequests,
      pendingInviteCount,
      joinRequests,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      refreshDiscovery,
      refreshGatewayDirectory,
      refreshGatewayReachability,
      refreshInvites,
      dismissInvite,
      markInviteAccepted,
      getInviteByEventId,
      loadJoinRequests,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      leaveGroup,
      fetchGroupDetail,
      getProvisionalGroupMetadata,
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
      createHypertunaRelayGroup,
      upsertProvisionalGroupMetadata
    ]
  )

  useEffect(() => {
    refreshDiscovery()
  }, [refreshDiscovery])

  useEffect(() => {
    void refreshGatewayPolicyDirectorySources()
  }, [refreshGatewayPolicyDirectorySources])

  useEffect(() => {
    void refreshGatewayDirectory()
  }, [refreshGatewayDirectory])

  useEffect(() => {
    void refreshGatewayReachability()
    if (typeof window === 'undefined') return
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refreshGatewayReachability()
    }, GATEWAY_REACHABILITY_TTL_MS)
    return () => window.clearInterval(intervalId)
  }, [refreshGatewayReachability])

  useEffect(() => {
    if (!pubkey) {
      setInvites([])
      setGatewayInvites([])
      setGatewayJoinRequests([])
      inviteRefreshInFlightRef.current = false
      return
    }
    if (typeof window === 'undefined') return

    let cancelled = false
    const refreshWithGuard = async () => {
      if (cancelled || inviteRefreshInFlightRef.current) return
      inviteRefreshInFlightRef.current = true
      try {
        await refreshInvites()
      } finally {
        inviteRefreshInFlightRef.current = false
      }
    }

    void refreshWithGuard()

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refreshWithGuard()
    }, 45_000)

    const onFocus = () => {
      void refreshWithGuard()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshWithGuard()
      }
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [pubkey, refreshInvites])

  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>
}
