import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from './NostrProvider'
import { electronIpc } from '@/services/electron-ipc.service'
import type {
  ConversationInvite,
  ConversationQuery,
  ConversationSummary,
  CreateConversationInput,
  MessageAttachment,
  MessengerEvent,
  ReadState,
  SendMessageOptions,
  ThreadMessage,
  UpdateConversationMetadataInput
} from '@/lib/conversations/types'

type MarmotSendStatus = {
  conversationId: string
  clientMessageId: string
  messageId?: string
  status: 'sending' | 'sent' | 'failed'
  error?: string
}

type LoadThreadResult = {
  conversationId: string
  messages: ThreadMessage[]
  readState: ReadState
  unreadCount: number
}

type InviteFailure = {
  pubkey: string
  error: string
}

type CreateConversationResult = {
  conversation: ConversationSummary
  invited: string[]
  failed: InviteFailure[]
}

type MarmotMessenger = {
  on: (cb: (event: MessengerEvent) => void) => () => void
  off: (cb: (event: MessengerEvent) => void) => void
  syncRecent: (conversationId?: string) => Promise<number>
  getConversationMessages: (conversationId: string, limit?: number) => Promise<ThreadMessage[]>
  loadThread: (
    conversationId: string,
    options?: {
      limit?: number
      beforeTimestamp?: number
      afterTimestamp?: number
      sync?: boolean
    }
  ) => Promise<LoadThreadResult>
  sendMessage: (
    conversationId: string,
    content: string,
    opts?: SendMessageOptions
  ) => Promise<ThreadMessage[]>
  sendMediaMessage: (
    conversationId: string,
    content: string,
    attachments: MessageAttachment[],
    opts?: SendMessageOptions
  ) => Promise<ThreadMessage[]>
  markConversationRead: (
    conversationId: string,
    lastReadMessageId?: string,
    lastReadAt?: number
  ) => Promise<void>
}

type MessengerContextType = {
  messenger: MarmotMessenger | null
  conversations: ConversationSummary[]
  invites: ConversationInvite[]
  pendingInviteCount: number
  ready: boolean
  unsupportedReason?: string
  createConversation: (input: CreateConversationInput) => Promise<CreateConversationResult>
  inviteMembers: (conversationId: string, members: string[]) => Promise<void>
  grantConversationAdmin: (conversationId: string, targetPubkey: string) => Promise<void>
  acceptInvite: (inviteId: string) => Promise<{ conversationId: string | null }>
  refreshConversations: (query?: ConversationQuery) => Promise<ConversationSummary[]>
  refreshInvites: (query?: ConversationQuery) => Promise<ConversationInvite[]>
  updateConversationMetadata: (input: UpdateConversationMetadataInput) => Promise<void>
  dismissInvite: (inviteId: string) => void
  markInviteAccepted: (inviteId: string, conversationId?: string | null) => void
  getInviteById: (inviteId: string) => ConversationInvite | null
  drainBufferedMessages: (conversationId: string) => ThreadMessage[]
}

const MessengerContext = createContext<MessengerContextType | undefined>(undefined)

const debug = (...args: any[]) => console.debug('[MarmotProvider]', ...args)

const readStateStorageKey = (pubkey: string | null | undefined) => `marmotReadState:${pubkey || 'anon'}`
const inviteDismissedStorageKey = (pubkey: string | null | undefined) => `marmotInviteDismissed:${pubkey || 'anon'}`
const inviteAcceptedStorageKey = (pubkey: string | null | undefined) => `marmotInviteAccepted:${pubkey || 'anon'}`
const inviteAcceptedConversationStorageKey = (pubkey: string | null | undefined) => `marmotInviteAcceptedConversation:${pubkey || 'anon'}`

function normalizeRelayUrl(relay: string): string | null {
  if (typeof relay !== 'string') return null
  const trimmed = relay.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null

    const pathname = parsed.pathname.replace(/\/+/g, '/')
    parsed.pathname = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname
    if ((parsed.protocol === 'ws:' && parsed.port === '80') || (parsed.protocol === 'wss:' && parsed.port === '443')) {
      parsed.port = ''
    }
    parsed.searchParams.sort()
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function normalizeRelayUrls(relayList: { read: string[]; write: string[] } | null, discoveryRelay?: string) {
  const relays = [
    ...(relayList?.read || []),
    ...(relayList?.write || []),
    discoveryRelay || ''
  ]
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const relay of relays) {
    const candidate = normalizeRelayUrl(relay)
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    normalized.push(candidate)
  }
  return normalized.sort((left, right) => left.localeCompare(right))
}

