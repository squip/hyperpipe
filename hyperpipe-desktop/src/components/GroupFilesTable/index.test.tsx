import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/components/Username', () => ({
  default: ({ userId }: { userId: string }) => <div>{userId}</div>
}))

vi.mock('@/components/Note/FileMetadata', () => ({
  default: () => <div data-testid="file-metadata-note">metadata</div>
}))

vi.mock('@/services/electron-ipc.service', () => ({
  electronIpc: {
    isElectron: () => true,
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/tmp/file.txt' })),
    sendToWorkerAwait: vi.fn(async () => ({ success: true, data: { savedPath: '/tmp/file.txt' } }))
  }
}))

import GroupFilesTable from '@/components/GroupFilesTable'

const baseRecord = {
  eventId: 'event-1',
  event: {
    kind: 1063,
    tags: [
      ['url', 'http://localhost:5500/drive/group/file.txt'],
      ['m', 'text/plain']
    ],
    content: 'file.txt'
  } as any,
  url: 'http://localhost:5500/drive/group/file.txt',
  groupId: 'npubdemo:group-a',
  groupRelay: 'ws://localhost:5500/group-a',
  groupName: 'Group A',
  fileName: 'file.txt',
  mime: 'text/plain',
  size: 123,
  uploadedAt: 1_700_000_000,
  uploadedBy: 'alice',
  sha256: 'a'.repeat(64),
  dim: null,
  alt: null,
  summary: null
}

describe('GroupFilesTable expanded actions', () => {
  it('shows the Download button only when explicitly enabled', () => {
    const { rerender } = render(<GroupFilesTable records={[baseRecord]} showDownloadAction={false} />)

    fireEvent.click(screen.getAllByText('file.txt')[0].closest('button') as HTMLButtonElement)
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument()

    rerender(<GroupFilesTable records={[baseRecord]} showDownloadAction />)
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
  })
})
