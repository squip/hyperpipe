import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessengerProvider, useMessenger } from '@/providers/MessengerProvider'

const ME_PUBKEY = '1'.repeat(64)
const FRIEND_PUBKEY = '2'.repeat(64)

type WorkerMessageHandler = ((message: unknown) => void) | null

const {
  sendToWorkerAwaitMock,
  uploadMock,
  toastLoadingMock,
  toastWarningMock,
  toastErrorMock,
  toastDismissMock,
  state
} = vi.hoisted(() => ({
  sendToWorkerAwaitMock: vi.fn(),
  uploadMock: vi.fn(),
  toastLoadingMock: vi.fn(),
  toastWarningMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastDismissMock: vi.fn(),
  state: {
    workerMessageHandler: null as WorkerMessageHandler,
    createAck: null as Record<string, unknown> | null
  }
}))

function buildConversation(id = 'conv-1', imageUrl: string | null = null) {
  return {
    id,
    protocol: 'marmot' as const,
    participants: [ME_PUBKEY, FRIEND_PUBKEY],
    adminPubkeys: [ME_PUBKEY],
    canInviteMembers: true,
    title: 'Chat',
    description: null,
    imageUrl,
    unreadCount: 0,
    lastMessageAt: 0,
    lastReadAt: 0
  }
}

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    pubkey: ME_PUBKEY,
    relayList: {
      read: ['wss://relay.test'],
      write: []
    },
    isReady: true
  })
}))

vi.mock('@/services/electron-ipc.service', () => ({
  electronIpc: {
    isElectron: () => true,
    sendToWorkerAwait: sendToWorkerAwaitMock,
    onWorkerMessage: vi.fn((cb: (message: unknown) => void) => {
      state.workerMessageHandler = cb
      return () => {
        if (state.workerMessageHandler === cb) {
          state.workerMessageHandler = null
        }
      }
    })
  }
}))

vi.mock('@/services/media-upload.service', () => ({
  default: {
    upload: uploadMock
  }
}))

vi.mock('sonner', () => ({
  toast: {
    loading: toastLoadingMock,
    warning: toastWarningMock,
    error: toastErrorMock,
    dismiss: toastDismissMock
  }
}))

function Harness({ thumbnailFile = null }: { thumbnailFile?: File | null }) {
  const { createConversation, messenger, ready } = useMessenger()
  const [result, setResult] = useState('')

  useEffect(() => {
    if (!messenger) return
    return messenger.on(() => {})
  }, [messenger])

  return (
    <div>
      <div data-testid="ready">{String(ready)}</div>
      <button
        disabled={!ready}
        onClick={async () => {
          const created = await createConversation({
            title: 'Chat',
            members: [FRIEND_PUBKEY],
            thumbnailFile,
            relayUrls: ['wss://relay.test']
          })
          setResult(`${created.conversation.id}:${created.operationId}`)
        }}
      >
        create
      </button>
      <div data-testid="result">{result}</div>
    </div>
  )
}

function InitHarness() {
  const { ready, initialSyncPending, unsupportedReason, conversations, invites } = useMessenger()

  return (
    <div>
      <div data-testid="ready">{String(ready)}</div>
      <div data-testid="initial-sync-pending">{String(initialSyncPending)}</div>
      <div data-testid="unsupported-reason">{unsupportedReason || ''}</div>
      <div data-testid="conversation-count">{String(conversations.length)}</div>
      <div data-testid="invite-count">{String(invites.length)}</div>
    </div>
  )
}

function JoinHarness() {
  const { acceptInvite, ready } = useMessenger()
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  return (
    <div>
      <div data-testid="join-ready">{String(ready)}</div>
      <button
        disabled={!ready}
        onClick={async () => {
          try {
            const joined = await acceptInvite('invite-1')
            setResult(joined.conversationId || '')
          } catch (joinError) {
            setError(joinError instanceof Error ? joinError.message : String(joinError))
          }
        }}
      >
        join
      </button>
      <div data-testid="join-result">{result}</div>
      <div data-testid="join-error">{error}</div>
    </div>
  )
}

