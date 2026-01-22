#!/usr/bin/env node
// ./hypertuna-worker/index.js
//
// Enhanced worker with Hyperswarm support instead of hypertele
/** @typedef {import('pear-interface')} */ 
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import nodeCrypto from 'node:crypto'
import swarmCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import HypercoreId from 'hypercore-id-encoding'
import GatewayService from './gateway/GatewayService.mjs'
import {
  getAllRelayProfiles,
  getRelayProfileByKey,
  getRelayProfileByPublicIdentifier,
  saveRelayProfile,
  removeRelayAuth, // <-- NEW IMPORT
  updateRelayMembers, // This is likely not used directly anymore for member_adds/removes
  updateRelayAuthToken, // <-- NEW IMPORT
  updateRelayMemberSets,
  calculateMembers,
  calculateAuthorizedUsers
} from './hypertuna-relay-profile-manager-bare.mjs'
import { loadRelayKeyMappings, activeRelays, virtualRelayKeys, keyToPublic } from './hypertuna-relay-manager-adapter.mjs'
import { getRelayAuthStore } from './relay-auth-store.mjs'
import {
  queuePendingAuthUpdate,
  applyPendingAuthUpdates
} from './pending-auth.mjs';
import {
  initializeHyperdrive,
  initializePfpHyperdrive,
  ensureRelayFolder,
  storeFile,
  getFile,
  fileExists,
  fetchFileFromDrive,
  storePfpFile,
  getPfpFile,
  pfpFileExists,
  fetchPfpFileFromDrive,
  getPfpDriveKey,
  mirrorPfpDrive,
  watchDrive,
  getReplicationHealth,
  getCorestore,
  getRelayCorestore,
  getLocalDrive,
  getPfpDrive
} from './hyperdrive-manager.mjs';
import { ensureMirrorsForProviders, stopAllMirrors } from './mirror-sync-manager.mjs';
import { NostrUtils } from './nostr-utils.js';
import { getRelayKeyFromPublicIdentifier } from './relay-lookup-utils.mjs';
import { loadGatewaySettings, getCachedGatewaySettings, updateGatewaySettings } from '../shared/config/GatewaySettings.mjs'
import {
  loadPublicGatewaySettings,
  updatePublicGatewaySettings,
  getCachedPublicGatewaySettings
} from '../shared/config/PublicGatewaySettings.mjs'
import { createSignature } from '../shared/auth/PublicGatewayTokens.mjs'
import {
  encryptSharedSecretToString,
  decryptSharedSecretFromString
} from './challenge-manager.mjs'
import BlindPeeringManager from './blind-peering-manager.mjs'

const pearRuntime = globalThis?.Pear
const __dirname = process.env.APP_DIR || pearRuntime?.config?.dir || process.cwd()
const defaultStorageDir = process.env.STORAGE_DIR || pearRuntime?.config?.storage || join(process.cwd(), 'data')
const userKey = process.env.USER_KEY || null
const BLIND_PEERING_METADATA_FILENAME = 'blind-peering-metadata.json'
const RELAY_CORE_REFS_CACHE_FILENAME = 'relay-core-refs-cache.json'
const BLIND_PEER_REHYDRATION_TIMEOUT_MS = 60000
const BLIND_PEER_JOIN_REHYDRATION_TIMEOUT_MS = 90000
const BLIND_PEER_REHYDRATION_RETRIES = 1
const BLIND_PEER_REHYDRATION_BACKOFF_MS = 5000
const BLIND_PEER_JOIN_REHYDRATION_RETRIES = 1
const BLIND_PEER_JOIN_REHYDRATION_BACKOFF_MS = 7000
const BLIND_PEER_INVITE_MIRROR_ATTEMPTS = 2
const BLIND_PEER_INVITE_MIRROR_BACKOFF_MS = 3000
const BLIND_PEER_MIRROR_METADATA_REFRESH_MS = 1 * 60 * 1000
const BLIND_PEER_MIRROR_METADATA_TIMEOUT_MS = 8000
const RELAY_WRITER_SYNC_RETRY_TIMEOUT_MS = 30000
const OPEN_JOIN_BOOTSTRAP_TIMEOUT_MS = 8000
const OPEN_JOIN_APPEND_CORES_TIMEOUT_MS = 8000
const OPEN_JOIN_APPEND_CORES_PURPOSE = 'append-cores'

global.userConfig = {
  storage: defaultStorageDir,
  userKey: userKey || null
}

const relayMirrorSubscriptions = new Map()
const relayMirrorCoreRefs = new Map()
const relayMirrorCoreRefsCache = new Map()
const relayMirrorSyncState = new Map()
const relayWriterSyncTasks = new Map()
let lastBlindPeerFingerprint = null
let lastDispatcherAssignmentFingerprint = null
let pendingRelayRegistryRefresh = false
let gatewayWasRunning = false
let lastMirrorMetadataRefreshAt = 0
let mirrorMetadataRefreshInFlight = null
let relayCoreRefsCacheLoaded = false
let relayCoreRefsCacheDirty = false
let relayCoreRefsCacheTimer = null
const openJoinContexts = new Map()
const pendingOpenJoinReauth = new Map()
const OPEN_JOIN_REAUTH_MIN_INTERVAL_MS = 30000
const OPEN_JOIN_POOL_TARGET_SIZE = 8
const OPEN_JOIN_POOL_ENTRY_TTL_MS = 6 * 60 * 60 * 1000
const OPEN_JOIN_POOL_REFRESH_MS = 30 * 60 * 1000
const openJoinWriterPoolCache = new Map()
const openJoinWriterPoolLocks = new Set()

function getGatewayWebsocketProtocol(config) {
  return config?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss'
}

function buildGatewayWebsocketBase(config) {
  const protocol = getGatewayWebsocketProtocol(config)
  const host = config?.proxy_server_address || 'localhost'
  return `${protocol}://${host}`
}

function deriveGatewayHostFromStatus(status) {
  try {
    const hostnameUrl = status?.urls?.hostname ? new URL(status.urls.hostname) : null
    if (hostnameUrl) {
      return {
        httpUrl: `http://${hostnameUrl.host}`,
        proxyHost: hostnameUrl.host,
        wsProtocol: hostnameUrl.protocol === 'wss:' ? 'wss' : 'ws'
      }
    }
  } catch (_) {}
  const port = status?.port || gatewayOptions.port || 8443
  const host = `${gatewayOptions.hostname || '127.0.0.1'}:${port}`
  return {
    httpUrl: `http://${host}`,
    proxyHost: host,
    wsProtocol: 'ws'
  }
}

async function initializeGatewayOptionsFromSettings() {
  try {
    await loadGatewaySettings()
  } catch (error) {
    console.warn('[Worker] Failed to load gateway option defaults:', error)
  }
  gatewayOptions.listenHost = '127.0.0.1'
  gatewayOptions.hostname = gatewayOptions.hostname || '127.0.0.1'
}

function normalizeGatewayPathFragment(fragment) {
  if (typeof fragment !== 'string') return null
  const trimmed = fragment.trim()
  if (!trimmed) return null
  return trimmed.replace(/^\//, '').replace(/\/+$/, '')
}

function normalizeRelayKeyHex(value) {
  const trimmed = typeof value === 'string' ? value.trim() : null
  if (!trimmed || !isHex64(trimmed)) return null
  return trimmed.toLowerCase()
}

function resolveRelayIdentifierPath(identifier) {
  if (!identifier || typeof identifier !== 'string') return null
  return identifier.includes(':') ? identifier.replace(':', '/') : identifier
}

function resolveHostPeersFromGatewayStatus(status, identifier) {
  if (!status || !identifier) return []
  const peerRelayMap = status?.peerRelayMap
  if (!peerRelayMap || typeof peerRelayMap !== 'object') return []
  const localPeerKeyRaw = status?.ownPeerPublicKey || config?.swarmPublicKey || deriveSwarmPublicKey(config)
  const localPeerKey = typeof localPeerKeyRaw === 'string' ? localPeerKeyRaw.trim().toLowerCase() : null
  const candidates = [identifier]
  if (typeof identifier === 'string' && identifier.includes(':')) {
    candidates.push(identifier.replace(':', '/'))
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    const entry = peerRelayMap?.[candidate]
    const peers = Array.isArray(entry?.peers) ? entry.peers : []
    if (!peers.length) continue
    const normalized = peers
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((key) => !localPeerKey || key !== localPeerKey)
    if (normalized.length) return normalized
  }
  return []
}

function normalizeCoreRef(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) {
    try {
      return HypercoreId.encode(value)
    } catch (_) {
      return null
    }
  }
  if (value instanceof Uint8Array) {
    return normalizeCoreRef(Buffer.from(value))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      const decoded = HypercoreId.decode(trimmed)
      return HypercoreId.encode(decoded)
    } catch (_) {
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        try {
          return HypercoreId.encode(Buffer.from(trimmed, 'hex'))
        } catch (_) {
          return null
        }
      }
      return null
    }
  }
  if (value && typeof value === 'object') {
    if (value.key) return normalizeCoreRef(value.key)
    if (value.core) return normalizeCoreRef(value.core)
  }
  return null
}

function decodeCoreRef(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return HypercoreId.decode(trimmed)
    } catch (_) {
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex')
      }
      return null
    }
  }
  if (value && typeof value === 'object') {
    if (value.key) return decodeCoreRef(value.key)
    if (value.core) return decodeCoreRef(value.core)
  }
  return null
}

function normalizeCoreRefList(refs) {
  if (!Array.isArray(refs)) return []
  const seen = new Set()
  const result = []
  for (const ref of refs) {
    const normalized = normalizeCoreRef(ref)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function describeCoreRefCandidate(value) {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    return previewValue(b4a.toString(value, 'hex'), 16)
  }
  if (value instanceof Uint8Array) {
    return previewValue(b4a.toString(Buffer.from(value), 'hex'), 16)
  }
  if (typeof value === 'string') {
    return previewValue(value, 16)
  }
  if (value && typeof value === 'object') {
    if (value.key) return describeCoreRefCandidate(value.key)
    if (value.core) return describeCoreRefCandidate(value.core)
    if (value.publicKey) return previewValue(value.publicKey, 16)
  }
  return previewValue(value, 16)
}

function normalizeCoreRefListWithStats(refs, { context = null, log = null, maxSample = 3 } = {}) {
  const input = Array.isArray(refs) ? refs : []
  const seen = new Set()
  const normalized = []
  const invalidSamples = []
  const duplicateSamples = []
  let invalidCount = 0
  let duplicateCount = 0

  for (const ref of input) {
    const normalizedRef = normalizeCoreRef(ref)
    if (!normalizedRef) {
      invalidCount += 1
      if (invalidSamples.length < maxSample) {
        const sample = describeCoreRefCandidate(ref)
        if (sample) invalidSamples.push(sample)
      }
      continue
    }
    if (seen.has(normalizedRef)) {
      duplicateCount += 1
      if (duplicateSamples.length < maxSample) {
        duplicateSamples.push(previewValue(normalizedRef, 16))
      }
      continue
    }
    seen.add(normalizedRef)
    normalized.push(normalizedRef)
  }

  const inputCount = input.length
  const normalizedCount = normalized.length
  const droppedCount = inputCount - normalizedCount

  if (context && log && (invalidCount > 0 || duplicateCount > 0)) {
    const warn = typeof log.warn === 'function' ? log.warn.bind(log) : console.warn
    warn('[Worker] Core refs normalized with drops', {
      context,
      inputCount,
      normalizedCount,
      invalidCount,
      duplicateCount,
      droppedCount,
      invalidSamples,
      duplicateSamples
    })
  }

  return {
    normalized,
    inputCount,
    normalizedCount,
    invalidCount,
    duplicateCount,
    droppedCount,
    invalidSamples,
    duplicateSamples
  }
}

function mergeCoreRefListsWithStats(lists = [], { context = null, log = null, maxSample = 3 } = {}) {
  const merged = []
  const seen = new Set()
  let inputCount = 0
  let duplicateCount = 0
  const duplicateSamples = []

  const arrays = Array.isArray(lists) ? lists : []
  for (const list of arrays) {
    if (!Array.isArray(list)) continue
    for (const ref of list) {
      if (!ref) continue
      inputCount += 1
      if (seen.has(ref)) {
        duplicateCount += 1
        if (duplicateSamples.length < maxSample) {
          duplicateSamples.push(previewValue(ref, 16))
        }
        continue
      }
      seen.add(ref)
      merged.push(ref)
    }
  }

  if (context && log && duplicateCount > 0) {
    const info = typeof log.info === 'function' ? log.info.bind(log) : console.log
    info('[Worker] Core refs merged with duplicates', {
      context,
      inputCount,
      mergedCount: merged.length,
      duplicateCount,
      duplicateSamples
    })
  }

  return {
    merged,
    inputCount,
    mergedCount: merged.length,
    duplicateCount,
    duplicateSamples
  }
}

function normalizeMirrorCoreRefs(cores) {
  if (!Array.isArray(cores)) return []
  return normalizeCoreRefList(cores)
}

function normalizeOpenJoinCoreEntry(entry) {
  const key = normalizeCoreRef(entry)
  if (!key) return null
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const role = typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim() : null
    return role ? { key, role } : { key }
  }
  return { key }
}

function collectRelayCoreEntriesForAppend(relayManager) {
  const autobase = relayManager?.relay || null
  if (!autobase) return []
  const seen = new Set()
  const entries = []
  const addCore = (candidate, role = null) => {
    const normalized = normalizeOpenJoinCoreEntry(candidate)
    if (!normalized?.key || seen.has(normalized.key)) return
    seen.add(normalized.key)
    if (role) {
      entries.push({ key: normalized.key, role })
    } else {
      entries.push(normalized.role ? normalized : { key: normalized.key })
    }
  }
  const addArray = (arr, prefix) => {
    if (!arr) return
    const list = Array.isArray(arr) ? arr : (arr[Symbol.iterator] ? Array.from(arr) : [])
    list.forEach((entry, index) => addCore(entry?.core || entry, prefix ? `${prefix}-${index}` : null))
  }
  addCore(autobase, 'autobase')
  addCore(autobase?.core, 'autobase-core')
  addCore(autobase?.local || autobase?.local?.core, 'autobase-local')
  addCore(autobase?.localInput || autobase?.localInput?.core, 'autobase-local')
  addCore(autobase?.localWriter || autobase?.localWriter?.core, 'autobase-local')
  addCore(autobase?.defaultWriter || autobase?.defaultWriter?.core, 'autobase-writer')
  addCore(autobase?.view || autobase?.view?.core, 'autobase-view')
  addArray(autobase?.activeWriters, 'autobase-writer')
  addArray(autobase?.writers, 'autobase-writer')
  addArray(Array.isArray(autobase?.inputs) ? autobase.inputs : (autobase?.inputs ? Array.from(autobase.inputs) : []), 'autobase-writer')
  if (autobase?.writer && typeof autobase.writer === 'object') {
    addCore(autobase.writer.core || autobase.writer, 'autobase-writer')
  }
  return entries
}

function mergeCoreRefLists(...lists) {
  const merged = []
  const seen = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const ref of list) {
      if (!ref || seen.has(ref)) continue
      seen.add(ref)
      merged.push(ref)
    }
  }
  return merged
}

function coreRefsFingerprint(coreRefs = []) {
  return Array.isArray(coreRefs) ? coreRefs.join('|') : ''
}

function getRelayCoreRefsCachePath() {
  return join(defaultStorageDir, RELAY_CORE_REFS_CACHE_FILENAME)
}

async function loadRelayCoreRefsCache() {
  if (relayCoreRefsCacheLoaded) return
  relayCoreRefsCacheLoaded = true
  const cachePath = getRelayCoreRefsCachePath()
  try {
    const payload = await fs.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(payload)
    const relays = parsed?.relays && typeof parsed.relays === 'object'
      ? parsed.relays
      : parsed
    if (!relays || typeof relays !== 'object') return
    for (const [relayKey, entry] of Object.entries(relays)) {
      const coreRefs = Array.isArray(entry) ? entry : entry?.coreRefs
      const normalizedStats = normalizeCoreRefListWithStats(coreRefs, {
        context: { phase: 'relay-core-refs-cache-load', relayKey: previewValue(relayKey, 16) },
        log: console
      })
      const normalized = normalizedStats.normalized
      if (!normalized.length) continue
      relayMirrorCoreRefsCache.set(relayKey, normalized)
      const existing = relayMirrorCoreRefs.get(relayKey) || []
      const merged = mergeCoreRefLists(existing, normalized)
      if (merged.length && coreRefsFingerprint(existing) !== coreRefsFingerprint(merged)) {
        relayMirrorCoreRefs.set(relayKey, merged)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[Worker] Failed to load relay core refs cache', {
        path: cachePath,
        error: error?.message || error
      })
    }
  }
}

function scheduleRelayCoreRefsCachePersist() {
  if (relayCoreRefsCacheTimer) return
  relayCoreRefsCacheTimer = setTimeout(() => {
    relayCoreRefsCacheTimer = null
    persistRelayCoreRefsCache().catch((error) => {
      console.warn('[Worker] Failed to persist relay core refs cache', {
        error: error?.message || error
      })
    })
  }, 2000)
  relayCoreRefsCacheTimer.unref?.()
}

async function persistRelayCoreRefsCache(force = false) {
  await loadRelayCoreRefsCache()
  if (!force && !relayCoreRefsCacheDirty) return
  const relays = {}
  let totalInput = 0
  let totalNormalized = 0
  let totalDropped = 0
  for (const [relayKey, coreRefs] of relayMirrorCoreRefs.entries()) {
    const normalizedStats = normalizeCoreRefListWithStats(coreRefs, {
      context: { phase: 'relay-core-refs-cache-persist', relayKey: previewValue(relayKey, 16) },
      log: console
    })
    totalInput += normalizedStats.inputCount
    totalNormalized += normalizedStats.normalizedCount
    totalDropped += normalizedStats.droppedCount
    if (!normalizedStats.normalized.length) continue
    relays[relayKey] = { coreRefs: normalizedStats.normalized }
  }
  if (totalDropped > 0) {
    console.warn('[Worker] Relay core refs cache persist dropped entries', {
      relayCount: Object.keys(relays).length,
      totalInput,
      totalNormalized,
      totalDropped
    })
  }
  const payload = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    relays
  }, null, 2)
  const cachePath = getRelayCoreRefsCachePath()
  try {
    await fs.mkdir(defaultStorageDir, { recursive: true })
    await fs.writeFile(cachePath, payload, 'utf8')
    relayMirrorCoreRefsCache.clear()
    for (const [relayKey, entry] of Object.entries(relays)) {
      relayMirrorCoreRefsCache.set(relayKey, entry.coreRefs)
    }
    relayCoreRefsCacheDirty = false
  } catch (error) {
    console.warn('[Worker] Failed to persist relay core refs cache', {
      path: cachePath,
      error: error?.message || error
    })
  }
}

async function getRelayMirrorCoreRefsCache(relayKey) {
  await loadRelayCoreRefsCache()
  if (!relayKey) return []
  return relayMirrorCoreRefsCache.get(relayKey) || []
}

function updateRelayMirrorCoreRefs(relayKey, coreRefs, { persist = true, context = null } = {}) {
  if (!relayKey || !Array.isArray(coreRefs) || !coreRefs.length) return
  const normalizedStats = normalizeCoreRefListWithStats(coreRefs, {
    context: context
      ? { phase: 'relay-core-refs-update', relayKey: previewValue(relayKey, 16), context }
      : null,
    log: console
  })
  const normalized = normalizedStats.normalized
  if (!normalized.length) return
  const existing = relayMirrorCoreRefs.get(relayKey) || []
  if (coreRefsFingerprint(existing) === coreRefsFingerprint(normalized)) {
    if (context) {
      console.log('[Worker] Relay core refs update skipped', {
        relayKey,
        context,
        existingCount: existing.length,
        normalizedCount: normalized.length
      })
    }
    return
  }
  relayMirrorCoreRefs.set(relayKey, normalized)
  if (context) {
    console.log('[Worker] Relay core refs updated', {
      relayKey,
      context,
      inputCount: normalizedStats.inputCount,
      normalizedCount: normalizedStats.normalizedCount,
      droppedCount: normalizedStats.droppedCount,
      existingCount: existing.length,
      nextCount: normalized.length,
      added: Math.max(normalized.length - existing.length, 0),
      removed: Math.max(existing.length - normalized.length, 0),
      coreRefsPreview: summarizeCoreRefs(normalized)
    })
  }
  if (persist) {
    relayCoreRefsCacheDirty = true
    scheduleRelayCoreRefsCachePersist()
  }
}

async function resolveRelayMirrorCoreRefs(
  relayKey,
  publicIdentifier = null,
  fallbackRefs = [],
  { context = null } = {}
) {
  const fallbackStats = normalizeCoreRefListWithStats(fallbackRefs, {
    context: context
      ? { phase: 'relay-core-refs-fallback', relayKey: previewValue(relayKey, 16), context }
      : null,
    log: console
  })
  const normalizedFallback = fallbackStats.normalized
  await loadRelayCoreRefsCache()
  const cachedRefs = relayKey ? (relayMirrorCoreRefsCache.get(relayKey) || []) : []
  const cachedStats = normalizeCoreRefListWithStats(cachedRefs, {
    context: context
      ? { phase: 'relay-core-refs-cache', relayKey: previewValue(relayKey, 16), context }
      : null,
    log: console
  })
  const normalizedCached = cachedStats.normalized
  if (relayKey && relayMirrorCoreRefs.has(relayKey)) {
    const cached = relayMirrorCoreRefs.get(relayKey) || []
    const liveStats = normalizeCoreRefListWithStats(cached, {
      context: context
        ? { phase: 'relay-core-refs-live', relayKey: previewValue(relayKey, 16), context }
        : null,
      log: console
    })
    const mergeStats = mergeCoreRefListsWithStats(
      [normalizedCached, liveStats.normalized, normalizedFallback],
      {
        context: context
          ? { phase: 'relay-core-refs-merge', relayKey: previewValue(relayKey, 16), context, source: 'cache' }
          : null,
        log: console
      }
    )
    updateRelayMirrorCoreRefs(relayKey, mergeStats.merged, {
      context: context ? `${context}-resolve-cache` : null
    })
    if (context) {
      console.log('[Worker] Relay core refs resolved from cache', {
        relayKey,
        publicIdentifier,
        context,
        cachedCount: normalizedCached.length,
        liveCount: liveStats.normalized.length,
        fallbackCount: normalizedFallback.length,
        mergedCount: mergeStats.merged.length
      })
    }
    return mergeStats.merged
  }

  let profile = null
  if (relayKey) {
    profile = await getRelayProfileByKey(relayKey)
  }
  if (!profile && publicIdentifier) {
    profile = await getRelayProfileByPublicIdentifier(publicIdentifier)
  }
  if (context && !profile) {
    console.warn('[Worker] Relay core refs profile missing', {
      relayKey,
      publicIdentifier,
      context
    })
  }
  const storedStats = normalizeCoreRefListWithStats(profile?.core_refs || profile?.coreRefs, {
    context: context
      ? { phase: 'relay-core-refs-profile', relayKey: previewValue(relayKey, 16), context }
      : null,
    log: console
  })
  const mergeStats = mergeCoreRefListsWithStats(
    [normalizedCached, storedStats.normalized, normalizedFallback],
    {
      context: context
        ? { phase: 'relay-core-refs-merge', relayKey: previewValue(relayKey, 16), context, source: 'profile' }
        : null,
      log: console
    }
  )
  updateRelayMirrorCoreRefs(relayKey, mergeStats.merged, {
    context: context ? `${context}-resolve-profile` : null
  })
  if (context) {
    console.log('[Worker] Relay core refs resolved from profile', {
      relayKey,
      publicIdentifier,
      context,
      cachedCount: normalizedCached.length,
      storedCount: storedStats.normalized.length,
      fallbackCount: normalizedFallback.length,
      mergedCount: mergeStats.merged.length
    })
  }
  return mergeStats.merged
}

