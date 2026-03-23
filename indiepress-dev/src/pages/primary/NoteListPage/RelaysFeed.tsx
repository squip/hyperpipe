import NormalFeed from '@/components/NormalFeed'
import useFeedRelayOptions from '@/hooks/useFeedRelayOptions'
import { buildRelayFeedSubRequests } from '@/lib/feed-subrequests'
import { dedupeRelayUrlsByIdentity } from '@/lib/relay-targets'
import { useFeed } from '@/providers/FeedProvider'
import { useMemo } from 'react'

function isLocalRelayProxyUrl(relay?: string | null) {
  if (!relay) return false
  try {
    const parsed = new URL(relay)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch (_err) {
    return /^wss?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(relay)
  }
}

export default function RelaysFeed() {
  const { feedInfo, relayUrls } = useFeed()
  const { getGroupRelaySelectionState, getRelaySelectionState } = useFeedRelayOptions()

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

  const effectiveRelayUrls = useMemo(() => {
    if (feedInfo.feedType === 'relay') {
      return dedupeRelayUrlsByIdentity(
        feedInfo.localGroupRelay?.groupId
          ? relayUrls
          : activeRelaySelection?.relayUrl
            ? [activeRelaySelection.relayUrl]
            : []
      )
    }
    if (feedInfo.feedType === 'relays') {
      return dedupeRelayUrlsByIdentity(relayUrls)
    }
    return []
  }, [activeRelaySelection?.relayUrl, feedInfo.feedType, feedInfo.localGroupRelay?.groupId, relayUrls])

  const storedLocalGroupId = useMemo(() => {
    const value = feedInfo.feedType === 'relay' ? feedInfo.localGroupRelay?.groupId : null
    const normalized = String(value || '').trim()
    return normalized || null
  }, [feedInfo.feedType, feedInfo.localGroupRelay?.groupId])
  const shouldTreatAsLocalGroupRelay =
    feedInfo.feedType === 'relay' &&
    Boolean(storedLocalGroupId || activeRelaySelection?.isLocalGroupRelay)
  const localGroupId = storedLocalGroupId || activeRelaySelection?.groupState?.groupId || null
  const shouldDeferUnclassifiedLocalRelay =
    feedInfo.feedType === 'relay' &&
    !shouldTreatAsLocalGroupRelay &&
    isLocalRelayProxyUrl(feedInfo.id || activeRelaySelection?.relayUrl) &&
    !activeRelaySelection?.isReadyForReq

  const subRequests = useMemo(
    () => {
      if (feedInfo.feedType === 'relay' && shouldTreatAsLocalGroupRelay) {
        return buildRelayFeedSubRequests({
          relayUrls: effectiveRelayUrls,
          groupId: localGroupId,
          warmHydrateLocalGroupRelay: true,
          relayReadyForReq: activeRelaySelection?.isReadyForReq ?? false,
          relaySinceOverlapSeconds: 10
        })
      }

      if (shouldDeferUnclassifiedLocalRelay) {
        console.info('[RelaysFeed] deferring local relay subscription until relay is ready', {
          relay: feedInfo.id || activeRelaySelection?.relayUrl || null
        })
        return []
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
      feedInfo.feedType,
      feedInfo.id,
      localGroupId,
      shouldDeferUnclassifiedLocalRelay,
      shouldTreatAsLocalGroupRelay
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
