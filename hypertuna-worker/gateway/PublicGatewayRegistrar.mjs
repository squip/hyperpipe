import { URL } from 'node:url';

import {
  createRelayRegistration,
  createSignature
} from '../../shared/auth/PublicGatewayTokens.mjs';

class PublicGatewayRegistrar {
  constructor({ baseUrl, sharedSecret, logger, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.sharedSecret = sharedSecret;
    this.fetch = fetchImpl;
    this.logger = logger || console;
    this.enabled = Boolean(this.baseUrl && this.sharedSecret && typeof this.fetch === 'function');
  }

  isEnabled() {
    return this.enabled;
  }

  async registerRelay(relayKey, payload = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    const registration = createRelayRegistration(relayKey, payload);
    const signature = createSignature(registration, this.sharedSecret);

    const body = JSON.stringify({ registration, signature });
    const url = new URL('/api/relays', this.baseUrl).toString();

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
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
    const signature = createSignature({ relayKey }, this.sharedSecret);

    try {
      const response = await this.fetch(url, {
        method: 'DELETE',
        headers: {
          'x-signature': signature
        }
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
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/issue', body);
  }

  async refreshGatewayToken(relayKey, payload = {}) {
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/refresh', body);
  }

  async revokeGatewayToken(relayKey, payload = {}) {
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/revoke', body);
  }

  async updateOpenJoinPool(relayKey, entries = [], options = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');
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

  async appendClosedJoinMirrorCores(relayKey, relayCores = [], options = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');
    const metadata = options?.metadata && typeof options.metadata === 'object' ? options.metadata : null;
    const publicIdentifier = typeof options?.publicIdentifier === 'string'
      ? options.publicIdentifier
      : null;
    const relayUrl = typeof options?.relayUrl === 'string'
      ? options.relayUrl
      : null;
    const cores = Array.isArray(relayCores) ? relayCores : [];
    const payload = {
      relayKey,
      relayCores: cores,
      publicIdentifier: publicIdentifier || undefined,
      relayUrl: relayUrl || undefined,
      metadata: metadata || undefined,
      closedJoin: true,
      updatedAt: options.updatedAt || Date.now(),
      reason: options.reason || undefined
    };
    const body = await this.#signedPayload(payload);
    const path = `/api/relays/${encodeURIComponent(relayKey)}/closed-join/append-cores`;
    const corePreview = cores.slice(0, 3).map((entry) => {
      if (entry && typeof entry === 'object') {
        return {
          key: entry.key ? String(entry.key).slice(0, 16) : null,
          role: entry.role || null
        };
      }
      return {
        key: entry ? String(entry).slice(0, 16) : null,
        role: null
      };
    });
    this.logger?.info?.('[PublicGateway] Closed join core append request', {
      relayKey,
      cores: cores.length,
      publicIdentifier: publicIdentifier || null,
      corePreview
    });
    const response = await this.#postJson(path, body);
    this.logger?.info?.('[PublicGateway] Closed join core append response', {
      relayKey,
      added: response?.added ?? null,
      ignored: response?.ignored ?? null,
      rejected: response?.rejected ?? null,
      total: response?.total ?? null
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
      headers: { 'content-type': 'application/json' },
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
    if (!this.sharedSecret) throw new Error('Shared secret not configured');
    const signature = createSignature(payload, this.sharedSecret);
    return { payload, signature };
  }
}

export default PublicGatewayRegistrar;