function bufferListHas(buffers, candidate) {
  if (!candidate || !Array.isArray(buffers)) return false
  return buffers.some((entry) => entry && b4a.equals(entry, candidate))
}

function relayHasWriter(activeWriters, candidate) {
  if (!candidate || !activeWriters) return false
  if (typeof activeWriters.has === 'function') {
    try {
      return activeWriters.has(candidate)
    } catch (_) {
      // fall through to manual scan
    }
  }
  const iterable = Array.isArray(activeWriters) ? activeWriters : activeWriters[Symbol.iterator] ? activeWriters : []
  for (const writer of iterable) {
    const key = writer?.core?.key || writer
    if (key && b4a.equals(key, candidate)) return true
  }
  return false
}

function collectRelaySkipKeys(relay) {
  const skip = []
  const pushKey = (value) => {
    const decoded = decodeCoreRef(value)
    if (decoded) skip.push(decoded)
  }
  if (!relay) return skip
  pushKey(relay.view?.core?.key || relay.view?.key)
  pushKey(relay.core?.key)
  pushKey(relay.key)
  pushKey(relay.local?.core?.key || relay.local?.key)
  pushKey(relay.localWriter?.core?.key)
  if (Array.isArray(relay.viewCores)) {
    relay.viewCores.forEach((core) => {
      pushKey(core?.core?.key || core?.key || core)
    })
  }
  return skip
}

async function ensureRelayWritersFromCoreRefs(relayManager, coreRefs, reason = 'mirror-update') {
  const relay = relayManager?.relay
  if (!relay || typeof relayManager?.addWriter !== 'function') {
    return { status: 'skipped', reason: 'relay-unavailable' }
  }
  const normalized = normalizeCoreRefList(coreRefs)
  if (!normalized.length) {
    return { status: 'skipped', reason: 'no-core-refs' }
  }
  if (relay.writable === false) {
    return {
      status: 'read-only',
      reason: 'relay-not-writable',
      added: 0,
      skipped: normalized.length,
      failed: 0
    }
  }

  try {
    if (typeof relay.update === 'function') {
      try {
        await relay.update({ wait: true })
      } catch (_) {
        await relay.update()
      }
    }
  } catch (error) {
    console.warn('[Worker] Relay update failed before writer sync', {
      relayKey: relayManager?.bootstrap || null,
      reason,
      error: error?.message || error
    })
  }

  const skipKeys = collectRelaySkipKeys(relay)
  const activeWriters = relay.activeWriters || []
  const summary = {
    status: 'ok',
    added: 0,
    skipped: 0,
    failed: 0
  }

  for (const ref of normalized) {
    const decoded = decodeCoreRef(ref)
    if (!decoded) {
      summary.failed += 1
      continue
    }
    if (bufferListHas(skipKeys, decoded) || relayHasWriter(activeWriters, decoded)) {
      summary.skipped += 1
      continue
    }
    try {
      const writerHex = b4a.toString(decoded, 'hex')
      await relayManager.addWriter(writerHex)
      summary.added += 1
    } catch (error) {
      summary.failed += 1
      console.warn('[Worker] Failed to add writer from mirror core refs', {
        relayKey: relayManager?.bootstrap || null,
        writer: ref.slice(0, 16),
        reason,
        error: error?.message || error
      })
    }
  }

  if (summary.added && typeof relay.update === 'function') {
    try {
      await relay.update({ wait: true })
    } catch (_) {
      try {
        await relay.update()
      } catch (error) {
        console.warn('[Worker] Relay update failed after writer sync', {
          relayKey: relayManager?.bootstrap || null,
          reason,
          error: error?.message || error
        })
      }
    }
  }

  return summary
}

function scheduleRelayWriterSyncOnWritable({
  relayKey,
  publicIdentifier = null,
  coreRefs = [],
  reason = 'mirror-update',
  timeoutMs = RELAY_WRITER_SYNC_RETRY_TIMEOUT_MS
} = {}) {
  if (!relayKey) return { status: 'skipped', reason: 'missing-relay-key' }
  const normalized = normalizeCoreRefList(coreRefs)
  if (!normalized.length) return { status: 'skipped', reason: 'no-core-refs' }

  if (relayWriterSyncTasks.has(relayKey)) {
    console.log('[Worker] Relay writer sync retry already scheduled', {
      relayKey,
      publicIdentifier,
      reason
    })
    return { status: 'skipped', reason: 'already-scheduled' }
  }

  const relayManager = activeRelays.get(relayKey)
  const relay = relayManager?.relay
  if (!relay) {
    return { status: 'skipped', reason: 'relay-unavailable' }
  }

  let timeoutId = null
  let inFlight = false

  const cleanup = (finalReason = 'complete') => {
    if (timeoutId) clearTimeout(timeoutId)
    if (typeof relay.off === 'function') {
      relay.off('writable', onWritable)
      relay.off('update', onUpdate)
    } else if (typeof relay.removeListener === 'function') {
      relay.removeListener('writable', onWritable)
      relay.removeListener('update', onUpdate)
    }
    relayWriterSyncTasks.delete(relayKey)
    console.log('[Worker] Relay writer sync retry cleared', {
      relayKey,
      publicIdentifier,
      reason,
      finalReason
    })
  }

  const attempt = async (trigger) => {
    if (inFlight) return
    if (!relayManager?.relay?.writable) return
    inFlight = true
    try {
      const summary = await ensureRelayWritersFromCoreRefs(
        relayManager,
        normalized,
        `${reason}-retry-${trigger}`
      )
      console.log('[Worker] Relay writer sync retry result', {
        relayKey,
        publicIdentifier,
        reason,
        trigger,
        status: summary?.status ?? null,
        added: summary?.added ?? 0,
        skipped: summary?.skipped ?? 0,
        failed: summary?.failed ?? 0
      })
      if (summary?.status === 'ok') {
        if (summary.added > 0 && typeof global.requestRelaySubscriptionRefresh === 'function') {
          try {
            const refreshSummary = await global.requestRelaySubscriptionRefresh({
              relayKey,
              reason: `${reason}-writer-sync`
            })
            console.log('[Worker] Subscription refresh scheduled after writer sync retry', {
              relayKey,
              status: refreshSummary?.status ?? null,
              updated: refreshSummary?.updated ?? null,
              failed: refreshSummary?.failed ?? null
            })
          } catch (error) {
            console.warn('[Worker] Subscription refresh after writer sync retry failed', {
              relayKey,
              error: error?.message || error
            })
          }
        }
        cleanup('resolved')
      }
    } catch (error) {
      console.warn('[Worker] Relay writer sync retry failed', {
        relayKey,
        publicIdentifier,
        reason,
        trigger,
        error: error?.message || error
      })
    } finally {
      inFlight = false
    }
  }

  const onWritable = () => attempt('writable')
  const onUpdate = () => attempt('update')

  if (typeof relay.on === 'function') {
    relay.on('writable', onWritable)
    relay.on('update', onUpdate)
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      console.warn('[Worker] Relay writer sync retry timed out', {
        relayKey,
        publicIdentifier,
        reason,
        timeoutMs
      })
      cleanup('timeout')
    }, timeoutMs)
  }

  relayWriterSyncTasks.set(relayKey, {
    relayKey,
    publicIdentifier,
    reason,
    startedAt: Date.now(),
    timeoutMs
  })

  console.log('[Worker] Scheduled relay writer sync retry', {
    relayKey,
    publicIdentifier,
    reason,
    timeoutMs,
    coreRefsCount: normalized.length,
    coreRefsPreview: summarizeCoreRefs(normalized)
  })

  return { status: 'scheduled', relayKey }
}

async function syncActiveRelayCoreRefs({
  relayKey,
  publicIdentifier = null,
  coreRefs = [],
  reason = 'mirror-update'
} = {}) {
  const normalizedStats = normalizeCoreRefListWithStats(coreRefs, {
    context: { phase: 'sync-active-core-refs', relayKey: previewValue(relayKey, 16), reason },
    log: console
  })
  const normalized = normalizedStats.normalized
  if (!relayKey || !normalized.length) {
    return { status: 'skipped', reason: 'missing-core-refs' }
  }

  updateRelayMirrorCoreRefs(relayKey, normalized, { context: 'sync-active-core-refs' })
  const fingerprint = coreRefsFingerprint(normalized)
  if (relayMirrorSyncState.get(relayKey) === fingerprint) {
    return { status: 'skipped', reason: 'already-synced' }
  }

  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    return { status: 'skipped', reason: 'relay-not-active' }
  }

  const manager = await ensureBlindPeeringManager()
  if (!manager?.started) {
    return { status: 'skipped', reason: 'blind-peering-unavailable' }
  }

  const identifier = publicIdentifier || relayManager?.publicIdentifier || null
  const relayCorestore = relayManager?.store || null
  manager.ensureRelayMirror({
    relayKey,
    publicIdentifier: identifier,
    autobase: relayManager.relay,
    coreRefs: normalized,
    corestore: relayCorestore
  })

  let primeSummary = null
  if (typeof manager.primeRelayCoreRefs === 'function') {
    primeSummary = await manager.primeRelayCoreRefs({
      relayKey,
      publicIdentifier: identifier,
      coreRefs: normalized,
      timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
      reason,
      corestore: relayCorestore
    })
  }

  const rehydrateSummary = await rehydrateMirrorsWithRetry(manager, {
    reason,
    timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
    retries: BLIND_PEER_REHYDRATION_RETRIES,
    backoffMs: BLIND_PEER_REHYDRATION_BACKOFF_MS
  })

  const writerSummary = await ensureRelayWritersFromCoreRefs(relayManager, normalized, reason)

  if (writerSummary?.status === 'read-only') {
    console.warn('[Worker] Relay writer sync deferred (read-only)', {
      relayKey,
      publicIdentifier: identifier,
      reason,
      coreRefsCount: normalized.length,
      coreRefsPreview: summarizeCoreRefs(normalized)
    })
    scheduleRelayWriterSyncOnWritable({
      relayKey,
      publicIdentifier: identifier,
      coreRefs: normalized,
      reason
    })
  }

  if (writerSummary?.status === 'ok' || writerSummary?.status === 'read-only') {
    relayMirrorSyncState.set(relayKey, fingerprint)
  }
  return { status: 'ok', primeSummary, rehydrateSummary, writerSummary }
}

function sanitizeBlindPeerMeta(blindPeer) {
  if (!blindPeer || typeof blindPeer !== 'object') return null
  const entry = {}
  if (blindPeer.publicKey) entry.publicKey = String(blindPeer.publicKey)
  if (blindPeer.encryptionKey) entry.encryptionKey = String(blindPeer.encryptionKey)
  if (blindPeer.replicationTopic) entry.replicationTopic = String(blindPeer.replicationTopic)
  if (Number.isFinite(blindPeer.maxBytes)) entry.maxBytes = blindPeer.maxBytes
  return Object.keys(entry).length ? entry : null
}

function blindPeerFingerprint(blindPeer) {
  if (!blindPeer || typeof blindPeer !== 'object') return ''
  const maxBytes = Number.isFinite(blindPeer.maxBytes) ? String(blindPeer.maxBytes) : ''
  return [
    blindPeer.publicKey || '',
    blindPeer.encryptionKey || '',
    blindPeer.replicationTopic || '',
    maxBytes
  ].join('|')
}

function normalizeHttpOrigin(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin
  } catch (_) {
    return null
  }
}

function collectPublicGatewayOrigins() {
  const origins = new Set()
  const addOrigin = (candidate) => {
    const origin = normalizeHttpOrigin(candidate)
    if (origin) origins.add(origin)
  }

  const settings = publicGatewaySettings || {}
  addOrigin(settings.preferredBaseUrl)
  addOrigin(settings.baseUrl)
  addOrigin(settings.resolvedWsUrl)
  addOrigin(publicGatewayStatusCache?.wsBase)

  if (origins.size === 0) {
    origins.add('https://hypertuna.com')
  }

  return Array.from(origins)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function rehydrateMirrorsWithRetry(manager, {
  reason = 'manual',
  timeoutMs,
  retries = 0,
  backoffMs = 0
} = {}) {
  if (!manager?.rehydrateMirrors) {
    return { status: 'skipped', reason: 'rehydration-unavailable', synced: 0, failed: 0 }
  }
  let attempt = 0
  let summary = await manager.rehydrateMirrors({ reason, timeoutMs })
  while (summary?.failed > 0 && attempt < retries) {
    const waitMs = backoffMs * Math.pow(2, attempt)
    if (waitMs > 0) {
      console.warn('[Worker] Mirror rehydration retry scheduled', {
        reason,
        failed: summary?.failed ?? null,
        attempt: attempt + 1,
        waitMs
      })
      await delay(waitMs)
    }
    summary = await manager.rehydrateMirrors({
      reason: `${reason}-retry-${attempt + 1}`,
      timeoutMs: timeoutMs ? Math.round(timeoutMs * 1.5) : timeoutMs
    })
    attempt += 1
  }
  return summary
}

async function ensureBlindPeerMirrorReady(manager, {
  relayKey = null,
  publicIdentifier = null,
  coreRefs = [],
  corestore = null,
  reason = 'mirror-ready',
  attempts = BLIND_PEER_INVITE_MIRROR_ATTEMPTS,
  backoffMs = BLIND_PEER_INVITE_MIRROR_BACKOFF_MS
} = {}) {
  if (!manager?.getRelayMirrorSyncSummary) {
    return { status: 'skipped', reason: 'mirror-check-unavailable', ready: false }
  }

  let lastSummary = null
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    lastSummary = manager.getRelayMirrorSyncSummary({
      relayKey,
      publicIdentifier,
      coreRefs,
      corestore,
      requirePeers: false
    })
    if (!lastSummary || lastSummary.status !== 'ok') {
      return {
        status: lastSummary?.status || 'error',
        reason: lastSummary?.reason || 'mirror-check-failed',
        ready: false,
        summary: lastSummary
      }
    }

    const ready = lastSummary.missing === 0 && lastSummary.notReady === 0
    if (ready) {
      return { status: 'ok', ready: true, summary: lastSummary }
    }

    if (attempt >= attempts) break

    console.warn('[Worker] Blind-peer mirror incomplete; retry scheduled', {
      relayKey,
      publicIdentifier,
      attempt: attempt + 1,
      missing: lastSummary.missing,
      notReady: lastSummary.notReady,
      total: lastSummary.total
    })

    if (manager?.primeRelayCoreRefs) {
      await manager.primeRelayCoreRefs({
        relayKey,
        publicIdentifier,
        coreRefs,
        corestore,
        timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
        reason: `${reason}-prime-${attempt + 1}`
      })
    }

    if (manager?.refreshFromBlindPeers) {
      await manager.refreshFromBlindPeers(`${reason}-refresh-${attempt + 1}`)
    }

    await rehydrateMirrorsWithRetry(manager, {
      reason: `${reason}-rehydrate-${attempt + 1}`,
      timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
      retries: BLIND_PEER_REHYDRATION_RETRIES,
      backoffMs: BLIND_PEER_REHYDRATION_BACKOFF_MS
    })

    const waitMs = backoffMs * Math.pow(2, attempt)
    if (waitMs > 0) {
      await delay(waitMs)
    }
  }

  return {
    status: 'incomplete',
    reason: 'mirror-not-ready',
    ready: false,
    summary: lastSummary
  }
}

function pruneOpenJoinPoolEntries(entries = [], now = Date.now()) {
  return entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (!entry.writerCore || !entry.writerSecret) return false
    if (entry.expiresAt && entry.expiresAt <= now) return false
    return true
  })
}

function previewValue(value, limit = 16) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : String(value)
  if (!text) return null
  return text.length > limit ? text.slice(0, limit) : text
}

function summarizeOpenJoinEntries(entries = [], limit = 3) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  return entries.slice(0, limit).map((entry) => ({
    writerCore: previewValue(entry?.writerCore, 16),
    writerCoreHex: previewValue(entry?.writerCoreHex || entry?.autobaseLocal, 16),
    issuedAt: entry?.issuedAt ?? null,
    expiresAt: entry?.expiresAt ?? null
  }))
}

function summarizeCoreRefs(coreRefs = [], limit = 3) {
  if (!Array.isArray(coreRefs) || coreRefs.length === 0) return []
  return coreRefs.slice(0, limit).map((ref) => previewValue(ref, 16))
}

function normalizeInviteProof(inviteProof) {
  if (!inviteProof || typeof inviteProof !== 'object') return null
  const payload = inviteProof.payload && typeof inviteProof.payload === 'object'
    ? inviteProof.payload
    : null
  const signature = typeof inviteProof.signature === 'string' ? inviteProof.signature : null
  if (!payload || !signature) return null
  return { payload, signature, scheme: inviteProof.scheme || null }
}

function serializeInviteProof(inviteProof) {
  const normalized = normalizeInviteProof(inviteProof)
  if (!normalized) return null
  try {
    return Buffer.from(JSON.stringify(normalized)).toString('base64url')
  } catch (_err) {
    return null
  }
}

async function ensureOpenJoinWriterPool({
  relayKey,
  publicIdentifier,
  needed = null,
  targetSize = OPEN_JOIN_POOL_TARGET_SIZE,
  mode = 'provision',
  inviteOnly = false
} = {}) {
  const normalizedRelayKey = normalizeRelayKeyHex(relayKey)
  const normalizedPublicIdentifier = typeof publicIdentifier === 'string' ? publicIdentifier.trim() : null
  const fallbackIdentifier = typeof relayKey === 'string' ? relayKey.trim() : null
  const requestIdentifier = normalizedRelayKey || normalizedPublicIdentifier || fallbackIdentifier
  if (!requestIdentifier) return null

  const resolvedTarget = Number.isFinite(targetSize) && targetSize > 0
    ? Math.trunc(targetSize)
    : OPEN_JOIN_POOL_TARGET_SIZE
  const requestedCount = Number.isFinite(needed) ? Math.max(Math.trunc(needed), 0) : null

  console.info('[Worker] Open join pool request', {
    requestIdentifier,
    relayKey: normalizedRelayKey || relayKey || null,
    publicIdentifier: normalizedPublicIdentifier || publicIdentifier || null,
    mode,
    inviteOnly: inviteOnly === true,
    requestedCount,
    targetSize: resolvedTarget
  })

  let profile = null
  if (normalizedRelayKey) {
    profile = await getRelayProfileByKey(normalizedRelayKey)
  }
  const lookupPublicIdentifier = normalizedPublicIdentifier || (normalizedRelayKey ? null : fallbackIdentifier)
  if (!profile && lookupPublicIdentifier) {
    profile = await getRelayProfileByPublicIdentifier(lookupPublicIdentifier)
  }

  const canonicalRelayKey = normalizeRelayKeyHex(profile?.relay_key || profile?.relayKey || null) || normalizedRelayKey
  const canonicalPublicIdentifier =
    profile?.public_identifier || profile?.publicIdentifier || normalizedPublicIdentifier || null
  const poolKey = canonicalRelayKey || canonicalPublicIdentifier || requestIdentifier

  console.info('[Worker] Open join pool resolved', {
    requestIdentifier,
    canonicalRelayKey: previewValue(canonicalRelayKey, 16),
    canonicalPublicIdentifier,
    poolKey: previewValue(poolKey, 16),
    profileRelayKey: previewValue(profile?.relay_key || profile?.relayKey || null, 16),
    profilePublicIdentifier: profile?.public_identifier || profile?.publicIdentifier || null,
    profileIsOpen: profile?.isOpen ?? null,
    profileIsHosted: profile?.isHosted ?? null,
    profileIsJoined: profile?.isJoined ?? null
  })

  if (canonicalRelayKey && requestIdentifier !== canonicalRelayKey) {
    console.info('[Worker] Open join pool canonicalized', {
      requestIdentifier,
      canonicalRelayKey,
      publicIdentifier: canonicalPublicIdentifier
    })
  }

  if (mode === 'target-only') {
    return {
      targetSize: resolvedTarget,
      relayKey: canonicalRelayKey || normalizedRelayKey || null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null
    }
  }
  if (!relayServer?.provisionWriterForInvitee) return null
  if (openJoinWriterPoolLocks.has(poolKey)) {
    console.warn('[Worker] Open join pool skipped: lock active', {
      poolKey: previewValue(poolKey, 16),
      relayKey: previewValue(canonicalRelayKey || normalizedRelayKey || relayKey || null, 16),
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null
    })
    return null
  }

  openJoinWriterPoolLocks.add(poolKey)
  try {
    const relayKeyForLog = canonicalRelayKey || normalizedRelayKey || null
    const publicIdentifierForLog = canonicalPublicIdentifier || normalizedPublicIdentifier || null
    if (!profile) {
      console.warn('[Worker] Open join pool skipped: profile not found', {
        relayKey: relayKey || null,
        publicIdentifier: publicIdentifier || null
      })
      return null
    }
    const isOpen = profile.isOpen === true
    const isClosed = profile.isOpen === false
    const allowInviteOnly = inviteOnly === true && isClosed
    if (!isOpen && !allowInviteOnly) {
      console.warn('[Worker] Open join pool skipped: relay not open', {
        relayKey: relayKeyForLog || null,
        publicIdentifier: publicIdentifierForLog || null,
        isOpen: profile.isOpen,
        inviteOnly
      })
      return null
    }

    const now = Date.now()
    const cached = openJoinWriterPoolCache.get(poolKey) || { entries: [], updatedAt: 0 }
    const entries = pruneOpenJoinPoolEntries(cached.entries, now)
    const stale = !cached.updatedAt || (now - cached.updatedAt) >= OPEN_JOIN_POOL_REFRESH_MS
    const poolNeeded = Math.max(resolvedTarget - entries.length, 0)
    const generateCount = requestedCount !== null
      ? requestedCount
      : (poolNeeded > 0 ? poolNeeded : (stale ? 1 : 0))

    console.log('[Worker] Open join pool status', {
      poolKey: previewValue(poolKey, 16),
      relayKey: relayKeyForLog ? previewValue(relayKeyForLog, 16) : null,
      publicIdentifier: publicIdentifierForLog,
      cachedTotal: Array.isArray(cached.entries) ? cached.entries.length : 0,
      cachedValid: entries.length,
      cachedUpdatedAt: cached.updatedAt || null,
      stale,
      requestedCount,
      poolNeeded,
      generateCount,
      targetSize: resolvedTarget
    })

    if (generateCount <= 0) {
      if (cached.entries.length !== entries.length) {
        openJoinWriterPoolCache.set(poolKey, { ...cached, entries })
      }
      console.log('[Worker] Open join pool warm', {
        relayKey: relayKeyForLog,
        publicIdentifier: publicIdentifierForLog,
        cached: entries.length,
        updatedAt: cached.updatedAt || null
      })
      return {
        entries: [],
        updatedAt: cached.updatedAt || null,
        targetSize: resolvedTarget,
        relayKey: canonicalRelayKey || normalizedRelayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null
      }
    }

    const newEntries = []
    for (let i = 0; i < generateCount; i += 1) {
      const provision = await relayServer.provisionWriterForInvitee({
        relayKey: canonicalRelayKey || relayKey,
        publicIdentifier: canonicalPublicIdentifier || publicIdentifier
      })
      const writerCore = provision?.writerCore || null
      const writerCoreHex = provision?.writerCoreHex || provision?.autobaseLocal || null
      const writerSecret = provision?.writerSecret || null
      if (!writerCore || !writerSecret) continue
      const issuedAt = Date.now()
      const expiresAt = issuedAt + OPEN_JOIN_POOL_ENTRY_TTL_MS
      const entry = {
        writerCore,
        writerCoreHex,
        autobaseLocal: writerCoreHex,
        writerSecret,
        issuedAt,
        expiresAt
      }
      entries.push(entry)
      newEntries.push(entry)
    }

    if (!newEntries.length) {
      openJoinWriterPoolCache.set(poolKey, { ...cached, entries })
      console.warn('[Worker] Open join pool provisioned empty', {
        relayKey: relayKeyForLog ? previewValue(relayKeyForLog, 16) : null,
        publicIdentifier: publicIdentifierForLog,
        requestedCount: generateCount,
        cached: entries.length
      })
      return {
        entries: [],
        updatedAt: cached.updatedAt || null,
        targetSize: resolvedTarget,
        relayKey: canonicalRelayKey || normalizedRelayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null
      }
    }

    const updatedAt = Date.now()
    openJoinWriterPoolCache.set(poolKey, { entries, updatedAt })
    console.log('[Worker] Open join pool provisioned', {
      relayKey: relayKeyForLog,
      publicIdentifier: publicIdentifierForLog,
      generated: newEntries.length,
      cached: entries.length,
      updatedAt,
      entryPreview: summarizeOpenJoinEntries(newEntries)
    })
    if (newEntries.length) {
      const mirrorRelayKey = canonicalRelayKey || normalizedRelayKey || null
      appendOpenJoinMirrorCores({
        relayKey: mirrorRelayKey,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null,
        relayManager: mirrorRelayKey ? activeRelays.get(mirrorRelayKey) : null,
        reason: 'open-join-pool'
      }).catch((error) => {
        console.warn('[Worker] Open join pool mirror append failed', {
          relayKey: relayKeyForLog ? previewValue(relayKeyForLog, 16) : null,
          publicIdentifier: publicIdentifierForLog,
          error: error?.message || error
        })
      })
    }
    return {
      entries: newEntries,
      updatedAt,
      targetSize: resolvedTarget,
      relayKey: canonicalRelayKey || normalizedRelayKey || null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null
    }
  } catch (error) {
    console.warn('[Worker] Failed to provision open-join writer pool', {
      relayKey: relayKey || null,
      publicIdentifier: publicIdentifier || null,
      error: error?.message || error
    })
    return null
  } finally {
    openJoinWriterPoolLocks.delete(poolKey)
  }
}

