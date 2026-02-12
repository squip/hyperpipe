import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Event } from 'nostr-tools'
import { generateSecretKey, nip19 } from 'nostr-tools'
import { AccountService } from './accountService.js'
import type {
  AccountRecord,
  AccountSession,
  BookmarkList,
  ChatViewTab,
  ChatConversation,
  ChatInvite,
  FeedItem,
  GroupJoinRequest,
  GroupListEntry,
  GroupViewTab,
  GroupFileRecord,
  GroupInvite,
  GroupSummary,
  InvitesInboxItem,
  ListService as IListService,
  LogLevel,
  PaneViewportMap,
  PerfMetrics,
  RelayEntry,
  SearchMode,
  SearchResult,
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
import { resolveStoragePaths } from '../storage/paths.js'
import { UiStateStore } from '../storage/uiStateStore.js'
import { DEFAULT_DISCOVERY_RELAYS, SEARCHABLE_RELAYS } from '../lib/constants.js'
import { uniqueRelayUrls, nip04Decrypt, nip04Encrypt } from '../lib/nostr.js'
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
  feed: FeedItem[]
  groups: GroupSummary[]
  invites: GroupInvite[]
  files: GroupFileRecord[]
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
  groupViewTab: GroupViewTab
  chatViewTab: ChatViewTab
  keymap: {
    vimNavigation: boolean
  }
  paneViewport: PaneViewportMap
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

function maybeNpub(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return nip19.npubEncode(value)
  } catch {
    return undefined
  }
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

  private state: ControllerState = {
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
      feed: [...this.state.feed],
      groups: this.state.groups.map((group) => ({ ...group })),
      invites: this.state.invites.map((invite) => ({ ...invite })),
      files: this.state.files.map((file) => ({ ...file })),
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
      groupDiscover: this.state.groupDiscover.map((group) => ({ ...group })),
      myGroups: this.state.myGroups.map((group) => ({ ...group })),
      groupInvites: this.state.groupInvites.map((invite) => ({ ...invite })),
      groupJoinRequests: Object.fromEntries(
        Object.entries(this.state.groupJoinRequests).map(([key, value]) => [key, value.map((row) => ({ ...row }))])
      ),
      invitesInbox: this.state.invitesInbox.map((item) => ({ ...item })),
      keymap: { ...this.state.keymap },
      paneViewport: Object.fromEntries(
        Object.entries(this.state.paneViewport).map(([key, value]) => [key, { ...value }])
      ),
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

  private refreshDerivedCollections(): void {
    const myGroupListIds = new Set(this.state.myGroupList.map((entry) => entry.groupId))
    const myGroups = this.state.groupDiscover.filter((group) => myGroupListIds.has(group.id))

    const invitesInbox = buildInvitesInbox({
      groupInvites: this.state.groupInvites,
      chatInvites: this.state.chatInvites
    })

    this.state.myGroups = myGroups
    this.state.invitesInbox = invitesInbox
    this.state.filesCount = selectFilesCount(this.state.files)
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

  private async loadAccountScopedUiState(userKey: string | null): Promise<void> {
    if (!userKey) return
    const scoped = this.uiStateStore.getAccountState(userKey)
    this.patchState({
      groupViewTab: scoped.groupViewTab,
      chatViewTab: scoped.chatViewTab,
      paneViewport: scoped.paneViewport,
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
  }

  private async persistAccountScopedUiState(patch: {
    groupViewTab?: GroupViewTab
    chatViewTab?: ChatViewTab
    paneViewport?: PaneViewportMap
    dismissedGroupInviteIds?: string[]
    acceptedGroupInviteIds?: string[]
    acceptedGroupInviteGroupIds?: string[]
    dismissedChatInviteIds?: string[]
    acceptedChatInviteIds?: string[]
    acceptedChatInviteConversationIds?: string[]
    perfOverlayEnabled?: boolean
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
          const lifecycle =
            phase === 'ready'
              ? 'ready'
              : phase === 'stopping'
                ? 'stopping'
                : phase === 'error'
                  ? 'error'
                  : phase
                    ? 'initializing'
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

        if (event.type === 'relay-update' && Array.isArray((event as { relays?: unknown[] }).relays)) {
          this.patchState({
            relays: ((event as unknown as { relays: RelayEntry[] }).relays || [])
          })
          return
        }

        if (event.type === 'error') {
          const message =
            typeof (event as { message?: string }).message === 'string'
              ? (event as { message?: string }).message || 'Worker error'
              : event.error || 'Worker error'

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
        this.workerStdoutQueue.push(...lines)
        this.scheduleWorkerOutputFlush()
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onStderr((chunk) => {
        const lines = sanitizeWorkerChunk(chunk)
        if (!lines.length) return
        this.workerStderrQueue.push(...lines)
        this.scheduleWorkerOutputFlush()
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onExit((code) => {
        this.resetChatRuntimeState()
        this.patchState({
          lifecycle: 'stopped',
          readinessMessage: `Worker exited (${code})`
        })
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

    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, nextAttempt - 1))
    this.patchState({
      workerRecoveryState: {
        ...this.state.workerRecoveryState,
        status: 'scheduled',
        attempt: nextAttempt,
        nextDelayMs: delayMs,
        lastExitCode: exitCode,
        lastError: null
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
        this.patchState({ session: null })
      }
    })
  }

  async selectAccount(pubkey: string): Promise<void> {
    await this.runTask('Select account', async () => {
      if (this.state.session && this.state.session.pubkey !== pubkey) {
        await this.workerHost.stop().catch(() => {})
        this.resetChatRuntimeState()
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
    })
  }

  async clearSession(): Promise<void> {
    await this.runTask('Clear session', async () => {
      this.clearRecoveryTimer()
      await this.workerHost.stop().catch(() => {})
      this.resetChatRuntimeState()
      this.patchState({
        session: null,
        lifecycle: 'stopped',
        readinessMessage: 'Stopped'
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
    const nextTab: GroupViewTab = ['discover', 'my', 'invites'].includes(tab) ? tab : 'discover'
    this.patchState({ groupViewTab: nextTab })
    await this.persistAccountScopedUiState({ groupViewTab: nextTab })
  }

  async setChatViewTab(tab: ChatViewTab): Promise<void> {
    const nextTab: ChatViewTab = ['conversations', 'invites'].includes(tab) ? tab : 'conversations'
    this.patchState({ chatViewTab: nextTab })
    await this.persistAccountScopedUiState({ chatViewTab: nextTab })
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
    this.patchState({ paneViewport: next })
    await this.persistAccountScopedUiState({ paneViewport: next })
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

  private currentRelayUrls(): string[] {
    const workerRelays = this.state.relays
      .map((entry) => entry.connectionUrl)
      .filter((entry): entry is string => typeof entry === 'string' && !!entry)

    return uniqueRelayUrls([...workerRelays, ...DEFAULT_DISCOVERY_RELAYS])
  }

  private resolveRelayUrl(relay?: string): string | undefined {
    const normalized = String(relay || '').trim()
    if (!normalized) return undefined

    const direct = this.state.relays.find((entry) =>
      entry.connectionUrl === normalized
      || entry.publicIdentifier === normalized
      || entry.relayKey === normalized
    )
    if (direct?.connectionUrl) return direct.connectionUrl

    const slashForm = normalized.replace(':', '/')
    const slashHit = this.state.relays.find((entry) => entry.publicIdentifier === slashForm)
    if (slashHit?.connectionUrl) return slashHit.connectionUrl

    return normalized
  }

  private searchableRelayUrls(): string[] {
    return uniqueRelayUrls([...this.currentRelayUrls(), ...SEARCHABLE_RELAYS])
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
    })
  }

  async stopWorker(): Promise<void> {
    await this.runTask('Stop worker', async () => {
      this.clearRecoveryTimer()
      this.patchState({ lifecycle: 'stopping', readinessMessage: 'Stopping worker…' })
      await this.workerHost.stop()
      this.resetChatRuntimeState()
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

      const relays = await this.withTimeout(
        this.relayService.getRelays(),
        25_000,
        'Relay refresh'
      )
      this.patchState({
        relays: relays as RelayEntry[]
      })
    }, { dedupeKey: 'refresh:relays', retries: 1 })
  }

  async createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Create relay', async () => {
      const result = await this.relayService.createRelay(input)
      await this.refreshRelays()
      return result
    })
  }

  async joinRelay(input: {
    relayKey?: string
    publicIdentifier?: string
    relayUrl?: string
    authToken?: string
    fileSharing?: boolean
  }): Promise<Record<string, unknown>> {
    return await this.runTask('Join relay', async () => {
      const result = await this.relayService.joinRelay(input)
      await this.refreshRelays()
      return result
    })
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
    await this.runTask('Start join flow', async () => {
      await this.relayService.startJoinFlow(input)
    })
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
      const relays = this.currentRelayUrls()
      const feed = await this.feedService.fetchFeed(
        relays,
        {
          kinds: [1, 6, 7, 20, 21, 22],
          limit
        },
        5_000
      )
      this.patchState({ feed })
    })
  }

  async publishPost(content: string): Promise<Event> {
    return await this.runTask('Publish post', async () => {
      const event = await this.postService.publishTextNote(content, this.currentRelayUrls())
      this.patchState({ feed: [event, ...this.state.feed] })
      return event
    })
  }

  async publishReply(content: string, replyToEventId: string, replyToPubkey: string): Promise<Event> {
    return await this.runTask('Publish reply', async () => {
      return await this.postService.publishReply(
        content,
        replyToEventId,
        replyToPubkey,
        this.currentRelayUrls()
      )
    })
  }

  async publishReaction(eventId: string, eventPubkey: string, reaction: string): Promise<Event> {
    return await this.runTask('Publish reaction', async () => {
      return await this.postService.publishReaction(
        eventId,
        eventPubkey,
        reaction,
        this.currentRelayUrls()
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
      const event = await this.bookmarkService.publishBookmarks(nextIds, this.currentRelayUrls())
      this.patchState({ bookmarks: { event, eventIds: nextIds } })
    })
  }

  async removeBookmark(eventId: string): Promise<void> {
    await this.runTask('Remove bookmark', async () => {
      const nextIds = this.bookmarkService.removeBookmark(this.state.bookmarks, eventId)
      const event = await this.bookmarkService.publishBookmarks(nextIds, this.currentRelayUrls())
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

  async refreshGroups(): Promise<void> {
    await this.runTask('Refresh groups', async () => {
      const [groups, myGroupList] = await Promise.all([
        this.groupService.discoverGroups(this.searchableRelayUrls()),
        this.state.session
          ? this.groupService.loadMyGroupList(this.searchableRelayUrls(), this.state.session.pubkey)
          : Promise.resolve(this.state.myGroupList)
      ])

      this.patchState({
        groups,
        groupDiscover: groups,
        myGroupList
      })
    }, { dedupeKey: 'refresh:groups', retries: 1 })
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
        relayUrl: target.relay,
        fileSharing: target.fileSharing,
        openJoin: !target.token && target.fileSharing !== false
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
      const groupKey = relay ? `${relay}|${groupId}` : groupId
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
          [groupKey]: requests
        }
      })
    }, { dedupeKey: `refresh:join-requests:${groupId}:${relay || ''}`, retries: 1 })
  }

  async approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.runTask('Approve join request', async () => {
      await this.groupService.approveJoinRequest(groupId, pubkey, relay)
      const groupKey = relay ? `${relay}|${groupId}` : groupId
      const next = (this.state.groupJoinRequests[groupKey] || []).filter((request) => request.pubkey !== pubkey)
      this.patchState({
        groupJoinRequests: {
          ...this.state.groupJoinRequests,
          [groupKey]: next
        }
      })
    })
  }

  async rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.runTask('Reject join request', async () => {
      await this.groupService.rejectJoinRequest(groupId, pubkey, relay)
      const groupKey = relay ? `${relay}|${groupId}` : groupId
      const next = (this.state.groupJoinRequests[groupKey] || []).filter((request) => request.pubkey !== pubkey)
      this.patchState({
        groupJoinRequests: {
          ...this.state.groupJoinRequests,
          [groupKey]: next
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
      const session = this.requireSession()
      await this.groupService.sendInvite({
        ...input,
        relayTargets: input.relayTargets && input.relayTargets.length
          ? input.relayTargets
          : this.searchableRelayUrls(),
        encrypt: (pubkey, plaintext) => nip04Encrypt(session.nsecHex, pubkey, plaintext)
      })
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
      this.patchState({ files })
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
  }): Promise<void> {
    await this.runTask('Create conversation', async () => {
      await this.chatService.createConversation({
        ...input,
        relayUrls: this.currentRelayUrls()
      })
      await this.refreshChats()
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
    })
  }

  async sendChatMessage(conversationId: string, content: string): Promise<void> {
    await this.runTask('Send chat message', async () => {
      const sent = await this.chatService.sendMessage(conversationId, content)
      this.patchState({
        threadMessages: [...this.state.threadMessages, sent]
      })
    })
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
