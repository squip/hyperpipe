import { describe, expect, it, vi } from 'vitest'
import { copyWithRuntime, type ClipboardRuntime } from '../src/runtime/clipboard.js'

function makeRuntime(overrides: Partial<ClipboardRuntime> = {}): ClipboardRuntime {
  return {
    isTTY: false,
    writeStdout: () => {},
    commandExists: async () => false,
    runWithInput: async () => {},
    ...overrides
  }
}

describe('clipboard adapter', () => {
  it('uses OSC52 first when stdout is a TTY', async () => {
    const writeStdout = vi.fn()
    const runtime = makeRuntime({
      isTTY: true,
      writeStdout
    })

    const result = await copyWithRuntime('group-id-123', runtime)

    expect(result.ok).toBe(true)
    expect(result.method).toBe('osc52')
    expect(writeStdout).toHaveBeenCalledOnce()
  })

  it('falls back to pbcopy when OSC52 is unavailable', async () => {
    const runWithInput = vi.fn(async () => {})
    const runtime = makeRuntime({
      isTTY: false,
      commandExists: async (command) => command === 'pbcopy',
      runWithInput
    })

    const result = await copyWithRuntime('npub1example', runtime)

    expect(result.ok).toBe(true)
    expect(result.method).toBe('pbcopy')
    expect(runWithInput).toHaveBeenCalledWith('pbcopy', [], 'npub1example')
  })

  it('returns none when no backend is available', async () => {
    const runtime = makeRuntime({
      isTTY: false,
      commandExists: async () => false
    })

    const result = await copyWithRuntime('value', runtime)

    expect(result.ok).toBe(false)
    expect(result.method).toBe('none')
    expect(result.error).toBeTruthy()
  })
})
