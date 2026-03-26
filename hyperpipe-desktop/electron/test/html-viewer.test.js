import test from 'brittle'

import {
  buildHtmlSourceViewerDocument,
  buildHtmlSourceViewerWindowOptions,
  buildHtmlViewerWindowOptions,
  createHtmlViewerPartition,
  isAllowedHtmlViewerUrl
} from '../html-viewer.cjs'

test('buildHtmlViewerWindowOptions keeps strict renderer security enabled', async (t) => {
  const partition = createHtmlViewerPartition()
  const options = buildHtmlViewerWindowOptions(partition)

  t.ok(options.webPreferences)
  t.is(options.webPreferences.partition, partition)
  t.is(options.webPreferences.nodeIntegration, false)
  t.is(options.webPreferences.contextIsolation, true)
  t.is(options.webPreferences.sandbox, true)
  t.is(options.webPreferences.webSecurity, true)
  t.is(options.webPreferences.allowRunningInsecureContent, false)
})

test('HTML viewer URL allowlist only permits https or localhost http', async (t) => {
  t.is(isAllowedHtmlViewerUrl('https://example.com/index.html'), true)
  t.is(isAllowedHtmlViewerUrl('http://localhost:5500/drive/group/index.html'), true)
  t.is(isAllowedHtmlViewerUrl('http://example.com/index.html'), false)
  t.is(isAllowedHtmlViewerUrl('javascript:alert(1)'), false)
})

test('buildHtmlSourceViewerDocument escapes HTML source and includes line numbers', async (t) => {
  const documentHtml = buildHtmlSourceViewerDocument({
    title: 'Example',
    url: 'http://localhost:5500/drive/group/index.html',
    source: '<script>alert(1)</script>\n<body>Hello</body>'
  })
  const options = buildHtmlSourceViewerWindowOptions()

  t.ok(documentHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  t.ok(documentHtml.includes('line-number'))
  t.ok(documentHtml.includes('http://localhost:5500/drive/group/index.html'))
  t.is(options.webPreferences.javascript, false)
  t.is(options.webPreferences.sandbox, true)
  t.is(options.webPreferences.webSecurity, true)
})
