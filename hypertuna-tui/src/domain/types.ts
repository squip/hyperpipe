import type { Event, Filter } from 'nostr-tools'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type AccountSignerType = 'nsec' | 'ncryptsec'

export type AccountRecord = {
  pubkey: string
  userKey: string
  signerType: AccountSignerType
  nsec?: string
  ncryptsec?: string
  label?: string
  createdAt: number
  updatedAt: number
}

export type AccountSession = {
  pubkey: string
  userKey: string
  nsecHex: string
  nsec: string
  signerType: AccountSignerType
}

export type RelayEntry = {
  relayKey: string
  publicIdentifier?: string
  connectionUrl?: string
  userAuthToken?: string
  requiresAuth?: boolean
  writable?: boolean
  readyForReq?: boolean
  name?: string
  description?: string
  createdAt?: number
  members?: string[]
  registrationStatus?: string
  registrationError?: string
  isActive?: boolean
  gatewayPath?: string
}

export type FeedItem = Event

export type GroupSummary = {
  id: string
  relay?: string
  name: string
  about?: string
  picture?: string
  isPublic?: boolean
  isOpen?: boolean
  event?: Event
}

export type GroupInvite = {
  id: string
  groupId: string
  relay?: string
  groupName?: string
  groupPicture?: string
  isPublic?: boolean
  fileSharing?: boolean
  token?: string
  event: Event
}

export type GroupFileRecord = {
  eventId: string
  url: string
  groupId: string
  groupRelay?: string | null
  groupName?: string | null
  fileName: string
  mime?: string | null
  size?: number | null
  uploadedAt: number
  uploadedBy: string
  sha256?: string | null
  event: Event
}

export type StarterPack = {
  id: string
  title: string
  description?: string
  image?: string
  pubkeys: string[]
  relayUrls?: string[]
  event: Event
}

export type BookmarkList = {
  event: Event | null
  eventIds: string[]
}

export type ChatConversation = {
  id: string
  title: string
  description?: string | null
  participants: string[]
  adminPubkeys: string[]
  canInviteMembers: boolean
  unreadCount: number
  lastMessageAt: number
  lastMessagePreview?: string | null
}

export type ChatInvite = {
  id: string
  senderPubkey: string
  createdAt: number
  status: 'pending' | 'joining' | 'joined' | 'failed'
  conversationId?: string | null
  title?: string | null
  description?: string | null
}

export type ThreadMessage = {
  id: string
  conversationId: string
  senderPubkey: string
  content: string
  timestamp: number
  type: 'text' | 'media' | 'reaction' | 'system'
  attachments?: Array<{
    url: string
    gatewayUrl?: string | null
    mime?: string | null
    size?: number | null
    width?: number | null
    height?: number | null
    fileName?: string | null
    sha256?: string | null
  }>
}

export type SearchMode = 'notes' | 'profiles' | 'groups' | 'lists'

export type SearchResult = {
  mode: SearchMode
  event: Event
  relay?: string
}

export type GroupViewTab = 'discover' | 'my' | 'invites'
export type ChatViewTab = 'conversations' | 'invites'

export type GroupListEntry = {
  groupId: string
  relay?: string
}

export type GroupJoinRequest = {
  id: string
  groupId: string
  pubkey: string
  createdAt: number
  relay?: string
  reason?: string
  code?: string
}

export type InvitesInboxItem =
  | {
      type: 'group'
      id: string
      createdAt: number
      groupId: string
      title: string
      relay?: string
      token?: string
    }
  | {
      type: 'chat'
      id: string
      createdAt: number
      conversationId?: string | null
      title: string
      senderPubkey: string
      status: ChatInvite['status']
    }

export type PaneViewportEntry = {
  cursor: number
  offset: number
}

export type PaneViewportMap = Record<string, PaneViewportEntry>

export type PerfOperationSample = {
  name: string
  startedAt: number
  durationMs: number
  success: boolean
  attempts: number
}

export type PerfMetrics = {
  inFlight: number
  queueDepth: number
  dedupedRequests: number
  cancelledRequests: number
  retries: number
  staleResponseDrops: number
  operationSamples: PerfOperationSample[]
  avgLatencyMs: number
  p95LatencyMs: number
  renderPressure: number
  overlayEnabled: boolean
}

export type WorkerRecoveryState = {
  enabled: boolean
  status: 'idle' | 'scheduled' | 'recovering' | 'disabled'
  attempt: number
  nextDelayMs: number
  lastExitCode: number | null
  lastError?: string | null
}

export type FileScope = {
  localGroupIds: string[]
  relayGroups: Array<{ relayUrl: string; groupIds: string[] }>
  fallbackRelays?: string[]
}

export interface AccountService {
  listAccounts(): AccountRecord[]
  getCurrentAccountPubkey(): string | null
  setCurrentAccount(pubkey: string | null): Promise<void>
  addNsecAccount(nsec: string, label?: string): Promise<AccountRecord>
  addNcryptsecAccount(ncryptsec: string, password: string, label?: string): Promise<AccountRecord>
  removeAccount(pubkey: string): Promise<void>
  unlockAccount(pubkey: string, getPassword?: () => Promise<string>): Promise<AccountSession>
}

