import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TuiController, type RuntimeOptions } from '../../src/domain/controller.js'
import type { GroupInvite, GroupSummary, LogLevel, RelayEntry } from '../../src/domain/types.js'

type PhaseId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
type PhaseStatus = 'PASS' | 'FAIL' | 'SKIP'
type ScenarioStatus = 'PASS' | 'FAIL'
type CheckpointStatus = 'pass' | 'fail' | 'skip'
type GatewayRuntime = 'docker' | 'local'
type JoinType = 'open' | 'closed'
type HostAvailability = 'online' | 'offline'
type GatewayAvailability = 'online' | 'offline'
type GatewayCallPolicy = 'required' | 'optional' | 'forbidden'
type MetadataPolicy = 'strict' | 'lenient'
type WorkerLabel = 'host' | 'joiner'
type StreamLabel = 'stdout' | 'stderr'

type ScenarioManifest = {
  scenarioId: string
  joinType: JoinType
  hostAvailability: HostAvailability
  gatewayAvailability: GatewayAvailability
  directJoinOnly: boolean
  gatewayOrigin?: string | null
  gatewayId?: string | null
  gatewayCallPolicy: GatewayCallPolicy
  metadataPolicy?: MetadataPolicy
  expectedPathModes?: string[]
  expectJoinSuccess?: boolean
  expectFailureContains?: string
  omitGatewayAssignment?: boolean
}

type JoinCheckpoint = {
  scenarioId: string
  correlationId: string
  phase: string
  expected: Record<string, unknown>
  actual: Record<string, unknown>
  status: CheckpointStatus
  ts: string
}

type GatewayTrace = {
  scenarioId: string
  correlationId: string
  relayKey: string | null
  gatewayOrigin: string
  route: string
  status: 'attempt' | 'ok' | 'error'
  authState: 'none' | 'signed' | 'verified' | 'failed'
  requestId: string
  ts: string
}

type GatewayStageStatus = 'attempt' | 'ok' | 'error' | 'skipped'

type GatewayStageEvent = {
  scenarioId: string
  correlationId: string
  route: string
  stage: string
  status: GatewayStageStatus
  relayIdentifier: string | null
  relayKey: string | null
  gatewayOrigin: string | null
  reason: string | null
  error: string | null
  errorCode: string | null
  statusCode: number | null
  details: Record<string, unknown> | null
  ts: string
}

type JoinCheckpointTraceEvent = {
  scenarioId: string
  correlationId: string
  worker: WorkerLabel
  phase: string
  payload: Record<string, unknown>
  ts: string
}

type ScenarioVerdict = {
  ok: boolean
  status: ScenarioStatus
  reason: string
  firstFailedCheckpoint?: string | null
  elapsedMs: number
  selectedPathMode: string | null
  selectedPathPeer: string | null
  writable: boolean
  joinError: string | null
}

type ScenarioRunArtifacts = {
  timelineFile: string
  checkpointsFile: string
  gatewayTraceFile: string
  joinCheckpointTraceFile: string
  verdictFile: string
  hostLogFile: string
  joinerLogFile: string
  dockerStdoutFile: string | null
  dockerStderrFile: string | null
  summaryFile: string
}

type ScenarioRunResult = {
  scenario: ScenarioManifest
  correlationId: string
  startedAt: string
  endedAt: string
  elapsedMs: number
  gatewayOrigin: string | null
  gatewaySecret: string | null
  checkpoints: JoinCheckpoint[]
  gatewayTrace: GatewayTrace[]
  joinCheckpointTrace: JoinCheckpointTraceEvent[]
  artifacts: ScenarioRunArtifacts
  verdict: ScenarioVerdict
  error?: string | null
}

type ScenarioAccount = {
  pubkey: string
  nsec: string
  label?: string
}

type ScenarioSession = {
  pubkey: string
  nsecHex: string
  nsec: string
} | null

type ScenarioPostJoinValidateContext = {
  scenarioDir: string
  hostStorage: string
  joinerStorage: string
  host: TuiController
  joiner: TuiController
  hostAccount: ScenarioAccount
  joinerAccount: ScenarioAccount
  hostSession: ScenarioSession
  joinerSession: ScenarioSession
  createdGroup: GroupSummary
  createdHostRelay: RelayEntry
  invite: GroupInvite | null
  discovered: GroupSummary | null
  joinedRelay: RelayEntry
  joinerRelayKey: string | null
  gatewayOrigin: string | null
  gatewaySecret: string | null
  gatewayTrace: GatewayTrace[]
  gatewayStages: GatewayStageEvent[]
  checkpoints: JoinCheckpoint[]
  joinCheckpointTrace: JoinCheckpointTraceEvent[]
  emitTimeline: (event: string, payload?: Record<string, unknown>) => Promise<void>
  recordCheckpoint: (
    phase: string,
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
    status: CheckpointStatus
  ) => Promise<JoinCheckpoint>
  assertCheckpoint: (
    phase: string,
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
    predicate: boolean,
    failureReason: string
  ) => Promise<void>
  waitForGatewayStageCheckpoint: (options: {
    phase: string
    expected: Record<string, unknown>
    timeoutMs: number
    match: (entry: GatewayStageEvent) => boolean
    failOn?: (entry: GatewayStageEvent) => boolean
    failureReason: string
  }) => Promise<void>
}

type PhaseCheck = {
  name: string
  ok: boolean
  detail: string
}

type PhaseResult = {
  phase: PhaseId
  name: string
  status: PhaseStatus
  startedAt: string
  endedAt: string
  elapsedMs: number
  reason: string
  checks: PhaseCheck[]
  summaryFile: string
  scenarioResults?: ScenarioRunResult[]
  data?: Record<string, unknown>
}

type BaselineScenarioKey = `${JoinType}:${HostAvailability}`

type BaselineFreeze = {
  generatedAt: string
  baselineLogs: string[]
  requiredMarkers: string[]
  scenarioPathHints: Record<BaselineScenarioKey, string[]>
  reports: Array<{
    file: string
    exists: boolean
    markers: Record<string, number>
    detectedPathModes: string[]
  }>
}

type TraceParserState = {
  route: string | null
  status: 'attempt' | 'ok' | 'error'
  authState: 'none' | 'signed' | 'verified' | 'failed'
  ttl: number
}

type GatewayStack = {
  runtime: GatewayRuntime
  origin: string
  secret: string
  hostPort: number
  blindPeerDhtPort: number
  blindPeerDhtPortEnd: number
  composeProjectName: string | null
  composeFile: string | null
  envFile: string | null
  dockerStdoutFile: string
  dockerStderrFile: string
  localProcess?: ReturnType<typeof spawn> | null
}

const DEFAULT_BASELINE_LOGS = [
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/closed-join-local-worker-gateway-mode-auto-both-online.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/closed-join-local-worker-gateway-mode-auto-host-offline.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/open-join-local-worker-gateway-mode-auto-both-online.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/open-join-local-worker-gateway-mode-auto-host-offline.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test18/closed-join-gatewayMode-auto-gateway-offline-PASS/local-worker.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test18/open-join-gatewayMode-auto-gateway-offline-PASS/local-worker.log'
]

const BASELINE_MARKERS = [
  'Start join flow input',
  'Start join flow resolved',
  'JOIN_PATH_SELECTED',
  'Mirror metadata request',
  'Open join bootstrap response',
  'Join auth writer material',
  'relay-writable-'
]

const CHECKPOINT_TIMEOUTS = {
  metadata: 60_000,
  joinInput: 45_000,
  joinResolved: 60_000,
  pathSelected: 90_000,
  gatewayDispatch: 90_000,
  gatewayResponse: 90_000,
  writerMaterial: 120_000,
  writable: 240_000,
  error: 120_000
}

class CheckpointFailure extends Error {
  checkpoint: JoinCheckpoint

  constructor(message: string, checkpoint: JoinCheckpoint) {
    super(message)
    this.checkpoint = checkpoint
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function logProgress(message: string): void {
  process.stdout.write(`[relay-scoped-validation] ${nowIso()} ${message}\n`)
}

async function appendLine(file: string, line: string): Promise<void> {
  await fs.appendFile(file, `${line}\n`, 'utf8')
}

async function appendJsonLine(file: string, data: Record<string, unknown>): Promise<void> {
  await appendLine(file, JSON.stringify(data))
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function normalizeIdentityKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

async function readRelayMemberAccessCache(storageDir: string): Promise<Record<string, unknown> | null> {
  const target = path.join(storageDir, 'relay-member-access-cache.json')
  if (!await fileExists(target)) return null
  try {
    const raw = await fs.readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as {
      relays?: Record<string, unknown>
    } | null
    if (!parsed || typeof parsed !== 'object') return null
    return parsed.relays && typeof parsed.relays === 'object'
      ? parsed.relays
      : parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function waitForRelayMemberAccessEntry(
  storageDir: string,
  {
    relayKey = null,
    publicIdentifier = null,
    timeoutMs = 45_000
  }: {
    relayKey?: string | null
    publicIdentifier?: string | null
    timeoutMs?: number
  } = {}
): Promise<Record<string, unknown>> {
  const lookupKeys = Array.from(new Set([
    normalizeIdentityKey(relayKey),
    normalizeIdentityKey(publicIdentifier)
  ].filter((entry): entry is string => Boolean(entry))))

  return await waitFor(
    'relay member access entry',
    async () => {
      const cache = await readRelayMemberAccessCache(storageDir)
      if (!cache) return null
      for (const key of lookupKeys) {
        const entry = cache[key]
        if (entry && typeof entry === 'object') {
          return entry as Record<string, unknown>
        }
      }
      return null
    },
    { timeoutMs, intervalMs: 300 }
  )
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '')
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return { raw: text }
  }
}

function installSyntheticGatewayApproval(
  controller: TuiController,
  {
    gatewayOrigin,
    gatewayId,
    joinType
  }: {
    gatewayOrigin: string
    gatewayId?: string | null
    joinType: JoinType
  }
): Record<string, unknown> | null {
  const normalizedGatewayOrigin = normalizeHttpOrigin(gatewayOrigin)
  if (!normalizedGatewayOrigin) return null

  const syntheticGatewayId = gatewayId
    || `e2e-${new URL(normalizedGatewayOrigin).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  const syntheticGateway = {
    gatewayId: syntheticGatewayId,
    publicUrl: normalizedGatewayOrigin,
    displayName: `E2E Gateway ${syntheticGatewayId}`,
    authMethod: 'relay-scoped-bearer-v1',
    hostPolicy: 'allowlist',
    memberDelegationMode: joinType === 'open' ? 'all-members' : 'closed-members'
  }
  const controllerHost = controller as unknown as {
    patchState?: (patch: Record<string, unknown>) => void
    refreshGatewayCatalog?: (options?: { force?: boolean; timeoutMs?: number }) => Promise<unknown[]>
    __e2eSyntheticGatewayRefreshWrapped?: boolean
  }
  if (typeof controllerHost.patchState !== 'function') return syntheticGateway

  const applySyntheticState = (): void => {
    const state = controller.getState()
    const mergeGateways = (entries: Array<Record<string, unknown>>) => [
      syntheticGateway,
      ...entries.filter((entry) => normalizeHttpOrigin(entry.publicUrl) !== normalizedGatewayOrigin)
    ]
    controllerHost.patchState?.({
      discoveredGateways: mergeGateways(state.discoveredGateways as unknown as Array<Record<string, unknown>>),
      authorizedGateways: mergeGateways(state.authorizedGateways as unknown as Array<Record<string, unknown>>),
      gatewayAccessCatalog: [
        {
          gatewayId: syntheticGatewayId,
          gatewayOrigin: normalizedGatewayOrigin,
          hostingState: 'approved',
          reason: 'e2e-local-manual-gateway',
          lastCheckedAt: Date.now(),
          memberDelegationMode: syntheticGateway.memberDelegationMode,
          authMethod: syntheticGateway.authMethod,
          policy: {
            hostPolicy: syntheticGateway.hostPolicy,
            authMethod: syntheticGateway.authMethod,
            capabilities: ['relay-member-delegation']
          }
        },
        ...state.gatewayAccessCatalog.filter((entry) => (
          normalizeHttpOrigin(entry.gatewayOrigin || null) !== normalizedGatewayOrigin
        ))
      ]
    })
  }

  if (!controllerHost.__e2eSyntheticGatewayRefreshWrapped && typeof controllerHost.refreshGatewayCatalog === 'function') {
    const originalRefreshGatewayCatalog = controllerHost.refreshGatewayCatalog.bind(controller)
    controllerHost.refreshGatewayCatalog = async (options) => {
      const result = await originalRefreshGatewayCatalog(options)
      applySyntheticState()
      return result
    }
    controllerHost.__e2eSyntheticGatewayRefreshWrapped = true
  }

  applySyntheticState()
  return syntheticGateway
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

function parseGatewayRuntime(value: string | undefined): GatewayRuntime {
  const normalized = String(value || 'docker').trim().toLowerCase()
  return normalized === 'local' ? 'local' : 'docker'
}

function parsePhaseList(value: string | undefined): PhaseId[] {
  const parsed = String(value || '1,2,3,4,5,6,7,8')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 8)
  return Array.from(new Set(parsed)) as PhaseId[]
}

function normalizeHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.origin
  } catch {
    return null
  }
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

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function parseScenarioKeyFromPath(filePath: string): BaselineScenarioKey | null {
  const normalized = filePath.toLowerCase()
  const joinType: JoinType | null = normalized.includes('open-join') ? 'open' : (normalized.includes('closed-join') ? 'closed' : null)
  const hostAvailability: HostAvailability | null = normalized.includes('host-offline') ? 'offline' : (normalized.includes('both-online') || normalized.includes('host-online') ? 'online' : null)
  if (!joinType || !hostAvailability) return null
  return `${joinType}:${hostAvailability}`
}

function classifyPathModesFromContent(content: string): string[] {
  const candidates = [
    'open-gateway-bootstrap',
    'direct-join',
    'closed-lease-direct',
    'closed-invite-offline-fallback',
    'open-offline-fallback'
  ]
  return candidates.filter((mode) => content.includes(`'${mode}'`) || content.includes(`\"${mode}\"`))
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while (index <= haystack.length) {
    const next = haystack.indexOf(needle, index)
    if (next === -1) break
    count += 1
    index = next + needle.length
  }
  return count
}

async function analyzeBaselineLogs(paths: string[]): Promise<BaselineFreeze> {
  const scenarioPathHints: Record<BaselineScenarioKey, string[]> = {
    'open:online': [],
    'open:offline': [],
    'closed:online': [],
    'closed:offline': []
  }

  const reports: BaselineFreeze['reports'] = []

  for (const file of paths) {
    const exists = await fileExists(file)
    if (!exists) {
      reports.push({
        file,
        exists: false,
        markers: Object.fromEntries(BASELINE_MARKERS.map((marker) => [marker, 0])),
        detectedPathModes: []
      })
      continue
    }

    const content = await fs.readFile(file, 'utf8')
    const markers = Object.fromEntries(
      BASELINE_MARKERS.map((marker) => [marker, countOccurrences(content, marker)])
    )
    const detectedPathModes = classifyPathModesFromContent(content)
    reports.push({
      file,
      exists: true,
      markers,
      detectedPathModes
    })

    const key = parseScenarioKeyFromPath(file)
    if (key) scenarioPathHints[key].push(...detectedPathModes)
  }

  const existing = reports.filter((report) => report.exists)
  const requiredMarkers = BASELINE_MARKERS.filter((marker) => {
    if (!existing.length) return false
    return existing.every((report) => (report.markers[marker] || 0) > 0)
  })

  return {
    generatedAt: nowIso(),
    baselineLogs: paths,
    requiredMarkers,
    scenarioPathHints,
    reports
  }
}

function normalizeGatewayOriginList(origins: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(origins)
    .map((origin) => normalizeHttpOrigin(origin))
    .filter((origin): origin is string => Boolean(origin))
  ))
}

function normalizePeerKeyList(peerKeys: Iterable<string | null | undefined>): string[] {
  return Array.from(new Set(Array.from(peerKeys)
    .map((peer) => String(peer || '').trim().toLowerCase())
    .filter(Boolean)
  ))
}

function isRelayWritable(entry: RelayEntry | null | undefined): boolean {
  return Boolean(entry && entry.writable !== false && entry.readyForReq !== false)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  description: string,
  action: () => Promise<T | null>,
  options: {
    timeoutMs?: number
    intervalMs?: number
  } = {}
): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs || 60_000))
  const intervalMs = Math.max(100, Math.trunc(options.intervalMs || 400))
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

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdoutFile?: string | null
    stderrFile?: string | null
    timeoutMs?: number
  }
): Promise<void> {
  const timeoutMs = Math.max(10_000, Math.trunc(options.timeoutMs || 180_000))
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

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} terminated by ${signal}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
        return
      }
      resolve()
    })
  })
}

