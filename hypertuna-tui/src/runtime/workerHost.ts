import { existsSync } from 'node:fs'
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

  async start(config: WorkerStartConfig): Promise<StartResult> {
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

    const proc = this.workerProcess
    this.workerProcess = null
    this.currentWorkerUserKey = null

    try {
      proc.removeAllListeners()
      proc.kill()
    } finally {
      this.rejectPendingWorkerRequests('Worker stopped')
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
    path.resolve(cwd, 'hypertuna-worker'),
    path.resolve(cwd, '../hypertuna-worker'),
    path.resolve(cwd, '../../hypertuna-worker')
  ]

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.js'))) {
      return candidate
    }
  }

  return path.resolve(cwd, '../hypertuna-worker')
}
