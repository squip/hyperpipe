const DEFAULT_JOIN_PERFORMANCE_LIMITS = {
  writableHardMs: 120000,
  writableWarnMs: 60000,
  writerMaterialMs: 45000,
  fastForwardMs: 30000
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function compareGatewayStatusResults(left, right) {
  const leftView = toSafeNumber(left?.metrics?.latestViewLength, 0)
  const rightView = toSafeNumber(right?.metrics?.latestViewLength, 0)
  if (rightView !== leftView) return rightView - leftView

  const leftUpdatedAt = toSafeNumber(left?.metrics?.updatedAt, 0)
  const rightUpdatedAt = toSafeNumber(right?.metrics?.updatedAt, 0)
  if (rightUpdatedAt !== leftUpdatedAt) return rightUpdatedAt - leftUpdatedAt

  const leftWriterCount = toSafeNumber(left?.metrics?.writerCount, 0)
  const rightWriterCount = toSafeNumber(right?.metrics?.writerCount, 0)
  if (rightWriterCount !== leftWriterCount) return rightWriterCount - leftWriterCount

  const leftLatency = toSafeNumber(left?.latencyMs, Number.MAX_SAFE_INTEGER)
  const rightLatency = toSafeNumber(right?.latencyMs, Number.MAX_SAFE_INTEGER)
  return leftLatency - rightLatency
}

function rankGatewayStatusProbes(probes = [], fallbackOrigins = []) {
  const originSet = new Set(Array.isArray(fallbackOrigins) ? fallbackOrigins.filter(Boolean) : [])
  const healthy = (Array.isArray(probes) ? probes : []).filter((entry) => entry?.result === 'ok')
  healthy.sort(compareGatewayStatusResults)

  const rankedOrigins = healthy.length
    ? healthy.map((entry) => entry?.origin).filter(Boolean)
    : Array.from(originSet)

  const coreRefsHashes = Array.from(
    new Set(
      healthy
        .map((entry) => entry?.metrics?.coreRefsHash)
        .filter((value) => typeof value === 'string' && value.length)
    )
  )

  return {
    rankedOrigins,
    healthy,
    coreRefsHashes,
    driftDetected: coreRefsHashes.length > 1
  }
}

function evaluateFanoutResults(results = [], { minimumSuccess = 1 } = {}) {
  const list = Array.isArray(results) ? results : []
  const successCount = list.filter((entry) => entry?.status === 'ok').length
  const minimum = Number.isFinite(minimumSuccess) && minimumSuccess > 0 ? Math.trunc(minimumSuccess) : 1
  return {
    total: list.length,
    successCount,
    failedCount: Math.max(list.length - successCount, 0),
    minimumSuccess: minimum,
    passesThreshold: successCount >= minimum
  }
}

function firstEvent(events, eventType) {
  if (!Array.isArray(events) || !eventType) return null
  return events.find((entry) => entry?.eventType === eventType) || null
}

function evaluateJoinPerformanceTelemetry(events = [], limits = {}) {
  const configured = {
    writableHardMs: Number.isFinite(limits?.writableHardMs)
      ? Math.trunc(limits.writableHardMs)
      : DEFAULT_JOIN_PERFORMANCE_LIMITS.writableHardMs,
    writableWarnMs: Number.isFinite(limits?.writableWarnMs)
      ? Math.trunc(limits.writableWarnMs)
      : DEFAULT_JOIN_PERFORMANCE_LIMITS.writableWarnMs,
    writerMaterialMs: Number.isFinite(limits?.writerMaterialMs)
      ? Math.trunc(limits.writerMaterialMs)
      : DEFAULT_JOIN_PERFORMANCE_LIMITS.writerMaterialMs,
    fastForwardMs: Number.isFinite(limits?.fastForwardMs)
      ? Math.trunc(limits.fastForwardMs)
      : DEFAULT_JOIN_PERFORMANCE_LIMITS.fastForwardMs
  }

  const start = firstEvent(events, 'JOIN_START')
  const writerMaterial = firstEvent(events, 'JOIN_WRITER_MATERIAL_APPLIED')
  const fastForward = firstEvent(events, 'JOIN_FAST_FORWARD_APPLIED')
  const writableConfirmed = firstEvent(events, 'JOIN_WRITABLE_CONFIRMED')
  const failFast = firstEvent(events, 'JOIN_FAIL_FAST_ABORT')

  const writerMaterialElapsedMs = toSafeNumber(writerMaterial?.elapsedMs, null)
  const fastForwardElapsedMs = toSafeNumber(fastForward?.elapsedMs, null)
  const writableElapsedMs = toSafeNumber(writableConfirmed?.elapsedMs, null)

  const hardPass = Number.isFinite(writableElapsedMs) && writableElapsedMs <= configured.writableHardMs
  const warnPass = Number.isFinite(writableElapsedMs) && writableElapsedMs <= configured.writableWarnMs
  const writerMaterialPass = Number.isFinite(writerMaterialElapsedMs)
    && writerMaterialElapsedMs <= configured.writerMaterialMs
  const fastForwardPass = Number.isFinite(fastForwardElapsedMs)
    && fastForwardElapsedMs <= configured.fastForwardMs

  const failures = []
  if (!start) failures.push('missing-join-start')
  if (!writerMaterialPass) failures.push('writer-material-sla-failed')
  if (!fastForwardPass) failures.push('fast-forward-sla-failed')
  if (!hardPass) failures.push('join-writable-hard-sla-failed')
  if (failFast?.reasonCode) failures.push(`fail-fast:${failFast.reasonCode}`)

  return {
    limits: configured,
    writerMaterialElapsedMs,
    fastForwardElapsedMs,
    writableElapsedMs,
    writerMaterialPass,
    fastForwardPass,
    writableHardPass: hardPass,
    writableWarnPass: warnPass,
    failFastReason: failFast?.reasonCode || null,
    failures,
    pass: failures.length === 0
  }
}

export {
  DEFAULT_JOIN_PERFORMANCE_LIMITS,
  compareGatewayStatusResults,
  rankGatewayStatusProbes,
  evaluateFanoutResults,
  evaluateJoinPerformanceTelemetry
}