describe('MessengerProvider create conversation contract', () => {
  beforeEach(() => {
    state.workerMessageHandler = null
    state.createAck = {
      operationId: 'op-1',
      conversation: buildConversation('conv-1')
    }
    sendToWorkerAwaitMock.mockReset()
    uploadMock.mockReset()
    toastLoadingMock.mockReset()
    toastWarningMock.mockReset()
    toastErrorMock.mockReset()
    toastDismissMock.mockReset()
    toastLoadingMock.mockReturnValue('toast-create-op')
    uploadMock.mockResolvedValue({
      url: 'https://cdn.example/thumb.png',
      tags: [],
      metadata: {
        mimeType: 'image/png',
        fileName: 'thumb.png',
        size: 128
      }
    })

    sendToWorkerAwaitMock.mockImplementation(
      async ({ message }: { message: { type: string; requestId?: string } }) => {
      switch (message.type) {
        case 'marmot-init':
          return {
            success: true,
            data: {
              operationId: message.requestId || 'init-op-1',
              initialized: true,
              conversations: [],
              invites: []
            }
          }
        case 'marmot-create-conversation':
          return {
            success: true,
            data: state.createAck
          }
        case 'marmot-update-conversation-metadata':
          return {
            success: true,
            data: {
              conversation: buildConversation('conv-1', 'https://cdn.example/thumb.png')
            }
          }
        case 'marmot-list-conversations':
          return {
            success: true,
            data: {
              conversations: [buildConversation('conv-1')]
            }
          }
        case 'marmot-list-invites':
          return {
            success: true,
            data: {
              invites: []
            }
          }
        case 'marmot-accept-invite':
          return {
            success: true,
            data: {
              operationId: message.requestId || 'join-op-1',
              inviteId: 'invite-1'
            }
          }
        default:
          return {
            success: true,
            data: {}
          }
      }
      }
    )
  })

  it('resolves createConversation on ack and dismisses the loading toast after background completion', async () => {
    render(
      <MessengerProvider>
        <Harness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'create' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'create' }))

    await waitFor(() => {
      const createCall = sendToWorkerAwaitMock.mock.calls.find(
        ([payload]) => payload?.message?.type === 'marmot-create-conversation'
      )
      expect(createCall?.[0]?.message?.data?.relayMode).toBeUndefined()
      expect(createCall?.[0]?.message?.data?.relayUrls).toEqual(['wss://relay.test/'])
    })

    await waitFor(() => {
      expect(screen.getByTestId('result')).toHaveTextContent('conv-1:op-1')
    })
    expect(toastLoadingMock).toHaveBeenCalled()

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-create-conversation-operation',
        data: {
          operationId: 'op-1',
          conversationId: 'conv-1',
          phase: 'completed',
          invited: [FRIEND_PUBKEY],
          failed: [],
          conversation: buildConversation('conv-1')
        }
      })
    })

    await waitFor(() => {
      expect(toastDismissMock).toHaveBeenCalledWith('toast-create-op')
    })
    expect(
      sendToWorkerAwaitMock.mock.calls.some(
        ([payload]) => payload?.message?.type === 'marmot-list-conversations'
      )
    ).toBe(true)
    expect(
      sendToWorkerAwaitMock.mock.calls.some(([payload]) => payload?.message?.type === 'marmot-list-invites')
    ).toBe(true)
  })

  it('converts invite failures into a warning toast after the worker completes', async () => {
    render(
      <MessengerProvider>
        <Harness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'create' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'create' }))

    await waitFor(() => {
      expect(screen.getByTestId('result')).toHaveTextContent('conv-1:op-1')
    })

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-create-conversation-operation',
        data: {
          operationId: 'op-1',
          conversationId: 'conv-1',
          phase: 'completed',
          invited: [],
          failed: [{ pubkey: FRIEND_PUBKEY, error: 'invite failed' }],
          conversation: buildConversation('conv-1')
        }
      })
    })

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalled()
    })
  })

  it('keeps the ack result immediate and surfaces thumbnail upload failure as a background error', async () => {
    let rejectUpload: ((error: Error) => void) | null = null
    uploadMock.mockImplementation(
      async () =>
        await new Promise((_, reject) => {
          rejectUpload = reject as (error: Error) => void
        })
    )

    render(
      <MessengerProvider>
        <Harness thumbnailFile={new File(['thumb'], 'thumb.png', { type: 'image/png' })} />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'create' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'create' }))

    await waitFor(() => {
      expect(screen.getByTestId('result')).toHaveTextContent('conv-1:op-1')
    })
    expect(uploadMock).toHaveBeenCalled()

    rejectUpload?.(new Error('upload failed'))

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled()
    })
  })

  it('sets ready from the init ack while keeping initial sync pending until the background op completes', async () => {
    sendToWorkerAwaitMock.mockImplementationOnce(async () => ({
      success: true,
      data: {
        operationId: 'init-op-2',
        initialized: true,
        conversations: [buildConversation('conv-cached')],
        invites: []
      }
    }))

    render(
      <MessengerProvider>
        <InitHarness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true')
    })
    expect(screen.getByTestId('initial-sync-pending')).toHaveTextContent('true')
    expect(screen.getByTestId('conversation-count')).toHaveTextContent('1')

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-init-operation',
        data: {
          operationId: 'init-op-2',
          phase: 'completed'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('initial-sync-pending')).toHaveTextContent('false')
    })
  })

  it('keeps background init failures non-blocking when cached data is already available', async () => {
    sendToWorkerAwaitMock.mockImplementationOnce(async () => ({
      success: true,
      data: {
        operationId: 'init-op-3',
        initialized: true,
        conversations: [buildConversation('conv-cached-2')],
        invites: []
      }
    }))

    render(
      <MessengerProvider>
        <InitHarness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true')
    })

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-init-operation',
        data: {
          operationId: 'init-op-3',
          phase: 'failed',
          error: 'sync failed'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('initial-sync-pending')).toHaveTextContent('false')
    })
    expect(screen.getByTestId('unsupported-reason')).toHaveTextContent('')
  })

  it('resolves acceptInvite on the joinedConversation phase and does not refresh lists afterward', async () => {
    render(
      <MessengerProvider>
        <JoinHarness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'join' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'join' }))

    const joinRequestId = sendToWorkerAwaitMock.mock.calls.find(
      ([payload]) => payload?.message?.type === 'marmot-accept-invite'
    )?.[0]?.message?.requestId

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-accept-invite-operation',
        data: {
          operationId: joinRequestId,
          inviteId: 'invite-1',
          phase: 'joinedConversation',
          conversationId: 'conv-join-1',
          conversation: buildConversation('conv-join-1')
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('join-result')).toHaveTextContent('conv-join-1')
    })
    expect(
      sendToWorkerAwaitMock.mock.calls.some(
        ([payload]) => payload?.message?.type === 'marmot-list-conversations'
      )
    ).toBe(false)
    expect(
      sendToWorkerAwaitMock.mock.calls.some(([payload]) => payload?.message?.type === 'marmot-list-invites')
    ).toBe(false)
  })

  it('surfaces post-join sync failure as a provider toast without blocking the join result', async () => {
    render(
      <MessengerProvider>
        <JoinHarness />
      </MessengerProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'join' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'join' }))

    const joinRequestId = sendToWorkerAwaitMock.mock.calls.find(
      ([payload]) => payload?.message?.type === 'marmot-accept-invite'
    )?.[0]?.message?.requestId

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-accept-invite-operation',
        data: {
          operationId: joinRequestId,
          inviteId: 'invite-1',
          phase: 'joinedConversation',
          conversationId: 'conv-join-2',
          conversation: buildConversation('conv-join-2')
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('join-result')).toHaveTextContent('conv-join-2')
    })

    await act(async () => {
      state.workerMessageHandler?.({
        type: 'marmot-accept-invite-operation',
        data: {
          operationId: joinRequestId,
          inviteId: 'invite-1',
          phase: 'failed',
          conversationId: 'conv-join-2',
          error: 'sync failed'
        }
      })
    })

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled()
    })
  })
})
