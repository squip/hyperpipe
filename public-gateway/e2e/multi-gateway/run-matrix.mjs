#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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

function normalizePrivkey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null
  return trimmed
}

function normalizeGatewayMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'remote' || normalized === 'disabled') return normalized
  return 'local'
}

const gatewayTopology = {
  gateway1: {
    mode: normalizeGatewayMode(process.env.HT_GW1_MODE || 'local'),
    remoteLogCommand:
      typeof process.env.HT_GW1_REMOTE_LOG_CMD === 'string' && process.env.HT_GW1_REMOTE_LOG_CMD.trim()
        ? process.env.HT_GW1_REMOTE_LOG_CMD.trim()
        : null
  },
  gateway2: {
    mode: normalizeGatewayMode(process.env.HT_GW2_MODE || 'local'),
    remoteLogCommand:
      typeof process.env.HT_GW2_REMOTE_LOG_CMD === 'string' && process.env.HT_GW2_REMOTE_LOG_CMD.trim()
        ? process.env.HT_GW2_REMOTE_LOG_CMD.trim()
        : null
  }
}

function isGatewayEnabled(name) {
  const topology = gatewayTopology[name]
  return !!topology && topology.mode !== 'disabled'
}

function isGatewayLocal(name) {
  const topology = gatewayTopology[name]
  return !!topology && topology.mode === 'local'
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

function scenarioExpectsFailFast(scenario) {
  if (!scenario || typeof scenario !== 'object') return false
  if (String(scenario.id || '').toUpperCase() === 'S21') return true
  const expected = typeof scenario.expected === 'string' ? scenario.expected : ''
  return /fails?\s+fast/i.test(expected)
}

function scenarioAllowsWriterMaterialFailFast(scenario) {
  if (!scenario || typeof scenario !== 'object') return false
  const scenarioId = String(scenario.id || '').toUpperCase()
  return scenarioId === 'S20' || scenarioId === 'S21'
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

function deriveDeterministicPrivkey(seedHex, scenarioId, label) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = createHash('sha256')
      .update(`${seedHex}:${scenarioId}:${label}:${attempt}`)
      .digest('hex')
      .toLowerCase()
    if (derivePubkeyFromPrivkey(candidate)) return candidate
  }
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = randomBytes(32).toString('hex').toLowerCase()
    if (derivePubkeyFromPrivkey(candidate)) return candidate
  }
  throw new Error(`failed-to-generate-worker-private-key:${scenarioId}:${label}`)
}

