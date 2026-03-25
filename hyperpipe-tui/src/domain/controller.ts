import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { Event, EventTemplate, Filter } from 'nostr-tools'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { AccountService } from './accountService.js'
import type {
  AccountRecord,
  AccountSession,
  BookmarkList,
  ChatViewTab,
  ChatConversation,
  ChatInvite,
  DiscoveredGateway,
  GatewayAccessState,
  FeedControls,
  FeedSortKey,
  FeedItem,
  FeedSourceState,
  FileActionStatus,
  FileControls,
  FileFamilyCounts,
  FileSortKey,
  GroupNoteRecord,
  GroupComposeDraft,
  GroupControls,
  GroupJoinRequest,
  GroupListEntry,
  GroupSortKey,
  GroupViewTab,
  GroupFileRecord,
  GroupDraftAttachment,
  GroupInvite,
  GroupNotesLoadState,
  GroupPresenceState,
  GroupSummary,
  GatewayOperatorIdentity,
  InvitesInboxItem,
  ListService as IListService,
  LogLevel,
  PaneFocus,
  PaneViewportMap,
  PerfMetrics,
  RelayEntry,
  RelayListPreferences,
  ProfileSuggestion,
  SearchMode,
  SearchResult,
  SortDirection,
  StarterPack,
  ThreadMessage,
  WorkerRecoveryState
} from './types.js'
import { RelayService } from './relayService.js'
import { FeedService } from './feedService.js'
import { PostService } from './postService.js'
import { GroupService } from './groupService.js'
import { FileService } from './fileService.js'
import { ListService } from './listService.js'
import { BookmarkService } from './bookmarkService.js'
import { ChatService } from './chatService.js'
import { SearchService } from './searchService.js'
import { NostrClient } from './nostrClient.js'
import { WorkerHost, findDefaultWorkerRoot } from '../runtime/workerHost.js'
import type { ClipboardCopyResult } from '../runtime/clipboard.js'
import { waitForWorkerEvent } from '../runtime/waitForWorkerEvent.js'
import { writeTuiFileLog } from '../runtime/tuiFileLogger.js'
import { resolveStoragePaths } from '../storage/paths.js'
import { UiStateStore } from '../storage/uiStateStore.js'
import {
  DEFAULT_DISCOVERY_RELAYS,
  FILE_FAMILY_ORDER,
  type FileFamily,
  type NavNodeId,
  SEARCHABLE_RELAYS
} from '../lib/constants.js'
import {
  uniqueRelayUrls,
  normalizeRelayUrl,
  nip04Decrypt,
  nip04Encrypt,
  eventNow,
  signDraftEvent
} from '../lib/nostr.js'
import { buildScopedFileScope, type ArchivedGroupEntry } from './parity/fileScope.js'
import {
  buildInvitesInbox,
  filterActionableGroupInvites
} from './parity/groupFilters.js'
import {
  selectChatNavCount,
  selectChatPendingInviteCount,
  selectChatUnreadTotal,
  selectFilesCount,
  selectInvitesCount
} from './parity/counters.js'
import { parseGroupAdminsEvent, parseGroupMembersEvent } from '../lib/groups.js'
import { createGroupFileMetadataDraftEvent } from '../lib/group-files.js'
import { groupScopeKey } from '../lib/groupScope.js'
import { getBaseRelayUrl } from '../lib/hyperpipe-group-events.js'

export type RuntimeOptions = {
  cwd: string
  storageDir: string
  profile?: string
  noAnimations?: boolean
  logLevel?: LogLevel
}

export type WorkerLifecycle =
  | 'stopped'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'stopping'
  | 'error'

export type ChatRuntimeState = 'idle' | 'initializing' | 'ready' | 'degraded'

export type LogEntry = {
  ts: number
  level: LogLevel
  message: string
}

export type ControllerState = {
  initialized: boolean
  accounts: AccountRecord[]
  currentAccountPubkey: string | null
  session: AccountSession | null
  lifecycle: WorkerLifecycle
  readinessMessage: string
  relays: RelayEntry[]
  relayListPreferences: RelayListPreferences
  discoveryRelayUrls: string[]
  gatewayPeerCounts: Record<string, number>
  discoveredGateways: DiscoveredGateway[]
  authorizedGateways: DiscoveredGateway[]
  gatewayAccessCatalog: GatewayAccessState[]
  feed: FeedItem[]
  feedSource: FeedSourceState
  activeFeedRelays: string[]
  feedControls: FeedControls
  groups: GroupSummary[]
  groupControls: GroupControls
  invites: GroupInvite[]
  files: GroupFileRecord[]
  fileControls: FileControls
  lists: StarterPack[]
  bookmarks: BookmarkList
  conversations: ChatConversation[]
  chatInvites: ChatInvite[]
  threadMessages: ThreadMessage[]
  searchResults: SearchResult[]
  searchMode: SearchMode
  searchQuery: string
  myGroupList: GroupListEntry[]
  groupDiscover: GroupSummary[]
  myGroups: GroupSummary[]
  groupInvites: GroupInvite[]
  groupJoinRequests: Record<string, GroupJoinRequest[]>
  invitesInbox: InvitesInboxItem[]
  chatUnreadTotal: number
  chatPendingInviteCount: number
  chatRuntimeState: ChatRuntimeState
  chatWarning: string | null
  chatRetryCount: number
  chatNextRetryAt: number | null
  filesCount: number
  invitesCount: number
  fileFamilyCounts: FileFamilyCounts
  groupViewTab: GroupViewTab
  chatViewTab: ChatViewTab
  selectedNode: NavNodeId
  focusPane: PaneFocus
  treeExpanded: {
    groups: boolean
    chats: boolean
    invites: boolean
    files: boolean
  }
  nodeViewport: PaneViewportMap
  rightTopSelectionByNode: Record<string, number>
  rightBottomOffsetByNode: Record<string, number>
  keymap: {
    vimNavigation: boolean
  }
  detailPaneOffsetBySection: Record<string, number>
  paneViewport: PaneViewportMap
  groupNotesByGroupKey: Record<string, GroupNoteRecord[]>
  groupNotesLoadStateByGroupKey: Record<string, GroupNotesLoadState>
  groupFilesByGroupKey: Record<string, GroupFileRecord[]>
  adminProfileByPubkey: Record<string, {
    name: string | null
    bio: string | null
    followersCount: number | null
  }>
  fileActionStatus: FileActionStatus
  hiddenDeletedFileKeys: string[]
  composeDraft: GroupComposeDraft | null
  perfMetrics: PerfMetrics
  workerRecoveryState: WorkerRecoveryState
  dismissedGroupInviteIds: string[]
  acceptedGroupInviteIds: string[]
  acceptedGroupInviteGroupIds: string[]
  dismissedChatInviteIds: string[]
  acceptedChatInviteIds: string[]
  acceptedChatInviteConversationIds: string[]
  workerStdout: string[]
  workerStderr: string[]
  logs: LogEntry[]
  busyTask: string | null
  lastError: string | null
  lastCopiedValue: string | null
  lastCopiedMethod: ClipboardCopyResult['method'] | null
}

type ProfileNameCacheEntry = {
  name: string
  bio?: string | null
  updatedAt: number
}

function trimLogs<T>(items: T[], max = 400): T[] {
  if (items.length <= max) return items
  return items.slice(items.length - max)
}

function trimLines(lines: string[], max = 250): string[] {
  if (lines.length <= max) return lines
  return lines.slice(lines.length - max)
}

function sanitizeWorkerLine(input: string): string {
  return input
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeWorkerChunk(chunk: string): string[] {
  return String(chunk || '')
    .split(/\r?\n/g)
    .map((line) => sanitizeWorkerLine(line))
    .filter(Boolean)
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[idx] || 0
}

function defaultPerfMetrics(): PerfMetrics {
  return {
    inFlight: 0,
    queueDepth: 0,
    dedupedRequests: 0,
    cancelledRequests: 0,
    retries: 0,
    staleResponseDrops: 0,
    operationSamples: [],
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    renderPressure: 0,
    overlayEnabled: false
  }
}

function isHex64String(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function parseGatewayOperatorIdentity(input: unknown): GatewayOperatorIdentity | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const pubkey = typeof source.pubkey === 'string' ? source.pubkey.trim().toLowerCase() : ''
  if (!isHex64String(pubkey)) return null
  const attestation = source.attestation && typeof source.attestation === 'object'
    ? source.attestation as Record<string, unknown>
    : null
  const payload = attestation?.payload && typeof attestation.payload === 'object'
    ? attestation.payload as Record<string, unknown>
    : null
  return {
    pubkey,
    attestation: attestation
      ? {
          version: Number.isFinite(Number(attestation.version)) ? Number(attestation.version) : null,
          payload: payload
            ? {
                purpose: typeof payload.purpose === 'string' ? payload.purpose.trim() || null : null,
                operatorPubkey: typeof payload.operatorPubkey === 'string'
                  ? payload.operatorPubkey.trim().toLowerCase() || null
                  : null,
                gatewayId: typeof payload.gatewayId === 'string'
                  ? payload.gatewayId.trim().toLowerCase() || null
                  : null,
                publicUrl: typeof payload.publicUrl === 'string' ? payload.publicUrl.trim() || null : null,
                issuedAt: Number.isFinite(Number(payload.issuedAt)) ? Number(payload.issuedAt) : null,
                expiresAt: Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null
              }
            : null,
          signature: typeof attestation.signature === 'string' ? attestation.signature.trim() || null : null
        }
      : null
  }
}

function cloneGatewayOperatorIdentity(identity: GatewayOperatorIdentity | null | undefined): GatewayOperatorIdentity | null {
  if (!identity) return null
  return parseGatewayOperatorIdentity(identity)
}

function defaultWorkerRecoveryState(): WorkerRecoveryState {
  return {
    enabled: true,
    status: 'idle',
    attempt: 0,
    nextDelayMs: 0,
    lastExitCode: null,
    lastError: null
  }
}

function defaultFeedSourceState(): FeedSourceState {
  return {
    mode: 'relays',
    relayUrl: null,
    groupId: null,
    label: 'All Relays'
  }
}

function defaultFeedControls(): FeedControls {
  return {
    query: '',
    sortKey: 'createdAt',
    sortDirection: 'desc',
    kindFilter: null
  }
}

function defaultGroupControls(): GroupControls {
  return {
    query: '',
    sortKey: 'members',
    sortDirection: 'desc',
    visibility: 'all',
    joinMode: 'all'
  }
}

function defaultFileControls(): FileControls {
  return {
    query: '',
    sortKey: 'uploadedAt',
    sortDirection: 'desc',
    mime: 'all',
    group: 'all'
  }
}

function defaultFileActionStatus(): FileActionStatus {
  return {
    action: null,
    state: 'idle',
    message: null,
    path: null,
    updatedAt: Date.now(),
    eventId: null,
    sha256: null
  }
}

function defaultFileFamilyCounts(): FileFamilyCounts {
  return {
    images: 0,
    video: 0,
    audio: 0,
    docs: 0,
    other: 0
  }
}

function classifyFileFamily(mime?: string | null): FileFamily {
  const normalized = String(mime || '').toLowerCase()
  if (normalized.startsWith('image/')) return 'images'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  if (
    normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('pdf')
    || normalized.includes('markdown')
    || normalized.includes('msword')
    || normalized.includes('officedocument')
  ) {
    return 'docs'
  }
  return 'other'
}

function normalizeFileRecordKey(file: GroupFileRecord): string {
  if (file.sha256) return `${file.groupId}:${file.sha256}`
  return `${file.groupId}:${file.eventId}`
}

function groupListEntryKey(entry: GroupListEntry): string {
  const groupId = String(entry.groupId || '').trim()
  const relay = String(entry.relay || '').trim()
  return `${groupId}|${relay}`
}

function maybeNpub(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return nip19.npubEncode(value)
  } catch {
    return undefined
  }
}

function guessMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.txt':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    case '.json':
      return 'application/json'
    case '.pdf':
      return 'application/pdf'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.mp3':
      return 'audio/mpeg'
    default:
      return 'application/octet-stream'
  }
}

const MAX_FEED_RELAYS = 18
const MAX_SEARCH_RELAYS = 24
const MAX_GROUP_ENRICH_RELAYS = 12
const MAX_GROUP_ENRICH_ITEMS = 120
const RELAY_REFRESH_TIMEOUT_MS = 9_000
const FEED_REFRESH_TIMEOUT_MS = 4_000
const GROUP_METADATA_TIMEOUT_MS = 2_500
const LOCAL_PROFILE_CACHE_TTL_MS = 5_000
const CREATE_RELAY_RECONCILE_TIMEOUT_MS = 90_000
const CREATE_RELAY_RECONCILE_POLL_MS = 1_500
const GROUP_PRESENCE_SELECTED_TTL_MS = 15_000
const GROUP_PRESENCE_MY_GROUP_TTL_MS = 20_000
const GROUP_PRESENCE_DISCOVER_TTL_MS = 30_000
const GROUP_PRESENCE_VISIBLE_WINDOW = 6
const GROUP_PRESENCE_DISCOVER_CONCURRENCY = 3

type LocalRelayProfileSnapshot = {
  relayKey: string
  publicIdentifier: string
  relayUrl: string
  name: string
  about: string
  picture?: string
  isPublic: boolean
  isOpen: boolean
  adminPubkey?: string | null
  members: string[]
  membersCount: number
  createdAt: number | null
}

export class TuiController {
  private options: RuntimeOptions
  private emitter = new EventEmitter()
  private workerHost = new WorkerHost()
  private nostrClient = new NostrClient()
  private uiStateStore: UiStateStore
  private accountService: AccountService

  private relayService: RelayService
  private feedService: FeedService
  private postService: PostService
  private groupService: GroupService
  private fileService: FileService
  private listService: IListService
  private bookmarkService: BookmarkService
  private chatService: ChatService
  private searchService: SearchService

  private workerUnsubs: Array<() => void> = []
  private workerOutFlushTimer: NodeJS.Timeout | null = null
  private workerStdoutQueue: string[] = []
  private workerStderrQueue: string[] = []
  private inFlightByKey = new Map<string, number>()
  private operationCounter = 0
  private recoveryTimer: NodeJS.Timeout | null = null
  private recoveryMaxAttempts = 7
  private inviteRefreshToken = 0
  private chatRetryTimer: NodeJS.Timeout | null = null
  private chatInitInFlight = false
  private rawFeed: FeedItem[] = []
  private rawGroupDiscover: GroupSummary[] = []
  private rawFiles: GroupFileRecord[] = []
  private feedLimit = 120
  private profileNameCache = new Map<string, string>()
  private localProfileCache: { loadedAt: number; entries: LocalRelayProfileSnapshot[] } | null = null
  private gatewayPeerRelayMap: Record<string, string[]> = {}
  private groupPresenceCache = new Map<string, GroupPresenceState>()
  private groupPresenceExpiresAt = new Map<string, number>()
  private groupPresenceInFlight = new Map<string, Promise<GroupPresenceState>>()

