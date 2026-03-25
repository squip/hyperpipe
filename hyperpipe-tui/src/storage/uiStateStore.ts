import { readJsonFile, writeJsonFile } from './jsonStore.js'
import { defaultUiState, type AccountScopedUiState, type UiState, uiStateSchema } from './schema.js'
import { DEFAULT_DISCOVERY_RELAYS } from '../lib/constants.js'
import { uniqueRelayUrls } from '../lib/nostr.js'

const defaultAccountScopedUiState = (): AccountScopedUiState => ({
  groupViewTab: 'discover',
  chatViewTab: 'conversations',
  selectedNode: 'dashboard',
  focusPane: 'left-tree',
  treeExpanded: {
    groups: true,
    chats: true,
    invites: true,
    files: true
  },
  nodeViewport: {},
  rightTopSelectionByNode: {},
  rightBottomOffsetByNode: {},
  profileNameCacheByPubkey: {},
  discoveryRelays: uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS),
  feedSource: {
    mode: 'relays',
    relayUrl: null,
    groupId: null,
    label: 'All Relays'
  },
  feedControls: {
    query: '',
    sortKey: 'createdAt',
    sortDirection: 'desc',
    kindFilter: null
  },
  groupControls: {
    query: '',
    sortKey: 'members',
    sortDirection: 'desc',
    visibility: 'all',
    joinMode: 'all'
  },
  fileControls: {
    query: '',
    sortKey: 'uploadedAt',
    sortDirection: 'desc',
    mime: 'all',
    group: 'all'
  },
  detailPaneOffsetBySection: {},
  paneViewport: {},
  dismissedGroupInviteIds: [],
  acceptedGroupInviteIds: [],
  acceptedGroupInviteGroupIds: [],
  dismissedChatInviteIds: [],
  acceptedChatInviteIds: [],
  acceptedChatInviteConversationIds: [],
  hiddenDeletedFileKeys: [],
  perfOverlayEnabled: false
})

export class UiStateStore {
  private filePath: string
  private state: UiState = defaultUiState()
  private ready: Promise<void>

  constructor(filePath: string) {
    this.filePath = filePath
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    const loaded = await readJsonFile(this.filePath, uiStateSchema, defaultUiState)
    const defaults = defaultUiState()
    this.state = {
      ...defaults,
      ...loaded,
      keymap: {
        ...defaults.keymap,
        ...(loaded.keymap || {})
      },
      accountScoped: {
        ...defaults.accountScoped,
        ...(loaded.accountScoped || {})
      }
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
  }

  getState(): UiState {
    return {
      ...this.state,
      keymap: { ...this.state.keymap },
      accountScoped: { ...this.state.accountScoped }
    }
  }

  async patchState(patch: Partial<UiState>): Promise<UiState> {
    await this.waitUntilReady()
    this.state = {
      ...this.state,
      ...patch,
      keymap: {
        ...this.state.keymap,
        ...(patch.keymap || {})
      },
      accountScoped: {
        ...this.state.accountScoped,
        ...(patch.accountScoped || {})
      }
    }
    await writeJsonFile(this.filePath, this.state)
    return this.getState()
  }

  getAccountState(userKey: string): AccountScopedUiState {
    const key = String(userKey || '').trim().toLowerCase()
    if (!key) return defaultAccountScopedUiState()
    const raw = this.state.accountScoped[key] || {}
    const normalizedGroupViewTab =
      (raw as { groupViewTab?: string }).groupViewTab === 'my'
        ? 'my'
        : 'discover'
    const rawNodeViewport = ((raw as { nodeViewport?: Record<string, { cursor?: number; offset?: number }> }).nodeViewport || {})
    const normalizedNodeViewport = Object.fromEntries(
      Object.entries(rawNodeViewport).map(([key, value]) => ([
        key,
        {
          cursor: Math.max(0, Math.trunc(Number(value?.cursor || 0))),
          offset: Math.max(0, Math.trunc(Number(value?.offset || 0)))
        }
      ]))
    )

    return {
      ...defaultAccountScopedUiState(),
      ...raw,
      groupViewTab: normalizedGroupViewTab,
      treeExpanded: {
        ...defaultAccountScopedUiState().treeExpanded,
        ...((raw as { treeExpanded?: Record<string, boolean> }).treeExpanded || {})
      },
      nodeViewport: {
        ...defaultAccountScopedUiState().nodeViewport,
        ...normalizedNodeViewport
      },
      rightTopSelectionByNode: {
        ...defaultAccountScopedUiState().rightTopSelectionByNode,
        ...((raw as { rightTopSelectionByNode?: Record<string, number> }).rightTopSelectionByNode || {})
      },
      rightBottomOffsetByNode: {
        ...defaultAccountScopedUiState().rightBottomOffsetByNode,
        ...((raw as { rightBottomOffsetByNode?: Record<string, number> }).rightBottomOffsetByNode || {})
      },
      profileNameCacheByPubkey: {
        ...defaultAccountScopedUiState().profileNameCacheByPubkey,
        ...((raw as {
          profileNameCacheByPubkey?: Record<string, { name?: string; bio?: string | null; updatedAt?: number }>
        }).profileNameCacheByPubkey || {})
      },
      discoveryRelays: uniqueRelayUrls(
        ((raw as { discoveryRelays?: string[] }).discoveryRelays || defaultAccountScopedUiState().discoveryRelays)
      )
    }
  }

  async patchAccountState(
    userKey: string,
    patch: Partial<AccountScopedUiState>
  ): Promise<AccountScopedUiState> {
    await this.waitUntilReady()
    const key = String(userKey || '').trim().toLowerCase()
    if (!key) return defaultAccountScopedUiState()

    const previous = this.getAccountState(key)
    const next: AccountScopedUiState = {
      ...previous,
      ...patch,
      paneViewport: {
        ...previous.paneViewport,
        ...(patch.paneViewport || {})
      },
      nodeViewport: {
        ...previous.nodeViewport,
        ...(patch.nodeViewport || {})
      },
      rightTopSelectionByNode: {
        ...previous.rightTopSelectionByNode,
        ...(patch.rightTopSelectionByNode || {})
      },
      rightBottomOffsetByNode: {
        ...previous.rightBottomOffsetByNode,
        ...(patch.rightBottomOffsetByNode || {})
      },
      profileNameCacheByPubkey: {
        ...previous.profileNameCacheByPubkey,
        ...(patch.profileNameCacheByPubkey || {})
      },
      treeExpanded: {
        ...previous.treeExpanded,
        ...(patch.treeExpanded || {})
      }
    }

    this.state = {
      ...this.state,
      accountScoped: {
        ...this.state.accountScoped,
        [key]: next
      }
    }
    await writeJsonFile(this.filePath, this.state)
    return next
  }
}
