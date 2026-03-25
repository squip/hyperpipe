import { StorageKey } from '@/constants'
import storage from '@/services/local-storage.service'

describe('local storage feed selection persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    storage.init()
  })

  it('uses the hyperpipe appearance defaults when no overrides are stored', () => {
    expect(storage.getThemeSetting()).toBe('pure-black')
    expect(storage.getPrimaryColor()).toBe('EMERALD')
    expect(storage.getEnableSingleColumnLayout()).toBe(false)
    expect(storage.getDesktopPrimaryColumnWidth()).toBeCloseTo((1067 / (1067 + 586)) * 100, 5)
  })

  it('persists local group relay selections by stable group id instead of localhost url', () => {
    storage.setFeedInfo(
      {
        feedType: 'relay',
        id: 'ws://127.0.0.1:61120/npub1exampleowner/example-group?token=abc123',
        localGroupRelay: {
          groupId: 'npub1exampleowner:example-group',
          relayIdentity: 'ignored-for-persistence'
        }
      },
      'user-1'
    )

    expect(storage.getFeedInfo('user-1')).toEqual({
      feedType: 'relay',
      localGroupRelay: {
        groupId: 'npub1exampleowner:example-group',
        relayIdentity: 'ignored-for-persistence'
      }
    })

    expect(JSON.parse(window.localStorage.getItem(StorageKey.ACCOUNT_FEED_INFO_MAP) || '{}')).toEqual({
      'user-1': {
        feedType: 'relay',
        localGroupRelay: {
          groupId: 'npub1exampleowner:example-group',
          relayIdentity: 'ignored-for-persistence'
        }
      }
    })
  })

  it('migrates legacy localhost relay feed selections into stable local group selections', () => {
    window.localStorage.setItem(
      StorageKey.ACCOUNT_FEED_INFO_MAP,
      JSON.stringify({
        'user-2': {
          feedType: 'relay',
          id: 'ws://127.0.0.1:61120/npub1legacyowner/legacy-group?token=legacytoken'
        }
      })
    )
    storage.init()

    expect(storage.getFeedInfo('user-2')).toEqual({
      feedType: 'relay',
      localGroupRelay: {
        groupId: 'npub1legacyowner:legacy-group'
      }
    })

    expect(JSON.parse(window.localStorage.getItem(StorageKey.ACCOUNT_FEED_INFO_MAP) || '{}')).toEqual({
      'user-2': {
        feedType: 'relay',
        localGroupRelay: {
          groupId: 'npub1legacyowner:legacy-group'
        }
      }
    })
  })

  it('persists shared feed filter settings per account and page', () => {
    storage.setSharedFeedFilterSettings('user-3', 'reads', {
      recencyEnabled: true,
      timeFrame: { value: 24, unit: 'hours' },
      maxItemsPerAuthor: 3,
      mutedWords: 'spam, ads',
      selectedRelayIdentities: ['relay-a', 'relay-b'],
      selectedListKeys: ['user-3:trusted-authors']
    })

    expect(storage.getSharedFeedFilterSettings('user-3', 'reads')).toEqual({
      recencyEnabled: true,
      timeFrame: { value: 24, unit: 'hours' },
      maxItemsPerAuthor: 3,
      mutedWords: 'spam, ads',
      selectedRelayIdentities: ['relay-a', 'relay-b'],
      selectedListKeys: ['user-3:trusted-authors']
    })

    storage.init()

    expect(storage.getSharedFeedFilterSettings('user-3', 'reads')).toEqual({
      recencyEnabled: true,
      timeFrame: { value: 24, unit: 'hours' },
      maxItemsPerAuthor: 3,
      mutedWords: 'spam, ads',
      selectedRelayIdentities: ['relay-a', 'relay-b'],
      selectedListKeys: ['user-3:trusted-authors']
    })
  })

  it('persists and de-duplicates the per-account mute list cache', () => {
    storage.setMuteListCache('user-4', {
      public: ['pub-a', 'pub-a', 'pub-b'],
      private: ['pub-c', 'pub-c']
    })

    expect(storage.getMuteListCache('user-4')).toEqual({
      public: ['pub-a', 'pub-b'],
      private: ['pub-c']
    })

    storage.init()

    expect(storage.getMuteListCache('user-4')).toEqual({
      public: ['pub-a', 'pub-b'],
      private: ['pub-c']
    })
  })
})
