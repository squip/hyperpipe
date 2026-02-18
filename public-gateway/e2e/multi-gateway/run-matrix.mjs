#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1'

import { SCENARIOS, HARD_GATES } from './scenarios.mjs'
import {
  evaluateFanoutResults,
  evaluateJoinPerformanceTelemetry
} from '../../../hypertuna-worker/gateway/MultiGatewayJoinUtils.mjs'

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const DEFAULT_ARTIFACTS_ROOT = path.resolve(ROOT_DIR, 'test-logs/live-matrix/multi-gateway')
const DEFAULT_BASELINE_DIR = path.resolve(
  ROOT_DIR,
  'test-logs/CLOSED-JOIN-V2/PASS-closed-join-refactor-V2-3'
)
const COMPOSE_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'docker-compose.yml')
const DEFAULT_EXECUTOR = `node "${path.resolve(path.dirname(new URL(import.meta.url).pathname), 'executor-real.mjs')}"`
const DEFAULT_WORKER_A_PRIVKEY = '3333333333333333333333333333333333333333333333333333333333333333'
const DEFAULT_WORKER_B_PRIVKEY = '4444444444444444444444444444444444444444444444444444444444444444'

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    scenario: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'skip-docker': { type: 'boolean', default: false },
    'keep-docker': { type: 'boolean', default: false },
    executor: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'artifacts-root': { type: 'string' },
    'admin-pubkey': { type: 'string' },
    'worker-b-pubkey': { type: 'string' },
    'baseline-dir': { type: 'string' }
  }
})

const options = {
  dryRun: parsed.values['dry-run'] === true,
  skipDocker: parsed.values['skip-docker'] === true,
  keepDocker: parsed.values['keep-docker'] === true,
  executor: parsed.values.executor || process.env.HT_MULTI_GATEWAY_SCENARIO_EXECUTOR || DEFAULT_EXECUTOR,
  timeoutMs: Number.parseInt(
    parsed.values['timeout-ms'] || process.env.HT_MULTI_GATEWAY_SCENARIO_TIMEOUT_MS || '720000',
    10
  ),
  artifactsRoot: path.resolve(parsed.values['artifacts-root'] || DEFAULT_ARTIFACTS_ROOT),
  adminPubkey: normalizePubkey(parsed.values['admin-pubkey'] || process.env.HT_ADMIN_PUBKEY || null),
  workerBPubkey: normalizePubkey(parsed.values['worker-b-pubkey'] || process.env.HT_WORKER_B_PUBKEY || null),
  baselineDir: path.resolve(parsed.values['baseline-dir'] || DEFAULT_BASELINE_DIR)
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null
  return trimmed
}

function dedupePubkeys(values = []) {
  const unique = new Set()
  for (const value of values) {
    const normalized = normalizePubkey(value)
    if (!normalized) continue
    unique.add(normalized)
  }
  return Array.from(unique)
}

function nowStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function logLine(message, meta = null) {
  if (meta && typeof meta === 'object') {
    process.stdout.write(`${message} ${JSON.stringify(meta)}\n`)
    return
  }
  process.stdout.write(`${message}\n`)
}

function selectScenarios() {
  const raw = parsed.values.scenario
  if (!raw) return [...SCENARIOS]
  const wanted = new Set(
    String(raw)
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  )
  return SCENARIOS.filter((scenario) => wanted.has(scenario.id))
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 !== 0 || /[^a-f0-9]/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function derivePubkeyFromPrivkey(privkeyHex) {
  const bytes = hexToBytes(privkeyHex)
  if (!bytes) return null
  try {
    return toHex(schnorr.getPublicKey(bytes)).toLowerCase()
  } catch {
    return null
  }
}

async function runCommand(command, args, {
  cwd = ROOT_DIR,
  env = process.env,
  timeoutMs = options.timeoutMs,
  stdoutFile = null,
  stderrFile = null,
  onStdoutLine = null,
  onStderrLine = null
} = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdoutLines = []
    const stderrLines = []
    let timedOut = false
    let killedByFailFast = false
    let failFastReason = null

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, Math.max(1000, timeoutMs || 120000))

    const writeLine = async (filePath, line) => {
      if (!filePath) return
      await fs.appendFile(filePath, `${line}\n`, 'utf8')
    }

    const bindStream = (stream, lines, filePath, callback) => {
      let buffer = ''
      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() || ''
        for (const line of parts) {
          lines.push(line)
          writeLine(filePath, line).catch(() => {})
          if (typeof callback === 'function') {
            const result = callback(line)
            if (result && typeof result === 'object' && result.failFast) {
              killedByFailFast = true
              failFastReason = result.reason || 'fail-fast'
              child.kill('SIGTERM')
            }
          }
        }
      })
      stream.on('end', () => {
        if (buffer.length) {
          lines.push(buffer)
          writeLine(filePath, buffer).catch(() => {})
          if (typeof callback === 'function') {
            const result = callback(buffer)
            if (result && typeof result === 'object' && result.failFast) {
              killedByFailFast = true
              failFastReason = result.reason || 'fail-fast'
            }
          }
        }
      })
    }

    bindStream(child.stdout, stdoutLines, stdoutFile, onStdoutLine)
    bindStream(child.stderr, stderrLines, stderrFile, onStderrLine)

    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        timedOut,
        killedByFailFast,
        failFastReason,
        stdoutLines,
        stderrLines
      })
    })
  })
}

