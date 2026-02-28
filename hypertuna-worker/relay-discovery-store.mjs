import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const RELAY_DISCOVERY_CACHE_FILENAME = 'relay-discovery-cache.json';
const CAPABILITY_TTL_MS = 15 * 60 * 1000;
const PEER_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOPIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let configuredStorageBase = null;
let configuredLogger = console;

const relayDiscoveryCache = new Map();
let relayDiscoveryLoaded = false;
let relayDiscoveryDirty = false;
let relayDiscoveryFlushTimer = null;

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function normalizeRelayIdentifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isHex64(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function normalizePeerKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !isHex64(trimmed)) return null;
  return trimmed;
}

function normalizePeerHints(list = [], seenAt = Date.now()) {
  const result = [];
  const seen = new Set();
  const input = Array.isArray(list) ? list : [];
  for (const entry of input) {
    const key = normalizePeerKey(typeof entry === 'string' ? entry : entry?.peerKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tsRaw = typeof entry === 'object' && entry ? Number(entry.seenAt) : null;
    const ts = Number.isFinite(tsRaw) ? tsRaw : seenAt;
    result.push({ peerKey: key, seenAt: ts });
  }
  return result;
}

function normalizeCapabilityEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const lastProbeAt = Number(value.lastProbeAt);
  if (!Number.isFinite(lastProbeAt) || lastProbeAt <= 0) return null;
  const result = {
    lastProbeAt,
    lastSuccessAt: Number.isFinite(Number(value.lastSuccessAt)) ? Number(value.lastSuccessAt) : null,
    lastFailureAt: Number.isFinite(Number(value.lastFailureAt)) ? Number(value.lastFailureAt) : null,
    rttMs: Number.isFinite(Number(value.rttMs)) ? Number(value.rttMs) : null,
    canDirectChallenge: value.canDirectChallenge === true,
    canProvisionOpenWriter: value.canProvisionOpenWriter === true,
    hasMatchingLease: value.hasMatchingLease === true,
    leaseExpiresAt: Number.isFinite(Number(value.leaseExpiresAt)) ? Number(value.leaseExpiresAt) : null,
    writable: value.writable === true,
    active: value.active === true,
    nonce: typeof value.nonce === 'string' ? value.nonce : null
  };
  return result;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const now = Date.now();
  const hostPeerHints = normalizePeerHints(entry.hostPeerHints || entry.hostPeerKeys || [], now);
  const leaseReplicaPeerHints = normalizePeerHints(
    entry.leaseReplicaPeerHints || entry.leaseReplicaPeerKeys || [],
    now
  );

  const peerCapabilities = {};
  const capabilityInput = entry.peerCapabilities && typeof entry.peerCapabilities === 'object'
    ? entry.peerCapabilities
    : {};
  for (const [peerKeyRaw, capability] of Object.entries(capabilityInput)) {
    const peerKey = normalizePeerKey(peerKeyRaw);
    if (!peerKey) continue;
    const normalizedCapability = normalizeCapabilityEntry(capability);
    if (!normalizedCapability) continue;
    peerCapabilities[peerKey] = normalizedCapability;
  }

  return {
    relayKey: normalizeRelayIdentifier(entry.relayKey) || null,
    publicIdentifier: normalizeRelayIdentifier(entry.publicIdentifier) || null,
    discoveryTopic: typeof entry.discoveryTopic === 'string' ? entry.discoveryTopic.trim() || null : null,
    topicUpdatedAt: Number.isFinite(Number(entry.topicUpdatedAt)) ? Number(entry.topicUpdatedAt) : null,
    hostPeerHints,
    leaseReplicaPeerHints,
    writerIssuerPubkey:
      typeof entry.writerIssuerPubkey === 'string'
        ? entry.writerIssuerPubkey.trim().toLowerCase() || null
        : null,
    writerIssuerUpdatedAt: Number.isFinite(Number(entry.writerIssuerUpdatedAt))
      ? Number(entry.writerIssuerUpdatedAt)
      : null,
    peerCapabilities,
    lastJoinSuccessAt: Number.isFinite(Number(entry.lastJoinSuccessAt)) ? Number(entry.lastJoinSuccessAt) : null,
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : now
  };
}

function mergePeerHintLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    const normalized = normalizePeerHints(list || []);
    for (const entry of normalized) {
      const existing = merged.get(entry.peerKey);
      if (!existing || existing.seenAt < entry.seenAt) {
        merged.set(entry.peerKey, entry);
      }
    }
  }
  return Array.from(merged.values()).sort((left, right) => right.seenAt - left.seenAt);
}

