export type ConversationTab = 'my' | 'invites'

export type MessageAttachment = {
  url: string
  gatewayUrl?: string | null
  mime?: string | null
  size?: number | null
  width?: number | null
  height?: number | null
  blurhash?: string | null
  fileName?: string | null
  sha256?: string | null
  driveKey?: string | null
  ownerPubkey?: string | null
  fileId?: string | null
}

export type ThreadMessageType = 'text' | 'media' | 'reaction' | 'system'

export type ThreadMessage = {
  id: string
  conversationId: string
  senderPubkey: string
  content: string
  timestamp: number
  type: ThreadMessageType
  replyTo?: string | null
  attachments?: MessageAttachment[]
  tags?: string[][]
  protocol: 'marmot'
}

export type ReadState = {
  conversationId: string
  lastReadMessageId?: string | null
  lastReadAt: number
  updatedAt: number
}

export type ConversationSummary = {
  id: string
  protocol: 'marmot'
  participants: string[]
  adminPubkeys: string[]
  canInviteMembers: boolean
  title: string
  description?: string | null
  imageUrl?: string | null
  unreadCount: number
  lastMessageAt: number
  lastMessageId?: string | null
  lastMessageSenderPubkey?: string | null
  lastMessagePreview?: string | null
  lastReadAt: number
  lastReadMessageId?: string | null
  relayCount?: number
  updatedAt?: number
}

export type InviteStatus = 'pending' | 'joining' | 'joined' | 'failed'

export type ConversationInvite = {
  id: string
  protocol: 'marmot'
  senderPubkey: string
  createdAt: number
  receivedAt?: number
  status: InviteStatus
  error?: string | null
  keyPackageEventId?: string | null
  relays?: string[]
  conversationId?: string | null
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  memberPubkeys?: string[]
}

export type ConversationQuery = {
  search?: string
  tab?: ConversationTab
}

export type InviteFailure = {
  pubkey: string
  error: string
}

export type CreateConversationAckResult = {
  conversation: ConversationSummary
  operationId: string
}

export type ConversationInitPhase =
  | 'publishingIdentity'
  | 'syncingConversations'
  | 'syncingInvites'
  | 'completed'
  | 'failed'

export type ConversationInitOperationState = {
  operationId: string
  phase: ConversationInitPhase
  error?: string | null
}

export type ConversationCreateWorkerPhase =
  | 'invitingMembers'
  | 'syncingConversation'
  | 'completed'
  | 'failed'

export type ConversationCreateThumbnailPhase =
  | 'idle'
  | 'uploadingThumbnail'
  | 'publishingThumbnailMetadata'
  | 'completed'
  | 'failed'

export type ConversationCreateOperationState = {
  operationId: string
  conversationId: string
  workerPhase: ConversationCreateWorkerPhase
  thumbnailPhase: ConversationCreateThumbnailPhase
  uploadProgress?: number | null
  invited?: string[]
  failed?: InviteFailure[]
  error?: string | null
}

export type ConversationJoinPhase =
  | 'joiningConversation'
  | 'joinedConversation'
  | 'syncingConversation'
  | 'completed'
  | 'failed'

export type ConversationJoinOperationState = {
  operationId: string
  inviteId: string
  phase: ConversationJoinPhase
  conversationId?: string | null
  error?: string | null
}

export type MessengerEvent =
  | { type: 'message'; message: ThreadMessage }
  | { type: 'conversation-updated'; conversation: ConversationSummary }
  | { type: 'conversation-created'; conversation: ConversationSummary }
  | { type: 'conversation-init-operation'; operation: ConversationInitOperationState }
  | { type: 'conversation-create-operation'; operation: ConversationCreateOperationState }
  | { type: 'conversation-join-operation'; operation: ConversationJoinOperationState }
  | { type: 'invite-updated'; invite: ConversationInvite }
  | { type: 'readstate-updated'; conversationId: string; readState: ReadState; unreadCount: number }
  | {
      type: 'message-send-status'
      conversationId: string
      clientMessageId: string
      messageId?: string
      status: 'sending' | 'sent' | 'failed'
      error?: string
    }
  | { type: 'error'; error: Error }

export type SendMessageOptions = {
  replyTo?: string
  type?: 'text' | 'reaction'
  attachments?: MessageAttachment[]
  clientMessageId?: string
}

export type CreateConversationInput = {
  title: string
  description?: string
  members: string[]
  imageUrl?: string | null
  thumbnailFile?: File | null
  relayUrls?: string[]
}

export type UpdateConversationMetadataInput = {
  conversationId: string
  title?: string
  description?: string
  imageUrl?: string | null
  imageAttachment?: MessageAttachment | null
}

export const CONVERSATION_JUMP_FAB_THRESHOLD = 30
