import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hyperpipe-tui-e2e-copy-shortcuts',
  noAnimations: true,
  logLevel: 'info'
}

type RenderInstance = ReturnType<typeof render>

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '')
}

function frame(instance: RenderInstance): string {
  return stripAnsi(instance.lastFrame() || '')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI copy shortcuts', () => {
  it('supports y/Y context-first copy shortcuts from pane selection', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()
    const commandSnippet = `relay members ${groupId}`
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
        scriptedCommands={[{ command: 'goto relay:my', delayMs: 50, pauseAfterMs: 50 }]}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      await waitFor(() => frame(instance).includes('Keys:'))
      await waitFor(() => frame(instance).includes('$ goto relay:my ->'), 6_000)
      await sleep(250)

      instance.stdin.write('y')
      await waitFor(() => controller.getState().lastCopiedValue === groupId, 6_000)

      instance.stdin.write('Y')
      await waitFor(() => controller.getState().lastCopiedValue === commandSnippet, 6_000)

      expect(frame(instance)).toContain('Keys:')
      expect(controller.getState().lastCopiedMethod).not.toBeNull()
      expect(instance.stderr.frames.length).toBe(0)
    } finally {
      instance.unmount()
    }
  }, 15_000)
})
