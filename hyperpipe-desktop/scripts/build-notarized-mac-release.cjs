#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const PROJECT_DIR = path.resolve(__dirname, '..')
const PRODUCT_NAME = 'Hyperpipe'
const POLL_INTERVAL_MS = 15000
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000

function usage() {
  return [
    'Usage:',
    '  node ./scripts/build-notarized-mac-release.cjs <command> --arch <x64|arm64> [--timeout-minutes <minutes>]',
    '',
    'Commands:',
    '  build-app    Build a signed macOS .app bundle only',
    '  notarize     Zip, notarize, and staple the existing .app bundle',
    '  package      Build DMG and ZIP from the existing notarized .app bundle',
    '  all          Run build-app, notarize, and package in sequence',
    '',
    'Required env:',
    '  CSC_LINK',
    '  CSC_KEY_PASSWORD',
    '  APPLE_ID',
    '  APPLE_APP_SPECIFIC_PASSWORD',
    '  APPLE_TEAM_ID'
  ].join('\n')
}

function parseArgs(argv) {
  let command = ''
  let arch = ''
  let timeoutMinutes = 45

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (!token.startsWith('--') && !command) {
      command = token
      continue
    }
    if (token === '--arch') {
      arch = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    if (token === '--timeout-minutes') {
      timeoutMinutes = Number.parseInt(String(argv[index + 1] || '').trim(), 10)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  if (!command || !['build-app', 'notarize', 'package', 'all'].includes(command)) {
    throw new Error('Missing or invalid command. Expected build-app, notarize, package, or all.')
  }
  if (!arch || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Missing or invalid --arch value. Expected x64 or arm64.')
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('Missing or invalid --timeout-minutes value.')
  }

  return { command, arch, timeoutMs: timeoutMinutes * 60 * 1000 }
}

function assertEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function timestamp() {
  return new Date().toISOString()
}

function log(message) {
  process.stdout.write(`[${timestamp()}] ${message}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appBundlePathForArch(arch) {
  const folder = arch === 'arm64' ? 'mac-arm64' : 'mac'
  return path.join(PROJECT_DIR, 'release', folder, `${PRODUCT_NAME}.app`)
}

function notaryLogsDir() {
  return path.join(PROJECT_DIR, '.notarization')
}

function notaryStatusPath(arch) {
  return path.join(notaryLogsDir(), `notary-status-${arch}.json`)
}

function notarySummaryPath(arch) {
  return path.join(notaryLogsDir(), `notary-summary-${arch}.json`)
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function ensureDistArtifacts() {
  const distIndex = path.join(PROJECT_DIR, 'dist', 'index.html')
  if (!fs.existsSync(distIndex)) {
    throw new Error('Desktop dist assets are missing. Run build:web before notarized packaging.')
  }
}

function redactableError(command, args, code, stderr) {
  const trimmed = String(stderr || '').trim()
  const detail = trimmed ? `\n${trimmed}` : ''
  return new Error(`Command failed (${code}): ${command} ${args.join(' ')}${detail}`)
}

async function run(command, args, options = {}) {
  const {
    cwd = PROJECT_DIR,
    env = process.env,
    capture = false,
    announce = '',
    allowFailure = false,
    timeoutMs = 0
  } = options

  if (announce) {
    log(announce)
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timeoutHandle = null

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000).unref()
      }, timeoutMs)
    }

    child.on('error', reject)
    child.on('close', (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      if (timedOut) {
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds: ${command}`))
        return
      }
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr })
        return
      }
      reject(redactableError(command, args, code, stderr))
    })
  })
}

