import WebSocket from 'ws';

const PROFILE_EVENT_KIND = 0;
const DEFAULT_QUERY_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_TTL_SEC = 1800;
const DEFAULT_SEARCH_LIMIT = 12;
const MAX_SEARCH_LIMIT = 50;
const MAX_RESOLVE_KEYS = 200;
const MAX_RELAY_COUNT = 8;

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CHARKEY = Object.fromEntries(Array.from(BECH32_CHARSET).map((char, index) => [char, index]));
const BECH32_GENERATOR = [
  0x3b6a57b2,
  0x26508e6d,
  0x1ea119fa,
  0x3d4233dd,
  0x2a1462b3
];

function shortPubkey(pubkey) {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) return null;
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeRelayUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return null;
  }
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function extractDisplayName(metadata = {}, pubkey) {
  const displayName = normalizeText(metadata?.display_name) || normalizeText(metadata?.name);
  if (displayName) return displayName;
  const nip05 = normalizeText(metadata?.nip05);
  if (nip05 && nip05.includes('@')) {
    const local = nip05.split('@')[0]?.trim();
    if (local) return local;
  }
  return shortPubkey(pubkey);
}

function normalizeProfileSummary({ pubkey, metadata = {}, createdAt = null, source = 'relay' } = {}) {
  const normalizedPubkey = normalizePubkey(pubkey);
  if (!normalizedPubkey) return null;

  const name = normalizeText(metadata?.name);
  const displayName = normalizeText(metadata?.display_name);
  const nip05 = normalizeText(metadata?.nip05);
  const picture = normalizeText(metadata?.picture);
  const about = normalizeText(metadata?.about);

  return {
    pubkey: normalizedPubkey,
    displayName: extractDisplayName(metadata, normalizedPubkey),
    name,
    nip05,
    picture,
    about,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.trunc(createdAt) : null,
    source: source === 'cache' ? 'cache' : 'relay'
  };
}

function normalizeCachedSummary(profile = {}) {
  const normalizedPubkey = normalizePubkey(profile?.pubkey);
  if (!normalizedPubkey) return null;
  const name = normalizeText(profile?.name);
  const displayName = normalizeText(profile?.displayName);
  const nip05 = normalizeText(profile?.nip05);
  const picture = normalizeText(profile?.picture);
  const about = normalizeText(profile?.about);

  return {
    pubkey: normalizedPubkey,
    displayName: displayName || name || (nip05 && nip05.includes('@') ? nip05.split('@')[0] : null) || shortPubkey(normalizedPubkey),
    name,
    nip05,
    picture,
    about,
    createdAt: Number.isFinite(profile?.createdAt) && profile.createdAt > 0 ? Math.trunc(profile.createdAt) : null,
    source: 'relay'
  };
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (let p = 0; p < data.length; p += 1) {
    const value = data[p];
    if (value < 0 || (value >> fromBits) !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

function bech32Polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < BECH32_GENERATOR.length; i += 1) {
      if ((top >> i) & 1) {
        chk ^= BECH32_GENERATOR[i];
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const values = [];
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) >> 5);
  }
  values.push(0);
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) & 31);
  }
  return values;
}

function bech32VerifyChecksum(hrp, data) {
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

function decodeNpubHex(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith('npub1')) return null;
  const sep = normalized.lastIndexOf('1');
  if (sep <= 0 || sep + 7 > normalized.length) return null;
  const hrp = normalized.slice(0, sep);
  const dataPart = normalized.slice(sep + 1);
  const data = [];
  for (let i = 0; i < dataPart.length; i += 1) {
    const char = dataPart[i];
    const mapped = BECH32_CHARKEY[char];
    if (!Number.isInteger(mapped)) return null;
    data.push(mapped);
  }
  if (!bech32VerifyChecksum(hrp, data)) return null;
  const payload = data.slice(0, -6);
  const decoded = convertBits(payload, 5, 8, false);
  if (!decoded || decoded.length !== 32) return null;
  return Buffer.from(decoded).toString('hex');
}

