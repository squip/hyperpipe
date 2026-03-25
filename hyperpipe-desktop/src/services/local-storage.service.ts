import {
  DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT,
  DEFAULT_ENABLE_SINGLE_COLUMN_LAYOUT,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_NIP_96_SERVICE,
  DEFAULT_THEME_SETTING,
  ExtendedKind,
  HOSTED_TRANSLATION_SERVICE_ID,
  LINK_PREVIEW_MODE,
  MEDIA_AUTO_LOAD_POLICY,
  NOTIFICATION_LIST_STYLE,
  SUPPORTED_KINDS,
  StorageKey,
  TPrimaryColor
} from '@/constants'
import { isSameAccount } from '@/lib/account'
import { randomString } from '@/lib/random'
import {
  TAccount,
  TAccountPointer,
  TFeedInfo,
  TLocalGroupRelayFeedSelection,
  TLinkPreviewMode,
  TMediaAutoLoadPolicy,
  TMediaUploadServiceConfig,
  TNoteListMode,
  TNotificationStyle,
  TMutedList,
  TRelaySet,
  TThemeSetting,
  TTranslationServiceConfig
} from '@/types'
import { TStoredGroupedNotesSettings } from '@/providers/GroupedNotesProvider'
import {
  TSharedFeedFilterPage,
  TStoredSharedFeedFilterSettings
} from '@/lib/shared-feed-filters'

export type ArchivedGroupFilesEntry = {
  groupId: string
  relay?: string
  archivedAt: number
}

export type GroupLeavePublishRetryEntry = {
  groupId: string
  relay?: string
  relayKey?: string | null
  publicIdentifier?: string | null
  isPublicGroup?: boolean
  needs9022: boolean
  needs10009: boolean
  attempts: number
  nextAttemptAt: number
  lastError?: string | null
  updatedAt: number
}

