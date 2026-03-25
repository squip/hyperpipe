import { createHash } from 'node:crypto'
import { nip19, type Event, utils } from 'nostr-tools'
import type { ControllerState, RuntimeOptions } from '../../../src/domain/controller.js'
import type { AppController } from '../../../src/ui/App.js'
import type {
  AccountRecord,
  AccountSession,
  ChatConversation,
  ChatInvite,
  DiscoveredGateway,
  FileActionStatus,
  FileFamilyCounts,
  FeedControls,
  FeedSortKey,
  FeedSourceState,
  FileControls,
  FileSortKey,
  GroupNoteRecord,
  GroupComposeDraft,
  GroupControls,
  GroupJoinRequest,
  GroupListEntry,
  GroupSortKey,
  GroupFileRecord,
  GroupInvite,
  GroupSummary,
  InvitesInboxItem,
  LogLevel,
  PaneFocus,
  PaneViewportMap,
  PerfMetrics,
  RelayEntry,
  SearchMode,
  SearchResult,
  StarterPack,
  ThreadMessage
} from '../../../src/domain/types.js'
import { DEFAULT_DISCOVERY_RELAYS, FILE_FAMILY_ORDER, type NavNodeId } from '../../../src/lib/constants.js'
import { groupScopeKey } from '../../../src/lib/groupScope.js'
import { buildInvitesInbox } from '../../../src/domain/parity/groupFilters.js'
import {
  selectChatPendingInviteCount,
  selectChatUnreadTotal,
  selectFilesCount,
  selectInvitesCount
} from '../../../src/domain/parity/counters.js'
import { uniqueRelayUrls } from '../../../src/lib/nostr.js'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function nowMs(): number {
  return Date.now()
}

