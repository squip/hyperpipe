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
let stdioCaptureStream: WriteStream | null = null
let stdioCapturePath: string | null = null
let stdioCaptureInstalled = false
let stdioCaptureBroken = false

const originalConsole: Pick<typeof console, 'debug' | 'info' | 'log' | 'warn' | 'error'> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)

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

function writeInternalStderr(message: string): void {
  try {
    originalStderrWrite(message)
  } catch {
    // best effort
  }
}

function writeLine(entry: FileLogEntry): void {
  if (!logStream || streamBroken) return
  try {
    logStream.write(`${safeStringify(entry)}\n`)
  } catch (error) {
    streamBroken = true
    writeInternalStderr(`[TUI Logger] Failed to write log line: ${toMessage(error)}\n`)
  }
}

function resolveAbsolutePathFromEnv(variable: string): string | null {
  const raw = process.env[variable]
  if (!raw || !raw.trim()) return null
  const trimmed = raw.trim()
  if (!path.isAbsolute(trimmed)) {
    writeInternalStderr(`[TUI Logger] Ignoring ${variable} because it is not an absolute path: ${trimmed}\n`)
    return null
  }
  return trimmed
}

function resolveLogPathFromEnv(): string | null {
  return resolveAbsolutePathFromEnv('TUI_LOG_FILE')
}

function resolveStdioCapturePathFromEnv(): string | null {
  const primary = resolveAbsolutePathFromEnv('TUI_STDIO_LOG_FILE')
  if (primary) return primary
  return resolveAbsolutePathFromEnv('TUI_STDOUT_LOG_FILE')
}

function mapConsoleLevel(method: keyof Pick<typeof console, 'debug' | 'info' | 'log' | 'warn' | 'error'>): FileLogLevel {
  if (method === 'log') return 'info'
  return method
}

function invokeOriginalWrite(
  originalWrite: typeof process.stdout.write,
  chunk: unknown,
  encoding?: unknown,
  callback?: unknown
): boolean {
  if (typeof encoding === 'function') {
    return originalWrite(chunk as never, encoding as never)
  }
  if (typeof callback === 'function') {
    return originalWrite(chunk as never, encoding as never, callback as never)
  }
  if (typeof encoding !== 'undefined') {
    return originalWrite(chunk as never, encoding as never)
  }
  return originalWrite(chunk as never)
}

function toStdioText(chunk: unknown, encoding?: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) {
    const resolvedEncoding = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'
    return chunk.toString(resolvedEncoding)
  }
  if (chunk instanceof Uint8Array) {
    const resolvedEncoding = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'
    return Buffer.from(chunk).toString(resolvedEncoding)
  }
  return String(chunk)
}

function writeStdioCapture(source: 'stdout' | 'stderr', chunk: unknown, encoding?: unknown): void {
  if (!stdioCaptureStream || stdioCaptureBroken) return
  try {
    const text = toStdioText(chunk, encoding)
    if (!text) return
    stdioCaptureStream.write(text)
  } catch (error) {
    stdioCaptureBroken = true
    writeInternalStderr(`[TUI Logger] Failed to write ${source} capture: ${toMessage(error)}\n`)
  }
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
      writeInternalStderr(`[TUI Logger] Log stream error: ${toMessage(error)}\n`)
    })
    writeTuiFileLog('info', 'logger', 'TUI file logging initialized', { path: resolvedPath })
    return resolvedPath
  } catch (error) {
    writeInternalStderr(`[TUI Logger] Failed to initialize log file (${resolvedPath}): ${toMessage(error)}\n`)
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

export function initializeTuiStdioCapture(): string | null {
  if (stdioCaptureStream) return stdioCapturePath
  const resolvedPath = resolveStdioCapturePathFromEnv()
  if (!resolvedPath) return null

  try {
    mkdirSync(path.dirname(resolvedPath), { recursive: true })
    stdioCaptureStream = createWriteStream(resolvedPath, { flags: 'a' })
    stdioCapturePath = resolvedPath
    stdioCaptureBroken = false

    stdioCaptureStream.on('error', (error) => {
      stdioCaptureBroken = true
      writeInternalStderr(`[TUI Logger] STDIO capture stream error: ${toMessage(error)}\n`)
    })

    if (!stdioCaptureInstalled) {
      const stdoutCapture = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
        writeStdioCapture('stdout', chunk, encoding)
        return invokeOriginalWrite(originalStdoutWrite, chunk, encoding, callback)
      }) as typeof process.stdout.write

      const stderrCapture = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
        writeStdioCapture('stderr', chunk, encoding)
        return invokeOriginalWrite(originalStderrWrite, chunk, encoding, callback)
      }) as typeof process.stderr.write

      process.stdout.write = stdoutCapture
      process.stderr.write = stderrCapture
      stdioCaptureInstalled = true
    }

    writeTuiFileLog('info', 'logger', 'TUI stdio capture initialized', { path: resolvedPath })
    return resolvedPath
  } catch (error) {
    writeInternalStderr(`[TUI Logger] Failed to initialize stdio capture (${resolvedPath}): ${toMessage(error)}\n`)
    stdioCaptureStream = null
    stdioCapturePath = null
    stdioCaptureBroken = false
    return null
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
    writeInternalStderr(`[TUI Logger] Closed log file: ${finalPath}\n`)
  }
}

export async function closeTuiStdioCapture(): Promise<void> {
  if (stdioCaptureInstalled) {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write
    process.stderr.write = originalStderrWrite as typeof process.stderr.write
    stdioCaptureInstalled = false
  }

  if (!stdioCaptureStream) return

  const stream = stdioCaptureStream
  stdioCaptureStream = null
  const finalPath = stdioCapturePath
  stdioCapturePath = null

  await new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })

  stdioCaptureBroken = false
  if (finalPath) {
    writeInternalStderr(`[TUI Logger] Closed stdio capture file: ${finalPath}\n`)
  }
}
