import NewNotesButton from '@/components/NewNotesButton'
import { Button } from '@/components/ui/button'
import { isMentioningMutedUsers, isReplyNoteEvent } from '@/lib/event'
import { batchDebounce, isTouchDevice } from '@/lib/utils'
import { useContentPolicy } from '@/providers/ContentPolicyProvider'
import { useDeletedEvent } from '@/providers/DeletedEventProvider'
import { useMuteList } from '@/providers/MuteListProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useUserTrust } from '@/providers/UserTrustProvider'
import client from '@/services/client.service'
import { TFeedSubRequest } from '@/types'
import dayjs from 'dayjs'
import { Event, NostrEvent, verifyEvent } from '@jsr/nostr__tools/wasm'
import * as kinds from '@jsr/nostr__tools/kinds'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import PullToRefresh from 'react-simple-pull-to-refresh'
import { toast } from 'sonner'
import NoteCard, { NoteCardLoadingSkeleton } from '../NoteCard'
import PinnedNoteCard from '../PinnedNoteCard'

const LIMIT = 200
const SHOW_COUNT = 10

function normalizeFeedRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFeedRequestValue(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeFeedRequestValue(entryValue)])
    )
  }

  return value
}

function getFeedSubRequestsSignature(subRequests: TFeedSubRequest[]) {
  return JSON.stringify(subRequests.map((request) => normalizeFeedRequestValue(request)))
}

