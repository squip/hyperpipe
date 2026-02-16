import { createHash } from 'node:crypto';

import { schnorr } from '@noble/curves/secp256k1';

import { CONTROL_METHODS } from '../../../shared/public-gateway/ControlPlaneMethods.mjs';
import { validateJoinMaterialBundle } from '../../../shared/public-gateway/JoinMaterialVerifier.mjs';
import { TrustPolicyEngine } from '../../../shared/public-gateway/TrustPolicyEngine.mjs';
import {
  assert,
  quantile,
  randomHex,
  requestJson,
  sleep,
  waitFor
} from '../harness/utils.mjs';

function toHex(value) {
  return Buffer.from(value).toString('hex');
}

function normalizeHex64(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeCoreRefs(coreRefs = []) {
  if (!Array.isArray(coreRefs)) return [];
  const dedup = new Set();
  for (const entry of coreRefs) {
    const key = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' ? entry.key : null);
    const normalized = normalizeString(key);
    if (!normalized) continue;
    dedup.add(normalizeHex64(normalized) || normalized);
  }
  return Array.from(dedup);
}

function mergeCoreRefs(...lists) {
  const dedup = new Set();
  for (const list of lists) {
    for (const ref of normalizeCoreRefs(list)) dedup.add(ref);
  }
  return Array.from(dedup);
}

function setEqual(a = [], b = []) {
  const left = normalizeCoreRefs(a).sort();
  const right = normalizeCoreRefs(b).sort();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  event.id = createHash('sha256').update(serialized).digest('hex');
  const signature = schnorr.sign(event.id, privkey);
  return {
    ...event,
    sig: toHex(signature)
  };
}

function makeOpenJoinEntry({ writerCoreKey = null } = {}) {
  const canonicalWriterCore = normalizeHex64(writerCoreKey) || normalizeString(writerCoreKey) || randomHex(32);
  return {
    writerCore: canonicalWriterCore,
    writerCoreHex: canonicalWriterCore,
    autobaseLocal: canonicalWriterCore,
    writerSecret: `secret-${randomHex(8)}`,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (10 * 60 * 1000)
  };
}

function makeClosedJoinEntry({ relayKey, recipientPubkey, writerCoreKey = null }) {
  const canonicalWriterCore = normalizeHex64(writerCoreKey) || normalizeString(writerCoreKey) || randomHex(32);
  return {
    writerCore: canonicalWriterCore,
    writerCoreHex: canonicalWriterCore,
    autobaseLocal: canonicalWriterCore,
    writerEnvelope: {
      alg: 'x25519-aes-256-gcm-v1',
      ciphertext: 'QQ',
      nonce: 'QQ',
      authTag: 'QQ',
      ephemeralPubkey: randomHex(32),
      recipientPubkey,
      leaseId: `lease-${randomHex(8)}`,
      relayKey,
      purpose: 'closed-join',
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
      envelopeVersion: 1
    },
    issuedAt: Date.now(),
    expiresAt: Date.now() + (10 * 60 * 1000)
  };
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

async function timed(ctx, metricName, fn) {
  const startedAt = Date.now();
  const value = await fn();
  ctx.recordTiming(metricName, elapsedMs(startedAt));
  return value;
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  const normalizedTimeout = Number.isFinite(Number(timeoutMs))
    ? Math.max(500, Math.round(Number(timeoutMs)))
    : 60_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${label}`));
    }, normalizedTimeout);
    timer.unref?.();
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function getAvailableWorker(ctx) {
  if (ctx.workers?.creator && !ctx.workers.creator.exited) return ctx.workers.creator;
  return ctx.workers.joiner;
}

function workerConfigWithPolicy(ctx, trustPolicy) {
  const base = ctx.cluster.workerGatewayConfig({
    transportMode: ctx.options?.transportMode || null
  });
  return {
    ...base,
    trustPolicy: {
      ...(base.trustPolicy || {}),
      ...(trustPolicy || {})
    }
  };
}

async function applyWorkerPolicy(ctx, trustPolicy) {
  const config = workerConfigWithPolicy(ctx, trustPolicy);
  if (!ctx.workers.creator?.exited) {
    await ctx.workers.creator.configurePublicGateway(config);
  }
  await ctx.workers.joiner.configurePublicGateway(config);
  return config;
}

async function ensureBridgeTrustBaseline(ctx) {
  const policy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };
  await ctx.workers.joiner.setTrustFixture({
    followsByMe: [],
    followersOfMe: [],
    attestations: []
  }, {
    timeoutMs: 120_000
  });
  await applyWorkerPolicy(ctx, policy);
}

function isGatewayUnavailableError(error) {
  const message = error?.message || '';
  return typeof message === 'string' && (
    message.includes('Requested gateway is unavailable')
    || message.includes('No gateways available for control request')
  );
}

async function runControlMethodWithGatewayRetry(ctx, worker, methodName, payload, options = {}, {
  timeoutMs = 30_000,
  intervalMs = 400,
  label = null
} = {}) {
  const requestTimeoutMs = Math.min(8_000, Math.max(1_500, Math.trunc(timeoutMs / 3) || 5_000));
  const requestOptions = {
    ...(options || {}),
    timeoutMs: Number.isFinite(Number(options?.timeoutMs))
      ? Math.max(500, Math.round(Number(options.timeoutMs)))
      : requestTimeoutMs
  };
  return waitFor(async () => {
    try {
      return await worker.runControlMethod(methodName, payload, requestOptions, {
        timeoutMs: requestOptions.timeoutMs + 2_000
      });
    } catch (error) {
      if (isGatewayUnavailableError(error)) return null;
      throw error;
    }
  }, {
    timeoutMs,
    intervalMs,
    label: label || `${methodName} gateway retry`
  });
}

function buildRelayMetadata({ relayKey, isOpen = true, isPublic = true }) {
  return {
    identifier: relayKey,
    isOpen,
    isPublic,
    isHosted: true,
    isJoined: false,
    metadataUpdatedAt: Date.now()
  };
}

function buildAuthorityPolicy(ctx, relayKey, {
  ownerNostrPubkey = null,
  minQuorumWeight = 2,
  validators = null,
  allowedGatewayPubkeys = null,
  issuedAt = null,
  expiresAt = null
} = {}) {
  const defaultValidators = [
    {
      gatewayPubkey: ctx.cluster.gatewayIds.a,
      weight: 1,
      caps: ['open-join', 'closed-join', 'mirror', 'bridge-source']
    },
    {
      gatewayPubkey: ctx.cluster.gatewayIds.b,
      weight: 1,
      caps: ['open-join', 'closed-join', 'mirror', 'bridge-source']
    }
  ];
  const selectedValidators = Array.isArray(validators) && validators.length
    ? validators
    : defaultValidators;

  const allowed = Array.isArray(allowedGatewayPubkeys) && allowedGatewayPubkeys.length
    ? allowedGatewayPubkeys
    : selectedValidators.map((entry) => entry.gatewayPubkey).filter(Boolean);

  return {
    relayKey,
    ownerNostrPubkey: ownerNostrPubkey || ctx.workers.creator?.pubkey || ctx.workers.joiner?.pubkey || randomHex(32),
    ownerSig: `owner-sig-${randomHex(8)}`,
    policyVersion: 1,
    issuedAt: Number.isFinite(Number(issuedAt)) ? Math.round(Number(issuedAt)) : Date.now(),
    expiresAt: Number.isFinite(Number(expiresAt)) ? Math.round(Number(expiresAt)) : null,
    minQuorumWeight,
    validators: selectedValidators,
    bridgeRules: {
      allowAnyValidatedSource: false,
      allowedGatewayPubkeys: allowed,
      maxBundleAgeMs: 15 * 60 * 1000
    }
  };
}

async function upsertRelayAuthorityPolicy(ctx, relayKey, policy, { gatewayAlias = 'a' } = {}) {
  const gatewayId = ctx.cluster.gatewayIds[gatewayAlias];
  const worker = getAvailableWorker(ctx);
  const result = await worker.runControlMethod(CONTROL_METHODS.RELAY_AUTHORITY_UPSERT, {
    relayKey,
    policy
  }, {
    gatewayId,
    onlyGateway: true,
    hedged: false
  });
  assert(result?.data?.policy?.relayKey === relayKey, `relay authority upsert failed (${relayKey})`);
  return result.data.policy;
}

async function waitForMeshEvent(ctx, gatewayAlias, predicate, {
  timeoutMs = 25_000,
  intervalMs = 500,
  label = 'mesh event'
} = {}) {
  return waitFor(async () => {
    const state = await ctx.cluster.requestGateway(gatewayAlias, '/api/v2/mesh/state?sinceSequence=0&limit=5000');
    const events = Array.isArray(state?.events) ? state.events : [];
    return events.find((event) => {
      try {
        return predicate(event);
      } catch (_) {
        return false;
      }
    }) || null;
  }, {
    timeoutMs,
    intervalMs,
    label
  });
}

function extractMirrorCoreRefs(payload = {}) {
  const direct = normalizeCoreRefs(payload?.coreRefs || payload?.cores || []);
  if (direct.length) return direct;
  const cores = Array.isArray(payload?.mirror?.cores) ? payload.mirror.cores : [];
  return normalizeCoreRefs(cores);
}

function extractBundleCoreRefs(bundle = {}) {
  return mergeCoreRefs(
    bundle?.mirror?.coreRefs || [],
    bundle?.mirror?.cores || []
  );
}

function extractBundleJoinKeys(bundle = {}) {
  const writerCore = normalizeString(bundle?.lease?.writerCore || null);
  const writerCoreHex = normalizeString(bundle?.lease?.writerCoreHex || bundle?.lease?.autobaseLocal || null);
  const autobaseLocal = normalizeString(bundle?.lease?.autobaseLocal || bundle?.lease?.writerCoreHex || null);
  return {
    writerCore,
    writerCoreHex,
    autobaseLocal,
    coreRefs: extractBundleCoreRefs(bundle),
    fastForwardKey: normalizeString(bundle?.mirror?.fastForward?.key || null),
    blindPeerPublicKey: normalizeString(bundle?.mirror?.blindPeer?.publicKey || null),
    slotKey: normalizeString(bundle?.lease?.certificate?.slotKey || null),
    quorum: Number.isFinite(Number(bundle?.lease?.certificate?.quorum))
      ? Number(bundle.lease.certificate.quorum)
      : null,
    policyHash: normalizeString(bundle?.authorityPolicyHash || bundle?.lease?.certificate?.authorityPolicyHash || null),
    materialDigest: normalizeString(bundle?.materialDigest || bundle?.lease?.certificate?.materialDigest || null)
  };
}

function summarizeJoinStats(records = []) {
  const values = (Array.isArray(records) ? records : [])
    .map((entry) => Number(entry?.joinToWritableMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return {
    count: values.length,
    min: values.length ? values[0] : null,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: values.length ? values[values.length - 1] : null
  };
}

function resolveJoinDiagRecord(diag, { relayKey = null, publicIdentifier = null } = {}) {
  if (!diag) return null;
  if (Array.isArray(diag)) {
    return diag.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (relayKey && entry.relayKey === relayKey) return true;
      if (publicIdentifier && entry.publicIdentifier === publicIdentifier) return true;
      return false;
    }) || diag[0] || null;
  }
  if (diag && typeof diag === 'object') return diag;
  return null;
}

function matchJoinMessage(message, { relayKey = null, publicIdentifier = null, type = null } = {}) {
  if (!message || typeof message !== 'object') return false;
  if (type && message.type !== type) return false;
  const data = message?.data && typeof message.data === 'object' ? message.data : {};
  if (relayKey && data.relayKey === relayKey) return true;
  if (publicIdentifier && data.publicIdentifier === publicIdentifier) return true;
  return false;
}

async function issueOpenJoinLease(ctx, {
  relay,
  gatewayAlias = 'a',
  worker = null,
  purpose = null
} = {}) {
  const actor = worker || ctx.workers.joiner;
  const gatewayId = ctx.cluster.gatewayIds[gatewayAlias];

  const challengeResult = await actor.runControlMethod(CONTROL_METHODS.OPEN_JOIN_CHALLENGE, {
    relayKey: relay.relayKey,
    ...(purpose ? { purpose } : {})
  }, {
    gatewayId,
    onlyGateway: true,
    hedged: false
  });

  const challenge = challengeResult?.data?.challenge;
  assert(typeof challenge === 'string' && challenge.length > 0, 'open join challenge missing');

  const authEvent = buildNostrAuthEvent({
    relay: ctx.cluster.gatewayBaseUrl(gatewayAlias),
    challenge,
    pubkey: actor.pubkey,
    privkey: actor.privkey,
    publicIdentifier: challengeResult?.data?.publicIdentifier || relay.publicIdentifier,
    purpose: purpose || null
  });

  const leaseResult = await timed(ctx, 'open_join.lease_claim', async () => {
    return actor.runControlMethod(CONTROL_METHODS.OPEN_JOIN_LEASE_CLAIM, {
      relayKey: relay.relayKey,
      authEvent
    }, {
      gatewayId,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(leaseResult?.data?.certificate?.slotKey, 'open join lease certificate missing');
  return leaseResult;
}

async function issueClosedJoinLease(ctx, {
  relay,
  recipientPubkey,
  gatewayAlias = 'a',
  worker = null
} = {}) {
  const actor = worker || ctx.workers.joiner;
  const gatewayId = ctx.cluster.gatewayIds[gatewayAlias];

  const leaseResult = await timed(ctx, 'closed_join.lease_claim', async () => {
    return actor.runControlMethod(CONTROL_METHODS.CLOSED_JOIN_LEASE_CLAIM, {
      relayKey: relay.relayKey,
      recipientPubkey
    }, {
      gatewayId,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(leaseResult?.data?.certificate?.slotKey, 'closed join lease certificate missing');
  assert(leaseResult?.data?.writerEnvelope, 'closed join lease envelope missing');
  return leaseResult;
}

async function ensureControlRelay(ctx) {
  if (ctx.state.controlRelay?.relayKey) return ctx.state.controlRelay;

  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' }
  ];

  const worker = getAvailableWorker(ctx);
  const registerPayload = {
    relayKey,
    peers: [],
    metadata: buildRelayMetadata({ relayKey, isOpen: true, isPublic: true }),
    relayCores,
    relayCoresMode: 'merge'
  };

  for (const gatewayId of [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]) {
    // Keep control relay metadata present on both gateways for parity scenarios.
    // Mesh replication may be intentionally degraded in local live test runs.
    const result = await worker.runControlMethod(CONTROL_METHODS.RELAY_REGISTER, registerPayload, {
      gatewayId,
      onlyGateway: true,
      hedged: false
    });
    assert(result?.data?.status === 'ok', `relay register failed while ensuring control relay (${gatewayId})`);
  }

  ctx.state.controlRelay = {
    relayKey,
    relayCores,
    publicIdentifier: relayKey
  };
  return ctx.state.controlRelay;
}

async function ensureBridgeOpenFixture(ctx) {
  if (ctx.state.bridgeOpenFixture?.relayKey) return ctx.state.bridgeOpenFixture;
  await ensureBridgeTrustBaseline(ctx);

  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' },
    { key: randomHex(32), role: 'file' }
  ];

  const registerResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.RELAY_REGISTER, {
    relayKey,
    peers: [],
    metadata: buildRelayMetadata({ relayKey, isOpen: true, isPublic: true }),
    relayCores,
    relayCoresMode: 'merge'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(registerResult?.data?.status === 'ok', 'bridge open fixture relay register failed');
  ctx.log('[fixture:bridge-open] relay.register complete', { relayKey });

  const relayPolicy = buildAuthorityPolicy(ctx, relayKey, {
    minQuorumWeight: 2,
    allowedGatewayPubkeys: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]
  });
  await upsertRelayAuthorityPolicy(ctx, relayKey, relayPolicy, { gatewayAlias: 'a' });
  await upsertRelayAuthorityPolicy(ctx, relayKey, relayPolicy, { gatewayAlias: 'b' });
  ctx.log('[fixture:bridge-open] authority upsert complete', { relayKey });

  const entry = makeOpenJoinEntry({ writerCoreKey: relayCores[0]?.key || null });
  const poolResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, {
    relayKey,
    entries: [entry],
    updatedAt: Date.now(),
    targetSize: 1,
    publicIdentifier: relayKey,
    relayCores
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(poolResult?.data?.status === 'ok', 'bridge open fixture pool sync failed');
  ctx.log('[fixture:bridge-open] open_join.pool_sync complete', { relayKey });

  const leaseResult = await issueOpenJoinLease(ctx, {
    relay: { relayKey, publicIdentifier: relayKey },
    gatewayAlias: 'a',
    worker: ctx.workers.joiner
  });
  ctx.log('[fixture:bridge-open] open_join.lease complete', { relayKey });

  const bundleReadA = await waitFor(async () => {
    const response = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
      relayKey,
      purpose: 'open-join'
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
    const bundle = response?.data?.bundle || null;
    return bundle && typeof bundle === 'object' ? bundle : null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 500,
    label: 'bridge open fixture bundle read gateway-a'
  });
  ctx.log('[fixture:bridge-open] bridge.bundle.read gateway-a complete', { relayKey });

  await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_PUSH, {
    relayKey,
    purpose: 'open-join',
    bundle: bundleReadA
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });
  ctx.log('[fixture:bridge-open] bridge.bundle.push gateway-b complete', { relayKey });

  ctx.state.bridgeOpenFixture = {
    relayKey,
    publicIdentifier: relayKey,
    relayCores,
    entry,
    lease: leaseResult?.data || null
  };
  return ctx.state.bridgeOpenFixture;
}

async function ensureBridgeClosedFixture(ctx) {
  if (ctx.state.bridgeClosedFixture?.relayKey) return ctx.state.bridgeClosedFixture;
  await ensureBridgeTrustBaseline(ctx);

  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' },
    { key: randomHex(32), role: 'file' }
  ];
  const recipientPubkey = randomHex(32);

  const registerResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.RELAY_REGISTER, {
    relayKey,
    peers: [],
    metadata: buildRelayMetadata({ relayKey, isOpen: false, isPublic: false }),
    relayCores,
    relayCoresMode: 'merge'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(registerResult?.data?.status === 'ok', 'bridge closed fixture relay register failed');
  ctx.log('[fixture:bridge-closed] relay.register complete', { relayKey });

  const relayPolicy = buildAuthorityPolicy(ctx, relayKey, {
    minQuorumWeight: 2,
    allowedGatewayPubkeys: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]
  });
  await upsertRelayAuthorityPolicy(ctx, relayKey, relayPolicy, { gatewayAlias: 'a' });
  await upsertRelayAuthorityPolicy(ctx, relayKey, relayPolicy, { gatewayAlias: 'b' });
  ctx.log('[fixture:bridge-closed] authority upsert complete', { relayKey });

  const entry = makeClosedJoinEntry({
    relayKey,
    recipientPubkey,
    writerCoreKey: relayCores[0]?.key || null
  });
  const poolResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC, {
    relayKey,
    entries: [entry],
    updatedAt: Date.now(),
    publicIdentifier: relayKey,
    relayCores
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(poolResult?.data?.status === 'ok', 'bridge closed fixture pool sync failed');
  ctx.log('[fixture:bridge-closed] closed_join.pool_sync complete', { relayKey });

  const leaseResult = await issueClosedJoinLease(ctx, {
    relay: { relayKey, publicIdentifier: relayKey },
    recipientPubkey,
    gatewayAlias: 'a',
    worker: ctx.workers.joiner
  });
  ctx.log('[fixture:bridge-closed] closed_join.lease complete', { relayKey });

  const bundleReadA = await waitFor(async () => {
    const response = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
      relayKey,
      purpose: 'closed-join'
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
    const bundle = response?.data?.bundle || null;
    return bundle && typeof bundle === 'object' ? bundle : null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 500,
    label: 'bridge closed fixture bundle read gateway-a'
  });
  ctx.log('[fixture:bridge-closed] bridge.bundle.read gateway-a complete', { relayKey });

  await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_PUSH, {
    relayKey,
    purpose: 'closed-join',
    bundle: bundleReadA
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });
  ctx.log('[fixture:bridge-closed] bridge.bundle.push gateway-b complete', { relayKey });

  ctx.state.bridgeClosedFixture = {
    relayKey,
    publicIdentifier: relayKey,
    relayCores,
    recipientPubkey,
    entry,
    lease: leaseResult?.data || null
  };
  return ctx.state.bridgeClosedFixture;
}

async function ensureWorkerRelayFixtures(ctx) {
  if (ctx.state.workerRelay?.relayKey && ctx.state.workerClosedRelay?.relayKey && ctx.state.workerClosedInvite) {
    return {
      openRelay: ctx.state.workerRelay,
      closedRelay: ctx.state.workerClosedRelay,
      closedInvite: ctx.state.workerClosedInvite
    };
  }

  assert(!ctx.workers.creator.exited, 'creator worker is offline; worker relay fixtures unavailable');

  const openResult = await ctx.workers.creator.createRelay({
    name: `Live Matrix Open ${randomHex(3)}`,
    description: 'matrix e2e worker create open relay',
    isPublic: true,
    isOpen: true,
    fileSharing: true
  }, {
    timeoutMs: 180_000
  });
  assert(openResult?.success !== false, 'worker create open relay returned success=false');
  assert(typeof openResult?.relayKey === 'string', 'worker create open relay missing relay key');
  if (openResult?.gatewayRegistration === 'failed') {
    throw new Error(`worker create open relay gateway registration failed: ${openResult?.registrationError || 'unknown-error'}`);
  }

  const closedResult = await ctx.workers.creator.createRelay({
    name: `Live Matrix Closed ${randomHex(3)}`,
    description: 'matrix e2e worker create closed relay',
    isPublic: false,
    isOpen: false,
    fileSharing: true
  }, {
    timeoutMs: 180_000
  });
  assert(closedResult?.success !== false, 'worker create closed relay returned success=false');
  assert(typeof closedResult?.relayKey === 'string', 'worker create closed relay missing relay key');
  if (closedResult?.gatewayRegistration === 'failed') {
    throw new Error(`worker create closed relay gateway registration failed: ${closedResult?.registrationError || 'unknown-error'}`);
  }

  const closedInvite = await ctx.workers.creator.request('provision-writer-for-invitee', {
    relayKey: closedResult.relayKey,
    publicIdentifier: closedResult.publicIdentifier,
    inviteePubkey: ctx.workers.joiner.pubkey,
    useWriterPool: true
  }, {
    timeoutMs: 180_000
  });

  assert(closedInvite?.writerSecret, 'closed relay invite provisioning missing writerSecret');
  assert(closedInvite?.writerCoreHex || closedInvite?.autobaseLocal, 'closed relay invite provisioning missing writer core material');

  const readMirrorFromAnyGateway = async (relayKey) => {
    let lastError = null;
    for (const gatewayId of [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await ctx.workers.creator.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
          relayKey
        }, {
          gatewayId,
          onlyGateway: true,
          hedged: false
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('mirror-read-failed');
  };

  const openMirrorResult = await readMirrorFromAnyGateway(openResult.relayKey);
  const closedMirrorResult = await readMirrorFromAnyGateway(closedResult.relayKey);

  ctx.state.workerRelay = {
    relayKey: openResult.relayKey,
    publicIdentifier: openResult.publicIdentifier,
    relayUrl: openResult.relayUrl || null,
    hostPeer: ctx.workers.creator.swarmPublicKey,
    mirror: openMirrorResult?.data || null
  };

  ctx.state.workerClosedRelay = {
    relayKey: closedResult.relayKey,
    publicIdentifier: closedResult.publicIdentifier,
    relayUrl: closedResult.relayUrl || null,
    hostPeer: ctx.workers.creator.swarmPublicKey,
    mirror: closedMirrorResult?.data || null
  };

  ctx.state.workerClosedInvite = {
    ...closedInvite,
    token: `invite-${randomHex(12)}`
  };

  return {
    openRelay: ctx.state.workerRelay,
    closedRelay: ctx.state.workerClosedRelay,
    closedInvite: ctx.state.workerClosedInvite
  };
}

async function ensureCreatorOffline(ctx) {
  if (ctx.workers.creator?.exited) return;
  await ctx.workers.creator.shutdown({ timeoutMs: 12_000 });
}

async function runOfflineJoinAndCollect(ctx, {
  mode,
  relay,
  joinPayload,
  timeoutMs = 180_000
}) {
  const joinStartedAtMs = Date.now();
  ctx.workers.joiner.send({
    type: 'start-join-flow',
    data: joinPayload
  });

  const authOutcome = await withTimeout(ctx.workers.joiner.waitForMessage((message) => {
    if (!matchJoinMessage(message, {
      relayKey: relay.relayKey,
      publicIdentifier: relay.publicIdentifier
    })) return false;
    return message?.type === 'join-auth-success' || message?.type === 'join-auth-error';
  }, {
    timeoutMs,
    label: `${mode} join auth outcome`
  }), timeoutMs + 5_000, `${mode} join auth outcome`);

  if (authOutcome?.type === 'join-auth-error') {
    throw new Error(`join flow failed (${mode}): ${authOutcome?.data?.error || 'unknown-error'}`);
  }

  await withTimeout(ctx.workers.joiner.waitForMessage((message) => {
    if (!matchJoinMessage(message, {
      relayKey: relay.relayKey,
      publicIdentifier: relay.publicIdentifier,
      type: 'relay-writable'
    })) return false;
    return message?.data?.writable === true;
  }, {
    timeoutMs,
    label: `${mode} relay writable`
  }), timeoutMs + 5_000, `${mode} relay writable`);

  const diagRaw = await waitFor(async () => {
    const value = await ctx.workers.joiner.getRelayJoinDiagnostics({
      relayKey: relay.relayKey,
      publicIdentifier: relay.publicIdentifier
    }, {
      timeoutMs: 15_000
    });
    const record = resolveJoinDiagRecord(value, {
      relayKey: relay.relayKey,
      publicIdentifier: relay.publicIdentifier
    });
    if (!record) return null;
    return record;
  }, {
    timeoutMs: 25_000,
    intervalMs: 300,
    label: `${mode} join diagnostics`
  });

  const joinToWritable = {
    mode,
    joinToWritableMs: Number.isFinite(Number(diagRaw?.joinToWritableMs))
      ? Math.round(Number(diagRaw.joinToWritableMs))
      : Math.max(0, Date.now() - joinStartedAtMs),
    joinAuthToWritableMs: Number.isFinite(Number(diagRaw?.joinAuthToWritableMs))
      ? Math.round(Number(diagRaw.joinAuthToWritableMs))
      : null,
    writable: typeof diagRaw?.writable === 'boolean' ? diagRaw.writable : null,
    expectedWriterActive: typeof diagRaw?.expectedWriterActive === 'boolean' ? diagRaw.expectedWriterActive : null,
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier
  };

  assert(joinToWritable.writable === true, `${mode} join did not reach writable state`);
  if (diagRaw?.validation && diagRaw.validation.ok === false) {
    throw new Error(`${mode} join diagnostics validation failed: ${(diagRaw.validation.errors || []).join(',')}`);
  }

  if (!ctx.state.joinToWritableRecords) {
    ctx.state.joinToWritableRecords = [];
  }
  ctx.state.joinToWritableRecords.push(joinToWritable);

  ctx.recordTiming(`join_to_writable.${mode}`, joinToWritable.joinToWritableMs);
  if (Number.isFinite(Number(joinToWritable.joinAuthToWritableMs))) {
    ctx.recordTiming(`join_auth_to_writable.${mode}`, Number(joinToWritable.joinAuthToWritableMs));
  }

  return {
    joinToWritable,
    diagnostics: diagRaw
  };
}

async function scenarioInfraBoot(ctx) {
  await ctx.cluster.waitForHealthy();
  assert(ctx.workers.creator?.swarmPublicKey, 'creator worker missing swarm key');
  assert(ctx.workers.joiner?.swarmPublicKey, 'joiner worker missing swarm key');
  return {
    gatewayA: ctx.cluster.gatewayBaseUrl('a'),
    gatewayB: ctx.cluster.gatewayBaseUrl('b'),
    workerCreator: ctx.workers.creator.pubkey,
    workerJoiner: ctx.workers.joiner.pubkey
  };
}

async function scenarioTrustAllowlistPass(ctx) {
  const policy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };

  await ctx.workers.joiner.setTrustFixture({
    followsByMe: [],
    followersOfMe: [],
    attestations: []
  }, {
    timeoutMs: 120_000
  });
  await applyWorkerPolicy(ctx, policy);

  const resA = await runControlMethodWithGatewayRetry(ctx, ctx.workers.joiner, 'MESH_CATALOG_READ', {}, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  }, {
    timeoutMs: 45_000,
    label: 'allowlist pass gateway-a availability'
  });
  const resB = await runControlMethodWithGatewayRetry(ctx, ctx.workers.joiner, 'MESH_CATALOG_READ', {}, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  }, {
    timeoutMs: 45_000,
    label: 'allowlist pass gateway-b availability'
  });

  assert(resA?.gatewayId === ctx.cluster.gatewayIds.a, 'allowlist pass gateway-a mismatch');
  assert(resB?.gatewayId === ctx.cluster.gatewayIds.b, 'allowlist pass gateway-b mismatch');
  return {
    gatewayA: resA.gatewayId,
    gatewayB: resB.gatewayId
  };
}

async function scenarioTrustAllowlistBlock(ctx) {
  const policy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };

  await ctx.workers.joiner.setTrustFixture({ followsByMe: [], followersOfMe: [], attestations: [] }, {
    timeoutMs: 120_000
  });
  await applyWorkerPolicy(ctx, policy);

  await ctx.workers.joiner.runControlMethod('MESH_CATALOG_READ', {}, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  const blocked = await waitFor(async () => {
    try {
      await ctx.workers.joiner.runControlMethod('MESH_CATALOG_READ', {}, {
        gatewayId: ctx.cluster.gatewayIds.b,
        onlyGateway: true,
        hedged: false
      });
      return false;
    } catch (error) {
      const message = String(error?.message || '');
      return message.includes('Requested gateway is unavailable')
        || message.includes('No gateways available for control request')
        || message.includes('No gateways available');
    }
  }, {
    timeoutMs: 45_000,
    intervalMs: 400,
    label: 'allowlist block gateway-b filtered'
  });

  assert(blocked, 'allowlist block did not block gateway-b control request');
  return {
    blockedGatewayId: ctx.cluster.gatewayIds.b
  };
}

async function scenarioTrustWotFollowPass(ctx) {
  const policy = {
    explicitAllowlist: [],
    requireFollowedByMe: true,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };

  await ctx.workers.joiner.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    followersOfMe: [],
    attestations: []
  }, {
    timeoutMs: 120_000
  });
  await applyWorkerPolicy(ctx, policy);

  const engine = new TrustPolicyEngine({ policy });
  const evaluation = engine.evaluateGateway({
    gatewayPubkey: ctx.cluster.gatewayIds.b,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000)
  }, {
    followsByMe: new Set([ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]),
    followersOfMe: new Set(),
    attestations: []
  });

  assert(evaluation?.trusted === true, 'WOT follow pass policy evaluation did not trust gateway-b');

  const res = await runControlMethodWithGatewayRetry(ctx, ctx.workers.joiner, 'MESH_CATALOG_READ', {}, {
    hedged: false
  }, {
    timeoutMs: 30_000,
    label: 'wot follow pass control availability'
  });

  assert(typeof res?.gatewayId === 'string' && res.gatewayId.length > 0, 'WOT follow pass control request failed');
  return {
    gatewayId: res.gatewayId,
    evaluatedGatewayId: ctx.cluster.gatewayIds.b
  };
}

async function scenarioTrustWotFollowBlock(ctx) {
  const policy = {
    explicitAllowlist: [],
    requireFollowedByMe: true,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };
  await ctx.workers.joiner.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a],
    followersOfMe: [],
    attestations: []
  }, {
    timeoutMs: 120_000
  });
  await applyWorkerPolicy(ctx, policy);

  let blocked = false;
  try {
    await ctx.workers.joiner.runControlMethod('MESH_CATALOG_READ', {}, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  } catch (_) {
    blocked = true;
  }

  assert(blocked, 'WOT follow block did not block gateway-b');
  return { blockedGatewayId: ctx.cluster.gatewayIds.b };
}

async function scenarioBridgeOpenJoinPass(ctx) {
  const fixture = await ensureBridgeOpenFixture(ctx);

  const readResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'open-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });

  const bundle = readResult?.data?.bundle;
  assert(bundle && typeof bundle === 'object', 'bridge open join bundle missing');

  const verification = validateJoinMaterialBundle(bundle, {
    expectedRelayKey: fixture.relayKey,
    expectedPurpose: 'open-join',
    minQuorum: 2,
    requireWritableMaterial: true
  });

  const verificationErrors = (verification?.errors || []).filter((entry) => entry !== 'missing-blind-peer-public-key');
  assert(verificationErrors.length === 0, `bridge open join bundle invalid: ${verificationErrors.join(',')}`);
  const allowedSources = new Set([ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]);
  assert(
    typeof bundle?.sourceGatewayPubkey === 'string' && allowedSources.has(bundle.sourceGatewayPubkey),
    'bridge open join source gateway mismatch'
  );

  return {
    relayKey: fixture.relayKey,
    sourceGatewayPubkey: bundle?.sourceGatewayPubkey || null,
    materialDigest: bundle?.materialDigest || null
  };
}

async function scenarioBridgeClosedJoinPass(ctx) {
  const fixture = await ensureBridgeClosedFixture(ctx);

  const readResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'closed-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });

  const bundle = readResult?.data?.bundle;
  assert(bundle && typeof bundle === 'object', 'bridge closed join bundle missing');

  const verification = validateJoinMaterialBundle(bundle, {
    expectedRelayKey: fixture.relayKey,
    expectedPurpose: 'closed-join',
    minQuorum: 2,
    requireWritableMaterial: true
  });

  const verificationErrors = (verification?.errors || []).filter((entry) => entry !== 'missing-blind-peer-public-key');
  assert(verificationErrors.length === 0, `bridge closed join bundle invalid: ${verificationErrors.join(',')}`);
  const allowedSources = new Set([ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]);
  assert(
    typeof bundle?.sourceGatewayPubkey === 'string' && allowedSources.has(bundle.sourceGatewayPubkey),
    'bridge closed join source gateway mismatch'
  );
  assert(bundle?.closedJoin?.writerEnvelope, 'bridge closed join writer envelope missing');

  return {
    relayKey: fixture.relayKey,
    sourceGatewayPubkey: bundle?.sourceGatewayPubkey || null,
    materialDigest: bundle?.materialDigest || null
  };
}

async function scenarioBridgePolicyBlock(ctx) {
  await ensureBridgeTrustBaseline(ctx);
  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' }
  ];

  const registerResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.RELAY_REGISTER, {
    relayKey,
    peers: [],
    metadata: buildRelayMetadata({ relayKey, isOpen: true, isPublic: true }),
    relayCores,
    relayCoresMode: 'merge'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(registerResult?.data?.status === 'ok', 'bridge policy block relay register failed');

  const openEntry = makeOpenJoinEntry({ writerCoreKey: relayCores[0]?.key || null });
  const poolResult = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, {
    relayKey,
    entries: [openEntry],
    updatedAt: Date.now(),
    targetSize: 1,
    publicIdentifier: relayKey,
    relayCores
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(poolResult?.data?.status === 'ok', 'bridge policy block pool sync failed');

  const allowPolicy = buildAuthorityPolicy(ctx, relayKey, {
    allowedGatewayPubkeys: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]
  });
  await upsertRelayAuthorityPolicy(ctx, relayKey, allowPolicy, { gatewayAlias: 'a' });
  await upsertRelayAuthorityPolicy(ctx, relayKey, allowPolicy, { gatewayAlias: 'b' });

  await issueOpenJoinLease(ctx, {
    relay: { relayKey, publicIdentifier: relayKey },
    gatewayAlias: 'a',
    worker: ctx.workers.joiner
  });

  const blockedPolicy = buildAuthorityPolicy(ctx, relayKey, {
    allowedGatewayPubkeys: [`unknown-${randomHex(6)}`]
  });
  const upserted = await upsertRelayAuthorityPolicy(ctx, relayKey, blockedPolicy, { gatewayAlias: 'a' });
  await upsertRelayAuthorityPolicy(ctx, relayKey, blockedPolicy, { gatewayAlias: 'b' });

  await waitFor(async () => {
    const authority = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.RELAY_AUTHORITY_READ, {
      relayKey
    }, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
    return authority?.data?.policy?.policyHash === upserted.policyHash;
  }, {
    timeoutMs: 30_000,
    intervalMs: 500,
    label: 'bridge policy replication block'
  });

  let blocked = false;
  let statusCode = null;
  try {
    await ctx.cluster.requestGateway('b', `/api/v2/bridge/relays/${encodeURIComponent(relayKey)}/bundle/read`, {
      method: 'POST',
      body: {
        relayKey,
        purpose: 'open-join'
      }
    });
  } catch (error) {
    statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : null;
    blocked = statusCode === 404 || String(error?.message || '').includes('bridge-bundle-not-found');
  }

  assert(blocked, 'bridge policy block did not block bundle read on gateway-b');
  return {
    relayKey,
    blocked,
    statusCode,
    policyHash: upserted.policyHash
  };
}

async function scenarioControlAuth(ctx) {
  const challengeResult = await timed(ctx, 'auth.challenge_session', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.AUTH_CHALLENGE, {
      workerPubkey: ctx.workers.joiner.pubkey
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
  });

  const challenge = challengeResult?.data?.challenge;
  assert(typeof challenge === 'string' && challenge.length > 0, 'control auth challenge missing');

  const signature = createChallengeSignature(challenge, ctx.workers.joiner.privkey);
  const sessionResult = await timed(ctx, 'auth.challenge_session', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.AUTH_SESSION, {
      challenge,
      workerPubkey: ctx.workers.joiner.pubkey,
      signature
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(typeof sessionResult?.data?.accessToken === 'string', 'control auth session token missing');
  return {
    challenge: challenge.slice(0, 12),
    expiresAt: sessionResult?.data?.expiresAt || null
  };
}

async function scenarioControlRelayRegister(ctx) {
  const relay = await ensureControlRelay(ctx);
  return {
    relayKey: relay.relayKey,
    coreCount: relay.relayCores.length
  };
}

async function scenarioControlMirrorRead(ctx) {
  const relay = await ensureControlRelay(ctx);
  const mirror = await timed(ctx, 'mirror.read', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
      relayKey: relay.relayKey
    }, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(mirror?.data?.relayKey === relay.relayKey, 'mirror relay key mismatch');
  return {
    relayKey: relay.relayKey,
    gatewayId: mirror?.gatewayId || null
  };
}

async function scenarioOpenJoinPoolSync(ctx) {
  const relay = await ensureControlRelay(ctx);
  const entry = makeOpenJoinEntry({ writerCoreKey: relay.relayCores?.[0]?.key || null });
  for (const gatewayId of [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]) {
    const result = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, {
      relayKey: relay.relayKey,
      entries: [entry],
      updatedAt: Date.now(),
      targetSize: 1,
      publicIdentifier: relay.publicIdentifier,
      relayCores: relay.relayCores
    }, {
      gatewayId,
      onlyGateway: true,
      hedged: false
    });
    assert(result?.data?.status === 'ok', `open join pool sync failed (${gatewayId})`);
  }
  ctx.state.controlOpenJoinEntry = entry;
  return { relayKey: relay.relayKey, writerCore: entry.writerCore };
}

async function scenarioOpenJoinChallengeLease(ctx) {
  const relay = await ensureControlRelay(ctx);
  if (!ctx.state.controlOpenJoinEntry) {
    await scenarioOpenJoinPoolSync(ctx);
  }

  const leaseResult = await issueOpenJoinLease(ctx, {
    relay,
    gatewayAlias: 'b',
    worker: ctx.workers.joiner
  });

  return {
    relayKey: relay.relayKey,
    leaseId: leaseResult?.data?.certificate?.leaseId || null
  };
}

async function scenarioOpenJoinAppendCores(ctx) {
  const relay = await ensureControlRelay(ctx);

  const challengeResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_CHALLENGE, {
    relayKey: relay.relayKey,
    purpose: 'append-cores'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  const challenge = challengeResult?.data?.challenge;
  assert(typeof challenge === 'string' && challenge.length > 0, 'append-cores challenge missing');

  const authEvent = buildNostrAuthEvent({
    relay: ctx.cluster.gatewayBaseUrl('a'),
    challenge,
    pubkey: ctx.workers.joiner.pubkey,
    privkey: ctx.workers.joiner.privkey,
    publicIdentifier: challengeResult?.data?.publicIdentifier || relay.publicIdentifier,
    purpose: 'append-cores'
  });

  const appendResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_APPEND_CORES, {
    relayKey: relay.relayKey,
    authEvent,
    cores: [{ key: randomHex(32), role: 'file' }]
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  assert(appendResult?.data?.status === 'ok', 'open join append cores failed');
  return {
    relayKey: relay.relayKey,
    status: appendResult?.data?.status
  };
}

async function scenarioClosedJoinPoolSync(ctx) {
  const relay = await ensureControlRelay(ctx);
  const recipient = randomHex(32);
  ctx.state.controlClosedJoinRecipientPubkey = recipient;

  const entry = makeClosedJoinEntry({
    relayKey: relay.relayKey,
    recipientPubkey: recipient,
    writerCoreKey: relay.relayCores?.[0]?.key || null
  });

  for (const gatewayId of [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]) {
    const result = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC, {
      relayKey: relay.relayKey,
      entries: [entry],
      updatedAt: Date.now(),
      publicIdentifier: relay.publicIdentifier,
      relayCores: relay.relayCores
    }, {
      gatewayId,
      onlyGateway: true,
      hedged: false
    });
    assert(result?.data?.status === 'ok', `closed join pool sync failed (${gatewayId})`);
  }
  return {
    relayKey: relay.relayKey,
    recipient
  };
}

async function scenarioClosedJoinLeaseClaim(ctx) {
  const relay = await ensureControlRelay(ctx);
  if (!ctx.state.controlClosedJoinRecipientPubkey) {
    await scenarioClosedJoinPoolSync(ctx);
  }

  const leaseResult = await issueClosedJoinLease(ctx, {
    relay,
    recipientPubkey: ctx.state.controlClosedJoinRecipientPubkey,
    gatewayAlias: 'b',
    worker: ctx.workers.joiner
  });

  return {
    relayKey: relay.relayKey,
    leaseId: leaseResult?.data?.writerEnvelope?.leaseId || null
  };
}

async function scenarioJoinKeysOpenParity(ctx) {
  const fixture = await ensureBridgeOpenFixture(ctx);

  const readA = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'open-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  const readB = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'open-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });

  const bundleA = readA?.data?.bundle || null;
  const bundleB = readB?.data?.bundle || null;
  assert(bundleA && bundleB, 'open join parity bundle missing');

  const keysA = extractBundleJoinKeys(bundleA);
  const keysB = extractBundleJoinKeys(bundleB);

  assert(keysA.writerCoreHex === keysB.writerCoreHex, 'open join parity writerCoreHex mismatch');
  assert(keysA.autobaseLocal === keysB.autobaseLocal, 'open join parity autobaseLocal mismatch');
  assert(setEqual(keysA.coreRefs, keysB.coreRefs), 'open join parity coreRefs mismatch');
  assert(keysA.blindPeerPublicKey === keysB.blindPeerPublicKey, 'open join parity blindPeer key mismatch');
  assert(keysA.slotKey === keysB.slotKey, 'open join parity certificate slot mismatch');

  return {
    relayKey: fixture.relayKey,
    writerCoreHex: keysA.writerCoreHex,
    coreRefsCount: keysA.coreRefs.length,
    blindPeerPublicKey: keysA.blindPeerPublicKey,
    slotKey: keysA.slotKey
  };
}

async function scenarioJoinKeysClosedParity(ctx) {
  const fixture = await ensureBridgeClosedFixture(ctx);

  const readA = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'closed-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  const readB = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
    relayKey: fixture.relayKey,
    purpose: 'closed-join'
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });

  const bundleA = readA?.data?.bundle || null;
  const bundleB = readB?.data?.bundle || null;
  assert(bundleA && bundleB, 'closed join parity bundle missing');

  const keysA = extractBundleJoinKeys(bundleA);
  const keysB = extractBundleJoinKeys(bundleB);

  assert(keysA.writerCoreHex === keysB.writerCoreHex, 'closed join parity writerCoreHex mismatch');
  assert(keysA.autobaseLocal === keysB.autobaseLocal, 'closed join parity autobaseLocal mismatch');
  assert(setEqual(keysA.coreRefs, keysB.coreRefs), 'closed join parity coreRefs mismatch');
  assert(keysA.blindPeerPublicKey === keysB.blindPeerPublicKey, 'closed join parity blindPeer key mismatch');
  assert(keysA.slotKey === keysB.slotKey, 'closed join parity certificate slot mismatch');

  const recipientA = normalizeString(bundleA?.closedJoin?.writerEnvelope?.recipientPubkey || null);
  const recipientB = normalizeString(bundleB?.closedJoin?.writerEnvelope?.recipientPubkey || null);
  assert(recipientA && recipientB && recipientA === recipientB, 'closed join parity recipient mismatch');

  return {
    relayKey: fixture.relayKey,
    writerCoreHex: keysA.writerCoreHex,
    coreRefsCount: keysA.coreRefs.length,
    blindPeerPublicKey: keysA.blindPeerPublicKey,
    slotKey: keysA.slotKey,
    recipientPubkey: recipientA
  };
}

async function scenarioJoinKeysMismatchFastFail(ctx) {
  const publicIdentifier = `mismatch-${randomHex(8)}`;
  const relayKey = randomHex(32);
  const writerCoreHex = randomHex(32);
  const autobaseLocal = randomHex(32);
  const coreRefs = [randomHex(32)];
  const fastForwardKey = randomHex(32);

  const startedAt = Date.now();
  ctx.workers.joiner.send({
    type: 'start-join-flow',
    data: {
      publicIdentifier,
      relayKey,
      openJoin: true,
      isOpen: true,
      fileSharing: true,
      writerCoreHex,
      autobaseLocal,
      writerSecret: `secret-${randomHex(8)}`,
      cores: coreRefs,
      fastForward: { key: fastForwardKey },
      hostPeers: []
    }
  });

  const outcome = await ctx.workers.joiner.waitForMessage((message) => {
    if (message?.type !== 'join-auth-error') return false;
    const data = message?.data || {};
    return data.publicIdentifier === publicIdentifier || data.relayKey === relayKey;
  }, {
    timeoutMs: 30_000,
    label: 'join mismatch fast fail'
  });

  const detectionMs = Date.now() - startedAt;
  ctx.recordTiming('key_mismatch_detection', detectionMs);

  const errorMessage = String(outcome?.data?.error || '');
  assert(errorMessage.includes('join-material-invalid'), 'join mismatch did not fail with join-material-invalid');
  assert(detectionMs <= 10_000, `join mismatch detection exceeded 10s (${detectionMs}ms)`);

  const diagRaw = await ctx.workers.joiner.getRelayJoinDiagnostics({
    relayKey,
    publicIdentifier
  }, {
    timeoutMs: 10_000
  });
  const diag = resolveJoinDiagRecord(diagRaw, { relayKey, publicIdentifier });
  assert(diag && diag.validation && diag.validation.ok === false, 'join mismatch diagnostics missing failed validation');

  return {
    relayKey,
    publicIdentifier,
    detectionMs,
    error: errorMessage,
    validationErrors: Array.isArray(diag?.validation?.errors) ? diag.validation.errors : []
  };
}

async function scenarioWorkerCreateRelay(ctx) {
  const fixtures = await ensureWorkerRelayFixtures(ctx);
  return {
    openRelay: {
      relayKey: fixtures.openRelay.relayKey,
      publicIdentifier: fixtures.openRelay.publicIdentifier,
      relayUrl: fixtures.openRelay.relayUrl || null
    },
    closedRelay: {
      relayKey: fixtures.closedRelay.relayKey,
      publicIdentifier: fixtures.closedRelay.publicIdentifier,
      relayUrl: fixtures.closedRelay.relayUrl || null
    },
    closedInvite: {
      writerCoreHex: fixtures.closedInvite.writerCoreHex || fixtures.closedInvite.autobaseLocal || null,
      hasWriterSecret: !!fixtures.closedInvite.writerSecret,
      token: fixtures.closedInvite.token || null
    }
  };
}

async function scenarioWorkerJoinRelayOfflinePeerOpen(ctx) {
  const fixtures = await ensureWorkerRelayFixtures(ctx);
  await ensureCreatorOffline(ctx);

  const relay = fixtures.openRelay;
  const mirrorCoreRefs = extractMirrorCoreRefs(relay?.mirror || {});
  const fastForward = relay?.mirror?.fastForward || null;
  const blindPeer = relay?.mirror?.blindPeer || null;

  const joinPayload = {
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier,
    relayUrl: relay.relayUrl,
    openJoin: true,
    isOpen: true,
    fileSharing: true,
    hostPeers: relay.hostPeer ? [relay.hostPeer] : [],
    cores: mirrorCoreRefs,
    fastForward,
    blindPeer
  };

  const { joinToWritable, diagnostics } = await runOfflineJoinAndCollect(ctx, {
    mode: 'open',
    relay,
    joinPayload,
    timeoutMs: 240_000
  });

  assert(diagnostics?.material?.coreRefsCount == null || diagnostics.material.coreRefsCount >= 1, 'open join diagnostics core refs missing');

  return {
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier,
    mode: diagnostics?.mode || 'open',
    joinToWritable,
    diagnostics
  };
}

async function scenarioWorkerJoinRelayOfflinePeerClosed(ctx) {
  const fixtures = await ensureWorkerRelayFixtures(ctx);
  await ensureCreatorOffline(ctx);

  const relay = fixtures.closedRelay;
  const invite = fixtures.closedInvite;
  const mirror = relay?.mirror || {};
  const coreRefs = mergeCoreRefs(invite?.poolCoreRefs || [], extractMirrorCoreRefs(mirror));

  const joinPayload = {
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier,
    relayUrl: relay.relayUrl,
    openJoin: false,
    isOpen: false,
    fileSharing: true,
    hostPeers: relay.hostPeer ? [relay.hostPeer] : [],
    token: invite?.token || `invite-${randomHex(10)}`,
    writerCore: invite?.writerCore || null,
    writerCoreHex: invite?.writerCoreHex || invite?.autobaseLocal || null,
    autobaseLocal: invite?.autobaseLocal || invite?.writerCoreHex || null,
    writerSecret: invite?.writerSecret || null,
    cores: coreRefs,
    fastForward: invite?.fastForward || mirror?.fastForward || null,
    blindPeer: mirror?.blindPeer || null
  };

  const { joinToWritable, diagnostics } = await runOfflineJoinAndCollect(ctx, {
    mode: 'closed',
    relay,
    joinPayload,
    timeoutMs: 240_000
  });

  assert(diagnostics?.material?.canonicalWriterKey, 'closed join diagnostics missing canonical writer key');

  return {
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier,
    mode: diagnostics?.mode || 'closed',
    joinToWritable,
    diagnostics
  };
}

async function scenarioFederationStateReplication(ctx) {
  const eventId = `federation-${randomHex(8)}`;
  await ctx.cluster.requestGateway('a', '/api/v2/mesh/state/append', {
    method: 'POST',
    body: {
      event: {
        id: eventId,
        eventType: 'MirrorManifestUpdated',
        payload: {
          relayKey: ctx.state.controlRelay?.relayKey || randomHex(32),
          data: {
            mirror: true,
            marker: randomHex(4)
          }
        },
        metadata: {
          sourceGatewayId: ctx.cluster.gatewayIds.a,
          source: 'live-matrix'
        },
        timestamp: Date.now()
      }
    }
  });

  await waitFor(async () => {
    const state = await ctx.cluster.requestGateway('b', '/api/v2/mesh/state?sinceSequence=0&limit=5000');
    const events = Array.isArray(state?.events) ? state.events : [];
    return events.some((entry) => entry?.id === eventId);
  }, {
    timeoutMs: 25_000,
    intervalMs: 500,
    label: 'federation state replication'
  });

  return { eventId };
}

async function scenarioFederationLeaseQuorum(ctx) {
  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' }
  ];
  const relay = {
    relayKey,
    relayCores,
    publicIdentifier: relayKey
  };

  const registerResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.RELAY_REGISTER, {
    relayKey,
    peers: [],
    metadata: buildRelayMetadata({ relayKey, isOpen: true, isPublic: true }),
    relayCores,
    relayCoresMode: 'merge'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(registerResult?.data?.status === 'ok', 'lease quorum relay register failed');

  const entry = makeOpenJoinEntry({ writerCoreKey: relay.relayCores?.[0]?.key || null });
  const poolResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, {
    relayKey: relay.relayKey,
    entries: [entry],
    updatedAt: Date.now(),
    targetSize: 1,
    publicIdentifier: relay.publicIdentifier,
    relayCores: relay.relayCores
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(poolResult?.data?.status === 'ok', 'lease quorum open-join pool sync failed');

  await waitFor(async () => {
    try {
      const challenge = await ctx.cluster.requestGateway('b', `/api/v2/relays/${encodeURIComponent(relay.relayKey)}/open-join/challenge`);
      return typeof challenge?.challenge === 'string' ? challenge : null;
    } catch (_) {
      return null;
    }
  }, {
    timeoutMs: 25_000,
    intervalMs: 500,
    label: 'lease quorum challenge availability on gateway-b'
  });

  const challengeA = await ctx.cluster.requestGateway('a', `/api/v2/relays/${encodeURIComponent(relay.relayKey)}/open-join/challenge`);
  const challengeB = await ctx.cluster.requestGateway('b', `/api/v2/relays/${encodeURIComponent(relay.relayKey)}/open-join/challenge`);

  const authEventA = buildNostrAuthEvent({
    relay: ctx.cluster.gatewayBaseUrl('a'),
    challenge: challengeA.challenge,
    pubkey: ctx.workers.joiner.pubkey,
    privkey: ctx.workers.joiner.privkey,
    publicIdentifier: relay.publicIdentifier
  });
  const authEventB = buildNostrAuthEvent({
    relay: ctx.cluster.gatewayBaseUrl('b'),
    challenge: challengeB.challenge,
    pubkey: ctx.workers.joiner.pubkey,
    privkey: ctx.workers.joiner.privkey,
    publicIdentifier: relay.publicIdentifier
  });

  const [resA, resB] = await Promise.allSettled([
    requestJson(`${ctx.cluster.gatewayBaseUrl('a')}/api/v2/relays/${encodeURIComponent(relay.relayKey)}/open-join/lease`, {
      method: 'POST',
      body: { authEvent: authEventA }
    }),
    requestJson(`${ctx.cluster.gatewayBaseUrl('b')}/api/v2/relays/${encodeURIComponent(relay.relayKey)}/open-join/lease`, {
      method: 'POST',
      body: { authEvent: authEventB }
    })
  ]);

  const successes = [resA, resB].filter((entry) => entry.status === 'fulfilled');
  assert(successes.length <= 1, 'lease quorum returned conflicting successful lease results');

  return {
    relayKey: relay.relayKey,
    successCount: successes.length,
    outcomes: [resA.status, resB.status]
  };
}

async function scenarioFailoverGatewayDown(ctx) {
  const relay = await ensureControlRelay(ctx);
  await ctx.cluster.stopGateway('a');

  const mirror = await timed(ctx, 'mirror.read', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
      relayKey: relay.relayKey
    }, {
      hedged: false
    });
  });

  assert(mirror?.gatewayId === ctx.cluster.gatewayIds.b, 'failover did not route to gateway-b');
  return {
    activeGatewayId: mirror.gatewayId
  };
}

async function scenarioRecoveryGatewayRestart(ctx) {
  await ctx.cluster.startGateway('a');

  const relay = await ensureControlRelay(ctx);
  const mirror = await waitFor(async () => {
    const result = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
      relayKey: relay.relayKey
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
    return result?.data?.relayKey === relay.relayKey ? result : null;
  }, {
    timeoutMs: 45_000,
    intervalMs: 1000,
    label: 'gateway-a mirror recovery'
  });

  return {
    gatewayId: mirror.gatewayId,
    relayKey: relay.relayKey
  };
}

async function scenarioPerfJoinWritable(ctx) {
  const records = Array.isArray(ctx.state.joinToWritableRecords)
    ? ctx.state.joinToWritableRecords
    : [];

  const open = records.filter((entry) => entry?.mode === 'open');
  const closed = records.filter((entry) => entry?.mode === 'closed');

  assert(open.length > 0, 'missing open join_to_writable samples');
  assert(closed.length > 0, 'missing closed join_to_writable samples');

  return {
    open: summarizeJoinStats(open),
    closed: summarizeJoinStats(closed)
  };
}

async function scenarioStabilityRepeat(ctx) {
  const relay = await ensureControlRelay(ctx);
  const iterations = Number.isFinite(Number(ctx.options?.stabilityIterations))
    ? Math.max(1, Math.round(Number(ctx.options.stabilityIterations)))
    : 5;

  const failures = [];
  for (let i = 0; i < iterations; i += 1) {
    try {
      await timed(ctx, 'mirror.read', async () => {
        const result = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
          relayKey: relay.relayKey
        }, {
          hedged: true
        });
        assert(result?.data?.relayKey === relay.relayKey, 'stability mirror mismatch');
        return result;
      });
    } catch (error) {
      failures.push({
        iteration: i,
        message: error?.message || String(error)
      });
    }
  }

  assert(failures.length === 0, `stability repeat failures: ${JSON.stringify(failures)}`);
  return {
    iterations,
    failures
  };
}

const SCENARIO_IMPLEMENTATIONS = {
  'infra.boot': scenarioInfraBoot,
  'trust.allowlist.pass': scenarioTrustAllowlistPass,
  'trust.allowlist.block': scenarioTrustAllowlistBlock,
  'trust.wot.follow.pass': scenarioTrustWotFollowPass,
  'trust.wot.follow.block': scenarioTrustWotFollowBlock,
  'bridge.open_join.pass': scenarioBridgeOpenJoinPass,
  'bridge.closed_join.pass': scenarioBridgeClosedJoinPass,
  'bridge.policy.block': scenarioBridgePolicyBlock,
  'control.auth': scenarioControlAuth,
  'control.relay.register': scenarioControlRelayRegister,
  'control.mirror.read': scenarioControlMirrorRead,
  'open_join.pool_sync': scenarioOpenJoinPoolSync,
  'open_join.challenge_lease': scenarioOpenJoinChallengeLease,
  'open_join.append_cores': scenarioOpenJoinAppendCores,
  'closed_join.pool_sync': scenarioClosedJoinPoolSync,
  'closed_join.lease_claim': scenarioClosedJoinLeaseClaim,
  'join.keys.open.parity': scenarioJoinKeysOpenParity,
  'join.keys.closed.parity': scenarioJoinKeysClosedParity,
  'join.keys.mismatch.fastfail': scenarioJoinKeysMismatchFastFail,
  'worker.create_relay': scenarioWorkerCreateRelay,
  'worker.join_relay_offline_peer.open': scenarioWorkerJoinRelayOfflinePeerOpen,
  'worker.join_relay_offline_peer.closed': scenarioWorkerJoinRelayOfflinePeerClosed,
  'federation.state_replication': scenarioFederationStateReplication,
  'federation.lease_quorum': scenarioFederationLeaseQuorum,
  'failover.gateway_down': scenarioFailoverGatewayDown,
  'recovery.gateway_restart': scenarioRecoveryGatewayRestart,
  'perf.join_writable': scenarioPerfJoinWritable,
  'stability.repeat': scenarioStabilityRepeat
};

const PROFILE_SCENARIOS = {
  smoke: [
    'infra.boot',
    'trust.allowlist.pass',
    'bridge.open_join.pass',
    'bridge.closed_join.pass',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'open_join.append_cores',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'join.keys.open.parity',
    'join.keys.closed.parity',
    'join.keys.mismatch.fastfail',
    'worker.create_relay',
    'worker.join_relay_offline_peer.open',
    'worker.join_relay_offline_peer.closed',
    'federation.state_replication',
    'failover.gateway_down',
    'recovery.gateway_restart',
    'perf.join_writable'
  ],
  full: [
    'infra.boot',
    'trust.allowlist.pass',
    'trust.allowlist.block',
    'trust.wot.follow.pass',
    'trust.wot.follow.block',
    'bridge.open_join.pass',
    'bridge.closed_join.pass',
    'bridge.policy.block',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'open_join.append_cores',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'join.keys.open.parity',
    'join.keys.closed.parity',
    'join.keys.mismatch.fastfail',
    'worker.create_relay',
    'worker.join_relay_offline_peer.open',
    'worker.join_relay_offline_peer.closed',
    'federation.state_replication',
    'federation.lease_quorum',
    'failover.gateway_down',
    'recovery.gateway_restart',
    'perf.join_writable',
    'stability.repeat'
  ],
  soak: [
    'infra.boot',
    'trust.allowlist.pass',
    'bridge.open_join.pass',
    'bridge.closed_join.pass',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'join.keys.open.parity',
    'join.keys.closed.parity',
    'worker.create_relay',
    'worker.join_relay_offline_peer.open',
    'worker.join_relay_offline_peer.closed',
    'federation.state_replication',
    'federation.lease_quorum',
    'stability.repeat',
    'perf.join_writable'
  ]
};

function resolveScenarioIds({ profile = 'smoke', scenarioList = [] } = {}) {
  const selectedProfile = Object.prototype.hasOwnProperty.call(PROFILE_SCENARIOS, profile)
    ? profile
    : 'smoke';
  if (!Array.isArray(scenarioList) || !scenarioList.length) {
    return [...PROFILE_SCENARIOS[selectedProfile]];
  }
  const unique = [];
  for (const item of scenarioList) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id) continue;
    if (!SCENARIO_IMPLEMENTATIONS[id]) {
      throw new Error(`Unknown scenario id: ${id}`);
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

export {
  PROFILE_SCENARIOS,
  SCENARIO_IMPLEMENTATIONS,
  resolveScenarioIds
};
