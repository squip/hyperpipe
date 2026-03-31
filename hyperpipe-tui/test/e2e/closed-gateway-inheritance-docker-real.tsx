import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { TuiController, type RuntimeOptions } from '../../src/domain/controller.js'
import type { GroupInvite, GroupSummary, LogLevel, RelayEntry } from '../../src/domain/types.js'

type WorkerLabel = 'host' | 'joiner'
type StreamLabel = 'stdout' | 'stderr'

type ScenarioSummary = {
  generatedAt: string
  baseDir: string
  elapsedMs?: number
  gatewayOrigin: string
  docker?: {
    enabled: boolean
    projectName: string
    composeFile: string
    envFile: string
    hostPort: number
  }
  host?: {
    pubkey: string
    stoppedBeforeJoin: boolean
  }
  joiner?: {
    pubkey: string
    selectedPathMode: string | null
    selectedPathPeer: string | null
    relayKey: string | null
    writable: boolean
    readyForReq: boolean
    connectionUrl: string | null
  }
  invite?: {
    id: string
    hasToken: boolean
    hasWriterSecret: boolean
    hasWriterLeaseEnvelope: boolean
    hasGatewayRelayCredential: boolean
    gatewayOrigin: string | null
  }
  telemetry?: {
    sawGatewayCall: boolean
    sawGatewayCallFailed: boolean
    sawStrictNoFallback: boolean
    gatewayCallOrigins: string[]
    routePreflightHostOk: boolean
    routePreflightJoinerOk: boolean
  }
  files: {
    hostWorkerLog: string
    joinerWorkerLog: string
    timelineLog: string
  }
  error?: string
  result: {
    ok: boolean
    reason: string
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso(): string {
  return new Date().toISOString()
}

function logProgress(message: string): void {
  process.stdout.write(`[progress] ${nowIso()} ${message}\n`)
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseMs(value: string | undefined, fallback: number, min = 1000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.trunc(parsed))
}

function normalizeHttpOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}

function getWsProtocolFromHttpOrigin(origin: string): 'ws' | 'wss' {
  return origin.startsWith('http://') ? 'ws' : 'wss'
}

function short(value: string | null | undefined, len = 16): string {
  const text = String(value || '').trim()
  if (!text) return '-'
  if (text.length <= len) return text
  return `${text.slice(0, len)}…`
}

async function waitFor<T>(
  description: string,
  action: () => Promise<T | null>,
  options: {
    timeoutMs?: number
    intervalMs?: number
  } = {}
): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs || 120_000))
  const intervalMs = Math.max(200, Math.trunc(options.intervalMs || 1_000))
  const startedAt = Date.now()
  let lastError: string | null = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await action()
      if (value !== null) return value
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }

  throw new Error(`${description} timed out${lastError ? ` (${lastError})` : ''}`)
}

async function appendLine(file: string, line: string): Promise<void> {
  await fs.appendFile(file, `${line}\n`, 'utf8')
}

async function findOpenPort(preferredPort: number): Promise<number> {
  const probe = (port: number): Promise<boolean> => new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    // Probe all interfaces because docker publishes on 0.0.0.0.
    server.listen(port)
  })

  if (await probe(preferredPort)) return preferredPort

  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('unable-to-allocate-port')))
        return
      }
      const selected = address.port
      server.close(() => resolve(selected))
    })
    server.listen(0)
  })
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdoutFile?: string
    stderrFile?: string
    timeoutMs?: number
  }
): Promise<void> {
  const timeoutMs = Math.max(5_000, Math.trunc(options.timeoutMs || 180_000))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stdout.write(text)
      if (options.stdoutFile) {
        void fs.appendFile(options.stdoutFile, text, 'utf8').catch(() => {})
      }
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stderr.write(text)
      if (options.stderrFile) {
        void fs.appendFile(options.stderrFile, text, 'utf8').catch(() => {})
      }
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
        return
      }
      resolve()
    })
  })
}

type BlindPeerSeed = {
  enabled: boolean
  publicKey?: string | null
  encryptionKey?: string | null
}

