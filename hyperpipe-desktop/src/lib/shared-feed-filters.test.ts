import { getRelayIdentity } from '@/lib/relay-targets'
import {
  buildSharedFeedRelayOptions,
  FOLLOWING_FEED_FILTER_KEY,
  prependFollowingListOption
} from '@/lib/shared-feed-filters'

describe('shared feed filter helpers', () => {
  it('builds a unified relay option list with group metadata and custom relay markers', () => {
    const groupRelayUrl = 'ws://127.0.0.1:61120/example-group?token=abc123'
    const groupRelayIdentity = getRelayIdentity(groupRelayUrl)
    if (!groupRelayIdentity) {
      throw new Error('expected group relay identity')
    }

    const relayOptions = buildSharedFeedRelayOptions({
      discoveryRelayUrls: ['wss://relay.one/', 'wss://relay.two/'],
      groupRelayTargets: [
        {
          groupId: 'example-group',
          relayUrl: groupRelayUrl,
          relayIdentity: groupRelayIdentity,
          label: 'Example Group',
          imageUrl: null
        }
      ],
      customRelayUrls: ['wss://custom-relay.example/'],
      extraRelayUrls: ['wss://reader-relay.example/', 'wss://relay.one/']
    })

    expect(relayOptions.map((option) => option.relayUrl)).toEqual([
      'wss://relay.one/',
      'wss://relay.two/',
      groupRelayUrl,
      'wss://custom-relay.example/',
      'wss://reader-relay.example/'
    ])

    expect(
      relayOptions.find((option) => option.relayIdentity === groupRelayIdentity)
    ).toMatchObject({
      label: 'Example Group',
      hideUrl: true
    })

    expect(
      relayOptions.find((option) => option.relayUrl === 'wss://custom-relay.example/')
    ).toMatchObject({
      isCustom: true
    })
  })

  it('prepends the Following synthetic list option and de-duplicates followed authors', () => {
    const listOptions = prependFollowingListOption(
      [
        {
          key: 'reader:trusted',
          label: 'Trusted',
          authorPubkeys: ['pub-a'],
          description: 'Trusted authors'
        }
      ],
      {
        followings: ['pub-a', 'pub-b', 'pub-b'],
        includeFollowing: true,
        label: 'Following',
        description: 'From people you follow'
      }
    )

    expect(listOptions[0]).toEqual({
      key: FOLLOWING_FEED_FILTER_KEY,
      label: 'Following',
      description: 'From people you follow',
      authorPubkeys: ['pub-a', 'pub-b']
    })
    expect(listOptions[1]?.key).toBe('reader:trusted')
  })
})