async function runJson(command, args, options = {}) {
  const result = await run(command, args, { ...options, capture: true })
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${command}: ${result.stdout || result.stderr}`)
  }
  return parsed
}

async function buildSignedAppBundle(arch) {
  await ensureDistArtifacts()
  await run('node', ['./scripts/generate-icons.mjs'], {
    announce: `Generating desktop icons for ${arch}`
  })

  const builderEnv = {
    ...process.env,
    HYPERPIPE_ELECTRON_BUILDER_NOTARIZE: '',
    APPLE_ID: '',
    APPLE_APP_SPECIFIC_PASSWORD: '',
    APPLE_TEAM_ID: ''
  }

  await run(
    'npx',
    ['electron-builder', '--config', './electron-builder.config.cjs', '--publish=never', '--mac', 'dir', `--${arch}`],
    {
      env: builderEnv,
      announce: `Building signed macOS app bundle (${arch})`
    }
  )

  const appPath = appBundlePathForArch(arch)
  if (!fs.existsSync(appPath)) {
    throw new Error(`Signed app bundle not found: ${appPath}`)
  }

  log(`Signed app bundle ready: ${appPath}`)
  return appPath
}

async function submitForNotarization(archivePath) {
  const appleId = assertEnv('APPLE_ID')
  const password = assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = assertEnv('APPLE_TEAM_ID')

  const submission = await runJson(
    'xcrun',
    [
      'notarytool',
      'submit',
      archivePath,
      '--apple-id',
      appleId,
      '--password',
      password,
      '--team-id',
      teamId,
      '--output-format',
      'json',
      '--no-wait'
    ],
    {
      announce: `Submitting ${path.basename(archivePath)} to Apple notarization service`,
      timeoutMs: 10 * 60 * 1000
    }
  )

  const submissionId = String(submission.id || '').trim()
  if (!submissionId) {
    throw new Error(`Apple notarization submission did not return an id: ${JSON.stringify(submission, null, 2)}`)
  }

  log(`Apple notarization submission id: ${submissionId}`)
  return { submissionId, submission }
}

async function fetchNotaryInfo(submissionId) {
  const appleId = assertEnv('APPLE_ID')
  const password = assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = assertEnv('APPLE_TEAM_ID')

  return runJson(
    'xcrun',
    [
      'notarytool',
      'info',
      submissionId,
      '--apple-id',
      appleId,
      '--password',
      password,
      '--team-id',
      teamId,
      '--output-format',
      'json'
    ]
  )
}

async function writeNotaryLog(submissionId, arch) {
  const appleId = assertEnv('APPLE_ID')
  const password = assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = assertEnv('APPLE_TEAM_ID')
  const outputDir = notaryLogsDir()
  const logPath = path.join(outputDir, `notary-log-${arch}.json`)

  await fsp.mkdir(outputDir, { recursive: true })
  await run(
    'xcrun',
    [
      'notarytool',
      'log',
      submissionId,
      logPath,
      '--apple-id',
      appleId,
      '--password',
      password,
      '--team-id',
      teamId
    ],
    {
      announce: `Fetching Apple notarization log for submission ${submissionId}`
    }
  )

  return logPath
}

async function notarizeAndStapleApp(appPath, arch, timeoutMs) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `hyperpipe-notary-${arch}-`))
  const archivePath = path.join(tempDir, `${PRODUCT_NAME}-${arch}-notary.zip`)
  const logsDir = notaryLogsDir()

  await fsp.mkdir(logsDir, { recursive: true })
  await run(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath],
    {
      announce: `Creating notarization archive for ${arch}`
    }
  )

  const { submissionId, submission } = await submitForNotarization(archivePath)
  const statusPath = notaryStatusPath(arch)
  const summaryPath = notarySummaryPath(arch)
  const pollHistory = []

  await writeJson(summaryPath, {
    arch,
    submissionId,
    archivePath: path.basename(archivePath),
    timeoutMinutes: Math.round(timeoutMs / 60000),
    submittedAt: timestamp(),
    submission
  })

  const deadline = Date.now() + timeoutMs
  let lastStatus = ''
  let attempts = 0
  let finalInfo = null

  while (Date.now() < deadline) {
    attempts += 1
    let info
    try {
      info = await fetchNotaryInfo(submissionId)
    } catch (error) {
      log(`Apple notarization status lookup failed (attempt ${attempts}): ${error.message}`)
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    finalInfo = info
    const status = String(info.status || info.Status || '').trim() || 'Unknown'
    const normalizedStatus = status.toLowerCase()
    const message = String(info.message || info.statusSummary || '').trim()
    pollHistory.push({
      checkedAt: timestamp(),
      status,
      message,
      info
    })
    await writeJson(statusPath, {
      arch,
      submissionId,
      latestStatus: status,
      attempts,
      pollHistory
    })
    if (status !== lastStatus || attempts === 1 || attempts % 4 === 0) {
      log(`Apple notarization status (${arch}): ${status}${message ? ` - ${message}` : ''}`)
      lastStatus = status
    }

    if (normalizedStatus === 'accepted') {
      break
    }

    if (normalizedStatus === 'invalid' || normalizedStatus === 'rejected') {
      const logPath = await writeNotaryLog(submissionId, arch)
      throw new Error(`Apple notarization failed for ${arch}. See ${logPath}`)
    }

    await sleep(POLL_INTERVAL_MS)
  }

  if (!finalInfo || String(finalInfo.status || '').trim().toLowerCase() !== 'accepted') {
    const logPath = await writeNotaryLog(submissionId, arch).catch(() => '')
    await writeJson(summaryPath, {
      arch,
      submissionId,
      timeoutMinutes: Math.round(timeoutMs / 60000),
      completedAt: timestamp(),
      finalInfo,
      timedOut: true,
      logPath: logPath || null
    })
    throw new Error(
      `Apple notarization timed out for ${arch} after ${Math.round(timeoutMs / 60000)} minutes` +
        (logPath ? `. Partial log: ${logPath}` : '')
    )
  }

  const logPath = await writeNotaryLog(submissionId, arch)
  const infoPath = path.join(logsDir, `notary-info-${arch}.json`)
  await writeJson(infoPath, finalInfo)
  await writeJson(summaryPath, {
    arch,
    submissionId,
    completedAt: timestamp(),
    finalInfo,
    accepted: true,
    logPath
  })
  log(`Apple notarization accepted for ${arch}. Log saved to ${logPath}`)

  await run('xcrun', ['stapler', 'staple', '-v', appPath], {
    announce: `Stapling notarization ticket to ${path.basename(appPath)}`
  })
  await run('xcrun', ['stapler', 'validate', '-v', appPath], {
    announce: `Validating stapled ticket for ${path.basename(appPath)}`
  })
}

async function buildReleaseContainers(appPath, arch) {
  const builderEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    HYPERPIPE_ELECTRON_BUILDER_NOTARIZE: '',
    APPLE_ID: '',
    APPLE_APP_SPECIFIC_PASSWORD: '',
    APPLE_TEAM_ID: ''
  }

  await run(
    'npx',
    [
      'electron-builder',
      '--config',
      './electron-builder.config.cjs',
      '--publish=never',
      '--prepackaged',
      appPath,
      '--mac',
      'dmg',
      'zip',
      `--${arch}`
    ],
    {
      env: builderEnv,
      announce: `Building DMG and ZIP from notarized app bundle (${arch})`
    }
  )
}

async function main() {
  const { command, arch, timeoutMs } = parseArgs(process.argv.slice(2))
  const appPath = appBundlePathForArch(arch)

  if (command === 'build-app' || command === 'all') {
    assertEnv('CSC_LINK')
    assertEnv('CSC_KEY_PASSWORD')
  }

  if (command === 'notarize' || command === 'all') {
    assertEnv('APPLE_ID')
    assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
    assertEnv('APPLE_TEAM_ID')
  }

  if (command === 'build-app') {
    await buildSignedAppBundle(arch)
    log(`Signed macOS app build completed for ${arch}`)
    return
  }

  if (command === 'notarize') {
    await fsp.rm(notaryLogsDir(), { recursive: true, force: true })
    if (!fs.existsSync(appPath)) {
      throw new Error(`Signed app bundle not found for notarization: ${appPath}`)
    }
    await notarizeAndStapleApp(appPath, arch, timeoutMs || DEFAULT_TIMEOUT_MS)
    log(`Notarization and stapling completed for ${arch}`)
    return
  }

  if (command === 'package') {
    if (!fs.existsSync(appPath)) {
      throw new Error(`Signed app bundle not found for packaging: ${appPath}`)
    }
    await buildReleaseContainers(appPath, arch)
    log(`Release container packaging completed for ${arch}`)
    return
  }

  await fsp.rm(notaryLogsDir(), { recursive: true, force: true })
  const builtAppPath = await buildSignedAppBundle(arch)
  await notarizeAndStapleApp(builtAppPath, arch, timeoutMs || DEFAULT_TIMEOUT_MS)
  await buildReleaseContainers(builtAppPath, arch)
  log(`Notarized macOS release packaging completed for ${arch}`)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`)
  process.exitCode = 1
})