async function buildGatewayRelayMetadataSnapshot(precomputedRelays = null) {
  if (!relayServer?.getActiveRelays) {
    return { entries: [], relayCount: 0 }
  }

  try {
    const activeRelays = Array.isArray(precomputedRelays)
      ? precomputedRelays
      : await relayServer.getActiveRelays()

    const entries = []

    for (const relay of activeRelays) {
      if (!relay) continue
      const {
        relayKey,
        publicIdentifier,
        name,
        description,
        connectionUrl,
        createdAt,
        isActive = true,
        isOpen,
        isHosted,
        isJoined
      } = relay

      const isPublic = typeof relay.isPublic === 'boolean' ? relay.isPublic : isActive !== false

      const primaryIdentifier = publicIdentifier || relayKey
      if (!primaryIdentifier) continue

      const gatewayPath = normalizeGatewayPathFragment(resolveRelayIdentifierPath(primaryIdentifier))
      const effectiveConnectionUrl = connectionUrl || `${buildGatewayWebsocketBase(config)}/${gatewayPath || primaryIdentifier}`

      const baseMetadata = {
        identifier: primaryIdentifier,
        name,
        description,
        gatewayPath: gatewayPath || normalizeGatewayPathFragment(primaryIdentifier),
        connectionUrl: effectiveConnectionUrl,
        isPublic,
        isOpen: isOpen === true,
        isHosted: isHosted === true ? true : isHosted === false ? false : undefined,
        isJoined: isJoined === true ? true : isJoined === false ? false : undefined,
        metadataUpdatedAt: createdAt || null
      }

      const aliasSet = new Set()
      if (relayKey && relayKey !== primaryIdentifier) {
        const normalizedAlias = normalizeGatewayPathFragment(relayKey)
        if (normalizedAlias) {
          aliasSet.add(normalizedAlias)
        }
      }

      if (aliasSet.size > 0) {
        baseMetadata.pathAliases = Array.from(aliasSet)
      }

      entries.push(baseMetadata)

      if (relayKey && relayKey !== primaryIdentifier) {
        const aliasPath = normalizeGatewayPathFragment(relayKey)
        const aliasConnectionUrl = `${buildGatewayWebsocketBase(config)}/${aliasPath || relayKey}`
        const aliasMetadata = {
          identifier: relayKey,
          name,
          description,
          gatewayPath: aliasPath || relayKey,
          connectionUrl: aliasConnectionUrl,
          isPublic,
          isOpen: isOpen === true,
          isHosted: isHosted === true ? true : isHosted === false ? false : undefined,
          isJoined: isJoined === true ? true : isJoined === false ? false : undefined,
          metadataUpdatedAt: createdAt || null,
          pathAliases: gatewayPath ? [gatewayPath] : []
        }
        entries.push(aliasMetadata)
      }
    }

    return { entries, relayCount: activeRelays.length }
  } catch (error) {
    console.warn('[Worker] Failed to enumerate relays for gateway sync:', error?.message || error)
    return { entries: [], relayCount: 0 }
  }
}

async function syncGatewayPeerMetadata(reason = 'unspecified', options = {}) {
  if (!config?.nostr_pubkey_hex || !config?.swarmPublicKey || !config?.pfpDriveKey) {
    pendingGatewayMetadataSync = true
    return
  }
  if (!gatewayService) {
    pendingGatewayMetadataSync = true
    return
  }

  try {
    const { relays: precomputedRelays } = options
    const { entries, relayCount } = await buildGatewayRelayMetadataSnapshot(precomputedRelays)

    await gatewayService.registerPeerMetadata({
      publicKey: config.swarmPublicKey,
      nostrPubkeyHex: config.nostr_pubkey_hex,
      pfpDriveKey: config.pfpDriveKey,
      mode: 'hyperswarm',
      address: config.proxy_server_address || `${gatewayOptions.hostname || '127.0.0.1'}:${gatewayOptions.port || 8443}`,
      relays: entries
    }, { source: reason, skipConnect: true })
    pendingGatewayMetadataSync = false
    console.log('[Worker] Synced gateway peer metadata', {
      reason,
      owner: config.nostr_pubkey_hex.slice(0, 8),
      pfpDriveKey: config.pfpDriveKey.slice(0, 8),
      relayCount,
      aliasEntries: Math.max(entries.length - relayCount, 0)
    })
  } catch (error) {
    pendingGatewayMetadataSync = true
    console.warn('[Worker] Failed to sync gateway peer metadata:', error?.message || error)
  }
}

async function refreshGatewayRelayRegistry(reason = 'gateway-refresh', options = {}) {
  const reasonText = typeof reason === 'string' ? reason : 'unspecified'
  const triggerCategory = reasonText.includes('gateway')
    ? 'gateway-restart'
    : (reasonText.includes('relay-writable') || reasonText.includes('relay-joined'))
      ? 'join-flow'
      : 'other'
  const triggerDetail = reasonText.includes('direct-join')
    ? 'direct-join'
    : reasonText.includes('blind-peer')
      ? 'blind-peer'
      : triggerCategory

  console.log('[Worker] refreshGatewayRelayRegistry triggered', {
    reason: reasonText,
    category: triggerCategory,
    detail: triggerDetail
  })

  if (!relayServer?.getActiveRelays) {
    pendingRelayRegistryRefresh = true
    console.warn('[Worker] Gateway relay registry refresh deferred (relay server not ready)', { reason })
    return
  }

  try {
    const { relays: precomputedRelays } = options || {}
    const relays = Array.isArray(precomputedRelays)
      ? precomputedRelays
      : await relayServer.getActiveRelays()
    const relaysAuth = await addAuthInfoToRelays(relays)

    await syncGatewayPeerMetadata(reason, { relays: relaysAuth })

    sendMessage({
      type: 'relay-update',
      relays: addMembersToRelays(relaysAuth)
    })

    pendingRelayRegistryRefresh = false
    console.log('[Worker] Refreshed gateway relay registry', {
      reason,
      relayCount: relaysAuth.length
    })
  } catch (error) {
    pendingRelayRegistryRefresh = true
    console.warn('[Worker] Gateway relay registry refresh failed:', error?.message || error)
  }
}

async function fetchOpenJoinChallenge(relayIdentifier, { origin, purpose = null } = {}) {
  if (!relayIdentifier) {
    return { status: 'skipped', reason: 'missing-relay-identifier' }
  }
  if (!origin) {
    return { status: 'skipped', reason: 'missing-origin' }
  }
  const fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'skipped', reason: 'fetch-unavailable' }
  }
  const base = origin.replace(/\/$/, '')
  const encodedRelay = encodeURIComponent(relayIdentifier)
  const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : ''
  const url = `${base}/api/relays/${encodedRelay}/open-join/challenge${query}`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), OPEN_JOIN_APPEND_CORES_TIMEOUT_MS)
    : null
  try {
    const response = await fetchImpl(url, { signal: controller?.signal })
    if (!response.ok) {
      let body = null
      try {
        body = await response.text()
      } catch (_) {}
      return {
        status: 'error',
        reason: `challenge status ${response.status}`,
        origin: base,
        body: body ? body.slice(0, 200) : null
      }
    }
    const data = await response.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      return { status: 'error', reason: 'challenge invalid payload', origin: base }
    }
    if (!data?.challenge) {
      return { status: 'error', reason: 'challenge missing', origin: base }
    }
    return { status: 'ok', origin: base, data }
  } catch (error) {
    return { status: 'error', reason: error?.message || 'challenge failed', origin: base }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function submitOpenJoinAppendCores(relayIdentifier, {
  publicIdentifier = null,
  cores = [],
  origins = null,
  reason = 'open-join-append-cores'
} = {}) {
  if (!relayIdentifier) {
    return { status: 'skipped', reason: 'missing-relay-identifier' }
  }
  if (!config?.nostr_nsec_hex) {
    return { status: 'skipped', reason: 'missing-nostr-credentials' }
  }
  const fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'skipped', reason: 'fetch-unavailable' }
  }

  const normalizedEntries = Array.isArray(cores)
    ? cores.map((entry) => normalizeOpenJoinCoreEntry(entry)).filter(Boolean)
    : []
  if (!normalizedEntries.length) {
    return { status: 'skipped', reason: 'missing-cores' }
  }

  let authPubkey = null
  try {
    authPubkey = NostrUtils.getPublicKey(config.nostr_nsec_hex)
    if (config.nostr_pubkey_hex && authPubkey !== config.nostr_pubkey_hex) {
      console.warn('[Worker] Open join append auth pubkey mismatch; using derived pubkey')
    }
  } catch (error) {
    return { status: 'skipped', reason: 'nostr-pubkey-derivation-failed' }
  }

  const originList = Array.isArray(origins) && origins.length ? origins : collectPublicGatewayOrigins()
  const encodedRelay = encodeURIComponent(relayIdentifier)
  let lastError = null

  for (const origin of originList) {
    if (!origin) continue
    const base = origin.replace(/\/$/, '')
    const challengeResult = await fetchOpenJoinChallenge(relayIdentifier, {
      origin: base,
      purpose: OPEN_JOIN_APPEND_CORES_PURPOSE
    })
    if (!challengeResult || challengeResult.status !== 'ok') {
      lastError = new Error(challengeResult?.reason || 'challenge failed')
      console.warn('[Worker] Open join append challenge failed', {
        relayIdentifier,
        origin: base,
        reason: challengeResult?.reason || null
      })
      continue
    }
    const challengeData = challengeResult.data
    const challenge = challengeData?.challenge || null
    if (!challenge) {
      lastError = new Error('challenge missing')
      continue
    }
    const resolvedPublicIdentifier = publicIdentifier || challengeData?.publicIdentifier || relayIdentifier
    const tags = [
      ['relay', base],
      ['challenge', challenge],
      ['purpose', OPEN_JOIN_APPEND_CORES_PURPOSE]
    ]
    if (resolvedPublicIdentifier) {
      tags.push(['h', resolvedPublicIdentifier])
    }
    const unsigned = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: authPubkey,
      tags,
      content: ''
    }
    const authEvent = await NostrUtils.signEvent(unsigned, config.nostr_nsec_hex)
    let authVerified = null
    try {
      authVerified = await NostrUtils.verifySignature(authEvent)
    } catch (error) {
      authVerified = false
      console.warn('[Worker] Open join append auth event verification threw', {
        relayIdentifier,
        origin: base,
        error: error?.message || error
      })
    }
    if (authVerified === false) {
      console.warn('[Worker] Open join append auth event verification failed', {
        relayIdentifier,
        origin: base,
        pubkeyPrefix: authEvent?.pubkey ? String(authEvent.pubkey).slice(0, 12) : null,
        idPrefix: authEvent?.id ? String(authEvent.id).slice(0, 12) : null,
        sigPrefix: authEvent?.sig ? String(authEvent.sig).slice(0, 12) : null
      })
    }

    const appendUrl = `${base}/api/relays/${encodedRelay}/open-join/append-cores`
    const payload = {
      authEvent,
      cores: normalizedEntries
    }
    if (resolvedPublicIdentifier) payload.publicIdentifier = resolvedPublicIdentifier

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller
      ? setTimeout(() => controller.abort(), OPEN_JOIN_APPEND_CORES_TIMEOUT_MS)
      : null
    try {
      const response = await fetchImpl(appendUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller?.signal
      })
      if (!response.ok) {
        let body = null
        try {
          body = await response.text()
        } catch (_) {}
        lastError = new Error(`open-join-append status ${response.status}`)
        console.warn('[Worker] Open join append request failed', {
          relayIdentifier,
          origin: base,
          status: response.status,
          body: body ? body.slice(0, 200) : null
        })
        continue
      }
      const data = await response.json().catch(() => null)
      if (!data || typeof data !== 'object') {
        lastError = new Error('open-join-append invalid payload')
        console.warn('[Worker] Open join append response invalid payload', {
          relayIdentifier,
          origin: base
        })
        continue
      }
      console.log('[Worker] Open join append response', {
        relayIdentifier,
        origin: base,
        added: data?.added ?? null,
        ignored: data?.ignored ?? null,
        rejected: data?.rejected ?? null,
        total: data?.total ?? null
      })
      return { status: 'ok', origin: base, data }
    } catch (error) {
      lastError = error
      console.warn('[Worker] Open join append request threw', {
        relayIdentifier,
        origin: base,
        error: error?.message || error
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    status: 'error',
    reason: reason || 'open-join-append-failed',
    error: lastError?.message || String(lastError || 'open-join-append-failed')
  }
}

async function appendOpenJoinMirrorCores({
  relayKey,
  publicIdentifier = null,
  relayManager = null,
  reason = 'open-join-append'
} = {}) {
  const relayIdentifier = relayKey || publicIdentifier
  if (!relayIdentifier) {
    return { status: 'skipped', reason: 'missing-relay-identifier' }
  }
  if (!config?.nostr_nsec_hex) {
    return { status: 'skipped', reason: 'missing-nostr-credentials' }
  }
  const manager = relayManager || (relayKey ? activeRelays.get(relayKey) : null)
  const coreEntries = collectRelayCoreEntriesForAppend(manager)
  if (!coreEntries.length) {
    return { status: 'skipped', reason: 'missing-cores' }
  }

  await ensurePublicGatewaySettingsLoaded()
  console.log('[Worker] Open join append start', {
    relayIdentifier,
    coreRefsCount: coreEntries.length,
    coreRefsPreview: summarizeCoreRefs(coreEntries.map((entry) => entry?.key).filter(Boolean))
  })

  return submitOpenJoinAppendCores(relayIdentifier, {
    publicIdentifier: publicIdentifier || manager?.publicIdentifier || null,
    cores: coreEntries,
    reason
  })
}

async function fetchOpenJoinBootstrap(
  relayIdentifier,
  { origins = null, reason = 'open-join', inviteProof = null } = {}
) {
  if (!relayIdentifier) {
    return { status: 'skipped', reason: 'missing-relay-identifier' }
  }
  if (!config?.nostr_nsec_hex) {
    return { status: 'skipped', reason: 'missing-nostr-credentials' }
  }
  const fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'skipped', reason: 'fetch-unavailable' }
  }

  const originList = Array.isArray(origins) && origins.length ? origins : collectPublicGatewayOrigins()
  console.log('[Worker] Open join bootstrap start', {
    relayIdentifier,
    origins: originList,
    reason
  })
  const encodedRelay = encodeURIComponent(relayIdentifier)
  let lastError = null
  let authPubkey = null

  try {
    authPubkey = NostrUtils.getPublicKey(config.nostr_nsec_hex)
    if (config.nostr_pubkey_hex && authPubkey !== config.nostr_pubkey_hex) {
      console.warn('[Worker] Open join auth pubkey mismatch; using derived pubkey')
    }
  } catch (error) {
    return { status: 'skipped', reason: 'nostr-pubkey-derivation-failed' }
  }

  const inviteProofHeader = serializeInviteProof(inviteProof)

  for (const origin of originList) {
    if (!origin) continue
    const base = origin.replace(/\/$/, '')
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller
      ? setTimeout(() => controller.abort(), OPEN_JOIN_BOOTSTRAP_TIMEOUT_MS)
      : null
    try {
      const challengeUrl = `${base}/api/relays/${encodedRelay}/open-join/challenge`
      const challengeResponse = await fetchImpl(challengeUrl, {
        signal: controller?.signal,
        headers: inviteProofHeader ? { 'x-invite-proof': inviteProofHeader } : undefined
      })
      if (!challengeResponse.ok) {
        let body = null
        try {
          body = await challengeResponse.text()
        } catch (_) {}
        console.warn('[Worker] Open join challenge failed', {
          relayIdentifier,
          origin: base,
          status: challengeResponse.status,
          body: body ? body.slice(0, 200) : null
        })
        lastError = new Error(`challenge status ${challengeResponse.status}`)
        continue
      }
      const challengeData = await challengeResponse.json().catch(() => null)
      if (!challengeData || typeof challengeData !== 'object') {
        console.warn('[Worker] Open join challenge invalid payload', {
          relayIdentifier,
          origin: base
        })
        lastError = new Error('challenge invalid payload')
        continue
      }
      const challenge = challengeData?.challenge || null
      if (!challenge) {
        console.warn('[Worker] Open join challenge missing', {
          relayIdentifier,
          origin: base
        })
        lastError = new Error('challenge missing')
        continue
      }

      const publicIdentifier = challengeData?.publicIdentifier || relayIdentifier
      console.log('[Worker] Open join challenge ok', {
        relayIdentifier,
        origin: base,
        relayKey: challengeData?.relayKey ? String(challengeData.relayKey).slice(0, 16) : null,
        publicIdentifier,
        expiresAt: challengeData?.expiresAt || null
      })
      const tags = [
        ['relay', base],
        ['challenge', challenge]
      ]
      if (publicIdentifier) {
        tags.push(['h', publicIdentifier])
      }
      const unsigned = {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        pubkey: authPubkey,
        tags,
        content: ''
      }
      const authEvent = await NostrUtils.signEvent(unsigned, config.nostr_nsec_hex)
      let authVerified = null
      try {
        authVerified = await NostrUtils.verifySignature(authEvent)
      } catch (error) {
        authVerified = false
        console.warn('[Worker] Open join auth event verification threw', {
          relayIdentifier,
          origin: base,
          error: error?.message || error
        })
      }
      if (authVerified === false) {
        console.warn('[Worker] Open join auth event verification failed', {
          relayIdentifier,
          origin: base,
          pubkeyPrefix: authEvent?.pubkey ? String(authEvent.pubkey).slice(0, 12) : null,
          idPrefix: authEvent?.id ? String(authEvent.id).slice(0, 12) : null,
          sigPrefix: authEvent?.sig ? String(authEvent.sig).slice(0, 12) : null
        })
      }
      console.log('[Worker] Open join auth event signed', {
        relayIdentifier,
        origin: base,
        verified: authVerified,
        pubkeyPrefix: authEvent?.pubkey ? String(authEvent.pubkey).slice(0, 12) : null,
        idPrefix: authEvent?.id ? String(authEvent.id).slice(0, 12) : null,
        sigPrefix: authEvent?.sig ? String(authEvent.sig).slice(0, 12) : null,
        tagCount: Array.isArray(authEvent?.tags) ? authEvent.tags.length : 0
      })

      const joinUrl = `${base}/api/relays/${encodedRelay}/open-join`
      const joinResponse = await fetchImpl(joinUrl, {
        method: 'POST',
        headers: inviteProofHeader
          ? { 'content-type': 'application/json', 'x-invite-proof': inviteProofHeader }
          : { 'content-type': 'application/json' },
        body: JSON.stringify(inviteProof ? { authEvent, inviteProof } : { authEvent })
      })
      if (!joinResponse.ok) {
        let body = null
        try {
          body = await joinResponse.text()
        } catch (_) {}
        console.warn('[Worker] Open join request failed', {
          relayIdentifier,
          origin: base,
          status: joinResponse.status,
          body: body ? body.slice(0, 200) : null
        })
        lastError = new Error(`open-join status ${joinResponse.status}`)
        continue
      }
      const data = await joinResponse.json().catch(() => null)
      if (!data || typeof data !== 'object') {
        console.warn('[Worker] Open join response invalid payload', {
          relayIdentifier,
          origin: base
        })
        lastError = new Error('open-join invalid payload')
        continue
      }
      const dataBlindPeer = data.blindPeer || data.blind_peer || null
      console.log('[Worker] Open join bootstrap response', {
        relayIdentifier,
        origin: base,
        relayKey: previewValue(data.relayKey || data.relay_key, 16),
        publicIdentifier: data.publicIdentifier || data.public_identifier || null,
        hasWriterCore: !!data.writerCore,
        hasWriterCoreHex: !!(data.writerCoreHex || data.writer_core_hex),
        hasAutobaseLocal: !!(data.autobaseLocal || data.autobase_local),
        writerCorePrefix: previewValue(data.writerCore, 16),
        writerCoreHexPrefix: previewValue(
          data.writerCoreHex || data.writer_core_hex || data.autobaseLocal || data.autobase_local,
          16
        ),
        writerSecretLen: data.writerSecret ? String(data.writerSecret).length : 0,
        coreRefsCount: Array.isArray(data.cores) ? data.cores.length : 0,
        blindPeerKey: previewValue(dataBlindPeer?.publicKey, 16),
        blindPeerHasEncryptionKey: !!dataBlindPeer?.encryptionKey,
        issuedAt: data.issuedAt ?? null,
        expiresAt: data.expiresAt ?? null
      })
      return {
        status: 'ok',
        origin: base,
        data
      }
    } catch (error) {
      lastError = error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    status: 'error',
    reason: reason || 'open-join-failed',
    error: lastError?.message || String(lastError || 'open-join-failed')
  }
}

