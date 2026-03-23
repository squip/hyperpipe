import {
  applyWarmHydrationCursorToRelayFilter,
  buildRelayFeedSubRequests,
  extendFeedSubRequestsWithLocal
} from '@/lib/feed-subrequests'
import { TFeedSubRequest } from '@/types'

describe('feed subrequest utilities', () => {
  it('extends relay requests with matching local requests without duplicating existing locals', () => {
    const subRequests: TFeedSubRequest[] = [
      {
        source: 'local',
        filter: {
          '#h': ['group-1'],
          kinds: [1, 6]
        }
      },
      {
        source: 'relays',
        urls: ['wss://relay-a'],
        filter: {
          '#h': ['group-1'],
          kinds: [1, 6]
        }
      },
      {
        source: 'relays',
        urls: ['wss://relay-b'],
        filter: {
          '#h': ['group-2'],
          kinds: [1]
        }
      }
    ]

    expect(extendFeedSubRequestsWithLocal(subRequests)).toEqual([
      {
        source: 'local',
        filter: {
          '#h': ['group-1'],
          kinds: [1, 6]
        }
      },
      {
        source: 'local',
        filter: {
          '#h': ['group-2'],
          kinds: [1]
        }
      },
      {
        source: 'relays',
        urls: ['wss://relay-a'],
        filter: {
          '#h': ['group-1'],
          kinds: [1, 6]
        }
      },
      {
        source: 'relays',
        urls: ['wss://relay-b'],
        filter: {
          '#h': ['group-2'],
          kinds: [1]
        }
      }
    ])
  })

  it('applies a relay-only warm-hydration since cursor with a small overlap window', () => {
    expect(
      applyWarmHydrationCursorToRelayFilter(
        {
          '#h': ['group-1'],
          kinds: [1, 6]
        },
        200,
        10
      )
    ).toEqual({
      '#h': ['group-1'],
      kinds: [1, 6],
      since: 190
    })
  })

  it('preserves a stricter existing since filter', () => {
    expect(
      applyWarmHydrationCursorToRelayFilter(
        {
          '#h': ['group-1'],
          kinds: [1, 6],
          since: 250
        },
        200,
        10
      )
    ).toEqual({
      '#h': ['group-1'],
      kinds: [1, 6],
      since: 250
    })
  })

  it('builds local-only feed subrequests for a local group relay that is not ready yet', () => {
    expect(
      buildRelayFeedSubRequests({
        relayUrls: ['wss://local-group-relay'],
        groupId: 'group-1',
        warmHydrateLocalGroupRelay: true,
        relayReadyForReq: false
      })
    ).toEqual([
      {
        source: 'local',
        filter: {
          '#h': ['group-1']
        }
      }
    ])
  })

  it('builds local-plus-relay feed subrequests for a ready local group relay', () => {
    expect(
      buildRelayFeedSubRequests({
        relayUrls: ['wss://local-group-relay'],
        groupId: 'group-1',
        warmHydrateLocalGroupRelay: true,
        relayReadyForReq: true,
        relaySinceOverlapSeconds: 7
      })
    ).toEqual([
      {
        source: 'local',
        filter: {
          '#h': ['group-1']
        }
      },
      {
        source: 'relays',
        urls: ['wss://local-group-relay'],
        filter: {
          '#h': ['group-1']
        },
        warmHydrateFromLocalCache: true,
        relaySinceOverlapSeconds: 7
      }
    ])
  })
})
