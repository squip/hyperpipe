#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { fileURLToPath } = require('node:url')

const PROJECT_DIR = path.resolve(__dirname, '..')
const NOTARIZATION_DIR = path.join(PROJECT_DIR, '.notarization')
const POLL_INTERVAL_MS = 15000
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000

function usage() {
  return [
    'Usage:',
    '  node ./scripts/build-notarized-mac-release.cjs <command> --bundle-root <dir> --archive-path <file> --arch <x64|arm64> [--timeout-minutes <minutes>]',
    '',
    'Commands:',
    '  sign-archive  Sign Mach-O payloads inside the portable bundle and zip it with ditto',
    '  notarize      Submit an existing zip archive to Apple, wait for acceptance, and fetch the notary log',
    '  all           Run sign-archive and notarize in sequence',
    '',
    'Required env for sign-archive/all:',
    '  CSC_LINK',
    '  CSC_KEY_PASSWORD',
    '',
    'Required env for notarize/all:',
    '  APPLE_ID',
    '  APPLE_APP_SPECIFIC_PASSWORD',
    '  APPLE_TEAM_ID'
  ].join('\n')
}

function parseArgs(argv) {
  let command = ''
  let bundleRoot = ''
  let archivePath = ''
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
    if (token === '--bundle-root') {
      bundleRoot = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    if (token === '--archive-path') {
      archivePath = String(argv[index + 1] || '').trim()
      index += 1
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

  if (!command || !['sign-archive', 'notarize', 'all'].includes(command)) {
    throw new Error('Missing or invalid command. Expected sign-archive, notarize, or all.')
  }
  if (!bundleRoot) {
    throw new Error('Missing required --bundle-root argument.')
  }
  if (!archivePath) {
    throw new Error('Missing required --archive-path argument.')
  }
  if (!arch || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Missing or invalid --arch value. Expected x64 or arm64.')
  }
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('Missing or invalid --timeout-minutes value.')
  }

  return {
    command,
    bundleRoot: path.resolve(bundleRoot),
    archivePath: path.resolve(archivePath),
    arch,
    timeoutMs: timeoutMinutes * 60 * 1000
  }
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
  try {
    return JSON.parse(result.stdout)
  } catch (_) {
    throw new Error(`Failed to parse JSON from ${command}: ${result.stdout || result.stderr}`)
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function findMachOFiles(rootDir) {
  const queue = [rootDir]
  const result = []

  while (queue.length > 0) {
    const current = queue.pop()
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const targetPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(targetPath)
        continue
      }
      if (!entry.isFile()) continue
      const inspection = await run('file', ['-b', targetPath], { capture: true })
      if (inspection.stdout.includes('Mach-O')) {
        result.push(targetPath)
      }
    }
  }

  return result.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length || left.localeCompare(right))
}

async function resolveCertificateFile(tempDir) {
  const cscLink = assertEnv('CSC_LINK')
  if (/^file:\/\//.test(cscLink)) {
    return fileURLToPath(cscLink)
  }
  if (/^https?:\/\//.test(cscLink)) {
    const response = await fetch(cscLink)
    if (!response.ok) {
      throw new Error(`Failed to download CSC_LINK certificate (${response.status} ${response.statusText})`)
    }
    const certPath = path.join(tempDir, 'certificate.p12')
    await fsp.writeFile(certPath, Buffer.from(await response.arrayBuffer()))
    return certPath
  }
  if (fs.existsSync(cscLink)) {
    return path.resolve(cscLink)
  }

  const certPath = path.join(tempDir, 'certificate.p12')
  await fsp.writeFile(certPath, Buffer.from(cscLink, 'base64'))
  return certPath
}

async function listUserKeychains() {
  const result = await run('security', ['list-keychains', '-d', 'user'], { capture: true })
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^"/, '').replace(/"$/, ''))
}

async function defaultKeychain() {
  const result = await run('security', ['default-keychain', '-d', 'user'], { capture: true })
  return result.stdout.trim().replace(/^"/, '').replace(/"$/, '')
}

async function findSigningIdentity(keychainPath) {
  const result = await run('security', ['find-identity', '-v', '-p', 'codesigning', keychainPath], { capture: true })
  const lines = result.stdout.split('\n')
  const requestedName = String(process.env.CSC_NAME || '').trim()

  let firstDeveloperId = ''
  for (const line of lines) {
    const match = line.match(/"([^"]+)"/)
    if (!match) continue
    const identity = match[1]
    if (requestedName && identity.includes(requestedName)) {
      return identity
    }
    if (!firstDeveloperId && identity.includes('Developer ID Application')) {
      firstDeveloperId = identity
    }
  }

  if (firstDeveloperId) {
    return firstDeveloperId
  }

  throw new Error(`No Developer ID Application signing identity found in ${keychainPath}`)
}

