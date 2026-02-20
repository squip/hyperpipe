import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

const WRITER_LEASE_VERSION = 1;
const WRITER_LEASE_SCOPE = 'invite-lease';

function normalizeHex(value, expectedLength = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[^a-f0-9]/i.test(trimmed)) return null;
  if (expectedLength && trimmed.length !== expectedLength) return null;
  return trimmed;
}

function normalizePubkey(value) {
  return normalizeHex(value, 64);
}

function normalizeRelayKey(value) {
  return normalizeHex(value, 64);
}

function normalizeScope(value) {
  const scope = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return scope || WRITER_LEASE_SCOPE;
}

function normalizeWriterSecret(value) {
  const normalized = normalizeHex(value);
  if (!normalized) return null;
  if (normalized.length === 64 || normalized.length === 128) {
    return normalized;
  }
  return null;
}

function normalizeLeaseId(value) {
  const normalized = normalizeHex(value);
  if (!normalized || normalized.length < 16) return null;
  return normalized;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

function stableSerialize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return 'null';
}

function hashHex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

function hexToBytes(hex, expectedLength = null) {
  const normalized = normalizeHex(hex, expectedLength);
  return normalized ? Buffer.from(normalized, 'hex') : null;
}

export function computeWriterLeaseTokenHash(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  return hashHex(`ht-writer-lease:v1:${token.trim()}`);
}

export function normalizeWriterLeaseEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const version = Number(raw.version);
  const leaseId = normalizeLeaseId(raw.leaseId);
  const relayKey = normalizeRelayKey(raw.relayKey);
  const publicIdentifier = typeof raw.publicIdentifier === 'string' && raw.publicIdentifier.trim()
    ? raw.publicIdentifier.trim()
    : null;
  const scope = normalizeScope(raw.scope);
  const inviteePubkey = normalizePubkey(raw.inviteePubkey);
  const tokenHash = normalizeHex(raw.tokenHash, 64);
  const writerCore = typeof raw.writerCore === 'string' && raw.writerCore.trim()
    ? raw.writerCore.trim()
    : null;
  let writerCoreHex = normalizeHex(raw.writerCoreHex, 64);
  let autobaseLocal = normalizeHex(raw.autobaseLocal, 64);
  const writerSecret = normalizeWriterSecret(raw.writerSecret);
  const issuedAt = normalizeTimestamp(raw.issuedAt);
  const expiresAt = normalizeTimestamp(raw.expiresAt);
  const issuerPubkey = normalizePubkey(raw.issuerPubkey);
  const issuerPeerKey = normalizeHex(raw.issuerPeerKey, 64);
  const signature = normalizeHex(raw.signature, 128);

  if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex;
  if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal;

  if (version !== WRITER_LEASE_VERSION) return null;
  if (!leaseId || !relayKey || !inviteePubkey || !tokenHash) return null;
  if (!writerSecret || !(writerCore || writerCoreHex || autobaseLocal)) return null;
  if (!issuedAt || !expiresAt || expiresAt <= issuedAt) return null;
  if (!issuerPubkey || !signature) return null;

  return {
    version,
    leaseId,
    relayKey,
    publicIdentifier,
    scope,
    inviteePubkey,
    tokenHash,
    writerCore,
    writerCoreHex,
    autobaseLocal,
    writerSecret,
    issuedAt,
    expiresAt,
    issuerPubkey,
    issuerPeerKey,
    signature
  };
}

export function buildWriterLeaseSigningPayload(raw) {
  const normalized = normalizeWriterLeaseEnvelope({
    ...raw,
    signature: raw?.signature || '0'.repeat(128)
  });
  if (!normalized) return null;
  const payload = {
    version: normalized.version,
    leaseId: normalized.leaseId,
    relayKey: normalized.relayKey,
    publicIdentifier: normalized.publicIdentifier,
    scope: normalized.scope,
    inviteePubkey: normalized.inviteePubkey,
    tokenHash: normalized.tokenHash,
    writerCore: normalized.writerCore,
    writerCoreHex: normalized.writerCoreHex,
    autobaseLocal: normalized.autobaseLocal,
    writerSecret: normalized.writerSecret,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    issuerPubkey: normalized.issuerPubkey,
    issuerPeerKey: normalized.issuerPeerKey
  };
  return payload;
}

