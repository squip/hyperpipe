import { randomBytes } from 'node:crypto';

import {
  issueClientToken,
  verifyClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';

function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function normalizeScope(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'creator' || normalized === 'relay') return normalized;
  return null;
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeRelayKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed;
  return null;
}

function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

class GatewayCredentialService {
  constructor({
    rootSecret,
    logger = console,
    challengeTtlMs = 2 * 60 * 1000,
    creatorCredentialTtlMs = 30 * 24 * 60 * 60 * 1000,
    relayCredentialTtlMs = null
  } = {}) {
    if (!rootSecret || typeof rootSecret !== 'string' || !rootSecret.trim()) {
      throw new Error('GatewayCredentialService requires root secret');
    }
    this.rootSecret = rootSecret.trim();
    this.logger = logger;
    this.challengeTtlMs = Number.isFinite(challengeTtlMs) && challengeTtlMs > 0
      ? Math.trunc(challengeTtlMs)
      : 2 * 60 * 1000;
    this.creatorCredentialTtlMs = Number.isFinite(creatorCredentialTtlMs) && creatorCredentialTtlMs > 0
      ? Math.trunc(creatorCredentialTtlMs)
      : null;
    this.relayCredentialTtlMs = Number.isFinite(relayCredentialTtlMs) && relayCredentialTtlMs > 0
      ? Math.trunc(relayCredentialTtlMs)
      : null;
    this.challenges = new Map();
  }

