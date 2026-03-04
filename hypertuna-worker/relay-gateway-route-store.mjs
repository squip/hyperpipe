import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const RELAY_GATEWAY_ROUTE_CACHE_FILENAME = 'relay-gateway-route-cache.json';
const ROUTE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

const SOURCE_PRIORITY = {
  'payload-explicit': 100,
  'payload-invite': 95,
  'metadata-tag': 90,
  'create-flow': 85,
  'join-flow': 80,
  profile: 70,
  cache: 40,
  unknown: 10
};

let configuredStorageBase = null;
let configuredLogger = console;
const routeEntries = new Map();
let routeLoaded = false;
let routeDirty = false;
let routeFlushTimer = null;

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function normalizeRelayIdentity(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isHex64(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function normalizeGatewayOrigin(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (/^(none|null|disabled|direct-only)$/i.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function normalizeSource(source) {
  if (typeof source !== 'string') return 'unknown';
  const normalized = source.trim().toLowerCase();
  return normalized || 'unknown';
}

function resolveStorageBase() {
  if (configuredStorageBase) return configuredStorageBase;
  return global?.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data');
}

function getRouteCachePath() {
  return join(resolveStorageBase(), RELAY_GATEWAY_ROUTE_CACHE_FILENAME);
}

function getIdentityKeys(relayKey = null, publicIdentifier = null) {
  const keys = new Set();
  const normalizedRelayKey = normalizeRelayIdentity(relayKey);
  const normalizedIdentifier = normalizeRelayIdentity(publicIdentifier);
  if (normalizedRelayKey) keys.add(normalizedRelayKey);
  if (normalizedIdentifier) keys.add(normalizedIdentifier);
  return Array.from(keys);
}

function emptyEntry(now = Date.now()) {
  return {
    relayKey: null,
    publicIdentifier: null,
    gatewayOrigin: null,
    explicitNone: false,
    source: 'unknown',
    updatedAt: now,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null
  };
}

function sourceRank(source) {
  return SOURCE_PRIORITY[normalizeSource(source)] || SOURCE_PRIORITY.unknown;
}

function normalizeEntry(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const relayKey = normalizeRelayIdentity(entry.relayKey);
  const publicIdentifier = normalizeRelayIdentity(entry.publicIdentifier);
  const rawOrigin = typeof entry.gatewayOrigin === 'string' ? entry.gatewayOrigin : '';
  const gatewayOrigin = normalizeGatewayOrigin(rawOrigin);
  const explicitNone = entry.explicitNone === true || (!gatewayOrigin && typeof rawOrigin === 'string' && rawOrigin.trim().length > 0)
    || (entry.explicitNone === true)
    || (entry.gatewayOrigin === null && entry.explicitNone !== false);

  if (!relayKey && !publicIdentifier) return null;

  return {
    relayKey: relayKey || null,
    publicIdentifier: publicIdentifier || null,
    gatewayOrigin: gatewayOrigin || null,
    explicitNone: !!explicitNone && !gatewayOrigin,
    source: normalizeSource(entry.source),
    updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : now,
    lastSuccessAt: Number.isFinite(entry.lastSuccessAt) ? Number(entry.lastSuccessAt) : null,
    lastErrorAt: Number.isFinite(entry.lastErrorAt) ? Number(entry.lastErrorAt) : null,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null
  };
}

function shouldReplaceEntry(current, incoming) {
  if (!current) return true;
  const currentRank = sourceRank(current.source);
  const incomingRank = sourceRank(incoming.source);
  if (incomingRank > currentRank) return true;
  if (incomingRank < currentRank) return false;
  return Number(incoming.updatedAt || 0) >= Number(current.updatedAt || 0);
}

function mergeEntries(left, right, now = Date.now()) {
  const a = normalizeEntry(left, now) || emptyEntry(now);
  const b = normalizeEntry(right, now) || emptyEntry(now);
  const preferred = shouldReplaceEntry(a, b) ? b : a;
  const fallback = preferred === a ? b : a;
  return {
    relayKey: preferred.relayKey || fallback.relayKey || null,
    publicIdentifier: preferred.publicIdentifier || fallback.publicIdentifier || null,
    gatewayOrigin: preferred.gatewayOrigin ?? fallback.gatewayOrigin ?? null,
    explicitNone:
      preferred.gatewayOrigin
        ? false
        : (preferred.explicitNone || fallback.explicitNone || false),
    source: preferred.source || fallback.source || 'unknown',
    updatedAt: Math.max(Number(a.updatedAt || 0), Number(b.updatedAt || 0), now),
    lastSuccessAt: Math.max(Number(a.lastSuccessAt || 0), Number(b.lastSuccessAt || 0)) || null,
    lastErrorAt: Math.max(Number(a.lastErrorAt || 0), Number(b.lastErrorAt || 0)) || null,
    lastError: preferred.lastError || fallback.lastError || null
  };
}

function pruneEntry(entry, now = Date.now()) {
  const normalized = normalizeEntry(entry, now);
  if (!normalized) return null;
  const touchedAt = Math.max(
    Number(normalized.updatedAt || 0),
    Number(normalized.lastSuccessAt || 0),
    Number(normalized.lastErrorAt || 0)
  );
  if (touchedAt && now - touchedAt > ROUTE_RETENTION_MS) return null;
  return normalized;
}

async function loadRouteStore() {
  if (routeLoaded) return;
  routeLoaded = true;
  const cachePath = getRouteCachePath();
  try {
    const payload = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(payload);
    const relays = parsed?.relays && typeof parsed.relays === 'object' ? parsed.relays : parsed;
    if (!relays || typeof relays !== 'object') return;
    const now = Date.now();
    for (const [key, value] of Object.entries(relays)) {
      const normalizedKey = normalizeRelayIdentity(key);
      if (!normalizedKey) continue;
      const entry = pruneEntry(value, now);
      if (!entry) continue;
      routeEntries.set(normalizedKey, entry);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load relay gateway route store', {
        path: cachePath,
        error: error?.message || error
      });
    }
  }
}

function scheduleRouteFlush() {
  if (routeFlushTimer) return;
  routeFlushTimer = setTimeout(() => {
    routeFlushTimer = null;
    flushRouteStore().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush relay gateway route store', {
        error: error?.message || error
      });
    });
  }, 1200);
  routeFlushTimer.unref?.();
}