async function writeWorkerGatewaySettings(
  storageDir: string,
  gatewayOrigin: string,
  blindPeer: BlindPeerSeed | null = null,
  sharedSecret: string | null = null
): Promise<void> {
  const origin = normalizeHttpOrigin(gatewayOrigin)
  const parsed = new URL(origin)
  const wsProtocol = getWsProtocolFromHttpOrigin(origin)
  const blindPeerKey = (blindPeer?.publicKey || '').trim() || null
  const blindPeerEncryptionKey = (blindPeer?.encryptionKey || '').trim() || null
  const gatewaySharedSecret = typeof sharedSecret === 'string' ? sharedSecret.trim() : ''

  await fs.mkdir(storageDir, { recursive: true })
  await fs.writeFile(
    path.join(storageDir, 'hyperpipe-gateway-settings.json'),
    JSON.stringify({
      gatewayUrl: origin,
      proxyHost: parsed.host,
      proxyWebsocketProtocol: wsProtocol
    }, null, 2),
    'utf8'
  )
  await fs.writeFile(
    path.join(storageDir, 'public-hyperpipe-gateway-settings.json'),
    JSON.stringify({
      enabled: true,
      selectionMode: 'manual',
      preferredBaseUrl: origin,
      baseUrl: origin,
      sharedSecret: gatewaySharedSecret,
      delegateReqToPeers: false,
      blindPeerEnabled: blindPeer?.enabled === true && !!blindPeerKey,
      blindPeerKeys: blindPeerKey ? [blindPeerKey] : [],
      blindPeerManualKeys: blindPeerKey ? [blindPeerKey] : [],
      blindPeerEncryptionKey: blindPeerEncryptionKey || null
    }, null, 2),
    'utf8'
  )
}

async function fetchGatewayBlindPeerSeed(gatewayOrigin: string): Promise<BlindPeerSeed | null> {
  try {
    const response = await fetch(`${gatewayOrigin}/api/blind-peer`)
    if (!response.ok) return null
    const payload = await response.json() as {
      summary?: {
        enabled?: boolean
        running?: boolean
        publicKey?: string | null
        encryptionKey?: string | null
      }
      status?: {
        enabled?: boolean
        running?: boolean
        publicKey?: string | null
        encryptionKey?: string | null
      }
    }
    const summary = payload?.summary || {}
    const status = payload?.status || {}
    const enabled = (summary.enabled === true || status.enabled === true)
      && (summary.running === true || status.running === true)
    const publicKey = typeof summary.publicKey === 'string'
      ? summary.publicKey
      : (typeof status.publicKey === 'string' ? status.publicKey : null)
    const encryptionKey = typeof summary.encryptionKey === 'string'
      ? summary.encryptionKey
      : (typeof status.encryptionKey === 'string' ? status.encryptionKey : null)
    if (!enabled || !publicKey) return null
    return { enabled, publicKey, encryptionKey }
  } catch {
    return null
  }
}

type GatewayMirrorProbe = {
  identifier: string
  relayKey: string | null
  coreRefsCount: number
}

async function fetchGatewayMirrorMetadata(
  gatewayOrigin: string,
  relayIdentifier: string
): Promise<GatewayMirrorProbe | null> {
  const normalizedIdentifier = typeof relayIdentifier === 'string' ? relayIdentifier.trim() : ''
  if (!normalizedIdentifier) return null
  try {
    const response = await fetch(
      `${gatewayOrigin}/api/relays/${encodeURIComponent(normalizedIdentifier)}/mirror`
    )
    if (!response.ok) return null
    const payload = await response.json() as {
      relayKey?: string | null
      relay_key?: string | null
      cores?: unknown[]
    }
    const relayKey =
      typeof payload?.relayKey === 'string'
        ? payload.relayKey
        : (typeof payload?.relay_key === 'string' ? payload.relay_key : null)
    const coreRefsCount = Array.isArray(payload?.cores) ? payload.cores.length : 0
    return {
      identifier: normalizedIdentifier,
      relayKey: relayKey ? relayKey.trim() : null,
      coreRefsCount
    }
  } catch {
    return null
  }
}

async function waitForGatewayMirrorReady(
  gatewayOrigin: string,
  relayIdentifiers: Array<string | null | undefined>,
  timeoutMs = 120_000
): Promise<GatewayMirrorProbe> {
  const candidates = Array.from(
    new Set(
      relayIdentifiers
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    )
  )
  if (!candidates.length) {
    throw new Error('gateway-mirror-preflight-missing-identifiers')
  }

  return await waitFor<GatewayMirrorProbe>(
    `gateway mirror readiness (${candidates.join(', ')})`,
    async () => {
      for (const candidate of candidates) {
        const probe = await fetchGatewayMirrorMetadata(gatewayOrigin, candidate)
        if (probe) return probe
      }
      return null
    },
    { timeoutMs, intervalMs: 1_500 }
  )
}

function isRelayWritable(entry: RelayEntry | null | undefined): boolean {
  return Boolean(entry && entry.writable !== false && entry.readyForReq !== false)
}