async function dockerCompose(args) {
  return await runCommand('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    timeoutMs: 600000
  })
}

async function waitForGatewayHealth(baseUrl, timeoutMs = 120000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL('/health', baseUrl))
      if (response.ok) {
        return true
      }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

function parseJsonFromLine(line) {
  if (typeof line !== 'string') return null
  const first = line.indexOf('{')
  const last = line.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  const candidate = line.slice(first, last + 1)
  try {
    return JSON.parse(candidate)
  } catch (_) {
    return null
  }
}

function parseWorkerLogContent(content) {
  const telemetry = []
  const fanout = []
  const failFastSignals = []

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue

    if (line.includes('JOIN_FAIL_FAST_ABORT')) {
      failFastSignals.push({
        line,
        reason: 'JOIN_FAIL_FAST_ABORT'
      })
    }

    const parsed = parseJsonFromLine(line)
    if (!parsed || typeof parsed !== 'object') {
      continue
    }

    if (parsed?.type === 'join-telemetry' && parsed?.data && typeof parsed.data === 'object') {
      telemetry.push(parsed.data)
      if (parsed.data.eventType === 'JOIN_FAIL_FAST_ABORT') {
        failFastSignals.push({
          reason: parsed.data.reasonCode || 'join-fail-fast',
          traceId: parsed.data.traceId || null,
          payload: parsed.data
        })
      }
      continue
    }

    if (parsed?.eventType && typeof parsed.eventType === 'string') {
      telemetry.push(parsed)
      if (parsed.eventType === 'JOIN_FAIL_FAST_ABORT') {
        failFastSignals.push({
          reason: parsed.reasonCode || 'join-fail-fast',
          traceId: parsed.traceId || null,
          payload: parsed
        })
      }
      continue
    }

    if (parsed?.type === 'join-fanout-summary' && parsed?.data && typeof parsed.data === 'object') {
      fanout.push(parsed.data)
      continue
    }

    if (parsed?.traceId && parsed?.results && Array.isArray(parsed.results) && Number.isFinite(parsed.successCount)) {
      fanout.push(parsed)
    }
  }

  return {
    telemetry,
    fanout,
    failFastSignals
  }
}

async function parseWorkerLogs(files = []) {
  const combined = {
    telemetry: [],
    fanout: [],
    failFastSignals: []
  }

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const parsed = parseWorkerLogContent(content)
      combined.telemetry.push(...parsed.telemetry)
      combined.fanout.push(...parsed.fanout)
      combined.failFastSignals.push(...parsed.failFastSignals)
    } catch (_) {}
  }

  return combined
}

function selectPrimaryTrace(telemetry = []) {
  const traces = new Map()
  for (const event of telemetry) {
    const traceId = typeof event?.traceId === 'string' && event.traceId.trim()
      ? event.traceId.trim()
      : 'unknown'
    const list = traces.get(traceId) || []
    list.push(event)
    traces.set(traceId, list)
  }

  let bestTraceId = null
  let bestScore = -1
  for (const [traceId, events] of traces.entries()) {
    const hasConfirmed = events.some((event) => event?.eventType === 'JOIN_WRITABLE_CONFIRMED')
    const hasStart = events.some((event) => event?.eventType === 'JOIN_START')
    const score = (hasConfirmed ? 1000 : 0) + (hasStart ? 100 : 0) + events.length
    if (score > bestScore) {
      bestScore = score
      bestTraceId = traceId
    }
  }

  if (!bestTraceId) return { traceId: null, events: [] }
  return {
    traceId: bestTraceId,
    events: traces.get(bestTraceId) || []
  }
}

