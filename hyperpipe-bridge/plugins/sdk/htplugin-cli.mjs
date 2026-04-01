#!/usr/bin/env node

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import zlib from 'node:zlib'

import { validatePluginManifest } from '../index.mjs'

const execFileAsync = promisify(execFile)

const FIXED_MTIME = new Date('2000-01-01T00:00:00.000Z')
const FIXED_MTIME_SECONDS = Math.floor(FIXED_MTIME.getTime() / 1000)
const BLOCKED_SEGMENTS = new Set(['.git', '.hg', '.svn', 'node_modules'])
const DEFAULT_TEMPLATE_VERSION = '0.1.0'

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function toPosixPath(value) {
  return asString(value).replace(/\\/g, '/')
}

function normalizeRelativePath(rawPath, label = 'path') {
  const normalized = toPosixPath(rawPath)
    .replace(/\/+/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/$/, '')
  if (!normalized) {
    throw new Error(`${label} is empty`)
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} must be relative`)
  }
  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`${label} contains disallowed segment "${segment}"`)
    }
    if (BLOCKED_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`${label} contains blocked segment "${segment}"`)
    }
  }
  return segments.join('/')
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch (_) {
    return false
  }
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function sha256ForFile(filePath) {
  const buffer = await fs.readFile(filePath)
  return sha256Hex(buffer)
}

async function listFilesRecursive(rootDir) {
  const files = []
  const stack = ['']
  while (stack.length) {
    const relativeDir = stack.pop()
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true })
    for (const entry of entries) {
      const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const normalizedChild = normalizeRelativePath(childRelative, `Path "${childRelative}"`)
      const absolutePath = path.join(rootDir, normalizedChild)
      const stats = await fs.lstat(absolutePath)
      if (stats.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported (${normalizedChild})`)
      }
      if (stats.isDirectory()) {
        stack.push(normalizedChild)
        continue
      }
      if (!stats.isFile()) {
        throw new Error(`Unsupported file type (${normalizedChild})`)
      }
      files.push(normalizedChild)
    }
  }
  files.sort((a, b) => a.localeCompare(b))
  return files
}

async function sha256ForDirectory(rootDir) {
  const hash = crypto.createHash('sha256')
  const files = await listFilesRecursive(rootDir)
  for (const relativePath of files) {
    const absolutePath = path.join(rootDir, relativePath)
    const data = await fs.readFile(absolutePath)
    hash.update(relativePath)
    hash.update('\0')
    hash.update(data)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('JSON root must be an object')
    }
    return parsed
  } catch (error) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${error?.message || error}`)
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function ensurePluginId(input) {
  const pluginId = asString(input).toLowerCase()
  if (!/^[a-z0-9]+([.-][a-z0-9]+)+$/.test(pluginId)) {
    throw new Error('Plugin id must be reverse-dns style (example: com.example.plugin)')
  }
  return pluginId
}

function resolveCliPath() {
  return fileURLToPath(import.meta.url)
}

function usageText() {
  return [
    'htplugin CLI',
    '',
    'Usage:',
    '  htplugin init [dir] --id <pluginId> [--name <displayName>] [--version <semver>] [--force]',
    '  htplugin build [dir] [--command "<cmd>"]',
    '  htplugin validate [dir] [--strict] [--fix-integrity] [--json]',
    '  htplugin pack [dir] [--output <archive.htplugin.tgz>] [--skip-build] [--strict] [--json]',
    '',
    'Notes:',
    '  - validate/pack compute integrity hashes using the same algorithm as plugin-supervisor.',
    '  - pack writes deterministic archives by staging sorted files with fixed metadata.',
    '  - commands default to current working directory when [dir] is omitted.'
  ].join('\n')
}

function parseArgv(argv) {
  const positional = []
  const options = {}

  const setOption = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      const existing = options[key]
      if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        options[key] = [existing, value]
      }
      return
    }
    options[key] = value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }

    if (token === '-h' || token === '--help') {
      setOption('help', true)
      continue
    }

    if (token.startsWith('--no-')) {
      setOption(token.slice(5), false)
      continue
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`)
    }

    const equalsIndex = token.indexOf('=')
    if (equalsIndex > -1) {
      const key = token.slice(2, equalsIndex)
      const value = token.slice(equalsIndex + 1)
      setOption(key, value)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('-')) {
      setOption(key, true)
      continue
    }
    setOption(key, next)
    index += 1
  }

  return { positional, options }
}

