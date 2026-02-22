import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const LEGACY_PUBLIC_GATEWAY_PATH = 'public-gateway/hyperbee';

const DEFAULT_BLIND_PEER_MAX_BYTES = 25 * 1024 ** 3;

const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: Number(process.env.PORT) || 4430,
  tls: {
    enabled: process.env.GATEWAY_TLS_ENABLED === 'true',
    keyPath: process.env.GATEWAY_TLS_KEY || null,
    certPath: process.env.GATEWAY_TLS_CERT || null
  },
  publicBaseUrl: process.env.GATEWAY_PUBLIC_URL || 'https://hypertuna.com',
  metrics: {
    enabled: process.env.GATEWAY_METRICS_ENABLED !== 'false',
    path: process.env.GATEWAY_METRICS_PATH || '/metrics'
  },
  registration: {
    redisUrl: process.env.GATEWAY_REGISTRATION_REDIS || null,
    redisPrefix: process.env.GATEWAY_REGISTRATION_REDIS_PREFIX || 'gateway:registrations:',
    cacheTtlSeconds: Number(process.env.GATEWAY_REGISTRATION_TTL || 1800),
    mirrorTtlSeconds: Number(process.env.GATEWAY_MIRROR_METADATA_TTL || 86400),
    openJoinPoolTtlSeconds: Number(process.env.GATEWAY_OPEN_JOIN_POOL_TTL || 21600),
    relayGcAfterMs: Number(process.env.GATEWAY_RELAY_GC_AFTER_MS || (90 * 24 * 60 * 60 * 1000)),
    defaultTokenTtl: Number(process.env.GATEWAY_DEFAULT_TOKEN_TTL || 3600),
    tokenRefreshWindowSeconds: Number(process.env.GATEWAY_TOKEN_REFRESH_WINDOW || 300)
  },
  rateLimit: {
    enabled: process.env.GATEWAY_RATELIMIT_ENABLED === 'true',
    windowSeconds: Number(process.env.GATEWAY_RATELIMIT_WINDOW || 60),
    maxRequests: Number(process.env.GATEWAY_RATELIMIT_MAX || 120)
  },
  discovery: {
    enabled: process.env.GATEWAY_DISCOVERY_ENABLED === 'true',
    openAccess: process.env.GATEWAY_DISCOVERY_OPEN_ACCESS !== 'false',
    displayName: process.env.GATEWAY_DISCOVERY_DISPLAY_NAME || '',
    region: process.env.GATEWAY_DISCOVERY_REGION || '',
    keySeed: process.env.GATEWAY_DISCOVERY_KEY_SEED || null,
    ttlSeconds: Number(process.env.GATEWAY_DISCOVERY_TTL || 60),
    refreshIntervalMs: Number(process.env.GATEWAY_DISCOVERY_REFRESH_MS || 30000),
    authMode: process.env.GATEWAY_DISCOVERY_AUTH_MODE || 'nostr-challenge-v1',
    protocolVersion: Number(process.env.GATEWAY_DISCOVERY_PROTOCOL_VERSION || 2)
  },
  relay: {
    storageDir: process.env.GATEWAY_RELAY_STORAGE || null,
    datasetNamespace: process.env.GATEWAY_RELAY_NAMESPACE || 'public-gateway-relay',
    adminPublicKey: process.env.GATEWAY_RELAY_ADMIN_PUBLIC_KEY || null,
    adminSecretKey: process.env.GATEWAY_RELAY_ADMIN_SECRET_KEY || null,
    statsIntervalMs: Number(process.env.GATEWAY_RELAY_STATS_INTERVAL_MS || 15000),
    replicationTopic: process.env.GATEWAY_RELAY_REPLICATION_TOPIC || null,
    canonicalPath: process.env.GATEWAY_RELAY_CANONICAL_PATH || 'relay',
    aliasPaths: parseRelayAliasPaths(process.env.GATEWAY_RELAY_ALIAS_PATHS)
  },
  features: {
    hyperbeeRelayEnabled: process.env.GATEWAY_FEATURE_HYPERBEE_RELAY === 'true',
    dispatcherEnabled: process.env.GATEWAY_FEATURE_RELAY_DISPATCHER === 'true',
    tokenEnforcementEnabled: process.env.GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT === 'true'
  },
  dispatcher: {
    maxConcurrentJobsPerPeer: Number(process.env.GATEWAY_DISPATCHER_MAX_CONCURRENT || 3),
    inFlightWeight: Number(process.env.GATEWAY_DISPATCHER_INFLIGHT_WEIGHT || 25),
    latencyWeight: Number(process.env.GATEWAY_DISPATCHER_LATENCY_WEIGHT || 1),
    failureWeight: Number(process.env.GATEWAY_DISPATCHER_FAILURE_WEIGHT || 500),
    reassignOnLagBlocks: Number(process.env.GATEWAY_DISPATCHER_REASSIGN_LAG || 500),
    circuitBreakerThreshold: Number(process.env.GATEWAY_DISPATCHER_CB_THRESHOLD || 5),
    circuitBreakerDurationMs: Number(process.env.GATEWAY_DISPATCHER_CB_TIMEOUT_MS || 60000)
  },
  blindPeer: {
    enabled: process.env.GATEWAY_BLINDPEER_ENABLED === 'true',
    storageDir: process.env.GATEWAY_BLINDPEER_STORAGE || null,
    maxBytes: Number(process.env.GATEWAY_BLINDPEER_MAX_BYTES) || DEFAULT_BLIND_PEER_MAX_BYTES,
    gcIntervalMs: Number(process.env.GATEWAY_BLINDPEER_GC_INTERVAL_MS) || 300000,
    dedupeBatchSize: Number(process.env.GATEWAY_BLINDPEER_DEDUPE_BATCH) || 100,
    staleCoreTtlMs: Number(process.env.GATEWAY_BLINDPEER_STALE_TTL_MS) || (7 * 24 * 60 * 60 * 1000),
    trustedPeersPersistPath: process.env.GATEWAY_BLINDPEER_TRUSTED_PATH || null
  },
  openJoin: {
    enabled: process.env.GATEWAY_OPEN_JOIN_ENABLED !== 'false',
    poolEntryTtlMs: Number(process.env.GATEWAY_OPEN_JOIN_POOL_TTL_MS) || (30 * 24 * 60 * 60 * 1000),
    challengeTtlMs: Number(process.env.GATEWAY_OPEN_JOIN_CHALLENGE_TTL_MS) || (2 * 60 * 1000),
    authWindowSeconds: Number(process.env.GATEWAY_OPEN_JOIN_AUTH_WINDOW || 300),
    maxPoolSize: Number(process.env.GATEWAY_OPEN_JOIN_MAX_POOL || 100)
  },
  gateway: {
    enableMulti: process.env.GATEWAY_ENABLE_MULTI === 'true',
    operatorNsecHex: process.env.GATEWAY_OPERATOR_NSEC_HEX || null,
    operatorPubkey: process.env.GATEWAY_OPERATOR_PUBKEY_HEX || null,
    policy: process.env.GATEWAY_POLICY || 'OPEN',
    allowList: parseCsvValues(process.env.GATEWAY_ALLOW_LIST),
    banList: parseCsvValues(process.env.GATEWAY_BAN_LIST),
    discoveryRelays: parseCsvValues(process.env.GATEWAY_DISCOVERY_RELAYS),
    inviteOnly: process.env.GATEWAY_INVITE_ONLY === 'true',
    authJwtSecret: process.env.GATEWAY_AUTH_JWT_SECRET || null,
    relayTokenJwtSecret: process.env.GATEWAY_RELAY_TOKEN_JWT_SECRET || process.env.GATEWAY_AUTH_JWT_SECRET || null,
    authTokenTtlSec: Number(process.env.GATEWAY_AUTH_TOKEN_TTL_SEC || 3600),
    authChallengeTtlMs: Number(process.env.GATEWAY_AUTH_CHALLENGE_TTL_MS || (2 * 60 * 1000)),
    authWindowSec: Number(process.env.GATEWAY_AUTH_WINDOW_SEC || 300),
    adminUiEnabled: process.env.GATEWAY_ADMIN_UI_ENABLED !== 'false',
    adminUiPath: process.env.GATEWAY_ADMIN_UI_PATH || '/admin',
    adminSessionCookieName: process.env.GATEWAY_ADMIN_SESSION_COOKIE_NAME || 'ht_gateway_admin',
    adminSessionTtlSec: Number(process.env.GATEWAY_ADMIN_SESSION_TTL_SEC || 3600),
    adminActivityRetention: Number(process.env.GATEWAY_ADMIN_ACTIVITY_RETENTION || 5000),
    adminStateRedisPrefix: process.env.GATEWAY_ADMIN_STATE_REDIS_PREFIX || 'gateway:admin:'
  }
};

