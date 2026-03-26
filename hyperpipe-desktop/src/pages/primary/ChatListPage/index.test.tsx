import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ChatListPage from '@/pages/primary/ChatListPage'

const ME_PUBKEY = '1'.repeat(64)
const FRIEND_PUBKEY = '2'.repeat(64)
const ALICE_PUBKEY = '3'.repeat(64)
const BOB_PUBKEY = '4'.repeat(64)

const {
  pushMock,
  createConversationMock,
  acceptInviteMock,
  refreshConversationsMock,
  refreshInvitesMock,
  updateConversationMetadataMock,
  dismissInviteMock,
  toastErrorMock,
  toastWarningMock,
  mediaUploadMock,
  messengerState
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  createConversationMock: vi.fn(),
  acceptInviteMock: vi.fn(),
  refreshConversationsMock: vi.fn(async () => []),
  refreshInvitesMock: vi.fn(async () => []),
  updateConversationMetadataMock: vi.fn(async () => {}),
  dismissInviteMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastWarningMock: vi.fn(),
  mediaUploadMock: vi.fn(),
  messengerState: {
    invites: [] as Array<Record<string, unknown>>,
    conversations: [] as Array<Record<string, unknown>>,
    inviteProfiles: [] as Array<Record<string, string>>
  }
}))

vi.mock('@/layouts/PrimaryPageLayout', () => ({
  default: React.forwardRef(({ children }: { children: React.ReactNode }, _ref) => (
    <div>{children}</div>
  ))
}))

vi.mock('@/components/TitlebarInfoButton', () => ({
  default: () => null
}))

vi.mock('@/components/ChatConversations', () => ({
  ChatListPanel: () => <div>chat-list</div>
}))

vi.mock('@/components/PostEditor/PostRelaySelector', () => ({
  default: () => <div>relay-selector</div>
}))

vi.mock('@/components/UserAvatar', () => ({
  default: ({ userId }: { userId: string }) => <div>{userId}</div>,
  SimpleUserAvatar: ({ userId }: { userId: string }) => <div>{userId}</div>
}))

vi.mock('@/components/FormattedTimestamp', () => ({
  FormattedTimestamp: ({ timestamp }: { timestamp: number | string }) => (
    <span>{String(timestamp)}</span>
  )
}))

vi.mock('@/components/Username', () => ({
  default: ({ userId, className }: { userId: string; className?: string }) => (
    <span className={className}>{userId}</span>
  )
}))

vi.mock('@/components/Nip05', () => ({
  default: ({ pubkey }: { pubkey: string }) => <span>{pubkey}</span>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    pubkey: ME_PUBKEY,
    relayList: {
      read: ['wss://relay.test'],
      write: []
    }
  })
}))

vi.mock('@/providers/GroupsProvider', () => ({
  useGroups: () => ({
    myGroupList: [],
    discoveryGroups: [],
    getProvisionalGroupMetadata: vi.fn(() => null),
    resolveRelayUrl: vi.fn((relay?: string) => relay)
  })
}))

vi.mock('@/providers/WorkerBridgeProvider', () => ({
  useWorkerBridge: () => ({
    refreshRelaySubscriptions: vi.fn(async () => ({}))
  })
}))

vi.mock('@/PageManager', () => ({
  useSecondaryPage: () => ({
    push: pushMock
  })
}))

vi.mock('@/hooks/useSearchProfiles', () => ({
  useSearchProfiles: () => ({
    profiles: messengerState.inviteProfiles,
    isFetching: false
  })
}))

vi.mock('@/providers/MessengerProvider', () => ({
  useMessenger: () => ({
    conversations: messengerState.conversations,
    invites: messengerState.invites,
    pendingInviteCount: messengerState.invites.length,
    ready: true,
    unsupportedReason: undefined,
    createConversation: createConversationMock,
    acceptInvite: acceptInviteMock,
    refreshConversations: refreshConversationsMock,
    refreshInvites: refreshInvitesMock,
    updateConversationMetadata: updateConversationMetadataMock,
    dismissInvite: dismissInviteMock
  })
}))

vi.mock('@/services/media-upload.service', () => ({
  default: {
    upload: mediaUploadMock
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    warning: toastWarningMock
  }
}))

