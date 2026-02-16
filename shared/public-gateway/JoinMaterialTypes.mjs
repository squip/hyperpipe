import { createHash, randomBytes } from 'node:crypto';

import { stableStringify } from './RelayAuthorityTypes.mjs';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizePurpose(value) {
  return value === 'closed-join' ? 'closed-join' : 'open-join';
}

function normalizeCoreRefs(values = []) {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  for (const value of values) {
    const normalized = normalizeString(value?.key || value);
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique);
}

function normalizeLeaseCertificate(certificate = {}) {
  if (!certificate || typeof certificate !== 'object') return null;
  return {
    leaseId: normalizeString(certificate.leaseId),
    slotKey: normalizeString(certificate.slotKey),
    epoch: Number.isFinite(Number(certificate.epoch)) ? Math.round(Number(certificate.epoch)) : null,
    quorum: Number.isFinite(Number(certificate.quorum)) ? Math.max(1, Math.round(Number(certificate.quorum))) : 1,
    voterGatewayIds: Array.isArray(certificate.voterGatewayIds)
      ? certificate.voterGatewayIds.map((entry) => normalizeString(entry)).filter(Boolean)
      : [],
    voterSigs: Array.isArray(certificate.voterSigs)
      ? certificate.voterSigs.map((entry) => normalizeString(entry)).filter(Boolean)
      : [],
    fencingToken: normalizeString(certificate.fencingToken),
    issuedAt: Number.isFinite(Number(certificate.issuedAt)) ? Math.round(Number(certificate.issuedAt)) : Date.now(),
    expiresAt: Number.isFinite(Number(certificate.expiresAt)) ? Math.round(Number(certificate.expiresAt)) : null
  };
}

function normalizeJoinMaterialBundle(input = {}) {
  const purpose = normalizePurpose(input.purpose);
  const leaseCertificate = normalizeLeaseCertificate(input?.lease?.certificate || input?.certificate || null);
  const mirrorCores = Array.isArray(input?.mirror?.cores)
    ? input.mirror.cores
    : [];
  const mirrorCoreRefs = normalizeCoreRefs([
    ...(input?.mirror?.coreRefs || []),
    ...mirrorCores
  ]);
  const mirror = {
    coreRefs: mirrorCoreRefs,
    cores: mirrorCores.length ? mirrorCores : mirrorCoreRefs.map((key) => ({ key })),
    publicIdentifier: normalizeString(input?.mirror?.publicIdentifier),
    relayUrl: normalizeString(input?.mirror?.relayUrl),
    blindPeer: input?.mirror?.blindPeer && typeof input.mirror.blindPeer === 'object'
      ? { ...input.mirror.blindPeer }
      : null,
    fastForward: input?.mirror?.fastForward && typeof input.mirror.fastForward === 'object'
      ? { ...input.mirror.fastForward }
      : null
  };
  const lease = {
    writerCore: normalizeString(input?.lease?.writerCore || input?.writerCore),
    writerCoreHex: normalizeString(input?.lease?.writerCoreHex || input?.writerCoreHex || input?.lease?.autobaseLocal || input?.autobaseLocal),
    autobaseLocal: normalizeString(input?.lease?.autobaseLocal || input?.autobaseLocal || input?.lease?.writerCoreHex || input?.writerCoreHex),
    certificate: leaseCertificate
  };

  const bundle = {
    bundleId: normalizeString(input.bundleId) || randomBytes(16).toString('hex'),
    relayKey: normalizeString(input.relayKey),
    purpose,
    mirror,
    lease,
    openJoin: purpose === 'open-join'
      ? {
          writerSecret: normalizeString(input?.openJoin?.writerSecret || input?.writerSecret)
        }
      : undefined,
    closedJoin: purpose === 'closed-join'
      ? {
          writerEnvelope: input?.closedJoin?.writerEnvelope && typeof input.closedJoin.writerEnvelope === 'object'
            ? { ...input.closedJoin.writerEnvelope }
            : (input?.writerEnvelope && typeof input.writerEnvelope === 'object' ? { ...input.writerEnvelope } : null)
        }
      : undefined,
    authorityPolicyHash: normalizeString(input.authorityPolicyHash || input.policyHash),
    materialDigest: normalizeString(input.materialDigest),
    sourceGatewayPubkey: normalizeString(input.sourceGatewayPubkey),
    issuedAt: Number.isFinite(Number(input.issuedAt)) ? Math.round(Number(input.issuedAt)) : Date.now(),
    expiresAt: Number.isFinite(Number(input.expiresAt)) ? Math.round(Number(input.expiresAt)) : (Date.now() + (5 * 60 * 1000)),
    gatewaySig: normalizeString(input.gatewaySig)
  };

  if (!bundle.materialDigest) {
    bundle.materialDigest = computeJoinMaterialDigest(bundle);
  }

  return bundle;
}

function computeJoinMaterialDigest(bundle = {}) {
  const payload = {
    relayKey: bundle.relayKey || null,
    purpose: normalizePurpose(bundle.purpose),
    mirror: {
      coreRefs: normalizeCoreRefs(bundle?.mirror?.coreRefs || []),
      cores: Array.isArray(bundle?.mirror?.cores) ? bundle.mirror.cores : null,
      publicIdentifier: bundle?.mirror?.publicIdentifier || null,
      relayUrl: bundle?.mirror?.relayUrl || null,
      blindPeer: bundle?.mirror?.blindPeer || null,
      fastForward: bundle?.mirror?.fastForward || null
    },
    lease: {
      writerCore: bundle?.lease?.writerCore || null,
      writerCoreHex: bundle?.lease?.writerCoreHex || null,
      autobaseLocal: bundle?.lease?.autobaseLocal || null,
      certificate: normalizeLeaseCertificate(bundle?.lease?.certificate || null)
    },
    openJoin: bundle?.openJoin || null,
    closedJoin: bundle?.closedJoin || null,
    authorityPolicyHash: bundle?.authorityPolicyHash || null
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export {
  computeJoinMaterialDigest,
  normalizeJoinMaterialBundle,
  normalizeLeaseCertificate,
  normalizePurpose
};
