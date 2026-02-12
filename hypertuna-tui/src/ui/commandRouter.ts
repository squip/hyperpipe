import type { SearchMode } from '../domain/types.js'
import type { ClipboardCopyResult } from '../runtime/clipboard.js'
import { SECTION_ORDER, type SectionId } from '../lib/constants.js'
import { normalizeBool, splitCsv } from '../lib/format.js'

export type CommandResult = {
  message: string
  gotoSection?: SectionId
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
}

type SelectedGroupInviteRef = {
  kind: 'group'
  id: string
  groupId: string
  relay?: string | null
  token?: string | null
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
  url?: string | null
  sha256?: string | null
}

type SelectedConversationRef = {
  id: string
}

type SelectedFeedEventRef = {
  id: string
  pubkey: string
}

export type CommandContext = {
  currentSection?: SectionId
  resolveSelectedGroup?: () => SelectedGroupRef | null
  resolveSelectedInvite?: () => SelectedInviteRef | null
  resolveSelectedRelay?: () => SelectedRelayRef | null
  resolveSelectedFile?: () => SelectedFileRef | null
  resolveSelectedConversation?: () => SelectedConversationRef | null
  resolveSelectedFeedEvent?: () => SelectedFeedEventRef | null
  copy?: (text: string) => Promise<ClipboardCopyResult>
  unsafeCopySecrets?: boolean
}

export interface CommandController {
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

  refreshRelays(): Promise<void>
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
    openJoin?: boolean
  }): Promise<void>
  acceptGroupInvite(inviteId: string): Promise<void>
  dismissGroupInvite(inviteId: string): Promise<void>

  refreshFeed(limit?: number): Promise<void>
  publishPost(content: string): Promise<unknown>
  publishReply(content: string, replyToEventId: string, replyToPubkey: string): Promise<unknown>
  publishReaction(eventId: string, eventPubkey: string, reaction: string): Promise<unknown>

  refreshBookmarks(): Promise<void>
  addBookmark(eventId: string): Promise<void>
  removeBookmark(eventId: string): Promise<void>

  refreshGroups(): Promise<void>
  refreshInvites(): Promise<void>
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

  refreshGroupFiles(groupId?: string): Promise<void>
  uploadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
  }): Promise<Record<string, unknown>>

  refreshStarterPacks(): Promise<void>
  createStarterPack(input: {
    dTag: string
    title: string
    description?: string
    image?: string
    pubkeys: string[]
  }): Promise<void>
  applyStarterPack(listId: string, authorPubkey?: string): Promise<void>

  initChats(): Promise<void>
  refreshChats(): Promise<void>
  createConversation(input: {
    title: string
    description?: string
    members: string[]
  }): Promise<void>
  acceptChatInvite(inviteId: string): Promise<void>
  dismissChatInvite(inviteId: string): Promise<void>
  setGroupViewTab(tab: 'discover' | 'my' | 'invites'): Promise<void>
  setChatViewTab(tab: 'conversations' | 'invites'): Promise<void>
  refreshJoinRequests(groupId: string, relay?: string): Promise<void>
  approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
  rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void>
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
  loadChatThread(conversationId: string): Promise<void>
  sendChatMessage(conversationId: string, content: string): Promise<void>

  search(mode: SearchMode, query: string): Promise<void>
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

function parseSection(input: string): SectionId {
  const normalized = input.trim().toLowerCase()
  const section = SECTION_ORDER.find((entry) => entry === normalized)
  if (!section) {
    throw new Error(`Unknown section: ${input}`)
  }
  return section
}

function isHex64(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function looksLikeGroupIdentifier(value: string): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized.includes(':')) return true
  if (normalized.includes("'")) return true
  if (normalized.startsWith('npub')) return true
  return isHex64(normalized)
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

export function resolveSelectedFeedEvent(context?: CommandContext): SelectedFeedEventRef | null {
  return context?.resolveSelectedFeedEvent?.() || null
}

