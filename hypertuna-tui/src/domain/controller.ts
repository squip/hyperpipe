import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { AccountService } from './accountService.js'
import type {
  AccountRecord,
  AccountSession,
  BookmarkList,
  ChatConversation,
  ChatInvite,
  FeedItem,
  GroupFileRecord,
  GroupInvite,
  GroupSummary,
  ListService as IListService,
  LogLevel,
  RelayEntry,
  SearchMode,
  SearchResult,
  StarterPack,
  ThreadMessage
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
import { resolveStoragePaths } from '../storage/paths.js'
import { UiStateStore } from '../storage/uiStateStore.js'
import { DEFAULT_DISCOVERY_RELAYS, SEARCHABLE_RELAYS } from '../lib/constants.js'
import { uniqueRelayUrls, nip04Decrypt, nip04Encrypt } from '../lib/nostr.js'

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
  workerStdout: string[]
  workerStderr: string[]
  logs: LogEntry[]
  busyTask: string | null
  lastError: string | null
}

function trimLogs<T>(items: T[], max = 400): T[] {
  if (items.length <= max) return items
  return items.slice(items.length - max)
}

function trimLines(lines: string[], max = 250): string[] {
  if (lines.length <= max) return lines
  return lines.slice(lines.length - max)
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
    workerStdout: [],
    workerStderr: [],
    logs: [],
    busyTask: null,
    lastError: null
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

  private requireSession(): AccountSession {
    if (!this.state.session) {
      throw new Error('No unlocked account session')
    }
    return this.state.session
  }

  async initialize(): Promise<void> {
    await this.accountService.waitUntilReady()
    await this.uiStateStore.waitUntilReady()

    this.attachWorkerListeners()

    const accounts = this.accountService.listAccounts()
    const currentAccountPubkey = this.accountService.getCurrentAccountPubkey()

    this.patchState({
      initialized: true,
      accounts,
      currentAccountPubkey
    })

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
      this.workerHost.onStdout((line) => {
        const trimmed = line.trimEnd()
        if (!trimmed) return
        this.state.workerStdout = trimLines([...this.state.workerStdout, trimmed])
        this.emitter.emit('change')
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onStderr((line) => {
        const trimmed = line.trimEnd()
        if (!trimmed) return
        this.state.workerStderr = trimLines([...this.state.workerStderr, trimmed])
        this.emitter.emit('change')
      })
    )

    this.workerUnsubs.push(
      this.workerHost.onExit((code) => {
        this.patchState({
          lifecycle: 'stopped',
          readinessMessage: `Worker exited (${code})`
        })
        this.log('warn', `Worker exited with code ${code}`)
      })
    )
  }

  private detachWorkerListeners(): void {
    for (const off of this.workerUnsubs) {
      off()
    }
    this.workerUnsubs = []
  }

  private async runTask<T>(name: string, task: () => Promise<T>): Promise<T> {
    this.patchState({ busyTask: name, lastError: null })
    try {
      const result = await task()
      this.patchState({ busyTask: null })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patchState({ busyTask: null, lastError: message })
      this.log('error', `${name}: ${message}`)
      throw error
    }
  }

  async addNsecAccount(nsec: string, label?: string): Promise<void> {
    await this.runTask('Add nsec account', async () => {
      const added = await this.accountService.addNsecAccount(nsec, label)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: added.pubkey
      })
    })
  }

  async addNcryptsecAccount(ncryptsec: string, password: string, label?: string): Promise<void> {
    await this.runTask('Add ncryptsec account', async () => {
      const added = await this.accountService.addNcryptsecAccount(ncryptsec, password, label)
      this.patchState({
        accounts: this.accountService.listAccounts(),
        currentAccountPubkey: added.pubkey
      })
    })
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
        this.patchState({ session: null, lifecycle: 'stopped', readinessMessage: 'Stopped' })
      }
      await this.accountService.setCurrentAccount(pubkey)
      this.patchState({
        currentAccountPubkey: this.accountService.getCurrentAccountPubkey(),
        accounts: this.accountService.listAccounts()
      })
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
    })
  }

  async clearSession(): Promise<void> {
    await this.runTask('Clear session', async () => {
      await this.workerHost.stop().catch(() => {})
      this.patchState({
        session: null,
        lifecycle: 'stopped',
        readinessMessage: 'Stopped'
      })
    })
  }

  private currentRelayUrls(): string[] {
    const workerRelays = this.state.relays
      .map((entry) => entry.connectionUrl)
      .filter((entry): entry is string => typeof entry === 'string' && !!entry)

    return uniqueRelayUrls([...workerRelays, ...DEFAULT_DISCOVERY_RELAYS])
  }

  private searchableRelayUrls(): string[] {
    return uniqueRelayUrls([...this.currentRelayUrls(), ...SEARCHABLE_RELAYS])
  }

  async startWorker(): Promise<void> {
    await this.runTask('Start worker', async () => {
      const session = this.requireSession()

      this.patchState({
        lifecycle: 'starting',
        readinessMessage: 'Starting worker…'
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
        readinessMessage: result.alreadyRunning ? 'Worker already running' : 'Worker started'
      })

      await this.refreshRelays()
    })
  }

  async stopWorker(): Promise<void> {
    await this.runTask('Stop worker', async () => {
      this.patchState({ lifecycle: 'stopping', readinessMessage: 'Stopping worker…' })
      await this.workerHost.stop()
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
      const relays = await this.relayService.getRelays()
      this.patchState({
        relays: relays as RelayEntry[]
      })
    })
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

  async refreshGroups(): Promise<void> {
    await this.runTask('Refresh groups', async () => {
      const groups = await this.groupService.discoverGroups(this.searchableRelayUrls())
      this.patchState({ groups })
    })
  }

  async refreshInvites(): Promise<void> {
    await this.runTask('Refresh invites', async () => {
      const session = this.requireSession()
      const invites = await this.groupService.discoverInvites(
        this.searchableRelayUrls(),
        session.pubkey,
        async (pubkey, ciphertext) => nip04Decrypt(session.nsecHex, pubkey, ciphertext)
      )
      this.patchState({ invites })
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
      return await this.fileService.uploadFile(input)
    })
  }

  async refreshGroupFiles(groupId?: string): Promise<void> {
    await this.runTask('Refresh files', async () => {
      const files = await this.fileService.fetchGroupFiles(this.searchableRelayUrls(), groupId)
      this.patchState({ files })
    })
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
      await this.chatService.init(this.currentRelayUrls())
      const [conversations, invites] = await Promise.all([
        this.chatService.listConversations(),
        this.chatService.listInvites()
      ])
      this.patchState({ conversations, chatInvites: invites })
    })
  }

  async refreshChats(): Promise<void> {
    await this.runTask('Refresh chats', async () => {
      const [conversations, invites] = await Promise.all([
        this.chatService.listConversations(),
        this.chatService.listInvites()
      ])
      this.patchState({ conversations, chatInvites: invites })
    })
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
      await this.chatService.acceptInvite(inviteId)
      await this.refreshChats()
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
    try {
      await this.workerHost.stop()
    } catch {
      // ignore
    }
    this.nostrClient.destroy()
  }
}
