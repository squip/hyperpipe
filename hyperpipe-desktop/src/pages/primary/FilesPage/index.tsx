import GroupFilesTable from '@/components/GroupFilesTable'
import SharedFeedFilterMenu from '@/components/SharedFeedFilterMenu'
import TitlebarInfoButton from '@/components/TitlebarInfoButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import useSharedFeedFilterSettings from '@/hooks/useSharedFeedFilterSettings'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import {
  areStringArraysEqual,
  createDefaultSharedFeedFilterSettings,
  getSelectedAuthorPubkeys,
  getSharedFeedFilterSinceTimestamp,
  isRelaySelectionActive,
  isSharedFeedFilterActive,
  matchesMutedWordList,
  prependFollowingListOption,
  type TFeedFilterExtensionOption,
  type TFeedFilterListOption,
  type TFeedFilterRelayOption
} from '@/lib/shared-feed-filters'
import {
  getGroupFileExtensionLabel,
  normalizeGroupFileExtension,
  resolveGroupFileExtension
} from '@/lib/group-files'
import {
  buildGroupRelayDisplayMetaMap,
  buildGroupRelayTargets,
  dedupeRelayTargetsByIdentity,
  getRelayIdentity
} from '@/lib/relay-targets'
import { simplifyUrl } from '@/lib/url'
import { useGroupFiles } from '@/providers/GroupFilesProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useFollowList } from '@/providers/FollowListProvider'
import { useLists } from '@/providers/ListsProvider'
import { useMuteList } from '@/providers/MuteListProvider'
import { TPageRef } from '@/types'
import { Files, Loader2, Search } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const FilesPage = forwardRef<TPageRef>((_, ref) => {
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current!)
  const { t } = useTranslation()
  const { records, isLoading, refresh, lastUpdated } = useGroupFiles()
  const { lists } = useLists()
  const { followings } = useFollowList()
  const { mutePubkeySet } = useMuteList()
  const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()
  const {
    settings,
    setSettings,
    resetSettings,
    timeFrameOptions,
    hasSavedSettings
  } = useSharedFeedFilterSettings('files')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

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

  const relayDisplayMeta = useMemo(
    () => buildGroupRelayDisplayMetaMap(groupRelayTargets),
    [groupRelayTargets]
  )

  const relayOptions = useMemo<TFeedFilterRelayOption[]>(
    () =>
      dedupeRelayTargetsByIdentity(groupRelayTargets.map((target) => target.relayUrl)).map(
        (target) => {
          const meta = relayDisplayMeta[target.relayIdentity] || relayDisplayMeta[target.relayUrl]
          return {
            relayIdentity: target.relayIdentity,
            relayUrl: target.relayUrl,
            label: meta?.label?.trim() || simplifyUrl(target.relayUrl),
            subtitle: meta?.hideUrl ? null : simplifyUrl(target.relayUrl),
            imageUrl: meta?.imageUrl || null,
            hideUrl: meta?.hideUrl
          }
        }
      ),
    [groupRelayTargets, relayDisplayMeta]
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
          includeFollowing: true,
          label: t('Following'),
          description: t('From people you follow')
        }
      ),
    [followings, lists, t]
  )

  const fileExtensionOptions = useMemo<TFeedFilterExtensionOption[]>(() => {
    const optionByExtension = new Map<string, TFeedFilterExtensionOption>()
    const order: string[] = []

    records.forEach((record) => {
      const extension = resolveGroupFileExtension(record)
      if (!optionByExtension.has(extension)) {
        order.push(extension)
      }
      optionByExtension.set(extension, {
        extension,
        label: getGroupFileExtensionLabel(extension),
        description: record.mime || null
      })
    })

    return order
      .sort((left, right) => {
        if (left === 'unknown') return 1
        if (right === 'unknown') return -1
        return left.localeCompare(right)
      })
      .map((extension) => optionByExtension.get(extension))
      .filter((option): option is TFeedFilterExtensionOption => !!option)
  }, [records])

  const defaultFilterSettings = useMemo(
    () =>
      createDefaultSharedFeedFilterSettings(
        'files',
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

  const selectedAuthorPubkeySet = useMemo(
    () => getSelectedAuthorPubkeys(listOptions, settings.selectedListKeys),
    [listOptions, settings.selectedListKeys]
  )

  const selectedFileExtensionSet = useMemo(
    () => new Set(settings.selectedFileExtensions),
    [settings.selectedFileExtensions]
  )

  const sinceTimestamp = useMemo(
    () => getSharedFeedFilterSinceTimestamp(settings),
    [settings]
  )

  const relayFilterActive = useMemo(
    () =>
      isRelaySelectionActive(
        effectiveSelectedRelayIdentities,
        relayOptions.map((option) => option.relayIdentity)
      ),
    [effectiveSelectedRelayIdentities, relayOptions]
  )

  const filteredRecords = useMemo(() => {
    const selectedRelaySet = new Set(effectiveSelectedRelayIdentities)
    let nextRecords = records.filter((record) => {
      if (settings.recencyEnabled && sinceTimestamp && record.uploadedAt < sinceTimestamp) {
        return false
      }

      if (mutePubkeySet.has(record.uploadedBy)) {
        return false
      }

      if (settings.selectedListKeys.length > 0 && !selectedAuthorPubkeySet.has(record.uploadedBy)) {
        return false
      }

      if (relayFilterActive) {
        const relayIdentity = record.groupRelay ? getRelayIdentity(record.groupRelay) : null
        if (!relayIdentity || !selectedRelaySet.has(relayIdentity)) {
          return false
        }
      }

      if (
        settings.selectedFileExtensions.length > 0
        && !selectedFileExtensionSet.has(resolveGroupFileExtension(record))
      ) {
        return false
      }

      if (
        matchesMutedWordList(
          [record.fileName, record.alt, record.summary, record.groupName, record.groupId],
          settings.mutedWords
        )
      ) {
        return false
      }

      return true
    })

    if (settings.maxItemsPerAuthor > 0) {
      const countsByAuthor = new Map<string, number>()
      nextRecords.forEach((record) => {
        countsByAuthor.set(record.uploadedBy, (countsByAuthor.get(record.uploadedBy) || 0) + 1)
      })
      nextRecords = nextRecords.filter(
        (record) => (countsByAuthor.get(record.uploadedBy) || 0) <= settings.maxItemsPerAuthor
      )
    }

    return nextRecords
  }, [
    effectiveSelectedRelayIdentities,
    mutePubkeySet,
    records,
    relayFilterActive,
    selectedAuthorPubkeySet,
    selectedFileExtensionSet,
    settings.maxItemsPerAuthor,
    settings.mutedWords,
    settings.recencyEnabled,
    settings.selectedFileExtensions.length,
    settings.selectedListKeys.length,
    sinceTimestamp
  ])

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

  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PrimaryPageLayout
      pageName="files"
      ref={layoutRef}
      titlebar={<FilesPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('Search files...') as string}
              className="pl-9"
            />
          </div>
          <SharedFeedFilterMenu
            settings={{
              ...settings,
              selectedRelayIdentities: effectiveSelectedRelayIdentities
            }}
            defaultSettings={defaultFilterSettings}
            timeFrameOptions={timeFrameOptions}
            relayOptions={relayOptions}
            listOptions={listOptions}
            fileExtensionOptions={fileExtensionOptions}
            isActive={isFilterActive}
            onApply={setSettings}
            onReset={(nextSettings) => resetSettings(nextSettings)}
            createFileExtensionValue={normalizeGroupFileExtension}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('Refresh') as string}
          >
            <Loader2 className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <GroupFilesTable
          records={filteredRecords}
          loading={isLoading}
          showGroupColumn
          showDownloadAction
          searchQuery={search}
          emptyLabel={t('No files uploaded yet')}
          defaultSortKey="uploadedAt"
          defaultSortDirection="desc"
        />
        {lastUpdated ? (
          <div className="text-xs text-muted-foreground">
            {t('Last updated')}: {new Date(lastUpdated).toLocaleTimeString()}
          </div>
        ) : null}
      </div>
    </PrimaryPageLayout>
  )
})

FilesPage.displayName = 'FilesPage'

export default FilesPage

function FilesPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full w-full min-w-0 items-center justify-between pl-3 pr-2">
      <div className="flex gap-2 items-center [&_svg]:text-muted-foreground">
        <Files />
        <div className="text-lg font-semibold" style={{ fontSize: 'var(--title-font-size, 18px)' }}>
          {t('Files')}
        </div>
      </div>
      <TitlebarInfoButton
        label="Files info"
        content="Search, sort, and manage your p2p file system across all your Hyperpipe group relays."
      />
    </div>
  )
}
