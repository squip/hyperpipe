import NoteList, { TNoteListRef } from '@/components/NoteList'
import GroupedNoteList, { TGroupedNoteListRef } from '@/components/GroupedNoteList'
import Tabs, { TTabDefinition } from '@/components/Tabs'
import { Input } from '@/components/ui/input'
import { isTouchDevice } from '@/lib/utils'
import { useKindFilter } from '@/providers/KindFilterProvider'
import { useUserTrust } from '@/providers/UserTrustProvider'
import { useGroupedNotes } from '@/providers/GroupedNotesProvider'
import storage from '@/services/local-storage.service'
import { TFeedSubRequest, TNoteListMode } from '@/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import KindFilter from '../KindFilter'
import GroupedNotesFilter from '../GroupedNotesFilter'
import { RefreshButton } from '../RefreshButton'

export default function NormalFeed({
  subRequests,
  isMainFeed = false,
  showRelayCloseReason = false,
  debugActiveTab,
  debugLabel
}: {
  subRequests: TFeedSubRequest[]
  isMainFeed?: boolean
  showRelayCloseReason?: boolean
  debugActiveTab?: string
  debugLabel?: string
}) {
  const { t } = useTranslation()
  const { hideUntrustedNotes } = useUserTrust()
  const { showKinds } = useKindFilter()
  const { settings: groupedNotesSettings } = useGroupedNotes()
  const [temporaryShowKinds, setTemporaryShowKinds] = useState(showKinds)
  const [listMode, setListMode] = useState<TNoteListMode>(() => storage.getNoteListMode())
  const [userFilter, setUserFilter] = useState('')
  const supportTouch = useMemo(() => isTouchDevice(), [])
  const noteListRef = useRef<TNoteListRef | TGroupedNoteListRef>(null)

  // Deduplicate identical subRequests (same source, urls, filter) to avoid duplicate subscriptions
  const uniqueSubRequests = useMemo(() => {
    const seen = new Set<string>()
    return subRequests.filter((req) => {
      if (req.source === 'relays') {
        const key = JSON.stringify({
          src: req.source,
          urls: [...req.urls].sort(),
          filter: req.filter
        })
        if (seen.has(key)) return false
        seen.add(key)
      }
      return true
    })
  }, [subRequests])

  const handleListModeChange = (mode: TNoteListMode) => {
    setListMode(mode)
    if (isMainFeed) {
      storage.setNoteListMode(mode)
    }
    noteListRef.current?.scrollToTop('smooth')
  }

  const handleShowKindsChange = (newShowKinds: number[]) => {
    setTemporaryShowKinds(newShowKinds)
    noteListRef.current?.scrollToTop()
  }

  // In grouped mode, force 'posts' mode and disable replies tab
  const effectiveListMode = groupedNotesSettings.enabled ? 'posts' : listMode
  const availableTabs: TTabDefinition[] = groupedNotesSettings.enabled
    ? [{ value: 'posts', label: 'Notes' }]
    : [
        { value: 'posts', label: 'Notes' },
        { value: 'postsAndReplies', label: 'Replies' }
      ]

  const summarizeSubRequests = (requests: TFeedSubRequest[]) =>
    requests.map((req) => {
      if (req.source === 'local') {
        return {
          source: 'local',
          filterKeys: Object.keys(req.filter ?? {})
        }
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

  const subRequestsSignature = useMemo(
    () => JSON.stringify(summarizeSubRequests(subRequests)),
    [subRequests]
  )
  const uniqueSubRequestsSignature = useMemo(
    () => JSON.stringify(summarizeSubRequests(uniqueSubRequests)),
    [uniqueSubRequests]
  )

  useEffect(() => {
    if (!debugLabel && !debugActiveTab) return
    console.info('[NormalFeed] subRequests update', {
      label: debugLabel ?? null,
      activeTab: debugActiveTab ?? null,
      groupedMode: groupedNotesSettings.enabled,
      listMode: effectiveListMode,
      subRequestsCount: subRequests.length,
      uniqueSubRequestsCount: uniqueSubRequests.length,
      subRequests: summarizeSubRequests(subRequests),
      uniqueSubRequests: summarizeSubRequests(uniqueSubRequests)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debugLabel,
    debugActiveTab,
    groupedNotesSettings.enabled,
    effectiveListMode,
    subRequestsSignature,
    uniqueSubRequestsSignature
  ])

  return (
    <>
      {groupedNotesSettings.enabled ? (
        /* Custom header for grouped mode with filter input */
        <div className="sticky flex items-center justify-between top-12 bg-background z-30 px-4 py-2 w-full border-b gap-3">
          <div
            tabIndex={0}
            className="relative flex w-full items-center rounded-md border border-input px-3 py-1 text-base transition-colors md:text-sm [&:has(:focus-visible)]:ring-ring [&:has(:focus-visible)]:ring-1 [&:has(:focus-visible)]:outline-none bg-surface-background shadow-inner h-full border-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="lucide lucide-search size-4 shrink-0 opacity-50"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.3-4.3"></path>
            </svg>

            <Input
              type="text"
              placeholder={t('GroupedNotesFilter')}
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              showClearButton={true}
              onClear={() => setUserFilter('')}
              className="flex-1 h-9 size-full shadow-none border-none bg-transparent focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex items-center gap-1">
            {!supportTouch && <RefreshButton onClick={() => noteListRef.current?.refresh()} />}
            <KindFilter showKinds={temporaryShowKinds} onShowKindsChange={handleShowKindsChange} />
            <GroupedNotesFilter />
          </div>
        </div>
      ) : (
        /* Standard tabs for non-grouped mode */
        <Tabs
          value={effectiveListMode}
          tabs={availableTabs}
          onTabChange={(listMode) => {
            handleListModeChange(listMode as TNoteListMode)
          }}
          options={
            <>
              {!supportTouch && <RefreshButton onClick={() => noteListRef.current?.refresh()} />}
              <KindFilter
                showKinds={temporaryShowKinds}
                onShowKindsChange={handleShowKindsChange}
              />
              <GroupedNotesFilter />
            </>
          }
        />
      )}
      {groupedNotesSettings.enabled ? (
        <GroupedNoteList
          ref={noteListRef as React.Ref<TGroupedNoteListRef>}
          showKinds={temporaryShowKinds}
          subRequests={uniqueSubRequests}
          showRelayCloseReason={showRelayCloseReason}
          userFilter={userFilter}
          debugActiveTab={debugActiveTab}
          debugLabel={debugLabel}
        />
      ) : (
        <NoteList
          ref={noteListRef as React.Ref<TNoteListRef>}
          showKinds={temporaryShowKinds}
          subRequests={uniqueSubRequests}
          hideReplies={effectiveListMode === 'posts'}
          hideUntrustedNotes={hideUntrustedNotes}
          showRelayCloseReason={showRelayCloseReason}
          debugActiveTab={debugActiveTab}
          debugLabel={debugLabel}
        />
      )}
    </>
  )
}
