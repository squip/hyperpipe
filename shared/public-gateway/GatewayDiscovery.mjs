import { createHash, randomBytes } from 'node:crypto';
import hyperCrypto from 'hypercore-crypto';
import * as c from 'compact-encoding';

const DISCOVERY_TOPIC_SEED = 'hypertuna-public-gateway-discovery-v1';
const DISCOVERY_TOPIC = hyperCrypto.hash(Buffer.from(DISCOVERY_TOPIC_SEED));

const GATEWAY_DISCOVERY_PROTOCOL_VERSION = 2;
const GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1 = 'nostr-challenge-v1';

const announcementEncodingV2 = {
  preencode(state, value) {
    c.string.preencode(state, value.gatewayId || '');
    c.uint.preencode(state, value.timestamp || 0);
    c.uint.preencode(state, value.ttl || 0);
    c.string.preencode(state, value.publicUrl || '');
    c.string.preencode(state, value.wsUrl || '');
    c.bool.preencode(state, value.openAccess === true);
    c.string.preencode(state, value.authMode || GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1);
    c.string.preencode(state, value.displayName || '');
    c.string.preencode(state, value.region || '');
    c.uint.preencode(state, value.protocolVersion || GATEWAY_DISCOVERY_PROTOCOL_VERSION);
    c.string.preencode(state, value.signature || '');
    c.string.preencode(state, value.signatureKey || '');
    c.string.preencode(state, value.relayKey || '');
    c.string.preencode(state, value.relayDiscoveryKey || '');
    c.string.preencode(state, value.relayReplicationTopic || '');
    c.uint.preencode(state, value.relayTokenTtl || 0);
    c.uint.preencode(state, value.relayTokenRefreshWindow || 0);
    c.uint.preencode(state, value.dispatcherMaxConcurrent || 0);
    c.uint.preencode(state, value.dispatcherInFlightWeight || 0);
    c.uint.preencode(state, value.dispatcherLatencyWeight || 0);
    c.uint.preencode(state, value.dispatcherFailureWeight || 0);
    c.uint.preencode(state, value.dispatcherReassignLagBlocks || 0);
    c.uint.preencode(state, value.dispatcherCircuitBreakerThreshold || 0);
    c.uint.preencode(state, value.dispatcherCircuitBreakerTimeoutMs || 0);
  },
  encode(state, value) {
    c.string.encode(state, value.gatewayId || '');
    c.uint.encode(state, value.timestamp || 0);
    c.uint.encode(state, value.ttl || 0);
    c.string.encode(state, value.publicUrl || '');
    c.string.encode(state, value.wsUrl || '');
    c.bool.encode(state, value.openAccess === true);
    c.string.encode(state, value.authMode || GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1);
    c.string.encode(state, value.displayName || '');
    c.string.encode(state, value.region || '');
    c.uint.encode(state, value.protocolVersion || GATEWAY_DISCOVERY_PROTOCOL_VERSION);
    c.string.encode(state, value.signature || '');
    c.string.encode(state, value.signatureKey || '');
    c.string.encode(state, value.relayKey || '');
    c.string.encode(state, value.relayDiscoveryKey || '');
    c.string.encode(state, value.relayReplicationTopic || '');
    c.uint.encode(state, value.relayTokenTtl || 0);
    c.uint.encode(state, value.relayTokenRefreshWindow || 0);
    c.uint.encode(state, value.dispatcherMaxConcurrent || 0);
    c.uint.encode(state, value.dispatcherInFlightWeight || 0);
    c.uint.encode(state, value.dispatcherLatencyWeight || 0);
    c.uint.encode(state, value.dispatcherFailureWeight || 0);
    c.uint.encode(state, value.dispatcherReassignLagBlocks || 0);
    c.uint.encode(state, value.dispatcherCircuitBreakerThreshold || 0);
    c.uint.encode(state, value.dispatcherCircuitBreakerTimeoutMs || 0);
  },
  decode(state) {
    const announcement = {
      gatewayId: c.string.decode(state),
      timestamp: c.uint.decode(state),
      ttl: c.uint.decode(state),
      publicUrl: c.string.decode(state),
      wsUrl: c.string.decode(state),
      openAccess: c.bool.decode(state),
      authMode: c.string.decode(state) || GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1,
      displayName: c.string.decode(state),
      region: c.string.decode(state),
      protocolVersion: c.uint.decode(state),
      signature: c.string.decode(state),
      signatureKey: c.string.decode(state)
    };

    announcement.relayKey = state.start < state.end ? c.string.decode(state) : '';
    announcement.relayDiscoveryKey = state.start < state.end ? c.string.decode(state) : '';
    announcement.relayReplicationTopic = state.start < state.end ? c.string.decode(state) : '';

    const maybeDecodeUint = () => (state.start < state.end ? c.uint.decode(state) : 0);

    announcement.relayTokenTtl = maybeDecodeUint();
    announcement.relayTokenRefreshWindow = maybeDecodeUint();
    announcement.dispatcherMaxConcurrent = maybeDecodeUint();
    announcement.dispatcherInFlightWeight = maybeDecodeUint();
    announcement.dispatcherLatencyWeight = maybeDecodeUint();
    announcement.dispatcherFailureWeight = maybeDecodeUint();
    announcement.dispatcherReassignLagBlocks = maybeDecodeUint();
    announcement.dispatcherCircuitBreakerThreshold = maybeDecodeUint();
    announcement.dispatcherCircuitBreakerTimeoutMs = maybeDecodeUint();

    return announcement;
  }
};