class WorkerLogTap {
  private outIndex = 0
  private errIndex = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly label: WorkerLabel,
    private readonly controller: TuiController,
    private readonly onLine: (label: WorkerLabel, stream: StreamLabel, line: string) => void
  ) {}

  start(pollMs = 250): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const state = this.controller.getState()
      if (state.workerStdout.length > this.outIndex) {
        const next = state.workerStdout.slice(this.outIndex)
        this.outIndex = state.workerStdout.length
        for (const line of next) this.onLine(this.label, 'stdout', String(line))
      }
      if (state.workerStderr.length > this.errIndex) {
        const next = state.workerStderr.slice(this.errIndex)
        this.errIndex = state.workerStderr.length
        for (const line of next) this.onLine(this.label, 'stderr', String(line))
      }
    }, Math.max(100, Math.trunc(pollMs)))
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

function attachWorkerEvents(
  label: WorkerLabel,
  controller: TuiController,
  onEvent: (label: WorkerLabel, message: { type?: unknown; data?: unknown }) => void
): () => void {
  try {
    const host = (controller as unknown as {
      workerHost?: {
        onMessage?: (handler: (message: { type?: unknown; data?: unknown }) => void) => () => void
      }
    }).workerHost
    if (!host || typeof host.onMessage !== 'function') return () => {}
    return host.onMessage((message) => onEvent(label, message))
  } catch {
    return () => {}
  }
}

function createComposeFile(repoRoot: string): string {
  return `services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "300", "1"]

  gateway:
    build:
      context: ${repoRoot}
      dockerfile: hyperpipe-gateway/Dockerfile
    environment:
      PORT: 4430
      GATEWAY_TLS_ENABLED: "false"
      GATEWAY_METRICS_ENABLED: "false"
      GATEWAY_RATELIMIT_ENABLED: "false"
      GATEWAY_PUBLIC_URL: \${E2E_GATEWAY_PUBLIC_URL}
      GATEWAY_REGISTRATION_SECRET: \${E2E_GATEWAY_SECRET}
      GATEWAY_REGISTRATION_REDIS: redis://redis:6379
      GATEWAY_REGISTRATION_REDIS_PREFIX: \${E2E_REDIS_PREFIX}
      GATEWAY_REGISTRATION_TTL: "0"
      GATEWAY_MIRROR_METADATA_TTL: "0"
      GATEWAY_OPEN_JOIN_POOL_TTL: "0"
      GATEWAY_OPEN_JOIN_POOL_TTL_MS: "0"
      GATEWAY_BLINDPEER_ENABLED: "true"
      GATEWAY_BLINDPEER_STORAGE: /var/lib/hyperpipe/blind-peer
      GATEWAY_SCOPED_CREDENTIALS_V1: \${E2E_FLAG_SCOPED_CREDENTIALS}
      GATEWAY_CREATOR_POLICY_V1: \${E2E_FLAG_CREATOR_POLICY}
      GATEWAY_POLICY_MODE: \${E2E_GATEWAY_POLICY_MODE}
      GATEWAY_POLICY_ALLOW_LIST: \${E2E_GATEWAY_POLICY_ALLOW_LIST}
      GATEWAY_POLICY_BAN_LIST: ""
      GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT: "true"
    ports:
      - "\${E2E_GATEWAY_HOST_PORT}:4430"
    depends_on:
      - redis
`
}

