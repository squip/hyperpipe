import { ExtendedKind } from '@/constants'
import { notificationFilter } from '@/lib/notification'
import { useContentPolicy } from '@/providers/ContentPolicyProvider'
import { useMuteList } from '@/providers/MuteListProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useUserTrust } from '@/providers/UserTrustProvider'
import { CONVERSATION_INVITE_NOTIFICATION_KIND } from '@/lib/conversations/invite-notifications'
import { Event } from '@nostr/tools/wasm'
import * as kinds from '@nostr/tools/kinds'
import { useMemo } from 'react'
import { MentionNotification } from './MentionNotification'
import { PollResponseNotification } from './PollResponseNotification'
import { ReactionNotification } from './ReactionNotification'
import { RepostNotification } from './RepostNotification'
import { ZapNotification } from './ZapNotification'
import { GroupInviteNotification } from './GroupInviteNotification'
import { ConversationInviteNotification } from './ConversationInviteNotification'

const GROUP_INVITE_KIND = 9009

export function NotificationItem({
  notification,
  isNew = false
}: {
  notification: Event
  isNew?: boolean
}) {
  const { pubkey } = useNostr()
  const { mutePubkeySet } = useMuteList()
  const { hideContentMentioningMutedUsers } = useContentPolicy()
  const { hideUntrustedNotifications, isUserTrusted } = useUserTrust()
  const canShow = useMemo(() => {
    return notificationFilter(notification, {
      pubkey,
      mutePubkeySet,
      hideContentMentioningMutedUsers,
      hideUntrustedNotifications,
      isUserTrusted
    })
  }, [
    notification,
    mutePubkeySet,
    hideContentMentioningMutedUsers,
    hideUntrustedNotifications,
    isUserTrusted
  ])
  if (!canShow) return null

  if (notification.kind === GROUP_INVITE_KIND) {
    return <GroupInviteNotification notification={notification} isNew={isNew} />
  }
  if (notification.kind === CONVERSATION_INVITE_NOTIFICATION_KIND) {
    return <ConversationInviteNotification notification={notification} isNew={isNew} />
  }
  if (notification.kind === kinds.Reaction) {
    return <ReactionNotification notification={notification} isNew={isNew} />
  }
  if (
    notification.kind === kinds.ShortTextNote ||
    notification.kind === ExtendedKind.COMMENT ||
    notification.kind === ExtendedKind.VOICE_COMMENT ||
    notification.kind === ExtendedKind.POLL
  ) {
    return <MentionNotification notification={notification} isNew={isNew} />
  }
  if (notification.kind === kinds.Repost) {
    return <RepostNotification notification={notification} isNew={isNew} />
  }
  if (notification.kind === kinds.Zap) {
    return <ZapNotification notification={notification} isNew={isNew} />
  }
  if (notification.kind === ExtendedKind.POLL_RESPONSE) {
    return <PollResponseNotification notification={notification} isNew={isNew} />
  }
  return null
}
