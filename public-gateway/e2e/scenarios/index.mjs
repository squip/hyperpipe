import { createHash, randomBytes } from 'node:crypto';

import { schnorr } from '@noble/curves/secp256k1';

import { CONTROL_METHODS } from '../../../shared/public-gateway/ControlPlaneMethods.mjs';
import { TrustPolicyEngine } from '../../../shared/public-gateway/TrustPolicyEngine.mjs';
import {
  assert,
  randomHex,
  requestJson,
  sleep,
  waitFor
} from '../harness/utils.mjs';

function toHex(value) {
  return Buffer.from(value).toString('hex');
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

function makeOpenJoinEntry() {
  return {
    writerCore: randomHex(32),
    writerCoreHex: randomHex(32),
    autobaseLocal: randomHex(32),
    writerSecret: `secret-${randomHex(8)}`,
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

function workerConfigWithPolicy(ctx, trustPolicy) {
  const base = ctx.cluster.workerGatewayConfig();
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
  await ctx.workers.creator.configurePublicGateway(config);
  await ctx.workers.joiner.configurePublicGateway(config);
  return config;
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
  return waitFor(async () => {
    try {
      return await worker.runControlMethod(methodName, payload, options);
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

async function ensureControlRelay(ctx) {
  if (ctx.state.relay?.relayKey) return ctx.state.relay;

  const relayKey = randomHex(32);
  const relayCores = [
    { key: randomHex(32), role: 'autobase' },
    { key: randomHex(32), role: 'hyperdrive' }
  ];

  const result = await ctx.workers.creator.runControlMethod('RELAY_REGISTER', {
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
  });

  assert(result?.data?.status === 'ok', 'relay register failed while ensuring relay');

  ctx.state.relay = {
    relayKey,
    relayCores,
    publicIdentifier: relayKey
  };
  return ctx.state.relay;
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
  await applyWorkerPolicy(ctx, {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  });

  await ctx.workers.creator.setTrustFixture({
    followsByMe: [],
    followersOfMe: [],
    attestations: []
  });

  const resA = await runControlMethodWithGatewayRetry(ctx, ctx.workers.creator, 'MESH_CATALOG_READ', {}, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  }, {
    timeoutMs: 45_000,
    label: 'allowlist pass gateway-a availability'
  });
  const resB = await runControlMethodWithGatewayRetry(ctx, ctx.workers.creator, 'MESH_CATALOG_READ', {}, {
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
  await applyWorkerPolicy(ctx, {
    explicitAllowlist: [ctx.cluster.gatewayIds.a],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  });

  await ctx.workers.creator.setTrustFixture({ followsByMe: [], followersOfMe: [], attestations: [] });

  await ctx.workers.creator.runControlMethod('MESH_CATALOG_READ', {}, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  let blocked = false;
  try {
    await ctx.workers.creator.runControlMethod('MESH_CATALOG_READ', {}, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  } catch (_) {
    blocked = true;
  }
  assert(blocked, 'allowlist block did not block gateway-b control request');

  return {
    blockedGatewayId: ctx.cluster.gatewayIds.b
  };
}

async function scenarioTrustGatewayAllowPass(ctx) {
  const allowPolicy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: [],
    maxDescriptorAgeMs: 6 * 60 * 60 * 1000
  };
  await ctx.cluster.updateGatewayTrust('a', { trustPolicy: allowPolicy, trustContext: { followsByMe: [], followersOfMe: [], attestations: [] } });
  await ctx.cluster.updateGatewayTrust('b', { trustPolicy: allowPolicy, trustContext: { followsByMe: [], followersOfMe: [], attestations: [] } });

  const eventId = `trust-allow-pass-${randomHex(8)}`;
  await ctx.cluster.requestGateway('a', '/api/v2/mesh/state/append', {
    method: 'POST',
    body: {
      event: {
        id: eventId,
        eventType: 'TokenRevoked',
        payload: { relayKey: randomHex(32) },
        metadata: { sourceGatewayId: ctx.cluster.gatewayIds.a },
        timestamp: Date.now()
      }
    }
  });

  await waitFor(async () => {
    const stateB = await ctx.cluster.requestGateway('b', '/api/v2/mesh/state?sinceSequence=0&limit=5000');
    const events = Array.isArray(stateB?.events) ? stateB.events : [];
    return events.some((entry) => entry?.id === eventId);
  }, {
    timeoutMs: 45_000,
    intervalMs: 500,
    label: 'gateway trust allow replication'
  });

  return { replicatedEventId: eventId };
}

async function scenarioTrustGatewayAllowBlock(ctx) {
  const allowPolicy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: [],
    maxDescriptorAgeMs: 6 * 60 * 60 * 1000
  };
  const blockBPolicy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: [],
    maxDescriptorAgeMs: 6 * 60 * 60 * 1000
  };

  await ctx.cluster.updateGatewayTrust('a', { trustPolicy: allowPolicy, trustContext: { followsByMe: [], followersOfMe: [], attestations: [] } });
  await ctx.cluster.updateGatewayTrust('b', { trustPolicy: blockBPolicy, trustContext: { followsByMe: [], followersOfMe: [], attestations: [] } });

  const eventId = `trust-allow-block-${randomHex(8)}`;
  await ctx.cluster.requestGateway('a', '/api/v2/mesh/state/append', {
    method: 'POST',
    body: {
      event: {
        id: eventId,
        eventType: 'TokenRevoked',
        payload: { relayKey: randomHex(32) },
        metadata: { sourceGatewayId: ctx.cluster.gatewayIds.a },
        timestamp: Date.now()
      }
    }
  });

  await sleep(6_000);
  const stateB = await ctx.cluster.requestGateway('b', '/api/v2/mesh/state?sinceSequence=0&limit=5000');
  const events = Array.isArray(stateB?.events) ? stateB.events : [];
  const replicated = events.some((entry) => entry?.id === eventId);
  assert(!replicated, 'gateway trust block unexpectedly replicated event');

  await ctx.cluster.updateGatewayTrust('b', { trustPolicy: allowPolicy, trustContext: { followsByMe: [], followersOfMe: [], attestations: [] } });

  return {
    blockedEventId: eventId,
    replicated
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
  await applyWorkerPolicy(ctx, policy);
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    followersOfMe: [],
    attestations: []
  });

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

  const res = await runControlMethodWithGatewayRetry(ctx, ctx.workers.creator, 'MESH_CATALOG_READ', {}, {
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
  await applyWorkerPolicy(ctx, {
    explicitAllowlist: [],
    requireFollowedByMe: true,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  });
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a],
    followersOfMe: [],
    attestations: []
  });

  let blocked = false;
  try {
    await ctx.workers.creator.runControlMethod('MESH_CATALOG_READ', {}, {
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

async function scenarioTrustWotMutualPass(ctx) {
  const policy = {
    explicitAllowlist: [],
    requireFollowedByMe: true,
    requireMutualFollow: true,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  };
  await applyWorkerPolicy(ctx, policy);
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    followersOfMe: [ctx.cluster.gatewayIds.b],
    attestations: []
  });

  const engine = new TrustPolicyEngine({ policy });
  const evaluation = engine.evaluateGateway({
    gatewayPubkey: ctx.cluster.gatewayIds.b,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000)
  }, {
    followsByMe: new Set([ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b]),
    followersOfMe: new Set([ctx.cluster.gatewayIds.b]),
    attestations: []
  });
  assert(evaluation?.trusted === true, 'WOT mutual pass policy evaluation did not trust gateway-b');

  const res = await runControlMethodWithGatewayRetry(ctx, ctx.workers.creator, 'MESH_CATALOG_READ', {}, {
    hedged: false
  }, {
    timeoutMs: 30_000,
    label: 'wot mutual pass control availability'
  });
  assert(typeof res?.gatewayId === 'string' && res.gatewayId.length > 0, 'WOT mutual pass control request failed');
  return {
    gatewayId: res.gatewayId,
    evaluatedGatewayId: ctx.cluster.gatewayIds.b
  };
}

async function scenarioTrustWotMutualBlock(ctx) {
  await applyWorkerPolicy(ctx, {
    explicitAllowlist: [],
    requireFollowedByMe: true,
    requireMutualFollow: true,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  });
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    followersOfMe: [],
    attestations: []
  });

  let blocked = false;
  try {
    await ctx.workers.creator.runControlMethod('MESH_CATALOG_READ', {}, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  } catch (_) {
    blocked = true;
  }
  assert(blocked, 'WOT mutual block did not block gateway-b');
  return { blockedGatewayId: ctx.cluster.gatewayIds.b };
}

async function scenarioTrustWotAttestPass(ctx) {
  const attestor = randomHex(32);
  const policy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 1,
    acceptedAttestorPubkeys: [attestor]
  };
  await applyWorkerPolicy(ctx, policy);
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [],
    followersOfMe: [],
    attestations: [{
      attestorPubkey: attestor,
      targetPubkey: ctx.cluster.gatewayIds.a,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
      score: 1
    }]
  });

  const engine = new TrustPolicyEngine({ policy });
  const evaluation = engine.evaluateGateway({
    gatewayPubkey: ctx.cluster.gatewayIds.a,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000)
  }, {
    followsByMe: new Set(),
    followersOfMe: new Set(),
    attestations: [{
      attestorPubkey: attestor,
      targetPubkey: ctx.cluster.gatewayIds.a,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
      score: 1
    }]
  });
  assert(evaluation?.trusted === true, 'WOT attestation pass policy evaluation failed');
  return {
    gatewayId: ctx.cluster.gatewayIds.a,
    policyReason: evaluation?.reason || null
  };
}

async function scenarioTrustWotAttestBlock(ctx) {
  const attestor = randomHex(32);
  const policy = {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 1,
    acceptedAttestorPubkeys: [attestor]
  };
  await applyWorkerPolicy(ctx, {
    ...policy
  });
  await ctx.workers.creator.setTrustFixture({
    followsByMe: [],
    followersOfMe: [],
    attestations: []
  });

  const engine = new TrustPolicyEngine({ policy });
  const evaluation = engine.evaluateGateway({
    gatewayPubkey: ctx.cluster.gatewayIds.a,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (5 * 60 * 1000)
  }, {
    followsByMe: new Set(),
    followersOfMe: new Set(),
    attestations: []
  });
  assert(evaluation?.trusted === false, 'attestation policy did not reject descriptor without attestations');

  let blockObservation = null;
  try {
    await ctx.workers.creator.runControlMethod('MESH_CATALOG_READ', {}, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
  } catch (error) {
    blockObservation = {
      blocked: true,
      message: error?.message || 'blocked'
    };
  }
  const blocked = blockObservation?.blocked === true;

  await applyWorkerPolicy(ctx, {
    explicitAllowlist: [ctx.cluster.gatewayIds.a, ctx.cluster.gatewayIds.b],
    requireFollowedByMe: false,
    requireMutualFollow: false,
    minTrustedAttestations: 0,
    acceptedAttestorPubkeys: []
  });

  return {
    blockedGatewayId: ctx.cluster.gatewayIds.a,
    workerBlocked: blocked,
    workerError: blockObservation?.message || null,
    policyReason: evaluation?.reason || 'rejected'
  };
}

async function scenarioControlAuth(ctx) {
  const challengeResult = await timed(ctx, 'auth.challenge_session', async () => {
    return ctx.workers.creator.runControlMethod(CONTROL_METHODS.AUTH_CHALLENGE, {
      workerPubkey: ctx.workers.creator.pubkey
    }, {
      gatewayId: ctx.cluster.gatewayIds.a,
      onlyGateway: true,
      hedged: false
    });
  });

  const challenge = challengeResult?.data?.challenge;
  assert(typeof challenge === 'string' && challenge.length > 0, 'control auth challenge missing');

  const signature = createChallengeSignature(challenge, ctx.workers.creator.privkey);
  const sessionResult = await timed(ctx, 'auth.challenge_session', async () => {
    return ctx.workers.creator.runControlMethod(CONTROL_METHODS.AUTH_SESSION, {
      challenge,
      workerPubkey: ctx.workers.creator.pubkey,
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
    return ctx.workers.creator.runControlMethod(CONTROL_METHODS.MIRROR_READ, {
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
  const entry = makeOpenJoinEntry();
  const result = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, {
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

  assert(result?.data?.status === 'ok', 'open join pool sync failed');
  ctx.state.openJoinEntry = entry;
  return { relayKey: relay.relayKey, writerCore: entry.writerCore };
}

async function scenarioOpenJoinChallengeLease(ctx) {
  const relay = await ensureControlRelay(ctx);
  if (!ctx.state.openJoinEntry) {
    await scenarioOpenJoinPoolSync(ctx);
  }

  const challengeResult = await ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_CHALLENGE, {
    relayKey: relay.relayKey
  }, {
    gatewayId: ctx.cluster.gatewayIds.b,
    onlyGateway: true,
    hedged: false
  });

  const challenge = challengeResult?.data?.challenge;
  assert(typeof challenge === 'string' && challenge.length > 0, 'open join challenge missing');

  const authEvent = buildNostrAuthEvent({
    relay: ctx.cluster.gatewayBaseUrl('b'),
    challenge,
    pubkey: ctx.workers.joiner.pubkey,
    privkey: ctx.workers.joiner.privkey,
    publicIdentifier: challengeResult?.data?.publicIdentifier || relay.publicIdentifier
  });

  const leaseResult = await timed(ctx, 'open_join.lease_claim', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.OPEN_JOIN_LEASE_CLAIM, {
      relayKey: relay.relayKey,
      authEvent
    }, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(leaseResult?.data?.certificate?.slotKey, 'open join lease certificate missing');
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
  ctx.state.closedJoinRecipientPubkey = recipient;

  const entry = {
    writerCore: randomHex(32),
    writerCoreHex: randomHex(32),
    autobaseLocal: randomHex(32),
    writerEnvelope: {
      alg: 'x25519-aes-256-gcm-v1',
      ciphertext: 'QQ',
      nonce: 'QQ',
      authTag: 'QQ',
      ephemeralPubkey: randomHex(32),
      recipientPubkey: recipient,
      leaseId: `lease-${randomHex(8)}`,
      relayKey: relay.relayKey,
      purpose: 'closed-join',
      createdAt: Date.now(),
      expiresAt: Date.now() + (10 * 60 * 1000),
      envelopeVersion: 1
    },
    issuedAt: Date.now(),
    expiresAt: Date.now() + (10 * 60 * 1000)
  };

  const result = await ctx.workers.creator.runControlMethod(CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC, {
    relayKey: relay.relayKey,
    entries: [entry],
    updatedAt: Date.now(),
    publicIdentifier: relay.publicIdentifier,
    relayCores: relay.relayCores
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });

  assert(result?.data?.status === 'ok', 'closed join pool sync failed');
  return {
    relayKey: relay.relayKey,
    recipient
  };
}

async function scenarioClosedJoinLeaseClaim(ctx) {
  const relay = await ensureControlRelay(ctx);
  if (!ctx.state.closedJoinRecipientPubkey) {
    await scenarioClosedJoinPoolSync(ctx);
  }

  const leaseResult = await timed(ctx, 'closed_join.lease_claim', async () => {
    return ctx.workers.joiner.runControlMethod(CONTROL_METHODS.CLOSED_JOIN_LEASE_CLAIM, {
      relayKey: relay.relayKey,
      recipientPubkey: ctx.state.closedJoinRecipientPubkey
    }, {
      gatewayId: ctx.cluster.gatewayIds.b,
      onlyGateway: true,
      hedged: false
    });
  });

  assert(leaseResult?.data?.writerEnvelope?.leaseId, 'closed join lease envelope missing');
  assert(leaseResult?.data?.certificate?.slotKey, 'closed join lease certificate missing');
  return {
    relayKey: relay.relayKey,
    leaseId: leaseResult?.data?.writerEnvelope?.leaseId || null
  };
}

async function scenarioWorkerCreateRelay(ctx) {
  const result = await ctx.workers.creator.createRelay({
    name: `Live Matrix ${randomHex(3)}`,
    description: 'matrix e2e worker create relay',
    isPublic: true,
    isOpen: true,
    fileSharing: true
  }, {
    timeoutMs: 180_000
  });

  assert(result?.success !== false, 'worker create relay returned success=false');
  assert(typeof result?.relayKey === 'string', 'worker create relay missing relay key');
  if (result?.gatewayRegistration === 'failed') {
    throw new Error(`worker create relay gateway registration failed: ${result?.registrationError || 'unknown-error'}`);
  }

  ctx.state.workerRelay = {
    relayKey: result.relayKey,
    publicIdentifier: result.publicIdentifier,
    relayUrl: result.relayUrl || null,
    hostPeer: ctx.workers.creator.swarmPublicKey
  };

  return ctx.state.workerRelay;
}

async function scenarioWorkerJoinRelayOfflinePeer(ctx) {
  const relay = ctx.state.workerRelay;
  assert(relay?.relayKey, 'worker relay missing; run worker.create_relay first');

  await ctx.workers.creator.shutdown({ timeoutMs: 12_000 });

  ctx.workers.joiner.send({
    type: 'start-join-flow',
    data: {
      relayKey: relay.relayKey,
      publicIdentifier: relay.publicIdentifier,
      relayUrl: relay.relayUrl,
      openJoin: true,
      isOpen: true,
      fileSharing: true,
      hostPeers: relay.hostPeer ? [relay.hostPeer] : []
    }
  });

  const outcome = await ctx.workers.joiner.waitForMessage((message) => {
    if (message?.type === 'join-auth-success' && message?.data?.publicIdentifier === relay.publicIdentifier) return true;
    if (message?.type === 'join-auth-error' && message?.data?.publicIdentifier === relay.publicIdentifier) return true;
    return false;
  }, {
    timeoutMs: 180_000,
    label: 'join relay offline peer outcome'
  });

  if (outcome?.type === 'join-auth-error') {
    throw new Error(`join flow failed with creator offline: ${outcome?.data?.error || 'unknown-error'}`);
  }

  return {
    relayKey: relay.relayKey,
    mode: outcome?.data?.mode || null
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
          relayKey: ctx.state.relay?.relayKey || randomHex(32),
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
    metadata: {
      identifier: relay.publicIdentifier,
      isOpen: true,
      isPublic: true,
      isHosted: true,
      isJoined: false,
      metadataUpdatedAt: Date.now()
    },
    relayCores,
    relayCoresMode: 'merge'
  }, {
    gatewayId: ctx.cluster.gatewayIds.a,
    onlyGateway: true,
    hedged: false
  });
  assert(registerResult?.data?.status === 'ok', 'lease quorum relay register failed');

  const entry = makeOpenJoinEntry();
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

async function scenarioPerfSmoke(ctx) {
  const metrics = ctx.metricSnapshot();
  const required = [
    'mirror.read',
    'auth.challenge_session',
    'open_join.lease_claim',
    'closed_join.lease_claim'
  ];
  for (const key of required) {
    assert(metrics[key]?.count > 0, `missing metric samples for ${key}`);
  }
  return {
    metrics: required.reduce((acc, key) => {
      acc[key] = metrics[key];
      return acc;
    }, {})
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
  'trust.gateway.allow.pass': scenarioTrustGatewayAllowPass,
  'trust.gateway.allow.block': scenarioTrustGatewayAllowBlock,
  'trust.wot.follow.pass': scenarioTrustWotFollowPass,
  'trust.wot.follow.block': scenarioTrustWotFollowBlock,
  'trust.wot.mutual.pass': scenarioTrustWotMutualPass,
  'trust.wot.mutual.block': scenarioTrustWotMutualBlock,
  'trust.wot.attest.pass': scenarioTrustWotAttestPass,
  'trust.wot.attest.block': scenarioTrustWotAttestBlock,
  'control.auth': scenarioControlAuth,
  'control.relay.register': scenarioControlRelayRegister,
  'control.mirror.read': scenarioControlMirrorRead,
  'open_join.pool_sync': scenarioOpenJoinPoolSync,
  'open_join.challenge_lease': scenarioOpenJoinChallengeLease,
  'open_join.append_cores': scenarioOpenJoinAppendCores,
  'closed_join.pool_sync': scenarioClosedJoinPoolSync,
  'closed_join.lease_claim': scenarioClosedJoinLeaseClaim,
  'worker.create_relay': scenarioWorkerCreateRelay,
  'worker.join_relay_offline_peer': scenarioWorkerJoinRelayOfflinePeer,
  'federation.state_replication': scenarioFederationStateReplication,
  'federation.lease_quorum': scenarioFederationLeaseQuorum,
  'failover.gateway_down': scenarioFailoverGatewayDown,
  'recovery.gateway_restart': scenarioRecoveryGatewayRestart,
  'perf.smoke': scenarioPerfSmoke,
  'stability.repeat': scenarioStabilityRepeat
};

const PROFILE_SCENARIOS = {
  smoke: [
    'infra.boot',
    'trust.allowlist.pass',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'federation.state_replication',
    'failover.gateway_down',
    'recovery.gateway_restart',
    'perf.smoke'
  ],
  full: [
    'infra.boot',
    'trust.allowlist.pass',
    'trust.allowlist.block',
    'trust.gateway.allow.pass',
    'trust.gateway.allow.block',
    'trust.wot.follow.pass',
    'trust.wot.follow.block',
    'trust.wot.mutual.pass',
    'trust.wot.mutual.block',
    'trust.wot.attest.pass',
    'trust.wot.attest.block',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'open_join.append_cores',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'worker.create_relay',
    'worker.join_relay_offline_peer',
    'federation.state_replication',
    'federation.lease_quorum',
    'failover.gateway_down',
    'recovery.gateway_restart',
    'perf.smoke',
    'stability.repeat'
  ],
  soak: [
    'infra.boot',
    'trust.allowlist.pass',
    'control.auth',
    'control.relay.register',
    'control.mirror.read',
    'open_join.pool_sync',
    'open_join.challenge_lease',
    'closed_join.pool_sync',
    'closed_join.lease_claim',
    'federation.state_replication',
    'failover.gateway_down',
    'recovery.gateway_restart',
    'stability.repeat',
    'perf.smoke'
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
