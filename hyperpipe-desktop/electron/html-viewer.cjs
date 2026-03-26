function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isAllowedHtmlViewerUrl(candidate) {
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function createHtmlViewerPartition() {
  return `hyperpipe-html-viewer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildHtmlViewerWindowOptions(partition) {
  return {
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  }
}

function buildHtmlSourceViewerWindowOptions() {
  return {
    width: 1100,
    height: 820,
    minWidth: 680,
    minHeight: 420,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      javascript: false
    }
  }
}

function buildHtmlSourceViewerDocument({
  title = 'HTML Source',
  url = '',
  source = ''
} = {}) {
  const lines = String(source || '').split(/\r?\n/)
  const rows = lines
    .map(
      (line, index) => `
        <tr>
          <td class="line-number">${index + 1}</td>
          <td class="line-code">${escapeHtml(line) || '&nbsp;'}</td>
        </tr>`
    )
    .join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: #0b1020;
        color: #e5edf5;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 14px 18px;
        border-bottom: 1px solid rgba(229, 237, 245, 0.12);
        background: rgba(11, 16, 32, 0.97);
      }
      h1 {
        margin: 0;
        font-size: 16px;
      }
      .meta {
        margin-top: 4px;
        font-size: 12px;
        color: rgba(229, 237, 245, 0.66);
        overflow-wrap: anywhere;
      }
      .table-wrap {
        padding: 12px 0 24px;
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-family: SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
      }
      .line-number {
        width: 1%;
        min-width: 64px;
        padding: 0 14px 0 18px;
        text-align: right;
        vertical-align: top;
        user-select: none;
        color: rgba(229, 237, 245, 0.42);
        border-right: 1px solid rgba(229, 237, 245, 0.08);
      }
      .line-code {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 0 18px;
        color: #f8fafc;
      }
      tr + tr .line-number,
      tr + tr .line-code {
        padding-top: 2px;
      }
      .empty {
        padding: 18px;
        color: rgba(229, 237, 245, 0.66);
        font-family: SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(title)}</h1>
      ${url ? `<div class="meta">${escapeHtml(url)}</div>` : ''}
    </header>
    ${
      rows
        ? `<div class="table-wrap"><table aria-label="HTML source"><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">(empty file)</div>'
    }
  </body>
</html>`
}

module.exports = {
  buildHtmlSourceViewerDocument,
  buildHtmlSourceViewerWindowOptions,
  buildHtmlViewerWindowOptions,
  createHtmlViewerPartition,
  isAllowedHtmlViewerUrl
}