async function fetchRelayMirrorMetadata(relayKey, { origins = null, reason = 'mirror-refresh' } = {}) {
  if (!relayKey) {
    return { status: 'skipped', reason: 'missing-relay-key' }
  }
  const fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'skipped', reason: 'fetch-unavailable' }
  }

  const originList = Array.isArray(origins) && origins.length ? origins : collectPublicGatewayOrigins()
  const encodedRelay = encodeURIComponent(relayKey)
  let lastError = null

  for (const origin of originList) {
    if (!origin) continue
    const url = `${origin.replace(/\/$/, '')}/api/relays/${encodedRelay}/mirror`
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller
      ? setTimeout(() => controller.abort(), BLIND_PEER_MIRROR_METADATA_TIMEOUT_MS)
      : null
    try {
      const response = await fetchImpl(url, { signal: controller?.signal })
      if (!response.ok) {
        lastError = new Error(`status ${response.status}`)
        continue
      }
      const data = await response.json().catch(() => null)
      if (!data || typeof data !== 'object') {
        lastError = new Error('invalid-payload')
        continue
      }
      const mirrorBlindPeer = data.blindPeer || data.blind_peer || null
      console.log('[Worker] Mirror metadata response', {
        relayKey,
        origin,
        resolvedRelayKey: previewValue(data.relayKey || data.relay_key, 16),
        publicIdentifier: data.publicIdentifier || data.public_identifier || null,
        coreRefsCount: Array.isArray(data.cores) ? data.cores.length : 0,
        mirrorSource: data.mirrorSource || data.mirror_source || null,
        updatedAt: data.updatedAt ?? null,
        blindPeerKey: previewValue(mirrorBlindPeer?.publicKey, 16),
        blindPeerHasEncryptionKey: !!mirrorBlindPeer?.encryptionKey
      })
      return { status: 'ok', origin, data }
    } catch (error) {
      lastError = error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  if (lastError) {
    console.warn('[Worker] Mirror metadata fetch failed', {
      relayKey,
      reason,
      error: lastError?.message || lastError
    })
  }
  return { status: 'error', reason: 'mirror-unavailable', error: lastError }
}

async function fetchAndApplyRelayMirrorMetadata({
  relayKey,
  publicIdentifier = null,
  reason = 'auto-connect',
  origins = null
} = {}) {
  if (!relayKey) {
    return { status: 'skipped', reason: 'missing-relay-key' }
  }
  await ensurePublicGatewaySettingsLoaded()
  const originList = Array.isArray(origins) && origins.length ? origins : collectPublicGatewayOrigins()
  const mirrorResult = await fetchRelayMirrorMetadata(relayKey, { origins: originList, reason })
  if (mirrorResult.status !== 'ok') {
    return {
      status: 'error',
      reason: mirrorResult.reason || 'mirror-unavailable',
      error: mirrorResult.error || null
    }
  }
  const applyResult = await applyMirrorMetadataToProfile({
    relayKey,
    publicIdentifier,
    mirrorData: mirrorResult.data,
    origin: mirrorResult.origin,
    reason
  })
  return { status: 'ok', applyResult }
}

async function applyMirrorMetadataToProfile({
  relayKey,
  publicIdentifier = null,
  mirrorData = null,
  origin = null,
  reason = 'mirror-refresh'
} = {}) {
  if (!mirrorData || typeof mirrorData !== 'object') {
    return { status: 'skipped', reason: 'missing-mirror-data' }
  }

  let profile = relayKey ? await getRelayProfileByKey(relayKey) : null
  if (!profile && publicIdentifier) {
    profile = await getRelayProfileByPublicIdentifier(publicIdentifier)
  }
  if (!profile) {
    return { status: 'skipped', reason: 'profile-missing' }
  }

  const rawCoreRefs = Array.isArray(profile.core_refs || profile.coreRefs)
    ? (profile.core_refs || profile.coreRefs)
    : []
  const existingStats = normalizeCoreRefListWithStats(rawCoreRefs, {
    context: {
      phase: 'mirror-profile-existing',
      relayKey: previewValue(relayKey, 16),
      publicIdentifier,
      reason
    },
    log: console
  })
  const mirrorStats = normalizeCoreRefListWithStats(mirrorData.cores, {
    context: {
      phase: 'mirror-profile-mirror',
      relayKey: previewValue(relayKey, 16),
      publicIdentifier,
      origin,
      reason
    },
    log: console
  })
  const extraStats = normalizeCoreRefListWithStats([
    profile.writer_core,
    profile.writerCore,
    profile.writer_core_hex,
    profile.autobase_local,
    profile.autobaseLocal
  ], {
    context: {
      phase: 'mirror-profile-extra',
      relayKey: previewValue(relayKey, 16),
      publicIdentifier,
      reason
    },
    log: console
  })
  const mergeStats = mergeCoreRefListsWithStats(
    [existingStats.normalized, mirrorStats.normalized, extraStats.normalized],
    {
      context: {
        phase: 'mirror-profile-merge',
        relayKey: previewValue(relayKey, 16),
        publicIdentifier,
        origin,
        reason
      },
      log: console
    }
  )
  const existingCoreRefs = existingStats.normalized
  const mirrorCoreRefs = mirrorStats.normalized
  const extraCoreRefs = extraStats.normalized
  const mergedCoreRefs = mergeStats.merged
  const mergedFingerprint = coreRefsFingerprint(mergedCoreRefs)
  const existingFingerprint = coreRefsFingerprint(existingCoreRefs)
  const nextBlindPeer = sanitizeBlindPeerMeta(mirrorData.blindPeer)
  const updates = {}
  let coreRefsChanged = false
  let blindPeerChanged = false
  const resolvedRelayKey = profile.relay_key || relayKey || null

  const needsNormalization = rawCoreRefs.some((ref) => {
    if (!ref) return false
    if (typeof ref !== 'string') return true
    const normalized = normalizeCoreRef(ref)
    return normalized && normalized !== ref.trim()
  })

  if ((mergedFingerprint && mergedFingerprint !== existingFingerprint) || needsNormalization) {
    updates.core_refs = mergedCoreRefs
    coreRefsChanged = true
  }

  if (nextBlindPeer?.publicKey) {
    const mergedBlindPeer = {
      ...(profile.blind_peer || {}),
      ...nextBlindPeer
    }
    if (blindPeerFingerprint(profile.blind_peer) !== blindPeerFingerprint(mergedBlindPeer)) {
      updates.blind_peer = mergedBlindPeer
      blindPeerChanged = true
    }
  }

  updateRelayMirrorCoreRefs(resolvedRelayKey, mergedCoreRefs, { context: 'mirror-metadata-apply' })
  const shouldSyncActive = !!resolvedRelayKey
    && mergedCoreRefs.length > 0
    && relayMirrorSyncState.get(resolvedRelayKey) !== mergedFingerprint

  if (!coreRefsChanged && !blindPeerChanged) {
    if (shouldSyncActive) {
      await syncActiveRelayCoreRefs({
        relayKey: resolvedRelayKey,
        publicIdentifier: profile.public_identifier || publicIdentifier,
        coreRefs: mergedCoreRefs,
        reason: `${reason}-mirror-sync`
      })
      return {
        status: 'synced',
        coreRefs: mergedCoreRefs.length,
        coreRefsChanged,
        blindPeerChanged
      }
    }
    return { status: 'skipped', reason: 'no-change', coreRefs: existingCoreRefs.length }
  }

  const updatedProfile = {
    ...profile,
    ...updates,
    updated_at: new Date().toISOString()
  }
  await saveRelayProfile(updatedProfile)

  console.log('[Worker] Relay mirror metadata updated', {
    relayKey: updatedProfile.relay_key || relayKey,
    publicIdentifier: updatedProfile.public_identifier || publicIdentifier || null,
    origin,
    reason,
    coreRefs: updates.core_refs ? updates.core_refs.length : existingCoreRefs.length,
    blindPeerKey: updates.blind_peer?.publicKey
      ? String(updates.blind_peer.publicKey).slice(0, 16)
      : profile?.blind_peer?.publicKey
        ? String(profile.blind_peer.publicKey).slice(0, 16)
        : null
  })

  if (shouldSyncActive) {
    await syncActiveRelayCoreRefs({
      relayKey: resolvedRelayKey,
      publicIdentifier: updatedProfile.public_identifier || publicIdentifier,
      coreRefs: mergedCoreRefs,
      reason: `${reason}-mirror-sync`
    })
  }

  return {
    status: 'updated',
    coreRefs: updates.core_refs ? updates.core_refs.length : existingCoreRefs.length,
    coreRefsChanged,
    blindPeerChanged
  }
}

async function refreshRelayMirrorMetadata(reason = 'periodic') {
  if (mirrorMetadataRefreshInFlight) return mirrorMetadataRefreshInFlight

  mirrorMetadataRefreshInFlight = (async () => {
    await ensurePublicGatewaySettingsLoaded()
    const startedAt = Date.now()
    lastMirrorMetadataRefreshAt = startedAt
    const originList = collectPublicGatewayOrigins()

    try {
      await refreshGatewayRelayRegistry(`${reason}-mirror-registry`)
    } catch (error) {
      console.warn('[Worker] Mirror registry refresh failed', {
        reason,
        error: error?.message || error
      })
    }

    const relayKeys = Array.from(activeRelays.keys())
      .filter((key) => key && !virtualRelayKeys.has(key))
    if (!relayKeys.length) {
      return { status: 'skipped', reason: 'no-relays' }
    }

    const summary = {
      reason,
      total: relayKeys.length,
      updated: 0,
      skipped: 0,
      failed: 0
    }

    for (const relayKey of relayKeys) {
      const publicIdentifier = keyToPublic.get(relayKey) || null
      const mirrorResult = await fetchRelayMirrorMetadata(relayKey, { origins: originList, reason })
      if (mirrorResult.status !== 'ok') {
        summary.failed += 1
        continue
      }
      const updateResult = await applyMirrorMetadataToProfile({
        relayKey,
        publicIdentifier,
        mirrorData: mirrorResult.data,
        origin: mirrorResult.origin,
        reason
      })
      if (updateResult.status === 'updated') {
        summary.updated += 1
      } else {
        summary.skipped += 1
      }
    }

    const elapsedMs = Date.now() - startedAt
    console.log('[Worker] Mirror metadata refresh complete', {
      reason,
      total: summary.total,
      updated: summary.updated,
      skipped: summary.skipped,
      failed: summary.failed,
      elapsedMs
    })

    return { status: 'ok', ...summary }
  })()

  try {
    return await mirrorMetadataRefreshInFlight
  } finally {
    mirrorMetadataRefreshInFlight = null
  }
}

async function ensurePublicGatewaySettingsLoaded() {
  if (publicGatewaySettings) return publicGatewaySettings
  try {
    publicGatewaySettings = await loadPublicGatewaySettings()
  } catch (error) {
    console.warn('[Worker] Failed to load public gateway settings:', error)
    publicGatewaySettings = getCachedPublicGatewaySettings()
  }

  if (publicGatewaySettings && typeof publicGatewaySettings.delegateReqToPeers !== 'boolean') {
    publicGatewaySettings.delegateReqToPeers = false
  }
  return publicGatewaySettings
}

async function ensureBlindPeeringManager(runtime = {}) {
  await ensurePublicGatewaySettingsLoaded()
  const storageBase = (config && config.storage) ? config.storage : defaultStorageDir
  const metadataPath = join(storageBase, BLIND_PEERING_METADATA_FILENAME)
  const swarmKeyPair = deriveSwarmKeyPair(config)
  if (!blindPeeringManager) {
    blindPeeringManager = new BlindPeeringManager({
      logger: console,
      settingsProvider: () => publicGatewaySettings
    })
  }

  blindPeeringManager.setMetadataPath(metadataPath)
  blindPeeringManager.configure(publicGatewaySettings)

  if (runtime.start === true) {
    await blindPeeringManager.start({
      corestore: runtime.corestore,
      wakeup: runtime.wakeup,
      swarmKeyPair
    })
  } else if (swarmKeyPair) {
    blindPeeringManager.runtime.swarmKeyPair = swarmKeyPair
  }

  global.blindPeeringManager = blindPeeringManager
  return blindPeeringManager
}

async function seedBlindPeeringMirrors(manager) {
  if (!manager?.started) return
  const localDrive = getLocalDrive()
  if (config?.driveKey && localDrive) {
    manager.ensureHyperdriveMirror({
      identifier: config.driveKey,
      driveKey: config.driveKey,
      type: 'drive',
      drive: localDrive
    })
  }
  const pfpDriveInstance = getPfpDrive()
  if (config?.pfpDriveKey && pfpDriveInstance) {
    manager.ensureHyperdriveMirror({
      identifier: config.pfpDriveKey,
      driveKey: config.pfpDriveKey,
      type: 'pfp-drive',
      isPfp: true,
      drive: pfpDriveInstance
    })
  }
  for (const [relayKey, relayManager] of activeRelays.entries()) {
    if (!relayManager?.relay) continue
    const storedCoreRefs = await resolveRelayMirrorCoreRefs(
      relayKey,
      relayManager?.publicIdentifier || null,
      [],
      { context: 'blind-peering-seed' }
    )
    manager.ensureRelayMirror({
      relayKey,
      publicIdentifier: relayManager?.publicIdentifier || null,
      autobase: relayManager.relay,
      coreRefs: storedCoreRefs,
      corestore: relayManager.store || null
    })
    attachRelayMirrorHooks(relayKey, relayManager, manager)
  }
}

function attachRelayMirrorHooks(relayKey, relayManager, manager) {
  if (!manager?.started) return
  const autobase = relayManager?.relay
  if (!autobase || typeof autobase.on !== 'function') return
  if (relayMirrorSubscriptions.has(autobase)) return
  const handler = () => {
    Promise.resolve(resolveRelayMirrorCoreRefs(
      relayKey,
      relayManager?.publicIdentifier || null,
      [],
      { context: 'blind-peering-update' }
    ))
      .then((coreRefs) => {
        manager.ensureRelayMirror({
          relayKey,
          publicIdentifier: relayManager?.publicIdentifier || null,
          autobase,
          coreRefs,
          corestore: relayManager?.store || null
        })
        return manager.refreshFromBlindPeers('relay-update')
          .then(() => manager.rehydrateMirrors({
            reason: 'relay-update',
            timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
          }))
      })
      .catch((error) => {
        manager.logger?.warn?.('[BlindPeering] Relay update sync failed', {
          relayKey,
          err: error?.message || error
        })
      })
  }
  autobase.on('update', handler)
  relayMirrorSubscriptions.set(autobase, () => {
    if (typeof autobase.off === 'function') {
      autobase.off('update', handler)
    } else if (typeof autobase.removeListener === 'function') {
      autobase.removeListener('update', handler)
    }
  })
}

function detachRelayMirrorHooks(relayManager) {
  if (!relayManager) return
  const autobase = relayManager.relay
  if (!autobase) return
  const unsubscribe = relayMirrorSubscriptions.get(autobase)
  if (!unsubscribe) return
  try {
    unsubscribe()
  } catch (error) {
    console.warn('[Worker] Failed to detach relay mirror subscription:', error?.message || error)
  }
  relayMirrorSubscriptions.delete(autobase)
}

function cleanupRelayMirrorSubscriptions() {
  for (const unsubscribe of relayMirrorSubscriptions.values()) {
    try {
      unsubscribe()
    } catch (error) {
      console.warn('[Worker] Failed to remove relay mirror subscription:', error?.message || error)
    }
  }
  relayMirrorSubscriptions.clear()
}

async function startGatewayService(options = {}) {
  await ensurePublicGatewaySettingsLoaded()

  if (!gatewayService) {
    gatewayService = new GatewayService({
      publicGateway: publicGatewaySettings,
      getCurrentPubkey: () => config?.nostr_pubkey_hex || null,
      getOwnPeerPublicKey: () => config?.swarmPublicKey || deriveSwarmPublicKey(config),
      openJoinPoolProvider: ensureOpenJoinWriterPool
    })
    global.gatewayService = gatewayService
    gatewayService.on('log', (entry) => {
      sendMessage({ type: 'gateway-log', entry })
    })
    gatewayService.on('status', async (status) => {
      gatewayStatusCache = status
      if (status?.publicGateway) {
        publicGatewayStatusCache = status.publicGateway
      }
      sendMessage({ type: 'gateway-status', status })
      maybeReauthOpenJoins(status).catch((err) => {
        console.warn('[Worker] Open join reauth check failed', err?.message || err)
      })
      const wasRunning = gatewayWasRunning
      gatewayWasRunning = !!status?.running
      if (status?.running) {
        if (pendingGatewayMetadataSync || pendingRelayRegistryRefresh || !wasRunning) {
          refreshGatewayRelayRegistry(wasRunning ? 'gateway-status-running' : 'gateway-restarted').catch((err) => {
            console.warn('[Worker] Deferred gateway registry refresh failed on status:', err?.message || err)
          })
        }
        const { httpUrl, proxyHost, wsProtocol } = deriveGatewayHostFromStatus(status)
        if (!gatewaySettingsApplied) {
          try {
            await updateGatewaySettings({
              gatewayUrl: httpUrl,
              proxyHost,
              proxyWebsocketProtocol: wsProtocol
            })
            gatewaySettingsApplied = true
          } catch (error) {
            console.error('[Worker] Failed to update gateway settings:', error)
          }
        }
      }
    })
    gatewayService.on('public-gateway-status', async (state) => {
      publicGatewayStatusCache = state
      sendMessage({ type: 'public-gateway-status', state })
      if (!state?.blindPeer) return

      try {
        const blindPeerState = state.blindPeer || {}
        const summary = blindPeerState.summary || null
        const remoteKeys = Array.isArray(blindPeerState.keys) && blindPeerState.keys.length
          ? blindPeerState.keys.filter(Boolean)
          : summary?.publicKey ? [summary.publicKey] : []
        const previousSettings = publicGatewaySettings || {}
        const manualKeys = Array.isArray(previousSettings.blindPeerManualKeys)
          ? previousSettings.blindPeerManualKeys.filter(Boolean)
          : []

        publicGatewaySettings = {
          ...previousSettings,
          blindPeerEnabled: summary?.enabled ?? !!blindPeerState.enabled,
          blindPeerKeys: remoteKeys,
          blindPeerManualKeys: manualKeys,
          blindPeerEncryptionKey: summary?.encryptionKey || blindPeerState.encryptionKey || null,
          blindPeerMaxBytes: blindPeerState.maxBytes ?? previousSettings.blindPeerMaxBytes ?? null
        }

        const manager = await ensureBlindPeeringManager()
        manager.configure(publicGatewaySettings)
        manager.markTrustedMirrors(remoteKeys)

        const dispatcherAssignments = Array.isArray(blindPeerState.dispatcherAssignments)
          ? blindPeerState.dispatcherAssignments
          : Array.isArray(summary?.dispatcherAssignments) ? summary.dispatcherAssignments : []
        const ownPeerKey = config?.swarmPublicKey || deriveSwarmPublicKey(config)
        const ownAssignments = dispatcherAssignments.filter((assignment) => assignment?.peerKey === ownPeerKey)
        const dispatcherFingerprint = JSON.stringify(ownAssignments.map((assignment) => (
          `${assignment?.jobId || ''}:${assignment?.relayKey || ''}:${assignment?.status || 'assigned'}`
        )))
        const keysFingerprint = Array.from(new Set([...remoteKeys, ...manualKeys].filter(Boolean))).join(',')
        const fingerprint = summary?.enabled
          ? `${summary.publicKey || ''}:${summary.encryptionKey || ''}:${summary.trustedPeerCount ?? remoteKeys.length}:${keysFingerprint}`
          : 'disabled'

          if (manager.enabled && !manager.started) {
            await manager.start({
              corestore: getCorestore(),
              wakeup: null,
              swarmKeyPair: deriveSwarmKeyPair(config)
            })
            await seedBlindPeeringMirrors(manager)
            await manager.refreshFromBlindPeers('status-sync')
            await manager.rehydrateMirrors({
              reason: 'status-sync',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            })
            lastBlindPeerFingerprint = fingerprint
            lastDispatcherAssignmentFingerprint = dispatcherFingerprint
          } else if (manager.enabled && manager.started) {
            if (fingerprint !== lastBlindPeerFingerprint) {
              lastBlindPeerFingerprint = fingerprint
              try {
                await manager.refreshFromBlindPeers('status-sync')
            } catch (error) {
              console.warn('[Worker] Blind peering refresh failed on status update:', error?.message || error)
            }
            manager.rehydrateMirrors({
              reason: 'status-sync',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            }).catch((error) => {
              console.warn('[Worker] Blind peering rehydration failed after status update:', error?.message || error)
              })
            }
            if (dispatcherFingerprint !== lastDispatcherAssignmentFingerprint) {
              lastDispatcherAssignmentFingerprint = dispatcherFingerprint
              try {
                await seedBlindPeeringMirrors(manager)
              } catch (seedErr) {
                console.warn('[Worker] Blind peering mirror seeding failed (dispatcher update):', seedErr?.message || seedErr)
              }
              try {
                await manager.refreshFromBlindPeers('dispatcher-assignment')
              } catch (refreshErr) {
                console.warn('[Worker] Blind peering refresh failed on dispatcher update:', refreshErr?.message || refreshErr)
              }
              manager.rehydrateMirrors({
                reason: 'dispatcher-assignment',
                timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
              }).catch((error) => {
                console.warn('[Worker] Blind peering rehydration failed after dispatcher update:', error?.message || error)
              })
            }
          } else if (!manager.enabled && manager.started) {
            try {
              await manager.clearAllMirrors({ reason: 'status-disabled' })
            } catch (error) {
              console.warn('[Worker] Failed to clear blind peering mirrors before shutdown:', error?.message || error)
            }
            await manager.stop()
            lastBlindPeerFingerprint = fingerprint
            lastDispatcherAssignmentFingerprint = dispatcherFingerprint
          }
      } catch (error) {
        console.warn('[Worker] Failed to reconcile blind peering manager from status update:', error?.message || error)
      }
    })
    if (pendingGatewayMetadataSync) {
      refreshGatewayRelayRegistry('gateway-service-initialized').catch((err) => {
        console.warn('[Worker] Deferred gateway registry refresh failed:', err?.message || err)
      })
    }
  }

  await gatewayService.updatePublicGatewayConfig(publicGatewaySettings)
  sendMessage({ type: 'public-gateway-config', config: publicGatewaySettings })
  publicGatewayStatusCache = gatewayService.getPublicGatewayState()
  sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })

  const incomingOptions = options && typeof options === 'object' ? options : {}
  const sanitizedOptions = { ...incomingOptions }
  delete sanitizedOptions.detectLanAddresses
  delete sanitizedOptions.detectPublicIp
  const mergedOptions = {
    ...gatewayOptions,
    ...sanitizedOptions,
    publicGateway: publicGatewaySettings
  }
  mergedOptions.listenHost = '127.0.0.1'
  mergedOptions.hostname = '127.0.0.1'

  const needsRestart = gatewayService?.isRunning && (
    mergedOptions.port !== gatewayOptions.port ||
    mergedOptions.hostname !== gatewayOptions.hostname ||
    mergedOptions.listenHost !== gatewayOptions.listenHost
  )

  if (needsRestart) {
    await gatewayService.stop().catch((err) => {
      console.warn('[Worker] Gateway stop during restart failed:', err)
    })
  }

  if (gatewayService.isRunning && !needsRestart) {
    gatewayOptions = mergedOptions
    return
  }

  try {
    gatewaySettingsApplied = false
    await gatewayService.start(mergedOptions)
    gatewayOptions = mergedOptions
    await ensureBlindPeeringManager({
      start: true,
      corestore: getCorestore(),
      wakeup: null
    })
    refreshGatewayRelayRegistry('gateway-started').catch((err) => {
      console.warn('[Worker] Gateway registry refresh failed after start:', err?.message || err)
    })
  } catch (error) {
    console.error('[Worker] Failed to start gateway service:', error)
    throw error
  }
}

