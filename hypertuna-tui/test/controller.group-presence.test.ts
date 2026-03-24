import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { TuiController, type RuntimeOptions } from '../src/domain/controller.js'
import type { GroupSummary } from '../src/domain/types.js'

function baseOptions(root: string): RuntimeOptions {
  return {
    cwd: root,
    storageDir: root,
    noAnimations: true,
    logLevel: 'error'
  }
}

function makeGroup(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id: 'npub1presence:test-group',
    relay: 'wss://relay.example/',
    name: 'Presence Test Group',
    about: '',
    isPublic: true,
    isOpen: true,
    gatewayOrigin: 'https://hypertuna.com',
    gatewayId: 'gateway-main',
    directJoinOnly: false,
    members: [],
    membersCount: 0,
    ...overrides
  }
}

describe('TuiController group presence', () => {
  it('hydrates visible group presence from the worker probe command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypertuna-tui-group-presence-'))
    const controller = new TuiController(baseOptions(root))
    await controller.initialize()

    const request = vi.fn().mockResolvedValue({
      count: 2,
      status: 'ready',
      source: 'gateway',
      gatewayIncluded: true,
      gatewayHealthy: true,
      lastUpdatedAt: Date.now(),
      verifiedAt: Date.now(),
      unknown: false
    })

    ;(controller as any).workerHost = {
      isRunning: () => true,
      request,
      send: vi.fn(),
      onMessage: () => () => {},
      onStdout: () => () => {},
      onStderr: () => () => {},
      onExit: () => () => {}
    }
    ;(controller as any).state.lifecycle = 'ready'
    ;(controller as any).state.selectedNode = 'groups:browse'
    ;(controller as any).state.rightTopSelectionByNode = { 'groups:browse': 0 }
    ;(controller as any).rawGroupDiscover = [makeGroup()]

    ;(controller as any).syncGroupView()
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'probe-group-presence',
        data: expect.objectContaining({
          publicIdentifier: 'npub1presence:test-group',
          gatewayOrigin: 'https://hypertuna.com'
        })
      }),
      12_000
    )

    const group = controller.getState().groups[0]
    expect(group?.peerPresence?.status).toBe('ready')
    expect(group?.peerPresence?.source).toBe('gateway')
    expect(group?.peersOnline).toBe(2)

    await controller.shutdown()
  })

  it('preserves a previous gateway-backed count over a reduced fallback probe result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypertuna-tui-group-presence-preserve-'))
    const controller = new TuiController(baseOptions(root))
    await controller.initialize()

    const request = vi.fn()
      .mockResolvedValueOnce({
        count: 2,
        status: 'ready',
        source: 'gateway',
        gatewayIncluded: true,
        gatewayHealthy: true,
        lastUpdatedAt: Date.now(),
        verifiedAt: Date.now(),
        unknown: false
      })
      .mockResolvedValueOnce({
        count: 1,
        status: 'ready',
        source: 'direct-probe',
        gatewayIncluded: false,
        gatewayHealthy: false,
        lastUpdatedAt: Date.now(),
        verifiedAt: Date.now(),
        unknown: false,
        error: 'gateway-presence-timeout'
      })

    ;(controller as any).workerHost = {
      isRunning: () => true,
      request,
      send: vi.fn(),
      onMessage: () => () => {},
      onStdout: () => () => {},
      onStderr: () => () => {},
      onExit: () => () => {}
    }
    ;(controller as any).state.lifecycle = 'ready'

    const group = makeGroup()
    await (controller as any).refreshGroupPresence(group, { force: true, ttlMs: 1 })
    await (controller as any).refreshGroupPresence(group, { force: true, ttlMs: 1 })

    const resolved = (controller as any).groupPresenceForGroup(group.id, group.relay)
    expect(resolved.count).toBe(2)
    expect(resolved.gatewayIncluded).toBe(true)
    expect(resolved.gatewayHealthy).toBe(true)

    await controller.shutdown()
  })
})
