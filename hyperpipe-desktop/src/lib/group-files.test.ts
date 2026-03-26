import {
  getGroupFileExtensionLabel,
  isGroupFileHtml,
  normalizeGroupFileExtension,
  resolveGroupFileExtension
} from '@/lib/group-files'

describe('group file extension helpers', () => {
  it('normalizes extensions from user input', () => {
    expect(normalizeGroupFileExtension('.PDF')).toBe('pdf')
    expect(normalizeGroupFileExtension(' unknown ')).toBe('unknown')
    expect(normalizeGroupFileExtension('not/an-extension')).toBe(null)
  })

  it('resolves file extensions from file name, url, mime type, and unknown fallback', () => {
    expect(
      resolveGroupFileExtension({
        fileName: 'report.final.PDF',
        url: 'https://example.com/download',
        mime: null
      })
    ).toBe('pdf')

    expect(
      resolveGroupFileExtension({
        fileName: 'download',
        url: 'https://example.com/path/archive.tar.gz?download=1',
        mime: null
      })
    ).toBe('gz')

    expect(
      resolveGroupFileExtension({
        fileName: 'readme',
        url: 'https://example.com/content',
        mime: 'text/markdown'
      })
    ).toBe('md')

    expect(
      resolveGroupFileExtension({
        fileName: 'untitled',
        url: 'https://example.com/content',
        mime: null
      })
    ).toBe('unknown')
  })

  it('formats extension labels for display', () => {
    expect(getGroupFileExtensionLabel('pdf')).toBe('.pdf')
    expect(getGroupFileExtensionLabel('unknown')).toBe('Unknown')
  })

  it('detects HTML files from mime type or extension', () => {
    expect(
      isGroupFileHtml({
        fileName: 'landing-page',
        url: 'https://example.com/page',
        mime: 'text/html'
      })
    ).toBe(true)

    expect(
      isGroupFileHtml({
        fileName: 'landing-page.html',
        url: 'https://example.com/page',
        mime: null
      })
    ).toBe(true)

    expect(
      isGroupFileHtml({
        fileName: 'image.png',
        url: 'https://example.com/image.png',
        mime: 'image/png'
      })
    ).toBe(false)
  })
})
