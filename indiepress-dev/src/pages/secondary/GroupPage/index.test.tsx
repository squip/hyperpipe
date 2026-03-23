import { createGroupMembershipState } from '@/lib/group-membership'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'

const canonicalMembership = createGroupMembershipState({
  members: ['alice', 'bob', 'carol'],
  quality: 'complete',
  hydrationSource: 'persisted-last-complete',
  selectedSnapshotSource: 'persisted-last-complete',
  membershipStatus: 'member'
})

vi.mock('@/layouts/SecondaryPageLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/UserAvatar', () => ({
  default: ({ userId }: { userId: string }) => <div>{userId}</div>,
  SimpleUserAvatar: ({ userId }: { userId: string }) => <div>{userId}</div>
}))

vi.mock('@/components/Username', () => ({
  default: ({ userId }: { userId: string }) => <div>{userId}</div>,
  SimpleUsername: ({ userId }: { userId: string }) => <div>{userId}</div>
}))

vi.mock('@/components/NormalFeed', () => ({ default: () => <div>feed</div> }))
vi.mock('@/components/GroupFilesList', () => ({ default: () => <div>files</div> }))
vi.mock('@/components/PostEditor', () => ({ default: () => <div>editor</div> }))
vi.mock('@/components/GroupMetadataEditor', () => ({
  default: () => <div>metadata-editor</div>
}))
vi.mock('@/components/NoteOptions/ReportDialog', () => ({ default: () => null }))
vi.mock('@/components/Nip05', () => ({ default: () => null }))
vi.mock('@/components/FollowButton', () => ({ default: () => null }))

vi.mock('@/services/local-storage.service', () => ({
  default: {
    markDismissedGroupAdminLeaveEvent: vi.fn(),
    isGroupAdminLeaveEventDismissed: vi.fn(() => false)
  }
}))

vi.mock('@/services/relay-membership.service', () => ({
  default: {
    removeMember: vi.fn()
  }
}))

vi.mock('@/services/client.service', () => ({
  default: {
    fetchEvents: vi.fn(async () => []),
    loadMoreTimeline: vi.fn(async () => [])
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

vi.mock('@/providers/GroupsProvider', () => ({
  useGroups: () => ({
    discoveryGroups: [],
    fetchGroupDetail: vi.fn(async () => ({
      metadata: {
        id: 'group-1',
        relay: 'wss://relay.example',
        name: 'Canonical Group',
        about: 'A test group',
        picture: undefined,
        isPublic: true,
        isOpen: true,
        tags: [],
        event: {
          id: 'meta-1',
          kind: 39000,
          created_at: 10,
          pubkey: 'alice',
          tags: [['d', 'group-1']],
          content: '',
          sig: ''
        }
      },
      admins: [{ pubkey: 'alice', roles: ['admin'] }],
      members: [],
      membership: canonicalMembership,
      membershipStatus: 'member' as const,
      membershipAuthoritative: true,
      membershipEventsCount: 0,
      membersFromEventCount: 0,
      membersSnapshotCreatedAt: null,
      membershipFetchTimedOutLike: false,
      membershipFetchSource: 'group-relay' as const
    })),
    getProvisionalGroupMetadata: vi.fn(() => null),
    getGroupMemberPreview: vi.fn(() => canonicalMembership),
    hydrateGroupMemberPreview: vi.fn(async () => {}),
    sendJoinRequest: vi.fn(async () => {}),
    leaveGroup: vi.fn(async () => ({
      worker: null,
      queuedRetry: false,
      publishErrors: [],
      recoveredCount: 0,
      failedCount: 0
    })),
    invites: [],
    sendInvites: vi.fn(async () => {}),
    joinRequests: {},
    joinRequestsError: null,
    loadJoinRequests: vi.fn(async () => {}),
    approveJoinRequest: vi.fn(async () => {}),
    rejectJoinRequest: vi.fn(async () => {}),
    updateMetadata: vi.fn(async () => {}),
    grantAdmin: vi.fn(async () => {}),
    removeUser: vi.fn(async () => {}),
    resolveRelayUrl: vi.fn((relay?: string) => relay),
    myGroupList: [{ groupId: 'group-1', relay: 'wss://relay.example' }]
  })
}))

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    pubkey: 'alice',
    profile: null
  })
}))

vi.mock('@/providers/WorkerBridgeProvider', () => ({
  useWorkerBridge: () => ({
    joinFlows: {},
    startJoinFlow: vi.fn(async () => {}),
    relays: [],
    sendToWorker: vi.fn(async () => ({})),
    relayServerReady: false,
    refreshRelaySubscriptions: vi.fn(async () => ({})),
    probeGroupPresence: vi.fn(async () => ({
      count: 2,
      status: 'ready',
      source: 'gateway',
      gatewayIncluded: true,
      gatewayHealthy: true,
      lastUpdatedAt: Date.now(),
      unknown: false,
      error: null,
      verifiedAt: Date.now(),
      usablePeerCount: 1,
      aggregatePeerCount: 2,
      registeredPeerCount: 1,
      staleRegisteredPeerCount: 0
    }))
  })
}))

vi.mock('@/providers/MuteListProvider', () => ({
  useMuteList: () => ({
    mutePrivately: vi.fn(),
    mutePublicly: vi.fn()
  })
}))

vi.mock('@/hooks/useSearchProfiles', () => ({
  useSearchProfiles: () => ({
    profiles: [],
    isFetching: false
  })
}))

vi.mock('@/PageManager', () => ({
  useSecondaryPage: () => ({
    pop: vi.fn()
  })
}))

vi.mock('@/devtools/closedJoinSimulator', () => ({
  registerClosedJoinSimulator: vi.fn()
}))

import GroupPage from '@/pages/secondary/GroupPage'

describe('GroupPage canonical membership rendering', () => {
  it('uses one canonical member set for the header, badge, member list, and peers chip', async () => {
    render(<GroupPage id="group-1" relay="wss://relay.example" />)

    expect(await screen.findByText(/3 members/i)).toBeInTheDocument()
    expect(screen.getByText('Members (3)')).toBeInTheDocument()
    expect(await screen.findByText(/2 peers online/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getAllByText('alice').length).toBeGreaterThan(0)
      expect(screen.getAllByText('bob').length).toBeGreaterThan(0)
      expect(screen.getAllByText('carol').length).toBeGreaterThan(0)
    })
  })
})
