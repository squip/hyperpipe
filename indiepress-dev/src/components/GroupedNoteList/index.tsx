import NewNotesButton from '@/components/NewNotesButton'
import { Button } from '@/components/ui/button'
import { isMentioningMutedUsers, isReplyNoteEvent, isFirstLevelReply } from '@/lib/event'
import { batchDebounce, isTouchDevice } from '@/lib/utils'
import { useContentPolicy } from '@/providers/ContentPolicyProvider'
import { useDeletedEvent } from '@/providers/DeletedEventProvider'
import { useMuteList } from '@/providers/MuteListProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useGroupedNotes } from '@/providers/GroupedNotesProvider'
import { useGroupedNotesReadStatus } from '@/hooks/useGroupedNotesReadStatus'
import { getTimeFrameInMs } from '@/providers/GroupedNotesProvider'
import client from '@/services/client.service'
import { TFeedSubRequest } from '@/types'
import { Event, NostrEvent } from '@nostr/tools/wasm'
import * as kinds from '@nostr/tools/kinds'
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
import NoteCard from '../NoteCard'
import CompactedEventCard from '../CompactedEventCard'
import GroupedNotesEmptyState from '../GroupedNotesEmptyState'
import { usePinBury } from '@/providers/PinBuryProvider'

type TNoteGroup = {
  topNote: NostrEvent
  totalNotes: number
  oldestTimestamp: number
  newestTimestamp: number
  allNoteTimestamps: number[]
}

type GroupedNoteListSnapshot = {
  subRequestsSignature: string
  showKindsKey: string
  settingsSignature: string
  events: Event[]
  updatedAt: number
}

const groupedNoteListSnapshotCache = new Map<string, GroupedNoteListSnapshot>()
type RefreshTrigger = 'imperative-ref' | 'empty-state-button' | 'pull-to-refresh'
const EMPTY_FINAL_FALLBACK_DELAY_MS = 300

