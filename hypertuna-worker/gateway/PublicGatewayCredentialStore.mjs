import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const CREDENTIAL_CACHE_FILENAME = 'public-gateway-credential-cache.json';
const CREDENTIAL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

let configuredStorageBase = null;
let configuredLogger = console;
const credentialEntries = new Map();
let credentialsLoaded = false;
let credentialsDirty = false;
let flushTimer = null;

function resolveStorageBase() {
  if (configuredStorageBase) return configuredStorageBase;
  return global?.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data');
}

function getCredentialCachePath() {
  return join(resolveStorageBase(), CREDENTIAL_CACHE_FILENAME);
}

function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function normalizeScope(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'creator' || normalized === 'relay') return normalized;
  return null;
}

function normalizeRelayKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeSource(source) {
  if (typeof source !== 'string') return 'unknown';
  const normalized = source.trim().toLowerCase();
  return normalized || 'unknown';
}

function buildCredentialKey({ origin, scope, relayKey = null, creatorPubkey = null } = {}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedScope = normalizeScope(scope);
  if (!normalizedOrigin || !normalizedScope) return null;
  const normalizedRelayKey = normalizeRelayKey(relayKey);
  const normalizedCreator = normalizePubkey(creatorPubkey);
  const relayPart = normalizedRelayKey || '-';
  const creatorPart = normalizedCreator || '-';
  return `${normalizedOrigin}|${normalizedScope}|${relayPart}|${creatorPart}`;
}

function normalizeCredentialEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const origin = normalizeOrigin(envelope.origin);
  const scope = normalizeScope(envelope.scope);
  if (!origin || !scope) return null;
  const relayKey = normalizeRelayKey(envelope.relayKey);
  const creatorPubkey = normalizePubkey(envelope.creatorPubkey);
  if (scope === 'relay' && !relayKey) return null;
  const token = typeof envelope.token === 'string' ? envelope.token.trim() : '';
  if (!token) return null;
  const issuedAt = Number.isFinite(Number(envelope.issuedAt)) ? Number(envelope.issuedAt) : Date.now();
  const expiresAt = Number.isFinite(Number(envelope.expiresAt)) ? Number(envelope.expiresAt) : null;
  const credentialVersion = Number.isFinite(Number(envelope.credentialVersion))
    ? Math.max(1, Math.trunc(Number(envelope.credentialVersion)))
    : 1;
  return {
    version: Number.isFinite(Number(envelope.version)) ? Number(envelope.version) : 1,
    origin,
    scope,
    relayKey,
    creatorPubkey,
    issuedAt,
    expiresAt,
    credentialVersion,
    token
  };
}

function normalizeEntry(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const envelope = normalizeCredentialEnvelope(entry.envelope || entry);
  if (!envelope) return null;
  if (envelope.expiresAt && envelope.expiresAt <= now) return null;
  const key = buildCredentialKey(envelope);
  if (!key) return null;
  return {
    key,
    envelope,
    source: normalizeSource(entry.source),
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : now,
    lastSuccessAt: Number.isFinite(Number(entry.lastSuccessAt)) ? Number(entry.lastSuccessAt) : null,
    lastErrorAt: Number.isFinite(Number(entry.lastErrorAt)) ? Number(entry.lastErrorAt) : null,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null
  };
}

function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const envelope = entry.envelope || {};
  return {
    key: entry.key || null,
    source: entry.source || 'unknown',
    updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : null,
    lastSuccessAt: Number.isFinite(entry.lastSuccessAt) ? Number(entry.lastSuccessAt) : null,
    lastErrorAt: Number.isFinite(entry.lastErrorAt) ? Number(entry.lastErrorAt) : null,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
    envelope: {
      version: Number.isFinite(Number(envelope.version)) ? Number(envelope.version) : 1,
      origin: normalizeOrigin(envelope.origin),
      scope: normalizeScope(envelope.scope),
      relayKey: normalizeRelayKey(envelope.relayKey),
      creatorPubkey: normalizePubkey(envelope.creatorPubkey),
      issuedAt: Number.isFinite(Number(envelope.issuedAt)) ? Number(envelope.issuedAt) : null,
      expiresAt: Number.isFinite(Number(envelope.expiresAt)) ? Number(envelope.expiresAt) : null,
      credentialVersion: Number.isFinite(Number(envelope.credentialVersion))
        ? Math.max(1, Math.trunc(Number(envelope.credentialVersion)))
        : 1,
      hasToken: typeof envelope.token === 'string' && envelope.token.length > 0,
      tokenLength: typeof envelope.token === 'string' ? envelope.token.length : 0
    }
  };
}

