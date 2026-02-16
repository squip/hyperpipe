import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

import {
  createRelayRegistration,
  createSignature
} from '../../shared/auth/PublicGatewayTokens.mjs';

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

class PublicGatewayRegistrar {
  constructor({
    baseUrl,
    sharedSecret,
    logger,
    fetchImpl = globalThis.fetch,
    getWorkerPubkey = null,
    getWorkerPrivateKey = null,
    getWorkerEncryptPubkey = null
  } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.sharedSecret = typeof sharedSecret === 'string' ? sharedSecret.trim() : '';
    this.fetch = fetchImpl;
    this.logger = logger || console;
    this.getWorkerPubkey = typeof getWorkerPubkey === 'function' ? getWorkerPubkey : null;
    this.getWorkerPrivateKey = typeof getWorkerPrivateKey === 'function' ? getWorkerPrivateKey : null;
    this.getWorkerEncryptPubkey = typeof getWorkerEncryptPubkey === 'function' ? getWorkerEncryptPubkey : null;
    this.enabled = Boolean(this.baseUrl && typeof this.fetch === 'function');
    this.controlSession = null;
  }

  isEnabled() {
    return this.enabled;
  }

  isBridgeTokenEnabled() {
    return this.enabled && !!this.sharedSecret;
  }

  #classifyRelayKey(value) {
    if (typeof value !== 'string') return 'unknown';
    const trimmed = value.trim();
    if (!trimmed) return 'unknown';
    return /^[0-9a-fA-F]{64}$/.test(trimmed) ? 'hex' : 'alias';
  }

  #getWorkerPubkey() {
    const value = this.getWorkerPubkey?.();
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  #getWorkerPrivateKey() {
    const value = this.getWorkerPrivateKey?.();
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  #getWorkerEncryptPubkey() {
    const value = this.getWorkerEncryptPubkey?.();
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  #sessionIsFresh(minRemainingMs = 30_000) {
    if (!this.controlSession?.accessToken) return false;
    const expiresAt = Number(this.controlSession?.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return (expiresAt - Date.now()) > minRemainingMs;
  }

  async #signChallenge(challenge, privateKeyHex) {
    const digest = createHash('sha256').update(String(challenge)).digest('hex');
    const signature = await schnorr.sign(digest, privateKeyHex);
    return toHex(signature);
  }

  async #ensureControlSession({ force = false } = {}) {
    if (!this.enabled) {
      throw new Error('Public gateway registrar not configured');
    }

    if (!force && this.#sessionIsFresh()) {
      return this.controlSession;
    }

    const workerPubkey = this.#getWorkerPubkey();
    const workerPrivateKey = this.#getWorkerPrivateKey();
    const workerEncryptPubkey = this.#getWorkerEncryptPubkey();

    if (!workerPubkey || !workerPrivateKey) {
      throw new Error('Worker identity is not configured for v2 control auth');
    }

    const challengeResponse = await this.#requestJson('/api/v2/auth/challenge', {
      method: 'POST',
      body: {
        workerPubkey,
        workerEncryptPubkey
      },
      expectJson: true
    });

    const challenge = typeof challengeResponse?.challenge === 'string'
      ? challengeResponse.challenge.trim()
      : null;
    if (!challenge) {
      throw new Error('Gateway challenge response is missing challenge');
    }

    const signature = await this.#signChallenge(challenge, workerPrivateKey);

    const sessionResponse = await this.#requestJson('/api/v2/auth/session', {
      method: 'POST',
      body: {
        challenge,
        workerPubkey,
        workerEncryptPubkey,
        signature
      },
      expectJson: true
    });

    const accessToken = typeof sessionResponse?.accessToken === 'string'
      ? sessionResponse.accessToken
      : null;
    if (!accessToken) {
      throw new Error('Gateway session response is missing accessToken');
    }

    const expiresAt = Number(sessionResponse?.expiresAt);
    this.controlSession = {
      accessToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : (Date.now() + (25 * 60 * 1000)),
      gatewayPubkey: sessionResponse?.gatewayPubkey || null,
      sessionPublicKey: sessionResponse?.sessionPublicKey || null
    };

    return this.controlSession;
  }

  async #authorizedHeaders() {
    const session = await this.#ensureControlSession();
    return {
      authorization: `Bearer ${session.accessToken}`
    };
  }

  async registerRelay(relayKey, payload = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    this.logger?.info?.('[PublicGatewayRegistrar] Relay registration request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });

    const registration = createRelayRegistration(relayKey, payload);

    try {
      const headers = await this.#authorizedHeaders();
      const data = await this.#requestJson('/api/v2/relays/register', {
        method: 'POST',
        headers,
        body: registration,
        expectJson: true
      });
      this.logger.info?.('Relay registered with public gateway', { relayKey });
      return { success: true, ...data };
    } catch (error) {
      this.logger.error?.('Failed to register relay with public gateway', {
        relayKey,
        error: error?.message || error
      });
      return { success: false, error: error?.message || String(error) };
    }
  }

  async unregisterRelay(relayKey) {
    if (!this.isEnabled()) return false;
    const path = `/api/relays/${encodeURIComponent(relayKey)}`;

    try {
      if (this.sharedSecret) {
        const signature = createSignature({ relayKey }, this.sharedSecret);
        const response = await this.#requestRaw(path, {
          method: 'DELETE',
          headers: { 'x-signature': signature }
        });
        if (!response.ok) {
          this.logger.warn?.('Public gateway unregister failed', { relayKey, status: response.status });
          return false;
        }
        this.logger.info?.('Relay unregistered from public gateway', { relayKey });
        return true;
      }

      const authHeaders = await this.#authorizedHeaders();
      const response = await this.#requestRaw(path, {
        method: 'DELETE',
        headers: authHeaders
      });
      if (!response.ok) {
        this.logger.warn?.('Public gateway unregister failed', { relayKey, status: response.status });
        return false;
      }
      this.logger.info?.('Relay unregistered from public gateway', { relayKey });
      return true;
    } catch (error) {
      this.logger.error?.('Failed to unregister relay', { relayKey, error: error?.message || error });
      return false;
    }
  }

  async issueGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayRegistrar] Relay token issue request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/issue', body);
  }

  async refreshGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayRegistrar] Relay token refresh request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/refresh', body);
  }

  async revokeGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayRegistrar] Relay token revoke request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/revoke', body);
  }

  async updateOpenJoinPool(relayKey, entries = [], options = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');
    this.logger?.info?.('[PublicGatewayRegistrar] Open join pool update request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey),
      entriesCount: Array.isArray(entries) ? entries.length : 0
    });

    const metadata = options?.metadata && typeof options.metadata === 'object' ? options.metadata : null;
    const relayCores = Array.isArray(options?.relayCores)
      ? options.relayCores
      : null;
    const aliases = Array.isArray(options?.aliases)
      ? options.aliases
      : null;
    const publicIdentifier = typeof options?.publicIdentifier === 'string'
      ? options.publicIdentifier
      : null;
    const relayUrl = typeof options?.relayUrl === 'string'
      ? options.relayUrl
      : null;

    const payload = {
      relayKey,
      entries: Array.isArray(entries) ? entries : [],
      updatedAt: options.updatedAt || Date.now(),
      targetSize: Number.isFinite(options.targetSize) ? Math.trunc(options.targetSize) : undefined,
      publicIdentifier,
      relayUrl,
      relayCores: relayCores || undefined,
      metadata: metadata || undefined,
      aliases: aliases || undefined
    };

    const headers = await this.#authorizedHeaders();
    const path = `/api/v2/relays/${encodeURIComponent(relayKey)}/open-join/pool`;
    const response = await this.#requestJson(path, {
      method: 'POST',
      headers,
      body: payload,
      expectJson: true
    });

    this.logger?.info?.('[PublicGateway] Open join pool update response', {
      relayKey,
      stored: response?.stored ?? null,
      total: response?.total ?? null,
      needed: response?.needed ?? null,
      targetSize: response?.targetSize ?? null
    });

    return response;
  }

  async updateClosedJoinPool(relayKey, entries = [], options = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    const payload = {
      relayKey,
      entries: Array.isArray(entries) ? entries : [],
      updatedAt: options.updatedAt || Date.now(),
      publicIdentifier: typeof options?.publicIdentifier === 'string' ? options.publicIdentifier : undefined,
      relayUrl: typeof options?.relayUrl === 'string' ? options.relayUrl : undefined,
      relayCores: Array.isArray(options?.relayCores) ? options.relayCores : undefined,
      metadata: options?.metadata && typeof options.metadata === 'object' ? options.metadata : undefined
    };

    const headers = await this.#authorizedHeaders();
    const path = `/api/v2/relays/${encodeURIComponent(relayKey)}/closed-join/pool`;
    return this.#requestJson(path, {
      method: 'POST',
      headers,
      body: payload,
      expectJson: true
    });
  }

  async claimClosedJoinLease(relayKey, payload = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    const headers = await this.#authorizedHeaders();
    const path = `/api/v2/relays/${encodeURIComponent(relayKey)}/closed-join/lease`;
    return this.#requestJson(path, {
      method: 'POST',
      headers,
      body: { relayKey, ...payload },
      expectJson: true
    });
  }

  async #postJson(path, body) {
    if (!this.isEnabled()) {
      throw new Error('Public gateway registrar not configured');
    }
    return this.#requestJson(path, {
      method: 'POST',
      body,
      expectJson: true
    });
  }

  async #requestRaw(path, {
    method = 'GET',
    headers = {},
    body = null
  } = {}) {
    const url = new URL(path, this.baseUrl).toString();
    return this.fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body)
    });
  }

  async #requestJson(path, {
    method = 'GET',
    headers = {},
    body = null,
    expectJson = true
  } = {}) {
    const requestHeaders = {
      accept: 'application/json',
      ...(headers || {})
    };
    if (body != null) {
      requestHeaders['content-type'] = 'application/json';
    }

    const response = await this.#requestRaw(path, {
      method,
      headers: requestHeaders,
      body
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const error = new Error(text || `Gateway responded with status ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }

    if (!expectJson) {
      return text;
    }

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse gateway response: ${error.message}`);
    }
  }

  async #signedPayload(payload) {
    if (!this.sharedSecret) throw new Error('Shared secret not configured');
    const signature = createSignature(payload, this.sharedSecret);
    return { payload, signature };
  }
}

export default PublicGatewayRegistrar;