  private state: ControllerState = {
    initialized: false,
    accounts: [],
    currentAccountPubkey: null,
    session: null,
    lifecycle: 'stopped',
    readinessMessage: 'Stopped',
    relays: [],
    relayListPreferences: {
      read: [],
      write: []
    },
    discoveryRelayUrls: uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS),
    gatewayPeerCounts: {},
    discoveredGateways: [],
    authorizedGateways: [],
    gatewayAccessCatalog: [],
    feed: [],
    feedSource: defaultFeedSourceState(),
    activeFeedRelays: [],
    feedControls: defaultFeedControls(),
    groups: [],
    groupControls: defaultGroupControls(),
    invites: [],
    files: [],
    fileControls: defaultFileControls(),
    lists: [],
    bookmarks: {
      event: null,
      eventIds: []
    },
    conversations: [],
    chatInvites: [],
    threadMessages: [],
    searchResults: [],
    searchMode: 'notes',
    searchQuery: '',
    myGroupList: [],
    groupDiscover: [],
    myGroups: [],
    groupInvites: [],
    groupJoinRequests: {},
    invitesInbox: [],
    chatUnreadTotal: 0,
    chatPendingInviteCount: 0,
    chatRuntimeState: 'idle',
    chatWarning: null,
    chatRetryCount: 0,
    chatNextRetryAt: null,
    filesCount: 0,
    invitesCount: 0,
    fileFamilyCounts: defaultFileFamilyCounts(),
    groupViewTab: 'discover',
    chatViewTab: 'conversations',
    selectedNode: 'dashboard',
    focusPane: 'left-tree',
    treeExpanded: {
      groups: true,
      chats: true,
      invites: true,
      files: true
    },
    nodeViewport: {},
    rightTopSelectionByNode: {},
    rightBottomOffsetByNode: {},
    keymap: {
      vimNavigation: false
    },
    detailPaneOffsetBySection: {},
    paneViewport: {},
    groupNotesByGroupKey: {},
    groupNotesLoadStateByGroupKey: {},
    groupFilesByGroupKey: {},
    adminProfileByPubkey: {},
    fileActionStatus: defaultFileActionStatus(),
    hiddenDeletedFileKeys: [],
    composeDraft: null,
    perfMetrics: defaultPerfMetrics(),
    workerRecoveryState: defaultWorkerRecoveryState(),
    dismissedGroupInviteIds: [],
    acceptedGroupInviteIds: [],
    acceptedGroupInviteGroupIds: [],
    dismissedChatInviteIds: [],
    acceptedChatInviteIds: [],
    acceptedChatInviteConversationIds: [],
    workerStdout: [],
    workerStderr: [],
    logs: [],
    busyTask: null,
    lastError: null,
    lastCopiedValue: null,
    lastCopiedMethod: null
  }

  constructor(options: RuntimeOptions) {
    this.options = options

    const storagePaths = resolveStoragePaths(options.storageDir)
    this.uiStateStore = new UiStateStore(storagePaths.uiStateFile)
    this.accountService = new AccountService(storagePaths.accountsFile)

    this.relayService = new RelayService(this.workerHost)
    this.feedService = new FeedService(this.nostrClient)
    this.postService = new PostService(this.nostrClient, () => this.requireSession().nsecHex)
    this.groupService = new GroupService(this.nostrClient, this.workerHost, () => this.requireSession().nsecHex)
    this.fileService = new FileService(this.workerHost, this.nostrClient)
    this.listService = new ListService(
      this.nostrClient,
      () => this.requireSession().nsecHex,
      () => this.requireSession().pubkey
    )
    this.bookmarkService = new BookmarkService(
      this.nostrClient,
      () => this.requireSession().pubkey,
      () => this.requireSession().nsecHex
    )
    this.chatService = new ChatService(this.workerHost)
    this.searchService = new SearchService(this.nostrClient)
  }

  subscribe(listener: (state: ControllerState) => void): () => void {
    const wrapped = () => listener(this.getState())
    this.emitter.on('change', wrapped)
    return () => this.emitter.off('change', wrapped)
  }

  getState(): ControllerState {
    return {
      ...this.state,
      accounts: this.state.accounts.map((account) => ({ ...account })),
      relays: this.state.relays.map((relay) => ({ ...relay })),
      relayListPreferences: {
        read: [...this.state.relayListPreferences.read],
        write: [...this.state.relayListPreferences.write]
      },
      discoveryRelayUrls: [...this.state.discoveryRelayUrls],
      gatewayPeerCounts: { ...this.state.gatewayPeerCounts },
      discoveredGateways: this.state.discoveredGateways.map((gateway) => ({
        ...gateway,
        operatorIdentity: cloneGatewayOperatorIdentity(gateway.operatorIdentity)
      })),
      authorizedGateways: this.state.authorizedGateways.map((gateway) => ({
        ...gateway,
        operatorIdentity: cloneGatewayOperatorIdentity(gateway.operatorIdentity)
      })),
      gatewayAccessCatalog: this.state.gatewayAccessCatalog.map((entry) => ({
        ...entry,
        operatorIdentity: cloneGatewayOperatorIdentity(entry.operatorIdentity)
      })),
      feed: [...this.state.feed],
      feedSource: { ...this.state.feedSource },
      activeFeedRelays: [...this.state.activeFeedRelays],
      feedControls: {
        ...this.state.feedControls,
        kindFilter: this.state.feedControls.kindFilter ? [...this.state.feedControls.kindFilter] : null
      },
      groups: this.state.groups.map((group) => ({
        ...group,
        peerPresence: group.peerPresence ? { ...group.peerPresence } : undefined
      })),
      groupControls: { ...this.state.groupControls },
      invites: this.state.invites.map((invite) => ({ ...invite })),
      files: this.state.files.map((file) => ({ ...file })),
      fileControls: { ...this.state.fileControls },
      lists: this.state.lists.map((list) => ({ ...list })),
      bookmarks: {
        event: this.state.bookmarks.event,
        eventIds: [...this.state.bookmarks.eventIds]
      },
      conversations: this.state.conversations.map((conversation) => ({ ...conversation })),
      chatInvites: this.state.chatInvites.map((invite) => ({ ...invite })),
      threadMessages: this.state.threadMessages.map((message) => ({ ...message })),
      searchResults: this.state.searchResults.map((result) => ({ ...result })),
      myGroupList: this.state.myGroupList.map((entry) => ({ ...entry })),
      groupDiscover: this.state.groupDiscover.map((group) => ({
        ...group,
        peerPresence: group.peerPresence ? { ...group.peerPresence } : undefined
      })),
      myGroups: this.state.myGroups.map((group) => ({
        ...group,
        peerPresence: group.peerPresence ? { ...group.peerPresence } : undefined
      })),
      groupInvites: this.state.groupInvites.map((invite) => ({ ...invite })),
      groupJoinRequests: Object.fromEntries(
        Object.entries(this.state.groupJoinRequests).map(([key, value]) => [key, value.map((row) => ({ ...row }))])
      ),
      invitesInbox: this.state.invitesInbox.map((item) => ({ ...item })),
      fileFamilyCounts: { ...this.state.fileFamilyCounts },
      selectedNode: this.state.selectedNode,
      focusPane: this.state.focusPane,
      treeExpanded: { ...this.state.treeExpanded },
      nodeViewport: Object.fromEntries(
        Object.entries(this.state.nodeViewport).map(([key, value]) => [key, { ...value }])
      ),
      rightTopSelectionByNode: { ...this.state.rightTopSelectionByNode },
      rightBottomOffsetByNode: { ...this.state.rightBottomOffsetByNode },
      keymap: { ...this.state.keymap },
      detailPaneOffsetBySection: { ...this.state.detailPaneOffsetBySection },
      paneViewport: Object.fromEntries(
        Object.entries(this.state.paneViewport).map(([key, value]) => [key, { ...value }])
      ),
      groupNotesByGroupKey: Object.fromEntries(
        Object.entries(this.state.groupNotesByGroupKey).map(([key, value]) => [key, value.map((row) => ({ ...row }))])
      ),
      groupNotesLoadStateByGroupKey: { ...this.state.groupNotesLoadStateByGroupKey },
      groupFilesByGroupKey: Object.fromEntries(
        Object.entries(this.state.groupFilesByGroupKey).map(([key, value]) => [key, value.map((row) => ({ ...row }))])
      ),
      adminProfileByPubkey: { ...this.state.adminProfileByPubkey },
      fileActionStatus: { ...this.state.fileActionStatus },
      hiddenDeletedFileKeys: [...this.state.hiddenDeletedFileKeys],
      composeDraft: this.state.composeDraft
        ? {
            ...this.state.composeDraft,
            attachments: this.state.composeDraft.attachments.map((entry) => ({ ...entry }))
          }
        : null,
      perfMetrics: {
        ...this.state.perfMetrics,
        operationSamples: this.state.perfMetrics.operationSamples.map((sample) => ({ ...sample }))
      },
      workerRecoveryState: { ...this.state.workerRecoveryState },
      dismissedGroupInviteIds: [...this.state.dismissedGroupInviteIds],
      acceptedGroupInviteIds: [...this.state.acceptedGroupInviteIds],
      acceptedGroupInviteGroupIds: [...this.state.acceptedGroupInviteGroupIds],
      dismissedChatInviteIds: [...this.state.dismissedChatInviteIds],
      acceptedChatInviteIds: [...this.state.acceptedChatInviteIds],
      acceptedChatInviteConversationIds: [...this.state.acceptedChatInviteConversationIds],
      workerStdout: [...this.state.workerStdout],
      workerStderr: [...this.state.workerStderr],
      logs: [...this.state.logs]
    }
  }

  private patchState(patch: Partial<ControllerState>): void {
    this.state = {
      ...this.state,
      ...patch
    }
    const refreshTriggers = [
      'files',
      'groupInvites',
      'invites',
      'myGroupList',
      'groupDiscover',
      'groups',
      'conversations',
      'chatInvites'
    ]
    if (Object.keys(patch).some((key) => refreshTriggers.includes(key))) {
      this.refreshDerivedCollections()
    }
    this.emitter.emit('change')
  }

  private log(level: LogLevel, message: string): void {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      message
    }

    this.state.logs = trimLogs([...this.state.logs, entry])
    writeTuiFileLog(level, 'controller', message)
    this.emitter.emit('change')
  }

  private scheduleWorkerOutputFlush(): void {
    if (this.workerOutFlushTimer) return
    this.workerOutFlushTimer = setTimeout(() => {
      this.workerOutFlushTimer = null

      if (this.workerStdoutQueue.length) {
        this.state.workerStdout = trimLines([
          ...this.state.workerStdout,
          ...this.workerStdoutQueue
        ])
        this.workerStdoutQueue = []
      }

      if (this.workerStderrQueue.length) {
        this.state.workerStderr = trimLines([
          ...this.state.workerStderr,
          ...this.workerStderrQueue
        ])
        this.workerStderrQueue = []
      }

      this.state.perfMetrics = {
        ...this.state.perfMetrics,
        renderPressure:
          this.state.workerStdout.length + this.state.workerStderr.length + this.state.logs.length
      }

      this.emitter.emit('change')
    }, 60)
  }

  private recordOperationSample(sample: {
    name: string
    startedAt: number
    durationMs: number
    success: boolean
    attempts: number
  }): void {
    const nextSamples = trimLogs(
      [...this.state.perfMetrics.operationSamples, sample],
      400
    )
    const latencies = nextSamples.map((entry) => entry.durationMs)
    const avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((total, value) => total + value, 0) / latencies.length
        : 0

    this.state.perfMetrics = {
      ...this.state.perfMetrics,
      operationSamples: nextSamples,
      avgLatencyMs,
      p95LatencyMs: percentile(latencies, 0.95)
    }
  }

  private fallbackGroupNameFromIdentifier(identifier: string): string {
    const normalized = String(identifier || '').trim()
    if (!normalized) return 'Unnamed Group'
    const slashParts = normalized.split('/')
    const colonParts = normalized.split(':')
    const candidate = (colonParts.length > 1
      ? colonParts[colonParts.length - 1]
      : slashParts[slashParts.length - 1]) || normalized
    try {
      const decoded = decodeURIComponent(candidate)
      return decoded.trim() || normalized
    } catch {
      return candidate.trim() || normalized
    }
  }

  private looksLikeGroupIdentifier(value?: string | null): boolean {
    const normalized = String(value || '').trim()
    if (!normalized) return false
    if (normalized.includes('://')) return false
    if (/^[a-f0-9]{64}$/i.test(normalized)) return false
    return normalized.includes(':') || normalized.includes('/')
  }

  private deriveMyGroupListFromConnectedRelays(): GroupListEntry[] {
    const entries: GroupListEntry[] = []
    const seen = new Set<string>()
    for (const relay of this.state.relays) {
      if (relay.writable !== true) continue
      const groupId = String(relay.publicIdentifier || '').trim()
      if (!this.looksLikeGroupIdentifier(groupId)) continue
      const relayUrl = this.resolveRelayUrl(relay.connectionUrl || undefined)
        || String(relay.connectionUrl || '').trim()
        || undefined
      const entry: GroupListEntry = { groupId, relay: relayUrl }
      const key = groupListEntryKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
    return entries
  }

  private mergeMyGroupList(primary: GroupListEntry[], secondary: GroupListEntry[]): GroupListEntry[] {
    const merged: GroupListEntry[] = []
    const byGroup = new Map<string, GroupListEntry>()

    const ingest = (entry: GroupListEntry): void => {
      const groupId = String(entry.groupId || '').trim()
      if (!groupId) return
      const relay = this.resolveRelayUrl(entry.relay || undefined)
        || String(entry.relay || '').trim()
        || undefined
      const normalized: GroupListEntry = { groupId, relay }
      const existing = byGroup.get(groupId)
      if (!existing) {
        byGroup.set(groupId, normalized)
        merged.push(normalized)
        return
      }
      if (!existing.relay && normalized.relay) {
        existing.relay = normalized.relay
      }
    }

    for (const entry of primary) ingest(entry)
    for (const entry of secondary) ingest(entry)
    return merged
  }

  private refreshDerivedCollections(): void {
    const discoverById = new Map(this.state.groupDiscover.map((group) => [group.id, group]))
    const myGroups: GroupSummary[] = []
    const seenGroupIds = new Set<string>()
    for (const entry of this.state.myGroupList) {
      const groupId = String(entry.groupId || '').trim()
      if (!groupId || seenGroupIds.has(groupId)) continue
      seenGroupIds.add(groupId)

      const discovered = discoverById.get(groupId)
      if (discovered) {
        myGroups.push(discovered)
        continue
      }

      const relay = this.resolveRelayUrl(entry.relay) || String(entry.relay || '').trim() || undefined
      myGroups.push(this.applyGroupPresenceToGroup({
        id: groupId,
        relay,
        name: this.fallbackGroupNameFromIdentifier(groupId),
        about: '',
        isPublic: true,
        isOpen: true,
        members: [],
        membersCount: 0,
        createdAt: null
      }))
    }

    const invitesInbox = buildInvitesInbox({
      groupInvites: this.state.groupInvites,
      chatInvites: this.state.chatInvites
    })

    this.state.myGroups = myGroups
    this.state.invitesInbox = invitesInbox
    this.state.filesCount = selectFilesCount(this.state.files)
    this.state.fileFamilyCounts = FILE_FAMILY_ORDER.reduce((acc, family) => {
      acc[family] = 0
      return acc
    }, defaultFileFamilyCounts())
    for (const file of this.state.files) {
      const family = classifyFileFamily(file.mime)
      this.state.fileFamilyCounts[family] += 1
    }
    this.state.chatUnreadTotal = selectChatUnreadTotal(this.state.conversations)
    this.state.chatPendingInviteCount = selectChatPendingInviteCount(this.state.chatInvites)
    this.state.invitesCount = selectInvitesCount(this.state.groupInvites, this.state.chatInvites)
  }

  private requireSession(): AccountSession {
    if (!this.state.session) {
      throw new Error('No unlocked account session')
    }
    return this.state.session
  }

  private currentUiScopeKey(): string | null {
    return this.state.session?.userKey || this.state.currentAccountPubkey || null
  }

  private profileNameCachePatchFromState(): Record<string, ProfileNameCacheEntry> {
    const next: Record<string, ProfileNameCacheEntry> = {}
    for (const [pubkey, profile] of Object.entries(this.state.adminProfileByPubkey)) {
      const normalizedPubkey = String(pubkey || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/i.test(normalizedPubkey)) continue
      const name = String(profile?.name || '').trim()
      if (!name) continue
      next[normalizedPubkey] = {
        name,
        bio: String(profile?.bio || '').trim() || null,
        updatedAt: Date.now()
      }
    }
    return next
  }

  private async persistProfileNameCacheFromState(): Promise<void> {
    await this.persistAccountScopedUiState({
      profileNameCacheByPubkey: this.profileNameCachePatchFromState()
    })
  }

  private async upsertAdminProfiles(
    rows: Array<{
      pubkey: string
      name?: string | null
      bio?: string | null
      followersCount?: number | null
      updatedAt?: number
    }>,
    options: { persist?: boolean } = {}
  ): Promise<void> {
    if (!rows.length) return
    const next = { ...this.state.adminProfileByPubkey }
    let changed = false
    for (const row of rows) {
      const pubkey = String(row.pubkey || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/i.test(pubkey)) continue
      const name = String(row.name || '').trim() || null
      const bio = String(row.bio || '').trim() || null
      const followersCount = Number(row.followersCount)
      const previous = next[pubkey]
      const nextProfile = {
        name,
        bio,
        followersCount: Number.isFinite(followersCount)
          ? followersCount
          : (previous?.followersCount ?? null)
      }
      if (
        previous?.name === nextProfile.name
        && previous?.bio === nextProfile.bio
        && previous?.followersCount === nextProfile.followersCount
      ) {
        continue
      }
      next[pubkey] = nextProfile
      if (name) {
        this.profileNameCache.set(pubkey, name)
      } else {
        this.profileNameCache.delete(pubkey)
      }
      changed = true
    }
    if (!changed) return
    this.patchState({ adminProfileByPubkey: next })
    if (options.persist !== false) {
      await this.persistProfileNameCacheFromState()
    }
  }

  private async loadAccountScopedUiState(userKey: string | null): Promise<void> {
    if (!userKey) return
    const scoped = this.uiStateStore.getAccountState(userKey)
    this.profileNameCache = new Map<string, string>()
    const cachedProfiles = Object.entries(scoped.profileNameCacheByPubkey || {}).reduce<Record<string, {
      name: string | null
      bio: string | null
      followersCount: number | null
    }>>((acc, [pubkey, entry]) => {
      const normalizedPubkey = String(pubkey || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/i.test(normalizedPubkey)) return acc
      const name = String(entry?.name || '').trim()
      if (!name) return acc
      this.profileNameCache.set(normalizedPubkey, name)
      acc[normalizedPubkey] = {
        name,
        bio: String(entry?.bio || '').trim() || null,
        followersCount: null
      }
      return acc
    }, {})
    this.patchState({
      groupViewTab: scoped.groupViewTab,
      chatViewTab: scoped.chatViewTab,
      selectedNode: scoped.selectedNode as NavNodeId,
      focusPane: scoped.focusPane as PaneFocus,
      treeExpanded: {
        groups: scoped.treeExpanded.groups,
        chats: scoped.treeExpanded.chats ?? true,
        invites: scoped.treeExpanded.invites,
        files: scoped.treeExpanded.files
      },
      nodeViewport: scoped.nodeViewport && Object.keys(scoped.nodeViewport).length > 0
        ? scoped.nodeViewport
        : scoped.paneViewport,
      rightTopSelectionByNode: scoped.rightTopSelectionByNode || {},
      rightBottomOffsetByNode: scoped.rightBottomOffsetByNode || {},
      adminProfileByPubkey: {
        ...this.state.adminProfileByPubkey,
        ...cachedProfiles
      },
      discoveryRelayUrls: uniqueRelayUrls(
        scoped.discoveryRelays && scoped.discoveryRelays.length > 0
          ? scoped.discoveryRelays
          : DEFAULT_DISCOVERY_RELAYS
      ),
      feedSource: scoped.feedSource || defaultFeedSourceState(),
      feedControls: scoped.feedControls || defaultFeedControls(),
      groupControls: scoped.groupControls || defaultGroupControls(),
      fileControls: scoped.fileControls || defaultFileControls(),
      detailPaneOffsetBySection: scoped.detailPaneOffsetBySection || {},
      paneViewport: scoped.paneViewport,
      hiddenDeletedFileKeys: scoped.hiddenDeletedFileKeys || [],
      dismissedGroupInviteIds: scoped.dismissedGroupInviteIds,
      acceptedGroupInviteIds: scoped.acceptedGroupInviteIds,
      acceptedGroupInviteGroupIds: scoped.acceptedGroupInviteGroupIds,
      dismissedChatInviteIds: scoped.dismissedChatInviteIds,
      acceptedChatInviteIds: scoped.acceptedChatInviteIds,
      acceptedChatInviteConversationIds: scoped.acceptedChatInviteConversationIds,
      perfMetrics: {
        ...this.state.perfMetrics,
        overlayEnabled: scoped.perfOverlayEnabled
      }
    })

    if (this.rawFeed.length > 0) this.syncFeedView()
    if (this.rawGroupDiscover.length > 0) this.syncGroupView()
    if (this.rawFiles.length > 0) this.syncFilesView()
  }

  private async persistAccountScopedUiState(patch: {
    groupViewTab?: GroupViewTab
    chatViewTab?: ChatViewTab
    selectedNode?: NavNodeId
    focusPane?: PaneFocus
    treeExpanded?: {
      groups: boolean
      chats: boolean
      invites: boolean
      files: boolean
    }
    nodeViewport?: PaneViewportMap
    rightTopSelectionByNode?: Record<string, number>
    rightBottomOffsetByNode?: Record<string, number>
    discoveryRelays?: string[]
    feedSource?: FeedSourceState
    feedControls?: FeedControls
    groupControls?: GroupControls
    fileControls?: FileControls
    detailPaneOffsetBySection?: Record<string, number>
    paneViewport?: PaneViewportMap
    dismissedGroupInviteIds?: string[]
    acceptedGroupInviteIds?: string[]
    acceptedGroupInviteGroupIds?: string[]
    dismissedChatInviteIds?: string[]
    acceptedChatInviteIds?: string[]
    acceptedChatInviteConversationIds?: string[]
    hiddenDeletedFileKeys?: string[]
    perfOverlayEnabled?: boolean
    profileNameCacheByPubkey?: Record<string, ProfileNameCacheEntry>
  }): Promise<void> {
    const userKey = this.currentUiScopeKey()
    if (!userKey) return
    await this.uiStateStore.patchAccountState(userKey, patch)
  }

  async initialize(): Promise<void> {
    await this.accountService.waitUntilReady()
    await this.uiStateStore.waitUntilReady()

    this.attachWorkerListeners()

    const uiState = this.uiStateStore.getState()
    const accounts = this.accountService.listAccounts()
    const currentAccountPubkey = this.accountService.getCurrentAccountPubkey()

    this.patchState({
      initialized: true,
      accounts,
      currentAccountPubkey,
      keymap: {
        vimNavigation: Boolean(uiState.keymap?.vimNavigation)
      },
      lastCopiedValue: uiState.lastCopiedValue || null,
      lastCopiedMethod: uiState.lastCopiedMethod || null
    })

    await this.loadAccountScopedUiState(currentAccountPubkey)

    if (this.options.profile) {
      try {
        await this.selectAccount(this.options.profile)
      } catch (error) {
        this.log('warn', `Unable to auto-select profile: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private attachWorkerListeners(): void {
    this.detachWorkerListeners()

    this.workerUnsubs.push(
      this.workerHost.onMessage((event) => {
        if (!event || typeof event !== 'object') return

        if (event.type === 'status') {
          const phase = typeof event.phase === 'string' ? event.phase : ''
          const message = typeof event.message === 'string' ? event.message : ''
          const preserveReady = this.state.lifecycle === 'ready' && phase && phase !== 'stopping' && phase !== 'error'
          const lifecycle =
            phase === 'ready'
              ? 'ready'
              : phase === 'stopping'
                ? 'stopping'
                : phase === 'error'
                  ? 'error'
                  : phase
                    ? (preserveReady ? 'ready' : 'initializing')
                    : this.state.lifecycle

          this.patchState({
            lifecycle,
            readinessMessage: message || this.state.readinessMessage
          })
          if (lifecycle === 'ready') {
            this.patchState({
              workerRecoveryState: {
                ...this.state.workerRecoveryState,
                status: 'idle',
                attempt: 0,
                nextDelayMs: 0,
                lastError: null
              }
            })
            if (this.state.chatRuntimeState !== 'ready' && !this.chatInitInFlight && !this.chatRetryTimer) {
              this.scheduleChatRetry(800, 'worker-ready')
            }
          } else if (lifecycle === 'stopping' || lifecycle === 'error') {
            this.clearChatRetryTimer()
            this.patchState({ chatNextRetryAt: null })
          }
          return
        }

        if (event.type === 'relay-server-ready') {
          if (this.state.lifecycle === 'starting' || this.state.lifecycle === 'initializing') {
            this.patchState({
              lifecycle: 'ready',
              readinessMessage: 'Relay server initialized (background relay sync in progress)'
            })
            this.patchState({
              workerRecoveryState: {
                ...this.state.workerRecoveryState,
                status: 'idle',
                attempt: 0,
                nextDelayMs: 0,
                lastError: null
              }
            })
            if (this.state.chatRuntimeState !== 'ready' && !this.chatInitInFlight && !this.chatRetryTimer) {
              this.scheduleChatRetry(800, 'relay-server-ready')
            }
          }
          return
        }

        if (event.type === 'relay-update' && Array.isArray((event as { relays?: unknown[] }).relays)) {
          this.patchState({
            relays: ((event as unknown as { relays: RelayEntry[] }).relays || [])
          })
          return
        }

        if (event.type === 'gateway-status') {
          const status = (event as { status?: unknown }).status
          const gatewayPeerCounts = this.parseGatewayPeerCounts(status)
          const gatewayPeerRelayMap = this.parseGatewayPeerRelayMap(status)
          this.gatewayPeerRelayMap = gatewayPeerRelayMap
          this.patchState({ gatewayPeerCounts })
          if (this.rawGroupDiscover.length > 0) {
            this.syncGroupView()
          }
          return
        }

        if (event.type === 'public-gateway-status') {
          const state = (event as { state?: unknown }).state
          const discoveredGateways = this.parseDiscoveredGateways(
            (state as { discoveredGateways?: unknown } | null | undefined)?.discoveredGateways
          )
          const authorizedGateways = this.parseDiscoveredGateways(
            (state as { authorizedGateways?: unknown } | null | undefined)?.authorizedGateways
          )
          const gatewayAccessCatalog = this.parseGatewayAccessCatalog(
            (state as { gatewayAccessCatalog?: unknown } | null | undefined)?.gatewayAccessCatalog
          )
          this.patchState({ discoveredGateways, authorizedGateways, gatewayAccessCatalog })
          this.warmGatewayOperatorProfiles(authorizedGateways.length ? authorizedGateways : discoveredGateways)
          return
        }

        if (event.type === 'error') {
          const message =
            typeof (event as { message?: string }).message === 'string'
              ? (event as { message?: string }).message || 'Worker error'
              : event.error || 'Worker error'

          if (this.isNonFatalWorkerError(message)) {
            this.patchState({
              lastError: message
            })
            this.log('warn', message)
            return
          }

          this.patchState({
            lastError: message,
            lifecycle: 'error'
          })
          this.log('error', message)
          return
        }

        if (event.type.startsWith('join-auth-')) {
          this.log('info', `${event.type}: ${JSON.stringify((event as { data?: unknown }).data || {})}`)
          return
        }

        if (event.type.startsWith('marmot-')) {
          this.log('debug', `${event.type}`)
        }
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onStdout((chunk) => {
        const lines = sanitizeWorkerChunk(chunk)
        if (!lines.length) return
        for (const line of lines) {
          writeTuiFileLog('info', 'worker.stdout', line)
        }
        this.workerStdoutQueue.push(...lines)
        this.scheduleWorkerOutputFlush()
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onStderr((chunk) => {
        const lines = sanitizeWorkerChunk(chunk)
        if (!lines.length) return
        for (const line of lines) {
          writeTuiFileLog('error', 'worker.stderr', line)
        }
        this.workerStderrQueue.push(...lines)
        this.scheduleWorkerOutputFlush()
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onExit((code) => {
        const wasStopping = this.state.lifecycle === 'stopping'
        this.resetChatRuntimeState()
        this.patchState({
          lifecycle: 'stopped',
          readinessMessage: `Worker exited (${code})`
        })
        if (wasStopping) {
          this.log('info', `Worker exited with code ${code}`)
          return
        }
        this.log('warn', `Worker exited with code ${code}`)
        this.scheduleWorkerRecovery(code)
      })
    )
  }

  private detachWorkerListeners(): void {
    for (const off of this.workerUnsubs) {
      off()
    }
    this.workerUnsubs = []
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) return
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  private clearChatRetryTimer(): void {
    if (!this.chatRetryTimer) return
    clearTimeout(this.chatRetryTimer)
    this.chatRetryTimer = null
  }

  private resetChatRuntimeState(): void {
    this.clearChatRetryTimer()
    this.chatInitInFlight = false
    this.patchState({
      chatRuntimeState: 'idle',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  private resetGroupPresenceState(): void {
    this.groupPresenceCache.clear()
    this.groupPresenceExpiresAt.clear()
    this.groupPresenceInFlight.clear()
  }

  private chatRetryDelayMs(retryCount: number): number {
    const normalized = Math.max(1, Math.trunc(retryCount))
    return Math.min(60_000, 1_500 * 2 ** Math.max(0, normalized - 1))
  }

  private isTransientChatError(message: string): boolean {
    const normalized = String(message || '').toLowerCase()
    if (!normalized) return false
    const transientSignals = [
      'timed out',
      'timeout',
      'worker reply timeout',
      'worker not running',
      'worker is not running',
      'worker became',
      'temporarily unavailable',
      'not initialized',
      'not ready',
      'connection',
      'network',
      'socket'
    ]
    return transientSignals.some((signal) => normalized.includes(signal))
  }

  private async fetchChatSnapshot(
    timeoutMs: number,
    label: string
  ): Promise<{ conversations: ChatConversation[]; invites: ChatInvite[] }> {
    const [conversations, invitesRaw] = await this.withTimeout(
      Promise.all([
        this.chatService.listConversations(),
        this.chatService.listInvites()
      ]),
      timeoutMs,
      label
    )

    const invites = this.chatService.filterActionableInvites(invitesRaw, {
      dismissedInviteIds: new Set(this.state.dismissedChatInviteIds),
      acceptedInviteIds: new Set(this.state.acceptedChatInviteIds),
      acceptedConversationIds: new Set(this.state.acceptedChatInviteConversationIds)
    })

    return {
      conversations,
      invites
    }
  }

  private scheduleChatRetry(delayMs: number, source: string): void {
    if (!this.state.session) return
    if (this.state.lifecycle !== 'ready') return
    if (!this.workerHost.isRunning()) return
    if (this.chatRetryTimer) return

    const waitMs = Math.max(300, Math.min(Math.trunc(delayMs), 60_000))
    this.chatRetryTimer = setTimeout(() => {
      this.chatRetryTimer = null
      this.patchState({ chatNextRetryAt: null })
      this.initializeChatsWithRecovery(`retry:${source}`).catch(() => {})
    }, waitMs)
  }

  private markChatsDegraded(message: string, source: string): void {
    const normalized = String(message || '').trim() || 'Unknown chat initialization issue'
    const retryCount = this.state.chatRetryCount + 1
    const delayMs = this.chatRetryDelayMs(retryCount)
    const nextRetryAt = Date.now() + delayMs
    const warning = `Chats running in degraded mode (${normalized})`
    const shouldWarnLog =
      this.state.chatRuntimeState !== 'degraded'
      || this.state.chatWarning !== warning

    this.patchState({
      chatRuntimeState: 'degraded',
      chatWarning: warning,
      chatRetryCount: retryCount,
      chatNextRetryAt: nextRetryAt,
      lastError: null
    })

    if (shouldWarnLog) {
      this.log('warn', `${warning}; retrying in ${Math.round(delayMs / 1000)}s [${source}]`)
    }

    this.scheduleChatRetry(delayMs, source)
  }

  private async initializeChatsWithRecovery(source: string): Promise<boolean> {
    if (!this.state.session) return false
    if (this.state.lifecycle !== 'ready') return false
    if (!this.workerHost.isRunning()) return false
    if (this.chatInitInFlight) return false

    this.chatInitInFlight = true
    this.patchState({
      chatRuntimeState: 'initializing',
      chatNextRetryAt: null,
      lastError: null
    })

    try {
      await this.withTimeout(
        this.chatService.init(this.currentRelayUrls()),
        15_000,
        'Chat init'
      )

      const snapshot = await this.fetchChatSnapshot(12_000, 'Chat sync')
      const wasDegraded = this.state.chatRuntimeState === 'degraded' || this.state.chatRetryCount > 0

      this.clearChatRetryTimer()
      this.patchState({
        conversations: snapshot.conversations,
        chatInvites: snapshot.invites,
        chatRuntimeState: 'ready',
        chatWarning: null,
        chatRetryCount: 0,
        chatNextRetryAt: null,
        lastError: null
      })

      if (wasDegraded) {
        this.log('info', 'Chat service recovered from degraded mode')
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.markChatsDegraded(message, source)
      return false
    } finally {
      this.chatInitInFlight = false
    }
  }

  private scheduleWorkerRecovery(exitCode: number): void {
    this.clearRecoveryTimer()
    if (!this.state.session) return
    if (!this.state.workerRecoveryState.enabled) return

    const nextAttempt = this.state.workerRecoveryState.attempt + 1
    if (nextAttempt > this.recoveryMaxAttempts) {
      this.patchState({
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'disabled',
          attempt: nextAttempt,
          nextDelayMs: 0,
          lastExitCode: exitCode,
          lastError: 'Max recovery attempts reached'
        }
      })
      return
    }

    const baseDelayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, nextAttempt - 1))
    const lockConflict = this.hasRecentWorkerLockSignal()
    if (lockConflict) {
      const lockMessage =
        'Storage is locked by another Hyperpipe worker instance. Close the other instance, then restart the worker.'
      this.patchState({
        lifecycle: 'error',
        readinessMessage: lockMessage,
        lastError: 'ELOCKED: File is locked',
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'disabled',
          attempt: nextAttempt,
          nextDelayMs: 0,
          lastExitCode: exitCode,
          lastError: lockMessage
        }
      })
      this.log('error', lockMessage)
      return
    }
    const dependencyConflict = this.hasRecentWorkerDependencyMismatchSignal()
    if (dependencyConflict) {
      const dependencyMessage =
        'Worker dependency mismatch detected (Hyperbee/Autobase runtime incompatibility). Run npm ci in the worker package and restart.'
      this.patchState({
        lifecycle: 'error',
        readinessMessage: dependencyMessage,
        lastError: dependencyMessage,
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'disabled',
          attempt: nextAttempt,
          nextDelayMs: 0,
          lastExitCode: exitCode,
          lastError: dependencyMessage
        }
      })
      this.log('error', dependencyMessage)
      return
    }
    const delayMs = baseDelayMs
    this.patchState({
      workerRecoveryState: {
        ...this.state.workerRecoveryState,
        status: 'scheduled',
        attempt: nextAttempt,
        nextDelayMs: delayMs,
        lastExitCode: exitCode,
        lastError: lockConflict ? 'Storage lock contention detected' : null
      },
      readinessMessage: `Worker exited (${exitCode}), reconnecting in ${Math.round(delayMs / 1000)}s`
    })

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      this.patchState({
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'recovering',
          nextDelayMs: 0
        }
      })

      this.startWorker()
        .catch((error) => {
          this.patchState({
            workerRecoveryState: {
              ...this.state.workerRecoveryState,
              status: 'idle',
              lastError: error instanceof Error ? error.message : String(error)
            }
          })
        })
        .finally(() => {
          if (this.state.lifecycle === 'ready') {
            this.patchState({
              workerRecoveryState: {
                ...this.state.workerRecoveryState,
                status: 'idle',
                attempt: 0,
                nextDelayMs: 0
              }
            })
          }
        })
    }, delayMs)
  }

  private async runTask<T>(
    name: string,
    task: () => Promise<T>,
    opts?: {
      dedupeKey?: string
      retries?: number
      retryBaseDelayMs?: number
    }
  ): Promise<T> {
    const startedAt = Date.now()
    const retries = Math.max(0, opts?.retries || 0)
    const retryBaseDelayMs = Math.max(50, opts?.retryBaseDelayMs || 300)

    const operationId = ++this.operationCounter
    const dedupeKey = opts?.dedupeKey?.trim()
    if (dedupeKey) {
      if (this.inFlightByKey.has(dedupeKey)) {
        this.state.perfMetrics = {
          ...this.state.perfMetrics,
          dedupedRequests: this.state.perfMetrics.dedupedRequests + 1,
          cancelledRequests: this.state.perfMetrics.cancelledRequests + 1
        }
      }
      this.inFlightByKey.set(dedupeKey, operationId)
    }

    this.state.perfMetrics = {
      ...this.state.perfMetrics,
      inFlight: this.state.perfMetrics.inFlight + 1,
      queueDepth: this.inFlightByKey.size
    }
    this.patchState({ busyTask: name, lastError: null })

    let attempts = 0
    try {
      while (attempts <= retries) {
        attempts += 1
        try {
          const result = await task()
          const durationMs = Date.now() - startedAt
          this.recordOperationSample({
            name,
            startedAt,
            durationMs,
            success: true,
            attempts
          })
          this.patchState({ busyTask: null })
          return result
        } catch (error) {
          if (attempts <= retries) {
            this.state.perfMetrics = {
              ...this.state.perfMetrics,
              retries: this.state.perfMetrics.retries + 1
            }
            const delayMs = retryBaseDelayMs * 2 ** Math.max(0, attempts - 1)
            await new Promise((resolve) => setTimeout(resolve, delayMs))
            continue
          }

          const durationMs = Date.now() - startedAt
          this.recordOperationSample({
            name,
            startedAt,
            durationMs,
            success: false,
            attempts
          })

          const message = error instanceof Error ? error.message : String(error)
          this.patchState({ busyTask: null, lastError: message })
          this.log('error', `${name}: ${message}`)
          throw error
        }
      }
    } finally {
      this.state.perfMetrics = {
        ...this.state.perfMetrics,
        inFlight: Math.max(0, this.state.perfMetrics.inFlight - 1),
        queueDepth: Math.max(0, this.inFlightByKey.size - (dedupeKey ? 1 : 0))
      }
      if (dedupeKey) {
        const current = this.inFlightByKey.get(dedupeKey)
        if (current && current !== operationId) {
          this.state.perfMetrics = {
            ...this.state.perfMetrics,
            staleResponseDrops: this.state.perfMetrics.staleResponseDrops + 1
          }
        }
        if (current === operationId) {
          this.inFlightByKey.delete(dedupeKey)
        }
      }
    }

    throw new Error(`Task failed: ${name}`)
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string
  ): Promise<T> {
    const timeout = Math.max(1_000, Math.min(Math.trunc(timeoutMs || 0), 300_000))
    let timeoutId: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeout}ms`))
        }, timeout)
      })
      ])
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  private async waitForLifecycleReady(timeoutMs = 30_000): Promise<void> {
    if (this.state.lifecycle === 'ready') return
    if (!this.workerHost.isRunning()) {
      throw new Error('Worker is not running')
    }

    const timeout = Math.max(1_000, Math.min(Math.trunc(timeoutMs), 300_000))

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      const interval = setInterval(() => {
        if (Date.now() - startedAt < timeout) return
        clearInterval(interval)
        this.emitter.off('change', onChange)
        reject(new Error(`Timed out waiting for worker ready after ${timeout}ms`))
      }, 200)

      const onChange = (): void => {
        if (this.state.lifecycle === 'ready') {
          clearInterval(interval)
          this.emitter.off('change', onChange)
          resolve()
          return
        }
        if (this.state.lifecycle === 'error' || this.state.lifecycle === 'stopped') {
          clearInterval(interval)
          this.emitter.off('change', onChange)
          reject(new Error(`Worker became ${this.state.lifecycle} while waiting for ready`))
        }
      }

      this.emitter.on('change', onChange)
      onChange()
    })
  }

  private async pause(ms: number): Promise<void> {
    const timeout = Math.max(25, Math.min(Math.trunc(ms), 60_000))
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), timeout)
    })
  }

  private isStorageLockErrorMessage(message: string): boolean {
    const normalized = String(message || '').toLowerCase()
    if (!normalized) return false
    return (
      normalized.includes('elocked')
      || normalized.includes('file is locked')
      || normalized.includes('primary-key is locked')
      || normalized.includes('storage lock')
    )
  }

  private isNonRetryableWorkerStartError(message: string): boolean {
    const normalized = String(message || '').toLowerCase()
    if (!normalized) return false
    return (
      normalized.includes('incompatible hyperpipe-worker dependency graph detected')
      || normalized.includes('worker dependency check failed')
      || normalized.includes('setinflightrange')
    )
  }

  private async ensureWorkerReadyForOperation(reason: string): Promise<void> {
    const session = this.state.session
    if (!session) {
      throw new Error(`Unable to run ${reason}: account session is locked`)
    }
    const maxAttempts = 3
    let lastError: string | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const shouldStart =
          !this.workerHost.isRunning()
          || this.state.lifecycle === 'stopped'
          || this.state.lifecycle === 'error'

        if (shouldStart) {
          await this.startWorker()
        }

        if (
          this.state.lifecycle === 'starting'
          || this.state.lifecycle === 'initializing'
          || this.state.lifecycle === 'stopping'
        ) {
          await this.waitForLifecycleReady(45_000)
        }

        if (this.workerHost.isRunning() && this.state.lifecycle === 'ready') {
          return
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (this.isNonRetryableWorkerStartError(lastError)) {
          this.log('error', `Worker start failed with non-retryable dependency/runtime error: ${lastError}`)
          break
        }
      }

      if (this.workerHost.isRunning() && this.state.lifecycle === 'ready') {
        return
      }

      if (attempt < maxAttempts) {
        const detail = lastError ? `: ${lastError}` : ''
        this.log(
          'warn',
          `Worker not ready for ${reason} (attempt ${attempt}/${maxAttempts})${detail}; restarting worker`
        )
        await this.stopWorker().catch(() => {})
        await this.pause(500)
      }
    }

    throw new Error(`Unable to run ${reason}: worker not ready${lastError ? ` (${lastError})` : ''}`)
  }

  private relayIdentityKey(entry: RelayEntry): string {
    const byIdentifier = String(entry.publicIdentifier || '').trim()
    if (byIdentifier) return byIdentifier
    return String(entry.relayKey || '').trim().toLowerCase()
  }

  private async reconcilePendingCreatedRelay(input: {
    name: string
    knownRelayKeys: Set<string>
    timeoutMs?: number
  }): Promise<{ publicIdentifier: string; relayUrl: string | null } | null> {
    const targetName = String(input.name || '').trim()
    if (!targetName) return null

    const timeoutMs = Math.max(
      10_000,
      Math.min(Math.trunc(input.timeoutMs || CREATE_RELAY_RECONCILE_TIMEOUT_MS), 300_000)
    )
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      this.localProfileCache = null
      await this.refreshRelays().catch(() => {})

      for (const relay of this.state.relays) {
        const identityKey = this.relayIdentityKey(relay)
        if (!identityKey || input.knownRelayKeys.has(identityKey)) continue
        const relayName = String(relay.name || '').trim()
        if (relayName !== targetName) continue
        const publicIdentifier = String(relay.publicIdentifier || '').trim()
        if (!publicIdentifier) continue
        return {
          publicIdentifier,
          relayUrl: this.resolveRelayUrl(relay.connectionUrl || undefined)
            || String(relay.connectionUrl || '').trim()
            || null
        }
      }

      const localProfiles = await this.readLocalRelayProfiles().catch(() => [])
      for (const profile of localProfiles) {
        const identityKey = profile.publicIdentifier || profile.relayKey
        if (!identityKey || input.knownRelayKeys.has(identityKey)) continue
        const profileName = String(profile.name || '').trim()
        if (profileName !== targetName) continue
        return {
          publicIdentifier: profile.publicIdentifier,
          relayUrl: this.resolveRelayUrl(profile.relayUrl || undefined)
            || String(profile.relayUrl || '').trim()
            || null
        }
      }

      await this.pause(CREATE_RELAY_RECONCILE_POLL_MS)
    }

    return null
  }

  async addNsecAccount(nsec: string, label?: string): Promise<void> {
    await this.runTask('Add nsec account', async () => {
      const added = await this.accountService.addNsecAccount(nsec, label)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: added.pubkey
      })
      await this.loadAccountScopedUiState(added.userKey)
    })
  }

  async addNcryptsecAccount(ncryptsec: string, password: string, label?: string): Promise<void> {
    await this.runTask('Add ncryptsec account', async () => {
      const added = await this.accountService.addNcryptsecAccount(ncryptsec, password, label)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: added.pubkey
      })
      await this.loadAccountScopedUiState(added.userKey)
    })
  }

  async generateNsecAccount(label?: string): Promise<{ pubkey: string; nsec: string; label?: string }> {
    return await this.runTask('Generate nsec account', async () => {
      const secret = generateSecretKey()
      const nsec = nip19.nsecEncode(secret)
      const added = await this.accountService.addNsecAccount(nsec, label)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: added.pubkey
      })
      await this.loadAccountScopedUiState(added.userKey)
      return {
        pubkey: added.pubkey,
        nsec,
        label: added.label
      }
    })
  }

  async listAccountProfiles(): Promise<Array<{
    pubkey: string
    label?: string
    signerType: 'nsec' | 'ncryptsec'
    isCurrent: boolean
  }>> {
    const current = this.accountService.getCurrentAccountPubkey()
    return this.accountService.listAccounts().map((account) => ({
      pubkey: account.pubkey,
      label: account.label,
      signerType: account.signerType,
      isCurrent: account.pubkey === current
    }))
  }

  async removeAccount(pubkey: string): Promise<void> {
    await this.runTask('Remove account', async () => {
      await this.accountService.removeAccount(pubkey)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: this.accountService.getCurrentAccountPubkey()
      })
      if (this.state.currentAccountPubkey === pubkey) {
        await this.stopWorker()
        this.resetGroupPresenceState()
        this.patchState({ session: null })
      }
    })
  }

  async selectAccount(pubkey: string): Promise<void> {
    await this.runTask('Select account', async () => {
      if (this.state.session && this.state.session.pubkey !== pubkey) {
        await this.workerHost.stop().catch(() => {})
        this.resetChatRuntimeState()
        this.resetGroupPresenceState()
        this.patchState({ session: null, lifecycle: 'stopped', readinessMessage: 'Stopped' })
      }
      await this.accountService.setCurrentAccount(pubkey)
      this.patchState({
        currentAccountPubkey: this.accountService.getCurrentAccountPubkey(),
        accounts: this.accountService.listAccounts()
      })
      await this.loadAccountScopedUiState(pubkey)
    })
  }

  async unlockCurrentAccount(getPassword?: () => Promise<string>): Promise<void> {
    await this.runTask('Unlock account', async () => {
      const currentPubkey = this.accountService.getCurrentAccountPubkey()
      if (!currentPubkey) {
        throw new Error('No current account selected')
      }

      const session = await this.accountService.unlockAccount(currentPubkey, getPassword)
      this.patchState({ session })
      await this.loadAccountScopedUiState(session.userKey)
      // Ensure the active account's latest profile metadata is available for dashboard rendering
      // even when the user has no discovered groups/invites to trigger profile enrichment.
      await this.ensureAdminProfiles([session.pubkey])
    })
  }

  async clearSession(): Promise<void> {
    await this.runTask('Clear session', async () => {
      this.clearRecoveryTimer()
      await this.workerHost.stop().catch(() => {})
      this.resetChatRuntimeState()
      this.resetGroupPresenceState()
      this.patchState({
        session: null,
        lifecycle: 'stopped',
        readinessMessage: 'Stopped'
      })
    })
  }

  async setDiscoveryRelayUrls(relays: string[]): Promise<void> {
    const normalized = uniqueRelayUrls(relays || [])
    const next = normalized.length ? normalized : uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS)
    this.patchState({ discoveryRelayUrls: next })
    await this.persistAccountScopedUiState({ discoveryRelays: next })
  }

  async publishProfileMetadata(input: {
    name: string
    about?: string
    relays?: string[]
  }): Promise<void> {
    await this.runTask('Publish profile metadata', async () => {
      const session = this.requireSession()
      const name = String(input.name || '').trim()
      if (!name) {
        throw new Error('Profile name is required')
      }
      const about = String(input.about || '').trim()
      const metadata = {
        name,
        ...(about ? { about } : {})
      }
      const draft: EventTemplate = {
        kind: 0,
        created_at: eventNow(),
        tags: [],
        content: JSON.stringify(metadata)
      }
      const event = signDraftEvent(session.nsecHex, draft)
      const targets = uniqueRelayUrls(
        input.relays && input.relays.length > 0
          ? input.relays
          : this.searchableRelayUrls(16)
      )
      await this.nostrClient.publish(targets, event)
      await this.upsertAdminProfiles([{
        pubkey: session.pubkey,
        name,
        bio: about || null,
        followersCount: this.state.adminProfileByPubkey[session.pubkey]?.followersCount ?? null
      }], {
        persist: true
      })
    })
  }

  async setLastCopied(
    value: string,
    method: ClipboardCopyResult['method']
  ): Promise<void> {
    const normalizedValue = String(value || '')
    const normalizedMethod = method || 'none'
    this.patchState({
      lastCopiedValue: normalizedValue || null,
      lastCopiedMethod: normalizedMethod
    })
    try {
      await this.uiStateStore.patchState({
        lastCopiedValue: normalizedValue,
        lastCopiedMethod: normalizedMethod
      })
    } catch (_error) {
      // best effort persistence only
    }
  }

  async setGroupViewTab(tab: GroupViewTab): Promise<void> {
    const nextTab: GroupViewTab = tab === 'my' ? 'my' : 'discover'
    this.patchState({ groupViewTab: nextTab })
    await this.persistAccountScopedUiState({ groupViewTab: nextTab })
  }

  async setChatViewTab(tab: ChatViewTab): Promise<void> {
    const nextTab: ChatViewTab = ['conversations', 'invites'].includes(tab) ? tab : 'conversations'
    this.patchState({ chatViewTab: nextTab })
    await this.persistAccountScopedUiState({ chatViewTab: nextTab })
  }

  async setSelectedNode(nodeId: NavNodeId): Promise<void> {
    if (this.state.selectedNode === nodeId) return
    this.patchState({ selectedNode: nodeId })
    if (nodeId === 'groups:browse' || nodeId === 'groups:my') {
      void this.refreshVisibleGroupPresence().catch(() => {})
    }
    await this.persistAccountScopedUiState({ selectedNode: nodeId })
  }

  async setFocusPane(focusPane: PaneFocus): Promise<void> {
    if (this.state.focusPane === focusPane) return
    this.patchState({ focusPane })
    await this.persistAccountScopedUiState({ focusPane })
  }

  async setTreeExpanded(nextExpanded: {
    groups: boolean
    chats: boolean
    invites: boolean
    files: boolean
  }): Promise<void> {
    const normalized = {
      groups: Boolean(nextExpanded.groups),
      chats: Boolean(nextExpanded.chats),
      invites: Boolean(nextExpanded.invites),
      files: Boolean(nextExpanded.files)
    }
    const prev = this.state.treeExpanded
    if (
      prev.groups === normalized.groups
      && prev.chats === normalized.chats
      && prev.invites === normalized.invites
      && prev.files === normalized.files
    ) {
      return
    }
    this.patchState({ treeExpanded: normalized })
    await this.persistAccountScopedUiState({ treeExpanded: normalized })
  }

  async setPaneViewport(sectionKey: string, cursor: number, offset: number): Promise<void> {
    const key = String(sectionKey || '').trim()
    if (!key) return
    const normalizedCursor = Math.max(0, Math.trunc(cursor))
    const normalizedOffset = Math.max(0, Math.trunc(offset))
    const existing = this.state.paneViewport[key]
    if (existing && existing.cursor === normalizedCursor && existing.offset === normalizedOffset) {
      return
    }
    const next = {
      ...this.state.paneViewport,
      [key]: {
        cursor: normalizedCursor,
        offset: normalizedOffset
      }
    }
    const nextNodeViewport = {
      ...this.state.nodeViewport,
      [key]: {
        cursor: normalizedCursor,
        offset: normalizedOffset
      }
    }
    this.patchState({ paneViewport: next, nodeViewport: nextNodeViewport })
    await this.persistAccountScopedUiState({
      paneViewport: next,
      nodeViewport: nextNodeViewport
    })
  }

  async setDetailPaneOffset(sectionKey: string, offset: number): Promise<void> {
    const key = String(sectionKey || '').trim()
    if (!key) return
    const normalizedOffset = Math.max(0, Math.trunc(offset))
    const existing = this.state.detailPaneOffsetBySection[key]
    if (typeof existing === 'number' && existing === normalizedOffset) {
      return
    }
    const next = {
      ...this.state.detailPaneOffsetBySection,
      [key]: normalizedOffset
    }
    const nextRightBottom = {
      ...this.state.rightBottomOffsetByNode,
      [key]: normalizedOffset
    }
    this.patchState({
      detailPaneOffsetBySection: next,
      rightBottomOffsetByNode: nextRightBottom
    })
    await this.persistAccountScopedUiState({
      detailPaneOffsetBySection: next,
      rightBottomOffsetByNode: nextRightBottom
    })
  }

  async setRightTopSelection(nodeId: string, index: number): Promise<void> {
    const key = String(nodeId || '').trim()
    if (!key) return
    const normalizedIndex = Math.max(0, Math.trunc(index))
    const existing = this.state.rightTopSelectionByNode[key]
    if (existing === normalizedIndex) return
    const next = {
      ...this.state.rightTopSelectionByNode,
      [key]: normalizedIndex
    }
    this.patchState({ rightTopSelectionByNode: next })
    if (key === 'groups:browse' || key === 'groups:my') {
      void this.refreshVisibleGroupPresence().catch(() => {})
    }
    await this.persistAccountScopedUiState({ rightTopSelectionByNode: next })
  }

  async setPerfOverlay(enabled: boolean): Promise<void> {
    this.patchState({
      perfMetrics: {
        ...this.state.perfMetrics,
        overlayEnabled: Boolean(enabled)
      }
    })
    await this.persistAccountScopedUiState({ perfOverlayEnabled: Boolean(enabled) })
  }

  perfSnapshot(): PerfMetrics {
    return {
      ...this.state.perfMetrics,
      operationSamples: this.state.perfMetrics.operationSamples.map((sample) => ({ ...sample }))
    }
  }

  private applyFeedControls(feed: FeedItem[]): FeedItem[] {
    const controls = this.state.feedControls
    const query = controls.query.trim().toLowerCase()
    const kindSet = controls.kindFilter && controls.kindFilter.length
      ? new Set(controls.kindFilter)
      : null

    const filtered = feed.filter((event) => {
      if (kindSet && !kindSet.has(event.kind)) return false
      if (!query) return true
      if (event.content.toLowerCase().includes(query)) return true
      if (event.id.toLowerCase().includes(query)) return true
      if (event.pubkey.toLowerCase().includes(query)) return true
      return event.tags.some((tag) => tag.some((part) => String(part || '').toLowerCase().includes(query)))
    })

    const direction = controls.sortDirection === 'asc' ? 1 : -1
    filtered.sort((left, right) => {
      switch (controls.sortKey) {
        case 'kind':
          return direction * (left.kind - right.kind)
        case 'author':
          return direction * left.pubkey.localeCompare(right.pubkey)
        case 'content':
          return direction * left.content.localeCompare(right.content)
        case 'createdAt':
        default:
          if (left.created_at !== right.created_at) {
            return direction * (left.created_at - right.created_at)
          }
          return direction * left.id.localeCompare(right.id)
      }
    })

    return filtered
  }

  private applyGroupControls(groups: GroupSummary[]): GroupSummary[] {
    const controls = this.state.groupControls
    const query = controls.query.trim().toLowerCase()
    const filtered = groups.filter((group) => {
      if (controls.visibility === 'public' && group.isPublic === false) return false
      if (controls.visibility === 'private' && group.isPublic !== false) return false
      if (controls.joinMode === 'open' && group.isOpen === false) return false
      if (controls.joinMode === 'closed' && group.isOpen !== false) return false
      if (!query) return true
      const fields = [
        group.name,
        group.about || '',
        group.id,
        group.adminName || '',
        group.adminPubkey || ''
      ]
      return fields.some((value) => String(value || '').toLowerCase().includes(query))
    })

    const direction = controls.sortDirection === 'asc' ? 1 : -1
    filtered.sort((left, right) => {
      const leftAdmin = (left.adminName || left.adminPubkey || '').toLowerCase()
      const rightAdmin = (right.adminName || right.adminPubkey || '').toLowerCase()
      const leftCreatedAt = Number(left.createdAt || left.event?.created_at || 0)
      const rightCreatedAt = Number(right.createdAt || right.event?.created_at || 0)
      const leftMembers = Number(left.membersCount || left.members?.length || 0)
      const rightMembers = Number(right.membersCount || right.members?.length || 0)
      const leftPresence = left.peerPresence || this.groupPresenceForGroup(left.id, left.relay)
      const rightPresence = right.peerPresence || this.groupPresenceForGroup(right.id, right.relay)
      const leftPeers = Number.isFinite(leftPresence.count) ? Number(leftPresence.count) : -1
      const rightPeers = Number.isFinite(rightPresence.count) ? Number(rightPresence.count) : -1
      const leftPresenceBucket = leftPresence.status === 'ready' && Number.isFinite(leftPresence.count)
        ? 0
        : leftPresence.status === 'scanning'
          ? 1
          : 2
      const rightPresenceBucket = rightPresence.status === 'ready' && Number.isFinite(rightPresence.count)
        ? 0
        : rightPresence.status === 'scanning'
          ? 1
          : 2

      switch (controls.sortKey) {
        case 'name':
          return direction * left.name.localeCompare(right.name)
        case 'description':
          return direction * String(left.about || '').localeCompare(String(right.about || ''))
        case 'open':
          return direction * ((left.isOpen ? 1 : 0) - (right.isOpen ? 1 : 0))
        case 'public':
          return direction * ((left.isPublic === false ? 0 : 1) - (right.isPublic === false ? 0 : 1))
        case 'admin':
          return direction * leftAdmin.localeCompare(rightAdmin)
        case 'createdAt':
          return direction * (leftCreatedAt - rightCreatedAt)
        case 'peers':
          if (leftPresenceBucket !== rightPresenceBucket) {
            return leftPresenceBucket - rightPresenceBucket
          }
          return direction * (leftPeers - rightPeers)
        case 'members':
        default:
          return direction * (leftMembers - rightMembers)
      }
    })

    return filtered
  }

  private applyFileControls(files: GroupFileRecord[]): GroupFileRecord[] {
    const controls = this.state.fileControls
    const query = controls.query.trim().toLowerCase()
    const mimeQuery = controls.mime.trim().toLowerCase()
    const hiddenKeys = new Set(this.state.hiddenDeletedFileKeys)
    const filtered = files.filter((record) => {
      if (hiddenKeys.has(normalizeFileRecordKey(record))) return false
      if (controls.group !== 'all' && record.groupId !== controls.group) return false
      if (mimeQuery !== 'all') {
        const mime = String(record.mime || '').toLowerCase()
        if (!mime.startsWith(mimeQuery)) return false
      }
      if (!query) return true
      const fields = [
        record.fileName,
        record.groupId,
        record.groupName || '',
        record.url || '',
        record.uploadedBy,
        record.mime || '',
        record.sha256 || ''
      ]
      return fields.some((value) => String(value || '').toLowerCase().includes(query))
    })

    const direction = controls.sortDirection === 'asc' ? 1 : -1
    filtered.sort((left, right) => {
      switch (controls.sortKey) {
        case 'fileName':
          return direction * left.fileName.localeCompare(right.fileName)
        case 'group':
          return direction * String(left.groupName || left.groupId).localeCompare(String(right.groupName || right.groupId))
        case 'uploadedBy':
          return direction * left.uploadedBy.localeCompare(right.uploadedBy)
        case 'size':
          return direction * (Number(left.size || 0) - Number(right.size || 0))
        case 'mime':
          return direction * String(left.mime || '').localeCompare(String(right.mime || ''))
        case 'uploadedAt':
        default:
          return direction * (left.uploadedAt - right.uploadedAt)
      }
    })

    return filtered
  }

  private syncFeedView(): void {
    const next = this.applyFeedControls(this.rawFeed)
    this.patchState({ feed: next })
  }

  private syncGroupView(): void {
    const withLivePeers = this.rawGroupDiscover.map((group) => this.applyGroupPresenceToGroup({
      ...group,
      membersCount: Number(group.membersCount || group.members?.length || 0)
    }))
    const next = this.applyGroupControls(withLivePeers)
    this.patchState({
      groups: next,
      groupDiscover: next
    })
    void this.refreshVisibleGroupPresence().catch(() => {})
  }

  private syncFilesView(): void {
    const next = this.applyFileControls(this.rawFiles)
    const grouped: Record<string, GroupFileRecord[]> = {}
    for (const record of next) {
      const key = groupScopeKey(record.groupId, record.groupRelay || null)
      const rows = grouped[key] || []
      rows.push(record)
      grouped[key] = rows
    }
    this.patchState({
      files: next,
      groupFilesByGroupKey: grouped
    })
  }

  private normalizeSortDirection(direction?: string): SortDirection {
    return String(direction || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
  }

  async setFeedSource(input: FeedSourceState): Promise<void> {
    const next: FeedSourceState = {
      mode: input.mode,
      relayUrl: input.relayUrl || null,
      groupId: input.groupId || null,
      label: input.label || undefined
    }
    this.patchState({ feedSource: next })
    await this.persistAccountScopedUiState({ feedSource: next })
    await this.refreshFeed(this.feedLimit)
  }

  async setFeedSourceRelays(): Promise<void> {
    await this.setFeedSource({
      mode: 'relays',
      relayUrl: null,
      groupId: null,
      label: 'All Relays'
    })
  }

  async setFeedSourceFollowing(): Promise<void> {
    await this.setFeedSource({
      mode: 'following',
      relayUrl: null,
      groupId: null,
      label: 'Following'
    })
  }

  async setFeedSourceRelaySelector(selector: string): Promise<void> {
    const normalized = String(selector || '').trim()
    if (!normalized) {
      throw new Error('Relay selector is required')
    }
    const relayUrl = this.resolveRelayUrl(normalized)
    if (!relayUrl) {
      throw new Error(`Unable to resolve relay selector: ${normalized}`)
    }
    await this.setFeedSource({
      mode: 'relay',
      relayUrl,
      groupId: null,
      label: relayUrl
    })
  }

  private resolveGroupSelector(selector: string): { groupId: string; relay?: string | null } | null {
    const normalized = String(selector || '').trim()
    if (!normalized) return null
    if (/^\d+$/.test(normalized)) {
      const index = Math.max(0, Number.parseInt(normalized, 10) - 1)
      const fromMyGroups = this.state.myGroups[index] || this.state.groupDiscover[index]
      if (!fromMyGroups) return null
      return {
        groupId: fromMyGroups.id,
        relay: fromMyGroups.relay || null
      }
    }
    const direct = this.state.groupDiscover.find((group) => group.id === normalized)
      || this.state.myGroups.find((group) => group.id === normalized)
    if (direct) {
      return {
        groupId: direct.id,
        relay: direct.relay || null
      }
    }
    return {
      groupId: normalized,
      relay: null
    }
  }

  async setFeedSourceGroupSelector(selector: string, relay?: string): Promise<void> {
    const resolved = this.resolveGroupSelector(selector)
    if (!resolved?.groupId) {
      throw new Error(`Unable to resolve group selector: ${selector}`)
    }
    const relayUrl = this.resolveGroupRelayUrl(resolved.groupId, relay || resolved.relay || null)
    await this.setFeedSource({
      mode: 'group',
      groupId: resolved.groupId,
      relayUrl: relayUrl || relay || resolved.relay || null,
      label: resolved.groupId
    })
  }

  async setFeedSearch(query: string): Promise<void> {
    const next = {
      ...this.state.feedControls,
      query: String(query || '').trim()
    }
    this.patchState({ feedControls: next })
    await this.persistAccountScopedUiState({ feedControls: next })
    this.syncFeedView()
  }

  async setFeedSort(sortKey: FeedSortKey, direction?: string): Promise<void> {
    const next = {
      ...this.state.feedControls,
      sortKey,
      sortDirection: direction ? this.normalizeSortDirection(direction) : this.state.feedControls.sortDirection
    }
    this.patchState({ feedControls: next })
    await this.persistAccountScopedUiState({ feedControls: next })
    this.syncFeedView()
  }

  async setFeedKindFilter(kinds: number[] | null): Promise<void> {
    const uniqueKinds = kinds && kinds.length
      ? Array.from(new Set(kinds.map((kind) => Number(kind)).filter(Number.isFinite)))
      : null
    const next = {
      ...this.state.feedControls,
      kindFilter: uniqueKinds
    }
    this.patchState({ feedControls: next })
    await this.persistAccountScopedUiState({ feedControls: next })
    this.syncFeedView()
  }

  async setGroupSearch(query: string): Promise<void> {
    const next = {
      ...this.state.groupControls,
      query: String(query || '').trim()
    }
    this.patchState({ groupControls: next })
    await this.persistAccountScopedUiState({ groupControls: next })
    this.syncGroupView()
  }

  async setGroupSort(sortKey: GroupSortKey, direction?: string): Promise<void> {
    const next = {
      ...this.state.groupControls,
      sortKey,
      sortDirection: direction ? this.normalizeSortDirection(direction) : this.state.groupControls.sortDirection
    }
    this.patchState({ groupControls: next })
    await this.persistAccountScopedUiState({ groupControls: next })
    this.syncGroupView()
  }

  async setGroupVisibilityFilter(visibility: GroupControls['visibility']): Promise<void> {
    const next = {
      ...this.state.groupControls,
      visibility
    }
    this.patchState({ groupControls: next })
    await this.persistAccountScopedUiState({ groupControls: next })
    this.syncGroupView()
  }

  async setGroupJoinFilter(joinMode: GroupControls['joinMode']): Promise<void> {
    const next = {
      ...this.state.groupControls,
      joinMode
    }
    this.patchState({ groupControls: next })
    await this.persistAccountScopedUiState({ groupControls: next })
    this.syncGroupView()
  }

  async setFileSearch(query: string): Promise<void> {
    const next = {
      ...this.state.fileControls,
      query: String(query || '').trim()
    }
    this.patchState({ fileControls: next })
    await this.persistAccountScopedUiState({ fileControls: next })
    this.syncFilesView()
  }

  async setFileSort(sortKey: FileSortKey, direction?: string): Promise<void> {
    const next = {
      ...this.state.fileControls,
      sortKey,
      sortDirection: direction ? this.normalizeSortDirection(direction) : this.state.fileControls.sortDirection
    }
    this.patchState({ fileControls: next })
    await this.persistAccountScopedUiState({ fileControls: next })
    this.syncFilesView()
  }

  async setFileMimeFilter(mime: string): Promise<void> {
    const next = {
      ...this.state.fileControls,
      mime: String(mime || '').trim() || 'all'
    }
    this.patchState({ fileControls: next })
    await this.persistAccountScopedUiState({ fileControls: next })
    this.syncFilesView()
  }

  async setFileGroupFilter(group: string): Promise<void> {
    const next = {
      ...this.state.fileControls,
      group: String(group || '').trim() || 'all'
    }
    this.patchState({ fileControls: next })
    await this.persistAccountScopedUiState({ fileControls: next })
    this.syncFilesView()
  }

  private normalizeRelayForCompare(value?: string | null): string {
    const normalized = String(value || '').trim()
    if (!normalized) return ''
    try {
      return getBaseRelayUrl(normalized)
    } catch {
      return normalized
    }
  }

  private parseGatewayPeerCounts(status: unknown): Record<string, number> {
    if (!status || typeof status !== 'object') return {}
    const rawMap = (status as { peerRelayMap?: Record<string, { peerCount?: number; peers?: unknown[] }> }).peerRelayMap
    if (!rawMap || typeof rawMap !== 'object') return {}

    const output: Record<string, number> = {}
    for (const [key, value] of Object.entries(rawMap)) {
      const peerCount = Number(value?.peerCount)
      if (Number.isFinite(peerCount) && peerCount >= 0) {
        output[key] = Math.max(output[key] || 0, peerCount)
        continue
      }
      const peers = Array.isArray(value?.peers) ? value.peers.length : 0
      output[key] = Math.max(output[key] || 0, peers)
    }
    return output
  }

  private parseGatewayPeerRelayMap(status: unknown): Record<string, string[]> {
    if (!status || typeof status !== 'object') return {}
    const rawMap = (status as { peerRelayMap?: Record<string, { peers?: unknown[] }> }).peerRelayMap
    if (!rawMap || typeof rawMap !== 'object') return {}

    const output: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(rawMap)) {
      const peers = Array.isArray(value?.peers)
        ? value.peers
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter(Boolean)
        : []
      output[key] = Array.from(new Set(peers))
    }
    return output
  }

  private parseDiscoveredGateways(input: unknown): DiscoveredGateway[] {
    if (!Array.isArray(input)) return []
    const byId = new Map<string, DiscoveredGateway>()
    const normalizeOrigin = (value: unknown): string | null => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      if (!trimmed) return null
      try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        return parsed.origin
      } catch {
        return null
      }
    }

    for (const row of input) {
      if (!row || typeof row !== 'object') continue
      const source = row as Record<string, unknown>
      const gatewayId = typeof source.gatewayId === 'string'
        ? source.gatewayId.trim().toLowerCase()
        : ''
      const publicUrl = normalizeOrigin(source.publicUrl || source.gatewayOrigin || null)
      if (!gatewayId || !publicUrl) continue
      const item: DiscoveredGateway = {
        gatewayId,
        publicUrl,
        displayName: typeof source.displayName === 'string' ? source.displayName.trim() || null : null,
        region: typeof source.region === 'string' ? source.region.trim() || null : null,
        source: typeof source.source === 'string' ? source.source.trim() || null : null,
        isExpired: source.isExpired === true,
        lastSeenAt: Number.isFinite(Number(source.lastSeenAt)) ? Number(source.lastSeenAt) : null,
        authMethod: typeof source.authMethod === 'string' ? source.authMethod.trim() || null : null,
        hostPolicy: typeof source.hostPolicy === 'string' ? source.hostPolicy.trim() || null : null,
        memberDelegationMode: typeof source.memberDelegationMode === 'string'
          ? source.memberDelegationMode.trim() || null
          : null,
        operatorPubkey: typeof source.operatorPubkey === 'string' ? source.operatorPubkey.trim() || null : null,
        operatorIdentity: parseGatewayOperatorIdentity(source.operatorIdentity)
      }
      const previous = byId.get(gatewayId)
      if (!previous) {
        byId.set(gatewayId, item)
        continue
      }
      const prevSeen = Number(previous.lastSeenAt || 0)
      const nextSeen = Number(item.lastSeenAt || 0)
      if (nextSeen >= prevSeen) {
        byId.set(gatewayId, item)
      }
    }

    return Array.from(byId.values())
      .filter((item) => item.isExpired !== true)
      .sort((left, right) => {
        const byName = String(left.displayName || left.gatewayId).localeCompare(String(right.displayName || right.gatewayId))
        if (byName !== 0) return byName
        return String(left.publicUrl).localeCompare(String(right.publicUrl))
      })
  }

  private parseGatewayAccessCatalog(input: unknown): GatewayAccessState[] {
    if (!Array.isArray(input)) return []
    const normalizeOrigin = (value: unknown): string | null => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      if (!trimmed) return null
      try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        return parsed.origin
      } catch {
        return null
      }
    }

    return input
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const source = row as Record<string, unknown>
        return {
          gatewayId: typeof source.gatewayId === 'string' ? source.gatewayId.trim().toLowerCase() : null,
          gatewayOrigin: normalizeOrigin(source.gatewayOrigin),
          hostingState: typeof source.hostingState === 'string' ? source.hostingState.trim() : 'unknown',
          reason: typeof source.reason === 'string' ? source.reason.trim() || null : null,
          lastCheckedAt: Number.isFinite(Number(source.lastCheckedAt)) ? Number(source.lastCheckedAt) : null,
          memberDelegationMode: typeof source.memberDelegationMode === 'string'
            ? source.memberDelegationMode.trim() || null
            : null,
          authMethod: typeof source.authMethod === 'string' ? source.authMethod.trim() || null : null,
          operatorIdentity: parseGatewayOperatorIdentity(source.operatorIdentity),
          policy: source.policy && typeof source.policy === 'object'
            ? {
                hostPolicy: typeof (source.policy as Record<string, unknown>).hostPolicy === 'string'
                  ? String((source.policy as Record<string, unknown>).hostPolicy).trim() || null
                  : null,
                authMethod: typeof (source.policy as Record<string, unknown>).authMethod === 'string'
                  ? String((source.policy as Record<string, unknown>).authMethod).trim() || null
                  : null,
                openAccess: (source.policy as Record<string, unknown>).openAccess === true,
                operatorPubkey: typeof (source.policy as Record<string, unknown>).operatorPubkey === 'string'
                  ? String((source.policy as Record<string, unknown>).operatorPubkey).trim() || null
                  : null,
                wotRootPubkey: typeof (source.policy as Record<string, unknown>).wotRootPubkey === 'string'
                  ? String((source.policy as Record<string, unknown>).wotRootPubkey).trim() || null
                  : null,
                wotMaxDepth: Number.isFinite(Number((source.policy as Record<string, unknown>).wotMaxDepth))
                  ? Number((source.policy as Record<string, unknown>).wotMaxDepth)
                  : null,
                wotMinFollowersDepth2: Number.isFinite(Number((source.policy as Record<string, unknown>).wotMinFollowersDepth2))
                  ? Number((source.policy as Record<string, unknown>).wotMinFollowersDepth2)
                  : null,
                capabilities: Array.isArray((source.policy as Record<string, unknown>).capabilities)
                  ? ((source.policy as Record<string, unknown>).capabilities as unknown[])
                    .filter((value) => typeof value === 'string')
                    .map((value) => String(value))
                  : []
              }
            : null
        } as GatewayAccessState
      })
      .filter((entry): entry is GatewayAccessState => Boolean(entry && (entry.gatewayId || entry.gatewayOrigin)))
      .sort((left, right) => {
        const byState = String(left.hostingState || '').localeCompare(String(right.hostingState || ''))
        if (byState !== 0) return byState
        return String(left.gatewayOrigin || left.gatewayId || '').localeCompare(String(right.gatewayOrigin || right.gatewayId || ''))
      })
  }

  private findGatewayInList(list: DiscoveredGateway[], gatewaySelector: string | null | undefined): DiscoveredGateway | null {
    const selector = String(gatewaySelector || '').trim()
    if (!selector) return null
    const normalized = selector.toLowerCase()
    const directId = list.find((gateway) => gateway.gatewayId === normalized)
    if (directId) return directId
    if (/^\d+$/.test(selector)) {
      const index = Number.parseInt(selector, 10)
      if (Number.isFinite(index) && index >= 0 && index < list.length) {
        return list[index] || null
      }
    }
    return null
  }

  private findDiscoveredGateway(gatewaySelector: string | null | undefined): DiscoveredGateway | null {
    return this.findGatewayInList(this.state.discoveredGateways, gatewaySelector)
  }

  private findAuthorizedGateway(gatewaySelector: string | null | undefined): DiscoveredGateway | null {
    return this.findGatewayInList(this.state.authorizedGateways, gatewaySelector)
  }

  private warmGatewayOperatorProfiles(gateways: DiscoveredGateway[]): void {
    const pubkeys = Array.from(
      new Set(
        gateways
          .map((gateway) => String(gateway.operatorIdentity?.pubkey || '').trim().toLowerCase())
          .filter((pubkey) => isHex64String(pubkey))
      )
    )
    if (!pubkeys.length) return
    void this.ensureAdminProfiles(pubkeys).catch(() => {
      // optional enrichment only
    })
  }

  private async awaitWorkerMessage(
    predicate: (event: Record<string, unknown>) => boolean,
    sendAction: () => Promise<{ success: boolean; error?: string }>,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const timeout = Math.max(1_000, Math.min(timeoutMs, 300_000))
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const off = this.workerHost.onMessage((event) => {
        const message = event as Record<string, unknown>
        if (!predicate(message)) return
        clearTimeout(timeoutId)
        off()
        resolve(message)
      })

      const timeoutId = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for worker event after ${timeout}ms`))
      }, timeout)

      void sendAction()
        .then((result) => {
          if (result.success) return
          clearTimeout(timeoutId)
          off()
          reject(new Error(result.error || 'Worker request failed'))
        })
        .catch((error) => {
          clearTimeout(timeoutId)
          off()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  async refreshGatewayCatalog(options?: { force?: boolean; timeoutMs?: number }): Promise<DiscoveredGateway[]> {
    if (!this.workerHost.isRunning()) {
      return this.state.authorizedGateways.length ? this.state.authorizedGateways : this.state.discoveredGateways
    }

    const timeoutMs = Number.isFinite(options?.timeoutMs) ? Number(options?.timeoutMs) : 4_500
    try {
      const event = await this.awaitWorkerMessage(
        (msg) => msg.type === 'public-gateway-status',
        () => options?.force
          ? this.workerHost.send({ type: 'refresh-public-gateway-all' })
          : this.workerHost.send({ type: 'get-public-gateway-status' }),
        timeoutMs
      )
      const state = (event as { state?: unknown }).state
      const discoveredGateways = this.parseDiscoveredGateways(
        (state as { discoveredGateways?: unknown } | null | undefined)?.discoveredGateways
      )
      const authorizedGateways = this.parseDiscoveredGateways(
        (state as { authorizedGateways?: unknown } | null | undefined)?.authorizedGateways
      )
      const gatewayAccessCatalog = this.parseGatewayAccessCatalog(
        (state as { gatewayAccessCatalog?: unknown } | null | undefined)?.gatewayAccessCatalog
      )
      this.patchState({ discoveredGateways, authorizedGateways, gatewayAccessCatalog })
      this.warmGatewayOperatorProfiles(authorizedGateways.length ? authorizedGateways : discoveredGateways)
      return authorizedGateways.length ? authorizedGateways : discoveredGateways
    } catch {
      return this.state.authorizedGateways.length ? this.state.authorizedGateways : this.state.discoveredGateways
    }
  }

  private resolveGatewayHostPeers(args: {
    publicIdentifier?: string | null
    relayKey?: string | null
    relayUrl?: string | null
  }): string[] {
    const candidates = new Set<string>()
    const identifier = String(args.publicIdentifier || '').trim()
    for (const variant of this.relayIdentifierVariants(identifier)) {
      candidates.add(variant)
      candidates.add(variant.replace(':', '/'))
      candidates.add(variant.replace('/', ':'))
    }

    const relayKey = String(args.relayKey || '').trim().toLowerCase()
    if (relayKey) {
      candidates.add(relayKey)
    }

    const relayUrl = this.resolveRelayUrl(args.relayUrl || undefined)
    if (relayUrl) {
      const normalized = this.normalizeRelayForCompare(relayUrl)
      if (normalized) candidates.add(normalized)
      try {
        const parsed = new URL(relayUrl)
        const relayPath = parsed.pathname.replace(/^\/+/, '')
        if (relayPath) {
          candidates.add(relayPath)
          candidates.add(relayPath.replace('/', ':'))
          candidates.add(relayPath.replace(':', '/'))
        }
      } catch {
        // ignore invalid relay URL parsing
      }
    }

    const peers = new Set<string>()
    for (const [key, entries] of Object.entries(this.gatewayPeerRelayMap)) {
      if (!Array.isArray(entries) || entries.length === 0) continue
      const normalizedKey = String(key || '').trim()
      if (!normalizedKey) continue
      const matches = Array.from(candidates).some((candidate) => {
        if (!candidate) return false
        if (normalizedKey === candidate) return true
        if (normalizedKey.includes(candidate)) return true
        if (candidate.includes(normalizedKey)) return true
        return false
      })
      if (!matches) continue
      for (const peer of entries) {
        const normalizedPeer = String(peer || '').trim().toLowerCase()
        if (normalizedPeer) peers.add(normalizedPeer)
      }
    }
    return Array.from(peers)
  }

  private async refreshGatewayStatusSnapshot(timeoutMs = 3_500): Promise<{ running: boolean }> {
    await this.workerHost.send({ type: 'get-gateway-status' }).catch(() => {})
    try {
      const event = await waitForWorkerEvent(
        this.workerHost,
        (msg) => msg.type === 'gateway-status',
        timeoutMs
      )
      const status = (event as { status?: unknown }).status
      const gatewayPeerCounts = this.parseGatewayPeerCounts(status)
      const gatewayPeerRelayMap = this.parseGatewayPeerRelayMap(status)
      this.gatewayPeerRelayMap = gatewayPeerRelayMap
      this.patchState({ gatewayPeerCounts })
      const running = Boolean((status as { running?: boolean } | null | undefined)?.running)
      return { running }
    } catch {
      return { running: false }
    }
  }

  private async ensureGatewayParityReady(args?: {
    reason?: string
    refreshPublicGateway?: boolean
  }): Promise<void> {
    if (!this.workerHost.isRunning()) return

    const reason = String(args?.reason || 'relay-op').trim() || 'relay-op'
    const initial = await this.refreshGatewayStatusSnapshot(3_500)
    if (!initial.running) {
      this.log('debug', `Gateway not running before ${reason}; starting gateway`)
      await this.workerHost.send({ type: 'start-gateway', options: {} }).catch(() => {})
      await this.refreshGatewayStatusSnapshot(8_000)
    }

    await this.refreshGatewayCatalog({
      force: args?.refreshPublicGateway === true,
      timeoutMs: 4_500
    }).catch(() => {})
  }

  private isNonFatalWorkerError(message: string): boolean {
    const normalized = String(message || '').toLowerCase()
    return normalized.includes('relay profile not found')
  }

  private hasRecentWorkerLockSignal(): boolean {
    const recentLines = [
      ...this.workerStderrQueue.slice(-60),
      ...this.state.workerStderr.slice(-120)
    ]
    if (!recentLines.length) return false
    return recentLines.some((line) => {
      const normalized = String(line || '').toLowerCase()
      return (
        normalized.includes('elocked')
        || normalized.includes('primary-key is locked')
        || (normalized.includes('file is locked') && normalized.includes('primary-key'))
      )
    })
  }

  private hasRecentWorkerDependencyMismatchSignal(): boolean {
    const recentLines = [
      ...this.workerStderrQueue.slice(-80),
      ...this.state.workerStderr.slice(-160)
    ]
    if (!recentLines.length) return false
    return recentLines.some((line) => {
      const normalized = String(line || '').toLowerCase()
      return (
        normalized.includes("cannot read properties of undefined (reading 'setinflightrange')")
        || normalized.includes('node_modules/hyperbee/index.js')
        || normalized.includes('setinflightrange')
      )
    })
  }

  private groupPresenceKey(groupId?: string | null, relay?: string | null): string {
    const normalizedGroupId = String(groupId || '').trim()
    if (normalizedGroupId) return normalizedGroupId
    return this.normalizeRelayForCompare(relay || undefined)
  }

  private createGroupPresenceState(input: Partial<GroupPresenceState> = {}): GroupPresenceState {
    const count = Number.isFinite(Number(input.count)) ? Math.max(0, Math.trunc(Number(input.count))) : null
    const lastUpdatedAt = Number.isFinite(Number(input.lastUpdatedAt))
      ? Math.trunc(Number(input.lastUpdatedAt))
      : null
    const verifiedAt = Number.isFinite(Number(input.verifiedAt))
      ? Math.trunc(Number(input.verifiedAt))
      : null
    const status = (() => {
      const value = String(input.status || 'unknown').trim()
      return ['idle', 'scanning', 'ready', 'error', 'unknown'].includes(value)
        ? value as GroupPresenceState['status']
        : 'unknown'
    })()
    const source = (() => {
      const value = String(input.source || 'unknown').trim()
      return ['gateway', 'direct-probe', 'mixed', 'unknown'].includes(value)
        ? value as GroupPresenceState['source']
        : 'unknown'
    })()
    return {
      count,
      status,
      source,
      gatewayIncluded: input.gatewayIncluded === true,
      gatewayHealthy: input.gatewayHealthy === true,
      lastUpdatedAt,
      verifiedAt,
      unknown: input.unknown === true || status === 'unknown' || count === null,
      error: typeof input.error === 'string' && input.error.trim() ? input.error.trim() : null
    }
  }

  private groupPresenceForGroup(groupId?: string | null, relay?: string | null): GroupPresenceState {
    const key = this.groupPresenceKey(groupId, relay)
    if (!key) return this.createGroupPresenceState({ status: 'unknown' })
    return this.groupPresenceCache.get(key) || this.createGroupPresenceState({ status: 'unknown' })
  }

  private applyGroupPresenceToGroup(group: GroupSummary): GroupSummary {
    const presence = this.groupPresenceForGroup(group.id, group.relay)
    return {
      ...group,
      peerPresence: presence,
      peersOnline: presence.status === 'ready' && Number.isFinite(presence.count)
        ? Number(presence.count)
        : 0
    }
  }

  private shouldPreservePreviousGroupPresence(
    previous: GroupPresenceState | null | undefined,
    next: GroupPresenceState
  ): boolean {
    if (!previous || previous.status !== 'ready' || !Number.isFinite(previous.count)) return false
    if (previous.gatewayIncluded !== true || previous.gatewayHealthy !== true) return false
    if (next.status !== 'ready' || !Number.isFinite(next.count)) return false
    if (Number(next.count) >= Number(previous.count)) return false
    if (next.source !== 'direct-probe') return false
    if (next.gatewayIncluded === true || next.gatewayHealthy === true) return false
    return Boolean(next.error)
  }

  private mergeGroupPresenceState(
    previous: GroupPresenceState | null | undefined,
    next: GroupPresenceState
  ): GroupPresenceState {
    if (this.shouldPreservePreviousGroupPresence(previous, next)) {
      return {
        ...previous!,
        error: next.error || previous?.error || null,
        lastUpdatedAt: next.lastUpdatedAt || previous?.lastUpdatedAt || null,
        verifiedAt: next.verifiedAt || previous?.verifiedAt || null
      }
    }
    return next
  }

  private groupPresenceTtlForNode(nodeId: NavNodeId): number {
    if (nodeId === 'groups:my') return GROUP_PRESENCE_MY_GROUP_TTL_MS
    if (nodeId === 'groups:browse') return GROUP_PRESENCE_DISCOVER_TTL_MS
    return GROUP_PRESENCE_SELECTED_TTL_MS
  }

  private buildGroupPresencePayload(group: GroupSummary): Record<string, unknown> {
    return {
      publicIdentifier: group.id,
      relayUrl: group.relay || undefined,
      gatewayOrigin: group.gatewayOrigin || undefined,
      gatewayId: group.gatewayId || undefined,
      directJoinOnly: group.directJoinOnly === true,
      discoveryTopic: group.discoveryTopic || undefined,
      hostPeerKeys: Array.isArray(group.hostPeerKeys) ? group.hostPeerKeys : undefined,
      leaseReplicaPeerKeys: Array.isArray(group.leaseReplicaPeerKeys) ? group.leaseReplicaPeerKeys : undefined
    }
  }

  private selectedGroupRowsForNode(nodeId: NavNodeId): GroupSummary[] {
    if (nodeId === 'groups:my') return this.state.myGroups
    if (nodeId === 'groups:browse') return this.state.groups
    return []
  }

  private visibleGroupPresenceTargets(nodeId: NavNodeId): GroupSummary[] {
    const rows = this.selectedGroupRowsForNode(nodeId)
      .filter((group) => Boolean(String(group.id || '').trim()))
    if (!rows.length) return []
    const selectedIndex = Math.max(
      0,
      Math.min(
        Math.trunc(this.state.rightTopSelectionByNode[nodeId] || 0),
        Math.max(0, rows.length - 1)
      )
    )
    const start = Math.max(0, selectedIndex - 2)
    const end = Math.min(rows.length, start + GROUP_PRESENCE_VISIBLE_WINDOW)
    return rows.slice(start, end)
  }

  private async refreshGroupPresence(
    group: GroupSummary,
    options: { ttlMs?: number; force?: boolean; reason?: string } = {}
  ): Promise<GroupPresenceState> {
    const key = this.groupPresenceKey(group.id, group.relay)
    if (!key) return this.createGroupPresenceState({ status: 'unknown' })
    const ttlMs = Number.isFinite(Number(options.ttlMs))
      ? Math.max(1_000, Math.trunc(Number(options.ttlMs)))
      : GROUP_PRESENCE_DISCOVER_TTL_MS
    const cached = this.groupPresenceCache.get(key) || null
    const expiresAt = this.groupPresenceExpiresAt.get(key) || 0
    if (!options.force && cached && expiresAt > Date.now() && cached.status !== 'error') {
      return cached
    }
    const existing = this.groupPresenceInFlight.get(key)
    if (existing) return await existing
    if (!this.workerHost.isRunning() || this.state.lifecycle !== 'ready') {
      return cached || this.createGroupPresenceState({ status: 'unknown' })
    }

    const request = (async () => {
      try {
        const result = await this.workerHost.request<GroupPresenceState>({
          type: 'probe-group-presence',
          data: this.buildGroupPresencePayload(group)
        }, 12_000)
        const next = this.mergeGroupPresenceState(
          cached,
          this.createGroupPresenceState(result || {})
        )
        this.groupPresenceCache.set(key, next)
        this.groupPresenceExpiresAt.set(key, Date.now() + ttlMs)
        this.syncGroupView()
        return next
      } catch (error) {
        const fallback = cached || this.createGroupPresenceState({
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
        this.groupPresenceCache.set(key, fallback)
        this.groupPresenceExpiresAt.set(key, Date.now() + Math.min(ttlMs, 5_000))
        if (!cached) this.syncGroupView()
        return fallback
      } finally {
        this.groupPresenceInFlight.delete(key)
      }
    })()

    this.groupPresenceInFlight.set(key, request)
    if (!cached) {
      this.groupPresenceCache.set(key, this.createGroupPresenceState({ status: 'scanning' }))
      this.syncGroupView()
    }
    return await request
  }

  private async refreshVisibleGroupPresence(): Promise<void> {
    const nodeId = this.state.selectedNode
    if (nodeId !== 'groups:browse' && nodeId !== 'groups:my') return
    const targets = this.visibleGroupPresenceTargets(nodeId)
    if (!targets.length) return
    const ttlMs = this.groupPresenceTtlForNode(nodeId)
    const concurrency = nodeId === 'groups:browse'
      ? Math.min(GROUP_PRESENCE_DISCOVER_CONCURRENCY, targets.length)
      : targets.length
    let cursor = 0
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < targets.length) {
        const nextIndex = cursor
        cursor += 1
        const group = targets[nextIndex]
        if (!group) continue
        await this.refreshGroupPresence(group, { ttlMs, reason: `visible:${nodeId}` }).catch(() => {})
      }
    }))
  }

  private resolveGroupPeerCount(groupId: string, relay?: string): number {
    const presence = this.groupPresenceForGroup(groupId, relay)
    return presence.status === 'ready' && Number.isFinite(presence.count)
      ? Number(presence.count)
      : 0
  }

  private inferGatewayBaseUrl(): string {
    const sample = this.state.relays.find((entry) => entry.connectionUrl)?.connectionUrl || null
    if (sample) {
      try {
        const parsed = new URL(sample)
        return `${parsed.protocol}//${parsed.host}`
      } catch {
        // fall through
      }
    }
    return 'ws://127.0.0.1:8443'
  }

  private async readLocalRelayProfiles(): Promise<LocalRelayProfileSnapshot[]> {
    const now = Date.now()
    if (this.localProfileCache && now - this.localProfileCache.loadedAt <= LOCAL_PROFILE_CACHE_TTL_MS) {
      return this.localProfileCache.entries
    }

    const usersDir = path.join(this.options.storageDir, 'users')
    let userDirs: Array<{ name: string }> = []
    try {
      const entries = await fs.readdir(usersDir, { withFileTypes: true })
      userDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name }))
    } catch {
      this.localProfileCache = { loadedAt: now, entries: [] }
      return []
    }

    const gatewayBase = this.inferGatewayBaseUrl()
    const byPublicIdentifier = new Map<string, LocalRelayProfileSnapshot>()

    for (const dir of userDirs) {
      const profilePath = path.join(usersDir, dir.name, 'relay-profiles.json')
      let parsed: unknown = null
      try {
        const raw = await fs.readFile(profilePath, 'utf8')
        parsed = JSON.parse(raw)
      } catch {
        continue
      }

      const relays = Array.isArray((parsed as { relays?: unknown[] })?.relays)
        ? (parsed as { relays: unknown[] }).relays
        : []

      for (const relay of relays) {
        if (!relay || typeof relay !== 'object') continue
        const row = relay as Record<string, unknown>
        const relayKey = String(row.relay_key || '').trim().toLowerCase()
        const publicIdentifier = String(row.public_identifier || '').trim()
        if (!relayKey || !publicIdentifier) continue

        const createdAtRaw = String(row.created_at || row.joined_at || '').trim()
        const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN
        const createdAt = Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : null
        const members = Array.isArray(row.members)
          ? row.members.map((member) => String(member || '').trim()).filter(Boolean)
          : []
        const relayUrl = `${gatewayBase}/${publicIdentifier.replace(':', '/')}`
        const next: LocalRelayProfileSnapshot = {
          relayKey,
          publicIdentifier,
          relayUrl,
          name: String(row.name || publicIdentifier).trim() || publicIdentifier,
          about: String(row.description || '').trim(),
          picture: typeof row.picture === 'string' ? row.picture.trim() : undefined,
          isPublic: row.isPublic === true,
          isOpen: row.isOpen === true,
          adminPubkey: typeof row.admin_pubkey === 'string' ? row.admin_pubkey.trim() : null,
          members,
          membersCount: members.length,
          createdAt
        }

        const existing = byPublicIdentifier.get(publicIdentifier)
        if (!existing) {
          byPublicIdentifier.set(publicIdentifier, next)
          continue
        }

        const existingCreatedAt = Number(existing.createdAt || 0)
        const nextCreatedAt = Number(next.createdAt || 0)
        if (nextCreatedAt >= existingCreatedAt) {
          byPublicIdentifier.set(publicIdentifier, {
            ...existing,
            ...next,
            members: next.members.length ? next.members : existing.members,
            membersCount: next.membersCount || existing.membersCount
          })
        }
      }
    }

    const entries = Array.from(byPublicIdentifier.values())
    this.localProfileCache = { loadedAt: now, entries }
    return entries
  }

  private async resolveRelayKeyForIdentifier(identifier?: string | null): Promise<string | null> {
    const normalized = String(identifier || '').trim()
    if (!normalized) return null

    const connected = this.findConnectedRelayByIdentifier(normalized)
    if (connected?.relayKey) return connected.relayKey

    const variants = new Set(this.relayIdentifierVariants(normalized))
    const localProfiles = await this.readLocalRelayProfiles()
    for (const profile of localProfiles) {
      if (variants.has(profile.publicIdentifier) || variants.has(profile.relayKey)) {
        return profile.relayKey
      }
    }
    return null
  }

  private async loadLocalDiscoveryGroups(): Promise<GroupSummary[]> {
    const localProfiles = await this.readLocalRelayProfiles()
    return localProfiles
      .filter((profile) => profile.isPublic)
      .map((profile) => ({
        id: profile.publicIdentifier,
        relay: profile.relayUrl,
        name: profile.name,
        about: profile.about,
        picture: profile.picture,
        isPublic: profile.isPublic,
        isOpen: profile.isOpen,
        adminPubkey: profile.adminPubkey || null,
        members: [...profile.members],
        membersCount: profile.membersCount,
        createdAt: profile.createdAt
      }))
      .map((group) => this.applyGroupPresenceToGroup(group))
  }

  private getWorkerReadableRelayUrls(): string[] {
    const urls: string[] = []
    for (const entry of this.state.relays) {
      if (!entry.connectionUrl) continue
      const isReady = entry.readyForReq === true
      const isWritable = entry.writable === true
      const noAuthRequired = entry.requiresAuth !== true
      if (isReady || isWritable || noAuthRequired) {
        urls.push(entry.connectionUrl)
      }
    }
    return uniqueRelayUrls(urls)
  }

  private getWorkerWritableRelayUrls(): string[] {
    const urls = this.state.relays
      .filter((entry) => entry.connectionUrl && entry.writable === true)
      .map((entry) => String(entry.connectionUrl || ''))
    return uniqueRelayUrls(urls)
  }

  private getJoinedGroupRelayUrls(): string[] {
    const candidateRelays = new Set<string>()
    for (const entry of this.state.myGroupList) {
      const relay = this.resolveRelayUrl(entry.relay)
      if (relay) candidateRelays.add(relay)
      const match = this.state.groupDiscover.find((group) => group.id === entry.groupId && group.relay)
      if (match?.relay) {
        const resolved = this.resolveRelayUrl(match.relay)
        if (resolved) candidateRelays.add(resolved)
      }
    }
    return uniqueRelayUrls(Array.from(candidateRelays))
  }

  private currentRelayUrls(): string[] {
    const joinedGroupRelays = this.getJoinedGroupRelayUrls()
    return uniqueRelayUrls([
      ...this.getWorkerReadableRelayUrls(),
      ...this.state.relayListPreferences.read,
      ...joinedGroupRelays,
      ...this.state.discoveryRelayUrls
    ])
  }

  private currentWriteRelayUrls(): string[] {
    return uniqueRelayUrls([
      ...this.getWorkerWritableRelayUrls(),
      ...this.state.relayListPreferences.write,
      ...this.state.discoveryRelayUrls
    ])
  }

  private limitRelayTargets(relays: string[], maxTargets = MAX_SEARCH_RELAYS): string[] {
    const targets = uniqueRelayUrls(relays)
    const max = Math.max(1, Math.trunc(maxTargets))
    if (targets.length <= max) return targets
    return targets.slice(0, max)
  }

  private relayIdentifierVariants(identifier?: string | null): string[] {
    const normalized = String(identifier || '').trim()
    if (!normalized) return []
    const variants = new Set<string>([normalized])
    if (normalized.includes(':')) {
      variants.add(normalized.replace(':', '/'))
    }
    if (normalized.includes('/')) {
      variants.add(normalized.replace('/', ':'))
    }
    return Array.from(variants).filter(Boolean)
  }

  private findConnectedRelayByIdentifier(identifier?: string | null): RelayEntry | undefined {
    const candidates = new Set<string>(this.relayIdentifierVariants(identifier))
    if (!candidates.size) return undefined
    return this.state.relays.find((entry) => {
      const relayCandidates = [
        entry.publicIdentifier,
        entry.relayKey,
        entry.connectionUrl
      ].map((value) => String(value || '').trim()).filter(Boolean)
      return relayCandidates.some((candidate) => candidates.has(candidate))
    })
  }

  private resolveRelayUrl(relay?: string): string | undefined {
    const normalized = String(relay || '').trim()
    if (!normalized) return undefined
    const canonical = normalizeRelayUrl(normalized) || normalized

    const direct = this.state.relays.find((entry) =>
      entry.connectionUrl === normalized
      || entry.connectionUrl === canonical
      || (entry.connectionUrl && normalizeRelayUrl(entry.connectionUrl) === canonical)
      || entry.publicIdentifier === normalized
      || entry.relayKey === normalized
    )
    if (direct?.connectionUrl) {
      return normalizeRelayUrl(direct.connectionUrl) || direct.connectionUrl
    }

    if (normalized.includes('://')) {
      return canonical
    }

    const slashForm = normalized.replace(':', '/')
    const slashHit = this.state.relays.find((entry) =>
      entry.publicIdentifier === slashForm
      || entry.connectionUrl === slashForm
    )
    if (slashHit?.connectionUrl) return slashHit.connectionUrl

    return canonical
  }

  private resolveGroupRelayUrl(groupId?: string | null, fallbackRelay?: string | null): string | undefined {
    const normalizedGroupId = String(groupId || '').trim()
    if (!normalizedGroupId && !fallbackRelay) return undefined
    const fromSource = this.resolveRelayUrl(fallbackRelay || undefined)
    if (fromSource) return fromSource
    if (!normalizedGroupId) return undefined

    const inMyList = this.state.myGroupList.find((entry) => entry.groupId === normalizedGroupId)
    const fromMyList = this.resolveRelayUrl(inMyList?.relay)
    if (fromMyList) return fromMyList

    const discovered = this.state.groupDiscover.find((group) => group.id === normalizedGroupId)
    const fromDiscover = this.resolveRelayUrl(discovered?.relay)
    if (fromDiscover) return fromDiscover

    const relayRow = this.state.relays.find((relay) =>
      relay.publicIdentifier === normalizedGroupId || relay.relayKey === normalizedGroupId
    )
    const fromRelayRow = this.resolveRelayUrl(relayRow?.connectionUrl || relayRow?.publicIdentifier)
    return fromRelayRow
  }

  private async refreshRelayListPreferences(): Promise<void> {
    const session = this.state.session
    if (!session) return

    try {
      const events = await this.nostrClient.query(
        this.searchableRelayUrls(14),
        {
          kinds: [10002],
          authors: [session.pubkey],
          limit: 3
        },
        2_500
      )
      const latest = events.sort((left, right) => right.created_at - left.created_at)[0]
      if (!latest) return

      const read = new Set<string>()
      const write = new Set<string>()
      for (const tag of latest.tags) {
        if (!Array.isArray(tag) || tag[0] !== 'r' || typeof tag[1] !== 'string') continue
        const relayUrl = this.resolveRelayUrl(tag[1]) || tag[1]
        const scope = typeof tag[2] === 'string' ? tag[2].trim().toLowerCase() : ''
        if (!scope || scope === 'read') read.add(relayUrl)
        if (!scope || scope === 'write') write.add(relayUrl)
      }

      this.patchState({
        relayListPreferences: {
          read: uniqueRelayUrls(Array.from(read)),
          write: uniqueRelayUrls(Array.from(write))
        }
      })
    } catch (error) {
      this.log('debug', `Relay-list preferences unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private resolveFeedRelayUrls(): string[] {
    const source = this.state.feedSource
    if (source.mode === 'relay') {
      const relayUrl = this.resolveRelayUrl(source.relayUrl || undefined)
      return relayUrl ? [relayUrl] : []
    }

    if (source.mode === 'group') {
      const relayUrl = this.resolveGroupRelayUrl(source.groupId || null, source.relayUrl || null)
      if (relayUrl) return [relayUrl]
      return this.limitRelayTargets(this.currentRelayUrls(), MAX_FEED_RELAYS)
    }

    return this.limitRelayTargets(this.currentRelayUrls(), MAX_FEED_RELAYS)
  }

  private async loadFollowListPubkeys(): Promise<string[]> {
    const session = this.state.session
    if (!session) return []
    try {
      const follows = await this.listService.loadFollowList(this.searchableRelayUrls(16), session.pubkey)
      return Array.from(new Set(follows.filter(Boolean)))
    } catch (error) {
      this.log('warn', `Unable to load follow list: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private searchableRelayUrls(maxTargets = MAX_SEARCH_RELAYS): string[] {
    return this.limitRelayTargets([...this.currentRelayUrls(), ...SEARCHABLE_RELAYS], maxTargets)
  }

  async startWorker(): Promise<void> {
    await this.runTask('Start worker', async () => {
      const session = this.requireSession()
      this.clearRecoveryTimer()
      this.resetChatRuntimeState()

      this.patchState({
        lifecycle: 'starting',
        readinessMessage: 'Starting worker…',
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'recovering'
        }
      })

      const workerRoot = findDefaultWorkerRoot(this.options.cwd)
      const workerEntry = path.join(workerRoot, 'index.js')

      const result = await this.workerHost.start({
        workerRoot,
        workerEntry,
        storageDir: this.options.storageDir,
        config: {
          nostr_pubkey_hex: session.pubkey,
          nostr_nsec_hex: session.nsecHex,
          nostr_npub: maybeNpub(session.pubkey),
          userKey: session.userKey
        }
      })

      if (!result.success) {
        this.patchState({ lifecycle: 'error', readinessMessage: result.error || 'Failed to start worker' })
        throw new Error(result.error || 'Failed to start worker')
      }

      this.patchState({
        lifecycle: 'initializing',
        readinessMessage: result.alreadyRunning ? 'Worker already running' : 'Worker started',
        workerRecoveryState: {
          ...this.state.workerRecoveryState,
          status: 'idle',
          attempt: 0,
          nextDelayMs: 0,
          lastError: null
        }
      })

      await this.refreshRelays()
      await this.ensureGatewayParityReady({
        reason: 'worker-start',
        refreshPublicGateway: true
      }).catch((error) => {
        this.log('warn', `Gateway parity preflight failed during worker start: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, { dedupeKey: 'worker:start', retries: 0 })
  }

  async stopWorker(): Promise<void> {
    await this.runTask('Stop worker', async () => {
      this.clearRecoveryTimer()
      this.patchState({ lifecycle: 'stopping', readinessMessage: 'Stopping worker…' })
      await this.workerHost.stop()
      this.resetChatRuntimeState()
      this.resetGroupPresenceState()
      this.patchState({ lifecycle: 'stopped', readinessMessage: 'Stopped' })
    })
  }

  async restartWorker(): Promise<void> {
    await this.runTask('Restart worker', async () => {
      await this.stopWorker()
      await this.startWorker()
    })
  }

  async refreshRelays(): Promise<void> {
    await this.runTask('Refresh relays', async () => {
      if (this.state.lifecycle === 'starting' || this.state.lifecycle === 'initializing') {
        try {
          await this.waitForLifecycleReady(30_000)
        } catch (error) {
          this.log('warn', `Skipping relay refresh until worker is ready: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }

      let relays: RelayEntry[] | null = null
      try {
        relays = await this.withTimeout(
          this.relayService.getRelays(),
          RELAY_REFRESH_TIMEOUT_MS,
          'Relay refresh'
        ) as RelayEntry[]
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.state.relays.length > 0) {
          this.log('warn', `Relay refresh timed out; using cached relay snapshot (${message})`)
        } else {
          throw error
        }
      }

      if (relays && relays.length >= 0) {
        this.patchState({
          relays: relays as RelayEntry[]
        })
      }

      await this.refreshRelayListPreferences()
      await this.refreshGatewayStatusSnapshot(2_500).catch(() => {})
    }, { dedupeKey: 'refresh:relays', retries: 0 })
  }

  async createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Create relay', async () => {
      await this.ensureWorkerReadyForOperation('create relay')
      const normalizeHttpOrigin = (value: string | null | undefined): string | null => {
        const trimmed = String(value || '').trim()
        if (!trimmed) return null
        try {
          const parsed = new URL(trimmed)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
          return parsed.origin
        } catch {
          return null
        }
      }

      const knownRelayKeys = new Set(
        this.state.relays
          .map((entry) => this.relayIdentityKey(entry))
          .filter(Boolean)
      )

      await this.ensureGatewayParityReady({
        reason: 'create-relay',
        refreshPublicGateway: true
      }).catch(() => {})

      const directJoinOnly = input.directJoinOnly === true
      let resolvedGatewayOrigin = normalizeHttpOrigin(input.gatewayOrigin || null)
      let resolvedGatewayId =
        typeof input.gatewayId === 'string' && input.gatewayId.trim()
          ? input.gatewayId.trim().toLowerCase()
          : null

      if (directJoinOnly) {
        resolvedGatewayOrigin = null
        resolvedGatewayId = null
      }

      if (!directJoinOnly && !resolvedGatewayOrigin && resolvedGatewayId) {
        let selectedGateway = this.findAuthorizedGateway(resolvedGatewayId)
        if (!selectedGateway) {
          await this.refreshGatewayCatalog({ force: true, timeoutMs: 5_000 }).catch(() => {})
          selectedGateway = this.findAuthorizedGateway(resolvedGatewayId)
        }
        if (!selectedGateway) {
          throw new Error(`Gateway "${resolvedGatewayId}" is not approved for hosting on this account. Run "gateway refresh" and retry.`)
        }
        resolvedGatewayId = selectedGateway.gatewayId
        resolvedGatewayOrigin = selectedGateway.publicUrl
      }

      if (!directJoinOnly && resolvedGatewayOrigin && !resolvedGatewayId) {
        const matchedByOrigin = this.state.authorizedGateways.find((gateway) => gateway.publicUrl === resolvedGatewayOrigin)
        if (matchedByOrigin) {
          resolvedGatewayId = matchedByOrigin.gatewayId
        } else {
          throw new Error('Gateway origin is not approved for hosting on this account')
        }
      }

      if (!directJoinOnly && !resolvedGatewayOrigin) {
        throw new Error('Gateway origin is required unless direct-join-only is enabled')
      }

      const result = await this.relayService.createRelay({
        ...input,
        gatewayOrigin: resolvedGatewayOrigin,
        gatewayId: resolvedGatewayId,
        directJoinOnly
      })
      const session = this.state.session
      let publicIdentifier = String(result.publicIdentifier || '').trim()
      let relayUrl = this.resolveRelayUrl(String(result.relayUrl || '')) || String(result.relayUrl || '').trim() || null
      if (!publicIdentifier) {
        const reconciled = await this.reconcilePendingCreatedRelay({
          name: input.name,
          knownRelayKeys
        })
        if (reconciled) {
          publicIdentifier = reconciled.publicIdentifier
          relayUrl = reconciled.relayUrl || relayUrl
        }
      }
      const normalizedResult = {
        ...result,
        ...(publicIdentifier ? { publicIdentifier } : {}),
        ...(relayUrl ? { relayUrl } : {})
      }
      if (session && publicIdentifier) {
        const nextEntries = [
          ...this.state.myGroupList.filter((entry) => entry.groupId !== publicIdentifier),
          {
            groupId: publicIdentifier,
            relay: relayUrl || undefined
          }
        ]
        this.patchState({ myGroupList: nextEntries })
        try {
          await this.groupService.saveMyGroupList(
            this.searchableRelayUrls(14),
            session.pubkey,
            session.nsecHex,
            nextEntries
          )
        } catch (error) {
          this.log('warn', `Failed to persist my-group list after create: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (publicIdentifier && !this.rawGroupDiscover.some((group) => group.id === publicIdentifier)) {
        const provisional: GroupSummary = {
          id: publicIdentifier,
          relay: relayUrl || undefined,
          name: String(input.name || publicIdentifier),
          about: input.description || '',
          picture: input.picture || undefined,
          isPublic: typeof input.isPublic === 'boolean' ? input.isPublic : true,
          isOpen: typeof input.isOpen === 'boolean' ? input.isOpen : true,
          gatewayOrigin: resolvedGatewayOrigin,
          gatewayId: resolvedGatewayId,
          directJoinOnly,
          adminPubkey: session?.pubkey || null,
          adminName: null,
          members: session?.pubkey ? [session.pubkey] : [],
          membersCount: session?.pubkey ? 1 : 0,
          createdAt: eventNow()
        }
        this.rawGroupDiscover = [provisional, ...this.rawGroupDiscover]
        this.syncGroupView()
      }

      this.localProfileCache = null
      void this.refreshRelays().catch((error) => {
        this.log('warn', `Background relay refresh after create failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      void this.refreshGroups().catch((error) => {
        this.log('warn', `Background group refresh after create failed: ${error instanceof Error ? error.message : String(error)}`)
      })

      if (publicIdentifier) {
        const hasMyGroup = this.state.myGroups.some((group) => group.id === publicIdentifier)
        if (!hasMyGroup) {
          const fallbackGroup =
            this.state.groupDiscover.find((group) => group.id === publicIdentifier)
            || this.rawGroupDiscover.find((group) => group.id === publicIdentifier)
            || null
          const nextMyGroupList = [
            ...this.state.myGroupList.filter((entry) => entry.groupId !== publicIdentifier),
            {
              groupId: publicIdentifier,
              relay: relayUrl || undefined
            }
          ]
          this.patchState({
            myGroupList: nextMyGroupList,
            myGroups: fallbackGroup
              ? [fallbackGroup, ...this.state.myGroups.filter((group) => group.id !== publicIdentifier)]
              : this.state.myGroups
          })
        }
      }
      return normalizedResult
    })
  }

  async joinRelay(input: {
    relayKey?: string
    publicIdentifier?: string
    relayUrl?: string
    authToken?: string
    fileSharing?: boolean
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Join relay', async () => {
      await this.ensureWorkerReadyForOperation('join relay')

      await this.ensureGatewayParityReady({
        reason: 'join-relay',
        refreshPublicGateway: true
      }).catch(() => {})

      const normalizedPublicIdentifier = String(input.publicIdentifier || '').trim()

      const joinOnce = async (candidate: typeof input): Promise<Record<string, unknown>> => {
        const result = await this.relayService.joinRelay(candidate)
        this.localProfileCache = null
        await this.refreshRelays()
        return result
      }

      const existingRelay = this.findConnectedRelayByIdentifier(normalizedPublicIdentifier)
      if (existingRelay && existingRelay.connectionUrl && existingRelay.readyForReq) {
        this.log('info', `Relay already connected for ${normalizedPublicIdentifier}; skipping join`)
        return {
          relayKey: existingRelay.relayKey,
          publicIdentifier: existingRelay.publicIdentifier || normalizedPublicIdentifier,
          relayUrl: existingRelay.connectionUrl,
          alreadyJoined: true
        }
      }

      try {
        return await joinOnce(input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const profileMissing = message.toLowerCase().includes('relay profile not found')
        if (!profileMissing || !normalizedPublicIdentifier) {
          throw error
        }

        const variants = this.relayIdentifierVariants(normalizedPublicIdentifier)
          .filter((variant) => variant !== normalizedPublicIdentifier)

        for (const variant of variants) {
          try {
            this.log('warn', `Retrying join with identifier variant ${variant}`)
            return await joinOnce({
              ...input,
              publicIdentifier: variant
            })
          } catch {
            // keep trying identifier variants
          }
        }

        const connectedAfterFailure = this.findConnectedRelayByIdentifier(normalizedPublicIdentifier)
        if (connectedAfterFailure?.connectionUrl) {
          this.log('warn', `Join reported profile missing but relay is available locally (${normalizedPublicIdentifier})`)
          return {
            relayKey: connectedAfterFailure.relayKey,
            publicIdentifier: connectedAfterFailure.publicIdentifier || normalizedPublicIdentifier,
            relayUrl: connectedAfterFailure.connectionUrl,
            alreadyJoined: true,
            recoveredFromProfileLookup: true
          }
        }

        throw error
      }
    })
  }

  async startJoinFlow(input: {
    publicIdentifier: string
    fileSharing?: boolean
    isOpen?: boolean
    token?: string
    relayKey?: string
    relayUrl?: string
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
    discoveryTopic?: string | null
    hostPeerKeys?: string[]
    leaseReplicaPeerKeys?: string[]
    writerIssuerPubkey?: string | null
    writerLeaseEnvelope?: Record<string, unknown> | null
    gatewayAccess?: {
      version?: string | null
      authMethod?: string | null
      grantId?: string | null
      gatewayId?: string | null
      gatewayOrigin?: string | null
      scopes?: string[]
    } | null
    openJoin?: boolean
    hostPeers?: string[]
    blindPeer?: {
      publicKey?: string | null
      encryptionKey?: string | null
      replicationTopic?: string | null
      maxBytes?: number | null
    } | null
    cores?: Array<{
      key: string
      role?: string | null
    }>
    writerCore?: string | null
    writerCoreHex?: string | null
    autobaseLocal?: string | null
    writerSecret?: string | null
    fastForward?: {
      key?: string | null
      length?: number | null
      signedLength?: number | null
      timeoutMs?: number | null
    } | null
  }): Promise<void> {
    await this.runTask('Start join flow', async () => {
      await this.ensureWorkerReadyForOperation('start join flow')
      const directJoinOnly = input.directJoinOnly === true

      if (!directJoinOnly) {
        await this.ensureGatewayParityReady({
          reason: 'start-join-flow',
          refreshPublicGateway: true
        }).catch((error) => {
          this.log('warn', `Gateway parity preflight failed before join flow: ${error instanceof Error ? error.message : String(error)}`)
        })
      }

      const normalizedIdentifier = String(input.publicIdentifier || '').trim()
      const relayKey =
        (typeof input.relayKey === 'string' && /^[a-f0-9]{64}$/i.test(input.relayKey.trim())
          ? input.relayKey.trim().toLowerCase()
          : null)
        || await this.resolveRelayKeyForIdentifier(normalizedIdentifier)
        || undefined
      const relayUrl = String(input.relayUrl || '').trim() || undefined
      const hostPeers = Array.from(new Set([
        ...(Array.isArray(input.hostPeers) ? input.hostPeers : []).map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean),
        ...(Array.isArray(input.hostPeerKeys) ? input.hostPeerKeys : []).map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean),
        ...(!directJoinOnly
          ? this.resolveGatewayHostPeers({
              publicIdentifier: normalizedIdentifier,
              relayKey: relayKey || null,
              relayUrl: relayUrl || null
            })
          : [])
      ]))

      await this.relayService.startJoinFlow({
        ...input,
        directJoinOnly,
        relayKey,
        relayUrl,
        hostPeers: hostPeers.length ? hostPeers : undefined,
        hostPeerKeys: hostPeers.length ? hostPeers : undefined
      })
      this.localProfileCache = null
    })
  }

  async requestGroupInvite(input: {
    groupId: string
    relay?: string | null
    code?: string
    reason?: string
  }): Promise<void> {
    await this.runTask('Request group invite', async () => {
      await this.ensureWorkerReadyForOperation('request group invite')

      await this.ensureGatewayParityReady({
        reason: 'request-group-invite',
        refreshPublicGateway: true
      }).catch(() => {})

      const groupId = String(input.groupId || '').trim()
      if (!groupId) {
        throw new Error('groupId is required')
      }
      const relay = this.resolveRelayUrl(input.relay || undefined)
      const relayKey = await this.resolveRelayKeyForIdentifier(groupId)
      void this.relayService.startJoinFlow({
        publicIdentifier: groupId,
        relayKey: relayKey || undefined,
        relayUrl: relay || undefined,
        isOpen: false,
        openJoin: false,
        fileSharing: true
      }).then(() => {
        this.localProfileCache = null
      }).catch((error) => {
        this.log('warn', `Join-flow request invite fallback to event publish: ${error instanceof Error ? error.message : String(error)}`)
      })

      const relayTargets = relay
        ? uniqueRelayUrls([relay, ...this.searchableRelayUrls(16)])
        : this.searchableRelayUrls(16)
      await this.groupService.sendJoinRequest({
        groupId,
        reason: input.reason,
        code: input.code,
        relayTargets
      })
      await this.refreshJoinRequests(groupId, relay || undefined).catch(() => {})
    }, { dedupeKey: 'group:request-invite', retries: 1, retryBaseDelayMs: 1_000 })
  }

  async disconnectRelay(relayKey: string, publicIdentifier?: string): Promise<void> {
    await this.runTask('Disconnect relay', async () => {
      await this.relayService.disconnectRelay(relayKey, publicIdentifier)
      await this.refreshRelays()
    })
  }

  async leaveGroup(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    saveRelaySnapshot?: boolean
    saveSharedFiles?: boolean
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Leave group', async () => {
      const result = await this.relayService.leaveGroup(input)
      await this.refreshRelays()
      return result
    })
  }

  async refreshFeed(limit = 120): Promise<void> {
    await this.runTask('Refresh feed', async () => {
      this.feedLimit = Math.max(1, Math.trunc(limit || 120))
      const relays = this.resolveFeedRelayUrls()
      const kinds = [1, 6, 7, 20, 21, 22]
      const filter: Filter = {
        kinds,
        limit: this.feedLimit
      }

      if (this.state.feedSource.mode === 'group' && this.state.feedSource.groupId) {
        filter['#h'] = [this.state.feedSource.groupId]
      }

      let followSet: Set<string> | null = null
      if (this.state.feedSource.mode === 'following') {
        const follows = await this.loadFollowListPubkeys()
        followSet = new Set(follows)
      }

      if (!relays.length) {
        this.rawFeed = []
        this.patchState({
          activeFeedRelays: []
        })
        this.syncFeedView()
        return
      }

      let feed = await this.feedService.fetchFeed(
        relays,
        filter,
        FEED_REFRESH_TIMEOUT_MS
      )

      if (followSet) {
        feed = feed.filter((event) => followSet?.has(event.pubkey))
      }

      this.rawFeed = feed
      this.patchState({
        activeFeedRelays: relays
      })
      this.syncFeedView()
    })
  }

  async publishPost(content: string): Promise<Event> {
    return await this.runTask('Publish post', async () => {
      const event = await this.postService.publishTextNote(content, this.currentWriteRelayUrls())
      this.rawFeed = [event, ...this.rawFeed]
      this.syncFeedView()
      return event
    })
  }

  async publishReply(content: string, replyToEventId: string, replyToPubkey: string): Promise<Event> {
    return await this.runTask('Publish reply', async () => {
      return await this.postService.publishReply(
        content,
        replyToEventId,
        replyToPubkey,
        this.currentWriteRelayUrls()
      )
    })
  }

  async publishReaction(eventId: string, eventPubkey: string, reaction: string): Promise<Event> {
    return await this.runTask('Publish reaction', async () => {
      return await this.postService.publishReaction(
        eventId,
        eventPubkey,
        reaction,
        this.currentWriteRelayUrls()
      )
    })
  }

  async refreshBookmarks(): Promise<void> {
    await this.runTask('Refresh bookmarks', async () => {
      const session = this.requireSession()
      const bookmarks = await this.bookmarkService.loadBookmarks(this.currentRelayUrls(), session.pubkey)
      this.patchState({ bookmarks })
    })
  }

  async addBookmark(eventId: string): Promise<void> {
    await this.runTask('Add bookmark', async () => {
      const nextIds = this.bookmarkService.addBookmark(this.state.bookmarks, eventId)
      const event = await this.bookmarkService.publishBookmarks(nextIds, this.currentWriteRelayUrls())
      this.patchState({ bookmarks: { event, eventIds: nextIds } })
    })
  }

  async removeBookmark(eventId: string): Promise<void> {
    await this.runTask('Remove bookmark', async () => {
      const nextIds = this.bookmarkService.removeBookmark(this.state.bookmarks, eventId)
      const event = await this.bookmarkService.publishBookmarks(nextIds, this.currentWriteRelayUrls())
      this.patchState({ bookmarks: { event, eventIds: nextIds } })
    })
  }

  async refreshMyGroupList(): Promise<void> {
    await this.runTask('Refresh my groups', async () => {
      const session = this.requireSession()
      const entries = await this.groupService.loadMyGroupList(
        this.searchableRelayUrls(),
        session.pubkey
      )
      this.patchState({
        myGroupList: entries
      })
    }, { dedupeKey: 'refresh:my-group-list', retries: 1 })
  }

  private readTagValue(tags: string[][], key: string): string | null {
    const hit = tags.find((tag) => tag[0] === key && typeof tag[1] === 'string')
    return typeof hit?.[1] === 'string' ? hit[1] : null
  }

  private groupIdentifierFromEvent(event: Event): string | null {
    const byD = this.readTagValue(event.tags, 'd')
    if (byD) return byD
    const byH = this.readTagValue(event.tags, 'h')
    if (byH) return byH
    return null
  }

  private async enrichGroupMetadata(groups: GroupSummary[]): Promise<GroupSummary[]> {
    if (!groups.length) return []
    const groupIds = Array.from(new Set(groups.map((group) => String(group.id || '').trim()).filter(Boolean)))
    if (!groupIds.length) {
      return groups.map((group) => this.applyGroupPresenceToGroup({
        ...group,
        membersCount: Number(group.membersCount || group.members?.length || 0),
        createdAt: group.createdAt || group.event?.created_at || null
      }))
    }

    const targetGroupIds = groupIds.slice(0, MAX_GROUP_ENRICH_ITEMS)
    const targetGroupSet = new Set(targetGroupIds)
    const relays = this.searchableRelayUrls(MAX_GROUP_ENRICH_RELAYS)
    const limit = Math.max(120, targetGroupIds.length * 3)
    if (!relays.length || !targetGroupIds.length) {
      return groups.map((group) => this.applyGroupPresenceToGroup({
        ...group,
        membersCount: Number(group.membersCount || group.members?.length || 0),
        createdAt: group.createdAt || group.event?.created_at || null
      }))
    }

    const safeQuery = async (filter: Filter): Promise<Event[]> => {
      try {
        return await this.nostrClient.query(relays, filter, GROUP_METADATA_TIMEOUT_MS)
      } catch {
        return []
      }
    }

    const [adminsByD, adminsByH, membersByD, membersByH] = await Promise.all([
      safeQuery({ kinds: [39001], '#d': targetGroupIds, limit }),
      safeQuery({ kinds: [39001], '#h': targetGroupIds, limit }),
      safeQuery({ kinds: [39002], '#d': targetGroupIds, limit }),
      safeQuery({ kinds: [39002], '#h': targetGroupIds, limit })
    ])

    const latestAdminByGroup = new Map<string, Event>()
    const latestMembersByGroup = new Map<string, Event>()
    const registerLatest = (target: Map<string, Event>, event: Event) => {
      const groupId = this.groupIdentifierFromEvent(event)
      if (!groupId) return
      const existing = target.get(groupId)
      if (!existing || (existing.created_at || 0) < (event.created_at || 0)) {
        target.set(groupId, event)
      }
    }

    for (const event of [...adminsByD, ...adminsByH]) {
      registerLatest(latestAdminByGroup, event)
    }
    for (const event of [...membersByD, ...membersByH]) {
      registerLatest(latestMembersByGroup, event)
    }

    const adminPubkeys = Array.from(new Set(
      Array.from(latestAdminByGroup.values())
        .flatMap((event) => parseGroupAdminsEvent(event))
        .map((entry) => String(entry.pubkey || '').trim())
        .filter(Boolean)
    )).slice(0, 220)

    if (adminPubkeys.length > 0) {
      try {
        const profiles = await this.nostrClient.query(
          relays,
          {
            kinds: [0],
            authors: adminPubkeys,
            limit: Math.max(80, Math.min(420, adminPubkeys.length * 2))
          },
          GROUP_METADATA_TIMEOUT_MS
        )
        const profileRows: Array<{
          pubkey: string
          name?: string | null
          bio?: string | null
        }> = []
        for (const profile of profiles) {
          try {
            const parsed = JSON.parse(profile.content || '{}')
            const name = String(parsed?.display_name || parsed?.name || parsed?.username || '').trim()
            const bio = String(parsed?.about || parsed?.bio || '').trim()
            if (!name) continue
            this.profileNameCache.set(String(profile.pubkey || '').trim().toLowerCase(), name)
            profileRows.push({
              pubkey: String(profile.pubkey || '').trim().toLowerCase(),
              name,
              bio: bio || null
            })
          } catch {
            // ignore invalid metadata json
          }
        }
        await this.upsertAdminProfiles(profileRows, { persist: true })
      } catch {
        // optional enrichment
      }
    }

    return groups.map((group) => {
      if (!targetGroupSet.has(group.id)) {
        return this.applyGroupPresenceToGroup({
          ...group,
          membersCount: Number(group.membersCount || group.members?.length || 0),
          createdAt: group.createdAt || group.event?.created_at || null
        })
      }
      const adminEvent = latestAdminByGroup.get(group.id)
      const memberEvent = latestMembersByGroup.get(group.id)
      const admins = adminEvent ? parseGroupAdminsEvent(adminEvent) : []
      const members = memberEvent ? parseGroupMembersEvent(memberEvent) : []
      const adminPubkey = admins[0]?.pubkey || group.adminPubkey || group.event?.pubkey || null
      const adminName = adminPubkey ? (this.profileNameCache.get(String(adminPubkey).toLowerCase()) || null) : null
      const createdAt = group.createdAt || group.event?.created_at || null
      return this.applyGroupPresenceToGroup({
        ...group,
        adminPubkey,
        adminName,
        members,
        membersCount: members.length,
        createdAt
      })
    })
  }

  private async ensureAdminProfiles(pubkeys: string[]): Promise<void> {
    const unique = Array.from(
      new Set(
        pubkeys
          .map((value) => String(value || '').trim().toLowerCase())
          .filter((value) => /^[a-f0-9]{64}$/i.test(value))
      )
    )
    if (unique.length === 0) return

    const missing = unique.filter((pubkey) => !this.state.adminProfileByPubkey[pubkey])
    if (missing.length === 0) return

    const latestByPubkey = new Map<string, Event>()
    try {
      const events = await this.nostrClient.query(
        this.searchableRelayUrls(12),
        {
          kinds: [0],
          authors: missing,
          limit: Math.max(80, Math.min(500, missing.length * 2))
        },
        GROUP_METADATA_TIMEOUT_MS
      )
      for (const event of events) {
        if (!event?.pubkey) continue
        const pubkey = String(event.pubkey || '').trim().toLowerCase()
        if (!missing.includes(pubkey)) continue
        const existing = latestByPubkey.get(pubkey)
        if (!existing || Number(event.created_at || 0) >= Number(existing.created_at || 0)) {
          latestByPubkey.set(pubkey, event)
        }
      }
    } catch {
      // best-effort enrichment
    }

    const rows = missing.map((pubkey) => {
      const event = latestByPubkey.get(pubkey)
      if (!event) {
        return {
          pubkey,
          name: null,
          bio: null,
          followersCount: null
        }
      }
      try {
        const payload = JSON.parse(event.content || '{}')
        const name = String(payload?.display_name || payload?.name || payload?.username || '').trim()
        const bio = String(payload?.about || payload?.bio || '').trim()
        const followersRaw = Number(payload?.followers || payload?.followers_count)
        return {
          pubkey,
          name: name || null,
          bio: bio || null,
          followersCount: Number.isFinite(followersRaw) ? followersRaw : null
        }
      } catch {
        return {
          pubkey,
          name: null,
          bio: null,
          followersCount: null
        }
      }
    })
    await this.upsertAdminProfiles(rows)
  }

  async refreshGroups(): Promise<void> {
    await this.runTask('Refresh groups', async () => {
      const discoveryRelays = this.searchableRelayUrls(18)
      const myListRelays = this.searchableRelayUrls(14)
      const [groups, loadedMyGroupList, localGroups] = await Promise.all([
        this.groupService.discoverGroups(discoveryRelays, 220),
        this.state.session
          ? this.groupService.loadMyGroupList(myListRelays, this.state.session.pubkey)
          : Promise.resolve(this.state.myGroupList),
        this.loadLocalDiscoveryGroups().catch(() => [])
      ])
      const relayBackfillEntries = this.deriveMyGroupListFromConnectedRelays()
      const myGroupList = this.mergeMyGroupList(loadedMyGroupList, relayBackfillEntries)

      const groupMap = new Map<string, GroupSummary>()
      for (const group of localGroups) {
        if (!group?.id) continue
        groupMap.set(group.id, { ...group })
      }
      for (const group of groups) {
        if (!group?.id) continue
        const existing = groupMap.get(group.id)
        groupMap.set(group.id, {
          ...(existing || {}),
          ...group,
          relay: group.relay || existing?.relay,
          members: Array.isArray(group.members) && group.members.length
            ? group.members
            : (existing?.members || []),
          membersCount:
            Number(group.membersCount || 0)
            || Number(existing?.membersCount || 0)
            || Number(group.members?.length || 0)
        })
      }

      const mergedGroups = Array.from(groupMap.values())
      const enrichedGroups = await this.enrichGroupMetadata(mergedGroups)
      this.rawGroupDiscover = enrichedGroups.map((group) => ({ ...group }))
      this.patchState({ myGroupList })

      const loadedKeys = new Set(loadedMyGroupList.map((entry) => groupListEntryKey(entry)))
      const mergedKeys = new Set(myGroupList.map((entry) => groupListEntryKey(entry)))
      const addedByBackfill = mergedKeys.size > loadedKeys.size
      if (addedByBackfill && this.state.session) {
        await this.groupService.saveMyGroupList(
          this.searchableRelayUrls(14),
          this.state.session.pubkey,
          this.state.session.nsecHex,
          myGroupList
        ).catch((error) => {
          this.log('warn', `Failed to persist backfilled my-group list: ${error instanceof Error ? error.message : String(error)}`)
        })
      }

      await this.ensureAdminProfiles(
        enrichedGroups
          .map((group) => group.adminPubkey || group.event?.pubkey || '')
          .filter(Boolean)
      )
      this.syncGroupView()
    }, { dedupeKey: 'refresh:groups', retries: 0 })
  }

  async refreshInvites(): Promise<void> {
    const refreshToken = ++this.inviteRefreshToken

    if (this.state.busyTask === 'Refresh invites') {
      this.log('debug', 'Refresh invites already in progress; marked previous result stale')
      return
    }

    await this.runTask('Refresh invites', async () => {
      const session = this.requireSession()
      const invites = await this.withTimeout(
        this.groupService.discoverInvites(
          this.searchableRelayUrls(),
          session.pubkey,
          async (pubkey, ciphertext) => nip04Decrypt(session.nsecHex, pubkey, ciphertext)
        ),
        12_000,
        'Invite refresh'
      )

      if (refreshToken !== this.inviteRefreshToken) {
        this.log('debug', 'Dropped stale invite refresh result')
        return
      }

      const filtered = filterActionableGroupInvites({
        invites,
        myGroupList: this.state.myGroupList,
        dismissedInviteIds: new Set(this.state.dismissedGroupInviteIds),
        acceptedInviteIds: new Set(this.state.acceptedGroupInviteIds),
        acceptedInviteGroupIds: new Set(this.state.acceptedGroupInviteGroupIds)
      })
      this.patchState({
        invites: filtered,
        groupInvites: filtered
      })
      await this.ensureAdminProfiles(
        filtered.map((invite) => invite.event?.pubkey || '').filter(Boolean)
      )
    }, { dedupeKey: 'refresh:group-invites', retries: 0 })
  }

  async acceptGroupInvite(inviteId: string): Promise<void> {
    await this.runTask('Accept group invite', async () => {
      const target = this.state.groupInvites.find((invite) => invite.id === inviteId)
      if (!target) {
        throw new Error(`Group invite not found: ${inviteId}`)
      }

      await this.startJoinFlow({
        publicIdentifier: target.groupId,
        token: target.token,
        relayKey: target.relayKey || undefined,
        relayUrl: target.relayUrl || target.relay,
        gatewayOrigin: target.gatewayOrigin || undefined,
        gatewayId: target.gatewayId || undefined,
        directJoinOnly: target.directJoinOnly === true,
        discoveryTopic: target.discoveryTopic || undefined,
        hostPeerKeys: target.hostPeerKeys || undefined,
        leaseReplicaPeerKeys: target.leaseReplicaPeerKeys || undefined,
        writerIssuerPubkey: target.writerIssuerPubkey || undefined,
        writerLeaseEnvelope: target.writerLeaseEnvelope || undefined,
        gatewayAccess: target.gatewayAccess || undefined,
        fileSharing: target.fileSharing,
        openJoin: !target.token && target.fileSharing !== false,
        blindPeer: target.blindPeer || undefined,
        cores: target.cores || undefined,
        writerCore: target.writerCore || undefined,
        writerCoreHex: target.writerCoreHex || undefined,
        autobaseLocal: target.autobaseLocal || undefined,
        writerSecret: target.writerSecret || undefined,
        fastForward: target.fastForward || undefined
      })

      const accepted = this.groupService.markInviteAccepted(
        new Set(this.state.acceptedGroupInviteIds),
        new Set(this.state.acceptedGroupInviteGroupIds),
        inviteId,
        target.groupId
      )
      const nextInvites = this.state.groupInvites.filter((invite) => invite.id !== inviteId)
      this.patchState({
        invites: nextInvites,
        groupInvites: nextInvites,
        acceptedGroupInviteIds: Array.from(accepted.inviteIds),
        acceptedGroupInviteGroupIds: Array.from(accepted.groupIds)
      })
      await this.persistAccountScopedUiState({
        acceptedGroupInviteIds: this.state.acceptedGroupInviteIds,
        acceptedGroupInviteGroupIds: this.state.acceptedGroupInviteGroupIds
      })
    })
  }

  async dismissGroupInvite(inviteId: string): Promise<void> {
    await this.runTask('Dismiss group invite', async () => {
      const dismissed = this.groupService.dismissInvite(
        new Set(this.state.dismissedGroupInviteIds),
        inviteId
      )
      const nextInvites = this.state.groupInvites.filter((invite) => invite.id !== inviteId)
      this.patchState({
        invites: nextInvites,
        groupInvites: nextInvites,
        dismissedGroupInviteIds: Array.from(dismissed)
      })
      await this.persistAccountScopedUiState({
        dismissedGroupInviteIds: this.state.dismissedGroupInviteIds
      })
    })
  }

  async refreshJoinRequests(groupId: string, relay?: string): Promise<void> {
    await this.runTask('Refresh join requests', async () => {
      const key = groupScopeKey(groupId, relay || null)
      const requests = await this.groupService.loadJoinRequests(
        this.searchableRelayUrls(),
        groupId,
        {
          currentMembers: new Set()
        }
      )
      this.patchState({
        groupJoinRequests: {
          ...this.state.groupJoinRequests,
          [key]: requests
        }
      })
    }, { dedupeKey: `refresh:join-requests:${groupId}:${relay || ''}`, retries: 1 })
  }

  async approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.runTask('Approve join request', async () => {
      const approvalStartedAt = Date.now()
      const normalizedGroupId = String(groupId || '').trim()
      const normalizedPubkey = String(pubkey || '').trim().toLowerCase()
      if (!normalizedGroupId) {
        throw new Error('groupId is required')
      }
      if (!/^[a-f0-9]{64}$/i.test(normalizedPubkey)) {
        throw new Error(`Invalid pubkey for join request approval: ${pubkey}`)
      }

      const selectedGroup =
        this.state.myGroups.find((entry) => entry.id === normalizedGroupId)
        || this.state.groupDiscover.find((entry) => entry.id === normalizedGroupId)
        || null
      const relayUrl = this.resolveGroupRelayUrl(
        normalizedGroupId,
        relay || selectedGroup?.relay || null
      ) || this.resolveRelayUrl(relay || undefined)
      if (!relayUrl) {
        throw new Error('Unable to resolve relay URL for invite approval')
      }

      const relayEntry = this.findConnectedRelayByIdentifier(normalizedGroupId)
      const relayKey =
        relay && /^[a-f0-9]{64}$/i.test(relay)
          ? relay.toLowerCase()
          : (relayEntry?.relayKey || null)
      const isOpenGroup = selectedGroup?.isOpen === true
      const token = isOpenGroup ? undefined : Buffer.from(generateSecretKey()).toString('hex').slice(0, 24)
      const inviteApprovalTraceId = `${normalizedGroupId.slice(0, 10)}:${normalizedPubkey.slice(0, 10)}:${approvalStartedAt.toString(36)}`
      this.log(
        'info',
        `[invite-approval:${inviteApprovalTraceId}] start group=${normalizedGroupId} open=${isOpenGroup} relay=${relayUrl.slice(0, 80)}`
      )
      const groupMembers = Array.isArray(selectedGroup?.members)
        ? selectedGroup.members.filter((member) => /^[a-f0-9]{64}$/i.test(String(member || '').trim()))
        : []
      const payload: Record<string, unknown> = {
        relayUrl,
        relayKey: relayKey || null,
        gatewayId: selectedGroup?.gatewayId || null,
        gatewayOrigin: selectedGroup?.gatewayOrigin || null,
        gatewayAuthMethod: selectedGroup?.gatewayAuthMethod || null,
        directJoinOnly: selectedGroup?.directJoinOnly === true,
        discoveryTopic: selectedGroup?.discoveryTopic || null,
        hostPeerKeys: Array.isArray(selectedGroup?.hostPeerKeys) ? selectedGroup.hostPeerKeys : undefined,
        leaseReplicaPeerKeys: Array.isArray(selectedGroup?.leaseReplicaPeerKeys)
          ? selectedGroup.leaseReplicaPeerKeys
          : undefined,
        writerIssuerPubkey: selectedGroup?.writerIssuerPubkey || null,
        groupName: selectedGroup?.name || normalizedGroupId,
        groupPicture: selectedGroup?.picture || null,
        name: selectedGroup?.name || normalizedGroupId,
        about: selectedGroup?.about || '',
        isPublic: selectedGroup?.isPublic !== false,
        fileSharing: isOpenGroup,
        authorizedMemberPubkeys: Array.from(new Set([...groupMembers, normalizedPubkey])),
        token: token || null
      }

      if (!isOpenGroup) {
        const memberTs = Date.now()
        try {
          await this.groupService.updateAuthData({
            relayKey: relayKey || undefined,
            publicIdentifier: normalizedGroupId,
            pubkey: normalizedPubkey,
            token: token || ''
          })
        } catch (error) {
          this.log('warn', `Failed updating group auth during join approval: ${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          await this.groupService.updateMembers({
            relayKey: relayKey || undefined,
            publicIdentifier: normalizedGroupId,
            memberAdds: [{ pubkey: normalizedPubkey, ts: memberTs }]
          })
        } catch (error) {
          this.log('warn', `Failed updating members during join approval: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      await this.sendInvite({
        groupId: normalizedGroupId,
        relayUrl,
        inviteePubkey: normalizedPubkey,
        token,
        payload,
        relayTargets: this.searchableRelayUrls(16)
      })
      this.log(
        'info',
        `[invite-approval:${inviteApprovalTraceId}] invite sent elapsedMs=${Date.now() - approvalStartedAt} token=${token ? 'present' : 'none'}`
      )

      const key = groupScopeKey(normalizedGroupId, relay || null)
      const next = (this.state.groupJoinRequests[key] || []).filter((request) => request.pubkey !== normalizedPubkey)
      this.patchState({
        groupJoinRequests: {
          ...this.state.groupJoinRequests,
          [key]: next
        }
      })
    })
  }

  async rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.runTask('Reject join request', async () => {
      await this.groupService.rejectJoinRequest(groupId, pubkey, relay)
      const key = groupScopeKey(groupId, relay || null)
      const next = (this.state.groupJoinRequests[key] || []).filter((request) => request.pubkey !== pubkey)
      this.patchState({
        groupJoinRequests: {
          ...this.state.groupJoinRequests,
          [key]: next
        }
      })
    })
  }

  async sendInvite(input: {
    groupId: string
    relayUrl: string
    inviteePubkey: string
    token?: string
    payload: Record<string, unknown>
    relayTargets?: string[]
  }): Promise<void> {
    await this.runTask('Send invite', async () => {
      await this.ensureWorkerReadyForOperation('send invite')

      const session = this.requireSession()
      const normalizedGroupId = String(input.groupId || '').trim()
      const normalizedInvitee = String(input.inviteePubkey || '').trim().toLowerCase()
      const inviteSendStartedAt = Date.now()
      const inviteTraceId = `${normalizedGroupId.slice(0, 10)}:${normalizedInvitee.slice(0, 10)}:${inviteSendStartedAt.toString(36)}`
      if (!normalizedGroupId) throw new Error('groupId is required')
      if (!/^[a-f0-9]{64}$/i.test(normalizedInvitee)) {
        throw new Error(`Invalid invitee pubkey: ${input.inviteePubkey}`)
      }
      this.log('info', `[invite-send:${inviteTraceId}] start group=${normalizedGroupId}`)

      await this.ensureGatewayParityReady({
        reason: 'send-invite',
        refreshPublicGateway: true
      }).catch((error) => {
        this.log('warn', `Gateway parity preflight failed before send invite: ${error instanceof Error ? error.message : String(error)}`)
      })

      const resolvedRelayKey =
        await this.resolveRelayKeyForIdentifier(normalizedGroupId)
        || this.findConnectedRelayByIdentifier(normalizedGroupId)?.relayKey
        || null
      const resolvedRelayUrl =
        String(input.relayUrl || '').trim()
        || this.resolveGroupRelayUrl(normalizedGroupId, input.relayUrl || null)
        || ''
      if (!resolvedRelayUrl) {
        throw new Error('Unable to resolve relay URL for invite')
      }

      const payloadInput = input.payload as Record<string, unknown>
      const normalizeHttpOrigin = (value: unknown): string | null => {
        if (typeof value !== 'string' || !value.trim()) return null
        try {
          const parsed = new URL(value.trim())
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
          return parsed.origin
        } catch {
          return null
        }
      }
      const discoveryTopic = typeof payloadInput.discoveryTopic === 'string'
        ? payloadInput.discoveryTopic
        : null
      const hostPeerKeys = Array.isArray(payloadInput.hostPeerKeys)
        ? payloadInput.hostPeerKeys
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
        : []
      const payloadLeaseReplicaPeerKeys = Array.isArray(payloadInput.leaseReplicaPeerKeys)
        ? payloadInput.leaseReplicaPeerKeys
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
        : []
      const payloadWriterIssuerPubkey = typeof payloadInput.writerIssuerPubkey === 'string'
        ? payloadInput.writerIssuerPubkey.trim().toLowerCase()
        : null
      const payloadGatewayAccess =
        payloadInput.gatewayAccess && typeof payloadInput.gatewayAccess === 'object'
          ? payloadInput.gatewayAccess as Record<string, unknown>
          : payloadInput.gateway_access && typeof payloadInput.gateway_access === 'object'
            ? payloadInput.gateway_access as Record<string, unknown>
            : null
      const payloadGatewayOrigin =
        normalizeHttpOrigin(payloadInput.gatewayOrigin)
        || normalizeHttpOrigin(payloadInput.gateway_origin)
      const payloadGatewayId =
        typeof payloadInput.gatewayId === 'string'
          ? payloadInput.gatewayId.trim().toLowerCase()
          : typeof payloadInput.gateway_id === 'string'
            ? payloadInput.gateway_id.trim().toLowerCase()
            : null
      const payloadGatewayAccessAuthMethod =
        payloadGatewayAccess && typeof payloadGatewayAccess.authMethod === 'string'
          ? payloadGatewayAccess.authMethod.trim()
          : payloadGatewayAccess && typeof payloadGatewayAccess.auth_method === 'string'
            ? payloadGatewayAccess.auth_method.trim()
            : null
      const payloadGatewayAuthMethod =
        typeof payloadInput.gatewayAuthMethod === 'string'
          ? payloadInput.gatewayAuthMethod.trim()
          : typeof payloadInput.gateway_auth_method === 'string'
            ? payloadInput.gateway_auth_method.trim()
            : null
      const effectiveGatewayAuthMethod =
        payloadGatewayAccessAuthMethod
        || payloadGatewayAuthMethod
        || null
      const isOpenGroup = input.token
        ? false
        : (typeof payloadInput.fileSharing === 'boolean' ? payloadInput.fileSharing : true)
      const inviteTokenCandidate = String(
        input.token
        || (typeof payloadInput.token === 'string' ? payloadInput.token : '')
      ).trim()
      const inviteToken = inviteTokenCandidate || (!isOpenGroup
        ? Buffer.from(generateSecretKey()).toString('hex').slice(0, 24)
        : '')
      this.log(
        'info',
        `[invite-send:${inviteTraceId}] relay resolved relayKey=${resolvedRelayKey ? resolvedRelayKey.slice(0, 16) : 'none'} open=${isOpenGroup} token=${inviteToken ? 'present' : 'none'}`
      )

      if (!isOpenGroup && !resolvedRelayKey) {
        throw new Error('Unable to resolve relay key for closed invite writer provisioning')
      }

      if (!isOpenGroup && inviteToken) {
        try {
          await this.groupService.updateAuthData({
            relayKey: resolvedRelayKey || undefined,
            publicIdentifier: normalizedGroupId,
            pubkey: normalizedInvitee,
            token: inviteToken
          })
        } catch (error) {
          this.log('warn', `Failed to update auth data while sending invite: ${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          await this.groupService.updateMembers({
            relayKey: resolvedRelayKey || undefined,
            publicIdentifier: normalizedGroupId,
            memberAdds: [{ pubkey: normalizedInvitee, ts: Date.now() }]
          })
        } catch (error) {
          this.log('warn', `Failed to update members while sending invite: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      let writerProvision: Record<string, unknown> | null = null
      if (!isOpenGroup && resolvedRelayKey) {
        const provisionStartedAt = Date.now()
        this.log(
          'info',
          `[invite-send:${inviteTraceId}] writer provisioning start relayKey=${resolvedRelayKey.slice(0, 16)}`
        )
        try {
          writerProvision = await this.workerHost.request<Record<string, unknown>>(
            {
              type: 'provision-writer-for-invitee',
              data: {
                relayKey: resolvedRelayKey,
                publicIdentifier: normalizedGroupId,
                inviteePubkey: normalizedInvitee,
                token: inviteToken || undefined,
                leaseReplicaPeerKeys: payloadLeaseReplicaPeerKeys,
                useWriterPool: true,
                inviteTraceId,
                requireWriterMaterial: true
              }
            },
            90_000
          )
          this.log(
            'info',
            `[invite-send:${inviteTraceId}] writer provisioning complete elapsedMs=${Date.now() - provisionStartedAt}`
          )
        } catch (error) {
          const inviteePreview = normalizedInvitee ? `${normalizedInvitee.slice(0, 12)}…` : 'unknown'
          this.log(
            'warn',
            `[invite-send:${inviteTraceId}] failed to provision writer for invitee ${inviteePreview} elapsedMs=${Date.now() - provisionStartedAt}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      const writerCore = typeof writerProvision?.writerCore === 'string' ? writerProvision.writerCore : null
      let writerCoreHex = typeof writerProvision?.writerCoreHex === 'string' ? writerProvision.writerCoreHex : null
      let autobaseLocal = typeof writerProvision?.autobaseLocal === 'string' ? writerProvision.autobaseLocal : null
      if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
      if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal
      const writerSecret = typeof writerProvision?.writerSecret === 'string' ? writerProvision.writerSecret : null
      const writerLeaseEnvelope =
        writerProvision?.writerLeaseEnvelope && typeof writerProvision.writerLeaseEnvelope === 'object'
          ? writerProvision.writerLeaseEnvelope as Record<string, unknown>
          : null
      const writerIssuerPubkey = typeof writerProvision?.writerIssuerPubkey === 'string'
        ? writerProvision.writerIssuerPubkey
        : payloadWriterIssuerPubkey
      const leaseReplicaPeerKeys = Array.isArray(writerProvision?.leaseReplicaPeerKeys)
        ? writerProvision.leaseReplicaPeerKeys
            .map((entry) => String(entry || '').trim().toLowerCase())
            .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
        : payloadLeaseReplicaPeerKeys
      const fastForward = writerProvision?.fastForward && typeof writerProvision.fastForward === 'object'
        ? writerProvision.fastForward
        : null
      const hasClosedWriterMaterial = Boolean(writerSecret || writerLeaseEnvelope)
      if (!isOpenGroup) {
        this.log(
          'info',
          `[invite-send:${inviteTraceId}] closed writer material writerSecret=${writerSecret ? 'yes' : 'no'} leaseEnvelope=${writerLeaseEnvelope ? 'yes' : 'no'} writerCore=${writerCore ? 'yes' : 'no'} writerCoreHex=${writerCoreHex ? 'yes' : 'no'}`
        )
      }
      if (!isOpenGroup && !hasClosedWriterMaterial) {
        throw new Error(
          'Closed invite provisioning incomplete: missing writerSecret/writerLeaseEnvelope; invite not sent'
        )
      }

      const gatewayAccess =
        !isOpenGroup
        && effectiveGatewayAuthMethod === 'relay-scoped-bearer-v1'
        && payloadGatewayOrigin
        && resolvedRelayKey
          ? await this.workerHost.request<Record<string, unknown>>(
              {
                type: 'authorize-relay-member-access',
                data: {
                  relayKey: resolvedRelayKey,
                  publicIdentifier: normalizedGroupId,
                  subjectPubkey: normalizedInvitee,
                  gatewayOrigin: payloadGatewayOrigin,
                  gatewayId: payloadGatewayId,
                  scopes: ['relay:bootstrap', 'relay:mirror-read', 'relay:mirror-sync', 'relay:ws-connect']
                }
              },
              30_000
            )
          : null

      const mergedCores = new Map<string, { key: string; role?: string | null }>()
      const upsertCore = (key: string, role?: string | null): void => {
        const normalized = String(key || '').trim()
        if (!normalized) return
        const existing = mergedCores.get(normalized)
        if (!existing) {
          mergedCores.set(normalized, { key: normalized, role: role || null })
          return
        }
        if (!existing.role && role) {
          mergedCores.set(normalized, { ...existing, role })
        }
      }

      const payloadCores = Array.isArray(payloadInput.cores)
        ? payloadInput.cores
        : []
      for (const entry of payloadCores) {
        if (!entry || typeof entry !== 'object') continue
        const row = entry as Record<string, unknown>
        upsertCore(String(row.key || '').trim(), typeof row.role === 'string' ? row.role : null)
      }
      const poolCoreRefs = Array.isArray(writerProvision?.poolCoreRefs)
        ? writerProvision.poolCoreRefs
        : []
      for (const coreRef of poolCoreRefs) {
        upsertCore(String(coreRef || '').trim(), 'autobase-writer')
      }
      upsertCore(writerCoreHex || autobaseLocal || writerCore || '', 'autobase-writer')

      const payload = {
        ...payloadInput,
        relayUrl: resolvedRelayUrl,
        relayKey: resolvedRelayKey || payloadInput.relayKey || null,
        discoveryTopic: discoveryTopic || null,
        hostPeerKeys: hostPeerKeys.length ? hostPeerKeys : undefined,
        leaseReplicaPeerKeys: leaseReplicaPeerKeys.length ? leaseReplicaPeerKeys : undefined,
        writerIssuerPubkey: writerIssuerPubkey || null,
        writerLeaseEnvelope: writerLeaseEnvelope || null,
        gatewayAccess: gatewayAccess || payloadGatewayAccess || null,
        token: inviteToken || null,
        writerCore: writerCore || payloadInput.writerCore || null,
        writerCoreHex: writerCoreHex || payloadInput.writerCoreHex || payloadInput.writer_core_hex || null,
        autobaseLocal: autobaseLocal || payloadInput.autobaseLocal || payloadInput.autobase_local || null,
        writerSecret: writerSecret || payloadInput.writerSecret || null,
        fastForward: fastForward || payloadInput.fastForward || payloadInput.fast_forward || null,
        authorizedMemberPubkeys: Array.from(new Set(
          [
            ...(Array.isArray(payloadInput.authorizedMemberPubkeys) ? payloadInput.authorizedMemberPubkeys : []),
            ...(Array.isArray(payloadInput.authorizedMembers) ? payloadInput.authorizedMembers : []),
            normalizedInvitee
          ]
            .map((entry) => String(entry || '').trim().toLowerCase())
            .filter((entry) => /^[a-f0-9]{64}$/i.test(entry))
        )),
        cores: mergedCores.size > 0 ? Array.from(mergedCores.values()) : payloadInput.cores || undefined
      }

      await this.groupService.sendInvite({
        ...input,
        token: inviteToken || undefined,
        inviteePubkey: normalizedInvitee,
        relayUrl: resolvedRelayUrl,
        payload,
        relayTargets: input.relayTargets && input.relayTargets.length
          ? input.relayTargets
          : this.searchableRelayUrls(),
        encrypt: (pubkey, plaintext) => nip04Encrypt(session.nsecHex, pubkey, plaintext)
      })
      this.log('info', `[invite-send:${inviteTraceId}] published elapsedMs=${Date.now() - inviteSendStartedAt}`)
    })
  }

  async updateGroupMembers(input: {
    relayKey?: string
    publicIdentifier?: string
    members?: string[]
    memberAdds?: Array<{ pubkey: string; ts: number }>
    memberRemoves?: Array<{ pubkey: string; ts: number }>
  }): Promise<void> {
    await this.runTask('Update members', async () => {
      await this.groupService.updateMembers(input)
    })
  }

  async updateGroupAuth(input: {
    relayKey?: string
    publicIdentifier?: string
    pubkey: string
    token: string
  }): Promise<void> {
    await this.runTask('Update auth data', async () => {
      await this.groupService.updateAuthData(input)
    })
  }

  async refreshGroupMembers(groupId: string, relay?: string): Promise<GroupSummary | null> {
    return await this.runTask('Refresh group members', async () => {
      const normalizedGroupId = String(groupId || '').trim()
      if (!normalizedGroupId) {
        throw new Error('groupId is required')
      }
      const existing = this.rawGroupDiscover.find((group) => group.id === normalizedGroupId)
      const seed: GroupSummary = existing || {
        id: normalizedGroupId,
        relay,
        name: normalizedGroupId,
        about: '',
        isPublic: true,
        isOpen: true
      }
      const [enriched] = await this.enrichGroupMetadata([{
        ...seed,
        relay: relay || seed.relay
      }])
      if (!enriched) return null

      let replaced = false
      this.rawGroupDiscover = this.rawGroupDiscover.map((group) => {
        if (group.id !== enriched.id) return group
        replaced = true
        return enriched
      })
      if (!replaced) {
        this.rawGroupDiscover = [enriched, ...this.rawGroupDiscover]
      }
      this.syncGroupView()
      return enriched
    })
  }

  async startComposeDraft(groupId: string, relay?: string): Promise<void> {
    const normalizedGroupId = String(groupId || '').trim()
    if (!normalizedGroupId) {
      throw new Error('groupId is required')
    }
    const resolvedRelay = this.resolveGroupRelayUrl(normalizedGroupId, relay || null)
    const nextDraft: GroupComposeDraft = {
      groupId: normalizedGroupId,
      relay: resolvedRelay || relay || null,
      content: '',
      attachments: []
    }
    this.patchState({ composeDraft: nextDraft })
  }

  async updateComposeText(content: string): Promise<void> {
    const draft = this.state.composeDraft
    if (!draft) throw new Error('No compose draft in progress')
    this.patchState({
      composeDraft: {
        ...draft,
        content
      }
    })
  }

  async attachComposeFile(filePath: string): Promise<void> {
    const draft = this.state.composeDraft
    if (!draft) throw new Error('No compose draft in progress')
    const resolvedPath = path.resolve(filePath)
    const stats = await fs.stat(resolvedPath)
    if (!stats.isFile()) {
      throw new Error('Attachment path is not a file')
    }
    const fileName = path.basename(resolvedPath)
    const nextAttachment: GroupDraftAttachment = {
      filePath: resolvedPath,
      fileName,
      mime: guessMimeFromPath(resolvedPath),
      size: stats.size
    }
    this.patchState({
      composeDraft: {
        ...draft,
        attachments: [...draft.attachments, nextAttachment]
      }
    })
  }

  async removeComposeAttachment(selector: string): Promise<void> {
    const draft = this.state.composeDraft
    if (!draft) throw new Error('No compose draft in progress')
    const normalized = String(selector || '').trim()
    if (!normalized) throw new Error('Attachment selector is required')
    const index = Number.parseInt(normalized, 10)
    const nextAttachments = Number.isFinite(index)
      ? draft.attachments.filter((_entry, idx) => idx !== index)
      : draft.attachments.filter((entry) =>
        entry.filePath !== normalized && entry.fileName !== normalized
      )
    this.patchState({
      composeDraft: {
        ...draft,
        attachments: nextAttachments
      }
    })
  }

  composeDraftSnapshot(): GroupComposeDraft | null {
    if (!this.state.composeDraft) return null
    return {
      ...this.state.composeDraft,
      attachments: this.state.composeDraft.attachments.map((entry) => ({ ...entry }))
    }
  }

  async cancelComposeDraft(): Promise<void> {
    this.patchState({ composeDraft: null })
  }

  async publishComposeDraft(): Promise<Event> {
    return await this.runTask('Publish compose draft', async () => {
      const session = this.requireSession()
      const draft = this.state.composeDraft
      if (!draft) throw new Error('No compose draft in progress')

      if (!draft.content.trim() && draft.attachments.length === 0) {
        throw new Error('Compose draft has no content or attachments')
      }

      const relayUrl = this.resolveGroupRelayUrl(draft.groupId, draft.relay || null)
      const publishRelays = relayUrl
        ? uniqueRelayUrls([relayUrl, ...this.currentWriteRelayUrls()])
        : this.currentWriteRelayUrls()

      if (!publishRelays.length) {
        throw new Error('No relay targets available for compose publish')
      }

      const uploadResults: Array<Record<string, unknown>> = []
      for (const attachment of draft.attachments) {
        const upload = await this.fileService.uploadFile({
          publicIdentifier: draft.groupId,
          filePath: attachment.filePath,
          metadata: {
            source: 'group-hyperdrive'
          }
        })
        uploadResults.push(upload)
      }

      const tags: string[][] = [['h', draft.groupId]]
      if (uploadResults.length > 0) {
        tags.push(['i', 'hyperpipe:drive'])
      }

      for (const upload of uploadResults) {
        const uploadRecord = upload as Record<string, unknown>
        const url = String(uploadRecord.url || uploadRecord.gatewayUrl || '').trim()
        if (!url) continue
        tags.push(['r', url, 'hyperpipe:drive'])

        const imeta: string[] = [`url ${url}`]
        const uploadSize = Number(uploadRecord.size)
        if (typeof uploadRecord.mime === 'string' && uploadRecord.mime) imeta.push(`m ${uploadRecord.mime}`)
        if (typeof uploadRecord.sha256 === 'string' && uploadRecord.sha256) imeta.push(`x ${uploadRecord.sha256}`)
        if (typeof uploadRecord.ox === 'string' && uploadRecord.ox) imeta.push(`ox ${uploadRecord.ox}`)
        if (Number.isFinite(uploadSize)) imeta.push(`size ${uploadSize}`)
        if (typeof uploadRecord.dim === 'string' && uploadRecord.dim) imeta.push(`dim ${uploadRecord.dim}`)
        if (imeta.length > 0) {
          tags.push(['imeta', ...imeta])
        }
      }

      const draftEvent = {
        kind: 1,
        created_at: eventNow(),
        tags,
        content: draft.content
      }

      const noteEvent = signDraftEvent(session.nsecHex, draftEvent)
      await this.nostrClient.publish(publishRelays, noteEvent)

      for (const upload of uploadResults) {
        const uploadRecord = upload as Record<string, unknown>
        const url = String(uploadRecord.url || uploadRecord.gatewayUrl || '').trim()
        if (!url) continue
        const uploadSize = Number(uploadRecord.size)
        const fileMetadataDraft = createGroupFileMetadataDraftEvent({
          url,
          groupId: draft.groupId,
          mime: typeof uploadRecord.mime === 'string' ? uploadRecord.mime : undefined,
          sha256: typeof uploadRecord.sha256 === 'string' ? uploadRecord.sha256 : undefined,
          ox: typeof uploadRecord.ox === 'string' ? uploadRecord.ox : undefined,
          size: Number.isFinite(uploadSize) ? uploadSize : undefined,
          dim: typeof uploadRecord.dim === 'string' ? uploadRecord.dim : undefined,
          alt: typeof uploadRecord.fileId === 'string' ? uploadRecord.fileId : undefined
        })
        const metadataEvent = signDraftEvent(session.nsecHex, fileMetadataDraft)
        await this.nostrClient.publish(publishRelays, metadataEvent)
      }

      this.patchState({ composeDraft: null })
      await this.refreshFeed(this.feedLimit)
      await this.refreshGroupFiles(draft.groupId)
      return noteEvent
    })
  }

  async publishGroupNote(input: {
    groupId: string
    relayUrl: string
    content: string
  }): Promise<Event> {
    return await this.runTask('Publish relay note', async () => {
      const session = this.requireSession()
      const groupId = String(input.groupId || '').trim()
      const relayUrl = normalizeRelayUrl(input.relayUrl)
      const content = String(input.content || '').trim()
      if (!groupId) {
        throw new Error('groupId is required')
      }
      if (!relayUrl) {
        throw new Error('relayUrl is required')
      }
      if (!content) {
        throw new Error('Note content is required')
      }

      const draft: EventTemplate = {
        kind: 1,
        created_at: eventNow(),
        tags: [['h', groupId]],
        content
      }
      const event = signDraftEvent(session.nsecHex, draft)
      await this.nostrClient.publish([relayUrl], event)
      return event
    })
  }

  async uploadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Upload file', async () => {
      const result = await this.fileService.uploadFile(input)
      await this.refreshGroupFiles(input.publicIdentifier || input.relayKey || undefined)
      return result
    })
  }

  async downloadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
    fileName?: string | null
  }): Promise<{ savedPath: string; bytes: number; source: string }> {
    return await this.runTask('Download file', async () => {
      this.patchState({
        fileActionStatus: {
          action: 'download',
          state: 'in-progress',
          updatedAt: Date.now(),
          eventId: input.eventId || null,
          sha256: input.fileHash,
          message: 'Downloading file…',
          path: null
        }
      })
      const result = await this.fileService.downloadGroupFile(input)
      const hiddenKey = `${input.groupId || input.publicIdentifier || input.relayKey || ''}:${input.fileHash}`
      const nextHidden = this.state.hiddenDeletedFileKeys.filter((key) => key !== hiddenKey)
      this.patchState({
        hiddenDeletedFileKeys: nextHidden,
        fileActionStatus: {
          action: 'download',
          state: 'success',
          updatedAt: Date.now(),
          eventId: input.eventId || null,
          sha256: input.fileHash,
          message: 'Download complete',
          path: result.savedPath
        }
      })
      await this.persistAccountScopedUiState({ hiddenDeletedFileKeys: nextHidden })
      await this.refreshGroupFiles(input.groupId || input.publicIdentifier || input.relayKey || undefined)
      return result
    })
  }

  async deleteLocalGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
  }): Promise<{ deleted: boolean; reason?: string | null }> {
    return await this.runTask('Delete local file', async () => {
      this.patchState({
        fileActionStatus: {
          action: 'delete',
          state: 'in-progress',
          updatedAt: Date.now(),
          eventId: input.eventId || null,
          sha256: input.fileHash,
          message: 'Deleting local file…',
          path: null
        }
      })
      const result = await this.fileService.deleteLocalGroupFile(input)
      const keyPrefix = input.groupId || input.publicIdentifier || input.relayKey || ''
      const fileKey = `${keyPrefix}:${input.fileHash}`
      const hiddenKeys = new Set(this.state.hiddenDeletedFileKeys)
      hiddenKeys.add(fileKey)
      const nextHidden = Array.from(hiddenKeys)
      this.patchState({
        hiddenDeletedFileKeys: nextHidden,
        fileActionStatus: {
          action: 'delete',
          state: result.deleted ? 'success' : 'error',
          updatedAt: Date.now(),
          eventId: input.eventId || null,
          sha256: input.fileHash,
          message: result.deleted ? 'File deleted from local storage' : (result.reason || 'Delete failed'),
          path: null
        }
      })
      await this.persistAccountScopedUiState({ hiddenDeletedFileKeys: nextHidden })
      this.syncFilesView()
      return result
    })
  }

  async refreshGroupNotes(groupId: string, relay?: string): Promise<void> {
    const normalizedGroupId = String(groupId || '').trim()
    if (!normalizedGroupId) {
      throw new Error('groupId is required')
    }
    const key = groupScopeKey(normalizedGroupId, relay || null)
    this.patchState({
      groupNotesLoadStateByGroupKey: {
        ...this.state.groupNotesLoadStateByGroupKey,
        [key]: 'loading'
      }
    })

    try {
      await this.runTask('Refresh group notes', async () => {
        const relayCandidates = relay ? uniqueRelayUrls([relay, ...this.searchableRelayUrls()]) : this.searchableRelayUrls()
        const events = await this.feedService.fetchFeed(
          relayCandidates,
          {
            kinds: [1],
            '#h': [normalizedGroupId],
            limit: 350
          },
          FEED_REFRESH_TIMEOUT_MS
        )
        const notes: GroupNoteRecord[] = events
          .map((event) => ({
            eventId: event.id,
            groupId: normalizedGroupId,
            relay: relay || null,
            content: event.content || '',
            createdAt: Number(event.created_at || 0),
            authorPubkey: event.pubkey,
            event
          }))
          .sort((left, right) => right.createdAt - left.createdAt)
        const next = {
          ...this.state.groupNotesByGroupKey,
          [key]: notes
        }
        this.patchState({
          groupNotesByGroupKey: next,
          groupNotesLoadStateByGroupKey: {
            ...this.state.groupNotesLoadStateByGroupKey,
            [key]: notes.length > 0 ? 'ready' : 'empty'
          }
        })
        await this.ensureAdminProfiles(notes.map((entry) => entry.authorPubkey))
      }, { dedupeKey: `refresh:group-notes:${normalizedGroupId}:${relay || ''}`, retries: 0 })
    } catch (error) {
      this.patchState({
        groupNotesLoadStateByGroupKey: {
          ...this.state.groupNotesLoadStateByGroupKey,
          [key]: 'error'
        }
      })
      throw error
    }
  }

  async refreshGroupFiles(groupId?: string): Promise<void> {
    await this.runTask('Refresh files', async () => {
      let files: GroupFileRecord[] = []
      if (groupId) {
        files = await this.fileService.fetchGroupFiles(this.searchableRelayUrls(), groupId)
      } else {
        const archivedEntries: ArchivedGroupEntry[] = []
        const scope = buildScopedFileScope({
          myGroupList: this.state.myGroupList,
          archivedGroups: archivedEntries,
          discoveryGroups: this.state.groupDiscover,
          resolveRelayUrl: (relay) => this.resolveRelayUrl(relay)
        })
        files = await this.fileService.fetchScopedGroupFiles(scope, 1_500)
      }
      this.rawFiles = files.map((file) => ({ ...file }))
      if (groupId) {
        const key = groupScopeKey(groupId)
        this.patchState({
          groupFilesByGroupKey: {
            ...this.state.groupFilesByGroupKey,
            [key]: files.map((file) => ({ ...file }))
          }
        })
      }
      this.syncFilesView()
    }, { dedupeKey: `refresh:files:${groupId || 'all'}`, retries: 1 })
  }

  async refreshStarterPacks(): Promise<void> {
    await this.runTask('Refresh starter packs', async () => {
      const lists = await this.listService.fetchStarterPacks(this.searchableRelayUrls())
      this.patchState({ lists })
    })
  }

  async createStarterPack(input: {
    dTag: string
    title: string
    description?: string
    image?: string
    pubkeys: string[]
  }): Promise<void> {
    await this.runTask('Create starter pack', async () => {
      await this.listService.publishStarterPack({
        ...input,
        relays: this.searchableRelayUrls()
      })
      await this.refreshStarterPacks()
    })
  }

  async applyStarterPack(listId: string, authorPubkey?: string): Promise<void> {
    await this.runTask('Apply starter pack', async () => {
      const session = this.requireSession()
      const target = this.state.lists.find((entry) => entry.id === listId && (!authorPubkey || entry.event.pubkey === authorPubkey))

      if (!target) {
        throw new Error('Starter pack not found')
      }

      const currentFollows = await this.listService.loadFollowList(this.currentRelayUrls(), session.pubkey)
      const merged = Array.from(new Set([...currentFollows, ...target.pubkeys]))
      await this.listService.publishFollowList(merged, this.currentRelayUrls())
    })
  }

  async initChats(): Promise<void> {
    await this.runTask('Initialize chats', async () => {
      await this.initializeChatsWithRecovery('manual-init')
    }, { dedupeKey: 'refresh:chats:init', retries: 0 })
  }

  async refreshChats(): Promise<void> {
    await this.runTask('Refresh chats', async () => {
      try {
        const snapshot = await this.fetchChatSnapshot(12_000, 'Chat refresh')
        this.clearChatRetryTimer()
        this.patchState({
          conversations: snapshot.conversations,
          chatInvites: snapshot.invites,
          chatRuntimeState: 'ready',
          chatWarning: null,
          chatRetryCount: 0,
          chatNextRetryAt: null,
          lastError: null
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (this.isTransientChatError(message)) {
          this.markChatsDegraded(message, 'chat-refresh')
          return
        }
        throw error
      }
    }, { dedupeKey: 'refresh:chats', retries: 0 })
  }

  async createConversation(input: {
    title: string
    description?: string
    members: string[]
    relayUrls?: string[]
    relayMode?: 'withFallback' | 'strict'
  }): Promise<void> {
    await this.runTask('Create conversation', async () => {
      await this.chatService.createConversation({
        ...input,
        relayUrls: input.relayUrls && input.relayUrls.length > 0
          ? uniqueRelayUrls(input.relayUrls)
          : this.currentRelayUrls(),
        relayMode: input.relayMode || 'withFallback'
      })
      await this.refreshChats()
    })
  }

  async inviteChatMembers(conversationId: string, members: string[]): Promise<{
    conversationId: string
    invited: string[]
    failed: Array<{
      pubkey: string
      error: string
    }>
    conversation: ChatConversation | null
  }> {
    return await this.runTask('Invite chat members', async () => {
      const result = await this.chatService.inviteMembers(conversationId, members)
      await this.refreshChats()
      return result
    })
  }

  async acceptChatInvite(inviteId: string): Promise<void> {
    await this.runTask('Accept chat invite', async () => {
      const accepted = await this.chatService.acceptInvite(inviteId)
      const nextAcceptedInviteIds = new Set(this.state.acceptedChatInviteIds)
      nextAcceptedInviteIds.add(inviteId)
      const nextAcceptedConversationIds = new Set(this.state.acceptedChatInviteConversationIds)
      if (accepted.conversationId) {
        nextAcceptedConversationIds.add(accepted.conversationId)
      }
      this.patchState({
        acceptedChatInviteIds: Array.from(nextAcceptedInviteIds),
        acceptedChatInviteConversationIds: Array.from(nextAcceptedConversationIds)
      })
      await this.persistAccountScopedUiState({
        acceptedChatInviteIds: this.state.acceptedChatInviteIds,
        acceptedChatInviteConversationIds: this.state.acceptedChatInviteConversationIds
      })
      await this.refreshChats()
    })
  }

  async dismissChatInvite(inviteId: string): Promise<void> {
    await this.runTask('Dismiss chat invite', async () => {
      const nextDismissed = new Set(this.state.dismissedChatInviteIds)
      nextDismissed.add(inviteId)
      this.patchState({
        chatInvites: this.state.chatInvites.filter((invite) => invite.id !== inviteId),
        dismissedChatInviteIds: Array.from(nextDismissed)
      })
      await this.persistAccountScopedUiState({
        dismissedChatInviteIds: this.state.dismissedChatInviteIds
      })
    })
  }

  async loadChatThread(conversationId: string): Promise<void> {
    await this.runTask('Load chat thread', async () => {
      const messages = await this.chatService.loadThread(conversationId)
      this.patchState({ threadMessages: messages })
      await this.ensureAdminProfiles(messages.map((entry) => entry.senderPubkey))
    })
  }

  async sendChatMessage(conversationId: string, content: string): Promise<void> {
    await this.runTask('Send chat message', async () => {
      const sent = await this.chatService.sendMessage(conversationId, content)
      this.patchState({
        threadMessages: [...this.state.threadMessages, sent]
      })
      await this.ensureAdminProfiles([sent.senderPubkey])
    })
  }

  async searchProfileSuggestions(query: string, limit = 12): Promise<ProfileSuggestion[]> {
    const normalizedQuery = String(query || '').trim().toLowerCase()
    const max = Math.max(1, Math.min(Math.trunc(limit || 12), 80))
    if (!normalizedQuery) return []

    const map = new Map<string, ProfileSuggestion>()
    const addSuggestion = (row: ProfileSuggestion): void => {
      const pubkey = String(row.pubkey || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/i.test(pubkey)) return
      const existing = map.get(pubkey)
      if (!existing) {
        map.set(pubkey, {
          ...row,
          pubkey
        })
        return
      }
      const existingNamed = Boolean(existing.name && existing.name.trim())
      const nextNamed = Boolean(row.name && row.name.trim())
      if (!existingNamed && nextNamed) {
        map.set(pubkey, {
          ...existing,
          ...row,
          pubkey
        })
      }
    }

    const localCandidates = new Set<string>()
    for (const pubkey of Object.keys(this.state.adminProfileByPubkey)) {
      localCandidates.add(pubkey)
    }
    for (const group of [...this.state.groupDiscover, ...this.state.myGroups]) {
      if (group.adminPubkey) localCandidates.add(group.adminPubkey)
      for (const member of group.members || []) {
        localCandidates.add(String(member || ''))
      }
    }
    for (const requests of Object.values(this.state.groupJoinRequests)) {
      for (const request of requests) {
        localCandidates.add(request.pubkey)
      }
    }
    for (const conversation of this.state.conversations) {
      for (const participant of conversation.participants || []) localCandidates.add(participant)
      for (const admin of conversation.adminPubkeys || []) localCandidates.add(admin)
    }
    for (const invite of this.state.chatInvites) {
      localCandidates.add(invite.senderPubkey)
    }

    for (const candidate of localCandidates) {
      const pubkey = String(candidate || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/i.test(pubkey)) continue
      const profile = this.state.adminProfileByPubkey[pubkey]
      const name = String(profile?.name || '').trim()
      const about = String(profile?.bio || '').trim()
      const haystack = `${pubkey} ${name.toLowerCase()} ${about.toLowerCase()}`
      if (!haystack.includes(normalizedQuery)) continue
      addSuggestion({
        pubkey,
        name: name || null,
        about: about || null,
        source: 'cache'
      })
    }

    try {
      const remoteEvents = await this.nostrClient.query(
        this.searchableRelayUrls(8),
        {
          kinds: [0],
          limit: Math.max(max * 6, 40)
        },
        4_000
      )
      for (const event of remoteEvents) {
        const pubkey = String(event?.pubkey || '').trim().toLowerCase()
        if (!/^[a-f0-9]{64}$/i.test(pubkey)) continue
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(event.content || '{}')
        } catch {
          payload = {}
        }
        const name = String(payload.display_name || payload.name || payload.username || '').trim()
        const about = String(payload.about || payload.bio || '').trim()
        const nip05 = String(payload.nip05 || '').trim()
        const haystack = `${pubkey} ${name.toLowerCase()} ${about.toLowerCase()} ${nip05.toLowerCase()}`
        if (!haystack.includes(normalizedQuery)) continue
        addSuggestion({
          pubkey,
          name: name || null,
          about: about || null,
          nip05: nip05 || null,
          source: 'remote'
        })
      }
    } catch {
      // best-effort suggestions
    }

    const score = (row: ProfileSuggestion): number => {
      let value = 0
      if (row.name && row.name.trim()) value += 3
      if (row.nip05 && row.nip05.trim()) value += 2
      if (row.about && row.about.trim()) value += 1
      if (row.source === 'cache') value += 1
      return value
    }

    return Array.from(map.values())
      .sort((left, right) => {
        const leftScore = score(left)
        const rightScore = score(right)
        if (leftScore !== rightScore) return rightScore - leftScore
        const leftName = String(left.name || '')
        const rightName = String(right.name || '')
        if (leftName !== rightName) return leftName.localeCompare(rightName)
        return left.pubkey.localeCompare(right.pubkey)
      })
      .slice(0, max)
  }

  async search(mode: SearchMode, query: string): Promise<void> {
    await this.runTask('Search', async () => {
      const relays = this.searchableRelayUrls()
      let results: SearchResult[] = []

      switch (mode) {
        case 'notes':
          results = await this.searchService.searchNotes(relays, query, 200)
          break
        case 'profiles':
          results = await this.searchService.searchProfiles(relays, query, 200)
          break
        case 'groups':
          results = await this.searchService.searchGroups(relays, query, 200)
          break
        case 'lists':
          results = await this.searchService.searchLists(relays, query, 200)
          break
      }

      this.patchState({
        searchMode: mode,
        searchQuery: query,
        searchResults: results
      })
    })
  }

  async shutdown(): Promise<void> {
    this.detachWorkerListeners()
    this.clearRecoveryTimer()
    this.clearChatRetryTimer()
    if (this.workerOutFlushTimer) {
      clearTimeout(this.workerOutFlushTimer)
      this.workerOutFlushTimer = null
    }
    try {
      await this.workerHost.stop()
    } catch {
      // ignore
    }
    this.nostrClient.destroy()
  }
}