function computeProfileSearchScore(profile, query, { exactPubkey = null, exactNpub = null } = {}) {
  if (!profile || !query) return 0;
  const normalizedQuery = query.toLowerCase();
  const pubkey = String(profile.pubkey || '').toLowerCase();
  const displayName = String(profile.displayName || '').toLowerCase();
  const name = String(profile.name || '').toLowerCase();
  const nip05 = String(profile.nip05 || '').toLowerCase();

  let score = 0;

  if (exactPubkey && pubkey === exactPubkey) score += 10000;
  if (exactNpub && exactPubkey && pubkey === exactPubkey) score += 9000;

  if (displayName === normalizedQuery) score += 1400;
  if (name === normalizedQuery) score += 1200;
  if (nip05 === normalizedQuery) score += 1100;

  if (displayName.startsWith(normalizedQuery)) score += 900;
  if (name.startsWith(normalizedQuery)) score += 800;
  if (nip05.startsWith(normalizedQuery)) score += 760;
  if (pubkey.startsWith(normalizedQuery)) score += 700;

  if (displayName.includes(normalizedQuery)) score += 520;
  if (name.includes(normalizedQuery)) score += 480;
  if (nip05.includes(normalizedQuery)) score += 440;
  if (pubkey.includes(normalizedQuery)) score += 360;

  if (Number.isFinite(profile.createdAt) && profile.createdAt > 0) {
    score += Math.min(Math.floor(profile.createdAt / 1000000), 300);
  }

  return score;
}

class GatewayNostrProfileService {
  constructor({
    logger = console,
    relayUrls = [],
    getRelayUrls = null,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    cacheTtlSec = DEFAULT_CACHE_TTL_SEC,
    defaultSearchLimit = DEFAULT_SEARCH_LIMIT,
    maxSearchLimit = MAX_SEARCH_LIMIT,
    maxResolveKeys = MAX_RESOLVE_KEYS
  } = {}) {
    this.logger = logger;
    this.relayUrls = Array.isArray(relayUrls) ? relayUrls : [];
    this.getRelayUrls = typeof getRelayUrls === 'function' ? getRelayUrls : null;
    this.queryTimeoutMs = Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0
      ? Math.trunc(queryTimeoutMs)
      : DEFAULT_QUERY_TIMEOUT_MS;
    this.cacheTtlMs = Number.isFinite(cacheTtlSec) && cacheTtlSec > 0
      ? Math.trunc(cacheTtlSec * 1000)
      : DEFAULT_CACHE_TTL_SEC * 1000;
    this.defaultSearchLimit = Number.isFinite(defaultSearchLimit) && defaultSearchLimit > 0
      ? Math.min(Math.trunc(defaultSearchLimit), MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
    this.maxSearchLimit = Number.isFinite(maxSearchLimit) && maxSearchLimit > 0
      ? Math.min(Math.trunc(maxSearchLimit), 200)
      : MAX_SEARCH_LIMIT;
    this.maxResolveKeys = Number.isFinite(maxResolveKeys) && maxResolveKeys > 0
      ? Math.min(Math.trunc(maxResolveKeys), 2000)
      : MAX_RESOLVE_KEYS;
    this.cache = new Map();
  }

  #getRelayUrls() {
    const raw = this.getRelayUrls ? this.getRelayUrls() : this.relayUrls;
    const normalized = Array.from(
      new Set(
        (Array.isArray(raw) ? raw : [])
          .map((entry) => normalizeRelayUrl(entry))
          .filter((entry) => !!entry)
      )
    );
    return normalized.slice(0, MAX_RELAY_COUNT);
  }