function ensureArchiveExtension(targetPath) {
  const normalized = asString(targetPath)
  if (!normalized) return normalized
  if (normalized.endsWith('.htplugin.tgz')) return normalized
  if (normalized.endsWith('.tgz')) return normalized
  return `${normalized}.htplugin.tgz`
}

async function runShellCommand(command, { cwd } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: 'inherit'
    })
    child.once('error', (error) => reject(error))
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Command failed with exit code ${code}: ${command}`))
    })
  })
}

async function runBuildStep(pluginDir, command = '') {
  const explicit = asString(command)
  if (explicit) {
    await runShellCommand(explicit, { cwd: pluginDir })
    return { mode: 'custom-command', command: explicit }
  }

  const packageJsonPath = path.join(pluginDir, 'package.json')
  if (await pathExists(packageJsonPath)) {
    const packageJson = await readJsonFile(packageJsonPath)
    const scripts = asObject(packageJson.scripts)
    if (scripts && isNonEmptyString(scripts.build)) {
      await runShellCommand('npm run build', { cwd: pluginDir })
      return { mode: 'npm-build-script', command: 'npm run build' }
    }
  }

  const fallbackCandidates = ['src/runner.mjs', 'src/runner.js']
  let sourcePath = ''
  for (const relativeCandidate of fallbackCandidates) {
    const absoluteCandidate = path.join(pluginDir, relativeCandidate)
    if (await pathExists(absoluteCandidate)) {
      sourcePath = absoluteCandidate
      break
    }
  }
  if (!sourcePath) {
    throw new Error('No build command found and no fallback src/runner.mjs|src/runner.js source was found')
  }
  const distDir = path.join(pluginDir, 'dist')
  await fs.mkdir(distDir, { recursive: true })
  const targetPath = path.join(distDir, 'runner.mjs')
  await fs.copyFile(sourcePath, targetPath)
  return {
    mode: 'fallback-copy',
    command: `${path.relative(pluginDir, sourcePath)} -> dist/runner.mjs`
  }
}

function shouldExcludePath(relativePath, { outputArchiveRelative = '' } = {}) {
  const normalized = normalizeRelativePath(relativePath, `Path "${relativePath}"`)
  const segments = normalized.split('/')
  for (const segment of segments) {
    const lowered = segment.toLowerCase()
    if (BLOCKED_SEGMENTS.has(lowered)) return true
    if (lowered === '.ds_store') return true
  }
  const loweredPath = normalized.toLowerCase()
  if (loweredPath.endsWith('.htplugin.tgz')) return true
  if (loweredPath.endsWith('.tgz')) return true
  if (outputArchiveRelative && loweredPath === outputArchiveRelative.toLowerCase()) return true
  return false
}

async function collectPackageFiles(pluginDir, { outputArchivePath = '' } = {}) {
  const files = await listFilesRecursive(pluginDir)
  const outputArchiveRelative = outputArchivePath
    ? toPosixPath(path.relative(pluginDir, outputArchivePath))
    : ''
  const included = []
  for (const relativePath of files) {
    if (shouldExcludePath(relativePath, { outputArchiveRelative })) continue
    included.push(relativePath)
  }
  if (!included.includes('manifest.json')) {
    throw new Error('manifest.json is required for packaging')
  }
  return included.sort((a, b) => a.localeCompare(b))
}

async function ensureDirectoryMeta(targetDir) {
  await fs.chmod(targetDir, 0o755).catch(() => {})
  await fs.utimes(targetDir, FIXED_MTIME, FIXED_MTIME).catch(() => {})
}

async function ensureFileMeta(targetFile) {
  await fs.chmod(targetFile, 0o644).catch(() => {})
  await fs.utimes(targetFile, FIXED_MTIME, FIXED_MTIME).catch(() => {})
}

async function createStagingDirectory(pluginDir, filesToInclude) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'htplugin-stage-'))
  const stagedDirectories = new Set([''])
  for (const relativePath of filesToInclude) {
    const absoluteSource = path.join(pluginDir, relativePath)
    const absoluteTarget = path.join(stagingRoot, relativePath)
    const parentRelative = path.dirname(relativePath)
    if (parentRelative && parentRelative !== '.') {
      const parts = parentRelative.split('/')
      let acc = ''
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part
        stagedDirectories.add(acc)
      }
      await fs.mkdir(path.join(stagingRoot, parentRelative), { recursive: true })
    }
    await fs.copyFile(absoluteSource, absoluteTarget)
    await ensureFileMeta(absoluteTarget)
  }

  const sortedDirectories = Array.from(stagedDirectories).sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })
  for (const relativeDir of sortedDirectories) {
    const absoluteDir = relativeDir ? path.join(stagingRoot, relativeDir) : stagingRoot
    await ensureDirectoryMeta(absoluteDir)
  }

  return stagingRoot
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value || ''), 'utf8')
  bytes.copy(buffer, offset, 0, Math.min(length, bytes.length))
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0')
  writeTarString(buffer, offset, length - 1, encoded)
  buffer[offset + length - 1] = 0
}

function writeTarChecksum(buffer, checksum) {
  const encoded = Math.max(0, Number(checksum) || 0).toString(8).padStart(6, '0')
  writeTarString(buffer, 148, 6, encoded)
  buffer[154] = 0
  buffer[155] = 0x20
}

function splitTarPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath, `Path "${relativePath}"`)
  if (Buffer.byteLength(normalized, 'utf8') <= 100) {
    return { name: normalized, prefix: '' }
  }

  const segments = normalized.split('/')
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join('/')
    const name = segments.slice(index).join('/')
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix }
    }
  }

  throw new Error(`Path is too long for deterministic archive packaging: ${normalized}`)
}

function createTarFileRecord(relativePath, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const header = Buffer.alloc(512, 0)
  const { name, prefix } = splitTarPath(relativePath)

  writeTarString(header, 0, 100, name)
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, data.length)
  writeTarOctal(header, 136, 12, FIXED_MTIME_SECONDS)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')
  writeTarString(header, 265, 32, 'root')
  writeTarString(header, 297, 32, 'root')
  writeTarString(header, 345, 155, prefix)

  const checksum = [...header].reduce((sum, value) => sum + value, 0)
  writeTarChecksum(header, checksum)

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0)
  return Buffer.concat([header, data, padding])
}

async function createDeterministicArchive(stagingRoot, filesToInclude, outputPath) {
  const outputDir = path.dirname(outputPath)
  await fs.mkdir(outputDir, { recursive: true })
  const archiveParts = []
  for (const relativePath of filesToInclude) {
    const sourcePath = path.join(stagingRoot, relativePath)
    const data = await fs.readFile(sourcePath)
    archiveParts.push(createTarFileRecord(relativePath, data))
  }
  archiveParts.push(Buffer.alloc(1024, 0))
  const tarPayload = Buffer.concat(archiveParts)
  const gzipped = zlib.gzipSync(tarPayload, { level: 9, mtime: 0 })
  await fs.writeFile(outputPath, gzipped)
}

async function computeProjectIntegrity(pluginDir, manifest) {
  const normalizedManifest = validatePluginManifest(manifest, { strict: false }).manifest
  const runnerEntrypoint = asString(normalizedManifest?.entrypoints?.runner)
  let bundleSha256 = ''
  let bundleTarget = ''
  let bundleMode = ''

  if (runnerEntrypoint) {
    const runnerRelative = normalizeRelativePath(runnerEntrypoint, 'Manifest entrypoints.runner')
    const runnerAbsolute = path.join(pluginDir, runnerRelative)
    if (!(await pathExists(runnerAbsolute))) {
      throw new Error(`Manifest entrypoint not found: ${runnerRelative}`)
    }
    bundleSha256 = await sha256ForFile(runnerAbsolute)
    bundleTarget = runnerRelative
    bundleMode = 'entrypoint-file'
  } else {
    const distDir = path.join(pluginDir, 'dist')
    if (!(await pathExists(distDir))) {
      throw new Error('Plugin must define entrypoints.runner or include a dist/ directory')
    }
    bundleSha256 = await sha256ForDirectory(distDir)
    bundleTarget = 'dist/'
    bundleMode = 'dist-directory'
  }

  const srcDir = path.join(pluginDir, 'src')
  const hasSourceDir = await pathExists(srcDir)
  const sourceSha256 = hasSourceDir ? await sha256ForDirectory(srcDir) : ''

  return {
    bundleSha256,
    sourceSha256,
    hasSourceDir,
    bundleTarget,
    bundleMode
  }
}

async function updateChecksumsFile(pluginDir, integrity) {
  const lines = []
  if (integrity.bundleSha256) {
    lines.push(`${integrity.bundleSha256}  ${integrity.bundleTarget}`)
  }
  if (integrity.hasSourceDir && integrity.sourceSha256) {
    lines.push(`${integrity.sourceSha256}  src/`)
  }
  const manifestSha = await sha256ForFile(path.join(pluginDir, 'manifest.json'))
  lines.push(`${manifestSha}  manifest.json`)
  const content = `${lines.join('\n')}\n`
  await fs.writeFile(path.join(pluginDir, 'checksums.sha256'), content, 'utf8')
}

async function validateProject(pluginDir, { strict = false, fixIntegrity = false } = {}) {
  const manifestPath = path.join(pluginDir, 'manifest.json')
  if (!(await pathExists(manifestPath))) {
    return {
      valid: false,
      errors: ['manifest.json was not found'],
      warnings: []
    }
  }

  const manifestRaw = await readJsonFile(manifestPath)
  const contractValidation = validatePluginManifest(manifestRaw, { strict })
  const errors = [...contractValidation.errors]
  const warnings = []
  let computedIntegrity = null

  try {
    computedIntegrity = await computeProjectIntegrity(pluginDir, contractValidation.manifest)
  } catch (error) {
    errors.push(error?.message || String(error))
  }

  if (computedIntegrity) {
    const declaredBundle = asString(contractValidation.manifest?.integrity?.bundleSha256).toLowerCase()
    const declaredSource = asString(contractValidation.manifest?.integrity?.sourceSha256).toLowerCase()
    if (!declaredBundle) {
      errors.push('Manifest integrity.bundleSha256 is required for package validation')
    } else if (declaredBundle !== computedIntegrity.bundleSha256) {
      errors.push('Manifest integrity.bundleSha256 does not match computed bundle hash')
    }

    if (computedIntegrity.hasSourceDir) {
      if (!declaredSource) {
        errors.push('Manifest integrity.sourceSha256 is required when src/ exists')
      } else if (declaredSource !== computedIntegrity.sourceSha256) {
        errors.push('Manifest integrity.sourceSha256 does not match computed src hash')
      }
    } else if (declaredSource) {
      warnings.push('Manifest integrity.sourceSha256 is present but src/ directory is missing')
    }
  }

  let updatedManifest = null
  if (fixIntegrity && computedIntegrity && contractValidation.valid) {
    updatedManifest = {
      ...manifestRaw,
      integrity: {
        ...(asObject(manifestRaw.integrity) || {}),
        bundleSha256: computedIntegrity.bundleSha256,
        sourceSha256: computedIntegrity.hasSourceDir ? computedIntegrity.sourceSha256 : ''
      }
    }
    await writeJsonFile(manifestPath, updatedManifest)
  }

  const postFixManifest = updatedManifest || manifestRaw
  const postFixValidation = validatePluginManifest(postFixManifest, { strict })
  const postFixErrors = [...postFixValidation.errors]

  let postFixIntegrity = null
  try {
    postFixIntegrity = await computeProjectIntegrity(pluginDir, postFixValidation.manifest)
  } catch (error) {
    postFixErrors.push(error?.message || String(error))
  }

  if (postFixIntegrity) {
    const declaredBundle = asString(postFixValidation.manifest?.integrity?.bundleSha256).toLowerCase()
    const declaredSource = asString(postFixValidation.manifest?.integrity?.sourceSha256).toLowerCase()
    if (!declaredBundle || declaredBundle !== postFixIntegrity.bundleSha256) {
      postFixErrors.push('Manifest integrity.bundleSha256 does not match computed bundle hash')
    }
    if (postFixIntegrity.hasSourceDir) {
      if (!declaredSource || declaredSource !== postFixIntegrity.sourceSha256) {
        postFixErrors.push('Manifest integrity.sourceSha256 does not match computed src hash')
      }
    }
  }

  return {
    valid: postFixErrors.length === 0,
    errors: postFixErrors,
    warnings,
    manifest: postFixValidation.manifest,
    integrity: postFixIntegrity,
    fixedIntegrity: fixIntegrity && Boolean(updatedManifest)
  }
}

async function handleInit({ pluginDir, options }) {
  const pluginId = ensurePluginId(options.id || options.pluginId)
  const pluginName = asString(options.name) || pluginId
  const pluginVersion = asString(options.version) || DEFAULT_TEMPLATE_VERSION
  const force = options.force === true

  const targetDir = path.resolve(pluginDir || process.cwd())
  await fs.mkdir(targetDir, { recursive: true })

  const manifestPath = path.join(targetDir, 'manifest.json')
  if (!force && (await pathExists(manifestPath))) {
    throw new Error(`manifest.json already exists at ${targetDir} (use --force to overwrite)`)
  }

  const routePath = `/plugins/${pluginId}/home`
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: pluginVersion,
    engines: {
      hyperpipe: '^1.0.0',
      worker: '^1.0.0',
      renderer: '^1.0.0',
      mediaApi: '^1.0.0'
    },
    entrypoints: {
      runner: 'dist/runner.mjs'
    },
    permissions: ['renderer.nav', 'renderer.route'],
    contributions: {
      navItems: [
        {
          id: 'main',
          title: pluginName,
          description: `${pluginName} main page`,
          icon: 'puzzle',
          routePath,
          order: 100
        }
      ],
      routes: [
        {
          id: 'main',
          title: `${pluginName} Home`,
          description: 'Main plugin route',
          path: routePath,
          moduleId: '',
          iframeSrc: ''
        }
      ],
      mediaFeatures: []
    },
    integrity: {
      bundleSha256: '',
      sourceSha256: ''
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

  const templateFiles = new Map([
    [
      'README.md',
      [
        `# ${pluginName}`,
        '',
        `Plugin id: \`${pluginId}\``,
        '',
        '## Development',
        '',
        '1. `npm run build`',
        '2. `htplugin validate . --fix-integrity`',
        '3. `htplugin pack .`',
        ''
      ].join('\n')
    ],
    [
      'src/runner.mjs',
      [
        'export default async function invoke(payload = {}) {',
        '  if (payload?.type === \'render-route\') {',
        `    return { html: '<main><h1>${pluginName}</h1><p>Plugin route rendered from runner.</p></main>' }`,
        '  }',
        "  return { ok: true, message: 'Plugin invoked', payload }",
        '}',
        ''
      ].join('\n')
    ],
    [
      'scripts/build.mjs',
      [
        "import { promises as fs } from 'node:fs'",
        "import path from 'node:path'",
        '',
        'const root = process.cwd()',
        "const sourcePath = path.join(root, 'src', 'runner.mjs')",
        "const distDir = path.join(root, 'dist')",
        "const targetPath = path.join(distDir, 'runner.mjs')",
        '',
        'await fs.mkdir(distDir, { recursive: true })',
        'await fs.copyFile(sourcePath, targetPath)',
        "console.log('[htplugin] built dist/runner.mjs')",
        ''
      ].join('\n')
    ],
    [
      'package.json',
      JSON.stringify(
        {
          name: pluginId.replace(/\./g, '-'),
          private: true,
          version: pluginVersion,
          type: 'module',
          scripts: {
            build: 'node ./scripts/build.mjs',
            validate: 'htplugin validate .',
            pack: 'htplugin pack .'
          }
        },
        null,
        2
      ) + '\n'
    ],
    [
      '.gitignore',
      ['dist/', '*.htplugin.tgz', '*.tgz', 'node_modules/'].join('\n') + '\n'
    ]
  ])

  await writeJsonFile(manifestPath, manifest)
  for (const [relativePath, content] of templateFiles.entries()) {
    const absolutePath = path.join(targetDir, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf8')
  }

  await fs.mkdir(path.join(targetDir, 'dist'), { recursive: true })
  await fs.copyFile(
    path.join(targetDir, 'src', 'runner.mjs'),
    path.join(targetDir, 'dist', 'runner.mjs')
  )
  const buildResult = {
    mode: 'template-bootstrap-copy',
    command: 'src/runner.mjs -> dist/runner.mjs'
  }
  const validation = await validateProject(targetDir, { fixIntegrity: true })
  if (!validation.valid) {
    throw new Error(`Template validation failed: ${validation.errors.join('; ')}`)
  }
  await updateChecksumsFile(targetDir, validation.integrity)

  return {
    success: true,
    command: 'init',
    pluginDir: targetDir,
    pluginId,
    version: pluginVersion,
    build: buildResult,
    manifestPath
  }
}

