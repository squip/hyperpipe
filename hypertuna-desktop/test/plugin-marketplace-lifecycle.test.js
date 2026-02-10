import test from 'brittle'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PluginSupervisor } from '../plugin-supervisor.cjs'

const execFileAsync = promisify(execFile)

const QUIET_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {}
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function createPluginArchiveFixture({
  rootDir,
  pluginId,
  version = '1.0.0',
  permissions = ['renderer.nav', 'renderer.route', 'p2p.session']
}) {
  const packageRoot = path.join(rootDir, `${pluginId}-package`)
  const distDir = path.join(packageRoot, 'dist')
  await fs.mkdir(distDir, { recursive: true })

  const runnerRelativePath = 'dist/runner.mjs'
  const routePath = `/plugins/${pluginId}/lobby`
  const runnerSource = [
    'export default async function invoke(payload = {}) {',
    '  if (payload?.type === "render-route") {',
    '    return { html: "<div>plugin route</div>" }',
    '  }',
    '  return { ok: true }',
    '}',
    ''
  ].join('\n')
  await fs.writeFile(path.join(packageRoot, runnerRelativePath), runnerSource, 'utf8')

  const manifest = {
    id: pluginId,
    name: 'Lifecycle Test Plugin',
    version,
    engines: {
      hypertuna: '^1.0.0',
      worker: '^1.0.0',
      renderer: '^1.0.0',
      mediaApi: '^1.0.0'
    },
    entrypoints: {
      runner: runnerRelativePath
    },
    permissions,
    contributions: {
      navItems: [
        {
          id: 'nav-main',
          title: 'Lifecycle',
          routePath
        }
      ],
      routes: [
        {
          id: 'route-main',
          title: 'Lifecycle Route',
          path: routePath
        }
      ],
      mediaFeatures: []
    },
    integrity: {
      bundleSha256: sha256Hex(Buffer.from(runnerSource, 'utf8'))
    },
    source: {
      hyperdriveUrl: '',
      path: ''
    },
    marketplace: {
      publisherPubkey: '',
      tags: []
    }
  }

  await fs.writeFile(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  )

  const archivePath = path.join(rootDir, `${pluginId}-${version}.htplugin.tgz`)
  await execFileAsync('tar', ['-czf', archivePath, '-C', packageRoot, '.'])
  return {
    manifest,
    archivePath,
    routePath
  }
}

test('marketplace lifecycle enforces approval, enablement, and permissions before worker commands', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-marketplace-lifecycle-'))
  const storagePath = path.join(tmpRoot, 'desktop-storage')
  const pluginId = 'com.hypertuna.lifecycle'
  const fixture = await createPluginArchiveFixture({
    rootDir: tmpRoot,
    pluginId,
    permissions: ['renderer.nav', 'renderer.route', 'p2p.session']
  })

  const supervisor = new PluginSupervisor({
    storagePath,
    logger: QUIET_LOGGER
  })

  await supervisor.init()

  try {
    const discovered = await supervisor.discoverFromMarketplaceListings({
      source: 'nostr-marketplace',
      listings: [
        {
          manifest: fixture.manifest,
          metadata: {
            eventId: 'event-1',
            social: {
              recommendCount: 3,
              installCount: 1,
              flagCount: 0
            }
          }
        }
      ]
    })
    t.is(discovered.success, true)
    t.is(discovered.discovered.length, 1)
    t.is(discovered.skipped.length, 0)
    t.is(discovered.discovered[0]?.status, 'discovered')

    const installResult = await supervisor.installPluginArchive({
      archivePath: fixture.archivePath,
      source: 'nostr-marketplace'
    })
    t.is(installResult.success, true)
    t.is(installResult.plugin?.status, 'installed')
    t.is(installResult.plugin?.enabled, false)

    const blockedBeforeApproval = supervisor.getUiContributions()
    const blockedForPluginBeforeApproval = blockedBeforeApproval.blockedContributions.filter(
      (entry) => entry.pluginId === pluginId
    )
    t.ok(blockedForPluginBeforeApproval.some((entry) => entry.contributionType === 'route'))
    t.ok(blockedForPluginBeforeApproval.some((entry) => entry.contributionType === 'nav-item'))
    t.ok(blockedForPluginBeforeApproval.every((entry) => entry.reason === 'plugin-not-approved'))

    const deniedNotApproved = supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'p2p-send-signal',
      sourceType: 'plugin'
    })
    t.is(deniedNotApproved.success, false)
    t.ok(String(deniedNotApproved.error).includes('not approved'))

    const approveResult = await supervisor.approveVersion({
      pluginId,
      version: fixture.manifest.version
    })
    t.is(approveResult.success, true)

    const deniedNotEnabled = supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'p2p-send-signal',
      sourceType: 'plugin'
    })
    t.is(deniedNotEnabled.success, false)
    t.ok(String(deniedNotEnabled.error).includes('not enabled'))

    const enableResult = await supervisor.enablePlugin({ pluginId })
    t.is(enableResult.success, true)

    const allowedP2p = supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'p2p-send-signal',
      sourceType: 'plugin'
    })
    t.is(allowedP2p.success, true)
    t.is(allowedP2p.requiredPermission, 'p2p.session')

    const deniedMissingPermission = supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'media-start-recording',
      sourceType: 'plugin'
    })
    t.is(deniedMissingPermission.success, false)
    t.ok(String(deniedMissingPermission.error).includes('missing required permission: media.record'))

    const uiContributions = supervisor.getUiContributions()
    t.ok(uiContributions.routes.some((route) => route.path === fixture.routePath))
    t.ok(uiContributions.navItems.some((item) => item.routePath === fixture.routePath))
    const blockedForPluginAfterEnable = uiContributions.blockedContributions.filter(
      (entry) => entry.pluginId === pluginId
    )
    t.is(blockedForPluginAfterEnable.length, 0)

    const auditResponse = supervisor.getAudit(pluginId, 100)
    t.is(auditResponse.success, true)
    const entries = Array.isArray(auditResponse.entries) ? auditResponse.entries : []
    const hasMissingPermissionEntry = entries.some(
      (entry) =>
        entry?.action === 'worker-command-denied' &&
        entry?.details?.reason === 'missing-permission' &&
        entry?.details?.requiredPermission === 'media.record'
    )
    t.ok(hasMissingPermissionEntry)
  } finally {
    await supervisor.stopAll().catch(() => {})
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
})
