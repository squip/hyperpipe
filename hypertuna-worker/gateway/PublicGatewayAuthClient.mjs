import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

const AUTH_EVENT_KIND = 22242;
const TOKEN_REFRESH_SKEW_MS = 30_000;
const DEFAULT_TOKEN_TTL_SEC = 120;

function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch (_) {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed : null;
}

function normalizeNsecHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed : null;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function buildTokenCacheKey({ origin, pubkey, scope, relayKey = null }) {
  return `${origin}|${pubkey}|${scope}|${relayKey || ''}`;
}

function parseResponseError(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = typeof payload.error === 'string' ? payload.error.trim() : '';
  if (error) return error;
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason) return reason;
  return fallback;
}

async function readJson(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

class PublicGatewayAuthClient {
  constructor({
    baseUrl,
    getAuthContext,
    logger,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = normalizeOrigin(baseUrl);
    this.getAuthContext = typeof getAuthContext === 'function' ? getAuthContext : () => null;
    this.logger = logger || console;
    this.fetch = fetchImpl;
    this.tokenCache = new Map();
    this.enabled = Boolean(this.baseUrl && typeof this.fetch === 'function');
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeOrigin(baseUrl);
    this.enabled = Boolean(this.baseUrl && typeof this.fetch === 'function');
    this.tokenCache.clear();
  }

  isEnabled() {
    return this.enabled;
  }

  invalidateToken({ scope, relayKey = null } = {}) {
    const context = this.#resolveAuthContext();
    if (!context?.pubkey || !scope || !this.baseUrl) return;
    const cacheKey = buildTokenCacheKey({
      origin: this.baseUrl,
      pubkey: context.pubkey,
      scope,
      relayKey
    });
    this.tokenCache.delete(cacheKey);
  }

  pruneTokenCache(nowMs = Date.now()) {
    for (const [key, entry] of this.tokenCache.entries()) {
      if (!entry?.token || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= nowMs) {
        this.tokenCache.delete(key);
      }
    }
  }

  async issueBearerToken({ scope, relayKey = null, forceRefresh = false } = {}) {
    if (!this.isEnabled()) {
      throw new Error('gateway-auth-disabled');
    }
    const normalizedScope = typeof scope === 'string' ? scope.trim() : '';
    if (!normalizedScope) {
      throw new Error('gateway-auth-scope-required');
    }

    const context = this.#resolveAuthContext();
    if (!context) {
      throw new Error('gateway-auth-context-missing');
    }

    const cacheKey = buildTokenCacheKey({
      origin: this.baseUrl,
      pubkey: context.pubkey,
      scope: normalizedScope,
      relayKey
    });

    const now = Date.now();
    this.pruneTokenCache(now);
    if (!forceRefresh) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
        return cached.token;
      }
    }

    const challengeResponse = await this.fetch(new URL('/api/auth/challenge', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pubkey: context.pubkey,
        scope: normalizedScope,
        relayKey: relayKey || null
      })
    });

    const challengePayload = await readJson(challengeResponse);
    if (!challengeResponse.ok) {
      throw new Error(parseResponseError(challengePayload, `gateway-auth-challenge-${challengeResponse.status}`));
    }

    const challengeId = String(challengePayload?.challengeId || challengePayload?.challenge_id || '').trim();
    const nonce = String(challengePayload?.nonce || '').trim();
    if (!challengeId || !nonce) {
      throw new Error('gateway-auth-challenge-invalid');
    }

    const tags = [
      ['challenge', nonce],
      ['scope', normalizedScope]
    ];
    if (relayKey) {
      tags.push(['relay', String(relayKey)]);
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const id = createHash('sha256')
      .update(JSON.stringify([0, context.pubkey, createdAt, AUTH_EVENT_KIND, tags, '']))
      .digest('hex');

    const privkeyBytes = hexToBytes(context.nsecHex);
    const msgBytes = hexToBytes(id);
    if (!privkeyBytes || !msgBytes) {
      throw new Error('gateway-auth-signing-material-invalid');
    }
    const sig = await schnorr.sign(msgBytes, privkeyBytes);

    const verifyResponse = await this.fetch(new URL('/api/auth/verify', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId,
        authEvent: {
          id,
          kind: AUTH_EVENT_KIND,
          pubkey: context.pubkey,
          created_at: createdAt,
          tags,
          content: '',
          sig: toHex(sig)
        }
      })
    });

    const verifyPayload = await readJson(verifyResponse);
    if (!verifyResponse.ok) {
      throw new Error(parseResponseError(verifyPayload, `gateway-auth-verify-${verifyResponse.status}`));
    }

    const token = typeof verifyPayload?.token === 'string' ? verifyPayload.token.trim() : '';
    if (!token) {
      throw new Error('gateway-auth-token-missing');
    }

    const expiresInSec = Number(verifyPayload?.expiresIn ?? verifyPayload?.expires_in);
    const ttlSec = Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.floor(expiresInSec)
      : DEFAULT_TOKEN_TTL_SEC;

    this.tokenCache.set(cacheKey, {
      token,
      expiresAtMs: Date.now() + ttlSec * 1000
    });

    this.logger?.info?.('[PublicGatewayAuth] Bearer token issued', {
      origin: this.baseUrl,
      scope: normalizedScope,
      relayKey: relayKey || null,
      expiresInSec: ttlSec
    });

    return token;
  }

  #resolveAuthContext() {
    const raw = this.getAuthContext?.();
    if (!raw || typeof raw !== 'object') return null;
    const pubkey = normalizePubkey(raw.pubkey || raw.nostrPubkey || raw.nostr_pubkey_hex);
    const nsecHex = normalizeNsecHex(raw.nsecHex || raw.nsec || raw.nostrNsec || raw.nostr_nsec_hex);
    if (!pubkey || !nsecHex) return null;
    return { pubkey, nsecHex };
  }
}

export default PublicGatewayAuthClient;