function pruneEntry(entry, now = Date.now()) {
  const normalized = normalizeEntry(entry, now);
  if (!normalized) return null;
  const touchedAt = Math.max(
    Number(normalized.updatedAt || 0),
    Number(normalized.lastSuccessAt || 0),
    Number(normalized.lastErrorAt || 0),
    Number(normalized.envelope?.issuedAt || 0)
  );
  if (touchedAt && now - touchedAt > CREDENTIAL_RETENTION_MS) return null;
  return normalized;
}

async function loadCredentialStore() {
  if (credentialsLoaded) return;
  credentialsLoaded = true;
  const cachePath = getCredentialCachePath();
  try {
    const payload = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(payload);
    const entries = parsed?.entries && typeof parsed.entries === 'object'
      ? parsed.entries
      : parsed;
    if (!entries || typeof entries !== 'object') return;
    const now = Date.now();
    for (const [key, value] of Object.entries(entries)) {
      const normalized = pruneEntry({ ...value, key }, now);
      if (!normalized) continue;
      credentialEntries.set(normalized.key, normalized);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load public gateway credential store', {
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
    flushCredentialStore().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush public gateway credential store', {
        error: error?.message || error
      });
    });
  }, 1200);
  flushTimer.unref?.();
}

async function flushCredentialStore() {
  if (!credentialsDirty) return;
  credentialsDirty = false;
  const now = Date.now();
  const entries = {};
  for (const [key, entry] of credentialEntries.entries()) {
    const pruned = pruneEntry(entry, now);
    if (!pruned) {
      credentialEntries.delete(key);
      continue;
    }
    entries[key] = pruned;
  }
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(getCredentialCachePath(), JSON.stringify({ entries }, null, 2), 'utf8');
}

export function configurePublicGatewayCredentialStore({ storageBase = null, logger = null } = {}) {
  if (typeof storageBase === 'string' && storageBase.trim()) {
    configuredStorageBase = storageBase;
  }
  if (logger) {
    configuredLogger = logger;
  }
}

export async function upsertPublicGatewayCredential({
  envelope,
  source = 'unknown',
  updatedAt = Date.now(),
  lastSuccessAt = undefined,
  lastErrorAt = undefined,
  lastError = undefined
} = {}) {
  await loadCredentialStore();
  const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
  const normalizedEnvelope = normalizeCredentialEnvelope(envelope);
  if (!normalizedEnvelope) return null;
  const key = buildCredentialKey(normalizedEnvelope);
  if (!key) return null;
  const next = normalizeEntry({
    key,
    envelope: normalizedEnvelope,
    source,
    updatedAt: now,
    lastSuccessAt,
    lastErrorAt,
    lastError
  }, now);
  if (!next) return null;
  const existing = credentialEntries.get(key) || null;
  credentialEntries.set(key, {
    ...existing,
    ...next
  });
  credentialsDirty = true;
  scheduleFlush();
  return redactEntry(credentialEntries.get(key));
}

export async function getPublicGatewayCredential({
  origin,
  scope,
  relayKey = null,
  creatorPubkey = null,
  includeToken = false
} = {}) {
  await loadCredentialStore();
  const key = buildCredentialKey({ origin, scope, relayKey, creatorPubkey });
  if (!key) return null;
  const entry = pruneEntry(credentialEntries.get(key), Date.now());
  if (!entry) {
    credentialEntries.delete(key);
    return null;
  }
  credentialEntries.set(key, entry);
  if (includeToken) return { ...entry, envelope: { ...entry.envelope } };
  return redactEntry(entry);
}

