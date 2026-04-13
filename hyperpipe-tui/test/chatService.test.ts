import { describe, expect, it, vi } from 'vitest'
import { ChatService } from '../src/domain/chatService.js'

describe('ChatService.acceptInvite', () => {
  it('waits for joinedConversation before resolving', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const workerHost = {
      request: vi.fn().mockResolvedValue({
        operationId: 'join-op-1',
        inviteId: 'invite-1'
      }),
      onMessage: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    }

    const service = new ChatService(workerHost as never)
    const acceptPromise = service.acceptInvite('invite-1')

    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })
    expect(workerHost.request).toHaveBeenCalled()

    for (const listener of listeners) {
      listener({
        type: 'marmot-accept-invite-operation',
        data: {
          operationId: 'join-op-1',
          inviteId: 'invite-1',
          phase: 'joinedConversation',
          conversationId: 'conv-1'
        }
      })
    }

    await expect(acceptPromise).resolves.toEqual({ conversationId: 'conv-1' })
  })

  it('rejects when the background invite accept operation fails', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const workerHost = {
      request: vi.fn().mockResolvedValue({
        operationId: 'join-op-2',
        inviteId: 'invite-2'
      }),
      onMessage: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    }

    const service = new ChatService(workerHost as never)
    const acceptPromise = service.acceptInvite('invite-2')

    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })

    for (const listener of listeners) {
      listener({
        type: 'marmot-accept-invite-operation',
        data: {
          operationId: 'join-op-2',
          inviteId: 'invite-2',
          phase: 'failed',
          error: 'join exploded'
        }
      })
    }

    await expect(acceptPromise).rejects.toThrow('join exploded')
  })
})
