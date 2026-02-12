import { readJsonFile, writeJsonFile } from './jsonStore.js'
import { defaultUiState, type UiState, uiStateSchema } from './schema.js'

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
      }
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
  }

  getState(): UiState {
    return { ...this.state, keymap: { ...this.state.keymap } }
  }

  async patchState(patch: Partial<UiState>): Promise<UiState> {
    await this.waitUntilReady()
    this.state = {
      ...this.state,
      ...patch,
      keymap: {
        ...this.state.keymap,
        ...(patch.keymap || {})
      }
    }
    await writeJsonFile(this.filePath, this.state)
    return this.getState()
  }
}
