import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import { TuiController, type RuntimeOptions } from '../../src/domain/controller.js'
import type { GroupSummary, LogLevel, RelayEntry } from '../../src/domain/types.js'

type JoinResult = {
  ok: boolean
  reason: string
  elapsedMs: number
  groupId?: string
  relayUrl?: string | null
  discoveredRelayUrl?: string | null
  selectedPathMode?: string | null
  selectedPathPeer?: string | null
  writerDeadlineOk?: boolean | null
  writerDeadlineReason?: string | null
  hostAccountPubkey?: string
  joinerAccountPubkey?: string
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
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

function short(value: string | null | undefined, len = 16): string {
  const text = String(value || '').trim()
  if (!text) return '-'
  if (text.length <= len) return text
  return `${text.slice(0, len)}…`
}

function dedupeLower(input: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      input
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

function isRelayWritable(entry: RelayEntry | null | undefined): boolean {
  if (!entry) return false
  return entry.writable !== false && entry.readyForReq !== false
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

function logProgress(step: string): void {
  process.stdout.write(`[progress] ${nowIso()} ${step}\n`)
}

class WorkerLogTap {
  private outIndex = 0
  private errIndex = 0
  private interval: NodeJS.Timeout | null = null
  private lastLineAt = Date.now()
  private onLine: (label: string, stream: 'stdout' | 'stderr', line: string) => void

  constructor(
    private readonly label: string,
    private readonly controller: TuiController,
    onLine: (label: string, stream: 'stdout' | 'stderr', line: string) => void
  ) {
    this.onLine = onLine
  }

  start(pollMs = 250): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      const snapshot = this.controller.getState()

      if (snapshot.workerStdout.length > this.outIndex) {
        const next = snapshot.workerStdout.slice(this.outIndex)
        this.outIndex = snapshot.workerStdout.length
        for (const line of next) {
          this.lastLineAt = Date.now()
          this.onLine(this.label, 'stdout', String(line))
        }
      }

      if (snapshot.workerStderr.length > this.errIndex) {
        const next = snapshot.workerStderr.slice(this.errIndex)
        this.errIndex = snapshot.workerStderr.length
        for (const line of next) {
          this.lastLineAt = Date.now()
          this.onLine(this.label, 'stderr', String(line))
        }
      }
    }, Math.max(100, Math.trunc(pollMs)))
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = null
  }

  secondsSinceLine(): number {
    return Math.floor((Date.now() - this.lastLineAt) / 1000)
  }
}

type WorkerMessageLike = {
  type?: unknown
  data?: unknown
}

function attachWorkerEventTap(
  label: string,
  controller: TuiController,
  onEvent: (label: string, message: WorkerMessageLike) => void
): () => void {
  try {
    const host = (controller as unknown as {
      workerHost?: {
        onMessage?: (handler: (message: WorkerMessageLike) => void) => () => void
      }
    }).workerHost

    if (!host || typeof host.onMessage !== 'function') return () => {}
    return host.onMessage((message) => onEvent(label, message))
  } catch {
    return () => {}
  }
}