describe('ChatListPage progress UX', () => {
  beforeEach(() => {
    messengerState.invites = []
    messengerState.conversations = []
    messengerState.inviteProfiles = [{ pubkey: FRIEND_PUBKEY }]
    pushMock.mockReset()
    createConversationMock.mockReset()
    acceptInviteMock.mockReset()
    refreshConversationsMock.mockReset()
    refreshInvitesMock.mockReset()
    updateConversationMetadataMock.mockReset()
    dismissInviteMock.mockReset()
    toastErrorMock.mockReset()
    toastWarningMock.mockReset()
    mediaUploadMock.mockReset()
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
    globalThis.URL.revokeObjectURL = vi.fn()
  })

  it('locks the create-chat modal during the provider create phase and avoids extra page refreshes', async () => {
    let resolveCreate: (() => void) | null = null
    createConversationMock.mockImplementation(
      async (
        _payload: unknown,
        options?: { onProgress?: (state: { phase: string; error?: string }) => void }
      ) => {
        options?.onProgress?.({ phase: 'creatingConversation' })
        await new Promise<void>((resolve) => {
          resolveCreate = resolve
        })
        options?.onProgress?.({ phase: 'syncingConversation' })
        return {
          conversation: {
            id: 'conv-1',
            protocol: 'marmot',
            participants: [ME_PUBKEY, FRIEND_PUBKEY],
            adminPubkeys: [],
            canInviteMembers: true,
            title: 'Chat',
            description: null,
            imageUrl: null,
            unreadCount: 0,
            lastMessageAt: 0,
            lastReadAt: 0
          },
          invited: [FRIEND_PUBKEY],
          failed: [{ pubkey: FRIEND_PUBKEY, error: 'invite failed' }]
        }
      }
    )

    render(<ChatListPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))

    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.getAllByText('Creating chat…')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    resolveCreate?.()

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/conversations/conv-1')
    })
    expect(refreshConversationsMock).not.toHaveBeenCalled()
    expect(refreshInvitesMock).not.toHaveBeenCalled()
    expect(toastWarningMock).toHaveBeenCalled()
  })

  it('renders thumbnail upload progress and publishes metadata when an image is selected', async () => {
    let resolveUpload: ((value: unknown) => void) | null = null
    createConversationMock.mockResolvedValue({
      conversation: {
        id: 'conv-2',
        protocol: 'marmot',
        participants: [ME_PUBKEY, FRIEND_PUBKEY],
        adminPubkeys: [],
        canInviteMembers: true,
        title: 'Chat',
        description: null,
        imageUrl: null,
        unreadCount: 0,
        lastMessageAt: 0,
        lastReadAt: 0
      },
      invited: [FRIEND_PUBKEY],
      failed: []
    })
    mediaUploadMock.mockImplementation(
      async (_file: File, options?: { onProgress?: (progress: number) => void }) => {
        options?.onProgress?.(25)
        return await new Promise((resolve) => {
          resolveUpload = resolve
        })
      }
    )

    render(<ChatListPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['thumb'], 'thumb.png', { type: 'image/png' })]
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))

    expect(await screen.findByText('Uploading thumbnail… 25%')).toBeInTheDocument()

    resolveUpload?.({
      url: 'https://cdn.example/thumb.png',
      metadata: {
        mimeType: 'image/png',
        size: 128
      }
    })

    await waitFor(() => {
      expect(updateConversationMetadataMock).toHaveBeenCalled()
      expect(pushMock).toHaveBeenCalledWith('/conversations/conv-2')
    })
  })

  it('still opens the chat when thumbnail upload fails', async () => {
    createConversationMock.mockResolvedValue({
      conversation: {
        id: 'conv-3',
        protocol: 'marmot',
        participants: [ME_PUBKEY, FRIEND_PUBKEY],
        adminPubkeys: [],
        canInviteMembers: true,
        title: 'Chat',
        description: null,
        imageUrl: null,
        unreadCount: 0,
        lastMessageAt: 0,
        lastReadAt: 0
      },
      invited: [FRIEND_PUBKEY],
      failed: []
    })
    mediaUploadMock.mockRejectedValue(new Error('upload failed'))

    render(<ChatListPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['thumb'], 'thumb.png', { type: 'image/png' })]
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/conversations/conv-3')
    })
    expect(
      toastErrorMock.mock.calls.some(
        ([message]) => message === 'Chat created, but thumbnail upload failed'
      )
    ).toBe(true)
  })

  it('shows inline join progress in the active invite row and avoids extra page refreshes', async () => {
    messengerState.invites = [
      {
        id: 'invite-1',
        protocol: 'marmot',
        senderPubkey: ALICE_PUBKEY,
        createdAt: 10,
        status: 'pending',
        title: 'Alpha Chat',
        description: 'First invite',
        memberPubkeys: [ALICE_PUBKEY, ME_PUBKEY]
      },
      {
        id: 'invite-2',
        protocol: 'marmot',
        senderPubkey: BOB_PUBKEY,
        createdAt: 5,
        status: 'pending',
        title: 'Beta Chat',
        description: 'Second invite',
        memberPubkeys: [BOB_PUBKEY, ME_PUBKEY]
      }
    ]

    let resolveJoin: (() => void) | null = null
    acceptInviteMock.mockImplementation(
      async (
        _inviteId: string,
        options?: { onProgress?: (state: { phase: string; error?: string }) => void }
      ) => {
        options?.onProgress?.({ phase: 'joiningConversation' })
        await new Promise<void>((resolve) => {
          resolveJoin = resolve
        })
        options?.onProgress?.({ phase: 'syncingConversation' })
        return { conversationId: 'conv-join-1' }
      }
    )

    render(<ChatListPage initialTab="invites" />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Join' })[0])

    expect(await screen.findByText('Accepting invite…')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Dismiss' })[0]).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Joining...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()

    resolveJoin?.()

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/conversations/conv-join-1')
    })
    expect(refreshConversationsMock).not.toHaveBeenCalled()
    expect(refreshInvitesMock).not.toHaveBeenCalled()
  })

  it('restores row actions and shows an inline error when join invite fails', async () => {
    messengerState.invites = [
      {
        id: 'invite-error',
        protocol: 'marmot',
        senderPubkey: ALICE_PUBKEY,
        createdAt: 10,
        status: 'pending',
        title: 'Alpha Chat',
        description: 'First invite',
        memberPubkeys: [ALICE_PUBKEY, ME_PUBKEY]
      }
    ]

    acceptInviteMock.mockImplementation(
      async (
        _inviteId: string,
        options?: { onProgress?: (state: { phase: string; error?: string }) => void }
      ) => {
        options?.onProgress?.({ phase: 'joiningConversation' })
        throw new Error('join failed')
      }
    )

    render(<ChatListPage initialTab="invites" />)

    fireEvent.click(screen.getByRole('button', { name: 'Join' }))

    expect(await screen.findByText('join failed')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join' })).not.toBeDisabled()
    })
    expect(toastErrorMock.mock.calls.some(([message]) => message === 'Failed to join invite')).toBe(
      true
    )
  })
})