function mergeMessages(existing: ThreadMessage[], incoming: ThreadMessage[]) {
  const map = new Map(existing.map((message) => [message.id, message]))
  for (const message of incoming) {
    map.set(message.id, message)
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.id.localeCompare(b.id)
  })
}

function normalizePubkeyList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter((value) => Boolean(value))
    )
  )
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function parseConversations(payload: any): ConversationSummary[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((row) => row && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      protocol: 'marmot' as const,
      participants: Array.isArray(row.participants) ? row.participants : [],
      adminPubkeys: normalizePubkeyList(row.adminPubkeys),
      canInviteMembers: Boolean(row.canInviteMembers),
      title: typeof row.title === 'string' && row.title ? row.title : 'Conversation',
      description: typeof row.description === 'string' ? row.description : null,
      imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null,
      unreadCount: Number.isFinite(row.unreadCount) ? Number(row.unreadCount) : 0,
      lastMessageAt: Number.isFinite(row.lastMessageAt) ? Number(row.lastMessageAt) : 0,
      lastMessageId: typeof row.lastMessageId === 'string' ? row.lastMessageId : null,
      lastMessageSenderPubkey:
        typeof row.lastMessageSenderPubkey === 'string' ? row.lastMessageSenderPubkey : null,
      lastMessagePreview:
        typeof row.lastMessagePreview === 'string' ? row.lastMessagePreview : null,
      lastReadAt: Number.isFinite(row.lastReadAt) ? Number(row.lastReadAt) : 0,
      lastReadMessageId:
        typeof row.lastReadMessageId === 'string' ? row.lastReadMessageId : null,
      relayCount: Number.isFinite(row.relayCount) ? Number(row.relayCount) : 0,
      updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : undefined
    }))
}

function parseInvites(payload: any): ConversationInvite[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((row) => row && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      protocol: 'marmot' as const,
      senderPubkey: typeof row.senderPubkey === 'string' ? row.senderPubkey : '',
      createdAt: Number.isFinite(row.createdAt) ? Number(row.createdAt) : 0,
      receivedAt: Number.isFinite(row.receivedAt) ? Number(row.receivedAt) : 0,
      status: ['pending', 'joining', 'joined', 'failed'].includes(row.status)
        ? row.status
        : 'pending',
      error: typeof row.error === 'string' ? row.error : null,
      keyPackageEventId: typeof row.keyPackageEventId === 'string' ? row.keyPackageEventId : null,
      relays: Array.isArray(row.relays) ? row.relays : [],
      conversationId: typeof row.conversationId === 'string' ? row.conversationId : null,
      title: typeof row.title === 'string' ? row.title : null,
      description: typeof row.description === 'string' ? row.description : null,
      imageUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null,
      memberPubkeys: Array.isArray(row.memberPubkeys)
        ? row.memberPubkeys
            .map((value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
            .filter((value: string) => Boolean(value))
        : []
    }))
}

