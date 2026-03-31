function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderPage(payload = {}, context = {}) {
  const pluginId = escapeHtml(context?.pluginId || 'unknown')
  const pluginVersion = escapeHtml(context?.pluginVersion || 'unknown')
  const routePath = escapeHtml(payload?.routePath || '/')
  const routeId = escapeHtml(payload?.routeId || 'route')
  const renderedAt = new Date().toISOString()

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello Plugin</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #e9f7ff, #f8fbff 38%, #f2f3f8 100%);
        color: #10203b;
      }
      .wrap {
        max-width: 760px;
        margin: 36px auto;
        padding: 20px;
      }
      .card {
        border-radius: 16px;
        border: 1px solid #d0d8e8;
        background: #ffffffdd;
        padding: 22px;
        box-shadow: 0 10px 32px #2f4f8712;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      p {
        margin: 0 0 14px;
        color: #344763;
      }
      code {
        font-family: "Iosevka", "SFMono-Regular", Consolas, monospace;
        background: #edf2fd;
        border-radius: 7px;
        padding: 2px 6px;
      }
      ul {
        margin: 14px 0 0;
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <h1>Hello from First-Party Plugin</h1>
        <p>This plugin demonstrates additive nav + route registration through the v1 plugin framework.</p>
        <ul>
          <li><strong>Plugin:</strong> <code>${pluginId}</code> (v${pluginVersion})</li>
          <li><strong>Route:</strong> <code>${routePath}</code></li>
          <li><strong>Route ID:</strong> <code>${routeId}</code></li>
          <li><strong>Rendered:</strong> <code>${escapeHtml(renderedAt)}</code></li>
        </ul>
      </section>
    </main>
  </body>
</html>`
}

export async function handleInvoke(payload = {}, context = {}) {
  if (payload?.type === 'render-route') {
    return {
      html: renderPage(payload, context)
    }
  }
  return {
    ok: true,
    pluginId: context?.pluginId || null,
    pluginVersion: context?.pluginVersion || null,
    payload
  }
}

export async function activate(context = {}) {
  context?.emit?.('hello-nav-page-activated', {
    pluginId: context?.pluginId || null,
    pluginVersion: context?.pluginVersion || null
  })
}
