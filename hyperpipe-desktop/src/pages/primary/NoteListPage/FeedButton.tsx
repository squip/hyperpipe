import FeedSwitcher from '@/components/FeedSwitcher'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { simplifyUrl } from '@/lib/url'
import { cn } from '@/lib/utils'
import useFeedRelayOptions from '@/hooks/useFeedRelayOptions'
import { useFavoriteRelays } from '@/providers/FavoriteRelaysProvider'
import { useFeed } from '@/providers/FeedProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { ChevronDown, Server, UsersRound } from 'lucide-react'
import { forwardRef, HTMLAttributes, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function FeedButton({ className }: { className?: string }) {
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)

  if (isSmallScreen) {
    return (
      <>
        <FeedSwitcherTrigger className={className} onClick={() => setOpen(true)} />
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[80vh]">
            <div
              className="overflow-y-auto overscroll-contain py-2 px-4"
              style={{ touchAction: 'pan-y' }}
            >
              <FeedSwitcher close={() => setOpen(false)} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FeedSwitcherTrigger className={className} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={0}
        side="bottom"
        className="w-96 min-w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] max-h-[80vh] overflow-auto scrollbar-hide p-4"
      >
        <FeedSwitcher close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

const FeedSwitcherTrigger = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { t } = useTranslation()
    const { feedInfo, relayUrls } = useFeed()
    const { relaySets } = useFavoriteRelays()
    const { getGroupRelaySelectionState, getRelaySelectionState } = useFeedRelayOptions()
    const activeRelaySet = useMemo(() => {
      return feedInfo.feedType === 'relays' && feedInfo.id
        ? relaySets.find((set) => set.id === feedInfo.id)
        : undefined
    }, [feedInfo, relaySets])
    const activeRelaySelection = useMemo(
      () =>
        feedInfo.feedType === 'relay'
          ? feedInfo.localGroupRelay?.groupId
            ? getGroupRelaySelectionState(feedInfo.localGroupRelay.groupId)
            : getRelaySelectionState(feedInfo.id || null)
          : null,
      [
        feedInfo.feedType,
        feedInfo.id,
        feedInfo.localGroupRelay?.groupId,
        getGroupRelaySelectionState,
        getRelaySelectionState
      ]
    )
    const title = useMemo(() => {
      if (feedInfo.feedType === 'following') {
        return t('Following')
      }
      if (feedInfo.feedType === 'relay') {
        const groupLabel = activeRelaySelection?.groupState?.label?.trim()
        if (groupLabel) {
          return activeRelaySelection?.isReadyForReq
            ? groupLabel
            : `${groupLabel} (${t('loading...')})`
        }
        if (relayUrls.length === 0 && feedInfo.localGroupRelay?.groupId) {
          return `${feedInfo.localGroupRelay.groupId.split(':')[1] || t('loading...')} (${t('loading...')})`
        }
        return simplifyUrl(activeRelaySelection?.relayUrl || feedInfo.id || '')
      }
      if (relayUrls.length === 0) {
        return t('Choose a relay')
      }
      if (feedInfo.feedType === 'relays') {
        return activeRelaySet?.name ?? activeRelaySet?.id
      }
    }, [activeRelaySelection, activeRelaySet, feedInfo, relayUrls.length, t])

    return (
      <div
        className={cn(
          'inline-flex h-full max-w-full min-w-0 items-center gap-2 rounded-lg px-3 clickable',
          className
        )}
        ref={ref}
        {...props}
      >
        {feedInfo.feedType === 'following' ? <UsersRound /> : <Server />}
        <div className="min-w-0 shrink truncate text-lg font-semibold">{title}</div>
        <ChevronDown />
      </div>
    )
  }
)
