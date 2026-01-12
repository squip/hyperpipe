import { createClient } from 'redis';

class RedisRegistrationStore {
  constructor({
    url,
    ttlSeconds = 300,
    mirrorTtlSeconds = null,
    openJoinPoolTtlSeconds = null,
    prefix = 'gateway:registrations:',
    logger
  } = {}) {
    if (!url) throw new Error('Redis URL is required for RedisRegistrationStore');
    this.url = url;
    this.ttlSeconds = ttlSeconds;
    this.mirrorTtlSeconds = Number.isFinite(mirrorTtlSeconds) ? mirrorTtlSeconds : null;
    this.openJoinPoolTtlSeconds = Number.isFinite(openJoinPoolTtlSeconds) ? openJoinPoolTtlSeconds : null;
    this.prefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
    this.tokenPrefix = `${this.prefix}tokens:`;
    this.openJoinPrefix = `${this.prefix}open-join:`;
    this.mirrorPrefix = `${this.prefix}mirrors:`;
    this.aliasPrefix = `${this.prefix}aliases:`;
    this.logger = logger || console;
    this.client = createClient({ url: this.url });
    this.readyPromise = null;
    this.client.on('error', (err) => {
      this.logger?.error?.('Redis registration store error', { error: err?.message || err });
    });
  }

  async #ensureConnected() {
    if (this.client.isReady) return;
    if (!this.readyPromise) {
      this.readyPromise = this.client.connect().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async connect() {
    await this.#ensureConnected();
  }

  #key(relayKey) {
    return `${this.prefix}${relayKey}`;
  }

  #tokenKey(relayKey) {
    return `${this.tokenPrefix}${relayKey}`;
  }

  #openJoinKey(relayKey) {
    return `${this.openJoinPrefix}${relayKey}`;
  }

  #mirrorKey(relayKey) {
    return `${this.mirrorPrefix}${relayKey}`;
  }

  #aliasKey(identifier) {
    return `${this.aliasPrefix}${identifier}`;
  }

  async upsertRelay(relayKey, payload) {
    await this.#ensureConnected();
    const data = JSON.stringify({ ...payload, relayKey, updatedAt: Date.now() });
    const key = this.#key(relayKey);
    await this.client.set(key, data, { EX: this.ttlSeconds });
  }

  async getRelay(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#key(relayKey));
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis registration payload', { relayKey, error: error.message });
      return null;
    }
  }

  async removeRelay(relayKey) {
    await this.#ensureConnected();
    await this.client.del(this.#key(relayKey));
    await this.client.del(this.#tokenKey(relayKey));
    await this.client.del(this.#openJoinKey(relayKey));
  }

  pruneExpired() {
    // Redis handles TTL expiry automatically.
    return undefined;
  }

  async disconnect() {
    if (!this.client.isOpen) return;
    await this.client.disconnect();
  }

  async storeTokenMetadata(relayKey, metadata = {}) {
    await this.#ensureConnected();
    const payload = JSON.stringify({
      ...metadata,
      relayKey,
      recordedAt: Date.now()
    });
    await this.client.set(this.#tokenKey(relayKey), payload, { EX: this.ttlSeconds });
  }

  async getTokenMetadata(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#tokenKey(relayKey));
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis token metadata', { relayKey, error: error.message });
      return null;
    }
  }

  async clearTokenMetadata(relayKey) {
    await this.#ensureConnected();
    await this.client.del(this.#tokenKey(relayKey));
  }

  async storeOpenJoinPool(relayKey, pool = {}) {
    if (!relayKey) return;
    await this.#ensureConnected();
    const payload = JSON.stringify({
      entries: Array.isArray(pool.entries) ? pool.entries : [],
      updatedAt: pool.updatedAt || Date.now()
    });
    const ttlSeconds = Number.isFinite(this.openJoinPoolTtlSeconds)
      ? this.openJoinPoolTtlSeconds
      : this.ttlSeconds;
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await this.client.set(this.#openJoinKey(relayKey), payload, { EX: ttlSeconds });
    } else {
      await this.client.set(this.#openJoinKey(relayKey), payload);
    }
  }

  async getOpenJoinPool(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#openJoinKey(relayKey));
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis open-join pool payload', { relayKey, error: error.message });
      return null;
    }
  }

  async takeOpenJoinLease(relayKey) {
    await this.#ensureConnected();
    const pool = await this.getOpenJoinPool(relayKey);
    if (!pool) return null;
    const now = Date.now();
    const entries = Array.isArray(pool.entries) ? pool.entries : [];
    const nextEntries = entries.filter((entry) => !entry?.expiresAt || entry.expiresAt > now);
    const lease = nextEntries.shift() || null;
    if (nextEntries.length) {
      await this.storeOpenJoinPool(relayKey, { entries: nextEntries, updatedAt: pool.updatedAt || now });
    } else {
      await this.clearOpenJoinPool(relayKey);
    }
    return lease;
  }

  async clearOpenJoinPool(relayKey) {
    await this.#ensureConnected();
    await this.client.del(this.#openJoinKey(relayKey));
  }

  async storeMirrorMetadata(relayKey, payload = {}) {
    if (!relayKey) return;
    await this.#ensureConnected();
    const record = JSON.stringify({
      payload,
      storedAt: Date.now()
    });
    const ttlSeconds = Number.isFinite(this.mirrorTtlSeconds)
      ? this.mirrorTtlSeconds
      : this.ttlSeconds;
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await this.client.set(this.#mirrorKey(relayKey), record, { EX: ttlSeconds });
    } else {
      await this.client.set(this.#mirrorKey(relayKey), record);
    }
  }

  async getMirrorMetadata(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#mirrorKey(relayKey));
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed?.payload || null;
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis mirror metadata payload', { relayKey, error: error.message });
      return null;
    }
  }

  async clearMirrorMetadata(relayKey) {
    await this.#ensureConnected();
    await this.client.del(this.#mirrorKey(relayKey));
  }

  async storeRelayAlias(identifier, relayKey) {
    if (!identifier || !relayKey) return;
    await this.#ensureConnected();
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return;
    await this.client.set(this.#aliasKey(alias), relayKey, { EX: this.ttlSeconds });
  }

  async resolveRelayAlias(identifier) {
    if (!identifier) return null;
    await this.#ensureConnected();
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return null;
    const value = await this.client.get(this.#aliasKey(alias));
    return value || null;
  }

  async removeRelayAlias(identifier) {
    if (!identifier) return;
    await this.#ensureConnected();
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return;
    await this.client.del(this.#aliasKey(alias));
  }
}

export default RedisRegistrationStore;