function resolveCopyField(field: string, context?: CommandContext): { label: string; value: string } | null {
  const normalized = field.toLowerCase()
  const selectedGroup = resolveSelectedGroup(context)
  const selectedInvite = resolveSelectedInvite(context)
  const selectedRelay = resolveSelectedRelay(context)
  const selectedFile = resolveSelectedFile(context)
  const selectedConversation = resolveSelectedConversation(context)
  const selectedFeedEvent = resolveSelectedFeedEvent(context)

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
    if (selectedFeedEvent?.id) return { label: 'event-id', value: selectedFeedEvent.id }
    return null
  }

  if (normalized === 'group-id' || normalized === 'group') {
    if (selectedGroup?.id) return { label: 'group-id', value: selectedGroup.id }
    if (selectedInvite?.kind === 'group' && selectedInvite.groupId) {
      return { label: 'group-id', value: selectedInvite.groupId }
    }
    if (selectedFile?.groupId) return { label: 'group-id', value: selectedFile.groupId }
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
    if (selectedFeedEvent?.id) return { label: 'event-id', value: selectedFeedEvent.id }
    if (selectedFile?.eventId) return { label: 'event-id', value: selectedFile.eventId }
    return null
  }

  if (normalized === 'pubkey') {
    if (selectedFeedEvent?.pubkey) return { label: 'pubkey', value: selectedFeedEvent.pubkey }
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
  const selectedFeedEvent = resolveSelectedFeedEvent(context)
  const selectedSection = context?.currentSection
  const normalizedWorkflow = String(workflow || '').trim().toLowerCase()

  const fromWorkflow = (): string | null => {
    if (!normalizedWorkflow) return null
    if ((normalizedWorkflow === 'join-flow' || normalizedWorkflow === 'group-join')
      && (selectedGroup?.id || (selectedInvite?.kind === 'group' ? selectedInvite.groupId : null))) {
      const groupId = selectedGroup?.id || (selectedInvite as SelectedGroupInviteRef).groupId
      return `group join-flow ${groupId}`
    }
    if ((normalizedWorkflow === 'group-invite' || normalizedWorkflow === 'invite') && selectedGroup?.id) {
      return `group invite ${selectedGroup.id} <relayUrl> <inviteePubkey> [token]`
    }
    if (normalizedWorkflow === 'group-invite-accept' && selectedInvite?.kind === 'group') {
      return `group invite-accept ${selectedInvite.id}`
    }
    if (normalizedWorkflow === 'group-invite-dismiss' && selectedInvite?.kind === 'group') {
      return `group invite-dismiss ${selectedInvite.id}`
    }
    if (normalizedWorkflow === 'group-update-members' && selectedGroup?.id) {
      return `group update-members ${selectedGroup.id} add <pubkey>`
    }
    if (normalizedWorkflow === 'group-update-auth' && selectedGroup?.id) {
      return `group update-auth ${selectedGroup.id} <pubkey> <token>`
    }
    if ((normalizedWorkflow === 'chat-accept' || normalizedWorkflow === 'accept')
      && selectedInvite?.kind === 'chat') {
      return `chat accept ${selectedInvite.id}`
    }
    if (normalizedWorkflow === 'chat-thread' && selectedConversation?.id) {
      return `chat thread ${selectedConversation.id}`
    }
    if (normalizedWorkflow === 'reply' && selectedFeedEvent?.id) {
      return `reply ${selectedFeedEvent.id} ${selectedFeedEvent.pubkey} <content>`
    }
    if ((normalizedWorkflow === 'relay-join' || normalizedWorkflow === 'join')
      && (selectedRelay?.publicIdentifier || selectedRelay?.relayKey)) {
      return `relay join ${selectedRelay?.publicIdentifier || selectedRelay?.relayKey}`
    }
    if (normalizedWorkflow === 'file-refresh' && selectedFile?.groupId) {
      return `file refresh ${selectedFile.groupId}`
    }
    return null
  }

  const byWorkflow = fromWorkflow()
  if (byWorkflow) return byWorkflow

  if (selectedSection === 'groups') {
    if (selectedInvite?.kind === 'group') return `group invite-accept ${selectedInvite.id}`
    if (selectedGroup?.id) return `group join-flow ${selectedGroup.id}`
  }
  if (selectedSection === 'relays' && (selectedRelay?.publicIdentifier || selectedRelay?.relayKey)) {
    return `relay join ${selectedRelay?.publicIdentifier || selectedRelay?.relayKey}`
  }
  if (selectedSection === 'feed' && selectedFeedEvent?.id) {
    return `reply ${selectedFeedEvent.id} ${selectedFeedEvent.pubkey} <content>`
  }
  if (selectedSection === 'files' && selectedFile?.groupId) {
    return `file refresh ${selectedFile.groupId}`
  }
  if (selectedSection === 'chats') {
    if (selectedInvite?.kind === 'chat') return `chat accept ${selectedInvite.id}`
    if (selectedConversation?.id) return `chat thread ${selectedConversation.id}`
  }
  if (selectedSection === 'invites') {
    if (selectedInvite?.kind === 'group') return `invites accept group ${selectedInvite.id}`
    if (selectedInvite?.kind === 'chat') return `invites accept chat ${selectedInvite.id}`
    return 'invites refresh'
  }
  if (selectedSection === 'bookmarks') {
    return 'bookmark refresh'
  }
  if (selectedSection === 'search') {
    return 'search notes <query>'
  }
  if (selectedSection === 'accounts') {
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

  if (cmd === 'help') {
    return {
      message:
        'Commands: help | goto <section> | copy <field|selected|command> | account generate/profiles/login/add-nsec/add-ncryptsec/select/unlock/remove/clear | worker start/stop/restart | relay refresh/create/join/disconnect/leave | feed refresh | post/reply/react | bookmark refresh/add/remove | group tab/refresh/invites/join-flow/invite/invite-accept/invite-dismiss/join-requests/approve/reject/update-members/update-auth | invites accept/dismiss | file refresh/upload | list refresh/create/apply | chat tab/init/refresh/create/accept/dismiss/thread/send | perf overlay/snapshot | search <notes|profiles|groups|lists> <query>'
    }
  }

  if (cmd === 'goto') {
    const section = parseSection(requireArg(args[1], 'section'))
    return {
      message: `Switched to ${section}`,
      gotoSection: section
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
        gotoSection: 'accounts'
      }
    }

    if (action === 'profiles' || action === 'list') {
      const profiles = await controller.listAccountProfiles()
      if (profiles.length === 0) {
        return { message: 'No profiles configured', gotoSection: 'accounts' }
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
          gotoSection: 'accounts'
        }
      }

      return { message: `Profiles: ${compact}`, gotoSection: 'accounts' }
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
        gotoSection: 'accounts'
      }
    }

    if (action === 'add-nsec') {
      const nsec = requireArg(args[2], 'nsec')
      const label = args.slice(3).join(' ') || undefined
      await controller.addNsecAccount(nsec, label)
      await controller.unlockCurrentAccount()
      await controller.startWorker()
      return { message: 'nsec account added and unlocked', gotoSection: 'accounts' }
    }

    if (action === 'add-ncryptsec') {
      const ncryptsec = requireArg(args[2], 'ncryptsec')
      const password = requireArg(args[3], 'password')
      const label = args.slice(4).join(' ') || undefined
      await controller.addNcryptsecAccount(ncryptsec, password, label)
      await controller.unlockCurrentAccount(async () => password)
      await controller.startWorker()
      return { message: 'ncryptsec account added and unlocked', gotoSection: 'accounts' }
    }

    if (action === 'select') {
      const selector = requireArg(args[2], 'profile selector (pubkey|index|label)')
      const profiles = await controller.listAccountProfiles()
      const selected = parseProfileSelector(selector, profiles)
      await controller.selectAccount(selected.pubkey)
      return { message: `Selected account ${selected.pubkey}`, gotoSection: 'accounts' }
    }

    if (action === 'unlock') {
      const password = args[2]
      await controller.unlockCurrentAccount(password ? async () => password : undefined)
      await controller.startWorker()
      return { message: 'Account unlocked and worker started', gotoSection: 'accounts' }
    }

    if (action === 'remove') {
      const pubkey = requireArg(args[2], 'pubkey')
      await controller.removeAccount(pubkey)
      return { message: `Removed account ${pubkey}`, gotoSection: 'accounts' }
    }

    if (action === 'clear') {
      await controller.clearSession()
      return { message: 'Session cleared', gotoSection: 'accounts' }
    }

    throw new Error(`Unknown account action: ${action}`)
  }

  if (cmd === 'worker') {
    const action = requireArg(args[1], 'worker action').toLowerCase()
    if (action === 'start') {
      await controller.startWorker()
      return { message: 'Worker started', gotoSection: 'dashboard' }
    }
    if (action === 'stop') {
      await controller.stopWorker()
      return { message: 'Worker stopped', gotoSection: 'dashboard' }
    }
    if (action === 'restart') {
      await controller.restartWorker()
      return { message: 'Worker restarted', gotoSection: 'dashboard' }
    }
    throw new Error(`Unknown worker action: ${action}`)
  }

  if (cmd === 'relay') {
    const action = requireArg(args[1], 'relay action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshRelays()
      return { message: 'Relays refreshed', gotoSection: 'relays' }
    }

    if (action === 'create') {
      const name = requireArg(args[2], 'name')
      const isPublic = args.includes('--public') || !args.includes('--private')
      const isOpen = args.includes('--open') || !args.includes('--closed')
      const fileSharing = args.includes('--file-sharing') ? true : args.includes('--no-file-sharing') ? false : true
      await controller.createRelay({
        name,
        isPublic,
        isOpen,
        fileSharing,
        description: args.includes('--desc')
          ? args.slice(args.indexOf('--desc') + 1).join(' ')
          : undefined
      })
      return { message: `Relay created: ${name}`, gotoSection: 'relays' }
    }

    if (action === 'join') {
      let identifier: string | undefined = args[2]
      const token = args[3]
      if (!identifier) {
        const selectedRelay = resolveSelectedRelay(context)
        identifier = selectedRelay?.publicIdentifier || selectedRelay?.relayKey
      }
      identifier = requireArg(identifier, 'publicIdentifier or relayKey')

      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.joinRelay({
        relayKey: isRelayKey ? identifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : identifier,
        authToken: token
      })
      return { message: `Join relay requested for ${identifier}`, gotoSection: 'relays' }
    }

    if (action === 'disconnect') {
      const relayKey = requireArg(args[2], 'relayKey')
      await controller.disconnectRelay(relayKey)
      return { message: `Relay disconnected ${relayKey}`, gotoSection: 'relays' }
    }

    if (action === 'leave') {
      const identifier = requireArg(args[2], 'publicIdentifier or relayKey')
      const saveRelaySnapshot = args.includes('--archive') ? true : args.includes('--no-archive') ? false : true
      const saveSharedFiles = args.includes('--save-files') ? true : args.includes('--drop-files') ? false : true
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.leaveGroup({
        relayKey: isRelayKey ? identifier.toLowerCase() : null,
        publicIdentifier: isRelayKey ? null : identifier,
        saveRelaySnapshot,
        saveSharedFiles
      })
      return { message: `Leave group requested for ${identifier}`, gotoSection: 'relays' }
    }

    if (action === 'join-flow') {
      let publicIdentifier = args[2]
      const token = args[3]
      if (!publicIdentifier) {
        const selectedGroup = resolveSelectedGroup(context)
        const selectedGroupInvite = resolveSelectedInvite(context)
        if (selectedGroup?.id) {
          publicIdentifier = selectedGroup.id
        } else if (selectedGroupInvite?.kind === 'group') {
          publicIdentifier = selectedGroupInvite.groupId
        }
      }
      publicIdentifier = requireArg(publicIdentifier, 'publicIdentifier')
      await controller.startJoinFlow({
        publicIdentifier,
        token,
        openJoin: args.includes('--open')
      })
      return { message: `Join flow started for ${publicIdentifier}`, gotoSection: 'groups' }
    }

    throw new Error(`Unknown relay action: ${action}`)
  }

  if (cmd === 'feed') {
    const action = requireArg(args[1], 'feed action').toLowerCase()
    if (action === 'refresh') {
      const limit = args[2] ? Number(args[2]) : 120
      await controller.refreshFeed(Number.isFinite(limit) ? limit : 120)
      return { message: 'Feed refreshed', gotoSection: 'feed' }
    }
    throw new Error(`Unknown feed action: ${action}`)
  }

  if (cmd === 'post') {
    const content = remainder(trimmed, 'post')
    if (!content) throw new Error('Post content required')
    await controller.publishPost(content)
    return { message: 'Post published', gotoSection: 'feed' }
  }

  if (cmd === 'reply') {
    let eventId: string | undefined = args[1]
    let pubkey: string | undefined = args[2]
    let content = ''
    const hasExplicitReplyTarget = Boolean(args[1] && args[2])

    if (!hasExplicitReplyTarget) {
      const selectedEvent = resolveSelectedFeedEvent(context)
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
    return { message: 'Reply published', gotoSection: 'feed' }
  }

  if (cmd === 'react') {
    let eventId: string | undefined = args[1]
    let pubkey: string | undefined = args[2]
    let reaction: string | undefined = args[3]
    if (args[1] && !args[2]) {
      const selectedEvent = resolveSelectedFeedEvent(context)
      if (selectedEvent && !isHex64(args[1])) {
        eventId = selectedEvent.id
        pubkey = selectedEvent.pubkey
        reaction = args[1]
      }
    }
    if (!eventId || !pubkey) {
      const selectedEvent = resolveSelectedFeedEvent(context)
      if (!eventId) eventId = selectedEvent?.id
      if (!pubkey) pubkey = selectedEvent?.pubkey
    }
    eventId = requireArg(eventId, 'eventId')
    pubkey = requireArg(pubkey, 'event pubkey')
    reaction = requireArg(reaction, 'reaction')
    await controller.publishReaction(eventId, pubkey, reaction)
    return { message: 'Reaction published', gotoSection: 'feed' }
  }

  if (cmd === 'bookmark') {
    const action = requireArg(args[1], 'bookmark action').toLowerCase()
    if (action === 'refresh') {
      await controller.refreshBookmarks()
      return { message: 'Bookmarks refreshed', gotoSection: 'bookmarks' }
    }
    if (action === 'add') {
      let eventId: string | undefined = args[2]
      if (!eventId) {
        const selectedEvent = resolveSelectedFeedEvent(context)
        eventId = selectedEvent?.id
      }
      eventId = requireArg(eventId, 'eventId')
      await controller.addBookmark(eventId)
      return { message: 'Bookmark added', gotoSection: 'bookmarks' }
    }
    if (action === 'remove') {
      const eventId = requireArg(args[2], 'eventId')
      await controller.removeBookmark(eventId)
      return { message: 'Bookmark removed', gotoSection: 'bookmarks' }
    }
    throw new Error(`Unknown bookmark action: ${action}`)
  }

  if (cmd === 'group') {
    const action = requireArg(args[1], 'group action').toLowerCase()

    if (action === 'tab') {
      const tab = requireArg(args[2], 'tab').toLowerCase()
      if (!['discover', 'my', 'invites'].includes(tab)) {
        throw new Error('Group tab must be discover|my|invites')
      }
      await controller.setGroupViewTab(tab as 'discover' | 'my' | 'invites')
      return { message: `Group tab ${tab}`, gotoSection: 'groups' }
    }

    if (action === 'refresh') {
      await controller.refreshGroups()
      return { message: 'Groups refreshed', gotoSection: 'groups' }
    }

    if (action === 'invites') {
      await controller.refreshInvites()
      return { message: 'Invites refreshed', gotoSection: 'groups' }
    }

    if (action === 'join-flow') {
      const selectedGroup = resolveSelectedGroup(context)
      const selectedGroupInvite = resolveSelectedInvite(context)
      const candidate = args[2]
      let publicIdentifier: string | undefined
      let token: string | undefined

      if (candidate && looksLikeGroupIdentifier(candidate)) {
        publicIdentifier = candidate
        token = args[3]
      } else {
        publicIdentifier = selectedGroup?.id
          || (selectedGroupInvite?.kind === 'group' ? selectedGroupInvite.groupId : undefined)
        if (candidate && !candidate.startsWith('--')) token = candidate
      }

      publicIdentifier = requireArg(publicIdentifier, 'publicIdentifier')

      await controller.startJoinFlow({
        publicIdentifier,
        token,
        openJoin: args.includes('--open')
      })
      return { message: `Join flow started for ${publicIdentifier}`, gotoSection: 'groups' }
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
          fileSharing: true
        }
      })
      return { message: `Invite sent to ${inviteePubkey}`, gotoSection: 'groups' }
    }

    if (action === 'invite-accept' || action === 'accept-invite') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'group') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.acceptGroupInvite(inviteId)
      return { message: `Group invite accepted ${inviteId}`, gotoSection: 'groups' }
    }

    if (action === 'invite-dismiss' || action === 'dismiss-invite') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'group') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.dismissGroupInvite(inviteId)
      return { message: `Group invite dismissed ${inviteId}`, gotoSection: 'groups' }
    }

    if (action === 'join-requests') {
      let groupId: string | undefined = args[2]
      if (!groupId) {
        groupId = resolveSelectedGroup(context)?.id
      }
      groupId = requireArg(groupId, 'groupId')
      await controller.refreshJoinRequests(groupId, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Join requests refreshed for ${groupId}`, gotoSection: 'groups' }
    }

    if (action === 'approve') {
      let groupId: string | undefined = args[2]
      let pubkey: string | undefined = args[3]
      if (!pubkey) {
        groupId = resolveSelectedGroup(context)?.id
        pubkey = args[2]
      }
      groupId = requireArg(groupId, 'groupId')
      pubkey = requireArg(pubkey, 'pubkey')
      await controller.approveJoinRequest(groupId, pubkey, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Approved join request ${pubkey}`, gotoSection: 'groups' }
    }

    if (action === 'reject') {
      let groupId: string | undefined = args[2]
      let pubkey: string | undefined = args[3]
      if (!pubkey) {
        groupId = resolveSelectedGroup(context)?.id
        pubkey = args[2]
      }
      groupId = requireArg(groupId, 'groupId')
      pubkey = requireArg(pubkey, 'pubkey')
      await controller.rejectJoinRequest(groupId, pubkey, resolveSelectedGroup(context)?.relay || undefined)
      return { message: `Rejected join request ${pubkey}`, gotoSection: 'groups' }
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

      return { message: `Membership update sent (${op} ${pubkey})`, gotoSection: 'groups' }
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

      return { message: `Auth token updated for ${pubkey}`, gotoSection: 'groups' }
    }

    throw new Error(`Unknown group action: ${action}`)
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
      return { message: 'Files refreshed', gotoSection: 'files' }
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
      return { message: `Uploaded file ${filePath}`, gotoSection: 'files' }
    }

    throw new Error(`Unknown file action: ${action}`)
  }

  if (cmd === 'list') {
    const action = requireArg(args[1], 'list action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshStarterPacks()
      return { message: 'Lists refreshed', gotoSection: 'lists' }
    }

    if (action === 'create') {
      const dTag = requireArg(args[2], 'dTag')
      const title = requireArg(args[3], 'title')
      const pubkeys = splitCsv(requireArg(args[4], 'pubkeys csv'))
      await controller.createStarterPack({
        dTag,
        title,
        pubkeys,
        description: args[5]
      })
      return { message: `Starter pack ${dTag} published`, gotoSection: 'lists' }
    }

    if (action === 'apply') {
      const dTag = requireArg(args[2], 'dTag')
      const author = args[3]
      await controller.applyStarterPack(dTag, author)
      return { message: `Applied starter pack ${dTag}`, gotoSection: 'lists' }
    }

    throw new Error(`Unknown list action: ${action}`)
  }

  if (cmd === 'chat') {
    const action = requireArg(args[1], 'chat action').toLowerCase()

    if (action === 'tab') {
      const tab = requireArg(args[2], 'tab').toLowerCase()
      if (!['conversations', 'invites'].includes(tab)) {
        throw new Error('Chat tab must be conversations|invites')
      }
      await controller.setChatViewTab(tab as 'conversations' | 'invites')
      return { message: `Chat tab ${tab}`, gotoSection: 'chats' }
    }

    if (action === 'init') {
      await controller.initChats()
      return { message: 'Chat init requested (background retry enabled)', gotoSection: 'chats' }
    }

    if (action === 'refresh') {
      await controller.refreshChats()
      return { message: 'Chats refreshed', gotoSection: 'chats' }
    }

    if (action === 'create') {
      const title = requireArg(args[2], 'title')
      const members = splitCsv(requireArg(args[3], 'members csv'))
      await controller.createConversation({
        title,
        members,
        description: args[4]
      })
      return { message: 'Conversation created', gotoSection: 'chats' }
    }

    if (action === 'accept') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'chat') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.acceptChatInvite(inviteId)
      return { message: `Invite accepted ${inviteId}`, gotoSection: 'chats' }
    }

    if (action === 'dismiss') {
      let inviteId = args[2]
      if (!inviteId) {
        const selectedInvite = resolveSelectedInvite(context)
        if (selectedInvite?.kind === 'chat') inviteId = selectedInvite.id
      }
      inviteId = requireArg(inviteId, 'inviteId')
      await controller.dismissChatInvite(inviteId)
      return { message: `Invite dismissed ${inviteId}`, gotoSection: 'chats' }
    }

    if (action === 'thread') {
      let conversationId: string | undefined = args[2]
      if (!conversationId) {
        conversationId = resolveSelectedConversation(context)?.id
      }
      conversationId = requireArg(conversationId, 'conversationId')
      await controller.loadChatThread(conversationId)
      return { message: `Thread loaded ${conversationId}`, gotoSection: 'chats' }
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
      return { message: 'Message sent', gotoSection: 'chats' }
    }

    throw new Error(`Unknown chat action: ${action}`)
  }

  if (cmd === 'search') {
    const rawMode = requireArg(args[1], 'mode').toLowerCase()
    const mode = rawMode as SearchMode
    if (!['notes', 'profiles', 'groups', 'lists'].includes(mode)) {
      throw new Error('Search mode must be notes|profiles|groups|lists')
    }

    const query = remainder(trimmed, `${args[0]} ${args[1]}`)
    if (!query) throw new Error('Search query required')

    await controller.search(mode, query)
    return { message: `Search complete (${mode})`, gotoSection: 'search' }
  }

  if (cmd === 'invites') {
    const action = requireArg(args[1], 'invites action').toLowerCase()
    if (action === 'refresh') {
      await Promise.all([controller.refreshInvites(), controller.refreshChats()])
      return { message: 'Invites refreshed', gotoSection: 'invites' }
    }
    const target = requireArg(args[2], 'invite target').toLowerCase()
    const inviteId = args[3]

    const resolveGroupInviteId = () => {
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
      if (target === 'group') {
        const id = requireArg(resolveGroupInviteId(), 'inviteId')
        await controller.acceptGroupInvite(id)
        return { message: `Accepted group invite ${id}`, gotoSection: 'invites' }
      }
      if (target === 'chat') {
        const id = requireArg(resolveChatInviteId(), 'inviteId')
        await controller.acceptChatInvite(id)
        return { message: `Accepted chat invite ${id}`, gotoSection: 'invites' }
      }
      throw new Error('Invites accept target must be group|chat')
    }

    if (action === 'dismiss') {
      if (target === 'group') {
        const id = requireArg(resolveGroupInviteId(), 'inviteId')
        await controller.dismissGroupInvite(id)
        return { message: `Dismissed group invite ${id}`, gotoSection: 'invites' }
      }
      if (target === 'chat') {
        const id = requireArg(resolveChatInviteId(), 'inviteId')
        await controller.dismissChatInvite(id)
        return { message: `Dismissed chat invite ${id}`, gotoSection: 'invites' }
      }
      throw new Error('Invites dismiss target must be group|chat')
    }

    throw new Error(`Unknown invites action: ${action}`)
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
        controller.refreshFeed(),
        controller.refreshGroups(),
        controller.refreshInvites(),
        controller.refreshGroupFiles(),
        controller.refreshStarterPacks(),
        controller.refreshBookmarks(),
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