export function createWriterLeaseEnvelope({
  relayKey,
  publicIdentifier = null,
  inviteePubkey,
  inviteToken = null,
  tokenHash = null,
  writerCore = null,
  writerCoreHex = null,
  autobaseLocal = null,
  writerSecret = null,
  issuedAt = Date.now(),
  expiresAt,
  issuerPubkey,
  issuerPeerKey = null,
  issuerPrivkey,
  scope = WRITER_LEASE_SCOPE
} = {}) {
  const normalizedRelayKey = normalizeRelayKey(relayKey);
  const normalizedInvitee = normalizePubkey(inviteePubkey);
  const normalizedIssuerPubkey = normalizePubkey(issuerPubkey);
  const normalizedIssuerPrivkey = normalizeHex(issuerPrivkey, 64);
  let normalizedWriterCoreHex = normalizeHex(writerCoreHex, 64);
  let normalizedAutobaseLocal = normalizeHex(autobaseLocal, 64);
  const normalizedWriterSecret = normalizeWriterSecret(writerSecret);

  if (normalizedWriterCoreHex && !normalizedAutobaseLocal) normalizedAutobaseLocal = normalizedWriterCoreHex;
  if (normalizedAutobaseLocal && !normalizedWriterCoreHex) normalizedWriterCoreHex = normalizedAutobaseLocal;

  const normalizedTokenHash = normalizeHex(tokenHash, 64) || computeWriterLeaseTokenHash(inviteToken);
  const normalizedIssuedAt = normalizeTimestamp(issuedAt) || Date.now();
  const normalizedExpiresAt = normalizeTimestamp(expiresAt) || (normalizedIssuedAt + (90 * 24 * 60 * 60 * 1000));

  if (!normalizedRelayKey) throw new Error('create-writer-lease:missing-relay-key');
  if (!normalizedInvitee) throw new Error('create-writer-lease:missing-invitee-pubkey');
  if (!normalizedIssuerPubkey || !normalizedIssuerPrivkey) throw new Error('create-writer-lease:missing-issuer-material');
  if (!normalizedTokenHash) throw new Error('create-writer-lease:missing-token-hash');
  if (!normalizedWriterSecret) throw new Error('create-writer-lease:missing-writer-secret');
  if (!(writerCore || normalizedWriterCoreHex || normalizedAutobaseLocal)) {
    throw new Error('create-writer-lease:missing-writer-core');
  }
  if (normalizedExpiresAt <= normalizedIssuedAt) {
    throw new Error('create-writer-lease:invalid-expiry');
  }

  const envelope = {
    version: WRITER_LEASE_VERSION,
    leaseId: randomBytes(16).toString('hex'),
    relayKey: normalizedRelayKey,
    publicIdentifier: typeof publicIdentifier === 'string' && publicIdentifier.trim()
      ? publicIdentifier.trim()
      : null,
    scope: normalizeScope(scope),
    inviteePubkey: normalizedInvitee,
    tokenHash: normalizedTokenHash,
    writerCore: typeof writerCore === 'string' && writerCore.trim() ? writerCore.trim() : null,
    writerCoreHex: normalizedWriterCoreHex,
    autobaseLocal: normalizedAutobaseLocal,
    writerSecret: normalizedWriterSecret,
    issuedAt: normalizedIssuedAt,
    expiresAt: normalizedExpiresAt,
    issuerPubkey: normalizedIssuerPubkey,
    issuerPeerKey: normalizeHex(issuerPeerKey, 64)
  };

  const signingPayload = buildWriterLeaseSigningPayload({ ...envelope, signature: '0'.repeat(128) });
  if (!signingPayload) {
    throw new Error('create-writer-lease:invalid-payload');
  }
  const payloadDigestHex = hashHex(stableSerialize(signingPayload));
  const messageBytes = hexToBytes(payloadDigestHex, 64);
  const signerBytes = hexToBytes(normalizedIssuerPrivkey, 64);
  if (!messageBytes || !signerBytes) {
    throw new Error('create-writer-lease:invalid-signing-bytes');
  }

  envelope.signature = Buffer.from(schnorr.sign(messageBytes, signerBytes)).toString('hex');
  return envelope;
}

