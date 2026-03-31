#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function usage() {
  return [
    'Usage:',
    '  node ./scripts/bundle-release.mjs [--platform <darwin|linux|win32>] [--arch <x64|arm64>] [--node-version <version>] [--output-dir <dir>]',
    '',
    'The script assembles a portable bundle directory containing:',
    '  - the built hyperpipe-tui dist output',
    '  - the @squip/hyperpipe-core runtime package',
    '  - the @squip/hyperpipe-core-host launcher package',
    '  - the @squip/hyperpipe-bridge integration package',
    '  - a bundled Node.js runtime',
    '  - launcher scripts for the target platform'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version.replace(/^v/, ''),
    outputDir: ''
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (token === '--platform') {
      options.platform = String(argv[index + 1] || '').trim() || options.platform
      index += 1
      continue
    }
    if (token === '--arch') {
      options.arch = String(argv[index + 1] || '').trim() || options.arch
      index += 1
      continue
    }
    if (token === '--node-version') {
      options.nodeVersion = String(argv[index + 1] || '').trim().replace(/^v/, '') || options.nodeVersion
      index += 1
      continue
    }
    if (token === '--output-dir') {
      options.outputDir = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  return options
}

function getNodeDistributionInfo(platform, arch, nodeVersion) {
  const version = String(nodeVersion || '').trim().replace(/^v/, '')
  if (!version) throw new Error('Node version is required')

  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}`)
  }
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported architecture: ${arch}`)
  }
  if (platform === 'linux' && arch !== 'x64') {
    throw new Error('Linux release bundles currently support x64 only')
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('Windows release bundles currently support x64 only')
  }

  const platformSegment =
    platform === 'win32'
      ? `win-${arch}`
      : `${platform}-${arch}`
  const extension = platform === 'win32' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz'
  const rootName = `node-v${version}-${platformSegment}`
  const assetName = `${rootName}.${extension}`

  return {
    version,
    rootName,
    assetName,
    url: `https://nodejs.org/dist/v${version}/${assetName}`,
    nodeExecutableRelativePath: platform === 'win32' ? 'node.exe' : path.join('bin', 'node')
  }
}

async function ensureExists(targetPath, label) {
  try {
    await fs.access(targetPath)
  } catch (_) {
    throw new Error(`${label} not found: ${targetPath}`)
  }
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (${response.status} ${response.statusText})`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(outputPath, buffer)
}

async function extractArchive({ archivePath, extractDir, platform }) {
  if (platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
    ])
    return
  }

  await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir])
}

function shouldCopyCore(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    normalized === 'data'
    || normalized.startsWith('data/')
    || normalized === 'test'
    || normalized.startsWith('test/')
    || normalized === 'release'
    || normalized.startsWith('release/')
    || normalized === 'package-lock.json'
  )
}

function shouldCopyCoreHost(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
  )
}

function shouldCopyBridge(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'package-lock.json'
    || normalized === 'plugins/reference'
    || normalized.startsWith('plugins/reference/')
  )
}

async function copyDirectory(fromPath, toPath, filter) {
  await fs.cp(fromPath, toPath, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const relativePath = path.relative(fromPath, source)
      return filter(relativePath)
    }
  })
}

async function writeLauncherScripts(bundleRoot, platform) {
  const unixLauncher = [
    '#!/usr/bin/env sh',
    'set -eu',
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    'exec "$SCRIPT_DIR/runtime/node/bin/node" "$SCRIPT_DIR/app/dist/cli.js" "$@"'
  ].join('\n')

  const windowsLauncher = [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'cd /d "%SCRIPT_DIR%"',
    '"%SCRIPT_DIR%runtime\\node\\node.exe" "%SCRIPT_DIR%app\\dist\\cli.js" %*'
  ].join('\r\n')

  await fs.writeFile(path.join(bundleRoot, 'hyperpipe-tui'), `${unixLauncher}\n`, 'utf8')
  await fs.writeFile(path.join(bundleRoot, 'hyperpipe-tui.cmd'), `${windowsLauncher}\r\n`, 'utf8')
  await fs.chmod(path.join(bundleRoot, 'hyperpipe-tui'), 0o755)

  if (platform !== 'win32') {
    await fs.chmod(path.join(bundleRoot, 'runtime', 'node', 'bin', 'node'), 0o755)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scriptPath = fileURLToPath(import.meta.url)
  const scriptsDir = path.dirname(scriptPath)
  const tuiRoot = path.resolve(scriptsDir, '..')
  const repoRoot = path.resolve(tuiRoot, '..')
  const coreRoot = path.join(repoRoot, 'hyperpipe-core')
  const coreHostRoot = path.join(repoRoot, 'hyperpipe-core-host')
  const bridgeRoot = path.join(repoRoot, 'hyperpipe-bridge')
  const distRoot = path.join(tuiRoot, 'dist')
  const distEntry = path.join(distRoot, 'cli.js')
  const outputDir = path.resolve(options.outputDir || path.join(tuiRoot, 'release'))

  await ensureExists(distEntry, 'Built TUI entry')
  await ensureExists(coreRoot, 'Core workspace')
  await ensureExists(coreHostRoot, 'Core Host workspace')
  await ensureExists(bridgeRoot, 'Bridge workspace')

  const nodeDist = getNodeDistributionInfo(options.platform, options.arch, options.nodeVersion)
  const bundleName = `hyperpipe-tui-${options.platform}-${options.arch}`
  const bundleRoot = path.join(outputDir, bundleName)
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperpipe-tui-release-'))
  const archivePath = path.join(tempRoot, nodeDist.assetName)
  const extractRoot = path.join(tempRoot, 'extract')

  await fs.rm(bundleRoot, { recursive: true, force: true })
  await fs.mkdir(bundleRoot, { recursive: true })
  await fs.mkdir(extractRoot, { recursive: true })

  await downloadFile(nodeDist.url, archivePath)
  await extractArchive({ archivePath, extractDir: extractRoot, platform: options.platform })

  const extractedNodeRoot = path.join(extractRoot, nodeDist.rootName)
  await ensureExists(extractedNodeRoot, 'Extracted Node runtime')

  await copyDirectory(extractedNodeRoot, path.join(bundleRoot, 'runtime', 'node'), () => true)
  await copyDirectory(distRoot, path.join(bundleRoot, 'app', 'dist'), () => true)
  await fs.copyFile(path.join(tuiRoot, 'package.json'), path.join(bundleRoot, 'app', 'package.json'))
  await fs.copyFile(path.join(tuiRoot, 'README.md'), path.join(bundleRoot, 'README.md'))
  await copyDirectory(coreRoot, path.join(bundleRoot, 'app', 'node_modules', '@hyperpipe', 'core'), shouldCopyCore)
  await copyDirectory(coreHostRoot, path.join(bundleRoot, 'app', 'node_modules', '@hyperpipe', 'core-host'), shouldCopyCoreHost)
  await copyDirectory(bridgeRoot, path.join(bundleRoot, 'app', 'node_modules', '@hyperpipe', 'bridge'), shouldCopyBridge)
  await writeLauncherScripts(bundleRoot, options.platform)

  const nodeExecutable = path.join(bundleRoot, 'runtime', 'node', nodeDist.nodeExecutableRelativePath)
  await ensureExists(nodeExecutable, 'Bundled Node executable')

  process.stdout.write(`${JSON.stringify({
    success: true,
    bundleRoot,
    platform: options.platform,
    arch: options.arch,
    nodeVersion: nodeDist.version
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`)
  process.exitCode = 1
})
