#!/usr/bin/env node

import { spawn, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1';

const thisFile = fileURLToPath(import.meta.url);
const gatewayRoot = resolve(dirname(thisFile), '..');
const repoRoot = resolve(gatewayRoot, '..');
const workerRoot = resolve(repoRoot, 'hypertuna-worker');

const HOST = process.env.E2E_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = Number.isFinite(Number(process.env.E2E_GATEWAY_PORT))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_GATEWAY_PORT)))
  : 4630;
const WORKER_A_PORT = Number.isFinite(Number(process.env.E2E_WORKER_A_PORT))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_WORKER_A_PORT)))
  : 39401;
const WORKER_B_PORT = Number.isFinite(Number(process.env.E2E_WORKER_B_PORT))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_WORKER_B_PORT)))
  : 39402;

const GATEWAY_BASE_URL = `http://${HOST}:${GATEWAY_PORT}`;
const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.E2E_TIMEOUT_MS))
  ? Math.max(5_000, Math.trunc(Number(process.env.E2E_TIMEOUT_MS)))
  : 180_000;
const HEALTH_TIMEOUT_MS = Number.isFinite(Number(process.env.E2E_HEALTH_TIMEOUT_MS))
  ? Math.max(5_000, Math.trunc(Number(process.env.E2E_HEALTH_TIMEOUT_MS)))
  : 45_000;
const VERBOSE = process.env.E2E_VERBOSE === '1' || process.env.E2E_VERBOSE === 'true';

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function toHex(value) {
  return Buffer.from(value).toString('hex');
}