async function handleBuild({ pluginDir, options }) {
  const targetDir = path.resolve(pluginDir || process.cwd())
  const buildResult = await runBuildStep(targetDir, asString(options.command))
  return {
    success: true,
    command: 'build',
    pluginDir: targetDir,
    build: buildResult
  }
}

async function handleValidate({ pluginDir, options }) {
  const targetDir = path.resolve(pluginDir || process.cwd())
  const validation = await validateProject(targetDir, {
    strict: options.strict === true,
    fixIntegrity: options['fix-integrity'] === true || options.fixIntegrity === true
  })
  return {
    success: validation.valid,
    command: 'validate',
    pluginDir: targetDir,
    ...validation
  }
}

async function handlePack({ pluginDir, options }) {
  const targetDir = path.resolve(pluginDir || process.cwd())
  const skipBuild = options['skip-build'] === true || options.skipBuild === true

  let build = null
  if (!skipBuild) {
    build = await runBuildStep(targetDir, asString(options.command))
  }

  const validation = await validateProject(targetDir, {
    strict: options.strict === true,
    fixIntegrity: true
  })
  if (!validation.valid) {
    throw new Error(`Plugin validation failed: ${validation.errors.join('; ')}`)
  }
  await updateChecksumsFile(targetDir, validation.integrity)

  const manifest = validation.manifest
  const defaultArchiveName = `${manifest.id || 'plugin'}-${manifest.version || '0.0.0'}.htplugin.tgz`
  const outputPathRaw = asString(options.output) || path.join(targetDir, defaultArchiveName)
  const outputPath = path.resolve(ensureArchiveExtension(outputPathRaw))

  const filesToInclude = await collectPackageFiles(targetDir, { outputArchivePath: outputPath })
  const stagingRoot = await createStagingDirectory(targetDir, filesToInclude)
  try {
    await createDeterministicArchive(stagingRoot, filesToInclude, outputPath)
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }

  const archiveStats = await fs.stat(outputPath)
  const archiveSha256 = await sha256ForFile(outputPath)
  return {
    success: true,
    command: 'pack',
    pluginDir: targetDir,
    outputPath,
    archive: {
      sizeBytes: archiveStats.size,
      sha256: archiveSha256
    },
    filesIncluded: filesToInclude.length,
    build,
    validation: {
      errors: validation.errors,
      warnings: validation.warnings
    }
  }
}