// Backward-compat decode path for legacy discovery announcements.
const announcementEncodingV1 = {
  preencode(state, value) {
    c.string.preencode(state, value.gatewayId || '');
    c.uint.preencode(state, value.timestamp || 0);
    c.uint.preencode(state, value.ttl || 0);
    c.string.preencode(state, value.publicUrl || '');
    c.string.preencode(state, value.wsUrl || '');
    c.string.preencode(state, value.secretUrl || '');
    c.string.preencode(state, value.secretHash || '');
    c.bool.preencode(state, value.openAccess === true);
    c.string.preencode(state, value.sharedSecretVersion || '');
    c.string.preencode(state, value.displayName || '');
    c.string.preencode(state, value.region || '');
    c.uint.preencode(state, value.protocolVersion || 1);
    c.string.preencode(state, value.signature || '');
    c.string.preencode(state, value.signatureKey || '');
    c.string.preencode(state, value.relayKey || '');
    c.string.preencode(state, value.relayDiscoveryKey || '');
    c.string.preencode(state, value.relayReplicationTopic || '');
    c.uint.preencode(state, value.relayTokenTtl || 0);
    c.uint.preencode(state, value.relayTokenRefreshWindow || 0);
    c.uint.preencode(state, value.dispatcherMaxConcurrent || 0);
    c.uint.preencode(state, value.dispatcherInFlightWeight || 0);
    c.uint.preencode(state, value.dispatcherLatencyWeight || 0);
    c.uint.preencode(state, value.dispatcherFailureWeight || 0);
    c.uint.preencode(state, value.dispatcherReassignLagBlocks || 0);
    c.uint.preencode(state, value.dispatcherCircuitBreakerThreshold || 0);
    c.uint.preencode(state, value.dispatcherCircuitBreakerTimeoutMs || 0);
  },
  encode(state, value) {
    c.string.encode(state, value.gatewayId || '');
    c.uint.encode(state, value.timestamp || 0);
    c.uint.encode(state, value.ttl || 0);
    c.string.encode(state, value.publicUrl || '');
    c.string.encode(state, value.wsUrl || '');
    c.string.encode(state, value.secretUrl || '');
    c.string.encode(state, value.secretHash || '');
    c.bool.encode(state, value.openAccess === true);
    c.string.encode(state, value.sharedSecretVersion || '');
    c.string.encode(state, value.displayName || '');
    c.string.encode(state, value.region || '');
    c.uint.encode(state, value.protocolVersion || 1);
    c.string.encode(state, value.signature || '');
    c.string.encode(state, value.signatureKey || '');
    c.string.encode(state, value.relayKey || '');
    c.string.encode(state, value.relayDiscoveryKey || '');
    c.string.encode(state, value.relayReplicationTopic || '');
    c.uint.encode(state, value.relayTokenTtl || 0);
    c.uint.encode(state, value.relayTokenRefreshWindow || 0);
    c.uint.encode(state, value.dispatcherMaxConcurrent || 0);
    c.uint.encode(state, value.dispatcherInFlightWeight || 0);
    c.uint.encode(state, value.dispatcherLatencyWeight || 0);
    c.uint.encode(state, value.dispatcherFailureWeight || 0);
    c.uint.encode(state, value.dispatcherReassignLagBlocks || 0);
    c.uint.encode(state, value.dispatcherCircuitBreakerThreshold || 0);
    c.uint.encode(state, value.dispatcherCircuitBreakerTimeoutMs || 0);
  },
  decode(state) {
    const announcement = {
      gatewayId: c.string.decode(state),
      timestamp: c.uint.decode(state),
      ttl: c.uint.decode(state),
      publicUrl: c.string.decode(state),
      wsUrl: c.string.decode(state),
      secretUrl: c.string.decode(state),
      secretHash: c.string.decode(state),
      openAccess: c.bool.decode(state),
      sharedSecretVersion: c.string.decode(state),
      displayName: c.string.decode(state),
      region: c.string.decode(state),
      protocolVersion: c.uint.decode(state),
      signature: c.string.decode(state),
      signatureKey: c.string.decode(state)
    };

    announcement.relayKey = state.start < state.end ? c.string.decode(state) : '';
    announcement.relayDiscoveryKey = state.start < state.end ? c.string.decode(state) : '';
    announcement.relayReplicationTopic = state.start < state.end ? c.string.decode(state) : '';

    const maybeDecodeUint = () => (state.start < state.end ? c.uint.decode(state) : 0);

    announcement.relayTokenTtl = maybeDecodeUint();
    announcement.relayTokenRefreshWindow = maybeDecodeUint();
    announcement.dispatcherMaxConcurrent = maybeDecodeUint();
    announcement.dispatcherInFlightWeight = maybeDecodeUint();
    announcement.dispatcherLatencyWeight = maybeDecodeUint();
    announcement.dispatcherFailureWeight = maybeDecodeUint();
    announcement.dispatcherReassignLagBlocks = maybeDecodeUint();
    announcement.dispatcherCircuitBreakerThreshold = maybeDecodeUint();
    announcement.dispatcherCircuitBreakerTimeoutMs = maybeDecodeUint();

    return announcement;
  }
};

