#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1';

const thisFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(thisFile), '..');

const HOST = process.env.E2E_GATEWAY_HOST || '127.0.0.1';
const portA = Number.isFinite(Number(process.env.E2E_GATEWAY_A_PORT))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_GATEWAY_A_PORT)))
  : 4540;
const portB = Number.isFinite(Number(process.env.E2E_GATEWAY_B_PORT))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_GATEWAY_B_PORT)))
  : 4541;
const baseA = `http://${HOST}:${portA}`;
const baseB = `http://${HOST}:${portB}`;

const gatewayAId = typeof process.env.E2E_GATEWAY_A_ID === 'string' && process.env.E2E_GATEWAY_A_ID.trim()
  ? process.env.E2E_GATEWAY_A_ID.trim()
  : `gateway-a-${HOST}-${portA}`;
const gatewayBId = typeof process.env.E2E_GATEWAY_B_ID === 'string' && process.env.E2E_GATEWAY_B_ID.trim()
  ? process.env.E2E_GATEWAY_B_ID.trim()
  : `gateway-b-${HOST}-${portB}`;
const federationId = typeof process.env.E2E_FEDERATION_ID === 'string' && process.env.E2E_FEDERATION_ID.trim()
  ? process.env.E2E_FEDERATION_ID.trim()
  : `hypertuna-federation-${randomBytes(4).toString('hex')}`;
const minQuorum = Number.isFinite(Number(process.env.E2E_FEDERATION_MIN_QUORUM))
  ? Math.max(1, Math.trunc(Number(process.env.E2E_FEDERATION_MIN_QUORUM)))
  : 2;

const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.E2E_TIMEOUT_MS))
  ? Math.max(1000, Math.trunc(Number(process.env.E2E_TIMEOUT_MS)))
  : 30_000;

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function toHex(value) {
  return Buffer.from(value).toString('hex');
}

function normalizeHex(value) {
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
  throw new Error('failed-to-generate-worker-private-key');
}

function createChallengeSignature(challenge, privkeyHex) {
  const digestHex = createHash('sha256').update(String(challenge)).digest('hex');
  const signature = schnorr.sign(digestHex, privkeyHex);
  return toHex(signature);
}

