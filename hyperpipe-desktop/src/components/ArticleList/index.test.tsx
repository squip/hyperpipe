import { render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@nostr/tools/wasm'
import { vi } from 'vitest'

let subscribedEventsMock: Event[] = []
let mutePubkeySetMock = new Set<string>()

const subscribeTimelineMock = vi.fn(
  async (
    _subRequests: unknown,
    _filter: unknown,
    handlers: {
      onEvents: (events: Event[], isFinal: boolean) => void
      onNew: (event: Event) => void
    }
  ) => {
    handlers.onEvents(subscribedEventsMock, true)
    return { close: vi.fn() }
  }
)

const loadMoreTimelineMock = vi.fn(async () => [])

vi.mock('@/services/client.service', () => ({
  default: {
    subscribeTimeline: (...args: unknown[]) => subscribeTimelineMock(...args),
    loadMoreTimeline: (...args: unknown[]) => loadMoreTimelineMock(...args)
  }
}))

vi.mock('@/providers/MuteListProvider', () => ({
  useMuteList: () => ({
    mutePubkeySet: mutePubkeySetMock
  })
}))

vi.mock('@/providers/NostrProvider', () => ({
  useNostr: () => ({
    startLogin: vi.fn()
  })
}))

vi.mock('@/components/ArticleCard', () => ({
  default: ({ event }: { event: Event }) => {
    const title = event.tags.find((tag) => tag[0] === 'title')?.[1] || event.id
    return <div data-testid="article-card">{`${title}|${event.pubkey}`}</div>
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

import ArticleList from '@/components/ArticleList'

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createArticleEvent(args: {
  id: string
  pubkey: string
  title: string
  summary?: string
  content?: string
  hashtags?: string[]
  createdAt?: number
  publishedAt?: number
}): Event {
  const tags = [
    ['title', args.title],
    ['summary', args.summary || ''],
    ...(args.publishedAt ? [['published_at', String(args.publishedAt)]] : []),
    ...((args.hashtags || []).map((tag) => ['t', tag]))
  ]

  return {
    id: args.id,
    pubkey: args.pubkey,
    kind: 30023,
    created_at: args.createdAt || 1_700_000_000,
    tags,
    content: args.content || '',
    sig: 'sig'
  } as unknown as Event
}

describe('ArticleList shared feed filtering', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      value: IntersectionObserverMock
    })
  })

  beforeEach(() => {
    subscribedEventsMock = []
    mutePubkeySetMock = new Set()
    subscribeTimelineMock.mockClear()
    loadMoreTimelineMock.mockClear()
  })

  it('filters out muted authors', async () => {
    mutePubkeySetMock = new Set(['muted-author'])
    subscribedEventsMock = [
      createArticleEvent({
        id: 'article-1',
        pubkey: 'muted-author',
        title: 'Muted article'
      }),
      createArticleEvent({
        id: 'article-2',
        pubkey: 'allowed-author',
        title: 'Allowed article'
      })
    ]

    render(<ArticleList subRequests={[{ source: 'relays', urls: ['wss://relay.test'], filter: {} }]} />)

    await waitFor(() => {
      expect(screen.getByText('Allowed article|allowed-author')).toBeInTheDocument()
    })

    expect(screen.queryByText('Muted article|muted-author')).not.toBeInTheDocument()
  })

  it('filters out articles that match the muted word list', async () => {
    subscribedEventsMock = [
      createArticleEvent({
        id: 'article-1',
        pubkey: 'author-1',
        title: 'Spam article'
      }),
      createArticleEvent({
        id: 'article-2',
        pubkey: 'author-2',
        title: 'Clean article',
        summary: 'Nothing to filter'
      })
    ]

    render(
      <ArticleList
        subRequests={[{ source: 'relays', urls: ['wss://relay.test'], filter: {} }]}
        mutedWords="spam"
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Clean article|author-2')).toBeInTheDocument()
    })

    expect(screen.queryByText('Spam article|author-1')).not.toBeInTheDocument()
  })

  it('filters out authors who exceed the max items per author threshold', async () => {
    subscribedEventsMock = [
      createArticleEvent({
        id: 'article-1',
        pubkey: 'busy-author',
        title: 'Busy article one',
        publishedAt: 1_700_000_100
      }),
      createArticleEvent({
        id: 'article-2',
        pubkey: 'busy-author',
        title: 'Busy article two',
        publishedAt: 1_700_000_050
      }),
      createArticleEvent({
        id: 'article-3',
        pubkey: 'steady-author',
        title: 'Steady article',
        publishedAt: 1_700_000_025
      })
    ]

    render(
      <ArticleList
        subRequests={[{ source: 'relays', urls: ['wss://relay.test'], filter: {} }]}
        maxItemsPerAuthor={1}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Steady article|steady-author')).toBeInTheDocument()
    })

    expect(screen.queryByText('Busy article one|busy-author')).not.toBeInTheDocument()
    expect(screen.queryByText('Busy article two|busy-author')).not.toBeInTheDocument()
  })

  it('filters articles by detected language when language codes are selected', async () => {
    subscribedEventsMock = [
      createArticleEvent({
        id: 'article-1',
        pubkey: 'author-en',
        title: 'English article',
        content: 'This article is written in English and should be filtered out.'
      }),
      createArticleEvent({
        id: 'article-2',
        pubkey: 'author-ja',
        title: 'Japanese article',
        content: 'これは日本語で書かれた記事です。'
      })
    ]

    render(
      <ArticleList
        subRequests={[{ source: 'relays', urls: ['wss://relay.test'], filter: {} }]}
        selectedLanguageCodes={['ja']}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Japanese article|author-ja')).toBeInTheDocument()
    })

    expect(screen.queryByText('English article|author-en')).not.toBeInTheDocument()
  })
})
