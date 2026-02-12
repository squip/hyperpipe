import { createHash } from 'node:crypto'
import type { Event } from 'nostr-tools'
import type { ControllerState, RuntimeOptions } from '../../../src/domain/controller.js'
import type { AppController } from '../../../src/ui/App.js'
import type {
  AccountRecord,
  AccountSession,
  ChatConversation,
  ChatInvite,
  GroupJoinRequest,
  GroupListEntry,
  GroupFileRecord,
  GroupInvite,
  GroupSummary,
  InvitesInboxItem,
  LogLevel,
  PaneViewportMap,
  PerfMetrics,
  RelayEntry,
  SearchMode,
  SearchResult,
  StarterPack,
  ThreadMessage
} from '../../../src/domain/types.js'
import { buildInvitesInbox } from '../../../src/domain/parity/groupFilters.js'
import {
  selectChatPendingInviteCount,
  selectChatUnreadTotal,
  selectFilesCount,
  selectInvitesCount
} from '../../../src/domain/parity/counters.js'

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

function emptyState(): ControllerState {
  return {
    initialized: false,
    accounts: [],
    currentAccountPubkey: null,
    session: null,
    lifecycle: 'stopped',
    readinessMessage: 'Stopped',
    relays: [],
    feed: [],
    groups: [],
    invites: [],
    files: [],
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
    groupViewTab: 'discover',
    chatViewTab: 'conversations',
    keymap: {
      vimNavigation: false
    },
    paneViewport: {},
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
    feed: [...state.feed],
    groups: state.groups.map((entry) => ({ ...entry })),
    invites: state.invites.map((entry) => ({ ...entry })),
    files: state.files.map((entry) => ({ ...entry })),
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
    keymap: {
      ...state.keymap
    },
    paneViewport: Object.fromEntries(
      Object.entries(state.paneViewport).map(([key, value]) => [key, { ...value }])
    ),
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
      bookmarks: state?.bookmarks || { event: null, eventIds: [] }
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
        event: makeEvent({ idSeed: 'group-a', pubkey, kind: 39000, content: '' })
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
      feed,
      groups,
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

  private refreshDerivedState(): void {
    const groupsById = new Map<string, GroupSummary>()
    for (const group of [...this.state.groupDiscover, ...this.state.groups]) {
      groupsById.set(group.id, group)
    }
    const groups = Array.from(groupsById.values())

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
    const nsec = `nsec-generated-${nowMs()}`
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

  async setGroupViewTab(tab: 'discover' | 'my' | 'invites'): Promise<void> {
    const next = ['discover', 'my', 'invites'].includes(tab) ? tab : 'discover'
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

  async createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
  }): Promise<Record<string, unknown>> {
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
    this.patch({
      relays: [...this.state.relays, relay],
      groups: [
        ...this.state.groups,
        {
          id: publicIdentifier,
          relay: relay.connectionUrl,
          name: input.name,
          about: input.description,
          picture: input.picture,
          isPublic: input.isPublic,
          isOpen: input.isOpen
        }
      ]
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
    openJoin?: boolean
  }): Promise<void> {
    this.state.logs.push({
      ts: nowMs(),
      level: 'info',
      message: `join-flow:${input.publicIdentifier}`
    })
    this.emit()
  }

  async refreshFeed(limit = 120): Promise<void> {
    const pubkey = this.state.session?.pubkey || shortPubkeySeed('anonymous')
    const events = Array.from({ length: Math.min(10, limit) }).map((_, idx) =>
      makeEvent({
        idSeed: `feed-refresh-${idx}`,
        pubkey,
        kind: 1,
        content: `feed message ${idx}`,
        createdAt: nowSec() - idx
      })
    )
    this.patch({ feed: events })
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
    const key = relay ? `${relay}|${groupId}` : groupId
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
    const key = relay ? `${relay}|${groupId}` : groupId
    const next = (this.state.groupJoinRequests[key] || []).filter((row) => row.pubkey !== pubkey)
    this.patch({
      groupJoinRequests: {
        ...this.state.groupJoinRequests,
        [key]: next
      }
    })
  }

  async rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    const key = relay ? `${relay}|${groupId}` : groupId
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
    const base: ThreadMessage[] = [
      {
        id: `msg-${hex64(conversationId).slice(0, 8)}`,
        conversationId,
        senderPubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
        content: `thread for ${conversationId}`,
        timestamp: nowSec(),
        type: 'text'
      }
    ]

    this.patch({ threadMessages: base })
  }

  async sendChatMessage(conversationId: string, content: string): Promise<void> {
    const message: ThreadMessage = {
      id: `msg-${hex64(`${conversationId}:${content}`)}`,
      conversationId,
      senderPubkey: this.state.session?.pubkey || shortPubkeySeed('anonymous'),
      content,
      timestamp: nowSec(),
      type: 'text'
    }

    this.patch({
      threadMessages: [...this.state.threadMessages, message]
    })
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