  #purgeExpiredCacheEntries() {
    if (!this.cache.size) return;
    const now = Date.now();
    for (const [pubkey, entry] of this.cache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.cache.delete(pubkey);
      }
    }
  }

  #readCachedProfile(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) return null;
    const cached = this.cache.get(normalized);
    if (!cached) return null;
    if (!cached.expiresAt || cached.expiresAt <= Date.now()) {
      this.cache.delete(normalized);
      return null;
    }
    return {
      ...cached.profile,
      source: 'cache'
    };
  }

  #writeProfileToCache(profile) {
    const normalized = profile?.metadata && typeof profile.metadata === 'object'
      ? normalizeProfileSummary(profile)
      : normalizeCachedSummary(profile);
    if (!normalized) return;
    this.cache.set(normalized.pubkey, {
      profile: {
        ...normalized,
        source: 'relay'
      },
      fetchedAt: Date.now(),
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  #listCachedProfiles() {
    this.#purgeExpiredCacheEntries();
    return Array.from(this.cache.values()).map((entry) => ({
      ...entry.profile,
      source: 'cache'
    }));
  }

  async resolvePubkeys(pubkeys = []) {
    const normalizedPubkeys = Array.from(
      new Set(
        (Array.isArray(pubkeys) ? pubkeys : [])
          .map((entry) => normalizePubkey(entry))
          .filter((entry) => !!entry)
      )
    ).slice(0, this.maxResolveKeys);

    const profiles = [];
    const missing = [];
    const unresolved = [];
    let cacheCount = 0;
    let relayCount = 0;

    for (const pubkey of normalizedPubkeys) {
      const cached = this.#readCachedProfile(pubkey);
      if (cached) {
        profiles.push(cached);
        cacheCount += 1;
      } else {
        unresolved.push(pubkey);
      }
    }

    if (unresolved.length) {
      const events = await this.#fetchProfileEventsFromRelays([
        {
          kinds: [PROFILE_EVENT_KIND],
          authors: unresolved,
          limit: unresolved.length
        }
      ]);
      const parsedByPubkey = new Map();
      for (const event of events) {
        const parsed = this.#parseProfileEvent(event, 'relay');
        if (!parsed) continue;
        const existing = parsedByPubkey.get(parsed.pubkey);
        const existingCreatedAt = Number(existing?.createdAt || 0);
        const nextCreatedAt = Number(parsed.createdAt || 0);
        if (!existing || nextCreatedAt >= existingCreatedAt) {
          parsedByPubkey.set(parsed.pubkey, parsed);
        }
      }

      for (const pubkey of unresolved) {
        const resolved = parsedByPubkey.get(pubkey);
        if (resolved) {
          this.#writeProfileToCache(resolved);
          profiles.push({ ...resolved, source: 'relay' });
          relayCount += 1;
        } else {
          missing.push(pubkey);
        }
      }
    }

    const profileByPubkey = new Map(profiles.map((entry) => [entry.pubkey, entry]));
    const ordered = normalizedPubkeys
      .map((pubkey) => profileByPubkey.get(pubkey))
      .filter((entry) => !!entry);

    return {
      profiles: ordered,
      missing,
      sources: {
        cache: cacheCount,
        relays: relayCount
      }
    };
  }

  async searchProfiles(query, limit = this.defaultSearchLimit) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    if (!normalizedQuery) {
      return {
        profiles: [],
        sources: {
          cache: 0,
          relays: 0
        }
      };
    }

    const resolvedLimit = Number.isFinite(limit) && Number(limit) > 0
      ? Math.min(Math.trunc(Number(limit)), this.maxSearchLimit)
      : this.defaultSearchLimit;

    const exactHex = normalizePubkey(normalizedQuery) || decodeNpubHex(normalizedQuery);

    const byPubkey = new Map();
    const applyProfile = (profile) => {
      if (!profile?.pubkey) return;
      const existing = byPubkey.get(profile.pubkey);
      const existingCreatedAt = Number(existing?.createdAt || 0);
      const nextCreatedAt = Number(profile?.createdAt || 0);
      if (!existing || nextCreatedAt >= existingCreatedAt) {
        byPubkey.set(profile.pubkey, profile);
      }
    };

    const cachedProfiles = this.#listCachedProfiles();
    cachedProfiles.forEach(applyProfile);

    const filters = [];
    if (exactHex) {
      filters.push({
        kinds: [PROFILE_EVENT_KIND],
        authors: [exactHex],
        limit: 1
      });
    }

    const searchFetchLimit = Math.min(Math.max(resolvedLimit * 6, 60), 300);
    filters.push({
      kinds: [PROFILE_EVENT_KIND],
      limit: searchFetchLimit
    });

    const relayEvents = await this.#fetchProfileEventsFromRelays(filters);
    for (const event of relayEvents) {
      const parsed = this.#parseProfileEvent(event, 'relay');
      if (!parsed) continue;
      this.#writeProfileToCache(parsed);
      applyProfile(parsed);
    }

    const scored = Array.from(byPubkey.values())
      .map((profile) => ({
        profile,
        score: computeProfileSearchScore(profile, normalizedQuery, {
          exactPubkey: exactHex,
          exactNpub: normalizedQuery.startsWith('npub1') ? normalizedQuery : null
        })
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        const leftCreated = Number(left.profile?.createdAt || 0);
        const rightCreated = Number(right.profile?.createdAt || 0);
        if (leftCreated !== rightCreated) return rightCreated - leftCreated;
        return String(left.profile?.pubkey || '').localeCompare(String(right.profile?.pubkey || ''));
      })
      .slice(0, resolvedLimit)
      .map((entry) => entry.profile);

    const sourceStats = scored.reduce((acc, profile) => {
      if (profile?.source === 'cache') {
        acc.cache += 1;
      } else {
        acc.relays += 1;
      }
      return acc;
    }, { cache: 0, relays: 0 });

    return {
      profiles: scored,
      sources: sourceStats
    };
  }

  #parseProfileEvent(event, source = 'relay') {
    if (!event || typeof event !== 'object') return null;
    if (Number(event.kind) !== PROFILE_EVENT_KIND) return null;
    const pubkey = normalizePubkey(event.pubkey);
    if (!pubkey) return null;
    const metadata = safeJsonParse(String(event.content || ''));
    if (!metadata || typeof metadata !== 'object') return null;
    return normalizeProfileSummary({
      pubkey,
      metadata,
      createdAt: Number(event.created_at || 0),
      source
    });
  }

  async #fetchProfileEventsFromRelays(filters = []) {
    const relayUrls = this.#getRelayUrls();
    if (!relayUrls.length) {
      return [];
    }

    const normalizedFilters = (Array.isArray(filters) ? filters : [])
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({ ...entry }));

    if (!normalizedFilters.length) {
      return [];
    }

    const settled = await Promise.allSettled(
      relayUrls.map((relayUrl) => this.#fetchFromRelay(relayUrl, normalizedFilters))
    );

    const eventsByPubkey = new Map();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const event of result.value) {
        if (!event || Number(event.kind) !== PROFILE_EVENT_KIND) continue;
        const pubkey = normalizePubkey(event.pubkey);
        if (!pubkey) continue;
        const current = eventsByPubkey.get(pubkey);
        const currentCreatedAt = Number(current?.created_at || 0);
        const nextCreatedAt = Number(event?.created_at || 0);
        if (!current || nextCreatedAt >= currentCreatedAt) {
          eventsByPubkey.set(pubkey, event);
        }
      }
    }

    return Array.from(eventsByPubkey.values());
  }

  async #fetchFromRelay(relayUrl, filters) {
    const timeoutMs = this.queryTimeoutMs;

    return await new Promise((resolve) => {
      const events = [];
      const subscriptionId = `gw-admin-profiles-${Math.random().toString(36).slice(2, 10)}`;
      let settled = false;
      let timeoutHandle = null;
      const socket = new WebSocket(relayUrl);

      const settle = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        try {
          socket.close();
        } catch (_error) {
          // best effort
        }
        resolve(events);
      };

      timeoutHandle = setTimeout(() => {
        this.logger?.debug?.('[GatewayProfiles] Relay query timeout', { relayUrl, timeoutMs });
        settle();
      }, timeoutMs);

      socket.once('open', () => {
        try {
          socket.send(JSON.stringify(['REQ', subscriptionId, ...filters]));
        } catch (_error) {
          settle();
        }
      });

      socket.on('message', (buffer) => {
        let frame = null;
        try {
          frame = JSON.parse(String(buffer || ''));
        } catch (_error) {
          return;
        }
        if (!Array.isArray(frame) || frame.length < 2) return;

        if (frame[0] === 'EVENT' && frame[1] === subscriptionId && frame[2] && typeof frame[2] === 'object') {
          events.push(frame[2]);
          return;
        }

        if (frame[0] === 'EOSE' && frame[1] === subscriptionId) {
          try {
            socket.send(JSON.stringify(['CLOSE', subscriptionId]));
          } catch (_error) {
            // best effort
          }
          settle();
        }
      });

      socket.once('error', (error) => {
        this.logger?.debug?.('[GatewayProfiles] Relay query failed', {
          relayUrl,
          error: error?.message || error
        });
        settle();
      });

      socket.once('close', () => {
        settle();
      });
    });
  }
}

export {
  GatewayNostrProfileService,
  normalizeProfileSummary,
  normalizePubkey,
  decodeNpubHex
};

export default GatewayNostrProfileService;