function normalizeHex64(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function generateSchnorrPrivateKey() {
  for (let i = 0; i < 128; i += 1) {
    const candidate = randomHex(32);
    try {
      schnorr.getPublicKey(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error('failed-to-generate-schnorr-private-key');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function prefixStream(stream, label) {
  if (!VERBOSE) return;
  if (!stream) return;
  stream.on('data', (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      process.stdout.write(`[${label}] ${line}\n`);
    }
  });
}

async function waitFor(fn, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = 250,
  label = 'condition'
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` (${lastError?.message || lastError})` : '';
  throw new Error(`timeout waiting for ${label}${suffix}`);
}

async function requestJson(pathname, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 10_000
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${GATEWAY_BASE_URL}${pathname}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(headers || {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal
    });
    const raw = await response.text().catch(() => '');
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        payload = { raw };
      }
    }
    if (!response.ok) {
      const detail = typeof payload?.error === 'string'
        ? payload.error
        : (typeof payload?.raw === 'string' ? payload.raw.slice(0, 240) : null);
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` (${detail})` : ''}`);
    }
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class WorkerHarness extends EventEmitter {
  constructor({ label, child, pubkey, privkey, storageDir }) {
    super();
    this.label = label;
    this.child = child;
    this.pubkey = pubkey;
    this.privkey = privkey;
    this.storageDir = storageDir;
    this.swarmPublicKey = null;
    this.messages = [];
    this.waiters = new Set();
    this.pendingRequests = new Map();
    this.exited = false;

    child.on('message', (message) => this.#onMessage(message));
    child.once('exit', (code, signal) => this.#onExit(code, signal));
  }

  #onMessage(message) {
    this.messages.push(message);
    this.emit('message', message);

    if (message?.type === 'config-applied') {
      const swarmKey = message?.data?.proxy?.swarmPublicKey;
      if (typeof swarmKey === 'string' && swarmKey.trim()) {
        this.swarmPublicKey = swarmKey.trim();
      }
    }

    if (message?.type === 'worker-response' && typeof message?.requestId === 'string') {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.success === false) {
          const error = new Error(message.error || `worker request failed (${message.requestId})`);
          pending.reject(error);
        } else {
          pending.resolve(message.data ?? null);
        }
      }
    }

    for (const waiter of Array.from(this.waiters)) {
      let matched = false;
      try {
        matched = !!waiter.predicate(message);
      } catch (error) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error);
        continue;
      }
      if (!matched) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  #onExit(code, signal) {
    this.exited = true;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    const error = new Error(`worker ${this.label} exited (${reason})`);
    for (const waiter of Array.from(this.waiters)) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  send(message) {
    if (this.exited) {
      throw new Error(`cannot send message to exited worker (${this.label})`);
    }
    this.child.send(message);
  }

  request(type, data, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const requestId = `${type}-${randomHex(8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`timeout waiting for worker-response (${type})`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.send({
        type,
        requestId,
        data
      });
    });
  }

  waitForMessage(predicate, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = 'worker message'
  } = {}) {
    for (const message of this.messages) {
      if (predicate(message)) {
        return Promise.resolve(message);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  async shutdown({ timeoutMs = 10_000 } = {}) {
    if (this.exited) return;
    try {
      this.send({ type: 'shutdown' });
    } catch (_) {}

    const exitPromise = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
    });

    const timed = waitFor(async () => this.exited, {
      timeoutMs,
      intervalMs: 100,
      label: `worker ${this.label} shutdown`
    }).catch(() => null);
    await Promise.race([timed, exitPromise, sleep(timeoutMs)]);

    if (!this.exited) {
      try {
        this.child.kill('SIGTERM');
      } catch (_) {}
    }
  }
}

function startGateway({ gatewayId, manifestJson }) {
  const env = {
    ...process.env,
    HOST,
    PORT: String(GATEWAY_PORT),
    GATEWAY_TLS_ENABLED: 'false',
    GATEWAY_PUBLIC_URL: GATEWAY_BASE_URL,
    GATEWAY_NOSTR_PUBKEY: gatewayId,
    GATEWAY_FEDERATION_GATEWAY_ID: gatewayId,
    GATEWAY_FEDERATION_MANIFEST_JSON: manifestJson
  };

  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: gatewayRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  prefixStream(child.stdout, 'gateway');
  prefixStream(child.stderr, 'gateway');
  return child;
}

async function waitForGatewayReady() {
  await waitFor(async () => {
    const payload = await requestJson('/health', { timeoutMs: 2_000 });
    return payload || true;
  }, {
    timeoutMs: HEALTH_TIMEOUT_MS,
    intervalMs: 400,
    label: 'gateway health endpoint'
  });
}

async function startWorker({
  label,
  storageDir,
  port,
  gatewayBaseUrl
}) {
  await fs.mkdir(storageDir, { recursive: true });

  const privkey = generateSchnorrPrivateKey();
  const pubkey = toHex(schnorr.getPublicKey(privkey));
  const config = {
    nostr_pubkey_hex: pubkey,
    nostr_nsec_hex: privkey,
    storage: storageDir,
    port,
    proxy_server_address: `${HOST}:${port}`,
    proxy_websocket_protocol: 'ws',
    gatewayUrl: gatewayBaseUrl,
    registerWithGateway: true,
    relays: []
  };

  const child = fork(join(workerRoot, 'index.js'), [], {
    cwd: workerRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      STORAGE_DIR: storageDir,
      PUBLIC_GATEWAY_SETTINGS_PATH: join(storageDir, 'public-gateway-settings.json')
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  prefixStream(child.stdout, `${label}:stdout`);
  prefixStream(child.stderr, `${label}:stderr`);

  const worker = new WorkerHarness({ label, child, pubkey, privkey, storageDir });
  worker.send({
    type: 'config',
    data: config
  });

  await worker.waitForMessage((message) => (
    message?.type === 'config-applied'
    && message?.data?.user?.pubkeyHex === pubkey
  ), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    label: `${label} config-applied`
  });

  await worker.waitForMessage((message) => (
    message?.type === 'status'
    && message?.phase === 'ready'
  ), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    label: `${label} ready`
  });

  assert(worker.swarmPublicKey, `${label} missing swarmPublicKey after config-applied`);
  return worker;
}

function buildGatewayConfig({ gatewayId }) {
  return {
    enabled: true,
    networkMode: 'permissionless-wot',
    selectionMode: 'manual',
    selectedGatewayId: gatewayId,
    activeGatewayId: gatewayId,
    baseUrl: GATEWAY_BASE_URL,
    preferredBaseUrl: GATEWAY_BASE_URL,
    preferredGatewayIds: [gatewayId],
    trustPolicy: {
      explicitAllowlist: [gatewayId],
      requireFollowedByMe: false,
      requireMutualFollow: false,
      minTrustedAttestations: 0,
      acceptedAttestorPubkeys: [],
      maxDescriptorAgeMs: 6 * 60 * 60 * 1000
    },
    gateways: {
      [gatewayId]: {
        id: gatewayId,
        nostrPubkey: gatewayId,
        swarmPublicKey: gatewayId,
        controlTopic: 'hypertuna-gateway-control-v2',
        baseUrl: GATEWAY_BASE_URL,
        wsUrl: null,
        trust: 'trusted',
        health: 'healthy'
      }
    }
  };
}

async function configureWorkerGateway(worker, gatewayId) {
  const nextConfig = buildGatewayConfig({ gatewayId });
  worker.send({
    type: 'set-public-gateway-config',
    config: nextConfig
  });

  await worker.waitForMessage((message) => (
    message?.type === 'public-gateway-config'
    && message?.config?.baseUrl === GATEWAY_BASE_URL
    && message?.config?.selectedGatewayId === gatewayId
  ), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    label: `${worker.label} public-gateway-config`
  });
}

