import { parseConversationInviteNotification } from '@/lib/conversations/invite-notifications'
import { usePrimaryPage } from '@/PageManager'
import { useMessenger } from '@/providers/MessengerProvider'
import { MessageSquare } from 'lucide-react'
import { Event } from '@jsr/nostr__tools/wasm'
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

export function ConversationInviteNotification({
  notification,
  isNew = false
}: {
  notification: Event
  isNew?: boolean
}) {
  const { t } = useTranslation()
  const { navigate } = usePrimaryPage()
  const { getInviteById } = useMessenger()
  const parsed = useMemo(() => parseConversationInviteNotification(notification), [notification])
  const invite = getInviteById(parsed?.inviteId || '')

  if (!parsed) return null

  const title =
    invite?.title ||
    parsed.title ||
    t('Chat')
  const description =
    invite?.description ||
    parsed.description ||
    t('Encrypted chat invite')
  const imageUrl = invite?.imageUrl || parsed.imageUrl || null
  const inviteMemberCount = Array.isArray(invite?.memberPubkeys) ? invite.memberPubkeys.length : 0
  const parsedMemberCount = Array.isArray(parsed.memberPubkeys) ? parsed.memberPubkeys.length : 0
  const memberCount = (
    inviteMemberCount > 0
      ? inviteMemberCount
      : parsedMemberCount > 0
        ? parsedMemberCount
        : 1
  )
  const initials = (title || 'CN').slice(0, 2).toUpperCase()

  const handleClick = () => {
    navigate('conversations', {
      initialTab: 'invites',
      tabRequestId: `${parsed.inviteId}:${Date.now()}`
    })
  }

  return (
    <Notification
      notificationId={notification.id}
      icon={<MessageSquare size={24} className="shrink-0 text-emerald-500" />}
      sender={parsed.senderPubkey}
      sentAt={parsed.createdAt}
      description={t('invited you to a chat')}
      isNew={isNew}
      showBottomTimestamp={false}
      onClick={handleClick}
      middle={
        <div className="mt-1.5 flex min-w-0 items-start gap-2">
          <Avatar className="h-9 w-9 shrink-0">
            {imageUrl ? <AvatarImage src={imageUrl} alt={title} /> : null}
            <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <div className="truncate text-sm font-semibold">{title}</div>
            {description ? (
              <div className="line-clamp-2 text-xs text-muted-foreground">{description}</div>
            ) : null}
            <div className="flex items-center gap-1.5">
              <InviteStatusBadge
                label={t('{{count}} members', { count: memberCount })}
              />
            </div>
          </div>
        </div>
      }
    />
  )
}
