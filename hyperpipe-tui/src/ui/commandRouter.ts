import type { NavNodeId } from '../lib/constants.js'
import { FILE_FAMILY_ORDER } from '../lib/constants.js'
import type { ClipboardCopyResult } from '../runtime/clipboard.js'
import { normalizeBool, splitCsv } from '../lib/format.js'
import { buildCommandHelpSummary } from './commandCatalog.js'

export type CommandResult = {
  message: string
  gotoNode?: NavNodeId
}

export type AccountProfileSummary = {
  pubkey: string
  label?: string
  signerType: 'nsec' | 'ncryptsec' | string
  isCurrent: boolean
}

type GeneratedAccount = {
  pubkey: string
  nsec: string
  label?: string
}

type SelectedGroupRef = {
  id: string
  relay?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
}

type SelectedGroupInviteRef = {
  kind: 'group'
  id: string
  groupId: string
  relay?: string | null
  token?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
}

type SelectedChatInviteRef = {
  kind: 'chat'
  id: string
  conversationId?: string | null
}

type SelectedInviteRef = SelectedGroupInviteRef | SelectedChatInviteRef

type SelectedRelayRef = {
  relayKey: string
  publicIdentifier?: string | null
  connectionUrl?: string | null
}

type SelectedFileRef = {
  eventId: string
  groupId: string
  fileName?: string | null
  relay?: string | null
  url?: string | null
  sha256?: string | null
}

type SelectedConversationRef = {
  id: string
}

type SelectedNoteRef = {
  id: string
  pubkey: string
  groupId?: string | null
}

export type CommandContext = {
  currentSection?: string
  currentNode?: NavNodeId
  resolveSelectedGroup?: () => SelectedGroupRef | null
  resolveSelectedInvite?: () => SelectedInviteRef | null
  resolveSelectedRelay?: () => SelectedRelayRef | null
  resolveSelectedFile?: () => SelectedFileRef | null
  resolveSelectedConversation?: () => SelectedConversationRef | null
  resolveSelectedNote?: () => SelectedNoteRef | null
  copy?: (text: string) => Promise<ClipboardCopyResult>
  unsafeCopySecrets?: boolean
}

export interface CommandController {
  getState(): {
    discoveredGateways: Array<{
      gatewayId: string
      publicUrl: string
      displayName?: string | null
      region?: string | null
    }>
    authorizedGateways: Array<{
      gatewayId: string
      publicUrl: string
      displayName?: string | null
      region?: string | null
    }>
    gatewayAccessCatalog: Array<{
      gatewayId?: string | null
      gatewayOrigin?: string | null
      hostingState?: string
      reason?: string | null
    }>
  }
  addNsecAccount(nsec: string, label?: string): Promise<void>
  addNcryptsecAccount(ncryptsec: string, password: string, label?: string): Promise<void>
  generateNsecAccount(label?: string): Promise<GeneratedAccount>
  listAccountProfiles(): Promise<AccountProfileSummary[]>
  selectAccount(pubkey: string): Promise<void>
  unlockCurrentAccount(getPassword?: () => Promise<string>): Promise<void>
  removeAccount(pubkey: string): Promise<void>
  clearSession(): Promise<void>
  setLastCopied(value: string, method: ClipboardCopyResult['method']): Promise<void>

  startWorker(): Promise<void>
  stopWorker(): Promise<void>
  restartWorker(): Promise<void>
  refreshGatewayCatalog(options?: { force?: boolean; timeoutMs?: number }): Promise<Array<{
    gatewayId: string
    publicUrl: string
    displayName?: string | null
    region?: string | null
    source?: string | null
    isExpired?: boolean
    lastSeenAt?: number | null
  }>>

  refreshRelays(): Promise<void>
  createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
  }): Promise<Record<string, unknown>>
  joinRelay(input: {
    relayKey?: string
    publicIdentifier?: string
    relayUrl?: string
    authToken?: string
    fileSharing?: boolean
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
  }): Promise<Record<string, unknown>>
  disconnectRelay(relayKey: string, publicIdentifier?: string): Promise<void>
  leaveGroup(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    saveRelaySnapshot?: boolean
    saveSharedFiles?: boolean
  }): Promise<Record<string, unknown>>
  startJoinFlow(input: {
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
  }): Promise<void>
  requestGroupInvite(input: {
    groupId: string
    relay?: string | null
    code?: string
    reason?: string
  }): Promise<void>

  refreshGroups(): Promise<void>
  refreshInvites(): Promise<void>
  refreshGroupMembers(groupId: string, relay?: string): Promise<unknown>
  sendInvite(input: {
    groupId: string
    relayUrl: string
    inviteePubkey: string
    token?: string
    payload: Record<string, unknown>
    relayTargets?: string[]
  }): Promise<void>
  updateGroupMembers(input: {
    relayKey?: string
    publicIdentifier?: string
    members?: string[]
    memberAdds?: Array<{ pubkey: string; ts: number }>
    memberRemoves?: Array<{ pubkey: string; ts: number }>
  }): Promise<void>
  updateGroupAuth(input: {
    relayKey?: string
    publicIdentifier?: string
    pubkey: string
    token: string
  }): Promise<void>
  acceptGroupInvite(
    inviteId: string
  ): Promise<void>
  dismissGroupInvite(inviteId: string): Promise<void>
  setGroupViewTab(tab: 'discover' | 'my'): Promise<void>
  refreshJoinRequests(groupId: string, relay?: string): Promise<void>
  approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
  rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
  setGroupSearch(query: string): Promise<void>
  setGroupSort(sortKey: 'name' | 'description' | 'open' | 'public' | 'admin' | 'createdAt' | 'members' | 'peers', direction?: string): Promise<void>
  setGroupVisibilityFilter(visibility: 'all' | 'public' | 'private'): Promise<void>
  setGroupJoinFilter(joinMode: 'all' | 'open' | 'closed'): Promise<void>

  refreshGroupNotes(groupId: string, relay?: string): Promise<void>
  publishPost(content: string): Promise<unknown>
  publishReply(content: string, replyToEventId: string, replyToPubkey: string): Promise<unknown>
  publishReaction(eventId: string, eventPubkey: string, reaction: string): Promise<unknown>

  refreshGroupFiles(groupId?: string): Promise<void>
  uploadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
  }): Promise<Record<string, unknown>>
  downloadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
    fileName?: string | null
  }): Promise<{ savedPath: string; bytes: number; source: string }>
  deleteLocalGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
  }): Promise<{ deleted: boolean; reason?: string | null }>
  setFileSearch(query: string): Promise<void>
  setFileSort(sortKey: 'fileName' | 'group' | 'uploadedAt' | 'uploadedBy' | 'size' | 'mime', direction?: string): Promise<void>
  setFileMimeFilter(mime: string): Promise<void>
  setFileGroupFilter(group: string): Promise<void>

  initChats(): Promise<void>
  refreshChats(): Promise<void>
  createConversation(input: {
    title: string
    description?: string
    members: string[]
    relayUrls?: string[]
    relayMode?: 'withFallback' | 'strict'
  }): Promise<void>
  inviteChatMembers(conversationId: string, members: string[]): Promise<{
    conversationId: string
    invited: string[]
    failed: Array<{
      pubkey: string
      error: string
    }>
    conversation: unknown | null
  }>
  searchProfileSuggestions(query: string, limit?: number): Promise<Array<{
    pubkey: string
    name?: string | null
    about?: string | null
    nip05?: string | null
    source?: 'local' | 'remote' | 'cache'
  }>>
  acceptChatInvite(inviteId: string): Promise<void>
  dismissChatInvite(inviteId: string): Promise<void>
  setChatViewTab(tab: 'conversations' | 'invites'): Promise<void>
  loadChatThread(conversationId: string): Promise<void>
  sendChatMessage(conversationId: string, content: string): Promise<void>

  startComposeDraft(groupId: string, relay?: string): Promise<void>
  updateComposeText(content: string): Promise<void>
  attachComposeFile(filePath: string): Promise<void>
  removeComposeAttachment(selector: string): Promise<void>
  composeDraftSnapshot(): {
    groupId: string
    relay?: string | null
    content: string
    attachments: Array<{ filePath: string; fileName: string }>
  } | null
  publishComposeDraft(): Promise<unknown>
  cancelComposeDraft(): Promise<void>

  setPerfOverlay(enabled: boolean): Promise<void>
  perfSnapshot(): {
    inFlight: number
    queueDepth: number
    dedupedRequests: number
    cancelledRequests: number
    retries: number
    staleResponseDrops: number
    avgLatencyMs: number
    p95LatencyMs: number
    renderPressure: number
    operationSamples: Array<{ name: string; durationMs: number; attempts: number; success: boolean }>
  }
}

