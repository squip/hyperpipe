import type {
  ChatConversation,
  ChatInvite,
  ChatService as IChatService,
  ThreadMessage
} from './types.js'
import type { WorkerHost } from '../runtime/workerHost.js'
import { waitForWorkerEvent } from '../runtime/waitForWorkerEvent.js'

export function parseConversationPayload(row: Record<string, unknown>): ChatConversation | null {
  if (typeof row.id !== 'string') return null

  return {
    id: row.id,
    title:
      typeof row.title === 'string' && row.title.trim().length
        ? row.title
        : 'Conversation',
    description: typeof row.description === 'string' ? row.description : null,
    participants: Array.isArray(row.participants)
      ? row.participants
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    adminPubkeys: Array.isArray(row.adminPubkeys)
      ? row.adminPubkeys
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      : [],
    canInviteMembers: Boolean(row.canInviteMembers),
    unreadCount: Number.isFinite(row.unreadCount) ? Number(row.unreadCount) : 0,
    lastMessageAt: Number.isFinite(row.lastMessageAt) ? Number(row.lastMessageAt) : 0,
    lastMessagePreview: typeof row.lastMessagePreview === 'string' ? row.lastMessagePreview : null
  }
}

export function parseInvitePayload(row: Record<string, unknown>): ChatInvite | null {
  if (typeof row.id !== 'string') return null

  const rawStatus = typeof row.status === 'string' ? row.status : 'pending'
  const status = (['pending', 'joining', 'joined', 'failed'].includes(rawStatus)
    ? rawStatus
    : 'pending') as ChatInvite['status']

  return {
    id: row.id,
    senderPubkey: typeof row.senderPubkey === 'string' ? row.senderPubkey : '',
    createdAt: Number.isFinite(row.createdAt) ? Number(row.createdAt) : 0,
    status,
    conversationId:
      typeof row.conversationId === 'string' ? row.conversationId : null,
    title: typeof row.title === 'string' ? row.title : null,
    description: typeof row.description === 'string' ? row.description : null
  }
}

export function parseThreadMessagePayload(row: Record<string, unknown>): ThreadMessage | null {
  if (typeof row.id !== 'string') return null
  if (typeof row.conversationId !== 'string') return null

  const rawType = typeof row.type === 'string' ? row.type : 'text'
  const type = (['text', 'media', 'reaction', 'system'].includes(rawType)
    ? rawType
    : 'text') as ThreadMessage['type']

  return {
    id: row.id,
    conversationId: row.conversationId,
    senderPubkey: typeof row.senderPubkey === 'string' ? row.senderPubkey : '',
    content: typeof row.content === 'string' ? row.content : '',
    timestamp: Number.isFinite(row.timestamp) ? Number(row.timestamp) : 0,
    type,
    attachments: Array.isArray(row.attachments)
      ? row.attachments
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => ({
            url:
              typeof item.url === 'string'
                ? item.url
                : typeof item.gatewayUrl === 'string'
                  ? item.gatewayUrl
                  : '',
            gatewayUrl: typeof item.gatewayUrl === 'string' ? item.gatewayUrl : null,
            mime: typeof item.mime === 'string' ? item.mime : null,
            size: Number.isFinite(item.size) ? Number(item.size) : null,
            width: Number.isFinite(item.width) ? Number(item.width) : null,
            height: Number.isFinite(item.height) ? Number(item.height) : null,
            fileName: typeof item.fileName === 'string' ? item.fileName : null,
            sha256: typeof item.sha256 === 'string' ? item.sha256 : null
          }))
      : []
  }
}

export class ChatService implements IChatService {
  private workerHost: WorkerHost

  constructor(workerHost: WorkerHost) {
    this.workerHost = workerHost
  }

  private async command<T = Record<string, unknown>>(
    type: string,
    data: Record<string, unknown> = {},
    timeoutMs = 60_000
  ): Promise<T> {
    const result = await this.workerHost.request<T>(
      {
        type,
        data
      },
      timeoutMs
    )

    return result
  }

  async init(relays: string[]): Promise<void> {
    await this.command('marmot-init', { relays }, 90_000)
  }

