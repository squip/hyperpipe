import { getTimeFrameInMs, type TStoredTimeFrame, type TTimeFrame } from '@/lib/time-frame'
import {
  buildGroupRelayDisplayMetaMap,
  dedupeRelayUrlsByIdentity,
  getRelayIdentity,
  normalizeRelayTransportUrl,
  type GroupRelayTarget
} from '@/lib/relay-targets'
import { simplifyUrl } from '@/lib/url'

export type TSharedFeedFilterPage = 'reads' | 'groups' | 'files' | 'lists'
export const FOLLOWING_FEED_FILTER_KEY = '__following__'

export type TSharedFeedFilterSettings = {
  recencyEnabled: boolean
  timeFrame: TTimeFrame
  maxItemsPerAuthor: number
  mutedWords: string
  selectedRelayIdentities: string[]
  selectedListKeys: string[]
  selectedLanguageCodes: string[]
  selectedFileExtensions: string[]
  customFileExtensions: string[]
}

export type TStoredSharedFeedFilterSettings = {
  recencyEnabled: boolean
  timeFrame: TStoredTimeFrame
  maxItemsPerAuthor: number
  mutedWords: string
  selectedRelayIdentities: string[]
  selectedListKeys: string[]
  selectedLanguageCodes: string[]
  selectedFileExtensions: string[]
  customFileExtensions: string[]
}

export type TFeedFilterRelayOption = {
  relayIdentity: string
  relayUrl: string
  label: string
  subtitle?: string | null
  imageUrl?: string | null
  hideUrl?: boolean
  isCustom?: boolean
}

export type TFeedFilterListOption = {
  key: string
  label: string
  authorPubkeys: string[]
  description?: string | null
}

export type TFeedFilterLanguageOption = {
  code: string
  label: string
}

export type TFeedFilterExtensionOption = {
  extension: string
  label: string
  description?: string | null
  isCustom?: boolean
}

export function createDefaultSharedFeedFilterSettings(
  page: TSharedFeedFilterPage,
  timeFrameOptions: TTimeFrame[],
  selectedRelayIdentities: string[] = []
): TSharedFeedFilterSettings {
  return {
    recencyEnabled: page === 'reads',
    timeFrame: timeFrameOptions[23],
    maxItemsPerAuthor: 0,
    mutedWords: page === 'groups' ? 'test' : '',
    selectedRelayIdentities,
    selectedListKeys: [],
    selectedLanguageCodes: [],
    selectedFileExtensions: [],
    customFileExtensions: []
  }
}

export function toStoredSharedFeedFilterSettings(
  settings: TSharedFeedFilterSettings
): TStoredSharedFeedFilterSettings {
  return {
    ...settings,
    timeFrame: {
      value: settings.timeFrame.value,
      unit: settings.timeFrame.unit
    }
  }
}

export function restoreSharedFeedFilterSettings(
  storedSettings: TStoredSharedFeedFilterSettings,
  page: TSharedFeedFilterPage,
  timeFrameOptions: TTimeFrame[]
): TSharedFeedFilterSettings {
  const defaults = createDefaultSharedFeedFilterSettings(page, timeFrameOptions)
  const selectedRelayIdentities = Array.isArray(storedSettings.selectedRelayIdentities)
    ? storedSettings.selectedRelayIdentities.filter(Boolean)
    : defaults.selectedRelayIdentities
  const selectedListKeys = Array.isArray(storedSettings.selectedListKeys)
    ? storedSettings.selectedListKeys.filter(Boolean)
    : defaults.selectedListKeys
  const selectedLanguageCodes = Array.isArray(storedSettings.selectedLanguageCodes)
    ? storedSettings.selectedLanguageCodes.filter(Boolean)
    : defaults.selectedLanguageCodes
  const selectedFileExtensions = Array.isArray(storedSettings.selectedFileExtensions)
    ? storedSettings.selectedFileExtensions.filter(Boolean)
    : defaults.selectedFileExtensions
  const customFileExtensions = Array.isArray(storedSettings.customFileExtensions)
    ? storedSettings.customFileExtensions.filter(Boolean)
    : defaults.customFileExtensions

  return {
    recencyEnabled: storedSettings.recencyEnabled ?? defaults.recencyEnabled,
    timeFrame:
      timeFrameOptions.find(
        (option) =>
          option.value === storedSettings.timeFrame?.value
          && option.unit === storedSettings.timeFrame?.unit
      ) || defaults.timeFrame,
    maxItemsPerAuthor: Math.max(0, Number(storedSettings.maxItemsPerAuthor) || 0),
    mutedWords: storedSettings.mutedWords ?? '',
    selectedRelayIdentities,
    selectedListKeys,
    selectedLanguageCodes,
    selectedFileExtensions,
    customFileExtensions
  }
}

export function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export function sortStrings(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right))
}

export function isSameStringSet(left: string[], right: string[]) {
  return areStringArraysEqual(sortStrings(left), sortStrings(right))
}

export function getSharedFeedFilterSinceTimestamp(settings: TSharedFeedFilterSettings) {
  if (!settings.recencyEnabled) return undefined
  return Math.floor((Date.now() - getTimeFrameInMs(settings.timeFrame)) / 1000)
}

export function parseMutedWords(value: string) {
  return value
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
}

