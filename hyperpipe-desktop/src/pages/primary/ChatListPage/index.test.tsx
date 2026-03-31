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
  dismissInviteMock,
  toastErrorMock,
  messengerState
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  createConversationMock: vi.fn(),
  acceptInviteMock: vi.fn(),
  refreshConversationsMock: vi.fn(async () => []),
  refreshInvitesMock: vi.fn(async () => []),
  dismissInviteMock: vi.fn(),
  toastErrorMock: vi.fn(),
  messengerState: {
    invites: [] as Array<Record<string, unknown>>,
    conversations: [] as Array<Record<string, unknown>>,
    inviteProfiles: [] as Array<Record<string, string>>,
    ready: true,
    initialSyncPending: false,
    unsupportedReason: undefined as string | undefined
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
    ready: messengerState.ready,
    initialSyncPending: messengerState.initialSyncPending,
    unsupportedReason: messengerState.unsupportedReason,
    createConversation: createConversationMock,
    acceptInvite: acceptInviteMock,
    refreshConversations: refreshConversationsMock,
    refreshInvites: refreshInvitesMock,
    dismissInvite: dismissInviteMock
  })
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

describe('ChatListPage chat UX', () => {
  const openCreateWizard = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  }

  const moveToMembersStep = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  }

  const addFriendInvitee = async () => {
    fireEvent.change(screen.getByPlaceholderText('Search users...'), {
      target: { value: 'friend' }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    await screen.findByText('Selected members (1)')
  }

  const moveToRelaysStep = async () => {
    moveToMembersStep()
    await addFriendInvitee()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  }

  beforeEach(() => {
    messengerState.invites = []
    messengerState.conversations = []
    messengerState.inviteProfiles = [{ pubkey: FRIEND_PUBKEY }]
    messengerState.ready = true
    messengerState.initialSyncPending = false
    messengerState.unsupportedReason = undefined
    pushMock.mockReset()
    createConversationMock.mockReset()
    acceptInviteMock.mockReset()
    refreshConversationsMock.mockReset()
    refreshInvitesMock.mockReset()
    dismissInviteMock.mockReset()
    toastErrorMock.mockReset()
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
    globalThis.URL.revokeObjectURL = vi.fn()
  })

  it('locks the create-chat modal during the provider create phase without rendering a progress bar', async () => {
    createConversationMock.mockImplementation(
      async (_payload: unknown) =>
        await new Promise(() => {
          // keep the create request pending so the modal remains in its busy state
        })
    )

    render(<ChatListPage />)

    openCreateWizard()
    await moveToRelaysStep()
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Creating chat…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    expect(refreshConversationsMock).not.toHaveBeenCalled()
    expect(refreshInvitesMock).not.toHaveBeenCalled()
  })

  it('passes the selected thumbnail file to the provider and navigates immediately on ack', async () => {
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
      operationId: 'op-2'
    })

    render(<ChatListPage />)

    openCreateWizard()
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['thumb'], 'thumb.png', { type: 'image/png' })]
      }
    })
    await moveToRelaysStep()
    fireEvent.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/conversations/conv-2')
    })
    const payload = createConversationMock.mock.calls[0]?.[0] as {
      thumbnailFile?: File | null
    }
    expect(payload.thumbnailFile).toBeInstanceOf(File)
    expect(screen.queryByText('Upload a chat thumbnail')).not.toBeInTheDocument()
  })

  it('renders the create-chat dialog as a three-step wizard with step state persistence and no fallback toggle', async () => {
    render(<ChatListPage />)

    openCreateWizard()

    expect(document.querySelector('[role=\"dialog\"].flex.flex-col.overflow-hidden')).toBeTruthy()
    expect(document.querySelector('[role=\"dialog\"] .min-h-0.flex-1.overflow-y-auto.px-6.py-5')).toBeTruthy()
    expect(document.querySelector('[role=\"dialog\"] .shrink-0.border-t.bg-background.px-6.py-4')).toBeTruthy()
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Relays')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Upload a chat thumbnail')).toBeInTheDocument()
    expect(screen.queryByText('Discovery relay fallback')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(screen.queryByText('relay-selector')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Chat title'), {
      target: { value: 'Launch Room' }
    })
    moveToMembersStep()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search users...'), {
      target: { value: 'friend' }
    })

    expect(await screen.findByText('Search results')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('Selected members (1)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByDisplayValue('Launch Room')).toBeInTheDocument()

    moveToMembersStep()
    expect(screen.getByText('Selected members (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
    expect(screen.getByText('relay-selector')).toBeInTheDocument()
    expect(screen.getByText('Launch Room')).toBeInTheDocument()
  })

  it('shows button-level join busy state in the active invite row and avoids extra page refreshes', async () => {
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
    acceptInviteMock.mockImplementation(async (_inviteId: string) => {
        await new Promise<void>((resolve) => {
          resolveJoin = resolve
        })
        return { conversationId: 'conv-join-1' }
      })

    render(<ChatListPage initialTab="invites" />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Join' })[0])

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Accepting invite…')).not.toBeInTheDocument()
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

  it('keeps the invites tab loading while initial sync is pending and no invites are cached', async () => {
    messengerState.initialSyncPending = true
    messengerState.ready = true
    messengerState.unsupportedReason = 'Worker reply timeout after 60000ms'

    render(<ChatListPage initialTab="invites" />)

    expect(screen.getByText('Loading invites...')).toBeInTheDocument()
    expect(screen.queryByText('Worker reply timeout after 60000ms')).not.toBeInTheDocument()
    expect(screen.queryByText('No invites')).not.toBeInTheDocument()
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

    acceptInviteMock.mockImplementation(async (_inviteId: string) => {
      throw new Error('join failed')
    })

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