async function loadTlsOptions(tlsConfig) {
  if (!tlsConfig.enabled) return null;
  if (!tlsConfig.keyPath || !tlsConfig.certPath) {
    throw new Error('TLS enabled but key/cert paths not provided');
  }

  const [key, cert] = await Promise.all([
    readFile(resolve(tlsConfig.keyPath)),
    readFile(resolve(tlsConfig.certPath))
  ]);

  return { key, cert };
}

function loadConfig(overrides = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...overrides,
    tls: {
      ...DEFAULT_CONFIG.tls,
      ...(overrides.tls || {})
    },
    metrics: {
      ...DEFAULT_CONFIG.metrics,
      ...(overrides.metrics || {})
    },
    registration: {
      ...DEFAULT_CONFIG.registration,
      ...(overrides.registration || {})
    },
    rateLimit: {
      ...DEFAULT_CONFIG.rateLimit,
      ...(overrides.rateLimit || {})
    },
    discovery: {
      ...DEFAULT_CONFIG.discovery,
      ...(overrides.discovery || {})
    },
    relay: {
      ...DEFAULT_CONFIG.relay,
      ...(overrides.relay || {})
    },
    features: {
      ...DEFAULT_CONFIG.features,
      ...(overrides.features || {})
    },
    dispatcher: {
      ...DEFAULT_CONFIG.dispatcher,
      ...(overrides.dispatcher || {})
    },
    blindPeer: {
      ...DEFAULT_CONFIG.blindPeer,
      ...(overrides.blindPeer || {})
    },
    openJoin: {
      ...DEFAULT_CONFIG.openJoin,
      ...(overrides.openJoin || {})
    },
    gateway: {
      ...DEFAULT_CONFIG.gateway,
      ...(overrides.gateway || {})
    }
  };

  if (!merged.publicBaseUrl) {
    throw new Error('Gateway requires a publicBaseUrl configuration value');
  }

  merged.relay = normalizeRelaySettings(merged.relay);
  merged.blindPeer = normalizeBlindPeerSettings(merged.blindPeer);

  if (!Number.isFinite(merged.registration.tokenTtlSeconds)) {
    merged.registration.tokenTtlSeconds = merged.registration.defaultTokenTtl;
  }

  if (Number.isFinite(merged.openJoin?.poolEntryTtlMs)) {
    const derivedPoolTtlSeconds = Math.ceil(merged.openJoin.poolEntryTtlMs / 1000);
    merged.registration.openJoinPoolTtlSeconds = derivedPoolTtlSeconds;
  }

  if (Number.isFinite(merged.registration?.relayGcAfterMs) && merged.registration.relayGcAfterMs > 0) {
    merged.registration.cacheTtlSeconds = 0;
    merged.registration.mirrorTtlSeconds = 0;
    merged.registration.openJoinPoolTtlSeconds = 0;
    merged.registration.relayTtlSeconds = 0;
    merged.registration.aliasTtlSeconds = 0;
  }

  const relayGcExplicitlyConfigured = typeof process.env.GATEWAY_RELAY_GC_AFTER_MS !== 'undefined'
    || Number.isFinite(overrides?.registration?.relayGcAfterMs);
  if (relayGcExplicitlyConfigured
    && Number.isFinite(merged.registration?.relayGcAfterMs)
    && merged.registration.relayGcAfterMs > 0
    && Number.isFinite(merged.blindPeer?.staleCoreTtlMs)
    && merged.blindPeer.staleCoreTtlMs < merged.registration.relayGcAfterMs) {
    merged.blindPeer.staleCoreTtlMs = merged.registration.relayGcAfterMs;
  }

  return merged;
}

