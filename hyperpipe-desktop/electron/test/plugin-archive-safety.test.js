import test from 'brittle'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PluginSupervisor } from '../plugin-supervisor.cjs'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_SIZE_BYTES = 128 * 1024 * 1024

const QUIET_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {}
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(String(value), 'utf8')
  encoded.copy(buffer, offset, 0, Math.min(length, encoded.length))
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = Math.max(0, value).toString(8).padStart(length - 1, '0')
  writeTarString(buffer, offset, length - 1, encoded)
  buffer[offset + length - 1] = 0
}

function createTarRecord({ name, body, mode = 0o644, type = '0', linkName = '' }) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const header = Buffer.alloc(512, 0)

  writeTarString(header, 0, 100, name)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, data.length)
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000))
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  writeTarString(header, 157, 100, linkName)
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')

  const checksum = [...header].reduce((sum, value) => sum + value, 0)
  writeTarOctal(header, 148, 8, checksum)

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0)
  return Buffer.concat([header, data, padding])
}

async function writeTarGzArchive(archivePath, entries) {
  const trailer = Buffer.alloc(1024, 0)
  const payload = Buffer.concat([
    ...entries.map((entry) => createTarRecord(entry)),
    trailer
  ])
  await fs.writeFile(archivePath, zlib.gzipSync(payload))
}

async function createPluginArchiveFixture({
  rootDir,
  pluginId,
  version = '1.0.0',
  permissions = ['renderer.nav', 'renderer.route', 'p2p.session'],
  mutateManifest = null
}) {
  const safeVersion = String(version).replace(/[^a-zA-Z0-9._-]/g, '-')
  const packageRoot = path.join(rootDir, `${pluginId}-${safeVersion}-package`)
  const distDir = path.join(packageRoot, 'dist')
  await fs.mkdir(distDir, { recursive: true })

  const routePath = `/plugins/${pluginId}/home`
  const runnerRelativePath = 'dist/runner.mjs'
  const runnerSource = [
    'export default async function invoke(payload = {}) {',
    `  return { ok: true, version: ${JSON.stringify(version)}, payload }`,
    '}',
    ''
  ].join('\n')
  await fs.writeFile(path.join(packageRoot, runnerRelativePath), runnerSource, 'utf8')

  const manifest = {
    id: pluginId,
    name: 'Archive Safety Test Plugin',
    version,
    engines: {
      hyperpipe: '^1.0.0',
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
          title: 'Archive Safety',
          routePath
        }
      ],
      routes: [
        {
          id: 'route-main',
          title: 'Archive Safety Route',
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

  if (typeof mutateManifest === 'function') {
    mutateManifest(manifest)
  }

  await fs.writeFile(path.join(packageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const archivePath = path.join(rootDir, `${pluginId}-${safeVersion}.htplugin.tgz`)
  await execFileAsync('tar', ['-czf', archivePath, '-C', packageRoot, '.'])

  return {
    archivePath,
    manifest
  }
}

async function createSupervisorContext(prefix) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  const storagePath = path.join(tmpRoot, 'desktop-storage')
  const supervisor = new PluginSupervisor({
    storagePath,
    logger: QUIET_LOGGER
  })
  await supervisor.init()
  return {
    tmpRoot,
    supervisor
  }
}

async function cleanupSupervisorContext(context) {
  await context?.supervisor?.stopAll?.().catch(() => {})
  await fs.rm(context?.tmpRoot || '', { recursive: true, force: true }).catch(() => {})
}

test('rejects plugin archives with path traversal entries', async (t) => {
  const context = await createSupervisorContext('plugin-archive-traversal')
  try {
    const packageRoot = path.join(context.tmpRoot, 'malicious-package')
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, 'file.txt'), 'payload', 'utf8')

    const archivePath = path.join(context.tmpRoot, 'path-traversal.htplugin.tgz')
    await writeTarGzArchive(archivePath, [
      {
        name: '../outside.txt',
        body: Buffer.from('payload', 'utf8')
      }
    ])

    const result = await context.supervisor.previewPluginArchive({ archivePath })
    t.is(result.success, false)
    t.ok(String(result.error || '').includes('disallowed path segment ".."'))
  } finally {
    await cleanupSupervisorContext(context)
  }
})

test('rejects plugin archives with symbolic link entries', async (t) => {
  const context = await createSupervisorContext('plugin-archive-symlink')
  try {
    const packageRoot = path.join(context.tmpRoot, 'malicious-package')
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, 'file.txt'), 'payload', 'utf8')
    await fs.symlink('file.txt', path.join(packageRoot, 'link.txt'))

    const archivePath = path.join(context.tmpRoot, 'symlink-entry.htplugin.tgz')
    await execFileAsync('tar', ['-czf', archivePath, '-C', packageRoot, 'file.txt', 'link.txt'])

    const result = await context.supervisor.previewPluginArchive({ archivePath })
    t.is(result.success, false)
    t.ok(String(result.error || '').includes('unsupported entry type "l"'))
  } finally {
    await cleanupSupervisorContext(context)
  }
})