function tokenize(input: string): string[] {
  const matches = input.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || []
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''))
}

function remainder(input: string, command: string): string {
  const idx = input.toLowerCase().indexOf(command.toLowerCase())
  if (idx < 0) return ''
  return input.slice(idx + command.length).trim()
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

function normalizeHttpOrigin(value: string | null | undefined): string | null {
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

function normalizeGatewayId(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim().toLowerCase()
  return trimmed || null
}

function isHex64(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function looksLikeGroupIdentifier(value: string): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized.includes(':')) return true
  if (normalized.startsWith('npub')) return true
  return isHex64(normalized)
}

const NAV_ALIASES: Record<string, NavNodeId> = {
  dashboard: 'dashboard',
  relays: 'groups:my',
  relay: 'groups:my',
  'relay:browse': 'groups:browse',
  'relay:my': 'groups:my',
  'relay:create': 'groups:create',
  'browse-relays': 'groups:browse',
  'my-relays': 'groups:my',
  'create-relay': 'groups:create',
  chats: 'chats',
  'chats:create': 'chats:create',
  'create-chat': 'chats:create',
  invites: 'invites',
  'invites:group': 'invites:group',
  'relay-invites': 'invites:group',
  'invites:chat': 'invites:chat',
  'chat-invites': 'invites:chat',
  files: 'files',
  'files:images': 'files:type:images',
  'files:video': 'files:type:video',
  'files:audio': 'files:type:audio',
  'files:docs': 'files:type:docs',
  'files:other': 'files:type:other',
  accounts: 'accounts',
  logs: 'logs'
}

const LEGACY_GROUP_GOTO_MIGRATIONS: Record<string, string> = {
  groups: 'relay:my',
  'groups:browse': 'relay:browse',
  'groups:discover': 'relay:browse',
  'groups:my': 'relay:my',
  'groups:create': 'relay:create',
  browse: 'relay:browse',
  discover: 'relay:browse',
  my: 'relay:my',
  'create-group': 'relay:create',
  'group-invites': 'invites:group'
}

function parseNode(input: string): NavNodeId {
  const normalized = input.trim().toLowerCase()
  if (normalized === 'invites:send' || normalized === 'send-invite') {
    throw new Error('Navigation alias "send-invite" was removed. Use "goto relay:my" or "goto chats", then open a row and select "Send Invite".')
  }
  const alias = NAV_ALIASES[normalized]
  if (alias) return alias
  const migrationTarget = LEGACY_GROUP_GOTO_MIGRATIONS[normalized]
  if (migrationTarget) {
    throw new Error(`Navigation alias "${input}" was removed. Use "goto ${migrationTarget}" instead.`)
  }
  if (normalized.startsWith('files:type:')) {
    const family = normalized.replace('files:type:', '')
    if (FILE_FAMILY_ORDER.includes(family as (typeof FILE_FAMILY_ORDER)[number])) {
      return `files:type:${family}` as NavNodeId
    }
  }
  throw new Error(`Unknown navigation target: ${input}`)
}

function parseProfileSelector(selector: string, profiles: AccountProfileSummary[]): AccountProfileSummary {
  const normalized = selector.trim()
  if (!normalized) {
    throw new Error('Missing profile selector')
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10)
    if (index < 0 || index >= profiles.length) {
      throw new Error(`Profile index out of range: ${index}`)
    }
    const matchByIndex = profiles[index]
    if (!matchByIndex) {
      throw new Error(`Profile index out of range: ${index}`)
    }
    return matchByIndex
  }

  if (isHex64(normalized)) {
    const target = normalized.toLowerCase()
    const matchByPubkey = profiles.find((profile) => profile.pubkey.toLowerCase() === target)
    if (!matchByPubkey) {
      throw new Error(`No profile found for pubkey ${normalized}`)
    }
    return matchByPubkey
  }

  const byLabel = profiles.filter((profile) => (profile.label || '').toLowerCase() === normalized.toLowerCase())
  if (byLabel.length === 1) {
    return byLabel[0]
  }
  if (byLabel.length > 1) {
    throw new Error(`Multiple profiles match label "${selector}". Use profile index or pubkey.`)
  }

  throw new Error(`No profile found for selector "${selector}"`)
}

function shortValueForMessage(value: string, max = 160): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function suggestRelayMigration(input: string): string {
  const parts = tokenize(input)
  const legacyAction = String(parts[1] || '').trim().toLowerCase()
  const canonicalAction = legacyAction === 'request'
    ? 'request-invite'
    : legacyAction === 'accept-invite'
      ? 'invite-accept'
      : legacyAction === 'dismiss-invite'
        ? 'invite-dismiss'
        : (legacyAction || '<action>')
  const remaining = parts.slice(2).join(' ')
  return ['relay', canonicalAction, remaining].filter(Boolean).join(' ').trim()
}

function displayNodeId(node: NavNodeId): string {
  if (node === 'groups') return 'P2P Relays'
  if (node === 'groups:browse') return 'relays:browse'
  if (node === 'groups:my') return 'relays:my'
  if (node === 'groups:create') return 'relays:create'
  if (node === 'invites:group') return 'invites:relay'
  return node
}

const SENSITIVE_COPY_FIELDS = new Set(['nsec', 'ncryptsec', 'token', 'secret', 'writer-secret', 'writer_secret'])

function isSensitiveField(field: string): boolean {
  const normalized = String(field || '').trim().toLowerCase()
  if (!normalized) return false
  if (SENSITIVE_COPY_FIELDS.has(normalized)) return true
  return normalized.includes('secret')
}

export function resolveSelectedGroup(context?: CommandContext): SelectedGroupRef | null {
  return context?.resolveSelectedGroup?.() || null
}

export function resolveSelectedInvite(context?: CommandContext): SelectedInviteRef | null {
  return context?.resolveSelectedInvite?.() || null
}

export function resolveSelectedRelay(context?: CommandContext): SelectedRelayRef | null {
  return context?.resolveSelectedRelay?.() || null
}

export function resolveSelectedFile(context?: CommandContext): SelectedFileRef | null {
  return context?.resolveSelectedFile?.() || null
}

export function resolveSelectedConversation(context?: CommandContext): SelectedConversationRef | null {
  return context?.resolveSelectedConversation?.() || null
}

export function resolveSelectedNote(context?: CommandContext): SelectedNoteRef | null {
  return context?.resolveSelectedNote?.() || null
}

