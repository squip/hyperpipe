import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'

type FileLogLevel = 'debug' | 'info' | 'warn' | 'error'

type FileLogEntry = {
  ts: string
  level: FileLogLevel
  source: string
  message: string
  pid: number
  data?: unknown
}

const CONSOLE_METHODS: Array<keyof Pick<typeof console, 'debug' | 'info' | 'log' | 'warn' | 'error'>> = [
  'debug',
  'info',
  'log',
  'warn',
  'error'
]

let logStream: WriteStream | null = null
let logFilePath: string | null = null
let consoleMirroringInstalled = false
let streamBroken = false

const originalConsole: Pick<typeof console, 'debug' | 'info' | 'log' | 'warn' | 'error'> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

function toMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return inspect(value, { depth: 5, breakLength: Infinity, compact: true })
  } catch {
    return String(value)
  }
}

function normalizeArgs(args: unknown[]): { message: string; data?: unknown } {
  if (!args.length) return { message: '' }
  if (args.length === 1) return { message: toMessage(args[0]) }
  return {
    message: toMessage(args[0]),
    data: args.slice(1)
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return String(current)
    if (!current || typeof current !== 'object') return current
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack
      }
    }
    if (seen.has(current)) return '[Circular]'
    seen.add(current)
    return current
  })
}

function writeLine(entry: FileLogEntry): void {
  if (!logStream || streamBroken) return
  try {
    logStream.write(`${safeStringify(entry)}\n`)
  } catch (error) {
    streamBroken = true
    process.stderr.write(`[TUI Logger] Failed to write log line: ${toMessage(error)}\n`)
  }
}

function resolveLogPathFromEnv(): string | null {
  const raw = process.env.TUI_LOG_FILE
  if (!raw || !raw.trim()) return null
  const trimmed = raw.trim()
  if (!path.isAbsolute(trimmed)) {
    process.stderr.write(`[TUI Logger] Ignoring TUI_LOG_FILE because it is not an absolute path: ${trimmed}\n`)
    return null
  }
  return trimmed
}

function mapConsoleLevel(method: keyof Pick<typeof console, 'debug' | 'info' | 'log' | 'warn' | 'error'>): FileLogLevel {
  if (method === 'log') return 'info'
  return method
}

export function initializeTuiFileLogger(): string | null {
  if (logStream) return logFilePath

  const resolvedPath = resolveLogPathFromEnv()
  if (!resolvedPath) return null

  try {
    mkdirSync(path.dirname(resolvedPath), { recursive: true })
    logStream = createWriteStream(resolvedPath, { flags: 'a' })
    logFilePath = resolvedPath
    streamBroken = false
    logStream.on('error', (error) => {
      streamBroken = true
      process.stderr.write(`[TUI Logger] Log stream error: ${toMessage(error)}\n`)
    })
    writeTuiFileLog('info', 'logger', 'TUI file logging initialized', { path: resolvedPath })
    return resolvedPath
  } catch (error) {
    process.stderr.write(`[TUI Logger] Failed to initialize log file (${resolvedPath}): ${toMessage(error)}\n`)
    logStream = null
    logFilePath = null
    streamBroken = false
    return null
  }
}

export function writeTuiFileLog(level: FileLogLevel, source: string, message: string, data?: unknown): void {
  if (!logStream || streamBroken) return
  writeLine({
    ts: new Date().toISOString(),
    level,
    source,
    message,
    pid: process.pid,
    data
  })
}

export function mirrorConsoleToTuiFileLogger(): void {
  if (consoleMirroringInstalled || !logStream || streamBroken) return
  consoleMirroringInstalled = true

  for (const method of CONSOLE_METHODS) {
    const original = originalConsole[method]
    console[method] = (...args: unknown[]) => {
      original(...args)
      const normalized = normalizeArgs(args)
      writeTuiFileLog(mapConsoleLevel(method), 'console', normalized.message, normalized.data)
    }
  }
}

export async function closeTuiFileLogger(): Promise<void> {
  if (!logStream) return
  const stream = logStream
  logStream = null
  const finalPath = logFilePath
  logFilePath = null

  await new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })

  consoleMirroringInstalled = false
  streamBroken = false
  if (finalPath) {
    process.stderr.write(`[TUI Logger] Closed log file: ${finalPath}\n`)
  }
}
