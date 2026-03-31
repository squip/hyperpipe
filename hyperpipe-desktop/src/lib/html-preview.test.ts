import { parseHtmlDocumentAnalysis } from '@/lib/html-preview'

describe('parseHtmlDocumentAnalysis', () => {
  it('extracts metadata and external origins from HTML source', () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="Hyperpipe Demo" />
          <meta property="og:description" content="Preview description" />
          <meta property="og:image" content="/preview.png" />
          <script src="https://cdn.example.com/app.js"></script>
          <link rel="stylesheet" href="https://static.example.com/site.css" />
          <img src="https://images.example.net/card.png" />
          <script src="/same-origin.js"></script>
        </head>
      </html>`

    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const analysis = parseHtmlDocumentAnalysis(html, doc, 'http://localhost:5500/drive/group/page.html')

    expect(analysis.title).toBe('Hyperpipe Demo')
    expect(analysis.description).toBe('Preview description')
    expect(analysis.image).toBe('http://localhost:5500/preview.png')
    expect(analysis.hasMetaPreview).toBe(true)
    expect(analysis.declaredExternalOrigins).toEqual([
      'https://cdn.example.com',
      'https://images.example.net',
      'https://static.example.com'
    ])
  })

  it('falls back cleanly when metadata is absent', () => {
    const html = '<html><body><h1>Hello</h1></body></html>'
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const analysis = parseHtmlDocumentAnalysis(html, doc, 'http://localhost:5500/drive/group/page.html')

    expect(analysis.title).toBe(null)
    expect(analysis.description).toBe(null)
    expect(analysis.image).toBe(null)
    expect(analysis.hasMetaPreview).toBe(false)
    expect(analysis.declaredExternalOrigins).toEqual([])
    expect(analysis.htmlSource).toBe(html)
  })
})
