import NormalFeed from '@/components/NormalFeed'
import useFeedRelayOptions from '@/hooks/useFeedRelayOptions'
import { dedupeRelayUrlsByIdentity } from '@/lib/relay-targets'
import { useFeed } from '@/providers/FeedProvider'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

export default function RelaysFeed() {
  const { t } = useTranslation()
  const { feedInfo, relayUrls } = useFeed()
  const { getRelaySelectionState } = useFeedRelayOptions()

  const activeRelaySelection = useMemo(
    () => (feedInfo.feedType === 'relay' ? getRelaySelectionState(feedInfo.id || null) : null),
    [feedInfo.feedType, feedInfo.id, getRelaySelectionState]
  )

  const effectiveRelayUrls = useMemo(() => {
    if (feedInfo.feedType === 'relay') {
      return dedupeRelayUrlsByIdentity(activeRelaySelection?.relayUrl ? [activeRelaySelection.relayUrl] : [])
    }
    if (feedInfo.feedType === 'relays') {
      return dedupeRelayUrlsByIdentity(relayUrls)
    }
    return []
  }, [activeRelaySelection?.relayUrl, feedInfo.feedType, relayUrls])

  const subRequests = useMemo(
    () =>
      effectiveRelayUrls.length > 0
        ? [{ source: 'relays' as const, urls: effectiveRelayUrls, filter: {} }]
        : [],
    [effectiveRelayUrls]
  )

  if (feedInfo.feedType !== 'relay' && feedInfo.feedType !== 'relays') {
    return null
  }

  if (
    feedInfo.feedType === 'relay'
    && activeRelaySelection?.isWorkerManagedGroupRelay
    && !activeRelaySelection.isReadyForReq
  ) {
    return <div className="text-center text-sm text-muted-foreground">{t('loading...')}</div>
  }

  if (!subRequests.length) {
    return null
  }

  return <NormalFeed subRequests={subRequests} isMainFeed showRelayCloseReason />
}
