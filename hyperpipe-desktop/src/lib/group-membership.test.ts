import {
  buildGroupMembershipSourcePlan,
  isSuspiciousCreatorSelfMembershipDowngrade,
  choosePreferredMembershipState,
  createGroupMembershipState,
  resolveCanonicalGroupMembershipState,
  selectPreferredMembershipState
} from '@/lib/group-membership'
import type { Filter } from '@jsr/nostr__tools/filter'
import type { Event } from '@jsr/nostr__tools/wasm'

const makeEvent = ({
  id,
  kind,
  createdAt,
  pubkey = 'author',
  tags = []
}: {
  id: string
  kind: number
  createdAt: number
  pubkey?: string
  tags?: string[][]
}) =>
  ({
    id,
    kind,
    created_at: createdAt,
    pubkey,
    tags,
    content: '',
    sig: ''
  }) as unknown as Event

const buildFetchEventsMock = (eventsByRelay: Record<string, Event[]>) => {
  return async (relayUrls: string[], filter: Filter) => {
    const events = relayUrls.flatMap((relayUrl) => eventsByRelay[relayUrl] || [])
    return events
      .filter((event) => {
        if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false
        if (filter.authors?.length && !filter.authors.includes(event.pubkey)) return false
        if (typeof filter.since === 'number' && event.created_at <= filter.since) return false
        if (typeof filter.until === 'number' && event.created_at > filter.until) return false
        const dTags = filter['#d']
        if (Array.isArray(dTags) && dTags.length > 0) {
          const eventDTag = event.tags.find((tag) => tag[0] === 'd')?.[1]
          if (!eventDTag || !dTags.includes(eventDTag)) return false
        }
        const hTags = filter['#h']
        if (Array.isArray(hTags) && hTags.length > 0) {
          const eventHTag = event.tags.find((tag) => tag[0] === 'h')?.[1]
          if (!eventHTag || !hTags.includes(eventHTag)) return false
        }
        return true
      })
      .sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
      .slice(0, filter.limit || Number.MAX_SAFE_INTEGER)
  }
}

