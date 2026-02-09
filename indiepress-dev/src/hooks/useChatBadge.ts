import { useMessenger } from '@/providers/MessengerProvider'
import { useMemo } from 'react'

export function useChatBadge() {
  const { conversations } = useMessenger()
  const unreadCount = useMemo(
    () => conversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unreadCount || 0), 0),
    [conversations]
  )
  const hasNewMessages = unreadCount > 0
  const reset = () => {}

  return { hasNewMessages, unreadCount, reset }
}
