import { usePrimaryPage } from '@/PageManager'
import { useChatBadge } from '@/hooks'
import { MessageSquare } from 'lucide-react'
import BottomNavigationBarItem from './BottomNavigationBarItem'

export default function ChatButton() {
  const { navigate, current, display } = usePrimaryPage()
  const { hasNewMessages, unreadCount } = useChatBadge()

  return (
    <BottomNavigationBarItem
      active={current === 'conversations' && display}
      onClick={() => navigate('conversations')}
    >
      <div className="relative">
        <MessageSquare />
        {hasNewMessages && (
          <div
            className="absolute -right-2 -top-2 flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-primary-foreground ring-2 ring-background"
            style={{ backgroundColor: 'hsl(var(--primary))' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </div>
        )}
      </div>
    </BottomNavigationBarItem>
  )
}