const GroupedNoteList = forwardRef(
  (
    {
      subRequests,
      showKinds,
      filterMutedNotes = true,
      showRelayCloseReason = false,
      onNotesLoaded,
      userFilter = '',
      filterFn,
      debugActiveTab,
      debugLabel
    }: {
      subRequests: TFeedSubRequest[]
      showKinds: number[]
      filterMutedNotes?: boolean
      showRelayCloseReason?: boolean
      onNotesLoaded?: (
        hasNotes: boolean,
        hasReplies: boolean,
        notesCount: number,
        repliesCount: number
      ) => void
      userFilter?: string
      filterFn?: (event: Event) => boolean
      debugActiveTab?: string
      debugLabel?: string
    },
    ref
  ) => {
    const { t } = useTranslation()
    const { startLogin, pubkey } = useNostr()
    const { mutePubkeySet } = useMuteList()
    const { hideContentMentioningMutedUsers } = useContentPolicy()
    const { isEventDeleted } = useDeletedEvent()
    const { resetSettings, settings } = useGroupedNotes()
    const { markLastNoteRead, markAllNotesRead, getReadStatus, getUnreadCount, markAsUnread } =
      useGroupedNotesReadStatus()
    const [events, setEvents] = useState<Event[]>([])
    const [newEvents, setNewEvents] = useState<Event[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshCount, setRefreshCount] = useState(0)
    const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
    const [matchingPubkeys, setMatchingPubkeys] = useState<Set<string> | null>(null)
    const supportTouch = useMemo(() => isTouchDevice(), [])
    const topRef = useRef<HTMLDivElement | null>(null)
    const hasLoggedMount = useRef(false)
    const effectIdRef = useRef(0)
    const prevSnapshotRef = useRef<Record<string, unknown> | null>(null)
    const settingsIdentityRef = useRef(settings)
    const resubscribeTimerRef = useRef<number | null>(null)
    const resubscribeAttemptRef = useRef(0)
    const emptyFinalFallbackTimerRef = useRef<number | null>(null)
    const emptyFinalFallbackAttemptedRef = useRef(false)
    const emptyFinalFallbackContextRef = useRef<string>('')
    const emptyFinalAutoRetryTimerRef = useRef<number | null>(null)
    const emptyFinalAutoRetryCountRef = useRef(0)
    const softResubscribeRef = useRef(false)
    const eventsRef = useRef<Event[]>([])
    const snapshotCacheKey = useMemo(() => debugLabel || null, [debugLabel])
    const { getPinBuryState } = usePinBury()
    const timelineLabel = useMemo(() => {
      const relayReq = subRequests.find(
        (
          req
        ): req is Extract<TFeedSubRequest, { source: 'relays' }> =>
          req.source === 'relays' && Array.isArray((req.filter as { ['#h']?: string[] })?.['#h'])
      )
      const hTag = relayReq ? (relayReq.filter as { ['#h']?: string[] })?.['#h']?.[0] : null
      if (!hTag) return undefined
      const normalized = String(hTag)
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 24)
      return `f-timeline-group-${normalized || 'default'}`
    }, [subRequests])

    const [{ noteGroups, hasNoResults }, setNoteGroups] = useState<{
      noteGroups: TNoteGroup[]
      hasNoResults: boolean
    }>({
      noteGroups: [],
      hasNoResults: false
    })

    useEffect(() => {
      eventsRef.current = events
      if (!snapshotCacheKey || events.length === 0) return
      const settingsSignature = JSON.stringify({
        includeReplies: settings.includeReplies,
        showOnlyFirstLevelReplies: settings.showOnlyFirstLevelReplies,
        hideShortNotes: settings.hideShortNotes,
        wordFilter: settings.wordFilter,
        maxNotesFilter: settings.maxNotesFilter,
        timeFrame: settings.timeFrame
      })
      const subRequestsSignature = JSON.stringify(
        subRequests.map((req) => {
          if (req.source === 'local') {
            return { source: 'local', filterKeys: Object.keys(req.filter ?? {}) }
          }
          const hTag = Array.isArray(req.filter?.['#h']) ? req.filter['#h'][0] : undefined
          return {
            source: 'relays',
            urls: req.urls,
            filterKeys: Object.keys(req.filter ?? {}),
            kindsCount: Array.isArray(req.filter?.kinds) ? req.filter.kinds.length : 0,
            hTag: hTag ? String(hTag).slice(0, 32) : null
          }
        })
      )
      groupedNoteListSnapshotCache.set(snapshotCacheKey, {
        subRequestsSignature,
        showKindsKey: showKinds.join(','),
        settingsSignature,
        events,
        updatedAt: Date.now()
      })
    }, [events, settings, showKinds, snapshotCacheKey, subRequests])

    useEffect(() => {
      let filteredEvents = events

      if (!settings.includeReplies) {
        filteredEvents = filteredEvents.filter((event) => !isReplyNoteEvent(event))
      }

      // filter by word filter (content and hashtags)
      if (settings.wordFilter.trim()) {
        const filterWords = settings.wordFilter
          .split(',')
          .map((word) => word.trim().toLowerCase())
          .filter((word) => word.length > 0)

        if (filterWords.length > 0) {
          filteredEvents = filteredEvents.filter((event) => {
            // get content in lowercase for case-insensitive matching
            const content = (event.content || '').toLowerCase()

            // get hashtags from tags
            const hashtags = event.tags
              .filter((tag) => tag[0] === 't' && tag[1])
              .map((tag) => tag[1].toLowerCase())

            // check if any filter word matches content or hashtags
            const hasMatchInContent = filterWords.some((word) => content.includes(word))
            const hasMatchInHashtags = filterWords.some((word) =>
              hashtags.some((hashtag) => hashtag.includes(word))
            )

            // return true to KEEP the event (filter OUT filteredEvents that match)
            return !hasMatchInContent && !hasMatchInHashtags
          })
        }
      }

      // filter out short notes (single words or less than 10 characters)
      if (settings.hideShortNotes) {
        filteredEvents = filteredEvents.filter((event) => {
          const content = (event.content || '').trim()

          // filter out if content is less than 10 characters
          if (content.length < 10) {
            return false
          }

          // filter out emoji-only notes
          // remove emojis and check if there's any substantial text left
          // using Unicode property escapes to match all emoji characters
          const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu
          const contentWithoutEmojis = content.replace(emojiRegex, '').replace(/\s+/g, '').trim()
          if (contentWithoutEmojis.length < 2) {
            return false
          }

          // filter out single words (no spaces or only one word)
          const words = content.split(/\s+/).filter((word) => word.length > 0)
          if (words.length === 1) {
            return false
          }

          return true
        })
      }

      // group events by author pubkey
      let noteGroups: TNoteGroup[] = []
      const authorIndexes = new Map<string, number>()

      for (let i = 0; i < filteredEvents.length; i++) {
        const event = filteredEvents[i]

        const idx = authorIndexes.get(event.pubkey)
        if (idx !== undefined) {
          const group = noteGroups[idx]
          group.allNoteTimestamps.push(event.created_at)
          group.oldestTimestamp = event.created_at
          group.totalNotes++
        } else {
          authorIndexes.set(event.pubkey, noteGroups.length)
          noteGroups.push({
            allNoteTimestamps: [event.created_at],
            newestTimestamp: event.created_at,
            oldestTimestamp: event.created_at,
            topNote: event,
            totalNotes: 1
          })
        }
      }

      // apply activity level filter
      if (settings.maxNotesFilter > 0) {
        for (let i = noteGroups.length - 1; i >= 0; i--) {
          const group = noteGroups[i]
          if (group.totalNotes > settings.maxNotesFilter) {
            noteGroups.splice(i, 1)
          }
        }
      }

      // sort final notes by pin/bury state (everything is already sorted by created_at descending)
      const pinned: TNoteGroup[] = []
      const buried: TNoteGroup[] = []
      for (let i = noteGroups.length - 1; i >= 0; i--) {
        const group = noteGroups[i]
        switch (getPinBuryState(group.topNote.pubkey)) {
          case 'pinned':
            pinned.push(group)
            noteGroups.splice(i, 1)
            break
          case 'buried':
            buried.push(group)
            noteGroups.splice(i, 1)
            break
        }
      }
      noteGroups = [...pinned.reverse(), ...noteGroups, ...buried.reverse()]

      setNoteGroups({
        noteGroups,
        hasNoResults: filteredEvents.length === 0 && events.length > 0
      })
    }, [events, settings, getPinBuryState])

    const shouldHideEvent = useCallback(
      (evt: Event) => {
        if (isEventDeleted(evt)) return true
        // Filter nested replies when showOnlyFirstLevelReplies is enabled
        if (
          settings.includeReplies &&
          settings.showOnlyFirstLevelReplies &&
          isReplyNoteEvent(evt) &&
          !isFirstLevelReply(evt)
        ) {
          return true
        }
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
      [mutePubkeySet, isEventDeleted, settings, filterFn]
    )

    // update matching pubkeys when user filter changes
    useEffect(() => {
      if (!userFilter.trim()) {
        setMatchingPubkeys(null)
        return
      }

      const searchProfiles = async () => {
        try {
          const pubkeys = await client.searchPubKeysFromLocal(userFilter, 1000)
          setMatchingPubkeys(new Set(pubkeys))
        } catch (error) {
          console.error('Error searching profiles:', error)
          setMatchingPubkeys(new Set())
        }
      }

      searchProfiles()
    }, [userFilter])

    // apply author name filter
    const nameFilteredGroups = useMemo(() => {
      if (!userFilter.trim() || matchingPubkeys === null) {
        return noteGroups
      }

      return noteGroups.filter((group) => matchingPubkeys.has(group.topNote.pubkey))
    }, [noteGroups, userFilter, matchingPubkeys])

    // notify parent about notes composition (notes vs replies)
    useEffect(() => {
      if (!onNotesLoaded || loading || events.length === 0) return

      const notesCount = events.filter((evt) => !isReplyNoteEvent(evt)).length
      const repliesCount = events.filter((evt) => isReplyNoteEvent(evt)).length
      const hasNotes = notesCount > 0
      const hasReplies = repliesCount > 0

      onNotesLoaded(hasNotes, hasReplies, notesCount, repliesCount)
    }, [events, loading, onNotesLoaded])

    const scrollToTop = (behavior: ScrollBehavior = 'instant') => {
      setTimeout(() => {
        topRef.current?.scrollIntoView({ behavior, block: 'start' })
      }, 20)
    }

    const resetEmptyFinalFallbackState = (trigger: RefreshTrigger) => {
      const attempted = emptyFinalFallbackAttemptedRef.current
      emptyFinalFallbackAttemptedRef.current = false
      if (emptyFinalFallbackTimerRef.current !== null) {
        clearTimeout(emptyFinalFallbackTimerRef.current)
        emptyFinalFallbackTimerRef.current = null
      }
      if (emptyFinalAutoRetryTimerRef.current !== null) {
        clearTimeout(emptyFinalAutoRetryTimerRef.current)
        emptyFinalAutoRetryTimerRef.current = null
      }
      emptyFinalAutoRetryCountRef.current = 0
      console.info('[GroupedNoteList] empty-final fallback state reset', {
        label: debugLabel ?? null,
        activeTab: debugActiveTab ?? null,
        trigger,
        attempted
      })
    }

    const refresh = (trigger: RefreshTrigger = 'imperative-ref') => {
      console.info('[GroupedNoteList] refresh requested', {
        label: debugLabel ?? null,
        activeTab: debugActiveTab ?? null,
        trigger,
        refreshCount,
        eventsCount: eventsRef.current.length,
        loading
      })
      resetEmptyFinalFallbackState(trigger)
      // Avoid jumping the entire GroupPage header when user clicks reload in empty state.
      if (trigger !== 'empty-state-button') {
        scrollToTop()
      }
      setTimeout(() => {
        // Keep existing notes while forcing a resubscribe to avoid UI flicker/empty-state flashes.
        softResubscribeRef.current = true
        setRefreshCount((count) => {
          const next = count + 1
          console.info('[GroupedNoteList] refreshCount increment', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            trigger,
            from: count,
            to: next
          })
          return next
        })
      }, 500)
    }

    useImperativeHandle(
      ref,
      () => ({
        scrollToTop,
        refresh: () => refresh('imperative-ref')
      }),
      [refresh]
    )

    useEffect(() => {
      if (hasLoggedMount.current) return
      console.info('[GroupedNoteList] mount', {
        label: debugLabel ?? null,
        activeTab: debugActiveTab ?? null,
        subRequests: subRequests.length
      })
      hasLoggedMount.current = true
    }, [debugActiveTab, subRequests.length])

    useEffect(() => {
      if (!debugLabel && !debugActiveTab) return
      console.info('[GroupedNoteList] activeTab change', {
        label: debugLabel ?? null,
        activeTab: debugActiveTab ?? null
      })
    }, [debugLabel, debugActiveTab])

    useEffect(() => {
      const effectId = ++effectIdRef.current
      const subRequestsSignature = JSON.stringify(
        subRequests.map((req) => {
          if (req.source === 'local') {
            return { source: 'local', filterKeys: Object.keys(req.filter ?? {}) }
          }
          const hTag = Array.isArray(req.filter?.['#h']) ? req.filter['#h'][0] : undefined
          return {
            source: 'relays',
            urls: req.urls,
            filterKeys: Object.keys(req.filter ?? {}),
            kindsCount: Array.isArray(req.filter?.kinds) ? req.filter.kinds.length : 0,
            hTag: hTag ? String(hTag).slice(0, 32) : null
          }
        })
      )
      const settingsSignature = JSON.stringify({
        includeReplies: settings.includeReplies,
        showOnlyFirstLevelReplies: settings.showOnlyFirstLevelReplies,
        hideShortNotes: settings.hideShortNotes,
        wordFilter: settings.wordFilter,
        maxNotesFilter: settings.maxNotesFilter,
        timeFrame: settings.timeFrame
      })
      const retryContextKey = `${subRequestsSignature}|${showKinds.join(',')}|${settingsSignature}`
      if (emptyFinalFallbackContextRef.current !== retryContextKey) {
        emptyFinalFallbackContextRef.current = retryContextKey
        emptyFinalFallbackAttemptedRef.current = false
        if (emptyFinalFallbackTimerRef.current !== null) {
          clearTimeout(emptyFinalFallbackTimerRef.current)
          emptyFinalFallbackTimerRef.current = null
        }
        if (emptyFinalAutoRetryTimerRef.current !== null) {
          clearTimeout(emptyFinalAutoRetryTimerRef.current)
          emptyFinalAutoRetryTimerRef.current = null
        }
        emptyFinalAutoRetryCountRef.current = 0
      }
      const snapshot = {
        effectId,
        label: debugLabel ?? null,
        activeTab: debugActiveTab ?? null,
        subRequestsCount: subRequests.length,
        subRequestsSignature,
        showKindsKey: showKinds.join(','),
        refreshCount,
        settingsSignature,
        settingsIdentityChanged: settingsIdentityRef.current !== settings
      }
      const prev = prevSnapshotRef.current
      const changes =
        prev === null
          ? ['initial']
          : Object.keys(snapshot).filter(
              (key) => (snapshot as Record<string, unknown>)[key] !== prev[key]
            )
      prevSnapshotRef.current = snapshot
      settingsIdentityRef.current = settings

      console.info('[GroupedNoteList] subscribe effect', {
        ...snapshot,
        changes
      })

      const softResubscribe = softResubscribeRef.current
      if (!softResubscribe) {
        resubscribeAttemptRef.current = 0
      }
      softResubscribeRef.current = false

      if (!subRequests.length) return

      const sameSubscriptionInputs =
        prev !== null &&
        prev.subRequestsSignature === subRequestsSignature &&
        prev.showKindsKey === snapshot.showKindsKey &&
        prev.settingsSignature === settingsSignature
      const cachedSnapshot = snapshotCacheKey
        ? groupedNoteListSnapshotCache.get(snapshotCacheKey)
        : null
      const sameCachedSubscriptionInputs =
        !!cachedSnapshot &&
        cachedSnapshot.subRequestsSignature === subRequestsSignature &&
        cachedSnapshot.showKindsKey === snapshot.showKindsKey &&
        cachedSnapshot.settingsSignature === settingsSignature

      if (sameCachedSubscriptionInputs && eventsRef.current.length === 0 && cachedSnapshot?.events?.length) {
        console.info('[GroupedNoteList] restored events from snapshot cache', {
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          eventCount: cachedSnapshot.events.length
        })
        setEvents(cachedSnapshot.events)
      }

      const preserveExistingEvents =
        softResubscribe || sameSubscriptionInputs || sameCachedSubscriptionInputs

      if (!preserveExistingEvents) {
        setLoading(true)
        setEvents([])
        setNewEvents([])
      } else {
        if (!softResubscribe && sameSubscriptionInputs) {
          console.info('[GroupedNoteList] preserving events on equivalent subscription refresh', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            effectId
          })
        } else if (!softResubscribe && sameCachedSubscriptionInputs) {
          console.info('[GroupedNoteList] preserving events on cached equivalent subscription', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            effectId
          })
        }
        setLoading(true)
      }

      if (showKinds.length === 0) {
        setLoading(false)
        return () => {}
      }

      const timeframeMs = getTimeFrameInMs(settings.timeFrame)
      const groupedNotesSince = Math.floor((Date.now() - timeframeMs) / 1000)

      const groupRelayUrls = new Set(
        subRequests
          .filter(
            (
              req
            ): req is Extract<TFeedSubRequest, { source: 'relays' }> => {
              if (req.source !== 'relays') return false
              const hTags = (req.filter as { ['#h']?: string[] })?.['#h']
              return Array.isArray(hTags) && hTags.length > 0
            }
          )
          .flatMap((req) => req.urls)
      )
      const canResubscribe = groupRelayUrls.size > 0

      const stripRelayToken = (relayUrl: string) => {
        try {
          const parsed = new URL(relayUrl)
          if (!parsed.searchParams.has('token')) return relayUrl
          parsed.searchParams.delete('token')
          const normalized = parsed.toString()
          return normalized.endsWith('?') ? normalized.slice(0, -1) : normalized
        } catch {
          return relayUrl
        }
      }

      const groupRelayBaseUrls = new Set(
        Array.from(groupRelayUrls, (url) => stripRelayToken(url))
      )

      const isGroupRelayUrl = (url: string) =>
        groupRelayUrls.has(url) || groupRelayBaseUrls.has(stripRelayToken(url))

      const mergeEventBatch = (incomingEvents: Event[], currentEvents: Event[]) => {
        const merged = [...incomingEvents, ...currentEvents].sort(
          (a, b) => b.created_at - a.created_at
        )
        return merged.filter((evt, i) => i === 0 || evt.id !== merged[i - 1].id)
      }

      const shouldResubscribeReason = (reason: string) => {
        if (reason.startsWith('GroupedNoteList cleanup')) return false
        if (['closed by caller', 'relay connection closed by us'].includes(reason)) {
          return false
        }

        return [
          'relay connection closed',
          'relay connection errored',
          'relay connection timed out',
          'pingpong timed out'
        ].includes(reason)
      }

      const scheduleResubscribe = (url: string, reason: string) => {
        if (!canResubscribe || !isGroupRelayUrl(url)) return
        if (resubscribeTimerRef.current !== null) return
        resubscribeAttemptRef.current += 1
        const attempt = resubscribeAttemptRef.current
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 15000)
        softResubscribeRef.current = true
        console.info('[GroupedNoteList] resubscribe scheduled', {
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
      let effectActive = true
      let earlyFetchResolvedWithEvents = false
      let pendingEarlyFetchCount = 0
      let awaitingFallbackAfterHedges = false
      const earlyFetchRetryTimers: number[] = []
      const scheduleAutoRetryAfterEmpty = (reason: string) => {
        if (!effectActive) return false
        if (eventsRef.current.length > 0 || earlyFetchResolvedWithEvents) return false
        if (emptyFinalAutoRetryTimerRef.current !== null) return true
        if (emptyFinalAutoRetryCountRef.current >= 1) return false
        emptyFinalAutoRetryCountRef.current += 1
        const attempt = emptyFinalAutoRetryCountRef.current
        const delayMs = 450
        console.info('[GroupedNoteList] empty-final auto-retry scheduled', {
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          effectId,
          reason,
          attempt,
          delayMs
        })
        setLoading(true)
        emptyFinalAutoRetryTimerRef.current = window.setTimeout(() => {
          emptyFinalAutoRetryTimerRef.current = null
          if (!effectActive) return
          console.info('[GroupedNoteList] empty-final auto-retry firing', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            effectId,
            reason,
            attempt
          })
          softResubscribeRef.current = true
          setRefreshCount((curr) => curr + 1)
        }, delayMs)
        return true
      }
      const resolveDeferredFallbackAfterHedges = (reason: string) => {
        if (!effectActive || !awaitingFallbackAfterHedges) return
        if (pendingEarlyFetchCount > 0) return
        awaitingFallbackAfterHedges = false
        const fallbackScheduled = scheduleEmptyFinalFallback(reason)
        console.info('[GroupedNoteList] empty-final fallback hedge resolution', {
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          effectId,
          reason,
          fallbackScheduled,
          pendingEarlyFetchCount,
          hasEvents: eventsRef.current.length > 0,
          earlyFetchResolvedWithEvents
        })
        if (effectActive) {
          setLoading(Boolean(fallbackScheduled))
        }
      }
      const cancelPendingEmptyFallback = (reason: string) => {
        if (emptyFinalFallbackTimerRef.current === null) return false
        clearTimeout(emptyFinalFallbackTimerRef.current)
        emptyFinalFallbackTimerRef.current = null
        console.info('[GroupedNoteList] empty-final fallback canceled', {
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          effectId,
          reason
        })
        return true
      }
      const scheduleEmptyFinalFallback = (reason: string) => {
        if (!canResubscribe) return false
        if (eventsRef.current.length > 0) return false
        if (earlyFetchResolvedWithEvents) return false
        if (emptyFinalFallbackAttemptedRef.current) return false
        if (emptyFinalFallbackTimerRef.current !== null) return true

        emptyFinalFallbackAttemptedRef.current = true
        const delayMs = EMPTY_FINAL_FALLBACK_DELAY_MS
        console.info('[GroupedNoteList] empty-final fallback scheduled', {
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          effectId,
          delayMs,
          reason
        })
        emptyFinalFallbackTimerRef.current = window.setTimeout(async () => {
          emptyFinalFallbackTimerRef.current = null
          if (earlyFetchResolvedWithEvents || eventsRef.current.length > 0) {
            console.info('[GroupedNoteList] empty-final fallback skipped', {
              label: debugLabel ?? null,
              activeTab: debugActiveTab ?? null,
              effectId,
              reason: 'events-already-available'
            })
            if (effectActive) setLoading(false)
            return
          }
          console.info('[GroupedNoteList] empty-final fallback firing', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            effectId
          })
          try {
            const fallbackEvents = await client.loadMoreTimeline(
              subRequests,
              {
                kinds: showKinds,
                since: groupedNotesSince
              },
              {
                startLogin
              }
            )
            const filteredEvents = fallbackEvents.filter((evt) => !shouldHideEvent(evt))
            console.info('[GroupedNoteList] empty-final fallback result', {
              label: debugLabel ?? null,
              activeTab: debugActiveTab ?? null,
              effectId,
              batchSize: filteredEvents.length
            })
            if (!effectActive) return
            if (filteredEvents.length > 0) {
              if (emptyFinalAutoRetryTimerRef.current !== null) {
                clearTimeout(emptyFinalAutoRetryTimerRef.current)
                emptyFinalAutoRetryTimerRef.current = null
              }
              emptyFinalAutoRetryCountRef.current = 0
              setEvents((currentEvents) => {
                return mergeEventBatch(filteredEvents, currentEvents)
              })
            } else {
              scheduleAutoRetryAfterEmpty('fallback-empty')
            }
          } catch (error) {
            console.warn('[GroupedNoteList] empty-final fallback failed', {
              label: debugLabel ?? null,
              activeTab: debugActiveTab ?? null,
              effectId,
              error: error instanceof Error ? error.message : String(error)
            })
          } finally {
            if (effectActive && emptyFinalAutoRetryTimerRef.current === null) setLoading(false)
          }
        }, delayMs)
        return true
      }

      const shouldRunEarlyFetch = canResubscribe && !preserveExistingEvents
      if (shouldRunEarlyFetch) {
        const runEarlyFetchAttempt = (attempt: number, trigger: 'initial' | 'hedge') => {
          if (!effectActive || earlyFetchResolvedWithEvents) return
          pendingEarlyFetchCount += 1
          const earlyFetchStartedAt = Date.now()
          console.info('[GroupedNoteList] early one-shot fetch start', {
            label: debugLabel ?? null,
            activeTab: debugActiveTab ?? null,
            effectId,
            groupedNotesSince,
            showKindsCount: showKinds.length,
            attempt,
            trigger,
            pendingEarlyFetchCount
          })
          client
            .loadMoreTimeline(
              subRequests,
              {
                kinds: showKinds,
                since: groupedNotesSince
              },
              {
                startLogin
              }
            )
            .then((earlyFetchEvents) => {
              const filteredEvents = earlyFetchEvents.filter((evt) => !shouldHideEvent(evt))
              const elapsedMs = Date.now() - earlyFetchStartedAt
              console.info('[GroupedNoteList] early one-shot fetch result', {
                label: debugLabel ?? null,
                activeTab: debugActiveTab ?? null,
                effectId,
                batchSize: filteredEvents.length,
                elapsedMs,
                attempt,
                trigger
              })
              if (!effectActive) {
                console.info('[GroupedNoteList] early one-shot fetch ignored (stale effect)', {
                  label: debugLabel ?? null,
                  activeTab: debugActiveTab ?? null,
                  effectId,
                  attempt,
                  trigger
                })
                return
              }
              if (!filteredEvents.length || earlyFetchResolvedWithEvents) return
              earlyFetchResolvedWithEvents = true
              awaitingFallbackAfterHedges = false
              if (emptyFinalAutoRetryTimerRef.current !== null) {
                clearTimeout(emptyFinalAutoRetryTimerRef.current)
                emptyFinalAutoRetryTimerRef.current = null
              }
              emptyFinalAutoRetryCountRef.current = 0
              emptyFinalFallbackAttemptedRef.current = false
              cancelPendingEmptyFallback('early-fetch-events')
              setEvents((currentEvents) => mergeEventBatch(filteredEvents, currentEvents))
              setLoading(false)
            })
            .catch((error) => {
              console.warn('[GroupedNoteList] early one-shot fetch failed', {
                label: debugLabel ?? null,
                activeTab: debugActiveTab ?? null,
                effectId,
                error: error instanceof Error ? error.message : String(error),
                attempt,
                trigger
              })
            })
            .finally(() => {
              pendingEarlyFetchCount = Math.max(0, pendingEarlyFetchCount - 1)
              resolveDeferredFallbackAfterHedges('after-early-fetch-settled')
            })
        }

        runEarlyFetchAttempt(1, 'initial')
        const hedgeDelaysMs = [900, 1800]
        for (let i = 0; i < hedgeDelaysMs.length; i++) {
          const delayMs = hedgeDelaysMs[i]
          const timer = window.setTimeout(() => {
            runEarlyFetchAttempt(i + 2, 'hedge')
          }, delayMs)
          earlyFetchRetryTimers.push(timer)
        }
      }

      const subc = client.subscribeTimeline(
        subRequests,
        {
          kinds: showKinds,
          since: groupedNotesSince
        },
        {
          async onEvents(events, isFinal) {
            events = events.filter((evt) => !shouldHideEvent(evt))

            if (isFinal) {
              const isEmptyFinal = events.length === 0
              const hasCachedEvents = eventsRef.current.length > 0 || earlyFetchResolvedWithEvents
              let fallbackScheduled = false
              if (isEmptyFinal && !hasCachedEvents) {
                if (pendingEarlyFetchCount > 0) {
                  awaitingFallbackAfterHedges = true
                  console.info('[GroupedNoteList] empty-final fallback deferred for hedges', {
                    label: debugLabel ?? null,
                    activeTab: debugActiveTab ?? null,
                    effectId,
                    pendingEarlyFetchCount
                  })
                } else {
                  fallbackScheduled = scheduleEmptyFinalFallback('final-empty-batch')
                }
              } else if (!isEmptyFinal) {
                awaitingFallbackAfterHedges = false
                emptyFinalFallbackAttemptedRef.current = false
                cancelPendingEmptyFallback('final-non-empty')
              }
              console.info('[GroupedNoteList] onEvents final batch', {
                label: debugLabel ?? null,
                activeTab: debugActiveTab ?? null,
                effectId,
                batchSize: events.length,
                hasCachedEvents,
                fallbackScheduled,
                fallbackAttempted: emptyFinalFallbackAttemptedRef.current
              })
              setLoading(
                fallbackScheduled ||
                  (isEmptyFinal && !hasCachedEvents && pendingEarlyFetchCount > 0)
              )
            }

            if (events.length > 0) {
              if (emptyFinalAutoRetryTimerRef.current !== null) {
                clearTimeout(emptyFinalAutoRetryTimerRef.current)
                emptyFinalAutoRetryTimerRef.current = null
              }
              emptyFinalAutoRetryCountRef.current = 0
              if (earlyFetchResolvedWithEvents) {
                setEvents((currentEvents) => mergeEventBatch(events, currentEvents))
              } else {
                setEvents(events)
              }
            }
          },
          onNew: batchDebounce((newEvents) => {
            // do everything inside this setter otherwise it's impossible to get the latest state
            setNoteGroups((curr) => {
              const pending: NostrEvent[] = []
              const appended: NostrEvent[] = []

              for (let i = 0; i < newEvents.length; i++) {
                const newEvent = newEvents[i]

                // TODO: figure out where exactly the viewport is: for now just assume it's at the top
                if (
                  curr.noteGroups.length < 7 ||
                  newEvent.created_at < curr.noteGroups[6].topNote.created_at ||
                  curr.noteGroups
                    .slice(0, 6)
                    .some((group) => group.topNote.pubkey === newEvent.pubkey)
                ) {
                  // if there are very few events in the viewport or the new events would be inserted below
                  // or they authored by any of the top authors (but they wouldn't be their top notes), just append
                  appended.push(newEvent)
                } else if (pubkey && newEvent.pubkey === pubkey) {
                  // our own notes are also inserted regardless of any concern
                  appended.push(newEvent)
                } else {
                  // any other "new" notes that would be inserted above, make them be pending in the modal thing
                  pending.push(newEvent)
                }
              }

              // prepend them to the top (no need to sort as they will be sorted on mergeNewEvents)
              if (pending.length) {
                setNewEvents((curr) => [...pending, ...curr])
              }

              if (appended.length) {
                // merging these will trigger a group recomputation
                setEvents((oldEvents) => {
                  // we have no idea of the order here, so just sort everything and eliminate duplicates
                  const all = [...oldEvents, ...appended].sort(
                    (a, b) => b.created_at - a.created_at
                  )
                  return all.filter((evt, i) => i === 0 || evt.id !== all[i - 1].id)
                })
              }

              return curr
            })
          }, 1800),
          onClose(url, reason) {
            if (shouldResubscribeReason(reason)) {
              scheduleResubscribe(url, reason)
            }
            if (!showRelayCloseReason) return
            // ignore reasons from @nostr/tools
            if (
              [
                'closed by caller',
                'relay connection errored',
                'relay connection closed',
                'relay connection timed out',
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
        effectActive = false
        if (resubscribeTimerRef.current !== null) {
          clearTimeout(resubscribeTimerRef.current)
          resubscribeTimerRef.current = null
        }
        if (emptyFinalFallbackTimerRef.current !== null) {
          clearTimeout(emptyFinalFallbackTimerRef.current)
          emptyFinalFallbackTimerRef.current = null
        }
        if (emptyFinalAutoRetryTimerRef.current !== null) {
          clearTimeout(emptyFinalAutoRetryTimerRef.current)
          emptyFinalAutoRetryTimerRef.current = null
        }
        for (const timer of earlyFetchRetryTimers) {
          clearTimeout(timer)
        }
        console.info('[GroupedNoteList] subscribe cleanup', {
          effectId,
          label: debugLabel ?? null,
          activeTab: debugActiveTab ?? null,
          subRequestsCount: subRequests.length
        })
        subc.close(`GroupedNoteList cleanup effectId=${effectId}`)
      }
    }, [subRequests, refreshCount, showKinds, settings, timelineLabel])

    function mergeNewEvents() {
      setEvents((oldEvents) =>
        // we must sort here because the group calculation assumes everything is sorted
        [...newEvents, ...oldEvents].sort((a, b) => b.created_at - a.created_at)
      )
      setNewEvents([])
      setTimeout(() => {
        scrollToTop('smooth')
      }, 0)
    }

    if (hasNoResults) {
      return (
        <div>
          <div ref={topRef} className="scroll-mt-[calc(6rem+1px)]" />
          <GroupedNotesEmptyState
            onOpenSettings={() => {
              // Settings will be handled by the GroupedNotesFilter component
            }}
            onReset={resetSettings}
          />
        </div>
      )
    }

    const list = (
      <div className="min-h-screen" style={{ overflowAnchor: 'none' }}>
        {nameFilteredGroups.map(({ totalNotes, oldestTimestamp, allNoteTimestamps, topNote }) => {
          // use CompactedNoteCard if compacted view is on
          if (settings.compactedView) {
            const readStatus = getReadStatus(topNote.pubkey, topNote.created_at)
            const unreadCount = getUnreadCount(topNote.pubkey, allNoteTimestamps)

            return (
              <CompactedEventCard
                key={topNote.id}
                className="w-full"
                event={topNote}
                variant={topNote.kind === kinds.Repost ? 'repost' : 'note'}
                totalNotesInTimeframe={unreadCount}
                oldestTimestamp={oldestTimestamp}
                filterMutedNotes={filterMutedNotes}
                isSelected={selectedNoteId === topNote.id}
                onSelect={() => setSelectedNoteId(topNote.id)}
                onLastNoteRead={() => {
                  // If there's only one note, mark all as read instead of just last
                  if (totalNotes === 1) {
                    markAllNotesRead(topNote.pubkey, topNote.created_at, unreadCount)
                  } else {
                    markLastNoteRead(topNote.pubkey, topNote.created_at, unreadCount)
                  }
                }}
                onAllNotesRead={() =>
                  markAllNotesRead(topNote.pubkey, topNote.created_at, unreadCount)
                }
                onMarkAsUnread={() => markAsUnread(topNote.pubkey)}
                isLastNoteRead={readStatus.isLastNoteRead}
                areAllNotesRead={readStatus.areAllNotesRead}
              />
            )
          }

          // otherwise use regular NoteCard
          const unreadCount = totalNotes
            ? getUnreadCount(topNote.pubkey, allNoteTimestamps)
            : totalNotes
          const readStatus = totalNotes
            ? getReadStatus(topNote.pubkey, topNote.created_at)
            : { isLastNoteRead: false, areAllNotesRead: false }

          return (
            <NoteCard
              key={topNote.id}
              className="w-full"
              event={topNote}
              filterMutedNotes={filterMutedNotes}
              groupedNotesTotalCount={unreadCount}
              groupedNotesOldestTimestamp={oldestTimestamp}
              onAllNotesRead={() =>
                unreadCount && markAllNotesRead(topNote.pubkey, topNote.created_at, unreadCount)
              }
              areAllNotesRead={readStatus.areAllNotesRead}
            />
          )
        })}
        {events.length ? (
          <div className="text-center text-sm text-muted-foreground mt-2">
            {t('end of grouped results')}
          </div>
        ) : !loading && !events.length ? (
          <div className="flex justify-center w-full mt-2">
            <Button size="lg" onClick={() => refresh('empty-state-button')}>
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
              refresh('pull-to-refresh')
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
GroupedNoteList.displayName = 'GroupedNoteList'
export default GroupedNoteList

export type TGroupedNoteListRef = {
  scrollToTop: (behavior?: ScrollBehavior) => void
  refresh: () => void
}
