import { toRelaySettings } from '@/lib/link'
import { simplifyUrl } from '@/lib/url'
import { SecondaryPageLink } from '@/PageManager'
import useFeedRelayOptions, { type FeedRelayOption } from '@/hooks/useFeedRelayOptions'
import { useFavoriteRelays } from '@/providers/FavoriteRelaysProvider'
import { useFeed } from '@/providers/FeedProvider'
import { useNostr } from '@/providers/NostrProvider'
import { UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import RelayIcon from '../RelayIcon'
import RelaySetCard from '../RelaySetCard'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

export default function FeedSwitcher({ close }: { close?: () => void }) {
  const { t } = useTranslation()
  const { pubkey } = useNostr()
  const { relaySets } = useFavoriteRelays()
  const { feedInfo, switchFeed } = useFeed()
  const { relayOptions, getGroupRelaySelectionState, getRelaySelectionState } = useFeedRelayOptions()
  const activeRelaySelection =
    feedInfo.feedType === 'relay'
      ? feedInfo.localGroupRelay?.groupId
        ? getGroupRelaySelectionState(feedInfo.localGroupRelay.groupId)
        : getRelaySelectionState(feedInfo.id || null)
      : null
  const activeRelayIdentity = activeRelaySelection?.relayIdentity || null

  return (
    <div className="space-y-2">
      {pubkey && (
        <FeedSwitcherItem
          isActive={feedInfo.feedType === 'following'}
          onClick={() => {
            if (!pubkey) return
            switchFeed('following', { pubkey })
            close?.()
          }}
        >
          <div className="flex gap-2 items-center">
            <div className="flex justify-center items-center w-6 h-6 shrink-0">
              <UsersRound className="size-4" />
            </div>
            <div>{t('Following')}</div>
          </div>
        </FeedSwitcherItem>
      )}

      <div className="flex justify-end items-center text-sm">
        <SecondaryPageLink
          to={toRelaySettings()}
          className="text-primary font-semibold"
          onClick={() => close?.()}
        >
          {t('edit')}
        </SecondaryPageLink>
      </div>
      {relaySets
        .filter((set) => set.relayUrls.length > 0)
        .map((set) => (
          <RelaySetCard
            key={set.id}
            relaySet={set}
            select={feedInfo.feedType === 'relays' && set.id === feedInfo.id}
            onSelectChange={(select) => {
              if (!select) return
              switchFeed('relays', { activeRelaySetId: set.id })
              close?.()
            }}
          />
        ))}
      {relayOptions.map((relayOption) => (
        <FeedSwitcherItem
          key={relayOption.relayIdentity}
          isActive={
            feedInfo.feedType === 'relay'
            && (
              activeRelayIdentity === relayOption.relayIdentity
              || (
                !!feedInfo.localGroupRelay?.groupId
                && relayOption.groupId === feedInfo.localGroupRelay.groupId
              )
            )
          }
          onClick={() => {
            switchFeed('relay', {
              relay: relayOption.relayUrl,
              localGroupRelay:
                relayOption.isGroupRelay && relayOption.groupId
                  ? {
                      groupId: relayOption.groupId,
                      relayIdentity: relayOption.relayIdentity
                    }
                  : null
            })
            close?.()
          }}
        >
          <FeedRelayOptionRow relayOption={relayOption} />
        </FeedSwitcherItem>
      ))}
    </div>
  )
}

function FeedRelayOptionRow({ relayOption }: { relayOption: FeedRelayOption }) {
  const { t } = useTranslation()
  const meta = relayOption.displayMeta
  if (!meta) {
    return (
      <div className="flex gap-2 items-center w-full">
        <RelayIcon url={relayOption.relayUrl} />
        <div className="flex-1 w-0 truncate">{simplifyUrl(relayOption.relayUrl)}</div>
      </div>
    )
  }

  const label = meta.label?.trim() || simplifyUrl(relayOption.relayUrl)
  const initials = label.slice(0, 2).toUpperCase()
  const secondaryLabel =
    !relayOption.readyForReq && relayOption.isGroupRelay
      ? t('loading...')
      : !meta.hideUrl
        ? simplifyUrl(relayOption.relayUrl)
        : null
  return (
    <div className="flex min-w-0 items-center gap-2 w-full">
      {meta.imageUrl ? (
        <Avatar className="h-5 w-5 shrink-0">
          <AvatarImage src={meta.imageUrl} alt={label} />
          <AvatarFallback className="text-[9px] font-semibold">{initials}</AvatarFallback>
        </Avatar>
      ) : (
        <RelayIcon url={relayOption.relayUrl} />
      )}
      <div className="min-w-0">
        <div className="truncate">{label}</div>
        {secondaryLabel ? (
          <div className="truncate text-[11px] text-muted-foreground">{secondaryLabel}</div>
        ) : null}
      </div>
    </div>
  )
}

function FeedSwitcherItem({
  children,
  isActive,
  onClick,
  controls
}: {
  children: React.ReactNode
  isActive: boolean
  onClick: () => void
  controls?: React.ReactNode
}) {
  return (
    <div
      className={`w-full border rounded-lg p-4 ${isActive ? 'border-primary bg-primary/5' : 'clickable'}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-center">
        <div className="font-semibold flex-1">{children}</div>
        {controls}
      </div>
    </div>
  )
}