function deriveKeyPair(seed) {
  if (seed && typeof seed === 'string') {
    const digest = createHash('sha256').update(seed).digest();
    return hyperCrypto.keyPair(digest);
  }
  if (seed instanceof Uint8Array) {
    const buf = seed.length === 32 ? seed : createHash('sha256').update(seed).digest();
    return hyperCrypto.keyPair(buf);
  }
  return hyperCrypto.keyPair(randomBytes(32));
}

function canonicalizeAnnouncementV2(announcement) {
  const payload = {
    gatewayId: announcement.gatewayId || '',
    timestamp: announcement.timestamp || 0,
    ttl: announcement.ttl || 0,
    publicUrl: announcement.publicUrl || '',
    wsUrl: announcement.wsUrl || '',
    openAccess: announcement.openAccess === true,
    authMode: announcement.authMode || GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1,
    displayName: announcement.displayName || '',
    region: announcement.region || '',
    protocolVersion: announcement.protocolVersion || GATEWAY_DISCOVERY_PROTOCOL_VERSION
  };
  if (announcement.relayKey) payload.relayKey = announcement.relayKey;
  if (announcement.relayDiscoveryKey) payload.relayDiscoveryKey = announcement.relayDiscoveryKey;
  if (announcement.relayReplicationTopic) payload.relayReplicationTopic = announcement.relayReplicationTopic;
  if (announcement.relayTokenTtl) payload.relayTokenTtl = announcement.relayTokenTtl;
  if (announcement.relayTokenRefreshWindow) payload.relayTokenRefreshWindow = announcement.relayTokenRefreshWindow;
  if (announcement.dispatcherMaxConcurrent) payload.dispatcherMaxConcurrent = announcement.dispatcherMaxConcurrent;
  if (announcement.dispatcherInFlightWeight) payload.dispatcherInFlightWeight = announcement.dispatcherInFlightWeight;
  if (announcement.dispatcherLatencyWeight) payload.dispatcherLatencyWeight = announcement.dispatcherLatencyWeight;
  if (announcement.dispatcherFailureWeight) payload.dispatcherFailureWeight = announcement.dispatcherFailureWeight;
  if (announcement.dispatcherReassignLagBlocks) payload.dispatcherReassignLagBlocks = announcement.dispatcherReassignLagBlocks;
  if (announcement.dispatcherCircuitBreakerThreshold) payload.dispatcherCircuitBreakerThreshold = announcement.dispatcherCircuitBreakerThreshold;
  if (announcement.dispatcherCircuitBreakerTimeoutMs) payload.dispatcherCircuitBreakerTimeoutMs = announcement.dispatcherCircuitBreakerTimeoutMs;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function canonicalizeAnnouncementV1(announcement) {
  const payload = {
    gatewayId: announcement.gatewayId || '',
    timestamp: announcement.timestamp || 0,
    ttl: announcement.ttl || 0,
    publicUrl: announcement.publicUrl || '',
    wsUrl: announcement.wsUrl || '',
    secretUrl: announcement.secretUrl || '',
    secretHash: announcement.secretHash || '',
    openAccess: announcement.openAccess === true,
    sharedSecretVersion: announcement.sharedSecretVersion || '',
    displayName: announcement.displayName || '',
    region: announcement.region || '',
    protocolVersion: announcement.protocolVersion || 1
  };
  if (announcement.relayKey) payload.relayKey = announcement.relayKey;
  if (announcement.relayDiscoveryKey) payload.relayDiscoveryKey = announcement.relayDiscoveryKey;
  if (announcement.relayReplicationTopic) payload.relayReplicationTopic = announcement.relayReplicationTopic;
  if (announcement.relayTokenTtl) payload.relayTokenTtl = announcement.relayTokenTtl;
  if (announcement.relayTokenRefreshWindow) payload.relayTokenRefreshWindow = announcement.relayTokenRefreshWindow;
  if (announcement.dispatcherMaxConcurrent) payload.dispatcherMaxConcurrent = announcement.dispatcherMaxConcurrent;
  if (announcement.dispatcherInFlightWeight) payload.dispatcherInFlightWeight = announcement.dispatcherInFlightWeight;
  if (announcement.dispatcherLatencyWeight) payload.dispatcherLatencyWeight = announcement.dispatcherLatencyWeight;
  if (announcement.dispatcherFailureWeight) payload.dispatcherFailureWeight = announcement.dispatcherFailureWeight;
  if (announcement.dispatcherReassignLagBlocks) payload.dispatcherReassignLagBlocks = announcement.dispatcherReassignLagBlocks;
  if (announcement.dispatcherCircuitBreakerThreshold) payload.dispatcherCircuitBreakerThreshold = announcement.dispatcherCircuitBreakerThreshold;
  if (announcement.dispatcherCircuitBreakerTimeoutMs) payload.dispatcherCircuitBreakerTimeoutMs = announcement.dispatcherCircuitBreakerTimeoutMs;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function canonicalizeAnnouncement(announcement) {
  const protocolVersion = Number(announcement?.protocolVersion || 0);
  const hasLegacyFields = typeof announcement?.secretUrl === 'string'
    || typeof announcement?.secretHash === 'string'
    || typeof announcement?.sharedSecretVersion === 'string';
  if (hasLegacyFields || (Number.isFinite(protocolVersion) && protocolVersion > 0 && protocolVersion < 2)) {
    return canonicalizeAnnouncementV1(announcement || {});
  }
  return canonicalizeAnnouncementV2(announcement || {});
}

function ensureSecretKeyBuffer(secretKey) {
  if (!secretKey) {
    throw new Error('Gateway discovery secret key not provided');
  }

  if (Buffer.isBuffer(secretKey)) {
    return secretKey;
  }

  if (secretKey instanceof Uint8Array) {
    return Buffer.from(secretKey);
  }

  throw new Error('Gateway discovery secret key must be a Buffer or Uint8Array');
}

function signAnnouncement(announcement, secretKey) {
  const payload = canonicalizeAnnouncement(announcement);
  const skBuffer = ensureSecretKeyBuffer(secretKey);
  if (skBuffer.length !== 64) {
    throw new Error(`Gateway discovery secret key must be 64 bytes, received ${skBuffer.length}`);
  }
  const signature = hyperCrypto.sign(payload, skBuffer);
  return Buffer.from(signature).toString('hex');
}

function verifyAnnouncementSignature(announcement) {
  if (!announcement?.signature || !announcement?.signatureKey) {
    return false;
  }
  try {
    const payload = canonicalizeAnnouncement(announcement);
    const signature = Buffer.from(announcement.signature, 'hex');
    const publicKey = Buffer.from(announcement.signatureKey, 'hex');
    return hyperCrypto.verify(payload, signature, publicKey);
  } catch (_) {
    return false;
  }
}

function encodeAnnouncement(announcement) {
  const normalized = {
    gatewayId: announcement?.gatewayId || '',
    timestamp: announcement?.timestamp || 0,
    ttl: announcement?.ttl || 0,
    publicUrl: announcement?.publicUrl || '',
    wsUrl: announcement?.wsUrl || '',
    openAccess: announcement?.openAccess === true,
    authMode: announcement?.authMode || GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1,
    displayName: announcement?.displayName || '',
    region: announcement?.region || '',
    protocolVersion: announcement?.protocolVersion || GATEWAY_DISCOVERY_PROTOCOL_VERSION,
    signature: announcement?.signature || '',
    signatureKey: announcement?.signatureKey || '',
    relayKey: announcement?.relayKey || '',
    relayDiscoveryKey: announcement?.relayDiscoveryKey || '',
    relayReplicationTopic: announcement?.relayReplicationTopic || '',
    relayTokenTtl: announcement?.relayTokenTtl || 0,
    relayTokenRefreshWindow: announcement?.relayTokenRefreshWindow || 0,
    dispatcherMaxConcurrent: announcement?.dispatcherMaxConcurrent || 0,
    dispatcherInFlightWeight: announcement?.dispatcherInFlightWeight || 0,
    dispatcherLatencyWeight: announcement?.dispatcherLatencyWeight || 0,
    dispatcherFailureWeight: announcement?.dispatcherFailureWeight || 0,
    dispatcherReassignLagBlocks: announcement?.dispatcherReassignLagBlocks || 0,
    dispatcherCircuitBreakerThreshold: announcement?.dispatcherCircuitBreakerThreshold || 0,
    dispatcherCircuitBreakerTimeoutMs: announcement?.dispatcherCircuitBreakerTimeoutMs || 0
  };

  const state = { start: 0, end: 0, buffer: null };
  announcementEncodingV2.preencode(state, normalized);
  state.buffer = Buffer.allocUnsafe(state.end);
  state.start = 0;
  announcementEncodingV2.encode(state, normalized);
  return state.buffer;
}

function decodeAnnouncement(buffer) {
  try {
    const stateV2 = { start: 0, end: buffer.length, buffer };
    const decodedV2 = announcementEncodingV2.decode(stateV2);
    if (stateV2.start !== stateV2.end) {
      throw new Error('trailing-bytes');
    }
    return decodedV2;
  } catch (_) {
    const stateV1 = { start: 0, end: buffer.length, buffer };
    const decodedV1 = announcementEncodingV1.decode(stateV1);
    decodedV1.protocolVersion = decodedV1.protocolVersion || 1;
    decodedV1.authMode = GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1;
    return decodedV1;
  }
}

function isAnnouncementExpired(announcement, now = Date.now()) {
  if (!announcement?.ttl || !announcement?.timestamp) return true;
  return announcement.timestamp + announcement.ttl * 1000 < now;
}

export {
  DISCOVERY_TOPIC,
  DISCOVERY_TOPIC_SEED,
  GATEWAY_AUTH_MODE_NOSTR_CHALLENGE_V1,
  GATEWAY_DISCOVERY_PROTOCOL_VERSION,
  decodeAnnouncement,
  deriveKeyPair,
  encodeAnnouncement,
  isAnnouncementExpired,
  signAnnouncement,
  verifyAnnouncementSignature
};