async function findOpenPort(preferredPort: number): Promise<number> {
  const probe = (port: number): Promise<boolean> => new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port)
  })

  if (preferredPort > 0 && await probe(preferredPort)) return preferredPort

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

async function canBindUdpPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false

    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.close(() => resolve(result))
      } catch {
        resolve(result)
      }
    }

    socket.once('error', () => finish(false))
    socket.bind(port, '127.0.0.1', () => finish(true))
  })
}

async function findOpenUdpRange(size: number): Promise<{ start: number; end: number }> {
  const normalizedSize = Math.max(1, Math.trunc(size))
  const minPort = 20000
  const maxPort = 59999 - normalizedSize
  const attempts = 40

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const randomSpan = maxPort - minPort
    const randomStart = minPort + Math.floor(Math.random() * Math.max(1, randomSpan))
    const start = randomStart - (randomStart % normalizedSize)
    let ok = true
    for (let port = start; port < start + normalizedSize; port += 1) {
      // eslint-disable-next-line no-await-in-loop
      const free = await canBindUdpPort(port)
      if (!free) {
        ok = false
        break
      }
    }
    if (ok) {
      return {
        start,
        end: start + normalizedSize - 1
      }
    }
  }

  throw new Error(`unable-to-allocate-udp-range:${normalizedSize}`)
}

function createGatewayComposeFile(repoRoot: string): string {
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
      GATEWAY_BLINDPEER_PORT: \${E2E_GATEWAY_BLINDPEER_PORT}
      GATEWAY_SCOPED_CREDENTIALS_V1: "true"
      GATEWAY_CREATOR_POLICY_V1: "true"
      GATEWAY_POLICY_MODE: "closed"
      GATEWAY_POLICY_ALLOW_LIST: \${E2E_GATEWAY_POLICY_ALLOW_LIST}
      GATEWAY_POLICY_BAN_LIST: ""
      GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT: "true"
    ports:
      - "\${E2E_GATEWAY_HOST_PORT}:4430"
      - "\${E2E_GATEWAY_BLINDPEER_PORT_START}-\${E2E_GATEWAY_BLINDPEER_PORT_END}:\${E2E_GATEWAY_BLINDPEER_PORT_START}-\${E2E_GATEWAY_BLINDPEER_PORT_END}/udp"
    depends_on:
      - redis
`
}

async function waitForGatewayReady(gatewayOrigin: string, timeoutMs = 90_000): Promise<void> {
  await waitFor(
    'gateway health',
    async () => {
      const response = await fetch(`${gatewayOrigin}/health`)
      if (!response.ok) return null
      return true
    },
    { timeoutMs, intervalMs: 1_000 }
  )

  await waitFor(
    'gateway blind-peer ready',
    async () => {
      const response = await fetch(`${gatewayOrigin}/api/blind-peer`)
      if (!response.ok) return null
      const payload = await response.json() as {
        status?: {
          enabled?: boolean
          running?: boolean
        }
      }
      if (payload?.status?.enabled !== true || payload?.status?.running !== true) return null
      return true
    },
    { timeoutMs, intervalMs: 1_000 }
  )
}

type BlindPeerSeed = {
  enabled: boolean
  publicKey?: string | null
  encryptionKey?: string | null
}

type GatewayBlindPeerStatus = {
  enabled: boolean
  running: boolean
  trackedCores: number
  trustedPeerCount: number | null
  publicKey: string | null
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

async function fetchGatewayBlindPeerStatus(gatewayOrigin: string): Promise<GatewayBlindPeerStatus | null> {
  try {
    const response = await fetch(`${gatewayOrigin}/api/blind-peer`)
    if (!response.ok) return null
    const payload = await response.json() as {
      summary?: {
        enabled?: boolean
        running?: boolean
        publicKey?: string | null
        trustedPeerCount?: number
        metadataTracked?: number
      }
      status?: {
        enabled?: boolean
        running?: boolean
        publicKey?: string | null
        trustedPeerCount?: number
        metadata?: {
          trackedCores?: number
        }
      }
    }

    const summary = payload?.summary || {}
    const status = payload?.status || {}
    const trackedSummary = Number(summary?.metadataTracked)
    const trackedStatus = Number(status?.metadata?.trackedCores)
    const trackedCores = Number.isFinite(trackedSummary)
      ? Math.max(0, Math.trunc(trackedSummary))
      : (Number.isFinite(trackedStatus) ? Math.max(0, Math.trunc(trackedStatus)) : 0)
    const trustedSummary = Number(summary?.trustedPeerCount)
    const trustedStatus = Number(status?.trustedPeerCount)
    return {
      enabled: summary.enabled === true || status.enabled === true,
      running: summary.running === true || status.running === true,
      trackedCores,
      trustedPeerCount: Number.isFinite(trustedSummary)
        ? Math.trunc(trustedSummary)
        : (Number.isFinite(trustedStatus) ? Math.trunc(trustedStatus) : null),
      publicKey: typeof summary.publicKey === 'string'
        ? summary.publicKey
        : (typeof status.publicKey === 'string' ? status.publicKey : null)
    }
  } catch {
    return null
  }
}

async function writeWorkerGatewaySettings(
  storageDir: string,
  gatewayOrigin: string,
  options: {
    blindPeer?: BlindPeerSeed | null
    sharedSecret?: string | null
  } = {}
): Promise<void> {
  const origin = normalizeHttpOrigin(gatewayOrigin)
  if (!origin) throw new Error('invalid-gateway-origin')
  const parsed = new URL(origin)
  const wsProtocol = getWsProtocolFromHttpOrigin(origin)
  const blindPeer = options.blindPeer || null
  const blindPeerKey = (blindPeer?.publicKey || '').trim() || null
  const blindPeerEncryptionKey = (blindPeer?.encryptionKey || '').trim() || null
  const sharedSecret = typeof options.sharedSecret === 'string' ? options.sharedSecret.trim() : ''

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
      sharedSecret,
      delegateReqToPeers: false,
      blindPeerEnabled: blindPeer?.enabled === true && !!blindPeerKey,
      blindPeerKeys: blindPeerKey ? [blindPeerKey] : [],
      blindPeerManualKeys: blindPeerKey ? [blindPeerKey] : [],
      blindPeerEncryptionKey: blindPeerEncryptionKey || null
    }, null, 2),
    'utf8'
  )
}

async function startGatewayStack(options: {
  repoRoot: string
  runDir: string
  preferredPort: number
  hostAllowPubkey: string
  timeoutMs: number
  runtime: GatewayRuntime
}): Promise<GatewayStack> {
  const hostPort = await findOpenPort(options.preferredPort)
  const blindPeerDhtRange = await findOpenUdpRange(65)
  const blindPeerDhtPort = blindPeerDhtRange.start
  const origin = normalizeHttpOrigin(`http://127.0.0.1:${hostPort}`)
  if (!origin) throw new Error('failed-to-build-gateway-origin')

  const runId = path.basename(options.runDir)
  const dockerStdoutFile = path.join(options.runDir, 'docker.stdout.log')
  const dockerStderrFile = path.join(options.runDir, 'docker.stderr.log')
  const gatewaySecret = `e2e-gateway-secret-${runId}`

  if (options.runtime === 'local') {
    const gatewayDir = path.join(options.repoRoot, 'hyperpipe-gateway')
    const blindPeerStorage = path.join(options.runDir, 'gateway-blind-peer-data')
    await fs.mkdir(blindPeerStorage, { recursive: true })

    const localEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(hostPort),
      GATEWAY_TLS_ENABLED: 'false',
      GATEWAY_METRICS_ENABLED: 'false',
      GATEWAY_RATELIMIT_ENABLED: 'false',
      GATEWAY_PUBLIC_URL: origin,
      GATEWAY_REGISTRATION_SECRET: gatewaySecret,
      GATEWAY_REGISTRATION_TTL: '0',
      GATEWAY_MIRROR_METADATA_TTL: '0',
      GATEWAY_OPEN_JOIN_POOL_TTL: '0',
      GATEWAY_OPEN_JOIN_POOL_TTL_MS: '0',
      GATEWAY_BLINDPEER_ENABLED: 'true',
      GATEWAY_BLINDPEER_STORAGE: blindPeerStorage,
      GATEWAY_BLINDPEER_PORT: String(blindPeerDhtPort),
      GATEWAY_SCOPED_CREDENTIALS_V1: 'true',
      GATEWAY_CREATOR_POLICY_V1: 'true',
      GATEWAY_POLICY_MODE: 'closed',
      GATEWAY_POLICY_ALLOW_LIST: options.hostAllowPubkey,
      GATEWAY_POLICY_BAN_LIST: '',
      GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT: 'true'
    }

    const child = spawn('node', ['src/index.mjs'], {
      cwd: gatewayDir,
      env: localEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stdout.write(text)
      void fs.appendFile(dockerStdoutFile, text, 'utf8').catch(() => {})
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stderr.write(text)
      void fs.appendFile(dockerStderrFile, text, 'utf8').catch(() => {})
    })

    try {
      await waitForGatewayReady(origin, Math.min(options.timeoutMs, 120_000))
    } catch (error) {
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
      throw error
    }

    return {
      runtime: 'local',
      origin,
      secret: gatewaySecret,
      hostPort,
      blindPeerDhtPort,
      blindPeerDhtPortEnd: blindPeerDhtRange.end,
      composeProjectName: null,
      composeFile: null,
      envFile: null,
      dockerStdoutFile,
      dockerStderrFile,
      localProcess: child
    }
  }

  const composeProjectName = `htval_${runId.replace(/[^a-z0-9_]/gi, '_')}`
  const composeFile = path.join(options.runDir, 'docker-compose.yml')
  const envFile = path.join(options.runDir, '.env')

  await fs.writeFile(composeFile, createGatewayComposeFile(options.repoRoot), 'utf8')

  const env = [
    `E2E_GATEWAY_HOST_PORT=${hostPort}`,
    `E2E_GATEWAY_PUBLIC_URL=${origin}`,
    `E2E_GATEWAY_SECRET=${gatewaySecret}`,
    `E2E_REDIS_PREFIX=e2e:relay-scoped-validation:${runId}:`,
    `E2E_GATEWAY_BLINDPEER_PORT=${blindPeerDhtPort}`,
    `E2E_GATEWAY_BLINDPEER_PORT_START=${blindPeerDhtRange.start}`,
    `E2E_GATEWAY_BLINDPEER_PORT_END=${blindPeerDhtRange.end}`,
    `E2E_GATEWAY_POLICY_ALLOW_LIST=${options.hostAllowPubkey}`
  ].join('\n')

  await fs.writeFile(envFile, `${env}\n`, 'utf8')

  await runCommand(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, '-p', composeProjectName, 'up', '-d', '--build'],
    {
      cwd: options.runDir,
      stdoutFile: dockerStdoutFile,
      stderrFile: dockerStderrFile,
      timeoutMs: options.timeoutMs
    }
  )

  await waitForGatewayReady(origin, Math.min(options.timeoutMs, 120_000))

  return {
    runtime: 'docker',
    origin,
    secret: gatewaySecret,
    hostPort,
    blindPeerDhtPort,
    blindPeerDhtPortEnd: blindPeerDhtRange.end,
    composeProjectName,
    composeFile,
    envFile,
    dockerStdoutFile,
    dockerStderrFile
  }
}

async function stopGatewayStack(stack: GatewayStack, runDir: string): Promise<void> {
  if (stack.runtime === 'local') {
    const child = stack.localProcess || null
    if (!child || child.killed || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 10_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    return
  }

  if (!stack.envFile || !stack.composeFile || !stack.composeProjectName) {
    throw new Error('docker-stack-metadata-missing')
  }
  await runCommand(
    'docker',
    ['compose', '--env-file', stack.envFile, '-f', stack.composeFile, '-p', stack.composeProjectName, 'down', '-v', '--remove-orphans'],
    {
      cwd: runDir,
      stdoutFile: stack.dockerStdoutFile,
      stderrFile: stack.dockerStderrFile,
      timeoutMs: 180_000
    }
  )
}

async function collectGatewayStackLogs(stack: GatewayStack, runDir: string): Promise<void> {
  if (stack.runtime === 'local') return
  if (!stack.envFile || !stack.composeFile || !stack.composeProjectName) {
    throw new Error('docker-stack-metadata-missing')
  }
  await runCommand(
    'docker',
    [
      'compose',
      '--env-file',
      stack.envFile,
      '-f',
      stack.composeFile,
      '-p',
      stack.composeProjectName,
      'logs',
      '--no-color',
      'gateway',
      'redis'
    ],
    {
      cwd: runDir,
      stdoutFile: stack.dockerStdoutFile,
      stderrFile: stack.dockerStderrFile,
      timeoutMs: 120_000
    }
  )
}

class WorkerLogTap {
  private outIndex = 0
  private errIndex = 0
  private timer: NodeJS.Timeout | null = null
  private detachStdout: (() => void) | null = null
  private detachStderr: (() => void) | null = null
  private stdoutRemainder = ''
  private stderrRemainder = ''

  constructor(
    private readonly label: WorkerLabel,
    private readonly controller: TuiController,
    private readonly onLine: (label: WorkerLabel, stream: StreamLabel, line: string) => void
  ) {}

  private static sanitizeLine(input: string): string {
    return String(input || '')
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private consumeChunk(stream: StreamLabel, chunk: unknown): void {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk ?? '')
    if (!text) return

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let combined = stream === 'stdout' ? `${this.stdoutRemainder}${normalized}` : `${this.stderrRemainder}${normalized}`
    const lines = combined.split('\n')
    const remainder = lines.pop() || ''
    if (stream === 'stdout') this.stdoutRemainder = remainder
    else this.stderrRemainder = remainder

    for (const rawLine of lines) {
      const line = WorkerLogTap.sanitizeLine(rawLine)
      if (!line) continue
      this.onLine(this.label, stream, line)
    }
  }

  private flushRemainder(stream: StreamLabel): void {
    const raw = stream === 'stdout' ? this.stdoutRemainder : this.stderrRemainder
    const line = WorkerLogTap.sanitizeLine(raw)
    if (line) this.onLine(this.label, stream, line)
    if (stream === 'stdout') this.stdoutRemainder = ''
    else this.stderrRemainder = ''
  }

  start(pollMs = 200): void {
    if (this.timer || this.detachStdout || this.detachStderr) return
    const workerHost = (this.controller as unknown as {
      workerHost?: {
        onStdout?: (handler: (chunk: string) => void) => () => void
        onStderr?: (handler: (chunk: string) => void) => () => void
      }
    }).workerHost
    if (workerHost && typeof workerHost.onStdout === 'function' && typeof workerHost.onStderr === 'function') {
      this.detachStdout = workerHost.onStdout((chunk) => this.consumeChunk('stdout', chunk))
      this.detachStderr = workerHost.onStderr((chunk) => this.consumeChunk('stderr', chunk))
      return
    }
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
    if (this.detachStdout || this.detachStderr) {
      this.flushRemainder('stdout')
      this.flushRemainder('stderr')
      this.detachStdout?.()
      this.detachStderr?.()
      this.detachStdout = null
      this.detachStderr = null
    }
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

function parsePathModeFromLine(line: string): string | null {
  const modeMatch = line.match(/mode:\s*'([^']+)'/)
  if (modeMatch?.[1]) return normalizeSelectedPathMode(modeMatch[1])
  const joinPathMatch = line.match(/joinPathMode:\s*'([^']+)'/)
  if (joinPathMatch?.[1]) return normalizeSelectedPathMode(joinPathMatch[1])
  return null
}

function normalizeSelectedPathMode(mode: string | null | undefined): string | null {
  const normalized = String(mode || '').trim()
  if (!normalized) return null
  if (normalized === 'hyperswarm' || normalized === 'direct-challenge') return 'direct-join'
  return normalized
}

function parsePeerFromLine(line: string): string | null {
  const peerMatch = line.match(/peerKey:\s*'([^']+)'/)
  return peerMatch?.[1] || null
}

