import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const SECRET_CACHE_FILENAME = 'public-gateway-secret-cache.json';
const SECRET_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

let configuredStorageBase = null;
let configuredLogger = console;
const secretEntries = new Map();
let secretsLoaded = false;
let secretsDirty = false;
let flushTimer = null;

function resolveStorageBase() {
  if (configuredStorageBase) return configuredStorageBase;
  return global?.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data');
}

function getSecretCachePath() {
  return join(resolveStorageBase(), SECRET_CACHE_FILENAME);
}

function normalizeHttpOrigin(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
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

function sanitizeSecret(secret) {
  if (typeof secret !== 'string') return null;
  const trimmed = secret.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeEntry(origin, entry, now = Date.now()) {
  const normalizedOrigin = normalizeHttpOrigin(origin || entry?.origin || null);
  if (!normalizedOrigin) return null;
  const secret = sanitizeSecret(entry?.sharedSecret);
  if (!secret) return null;
  return {
    origin: normalizedOrigin,
    sharedSecret: secret,
    source: normalizeSource(entry?.source),
    updatedAt: Number.isFinite(entry?.updatedAt) ? Number(entry.updatedAt) : now,
    lastSuccessAt: Number.isFinite(entry?.lastSuccessAt) ? Number(entry.lastSuccessAt) : null,
    lastErrorAt: Number.isFinite(entry?.lastErrorAt) ? Number(entry.lastErrorAt) : null,
    lastError: typeof entry?.lastError === 'string' ? entry.lastError : null,
    secretVersion: typeof entry?.secretVersion === 'string' ? entry.secretVersion : null,
    secretHash: typeof entry?.secretHash === 'string' ? entry.secretHash : null
  };
}

function pruneEntry(entry, now = Date.now()) {
  const normalized = normalizeEntry(entry?.origin, entry, now);
  if (!normalized) return null;
  const touchedAt = Math.max(
    Number(normalized.updatedAt || 0),
    Number(normalized.lastSuccessAt || 0),
    Number(normalized.lastErrorAt || 0)
  );
  if (touchedAt && now - touchedAt > SECRET_RETENTION_MS) return null;
  return normalized;
}

function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    origin: entry.origin || null,
    source: entry.source || 'unknown',
    hasSecret: typeof entry.sharedSecret === 'string' && entry.sharedSecret.length > 0,
    secretLength: typeof entry.sharedSecret === 'string' ? entry.sharedSecret.length : 0,
    secretVersion: entry.secretVersion || null,
    secretHash: entry.secretHash || null,
    updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : null,
    lastSuccessAt: Number.isFinite(entry.lastSuccessAt) ? Number(entry.lastSuccessAt) : null,
    lastErrorAt: Number.isFinite(entry.lastErrorAt) ? Number(entry.lastErrorAt) : null,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null
  };
}

async function loadSecretStore() {
  if (secretsLoaded) return;
  secretsLoaded = true;
  const cachePath = getSecretCachePath();
  try {
    const payload = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(payload);
    const entries = parsed?.origins && typeof parsed.origins === 'object'
      ? parsed.origins
      : parsed;
    if (!entries || typeof entries !== 'object') return;
    const now = Date.now();
    for (const [origin, value] of Object.entries(entries)) {
      const normalized = pruneEntry({ ...value, origin }, now);
      if (!normalized) continue;
      secretEntries.set(normalized.origin, normalized);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load public gateway secret store', {
        path: cachePath,
        error: error?.message || error
      });
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSecretStore().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush public gateway secret store', {
        error: error?.message || error
      });
    });
  }, 1200);
  flushTimer.unref?.();
}

async function flushSecretStore() {
  if (!secretsDirty) return;
  secretsDirty = false;
  const now = Date.now();
  const origins = {};
  for (const [origin, entry] of secretEntries.entries()) {
    const pruned = pruneEntry(entry, now);
    if (!pruned) {
      secretEntries.delete(origin);
      continue;
    }
    origins[origin] = pruned;
  }
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(getSecretCachePath(), JSON.stringify({ origins }, null, 2), 'utf8');
}