async function flushRouteStore() {
  if (!routeDirty) return;
  routeDirty = false;
  const now = Date.now();
  const relays = {};
  for (const [key, value] of routeEntries.entries()) {
    const pruned = pruneEntry(value, now);
    if (!pruned) {
      routeEntries.delete(key);
      continue;
    }
    relays[key] = pruned;
  }
  const payload = JSON.stringify({ relays }, null, 2);
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(getRouteCachePath(), payload, 'utf8');
}

export function configureRelayGatewayRouteStore({ storageBase = null, logger = null } = {}) {
  if (typeof storageBase === 'string' && storageBase.trim()) {
    configuredStorageBase = storageBase;
  }
  if (logger) {
    configuredLogger = logger;
  }
}

export async function getRelayGatewayRoute({ relayKey = null, publicIdentifier = null } = {}) {
  await loadRouteStore();
  const now = Date.now();
  const keys = getIdentityKeys(relayKey, publicIdentifier);
  let merged = null;
  for (const key of keys) {
    const entry = pruneEntry(routeEntries.get(key), now);
    if (!entry) continue;
    routeEntries.set(key, entry);
    merged = merged ? mergeEntries(merged, entry, now) : entry;
  }
  if (!merged) return emptyEntry(now);
  return merged;
}

export async function upsertRelayGatewayRoute({
  relayKey = null,
  publicIdentifier = null,
  gatewayOrigin = null,
  explicitNone = undefined,
  source = 'unknown',
  updatedAt = Date.now(),
  lastSuccessAt = undefined,
  lastErrorAt = undefined,
  lastError = undefined
} = {}) {
  await loadRouteStore();
  const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
  const normalizedOrigin = normalizeGatewayOrigin(gatewayOrigin);
  const nextEntry = normalizeEntry({
    relayKey,
    publicIdentifier,
    gatewayOrigin: normalizedOrigin || null,
    explicitNone: explicitNone === true || (explicitNone !== false && gatewayOrigin === null),
    source: normalizeSource(source),
    updatedAt: now,
    lastSuccessAt,
    lastErrorAt,
    lastError
  }, now);
  if (!nextEntry) return emptyEntry(now);

  const keys = getIdentityKeys(nextEntry.relayKey, nextEntry.publicIdentifier);
  if (!keys.length) return emptyEntry(now);
  for (const key of keys) {
    const current = routeEntries.get(key) || null;
    routeEntries.set(key, mergeEntries(current, nextEntry, now));
  }

  routeDirty = true;
  scheduleRouteFlush();
  return nextEntry;
}

export async function recordRelayGatewayRouteSuccess({
  relayKey = null,
  publicIdentifier = null,
  gatewayOrigin = null,
  observedAt = Date.now()
} = {}) {
  const current = await getRelayGatewayRoute({ relayKey, publicIdentifier });
  return upsertRelayGatewayRoute({
    relayKey: current.relayKey || relayKey,
    publicIdentifier: current.publicIdentifier || publicIdentifier,
    gatewayOrigin: normalizeGatewayOrigin(gatewayOrigin) || current.gatewayOrigin || null,
    explicitNone: current.explicitNone && !gatewayOrigin,
    source: current.source || 'unknown',
    updatedAt: observedAt,
    lastSuccessAt: observedAt,
    lastErrorAt: current.lastErrorAt,
    lastError: current.lastError
  });
}

export async function recordRelayGatewayRouteError({
  relayKey = null,
  publicIdentifier = null,
  gatewayOrigin = null,
  observedAt = Date.now(),
  error = null
} = {}) {
  const current = await getRelayGatewayRoute({ relayKey, publicIdentifier });
  return upsertRelayGatewayRoute({
    relayKey: current.relayKey || relayKey,
    publicIdentifier: current.publicIdentifier || publicIdentifier,
    gatewayOrigin: normalizeGatewayOrigin(gatewayOrigin) || current.gatewayOrigin || null,
    explicitNone: current.explicitNone && !gatewayOrigin,
    source: current.source || 'unknown',
    updatedAt: observedAt,
    lastSuccessAt: current.lastSuccessAt,
    lastErrorAt: observedAt,
    lastError: typeof error === 'string' ? error : (error?.message || null)
  });
}

export async function pruneRelayGatewayRouteStore() {
  await loadRouteStore();
  const now = Date.now();
  let changed = false;
  for (const [key, value] of routeEntries.entries()) {
    const pruned = pruneEntry(value, now);
    if (!pruned) {
      routeEntries.delete(key);
      changed = true;
      continue;
    }
    routeEntries.set(key, pruned);
  }
  if (changed) {
    routeDirty = true;
    scheduleRouteFlush();
  }
}
