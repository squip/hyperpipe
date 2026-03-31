import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hyperpipe-tui-e2e',
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

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

function lastFrame(instance: RenderInstance): string {
  return stripAnsi(instance.lastFrame() || '')
}

function hasBorderAccumulation(frame: string): boolean {
  const lines = frame.split('\n')
  const scan = lines.slice(0, 12)
  let borderStreak = 0
  for (const line of scan) {
    const normalized = line.trim()
    if (!normalized) continue
    if (/^[\u2500-\u257f\s]+$/.test(normalized)) {
      borderStreak += 1
      if (borderStreak > 3) return true
      continue
    }
    borderStreak = 0
  }
  return false
}

function expectStableLayout(instance: RenderInstance): void {
  const frame = lastFrame(instance)
  const lines = frame.split('\n')
  expect(lines.length).toBeGreaterThan(8)
  expect(frame).toContain('Command')
  expect(frame).toContain('Keys:')
  expect(frame).toContain('Ready · node:')
  expect(hasBorderAccumulation(frame)).toBe(false)
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI e2e layout stability', () => {
  it('keeps shell stable during rapid focus and tree/list navigation', async () => {
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={(options) => MockController.withSeedData(options)}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await waitFor(() => lastFrame(instance).includes('Keys:'))
      expectStableLayout(instance)

      for (let i = 0; i < 30; i += 1) {
        instance.stdin.write('\t')
        await sleep(10)
        expectStableLayout(instance)
      }

      instance.stdin.write('\u001b[B')
      await sleep(30)
      instance.stdin.write('\u001b[C')
      await sleep(30)
      instance.stdin.write('\u001b[C')
      await sleep(30)
      expectStableLayout(instance)
      expect(instance.stderr.frames.length).toBe(0)
    } finally {
      instance.unmount()
    }
  })

  it('updates tree/split panes through controller actions without corruption', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      expectStableLayout(instance)

      await controller.refreshRelays()
      await controller.refreshGroups()
      await controller.refreshInvites()
      await controller.refreshGroupFiles('npubseed:group-a')
      await controller.refreshGroupNotes('npubseed:group-a')
      await controller.refreshChats()

      for (let i = 0; i < 16; i += 1) {
        instance.stdin.write('\t')
        await sleep(12)
        expectStableLayout(instance)
      }

      expect(instance.stderr.frames.length).toBe(0)
    } finally {
      instance.unmount()
    }
  })
})
