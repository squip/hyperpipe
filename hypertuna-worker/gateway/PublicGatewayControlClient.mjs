import { URL } from 'node:url';

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

class PublicGatewayControlClient {
  constructor({
    baseUrl,
    authClient,
    logger,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = normalizeOrigin(baseUrl);
    this.authClient = authClient || null;
    this.logger = logger || console;
    this.fetch = fetchImpl;
    this.enabled = Boolean(this.baseUrl && this.authClient && typeof this.fetch === 'function');
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeOrigin(baseUrl);
    this.authClient?.setBaseUrl?.(this.baseUrl);
    this.enabled = Boolean(this.baseUrl && this.authClient && typeof this.fetch === 'function');
  }

  isEnabled() {
    return this.enabled && this.authClient?.isEnabled?.();
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

    this.logger?.info?.('[PublicGatewayControl] Relay registration request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });

    const body = {
      relayKey,
      nonce: payload?.nonce || null,
      issuedAt: payload?.issuedAt || Date.now(),
      ...payload
    };

    try {
      const data = await this.#postJson('/api/relays', body, {
        scope: 'gateway:relay-register',
        relayKey
      });
      this.logger?.info?.('[PublicGatewayControl] Relay registered', { relayKey });
      return { success: true, ...data };
    } catch (error) {
      this.logger?.warn?.('Public gateway registration failed', {
        relayKey,
        error: error?.message || error
      });
      if (Number.isFinite(error?.statusCode)) {
        return { success: false, status: error.statusCode, error: error.message };
      }
      return { success: false, error: error?.message || String(error) };
    }
  }

  async unregisterRelay(relayKey) {
    if (!this.isEnabled()) return false;
    if (!relayKey) return false;
    try {
      await this.#request('DELETE', `/api/relays/${encodeURIComponent(relayKey)}`, null, {
        scope: 'gateway:relay-register',
        relayKey
      });
      this.logger?.info?.('Relay unregistered from public gateway', { relayKey });
      return true;
    } catch (error) {
      this.logger?.warn?.('Public gateway unregister failed', {
        relayKey,
        error: error?.message || error
      });
      return false;
    }
  }

  async issueGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayControl] Relay token issue request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    return this.#postJson('/api/relay-tokens/issue', {
      relayKey,
      ...payload
    }, {
      scope: 'gateway:relay-token',
      relayKey
    });
  }

  async refreshGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayControl] Relay token refresh request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    return this.#postJson('/api/relay-tokens/refresh', {
      relayKey,
      ...payload
    }, {
      scope: 'gateway:relay-token',
      relayKey
    });
  }

  async revokeGatewayToken(relayKey, payload = {}) {
    this.logger?.info?.('[PublicGatewayControl] Relay token revoke request', {
      relayKey,
      relayKeyType: this.#classifyRelayKey(relayKey)
    });
    return this.#postJson('/api/relay-tokens/revoke', {
      relayKey,
      ...payload
    }, {
      scope: 'gateway:relay-token',
      relayKey
    });
  }

  async updateOpenJoinPool(relayKey, entries = [], options = {}) {
    if (!this.isEnabled()) return { success: false };
    if (!relayKey) throw new Error('relayKey is required');

    const metadata = options?.metadata && typeof options.metadata === 'object' ? options.metadata : null;
    const relayCores = Array.isArray(options?.relayCores) ? options.relayCores : null;
    const aliases = Array.isArray(options?.aliases) ? options.aliases : null;
    const publicIdentifier = typeof options?.publicIdentifier === 'string' ? options.publicIdentifier : null;
    const relayUrl = typeof options?.relayUrl === 'string' ? options.relayUrl : null;

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

    const path = `/api/relays/${encodeURIComponent(relayKey)}/open-join/pool`;
    return this.#postJson(path, payload, {
      scope: 'gateway:open-join-pool',
      relayKey
    });
  }

  async #postJson(path, body, auth = {}) {
    if (!this.isEnabled()) {
      throw new Error('Public gateway control client not configured');
    }
    const response = await this.#request('POST', path, body, auth);
    return this.#parseJson(response);
  }

  async #request(method, path, body, { scope, relayKey = null } = {}) {
    if (!this.isEnabled()) {
      throw new Error('Public gateway control client not configured');
    }

    const attempt = async (forceRefresh = false) => {
      const token = await this.authClient.issueBearerToken({
        scope,
        relayKey,
        forceRefresh
      });
      const url = new URL(path, this.baseUrl).toString();
      return this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body != null ? { 'content-type': 'application/json' } : {})
        },
        body: body != null ? JSON.stringify(body) : undefined
      });
    };

    let response = await attempt(false);
    if (response.status === 401) {
      this.authClient.invalidateToken({ scope, relayKey });
      response = await attempt(true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(text || `Gateway responded with status ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }

    return response;
  }

  async #parseJson(response) {
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to parse gateway response: ${error.message}`);
    }
  }
}

export default PublicGatewayControlClient;
