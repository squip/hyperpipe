import { parseGatewayInviteEvent } from '@/lib/groups'
import { usePrimaryPage } from '@/PageManager'
import { useGroups } from '@/providers/GroupsProvider'
import { ShieldCheck } from 'lucide-react'
import { Event } from '@nostr/tools/wasm'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import Username from '@/components/Username'
import Notification from './Notification'

function InviteStatusBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {label}
    </span>
  )
}

export function GatewayInviteNotification({
  notification,
  isNew = false
}: {
  notification: Event
  isNew?: boolean
}) {
  const { t } = useTranslation()
  const { navigate } = usePrimaryPage()
  const { gatewayMetadata } = useGroups()
  const parsedInvite = useMemo(() => parseGatewayInviteEvent(notification), [notification])
  const metadataByOrigin = useMemo(() => {
    const map = new Map<string, (typeof gatewayMetadata)[number]>()
    for (const item of gatewayMetadata) {
      if (!item?.origin || map.has(item.origin)) continue
      map.set(item.origin, item)
    }
    return map
  }, [gatewayMetadata])

  if (!parsedInvite) return null

  const metadata = metadataByOrigin.get(parsedInvite.origin)
  const operatorPubkey = String(parsedInvite.operatorPubkey || metadata?.operatorPubkey || '').trim()
  const policy = metadata?.policy || 'OPEN'

  const handleClick = () => {
    navigate('groups', {
      initialTab: 'invites',
      tabRequestId: `${notification.id}:${Date.now()}`
    })
  }

  return (
    <Notification
      notificationId={notification.id}
      icon={<ShieldCheck size={24} className="text-emerald-500 shrink-0" />}
      sender={notification.pubkey}
      sentAt={notification.created_at}
      description={t('invited you to a gateway')}
      isNew={isNew}
      showBottomTimestamp={false}
      onClick={handleClick}
      middle={
        <div className="mt-1.5 min-w-0 space-y-1">
          <div className="truncate text-sm font-semibold">{parsedInvite.origin}</div>
          <div className="flex items-center gap-1.5">
            <InviteStatusBadge label={policy === 'CLOSED' ? t('Closed') : t('Open')} />
          </div>
          {operatorPubkey ? (
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <SimpleUserAvatar
                userId={operatorPubkey}
                size="small"
                className="h-5 w-5 rounded-full"
              />
              <Username userId={operatorPubkey} className="truncate text-xs" withoutSkeleton />
            </div>
          ) : null}
        </div>
      }
    />
  )
}
