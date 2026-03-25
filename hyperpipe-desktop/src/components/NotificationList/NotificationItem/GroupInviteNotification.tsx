import { parseGroupInviteEvent } from '@/lib/groups'
import { usePrimaryPage } from '@/PageManager'
import { useGroups } from '@/providers/GroupsProvider'
import { UserPlus2 } from 'lucide-react'
import { Event } from '@nostr/tools/wasm'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import Notification from './Notification'

function InviteStatusBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {label}
    </span>
  )
}

export function GroupInviteNotification({
  notification,
  isNew = false
}: {
  notification: Event
  isNew?: boolean
}) {
  const { t } = useTranslation()
  const { navigate } = usePrimaryPage()
  const { getInviteByEventId } = useGroups()
  const parsedInvite = useMemo(() => parseGroupInviteEvent(notification), [notification])
  const enrichedInvite = getInviteByEventId(notification.id)

  const groupName =
    enrichedInvite?.groupName ||
    enrichedInvite?.name ||
    parsedInvite.groupName ||
    parsedInvite.name ||
    parsedInvite.groupId ||
    t('Group')
  const groupPicture = enrichedInvite?.groupPicture || parsedInvite.groupPicture
  const groupAbout = enrichedInvite?.about || parsedInvite.about
  const isOpen = enrichedInvite?.fileSharing ?? parsedInvite.fileSharing
  const isPublic = enrichedInvite?.isPublic ?? parsedInvite.isPublic
  const initials = (groupName || 'GR').slice(0, 2).toUpperCase()

  const handleClick = () => {
    navigate('groups', {
      initialTab: 'invites',
      tabRequestId: `${notification.id}:${Date.now()}`
    })
  }

  return (
    <Notification
      notificationId={notification.id}
      icon={<UserPlus2 size={24} className="text-emerald-500 shrink-0" />}
      sender={notification.pubkey}
      sentAt={notification.created_at}
      description={t('invited you to a group')}
      isNew={isNew}
      showBottomTimestamp={false}
      onClick={handleClick}
      middle={
        <div className="mt-1.5 flex items-start gap-2 min-w-0">
          <Avatar className="h-9 w-9 shrink-0">
            {groupPicture ? <AvatarImage src={groupPicture} alt={groupName} /> : null}
            <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <div className="truncate text-sm font-semibold">{groupName}</div>
            {groupAbout ? (
              <div className="line-clamp-2 text-xs text-muted-foreground">{groupAbout}</div>
            ) : null}
            <div className="flex items-center gap-1.5">
              {typeof isOpen === 'boolean' ? (
                <InviteStatusBadge label={isOpen ? t('Open') : t('Closed')} />
              ) : null}
              {typeof isPublic === 'boolean' ? (
                <InviteStatusBadge label={isPublic ? t('Public') : t('Private')} />
              ) : null}
            </div>
          </div>
        </div>
      }
    />
  )
}
