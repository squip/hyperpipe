#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { schnorr } from '@noble/curves/secp256k1'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '../../..')
const WORKER_ROOT = path.resolve(ROOT_DIR, 'hypertuna-worker')

const SCENARIO_ID = process.env.HT_SCENARIO_ID || 'S00'
const SCENARIO_DIR = path.resolve(process.env.HT_SCENARIO_DIR || process.cwd())
const SCENARIO_TIMEOUT_MS = Number.parseInt(process.env.HT_SCENARIO_TIMEOUT_MS || '720000', 10)
const GATES = parseJsonEnv(process.env.HT_MULTI_GATEWAY_GATES, {
  joinToWritableMs: 120000,
  joinToWritableWarnMs: 60000,
  writerMaterialMs: 45000,
  fastForwardMs: 30000,
  minimumFanoutSuccess: 1
})
const SCENARIO = parseJsonEnv(process.env.HT_SCENARIO_JSON, {
  id: SCENARIO_ID,
  groupType: 'OPEN',
  gateway1: 'OPEN',
  gateway2: 'OPEN'
})

const GATEWAYS = {
  gateway1: {
    baseUrl: process.env.HT_GW1_BASE_URL || 'http://127.0.0.1:4541',
    operatorPrivkey:
      process.env.HT_GW1_OPERATOR_PRIVKEY
      || '1111111111111111111111111111111111111111111111111111111111111111',
    operatorPubkey:
      process.env.HT_GW1_OPERATOR_PUBKEY
      || '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  },
  gateway2: {
    baseUrl: process.env.HT_GW2_BASE_URL || 'http://127.0.0.1:4542',
    operatorPrivkey:
      process.env.HT_GW2_OPERATOR_PRIVKEY
      || '2222222222222222222222222222222222222222222222222222222222222222',
    operatorPubkey:
      process.env.HT_GW2_OPERATOR_PUBKEY
      || '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
  }
}

const REGISTRATION_SHARED_SECRET = process.env.HT_REGISTRATION_SHARED_SECRET || 'e2e-registration-secret'

const WORKER_A_PRIVKEY =
  normalizeHexKey(process.env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY)
  || '3333333333333333333333333333333333333333333333333333333333333333'
const WORKER_B_PRIVKEY =
  normalizeHexKey(process.env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY)
  || '4444444444444444444444444444444444444444444444444444444444444444'

const WORKER_A_PUBKEY = derivePubkey(WORKER_A_PRIVKEY)
const WORKER_B_PUBKEY = derivePubkey(WORKER_B_PRIVKEY)

function parseJsonEnv(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeHexKey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null
  return trimmed
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

function derivePubkey(privkeyHex) {
  const privBytes = hexToBytes(privkeyHex)
  if (!privBytes) {
    throw new Error('invalid-private-key')
  }
  return toHex(schnorr.getPublicKey(privBytes))
}

function nowTs() {
  return Date.now()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeRequestId(prefix = 'e2e') {
  return `${prefix}-${Date.now().toString(16)}-${randomBytes(4).toString('hex')}`
}

function baseNameForScenario(scenarioId = 'S00') {
  return `${scenarioId}-${Date.now().toString(16)}-${randomBytes(2).toString('hex')}`
}

function normalizeHttpOrigin(value) {
  if (!value || typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin
  } catch {
    return null
  }
}

function getWsProtocolFromHttpUrl(httpUrl) {
  const origin = normalizeHttpOrigin(httpUrl)
  if (!origin) return 'wss'
  return origin.startsWith('http://') ? 'ws' : 'wss'
}

function gatewayOrderForJoin() {
  return [
    normalizeHttpOrigin(GATEWAYS.gateway1.baseUrl),
    normalizeHttpOrigin(GATEWAYS.gateway2.baseUrl)
  ].filter(Boolean)
}

function chooseCreateGatewayName(scenario) {
  if (scenario?.id === 'S09' || scenario?.id === 'S10') return 'gateway2'
  if (scenario?.id === 'S11' || scenario?.id === 'S12') return 'gateway2'
  if (scenario?.id === 'S13' || scenario?.id === 'S14') return 'gateway2'
  if (scenario?.id === 'S15') return 'gateway2'
  if (scenario?.id === 'S16') return 'gateway1'
  if (scenario?.id === 'S17' || scenario?.id === 'S18') return 'gateway1'

  if (scenario?.gateway1 === 'OPEN') return 'gateway1'
  if (scenario?.gateway2 === 'OPEN') return 'gateway2'
  return 'gateway1'
}

function matchRelayIdentifier(payload, relayKey, publicIdentifier) {
  if (!payload || typeof payload !== 'object') return false
  const payloadRelayKey = typeof payload.relayKey === 'string' ? payload.relayKey : null
  const payloadPublicId = typeof payload.publicIdentifier === 'string' ? payload.publicIdentifier : null
  if (relayKey && payloadRelayKey && payloadRelayKey.toLowerCase() === relayKey.toLowerCase()) return true
  if (publicIdentifier && payloadPublicId && payloadPublicId === publicIdentifier) return true
  return false
}

function extractWritableMetricsFromTelemetry(entry) {
  if (!entry || typeof entry !== 'object') return { observedViewLength: null, expectedViewLength: null }
  const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  const viewLength = Number.isFinite(meta.viewLength) ? Number(meta.viewLength) : null
  const expectedViewLengthRaw = Number.isFinite(meta.expectedViewLength) ? Number(meta.expectedViewLength) : null
  const localLength = Number.isFinite(meta.localLength) ? Number(meta.localLength) : null
  const observedViewLength = viewLength ?? localLength
  const expectedViewLength = expectedViewLengthRaw ?? viewLength ?? localLength
  return {
    observedViewLength,
    expectedViewLength
  }
}

class WorkerClient {
  constructor({
    name,
    workerRoot,
    storageDir,
    userKey,
    pubkeyHex,
    nsecHex,
    logFile,
    scenarioTimeoutMs = 180000
  }) {
    this.name = name
    this.workerRoot = workerRoot
    this.storageDir = storageDir
    this.userKey = userKey
    this.pubkeyHex = pubkeyHex
    this.nsecHex = nsecHex
    this.logFile = logFile
    this.scenarioTimeoutMs = scenarioTimeoutMs
    this.proc = null
    this.logStream = null
    this.emitter = new EventEmitter()
    this.pending = new Map()
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.messageBacklog = []
    this.maxMessageBacklog = 4096
    this.stopped = false
  }

  async start() {
    await fs.mkdir(this.storageDir, { recursive: true })
    await fs.mkdir(path.dirname(this.logFile), { recursive: true })
    await fs.writeFile(this.logFile, '', 'utf8')
    this.logStream = createWriteStream(this.logFile, { flags: 'a' })

    this.proc = spawn(process.execPath, [path.join(this.workerRoot, 'index.js')], {
      cwd: this.workerRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        APP_DIR: this.workerRoot,
        STORAGE_DIR: this.storageDir,
        USER_KEY: this.userKey,
        HT_DEBUG_MULTI_GATEWAY: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })

    this.proc.stdout?.on('data', (chunk) => this.#consumeText('stdout', chunk))
    this.proc.stderr?.on('data', (chunk) => this.#consumeText('stderr', chunk))

    this.proc.on('message', (message) => {
      this.#handleMessage(message)
    })

    this.proc.on('exit', (code, signal) => {
      this.#appendLog(`[process] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      this.#rejectPending(`worker-exited:${code ?? signal ?? 'unknown'}`)
      this.emitter.emit('exit', { code, signal })
    })

    this.proc.on('error', (error) => {
      this.#appendLog(`[process] error ${error?.message || error}`)
      this.#rejectPending(`worker-error:${error?.message || error}`)
      this.emitter.emit('error', error)
    })

    this.send({
      type: 'config',
      data: {
        nostr_pubkey_hex: this.pubkeyHex,
        nostr_nsec_hex: this.nsecHex,
        userKey: this.userKey
      }
    })

    setTimeout(() => {
      if (!this.proc || !this.proc.connected) return
      this.send({
        type: 'config',
        data: {
          nostr_pubkey_hex: this.pubkeyHex,
          nostr_nsec_hex: this.nsecHex,
          userKey: this.userKey
        }
      })
    }, 1000).unref?.()

    await this.waitForMessage((message) => {
      if (!message || typeof message !== 'object') return false
      if (message.type === 'relay-server-ready') return true
      if (message.type === 'heartbeat' && message.status === 'running') return true
      if (message.type !== 'status') return false
      if (message.initialized === true) return true
      return message.phase === 'ready' || message.phase === 'gateway-ready'
    }, Math.min(this.scenarioTimeoutMs, 180000), `${this.name}:ready`)
  }

  onMessage(listener) {
    this.emitter.on('message', listener)
    return () => this.emitter.off('message', listener)
  }

  send(command) {
    if (!this.proc || typeof this.proc.send !== 'function') {
      throw new Error(`${this.name}:worker-not-running`)
    }
    this.proc.send(command)
  }

  async request(type, data = {}, timeoutMs = 120000) {
    const requestId = makeRequestId(`${this.name}-${type}`)
    const timeout = Math.max(1000, Math.trunc(timeoutMs))

    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${this.name}:${type}:timeout:${timeout}`))
      }, timeout)

      this.pending.set(requestId, {
        resolve,
        reject,
        timeoutId
      })

      try {
        this.send({
          type,
          requestId,
          data
        })
      } catch (error) {
        clearTimeout(timeoutId)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  async getRelays(timeoutMs = 60000) {
    this.send({ type: 'get-relays' })
    const relayUpdate = await this.waitForMessage(
      (message) => message?.type === 'relay-update' && Array.isArray(message?.relays),
      timeoutMs,
      `${this.name}:relay-update`
    )
    return Array.isArray(relayUpdate?.relays) ? relayUpdate.relays : []
  }

  async waitForMessage(predicate, timeoutMs = 60000, label = 'worker-message') {
    const timeout = Math.max(1000, Math.trunc(timeoutMs))
    return await new Promise((resolve, reject) => {
      for (let index = this.messageBacklog.length - 1; index >= 0; index -= 1) {
        const cached = this.messageBacklog[index]
        let cachedMatch = false
        try {
          cachedMatch = predicate(cached)
        } catch {
          cachedMatch = false
        }
        if (cachedMatch) {
          resolve(cached)
          return
        }
      }

      let settled = false
      const onMessage = (message) => {
        if (settled) return
        let matches = false
        try {
          matches = predicate(message)
        } catch {
          matches = false
        }
        if (!matches) return
        settled = true
        clearTimeout(timeoutId)
        this.emitter.off('message', onMessage)
        resolve(message)
      }

      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        this.emitter.off('message', onMessage)
        reject(new Error(`${this.name}:${label}:timeout:${timeout}`))
      }, timeout)

      this.emitter.on('message', onMessage)
    })
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    const proc = this.proc
    if (!proc) {
      await this.#closeLog()
      return
    }

    const waitExit = new Promise((resolve) => {
      const done = () => resolve()
      proc.once('exit', done)
      setTimeout(done, 8000).unref?.()
    })

    try {
      if (proc.connected) {
        this.send({ type: 'shutdown' })
      }
    } catch (_) {}

    await waitExit
    if (!proc.killed) {
      try {
        proc.kill('SIGTERM')
      } catch (_) {}
    }
    await this.#closeLog()
  }

  #consumeText(source, chunk) {
    const text = chunk?.toString ? chunk.toString('utf8') : String(chunk || '')
    const key = source === 'stderr' ? 'stderrBuffer' : 'stdoutBuffer'
    this[key] += text
    const parts = this[key].split(/\r?\n/)
    this[key] = parts.pop() || ''
    for (const part of parts) {
      this.#appendLog(`[${source}] ${part}`)
    }
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return
    this.messageBacklog.push(message)
    if (this.messageBacklog.length > this.maxMessageBacklog) {
      this.messageBacklog.splice(0, this.messageBacklog.length - this.maxMessageBacklog)
    }
    try {
      this.#appendLog(JSON.stringify(message))
    } catch {
      this.#appendLog('[ipc] [unserializable-message]')
    }

    if (message.type === 'worker-response' && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId)
      if (pending) {
        this.pending.delete(message.requestId)
        clearTimeout(pending.timeoutId)
        if (message.success === false) {
          pending.reject(new Error(message.error || `${this.name}:worker-request-failed`))
        } else {
          pending.resolve(message.data ?? null)
        }
      }
      return
    }

    this.emitter.emit('message', message)
  }

  #appendLog(line) {
    if (!this.logStream) return
    this.logStream.write(`${line}\n`)
  }

  #rejectPending(reason) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(`${reason}:${requestId}`))
    }
    this.pending.clear()
  }

  async #closeLog() {
    if (!this.logStream) return
    const stream = this.logStream
    this.logStream = null
    await new Promise((resolve) => stream.end(resolve))
  }
}

async function writeGatewaySettings(storageDir, gatewayBaseUrl) {
  const baseUrl = normalizeHttpOrigin(gatewayBaseUrl)
  if (!baseUrl) {
    throw new Error(`invalid-gateway-base-url:${gatewayBaseUrl}`)
  }
  const parsed = new URL(baseUrl)

  await fs.mkdir(storageDir, { recursive: true })
  await fs.writeFile(
    path.join(storageDir, 'gateway-settings.json'),
    JSON.stringify({
      gatewayUrl: baseUrl,
      proxyHost: parsed.host,
      proxyWebsocketProtocol: getWsProtocolFromHttpUrl(baseUrl)
    }, null, 2),
    'utf8'
  )
  await fs.writeFile(
    path.join(storageDir, 'public-gateway-settings.json'),
    JSON.stringify({
      enabled: true,
      selectionMode: 'manual',
      preferredBaseUrl: baseUrl,
      baseUrl,
      sharedSecret: REGISTRATION_SHARED_SECRET,
      delegateReqToPeers: false
    }, null, 2),
    'utf8'
  )
}

function buildNostrAuthEvent({
  pubkey,
  privkey,
  nonce,
  scope
}) {
  const createdAt = Math.floor(Date.now() / 1000)
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ]
  const serialized = JSON.stringify([0, pubkey, createdAt, 22242, tags, ''])
  const id = createHash('sha256').update(serialized).digest('hex')
  const messageBytes = hexToBytes(id)
  const privBytes = hexToBytes(privkey)
  if (!messageBytes || !privBytes) {
    throw new Error('invalid-auth-material')
  }
  const signature = schnorr.sign(messageBytes, privBytes)
  return {
    id,
    kind: 22242,
    pubkey,
    created_at: createdAt,
    tags,
    content: '',
    sig: toHex(signature)
  }
}

async function gatewayRequest(baseUrl, pathname, {
  method = 'GET',
  token = null,
  body = null
} = {}) {
  const headers = {}
  if (body !== null) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok) {
    const reason = payload?.error || payload?.reason || response.statusText || `status-${response.status}`
    throw new Error(`gateway-request-failed:${method}:${pathname}:${response.status}:${reason}`)
  }
  return payload
}

async function issueGatewayToken({
  baseUrl,
  pubkey,
  privkey,
  scope
}) {
  const challenge = await gatewayRequest(baseUrl, '/api/auth/challenge', {
    method: 'POST',
    body: {
      pubkey,
      scope
    }
  })
  const challengeId = challenge?.challengeId
  const nonce = challenge?.nonce
  if (!challengeId || !nonce) {
    throw new Error('gateway-challenge-invalid')
  }
  const authEvent = buildNostrAuthEvent({
    pubkey,
    privkey,
    nonce,
    scope
  })
  const verified = await gatewayRequest(baseUrl, '/api/auth/verify', {
    method: 'POST',
    body: {
      challengeId,
      authEvent
    }
  })
  if (!verified?.token) {
    throw new Error('gateway-token-missing')
  }
  return verified.token
}

async function ensureInviteAllowList({
  gateway,
  inviteePubkey,
  inviteePrivkey
}) {
  const operatorToken = await issueGatewayToken({
    baseUrl: gateway.baseUrl,
    pubkey: gateway.operatorPubkey,
    privkey: gateway.operatorPrivkey,
    scope: 'gateway:operator'
  })
  const inviteResp = await gatewayRequest(gateway.baseUrl, '/api/gateway/invites', {
    method: 'POST',
    token: operatorToken,
    body: {
      pubkey: inviteePubkey
    }
  })
  const inviteToken = inviteResp?.invite?.inviteToken
  if (!inviteToken) {
    throw new Error('invite-token-missing')
  }
  const redeemToken = await issueGatewayToken({
    baseUrl: gateway.baseUrl,
    pubkey: inviteePubkey,
    privkey: inviteePrivkey,
    scope: 'gateway:invite-redeem'
  })
  await gatewayRequest(gateway.baseUrl, '/api/gateway/invites/redeem', {
    method: 'POST',
    token: redeemToken,
    body: {
      inviteToken
    }
  })
}

async function ensureJoinRequestAllowList({
  gateway,
  requesterPubkey,
  requesterPrivkey
}) {
  const requesterToken = await issueGatewayToken({
    baseUrl: gateway.baseUrl,
    pubkey: requesterPubkey,
    privkey: requesterPrivkey,
    scope: 'gateway:join-request'
  })
  const requestCreate = await gatewayRequest(gateway.baseUrl, '/api/gateway/join-requests', {
    method: 'POST',
    token: requesterToken,
    body: {
      content: `e2e-${SCENARIO_ID}-join-request`
    }
  })
  const requestId = requestCreate?.request?.id
  if (!requestId) {
    throw new Error('join-request-id-missing')
  }
  const operatorToken = await issueGatewayToken({
    baseUrl: gateway.baseUrl,
    pubkey: gateway.operatorPubkey,
    privkey: gateway.operatorPrivkey,
    scope: 'gateway:operator'
  })
  const approved = await gatewayRequest(gateway.baseUrl, `/api/gateway/join-requests/${encodeURIComponent(requestId)}/approve`, {
    method: 'POST',
    token: operatorToken
  })
  const inviteToken = approved?.invite?.inviteToken
  if (!inviteToken) {
    throw new Error('approved-invite-token-missing')
  }
  const redeemToken = await issueGatewayToken({
    baseUrl: gateway.baseUrl,
    pubkey: requesterPubkey,
    privkey: requesterPrivkey,
    scope: 'gateway:invite-redeem'
  })
  await gatewayRequest(gateway.baseUrl, '/api/gateway/invites/redeem', {
    method: 'POST',
    token: redeemToken,
    body: {
      inviteToken
    }
  })
}

async function waitForJoinWritable(worker, {
  relayKey,
  publicIdentifier,
  timeoutMs
}) {
  const hardTimeout = Math.max(1000, timeoutMs)
  return await new Promise((resolve, reject) => {
    let settled = false
    const startedAt = nowTs()

    const cleanup = () => {
      clearTimeout(timer)
      off()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`join-writable-timeout:${hardTimeout}`))
    }, hardTimeout)

    const off = worker.onMessage((message) => {
      if (!message || typeof message !== 'object') return
      if (message.type !== 'join-telemetry') return
      const data = message.data && typeof message.data === 'object' ? message.data : null
      if (!data) return

      const matches = matchRelayIdentifier(data, relayKey, publicIdentifier)
      if (!matches) return

      process.stdout.write(`${JSON.stringify({ type: 'join-telemetry', data })}\n`)

      if (data.eventType === 'JOIN_FAIL_FAST_ABORT') {
        if (settled) return
        settled = true
        cleanup()
        const reason = data.reasonCode || 'join-fail-fast-abort'
        reject(new Error(reason))
        return
      }

      if (data.eventType === 'JOIN_WRITABLE_CONFIRMED' && data.writable === true) {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          event: data,
          elapsedMs: nowTs() - startedAt
        })
      }
    })
  })
}

async function waitForJoinFailFast(worker, {
  relayKey,
  publicIdentifier,
  timeoutMs
}) {
  const hardTimeout = Math.max(1000, timeoutMs)
  const message = await worker.waitForMessage((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (entry.type !== 'join-telemetry') return false
    const data = entry.data && typeof entry.data === 'object' ? entry.data : null
    if (!data) return false
    if (!matchRelayIdentifier(data, relayKey, publicIdentifier)) return false
    return data.eventType === 'JOIN_FAIL_FAST_ABORT'
  }, hardTimeout, 'join-fail-fast')

  const data = message?.data && typeof message.data === 'object' ? message.data : null
  if (!data) {
    throw new Error(`join-fail-fast-timeout:${hardTimeout}`)
  }
  process.stdout.write(`${JSON.stringify({ type: 'join-telemetry', data })}\n`)
  return data
}

async function waitForJoinFanout(worker, traceId, timeoutMs = 45000) {
  try {
    const message = await worker.waitForMessage((entry) => {
      if (!entry || typeof entry !== 'object') return false
      if (entry.type !== 'join-fanout-summary') return false
      if (!traceId) return true
      return entry?.data?.traceId === traceId
    }, timeoutMs, 'join-fanout-summary')
    if (message?.type === 'join-fanout-summary') {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    }
    return message
  } catch {
    return null
  }
}

async function waitForAutoConnectWritable(worker, {
  relayKey,
  publicIdentifier,
  timeoutMs
}) {
  const hardTimeout = Math.max(1000, timeoutMs)
  const startedAt = nowTs()
  const message = await worker.waitForMessage((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (entry.type !== 'autoconnect-telemetry') return false
    const data = entry.data && typeof entry.data === 'object' ? entry.data : null
    if (!data) return false
    if (!matchRelayIdentifier(data, relayKey, publicIdentifier)) return false
    return (
      data.eventType === 'AUTOCONNECT_FAIL_FAST_ABORT'
      || (data.eventType === 'AUTOCONNECT_WRITABLE_CONFIRMED' && data.writable === true)
    )
  }, hardTimeout, 'autoconnect-writable')

  const data = message?.data && typeof message.data === 'object' ? message.data : null
  if (!data) {
    throw new Error(`autoconnect-writable-timeout:${hardTimeout}`)
  }
  process.stdout.write(`${JSON.stringify({ type: 'autoconnect-telemetry', data })}\n`)
  if (data.eventType === 'AUTOCONNECT_FAIL_FAST_ABORT') {
    throw new Error(data.reasonCode || 'autoconnect-fail-fast-abort')
  }
  return {
    event: data,
    elapsedMs: nowTs() - startedAt
  }
}

async function waitForAutoConnectFanout(worker, traceId, timeoutMs = 45000) {
  try {
    const message = await worker.waitForMessage((entry) => {
      if (!entry || typeof entry !== 'object') return false
      if (entry.type !== 'autoconnect-fanout-summary') return false
      if (!traceId) return true
      return entry?.data?.traceId === traceId
    }, timeoutMs, 'autoconnect-fanout-summary')
    if (message?.type === 'autoconnect-fanout-summary') {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    }
    return message
  } catch {
    return null
  }
}

async function collectRelayViewLengths(worker, relayKey, publicIdentifier) {
  try {
    const relays = await worker.getRelays(45000)
    const joinedRelay = relays.find((entry) => (
      (typeof entry?.relayKey === 'string' && entry.relayKey.toLowerCase() === relayKey.toLowerCase())
      || (typeof entry?.publicIdentifier === 'string' && entry.publicIdentifier === publicIdentifier)
    ))
    if (!joinedRelay || typeof joinedRelay !== 'object') return null
    const viewLength = Number.isFinite(joinedRelay?.viewLength) ? Number(joinedRelay.viewLength) : null
    const expectedViewLength = Number.isFinite(joinedRelay?.expectedViewLength)
      ? Number(joinedRelay.expectedViewLength)
      : null
    const localLength = Number.isFinite(joinedRelay?.localLength) ? Number(joinedRelay.localLength) : null
    return {
      viewLength,
      expectedViewLength,
      localLength
    }
  } catch (_) {
    return null
  }
}

async function setupScenarioPreconditions(scenario) {
  if (scenario?.id === 'S17') {
    await ensureInviteAllowList({
      gateway: GATEWAYS.gateway1,
      inviteePubkey: WORKER_A_PUBKEY,
      inviteePrivkey: WORKER_A_PRIVKEY
    })
  } else if (scenario?.id === 'S18') {
    await ensureJoinRequestAllowList({
      gateway: GATEWAYS.gateway1,
      requesterPubkey: WORKER_A_PUBKEY,
      requesterPrivkey: WORKER_A_PRIVKEY
    })
  }
}

async function runScenario() {
  const scenarioName = baseNameForScenario(SCENARIO_ID)
  const createGatewayName = chooseCreateGatewayName(SCENARIO)
  const createGateway = GATEWAYS[createGatewayName]
  const joinOrigins = SCENARIO?.id === 'S19' ? [] : gatewayOrderForJoin()
  const shouldPreseedWriterMaterial = !['S19', 'S20', 'S21', 'S22'].includes(SCENARIO?.id)
  const requiresLeaseProvision = ['S20', 'S22'].includes(SCENARIO?.id)
  const expectJoinFailure = SCENARIO?.id === 'S21'

  const workerAStorage = path.join(SCENARIO_DIR, 'workerA-data')
  const workerBStorage = path.join(SCENARIO_DIR, 'workerB-data')
  const workerALog = path.join(SCENARIO_DIR, 'workerA.log')
  const workerBLog = path.join(SCENARIO_DIR, 'workerB.log')
  const workerBRestartLog = path.join(SCENARIO_DIR, 'workerB-restart.log')

  await writeGatewaySettings(workerAStorage, createGateway.baseUrl)
  await writeGatewaySettings(workerBStorage, createGateway.baseUrl)

  const workerA = new WorkerClient({
    name: 'workerA',
    workerRoot: WORKER_ROOT,
    storageDir: workerAStorage,
    userKey: 'e2e-worker-a',
    pubkeyHex: WORKER_A_PUBKEY,
    nsecHex: WORKER_A_PRIVKEY,
    logFile: workerALog,
    scenarioTimeoutMs: SCENARIO_TIMEOUT_MS
  })
  const workerB = new WorkerClient({
    name: 'workerB',
    workerRoot: WORKER_ROOT,
    storageDir: workerBStorage,
    userKey: 'e2e-worker-b',
    pubkeyHex: WORKER_B_PUBKEY,
    nsecHex: WORKER_B_PRIVKEY,
    logFile: workerBLog,
    scenarioTimeoutMs: SCENARIO_TIMEOUT_MS
  })

  const summary = {
    scenarioId: SCENARIO_ID,
    workerLogs: [workerALog, workerBLog, workerBRestartLog],
    observedViewLength: null,
    expectedViewLength: null,
    autoConnectObservedViewLength: null,
    autoConnectExpectedViewLength: null,
    joinExpectedFailure: expectJoinFailure,
    joinFailFastReason: null
  }

  let workerBRestart = null

  try {
    await workerA.start()
    await workerB.start()

    await setupScenarioPreconditions(SCENARIO)

    const createResult = await workerA.request('create-relay', {
      name: `${scenarioName}-group`,
      description: `multi-gateway ${SCENARIO_ID}`,
      isPublic: true,
      isOpen: SCENARIO?.groupType === 'OPEN',
      fileSharing: true
    }, 240000)

    const relayKey = typeof createResult?.relayKey === 'string' ? createResult.relayKey : null
    const publicIdentifier =
      typeof createResult?.publicIdentifier === 'string' && createResult.publicIdentifier.trim()
        ? createResult.publicIdentifier.trim()
        : relayKey

    if (!relayKey || !publicIdentifier) {
      throw new Error('create-relay-missing-identifiers')
    }

    const inviteToken = `invite-${SCENARIO_ID.toLowerCase()}-${randomBytes(16).toString('hex')}`
    if (SCENARIO?.groupType !== 'OPEN') {
      workerA.send({
        type: 'update-auth-data',
        data: {
          relayKey,
          publicIdentifier,
          pubkey: WORKER_B_PUBKEY,
          token: inviteToken
        }
      })
      await sleep(1200)
    }

    let provisionResult = null
    if (SCENARIO?.groupType === 'OPEN') {
      if (shouldPreseedWriterMaterial) {
        provisionResult = await workerA.request('provision-writer-for-invitee', {
          relayKey,
          publicIdentifier,
          inviteePubkey: WORKER_B_PUBKEY,
          useWriterPool: true
        }, 180000)
      }
    } else if (requiresLeaseProvision || shouldPreseedWriterMaterial) {
      provisionResult = await workerA.request('provision-writer-for-invitee', {
        relayKey,
        publicIdentifier,
        inviteePubkey: WORKER_B_PUBKEY,
        inviteToken,
        useWriterPool: shouldPreseedWriterMaterial
      }, 180000)
    }

    const joinPayload = {
      publicIdentifier,
      relayKey,
      fileSharing: true,
      isOpen: SCENARIO?.groupType === 'OPEN',
      openJoin: SCENARIO?.groupType === 'OPEN',
      gatewayOrigins: joinOrigins,
      writerCore: shouldPreseedWriterMaterial ? (provisionResult?.writerCore || null) : null,
      writerCoreHex: shouldPreseedWriterMaterial ? (provisionResult?.writerCoreHex || null) : null,
      autobaseLocal: shouldPreseedWriterMaterial ? (provisionResult?.autobaseLocal || null) : null,
      writerSecret: shouldPreseedWriterMaterial ? (provisionResult?.writerSecret || null) : null,
      fastForward: shouldPreseedWriterMaterial ? (provisionResult?.fastForward || null) : null
    }

    if (SCENARIO?.groupType !== 'OPEN') {
      joinPayload.token = inviteToken
    }

    workerB.send({
      type: 'start-join-flow',
      data: joinPayload
    })

    if (expectJoinFailure) {
      const failFastEvent = await waitForJoinFailFast(workerB, {
        relayKey,
        publicIdentifier,
        timeoutMs: GATES.joinToWritableMs + 5000
      })
      summary.joinFailFastReason = typeof failFastEvent?.reasonCode === 'string'
        ? failFastEvent.reasonCode
        : 'join-fail-fast-abort'
      const failTraceId =
        typeof failFastEvent?.traceId === 'string' && failFastEvent.traceId.trim()
          ? failFastEvent.traceId.trim()
          : null
      await waitForJoinFanout(workerB, failTraceId, 15000)
      return summary
    }

    const joinResult = await waitForJoinWritable(workerB, {
      relayKey,
      publicIdentifier,
      timeoutMs: GATES.joinToWritableMs + 5000
    })

    const writableMetrics = extractWritableMetricsFromTelemetry(joinResult?.event)
    summary.observedViewLength = writableMetrics.observedViewLength
    summary.expectedViewLength = writableMetrics.expectedViewLength

    const traceId = typeof joinResult?.event?.traceId === 'string' ? joinResult.event.traceId : null
    await waitForJoinFanout(workerB, traceId, 60000)

    const joinedRelayLens = await collectRelayViewLengths(workerB, relayKey, publicIdentifier)
    if (joinedRelayLens) {
      if (summary.observedViewLength == null && joinedRelayLens.viewLength != null) {
        summary.observedViewLength = joinedRelayLens.viewLength
      }
      if (summary.observedViewLength == null && joinedRelayLens.localLength != null) {
        summary.observedViewLength = joinedRelayLens.localLength
      }
      if (summary.expectedViewLength == null && joinedRelayLens.expectedViewLength != null) {
        summary.expectedViewLength = joinedRelayLens.expectedViewLength
      }
      if (summary.expectedViewLength == null && joinedRelayLens.viewLength != null) {
        summary.expectedViewLength = joinedRelayLens.viewLength
      }
      if (summary.expectedViewLength == null && joinedRelayLens.localLength != null) {
        summary.expectedViewLength = joinedRelayLens.localLength
      }
    }

    await workerB.stop()

    workerBRestart = new WorkerClient({
      name: 'workerB-restart',
      workerRoot: WORKER_ROOT,
      storageDir: workerBStorage,
      userKey: 'e2e-worker-b',
      pubkeyHex: WORKER_B_PUBKEY,
      nsecHex: WORKER_B_PRIVKEY,
      logFile: workerBRestartLog,
      scenarioTimeoutMs: SCENARIO_TIMEOUT_MS
    })
    await workerBRestart.start()

    const autoConnectResult = await waitForAutoConnectWritable(workerBRestart, {
      relayKey,
      publicIdentifier,
      timeoutMs: GATES.joinToWritableMs + 5000
    })
    const autoConnectMetrics = extractWritableMetricsFromTelemetry(autoConnectResult?.event)
    summary.autoConnectObservedViewLength = autoConnectMetrics.observedViewLength
    summary.autoConnectExpectedViewLength = autoConnectMetrics.expectedViewLength

    const autoConnectTraceId =
      typeof autoConnectResult?.event?.traceId === 'string'
        ? autoConnectResult.event.traceId
        : null
    await waitForAutoConnectFanout(workerBRestart, autoConnectTraceId, 60000)

    const autoConnectRelayLens = await collectRelayViewLengths(workerBRestart, relayKey, publicIdentifier)
    if (autoConnectRelayLens) {
      if (summary.autoConnectObservedViewLength == null && autoConnectRelayLens.viewLength != null) {
        summary.autoConnectObservedViewLength = autoConnectRelayLens.viewLength
      }
      if (summary.autoConnectObservedViewLength == null && autoConnectRelayLens.localLength != null) {
        summary.autoConnectObservedViewLength = autoConnectRelayLens.localLength
      }
      if (summary.autoConnectExpectedViewLength == null && autoConnectRelayLens.expectedViewLength != null) {
        summary.autoConnectExpectedViewLength = autoConnectRelayLens.expectedViewLength
      }
      if (summary.autoConnectExpectedViewLength == null && autoConnectRelayLens.viewLength != null) {
        summary.autoConnectExpectedViewLength = autoConnectRelayLens.viewLength
      }
      if (summary.autoConnectExpectedViewLength == null && autoConnectRelayLens.localLength != null) {
        summary.autoConnectExpectedViewLength = autoConnectRelayLens.localLength
      }
    }

    return summary
  } finally {
    await Promise.allSettled([
      workerA.stop(),
      workerB.stop(),
      workerBRestart?.stop()
    ])
  }
}

async function main() {
  let summary = {
    scenarioId: SCENARIO_ID,
    workerLogs: [
      path.join(SCENARIO_DIR, 'workerA.log'),
      path.join(SCENARIO_DIR, 'workerB.log')
    ],
    observedViewLength: null,
    expectedViewLength: null,
    autoConnectObservedViewLength: null,
    autoConnectExpectedViewLength: null
  }

  let failed = false
  let errorMessage = null

  try {
    summary = await runScenario()
  } catch (error) {
    failed = true
    errorMessage = error?.message || String(error)
    console.error('[executor-real] scenario failed', {
      scenarioId: SCENARIO_ID,
      error: errorMessage
    })
  } finally {
    process.stdout.write(`HT_SCENARIO_SUMMARY=${JSON.stringify(summary)}\n`)
  }

  if (failed) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[executor-real] fatal', error?.message || error)
  process.exitCode = 1
})
