import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import {
  buildPrivateGroupLeaveShadowRef,
  parseGroupAdminsEvent,
  parseGroupIdentifier,
  parseGroupInviteEvent,
  parseGroupJoinRequestEvent,
  parseGroupListEvent,
  parseGroupMetadataEvent,
  resolveGroupMembersFromSnapshotAndOps,
  buildGroupIdForCreation
} from '@/lib/groups'
import {
  buildGroupMembershipSourcePlan,
  choosePreferredMembershipState,
  createGroupMembershipState,
  DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE,
  hydratePersistedGroupMembershipState,
  isDiscoveryPersistedGroupMembershipRelayBase,
  isSuspiciousCreatorSelfMembershipDowngrade,
  getPersistedGroupMembershipRelayBase,
  normalizeMembershipPubkeys,
  resolveCanonicalGroupMembershipState,
  selectPreferredMembershipState,
  toGroupMembershipCacheKey,
  toPersistedGroupMembershipRecordKey,
  updatePersistedGroupMembershipRecord
} from '@/lib/group-membership'
import type { GroupMembershipLiveSourceConfig } from '@/lib/group-membership'
import {
  buildHyperpipeAdminBootstrapDraftEvents,
  buildHyperpipeDiscoveryDraftEvents,
  getBaseRelayUrl,
  HYPERPIPE_IDENTIFIER_TAG,
  HYPERPIPE_GATEWAY_ID_TAG,
  HYPERPIPE_GATEWAY_ORIGIN_TAG,
  HYPERPIPE_DIRECT_JOIN_ONLY_TAG,
  isHyperpipeTaggedEvent,
  KIND_HYPERPIPE_RELAY,
  parseHyperpipeRelayEvent30166
} from '@/lib/hyperpipe-group-events'
import { TDraftEvent } from '@/types'
import {
  TGroupAdmin,
  TGroupGatewayAccess,
  TGroupInvite,
  TGroupListEntry,
  TGroupMembershipStatus,
  TGroupMembershipState,
  TGroupMetadata,
  TPersistedGroupMetadataRecord,
  TPersistedGroupMembershipRecord,
  TJoinRequest
} from '@/types/groups'
import client from '@/services/client.service'
import indexedDb from '@/services/indexed-db.service'
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
import * as nip19 from '@jsr/nostr__tools/nip19'
import { normalizeUrl } from '@/lib/url'
import type { CreateGroupProgressState } from '@/lib/workflow-progress-ui'

const INVITE_DISMISSED_STORAGE_PREFIX = 'hyperpipe_group_invites_dismissed_v1'
const INVITE_ACCEPTED_STORAGE_PREFIX = 'hyperpipe_group_invites_accepted_v1'

const getSnapshotEventTaggedPubkeys = (event: Pick<TDraftEvent, 'tags'>) =>
  normalizeMembershipPubkeys(
    (Array.isArray(event.tags) ? event.tags : [])
      .filter((tag) => tag[0] === 'p')
      .map((tag) => tag[1])
  )

const getSnapshotEventAdminTaggedPubkeys = (event: Pick<TDraftEvent, 'tags'>) =>
  normalizeMembershipPubkeys(
    (Array.isArray(event.tags) ? event.tags : [])
      .filter(
        (tag) =>
          tag[0] === 'p' && tag.slice(2).some((value) => String(value || '').trim() === 'admin')
      )
      .map((tag) => tag[1])
  )

const logGroupSnapshotPublishAttempt = (args: {
  reason: string
  groupId: string
  event: Pick<TDraftEvent, 'kind' | 'created_at' | 'tags'>
  relayUrls: string[]
}) => {
  if (args.event.kind !== 39001 && args.event.kind !== 39002) return
  const taggedPubkeys = getSnapshotEventTaggedPubkeys(args.event)
  const adminTaggedPubkeys = getSnapshotEventAdminTaggedPubkeys(args.event)
  console.info('[GroupsProvider] Publishing group snapshot event', {
    reason: args.reason,
    groupId: args.groupId,
    kind: args.event.kind,
    createdAt: args.event.created_at,
    taggedPubkeysCount: taggedPubkeys.length,
    adminTaggedPubkeysCount: adminTaggedPubkeys.length,
    selfOnly: taggedPubkeys.length === 1,
    relayTargets: args.relayUrls.length
  })
}
const INVITE_ACCEPTED_GROUPS_STORAGE_PREFIX = 'hyperpipe_group_invites_accepted_groups_v1'
const JOIN_REQUESTS_HANDLED_STORAGE_KEY = 'hyperpipe_join_requests_handled_v1'
const GROUP_MEMBER_PREVIEW_TTL_MS = 2 * 60 * 1000
const GROUP_MEMBER_PREVIEW_INCOMPLETE_TTL_MS = 15 * 1000
const TOKENIZED_RELAY_REFRESH_MIN_INTERVAL_MS = 5000
const LEAVE_PUBLISH_RETRY_BASE_DELAY_MS = 5000
const LEAVE_PUBLISH_RETRY_MAX_DELAY_MS = 60 * 60 * 1000
const JOIN_FLOW_SUCCESS_FRESH_MS = 15 * 60 * 1000
const INVITE_MIRROR_METADATA_TIMEOUT_MS = 1500
const DEFAULT_GATEWAY_MEMBER_SCOPES = [
  'relay:bootstrap',
  'relay:mirror-read',
  'relay:mirror-sync',
  'relay:ws-connect'
]

type GroupMemberPreviewEntry = TGroupMembershipState

type ProvisionalGroupMetadataEntry = {
  metadata: TGroupMetadata
  source: 'invite' | 'create' | 'update' | 'persisted'
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

type TGroupMetadataDiscoveryHints = {
  discoveryTopic?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
}

type TGroupsContext = {
  discoveryGroups: TGroupMetadata[]
  invites: TGroupInvite[]
  pendingInviteCount: number
  joinRequests: Record<string, TJoinRequest[]>
  favoriteGroups: string[]
  myGroupList: TGroupListEntry[]
  isLoadingDiscovery: boolean
  discoveryError: string | null
  invitesError: string | null
  joinRequestsError: string | null
  discoveryRelays: string[]
  setDiscoveryRelays: (relays: string[]) => void
  resetDiscoveryRelays: () => void
  refreshDiscovery: (relayUrls?: string[]) => Promise<void>
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
    membership: TGroupMembershipState
    membershipStatus: TGroupMembershipStatus
    membershipAuthoritative: boolean
    membershipEventsCount: number
    membersFromEventCount: number
    membersSnapshotCreatedAt: number | null
    membershipFetchTimedOutLike: boolean
    membershipFetchSource: TGroupMembershipState['membershipFetchSource']
  }>
  getProvisionalGroupMetadata: (groupId: string, relay?: string) => TGroupMetadata | null
  getGroupMemberPreview: (groupId: string, relay?: string) => TGroupMembershipState | null
  hydrateGroupMemberPreview: (groupId: string, relay?: string) => Promise<void>
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
  createHyperpipeRelayGroup: (
    data: {
      name: string
      about?: string
      isPublic: boolean
      isOpen: boolean
      picture?: string
      fileSharing?: boolean
      gatewayOrigin?: string | null
      gatewayId?: string | null
      gatewayAuthMethod?: string | null
      gatewayDelegation?: string | null
      gatewaySponsorPubkey?: string | null
      directJoinOnly?: boolean
    },
    options?: {
      onProgress?: (state: CreateGroupProgressState) => void
    }
  ) => Promise<{ groupId: string; relay: string }>
}

const GroupsContext = createContext<TGroupsContext | undefined>(undefined)