function parseRelayAliasPaths(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input.map((value) => (typeof value === 'string' ? value.trim() : value)).filter((value) => typeof value === 'string' && value.length);
  return String(input)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length);
}

function parseCsvValues(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((value) => String(value || '').trim()).filter((value) => value.length);
  }
  return String(input)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length);
}

function normalizeGatewayPathValue(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeRelaySettings(relayConfig = {}) {
  const result = { ...relayConfig };
  const canonicalPath = normalizeGatewayPathValue(result.canonicalPath) || 'relay';
  const aliasInput = Array.isArray(result.aliasPaths) ? result.aliasPaths : parseRelayAliasPaths(result.aliasPaths);
  const aliasSet = new Set();
  const addAlias = (value) => {
    const normalized = normalizeGatewayPathValue(value);
    if (normalized) {
      aliasSet.add(normalized);
    }
  };

  addAlias(canonicalPath);
  (aliasInput || []).forEach(addAlias);
  addAlias(LEGACY_PUBLIC_GATEWAY_PATH);
  addAlias('relay');

  result.canonicalPath = canonicalPath;
  result.aliasPaths = Array.from(aliasSet);
  return result;
}

function normalizeBlindPeerSettings(settings = {}) {
  const sanitizePath = (value) => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  const toPositiveInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
  };

  return {
    enabled: !!settings.enabled,
    storageDir: sanitizePath(settings.storageDir),
    maxBytes: toPositiveInt(settings.maxBytes, DEFAULT_BLIND_PEER_MAX_BYTES),
    gcIntervalMs: toPositiveInt(settings.gcIntervalMs, 300000),
    dedupeBatchSize: toPositiveInt(settings.dedupeBatchSize, 100),
    staleCoreTtlMs: toPositiveInt(settings.staleCoreTtlMs, 7 * 24 * 60 * 60 * 1000),
    trustedPeersPersistPath: sanitizePath(settings.trustedPeersPersistPath)
  };
}

export {
  loadConfig,
  loadTlsOptions
};