async function bootPeer(controller: TuiController, label: string): Promise<string> {
  logProgress(`${label}: initialize`)
  await controller.initialize()
  const created = await controller.generateNsecAccount(`${label}-${Date.now().toString(36)}`)
  await controller.selectAccount(created.pubkey)
  await controller.unlockCurrentAccount()
  await controller.startWorker()
  await Promise.allSettled([
    controller.refreshRelays(),
    controller.refreshGroups(),
    controller.refreshInvites(),
    controller.refreshChats()
  ])
  logProgress(`${label}: ready ${short(created.pubkey)}`)
  return created.pubkey
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      'base-dir': { type: 'string' },
      'json-out': { type: 'string' },
      'log-level': { type: 'string' },
      'gateway-mode': { type: 'string' },
      'hard-timeout-ms': { type: 'string' },
      'stall-timeout-ms': { type: 'string' },
      'discovery-timeout-ms': { type: 'string' },
      'verbose-logs': { type: 'string' }
    }
  })

  const cwd = process.cwd()
  const baseDirArg = parsed.values['base-dir']
    ? path.resolve(cwd, parsed.values['base-dir'])
    : path.join(
      os.tmpdir(),
      'hypertuna-direct-join-host-online-debug',
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    )

  const jsonOut = parsed.values['json-out']
    ? path.resolve(cwd, parsed.values['json-out'])
    : ''
  const gatewayMode = parsed.values['gateway-mode'] === 'auto' ? 'auto' : 'disabled'
  const hardTimeoutMs = parseMs(parsed.values['hard-timeout-ms'], 8 * 60 * 1000)
  const stallTimeoutMs = parseMs(parsed.values['stall-timeout-ms'], 75_000)
  const discoveryTimeoutMs = parseMs(parsed.values['discovery-timeout-ms'], 90_000)
  const verboseLogs = parseBooleanFlag(parsed.values['verbose-logs'], true)
  const logLevel = parseLogLevel(parsed.values['log-level'])

  await fs.mkdir(baseDirArg, { recursive: true })
  const hostStorage = path.join(baseDirArg, 'host')
  const joinerStorage = path.join(baseDirArg, 'joiner')
  await fs.mkdir(hostStorage, { recursive: true })
  await fs.mkdir(joinerStorage, { recursive: true })

  const hostRuntime: RuntimeOptions = {
    cwd,
    storageDir: hostStorage,
    noAnimations: true,
    logLevel
  }
  const joinerRuntime: RuntimeOptions = {
    cwd,
    storageDir: joinerStorage,
    noAnimations: true,
    logLevel
  }

  const host = new TuiController(hostRuntime)
  const joiner = new TuiController(joinerRuntime)

  const hostLogFile = path.join(baseDirArg, 'host-worker.log')
  const joinerLogFile = path.join(baseDirArg, 'joiner-worker.log')
  const timelineLogFile = path.join(baseDirArg, 'timeline.log')

  const append = async (target: string, line: string): Promise<void> => {
    await fs.appendFile(target, `${line}\n`, 'utf8')
  }

  let selectedPathMode: string | null = null
  let selectedPathPeer: string | null = null
  let writerDeadlineOk: boolean | null = null
  let writerDeadlineReason: string | null = null
  let lastProgressAt = Date.now()
  let done = false

  const onLogLine = (label: string, stream: 'stdout' | 'stderr', line: string): void => {
    const normalizedLine = String(line || '').trim()
    const stamped = `[${nowIso()}] [${label} ${stream}] ${normalizedLine}`
    if (verboseLogs || normalizedLine.includes('JOIN_') || normalizedLine.includes('start-join-flow')) {
      process.stdout.write(`${stamped}\n`)
    }
    const target = label === 'host' ? hostLogFile : joinerLogFile
    void append(target, stamped).catch(() => {})
    void append(timelineLogFile, stamped).catch(() => {})

    const importantMarkers = [
      'JOIN_DISCOVERY_SOURCES',
      'JOIN_PROBE_RESULT',
      'JOIN_PATH_SELECTED',
      'JOIN_WRITER_SOURCE',
      'JOIN_WRITABLE_DEADLINE_RESULT',
      'Start join flow resolved',
      'startJoinAuthentication',
      'join-auth-error',
      'relay-joined',
      'relay-writable'
    ]
    if (importantMarkers.some((marker) => normalizedLine.includes(marker))) {
      lastProgressAt = Date.now()
    }

    if (normalizedLine.includes('JOIN_PATH_SELECTED')) {
      const modeMatch = normalizedLine.match(/mode:\s*'([^']+)'/)
      const peerMatch = normalizedLine.match(/peerKey:\s*'([^']+)'/)
      if (modeMatch?.[1]) selectedPathMode = modeMatch[1]
      if (peerMatch?.[1]) selectedPathPeer = peerMatch[1]
    }
    if (normalizedLine.includes('JOIN_WRITABLE_DEADLINE_RESULT')) {
      if (normalizedLine.includes('ok: true')) {
        writerDeadlineOk = true
        writerDeadlineReason = null
      }
      if (normalizedLine.includes('ok: false')) {
        writerDeadlineOk = false
        const reasonMatch = normalizedLine.match(/reason:\s*'([^']+)'/)
        writerDeadlineReason = reasonMatch?.[1] || 'join-failed'
      }
    }
  }

  const hostTap = new WorkerLogTap('host', host, onLogLine)
  const joinerTap = new WorkerLogTap('joiner', joiner, onLogLine)
  const trackedWorkerEventTypes = new Set([
    'JOIN_DISCOVERY_SOURCES',
    'JOIN_PROBE_RESULT',
    'JOIN_PATH_SELECTED',
    'JOIN_WRITER_SOURCE',
    'JOIN_WRITABLE_DEADLINE_RESULT',
    'join-auth-error',
    'relay-joined',
    'relay-update'
  ])

  const onWorkerEvent = (label: string, message: WorkerMessageLike): void => {
    const eventType = String(message?.type || '').trim()
    if (!trackedWorkerEventTypes.has(eventType)) return
    const payload = {
      type: eventType,
      data: message?.data ?? null
    }
    const line = `[${nowIso()}] [${label} ipc] ${JSON.stringify(payload)}`
    process.stdout.write(`${line}\n`)
    void append(timelineLogFile, line).catch(() => {})
    lastProgressAt = Date.now()

    if (eventType === 'JOIN_PATH_SELECTED') {
      const data = payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : {}
      const mode = typeof data.mode === 'string' ? data.mode.trim() : ''
      const peer = typeof data.peerKey === 'string' ? data.peerKey.trim() : ''
      selectedPathMode = mode || null
      selectedPathPeer = peer || null
    }

    if (eventType === 'JOIN_WRITABLE_DEADLINE_RESULT') {
      const data = payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : {}
      if (data.ok === true) {
        writerDeadlineOk = true
        writerDeadlineReason = null
      } else if (data.ok === false) {
        writerDeadlineOk = false
        writerDeadlineReason = typeof data.reason === 'string' ? data.reason : 'join-failed'
      }
    }
  }

  hostTap.start()
  joinerTap.start()
  const detachHostEvents = attachWorkerEventTap('host', host, onWorkerEvent)
  const detachJoinerEvents = attachWorkerEventTap('joiner', joiner, onWorkerEvent)

  const hardWatchdog = setTimeout(() => {
    if (done) return
    process.stderr.write(`[fatal] global timeout exceeded (${hardTimeoutMs}ms)\n`)
    process.exitCode = 1
  }, hardTimeoutMs)

  let result: JoinResult = {
    ok: false,
    reason: 'not-started',
    elapsedMs: 0
  }

  const startedAt = Date.now()

  try {
    logProgress(`baseDir=${baseDirArg}`)
    logProgress(`gatewayMode=${gatewayMode}`)
    logProgress('env check (timeouts)')
    process.stdout.write(
      `[config] JOIN_DIRECT_DISCOVERY_V2=${process.env.JOIN_DIRECT_DISCOVERY_V2 || '(unset)'} `
      + `JOIN_TOTAL_DEADLINE_MS=${process.env.JOIN_TOTAL_DEADLINE_MS || '(unset)'} `
      + `DIRECT_JOIN_VERIFY_TIMEOUT_MS=${process.env.DIRECT_JOIN_VERIFY_TIMEOUT_MS || '(unset)'}\n`
    )

    const [hostPubkey, joinerPubkey] = await Promise.all([
      bootPeer(host, 'host'),
      bootPeer(joiner, 'joiner')
    ])

    const relayName = `direct-host-online-${Date.now().toString(36)}`
    logProgress(`host: create relay ${relayName}`)
    await host.createRelay({
      name: relayName,
      description: 'targeted direct-join host-online debug',
      isPublic: true,
      isOpen: true,
      fileSharing: true
    })

    const hostGroup = await waitFor<GroupSummary>(
      'host group availability',
      async () => {
        await host.refreshGroups()
        const snapshot = host.getState()
        return snapshot.myGroups.find((entry) => entry.name === relayName) || null
      },
      { timeoutMs: discoveryTimeoutMs, intervalMs: 1_200 }
    )

    logProgress(
      `host group ready id=${hostGroup.id} relay=${hostGroup.relay || '-'} `
      + `topic=${short(hostGroup.discoveryTopic || null)} hosts=${(hostGroup.hostPeerKeys || []).length}`
    )

    const discovered = await waitFor<GroupSummary>(
      'joiner discover host group',
      async () => {
        await joiner.refreshGroups()
        const snapshot = joiner.getState()
        return snapshot.groupDiscover.find((entry) => entry.id === hostGroup.id) || null
      },
      { timeoutMs: discoveryTimeoutMs, intervalMs: 1_500 }
    )

    const hostPeerKeys = dedupeLower([
      ...(hostGroup.hostPeerKeys || []),
      ...(discovered.hostPeerKeys || [])
    ])
    const leaseReplicaPeerKeys = dedupeLower([
      ...(hostGroup.leaseReplicaPeerKeys || []),
      ...(discovered.leaseReplicaPeerKeys || [])
    ])
    const discoveryTopic = String(
      discovered.discoveryTopic
      || hostGroup.discoveryTopic
      || ''
    ).trim() || null

    logProgress(
      `join start id=${hostGroup.id} relay=${discovered.relay || hostGroup.relay || '-'} `
      + `topic=${short(discoveryTopic)} hostPeers=${hostPeerKeys.length} leaseReplicas=${leaseReplicaPeerKeys.length}`
    )

    await joiner.startJoinFlow({
      publicIdentifier: hostGroup.id,
      relayUrl: discovered.relay || hostGroup.relay || undefined,
      isOpen: true,
      openJoin: true,
      directJoinOnly: gatewayMode === 'disabled',
      discoveryTopic,
      hostPeerKeys,
      leaseReplicaPeerKeys,
      writerIssuerPubkey: discovered.writerIssuerPubkey || hostGroup.writerIssuerPubkey || undefined
    })

    let lastWritableState = false
    const joinLoopStartedAt = Date.now()
    while (true) {
      await sleep(1_000)
      await joiner.refreshRelays().catch(() => {})

      const joinerState = joiner.getState()
      const relay = joinerState.relays.find((entry) => entry.publicIdentifier === hostGroup.id) || null
      const writableNow = isRelayWritable(relay)

      if (relay && writableNow !== lastWritableState) {
        lastWritableState = writableNow
        lastProgressAt = Date.now()
        logProgress(
          `joiner relay state relayKey=${short(relay.relayKey)} writable=${String(relay.writable)} `
          + `readyForReq=${String(relay.readyForReq)} conn=${relay.connectionUrl || '-'}`
        )
      }

      if (relay && writableNow) {
        result = {
          ok: true,
          reason: 'joined-writable',
          elapsedMs: Date.now() - startedAt,
          groupId: hostGroup.id,
          relayUrl: relay.connectionUrl || null,
          discoveredRelayUrl: discovered.relay || hostGroup.relay || null,
          selectedPathMode,
          selectedPathPeer,
          writerDeadlineOk,
          writerDeadlineReason,
          hostAccountPubkey: hostPubkey,
          joinerAccountPubkey: joinerPubkey
        }
        break
      }

      const stalledForMs = Date.now() - lastProgressAt
      if (stalledForMs >= stallTimeoutMs) {
        result = {
          ok: false,
          reason: 'stalled-no-progress',
          elapsedMs: Date.now() - startedAt,
          groupId: hostGroup.id,
          relayUrl: relay?.connectionUrl || null,
          discoveredRelayUrl: discovered.relay || hostGroup.relay || null,
          selectedPathMode,
          selectedPathPeer,
          writerDeadlineOk,
          writerDeadlineReason,
          hostAccountPubkey: hostPubkey,
          joinerAccountPubkey: joinerPubkey,
          error: `No significant join progress for ${Math.floor(stalledForMs / 1000)}s`
        }
        break
      }

      if (Date.now() - joinLoopStartedAt >= hardTimeoutMs) {
        result = {
          ok: false,
          reason: 'join-hard-timeout',
          elapsedMs: Date.now() - startedAt,
          groupId: hostGroup.id,
          relayUrl: relay?.connectionUrl || null,
          discoveredRelayUrl: discovered.relay || hostGroup.relay || null,
          selectedPathMode,
          selectedPathPeer,
          writerDeadlineOk,
          writerDeadlineReason,
          hostAccountPubkey: hostPubkey,
          joinerAccountPubkey: joinerPubkey,
          error: `Join loop exceeded ${hardTimeoutMs}ms`
        }
        break
      }
    }
  } catch (error) {
    result = {
      ok: false,
      reason: 'exception',
      elapsedMs: Date.now() - startedAt,
      selectedPathMode,
      selectedPathPeer,
      writerDeadlineOk,
      writerDeadlineReason,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    done = true
    clearTimeout(hardWatchdog)
    hostTap.stop()
    joinerTap.stop()
    detachHostEvents()
    detachJoinerEvents()
    await Promise.allSettled([
      host.shutdown(),
      joiner.shutdown()
    ])
  }

  const summary = {
    generatedAt: nowIso(),
    baseDir: baseDirArg,
    env: {
      JOIN_DIRECT_DISCOVERY_V2: process.env.JOIN_DIRECT_DISCOVERY_V2 || null,
      JOIN_TOTAL_DEADLINE_MS: process.env.JOIN_TOTAL_DEADLINE_MS || null,
      DIRECT_JOIN_VERIFY_TIMEOUT_MS: process.env.DIRECT_JOIN_VERIFY_TIMEOUT_MS || null,
      DIRECT_JOIN_WRITABLE_TIMEOUT_MS: process.env.DIRECT_JOIN_WRITABLE_TIMEOUT_MS || null
    },
    hostLogFile,
    joinerLogFile,
    timelineLogFile,
    result
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (jsonOut) {
    await fs.mkdir(path.dirname(jsonOut), { recursive: true })
    await fs.writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    process.stdout.write(`[output] wrote summary to ${jsonOut}\n`)
  }

  if (!result.ok) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
