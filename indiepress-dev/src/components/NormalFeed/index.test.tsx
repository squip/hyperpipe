import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'

let groupedNotesEnabled = false
const searchPubKeysFromLocalMock = vi.fn(async () => [] as string[])
const noteListMock = vi.fn(
  ({ filterFn }: { filterFn?: (event: { pubkey: string }) => boolean }) => (
    <div data-has-filter={String(Boolean(filterFn))} data-testid="note-list" />
  )
)
const groupedNoteListMock = vi.fn(({ userFilter }: { userFilter?: string }) => (
  <div data-testid="grouped-note-list" data-user-filter={userFilter || ''} />
))

vi.mock('@/components/NoteList', () => ({
  default: React.forwardRef(
    (
      props: { filterFn?: (event: { pubkey: string }) => boolean },
      _ref: React.ForwardedRef<unknown>
    ) => noteListMock(props)
  )
}))

vi.mock('@/components/GroupedNoteList', () => ({
  default: React.forwardRef(
    (props: { userFilter?: string }, _ref: React.ForwardedRef<unknown>) =>
      groupedNoteListMock(props)
  )
}))

vi.mock('@/components/KindFilter', () => ({
  default: () => <div data-testid="kind-filter" />
}))

vi.mock('@/components/GroupedNotesFilter', () => ({
  default: () => <div data-testid="grouped-notes-filter" />
}))

vi.mock('@/components/RefreshButton', () => ({
  RefreshButton: ({ onClick }: { onClick?: () => void }) => (
    <button onClick={onClick} type="button">
      refresh
    </button>
  )
}))

vi.mock('@/providers/KindFilterProvider', () => ({
  useKindFilter: () => ({
    showKinds: [1]
  })
}))

vi.mock('@/providers/UserTrustProvider', () => ({
  useUserTrust: () => ({
    hideUntrustedNotes: false
  })
}))

vi.mock('@/providers/GroupedNotesProvider', () => ({
  useGroupedNotes: () => ({
    settings: {
      enabled: groupedNotesEnabled
    }
  })
}))

vi.mock('@/services/client.service', () => ({
  default: {
    searchPubKeysFromLocal: (...args: unknown[]) => searchPubKeysFromLocalMock(...args)
  }
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTouchDevice: () => false
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

import NormalFeed from '@/components/NormalFeed'

describe('NormalFeed toolbar behavior', () => {
  beforeEach(() => {
    groupedNotesEnabled = false
    searchPubKeysFromLocalMock.mockReset()
    searchPubKeysFromLocalMock.mockResolvedValue([])
    noteListMock.mockClear()
    groupedNoteListMock.mockClear()
  })

  it('keeps the search bar visible and wires it into NoteList when grouped notes are disabled', async () => {
    searchPubKeysFromLocalMock.mockResolvedValue(['alice-pubkey'])

    render(<NormalFeed subRequests={[]} />)

    const searchInput = screen.getByPlaceholderText('GroupedNotesFilter')
    expect(searchInput).toBeInTheDocument()
    expect(screen.getByTestId('note-list')).toHaveAttribute('data-has-filter', 'false')

    fireEvent.change(searchInput, { target: { value: 'alice' } })

    await waitFor(() => {
      expect(searchPubKeysFromLocalMock).toHaveBeenCalledWith('alice', 1000)
      expect(screen.getByTestId('note-list')).toHaveAttribute('data-has-filter', 'true')
    })
  })

  it('keeps the search bar visible and forwards the query to GroupedNoteList when grouped notes are enabled', async () => {
    groupedNotesEnabled = true

    render(<NormalFeed subRequests={[]} />)

    const searchInput = screen.getByPlaceholderText('GroupedNotesFilter')
    expect(searchInput).toBeInTheDocument()
    expect(screen.getByTestId('grouped-note-list')).toHaveAttribute('data-user-filter', '')

    fireEvent.change(searchInput, { target: { value: 'alice' } })

    await waitFor(() => {
      expect(screen.getByTestId('grouped-note-list')).toHaveAttribute('data-user-filter', 'alice')
    })
  })
})
