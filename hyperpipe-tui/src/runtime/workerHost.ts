import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type {
  StartResult,
  Unsubscribe,
  WorkerCommand,
  WorkerConfig,
  WorkerEvent,
  WorkerRequestResult,
  WorkerStartConfig
} from './workerProtocol.js'

type PendingRequest = {
  resolve: (result: WorkerRequestResult) => void
  timeoutId: NodeJS.Timeout
}

function isHex64(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value)
}

function validateWorkerConfigPayload(payload: WorkerConfig): string | null {
  if (!isHex64(payload.nostr_pubkey_hex) || !isHex64(payload.nostr_nsec_hex)) {
    return 'Invalid worker config: expected nostr_pubkey_hex and nostr_nsec_hex (64-char hex)'
  }
  if (!payload.userKey || typeof payload.userKey !== 'string') {
    return 'Invalid worker config: userKey is required for per-account isolation'
  }
  return null
}

function makeRequestId(prefix = 'worker-req'): string {
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 30_000
  return Math.max(1_000, Math.min(Math.trunc(timeoutMs), 300_000))
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readInstalledPackageVersion(workerRoot: string, pkgName: string): string | null {
  const packagePath = path.join(workerRoot, 'node_modules', pkgName, 'package.json')
  const parsed = readJsonFile(packagePath)
  if (!parsed || typeof parsed !== 'object') return null
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'string' && version.trim() ? version.trim() : null
}

function readLockfilePackageVersion(workerRoot: string, pkgName: string): string | null {
  const lockPath = path.join(workerRoot, 'package-lock.json')
  const parsed = readJsonFile(lockPath)
  if (!parsed || typeof parsed !== 'object') return null
  const packages = (parsed as { packages?: unknown }).packages
  if (!packages || typeof packages !== 'object') return null
  const entry = (packages as Record<string, unknown>)[`node_modules/${pkgName}`]
  if (!entry || typeof entry !== 'object') return null
  const version = (entry as { version?: unknown }).version
  return typeof version === 'string' && version.trim() ? version.trim() : null
}

function detectWorkerDependencyCompatibilityIssue(workerRoot: string): string | null {
  const hyperbeeIndex = path.join(workerRoot, 'node_modules', 'hyperbee', 'index.js')
  if (!existsSync(hyperbeeIndex)) {
    return `Worker dependency check failed: missing ${hyperbeeIndex}. Run: (cd ${workerRoot} && npm ci)`
  }

  const source = (() => {
    try {
      return readFileSync(hyperbeeIndex, 'utf8')
    } catch {
      return null
    }
  })()

  if (!source) {
    return `Worker dependency check failed: unable to read ${hyperbeeIndex}`
  }

  const installedHyperbee = readInstalledPackageVersion(workerRoot, 'hyperbee')
  const lockHyperbee = readLockfilePackageVersion(workerRoot, 'hyperbee')
  if (installedHyperbee && lockHyperbee && installedHyperbee !== lockHyperbee) {
    return [
      `Worker dependency mismatch detected (hyperbee installed=${installedHyperbee}, lockfile=${lockHyperbee}).`,
      `Run: (cd ${workerRoot} && rm -rf node_modules && npm ci)`
    ].join(' ')
  }

  const installedAutobase = readInstalledPackageVersion(workerRoot, 'autobase')
  const lockAutobase = readLockfilePackageVersion(workerRoot, 'autobase')
  if (installedAutobase && lockAutobase && installedAutobase !== lockAutobase) {
    return [
      `Worker dependency mismatch detected (autobase installed=${installedAutobase}, lockfile=${lockAutobase}).`,
      `Run: (cd ${workerRoot} && rm -rf node_modules && npm ci)`
    ].join(' ')
  }

  const installedHypercore = readInstalledPackageVersion(workerRoot, 'hypercore')
  const lockHypercore = readLockfilePackageVersion(workerRoot, 'hypercore')
  if (installedHypercore && lockHypercore && installedHypercore !== lockHypercore) {
    return [
      `Worker dependency mismatch detected (hypercore installed=${installedHypercore}, lockfile=${lockHypercore}).`,
      `Run: (cd ${workerRoot} && rm -rf node_modules && npm ci)`
    ].join(' ')
  }

  return null
}

const STOP_WAIT_FOR_EXIT_MS = 8_000
const STOP_SIGTERM_GRACE_MS = 4_000
const STOP_SIGKILL_GRACE_MS = 1_500
const STARTUP_ORPHAN_TERM_GRACE_MS = 2_500
const STARTUP_ORPHAN_KILL_GRACE_MS = 1_500

function resolveWorkerEntry(config: WorkerStartConfig): string {
  if (config.workerEntry) return config.workerEntry
  return path.join(config.workerRoot, 'index.js')
}

function sendWorkerConfigToProcess(proc: ChildProcess, payload: WorkerConfig): { success: boolean; error?: string } {
  if (typeof proc.send !== 'function') {
    return { success: false, error: 'Worker IPC channel unavailable' }
  }
  try {
    proc.send({ type: 'config', data: payload })
    setTimeout(() => {
      if (proc.killed || !proc.connected) return
      try {
        proc.send?.({ type: 'config', data: payload })
      } catch {
        // best effort safety resend
      }
    }, 1_000)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export class WorkerHost {
  private workerProcess: ChildProcess | null = null
  private currentWorkerUserKey: string | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private emitter = new EventEmitter()
  private parentExitHooksInstalled = false
  private stopInFlight: Promise<void> | null = null

  private installParentExitHooks(): void {
    if (this.parentExitHooksInstalled) return
    this.parentExitHooksInstalled = true

    const shutdownChild = (): void => {
      const proc = this.workerProcess
      if (!proc) return
      if (typeof proc.send === 'function' && proc.connected) {
        try {
          proc.send({ type: 'shutdown' })
        } catch {
          // ignore
        }
      }
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
    }

    process.on('exit', shutdownChild)
    process.on('SIGINT', shutdownChild)
    process.on('SIGTERM', shutdownChild)
  }

  async start(config: WorkerStartConfig): Promise<StartResult> {
    this.installParentExitHooks()

    const validationError = validateWorkerConfigPayload(config.config)
    if (validationError) {
      return { success: false, configSent: false, error: validationError }
    }

    const workerEntry = resolveWorkerEntry(config)
    if (!existsSync(workerEntry)) {
      return {
        success: false,
        configSent: false,
        error: `Relay worker entry not found at ${workerEntry}`
      }
    }

    const defaultWorkerEntry = path.join(config.workerRoot, 'index.js')
    const shouldCheckDependencies = path.resolve(workerEntry) === path.resolve(defaultWorkerEntry)
    if (shouldCheckDependencies) {
      const dependencyIssue = detectWorkerDependencyCompatibilityIssue(config.workerRoot)
      if (dependencyIssue) {
        return {
          success: false,
          configSent: false,
          error: dependencyIssue
        }
      }
    }

    if (this.workerProcess) {
      if (
        this.currentWorkerUserKey
        && config.config.userKey
        && this.currentWorkerUserKey !== config.config.userKey
      ) {
        await this.stop()
      } else {
        const configResult = sendWorkerConfigToProcess(this.workerProcess, config.config)
        if (!configResult.success) {
          return {
            success: false,
            configSent: false,
            error: configResult.error || 'Failed to send config to running worker'
          }
        }
        this.currentWorkerUserKey = config.config.userKey
        return { success: true, alreadyRunning: true, configSent: true }
      }
    }

    try {
      await this.cleanupOrphanedWorkers(workerEntry, config.config.userKey)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.emitter.emit('stderr', `[WorkerHost] Startup orphan worker cleanup failed: ${detail}`)
    }

    const workerProcess = spawn(process.execPath, [workerEntry], {
      cwd: config.workerRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        APP_DIR: config.workerRoot,
        STORAGE_DIR: config.storageDir,
        USER_KEY: config.config.userKey
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })

    this.workerProcess = workerProcess
    this.currentWorkerUserKey = config.config.userKey

    workerProcess.on('message', (message: unknown) => {
      if (this.resolveWorkerRequest(message)) {
        return
      }
      if (message && typeof message === 'object') {
        this.emitter.emit('message', message as WorkerEvent)
      }
    })

    workerProcess.on('error', (error) => {
      this.rejectPendingWorkerRequests(error?.message || 'Worker process error')
      this.emitter.emit('stderr', `[WorkerHost] Worker error: ${error?.message || String(error)}`)
    })

    workerProcess.on('exit', (code, signal) => {
      this.rejectPendingWorkerRequests(`Worker exited with code=${code ?? signal ?? 'unknown'}`)
      this.workerProcess = null
      this.currentWorkerUserKey = null
      this.emitter.emit('exit', code ?? 0)
    })

    workerProcess.stdout?.on('data', (chunk: Buffer | string) => {
      this.emitter.emit('stdout', chunk.toString())
    })

    workerProcess.stderr?.on('data', (chunk: Buffer | string) => {
      this.emitter.emit('stderr', chunk.toString())
    })

    const configResult = sendWorkerConfigToProcess(workerProcess, config.config)
    if (!configResult.success) {
      try {
        workerProcess.kill()
      } catch {
        // ignore
      }
      this.workerProcess = null
      this.currentWorkerUserKey = null
      return {
        success: false,
        configSent: false,
        error: configResult.error || 'Failed to send config to worker'
      }
    }

    return { success: true, configSent: true }
  }

  async stop(): Promise<void> {
    if (!this.workerProcess) return
    if (this.stopInFlight) {
      await this.stopInFlight
      return
    }

    const proc = this.workerProcess

    this.stopInFlight = (async () => {
      try {
        if (typeof proc.send === 'function' && proc.connected) {
          try {
            proc.send({ type: 'shutdown' })
          } catch {
            // ignore
          }
        }

        let exited = await this.waitForProcessExit(proc, STOP_WAIT_FOR_EXIT_MS)
        if (!exited) {
          try {
            proc.kill('SIGTERM')
          } catch {
            // ignore
          }
          exited = await this.waitForProcessExit(proc, STOP_SIGTERM_GRACE_MS)
        }

        if (!exited) {
          try {
            proc.kill('SIGKILL')
          } catch {
            // ignore
          }
          await this.waitForProcessExit(proc, STOP_SIGKILL_GRACE_MS)
        }
      } finally {
        this.workerProcess = null
        this.currentWorkerUserKey = null
        this.rejectPendingWorkerRequests('Worker stopped')
      }
    })()

    try {
      await this.stopInFlight
    } finally {
      this.stopInFlight = null
    }
  }

  async send(message: WorkerCommand): Promise<{ success: boolean; error?: string }> {
    const proc = this.workerProcess
    if (!proc || typeof proc.send !== 'function') {
      return { success: false, error: 'Worker not running' }
    }

    try {
      proc.send(message)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async request<T>(message: WorkerCommand, timeoutMs = 30_000): Promise<T> {
    const proc = this.workerProcess
    if (!proc || typeof proc.send !== 'function') {
      throw new Error('Worker not running')
    }

    const requestId =
      typeof message.requestId === 'string' && message.requestId
        ? message.requestId
        : makeRequestId()

    if (this.pendingRequests.has(requestId)) {
      throw new Error(`Duplicate worker requestId: ${requestId}`)
    }

    const outgoing = {
      ...message,
      requestId
    }

    const timeout = normalizeTimeout(timeoutMs)

    const response = await new Promise<WorkerRequestResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (!this.pendingRequests.has(requestId)) return
        this.pendingRequests.delete(requestId)
        resolve({
          success: false,
          requestId,
          error: `Worker reply timeout after ${timeout}ms`
        })
      }, timeout)

      this.pendingRequests.set(requestId, { resolve, timeoutId })

      try {
        proc.send?.(outgoing)
      } catch (error) {
        clearTimeout(timeoutId)
        this.pendingRequests.delete(requestId)
        resolve({
          success: false,
          requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })

    if (!response.success) {
      throw new Error(response.error || 'Worker request failed')
    }

    return (response.data ?? null) as T
  }

  onMessage(listener: (event: WorkerEvent) => void): Unsubscribe {
    this.emitter.on('message', listener)
    return () => this.emitter.off('message', listener)
  }

  onExit(listener: (code: number) => void): Unsubscribe {
    this.emitter.on('exit', listener)
    return () => this.emitter.off('exit', listener)
  }

  onStdout(listener: (line: string) => void): Unsubscribe {
    this.emitter.on('stdout', listener)
    return () => this.emitter.off('stdout', listener)
  }

  onStderr(listener: (line: string) => void): Unsubscribe {
    this.emitter.on('stderr', listener)
    return () => this.emitter.off('stderr', listener)
  }

  isRunning(): boolean {
    return !!this.workerProcess
  }

  private async waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return true

    const timeout = Math.max(250, Math.min(Math.trunc(timeoutMs || 0), 60_000))
    return await new Promise<boolean>((resolve) => {
      let settled = false

      const finish = (result: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('exit', onExit)
        proc.off('close', onClose)
        resolve(result)
      }

      const onExit = (): void => finish(true)
      const onClose = (): void => finish(true)

      const timer = setTimeout(() => finish(false), timeout)
      proc.once('exit', onExit)
      proc.once('close', onClose)
    })
  }

  private async cleanupOrphanedWorkers(workerEntry: string, userKey: string): Promise<void> {
    if (process.platform !== 'linux') return
    if (!existsSync('/proc')) return

    const normalizedWorkerEntry = path.resolve(workerEntry)
    const procEntries = readdirSync('/proc', { withFileTypes: true })

    for (const entry of procEntries) {
      if (!entry.isDirectory()) continue
      if (!/^\d+$/.test(entry.name)) continue

      const pid = Number.parseInt(entry.name, 10)
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue

      const cmdline = this.readProcCmdline(pid)
      if (!cmdline || !this.isWorkerEntryMatch(cmdline, normalizedWorkerEntry)) continue

      const candidateUserKey = this.readProcEnvVar(pid, 'USER_KEY')
      if (candidateUserKey && candidateUserKey !== userKey) continue

      const ppid = this.readProcParentPid(pid)
      if (!this.isOrphanProcess(ppid)) continue

      this.emitter.emit(
        'stderr',
        `[WorkerHost] Cleaning orphaned worker pid=${pid} ppid=${ppid ?? 'unknown'}`
      )
      this.terminatePid(pid, 'SIGTERM')

      let exited = await this.waitForPidExit(pid, STARTUP_ORPHAN_TERM_GRACE_MS)
      if (!exited) {
        this.terminatePid(pid, 'SIGKILL')
        exited = await this.waitForPidExit(pid, STARTUP_ORPHAN_KILL_GRACE_MS)
      }

      if (!exited) {
        this.emitter.emit(
          'stderr',
          `[WorkerHost] Failed to terminate orphaned worker pid=${pid}`
        )
      }
    }
  }

  private readProcCmdline(pid: number): string[] | null {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`)
      if (!raw.length) return null
      const tokens = raw
        .toString('utf8')
        .split('\0')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      return tokens.length > 0 ? tokens : null
    } catch {
      return null
    }
  }

  private readProcEnvVar(pid: number, key: string): string | null {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`)
      if (!raw.length) return null
      const prefix = `${key}=`
      for (const entry of raw.toString('utf8').split('\0')) {
        if (!entry.startsWith(prefix)) continue
        const value = entry.slice(prefix.length)
        return value || null
      }
      return null
    } catch {
      return null
    }
  }

  private readProcParentPid(pid: number): number | null {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const match = status.match(/^PPid:\s+(\d+)$/m)
      if (!match) return null
      const parsed = Number.parseInt(match[1], 10)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private isWorkerEntryMatch(cmdline: string[], workerEntry: string): boolean {
    for (let index = 1; index < cmdline.length; index += 1) {
      const arg = cmdline[index]
      if (!arg || !path.isAbsolute(arg)) continue
      if (path.resolve(arg) === workerEntry) return true
    }
    return false
  }

  private isOrphanProcess(ppid: number | null): boolean {
    if (!ppid || ppid <= 1) return true
    return !this.isPidAlive(ppid)
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private terminatePid(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal)
    } catch {
      // ignore
    }
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(250, Math.trunc(timeoutMs))
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) return true
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    return !this.isPidAlive(pid)
  }

  private resolveWorkerRequest(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false
    const payload = message as WorkerEvent
    if (payload.type !== 'worker-response') return false

    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null
    if (!requestId) return false

    const pending = this.pendingRequests.get(requestId)
    if (!pending) return false

    this.pendingRequests.delete(requestId)
    clearTimeout(pending.timeoutId)

    pending.resolve({
      success: payload.success !== false,
      data: payload.data ?? null,
      error: payload.error || null,
      requestId
    })
    return true
  }

  private rejectPendingWorkerRequests(reason = 'Worker unavailable'): void {
    const entries = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    for (const pending of entries) {
      clearTimeout(pending.timeoutId)
      pending.resolve({ success: false, error: reason })
    }
  }
}

export function findDefaultWorkerRoot(cwd: string): string {
  const candidates = [
    path.resolve(cwd, 'hyperpipe-worker'),
    path.resolve(cwd, '../hyperpipe-worker'),
    path.resolve(cwd, '../../hyperpipe-worker')
  ]

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.js'))) {
      return candidate
    }
  }

  return path.resolve(cwd, '../hyperpipe-worker')
}
