#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.E2E_TIMEOUT_MS))
  ? Math.max(1000, Math.trunc(Number(process.env.E2E_TIMEOUT_MS)))
  : 15_000;

const baseUrl = normalizeBaseUrl(process.env.GATEWAY_BASE_URL || process.env.GATEWAY_PUBLIC_URL || 'http://127.0.0.1:4430');
const relayKey = normalizeRelayKey(process.env.E2E_RELAY_KEY) || randomHex(32);
const workerPrivkey = normalizeHex(process.env.WORKER_NSEC_HEX || process.env.E2E_WORKER_NSEC_HEX) || generateSchnorrPrivateKey();
const workerPubkey = toHex(schnorr.getPublicKey(workerPrivkey));

if (!baseUrl) {
  throw new Error('Missing valid GATEWAY_BASE_URL (e.g. http://127.0.0.1:4430)');
}

const stepResults = [];

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeRelayKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

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
  throw new Error('Failed to generate valid schnorr private key');
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
  if (publicIdentifier) {
    tags.push(['h', publicIdentifier]);
  }
  if (purpose) {
    tags.push(['purpose', purpose]);
  }
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
  return ({
    ...event,
    sig: toHex(signature)
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(path, { method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${baseUrl}${path}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
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

async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    const durationMs = Date.now() - startedAt;
    stepResults.push({ name, status: 'ok', durationMs });
    console.log(`[ok] ${name} (${durationMs}ms)`);
    return value;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    stepResults.push({ name, status: 'error', durationMs, error: error?.message || String(error) });
    throw error;
  }
}

async function main() {
  console.log('[LiveE2E] Starting gateway control-plane e2e', {
    baseUrl,
    relayKey,
    workerPubkey: workerPubkey.slice(0, 16)
  });

  const challenge = await step('auth.challenge', async () => {
    const payload = await requestJson('/api/v2/auth/challenge', {
      method: 'POST',
      body: {
        workerPubkey
      }
    });
    assert(typeof payload?.challenge === 'string' && payload.challenge.length > 0, 'Missing challenge');
    return payload;
  });

  const challengeSignature = await step('auth.sign', async () => {
    return await createChallengeSignature(challenge.challenge, workerPrivkey);
  });

  const session = await step('auth.session', async () => {
    const payload = await requestJson('/api/v2/auth/session', {
      method: 'POST',
      body: {
        challenge: challenge.challenge,
        workerPubkey,
        signature: challengeSignature
      }
    });
    assert(typeof payload?.accessToken === 'string' && payload.accessToken.length > 10, 'Missing access token');
    return payload;
  });

  const authHeaders = {
    authorization: `Bearer ${session.accessToken}`
  };

  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' }
  ];

  await step('relay.register', async () => {
    const payload = await requestJson('/api/v2/relays/register', {
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
    assert(payload?.status === 'ok', 'Relay register did not return status=ok');
    return payload;
  });

  const mirror = await step('mirror.read', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/mirror`);
    assert(payload?.relayKey === relayKey, 'Mirror payload relayKey mismatch');
    return payload;
  });

  const openJoinEntry = {
    writerCore: randomHex(32),
    writerCoreHex: randomHex(32),
    autobaseLocal: randomHex(32),
    writerSecret: `secret-${randomHex(8)}`,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (10 * 60 * 1000)
  };

  await step('open_join.pool_sync', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/pool`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        entries: [openJoinEntry],
        updatedAt: Date.now(),
        targetSize: 1,
        publicIdentifier: relayKey,
        relayCores
      }
    });
    assert(payload?.status === 'ok', 'Open join pool sync failed');
    return payload;
  });

  const openJoinChallenge = await step('open_join.challenge', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/challenge`);
    assert(typeof payload?.challenge === 'string' && payload.challenge.length > 0, 'Missing open-join challenge');
    return payload;
  });

  const openJoinAuthEvent = await step('open_join.auth_event', async () => {
    return await buildNostrAuthEvent({
      relay: baseUrl,
      challenge: openJoinChallenge.challenge,
      pubkey: workerPubkey,
      privkey: workerPrivkey,
      publicIdentifier: openJoinChallenge.publicIdentifier || relayKey
    });
  });

  await step('open_join.lease_claim', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/lease`, {
      method: 'POST',
      body: {
        authEvent: openJoinAuthEvent
      }
    });
    assert(payload?.writerCore || payload?.writerCoreHex || payload?.autobaseLocal, 'Open join lease missing writer core');
    assert(payload?.certificate?.slotKey, 'Open join lease missing certificate');
    return payload;
  });

  await step('open_join.pool_sync_reseed', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/pool`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        entries: [{
          writerCore: randomHex(32),
          writerCoreHex: randomHex(32),
          autobaseLocal: randomHex(32),
          writerSecret: `secret-${randomHex(8)}`,
          issuedAt: Date.now(),
          expiresAt: Date.now() + (10 * 60 * 1000)
        }],
        updatedAt: Date.now(),
        targetSize: 1,
        publicIdentifier: relayKey,
        relayCores
      }
    });
    assert(payload?.status === 'ok', 'Open join reseed failed');
    return payload;
  });

  const appendChallenge = await step('open_join.append_challenge', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/challenge?purpose=append-cores`);
    assert(typeof payload?.challenge === 'string' && payload.challenge.length > 0, 'Missing append challenge');
    return payload;
  });

  const appendAuthEvent = await step('open_join.append_auth_event', async () => {
    return await buildNostrAuthEvent({
      relay: baseUrl,
      challenge: appendChallenge.challenge,
      pubkey: workerPubkey,
      privkey: workerPrivkey,
      publicIdentifier: appendChallenge.publicIdentifier || relayKey,
      purpose: 'append-cores'
    });
  });

  await step('open_join.append_cores', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/append-cores`, {
      method: 'POST',
      body: {
        authEvent: appendAuthEvent,
        relayKey,
        cores: [{ key: randomHex(32), role: 'file' }]
      }
    });
    assert(payload?.status === 'ok', 'Open join append-cores failed');
    return payload;
  });

  const closedJoinEnvelope = {
    alg: 'x25519-aes-256-gcm-v1',
    ciphertext: 'QQ',
    nonce: 'QQ',
    authTag: 'QQ',
    ephemeralPubkey: randomHex(32),
    recipientPubkey: randomHex(32),
    leaseId: `lease-${randomHex(8)}`,
    relayKey,
    purpose: 'closed-join',
    createdAt: Date.now(),
    expiresAt: Date.now() + (10 * 60 * 1000),
    envelopeVersion: 1
  };

  await step('closed_join.pool_sync', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/closed-join/pool`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        updatedAt: Date.now(),
        entries: [{
          writerCore: randomHex(32),
          writerCoreHex: randomHex(32),
          autobaseLocal: randomHex(32),
          writerEnvelope: closedJoinEnvelope,
          issuedAt: Date.now(),
          expiresAt: Date.now() + (10 * 60 * 1000)
        }]
      }
    });
    assert(payload?.status === 'ok', 'Closed join pool sync failed');
    return payload;
  });

  await step('closed_join.lease_claim', async () => {
    const payload = await requestJson(`/api/v2/relays/${encodeURIComponent(relayKey)}/closed-join/lease`, {
      method: 'POST',
      headers: authHeaders,
      body: {
        relayKey,
        recipientPubkey: randomHex(32)
      }
    });
    assert(payload?.writerEnvelope?.leaseId, 'Closed join lease missing envelope');
    assert(payload?.certificate?.slotKey, 'Closed join lease missing certificate');
    return payload;
  });

  await step('mesh.state.read', async () => {
    const payload = await requestJson('/api/v2/mesh/state?sinceSequence=0&limit=2000');
    const events = Array.isArray(payload?.events) ? payload.events : [];
    assert(events.length > 0, 'Mesh state log is empty');
    const eventTypes = new Set(events.map((entry) => entry?.eventType).filter(Boolean));
    const expected = [
      'RelayRegistered',
      'OpenJoinPoolUpdated',
      'OpenJoinAppendCoresUpdated',
      'ClosedJoinPoolUpdated',
      'LeaseCertificateCommitted'
    ];
    assert(expected.some((name) => eventTypes.has(name)), 'Mesh state missing expected event classes');
    return payload;
  });

  const syntheticEventId = `e2e-${randomHex(8)}`;
  await step('mesh.state.append', async () => {
    const payload = await requestJson('/api/v2/mesh/state/append', {
      method: 'POST',
      body: {
        event: {
          id: syntheticEventId,
          eventType: 'MirrorManifestUpdated',
          payload: {
            relayKey,
            data: mirror
          },
          metadata: {
            sourceGatewayId: session.gatewayPubkey || null,
            source: 'live-e2e'
          },
          timestamp: Date.now()
        }
      }
    });
    assert(payload?.status === 'appended' || payload?.status === 'duplicate', 'Mesh append failed');
    return payload;
  });

  await step('mesh.state.verify_append', async () => {
    const payload = await requestJson('/api/v2/mesh/state?sinceSequence=0&limit=3000');
    const events = Array.isArray(payload?.events) ? payload.events : [];
    assert(events.some((entry) => entry?.id === syntheticEventId), 'Synthetic mesh event not found');
    return payload;
  });

  console.log('[LiveE2E] Completed successfully');
  console.log(JSON.stringify({
    baseUrl,
    relayKey,
    workerPubkey,
    steps: stepResults
  }, null, 2));
}

main().catch((error) => {
  console.error('[LiveE2E] Failed', {
    error: error?.message || String(error),
    steps: stepResults
  });
  process.exitCode = 1;
});
