import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import HypercoreId from 'hypercore-id-encoding';

const PEER_DISCOVERY_CACHE_FILENAME = 'relay-peer-discovery-cache.json';
const CAPABILITY_TTL_MS = 15 * 60 * 1000;

let configuredStorageBase = null;
let configuredLogger = console;

const relayPeerDiscoveryCache = new Map();
let relayPeerDiscoveryLoaded = false;
let relayPeerDiscoveryDirty = false;
let relayPeerDiscoveryFlushTimer = null;

function resolveStorageBase() {
  if (configuredStorageBase) return configuredStorageBase;
  return global?.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data');
}

function getRelayPeerDiscoveryPath() {
  return join(resolveStorageBase(), PEER_DISCOVERY_CACHE_FILENAME);
}

function normalizeHex(value, expectedLength = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[^a-f0-9]/i.test(trimmed)) return null;
  if (expectedLength && trimmed.length !== expectedLength) return null;
  return trimmed;
}

function normalizeRelayKeyHex(value) {
  return normalizeHex(value, 64);
}

function normalizePeerKey(value) {
  if (!value) return null;
  const asHex = normalizeHex(String(value), 64);
  if (asHex) return asHex;
  try {
    const decoded = HypercoreId.decode(String(value).trim());
    if (decoded?.length === 32) {
      return Buffer.from(decoded).toString('hex');
    }
  } catch (_) {
    // no-op
  }
  return null;
}

function normalizeTopic(value) {
  if (!value) return null;
  const asHex = normalizeHex(String(value), 64);
  if (asHex) return asHex;
  try {
    const decoded = HypercoreId.decode(String(value).trim());
    if (decoded?.length === 32) {
      return Buffer.from(decoded).toString('hex');
    }
  } catch (_) {
    // no-op
  }
  return null;
}

function normalizePubkey(value) {
  return normalizeHex(value, 64);
}

function normalizePeerKeyList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((entry) => normalizePeerKey(entry)).filter(Boolean)));
}

function normalizeCapabilities(capabilities = {}, now = Date.now()) {
  const result = {};
  if (!capabilities || typeof capabilities !== 'object') return result;
  for (const [peerKey, snapshot] of Object.entries(capabilities)) {
    const normalizedPeer = normalizePeerKey(peerKey);
    if (!normalizedPeer || !snapshot || typeof snapshot !== 'object') continue;
    const observedAt = Number.isFinite(snapshot.observedAt) ? Math.trunc(snapshot.observedAt) : now;
    if (observedAt <= 0 || now - observedAt > CAPABILITY_TTL_MS) continue;
    result[normalizedPeer] = {
      writerGuarantee:
        typeof snapshot.writerGuarantee === 'string' && snapshot.writerGuarantee.trim()
          ? snapshot.writerGuarantee.trim()
          : 'none',
      supports: Array.isArray(snapshot.supports)
        ? Array.from(new Set(snapshot.supports.map((entry) => String(entry || '').trim()).filter(Boolean)))
        : [],
      isHosted: snapshot.isHosted === true,
      isOpen: snapshot.isOpen === true,
      writable: snapshot.writable === true,
      rttMs: Number.isFinite(snapshot.rttMs) ? Math.trunc(snapshot.rttMs) : null,
      observedAt
    };
  }
  return result;
}

function normalizeDiscoveryEntry(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const relayKey = normalizeRelayKeyHex(entry.relayKey || null);
  const publicIdentifier =
    typeof entry.publicIdentifier === 'string' && entry.publicIdentifier.trim()
      ? entry.publicIdentifier.trim()
      : null;
  const discoveryTopic = normalizeTopic(entry.discoveryTopic || null);
  const writerIssuerPubkey = normalizePubkey(entry.writerIssuerPubkey || null);
  const hostPeerKeys = normalizePeerKeyList(entry.hostPeerKeys || []);
  const memberPeerKeys = normalizePeerKeyList(entry.memberPeerKeys || []);
  const capabilities = normalizeCapabilities(entry.capabilities, now);
  const updatedAt = Number.isFinite(entry.updatedAt) ? Math.trunc(entry.updatedAt) : now;

  if (!relayKey && !publicIdentifier) return null;
  return {
    relayKey,
    publicIdentifier,
    discoveryTopic,
    writerIssuerPubkey,
    hostPeerKeys,
    memberPeerKeys,
    capabilities,
    updatedAt
  };
}

