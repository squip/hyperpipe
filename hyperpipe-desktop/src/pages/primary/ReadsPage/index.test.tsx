import { BIG_RELAY_URLS } from '@/constants'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'

let pubkeyMock: string | null = 'reader-pubkey'
let followingsMock: string[] = ['followed-pubkey']
let listsMock: Array<{
  id: string
  title: string
  description?: string
  pubkeys: string[]
  event: { pubkey: string }
}> = []

const timeFrameOptionsMock = Array.from({ length: 24 }, (_, index) => ({
  label: `${index + 1} hours`,
  value: index + 1,
  unit: 'hours' as const
}))

let sharedFilterSettingsMock = {
  recencyEnabled: true,
  timeFrame: timeFrameOptionsMock[23],
  maxItemsPerAuthor: 0,
  mutedWords: '',
  selectedRelayIdentities: [] as string[],
  selectedListKeys: [] as string[]
}
let hasSavedSettingsMock = false

const setSharedFilterSettingsMock = vi.fn()
const resetSharedFilterSettingsMock = vi.fn()

const fetchRelayListMock = vi.fn(async () => ({
  read: ['wss://reader-relay.example/'],
  write: [],
  originalRelays: []
}))

const articleListMock = vi.fn(
  ({
    subRequests,
    sinceTimestamp,
    mutedWords,
    maxItemsPerAuthor
  }: {
    subRequests: unknown[]
    sinceTimestamp?: number
    mutedWords?: string
    maxItemsPerAuthor?: number
  }) => (
    <div
      data-testid="article-list"
      data-props={JSON.stringify({
        subRequests,
        sinceTimestamp,
        mutedWords,
        maxItemsPerAuthor
      })}
    />
  )
)

vi.mock('@/layouts/PrimaryPageLayout', () => ({
  default: React.forwardRef(
    (
      {
        children,
        titlebar
      }: {
        children: React.ReactNode
        titlebar: React.ReactNode
      },
      _ref: React.ForwardedRef<unknown>
    ) => (
      <div>
        <div>{titlebar}</div>
        <div>{children}</div>
      </div>
    )
  )
}))

vi.mock('@/components/ArticleList', () => ({
  default: React.forwardRef(
    (
      props: {
        subRequests: unknown[]
        sinceTimestamp?: number
        mutedWords?: string
        maxItemsPerAuthor?: number
      },
      _ref: React.ForwardedRef<unknown>
    ) => articleListMock(props)
  )
}))

vi.mock('@/components/Tabs', () => ({
  __esModule: true,
  default: ({
    tabs,
    value,
    onTabChange
  }: {
    tabs: { value: string; label: string }[]
    value: string
    onTabChange?: (value: string) => void
  }) => (
    <div data-testid="reads-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          data-active={String(value === tab.value)}
          onClick={() => onTabChange?.(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}))

vi.mock('@/components/RefreshButton', () => ({
  RefreshButton: ({ onClick }: { onClick?: () => void }) => (
    <button onClick={onClick} type="button">
      refresh
    </button>
  )
}))

vi.mock('@/components/SharedFeedFilterMenu', () => ({
  default: () => <div data-testid="shared-feed-filter-menu" />
}))

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    pubkey: pubkeyMock,
    startLogin: vi.fn()
  })
}))

vi.mock('@/providers/ListsProvider', () => ({
  useLists: () => ({
    lists: listsMock
  })
}))

vi.mock('@/hooks', () => ({
  useFetchFollowings: () => ({
    followings: followingsMock,
    isFetching: false
  })
}))

vi.mock('@/hooks/useSharedFeedFilterSettings', () => ({
  default: () => ({
    settings: sharedFilterSettingsMock,
    setSettings: setSharedFilterSettingsMock,
    resetSettings: resetSharedFilterSettingsMock,
    timeFrameOptions: timeFrameOptionsMock,
    hasSavedSettings: hasSavedSettingsMock
  })
}))

vi.mock('@/services/client.service', () => ({
  default: {
    fetchRelayList: (...args: unknown[]) => fetchRelayListMock(...args)
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTouchDevice: () => false
  }
})

import ReadsPage from '@/pages/primary/ReadsPage'

function getRenderedArticleListProps() {
  const raw = screen.getByTestId('article-list').getAttribute('data-props')
  return raw ? JSON.parse(raw) : null
}

describe('ReadsPage shared feed filters', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-25T12:00:00Z').getTime())

    pubkeyMock = 'reader-pubkey'
    followingsMock = ['followed-pubkey']
    listsMock = []
    hasSavedSettingsMock = false
    sharedFilterSettingsMock = {
      recencyEnabled: true,
      timeFrame: timeFrameOptionsMock[23],
      maxItemsPerAuthor: 0,
      mutedWords: '',
      selectedRelayIdentities: [],
      selectedListKeys: []
    }
    fetchRelayListMock.mockClear()
    articleListMock.mockClear()
    setSharedFilterSettingsMock.mockClear()
    resetSharedFilterSettingsMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to Discover, uses the public article feed, and applies a 24 hour recency filter', async () => {
    render(<ReadsPage />)

    await waitFor(() => {
      expect(getRenderedArticleListProps()).toEqual({
        subRequests: [
          {
            source: 'relays',
            urls: BIG_RELAY_URLS,
            filter: {}
          }
        ],
        sinceTimestamp: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000),
        mutedWords: '',
        maxItemsPerAuthor: 0
      })
    })

    expect(fetchRelayListMock).not.toHaveBeenCalled()
    expect(screen.getByText('Discover')).toBeInTheDocument()
    expect(screen.getByText('Following')).toBeInTheDocument()
  })

  it('switches to Following and scopes the feed to followings on the reader relay set', async () => {
    render(<ReadsPage />)

    fireEvent.click(screen.getByText('Following'))

    await waitFor(() => {
      expect(fetchRelayListMock).toHaveBeenCalledWith('reader-pubkey')
    })

    await waitFor(() => {
      expect(getRenderedArticleListProps()?.subRequests).toEqual([
        {
          source: 'relays',
          urls: ['wss://reader-relay.example/', ...BIG_RELAY_URLS].slice(0, 8),
          filter: {
            authors: ['followed-pubkey']
          }
        }
      ])
    })
  })

  it('intersects following authors with the selected personal list author set', async () => {
    followingsMock = ['followed-pubkey', 'another-followed-pubkey']
    listsMock = [
      {
        id: 'trusted-authors',
        title: 'Trusted Authors',
        pubkeys: ['followed-pubkey', 'outside-followings'],
        event: { pubkey: 'reader-pubkey' }
      }
    ]
    hasSavedSettingsMock = false
    sharedFilterSettingsMock = {
      recencyEnabled: true,
      timeFrame: timeFrameOptionsMock[23],
      maxItemsPerAuthor: 0,
      mutedWords: '',
      selectedRelayIdentities: [],
      selectedListKeys: ['reader-pubkey:trusted-authors']
    }

    render(<ReadsPage />)

    fireEvent.click(screen.getByText('Following'))

    await waitFor(() => {
      expect(getRenderedArticleListProps()?.subRequests).toEqual([
        {
          source: 'relays',
          urls: ['wss://reader-relay.example/', ...BIG_RELAY_URLS].slice(0, 8),
          filter: {
            authors: ['followed-pubkey']
          }
        }
      ])
    })
  })
})