export const useGroups = () => {
  const context = useContext(GroupsContext)
  if (!context) {
    console.warn('useGroups called outside GroupsProvider; returning fallback context')
    return {
      discoveryGroups: [],
      invites: [],
      pendingInviteCount: 0,
      joinRequests: {},
      favoriteGroups: [],
      myGroupList: [],
      isLoadingDiscovery: false,
      discoveryError: null,
      invitesError: null,
      joinRequestsError: null,
      discoveryRelays: [...defaultDiscoveryRelays],
      setDiscoveryRelays: () => {},
      resetDiscoveryRelays: () => {},
      refreshDiscovery: async () => {},
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
        membership: createGroupMembershipState(),
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
      hydrateGroupMemberPreview: async () => {},
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
      createHyperpipeRelayGroup: async () => {
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
  toGroupMembershipCacheKey(groupId, relay)
const toProvisionalGroupMetadataKey = (groupId: string, relay?: string | null) =>
  `${relay ? getBaseRelayUrl(relay) : ''}|${groupId}`
const toPersistedGroupMetadataRecordKey = (accountPubkey: string, groupId: string) =>
  `${String(accountPubkey || '').trim()}|${String(groupId || '').trim()}`
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const getLeavePublishRetryDelayMs = (attempts: number) =>
  Math.min(
    LEAVE_PUBLISH_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts),
    LEAVE_PUBLISH_RETRY_MAX_DELAY_MS
  )

const tryDecodeNpubToHex = (value?: string | null): string | undefined => {
  const candidate = String(value || '').trim()
  if (!candidate.startsWith('npub1')) return undefined
  try {
    const decoded = nip19.decode(candidate)
    if (decoded.type === 'npub') return decoded.data as string
  } catch (_err) {
    // ignore decode failures
  }
  return undefined
}

const extractCreatorPubkeyHint = (value?: string | null): string | undefined => {
  const raw = String(value || '').trim()
  if (!raw) return undefined

  const exact = tryDecodeNpubToHex(raw)
  if (exact) return exact

  const candidates = new Set<string>()
  const colonIndex = raw.indexOf(':')
  if (colonIndex > 0) candidates.add(raw.slice(0, colonIndex))
  const slashIndex = raw.indexOf('/')
  if (slashIndex > 0) candidates.add(raw.slice(0, slashIndex))
  const match = raw.match(/(npub1[023456789acdefghjklmnpqrstuvwxyz]+)/i)
  if (match?.[1]) candidates.add(match[1])

  for (const candidate of candidates) {
    const decoded = tryDecodeNpubToHex(candidate)
    if (decoded) return decoded
  }
  return undefined
}

const createProvisionalGroupMetadata = (args: {
  groupId: string
  relay?: string | null
  name?: string | null
  about?: string | null
  picture?: string | null
  isPublic?: boolean
  isOpen?: boolean
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  createdAt?: number
  creatorPubkey?: string | null
  event?: TGroupMetadata['event'] | null
}): TGroupMetadata | null => {
  const groupId = String(args.groupId || '').trim()
  if (!groupId) return null
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const about = typeof args.about === 'string' ? args.about.trim() : ''
  const picture = typeof args.picture === 'string' ? args.picture.trim() : ''
  const hasAnyMetadata =
    !!name ||
    !!about ||
    !!picture ||
    typeof args.isPublic === 'boolean' ||
    typeof args.isOpen === 'boolean'
  if (!hasAnyMetadata) return null
  const createdAt =
    Number.isFinite(args.createdAt) && (args.createdAt as number) > 0
      ? Math.floor(args.createdAt as number)
      : Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['d', groupId],
    ['h', groupId],
    ['i', HYPERPIPE_IDENTIFIER_TAG]
  ]
  if (name) tags.push(['name', name])
  if (about) tags.push(['about', about])
  if (picture) tags.push(['picture', picture])
  if (typeof args.isPublic === 'boolean') tags.push([args.isPublic ? 'public' : 'private'])
  if (typeof args.isOpen === 'boolean') tags.push([args.isOpen ? 'open' : 'closed'])
  const gatewayId = typeof args.gatewayId === 'string' ? args.gatewayId.trim().toLowerCase() : ''
  const gatewayOrigin = normalizeHttpOrigin(args.gatewayOrigin || null)
  if (gatewayId) tags.push([HYPERPIPE_GATEWAY_ID_TAG, gatewayId])
  if (gatewayOrigin) tags.push([HYPERPIPE_GATEWAY_ORIGIN_TAG, gatewayOrigin])
  if (args.directJoinOnly === true) tags.push([HYPERPIPE_DIRECT_JOIN_ONLY_TAG, '1'])
  const event =
    args.event ||
    ({
      id: `provisional:${groupId}:${createdAt}`,
      pubkey: String(args.creatorPubkey || '').trim(),
      created_at: createdAt,
      kind: ExtendedKind.GROUP_METADATA,
      tags,
      content: '',
      sig: ''
    } as any)
  return {
    id: groupId,
    relay: args.relay ? getBaseRelayUrl(args.relay) : undefined,
    name: name || groupId,
    about: about || undefined,
    picture: picture || undefined,
    isPublic: typeof args.isPublic === 'boolean' ? args.isPublic : undefined,
    isOpen: typeof args.isOpen === 'boolean' ? args.isOpen : undefined,
    gatewayId: gatewayId || null,
    gatewayOrigin,
    directJoinOnly: args.directJoinOnly === true,
    tags: [],
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

const normalizePubkeyList = (values?: string[] | null) => normalizeMembershipPubkeys(values || [])

const isLoopbackRelayUrl = (relayUrl?: string | null): boolean => {
  if (!relayUrl) return false
  try {
    const parsed = new URL(relayUrl)
    const host = String(parsed.hostname || '').toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch (_err) {
    return /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(relayUrl)
  }
}

const normalizeHttpOrigin = (value?: string | null): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch (_err) {
    return null
  }
}

const isLoopbackHttpOrigin = (origin?: string | null): boolean => {
  if (!origin) return false
  try {
    const parsed = new URL(origin)
    const host = String(parsed.hostname || '').toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch (_err) {
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(origin)
  }
}

const areSameMemberLists = (left: string[], right: string[]) => {
  const normalizedLeft = normalizeMembershipPubkeys(left)
  const normalizedRight = normalizeMembershipPubkeys(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, idx) => value === normalizedRight[idx])
  )
}

const areEquivalentMembershipStates = (
  left: GroupMemberPreviewEntry | null | undefined,
  right: GroupMemberPreviewEntry | null | undefined
) => {
  if (!left || !right) return left === right
  return (
    left.updatedAt === right.updatedAt &&
    left.quality === right.quality &&
    left.membershipStatus === right.membershipStatus &&
    areSameMemberLists(left.members, right.members) &&
    left.membershipEventsCount === right.membershipEventsCount &&
    left.selectedSnapshotCreatedAt === right.selectedSnapshotCreatedAt &&
    left.selectedSnapshotId === right.selectedSnapshotId &&
    left.hydrationSource === right.hydrationSource &&
    left.membershipFetchSource === right.membershipFetchSource &&
    left.opsOverflowed === right.opsOverflowed &&
    left.memberCount === right.memberCount
  )
}

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
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  writerLeaseEnvelope?: Record<string, unknown> | null
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
  gatewayAccess?: TGroupGatewayAccess | null
}) => ({
  relayUrl: args.relayUrl,
  token: args.token,
  relayKey: args.relayKey ?? null,
  gatewayId: args.gatewayId ?? null,
  gatewayOrigin: args.gatewayOrigin ?? null,
  directJoinOnly: args.directJoinOnly === true,
  isPublic: args.meta?.isPublic !== false,
  isOpen: args.meta?.isOpen === true,
  groupName: args.groupName || args.meta?.name,
  groupPicture: args.groupPicture || args.meta?.picture || null,
  authorizedMemberPubkeys: normalizePubkeyList(args.authorizedMemberPubkeys),
  name: args.groupName || args.meta?.name,
  about: args.meta?.about,
  fileSharing: args.meta?.isOpen !== false,
  blindPeer: args.mirrorMetadata?.blindPeer,
  cores: args.mirrorMetadata?.cores,
  discoveryTopic: args.discoveryTopic || null,
  hostPeerKeys: normalizePubkeyList(args.hostPeerKeys || []),
  leaseReplicaPeerKeys: normalizePubkeyList(args.leaseReplicaPeerKeys || []),
  writerIssuerPubkey: args.writerIssuerPubkey || null,
  writerLeaseEnvelope: args.writerLeaseEnvelope || null,
  fastForward: args.fastForward ?? null,
  writerCore: args.writerInfo?.writerCore || null,
  writerCoreHex: args.writerInfo?.writerCoreHex || args.writerInfo?.autobaseLocal || null,
  autobaseLocal: args.writerInfo?.autobaseLocal || args.writerInfo?.writerCoreHex || null,
  writerSecret: args.writerInfo?.writerSecret || null,
  gatewayAccess: args.gatewayAccess || null
})

const buildOpenInvitePayload = (args: {
  relayUrl: string | null
  relayKey?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  groupName?: string
  groupPicture?: string
  authorizedMemberPubkeys?: string[]
  gatewayAccess?: TGroupGatewayAccess | null
}) => ({
  relayUrl: args.relayUrl,
  relayKey: args.relayKey ?? null,
  gatewayId: args.gatewayId ?? null,
  gatewayOrigin: args.gatewayOrigin ?? null,
  directJoinOnly: args.directJoinOnly === true,
  isOpen: true,
  discoveryTopic: args.discoveryTopic || null,
  hostPeerKeys: normalizePubkeyList(args.hostPeerKeys || []),
  leaseReplicaPeerKeys: normalizePubkeyList(args.leaseReplicaPeerKeys || []),
  writerIssuerPubkey: args.writerIssuerPubkey || null,
  groupName: args.groupName || null,
  groupPicture: args.groupPicture || null,
  authorizedMemberPubkeys: normalizePubkeyList(args.authorizedMemberPubkeys),
  gatewayAccess: args.gatewayAccess || null
})

const resolveInviteIsOpen = (invite: Pick<
  TGroupInvite,
  'isOpen'
  | 'token'
  | 'gatewayAccess'
  | 'gatewayOrigin'
  | 'gatewayId'
  | 'writerLeaseEnvelope'
  | 'writerSecret'
  | 'directJoinOnly'
  | 'fileSharing'
>) => {
  if (invite.isOpen === true) return true
  if (invite.isOpen === false) return false
  if (invite.token) return false
  if (invite.writerLeaseEnvelope || invite.writerSecret) return false
  if (invite.gatewayAccess || invite.gatewayOrigin || invite.gatewayId) return false
  if (invite.directJoinOnly === true) return true
  return invite.fileSharing === true
}

const parseGatewayAccessPayload = (value: unknown): TGroupGatewayAccess | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const gatewayOrigin =
    normalizeHttpOrigin(
      typeof candidate.gatewayOrigin === 'string' ? candidate.gatewayOrigin : null
    ) ||
    normalizeHttpOrigin(
      typeof candidate.gateway_origin === 'string' ? candidate.gateway_origin : null
    )
  const gatewayId =
    typeof candidate.gatewayId === 'string'
      ? candidate.gatewayId.trim().toLowerCase() || null
      : typeof candidate.gateway_id === 'string'
        ? candidate.gateway_id.trim().toLowerCase() || null
        : null
  const grantId =
    typeof candidate.grantId === 'string'
      ? candidate.grantId.trim() || null
      : typeof candidate.grant_id === 'string'
        ? candidate.grant_id.trim() || null
        : null
  const authMethod =
    typeof candidate.authMethod === 'string'
      ? candidate.authMethod.trim() || null
      : typeof candidate.auth_method === 'string'
        ? candidate.auth_method.trim() || null
        : null
  const version = typeof candidate.version === 'string' ? candidate.version.trim() || null : null
  const scopes = Array.isArray(candidate.scopes)
    ? Array.from(
        new Set(candidate.scopes.map((entry) => String(entry || '').trim()).filter(Boolean))
      )
    : []
  if (!grantId && !gatewayOrigin && !gatewayId) return null
  return {
    version,
    authMethod,
    grantId,
    gatewayId,
    gatewayOrigin,
    scopes: scopes.length ? scopes : [...DEFAULT_GATEWAY_MEMBER_SCOPES]
  }
}

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
  const [discoveryRelays, setDiscoveryRelaysState] = useState<string[]>(() => {
    const stored = localStorageService.getGroupDiscoveryRelays()
    const base = stored.length ? stored : defaultDiscoveryRelays
    return Array.from(
      new Set(base.map((url) => normalizeUrl(String(url || '').trim())).filter(Boolean))
    )
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

  const setDiscoveryRelays = useCallback((nextRelays: string[]) => {
    const sanitized = Array.from(
      new Set(
        (Array.isArray(nextRelays) ? nextRelays : [])
          .map((relay) => normalizeUrl(String(relay || '').trim()))
          .filter(Boolean)
      )
    )
    setDiscoveryRelaysState(sanitized.length ? sanitized : [...defaultDiscoveryRelays])
  }, [])

  const resetDiscoveryRelays = useCallback(() => {
    setDiscoveryRelaysState([...defaultDiscoveryRelays])
  }, [])
  const dismissedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteGroupIdsRef = useRef<Set<string>>(new Set())
  const groupMemberPreviewByKeyRef = useRef<Record<string, GroupMemberPreviewEntry>>({})
  const groupMemberPreviewInFlightRef = useRef<Map<string, Promise<string[]>>>(new Map())
  const groupMembershipPersistedRecordsRef = useRef<
    Record<string, TPersistedGroupMembershipRecord>
  >({})
  const groupMetadataPersistedRecordsRef = useRef<Record<string, TPersistedGroupMetadataRecord>>({})
  const groupMembershipLazyHydrateInFlightRef = useRef<Set<string>>(new Set())
  const groupMetadataLazyHydrateInFlightRef = useRef<Set<string>>(new Set())
  const inviteRefreshInFlightRef = useRef(false)

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
      const existing = map.get(key)
      if (existing) {
        const existingTokenized = hasRelayAuthToken(existing)
        const incomingTokenized = hasRelayAuthToken(value)
        if (existingTokenized && !incomingTokenized) return
        if (existing === value) return
      }
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

  const upsertProvisionalGroupMetadata = useCallback(
    (args: {
      groupId: string
      relay?: string | null
      name?: string | null
      about?: string | null
      picture?: string | null
      isPublic?: boolean
      isOpen?: boolean
      gatewayId?: string | null
      gatewayOrigin?: string | null
      directJoinOnly?: boolean
      createdAt?: number
      creatorPubkey?: string | null
      event?: TGroupMetadata['event'] | null
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
        gatewayId: args.gatewayId,
        gatewayOrigin: args.gatewayOrigin,
        directJoinOnly: args.directJoinOnly,
        createdAt: args.createdAt,
        creatorPubkey: args.creatorPubkey,
        event: args.event
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
            (current.metadata.gatewayId || null) === (metadata.gatewayId || null) &&
            (current.metadata.gatewayOrigin || null) === (metadata.gatewayOrigin || null) &&
            current.metadata.directJoinOnly === metadata.directJoinOnly
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

  const persistGroupMetadata = useCallback(
    async (metadata: TGroupMetadata | null | undefined, relay?: string) => {
      if (!pubkey || !metadata?.id) return
      const creatorPubkey = String(metadata.event?.pubkey || '').trim()
      if (!creatorPubkey) return
      const record: TPersistedGroupMetadataRecord = {
        key: toPersistedGroupMetadataRecordKey(pubkey, metadata.id),
        accountPubkey: pubkey,
        groupId: metadata.id,
        metadata: {
          ...metadata,
          relay: metadata.relay || (relay ? getBaseRelayUrl(relay) : undefined)
        },
        persistedAt: Date.now()
      }
      groupMetadataPersistedRecordsRef.current[record.key] = record
      await indexedDb.putGroupMetadataCache(record)
    },
    [pubkey]
  )

  const hydratePersistedGroupMetadata = useCallback(
    async (groupId: string) => {
      if (!pubkey) return null
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const recordKey = toPersistedGroupMetadataRecordKey(pubkey, normalizedGroupId)
      const existing = groupMetadataPersistedRecordsRef.current[recordKey] || null
      if (existing?.metadata) return existing.metadata
      if (groupMetadataLazyHydrateInFlightRef.current.has(recordKey)) return null

      groupMetadataLazyHydrateInFlightRef.current.add(recordKey)
      try {
        const record = await indexedDb.getGroupMetadataCache(pubkey, normalizedGroupId)
        if (!record?.metadata) return null
        groupMetadataPersistedRecordsRef.current[record.key] = record
        upsertProvisionalGroupMetadata({
          groupId: record.groupId,
          relay: record.metadata.relay,
          name: record.metadata.name,
          about: record.metadata.about,
          picture: record.metadata.picture,
          isPublic: record.metadata.isPublic,
          isOpen: record.metadata.isOpen,
          gatewayId: record.metadata.gatewayId,
          gatewayOrigin: record.metadata.gatewayOrigin,
          directJoinOnly: record.metadata.directJoinOnly,
          createdAt: record.metadata.event?.created_at,
          creatorPubkey: record.metadata.event?.pubkey,
          event: record.metadata.event,
          source: 'persisted'
        })
        return record.metadata
      } catch (_err) {
        return null
      } finally {
        groupMetadataLazyHydrateInFlightRef.current.delete(recordKey)
      }
    },
    [pubkey, upsertProvisionalGroupMetadata]
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

  const getGroupMembershipCacheKeys = useCallback(
    (groupId: string, relay?: string) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return [] as string[]
      const keys = new Set<string>([toGroupMemberPreviewKey(normalizedGroupId)])
      if (relay) {
        keys.add(toGroupMemberPreviewKey(normalizedGroupId, relay))
        const resolvedRelay = resolveRelayUrl(relay)
        if (resolvedRelay) {
          keys.add(toGroupMemberPreviewKey(normalizedGroupId, resolvedRelay))
        }
      }
      return Array.from(keys)
    },
    [resolveRelayUrl]
  )

  const getCachedGroupMemberPreview = useCallback(
    (
      groupId: string,
      relay: string | undefined,
      source: Record<string, GroupMemberPreviewEntry>
    ) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const cacheKeys = getGroupMembershipCacheKeys(normalizedGroupId, relay)
      return selectPreferredMembershipState(cacheKeys.map((cacheKey) => source[cacheKey] || null))
    },
    [getGroupMembershipCacheKeys]
  )

  const getGroupMembershipRelayBase = useCallback(
    (groupId: string, relay?: string, opts?: { discoveryOnly?: boolean }) => {
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedRelay = resolveRelayUrl(relay || relayEntry?.connectionUrl || undefined)
      return getPersistedGroupMembershipRelayBase({
        relayBase: String(getBaseRelayUrl(resolvedRelay || relay || '') || '').trim(),
        discoveryOnly: opts?.discoveryOnly
      })
    },
    [getRelayEntryForGroup, resolveRelayUrl]
  )

  const getPersistedGroupMembershipBaseline = useCallback(
    (
      groupId: string,
      relay: string | undefined,
      opts?: {
        discoveryOnly?: boolean
      }
    ) => {
      if (!pubkey) return null
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null

      const relayBases = new Set<string>([
        getGroupMembershipRelayBase(normalizedGroupId, relay, {
          discoveryOnly: opts?.discoveryOnly
        })
      ])
      if (opts?.discoveryOnly !== true) {
        relayBases.add(DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE)
      }

      const candidates = Array.from(relayBases)
        .map((relayBase) => {
          const recordKey = toPersistedGroupMembershipRecordKey(
            pubkey,
            normalizedGroupId,
            relayBase
          )
          const record = groupMembershipPersistedRecordsRef.current[recordKey] || null
          if (!record) return null
          return (
            hydratePersistedGroupMembershipState(record.lastComplete, 'persisted-last-complete') ||
            hydratePersistedGroupMembershipState(record.lastKnown, 'persisted-last-known')
          )
        })
        .filter((state): state is GroupMemberPreviewEntry => !!state)

      return selectPreferredMembershipState(candidates)
    },
    [getGroupMembershipRelayBase, pubkey]
  )

  const getRelayRuntimeState = useCallback(
    (groupId: string, relay?: string) => {
      const relayEntry = getRelayEntryForGroup(groupId)
      const resolvedRelay = resolveRelayUrl(relay || relayEntry?.connectionUrl || undefined)
      const relayReadyForReq = relayEntry?.readyForReq === true
      const relayWritable = relayEntry?.writable === true
      const hasActiveRelayConnection = !!(
        relayEntry &&
        relayEntry.isActive !== false &&
        relayEntry.connectionUrl
      )
      return {
        relayEntry,
        resolvedRelay,
        relayReadyForReq,
        relayWritable,
        relayHasAuthToken: hasRelayAuthToken(resolvedRelay),
        relayLooksLoopback: isLoopbackRelayUrl(resolvedRelay),
        hasActiveRelayConnection
      }
    },
    [getRelayEntryForGroup, resolveRelayUrl]
  )

  const persistGroupMembershipState = useCallback(
    async (
      groupId: string,
      relay: string | undefined,
      visibleState: GroupMemberPreviewEntry | null,
      opts?: {
        isJoinedGroup?: boolean
        isActiveGroup?: boolean
        persistDiscover?: boolean
        discoveryOnly?: boolean
        lastKnownState?: GroupMemberPreviewEntry | null
      }
    ) => {
      if (!pubkey || !visibleState) return
      const shouldPersist =
        opts?.isJoinedGroup === true ||
        opts?.isActiveGroup === true ||
        opts?.persistDiscover === true
      if (!shouldPersist) return
      if (
        opts?.persistDiscover &&
        visibleState.memberCount === 0 &&
        visibleState.quality === 'partial'
      ) {
        return
      }
      const relayBase = getGroupMembershipRelayBase(groupId, relay, {
        discoveryOnly: opts?.discoveryOnly
      })
      const recordKey = toPersistedGroupMembershipRecordKey(pubkey, groupId, relayBase)
      const currentRecord = groupMembershipPersistedRecordsRef.current[recordKey] || null
      const lastKnownState = opts?.lastKnownState || visibleState
      const persistedRecord = updatePersistedGroupMembershipRecord(currentRecord, {
        accountPubkey: pubkey,
        groupId,
        relayBase,
        lastKnown: lastKnownState,
        lastComplete:
          visibleState.quality === 'complete'
            ? visibleState
            : lastKnownState.quality === 'complete'
              ? lastKnownState
              : undefined
      })
      groupMembershipPersistedRecordsRef.current[recordKey] = persistedRecord
      await indexedDb.putGroupMembershipCache(persistedRecord)
    },
    [getGroupMembershipRelayBase, pubkey]
  )

  const deletePersistedGroupMembershipState = useCallback(
    async (groupId: string, relay?: string, opts?: { discoveryOnly?: boolean }) => {
      if (!pubkey) return
      const relayBase = getGroupMembershipRelayBase(groupId, relay, {
        discoveryOnly: opts?.discoveryOnly
      })
      const recordKey = toPersistedGroupMembershipRecordKey(pubkey, groupId, relayBase)
      delete groupMembershipPersistedRecordsRef.current[recordKey]
      await indexedDb.deleteGroupMembershipCache(pubkey, groupId, relayBase || undefined)
    },
    [getGroupMembershipRelayBase, pubkey]
  )

  const applyGroupMembershipState = useCallback(
    (
      groupId: string,
      relay: string | undefined,
      incomingState: GroupMemberPreviewEntry | null,
      opts?: {
        persist?: boolean
        isJoinedGroup?: boolean
        isActiveGroup?: boolean
        persistDiscover?: boolean
        discoveryOnly?: boolean
      }
    ) => {
      if (!incomingState) return null
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const cacheKeys = getGroupMembershipCacheKeys(normalizedGroupId, relay)
      let resolvedState: GroupMemberPreviewEntry | null = incomingState
      let changed = false

      setGroupMemberPreviewByKey((prev) => {
        if (!cacheKeys.length) return prev
        const currentStates = cacheKeys
          .map((cacheKey) => prev[cacheKey] || null)
          .filter((state): state is GroupMemberPreviewEntry => !!state)
        const preferredState = selectPreferredMembershipState([...currentStates, incomingState])
        if (!preferredState) return prev
        const next = { ...prev }
        cacheKeys.forEach((cacheKey) => {
          const current = next[cacheKey] || null
          if (areEquivalentMembershipStates(current, preferredState)) {
            resolvedState = current
            return
          }
          next[cacheKey] = preferredState
          resolvedState = preferredState
          changed = true
        })
        return changed ? next : prev
      })

      if (changed) {
        setGroupMemberPreviewVersion((prev) => prev + 1)
      }

      if (opts?.persist && resolvedState) {
        persistGroupMembershipState(normalizedGroupId, relay, resolvedState, {
          ...opts,
          lastKnownState: incomingState
        }).catch(() => {})
      }

      return resolvedState
    },
    [getGroupMembershipCacheKeys, persistGroupMembershipState]
  )

  const hydrateGroupMemberPreview = useCallback(
    async (groupId: string, relay?: string) => {
      if (!pubkey) return
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return
      const relayBase = getGroupMembershipRelayBase(normalizedGroupId, relay)
      const joined = myGroupList.some((entry) => entry.groupId === normalizedGroupId)
      const relayBasesToTry = joined
        ? [relayBase]
        : Array.from(new Set([relayBase, DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE].filter(Boolean)))
      const recordKeysToTry = relayBasesToTry.map((candidateRelayBase) =>
        toPersistedGroupMembershipRecordKey(pubkey, normalizedGroupId, candidateRelayBase)
      )
      const inFlightKey = recordKeysToTry[0]
      if (groupMembershipLazyHydrateInFlightRef.current.has(inFlightKey)) return
      groupMembershipLazyHydrateInFlightRef.current.add(inFlightKey)
      try {
        let record =
          recordKeysToTry
            .map((recordKey) => groupMembershipPersistedRecordsRef.current[recordKey] || null)
            .find(Boolean) || null
        if (!record) {
          for (const candidateRelayBase of relayBasesToTry) {
            record = await indexedDb.getGroupMembershipCache(
              pubkey,
              normalizedGroupId,
              candidateRelayBase || undefined
            )
            if (record) break
          }
        }
        if (!record) return
        groupMembershipPersistedRecordsRef.current[record.key] = record
        const seededState =
          hydratePersistedGroupMembershipState(record.lastComplete, 'persisted-last-complete') ||
          hydratePersistedGroupMembershipState(record.lastKnown, 'persisted-last-known')
        if (!seededState) return
        applyGroupMembershipState(
          normalizedGroupId,
          isDiscoveryPersistedGroupMembershipRelayBase(record.relayBase) ? undefined : relay,
          seededState,
          {
            persist: false,
            isJoinedGroup: joined,
            persistDiscover:
              !joined && isDiscoveryPersistedGroupMembershipRelayBase(record.relayBase),
            discoveryOnly: isDiscoveryPersistedGroupMembershipRelayBase(record.relayBase)
          }
        )
      } finally {
        groupMembershipLazyHydrateInFlightRef.current.delete(inFlightKey)
      }
    },
    [applyGroupMembershipState, getGroupMembershipRelayBase, myGroupList, pubkey]
  )

  const patchGroupMembershipOptimistically = useCallback(
    (
      groupId: string,
      relay: string | undefined,
      updater: (currentMembers: string[]) => string[],
      opts?: {
        membershipStatus?: TGroupMembershipStatus
        isJoinedGroup?: boolean
        isActiveGroup?: boolean
      }
    ) => {
      const normalizedGroupId = String(groupId || '').trim()
      const current =
        groupMemberPreviewByKeyRef.current[toGroupMemberPreviewKey(normalizedGroupId, relay)] ||
        groupMemberPreviewByKeyRef.current[toGroupMemberPreviewKey(normalizedGroupId)] ||
        createGroupMembershipState({
          members: [],
          quality: 'warming',
          hydrationSource: 'optimistic',
          source: 'optimistic',
          selectedSnapshotSource: 'optimistic'
        })
      const nextMembers = normalizePubkeyList(updater(current.members))
      const nextState = createGroupMembershipState({
        ...current,
        members: nextMembers,
        membershipStatus: opts?.membershipStatus || current.membershipStatus,
        quality: 'warming',
        hydrationSource: 'optimistic',
        authoritative: false,
        membershipAuthoritative: false,
        source: 'optimistic',
        selectedSnapshotSource: current.selectedSnapshotSource || 'optimistic',
        membershipFetchSource: 'optimistic',
        updatedAt: Date.now()
      })
      return applyGroupMembershipState(normalizedGroupId, relay, nextState, {
        persist: true,
        isJoinedGroup: opts?.isJoinedGroup === true,
        isActiveGroup: opts?.isActiveGroup === true
      })
    },
    [applyGroupMembershipState]
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
    async (
      relayIdentifier: string,
      options?: {
        gatewayOrigin?: string | null
        resolved?: string | null
        timeoutMs?: number | null
      }
    ): Promise<InviteMirrorMetadata> => {
      const origins: string[] = []
      const normalizedGatewayOrigin = normalizeHttpOrigin(options?.gatewayOrigin || null)
      if (normalizedGatewayOrigin && !isLoopbackHttpOrigin(normalizedGatewayOrigin)) {
        origins.push(normalizedGatewayOrigin)
      }
      if (options?.resolved) {
        try {
          const baseUrl = new URL(options.resolved)
          baseUrl.protocol = baseUrl.protocol === 'wss:' ? 'https:' : 'http:'
          const hostOrigin = normalizeHttpOrigin(baseUrl.origin)
          if (
            hostOrigin &&
            !isLoopbackHttpOrigin(hostOrigin) &&
            !origins.includes(hostOrigin)
          ) {
            origins.push(hostOrigin)
          }
        } catch (_err) {
          // Ignore malformed relay URLs and fall back to any explicit gateway origin.
        }
      }

      if (!origins.length) return null

      for (const origin of origins) {
        const controller =
          typeof AbortController === 'function' ? new AbortController() : null
        const timeoutMs =
          Number.isFinite(Number(options?.timeoutMs))
            ? Math.max(1, Number(options?.timeoutMs))
            : INVITE_MIRROR_METADATA_TIMEOUT_MS
        const timeoutId = controller
          ? window.setTimeout(() => controller.abort(), timeoutMs)
          : null
        try {
          const resp = await fetch(
            `${origin}/api/relays/${encodeURIComponent(relayIdentifier)}/mirror`,
            controller ? { signal: controller.signal } : undefined
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
          const isAbort =
            err instanceof DOMException
              ? err.name === 'AbortError'
              : typeof err === 'object' &&
                err !== null &&
                'name' in err &&
                (err as { name?: string }).name === 'AbortError'
          console.warn('[GroupsProvider] Failed to fetch relay mirror metadata', {
            origin,
            err: isAbort ? 'Timed out' : err instanceof Error ? err.message : err
          })
        } finally {
          if (timeoutId !== null) {
            window.clearTimeout(timeoutId)
          }
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
    groupMembershipPersistedRecordsRef.current = {}
    groupMembershipLazyHydrateInFlightRef.current.clear()
    groupMetadataPersistedRecordsRef.current = {}
    groupMetadataLazyHydrateInFlightRef.current.clear()
    setProvisionalGroupMetadataByKey({})
  }, [pubkey])

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false

    indexedDb
      .getAllGroupMembershipCache(pubkey)
      .then((records) => {
        if (cancelled) return
        const nextRecords: Record<string, TPersistedGroupMembershipRecord> = {}
        records.forEach((record) => {
          nextRecords[record.key] = record
        })
        groupMembershipPersistedRecordsRef.current = nextRecords

        const seededEntries = records
          .map((record) => {
            const state =
              hydratePersistedGroupMembershipState(
                record.lastComplete,
                'persisted-last-complete'
              ) || hydratePersistedGroupMembershipState(record.lastKnown, 'persisted-last-known')
            if (!state) return null
            return {
              key: isDiscoveryPersistedGroupMembershipRelayBase(record.relayBase)
                ? toGroupMemberPreviewKey(record.groupId)
                : toGroupMemberPreviewKey(record.groupId, record.relayBase),
              state
            }
          })
          .filter((entry): entry is { key: string; state: GroupMemberPreviewEntry } => !!entry)

        if (!seededEntries.length) return
        setGroupMemberPreviewByKey((prev) => {
          const next = { ...prev }
          let changed = false
          seededEntries.forEach(({ key, state }) => {
            const current = next[key] || null
            const preferred = choosePreferredMembershipState(current, state)
            if (!preferred) return
            if (
              current &&
              current.updatedAt === preferred.updatedAt &&
              current.quality === preferred.quality &&
              areSameMemberLists(current.members, preferred.members)
            ) {
              return
            }
            next[key] = preferred
            changed = true
          })
          return changed ? next : prev
        })
        setGroupMemberPreviewVersion((prev) => prev + 1)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [pubkey])

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false

    indexedDb
      .getAllGroupMetadataCache(pubkey)
      .then((records) => {
        if (cancelled) return
        const nextRecords: Record<string, TPersistedGroupMetadataRecord> = {}
        records.forEach((record) => {
          nextRecords[record.key] = record
        })
        groupMetadataPersistedRecordsRef.current = nextRecords

        if (!records.length) return
        setProvisionalGroupMetadataByKey((prev) => {
          let changed = false
          const next = { ...prev }
          records.forEach((record) => {
            const metadata = record.metadata
            if (!metadata?.id) return
            const keys = new Set<string>([toProvisionalGroupMetadataKey(metadata.id)])
            if (metadata.relay) keys.add(toProvisionalGroupMetadataKey(metadata.id, metadata.relay))
            keys.forEach((key) => {
              const current = next[key]
              const currentTs = current?.metadata?.event?.created_at || 0
              const incomingTs = metadata.event?.created_at || 0
              if (current && currentTs > incomingTs) return
              if (
                current &&
                currentTs === incomingTs &&
                current.metadata.event?.pubkey === metadata.event?.pubkey &&
                current.metadata.name === metadata.name &&
                (current.metadata.about || '') === (metadata.about || '') &&
                (current.metadata.picture || '') === (metadata.picture || '') &&
                current.metadata.isPublic === metadata.isPublic &&
                current.metadata.isOpen === metadata.isOpen
              ) {
                return
              }
              next[key] = {
                metadata,
                source: 'persisted',
                updatedAt: Date.now()
              }
              changed = true
            })
          })
          return changed ? next : prev
        })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
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

  const refreshDiscovery = useCallback(
    async (relayUrls?: string[]) => {
      setIsLoadingDiscovery(true)
      setDiscoveryError(null)
      try {
        if (Array.isArray(relayUrls) && relayUrls.length === 0) {
          setDiscoveryGroups([])
          return
        }

        const fetchRelayUrls = Array.isArray(relayUrls) ? relayUrls : discoveryRelays

        const [metadataEvents, relayEvents] = await Promise.all([
          client.fetchEvents(fetchRelayUrls, {
            kinds: [ExtendedKind.GROUP_METADATA],
            '#i': [HYPERPIPE_IDENTIFIER_TAG],
            since: 1764892800, // 2025-12-05T00:00:00Z - temporary cutoff to filter legacy noise
            limit: 200
          }),
          client.fetchEvents(fetchRelayUrls, {
            kinds: [KIND_HYPERPIPE_RELAY],
            '#i': [HYPERPIPE_IDENTIFIER_TAG],
            limit: 300
          })
        ])

        const hyperpipeRelayUrlById = new Map<string, string>()
        relayEvents.forEach((evt) => {
          const parsed = parseHyperpipeRelayEvent30166(evt)
          if (!parsed) return
          hyperpipeRelayUrlById.set(parsed.publicIdentifier, getBaseRelayUrl(parsed.wsUrl))
        })

        const parsed = metadataEvents.map((evt) => {
          const parsedId = parseGroupIdentifier(evt.tags.find((t) => t[0] === 'd')?.[1] ?? '')
          const meta = parseGroupMetadataEvent(evt, parsedId.relay)
          if (isHyperpipeTaggedEvent(evt)) {
            const relayUrl = hyperpipeRelayUrlById.get(meta.id)
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
    },
    [discoveryRelays]
  )

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
            isOpen: resolveInviteIsOpen(matchedInvite),
            gatewayId: matchedInvite.gatewayId,
            gatewayOrigin: matchedInvite.gatewayOrigin,
            directJoinOnly: matchedInvite.directJoinOnly,
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

  const pendingInviteCount = invites.length

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
            let gatewayId: string | null | undefined = invite.gatewayId || null
            let gatewayOrigin: string | null | undefined = invite.gatewayOrigin || null
            let directJoinOnly: boolean | undefined = invite.directJoinOnly === true
            let groupName: string | undefined = invite.groupName || invite.name
            let groupPicture: string | undefined = invite.groupPicture
            let authorizedMemberPubkeys: string[] | undefined
            let isOpen: boolean | undefined = invite.isOpen
            let fileSharing: boolean | undefined = invite.fileSharing
            let isPublic: boolean | undefined = invite.isPublic
            let blindPeer: TGroupInvite['blindPeer'] | null | undefined
            let cores: TGroupInvite['cores'] | undefined
            let discoveryTopic: string | null | undefined
            let hostPeerKeys: string[] | undefined
            let leaseReplicaPeerKeys: string[] | undefined
            let writerIssuerPubkey: string | null | undefined
            let writerLeaseEnvelope: Record<string, unknown> | null | undefined
            let gatewayAccess: TGroupGatewayAccess | null | undefined
            let writerCore: string | null | undefined
            let writerCoreHex: string | null | undefined
            let autobaseLocal: string | null | undefined
            let writerSecret: string | null | undefined
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
                if (typeof payload.gatewayId === 'string') {
                  gatewayId = payload.gatewayId.trim().toLowerCase() || null
                } else if (typeof payload.gateway_id === 'string') {
                  gatewayId = payload.gateway_id.trim().toLowerCase() || null
                }
                const payloadGatewayOrigin =
                  normalizeHttpOrigin(
                    typeof payload.gatewayOrigin === 'string' ? payload.gatewayOrigin : null
                  ) ||
                  normalizeHttpOrigin(
                    typeof payload.gateway_origin === 'string' ? payload.gateway_origin : null
                  )
                if (payloadGatewayOrigin) {
                  gatewayOrigin = payloadGatewayOrigin
                }
                if (payload.directJoinOnly === true || payload.gatewayDirectJoinOnly === true) {
                  directJoinOnly = true
                }
                if (typeof payload.isOpen === 'boolean') {
                  isOpen = payload.isOpen
                }
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
                if (typeof payload.discoveryTopic === 'string') {
                  discoveryTopic = payload.discoveryTopic
                }
                if (Array.isArray(payload.hostPeerKeys)) {
                  hostPeerKeys = normalizePubkeyList(payload.hostPeerKeys)
                }
                if (Array.isArray(payload.leaseReplicaPeerKeys)) {
                  leaseReplicaPeerKeys = normalizePubkeyList(payload.leaseReplicaPeerKeys)
                }
                if (typeof payload.writerIssuerPubkey === 'string') {
                  writerIssuerPubkey = payload.writerIssuerPubkey
                }
                if (
                  payload.writerLeaseEnvelope &&
                  typeof payload.writerLeaseEnvelope === 'object'
                ) {
                  writerLeaseEnvelope = payload.writerLeaseEnvelope as Record<string, unknown>
                }
                gatewayAccess = parseGatewayAccessPayload(
                  payload.gatewayAccess ?? payload.gateway_access
                )
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
              gatewayId,
              gatewayOrigin,
              directJoinOnly,
              isOpen,
              fileSharing,
              isPublic,
              blindPeer,
              cores,
              discoveryTopic,
              hostPeerKeys,
              leaseReplicaPeerKeys,
              writerIssuerPubkey,
              writerLeaseEnvelope,
              gatewayAccess,
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
          isOpen: resolveInviteIsOpen(invite),
          gatewayId: invite.gatewayId,
          gatewayOrigin: invite.gatewayOrigin,
          directJoinOnly: invite.directJoinOnly,
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

  const resolveLiveGroupMembershipState = useCallback(
    async (
      groupId: string,
      relay?: string,
      opts?: { preferRelay?: boolean; discoveryOnly?: boolean }
    ) => {
      const normalizedGroupId = String(groupId || '').trim()
      const relayFromList = myGroupList.find((entry) => entry.groupId === normalizedGroupId)?.relay
      const targetRelay = relay || relayFromList || undefined
      const {
        relayEntry,
        resolvedRelay,
        relayReadyForReq,
        relayWritable,
        relayHasAuthToken,
        relayLooksLoopback,
        hasActiveRelayConnection
      } = getRelayRuntimeState(normalizedGroupId, targetRelay)
      const isInMyGroups = myGroupList.some((entry) => entry.groupId === normalizedGroupId)
      let provisionalMetadata = getProvisionalGroupMetadata(
        normalizedGroupId,
        targetRelay || resolvedRelay || undefined
      )
      if (!provisionalMetadata?.event?.pubkey) {
        const hydratedMetadata = await hydratePersistedGroupMetadata(normalizedGroupId)
        if (hydratedMetadata) {
          provisionalMetadata = hydratedMetadata
        }
      }
      const creatorPubkeyHint =
        String(provisionalMetadata?.event?.pubkey || '').trim() ||
        extractCreatorPubkeyHint(normalizedGroupId) ||
        extractCreatorPubkeyHint(provisionalMetadata?.id) ||
        extractCreatorPubkeyHint(
          provisionalMetadata?.event?.tags?.find?.((tag) => tag[0] === 'd')?.[1] || null
        ) ||
        undefined
      const discoveryPrivate = discoveryGroups.some((entry) => {
        if (entry.id !== normalizedGroupId) return false
        if (entry.isPublic !== false) return false
        if (!targetRelay) return true
        if (!entry.relay) return true
        return getBaseRelayUrl(entry.relay) === getBaseRelayUrl(targetRelay)
      })
      const knownPrivateGroup = provisionalMetadata?.isPublic === false || discoveryPrivate
      const isCreator =
        !!pubkey &&
        ((!!provisionalMetadata?.event?.pubkey && provisionalMetadata.event.pubkey === pubkey) ||
          (!!creatorPubkeyHint && creatorPubkeyHint === pubkey))
      const canUseResolvedRelay =
        !opts?.discoveryOnly &&
        !!resolvedRelay &&
        (!relayLooksLoopback || hasActiveRelayConnection) &&
        (isInMyGroups || (!!opts?.preferRelay && relayHasAuthToken))
      const availableDiscoveryRelays = discoveryRelays.length
        ? discoveryRelays
        : defaultDiscoveryRelays

      const sources: GroupMembershipLiveSourceConfig[] = buildGroupMembershipSourcePlan({
        discoveryOnly: opts?.discoveryOnly,
        knownPrivateGroup,
        canUseResolvedRelay,
        resolvedRelay,
        discoveryRelays: availableDiscoveryRelays,
        relayReadyForReq
      })
      const cachedMembership = getCachedGroupMemberPreview(
        normalizedGroupId,
        resolvedRelay || relay,
        groupMemberPreviewByKeyRef.current
      )
      const persistedMembership = getPersistedGroupMembershipBaseline(
        normalizedGroupId,
        resolvedRelay || relay,
        {
          discoveryOnly: opts?.discoveryOnly
        }
      )
      const protectedState = selectPreferredMembershipState([cachedMembership, persistedMembership])

      const shadowLeaveEvents = knownPrivateGroup
        ? await fetchPrivateLeaveShadowEvents({
            groupId: normalizedGroupId,
            relayKey: relayEntry?.relayKey || null,
            publicIdentifier: relayEntry?.publicIdentifier || normalizedGroupId,
            relayUrls: defaultDiscoveryRelays,
            limit: 200
          }).catch(() => [])
        : []

      const joinRequestRelayUrls =
        canUseResolvedRelay && resolvedRelay ? [resolvedRelay] : availableDiscoveryRelays

      const { state, selectionDebug } = await resolveCanonicalGroupMembershipState({
        groupId: normalizedGroupId,
        sources,
        fetchEvents: (relayUrls, filter) => client.fetchEvents(relayUrls, filter),
        fetchJoinRequests: pubkey
          ? () =>
              client.fetchEvents(joinRequestRelayUrls, {
                kinds: [9021],
                authors: [pubkey],
                '#h': [normalizedGroupId],
                limit: 10
              })
          : undefined,
        currentPubkey: pubkey,
        isCreator,
        protectedState,
        expectCurrentPubkeyMember: isInMyGroups,
        relayReadyForReq,
        relayWritable,
        extraMembershipEvents: shadowLeaveEvents,
        extraMembershipEventsSource: shadowLeaveEvents.length ? 'discovery' : undefined
      })

      if (
        selectionDebug.usedProtectedState ||
        selectionDebug.skippedSuspiciousCandidateIds.length
      ) {
        console.warn('[GroupsProvider] Quarantined suspicious relay membership snapshot', {
          groupId: normalizedGroupId,
          relay: resolvedRelay || relay || null,
          isCreator,
          protectedStateSnapshotId: selectionDebug.protectedStateSnapshotId,
          skippedSuspiciousCandidateIds: selectionDebug.skippedSuspiciousCandidateIds,
          chosenSnapshotId: state.selectedSnapshotId,
          chosenSnapshotSource: state.selectedSnapshotSource,
          chosenMemberCount: state.memberCount,
          candidates: selectionDebug.candidates
        })
      }

      return {
        state,
        relayEntry,
        resolvedRelay,
        isInMyGroups,
        knownPrivateGroup,
        relayHasAuthToken,
        isCreator
      }
    },
    [
      discoveryGroups,
      discoveryRelays,
      fetchPrivateLeaveShadowEvents,
      getCachedGroupMemberPreview,
      getPersistedGroupMembershipBaseline,
      getProvisionalGroupMetadata,
      getRelayRuntimeState,
      hydratePersistedGroupMetadata,
      myGroupList,
      pubkey
    ]
  )

  const resolveAndApplyGroupMembershipState = useCallback(
    async (
      groupId: string,
      relay?: string,
      opts?: {
        preferRelay?: boolean
        discoveryOnly?: boolean
        reason?: string
        persist?: boolean
        isActiveGroup?: boolean
        persistDiscover?: boolean
      }
    ) => {
      const normalizedGroupId = String(groupId || '').trim()
      const resolved = await resolveLiveGroupMembershipState(normalizedGroupId, relay, opts)
      const cachedMembership = getCachedGroupMemberPreview(
        normalizedGroupId,
        resolved.resolvedRelay || relay,
        groupMemberPreviewByKeyRef.current
      )
      const persistedMembership = getPersistedGroupMembershipBaseline(
        normalizedGroupId,
        resolved.resolvedRelay || relay,
        {
          discoveryOnly: opts?.discoveryOnly
        }
      )
      const protectionBaseline = selectPreferredMembershipState([
        cachedMembership,
        persistedMembership
      ])
      const nextVisibleState = isSuspiciousCreatorSelfMembershipDowngrade({
        currentState: protectionBaseline,
        incomingState: resolved.state,
        currentPubkey: pubkey,
        isCreator: resolved.isCreator
      })
        ? protectionBaseline
        : resolved.state
      if (nextVisibleState !== resolved.state) {
        console.warn(
          '[GroupsProvider] Preserving cached membership over suspicious creator self-only relay state',
          {
            groupId: normalizedGroupId,
            relay: resolved.resolvedRelay || relay || null,
            cachedMemberCount: protectionBaseline?.memberCount || 0,
            incomingMemberCount: resolved.state.memberCount,
            incomingSource: resolved.state.hydrationSource
          }
        )
      }
      const visibleState = applyGroupMembershipState(
        normalizedGroupId,
        resolved.resolvedRelay || relay,
        nextVisibleState,
        {
          persist: opts?.persist !== false,
          isJoinedGroup: resolved.isInMyGroups,
          isActiveGroup: opts?.isActiveGroup === true,
          persistDiscover: opts?.persistDiscover === true,
          discoveryOnly: opts?.discoveryOnly === true
        }
      )

      return {
        ...resolved,
        visibleState: visibleState || nextVisibleState || resolved.state
      }
    },
    [
      applyGroupMembershipState,
      getCachedGroupMemberPreview,
      getPersistedGroupMembershipBaseline,
      pubkey,
      resolveLiveGroupMembershipState
    ]
  )

  const fetchGroupDetail = useCallback(
    async (
      groupId: string,
      relay?: string,
      opts?: { preferRelay?: boolean; discoveryOnly?: boolean }
    ) => {
      const relayFromList = myGroupList.find((entry) => entry.groupId === groupId)?.relay
      const targetRelay = relay || relayFromList || undefined
      const {
        resolvedRelay: resolved,
        relayHasAuthToken,
        hasActiveRelayConnection,
        relayLooksLoopback
      } = getRelayRuntimeState(groupId, targetRelay)
      const isInMyGroups = myGroupList.some((entry) => entry.groupId === groupId)
      const preferRelay =
        !opts?.discoveryOnly &&
        !!resolved &&
        (!relayLooksLoopback || hasActiveRelayConnection) &&
        (isInMyGroups || (!!opts?.preferRelay && relayHasAuthToken))
      let provisionalMetadata = getProvisionalGroupMetadata(
        groupId,
        targetRelay || resolved || undefined
      )
      if (!provisionalMetadata?.event?.pubkey) {
        const hydratedMetadata = await hydratePersistedGroupMetadata(groupId)
        if (hydratedMetadata) {
          provisionalMetadata = hydratedMetadata
        }
      }
      const discoveryPrivate = discoveryGroups.some((entry) => {
        if (entry.id !== groupId) return false
        if (entry.isPublic !== false) return false
        if (!targetRelay) return true
        if (!entry.relay) return true
        return getBaseRelayUrl(entry.relay) === getBaseRelayUrl(targetRelay)
      })
      const knownPrivateGroup = provisionalMetadata?.isPublic === false || discoveryPrivate

      // Default: discovery only for list/facepile; if member/admin, stick to the resolved group relay only.
      const availableDiscoveryRelays = discoveryRelays.length
        ? discoveryRelays
        : defaultDiscoveryRelays
      const groupRelays = preferRelay && resolved ? [resolved] : availableDiscoveryRelays
      const resolvedRelayList = resolved ? [resolved] : []
      const metadataRelays = opts?.discoveryOnly
        ? availableDiscoveryRelays
        : (preferRelay && resolved) || (knownPrivateGroup && resolved)
          ? [resolved]
          : Array.from(new Set([...resolvedRelayList, ...availableDiscoveryRelays]))
      const adminRelays = opts?.discoveryOnly
        ? availableDiscoveryRelays
        : knownPrivateGroup
          ? groupRelays
          : Array.from(new Set([...resolvedRelayList, ...availableDiscoveryRelays]))

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
          return await fetchLatestByTags(adminRelays, 39001, ['d', 'h'])
        } catch (_e) {
          return null
        }
      })()
      const membershipPromise = resolveAndApplyGroupMembershipState(groupId, targetRelay, {
        preferRelay: opts?.preferRelay,
        discoveryOnly: opts?.discoveryOnly,
        reason: 'fetch-group-detail',
        isActiveGroup: true
      })

      const [metadataEvt, adminsEvt, membershipResult] = await Promise.all([
        metadataPromise,
        adminsPromise,
        membershipPromise
      ])

      let membershipState = membershipResult.visibleState
      const groupIdPubkey =
        extractCreatorPubkeyHint(groupId) ||
        extractCreatorPubkeyHint(metadataEvt?.tags?.find((t) => t[0] === 'd')?.[1] || null) ||
        undefined
      const creatorPubkey = metadataEvt?.pubkey
      const isCreator =
        !!pubkey &&
        ((!!creatorPubkey && creatorPubkey === pubkey) ||
          (!!groupIdPubkey && groupIdPubkey === pubkey))
      const creatorProtectionBaseline = selectPreferredMembershipState([
        getCachedGroupMemberPreview(
          groupId,
          resolved || targetRelay || undefined,
          groupMemberPreviewByKeyRef.current
        ),
        getPersistedGroupMembershipBaseline(groupId, resolved || targetRelay || undefined)
      ])
      if (
        isSuspiciousCreatorSelfMembershipDowngrade({
          currentState: creatorProtectionBaseline,
          incomingState: membershipState,
          currentPubkey: pubkey,
          isCreator
        }) &&
        creatorProtectionBaseline
      ) {
        console.warn(
          '[GroupsProvider] Corrected creator self-only membership detail with protected baseline',
          {
            groupId,
            relay: resolved || targetRelay || null,
            incomingSnapshotId: membershipState.selectedSnapshotId,
            incomingMemberCount: membershipState.memberCount,
            baselineSnapshotId: creatorProtectionBaseline.selectedSnapshotId,
            baselineMemberCount: creatorProtectionBaseline.memberCount
          }
        )
        membershipState = creatorProtectionBaseline
      }
      let coercedMembershipStatus =
        membershipState.membershipStatus === 'not-member' &&
        pubkey &&
        membershipState.members.includes(pubkey)
          ? 'member'
          : membershipState.membershipStatus

      // If this group is in my list, default to member unless explicitly removed
      if (coercedMembershipStatus === 'not-member' && isInMyGroups) {
        coercedMembershipStatus = 'member'
      }
      if (isCreator) {
        coercedMembershipStatus = 'member'
      }

      // If we believe we're a member but members list is empty, include self so UI doesn't zero out
      let members = normalizePubkeyList(membershipState.members)
      if (coercedMembershipStatus === 'member' && pubkey) {
        if (!members.includes(pubkey)) members = [...members, pubkey]
      }

      const membersSnapshotCreatedAt = membershipState.membersSnapshotCreatedAt
      const membersFromEventCount = membershipState.membersFromEventCount
      const membershipEventsCount = membershipState.membershipEventsCount
      const membershipAuthoritative = membershipState.quality === 'complete'
      const membershipFetchTimedOutLike = membershipState.membershipFetchTimedOutLike
      const membershipFetchSource = membershipState.membershipFetchSource

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
          gatewayId: metadata.gatewayId,
          gatewayOrigin: metadata.gatewayOrigin,
          directJoinOnly: metadata.directJoinOnly,
          createdAt: metadata.event?.created_at,
          creatorPubkey: metadataEvt.pubkey,
          event: metadataEvt,
          source: 'update'
        })
        persistGroupMetadata(
          {
            ...metadata,
            relay: resolved || targetRelay || metadata.relay
          },
          resolved || targetRelay || undefined
        ).catch(() => {})
      }

      const shouldInjectCreatorAdmin = isCreator && pubkey && admins.length === 0
      if (shouldInjectCreatorAdmin) {
        console.warn('[GroupsProvider] creator detected but no admin snapshot; injecting self', {
          groupId,
          relay: resolved || targetRelay || null
        })
        admins = [{ pubkey, roles: ['admin'] }]
      }

      console.info('[GroupsProvider] membership derivation', {
        groupId,
        relay: targetRelay,
        membershipEventsCount,
        initialStatus: membershipState.membershipStatus,
        membersFromEventCount,
        membersSnapshotCreatedAt,
        membersSnapshotId: membershipState.selectedSnapshotId,
        resolvedMembersCount: membershipState.members.length,
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
        membershipFetchSource,
        membership: createGroupMembershipState({
          ...membershipState,
          members,
          membershipStatus: coercedMembershipStatus
        })
      }
    },
    [
      discoveryGroups,
      discoveryRelays,
      getCachedGroupMemberPreview,
      getPersistedGroupMembershipBaseline,
      getProvisionalGroupMetadata,
      getRelayRuntimeState,
      hydratePersistedGroupMetadata,
      myGroupList,
      persistGroupMetadata,
      pubkey,
      resolveAndApplyGroupMembershipState,
      resolveRelayUrl,
      upsertProvisionalGroupMetadata
    ]
  )

  const getGroupMemberPreview = useCallback(
    (groupId: string, relay?: string) => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) return null
      const cacheKeys = getGroupMembershipCacheKeys(normalizedGroupId, relay)
      return selectPreferredMembershipState(
        cacheKeys.map((cacheKey) => groupMemberPreviewByKey[cacheKey] || null)
      )
    },
    [getGroupMembershipCacheKeys, groupMemberPreviewByKey]
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
      const ttlMs =
        cached?.quality === 'complete'
          ? GROUP_MEMBER_PREVIEW_TTL_MS
          : GROUP_MEMBER_PREVIEW_INCOMPLETE_TTL_MS
      if (!opts?.force && cached && now - cached.updatedAt < ttlMs) {
        return cached.members
      }

      const inFlightKey = `${relayCacheKey}|${opts?.force ? 'force' : 'normal'}`
      const existingPromise = groupMemberPreviewInFlightRef.current.get(inFlightKey)
      if (existingPromise) return existingPromise

      const fetchPromise = (async () => {
        try {
          const resolved = await resolveAndApplyGroupMembershipState(normalizedGroupId, relay, {
            discoveryOnly: !isMyGroup,
            preferRelay: true,
            reason,
            persist: true,
            persistDiscover: !isMyGroup && reason === 'groups-page-row-list'
          })
          console.info('[GroupsProvider] Refreshed member preview cache', {
            groupId: normalizedGroupId,
            relay: relay || null,
            reason,
            membersCount: resolved.visibleState.members.length,
            isMember: resolved.isInMyGroups,
            source: resolved.visibleState.membershipFetchSource,
            membershipAuthoritative: resolved.visibleState.quality === 'complete'
          })
          return resolved.visibleState.members
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
    [myGroupList, resolveAndApplyGroupMembershipState]
  )

  const tokenizedPreviewRefreshByGroupRef = useRef<Map<string, string>>(new Map())
  const tokenizedPreviewLastRefreshByGroupRef = useRef<Map<string, number>>(new Map())

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
    const now = Date.now()

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
      const lastRefreshAt = tokenizedPreviewLastRefreshByGroupRef.current.get(entry.groupId) || 0
      const withinCooldown = now - lastRefreshAt < TOKENIZED_RELAY_REFRESH_MIN_INTERVAL_MS
      if (prevRelay === resolvedRelay) return
      if (withinCooldown) {
        console.info('[GroupsProvider] tokenized relay refresh suppressed by cooldown', {
          groupId: entry.groupId,
          relay: resolvedRelay,
          lastRefreshAgoMs: now - lastRefreshAt
        })
        return
      }

      console.info('[GroupsProvider] tokenized relay observed; forcing member preview refresh', {
        groupId: entry.groupId,
        relay: resolvedRelay
      })
      tokenizedPreviewLastRefreshByGroupRef.current.set(entry.groupId, now)

      refreshGroupMemberPreview(entry.groupId, resolvedRelay, {
        force: true,
        reason: 'worker-relay-tokenized-update'
      }).catch(() => {})
    })

    tokenizedPreviewRefreshByGroupRef.current = nextByGroup
    const nextRefreshAt = new Map<string, number>()
    nextByGroup.forEach((_relay, groupId) => {
      const refreshAt = tokenizedPreviewLastRefreshByGroupRef.current.get(groupId)
      if (Number.isFinite(refreshAt)) {
        nextRefreshAt.set(groupId, Number(refreshAt))
      }
    })
    tokenizedPreviewLastRefreshByGroupRef.current = nextRefreshAt
  }, [myGroupList, pubkey, refreshGroupMemberPreview, resolveRelayUrl, workerRelays])

  const republishMemberSnapshot39002 = useCallback(
    async (params: {
      groupId: string
      relay?: string
      isPublicGroup?: boolean
      reason: string
      ensureMemberPubkey?: string
      waitForVerification?: boolean
    }) => {
      const {
        groupId,
        relay,
        isPublicGroup,
        reason,
        ensureMemberPubkey,
        waitForVerification = true
      } = params
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      let members: string[] = []
      let resolvedIsPublic = typeof isPublicGroup === 'boolean' ? isPublicGroup : true
      try {
        const cachedMembership =
          getGroupMemberPreview(groupId, resolved || relay || undefined) ||
          getGroupMemberPreview(groupId)
        const liveMembership =
          cachedMembership?.quality === 'complete'
            ? cachedMembership
            : (
                await resolveAndApplyGroupMembershipState(groupId, relay, {
                  preferRelay: true,
                  reason: `republish-39002:${reason}`,
                  persist: true
                })
              ).visibleState
        if (!liveMembership || liveMembership.quality !== 'complete') {
          console.warn('[GroupsProvider] Skipping 39002 republish: membership not complete', {
            groupId,
            relay,
            reason,
            quality: liveMembership?.quality || null
          })
          return
        }
        members = normalizePubkeyList(liveMembership.members || [])
        if (ensureMemberPubkey) {
          members = normalizePubkeyList([...members, ensureMemberPubkey])
        }
        if (typeof isPublicGroup !== 'boolean') {
          const detail = await fetchGroupDetail(groupId, relay, { preferRelay: true })
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
        tags.push(['hyperpipe', groupId], ['i', HYPERPIPE_IDENTIFIER_TAG])
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

      logGroupSnapshotPublishAttempt({
        reason: `republish-39002:${reason}`,
        groupId,
        event: membersEvent,
        relayUrls
      })
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

      const runVerification = async () => {
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
          postPublishMembersCount = Array.isArray(postDetail?.members)
            ? postDetail.members.length
            : 0
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
      }

      if (!waitForVerification) {
        void runVerification()
        return
      }

      await runVerification()
    },
    [
      fetchGroupDetail,
      getGroupMemberPreview,
      invalidateGroupMemberPreview,
      publish,
      refreshGroupMemberPreview,
      resolveAndApplyGroupMembershipState,
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
            baseTags.push(['hyperpipe', groupId], ['i', HYPERPIPE_IDENTIFIER_TAG])
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
            logGroupSnapshotPublishAttempt({
              reason: 'leave-group-admin-snapshot:admins',
              groupId,
              event: adminsEvent,
              relayUrls: snapshotRelayUrls
            })
            logGroupSnapshotPublishAttempt({
              reason: 'leave-group-admin-snapshot:members',
              groupId,
              event: membersEvent,
              relayUrls: snapshotRelayUrls
            })
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

      patchGroupMembershipOptimistically(
        groupId,
        resolvedRelay || relayFromList || relay || undefined,
        (currentMembers) => currentMembers.filter((memberPubkey) => memberPubkey !== pubkey),
        {
          membershipStatus: 'removed',
          isJoinedGroup: false
        }
      )
      deletePersistedGroupMembershipState(
        groupId,
        resolvedRelay || relayFromList || relay || undefined
      ).catch(() => {})

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
      myGroupList,
      patchGroupMembershipOptimistically,
      publish,
      pubkey,
      deletePersistedGroupMembershipState,
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
          patchGroupMembershipOptimistically(
            identifier,
            baseUrl,
            (currentMembers) => normalizePubkeyList([...currentMembers, pubkey]),
            {
              membershipStatus: 'member',
              isJoinedGroup: true
            }
          )
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
            gatewayId: metadata.gatewayId,
            gatewayOrigin: metadata.gatewayOrigin,
            directJoinOnly: metadata.directJoinOnly,
            createdAt: metadata.event?.created_at,
            creatorPubkey: metadata.event?.pubkey,
            event: metadata.event,
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

      const flowUpdatedAt =
        typeof flow.updatedAt === 'number'
          ? flow.updatedAt
          : typeof flow.startedAt === 'number'
            ? flow.startedAt
            : 0
      const relayEntry = getRelayEntryForGroup(identifier)
      const hasActiveRelayConnection = !!(
        relayEntry &&
        relayEntry.isActive !== false &&
        relayEntry.connectionUrl
      )
      const isFreshFlow =
        flowUpdatedAt > 0 ? Date.now() - flowUpdatedAt <= JOIN_FLOW_SUCCESS_FRESH_MS : false
      if (!hasActiveRelayConnection && !isFreshFlow) {
        processedJoinFlowsRef.add(identifier)
        return
      }

      const relayUrl = relayEntry?.connectionUrl || flow.relayUrl
      if (typeof relayUrl !== 'string' || !relayUrl) return
      const resolvedRelayUrl = resolveRelayUrl(relayUrl) || relayUrl
      const baseUrl = getBaseRelayUrl(resolvedRelayUrl)
      if (!baseUrl) return

      announceOpenJoinMembership(flow, baseUrl)

      const existing = myGroupList.find((e) => e.groupId === identifier) || null
      const existingBaseRelay = existing?.relay ? getBaseRelayUrl(existing.relay) : null
      const already = existingBaseRelay === baseUrl
      if (already) {
        processedJoinFlowsRef.add(identifier)
        hydrateProvisionalFromRelay(identifier, baseUrl)
        patchGroupMembershipOptimistically(
          identifier,
          baseUrl,
          (currentMembers) => normalizePubkeyList([...currentMembers, pubkey]),
          {
            membershipStatus: 'member',
            isJoinedGroup: true
          }
        )
        invalidateGroupMemberPreview(identifier, baseUrl, { reason: 'join-flow-success-existing' })
        refreshGroupMemberPreview(identifier, baseUrl, {
          force: true,
          reason: 'join-flow-success-existing'
        }).catch(() => {})
        return
      }

      processedJoinFlowsRef.add(identifier)
      hydrateProvisionalFromRelay(identifier, baseUrl)
      const updated = [
        ...myGroupList.filter((entry) => entry.groupId !== identifier),
        { groupId: identifier, relay: baseUrl }
      ]
      saveMyGroupList(updated, { specifiedRelayUrls: BIG_RELAY_URLS }).catch(() => {})
      patchGroupMembershipOptimistically(
        identifier,
        baseUrl,
        (currentMembers) => normalizePubkeyList([...currentMembers, pubkey]),
        {
          membershipStatus: 'member',
          isJoinedGroup: true
        }
      )
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
    patchGroupMembershipOptimistically,
    invalidateGroupMemberPreview,
    joinFlows,
    myGroupList,
    processedJoinFlowsRef,
    pubkey,
    publish,
    republishMemberSnapshot39002,
    refreshGroupMemberPreview,
    resolveRelayUrl,
    saveMyGroupList,
    getRelayEntryForGroup,
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
        hyperpipeFound: false,
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
            hyperpipeByH
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
          state.hyperpipeFound = hyperpipeByH.length > 0
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

  const createHyperpipeRelayGroup = useCallback(
    async (
      {
        name,
        about,
        isPublic,
        isOpen,
        picture,
        fileSharing,
        gatewayOrigin,
        gatewayId,
        gatewayAuthMethod,
        gatewayDelegation,
        gatewaySponsorPubkey,
        directJoinOnly
      }: {
        name: string
        about?: string
        isPublic: boolean
        isOpen: boolean
        picture?: string
        fileSharing?: boolean
        gatewayOrigin?: string | null
        gatewayId?: string | null
        gatewayAuthMethod?: string | null
        gatewayDelegation?: string | null
        gatewaySponsorPubkey?: string | null
        directJoinOnly?: boolean
      },
      options?: {
        onProgress?: (state: CreateGroupProgressState) => void
      }
    ) => {
      const reportProgress = (state: CreateGroupProgressState) => {
        options?.onProgress?.(state)
      }

      try {
        if (!pubkey) throw new Error('Not logged in')
        const normalizedGatewayOrigin = normalizeHttpOrigin(gatewayOrigin || null)
        const normalizedGatewayId =
          typeof gatewayId === 'string' && gatewayId.trim() ? gatewayId.trim().toLowerCase() : null
        const normalizedDirectJoinOnly = directJoinOnly === true

        reportProgress({ phase: 'creatingRelay' })
        const result = await createRelay({
          name,
          description: about || undefined,
          isPublic,
          isOpen,
          fileSharing,
          picture,
          gatewayOrigin: normalizedGatewayOrigin,
          gatewayId: normalizedGatewayId,
          directJoinOnly: normalizedDirectJoinOnly
        })
        if (!result?.success) throw new Error(result?.error || 'Failed to create relay')

        const publicIdentifier = result.publicIdentifier
        const authenticatedRelayUrl = result.relayUrl
        const relayKey = result.relayKey || null
        if (!publicIdentifier || !authenticatedRelayUrl) {
          throw new Error('Worker did not return a publicIdentifier/relayUrl')
        }

        const relayWsUrl = getBaseRelayUrl(authenticatedRelayUrl)
        const discoveryTopic =
          typeof result.discoveryTopic === 'string' && result.discoveryTopic.trim()
            ? result.discoveryTopic.trim()
            : null
        const hostPeerKeys = normalizePubkeyList(result.hostPeerKeys || [])
        const leaseReplicaPeerKeys = normalizePubkeyList(result.leaseReplicaPeerKeys || [])
        const writerIssuerPubkey =
          typeof result.writerIssuerPubkey === 'string' && result.writerIssuerPubkey.trim()
            ? result.writerIssuerPubkey.trim()
            : null
        upsertProvisionalGroupMetadata({
          groupId: publicIdentifier,
          relay: relayWsUrl,
          name,
          about,
          picture,
          isPublic,
          isOpen,
          gatewayId: normalizedGatewayId,
          gatewayOrigin: normalizedGatewayOrigin,
          directJoinOnly: normalizedDirectJoinOnly,
          creatorPubkey: pubkey,
          source: 'create'
        })

        const { groupCreateEvent, metadataEvent, hyperpipeEvent } =
          buildHyperpipeDiscoveryDraftEvents({
            publicIdentifier,
            name,
            about,
            isPublic,
            isOpen,
            fileSharing,
            relayWsUrl,
            pictureTagUrl: picture,
            gatewayOrigin: normalizedGatewayOrigin,
            gatewayId: normalizedGatewayId,
            gatewayAuthMethod,
            gatewayDelegation,
            gatewaySponsorPubkey,
            directJoinOnly: normalizedDirectJoinOnly,
            discoveryTopic,
            hostPeerKeys,
            leaseReplicaPeerKeys,
            writerIssuerPubkey
          })
        persistGroupMetadata(
          createProvisionalGroupMetadata({
            groupId: publicIdentifier,
            relay: relayWsUrl,
            name,
            about,
            picture,
            isPublic,
            isOpen,
            gatewayId: normalizedGatewayId,
            gatewayOrigin: normalizedGatewayOrigin,
            directJoinOnly: normalizedDirectJoinOnly,
            createdAt: metadataEvent.created_at,
            creatorPubkey: pubkey
          }),
          relayWsUrl
        ).catch(() => {})
        const { adminListEvent, memberListEvent } = buildHyperpipeAdminBootstrapDraftEvents({
          publicIdentifier,
          adminPubkeyHex: pubkey,
          name
        })

        if (isPublic) {
          reportProgress({ phase: 'publishingDiscovery' })
          await Promise.all([
            publish(groupCreateEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
            publish(metadataEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
            publish(hyperpipeEvent, { specifiedRelayUrls: BIG_RELAY_URLS })
          ])
        }

        reportProgress({ phase: 'savingGroupList' })
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
          resolveRelayUrl(workerBootstrap?.relayWsUrl || authenticatedRelayUrl) ||
          authenticatedRelayUrl
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

        reportProgress({ phase: 'verifyingBootstrap' })
        let bootstrapRelayUrl = workerBootstrapRelayUrl
        const workerVerification = await verifyGroupRelayBootstrapState({
          groupId: publicIdentifier,
          relayUrl: workerBootstrapRelayUrl,
          maxAttempts: workerBootstrap?.status === 'success' ? 8 : 4,
          delayMs: 450
        })

        if (!workerVerification.ok) {
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
            events: [
              groupCreateEvent,
              metadataEvent,
              hyperpipeEvent,
              adminListEvent,
              memberListEvent
            ]
          })
        }

        console.info('[GroupsProvider] create bootstrap verify complete', {
          groupId: publicIdentifier,
          relayKey,
          relayUrl: bootstrapRelayUrl,
          source: workerVerification.ok ? 'worker' : 'renderer-fallback',
          metadataFound: workerVerification.metadataFound,
          membersFound: workerVerification.membersFound,
          adminsFound: workerVerification.adminsFound
        })

        reportProgress({ phase: 'publishingMembershipSnapshots' })
        // Bootstrap admin/member snapshots on the group relay.
        const membershipSnapshotTargets = isPublic
          ? Array.from(new Set([bootstrapRelayUrl, ...BIG_RELAY_URLS]))
          : [bootstrapRelayUrl]
        logGroupSnapshotPublishAttempt({
          reason: 'create-hyperpipe-group:bootstrap-admins',
          groupId: publicIdentifier,
          event: adminListEvent,
          relayUrls: membershipSnapshotTargets
        })
        logGroupSnapshotPublishAttempt({
          reason: 'create-hyperpipe-group:bootstrap-members',
          groupId: publicIdentifier,
          event: memberListEvent,
          relayUrls: membershipSnapshotTargets
        })
        await Promise.all([
          publish(adminListEvent, { specifiedRelayUrls: membershipSnapshotTargets }),
          publish(memberListEvent, { specifiedRelayUrls: membershipSnapshotTargets })
        ])

        reportProgress({ phase: 'success' })
        return { groupId: publicIdentifier, relay: relayWsUrl }
      } catch (error) {
        reportProgress({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    },
    [
      createRelay,
      myGroupList,
      persistGroupMetadata,
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
      const initialResolvedIsOpen =
        typeof options?.isOpen === 'boolean' ? options.isOpen : meta?.isOpen
      const initialGatewayOrigin = normalizeHttpOrigin(
        ((meta as TGroupMetadata & TGroupMetadataDiscoveryHints | null)?.gatewayOrigin) || null
      )
      const shouldRefreshClosedInviteMetadata =
        initialResolvedIsOpen === false &&
        (!initialGatewayOrigin || isLoopbackHttpOrigin(initialGatewayOrigin))
      if (shouldRefreshClosedInviteMetadata) {
        try {
          const detail = await fetchGroupDetail(groupId, resolved || relay || undefined, {
            preferRelay: true
          })
          if (detail?.metadata) {
            meta = detail.metadata
          }
        } catch (_err) {
          // Best-effort only.
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
      const inviteRelayKey = relayEntry?.relayKey || extractRelayKeyFromUrl(inviteRelayUrl) || null
      const metadataHints = meta as (TGroupMetadata & TGroupMetadataDiscoveryHints) | null
      const gatewayId =
        typeof metadataHints?.gatewayId === 'string' && metadataHints.gatewayId.trim()
          ? metadataHints.gatewayId.trim().toLowerCase()
          : null
      const gatewayOrigin = normalizeHttpOrigin(metadataHints?.gatewayOrigin || null)
      const gatewayAuthMethod =
        typeof metadataHints?.gatewayAuthMethod === 'string' &&
        metadataHints.gatewayAuthMethod.trim()
          ? metadataHints.gatewayAuthMethod.trim()
          : null
      const directJoinOnly = metadataHints?.directJoinOnly === true
      const discoveryTopic =
        typeof metadataHints?.discoveryTopic === 'string' && metadataHints.discoveryTopic.trim()
          ? metadataHints.discoveryTopic.trim()
          : null
      const hostPeerKeys = Array.isArray(metadataHints?.hostPeerKeys)
        ? metadataHints.hostPeerKeys
            .map((entry: string) => String(entry || '').trim())
            .filter(Boolean)
        : []
      const metadataLeaseReplicaPeerKeys = Array.isArray(metadataHints?.leaseReplicaPeerKeys)
        ? metadataHints.leaseReplicaPeerKeys
            .map((entry: string) => String(entry || '').trim())
            .filter(Boolean)
        : []
      const metadataWriterIssuerPubkey =
        typeof metadataHints?.writerIssuerPubkey === 'string' &&
        metadataHints.writerIssuerPubkey.trim()
          ? metadataHints.writerIssuerPubkey.trim()
          : null
      if (!isOpenGroup && !inviteRelayKey) {
        console.warn('[GroupsProvider] Missing relayKey for closed invite payload', {
          groupId,
          relayUrl: inviteRelayUrl ? String(inviteRelayUrl).slice(0, 80) : null
        })
      }

      const provisionWriterInfo = async (invitee: string, token: string | null) => {
        if (isOpenGroup) return null
        if (!sendToWorker || !relayEntry?.relayKey) return null
        try {
          const res = await sendToWorker({
            type: 'provision-writer-for-invitee',
            data: {
              relayKey: relayEntry.relayKey,
              publicIdentifier: groupId,
              inviteePubkey: invitee,
              token: token || undefined,
              leaseReplicaPeerKeys: metadataLeaseReplicaPeerKeys,
              useWriterPool: true
            }
          })
          if (res && typeof res === 'object') {
            const writerInfo = {
              writerCore: (res as any).writerCore,
              writerCoreHex: (res as any).writerCoreHex,
              autobaseLocal: (res as any).autobaseLocal,
              writerSecret: (res as any).writerSecret,
              poolCoreRefs: Array.isArray((res as any).poolCoreRefs)
                ? (res as any).poolCoreRefs
                : undefined,
              fastForward: (res as any).fastForward || null,
              writerLeaseEnvelope:
                (res as any).writerLeaseEnvelope &&
                typeof (res as any).writerLeaseEnvelope === 'object'
                  ? (res as any).writerLeaseEnvelope
                  : null,
              leaseReplicaPeerKeys: Array.isArray((res as any).leaseReplicaPeerKeys)
                ? (res as any).leaseReplicaPeerKeys
                : [],
              writerIssuerPubkey:
                typeof (res as any).writerIssuerPubkey === 'string'
                  ? (res as any).writerIssuerPubkey
                  : null
            }
            console.info('[GroupsProvider] Writer provisioning result (invite)', {
              groupId,
              invitee,
              relayKey: relayEntry.relayKey,
              hasWriterCore: !!writerInfo?.writerCore,
              hasWriterCoreHex: !!writerInfo?.writerCoreHex,
              hasAutobaseLocal: !!writerInfo?.autobaseLocal,
              hasWriterSecret: !!writerInfo?.writerSecret,
              hasWriterLeaseEnvelope: !!writerInfo?.writerLeaseEnvelope,
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

      const baseMirrorMetadataPromise: Promise<InviteMirrorMetadata> = !isOpenGroup
        ? fetchInviteMirrorMetadata(inviteRelayKey || relayEntry?.relayKey || groupId, {
            gatewayOrigin,
            resolved
          })
        : Promise.resolve(null)

      const buildInviteMirrorMetadata = async (
        writerInfo: {
          writerCore?: string
          writerCoreHex?: string
          autobaseLocal?: string
          writerSecret?: string
          poolCoreRefs?: string[]
          writerLeaseEnvelope?: Record<string, unknown> | null
          leaseReplicaPeerKeys?: string[]
          writerIssuerPubkey?: string | null
        } | null
      ) => {
        if (isOpenGroup) return null
        const baseMirrorMetadata = await baseMirrorMetadataPromise
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
          const inviteTrace = `${groupId}:${String(invitee).slice(0, 16)}`
          let stage = 'init'
          try {
            const token = isOpenGroup ? null : randomString(24)
            stage = 'provision-writer'
            const writerInfo = await provisionWriterInfo(invitee, token)

            let gatewayAccess: TGroupGatewayAccess | null = null
            if (
              !isOpenGroup &&
              gatewayAuthMethod === 'relay-scoped-bearer-v1' &&
              !directJoinOnly &&
              !!gatewayOrigin &&
              !!inviteRelayKey &&
              !!sendToWorker
            ) {
              stage = 'authorize-relay-member-access:request'
              gatewayAccess = (await sendToWorker({
                type: 'authorize-relay-member-access',
                data: {
                  relayKey: inviteRelayKey,
                  publicIdentifier: groupId,
                  subjectPubkey: invitee,
                  gatewayOrigin,
                  gatewayId,
                  scopes: DEFAULT_GATEWAY_MEMBER_SCOPES
                }
              })) as TGroupGatewayAccess
            }

            stage = 'build-invite-mirror-metadata'
            const inviteMirrorMetadata = await buildInviteMirrorMetadata(writerInfo)

            stage = 'build-invite-payload'
            const payload = isOpenGroup
              ? buildOpenInvitePayload({
                  relayUrl: inviteRelayUrl,
                  relayKey: inviteRelayKey,
                  gatewayId,
                  gatewayOrigin,
                  directJoinOnly,
                  discoveryTopic,
                  hostPeerKeys,
                  leaseReplicaPeerKeys: metadataLeaseReplicaPeerKeys,
                  writerIssuerPubkey: metadataWriterIssuerPubkey,
                  groupName: inviteName,
                  groupPicture: invitePicture,
                  authorizedMemberPubkeys: baseAuthorizedMemberPubkeys,
                  gatewayAccess
                })
              : buildInvitePayload({
                  token: token as string,
                  relayUrl: inviteRelayUrl,
                  relayKey: inviteRelayKey,
                  gatewayId,
                  gatewayOrigin,
                  directJoinOnly,
                  meta,
                  groupName: inviteName,
                  groupPicture: invitePicture,
                  authorizedMemberPubkeys: normalizePubkeyList([
                    ...baseAuthorizedMemberPubkeys,
                    invitee
                  ]),
                  discoveryTopic,
                  hostPeerKeys,
                  leaseReplicaPeerKeys: Array.isArray(writerInfo?.leaseReplicaPeerKeys)
                    ? writerInfo.leaseReplicaPeerKeys
                    : metadataLeaseReplicaPeerKeys,
                  writerIssuerPubkey: writerInfo?.writerIssuerPubkey || metadataWriterIssuerPubkey,
                  writerLeaseEnvelope: writerInfo?.writerLeaseEnvelope || null,
                  mirrorMetadata: inviteMirrorMetadata,
                  writerInfo,
                  fastForward: writerInfo?.fastForward || null,
                  gatewayAccess
                })

            stage = 'encrypt-invite-payload'
            const encryptedPayload = await nip04Encrypt(invitee, JSON.stringify(payload))
            const inviteTags: string[][] = [
              ['h', groupId],
              ['p', invitee],
              ['i', 'hyperpipe']
            ]
            if (inviteName) inviteTags.push(['name', inviteName])
            if (inviteAbout) inviteTags.push(['about', inviteAbout])
            if (invitePicture) inviteTags.push(['picture', invitePicture])
            if (isOpenGroup) inviteTags.push(['open'])
            if (gatewayId) inviteTags.push([HYPERPIPE_GATEWAY_ID_TAG, gatewayId])
            if (gatewayOrigin) inviteTags.push([HYPERPIPE_GATEWAY_ORIGIN_TAG, gatewayOrigin])
            if (directJoinOnly) inviteTags.push([HYPERPIPE_DIRECT_JOIN_ONLY_TAG, '1'])
            inviteTags.push([resolvedIsOpen === false ? 'file-sharing-off' : 'file-sharing-on'])

            if (!isOpenGroup && token) {
              stage = 'publish-9000'
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

            stage = 'publish-9009'
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
                  stage = 'update-local-member-state'
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
          } catch (err) {
            console.error('[GroupsProvider] sendInvites invitee failed', {
              inviteTrace,
              stage,
              err: err instanceof Error ? err.message : err,
              relayKey: inviteRelayKey ? String(inviteRelayKey).slice(0, 16) : null,
              gatewayOrigin,
              gatewayId,
              gatewayAuthMethod
            })
            throw err
          }
        })
      )

      patchGroupMembershipOptimistically(
        groupId,
        resolved || relay || undefined,
        (currentMembers) => normalizePubkeyList([...currentMembers, ...invitees]),
        {
          membershipStatus: 'member',
          isJoinedGroup: true
        }
      )

      if (!isOpenGroup) {
        await republishMemberSnapshot39002({
          groupId,
          relay: resolved || relay || undefined,
          isPublicGroup,
          reason: 'send-invites',
          waitForVerification: false
        })
      }
    },
    [
      discoveryGroups,
      fetchGroupDetail,
      fetchInviteMirrorMetadata,
      getProvisionalGroupMetadata,
      getRelayEntryForGroup,
      nip04Encrypt,
      patchGroupMembershipOptimistically,
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

      const isHyperpipe = groupId.includes(':')
      const nextIsPublic =
        typeof data.isPublic === 'boolean' ? data.isPublic : cachedMetadata?.isPublic !== false
      const nextIsOpen =
        typeof data.isOpen === 'boolean' ? data.isOpen : cachedMetadata?.isOpen === true
      if (isHyperpipe) {
        metadataTags.push(['hyperpipe', groupId])
        metadataTags.push(['i', HYPERPIPE_IDENTIFIER_TAG])
        const previousTags = Array.isArray(cachedMetadata?.event?.tags)
          ? (cachedMetadata?.event?.tags as string[][])
          : []
        if (nextIsPublic && nextIsOpen) {
          const discoveryTagNames = new Set([
            'hyperpipe-topic',
            'hyperpipe-host-peer',
            'hyperpipe-writer-issuer',
            'hyperpipe-lease-replica-peer',
            HYPERPIPE_GATEWAY_ID_TAG,
            HYPERPIPE_GATEWAY_ORIGIN_TAG,
            HYPERPIPE_DIRECT_JOIN_ONLY_TAG
          ])
          const existingTagKeys = new Set(metadataTags.map((tag) => `${tag[0]}:${tag[1] || ''}`))
          for (const tag of previousTags) {
            if (!Array.isArray(tag) || !tag[0] || !tag[1]) continue
            if (!discoveryTagNames.has(tag[0])) continue
            const key = `${tag[0]}:${tag[1]}`
            if (existingTagKeys.has(key)) continue
            metadataTags.push([tag[0], tag[1]])
            existingTagKeys.add(key)
          }
        }
      }

      if (metadataTags.length > 2) {
        const metadataEvent: TDraftEvent = {
          kind: ExtendedKind.GROUP_METADATA,
          created_at: Math.floor(Date.now() / 1000),
          tags: metadataTags,
          content: ''
        }
        console.info('[GroupsProvider] updateMetadata 39000', metadataEvent)
        const isPublicGroup = nextIsPublic
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
          gatewayId: cachedMetadata?.gatewayId || null,
          gatewayOrigin: cachedMetadata?.gatewayOrigin || null,
          directJoinOnly: cachedMetadata?.directJoinOnly === true,
          creatorPubkey: pubkey,
          source: 'update'
        })
        persistGroupMetadata(
          createProvisionalGroupMetadata({
            groupId,
            relay: resolved || relay || undefined,
            name,
            about,
            picture,
            isPublic: typeof data.isPublic === 'boolean' ? data.isPublic : cachedMetadata?.isPublic,
            isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : cachedMetadata?.isOpen,
            gatewayId: cachedMetadata?.gatewayId || null,
            gatewayOrigin: cachedMetadata?.gatewayOrigin || null,
            directJoinOnly: cachedMetadata?.directJoinOnly === true,
            createdAt: metadataEvent.created_at,
            creatorPubkey: pubkey
          }),
          resolved || relay || undefined
        ).catch(() => {})

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
    [
      discoveryGroups,
      getProvisionalGroupMetadata,
      persistGroupMetadata,
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
      patchGroupMembershipOptimistically(
        groupId,
        resolved || relay || undefined,
        (currentMembers) => normalizePubkeyList([...currentMembers, targetPubkey]),
        {
          membershipStatus: targetPubkey === pubkey ? 'member' : undefined,
          isJoinedGroup: true
        }
      )
      await republishMemberSnapshot39002({
        groupId,
        relay: resolved || relay || undefined,
        isPublicGroup,
        reason: 'add-user'
      })
    },
    [
      fetchGroupDetail,
      patchGroupMembershipOptimistically,
      pubkey,
      publish,
      republishMemberSnapshot39002,
      resolveRelayUrl
    ]
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
      deletePersistedGroupMembershipState(groupId, resolved || relay || undefined).catch(() => {})
    },
    [deletePersistedGroupMembershipState, pubkey, publish, resolveRelayUrl]
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
      patchGroupMembershipOptimistically(
        groupId,
        resolved || relay || undefined,
        (currentMembers) => currentMembers.filter((memberPubkey) => memberPubkey !== targetPubkey),
        {
          membershipStatus: targetPubkey === pubkey ? 'removed' : undefined,
          isJoinedGroup: targetPubkey === pubkey ? false : true
        }
      )
      if (targetPubkey === pubkey) {
        deletePersistedGroupMembershipState(groupId, resolved || relay || undefined).catch(() => {})
      }
      await republishMemberSnapshot39002({
        groupId,
        relay: resolved || relay || undefined,
        isPublicGroup,
        reason: 'remove-user'
      })
    },
    [
      fetchGroupDetail,
      deletePersistedGroupMembershipState,
      patchGroupMembershipOptimistically,
      pubkey,
      publish,
      republishMemberSnapshot39002,
      resolveRelayUrl
    ]
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
      pendingInviteCount,
      joinRequests,
      favoriteGroups,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      discoveryRelays,
      setDiscoveryRelays,
      resetDiscoveryRelays,
      refreshDiscovery,
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
      hydrateGroupMemberPreview,
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

        const discoveryTargets = discoveryRelays.length ? discoveryRelays : defaultDiscoveryRelays
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
        metadataTags.push(['i', HYPERPIPE_IDENTIFIER_TAG])

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
          logGroupSnapshotPublishAttempt({
            reason: 'create-group:admins',
            groupId,
            event: adminsEvent,
            relayUrls: Array.from(new Set([...localTargets, ...discoveryTargets]))
          })
          logGroupSnapshotPublishAttempt({
            reason: 'create-group:members',
            groupId,
            event: membersEvent,
            relayUrls: Array.from(new Set([...localTargets, ...discoveryTargets]))
          })
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
          logGroupSnapshotPublishAttempt({
            reason: 'create-group-private:admins',
            groupId,
            event: adminsEvent,
            relayUrls: localTargets
          })
          logGroupSnapshotPublishAttempt({
            reason: 'create-group-private:members',
            groupId,
            event: membersEvent,
            relayUrls: localTargets
          })
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
          creatorPubkey: pubkey,
          source: 'create'
        })
        persistGroupMetadata(
          createProvisionalGroupMetadata({
            groupId,
            relay: localTargets[0],
            name,
            about,
            picture,
            isPublic,
            isOpen,
            createdAt,
            creatorPubkey: pubkey
          }),
          localTargets[0]
        ).catch(() => {})
        await saveMyGroupList(updatedList)
        return { groupId, relay: localTargets[0] }
      },
      createHyperpipeRelayGroup
    }),
    [
      discoveryGroups,
      favoriteGroups,
      invites,
      pendingInviteCount,
      joinRequests,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      joinRequestsError,
      discoveryRelays,
      setDiscoveryRelays,
      resetDiscoveryRelays,
      refreshDiscovery,
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
      hydrateGroupMemberPreview,
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
      publish,
      persistGroupMetadata,
      resolveRelayUrl,
      createHyperpipeRelayGroup,
      upsertProvisionalGroupMetadata
    ]
  )

  useEffect(() => {
    refreshDiscovery()
  }, [refreshDiscovery])

  useEffect(() => {
    if (!pubkey) {
      setInvites([])
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
