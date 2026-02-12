import { readJsonFile, writeJsonFile } from './jsonStore.js'
import { defaultUiState, type AccountScopedUiState, type UiState, uiStateSchema } from './schema.js'

const defaultAccountScopedUiState = (): AccountScopedUiState => ({
  groupViewTab: 'discover',
  chatViewTab: 'conversations',
  paneViewport: {},
  dismissedGroupInviteIds: [],
  acceptedGroupInviteIds: [],
  acceptedGroupInviteGroupIds: [],
  dismissedChatInviteIds: [],
  acceptedChatInviteIds: [],
  acceptedChatInviteConversationIds: [],
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
    return {
      ...defaultAccountScopedUiState(),
      ...(this.state.accountScoped[key] || {})
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