function resolveCopyField(field: string, context?: CommandContext): { label: string; value: string } | null {
  const normalized = field.toLowerCase()
  const selectedGroup = resolveSelectedGroup(context)
  const selectedInvite = resolveSelectedInvite(context)
  const selectedRelay = resolveSelectedRelay(context)
  const selectedFile = resolveSelectedFile(context)
  const selectedConversation = resolveSelectedConversation(context)
  const selectedNote = resolveSelectedNote(context)

  if (normalized === 'selected' || normalized === 'primary' || normalized === 'id') {
    if (selectedGroup?.id) return { label: 'group-id', value: selectedGroup.id }
    if (selectedInvite?.kind === 'group' && selectedInvite.groupId) {
      return { label: 'group-id', value: selectedInvite.groupId }
    }
    if (selectedInvite?.kind === 'chat' && selectedInvite.id) return { label: 'invite-id', value: selectedInvite.id }
    if (selectedRelay?.publicIdentifier) return { label: 'relay-identifier', value: selectedRelay.publicIdentifier }
    if (selectedRelay?.relayKey) return { label: 'relay-key', value: selectedRelay.relayKey }
    if (selectedFile?.groupId) return { label: 'group-id', value: selectedFile.groupId }
    if (selectedConversation?.id) return { label: 'conversation-id', value: selectedConversation.id }
    if (selectedNote?.id) return { label: 'event-id', value: selectedNote.id }
    return null
  }

  if (normalized === 'relay-id') {
    if (selectedGroup?.id) return { label: 'relay-id', value: selectedGroup.id }
    if (selectedInvite?.kind === 'group' && selectedInvite.groupId) {
      return { label: 'relay-id', value: selectedInvite.groupId }
    }
    if (selectedFile?.groupId) return { label: 'relay-id', value: selectedFile.groupId }
    if (selectedNote?.groupId) return { label: 'relay-id', value: selectedNote.groupId }
    return null
  }

  if (normalized === 'group-id' || normalized === 'group') {
    if (selectedGroup?.id) return { label: 'group-id', value: selectedGroup.id }
    if (selectedInvite?.kind === 'group' && selectedInvite.groupId) {
      return { label: 'group-id', value: selectedInvite.groupId }
    }
    if (selectedFile?.groupId) return { label: 'group-id', value: selectedFile.groupId }
    if (selectedNote?.groupId) return { label: 'group-id', value: selectedNote.groupId }
    return null
  }

  if (normalized === 'invite-id' || normalized === 'invite') {
    if (selectedInvite?.id) return { label: 'invite-id', value: selectedInvite.id }
    return null
  }

  if (normalized === 'relay' || normalized === 'relay-url') {
    if (selectedGroup?.relay) return { label: 'relay-url', value: selectedGroup.relay }
    if (selectedInvite?.kind === 'group' && selectedInvite.relay) {
      return { label: 'relay-url', value: selectedInvite.relay }
    }
    if (selectedRelay?.connectionUrl) return { label: 'relay-url', value: selectedRelay.connectionUrl }
    return null
  }

  if (normalized === 'relay-key') {
    if (selectedRelay?.relayKey) return { label: 'relay-key', value: selectedRelay.relayKey }
    return null
  }

  if (normalized === 'relay-identifier') {
    if (selectedRelay?.publicIdentifier) return { label: 'relay-identifier', value: selectedRelay.publicIdentifier }
    if (selectedRelay?.relayKey) return { label: 'relay-identifier', value: selectedRelay.relayKey }
    return null
  }

  if (normalized === 'event-id' || normalized === 'event') {
    if (selectedNote?.id) return { label: 'event-id', value: selectedNote.id }
    if (selectedFile?.eventId) return { label: 'event-id', value: selectedFile.eventId }
    return null
  }

  if (normalized === 'pubkey') {
    if (selectedNote?.pubkey) return { label: 'pubkey', value: selectedNote.pubkey }
    return null
  }

  if (normalized === 'conversation-id' || normalized === 'conversation') {
    if (selectedConversation?.id) return { label: 'conversation-id', value: selectedConversation.id }
    if (selectedInvite?.kind === 'chat' && selectedInvite.conversationId) {
      return { label: 'conversation-id', value: selectedInvite.conversationId }
    }
    return null
  }

  if (normalized === 'url') {
    if (selectedFile?.url) return { label: 'url', value: selectedFile.url }
    return null
  }

  if (normalized === 'sha256' || normalized === 'hash') {
    if (selectedFile?.sha256) return { label: 'sha256', value: selectedFile.sha256 }
    return null
  }

  return null
}

export function buildCommandSnippet(context?: CommandContext, workflow?: string): string | null {
  const selectedGroup = resolveSelectedGroup(context)
  const selectedInvite = resolveSelectedInvite(context)
  const selectedRelay = resolveSelectedRelay(context)
  const selectedFile = resolveSelectedFile(context)
  const selectedConversation = resolveSelectedConversation(context)
  const selectedNote = resolveSelectedNote(context)
  const selectedNode = context?.currentNode
  const normalizedWorkflow = String(workflow || '').trim().toLowerCase()

  const fromWorkflow = (): string | null => {
    if (!normalizedWorkflow) return null
    if ((normalizedWorkflow === 'join-flow' || normalizedWorkflow === 'group-join' || normalizedWorkflow === 'relay-join')
      && (selectedGroup?.id || (selectedInvite?.kind === 'group' ? selectedInvite.groupId : null))) {
      const groupId = selectedGroup?.id || (selectedInvite as SelectedGroupInviteRef).groupId
      return `relay join-flow ${groupId}`
    }
    if ((normalizedWorkflow === 'group-invite' || normalizedWorkflow === 'relay-invite' || normalizedWorkflow === 'invite') && selectedGroup?.id) {
      return `relay invite ${selectedGroup.id} <relayUrl> <inviteePubkey> [token]`
    }
    if ((normalizedWorkflow === 'group-invite-accept' || normalizedWorkflow === 'relay-invite-accept')
      && selectedInvite?.kind === 'group') {
      return `relay invite-accept ${selectedInvite.id}`
    }
    if ((normalizedWorkflow === 'group-invite-dismiss' || normalizedWorkflow === 'relay-invite-dismiss')
      && selectedInvite?.kind === 'group') {
      return `relay invite-dismiss ${selectedInvite.id}`
    }
    if ((normalizedWorkflow === 'group-update-members' || normalizedWorkflow === 'relay-update-members') && selectedGroup?.id) {
      return `relay update-members ${selectedGroup.id} add <pubkey>`
    }
    if ((normalizedWorkflow === 'group-update-auth' || normalizedWorkflow === 'relay-update-auth') && selectedGroup?.id) {
      return `relay update-auth ${selectedGroup.id} <pubkey> <token>`
    }
    if ((normalizedWorkflow === 'chat-accept' || normalizedWorkflow === 'accept')
      && selectedInvite?.kind === 'chat') {
      return `chat accept ${selectedInvite.id}`
    }
    if (normalizedWorkflow === 'chat-thread' && selectedConversation?.id) {
      return `chat thread ${selectedConversation.id}`
    }
    if (normalizedWorkflow === 'reply' && selectedNote?.id) {
      return `reply ${selectedNote.id} ${selectedNote.pubkey} <content>`
    }
    if ((normalizedWorkflow === 'relay-join' || normalizedWorkflow === 'join')
      && (selectedRelay?.publicIdentifier || selectedRelay?.relayKey)) {
      return `relay join ${selectedRelay?.publicIdentifier || selectedRelay?.relayKey}`
    }
    if (normalizedWorkflow === 'compose-start' && selectedGroup?.id) {
      return `compose start ${selectedGroup.id}`
    }
    if ((normalizedWorkflow === 'file-refresh' || normalizedWorkflow === 'file-download') && selectedFile?.groupId) {
      return `file refresh ${selectedFile.groupId}`
    }
    return null
  }

  const byWorkflow = fromWorkflow()
  if (byWorkflow) return byWorkflow

  if (selectedNode?.startsWith('groups')) {
    if (selectedInvite?.kind === 'group') return `relay invite-accept ${selectedInvite.id}`
    if (selectedGroup?.id) return `relay members ${selectedGroup.id}`
    return 'relay tab my'
  }
  if ((selectedNode === 'groups:my' || selectedNode === 'groups:browse') && selectedNote?.id) {
    return `reply ${selectedNote.id} ${selectedNote.pubkey} <content>`
  }
  if (selectedNode?.startsWith('files')) {
    if (selectedFile?.sha256) return `file download ${selectedFile.sha256}`
    if (selectedFile?.groupId) return `file filter group ${selectedFile.groupId}`
    return 'file search <query>'
  }
  if (selectedNode === 'invites:group') {
    if (selectedInvite?.kind === 'group') return `invites accept relay ${selectedInvite.id}`
    return 'invites refresh'
  }
  if (selectedNode === 'invites:chat') {
    if (selectedInvite?.kind === 'chat') return `invites accept chat ${selectedInvite.id}`
    return 'invites refresh'
  }
  if (selectedNode === 'chats') {
    if (selectedInvite?.kind === 'chat') return `chat accept ${selectedInvite.id}`
    if (selectedConversation?.id) return `chat thread ${selectedConversation.id}`
    return 'chat refresh'
  }
  if (selectedNode === 'accounts') {
    return 'account profiles'
  }

  return null
}