function findWritableViewLength(primaryEvents = []) {
  const confirmed = primaryEvents.find((entry) => entry?.eventType === 'JOIN_WRITABLE_CONFIRMED') || null
  const viewLength = Number.isFinite(confirmed?.meta?.viewLength) ? Number(confirmed.meta.viewLength) : null
  const expectedViewLength = Number.isFinite(confirmed?.meta?.expectedViewLength)
    ? Number(confirmed.meta.expectedViewLength)
    : null
  const localLength = Number.isFinite(confirmed?.meta?.localLength) ? Number(confirmed.meta.localLength) : null
  const viewLengthMatch = typeof confirmed?.meta?.viewLengthMatch === 'boolean'
    ? confirmed.meta.viewLengthMatch
    : (Number.isFinite(viewLength) && Number.isFinite(expectedViewLength)
      ? viewLength === expectedViewLength
      : null)

  return {
    viewLength,
    expectedViewLength,
    localLength,
    viewLengthMatch
  }
}

function selectFanoutSummary(fanout = [], traceId = null) {
  if (!Array.isArray(fanout) || fanout.length === 0) return null
  if (traceId) {
    const match = fanout.find((entry) => entry?.traceId === traceId)
    if (match) return match
  }
  return fanout[fanout.length - 1]
}

function getEnvGatewayDefinitions() {
  return {
    gateway1: {
      baseUrl: process.env.HT_GW1_BASE_URL || 'http://127.0.0.1:4541',
      operatorPrivkey: process.env.HT_GW1_OPERATOR_PRIVKEY || '1111111111111111111111111111111111111111111111111111111111111111',
      operatorPubkey: process.env.HT_GW1_OPERATOR_PUBKEY || '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
    },
    gateway2: {
      baseUrl: process.env.HT_GW2_BASE_URL || 'http://127.0.0.1:4542',
      operatorPrivkey: process.env.HT_GW2_OPERATOR_PRIVKEY || '2222222222222222222222222222222222222222222222222222222222222222',
      operatorPubkey: process.env.HT_GW2_OPERATOR_PUBKEY || '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
    }
  }
}

async function issueOperatorToken(gateway, scope = 'gateway:operator') {
  const challengeResp = await fetch(new URL('/api/auth/challenge', gateway.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pubkey: gateway.operatorPubkey,
      scope
    })
  })
  if (!challengeResp.ok) {
    throw new Error(`challenge failed: ${challengeResp.status}`)
  }
  const challenge = await challengeResp.json()
  const nonce = challenge?.nonce
  const challengeId = challenge?.challengeId
  if (!nonce || !challengeId) {
    throw new Error('invalid-challenge-response')
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ]
  const eventPayload = JSON.stringify([0, gateway.operatorPubkey, createdAt, 22242, tags, ''])
  const id = createHash('sha256').update(eventPayload).digest('hex')

  const message = hexToBytes(id)
  const privateKey = hexToBytes(gateway.operatorPrivkey)
  if (!message || !privateKey) {
    throw new Error('invalid-gateway-operator-key')
  }
  const signature = await schnorr.sign(message, privateKey)

  const verifyResp = await fetch(new URL('/api/auth/verify', gateway.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      authEvent: {
        id,
        kind: 22242,
        pubkey: gateway.operatorPubkey,
        created_at: createdAt,
        tags,
        content: '',
        sig: toHex(signature)
      }
    })
  })
  if (!verifyResp.ok) {
    throw new Error(`verify failed: ${verifyResp.status}`)
  }
  const verified = await verifyResp.json()
  if (!verified?.token) {
    throw new Error('missing-operator-token')
  }
  return verified.token
}