export interface RelayService {
  getRelays(): Promise<RelayEntry[]>
  createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
  }): Promise<Record<string, unknown>>
  joinRelay(input: {
    relayKey?: string
    publicIdentifier?: string
    relayUrl?: string
    authToken?: string
    fileSharing?: boolean
  }): Promise<Record<string, unknown>>
  startJoinFlow(input: {
    publicIdentifier: string
    fileSharing?: boolean
    isOpen?: boolean
    token?: string
    relayKey?: string
    relayUrl?: string
    openJoin?: boolean
  }): Promise<void>
  disconnectRelay(relayKey: string, publicIdentifier?: string): Promise<void>
  leaveGroup(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    saveRelaySnapshot?: boolean
    saveSharedFiles?: boolean
  }): Promise<Record<string, unknown>>
}

export interface FeedService {
  fetchFeed(relays: string[], filter: Filter, maxWaitMs?: number): Promise<FeedItem[]>
}

export interface PostService {
  publishTextNote(content: string, relays: string[]): Promise<Event>
  publishReply(content: string, replyToEventId: string, replyToPubkey: string, relays: string[]): Promise<Event>
  publishReaction(eventId: string, eventPubkey: string, reaction: string, relays: string[]): Promise<Event>
}

export interface GroupService {
  discoverGroups(relays: string[], limit?: number): Promise<GroupSummary[]>
  discoverInvites(relays: string[], pubkey: string, decrypt: (pubkey: string, ciphertext: string) => Promise<string>): Promise<GroupInvite[]>
  loadMyGroupList(relays: string[], pubkey: string): Promise<GroupListEntry[]>
  saveMyGroupList(relays: string[], pubkey: string, nsecHex: string, entries: GroupListEntry[]): Promise<void>
  dismissInvite(inviteIds: Set<string>, inviteId: string): Set<string>
  markInviteAccepted(
    acceptedInviteIds: Set<string>,
    acceptedGroupIds: Set<string>,
    inviteId: string,
    groupId?: string
  ): { inviteIds: Set<string>; groupIds: Set<string> }
  loadJoinRequests(
    relays: string[],
    groupId: string,
    opts?: { handledKeys?: Set<string>; currentMembers?: Set<string> }
  ): Promise<GroupJoinRequest[]>
  approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
  rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
  sendInvite(input: {
    groupId: string
    relayUrl: string
    inviteePubkey: string
    token?: string
    payload: Record<string, unknown>
    encrypt: (pubkey: string, plaintext: string) => Promise<string>
    relayTargets: string[]
  }): Promise<Event>
  updateMembers(input: {
    relayKey?: string
    publicIdentifier?: string
    members?: string[]
    memberAdds?: Array<{ pubkey: string; ts: number }>
    memberRemoves?: Array<{ pubkey: string; ts: number }>
  }): Promise<void>
  updateAuthData(input: {
    relayKey?: string
    publicIdentifier?: string
    pubkey: string
    token: string
  }): Promise<void>
}

export interface FileService {
  uploadFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
    localRelayBaseUrl?: string
    metadata?: Record<string, unknown>
  }): Promise<Record<string, unknown>>
  fetchGroupFiles(relays: string[], groupId?: string, limit?: number): Promise<GroupFileRecord[]>
  fetchScopedGroupFiles(scope: FileScope, limit?: number): Promise<GroupFileRecord[]>
}

export interface ListService {
  fetchStarterPacks(relays: string[], maxWaitMs?: number): Promise<StarterPack[]>
  publishStarterPack(input: {
    dTag: string
    title: string
    description?: string
    image?: string
    pubkeys: string[]
    relays: string[]
  }): Promise<Event>
  loadFollowList(relays: string[], pubkey: string): Promise<string[]>
  publishFollowList(pubkeys: string[], relays: string[]): Promise<Event>
}

export interface BookmarkService {
  loadBookmarks(relays: string[], pubkey: string): Promise<BookmarkList>
  publishBookmarks(eventIds: string[], relays: string[]): Promise<Event>
}

export interface ChatService {
  init(relays: string[]): Promise<void>
  listConversations(search?: string): Promise<ChatConversation[]>
  listInvites(search?: string): Promise<ChatInvite[]>
  filterActionableInvites(
    invites: ChatInvite[],
    opts?: {
      dismissedInviteIds?: Set<string>
      acceptedInviteIds?: Set<string>
      acceptedConversationIds?: Set<string>
    }
  ): ChatInvite[]
  selectUnreadTotal(conversations: ChatConversation[]): number
  selectPendingInviteCount(invites: ChatInvite[]): number
  createConversation(input: {
    title: string
    description?: string
    members: string[]
    relayUrls?: string[]
  }): Promise<ChatConversation>
  acceptInvite(inviteId: string): Promise<{ conversationId: string | null }>
  loadThread(conversationId: string, limit?: number): Promise<ThreadMessage[]>
  sendMessage(conversationId: string, content: string): Promise<ThreadMessage>
}

export interface SearchService {
  searchNotes(relays: string[], query: string, limit?: number): Promise<SearchResult[]>
  searchProfiles(relays: string[], query: string, limit?: number): Promise<SearchResult[]>
  searchGroups(relays: string[], query: string, limit?: number): Promise<SearchResult[]>
  searchLists(relays: string[], query: string, limit?: number): Promise<SearchResult[]>
}
