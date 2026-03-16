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

  it('sends a relay invite from Invites -> Send Invite right-bottom input', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    await controller.setSelectedNode('invites:send')
    await controller.setFocusPane('right-bottom')
    const instance = render(
      <App
        options={BASE_OPTIONS}
        controllerFactory={() => controller}
      />
    )

    try {
      await waitFor(() => lastFrame(instance).includes('Command'))
      await waitFor(() => lastFrame(instance).includes('invites:send'))

      const invitee = 'b'.repeat(64)
      const initialInviteCount = controller.getState().invites.length
      await typeText(instance, invitee, 2)
      instance.stdin.write('\r')

      await waitFor(() => controller.getState().invites.length > initialInviteCount)
      const latestInvite = controller.getState().invites[0]
      expect(latestInvite).toBeTruthy()
      expect(latestInvite?.groupId).toBe(controller.getState().myGroups[0]?.id)
    } finally {
      instance.unmount()
    }
  })
})
