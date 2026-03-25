import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-e2e-relay-ui',
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

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI relay UI consolidation', () => {
  it('renders relay-focused tree labels and no standalone relays root item', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:create')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      const output = frame(instance)
      expect(output).toContain('Browse Relays')

      expect(output).not.toContain('Browse Groups')
      expect(output).not.toContain('My Groups')
      expect(output).not.toContain('Create Group')
      expect(output).not.toContain('Group Invites')
      expect(output).not.toContain('• Relays')
      expect(output).not.toContain('• Logs')
    } finally {
      instance.unmount()
    }
  })

  it('shows readiness token and relay metadata in My Relays details', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:my')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      await sleep(80)
      await waitFor(() => /Name|Vis|Status/.test(frame(instance)))

      // Move focus to right-bottom and page down to surface lower metadata rows.
      instance.stdin.write('\t')
      await sleep(30)
      instance.stdin.write('\t')
      await sleep(30)
      await waitFor(() => /Relay profile for:/.test(frame(instance)))
      let output = frame(instance)
      expect(output).toMatch(/[┌┬┐│├┼┤└┴┘]/)
      for (let index = 0; index < 8; index += 1) {
        if (/readyForReq|writable|requiresAuth/.test(output)) break
        instance.stdin.write('\u0004')
        await sleep(40)
        output = frame(instance)
      }
      expect(output).toMatch(/writable|readyForReq|requiresAuth/)
    } finally {
      instance.unmount()
    }
  })

  it('renders the shared peers column in relay browse tables', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:browse')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      await sleep(80)
      const output = frame(instance)
      expect(output).toContain('Peers')
      expect(output).toContain('Seed Group A')
    } finally {
      instance.unmount()
    }
  })

  it('expands parent rows into child actions and executes child leaves', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:browse')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => frame(instance).includes('Command'))
      const before = frame(instance)

      instance.stdin.write('\t')
      await sleep(30)
      instance.stdin.write('\r')

      await sleep(80)
      const after = frame(instance)
      expect(after).not.toEqual(before)
      expect(after).toMatch(/Relay Details|Admin details|Members/)
      expect(after).toMatch(/[┌│└].*Relay Details/)
    } finally {
      instance.unmount()
    }
  })

})
