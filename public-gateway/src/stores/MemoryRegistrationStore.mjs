const CJTRACE_TAG = '[CJTRACE]';

class MemoryRegistrationStore {
  constructor(options = 300) {
    const resolved = typeof options === 'object' && options !== null
      ? options
      : { ttlSeconds: options };
    this.logger = resolved?.logger || null;
    this.ttlSeconds = Number.isFinite(resolved.ttlSeconds) ? resolved.ttlSeconds : 300;
    this.mirrorTtlSeconds = Number.isFinite(resolved.mirrorTtlSeconds) ? resolved.mirrorTtlSeconds : null;
    this.openJoinPoolTtlSeconds = Number.isFinite(resolved.openJoinPoolTtlSeconds)
      ? resolved.openJoinPoolTtlSeconds
      : null;
    this.items = new Map();
    this.tokenMetadata = new Map();
    this.openJoinPools = new Map();
    this.mirrorMetadata = new Map();
    this.closedJoinCoreRefs = new Map();
    this.relayAliases = new Map();
    this.relayAliasIndex = new Map();
    this.openJoinAliases = new Map();
    this.openJoinAliasIndex = new Map();
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
    this.clearOpenJoinAliases(relayKey);
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
        this.clearOpenJoinAliases(key);
        continue;
      }
      const entries = Array.isArray(pool?.entries) ? pool.entries : [];
      const nextEntries = entries.filter((entry) => !entry?.expiresAt || entry.expiresAt > now);
      if (nextEntries.length) {
        this.openJoinPools.set(key, { ...pool, entries: nextEntries });
      } else {
        this.openJoinPools.delete(key);
        this.clearOpenJoinAliases(key);
      }
    }

    for (const [key, record] of this.mirrorMetadata.entries()) {
      if (record?.expiresAt && record.expiresAt <= now) {
        this.mirrorMetadata.delete(key);
      }
    }

    for (const [key, record] of this.closedJoinCoreRefs.entries()) {
      if (record?.expiresAt && record.expiresAt <= now) {
        this.closedJoinCoreRefs.delete(key);
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

    for (const [alias, record] of this.openJoinAliases.entries()) {
      if (!record?.expiresAt || record.expiresAt > now) continue;
      this.openJoinAliases.delete(alias);
      const relayKey = record?.relayKey;
      if (!relayKey) continue;
      const aliasSet = this.openJoinAliasIndex.get(relayKey);
      if (aliasSet) {
        aliasSet.delete(alias);
        if (aliasSet.size === 0) {
          this.openJoinAliasIndex.delete(relayKey);
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
      publicIdentifier: typeof pool.publicIdentifier === 'string' ? pool.publicIdentifier : null,
      relayUrl: typeof pool.relayUrl === 'string' ? pool.relayUrl : null,
      relayCores: Array.isArray(pool.relayCores) ? pool.relayCores : [],
      metadata: pool.metadata && typeof pool.metadata === 'object' ? pool.metadata : null,
      aliases: Array.isArray(pool.aliases) ? pool.aliases : [],
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
      this.clearOpenJoinAliases(relayKey);
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
      this.clearOpenJoinAliases(relayKey);
    }
    return lease;
  }

  async clearOpenJoinPool(relayKey) {
    this.openJoinPools.delete(relayKey);
    this.clearOpenJoinAliases(relayKey);
  }

  async storeOpenJoinAliases(relayKey, aliases = []) {
    if (!relayKey) return;
    const ttlSeconds = Number.isFinite(this.openJoinPoolTtlSeconds)
      ? this.openJoinPoolTtlSeconds
      : this.ttlSeconds;
    const expiresAt = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Date.now() + ttlSeconds * 1000
      : null;
    const aliasList = Array.isArray(aliases) ? aliases : [];
    const unique = new Set();
    for (const rawAlias of aliasList) {
      const alias = typeof rawAlias === 'string' ? rawAlias.trim() : null;
      if (!alias || unique.has(alias)) continue;
      unique.add(alias);
      this.openJoinAliases.set(alias, { relayKey, expiresAt });
      const aliasSet = this.openJoinAliasIndex.get(relayKey) || new Set();
      aliasSet.add(alias);
      this.openJoinAliasIndex.set(relayKey, aliasSet);
    }
  }

  async resolveOpenJoinAlias(identifier) {
    if (!identifier) return null;
    const alias = typeof identifier === 'string' ? identifier.trim() : null;
    if (!alias) return null;
    const record = this.openJoinAliases.get(alias);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.openJoinAliases.delete(alias);
      const aliasSet = this.openJoinAliasIndex.get(record.relayKey);
      if (aliasSet) {
        aliasSet.delete(alias);
        if (aliasSet.size === 0) {
          this.openJoinAliasIndex.delete(record.relayKey);
        }
      }
      return null;
    }
    return record.relayKey || null;
  }

  clearOpenJoinAliases(relayKey) {
    const aliasSet = this.openJoinAliasIndex.get(relayKey);
    if (!aliasSet) return;
    for (const alias of aliasSet) {
      this.openJoinAliases.delete(alias);
    }
    this.openJoinAliasIndex.delete(relayKey);
  }

  async storeMirrorMetadata(relayKey, payload = {}) {
    if (!relayKey) return;
    const isClosedJoin = payload?.closedJoin === true || payload?.mirrorSource === 'closed-join';
    const ttlSeconds = isClosedJoin
      ? null
      : (Number.isFinite(this.mirrorTtlSeconds) ? this.mirrorTtlSeconds : this.ttlSeconds);
    const coreCount = Array.isArray(payload?.cores)
      ? payload.cores.length
      : (Array.isArray(payload?.relayCores) ? payload.relayCores.length : 0);
    const record = {
      payload,
      storedAt: Date.now(),
      expiresAt: Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null
    };
    this.mirrorMetadata.set(relayKey, record);
    this.logger?.info?.(`${CJTRACE_TAG} mirror metadata stored`, {
      relayKey,
      closedJoin: isClosedJoin,
      ttlSeconds,
      coreCount,
      mirrorSource: payload?.mirrorSource || null,
      updatedAt: payload?.updatedAt ?? null
    });
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

  async storeClosedJoinCoreRefs(relayKey, payload = {}) {
    if (!relayKey) return;
    const cores = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.cores) ? payload.cores : []);
    if (!cores.length) return;
    const record = {
      payload: Array.isArray(payload) ? { cores, updatedAt: Date.now() } : { ...payload, cores },
      storedAt: Date.now(),
      expiresAt: null
    };
    this.closedJoinCoreRefs.set(relayKey, record);
    this.logger?.info?.(`${CJTRACE_TAG} closed join cores stored`, {
      relayKey,
      coreCount: cores.length,
      updatedAt: record.payload?.updatedAt ?? null
    });
  }

  async getClosedJoinCoreRefs(relayKey) {
    const record = this.closedJoinCoreRefs.get(relayKey);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.closedJoinCoreRefs.delete(relayKey);
      return null;
    }
    return record.payload || null;
  }

  async clearClosedJoinCoreRefs(relayKey) {
    this.closedJoinCoreRefs.delete(relayKey);
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