  async listConversations(search = ''): Promise<ChatConversation[]> {
    const response = await this.command<{ conversations?: unknown[] }>('marmot-list-conversations', {
      search
    })

    const rows = Array.isArray(response?.conversations) ? response.conversations : []
    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => parseConversationPayload(row))
      .filter((row): row is ChatConversation => !!row)
  }

  async listInvites(search = ''): Promise<ChatInvite[]> {
    const response = await this.command<{ invites?: unknown[] }>('marmot-list-invites', {
      search
    })

    const rows = Array.isArray(response?.invites) ? response.invites : []
    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => parseInvitePayload(row))
      .filter((row): row is ChatInvite => !!row)
  }

  filterActionableInvites(
    invites: ChatInvite[],
    opts?: {
      dismissedInviteIds?: Set<string>
      acceptedInviteIds?: Set<string>
      acceptedConversationIds?: Set<string>
    }
  ): ChatInvite[] {
    const dismissed = opts?.dismissedInviteIds || new Set<string>()
    const accepted = opts?.acceptedInviteIds || new Set<string>()
    const acceptedConversations = opts?.acceptedConversationIds || new Set<string>()

    const rows = invites.filter((invite) => {
      if (!invite.id) return false
      if (dismissed.has(invite.id)) return false
      if (accepted.has(invite.id)) return false
      if (invite.conversationId && acceptedConversations.has(invite.conversationId)) return false
      if (invite.status === 'joined') return false
      return true
    })

    rows.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
      return left.id.localeCompare(right.id)
    })
    return rows
  }

  selectUnreadTotal(conversations: ChatConversation[]): number {
    return conversations.reduce((total, conversation) => {
      const unread = Number.isFinite(conversation.unreadCount) ? Math.max(0, conversation.unreadCount) : 0
      return total + unread
    }, 0)
  }

  selectPendingInviteCount(invites: ChatInvite[]): number {
    return invites.filter((invite) => invite.status !== 'joined').length
  }

  async createConversation(input: {
    title: string
    description?: string
    members: string[]
    relayUrls?: string[]
    relayMode?: 'withFallback' | 'strict'
  }): Promise<ChatConversation> {
    const response = await this.command<{ conversation?: Record<string, unknown> }>(
      'marmot-create-conversation',
      {
        title: input.title,
        description: input.description,
        members: input.members,
        relayUrls: input.relayUrls,
        relayMode: input.relayMode
      }
    )

    const parsed = response?.conversation ? parseConversationPayload(response.conversation) : null
    if (!parsed) {
      throw new Error('Worker did not return created conversation')
    }

    return parsed
  }

  async inviteMembers(conversationId: string, members: string[]): Promise<{
    conversationId: string
    invited: string[]
    failed: Array<{
      pubkey: string
      error: string
    }>
    conversation: ChatConversation | null
  }> {
    const response = await this.command<{
      conversationId?: string
      invited?: unknown[]
      failed?: unknown[]
      conversation?: Record<string, unknown>
    }>(
      'marmot-invite-members',
      {
        conversationId,
        members
      }
    )

    const conversation = response?.conversation ? parseConversationPayload(response.conversation) : null
    const invited = Array.isArray(response?.invited)
      ? response.invited
          .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
          .filter(Boolean)
      : []
    const failed = Array.isArray(response?.failed)
      ? response.failed
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
          .map((entry) => ({
            pubkey: typeof entry.pubkey === 'string' ? entry.pubkey : '',
            error: typeof entry.error === 'string' ? entry.error : 'Unknown invite failure'
          }))
          .filter((entry) => Boolean(entry.pubkey))
      : []

    return {
      conversationId:
        typeof response?.conversationId === 'string' && response.conversationId
          ? response.conversationId
          : conversationId,
      invited,
      failed,
      conversation
    }
  }

  async acceptInvite(inviteId: string): Promise<{ conversationId: string | null }> {
    const response = await this.command<{
      operationId?: string
      inviteId?: string
      conversation?: { id?: string }
      conversationId?: string
    }>(
      'marmot-accept-invite',
      {
        inviteId
      }
    )

    const operationId =
      typeof response?.operationId === 'string' && response.operationId.trim().length
        ? response.operationId.trim()
        : null

    if (!operationId) {
      const conversationId =
        typeof response?.conversation?.id === 'string'
          ? response.conversation.id
          : typeof response?.conversationId === 'string'
            ? response.conversationId
            : null

      return { conversationId }
    }

    const event = await waitForWorkerEvent(
      this.workerHost,
      (candidate) => {
        if (candidate?.type !== 'marmot-accept-invite-operation') return false
        const data =
          candidate?.data && typeof candidate.data === 'object'
            ? candidate.data as Record<string, unknown>
            : null
        if (!data) return false
        if (data.operationId !== operationId) return false
        return data.phase === 'joinedConversation' || data.phase === 'failed'
      },
      120_000
    )

    const eventData =
      event?.data && typeof event.data === 'object'
        ? event.data as Record<string, unknown>
        : null
    const phase = typeof eventData?.phase === 'string' ? eventData.phase : null

    if (phase === 'failed') {
      throw new Error(
        typeof eventData?.error === 'string' && eventData.error.trim().length
          ? eventData.error
          : 'Chat join failed'
      )
    }

    const conversationId =
      typeof eventData?.conversationId === 'string'
        ? eventData.conversationId
        : typeof response?.conversation?.id === 'string'
          ? response.conversation.id
          : typeof response?.conversationId === 'string'
            ? response.conversationId
            : null

    return { conversationId }
  }

  async loadThread(conversationId: string, limit = 200): Promise<ThreadMessage[]> {
    const response = await this.command<{ messages?: unknown[] }>('marmot-load-thread', {
      conversationId,
      limit,
      sync: true
    })

    const rows = Array.isArray(response?.messages) ? response.messages : []

    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => parseThreadMessagePayload({ ...row, conversationId }))
      .filter((row): row is ThreadMessage => !!row)
      .sort((left, right) => {
        if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
        return left.id.localeCompare(right.id)
      })
  }

  async sendMessage(conversationId: string, content: string): Promise<ThreadMessage> {
    const response = await this.command<{ message?: Record<string, unknown> }>('marmot-send-message', {
      conversationId,
      content,
      type: 'text',
      attachments: []
    })

    if (!response?.message) {
      throw new Error('Worker did not return sent message')
    }

    const parsed = parseThreadMessagePayload({
      ...response.message,
      conversationId
    })

    if (!parsed) {
      throw new Error('Invalid sent message payload')
    }

    return parsed
  }
}