export async function executeCommand(
  controller: CommandController,
  input: string,
  context?: CommandContext
): Promise<CommandResult> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { message: 'Empty command' }
  }

  const args = tokenize(trimmed)
  const cmd = args[0]?.toLowerCase() || ''

  if (cmd === 'group') {
    const replacement = suggestRelayMigration(trimmed)
    throw new Error(`Command root "group" was removed. Use "${replacement}" instead.`)
  }

  if (cmd === 'help') {
    return {
      message: buildCommandHelpSummary()
    }
  }

  if (cmd === 'goto') {
    const node = parseNode(requireArg(args[1], 'node'))
    return {
      message: `Switched to ${displayNodeId(node)}`,
      gotoNode: node
    }
  }

  if (cmd === 'copy') {
    const rawField = args[1] || 'selected'
    const normalizedField = rawField.toLowerCase()
    if (isSensitiveField(normalizedField) && !context?.unsafeCopySecrets) {
      throw new Error('Copy for sensitive fields is blocked by default')
    }

    if (normalizedField === 'command') {
      const workflow = args[2]
      const snippet = buildCommandSnippet(context, workflow)
      if (!snippet) {
        throw new Error('No command snippet available for the current selection')
      }
      if (!context?.copy) {
        return { message: `Copy unavailable. Command: ${snippet}` }
      }
      const result = await context.copy(snippet)
      if (result.ok) {
        return { message: `Copied command via ${result.method}` }
      }
      return {
        message: `Copy unavailable (${result.error || result.method}). Command: ${shortValueForMessage(snippet)}`
      }
    }

    const copyValue = resolveCopyField(normalizedField, context)
    if (!copyValue) {
      throw new Error(`No value available for copy field "${rawField}"`)
    }

    if (!context?.copy) {
      return { message: `Copy unavailable. ${copyValue.label}: ${copyValue.value}` }
    }

    const result = await context.copy(copyValue.value)
    if (result.ok) {
      return { message: `Copied ${copyValue.label} via ${result.method}` }
    }
    return {
      message:
        `Copy unavailable (${result.error || result.method}). ${copyValue.label}: ` +
        shortValueForMessage(copyValue.value)
    }
  }

  if (cmd === 'account') {
    const action = requireArg(args[1], 'account action').toLowerCase()

    if (action === 'generate') {
      const label = args.slice(2).join(' ') || undefined
      const created = await controller.generateNsecAccount(label)
      await controller.unlockCurrentAccount()
      await controller.startWorker()
      return {
        message: `Generated profile ${created.label || created.pubkey} pubkey=${created.pubkey} nsec=${created.nsec}`,
        gotoNode: 'accounts'
      }
    }

    if (action === 'profiles' || action === 'list') {
      const profiles = await controller.listAccountProfiles()
      if (profiles.length === 0) {
        return { message: 'No profiles configured', gotoNode: 'accounts' }
      }

      const compact = profiles
        .map((profile, index) => {
          const marker = profile.isCurrent ? '*' : ''
          const label = profile.label || profile.pubkey.slice(0, 12)
          return `[${index}]${marker}${label}:${profile.signerType}`
        })
        .join(' ')

      if (compact.length > 165) {
        return {
          message: `Profiles loaded: ${profiles.length}. Use account login <index|pubkey|label> [password]`,
          gotoNode: 'accounts'
        }
      }

      return { message: `Profiles: ${compact}`, gotoNode: 'accounts' }
    }

    if (action === 'login' || action === 'auth') {
      const selector = requireArg(args[2], 'profile selector (index|pubkey|label)')
      const password = args[3]
      const profiles = await controller.listAccountProfiles()
      if (profiles.length === 0) {
        throw new Error('No profiles configured')
      }

      const selected = parseProfileSelector(selector, profiles)
      if (selected.signerType === 'ncryptsec' && !password) {
        throw new Error('Password required for ncryptsec profile: account login <selector> <password>')
      }

      await controller.selectAccount(selected.pubkey)
      await controller.unlockCurrentAccount(password ? async () => password : undefined)
      await controller.startWorker()

      return {
        message: `Authenticated profile ${selected.label || selected.pubkey}`,
        gotoNode: 'accounts'
      }
    }

    if (action === 'add-nsec') {
      const nsec = requireArg(args[2], 'nsec')
      const label = args.slice(3).join(' ') || undefined
      await controller.addNsecAccount(nsec, label)
      await controller.unlockCurrentAccount()
      await controller.startWorker()
      return { message: 'nsec account added and unlocked', gotoNode: 'accounts' }
    }

    if (action === 'add-ncryptsec') {
      const ncryptsec = requireArg(args[2], 'ncryptsec')
      const password = requireArg(args[3], 'password')
      const label = args.slice(4).join(' ') || undefined
      await controller.addNcryptsecAccount(ncryptsec, password, label)
      await controller.unlockCurrentAccount(async () => password)
      await controller.startWorker()
      return { message: 'ncryptsec account added and unlocked', gotoNode: 'accounts' }
    }

    if (action === 'select') {
      const selector = requireArg(args[2], 'profile selector (pubkey|index|label)')
      const profiles = await controller.listAccountProfiles()
      const selected = parseProfileSelector(selector, profiles)
      await controller.selectAccount(selected.pubkey)
      return { message: `Selected account ${selected.pubkey}`, gotoNode: 'accounts' }
    }

    if (action === 'unlock') {
      const password = args[2]
      await controller.unlockCurrentAccount(password ? async () => password : undefined)
      await controller.startWorker()
      return { message: 'Account unlocked and worker started', gotoNode: 'accounts' }
    }

    if (action === 'remove') {
      const pubkey = requireArg(args[2], 'pubkey')
      await controller.removeAccount(pubkey)
      return { message: `Removed account ${pubkey}`, gotoNode: 'accounts' }
    }

    if (action === 'clear') {
      await controller.clearSession()
      return { message: 'Session cleared', gotoNode: 'accounts' }
    }

    throw new Error(`Unknown account action: ${action}`)
  }

  if (cmd === 'worker') {
    const action = requireArg(args[1], 'worker action').toLowerCase()
    if (action === 'start') {
      await controller.startWorker()
      return { message: 'Worker started', gotoNode: 'dashboard' }
    }
    if (action === 'stop') {
      await controller.stopWorker()
      return { message: 'Worker stopped', gotoNode: 'dashboard' }
    }
    if (action === 'restart') {
      await controller.restartWorker()
      return { message: 'Worker restarted', gotoNode: 'dashboard' }
    }
    throw new Error(`Unknown worker action: ${action}`)
  }

  if (cmd === 'gateway') {
    const action = requireArg(args[1], 'gateway action').toLowerCase()
    if (action === 'refresh') {
      const gateways = await controller.refreshGatewayCatalog({ force: true })
      const state = controller.getState()
      return {
        message: `Gateway catalog refreshed (${state.authorizedGateways.length} approved, ${state.discoveredGateways.length} discovered)`
      }
    }
    if (action === 'list') {
      await controller.refreshGatewayCatalog({ force: args.includes('--refresh') })
      const state = controller.getState()
      const catalog = state.gatewayAccessCatalog || []
      if (!catalog.length) {
        return { message: 'No gateway access state available. Run `gateway refresh`.' }
      }
      const compact = catalog
        .map((entry: { gatewayId?: string | null; gatewayOrigin?: string | null; hostingState?: string; reason?: string | null }, index: number) => {
          const discovered = state.discoveredGateways.find((gateway) =>
            (entry.gatewayId && gateway.gatewayId === entry.gatewayId)
            || (entry.gatewayOrigin && gateway.publicUrl === entry.gatewayOrigin)
          )
          const label = discovered?.displayName ? `${discovered.displayName}` : (entry.gatewayId || entry.gatewayOrigin || 'gateway')
          const region = discovered?.region ? ` (${discovered.region})` : ''
          const reason = entry.reason ? ` reason=${entry.reason}` : ''
          return `[${index}] ${label}${region} state=${entry.hostingState || 'unknown'} id=${entry.gatewayId || '-'} origin=${entry.gatewayOrigin || discovered?.publicUrl || '-'}${reason}`
        })
        .join(' | ')
      return { message: `Gateway access: ${compact}` }
    }
    throw new Error(`Unknown gateway action: ${action}`)
  }

  if (cmd === 'relay') {
    const action = requireArg(args[1], 'relay action').toLowerCase()

    if (action === 'tab') {
      const tab = requireArg(args[2], 'tab').toLowerCase()
      if (tab === 'invites') {
        return { message: 'Relay invites live under Invites > Relay Invites', gotoNode: 'invites:group' }
      }
      if (tab === 'create') {
        return { message: 'Relay tab create', gotoNode: 'groups:create' }
      }
      const normalizedTab = tab === 'browse' ? 'discover' : tab
      if (!['discover', 'my'].includes(normalizedTab)) {
        throw new Error('Relay tab must be discover|browse|my|create|invites')
      }
      await controller.setGroupViewTab(normalizedTab as 'discover' | 'my')
      return {
        message: `Relay tab ${normalizedTab === 'discover' ? 'browse' : normalizedTab}`,
        gotoNode: normalizedTab === 'my' ? 'groups:my' : 'groups:browse'
      }
    }

    if (action === 'refresh') {
      await Promise.all([controller.refreshRelays(), controller.refreshGroups()])
      return { message: 'Relay state refreshed', gotoNode: 'groups:my' }
    }

    if (action === 'invites') {
      await controller.refreshInvites()
      return { message: 'Relay invites refreshed', gotoNode: 'invites:group' }
    }

    if (action === 'members') {
      const selectedGroup = resolveSelectedGroup(context)
      let groupId: string | undefined = args[2]
      if (!groupId) {
        groupId = selectedGroup?.id
      }
      groupId = requireArg(groupId, 'relay id')
      await controller.refreshGroupMembers(groupId, selectedGroup?.relay || undefined)
      return { message: `Relay members refreshed for ${groupId}`, gotoNode: 'groups:my' }
    }

    if (action === 'search') {
      const query = args[2] ? remainder(trimmed, `${args[0]} ${args[1]}`) : ''
      if (!query || query.toLowerCase() === 'clear') {
        await controller.setGroupSearch('')
        return { message: 'Relay search cleared', gotoNode: 'groups:browse' }
      }
      await controller.setGroupSearch(query)
      return { message: 'Relay search updated', gotoNode: 'groups:browse' }
    }

    if (action === 'sort') {
      const sortKey = requireArg(args[2], 'sort key') as
        | 'name'
        | 'description'
        | 'open'
        | 'public'
        | 'admin'
        | 'createdAt'
        | 'members'
        | 'peers'
      if (!['name', 'description', 'open', 'public', 'admin', 'createdAt', 'members', 'peers'].includes(sortKey)) {
        throw new Error('Relay sort key must be name|description|open|public|admin|createdAt|members|peers')
      }
      await controller.setGroupSort(sortKey, args[3])
      return {
        message: `Relay sort updated (${sortKey}${args[3] ? ` ${args[3]}` : ''})`,
        gotoNode: 'groups:browse'
      }
    }

    if (action === 'filter') {
      const target = requireArg(args[2], 'filter target').toLowerCase()
      const value = requireArg(args[3], 'filter value').toLowerCase()
      if (target === 'visibility') {
        if (!['all', 'public', 'private'].includes(value)) {
          throw new Error('Visibility filter must be all|public|private')
        }
        await controller.setGroupVisibilityFilter(value as 'all' | 'public' | 'private')
        return { message: `Relay visibility filter set (${value})`, gotoNode: 'groups:browse' }
      }
      if (target === 'join') {
        if (!['all', 'open', 'closed'].includes(value)) {
          throw new Error('Join filter must be all|open|closed')
        }
        await controller.setGroupJoinFilter(value as 'all' | 'open' | 'closed')
        return { message: `Relay join filter set (${value})`, gotoNode: 'groups:browse' }
      }
      throw new Error('Relay filter target must be visibility|join')
    }

    if (action === 'create') {
      const name = requireArg(args[2], 'name')
      let isPublic = args.includes('--public') || !args.includes('--private')
      let isOpen = args.includes('--open') || !args.includes('--closed')
      let fileSharing = args.includes('--file-sharing') ? true : args.includes('--no-file-sharing') ? false : true
      let description: string | undefined
      let gatewayOrigin: string | null = null
      let gatewayId: string | null = null
      let directJoinOnly = false
      let directJoinOnlyExplicit = false

      for (let index = 3; index < args.length; index += 1) {
        const token = args[index]
        if (!token.startsWith('--')) {
          throw new Error(`Unknown relay create option: ${token}`)
        }
        if (token === '--public') {
          isPublic = true
          continue
        }
        if (token === '--private') {
          isPublic = false
          continue
        }
        if (token === '--open') {
          isOpen = true
          continue
        }
        if (token === '--closed') {
          isOpen = false
          continue
        }
        if (token === '--file-sharing') {
          fileSharing = true
          continue
        }
        if (token === '--no-file-sharing') {
          fileSharing = false
          continue
        }
        if (token === '--direct-join-only') {
          directJoinOnly = true
          directJoinOnlyExplicit = true
          continue
        }
        if (token === '--gateway') {
          const normalized = normalizeGatewayId(requireArg(args[index + 1], 'gateway id'))
          if (!normalized) {
            throw new Error('Invalid --gateway (expected gateway id or gateway index from `gateway list`)')
          }
          gatewayId = normalized
          index += 1
          continue
        }
        if (token === '--gateway-origin') {
          const rawOrigin = requireArg(args[index + 1], 'gateway origin')
          const normalized = normalizeHttpOrigin(rawOrigin)
          if (!normalized) {
            throw new Error('Invalid --gateway-origin (expected http(s)://...)')
          }
          gatewayOrigin = normalized
          index += 1
          continue
        }
        if (token === '--gateway-id') {
          const normalized = normalizeGatewayId(requireArg(args[index + 1], 'gateway id'))
          if (!normalized) {
            throw new Error('Invalid --gateway-id')
          }
          gatewayId = normalized
          index += 1
          continue
        }
        if (token === '--desc') {
          const parts: string[] = []
          for (let partIndex = index + 1; partIndex < args.length; partIndex += 1) {
            const part = args[partIndex]
            if (part.startsWith('--')) break
            parts.push(part)
            index = partIndex
          }
          if (!parts.length) {
            throw new Error('Missing description text after --desc')
          }
          description = parts.join(' ')
          continue
        }
        throw new Error(`Unknown relay create option: ${token}`)
      }

      if (directJoinOnly && (gatewayOrigin || gatewayId)) {
        throw new Error('--direct-join-only cannot be combined with --gateway/--gateway-id/--gateway-origin')
      }
      if (!directJoinOnlyExplicit && !gatewayOrigin && !gatewayId) {
        directJoinOnly = true
      }

      await controller.createRelay({
        name,
        isPublic,
        isOpen,
        fileSharing,
        description,
        gatewayOrigin: directJoinOnly ? null : gatewayOrigin,
        gatewayId: directJoinOnly ? null : gatewayId,
        directJoinOnly
      })
      return { message: `Relay created: ${name}`, gotoNode: 'groups:my' }
    }

    if (action === 'join') {
      let identifier: string | undefined = args[2]
      const token = args[3]
      if (!identifier) {
        const selectedGroup = resolveSelectedGroup(context)
        const selectedRelay = resolveSelectedRelay(context)
        identifier = selectedGroup?.id || selectedRelay?.publicIdentifier || selectedRelay?.relayKey
      }
      identifier = requireArg(identifier, 'publicIdentifier or relayKey')

      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.joinRelay({
        relayKey: isRelayKey ? identifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : identifier,
        authToken: token
      })
      return { message: `Join relay requested for ${identifier}`, gotoNode: 'groups:my' }
    }

    if (action === 'disconnect') {
      let relayKey = args[2]
      if (!relayKey) {
        relayKey = resolveSelectedRelay(context)?.relayKey
      }
      relayKey = requireArg(relayKey, 'relayKey')
      await controller.disconnectRelay(relayKey)
      return { message: `Relay disconnected ${relayKey}`, gotoNode: 'groups:my' }
    }

    if (action === 'leave') {
      let identifier: string | undefined = args[2]
      if (!identifier) {
        const selectedGroup = resolveSelectedGroup(context)
        const selectedRelay = resolveSelectedRelay(context)
        identifier = selectedGroup?.id || selectedRelay?.publicIdentifier || selectedRelay?.relayKey
      }
      identifier = requireArg(identifier, 'publicIdentifier or relayKey')
      const saveRelaySnapshot = args.includes('--archive') ? true : args.includes('--no-archive') ? false : true
      const saveSharedFiles = args.includes('--save-files') ? true : args.includes('--drop-files') ? false : true
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.leaveGroup({
        relayKey: isRelayKey ? identifier.toLowerCase() : null,
        publicIdentifier: isRelayKey ? null : identifier,
        saveRelaySnapshot,
        saveSharedFiles
      })
      return { message: `Leave relay requested for ${identifier}`, gotoNode: 'groups:my' }
    }

    if (action === 'join-flow') {
      const selectedGroup = resolveSelectedGroup(context)
      const selectedGroupInvite = resolveSelectedInvite(context)
      const candidate = args[2] && !args[2].startsWith('--') ? args[2] : undefined
      let publicIdentifier: string | undefined
      let token: string | undefined
      let gatewayOrigin: string | null | undefined
      let gatewayId: string | null | undefined
      let directJoinOnly: boolean | undefined

      if (candidate && looksLikeGroupIdentifier(candidate)) {
        publicIdentifier = candidate
        token = args[3]
      } else {
        publicIdentifier = selectedGroup?.id
          || (selectedGroupInvite?.kind === 'group' ? selectedGroupInvite.groupId : undefined)
        if (candidate && !candidate.startsWith('--')) token = candidate
        if (selectedGroup?.id) {
          publicIdentifier = selectedGroup.id
          gatewayOrigin = selectedGroup.gatewayOrigin
          gatewayId = selectedGroup.gatewayId
          directJoinOnly = selectedGroup.directJoinOnly === true
        } else if (selectedGroupInvite?.kind === 'group') {
          publicIdentifier = selectedGroupInvite.groupId
          token = token || selectedGroupInvite.token || undefined
          gatewayOrigin = selectedGroupInvite.gatewayOrigin
          gatewayId = selectedGroupInvite.gatewayId
          directJoinOnly = selectedGroupInvite.directJoinOnly === true
        }
      }
      publicIdentifier = requireArg(publicIdentifier, 'publicIdentifier')
      await controller.startJoinFlow({
        publicIdentifier,
        token,
        openJoin: args.includes('--open'),
        gatewayOrigin,
        gatewayId,
        directJoinOnly
      })
      return { message: `Join flow started for ${publicIdentifier}`, gotoNode: 'groups:browse' }
    }

    if (action === 'request-invite') {
      const selectedGroup = resolveSelectedGroup(context)
      let groupId: string | undefined = args[2]
      let code: string | undefined
      let reason: string | undefined
      if (!groupId) {
        groupId = selectedGroup?.id
      } else if (!looksLikeGroupIdentifier(groupId) && selectedGroup?.id) {
        code = groupId
        groupId = selectedGroup.id
      } else {
        code = args[3]
      }
      groupId = requireArg(groupId, 'groupId')
      if (args.length >= 5) {
        reason = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]} ${args[3]}`)
      } else if (args.length >= 4 && !code) {
        reason = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
      }

      await controller.requestGroupInvite({
        groupId,
        relay: selectedGroup?.relay || null,
        code,
        reason
      })
      return { message: `Invite request submitted for ${groupId}`, gotoNode: 'groups:browse' }
    }

    if (action === 'invite') {
      let groupId = args[2]
      let relayUrl = args[3]
      let inviteePubkey = args[4]
      let token = args[5]

      if (!inviteePubkey) {
        const selectedGroup = resolveSelectedGroup(context)
        if (selectedGroup?.id) {
          groupId = selectedGroup.id
          relayUrl = selectedGroup.relay || resolveSelectedRelay(context)?.connectionUrl || relayUrl
          inviteePubkey = args[2]
          token = args[3]
        }
      }

      groupId = requireArg(groupId, 'groupId')
      relayUrl = requireArg(relayUrl, 'relayUrl')
      inviteePubkey = requireArg(inviteePubkey, 'inviteePubkey')

      await controller.sendInvite({
        groupId,
        relayUrl,
        inviteePubkey,
        token,
        payload: {
          groupName: groupId,
          isPublic: true,
          isOpen: !token,
          fileSharing: true
        }
      })
      return { message: `Relay invite sent to ${inviteePubkey}`, gotoNode: 'invites:group' }
    }

    if (action === 'invite-accept') {
      let inviteId = args[2] && !args[2].startsWith('--') ? args[2] : undefined
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'group') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.acceptGroupInvite(inviteId)
      return { message: `Relay invite accepted ${inviteId}`, gotoNode: 'invites:group' }
    }

    if (action === 'invite-dismiss') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'group') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.dismissGroupInvite(inviteId)
      return { message: `Relay invite dismissed ${inviteId}`, gotoNode: 'invites:group' }
    }

    if (action === 'join-requests') {
      let groupId: string | undefined = args[2]
      if (!groupId) {
        groupId = resolveSelectedGroup(context)?.id
      }
      groupId = requireArg(groupId, 'relay id')
      await controller.refreshJoinRequests(groupId, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Join requests refreshed for ${groupId}`, gotoNode: 'groups:my' }
    }

    if (action === 'approve') {
      let groupId: string | undefined = args[2]
      let pubkey: string | undefined = args[3]
      if (!pubkey) {
        groupId = resolveSelectedGroup(context)?.id
        pubkey = args[2]
      }
      groupId = requireArg(groupId, 'relay id')
      pubkey = requireArg(pubkey, 'pubkey')
      await controller.approveJoinRequest(groupId, pubkey, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Approved join request ${pubkey}`, gotoNode: 'groups:my' }
    }

    if (action === 'reject') {
      let groupId: string | undefined = args[2]
      let pubkey: string | undefined = args[3]
      if (!pubkey) {
        groupId = resolveSelectedGroup(context)?.id
        pubkey = args[2]
      }
      groupId = requireArg(groupId, 'relay id')
      pubkey = requireArg(pubkey, 'pubkey')
      await controller.rejectJoinRequest(groupId, pubkey, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Rejected join request ${pubkey}`, gotoNode: 'groups:my' }
    }

    if (action === 'update-members') {
      const selectedGroup = resolveSelectedGroup(context)
      let relayOrIdentifier = args[2]
      let op = args[3]
      let pubkey = args[4]

      if ((relayOrIdentifier === 'add' || relayOrIdentifier === 'remove') && selectedGroup?.id) {
        op = relayOrIdentifier
        pubkey = args[3]
        relayOrIdentifier = selectedGroup.id
      }

      relayOrIdentifier = requireArg(relayOrIdentifier, 'relayKey or publicIdentifier')
      op = requireArg(op, 'add/remove').toLowerCase()
      pubkey = requireArg(pubkey, 'member pubkey')
      const now = Date.now()
      const isRelayKey = /^[a-f0-9]{64}$/i.test(relayOrIdentifier)

      await controller.updateGroupMembers({
        relayKey: isRelayKey ? relayOrIdentifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : relayOrIdentifier,
        memberAdds: op === 'add' ? [{ pubkey, ts: now }] : undefined,
        memberRemoves: op === 'remove' ? [{ pubkey, ts: now }] : undefined
      })

      return { message: `Membership update sent (${op} ${pubkey})`, gotoNode: 'groups:my' }
    }

    if (action === 'update-auth') {
      const selectedGroup = resolveSelectedGroup(context)
      let relayOrIdentifier = args[2]
      let pubkey = args[3]
      let token = args[4]

      if (!token && selectedGroup?.id) {
        relayOrIdentifier = selectedGroup.id
        pubkey = args[2]
        token = args[3]
      }

      relayOrIdentifier = requireArg(relayOrIdentifier, 'relayKey or publicIdentifier')
      pubkey = requireArg(pubkey, 'pubkey')
      token = requireArg(token, 'token')
      const isRelayKey = /^[a-f0-9]{64}$/i.test(relayOrIdentifier)

      await controller.updateGroupAuth({
        relayKey: isRelayKey ? relayOrIdentifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : relayOrIdentifier,
        pubkey,
        token
      })

      return { message: `Auth token updated for ${pubkey}`, gotoNode: 'groups:my' }
    }

    throw new Error(`Unknown relay action: ${action}`)
  }

  if (cmd === 'invites') {
    const action = requireArg(args[1], 'invites action').toLowerCase()
    if (action === 'refresh') {
      await Promise.all([controller.refreshInvites(), controller.refreshChats()])
      return { message: 'Invites refreshed', gotoNode: 'invites:group' }
    }
    const target = requireArg(args[2], 'invite target').toLowerCase()
    const inviteId = args[3] && !args[3].startsWith('--') ? args[3] : undefined
    if (target === 'group') {
      const replacement = ['invites', action, 'relay', inviteId].filter(Boolean).join(' ')
      throw new Error(`Invite target "group" was removed. Use "${replacement}" instead.`)
    }

    const resolveRelayInviteId = () => {
      if (inviteId) return inviteId
      const selectedInvite = resolveSelectedInvite(context)
      if (selectedInvite?.kind === 'group') return selectedInvite.id
      return undefined
    }

    const resolveChatInviteId = () => {
      if (inviteId) return inviteId
      const selectedInvite = resolveSelectedInvite(context)
      if (selectedInvite?.kind === 'chat') return selectedInvite.id
      return undefined
    }

    if (action === 'accept') {
      if (target === 'relay') {
        const id = requireArg(resolveRelayInviteId(), 'inviteId')
        await controller.acceptGroupInvite(id)
        return { message: `Accepted relay invite ${id}`, gotoNode: 'invites:group' }
      }
      if (target === 'chat') {
        const id = requireArg(resolveChatInviteId(), 'inviteId')
        await controller.acceptChatInvite(id)
        return { message: `Accepted chat invite ${id}`, gotoNode: 'invites:chat' }
      }
      throw new Error('Invites accept target must be relay|chat')
    }

    if (action === 'dismiss') {
      if (target === 'relay') {
        const id = requireArg(resolveRelayInviteId(), 'inviteId')
        await controller.dismissGroupInvite(id)
        return { message: `Dismissed relay invite ${id}`, gotoNode: 'invites:group' }
      }
      if (target === 'chat') {
        const id = requireArg(resolveChatInviteId(), 'inviteId')
        await controller.dismissChatInvite(id)
        return { message: `Dismissed chat invite ${id}`, gotoNode: 'invites:chat' }
      }
      throw new Error('Invites dismiss target must be relay|chat')
    }

    throw new Error(`Unknown invites action: ${action}`)
  }

  if (cmd === 'file') {
    const action = requireArg(args[1], 'file action').toLowerCase()

    if (action === 'refresh') {
      let groupId: string | undefined = args[2]
      if (!groupId) {
        const selectedGroup = resolveSelectedGroup(context)
        const selectedInvite = resolveSelectedInvite(context)
        const selectedFile = resolveSelectedFile(context)
        groupId = selectedGroup?.id
          || (selectedInvite?.kind === 'group'
            ? selectedInvite.groupId
            : undefined)
          || selectedFile?.groupId
      }
      await controller.refreshGroupFiles(groupId)
      return { message: 'Files refreshed', gotoNode: 'files' }
    }

    if (action === 'upload') {
      let identifier: string | undefined = args[2]
      let filePath: string | undefined = args[3]
      if (!filePath && identifier) {
        filePath = identifier
        identifier = undefined
      }
      filePath = requireArg(filePath, 'filePath')
      if (!identifier) {
        identifier = resolveSelectedGroup(context)?.id || resolveSelectedFile(context)?.groupId
      }
      identifier = requireArg(identifier, 'publicIdentifier or relayKey')
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.uploadGroupFile({
        relayKey: isRelayKey ? identifier.toLowerCase() : null,
        publicIdentifier: isRelayKey ? null : identifier,
        filePath
      })
      return { message: `Uploaded file ${filePath}`, gotoNode: 'files' }
    }

    if (action === 'download') {
      let selector: string | undefined = args[2]
      const selectedFile = resolveSelectedFile(context)
      if (!selector) {
        selector = selectedFile?.sha256 || selectedFile?.eventId || undefined
      }
      selector = requireArg(selector, 'eventId or sha256')
      const fileHash = isHex64(selector)
        ? selector.toLowerCase()
        : requireArg(selectedFile?.sha256 || undefined, 'selected file sha256')
      await controller.downloadGroupFile({
        relayKey: selectedFile?.relay && isHex64(selectedFile.relay) ? selectedFile.relay.toLowerCase() : null,
        publicIdentifier: selectedFile?.groupId || null,
        groupId: selectedFile?.groupId || null,
        eventId: selectedFile?.eventId || null,
        fileHash,
        fileName: selectedFile?.fileName || null
      })
      return { message: `Downloaded ${fileHash}`, gotoNode: 'files' }
    }

    if (action === 'delete') {
      let selector: string | undefined = args[2]
      const selectedFile = resolveSelectedFile(context)
      if (!selector) {
        selector = selectedFile?.sha256 || selectedFile?.eventId || undefined
      }
      selector = requireArg(selector, 'eventId or sha256')
      const fileHash = isHex64(selector)
        ? selector.toLowerCase()
        : requireArg(selectedFile?.sha256 || undefined, 'selected file sha256')
      await controller.deleteLocalGroupFile({
        relayKey: selectedFile?.relay && isHex64(selectedFile.relay) ? selectedFile.relay.toLowerCase() : null,
        publicIdentifier: selectedFile?.groupId || null,
        groupId: selectedFile?.groupId || null,
        eventId: selectedFile?.eventId || null,
        fileHash
      })
      return { message: `Deleted local file ${fileHash}`, gotoNode: 'files' }
    }

    if (action === 'search') {
      const query = args[2] ? remainder(trimmed, `${args[0]} ${args[1]}`) : ''
      if (!query || query.toLowerCase() === 'clear') {
        await controller.setFileSearch('')
        return { message: 'File search cleared', gotoNode: 'files' }
      }
      await controller.setFileSearch(query)
      return { message: 'File search updated', gotoNode: 'files' }
    }

    if (action === 'sort') {
      const sortKey = requireArg(args[2], 'sort key') as
        | 'fileName'
        | 'group'
        | 'uploadedAt'
        | 'uploadedBy'
        | 'size'
        | 'mime'
      if (!['fileName', 'group', 'uploadedAt', 'uploadedBy', 'size', 'mime'].includes(sortKey)) {
        throw new Error('File sort key must be fileName|group|uploadedAt|uploadedBy|size|mime')
      }
      await controller.setFileSort(sortKey, args[3])
      return { message: `File sort updated (${sortKey}${args[3] ? ` ${args[3]}` : ''})`, gotoNode: 'files' }
    }

    if (action === 'filter') {
      const target = requireArg(args[2], 'filter target').toLowerCase()
      const value = requireArg(args[3], 'filter value')
      if (target === 'mime') {
        await controller.setFileMimeFilter(value.toLowerCase() === 'all' ? 'all' : value)
        return { message: `File mime filter set (${value})`, gotoNode: 'files' }
      }
      if (target === 'group') {
        await controller.setFileGroupFilter(value.toLowerCase() === 'all' ? 'all' : value)
        return { message: `File group filter set (${value})`, gotoNode: 'files' }
      }
      throw new Error('File filter target must be mime|group')
    }

    throw new Error(`Unknown file action: ${action}`)
  }

  if (cmd === 'compose') {
    const action = requireArg(args[1], 'compose action').toLowerCase()

    if (action === 'start') {
      let groupId: string | undefined = args[2]
      const relay = args[3]
      if (!groupId) {
        groupId = resolveSelectedGroup(context)?.id
          || (resolveSelectedInvite(context)?.kind === 'group'
            ? (resolveSelectedInvite(context) as SelectedGroupInviteRef).groupId
            : undefined)
      }
      groupId = requireArg(groupId, 'groupId')
      await controller.startComposeDraft(groupId, relay)
      return { message: `Compose draft started for ${groupId}`, gotoNode: 'groups:my' }
    }

    if (action === 'text') {
      const content = remainder(trimmed, `${args[0]} ${args[1]}`)
      await controller.updateComposeText(content)
      return { message: 'Compose draft text updated', gotoNode: 'groups:my' }
    }

    if (action === 'attach') {
      const filePath = requireArg(args[2], 'filePath')
      await controller.attachComposeFile(filePath)
      return { message: `Attached ${filePath}`, gotoNode: 'groups:my' }
    }

    if (action === 'remove') {
      const selector = requireArg(args[2], 'index|filePath')
      await controller.removeComposeAttachment(selector)
      return { message: `Removed attachment ${selector}`, gotoNode: 'groups:my' }
    }

    if (action === 'show') {
      const draft = controller.composeDraftSnapshot()
      if (!draft) {
        return { message: 'No compose draft in progress', gotoNode: 'groups:my' }
      }
      return {
        message: `Compose draft group=${draft.groupId} relay=${draft.relay || '-'} attachments=${draft.attachments.length} contentLen=${draft.content.length}`,
        gotoNode: 'groups:my'
      }
    }

    if (action === 'publish') {
      await controller.publishComposeDraft()
      return { message: 'Compose draft published', gotoNode: 'groups:my' }
    }

    if (action === 'cancel') {
      await controller.cancelComposeDraft()
      return { message: 'Compose draft canceled', gotoNode: 'groups:my' }
    }

    throw new Error(`Unknown compose action: ${action}`)
  }

  if (cmd === 'post') {
    const content = remainder(trimmed, 'post')
    if (!content) throw new Error('Post content required')
    await controller.publishPost(content)
    return { message: 'Post published', gotoNode: 'groups:my' }
  }

  if (cmd === 'reply') {
    let eventId: string | undefined = args[1]
    let pubkey: string | undefined = args[2]
    let content = ''
    const hasExplicitReplyTarget = Boolean(args[1] && args[2])

    if (!hasExplicitReplyTarget) {
      const selectedEvent = resolveSelectedNote(context)
      eventId = selectedEvent?.id
      pubkey = selectedEvent?.pubkey
      content = remainder(trimmed, 'reply')
    } else {
      content = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
    }

    eventId = requireArg(eventId, 'eventId')
    pubkey = requireArg(pubkey, 'event pubkey')
    if (!content) throw new Error('Reply content required')
    await controller.publishReply(content, eventId, pubkey)
    return { message: 'Reply published', gotoNode: 'groups:my' }
  }

  if (cmd === 'react') {
    let eventId: string | undefined = args[1]
    let pubkey: string | undefined = args[2]
    let reaction: string | undefined = args[3]
    if (args[1] && !args[2]) {
      const selectedEvent = resolveSelectedNote(context)
      if (selectedEvent && !isHex64(args[1])) {
        eventId = selectedEvent.id
        pubkey = selectedEvent.pubkey
        reaction = args[1]
      }
    }
    if (!eventId || !pubkey) {
      const selectedEvent = resolveSelectedNote(context)
      if (!eventId) eventId = selectedEvent?.id
      if (!pubkey) pubkey = selectedEvent?.pubkey
    }
    eventId = requireArg(eventId, 'eventId')
    pubkey = requireArg(pubkey, 'event pubkey')
    reaction = requireArg(reaction, 'reaction')
    await controller.publishReaction(eventId, pubkey, reaction)
    return { message: 'Reaction published', gotoNode: 'groups:my' }
  }

  if (cmd === 'chat') {
    const action = requireArg(args[1], 'chat action').toLowerCase()

    if (action === 'tab') {
      const tab = requireArg(args[2], 'tab').toLowerCase()
      if (!['conversations', 'invites'].includes(tab)) {
        throw new Error('Chat tab must be conversations|invites')
      }
      await controller.setChatViewTab(tab as 'conversations' | 'invites')
      return { message: `Chat tab ${tab}`, gotoNode: 'chats' }
    }

    if (action === 'init') {
      await controller.initChats()
      return { message: 'Chat init requested (background retry enabled)', gotoNode: 'chats' }
    }

    if (action === 'refresh') {
      await controller.refreshChats()
      return { message: 'Chats refreshed', gotoNode: 'chats' }
    }

    if (action === 'create') {
      const title = requireArg(args[2], 'title')
      const members = splitCsv(requireArg(args[3], 'members csv'))
      await controller.createConversation({
        title,
        members,
        description: args[4],
        relayMode: 'withFallback'
      })
      return { message: 'Conversation created', gotoNode: 'chats' }
    }

    if (action === 'invite') {
      const selectedConversation = resolveSelectedConversation(context)
      let conversationId: string | undefined = args[2]
      let membersCsv: string | undefined = args[3]

      if (!membersCsv) {
        if (selectedConversation?.id) {
          membersCsv = args[2]
          conversationId = selectedConversation.id
        }
      }

      conversationId = requireArg(conversationId, 'conversationId')
      membersCsv = requireArg(membersCsv, 'members csv')
      const members = splitCsv(membersCsv)
      const result = await controller.inviteChatMembers(conversationId, members)
      const failed = result.failed?.length || 0
      if (failed > 0) {
        return { message: `Invited ${result.invited.length} members, ${failed} failed`, gotoNode: 'chats' }
      }
      return { message: `Invited ${result.invited.length} members`, gotoNode: 'chats' }
    }

    if (action === 'accept') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'chat') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.acceptChatInvite(inviteId)
      return { message: `Invite accepted ${inviteId}`, gotoNode: 'invites:chat' }
    }

    if (action === 'dismiss') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'chat') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.dismissChatInvite(inviteId)
      return { message: `Invite dismissed ${inviteId}`, gotoNode: 'invites:chat' }
    }

    if (action === 'thread') {
      let conversationId: string | undefined = args[2]
      if (!conversationId) {
        conversationId = resolveSelectedConversation(context)?.id
      }
      conversationId = requireArg(conversationId, 'conversationId')
      await controller.loadChatThread(conversationId)
      return { message: `Thread loaded ${conversationId}`, gotoNode: 'chats' }
    }

    if (action === 'send') {
      let conversationId: string | undefined = args[2]
      let content: string

      if (args[3]) {
        content = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
      } else {
        const selectedConversation = resolveSelectedConversation(context)
        if (selectedConversation) {
          conversationId = selectedConversation.id
          content = remainder(trimmed, `${args[0]} ${args[1]}`)
        } else {
          content = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
        }
      }

      if (!conversationId) {
        conversationId = resolveSelectedConversation(context)?.id
      }
      conversationId = requireArg(conversationId, 'conversationId')
      if (!content) throw new Error('Message content required')
      await controller.sendChatMessage(conversationId, content)
      return { message: 'Message sent', gotoNode: 'chats' }
    }

    throw new Error(`Unknown chat action: ${action}`)
  }

  if (cmd === 'perf') {
    const action = requireArg(args[1], 'perf action').toLowerCase()
    if (action === 'overlay') {
      const enabled = normalizeBool(requireArg(args[2], 'on|off'))
      await controller.setPerfOverlay(enabled)
      return { message: `Perf overlay ${enabled ? 'enabled' : 'disabled'}` }
    }
    if (action === 'snapshot') {
      const snapshot = controller.perfSnapshot()
      return {
        message:
          `Perf inFlight=${snapshot.inFlight} queue=${snapshot.queueDepth} avg=${snapshot.avgLatencyMs.toFixed(1)}ms ` +
          `p95=${snapshot.p95LatencyMs.toFixed(1)}ms retries=${snapshot.retries} stale=${snapshot.staleResponseDrops}`
      }
    }
    throw new Error(`Unknown perf action: ${action}`)
  }

  if (cmd === 'refresh') {
    const target = args[1]?.toLowerCase()
    if (!target || target === 'all') {
      await Promise.all([
        controller.refreshRelays(),
        controller.refreshGroups(),
        controller.refreshInvites(),
        controller.refreshGroupFiles(),
        controller.refreshChats()
      ])
      return { message: 'All views refreshed' }
    }

    if (target === 'true' || target === 'false') {
      return { message: `Refresh expects view name, not boolean (${normalizeBool(target)})` }
    }

    return await executeCommand(controller, `${target} refresh`, context)
  }

  throw new Error(`Unknown command: ${cmd}`)
}
