import test from 'brittle'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { PluginSupervisor } from '../plugin-supervisor.cjs'

const execFileAsync = promisify(execFile)

const QUIET_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {}
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function packReferencePlugin({
  cliPath,
  pluginDir,
  pluginId,
  version,
  outputDir
}) {
  await fs.mkdir(outputDir, { recursive: true })
  const archivePath = path.join(outputDir, `${pluginId}-${version}.htplugin.tgz`)
  const result = await execFileAsync(
    process.execPath,
    [cliPath, 'pack', pluginDir, '--output', archivePath, '--json'],
    {
      cwd: pluginDir,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024
    }
  )
  let parsed = null
  try {
    parsed = JSON.parse(String(result?.stdout || '{}'))
  } catch (_) {
    parsed = null
  }
  const archiveStats = await fs.stat(archivePath)
  return {
    archivePath,
    archiveMeta: asObject(parsed?.archive) || null,
    sizeBytes: archiveStats.size
  }
}

function assertCapabilityMarkers(t, pluginId, html) {
  if (pluginId === 'com.hypertuna.reference.hello-nav-page') {
    t.ok(html.includes('Hello from First-Party Plugin'))
    return
  }
  if (pluginId === 'com.hypertuna.reference.p2p-audio-room') {
    t.ok(html.includes('P2P Audio/Video Room'))
    t.ok(html.includes('media-create-session'))
    return
  }
  if (pluginId === 'com.hypertuna.reference.threejs-multiplayer-demo') {
    t.ok(html.includes('Three.js Multiplayer Demo'))
    t.ok(html.includes('__HT_THREE_RUNTIME_STATE'))
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function invokeRouteWithRetry(supervisor, { pluginId, routeId, routePath, timeoutMs = 20_000 }) {
  let lastResult = null
  for (let attempt = 0; attempt < 12; attempt += 1) {
    lastResult = await supervisor.invokePlugin({
      pluginId,
      payload: {
        type: 'render-route',
        routeId,
        routePath
      },
      timeoutMs
    })
    if (lastResult?.success) return lastResult
    await sleep(150)
  }
  return lastResult
}

test('first-party reference plugins package, install, and render route payloads', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-reference-plugins-'))
  const storagePath = path.join(tmpRoot, 'desktop-storage')
  const archivesDir = path.join(tmpRoot, 'archives')

  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = path.resolve(path.dirname(currentFile), '..', '..', '..')
  const referenceRoot = path.join(repoRoot, 'shared', 'plugins', 'reference')
  const cliPath = path.join(repoRoot, 'shared', 'plugins', 'sdk', 'htplugin-cli.mjs')
  const catalogPath = path.join(referenceRoot, 'catalog.json')

  const catalog = await readJson(catalogPath)
  t.ok(Array.isArray(catalog))
  t.ok(catalog.length >= 3)

  const supervisor = new PluginSupervisor({
    storagePath,
    logger: QUIET_LOGGER
  })
  await supervisor.init()

  try {
    for (const entry of catalog) {
      const item = asObject(entry)
      if (!item) continue
      const pluginId = String(item.id || '').trim().toLowerCase()
      const slug = String(item.slug || '').trim()
      t.ok(pluginId.length > 0)
      t.ok(slug.length > 0)

      const pluginDir = path.join(referenceRoot, slug)
      const manifestPath = path.join(pluginDir, 'manifest.json')
      const manifest = await readJson(manifestPath)
      const version = String(manifest?.version || '0.0.0').trim()
      const routeContributions = Array.isArray(manifest?.contributions?.routes)
        ? manifest.contributions.routes
        : []
      t.ok(routeContributions.length > 0)

      const packaged = await packReferencePlugin({
        cliPath,
        pluginDir,
        pluginId,
        version,
        outputDir: archivesDir
      })
      t.ok(packaged.sizeBytes > 0)

      const preview = await supervisor.previewPluginArchive({ archivePath: packaged.archivePath })
      t.is(preview?.success, true)
      t.is(preview?.manifest?.id, pluginId)
      t.is(preview?.manifest?.version, version)
      t.ok((preview?.archive?.sizeBytes || 0) > 0)
      if (packaged.archiveMeta?.sha256) {
        t.is(preview?.archive?.sha256, packaged.archiveMeta.sha256)
      }

      const install = await supervisor.installPluginArchive({
        archivePath: packaged.archivePath,
        source: 'first-party-reference-test'
      })
      t.is(install?.success, true)
      t.is(install?.plugin?.id, pluginId)
      t.is(install?.plugin?.version, version)
      t.ok((install?.plugin?.contributions?.routes?.length || 0) >= routeContributions.length)

      const approveResult = await supervisor.approveVersion({
        pluginId,
        version
      })
      t.is(approveResult?.success, true)

      const enableResult = await supervisor.enablePlugin({ pluginId })
      t.is(enableResult?.success, true)
      t.is(enableResult?.plugin?.status, 'enabled')

      const primaryRoute = routeContributions[0] || {}
      const invokeResult = await invokeRouteWithRetry(supervisor, {
        pluginId,
        routeId: String(primaryRoute.id || 'route-main'),
        routePath: String(primaryRoute.path || `/plugins/${pluginId}`),
        timeoutMs: 20_000
      })
      t.is(invokeResult?.success, true)
      const html = String(invokeResult?.data?.html || '')
      t.ok(html.length > 100)
      assertCapabilityMarkers(t, pluginId, html)
    }
  } finally {
    await supervisor.stopAll().catch(() => {})
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
})