function mergeEntries(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;

  const mergedCapabilities = {
    ...(base.peerCapabilities || {}),
    ...(incoming.peerCapabilities || {})
  };

  return {
    relayKey: incoming.relayKey || base.relayKey || null,
    publicIdentifier: incoming.publicIdentifier || base.publicIdentifier || null,
    discoveryTopic: incoming.discoveryTopic || base.discoveryTopic || null,
    topicUpdatedAt: incoming.topicUpdatedAt || base.topicUpdatedAt || null,
    hostPeerHints: mergePeerHintLists(base.hostPeerHints, incoming.hostPeerHints),
    leaseReplicaPeerHints: mergePeerHintLists(base.leaseReplicaPeerHints, incoming.leaseReplicaPeerHints),
    writerIssuerPubkey: incoming.writerIssuerPubkey || base.writerIssuerPubkey || null,
    writerIssuerUpdatedAt: incoming.writerIssuerUpdatedAt || base.writerIssuerUpdatedAt || null,
    peerCapabilities: mergedCapabilities,
    lastJoinSuccessAt: incoming.lastJoinSuccessAt || base.lastJoinSuccessAt || null,
    updatedAt: Math.max(base.updatedAt || 0, incoming.updatedAt || 0, Date.now())
  };
}

function pruneEntry(entry, now = Date.now()) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return null;

  const hostPeerHints = (normalized.hostPeerHints || []).filter((entry) => now - entry.seenAt <= PEER_HINT_TTL_MS);
  const leaseReplicaPeerHints = (normalized.leaseReplicaPeerHints || []).filter(
    (entry) => now - entry.seenAt <= PEER_HINT_TTL_MS
  );

  const peerCapabilities = {};
  for (const [peerKey, capability] of Object.entries(normalized.peerCapabilities || {})) {
    const cutoff = capability.lastProbeAt || capability.lastSuccessAt || capability.lastFailureAt || 0;
    if (!cutoff || now - cutoff > CAPABILITY_TTL_MS) continue;
    peerCapabilities[peerKey] = capability;
  }

  const topicStillValid =
    normalized.discoveryTopic &&
    Number.isFinite(normalized.topicUpdatedAt) &&
    now - Number(normalized.topicUpdatedAt) <= TOPIC_TTL_MS;

  return {
    ...normalized,
    discoveryTopic: topicStillValid ? normalized.discoveryTopic : null,
    topicUpdatedAt: topicStillValid ? normalized.topicUpdatedAt : null,
    hostPeerHints,
    leaseReplicaPeerHints,
    peerCapabilities
  };
}

function hasMeaningfulEntry(entry) {
  if (!entry) return false;
  return Boolean(
    entry.discoveryTopic ||
      (entry.hostPeerHints && entry.hostPeerHints.length) ||
      (entry.leaseReplicaPeerHints && entry.leaseReplicaPeerHints.length) ||
      (entry.peerCapabilities && Object.keys(entry.peerCapabilities).length) ||
      entry.writerIssuerPubkey
  );
}

