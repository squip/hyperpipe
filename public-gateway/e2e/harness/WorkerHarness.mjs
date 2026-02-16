import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1';

import {
  randomHex,
  waitFor
} from './utils.mjs';

function toHex(value) {
  return Buffer.from(value).toString('hex');
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

function pipeToLogger(stream, logger) {
  if (!stream || typeof logger !== 'function') return;
  stream.on('data', (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line) continue;
      logger(line);
    }
  });
}

class WorkerHarness extends EventEmitter {
  constructor({
    label,
    child,
    pubkey,
    privkey,
    storageDir,
    logger = null
  }) {
    super();
    this.label = label;
    this.child = child;
    this.pubkey = pubkey;
    this.privkey = privkey;
    this.storageDir = storageDir;
    this.logger = typeof logger === 'function' ? logger : null;
    this.messages = [];
    this.waiters = new Set();
    this.pendingRequests = new Map();
    this.exited = false;
    this.swarmPublicKey = null;

    child.on('message', (message) => this.#onMessage(message));
    child.once('exit', (code, signal) => this.#onExit(code, signal));
  }

  #log(message, data = null) {
    if (!this.logger) return;
    this.logger(data ? `${message} ${JSON.stringify(data)}` : message);
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
          pending.reject(new Error(message.error || `worker request failed (${message.requestId})`));
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
    if (this.exited) throw new Error(`cannot send message to exited worker (${this.label})`);
    this.child.send(message);
  }

  request(type, data = {}, { timeoutMs = 180_000 } = {}) {
    const requestId = `${type}-${randomHex(8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`timeout waiting for worker-response (${type})`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.send({ type, requestId, data });
    });
  }

  waitForMessage(predicate, {
    timeoutMs = 180_000,
    label = 'worker message'
  } = {}) {
    for (const message of this.messages) {
      if (predicate(message)) {
        return Promise.resolve(message);
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: null
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async configurePublicGateway(config, { timeoutMs = 60_000 } = {}) {
    this.send({ type: 'set-public-gateway-config', config });
    await this.waitForMessage((message) => (
      message?.type === 'public-gateway-config'
      && message?.config
      && typeof message.config === 'object'
    ), {
      timeoutMs,
      label: `${this.label} public-gateway-config`
    });
  }

  async setTrustFixture(fixture = {}, { timeoutMs = 30_000 } = {}) {
    const result = await this.request('set-gateway-trust-fixture', {
      fixture
    }, {
      timeoutMs
    });
    return result;
  }

  async getTrustFixture({ timeoutMs = 30_000 } = {}) {
    return this.request('get-gateway-trust-fixture', {}, { timeoutMs });
  }

  async runControlMethod(methodName, payload = {}, options = {}, { timeoutMs = 45_000 } = {}) {
    return this.request('run-control-method', {
      methodName,
      payload,
      options
    }, {
      timeoutMs
    });
  }

  async createRelay(payload, { timeoutMs = 180_000 } = {}) {
    return this.request('create-relay', payload, { timeoutMs });
  }

  async shutdown({ timeoutMs = 12_000 } = {}) {
    if (this.exited) return;
    try {
      this.send({ type: 'shutdown' });
    } catch (_) {}

    await waitFor(async () => this.exited, {
      timeoutMs,
      intervalMs: 100,
      label: `${this.label} shutdown`
    }).catch(() => null);

    if (!this.exited) {
      try {
        this.child.kill('SIGTERM');
      } catch (_) {}
    }
  }

  static async start({
    label,
    workerRoot,
    storageDir,
    port,
    host = '127.0.0.1',
    gatewayBaseUrl,
    logger = null,
    timeoutMs = 180_000,
    configOverrides = {}
  }) {
    await fs.mkdir(storageDir, { recursive: true });

    const privkey = generateSchnorrPrivateKey();
    const pubkey = toHex(schnorr.getPublicKey(privkey));

    const config = {
      nostr_pubkey_hex: pubkey,
      nostr_nsec_hex: privkey,
      storage: storageDir,
      port,
      proxy_server_address: `${host}:${port}`,
      proxy_websocket_protocol: 'ws',
      gatewayUrl: gatewayBaseUrl,
      registerWithGateway: true,
      relays: [],
      ...(configOverrides || {})
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

    const prefix = `[${label}]`;
    pipeToLogger(child.stdout, (line) => logger?.(`${prefix}[stdout] ${line}`));
    pipeToLogger(child.stderr, (line) => logger?.(`${prefix}[stderr] ${line}`));

    const worker = new WorkerHarness({
      label,
      child,
      pubkey,
      privkey,
      storageDir,
      logger: logger ? (line) => logger(`${prefix} ${line}`) : null
    });

    worker.send({ type: 'config', data: config });

    await worker.waitForMessage((message) => (
      message?.type === 'config-applied'
      && message?.data?.user?.pubkeyHex === pubkey
    ), {
      timeoutMs,
      label: `${label} config-applied`
    });

    await worker.waitForMessage((message) => (
      message?.type === 'status'
      && message?.phase === 'ready'
    ), {
      timeoutMs,
      label: `${label} ready`
    });

    return worker;
  }
}

export default WorkerHarness;
