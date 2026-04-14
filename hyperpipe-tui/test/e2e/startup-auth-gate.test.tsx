import React from 'react'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { nip19, utils } from 'nostr-tools'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS = {
  cwd: process.cwd(),
  noAnimations: true,
  logLevel: 'info'
} as const

type RenderInstance = ReturnType<typeof render>

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '')
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 12_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

async function waitForStartupAccountSetup(instance: RenderInstance): Promise<void> {
  await waitFor(() => {
    const output = frame(instance)
    return output.includes('Account Setup')
      && output.includes('Generate New Account')
      && output.includes('Sign In With Existing nsec')
  })
}

async function openImportNsecFlow(instance: RenderInstance): Promise<void> {
  await waitForStartupAccountSetup(instance)
  await sleep(100)
  await pressKey(instance, '\u001b[B', 1, 30)
  await pressKey(instance, '\r', 1, 30)
  await waitFor(() => frame(instance).includes('Sign In With Existing nsec'))
}

async function waitForStartupSignInMenu(instance: RenderInstance): Promise<void> {
  await waitFor(() => {
    const output = frame(instance)
    return output.includes('Sign In')
      && output.includes('Sign In With Saved Account')
      && output.includes('Generate New Account')
      && output.includes('Sign In With Existing nsec')
  })
}

async function openSavedAccountPicker(instance: RenderInstance): Promise<void> {
  await waitForStartupSignInMenu(instance)
  await sleep(100)
  await pressKey(instance, '\r', 1, 30)
  await waitFor(() => frame(instance).includes('Saved Accounts'))
  await sleep(100)
}

function frame(instance: RenderInstance): string {
  return stripAnsi(instance.lastFrame() || '')
}

function isAppReady(controller: MockController): boolean {
  const snapshot = controller.getState()
  return snapshot.session != null && snapshot.lifecycle === 'ready'
}

async function createRuntimeOptions(): Promise<RuntimeOptions> {
  return {
    ...BASE_OPTIONS,
    storageDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hyperpipe-tui-e2e-startup-gate-'))
  }
}

async function pressKey(instance: RenderInstance, key: string, repeat = 1, delayMs = 12): Promise<void> {
  for (let i = 0; i < repeat; i += 1) {
    instance.stdin.write(key)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

async function typeText(instance: RenderInstance, value: string, delayMs = 2): Promise<void> {
  for (const char of value) {
    instance.stdin.write(char)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI e2e startup authentication gate', () => {
  it('shows setup auth choice when no stored accounts exist', async () => {
    const options = await createRuntimeOptions()
    const controller = new MockController(options)
    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
      />
    )

    try {
      await waitForStartupAccountSetup(instance)
      const output = frame(instance)
      expect(output).toContain('Generate New Account')
      expect(output).toContain('Sign In With Existing nsec')
      expect(output).toContain('Startup')
    } finally {
      instance.unmount()
    }
  })

  it('completes no-account generated flow through keys, profile, discovery, and bootstrap', async () => {
    const options = await createRuntimeOptions()
    const controller = new MockController(options)
    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
      />
    )

    try {
      await waitForStartupAccountSetup(instance)
      await sleep(100)
      await pressKey(instance, '\r')
      await waitFor(() => {
        const output = frame(instance)
        return (
          output.includes('Generated Account Keys')
          || output.includes('Profile Setup (kind 0)')
        )
      })

      if (frame(instance).includes('Generated Account Keys')) {
        await pressKey(instance, '\r')
        await waitFor(() => frame(instance).includes('Profile Setup (kind 0)'))
      }

      await pressKey(instance, '\r')
      await typeText(instance, 'startup-generated-user')
      await pressKey(instance, '\r')
      await pressKey(instance, '\u001b[B', 2)
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Discovery Relays'))
      await pressKey(instance, '\u001b[B', 40)
      await pressKey(instance, '\r')

      await waitFor(() => isAppReady(controller))
      const snapshot = controller.getState()
      expect(snapshot.session).not.toBeNull()
      expect(snapshot.lifecycle).toBe('ready')
      expect(snapshot.currentAccountPubkey).toBeTruthy()
    } finally {
      instance.unmount()
    }
  }, 25_000)

  it('imports existing 64-char hex nsec and reaches app after discovery selection', async () => {
    const options = await createRuntimeOptions()
    const controller = new MockController(options)
    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
      />
    )

    try {
      await openImportNsecFlow(instance)

      await typeText(instance, '1'.repeat(64))
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Discovery Relays'))
      await pressKey(instance, '\u001b[B', 40)
      await pressKey(instance, '\r')

      await waitFor(() => isAppReady(controller))
      expect(controller.getState().session).not.toBeNull()
    } finally {
      instance.unmount()
    }
  }, 15_000)

  it('imports bech32 nsec, supports manual discovery relay add, and persists selected relay set', async () => {
    const options = await createRuntimeOptions()
    const controller = new MockController(options)
    const bech32Nsec = nip19.nsecEncode(utils.hexToBytes('2'.repeat(64)))

    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
      />
    )

    try {
      await openImportNsecFlow(instance)

      await typeText(instance, bech32Nsec)
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Discovery Relays'))
      await pressKey(instance, '\u001b[B', 40)
      await pressKey(instance, '\u001b[A')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('Relay URL:'))
      await typeText(instance, 'wss://example.org/relay')
      await pressKey(instance, '\r')

      await waitFor(() => frame(instance).includes('wss://example.org/relay'))
      await pressKey(instance, '\u001b[B', 40)
      await pressKey(instance, '\r')

      await waitFor(() => isAppReady(controller))
      expect(controller.getState().discoveryRelayUrls).toContain('wss://example.org/relay')
    } finally {
      instance.unmount()
    }
  })

  it('uses saved-account picker and prompts password for ncryptsec accounts', async () => {
    const pubkey = 'a'.repeat(64)
    const now = Date.now()
    const options = await createRuntimeOptions()
    const controller = new MockController(options, {
      accounts: [{
        pubkey,
        userKey: pubkey,
        signerType: 'ncryptsec',
        ncryptsec: 'ncryptsec-mock',
        label: 'vault',
        createdAt: now,
        updatedAt: now
      }],
      currentAccountPubkey: pubkey,
      session: null
    })

    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
      />
    )

    try {
      await openSavedAccountPicker(instance)

      await pressKey(instance, '\r', 1, 30)
      await waitFor(() => frame(instance).includes('Account Password'))
      await typeText(instance, 'password123')
      await pressKey(instance, '\r')

      await waitFor(() => isAppReady(controller))
      const snapshot = controller.getState()
      expect(snapshot.session).not.toBeNull()
      expect(snapshot.lifecycle).toBe('ready')
    } finally {
      instance.unmount()
    }
  }, 15_000)

  it('bypasses startup gate when scripted commands are provided', async () => {
    const options = await createRuntimeOptions()
    const controller = MockController.withSeedData(options)
    const instance = render(
      <App
        options={options}
        enableStartupGate
        controllerFactory={() => controller}
        scriptedCommands={[{ command: 'goto relay:my', delayMs: 30, pauseAfterMs: 30 }]}
      />
    )

    try {
      await waitFor(() => isAppReady(controller))
      await waitFor(() => frame(instance).includes('node:'))
      const output = frame(instance)
      expect(output).not.toContain('Account Setup')
      expect(output).not.toContain('Sign In With Saved Account')
    } finally {
      instance.unmount()
    }
  })
})
