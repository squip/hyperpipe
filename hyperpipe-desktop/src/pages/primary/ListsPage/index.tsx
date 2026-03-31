import { useSecondaryPage } from '@/providers/SecondaryPageProvider'
import UserAvatar from '@/components/UserAvatar'
import Username from '@/components/Username'
import NoteList from '@/components/NoteList'
import ProfileList from '@/components/ProfileList'
import SharedFeedFilterMenu from '@/components/SharedFeedFilterMenu'
import TabsBar, { TTabDefinition } from '@/components/Tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import useSharedFeedCustomRelayUrls from '@/hooks/useSharedFeedCustomRelayUrls'
import { toCreateList, toEditList } from '@/lib/link'
import {
  FILTER_LANGUAGE_CODES,
  getFilterLanguageLabel,
  matchesSelectedLanguageCodes,
  UNKNOWN_LANGUAGE_CODE
} from '@/lib/language'
import localStorageService from '@/services/local-storage.service'
import listStatsService from '@/services/list-stats.service'
import { useFollowList } from '@/providers/FollowListProvider'
import { useLists, TStarterPack } from '@/providers/ListsProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useMuteList } from '@/providers/MuteListProvider'
import useSharedFeedFilterSettings from '@/hooks/useSharedFeedFilterSettings'
import { TPageRef } from '@/types'
import client from '@/services/client.service'
import { ExtendedKind, BIG_RELAY_URLS } from '@/constants'
import {
  areStringArraysEqual,
  buildSharedFeedRelayOptions,
  createDefaultSharedFeedFilterSettings,
  getSelectedAuthorPubkeys,
  getSharedFeedFilterSinceTimestamp,
  isRelaySelectionActive,
  isSharedFeedFilterActive,
  matchesMutedWordList,
  prependFollowingListOption,
  type TFeedFilterLanguageOption,
  type TFeedFilterListOption,
  type TFeedFilterRelayOption
} from '@/lib/shared-feed-filters'
import {
  buildGroupRelayTargets,
  dedupeRelayUrlsByIdentity,
  getRelayIdentity,
  type GroupRelayTarget
} from '@/lib/relay-targets'
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
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Edit,
  Loader2,
  PencilLine,
  Plus,
  Search,
  Star,
  Trash2,
  UserPlus
} from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import ListEditorForm from '@/components/ListEditorForm'
import { Event } from '@jsr/nostr__tools/wasm'
import PullToRefresh from 'react-simple-pull-to-refresh'

type TSortBy = 'recent' | 'zaps'
const GROUP_RELAY_READY_TTL_MS = 30_000
const LIST_NOTE_FEED_KINDS = [1, 6]

const ListsPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current)

  const { pubkey, checkLogin } = useNostr()
  const {
    myGroupList,
    discoveryGroups,
    discoveryRelays,
    getProvisionalGroupMetadata,
    resolveRelayUrl
  } = useGroups()
  const { refreshRelaySubscriptions } = useWorkerBridge()
  const { push } = useSecondaryPage()
  const { lists, isLoading: isLoadingMyLists, deleteList, fetchLists } = useLists()
  const { followings = [], followMultiple, unfollowMultiple } = useFollowList()
  const { mutePubkeySet } = useMuteList()
  const {
    relayUrls: customRelayUrls,
    addRelayUrl: addCustomRelayUrl,
    removeRelayIdentity: removeCustomRelayIdentity
  } = useSharedFeedCustomRelayUrls()
  const { isSmallScreen } = useScreenSize()
  const {
    settings: sharedFilterSettings,
    setSettings: setSharedFilterSettings,
    resetSettings: resetSharedFilterSettings,
    timeFrameOptions,
    hasSavedSettings
  } = useSharedFeedFilterSettings('lists')

  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<TStarterPack[]>([])
  const [allPublicLists, setAllPublicLists] = useState<TStarterPack[]>([])
  const [isLoadingPublicLists, setIsLoadingPublicLists] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [listToDelete, setListToDelete] = useState<string | null>(null)
  const [selectedList, setSelectedList] = useState<TStarterPack | null>(null)
  const [isLoadingSelectedList, setIsLoadingSelectedList] = useState(false)
  const [favoriteLists, setFavoriteLists] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'notes' | 'members'>('notes')
  const [activeSection, setActiveSection] = useState<'discover' | 'favorites' | 'my'>('discover')
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<TSortBy>('recent')
  const [followedLists, setFollowedLists] = useState<Set<string>>(new Set())
  const [showSearchBar, setShowSearchBar] = useState(!isSmallScreen)
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [listStatsVersion, setListStatsVersion] = useState(0) // used to trigger re-sorts when stats change
  const refreshRelaySubscriptionsRef = useRef(refreshRelaySubscriptions)
  const resolveRelayUrlRef = useRef(resolveRelayUrl)
  const groupRelayReadyCacheRef = useRef<
    Map<string, { checkedAt: number; relayUrl: string | null }>
  >(new Map())
  const groupRelayReadyInFlightRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const publicListsFetchInFlightRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    refreshRelaySubscriptionsRef.current = refreshRelaySubscriptions
  }, [refreshRelaySubscriptions])

  useEffect(() => {
    resolveRelayUrlRef.current = resolveRelayUrl
  }, [resolveRelayUrl])

  const parseStarterPackEvent = (event: Event): TStarterPack => {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] || ''
    const title = event.tags.find((tag) => tag[0] === 'title')?.[1] || 'Untitled List'
    const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
    const image = event.tags.find((tag) => tag[0] === 'image')?.[1]
    const pubkeys = event.tags?.filter((tag) => tag[0] === 'p').map((tag) => tag[1]) || []
    const relayUrls = client.getSeenEventRelayUrls(event.id, event)

    return {
      id: dTag,
      title,
      description,
      image,
      pubkeys,
      relayUrls,
      event
    }
  }

  const dedupeLatestLists = useCallback((listItems: TStarterPack[]): TStarterPack[] => {
    const latestByKey = new Map<string, TStarterPack>()
    listItems.forEach((list) => {
      const key = `${list.event.pubkey}:${list.id}`
      const current = latestByKey.get(key)
      if (!current || current.event.created_at < list.event.created_at) {
        latestByKey.set(key, list)
      }
    })
    return Array.from(latestByKey.values()).sort((a, b) => b.event.created_at - a.event.created_at)
  }, [])

  const groupRelayTargets = useMemo<GroupRelayTarget[]>(
    () =>
      buildGroupRelayTargets({
        myGroupList,
        resolveRelayUrl,
        getProvisionalGroupMetadata,
        discoveryGroups
      }),
    [discoveryGroups, getProvisionalGroupMetadata, myGroupList, resolveRelayUrl]
  )
  const groupRelayTargetsSignature = useMemo(
    () =>
      groupRelayTargets
        .map((target) => `${target.groupId}:${target.relayIdentity}`)
        .sort()
        .join('|'),
    [groupRelayTargets]
  )
  const stableGroupRelayTargets = useMemo(() => groupRelayTargets, [groupRelayTargetsSignature])

  const sharedRelayOptions = useMemo<TFeedFilterRelayOption[]>(
    () =>
      buildSharedFeedRelayOptions({
        discoveryRelayUrls: discoveryRelays,
        groupRelayTargets: stableGroupRelayTargets,
        customRelayUrls
      }),
    [customRelayUrls, discoveryRelays, stableGroupRelayTargets]
  )

  const sharedListOptions = useMemo<TFeedFilterListOption[]>(
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
  const baseDiscoverFetchRelayUrls = useMemo(
    () => dedupeRelayUrlsByIdentity([...discoveryRelays, ...customRelayUrls]),
    [customRelayUrls, discoveryRelays]
  )

  const defaultSharedFilterSettings = useMemo(
    () =>
      createDefaultSharedFeedFilterSettings(
        'lists',
        timeFrameOptions,
        sharedRelayOptions.map((option) => option.relayIdentity)
      ),
    [sharedRelayOptions, timeFrameOptions]
  )

  const effectiveSelectedRelayIdentities = useMemo(
    () =>
      sharedFilterSettings.selectedRelayIdentities.length === 0
        ? sharedRelayOptions.map((option) => option.relayIdentity)
        : sharedFilterSettings.selectedRelayIdentities,
    [sharedFilterSettings.selectedRelayIdentities, sharedRelayOptions]
  )

  useEffect(() => {
    setShowSearchBar(!isSmallScreen)
  }, [isSmallScreen])

  useEffect(() => {
    if (!sharedRelayOptions.length) return

    const availableIdentities = sharedRelayOptions.map((option) => option.relayIdentity)
    const availableSet = new Set(availableIdentities)

    if (!hasSavedSettings && sharedFilterSettings.selectedRelayIdentities.length === 0) {
      setSharedFilterSettings(
        createDefaultSharedFeedFilterSettings('lists', timeFrameOptions, availableIdentities)
      )
      return
    }

    const filteredSelections = sharedFilterSettings.selectedRelayIdentities.filter((relayIdentity) =>
      availableSet.has(relayIdentity)
    )

    if (!areStringArraysEqual(filteredSelections, sharedFilterSettings.selectedRelayIdentities)) {
      setSharedFilterSettings({
        ...sharedFilterSettings,
        selectedRelayIdentities: filteredSelections
      })
    }
  }, [
    sharedRelayOptions,
    hasSavedSettings,
    setSharedFilterSettings,
    sharedFilterSettings,
    sharedFilterSettings.selectedRelayIdentities,
    timeFrameOptions
  ])

  useEffect(() => {
    setFavoriteLists(localStorageService.getFavoriteLists(pubkey))
  }, [pubkey])

  useEffect(() => {
    const validGroupIds = new Set(stableGroupRelayTargets.map((target) => target.groupId))
    for (const groupId of Array.from(groupRelayReadyCacheRef.current.keys())) {
      if (!validGroupIds.has(groupId)) {
        groupRelayReadyCacheRef.current.delete(groupId)
      }
    }
    for (const groupId of Array.from(groupRelayReadyInFlightRef.current.keys())) {
      if (!validGroupIds.has(groupId)) {
        groupRelayReadyInFlightRef.current.delete(groupId)
      }
    }
  }, [groupRelayTargetsSignature, stableGroupRelayTargets])

  const resolveReadyGroupRelayUrl = useCallback(
    async (target: GroupRelayTarget, force = false): Promise<string | null> => {
      const groupId = target.groupId
      const now = Date.now()

      const inFlight = groupRelayReadyInFlightRef.current.get(groupId)
      if (inFlight) {
        return await inFlight
      }

      if (!force) {
        const cached = groupRelayReadyCacheRef.current.get(groupId)
        if (cached && now - cached.checkedAt < GROUP_RELAY_READY_TTL_MS) {
          return cached.relayUrl
        }
      }

      const refreshPromise = (async () => {
        try {
          const refreshResult = await refreshRelaySubscriptionsRef.current({
            publicIdentifier: target.groupId,
            reason: 'lists-discover-fetch',
            timeoutMs: 12_000
          })
          const status = String(refreshResult?.status || '')
          const reason = String(refreshResult?.reason || '')
          const relayUrl =
            status === 'ok' || reason === 'throttled'
              ? resolveRelayUrlRef.current(target.relayUrl) || target.relayUrl
              : null
          groupRelayReadyCacheRef.current.set(groupId, {
            checkedAt: Date.now(),
            relayUrl
          })
          return relayUrl
        } catch (_error) {
          groupRelayReadyCacheRef.current.set(groupId, {
            checkedAt: Date.now(),
            relayUrl: null
          })
          return null
        } finally {
          groupRelayReadyInFlightRef.current.delete(groupId)
        }
      })()

      groupRelayReadyInFlightRef.current.set(groupId, refreshPromise)
      return await refreshPromise
    },
    []
  )

  const resolveReadyGroupRelayUrls = useCallback(
    async (force = false) => {
      const readyGroupRelayUrls = await Promise.all(
        stableGroupRelayTargets.map((target) => resolveReadyGroupRelayUrl(target, force))
      )
      return dedupeRelayUrlsByIdentity(
        readyGroupRelayUrls.filter((relayUrl): relayUrl is string => !!relayUrl)
      )
    },
    [resolveReadyGroupRelayUrl, stableGroupRelayTargets]
  )

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    ;(async () => {
      await fetchLists()
      if (cancelled) return
      const readyGroupRelayUrls = await resolveReadyGroupRelayUrls()
      if (cancelled) return
      if (readyGroupRelayUrls.length > 0) {
        await fetchLists(readyGroupRelayUrls)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchLists, groupRelayTargetsSignature, pubkey, resolveReadyGroupRelayUrls])

  const fetchPublicLists = useCallback(async () => {
    if (publicListsFetchInFlightRef.current) {
      await publicListsFetchInFlightRef.current
      return
    }

    const run = (async () => {
      setIsLoadingPublicLists(true)
      try {
        const readyGroupRelayUrlsPromise = resolveReadyGroupRelayUrls()

        const baseEvents = baseDiscoverFetchRelayUrls.length
          ? await client.fetchEvents(baseDiscoverFetchRelayUrls, {
              kinds: [ExtendedKind.STARTER_PACK],
              limit: 50
            })
          : []
        const baseLists = dedupeLatestLists(baseEvents.map((event) => parseStarterPackEvent(event)))
        setAllPublicLists(baseLists)
        setIsLoadingPublicLists(false)

        try {
          const readyGroupRelayUrls = await readyGroupRelayUrlsPromise
          if (!readyGroupRelayUrls.length) return
          const groupEvents = await client.fetchEvents(readyGroupRelayUrls, {
            kinds: [ExtendedKind.STARTER_PACK],
            limit: 50
          })
          if (!groupEvents.length) return
          const groupLists = groupEvents.map((event) => parseStarterPackEvent(event))
          setAllPublicLists((previous) => dedupeLatestLists([...previous, ...groupLists]))
        } catch (error) {
          console.warn('Failed to fetch discover lists from group relays:', error)
        }
      } catch (_error) {
        console.error('Failed to fetch public lists:', _error)
      } finally {
        setIsLoadingPublicLists(false)
      }
    })()

    publicListsFetchInFlightRef.current = run
    try {
      await run
    } finally {
      if (publicListsFetchInFlightRef.current === run) {
        publicListsFetchInFlightRef.current = null
      }
    }
  }, [baseDiscoverFetchRelayUrls, dedupeLatestLists, resolveReadyGroupRelayUrls])

  useEffect(() => {
    fetchPublicLists()
  }, [fetchPublicLists])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }

    setIsSearching(true)

    const searchInLists = () => {
      const query = searchQuery.toLowerCase()
      const filtered = allPublicLists.filter((list) => {
        return (
          list.title.toLowerCase().includes(query) ||
          list.description?.toLowerCase().includes(query)
        )
      })
      setSearchResults(filtered)
      setIsSearching(false)
    }

    const debounce = setTimeout(searchInLists, 300)
    return () => clearTimeout(debounce)
  }, [searchQuery, allPublicLists])

  const sortLists = (listItems: TStarterPack[]) => {
    if (sortBy === 'zaps') {
      return [...listItems].sort((a, b) => {
        const aZaps = listStatsService.getTotalZapAmount?.(a.event.pubkey, a.id) || 0
        const bZaps = listStatsService.getTotalZapAmount?.(b.event.pubkey, b.id) || 0
        return bZaps - aZaps
      })
    }
    return [...listItems].sort((a, b) => b.event.created_at - a.event.created_at)
  }

  const startCreateList = () => {
    const openEditor = () => {
      if (isSmallScreen) {
        setCreateSheetOpen(true)
      } else {
        push(toCreateList())
      }
    }

    if (!pubkey) {
      checkLogin(() => openEditor())
      return
    }

    openEditor()
  }

  const handleListClick = async (listId: string) => {
    let ownerPubkey: string | undefined
    let dTag: string

    if (listId.includes(':')) {
      const [listPubkey, tag] = listId.split(':')
      ownerPubkey = listPubkey
      dTag = tag
    } else {
      ownerPubkey = pubkey || undefined
      dTag = listId
    }

    const ownList = Array.isArray(lists) ? lists.find((l) => l.id === dTag) : null

    if (ownList) {
      setSelectedList(ownList)
      listStatsService.fetchListStats(ownList.event.pubkey, ownList.id, pubkey)
      return
    }

    if (!ownerPubkey || !dTag) return

    setIsLoadingSelectedList(true)
    try {
      let events = baseDiscoverFetchRelayUrls.length
        ? await client.fetchEvents(baseDiscoverFetchRelayUrls, {
            kinds: [ExtendedKind.STARTER_PACK],
            authors: [ownerPubkey],
            '#d': [dTag],
            limit: 1
          })
        : []
      if (!events.length) {
        const readyGroupRelayUrls = await resolveReadyGroupRelayUrls()
        if (readyGroupRelayUrls.length > 0) {
          events = await client.fetchEvents(readyGroupRelayUrls, {
            kinds: [ExtendedKind.STARTER_PACK],
            authors: [ownerPubkey],
            '#d': [dTag],
            limit: 1
          })
        }
      }
      if (events.length > 0) {
        const list = parseStarterPackEvent(events[0])
        setSelectedList(list)
        listStatsService.fetchListStats(list.event.pubkey, list.id, pubkey)
      }
    } catch (_error) {
      console.error('Failed to fetch list:', _error)
    } finally {
      setIsLoadingSelectedList(false)
    }
  }

  const handleDeleteList = async () => {
    if (!listToDelete) return
    try {
      await deleteList(listToDelete)
      toast.success(t('Delete') + ' ' + t('successfully'))
    } catch (_error) {
      toast.error(t('Delete') + ' ' + t('failed'))
    } finally {
      setDeleteDialogOpen(false)
      setListToDelete(null)
    }
  }

  const handleToggleFavorite = (listKey: string) => {
    if (favoriteLists.includes(listKey)) {
      localStorageService.removeFavoriteList(listKey, pubkey)
    } else {
      localStorageService.addFavoriteList(listKey, pubkey)
    }
    setFavoriteLists(localStorageService.getFavoriteLists(pubkey))
  }

  const handleFollowAllMembers = async (pubkeys: string[], listKey?: string) => {
    const alreadyFollowingAll =
      pubkeys.length === 0 ||
      pubkeys.every((pk) => pk && (pk === pubkey || followings.includes(pk))) ||
      (listKey ? followedLists.has(listKey) : false)

    const followAction = async () => {
      const unique = pubkeys.filter((pk) => pk && pk !== pubkey && !followings.includes(pk))
      if (!unique.length) {
        toast.info(t('You are already following everyone in this list'))
        return
      }

      try {
        await followMultiple(unique)
        if (listKey) {
          setFollowedLists((prev) => new Set(prev).add(listKey))
        }
        toast.success(t('Followed all members'))
      } catch (_error) {
        toast.error(t('Follow failed'))
      }
    }

    const unfollowAction = async () => {
      const targets = pubkeys.filter((pk) => pk && pk !== pubkey && followings.includes(pk))
      if (!targets.length) return

      try {
        await unfollowMultiple(targets)
        if (listKey) {
          setFollowedLists((prev) => {
            const next = new Set(prev)
            next.delete(listKey)
            return next
          })
        }
        toast.success(t('Unfollowed all members'))
      } catch (_error) {
        toast.error(t('Unfollow failed'))
      }
    }

    if (!pubkey) {
      await checkLogin(() => (alreadyFollowingAll ? unfollowAction() : followAction()))
      return
    }

    if (alreadyFollowingAll) {
      await unfollowAction()
    } else {
      await followAction()
    }
  }

  const refreshSelectedList = async () => {
    if (!selectedList) return
    const listKey = `${selectedList.event.pubkey}:${selectedList.id}`
    await handleListClick(listKey)
  }

  const handleRefresh = async () => {
    const listFetchRelayUrls = await resolveReadyGroupRelayUrls(true)
    if (selectedList) {
      await refreshSelectedList()
      await fetchLists(listFetchRelayUrls)
      await fetchPublicLists()
      return
    }
    await Promise.all([fetchLists(listFetchRelayUrls), fetchPublicLists()])
  }

  const renderListCard = (list: TStarterPack, isOwnList: boolean) => {
    const listKey = `${list.event.pubkey}:${list.id}`
    const isFavorite = favoriteLists.includes(listKey)
    const isExpanded = expandedDescriptions.has(listKey)
    const memberCount = Array.isArray(list.pubkeys) ? list.pubkeys.length : 0
    const alreadyFollowedAll =
      memberCount === 0 ||
      list.pubkeys.every((pk) => pk === pubkey || followings.includes(pk)) ||
      followedLists.has(listKey)

    const descriptionNeedsTruncation = (list.description?.length || 0) > 140

    return (
      <Card
        key={listKey}
        className={`cursor-pointer transition-colors ${isSmallScreen ? 'rounded-none border-x-0 shadow-none' : 'hover:bg-accent/50'} overflow-hidden`}
        onClick={() => handleListClick(listKey)}
      >
        <CardContent className={isSmallScreen ? 'py-4 px-0' : 'p-4'}>
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3">
              {list.image && (
                <img
                  src={list.image}
                  alt={list.title}
                  className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-lg line-clamp-2 mb-1">{list.title}</h3>
                <div className="flex items-center gap-2 text-sm text-muted-foreground flex-nowrap min-w-0">
                  <span className="whitespace-nowrap">
                    {memberCount} {memberCount === 1 ? t('member') : t('members')}
                  </span>
                  {!isOwnList && (
                    <>
                      <span className="text-muted-foreground">•</span>
                      <div className="inline-flex items-center gap-1 min-w-0 whitespace-nowrap">
                        <span>{t('By')}</span>
                        <UserAvatar
                          userId={list.event.pubkey}
                          size="xSmall"
                          className="inline-block"
                        />
                        <Username
                          userId={list.event.pubkey}
                          className="font-medium inline truncate max-w-[120px] min-w-0"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {!isOwnList && (
                  <Button
                    variant={alreadyFollowedAll ? 'default' : 'outline'}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleFollowAllMembers(list.pubkeys || [], listKey)
                    }}
                    title={alreadyFollowedAll ? t('Unfollow all members') : t('Follow all members')}
                    className="text-xs px-2 h-8 whitespace-nowrap"
                  >
                    {alreadyFollowedAll ? (
                      <>
                        <Check className="w-3 h-3 mr-1" />
                        {t('Unfollow')}
                      </>
                    ) : (
                      t('Follow all')
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleToggleFavorite(listKey)
                  }}
                  title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                >
                  <Star
                    className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : 'text-muted-foreground'}`}
                  />
                </Button>
                {isOwnList && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        push(toEditList(list.id))
                      }}
                      title={t('Edit')}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        setListToDelete(list.id)
                        setDeleteDialogOpen(true)
                      }}
                      title={t('Delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            {list.description && (
              <div className="text-sm text-muted-foreground">
                {descriptionNeedsTruncation && !isExpanded ? (
                  <>
                    {list.description.substring(0, 140)}...{' '}
                    <button
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedDescriptions((prev) => new Set(prev).add(listKey))
                      }}
                    >
                      {t('Show more...')}
                    </button>
                  </>
                ) : (
                  list.description
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderSelectedList = () => {
    if (isLoadingSelectedList) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('Loading...')}
        </div>
      )
    }

    if (!selectedList) return null

    const listKey = `${selectedList.event.pubkey}:${selectedList.id}`
    const isFavorite = favoriteLists.includes(listKey)
    const pubkeys = Array.isArray(selectedList.pubkeys) ? selectedList.pubkeys : []
    const memberCount = pubkeys.length

    return (
      <div className="flex flex-col h-full">
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <Button variant="ghost" size="sm" onClick={() => setSelectedList(null)}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('Back to Lists')}
            </Button>

            {memberCount > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleFavorite(listKey)}
                  title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                >
                  <Star
                    className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : 'text-muted-foreground'}`}
                  />
                </Button>
                <Button
                  variant={followedLists.has(listKey) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleFollowAllMembers(pubkeys, listKey)}
                  title={
                    followedLists.has(listKey) ? t('Unfollow all members') : t('Follow all members')
                  }
                >
                  <UserPlus className="w-4 h-4 mr-2" />
                  {followedLists.has(listKey) ? t('Unfollow') : t('Follow all members')}
                </Button>
                {selectedList.event.pubkey === pubkey && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => push(toEditList(selectedList.id))}
                  >
                    <Edit className="w-4 h-4 mr-2" />
                    {t('Edit')}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-start gap-4">
            {selectedList.image && (
              <img
                src={selectedList.image}
                alt={selectedList.title}
                className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-2xl font-bold mb-1">{selectedList.title}</h2>
              </div>
              {selectedList.event.pubkey !== pubkey && (
                <div className="text-sm text-muted-foreground mb-2 flex items-center gap-1">
                  <span>{t('By')}</span>
                  <UserAvatar userId={selectedList.event.pubkey} size="small" />
                  <Username userId={selectedList.event.pubkey} className="font-medium" />
                </div>
              )}
              <div className="text-sm text-muted-foreground mb-3">
                {memberCount} {memberCount === 1 ? t('member') : t('members')}
              </div>
              {selectedList.description && (
                <p className="text-sm text-muted-foreground">
                  {expandedDescriptions.has(listKey) ? (
                    selectedList.description
                  ) : selectedList.description.length > 140 ? (
                    <>
                      {selectedList.description.substring(0, 140)}...{' '}
                      <button
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedDescriptions((prev) => new Set(prev).add(listKey))
                        }}
                      >
                        {t('Show more...')}
                      </button>
                    </>
                  ) : (
                    selectedList.description
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {pubkeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <div className="text-muted-foreground">{t('No members in this list')}</div>
              {selectedList.event.pubkey === pubkey && (
                <Button onClick={() => push(toEditList(selectedList.id))} variant="outline">
                  {t('Add Members')}
                </Button>
              )}
            </div>
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as 'notes' | 'members')}
              className="w-full"
            >
              <div className="border-b">
                <TabsList className="w-full justify-start h-auto p-0 bg-transparent px-4">
                  <TabsTrigger
                    value="notes"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Notes')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="members"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Members')} ({memberCount})
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="notes" className="mt-0">
                <NoteList
                  subRequests={selectedListNoteSubRequests}
                  showKinds={LIST_NOTE_FEED_KINDS}
                />
              </TabsContent>
              <TabsContent value="members" className="mt-0">
                <ProfileList pubkeys={pubkeys} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    )
  }

  const favoriteListObjects = useMemo(() => {
    const listMap = new Map<string, TStarterPack>()
    ;(lists || []).forEach((l) => listMap.set(`${l.event.pubkey}:${l.id}`, l))
    ;(allPublicLists || []).forEach((l) => {
      const key = `${l.event.pubkey}:${l.id}`
      if (!listMap.has(key)) listMap.set(key, l)
    })
    if (selectedList) {
      const key = `${selectedList.event.pubkey}:${selectedList.id}`
      listMap.set(key, selectedList)
    }

    const favListObjects: TStarterPack[] = []
    favoriteLists.forEach((key) => {
      const match = listMap.get(key)
      if (match) {
        favListObjects.push(match)
      }
    })
    return favListObjects
  }, [favoriteLists, lists, allPublicLists, selectedList])

  const myListObjects = useMemo(() => {
    if (!lists) return []
    return lists
  }, [lists])

  const discoverListObjects = useMemo(() => {
    const latestByKey = new Map<string, TStarterPack>()
    const combinedLists = [...(allPublicLists || []), ...(lists || [])]

    combinedLists.forEach((list) => {
      const key = `${list.event.pubkey}:${list.id}`
      const current = latestByKey.get(key)
      if (!current || current.event.created_at < list.event.created_at) {
        latestByKey.set(key, list)
      }
    })

    return Array.from(latestByKey.values())
  }, [allPublicLists, lists])

  const selectedAuthorPubkeySet = useMemo(
    () => getSelectedAuthorPubkeys(sharedListOptions, sharedFilterSettings.selectedListKeys),
    [sharedFilterSettings.selectedListKeys, sharedListOptions]
  )

  const sinceTimestamp = useMemo(
    () => getSharedFeedFilterSinceTimestamp(sharedFilterSettings),
    [sharedFilterSettings]
  )

  const relayFilterActive = useMemo(
    () =>
      isRelaySelectionActive(
        effectiveSelectedRelayIdentities,
        sharedRelayOptions.map((option) => option.relayIdentity)
      ),
    [effectiveSelectedRelayIdentities, sharedRelayOptions]
  )

  const filterListObjects = useCallback(
    (listItems: TStarterPack[]) => {
      const selectedRelaySet = new Set(effectiveSelectedRelayIdentities)

      let filteredItems = listItems.filter((list) => {
        if (
          sharedFilterSettings.recencyEnabled
          && sinceTimestamp
          && list.event.created_at < sinceTimestamp
        ) {
          return false
        }

        if (mutePubkeySet.has(list.event.pubkey)) {
          return false
        }

        if (
          sharedFilterSettings.selectedListKeys.length > 0
          && !selectedAuthorPubkeySet.has(list.event.pubkey)
        ) {
          return false
        }

        if (relayFilterActive) {
          const relayUrls = dedupeRelayUrlsByIdentity([
            ...(list.relayUrls || []),
            ...client.getSeenEventRelayUrls(list.event.id, list.event)
          ])
          if (!relayUrls.length) return false
          const hasMatchingRelay = relayUrls.some((relayUrl) => {
            const relayIdentity = getRelayIdentity(relayUrl)
            return relayIdentity ? selectedRelaySet.has(relayIdentity) : false
          })
          if (!hasMatchingRelay) {
            return false
          }
        }

        if (
          matchesMutedWordList(
            [list.title, list.description, list.id, list.event.content],
            sharedFilterSettings.mutedWords
          )
        ) {
          return false
        }

        if (
          sharedFilterSettings.selectedLanguageCodes.length > 0
          && !matchesSelectedLanguageCodes(
            [list.title, list.description, list.event.content],
            sharedFilterSettings.selectedLanguageCodes
          )
        ) {
          return false
        }

        return true
      })

      if (sharedFilterSettings.maxItemsPerAuthor > 0) {
        const countsByAuthor = new Map<string, number>()
        filteredItems.forEach((list) => {
          countsByAuthor.set(list.event.pubkey, (countsByAuthor.get(list.event.pubkey) || 0) + 1)
        })
        filteredItems = filteredItems.filter(
          (list) =>
            (countsByAuthor.get(list.event.pubkey) || 0) <= sharedFilterSettings.maxItemsPerAuthor
        )
      }

      return filteredItems
    },
    [
      effectiveSelectedRelayIdentities,
      mutePubkeySet,
      relayFilterActive,
      selectedAuthorPubkeySet,
      sharedFilterSettings.maxItemsPerAuthor,
      sharedFilterSettings.selectedLanguageCodes,
      sharedFilterSettings.mutedWords,
      sharedFilterSettings.recencyEnabled,
      sharedFilterSettings.selectedListKeys.length,
      sinceTimestamp
    ]
  )

  const filteredDiscoverListObjects = useMemo(
    () => filterListObjects(discoverListObjects),
    [discoverListObjects, filterListObjects]
  )

  const filteredFavoriteListObjects = useMemo(
    () => filterListObjects(favoriteListObjects),
    [favoriteListObjects, filterListObjects]
  )

  const filteredMyListObjects = useMemo(
    () => filterListObjects(myListObjects),
    [filterListObjects, myListObjects]
  )

  const filteredSearchResults = useMemo(
    () => filterListObjects(searchResults),
    [filterListObjects, searchResults]
  )

  const visibleListObjectsForSort = useMemo(() => {
    if (searchQuery.trim()) return filteredSearchResults
    if (activeSection === 'favorites') return filteredFavoriteListObjects
    if (activeSection === 'my') return filteredMyListObjects
    return filteredDiscoverListObjects
  }, [
    activeSection,
    filteredFavoriteListObjects,
    filteredDiscoverListObjects,
    filteredMyListObjects,
    filteredSearchResults,
    searchQuery,
  ])

  const selectedListNoteAuthors = selectedList?.pubkeys ?? []
  const selectedListNoteAuthorsKey = useMemo(
    () => selectedListNoteAuthors.join(','),
    [selectedListNoteAuthors]
  )
  const selectedListNoteSubRequests = useMemo(
    () =>
      selectedListNoteAuthors.length
        ? [
            {
              source: 'relays' as const,
              urls: BIG_RELAY_URLS,
              filter: {
                authors: selectedListNoteAuthors,
                kinds: LIST_NOTE_FEED_KINDS
              }
            }
          ]
        : [],
    [selectedListNoteAuthorsKey]
  )

  useEffect(() => {
    if (sortBy !== 'zaps' || visibleListObjectsForSort.length === 0) return
    let cancelled = false
    ;(async () => {
      await Promise.all(
        visibleListObjectsForSort.map((list) =>
          listStatsService.fetchListStats(list.event.pubkey, list.id, pubkey)
        )
      )
      if (!cancelled) {
        setListStatsVersion((v) => v + 1)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pubkey, sortBy, visibleListObjectsForSort])

  const renderListGroup = (items: TStarterPack[]) => {
    if (!items.length) {
      return <div className="text-sm text-muted-foreground">{t('No lists found')}</div>
    }
    return (
      <div className={isSmallScreen ? 'divide-y border-y' : 'grid gap-3'}>
        {sortLists(items).map((list) => renderListCard(list, list?.event?.pubkey === pubkey))}
      </div>
    )
  }

  const sectionContent = useMemo(() => {
    if (activeSection === 'my' && isLoadingMyLists) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('Loading...')}
        </div>
      )
    }

    if (isLoadingPublicLists && activeSection === 'discover') {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          <div className="text-center text-muted-foreground">{t('Loading...')}</div>
        </div>
      )
    }

    switch (activeSection) {
      case 'favorites':
        return renderListGroup(filteredFavoriteListObjects)
      case 'my':
        return renderListGroup(filteredMyListObjects)
      default:
        return renderListGroup(filteredDiscoverListObjects)
    }
  }, [
    activeSection,
    filteredDiscoverListObjects,
    filteredFavoriteListObjects,
    isLoadingPublicLists,
    filteredMyListObjects,
    isLoadingMyLists,
    listStatsVersion,
    sortBy,
    followings,
    followedLists,
    isSmallScreen
  ])

  const isSharedFilterMenuActive = isSharedFeedFilterActive(
    {
      ...sharedFilterSettings,
      selectedRelayIdentities: effectiveSelectedRelayIdentities
    },
    defaultSharedFilterSettings
  )

  const sortControl = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title={t('Sort') as string}>
          <ArrowUpDown className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('Sort')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sortBy}
          onValueChange={(value) => setSortBy(value as TSortBy)}
        >
          <DropdownMenuRadioItem value="recent">{t('Most recent')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="zaps">{t('Most zapped')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const sharedFilterControl = (
    <SharedFeedFilterMenu
      settings={{
        ...sharedFilterSettings,
        selectedRelayIdentities: effectiveSelectedRelayIdentities
      }}
      defaultSettings={defaultSharedFilterSettings}
      timeFrameOptions={timeFrameOptions}
      relayOptions={sharedRelayOptions}
      listOptions={sharedListOptions}
      languageOptions={languageOptions}
      isActive={isSharedFilterMenuActive}
      onApply={setSharedFilterSettings}
      onReset={(nextSettings) => resetSharedFilterSettings(nextSettings)}
      onCreateRelayOption={addCustomRelayUrl}
      onRemoveRelayOption={removeCustomRelayIdentity}
    />
  )

  const tabs = useMemo<TTabDefinition[]>(
    () => [
      { value: 'discover', label: 'Discover' },
      { value: 'favorites', label: 'Favorites' },
      { value: 'my', label: 'My Lists' }
    ],
    []
  )

  const renderTabs = !selectedList && !(isSmallScreen && showSearchBar) && !searchQuery && (
    <div className={isSmallScreen ? '' : 'px-4'}>
      <TabsBar
        tabs={tabs}
        value={activeSection}
        onTabChange={(tab) => setActiveSection(tab as 'discover' | 'favorites' | 'my')}
        options={isSmallScreen ? <div className="flex items-center gap-1">{sortControl}{sharedFilterControl}</div> : null}
        topOffset="0"
        reserveOptionsSpace={!isSmallScreen}
      />
    </div>
  )

  const renderSearchBar = !selectedList && (!isSmallScreen || showSearchBar) && (
    <div className={`flex items-center gap-2 ${isSmallScreen && showSearchBar ? 'mt-4' : ''}`}>
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t('Search lists...') as string}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      {!isSmallScreen && sortControl}
      {!isSmallScreen && sharedFilterControl}
      {!isSmallScreen && (
        <Button onClick={startCreateList} size="default">
          <Plus className="w-4 h-4 mr-1" />
          {t('Create')}
        </Button>
      )}
    </div>
  )

  let content: React.ReactNode = null

  if (selectedList) {
    content = renderSelectedList()
  } else {
    content = (
      <div className="space-y-4">
        {!searchQuery && renderTabs}
        <div className={isSmallScreen ? 'px-4 space-y-4' : 'p-4 space-y-6'}>
          {renderSearchBar}

          {searchQuery ? (
            <div className="space-y-4">
              <h2 className="text-xl font-bold">{t('Search Results')}</h2>
              {isSearching && (
                <div className="text-center text-muted-foreground py-8">{t('Searching...')}</div>
              )}
              {!isSearching && (!filteredSearchResults || filteredSearchResults.length === 0) && (
                <div className="text-center text-muted-foreground py-8">
                  {t('No starter packs found')}
                </div>
              )}
              {filteredSearchResults && filteredSearchResults.length > 0 && (
                <div className={isSmallScreen ? 'divide-y border-y' : 'grid gap-3'}>
                  {sortLists(filteredSearchResults).map((list) =>
                    renderListCard(list, list?.event?.pubkey === pubkey)
                  )}
                </div>
              )}
            </div>
          ) : (
            sectionContent
          )}
        </div>
      </div>
    )
  }

  return (
    <PrimaryPageLayout
      pageName="lists"
      ref={layoutRef}
      titlebar={
        <ListsPageTitlebar
          isSmallScreen={isSmallScreen}
          selectedListTitle={selectedList?.title}
          onToggleSearch={() => setShowSearchBar((prev) => !prev)}
          onCreateClick={startCreateList}
        />
      }
      displayScrollToTopButton
    >
      <PullToRefresh onRefresh={handleRefresh}>
        <div>{content}</div>
      </PullToRefresh>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Are you sure you want to delete this list?')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteDialogOpen(false)}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteList}>{t('Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={createSheetOpen} onOpenChange={setCreateSheetOpen}>
        <SheetContent side="bottom" className="h-[90vh] p-0">
          <ScrollArea className="h-full">
            <div className="p-4">
              <ListEditorForm
                onSaved={() => {
                  setCreateSheetOpen(false)
                  ;(async () => {
                    const listFetchRelayUrls = await resolveReadyGroupRelayUrls(true)
                    await fetchLists(listFetchRelayUrls)
                  })()
                  fetchPublicLists()
                }}
                onCancel={() => setCreateSheetOpen(false)}
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </PrimaryPageLayout>
  )
})

ListsPage.displayName = 'ListsPage'

export default ListsPage

function ListsPageTitlebar({
  isSmallScreen,
  selectedListTitle,
  onToggleSearch,
  onCreateClick
}: {
  isSmallScreen: boolean
  selectedListTitle?: string
  onToggleSearch: () => void
  onCreateClick: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-1 items-center h-full justify-between px-3">
      <div className="font-semibold text-lg flex-1 truncate">{selectedListTitle || t('Lists')}</div>
      {isSmallScreen ? (
        <div className="shrink-0 flex gap-1 items-center">
          <Button variant="ghost" size="titlebar-icon" onClick={onToggleSearch}>
            <Search className="w-5 h-5" />
          </Button>
          <Button variant="ghost" size="titlebar-icon" onClick={onCreateClick}>
            <PencilLine className="w-5 h-5" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
