import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

const useFetchHtmlAnalysisMock = vi.fn()

vi.mock('@/hooks/useFetchHtmlAnalysis', () => ({
  useFetchHtmlAnalysis: (...args: unknown[]) => useFetchHtmlAnalysisMock(...args)
}))

vi.mock('@/services/electron-ipc.service', () => ({
  electronIpc: {
    isElectron: () => false
  }
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
})
