import type { ConversationInvite } from '@/lib/conversations/types'
import type { NostrEvent } from '@jsr/nostr__tools/wasm'

export const CONVERSATION_INVITE_NOTIFICATION_KIND = 99017
const CONVERSATION_INVITE_ID_TAG = 'marmot-invite-id'

export type ConversationInviteNotificationPayload = {
  inviteId: string
  senderPubkey: string
  createdAt: number
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  conversationId?: string | null
  memberPubkeys?: string[]
}

export function toConversationInviteNotificationEvent(invite: ConversationInvite): NostrEvent | null {
  if (!invite?.id || !invite.senderPubkey || !Number.isFinite(invite.createdAt)) return null

  const payload: ConversationInviteNotificationPayload = {
    inviteId: invite.id,
    senderPubkey: invite.senderPubkey,
    createdAt: Math.floor(invite.createdAt),
    title: invite.title || null,
    description: invite.description || null,
    imageUrl: invite.imageUrl || null,
    conversationId: invite.conversationId || null,
    memberPubkeys: Array.isArray(invite.memberPubkeys)
      ? invite.memberPubkeys.filter((value) => Boolean(value))
      : []
  }

  return {
    id: `marmot-invite:${invite.id}`,
    pubkey: invite.senderPubkey,
    created_at: Math.floor(invite.createdAt),
    kind: CONVERSATION_INVITE_NOTIFICATION_KIND,
    tags: [[CONVERSATION_INVITE_ID_TAG, invite.id]],
    content: JSON.stringify(payload),
    sig: ''
  } as NostrEvent
}

export function parseConversationInviteNotification(event: NostrEvent): ConversationInviteNotificationPayload | null {
  if (!event || event.kind !== CONVERSATION_INVITE_NOTIFICATION_KIND) return null

  const inviteIdFromTag = Array.isArray(event.tags)
    ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === CONVERSATION_INVITE_ID_TAG)?.[1]
    : null

  try {
    const parsed = JSON.parse(event.content || '{}')
    if (!parsed || typeof parsed !== 'object') return null
    const inviteId = String(parsed.inviteId || inviteIdFromTag || '').trim()
    const senderPubkey = String(parsed.senderPubkey || event.pubkey || '').trim()
    const createdAt = Number(parsed.createdAt ?? event.created_at)
    if (!inviteId || !senderPubkey || !Number.isFinite(createdAt)) return null

    return {
      inviteId,
      senderPubkey,
      createdAt: Math.floor(createdAt),
      title: typeof parsed.title === 'string' ? parsed.title : null,
      description: typeof parsed.description === 'string' ? parsed.description : null,
      imageUrl: typeof parsed.imageUrl === 'string' ? parsed.imageUrl : null,
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
      memberPubkeys: Array.isArray(parsed.memberPubkeys)
        ? parsed.memberPubkeys
            .map((value: unknown) => String(value || '').trim())
            .filter((value: string) => Boolean(value))
        : []
    }
  } catch {
    const inviteId = String(inviteIdFromTag || '').trim()
    const senderPubkey = String(event.pubkey || '').trim()
    if (!inviteId || !senderPubkey || !Number.isFinite(event.created_at)) return null
    return {
      inviteId,
      senderPubkey,
      createdAt: Math.floor(event.created_at),
      title: null,
      description: null,
      imageUrl: null,
      conversationId: null,
      memberPubkeys: []
    }
  }
}
