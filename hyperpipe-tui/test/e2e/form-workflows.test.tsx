import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-e2e-form',
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

async function typeText(instance: RenderInstance, value: string, delayMs = 4): Promise<void> {
  for (const char of value) {
    instance.stdin.write(char)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

async function pressKey(instance: RenderInstance, key: string, repeat = 1, delayMs = 12): Promise<void> {
  for (let index = 0; index < repeat; index += 1) {
    instance.stdin.write(key)
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for expected frame update')
}

function lastFrame(instance: RenderInstance): string {
  return stripAnsi(instance.lastFrame() || '')
}

afterEach(() => {
  cleanup()
})

describe.sequential('TUI e2e in-pane form workflows', () => {
  it('renders Create Relay browse view and enters field edit mode on Enter', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:create')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await waitFor(() => lastFrame(instance).includes('Create Relay'))
      await waitFor(() => lastFrame(instance).includes('Relay Name'))

      instance.stdin.write('\r')
      await typeText(instance, 'relay-browse-edit')
      instance.stdin.write('\r')
      await waitFor(() => lastFrame(instance).includes('Relay Name: relay-browse-edit'))
    } finally {
      instance.unmount()
    }
  })

  it('renders Create Chat browse view and enters field edit mode on Enter', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('chats:create')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await waitFor(() => lastFrame(instance).includes('Create Chat'))
      await waitFor(() => lastFrame(instance).includes('Chat Name'))

      instance.stdin.write('\r')
      await waitFor(() => lastFrame(instance).includes('Editing Chat Name'))
      await typeText(instance, 'chat-browse-edit')
      instance.stdin.write('\r')
      await waitFor(() => lastFrame(instance).includes('Chat Name: chat-browse-edit'))
    } finally {
      instance.unmount()
    }
  })

  it('shows relay gateway branch and dedicated picker/manual editors in Create Relay', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:create')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Create Relay'))
      await waitFor(() => lastFrame(instance).includes('Direct Join Only'))

      await pressKey(instance, '\u001b[B', 4)
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Editing Direct Join Only'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')

      await waitFor(() => lastFrame(instance).includes('Gateway Server'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Gateway Picker'))
      await waitFor(() => lastFrame(instance).includes('Manual entry'))

      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Editing Gateway Server: Gateway Picker'))
      await waitFor(() => lastFrame(instance).includes('Hyperpipe Operator'))
      await pressKey(instance, '\u001b')

      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Editing Gateway Server: Manual entry'))
    } finally {
      instance.unmount()
    }
  })

  it('shows chat relay branch with URL-only picker and manual relay URL editor', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('chats:create')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Create Chat'))
      await waitFor(() => lastFrame(instance).includes('Chat Relays'))

      await pressKey(instance, '\u001b[B', 3)
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Relay Picker'))
      await waitFor(() => lastFrame(instance).includes('Manual entry'))

      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Editing Chat Relays: Relay Picker'))
      await waitFor(() => lastFrame(instance).includes('wss://'))
      expect(lastFrame(instance)).not.toContain('npubseed')
      await pressKey(instance, '\u001b')

      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Editing Relay URLs'))
    } finally {
      instance.unmount()
    }
  })

  it('shows Send Invite child action under My Relays rows', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:my')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      instance.stdin.write('\r')
      await waitFor(() => lastFrame(instance).includes('Relay Details'))
      await pressKey(instance, '\u001b[B', 6)
      await waitFor(() => lastFrame(instance).includes('Send Invite'))
    } finally {
      instance.unmount()
    }
  })

  it('shows Send Invite child action under Chats rows', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('chats')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      instance.stdin.write('\r')
      await waitFor(() => lastFrame(instance).includes('Send Invite'))
      await pressKey(instance, '\u001b[B', 1)
      await waitFor(() => lastFrame(instance).includes('Send Invite'))
    } finally {
      instance.unmount()
    }
  })

  it('opens My Relays notes composer and publishes a relay-scoped note', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('groups:my')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Notes'))
      await pressKey(instance, '\u001b[B', 3)
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Publish a new note to the'))
      await typeText(instance, 'hello relay note')
      await pressKey(instance, '\r')
      await waitFor(() => !lastFrame(instance).includes('Publish a new note to the'))
      await waitFor(() => lastFrame(instance).includes('hello relay note'))
    } finally {
      instance.unmount()
    }
  })

  it('opens chat notes composer and publishes to chat thread feed', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('chats')
    await controller.setFocusPane('right-top')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Notes'))
      await pressKey(instance, '\u001b[B')
      await pressKey(instance, '\r')
      await waitFor(() => lastFrame(instance).includes('Publish a new note to the'))
      await typeText(instance, 'hello chat note')
      await pressKey(instance, '\r')
      await waitFor(() => !lastFrame(instance).includes('Publish a new note to the'))
      await waitFor(() => lastFrame(instance).includes('hello chat note'))
    } finally {
      instance.unmount()
    }
  })
})
