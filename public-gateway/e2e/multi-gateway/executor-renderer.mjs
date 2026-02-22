#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { schnorr } from '@noble/curves/secp256k1'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '../../..')
const DESKTOP_ROOT = path.resolve(ROOT_DIR, 'hypertuna-desktop')

const require = createRequire(import.meta.url)
const playwrightPath = path.resolve(ROOT_DIR, 'indiepress-dev/node_modules/playwright')
let _electron = null
let playwrightLoadError = null
try {
  ({ _electron } = require(playwrightPath))
} catch (error) {
  playwrightLoadError = error
}
const ELECTRON_EXECUTABLE_PATH = resolveElectronExecutablePath()

const SCENARIO_ID = process.env.HT_SCENARIO_ID || 'S00'
const SCENARIO_DIR = path.resolve(process.env.HT_SCENARIO_DIR || process.cwd())
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
    mode: normalizeGatewayMode(process.env.HT_GW1_MODE || 'local'),
    baseUrl: process.env.HT_GW1_BASE_URL || 'http://127.0.0.1:4541',
    operatorPubkey:
      process.env.HT_GW1_OPERATOR_PUBKEY
      || '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  },
  gateway2: {
    mode: normalizeGatewayMode(process.env.HT_GW2_MODE || 'local'),
    baseUrl: process.env.HT_GW2_BASE_URL || 'http://127.0.0.1:4542',
    operatorPubkey:
      process.env.HT_GW2_OPERATOR_PUBKEY
      || '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
  }
}

const RENDERER_URL_OVERRIDE = resolveRendererUrl(
  process.env.HT_MATRIX_RENDERER_URL
  || process.env.RENDERER_URL
  || null
)
const REUSE_RENDERER_RUNTIME = String(process.env.HT_MATRIX_REUSE_RENDERER || '').trim() === '1'

const WORKER_A_PRIVKEY =
  normalizeHexKey(process.env.HT_MULTI_GATEWAY_WORKER_A_PRIVKEY)
  || '3333333333333333333333333333333333333333333333333333333333333333'
const WORKER_B_PRIVKEY =
  normalizeHexKey(process.env.HT_MULTI_GATEWAY_WORKER_B_PRIVKEY)
  || '4444444444444444444444444444444444444444444444444444444444444444'
const WORKER_C_PRIVKEY =
  normalizeHexKey(process.env.HT_MULTI_GATEWAY_WORKER_C_PRIVKEY)
  || '5555555555555555555555555555555555555555555555555555555555555555'

const WORKER_A_PUBKEY = derivePubkey(WORKER_A_PRIVKEY)
const WORKER_B_PUBKEY = derivePubkey(WORKER_B_PRIVKEY)
const WORKER_C_PUBKEY = derivePubkey(WORKER_C_PRIVKEY)

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

function normalizeGatewayMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'remote' || normalized === 'disabled') return normalized
  return 'local'
}