function preview(value, length = 12) {
  if (typeof value !== 'string') return null;
  return value.slice(0, length);
}

async function main() {
  const runDir = await fs.mkdtemp(join(tmpdir(), 'ht-live-worker-gateway-e2e-'));
  const gatewayId = normalizeHex64(process.env.E2E_GATEWAY_ID) || randomHex(32);
  const federationId = process.env.E2E_FEDERATION_ID || `hypertuna-live-${randomHex(4)}`;

  const manifest = {
    federationId,
    epoch: 1,
    minQuorum: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    gateways: [{
      id: gatewayId,
      swarmPublicKey: gatewayId,
      role: 'voter',
      weight: 1,
      controlP2P: {
        topic: 'hypertuna-gateway-control-v2',
        protocol: 'gateway-control-v2',
        swarmPublicKey: gatewayId
      },
      controlHttp: {
        baseUrl: GATEWAY_BASE_URL
      },
      bridgeHttp: {
        baseUrl: GATEWAY_BASE_URL
      }
    }]
  };

  const summary = {
    gateway: {
      id: gatewayId,
      baseUrl: GATEWAY_BASE_URL
    },
    workers: {},
    createRelay: null,
    joinResult: null
  };

  let gatewayChild = null;
  let creatorWorker = null;
  let joinerWorker = null;

  const cleanup = async () => {
    if (creatorWorker) await creatorWorker.shutdown({ timeoutMs: 10_000 }).catch(() => {});
    if (joinerWorker) await joinerWorker.shutdown({ timeoutMs: 10_000 }).catch(() => {});
    if (gatewayChild && !gatewayChild.killed) {
      try {
        gatewayChild.kill('SIGTERM');
      } catch (_) {}
      await sleep(300);
      if (!gatewayChild.killed) {
        try {
          gatewayChild.kill('SIGKILL');
        } catch (_) {}
      }
    }
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    console.log('[LiveWorkerE2E] Starting gateway + worker harness', {
      runDir,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      gatewayId: preview(gatewayId, 16),
      federationId
    });

    gatewayChild = startGateway({
      gatewayId,
      manifestJson: JSON.stringify(manifest)
    });
    await waitForGatewayReady();
    console.log('[LiveWorkerE2E] Gateway is healthy');

    creatorWorker = await startWorker({
      label: 'worker-a',
      storageDir: join(runDir, 'worker-a'),
      port: WORKER_A_PORT,
      gatewayBaseUrl: GATEWAY_BASE_URL
    });
    joinerWorker = await startWorker({
      label: 'worker-b',
      storageDir: join(runDir, 'worker-b'),
      port: WORKER_B_PORT,
      gatewayBaseUrl: GATEWAY_BASE_URL
    });

    summary.workers.creator = {
      pubkey: creatorWorker.pubkey,
      swarmPublicKey: creatorWorker.swarmPublicKey
    };
    summary.workers.joiner = {
      pubkey: joinerWorker.pubkey,
      swarmPublicKey: joinerWorker.swarmPublicKey
    };

    await configureWorkerGateway(creatorWorker, gatewayId);
    await configureWorkerGateway(joinerWorker, gatewayId);
    console.log('[LiveWorkerE2E] Workers configured for local gateway');

    const createRelayResult = await creatorWorker.request('create-relay', {
      name: `Live E2E ${randomHex(3)}`,
      description: 'worker-process live e2e relay',
      isPublic: true,
      isOpen: true,
      fileSharing: true
    }, {
      timeoutMs: DEFAULT_TIMEOUT_MS
    });

    assert(createRelayResult?.success !== false, 'create-relay returned success=false');
    assert(typeof createRelayResult?.relayKey === 'string', 'create-relay missing relayKey');
    assert(typeof createRelayResult?.publicIdentifier === 'string', 'create-relay missing publicIdentifier');
    summary.createRelay = {
      relayKey: createRelayResult.relayKey,
      publicIdentifier: createRelayResult.publicIdentifier,
      gatewayRegistration: createRelayResult.gatewayRegistration || null
    };

    if (createRelayResult?.gatewayRegistration === 'failed') {
      throw new Error(`create-relay gateway registration failed: ${createRelayResult?.registrationError || 'unknown-error'}`);
    }

    const joinPayload = {
      relayKey: createRelayResult.relayKey,
      publicIdentifier: createRelayResult.publicIdentifier,
      relayUrl: createRelayResult.relayUrl || null,
      openJoin: true,
      isOpen: true,
      fileSharing: true,
      hostPeers: [creatorWorker.swarmPublicKey]
    };
    joinerWorker.send({
      type: 'start-join-flow',
      data: joinPayload
    });

    const joinOutcome = await joinerWorker.waitForMessage((message) => {
      if (message?.type === 'join-auth-success' && message?.data?.publicIdentifier === createRelayResult.publicIdentifier) {
        return true;
      }
      if (message?.type === 'join-auth-error' && message?.data?.publicIdentifier === createRelayResult.publicIdentifier) {
        return true;
      }
      return false;
    }, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      label: 'join outcome'
    });

    if (joinOutcome?.type === 'join-auth-error') {
      throw new Error(`join flow failed: ${joinOutcome?.data?.error || 'unknown-error'}`);
    }

    joinerWorker.send({ type: 'get-relays' });
    await joinerWorker.waitForMessage((message) => {
      if (message?.type !== 'relay-update' || !Array.isArray(message?.relays)) return false;
      return message.relays.some((relay) => relay?.relayKey === createRelayResult.relayKey);
    }, {
      timeoutMs: 60_000,
      label: 'joined relay update'
    });

    summary.joinResult = {
      status: 'ok',
      relayKey: joinOutcome?.data?.relayKey || createRelayResult.relayKey,
      mode: joinOutcome?.data?.mode || null,
      hostPeer: joinOutcome?.data?.hostPeer || null
    };

    console.log('[LiveWorkerE2E] Completed successfully');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error('[LiveWorkerE2E] Failed', error?.message || error);
  process.exitCode = 1;
});