function buildScenarioWorkerKeys(scenario, runSeedHex) {
  const scenarioId = String(scenario?.id || 'S00').trim() || 'S00'
  const envWorkerA = normalizePrivkey(process.env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY)
  const envWorkerB = normalizePrivkey(process.env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY)
  const envWorkerC = normalizePrivkey(process.env.HT_MULTI_GATEWAY_WORKER_C_PRIVKEY)

  const workerAPrivkey =
    envWorkerA || deriveDeterministicPrivkey(runSeedHex, scenarioId, 'worker-a')
  const workerBPrivkey =
    envWorkerB || deriveDeterministicPrivkey(runSeedHex, scenarioId, 'worker-b')
  const workerCPrivkey =
    envWorkerC || deriveDeterministicPrivkey(runSeedHex, scenarioId, 'worker-c')

  const workerAPubkey = derivePubkeyFromPrivkey(workerAPrivkey)
  const workerBPubkey = derivePubkeyFromPrivkey(workerBPrivkey)
  const workerCPubkey = derivePubkeyFromPrivkey(workerCPrivkey)

  if (!workerAPubkey || !workerBPubkey || !workerCPubkey) {
    throw new Error(`failed-to-derive-scenario-worker-pubkeys:${scenarioId}`)
  }

  return {
    workerA: { privkey: workerAPrivkey, pubkey: workerAPubkey },
    workerB: { privkey: workerBPrivkey, pubkey: workerBPubkey },
    workerC: { privkey: workerCPrivkey, pubkey: workerCPubkey }
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
  const joinTelemetry = []
  const autoconnectTelemetry = []
  const joinFanout = []
  const autoconnectFanout = []
  const failFastSignals = []
  const legacySharedSecretSignals = []
  const gatewayAuthSignals = {
    bearerIssuedCount: 0
  }
  const joinHintSignals = {
    joinStartSeen: false,
    joinStartCount: 0,
    maxHostPeerHintsCount: 0,
    sawDiscoveryTopicHint: false,
    sawWriterIssuerHint: false,
    sawHostPeerHintsZero: false
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue

    if (line.includes('[Worker] Start join flow input')) {
      joinHintSignals.joinStartSeen = true
      joinHintSignals.joinStartCount += 1
    }
    if (
      line.includes('missing-shared-secret')
      || line.includes('/.well-known/hypertuna-gateway-secret')
      || line.includes('Shared secret not configured')
    ) {
      legacySharedSecretSignals.push(line)
    }
    if (line.includes('[PublicGatewayAuth] Bearer token issued')) {
      gatewayAuthSignals.bearerIssuedCount += 1
    }
    const hostHintMatch = line.match(/\bhostPeerHintsCount:\s*([0-9]+)/)
    if (hostHintMatch) {
      const value = Number.parseInt(hostHintMatch[1], 10)
      if (Number.isFinite(value)) {
        joinHintSignals.maxHostPeerHintsCount = Math.max(joinHintSignals.maxHostPeerHintsCount, value)
        if (value === 0) joinHintSignals.sawHostPeerHintsZero = true
      }
    }
    if (/\bdiscoveryTopic:\s*'?[a-f0-9]{16,}'?/i.test(line)) {
      joinHintSignals.sawDiscoveryTopicHint = true
    }
    if (/\bwriterIssuerPubkey:\s*'?[a-f0-9]{16,}'?/i.test(line)) {
      joinHintSignals.sawWriterIssuerHint = true
    }

    if (line.includes('JOIN_FAIL_FAST_ABORT')) {
      failFastSignals.push({
        line,
        reason: 'JOIN_FAIL_FAST_ABORT'
      })
    }
    if (line.includes('AUTOCONNECT_FAIL_FAST_ABORT')) {
      failFastSignals.push({
        line,
        reason: 'AUTOCONNECT_FAIL_FAST_ABORT'
      })
    }

    const parsed = parseJsonFromLine(line)
    if (!parsed || typeof parsed !== 'object') {
      continue
    }

    if (parsed?.type === 'join-telemetry' && parsed?.data && typeof parsed.data === 'object') {
      joinTelemetry.push(parsed.data)
      if (parsed.data.eventType === 'JOIN_FAIL_FAST_ABORT') {
        failFastSignals.push({
          reason: parsed.data.reasonCode || 'join-fail-fast',
          traceId: parsed.data.traceId || null,
          payload: parsed.data
        })
      }
      continue
    }

    if (parsed?.type === 'autoconnect-telemetry' && parsed?.data && typeof parsed.data === 'object') {
      autoconnectTelemetry.push(parsed.data)
      if (parsed.data.eventType === 'AUTOCONNECT_FAIL_FAST_ABORT') {
        failFastSignals.push({
          reason: parsed.data.reasonCode || 'autoconnect-fail-fast',
          traceId: parsed.data.traceId || null,
          payload: parsed.data
        })
      }
      continue
    }

    if (parsed?.eventType && typeof parsed.eventType === 'string') {
      if (parsed.eventType.startsWith('AUTOCONNECT_')) {
        autoconnectTelemetry.push(parsed)
      } else {
        joinTelemetry.push(parsed)
      }
      if (parsed.eventType === 'JOIN_FAIL_FAST_ABORT' || parsed.eventType === 'AUTOCONNECT_FAIL_FAST_ABORT') {
        failFastSignals.push({
          reason: parsed.reasonCode || 'telemetry-fail-fast',
          traceId: parsed.traceId || null,
          payload: parsed
        })
      }
      continue
    }

    if (parsed?.type === 'join-fanout-summary' && parsed?.data && typeof parsed.data === 'object') {
      joinFanout.push(parsed.data)
      continue
    }

    if (parsed?.type === 'autoconnect-fanout-summary' && parsed?.data && typeof parsed.data === 'object') {
      autoconnectFanout.push(parsed.data)
      continue
    }

    if (parsed?.traceId && parsed?.results && Array.isArray(parsed.results) && Number.isFinite(parsed.successCount)) {
      const trace = typeof parsed.traceId === 'string' ? parsed.traceId : ''
      if (trace.startsWith('autoconnect-')) {
        autoconnectFanout.push(parsed)
      } else {
        joinFanout.push(parsed)
      }
    }
  }

  return {
    joinTelemetry,
    autoconnectTelemetry,
    joinFanout,
    autoconnectFanout,
    failFastSignals,
    legacySharedSecretSignals,
    gatewayAuthSignals,
    joinHintSignals
  }
}

async function parseWorkerLogs(files = []) {
  const combined = {
    joinTelemetry: [],
    autoconnectTelemetry: [],
    joinFanout: [],
    autoconnectFanout: [],
    failFastSignals: [],
    legacySharedSecretSignals: [],
    gatewayAuthSignals: {
      bearerIssuedCount: 0
    },
    joinHintSignals: {
      joinStartSeen: false,
      joinStartCount: 0,
      maxHostPeerHintsCount: 0,
      sawDiscoveryTopicHint: false,
      sawWriterIssuerHint: false,
      sawHostPeerHintsZero: false
    }
  }

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const parsed = parseWorkerLogContent(content)
      combined.joinTelemetry.push(...parsed.joinTelemetry)
      combined.autoconnectTelemetry.push(...parsed.autoconnectTelemetry)
      combined.joinFanout.push(...parsed.joinFanout)
      combined.autoconnectFanout.push(...parsed.autoconnectFanout)
      combined.failFastSignals.push(...parsed.failFastSignals)
      combined.legacySharedSecretSignals.push(...parsed.legacySharedSecretSignals)
      combined.gatewayAuthSignals.bearerIssuedCount += parsed.gatewayAuthSignals?.bearerIssuedCount || 0
      combined.joinHintSignals.joinStartSeen =
        combined.joinHintSignals.joinStartSeen || parsed.joinHintSignals.joinStartSeen
      combined.joinHintSignals.joinStartCount += parsed.joinHintSignals.joinStartCount || 0
      combined.joinHintSignals.maxHostPeerHintsCount = Math.max(
        combined.joinHintSignals.maxHostPeerHintsCount,
        parsed.joinHintSignals.maxHostPeerHintsCount || 0
      )
      combined.joinHintSignals.sawDiscoveryTopicHint =
        combined.joinHintSignals.sawDiscoveryTopicHint || parsed.joinHintSignals.sawDiscoveryTopicHint
      combined.joinHintSignals.sawWriterIssuerHint =
        combined.joinHintSignals.sawWriterIssuerHint || parsed.joinHintSignals.sawWriterIssuerHint
      combined.joinHintSignals.sawHostPeerHintsZero =
        combined.joinHintSignals.sawHostPeerHintsZero || parsed.joinHintSignals.sawHostPeerHintsZero
    } catch (_) {}
  }

  return combined
}