async function stopGatewayService() {
  if (!gatewayService) return
  try {
    await gatewayService.stop()
    publicGatewayStatusCache = gatewayService.getPublicGatewayState()
    sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
    if (blindPeeringManager) {
      await blindPeeringManager.stop()
    }
  } catch (error) {
    console.error('[Worker] Failed to stop gateway service:', error)
    throw error
  }
}

function waitForGatewayReady(timeoutMs = 15000) {
  if (gatewayStatusCache?.running) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const start = Date.now()
    const interval = setInterval(() => {
      if (gatewayStatusCache?.running) {
        clearInterval(interval)
        resolve(true)
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval)
        resolve(false)
      }
    }, 200)
  })
}

function getGatewayStatus() {
  if (gatewayService) {
    return gatewayService.getStatus()
  }
  return gatewayStatusCache || { running: false }
}

function getGatewayLogs() {
  if (gatewayService) {
    return gatewayService.getLogs()
  }
  return []
}

// Variable to store the relay server module
let relayServer = null
let isShuttingDown = false
// Map of relayKey -> members array
const relayMembers = new Map()
const relayMemberAdds = new Map()
const relayMemberRemoves = new Map()
const relayRegistrationStatus = new Map()
const seenFileHashes = new Map()
let config = null
let configPath = null
let healthLogPath = null
let healthIntervalHandle = null

// Store configuration received from the parent process
let configReceived = false
let storedParentConfig = null

let gatewayService = null
let blindPeeringManager = null
let gatewayStatusCache = null
let gatewaySettingsApplied = false
let gatewayOptions = { port: 8443, hostname: '127.0.0.1', listenHost: '127.0.0.1' }
let publicGatewaySettings = null
let publicGatewayStatusCache = null
let pendingGatewayMetadataSync = false

const WORKER_MESSAGE_VERSION = 1
const WORKER_SESSION_ID =
  typeof nodeCrypto.randomUUID === 'function'
    ? nodeCrypto.randomUUID()
    : nodeCrypto.randomBytes(16).toString('hex')

const PROXY_DERIVATION_CONTEXT = 'hypertuna-relay-peer'
const PROXY_DERIVATION_ITERATIONS = 100000
const PROXY_DERIVATION_DKLEN_BYTES = 32

async function appendFilekeyDbEntry (relayKey, fileHash) {
  if (!config?.driveKey || !config?.nostr_pubkey_hex) {
    console.warn(`[Worker] appendFilekeyDbEntry skipped: missing driveKey or nostr_pubkey_hex (driveKey=${!!config?.driveKey}, pub=${!!config?.nostr_pubkey_hex})`)
    return
  }
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    console.warn(`[Worker] appendFilekeyDbEntry skipped: no active relay manager for key=${relayKey}`)
    return
  }

  const fileKey = `filekey:${fileHash}:drivekey:${config.driveKey}:pubkey:${config.nostr_pubkey_hex}`
  const fileKeyValue = {
    filekey: fileHash,
    drivekey: config.driveKey,
    pubkey: config.nostr_pubkey_hex
  }

  try {
    await relayManager.relay.put(
      b4a.from(fileKey, 'utf8'),
      b4a.from(JSON.stringify(fileKeyValue), 'utf8')
    )
    // Ensure the view applies this operation before any immediate queries
    try {
      await relayManager.relay.update()
      const v = relayManager?.relay?.view?.version
      console.log(`[Index] put applied (viewVersion=${v}) key=${fileKey} value=${JSON.stringify(fileKeyValue)}`)
    } catch (e) {
      console.warn('[Index] relay.update after put failed:', e?.message || e)
    }
    console.log(`[Worker] Stored filekey index for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to store filekey index:', err)
  }
}

async function publishFilekeyEvent (relayKey, fileHash) {
  if (!config?.nostr_pubkey_hex || !config?.nostr_nsec_hex || !config?.driveKey) return
  const relayManager = activeRelays.get(relayKey)
  try {
    await appendFilekeyDbEntry(relayKey, fileHash)
    console.log(`[Worker] Published filekey event for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to publish filekey event:', err)
  }
}

async function publishFileDeletionEvent (relayKey, fileHash) {
  if (!config?.driveKey || !config?.nostr_pubkey_hex) return
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) return

  const fileKey = `filekey:${fileHash}:drivekey:${config.driveKey}:pubkey:${config.nostr_pubkey_hex}`
  try {
    await relayManager.relay.del(b4a.from(fileKey, 'utf8'))
    try { await relayManager.relay.update() } catch (_) {}
    console.log(`[Worker] Deleted filekey index for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to delete filekey index:', err)
  }
}


function isHex64 (s) { return typeof s === 'string' && /^[a-fA-F0-9]{64}$/.test(s) }

function startDriveWatcher () {
  watchDrive(async ({ type, path }) => {
    console.log(`[DriveWatch] change type=${type} path=${path}`)
    const parts = path.split('/').filter(Boolean)
    if (parts.length !== 2) return
    const [identifier, fileHash] = parts
    let relayKey = identifier
    try {
      if (!isHex64(identifier) && identifier.includes(':')) {
        const mapped = await getRelayKeyFromPublicIdentifier(identifier)
        if (mapped) relayKey = mapped
        else console.warn(`[Worker] watchDrive: could not resolve relayKey for identifier ${identifier}`)
      }
    } catch (_) {}
    if (type === 'add') await publishFilekeyEvent(relayKey, fileHash)
    else if (type === 'del') await publishFileDeletionEvent(relayKey, fileHash)

    if (blindPeeringManager?.started) {
      try {
        if (config?.driveKey && identifier === config.driveKey) {
          const localDrive = getLocalDrive()
          if (localDrive) {
            blindPeeringManager.ensureHyperdriveMirror({
              identifier: config.driveKey,
              driveKey: config.driveKey,
              type: 'drive',
              drive: localDrive
            })
          }
        } else if (config?.pfpDriveKey && identifier === config.pfpDriveKey) {
          const pfpDrive = getPfpDrive()
          if (pfpDrive) {
            blindPeeringManager.ensureHyperdriveMirror({
              identifier: config.pfpDriveKey,
              driveKey: config.pfpDriveKey,
              type: 'pfp-drive',
              isPfp: true,
              drive: pfpDrive
            })
          }
        }
        blindPeeringManager.refreshFromBlindPeers('drive-watch').catch((error) => {
          console.warn('[Worker] Blind peering drive-watch refresh failed:', error?.message || error)
        })
      } catch (error) {
        console.warn('[Worker] Failed to update blind peering mirrors from drive watch:', error?.message || error)
      }
    }
  })
}


function getUserKey(config) {
    if (config?.userKey && typeof config.userKey === 'string') {
      return config.userKey
    }
    // If storage path contains /users/, extract the key
    if (config.storage && config.storage.includes('/users/')) {
      const match = config.storage.match(/\/users\/([a-f0-9]{64})/);
      if (match) {
        return match[1];
      }
    }
    
    // Otherwise, generate from nostr_nsec_hex
    if (config.nostr_nsec_hex) {
      return nodeCrypto.createHash('sha256')
        .update(config.nostr_nsec_hex)
        .digest('hex');
    }
    
    throw new Error('Unable to determine user key from config');
  }
  
function deriveSwarmPublicKey(cfg = {}) {
  if (cfg.swarmPublicKey && typeof cfg.swarmPublicKey === 'string') {
    return cfg.swarmPublicKey;
  }
  if (cfg.proxy_seed && typeof cfg.proxy_seed === 'string') {
    try {
      const keyPair = swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'));
      const key = keyPair?.publicKey?.toString('hex');
      if (key) return key;
    } catch (error) {
      console.warn('[Worker] Failed to derive swarm public key from seed:', error?.message || error);
    }
  }
  return null;
}

function deriveSwarmKeyPair(cfg = {}) {
  if (cfg?.proxy_seed && typeof cfg.proxy_seed === 'string') {
    try {
      return swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'));
    } catch (error) {
      console.warn('[Worker] Failed to derive swarm key pair from seed:', error?.message || error);
    }
  }
  return null;
}

function deriveProxySeedHex(nostr_nsec_hex) {
  if (typeof nostr_nsec_hex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(nostr_nsec_hex)) {
    throw new Error('Invalid nostr_nsec_hex for proxy seed derivation')
  }

  const seed = nodeCrypto.pbkdf2Sync(
    Buffer.from(nostr_nsec_hex.toLowerCase(), 'hex'),
    Buffer.from(PROXY_DERIVATION_CONTEXT, 'utf8'),
    PROXY_DERIVATION_ITERATIONS,
    PROXY_DERIVATION_DKLEN_BYTES,
    'sha256'
  )

  return seed.toString('hex')
}

function ensureProxyIdentity(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Missing config for proxy identity derivation')
  }

  if (!cfg.proxy_seed) {
    cfg.proxy_seed = deriveProxySeedHex(cfg.nostr_nsec_hex)
  }

  try {
    const keyPair = swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'))
    if (keyPair?.publicKey) {
      cfg.proxy_publicKey = keyPair.publicKey.toString('hex')
      cfg.swarmPublicKey = cfg.swarmPublicKey || cfg.proxy_publicKey
    }
    if (keyPair?.secretKey) {
      cfg.proxy_privateKey = keyPair.secretKey.toString('hex')
    }
  } catch (error) {
    console.warn('[Worker] Failed to derive proxy keypair from proxy_seed:', error?.message || error)
  }

  return cfg
}

function sanitizeConfigForDisk(configData) {
  if (!configData || typeof configData !== 'object') return configData
  const sanitized = { ...configData }

  // Never persist nostr private keys (memory-only).
  delete sanitized.nostr_nsec
  delete sanitized.nostr_nsec_hex
  delete sanitized.nostr_nsec_bech32

  // Never persist proxy key material (re-derived from nostr_nsec_hex at runtime).
  delete sanitized.proxy_seed
  delete sanitized.proxy_privateKey
  delete sanitized.proxy_private_key
  delete sanitized.proxySecretKey

  return sanitized
}

function getUserKeyFromDiskConfig(configData) {
  if (!configData || typeof configData !== 'object') return null
  if (isHex64(configData.userKey)) return configData.userKey.toLowerCase()
  if (typeof configData.storage === 'string') {
    const match = configData.storage.match(/\/users\/([a-f0-9]{64})/i)
    if (match) return match[1].toLowerCase()
  }
  if (isHex64(configData.nostr_nsec_hex)) {
    return nodeCrypto.createHash('sha256').update(configData.nostr_nsec_hex).digest('hex')
  }
  return null
}

function doesDiskConfigMatchUser(configData, { userKey, pubkeyHex } = {}) {
  if (!configData || typeof configData !== 'object') return false
  const expectedUserKey = isHex64(userKey) ? userKey.toLowerCase() : null
  const expectedPubkeyHex = isHex64(pubkeyHex) ? pubkeyHex.toLowerCase() : null

  const diskUserKey = getUserKeyFromDiskConfig(configData)
  const diskPubkeyHex = isHex64(configData.nostr_pubkey_hex) ? configData.nostr_pubkey_hex.toLowerCase() : null

  if (expectedUserKey && diskUserKey && diskUserKey !== expectedUserKey) return false
  if (expectedPubkeyHex && diskPubkeyHex && diskPubkeyHex !== expectedPubkeyHex) return false

  // Require at least one verifiable identity signal to avoid cross-imports.
  if (!diskUserKey && !diskPubkeyHex) return false

  return true
}

// Load or create configuration
async function loadOrCreateConfig(customDir = null) {
  const configDir = customDir || defaultStorageDir
  await fs.mkdir(configDir, { recursive: true })

  configPath = join(configDir, 'relay-config.json')

  const gatewaySettings = await loadGatewaySettings()
  const cachedGatewaySettings = getCachedGatewaySettings()
  const defaultGatewayUrl = gatewaySettings.gatewayUrl || cachedGatewaySettings.gatewayUrl || 'http://127.0.0.1:1945'
  const defaultProxyHost = gatewaySettings.proxyHost || cachedGatewaySettings.proxyHost || '127.0.0.1:8443'

  const defaultConfig = {
    port: 1945,
    gatewayUrl: defaultGatewayUrl,
    proxy_server_address: defaultProxyHost,
    proxy_websocket_protocol: gatewaySettings.proxyWebsocketProtocol || cachedGatewaySettings.proxyWebsocketProtocol || 'ws',
    registerWithGateway: true,
    registerInterval: 300000,
    relays: [],
    driveKey: null,
    pfpDriveKey: null
  }
  defaultConfig.storage = configDir
  if (global.userConfig?.userKey) {
    defaultConfig.userKey = global.userConfig.userKey
  }

  try {
    const configData = await fs.readFile(configPath, 'utf8')
    console.log('[Worker] Loaded existing config from:', configPath)
    const loadedConfig = JSON.parse(configData)
    let needsPersist = false
    for (const secretKey of [
      'nostr_nsec_hex',
      'nostr_nsec',
      'nostr_nsec_bech32',
      'proxy_seed',
      'proxy_privateKey',
      'proxy_private_key',
      'proxySecretKey'
    ]) {
      if (secretKey in loadedConfig) {
        needsPersist = true
      }
    }
    if (!('driveKey' in loadedConfig)) {
      loadedConfig.driveKey = null
      needsPersist = true
    }
    if (!('pfpDriveKey' in loadedConfig)) {
      loadedConfig.pfpDriveKey = null
      needsPersist = true
    }
    if (!('proxy_websocket_protocol' in loadedConfig) || !loadedConfig.proxy_websocket_protocol) {
      loadedConfig.proxy_websocket_protocol = defaultConfig.proxy_websocket_protocol
      needsPersist = true
    }
    if (needsPersist) {
      await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(loadedConfig), null, 2))
    }
    return { ...defaultConfig, ...loadedConfig }
  } catch (err) {
    const missingFile = err && typeof err === 'object' && err.code === 'ENOENT'
    if (missingFile && customDir && /\/users\/[a-f0-9]{64}$/i.test(customDir)) {
      const globalConfigPath = join(defaultStorageDir, 'relay-config.json')
      try {
        const globalConfigData = await fs.readFile(globalConfigPath, 'utf8')
        const globalConfig = JSON.parse(globalConfigData)
        const expectedUserKey = global.userConfig?.userKey || null
        const expectedPubkeyHex = storedParentConfig?.nostr_pubkey_hex || null

        if (doesDiskConfigMatchUser(globalConfig, { userKey: expectedUserKey, pubkeyHex: expectedPubkeyHex })) {
          const migratedConfig = {
            ...defaultConfig,
            ...globalConfig,
            storage: configDir,
            userKey: expectedUserKey || globalConfig.userKey
          }
          await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(migratedConfig), null, 2))
          try {
            await fs.writeFile(globalConfigPath, JSON.stringify(sanitizeConfigForDisk(globalConfig), null, 2))
          } catch (scrubError) {
            console.warn('[Worker] Failed to scrub secrets from legacy global config:', scrubError?.message || scrubError)
          }
          console.log('[Worker] Migrated legacy global config to user config:', {
            from: globalConfigPath,
            to: configPath
          })
          return migratedConfig
        }
      } catch (migrationError) {
        if (migrationError && typeof migrationError === 'object' && migrationError.code !== 'ENOENT') {
          console.warn('[Worker] Failed to migrate legacy global config:', migrationError?.message || migrationError)
        }
      }
    }

    console.log('[Worker] Creating new config at:', configPath)
    await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(defaultConfig), null, 2))
    return defaultConfig
  }
}

// Load member lists from saved relay profiles
async function loadRelayMembers() {
  try {
    const profiles = await getAllRelayProfiles(global.userConfig?.userKey)
    for (const profile of profiles) {
      if (profile.relay_key) {
        const members = calculateMembers(profile.member_adds || [], profile.member_removes || [])
        relayMembers.set(profile.relay_key, members)
        relayMemberAdds.set(profile.relay_key, profile.member_adds || [])
        relayMemberRemoves.set(profile.relay_key, profile.member_removes || [])
        if (profile.public_identifier) {
          relayMembers.set(profile.public_identifier, members)
          relayMemberAdds.set(profile.public_identifier, profile.member_adds || [])
          relayMemberRemoves.set(profile.public_identifier, profile.member_removes || [])
        }
      }
    }
    console.log(`[Worker] Loaded members for ${relayMembers.size} relays`)
  } catch (err) {
    console.error('[Worker] Failed to load relay members:', err)
  }
}

// Handle worker communication
let workerPipe = null
if (pearRuntime?.worker?.pipe) {
  workerPipe = pearRuntime.worker.pipe()
}

console.log('[Worker] IPC channel:', workerPipe ? 'pear-pipe' : (typeof process.send === 'function' ? 'node-ipc' : 'none'))

// Helper function to send messages with newline delimiter (Pear) or Node IPC events
function trackRegistrationStatus(message) {
  if (!message || typeof message !== 'object') return

  if (message.type === 'relay-created' && message.data) {
    const { relayKey, publicIdentifier, gatewayRegistration, registrationError } = message.data
    if (relayKey) {
      relayRegistrationStatus.set(relayKey, {
        status: gatewayRegistration || 'unknown',
        error: registrationError || null
      })
    }
    if (publicIdentifier) {
      relayRegistrationStatus.set(publicIdentifier, {
        status: gatewayRegistration || 'unknown',
        error: registrationError || null
      })
    }
  } else if (message.type === 'relay-registration-complete') {
    const entry = { status: 'success', error: null }
    if (message.relayKey) relayRegistrationStatus.set(message.relayKey, entry)
    if (message.publicIdentifier) relayRegistrationStatus.set(message.publicIdentifier, entry)
  } else if (message.type === 'relay-registration-failed') {
    const entry = { status: 'failed', error: message.error || null }
    if (message.relayKey) relayRegistrationStatus.set(message.relayKey, entry)
    if (message.publicIdentifier) relayRegistrationStatus.set(message.publicIdentifier, entry)
  }
}

function recordOpenJoinContext({ publicIdentifier, fileSharing, relayKey, relayUrl } = {}) {
  if (!publicIdentifier) return
  const current = openJoinContexts.get(publicIdentifier) || { publicIdentifier }
  openJoinContexts.set(publicIdentifier, {
    ...current,
    fileSharing: typeof fileSharing === 'boolean' ? fileSharing : current.fileSharing,
    relayKey: relayKey ?? current.relayKey ?? null,
    relayUrl: relayUrl ?? current.relayUrl ?? null
  })
}

function trackOpenJoinReauthState(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'join-auth-success') {
    const data = message.data || {}
    const identifier = data.publicIdentifier
    if (!identifier) return
    recordOpenJoinContext({
      publicIdentifier: identifier,
      relayKey: data.relayKey || null,
      relayUrl: data.relayUrl || null
    })
    if (data.provisional) {
      const context = openJoinContexts.get(identifier) || { publicIdentifier: identifier }
      pendingOpenJoinReauth.set(identifier, {
        ...context,
        relayKey: data.relayKey || context.relayKey || null,
        relayUrl: data.relayUrl || context.relayUrl || null,
        lastAttempt: 0,
        inFlight: false
      })
    } else {
      pendingOpenJoinReauth.delete(identifier)
      openJoinContexts.delete(identifier)
    }
    return
  }

  if (message.type === 'join-auth-error') {
    const identifier = message?.data?.publicIdentifier
    if (!identifier) return
    const entry = pendingOpenJoinReauth.get(identifier)
    if (entry) {
      pendingOpenJoinReauth.set(identifier, {
        ...entry,
        inFlight: false,
        lastAttempt: Date.now()
      })
    }
  }
}

async function maybeReauthOpenJoins(status) {
  if (!relayServer || !pendingOpenJoinReauth.size) return
  if (!status?.peerRelayMap) return
  const now = Date.now()
  for (const [identifier, entry] of pendingOpenJoinReauth.entries()) {
    if (!identifier || entry?.inFlight) continue
    if (entry?.lastAttempt && now - entry.lastAttempt < OPEN_JOIN_REAUTH_MIN_INTERVAL_MS) continue
    const hostPeers = resolveHostPeersFromGatewayStatus(status, identifier)
    if (!hostPeers.length) continue
    pendingOpenJoinReauth.set(identifier, { ...entry, inFlight: true, lastAttempt: now })
    console.log('[Worker] Reauthing open join with host peers', {
      publicIdentifier: identifier,
      hostPeersCount: hostPeers.length
    })
    try {
      await relayServer.startJoinAuthentication({
        publicIdentifier: identifier,
        fileSharing: entry?.fileSharing !== false,
        relayKey: entry?.relayKey || undefined,
        relayUrl: entry?.relayUrl || undefined,
        hostPeers,
        openJoin: false
      })
    } catch (err) {
      console.warn('[Worker] Open join reauth attempt failed', err?.message || err)
      pendingOpenJoinReauth.set(identifier, { ...entry, inFlight: false, lastAttempt: Date.now() })
    }
  }
}

const sendMessage = (message) => {
  if (isShuttingDown) return

  trackRegistrationStatus(message)
  trackOpenJoinReauthState(message)

  if (workerPipe) {
    const messageStr = JSON.stringify(message) + '\n'
    console.log('[Worker] Sending message:', messageStr.trim())
    try {
      workerPipe.write(messageStr)
    } catch (err) {
      console.error('[Worker] Error writing to pear pipe:', err)
    }
    return
  }

  if (typeof process.send === 'function') {
    try {
      process.send(message)
    } catch (err) {
      console.error('[Worker] Error sending IPC message:', err)
    }
    return
  }

  try {
    console.log('[Worker] IPC unavailable, message:', JSON.stringify(message))
  } catch (_) {
    console.log('[Worker] IPC unavailable, message sent but not serialized')
  }
}

let workerStatusState = {
  user: null,
  app: {
    initialized: false,
    mode: 'hyperswarm',
    shuttingDown: false
  },
  gateway: {
    ready: false,
    running: false
  },
  relays: {
    expected: 0,
    active: 0
  }
}

function mergeWorkerStatusState(patch = null) {
  if (!patch || typeof patch !== 'object') return

  if ('user' in patch) {
    workerStatusState.user = patch.user ? { ...(workerStatusState.user || {}), ...patch.user } : null
  }
  if (patch.app) {
    workerStatusState.app = { ...workerStatusState.app, ...patch.app }
  }
  if (patch.gateway) {
    workerStatusState.gateway = { ...workerStatusState.gateway, ...patch.gateway }
  }
  if (patch.relays) {
    workerStatusState.relays = { ...workerStatusState.relays, ...patch.relays }
  }
}

function sendWorkerStatus(phase, message, { statePatch = null, legacy = null, error = null } = {}) {
  mergeWorkerStatusState(statePatch)

  const payload = {
    type: 'status',
    v: WORKER_MESSAGE_VERSION,
    ts: Date.now(),
    sessionId: WORKER_SESSION_ID,
    phase,
    message: message || '',
    state: workerStatusState
  }

  if (legacy && typeof legacy === 'object') {
    Object.assign(payload, legacy)
  }

  if (error) {
    payload.error = {
      message: error?.message || String(error),
      stack: error?.stack || null
    }
  }

  sendMessage(payload)
}

function sendConfigAppliedV1(data) {
  sendMessage({
    type: 'config-applied',
    v: WORKER_MESSAGE_VERSION,
    ts: Date.now(),
    sessionId: WORKER_SESSION_ID,
    data
  })
}

const configWaiters = []

function notifyConfigWaiters(configData) {
  if (!configWaiters.length) return
  const waiters = configWaiters.splice(0, configWaiters.length)
  for (const waiter of waiters) {
    try {
      waiter(configData)
    } catch (err) {
      console.error('[Worker] Config waiter error:', err)
    }
  }
}

function waitForParentConfig(timeoutMs = 3000) {
  if (configReceived) return Promise.resolve(storedParentConfig)
  return new Promise((resolve) => {
    let settled = false
    const resolver = (configData) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const index = configWaiters.indexOf(resolver)
      if (index !== -1) configWaiters.splice(index, 1)
      resolve(configData)
    }

	    const timeout = setTimeout(() => {
	      if (settled) return
	      settled = true
	      const index = configWaiters.indexOf(resolver)
	      if (index !== -1) configWaiters.splice(index, 1)
	      const requiresParentConfig = process.env.ELECTRON_RUN_AS_NODE === '1'
	      console.log('[Worker] Config wait timeout' + (requiresParentConfig ? '' : ' - proceeding with defaults'))
	      resolve(null)
	    }, timeoutMs)

    configWaiters.push(resolver)
  })
}

async function logToFile (filepath, line) {
  try {
    await fs.mkdir(barePathDirname(filepath), { recursive: true }).catch(() => {})
  } catch (_) {}
  try {
    await fs.appendFile(filepath, line + '\n')
  } catch (err) {
    console.error('[Worker] Failed to append health log:', err)
  }
}

function barePathDirname (p) {
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return '/' + parts.join('/')
}

function addMembersToRelays(relays) {
  return relays.map(r => ({
    ...r,
    members: relayMembers.get(r.relayKey) || []
  }))
}

async function addAuthInfoToRelays(relays) {
  try {
    const profiles = await getAllRelayProfiles(global.userConfig?.userKey)
    const authStore = getRelayAuthStore()
    return relays.map(r => {
      const profile = profiles.find(p => p.relay_key === r.relayKey) || {}

      let token = null
      if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
        // Calculate authorized users from auth_adds and auth_removes
        // const { calculateAuthorizedUsers } = require('./hypertuna-relay-profile-manager-bare.mjs')
        const authorizedUsers = calculateAuthorizedUsers(
          profile.auth_config.auth_adds || [],
          profile.auth_config.auth_removes || []
        )
        
        const userAuth = authorizedUsers.find(
          u => u.pubkey === config.nostr_pubkey_hex
        )
        token = userAuth?.token || null
        
        if (!token && profile.auth_tokens && profile.auth_tokens[config.nostr_pubkey_hex]) {
          // Fallback to legacy auth_tokens if present
          token = profile.auth_tokens[config.nostr_pubkey_hex]
        }
        
        if (token) {
          console.log(`[Worker] Found auth token for user on relay ${r.relayKey}`)
        } else {
          console.log(`[Worker] No auth token found for user on relay ${r.relayKey}`)
        }
      }

      // Fallback: pull token from auth store if available
      let tokenFromStore = null
      if (!token && config?.nostr_pubkey_hex && authStore) {
        try {
          // Some auth stores expose a getter; others rely on verifyAuth
          if (typeof authStore.getAuthToken === 'function') {
            tokenFromStore = authStore.getAuthToken(r.relayKey, config.nostr_pubkey_hex)
            if (tokenFromStore) token = tokenFromStore
          } else if (typeof authStore.verifyAuth === 'function') {
            const auth = authStore.verifyAuth(r.relayKey, config.nostr_pubkey_hex)
            if (auth && auth.token) {
              tokenFromStore = auth.token
              token = auth.token
            }
          }
          if (token) {
            console.log(`[Worker] Using auth token from auth store for relay ${r.relayKey}`)
          }
        } catch (err) {
          console.warn('[Worker] Failed to read auth token from store:', err?.message || err)
        }
      }

      const identifierPath = profile.public_identifier
        ? profile.public_identifier.replace(':', '/')
        : r.relayKey

      const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`
      const connectionUrl = token ? `${baseUrl}?token=${token}` : baseUrl

      console.log('[Worker][addAuthInfoToRelays]', {
        relayKey: r.relayKey,
        publicIdentifier: profile.public_identifier || null,
        requiresAuth: !!profile.auth_config?.requiresAuth,
        fromProfileToken: !!token, // token derived above (profile auth_adds/auth_tokens)
        fromLegacyToken: !!(profile.auth_tokens && profile.auth_tokens[config.nostr_pubkey_hex]),
        fromStoreToken: !!tokenFromStore,
        tokenApplied: !!token,
        connectionUrl,
        userAuthToken: token
      })

      const statusEntry = relayRegistrationStatus.get(r.relayKey)
        || (profile.public_identifier ? relayRegistrationStatus.get(profile.public_identifier) : null)
        || null

      return {
        ...r,
        publicIdentifier: profile.public_identifier || null,
        connectionUrl,
        userAuthToken: token,
        requiresAuth: profile.auth_config?.requiresAuth || false,
        registrationStatus: statusEntry?.status || 'unknown',
        registrationError: statusEntry?.error || null
      }
    })
  } catch (err) {
    console.error('[Worker] Failed to add auth info to relays:', err)
    return relays
  }
}

