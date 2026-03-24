import { BIG_RELAY_URLS } from '@/constants'
import TabsBar, { TTabDefinition } from '@/components/Tabs'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { isTouchDevice } from '@/lib/utils'
import ArticleList, { TArticleListRef, TArticleSubRequest } from '@/components/ArticleList'
import { RefreshButton } from '@/components/RefreshButton'
import { TPageRef } from '@/types'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNostr } from '@/providers/NostrProvider'
import { useFetchFollowings } from '@/hooks'
import client from '@/services/client.service'

type ReadsFeedMode = 'discover' | 'following'

const READS_TABS: TTabDefinition[] = [
  { value: 'discover', label: 'Discover' },
  { value: 'following', label: 'Following' }
]

function buildDiscoverSubRequests(): TArticleSubRequest[] {
  return [
    {
      source: 'relays',
      urls: BIG_RELAY_URLS,
      filter: {}
    }
  ]
}

const ReadsPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const layoutRef = useRef<TPageRef>(null)
  const articleListRef = useRef<TArticleListRef>(null)
  const { pubkey } = useNostr()
  const { followings } = useFetchFollowings(pubkey)
  const [feedMode, setFeedMode] = useState<ReadsFeedMode>('discover')
  const [subRequests, setSubRequests] = useState<TArticleSubRequest[]>([])
  const supportTouch = useMemo(() => isTouchDevice(), [])
  const hasFollowings = followings.length > 0
  const canUseFollowing = Boolean(pubkey) && hasFollowings

  useImperativeHandle(ref, () => layoutRef.current)

  useEffect(() => {
    if (!canUseFollowing && feedMode === 'following') {
      setFeedMode('discover')
    }
  }, [canUseFollowing, feedMode])

  useEffect(() => {
    let cancelled = false

    const applySubRequests = (nextRequests: TArticleSubRequest[]) => {
      if (!cancelled) {
        setSubRequests(nextRequests)
      }
    }

    const init = async () => {
      applySubRequests([])

      if (feedMode !== 'following' || !pubkey || !canUseFollowing) {
        applySubRequests(buildDiscoverSubRequests())
        return
      }

      try {
        const relayList = await client.fetchRelayList(pubkey)
        const relayUrls = Array.from(new Set(relayList.read.concat(BIG_RELAY_URLS))).slice(0, 8)

        applySubRequests([
          {
            source: 'relays',
            urls: relayUrls,
            filter: {
              authors: followings
            }
          }
        ])
      } catch (error) {
        console.error('Failed to initialize following Reads feed', error)
        if (!cancelled) {
          setFeedMode('discover')
        }
      }
    }

    void init()

    return () => {
      cancelled = true
    }
  }, [canUseFollowing, feedMode, followings, pubkey])

  const renderTabs = (
    <TabsBar
      tabs={READS_TABS}
      value={feedMode}
      onTabChange={(tab) => {
        if (tab === 'following' && !canUseFollowing) return
        setFeedMode(tab as ReadsFeedMode)
      }}
      options={!supportTouch ? <RefreshButton onClick={() => articleListRef.current?.refresh()} /> : null}
      topOffset="0"
      reserveOptionsSpace={!supportTouch}
    />
  )

  let content: React.ReactNode = null

  if (subRequests.length === 0) {
    content = (
      <div className="text-center text-sm text-muted-foreground py-8">
        {t('Loading articles...')}
      </div>
    )
  } else {
    content = <ArticleList ref={articleListRef} subRequests={subRequests} />
  }

  return (
    <PrimaryPageLayout
      pageName="reads"
      ref={layoutRef}
      titlebar={
        <ReadsPageTitlebar />
      }
      displayScrollToTopButton
    >
      <div>
        {renderTabs}
        {content}
      </div>
    </PrimaryPageLayout>
  )
})

ReadsPage.displayName = 'ReadsPage'

export default ReadsPage

function ReadsPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex gap-1 items-center h-full justify-between px-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-lg">{t('Articles')}</div>
      </div>
    </div>
  )
}
