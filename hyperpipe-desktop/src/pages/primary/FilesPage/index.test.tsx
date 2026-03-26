import { render, screen } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'

const timeFrameOptionsMock = Array.from({ length: 24 }, (_, index) => ({
  label: `${index + 1} hours`,
  value: index + 1,
  unit: 'hours' as const
}))

const groupFilesTableMock = vi.fn(
  ({ showDownloadAction }: { showDownloadAction?: boolean }) => (
    <div data-testid="group-files-table" data-show-download={String(Boolean(showDownloadAction))} />
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

vi.mock('@/components/GroupFilesTable', () => ({
  default: React.forwardRef((props: { showDownloadAction?: boolean }, _ref: React.ForwardedRef<unknown>) =>
    groupFilesTableMock(props)
  )
}))

vi.mock('@/components/SharedFeedFilterMenu', () => ({
  default: () => <div data-testid="shared-feed-filter-menu" />
}))

vi.mock('@/components/TitlebarInfoButton', () => ({
  default: ({ label, content }: { label: string; content: string }) => (
    <div data-testid="titlebar-info" data-label={label} data-content={content} />
  )
}))

vi.mock('@/providers/GroupFilesProvider', () => ({
  useGroupFiles: () => ({
    records: [],
    isLoading: false,
    refresh: vi.fn(async () => {}),
    lastUpdated: null
  })
}))

vi.mock('@/providers/ListsProvider', () => ({
  useLists: () => ({
    lists: []
  })
}))

vi.mock('@/providers/FollowListProvider', () => ({
  useFollowList: () => ({
    followings: []
  })
}))

vi.mock('@/providers/MuteListProvider', () => ({
  useMuteList: () => ({
    mutePubkeySet: new Set()
  })
}))

vi.mock('@/providers/GroupsProvider', () => ({
  useGroups: () => ({
    myGroupList: [],
    discoveryGroups: [],
    getProvisionalGroupMetadata: vi.fn(() => null),
    resolveRelayUrl: vi.fn((value: string) => value)
  })
}))

vi.mock('@/hooks/useSharedFeedFilterSettings', () => ({
  default: () => ({
    settings: {
      recencyEnabled: false,
      timeFrame: timeFrameOptionsMock[23],
      maxItemsPerAuthor: 0,
      mutedWords: '',
      selectedRelayIdentities: [],
      selectedListKeys: [],
      selectedLanguageCodes: [],
      selectedFileExtensions: [],
      customFileExtensions: []
    },
    setSettings: vi.fn(),
    resetSettings: vi.fn(),
    timeFrameOptions: timeFrameOptionsMock,
    hasSavedSettings: false
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

import FilesPage from '@/pages/primary/FilesPage'

describe('FilesPage titlebar and download wiring', () => {
  beforeEach(() => {
    groupFilesTableMock.mockClear()
  })

  it('passes the info copy and enables expanded-row downloads', () => {
    render(<FilesPage />)

    expect(screen.getByTestId('titlebar-info')).toHaveAttribute('data-label', 'Files info')
    expect(screen.getByTestId('titlebar-info')).toHaveAttribute(
      'data-content',
      'Search, sort, and manage your p2p file system across all your Hyperpipe group relays.'
    )
    expect(screen.getByTestId('group-files-table')).toHaveAttribute('data-show-download', 'true')
  })
})