async function withImportedSigningIdentity(callback) {
  const cscPassword = assertEnv('CSC_KEY_PASSWORD')
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyperpipe-tui-signing-'))
  const keychainPath = path.join(tempDir, 'build.keychain-db')
  const keychainPassword = `codex-${Date.now()}`
  const originalKeychains = await listUserKeychains()
  const originalDefault = await defaultKeychain()
  const certPath = await resolveCertificateFile(tempDir)
  const resolvedCertPath = path.resolve(certPath)

  try {
    await run('security', ['create-keychain', '-p', keychainPassword, keychainPath])
    await run('security', ['set-keychain-settings', '-lut', '21600', keychainPath])
    await run('security', ['unlock-keychain', '-p', keychainPassword, keychainPath])
    await run('security', ['import', String(resolvedCertPath), '-k', keychainPath, '-P', cscPassword, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
    await run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychainPassword, keychainPath])
    await run('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...originalKeychains])
    await run('security', ['default-keychain', '-d', 'user', '-s', keychainPath])

    const identity = await findSigningIdentity(keychainPath)
    return await callback(identity)
  } finally {
    await run('security', ['default-keychain', '-d', 'user', '-s', originalDefault], { allowFailure: true })
    if (originalKeychains.length > 0) {
      await run('security', ['list-keychains', '-d', 'user', '-s', ...originalKeychains], { allowFailure: true })
    }
    await run('security', ['delete-keychain', keychainPath], { allowFailure: true })
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
}

async function signBundle(bundleRoot) {
  const machOFiles = await findMachOFiles(bundleRoot)
  if (machOFiles.length === 0) {
    throw new Error(`No Mach-O payloads found to sign under ${bundleRoot}`)
  }

  await withImportedSigningIdentity(async (identity) => {
    log(`Using signing identity: ${identity}`)
    for (const filePath of machOFiles) {
      await run(
        'codesign',
        ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', filePath],
        { announce: `Signing ${path.relative(bundleRoot, filePath)}` }
      )
      await run('codesign', ['--verify', '--strict', '--verbose=2', filePath], {
        announce: `Verifying ${path.relative(bundleRoot, filePath)}`
      })
    }
  })
}

async function archiveBundle(bundleRoot, archivePath) {
  await fsp.mkdir(path.dirname(archivePath), { recursive: true })
  await fsp.rm(archivePath, { force: true })
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundleRoot, archivePath], {
    announce: `Creating macOS distribution archive ${path.basename(archivePath)}`
  })
}

async function submitForNotarization(archivePath) {
  const appleId = assertEnv('APPLE_ID')
  const password = assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = assertEnv('APPLE_TEAM_ID')

  return runJson(
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

  await fsp.mkdir(NOTARIZATION_DIR, { recursive: true })
  const logPath = path.join(NOTARIZATION_DIR, `notary-log-${arch}.json`)
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

async function notarizeArchive(archivePath, arch, timeoutMs) {
  await fsp.mkdir(NOTARIZATION_DIR, { recursive: true })
  const submission = await submitForNotarization(archivePath)
  const submissionId = String(submission.id || '').trim()
  if (!submissionId) {
    throw new Error(`Apple notarization submission did not return an id: ${JSON.stringify(submission, null, 2)}`)
  }

  const statusPath = path.join(NOTARIZATION_DIR, `notary-status-${arch}.json`)
  const summaryPath = path.join(NOTARIZATION_DIR, `notary-summary-${arch}.json`)
  const pollHistory = []
  const deadline = Date.now() + timeoutMs
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
      archivePath: path.basename(archivePath),
      submissionId,
      latestStatus: status,
      attempts,
      pollHistory
    })
    log(`Apple notarization status (${arch}): ${status}${message ? ` - ${message}` : ''}`)

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
      archivePath: path.basename(archivePath),
      submissionId,
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
  await writeJson(summaryPath, {
    arch,
    archivePath: path.basename(archivePath),
    submissionId,
    completedAt: timestamp(),
    accepted: true,
    finalInfo,
    logPath
  })
  log(`Apple notarization accepted for ${arch}. Log saved to ${logPath}`)
}

async function main() {
  const { command, bundleRoot, archivePath, arch, timeoutMs } = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(bundleRoot)) {
    throw new Error(`Bundle root not found: ${bundleRoot}`)
  }

  if (command === 'sign-archive' || command === 'all') {
    assertEnv('CSC_LINK')
    assertEnv('CSC_KEY_PASSWORD')
  }
  if (command === 'notarize' || command === 'all') {
    assertEnv('APPLE_ID')
    assertEnv('APPLE_APP_SPECIFIC_PASSWORD')
    assertEnv('APPLE_TEAM_ID')
  }

  if (command === 'sign-archive') {
    await signBundle(bundleRoot)
    await archiveBundle(bundleRoot, archivePath)
    return
  }

  if (command === 'notarize') {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Archive path not found for notarization: ${archivePath}`)
    }
    await notarizeArchive(archivePath, arch, timeoutMs || DEFAULT_TIMEOUT_MS)
    return
  }

  await fsp.rm(NOTARIZATION_DIR, { recursive: true, force: true })
  await signBundle(bundleRoot)
  await archiveBundle(bundleRoot, archivePath)
  await notarizeArchive(archivePath, arch, timeoutMs || DEFAULT_TIMEOUT_MS)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`)
  process.exitCode = 1
})
