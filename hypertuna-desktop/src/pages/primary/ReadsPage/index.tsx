import { BIG_RELAY_URLS } from '@/constants'
import { Button } from '@/components/ui/button'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { cn, isTouchDevice } from '@/lib/utils'
import ArticleList, { TArticleListRef, TArticleSubRequest } from '@/components/ArticleList'
import { RefreshButton } from '@/components/RefreshButton'
import { TPageRef } from '@/types'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNostr } from '@/providers/NostrProvider'
import { useFetchFollowings } from '@/hooks'
import client from '@/services/client.service'

type ReadsFeedMode = 'discover' | 'following'

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
        <ReadsPageTitlebar
          articleListRef={articleListRef}
          supportTouch={supportTouch}
          feedMode={feedMode}
          canUseFollowing={canUseFollowing}
          onFeedModeChange={setFeedMode}
        />
      }
      displayScrollToTopButton
    >
      {content}
    </PrimaryPageLayout>
  )
})

ReadsPage.displayName = 'ReadsPage'

export default ReadsPage

function ReadsPageTitlebar({
  articleListRef,
  supportTouch,
  feedMode,
  canUseFollowing,
  onFeedModeChange
}: {
  articleListRef: React.RefObject<TArticleListRef>
  supportTouch: boolean
  feedMode: ReadsFeedMode
  canUseFollowing: boolean
  onFeedModeChange: (mode: ReadsFeedMode) => void
}) {
  const { t } = useTranslation()
  const subtitle =
    feedMode === 'following' && canUseFollowing
      ? t('From people you follow')
      : t('Public articles')

  return (
    <div className="flex gap-2 items-center h-full justify-between min-w-0">
      <div className="flex-1 pl-4 min-w-0">
        <div className="font-semibold text-lg">{t('Reads')}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className="shrink-0 flex gap-1 items-center">
        <div className="flex items-center gap-1 rounded-lg bg-muted/70 p-1">
          <Button
            type="button"
            variant={feedMode === 'discover' ? 'secondary' : 'ghost'}
            size="sm"
            className={cn('h-8 rounded-md px-3', feedMode !== 'discover' && 'text-muted-foreground')}
            aria-pressed={feedMode === 'discover'}
            onClick={() => onFeedModeChange('discover')}
          >
            {t('Discover')}
          </Button>
          <Button
            type="button"
            variant={feedMode === 'following' ? 'secondary' : 'ghost'}
            size="sm"
            className={cn('h-8 rounded-md px-3', feedMode !== 'following' && 'text-muted-foreground')}
            aria-pressed={feedMode === 'following'}
            disabled={!canUseFollowing}
            onClick={() => onFeedModeChange('following')}
          >
            {t('Following')}
          </Button>
        </div>
        {!supportTouch && <RefreshButton onClick={() => articleListRef.current?.refresh()} />}
      </div>
    </div>
  )
}