function parseMessages(payload: any): ThreadMessage[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((row) => row && typeof row === 'object' && typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      conversationId: typeof row.conversationId === 'string' ? row.conversationId : '',
      senderPubkey: typeof row.senderPubkey === 'string' ? row.senderPubkey : '',
      content: typeof row.content === 'string' ? row.content : '',
      timestamp: Number.isFinite(row.timestamp) ? Number(row.timestamp) : 0,
      type: ['text', 'media', 'reaction', 'system'].includes(row.type) ? row.type : 'text',
      replyTo: typeof row.replyTo === 'string' ? row.replyTo : null,
	      attachments: Array.isArray(row.attachments)
	        ? row.attachments
	            .filter((attachment: unknown): attachment is Record<string, unknown> => (
	              !!attachment && typeof attachment === 'object'
	            ))
	            .map((attachment: Record<string, unknown>) => {
	              const rawUrl = typeof attachment.url === 'string' ? attachment.url : ''
	              const rawGatewayUrl = typeof attachment.gatewayUrl === 'string' ? attachment.gatewayUrl : ''
	              return {
	                url: rawUrl || rawGatewayUrl,
	                gatewayUrl: rawGatewayUrl || null,
	              mime: typeof attachment.mime === 'string' ? attachment.mime : null,
	              size: Number.isFinite(attachment.size) ? Number(attachment.size) : null,
	              width: Number.isFinite(attachment.width) ? Number(attachment.width) : null,
	              height: Number.isFinite(attachment.height) ? Number(attachment.height) : null,
	              blurhash: typeof attachment.blurhash === 'string' ? attachment.blurhash : null,
	              fileName: typeof attachment.fileName === 'string' ? attachment.fileName : null,
	              sha256: typeof attachment.sha256 === 'string' ? attachment.sha256 : null,
	              driveKey: typeof attachment.driveKey === 'string' ? attachment.driveKey : null,
	              ownerPubkey: typeof attachment.ownerPubkey === 'string' ? attachment.ownerPubkey : null,
	              fileId: typeof attachment.fileId === 'string' ? attachment.fileId : null
	              }
	            })
	            .filter((attachment: { url: string; gatewayUrl: string | null }) => (
              Boolean(attachment.url || attachment.gatewayUrl)
            ))
        : [],
      tags: Array.isArray(row.tags)
        ? row.tags
            .filter((tag: unknown): tag is unknown[] => Array.isArray(tag))
            .map((tag: unknown[]) => tag.map((item: unknown) => String(item ?? '')))
        : [],
      protocol: 'marmot'
    }))
}

function parseReadState(payload: any, conversationId: string): ReadState {
  const source = payload && typeof payload === 'object' ? payload : {}
  return {
    conversationId,
    lastReadMessageId:
      typeof source.lastReadMessageId === 'string' ? source.lastReadMessageId : null,
    lastReadAt: Number.isFinite(source.lastReadAt) ? Number(source.lastReadAt) : 0,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now() / 1000
  }
}