function hex64(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function shortPubkeySeed(seed: string): string {
  return hex64(seed)
}

function mockGatewayOperatorIdentity(seed: string, gatewayId: string, publicUrl: string) {
  const pubkey = shortPubkeySeed(seed)
  return {
    pubkey,
    attestation: {
      version: 1,
      payload: {
        purpose: 'gateway-operator-attestation',
        operatorPubkey: pubkey,
        gatewayId,
        publicUrl,
        issuedAt: nowMs() - 60_000,
        expiresAt: nowMs() + 86_400_000
      },
      signature: `${hex64(`${seed}:${gatewayId}:${publicUrl}`)}${hex64(`${gatewayId}:${seed}`)}`
    }
  }
}

function makeEvent(args: {
  idSeed: string
  pubkey: string
  kind: number
  content?: string
  tags?: string[][]
  createdAt?: number
}): Event {
  return {
    id: hex64(args.idSeed + Math.random().toString(16)),
    pubkey: args.pubkey,
    created_at: args.createdAt || nowSec(),
    kind: args.kind,
    tags: args.tags || [],
    content: args.content || '',
    sig: '0'.repeat(128)
  }
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

function defaultFeedSource(): FeedSourceState {
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
  return FILE_FAMILY_ORDER.reduce((acc, family) => {
    acc[family] = 0
    return acc
  }, {} as FileFamilyCounts)
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

function classifyFileFamily(mime: string | null | undefined): (typeof FILE_FAMILY_ORDER)[number] {
  const normalized = String(mime || '').toLowerCase()
  if (normalized.startsWith('image/')) return 'images'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  if (
    normalized.includes('pdf')
    || normalized.includes('text/')
    || normalized.includes('json')
    || normalized.includes('msword')
    || normalized.includes('officedocument')
    || normalized.includes('document')
  ) {
    return 'docs'
  }
  return 'other'
}

function fileRecordKey(file: GroupFileRecord): string {
  return String(file.sha256 || file.eventId || `${file.groupId}:${file.fileName || ''}`).trim().toLowerCase()
}

function emptyState(): ControllerState {
  return {
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
    feedSource: defaultFeedSource(),
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
    workerRecoveryState: {
      enabled: true,
      status: 'idle',
      attempt: 0,
      nextDelayMs: 0,
      lastExitCode: null,
      lastError: null
    },
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
}

function cloneState(state: ControllerState): ControllerState {
  return {
    ...state,
    accounts: state.accounts.map((entry) => ({ ...entry })),
    relays: state.relays.map((entry) => ({ ...entry })),
    relayListPreferences: {
      read: [...state.relayListPreferences.read],
      write: [...state.relayListPreferences.write]
    },
    discoveryRelayUrls: [...state.discoveryRelayUrls],
    gatewayPeerCounts: { ...state.gatewayPeerCounts },
    discoveredGateways: state.discoveredGateways.map((entry) => ({
      ...entry,
      operatorIdentity: entry.operatorIdentity
        ? {
            ...entry.operatorIdentity,
            attestation: entry.operatorIdentity.attestation
              ? {
                  ...entry.operatorIdentity.attestation,
                  payload: entry.operatorIdentity.attestation.payload
                    ? { ...entry.operatorIdentity.attestation.payload }
                    : null
                }
              : null
          }
        : null
    })),
    authorizedGateways: state.authorizedGateways.map((entry) => ({
      ...entry,
      operatorIdentity: entry.operatorIdentity
        ? {
            ...entry.operatorIdentity,
            attestation: entry.operatorIdentity.attestation
              ? {
                  ...entry.operatorIdentity.attestation,
                  payload: entry.operatorIdentity.attestation.payload
                    ? { ...entry.operatorIdentity.attestation.payload }
                    : null
                }
              : null
          }
        : null
    })),
    gatewayAccessCatalog: state.gatewayAccessCatalog.map((entry) => ({
      ...entry,
      operatorIdentity: entry.operatorIdentity
        ? {
            ...entry.operatorIdentity,
            attestation: entry.operatorIdentity.attestation
              ? {
                  ...entry.operatorIdentity.attestation,
                  payload: entry.operatorIdentity.attestation.payload
                    ? { ...entry.operatorIdentity.attestation.payload }
                    : null
                }
              : null
          }
        : null
    })),
    feed: [...state.feed],
    feedSource: { ...state.feedSource },
    activeFeedRelays: [...state.activeFeedRelays],
    feedControls: {
      ...state.feedControls,
      kindFilter: state.feedControls.kindFilter ? [...state.feedControls.kindFilter] : null
    },
    groups: state.groups.map((entry) => ({ ...entry })),
    groupControls: { ...state.groupControls },
    invites: state.invites.map((entry) => ({ ...entry })),
    files: state.files.map((entry) => ({ ...entry })),
    fileControls: { ...state.fileControls },
    lists: state.lists.map((entry) => ({ ...entry })),
    bookmarks: {
      event: state.bookmarks.event,
      eventIds: [...state.bookmarks.eventIds]
    },
    conversations: state.conversations.map((entry) => ({ ...entry })),
    chatInvites: state.chatInvites.map((entry) => ({ ...entry })),
    threadMessages: state.threadMessages.map((entry) => ({ ...entry })),
    searchResults: state.searchResults.map((entry) => ({ ...entry })),
    myGroupList: state.myGroupList.map((entry) => ({ ...entry })),
    groupDiscover: state.groupDiscover.map((entry) => ({ ...entry })),
    myGroups: state.myGroups.map((entry) => ({ ...entry })),
    groupInvites: state.groupInvites.map((entry) => ({ ...entry })),
    groupJoinRequests: Object.fromEntries(
      Object.entries(state.groupJoinRequests).map(([key, value]) => [key, value.map((entry) => ({ ...entry }))])
    ),
    invitesInbox: state.invitesInbox.map((entry) => ({ ...entry })),
    fileFamilyCounts: { ...state.fileFamilyCounts },
    treeExpanded: { ...state.treeExpanded },
    nodeViewport: Object.fromEntries(
      Object.entries(state.nodeViewport).map(([key, value]) => [key, { ...value }])
    ),
    rightTopSelectionByNode: { ...state.rightTopSelectionByNode },
    rightBottomOffsetByNode: { ...state.rightBottomOffsetByNode },
    keymap: {
      ...state.keymap
    },
    detailPaneOffsetBySection: { ...state.detailPaneOffsetBySection },
    paneViewport: Object.fromEntries(
      Object.entries(state.paneViewport).map(([key, value]) => [key, { ...value }])
    ),
    groupNotesByGroupKey: Object.fromEntries(
      Object.entries(state.groupNotesByGroupKey).map(([key, value]) => [key, value.map((entry) => ({ ...entry }))])
    ),
    groupNotesLoadStateByGroupKey: { ...state.groupNotesLoadStateByGroupKey },
    groupFilesByGroupKey: Object.fromEntries(
      Object.entries(state.groupFilesByGroupKey).map(([key, value]) => [key, value.map((entry) => ({ ...entry }))])
    ),
    adminProfileByPubkey: Object.fromEntries(
      Object.entries(state.adminProfileByPubkey).map(([key, value]) => [key, { ...value }])
    ),
    fileActionStatus: { ...state.fileActionStatus },
    hiddenDeletedFileKeys: [...state.hiddenDeletedFileKeys],
    composeDraft: state.composeDraft
      ? {
          ...state.composeDraft,
          attachments: state.composeDraft.attachments.map((entry) => ({ ...entry }))
        }
      : null,
    perfMetrics: {
      ...state.perfMetrics,
      operationSamples: state.perfMetrics.operationSamples.map((entry) => ({ ...entry }))
    },
    workerRecoveryState: {
      ...state.workerRecoveryState
    },
    dismissedGroupInviteIds: [...state.dismissedGroupInviteIds],
    acceptedGroupInviteIds: [...state.acceptedGroupInviteIds],
    acceptedGroupInviteGroupIds: [...state.acceptedGroupInviteGroupIds],
    dismissedChatInviteIds: [...state.dismissedChatInviteIds],
    acceptedChatInviteIds: [...state.acceptedChatInviteIds],
    acceptedChatInviteConversationIds: [...state.acceptedChatInviteConversationIds]
  }
}

function parseLogLevel(level: LogLevel): LogLevel {
  return level
}

export class MockController implements AppController {
  private options: RuntimeOptions
  private state: ControllerState
  private listeners = new Set<(state: ControllerState) => void>()

  private relayCounter = 1
  private conversationCounter = 1
  private rawFeed: Event[] = []
  private rawGroups: GroupSummary[] = []
  private rawFiles: GroupFileRecord[] = []
  private chatThreadByConversation = new Map<string, ThreadMessage[]>()

  constructor(options: RuntimeOptions, state?: Partial<ControllerState>) {
    this.options = options
    this.state = {
      ...emptyState(),
      ...state,
      accounts: state?.accounts || [],
      relays: state?.relays || [],
      feed: state?.feed || [],
      groups: state?.groups || [],
      invites: state?.invites || [],
      files: state?.files || [],
      lists: state?.lists || [],
      conversations: state?.conversations || [],
      chatInvites: state?.chatInvites || [],
      threadMessages: state?.threadMessages || [],
      searchResults: state?.searchResults || [],
      bookmarks: state?.bookmarks || { event: null, eventIds: [] },
      relayListPreferences: state?.relayListPreferences || { read: [], write: [] },
      discoveryRelayUrls: state?.discoveryRelayUrls || uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS),
      gatewayPeerCounts: state?.gatewayPeerCounts || {},
      discoveredGateways: state?.discoveredGateways || [],
      authorizedGateways: state?.authorizedGateways || [],
      gatewayAccessCatalog: state?.gatewayAccessCatalog || [],
      feedSource: state?.feedSource || defaultFeedSource(),
      activeFeedRelays: state?.activeFeedRelays || [],
      feedControls: state?.feedControls || defaultFeedControls(),
      groupControls: state?.groupControls || defaultGroupControls(),
      fileControls: state?.fileControls || defaultFileControls(),
      detailPaneOffsetBySection: state?.detailPaneOffsetBySection || {},
      composeDraft: state?.composeDraft || null,
      groupNotesLoadStateByGroupKey: state?.groupNotesLoadStateByGroupKey || {}
    }
    this.rawFeed = [...this.state.feed]
    this.rawGroups = [...(this.state.groupDiscover.length ? this.state.groupDiscover : this.state.groups)]
    this.rawFiles = [...this.state.files]
    for (const message of this.state.threadMessages) {
      const conversationId = String(message.conversationId || '').trim()
      if (!conversationId) continue
      const existing = this.chatThreadByConversation.get(conversationId) || []
      this.chatThreadByConversation.set(conversationId, [...existing, { ...message }])
    }
    if (!this.state.activeFeedRelays.length) {
      this.state.activeFeedRelays = this.state.relays
        .map((relay) => relay.connectionUrl)
        .filter((value): value is string => Boolean(value))
    }
    this.refreshDerivedState()
  }

  static withSeedData(options: RuntimeOptions): MockController {
    const pubkey = shortPubkeySeed('seed-account')
    const account: AccountRecord = {
      pubkey,
      userKey: pubkey,
      signerType: 'nsec',
      nsec: 'nsec-seed',
      createdAt: nowMs(),
      updatedAt: nowMs(),
      label: 'seed'
    }

    const session: AccountSession = {
      pubkey,
      userKey: pubkey,
      nsecHex: '1'.repeat(64),
      nsec: 'nsec-seed',
      signerType: 'nsec'
    }

    const relays: RelayEntry[] = [
      {
        relayKey: shortPubkeySeed('relay-a'),
        publicIdentifier: 'npubseed:group-a',
        connectionUrl: 'wss://relay.damus.io/',
        writable: true,
        readyForReq: true,
        requiresAuth: false,
        members: [pubkey]
      },
      {
        relayKey: shortPubkeySeed('relay-b'),
        publicIdentifier: 'npubseed:group-b',
        connectionUrl: 'wss://nos.lol/',
        writable: false,
        readyForReq: false,
        requiresAuth: true,
        members: [pubkey]
      }
    ]

    const feed = [
      makeEvent({ idSeed: 'feed-1', pubkey, kind: 1, content: 'hello from feed 1' }),
      makeEvent({ idSeed: 'feed-2', pubkey: shortPubkeySeed('peer'), kind: 1, content: 'hello from peer' })
    ]

    const groups: GroupSummary[] = [
      {
        id: 'npubseed:group-a',
        relay: 'wss://relay.damus.io/',
        name: 'Seed Group A',
        about: 'seed about',
        isPublic: true,
        isOpen: true,
        adminPubkey: pubkey,
        adminName: 'seed-admin',
        members: [pubkey, shortPubkeySeed('peer-group')],
        membersCount: 2,
        peersOnline: 1,
        createdAt: nowSec() - 200,
        event: makeEvent({ idSeed: 'group-a', pubkey, kind: 39000, content: '' })
      }
    ]

    const mainGatewayOperator = mockGatewayOperatorIdentity('gateway-main-operator', 'gateway-main', 'https://hypertuna.com')
    const discoveredGateways: DiscoveredGateway[] = [
      {
        gatewayId: 'gateway-main',
        publicUrl: 'https://hypertuna.com',
        displayName: 'Hyperpipe Main',
        region: 'us-west',
        source: 'nostr:30078',
        isExpired: false,
        lastSeenAt: nowMs(),
        operatorIdentity: mainGatewayOperator
      },
      {
        gatewayId: 'gateway-134',
        publicUrl: 'http://134.199.238.230:4430',
        displayName: 'Gateway 134',
        region: 'us-east',
        source: 'nostr:30078',
        isExpired: false,
        lastSeenAt: nowMs()
      }
    ]

    const invites: GroupInvite[] = [
      {
        id: 'invite-seed-1',
        groupId: 'npubseed:group-a',
        groupName: 'Seed Group A',
        isPublic: true,
        fileSharing: true,
        token: 'seed-token',
        event: makeEvent({ idSeed: 'invite-1', pubkey, kind: 9009, content: 'invite' })
      }
    ]

    const files: GroupFileRecord[] = [
      {
        eventId: 'file-event-1',
        event: makeEvent({ idSeed: 'file-1', pubkey, kind: 1063, content: '' }),
        url: 'https://example.com/file-1.png',
        groupId: 'npubseed:group-a',
        groupRelay: 'wss://relay.damus.io/',
        groupName: 'Seed Group A',
        fileName: 'file-1.png',
        mime: 'image/png',
        size: 1024,
        uploadedAt: nowSec(),
        uploadedBy: pubkey,
        sha256: hex64('file-1')
      }
    ]

    const starter: StarterPack = {
      id: 'starter-seed',
      title: 'Seed Starter Pack',
      pubkeys: [shortPubkeySeed('peer-1'), shortPubkeySeed('peer-2')],
      event: makeEvent({ idSeed: 'starter-1', pubkey, kind: 39089, content: '' })
    }

    const conversation: ChatConversation = {
      id: 'conv-seed-1',
      title: 'Seed Conversation',
      description: 'seed chat',
      participants: [pubkey, shortPubkeySeed('peer-chat')],
      adminPubkeys: [pubkey],
      canInviteMembers: true,
      unreadCount: 1,
      lastMessageAt: nowSec(),
      lastMessagePreview: 'seed message'
    }

    const chatInvite: ChatInvite = {
      id: 'chat-invite-1',
      senderPubkey: shortPubkeySeed('peer-chat'),
      createdAt: nowSec(),
      status: 'pending',
      conversationId: null,
      title: 'Invite',
      description: 'join me'
    }

    const threadMessages: ThreadMessage[] = [
      {
        id: 'msg-seed-1',
        conversationId: conversation.id,
        senderPubkey: pubkey,
        content: 'seed message',
        timestamp: nowSec(),
        type: 'text'
      }
    ]

    return new MockController(options, {
      initialized: true,
      accounts: [account],
      currentAccountPubkey: pubkey,
      session,
      lifecycle: 'ready',
      readinessMessage: 'Ready',
      relays,
      discoveredGateways,
      authorizedGateways: [discoveredGateways[0]],
      gatewayAccessCatalog: [
        {
          gatewayId: discoveredGateways[0].gatewayId,
          gatewayOrigin: discoveredGateways[0].publicUrl,
          hostingState: 'approved',
          reason: 'mock-approved',
          lastCheckedAt: nowMs(),
          operatorIdentity: mainGatewayOperator
        }
      ],
      feed,
      groups,
      myGroupList: [{ groupId: groups[0].id, relay: groups[0].relay }],
      invites,
      files,
      lists: [starter],
      bookmarks: {
        event: null,
        eventIds: [feed[0].id]
      },
      conversations: [conversation],
      chatInvites: [chatInvite],
      chatRuntimeState: 'ready',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null,
      threadMessages,
      adminProfileByPubkey: {
        [String(mainGatewayOperator.pubkey || '').toLowerCase()]: {
          name: 'Hyperpipe Operator',
          bio: 'Gateway operator',
          followersCount: 42
        }
      },
      logs: [
        {
          ts: nowMs(),
          level: parseLogLevel('info'),
          message: 'seed log'
        }
      ]
    })
  }

  private emit(): void {
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private applyFeedControls(rows: Event[]): Event[] {
    const controls = this.state.feedControls
    const query = controls.query.toLowerCase().trim()
    const kindSet = controls.kindFilter?.length ? new Set(controls.kindFilter) : null
    const direction = controls.sortDirection === 'asc' ? 1 : -1
    const filtered = rows.filter((event) => {
      if (kindSet && !kindSet.has(event.kind)) return false
      if (!query) return true
      return event.content.toLowerCase().includes(query)
        || event.id.toLowerCase().includes(query)
        || event.pubkey.toLowerCase().includes(query)
    })
    filtered.sort((left, right) => {
      if (controls.sortKey === 'kind') return direction * (left.kind - right.kind)
      if (controls.sortKey === 'author') return direction * left.pubkey.localeCompare(right.pubkey)
      if (controls.sortKey === 'content') return direction * left.content.localeCompare(right.content)
      if (left.created_at !== right.created_at) return direction * (left.created_at - right.created_at)
      return direction * left.id.localeCompare(right.id)
    })
    return filtered
  }

  private applyGroupControls(rows: GroupSummary[]): GroupSummary[] {
    const controls = this.state.groupControls
    const query = controls.query.toLowerCase().trim()
    const direction = controls.sortDirection === 'asc' ? 1 : -1
    const filtered = rows.filter((group) => {
      if (controls.visibility === 'public' && group.isPublic === false) return false
      if (controls.visibility === 'private' && group.isPublic !== false) return false
      if (controls.joinMode === 'open' && group.isOpen === false) return false
      if (controls.joinMode === 'closed' && group.isOpen !== false) return false
      if (!query) return true
      return [group.id, group.name, group.about || '', group.adminName || '', group.adminPubkey || '']
        .some((value) => value.toLowerCase().includes(query))
    })
    filtered.sort((left, right) => {
      const leftAdmin = `${left.adminName || left.adminPubkey || ''}`.toLowerCase()
      const rightAdmin = `${right.adminName || right.adminPubkey || ''}`.toLowerCase()
      const leftCreated = Number(left.createdAt || left.event?.created_at || 0)
      const rightCreated = Number(right.createdAt || right.event?.created_at || 0)
      const leftMembers = Number(left.membersCount || left.members?.length || 0)
      const rightMembers = Number(right.membersCount || right.members?.length || 0)
      const leftPeers = Number(left.peersOnline || 0)
      const rightPeers = Number(right.peersOnline || 0)
      if (controls.sortKey === 'name') return direction * left.name.localeCompare(right.name)
      if (controls.sortKey === 'description') return direction * String(left.about || '').localeCompare(String(right.about || ''))
      if (controls.sortKey === 'open') return direction * ((left.isOpen ? 1 : 0) - (right.isOpen ? 1 : 0))
      if (controls.sortKey === 'public') return direction * ((left.isPublic === false ? 0 : 1) - (right.isPublic === false ? 0 : 1))
      if (controls.sortKey === 'admin') return direction * leftAdmin.localeCompare(rightAdmin)
      if (controls.sortKey === 'createdAt') return direction * (leftCreated - rightCreated)
      if (controls.sortKey === 'peers') return direction * (leftPeers - rightPeers)
      return direction * (leftMembers - rightMembers)
    })
    return filtered
  }

  private applyFileControls(rows: GroupFileRecord[]): GroupFileRecord[] {
    const controls = this.state.fileControls
    const query = controls.query.toLowerCase().trim()
    const mimeFilter = controls.mime.toLowerCase().trim()
    const direction = controls.sortDirection === 'asc' ? 1 : -1
    const hiddenKeys = new Set(this.state.hiddenDeletedFileKeys.map((entry) => String(entry || '').toLowerCase()))
    const filtered = rows.filter((row) => {
      if (hiddenKeys.has(fileRecordKey(row))) return false
      if (controls.group !== 'all' && row.groupId !== controls.group) return false
      if (mimeFilter !== 'all') {
        const mime = String(row.mime || '').toLowerCase()
        if (!mime.startsWith(mimeFilter)) return false
      }
      if (!query) return true
      return [
        row.fileName,
        row.groupId,
        row.groupName || '',
        row.uploadedBy,
        row.mime || '',
        row.url || ''
      ].some((value) => value.toLowerCase().includes(query))
    })
    filtered.sort((left, right) => {
      if (controls.sortKey === 'fileName') return direction * left.fileName.localeCompare(right.fileName)
      if (controls.sortKey === 'group') return direction * left.groupId.localeCompare(right.groupId)
      if (controls.sortKey === 'uploadedBy') return direction * left.uploadedBy.localeCompare(right.uploadedBy)
      if (controls.sortKey === 'size') return direction * (Number(left.size || 0) - Number(right.size || 0))
      if (controls.sortKey === 'mime') return direction * String(left.mime || '').localeCompare(String(right.mime || ''))
      return direction * (left.uploadedAt - right.uploadedAt)
    })
    return filtered
  }

  private refreshDerivedState(): void {
    const groupsById = new Map<string, GroupSummary>()
    for (const group of this.rawGroups.length ? this.rawGroups : [...this.state.groupDiscover, ...this.state.groups]) {
      groupsById.set(group.id, group)
    }
    const groups = this.applyGroupControls(Array.from(groupsById.values()))

    const inviteById = new Map<string, GroupInvite>()
    for (const invite of [...this.state.invites, ...this.state.groupInvites]) {
      inviteById.set(invite.id, invite)
    }
    const invites = Array.from(inviteById.values())

    const myList: GroupListEntry[] = this.state.myGroupList
    const mySet = new Set(myList.map((entry) => entry.groupId))
    const myGroups = groups.filter((group) => mySet.has(group.id))
    const chatInvites = this.state.chatInvites.filter((invite) => {
      if (this.state.dismissedChatInviteIds.includes(invite.id)) return false
      if (this.state.acceptedChatInviteIds.includes(invite.id)) return false
      if (invite.conversationId && this.state.acceptedChatInviteConversationIds.includes(invite.conversationId)) {
        return false
      }
      return true
    })
    const groupInvites = invites.filter((invite) => {
      if (this.state.dismissedGroupInviteIds.includes(invite.id)) return false
      if (this.state.acceptedGroupInviteIds.includes(invite.id)) return false
      if (this.state.acceptedGroupInviteGroupIds.includes(invite.groupId)) return false
      return true
    })

    this.state.groupDiscover = groups
    this.state.groups = groups
    this.state.myGroupList = myList
    this.state.myGroups = myGroups
    this.state.feed = this.applyFeedControls(this.rawFeed)
    this.state.files = this.applyFileControls(this.rawFiles)
    this.state.groupFilesByGroupKey = this.state.files.reduce((acc, row) => {
      const key = String(row.groupId || '').trim()
      if (!key) return acc
      if (!acc[key]) acc[key] = []
      acc[key].push({ ...row })
      return acc
    }, {} as Record<string, GroupFileRecord[]>)
    this.state.fileFamilyCounts = this.state.files.reduce((acc, row) => {
      const family = classifyFileFamily(row.mime)
      acc[family] += 1
      return acc
    }, defaultFileFamilyCounts())
    this.state.groupInvites = groupInvites
    this.state.invites = groupInvites
    this.state.chatInvites = chatInvites
    this.state.invitesInbox = buildInvitesInbox({
      groupInvites,
      chatInvites
    }) as InvitesInboxItem[]
    this.state.chatUnreadTotal = selectChatUnreadTotal(this.state.conversations)
    this.state.chatPendingInviteCount = selectChatPendingInviteCount(chatInvites)
    this.state.filesCount = selectFilesCount(this.state.files)
    this.state.invitesCount = selectInvitesCount(groupInvites, chatInvites)
    this.state.perfMetrics = {
      ...this.state.perfMetrics,
      queueDepth: 0,
      renderPressure: this.state.logs.length + this.state.workerStdout.length + this.state.workerStderr.length
    }
  }

  private patch(patch: Partial<ControllerState>): void {
    if (patch.feed) {
      this.rawFeed = patch.feed.map((event) => ({ ...event }))
    }
    if (patch.groups || patch.groupDiscover) {
      const nextGroups = patch.groupDiscover || patch.groups || []
      this.rawGroups = nextGroups.map((group) => ({ ...group }))
    }
    if (patch.files) {
      this.rawFiles = patch.files.map((file) => ({ ...file }))
    }
    this.state = {
      ...this.state,
      ...patch
    }
    this.refreshDerivedState()
    this.emit()
  }

  private nextRelayKey(seed: string): string {
    const key = hex64(`${seed}-${this.relayCounter}`)
    this.relayCounter += 1
    return key
  }

  private nextConversationId(): string {
    const id = `conv-${this.conversationCounter}`
    this.conversationCounter += 1
    return id
  }

  async initialize(): Promise<void> {
    this.patch({ initialized: true })
  }

  subscribe(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState(): ControllerState {
    return cloneState(this.state)
  }

  async shutdown(): Promise<void> {
    this.patch({ lifecycle: 'stopped', readinessMessage: 'Stopped' })
  }

  async addNsecAccount(nsec: string, label?: string): Promise<void> {
    const pubkey = shortPubkeySeed(`nsec:${nsec}`)
    const account: AccountRecord = {
      pubkey,
      userKey: pubkey,
      signerType: 'nsec',
      nsec,
      label,
      createdAt: nowMs(),
      updatedAt: nowMs()
    }
    const others = this.state.accounts.filter((entry) => entry.pubkey !== pubkey)
    this.patch({
      accounts: [...others, account],
      currentAccountPubkey: pubkey
    })
  }

  async addNcryptsecAccount(ncryptsec: string, _password: string, label?: string): Promise<void> {
    const pubkey = shortPubkeySeed(`ncryptsec:${ncryptsec}`)
    const account: AccountRecord = {
      pubkey,
      userKey: pubkey,
      signerType: 'ncryptsec',
      ncryptsec,
      label,
      createdAt: nowMs(),
      updatedAt: nowMs()
    }
    const others = this.state.accounts.filter((entry) => entry.pubkey !== pubkey)
    this.patch({
      accounts: [...others, account],
      currentAccountPubkey: pubkey
    })
  }

  async generateNsecAccount(label?: string): Promise<{ pubkey: string; nsec: string; label?: string }> {
    const seed = hex64(`generated-account:${nowMs()}:${Math.random().toString(16).slice(2)}`)
    const nsec = nip19.nsecEncode(utils.hexToBytes(seed))
    await this.addNsecAccount(nsec, label)
    const pubkey = this.state.currentAccountPubkey
    if (!pubkey) {
      throw new Error('Failed to generate account')
    }
    return {
      pubkey,
      nsec,
      label
    }
  }

  async listAccountProfiles(): Promise<Array<{
    pubkey: string
    label?: string
    signerType: 'nsec' | 'ncryptsec' | string
    isCurrent: boolean
  }>> {
    const current = this.state.currentAccountPubkey
    return this.state.accounts.map((account) => ({
      pubkey: account.pubkey,
      label: account.label,
      signerType: account.signerType,
      isCurrent: account.pubkey === current
    }))
  }

  async selectAccount(pubkey: string): Promise<void> {
    this.patch({ currentAccountPubkey: pubkey })
  }

  async unlockCurrentAccount(_getPassword?: () => Promise<string>): Promise<void> {
    if (!this.state.currentAccountPubkey) {
      throw new Error('No account selected')
    }
    this.patch({
      session: {
        pubkey: this.state.currentAccountPubkey,
        userKey: this.state.currentAccountPubkey,
        nsecHex: '1'.repeat(64),
        nsec: 'nsec-mock',
        signerType: 'nsec'
      }
    })
  }

  async removeAccount(pubkey: string): Promise<void> {
    const accounts = this.state.accounts.filter((entry) => entry.pubkey !== pubkey)
    const currentAccountPubkey =
      this.state.currentAccountPubkey === pubkey
        ? accounts[0]?.pubkey || null
        : this.state.currentAccountPubkey
    this.patch({ accounts, currentAccountPubkey })
  }

  async clearSession(): Promise<void> {
    this.patch({
      session: null,
      lifecycle: 'stopped',
      readinessMessage: 'Stopped',
      chatRuntimeState: 'idle',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  async setLastCopied(
    value: string,
    method: 'osc52' | 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'none'
  ): Promise<void> {
    this.patch({
      lastCopiedValue: value || null,
      lastCopiedMethod: method || null
    })
  }

  async setDiscoveryRelayUrls(relays: string[]): Promise<void> {
    const next = uniqueRelayUrls(relays || [])
    this.patch({
      discoveryRelayUrls: next.length ? next : uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS)
    })
  }

  async publishProfileMetadata(input: { name: string; about?: string; relays?: string[] }): Promise<void> {
    const sessionPubkey = this.state.session?.pubkey
    if (!sessionPubkey) {
      throw new Error('No unlocked account session')
    }
    const name = String(input.name || '').trim()
    if (!name) {
      throw new Error('Profile name is required')
    }
    const about = String(input.about || '').trim()
    this.patch({
      adminProfileByPubkey: {
        ...this.state.adminProfileByPubkey,
        [sessionPubkey]: {
          name,
          bio: about || null,
          followersCount: this.state.adminProfileByPubkey[sessionPubkey]?.followersCount ?? null
        }
      }
    })
  }

  async setGroupViewTab(tab: 'discover' | 'my'): Promise<void> {
    const next = tab === 'my' ? 'my' : 'discover'
    this.patch({ groupViewTab: next })
  }

  async setChatViewTab(tab: 'conversations' | 'invites'): Promise<void> {
    const next = ['conversations', 'invites'].includes(tab) ? tab : 'conversations'
    this.patch({ chatViewTab: next })
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
    const next: PaneViewportMap = {
      ...this.state.paneViewport,
      [key]: {
        cursor: normalizedCursor,
        offset: normalizedOffset
      }
    }
    this.patch({ paneViewport: next })
  }

  async setDetailPaneOffset(sectionKey: string, offset: number): Promise<void> {
    const key = String(sectionKey || '').trim()
    if (!key) return
    const normalizedOffset = Math.max(0, Math.trunc(offset))
    const current = this.state.detailPaneOffsetBySection[key]
    if (typeof current === 'number' && current === normalizedOffset) return
    const next = {
      ...this.state.detailPaneOffsetBySection,
      [key]: normalizedOffset
    }
    this.patch({ detailPaneOffsetBySection: next })
  }

  async setSelectedNode(nodeId: NavNodeId): Promise<void> {
    this.patch({ selectedNode: nodeId })
  }

  async setFocusPane(focusPane: PaneFocus): Promise<void> {
    this.patch({ focusPane })
  }

  async setTreeExpanded(nextExpanded: {
    groups: boolean
    chats: boolean
    invites: boolean
    files: boolean
  }): Promise<void> {
    this.patch({
      treeExpanded: {
        ...this.state.treeExpanded,
        ...nextExpanded
      }
    })
  }

  async setRightTopSelection(nodeId: string, index: number): Promise<void> {
    const key = String(nodeId || '').trim()
    if (!key) return
    const next = {
      ...this.state.rightTopSelectionByNode,
      [key]: Math.max(0, Math.trunc(index))
    }
    this.patch({ rightTopSelectionByNode: next })
  }

  async refreshGroupNotes(groupId: string, relay?: string): Promise<void> {
    const key = String(groupId || '').trim()
    if (!key) return
    const scopedKey = groupScopeKey(key, relay || null)
    this.patch({
      groupNotesLoadStateByGroupKey: {
        ...this.state.groupNotesLoadStateByGroupKey,
        [scopedKey]: 'loading'
      }
    })
    const existing = this.state.groupNotesByGroupKey[scopedKey] || []
    const notes = existing.length > 0
      ? existing
      : [{
          eventId: `note-${hex64(`${key}:${Date.now()}`).slice(0, 16)}`,
          groupId: key,
          relay: relay || null,
          content: `mock group note ${new Date().toISOString()}`,
          createdAt: nowSec(),
          authorPubkey: this.state.session?.pubkey || shortPubkeySeed('note-author'),
          event: makeEvent({
            idSeed: `note:${key}:${Date.now()}`,
            pubkey: this.state.session?.pubkey || shortPubkeySeed('note-author'),
            kind: 1,
            content: `mock group note for ${key}`
          })
        } satisfies GroupNoteRecord]
    this.patch({
      groupNotesByGroupKey: {
        ...this.state.groupNotesByGroupKey,
        [scopedKey]: notes.map((entry) => ({ ...entry }))
      },
      groupNotesLoadStateByGroupKey: {
        ...this.state.groupNotesLoadStateByGroupKey,
        [scopedKey]: notes.length > 0 ? 'ready' : 'empty'
      }
    })
  }

  async publishGroupNote(input: { groupId: string; relayUrl: string; content: string }): Promise<Event> {
    const groupId = String(input.groupId || '').trim()
    const relayUrl = String(input.relayUrl || '').trim()
    const content = String(input.content || '').trim()
    if (!groupId) throw new Error('groupId is required')
    if (!relayUrl) throw new Error('relayUrl is required')
    if (!content) throw new Error('Note content is required')

    const sessionPubkey = this.state.session?.pubkey || shortPubkeySeed('note-author')
    const event = makeEvent({
      idSeed: `publish-note:${groupId}:${relayUrl}:${content}:${Date.now()}`,
      pubkey: sessionPubkey,
      kind: 1,
      content,
      tags: [['h', groupId]]
    })
    const record: GroupNoteRecord = {
      eventId: event.id,
      groupId,
      relay: relayUrl,
      content,
      createdAt: Number(event.created_at || nowSec()),
      authorPubkey: sessionPubkey,
      event
    }
    const scopedKey = groupScopeKey(groupId, relayUrl)
    this.patch({
      groupNotesByGroupKey: {
        ...this.state.groupNotesByGroupKey,
        [scopedKey]: [record, ...(this.state.groupNotesByGroupKey[scopedKey] || [])]
      },
      groupNotesLoadStateByGroupKey: {
        ...this.state.groupNotesLoadStateByGroupKey,
        [scopedKey]: 'ready'
      }
    })
    return event
  }

  async downloadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
    fileName?: string | null
  }): Promise<{ savedPath: string; bytes: number; source: string }> {
    const hash = String(input.fileHash || '').trim().toLowerCase()
    if (!hash) throw new Error('Missing file hash')
    const file = this.state.files.find((entry) => String(entry.sha256 || '').toLowerCase() === hash)
      || this.rawFiles.find((entry) => String(entry.sha256 || '').toLowerCase() === hash)
      || this.state.files.find((entry) => input.eventId && entry.eventId === input.eventId)
    if (!file) throw new Error('File not found')

    const savedPath = `/tmp/Downloads/${input.fileName || file.fileName || `${hash.slice(0, 12)}.bin`}`
    const hidden = new Set(this.state.hiddenDeletedFileKeys.map((entry) => String(entry || '').toLowerCase()))
    hidden.delete(hash)
    this.patch({
      hiddenDeletedFileKeys: Array.from(hidden),
      fileActionStatus: {
        action: 'download',
        state: 'success',
        message: 'downloaded',
        path: savedPath,
        updatedAt: Date.now(),
        eventId: file.eventId,
        sha256: hash
      }
    })
    return {
      savedPath,
      bytes: Number(file.size || 0),
      source: 'mock-local'
    }
  }

  async deleteLocalGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
  }): Promise<{ deleted: boolean; reason?: string | null }> {
    const hash = String(input.fileHash || '').trim().toLowerCase()
    if (!hash) throw new Error('Missing file hash')
    const hidden = new Set(this.state.hiddenDeletedFileKeys.map((entry) => String(entry || '').toLowerCase()))
    hidden.add(hash)
    this.patch({
      hiddenDeletedFileKeys: Array.from(hidden),
      fileActionStatus: {
        action: 'delete',
        state: 'success',
        message: 'deleted locally',
        path: null,
        updatedAt: Date.now(),
        eventId: input.eventId || null,
        sha256: hash
      }
    })
    return {
      deleted: true,
      reason: null
    }
  }

  async setPerfOverlay(enabled: boolean): Promise<void> {
    this.patch({
      perfMetrics: {
        ...this.state.perfMetrics,
        overlayEnabled: Boolean(enabled)
      }
    })
  }

  perfSnapshot(): PerfMetrics {
    return {
      ...this.state.perfMetrics,
      operationSamples: this.state.perfMetrics.operationSamples.map((entry) => ({ ...entry }))
    }
  }

  async startWorker(): Promise<void> {
    if (!this.state.session) {
      throw new Error('No unlocked session')
    }
    this.patch({
      lifecycle: 'ready',
      readinessMessage: 'Worker started',
      chatRuntimeState: 'idle',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  async stopWorker(): Promise<void> {
    this.patch({
      lifecycle: 'stopped',
      readinessMessage: 'Worker stopped',
      chatRuntimeState: 'idle',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  async restartWorker(): Promise<void> {
    this.patch({
      lifecycle: 'ready',
      readinessMessage: 'Worker restarted'
    })
  }

  async refreshRelays(): Promise<void> {
    if (!this.state.relays.length) {
      this.patch({
        relays: [
          {
            relayKey: this.nextRelayKey('relay-refresh'),
            publicIdentifier: 'npubseed:refreshed',
            connectionUrl: 'wss://relay.damus.io/',
            writable: true,
            readyForReq: true,
            requiresAuth: false,
            members: []
          }
        ]
      })
    } else {
      this.emit()
    }
  }

  async refreshGatewayCatalog(_options?: { force?: boolean; timeoutMs?: number }): Promise<DiscoveredGateway[]> {
    if (!this.state.discoveredGateways.length) {
      const operatorIdentity = mockGatewayOperatorIdentity('gateway-main-operator', 'gateway-main', 'https://hypertuna.com')
      const fallback: DiscoveredGateway[] = [
        {
          gatewayId: 'gateway-main',
          publicUrl: 'https://hypertuna.com',
          displayName: 'Hyperpipe Main',
          region: 'us-west',
          source: 'nostr:30078',
          isExpired: false,
          lastSeenAt: nowMs(),
          operatorIdentity
        }
      ]
      this.patch({
        discoveredGateways: fallback,
        authorizedGateways: fallback,
        gatewayAccessCatalog: fallback.map((entry) => ({
          gatewayId: entry.gatewayId,
          gatewayOrigin: entry.publicUrl,
          hostingState: 'approved',
          reason: 'mock-approved',
          lastCheckedAt: nowMs(),
          operatorIdentity
        })),
        adminProfileByPubkey: {
          ...this.state.adminProfileByPubkey,
          [String(operatorIdentity.pubkey || '').toLowerCase()]: {
            name: 'Hyperpipe Operator',
            bio: 'Gateway operator',
            followersCount: 42
          }
        }
      })
    }
    return (this.state.authorizedGateways.length ? this.state.authorizedGateways : this.state.discoveredGateways)
      .map((entry) => ({ ...entry }))
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
    const normalizeOrigin = (value: string | null | undefined): string | null => {
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

    const directJoinOnly = input.directJoinOnly === true
    let gatewayOrigin = normalizeOrigin(input.gatewayOrigin || null)
    let gatewayId = String(input.gatewayId || '').trim().toLowerCase() || null
    if (directJoinOnly) {
      gatewayOrigin = null
      gatewayId = null
    }

    if (!directJoinOnly && !gatewayOrigin && gatewayId) {
      const gatewaySelector = gatewayId
      const selectorIndex = /^\d+$/.test(gatewaySelector)
        ? Number.parseInt(gatewaySelector, 10)
        : -1
      const discovered = this.state.discoveredGateways.find((entry, index) =>
        entry.gatewayId === gatewaySelector
        || (selectorIndex >= 0 && index === selectorIndex)
      )
      if (!discovered) {
        throw new Error(`Gateway "${gatewayId}" not found in discovered catalog. Run "gateway refresh" and retry.`)
      }
      gatewayId = discovered.gatewayId
      gatewayOrigin = discovered.publicUrl
    }

    if (!directJoinOnly && gatewayOrigin && !gatewayId) {
      const discovered = this.state.discoveredGateways.find((entry) => entry.publicUrl === gatewayOrigin)
      if (discovered) {
        gatewayId = discovered.gatewayId
      }
    }

    if (!directJoinOnly && !gatewayOrigin) {
      throw new Error('Gateway origin is required unless direct-join-only is enabled')
    }

    const relayKey = this.nextRelayKey(input.name)
    const publicIdentifier = `${shortPubkeySeed(input.name).slice(0, 8)}:${input.name}`
    const relay: RelayEntry = {
      relayKey,
      publicIdentifier,
      connectionUrl: `wss://relay.local/${relayKey}`,
      writable: true,
      readyForReq: true,
      requiresAuth: false,
      members: this.state.session ? [this.state.session.pubkey] : []
    }
    const createdGroup: GroupSummary = {
      id: publicIdentifier,
      relay: relay.connectionUrl,
      name: input.name,
      about: input.description,
      picture: input.picture,
      isPublic: input.isPublic,
      isOpen: input.isOpen,
      gatewayOrigin,
      gatewayId,
      directJoinOnly,
      adminPubkey: this.state.session?.pubkey || null,
      adminName: 'me',
      members: this.state.session ? [this.state.session.pubkey] : [],
      membersCount: this.state.session ? 1 : 0,
      peersOnline: 0,
      createdAt: nowSec()
    }
    const nextMyGroupList: GroupListEntry[] = [
      ...this.state.myGroupList.filter((entry) => entry.groupId !== publicIdentifier),
      {
        groupId: publicIdentifier,
        relay: relay.connectionUrl
      }
    ]
    this.patch({
      relays: [...this.state.relays, relay],
      groups: [createdGroup, ...this.state.groups],
      groupDiscover: [createdGroup, ...this.state.groupDiscover],
      myGroups: [createdGroup, ...this.state.myGroups],
      myGroupList: nextMyGroupList
    })
    return {
      success: true,
      relayKey,
      publicIdentifier,
      relayUrl: relay.connectionUrl
    }
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
    const relayKey = input.relayKey || this.nextRelayKey(input.publicIdentifier || 'joined')
    const publicIdentifier = input.publicIdentifier || `${relayKey.slice(0, 8)}:joined`
    const relay: RelayEntry = {
      relayKey,
      publicIdentifier,
      connectionUrl: input.relayUrl || `wss://relay.local/${relayKey}`,
      writable: true,
      readyForReq: true,
      requiresAuth: Boolean(input.authToken),
      userAuthToken: input.authToken,
      members: this.state.session ? [this.state.session.pubkey] : []
    }
    this.patch({ relays: [...this.state.relays, relay] })
    return {
      success: true,
      relayKey,
      publicIdentifier,
      relayUrl: relay.connectionUrl,
      authToken: input.authToken || null
    }
  }

  async disconnectRelay(relayKey: string, publicIdentifier?: string): Promise<void> {
    this.patch({
      relays: this.state.relays.filter(
        (relay) => relay.relayKey !== relayKey && relay.publicIdentifier !== publicIdentifier
      )
    })
  }

  async leaveGroup(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    saveRelaySnapshot?: boolean
    saveSharedFiles?: boolean
  }): Promise<Record<string, unknown>> {
    this.patch({
      relays: this.state.relays.filter((relay) => {
        if (input.relayKey && relay.relayKey === input.relayKey) return false
        if (input.publicIdentifier && relay.publicIdentifier === input.publicIdentifier) return false
        return true
      }),
      groups: this.state.groups.filter((group) => {
        if (input.publicIdentifier && group.id === input.publicIdentifier) return false
        return true
      }),
      groupDiscover: this.state.groupDiscover.filter((group) => {
        if (input.publicIdentifier && group.id === input.publicIdentifier) return false
        return true
      })
    })

    return {
      relayKey: input.relayKey || null,
      publicIdentifier: input.publicIdentifier || null,
      archiveRelaySnapshot: {
        status: input.saveRelaySnapshot === false ? 'removed' : 'saved',
        archivePath: '/tmp/mock-archive'
      },
      sharedFiles: {
        status: input.saveSharedFiles === false ? 'removed' : 'saved',
        recoveredCount: input.saveSharedFiles === false ? 0 : 1,
        failedCount: 0,
        deletedCount: input.saveSharedFiles === false ? 1 : 0
      }
    }
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
    this.state.logs.push({
      ts: nowMs(),
      level: 'info',
      message: `join-flow:${input.publicIdentifier}`
    })
    this.emit()
  }

  async requestGroupInvite(input: {
    groupId: string
    relay?: string | null
    code?: string
    reason?: string
  }): Promise<void> {
    this.state.logs.push({
      ts: nowMs(),
      level: 'info',
      message: `request-invite:${input.groupId}${input.code ? `:${input.code}` : ''}`
    })
    this.emit()
  }

  async refreshFeed(limit = 120): Promise<void> {
    const pubkey = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const source = this.state.feedSource
    const selectedGroupId = source.mode === 'group' ? source.groupId || this.state.groups[0]?.id || null : null
    const relays = source.mode === 'relay'
      ? [source.relayUrl || 'wss://relay.mock/source']
      : source.mode === 'group'
        ? [source.relayUrl || this.state.groups.find((group) => group.id === selectedGroupId)?.relay || 'wss://relay.mock/group']
        : this.state.relays.map((relay) => relay.connectionUrl).filter((value): value is string => Boolean(value))

    const events = Array.from({ length: Math.min(10, limit) }).map((_, idx) => {
      const author = source.mode === 'following'
        ? shortPubkeySeed(`following-${idx % 3}`)
        : idx % 2 === 0
          ? pubkey
          : shortPubkeySeed(`peer-${idx}`)
      const tags = selectedGroupId ? [['h', selectedGroupId]] : []
      return makeEvent({
        idSeed: `feed-refresh-${source.mode}-${idx}`,
        pubkey: author,
        kind: idx % 4 === 0 ? 7 : 1,
        content: selectedGroupId ? `group ${selectedGroupId} message ${idx}` : `feed message ${idx}`,
        createdAt: nowSec() - idx,
        tags
      })
    })
    this.patch({
      feed: events,
      activeFeedRelays: relays
    })
  }

  async setFeedSourceRelays(): Promise<void> {
    this.patch({
      feedSource: {
        mode: 'relays',
        relayUrl: null,
        groupId: null,
        label: 'All Relays'
      }
    })
    await this.refreshFeed(this.rawFeed.length || 10)
  }

  async setFeedSourceFollowing(): Promise<void> {
    this.patch({
      feedSource: {
        mode: 'following',
        relayUrl: null,
        groupId: null,
        label: 'Following'
      }
    })
    await this.refreshFeed(this.rawFeed.length || 10)
  }

  async setFeedSourceRelaySelector(selector: string): Promise<void> {
    const normalized = String(selector || '').trim()
    if (!normalized) throw new Error('relay selector required')
    const relay = this.state.relays.find((entry) =>
      entry.connectionUrl === normalized
      || entry.publicIdentifier === normalized
      || entry.relayKey === normalized
    )
    const relayUrl = relay?.connectionUrl || normalized
    this.patch({
      feedSource: {
        mode: 'relay',
        relayUrl,
        groupId: null,
        label: relay?.publicIdentifier || relay?.relayKey || relayUrl
      }
    })
    await this.refreshFeed(this.rawFeed.length || 10)
  }

  async setFeedSourceGroupSelector(selector: string, relay?: string): Promise<void> {
    const normalized = String(selector || '').trim()
    if (!normalized) throw new Error('group selector required')
    const index = Number.parseInt(normalized, 10)
    const fromIndex = Number.isFinite(index)
      ? (this.state.myGroups[index - 1] || this.state.groups[index - 1])
      : null
    const group = fromIndex || this.state.groups.find((entry) => entry.id === normalized)
    const groupId = group?.id || normalized
    const relayUrl = relay || group?.relay || null
    this.patch({
      feedSource: {
        mode: 'group',
        relayUrl,
        groupId,
        label: group?.name || groupId
      }
    })
    await this.refreshFeed(this.rawFeed.length || 10)
  }

  async setFeedSearch(query: string): Promise<void> {
    this.patch({
      feedControls: {
        ...this.state.feedControls,
        query: String(query || '').trim()
      }
    })
  }

  async setFeedSort(sortKey: FeedSortKey, direction?: string): Promise<void> {
    this.patch({
      feedControls: {
        ...this.state.feedControls,
        sortKey,
        sortDirection: String(direction || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
      }
    })
  }

  async setFeedKindFilter(kinds: number[] | null): Promise<void> {
    this.patch({
      feedControls: {
        ...this.state.feedControls,
        kindFilter: kinds && kinds.length ? Array.from(new Set(kinds.map((kind) => Number(kind)).filter(Number.isFinite))) : null
      }
    })
  }

  async publishPost(content: string): Promise<unknown> {
    const pubkey = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const event = makeEvent({
      idSeed: `post:${content}`,
      pubkey,
      kind: 1,
      content
    })
    this.patch({ feed: [event, ...this.state.feed] })
    return event
  }

  async publishReply(content: string, replyToEventId: string, replyToPubkey: string): Promise<unknown> {
    const pubkey = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const event = makeEvent({
      idSeed: `reply:${content}:${replyToEventId}`,
      pubkey,
      kind: 1,
      content,
      tags: [
        ['e', replyToEventId, '', 'reply'],
        ['p', replyToPubkey]
      ]
    })
    this.patch({ feed: [event, ...this.state.feed] })
    return event
  }

  async publishReaction(eventId: string, eventPubkey: string, reaction: string): Promise<unknown> {
    const pubkey = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const event = makeEvent({
      idSeed: `reaction:${eventId}:${reaction}`,
      pubkey,
      kind: 7,
      content: reaction,
      tags: [
        ['e', eventId],
        ['p', eventPubkey]
      ]
    })
    this.patch({ feed: [event, ...this.state.feed] })
    return event
  }

  async refreshBookmarks(): Promise<void> {
    this.emit()
  }

  async addBookmark(eventId: string): Promise<void> {
    const next = Array.from(new Set([...this.state.bookmarks.eventIds, eventId]))
    this.patch({
      bookmarks: {
        ...this.state.bookmarks,
        eventIds: next
      }
    })
  }

  async removeBookmark(eventId: string): Promise<void> {
    this.patch({
      bookmarks: {
        ...this.state.bookmarks,
        eventIds: this.state.bookmarks.eventIds.filter((entry) => entry !== eventId)
      }
    })
  }

  async refreshGroups(): Promise<void> {
    if (!this.state.groups.length) {
      const group: GroupSummary = {
        id: 'npubseed:group-refresh',
        relay: 'wss://relay.damus.io/',
        name: 'Refreshed Group',
        about: 'group from refresh',
        isPublic: true,
        isOpen: true,
        adminPubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        adminName: 'refreshed-admin',
        members: [this.state.session?.pubkey || shortPubkeySeed('anonymous')],
        membersCount: 1,
        peersOnline: 0,
        createdAt: nowSec() - 120,
        event: makeEvent({
          idSeed: 'group-refresh',
          pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
          kind: 39000,
          content: ''
        })
      }
      this.patch({ groups: [group] })
      return
    }
    this.emit()
  }

  async refreshInvites(): Promise<void> {
    if (!this.state.invites.length) {
      const invite: GroupInvite = {
        id: 'invite-refresh-1',
        groupId: 'npubseed:group-refresh',
        groupName: 'Refreshed Group',
        isPublic: true,
        fileSharing: true,
        token: 'refresh-token',
        event: makeEvent({
          idSeed: 'invite-refresh',
          pubkey: shortPubkeySeed('peer-invite'),
          kind: 9009,
          content: 'refresh invite'
        })
      }
      this.patch({ invites: [invite] })
      return
    }
    this.emit()
  }

  async acceptGroupInvite(inviteId: string): Promise<void> {
    const invite = this.state.invites.find((entry) => entry.id === inviteId)
    if (!invite) {
      throw new Error(`Group invite not found: ${inviteId}`)
    }
    await this.startJoinFlow({
      publicIdentifier: invite.groupId,
      token: invite.token,
      relayUrl: invite.relay,
      fileSharing: invite.fileSharing,
      openJoin: !invite.token && invite.fileSharing !== false
    })
    this.patch({
      invites: this.state.invites.filter((entry) => entry.id !== inviteId),
      acceptedGroupInviteIds: Array.from(new Set([...this.state.acceptedGroupInviteIds, inviteId])),
      acceptedGroupInviteGroupIds: Array.from(
        new Set([...this.state.acceptedGroupInviteGroupIds, invite.groupId])
      )
    })
  }

  async dismissGroupInvite(inviteId: string): Promise<void> {
    this.patch({
      invites: this.state.invites.filter((entry) => entry.id !== inviteId),
      dismissedGroupInviteIds: Array.from(new Set([...this.state.dismissedGroupInviteIds, inviteId]))
    })
  }

  async refreshJoinRequests(groupId: string, relay?: string): Promise<void> {
    const key = groupScopeKey(groupId, relay || null)
    const request: GroupJoinRequest = {
      id: `join-request-${hex64(`${key}:${nowMs()}`).slice(0, 10)}`,
      groupId,
      pubkey: shortPubkeySeed(`joiner:${groupId}`),
      createdAt: nowSec(),
      relay,
      reason: 'Please approve'
    }
    this.patch({
      groupJoinRequests: {
        ...this.state.groupJoinRequests,
        [key]: [request]
      }
    })
  }

  async approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    const key = groupScopeKey(groupId, relay || null)
    const next = (this.state.groupJoinRequests[key] || []).filter((row) => row.pubkey !== pubkey)
    this.patch({
      groupJoinRequests: {
        ...this.state.groupJoinRequests,
        [key]: next
      }
    })
  }

  async rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    const key = groupScopeKey(groupId, relay || null)
    const next = (this.state.groupJoinRequests[key] || []).filter((row) => row.pubkey !== pubkey)
    this.patch({
      groupJoinRequests: {
        ...this.state.groupJoinRequests,
        [key]: next
      }
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
    const invite: GroupInvite = {
      id: `invite-${hex64(`${input.groupId}:${input.inviteePubkey}`).slice(0, 12)}`,
      groupId: input.groupId,
      relay: input.relayUrl,
      groupName:
        typeof input.payload.groupName === 'string' ? input.payload.groupName : input.groupId,
      isPublic: true,
      fileSharing: true,
      token: input.token,
      event: makeEvent({
        idSeed: `invite:${input.groupId}:${input.inviteePubkey}`,
        pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        kind: 9009,
        content: 'mock invite'
      })
    }
    this.patch({ invites: [invite, ...this.state.invites] })
  }

  async updateGroupMembers(_input: {
    relayKey?: string
    publicIdentifier?: string
    members?: string[]
    memberAdds?: Array<{ pubkey: string; ts: number }>
    memberRemoves?: Array<{ pubkey: string; ts: number }>
  }): Promise<void> {
    this.state.logs.push({ ts: nowMs(), level: 'info', message: 'members-updated' })
    this.emit()
  }

  async updateGroupAuth(_input: {
    relayKey?: string
    publicIdentifier?: string
    pubkey: string
    token: string
  }): Promise<void> {
    this.state.logs.push({ ts: nowMs(), level: 'info', message: 'auth-updated' })
    this.emit()
  }

  async refreshGroupMembers(groupId: string, _relay?: string): Promise<GroupSummary | null> {
    const normalized = String(groupId || '').trim()
    if (!normalized) {
      throw new Error('groupId is required')
    }
    const existing = this.rawGroups.find((group) => group.id === normalized)
    const target = existing || this.state.groups.find((group) => group.id === normalized)
    const nextMembers = target?.members?.length
      ? target.members
      : [this.state.session?.pubkey || shortPubkeySeed('anonymous'), shortPubkeySeed(`member:${normalized}`)]
    const updated: GroupSummary = {
      ...(target || {
        id: normalized,
        name: normalized,
        relay: _relay || undefined,
        isPublic: true,
        isOpen: true
      }),
      members: nextMembers,
      membersCount: nextMembers.length,
      adminPubkey: target?.adminPubkey || this.state.session?.pubkey || null,
      adminName: target?.adminName || 'group-admin',
      peersOnline: Math.max(0, Number(target?.peersOnline || 0))
    }

    const deduped = this.rawGroups.filter((group) => group.id !== normalized)
    this.patch({
      groups: [updated, ...deduped],
      groupDiscover: [updated, ...deduped]
    })
    return updated
  }

  async setGroupSearch(query: string): Promise<void> {
    this.patch({
      groupControls: {
        ...this.state.groupControls,
        query: String(query || '').trim()
      }
    })
  }

  async setGroupSort(sortKey: GroupSortKey, direction?: string): Promise<void> {
    this.patch({
      groupControls: {
        ...this.state.groupControls,
        sortKey,
        sortDirection: String(direction || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
      }
    })
  }

  async setGroupVisibilityFilter(visibility: 'all' | 'public' | 'private'): Promise<void> {
    this.patch({
      groupControls: {
        ...this.state.groupControls,
        visibility
      }
    })
  }

  async setGroupJoinFilter(joinMode: 'all' | 'open' | 'closed'): Promise<void> {
    this.patch({
      groupControls: {
        ...this.state.groupControls,
        joinMode
      }
    })
  }

  async refreshGroupFiles(groupId?: string): Promise<void> {
    if (this.state.files.length) {
      this.emit()
      return
    }

    const record: GroupFileRecord = {
      eventId: `file-${hex64(groupId || 'group')}`,
      event: makeEvent({
        idSeed: `file-refresh:${groupId || 'group'}`,
        pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        kind: 1063,
        content: ''
      }),
      url: 'https://example.com/file-refresh.png',
      groupId: groupId || 'npubseed:group-refresh',
      groupRelay: 'wss://relay.damus.io/',
      groupName: 'Refreshed Group',
      fileName: 'file-refresh.png',
      mime: 'image/png',
      size: 2048,
      uploadedAt: nowSec(),
      uploadedBy: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
      sha256: hex64('file-refresh')
    }

    this.patch({ files: [record] })
  }

  async uploadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
  }): Promise<Record<string, unknown>> {
    const fileName = input.filePath.split('/').pop() || 'upload.bin'
    const groupId = input.publicIdentifier || input.relayKey || 'unknown-group'
    const record: GroupFileRecord = {
      eventId: `upload-${hex64(`${groupId}:${fileName}`)}`,
      event: makeEvent({
        idSeed: `upload:${groupId}:${fileName}`,
        pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        kind: 1063,
        content: ''
      }),
      url: `https://example.com/uploads/${fileName}`,
      groupId,
      groupRelay: null,
      groupName: null,
      fileName,
      mime: 'application/octet-stream',
      size: 512,
      uploadedAt: nowSec(),
      uploadedBy: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
      sha256: hex64(fileName)
    }

    this.patch({ files: [record, ...this.state.files] })

    return {
      relayKey: input.relayKey,
      publicIdentifier: input.publicIdentifier,
      fileId: fileName,
      url: record.url,
      sha256: record.sha256
    }
  }

  async setFileSearch(query: string): Promise<void> {
    this.patch({
      fileControls: {
        ...this.state.fileControls,
        query: String(query || '').trim()
      }
    })
  }

  async setFileSort(sortKey: FileSortKey, direction?: string): Promise<void> {
    this.patch({
      fileControls: {
        ...this.state.fileControls,
        sortKey,
        sortDirection: String(direction || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
      }
    })
  }

  async setFileMimeFilter(mime: string): Promise<void> {
    this.patch({
      fileControls: {
        ...this.state.fileControls,
        mime: String(mime || '').trim() || 'all'
      }
    })
  }

  async setFileGroupFilter(group: string): Promise<void> {
    this.patch({
      fileControls: {
        ...this.state.fileControls,
        group: String(group || '').trim() || 'all'
      }
    })
  }

  async refreshStarterPacks(): Promise<void> {
    if (!this.state.lists.length) {
      const event = makeEvent({
        idSeed: 'starter-refresh',
        pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        kind: 39089,
        content: ''
      })
      const list: StarterPack = {
        id: 'starter-refresh',
        title: 'Refreshed Starter',
        pubkeys: [shortPubkeySeed('f1'), shortPubkeySeed('f2')],
        event
      }
      this.patch({ lists: [list] })
      return
    }
    this.emit()
  }

  async createStarterPack(input: {
    dTag: string
    title: string
    description?: string
    image?: string
    pubkeys: string[]
  }): Promise<void> {
    const event = makeEvent({
      idSeed: `starter-create:${input.dTag}`,
      pubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
      kind: 39089,
      content: ''
    })
    const list: StarterPack = {
      id: input.dTag,
      title: input.title,
      description: input.description,
      image: input.image,
      pubkeys: input.pubkeys,
      event
    }
    const deduped = this.state.lists.filter((entry) => entry.id !== input.dTag)
    this.patch({ lists: [list, ...deduped] })
  }

  async applyStarterPack(listId: string, _authorPubkey?: string): Promise<void> {
    this.state.logs.push({ ts: nowMs(), level: 'info', message: `starter-applied:${listId}` })
    this.emit()
  }

  async initChats(): Promise<void> {
    if (this.state.conversations.length || this.state.chatInvites.length) {
      this.patch({
        chatRuntimeState: 'ready',
        chatWarning: null,
        chatRetryCount: 0,
        chatNextRetryAt: null
      })
      return
    }

    const conversation: ChatConversation = {
      id: this.nextConversationId(),
      title: 'Initialized Chat',
      description: 'initialized',
      participants: [this.state.session?.pubkey || shortPubkeySeed('anonymous')],
      adminPubkeys: [this.state.session?.pubkey || shortPubkeySeed('anonymous')],
      canInviteMembers: true,
      unreadCount: 0,
      lastMessageAt: nowSec(),
      lastMessagePreview: null
    }

    const invite: ChatInvite = {
      id: 'chat-invite-init',
      senderPubkey: shortPubkeySeed('chat-peer'),
      createdAt: nowSec(),
      status: 'pending',
      conversationId: null,
      title: 'Init invite',
      description: 'join'
    }

    this.patch({
      conversations: [conversation],
      chatInvites: [invite],
      chatRuntimeState: 'ready',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  async refreshChats(): Promise<void> {
    this.patch({
      chatRuntimeState: 'ready',
      chatWarning: null,
      chatRetryCount: 0,
      chatNextRetryAt: null
    })
  }

  async createConversation(input: {
    title: string
    description?: string
    members: string[]
    relayUrls?: string[]
    relayMode?: 'withFallback' | 'strict'
  }): Promise<void> {
    const conversation: ChatConversation = {
      id: this.nextConversationId(),
      title: input.title,
      description: input.description || null,
      participants: [this.state.session?.pubkey || shortPubkeySeed('anonymous'), ...input.members],
      adminPubkeys: [this.state.session?.pubkey || shortPubkeySeed('anonymous')],
      canInviteMembers: true,
      unreadCount: 0,
      lastMessageAt: nowSec(),
      lastMessagePreview: null
    }

    this.patch({ conversations: [conversation, ...this.state.conversations] })
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
    const normalizedConversationId = String(conversationId || '').trim()
    if (!normalizedConversationId) {
      throw new Error('conversationId is required')
    }
    const normalizedMembers = Array.from(new Set(
      members.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    ))
    const conversation = this.state.conversations.find((entry) => entry.id === normalizedConversationId) || null
    if (!conversation) {
      throw new Error(`Conversation not found: ${normalizedConversationId}`)
    }

    const failed: Array<{ pubkey: string; error: string }> = []
    const invited: string[] = []
    for (const member of normalizedMembers) {
      if (!/^[a-f0-9]{64}$/i.test(member)) {
        failed.push({ pubkey: member, error: 'invalid pubkey' })
        continue
      }
      invited.push(member)
    }

    if (invited.length > 0) {
      const mergedParticipants = Array.from(new Set([
        ...conversation.participants,
        ...invited
      ]))
      const updated: ChatConversation = {
        ...conversation,
        participants: mergedParticipants,
        lastMessageAt: nowSec(),
        lastMessagePreview: `invited ${invited.length} member(s)`
      }
      this.patch({
        conversations: [
          updated,
          ...this.state.conversations.filter((entry) => entry.id !== normalizedConversationId)
        ]
      })
      return {
        conversationId: normalizedConversationId,
        invited,
        failed,
        conversation: updated
      }
    }

    return {
      conversationId: normalizedConversationId,
      invited,
      failed,
      conversation
    }
  }

  async searchProfileSuggestions(query: string, limit = 12): Promise<Array<{
    pubkey: string
    name?: string | null
    about?: string | null
    nip05?: string | null
    source?: 'local' | 'remote' | 'cache'
  }>> {
    const normalized = String(query || '').trim().toLowerCase()
    if (!normalized) return []
    const max = Math.max(1, Math.min(Math.trunc(limit || 12), 50))
    const candidates = [
      {
        pubkey: shortPubkeySeed('alice'),
        name: 'alice',
        source: 'cache' as const
      },
      {
        pubkey: shortPubkeySeed('bob'),
        name: 'bob',
        source: 'cache' as const
      },
      {
        pubkey: this.state.session?.pubkey || shortPubkeySeed('self'),
        name: 'self',
        source: 'local' as const
      }
    ]
    return candidates
      .filter((entry) => `${entry.pubkey} ${entry.name}`.toLowerCase().includes(normalized))
      .slice(0, max)
  }

  async acceptChatInvite(inviteId: string): Promise<void> {
    const accepted = this.state.chatInvites.find((invite) => invite.id === inviteId)
    const nextInvites = this.state.chatInvites.filter((invite) => invite.id !== inviteId)

    let conversations = this.state.conversations
    if (accepted) {
      const conversation: ChatConversation = {
        id: accepted.conversationId || this.nextConversationId(),
        title: accepted.title || 'Accepted Chat',
        description: accepted.description || null,
        participants: [this.state.session?.pubkey || shortPubkeySeed('anonymous'), accepted.senderPubkey],
        adminPubkeys: [accepted.senderPubkey],
        canInviteMembers: false,
        unreadCount: 0,
        lastMessageAt: nowSec(),
        lastMessagePreview: null
      }
      conversations = [conversation, ...conversations]
    }

    this.patch({
      chatInvites: nextInvites,
      conversations,
      acceptedChatInviteIds: Array.from(new Set([...this.state.acceptedChatInviteIds, inviteId])),
      acceptedChatInviteConversationIds: accepted?.conversationId
        ? Array.from(new Set([...this.state.acceptedChatInviteConversationIds, accepted.conversationId]))
        : this.state.acceptedChatInviteConversationIds
    })
  }

  async dismissChatInvite(inviteId: string): Promise<void> {
    this.patch({
      chatInvites: this.state.chatInvites.filter((invite) => invite.id !== inviteId),
      dismissedChatInviteIds: Array.from(new Set([...this.state.dismissedChatInviteIds, inviteId]))
    })
  }

  async loadChatThread(conversationId: string): Promise<void> {
    const key = String(conversationId || '').trim()
    if (!key) throw new Error('conversationId is required')
    const existing = this.chatThreadByConversation.get(key) || []
    if (existing.length === 0) {
      const base: ThreadMessage[] = [
        {
          id: `msg-${hex64(key).slice(0, 8)}`,
          conversationId: key,
          senderPubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
          content: `thread for ${key}`,
          timestamp: nowSec(),
          type: 'text'
        }
      ]
      this.chatThreadByConversation.set(key, base)
      this.patch({ threadMessages: base })
      return
    }
    this.patch({ threadMessages: existing.map((entry) => ({ ...entry })) })
  }

  async sendChatMessage(conversationId: string, content: string): Promise<void> {
    const key = String(conversationId || '').trim()
    if (!key) throw new Error('conversationId is required')
    const message: ThreadMessage = {
      id: `msg-${hex64(`${key}:${content}`)}`,
      conversationId: key,
      senderPubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
      content,
      timestamp: nowSec(),
      type: 'text'
    }

    const nextThread = [...(this.chatThreadByConversation.get(key) || []), message]
    this.chatThreadByConversation.set(key, nextThread)
    this.patch({
      threadMessages: nextThread
    })
  }

  async startComposeDraft(groupId: string, relay?: string): Promise<void> {
    const normalizedGroupId = String(groupId || '').trim()
    if (!normalizedGroupId) throw new Error('groupId is required')
    const targetGroup = this.state.groups.find((group) => group.id === normalizedGroupId)
    const nextDraft: GroupComposeDraft = {
      groupId: normalizedGroupId,
      relay: relay || targetGroup?.relay || null,
      content: '',
      attachments: []
    }
    this.patch({ composeDraft: nextDraft })
  }

  async updateComposeText(content: string): Promise<void> {
    if (!this.state.composeDraft) {
      throw new Error('No compose draft in progress')
    }
    this.patch({
      composeDraft: {
        ...this.state.composeDraft,
        content
      }
    })
  }

  async attachComposeFile(filePath: string): Promise<void> {
    if (!this.state.composeDraft) {
      throw new Error('No compose draft in progress')
    }
    const normalizedPath = String(filePath || '').trim()
    if (!normalizedPath) throw new Error('filePath is required')
    const fileName = normalizedPath.split('/').pop() || 'attachment.bin'
    const nextAttachments = [
      ...this.state.composeDraft.attachments,
      {
        filePath: normalizedPath,
        fileName
      }
    ]
    this.patch({
      composeDraft: {
        ...this.state.composeDraft,
        attachments: nextAttachments
      }
    })
  }

  async removeComposeAttachment(selector: string): Promise<void> {
    if (!this.state.composeDraft) {
      throw new Error('No compose draft in progress')
    }
    const normalized = String(selector || '').trim()
    if (!normalized) throw new Error('attachment selector required')
    const index = Number.parseInt(normalized, 10)
    const nextAttachments = Number.isFinite(index)
      ? this.state.composeDraft.attachments.filter((_entry, idx) => idx !== index)
      : this.state.composeDraft.attachments.filter((entry) =>
        entry.filePath !== normalized && entry.fileName !== normalized
      )
    this.patch({
      composeDraft: {
        ...this.state.composeDraft,
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

  async publishComposeDraft(): Promise<unknown> {
    const draft = this.state.composeDraft
    if (!draft) throw new Error('No compose draft in progress')
    const author = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const uploadRecords: GroupFileRecord[] = draft.attachments.map((attachment, idx) => ({
      eventId: `compose-file-${hex64(`${draft.groupId}:${attachment.filePath}:${idx}`)}`,
      event: makeEvent({
        idSeed: `compose-file:${draft.groupId}:${idx}`,
        pubkey: author,
        kind: 1063,
        content: ''
      }),
      url: `https://example.com/uploads/${attachment.fileName}`,
      groupId: draft.groupId,
      groupRelay: draft.relay || null,
      groupName: this.state.groups.find((group) => group.id === draft.groupId)?.name || draft.groupId,
      fileName: attachment.fileName,
      mime: attachment.mime || 'application/octet-stream',
      size: attachment.size || null,
      uploadedAt: nowSec(),
      uploadedBy: author,
      sha256: hex64(attachment.fileName)
    }))

    const postEvent = makeEvent({
      idSeed: `compose-post:${draft.groupId}:${draft.content}`,
      pubkey: author,
      kind: 1,
      content: draft.content,
      tags: [
        ['h', draft.groupId],
        ...uploadRecords.map((record) => ['r', record.url, 'hyperpipe:drive'])
      ]
    })

    this.patch({
      feed: [postEvent, ...this.rawFeed],
      files: [...uploadRecords, ...this.rawFiles],
      composeDraft: null
    })

    return postEvent
  }

  async cancelComposeDraft(): Promise<void> {
    this.patch({ composeDraft: null })
  }

  async search(mode: SearchMode, query: string): Promise<void> {
    const fromFeed: SearchResult[] = this.state.feed.map((event) => ({ mode, event }))
    const filtered = query
      ? fromFeed.filter((entry) => (entry.event.content || '').toLowerCase().includes(query.toLowerCase()))
      : fromFeed

    this.patch({
      searchMode: mode,
      searchQuery: query,
      searchResults: filtered
    })
  }
}
