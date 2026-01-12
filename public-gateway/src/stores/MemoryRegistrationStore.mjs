class MemoryRegistrationStore {
  constructor(options = 300) {
    const resolved = typeof options === 'object' && options !== null
      ? options
      : { ttlSeconds: options };
    this.ttlSeconds = Number.isFinite(resolved.ttlSeconds) ? resolved.ttlSeconds : 300;
    this.mirrorTtlSeconds = Number.isFinite(resolved.mirrorTtlSeconds) ? resolved.mirrorTtlSeconds : null;
    this.openJoinPoolTtlSeconds = Number.isFinite(resolved.openJoinPoolTtlSeconds)
      ? resolved.openJoinPoolTtlSeconds
      : null;
    this.items = new Map();
    this.tokenMetadata = new Map();
    this.openJoinPools = new Map();
    this.mirrorMetadata = new Map();
    this.relayAliases = new Map();
    this.relayAliasIndex = new Map();
  }

  async upsertRelay(relayKey, payload) {
    const record = {
      payload,
      expiresAt: Date.now() + this.ttlSeconds * 1000
    };
    this.items.set(relayKey, record);
  }

  async getRelay(relayKey) {
    const record = this.items.get(relayKey);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.items.delete(relayKey);
      return null;
    }
    return record.payload;
  }

  async removeRelay(relayKey) {
    this.items.delete(relayKey);
    this.tokenMetadata.delete(relayKey);
    this.openJoinPools.delete(relayKey);
    this.removeRelayAliases(relayKey);
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, record] of this.items.entries()) {
      if (record.expiresAt < now) {
        this.items.delete(key);
      }
    }

    for (const [key, metadata] of this.tokenMetadata.entries()) {
      if (metadata?.expiresAt && metadata.expiresAt < now) {
        this.tokenMetadata.delete(key);
      }
    }

    for (const [key, pool] of this.openJoinPools.entries()) {
      if (pool?.expiresAt && pool.expiresAt <= now) {
        this.openJoinPools.delete(key);
        continue;
      }
      const entries = Array.isArray(pool?.entries) ? pool.entries : [];
      const nextEntries = entries.filter((entry) => !entry?.expiresAt || entry.expiresAt > now);
      if (nextEntries.length) {
        this.openJoinPools.set(key, { ...pool, entries: nextEntries });
      } else {
        this.openJoinPools.delete(key);
      }
    }

    for (const [key, record] of this.mirrorMetadata.entries()) {
      if (record?.expiresAt && record.expiresAt <= now) {
        this.mirrorMetadata.delete(key);
      }
    }

    for (const [alias, record] of this.relayAliases.entries()) {
      if (!record?.expiresAt || record.expiresAt > now) continue;
      this.relayAliases.delete(alias);
      const relayKey = record?.relayKey;
      if (!relayKey) continue;
      const aliasSet = this.relayAliasIndex.get(relayKey);
      if (aliasSet) {
        aliasSet.delete(alias);
        if (aliasSet.size === 0) {
          this.relayAliasIndex.delete(relayKey);
        }
      }
    }
  }

  async storeTokenMetadata(relayKey, metadata = {}) {
    const record = {
      ...metadata,
      recordedAt: Date.now()
    };
    this.tokenMetadata.set(relayKey, record);
  }

  async getTokenMetadata(relayKey) {
    const record = this.tokenMetadata.get(relayKey);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < Date.now()) {
      this.tokenMetadata.delete(relayKey);
      return null;
    }
    return record;
  }

  async clearTokenMetadata(relayKey) {
    this.tokenMetadata.delete(relayKey);
  }

  async storeOpenJoinPool(relayKey, pool = {}) {
    if (!relayKey) return;
    const now = Date.now();
    const poolTtlSeconds = Number.isFinite(this.openJoinPoolTtlSeconds)
      ? this.openJoinPoolTtlSeconds
      : this.ttlSeconds;
    const record = {
      entries: Array.isArray(pool.entries) ? pool.entries : [],
      updatedAt: pool.updatedAt || now,
      expiresAt: Number.isFinite(poolTtlSeconds) && poolTtlSeconds > 0
        ? now + poolTtlSeconds * 1000
        : null
    };
    this.openJoinPools.set(relayKey, record);
  }

  async getOpenJoinPool(relayKey) {
    const record = this.openJoinPools.get(relayKey);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.openJoinPools.delete(relayKey);
      return null;
    }
    return record;
  }

  async takeOpenJoinLease(relayKey) {
    const record = await this.getOpenJoinPool(relayKey);
    if (!record) return null;
    const now = Date.now();
    const entries = Array.isArray(record.entries) ? record.entries : [];
    const nextEntries = entries.filter((entry) => !entry?.expiresAt || entry.expiresAt > now);
    const lease = nextEntries.shift() || null;
    if (nextEntries.length) {
      this.openJoinPools.set(relayKey, { ...record, entries: nextEntries, updatedAt: record.updatedAt || now });
    } else {
      this.openJoinPools.delete(relayKey);
    }
    return lease;
  }

  async clearOpenJoinPool(relayKey) {
    this.openJoinPools.delete(relayKey);
  }

  async storeMirrorMetadata(relayKey, payload = {}) {
    if (!relayKey) return;
    const ttlSeconds = Number.isFinite(this.mirrorTtlSeconds) ? this.mirrorTtlSeconds : this.ttlSeconds;
    const record = {
      payload,
      storedAt: Date.now(),
      expiresAt: Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null
    };
    this.mirrorMetadata.set(relayKey, record);
  }

  async getMirrorMetadata(relayKey) {
    const record = this.mirrorMetadata.get(relayKey);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.mirrorMetadata.delete(relayKey);
      return null;
    }
    return record.payload || null;
  }

  async clearMirrorMetadata(relayKey) {
    this.mirrorMetadata.delete(relayKey);
  }

  async storeRelayAlias(identifier, relayKey) {
    if (!identifier || !relayKey) return;
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return;
    const record = {
      relayKey,
      expiresAt: Date.now() + this.ttlSeconds * 1000
    };
    this.relayAliases.set(alias, record);
    const existing = this.relayAliasIndex.get(relayKey) || new Set();
    existing.add(alias);
    this.relayAliasIndex.set(relayKey, existing);
  }

  async resolveRelayAlias(identifier) {
    if (!identifier) return null;
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return null;
    const record = this.relayAliases.get(alias);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.relayAliases.delete(alias);
      const aliasSet = this.relayAliasIndex.get(record.relayKey);
      if (aliasSet) {
        aliasSet.delete(alias);
        if (aliasSet.size === 0) {
          this.relayAliasIndex.delete(record.relayKey);
        }
      }
      return null;
    }
    return record.relayKey || null;
  }

  removeRelayAliases(relayKey) {
    const aliasSet = this.relayAliasIndex.get(relayKey);
    if (!aliasSet) return;
    for (const alias of aliasSet) {
      this.relayAliases.delete(alias);
    }
    this.relayAliasIndex.delete(relayKey);
  }
}

export default MemoryRegistrationStore;