function collectCacheKeys({ relayKey = null, publicIdentifier = null } = {}) {
  const set = new Set();
  const normalizedRelayKey = normalizeRelayKeyHex(relayKey || null);
  const normalizedPublicIdentifier =
    typeof publicIdentifier === 'string' && publicIdentifier.trim()
      ? publicIdentifier.trim()
      : null;
  if (normalizedRelayKey) set.add(normalizedRelayKey);
  if (normalizedPublicIdentifier) set.add(normalizedPublicIdentifier);
  return Array.from(set);
}

function mergeUnique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function loadRelayPeerDiscoveryCache() {
  if (relayPeerDiscoveryLoaded) return;
  relayPeerDiscoveryLoaded = true;
  const cachePath = getRelayPeerDiscoveryPath();
  try {
    const payload = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(payload);
    const relays = parsed?.relays && typeof parsed.relays === 'object' ? parsed.relays : parsed;
    if (!relays || typeof relays !== 'object') return;

    const now = Date.now();
    for (const [key, value] of Object.entries(relays)) {
      const normalized = normalizeDiscoveryEntry(value, now);
      if (!normalized) continue;
      relayPeerDiscoveryCache.set(key, normalized);
      if (normalized.relayKey && normalized.relayKey !== key) {
        relayPeerDiscoveryCache.set(normalized.relayKey, normalized);
      }
      if (normalized.publicIdentifier && normalized.publicIdentifier !== key) {
        relayPeerDiscoveryCache.set(normalized.publicIdentifier, normalized);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load relay peer discovery cache', {
        path: cachePath,
        error: error?.message || error
      });
    }
  }
}

function scheduleRelayPeerDiscoveryFlush() {
  if (relayPeerDiscoveryFlushTimer) return;
  relayPeerDiscoveryFlushTimer = setTimeout(() => {
    relayPeerDiscoveryFlushTimer = null;
    flushRelayPeerDiscoveryCache().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush relay peer discovery cache', {
        error: error?.message || error
      });
    });
  }, 1000);
  relayPeerDiscoveryFlushTimer.unref?.();
}

async function flushRelayPeerDiscoveryCache() {
  if (!relayPeerDiscoveryDirty) return;
  relayPeerDiscoveryDirty = false;

  const relays = {};
  const emitted = new Set();
  for (const entry of relayPeerDiscoveryCache.values()) {
    const normalized = normalizeDiscoveryEntry(entry, Date.now());
    if (!normalized) continue;
    const primaryKey = normalized.relayKey || normalized.publicIdentifier;
    if (!primaryKey || emitted.has(primaryKey)) continue;
    emitted.add(primaryKey);
    relays[primaryKey] = normalized;
  }

  const payload = JSON.stringify({ relays }, null, 2);
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(getRelayPeerDiscoveryPath(), payload, 'utf8');
}

function mergeDiscoveryPatch(base, patch = {}, now = Date.now()) {
  const normalizedPatch = normalizeDiscoveryEntry({
    ...base,
    ...patch,
    relayKey: patch?.relayKey ?? base?.relayKey,
    publicIdentifier: patch?.publicIdentifier ?? base?.publicIdentifier,
    updatedAt: patch?.updatedAt ?? now
  }, now);
  if (!normalizedPatch) return null;

  return {
    relayKey: normalizedPatch.relayKey || base?.relayKey || null,
    publicIdentifier: normalizedPatch.publicIdentifier || base?.publicIdentifier || null,
    discoveryTopic: normalizedPatch.discoveryTopic || base?.discoveryTopic || null,
    writerIssuerPubkey: normalizedPatch.writerIssuerPubkey || base?.writerIssuerPubkey || null,
    hostPeerKeys: mergeUnique([
      ...(Array.isArray(base?.hostPeerKeys) ? base.hostPeerKeys : []),
      ...(Array.isArray(normalizedPatch.hostPeerKeys) ? normalizedPatch.hostPeerKeys : [])
    ]),
    memberPeerKeys: mergeUnique([
      ...(Array.isArray(base?.memberPeerKeys) ? base.memberPeerKeys : []),
      ...(Array.isArray(normalizedPatch.memberPeerKeys) ? normalizedPatch.memberPeerKeys : [])
    ]),
    capabilities: {
      ...(base?.capabilities && typeof base.capabilities === 'object' ? base.capabilities : {}),
      ...(normalizedPatch.capabilities && typeof normalizedPatch.capabilities === 'object'
        ? normalizedPatch.capabilities
        : {})
    },
    updatedAt: Math.max(
      Number.isFinite(base?.updatedAt) ? Math.trunc(base.updatedAt) : 0,
      Number.isFinite(normalizedPatch.updatedAt) ? Math.trunc(normalizedPatch.updatedAt) : now
    )
  };
}