export async function findPublicGatewayCredential({
  origin,
  relayKey = null,
  creatorPubkey = null,
  includeToken = false
} = {}) {
  await loadCredentialStore();
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedRelayKey = normalizeRelayKey(relayKey);
  const normalizedCreator = normalizePubkey(creatorPubkey);
  const candidates = [];
  if (normalizedOrigin && normalizedRelayKey) {
    const relayKeyExact = buildCredentialKey({
      origin: normalizedOrigin,
      scope: 'relay',
      relayKey: normalizedRelayKey,
      creatorPubkey: normalizedCreator || null
    });
    if (relayKeyExact) candidates.push(relayKeyExact);
    const relayWithoutCreator = buildCredentialKey({
      origin: normalizedOrigin,
      scope: 'relay',
      relayKey: normalizedRelayKey,
      creatorPubkey: null
    });
    if (relayWithoutCreator && relayWithoutCreator !== relayKeyExact) candidates.push(relayWithoutCreator);
  }
  if (normalizedOrigin && normalizedCreator) {
    const creatorKey = buildCredentialKey({
      origin: normalizedOrigin,
      scope: 'creator',
      creatorPubkey: normalizedCreator,
      relayKey: null
    });
    if (creatorKey) candidates.push(creatorKey);
  }

  const now = Date.now();
  for (const key of candidates) {
    const entry = pruneEntry(credentialEntries.get(key), now);
    if (!entry) {
      credentialEntries.delete(key);
      continue;
    }
    credentialEntries.set(key, entry);
    if (includeToken) return { ...entry, envelope: { ...entry.envelope } };
    return redactEntry(entry);
  }
  return null;
}

export async function removePublicGatewayCredential({ origin, scope, relayKey = null, creatorPubkey = null } = {}) {
  await loadCredentialStore();
  const key = buildCredentialKey({ origin, scope, relayKey, creatorPubkey });
  if (!key) return false;
  const deleted = credentialEntries.delete(key);
  if (deleted) {
    credentialsDirty = true;
    scheduleFlush();
  }
  return deleted;
}

export async function listPublicGatewayCredentials({ includeToken = false } = {}) {
  await loadCredentialStore();
  const now = Date.now();
  const rows = [];
  for (const [key, entry] of credentialEntries.entries()) {
    const pruned = pruneEntry(entry, now);
    if (!pruned) {
      credentialEntries.delete(key);
      continue;
    }
    credentialEntries.set(key, pruned);
    rows.push(includeToken ? { ...pruned, envelope: { ...pruned.envelope } } : redactEntry(pruned));
  }
  rows.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  return rows;
}

export async function recordPublicGatewayCredentialSuccess({ origin, scope, relayKey = null, creatorPubkey = null, observedAt = Date.now() } = {}) {
  await loadCredentialStore();
  const key = buildCredentialKey({ origin, scope, relayKey, creatorPubkey });
  if (!key) return null;
  const entry = credentialEntries.get(key) || null;
  if (!entry) return null;
  const next = {
    ...entry,
    lastSuccessAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now(),
    updatedAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now()
  };
  credentialEntries.set(key, next);
  credentialsDirty = true;
  scheduleFlush();
  return redactEntry(next);
}

export async function recordPublicGatewayCredentialError({
  origin,
  scope,
  relayKey = null,
  creatorPubkey = null,
  observedAt = Date.now(),
  error = null
} = {}) {
  await loadCredentialStore();
  const key = buildCredentialKey({ origin, scope, relayKey, creatorPubkey });
  if (!key) return null;
  const entry = credentialEntries.get(key) || null;
  if (!entry) return null;
  const next = {
    ...entry,
    lastErrorAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now(),
    lastError: typeof error === 'string' ? error : (error?.message || null),
    updatedAt: Number.isFinite(observedAt) ? Number(observedAt) : Date.now()
  };
  credentialEntries.set(key, next);
  credentialsDirty = true;
  scheduleFlush();
  return redactEntry(next);
}

export async function prunePublicGatewayCredentialStore() {
  await loadCredentialStore();
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of credentialEntries.entries()) {
    const pruned = pruneEntry(entry, now);
    if (!pruned) {
      credentialEntries.delete(key);
      changed = true;
      continue;
    }
    credentialEntries.set(key, pruned);
  }
  if (changed) {
    credentialsDirty = true;
    scheduleFlush();
  }
}