async function reconcileRelayFiles() {
  for (const [relayKey, manager] of activeRelays.entries()) {
    if (relayKey === 'public-gateway:hyperbee') {
      continue;
    }
    if (typeof manager?.relay?.queryFilekeyIndex !== 'function') {
      continue;
    }
    let fileMap
    try {
      fileMap = await manager.relay.queryFilekeyIndex()
    } catch (err) {
      console.error(`[Worker] Failed to query filekey index for ${relayKey}:`, err)
      continue
    }

    // Debug sample of filekey index
    try {
      const sample = []
      for (const [fh, dm] of fileMap.entries()) {
        sample.push({ fileHash: fh, drives: Array.from(dm.keys()) })
        if (sample.length >= 5) break
      }
      console.log(`[Reconcile] relay ${relayKey}: filekey sample ${JSON.stringify(sample)}`)
    } catch (_) {}

    const seen = seenFileHashes.get(relayKey) || new Set()
    // Prefer publicIdentifier path if available for this relay
    let identifier = relayKey
    try {
      const profile = await getRelayProfileByKey(relayKey)
      if (profile?.public_identifier) identifier = profile.public_identifier
    } catch (_) {}

    for (const [fileHash, driveMap] of fileMap.entries()) {
      if (seen.has(fileHash)) continue

      let exists = null
      try {
        exists = await getFile(identifier, fileHash)
      } catch (err) {
        console.error(`[Worker] Error checking file ${fileHash} for relay ${relayKey}:`, err)
      }

      if (exists) {
        console.log(`[Worker] Deduped file ${fileHash} for relay ${relayKey}`)
        seen.add(fileHash)
        continue
      }

      let stored = false
      for (const [driveKey] of driveMap.entries()) {
        console.log(`[Reconcile] attempt fetch file=${fileHash} from drive=${driveKey} folder=/${identifier}`)
        for (let attempt = 0; attempt < 3 && !stored; attempt++) {
          try {
            const data = await fetchFileFromDrive(driveKey, identifier, fileHash)
            if (!data) throw new Error('File not found')
            await storeFile(identifier, fileHash, data, { sourceDrive: driveKey })
            stored = true
            break
          } catch (err) {
            console.error(`[Worker] Failed to download ${fileHash} from ${driveKey} (attempt ${attempt + 1}):`, err)
          }
        }
        if (stored) break
      }

      if (stored) {
        console.log(`[Worker] Stored file ${fileHash} for relay ${relayKey}`)
        seen.add(fileHash)
      } else {
        console.warn(`[Worker] Unable to retrieve file ${fileHash} for relay ${relayKey}`)
      }
    }

    seenFileHashes.set(relayKey, seen)
  }
}

async function syncRemotePfpMirrors() {
  if (!gatewayService?.getPeersWithPfpDrive) return
  const peers = gatewayService.getPeersWithPfpDrive()
  if (!Array.isArray(peers) || peers.length === 0) return

  const localPfpKey = getPfpDriveKey()
  for (const peer of peers) {
    try {
      if (!peer?.pfpDriveKey) continue
      if (localPfpKey && peer.pfpDriveKey === localPfpKey) continue
      await mirrorPfpDrive(peer.pfpDriveKey)
    } catch (err) {
      console.warn('[Worker] PFP mirror failed for peer', peer?.pfpDriveKey, err?.message || err)
    }
  }
}

async function ensureMirrorsForAllRelays() {
  const total = activeRelays.size
  console.log(`[Mirror] scanning active relays: ${total}`)
  for (const [relayKey, manager] of activeRelays.entries()) {
    if (virtualRelayKeys.has(relayKey)) {
      console.log(`[Mirror] skipping virtual relay ${relayKey} for mirror scan`)
      continue
    }
    console.log(`[Mirror] relay ${relayKey}: collecting providers from filekey index`)
    // Collect all provider drive keys for this relay from the filekey index
    let fileMap
    try {
      fileMap = await manager.relay.queryFilekeyIndex()
    } catch (err) {
      console.error(`[Worker] Mirror: Failed to query filekey index for ${relayKey}:`, err)
      continue
    }

    console.log(`[Mirror] relay ${relayKey}: filekey index size=${fileMap.size}`)
    const providers = new Set()
    for (const [_fileHash, driveMap] of fileMap.entries()) {
      for (const [driveKey] of driveMap.entries()) providers.add(driveKey)
    }
    console.log(`[Mirror] relay ${relayKey}: providers=${providers.size}`)
    try {
      console.log(`[Mirror] relay ${relayKey}: providers list ${JSON.stringify(Array.from(providers))}`)
      const sample = []
      for (const [fh, dm] of fileMap.entries()) {
        sample.push({ fileHash: fh, drives: Array.from(dm.keys()) })
        if (sample.length >= 5) break
      }
      console.log(`[Mirror] relay ${relayKey}: filekey sample ${JSON.stringify(sample)}`)
    } catch (_) {}

    // Determine identifier path (prefer public identifier)
    let identifier = relayKey
    try {
      const profile = await getRelayProfileByKey(relayKey)
      if (profile?.public_identifier) identifier = profile.public_identifier
    } catch (_) {}

    // If no providers indexed, try to backfill from local files, then re-evaluate
    if (providers.size === 0) {
      try { await backfillRelayFilekeyIndex(relayKey, identifier) } catch (e) { console.warn('[Mirror] backfill failed:', e) }
      try {
        const fm2 = await manager.relay.queryFilekeyIndex()
        console.log(`[Mirror] relay ${relayKey}: re-check filekey index size=${fm2.size}`)
        for (const [_fh, dm] of fm2.entries()) {
          for (const [driveKey] of dm.entries()) providers.add(driveKey)
        }
        console.log(`[Mirror] relay ${relayKey}: providers after backfill=${providers.size}`)
        const sample2 = []
        for (const [fh2, dm2] of fm2.entries()) {
          sample2.push({ fileHash: fh2, drives: Array.from(dm2.keys()) })
          if (sample2.length >= 5) break
        }
        console.log(`[Mirror] relay ${relayKey}: filekey sample after backfill ${JSON.stringify(sample2)}`)
      } catch (e) {
        console.warn('[Mirror] re-check providers failed:', e)
      }
    }
    await ensureMirrorsForProviders(providers, identifier)
  }
}

async function backfillRelayFilekeyIndex(relayKey, identifier) {
  if (!config?.driveKey) return
  const pathPrefix = `/${identifier}`
  const { getCorestore } = await import('./hyperdrive-manager.mjs')
  const { default: Hyperdrive } = await import('hyperdrive')
  const store = getCorestore()
  if (!store) return
  // Use the existing local drive from hyperdrive-manager via module cache
  const { getLocalDrive } = await import('./hyperdrive-manager.mjs')
  const localDrive = getLocalDrive()
  if (!localDrive) return

  let count = 0
  for await (const entry of localDrive.list(pathPrefix, { recursive: false })) {
    if (!entry?.value?.blob) continue
    const fileHash = entry.key.split('/').pop()
    console.log(`[Backfill] local entry key=${entry.key} hash=${fileHash}`)
    try {
      await appendFilekeyDbEntry(relayKey, fileHash)
      count++
    } catch (_) {}
  }
  console.log(`[Mirror] backfill for ${relayKey} (${identifier}) added ${count} index entries`)
}

async function collectRelayHealth(relayKey, manager, maxChecks = 200) {
  if (virtualRelayKeys.has(relayKey)) {
    return {
      relayKey,
      skipped: true,
      reason: 'virtual-relay',
      timestamp: Date.now()
    }
  }
  // filekey index map: Map<fileHash, Map<driveKey,pubkey>>
  let fileMap
  try {
    fileMap = await manager.relay.queryFilekeyIndex()
  } catch (err) {
    console.error(`[Worker] Health: queryFilekeyIndex failed for ${relayKey}:`, err)
    return {
      relayKey,
      error: 'queryFilekeyIndex failed',
      timestamp: Date.now()
    }
  }

  const totalFiles = fileMap.size
  let minProviders = Number.POSITIVE_INFINITY
  let maxProviders = 0
  let providerSum = 0

  // Build a deterministic sample set (first N keys)
  const hashes = Array.from(fileMap.keys())
  const sample = hashes.slice(0, Math.max(0, Math.min(maxChecks, hashes.length)))
  let presentLocal = 0

  for (const h of hashes) {
    const providers = fileMap.get(h) || new Map()
    const count = providers.size
    minProviders = Math.min(minProviders, count)
    maxProviders = Math.max(maxProviders, count)
    providerSum += count
  }
  if (!isFinite(minProviders)) minProviders = 0
  const avgProviders = totalFiles > 0 ? providerSum / totalFiles : 0

  for (const h of sample) {
    try {
      // Prefer public identifier for file path resolution
      let identifier = relayKey
      try {
        const profile = await getRelayProfileByKey(relayKey)
        if (profile?.public_identifier) identifier = profile.public_identifier
      } catch (_) {}
      if (await fileExists(identifier, h)) presentLocal++
    } catch (_) {}
  }

  const health = getReplicationHealth()

  const viewVersion = manager?.relay?.view?.version || null

  return {
    relayKey,
    timestamp: Date.now(),
    totals: {
      filesIndexed: totalFiles,
      sampleChecked: sample.length,
      samplePresentLocal: presentLocal
    },
    providers: {
      min: minProviders,
      avg: Number.isFinite(avgProviders) ? Number(avgProviders.toFixed(2)) : 0,
      max: maxProviders
    },
    drive: {
      driveKey: health.driveKey,
      discoveryKey: health.discoveryKey
    },
    swarm: {
      openConnections: health.openConnections,
      totalConnections: health.totalConnections,
      topicsJoined: health.topicsJoined
    },
    relayView: {
      version: viewVersion
    }
  }
}

async function logReplicationHealthOnce() {
  if (!config || !healthLogPath) return
  const entries = []
  for (const [relayKey, manager] of activeRelays.entries()) {
    try {
      const entry = await collectRelayHealth(relayKey, manager)
      entries.push(entry)
    } catch (err) {
      entries.push({ relayKey, timestamp: Date.now(), error: err.message })
    }
  }
  const line = JSON.stringify({ type: 'replication-health', at: Date.now(), entries })
  await logToFile(healthLogPath, line)
}

function startHealthLogger(intervalMs = 60000) {
  if (!config) return
  if (!healthLogPath) {
    const baseDir = config.storage || '.'
    healthLogPath = join(baseDir, 'hyperdrive-replication-health.log')
  }
  if (healthIntervalHandle) clearInterval(healthIntervalHandle)
  // Stagger slightly from reconcile to spread IO
  healthIntervalHandle = setInterval(() => {
    if (!isShuttingDown) {
      logReplicationHealthOnce().catch(err => console.error('[Worker] Health log error:', err))
    }
  }, intervalMs)
}

// Make pipe and sendMessage globally available for the relay server
global.workerPipe = workerPipe
global.sendMessage = sendMessage
global.fetchAndApplyRelayMirrorMetadata = fetchAndApplyRelayMirrorMetadata
global.resolveRelayMirrorCoreRefs = resolveRelayMirrorCoreRefs
global.getRelayMirrorCoreRefsCache = getRelayMirrorCoreRefsCache
global.syncActiveRelayCoreRefs = syncActiveRelayCoreRefs
global.appendOpenJoinMirrorCores = appendOpenJoinMirrorCores
global.requestRelaySubscriptionRefresh = async ({ relayKey = null, reason = 'manual' } = {}) => {
  console.log('[Worker] Subscription refresh requested before relay server ready', {
    relayKey,
    reason
  })
  return { status: 'skipped', reason: 'relay-server-unavailable' }
}
global.onRelayWritable = (payload = {}) => {
  const mode = payload?.mode ? String(payload.mode) : 'unknown'
  console.log('[Worker] Relay writable received; refreshing gateway registry', {
    mode,
    relayKey: payload?.relayKey || null,
    publicIdentifier: payload?.publicIdentifier || null
  })
  refreshGatewayRelayRegistry(`relay-writable-${mode}`).catch((err) => {
    console.warn('[Worker] Gateway registry refresh failed after relay-writable:', err?.message || err)
  })
}