describe('group membership resolver', () => {
  it('uses discovery relays only for discover-feed membership resolution', () => {
    const sources = buildGroupMembershipSourcePlan({
      discoveryOnly: true,
      knownPrivateGroup: false,
      canUseResolvedRelay: true,
      resolvedRelay: 'wss://resolved',
      discoveryRelays: ['wss://discovery-a', 'wss://discovery-b'],
      relayReadyForReq: true
    })

    expect(sources).toEqual([
      {
        key: 'discovery',
        relayUrls: ['wss://discovery-a', 'wss://discovery-b'],
        snapshotAuthorityEligible: true,
        allowSnapshots: true,
        allowOps: true
      }
    ])
  })

  it('keeps the discovery member set when the resolved relay is not ready', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'resolved-snapshot',
          kind: 39002,
          createdAt: 200,
          tags: [
            ['h', 'group-1'],
            ['d', 'group-1'],
            ['p', 'alice']
          ]
        })
      ],
      'wss://discovery': [
        makeEvent({
          id: 'discovery-snapshot',
          kind: 39002,
          createdAt: 150,
          tags: [
            ['h', 'group-1'],
            ['d', 'group-1'],
            ['p', 'alice'],
            ['p', 'bob'],
            ['p', 'carol']
          ]
        })
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-1',
      fetchEvents,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: false,
          allowSnapshots: true,
          allowOps: true
        },
        {
          key: 'discovery',
          relayUrls: ['wss://discovery'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.members).toEqual(['alice', 'bob', 'carol'])
    expect(result.state.quality).toBe('complete')
    expect(result.state.hydrationSource).toBe('live-discovery')
  })

  it('promotes the resolved relay once it is ready and newer', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'resolved-snapshot',
          kind: 39002,
          createdAt: 300,
          tags: [
            ['h', 'group-1'],
            ['d', 'group-1'],
            ['p', 'alice'],
            ['p', 'bob'],
            ['p', 'carol']
          ]
        })
      ],
      'wss://discovery': [
        makeEvent({
          id: 'discovery-snapshot',
          kind: 39002,
          createdAt: 200,
          tags: [
            ['h', 'group-1'],
            ['d', 'group-1'],
            ['p', 'alice'],
            ['p', 'bob']
          ]
        })
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-1',
      fetchEvents,
      relayReadyForReq: true,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        },
        {
          key: 'discovery',
          relayUrls: ['wss://discovery'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.members).toEqual(['alice', 'bob', 'carol'])
    expect(result.state.hydrationSource).toBe('live-resolved-relay')
    expect(result.state.selectedSnapshotId).toBe('resolved-snapshot')
  })

  it('ignores a newer self-only resolved snapshot for creators when a fuller fallback snapshot exists', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'resolved-self-only',
          kind: 39002,
          createdAt: 300,
          pubkey: 'alice',
          tags: [
            ['h', 'group-creator'],
            ['d', 'group-creator'],
            ['p', 'alice']
          ]
        })
      ],
      'wss://discovery': [
        makeEvent({
          id: 'discovery-full',
          kind: 39002,
          createdAt: 200,
          tags: [
            ['h', 'group-creator'],
            ['d', 'group-creator'],
            ['p', 'alice'],
            ['p', 'bob'],
            ['p', 'carol']
          ]
        })
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-creator',
      fetchEvents,
      currentPubkey: 'alice',
      isCreator: true,
      relayReadyForReq: true,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        },
        {
          key: 'discovery',
          relayUrls: ['wss://discovery'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.members).toEqual(['alice', 'bob', 'carol'])
    expect(result.state.selectedSnapshotId).toBe('discovery-full')
    expect(result.state.hydrationSource).toBe('live-discovery')
  })

  it('uses an older fuller snapshot from the same resolved relay when the latest creator snapshot is self-only', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'resolved-self-only',
          kind: 39002,
          createdAt: 300,
          pubkey: 'alice',
          tags: [
            ['h', 'group-same-relay'],
            ['d', 'group-same-relay'],
            ['p', 'alice']
          ]
        }),
        makeEvent({
          id: 'resolved-fuller',
          kind: 39002,
          createdAt: 200,
          pubkey: 'other-author',
          tags: [
            ['h', 'group-same-relay'],
            ['d', 'group-same-relay'],
            ['p', 'alice'],
            ['p', 'bob'],
            ['p', 'carol'],
            ['p', 'dave']
          ]
        })
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-same-relay',
      fetchEvents,
      currentPubkey: 'alice',
      isCreator: true,
      relayReadyForReq: true,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.members).toEqual(['alice', 'bob', 'carol', 'dave'])
    expect(result.state.selectedSnapshotId).toBe('resolved-fuller')
    expect(result.selectionDebug.skippedSuspiciousCandidateIds).toEqual(['resolved-self-only'])
  })

  it('preserves the protected complete state when the only live resolved snapshot is suspiciously self-only', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'resolved-self-only',
          kind: 39002,
          createdAt: 300,
          pubkey: 'alice',
          tags: [
            ['h', 'group-protected'],
            ['d', 'group-protected'],
            ['p', 'alice']
          ]
        })
      ]
    })

    const protectedState = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      membershipStatus: 'member',
      quality: 'complete',
      hydrationSource: 'persisted-last-complete',
      selectedSnapshotId: 'persisted-complete',
      selectedSnapshotCreatedAt: 250,
      selectedSnapshotSource: 'persisted-last-complete',
      source: 'persisted-last-complete',
      membershipAuthoritative: true,
      authoritative: true,
      membershipFetchSource: 'persisted-last-complete'
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-protected',
      fetchEvents,
      currentPubkey: 'alice',
      isCreator: true,
      protectedState,
      relayReadyForReq: true,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.members).toEqual(['alice', 'bob', 'carol'])
    expect(result.state.selectedSnapshotId).toBe('persisted-complete')
    expect(result.selectionDebug.usedProtectedState).toBe(true)
    expect(result.selectionDebug.skippedSuspiciousCandidateIds).toEqual(['resolved-self-only'])
  })

  it('paginates membership ops beyond the old 50-event window', async () => {
    const ops = Array.from({ length: 60 }, (_, index) =>
      makeEvent({
        id: `member-add-${index}`,
        kind: 9000,
        createdAt: 200 - index,
        pubkey: `actor-${index}`,
        tags: [
          ['h', 'group-2'],
          ['p', `member-${index}`]
        ]
      })
    )
    const fetchEvents = buildFetchEventsMock({
      'wss://discovery': [
        makeEvent({
          id: 'snapshot',
          kind: 39002,
          createdAt: 100,
          tags: [
            ['h', 'group-2'],
            ['d', 'group-2'],
            ['p', 'alpha'],
            ['p', 'beta']
          ]
        }),
        ...ops
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-2',
      fetchEvents,
      opsPageSize: 25,
      opsMaxPerSource: 500,
      sources: [
        {
          key: 'discovery',
          relayUrls: ['wss://discovery'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ]
    })

    expect(result.state.memberCount).toBe(62)
    expect(result.state.members[0]).toBe('alpha')
    expect(result.state.members).toContain('member-59')
    expect(result.state.membershipEventsCount).toBe(60)
  })

  it('applies private shadow leave events without p-tags', async () => {
    const fetchEvents = buildFetchEventsMock({
      'wss://resolved': [
        makeEvent({
          id: 'snapshot',
          kind: 39002,
          createdAt: 100,
          tags: [
            ['h', 'group-3'],
            ['d', 'group-3'],
            ['p', 'alice'],
            ['p', 'bob']
          ]
        })
      ]
    })

    const result = await resolveCanonicalGroupMembershipState({
      groupId: 'group-3',
      fetchEvents,
      sources: [
        {
          key: 'resolved-relay',
          relayUrls: ['wss://resolved'],
          snapshotAuthorityEligible: true,
          allowSnapshots: true,
          allowOps: true
        }
      ],
      extraMembershipEvents: [
        makeEvent({
          id: 'shadow-leave',
          kind: 9022,
          createdAt: 120,
          pubkey: 'bob',
          tags: [['h', 'group-3']]
        })
      ],
      extraMembershipEventsSource: 'discovery'
    })

    expect(result.state.members).toEqual(['alice'])
  })

  it('does not churn on the same member set in a different order', () => {
    const current = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'discovery',
      selectedSnapshotCreatedAt: 100,
      membershipEventsCount: 4,
      updatedAt: 10
    })
    const incoming = createGroupMembershipState({
      members: ['carol', 'alice', 'bob'],
      quality: 'complete',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'discovery',
      selectedSnapshotCreatedAt: 100,
      membershipEventsCount: 4,
      updatedAt: 20
    })

    expect(choosePreferredMembershipState(current, incoming)).toBe(current)
  })

  it('selects the strongest alias state when relay and fallback cache entries diverge', () => {
    const completeFallback = createGroupMembershipState({
      members: ['alice', 'bob', 'carol', 'dave'],
      quality: 'complete',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'discovery',
      selectedSnapshotCreatedAt: 500,
      membershipEventsCount: 12,
      updatedAt: 100
    })
    const incompleteRelay = createGroupMembershipState({
      members: ['alice', 'bob'],
      quality: 'warming',
      hydrationSource: 'live-resolved-relay',
      selectedSnapshotSource: 'resolved-relay',
      selectedSnapshotCreatedAt: 450,
      membershipEventsCount: 3,
      updatedAt: 200
    })

    const preferred = selectPreferredMembershipState([incompleteRelay, completeFallback])

    expect(preferred).toBe(completeFallback)
    expect(preferred?.members).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('flags suspicious creator self-only relay downgrades', () => {
    const currentState = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'persisted-last-complete',
      selectedSnapshotSource: 'persisted-last-complete',
      membershipFetchSource: 'persisted-last-complete'
    })
    const incomingState = createGroupMembershipState({
      members: ['alice'],
      quality: 'complete',
      hydrationSource: 'live-resolved-relay',
      selectedSnapshotSource: 'resolved-relay',
      membershipFetchSource: 'group-relay',
      membershipEventsCount: 0
    })

    expect(
      isSuspiciousCreatorSelfMembershipDowngrade({
        currentState,
        incomingState,
        currentPubkey: 'alice',
        isCreator: true
      })
    ).toBe(true)
  })

  it('flags suspicious creator self-only relay downgrades without depending on hydration source', () => {
    const currentState = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'persisted-last-complete',
      selectedSnapshotSource: 'persisted-last-complete',
      membershipFetchSource: 'persisted-last-complete'
    })
    const incomingState = createGroupMembershipState({
      members: ['alice'],
      quality: 'warming',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'resolved-relay',
      membershipFetchSource: 'group-relay',
      membershipEventsCount: 0,
      membersFromEventCount: 1
    })

    expect(
      isSuspiciousCreatorSelfMembershipDowngrade({
        currentState,
        incomingState,
        currentPubkey: 'alice',
        isCreator: true
      })
    ).toBe(true)
  })
})
