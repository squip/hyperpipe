import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hyperpipe-tui-e2e-dashboard-actions',
  noAnimations: true,
  logLevel: 'info'
}

type RenderInstance = ReturnType<typeof render>

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

function frame(instance: RenderInstance): string {
  return stripAnsi(instance.lastFrame() || '')
}

async function pressKey(instance: RenderInstance, key: string, repeat = 1, delayMs = 12): Promise<void> {
  for (let i = 0; i < repeat; i += 1) {
    instance.stdin.write(key)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

async function typeText(instance: RenderInstance, value: string, delayMs = 3): Promise<void> {
  for (const char of value) {
    instance.stdin.write(char)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

async function moveSelectionTo(instance: RenderInstance, selectedLabel: string, maxMoves = 28): Promise<void> {
  for (let i = 0; i < maxMoves; i += 1) {
    if (frame(instance).includes(`> ${selectedLabel}`)) return
    await pressKey(instance, '\u001b[B')
  }
  throw new Error(`Unable to move selection to: ${selectedLabel}`)
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI e2e dashboard right-top actions', () => {
  it('shows dashboard action rows and removes legacy non-interactive summary row', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      const output = frame(instance)
      expect(output).toContain('User Profile:')
      expect(output).toContain('Discovery Relays:')
      expect(output).toContain('Terminal Commands')
      expect(output).not.toContain('p2pRelays:')
    } finally {
      instance.unmount()
    }
  })

  it('edits and submits dashboard user profile kind 0 fields', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('User Profile:'))
      await pressKey(instance, '\t')
      await pressKey(instance, '\r')
      await waitFor(() => frame(instance).includes('Edit Profile'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => frame(instance).includes('Edit User Profile'))

      await pressKey(instance, '\r')
      await typeText(instance, 'dashboard-edit-user')
      await pressKey(instance, '\r')
      await pressKey(instance, '\u001b[B', 2)
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('User Profile: dashboard-edit-user'))
      const snapshot = controller.getState()
      const sessionPubkey = String(snapshot.session?.pubkey || '')
      expect(snapshot.adminProfileByPubkey[sessionPubkey]?.name).toBe('dashboard-edit-user')
    } finally {
      instance.unmount()
    }
  })

  it('edits and submits dashboard discovery relays', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Discovery Relays:'))
      await pressKey(instance, '\t')
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => frame(instance).includes('Edit Discovery Relays'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => frame(instance).includes('Select discovery relays and submit.'))
      await moveSelectionTo(instance, 'Add relay URL manually')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Relay URL:'))
      await typeText(instance, 'wss://example.dashboard/relay')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('wss://example.dashboard/relay'))
      await moveSelectionTo(instance, 'Submit')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Terminal Commands'))
      const output = frame(instance)
      expect(output).toContain('Discovery Relays:')
      expect(controller.getState().discoveryRelayUrls).toContain('wss://example.dashboard/relay')
    } finally {
      instance.unmount()
    }
  })

  it('opens terminal command reference in read-only mode', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Terminal Commands'))
      await pressKey(instance, '\t')
      await pressKey(instance, '\u001b[B', 2)
      await pressKey(instance, '\r')
      await waitFor(() => frame(instance).includes('Open Command Reference'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Supported CLI commands'))
      await waitFor(() => frame(instance).includes('goto <dashboard|relays|relay:browse|relay:my|relay:create'))

      await typeText(instance, 'shouldnotappear')
      await sleep(80)
      const output = frame(instance)
      expect(output).toContain('Supported CLI commands')
      expect(output).not.toContain('shouldnotappear')
    } finally {
      instance.unmount()
    }
  })
})
