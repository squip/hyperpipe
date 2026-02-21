import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

const DEFAULT_ROTATE_MS = 30 * 60 * 1000
const DEFAULT_RETENTION_MS = 5 * 60 * 60 * 1000
const DEFAULT_PREFIX = 'public-gateway'

let activeInstance = null

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minute = pad2(date.getMinutes())
  const second = pad2(date.getSeconds())
  return `${year}${month}${day}-${hour}${minute}${second}`
}

function resolveDefaultLogDir() {
  const cwd = process.cwd()
  return basename(cwd) === 'public-gateway'
    ? join(cwd, 'logs')
    : join(cwd, 'public-gateway', 'logs')
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function normalizeWriteArgs(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    return { chunk, encoding: undefined, cb: encoding }
  }
  return { chunk, encoding, cb }
}

async function pruneOldLogs({ logDir, prefix, retentionMs }) {
  try {
    const entries = await readdir(logDir)
    const cutoff = Date.now() - retentionMs
    await Promise.all(entries.map(async (entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith('.log')) return
      const filePath = join(logDir, entry)
      try {
        const fileStats = await stat(filePath)
        if (fileStats.mtimeMs < cutoff) {
          await unlink(filePath)
        }
      } catch (_) {
        // Ignore transient filesystem errors.
      }
    }))
  } catch (_) {
    // Ignore cleanup errors to avoid crashing the gateway.
  }
}

function installStdoutLogRotation({
  logDir = null,
  rotateMs = null,
  retentionMs = null,
  prefix = null
} = {}) {
  if (activeInstance) return activeInstance

  const resolvedLogDir = typeof logDir === 'string' && logDir.trim().length
    ? logDir.trim()
    : resolveDefaultLogDir()
  const rotateIntervalMs = toPositiveInt(rotateMs, DEFAULT_ROTATE_MS)
  const retentionWindowMs = toPositiveInt(retentionMs, DEFAULT_RETENTION_MS)
  const filePrefix = typeof prefix === 'string' && prefix.trim().length
    ? prefix.trim()
    : DEFAULT_PREFIX

  let activeStream = null
  let rotateTimer = null
  let cleanupTimer = null

  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)

  const safeWrite = (stream, chunk, encoding) => {
    if (!stream) return
    try {
      if (typeof chunk === 'string' && encoding) {
        stream.write(chunk, encoding)
      } else {
        stream.write(chunk)
      }
    } catch (_) {
      // Ignore stream errors and keep stdout/stderr working.
    }
  }

  const rotate = async () => {
    try {
      await mkdir(resolvedLogDir, { recursive: true })
      const filePath = join(resolvedLogDir, `${filePrefix}-${formatTimestamp(new Date())}.log`)
      const nextStream = createWriteStream(filePath, { flags: 'a' })
      const previous = activeStream
      activeStream = nextStream
      if (previous) previous.end()
      await pruneOldLogs({ logDir: resolvedLogDir, prefix: filePrefix, retentionMs: retentionWindowMs })
    } catch (error) {
      stderrWrite(`[stdout-log-rotator] rotate failed: ${error?.message || error}\n`)
    }
  }

  process.stdout.write = (chunk, encoding, cb) => {
    const { chunk: payload, encoding: enc, cb: callback } = normalizeWriteArgs(chunk, encoding, cb)
    const result = stdoutWrite(payload, enc, callback)
    safeWrite(activeStream, payload, enc)
    return result
  }

  process.stderr.write = (chunk, encoding, cb) => {
    const { chunk: payload, encoding: enc, cb: callback } = normalizeWriteArgs(chunk, encoding, cb)
    const result = stderrWrite(payload, enc, callback)
    safeWrite(activeStream, payload, enc)
    return result
  }

  rotate().catch(() => {})
  rotateTimer = setInterval(() => {
    rotate().catch(() => {})
  }, rotateIntervalMs)
  rotateTimer.unref?.()

  cleanupTimer = setInterval(() => {
    pruneOldLogs({ logDir: resolvedLogDir, prefix: filePrefix, retentionMs: retentionWindowMs }).catch(() => {})
  }, retentionWindowMs)
  cleanupTimer.unref?.()

  const stop = () => {
    if (rotateTimer) {
      clearInterval(rotateTimer)
      rotateTimer = null
    }
    if (cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
    if (activeStream) {
      activeStream.end()
      activeStream = null
    }
  }

  process.on('exit', stop)
  activeInstance = { stop }
  return activeInstance
}

export {
  installStdoutLogRotation
}