export function configurePublicGatewaySecretStore({ storageBase = null, logger = null } = {}) {
  if (typeof storageBase === 'string' && storageBase.trim()) {
    configuredStorageBase = storageBase;
  }
  if (logger) {
    configuredLogger = logger;
  }
}

export async function upsertPublicGatewaySecret({
  origin,
  sharedSecret,
  source = 'unknown',
  updatedAt = Date.now(),
  lastSuccessAt = undefined,
  lastErrorAt = undefined,
  lastError = undefined,
  secretVersion = undefined,
  secretHash = undefined
} = {}) {
  await loadSecretStore();
  const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
  const normalized = normalizeEntry(origin, {
    origin,
    sharedSecret,
    source,
    updatedAt: now,
    lastSuccessAt,
    lastErrorAt,
    lastError,
    secretVersion,
    secretHash
  }, now);
  if (!normalized) return null;
  const existing = secretEntries.get(normalized.origin) || null;
  secretEntries.set(normalized.origin, {
    ...existing,
    ...normalized
  });
  secretsDirty = true;
  scheduleFlush();
  return redactEntry(secretEntries.get(normalized.origin));
}

export async function removePublicGatewaySecret({ origin } = {}) {
  await loadSecretStore();
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return false;
  const deleted = secretEntries.delete(normalizedOrigin);
  if (deleted) {
    secretsDirty = true;
    scheduleFlush();
  }
  return deleted;
}

export async function getPublicGatewaySecret({ origin, includeSecret = false } = {}) {
  await loadSecretStore();
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return null;
  const entry = pruneEntry(secretEntries.get(normalizedOrigin), Date.now());
  if (!entry) {
    secretEntries.delete(normalizedOrigin);
    return null;
  }
  secretEntries.set(normalizedOrigin, entry);
  if (includeSecret) return { ...entry };
  return redactEntry(entry);
}

export async function listPublicGatewaySecrets({ includeSecret = false } = {}) {
  await loadSecretStore();
  const now = Date.now();
  const rows = [];
  for (const [origin, value] of secretEntries.entries()) {
    const pruned = pruneEntry(value, now);
    if (!pruned) {
      secretEntries.delete(origin);
      continue;
    }
    secretEntries.set(origin, pruned);
    rows.push(includeSecret ? { ...pruned } : redactEntry(pruned));
  }
  rows.sort((a, b) => (Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0)));
  return rows;
}

export async function recordPublicGatewaySecretSuccess({ origin, observedAt = Date.now() } = {}) {
  await loadSecretStore();
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return null;
  const entry = secretEntries.get(normalizedOrigin) || null;
  if (!entry) return null;
  const next = {
    ...entry,
    lastSuccessAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now(),
    updatedAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now()
  };
  secretEntries.set(normalizedOrigin, next);
  secretsDirty = true;
  scheduleFlush();
  return redactEntry(next);
}

export async function recordPublicGatewaySecretError({
  origin,
  observedAt = Date.now(),
  error = null
} = {}) {
  await loadSecretStore();
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return null;
  const entry = secretEntries.get(normalizedOrigin) || null;
  if (!entry) return null;
  const next = {
    ...entry,
    lastErrorAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now(),
    lastError: typeof error === 'string' ? error : (error?.message || null),
    updatedAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now()
  };
  secretEntries.set(normalizedOrigin, next);
  secretsDirty = true;
  scheduleFlush();
  return redactEntry(next);
}

export async function prunePublicGatewaySecretStore() {
  await loadSecretStore();
  const now = Date.now();
  let changed = false;
  for (const [origin, value] of secretEntries.entries()) {
    const pruned = pruneEntry(value, now);
    if (!pruned) {
      secretEntries.delete(origin);
      changed = true;
      continue;
    }
    secretEntries.set(origin, pruned);
  }
  if (changed) {
    secretsDirty = true;
    scheduleFlush();
  }
}