async function handleMessageObject(message) {
  if (message == null) return

  if (typeof message === 'string') {
    try {
      message = JSON.parse(message)
    } catch (err) {
      console.error('[Worker] Failed to parse string message:', err)
      return
    }
  }

  if (Buffer.isBuffer(message)) {
    try {
      const parsed = JSON.parse(message.toString())
      message = parsed
    } catch (err) {
      console.error('[Worker] Failed to parse buffer message:', err)
      return
    }
  }

  if (typeof message !== 'object') {
    console.warn('[Worker] Ignoring non-object message:', message)
    return
  }

  if (message.type === 'config') {
    const pubkey = typeof message.data?.nostr_pubkey_hex === 'string' ? message.data.nostr_pubkey_hex : null
    console.log('[Worker] Received from parent: config', {
      pubkeyHex: pubkey ? `${pubkey.slice(0, 8)}...` : null,
      hasNsecHex: typeof message.data?.nostr_nsec_hex === 'string',
      hasStorage: typeof message.data?.storage === 'string'
    })
  } else {
    console.log('[Worker] Received from parent:', { type: message.type })
  }

  if (message.type === 'config') {
    storedParentConfig = message.data
    if (!configReceived) {
      configReceived = true
      const pubkey = typeof storedParentConfig?.nostr_pubkey_hex === 'string' ? storedParentConfig.nostr_pubkey_hex : null
      console.log('[Worker] Stored parent config (sanitized):', {
        pubkeyHex: pubkey ? `${pubkey.slice(0, 8)}...` : null,
        hasNsecHex: typeof storedParentConfig?.nostr_nsec_hex === 'string',
        hasStorage: typeof storedParentConfig?.storage === 'string'
      })
      notifyConfigWaiters(message.data)
      return
    }
  }

  switch (message.type) {
    case 'get-replication-health': {
      try {
        const entries = []
        for (const [relayKey, manager] of activeRelays.entries()) {
          entries.push(await collectRelayHealth(relayKey, manager, message.maxChecks || 200))
        }
        sendMessage({ type: 'replication-health', data: { entries, logPath: healthLogPath } })
      } catch (err) {
        sendMessage({ type: 'error', message: `get-replication-health failed: ${err.message}` })
      }
      break
    }

    case 'set-replication-health-interval': {
      const ms = Math.max(5000, Number(message.intervalMs) || 60000)
      startHealthLogger(ms)
      sendMessage({ type: 'replication-health-interval-set', intervalMs: ms, logPath: healthLogPath })
      break
    }

    case 'start-gateway': {
      try {
        await startGatewayService(message.options || {})
        sendMessage({ type: 'gateway-started', status: getGatewayStatus() })
      } catch (err) {
        sendMessage({ type: 'gateway-error', message: err.message })
      }
      break
    }

    case 'stop-gateway': {
      try {
        await stopGatewayService()
        sendMessage({ type: 'gateway-stopped', status: getGatewayStatus() })
      } catch (err) {
        sendMessage({ type: 'gateway-error', message: err.message })
      }
      break
    }

    case 'get-gateway-status': {
      sendMessage({ type: 'gateway-status', status: getGatewayStatus() })
      break
    }

    case 'get-gateway-logs': {
      sendMessage({ type: 'gateway-logs', logs: getGatewayLogs() })
      break
    }

    case 'get-public-gateway-config': {
      await ensurePublicGatewaySettingsLoaded()
      sendMessage({ type: 'public-gateway-config', config: publicGatewaySettings })
      break
    }

    case 'set-public-gateway-config': {
      await ensurePublicGatewaySettingsLoaded()
      try {
        const next = await updatePublicGatewaySettings(message.config || {})
        publicGatewaySettings = next
        if (blindPeeringManager) {
          blindPeeringManager.configure(next)
          if (Array.isArray(next.blindPeerKeys) && next.blindPeerKeys.length) {
            blindPeeringManager.markTrustedMirrors(next.blindPeerKeys)
          }
          if (blindPeeringManager.enabled && !blindPeeringManager.started) {
            try {
              await blindPeeringManager.start({
                corestore: getCorestore(),
                wakeup: null
              })
            } catch (err) {
              console.warn('[Worker] Failed to restart blind peering manager after config update:', err?.message || err)
            }
          } else if (!blindPeeringManager.enabled && blindPeeringManager.started) {
            try {
              await blindPeeringManager.clearAllMirrors({ reason: 'config-disabled' })
            } catch (err) {
              console.warn('[Worker] Failed to clear blind peering mirrors after config disable:', err?.message || err)
            }
            await blindPeeringManager.stop()
          }
        }
        if (gatewayService) {
          await gatewayService.updatePublicGatewayConfig(next)
          publicGatewayStatusCache = gatewayService.getPublicGatewayState()
          sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
        }
        sendMessage({ type: 'public-gateway-config', config: next })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
      break
    }

    case 'get-public-gateway-status': {
      if (gatewayService) {
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } else if (publicGatewayStatusCache) {
        sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
      } else {
        await ensurePublicGatewaySettingsLoaded()
        sendMessage({
          type: 'public-gateway-status',
          state: {
            enabled: !!publicGatewaySettings?.enabled,
            baseUrl: publicGatewaySettings?.baseUrl || null,
            defaultTokenTtl: publicGatewaySettings?.defaultTokenTtl || 3600,
            wsBase: null,
            lastUpdatedAt: null,
            relays: {}
          }
        })
      }
      break
    }

    case 'get-blind-peering-status': {
      try {
        const manager = await ensureBlindPeeringManager()
        const status = manager ? manager.getStatus() : { enabled: false, running: false }
        const metadata = manager ? manager.getMirrorMetadata() : null
        sendMessage({ type: 'blind-peering-status', status, metadata })
      } catch (err) {
        sendMessage({ type: 'error', message: `blind-peering-status failed: ${err.message}` })
      }
      break
    }

    case 'generate-public-gateway-token': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        const result = gatewayService.issuePublicGatewayToken(message.relayKey, {
          ttlSeconds: message.ttlSeconds
        })
        sendMessage({ type: 'public-gateway-token', result })
      } catch (err) {
        sendMessage({
          type: 'public-gateway-token-error',
          relayKey: message.relayKey || null,
          error: err.message
        })
      }
      break
    }

    case 'refresh-public-gateway-relay': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        await gatewayService.syncPublicGatewayRelay(message.relayKey)
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
      break
    }

    case 'refresh-public-gateway-all': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        await gatewayService.resyncPublicGateway()
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
      break
    }

    case 'upload-file': {
      try {
        const { relayKey, identifier: idFromMsg, publicIdentifier, fileHash, metadata, buffer } = message.data || {}
        const identifier = idFromMsg || publicIdentifier || relayKey
        if (!identifier || !fileHash || !buffer) throw new Error('Missing identifier/publicIdentifier, fileHash, or buffer')
        console.log(`[Upload] begin relayKey=${relayKey} identifier=${identifier} fileHash=${fileHash} metaKeys=${metadata ? Object.keys(metadata) : 'none'} bufLen=${buffer?.length}`)
        const data = b4a.from(buffer, 'base64')
        await ensureRelayFolder(identifier)
        await storeFile(identifier, fileHash, data, metadata || null)
        let resolvedRelayKey = relayKey
        if (!resolvedRelayKey && identifier && !/^[a-fA-F0-9]{64}$/.test(identifier)) {
          try { resolvedRelayKey = await getRelayKeyFromPublicIdentifier(identifier) } catch (_) {}
        }
        if (resolvedRelayKey) {
          await appendFilekeyDbEntry(resolvedRelayKey, fileHash)
          ensureMirrorsForAllRelays().catch(err => console.warn('[Mirror] ensure after upload failed:', err))
        } else {
          console.warn('[Worker] upload-file: could not resolve relayKey for identifier', identifier)
        }
        console.log(`[Upload] complete relayKey=${resolvedRelayKey || relayKey} identifier=${identifier} fileHash=${fileHash}`)
        sendMessage({ type: 'upload-file-complete', relayKey: resolvedRelayKey || null, identifier, fileHash })
      } catch (err) {
        console.error('[Worker] upload-file error:', err)
        sendMessage({ type: 'error', message: `upload-file failed: ${err.message}` })
      }
      break
    }

    case 'upload-pfp': {
      const payload = message?.data || {}
      const ownerRaw = typeof payload.owner === 'string' ? payload.owner : ''
      const ownerKey = ownerRaw.trim()
      try {
        const { fileHash, metadata, buffer } = payload
        if (!fileHash || !buffer) throw new Error('Missing fileHash or buffer')
        console.log(`[UploadPfp] begin owner=${ownerKey || 'root'} fileHash=${fileHash} bufLen=${buffer?.length}`)
        const data = b4a.from(buffer, 'base64')
        await storePfpFile(ownerKey, fileHash, data, metadata || null)
        sendMessage({ type: 'upload-pfp-complete', owner: ownerKey, fileHash })
      } catch (err) {
        console.error('[Worker] upload-pfp error:', err)
        sendMessage({ type: 'upload-pfp-error', owner: ownerKey, fileHash: payload?.fileHash || null, error: err?.message || String(err) })
        sendMessage({ type: 'error', message: `upload-pfp failed: ${err.message}` })
      }
      break
    }

    case 'crypto-encrypt': {
      const { requestId, privkey, pubkey, plaintext } = message || {}
      try {
        if (!requestId) throw new Error('Missing requestId')
        if (!privkey || !pubkey) throw new Error('Missing keys for encryption')
        const result = encryptSharedSecretToString(privkey, pubkey, plaintext)
        sendMessage({ type: 'crypto-response', requestId, success: true, result })
      } catch (err) {
        sendMessage({
          type: 'crypto-response',
          requestId: message?.requestId || null,
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'crypto-decrypt': {
      const { requestId, privkey, pubkey, ciphertext } = message || {}
      try {
        if (!requestId) throw new Error('Missing requestId')
        if (!privkey || !pubkey) throw new Error('Missing keys for decryption')
        if (typeof ciphertext !== 'string') throw new Error('Missing ciphertext payload')
        const result = decryptSharedSecretFromString(privkey, pubkey, ciphertext)
        sendMessage({ type: 'crypto-response', requestId, success: true, result })
      } catch (err) {
        sendMessage({
          type: 'crypto-response',
          requestId: message?.requestId || null,
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'shutdown':
      console.log('[Worker] Shutdown requested')
      isShuttingDown = true
      sendWorkerStatus('stopping', 'Shutting down...', {
        statePatch: { app: { shuttingDown: true } }
      })
      await cleanup()
      process.exit(0)
      break

    case 'config':
      console.log('[Worker] Received additional config message (ignored)')
      break

    case 'create-relay':
      console.log('[Worker] Create relay requested:', message.data)
      if (relayServer) {
        try {
          const result = await relayServer.createRelay(message.data)
          relayMembers.set(result.relayKey, result.profile?.members || [])
          await ensureRelayFolder(result.profile?.public_identifier || result.relayKey)
          await applyPendingAuthUpdates(updateRelayAuthToken, result.relayKey, result.profile?.public_identifier)

          sendMessage({
            type: 'relay-created',
            data: {
              ...result,
              members: relayMembers.get(result.relayKey) || []
            }
          })

          if (result.gatewayRegistration === 'failed') {
            sendMessage({
              type: 'relay-registration-failed',
              relayKey: result.relayKey,
              publicIdentifier: result.publicIdentifier || null,
              error: result.registrationError || 'Gateway registration failed'
            })
          }

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          await syncGatewayPeerMetadata('relay-created', { relays: relaysAuth })
          console.log('[Worker][relay-update][relay-created] sending', relaysAuth.map(r => ({
            relayKey: r.relayKey,
            publicIdentifier: r.publicIdentifier,
            connectionUrl: r.connectionUrl,
            userAuthToken: r.userAuthToken,
            requiresAuth: r.requiresAuth
          })))
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to create relay: ${err.message}`
          })
        }
      } else {
        sendMessage({
          type: 'error',
          message: 'Relay server not initialized'
        })
      }
      break

    case 'join-relay':
      console.log('[Worker] Join relay requested:', message.data)
      if (relayServer) {
        try {
          const result = await relayServer.joinRelay(message.data)
          relayMembers.set(result.relayKey, result.profile?.members || [])
          await ensureRelayFolder(result.profile?.public_identifier || result.relayKey)
          await applyPendingAuthUpdates(updateRelayAuthToken, result.relayKey, result.profile?.public_identifier)

          sendMessage({
            type: 'relay-joined',
            data: {
              ...result,
              members: relayMembers.get(result.relayKey) || []
            }
          })

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          await syncGatewayPeerMetadata('relay-joined', { relays: relaysAuth })
          console.log('[Worker][relay-update][relay-joined] sending', relaysAuth.map(r => ({
            relayKey: r.relayKey,
            publicIdentifier: r.publicIdentifier,
            connectionUrl: r.connectionUrl,
            userAuthToken: r.userAuthToken,
            requiresAuth: r.requiresAuth
          })))
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to join relay: ${err.message}`
          })
        }
      } else {
        sendMessage({
          type: 'error',
          message: 'Relay server not initialized'
        })
      }
      break

    case 'disconnect-relay':
      console.log('[Worker] Disconnect relay requested:', message.data)
      if (relayServer && message?.data?.relayKey) {
        const relayKey = message.data.relayKey
        const relayManagerInstance = activeRelays.get(relayKey)
        const publicIdentifier = message.data?.publicIdentifier || keyToPublic.get(relayKey) || null
        try {
          const result = await relayServer.disconnectRelay(relayKey)

          detachRelayMirrorHooks(relayManagerInstance)
          try {
            const manager = await ensureBlindPeeringManager()
            if (manager?.started) {
              await manager.removeRelayMirror({
                relayKey,
                publicIdentifier,
                autobase: relayManagerInstance?.relay || null
              }, { reason: 'manual-disconnect' })
            }
          } catch (mirrorError) {
            console.warn('[Worker] Blind peering mirror removal on disconnect failed:', mirrorError?.message || mirrorError)
          }

          sendMessage({
            type: 'relay-disconnected',
            data: result
          })

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          await syncGatewayPeerMetadata('relay-disconnected', { relays: relaysAuth })
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to disconnect relay: ${err.message}`
          })

          if (relayManagerInstance && relayManagerInstance.relay) {
            attachRelayMirrorHooks(relayKey, relayManagerInstance, blindPeeringManager)
          }
        }
      }
      break

    case 'start-join-flow':
      if (relayServer) {
        const data = (message && typeof message === 'object' ? message.data : null) || {}
        const publicIdentifier = data.publicIdentifier
        const fileSharing = data.fileSharing
        const openJoinAllowed = data.openJoin === true
        const isOpen =
          typeof data.isOpen === 'boolean'
            ? data.isOpen
            : openJoinAllowed
              ? true
              : undefined
        const inviteToken = typeof data.token === 'string' ? data.token.trim() : null
        const inviteProof = normalizeInviteProof(data.inviteProof)
        const hasInviteProof = !!inviteProof
        const closedInvite = !openJoinAllowed && !!inviteToken
        const openJoin = openJoinAllowed || (closedInvite && hasInviteProof)
        try {
          let hostPeers = Array.isArray(data.hostPeers) ? data.hostPeers : []
          const coreRefsInput = closedInvite
            ? []
            : (Array.isArray(data.cores) ? data.cores : [])
          const coreRefsInputStats = normalizeCoreRefListWithStats(coreRefsInput, {
            context: {
              phase: 'join-flow-input',
              publicIdentifier,
              openJoin,
              closedInvite
            },
            log: console
          })
          let coreRefs = coreRefsInputStats.normalized
          let blindPeer = closedInvite ? null : sanitizeBlindPeerMeta(data.blindPeer)
          let joinRelayKey = normalizeRelayKeyHex(data.relayKey)
          let joinRelayUrl = data.relayUrl || null
          let writerCore = closedInvite ? null : (data.writerCore || null)
          let writerSecret = closedInvite ? null : (data.writerSecret || null)
          let writerCoreHex = closedInvite
            ? null
            : (data.writerCoreHex ||
              data.writer_core_hex ||
              data.autobaseLocal ||
              data.autobase_local ||
              null)
          let autobaseLocal = closedInvite
            ? null
            : (data.autobaseLocal || data.autobase_local || null)
          if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
          if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal
          hostPeers = hostPeers
            .map((key) => String(key || '').trim().toLowerCase())
            .filter(Boolean)

          console.info('[Worker] Start join flow input', {
            publicIdentifier,
            openJoin,
            closedInvite,
            isOpen,
            hasInviteToken: !!inviteToken,
            hasInviteProof,
            relayKey: previewValue(joinRelayKey, 16),
            relayUrl: joinRelayUrl ? String(joinRelayUrl).slice(0, 80) : null,
            hostPeersCount: hostPeers.length,
            hasBlindPeer: !!blindPeer?.publicKey,
            coreRefsCount: coreRefs.length,
            coreRefsInputCount: coreRefsInputStats.inputCount,
            coreRefsDropped: coreRefsInputStats.droppedCount,
            coreRefsInvalid: coreRefsInputStats.invalidCount,
            coreRefsDuplicates: coreRefsInputStats.duplicateCount,
            coreRefsPreview: summarizeCoreRefs(coreRefs),
            writerCorePrefix: previewValue(writerCore, 16),
            writerCoreHexPrefix: previewValue(writerCoreHex || autobaseLocal, 16),
            writerSecretLen: writerSecret ? String(writerSecret).length : 0
          })

          if (openJoin && publicIdentifier) {
            recordOpenJoinContext({
              publicIdentifier,
              fileSharing: fileSharing !== false,
              relayKey: joinRelayKey,
              relayUrl: joinRelayUrl
            })
          }

          const shouldAttemptOpenJoinBootstrap = openJoin && (!writerCore || !writerSecret)
          if (shouldAttemptOpenJoinBootstrap) {
            const relayIdentifier = joinRelayKey || publicIdentifier
            if (relayIdentifier) {
              try {
                await ensurePublicGatewaySettingsLoaded()
                const bootstrapResult = await fetchOpenJoinBootstrap(relayIdentifier, {
                  reason: closedInvite && hasInviteProof ? 'invite-join' : 'open-join',
                  inviteProof
                })
                if (bootstrapResult?.status === 'ok' && bootstrapResult.data) {
                  const bootstrapData = bootstrapResult.data
                  const bootstrapBlindPeer = sanitizeBlindPeerMeta(bootstrapData.blindPeer)
                  const bootstrapCoreStats = normalizeCoreRefListWithStats(bootstrapData.cores, {
                    context: {
                      phase: 'open-join-bootstrap',
                      relayIdentifier,
                      publicIdentifier
                    },
                    log: console
                  })
                  const bootstrapCoreRefs = bootstrapCoreStats.normalized
                  const bootstrapRelayKey = normalizeRelayKeyHex(
                    bootstrapData.relayKey || bootstrapData.relay_key || null
                  )
                  if (!joinRelayKey && bootstrapRelayKey) joinRelayKey = bootstrapRelayKey
                  if (!joinRelayUrl && bootstrapData.relayUrl) joinRelayUrl = String(bootstrapData.relayUrl)
                  if (!writerCore && bootstrapData.writerCore) writerCore = String(bootstrapData.writerCore)
                  if (!writerCoreHex && (bootstrapData.writerCoreHex || bootstrapData.writer_core_hex)) {
                    writerCoreHex = String(bootstrapData.writerCoreHex || bootstrapData.writer_core_hex)
                  }
                  if (!autobaseLocal && (bootstrapData.autobaseLocal || bootstrapData.autobase_local)) {
                    autobaseLocal = String(bootstrapData.autobaseLocal || bootstrapData.autobase_local)
                  }
                  if (!writerSecret && bootstrapData.writerSecret) writerSecret = String(bootstrapData.writerSecret)
                  if (!blindPeer && bootstrapBlindPeer) blindPeer = bootstrapBlindPeer
                  if (!coreRefs.length && bootstrapCoreRefs.length) coreRefs = bootstrapCoreRefs
                  if (openJoin && publicIdentifier) {
                    recordOpenJoinContext({
                      publicIdentifier,
                      fileSharing: fileSharing !== false,
                      relayKey: joinRelayKey,
                      relayUrl: joinRelayUrl
                    })
                  }
                  console.log('[Worker] Open join bootstrap fetched', {
                    relayIdentifier,
                    relayKey: joinRelayKey ? String(joinRelayKey).slice(0, 16) : null,
                    hasWriterCore: !!writerCore,
                    hasWriterCoreHex: !!writerCoreHex,
                    hasAutobaseLocal: !!autobaseLocal,
                    hasWriterSecret: !!writerSecret,
                    hasBlindPeer: !!blindPeer
                  })
                  console.log('[Worker] Open join bootstrap resolved', {
                    relayIdentifier,
                    origin: bootstrapResult?.origin || null,
                    relayKey: previewValue(joinRelayKey, 16),
                    relayUrl: joinRelayUrl ? String(joinRelayUrl).slice(0, 80) : null,
                    coreRefsCount: coreRefs.length,
                    bootstrapCoreRefsInput: bootstrapCoreStats.inputCount,
                    bootstrapCoreRefsDropped: bootstrapCoreStats.droppedCount,
                    coreRefsPreview: summarizeCoreRefs(coreRefs),
                    writerCorePrefix: previewValue(writerCore, 16),
                    writerCoreHexPrefix: previewValue(writerCoreHex || autobaseLocal, 16),
                    writerSecretLen: writerSecret ? String(writerSecret).length : 0,
                    blindPeerKey: previewValue(blindPeer?.publicKey, 16),
                    blindPeerHasEncryptionKey: !!blindPeer?.encryptionKey
                  })
                } else {
                  console.warn('[Worker] Open join bootstrap unavailable', {
                    relayIdentifier,
                    status: bootstrapResult?.status || 'unknown',
                    reason: bootstrapResult?.reason || null,
                    error: bootstrapResult?.error || null
                  })
                }
              } catch (err) {
                console.warn('[Worker] Open join bootstrap failed', err?.message || err)
              }
            }
          }

          const shouldFetchMirror = (!hostPeers || hostPeers.length === 0)
            && (!blindPeer || !blindPeer.publicKey)
          if (shouldFetchMirror) {
            const relayIdentifier = joinRelayKey || publicIdentifier
            if (relayIdentifier) {
              try {
                await ensurePublicGatewaySettingsLoaded()
                const mirrorResult = await fetchRelayMirrorMetadata(relayIdentifier, { reason: 'join-flow' })
                if (mirrorResult?.status === 'ok' && mirrorResult.data) {
                  const mirrorData = mirrorResult.data
                  const mirrorBlindPeer = sanitizeBlindPeerMeta(mirrorData.blindPeer)
                  const mirrorCoreStats = normalizeCoreRefListWithStats(mirrorData.cores, {
                    context: {
                      phase: 'join-flow-mirror',
                      relayIdentifier,
                      publicIdentifier,
                      closedInvite
                    },
                    log: console
                  })
                  const mirrorCoreRefs = mirrorCoreStats.normalized
                  const mirrorRelayKey = normalizeRelayKeyHex(
                    mirrorData.relayKey || mirrorData.relay_key || null
                  )
                  if (!joinRelayKey && mirrorRelayKey) joinRelayKey = mirrorRelayKey
                  if (!blindPeer && mirrorBlindPeer) blindPeer = mirrorBlindPeer
                  const coreRefsBefore = coreRefs.length
                  if (mirrorCoreRefs.length && !coreRefs.length) {
                    coreRefs = mirrorCoreRefs
                  }
                  const coreRefsAdded = Math.max(coreRefs.length - coreRefsBefore, 0)
                  if (!writerCore && mirrorData.writerCore) writerCore = String(mirrorData.writerCore)
                  if (!writerCoreHex && (mirrorData.writerCoreHex || mirrorData.writer_core_hex)) {
                    writerCoreHex = String(mirrorData.writerCoreHex || mirrorData.writer_core_hex)
                  }
                  if (!autobaseLocal && (mirrorData.autobaseLocal || mirrorData.autobase_local)) {
                    autobaseLocal = String(mirrorData.autobaseLocal || mirrorData.autobase_local)
                  }
                  if (!writerSecret && mirrorData.writerSecret) writerSecret = String(mirrorData.writerSecret)
                  if (openJoin && publicIdentifier) {
                    recordOpenJoinContext({
                      publicIdentifier,
                      fileSharing: fileSharing !== false,
                      relayKey: joinRelayKey,
                      relayUrl: joinRelayUrl
                    })
                  }
                  console.log('[Worker] Mirror metadata fetched for join flow', {
                    relayIdentifier,
                    hasBlindPeer: !!blindPeer,
                    coreRefsCount: coreRefs.length,
                    mirrorCoreRefsCount: mirrorCoreRefs.length,
                    mirrorCoreRefsInput: mirrorCoreStats.inputCount,
                    mirrorCoreRefsDropped: mirrorCoreStats.droppedCount,
                    coreRefsAdded,
                    closedInvite,
                    relayKey: joinRelayKey ? String(joinRelayKey).slice(0, 16) : null,
                    coreRefsPreview: coreRefs.slice(0, 3),
                    hasWriterCore: !!writerCore,
                    hasWriterCoreHex: !!writerCoreHex,
                    hasAutobaseLocal: !!autobaseLocal,
                    origin: mirrorResult?.origin || null,
                    writerSecretLen: writerSecret ? String(writerSecret).length : 0,
                    blindPeerKey: previewValue(blindPeer?.publicKey, 16),
                    blindPeerHasEncryptionKey: !!blindPeer?.encryptionKey
                  })
                }
              } catch (err) {
                console.warn('[Worker] Failed to fetch mirror metadata for join flow', err?.message || err)
              }
            }
          }

          // Blind-peer fallback: if no host peers but mirror info provided, hydrate mirrors and trust the mirror key.
          if ((!hostPeers || hostPeers.length === 0) && blindPeer && blindPeer.publicKey) {
            try {
              const manager = await ensureBlindPeeringManager()
              if (manager) {
                manager.markTrustedMirrors([blindPeer.publicKey])
                const relayIdentifier = joinRelayKey || publicIdentifier
                const relayCorestore = getRelayCorestore(relayIdentifier, {
                  storageBase: config?.storage || defaultStorageDir
                })
                console.log('[Worker] Blind-peer join flow: using relay corestore', {
                  relayIdentifier,
                  corestoreId: relayCorestore?.__ht_id || null,
                  storagePath: relayCorestore?.__ht_storage_path || null
                })
                manager.ensureRelayMirror({
                  relayKey: relayIdentifier,
                  publicIdentifier,
                  coreRefs,
                  corestore: relayCorestore
                })
                console.log('[Worker] Blind-peer join flow: refreshing mirrors', {
                  relayIdentifier,
                  coreRefsCount: coreRefs.length,
                  timeoutMs: BLIND_PEER_JOIN_REHYDRATION_TIMEOUT_MS,
                  coreRefsPreview: coreRefs.map((key) => String(key).slice(0, 16))
                })
                await manager.refreshFromBlindPeers('join-flow')
                if (typeof manager.primeRelayCoreRefs === 'function' && coreRefs.length) {
                  const primeSummary = await manager.primeRelayCoreRefs({
                    relayKey: relayIdentifier,
                    publicIdentifier,
                    coreRefs,
                    timeoutMs: BLIND_PEER_JOIN_REHYDRATION_TIMEOUT_MS,
                    reason: 'join-flow',
                    corestore: relayCorestore
                  })
                  console.log('[Worker] Blind-peer join flow: core prefetch completed', {
                    relayIdentifier,
                    status: primeSummary?.status ?? null,
                    synced: primeSummary?.synced ?? null,
                    failed: primeSummary?.failed ?? null,
                    connected: primeSummary?.connected ?? null
                  })
                }
                const rehydrateSummary = await rehydrateMirrorsWithRetry(manager, {
                  reason: 'join-flow',
                  timeoutMs: BLIND_PEER_JOIN_REHYDRATION_TIMEOUT_MS,
                  retries: BLIND_PEER_JOIN_REHYDRATION_RETRIES,
                  backoffMs: BLIND_PEER_JOIN_REHYDRATION_BACKOFF_MS
                })
                console.log('[Worker] Blind-peer join flow: rehydration completed', {
                  relayIdentifier,
                  status: rehydrateSummary?.status ?? null,
                  synced: rehydrateSummary?.synced ?? null,
                  failed: rehydrateSummary?.failed ?? null
                })
                hostPeers = [String(blindPeer.publicKey).toLowerCase()]
                console.log('[Worker] Using blind-peer mirror as host peer for join flow', {
                  relayIdentifier,
                  coreRefsCount: coreRefs.length
                })
              }
            } catch (err) {
              console.warn('[Worker] Blind-peer fallback failed', err?.message || err)
            }
          }

          if (!hostPeers.length) {
            hostPeers = resolveHostPeersFromGatewayStatus(getGatewayStatus(), publicIdentifier)
          }

          if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
          if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal

          console.info('[Worker] Start join flow resolved', {
            publicIdentifier,
            openJoin,
            closedInvite,
            isOpen,
            hasInviteToken: !!inviteToken,
            hasInviteProof,
            relayKey: previewValue(joinRelayKey, 16),
            relayUrl: joinRelayUrl ? String(joinRelayUrl).slice(0, 80) : null,
            hostPeersCount: hostPeers.length,
            hasBlindPeer: !!blindPeer?.publicKey,
            coreRefsCount: coreRefs.length,
            coreRefsPreview: summarizeCoreRefs(coreRefs),
            writerCorePrefix: previewValue(writerCore, 16),
            writerCoreHexPrefix: previewValue(writerCoreHex || autobaseLocal, 16),
            writerSecretLen: writerSecret ? String(writerSecret).length : 0
          })

          await relayServer.startJoinAuthentication({
            ...data,
            publicIdentifier,
            fileSharing,
            openJoin,
            isOpen,
            relayKey: joinRelayKey || undefined,
            relayUrl: joinRelayUrl || undefined,
            blindPeer,
            hostPeers,
            coreRefs,
            writerCore,
            writerCoreHex,
            autobaseLocal,
            writerSecret
          })
        } catch (err) {
          sendMessage({
            type: 'join-auth-error',
            data: {
              publicIdentifier,
              error: `Failed to start join flow: ${err.message}`
            }
          })
        }
      } else {
        sendMessage({
          type: 'join-auth-error',
          data: {
            publicIdentifier: message?.data?.publicIdentifier,
            error: 'Relay server not initialized'
          }
        })
      }
      break

    case 'generate-invite-proof':
      try {
        const requestId = message?.requestId
        const data = (message && typeof message === 'object' ? message.data : null) || {}
        await ensurePublicGatewaySettingsLoaded()
        const sharedSecret = publicGatewaySettings?.sharedSecret || null
        if (!sharedSecret) throw new Error('Public gateway shared secret unavailable')

        const relayKey = normalizeRelayKeyHex(data.relayKey) || null
        const publicIdentifier = typeof data.publicIdentifier === 'string' ? data.publicIdentifier.trim() : null
        const inviteePubkey = typeof data.inviteePubkey === 'string' ? data.inviteePubkey.trim() : null
        const authToken = typeof data.authToken === 'string' ? data.authToken : null

        if (!relayKey && !publicIdentifier) {
          throw new Error('Missing relay identifier for invite proof')
        }
        if (!inviteePubkey) {
          throw new Error('Missing invitee pubkey for invite proof')
        }

        const payload = {
          relayKey,
          publicIdentifier,
          inviteePubkey,
          authToken: authToken || null,
          issuedAt: Date.now(),
          version: 1
        }
        const signature = createSignature(payload, sharedSecret)
        const inviteProof = {
          payload,
          signature,
          scheme: 'hmac-sha256'
        }
        sendMessage({ type: 'generate-invite-proof:result', requestId, data: { inviteProof } })
      } catch (err) {
        sendMessage({
          type: 'generate-invite-proof:error',
          requestId: message?.requestId,
          error: err?.message || String(err)
        })
      }
      break

    case 'provision-writer-for-invitee':
      {
        const requestId = message?.requestId
        console.warn('[Worker] Invite writer provisioning disabled; use open-join pool', {
          relayKey: previewValue(message?.data?.relayKey, 16),
          publicIdentifier: message?.data?.publicIdentifier || null
        })
        sendMessage({
          type: 'provision-writer-for-invitee:error',
          requestId,
          error: 'invite-writer-disabled'
        })
      }
      break

    case 'update-members':
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, members, member_adds, member_removes } = message.data
          const id = relayKey || publicIdentifier
          let profile
          if (member_adds || member_removes) {
            profile = await updateRelayMemberSets(id, member_adds || [], member_removes || [])
          } else {
            profile = await updateRelayMembers(id, members)
          }
          if (profile) {
            const finalMembers = profile.members || members
            relayMembers.set(profile.relay_key, finalMembers)
            relayMemberAdds.set(profile.relay_key, profile.member_adds || [])
            relayMemberRemoves.set(profile.relay_key, profile.member_removes || [])
            if (profile.public_identifier) {
              relayMembers.set(profile.public_identifier, finalMembers)
              relayMemberAdds.set(profile.public_identifier, profile.member_adds || [])
              relayMemberRemoves.set(profile.public_identifier, profile.member_removes || [])
            }
            sendMessage({ type: 'members-updated', relayKey: profile.relay_key })
          } else {
            sendMessage({ type: 'error', message: 'Relay profile not found' })
          }
        } catch (err) {
          sendMessage({ type: 'error', message: `Failed to update members: ${err.message}` })
        }
      }
      break

    case 'update-auth-data':
      console.log('[Worker] Update auth data requested:', message.data)
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, pubkey, token } = message.data
          const identifier = relayKey || publicIdentifier
          if (!identifier) {
            throw new Error('No identifier provided for auth data update')
          }
          const updated = await updateRelayAuthToken(identifier, pubkey, token)
          if (!updated) {
            queuePendingAuthUpdate(identifier, pubkey, token)
            console.log(`[Worker] Queued pending auth update for ${identifier}`)
          }
          sendMessage({
            type: 'auth-data-updated',
            identifier: identifier,
            pubkey: pubkey
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to update auth data: ${err.message}`
          })
        }
      }
      break

    case 'get-relays':
      console.log('[Worker] Get relays requested')
      if (relayServer) {
        try {
          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          console.log('[Worker][relay-update][get-relays] sending', relaysAuth.map(r => ({
            relayKey: r.relayKey,
            publicIdentifier: r.publicIdentifier,
            connectionUrl: r.connectionUrl,
            userAuthToken: r.userAuthToken,
            requiresAuth: r.requiresAuth
          })))
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to get relays: ${err.message}`
          })
        }
      }
      break

    case 'remove-auth-data':
      console.log('[Worker] Remove auth data requested:', message.data)
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, pubkey } = message.data
          const identifier = relayKey || publicIdentifier
          if (!identifier) {
            throw new Error('No identifier provided for auth data removal')
          }
          await removeRelayAuth(identifier, pubkey)
          const authStore = getRelayAuthStore()
          authStore.removeAuth(identifier, pubkey)

          sendMessage({
            type: 'auth-data-removed',
            identifier: identifier,
            pubkey: pubkey
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to remove auth data: ${err.message}`
          })
        }
      }
      break

    case 'get-health':
      console.log('[Worker] Get health requested')
      break

    default:
      console.log('[Worker] Unknown message type:', message.type)
  }
}