export function configureRelayPeerDiscoveryStore({ storageBase = null, logger = null } = {}) {
  if (typeof storageBase === 'string' && storageBase.trim()) {
    configuredStorageBase = storageBase;
  }
  if (logger) {
    configuredLogger = logger;
  }
}

export async function getRelayPeerDiscovery(relayKey = null, publicIdentifier = null) {
  await loadRelayPeerDiscoveryCache();
  const keys = collectCacheKeys({ relayKey, publicIdentifier });
  let merged = null;
  const now = Date.now();
  for (const key of keys) {
    const cached = relayPeerDiscoveryCache.get(key);
    if (!cached) continue;
    const normalized = normalizeDiscoveryEntry(cached, now);
    if (!normalized) continue;
    merged = mergeDiscoveryPatch(merged, normalized, now);
  }
  return merged || {
    relayKey: normalizeRelayKeyHex(relayKey || null),
    publicIdentifier:
      typeof publicIdentifier === 'string' && publicIdentifier.trim()
        ? publicIdentifier.trim()
        : null,
    discoveryTopic: null,
    writerIssuerPubkey: null,
    hostPeerKeys: [],
    memberPeerKeys: [],
    capabilities: {},
    updatedAt: null
  };
}

export async function setRelayPeerDiscovery(relayKey = null, publicIdentifier = null, patch = {}) {
  await loadRelayPeerDiscoveryCache();
  const now = Date.now();
  const existing = await getRelayPeerDiscovery(relayKey, publicIdentifier);
  const merged = mergeDiscoveryPatch(existing, {
    ...patch,
    relayKey: patch?.relayKey ?? relayKey,
    publicIdentifier: patch?.publicIdentifier ?? publicIdentifier,
    updatedAt: patch?.updatedAt ?? now
  }, now);
  if (!merged) return null;

  const keys = collectCacheKeys({ relayKey: merged.relayKey, publicIdentifier: merged.publicIdentifier });
  if (!keys.length) return null;
  for (const key of keys) {
    relayPeerDiscoveryCache.set(key, merged);
  }
  relayPeerDiscoveryDirty = true;
  scheduleRelayPeerDiscoveryFlush();
  return merged;
}

export async function recordRelayPeerCapability(relayKey = null, publicIdentifier = null, peerKey = null, snapshot = {}) {
  const normalizedPeer = normalizePeerKey(peerKey);
  if (!normalizedPeer) return null;
  const observedAt = Number.isFinite(snapshot?.observedAt) ? Math.trunc(snapshot.observedAt) : Date.now();

  return await setRelayPeerDiscovery(relayKey, publicIdentifier, {
    capabilities: {
      [normalizedPeer]: {
        writerGuarantee:
          typeof snapshot?.writerGuarantee === 'string' && snapshot.writerGuarantee.trim()
            ? snapshot.writerGuarantee.trim()
            : 'none',
        supports: Array.isArray(snapshot?.supports)
          ? snapshot.supports.map((entry) => String(entry || '').trim()).filter(Boolean)
          : [],
        isHosted: snapshot?.isHosted === true,
        isOpen: snapshot?.isOpen === true,
        writable: snapshot?.writable === true,
        rttMs: Number.isFinite(snapshot?.rttMs) ? Math.trunc(snapshot.rttMs) : null,
        observedAt
      }
    }
  });
}

export async function listRelayPeerCapabilities(relayKey = null, publicIdentifier = null) {
  const entry = await getRelayPeerDiscovery(relayKey, publicIdentifier);
  const capabilities = entry?.capabilities && typeof entry.capabilities === 'object'
    ? entry.capabilities
    : {};
  return Object.entries(capabilities).map(([peerKey, snapshot]) => ({
    peerKey,
    ...(snapshot && typeof snapshot === 'object' ? snapshot : {})
  }));
}

export async function flushRelayPeerDiscoveryStore() {
  await flushRelayPeerDiscoveryCache();
}

export {
  CAPABILITY_TTL_MS
};