function extractOriginsFromLine(line: string): string[] {
  const matches = line.match(/https?:\/\/[^\s'",}\]]+/g) || []
  return normalizeGatewayOriginList(matches)
}

function hasGatewayUnassignedMarker(line: string): boolean {
  return /\bgateway-unassigned\b(?!-error)/i.test(line)
}

function hasJoinFailureMarker(line: string): boolean {
  const normalized = String(line || '').toLowerCase()
  if (!normalized) return false
  if (normalized.includes('join-auth-error')) return true
  if (hasGatewayUnassignedMarker(line)) return true
  if (normalized.includes('missing relay key for open join fallback')) return true
  if (normalized.includes('direct join attempt failed')) return true
  if (normalized.includes('join-deadline-exceeded')) return true
  if (normalized.includes('failed to start join flow')) return true
  if (normalized.includes('error: closing')) return true
  if (normalized.includes('hyperswarm getconnection loop detected')) return true
  if (normalized.includes('waitforrelaywriteractivation timeout')) return true
  if (normalized.includes('join_writable_deadline_result') && normalized.includes('ok: false')) return true
  return false
}

function parseGatewayTraceHint(line: string): {
  route: string
  status: 'attempt' | 'ok' | 'error'
  authState: 'none' | 'signed' | 'verified' | 'failed'
} | null {
  if (line.includes('[Worker] Open join bootstrap start')) {
    return { route: 'open-join/bootstrap', status: 'attempt', authState: 'none' }
  }
  if (line.includes('[Worker] Open join challenge ok')) {
    return { route: 'open-join/challenge', status: 'ok', authState: 'verified' }
  }
  if (line.includes('[Worker] Open join challenge failed')) {
    return { route: 'open-join/challenge', status: 'error', authState: 'failed' }
  }
  if (line.includes('[Worker] Open join auth event signed')) {
    return { route: 'open-join/auth-event', status: 'ok', authState: 'signed' }
  }
  if (line.includes('[Worker] Open join request failed')) {
    return { route: 'open-join', status: 'error', authState: 'verified' }
  }
  if (line.includes('[Worker] Open join bootstrap response')) {
    return { route: 'open-join', status: 'ok', authState: 'verified' }
  }
  if (line.includes('[Worker] Mirror metadata request')) {
    return { route: 'mirror', status: 'attempt', authState: 'none' }
  }
  if (line.includes('[Worker] Mirror metadata response')) {
    return { route: 'mirror', status: 'ok', authState: 'none' }
  }
  if (line.includes('[Worker] Mirror metadata fetch failed')) {
    return { route: 'mirror', status: 'error', authState: 'none' }
  }
  if (hasGatewayUnassignedMarker(line)) {
    return { route: 'gateway-routing', status: 'error', authState: 'none' }
  }
  return null
}

function normalizeGatewayStageStatus(value: unknown): GatewayStageStatus {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'ok' || normalized === 'error' || normalized === 'skipped') return normalized
  return 'attempt'
}

function gatewayTraceStatusFromStage(status: GatewayStageStatus): GatewayTrace['status'] | null {
  if (status === 'ok' || status === 'error' || status === 'attempt') return status
  return null
}

function gatewayAuthStateFromStage(route: string, stage: string, status: GatewayStageStatus): GatewayTrace['authState'] {
  if (route === 'open-join' && stage === 'auth-event') {
    return status === 'error' ? 'failed' : 'signed'
  }
  if (route === 'open-join' && (stage === 'request' || stage === 'response' || stage === 'final')) {
    return status === 'error' ? 'failed' : 'verified'
  }
  return 'none'
}

async function runScenario(options: {
  repoRoot: string
  tuiRoot: string
  phaseDir: string
  manifest: ScenarioManifest
  logLevel: LogLevel
  timeoutMs: number
  keepDocker: boolean
  preferredGatewayPort: number
  gatewayRuntime: GatewayRuntime
  postJoinValidate?: ((context: ScenarioPostJoinValidateContext) => Promise<void>) | null
}): Promise<ScenarioRunResult> {
  const startedAtIso = nowIso()
  const startedAtMs = Date.now()
  const scenario = { ...options.manifest }
  const scenarioDir = path.join(options.phaseDir, scenario.scenarioId)
  await fs.mkdir(scenarioDir, { recursive: true })

  const correlationId = randomId(`corr-${scenario.scenarioId}`)
  const timelineFile = path.join(scenarioDir, 'timeline.jsonl')
  const checkpointsFile = path.join(scenarioDir, 'checkpoints.json')
  const gatewayTraceFile = path.join(scenarioDir, 'gateway-trace.json')
  const joinCheckpointTraceFile = path.join(scenarioDir, 'join-checkpoint-trace.json')
  const verdictFile = path.join(scenarioDir, 'verdict.json')
  const summaryFile = path.join(scenarioDir, 'summary.json')
  const hostLogFile = path.join(scenarioDir, 'host-worker.log')
  const joinerLogFile = path.join(scenarioDir, 'joiner-worker.log')

  const checkpoints: JoinCheckpoint[] = []
  const gatewayTrace: GatewayTrace[] = []
  const gatewayStages: GatewayStageEvent[] = []
  const joinCheckpointTrace: JoinCheckpointTraceEvent[] = []

  const artifacts: ScenarioRunArtifacts = {
    timelineFile,
    checkpointsFile,
    gatewayTraceFile,
    joinCheckpointTraceFile,
    verdictFile,
    hostLogFile,
    joinerLogFile,
    dockerStdoutFile: null,
    dockerStderrFile: null,
    summaryFile
  }

  const traceContext: TraceParserState = {
    route: null,
    status: 'attempt',
    authState: 'none',
    ttl: 0
  }

  let selectedPathMode: string | null = null
  let selectedPathPeer: string | null = null
  let lastJoinError: string | null = null
  let joinFlowInputSeen = false
  let joinFlowResolvedSeen = false
  let joinFlowActive = false
  let joinerJoinStartLineIndex = 0
  let writerMaterialSignalSeen = false
  let joinAuthSuccessSeen = false
  let joinerRelayKey: string | null = null
  let gatewayOrigin: string | null = normalizeHttpOrigin(scenario.gatewayOrigin || null)
  let gatewaySecret: string | null = null
  let hostStorage = ''
  let joinerStorage = ''
  let hostAccount: ScenarioAccount | null = null
  let joinerAccount: ScenarioAccount | null = null
  let hostSession: ScenarioSession = null
  let joinerSession: ScenarioSession = null
  let createdGroup: GroupSummary | null = null
  let createdHostRelay: RelayEntry | null = null
  let invite: GroupInvite | null = null
  let discovered: GroupSummary | null = null

  let hostTap: WorkerLogTap | null = null
  let joinerTap: WorkerLogTap | null = null
  let detachHostEvents: (() => void) | null = null
  let detachJoinerEvents: (() => void) | null = null
  let host: TuiController | null = null
  let joiner: TuiController | null = null
  let gatewayStack: GatewayStack | null = null

  const hostLines: string[] = []
  const joinerLines: string[] = []
  const joinerJoinFlowLines = (): string[] => joinerLines.slice(joinerJoinStartLineIndex)

  const emitTimeline = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => {
    await appendJsonLine(timelineFile, {
      ts: nowIso(),
      correlationId,
      scenarioId: scenario.scenarioId,
      event,
      ...payload
    })
  }

  const recordGatewayTrace = async (entry: Omit<GatewayTrace, 'scenarioId' | 'correlationId' | 'ts'>): Promise<void> => {
    const traceEntry: GatewayTrace = {
      scenarioId: scenario.scenarioId,
      correlationId,
      ts: nowIso(),
      ...entry
    }
    gatewayTrace.push(traceEntry)
    await emitTimeline('gateway-trace', {
      route: traceEntry.route,
      status: traceEntry.status,
      authState: traceEntry.authState,
      gatewayOrigin: traceEntry.gatewayOrigin,
      relayKey: traceEntry.relayKey,
      requestId: traceEntry.requestId
    })
  }

  const recordGatewayStage = async (entry: Omit<GatewayStageEvent, 'scenarioId' | 'correlationId' | 'ts'>): Promise<void> => {
    const stageEntry: GatewayStageEvent = {
      scenarioId: scenario.scenarioId,
      correlationId,
      ts: nowIso(),
      ...entry
    }
    gatewayStages.push(stageEntry)
    await emitTimeline('gateway-stage', {
      route: stageEntry.route,
      stage: stageEntry.stage,
      status: stageEntry.status,
      relayIdentifier: stageEntry.relayIdentifier,
      relayKey: stageEntry.relayKey,
      gatewayOrigin: stageEntry.gatewayOrigin,
      reason: stageEntry.reason,
      error: stageEntry.error,
      errorCode: stageEntry.errorCode,
      statusCode: stageEntry.statusCode,
      details: stageEntry.details || null
    })
    const traceStatus = gatewayTraceStatusFromStage(stageEntry.status)
    const normalizedOrigin = normalizeHttpOrigin(stageEntry.gatewayOrigin)
    if (traceStatus && normalizedOrigin) {
      await recordGatewayTrace({
        relayKey: stageEntry.relayKey || stageEntry.relayIdentifier || joinerRelayKey,
        gatewayOrigin: normalizedOrigin,
        route: `${stageEntry.route}/${stageEntry.stage}`,
        status: traceStatus,
        authState: gatewayAuthStateFromStage(stageEntry.route, stageEntry.stage, stageEntry.status),
        requestId: randomId('req')
      })
    }
  }

  const recordJoinCheckpointTrace = async (
    worker: WorkerLabel,
    payload: Record<string, unknown>
  ): Promise<void> => {
    const phase = typeof payload.phase === 'string' ? payload.phase.trim() : 'unknown'
    const traceEntry: JoinCheckpointTraceEvent = {
      scenarioId: scenario.scenarioId,
      correlationId,
      worker,
      phase,
      payload,
      ts: nowIso()
    }
    joinCheckpointTrace.push(traceEntry)
    await emitTimeline('join-checkpoint-trace', {
      worker,
      phase,
      payload
    })
  }

  const recordCheckpoint = async (
    phase: string,
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
    status: CheckpointStatus
  ): Promise<JoinCheckpoint> => {
    const checkpoint: JoinCheckpoint = {
      scenarioId: scenario.scenarioId,
      correlationId,
      phase,
      expected,
      actual,
      status,
      ts: nowIso()
    }
    checkpoints.push(checkpoint)
    await emitTimeline('checkpoint', {
      phase,
      status,
      expected,
      actual
    })
    return checkpoint
  }

  const assertCheckpoint = async (
    phase: string,
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
    predicate: boolean,
    failureReason: string
  ): Promise<void> => {
    const status: CheckpointStatus = predicate ? 'pass' : 'fail'
    const checkpoint = await recordCheckpoint(phase, expected, actual, status)
    if (!predicate) {
      throw new CheckpointFailure(`${phase}: ${failureReason}`, checkpoint)
    }
  }

  const summarizeGatewayStage = (entry: GatewayStageEvent | null): Record<string, unknown> | null => {
    if (!entry) return null
    return {
      route: entry.route,
      stage: entry.stage,
      status: entry.status,
      relayIdentifier: short(entry.relayIdentifier),
      relayKey: short(entry.relayKey),
      gatewayOrigin: entry.gatewayOrigin,
      reason: entry.reason,
      error: entry.error,
      errorCode: entry.errorCode,
      statusCode: entry.statusCode,
      details: entry.details || null
    }
  }

  const waitForGatewayStageCheckpoint = async (options: {
    phase: string
    expected: Record<string, unknown>
    timeoutMs: number
    match: (entry: GatewayStageEvent) => boolean
    failOn?: (entry: GatewayStageEvent) => boolean
    failureReason: string
  }): Promise<void> => {
    const stageSignal = await waitFor<'matched' | 'failed'>(
      options.phase,
      async () => {
        if (gatewayStages.some(options.match)) return 'matched'
        if (options.failOn && gatewayStages.some(options.failOn)) return 'failed'
        return null
      },
      { timeoutMs: options.timeoutMs, intervalMs: 250 }
    )
    const matched = stageSignal === 'matched'
    const failureStage = options.failOn
      ? [...gatewayStages].reverse().find((entry) => options.failOn?.(entry)) || null
      : null
    const latestStage = gatewayStages.length ? gatewayStages[gatewayStages.length - 1] : null
    await assertCheckpoint(
      options.phase,
      options.expected,
      {
        signal: stageSignal,
        matchedStage: summarizeGatewayStage(
          [...gatewayStages].reverse().find((entry) => options.match(entry)) || null
        ),
        failureStage: summarizeGatewayStage(failureStage),
        latestStage: summarizeGatewayStage(latestStage)
      },
      matched,
      failureStage?.error || failureStage?.reason || options.failureReason
    )
  }

  const onLogLine = async (label: WorkerLabel, stream: StreamLabel, line: string): Promise<void> => {
    const normalized = String(line || '').trim()
    if (!normalized) return

    const stamped = `[${nowIso()}] [${label} ${stream}] ${normalized}`
    const target = label === 'host' ? hostLogFile : joinerLogFile
    await appendLine(target, stamped)
    await emitTimeline('worker-log', { label, stream, line: normalized })

    if (label === 'host') hostLines.push(normalized)
    else joinerLines.push(normalized)

    if (label === 'joiner' && joinFlowActive && hasJoinFailureMarker(normalized)) {
      lastJoinError = normalized
    }

    const parsedMode = parsePathModeFromLine(normalized)
    if (label === 'joiner' && parsedMode) {
      selectedPathMode = parsedMode
      const parsedPeer = parsePeerFromLine(normalized)
      if (parsedPeer) selectedPathPeer = parsedPeer
    }

    const hint = parseGatewayTraceHint(normalized)
    if (hint) {
      traceContext.route = hint.route
      traceContext.status = hint.status
      traceContext.authState = hint.authState
      traceContext.ttl = 24
    }

    if (traceContext.ttl > 0 && normalized.includes('}')) {
      traceContext.ttl -= 1
      if (traceContext.ttl <= 0) {
        traceContext.route = null
      }
    }

    const origins = extractOriginsFromLine(normalized)
    if (origins.length && traceContext.route) {
      for (const origin of origins) {
        await recordGatewayTrace({
          relayKey: joinerRelayKey,
          gatewayOrigin: origin,
          route: traceContext.route,
          status: traceContext.status,
          authState: traceContext.authState,
          requestId: randomId('req')
        })
      }
      traceContext.ttl = Math.max(0, traceContext.ttl - 1)
    }
  }

  try {
    await emitTimeline('scenario-start', { manifest: scenario })

    hostStorage = path.join(os.tmpdir(), randomId(`${scenario.scenarioId}-host`))
    joinerStorage = path.join(os.tmpdir(), randomId(`${scenario.scenarioId}-joiner`))
    await fs.mkdir(hostStorage, { recursive: true })
    await fs.mkdir(joinerStorage, { recursive: true })

    const hostRuntime: RuntimeOptions = {
      cwd: options.tuiRoot,
      storageDir: hostStorage,
      noAnimations: true,
      logLevel: options.logLevel
    }

    const joinerRuntime: RuntimeOptions = {
      cwd: options.tuiRoot,
      storageDir: joinerStorage,
      noAnimations: true,
      logLevel: options.logLevel
    }

    host = new TuiController(hostRuntime)
    joiner = new TuiController(joinerRuntime)

    await emitTimeline('controller-init-start')
    await host.initialize()
    await joiner.initialize()

    hostAccount = await host.generateNsecAccount(`host-${scenario.scenarioId}`)
    joinerAccount = await joiner.generateNsecAccount(`joiner-${scenario.scenarioId}`)
    await host.selectAccount(hostAccount.pubkey)
    await host.unlockCurrentAccount()
    await joiner.selectAccount(joinerAccount.pubkey)
    await joiner.unlockCurrentAccount()
    hostSession = host.getState().session
      ? {
        pubkey: host.getState().session!.pubkey,
        nsecHex: host.getState().session!.nsecHex,
        nsec: host.getState().session!.nsec
      }
      : null
    joinerSession = joiner.getState().session
      ? {
        pubkey: joiner.getState().session!.pubkey,
        nsecHex: joiner.getState().session!.nsecHex,
        nsec: joiner.getState().session!.nsec
      }
      : null

    if (scenario.gatewayAvailability === 'online') {
      gatewayStack = await startGatewayStack({
        repoRoot: options.repoRoot,
        runDir: scenarioDir,
        preferredPort: options.preferredGatewayPort,
        hostAllowPubkey: hostAccount.pubkey,
        timeoutMs: Math.min(options.timeoutMs, 300_000),
        runtime: options.gatewayRuntime
      })
      artifacts.dockerStdoutFile = gatewayStack.dockerStdoutFile
      artifacts.dockerStderrFile = gatewayStack.dockerStderrFile
      gatewayOrigin = gatewayStack.origin
      gatewaySecret = gatewayStack.secret
      await emitTimeline('gateway-stack-started', {
        gatewayOrigin,
        projectName: gatewayStack.composeProjectName,
        hostPort: gatewayStack.hostPort,
        runtime: gatewayStack.runtime
      })
    } else if (!gatewayOrigin) {
      const fallbackPort = await findOpenPort(options.preferredGatewayPort)
      gatewayOrigin = normalizeHttpOrigin(`http://127.0.0.1:${fallbackPort}`)
      gatewaySecret = 'offline-secret'
    }

    if (!gatewayOrigin) {
      throw new Error('gateway-origin-unavailable')
    }

    const blindPeerSeed = scenario.gatewayAvailability === 'online'
      ? await fetchGatewayBlindPeerSeed(gatewayOrigin)
      : null

    await Promise.all([
      writeWorkerGatewaySettings(hostStorage, gatewayOrigin, {
        blindPeer: blindPeerSeed,
        sharedSecret: gatewaySecret
      }),
      writeWorkerGatewaySettings(joinerStorage, gatewayOrigin, {
        blindPeer: blindPeerSeed,
        sharedSecret: gatewaySecret
      })
    ])

    hostTap = new WorkerLogTap('host', host, (label, stream, line) => {
      void onLogLine(label, stream, line)
    })
    joinerTap = new WorkerLogTap('joiner', joiner, (label, stream, line) => {
      void onLogLine(label, stream, line)
    })
    hostTap.start()
    joinerTap.start()

    detachHostEvents = attachWorkerEvents('host', host, (label, message) => {
      const type = String(message?.type || '')
      if (!type) return
      void emitTimeline('worker-event', {
        label,
        type,
        data: message?.data ?? null
      })
      if (type === 'JOIN_PATH_SELECTED') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const mode = normalizeSelectedPathMode(typeof payload.mode === 'string' ? payload.mode : '')
        const peerKey = typeof payload.peerKey === 'string' ? payload.peerKey.trim() : ''
        selectedPathMode = mode || selectedPathMode
        selectedPathPeer = peerKey || selectedPathPeer
      }
      if (type === 'JOIN_CHECKPOINT_TRACE') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        void recordJoinCheckpointTrace('host', payload)
      }
      if (type === 'join-auth-error') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const reason = typeof payload.error === 'string' ? payload.error : (typeof payload.reason === 'string' ? payload.reason : null)
        if (joinFlowActive && reason) lastJoinError = reason
      }
    })

    detachJoinerEvents = attachWorkerEvents('joiner', joiner, (label, message) => {
      const type = String(message?.type || '')
      if (!type) return
      void emitTimeline('worker-event', {
        label,
        type,
        data: message?.data ?? null
      })
      if (type === 'JOIN_PATH_SELECTED') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const mode = normalizeSelectedPathMode(typeof payload.mode === 'string' ? payload.mode : '')
        const peerKey = typeof payload.peerKey === 'string' ? payload.peerKey.trim() : ''
        selectedPathMode = mode || selectedPathMode
        selectedPathPeer = peerKey || selectedPathPeer
        joinFlowResolvedSeen = true
      }
      if (type === 'JOIN_CHECKPOINT_TRACE') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        void recordJoinCheckpointTrace('joiner', payload)
      }
      if (type === 'JOIN_DISCOVERY_SOURCES') {
        joinFlowInputSeen = true
      }
      if (type === 'join-auth-progress') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : ''
        if (status) {
          joinFlowInputSeen = true
        }
        if (['resolved', 'success', 'completed', 'connected', 'writable'].includes(status)) {
          joinFlowResolvedSeen = true
        }
      }
      if (type === 'join-auth-success') {
        joinAuthSuccessSeen = true
      }
      if (type === 'JOIN_WRITER_SOURCE') {
        writerMaterialSignalSeen = true
      }
      if (type === 'JOIN_GATEWAY_STAGE') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const route = typeof payload.route === 'string' ? payload.route.trim() : 'unknown'
        const stage = typeof payload.stage === 'string' ? payload.stage.trim() : 'unknown'
        const status = normalizeGatewayStageStatus(payload.status)
        const relayIdentifier = typeof payload.relayIdentifier === 'string'
          ? payload.relayIdentifier.trim()
          : (typeof payload.publicIdentifier === 'string' ? payload.publicIdentifier.trim() : null)
        const relayKey = typeof payload.relayKey === 'string'
          ? payload.relayKey.trim()
          : null
        const gatewayStageOrigin = normalizeHttpOrigin(payload.gatewayOrigin || payload.origin || null)
        const reason = typeof payload.reason === 'string' ? payload.reason : null
        const error = typeof payload.error === 'string' ? payload.error : null
        const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : null
        const rawStatusCode = typeof payload.statusCode === 'number'
          ? payload.statusCode
          : Number.NaN
        const statusCode = Number.isFinite(rawStatusCode) ? rawStatusCode : null
        const writerLeaseId = typeof payload.writerLeaseId === 'string'
          ? payload.writerLeaseId
          : null
        const writerCommitCheckpoint = payload.writerCommitCheckpoint && typeof payload.writerCommitCheckpoint === 'object'
          ? payload.writerCommitCheckpoint as Record<string, unknown>
          : null
        const details: Record<string, unknown> = {
          hasWriterLeaseId: payload.hasWriterLeaseId === true || !!writerLeaseId,
          writerLeaseId: writerLeaseId || null,
          hasWriterCommitCheckpoint: payload.hasWriterCommitCheckpoint === true || !!writerCommitCheckpoint,
          writerCommitCheckpoint: writerCommitCheckpoint || null,
          writerDurabilityAtServe: typeof payload.writerDurabilityAtServe === 'boolean'
            ? payload.writerDurabilityAtServe
            : (payload.writerDurabilityAtServe === null ? null : null),
          writerDurabilityReason: typeof payload.writerDurabilityReason === 'string'
            ? payload.writerDurabilityReason
            : null,
          writerDurabilityProofSource: typeof payload.writerDurabilityProofSource === 'string'
            ? payload.writerDurabilityProofSource
            : null,
          writerDurabilityProofAuthoritative: payload.writerDurabilityProofAuthoritative === true,
          membershipState: typeof payload.membershipState === 'string'
            ? payload.membershipState
            : null,
          hasMirror: payload.hasMirror === true,
          hasAccessToken: payload.hasAccessToken === true,
          refreshAfter: Number.isFinite(Number(payload.refreshAfter))
            ? Number(payload.refreshAfter)
            : null,
          expiresAt: Number.isFinite(Number(payload.expiresAt))
            ? Number(payload.expiresAt)
            : null,
          grantId: typeof payload.grantId === 'string' ? payload.grantId : null
        }
        void recordGatewayStage({
          route,
          stage,
          status,
          relayIdentifier: relayIdentifier || null,
          relayKey: relayKey || null,
          gatewayOrigin: gatewayStageOrigin,
          reason,
          error,
          errorCode,
          statusCode,
          details
        })
      }
      if (type === 'JOIN_GATEWAY_TRACE') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const route = typeof payload.route === 'string'
          ? payload.route.trim()
          : (typeof payload.stage === 'string' ? payload.stage.trim() : 'gateway-trace')
        const rawStatus = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : ''
        const status: GatewayTrace['status'] =
          rawStatus === 'ok'
            ? 'ok'
            : rawStatus === 'error'
              ? 'error'
              : 'attempt'
        const authStateRaw = typeof payload.authState === 'string' ? payload.authState.trim().toLowerCase() : ''
        const authState: GatewayTrace['authState'] =
          authStateRaw === 'signed'
            ? 'signed'
            : authStateRaw === 'verified'
              ? 'verified'
              : authStateRaw === 'failed'
                ? 'failed'
                : 'none'
        const gatewayTraceOrigin = normalizeHttpOrigin(
          payload.gatewayOrigin || payload.origin || null
        )
        const requestId = typeof payload.traceId === 'string' && payload.traceId.trim()
          ? payload.traceId.trim()
          : randomId('req')
        if (gatewayTraceOrigin) {
          void recordGatewayTrace({
            relayKey: typeof payload.relayKey === 'string'
              ? payload.relayKey
              : (typeof payload.relayIdentifier === 'string' ? payload.relayIdentifier : joinerRelayKey),
            gatewayOrigin: gatewayTraceOrigin,
            route,
            status,
            authState,
            requestId
          })
        }
      }
      if (type === 'join-auth-error') {
        const payload = message?.data && typeof message.data === 'object'
          ? message.data as Record<string, unknown>
          : {}
        const reason = typeof payload.error === 'string' ? payload.error : (typeof payload.reason === 'string' ? payload.reason : null)
        if (joinFlowActive && reason) lastJoinError = reason
      }
    })

    await emitTimeline('workers-starting')
    await host.startWorker()
    await joiner.startWorker()

    await Promise.allSettled([
      host.refreshRelays(),
      host.refreshGroups(),
      host.refreshInvites(),
      joiner.refreshRelays(),
      joiner.refreshGroups(),
      joiner.refreshInvites()
    ])

    const joinDirectDiscoveryValue = await waitFor<string>(
      'joinDirectDiscoveryV2 startup flag',
      async () => {
        const lines = [...joinerLines, ...hostLines]
        const line = lines.find((entry) => entry.includes('joinDirectDiscoveryV2:')) || null
        if (!line) return null
        const match = line.match(/joinDirectDiscoveryV2:\s*(true|false)/i)
        return match?.[1]?.toLowerCase() || null
      },
      { timeoutMs: 45_000, intervalMs: 250 }
    )

    await assertCheckpoint(
      'worker-flag-join-direct-discovery-v2',
      { expected: true },
      { value: joinDirectDiscoveryValue },
      joinDirectDiscoveryValue === 'true',
      'JOIN_DIRECT_DISCOVERY_V2 must be true for relay-scoped join validation'
    )

    if (scenario.gatewayAvailability === 'online' && !scenario.directJoinOnly && gatewayOrigin) {
      await host.refreshGatewayCatalog({ force: true, timeoutMs: 8_000 }).catch(() => {})
      const normalizedGatewayOrigin = normalizeHttpOrigin(gatewayOrigin)
      let authorizedGateway = host.getState().authorizedGateways.find((gateway) => (
        normalizeHttpOrigin(gateway.publicUrl) === normalizedGatewayOrigin
      )) || null
      let approvalSource = 'discovered'

      if (!authorizedGateway && normalizedGatewayOrigin) {
        const syntheticGateway = installSyntheticGatewayApproval(host, {
          gatewayOrigin: normalizedGatewayOrigin,
          gatewayId: scenario.gatewayId || null,
          joinType: scenario.joinType
        })
        if (syntheticGateway) {
          authorizedGateway = syntheticGateway as typeof authorizedGateway
          approvalSource = 'synthetic'
        }
      }

      await assertCheckpoint(
        'gateway-host-approval-ready',
        { required: true },
        {
          gatewayOrigin: normalizedGatewayOrigin,
          gatewayId: authorizedGateway?.gatewayId || null,
          source: approvalSource,
          authorizedGatewayCount: host.getState().authorizedGateways.length,
          accessCatalogCount: host.getState().gatewayAccessCatalog.length
        },
        !!authorizedGateway,
        'gateway hosting approval was not available before createRelay'
      )
    } else {
      await recordCheckpoint(
        'gateway-host-approval-ready',
        { required: false },
        { skipped: true },
        'skip'
      )
    }

    const relayName = `${scenario.joinType}-relay-${scenario.scenarioId}`
    const createGatewayOrigin = scenario.omitGatewayAssignment
      ? null
      : (scenario.directJoinOnly ? null : gatewayOrigin)

    await emitTimeline('create-relay-start', {
      relayName,
      joinType: scenario.joinType,
      gatewayOrigin: createGatewayOrigin,
      directJoinOnly: scenario.directJoinOnly
    })

    await host.createRelay({
      name: relayName,
      description: `relay-scoped validation scenario ${scenario.scenarioId}`,
      isPublic: true,
      isOpen: scenario.joinType === 'open',
      fileSharing: true,
      gatewayOrigin: createGatewayOrigin,
      gatewayId: scenario.gatewayId || null,
      directJoinOnly: scenario.directJoinOnly
    })

    createdGroup = await waitFor<GroupSummary>(
      'created group',
      async () => {
        await host.refreshGroups()
        const state = host.getState()
        return state.myGroups.find((entry) => entry.name === relayName) || null
      },
      { timeoutMs: 120_000, intervalMs: 1_250 }
    )

    createdHostRelay = await waitFor<RelayEntry>(
      'host writable relay',
      async () => {
        await host.refreshRelays()
        const relay = host.getState().relays.find((entry) => entry.publicIdentifier === createdGroup.id) || null
        if (!relay) return null
        if (!isRelayWritable(relay)) return null
        return relay
      },
      { timeoutMs: 120_000, intervalMs: 1_250 }
    )

    const metadataPolicy: MetadataPolicy = scenario.metadataPolicy || 'strict'

    if (scenario.joinType === 'closed') {
      await host.sendInvite({
        groupId: createdGroup.id,
        relayUrl: createdGroup.relay || '',
        inviteePubkey: joinerAccount.pubkey,
        token: `closed-token-${scenario.scenarioId}`,
        payload: {
          groupName: createdGroup.name || createdGroup.id,
          isPublic: true,
          isOpen: false,
          fileSharing: true,
          gatewayOrigin: createGatewayOrigin,
          gatewayId: scenario.gatewayId || null,
          gatewayAuthMethod: createdGroup.gatewayAuthMethod || 'relay-scoped-bearer-v1',
          gatewayDelegation: createdGroup.gatewayDelegation || 'closed-members',
          directJoinOnly: scenario.directJoinOnly
        }
      })

      invite = await waitFor<GroupInvite>(
        'invite receipt',
        async () => {
          await joiner.refreshInvites()
          return joiner.getState().groupInvites.find((entry) => entry.groupId === createdGroup.id) || null
        },
        { timeoutMs: 120_000, intervalMs: 1_250 }
      )

      joinerRelayKey = String(invite.relayKey || '').trim() || null
      const closedMetadataMatch = scenario.directJoinOnly
        ? invite.directJoinOnly === true
        : (scenario.omitGatewayAssignment
          ? !invite.gatewayOrigin
          : normalizeHttpOrigin(invite.gatewayOrigin || null) === normalizeHttpOrigin(gatewayOrigin))

      await assertCheckpoint(
        'group-metadata-parsed',
        {
          gatewayAssigned: !scenario.omitGatewayAssignment && !scenario.directJoinOnly,
          directJoinOnly: scenario.directJoinOnly
        },
        {
          inviteId: invite.id,
          relayKey: invite.relayKey || null,
          gatewayOrigin: normalizeHttpOrigin(invite.gatewayOrigin || null),
          gatewayId: invite.gatewayId || null,
          directJoinOnly: invite.directJoinOnly === true
        },
        metadataPolicy === 'lenient' ? true : closedMetadataMatch,
        'invite metadata gateway assignment mismatch'
      )

      if (!scenario.directJoinOnly && !scenario.omitGatewayAssignment) {
        const gatewayAccessGrantId = typeof invite.gatewayAccess?.grantId === 'string'
          ? invite.gatewayAccess.grantId.trim()
          : ''
        await assertCheckpoint(
          'invite-gateway-access-grant',
          { required: true },
          {
            grantId: gatewayAccessGrantId || null,
            authMethod: invite.gatewayAccess?.authMethod || null,
            gatewayOrigin: invite.gatewayAccess?.gatewayOrigin || null,
            scopes: Array.isArray(invite.gatewayAccess?.scopes) ? invite.gatewayAccess.scopes : []
          },
          !!gatewayAccessGrantId,
          'invite payload missing gatewayAccess.grantId'
        )
      } else {
        await recordCheckpoint(
          'invite-gateway-access-grant',
          { required: false },
          { skipped: true },
          'skip'
        )
      }
    } else {
      try {
        discovered = await waitFor<GroupSummary>(
          'group discover metadata',
          async () => {
            await joiner.refreshGroups()
            return joiner.getState().groupDiscover.find((entry) => entry.id === createdGroup.id) || null
          },
          { timeoutMs: 120_000, intervalMs: 1_500 }
        )
      } catch (error) {
        const fallbackGatewayOrigin = scenario.directJoinOnly
          ? null
          : (scenario.omitGatewayAssignment ? null : gatewayOrigin)
        discovered = {
          id: createdGroup.id,
          relay: createdGroup.relay,
          name: createdGroup.name || createdGroup.id,
          isPublic: createdGroup.isPublic,
          isOpen: createdGroup.isOpen,
          gatewayId: scenario.gatewayId || null,
          gatewayOrigin: fallbackGatewayOrigin,
          directJoinOnly: scenario.directJoinOnly,
          discoveryTopic: createdGroup.discoveryTopic || null,
          hostPeerKeys: createdGroup.hostPeerKeys || [],
          leaseReplicaPeerKeys: createdGroup.leaseReplicaPeerKeys || [],
          writerIssuerPubkey: createdGroup.writerIssuerPubkey || null,
          relayKey: createdHostRelay.relayKey || null
        } as GroupSummary
        await recordCheckpoint(
          'group-discover-fallback',
          { source: 'group-discover' },
          {
            source: 'host-create-result',
            relayKey: createdHostRelay.relayKey || null,
            gatewayOrigin: fallbackGatewayOrigin,
            error: error instanceof Error ? error.message : String(error)
          },
          'pass'
        )
      }

      joinerRelayKey = String(discovered.relayKey || createdHostRelay.relayKey || '').trim() || null
      const openMetadataMatch = scenario.directJoinOnly
        ? discovered.directJoinOnly === true
        : (scenario.omitGatewayAssignment
          ? !discovered.gatewayOrigin
          : normalizeHttpOrigin(discovered.gatewayOrigin || null) === normalizeHttpOrigin(gatewayOrigin))

      await assertCheckpoint(
        'group-metadata-parsed',
        {
          gatewayAssigned: !scenario.omitGatewayAssignment && !scenario.directJoinOnly,
          directJoinOnly: scenario.directJoinOnly
        },
        {
          groupId: discovered.id,
          relayKey: discovered.relayKey || null,
          gatewayOrigin: normalizeHttpOrigin(discovered.gatewayOrigin || null),
          gatewayId: discovered.gatewayId || null,
          directJoinOnly: discovered.directJoinOnly === true
        },
        metadataPolicy === 'lenient' ? true : openMetadataMatch,
        'group metadata gateway assignment mismatch'
      )
    }

    const requiresGatewayMirrorWarmup =
      scenario.hostAvailability === 'offline'
      && scenario.gatewayAvailability === 'online'
      && scenario.gatewayCallPolicy === 'required'
      && !scenario.directJoinOnly
      && !scenario.omitGatewayAssignment
      && !!gatewayOrigin

    if (requiresGatewayMirrorWarmup && gatewayOrigin) {
      const warmGatewayOrigin = gatewayOrigin
      const mirrorWarmStatus = await waitFor<GatewayBlindPeerStatus>(
        'gateway blind-peer tracked cores before host stop',
        async () => {
          const status = await fetchGatewayBlindPeerStatus(warmGatewayOrigin)
          if (!status || !status.enabled || !status.running) return null
          if (status.trackedCores <= 0) return null
          return status
        },
        { timeoutMs: 150_000, intervalMs: 1_000 }
      )

      await assertCheckpoint(
        'gateway-blind-peer-warm-before-host-stop',
        { trackedCoresMin: 1, required: true },
        mirrorWarmStatus,
        mirrorWarmStatus.trackedCores > 0,
        'gateway blind-peer has zero tracked cores before host stop'
      )
    } else {
      await recordCheckpoint(
        'gateway-blind-peer-warm-before-host-stop',
        { trackedCoresMin: 1, required: false },
        { skipped: true },
        'skip'
      )
    }

    if (scenario.hostAvailability === 'offline') {
      await emitTimeline('host-stop-before-join')
      await host.stopWorker()
      await host.shutdown().catch(() => {})
      await assertCheckpoint(
        'host-availability-transition',
        { expected: 'offline' },
        { lifecycle: host.getState().lifecycle },
        host.getState().lifecycle !== 'ready',
        'host worker did not transition offline'
      )
    } else {
      await recordCheckpoint(
        'host-availability-transition',
        { expected: 'online' },
        { lifecycle: host.getState().lifecycle },
        'pass'
      )
    }

    await emitTimeline('start-join-flow-invoked', {
      joinType: scenario.joinType,
      hostAvailability: scenario.hostAvailability,
      gatewayAvailability: scenario.gatewayAvailability,
      directJoinOnly: scenario.directJoinOnly,
      gatewayOrigin
    })
    joinFlowActive = true
    joinerJoinStartLineIndex = joinerLines.length
    lastJoinError = null
    joinFlowInputSeen = false
    joinFlowResolvedSeen = false
    joinAuthSuccessSeen = false
    selectedPathMode = null
    selectedPathPeer = null

    const forceGatewayBootstrapPath =
      scenario.hostAvailability === 'offline'
      && scenario.gatewayAvailability === 'online'
      && !scenario.directJoinOnly

    if (scenario.joinType === 'closed' && invite) {
      const closedGatewayOrigin = scenario.directJoinOnly
        ? undefined
        : (invite.gatewayOrigin || (scenario.omitGatewayAssignment ? undefined : gatewayOrigin || undefined))
      await joiner.startJoinFlow({
        publicIdentifier: invite.groupId,
        relayKey: invite.relayKey || undefined,
        relayUrl: invite.relay || invite.relayUrl || createdGroup.relay || undefined,
        token: invite.token,
        isOpen: false,
        openJoin: false,
        directJoinOnly: invite.directJoinOnly === true,
        gatewayOrigin: closedGatewayOrigin,
        gatewayId: invite.gatewayId || undefined,
        discoveryTopic: invite.discoveryTopic || undefined,
        hostPeerKeys: forceGatewayBootstrapPath ? undefined : (invite.hostPeerKeys || undefined),
        leaseReplicaPeerKeys: invite.leaseReplicaPeerKeys || undefined,
        writerIssuerPubkey: invite.writerIssuerPubkey || undefined,
        writerLeaseEnvelope: invite.writerLeaseEnvelope || undefined,
        gatewayAccess: invite.gatewayAccess || undefined,
        blindPeer: invite.blindPeer || undefined,
        cores: invite.cores || undefined,
        writerCore: invite.writerCore || undefined,
        writerCoreHex: invite.writerCoreHex || undefined,
        autobaseLocal: invite.autobaseLocal || undefined,
        writerSecret: invite.writerSecret || undefined,
        fastForward: invite.fastForward || undefined
      })
    } else if (scenario.joinType === 'open' && discovered) {
      const hostPeerKeys = normalizePeerKeyList([
        ...(discovered.hostPeerKeys || []),
        ...(createdGroup.hostPeerKeys || [])
      ])
      const openGatewayOrigin = scenario.directJoinOnly
        ? undefined
        : (discovered.gatewayOrigin || (scenario.omitGatewayAssignment ? undefined : gatewayOrigin || undefined))

      await joiner.startJoinFlow({
        publicIdentifier: discovered.id,
        relayKey: discovered.relayKey || createdHostRelay.relayKey || undefined,
        relayUrl: discovered.relay || createdGroup.relay || undefined,
        isOpen: true,
        openJoin: true,
        directJoinOnly: scenario.directJoinOnly,
        gatewayOrigin: openGatewayOrigin,
        gatewayId: discovered.gatewayId || scenario.gatewayId || undefined,
        discoveryTopic: discovered.discoveryTopic || createdGroup.discoveryTopic || undefined,
        hostPeerKeys: forceGatewayBootstrapPath
          ? undefined
          : (hostPeerKeys.length ? hostPeerKeys : undefined),
        leaseReplicaPeerKeys: discovered.leaseReplicaPeerKeys || createdGroup.leaseReplicaPeerKeys || undefined,
        writerIssuerPubkey: discovered.writerIssuerPubkey || createdGroup.writerIssuerPubkey || undefined
      })
    } else {
      throw new Error('missing-join-input-data')
    }

    const expectJoinSuccess = scenario.expectJoinSuccess !== false
    const startJoinSignal = await waitFor<'input' | 'error'>(
      'start join flow input or early error',
      async () => {
        if (joinFlowInputSeen || joinerJoinFlowLines().some((line) => line.includes('[Worker] Start join flow input'))) return 'input'
        if (lastJoinError) return 'error'
        const errorLine = joinerJoinFlowLines().find((line) => hasJoinFailureMarker(line))
        if (errorLine) return 'error'
        return null
      },
      { timeoutMs: CHECKPOINT_TIMEOUTS.joinInput, intervalMs: 250 }
    )

    await recordCheckpoint(
      'start-join-flow-input',
      { marker: '[Worker] Start join flow input or JOIN_DISCOVERY_SOURCES' },
      { found: startJoinSignal === 'input', viaEvent: joinFlowInputSeen },
      startJoinSignal === 'input' ? 'pass' : 'skip'
    )

    if (expectJoinSuccess) {
      let openJoinResponseStage: GatewayStageEvent | null = null
      let inviteClaimResponseStage: GatewayStageEvent | null = null
      const requiresOpenJoinStages =
        scenario.gatewayCallPolicy === 'required'
        && scenario.joinType === 'open'
        && !scenario.directJoinOnly
        && !scenario.omitGatewayAssignment
      const requiresInviteClaimStages =
        scenario.gatewayCallPolicy === 'required'
        && scenario.joinType === 'closed'
        && !scenario.directJoinOnly
        && !scenario.omitGatewayAssignment

      if (requiresOpenJoinStages) {
        const prejoinBlindPeerStatus = gatewayOrigin
          ? await fetchGatewayBlindPeerStatus(gatewayOrigin)
          : null
        await assertCheckpoint(
          'gateway-blind-peer-prejoin',
          { trackedCoresMin: 1, required: true },
          prejoinBlindPeerStatus || {
            enabled: false,
            running: false,
            trackedCores: 0,
            trustedPeerCount: null,
            publicKey: null
          },
          !!prejoinBlindPeerStatus && prejoinBlindPeerStatus.trackedCores > 0,
          'gateway blind-peer tracked cores are zero before open join request'
        )

        await waitForGatewayStageCheckpoint({
          phase: 'gateway-open-join-routing',
          expected: { route: 'open-join', stage: 'routing', status: 'ok' },
          timeoutMs: CHECKPOINT_TIMEOUTS.gatewayDispatch,
          match: (entry) => entry.route === 'open-join' && entry.stage === 'routing' && entry.status === 'ok',
          failOn: (entry) => entry.route === 'open-join' && entry.stage === 'routing' && entry.status === 'error',
          failureReason: 'open-join routing did not resolve to a relay-scoped gateway'
        })

        await waitForGatewayStageCheckpoint({
          phase: 'gateway-open-join-challenge',
          expected: { route: 'open-join', stage: 'challenge-response', status: 'ok' },
          timeoutMs: CHECKPOINT_TIMEOUTS.gatewayDispatch,
          match: (entry) => entry.route === 'open-join' && entry.stage === 'challenge-response' && entry.status === 'ok',
          failOn: (entry) => entry.route === 'open-join' && entry.stage === 'final' && entry.status === 'error',
          failureReason: 'open-join challenge never reached a successful response'
        })

        await waitForGatewayStageCheckpoint({
          phase: 'gateway-open-join-response',
          expected: { route: 'open-join', stage: 'response', status: 'ok' },
          timeoutMs: CHECKPOINT_TIMEOUTS.gatewayResponse,
          match: (entry) => entry.route === 'open-join' && entry.stage === 'response' && entry.status === 'ok',
          failOn: (entry) => entry.route === 'open-join' && entry.stage === 'final' && entry.status === 'error',
          failureReason: 'open-join gateway response never returned writer bootstrap material'
        })
        openJoinResponseStage = [...gatewayStages]
          .reverse()
          .find((entry) => entry.route === 'open-join' && entry.stage === 'response' && entry.status === 'ok')
          || null
        const responseDetails = (openJoinResponseStage?.details || null) as Record<string, unknown> | null
        const hasWriterLeaseId = responseDetails?.hasWriterLeaseId === true
          || typeof responseDetails?.writerLeaseId === 'string'
        const hasWriterCommitCheckpoint = responseDetails?.hasWriterCommitCheckpoint === true
          || !!responseDetails?.writerCommitCheckpoint
        await assertCheckpoint(
          'gateway-open-join-lineage',
          { hasWriterLeaseId: true, hasWriterCommitCheckpoint: true },
          {
            stage: summarizeGatewayStage(openJoinResponseStage),
            hasWriterLeaseId,
            hasWriterCommitCheckpoint
          },
          hasWriterLeaseId && hasWriterCommitCheckpoint,
          'gateway open-join response missing lease lineage fields'
        )
        await assertCheckpoint(
          'gateway-open-join-durability',
          { writerDurabilityAtServe: true },
          {
            stage: summarizeGatewayStage(openJoinResponseStage),
            writerDurabilityAtServe: responseDetails?.writerDurabilityAtServe ?? null,
            writerDurabilityReason: typeof responseDetails?.writerDurabilityReason === 'string'
              ? responseDetails.writerDurabilityReason
              : null
          },
          responseDetails?.writerDurabilityAtServe === true,
          typeof responseDetails?.writerDurabilityReason === 'string'
            ? responseDetails.writerDurabilityReason
            : 'gateway reported non-durable lease at serve time'
        )
      }

      if (requiresInviteClaimStages) {
        await waitForGatewayStageCheckpoint({
          phase: 'gateway-invite-claim-challenge',
          expected: { route: 'invite-claim', stage: 'challenge-response', status: 'ok' },
          timeoutMs: CHECKPOINT_TIMEOUTS.gatewayDispatch,
          match: (entry) => entry.route === 'invite-claim' && entry.stage === 'challenge-response' && entry.status === 'ok',
          failOn: (entry) => entry.route === 'invite-claim' && entry.stage === 'response' && entry.status === 'error',
          failureReason: 'invite-claim challenge never reached a successful response'
        })

        await waitForGatewayStageCheckpoint({
          phase: 'gateway-invite-claim-response',
          expected: { route: 'invite-claim', stage: 'response', status: 'ok' },
          timeoutMs: CHECKPOINT_TIMEOUTS.gatewayResponse,
          match: (entry) => entry.route === 'invite-claim' && entry.stage === 'response' && entry.status === 'ok',
          failOn: (entry) => entry.route === 'invite-claim' && entry.stage === 'response' && entry.status === 'error',
          failureReason: 'invite-claim response never returned member access bootstrap material'
        })

        inviteClaimResponseStage = [...gatewayStages]
          .reverse()
          .find((entry) => entry.route === 'invite-claim' && entry.stage === 'response' && entry.status === 'ok')
          || null
        const claimDetails = (inviteClaimResponseStage?.details || null) as Record<string, unknown> | null
        await assertCheckpoint(
          'gateway-invite-claim-payload',
          { membershipState: 'active', hasMirror: true, hasAccessToken: true },
          {
            stage: summarizeGatewayStage(inviteClaimResponseStage),
            membershipState: typeof claimDetails?.membershipState === 'string'
              ? claimDetails.membershipState
              : null,
            hasMirror: claimDetails?.hasMirror === true,
            hasAccessToken: claimDetails?.hasAccessToken === true,
            refreshAfter: claimDetails?.refreshAfter ?? null,
            expiresAt: claimDetails?.expiresAt ?? null
          },
          claimDetails?.hasMirror === true
            && claimDetails?.hasAccessToken === true
            && claimDetails?.membershipState === 'active',
          'invite claim response missing active membership bootstrap material'
        )
      }

      const joinResolvedSignal = await waitFor<'resolved' | 'error'>(
        'start join flow resolved marker or early error',
        async () => {
          if (joinFlowResolvedSeen || joinerJoinFlowLines().some((line) => line.includes('[Worker] Start join flow resolved'))) return 'resolved'
          if (lastJoinError) return 'error'
          const joinerErrorLine = joinerJoinFlowLines().find((line) => hasJoinFailureMarker(line))
          if (joinerErrorLine) {
            lastJoinError = joinerErrorLine
            return 'error'
          }
          return null
        },
        { timeoutMs: CHECKPOINT_TIMEOUTS.joinResolved, intervalMs: 250 }
      )
      if (joinResolvedSignal !== 'resolved') {
        throw new Error(lastJoinError || 'join-flow-resolved-not-observed')
      }
      await recordCheckpoint(
        'start-join-flow-resolved',
        { marker: '[Worker] Start join flow resolved or JOIN_PATH_SELECTED' },
        { found: true, viaEvent: joinFlowResolvedSeen },
        'pass'
      )

      const pathMode = await waitFor<string>(
        'join path selected',
        async () => {
          if (selectedPathMode) return selectedPathMode
          const fromLog = joinerJoinFlowLines()
            .map((line) => parsePathModeFromLine(line))
            .filter((entry): entry is string => Boolean(entry))
            .pop()
          return fromLog || null
        },
        { timeoutMs: CHECKPOINT_TIMEOUTS.pathSelected, intervalMs: 300 }
      )
      selectedPathMode = pathMode

      const expectedPathModes = scenario.expectedPathModes?.length
        ? scenario.expectedPathModes
        : (
          scenario.joinType === 'open'
            ? (scenario.hostAvailability === 'offline' && scenario.gatewayAvailability === 'online' && !scenario.directJoinOnly
              ? ['open-gateway-bootstrap']
              : ['direct-join'])
            : ['closed-lease-direct', 'closed-invite-offline-fallback']
        )

      await assertCheckpoint(
        'join-path-selected',
        { expectedModes: expectedPathModes },
        { selectedPathMode, selectedPathPeer },
        expectedPathModes.includes(selectedPathMode || ''),
        'join path mode mismatch'
      )

      if (scenario.gatewayCallPolicy === 'required') {
        await waitFor(
          'gateway stage dispatch',
          async () => {
            const traceSeen = gatewayTrace.length > 0
            const stageDispatchSeen = gatewayStages.some((entry) => (
              entry.status === 'attempt'
              && (entry.stage === 'challenge-request' || entry.stage === 'request')
            ))
            return (traceSeen || stageDispatchSeen) ? true : null
          },
          { timeoutMs: CHECKPOINT_TIMEOUTS.gatewayDispatch, intervalMs: 300 }
        )
        await recordCheckpoint(
          'gateway-call-dispatch',
          { policy: 'required' },
          {
            traces: gatewayTrace.length,
            stages: gatewayStages.filter((entry) => (
              entry.status === 'attempt'
              && (entry.stage === 'challenge-request' || entry.stage === 'request')
            )).length
          },
          'pass'
        )

        const responseSignal = await waitFor<'event' | 'log'>(
          'gateway response marker',
          async () => {
            if (gatewayStages.some((entry) => (
              entry.stage === 'response'
              && entry.status === 'ok'
              && (entry.route === 'open-join' || entry.route === 'mirror' || entry.route === 'invite-claim')
            ))) {
              return 'event'
            }
            if (joinerLines.some((line) => (
              line.includes('Open join bootstrap response')
              || line.includes('Mirror metadata response')
            ))) {
              return 'log'
            }
            return null
          },
          { timeoutMs: CHECKPOINT_TIMEOUTS.gatewayResponse, intervalMs: 350 }
        )
        await recordCheckpoint(
          'gateway-response',
          { required: true },
          { found: true, via: responseSignal },
          'pass'
        )
      } else if (scenario.gatewayCallPolicy === 'forbidden') {
        const dispatchStages = gatewayStages.filter((entry) => (
          entry.status === 'attempt'
          && (entry.stage === 'challenge-request' || entry.stage === 'request')
        ))
        await recordCheckpoint(
          'gateway-call-dispatch',
          { policy: 'forbidden' },
          { traces: gatewayTrace.length, stages: dispatchStages.length },
          (gatewayTrace.length === 0 && dispatchStages.length === 0) ? 'pass' : 'fail'
        )
        if (gatewayTrace.length > 0 || dispatchStages.length > 0) {
          throw new CheckpointFailure(
            'gateway calls detected despite forbidden policy',
            checkpoints[checkpoints.length - 1]
          )
        }
      } else {
        await recordCheckpoint(
          'gateway-call-dispatch',
          { policy: 'optional' },
          { traces: gatewayTrace.length, stages: gatewayStages.length },
          'pass'
        )
      }

      await waitFor(
        'writer material marker',
        async () => (
          writerMaterialSignalSeen
          || joinAuthSuccessSeen
          || joinerLines.some((line) => (
            line.includes('[RelayServer][WriterMaterial] Join auth writer material')
            || line.includes('[RelayManager] addWriter append requested')
            || line.includes('[RelayManager] Preparing autobase writer material')
            || line.includes('[RelayManager] Updating autobase/local to align with invite writer')
            || line.includes('waitForRelayWriterActivation timeout')
          ))
        )
          ? true
          : null,
        { timeoutMs: CHECKPOINT_TIMEOUTS.writerMaterial, intervalMs: 300 }
      )

      await recordCheckpoint(
        'writer-material-apply',
        {
          requiredMarkers: [
            '[RelayServer][WriterMaterial] Join auth writer material',
            '[RelayManager] addWriter append requested',
            '[RelayManager] Preparing autobase writer material',
            '[RelayManager] Updating autobase/local to align with invite writer',
            'join-auth-success|JOIN_WRITER_SOURCE'
          ]
        },
        { found: true, viaEvent: writerMaterialSignalSeen || joinAuthSuccessSeen },
        'pass'
      )

      const prewaitTrace = await waitFor<JoinCheckpointTraceEvent>(
        'writer activation prewait checkpoint trace',
        async () => (
          [...joinCheckpointTrace]
            .reverse()
            .find((entry) => entry.worker === 'joiner' && entry.phase === 'writer-activation-prewait')
          || null
        ),
        { timeoutMs: CHECKPOINT_TIMEOUTS.writerMaterial, intervalMs: 250 }
      )
      const prewaitLeaseId = typeof prewaitTrace?.payload?.writerLeaseId === 'string'
        ? prewaitTrace.payload.writerLeaseId
        : null
      const prewaitCheckpoint = prewaitTrace?.payload?.writerCommitCheckpoint && typeof prewaitTrace.payload.writerCommitCheckpoint === 'object'
        ? prewaitTrace.payload.writerCommitCheckpoint as Record<string, unknown>
        : null
      const responseDetails = (openJoinResponseStage?.details || null) as Record<string, unknown> | null
      const responseLeaseId = typeof responseDetails?.writerLeaseId === 'string' ? responseDetails.writerLeaseId : null
      const requiresLeaseLineageMatch = requiresOpenJoinStages
      await assertCheckpoint(
        'writer-activation-lineage',
        {
          tracePhase: 'writer-activation-prewait',
          requiresLeaseLineageMatch
        },
        {
          worker: prewaitTrace?.worker || null,
          phase: prewaitTrace?.phase || null,
          prewaitLeaseId,
          responseLeaseId,
          prewaitCheckpoint
        },
        requiresLeaseLineageMatch
          ? (Boolean(prewaitLeaseId) && prewaitLeaseId === responseLeaseId && !!prewaitCheckpoint)
          : Boolean(prewaitCheckpoint),
        requiresLeaseLineageMatch
          ? 'writer prewait lineage does not match gateway lease response'
          : 'writer prewait checkpoint missing'
      )
    }

    if (expectJoinSuccess) {
      let joinedRelay: RelayEntry | null = null
      const writableSignal = await waitFor<'ok' | 'writer-activation-timeout' | 'mirror-warm-gate-incomplete'>(
        'relay writable or precondition failure',
        async () => {
          await joiner.refreshRelays().catch(() => {})
          const relay = joiner.getState().relays.find((entry) => entry.publicIdentifier === createdGroup.id) || null
          if (relay && isRelayWritable(relay)) {
            joinedRelay = relay
            return 'ok'
          }
          if (joinerLines.some((line) => line.includes('waitForRelayWriterActivation timeout'))) {
            return 'writer-activation-timeout'
          }
          if (joinerLines.some((line) => line.includes('Open join offline mirror warm gate incomplete'))) {
            return 'mirror-warm-gate-incomplete'
          }
          return null
        },
        { timeoutMs: CHECKPOINT_TIMEOUTS.writable, intervalMs: 900 }
      )

      await assertCheckpoint(
        'writable-preconditions',
        { expected: 'ok' },
        {
          signal: writableSignal,
          lastJoinError,
          markerWriterActivationTimeout: joinerLines.some((line) => line.includes('waitForRelayWriterActivation timeout')),
          markerWarmGateIncomplete: joinerLines.some((line) => line.includes('Open join offline mirror warm gate incomplete'))
        },
        writableSignal === 'ok' && !!joinedRelay,
        `writable blocked: ${writableSignal}`
      )

      if (!joinedRelay) {
        throw new Error(`writable blocked: ${writableSignal}`)
      }

      joinerRelayKey = joinedRelay.relayKey || joinerRelayKey

      await recordCheckpoint(
        'writable-reached',
        { expected: true },
        {
          relayKey: joinedRelay.relayKey || null,
          writable: joinedRelay.writable !== false,
          readyForReq: joinedRelay.readyForReq !== false
        },
        'pass'
      )

      if (typeof options.postJoinValidate === 'function') {
        if (!host || !joiner || !hostAccount || !joinerAccount || !createdGroup || !createdHostRelay) {
          throw new Error('scenario-post-join-context-incomplete')
        }
        await options.postJoinValidate({
          scenarioDir,
          hostStorage,
          joinerStorage,
          host,
          joiner,
          hostAccount,
          joinerAccount,
          hostSession,
          joinerSession,
          createdGroup,
          createdHostRelay,
          invite,
          discovered,
          joinedRelay,
          joinerRelayKey,
          gatewayOrigin,
          gatewaySecret,
          gatewayTrace,
          gatewayStages,
          checkpoints,
          joinCheckpointTrace,
          emitTimeline,
          recordCheckpoint,
          assertCheckpoint,
          waitForGatewayStageCheckpoint
        })
      }

      const observedOrigins = normalizeGatewayOriginList(gatewayTrace.map((entry) => entry.gatewayOrigin))
      if (gatewayTrace.length && gatewayOrigin) {
        await assertCheckpoint(
          'gateway-route-isolation',
          { gatewayOrigin },
          { observedOrigins },
          observedOrigins.every((origin) => origin === gatewayOrigin),
          'cross-gateway routing detected in scenario'
        )
      } else {
        await recordCheckpoint(
          'gateway-route-isolation',
          { gatewayOrigin: gatewayOrigin || null },
          { observedOrigins },
          'pass'
        )
      }

      const verdict: ScenarioVerdict = {
        ok: true,
        status: 'PASS',
        reason: 'scenario-pass',
        elapsedMs: Date.now() - startedAtMs,
        selectedPathMode,
        selectedPathPeer,
        writable: true,
        joinError: lastJoinError
      }

      await fs.writeFile(checkpointsFile, `${JSON.stringify(checkpoints, null, 2)}\n`, 'utf8')
      await fs.writeFile(gatewayTraceFile, `${JSON.stringify(gatewayTrace, null, 2)}\n`, 'utf8')
      await fs.writeFile(joinCheckpointTraceFile, `${JSON.stringify(joinCheckpointTrace, null, 2)}\n`, 'utf8')
      await fs.writeFile(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

      const result: ScenarioRunResult = {
        scenario,
        correlationId,
        startedAt: startedAtIso,
        endedAt: nowIso(),
        elapsedMs: Date.now() - startedAtMs,
        gatewayOrigin,
        gatewaySecret,
        checkpoints,
        gatewayTrace,
        joinCheckpointTrace,
        artifacts,
        verdict,
        error: null
      }

      await fs.writeFile(summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      await emitTimeline('scenario-complete', { status: verdict.status, reason: verdict.reason })
      return result
    }

    await waitFor(
      'expected join error',
      async () => {
        const errorLine = lastJoinError || joinerJoinFlowLines().find((line) => hasJoinFailureMarker(line))
        if (!errorLine) return null
        return errorLine
      },
      { timeoutMs: CHECKPOINT_TIMEOUTS.error, intervalMs: 300 }
    )

    const joinedUnexpectedly = await waitFor(
      'unexpected writable check',
      async () => {
        await joiner.refreshRelays().catch(() => {})
        const relay = joiner.getState().relays.find((entry) => entry.publicIdentifier === createdGroup.id) || null
        if (!relay) return false
        return isRelayWritable(relay)
      },
      { timeoutMs: 2_000, intervalMs: 400 }
    ).catch(() => false)

    const errorText = String(lastJoinError || joinerLines.slice(-200).join(' | '))
    const expectedFailure = String(scenario.expectFailureContains || '').trim().toLowerCase()

    await assertCheckpoint(
      'expected-failure',
      { contains: expectedFailure || null, joinSuccessExpected: false },
      { errorText: short(errorText, 120), joinedUnexpectedly },
      !joinedUnexpectedly && (!expectedFailure || errorText.toLowerCase().includes(expectedFailure)),
      'expected failure contract was not satisfied'
    )

    const verdict: ScenarioVerdict = {
      ok: true,
      status: 'PASS',
      reason: 'expected-failure-observed',
      elapsedMs: Date.now() - startedAtMs,
      selectedPathMode,
      selectedPathPeer,
      writable: false,
      joinError: errorText
    }

    await fs.writeFile(checkpointsFile, `${JSON.stringify(checkpoints, null, 2)}\n`, 'utf8')
    await fs.writeFile(gatewayTraceFile, `${JSON.stringify(gatewayTrace, null, 2)}\n`, 'utf8')
    await fs.writeFile(joinCheckpointTraceFile, `${JSON.stringify(joinCheckpointTrace, null, 2)}\n`, 'utf8')
    await fs.writeFile(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

    const result: ScenarioRunResult = {
      scenario,
      correlationId,
      startedAt: startedAtIso,
      endedAt: nowIso(),
      elapsedMs: Date.now() - startedAtMs,
      gatewayOrigin,
      gatewaySecret,
      checkpoints,
      gatewayTrace,
      joinCheckpointTrace,
      artifacts,
      verdict,
      error: null
    }

    await fs.writeFile(summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await emitTimeline('scenario-complete', { status: verdict.status, reason: verdict.reason })
    return result
  } catch (error) {
    const endedAt = nowIso()
    let firstFailedCheckpoint: string | null = null
    if (error instanceof CheckpointFailure) {
      firstFailedCheckpoint = error.checkpoint.phase
    }

    const verdict: ScenarioVerdict = {
      ok: false,
      status: 'FAIL',
      reason: error instanceof Error ? error.message : String(error),
      firstFailedCheckpoint,
      elapsedMs: Date.now() - startedAtMs,
      selectedPathMode,
      selectedPathPeer,
      writable: false,
      joinError: lastJoinError
    }

    await fs.writeFile(checkpointsFile, `${JSON.stringify(checkpoints, null, 2)}\n`, 'utf8')
    await fs.writeFile(gatewayTraceFile, `${JSON.stringify(gatewayTrace, null, 2)}\n`, 'utf8')
    await fs.writeFile(joinCheckpointTraceFile, `${JSON.stringify(joinCheckpointTrace, null, 2)}\n`, 'utf8')
    await fs.writeFile(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')

    const result: ScenarioRunResult = {
      scenario,
      correlationId,
      startedAt: startedAtIso,
      endedAt,
      elapsedMs: Date.now() - startedAtMs,
      gatewayOrigin,
      gatewaySecret,
      checkpoints,
      gatewayTrace,
      joinCheckpointTrace,
      artifacts,
      verdict,
      error: error instanceof Error ? (error.stack || error.message) : String(error)
    }

    await fs.writeFile(summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await emitTimeline('scenario-complete', { status: verdict.status, reason: verdict.reason })
    return result
  } finally {
    detachHostEvents?.()
    detachJoinerEvents?.()
    hostTap?.stop()
    joinerTap?.stop()

    await Promise.allSettled([
      host?.shutdown() || Promise.resolve(),
      joiner?.shutdown() || Promise.resolve()
    ])

    if (gatewayStack && !options.keepDocker) {
      try {
        await collectGatewayStackLogs(gatewayStack, scenarioDir)
        await emitTimeline('gateway-stack-logs-collected', {
          projectName: gatewayStack.composeProjectName,
          runtime: gatewayStack.runtime
        })
      } catch (error) {
        await emitTimeline('gateway-stack-log-collection-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
      try {
        await stopGatewayStack(gatewayStack, scenarioDir)
        await emitTimeline('gateway-stack-stopped', {
          projectName: gatewayStack.composeProjectName,
          runtime: gatewayStack.runtime
        })
      } catch (error) {
        await emitTimeline('gateway-stack-stop-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

function allPass(results: ScenarioRunResult[]): boolean {
  return results.every((result) => result.verdict.ok)
}

async function writePhaseSummary(result: PhaseResult): Promise<void> {
  await fs.writeFile(result.summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

function makePhaseResult(options: {
  phase: PhaseId
  name: string
  status: PhaseStatus
  startedAt: string
  startedAtMs: number
  reason: string
  checks: PhaseCheck[]
  summaryFile: string
  scenarioResults?: ScenarioRunResult[]
  data?: Record<string, unknown>
}): PhaseResult {
  return {
    phase: options.phase,
    name: options.name,
    status: options.status,
    startedAt: options.startedAt,
    endedAt: nowIso(),
    elapsedMs: Date.now() - options.startedAtMs,
    reason: options.reason,
    checks: options.checks,
    summaryFile: options.summaryFile,
    scenarioResults: options.scenarioResults,
    data: options.data
  }
}

async function runPhase1BaselineFreeze(options: {
  runRoot: string
  baselineLogs: string[]
  skipBaseline: boolean
}): Promise<PhaseResult> {
  const phase: PhaseId = 1
  const name = 'Baseline Freeze'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-1-baseline-freeze')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  if (options.skipBaseline) {
    const result = makePhaseResult({
      phase,
      name,
      status: 'SKIP',
      startedAt,
      startedAtMs,
      reason: 'skip-baseline-enabled',
      checks: [
        {
          name: 'baseline-scan-skipped',
          ok: true,
          detail: 'skip-baseline flag enabled'
        }
      ],
      summaryFile,
      data: {
        baselineLogs: options.baselineLogs
      }
    })
    await writePhaseSummary(result)
    return result
  }

  const baseline = await analyzeBaselineLogs(options.baselineLogs)
  const baselineFile = path.join(phaseDir, 'baseline-freeze.json')
  await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')

  const checks: PhaseCheck[] = []
  checks.push({
    name: 'baseline-logs-found',
    ok: baseline.reports.some((report) => report.exists),
    detail: `existing=${baseline.reports.filter((report) => report.exists).length}/${baseline.reports.length}`
  })

  checks.push({
    name: 'required-markers-derived',
    ok: baseline.requiredMarkers.length >= 3,
    detail: `required=${baseline.requiredMarkers.join(', ') || 'none'}`
  })

  const openOfflineHasGatewayPath = baseline.scenarioPathHints['open:offline'].includes('open-gateway-bootstrap')
  checks.push({
    name: 'open-offline-canonical-path',
    ok: openOfflineHasGatewayPath,
    detail: `detected=${baseline.scenarioPathHints['open:offline'].join(', ') || 'none'}`
  })

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'baseline-frozen' : 'baseline-invariants-missing',
    checks,
    summaryFile,
    data: {
      baselineFile
    }
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase2Instrumentation(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  keepDocker: boolean
  timeoutMs: number
  gatewayRuntime: GatewayRuntime
}): Promise<PhaseResult> {
  const phase: PhaseId = 2
  const name = 'Instrumentation Pass'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-2-instrumentation')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const scenario = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'open-offline-gateway-online-instrumentation',
      joinType: 'open',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      gatewayCallPolicy: 'required',
      expectedPathModes: ['open-gateway-bootstrap']
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: options.keepDocker,
    preferredGatewayPort: 4430,
    gatewayRuntime: options.gatewayRuntime
  })

  const checkpointsByPhase = new Set(scenario.checkpoints.map((checkpoint) => checkpoint.phase))
  const checks: PhaseCheck[] = [
    {
      name: 'scenario-pass',
      ok: scenario.verdict.ok,
      detail: scenario.verdict.reason
    },
    {
      name: 'checkpoint-group-metadata',
      ok: checkpointsByPhase.has('group-metadata-parsed'),
      detail: checkpointsByPhase.has('group-metadata-parsed') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-worker-join-direct-discovery-v2',
      ok: checkpointsByPhase.has('worker-flag-join-direct-discovery-v2'),
      detail: checkpointsByPhase.has('worker-flag-join-direct-discovery-v2') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-join-resolved',
      ok: checkpointsByPhase.has('start-join-flow-resolved'),
      detail: checkpointsByPhase.has('start-join-flow-resolved') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-gateway-dispatch',
      ok: checkpointsByPhase.has('gateway-call-dispatch'),
      detail: checkpointsByPhase.has('gateway-call-dispatch') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-gateway-routing-stage',
      ok: checkpointsByPhase.has('gateway-open-join-routing'),
      detail: checkpointsByPhase.has('gateway-open-join-routing') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-gateway-challenge-stage',
      ok: checkpointsByPhase.has('gateway-open-join-challenge'),
      detail: checkpointsByPhase.has('gateway-open-join-challenge') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-gateway-response-stage',
      ok: checkpointsByPhase.has('gateway-open-join-response'),
      detail: checkpointsByPhase.has('gateway-open-join-response') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-writer-material',
      ok: checkpointsByPhase.has('writer-material-apply'),
      detail: checkpointsByPhase.has('writer-material-apply') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-writable-preconditions',
      ok: checkpointsByPhase.has('writable-preconditions'),
      detail: checkpointsByPhase.has('writable-preconditions') ? 'present' : 'missing'
    },
    {
      name: 'checkpoint-writable',
      ok: checkpointsByPhase.has('writable-reached'),
      detail: checkpointsByPhase.has('writable-reached') ? 'present' : 'missing'
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'instrumentation-checkpoints-complete' : 'instrumentation-checkpoint-missing',
    checks,
    summaryFile,
    scenarioResults: [scenario]
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase3Contracts(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  keepDocker: boolean
  timeoutMs: number
  gatewayRuntime: GatewayRuntime
}): Promise<PhaseResult> {
  const phase: PhaseId = 3
  const name = 'Contract Layer'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-3-contracts')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const directJoinOnlyScenario = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'contract-direct-join-only-no-gateway',
      joinType: 'closed',
      hostAvailability: 'online',
      gatewayAvailability: 'online',
      directJoinOnly: true,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'forbidden',
      expectedPathModes: ['closed-lease-direct', 'closed-invite-offline-fallback']
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: options.keepDocker,
    preferredGatewayPort: 4432,
    gatewayRuntime: options.gatewayRuntime
  })

  const unassignedScenario = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'contract-gateway-unassigned-error',
      joinType: 'open',
      hostAvailability: 'offline',
      gatewayAvailability: 'offline',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      omitGatewayAssignment: true,
      gatewayCallPolicy: 'optional',
      expectJoinSuccess: false,
      expectFailureContains: 'gateway-unassigned'
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: true,
    preferredGatewayPort: 4440,
    gatewayRuntime: options.gatewayRuntime
  })

  const checks: PhaseCheck[] = [
    {
      name: 'direct-join-only-contract-captured',
      ok: directJoinOnlyScenario.checkpoints.some((checkpoint) => checkpoint.phase === 'group-metadata-parsed'),
      detail: `checkpoints=${directJoinOnlyScenario.checkpoints.length}`
    },
    {
      name: 'direct-join-only-forbids-gateway-calls',
      ok: directJoinOnlyScenario.gatewayTrace.length === 0,
      detail: `gatewayTraces=${directJoinOnlyScenario.gatewayTrace.length} verdict=${directJoinOnlyScenario.verdict.reason}`
    },
    {
      name: 'gateway-unassigned-deterministic-error',
      ok: unassignedScenario.verdict.ok,
      detail: unassignedScenario.verdict.reason
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'contract-layer-pass' : 'contract-layer-fail',
    checks,
    summaryFile,
    scenarioResults: [directJoinOnlyScenario, unassignedScenario]
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase4SingleRelayDeterministic(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  keepDocker: boolean
  timeoutMs: number
  gatewayRuntime: GatewayRuntime
  scenarioId?: string
}): Promise<PhaseResult> {
  const phase: PhaseId = 4
  const name = 'Single Relay Deterministic'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-4-single-relay')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const manifests: Array<{ manifest: ScenarioManifest, preferredGatewayPort: number }> = [
    {
      manifest: {
        scenarioId: 'single-open-offline-gateway-online',
        joinType: 'open',
        hostAvailability: 'offline',
        gatewayAvailability: 'online',
        directJoinOnly: false,
        metadataPolicy: 'lenient',
        gatewayCallPolicy: 'required',
        expectedPathModes: ['open-gateway-bootstrap']
      },
      preferredGatewayPort: 4433
    },
    {
      manifest: {
        scenarioId: 'single-closed-offline-gateway-online',
        joinType: 'closed',
        hostAvailability: 'offline',
        gatewayAvailability: 'online',
        directJoinOnly: false,
        metadataPolicy: 'lenient',
        gatewayCallPolicy: 'optional',
        expectedPathModes: ['closed-lease-direct', 'closed-invite-offline-fallback']
      },
      preferredGatewayPort: 4434
    }
  ]

  const selected = options.scenarioId
    ? manifests.filter((entry) => entry.manifest.scenarioId === options.scenarioId)
    : manifests
  if (!selected.length) {
    const available = manifests.map((entry) => entry.manifest.scenarioId).join(', ')
    throw new Error(`Phase 4 scenario-id not found: ${options.scenarioId}. Available: ${available}`)
  }

  const scenarios: ScenarioRunResult[] = []
  for (const { manifest, preferredGatewayPort } of selected) {
    const run = await runScenario({
      repoRoot: options.repoRoot,
      tuiRoot: options.tuiRoot,
      phaseDir,
      manifest,
      logLevel: options.logLevel,
      timeoutMs: options.timeoutMs,
      keepDocker: options.keepDocker,
      preferredGatewayPort,
      gatewayRuntime: options.gatewayRuntime
    })
    scenarios.push(run)
  }

  const checks: PhaseCheck[] = scenarios.map((entry) => ({
    name: `${entry.scenario.scenarioId}-parity`,
    ok: entry.verdict.ok,
    detail: entry.verdict.reason
  }))

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'single-relay-deterministic-pass' : 'single-relay-deterministic-fail',
    checks,
    summaryFile,
    scenarioResults: scenarios
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase5Isolation(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  keepDocker: boolean
  timeoutMs: number
  gatewayRuntime: GatewayRuntime
}): Promise<PhaseResult> {
  const phase: PhaseId = 5
  const name = 'Multi Relay Isolation'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-5-isolation')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const relayA = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'isolation-relay-a-gateway-1',
      joinType: 'open',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'required',
      expectedPathModes: ['open-gateway-bootstrap']
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: options.keepDocker,
    preferredGatewayPort: 4435,
    gatewayRuntime: options.gatewayRuntime
  })

  const relayB = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'isolation-relay-b-gateway-2',
      joinType: 'open',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'required',
      expectedPathModes: ['open-gateway-bootstrap']
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: options.keepDocker,
    preferredGatewayPort: 4436,
    gatewayRuntime: options.gatewayRuntime
  })

  const originsA = normalizeGatewayOriginList(relayA.gatewayTrace.map((entry) => entry.gatewayOrigin))
  const originsB = normalizeGatewayOriginList(relayB.gatewayTrace.map((entry) => entry.gatewayOrigin))

  const checks: PhaseCheck[] = [
    {
      name: 'relay-a-pass',
      ok: relayA.verdict.ok,
      detail: relayA.verdict.reason
    },
    {
      name: 'relay-b-pass',
      ok: relayB.verdict.ok,
      detail: relayB.verdict.reason
    },
    {
      name: 'distinct-gateway-origins',
      ok: Boolean(relayA.gatewayOrigin && relayB.gatewayOrigin && relayA.gatewayOrigin !== relayB.gatewayOrigin),
      detail: `gatewayA=${relayA.gatewayOrigin || 'null'} gatewayB=${relayB.gatewayOrigin || 'null'}`
    },
    {
      name: 'relay-a-origin-isolation',
      ok: originsA.every((origin) => origin === relayA.gatewayOrigin),
      detail: `observed=${originsA.join(',') || 'none'}`
    },
    {
      name: 'relay-b-origin-isolation',
      ok: originsB.every((origin) => origin === relayB.gatewayOrigin),
      detail: `observed=${originsB.join(',') || 'none'}`
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'isolation-pass' : 'isolation-fail',
    checks,
    summaryFile,
    scenarioResults: [relayA, relayB]
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase6AuthLifecycle(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  timeoutMs: number
  keepDocker: boolean
  gatewayRuntime: GatewayRuntime
}): Promise<PhaseResult> {
  const phase: PhaseId = 6
  const name = 'Relay Member Lifecycle'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-6-auth-lifecycle')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')
  const lifecycleSummaryFile = path.join(phaseDir, 'relay-member-lifecycle.json')
  const workerAuthClientPath = pathToFileURL(
    path.join(options.repoRoot, 'hyperpipe-worker/gateway/PublicGatewayAuthClient.mjs')
  ).href
  const workerControlClientPath = pathToFileURL(
    path.join(options.repoRoot, 'hyperpipe-worker/gateway/PublicGatewayControlClient.mjs')
  ).href
  const authClientModule = await import(workerAuthClientPath) as {
    default: new (args: {
      baseUrl: string
      fetchImpl?: typeof fetch
      logger?: Console
      getAuthContext?: () => {
        pubkey?: string
        nsecHex?: string
      }
    }) => {
      isEnabled: () => boolean
      issueBearerToken: (args?: {
        scope?: string
        relayKey?: string | null
        forceRefresh?: boolean
      }) => Promise<string>
    }
  }
  const controlClientModule = await import(workerControlClientPath) as {
    default: new (args: {
      baseUrl: string
      authClient?: unknown
      fetchImpl?: typeof fetch
      logger?: Console
    }) => {
      revokeRelayMember: (
        relayKey: string,
        payload?: Record<string, unknown>
      ) => Promise<Record<string, unknown>>
    }
  }
  const PublicGatewayAuthClient = authClientModule.default
  const PublicGatewayControlClient = controlClientModule.default

  const scenario = await runScenario({
    repoRoot: options.repoRoot,
    tuiRoot: options.tuiRoot,
    phaseDir,
    manifest: {
      scenarioId: 'auth-lifecycle-closed-offline-gateway-online',
      joinType: 'closed',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'required',
      expectedPathModes: ['closed-lease-direct', 'closed-invite-offline-fallback']
    },
    logLevel: options.logLevel,
    timeoutMs: options.timeoutMs,
    keepDocker: options.keepDocker,
    preferredGatewayPort: 4437,
    gatewayRuntime: options.gatewayRuntime,
    postJoinValidate: async (context) => {
      const relayKey = String(
        context.joinedRelay.relayKey
        || context.joinerRelayKey
        || context.invite?.relayKey
        || ''
      ).trim()
      const publicIdentifier = context.invite?.groupId || context.createdGroup.id
      const grantId = typeof context.invite?.gatewayAccess?.grantId === 'string'
        ? context.invite.gatewayAccess.grantId.trim()
        : ''
      const gatewayOrigin = normalizeHttpOrigin(context.gatewayOrigin)
      if (!relayKey) throw new Error('missing-relay-key-for-phase-6')
      if (!gatewayOrigin) throw new Error('missing-gateway-origin-for-phase-6')
      if (!context.hostSession?.nsecHex) throw new Error('missing-host-session-for-phase-6')

      const accessEntry = await waitForRelayMemberAccessEntry(context.joinerStorage, {
        relayKey,
        publicIdentifier,
        timeoutMs: 45_000
      })

      const storedAccessToken = typeof accessEntry.accessToken === 'string'
        ? accessEntry.accessToken.trim()
        : ''
      const storedGrantId = typeof accessEntry.grantId === 'string'
        ? accessEntry.grantId.trim()
        : ''
      await context.assertCheckpoint(
        'relay-member-access-stored',
        { grantId, accessToken: true },
        {
          relayKey,
          publicIdentifier,
          grantId: storedGrantId || null,
          hasAccessToken: !!storedAccessToken,
          scopes: Array.isArray(accessEntry.scopes) ? accessEntry.scopes : [],
          expiresAt: accessEntry.expiresAt ?? null,
          refreshAfter: accessEntry.refreshAfter ?? null
        },
        !!storedAccessToken && (!grantId || storedGrantId === grantId),
        'relay member access token was not persisted to the joiner cache'
      )

      const refreshResponse = await fetch(`${gatewayOrigin}/api/relay-member-tokens/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          relayKey,
          token: storedAccessToken
        })
      })
      const refreshPayload = await readJsonResponse(refreshResponse)
      const refreshedToken = typeof refreshPayload.accessToken === 'string'
        ? refreshPayload.accessToken.trim()
        : ''
      await context.assertCheckpoint(
        'relay-member-token-refresh',
        { status: 200, tokenRotated: true },
        {
          statusCode: refreshResponse.status,
          hasAccessToken: !!refreshedToken,
          tokenRotated: !!refreshedToken && refreshedToken !== storedAccessToken,
          expiresAt: refreshPayload.expiresAt ?? null,
          refreshAfter: refreshPayload.refreshAfter ?? null,
          error: typeof refreshPayload.error === 'string' ? refreshPayload.error : null
        },
        refreshResponse.ok && !!refreshedToken && refreshedToken !== storedAccessToken,
        'relay member access token did not refresh successfully'
      )

      const authClient = new PublicGatewayAuthClient({
        baseUrl: gatewayOrigin,
        fetchImpl: fetch,
        logger: console,
        getAuthContext: () => ({
          pubkey: context.hostAccount.pubkey,
          nsecHex: context.hostSession?.nsecHex || ''
        })
      })
      const controlClient = new PublicGatewayControlClient({
        baseUrl: gatewayOrigin,
        authClient,
        fetchImpl: fetch,
        logger: console
      })
      const revokeResult = await controlClient.revokeRelayMember(relayKey, {
        subjectPubkey: context.joinerAccount.pubkey,
        reason: 'relay-member-lifecycle-e2e'
      })
      await context.assertCheckpoint(
        'relay-member-revoke',
        { success: true, state: 'revoked' },
        revokeResult,
        revokeResult?.success === true && revokeResult?.state === 'revoked',
        'relay member revoke did not complete successfully'
      )

      const revokedRefreshResponse = await fetch(`${gatewayOrigin}/api/relay-member-tokens/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          relayKey,
          token: refreshedToken || storedAccessToken
        })
      })
      const revokedRefreshPayload = await readJsonResponse(revokedRefreshResponse)
      const revokedRefreshError = typeof revokedRefreshPayload.error === 'string'
        ? revokedRefreshPayload.error
        : null
      await context.assertCheckpoint(
        'relay-member-refresh-revoked',
        { status: 401, error: 'gateway-member-access-revoked' },
        {
          statusCode: revokedRefreshResponse.status,
          error: revokedRefreshError,
          payload: revokedRefreshPayload
        },
        revokedRefreshResponse.status === 401 && revokedRefreshError === 'gateway-member-access-revoked',
        'revoked relay member token still refreshed successfully'
      )

      const revokedMirrorResponse = await fetch(
        `${gatewayOrigin}/api/relays/${encodeURIComponent(relayKey)}/mirror`,
        {
          headers: {
            authorization: `Bearer ${refreshedToken || storedAccessToken}`
          }
        }
      )
      const revokedMirrorPayload = await readJsonResponse(revokedMirrorResponse)
      const revokedMirrorError = typeof revokedMirrorPayload.error === 'string'
        ? revokedMirrorPayload.error
        : null
      await context.assertCheckpoint(
        'relay-member-mirror-revoked',
        { status: 401, error: 'gateway-member-access-revoked' },
        {
          statusCode: revokedMirrorResponse.status,
          error: revokedMirrorError,
          payload: revokedMirrorPayload
        },
        revokedMirrorResponse.status === 401 && revokedMirrorError === 'gateway-member-access-revoked',
        'revoked relay member token still fetched mirror metadata'
      )

      await fs.writeFile(
        lifecycleSummaryFile,
        `${JSON.stringify({
          generatedAt: nowIso(),
          relayKey,
          publicIdentifier,
          gatewayOrigin,
          inviteGrantId: grantId || null,
          storedGrantId: storedGrantId || null,
          refreshedTokenIssued: !!refreshedToken,
          revokeResult,
          revokedRefresh: {
            statusCode: revokedRefreshResponse.status,
            error: revokedRefreshError
          },
          revokedMirror: {
            statusCode: revokedMirrorResponse.status,
            error: revokedMirrorError
          }
        }, null, 2)}\n`,
        'utf8'
      )
    }
  })

  const checkpointsByPhase = new Set(scenario.checkpoints.map((checkpoint) => checkpoint.phase))
  const checks: PhaseCheck[] = [
    {
      name: 'scenario-pass',
      ok: scenario.verdict.ok,
      detail: scenario.verdict.reason
    },
    {
      name: 'invite-grant-issued',
      ok: checkpointsByPhase.has('invite-gateway-access-grant'),
      detail: checkpointsByPhase.has('invite-gateway-access-grant') ? 'present' : 'missing'
    },
    {
      name: 'invite-claim-stage',
      ok: checkpointsByPhase.has('gateway-invite-claim-response'),
      detail: checkpointsByPhase.has('gateway-invite-claim-response') ? 'present' : 'missing'
    },
    {
      name: 'member-access-stored',
      ok: checkpointsByPhase.has('relay-member-access-stored'),
      detail: checkpointsByPhase.has('relay-member-access-stored') ? 'present' : 'missing'
    },
    {
      name: 'member-token-refresh',
      ok: checkpointsByPhase.has('relay-member-token-refresh'),
      detail: checkpointsByPhase.has('relay-member-token-refresh') ? 'present' : 'missing'
    },
    {
      name: 'member-revoke',
      ok: checkpointsByPhase.has('relay-member-revoke'),
      detail: checkpointsByPhase.has('relay-member-revoke') ? 'present' : 'missing'
    },
    {
      name: 'member-refresh-denied-after-revoke',
      ok: checkpointsByPhase.has('relay-member-refresh-revoked'),
      detail: checkpointsByPhase.has('relay-member-refresh-revoked') ? 'present' : 'missing'
    },
    {
      name: 'member-mirror-denied-after-revoke',
      ok: checkpointsByPhase.has('relay-member-mirror-revoked'),
      detail: checkpointsByPhase.has('relay-member-mirror-revoked') ? 'present' : 'missing'
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'relay-member-lifecycle-pass' : 'relay-member-lifecycle-fail',
    checks,
    summaryFile,
    scenarioResults: [scenario],
    data: {
      lifecycleSummaryFile
    }
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase7Regression(options: {
  repoRoot: string
  tuiRoot: string
  runRoot: string
  logLevel: LogLevel
  keepDocker: boolean
  timeoutMs: number
  gatewayRuntime: GatewayRuntime
  scenarioId?: string
}): Promise<PhaseResult> {
  const phase: PhaseId = 7
  const name = 'End-to-End Regression'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-7-regression')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const manifests: ScenarioManifest[] = [
    {
      scenarioId: 'reg-open-offline-gateway-online',
      joinType: 'open',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'required',
      expectedPathModes: ['open-gateway-bootstrap']
    },
    {
      scenarioId: 'reg-closed-offline-gateway-online',
      joinType: 'closed',
      hostAvailability: 'offline',
      gatewayAvailability: 'online',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'optional',
      expectedPathModes: ['closed-lease-direct', 'closed-invite-offline-fallback']
    },
    {
      scenarioId: 'reg-open-online-gateway-offline',
      joinType: 'open',
      hostAvailability: 'online',
      gatewayAvailability: 'offline',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'optional',
      expectedPathModes: ['direct-join', 'open-offline-fallback']
    },
    {
      scenarioId: 'reg-closed-online-gateway-offline',
      joinType: 'closed',
      hostAvailability: 'online',
      gatewayAvailability: 'offline',
      directJoinOnly: false,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'optional',
      expectedPathModes: ['closed-lease-direct']
    },
    {
      scenarioId: 'reg-open-direct-join-only',
      joinType: 'open',
      hostAvailability: 'online',
      gatewayAvailability: 'offline',
      directJoinOnly: true,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'forbidden',
      expectedPathModes: ['direct-join']
    },
    {
      scenarioId: 'reg-closed-direct-join-only',
      joinType: 'closed',
      hostAvailability: 'online',
      gatewayAvailability: 'offline',
      directJoinOnly: true,
      metadataPolicy: 'lenient',
      gatewayCallPolicy: 'forbidden',
      expectedPathModes: ['closed-lease-direct']
    }
  ]

  const selected = options.scenarioId
    ? manifests.filter((entry) => entry.scenarioId === options.scenarioId)
    : manifests
  if (!selected.length) {
    const available = manifests.map((entry) => entry.scenarioId).join(', ')
    throw new Error(`Phase 7 scenario-id not found: ${options.scenarioId}. Available: ${available}`)
  }

  const results: ScenarioRunResult[] = []
  let preferredPort = 4441
  for (const manifest of selected) {
    const run = await runScenario({
      repoRoot: options.repoRoot,
      tuiRoot: options.tuiRoot,
      phaseDir,
      manifest,
      logLevel: options.logLevel,
      timeoutMs: options.timeoutMs,
      keepDocker: options.keepDocker,
      preferredGatewayPort: preferredPort,
      gatewayRuntime: options.gatewayRuntime
    })
    results.push(run)
    preferredPort += 1
  }

  const checks: PhaseCheck[] = [
    {
      name: 'all-regression-scenarios-pass',
      ok: allPass(results),
      detail: `passed=${results.filter((entry) => entry.verdict.ok).length}/${results.length}`
    },
    {
      name: 'direct-join-only-no-gateway-calls',
      ok: results
        .filter((entry) => entry.scenario.directJoinOnly)
        .every((entry) => entry.gatewayTrace.length === 0),
      detail: 'validated for direct-join-only scenarios'
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'regression-pass' : 'regression-fail',
    checks,
    summaryFile,
    scenarioResults: results
  })

  await writePhaseSummary(result)
  return result
}

async function runPhase8CiGates(options: {
  runRoot: string
  priorPhases: PhaseResult[]
}): Promise<PhaseResult> {
  const phase: PhaseId = 8
  const name = 'CI And Triage Gates'
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-8-ci-gates')
  await fs.mkdir(phaseDir, { recursive: true })
  const summaryFile = path.join(phaseDir, 'phase-summary.json')

  const requiredPhaseIds: PhaseId[] = [3, 4, 5]
  const requiredPhases = options.priorPhases.filter((entry) => requiredPhaseIds.includes(entry.phase))
  const requiredPass = requiredPhases.every((entry) => entry.status === 'PASS')

  let firstFail: {
    phase: number
    scenarioId: string | null
    checkpoint: string | null
    reason: string
  } | null = null

  for (const phaseResult of options.priorPhases) {
    if (phaseResult.status !== 'FAIL') continue
    const scenario = phaseResult.scenarioResults?.find((entry) => !entry.verdict.ok) || null
    firstFail = {
      phase: phaseResult.phase,
      scenarioId: scenario?.scenario?.scenarioId || null,
      checkpoint: scenario?.verdict?.firstFailedCheckpoint || null,
      reason: scenario?.verdict?.reason || phaseResult.reason
    }
    break
  }

  const gatePayload = {
    generatedAt: nowIso(),
    requiredPhaseIds,
    requiredPass,
    firstFail,
    gates: {
      prRequired: requiredPass,
      nightlyRequired: options.priorPhases.every((entry) => entry.status !== 'FAIL')
    },
    repro: firstFail
      ? {
        phase: firstFail.phase,
        scenario: firstFail.scenarioId,
        command: `npm run demo:e2e:real:relay-scoped-phased-docker -- --phases ${firstFail.phase}`
      }
      : null
  }

  const gateFile = path.join(phaseDir, 'ci-gates.json')
  await fs.writeFile(gateFile, `${JSON.stringify(gatePayload, null, 2)}\n`, 'utf8')

  const checks: PhaseCheck[] = [
    {
      name: 'pr-gates',
      ok: gatePayload.gates.prRequired,
      detail: `required phases ${requiredPhaseIds.join(',')} must pass`
    },
    {
      name: 'nightly-gates',
      ok: gatePayload.gates.nightlyRequired,
      detail: 'all executed phases must pass'
    }
  ]

  const status: PhaseStatus = checks.every((check) => check.ok) ? 'PASS' : 'FAIL'
  const result = makePhaseResult({
    phase,
    name,
    status,
    startedAt,
    startedAtMs,
    reason: status === 'PASS' ? 'ci-gates-pass' : 'ci-gates-fail',
    checks,
    summaryFile,
    data: {
      gateFile,
      gatePayload
    }
  })

  await writePhaseSummary(result)
  return result
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
      phases: { type: 'string' },
      'scenario-id': { type: 'string' },
      'log-level': { type: 'string' },
      'keep-docker': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'gateway-runtime': { type: 'string' },
      'skip-baseline': { type: 'string' },
      'baseline-log': { type: 'string', multiple: true }
    }
  })

  const runId = randomId('run')
  const runRoot = parsed.values['base-dir']
    ? path.resolve(process.cwd(), parsed.values['base-dir'])
    : path.join(repoRoot, 'test-logs/relay-scoped-validation', runId)

  await fs.mkdir(runRoot, { recursive: true })

  const selectedPhases = parsePhaseList(parsed.values.phases)
  if (!selectedPhases.length) {
    throw new Error('No valid phases selected. Use --phases 1,2,3,4,5,6,7,8')
  }

  const logLevel = parseLogLevel(parsed.values['log-level'])
  const keepDocker = parseBoolean(parsed.values['keep-docker'], false)
  const gatewayRuntime = parseGatewayRuntime(parsed.values['gateway-runtime'])
  const timeoutMsRaw = Number.parseInt(String(parsed.values['timeout-ms'] || '1200000'), 10)
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(180_000, timeoutMsRaw) : 1_200_000
  const scenarioId = String(parsed.values['scenario-id'] || '').trim() || null
  const skipBaseline = parseBoolean(parsed.values['skip-baseline'], false)
  const baselineLogs = parsed.values['baseline-log']?.length
    ? parsed.values['baseline-log'].map((entry) => path.resolve(process.cwd(), entry))
    : DEFAULT_BASELINE_LOGS
  const forcedWorkerFlags: Record<string, string> = {
    JOIN_DIRECT_DISCOVERY_V2: 'true',
    JOIN_TOTAL_DEADLINE_MS: process.env.JOIN_TOTAL_DEADLINE_MS || '0',
    RELAY_PROTOCOL_REQUEST_TIMEOUT_MS: process.env.RELAY_PROTOCOL_REQUEST_TIMEOUT_MS || '0',
    DIRECT_JOIN_VERIFY_TIMEOUT_MS: process.env.DIRECT_JOIN_VERIFY_TIMEOUT_MS || '0',
    RELAY_SCOPED_GATEWAY_V1: 'true',
    GATEWAY_SCOPED_CREDENTIALS_V1: 'true',
    GATEWAY_CREATOR_POLICY_V1: 'true'
  }
  for (const [key, value] of Object.entries(forcedWorkerFlags)) {
    process.env[key] = value
  }

  const timelineFile = path.join(runRoot, 'timeline.log')
  await appendLine(
    timelineFile,
    `[${nowIso()}] start phases=${selectedPhases.join(',')} scenarioId=${scenarioId || 'all'} runRoot=${runRoot}`
  )
  logProgress(`runRoot=${runRoot}`)
  logProgress(`selectedPhases=${selectedPhases.join(',')}`)
  logProgress(`scenarioId=${scenarioId || 'all'}`)
  logProgress(`gatewayRuntime=${gatewayRuntime}`)
  logProgress(`workerFlags=${JSON.stringify(forcedWorkerFlags)}`)

  const phaseResults: PhaseResult[] = []
  for (const phase of selectedPhases) {
    await appendLine(timelineFile, `[${nowIso()}] phase-start=${phase}`)

    if (phase === 1) {
      const result = await runPhase1BaselineFreeze({
        runRoot,
        baselineLogs,
        skipBaseline
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 2) {
      const result = await runPhase2Instrumentation({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        gatewayRuntime
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 3) {
      const result = await runPhase3Contracts({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        gatewayRuntime
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 4) {
      const result = await runPhase4SingleRelayDeterministic({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        gatewayRuntime,
        scenarioId: scenarioId || undefined
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 5) {
      const result = await runPhase5Isolation({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        gatewayRuntime
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 6) {
      const result = await runPhase6AuthLifecycle({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        timeoutMs,
        keepDocker,
        gatewayRuntime
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 7) {
      const result = await runPhase7Regression({
        repoRoot,
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        gatewayRuntime,
        scenarioId: scenarioId || undefined
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }

    if (phase === 8) {
      const result = await runPhase8CiGates({
        runRoot,
        priorPhases: phaseResults
      })
      phaseResults.push(result)
      await appendLine(timelineFile, `[${nowIso()}] phase-end=${phase} status=${result.status}`)
      continue
    }
  }

  const anyFail = phaseResults.some((result) => result.status === 'FAIL')
  const summary = {
    generatedAt: nowIso(),
    runRoot,
    timelineFile,
    selectedPhases,
    result: {
      ok: !anyFail,
      reason: anyFail ? 'one-or-more-phases-failed' : 'selected-phases-passed'
    },
    phases: phaseResults
  }

  const summaryFile = path.join(runRoot, 'summary.json')
  await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`[output] ${summaryFile}\n`)
  if (anyFail) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
