import { URL } from 'node:url';

import {
  createRelayRegistration,
  createSignature
} from '../../shared/auth/PublicGatewayTokens.mjs';

class PublicGatewayRegistrar {
  constructor({
    baseUrl,
    sharedSecret = null,
    bearerCredential = null,
    logger,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.sharedSecret = typeof sharedSecret === 'string' && sharedSecret.trim()
      ? sharedSecret.trim()
      : null;
    this.bearerCredential = (
      bearerCredential
      && typeof bearerCredential === 'object'
      && typeof bearerCredential.token === 'string'
      && bearerCredential.token.trim()
    )
      ? { ...bearerCredential, token: bearerCredential.token.trim() }
      : null;
    this.fetch = fetchImpl;
    this.logger = logger || console;
    this.authMode = this.bearerCredential?.token
      ? 'bearer'
      : (this.sharedSecret ? 'legacy-signature' : 'none');
    this.enabled = Boolean(
      this.baseUrl
      && typeof this.fetch === 'function'
      && (this.authMode === 'legacy-signature' || this.authMode === 'bearer')
    );
  }

  isEnabled() {
    return this.enabled;
  }

  isBearerMode() {
    return this.authMode === 'bearer' && !!this.bearerCredential?.token;
  }

  #classifyRelayKey(value) {
    if (typeof value !== 'string') return 'unknown';
    const trimmed = value.trim();
    if (!trimmed) return 'unknown';
    return /^[0-9a-fA-F]{64}$/.test(trimmed) ? 'hex' : 'alias';
  }