function printHumanResult(result) {
  if (!result || typeof result !== 'object') return
  if (result.success) {
    if (result.command === 'init') {
      console.log(`[htplugin] initialized template: ${result.pluginDir}`)
      console.log(`[htplugin] plugin: ${result.pluginId} v${result.version}`)
      return
    }
    if (result.command === 'build') {
      console.log(`[htplugin] build completed in ${result.pluginDir}`)
      console.log(`[htplugin] mode: ${result?.build?.mode || 'unknown'}`)
      return
    }
    if (result.command === 'validate') {
      console.log(`[htplugin] validation passed: ${result.pluginDir}`)
      if (Array.isArray(result.warnings) && result.warnings.length) {
        for (const warning of result.warnings) {
          console.log(`[htplugin] warning: ${warning}`)
        }
      }
      return
    }
    if (result.command === 'pack') {
      console.log(`[htplugin] archive created: ${result.outputPath}`)
      console.log(`[htplugin] size: ${result.archive.sizeBytes} bytes`)
      console.log(`[htplugin] sha256: ${result.archive.sha256}`)
      return
    }
  } else if (result.command === 'validate') {
    console.error(`[htplugin] validation failed: ${result.pluginDir}`)
    for (const error of result.errors || []) {
      console.error(`[htplugin] error: ${error}`)
    }
    for (const warning of result.warnings || []) {
      console.error(`[htplugin] warning: ${warning}`)
    }
  }
}

async function main() {
  const { positional, options } = parseArgv(process.argv.slice(2))
  const command = positional[0]

  if (options.help || !command || command === 'help') {
    console.log(usageText())
    return
  }

  const commandDir = positional[1]
  let result = null

  if (command === 'init') {
    result = await handleInit({ pluginDir: commandDir, options })
  } else if (command === 'build') {
    result = await handleBuild({ pluginDir: commandDir, options })
  } else if (command === 'validate') {
    result = await handleValidate({ pluginDir: commandDir, options })
  } else if (command === 'pack') {
    result = await handlePack({ pluginDir: commandDir, options })
  } else if (command === 'version' || command === '--version') {
    const cliPath = resolveCliPath()
    console.log(`htplugin-cli: ${cliPath}`)
    return
  } else {
    throw new Error(`Unknown command: ${command}`)
  }

  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printHumanResult(result)
  }

  if (result && result.success === false) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  const message = error?.message || String(error)
  console.error(`[htplugin] ${message}`)
  process.exitCode = 1
})