export function configureRelayDiscoveryStore({ storageBase = null, logger = null } = {}) {
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

function getRelayDiscoveryCachePath() {
  return join(resolveStorageBase(), RELAY_DISCOVERY_CACHE_FILENAME);
}

async function loadRelayDiscoveryCache() {
  if (relayDiscoveryLoaded) return;
  relayDiscoveryLoaded = true;

  const path = getRelayDiscoveryCachePath();
  try {
    const payload = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(payload);
    const relays = parsed?.relays && typeof parsed.relays === 'object' ? parsed.relays : parsed;
    if (!relays || typeof relays !== 'object') return;

    for (const [key, entry] of Object.entries(relays)) {
      const normalizedKey = normalizeRelayIdentifier(key);
      if (!normalizedKey) continue;
      const pruned = pruneEntry(entry);
      if (!hasMeaningfulEntry(pruned)) continue;
      relayDiscoveryCache.set(normalizedKey, pruned);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configuredLogger?.warn?.('[Worker] Failed to load relay discovery cache', {
        path,
        error: error?.message || error
      });
    }
  }
}

function scheduleRelayDiscoveryFlush() {
  if (relayDiscoveryFlushTimer) return;
  relayDiscoveryFlushTimer = setTimeout(() => {
    relayDiscoveryFlushTimer = null;
    flushRelayDiscoveryCache().catch((error) => {
      configuredLogger?.warn?.('[Worker] Failed to flush relay discovery cache', {
        error: error?.message || error
      });
    });
  }, 1000);
  relayDiscoveryFlushTimer.unref?.();
}

export async function flushRelayDiscoveryCache(force = false) {
  await loadRelayDiscoveryCache();
  if (!force && !relayDiscoveryDirty) return;
  relayDiscoveryDirty = false;

  const relays = {};
  for (const [key, entry] of relayDiscoveryCache.entries()) {
    const pruned = pruneEntry(entry);
    if (!hasMeaningfulEntry(pruned)) continue;
    relays[key] = pruned;
  }

  const payload = JSON.stringify({ relays }, null, 2);
  await fs.mkdir(resolveStorageBase(), { recursive: true });
  await fs.writeFile(getRelayDiscoveryCachePath(), payload, 'utf8');
}

function buildLookupKeys({ identifier = null, relayKey = null, publicIdentifier = null } = {}) {
  const keys = new Set();
  [identifier, relayKey, publicIdentifier].forEach((value) => {
    const normalized = normalizeRelayIdentifier(value);
    if (normalized) keys.add(normalized);
  });
  return Array.from(keys);
}

async function getMergedEntry(keys = []) {
  await loadRelayDiscoveryCache();
  let merged = null;
  for (const key of keys) {
    const cached = relayDiscoveryCache.get(key);
    if (!cached) continue;
    const pruned = pruneEntry(cached);
    if (!pruned) continue;
    merged = mergeEntries(merged, pruned);
  }
  return merged;
}

async function saveMergedEntry(keys = [], entry = null) {
  if (!entry) return;
  const normalized = pruneEntry(entry);
  if (!normalized) return;
  keys.forEach((key) => {
    if (!key) return;
    relayDiscoveryCache.set(key, normalized);
  });
  relayDiscoveryDirty = true;
  scheduleRelayDiscoveryFlush();
}

export async function getRelayDiscoveryState({ identifier = null, relayKey = null, publicIdentifier = null } = {}) {
  const keys = buildLookupKeys({ identifier, relayKey, publicIdentifier });
  if (!keys.length) return null;
  const merged = await getMergedEntry(keys);
  if (!merged || !hasMeaningfulEntry(merged)) return null;

  return {
    relayKey: merged.relayKey || null,
    publicIdentifier: merged.publicIdentifier || null,
    discoveryTopic: merged.discoveryTopic || null,
    hostPeerKeys: (merged.hostPeerHints || []).map((entry) => entry.peerKey),
    leaseReplicaPeerKeys: (merged.leaseReplicaPeerHints || []).map((entry) => entry.peerKey),
    writerIssuerPubkey: merged.writerIssuerPubkey || null,
    peerCapabilities: merged.peerCapabilities || {},
    lastJoinSuccessAt: merged.lastJoinSuccessAt || null,
    updatedAt: merged.updatedAt || null
  };
}

export async function mergeRelayDiscoveryHints({
  identifier = null,
  relayKey = null,
  publicIdentifier = null,
  discoveryTopic = null,
  hostPeerKeys = null,
  leaseReplicaPeerKeys = null,
  writerIssuerPubkey = null
} = {}) {
  const keys = buildLookupKeys({ identifier, relayKey, publicIdentifier });
  if (!keys.length) return null;

  const existing = await getMergedEntry(keys);
  const now = Date.now();
  const incoming = {
    relayKey: normalizeRelayIdentifier(relayKey) || existing?.relayKey || null,
    publicIdentifier: normalizeRelayIdentifier(publicIdentifier) || existing?.publicIdentifier || null,
    discoveryTopic: typeof discoveryTopic === 'string' ? discoveryTopic.trim() || null : null,
    topicUpdatedAt: typeof discoveryTopic === 'string' && discoveryTopic.trim() ? now : null,
    hostPeerHints: normalizePeerHints(hostPeerKeys || [], now),
    leaseReplicaPeerHints: normalizePeerHints(leaseReplicaPeerKeys || [], now),
    writerIssuerPubkey:
      typeof writerIssuerPubkey === 'string' ? writerIssuerPubkey.trim().toLowerCase() || null : null,
    writerIssuerUpdatedAt:
      typeof writerIssuerPubkey === 'string' && writerIssuerPubkey.trim() ? now : null,
    peerCapabilities: {},
    updatedAt: now
  };

  const merged = mergeEntries(existing, incoming);
  await saveMergedEntry(keys, merged);
  return getRelayDiscoveryState({ identifier, relayKey, publicIdentifier });
}

export async function recordCapabilityProbe({
  identifier = null,
  relayKey = null,
  publicIdentifier = null,
  peerKey = null,
  success = false,
  rttMs = null,
  capabilities = null
} = {}) {
  const normalizedPeerKey = normalizePeerKey(peerKey);
  if (!normalizedPeerKey) return null;

  const keys = buildLookupKeys({ identifier, relayKey, publicIdentifier });
  if (!keys.length) return null;
  const now = Date.now();

  const existing = await getMergedEntry(keys);
  const next = mergeEntries(existing, {
    relayKey: normalizeRelayIdentifier(relayKey) || existing?.relayKey || null,
    publicIdentifier: normalizeRelayIdentifier(publicIdentifier) || existing?.publicIdentifier || null,
    hostPeerHints: [{ peerKey: normalizedPeerKey, seenAt: now }],
    leaseReplicaPeerHints: [],
    peerCapabilities: {
      [normalizedPeerKey]: {
        lastProbeAt: now,
        lastSuccessAt: success ? now : existing?.peerCapabilities?.[normalizedPeerKey]?.lastSuccessAt || null,
        lastFailureAt: success ? null : now,
        rttMs: Number.isFinite(Number(rttMs)) ? Number(rttMs) : null,
        canDirectChallenge: capabilities?.canDirectChallenge === true,
        canProvisionOpenWriter: capabilities?.canProvisionOpenWriter === true,
        hasMatchingLease: capabilities?.hasMatchingLease === true,
        leaseExpiresAt: Number.isFinite(Number(capabilities?.leaseExpiresAt))
          ? Number(capabilities.leaseExpiresAt)
          : null,
        writable: capabilities?.writable === true,
        active: capabilities?.active === true,
        nonce: typeof capabilities?.nonce === 'string' ? capabilities.nonce : null
      }
    },
    updatedAt: now
  });

  await saveMergedEntry(keys, next);
  return getRelayDiscoveryState({ identifier, relayKey, publicIdentifier });
}

export async function recordJoinSuccessPeer({
  identifier = null,
  relayKey = null,
  publicIdentifier = null,
  peerKey = null,
  discoveryTopic = null
} = {}) {
  const normalizedPeerKey = normalizePeerKey(peerKey);
  const keys = buildLookupKeys({ identifier, relayKey, publicIdentifier });
  if (!keys.length) return null;

  const now = Date.now();
  const existing = await getMergedEntry(keys);
  const next = mergeEntries(existing, {
    relayKey: normalizeRelayIdentifier(relayKey) || existing?.relayKey || null,
    publicIdentifier: normalizeRelayIdentifier(publicIdentifier) || existing?.publicIdentifier || null,
    discoveryTopic: typeof discoveryTopic === 'string' ? discoveryTopic.trim() || null : null,
    topicUpdatedAt: typeof discoveryTopic === 'string' && discoveryTopic.trim() ? now : null,
    hostPeerHints: normalizedPeerKey ? [{ peerKey: normalizedPeerKey, seenAt: now }] : [],
    leaseReplicaPeerHints: [],
    peerCapabilities: {},
    lastJoinSuccessAt: now,
    updatedAt: now
  });
  await saveMergedEntry(keys, next);
  return getRelayDiscoveryState({ identifier, relayKey, publicIdentifier });
}

export async function getDiscoveryCandidates({ identifier = null, relayKey = null, publicIdentifier = null } = {}) {
  const state = await getRelayDiscoveryState({ identifier, relayKey, publicIdentifier });
  if (!state) {
    return {
      hostPeerKeys: [],
      leaseReplicaPeerKeys: [],
      successfulProbePeers: []
    };
  }

  const successfulProbePeers = Object.entries(state.peerCapabilities || {})
    .filter(([, capability]) => capability?.lastSuccessAt && capability.lastSuccessAt > 0)
    .sort((left, right) => Number(right[1]?.lastSuccessAt || 0) - Number(left[1]?.lastSuccessAt || 0))
    .map(([peerKey]) => peerKey);

  return {
    hostPeerKeys: state.hostPeerKeys || [],
    leaseReplicaPeerKeys: state.leaseReplicaPeerKeys || [],
    successfulProbePeers
  };
}

export async function pruneRelayDiscoveryState(now = Date.now()) {
  await loadRelayDiscoveryCache();
  let changed = false;
  for (const [key, entry] of relayDiscoveryCache.entries()) {
    const pruned = pruneEntry(entry, now);
    if (!hasMeaningfulEntry(pruned)) {
      relayDiscoveryCache.delete(key);
      changed = true;
      continue;
    }
    const before = JSON.stringify(entry);
    const after = JSON.stringify(pruned);
    if (before !== after) {
      relayDiscoveryCache.set(key, pruned);
      changed = true;
    }
  }

  if (changed) {
    relayDiscoveryDirty = true;
    scheduleRelayDiscoveryFlush();
  }
}

export const RELAY_DISCOVERY_TTLS = {
  capabilityMs: CAPABILITY_TTL_MS,
  peerHintMs: PEER_HINT_TTL_MS,
  topicMs: TOPIC_TTL_MS
};