const NoteList = forwardRef(
  (
    {
      subRequests,
      showKinds,
      filterMutedNotes = true,
      hideReplies = false,
      showOnlyReplies = false,
      hideUntrustedNotes = false,
      showRelayCloseReason = false,
      debugActiveTab,
      debugLabel,
      timelineLabel,
      sinceTimestamp,
      onNotesLoaded,
      pinnedEventIds,
      filterFn
    }: {
      subRequests: TFeedSubRequest[]
      showKinds: number[]
      filterMutedNotes?: boolean
      hideReplies?: boolean
      showOnlyReplies?: boolean
      hideUntrustedNotes?: boolean
      showRelayCloseReason?: boolean
      debugActiveTab?: string
      debugLabel?: string
      timelineLabel?: string
      sinceTimestamp?: number
      onNotesLoaded?: (count: number, hasPosts: boolean, hasReplies: boolean) => void
      pinnedEventIds?: string[]
      filterFn?: (event: Event) => boolean
    },
    ref
  ) => {
    const { t } = useTranslation()
    const { startLogin, pubkey } = useNostr()
    const { isUserTrusted } = useUserTrust()
    const { mutePubkeySet } = useMuteList()
    const { hideContentMentioningMutedUsers } = useContentPolicy()
    const { isEventDeleted } = useDeletedEvent()
    const [events, setEvents] = useState<Event[]>([])
    const [newEvents, setNewEvents] = useState<Event[]>([])
    const [hasMore, setHasMore] = useState<boolean>(false)
    const [loading, setLoading] = useState(true)
    const [refreshCount, setRefreshCount] = useState(0)
    const [showCount, setShowCount] = useState(SHOW_COUNT)
    const [isFilteredView, setIsFilteredView] = useState(!!sinceTimestamp)
    const supportTouch = useMemo(() => isTouchDevice(), [])
    const bottomRef = useRef<HTMLDivElement | null>(null)
    const topRef = useRef<HTMLDivElement | null>(null)
    const hasLoggedMount = useRef(false)
    const effectIdRef = useRef(0)
    const prevSnapshotRef = useRef<Record<string, unknown> | null>(null)
    const resubscribeTimerRef = useRef<number | null>(null)
    const resubscribeAttemptRef = useRef(0)
    const softResubscribeRef = useRef(false)
    // Callers often inline `subRequests`; keep the subscription stable
    // unless the request payload actually changes.
    const subRequestsSignature = useMemo(
      () => getFeedSubRequestsSignature(subRequests),
      [subRequests]
    )
    const stableSubRequests = useMemo(() => subRequests, [subRequestsSignature])
    const showKindsKey = useMemo(() => showKinds.join(','), [showKinds])

    const shouldHideEvent = useCallback(
      (evt: Event) => {
        if (pinnedEventIds && pinnedEventIds.includes(evt.id)) return true
        if (isEventDeleted(evt)) return true
        if (hideReplies && isReplyNoteEvent(evt)) return true
        if (showOnlyReplies && !isReplyNoteEvent(evt)) return true
        if (hideUntrustedNotes && !isUserTrusted(evt.pubkey)) return true
        if (filterMutedNotes && mutePubkeySet.has(evt.pubkey)) return true
        if (
          filterMutedNotes &&
          hideContentMentioningMutedUsers &&
          isMentioningMutedUsers(evt, mutePubkeySet)
        ) {
          return true
        }
        if (filterFn && !filterFn(evt)) {
          return true
        }

        return false
      },
      [
        hideReplies,
        showOnlyReplies,
        hideUntrustedNotes,
        mutePubkeySet,
        pinnedEventIds,
        isEventDeleted,
        filterFn
      ]
    )

    const filteredEvents = useMemo(() => {
      const repostersMap = new Map<string, string[]>()
      const filteredEvents: { event: NostrEvent; reposters: string[] }[] = []

      for (let i = 0; i < Math.min(events.length, showCount); i++) {
        const event = events[i]

        if (shouldHideEvent(event)) continue

        if (event.kind !== kinds.Repost) {
          // for all events just stop processing here, this is it
          filteredEvents.push({ event, reposters: [] })
          continue
        }

        // except reposts, for these we will do some grouping
        let eventFromContent: NostrEvent
        try {
          eventFromContent = JSON.parse(event.content) as NostrEvent
        } catch (_err) {
          continue
        }

        // before we verify anything let's check if we have already seen this
        let reposters = repostersMap.get(eventFromContent.id)
        if (!reposters) {
          // we haven't seen it:
          reposters = []

          if (shouldHideEvent(eventFromContent)) continue
          if (!verifyEvent(eventFromContent)) continue

          const targetSeenOn = client.getSeenEventRelays(eventFromContent.id)
          if (targetSeenOn.length === 0) {
            const seenOn = client.getSeenEventRelays(event.id)
            seenOn.forEach((relay) => {
              client.trackEventSeenOn(eventFromContent.id, relay)
            })
          }

          filteredEvents.push({ event: eventFromContent, reposters })
        }

        // now that we have it all set up and this repost added to the list add the current reposter
        if (!reposters.includes(event.pubkey)) {
          reposters.push(event.pubkey)
        }
        repostersMap.set(eventFromContent.id, reposters)
      }

      return filteredEvents
    }, [events, showCount, shouldHideEvent])

    const scrollToTop = (behavior: ScrollBehavior = 'instant') => {
      setTimeout(() => {
        topRef.current?.scrollIntoView({ behavior, block: 'start' })
      }, 20)
    }

    const refresh = () => {
      scrollToTop()
      setTimeout(() => {
        setRefreshCount((count) => count + 1)
      }, 500)
    }

    useImperativeHandle(ref, () => ({ scrollToTop, refresh }), [])

    useEffect(() => {
      const activeTab = debugActiveTab ?? 'unknown'
      if (!hasLoggedMount.current) {
        console.info('[NoteList] mount', {
          label: debugLabel ?? null,
          activeTab,
          subRequests: stableSubRequests.length
        })
        hasLoggedMount.current = true
      }
      if (debugLabel || debugActiveTab) {
        console.info('[NoteList] activeTab change', {
          label: debugLabel ?? null,
          activeTab
        })
      }
    }, [debugActiveTab, debugLabel, stableSubRequests.length])

    useEffect(() => {
      const effectId = ++effectIdRef.current
      const activeTab = debugActiveTab ?? 'unknown'
      const snapshot = {
        effectId,
        label: debugLabel ?? null,
        activeTab,
        subRequestsCount: stableSubRequests.length,
        subRequestsSignature,
        showKindsKey,
        timelineLabel: timelineLabel ?? null,
        refreshCount,
        sinceTimestamp: sinceTimestamp ?? null,
        isFilteredView
      }
      const prev = prevSnapshotRef.current
      const changes =
        prev === null
          ? ['initial']
          : Object.keys(snapshot).filter(
              (key) => (snapshot as Record<string, unknown>)[key] !== prev[key]
            )
      prevSnapshotRef.current = snapshot

      console.info('[NoteList] subscribe effect', {
        ...snapshot,
        changes
      })

      const softResubscribe = softResubscribeRef.current
      if (!softResubscribe) {
        resubscribeAttemptRef.current = 0
      }
      softResubscribeRef.current = false
      if (!stableSubRequests.length) return

      if (!softResubscribe) {
        setLoading(true)
        setEvents([])
        setNewEvents([])
        setHasMore(true)
      } else {
        setLoading(true)
      }

      if (showKinds.length === 0) {
        setLoading(false)
        setHasMore(false)
        return () => {}
      }

      const groupRelayUrls = new Set(
        stableSubRequests
          .filter((req): req is Extract<TFeedSubRequest, { source: 'relays' }> => {
            if (req.source !== 'relays') return false
            const hTags = (req.filter as { ['#h']?: string[] })?.['#h']
            return Array.isArray(hTags) && hTags.length > 0
          })
          .flatMap((req) => req.urls)
      )
      const canResubscribe = groupRelayUrls.size > 0

      const scheduleResubscribe = (url: string, reason: string) => {
        if (!canResubscribe || !groupRelayUrls.has(url)) return
        if (resubscribeTimerRef.current !== null) return
        resubscribeAttemptRef.current += 1
        const attempt = resubscribeAttemptRef.current
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 15000)
        softResubscribeRef.current = true
        console.info('[NoteList] resubscribe scheduled', {
          label: debugLabel ?? null,
          url,
          reason,
          attempt,
          delayMs
        })
        resubscribeTimerRef.current = window.setTimeout(() => {
          resubscribeTimerRef.current = null
          setRefreshCount((curr) => curr + 1)
        }, delayMs)
      }

      const subc = client.subscribeTimeline(
        stableSubRequests,
        {
          kinds: showKinds,
          limit: LIMIT,
          ...(sinceTimestamp && isFilteredView ? { since: sinceTimestamp } : {})
        },
        {
          async onEvents(events, isFinal) {
            if (isFinal) {
              setLoading(false)
              setHasMore(events.length > 0)

              if (onNotesLoaded) {
                // notify parent about notes composition (notes vs replies)
                let hasPosts = false
                let hasReplies = false
                for (let i = 0; i < events.length; i++) {
                  if (isReplyNoteEvent(events[i])) {
                    hasReplies = true
                  } else {
                    hasPosts = true
                  }
                  if (hasReplies && hasPosts) break
                }
                onNotesLoaded(events.length, hasPosts, hasReplies)
              }
            }

            if (events.length > 0) {
              setEvents(events)
            }
          },
          onNew: batchDebounce((newEvents) => {
            // do everything inside this setter so we get the latest state (because react is incredibly retarded)
            setEvents((events) => {
              const pending: Event[] = []
              const appended: Event[] = []

              for (let i = 0; i < newEvents.length; i++) {
                const newEvent = newEvents[i]

                // TODO: figure out where exactly the viewport is: for now just assume it's at the top
                if (events.length < 7 || newEvent.created_at < events[6].created_at) {
                  // if there are very few events in the viewport or the new events would be inserted below, just append
                  appended.push(newEvent)
                } else if (pubkey && newEvent.pubkey === pubkey) {
                  // our own notes are also inserted regardless of any concern
                  appended.push(newEvent)
                } else {
                  // any other "new" notes that would be inserted above, make them be pending in the modal thingie
                  pending.push(newEvent)
                }
              }

              if (pending.length) {
                // sort these as they will not come in order (they will come from different author syncing processes)
                pending.sort((a, b) => b.created_at - a.created_at)
                // prepend them to the top
                setNewEvents((curr) => [...pending, ...curr])
              }

              // we have no idea of the order here, so just sort everything and eliminate duplicates
              if (appended.length) {
                const all = [...events, ...appended].sort((a, b) => b.created_at - a.created_at)
                return all.filter((evt, i) => i === 0 || evt.id !== all[i - 1].id)
              } else {
                return events
              }
            })
          }, 1800),
          onClose(url, reason) {
            if (reason === 'relay connection closed') {
              scheduleResubscribe(url, reason)
            }
            if (!showRelayCloseReason) return
            // ignore reasons from @jsr/nostr__tools
            if (
              [
                'closed by caller',
                'relay connection errored',
                'relay connection closed',
                'pingpong timed out',
                'relay connection closed by us'
              ].includes(reason)
            ) {
              return
            }

            toast.error(`${url}: ${reason}`)
          }
        },
        {
          startLogin,
          timelineLabel
        }
      )

      return () => {
        if (resubscribeTimerRef.current !== null) {
          clearTimeout(resubscribeTimerRef.current)
          resubscribeTimerRef.current = null
        }
        console.info('[NoteList] subscribe cleanup', {
          effectId,
          label: debugLabel ?? null,
          activeTab,
          subRequestsCount: stableSubRequests.length
        })
        subc.close(`NoteList cleanup effectId=${effectId}`)
      }
    }, [stableSubRequests, subRequestsSignature, refreshCount, showKindsKey, timelineLabel])

    const loadMore = useCallback(async () => {
      setEvents((events) => {
        // do this update inside the events setter because react is stupid and that's
        // the only safe way to get the latest events state

        if (showCount < events.length) {
          setShowCount((prev) => prev + SHOW_COUNT)
          // do we need to preload more?
          if (events.length - showCount > LIMIT / 2) {
            // no, we don't
            return events
          }
        }

        setLoading(true)

        client
          .loadMoreTimeline(stableSubRequests, {
            until: events.length ? events[events.length - 1].created_at - 1 : dayjs().unix(),
            limit: LIMIT,
            ...(sinceTimestamp && isFilteredView ? { since: sinceTimestamp } : {})
          })
          .then((moreEvents) => {
            if (moreEvents.length === 0) {
              // we have nothing more to load
              setHasMore(false)
              return
            }

            setLoading(false)
            setEvents((events) => [...events, ...moreEvents])
            return
          })

        return events // bogus, just return the same thing
      })
    }, [showCount, stableSubRequests, sinceTimestamp, isFilteredView])

    useEffect(() => {
      if (!hasMore || loading || isFilteredView) return

      const observerInstance = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMore) {
            loadMore()
          }
        },
        {
          root: null,
          rootMargin: '10px',
          threshold: 0.1
        }
      )

      const currentBottomRef = bottomRef.current

      if (currentBottomRef) {
        observerInstance.observe(currentBottomRef)
      }

      return () => {
        if (observerInstance && currentBottomRef) {
          observerInstance.unobserve(currentBottomRef)
        }
      }
    }, [hasMore, loading, isFilteredView, loadMore])

    function mergeNewEvents() {
      setEvents((oldEvents) => [...newEvents, ...oldEvents])
      setNewEvents([])
      setTimeout(() => {
        scrollToTop('smooth')
      }, 0)
    }

    const list = (
      <div className="min-h-screen">
        {(pinnedEventIds || []).map((id) => (
          <PinnedNoteCard key={id} eventId={id} className="w-full" />
        ))}

        {filteredEvents.map(({ event, reposters }) => (
          <NoteCard
            key={
              event.id +
              // this differentiates between reposts and direct notes:
              ':' +
              reposters.length
            }
            className="w-full"
            event={event}
            filterMutedNotes={filterMutedNotes}
            reposters={reposters}
          />
        ))}
        {hasMore || loading ? (
          <div ref={bottomRef}>
            <NoteCardLoadingSkeleton />
          </div>
        ) : isFilteredView && events.length > 0 ? (
          <div className="flex justify-center items-center mt-4 p-4">
            <Button
              size="lg"
              onClick={async () => {
                setIsFilteredView(false)
                setHasMore(true)
              }}
            >
              {t('Load more notes')}
            </Button>
          </div>
        ) : hasMore || loading ? (
          <div ref={bottomRef}>
            <NoteCardLoadingSkeleton />
          </div>
        ) : events.length && !hasMore ? (
          <div className="text-center text-sm text-muted-foreground mt-2">{t('no more notes')}</div>
        ) : !loading && !events.length ? (
          <div className="flex justify-center w-full mt-2">
            <Button size="lg" onClick={() => setRefreshCount((count) => count + 1)}>
              {t('reload notes')}
            </Button>
          </div>
        ) : null}
      </div>
    )

    return (
      <div>
        <div ref={topRef} className="scroll-mt-[calc(6rem+1px)]" />
        {supportTouch ? (
          <PullToRefresh
            onRefresh={async () => {
              refresh()
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }}
            pullingContent=""
          >
            {list}
          </PullToRefresh>
        ) : (
          list
        )}
        <div className="h-40" />
        {newEvents.length > 0 && <NewNotesButton newEvents={newEvents} onClick={mergeNewEvents} />}
      </div>
    )
  }
)

NoteList.displayName = 'NoteList'
export default NoteList

export type TNoteListRef = {
  scrollToTop: (behavior?: ScrollBehavior) => void
  refresh: () => void
}