  issueChallenge({ origin, purpose = 'gateway-auth-redeem' } = {}) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) {
      throw new Error('origin is required for gateway auth challenge');
    }
    const challenge = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.challengeTtlMs;
    this.challenges.set(challenge, {
      challenge,
      nonce,
      origin: normalizedOrigin,
      purpose,
      issuedAt,
      expiresAt
    });
    return {
      challenge,
      nonce,
      origin: normalizedOrigin,
      purpose,
      issuedAt,
      expiresAt
    };
  }

  consumeChallenge(challenge) {
    if (typeof challenge !== 'string' || !challenge.trim()) return null;
    const key = challenge.trim();
    const entry = this.challenges.get(key) || null;
    if (!entry) return null;
    this.challenges.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  issueCreatorCredential({ origin, creatorPubkey, credentialVersion = 1, expiresAt = undefined } = {}) {
    return this.#issueCredential({
      origin,
      scope: 'creator',
      creatorPubkey,
      credentialVersion,
      expiresAt,
      ttlMs: this.creatorCredentialTtlMs
    });
  }

  issueRelayCredential({ origin, relayKey, creatorPubkey, credentialVersion = 1, expiresAt = undefined } = {}) {
    return this.#issueCredential({
      origin,
      scope: 'relay',
      relayKey,
      creatorPubkey,
      credentialVersion,
      expiresAt,
      ttlMs: this.relayCredentialTtlMs
    });
  }

  #issueCredential({ origin, scope, relayKey = null, creatorPubkey = null, credentialVersion = 1, expiresAt = undefined, ttlMs = null } = {}) {
    const normalizedOrigin = normalizeOrigin(origin);
    const normalizedScope = normalizeScope(scope);
    const normalizedRelayKey = normalizeRelayKey(relayKey);
    const normalizedCreatorPubkey = normalizePubkey(creatorPubkey);
    if (!normalizedOrigin) throw new Error('invalid credential origin');
    if (!normalizedScope) throw new Error('invalid credential scope');
    if (normalizedScope === 'relay' && !normalizedRelayKey) {
      throw new Error('relay scope requires relayKey');
    }
    const issuedAt = Date.now();
    const resolvedExpiresAt = Number.isFinite(expiresAt)
      ? Number(expiresAt)
      : (Number.isFinite(ttlMs) && ttlMs > 0 ? issuedAt + ttlMs : null);
    const envelopePayload = {
      kind: 'gateway-credential',
      version: 1,
      origin: normalizedOrigin,
      scope: normalizedScope,
      relayKey: normalizedRelayKey,
      creatorPubkey: normalizedCreatorPubkey,
      credentialVersion: Number.isFinite(Number(credentialVersion))
        ? Math.max(1, Math.trunc(Number(credentialVersion)))
        : 1,
      issuedAt,
      expiresAt: Number.isFinite(resolvedExpiresAt) ? Number(resolvedExpiresAt) : null
    };
    const token = issueClientToken(envelopePayload, this.rootSecret);
    return {
      version: 1,
      origin: normalizedOrigin,
      scope: normalizedScope,
      relayKey: normalizedRelayKey,
      creatorPubkey: normalizedCreatorPubkey,
      issuedAt,
      expiresAt: envelopePayload.expiresAt,
      credentialVersion: envelopePayload.credentialVersion,
      token
    };
  }

  verifyToken(token, {
    origin = null,
    scope = null,
    relayKey = null,
    creatorPubkey = null
  } = {}) {
    const payload = verifyClientToken(token, this.rootSecret);
    if (!payload || payload.kind !== 'gateway-credential') {
      return { ok: false, reason: 'invalid-credential-token' };
    }

    const tokenOrigin = normalizeOrigin(payload.origin);
    const tokenScope = normalizeScope(payload.scope);
    const tokenRelayKey = normalizeRelayKey(payload.relayKey);
    const tokenCreator = normalizePubkey(payload.creatorPubkey || payload.pubkey || payload.sub);
    const tokenExpiresAt = Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null;

    if (!tokenOrigin || !tokenScope) {
      return { ok: false, reason: 'credential-token-missing-fields' };
    }

    if (tokenExpiresAt && tokenExpiresAt <= Date.now()) {
      return { ok: false, reason: 'credential-expired' };
    }

    const expectedOrigin = normalizeOrigin(origin);
    if (expectedOrigin && tokenOrigin !== expectedOrigin) {
      return { ok: false, reason: 'credential-origin-mismatch' };
    }

    const expectedScope = normalizeScope(scope);
    if (expectedScope && tokenScope !== expectedScope) {
      return { ok: false, reason: 'credential-scope-mismatch' };
    }

    const expectedRelayKey = normalizeRelayKey(relayKey);
    if (expectedRelayKey && tokenRelayKey !== expectedRelayKey) {
      return { ok: false, reason: 'credential-relay-mismatch' };
    }

    const expectedCreator = normalizePubkey(creatorPubkey);
    if (expectedCreator && tokenCreator !== expectedCreator) {
      return { ok: false, reason: 'credential-creator-mismatch' };
    }

    return {
      ok: true,
      payload: {
        version: Number.isFinite(Number(payload.version)) ? Number(payload.version) : 1,
        origin: tokenOrigin,
        scope: tokenScope,
        relayKey: tokenRelayKey,
        creatorPubkey: tokenCreator,
        issuedAt: Number.isFinite(Number(payload.issuedAt)) ? Number(payload.issuedAt) : null,
        expiresAt: tokenExpiresAt,
        credentialVersion: Number.isFinite(Number(payload.credentialVersion))
          ? Math.max(1, Math.trunc(Number(payload.credentialVersion)))
          : 1,
        token
      }
    };
  }

  verifyBearer(authorizationHeader, options = {}) {
    const token = parseBearerToken(authorizationHeader);
    if (!token) return { ok: false, reason: 'missing-bearer-token' };
    return this.verifyToken(token, options);
  }

  verifyEnvelope(envelope, options = {}) {
    if (!envelope || typeof envelope !== 'object') {
      return { ok: false, reason: 'missing-envelope' };
    }
    const token = typeof envelope.token === 'string' ? envelope.token : null;
    if (!token) return { ok: false, reason: 'missing-envelope-token' };
    const verified = this.verifyToken(token, {
      origin: options.origin || envelope.origin || null,
      scope: options.scope || envelope.scope || null,
      relayKey: options.relayKey || envelope.relayKey || null,
      creatorPubkey: options.creatorPubkey || envelope.creatorPubkey || null
    });
    if (!verified.ok) return verified;
    return {
      ok: true,
      envelope: {
        version: Number.isFinite(Number(envelope.version)) ? Number(envelope.version) : 1,
        origin: verified.payload.origin,
        scope: verified.payload.scope,
        relayKey: verified.payload.relayKey,
        creatorPubkey: verified.payload.creatorPubkey,
        issuedAt: verified.payload.issuedAt,
        expiresAt: verified.payload.expiresAt,
        credentialVersion: verified.payload.credentialVersion,
        token
      }
    };
  }

  redactEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;
    return {
      version: Number.isFinite(Number(envelope.version)) ? Number(envelope.version) : 1,
      origin: normalizeOrigin(envelope.origin),
      scope: normalizeScope(envelope.scope),
      relayKey: normalizeRelayKey(envelope.relayKey),
      creatorPubkey: normalizePubkey(envelope.creatorPubkey),
      issuedAt: Number.isFinite(Number(envelope.issuedAt)) ? Number(envelope.issuedAt) : null,
      expiresAt: Number.isFinite(Number(envelope.expiresAt)) ? Number(envelope.expiresAt) : null,
      credentialVersion: Number.isFinite(Number(envelope.credentialVersion))
        ? Math.max(1, Math.trunc(Number(envelope.credentialVersion)))
        : 1,
      hasToken: typeof envelope.token === 'string' && envelope.token.length > 0,
      tokenLength: typeof envelope.token === 'string' ? envelope.token.length : 0
    };
  }
}

export {
  GatewayCredentialService,
  normalizeOrigin,
  normalizeScope,
  normalizePubkey,
  normalizeRelayKey,
  parseBearerToken
};

export default GatewayCredentialService;
