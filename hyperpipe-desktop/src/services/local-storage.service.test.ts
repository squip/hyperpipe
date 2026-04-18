import {
  DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT,
  LEGACY_DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT,
  StorageKey
} from '@/constants'
import storage from '@/services/local-storage.service'

describe('local storage feed selection persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    storage.init()
  })

  it('uses the hyperpipe appearance defaults when no overrides are stored', () => {
    expect(storage.getThemeSetting()).toBe('pure-black')
    expect(storage.getPrimaryColor()).toBe('CYAN')
    expect(storage.getEnableSingleColumnLayout()).toBe(false)
    expect(storage.getDesktopPrimaryColumnWidth()).toBeCloseTo(
      DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT,
      5
    )
  })

  it('migrates untouched desktop split widths from the legacy default to the new default', () => {
    window.localStorage.setItem(
      StorageKey.DESKTOP_PRIMARY_COLUMN_WIDTH,
      LEGACY_DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT.toString()
    )

    storage.init()

    expect(storage.getDesktopPrimaryColumnWidth()).toBeCloseTo(
      DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT,
      5
    )
    expect(
      Number(window.localStorage.getItem(StorageKey.DESKTOP_PRIMARY_COLUMN_WIDTH))
    ).toBeCloseTo(DEFAULT_DESKTOP_PRIMARY_COLUMN_WIDTH_PERCENT, 5)
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
      selectedListKeys: ['user-3:trusted-authors'],
      selectedLanguageCodes: ['en'],
      selectedFileExtensions: ['pdf'],
      customFileExtensions: ['heic']
    })

    expect(storage.getSharedFeedFilterSettings('user-3', 'reads')).toEqual({
      recencyEnabled: true,
      timeFrame: { value: 24, unit: 'hours' },
      maxItemsPerAuthor: 3,
      mutedWords: 'spam, ads',
      selectedRelayIdentities: ['relay-a', 'relay-b'],
      selectedListKeys: ['user-3:trusted-authors'],
      selectedLanguageCodes: ['en'],
      selectedFileExtensions: ['pdf'],
      customFileExtensions: ['heic']
    })

    storage.init()

    expect(storage.getSharedFeedFilterSettings('user-3', 'reads')).toEqual({
      recencyEnabled: true,
      timeFrame: { value: 24, unit: 'hours' },
      maxItemsPerAuthor: 3,
      mutedWords: 'spam, ads',
      selectedRelayIdentities: ['relay-a', 'relay-b'],
      selectedListKeys: ['user-3:trusted-authors'],
      selectedLanguageCodes: ['en'],
      selectedFileExtensions: ['pdf'],
      customFileExtensions: ['heic']
    })
  })

  it('persists shared custom relay urls per account', () => {
    storage.setSharedFeedFilterCustomRelayUrls('user-5', [
      'wss://custom-one.example',
      'wss://custom-two.example'
    ])

    expect(storage.getSharedFeedFilterCustomRelayUrls('user-5')).toEqual([
      'wss://custom-one.example',
      'wss://custom-two.example'
    ])

    storage.init()

    expect(storage.getSharedFeedFilterCustomRelayUrls('user-5')).toEqual([
      'wss://custom-one.example',
      'wss://custom-two.example'
    ])
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