test('rejects plugin archives with hard link entries', async (t) => {
  const context = await createSupervisorContext('plugin-archive-hardlink')
  try {
    const packageRoot = path.join(context.tmpRoot, 'malicious-package')
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, 'file.txt'), 'payload', 'utf8')
    await fs.link(path.join(packageRoot, 'file.txt'), path.join(packageRoot, 'hard.txt'))

    const archivePath = path.join(context.tmpRoot, 'hardlink-entry.htplugin.tgz')
    await execFileAsync('tar', ['-czf', archivePath, '-C', packageRoot, 'file.txt', 'hard.txt'])

    const result = await context.supervisor.previewPluginArchive({ archivePath })
    t.is(result.success, false)
    t.ok(String(result.error || '').includes('unsupported entry type "h"'))
  } finally {
    await cleanupSupervisorContext(context)
  }
})

test('rejects oversized plugin archive payloads before extraction', async (t) => {
  const context = await createSupervisorContext('plugin-archive-oversize')
  try {
    const archivePath = path.join(context.tmpRoot, 'oversize.htplugin.tgz')
    const handle = await fs.open(archivePath, 'w')
    try {
      await handle.truncate(MAX_ARCHIVE_SIZE_BYTES + 1)
    } finally {
      await handle.close()
    }

    const result = await context.supervisor.previewPluginArchive({ archivePath })
    t.is(result.success, false)
    t.ok(String(result.error || '').includes(`Plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes`))
  } finally {
    await cleanupSupervisorContext(context)
  }
})

test('rejects install when manifest integrity hash does not match bundle content', async (t) => {
  const context = await createSupervisorContext('plugin-archive-hash-mismatch')
  try {
    const pluginId = 'com.hyperpipe.archive-hash-mismatch'
    const fixture = await createPluginArchiveFixture({
      rootDir: context.tmpRoot,
      pluginId,
      version: '1.0.0',
      mutateManifest: (manifest) => {
        manifest.integrity.bundleSha256 = 'f'.repeat(64)
      }
    })

    const result = await context.supervisor.installPluginArchive({
      archivePath: fixture.archivePath,
      source: 'local-archive'
    })

    t.is(result.success, false)
    t.ok(String(result.error || '').includes('integrity.bundleSha256 does not match bundle hash'))

    const plugins = context.supervisor.listPlugins()
    t.is(plugins.length, 0)
  } finally {
    await cleanupSupervisorContext(context)
  }
})

test('upgrading plugin version requires re-approval and blocks plugin-origin worker commands until re-approved', async (t) => {
  const context = await createSupervisorContext('plugin-upgrade-reapproval')
  try {
    const pluginId = 'com.hyperpipe.upgrade-reapproval'
    const v1 = await createPluginArchiveFixture({
      rootDir: context.tmpRoot,
      pluginId,
      version: '1.0.0'
    })
    const v2 = await createPluginArchiveFixture({
      rootDir: context.tmpRoot,
      pluginId,
      version: '1.1.0'
    })

    const installV1 = await context.supervisor.installPluginArchive({
      archivePath: v1.archivePath,
      source: 'local-archive'
    })
    t.is(installV1.success, true)

    const approveV1 = await context.supervisor.approveVersion({
      pluginId,
      version: '1.0.0'
    })
    t.is(approveV1.success, true)

    const enableV1 = await context.supervisor.enablePlugin({ pluginId })
    t.is(enableV1.success, true)

    const allowedV1 = context.supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'p2p-send-signal',
      sourceType: 'plugin'
    })
    t.is(allowedV1.success, true)

    const installV2 = await context.supervisor.installPluginArchive({
      archivePath: v2.archivePath,
      source: 'local-archive'
    })
    t.is(installV2.success, true)
    t.is(installV2.plugin?.version, '1.1.0')
    t.is(installV2.plugin?.approvedVersion, null)
    t.is(installV2.plugin?.enabled, false)
    t.is(installV2.plugin?.status, 'installed')

    const deniedAfterUpgrade = context.supervisor.authorizePluginWorkerCommand({
      pluginId,
      commandType: 'p2p-send-signal',
      sourceType: 'plugin'
    })
    t.is(deniedAfterUpgrade.success, false)
    t.ok(String(deniedAfterUpgrade.error || '').includes('not approved'))

    const blockedContributions = context.supervisor
      .getUiContributions()
      .blockedContributions.filter((entry) => entry.pluginId === pluginId)
    t.ok(blockedContributions.length > 0)
    t.ok(blockedContributions.every((entry) => entry.reason === 'plugin-not-approved'))
  } finally {
    await cleanupSupervisorContext(context)
  }
})
