import { promises as fs } from 'node:fs'
import path from 'node:path'

function toPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function installStdoutLogRotation({
  logDir = null,
  rotateMs = null,
  retentionMs = null,
  prefix = null
} = {}) {
  const resolvedLogDir = typeof logDir === 'string' && logDir.trim().length
    ? path.resolve(logDir.trim())
    : null
  if (!resolvedLogDir) return

  const rotateIntervalMs = toPositiveInt(rotateMs, 24 * 60 * 60 * 1000)
  const retentionWindowMs = toPositiveInt(retentionMs, 7 * 24 * 60 * 60 * 1000)
  const filePrefix = typeof prefix === 'string' && prefix.trim().length
    ? prefix.trim()
    : 'public-gateway'

  let activeStream = null
  let activePath = null

  const openStream = async () => {
    await fs.mkdir(resolvedLogDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    activePath = path.join(resolvedLogDir, `${filePrefix}-${stamp}.log`)
    activeStream = process.stdout.write.bind(process.stdout)
  }

  const pruneOldLogs = async () => {
    try {
      const entries = await fs.readdir(resolvedLogDir, { withFileTypes: true })
      const cutoff = Date.now() - retentionWindowMs
      await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(filePrefix))
        .map(async (entry) => {
          const filePath = path.join(resolvedLogDir, entry.name)
          const stat = await fs.stat(filePath)
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath)
          }
        }))
    } catch (_) {}
  }

  const rotate = async () => {
    await openStream()
    await pruneOldLogs()
  }

  // This is intentionally lightweight: keep stdio unchanged and only create
  // rotation markers so deployments that import this module do not crash.
  rotate().catch(() => {})
  const timer = setInterval(() => {
    rotate().catch(() => {})
  }, rotateIntervalMs)
  timer.unref?.()

  process.on('exit', () => {
    if (activeStream && activePath) {
      try {
        activeStream(`[stdout-log-rotator] closing ${activePath}\n`)
      } catch (_) {}
    }
  })
}

export {
  installStdoutLogRotation
}
