import { BIG_RELAY_URLS } from '@/constants'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'

let pubkeyMock: string | null = 'reader-pubkey'
let followingsMock: string[] = ['followed-pubkey']

const fetchRelayListMock = vi.fn(async () => ({
  read: ['wss://reader-relay.example/'],
  write: [],
  originalRelays: []
}))

const articleListMock = vi.fn(
  ({ subRequests }: { subRequests: unknown[] }) => (
    <div data-testid="article-list" data-requests={JSON.stringify(subRequests)} />
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
      props: { subRequests: unknown[] },
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

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    pubkey: pubkeyMock,
    startLogin: vi.fn()
  })
}))

vi.mock('@/hooks', () => ({
  useFetchFollowings: () => ({
    followings: followingsMock,
    isFetching: false
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

function getRenderedSubRequests() {
  const raw = screen.getByTestId('article-list').getAttribute('data-requests')
  return raw ? JSON.parse(raw) : null
}

describe('ReadsPage feed mode toggle', () => {
  beforeEach(() => {
    pubkeyMock = 'reader-pubkey'
    followingsMock = ['followed-pubkey']
    fetchRelayListMock.mockClear()
    articleListMock.mockClear()
  })

  it('defaults to Discover and uses the public article feed', async () => {
    render(<ReadsPage />)

    await waitFor(() => {
      expect(getRenderedSubRequests()).toEqual([
        {
          source: 'relays',
          urls: BIG_RELAY_URLS,
          filter: {}
        }
      ])
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
      expect(getRenderedSubRequests()).toEqual([
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