function isLocalRelayProxyUrl(relay?: string | null) {
  if (!relay) return false
  try {
    const parsed = new URL(relay)
    return (
      (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    )
  } catch (_err) {
    return /^wss?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(String(relay || ''))
  }
}

function sanitizeLocalGroupRelaySelection(
  selection?: TLocalGroupRelayFeedSelection | null
): TLocalGroupRelayFeedSelection | null {
  const groupId = String(selection?.groupId || '').trim()
  if (!groupId) return null
  const relayIdentity =
    typeof selection?.relayIdentity === 'string' && selection.relayIdentity.trim()
      ? selection.relayIdentity.trim()
      : null
  return relayIdentity ? { groupId, relayIdentity } : { groupId }
}

function extractLocalGroupRelaySelectionFromRelayUrl(
  relay?: string | null
): TLocalGroupRelayFeedSelection | null {
  const input = String(relay || '').trim()
  if (!input || !isLocalRelayProxyUrl(input)) return null

  try {
    const parsed = new URL(input)
    const pathSegments = parsed.pathname.split('/').filter(Boolean)
    if (pathSegments.length < 2) return null
    const owner = pathSegments[0]?.trim()
    const slug = pathSegments[1]?.trim()
    if (!owner || !slug || !/^npub1/i.test(owner)) return null
    return { groupId: `${owner}:${slug}` }
  } catch (_err) {
    const match = input.match(/(?:127\.0\.0\.1|localhost)(?::\d+)?\/([^/?#]+)\/([^/?#]+)/i)
    if (!match) return null
    const owner = String(match[1] || '').trim()
    const slug = String(match[2] || '').trim()
    if (!owner || !slug || !/^npub1/i.test(owner)) return null
    return { groupId: `${owner}:${slug}` }
  }
}

function normalizeStoredFeedInfo(info?: TFeedInfo | null): TFeedInfo | undefined {
  if (!info || typeof info !== 'object') return undefined
  if (info.feedType === 'following') {
    return { feedType: 'following' }
  }
  if (info.feedType === 'relays') {
    return {
      feedType: 'relays',
      ...(typeof info.id === 'string' && info.id.trim() ? { id: info.id.trim() } : {})
    }
  }
  if (info.feedType !== 'relay') return undefined

  const localGroupRelay =
    sanitizeLocalGroupRelaySelection(info.localGroupRelay || null)
    || extractLocalGroupRelaySelectionFromRelayUrl(info.id)
  if (localGroupRelay) {
    return {
      feedType: 'relay',
      localGroupRelay
    }
  }

  const relayId = typeof info.id === 'string' ? info.id.trim() : ''
  if (!relayId) return undefined
  return {
    feedType: 'relay',
    id: relayId
  }
}

function areFeedInfosEqual(a?: TFeedInfo, b?: TFeedInfo) {
  return JSON.stringify(a || null) === JSON.stringify(b || null)
}

class LocalStorageService {
  static instance: LocalStorageService

  private relaySets: TRelaySet[] = []
  private themeSetting: TThemeSetting = DEFAULT_THEME_SETTING
  private accounts: TAccount[] = []
  private currentAccount: TAccount | null = null
  private noteListMode: TNoteListMode = 'posts'
  private lastReadNotificationTimeMap: Record<string, number> = {}
  private defaultZapSats: number = 21
  private defaultZapComment: string = 'Zap!'
  private quickZap: boolean = false
  private accountFeedInfoMap: Record<string, TFeedInfo | undefined> = {}
  private mediaUploadService: string = DEFAULT_NIP_96_SERVICE
  private autoplay: boolean = true
  private hideUntrustedInteractions: boolean = false
  private hideUntrustedNotifications: boolean = false
  private hideUntrustedNotes: boolean = false
  private translationServiceConfigMap: Record<string, TTranslationServiceConfig> = {}
  private mediaUploadServiceConfigMap: Record<string, TMediaUploadServiceConfig> = {}
  private defaultShowNsfw: boolean = false
  private dismissedTooManyRelaysAlert: boolean = false
  private showKinds: number[] = []
  private hideContentMentioningMutedUsers: boolean = false
  private notificationListStyle: TNotificationStyle = NOTIFICATION_LIST_STYLE.DETAILED
  private mediaAutoLoadPolicy: TMediaAutoLoadPolicy = MEDIA_AUTO_LOAD_POLICY.ALWAYS
  private groupedNotesSettings: TStoredGroupedNotesSettings | null = null
  private sharedFeedFilterSettingsMap: Record<
    string,
    Partial<Record<TSharedFeedFilterPage, TStoredSharedFeedFilterSettings>>
  > = {}
  private muteListCacheMap: Record<string, TMutedList> = {}
  private shownCreateWalletGuideToastPubkeys: Set<string> = new Set()
  private sidebarCollapse: boolean = false
  private primaryColor: TPrimaryColor = DEFAULT_PRIMARY_COLOR
  private enableSingleColumnLayout: boolean = DEFAULT_ENABLE_SINGLE_COLUMN_LAYOUT
  private desktopPrimaryColumnWidth: number = DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT
  private linkPreviewMode: TLinkPreviewMode = LINK_PREVIEW_MODE.ENABLED
  private favoriteListsMap: Record<string, string[]> = {}
  private favoriteGroupsMap: Record<string, string[]> = {}
  private groupDiscoveryRelays: string[] = []
  private archivedGroupFilesMap: Record<string, ArchivedGroupFilesEntry[]> = {}
  private groupLeavePublishRetryQueueMap: Record<string, GroupLeavePublishRetryEntry[]> = {}
  private dismissedGroupAdminLeaveEventsMap: Record<string, string[]> = {}

  constructor() {
    if (!LocalStorageService.instance) {
      this.init()
      LocalStorageService.instance = this
    }
    return LocalStorageService.instance
  }

  init() {
    this.themeSetting =
      (window.localStorage.getItem(StorageKey.THEME_SETTING) as TThemeSetting)
      ?? DEFAULT_THEME_SETTING
    const accountsStr = window.localStorage.getItem(StorageKey.ACCOUNTS)
    this.accounts = accountsStr ? JSON.parse(accountsStr) : []
    const currentAccountStr = window.localStorage.getItem(StorageKey.CURRENT_ACCOUNT)
    this.currentAccount = currentAccountStr ? JSON.parse(currentAccountStr) : null
    const noteListModeStr = window.localStorage.getItem(StorageKey.NOTE_LIST_MODE)
    this.noteListMode =
      noteListModeStr && ['posts', 'postsAndReplies', 'pictures'].includes(noteListModeStr)
        ? (noteListModeStr as TNoteListMode)
        : 'posts'
    const lastReadNotificationTimeMapStr =
      window.localStorage.getItem(StorageKey.LAST_READ_NOTIFICATION_TIME_MAP) ?? '{}'
    this.lastReadNotificationTimeMap = JSON.parse(lastReadNotificationTimeMapStr)

    const relaySetsStr = window.localStorage.getItem(StorageKey.RELAY_SETS)
    if (!relaySetsStr) {
      let relaySets: TRelaySet[] = []
      const legacyRelayGroupsStr = window.localStorage.getItem('relayGroups')
      if (legacyRelayGroupsStr) {
        const legacyRelayGroups = JSON.parse(legacyRelayGroupsStr)
        relaySets = legacyRelayGroups.map((group: any) => {
          return {
            id: randomString(),
            name: group.groupName,
            relayUrls: group.relayUrls
          }
        })
      }
      if (!relaySets.length) {
        relaySets = []
      }
      window.localStorage.setItem(StorageKey.RELAY_SETS, JSON.stringify(relaySets))
      this.relaySets = relaySets
    } else {
      this.relaySets = JSON.parse(relaySetsStr)
    }

    const defaultZapSatsStr = window.localStorage.getItem(StorageKey.DEFAULT_ZAP_SATS)
    if (defaultZapSatsStr) {
      const num = parseInt(defaultZapSatsStr)
      if (!isNaN(num)) {
        this.defaultZapSats = num
      }
    }
    this.defaultZapComment = window.localStorage.getItem(StorageKey.DEFAULT_ZAP_COMMENT) ?? 'Zap!'
    this.quickZap = window.localStorage.getItem(StorageKey.QUICK_ZAP) === 'true'

    const accountFeedInfoMapStr =
      window.localStorage.getItem(StorageKey.ACCOUNT_FEED_INFO_MAP) ?? '{}'
    this.accountFeedInfoMap = JSON.parse(accountFeedInfoMapStr)

    this.autoplay = window.localStorage.getItem(StorageKey.AUTOPLAY) !== 'false'

    const hideUntrustedEvents =
      window.localStorage.getItem(StorageKey.HIDE_UNTRUSTED_EVENTS) === 'true'
    const storedHideUntrustedInteractions = window.localStorage.getItem(
      StorageKey.HIDE_UNTRUSTED_INTERACTIONS
    )
    const storedHideUntrustedNotifications = window.localStorage.getItem(
      StorageKey.HIDE_UNTRUSTED_NOTIFICATIONS
    )
    const storedHideUntrustedNotes = window.localStorage.getItem(StorageKey.HIDE_UNTRUSTED_NOTES)
    this.hideUntrustedInteractions = storedHideUntrustedInteractions
      ? storedHideUntrustedInteractions === 'true'
      : hideUntrustedEvents
    this.hideUntrustedNotifications = storedHideUntrustedNotifications
      ? storedHideUntrustedNotifications === 'true'
      : hideUntrustedEvents
    this.hideUntrustedNotes = storedHideUntrustedNotes
      ? storedHideUntrustedNotes === 'true'
      : hideUntrustedEvents

    const translationServiceConfigMapStr = window.localStorage.getItem(
      StorageKey.TRANSLATION_SERVICE_CONFIG_MAP
    )
    if (translationServiceConfigMapStr) {
      this.translationServiceConfigMap = JSON.parse(translationServiceConfigMapStr)
    }

    const mediaUploadServiceConfigMapStr = window.localStorage.getItem(
      StorageKey.MEDIA_UPLOAD_SERVICE_CONFIG_MAP
    )
    if (mediaUploadServiceConfigMapStr) {
      this.mediaUploadServiceConfigMap = JSON.parse(mediaUploadServiceConfigMapStr)
    }

    this.defaultShowNsfw = window.localStorage.getItem(StorageKey.DEFAULT_SHOW_NSFW) === 'true'

    this.dismissedTooManyRelaysAlert =
      window.localStorage.getItem(StorageKey.DISMISSED_TOO_MANY_RELAYS_ALERT) === 'true'

    const showKindsStr = window.localStorage.getItem(StorageKey.SHOW_KINDS)
    if (!showKindsStr) {
      this.showKinds = SUPPORTED_KINDS
    } else {
      const showKindsVersionStr = window.localStorage.getItem(StorageKey.SHOW_KINDS_VERSION)
      const showKindsVersion = showKindsVersionStr ? parseInt(showKindsVersionStr) : 0
      const showKinds = JSON.parse(showKindsStr) as number[]
      if (showKindsVersion < 1) {
        showKinds.push(ExtendedKind.VIDEO, ExtendedKind.SHORT_VIDEO)
      }
      this.showKinds = showKinds
    }
    window.localStorage.setItem(StorageKey.SHOW_KINDS, JSON.stringify(this.showKinds))
    window.localStorage.setItem(StorageKey.SHOW_KINDS_VERSION, '1')

    this.hideContentMentioningMutedUsers =
      window.localStorage.getItem(StorageKey.HIDE_CONTENT_MENTIONING_MUTED_USERS) === 'true'

    this.notificationListStyle =
      window.localStorage.getItem(StorageKey.NOTIFICATION_LIST_STYLE) ===
      NOTIFICATION_LIST_STYLE.COMPACT
        ? NOTIFICATION_LIST_STYLE.COMPACT
        : NOTIFICATION_LIST_STYLE.DETAILED

    const mediaAutoLoadPolicy = window.localStorage.getItem(StorageKey.MEDIA_AUTO_LOAD_POLICY)
    if (
      mediaAutoLoadPolicy &&
      Object.values(MEDIA_AUTO_LOAD_POLICY).includes(mediaAutoLoadPolicy as TMediaAutoLoadPolicy)
    ) {
      this.mediaAutoLoadPolicy = mediaAutoLoadPolicy as TMediaAutoLoadPolicy
    }

    const favoriteListsMapStr = window.localStorage.getItem(StorageKey.FAVORITE_LISTS)
    if (favoriteListsMapStr) {
      try {
        const parsed = JSON.parse(favoriteListsMapStr)
        this.favoriteListsMap = Array.isArray(parsed) ? { _global: parsed } : parsed
      } catch {
        this.favoriteListsMap = {}
      }
    }

    const favoriteGroupsMapStr = window.localStorage.getItem(StorageKey.FAVORITE_GROUPS)
    if (favoriteGroupsMapStr) {
      try {
        const parsed = JSON.parse(favoriteGroupsMapStr)
        this.favoriteGroupsMap = Array.isArray(parsed) ? { _global: parsed } : parsed
      } catch {
        this.favoriteGroupsMap = {}
      }
    }

    const groupDiscoveryRelaysStr = window.localStorage.getItem(StorageKey.GROUP_DISCOVERY_RELAYS)
    if (groupDiscoveryRelaysStr) {
      try {
        this.groupDiscoveryRelays = JSON.parse(groupDiscoveryRelaysStr)
      } catch {
        this.groupDiscoveryRelays = []
      }
    }

    const archivedGroupFilesStr = window.localStorage.getItem(
      StorageKey.GROUP_FILES_ARCHIVED_GROUPS
    )
    if (archivedGroupFilesStr) {
      try {
        const parsed = JSON.parse(archivedGroupFilesStr)
        this.archivedGroupFilesMap = Array.isArray(parsed) ? { _global: parsed } : parsed
      } catch {
        this.archivedGroupFilesMap = {}
      }
    }

    const groupLeaveRetryQueueStr = window.localStorage.getItem(
      StorageKey.GROUP_LEAVE_PUBLISH_RETRY_QUEUE
    )
    if (groupLeaveRetryQueueStr) {
      try {
        const parsed = JSON.parse(groupLeaveRetryQueueStr)
        this.groupLeavePublishRetryQueueMap = Array.isArray(parsed) ? { _global: parsed } : parsed
      } catch {
        this.groupLeavePublishRetryQueueMap = {}
      }
    }

    const dismissedGroupAdminLeaveEventsStr = window.localStorage.getItem(
      StorageKey.GROUP_ADMIN_LEAVE_DISMISSED_EVENTS
    )
    if (dismissedGroupAdminLeaveEventsStr) {
      try {
        const parsed = JSON.parse(dismissedGroupAdminLeaveEventsStr)
        this.dismissedGroupAdminLeaveEventsMap = Array.isArray(parsed)
          ? { _global: parsed }
          : parsed
      } catch {
        this.dismissedGroupAdminLeaveEventsMap = {}
      }
    }

    const groupedNotesSettingsStr = window.localStorage.getItem(StorageKey.GROUPED_NOTES_SETTINGS)
    if (groupedNotesSettingsStr) {
      try {
        this.groupedNotesSettings = JSON.parse(groupedNotesSettingsStr)
      } catch {
        // Invalid JSON, ignore and use defaults
        this.groupedNotesSettings = null
      }
    }
    const sharedFeedFilterSettingsStr = window.localStorage.getItem(
      StorageKey.SHARED_FEED_FILTER_SETTINGS
    )
    if (sharedFeedFilterSettingsStr) {
      try {
        this.sharedFeedFilterSettingsMap = JSON.parse(sharedFeedFilterSettingsStr)
      } catch {
        this.sharedFeedFilterSettingsMap = {}
      }
    }
    const muteListCacheStr = window.localStorage.getItem(StorageKey.MUTE_LIST_CACHE)
    if (muteListCacheStr) {
      try {
        this.muteListCacheMap = JSON.parse(muteListCacheStr)
      } catch {
        this.muteListCacheMap = {}
      }
    }
    const shownCreateWalletGuideToastPubkeysStr = window.localStorage.getItem(
      StorageKey.SHOWN_CREATE_WALLET_GUIDE_TOAST_PUBKEYS
    )
    this.shownCreateWalletGuideToastPubkeys = shownCreateWalletGuideToastPubkeysStr
      ? new Set(JSON.parse(shownCreateWalletGuideToastPubkeysStr))
      : new Set()

    this.sidebarCollapse = window.localStorage.getItem(StorageKey.SIDEBAR_COLLAPSE) === 'true'

    this.primaryColor =
      (window.localStorage.getItem(StorageKey.PRIMARY_COLOR) as TPrimaryColor)
      ?? DEFAULT_PRIMARY_COLOR

    const storedEnableSingleColumnLayout = window.localStorage.getItem(
      StorageKey.ENABLE_SINGLE_COLUMN_LAYOUT
    )
    this.enableSingleColumnLayout =
      storedEnableSingleColumnLayout === null
        ? DEFAULT_ENABLE_SINGLE_COLUMN_LAYOUT
        : storedEnableSingleColumnLayout === 'true'

    const storedDesktopPrimaryColumnWidth = window.localStorage.getItem(
      StorageKey.DESKTOP_PRIMARY_COLUMN_WIDTH
    )
    const legacyDesktopPrimaryColumnWidth = window.localStorage.getItem('column-width')
    const parsedDesktopPrimaryColumnWidth = parseFloat(
      storedDesktopPrimaryColumnWidth ?? legacyDesktopPrimaryColumnWidth ?? ''
    )
    this.desktopPrimaryColumnWidth = Number.isFinite(parsedDesktopPrimaryColumnWidth)
      ? Math.max(20, Math.min(80, parsedDesktopPrimaryColumnWidth))
      : DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT

    // Migration logic for old boolean showLinkPreviews to new enum linkPreviewMode
    const storedLinkPreviewMode = window.localStorage.getItem(StorageKey.SHOW_LINK_PREVIEWS)
    if (storedLinkPreviewMode === 'true') {
      this.linkPreviewMode = LINK_PREVIEW_MODE.ENABLED
    } else if (storedLinkPreviewMode === 'false') {
      this.linkPreviewMode = LINK_PREVIEW_MODE.NEVER
    } else if (
      storedLinkPreviewMode &&
      Object.values(LINK_PREVIEW_MODE).includes(storedLinkPreviewMode as TLinkPreviewMode)
    ) {
      this.linkPreviewMode = storedLinkPreviewMode as TLinkPreviewMode
    } else {
      this.linkPreviewMode = LINK_PREVIEW_MODE.ENABLED
    }
  }

  getRelaySets() {
    return this.relaySets
  }

  setRelaySets(relaySets: TRelaySet[]) {
    this.relaySets = relaySets
    window.localStorage.setItem(StorageKey.RELAY_SETS, JSON.stringify(this.relaySets))
  }

  getThemeSetting() {
    return this.themeSetting
  }

  setThemeSetting(themeSetting: TThemeSetting) {
    window.localStorage.setItem(StorageKey.THEME_SETTING, themeSetting)
    this.themeSetting = themeSetting
  }

  getNoteListMode() {
    return this.noteListMode
  }

  setNoteListMode(mode: TNoteListMode) {
    window.localStorage.setItem(StorageKey.NOTE_LIST_MODE, mode)
    this.noteListMode = mode
  }

  getAccounts() {
    return this.accounts
  }

  findAccount(account: TAccountPointer) {
    return this.accounts.find((act) => isSameAccount(act, account))
  }

  getCurrentAccount() {
    return this.currentAccount
  }

  getAccountNsec(pubkey: string) {
    const account = this.accounts.find((act) => act.pubkey === pubkey && act.signerType === 'nsec')
    return account?.nsec
  }

  getAccountNcryptsec(pubkey: string) {
    const account = this.accounts.find(
      (act) => act.pubkey === pubkey && act.signerType === 'ncryptsec'
    )
    return account?.ncryptsec
  }

  addAccount(account: TAccount) {
    const index = this.accounts.findIndex((act) => isSameAccount(act, account))
    if (index !== -1) {
      this.accounts[index] = account
    } else {
      this.accounts.push(account)
    }
    window.localStorage.setItem(StorageKey.ACCOUNTS, JSON.stringify(this.accounts))
    return this.accounts
  }

  removeAccount(account: TAccount) {
    this.accounts = this.accounts.filter((act) => !isSameAccount(act, account))
    window.localStorage.setItem(StorageKey.ACCOUNTS, JSON.stringify(this.accounts))
    return this.accounts
  }

  switchAccount(account: TAccount | null) {
    if (isSameAccount(this.currentAccount, account)) {
      return
    }
    const act = this.accounts.find((act) => isSameAccount(act, account))
    if (!act) {
      return
    }
    this.currentAccount = act
    window.localStorage.setItem(StorageKey.CURRENT_ACCOUNT, JSON.stringify(act))
  }

  getDefaultZapSats() {
    return this.defaultZapSats
  }

  setDefaultZapSats(sats: number) {
    this.defaultZapSats = sats
    window.localStorage.setItem(StorageKey.DEFAULT_ZAP_SATS, sats.toString())
  }

  getDefaultZapComment() {
    return this.defaultZapComment
  }

  setDefaultZapComment(comment: string) {
    this.defaultZapComment = comment
    window.localStorage.setItem(StorageKey.DEFAULT_ZAP_COMMENT, comment)
  }

  getQuickZap() {
    return this.quickZap
  }

  setQuickZap(quickZap: boolean) {
    this.quickZap = quickZap
    window.localStorage.setItem(StorageKey.QUICK_ZAP, quickZap.toString())
  }

  getLastReadNotificationTime(pubkey: string) {
    return this.lastReadNotificationTimeMap[pubkey] ?? 0
  }

  setLastReadNotificationTime(pubkey: string, time: number) {
    this.lastReadNotificationTimeMap[pubkey] = time
    window.localStorage.setItem(
      StorageKey.LAST_READ_NOTIFICATION_TIME_MAP,
      JSON.stringify(this.lastReadNotificationTimeMap)
    )
  }

  getFeedInfo(pubkey: string) {
    const key = pubkey || 'default'
    const current = this.accountFeedInfoMap[key]
    const normalized = normalizeStoredFeedInfo(current)

    if (!normalized) {
      if (typeof current !== 'undefined') {
        delete this.accountFeedInfoMap[key]
        window.localStorage.setItem(
          StorageKey.ACCOUNT_FEED_INFO_MAP,
          JSON.stringify(this.accountFeedInfoMap)
        )
      }
      return undefined
    }

    if (!areFeedInfosEqual(current, normalized)) {
      this.accountFeedInfoMap[key] = normalized
      window.localStorage.setItem(
        StorageKey.ACCOUNT_FEED_INFO_MAP,
        JSON.stringify(this.accountFeedInfoMap)
      )
    }

    return normalized
  }

  setFeedInfo(info: TFeedInfo, pubkey?: string | null) {
    const normalized = normalizeStoredFeedInfo(info)
    if (!normalized) return
    this.accountFeedInfoMap[pubkey ?? 'default'] = normalized
    window.localStorage.setItem(
      StorageKey.ACCOUNT_FEED_INFO_MAP,
      JSON.stringify(this.accountFeedInfoMap)
    )
  }

  getAutoplay() {
    return this.autoplay
  }

  setAutoplay(autoplay: boolean) {
    this.autoplay = autoplay
    window.localStorage.setItem(StorageKey.AUTOPLAY, autoplay.toString())
  }

  getHideUntrustedInteractions() {
    return this.hideUntrustedInteractions
  }

  setHideUntrustedInteractions(hideUntrustedInteractions: boolean) {
    this.hideUntrustedInteractions = hideUntrustedInteractions
    window.localStorage.setItem(
      StorageKey.HIDE_UNTRUSTED_INTERACTIONS,
      hideUntrustedInteractions.toString()
    )
  }

  getHideUntrustedNotifications() {
    return this.hideUntrustedNotifications
  }

  setHideUntrustedNotifications(hideUntrustedNotifications: boolean) {
    this.hideUntrustedNotifications = hideUntrustedNotifications
    window.localStorage.setItem(
      StorageKey.HIDE_UNTRUSTED_NOTIFICATIONS,
      hideUntrustedNotifications.toString()
    )
  }

  getHideUntrustedNotes() {
    return this.hideUntrustedNotes
  }

  setHideUntrustedNotes(hideUntrustedNotes: boolean) {
    this.hideUntrustedNotes = hideUntrustedNotes
    window.localStorage.setItem(StorageKey.HIDE_UNTRUSTED_NOTES, hideUntrustedNotes.toString())
  }

  getTranslationServiceConfig(pubkey?: string | null) {
    return this.translationServiceConfigMap[pubkey ?? '_'] ?? { service: HOSTED_TRANSLATION_SERVICE_ID }
  }

  setTranslationServiceConfig(config: TTranslationServiceConfig, pubkey?: string | null) {
    this.translationServiceConfigMap[pubkey ?? '_'] = config
    window.localStorage.setItem(
      StorageKey.TRANSLATION_SERVICE_CONFIG_MAP,
      JSON.stringify(this.translationServiceConfigMap)
    )
  }

  getMediaUploadServiceConfig(pubkey?: string | null): TMediaUploadServiceConfig {
    const defaultConfig = { type: 'nip96', service: this.mediaUploadService } as const
    if (!pubkey) {
      return defaultConfig
    }
    return this.mediaUploadServiceConfigMap[pubkey] ?? defaultConfig
  }

  setMediaUploadServiceConfig(
    pubkey: string,
    config: TMediaUploadServiceConfig
  ): TMediaUploadServiceConfig {
    this.mediaUploadServiceConfigMap[pubkey] = config
    window.localStorage.setItem(
      StorageKey.MEDIA_UPLOAD_SERVICE_CONFIG_MAP,
      JSON.stringify(this.mediaUploadServiceConfigMap)
    )
    return config
  }

  getDefaultShowNsfw() {
    return this.defaultShowNsfw
  }

  setDefaultShowNsfw(defaultShowNsfw: boolean) {
    this.defaultShowNsfw = defaultShowNsfw
    window.localStorage.setItem(StorageKey.DEFAULT_SHOW_NSFW, defaultShowNsfw.toString())
  }

  getDismissedTooManyRelaysAlert() {
    return this.dismissedTooManyRelaysAlert
  }

  setDismissedTooManyRelaysAlert(dismissed: boolean) {
    this.dismissedTooManyRelaysAlert = dismissed
    window.localStorage.setItem(StorageKey.DISMISSED_TOO_MANY_RELAYS_ALERT, dismissed.toString())
  }

  getShowKinds() {
    return this.showKinds
  }

  setShowKinds(kinds: number[]) {
    this.showKinds = kinds
    window.localStorage.setItem(StorageKey.SHOW_KINDS, JSON.stringify(kinds))
  }

  getHideContentMentioningMutedUsers() {
    return this.hideContentMentioningMutedUsers
  }

  setHideContentMentioningMutedUsers(hide: boolean) {
    this.hideContentMentioningMutedUsers = hide
    window.localStorage.setItem(StorageKey.HIDE_CONTENT_MENTIONING_MUTED_USERS, hide.toString())
  }

  getNotificationListStyle() {
    return this.notificationListStyle
  }

  setNotificationListStyle(style: TNotificationStyle) {
    this.notificationListStyle = style
    window.localStorage.setItem(StorageKey.NOTIFICATION_LIST_STYLE, style)
  }

  getMediaAutoLoadPolicy() {
    return this.mediaAutoLoadPolicy
  }

  setMediaAutoLoadPolicy(policy: TMediaAutoLoadPolicy) {
    this.mediaAutoLoadPolicy = policy
    window.localStorage.setItem(StorageKey.MEDIA_AUTO_LOAD_POLICY, policy)
  }

  getGroupedNotesSettings() {
    return this.groupedNotesSettings
  }

  setGroupedNotesSettings(settings: TStoredGroupedNotesSettings) {
    this.groupedNotesSettings = settings
    window.localStorage.setItem(StorageKey.GROUPED_NOTES_SETTINGS, JSON.stringify(settings))
  }

  getSharedFeedFilterSettings(
    pubkey: string | null | undefined,
    page: TSharedFeedFilterPage
  ) {
    const key = pubkey || '_global'
    return this.sharedFeedFilterSettingsMap[key]?.[page] || null
  }

  setSharedFeedFilterSettings(
    pubkey: string | null | undefined,
    page: TSharedFeedFilterPage,
    settings: TStoredSharedFeedFilterSettings
  ) {
    const key = pubkey || '_global'
    const current = this.sharedFeedFilterSettingsMap[key] || {}
    this.sharedFeedFilterSettingsMap[key] = {
      ...current,
      [page]: settings
    }
    window.localStorage.setItem(
      StorageKey.SHARED_FEED_FILTER_SETTINGS,
      JSON.stringify(this.sharedFeedFilterSettingsMap)
    )
  }

  getMuteListCache(pubkey: string | null | undefined) {
    const key = pubkey || '_global'
    const cached = this.muteListCacheMap[key]
    return {
      public: Array.isArray(cached?.public) ? cached.public.filter(Boolean) : [],
      private: Array.isArray(cached?.private) ? cached.private.filter(Boolean) : []
    }
  }

  setMuteListCache(pubkey: string | null | undefined, muteList: TMutedList) {
    const key = pubkey || '_global'
    this.muteListCacheMap[key] = {
      public: Array.isArray(muteList.public)
        ? Array.from(new Set(muteList.public.filter(Boolean)))
        : [],
      private: Array.isArray(muteList.private)
        ? Array.from(new Set(muteList.private.filter(Boolean)))
        : []
    }
    window.localStorage.setItem(StorageKey.MUTE_LIST_CACHE, JSON.stringify(this.muteListCacheMap))
  }

  hasShownCreateWalletGuideToast(pubkey: string) {
    return this.shownCreateWalletGuideToastPubkeys.has(pubkey)
  }

  markCreateWalletGuideToastAsShown(pubkey: string) {
    if (this.shownCreateWalletGuideToastPubkeys.has(pubkey)) {
      return
    }
    this.shownCreateWalletGuideToastPubkeys.add(pubkey)
    window.localStorage.setItem(
      StorageKey.SHOWN_CREATE_WALLET_GUIDE_TOAST_PUBKEYS,
      JSON.stringify(Array.from(this.shownCreateWalletGuideToastPubkeys))
    )
  }

  getSidebarCollapse() {
    return this.sidebarCollapse
  }

  setSidebarCollapse(collapse: boolean) {
    this.sidebarCollapse = collapse
    window.localStorage.setItem(StorageKey.SIDEBAR_COLLAPSE, collapse.toString())
  }

  getPrimaryColor() {
    return this.primaryColor
  }

  setPrimaryColor(color: TPrimaryColor) {
    this.primaryColor = color
    window.localStorage.setItem(StorageKey.PRIMARY_COLOR, color)
  }

  getEnableSingleColumnLayout() {
    return this.enableSingleColumnLayout
  }

  setEnableSingleColumnLayout(enable: boolean) {
    this.enableSingleColumnLayout = enable
    window.localStorage.setItem(StorageKey.ENABLE_SINGLE_COLUMN_LAYOUT, enable.toString())
  }

  getDesktopPrimaryColumnWidth() {
    return this.desktopPrimaryColumnWidth
  }

  setDesktopPrimaryColumnWidth(width: number) {
    const clampedWidth = Math.max(20, Math.min(80, width))
    this.desktopPrimaryColumnWidth = clampedWidth
    window.localStorage.setItem(StorageKey.DESKTOP_PRIMARY_COLUMN_WIDTH, clampedWidth.toString())
  }

  getLinkPreviewMode() {
    return this.linkPreviewMode
  }

  setLinkPreviewMode(mode: TLinkPreviewMode) {
    this.linkPreviewMode = mode
    window.localStorage.setItem(StorageKey.SHOW_LINK_PREVIEWS, mode)
  }

  getFavoriteLists(pubkey?: string | null) {
    const key = pubkey || '_global'
    return this.favoriteListsMap[key] || []
  }

  addFavoriteList(listKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteListsMap[key] || []
    if (!currentFavorites.includes(listKey)) {
      this.favoriteListsMap[key] = [...currentFavorites, listKey]
      window.localStorage.setItem(StorageKey.FAVORITE_LISTS, JSON.stringify(this.favoriteListsMap))
    }
  }

  removeFavoriteList(listKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteListsMap[key] || []
    this.favoriteListsMap[key] = currentFavorites.filter((k) => k !== listKey)
    window.localStorage.setItem(StorageKey.FAVORITE_LISTS, JSON.stringify(this.favoriteListsMap))
  }

  isFavoriteList(listKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteListsMap[key] || []
    return currentFavorites.includes(listKey)
  }

  getFavoriteGroups(pubkey?: string | null) {
    const key = pubkey || '_global'
    return this.favoriteGroupsMap[key] || []
  }

  addFavoriteGroup(groupKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteGroupsMap[key] || []
    if (!currentFavorites.includes(groupKey)) {
      this.favoriteGroupsMap[key] = [...currentFavorites, groupKey]
      window.localStorage.setItem(
        StorageKey.FAVORITE_GROUPS,
        JSON.stringify(this.favoriteGroupsMap)
      )
    }
  }

  removeFavoriteGroup(groupKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteGroupsMap[key] || []
    this.favoriteGroupsMap[key] = currentFavorites.filter((k) => k !== groupKey)
    window.localStorage.setItem(StorageKey.FAVORITE_GROUPS, JSON.stringify(this.favoriteGroupsMap))
  }

  isFavoriteGroup(groupKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const currentFavorites = this.favoriteGroupsMap[key] || []
    return currentFavorites.includes(groupKey)
  }

  getGroupDiscoveryRelays() {
    return this.groupDiscoveryRelays
  }

  setGroupDiscoveryRelays(relays: string[]) {
    this.groupDiscoveryRelays = relays
    window.localStorage.setItem(StorageKey.GROUP_DISCOVERY_RELAYS, JSON.stringify(relays))
  }

  getArchivedGroupFiles(pubkey?: string | null) {
    const key = pubkey || '_global'
    return this.archivedGroupFilesMap[key] || []
  }

  setArchivedGroupFiles(entries: ArchivedGroupFilesEntry[], pubkey?: string | null) {
    const key = pubkey || '_global'
    this.archivedGroupFilesMap[key] = entries
    window.localStorage.setItem(
      StorageKey.GROUP_FILES_ARCHIVED_GROUPS,
      JSON.stringify(this.archivedGroupFilesMap)
    )
  }

  upsertArchivedGroupFilesEntry(entry: ArchivedGroupFilesEntry, pubkey?: string | null) {
    const key = pubkey || '_global'
    const current = this.archivedGroupFilesMap[key] || []
    const next = current.filter(
      (item) => !(item.groupId === entry.groupId && (item.relay || '') === (entry.relay || ''))
    )
    next.push(entry)
    this.archivedGroupFilesMap[key] = next
    window.localStorage.setItem(
      StorageKey.GROUP_FILES_ARCHIVED_GROUPS,
      JSON.stringify(this.archivedGroupFilesMap)
    )
  }

  removeArchivedGroupFilesEntry(groupId: string, relay?: string | null, pubkey?: string | null) {
    const key = pubkey || '_global'
    const current = this.archivedGroupFilesMap[key] || []
    this.archivedGroupFilesMap[key] = current.filter((entry) => {
      if (entry.groupId !== groupId) return true
      if (!relay) return false
      return (entry.relay || '') !== relay
    })
    window.localStorage.setItem(
      StorageKey.GROUP_FILES_ARCHIVED_GROUPS,
      JSON.stringify(this.archivedGroupFilesMap)
    )
  }

  getGroupLeavePublishRetryQueue(pubkey?: string | null) {
    const key = pubkey || '_global'
    return this.groupLeavePublishRetryQueueMap[key] || []
  }

  setGroupLeavePublishRetryQueue(entries: GroupLeavePublishRetryEntry[], pubkey?: string | null) {
    const key = pubkey || '_global'
    this.groupLeavePublishRetryQueueMap[key] = entries
    window.localStorage.setItem(
      StorageKey.GROUP_LEAVE_PUBLISH_RETRY_QUEUE,
      JSON.stringify(this.groupLeavePublishRetryQueueMap)
    )
  }

  upsertGroupLeavePublishRetryEntry(entry: GroupLeavePublishRetryEntry, pubkey?: string | null) {
    const key = pubkey || '_global'
    const current = this.groupLeavePublishRetryQueueMap[key] || []
    const index = current.findIndex(
      (item) => item.groupId === entry.groupId && (item.relay || '') === (entry.relay || '')
    )
    if (index >= 0) {
      const existing = current[index]
      const nextEntry: GroupLeavePublishRetryEntry = {
        ...existing,
        ...entry,
        needs9022: existing.needs9022 || entry.needs9022,
        needs10009: existing.needs10009 || entry.needs10009
      }
      this.groupLeavePublishRetryQueueMap[key] = [
        ...current.slice(0, index),
        nextEntry,
        ...current.slice(index + 1)
      ]
    } else {
      this.groupLeavePublishRetryQueueMap[key] = [...current, entry]
    }
    window.localStorage.setItem(
      StorageKey.GROUP_LEAVE_PUBLISH_RETRY_QUEUE,
      JSON.stringify(this.groupLeavePublishRetryQueueMap)
    )
  }

  removeGroupLeavePublishRetryEntry(
    groupId: string,
    relay?: string | null,
    pubkey?: string | null
  ) {
    const key = pubkey || '_global'
    const current = this.groupLeavePublishRetryQueueMap[key] || []
    this.groupLeavePublishRetryQueueMap[key] = current.filter((entry) => {
      if (entry.groupId !== groupId) return true
      if (!relay) return false
      return (entry.relay || '') !== relay
    })
    window.localStorage.setItem(
      StorageKey.GROUP_LEAVE_PUBLISH_RETRY_QUEUE,
      JSON.stringify(this.groupLeavePublishRetryQueueMap)
    )
  }

  getDismissedGroupAdminLeaveEvents(pubkey?: string | null) {
    const key = pubkey || '_global'
    return this.dismissedGroupAdminLeaveEventsMap[key] || []
  }

  markDismissedGroupAdminLeaveEvent(eventKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const current = this.dismissedGroupAdminLeaveEventsMap[key] || []
    if (!current.includes(eventKey)) {
      this.dismissedGroupAdminLeaveEventsMap[key] = [...current, eventKey]
      window.localStorage.setItem(
        StorageKey.GROUP_ADMIN_LEAVE_DISMISSED_EVENTS,
        JSON.stringify(this.dismissedGroupAdminLeaveEventsMap)
      )
    }
  }

  isGroupAdminLeaveEventDismissed(eventKey: string, pubkey?: string | null) {
    const key = pubkey || '_global'
    const current = this.dismissedGroupAdminLeaveEventsMap[key] || []
    return current.includes(eventKey)
  }
}

const instance = new LocalStorageService()
export default instance