function readInviteCache(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map((entry) => String(entry || '').trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

export function useMessenger() {
  const ctx = useContext(MessengerContext)
  if (!ctx) throw new Error('useMessenger must be used within MessengerProvider')
  return ctx
}

export function MessengerProvider({ children }: { children: React.ReactNode }) {
  const { pubkey, relayList, isReady } = useNostr()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [invites, setInvites] = useState<ConversationInvite[]>([])
  const [dismissedInviteIds, setDismissedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteIds, setAcceptedInviteIds] = useState<Set<string>>(new Set())
  const [acceptedInviteConversationIds, setAcceptedInviteConversationIds] = useState<Set<string>>(new Set())
  const [unsupportedReason, setUnsupportedReason] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(false)

  const listenersRef = useRef<Set<(event: MessengerEvent) => void>>(new Set())
  const bufferedMessagesRef = useRef<Map<string, ThreadMessage[]>>(new Map())
  const messageCacheRef = useRef<Map<string, ThreadMessage[]>>(new Map())
  const readStateRef = useRef<Map<string, ReadState>>(new Map())
  const recentInitRef = useRef<{ signature: string; at: number } | null>(null)
  const initInFlightSignatureRef = useRef<string | null>(null)
  const dismissedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteIdsRef = useRef<Set<string>>(new Set())
  const acceptedInviteConversationIdsRef = useRef<Set<string>>(new Set())

  const discoveryRelay = import.meta.env.VITE_DISCOVERY_RELAY as string | undefined
  const relayUrls = useMemo(
    () => normalizeRelayUrls(relayList, discoveryRelay),
    [relayList, discoveryRelay]
  )

  const relaySignature = useMemo(() => relayUrls.slice().sort().join('|'), [relayUrls])

  const emitEvent = (event: MessengerEvent) => {
    if (event.type === 'message') {
      const list = bufferedMessagesRef.current.get(event.message.conversationId) || []
      list.push(event.message)
      bufferedMessagesRef.current.set(event.message.conversationId, list.slice(-50))
    }

    for (const listener of listenersRef.current) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[MarmotProvider] listener failed', error)
      }
    }
  }

  const saveReadStateToStorage = (stateMap: Map<string, ReadState>) => {
    if (typeof window === 'undefined') return
    try {
      const key = readStateStorageKey(pubkey)
      const payload = Object.fromEntries(stateMap)
      window.localStorage.setItem(key, JSON.stringify(payload))
    } catch {
      // ignore storage errors
    }
  }

  const loadReadStateFromStorage = () => {
    if (typeof window === 'undefined') return new Map<string, ReadState>()
    try {
      const key = readStateStorageKey(pubkey)
      const raw = window.localStorage.getItem(key)
      if (!raw) return new Map<string, ReadState>()
      const parsed = JSON.parse(raw)
      const map = new Map<string, ReadState>()
      Object.entries(parsed || {}).forEach(([conversationId, value]) => {
        map.set(conversationId, parseReadState(value, conversationId))
      })
      return map
    } catch {
      return new Map<string, ReadState>()
    }
  }

  useEffect(() => {
    if (!pubkey || typeof window === 'undefined') {
      const empty = new Set<string>()
      setDismissedInviteIds(empty)
      dismissedInviteIdsRef.current = empty
      setAcceptedInviteIds(empty)
      acceptedInviteIdsRef.current = empty
      setAcceptedInviteConversationIds(empty)
      acceptedInviteConversationIdsRef.current = empty
      return
    }

    const dismissed = readInviteCache(inviteDismissedStorageKey(pubkey))
    const accepted = readInviteCache(inviteAcceptedStorageKey(pubkey))
    const acceptedConversations = readInviteCache(inviteAcceptedConversationStorageKey(pubkey))

    setDismissedInviteIds(dismissed)
    dismissedInviteIdsRef.current = dismissed
    setAcceptedInviteIds(accepted)
    acceptedInviteIdsRef.current = accepted
    setAcceptedInviteConversationIds(acceptedConversations)
    acceptedInviteConversationIdsRef.current = acceptedConversations
  }, [pubkey])

  useEffect(() => {
    dismissedInviteIdsRef.current = dismissedInviteIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        inviteDismissedStorageKey(pubkey),
        JSON.stringify(Array.from(dismissedInviteIds))
      )
    } catch {
      // best effort
    }
  }, [dismissedInviteIds, pubkey])

  useEffect(() => {
    acceptedInviteIdsRef.current = acceptedInviteIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        inviteAcceptedStorageKey(pubkey),
        JSON.stringify(Array.from(acceptedInviteIds))
      )
    } catch {
      // best effort
    }
  }, [acceptedInviteIds, pubkey])

  useEffect(() => {
    acceptedInviteConversationIdsRef.current = acceptedInviteConversationIds
    if (!pubkey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        inviteAcceptedConversationStorageKey(pubkey),
        JSON.stringify(Array.from(acceptedInviteConversationIds))
      )
    } catch {
      // best effort
    }
  }, [acceptedInviteConversationIds, pubkey])

  const sendToWorkerAwait = async (message: Record<string, unknown>, timeoutMs = 30_000) => {
    const response = await electronIpc.sendToWorkerAwait({ message, timeoutMs })
    if (!response?.success) {
      throw new Error(response?.error || 'Worker request failed')
    }
    return response.data || {}
  }

  const applyConversationUpdate = (conversation: ConversationSummary) => {
    setConversations((previous) => {
      const existing = previous.find((item) => item.id === conversation.id)
      if (
        existing
        && existing.lastMessageAt === conversation.lastMessageAt
        && existing.lastMessageSenderPubkey === conversation.lastMessageSenderPubkey
        && existing.unreadCount === conversation.unreadCount
        && existing.lastReadAt === conversation.lastReadAt
        && existing.lastReadMessageId === conversation.lastReadMessageId
        && existing.canInviteMembers === conversation.canInviteMembers
        && sameStringSet(existing.adminPubkeys || [], conversation.adminPubkeys || [])
        && existing.title === conversation.title
        && existing.description === conversation.description
        && existing.imageUrl === conversation.imageUrl
      ) {
        return previous
      }

      const next = [...previous.filter((item) => item.id !== conversation.id), conversation]
      next.sort((left, right) => {
        if (left.lastMessageAt !== right.lastMessageAt) {
          return right.lastMessageAt - left.lastMessageAt
        }
        return left.id.localeCompare(right.id)
      })
      return next
    })
  }

  const isInviteActionable = useCallback((invite: ConversationInvite | null | undefined) => {
    if (!invite || !invite.id) return false
    if (dismissedInviteIdsRef.current.has(invite.id)) return false
    if (acceptedInviteIdsRef.current.has(invite.id)) return false
    if (
      invite.conversationId
      && acceptedInviteConversationIdsRef.current.has(invite.conversationId)
    ) {
      return false
    }
    if (invite.status === 'joined') return false
    return true
  }, [])

  const sortInvites = useCallback((rows: ConversationInvite[]) => {
    return [...rows].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
      return left.id.localeCompare(right.id)
    })
  }, [])

  const filterActionableInvites = useCallback((rows: ConversationInvite[]) => {
    return sortInvites(rows.filter((invite) => isInviteActionable(invite)))
  }, [isInviteActionable, sortInvites])

  const dismissInvite = useCallback((inviteId: string) => {
    const normalizedInviteId = String(inviteId || '').trim()
    if (!normalizedInviteId) return
    setDismissedInviteIds((previous) => {
      if (previous.has(normalizedInviteId)) return previous
      const next = new Set(previous)
      next.add(normalizedInviteId)
      return next
    })
    setInvites((previous) => previous.filter((invite) => invite.id !== normalizedInviteId))
  }, [])

  const markInviteAccepted = useCallback((inviteId: string, conversationId?: string | null) => {
    const normalizedInviteId = String(inviteId || '').trim()
    const normalizedConversationId = String(conversationId || '').trim()

    if (normalizedInviteId) {
      setAcceptedInviteIds((previous) => {
        if (previous.has(normalizedInviteId)) return previous
        const next = new Set(previous)
        next.add(normalizedInviteId)
        return next
      })
    }

    if (normalizedConversationId) {
      setAcceptedInviteConversationIds((previous) => {
        if (previous.has(normalizedConversationId)) return previous
        const next = new Set(previous)
        next.add(normalizedConversationId)
        return next
      })
    }

    setInvites((previous) =>
      previous.filter((invite) => {
        if (normalizedInviteId && invite.id === normalizedInviteId) return false
        if (normalizedConversationId && invite.conversationId === normalizedConversationId) return false
        if (invite.status === 'joined') return false
        return true
      })
    )
  }, [])

  const getInviteById = useCallback((inviteId: string) => {
    const normalizedInviteId = String(inviteId || '').trim()
    if (!normalizedInviteId) return null
    return invites.find((invite) => invite.id === normalizedInviteId) || null
  }, [invites])

  const pendingInviteCount = invites.length

  useEffect(() => {
    setInvites((previous) => filterActionableInvites(previous))
  }, [dismissedInviteIds, acceptedInviteIds, acceptedInviteConversationIds, filterActionableInvites])

  const refreshConversations = async (query: ConversationQuery = {}) => {
    if (!electronIpc.isElectron()) return []
    const data = await sendToWorkerAwait({
      type: 'marmot-list-conversations',
      data: {
        search: query.search || ''
      }
    })
    const parsed = parseConversations(data?.conversations || [])
    setConversations(parsed)
    return parsed
  }

  const refreshInvites = async (query: ConversationQuery = {}) => {
    if (!electronIpc.isElectron()) return []
    const data = await sendToWorkerAwait({
      type: 'marmot-list-invites',
      data: {
        search: query.search || ''
      }
    })
    const parsed = parseInvites(data?.invites || [])
    const actionable = filterActionableInvites(parsed)
    setInvites(actionable)
    return actionable
  }

  const loadThread = async (
    conversationId: string,
    options: {
      limit?: number
      beforeTimestamp?: number
      afterTimestamp?: number
      sync?: boolean
    } = {}
  ) => {
    const data = await sendToWorkerAwait({
      type: 'marmot-load-thread',
      data: {
        conversationId,
        limit: options.limit,
        beforeTimestamp: options.beforeTimestamp,
        afterTimestamp: options.afterTimestamp,
        sync: options.sync !== false
      }
    })

    const messages = parseMessages(data?.messages || []).map((message) => ({
      ...message,
      conversationId
    }))

    messageCacheRef.current.set(conversationId, messages)

    const readState = parseReadState(data?.readState || {}, conversationId)
    readStateRef.current.set(conversationId, readState)
    saveReadStateToStorage(readStateRef.current)

    return {
      conversationId,
      messages,
      readState,
      unreadCount: Number.isFinite(data?.unreadCount) ? Number(data.unreadCount) : 0
    }
  }

  const createConversation = async (input: CreateConversationInput) => {
    const data = await sendToWorkerAwait({
      type: 'marmot-create-conversation',
      data: {
        title: input.title,
        description: input.description,
        members: input.members,
        imageUrl: input.imageUrl || null,
        relayUrls: Array.isArray(input.relayUrls)
          ? input.relayUrls
              .map((relay) => normalizeRelayUrl(relay))
              .filter((relay): relay is string => Boolean(relay))
          : undefined,
        relayMode: input.relayMode === 'strict' ? 'strict' : 'withFallback'
      }
    })

    const conversation = parseConversations(data?.conversation ? [data.conversation] : [])[0]
    if (conversation) {
      applyConversationUpdate(conversation)
      emitEvent({ type: 'conversation-created', conversation })
    }

    await refreshConversations()
    await refreshInvites()

    if (!conversation) {
      throw new Error('Worker did not return created conversation')
    }

    const invited = Array.isArray(data?.invited)
      ? data.invited
          .map((member: unknown) => (typeof member === 'string' ? member.trim().toLowerCase() : ''))
          .filter((member: string) => Boolean(member))
      : []

    const failed = Array.isArray(data?.failed)
      ? data.failed
          .filter((row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object')
          .map((row: Record<string, unknown>) => ({
            pubkey: typeof row.pubkey === 'string' ? row.pubkey : '',
            error: typeof row.error === 'string' ? row.error : 'Unknown invite failure'
          }))
          .filter((row: InviteFailure) => Boolean(row.pubkey))
      : []

    return {
      conversation,
      invited,
      failed
    }
  }

  const inviteMembers = async (conversationId: string, members: string[]) => {
    await sendToWorkerAwait({
      type: 'marmot-invite-members',
      data: {
        conversationId,
        members
      }
    })
    await refreshConversations()
  }

  const grantConversationAdmin = async (conversationId: string, targetPubkey: string) => {
    const data = await sendToWorkerAwait({
      type: 'marmot-grant-admin',
      data: {
        conversationId,
        targetPubkey
      }
    })

    const conversation = parseConversations(data?.conversation ? [data.conversation] : [])[0]
    if (conversation) {
      applyConversationUpdate(conversation)
      emitEvent({ type: 'conversation-updated', conversation })
    }

    await refreshConversations()
  }

  const acceptInvite = async (inviteId: string) => {
    const data = await sendToWorkerAwait({
      type: 'marmot-accept-invite',
      data: {
        inviteId
      }
    })
    const conversationId =
      typeof data?.conversation?.id === 'string'
        ? data.conversation.id
        : typeof data?.conversationId === 'string'
          ? data.conversationId
          : null

    markInviteAccepted(inviteId, conversationId)
    await refreshConversations()
    await refreshInvites()
    return { conversationId }
  }

  const updateConversationMetadata = async (input: UpdateConversationMetadataInput) => {
    await sendToWorkerAwait({
      type: 'marmot-update-conversation-metadata',
      data: {
        conversationId: input.conversationId,
        title: input.title,
        description: input.description,
        imageUrl: input.imageUrl,
        imageAttachment: input.imageAttachment || null,
        publish: true
      }
    })
    await refreshConversations()
  }

  const messenger = useMemo<MarmotMessenger | null>(() => {
    if (!ready || !electronIpc.isElectron()) return null

    return {
      on: (cb: (event: MessengerEvent) => void) => {
        listenersRef.current.add(cb)
        return () => listenersRef.current.delete(cb)
      },
      off: (cb: (event: MessengerEvent) => void) => {
        listenersRef.current.delete(cb)
      },
      syncRecent: async (conversationId?: string) => {
        if (conversationId) {
          const thread = await loadThread(conversationId, { sync: true, limit: 500 })
          return thread.messages.length
        }
        await refreshConversations()
        await refreshInvites()
        return conversations.length
      },
      getConversationMessages: async (conversationId: string, limit?: number) => {
        const cached = messageCacheRef.current.get(conversationId)
        if (cached && (!limit || cached.length <= limit)) {
          return limit ? cached.slice(-limit) : cached
        }
        const thread = await loadThread(conversationId, { limit: limit || 500, sync: false })
        return limit ? thread.messages.slice(-limit) : thread.messages
      },
      loadThread,
      sendMessage: async (conversationId: string, content: string, opts: SendMessageOptions = {}) => {
        const clientMessageId =
          opts.clientMessageId || `client-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

        emitEvent({
          type: 'message-send-status',
          conversationId,
          clientMessageId,
          status: 'sending'
        })

        let data: any
        try {
          data = await sendToWorkerAwait({
            type: 'marmot-send-message',
            data: {
              conversationId,
              content,
              replyTo: opts.replyTo,
              type: opts.type || 'text',
              attachments: opts.attachments || [],
              clientMessageId
            }
          })
        } catch (error) {
          emitEvent({
            type: 'message-send-status',
            conversationId,
            clientMessageId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
          throw error
        }

        const message = parseMessages(data?.message ? [data.message] : [])[0]
        if (!message) {
          const error = new Error('Worker did not return sent message')
          emitEvent({
            type: 'message-send-status',
            conversationId,
            clientMessageId,
            status: 'failed',
            error: error.message
          })
          throw error
        }

        message.conversationId = conversationId

        const existing = messageCacheRef.current.get(conversationId) || []
        const merged = mergeMessages(existing, [message])
        messageCacheRef.current.set(conversationId, merged)

        emitEvent({ type: 'message', message })
        emitEvent({
          type: 'message-send-status',
          conversationId,
          clientMessageId,
          messageId: message.id,
          status: 'sent'
        })

        return [message]
      },
      sendMediaMessage: async (
        conversationId: string,
        content: string,
        attachments: MessageAttachment[],
        opts: SendMessageOptions = {}
      ) => {
        const clientMessageId =
          opts.clientMessageId || `client-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

        emitEvent({
          type: 'message-send-status',
          conversationId,
          clientMessageId,
          status: 'sending'
        })

        let data: any
        try {
          data = await sendToWorkerAwait({
            type: 'marmot-send-media-message',
            data: {
              conversationId,
              content,
              replyTo: opts.replyTo,
              attachments,
              type: 'media',
              clientMessageId
            }
          })
        } catch (error) {
          emitEvent({
            type: 'message-send-status',
            conversationId,
            clientMessageId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
          throw error
        }

        const message = parseMessages(data?.message ? [data.message] : [])[0]
        if (!message) {
          const error = new Error('Worker did not return sent media message')
          emitEvent({
            type: 'message-send-status',
            conversationId,
            clientMessageId,
            status: 'failed',
            error: error.message
          })
          throw error
        }

        message.conversationId = conversationId

        const existing = messageCacheRef.current.get(conversationId) || []
        const merged = mergeMessages(existing, [message])
        messageCacheRef.current.set(conversationId, merged)

        emitEvent({ type: 'message', message })
        emitEvent({
          type: 'message-send-status',
          conversationId,
          clientMessageId,
          messageId: message.id,
          status: 'sent'
        })

        return [message]
      },
      markConversationRead: async (
        conversationId: string,
        lastReadMessageId?: string,
        lastReadAt?: number
      ) => {
        const data = await sendToWorkerAwait({
          type: 'marmot-mark-read',
          data: {
            conversationId,
            lastReadMessageId,
            lastReadAt
          }
        })

        const readState = parseReadState(data?.readState || {}, conversationId)
        readStateRef.current.set(conversationId, readState)
        saveReadStateToStorage(readStateRef.current)

        setConversations((previous) =>
          previous.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  unreadCount: Number.isFinite(data?.unreadCount) ? Number(data.unreadCount) : 0,
                  lastReadAt: readState.lastReadAt,
                  lastReadMessageId: readState.lastReadMessageId || null
                }
              : conversation
          )
        )
      }
    }
  }, [ready, conversations.length])

  useEffect(() => {
    if (!isReady || !pubkey) return
    if (!relayUrls.length) {
      setReady(true)
      return
    }
    const initSignature = `${pubkey}:${relaySignature}`
    const now = Date.now()
    if (recentInitRef.current?.signature === initSignature && now - recentInitRef.current.at < 10_000) {
      return
    }
    if (initInFlightSignatureRef.current === initSignature) {
      return
    }

    if (!electronIpc.isElectron()) {
      setUnsupportedReason('Conversations require Electron runtime.')
      setReady(true)
      return
    }

    let cancelled = false
    setReady(false)
    setUnsupportedReason(undefined)

    readStateRef.current = loadReadStateFromStorage()

    const init = async () => {
      initInFlightSignatureRef.current = initSignature
      recentInitRef.current = { signature: initSignature, at: Date.now() }
      try {
        const initData = await sendToWorkerAwait({
          type: 'marmot-init',
          data: {
            relays: relayUrls
          }
        }, 60_000)

        if (cancelled) return

        const nextConversations = parseConversations(initData?.conversations || [])
        const nextInvites = filterActionableInvites(parseInvites(initData?.invites || []))

        setConversations(nextConversations)
        setInvites(nextInvites)
        setReady(true)

        debug('marmot init complete', {
          conversations: nextConversations.length,
          invites: nextInvites.length,
          relayCount: relayUrls.length
        })
      } catch (error) {
        console.error('Failed to initialize marmot conversations', error)
        if (!cancelled) {
          setUnsupportedReason(error instanceof Error ? error.message : 'Failed to initialize conversations')
          setReady(true)
        }
      } finally {
        if (initInFlightSignatureRef.current === initSignature) {
          initInFlightSignatureRef.current = null
        }
      }
    }

    const offWorkerMessage = electronIpc.onWorkerMessage((msg) => {
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'marmot-conversation-updated' && msg.data?.conversation) {
        const conversation = parseConversations([msg.data.conversation])[0]
        if (!conversation) return
        applyConversationUpdate(conversation)
        emitEvent({ type: 'conversation-updated', conversation })
        return
      }

      if (msg.type === 'marmot-thread-updated' && msg.data?.conversationId) {
        const conversationId = String(msg.data.conversationId)
        const incoming = parseMessages(msg.data.messages || []).map((message) => ({
          ...message,
          conversationId
        }))
        if (!incoming.length) return

        const existing = messageCacheRef.current.get(conversationId) || []
        const merged = mergeMessages(existing, incoming)
        messageCacheRef.current.set(conversationId, merged)

        incoming.forEach((message) => emitEvent({ type: 'message', message }))
        return
      }

      if (msg.type === 'marmot-invite-updated' && msg.data?.invite) {
        const invite = parseInvites([msg.data.invite])[0]
        if (!invite) return
        if (!isInviteActionable(invite)) {
          setInvites((previous) => previous.filter((item) => item.id !== invite.id))
          emitEvent({ type: 'invite-updated', invite })
          return
        }
        setInvites((previous) => {
          const next = [...previous.filter((item) => item.id !== invite.id), invite]
          return sortInvites(next)
        })
        emitEvent({ type: 'invite-updated', invite })
        return
      }

      if (msg.type === 'marmot-readstate-updated' && msg.data?.conversationId) {
        const conversationId = String(msg.data.conversationId)
        const readState = parseReadState(msg.data.readState || {}, conversationId)
        const unreadCount = Number.isFinite(msg.data.unreadCount) ? Number(msg.data.unreadCount) : 0

        readStateRef.current.set(conversationId, readState)
        saveReadStateToStorage(readStateRef.current)

        setConversations((previous) =>
          previous.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  unreadCount,
                  lastReadAt: readState.lastReadAt,
                  lastReadMessageId: readState.lastReadMessageId || null
                }
              : conversation
          )
        )

        emitEvent({
          type: 'readstate-updated',
          conversationId,
          readState,
          unreadCount
        })
        return
      }

      if (msg.type === 'marmot-message-send-status' && msg.data) {
        const statusData = msg.data as MarmotSendStatus
        if (!statusData.conversationId || !statusData.clientMessageId) return
        emitEvent({
          type: 'message-send-status',
          conversationId: statusData.conversationId,
          clientMessageId: statusData.clientMessageId,
          messageId: statusData.messageId,
          status: statusData.status,
          error: statusData.error
        })
      }
    })

    init()

    return () => {
      cancelled = true
      offWorkerMessage?.()
    }
  }, [isReady, pubkey, relaySignature])

  const value = useMemo<MessengerContextType>(
    () => ({
      messenger,
      conversations,
      invites,
      pendingInviteCount,
      ready,
      unsupportedReason,
      createConversation,
      inviteMembers,
      grantConversationAdmin,
      acceptInvite,
      refreshConversations,
      refreshInvites,
      updateConversationMetadata,
      dismissInvite,
      markInviteAccepted,
      getInviteById,
      drainBufferedMessages: (conversationId: string) => {
        const list = bufferedMessagesRef.current.get(conversationId) || []
        bufferedMessagesRef.current.delete(conversationId)
        return list
      }
    }),
    [
      messenger,
      conversations,
      invites,
      pendingInviteCount,
      ready,
      unsupportedReason,
      createConversation,
      inviteMembers,
      grantConversationAdmin,
      acceptInvite,
      refreshConversations,
      refreshInvites,
      updateConversationMetadata,
      dismissInvite,
      markInviteAccepted,
      getInviteById
    ]
  )

  return <MessengerContext.Provider value={value}>{children}</MessengerContext.Provider>
}