function selectPrimaryTrace(telemetry = [], prefix = 'JOIN') {
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
    const hasConfirmed = events.some((event) => event?.eventType === `${prefix}_WRITABLE_CONFIRMED`)
    const hasStart = events.some((event) => event?.eventType === `${prefix}_START`)
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

function findWritableViewLength(primaryEvents = [], prefix = 'JOIN') {
  const confirmed = primaryEvents.find((entry) => entry?.eventType === `${prefix}_WRITABLE_CONFIRMED`) || null
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

function normalizeExpectedViewLength(observedViewLength, expectedViewLength) {
  const observed = Number.isFinite(observedViewLength) ? Number(observedViewLength) : null
  const expected = Number.isFinite(expectedViewLength) ? Number(expectedViewLength) : null
  if (expected !== null && expected > 0) return expected
  if (observed !== null) return observed
  return expected
}

function getEnvGatewayDefinitions() {
  return {
    gateway1: {
      mode: gatewayTopology.gateway1.mode,
      baseUrl: process.env.HT_GW1_BASE_URL || 'http://127.0.0.1:4541',
      operatorPrivkey: process.env.HT_GW1_OPERATOR_PRIVKEY || '1111111111111111111111111111111111111111111111111111111111111111',
      operatorPubkey: process.env.HT_GW1_OPERATOR_PUBKEY || '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
    },
    gateway2: {
      mode: gatewayTopology.gateway2.mode,
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

async function configureScenarioPolicies(scenario, scenarioWorkerKeys = null) {
  const gateways = getEnvGatewayDefinitions()
  const gatewayTokens = {}
  for (const gatewayName of ['gateway1', 'gateway2']) {
    if (!isGatewayEnabled(gatewayName)) continue
    const gateway = gateways[gatewayName]
    const token = await issueOperatorToken(gateway)
    gatewayTokens[gatewayName] = token
    await gatewayRequest(gateway, token, 'POST', '/api/gateway/policy', {
      policy: scenario[gatewayName] === 'CLOSED' ? 'CLOSED' : 'OPEN',
      inviteOnly: gatewayName === 'gateway1' && scenario.id === 'S17',
      discoveryRelays: ['wss://relay.damus.io', 'wss://nos.lol']
    })
    await resetGatewayLists(gateway, token)
  }

  const derivedAdminPubkey =
    scenarioWorkerKeys?.workerA?.pubkey
    || derivePubkeyFromPrivkey(process.env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY || DEFAULT_WORKER_A_PRIVKEY)
  const derivedWorkerBPubkey =
    scenarioWorkerKeys?.workerB?.pubkey
    || derivePubkeyFromPrivkey(process.env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY || DEFAULT_WORKER_B_PRIVKEY)
  const adminPubkeys = dedupePubkeys([options.adminPubkey, derivedAdminPubkey])
  const workerBPubkeys = dedupePubkeys([options.workerBPubkey, derivedWorkerBPubkey])

  const addAllow = async (gatewayName, pubkey) => {
    if (!pubkey) return
    if (!isGatewayEnabled(gatewayName)) return
    const gateway = gateways[gatewayName]
    const token = gatewayTokens[gatewayName]
    if (!gateway || !token) return
    await gatewayRequest(gateway, token, 'POST', '/api/gateway/allow-list', { pubkey })
  }
  const addBan = async (gatewayName, pubkey) => {
    if (!pubkey) return
    if (!isGatewayEnabled(gatewayName)) return
    const gateway = gateways[gatewayName]
    const token = gatewayTokens[gatewayName]
    if (!gateway || !token) return
    await gatewayRequest(gateway, token, 'POST', '/api/gateway/ban-list', { pubkey })
  }

  if (['S02', 'S06'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow('gateway2', pubkey)
    }
  }
  if (['S03', 'S07'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow('gateway1', pubkey)
    }
  }
  if (['S04', 'S08'].includes(scenario.id)) {
    for (const pubkey of adminPubkeys) {
      await addAllow('gateway1', pubkey)
      await addAllow('gateway2', pubkey)
    }
  }
  if (['S11', 'S12'].includes(scenario.id)) {
    for (const pubkey of workerBPubkeys) {
      await addBan('gateway1', pubkey)
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
  if (line.includes('AUTOCONNECT_FAIL_FAST_ABORT')) {
    return {
      failFast: true,
      reason: 'AUTOCONNECT_FAIL_FAST_ABORT'
    }
  }
  if (line.includes('autoconnect-writer-material-timeout')) {
    return {
      failFast: true,
      reason: 'autoconnect-writer-material-timeout'
    }
  }
  if (line.includes('autoconnect-writable-timeout')) {
    return {
      failFast: true,
      reason: 'autoconnect-writable-timeout'
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

async function parseExecutorStageFlags(scenarioDir) {
  const flags = {
    restartAutoconnectConfirmed: false,
    scenarioComplete: false
  }
  const filePath = path.join(scenarioDir, 'executor.stdout.log')
  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return flags
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    if (line.includes('[executor-renderer][stage] restart-autoconnect-confirmed')) {
      flags.restartAutoconnectConfirmed = true
    }
    if (line.includes('[executor-renderer][stage] scenario-complete')) {
      flags.scenarioComplete = true
    }
  }
  return flags
}

async function runScenarioExecutor(scenario, scenarioDir, scenarioWorkerKeys = null) {
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
    HT_MULTI_GATEWAY_GATES: JSON.stringify(HARD_GATES),
    HT_GW1_MODE: gatewayTopology.gateway1.mode,
    HT_GW2_MODE: gatewayTopology.gateway2.mode
  }

  if (scenarioWorkerKeys?.workerA?.privkey) {
    env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY = scenarioWorkerKeys.workerA.privkey
  }
  if (scenarioWorkerKeys?.workerB?.privkey) {
    env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY = scenarioWorkerKeys.workerB.privkey
  }
  if (scenarioWorkerKeys?.workerC?.privkey) {
    env.HT_MULTI_GATEWAY_WORKER_C_PRIVKEY = scenarioWorkerKeys.workerC.privkey
  }

  const watchdog = {
    join: {
      startedAtMs: null,
      writerMaterialApplied: false,
      fastForwardApplied: false,
      fastForwardExpected: false,
      writableConfirmed: false
    },
    autoconnect: {
      startedAtMs: null,
      writerMaterialApplied: false,
      fastForwardApplied: false,
      fastForwardExpected: false,
      writableConfirmed: false
    }
  }

  const checkWatchdogStage = (stage, label) => {
    if (!stage.startedAtMs || stage.writableConfirmed) return null
    const elapsed = Date.now() - stage.startedAtMs
    if (elapsed > HARD_GATES.joinToWritableMs) {
      return {
        failFast: true,
        reason: label === 'autoconnect'
          ? 'autoconnect-writable-timeout'
          : 'join-writable-timeout'
      }
    }
    if (!stage.writerMaterialApplied && elapsed > HARD_GATES.writerMaterialMs) {
      return {
        failFast: true,
        reason: label === 'autoconnect'
          ? 'autoconnect-writer-material-timeout'
          : 'writer-material-timeout'
      }
    }
    if (stage.fastForwardExpected && !stage.fastForwardApplied && elapsed > HARD_GATES.fastForwardMs) {
      return {
        failFast: true,
        reason: label === 'autoconnect'
          ? 'autoconnect-fast-forward-timeout'
          : 'fast-forward-timeout'
      }
    }
    return null
  }

  const onExecutorLine = (line) => {
    const immediate = detectFailFastLine(line)
    if (immediate) return immediate

    const parsed = parseJsonFromLine(line)
    const telemetry = parsed?.type === 'join-telemetry'
      ? parsed?.data
      : (parsed?.type === 'autoconnect-telemetry'
        ? parsed?.data
        : (parsed?.eventType ? parsed : null))
    if (telemetry && typeof telemetry === 'object') {
      const eventType = typeof telemetry.eventType === 'string' ? telemetry.eventType : ''
      const stage = eventType.startsWith('AUTOCONNECT_')
        ? watchdog.autoconnect
        : watchdog.join

      if (eventType.endsWith('_START')) {
        stage.startedAtMs = Date.now()
        stage.fastForwardExpected = telemetry?.meta?.hasFastForward === true
      }
      if (eventType.endsWith('_WRITER_MATERIAL_APPLIED')) {
        stage.writerMaterialApplied = true
      }
      if (eventType.endsWith('_FAST_FORWARD_APPLIED')) {
        stage.fastForwardApplied = true
      }
      if (eventType.endsWith('_WRITABLE_CONFIRMED')) {
        stage.writableConfirmed = true
      }
      if (telemetry.eventType === 'JOIN_FAIL_FAST_ABORT') {
        return {
          failFast: true,
          reason: telemetry.reasonCode || 'join-fail-fast'
        }
      }
      if (telemetry.eventType === 'AUTOCONNECT_FAIL_FAST_ABORT') {
        return {
          failFast: true,
          reason: telemetry.reasonCode || 'autoconnect-fail-fast'
        }
      }
    }

    return checkWatchdogStage(watchdog.join, 'join')
      || checkWatchdogStage(watchdog.autoconnect, 'autoconnect')
      || null
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
    const failFastReason = String(run.failFastReason || '')
    const writerMaterialFailFast = /writer-material-timeout|join-fail-fast|join_fail_fast_abort/i.test(failFastReason)
    if (scenarioExpectsFailFast(scenario) || (scenarioAllowsWriterMaterialFailFast(scenario) && writerMaterialFailFast)) {
      return {
        status: 'OK',
        reason: run.failFastReason || 'expected-fail-fast',
        summary,
        run
      }
    }
    return {
      status: 'FAIL',
      reason: run.failFastReason || 'executor-fail-fast',
      summary,
      run
    }
  }
  if (run.code !== 0) {
    if (scenarioAllowsWriterMaterialFailFast(scenario)) {
      const mergedOutput = [...(run.stdoutLines || []), ...(run.stderrLines || [])].join('\n')
      if (/writer-material-timeout|JOIN_FAIL_FAST_ABORT|join-fail-fast/i.test(mergedOutput)) {
        return {
          status: 'OK',
          reason: 'expected-fail-fast',
          summary,
          run
        }
      }
    }
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

async function captureGatewayLogSnapshot(gatewayName, scenarioDir) {
  const topology = gatewayTopology[gatewayName]
  if (!topology || !topology.remoteLogCommand) return null
  const stdoutFile = path.join(scenarioDir, `${gatewayName}.snapshot.stdout.log`)
  const stderrFile = path.join(scenarioDir, `${gatewayName}.snapshot.stderr.log`)
  const run = await runCommand('zsh', ['-lc', topology.remoteLogCommand], {
    cwd: ROOT_DIR,
    timeoutMs: 120000,
    stdoutFile,
    stderrFile
  })
  return {
    gateway: gatewayName,
    mode: topology.mode,
    command: topology.remoteLogCommand,
    code: run.code,
    timedOut: run.timedOut,
    stdoutFile,
    stderrFile
  }
}

async function cleanupScenarioRelayRegistrations(executorSummary) {
  const relayKey =
    typeof executorSummary?.relayKey === 'string' && executorSummary.relayKey.trim()
      ? executorSummary.relayKey.trim()
      : null
  if (!relayKey) {
    return {
      relayKey: null,
      cleaned: false,
      results: []
    }
  }

  const gateways = getEnvGatewayDefinitions()
  const results = []
  for (const gatewayName of ['gateway1', 'gateway2']) {
    if (!isGatewayEnabled(gatewayName)) continue
    const gateway = gateways[gatewayName]
    try {
      const token = await issueOperatorToken(gateway, 'gateway:relay-register')
      const response = await gatewayRequest(
        gateway,
        token,
        'DELETE',
        `/api/relays/${encodeURIComponent(relayKey)}`
      )
      results.push({
        gateway: gatewayName,
        baseUrl: gateway.baseUrl,
        httpStatus: response.status,
        status: response.ok ? 'deleted' : (response.status === 404 ? 'not-found' : 'error')
      })
    } catch (error) {
      results.push({
        gateway: gatewayName,
        baseUrl: gateway?.baseUrl || null,
        status: 'error',
        reason: error?.message || String(error)
      })
    }
  }

  return {
    relayKey,
    cleaned: results.some((entry) => entry.status === 'deleted'),
    results
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
  const joinTrace = selectPrimaryTrace(parsedWorker.joinTelemetry, 'JOIN')
  const autoconnectTrace = selectPrimaryTrace(parsedWorker.autoconnectTelemetry, 'AUTOCONNECT')

  const joinPerf = evaluateJoinPerformanceTelemetry(joinTrace.events, {
    writableHardMs: HARD_GATES.joinToWritableMs,
    writableWarnMs: HARD_GATES.joinToWritableWarnMs,
    writerMaterialMs: HARD_GATES.writerMaterialMs,
    fastForwardMs: HARD_GATES.fastForwardMs
  }, {
    prefix: 'JOIN'
  })
  const autoconnectPerf = evaluateJoinPerformanceTelemetry(autoconnectTrace.events, {
    writableHardMs: HARD_GATES.joinToWritableMs,
    writableWarnMs: HARD_GATES.joinToWritableWarnMs,
    writerMaterialMs: HARD_GATES.writerMaterialMs,
    fastForwardMs: HARD_GATES.fastForwardMs
  }, {
    prefix: 'AUTOCONNECT'
  })

  const joinFanoutSummary = selectFanoutSummary(parsedWorker.joinFanout, joinTrace.traceId)
  const joinFanout = evaluateFanoutResults(joinFanoutSummary?.results || [], {
    minimumSuccess: HARD_GATES.minimumFanoutSuccess
  })
  const autoconnectFanoutSummary = selectFanoutSummary(parsedWorker.autoconnectFanout, autoconnectTrace.traceId)
  const autoconnectFanout = evaluateFanoutResults(autoconnectFanoutSummary?.results || [], {
    minimumSuccess: HARD_GATES.minimumFanoutSuccess
  })

  const joinWritableView = findWritableViewLength(joinTrace.events, 'JOIN')
  const autoconnectWritableView = findWritableViewLength(autoconnectTrace.events, 'AUTOCONNECT')
  const observedViewLength = Number.isFinite(summary?.observedViewLength)
    ? Number(summary.observedViewLength)
    : joinWritableView.viewLength
  const expectedViewLength = Number.isFinite(summary?.expectedViewLength)
    ? Number(summary.expectedViewLength)
    : joinWritableView.expectedViewLength
  const autoconnectObservedViewLength = Number.isFinite(summary?.autoConnectObservedViewLength)
    ? Number(summary.autoConnectObservedViewLength)
    : autoconnectWritableView.viewLength
  const autoconnectExpectedViewLength = Number.isFinite(summary?.autoConnectExpectedViewLength)
    ? Number(summary.autoConnectExpectedViewLength)
    : autoconnectWritableView.expectedViewLength
  const normalizedExpectedViewLength = normalizeExpectedViewLength(observedViewLength, expectedViewLength)
  const normalizedAutoconnectExpectedViewLength = normalizeExpectedViewLength(
    autoconnectObservedViewLength,
    autoconnectExpectedViewLength
  )
  const stageFlags = await parseExecutorStageFlags(scenarioDir)
  const hasAutoconnectTelemetry = Array.isArray(autoconnectTrace.events) && autoconnectTrace.events.length > 0
  const hasAutoConnectViewEvidence =
    Number.isFinite(autoconnectObservedViewLength) && Number.isFinite(autoconnectExpectedViewLength)
  const autoconnectFallbackPass =
    !hasAutoconnectTelemetry
    && stageFlags.restartAutoconnectConfirmed
    && hasAutoConnectViewEvidence
    && autoconnectObservedViewLength === normalizedAutoconnectExpectedViewLength

  const allowWriterMaterialFailFastEvaluation =
    scenario?.id === 'S21'
    || (
      scenario?.id === 'S20'
      && /fail-fast|writer-material-timeout/i.test(String(executorResult?.reason || ''))
    )

  if (allowWriterMaterialFailFastEvaluation) {
    const failFastSignals = Array.isArray(parsedWorker.failFastSignals) ? parsedWorker.failFastSignals : []
    const failFastObserved = failFastSignals.length > 0
      || joinPerf?.failFastReason
      || autoconnectPerf?.failFastReason
    const joinHintSignals = parsedWorker.joinHintSignals || {
      joinStartSeen: false,
      joinStartCount: 0,
      maxHostPeerHintsCount: 0,
      sawDiscoveryTopicHint: false,
      sawWriterIssuerHint: false,
      sawHostPeerHintsZero: false
    }
    const checks = [
      {
        name: 'expected_closed_join_without_lease_fail_fast',
        pass: !!failFastObserved,
        signals: failFastSignals,
        joinFailFastReason: joinPerf?.failFastReason || null,
        autoconnectFailFastReason: autoconnectPerf?.failFastReason || null
      },
      {
        name: 'join_dispatch_hint_evidence',
        pass:
          joinHintSignals.joinStartSeen
          && (joinHintSignals.maxHostPeerHintsCount > 0 || joinHintSignals.sawDiscoveryTopicHint),
        joinHintSignals
      }
    ]
    return {
      scenario: scenario.id,
      traceId: joinTrace.traceId,
      autoconnectTraceId: autoconnectTrace.traceId,
      status: failFastObserved ? 'PASS' : 'FAIL',
      hardFailures: failFastObserved ? [] : checks,
      warnings: [],
      checks,
      telemetryEvents: joinTrace.events,
      joinTelemetryEvents: joinTrace.events,
      autoconnectTelemetryEvents: autoconnectTrace.events,
      fanoutSummary: joinFanoutSummary || null,
      joinFanoutSummary: joinFanoutSummary || null,
      autoconnectFanoutSummary: autoconnectFanoutSummary || null,
      joinPerformance: joinPerf,
      autoconnectPerformance: autoconnectPerf,
      failFastSignals,
      workerLogs,
      summary
    }
  }

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
    name: 'join_writer_material_stage',
    pass: joinPerf.writerMaterialPass,
    observedMs: joinPerf.writerMaterialElapsedMs,
    thresholdMs: HARD_GATES.writerMaterialMs
  })
  checks.push({
    name: 'join_fast_forward_stage',
    pass: joinPerf.fastForwardPass,
    observedMs: joinPerf.fastForwardElapsedMs,
    thresholdMs: HARD_GATES.fastForwardMs
  })
  checks.push({
    name: 'join_fanout_success_threshold',
    pass: joinFanout.passesThreshold,
    successCount: joinFanout.successCount,
    minimumSuccess: joinFanout.minimumSuccess
  })

  const hasViewEvidence = Number.isFinite(observedViewLength) && Number.isFinite(expectedViewLength)
  checks.push({
    name: 'join_view_length_match',
    pass: hasViewEvidence ? observedViewLength === normalizedExpectedViewLength : false,
    observedViewLength,
    expectedViewLength: normalizedExpectedViewLength
  })

  checks.push({
    name: 'autoconnect_to_writable_hard',
    pass: autoconnectPerf.writableHardPass || autoconnectFallbackPass,
    observedMs: autoconnectPerf.writableElapsedMs,
    thresholdMs: HARD_GATES.joinToWritableMs,
    fallbackUsed: autoconnectFallbackPass
  })
  checks.push({
    name: 'autoconnect_to_writable_warn',
    pass: autoconnectPerf.writableWarnPass || autoconnectFallbackPass,
    observedMs: autoconnectPerf.writableElapsedMs,
    thresholdMs: HARD_GATES.joinToWritableWarnMs,
    severity: 'warning',
    fallbackUsed: autoconnectFallbackPass
  })
  checks.push({
    name: 'autoconnect_writer_material_stage',
    pass: autoconnectPerf.writerMaterialPass || autoconnectFallbackPass,
    observedMs: autoconnectPerf.writerMaterialElapsedMs,
    thresholdMs: HARD_GATES.writerMaterialMs,
    fallbackUsed: autoconnectFallbackPass
  })
  checks.push({
    name: 'autoconnect_fast_forward_stage',
    pass: autoconnectPerf.fastForwardPass,
    observedMs: autoconnectPerf.fastForwardElapsedMs,
    thresholdMs: HARD_GATES.fastForwardMs
  })
  checks.push({
    name: 'autoconnect_fanout_success_threshold',
    pass: autoconnectFanout.passesThreshold || autoconnectFallbackPass,
    successCount: autoconnectFallbackPass ? HARD_GATES.minimumFanoutSuccess : autoconnectFanout.successCount,
    minimumSuccess: autoconnectFanout.minimumSuccess,
    fallbackUsed: autoconnectFallbackPass
  })
  checks.push({
    name: 'autoconnect_view_length_match',
    pass: hasAutoConnectViewEvidence
      ? autoconnectObservedViewLength === normalizedAutoconnectExpectedViewLength
      : false,
    observedViewLength: autoconnectObservedViewLength,
    expectedViewLength: normalizedAutoconnectExpectedViewLength
  })
  checks.push({
    name: 'autoconnect_telemetry_or_fallback',
    pass: hasAutoconnectTelemetry || autoconnectFallbackPass,
    hasAutoconnectTelemetry,
    fallbackUsed: autoconnectFallbackPass,
    restartAutoconnectConfirmed: stageFlags.restartAutoconnectConfirmed
  })

  const joinPathSelectedEvent = [...(Array.isArray(joinTrace.events) ? joinTrace.events : [])]
    .reverse()
    .find((event) => event?.eventType === 'JOIN_PATH_SELECTED') || null
  const joinWriterSourceEvent = [...(Array.isArray(joinTrace.events) ? joinTrace.events : [])]
    .reverse()
    .find((event) => event?.eventType === 'JOIN_WRITER_SOURCE') || null
  const selectedWriterGuarantee =
    typeof joinPathSelectedEvent?.meta?.selectedWriterGuarantee === 'string'
      ? joinPathSelectedEvent.meta.selectedWriterGuarantee
      : null
  const selectedWriterSource =
    typeof joinWriterSourceEvent?.meta?.source === 'string'
      ? joinWriterSourceEvent.meta.source
      : null

  if (['S19', 'S20', 'S22'].includes(scenario?.id)) {
    checks.push({
      name: 'join_path_selected_telemetry',
      pass: !!joinPathSelectedEvent,
      selectedWriterGuarantee,
      selectedWriterSource
    })
    checks.push({
      name: 'join_writer_source_telemetry',
      pass: !!joinWriterSourceEvent,
      selectedWriterGuarantee,
      selectedWriterSource
    })
  }
  if (scenario?.id === 'S19') {
    checks.push({
      name: 's19_peer_local_provision_source',
      pass: selectedWriterSource === 'peer-local-provision' || selectedWriterGuarantee === 'peer-local-provision',
      selectedWriterGuarantee,
      selectedWriterSource
    })
  }
  if (scenario?.id === 'S20') {
    checks.push({
      name: 's20_peer_invite_lease_source',
      pass: selectedWriterSource === 'peer-invite-lease' || selectedWriterGuarantee === 'peer-invite-lease',
      selectedWriterGuarantee,
      selectedWriterSource
    })
  }
  if (scenario?.id === 'S22') {
    checks.push({
      name: 's22_peer_path_preferred',
      pass: typeof selectedWriterGuarantee === 'string' && selectedWriterGuarantee.startsWith('peer-'),
      selectedWriterGuarantee,
      selectedWriterSource
    })
  }

  checks.push({
    name: 'legacy_shared_secret_fallback_not_used',
    pass: !Array.isArray(parsedWorker.legacySharedSecretSignals) || parsedWorker.legacySharedSecretSignals.length === 0,
    signals: parsedWorker.legacySharedSecretSignals || []
  })

  const gatewayWriterPathSelected =
    (typeof selectedWriterGuarantee === 'string' && selectedWriterGuarantee.startsWith('gateway-'))
    || (typeof selectedWriterSource === 'string' && selectedWriterSource.startsWith('gateway-'))
  checks.push({
    name: 'gateway_nostr_bearer_auth_observed',
    pass: !gatewayWriterPathSelected || (parsedWorker.gatewayAuthSignals?.bearerIssuedCount || 0) > 0,
    gatewayWriterPathSelected,
    bearerIssuedCount: parsedWorker.gatewayAuthSignals?.bearerIssuedCount || 0
  })

  const joinHintSignals = parsedWorker.joinHintSignals || {
    joinStartSeen: false,
    joinStartCount: 0,
    maxHostPeerHintsCount: 0,
    sawDiscoveryTopicHint: false,
    sawWriterIssuerHint: false,
    sawHostPeerHintsZero: false
  }
  const metadataHintContinuityPass =
    !joinHintSignals.joinStartSeen
    || (
      joinHintSignals.sawDiscoveryTopicHint
      && (
        joinHintSignals.maxHostPeerHintsCount > 0
        || scenario?.id === 'S19'
      )
    )
  checks.push({
    name: 'join_dispatch_hint_evidence',
    pass:
      joinHintSignals.joinStartSeen
      && (joinHintSignals.maxHostPeerHintsCount > 0 || joinHintSignals.sawDiscoveryTopicHint),
    joinHintSignals
  })
  checks.push({
    name: 'metadata_hint_continuity',
    pass: metadataHintContinuityPass,
    joinHintSignals
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
    traceId: joinTrace.traceId,
    autoconnectTraceId: autoconnectTrace.traceId,
    status: hardFailures.length === 0 ? 'PASS' : 'FAIL',
    hardFailures,
    warnings,
    checks,
    telemetryEvents: joinTrace.events,
    joinTelemetryEvents: joinTrace.events,
    autoconnectTelemetryEvents: autoconnectTrace.events,
    fanoutSummary: joinFanoutSummary || null,
    joinFanoutSummary: joinFanoutSummary || null,
    autoconnectFanoutSummary: autoconnectFanoutSummary || null,
    joinPerformance: joinPerf,
    autoconnectPerformance: autoconnectPerf,
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
  logLine('[multi-gateway] gateway topology', {
    gateway1: gatewayTopology.gateway1.mode,
    gateway2: gatewayTopology.gateway2.mode
  })

  let dockerStarted = false
  if (!options.skipDocker && !options.dryRun) {
    const localServices = []
    if (isGatewayLocal('gateway1')) localServices.push('redis1', 'gateway1')
    if (isGatewayLocal('gateway2')) localServices.push('redis2', 'gateway2')

    if (localServices.length > 0) {
      logLine('[multi-gateway] starting local docker gateways', { services: localServices })
      const up = await dockerCompose(['up', '-d', '--build', ...localServices])
      if (up.code !== 0) {
        throw new Error(`docker compose up failed: ${up.code}`)
      }
      dockerStarted = true
    } else {
      logLine('[multi-gateway] no local gateways selected; skipping docker startup')
    }
  }

  if (!options.dryRun) {
    const gateways = getEnvGatewayDefinitions()
    for (const gatewayName of ['gateway1', 'gateway2']) {
      if (!isGatewayEnabled(gatewayName)) continue
      const gateway = gateways[gatewayName]
      const healthy = await waitForGatewayHealth(gateway.baseUrl)
      if (!healthy) {
        throw new Error(`gateway health check failed: ${gatewayName} (${gateway.baseUrl})`)
      }
    }
    logLine('[multi-gateway] gateway health checks passed')
  }

  const runSeedHex = randomBytes(16).toString('hex')
  const results = []
  try {
    for (const scenario of scenarios) {
      const scenarioDir = path.join(runDir, scenario.id)
      await ensureDir(scenarioDir)
      const scenarioWorkerKeys = buildScenarioWorkerKeys(scenario, runSeedHex)
      await fs.writeFile(
        path.join(scenarioDir, 'scenario.json'),
        JSON.stringify(scenario, null, 2),
        'utf8'
      )
      await fs.writeFile(
        path.join(scenarioDir, 'scenario-worker-keys.json'),
        JSON.stringify(
          {
            workerA: scenarioWorkerKeys.workerA.pubkey,
            workerB: scenarioWorkerKeys.workerB.pubkey,
            workerC: scenarioWorkerKeys.workerC.pubkey
          },
          null,
          2
        ),
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

      if (isGatewayEnabled('gateway1') || isGatewayEnabled('gateway2')) {
        try {
          await configureScenarioPolicies(scenario, scenarioWorkerKeys)
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
        gateway2: scenario.gateway2,
        workerA: scenarioWorkerKeys.workerA.pubkey,
        workerB: scenarioWorkerKeys.workerB.pubkey
      })

      const executorResult = await runScenarioExecutor(scenario, scenarioDir, scenarioWorkerKeys)
      const gatewaySnapshots = []
      for (const gatewayName of ['gateway1', 'gateway2']) {
        if (!gatewayTopology[gatewayName]?.remoteLogCommand) continue
        try {
          const snapshot = await captureGatewayLogSnapshot(gatewayName, scenarioDir)
          if (snapshot) gatewaySnapshots.push(snapshot)
        } catch (error) {
          gatewaySnapshots.push({
            gateway: gatewayName,
            mode: gatewayTopology[gatewayName]?.mode || null,
            command: gatewayTopology[gatewayName]?.remoteLogCommand || null,
            error: error?.message || String(error)
          })
        }
      }
      if (gatewaySnapshots.length > 0) {
        await fs.writeFile(
          path.join(scenarioDir, 'gateway-snapshots.json'),
          JSON.stringify(gatewaySnapshots, null, 2),
          'utf8'
        )
      }
      const relayCleanup = await cleanupScenarioRelayRegistrations(executorResult.summary)
      await fs.writeFile(
        path.join(scenarioDir, 'relay-cleanup.json'),
        JSON.stringify(relayCleanup, null, 2),
        'utf8'
      )
      if (executorResult.status !== 'OK') {
        results.push({
          scenario: scenario.id,
          status: executorResult.status,
          reason: executorResult.reason,
          checks: [],
          gatewaySnapshots,
          relayCleanup
        })
        continue
      }

      const evaluated = await evaluateScenarioResult(scenario, scenarioDir, executorResult)
      if (gatewaySnapshots.length > 0) {
        evaluated.gatewaySnapshots = gatewaySnapshots
      }
      evaluated.relayCleanup = relayCleanup
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
    topology: {
      gateway1: gatewayTopology.gateway1.mode,
      gateway2: gatewayTopology.gateway2.mode
    },
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
    `- Topology: gateway1=${summary.topology.gateway1} gateway2=${summary.topology.gateway2}`,
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