export function matchesMutedWordList(values: Array<string | null | undefined>, mutedWords: string) {
  const words = parseMutedWords(mutedWords)
  if (!words.length) return false

  const haystacks = values
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean)

  return words.some((word) => haystacks.some((value) => value.includes(word)))
}

export function getSelectedAuthorPubkeys(
  listOptions: TFeedFilterListOption[],
  selectedListKeys: string[]
) {
  const selectedListKeySet = new Set(selectedListKeys)
  const authorPubkeySet = new Set<string>()

  listOptions.forEach((option) => {
    if (!selectedListKeySet.has(option.key)) return
    option.authorPubkeys.forEach((pubkey) => {
      if (pubkey) {
        authorPubkeySet.add(pubkey)
      }
    })
  })

  return authorPubkeySet
}

export function prependFollowingListOption(
  listOptions: TFeedFilterListOption[],
  options?: {
    followings?: string[]
    includeFollowing?: boolean
    label?: string
    description?: string | null
  }
) {
  if (!options?.includeFollowing) return listOptions
  const nextFollowings = Array.isArray(options.followings) ? options.followings.filter(Boolean) : []
  return [
    {
      key: FOLLOWING_FEED_FILTER_KEY,
      label: options.label || 'Following',
      description: options.description || null,
      authorPubkeys: Array.from(new Set(nextFollowings))
    },
    ...listOptions
  ]
}

export function buildSharedFeedRelayOptions({
  discoveryRelayUrls = [],
  groupRelayTargets = [],
  customRelayUrls = [],
  extraRelayUrls = []
}: {
  discoveryRelayUrls?: string[]
  groupRelayTargets?: GroupRelayTarget[]
  customRelayUrls?: string[]
  extraRelayUrls?: string[]
}) {
  const groupRelayMetaMap = buildGroupRelayDisplayMetaMap(groupRelayTargets)
  const optionByIdentity = new Map<string, TFeedFilterRelayOption>()
  const order: string[] = []
  const customRelayIdentitySet = new Set(
    customRelayUrls
      .map((relayUrl) => {
        const normalizedRelayUrl = normalizeRelayTransportUrl(relayUrl)
        return normalizedRelayUrl ? getRelayIdentity(normalizedRelayUrl) : null
      })
      .filter((relayIdentity): relayIdentity is string => !!relayIdentity)
  )

  const registerRelay = (relayUrl: string) => {
    const normalizedRelayUrl = normalizeRelayTransportUrl(relayUrl)
    if (!normalizedRelayUrl) return
    const relayIdentity = getRelayIdentity(normalizedRelayUrl)
    if (!relayIdentity) return

    const existing = optionByIdentity.get(relayIdentity)
    const dedupedRelayUrl = existing
      ? dedupeRelayUrlsByIdentity([existing.relayUrl, normalizedRelayUrl])[0] || existing.relayUrl
      : normalizedRelayUrl
    const meta =
      groupRelayMetaMap[relayIdentity]
      || groupRelayMetaMap[normalizedRelayUrl]
      || groupRelayMetaMap[dedupedRelayUrl]
      || null
    const nextOption: TFeedFilterRelayOption = {
      relayIdentity,
      relayUrl: dedupedRelayUrl,
      label: meta?.label?.trim() || simplifyUrl(dedupedRelayUrl),
      subtitle: meta?.hideUrl ? null : meta?.subtitle || simplifyUrl(dedupedRelayUrl),
      imageUrl: meta?.imageUrl || null,
      hideUrl: meta?.hideUrl,
      isCustom: customRelayIdentitySet.has(relayIdentity)
    }

    if (!existing) {
      order.push(relayIdentity)
    }

    optionByIdentity.set(relayIdentity, nextOption)
  }

  discoveryRelayUrls.forEach(registerRelay)
  groupRelayTargets.forEach((target) => registerRelay(target.relayUrl))
  customRelayUrls.forEach(registerRelay)
  extraRelayUrls.forEach(registerRelay)

  return order
    .map((relayIdentity) => optionByIdentity.get(relayIdentity))
    .filter((option): option is TFeedFilterRelayOption => !!option)
}

export function isRelaySelectionActive(
  selectedRelayIdentities: string[],
  allRelayIdentities: string[]
) {
  if (!allRelayIdentities.length) return false
  return !isSameStringSet(selectedRelayIdentities, allRelayIdentities)
}

export function isSharedFeedFilterActive(
  settings: TSharedFeedFilterSettings,
  defaults: TSharedFeedFilterSettings
) {
  return (
    settings.recencyEnabled !== defaults.recencyEnabled
    || settings.timeFrame.value !== defaults.timeFrame.value
    || settings.timeFrame.unit !== defaults.timeFrame.unit
    || settings.maxItemsPerAuthor !== defaults.maxItemsPerAuthor
    || settings.mutedWords.trim() !== defaults.mutedWords.trim()
    || !isSameStringSet(settings.selectedRelayIdentities, defaults.selectedRelayIdentities)
    || !isSameStringSet(settings.selectedListKeys, defaults.selectedListKeys)
    || !isSameStringSet(settings.selectedLanguageCodes, defaults.selectedLanguageCodes)
    || !isSameStringSet(settings.selectedFileExtensions, defaults.selectedFileExtensions)
    || !isSameStringSet(settings.customFileExtensions, defaults.customFileExtensions)
  )
}
