import { usePrimaryPage } from '@/PageManager'
import { useNostr } from '@/providers/NostrProvider'
import { useNotification } from '@/providers/NotificationProvider'
import { Bell } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function NotificationsButton({ collapse }: { collapse: boolean }) {
  const { checkLogin } = useNostr()
  const { navigate, current, display } = usePrimaryPage()
  const { newNotificationCount } = useNotification()
  const badgeLabel = newNotificationCount > 99 ? '99+' : String(newNotificationCount)

  return (
    <SidebarItem
      title="Notifications"
      onClick={() => checkLogin(() => navigate('notifications'))}
      active={display && current === 'notifications'}
      collapse={collapse}
    >
      <div className="relative">
        <Bell />
        {newNotificationCount > 0 && (
          <span className="absolute -top-2 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-4 text-center">
            {badgeLabel}
          </span>
        )}
      </div>
    </SidebarItem>
  )
}
