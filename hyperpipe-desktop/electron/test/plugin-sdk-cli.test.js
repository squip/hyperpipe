import test from 'brittle'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { PluginSupervisor } from '../plugin-supervisor.cjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const QUIET_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {}
}

async function runCli(cliPath, args, cwd) {
  try {
    return await execFileAsync('node', [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    })
  } catch (error) {
    const stdout = error?.stdout ? `\nstdout:\n${String(error.stdout)}` : ''
    const stderr = error?.stderr ? `\nstderr:\n${String(error.stderr)}` : ''
    throw new Error(`CLI command failed: node ${cliPath} ${args.join(' ')}${stdout}${stderr}`)
  }
}

async function sha256ForFile(filePath) {
  const bytes = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function resolveBridgeRoot() {
  const currentFile = fileURLToPath(import.meta.url)
  const fallbackRepoRoot = path.resolve(path.dirname(currentFile), '..', '..', '..')

  try {
    const packageJsonPath = require.resolve('@squip/hyperpipe-bridge/package.json', {
      paths: [path.dirname(currentFile), process.cwd()]
    })
    return path.dirname(packageJsonPath)
  } catch (_) {
    return path.join(fallbackRepoRoot, 'hyperpipe-bridge')
  }
}

test('htplugin CLI init/pack outputs installable .htplugin.tgz archive', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'htplugin-cli-e2e-'))
  const pluginDir = path.join(tmpRoot, 'sample-plugin')
  const storagePath = path.join(tmpRoot, 'desktop-storage')
  const artifactsDir = path.join(tmpRoot, 'artifacts')
  const pluginId = 'com.hyperpipe.cli-sample'
  const pluginVersion = '1.0.0'
  const archivePath = path.join(artifactsDir, `${pluginId}-${pluginVersion}.htplugin.tgz`)

  const bridgeRoot = resolveBridgeRoot()
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const cliPath = path.join(bridgeRoot, 'plugins', 'sdk', 'htplugin-cli.mjs')

  try {
    await fs.access(cliPath)
  } catch (_) {
    t.comment('plugin SDK CLI is not included in the installed bridge package')
    return
  }

  const supervisor = new PluginSupervisor({
    storagePath,
    logger: QUIET_LOGGER
  })
  await supervisor.init()

  try {
    await runCli(
      cliPath,
      [
        'init',
        pluginDir,
        '--id',
        pluginId,
        '--name',
        'CLI Sample',
        '--version',
        pluginVersion
      ],
      repoRoot
    )

    const validate = await runCli(
      cliPath,
      ['validate', pluginDir, '--json'],
      repoRoot
    )
    const validatePayload = JSON.parse(String(validate.stdout || '{}'))
    t.is(validatePayload.success, true)
    t.is(validatePayload.valid, true)

    await runCli(
      cliPath,
      ['pack', pluginDir, '--output', archivePath, '--json'],
      repoRoot
    )

    const archiveStats = await fs.stat(archivePath)
    t.ok(archiveStats.size > 0)
    const firstPackSha = await sha256ForFile(archivePath)

    await runCli(
      cliPath,
      ['pack', pluginDir, '--output', archivePath, '--json'],
      repoRoot
    )
    const secondPackSha = await sha256ForFile(archivePath)
    t.is(firstPackSha, secondPackSha)

    const preview = await supervisor.previewPluginArchive({ archivePath })
    t.is(preview.success, true)

    const install = await supervisor.installPluginArchive({
      archivePath,
      source: 'sdk-cli-test'
    })
    t.is(install.success, true)
    t.is(install?.plugin?.id, pluginId)
    t.is(install?.plugin?.version, pluginVersion)
    t.is(install?.plugin?.status, 'installed')
  } finally {
    await supervisor.stopAll().catch(() => {})
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
})