async function waitForGatewayReady(gatewayOrigin: string, timeoutMs = 90_000): Promise<void> {
  await waitFor(
    'gateway /health',
    async () => {
      const response = await fetch(`${gatewayOrigin}/health`)
      if (!response.ok) return null
      return true
    },
    { timeoutMs, intervalMs: 1_250 }
  )

  await waitFor(
    'gateway blind-peer readiness',
    async () => {
      const response = await fetch(`${gatewayOrigin}/api/blind-peer`)
      if (!response.ok) return null
      const payload = await response.json() as {
        status?: {
          enabled?: boolean
          running?: boolean
        }
      }
      const enabled = payload?.status?.enabled === true
      const running = payload?.status?.running === true
      if (!enabled || !running) return null
      return true
    },
    { timeoutMs, intervalMs: 1_250 }
  )
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const tuiRoot = path.resolve(__dirname, '../..')
  const repoRoot = path.resolve(tuiRoot, '..')
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      'base-dir': { type: 'string' },
      'log-level': { type: 'string' },
      'gateway-port': { type: 'string' },
      'skip-docker': { type: 'string' },
      'keep-docker': { type: 'string' },
      'dry-run': { type: 'string' },
      'gateway-policy-mode': { type: 'string' },
      'routing-only': { type: 'string' }
    }
  })

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const baseDir = parsed.values['base-dir']
    ? path.resolve(process.cwd(), parsed.values['base-dir'])
    : path.join(repoRoot, 'test-logs/relay-scoped-credential-matrix', `closed-gateway-inheritance-host-offline-docker-${runId}`)

  const logLevel = parseLogLevel(parsed.values['log-level'])
  const skipDocker = parseBoolean(parsed.values['skip-docker'], false)
  const keepDocker = parseBoolean(parsed.values['keep-docker'], false)
  const dryRun = parseBoolean(parsed.values['dry-run'], false)
  const routingOnly = parseBoolean(parsed.values['routing-only'], false)
  const preferredGatewayPort = Number.parseInt(parsed.values['gateway-port'] || '4430', 10)
  const gatewayPolicyMode = String(parsed.values['gateway-policy-mode'] || 'closed').trim().toLowerCase() === 'open'
    ? 'open'
    : 'closed'
  const forcedWorkerFlags: Record<string, string> = {
    JOIN_DIRECT_DISCOVERY_V2: 'true',
    RELAY_SCOPED_GATEWAY_V1: 'true',
    GATEWAY_SCOPED_CREDENTIALS_V1: 'true',
    GATEWAY_CREATOR_POLICY_V1: 'true'
  }

  for (const [key, value] of Object.entries(forcedWorkerFlags)) {
    process.env[key] = value
  }

  await fs.mkdir(baseDir, { recursive: true })

  const hostStorage = path.join(os.tmpdir(), `ht-host-${runId}`)
  const joinerStorage = path.join(os.tmpdir(), `ht-joiner-${runId}`)
  await fs.mkdir(hostStorage, { recursive: true })
  await fs.mkdir(joinerStorage, { recursive: true })

  const hostLogFile = path.join(baseDir, 'host-worker.log')
  const joinerLogFile = path.join(baseDir, 'joiner-worker.log')
  const timelineLogFile = path.join(baseDir, 'timeline.log')
  const dockerStdoutFile = path.join(baseDir, 'docker.stdout.log')
  const dockerStderrFile = path.join(baseDir, 'docker.stderr.log')
  const summaryFile = path.join(baseDir, 'summary.json')

  const requestedPort = Number.isFinite(preferredGatewayPort) && preferredGatewayPort > 0
    ? preferredGatewayPort
    : 4430
  const gatewayHostPort = await findOpenPort(requestedPort)
  const gatewayOrigin = normalizeHttpOrigin(`http://127.0.0.1:${gatewayHostPort}`)
  const composeProjectName = `htcred_${runId.replace(/[^a-z0-9_]/gi, '_')}`
  const composeFile = path.join(baseDir, 'docker-compose.yml')
  const envFile = path.join(baseDir, '.env')
  const composeContent = createComposeFile(repoRoot)
  await fs.writeFile(composeFile, composeContent, 'utf8')

  const runtimeHost: RuntimeOptions = {
    cwd: tuiRoot,
    storageDir: hostStorage,
    noAnimations: true,
    logLevel
  }
  const runtimeJoiner: RuntimeOptions = {
    cwd: tuiRoot,
    storageDir: joinerStorage,
    noAnimations: true,
    logLevel
  }

  const host = new TuiController(runtimeHost)
  const joiner = new TuiController(runtimeJoiner)

  const hostLines: string[] = []
  const joinerLines: string[] = []
  let selectedPathMode: string | null = null
  let selectedPathPeer: string | null = null
  let sawGatewayCall = false
  let sawGatewayCallFailed = false
  let sawStrictNoFallback = false
  let inviteHasGatewayCredential = false
  let hostStoppedBeforeJoin = false
  let routePreflightHostOk = false
  let routePreflightJoinerOk = false
  const gatewayCallOrigins = new Set<string>()

  const onLine = (label: WorkerLabel, stream: StreamLabel, line: string): void => {
    const message = String(line || '').trim()
    const stamped = `[${nowIso()}] [${label} ${stream}] ${message}`
    process.stdout.write(`${stamped}\n`)
    void appendLine(label === 'host' ? hostLogFile : joinerLogFile, stamped).catch(() => {})
    void appendLine(timelineLogFile, stamped).catch(() => {})
    if (label === 'host') hostLines.push(message)
    else joinerLines.push(message)

    if (message.includes('JOIN_PATH_SELECTED')) {
      const modeMatch = message.match(/mode:\s*'([^']+)'/)
      const peerMatch = message.match(/peerKey:\s*'([^']+)'/)
      if (modeMatch?.[1]) selectedPathMode = modeMatch[1]
      if (peerMatch?.[1]) selectedPathPeer = peerMatch[1]
    }
  }

  const onEvent = (label: WorkerLabel, message: { type?: unknown; data?: unknown }): void => {
    const type = String(message?.type || '')
    if (!type) return
    const interested = new Set([
      'RELAY_GATEWAY_CALL',
      'RELAY_GATEWAY_CALL_FAILED',
      'RELAY_GATEWAY_STRICT_NO_FALLBACK',
      'JOIN_PATH_SELECTED'
    ])
    if (!interested.has(type)) return
    const stamped = `[${nowIso()}] [${label} ipc] ${JSON.stringify({ type, data: message?.data ?? null })}`
    process.stdout.write(`${stamped}\n`)
    void appendLine(timelineLogFile, stamped).catch(() => {})

    if (type === 'JOIN_PATH_SELECTED') {
      const payload = message?.data && typeof message.data === 'object'
        ? message.data as Record<string, unknown>
        : {}
      const mode = typeof payload.mode === 'string' ? payload.mode.trim() : ''
      const peer = typeof payload.peerKey === 'string' ? payload.peerKey.trim() : ''
      selectedPathMode = mode || null
      selectedPathPeer = peer || null
    } else if (type === 'RELAY_GATEWAY_CALL') {
      sawGatewayCall = true
      const payload = message?.data && typeof message.data === 'object'
        ? message.data as Record<string, unknown>
        : {}
      const origin = typeof payload.origin === 'string' ? payload.origin.trim() : ''
      if (origin) gatewayCallOrigins.add(origin)
    } else if (type === 'RELAY_GATEWAY_CALL_FAILED') {
      sawGatewayCallFailed = true
    } else if (type === 'RELAY_GATEWAY_STRICT_NO_FALLBACK') {
      sawStrictNoFallback = true
    }
  }

  const hostTap = new WorkerLogTap('host', host, onLine)
  const joinerTap = new WorkerLogTap('joiner', joiner, onLine)
  hostTap.start()
  joinerTap.start()
  const detachHost = attachWorkerEvents('host', host, onEvent)
  const detachJoiner = attachWorkerEvents('joiner', joiner, onEvent)

  const startedAt = Date.now()
  let summary: ScenarioSummary = {
    generatedAt: nowIso(),
    baseDir,
    gatewayOrigin,
    files: {
      hostWorkerLog: hostLogFile,
      joinerWorkerLog: joinerLogFile,
      timelineLog: timelineLogFile
    },
    result: {
      ok: false,
      reason: 'initialized'
    }
  }

  try {
    logProgress('initialize controllers and accounts')
    await host.initialize()
    await joiner.initialize()

    const hostAccount = await host.generateNsecAccount(`host-${runId}`)
    const joinerAccount = await joiner.generateNsecAccount(`joiner-${runId}`)
    await host.selectAccount(hostAccount.pubkey)
    await host.unlockCurrentAccount()
    await joiner.selectAccount(joinerAccount.pubkey)
    await joiner.unlockCurrentAccount()

    const gatewayRegistrationSecret = `e2e-registration-secret-${runId}`
    process.env.PUBLIC_GATEWAY_ENABLED = 'true'
    process.env.PUBLIC_GATEWAY_URL = gatewayOrigin
    process.env.PUBLIC_GATEWAY_SECRET = gatewayRegistrationSecret

    const env = [
      `E2E_GATEWAY_HOST_PORT=${gatewayHostPort}`,
      `E2E_GATEWAY_PUBLIC_URL=${gatewayOrigin}`,
      `E2E_GATEWAY_SECRET=${gatewayRegistrationSecret}`,
      `E2E_REDIS_PREFIX=e2e:relay-scoped-cred:${runId}:`,
      `E2E_FLAG_SCOPED_CREDENTIALS=${process.env.GATEWAY_SCOPED_CREDENTIALS_V1 || 'true'}`,
      `E2E_FLAG_CREATOR_POLICY=${process.env.GATEWAY_CREATOR_POLICY_V1 || 'true'}`,
      `E2E_GATEWAY_POLICY_MODE=${gatewayPolicyMode}`,
      `E2E_GATEWAY_POLICY_ALLOW_LIST=${hostAccount.pubkey}`
    ].join('\n')
    await fs.writeFile(envFile, `${env}\n`, 'utf8')

    if (dryRun) {
      summary = {
        generatedAt: nowIso(),
        baseDir,
        gatewayOrigin,
        docker: {
          enabled: !skipDocker,
          projectName: composeProjectName,
          composeFile,
          envFile,
          hostPort: gatewayHostPort
        },
        files: {
          hostWorkerLog: hostLogFile,
          joinerWorkerLog: joinerLogFile,
          timelineLog: timelineLogFile
        },
        result: {
          ok: true,
          reason: 'dry-run'
        }
      }
    } else {
      if (!skipDocker) {
        logProgress(`docker up project=${composeProjectName} gateway=${gatewayOrigin}`)
        await runCommand(
          'docker',
          ['compose', '--env-file', envFile, '-f', composeFile, '-p', composeProjectName, 'up', '-d', '--build'],
          {
            cwd: baseDir,
            stdoutFile: dockerStdoutFile,
            stderrFile: dockerStderrFile,
            timeoutMs: 300_000
          }
        )
      }

      logProgress(`gateway preflight ${gatewayOrigin}`)
      await waitForGatewayReady(gatewayOrigin, 90_000)
      const blindPeerSeed = await fetchGatewayBlindPeerSeed(gatewayOrigin)
      if (!blindPeerSeed?.enabled || !blindPeerSeed.publicKey || !blindPeerSeed.encryptionKey) {
        throw new Error('gateway-preflight-failed: blind-peer seed unavailable or incomplete')
      }

      logProgress('pre-seed per-worker gateway settings')
      await Promise.all([
        writeWorkerGatewaySettings(hostStorage, gatewayOrigin, blindPeerSeed, gatewayRegistrationSecret),
        writeWorkerGatewaySettings(joinerStorage, gatewayOrigin, blindPeerSeed, gatewayRegistrationSecret)
      ])

      logProgress(`start workers host=${short(hostAccount.pubkey)} joiner=${short(joinerAccount.pubkey)}`)
      await host.startWorker()
      await joiner.startWorker()

      routePreflightHostOk = await waitFor(
        'host route preflight',
        async () => {
          if (hostLines.some((line) => line.includes(`gatewayUrl: '${gatewayOrigin}'`) || (line.includes('gatewayUrl') && line.includes(gatewayOrigin)))) {
            return true
          }
          return null
        },
        { timeoutMs: 45_000, intervalMs: 500 }
      )
      routePreflightJoinerOk = await waitFor(
        'joiner route preflight',
        async () => {
          if (joinerLines.some((line) => line.includes(`gatewayUrl: '${gatewayOrigin}'`) || (line.includes('gatewayUrl') && line.includes(gatewayOrigin)))) {
            return true
          }
          return null
        },
        { timeoutMs: 45_000, intervalMs: 500 }
      )
      if (!routePreflightHostOk || !routePreflightJoinerOk) {
        throw new Error('route-preflight-failed')
      }
      if (hostLines.some((line) => line.includes("gatewayUrl: 'https://hypertuna.com'"))) {
        throw new Error('host-route-fell-back-to-global-default')
      }
      if (joinerLines.some((line) => line.includes("gatewayUrl: 'https://hypertuna.com'"))) {
        throw new Error('joiner-route-fell-back-to-global-default')
      }

      await Promise.allSettled([
        host.refreshRelays(), host.refreshGroups(), host.refreshInvites(),
        joiner.refreshRelays(), joiner.refreshGroups(), joiner.refreshInvites()
      ])

      const relayName = `closed-gw-inherit-${runId}`
      logProgress(`host create closed relay ${relayName}`)
      await host.createRelay({
        name: relayName,
        description: 'Closed gateway inheritance deterministic docker test',
        isPublic: true,
        isOpen: false,
        fileSharing: true,
        gatewayOrigin
      })

      const group = await waitFor<GroupSummary>(
        'group created',
        async () => {
          await host.refreshGroups()
          return host.getState().myGroups.find((entry) => entry.name === relayName) || null
        },
        { timeoutMs: 120_000, intervalMs: 1_200 }
      )

      const hostCreateFatal = hostLines.find((line) =>
        line.includes('Autobase is closing')
        || line.includes('Relay manager not found for key')
        || line.includes('Relay not found:')
      ) || null
      if (hostCreateFatal) {
        throw new Error(`host-create-relay-unstable: ${hostCreateFatal}`)
      }

      const hostCreatedRelay = await waitFor<RelayEntry>(
        'host created relay writable',
        async () => {
          await host.refreshRelays()
          const relay = host.getState().relays.find((entry) => entry.publicIdentifier === group.id) || null
          if (!relay) return null
          if (!isRelayWritable(relay)) return null
          return relay
        },
        { timeoutMs: 120_000, intervalMs: 1_200 }
      )

      logProgress(`host send invite group=${short(group.id, 24)}`)
      await host.sendInvite({
        groupId: group.id,
        relayUrl: group.relay || '',
        inviteePubkey: joinerAccount.pubkey,
        token: `closed-token-${runId}`,
        payload: {
          groupName: group.name || group.id,
          isPublic: true,
          isOpen: false,
          fileSharing: true,
          gatewayOrigin
        }
      })

      const invite = await waitFor<GroupInvite>(
        'joiner invite received',
        async () => {
          await joiner.refreshInvites()
          return joiner.getState().groupInvites.find((entry) => entry.groupId === group.id) || null
        },
        { timeoutMs: 120_000, intervalMs: 1_250 }
      )

      inviteHasGatewayCredential = Boolean(
        (typeof invite.gatewayOrigin === 'string' && invite.gatewayOrigin.trim())
        || (typeof invite.gatewayId === 'string' && invite.gatewayId.trim())
      )
      if (!invite.writerSecret || !(invite.writerCoreHex || invite.autobaseLocal || invite.writerCore)) {
        throw new Error('invalid-closed-invite-missing-writer-material')
      }
      if (!invite.relayKey || !/^[a-f0-9]{64}$/i.test(String(invite.relayKey))) {
        throw new Error('invalid-closed-invite-missing-relay-key')
      }

      logProgress('gateway mirror preflight for invite relay')
      const mirrorProbe = await waitForGatewayMirrorReady(
        gatewayOrigin,
        [invite.relayKey, hostCreatedRelay.relayKey, group.id],
        120_000
      )
      logProgress(
        `gateway mirror ready identifier=${mirrorProbe.identifier} `
        + `relayKey=${short(mirrorProbe.relayKey, 16)} cores=${mirrorProbe.coreRefsCount}`
      )

      if (routingOnly) {
        summary = {
          generatedAt: nowIso(),
          baseDir,
          elapsedMs: Date.now() - startedAt,
          gatewayOrigin,
          docker: {
            enabled: !skipDocker,
            projectName: composeProjectName,
            composeFile,
            envFile,
            hostPort: gatewayHostPort
          },
          host: {
            pubkey: hostAccount.pubkey,
            stoppedBeforeJoin: false
          },
          joiner: {
            pubkey: joinerAccount.pubkey,
            selectedPathMode,
            selectedPathPeer,
            relayKey: null,
            writable: false,
            readyForReq: false,
            connectionUrl: null
          },
          invite: {
            id: invite.id,
            hasToken: Boolean(invite.token),
            hasWriterSecret: Boolean(invite.writerSecret),
            hasWriterLeaseEnvelope: Boolean(invite.writerLeaseEnvelope),
            hasGatewayRelayCredential: inviteHasGatewayCredential,
            gatewayOrigin: invite.gatewayOrigin || null
          },
          telemetry: {
            sawGatewayCall,
            sawGatewayCallFailed,
            sawStrictNoFallback,
            gatewayCallOrigins: Array.from(gatewayCallOrigins),
            routePreflightHostOk,
            routePreflightJoinerOk
          },
          files: {
            hostWorkerLog: hostLogFile,
            joinerWorkerLog: joinerLogFile,
            timelineLog: timelineLogFile
          },
          result: {
            ok: Boolean(
              routePreflightHostOk
              && routePreflightJoinerOk
              && inviteHasGatewayCredential
              && mirrorProbe?.relayKey
            ),
            reason: 'routing-preflight-pass'
          }
        }
        return
      }

      logProgress('stop host before join')
      await host.stopWorker()
      hostStoppedBeforeJoin = host.getState().lifecycle !== 'ready'

      logProgress('joiner startJoinFlow (gateway-only expected)')
      await joiner.startJoinFlow({
        publicIdentifier: invite.groupId,
        relayKey: invite.relayKey || undefined,
        relayUrl: invite.relay || invite.relayUrl || group.relay || undefined,
        token: invite.token,
        isOpen: false,
        openJoin: false,
        directJoinOnly: invite.directJoinOnly === true,
        gatewayOrigin: invite.gatewayOrigin || gatewayOrigin,
        gatewayId: invite.gatewayId || undefined,
        discoveryTopic: invite.discoveryTopic || undefined,
        hostPeerKeys: invite.hostPeerKeys || undefined,
        leaseReplicaPeerKeys: invite.leaseReplicaPeerKeys || undefined,
        writerIssuerPubkey: invite.writerIssuerPubkey || undefined,
        writerLeaseEnvelope: invite.writerLeaseEnvelope || undefined,
        blindPeer: invite.blindPeer || undefined,
        cores: invite.cores || undefined,
        writerCore: invite.writerCore || undefined,
        writerCoreHex: invite.writerCoreHex || undefined,
        autobaseLocal: invite.autobaseLocal || undefined,
        writerSecret: invite.writerSecret || undefined,
        fastForward: invite.fastForward || undefined
      })

      const joinedRelay = await waitFor<RelayEntry>(
        'joiner writable relay',
        async () => {
          const relay = joiner.getState().relays.find((entry) => entry.publicIdentifier === group.id) || null
          if (!relay) return null
          if (!isRelayWritable(relay)) return null
          return relay
        },
        { timeoutMs: 180_000, intervalMs: 1_250 }
      )

      summary = {
        generatedAt: nowIso(),
        baseDir,
        elapsedMs: Date.now() - startedAt,
        gatewayOrigin,
        docker: {
          enabled: !skipDocker,
          projectName: composeProjectName,
          composeFile,
          envFile,
          hostPort: gatewayHostPort
        },
        host: {
          pubkey: hostAccount.pubkey,
          stoppedBeforeJoin: hostStoppedBeforeJoin
        },
        joiner: {
          pubkey: joinerAccount.pubkey,
          selectedPathMode,
          selectedPathPeer,
          relayKey: joinedRelay.relayKey || null,
          writable: joinedRelay.writable !== false,
          readyForReq: joinedRelay.readyForReq !== false,
          connectionUrl: joinedRelay.connectionUrl || null
        },
        invite: {
          id: invite.id,
          hasToken: Boolean(invite.token),
          hasWriterSecret: Boolean(invite.writerSecret),
          hasWriterLeaseEnvelope: Boolean(invite.writerLeaseEnvelope),
          hasGatewayRelayCredential: inviteHasGatewayCredential,
          gatewayOrigin: invite.gatewayOrigin || null
        },
        telemetry: {
          sawGatewayCall,
          sawGatewayCallFailed,
          sawStrictNoFallback,
          gatewayCallOrigins: Array.from(gatewayCallOrigins),
          routePreflightHostOk,
          routePreflightJoinerOk
        },
        files: {
          hostWorkerLog: hostLogFile,
          joinerWorkerLog: joinerLogFile,
          timelineLog: timelineLogFile
        },
        result: {
          ok: Boolean(
            hostStoppedBeforeJoin
            && inviteHasGatewayCredential
            && sawGatewayCall
            && isRelayWritable(joinedRelay)
          ),
          reason: hostStoppedBeforeJoin
            ? (sawGatewayCall
              ? 'closed-gateway-inheritance-host-offline-pass'
              : 'joined-but-no-gateway-call-telemetry')
            : 'host-not-stopped-before-join'
        }
      }
    }
  } catch (error) {
    summary = {
      generatedAt: nowIso(),
      baseDir,
      gatewayOrigin,
      docker: {
        enabled: !skipDocker,
        projectName: composeProjectName,
        composeFile,
        envFile,
        hostPort: gatewayHostPort
      },
      telemetry: {
        sawGatewayCall,
        sawGatewayCallFailed,
        sawStrictNoFallback,
        gatewayCallOrigins: Array.from(gatewayCallOrigins),
        routePreflightHostOk,
        routePreflightJoinerOk
      },
      files: {
        hostWorkerLog: hostLogFile,
        joinerWorkerLog: joinerLogFile,
        timelineLog: timelineLogFile
      },
      error: error instanceof Error ? (error.stack || error.message) : String(error),
      result: {
        ok: false,
        reason: 'exception'
      }
    }
  } finally {
    detachHost()
    detachJoiner()
    hostTap.stop()
    joinerTap.stop()

    await Promise.allSettled([
      host.shutdown(),
      joiner.shutdown()
    ])

    if (!dryRun && !skipDocker && !keepDocker) {
      try {
        logProgress(`docker down project=${composeProjectName}`)
        await runCommand(
          'docker',
          ['compose', '--env-file', envFile, '-f', composeFile, '-p', composeProjectName, 'down', '-v', '--remove-orphans'],
          {
            cwd: baseDir,
            stdoutFile: dockerStdoutFile,
            stderrFile: dockerStderrFile,
            timeoutMs: 180_000
          }
        )
      } catch (error) {
        const line = `[warn] docker cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        process.stderr.write(`${line}\n`)
        void appendLine(timelineLogFile, line).catch(() => {})
      }
    }

    await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`[output] ${summaryFile}\n`)
    if (!summary.result.ok) process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
