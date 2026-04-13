import { describe, expect, it, vi } from 'vitest'
import { RelayService } from '../src/domain/relayService.js'

describe('RelayService.startJoinFlow', () => {
  it('waits for join-auth-success before resolving', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const workerHost = {
      send: vi.fn().mockResolvedValue({ success: true }),
      onMessage: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    }

    const service = new RelayService(workerHost as never)
    const joinPromise = service.startJoinFlow({
      publicIdentifier: 'npub1test:group'
    })

    await vi.waitFor(() => {
      expect(workerHost.send).toHaveBeenCalled()
      expect(listeners.size).toBe(1)
    })

    for (const listener of listeners) {
      listener({
        type: 'join-auth-success',
        data: {
          publicIdentifier: 'npub1test:group'
        }
      })
    }

    await expect(joinPromise).resolves.toBeUndefined()
  })

  it('rejects when the worker emits join-auth-error', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const workerHost = {
      send: vi.fn().mockResolvedValue({ success: true }),
      onMessage: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    }

    const service = new RelayService(workerHost as never)
    const joinPromise = service.startJoinFlow({
      publicIdentifier: 'npub1test:group'
    })

    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })

    for (const listener of listeners) {
      listener({
        type: 'join-auth-error',
        data: {
          publicIdentifier: 'npub1test:group',
          error: 'join failed'
        }
      })
    }

    await expect(joinPromise).rejects.toThrow('join failed')
  })
})
