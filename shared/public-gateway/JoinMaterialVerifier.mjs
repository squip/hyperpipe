import { computeJoinMaterialDigest, normalizeJoinMaterialBundle, normalizePurpose } from './JoinMaterialTypes.mjs';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function ensureInCoreRefs(coreRefs = [], target = null) {
  if (!target) return false;
  return Array.isArray(coreRefs) && coreRefs.includes(target);
}

function resolveWriterTuple(bundle = {}) {
  const writerCore = normalizeString(bundle?.lease?.writerCore || bundle?.writerCore);
  const writerCoreHex = normalizeString(bundle?.lease?.writerCoreHex || bundle?.writerCoreHex);
  const autobaseLocal = normalizeString(bundle?.lease?.autobaseLocal || bundle?.autobaseLocal);
  const canonical = writerCoreHex || autobaseLocal || writerCore;
  return {
    writerCore,
    writerCoreHex,
    autobaseLocal,
    canonical
  };
}

function validateJoinMaterialBundle(rawBundle = {}, {
  expectedRelayKey = null,
  expectedPurpose = null,
  now = Date.now(),
  minQuorum = null,
  requireWritableMaterial = true
} = {}) {
  const bundle = normalizeJoinMaterialBundle(rawBundle);
  const errors = [];

  if (!bundle.relayKey) errors.push('missing-relay-key');
  if (expectedRelayKey && bundle.relayKey !== expectedRelayKey) errors.push('relay-key-mismatch');

  const expectedNormalizedPurpose = expectedPurpose ? normalizePurpose(expectedPurpose) : null;
  if (expectedNormalizedPurpose && bundle.purpose !== expectedNormalizedPurpose) {
    errors.push('purpose-mismatch');
  }

  if (Number.isFinite(Number(bundle.expiresAt)) && Number(bundle.expiresAt) <= now) {
    errors.push('bundle-expired');
  }

  const recomputedDigest = computeJoinMaterialDigest(bundle);
  if (!bundle.materialDigest || bundle.materialDigest !== recomputedDigest) {
    errors.push('bundle-digest-mismatch');
  }

  const tuple = resolveWriterTuple(bundle);
  if (requireWritableMaterial && !tuple.canonical) {
    errors.push('missing-writer-tuple');
  }

  const coreRefs = Array.isArray(bundle?.mirror?.coreRefs) ? bundle.mirror.coreRefs : [];
  if (tuple.canonical && !ensureInCoreRefs(coreRefs, tuple.canonical)) {
    errors.push('writer-key-missing-from-core-refs');
  }

  const fastForwardKey = normalizeString(bundle?.mirror?.fastForward?.key);
  if (fastForwardKey && !ensureInCoreRefs(coreRefs, fastForwardKey)) {
    errors.push('fast-forward-key-missing-from-core-refs');
  }

  const cert = bundle?.lease?.certificate || null;
  if (!cert || typeof cert !== 'object') {
    errors.push('missing-lease-certificate');
  } else {
    const slotKey = normalizeString(cert.slotKey);
    const expectedSlot = tuple.canonical
      ? `${bundle.relayKey}:${tuple.canonical}:${bundle.purpose}`
      : null;
    if (!slotKey) {
      errors.push('missing-certificate-slot-key');
    } else if (expectedSlot && slotKey !== expectedSlot) {
      errors.push('certificate-slot-mismatch');
    }

    if (Number.isFinite(Number(cert.expiresAt)) && Number(cert.expiresAt) <= now) {
      errors.push('lease-certificate-expired');
    }

    const voterIds = Array.isArray(cert.voterGatewayIds) ? cert.voterGatewayIds.filter(Boolean) : [];
    const quorum = Number.isFinite(Number(cert.quorum)) ? Math.round(Number(cert.quorum)) : 0;
    const requiredQuorum = Number.isFinite(Number(minQuorum)) && Number(minQuorum) > 0
      ? Math.round(Number(minQuorum))
      : quorum;
    if (requiredQuorum > 0 && voterIds.length < requiredQuorum) {
      errors.push('certificate-quorum-not-met');
    }
  }

  const blindPeerPublicKey = normalizeString(bundle?.mirror?.blindPeer?.publicKey);
  if (!blindPeerPublicKey) {
    errors.push('missing-blind-peer-public-key');
  }

  return {
    ok: errors.length === 0,
    errors,
    bundle,
    writerTuple: tuple,
    metrics: {
      coreRefsCount: coreRefs.length,
      hasFastForward: !!fastForwardKey,
      hasBlindPeer: !!blindPeerPublicKey
    }
  };
}

export {
  resolveWriterTuple,
  validateJoinMaterialBundle
};
