import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

const useFetchHtmlAnalysisMock = vi.fn()
const openHtmlSourceViewerMock = vi.fn(async () => ({ success: true }))
let isElectronMock = false

vi.mock('@/hooks/useFetchHtmlAnalysis', () => ({
  useFetchHtmlAnalysis: (...args: unknown[]) => useFetchHtmlAnalysisMock(...args)
}))

vi.mock('@/services/electron-ipc.service', () => ({
  electronIpc: {
    isElectron: () => isElectronMock,
    openHtmlSourceViewer: (...args: unknown[]) => openHtmlSourceViewerMock(...args)
  }
}))

vi.mock('@/providers/GroupsProvider', () => ({
  useGroups: () => ({
    resolveRelayUrl: (value?: string) => value
  })
}))

import FileMetadataNote from '@/components/Note/FileMetadata'

function createFileEvent(tags: string[][]) {
  return {
    kind: 1063,
    tags,
    content: 'index.html'
  } as any
}

describe('FileMetadataNote HTML preview', () => {
  beforeEach(() => {
    isElectronMock = false
    openHtmlSourceViewerMock.mockClear()
    useFetchHtmlAnalysisMock.mockReset()
    useFetchHtmlAnalysisMock.mockReturnValue({
      title: null,
      description: null,
      image: null,
      htmlSource: '<html></html>',
      declaredExternalOrigins: [],
      hasMetaPreview: false,
      isLoading: false
    })
  })

  it('renders HTML metadata preview actions when meta tags are available', () => {
    useFetchHtmlAnalysisMock.mockReturnValue({
      title: 'Demo page',
      description: 'An HTML preview description',
      image: 'https://example.com/preview.png',
      htmlSource: '<html></html>',
      declaredExternalOrigins: ['https://cdn.example.com'],
      hasMetaPreview: true,
      isLoading: false
    })

    render(
      <FileMetadataNote
        event={createFileEvent([
          ['url', 'http://localhost:5500/drive/group/index.html'],
          ['m', 'text/html'],
          ['alt', 'index.html']
        ])}
      />
    )

    expect(screen.getByText('Demo page')).toBeInTheDocument()
    expect(screen.getByText('An HTML preview description')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /view code/i })).toBeInTheDocument()
  })

  it('renders a generic HTML fallback preview when metadata is unavailable', () => {
    render(
      <FileMetadataNote
        event={createFileEvent([
          ['url', 'http://localhost:5500/drive/group/index.html'],
          ['m', 'text/html'],
          ['alt', 'index.html']
        ])}
      />
    )

    expect(screen.getByText('HTML Preview')).toBeInTheDocument()
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /view code/i })).toBeInTheDocument()
  })

  it('keeps non-HTML files on the existing media layout', () => {
    render(
      <FileMetadataNote
        event={createFileEvent([
          ['url', 'http://localhost:5500/drive/group/photo.png'],
          ['m', 'image/png'],
          ['alt', 'photo.png']
        ])}
      />
    )

    expect(screen.queryByRole('button', { name: /view code/i })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /photo\.png/i })).toBeInTheDocument()
  })

  it('delegates source loading to Electron when renderer analysis has no source body', async () => {
    isElectronMock = true
    useFetchHtmlAnalysisMock.mockReturnValue({
      title: 'Demo page',
      description: 'An HTML preview description',
      image: null,
      htmlSource: undefined,
      declaredExternalOrigins: [],
      hasMetaPreview: true,
      isLoading: false
    })

    render(
      <FileMetadataNote
        event={createFileEvent([
          ['url', 'https://gateway.hyperpipe.example/drive/group/index.html'],
          ['m', 'text/html'],
          ['alt', 'index.html']
        ])}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /view code/i }))

    await waitFor(() => {
      expect(openHtmlSourceViewerMock).toHaveBeenCalledWith({
        title: 'Demo page',
        source: undefined,
        url: 'https://gateway.hyperpipe.example/drive/group/index.html'
      })
    })
  })
})
