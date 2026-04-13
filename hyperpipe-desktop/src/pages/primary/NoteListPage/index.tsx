import { useSecondaryPage } from '@/PageManager'
import PostEditor from '@/components/PostEditor'
import RelayInfo from '@/components/RelayInfo'
import useFeedRelayOptions from '@/hooks/useFeedRelayOptions'
import { Button } from '@/components/ui/button'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { toSearch } from '@/lib/link'
import { useCurrentRelays } from '@/providers/CurrentRelaysProvider'
import { useFeed } from '@/providers/FeedProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { TPageRef } from '@/types'
import { Info, PencilLine, Search } from 'lucide-react'
import {
  Dispatch,
  forwardRef,
  SetStateAction,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import FeedButton from './FeedButton'
import FollowingFeed from './FollowingFeed'
import RelaysFeed from './RelaysFeed'

function isLocalRelayProxyUrl(relay?: string | null) {
  if (!relay) return false
  try {
    const parsed = new URL(relay)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  } catch (_err) {
    return /^wss?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(relay)
  }
}

const NoteListPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const { addRelayUrls, removeRelayUrls } = useCurrentRelays()
  const layoutRef = useRef<TPageRef>(null)
  const { pubkey, checkLogin } = useNostr()
  const { feedInfo, relayUrls, isReady } = useFeed()
  const { getGroupRelaySelectionState, getRelaySelectionState } = useFeedRelayOptions()
  const [showRelayDetails, setShowRelayDetails] = useState(false)
  useImperativeHandle(ref, () => layoutRef.current)
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
  const shouldDeferCurrentRelayRegistration =
    feedInfo.feedType === 'relay' &&
    ((Boolean(feedInfo.localGroupRelay?.groupId) && !activeRelaySelection?.isReadyForReq) ||
      (!feedInfo.localGroupRelay?.groupId &&
        isLocalRelayProxyUrl(feedInfo.id || activeRelaySelection?.relayUrl) &&
        !activeRelaySelection?.isReadyForReq))
  const effectiveCurrentRelayUrls = shouldDeferCurrentRelayRegistration ? [] : relayUrls

  useEffect(() => {
    if (layoutRef.current) {
      layoutRef.current.scrollToTop('instant')
    }
  }, [JSON.stringify(relayUrls), feedInfo])

  useEffect(() => {
    if (effectiveCurrentRelayUrls.length) {
      addRelayUrls(effectiveCurrentRelayUrls)
      return () => {
        removeRelayUrls(effectiveCurrentRelayUrls)
      }
    }
  }, [addRelayUrls, effectiveCurrentRelayUrls, removeRelayUrls])

  let content: React.ReactNode = null
  if (!isReady) {
    content = <div className="text-center text-sm text-muted-foreground">{t('loading...')}</div>
  } else if (feedInfo.feedType === 'following' && !pubkey) {
    content = (
      <div className="flex justify-center w-full">
        <Button size="lg" onClick={() => checkLogin()}>
          {t('Please login to view following feed')}
        </Button>
      </div>
    )
  } else if (feedInfo.feedType === 'following') {
    content = <FollowingFeed />
  } else {
    content = (
      <>
        {showRelayDetails && feedInfo.feedType === 'relay' && !!feedInfo.id && (
          <RelayInfo url={feedInfo.id!} className="mb-2 pt-3" />
        )}
        <RelaysFeed />
      </>
    )
  }

  return (
    <PrimaryPageLayout
      pageName="home"
      ref={layoutRef}
      titlebar={
        <NoteListPageTitlebar
          layoutRef={layoutRef}
          showRelayDetails={showRelayDetails}
          setShowRelayDetails={
            feedInfo.feedType === 'relay' && !!feedInfo.id ? setShowRelayDetails : undefined
          }
        />
      }
      displayScrollToTopButton
    >
      {content}
    </PrimaryPageLayout>
  )
})
NoteListPage.displayName = 'NoteListPage'
export default NoteListPage

function NoteListPageTitlebar({
  layoutRef,
  showRelayDetails,
  setShowRelayDetails
}: {
  layoutRef?: React.RefObject<TPageRef>
  showRelayDetails?: boolean
  setShowRelayDetails?: Dispatch<SetStateAction<boolean>>
}) {
  const { isSmallScreen } = useScreenSize()

  return (
    <div className="flex h-full w-full min-w-0 items-center justify-between gap-1">
      <div className="min-w-0 flex-1">
        <FeedButton className="max-w-full" />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {setShowRelayDetails && (
          <Button
            variant="ghost"
            size="titlebar-icon"
            onClick={(e) => {
              e.stopPropagation()
              setShowRelayDetails((show) => !show)

              if (!showRelayDetails) {
                layoutRef?.current?.scrollToTop('smooth')
              }
            }}
            className={showRelayDetails ? 'bg-accent/50' : ''}
          >
            <Info />
          </Button>
        )}
        {isSmallScreen && (
          <>
            <SearchButton />
            <PostButton />
          </>
        )}
      </div>
    </div>
  )
}

function PostButton() {
  const { checkLogin } = useNostr()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="titlebar-icon"
        onClick={(e) => {
          e.stopPropagation()
          checkLogin(() => {
            setOpen(true)
          })
        }}
      >
        <PencilLine />
      </Button>
      <PostEditor open={open} setOpen={setOpen} />
    </>
  )
}

function SearchButton() {
  const { push } = useSecondaryPage()

  return (
    <Button variant="ghost" size="titlebar-icon" onClick={() => push(toSearch())}>
      <Search />
    </Button>
  )
}