async function gatewayRequest(gateway, token, method, pathname, body = null) {
  const response = await fetch(new URL(pathname, gateway.baseUrl), {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return {
    ok: response.ok,
    status: response.status,
    data
  }
}

async function resetGatewayLists(gateway, token) {
  const allow = await gatewayRequest(gateway, token, 'GET', '/api/gateway/allow-list')
  const allowList = Array.isArray(allow?.data?.allowList) ? allow.data.allowList : []
  for (const pubkey of allowList) {
    await gatewayRequest(gateway, token, 'DELETE', `/api/gateway/allow-list/${encodeURIComponent(pubkey)}`)
  }

  const ban = await gatewayRequest(gateway, token, 'GET', '/api/gateway/ban-list')
  const banList = Array.isArray(ban?.data?.banList) ? ban.data.banList : []
  for (const pubkey of banList) {
    await gatewayRequest(gateway, token, 'DELETE', `/api/gateway/ban-list/${encodeURIComponent(pubkey)}`)
  }
}

async function configureScenarioPolicies(scenario) {
  const gateways = getEnvGatewayDefinitions()
  const g1Token = await issueOperatorToken(gateways.gateway1)
  const g2Token = await issueOperatorToken(gateways.gateway2)

  await gatewayRequest(gateways.gateway1, g1Token, 'POST', '/api/gateway/policy', {
    policy: scenario.gateway1,
    inviteOnly: scenario.id === 'S17',
    discoveryRelays: ['wss://relay.damus.io', 'wss://nos.lol']
  })
  await gatewayRequest(gateways.gateway2, g2Token, 'POST', '/api/gateway/policy', {
    policy: scenario.gateway2,
    inviteOnly: false,
    discoveryRelays: ['wss://relay.damus.io', 'wss://nos.lol']
  })

  await resetGatewayLists(gateways.gateway1, g1Token)
  await resetGatewayLists(gateways.gateway2, g2Token)

  const derivedAdminPubkey = derivePubkeyFromPrivkey(
    process.env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY || DEFAULT_WORKER_A_PRIVKEY
  )
  const derivedWorkerBPubkey = derivePubkeyFromPrivkey(
    process.env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY || DEFAULT_WORKER_B_PRIVKEY
  )
  const adminPubkeys = dedupePubkeys([options.adminPubkey, derivedAdminPubkey])
  const workerBPubkeys = dedupePubkeys([options.workerBPubkey, derivedWorkerBPubkey])

  const addAllow = async (gateway, token, pubkey) => {
    if (!pubkey) return
    await gatewayRequest(gateway, token, 'POST', '/api/gateway/allow-list', { pubkey })
  }
  const addBan = async (gateway, token, pubkey) => {
    if (!pubkey) return
    await gatewayRequest(gateway, token, 'POST', '/api/gateway/ban-list', { pubkey })
  }

  if (['S02', 'S06'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow(gateways.gateway2, g2Token, pubkey)
    }
  }
  if (['S03', 'S07'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow(gateways.gateway1, g1Token, pubkey)
    }
  }
  if (['S04', 'S08'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow(gateways.gateway1, g1Token, pubkey)
      await addAllow(gateways.gateway2, g2Token, pubkey)
    }
  }
  if (['S11', 'S12'].includes(scenario.id)) {
    for (const pubkey of workerBPubkeys) {
      await addBan(gateways.gateway1, g1Token, pubkey)
    }
  }
}

function detectFailFastLine(line) {
  if (typeof line !== 'string') return null
  if (line.includes('JOIN_FAIL_FAST_ABORT')) {
    return {
      failFast: true,
      reason: 'JOIN_FAIL_FAST_ABORT'
    }
  }
  if (line.includes('writer-material-timeout')) {
    return {
      failFast: true,
      reason: 'writer-material-timeout'
    }
  }
  if (line.includes('join-writable-timeout')) {
    return {
      failFast: true,
      reason: 'join-writable-timeout'
    }
  }
  return null
}

function parseScenarioSummary(stdoutLines = []) {
  for (const line of stdoutLines) {
    const trimmed = String(line || '').trim()
    if (!trimmed) continue
    if (trimmed.startsWith('HT_SCENARIO_SUMMARY=')) {
      const payload = trimmed.slice('HT_SCENARIO_SUMMARY='.length)
      try {
        return JSON.parse(payload)
      } catch (_) {}
    }
  }
  const lastLine = stdoutLines.length ? String(stdoutLines[stdoutLines.length - 1] || '').trim() : ''
  if (!lastLine) return null
  try {
    return JSON.parse(lastLine)
  } catch (_) {
    return null
  }
}

async function runScenarioExecutor(scenario, scenarioDir) {
  const executor = options.executor
  if (!executor) {
    return {
      status: 'BLOCKED',
      reason: 'missing-scenario-executor',
      summary: null,
      run: null
    }
  }

  const stdoutFile = path.join(scenarioDir, 'executor.stdout.log')
  const stderrFile = path.join(scenarioDir, 'executor.stderr.log')

  const env = {
    ...process.env,
    HT_SCENARIO_ID: scenario.id,
    HT_SCENARIO_JSON: JSON.stringify(scenario),
    HT_SCENARIO_DIR: scenarioDir,
    HT_SCENARIO_TIMEOUT_MS: String(options.timeoutMs),
    HT_SCENARIO_BASELINE_DIR: options.baselineDir,
    HT_MULTI_GATEWAY_GATES: JSON.stringify(HARD_GATES)
  }

  const watchdog = {
    joinStartedAtMs: null,
    writerMaterialApplied: false,
    fastForwardApplied: false,
    fastForwardExpected: false,
    writableConfirmed: false
  }

  const onExecutorLine = (line) => {
    const immediate = detectFailFastLine(line)
    if (immediate) return immediate

    const parsed = parseJsonFromLine(line)
    const telemetry = parsed?.type === 'join-telemetry'
      ? parsed?.data
      : (parsed?.eventType ? parsed : null)
    if (telemetry && typeof telemetry === 'object') {
      if (telemetry.eventType === 'JOIN_START') {
        watchdog.joinStartedAtMs = Date.now()
        watchdog.fastForwardExpected = telemetry?.meta?.hasFastForward === true
      }
      if (telemetry.eventType === 'JOIN_WRITER_MATERIAL_APPLIED') {
        watchdog.writerMaterialApplied = true
      }
      if (telemetry.eventType === 'JOIN_FAST_FORWARD_APPLIED') {
        watchdog.fastForwardApplied = true
      }
      if (telemetry.eventType === 'JOIN_WRITABLE_CONFIRMED') {
        watchdog.writableConfirmed = true
      }
      if (telemetry.eventType === 'JOIN_FAIL_FAST_ABORT') {
        return {
          failFast: true,
          reason: telemetry.reasonCode || 'join-fail-fast'
        }
      }
    }

    if (!watchdog.joinStartedAtMs || watchdog.writableConfirmed) return null
    const elapsed = Date.now() - watchdog.joinStartedAtMs
    if (elapsed > HARD_GATES.joinToWritableMs) {
      return {
        failFast: true,
        reason: 'join-writable-timeout'
      }
    }
    if (!watchdog.writerMaterialApplied && elapsed > HARD_GATES.writerMaterialMs) {
      return {
        failFast: true,
        reason: 'writer-material-timeout'
      }
    }
    if (watchdog.fastForwardExpected && !watchdog.fastForwardApplied && elapsed > HARD_GATES.fastForwardMs) {
      return {
        failFast: true,
        reason: 'fast-forward-timeout'
      }
    }
    return null
  }

  const run = await runCommand('zsh', ['-lc', executor], {
    cwd: ROOT_DIR,
    env,
    timeoutMs: options.timeoutMs,
    stdoutFile,
    stderrFile,
    onStdoutLine: onExecutorLine,
    onStderrLine: onExecutorLine
  })

  const summary = parseScenarioSummary(run.stdoutLines)
  if (run.timedOut) {
    return {
      status: 'FAIL',
      reason: `executor-timeout-${options.timeoutMs}ms`,
      summary,
      run
    }
  }
  if (run.killedByFailFast) {
    return {
      status: 'FAIL',
      reason: run.failFastReason || 'executor-fail-fast',
      summary,
      run
    }
  }
  if (run.code !== 0) {
    return {
      status: 'FAIL',
      reason: `executor-exit-${run.code}`,
      summary,
      run
    }
  }

  return {
    status: 'OK',
    reason: null,
    summary,
    run
  }
}

async function evaluateScenarioResult(scenario, scenarioDir, executorResult) {
  const summary = executorResult.summary && typeof executorResult.summary === 'object'
    ? executorResult.summary
    : {}

  const fallbackWorkerLogs = [
    path.join(scenarioDir, 'workerA.log'),
    path.join(scenarioDir, 'workerB.log')
  ]
  const workerLogs = Array.isArray(summary.workerLogs) && summary.workerLogs.length
    ? summary.workerLogs.map((value) => path.resolve(String(value)))
    : fallbackWorkerLogs

  const parsedWorker = await parseWorkerLogs(workerLogs)
  const primaryTrace = selectPrimaryTrace(parsedWorker.telemetry)
  const joinPerf = evaluateJoinPerformanceTelemetry(primaryTrace.events, {
    writableHardMs: HARD_GATES.joinToWritableMs,
    writableWarnMs: HARD_GATES.joinToWritableWarnMs,
    writerMaterialMs: HARD_GATES.writerMaterialMs,
    fastForwardMs: HARD_GATES.fastForwardMs
  })

  const fanoutSummary = selectFanoutSummary(parsedWorker.fanout, primaryTrace.traceId)
  const fanout = evaluateFanoutResults(fanoutSummary?.results || [], {
    minimumSuccess: HARD_GATES.minimumFanoutSuccess
  })

  const writableView = findWritableViewLength(primaryTrace.events)
  const observedViewLength = Number.isFinite(summary?.observedViewLength)
    ? Number(summary.observedViewLength)
    : writableView.viewLength
  const expectedViewLength = Number.isFinite(summary?.expectedViewLength)
    ? Number(summary.expectedViewLength)
    : writableView.expectedViewLength

  const checks = []
  checks.push({
    name: 'join_to_writable_hard',
    pass: joinPerf.writableHardPass,
    observedMs: joinPerf.writableElapsedMs,
    thresholdMs: HARD_GATES.joinToWritableMs
  })
  checks.push({
    name: 'join_to_writable_warn',
    pass: joinPerf.writableWarnPass,
    observedMs: joinPerf.writableElapsedMs,
    thresholdMs: HARD_GATES.joinToWritableWarnMs,
    severity: 'warning'
  })
  checks.push({
    name: 'writer_material_stage',
    pass: joinPerf.writerMaterialPass,
    observedMs: joinPerf.writerMaterialElapsedMs,
    thresholdMs: HARD_GATES.writerMaterialMs
  })
  checks.push({
    name: 'fast_forward_stage',
    pass: joinPerf.fastForwardPass,
    observedMs: joinPerf.fastForwardElapsedMs,
    thresholdMs: HARD_GATES.fastForwardMs
  })
  checks.push({
    name: 'fanout_success_threshold',
    pass: fanout.passesThreshold,
    successCount: fanout.successCount,
    minimumSuccess: fanout.minimumSuccess
  })

  const hasViewEvidence = Number.isFinite(observedViewLength) && Number.isFinite(expectedViewLength)
  checks.push({
    name: 'view_length_match',
    pass: hasViewEvidence ? observedViewLength === expectedViewLength : false,
    observedViewLength,
    expectedViewLength
  })

  if (parsedWorker.failFastSignals.length > 0) {
    checks.push({
      name: 'fail_fast_signals',
      pass: false,
      signals: parsedWorker.failFastSignals
    })
  }

  const hardFailures = checks.filter((check) => check.pass === false && check.severity !== 'warning')
  const warnings = checks.filter((check) => check.pass === false && check.severity === 'warning')

  return {
    scenario: scenario.id,
    traceId: primaryTrace.traceId,
    status: hardFailures.length === 0 ? 'PASS' : 'FAIL',
    hardFailures,
    warnings,
    checks,
    telemetryEvents: primaryTrace.events,
    fanoutSummary: fanoutSummary || null,
    joinPerformance: joinPerf,
    failFastSignals: parsedWorker.failFastSignals,
    workerLogs,
    summary
  }
}

async function main() {
  const scenarios = selectScenarios()
  if (!scenarios.length) {
    throw new Error('No scenarios selected')
  }

  await ensureDir(options.artifactsRoot)
  const runDir = path.join(options.artifactsRoot, nowStamp())
  await ensureDir(runDir)

  logLine('[multi-gateway] artifacts directory', { runDir })
  logLine('[multi-gateway] baseline calibration reference', { baselineDir: options.baselineDir })
  logLine('[multi-gateway] scenario executor', { executor: options.executor })

  let dockerStarted = false
  if (!options.skipDocker && !options.dryRun) {
    logLine('[multi-gateway] starting docker stack')
    const up = await dockerCompose(['up', '-d', '--build'])
    if (up.code !== 0) {
      throw new Error(`docker compose up failed: ${up.code}`)
    }
    dockerStarted = true

    const health1 = await waitForGatewayHealth(process.env.HT_GW1_BASE_URL || 'http://127.0.0.1:4541')
    const health2 = await waitForGatewayHealth(process.env.HT_GW2_BASE_URL || 'http://127.0.0.1:4542')
    if (!health1 || !health2) {
      throw new Error('gateway health checks failed after docker startup')
    }
    logLine('[multi-gateway] docker stack healthy')
  }

  const results = []
  try {
    for (const scenario of scenarios) {
      const scenarioDir = path.join(runDir, scenario.id)
      await ensureDir(scenarioDir)
      await fs.writeFile(
        path.join(scenarioDir, 'scenario.json'),
        JSON.stringify(scenario, null, 2),
        'utf8'
      )

      if (options.dryRun) {
        results.push({
          scenario: scenario.id,
          status: 'SKIP',
          reason: 'dry-run',
          checks: []
        })
        continue
      }

      if (!options.skipDocker) {
        try {
          await configureScenarioPolicies(scenario)
        } catch (error) {
          results.push({
            scenario: scenario.id,
            status: 'FAIL',
            reason: `policy-setup-failed:${error?.message || error}`,
            checks: []
          })
          continue
        }
      }

      logLine('[multi-gateway] running scenario', {
        id: scenario.id,
        groupType: scenario.groupType,
        gateway1: scenario.gateway1,
        gateway2: scenario.gateway2
      })

      const executorResult = await runScenarioExecutor(scenario, scenarioDir)
      if (executorResult.status !== 'OK') {
        results.push({
          scenario: scenario.id,
          status: executorResult.status,
          reason: executorResult.reason,
          checks: []
        })
        continue
      }

      const evaluated = await evaluateScenarioResult(scenario, scenarioDir, executorResult)
      results.push(evaluated)

      await fs.writeFile(
        path.join(scenarioDir, 'result.json'),
        JSON.stringify(evaluated, null, 2),
        'utf8'
      )

      if (evaluated.status !== 'PASS') {
        logLine('[multi-gateway] scenario failed', {
          scenario: scenario.id,
          failures: evaluated.hardFailures.map((entry) => entry.name)
        })
      } else {
        logLine('[multi-gateway] scenario passed', { scenario: scenario.id })
      }
    }
  } finally {
    if (dockerStarted && !options.keepDocker) {
      logLine('[multi-gateway] stopping docker stack')
      await dockerCompose(['down', '-v'])
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    runDir,
    gates: HARD_GATES,
    baselineDir: options.baselineDir,
    total: results.length,
    passed: results.filter((entry) => entry.status === 'PASS').length,
    failed: results.filter((entry) => entry.status === 'FAIL').length,
    blocked: results.filter((entry) => entry.status === 'BLOCKED').length,
    skipped: results.filter((entry) => entry.status === 'SKIP').length,
    results
  }

  await fs.writeFile(path.join(runDir, 'matrix-summary.json'), JSON.stringify(summary, null, 2), 'utf8')

  const mdLines = [
    '# Multi-Gateway Live Matrix Summary',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Run Dir: ${summary.runDir}`,
    `- Baseline Reference: ${summary.baselineDir}`,
    `- Totals: pass=${summary.passed} fail=${summary.failed} blocked=${summary.blocked} skip=${summary.skipped}`,
    '',
    '| Scenario | Status | Hard Failures |',
    '|---|---|---|'
  ]
  for (const result of results) {
    const failures = Array.isArray(result?.hardFailures) && result.hardFailures.length
      ? result.hardFailures.map((entry) => entry.name).join(', ')
      : (result.reason || '-')
    mdLines.push(`| ${result.scenario} | ${result.status} | ${failures} |`)
  }
  await fs.writeFile(path.join(runDir, 'matrix-summary.md'), mdLines.join('\n'), 'utf8')

  logLine('[multi-gateway] run complete', {
    runDir,
    passed: summary.passed,
    failed: summary.failed,
    blocked: summary.blocked,
    skipped: summary.skipped
  })

  if (summary.failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[multi-gateway] fatal', error?.message || error)
  process.exitCode = 1
})
