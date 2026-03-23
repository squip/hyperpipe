import NormalFeed from '@/components/NormalFeed'
import useFeedRelayOptions from '@/hooks/useFeedRelayOptions'
import { buildRelayFeedSubRequests } from '@/lib/feed-subrequests'
import { dedupeRelayUrlsByIdentity } from '@/lib/relay-targets'
import { useFeed } from '@/providers/FeedProvider'
import { useMemo } from 'react'

export default function RelaysFeed() {
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
    () => {
      if (feedInfo.feedType === 'relay' && activeRelaySelection?.isLocalGroupRelay) {
        return buildRelayFeedSubRequests({
          relayUrls: effectiveRelayUrls,
          groupId: activeRelaySelection.groupState?.groupId,
          warmHydrateLocalGroupRelay: true,
          relayReadyForReq: activeRelaySelection.isReadyForReq,
          relaySinceOverlapSeconds: 10
        })
      }

      return buildRelayFeedSubRequests({
        relayUrls: effectiveRelayUrls
      })
    },
    [
      activeRelaySelection?.groupState?.groupId,
      activeRelaySelection?.isLocalGroupRelay,
      activeRelaySelection?.isReadyForReq,
      effectiveRelayUrls,
      feedInfo.feedType
    ]
  )

  if (feedInfo.feedType !== 'relay' && feedInfo.feedType !== 'relays') {
    return null
  }

  if (!subRequests.length) {
    return null
  }

  return <NormalFeed subRequests={subRequests} isMainFeed showRelayCloseReason />
}