  async registerRelay(relayKey, payload = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    this.logger?.info?.('[PublicGatewayRegistrar] Relay registration request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });

    const registration = createRelayRegistration(relayKey, payload);
    const bodyPayload = this.authMode === 'legacy-signature'
      ? { registration, signature: createSignature(registration, this.sharedSecret) }
      : { registration };
    const body = JSON.stringify(bodyPayload);
    const url = new URL('/api/relays', this.baseUrl).toString();

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: this.#buildHeaders({ 'content-type': 'application/json' }),
        body
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn?.('Public gateway registration failed', { status: response.status, relayKey });
        if (text) {
          this.logger.debug?.('Public gateway error response', { body: text, relayKey });
        }
        return { success: false, status: response.status };
      }

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      this.logger.info?.('Relay registered with public gateway', { relayKey });
      return { success: true, ...data };
    } catch (error) {
      this.logger.error?.('Failed to register relay with public gateway', { relayKey, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async unregisterRelay(relayKey) {
    if (!this.isEnabled()) return false;
    const url = new URL(`/api/relays/${encodeURIComponent(relayKey)}`, this.baseUrl).toString();
    const signature = this.authMode === 'legacy-signature'
      ? createSignature({ relayKey }, this.sharedSecret)
      : null;

    try {
      const response = await this.fetch(url, {
        method: 'DELETE',
        headers: this.#buildHeaders(signature ? { 'x-signature': signature } : {})
      });
      if (!response.ok) {
        this.logger.warn?.('Public gateway unregister failed', { relayKey, status: response.status });
        return false;
      }
      this.logger.info?.('Relay unregistered from public gateway', { relayKey });
      return true;
    } catch (error) {
      this.logger.error?.('Failed to unregister relay', { relayKey, error: error.message });
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
    const body = await this.#signedPayload(payload);
    const path = `/api/relays/${encodeURIComponent(relayKey)}/open-join/pool`;
    const entryPreview = payload.entries.slice(0, 3).map((entry) => ({
      writerCore: entry?.writerCore ? String(entry.writerCore).slice(0, 16) : null,
      writerCoreHex: entry?.writerCoreHex
        ? String(entry.writerCoreHex).slice(0, 16)
        : entry?.autobaseLocal
          ? String(entry.autobaseLocal).slice(0, 16)
          : null,
      expiresAt: entry?.expiresAt ?? null
    }));
    this.logger?.info?.('[PublicGateway] Open join pool update request', {
      relayKey,
      entries: payload.entries.length,
      targetSize: payload.targetSize ?? null,
      updatedAt: payload.updatedAt ?? null,
      entryPreview,
      publicIdentifier: payload.publicIdentifier ?? null,
      relayCores: relayCores ? relayCores.length : null,
      aliases: Array.isArray(payload.aliases) ? payload.aliases.length : null
    });
    const response = await this.#postJson(path, body);
    this.logger?.info?.('[PublicGateway] Open join pool update response', {
      relayKey,
      stored: response?.stored ?? null,
      total: response?.total ?? null,
      needed: response?.needed ?? null,
      targetSize: response?.targetSize ?? null
    });
    return response;
  }

  async #postJson(path, body) {
    if (!this.isEnabled()) {
      throw new Error('Public gateway registrar not configured');
    }
    const url = new URL(path, this.baseUrl).toString();
    const response = await this.fetch(url, {
      method: 'POST',
      headers: this.#buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Gateway responded with status ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to parse gateway response: ${error.message}`);
    }
  }

  async #signedPayload(payload) {
    if (this.authMode === 'legacy-signature') {
      if (!this.sharedSecret) throw new Error('Shared secret not configured');
      const signature = createSignature(payload, this.sharedSecret);
      return { payload, signature };
    }
    if (this.authMode === 'bearer') {
      return { payload };
    }
    throw new Error('Public gateway registrar auth mode unavailable');
  }

  async bootstrapCreatorCredential({
    signAuthEvent,
    creatorPubkey = null,
    origin = null
  } = {}) {
    if (!this.baseUrl || typeof this.fetch !== 'function') {
      throw new Error('Public gateway registrar base URL unavailable');
    }
    if (typeof signAuthEvent !== 'function') {
      throw new Error('signAuthEvent callback is required');
    }
    const challengeUrl = new URL('/api/gateway/auth/challenge', this.baseUrl).toString();
    const challengeResponse = await this.fetch(challengeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: origin || this.baseUrl
      })
    });
    if (!challengeResponse.ok) {
      const text = await challengeResponse.text().catch(() => '');
      throw new Error(text || `challenge status ${challengeResponse.status}`);
    }
    const challengeData = await challengeResponse.json().catch(() => null);
    if (!challengeData || typeof challengeData !== 'object') {
      throw new Error('invalid challenge payload');
    }
    const challenge = typeof challengeData.challenge === 'string' ? challengeData.challenge : null;
    const nonce = typeof challengeData.nonce === 'string' ? challengeData.nonce : null;
    if (!challenge || !nonce) {
      throw new Error('challenge missing');
    }
    const authEvent = await signAuthEvent({
      challenge: nonce,
      origin: origin || this.baseUrl,
      purpose: 'gateway-auth-redeem',
      pubkey: creatorPubkey || null
    });
    const redeemUrl = new URL('/api/gateway/auth/redeem', this.baseUrl).toString();
    const redeemResponse = await this.fetch(redeemUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge,
        authEvent
      })
    });
    if (!redeemResponse.ok) {
      const text = await redeemResponse.text().catch(() => '');
      throw new Error(text || `redeem status ${redeemResponse.status}`);
    }
    const redeemData = await redeemResponse.json().catch(() => null);
    const credential =
      redeemData?.credential && typeof redeemData.credential === 'object'
        ? redeemData.credential
        : null;
    if (!credential || typeof credential.token !== 'string' || !credential.token.trim()) {
      throw new Error('gateway credential missing from redeem response');
    }
    return {
      success: true,
      credential
    };
  }

  #buildHeaders(extra = {}) {
    const headers = { ...(extra || {}) };
    if (this.isBearerMode()) {
      headers.authorization = `Bearer ${this.bearerCredential.token}`;
    }
    return headers;
  }
}

export default PublicGatewayRegistrar;