function buildNostrAuthEvent({
  relay,
  challenge,
  pubkey,
  privkey,
  publicIdentifier = null,
  purpose = null
}) {
  const tags = [
    ['relay', relay],
    ['challenge', challenge]
  ];
  if (publicIdentifier) tags.push(['h', publicIdentifier]);
  if (purpose) tags.push(['purpose', purpose]);
  const event = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    pubkey,
    tags,
    content: ''
  };
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  event.id = createHash('sha256').update(serialized).digest('hex');
  const signature = schnorr.sign(event.id, privkey);
  return {
    ...event,
    sig: toHex(signature)
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(baseUrl, path, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
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
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = { raw };
      }
    }
    if (!response.ok) {
      const detail = typeof data?.error === 'string'
        ? data.error
        : (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : null);
      const error = new Error(`HTTP ${response.status} ${response.statusText} for ${method} ${path}${detail ? ` (${detail})` : ''}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(fn, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = 500,
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? ` (${lastError?.message || lastError})` : '';
  throw new Error(`timeout waiting for ${label}${suffix}`);
}

function startGateway({ id, port, publicUrl, manifestJson, label }) {
  const env = {
    ...process.env,
    HOST,
    PORT: String(port),
    GATEWAY_TLS_ENABLED: 'false',
    GATEWAY_PUBLIC_URL: publicUrl,
    GATEWAY_NOSTR_PUBKEY: id,
    GATEWAY_FEDERATION_GATEWAY_ID: id,
    GATEWAY_FEDERATION_MANIFEST_JSON: manifestJson
  };

  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal == null) {
      process.stderr.write(`[${label}] exited with code ${code}\n`);
    }
  });
  return child;
}

async function main() {
  const workerPrivkey = normalizeHex(process.env.E2E_WORKER_NSEC_HEX) || generateSchnorrPrivateKey();
  const workerPubkey = toHex(schnorr.getPublicKey(workerPrivkey));
  const relayKey = normalizeHex(process.env.E2E_RELAY_KEY) || randomHex(32);

  const manifest = {
    federationId,
    epoch: 1,
    minQuorum,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    gateways: [
      {
        id: gatewayAId,
        swarmPublicKey: gatewayAId,
        role: 'voter',
        weight: 1,
        controlP2P: { topic: 'hypertuna-gateway-control-v2', protocol: 'gateway-control-v2', swarmPublicKey: gatewayAId },
        controlHttp: { baseUrl: baseA },
        bridgeHttp: { baseUrl: baseA }
      },
      {
        id: gatewayBId,
        swarmPublicKey: gatewayBId,
        role: 'voter',
        weight: 1,
        controlP2P: { topic: 'hypertuna-gateway-control-v2', protocol: 'gateway-control-v2', swarmPublicKey: gatewayBId },
        controlHttp: { baseUrl: baseB },
        bridgeHttp: { baseUrl: baseB }
      }
    ]
  };
  const manifestJson = JSON.stringify(manifest);

  const children = [];
  const killAll = () => {
    for (const child of children) {
      if (!child || child.killed) continue;
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  };
  process.on('SIGINT', () => { killAll(); process.exit(130); });
  process.on('SIGTERM', () => { killAll(); process.exit(143); });

  try {
    console.log('[LiveFederationE2E] starting gateways', {
      federationId,
      minQuorum,
      gatewayAId,
      gatewayBId,
      baseA,
      baseB
    });

    const gatewayA = startGateway({ id: gatewayAId, port: portA, publicUrl: baseA, manifestJson, label: 'gw-a' });
    const gatewayB = startGateway({ id: gatewayBId, port: portB, publicUrl: baseB, manifestJson, label: 'gw-b' });
    children.push(gatewayA, gatewayB);

    await waitFor(async () => {
      const health = await requestJson(baseA, '/health', { timeoutMs: 3000 });
      return health?.status === 'ok';
    }, { timeoutMs: 45_000, label: 'gateway-a health' });
    await waitFor(async () => {
      const health = await requestJson(baseB, '/health', { timeoutMs: 3000 });
      return health?.status === 'ok';
    }, { timeoutMs: 45_000, label: 'gateway-b health' });

    const challenge = await requestJson(baseA, '/api/v2/auth/challenge', {
      method: 'POST',
      body: { workerPubkey }
    });
    assert(typeof challenge?.challenge === 'string' && challenge.challenge.length > 0, 'missing-auth-challenge');
    const signature = createChallengeSignature(challenge.challenge, workerPrivkey);
    const session = await requestJson(baseA, '/api/v2/auth/session', {
      method: 'POST',
      body: {
        challenge: challenge.challenge,
        workerPubkey,
        signature
      }
    });
    assert(typeof session?.accessToken === 'string', 'missing-access-token');
    const authHeaders = { authorization: `Bearer ${session.accessToken}` };

    const relayCores = [
      { key: randomHex(32), role: 'autobase' },
      { key: randomHex(32), role: 'hyperdrive' }
    ];
    await requestJson(baseA, '/api/v2/relays/register', {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        peers: [],
        metadata: {
          identifier: relayKey,
          isOpen: true,
          isPublic: true,
          isHosted: true,
          isJoined: false,
          metadataUpdatedAt: Date.now()
        },
        relayCores,
        relayCoresMode: 'merge'
      }
    });

    const openJoinEntryOne = {
      writerCore: randomHex(32),
      writerCoreHex: randomHex(32),
      autobaseLocal: randomHex(32),
      writerSecret: `secret-${randomHex(8)}`,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000)
    };
    await requestJson(baseA, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/pool`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        entries: [openJoinEntryOne],
        targetSize: 1,
        metadata: { identifier: relayKey, isOpen: true, metadataUpdatedAt: Date.now() }
      }
    });

    const challengeA = await requestJson(baseA, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/challenge`);
    assert(typeof challengeA?.challenge === 'string', 'gateway-a missing open-join challenge');
    const authEventA = buildNostrAuthEvent({
      relay: baseA,
      challenge: challengeA.challenge,
      pubkey: workerPubkey,
      privkey: workerPrivkey,
      publicIdentifier: challengeA.publicIdentifier || relayKey
    });
    const leaseA = await requestJson(baseA, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/lease`, {
      method: 'POST',
      body: { authEvent: authEventA }
    });
    assert(leaseA?.certificate?.quorum >= minQuorum, 'gateway-a lease certificate quorum not reached');

    await waitFor(async () => {
      const state = await requestJson(baseB, '/api/v2/mesh/state');
      const events = Array.isArray(state?.events) ? state.events : [];
      return events.some((event) => event?.eventType === 'LeaseCertificateCommitted'
        && event?.payload?.relayKey === relayKey);
    }, { timeoutMs: 20_000, label: 'lease replication to gateway-b' });

    const mirrorOnB = await requestJson(baseB, `/api/v2/relays/${encodeURIComponent(relayKey)}/mirror`);
    assert(mirrorOnB?.relayKey === relayKey, 'gateway-b mirror metadata missing relay');

    const openJoinEntryTwo = {
      writerCore: randomHex(32),
      writerCoreHex: randomHex(32),
      autobaseLocal: randomHex(32),
      writerSecret: `secret-${randomHex(8)}`,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000)
    };
    await requestJson(baseA, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/pool`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        entries: [openJoinEntryTwo],
        targetSize: 1,
        metadata: { identifier: relayKey, isOpen: true, metadataUpdatedAt: Date.now() }
      }
    });

    const challengeB = await waitFor(async () => {
      const value = await requestJson(baseB, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/challenge`);
      return value?.challenge ? value : null;
    }, { timeoutMs: 20_000, label: 'gateway-b open-join challenge' });
    const authEventB = buildNostrAuthEvent({
      relay: baseB,
      challenge: challengeB.challenge,
      pubkey: workerPubkey,
      privkey: workerPrivkey,
      publicIdentifier: challengeB.publicIdentifier || relayKey
    });
    const leaseB = await requestJson(baseB, `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/lease`, {
      method: 'POST',
      body: { authEvent: authEventB }
    });
    assert(leaseB?.certificate?.quorum >= minQuorum, 'gateway-b lease certificate quorum not reached');

    const customEventId = randomHex(16);
    await requestJson(baseB, '/api/v2/mesh/state/append', {
      method: 'POST',
      body: {
        event: {
          id: customEventId,
          eventType: 'TokenRevoked',
          payload: { relayKey },
          metadata: { sourceGatewayId: gatewayBId },
          timestamp: Date.now()
        }
      }
    });
    await waitFor(async () => {
      const state = await requestJson(baseA, '/api/v2/mesh/state');
      const events = Array.isArray(state?.events) ? state.events : [];
      return events.some((event) => event?.id === customEventId);
    }, { timeoutMs: 20_000, label: 'mesh append propagation to gateway-a' });

    console.log('[LiveFederationE2E] completed successfully', {
      federationId,
      relayKey,
      workerPubkey: workerPubkey.slice(0, 16),
      leaseAQuorum: leaseA?.certificate?.quorum ?? null,
      leaseBQuorum: leaseB?.certificate?.quorum ?? null
    });
  } finally {
    killAll();
  }
}

main().catch((error) => {
  console.error('[LiveFederationE2E] failed', {
    error: error?.message || error
  });
  process.exitCode = 1;
});
