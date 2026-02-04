import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const WRITER_POOL_CACHE_FILENAME = 'relay-writer-pool-cache.json';

let configuredStorageBase = null;
let configuredLogger = console;

const relayWriterPoolCache = new Map();
let relayWriterPoolLoaded = false;
let relayWriterPoolDirty = false;
let relayWriterPoolFlushTimer = null;

export function configureRelayWriterPoolStore({ storageBase = null, logger = null } = {}) {
  if (typeof storageBase === 'string' && storageBase.trim()) {
    configuredStorageBase = storageBase;
  }
  if (logger) {
    configuredLogger = logger;
  }
}

function resolveStorageBase() {
  if (configuredStorageBase) return configuredStorageBase;
  return global?.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data');
}

function getRelayWriterPoolPath() {
  return join(resolveStorageBase(), WRITER_POOL_CACHE_FILENAME);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const writerCore = typeof entry.writerCore === 'string' ? entry.writerCore : null;
  const writerCoreHex = typeof entry.writerCoreHex === 'string' ? entry.writerCoreHex : null;
  const autobaseLocal = typeof entry.autobaseLocal === 'string' ? entry.autobaseLocal : null;
  const writerSecret = typeof entry.writerSecret === 'string' ? entry.writerSecret : null;
  const issuedAt = Number.isFinite(entry.issuedAt) ? entry.issuedAt : null;
  const expiresAt = Number.isFinite(entry.expiresAt) ? entry.expiresAt : null;
  if (!writerCore && !writerCoreHex && !autobaseLocal) return null;
  if (!writerSecret) return null;
  return {
    writerCore,
    writerCoreHex,
    autobaseLocal,
    writerSecret,
    issuedAt,
    expiresAt
  };
}

export function pruneWriterPoolEntries(entries = [], now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    if (Number.isFinite(normalized.expiresAt) && normalized.expiresAt <= now) continue;
    result.push(normalized);
  }
  return result;
}

async function loadRelayWriterPoolCache() {
  if (relayWriterPoolLoaded) return;
  relayWriterPoolLoaded = true;
  const cachePath = getRelayWriterPoolPath();
  try {
    const payload = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(payload);
    const relays = parsed?.relays && typeof parsed.relays === 'object' ? parsed.relays : parsed;
    if (!relays || typeof relays !== 'object') return;
    for (const [relayKey, entry] of Object.entries(relays)) {
      const entries = pruneWriterPoolEntries(Array.isArray(entry) ? entry : entry?.entries || []);
      if (!entries.length) continue;
      const updatedAt = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : null;
      relayWriterPoolCache.set(relayKey, { entries, updatedAt });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load relay writer pool cache', {
        path: cachePath,
        error: error?.message || error
      });
    }
  }
}

function scheduleRelayWriterPoolFlush() {
  if (relayWriterPoolFlushTimer) return;
  relayWriterPoolFlushTimer = setTimeout(() => {
    relayWriterPoolFlushTimer = null;
    flushRelayWriterPoolCache().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush relay writer pool cache', {
        error: error?.message || error
      });
    });
  }, 1000);
  relayWriterPoolFlushTimer.unref?.();
}

async function flushRelayWriterPoolCache() {
  if (!relayWriterPoolDirty) return;
  relayWriterPoolDirty = false;
  const cachePath = getRelayWriterPoolPath();
  const relays = {};
  for (const [relayKey, entry] of relayWriterPoolCache.entries()) {
    if (!entry || !Array.isArray(entry.entries) || entry.entries.length === 0) continue;
    relays[relayKey] = {
      entries: entry.entries,
      updatedAt: entry.updatedAt || null
    };
  }
  const payload = JSON.stringify({ relays }, null, 2);
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(cachePath, payload, 'utf8');
}

export async function getRelayWriterPool(relayKey) {
  if (!relayKey) return { entries: [], updatedAt: null };
  await loadRelayWriterPoolCache();
  const cached = relayWriterPoolCache.get(relayKey);
  if (!cached) return { entries: [], updatedAt: null };
  const pruned = pruneWriterPoolEntries(cached.entries);
  if (pruned.length !== cached.entries.length) {
    relayWriterPoolCache.set(relayKey, { ...cached, entries: pruned });
    relayWriterPoolDirty = true;
    scheduleRelayWriterPoolFlush();
  }
  return { entries: pruned, updatedAt: cached.updatedAt || null };
}

export async function setRelayWriterPool(relayKey, entries = [], updatedAt = Date.now()) {
  if (!relayKey) return;
  await loadRelayWriterPoolCache();
  const pruned = pruneWriterPoolEntries(entries);
  relayWriterPoolCache.set(relayKey, {
    entries: pruned,
    updatedAt: updatedAt || Date.now()
  });
  relayWriterPoolDirty = true;
  scheduleRelayWriterPoolFlush();
}