function resolveElectronExecutablePath() {
  if (typeof process.env.HT_ELECTRON_EXECUTABLE_PATH === 'string' && process.env.HT_ELECTRON_EXECUTABLE_PATH.trim()) {
    return process.env.HT_ELECTRON_EXECUTABLE_PATH.trim()
  }
  const modulePath = path.resolve(ROOT_DIR, 'hypertuna-desktop/node_modules/electron')
  try {
    const loaded = require(modulePath)
    if (typeof loaded === 'string' && loaded.trim()) return loaded.trim()
    if (loaded && typeof loaded.default === 'string' && loaded.default.trim()) return loaded.default.trim()
  } catch (_) {
    // fall through to undefined; Playwright will report a clear error.
  }
  return undefined
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 !== 0 || /[^a-f0-9]/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function derivePubkey(privkeyHex) {
  const privBytes = hexToBytes(privkeyHex)
  if (!privBytes) throw new Error('invalid-private-key')
  return toHex(schnorr.getPublicKey(privBytes))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label}-timeout:${timeoutMs}`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function nowTs() {
  return Date.now()
}

function randomToken(prefix = 'token') {
  return `${prefix}-${randomBytes(16).toString('hex')}`
}

function normalizeHttpOrigin(value) {
  if (!value || typeof value !== 'string') return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    return parsed.origin
  } catch {
    return null
  }
}

function getWsProtocolFromHttpUrl(httpUrl) {
  const origin = normalizeHttpOrigin(httpUrl)
  if (!origin) return 'wss'
  return origin.startsWith('http://') ? 'ws' : 'wss'
}

function withMatrixQuery(url) {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('htMatrixE2E', '1')
    return parsed.toString()
  } catch {
    if (url.includes('?')) return `${url}&htMatrixE2E=1`
    return `${url}?htMatrixE2E=1`
  }
}

function resolveRendererUrl(overrideUrl) {
  if (typeof overrideUrl !== 'string' || !overrideUrl.trim()) return null
  return withMatrixQuery(overrideUrl.trim())
}

function isGatewayEnabled(gatewayName) {
  const gateway = GATEWAYS[gatewayName]
  return !!gateway && gateway.mode !== 'disabled'
}

function firstEnabledGatewayName() {
  if (isGatewayEnabled('gateway1')) return 'gateway1'
  if (isGatewayEnabled('gateway2')) return 'gateway2'
  return 'gateway1'
}

function gatewayOrderForJoin() {
  return ['gateway1', 'gateway2']
    .filter((name) => isGatewayEnabled(name))
    .map((name) => normalizeHttpOrigin(GATEWAYS[name].baseUrl))
    .filter(Boolean)
}

function chooseCreateGatewayName(scenario) {
  const preferred = (() => {
    if (scenario?.id === 'S09' || scenario?.id === 'S10') return 'gateway2'
    if (scenario?.id === 'S11' || scenario?.id === 'S12') return 'gateway2'
    if (scenario?.id === 'S13' || scenario?.id === 'S14') return 'gateway2'
    if (scenario?.id === 'S15') return 'gateway2'
    if (scenario?.id === 'S16') return 'gateway1'
    if (scenario?.id === 'S17' || scenario?.id === 'S18') return 'gateway1'
    if (scenario?.gateway1 === 'OPEN') return 'gateway1'
    if (scenario?.gateway2 === 'OPEN') return 'gateway2'
    return 'gateway1'
  })()

  if (isGatewayEnabled(preferred)) return preferred
  return firstEnabledGatewayName()
}

function gatewayDescriptorsForCreate(scenario) {
  if (scenario?.id === 'S19') return []
  const descriptors = []
  if (isGatewayEnabled('gateway1')) {
    const origin = normalizeHttpOrigin(GATEWAYS.gateway1.baseUrl)
    if (origin) {
      descriptors.push({
        origin,
        operatorPubkey: GATEWAYS.gateway1.operatorPubkey,
        policy: scenario?.gateway1 === 'CLOSED' ? 'CLOSED' : 'OPEN'
      })
    }
  }
  if (isGatewayEnabled('gateway2')) {
    const origin = normalizeHttpOrigin(GATEWAYS.gateway2.baseUrl)
    if (origin) {
      descriptors.push({
        origin,
        operatorPubkey: GATEWAYS.gateway2.operatorPubkey,
        policy: scenario?.gateway2 === 'CLOSED' ? 'CLOSED' : 'OPEN'
      })
    }
  }
  return descriptors
}

async function writeGatewaySettings(userDataDir, gatewayBaseUrl) {
  const baseUrl = normalizeHttpOrigin(gatewayBaseUrl)
  if (!baseUrl) throw new Error(`invalid-gateway-base-url:${gatewayBaseUrl}`)
  const parsed = new URL(baseUrl)
  const storageDir = path.join(userDataDir, 'hypertuna-data')

  await fs.mkdir(storageDir, { recursive: true })
  await fs.writeFile(
    path.join(storageDir, 'gateway-settings.json'),
    JSON.stringify(
      {
        gatewayUrl: baseUrl,
        proxyHost: parsed.host,
        proxyWebsocketProtocol: getWsProtocolFromHttpUrl(baseUrl)
      },
      null,
      2
    ),
    'utf8'
  )
  await fs.writeFile(
    path.join(storageDir, 'public-gateway-settings.json'),
    JSON.stringify(
      {
        enabled: true,
        selectionMode: 'manual',
        preferredBaseUrl: baseUrl,
        baseUrl,
        delegateReqToPeers: false
      },
      null,
      2
    ),
    'utf8'
  )
}

function extractWritableMetricsFromRelay(relay) {
  if (!relay || typeof relay !== 'object') {
    return {
      observedViewLength: null,
      expectedViewLength: null
    }
  }
  const viewLength = Number.isFinite(relay?.viewLength) ? Number(relay.viewLength) : null
  const expectedViewLength = Number.isFinite(relay?.expectedViewLength)
    ? Number(relay.expectedViewLength)
    : null
  const localLength = Number.isFinite(relay?.localLength) ? Number(relay.localLength) : null
  const normalizedExpected =
    expectedViewLength !== null && expectedViewLength > 0
      ? expectedViewLength
      : (viewLength ?? localLength ?? expectedViewLength)
  return {
    observedViewLength: viewLength ?? localLength,
    expectedViewLength: normalizedExpected
  }
}

function selectRelayLikeFromWritableResult(result) {
  if (!result || typeof result !== 'object') return null
  if (result?.relay && typeof result.relay === 'object') return result.relay
  if (result?.flow && typeof result.flow === 'object') return result.flow
  if (result?.telemetry?.meta && typeof result.telemetry.meta === 'object') return result.telemetry.meta
  return null
}

function logScenarioStage(stage, data = null) {
  if (data && typeof data === 'object') {
    process.stdout.write(`[executor-renderer][stage] ${stage} ${JSON.stringify(data)}\n`)
    return
  }
  process.stdout.write(`[executor-renderer][stage] ${stage}\n`)
}

async function isRendererReachable(url) {
  if (!url) return false
  try {
    const response = await fetch(url)
    return response.ok || response.status < 500
  } catch {
    return false
  }
}

async function waitForRenderer(url, timeoutMs = 120000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRendererReachable(url)) return true
    await sleep(750)
  }
  return false
}

async function canListenOnPort(port) {
  return await new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.on('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function pickAvailablePort(startPort = 5173, attempts = 50) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = startPort + offset
    if (await canListenOnPort(candidate)) return candidate
  }
  throw new Error(`renderer-port-unavailable:${startPort}`)
}

async function ensureRendererRuntime(scenarioDir) {
  if (RENDERER_URL_OVERRIDE) {
    return {
      url: RENDERER_URL_OVERRIDE,
      stop: async () => {}
    }
  }

  const preferredPort = Number.parseInt(process.env.HT_MATRIX_RENDERER_PORT || '5173', 10)
  const baseUrlOverride = process.env.HT_MATRIX_RENDERER_BASE_URL || ''
  if (REUSE_RENDERER_RUNTIME && baseUrlOverride && await isRendererReachable(baseUrlOverride)) {
    return {
      url: withMatrixQuery(baseUrlOverride),
      stop: async () => {}
    }
  }

  const port = await pickAvailablePort(Number.isFinite(preferredPort) ? preferredPort : 5173)
  const baseUrl = `http://127.0.0.1:${port}`
  const targetUrl = withMatrixQuery(baseUrl)

  const logPath = path.join(scenarioDir, 'renderer-dev-server.log')
  await fs.writeFile(logPath, '', 'utf8')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(
    'npm',
    ['run', 'dev:web', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
    cwd: path.resolve(ROOT_DIR, 'indiepress-dev'),
    env: {
      ...process.env,
      BROWSER: 'none'
    },
    stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.on('exit', (code, signal) => {
    logStream.write(`[renderer-dev-server] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
  })

  child.stdout?.on('data', (chunk) => {
    logStream.write(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    logStream.write(chunk)
  })

  const ready = await waitForRenderer(baseUrl, 150000)
  if (!ready) {
    try {
      child.kill('SIGTERM')
    } catch (_) {}
    await new Promise((resolve) => logStream.end(resolve))
    throw new Error(`renderer-dev-server-timeout:${baseUrl}`)
  }

  const stop = async () => {
    let exited = false
    const waitForExit = new Promise((resolve) => {
      child.once('exit', () => {
        exited = true
        resolve()
      })
    })
    try {
      child.kill('SIGTERM')
    } catch (_) {}
    await Promise.race([waitForExit, sleep(3000)])
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch (_) {}
      await Promise.race([waitForExit, sleep(2000)])
    }
    await new Promise((resolve) => logStream.end(resolve))
  }

  return {
    url: targetUrl,
    stop
  }
}

class RendererPeer {
  constructor({
    name,
    userDataDir,
    nsecHex,
    pubkeyHex,
    workerLogPath,
    rendererLogPath,
    emitTelemetryToStdout = false
  }) {
    this.name = name
    this.userDataDir = userDataDir
    this.nsecHex = nsecHex
    this.pubkeyHex = pubkeyHex
    this.workerLogPath = workerLogPath
    this.rendererLogPath = rendererLogPath
    this.emitTelemetryToStdout = emitTelemetryToStdout
    this.app = null
    this.page = null
    this.workerLog = null
    this.rendererLog = null
    this.stdoutCarry = ''
    this.stderrCarry = ''
    this.telemetryEvents = []
  }

  async start(gatewayBaseUrl, rendererUrl) {
    await fs.mkdir(path.dirname(this.workerLogPath), { recursive: true })
    await fs.writeFile(this.workerLogPath, '', 'utf8')
    await fs.writeFile(this.rendererLogPath, '', 'utf8')
    await writeGatewaySettings(this.userDataDir, gatewayBaseUrl)

    this.workerLog = createWriteStream(this.workerLogPath, { flags: 'a' })
    this.rendererLog = createWriteStream(this.rendererLogPath, { flags: 'a' })

    this.app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE_PATH,
      args: [DESKTOP_ROOT],
      timeout: 120000,
      env: {
        ...process.env,
        HYPERTUNA_USER_DATA_DIR: this.userDataDir,
        ...(rendererUrl ? { RENDERER_URL: rendererUrl } : {}),
        HYPERTUNA_RENDERER_QUERY: 'htMatrixE2E=1',
        HT_DEBUG_MULTI_GATEWAY: '1',
        NODE_ENV: process.env.NODE_ENV || 'development'
      }
    })
    this.page = await this.#waitForBridgePage(150000)
    this.page.setDefaultTimeout(120000)
    this.page.setDefaultNavigationTimeout(120000)
    this.page.on('console', (msg) => this.#onConsole(msg))
    this.page.on('pageerror', (err) => {
      this.#appendRendererLog(`[pageerror] ${err?.message || String(err)}`)
    })

    const isRestartPeer = this.name.includes('restart')
    try {
      await this.callBridge('loginWithNsec', { nsec: this.nsecHex }, 60000)
    } catch (error) {
      if (!isRestartPeer) throw error
      // Restarted peers often have a persisted session already; probe bridge liveness and continue.
      await this.callBridge('getRelays', null, 10000)
    }

    try {
      await withTimeout(
        this.page.evaluate(() => {
          const bridge = window.__HT_MATRIX_E2E__
          if (!bridge || typeof bridge.subscribeLogs !== 'function') {
            throw new Error('matrix-bridge-unavailable')
          }
          bridge.subscribeLogs(
            (entry) => {
              try {
                console.log(`HT_MATRIX_LOG=${JSON.stringify(entry)}`)
              } catch (_err) {}
            },
            { replay: 400 }
          )
        }),
        10000,
        `${this.name}:subscribe-logs`
      )
    } catch (_) {
      if (!isRestartPeer) throw _
    }
  }

  async #waitForBridgePage(timeoutMs = 150000) {
    if (!this.app) throw new Error(`${this.name}:electron-app-not-ready`)
    const startedAt = nowTs()
    let lastError = null

    while (nowTs() - startedAt < timeoutMs) {
      const windows = this.app.windows()
      for (const candidate of windows) {
        if (!candidate || candidate.isClosed()) continue
        try {
          await candidate.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {})
          const hasBridge = await candidate.evaluate(() => Boolean(window.__HT_MATRIX_E2E__))
          if (hasBridge) return candidate
        } catch (error) {
          lastError = error
        }
      }

      try {
        const candidate = await this.app.waitForEvent('window', { timeout: 3000 })
        if (candidate && !candidate.isClosed()) {
          await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
          const hasBridge = await candidate.evaluate(() => Boolean(window.__HT_MATRIX_E2E__))
          if (hasBridge) return candidate
        }
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('timeout')) {
          lastError = error
        }
      }

      await sleep(250)
    }

    throw new Error(`bridge-page-timeout:${lastError?.message || 'window-with-matrix-bridge-not-found'}`)
  }

  async stop() {
    if (this.app) {
      const app = this.app
      const closePromise = (async () => {
        try {
          await app.close()
        } catch (_) {}
      })()
      await Promise.race([closePromise, sleep(10000)])
      try {
        const proc = app.process?.()
        if (proc && !proc.killed) {
          proc.kill('SIGKILL')
        }
      } catch (_) {}
      this.app = null
      this.page = null
    }
    this.#flushTextCarry()
    await this.#closeLogs()
  }

  async callBridge(method, args = null, timeoutMs = 120000) {
    const invoke = async () => {
      if (!this.page) throw new Error(`${this.name}:page-not-ready`)
      return await withTimeout(
        this.page.evaluate(
          async ({ method, args }) => {
            const bridge = window.__HT_MATRIX_E2E__
            if (!bridge || typeof bridge[method] !== 'function') {
              throw new Error(`bridge-method-unavailable:${method}`)
            }
            return await bridge[method](args)
          },
          { method, args }
        ),
        Math.max(1000, Number(timeoutMs) || 120000),
        `${this.name}:bridge:${method}`
      )
    }

    let lastError = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await invoke()
      } catch (error) {
        lastError = error
        const message = String(error?.message || '')
        const contextDestroyed =
          message.includes('Execution context was destroyed')
          || message.includes('Target page, context or browser has been closed')
        if (!contextDestroyed || attempt >= 3) {
          throw error
        }
        this.page = await this.#waitForBridgePage(60000)
        this.page.setDefaultTimeout(120000)
        this.page.setDefaultNavigationTimeout(120000)
        await sleep(200 * attempt)
      }
    }
    throw lastError || new Error(`${this.name}:bridge:${method}:unknown-error`)
  }

  async sendWorkerMessage(type, data = {}) {
    return await this.callBridge('sendWorkerMessage', { type, data })
  }

  async sendWorkerAwait(type, data = {}, timeoutMs = 120000) {
    if (!this.page) throw new Error(`${this.name}:page-not-ready`)
    return await this.page.evaluate(
      async ({ message, timeoutMs }) => {
        const bridge = window.__HT_MATRIX_E2E__
        if (!bridge || typeof bridge.sendWorkerAwait !== 'function') {
          throw new Error('bridge-sendWorkerAwait-unavailable')
        }
        return await bridge.sendWorkerAwait(message, timeoutMs)
      },
      {
        message: { type, data },
        timeoutMs
      }
    )
  }

  async getRelays() {
    return await this.callBridge('getRelays', null, 8000)
  }

  async waitForJoinWritable(args) {
    const timeoutMs = Math.max(
      30000,
      Number(args?.timeoutMs) || 120000
    ) + 15000
    return await this.callBridge('waitForJoinWritable', args, timeoutMs)
  }

  async waitForAutoConnectWritable(args) {
    const timeoutMs = Math.max(
      30000,
      Number(args?.timeoutMs) || 120000
    ) + 15000
    return await this.callBridge('waitForAutoConnectWritable', args, timeoutMs)
  }

  #onConsole(msg) {
    const text = msg.text()
    if (typeof text === 'string' && text.startsWith('HT_MATRIX_LOG=')) {
      const payload = text.slice('HT_MATRIX_LOG='.length)
      try {
        const parsed = JSON.parse(payload)
        this.#consumeBridgeLog(parsed)
      } catch (error) {
        this.#appendRendererLog(`[bridge-log-parse-error] ${error?.message || String(error)}`)
      }
      return
    }
    this.#appendRendererLog(`[console:${msg.type()}] ${text}`)
  }

  #consumeBridgeLog(entry) {
    const channel = typeof entry?.channel === 'string' ? entry.channel : 'unknown'
    const data = entry?.data
    if (channel === 'worker-stdout') {
      this.#consumeTextChunk('stdout', String(data ?? ''))
      return
    }
    if (channel === 'worker-stderr') {
      this.#consumeTextChunk('stderr', String(data ?? ''))
      return
    }
    if (channel === 'worker-message') {
      const line = JSON.stringify(data)
      this.#appendWorkerLog(line)
      if (
        data
        && typeof data === 'object'
        && (data.type === 'join-telemetry' || data.type === 'autoconnect-telemetry')
        && data.data
        && typeof data.data === 'object'
      ) {
        this.#recordTelemetryEvent(data.data)
      }
      if (
        this.emitTelemetryToStdout
        && data
        && typeof data === 'object'
        && (
          data.type === 'join-telemetry'
          || data.type === 'join-fanout-summary'
          || data.type === 'autoconnect-telemetry'
          || data.type === 'autoconnect-fanout-summary'
        )
      ) {
        process.stdout.write(`${line}\n`)
      }
      return
    }
    this.#appendRendererLog(`[bridge:${channel}] ${JSON.stringify(data)}`)
  }

  #consumeTextChunk(kind, chunk) {
    const key = kind === 'stderr' ? 'stderrCarry' : 'stdoutCarry'
    const prefix = kind === 'stderr' ? '[stderr] ' : ''
    const input = `${this[key]}${chunk}`
    const parts = input.split(/\r?\n/)
    this[key] = parts.pop() || ''
    for (const line of parts) {
      this.#appendWorkerLog(`${prefix}${line}`)
    }
  }

  #flushTextCarry() {
    if (this.stdoutCarry) {
      this.#appendWorkerLog(this.stdoutCarry)
      this.stdoutCarry = ''
    }
    if (this.stderrCarry) {
      this.#appendWorkerLog(`[stderr] ${this.stderrCarry}`)
      this.stderrCarry = ''
    }
  }

  #appendWorkerLog(line) {
    if (!this.workerLog) return
    this.workerLog.write(`${line}\n`)
  }

  #appendRendererLog(line) {
    if (!this.rendererLog) return
    this.rendererLog.write(`${line}\n`)
  }

  async #closeLogs() {
    const close = async (stream) => {
      if (!stream) return
      await new Promise((resolve) => stream.end(resolve))
    }
    const workerLog = this.workerLog
    const rendererLog = this.rendererLog
    this.workerLog = null
    this.rendererLog = null
    await Promise.allSettled([close(workerLog), close(rendererLog)])
  }

  #recordTelemetryEvent(event) {
    const next = [...this.telemetryEvents, event]
    this.telemetryEvents = next.length > 2000 ? next.slice(next.length - 2000) : next
  }

  findTelemetryEvent(eventType, { publicIdentifier = null, relayKey = null } = {}) {
    if (!eventType || typeof eventType !== 'string') return null
    for (let index = this.telemetryEvents.length - 1; index >= 0; index -= 1) {
      const event = this.telemetryEvents[index]
      if (!event || typeof event !== 'object') continue
      if (event.eventType !== eventType) continue
      if (publicIdentifier && event.publicIdentifier !== publicIdentifier) continue
      if (relayKey && event.relayKey !== relayKey) continue
      return event
    }
    return null
  }

  async waitForTelemetryEvent(eventType, {
    publicIdentifier = null,
    relayKey = null,
    timeoutMs = 120000,
    intervalMs = 200
  } = {}) {
    const startedAt = nowTs()
    while (nowTs() - startedAt < timeoutMs) {
      const matched = this.findTelemetryEvent(eventType, { publicIdentifier, relayKey })
      if (matched) {
        return {
          source: 'telemetry',
          telemetry: matched
        }
      }
      await sleep(intervalMs)
    }
    throw new Error(`${this.name}:telemetry-timeout:${eventType}`)
  }
}

async function waitForRelayEntry(peer, { relayKey = null, publicIdentifier = null }, timeoutMs = 120000) {
  const startedAt = nowTs()
  let lastError = null
  while (nowTs() - startedAt < timeoutMs) {
    let relays = []
    try {
      relays = await peer.getRelays()
      lastError = null
    } catch (error) {
      lastError = error
      await sleep(750)
      continue
    }
    const matched = (Array.isArray(relays) ? relays : []).find((entry) => {
      if (relayKey && typeof entry?.relayKey === 'string' && entry.relayKey === relayKey) return true
      if (publicIdentifier && typeof entry?.publicIdentifier === 'string' && entry.publicIdentifier === publicIdentifier) return true
      return false
    })
    if (matched) return matched
    await sleep(750)
  }
  const suffix = lastError?.message ? `:${lastError.message}` : ''
  throw new Error(`relay-entry-timeout:${publicIdentifier || relayKey || 'unknown'}${suffix}`)
}

function normalizeRelayUrlCandidate(candidate) {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return trimmed || null
}

function selectRelayUrlsFromWritableResult(result, fallback = null) {
  const candidates = [
    result?.relay?.localConnectionUrl,
    result?.relay?.connectionUrl,
    result?.relay?.gatewayConnectionUrl,
    result?.flow?.relayUrl,
    result?.flow?.localConnectionUrl,
    result?.relay?.relayUrl,
    result?.flow?.connectionUrl,
    result?.flow?.gatewayConnectionUrl,
    result?.relayUrl,
    fallback
  ]
  const seen = new Set()
  const urls = []
  for (const candidate of candidates) {
    const normalized = normalizeRelayUrlCandidate(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }
  return urls
}

function selectRelayUrlFromWritableResult(result, fallback = null) {
  const urls = selectRelayUrlsFromWritableResult(result, fallback)
  return urls.length ? urls[0] : null
}

function selectRelayUrlsFromRelayEntry(entry) {
  if (!entry || typeof entry !== 'object') return []
  const candidates = [
    entry.localConnectionUrl,
    entry.connectionUrl,
    entry.relayUrl,
    entry.gatewayConnectionUrl
  ]
  const seen = new Set()
  const urls = []
  for (const candidate of candidates) {
    const normalized = normalizeRelayUrlCandidate(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }
  return urls
}

function selectRelayUrlFromRelayEntry(entry) {
  const urls = selectRelayUrlsFromRelayEntry(entry)
  return Array.isArray(urls) && urls.length ? urls[0] : null
}

function isLocalRelayUrl(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false
  try {
    const parsed = new URL(candidate.trim())
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false
    const hostname = String(parsed.hostname || '').trim().toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

function stripRelayTokenParam(candidate) {
  const normalized = normalizeRelayUrlCandidate(candidate)
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    if (!parsed.searchParams.has('token')) return null
    parsed.searchParams.delete('token')
    return parsed.toString()
  } catch {
    return null
  }
}

function relayUrlHasToken(candidate) {
  const normalized = normalizeRelayUrlCandidate(candidate)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    return parsed.searchParams.has('token')
  } catch {
    return /[?&]token=/.test(normalized)
  }
}

function relayUrlBaseKey(candidate) {
  const normalized = normalizeRelayUrlCandidate(candidate)
  if (!normalized) return null
  return stripRelayTokenParam(normalized) || normalized
}

function relayCandidatePriority(relayUrl, source = 'unknown') {
  let score = 0
  const normalizedSource = String(source || '').toLowerCase()
  if (isLocalRelayUrl(relayUrl)) score += 40
  if (relayUrl.startsWith('wss://')) score += 20
  if (relayUrl.includes('token=')) score += 8
  if (normalizedSource.includes('joined-relay')) score += 12
  if (normalizedSource.includes('writable-result')) score += 10
  if (normalizedSource.includes('relay-list-local')) score += 8
  if (normalizedSource.includes('relay-list')) score += 6
  if (normalizedSource.includes('fallback')) score -= 2
  if (normalizedSource.includes('tokenless')) score -= 4
  return score
}

function buildRelayCandidateList(seedCandidates = []) {
  const byUrl = new Map()
  let nextOrder = 0
  const upsert = (relayUrl, source = 'unknown') => {
    const normalizedUrl = normalizeRelayUrlCandidate(relayUrl)
    if (!normalizedUrl) return
    const normalizedSource = String(source || 'unknown')
    const priority = relayCandidatePriority(normalizedUrl, normalizedSource)
    const existing = byUrl.get(normalizedUrl)
    if (existing) {
      if (!existing.sources.includes(normalizedSource)) {
        existing.sources.push(normalizedSource)
      }
      if (priority > existing.priority) {
        existing.priority = priority
        existing.source = normalizedSource
      }
      return
    }
    byUrl.set(normalizedUrl, {
      relayUrl: normalizedUrl,
      source: normalizedSource,
      sources: [normalizedSource],
      priority,
      order: nextOrder
    })
    nextOrder += 1
  }

  for (const candidate of seedCandidates) {
    if (typeof candidate === 'string') {
      upsert(candidate, 'unknown')
      const tokenless = stripRelayTokenParam(candidate)
      if (tokenless) upsert(tokenless, 'unknown:tokenless')
      continue
    }
    if (!candidate || typeof candidate !== 'object') continue
    const relayUrl = candidate.relayUrl
    const source = candidate.source || 'unknown'
    upsert(relayUrl, source)
    const tokenless = stripRelayTokenParam(relayUrl)
    if (tokenless) upsert(tokenless, `${source}:tokenless`)
  }

  const ranked = Array.from(byUrl.values())
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority
      return left.order - right.order
    })
    .map(({ relayUrl, source, sources, priority }) => ({ relayUrl, source, sources, priority }))

  return ranked
}

async function resolvePublishRelayCandidates(
  peer,
  {
    relayKey = null,
    publicIdentifier = null,
    joinedRelay = null,
    joinWritableResult = null,
    fallbackRelayUrl = null,
    timeoutMs = 30000
  } = {}
) {
  let candidates = buildRelayCandidateList([
    ...selectRelayUrlsFromRelayEntry(joinedRelay).map((relayUrl) => ({
      relayUrl,
      source: 'joined-relay'
    })),
    ...selectRelayUrlsFromWritableResult(joinWritableResult).map((relayUrl) => ({
      relayUrl,
      source: 'writable-result'
    }))
  ])

  const startedAt = nowTs()
  const localRelayWindowMs = Math.min(timeoutMs, 12000)
  const pollRelayList = async (deadlineMs, { requireLocal = false } = {}) => {
    let found = false
    while (nowTs() < deadlineMs) {
      let relays = null
      let matching = null
      let relayListSource = 'relay-list'
      try {
        relays = await peer.getRelays()
        matching = (Array.isArray(relays) ? relays : []).find((entry) => {
          if (relayKey && entry?.relayKey === relayKey) return true
          if (publicIdentifier && entry?.publicIdentifier === publicIdentifier) return true
          return false
        })
      } catch (_) {
        // Retry until timeout.
      }
      if (matching) {
        found = true
        relayListSource = isLocalRelayUrl(selectRelayUrlFromRelayEntry(matching))
          ? 'relay-list-local'
          : 'relay-list'
        const relayListCandidates = selectRelayUrlsFromRelayEntry(matching).map((relayUrl) => ({
          relayUrl,
          source: relayListSource
        }))
        candidates = buildRelayCandidateList([...candidates, ...relayListCandidates])
        if (!requireLocal || candidates.some((candidate) => isLocalRelayUrl(candidate.relayUrl))) {
          return true
        }
      }
      await sleep(500)
    }
    return found
  }

  await pollRelayList(startedAt + localRelayWindowMs, { requireLocal: true })

  const noLocalCandidates = !candidates.some((candidate) => isLocalRelayUrl(candidate.relayUrl))
  if (!candidates.length || noLocalCandidates) {
    await pollRelayList(startedAt + timeoutMs, { requireLocal: false })
  }

  if (typeof fallbackRelayUrl === 'string' && fallbackRelayUrl.trim()) {
    candidates = buildRelayCandidateList([
      ...candidates,
      {
        relayUrl: fallbackRelayUrl.trim(),
        source: 'fallback'
      }
    ])
  }

  const relayUrl = candidates[0]?.relayUrl || null
  const source = candidates[0]?.source || 'none'
  return {
    relayUrl,
    source,
    candidates
  }
}

function summarizeCandidateErrors(errors = [], limit = 3) {
  if (!Array.isArray(errors) || !errors.length) return 'unknown'
  return errors
    .slice(0, Math.max(1, limit))
    .map((entry) => {
      const stage = String(entry?.stage || 'unknown')
      const source = String(entry?.source || 'unknown')
      const relayUrl = String(entry?.relayUrl || 'unknown')
      const error = String(entry?.error || 'unknown-error')
      return `${stage}:${source}:${relayUrl}:${error}`
    })
    .join('|')
}

function dedupeRelayCandidates(candidates = []) {
  const seen = new Set()
  const deduped = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const relayUrl = normalizeRelayUrlCandidate(candidate.relayUrl)
    const dedupeKey = relayUrl || `default:${candidate.source || 'unknown'}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    deduped.push({
      relayUrl,
      source: candidate.source || 'unknown'
    })
  }
  return deduped
}

async function resolveRelayLikeFromWritableResult(
  peer,
  writableResult,
  { relayKey = null, publicIdentifier = null },
  timeoutMs = 15000
) {
  const direct = selectRelayLikeFromWritableResult(writableResult)
  if (direct) return direct
  try {
    return await waitForRelayEntry(peer, { relayKey, publicIdentifier }, timeoutMs)
  } catch (_) {
    return null
  }
}

async function requestProvision(hostPeer, data) {
  const response = await hostPeer.sendWorkerAwait('provision-writer-for-invitee', data, 240000)
  if (!response?.success) {
    throw new Error(response?.error || 'provision-writer-for-invitee failed')
  }
  return response.data || null
}

async function leaveGroupForCleanup(peer, { relayKey = null, publicIdentifier = null } = {}) {
  if (!peer) {
    return { peer: null, status: 'skipped', reason: 'peer-unavailable' }
  }
  if (!relayKey && !publicIdentifier) {
    return { peer: peer.name, status: 'skipped', reason: 'missing-relay-identifiers' }
  }

  try {
    const response = await withTimeout(
      peer.sendWorkerAwait(
        'leave-group',
        {
          relayKey: relayKey || undefined,
          publicIdentifier: publicIdentifier || undefined,
          saveRelaySnapshot: false,
          saveSharedFiles: false
        },
        25000
      ),
      30000,
      `leave-group-cleanup:${peer.name || 'peer'}`
    )
    if (!response?.success) {
      return {
        peer: peer.name,
        status: 'error',
        reason: response?.error || 'leave-group-response-failed'
      }
    }
    return { peer: peer.name, status: 'ok' }
  } catch (error) {
    return {
      peer: peer.name,
      status: 'error',
      reason: error?.message || String(error)
    }
  }
}

async function readWorkerSwarmPeerKey(userDataDir, pubkeyHex, timeoutMs = 30000) {
  const normalizedPubkey =
    typeof pubkeyHex === 'string' && pubkeyHex.trim()
      ? pubkeyHex.trim().toLowerCase()
      : null
  if (!normalizedPubkey) return null
  const configPath = path.join(
    userDataDir,
    'hypertuna-data',
    'users',
    normalizedPubkey,
    'relay-config.json'
  )
  const startedAt = nowTs()
  while (nowTs() - startedAt < timeoutMs) {
    try {
      const raw = await fs.readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw)
      const key =
        typeof parsed?.swarmPublicKey === 'string' && parsed.swarmPublicKey.trim()
          ? parsed.swarmPublicKey.trim().toLowerCase()
          : (typeof parsed?.proxy_publicKey === 'string' && parsed.proxy_publicKey.trim()
            ? parsed.proxy_publicKey.trim().toLowerCase()
            : null)
      if (key) return key
    } catch (_) {
      // keep polling until timeout
    }
    await sleep(500)
  }
  return null
}

async function runScenario() {
  const scenarioName = `${SCENARIO_ID}-${Date.now().toString(16)}-${randomBytes(2).toString('hex')}`
  const createGatewayName = chooseCreateGatewayName(SCENARIO)
  const createGateway = GATEWAYS[createGatewayName]
  const joinOrigins = SCENARIO?.id === 'S19' || SCENARIO?.id === 'S22' ? [] : gatewayOrderForJoin()
  const shouldPreseedWriterMaterial = !['S19', 'S20', 'S21', 'S22'].includes(SCENARIO?.id)
  const requiresLeaseProvision = ['S20', 'S22'].includes(SCENARIO?.id)
  const expectJoinFailure = SCENARIO?.id === 'S21'
  const requiresThirdPeer = ['S19', 'S20', 'S21', 'S22'].includes(SCENARIO?.id)
  const hostOfflineBeforeJoin = ['S19', 'S20', 'S21'].includes(SCENARIO?.id)

  if (!createGateway?.baseUrl) {
    throw new Error(`missing-create-gateway:${createGatewayName}`)
  }

  const rendererRuntime = await ensureRendererRuntime(SCENARIO_DIR)

  const workerALog = path.join(SCENARIO_DIR, 'workerA.log')
  const workerBLog = path.join(SCENARIO_DIR, 'workerB.log')
  const workerBRestartLog = path.join(SCENARIO_DIR, 'workerB-restart.log')
  const workerCLog = path.join(SCENARIO_DIR, 'workerC.log')
  const summary = {
    scenarioId: SCENARIO_ID,
    scenarioName,
    workerLogs: [workerALog, workerBLog, workerBRestartLog],
    observedViewLength: null,
    expectedViewLength: null,
    autoConnectObservedViewLength: null,
    autoConnectExpectedViewLength: null,
    publishValidation: null,
    joinExpectedFailure: expectJoinFailure,
    joinFailFastReason: null,
    relayKey: null,
    publicIdentifier: null,
    cleanup: []
  }
  let createdRelayKey = null
  let createdPublicIdentifier = null

  const hostPeer = new RendererPeer({
    name: 'workerA',
    userDataDir: path.join(SCENARIO_DIR, 'workerA-userdata'),
    nsecHex: WORKER_A_PRIVKEY,
    pubkeyHex: WORKER_A_PUBKEY,
    workerLogPath: workerALog,
    rendererLogPath: path.join(SCENARIO_DIR, 'workerA.renderer.log'),
    emitTelemetryToStdout: false
  })
  let joinerPeer = new RendererPeer({
    name: 'workerB',
    userDataDir: path.join(SCENARIO_DIR, 'workerB-userdata'),
    nsecHex: WORKER_B_PRIVKEY,
    pubkeyHex: WORKER_B_PUBKEY,
    workerLogPath: workerBLog,
    rendererLogPath: path.join(SCENARIO_DIR, 'workerB.renderer.log'),
    emitTelemetryToStdout: true
  })
  const memberPeer = requiresThirdPeer
    ? new RendererPeer({
      name: 'workerC',
      userDataDir: path.join(SCENARIO_DIR, 'workerC-userdata'),
      nsecHex: WORKER_C_PRIVKEY,
      pubkeyHex: WORKER_C_PUBKEY,
      workerLogPath: workerCLog,
      rendererLogPath: path.join(SCENARIO_DIR, 'workerC.renderer.log'),
      emitTelemetryToStdout: false
    })
    : null
  let restartedJoinerPeer = null

  try {
    logScenarioStage('scenario-start', { scenarioId: SCENARIO_ID, publicScenarioId: SCENARIO?.id || null })
    await hostPeer.start(createGateway.baseUrl, rendererRuntime.url)
    await joinerPeer.start(createGateway.baseUrl, rendererRuntime.url)
    if (memberPeer) {
      await memberPeer.start(createGateway.baseUrl, rendererRuntime.url)
    }
    logScenarioStage('peers-started', { hasMemberPeer: Boolean(memberPeer) })

    const hostSwarmPeerKey = await readWorkerSwarmPeerKey(hostPeer.userDataDir, WORKER_A_PUBKEY)
    const memberSwarmPeerKey = memberPeer
      ? await readWorkerSwarmPeerKey(memberPeer.userDataDir, WORKER_C_PUBKEY)
      : null

    const createResult = await hostPeer.callBridge('createHypertunaRelayGroup', {
      name: `${scenarioName}-group`,
      about: `renderer-matrix ${SCENARIO_ID}`,
      isPublic: true,
      isOpen: SCENARIO?.groupType === 'OPEN',
      fileSharing: true,
      gateways: gatewayDescriptorsForCreate(SCENARIO)
    })
    const discoveryTopicHint =
      typeof createResult?.discoveryTopic === 'string' && createResult.discoveryTopic.trim()
        ? createResult.discoveryTopic.trim()
        : null
    const writerIssuerPubkeyHint =
      typeof createResult?.writerIssuerPubkey === 'string' && createResult.writerIssuerPubkey.trim()
        ? createResult.writerIssuerPubkey.trim()
        : null
    const hostPeerKeysHint = hostSwarmPeerKey ? [hostSwarmPeerKey] : []
    const memberPeerKeysHint = memberSwarmPeerKey ? [memberSwarmPeerKey] : []

    const publicIdentifier =
      typeof createResult?.groupId === 'string' && createResult.groupId.trim()
        ? createResult.groupId.trim()
        : null
    if (!publicIdentifier) {
      throw new Error('create-group-missing-public-identifier')
    }
    createdPublicIdentifier = publicIdentifier
    summary.publicIdentifier = publicIdentifier
    logScenarioStage('group-created', { publicIdentifier })

    const hostRelay = await waitForRelayEntry(hostPeer, { publicIdentifier }, 180000)
    const relayKey = typeof hostRelay?.relayKey === 'string' ? hostRelay.relayKey : null
    if (!relayKey) {
      throw new Error('create-group-missing-relay-key')
    }
    createdRelayKey = relayKey
    summary.relayKey = relayKey

    const relayUrl =
      typeof hostRelay?.connectionUrl === 'string' && hostRelay.connectionUrl.trim()
        ? hostRelay.connectionUrl.trim()
        : (typeof createResult?.relay === 'string' ? createResult.relay : null)

    if (!relayUrl) {
      throw new Error('create-group-missing-relay-url')
    }
    logScenarioStage('relay-resolved', { relayKey, relayUrl })

    if (memberPeer) {
      let memberToken = null
      let memberProvision = null
      if (SCENARIO?.groupType !== 'OPEN') {
        memberToken = randomToken(`member-${SCENARIO_ID.toLowerCase()}`)
        await hostPeer.sendWorkerMessage('update-auth-data', {
          relayKey,
          publicIdentifier,
          pubkey: WORKER_C_PUBKEY,
          token: memberToken
        })
        await sleep(600)
      }
      memberProvision = await requestProvision(hostPeer, {
        relayKey,
        publicIdentifier,
        inviteePubkey: WORKER_C_PUBKEY,
        inviteToken: memberToken,
        useWriterPool: true,
        hostPeerKeys: hostSwarmPeerKey ? [hostSwarmPeerKey] : [],
        memberPeerKeys: memberSwarmPeerKey ? [memberSwarmPeerKey] : [],
        replicationTimeoutMs: 15000
      })
      await memberPeer.callBridge('startJoinLikeGroupPage', {
        groupId: publicIdentifier,
        relayKey,
        relayUrl,
        fileSharing: true,
        isOpen: SCENARIO?.groupType === 'OPEN',
        openJoin: SCENARIO?.groupType === 'OPEN',
        token: memberToken,
        gatewayOrigins: joinOrigins,
        discoveryTopic: discoveryTopicHint,
        hostPeerKeys: hostPeerKeysHint,
        memberPeerKeys: memberPeerKeysHint,
        writerIssuerPubkey: writerIssuerPubkeyHint,
        writerCore: memberProvision?.writerCore || null,
        writerCoreHex: memberProvision?.writerCoreHex || null,
        autobaseLocal: memberProvision?.autobaseLocal || null,
        writerSecret: memberProvision?.writerSecret || null,
        fastForward: memberProvision?.fastForward || null
      })
      await memberPeer.waitForJoinWritable({
        publicIdentifier,
        relayKey,
        timeoutMs: GATES.joinToWritableMs + 15000
      })
      logScenarioStage('member-join-writable-confirmed', { publicIdentifier, relayKey })
      await sleep(1200)
    }

    const inviteToken = randomToken(`join-${SCENARIO_ID.toLowerCase()}`)
    if (SCENARIO?.groupType !== 'OPEN') {
      await hostPeer.sendWorkerMessage('update-auth-data', {
        relayKey,
        publicIdentifier,
        pubkey: WORKER_B_PUBKEY,
        token: inviteToken
      })
      await sleep(800)
    }

    let provisionResult = null
    if (SCENARIO?.groupType === 'OPEN') {
      if (shouldPreseedWriterMaterial) {
        provisionResult = await requestProvision(hostPeer, {
          relayKey,
          publicIdentifier,
          inviteePubkey: WORKER_B_PUBKEY,
          useWriterPool: true
        })
      }
    } else if (requiresLeaseProvision || shouldPreseedWriterMaterial) {
      provisionResult = await requestProvision(hostPeer, {
        relayKey,
        publicIdentifier,
        inviteePubkey: WORKER_B_PUBKEY,
        inviteToken,
        useWriterPool: shouldPreseedWriterMaterial,
        hostPeerKeys: hostSwarmPeerKey ? [hostSwarmPeerKey] : [],
        memberPeerKeys: memberSwarmPeerKey ? [memberSwarmPeerKey] : [],
        replicationTimeoutMs: 15000
      })
      if (requiresLeaseProvision) {
        await sleep(8000)
      }
    }

    if (hostOfflineBeforeJoin) {
      logScenarioStage('host-stop-before-join', { publicIdentifier, relayKey })
      await hostPeer.stop()
    }

    logScenarioStage('join-start-dispatch', { publicIdentifier, relayKey })
    await joinerPeer.callBridge('startJoinLikeGroupPage', {
      groupId: publicIdentifier,
      relayKey,
      relayUrl,
      fileSharing: true,
      isOpen: SCENARIO?.groupType === 'OPEN',
      openJoin: SCENARIO?.groupType === 'OPEN',
      token: SCENARIO?.groupType === 'OPEN' ? null : inviteToken,
      gatewayOrigins: joinOrigins,
      discoveryTopic: discoveryTopicHint,
      hostPeerKeys: hostPeerKeysHint,
      memberPeerKeys: memberPeerKeysHint,
      writerIssuerPubkey: writerIssuerPubkeyHint,
      writerCore: shouldPreseedWriterMaterial ? (provisionResult?.writerCore || null) : null,
      writerCoreHex: shouldPreseedWriterMaterial ? (provisionResult?.writerCoreHex || null) : null,
      autobaseLocal: shouldPreseedWriterMaterial ? (provisionResult?.autobaseLocal || null) : null,
      writerSecret: shouldPreseedWriterMaterial ? (provisionResult?.writerSecret || null) : null,
      fastForward: shouldPreseedWriterMaterial ? (provisionResult?.fastForward || null) : null
    })

    if (expectJoinFailure) {
      try {
        await joinerPeer.waitForJoinWritable({
          publicIdentifier,
          relayKey,
          timeoutMs: GATES.joinToWritableMs + 15000
        })
        throw new Error('expected-join-fail-fast')
      } catch (error) {
        summary.joinFailFastReason = error?.message || String(error)
      }
      logScenarioStage('join-expected-fail-fast', { reason: summary.joinFailFastReason })
      await sleep(5000)
      return summary
    }

    const joinWritableTimeoutMs = GATES.joinToWritableMs + 15000
    const joinWritableResult = await withTimeout(
      Promise.race([
        joinerPeer.waitForJoinWritable({
          publicIdentifier,
          relayKey,
          timeoutMs: joinWritableTimeoutMs
        }),
        joinerPeer.waitForTelemetryEvent('JOIN_WRITABLE_CONFIRMED', {
          publicIdentifier,
          relayKey,
          timeoutMs: joinWritableTimeoutMs
        })
      ]),
      joinWritableTimeoutMs + 20000,
      'join-writable-confirm'
    )
    logScenarioStage('join-writable-confirmed', {
      source: joinWritableResult?.source || null
    })
    await sleep(3000)

    const joinedRelay = await resolveRelayLikeFromWritableResult(
      joinerPeer,
      joinWritableResult,
      { relayKey, publicIdentifier },
      15000
    )
    const joinedMetrics = extractWritableMetricsFromRelay(joinedRelay)
    summary.observedViewLength = joinedMetrics.observedViewLength
    summary.expectedViewLength = joinedMetrics.expectedViewLength

    const publishRelayResolution = await resolvePublishRelayCandidates(joinerPeer, {
      relayKey,
      publicIdentifier,
      joinedRelay,
      joinWritableResult,
      fallbackRelayUrl: null,
      timeoutMs: 30000
    })
    const publishCandidates = dedupeRelayCandidates(
      (Array.isArray(publishRelayResolution?.candidates) ? publishRelayResolution.candidates : []).slice(0, 8)
    )
    if (!publishCandidates.length) {
      throw new Error('publish-relay-url-unavailable')
    }
    const primaryPublishRelay = publishCandidates[0]
    const publishContent = `[matrix ${SCENARIO_ID}] publish validation ${Date.now()}`
    logScenarioStage('publish-validation-start', {
      relayUrl: primaryPublishRelay?.relayUrl || null,
      source: primaryPublishRelay?.source || publishRelayResolution?.source || null,
      candidateCount: publishCandidates.length,
      candidateRelayUrls: publishCandidates.map((candidate) => candidate.relayUrl),
      contentPreview: publishContent.slice(0, 48)
    })
    const publishErrors = []
    let publishedNote = null
    let publishWinner = null
    for (let index = 0; index < publishCandidates.length; index += 1) {
      const candidate = publishCandidates[index]
      const relayUrlCandidate = candidate?.relayUrl
      if (!relayUrlCandidate) continue
      const maxAttemptsPerCandidate = index === 0 ? 3 : 1
      for (let retry = 0; retry < maxAttemptsPerCandidate; retry += 1) {
        const attemptNumber = `${index + 1}.${retry + 1}`
        logScenarioStage('publish-attempt-start', {
          attempt: attemptNumber,
          relayUrl: relayUrlCandidate,
          source: candidate?.source || null
        })
        try {
          publishedNote = await joinerPeer.callBridge('publishGroupNote', {
            groupId: publicIdentifier,
            relayUrl: relayUrlCandidate,
            content: publishContent
          }, 45000)
          publishWinner = candidate
          break
        } catch (error) {
          const message = String(error?.message || error || 'publish-call-failed').replace(/\s+/g, ' ').slice(0, 320)
          publishErrors.push({
            stage: 'publish',
            source: candidate?.source || 'unknown',
            relayUrl: relayUrlCandidate,
            error: message
          })
          logScenarioStage('publish-attempt-failed', {
            attempt: attemptNumber,
            stage: 'publish',
            relayUrl: relayUrlCandidate,
            source: candidate?.source || null,
            error: message
          })
          if (retry + 1 < maxAttemptsPerCandidate) {
            const backoffMs = (retry + 1) * 2000
            logScenarioStage('publish-attempt-retry', {
              attempt: attemptNumber,
              relayUrl: relayUrlCandidate,
              source: candidate?.source || null,
              backoffMs
            })
            await sleep(backoffMs)
          }
        }
      }
      if (publishedNote && publishWinner) {
        break
      }
    }
    if (!publishedNote || !publishWinner) {
      throw new Error(`publish-call-failed:${summarizeCandidateErrors(publishErrors, 5)}`)
    }
    const noteId = typeof publishedNote?.id === 'string' && publishedNote.id.trim()
      ? publishedNote.id.trim()
      : null
    if (!noteId) {
      throw new Error('publish-note-id-unavailable')
    }
    logScenarioStage('publish-call-ok', {
      noteId,
      relayUrl: publishWinner.relayUrl,
      source: publishWinner.source || null
    })

    const publishWinnerHasToken = relayUrlHasToken(publishWinner.relayUrl)
    const publishWinnerBaseRelay = relayUrlBaseKey(publishWinner.relayUrl)
    const postPublishSnapshotWaitMs = publishWinnerHasToken ? 1_200 : 3_500
    logScenarioStage('publish-post-snapshot-wait', {
      relayUrl: publishWinner.relayUrl,
      hasToken: publishWinnerHasToken,
      waitMs: postPublishSnapshotWaitMs
    })
    await sleep(postPublishSnapshotWaitMs)
    await waitForRelayEntry(
      joinerPeer,
      { relayKey, publicIdentifier },
      12_000
    ).catch(() => null)

    const fetchCandidates = dedupeRelayCandidates([
      publishWinner,
      ...publishCandidates
    ]).sort((left, right) => {
      const score = (candidate) => {
        const relayUrlCandidate = normalizeRelayUrlCandidate(candidate?.relayUrl)
        if (!relayUrlCandidate) return -1000
        let rank = 0
        if (relayUrlCandidate === publishWinner.relayUrl) rank += 200
        const candidateBaseRelay = relayUrlBaseKey(relayUrlCandidate)
        const sameBaseRelay = publishWinnerBaseRelay && candidateBaseRelay === publishWinnerBaseRelay
        if (sameBaseRelay) rank += 120
        if (sameBaseRelay && !relayUrlHasToken(relayUrlCandidate)) rank += 40
        if (isLocalRelayUrl(relayUrlCandidate)) rank += 12
        return rank
      }
      return score(right) - score(left)
    })
    let fetchWinner = null
    for (let index = 0; index < fetchCandidates.length; index += 1) {
      const candidate = fetchCandidates[index]
      const relayUrlCandidate = candidate?.relayUrl
      if (!relayUrlCandidate) continue
      try {
        const candidateHasToken = relayUrlHasToken(relayUrlCandidate)
        const candidateBaseRelay = relayUrlBaseKey(relayUrlCandidate)
        const sameBaseRelay = publishWinnerBaseRelay && candidateBaseRelay === publishWinnerBaseRelay
        let fetchTimeoutMs = 20_000
        if (index === 0) {
          fetchTimeoutMs = publishWinnerHasToken ? 45_000 : 65_000
        } else if (sameBaseRelay && !candidateHasToken) {
          fetchTimeoutMs = 45_000
        } else if (sameBaseRelay) {
          fetchTimeoutMs = 30_000
        }
        await joinerPeer.callBridge('waitForGroupNote', {
          groupId: publicIdentifier,
          relayUrl: relayUrlCandidate,
          noteId,
          content: publishContent,
          authorPubkey: WORKER_B_PUBKEY,
          timeoutMs: fetchTimeoutMs
        }, fetchTimeoutMs + 15000)
        fetchWinner = candidate
        break
      } catch (error) {
        const message = String(error?.message || error || 'publish-fetch-failed').replace(/\s+/g, ' ').slice(0, 320)
        publishErrors.push({
          stage: 'fetch',
          source: candidate?.source || 'unknown',
          relayUrl: relayUrlCandidate,
          error: message
        })
        logScenarioStage('publish-attempt-failed', {
          attempt: index + 1,
          stage: 'fetch',
          relayUrl: relayUrlCandidate,
          source: candidate?.source || null,
          error: message
        })
      }
    }
    if (!fetchWinner) {
      const tokenizedFetchFailures = publishErrors.some(
        (entry) => entry?.stage === 'fetch' && relayUrlHasToken(entry?.relayUrl)
      )
      const fetchFailureKind =
        !publishWinnerHasToken && tokenizedFetchFailures
          ? 'publish-ok-fetch-timeout-token-churn'
          : 'publish-fetch-failed'
      throw new Error(`${fetchFailureKind}:${summarizeCandidateErrors(publishErrors, 6)}`)
    }
    logScenarioStage('publish-fetch-ok', { noteId, relayUrl: fetchWinner.relayUrl, source: fetchWinner.source || null })

    const visibleCandidates = dedupeRelayCandidates([
      { relayUrl: fetchWinner.relayUrl, source: `${fetchWinner.source || 'unknown'}:fetch-winner` },
      { relayUrl: publishWinner.relayUrl, source: `${publishWinner.source || 'unknown'}:publish-winner` },
      ...publishCandidates,
      { relayUrl: null, source: 'default-route' }
    ])
    let visibleWinner = null
    for (let index = 0; index < visibleCandidates.length; index += 1) {
      const candidate = visibleCandidates[index]
      const relayUrlCandidate = candidate?.relayUrl
      try {
        await joinerPeer.callBridge('openGroupPage', relayUrlCandidate
          ? { groupId: publicIdentifier, relayUrl: relayUrlCandidate }
          : { groupId: publicIdentifier }, 15000)
        const visibleTimeoutMs = index === 0 ? 45000 : 25000
        await joinerPeer.callBridge('waitForVisibleText', {
          text: publishContent,
          timeoutMs: visibleTimeoutMs
        }, visibleTimeoutMs + 15000)
        visibleWinner = candidate
        break
      } catch (error) {
        const message = String(error?.message || error || 'publish-visible-failed').replace(/\s+/g, ' ').slice(0, 320)
        publishErrors.push({
          stage: 'visible',
          source: candidate?.source || 'unknown',
          relayUrl: relayUrlCandidate || 'default-route',
          error: message
        })
        logScenarioStage('publish-attempt-failed', {
          attempt: index + 1,
          stage: 'visible',
          relayUrl: relayUrlCandidate || null,
          source: candidate?.source || null,
          error: message
        })
      }
    }
    if (!visibleWinner) {
      throw new Error(`publish-visible-failed:${summarizeCandidateErrors(publishErrors, 7)}`)
    }
    logScenarioStage('publish-visible-ok', {
      noteId,
      relayUrl: visibleWinner.relayUrl || null,
      source: visibleWinner.source || null
    })
    summary.publishValidation = {
      relayUrl: publishWinner.relayUrl,
      fetchRelayUrl: fetchWinner.relayUrl,
      visibleRelayUrl: visibleWinner.relayUrl || null,
      relayCandidates: publishCandidates.map((candidate) => ({
        relayUrl: candidate.relayUrl,
        source: candidate.source || null
      })),
      noteId,
      content: publishContent
    }
    logScenarioStage('publish-validation-confirmed', { noteId })

    await joinerPeer.stop()
    const buildRestartedJoiner = () =>
      new RendererPeer({
        name: 'workerB-restart',
        userDataDir: path.join(SCENARIO_DIR, 'workerB-userdata'),
        nsecHex: WORKER_B_PRIVKEY,
        pubkeyHex: WORKER_B_PUBKEY,
        workerLogPath: workerBRestartLog,
        rendererLogPath: path.join(SCENARIO_DIR, 'workerB-restart.renderer.log'),
        emitTelemetryToStdout: true
      })

    let restartError = null
    const restartAttempts = 3
    for (let attempt = 1; attempt <= restartAttempts; attempt += 1) {
      restartedJoinerPeer = buildRestartedJoiner()
      try {
        logScenarioStage('restart-attempt-start', { attempt })
        await withTimeout(
          restartedJoinerPeer.start(createGateway.baseUrl, rendererRuntime.url),
          120000,
          'restart-peer-start'
        )
        const autoconnectTimeoutMs = GATES.joinToWritableMs + 15000
        const autoWritableResult = await withTimeout(
          Promise.race([
            restartedJoinerPeer.waitForAutoConnectWritable({
              publicIdentifier,
              relayKey,
              timeoutMs: autoconnectTimeoutMs
            }),
            restartedJoinerPeer.waitForTelemetryEvent('AUTOCONNECT_WRITABLE_CONFIRMED', {
              publicIdentifier,
              relayKey,
              timeoutMs: autoconnectTimeoutMs
            })
          ]),
          autoconnectTimeoutMs + 20000,
          'restart-peer-autoconnect'
        )
        logScenarioStage('restart-autoconnect-confirmed', {
          attempt,
          source: autoWritableResult?.source || null
        })
        const autoConnectedRelay = await resolveRelayLikeFromWritableResult(
          restartedJoinerPeer,
          autoWritableResult,
          { relayKey, publicIdentifier },
          15000
        )
        const autoMetrics = extractWritableMetricsFromRelay(autoConnectedRelay)
        summary.autoConnectObservedViewLength = autoMetrics.observedViewLength
        summary.autoConnectExpectedViewLength = autoMetrics.expectedViewLength
        restartError = null
        break
      } catch (error) {
        restartError = error
        logScenarioStage('restart-attempt-failed', {
          attempt,
          error: error?.message || String(error)
        })
        await withTimeout(restartedJoinerPeer.stop().catch(() => {}), 15000, 'restart-attempt-stop')
        restartedJoinerPeer = null
        if (attempt < restartAttempts) {
          await sleep(2000 * attempt)
        }
      }
    }
    if (restartError) {
      throw restartError
    }
    logScenarioStage('scenario-complete', {
      observedViewLength: summary.observedViewLength,
      expectedViewLength: summary.expectedViewLength,
      autoConnectObservedViewLength: summary.autoConnectObservedViewLength,
      autoConnectExpectedViewLength: summary.autoConnectExpectedViewLength
    })

    return summary
  } finally {
    if (createdRelayKey || createdPublicIdentifier) {
      const cleanupPeers = [hostPeer, joinerPeer, memberPeer, restartedJoinerPeer].filter(Boolean)
      const cleanupResults = await Promise.all(
        cleanupPeers.map((peer) =>
          leaveGroupForCleanup(peer, {
            relayKey: createdRelayKey,
            publicIdentifier: createdPublicIdentifier
          })
        )
      )
      summary.cleanup = cleanupResults
      logScenarioStage('scenario-relay-cleanup', {
        relayKey: createdRelayKey,
        publicIdentifier: createdPublicIdentifier,
        results: cleanupResults.map((entry) => ({
          peer: entry.peer,
          status: entry.status,
          reason: entry.reason || null
        }))
      })
    }

    const stopWithTimeout = async (peer, label) => {
      if (!peer) return
      try {
        await withTimeout(peer.stop(), 15000, label)
      } catch (_) {
        // Best-effort cleanup only; scenario result should still finalize.
      }
    }
    await Promise.allSettled([
      stopWithTimeout(hostPeer, 'stop-host-peer'),
      stopWithTimeout(joinerPeer, 'stop-joiner-peer'),
      stopWithTimeout(memberPeer, 'stop-member-peer'),
      stopWithTimeout(restartedJoinerPeer, 'stop-restarted-joiner-peer')
    ])
    try {
      await withTimeout(rendererRuntime.stop(), 10000, 'stop-renderer-runtime')
    } catch (_) {
      // ignore shutdown timeout
    }
  }
}

async function main() {
  await fs.mkdir(SCENARIO_DIR, { recursive: true })

  const summary = {
    scenarioId: SCENARIO_ID,
    workerLogs: [
      path.join(SCENARIO_DIR, 'workerA.log'),
      path.join(SCENARIO_DIR, 'workerB.log'),
      path.join(SCENARIO_DIR, 'workerB-restart.log')
    ],
    observedViewLength: null,
    expectedViewLength: null,
    autoConnectObservedViewLength: null,
    autoConnectExpectedViewLength: null
  }

  let failed = false
  let errorMessage = null

  try {
    if (!_electron) {
      const reason = playwrightLoadError?.message || 'playwright-not-available'
      throw new Error(`playwright-not-available:${reason}`)
    }
    summary.workerLogs = summary.workerLogs.filter(Boolean)
    const scenarioSummary = await runScenario()
    Object.assign(summary, scenarioSummary)
  } catch (error) {
    failed = true
    errorMessage = error?.message || String(error)
    console.error('[executor-renderer] scenario failed', {
      scenarioId: SCENARIO_ID,
      error: errorMessage
    })
  } finally {
    await new Promise((resolve) => {
      process.stdout.write(`HT_SCENARIO_SUMMARY=${JSON.stringify(summary)}\n`, resolve)
    })
  }

  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('[executor-renderer] fatal', error?.message || error)
  process.exit(1)
})
