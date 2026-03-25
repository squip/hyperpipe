import { getTimeFrameInMs, type TStoredTimeFrame, type TTimeFrame } from '@/lib/time-frame'

export type TSharedFeedFilterPage = 'reads' | 'groups' | 'files' | 'lists'

export type TSharedFeedFilterSettings = {
  recencyEnabled: boolean
  timeFrame: TTimeFrame
  maxItemsPerAuthor: number
  mutedWords: string
  selectedRelayIdentities: string[]
  selectedListKeys: string[]
}

export type TStoredSharedFeedFilterSettings = {
  recencyEnabled: boolean
  timeFrame: TStoredTimeFrame
  maxItemsPerAuthor: number
  mutedWords: string
  selectedRelayIdentities: string[]
  selectedListKeys: string[]
}

export type TFeedFilterRelayOption = {
  relayIdentity: string
  relayUrl: string
  label: string
  subtitle?: string | null
  imageUrl?: string | null
  hideUrl?: boolean
}

export type TFeedFilterListOption = {
  key: string
  label: string
  authorPubkeys: string[]
  description?: string | null
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
    mutedWords: '',
    selectedRelayIdentities,
    selectedListKeys: []
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
    selectedListKeys
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
  )
}