export function verifyWriterLeaseEnvelope(raw, {
  writerIssuerPubkey = null,
  expectedRelayKey = null,
  expectedPublicIdentifier = null,
  inviteePubkey = null,
  tokenHash = null,
  nowMs = Date.now()
} = {}) {
  const envelope = normalizeWriterLeaseEnvelope(raw);
  if (!envelope) {
    return { ok: false, reason: 'invalid-envelope', envelope: null };
  }

  if (writerIssuerPubkey) {
    const expectedIssuer = normalizePubkey(writerIssuerPubkey);
    if (!expectedIssuer || expectedIssuer !== envelope.issuerPubkey) {
      return { ok: false, reason: 'issuer-mismatch', envelope };
    }
  }

  if (expectedRelayKey) {
    const normalizedExpectedRelayKey = normalizeRelayKey(expectedRelayKey);
    if (normalizedExpectedRelayKey && normalizedExpectedRelayKey !== envelope.relayKey) {
      return { ok: false, reason: 'relay-mismatch', envelope };
    }
  }

  if (expectedPublicIdentifier) {
    const expectedIdentifier = String(expectedPublicIdentifier).trim();
    if (expectedIdentifier && envelope.publicIdentifier && envelope.publicIdentifier !== expectedIdentifier) {
      return { ok: false, reason: 'public-identifier-mismatch', envelope };
    }
  }

  if (inviteePubkey) {
    const normalizedInvitee = normalizePubkey(inviteePubkey);
    if (normalizedInvitee && envelope.inviteePubkey !== normalizedInvitee) {
      return { ok: false, reason: 'invitee-mismatch', envelope };
    }
  }

  if (tokenHash) {
    const normalizedTokenHash = normalizeHex(tokenHash, 64);
    if (normalizedTokenHash && envelope.tokenHash !== normalizedTokenHash) {
      return { ok: false, reason: 'token-mismatch', envelope };
    }
  }

  if (Number.isFinite(nowMs) && envelope.expiresAt <= nowMs) {
    return { ok: false, reason: 'expired', envelope };
  }

  const signingPayload = buildWriterLeaseSigningPayload(envelope);
  if (!signingPayload) {
    return { ok: false, reason: 'invalid-signing-payload', envelope };
  }

  const digestHex = hashHex(stableSerialize(signingPayload));
  const messageBytes = hexToBytes(digestHex, 64);
  const signatureBytes = hexToBytes(envelope.signature, 128);
  const pubkeyBytes = hexToBytes(envelope.issuerPubkey, 64);

  if (!messageBytes || !signatureBytes || !pubkeyBytes) {
    return { ok: false, reason: 'invalid-signature-bytes', envelope };
  }

  let verified = false;
  try {
    verified = schnorr.verify(signatureBytes, messageBytes, pubkeyBytes);
  } catch (_) {
    verified = false;
  }

  if (!verified) {
    return { ok: false, reason: 'invalid-signature', envelope };
  }

  return { ok: true, reason: 'ok', envelope };
}

export function writerLeaseEnvelopeToPoolEntry(raw, source = null) {
  const normalized = normalizeWriterLeaseEnvelope(raw);
  if (!normalized) return null;
  return {
    writerCore: normalized.writerCore || null,
    writerCoreHex: normalized.writerCoreHex || normalized.autobaseLocal || null,
    autobaseLocal: normalized.autobaseLocal || normalized.writerCoreHex || null,
    writerSecret: normalized.writerSecret,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    leaseVersion: normalized.version,
    leaseId: normalized.leaseId,
    leaseScope: normalized.scope,
    inviteePubkey: normalized.inviteePubkey,
    tokenHash: normalized.tokenHash,
    issuerPubkey: normalized.issuerPubkey,
    issuerPeerKey: normalized.issuerPeerKey || null,
    signature: normalized.signature,
    relayKey: normalized.relayKey,
    publicIdentifier: normalized.publicIdentifier || null,
    source: typeof source === 'string' && source.trim() ? source.trim() : null
  };
}

export {
  WRITER_LEASE_VERSION,
  WRITER_LEASE_SCOPE
};
