import type { ChatConversation, ChatInvite, GroupFileRecord, GroupInvite } from '../types.js'

export function selectChatUnreadTotal(conversations: ChatConversation[]): number {
  return conversations.reduce((total, conversation) => {
    const unread = Number.isFinite(conversation.unreadCount) ? Math.max(0, conversation.unreadCount) : 0
    return total + unread
  }, 0)
}

export function selectChatPendingInviteCount(invites: ChatInvite[]): number {
  return invites.filter((invite) => invite.status !== 'joined').length
}

export function selectFilesCount(records: GroupFileRecord[]): number {
  return records.length
}

export function selectGroupInvitesCount(invites: GroupInvite[]): number {
  return invites.length
}

export function selectInvitesCount(groupInvites: GroupInvite[], chatInvites: ChatInvite[]): number {
  return selectGroupInvitesCount(groupInvites) + selectChatPendingInviteCount(chatInvites)
}

export function selectChatNavCount(conversations: ChatConversation[], invites: ChatInvite[]): number {
  return selectChatUnreadTotal(conversations) + selectChatPendingInviteCount(invites)
}
