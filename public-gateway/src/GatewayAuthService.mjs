import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64url(value) {
  return Buffer.from(value, 'base64url');
}

function normalizeScope(scope) {
  if (typeof scope !== 'string') return null;
  const trimmed = scope.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeRelayKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
  if (/[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function signHmac(input, secret) {
  const hmac = createHmac('sha256', secret);
  hmac.update(input);
  return hmac.digest();
}

function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

class GatewayAuthService {
  constructor({ config = {}, logger = console } = {}) {
    this.logger = logger;
    this.jwtSecret = typeof config?.jwtSecret === 'string' && config.jwtSecret.trim().length
      ? config.jwtSecret.trim()
      : randomBytes(32).toString('hex');
    this.tokenTtlSec = Number.isFinite(config?.tokenTtlSec) && config.tokenTtlSec > 0
      ? Math.trunc(config.tokenTtlSec)
      : 3600;
    this.challengeTtlMs = Number.isFinite(config?.challengeTtlMs) && config.challengeTtlMs > 0
      ? Math.trunc(config.challengeTtlMs)
      : 2 * 60 * 1000;
    this.authWindowSec = Number.isFinite(config?.authWindowSec) && config.authWindowSec > 0
      ? Math.trunc(config.authWindowSec)
      : 300;
    this.issuer = typeof config?.issuer === 'string' && config.issuer.trim().length
      ? config.issuer.trim()
      : 'hypertuna-public-gateway';
    this.challenges = new Map();
  }

  issueChallenge({ pubkey, scope, relayKey = null } = {}) {
    const normalizedPubkey = normalizePubkey(pubkey);
    const normalizedScope = normalizeScope(scope);
    if (!normalizedPubkey) {
      throw new Error('pubkey is required');
    }
    if (!normalizedScope) {
      throw new Error('scope is required');
    }
    const challengeId = randomBytes(12).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const now = Date.now();
    const entry = {
      challengeId,
      nonce,
      pubkey: normalizedPubkey,
      scope: normalizedScope,
      relayKey: normalizeRelayKey(relayKey),
      issuedAt: now,
      expiresAt: now + this.challengeTtlMs
    };
    this.challenges.set(challengeId, entry);
    return {
      challengeId: entry.challengeId,
      nonce: entry.nonce,
      expiresAt: entry.expiresAt,
      pubkey: entry.pubkey,
      scope: entry.scope,
      relayKey: entry.relayKey
    };
  }

  pruneExpiredChallenges() {
    const now = Date.now();
    for (const [challengeId, entry] of this.challenges.entries()) {
      if (!entry?.expiresAt || entry.expiresAt <= now) {
        this.challenges.delete(challengeId);
      }
    }
  }

  async verifyChallenge({ challengeId, authEvent } = {}) {
    this.pruneExpiredChallenges();
    const entry = this.challenges.get(challengeId);
    if (!entry) {
      return { ok: false, reason: 'challenge-not-found' };
    }
    this.challenges.delete(challengeId);
    const verified = await this.#verifyAuthEvent(authEvent, entry);
    if (!verified.ok) {
      return verified;
    }
    const token = this.issueToken({
      sub: entry.pubkey,
      pubkey: entry.pubkey,
      scope: entry.scope,
      relayKey: entry.relayKey
    });
    return {
      ok: true,
      token,
      tokenType: 'Bearer',
      expiresIn: this.tokenTtlSec,
      pubkey: entry.pubkey,
      scope: entry.scope,
      relayKey: entry.relayKey
    };
  }

  issueToken(claims = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      ...claims,
      iss: this.issuer,
      iat: nowSec,
      exp: nowSec + this.tokenTtlSec
    };
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = base64url(stableJson(header));
    const encodedPayload = base64url(stableJson(payload));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signature = base64url(signHmac(data, this.jwtSecret));
    return `${data}.${signature}`;
  }

  verifyToken(token, { requiredScopes = [], relayKey = null, pubkey = null } = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      return { ok: false, reason: 'missing-token' };
    }
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return { ok: false, reason: 'invalid-token-format' };
    }
    const signed = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = signHmac(signed, this.jwtSecret);
    let providedSignature = null;
    try {
      providedSignature = decodeBase64url(encodedSignature);
    } catch (_err) {
      return { ok: false, reason: 'invalid-token-signature' };
    }
    if (
      !Buffer.isBuffer(providedSignature)
      || providedSignature.length !== expectedSignature.length
      || !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return { ok: false, reason: 'invalid-token-signature' };
    }

    let payload = null;
    try {
      payload = JSON.parse(decodeBase64url(encodedPayload).toString('utf8'));
    } catch (_err) {
      return { ok: false, reason: 'invalid-token-payload' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload?.exp) || payload.exp <= nowSec) {
      return { ok: false, reason: 'token-expired' };
    }

    const tokenPubkey = normalizePubkey(payload?.pubkey || payload?.sub);
    if (pubkey && tokenPubkey && tokenPubkey !== normalizePubkey(pubkey)) {
      return { ok: false, reason: 'token-pubkey-mismatch' };
    }
    const tokenRelayKey = normalizeRelayKey(payload?.relayKey);
    if (relayKey && tokenRelayKey && tokenRelayKey !== normalizeRelayKey(relayKey)) {
      return { ok: false, reason: 'token-relay-key-mismatch' };
    }

    const required = Array.isArray(requiredScopes)
      ? requiredScopes.map(normalizeScope).filter(Boolean)
      : [];
    const tokenScope = normalizeScope(payload?.scope);
    if (required.length > 0 && !required.includes(tokenScope)) {
      return { ok: false, reason: 'token-scope-mismatch' };
    }

    return { ok: true, payload };
  }

  verifyBearer(authorizationHeader, options = {}) {
    const token = parseBearerToken(authorizationHeader);
    if (!token) return { ok: false, reason: 'missing-bearer-token' };
    return this.verifyToken(token, options);
  }

  async #verifyAuthEvent(event, challengeEntry) {
    if (!event || typeof event !== 'object') {
      return { ok: false, reason: 'missing-auth-event' };
    }
    if (event.kind !== 22242) {
      return { ok: false, reason: 'invalid-auth-kind' };
    }
    const pubkey = normalizePubkey(event.pubkey);
    if (!pubkey || pubkey !== challengeEntry.pubkey) {
      return { ok: false, reason: 'auth-pubkey-mismatch' };
    }
    const createdAt = Number(event.created_at);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(createdAt) || Math.abs(nowSec - createdAt) > this.authWindowSec) {
      return { ok: false, reason: 'auth-event-expired' };
    }

    const tags = Array.isArray(event.tags) ? event.tags : [];
    const challengeTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'challenge' && typeof tag[1] === 'string')?.[1] || null;
    if (!challengeTag || challengeTag !== challengeEntry.nonce) {
      return { ok: false, reason: 'challenge-mismatch' };
    }
    const scopeTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'scope' && typeof tag[1] === 'string')?.[1] || null;
    if (scopeTag && normalizeScope(scopeTag) !== challengeEntry.scope) {
      return { ok: false, reason: 'scope-mismatch' };
    }

    const eventContent = typeof event.content === 'string' ? event.content : '';
    const serialized = JSON.stringify([
      0,
      pubkey,
      createdAt,
      event.kind,
      tags,
      eventContent
    ]);
    const computedId = createHash('sha256').update(serialized).digest('hex');
    if (typeof event.id === 'string' && event.id !== computedId) {
      return { ok: false, reason: 'event-id-mismatch' };
    }

    const sigBytes = hexToBytes(event.sig);
    const pubkeyBytes = hexToBytes(pubkey);
    const messageBytes = hexToBytes(computedId);
    if (!sigBytes || !pubkeyBytes || !messageBytes) {
      return { ok: false, reason: 'invalid-signature-encoding' };
    }
    try {
      const valid = await schnorr.verify(sigBytes, messageBytes, pubkeyBytes);
      if (!valid) return { ok: false, reason: 'invalid-signature' };
    } catch (error) {
      this.logger?.warn?.('[GatewayAuth] Auth event signature verification failed', {
        error: error?.message || error
      });
      return { ok: false, reason: 'invalid-signature' };
    }
    return { ok: true, pubkey };
  }
}

export {
  GatewayAuthService,
  parseBearerToken,
  normalizeScope
};

export default GatewayAuthService;
