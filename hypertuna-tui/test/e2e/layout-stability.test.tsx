import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'
import { SECTION_ORDER } from '../../src/lib/constants.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-e2e',
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
  const headerIndex = lines.findIndex((line) => line.includes('Hypertuna TUI'))
  const scan = headerIndex > 0 ? lines.slice(0, headerIndex) : lines.slice(0, 8)
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
  expect(frame).toContain('Hypertuna TUI')
  expect(frame).toContain('Command')
  expect(frame).toContain('Keys:')
  expect(hasBorderAccumulation(frame)).toBe(false)
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI e2e layout stability', () => {
  it('keeps three-pane shell stable during rapid navigation', async () => {
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={(options) => MockController.withSeedData(options)}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Hypertuna TUI'))
      await waitFor(() => lastFrame(instance).includes('Runtime Summary'))

      expectStableLayout(instance)

      for (let i = 0; i < 30; i += 1) {
        instance.stdin.write('\t')
        await sleep(10)
        expectStableLayout(instance)
      }

      for (let i = 0; i < SECTION_ORDER.length + 2; i += 1) {
        if (lastFrame(instance).includes('Logs')) break
        instance.stdin.write('\t')
        await sleep(10)
      }
      expect(lastFrame(instance)).toContain('Logs')
      expect(instance.stderr.frames.length).toBe(0)
    } finally {
      instance.unmount()
    }
  })

  it('updates live panes through controller actions without layout corruption', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Hypertuna TUI'))

      instance.stdin.write(':')
      await sleep(30)
      instance.stdin.write('\u001B')
      await sleep(30)
      expectStableLayout(instance)

      await controller.refreshRelays()
      await controller.refreshFeed(5)
      await controller.publishPost('layout_test_post')
      await controller.refreshGroups()
      await controller.refreshGroupFiles('npubseed:group-a')
      await controller.refreshStarterPacks()
      await controller.refreshChats()
      await controller.search('notes', 'feed')

      for (let i = 0; i < SECTION_ORDER.length + 2; i += 1) {
        if (lastFrame(instance).includes('Search Results (notes)')) break
        instance.stdin.write('\t')
        await sleep(20)
      }

      await waitFor(() => lastFrame(instance).includes('Search Results (notes)'))
      const frameAfterSearch = lastFrame(instance)
      expect(frameAfterSearch).toContain('query: feed')

      instance.stdin.write('\t')
      await sleep(20)
      expect(lastFrame(instance)).toContain('Accounts')

      instance.stdin.write('\t')
      await sleep(20)
      expect(lastFrame(instance)).toContain('Logs')

      for (let i = 0; i < 16; i += 1) {
        await Promise.all([
          controller.refreshFeed(10),
          controller.refreshGroups(),
          controller.refreshGroupFiles('npubseed:group-a')
        ])
        instance.stdin.write('\t')
        await sleep(12)
        expectStableLayout(instance)
      }

      expectStableLayout(instance)
      expect(instance.stderr.frames.length).toBe(0)
    } finally {
      instance.unmount()
    }
  })
})
