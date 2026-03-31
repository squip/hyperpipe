import ArticleList, { TArticleListRef, TArticleSubRequest } from '@/components/ArticleList'
import SharedFeedFilterMenu from '@/components/SharedFeedFilterMenu'
import { RefreshButton } from '@/components/RefreshButton'
import TabsBar, { TTabDefinition } from '@/components/Tabs'
import { useFetchFollowings } from '@/hooks'
import useSharedFeedCustomRelayUrls from '@/hooks/useSharedFeedCustomRelayUrls'
import useSharedFeedFilterSettings from '@/hooks/useSharedFeedFilterSettings'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import {
  FILTER_LANGUAGE_CODES,
  getFilterLanguageLabel,
  UNKNOWN_LANGUAGE_CODE
} from '@/lib/language'
import {
  areStringArraysEqual,
  buildSharedFeedRelayOptions,
  createDefaultSharedFeedFilterSettings,
  getSelectedAuthorPubkeys,
  getSharedFeedFilterSinceTimestamp,
  isSharedFeedFilterActive,
  prependFollowingListOption,
  type TFeedFilterLanguageOption,
  type TFeedFilterListOption,
  type TFeedFilterRelayOption
} from '@/lib/shared-feed-filters'
import { buildGroupRelayTargets } from '@/lib/relay-targets'
import { isTouchDevice } from '@/lib/utils'
import { useGroups } from '@/providers/GroupsProvider'
import { useLists } from '@/providers/ListsProvider'
import { useNostr } from '@/providers/NostrProvider'
import client from '@/services/client.service'
import { TPageRef } from '@/types'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type ReadsFeedMode = 'discover' | 'following'

const READS_TABS: TTabDefinition[] = [
  { value: 'discover', label: 'Discover' },
  { value: 'following', label: 'Following' }
]

const ReadsPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const layoutRef = useRef<TPageRef>(null)
  const articleListRef = useRef<TArticleListRef>(null)
  const { pubkey } = useNostr()
  const { lists } = useLists()
  const { followings } = useFetchFollowings(pubkey)
  const {
    discoveryRelays,
    myGroupList,
    discoveryGroups,
    getProvisionalGroupMetadata,
    resolveRelayUrl
  } = useGroups()
  const {
    relayUrls: customRelayUrls,
    addRelayUrl: addCustomRelayUrl,
    removeRelayIdentity: removeCustomRelayIdentity
  } = useSharedFeedCustomRelayUrls()
  const {
    settings,
    setSettings,
    resetSettings,
    timeFrameOptions,
    hasSavedSettings
  } = useSharedFeedFilterSettings('reads')
  const [feedMode, setFeedMode] = useState<ReadsFeedMode>('discover')
  const [followingReadRelayUrls, setFollowingReadRelayUrls] = useState<string[]>([])
  const [isResolvingRelayUrls, setIsResolvingRelayUrls] = useState(false)
  const supportTouch = useMemo(() => isTouchDevice(), [])
  const hasFollowings = followings.length > 0
  const canUseFollowing = Boolean(pubkey) && hasFollowings

  useImperativeHandle(ref, () => layoutRef.current)

  const groupRelayTargets = useMemo(
    () =>
      buildGroupRelayTargets({
        myGroupList,
        resolveRelayUrl,
        getProvisionalGroupMetadata,
        discoveryGroups
      }),
    [discoveryGroups, getProvisionalGroupMetadata, myGroupList, resolveRelayUrl]
  )

  const listOptions = useMemo<TFeedFilterListOption[]>(
    () =>
      prependFollowingListOption(
        lists.map((list) => ({
          key: `${list.event.pubkey}:${list.id}`,
          label: list.title,
          authorPubkeys: list.pubkeys || [],
          description: list.description || null
        })),
        {
          followings,
          includeFollowing: Boolean(pubkey),
          label: t('Following'),
          description: t('From people you follow')
        }
      ),
    [followings, lists, pubkey, t]
  )

  const relayOptions = useMemo<TFeedFilterRelayOption[]>(
    () =>
      buildSharedFeedRelayOptions({
        discoveryRelayUrls: discoveryRelays,
        groupRelayTargets,
        customRelayUrls,
        extraRelayUrls: feedMode === 'following' ? followingReadRelayUrls : []
      }),
    [customRelayUrls, discoveryRelays, feedMode, followingReadRelayUrls, groupRelayTargets]
  )

  const languageOptions = useMemo<TFeedFilterLanguageOption[]>(
    () => [
      ...FILTER_LANGUAGE_CODES.map((code) => ({
        code,
        label: getFilterLanguageLabel(code)
      })),
      {
        code: UNKNOWN_LANGUAGE_CODE,
        label: t('Unknown')
      }
    ],
    [t]
  )

  const defaultFilterSettings = useMemo(
    () =>
      createDefaultSharedFeedFilterSettings(
        'reads',
        timeFrameOptions,
        relayOptions.map((option) => option.relayIdentity)
      ),
    [relayOptions, timeFrameOptions]
  )

  const effectiveSelectedRelayIdentities = useMemo(
    () =>
      settings.selectedRelayIdentities.length === 0
        ? relayOptions.map((option) => option.relayIdentity)
        : settings.selectedRelayIdentities,
    [relayOptions, settings.selectedRelayIdentities]
  )

  useEffect(() => {
    if (!canUseFollowing && feedMode === 'following') {
      setFeedMode('discover')
    }
  }, [canUseFollowing, feedMode])

  useEffect(() => {
    let cancelled = false

    const resolveRelayUrls = async () => {
      if (feedMode !== 'following' || !pubkey || !canUseFollowing) {
        setFollowingReadRelayUrls([])
        setIsResolvingRelayUrls(false)
        return
      }

      setIsResolvingRelayUrls(true)

      try {
        const relayList = await client.fetchRelayList(pubkey)
        if (cancelled) return
        setFollowingReadRelayUrls(Array.from(new Set(relayList.read.filter(Boolean))).slice(0, 8))
      } catch (error) {
        console.error('Failed to initialize following Reads feed', error)
        if (!cancelled) {
          setFeedMode('discover')
          setFollowingReadRelayUrls([])
        }
      } finally {
        if (!cancelled) {
          setIsResolvingRelayUrls(false)
        }
      }
    }

    void resolveRelayUrls()

    return () => {
      cancelled = true
    }
  }, [canUseFollowing, feedMode, pubkey])

  useEffect(() => {
    if (!relayOptions.length) return

    if (!hasSavedSettings && settings.selectedRelayIdentities.length === 0) {
      setSettings(defaultFilterSettings)
      return
    }

    const availableIdentitySet = new Set(relayOptions.map((option) => option.relayIdentity))
    const filteredSelections = settings.selectedRelayIdentities.filter((relayIdentity) =>
      availableIdentitySet.has(relayIdentity)
    )

    if (!areStringArraysEqual(filteredSelections, settings.selectedRelayIdentities)) {
      setSettings({
        ...settings,
        selectedRelayIdentities: filteredSelections
      })
    }
  }, [
    defaultFilterSettings,
    hasSavedSettings,
    relayOptions,
    setSettings,
    settings,
    settings.selectedRelayIdentities
  ])

  const selectedRelayUrls = useMemo(() => {
    const selectedRelaySet = new Set(effectiveSelectedRelayIdentities)
    return relayOptions
      .filter((option) => selectedRelaySet.has(option.relayIdentity))
      .map((option) => option.relayUrl)
  }, [effectiveSelectedRelayIdentities, relayOptions])

  const selectedAuthorPubkeySet = useMemo(
    () => getSelectedAuthorPubkeys(listOptions, settings.selectedListKeys),
    [listOptions, settings.selectedListKeys]
  )

  const effectiveAuthors = useMemo(() => {
    if (feedMode === 'following') {
      if (settings.selectedListKeys.length === 0) {
        return followings
      }

      return followings.filter((accountPubkey) => selectedAuthorPubkeySet.has(accountPubkey))
    }

    return Array.from(selectedAuthorPubkeySet)
  }, [feedMode, followings, selectedAuthorPubkeySet, settings.selectedListKeys.length])

  const subRequests = useMemo<TArticleSubRequest[]>(() => {
    if (isResolvingRelayUrls || selectedRelayUrls.length === 0) {
      return []
    }

    if (settings.selectedListKeys.length > 0 && effectiveAuthors.length === 0) {
      return []
    }

    return [
      {
        source: 'relays',
        urls: selectedRelayUrls,
        filter: effectiveAuthors.length > 0 ? { authors: effectiveAuthors } : {}
      }
    ]
  }, [effectiveAuthors, isResolvingRelayUrls, selectedRelayUrls, settings.selectedListKeys.length])

  const sinceTimestamp = useMemo(
    () => getSharedFeedFilterSinceTimestamp(settings),
    [settings]
  )

  const isFilterActive = useMemo(
    () =>
      isSharedFeedFilterActive(
        {
          ...settings,
          selectedRelayIdentities: effectiveSelectedRelayIdentities
        },
        defaultFilterSettings
      ),
    [defaultFilterSettings, effectiveSelectedRelayIdentities, settings]
  )

  const renderTabs = (
    <TabsBar
      tabs={READS_TABS}
      value={feedMode}
      onTabChange={(tab) => {
        if (tab === 'following' && !canUseFollowing) return
        setFeedMode(tab as ReadsFeedMode)
      }}
      options={(
        <div className="flex items-center gap-1">
          {!supportTouch && <RefreshButton onClick={() => articleListRef.current?.refresh()} />}
          <SharedFeedFilterMenu
            settings={{
              ...settings,
              selectedRelayIdentities: effectiveSelectedRelayIdentities
            }}
            defaultSettings={defaultFilterSettings}
            timeFrameOptions={timeFrameOptions}
            relayOptions={relayOptions}
            listOptions={listOptions}
            languageOptions={languageOptions}
            isActive={isFilterActive}
            onApply={setSettings}
            onReset={(nextSettings) => resetSettings(nextSettings)}
            onCreateRelayOption={addCustomRelayUrl}
            onRemoveRelayOption={removeCustomRelayIdentity}
          />
        </div>
      )}
      topOffset="0"
      reserveOptionsSpace={!supportTouch}
    />
  )

  let content: React.ReactNode = null

  if (isResolvingRelayUrls) {
    content = (
      <div className="text-center text-sm text-muted-foreground py-8">
        {t('Loading articles...')}
      </div>
    )
  } else if (subRequests.length === 0) {
    content = (
      <div className="text-center text-sm text-muted-foreground py-8">
        {t('No articles found')}
      </div>
    )
  } else {
    content = (
      <ArticleList
        ref={articleListRef}
        subRequests={subRequests}
        sinceTimestamp={sinceTimestamp}
        mutedWords={settings.mutedWords}
        maxItemsPerAuthor={settings.maxItemsPerAuthor}
        selectedLanguageCodes={settings.selectedLanguageCodes}
      />
    )
  }

  return (
    <PrimaryPageLayout
      pageName="reads"
      ref={layoutRef}
      titlebar={<ReadsPageTitlebar />}
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