if (workerPipe) {
  console.log('[Worker] Connected to parent via pipe')
  
  // Test the pipe immediately
  sendWorkerStatus('starting', 'Relay worker starting...')
  
  // Configuration may have been sent before initialization
  
  // Handle messages from parent
  let buffer = ''
  workerPipe.on('data', async (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        await handleMessageObject(message)
      } catch (err) {
        console.error('[Worker] Error handling message:', err)
      }
    }
  })
  
  // Handle pipe close
  workerPipe.on('close', () => {
    console.log('[Worker] Pipe closed by parent')
    isShuttingDown = true
    cleanup().then(() => process.exit(0))
  })
  
  // Handle pipe error
  workerPipe.on('error', (err) => {
    console.error('[Worker] Pipe error:', err)
    isShuttingDown = true
  })
} else if (typeof process.on === 'function') {
  console.log('[Worker] Using Node IPC for parent communication')
  process.on('message', async (message) => {
    try {
      await handleMessageObject(message)
    } catch (err) {
      console.error('[Worker] Error handling IPC message:', err)
    }
  })

  process.on('disconnect', () => {
    console.log('[Worker] Parent process disconnected')
    isShuttingDown = true
    cleanup().then(() => process.exit(0))
  })
}

// Setup teardown handler
const handleShutdownSignal = async () => {
  if (isShuttingDown) return
  console.log('[Worker] Teardown initiated')
  isShuttingDown = true
  await cleanup()
  process.exit(0)
}

process.on('SIGTERM', handleShutdownSignal)
process.on('SIGINT', handleShutdownSignal)

if (pearRuntime?.teardown) {
  pearRuntime.teardown(async () => {
    if (isShuttingDown) return
    console.log('[Worker] Pear teardown received')
    isShuttingDown = true
    await cleanup()
  })
}

// Cleanup function
async function cleanup() {
  if (!isShuttingDown) {
    sendWorkerStatus('stopping', 'Worker shutting down...', {
      statePatch: { app: { shuttingDown: true } }
    })
  }

  if (relayServer && relayServer.shutdownRelayServer) {
    console.log('[Worker] Stopping relay server...')
    await relayServer.shutdownRelayServer()
  }

  try { await stopGatewayService() } catch (_) {}

  // Stop all mirror watchers
  cleanupRelayMirrorSubscriptions()
  try { await stopAllMirrors() } catch (_) {}

  if (blindPeeringManager) {
    try {
      await blindPeeringManager.clearAllMirrors({
        reason: 'shutdown',
        deleteRemote: false,
        preserveMetadata: true
      })
    } catch (err) {
      console.warn('[Worker] Failed to clear blind peering mirrors during shutdown:', err?.message || err)
    }
    try {
      await blindPeeringManager.stop()
    } catch (err) {
      console.warn('[Worker] Failed to stop blind peering manager:', err?.message || err)
    }
    lastBlindPeerFingerprint = null
    lastDispatcherAssignmentFingerprint = null
  }
  
  if (workerPipe) {
    try { workerPipe.end() } catch (err) { console.warn('[Worker] Failed to close pipe cleanly:', err?.message || err) }
  } else if (typeof process.disconnect === 'function' && process.connected) {
    try { process.disconnect() } catch (err) { console.warn('[Worker] Failed to disconnect IPC:', err?.message || err) }
  }
}

// Main function to start the relay server
async function main() {
    try {
      console.log('[Worker] Hypertuna Relay Worker starting...')
      sendWorkerStatus('starting', 'Hypertuna Relay Worker starting...', {
        statePatch: {
          app: { initialized: false, mode: 'hyperswarm', shuttingDown: false },
          gateway: { ready: false, running: false },
          relays: { expected: 0, active: 0 }
        }
      })

	      const hasParentIpc = !!(workerPipe || typeof process.send === 'function')
	      const requiresParentConfig = process.env.ELECTRON_RUN_AS_NODE === '1'
	      let expectedRelayCount = 0
	      
	      // Wait for config from parent if available
	      let parentConfig = storedParentConfig
	      if (!parentConfig && hasParentIpc) {
        console.log('[Worker] Waiting for parent config...')
        sendWorkerStatus('waiting-config', 'Waiting for parent config…')
        parentConfig = await waitForParentConfig()
	      } else if (parentConfig) {
	        console.log('[Worker] Using previously received parent config')
	      }

	      if (requiresParentConfig) {
	        if (!parentConfig) {
	          const message = 'Missing required parent config (nostr keys). Worker cannot start.'
	          console.error('[Worker] ' + message)
	          sendWorkerStatus('error', message, { error: new Error(message) })
	          sendMessage({ type: 'error', message })
	          await new Promise(resolve => setTimeout(resolve, 25))
	          process.exit(1)
	        }

	        if (!isHex64(parentConfig.nostr_pubkey_hex) || !isHex64(parentConfig.nostr_nsec_hex)) {
	          const message = 'Invalid parent config (expected nostr_pubkey_hex + nostr_nsec_hex). Worker cannot start.'
	          console.error('[Worker] ' + message)
	          sendWorkerStatus('error', message, { error: new Error(message) })
	          sendMessage({ type: 'error', message })
	          await new Promise(resolve => setTimeout(resolve, 25))
	          process.exit(1)
	        }
	      }

	      if (parentConfig) {
	        storedParentConfig = parentConfig
	        configReceived = true

	        // Get user key from parent config
        const userKey = getUserKey(parentConfig)
        console.log('[Worker] User key:', userKey)

        const userSpecificStorage = join(defaultStorageDir, 'users', userKey)
        await fs.mkdir(userSpecificStorage, { recursive: true })

        // Set global user config for profile manager early (so downstream modules use correct scope)
        global.userConfig = { userKey, storage: userSpecificStorage }

        // Load or create configuration *within user-specific storage*
        config = await loadOrCreateConfig(userSpecificStorage)

        // Merge parent config with loaded config (parent values win for identity fields)
        config = {
          ...config,
          ...parentConfig,
          storage: userSpecificStorage,
          userKey
        }

        // Derive deterministic proxy identity in worker (matches legacy design intent)
        try {
          ensureProxyIdentity(config)
        } catch (error) {
          console.warn('[Worker] Failed to ensure proxy identity:', error?.message || error)
        }

        const derivedSwarmKey = deriveSwarmPublicKey(config)
        if (derivedSwarmKey) {
          config.swarmPublicKey = derivedSwarmKey
          gatewayService?.setOwnPeerPublicKey(derivedSwarmKey)
        }

        expectedRelayCount = Array.isArray(config.relays) ? config.relays.length : 0

        sendConfigAppliedV1({
          user: {
            pubkeyHex: config.nostr_pubkey_hex || null,
            userKey
          },
          storage: {
            baseDir: defaultStorageDir,
            userDir: userSpecificStorage,
            configPath
          },
          proxy: {
            swarmPublicKey: config.swarmPublicKey || null,
            derivation: {
              scheme: 'pbkdf2-sha256-ed25519',
              salt: PROXY_DERIVATION_CONTEXT,
              iterations: PROXY_DERIVATION_ITERATIONS,
              dkLen: PROXY_DERIVATION_DKLEN_BYTES
            }
          },
          network: {
            gatewayUrl: config.gatewayUrl,
            proxyHost: config.proxy_server_address,
            proxyWebsocketProtocol: config.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss'
          }
        })

        sendWorkerStatus('config-applied', 'Config applied. Initializing…', {
          statePatch: {
            user: {
              pubkeyHex: config.nostr_pubkey_hex || null,
              userKey
            },
            relays: { expected: expectedRelayCount, active: 0 }
          }
        })

        console.log('[Worker] Set global user config for profile operations')

        await loadRelayMembers()
        await loadRelayKeyMappings()
      } else {
        // Load or create configuration (no parent config provided)
        config = await loadOrCreateConfig()
        expectedRelayCount = Array.isArray(config.relays) ? config.relays.length : 0
      }

    await initializeGatewayOptionsFromSettings()

    global.userConfig = global.userConfig || { storage: config.storage };

    const hadDriveKey = !!config.driveKey;
    const hadPfpDriveKey = !!config.pfpDriveKey;
    const hyperdriveConfig = { ...config, storage: global.userConfig.storage };
    await initializeHyperdrive(hyperdriveConfig);
    config.driveKey = hyperdriveConfig.driveKey;

    const pfpConfig = { ...config, storage: global.userConfig.storage, pfpDriveKey: config.pfpDriveKey }
    await initializePfpHyperdrive(pfpConfig);
    config.pfpDriveKey = pfpConfig.pfpDriveKey;
    if (config.pfpDriveKey) {
      refreshGatewayRelayRegistry('pfp-drive-ready').catch((err) => {
        console.warn('[Worker] Gateway registry refresh failed (pfp-drive-ready):', err?.message || err)
      })
    }

	    if ((!hadDriveKey && config.driveKey) || (!hadPfpDriveKey && config.pfpDriveKey)) {
	      try {
	        await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(config), null, 2));
	      } catch (err) {
	        console.error('[Worker] Failed to persist hyperdrive keys:', err);
	      }
	    }

    if (config.driveKey) {
      sendMessage({ type: 'drive-key', driveKey: config.driveKey });
    }
    if (config.pfpDriveKey) {
      sendMessage({ type: 'pfp-drive-key', driveKey: config.pfpDriveKey });
    }

    startDriveWatcher()

    // Start periodic replication health logger
    startHealthLogger(60000)
    // Kick off mirror setup for all known relays/providers
    await ensureMirrorsForAllRelays().catch(err => console.error('[Worker] Mirror setup error:', err))

    try {
      const manager = await ensureBlindPeeringManager({
        start: true,
        corestore: getCorestore(),
        wakeup: null
      })
      await seedBlindPeeringMirrors(manager)
      await manager.refreshFromBlindPeers('startup')
      await manager.rehydrateMirrors({
        reason: 'startup',
        timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
      })
    } catch (error) {
      console.warn('[Worker] Blind peering manager failed to start:', error?.message || error)
    }

	    sendMessage({
	      type: 'status',
	      message: 'Loading relay server...',
	      config: {
	        port: config.port,
	        proxy_server_address: config.proxy_server_address,
	        gatewayUrl: config.gatewayUrl,
	        registerWithGateway: config.registerWithGateway
	      }
	    })
	    sendWorkerStatus('initializing', 'Loading relay server…', {
	      statePatch: {
	        relays: { expected: expectedRelayCount },
	        gateway: { ready: false, running: false }
	      }
	    })
	    
	    // Import and initialize the Hyperswarm-based relay server
	    try {
      console.log('[Worker] Importing Hyperswarm relay server module...')
      relayServer = await import('./pear-relay-server.mjs')
      
      console.log('[Worker] Initializing relay server...')
      await relayServer.initializeRelayServer(config)
      
      console.log('[Worker] Relay server base initialization complete')
      if (typeof relayServer.requestRelaySubscriptionRefresh === 'function') {
        global.requestRelaySubscriptionRefresh = relayServer.requestRelaySubscriptionRefresh
      }

      if (pendingRelayRegistryRefresh) {
        refreshGatewayRelayRegistry('relay-server-ready').catch((err) => {
          console.warn('[Worker] Deferred gateway registry refresh failed after relay server init:', err?.message || err)
        })
      }

      const derivedSwarmKey = deriveSwarmPublicKey(config)
      if (derivedSwarmKey) {
        config.swarmPublicKey = derivedSwarmKey
        gatewayService?.setOwnPeerPublicKey(derivedSwarmKey)
      }

	      const gatewayReadyPromise = (async () => {
	        try {
	          console.log('[Worker] Starting gateway service before auto-connecting relays...')
	          sendWorkerStatus('gateway-starting', 'Starting gateway…')
	          await startGatewayService()
	          const ready = await waitForGatewayReady()
	          if (!ready) {
	            console.warn('[Worker] Gateway did not report ready status within timeout; proceeding cautiously')
	          }
	          sendWorkerStatus('gateway-ready', ready ? 'Gateway ready.' : 'Gateway not ready (timeout).', {
	            statePatch: { gateway: { ready: !!ready, running: !!ready } }
	          })
	          return ready
	        } catch (gatewayError) {
	          console.error('[Worker] Failed to auto-start gateway:', gatewayError)
	          sendMessage({ type: 'gateway-error', message: gatewayError.message })
	          sendWorkerStatus('error', 'Gateway start failed', {
	            error: gatewayError,
	            statePatch: { gateway: { ready: false, running: false } }
	          })
	          return false
	        }
	      })()

      global.waitForGatewayReady = () => gatewayReadyPromise

	      const connectRelaysPromise = (async () => {
	        try {
	          sendWorkerStatus('relays-loading', 'Loading relays…', {
	            statePatch: { relays: { expected: expectedRelayCount, active: 0 } }
	          })
	          return await relayServer.connectStoredRelays()
	        } catch (connectError) {
	          console.error('[Worker] Failed to auto-connect stored relays:', connectError)
	          return []
	        }
	      })()

      const [connectedRelaysRaw, gatewayReadyResult] = await Promise.all([connectRelaysPromise, gatewayReadyPromise])
      const connectedRelays = Array.isArray(connectedRelaysRaw) ? connectedRelaysRaw : []
      const gatewayReady = !!gatewayReadyResult

      if (Array.isArray(connectedRelays)) {
        config.relays = connectedRelays
      }

      try {
        const relaysSnapshot = await relayServer.getActiveRelays()
        const relaysAuth = await addAuthInfoToRelays(relaysSnapshot)
        console.log('[Worker][relay-update][auto-connect-complete] sending', relaysAuth.map(r => ({
          relayKey: r.relayKey,
          publicIdentifier: r.publicIdentifier,
          connectionUrl: r.connectionUrl,
          userAuthToken: r.userAuthToken,
          requiresAuth: r.requiresAuth
        })))
        await syncGatewayPeerMetadata('auto-connect-complete', { relays: relaysAuth })
        sendMessage({
          type: 'relay-update',
          relays: addMembersToRelays(relaysAuth)
        })
      } catch (syncError) {
        console.warn('[Worker] Gateway metadata sync failed (auto-connect-complete):', syncError?.message || syncError)
      }

	      if (!isShuttingDown) {
	        sendMessage({
	          type: 'status',
	          message: 'Relay server running with Hyperswarm',
	          initialized: true,
	          config: {
	            port: config.port,
	            proxy_server_address: config.proxy_server_address,
	            gatewayUrl: config.gatewayUrl,
	            registerWithGateway: config.registerWithGateway,
	            relayCount: Array.isArray(connectedRelays) ? connectedRelays.length : (config.relays?.length || 0),
	            mode: 'hyperswarm',
	            gatewayReady
	          }
	        })
	        sendWorkerStatus('ready', 'Relay server running with Hyperswarm', {
	          legacy: { initialized: true },
	          statePatch: {
	            app: { initialized: true },
	            gateway: { ready: gatewayReady, running: gatewayReady },
	            relays: {
	              expected: expectedRelayCount,
	              active: Array.isArray(connectedRelays) ? connectedRelays.length : 0
	            }
	          }
	        })
	
	        console.log('[Worker] Sent status message with initialized=true')
	      }

	    } catch (error) {
	      console.error('[Worker] Failed to start relay server:', error)
	      console.log('[Worker] Make sure pear-relay-server.mjs is in the worker directory')
	      sendWorkerStatus('error', 'Failed to start relay server', { error })
	      
	      sendMessage({ 
	        type: 'error', 
	        message: `Failed to start relay server: ${error.message}` 
	      })
	    }

    setInterval(() => {
      if (!isShuttingDown) {
        const now = Date.now()
        // Keep the legacy reconcilation for now, and also refresh mirrors to discover new providers
        reconcileRelayFiles().catch(err => console.error('[Worker] File reconciliation error:', err))
        ensureMirrorsForAllRelays().catch(err => console.error('[Worker] Mirror refresh error:', err))
        syncRemotePfpMirrors().catch(err => console.error('[Worker] PFP mirror error:', err))
        if (blindPeeringManager?.started) {
          seedBlindPeeringMirrors(blindPeeringManager).catch(err => {
            console.warn('[Worker] Blind peering mirror seeding failed:', err?.message || err)
          })
          blindPeeringManager.refreshFromBlindPeers('periodic')
            .then(() => blindPeeringManager.rehydrateMirrors({
              reason: 'periodic',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            }))
            .catch(err => {
              console.warn('[Worker] Blind peering periodic sync failed:', err?.message || err)
            })
        }
        if (now - lastMirrorMetadataRefreshAt >= BLIND_PEER_MIRROR_METADATA_REFRESH_MS) {
          refreshRelayMirrorMetadata('periodic').catch((error) => {
            console.warn('[Worker] Mirror metadata refresh failed:', error?.message || error)
          })
        }
      }
    }, 60000)

    // Keep the process alive with heartbeat
    const heartbeatInterval = setInterval(() => {
      if (isShuttingDown) {
        clearInterval(heartbeatInterval)
        return
      }
      
      sendMessage({ 
        type: 'heartbeat', 
        timestamp: Date.now(),
        status: 'running',
        mode: 'hyperswarm'
      })
    }, 5000)
    
	  } catch (error) {
	    console.error('[Worker] Error starting relay server:', error)
	    sendWorkerStatus('error', 'Worker failed to start', { error })
	    sendMessage({ 
	      type: 'error', 
	      message: error.message 
	    })
	    process.exit(1)
	  }
}

// Start the worker
main().catch(console.error)
