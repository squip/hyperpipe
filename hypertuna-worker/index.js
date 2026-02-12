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
import WebSocket from 'ws'
import GatewayService from './gateway/GatewayService.mjs'
import {
  getAllRelayProfiles,
  getRelayProfileByKey,
  getRelayProfileByPublicIdentifier,
  saveRelayProfile,
  removeRelayProfile,
  removeRelayAuth, // <-- NEW IMPORT
  updateRelayMembers, // This is likely not used directly anymore for member_adds/removes
  updateRelayAuthToken, // <-- NEW IMPORT
  updateRelayMemberSets,
  calculateMembers,
  calculateAuthorizedUsers
} from './hypertuna-relay-profile-manager-bare.mjs'
import {
  loadRelayKeyMappings,
  activeRelays,
  virtualRelayKeys,
  keyToPublic,
  removeRelayMapping
} from './hypertuna-relay-manager-adapter.mjs'
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
  removeRelayCorestore,
  getLocalDrive,
  getPfpDrive,
  deleteRelayFilesByIdentifierPrefix
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
import {
  encryptSharedSecretToString,
  decryptSharedSecretFromString
} from './challenge-manager.mjs'
import BlindPeeringManager from './blind-peering-manager.mjs'
import {
  configureRelayCoreRefsStore,
  normalizeCoreRef,
  decodeCoreRef,
  normalizeCoreRefList,
  normalizeMirrorCoreRefs,
  normalizeMirrorWriterCoreRefs,
  mergeCoreRefLists,
  coreRefsFingerprint,
  collectRelayCoreRefsFromAutobase,
  getRelayMirrorCoreRefsCache,
  updateRelayMirrorCoreRefs,
  resolveRelayMirrorCoreRefs
} from './relay-core-refs-store.mjs'
import {
  configureRelayWriterPoolStore,
  getRelayWriterPool,
  setRelayWriterPool,
  pruneWriterPoolEntries
} from './relay-writer-pool-store.mjs'
import MarmotService from './marmot-service.mjs'
import ConversationFileIndex from './conversation-file-index.mjs'
import MediaServiceManager from './media/MediaServiceManager.mjs'
import PluginMarketplaceService from './plugins/PluginMarketplaceService.mjs'

if (typeof globalThis.crypto === 'undefined' && nodeCrypto?.webcrypto) {
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: nodeCrypto.webcrypto,
      configurable: true,
      writable: true
    })
    console.info('[Worker] Installed WebCrypto shim on globalThis.crypto')
  } catch (error) {
    console.warn('[Worker] Failed to install WebCrypto shim:', error?.message || error)
  }
}

if (typeof globalThis.WebSocket === 'undefined' && WebSocket) {
  try {
    Object.defineProperty(globalThis, 'WebSocket', {
      value: WebSocket,
      configurable: true,
      writable: true
    })
    console.info('[Worker] Installed WebSocket shim on globalThis.WebSocket')
  } catch (error) {
    console.warn('[Worker] Failed to install WebSocket shim:', error?.message || error)
  }
}

const pearRuntime = globalThis?.Pear
const __dirname = process.env.APP_DIR || pearRuntime?.config?.dir || process.cwd()
const defaultStorageDir = process.env.STORAGE_DIR || pearRuntime?.config?.storage || join(process.cwd(), 'data')
const userKey = process.env.USER_KEY || null
const BLIND_PEERING_METADATA_FILENAME = 'blind-peering-metadata.json'
const BLIND_PEER_REHYDRATION_TIMEOUT_MS = 60000
const BLIND_PEER_JOIN_REHYDRATION_TIMEOUT_MS = 90000
const BLIND_PEER_REHYDRATION_RETRIES = 1
const BLIND_PEER_REHYDRATION_BACKOFF_MS = 5000
const BLIND_PEER_JOIN_REHYDRATION_RETRIES = 1
const BLIND_PEER_JOIN_REHYDRATION_BACKOFF_MS = 7000
const BLIND_PEER_MIRROR_METADATA_REFRESH_MS = 1 * 60 * 1000
const BLIND_PEER_MIRROR_METADATA_TIMEOUT_MS = 8000
const OPEN_JOIN_BOOTSTRAP_TIMEOUT_MS = 8000
const OPEN_JOIN_APPEND_CORES_TIMEOUT_MS = 8000
const OPEN_JOIN_APPEND_CORES_PURPOSE = 'append-cores'

global.userConfig = {
  storage: defaultStorageDir,
  userKey: userKey || null
}

configureRelayCoreRefsStore({ storageBase: defaultStorageDir, logger: console })
configureRelayWriterPoolStore({ storageBase: defaultStorageDir, logger: console })

const relayMirrorSubscriptions = new Map()
const relayMirrorSyncState = new Map()
const relayMirrorWriterSyncState = new Map()
const relayWriterQueue = new Map()
let lastBlindPeerFingerprint = null
let lastDispatcherAssignmentFingerprint = null
let pendingRelayRegistryRefresh = false
let gatewayWasRunning = false
let lastMirrorMetadataRefreshAt = 0
let mirrorMetadataRefreshInFlight = null
const openJoinContexts = new Map()
const pendingOpenJoinReauth = new Map()
const OPEN_JOIN_REAUTH_MIN_INTERVAL_MS = 30000
const OPEN_JOIN_POOL_TARGET_SIZE = 10
const OPEN_JOIN_POOL_ENTRY_TTL_MS = 6 * 60 * 60 * 1000
const OPEN_JOIN_POOL_REFRESH_MS = 30 * 60 * 1000
const CLOSED_JOIN_POOL_TARGET_SIZE = 10
const DEFAULT_CLOSED_JOIN_POOL_ENTRY_TTL_MS = 90 * 24 * 60 * 60 * 1000
let CLOSED_JOIN_POOL_ENTRY_TTL_MS = DEFAULT_CLOSED_JOIN_POOL_ENTRY_TTL_MS
const CLOSED_JOIN_POOL_REFRESH_MS = 30 * 60 * 1000
const openJoinWriterPoolCache = new Map()
const openJoinWriterPoolLocks = new Set()
const closedJoinWriterPoolLocks = new Set()
const RELAY_SUBSCRIPTION_REFRESH_MIN_INTERVAL_MS = 1500
const RELAY_SUBSCRIPTION_REFRESH_CACHE_TTL_MS = 60 * 1000
const RELAY_SUBSCRIPTION_REFRESH_MAX_TRACKED = 512
const relaySubscriptionRefreshRecent = new Map()
const relaySubscriptionRefreshInFlight = new Map()

function resolveClosedJoinPoolEntryTtlMs(config) {
  const fromConfig =
    config?.closedJoinPoolEntryTtlMs ??
    config?.closed_join_pool_entry_ttl_ms ??
    config?.closedJoin?.poolEntryTtlMs ??
    config?.closed_join?.pool_entry_ttl_ms ??
    null
  const fromEnv = process.env.CLOSED_JOIN_POOL_TTL_MS || process.env.CLOSED_JOIN_POOL_ENTRY_TTL_MS || null
  const parsedEnv = fromEnv ? Number(fromEnv) : null
  const candidate = Number.isFinite(fromConfig) ? Number(fromConfig) : (Number.isFinite(parsedEnv) ? parsedEnv : null)
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_CLOSED_JOIN_POOL_ENTRY_TTL_MS
}

function applyClosedJoinPoolConfig(config) {
  CLOSED_JOIN_POOL_ENTRY_TTL_MS = resolveClosedJoinPoolEntryTtlMs(config)
  console.info('[Worker] Closed join pool TTL configured', {
    closedJoinPoolEntryTtlMs: CLOSED_JOIN_POOL_ENTRY_TTL_MS
  })
}

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

function describeRelayIdentifierType(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return 'unknown'
  if (isHex64(trimmed)) return 'hex'
  if (trimmed.includes(':') || trimmed.includes('/')) return 'alias'
  return 'alias'
}

function resolveRelayIdentifierPath(identifier) {
  if (!identifier || typeof identifier !== 'string') return null
  return identifier.includes(':') ? identifier.replace(':', '/') : identifier
}

function makeRelaySubscriptionRefreshKey({ relayKey = null, publicIdentifier = null } = {}) {
  const relayPart = relayKey ? String(relayKey).trim().toLowerCase() : ''
  const publicPart = publicIdentifier ? String(publicIdentifier).trim() : ''
  return `${relayPart}|${publicPart}`
}

function pruneRelaySubscriptionRefreshState(now = Date.now()) {
  for (const [key, ts] of relaySubscriptionRefreshRecent.entries()) {
    if (!Number.isFinite(ts) || now - ts > RELAY_SUBSCRIPTION_REFRESH_CACHE_TTL_MS) {
      relaySubscriptionRefreshRecent.delete(key)
    }
  }
  if (relaySubscriptionRefreshRecent.size <= RELAY_SUBSCRIPTION_REFRESH_MAX_TRACKED) return
  const sorted = Array.from(relaySubscriptionRefreshRecent.entries()).sort((a, b) => a[1] - b[1])
  const overflow = relaySubscriptionRefreshRecent.size - RELAY_SUBSCRIPTION_REFRESH_MAX_TRACKED
  for (let index = 0; index < overflow; index += 1) {
    relaySubscriptionRefreshRecent.delete(sorted[index][0])
  }
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

function resolveRelayKey(relayManager) {
  if (!relayManager) return null
  if (typeof relayManager.bootstrap === 'string') return relayManager.bootstrap
  const relayKeyBuffer = relayManager?.relay?.key || relayManager?.relay?.core?.key || relayManager?.relay?.local?.key
  if (relayKeyBuffer) {
    try {
      return b4a.toString(relayKeyBuffer, 'hex')
    } catch (_) {
      return null
    }
  }
  return null
}

function queueRelayWriterRefs(relayKey, refs, reason) {
  if (!relayKey || !Array.isArray(refs) || !refs.length) return null
  const entry = relayWriterQueue.get(relayKey) || {
    refs: new Set(),
    reason: null,
    updatedAt: 0
  }
  const previousCount = entry.refs.size
  for (const ref of refs) entry.refs.add(ref)
  entry.reason = reason
  entry.updatedAt = Date.now()
  relayWriterQueue.set(relayKey, entry)
  const totalQueued = entry.refs.size
  return {
    queued: Math.max(0, totalQueued - previousCount),
    totalQueued,
    changed: totalQueued !== previousCount
  }
}

async function flushQueuedRelayWriters(relayKey, trigger = 'relay-writable') {
  const entry = relayWriterQueue.get(relayKey)
  if (!entry || !entry.refs.size) {
    return { status: 'skipped', reason: 'no-queued-writers' }
  }
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    return { status: 'skipped', reason: 'relay-not-active' }
  }
  if (relayManager.relay?.writable === false) {
    return { status: 'skipped', reason: 'relay-not-writable' }
  }
  const refs = Array.from(entry.refs)
  console.log('[Worker] Flushing queued relay writers', {
    relayKey,
    trigger,
    queued: refs.length,
    reason: entry.reason || null
  })
  const summary = await ensureRelayWritersFromCoreRefs(
    relayManager,
    refs,
    entry.reason ? `queued-${entry.reason}` : 'queued-writers'
  )
  if (summary?.status !== 'read-only') {
    relayWriterQueue.delete(relayKey)
  }
  console.log('[Worker] Queued relay writers flushed', JSON.stringify({
    relayKey,
    trigger,
    summary
  }))
  return summary
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
    const relayKey = resolveRelayKey(relayManager)
    const queued = queueRelayWriterRefs(relayKey, normalized, reason)
    if (queued) {
      console.log('[Worker] Queued relay writers until writable', {
        relayKey,
        reason,
        queued: queued.queued,
        totalQueued: queued.totalQueued
      })
    }
    return {
      status: 'queued',
      reason: 'relay-not-writable',
      added: 0,
      skipped: normalized.length,
      failed: 0,
      queued: queued?.queued ?? normalized.length,
      totalQueued: queued?.totalQueued ?? normalized.length
    }
  }

  const skipPreUpdateWait = typeof reason === 'string'
    && (reason.startsWith('queued-') || reason === 'queued-writers')
  if (skipPreUpdateWait) {
    console.log('[Worker] Skipping pre-wait relay.update for queued writer sync', {
      relayKey: relayManager?.bootstrap || null,
      reason
    })
  } else {
    try {
      if (typeof relay.update === 'function') {
        const updateStart = Date.now()
        let mode = 'wait'
        try {
          await relay.update({ wait: true })
        } catch (_) {
          mode = 'no-wait'
          await relay.update()
        }
        console.log('[Worker] Relay update before writer sync', {
          relayKey: relayManager?.bootstrap || null,
          reason,
          mode,
          elapsedMs: Date.now() - updateStart
        })
      }
    } catch (error) {
      console.warn('[Worker] Relay update failed before writer sync', {
        relayKey: relayManager?.bootstrap || null,
        reason,
        error: error?.message || error
      })
    }
  }

  const skipKeys = collectRelaySkipKeys(relay)
  const activeWriters = relay.activeWriters || []
  const summary = {
    status: 'ok',
    added: 0,
    skipped: 0,
    failed: 0
  }

  const addWriterSlowThresholdMs = 2000
  const addWriterDurations = []

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
    const writerHex = b4a.toString(decoded, 'hex')
    const addStart = Date.now()
    try {
      await relayManager.addWriter(writerHex)
      const elapsedMs = Date.now() - addStart
      addWriterDurations.push({ writer: writerHex.slice(0, 16), elapsedMs })
      if (elapsedMs >= addWriterSlowThresholdMs) {
        console.warn('[Worker] addWriter slow', {
          relayKey: relayManager?.bootstrap || null,
          reason,
          writer: writerHex.slice(0, 16),
          elapsedMs
        })
      }
      summary.added += 1
    } catch (error) {
      const elapsedMs = Date.now() - addStart
      addWriterDurations.push({ writer: writerHex.slice(0, 16), elapsedMs, error: error?.message || error })
      summary.failed += 1
      console.warn('[Worker] Failed to add writer from mirror core refs', {
        relayKey: relayManager?.bootstrap || null,
        writer: writerHex.slice(0, 16),
        reason,
        elapsedMs,
        error: error?.message || error
      })
    }
  }

  if (addWriterDurations.length) {
    const durationsSorted = addWriterDurations
      .slice()
      .sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0))
    const slowest = durationsSorted[0]
    const totalElapsedMs = addWriterDurations.reduce((sum, entry) => sum + (entry.elapsedMs || 0), 0)
    console.log('[Worker] addWriter timing summary', JSON.stringify({
      relayKey: relayManager?.bootstrap || null,
      reason,
      count: addWriterDurations.length,
      totalElapsedMs,
      slowest
    }))
  }

  if (summary.added && typeof relay.update === 'function') {
    try {
      const updateStart = Date.now()
      let mode = 'wait'
      try {
        await relay.update({ wait: true })
      } catch (_) {
        mode = 'no-wait'
        await relay.update()
      }
      console.log('[Worker] Relay update after writer sync', {
        relayKey: relayManager?.bootstrap || null,
        reason,
        mode,
        elapsedMs: Date.now() - updateStart
      })
    } catch (_) {
      try {
        const updateStart = Date.now()
        await relay.update()
        console.log('[Worker] Relay update after writer sync', {
          relayKey: relayManager?.bootstrap || null,
          reason,
          mode: 'no-wait',
          elapsedMs: Date.now() - updateStart
        })
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

async function syncActiveRelayCoreRefs({
  relayKey,
  publicIdentifier = null,
  coreRefs = [],
  writerCoreRefs = [],
  reason = 'mirror-update'
} = {}) {
  const normalized = normalizeCoreRefList(coreRefs)
  const writerTargets = normalizeCoreRefList(writerCoreRefs)
  const writerRefsResolved = writerTargets.length ? writerTargets : normalized
  if (!relayKey || !normalized.length) {
    return { status: 'skipped', reason: 'missing-core-refs' }
  }

  await updateRelayMirrorCoreRefs(relayKey, normalized, { publicIdentifier })
  const fingerprint = coreRefsFingerprint(normalized)
  const writerFingerprint = writerRefsResolved.length ? coreRefsFingerprint(writerRefsResolved) : ''
  const coreRefsAlreadySynced = relayMirrorSyncState.get(relayKey) === fingerprint
  const writerAlreadySynced = writerFingerprint
    ? relayMirrorWriterSyncState.get(relayKey) === writerFingerprint
    : true
  const writerNeedsSync = !writerAlreadySynced
  if (coreRefsAlreadySynced && !writerNeedsSync) {
    return { status: 'skipped', reason: 'already-synced' }
  }
  if (coreRefsAlreadySynced && writerNeedsSync) {
    console.log('[Worker] Mirror writer sync bypass', {
      relayKey,
      reason,
      writerRefsCount: writerRefsResolved.length,
      coreRefsCount: normalized.length,
      writerFingerprint: writerFingerprint ? writerFingerprint.slice(0, 16) : null
    })
  }

  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    return { status: 'skipped', reason: 'relay-not-active' }
  }

  try {
    const entries = collectRelayCoreRefsFromAutobase(relayManager.relay)
    if (Array.isArray(entries) && entries.length) {
      const roleMap = new Map()
      for (const entry of entries) {
        const key = normalizeCoreRef(entry?.key)
        if (!key) continue
        const role = entry?.role || 'unlabeled'
        const existing = roleMap.get(key)
        if (existing) {
          existing.add(role)
        } else {
          roleMap.set(key, new Set([role]))
        }
      }
      const mapped = normalized
        .map((ref) => {
          const roles = roleMap.get(ref)
          if (!roles) return null
          return { key: ref, roles: Array.from(roles) }
        })
        .filter(Boolean)
      if (mapped.length) {
        const viewCore = relayManager?.relay?.view?.core || null
        const viewKeyHex = viewCore?.key ? b4a.toString(viewCore.key, 'hex') : null
        const viewCoreRef = viewCore?.key ? normalizeCoreRef(viewCore.key) : null
        const viewRoles = viewCoreRef ? Array.from(roleMap.get(viewCoreRef) || []) : []
        const viewCandidates = mapped
          .filter((entry) => entry.roles?.some((role) => role === 'autobase-view' || role.startsWith('autobase-view-')))
          .map((entry) => ({
            key: entry.key.slice(0, 16),
            roles: entry.roles
          }))
          .slice(0, 10)
        const rolesPayload = {
          relayKey,
          reason,
          total: normalized.length,
          mapped: mapped.length,
          viewCore: viewKeyHex
            ? {
              keyShort: viewKeyHex.slice(0, 16),
              coreRef: viewCoreRef ? viewCoreRef.slice(0, 16) : null,
              roles: viewRoles
            }
            : null,
          viewCandidates,
          roles: mapped.length <= 20 ? mapped : mapped.slice(0, 20)
        }
        console.log('[Worker] Core ref role map', JSON.stringify(rolesPayload))
      }
    }
  } catch (error) {
    console.warn('[Worker] Failed to resolve core ref role map', {
      relayKey,
      reason,
      error: error?.message || error
    })
  }

  const manager = await ensureBlindPeeringManager()
  if (!manager?.started) {
    if (!writerNeedsSync) {
      return { status: 'skipped', reason: 'blind-peering-unavailable' }
    }
    console.warn('[Worker] Blind peering unavailable; proceeding with writer sync only', {
      relayKey,
      reason,
      writerRefsCount: writerRefsResolved.length
    })
  }

  const identifier = publicIdentifier || relayManager?.publicIdentifier || null
  const relayCorestore = relayManager?.store || null
  if (manager?.started && !coreRefsAlreadySynced) {
    manager.ensureRelayMirror({
      relayKey,
      publicIdentifier: identifier,
      autobase: relayManager.relay,
      coreRefs: normalized,
      corestore: relayCorestore
    })
  }

  let primeSummary = null
  if (manager?.started && typeof manager.primeRelayCoreRefs === 'function' && !coreRefsAlreadySynced) {
    primeSummary = await manager.primeRelayCoreRefs({
      relayKey,
      publicIdentifier: identifier,
      coreRefs: normalized,
      timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
      reason,
      corestore: relayCorestore
    })
  }

  const rehydrateSummary = manager?.started && !coreRefsAlreadySynced
    ? await rehydrateMirrorsWithRetry(manager, {
      reason,
      timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
      retries: BLIND_PEER_REHYDRATION_RETRIES,
      backoffMs: BLIND_PEER_REHYDRATION_BACKOFF_MS
    })
    : null

  const writerSummary = await ensureRelayWritersFromCoreRefs(relayManager, writerRefsResolved, reason)

  if (writerSummary?.status === 'ok' || writerSummary?.status === 'read-only') {
    relayMirrorSyncState.set(relayKey, fingerprint)
    if (writerFingerprint) {
      relayMirrorWriterSyncState.set(relayKey, writerFingerprint)
    }
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

function normalizeDriveIdentifier(identifier) {
  if (typeof identifier !== 'string') return null
  const trimmed = identifier.trim()
  if (!trimmed) return null
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '')
}

function buildLocalDriveFileUrl(localBaseUrl, identifier, fileId) {
  const origin = normalizeHttpOrigin(localBaseUrl)
  const normalizedIdentifier = normalizeDriveIdentifier(identifier)
  const normalizedFileId =
    typeof fileId === 'string' && fileId.trim()
      ? fileId.trim().replace(/^\/+/, '')
      : null
  if (!origin || !normalizedIdentifier || !normalizedFileId) return null
  return `${origin}/drive/${normalizedIdentifier}/${normalizedFileId}`
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

async function ensureConversationFileIndex(storageRoot = null) {
  if (conversationFileIndex) return conversationFileIndex
  const basePath =
    storageRoot
    || global.userConfig?.storage
    || config?.storage
    || defaultStorageDir
  try {
    const next = new ConversationFileIndex({
      storageRoot: basePath,
      logger: console
    })
    await next.load()
    conversationFileIndex = next
    return conversationFileIndex
  } catch (error) {
    console.warn('[Worker] Failed to initialize conversation file index:', error?.message || error)
    return null
  }
}

function registerConversationFileObservation(payload = {}) {
  if (!payload || typeof payload !== 'object') return
  ensureConversationFileIndex()
    .then((index) => {
      if (!index) return
      const record = index.upsert(payload)
      if (!record) return
      console.debug('[Worker] conversation-file-index upsert', {
        conversationId: record.conversationId,
        fileHash: record.fileHash,
        providers: record.providers?.size || 0,
        source: payload.source || null
      })
    })
    .catch((error) => {
      console.warn('[Worker] Failed writing conversation file index entry:', error?.message || error)
    })
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

function buildFastForwardCheckpoint(relayKey) {
  if (!relayKey) return null
  const relayManager = activeRelays.get(relayKey)
  const relay = relayManager?.relay
  if (!relay) return null
  const systemCore = relay?.system?.core || null
  const keyRef = normalizeCoreRef(systemCore?.key || null)
  if (!keyRef) {
    console.warn('[Worker] Fast-forward checkpoint skipped (missing system core key)', {
      relayKey
    })
    return null
  }
  const signedLength = typeof systemCore?.signedLength === 'number' ? systemCore.signedLength : null
  const length = typeof systemCore?.length === 'number' ? systemCore.length : null
  return {
    key: keyRef,
    length,
    signedLength,
    source: 'system-core'
  }
}

async function ensureOpenJoinWriterPool({
  relayKey,
  publicIdentifier,
  needed = null,
  targetSize = OPEN_JOIN_POOL_TARGET_SIZE,
  mode = 'provision'
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
  const fastForward = canonicalRelayKey
    ? buildFastForwardCheckpoint(canonicalRelayKey)
    : (normalizedRelayKey ? buildFastForwardCheckpoint(normalizedRelayKey) : null)

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
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null,
      fastForward
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
    if (profile.isOpen !== true) {
      console.warn('[Worker] Open join pool skipped: relay not open', {
        relayKey: relayKeyForLog || null,
        publicIdentifier: publicIdentifierForLog || null,
        isOpen: profile.isOpen
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
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null,
        fastForward
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
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null,
        fastForward
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
    return {
      entries: newEntries,
      updatedAt,
      targetSize: resolvedTarget,
      relayKey: canonicalRelayKey || normalizedRelayKey || null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null,
      fastForward
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

function summarizeClosedJoinEntries(entries = [], limit = 3) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  return entries.slice(0, limit).map((entry) => ({
    writerCore: previewValue(entry?.writerCore, 16),
    writerCoreHex: previewValue(entry?.writerCoreHex || entry?.autobaseLocal, 16),
    issuedAt: entry?.issuedAt ?? null,
    expiresAt: entry?.expiresAt ?? null
  }))
}

function collectClosedJoinPoolCoreRefs(entries = []) {
  if (!Array.isArray(entries)) return []
  const refs = []
  for (const entry of entries) {
    const coreKey = entry?.writerCoreHex || entry?.autobaseLocal || entry?.writerCore || null
    if (coreKey) refs.push(coreKey)
  }
  return normalizeCoreRefList(refs)
}

async function ensureClosedJoinWriterPool({
  relayKey,
  publicIdentifier,
  needed = null,
  targetSize = CLOSED_JOIN_POOL_TARGET_SIZE,
  mode = 'provision',
  inviteePubkey = null
} = {}) {
  const normalizedRelayKey = normalizeRelayKeyHex(relayKey)
  const normalizedPublicIdentifier = typeof publicIdentifier === 'string' ? publicIdentifier.trim() : null
  const fallbackIdentifier = typeof relayKey === 'string' ? relayKey.trim() : null
  const requestIdentifier = normalizedRelayKey || normalizedPublicIdentifier || fallbackIdentifier
  if (!requestIdentifier) return null

  const resolvedTarget = Number.isFinite(targetSize) && targetSize > 0
    ? Math.trunc(targetSize)
    : CLOSED_JOIN_POOL_TARGET_SIZE
  const requestedCount = Number.isFinite(needed) ? Math.max(Math.trunc(needed), 0) : null

  console.info('[Worker] Closed join pool request', {
    requestIdentifier,
    relayKey: normalizedRelayKey || relayKey || null,
    publicIdentifier: normalizedPublicIdentifier || publicIdentifier || null,
    invitee: previewValue(inviteePubkey, 16),
    mode,
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

  console.info('[Worker] Closed join pool resolved', {
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
    console.info('[Worker] Closed join pool canonicalized', {
      requestIdentifier,
      canonicalRelayKey,
      publicIdentifier: canonicalPublicIdentifier
    })
  }

  if (!relayServer?.provisionWriterForInvitee) return null
  if (closedJoinWriterPoolLocks.has(poolKey)) {
    console.warn('[Worker] Closed join pool skipped: lock active', {
      poolKey: previewValue(poolKey, 16),
      relayKey: previewValue(canonicalRelayKey || normalizedRelayKey || relayKey || null, 16),
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null
    })
    return null
  }

  closedJoinWriterPoolLocks.add(poolKey)
  try {
    if (!profile) {
      console.warn('[Worker] Closed join pool skipped: profile not found', {
        relayKey: relayKey || null,
        publicIdentifier: publicIdentifier || null
      })
      return null
    }
    if (profile.isOpen === true) {
      console.warn('[Worker] Closed join pool skipped: relay is open', {
        relayKey: canonicalRelayKey || normalizedRelayKey || relayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null
      })
      return null
    }
    if (profile.isHosted === false) {
      console.warn('[Worker] Closed join pool skipped: relay not hosted', {
        relayKey: canonicalRelayKey || normalizedRelayKey || relayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null
      })
      return null
    }

    const now = Date.now()
    const cached = await getRelayWriterPool(poolKey)
    const entries = pruneWriterPoolEntries(cached.entries, now)
    const stale = !cached.updatedAt || (now - cached.updatedAt) >= CLOSED_JOIN_POOL_REFRESH_MS
    const poolNeeded = Math.max(resolvedTarget - entries.length, 0)
    const generateCount = requestedCount !== null
      ? requestedCount
      : (poolNeeded > 0 ? poolNeeded : (stale ? 1 : 0))

    console.log('[Worker] Closed join pool status', {
      poolKey: previewValue(poolKey, 16),
      relayKey: canonicalRelayKey ? previewValue(canonicalRelayKey, 16) : null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null,
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
      if ((cached.entries || []).length !== entries.length) {
        await setRelayWriterPool(poolKey, entries, cached.updatedAt || now)
      }
      console.log('[Worker] Closed join pool warm', {
        relayKey: canonicalRelayKey || normalizedRelayKey || relayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null,
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
        publicIdentifier: canonicalPublicIdentifier || publicIdentifier,
        skipUpdateWait: true,
        reason: 'closed-join-pool'
      })
      const writerCore = provision?.writerCore || null
      const writerCoreHex = provision?.writerCoreHex || provision?.autobaseLocal || null
      const writerSecret = provision?.writerSecret || null
      if (!writerCore || !writerSecret) continue
      const issuedAt = Date.now()
      const expiresAt = issuedAt + CLOSED_JOIN_POOL_ENTRY_TTL_MS
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
      await setRelayWriterPool(poolKey, entries, cached.updatedAt || now)
      console.warn('[Worker] Closed join pool provisioned empty', {
        relayKey: canonicalRelayKey || normalizedRelayKey || relayKey || null,
        publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null,
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
    await setRelayWriterPool(poolKey, entries, updatedAt)
    console.log('[Worker] Closed join pool provisioned', {
      relayKey: canonicalRelayKey || normalizedRelayKey || relayKey || null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || publicIdentifier || null,
      generated: newEntries.length,
      cached: entries.length,
      updatedAt,
      entryPreview: summarizeClosedJoinEntries(newEntries)
    })
    return {
      entries: newEntries,
      updatedAt,
      targetSize: resolvedTarget,
      relayKey: canonicalRelayKey || normalizedRelayKey || null,
      publicIdentifier: canonicalPublicIdentifier || normalizedPublicIdentifier || null
    }
  } catch (error) {
    console.warn('[Worker] Failed to provision closed-join writer pool', {
      relayKey: relayKey || null,
      publicIdentifier: publicIdentifier || null,
      error: error?.message || error
    })
    return null
  } finally {
    closedJoinWriterPoolLocks.delete(poolKey)
  }
}

async function claimClosedJoinWriterPoolEntry({
  relayKey,
  publicIdentifier,
  inviteePubkey = null
} = {}) {
  const normalizedRelayKey = normalizeRelayKeyHex(relayKey)
  const normalizedPublicIdentifier = typeof publicIdentifier === 'string' ? publicIdentifier.trim() : null
  const poolKey = normalizedRelayKey || normalizedPublicIdentifier || relayKey || null
  if (!poolKey) return null

  const ensure = await ensureClosedJoinWriterPool({
    relayKey: normalizedRelayKey || relayKey,
    publicIdentifier: normalizedPublicIdentifier || publicIdentifier,
    needed: 1,
    mode: 'claim',
    inviteePubkey
  })
  const cached = await getRelayWriterPool(poolKey)
  const entries = pruneWriterPoolEntries(cached.entries, Date.now())
  if (!entries.length) {
    console.warn('[Worker] Closed join pool empty after ensure', {
      poolKey: previewValue(poolKey, 16),
      relayKey: previewValue(normalizedRelayKey || relayKey, 16),
      publicIdentifier: normalizedPublicIdentifier || publicIdentifier || null
    })
    return { entry: null, pool: ensure || null }
  }

  const entry = entries.shift()
  await setRelayWriterPool(poolKey, entries, Date.now())
  if (entries.length < CLOSED_JOIN_POOL_TARGET_SIZE) {
    ensureClosedJoinWriterPool({
      relayKey: normalizedRelayKey || relayKey,
      publicIdentifier: normalizedPublicIdentifier || publicIdentifier,
      needed: Math.max(CLOSED_JOIN_POOL_TARGET_SIZE - entries.length, 0),
      mode: 'top-up',
      inviteePubkey
    }).catch((error) => {
      console.warn('[Worker] Closed join pool top-up failed', {
        poolKey: previewValue(poolKey, 16),
        error: error?.message || error
      })
    })
  }

  return {
    entry,
    pool: {
      poolKey,
      updatedAt: cached.updatedAt || null,
      available: entries.length,
      preview: summarizeClosedJoinEntries(entries),
      coreRefs: collectClosedJoinPoolCoreRefs(entries)
    }
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

async function fetchOpenJoinBootstrap(relayIdentifier, { origins = null, reason = 'open-join' } = {}) {
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
    relayIdentifierType: describeRelayIdentifierType(relayIdentifier),
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

  for (const origin of originList) {
    if (!origin) continue
    const base = origin.replace(/\/$/, '')
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller
      ? setTimeout(() => controller.abort(), OPEN_JOIN_BOOTSTRAP_TIMEOUT_MS)
      : null
    try {
      const challengeUrl = `${base}/api/relays/${encodedRelay}/open-join/challenge`
      const challengeResponse = await fetchImpl(challengeUrl, { signal: controller?.signal })
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
        relayKeyType: describeRelayIdentifierType(challengeData?.relayKey),
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authEvent })
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
        relayKeyType: describeRelayIdentifierType(data.relayKey || data.relay_key),
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
  const relayKeyType = describeRelayIdentifierType(relayKey)
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
      console.log('[Worker] Mirror metadata request', {
        relayKey,
        relayKeyType,
        origin,
        reason
      })
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
  const existingCoreRefs = normalizeCoreRefList(rawCoreRefs)
  const mirrorCoreRefs = normalizeMirrorCoreRefs(mirrorData.cores)
  const mirrorWriterCoreRefs = normalizeMirrorWriterCoreRefs(mirrorData.cores)
  const extraCoreRefs = normalizeCoreRefList([
    profile.writer_core,
    profile.writerCore,
    profile.writer_core_hex,
    profile.autobase_local,
    profile.autobaseLocal
  ])
  const mergedWriterCoreRefs = mergeCoreRefLists(mirrorWriterCoreRefs, extraCoreRefs)
  const mergedCoreRefs = mergeCoreRefLists(existingCoreRefs, mirrorCoreRefs, extraCoreRefs)
  const mergedFingerprint = coreRefsFingerprint(mergedCoreRefs)
  const existingFingerprint = coreRefsFingerprint(existingCoreRefs)
  const nextBlindPeer = sanitizeBlindPeerMeta(mirrorData.blindPeer)
  const nextFastForward = mirrorData.fastForward || mirrorData.fast_forward || null
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

  if (nextFastForward && typeof nextFastForward === 'object') {
    updates.fast_forward = nextFastForward
  }

  if (nextFastForward && typeof nextFastForward === 'object') {
    updates.fast_forward = nextFastForward
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

  await updateRelayMirrorCoreRefs(resolvedRelayKey, mergedCoreRefs, { publicIdentifier })
  const shouldSyncActive = !!resolvedRelayKey
    && mergedCoreRefs.length > 0
    && relayMirrorSyncState.get(resolvedRelayKey) !== mergedFingerprint

  if (!coreRefsChanged && !blindPeerChanged) {
    if (shouldSyncActive) {
      await syncActiveRelayCoreRefs({
        relayKey: resolvedRelayKey,
        publicIdentifier: profile.public_identifier || publicIdentifier,
        coreRefs: mergedCoreRefs,
        writerCoreRefs: mergedWriterCoreRefs,
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
      writerCoreRefs: mergedWriterCoreRefs,
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
      relayManager?.publicIdentifier || null
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
      relayManager?.publicIdentifier || null
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
let marmotService = null
let conversationFileIndex = null
let mediaServiceManager = null
let pluginMarketplaceService = null

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
    return false
  }
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    console.warn(`[Worker] appendFilekeyDbEntry skipped: no active relay manager for key=${relayKey}`)
    return false
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
    return true
  } catch (err) {
    console.error('[Worker] Failed to store filekey index:', err)
    return false
  }
}

async function publishFilekeyEvent (relayKey, fileHash) {
  if (!config?.nostr_pubkey_hex || !config?.nostr_nsec_hex || !config?.driveKey) return
  try {
    const stored = await appendFilekeyDbEntry(relayKey, fileHash)
    if (stored) {
      console.log(`[Worker] Published filekey event for ${fileHash} on relay ${relayKey}`)
    } else {
      console.debug(`[Worker] publishFilekeyEvent skipped (no relay manager) file=${fileHash} relay=${relayKey}`)
    }
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

function sendWorkerResponse(requestId, { success = true, data = null, error = null } = {}) {
  if (!requestId || typeof requestId !== 'string') return
  sendMessage({
    type: 'worker-response',
    requestId,
    success: success !== false,
    data,
    error: error || null
  })
}

function summarizeMarmotCommandPayload(type, payload = {}) {
  const data = payload && typeof payload === 'object' ? payload : {}
  const summary = {}

  if (Array.isArray(data.relays)) summary.relayCount = data.relays.length
  if (Array.isArray(data.relayUrls)) summary.relayUrlCount = data.relayUrls.length
  if (typeof data.relayMode === 'string') summary.relayMode = data.relayMode
  if (typeof data.search === 'string') summary.searchLength = data.search.length
  if (typeof data.conversationId === 'string') summary.conversationId = previewValue(data.conversationId, 20)
  if (typeof data.targetPubkey === 'string' || typeof data.pubkey === 'string') {
    summary.targetPubkey = previewValue(data.targetPubkey || data.pubkey, 20)
  }
  if (typeof data.inviteId === 'string' || typeof data.id === 'string') {
    summary.inviteId = previewValue(data.inviteId || data.id, 20)
  }
  if (Array.isArray(data.members) || Array.isArray(data.memberPubkeys)) {
    const members = Array.isArray(data.members) ? data.members : data.memberPubkeys
    summary.memberCount = members.length
  }
  if (Array.isArray(data.attachments)) summary.attachmentCount = data.attachments.length
  if (typeof data.content === 'string') summary.contentLength = data.content.length
  if (typeof data.title === 'string') summary.titleLength = data.title.length
  if (typeof data.limit === 'number') summary.limit = data.limit
  if (type === 'marmot-init') summary.relayOverride = Array.isArray(data.relays)
  return summary
}

function summarizeMarmotCommandResult(type, result = {}) {
  const data = result && typeof result === 'object' ? result : {}
  const summary = {}

  if (Array.isArray(data.conversations)) summary.conversationCount = data.conversations.length
  if (Array.isArray(data.invites)) summary.inviteCount = data.invites.length
  if (Array.isArray(data.messages)) summary.messageCount = data.messages.length
  if (Array.isArray(data.invited)) summary.invitedCount = data.invited.length
  if (Array.isArray(data.failed)) summary.failedCount = data.failed.length
  if (Number.isFinite(data.unreadCount)) summary.unreadCount = Number(data.unreadCount)
  if (type === 'marmot-send-message' || type === 'marmot-send-media-message') {
    summary.hasMessage = !!data?.message
  }
  if (typeof data.promotedPubkey === 'string') {
    summary.promotedPubkey = previewValue(data.promotedPubkey, 20)
  }
  if (typeof data.alreadyAdmin === 'boolean') {
    summary.alreadyAdmin = data.alreadyAdmin
  }
  if (Array.isArray(data.failed) && data.failed.length > 0) {
    const firstFailure = data.failed[0] && typeof data.failed[0] === 'object' ? data.failed[0] : null
    if (firstFailure) {
      if (typeof firstFailure.pubkey === 'string') summary.firstFailedPubkey = previewValue(firstFailure.pubkey, 20)
      if (typeof firstFailure.error === 'string') summary.firstFailedError = firstFailure.error
    }
  }

  const conversationId =
    (typeof data?.conversation?.id === 'string' && data.conversation.id)
    || (typeof data.conversationId === 'string' && data.conversationId)
    || null
  if (conversationId) summary.conversationId = previewValue(conversationId, 20)

  const messageId =
    (typeof data?.message?.id === 'string' && data.message.id)
    || (typeof data.messageId === 'string' && data.messageId)
    || null
  if (messageId) summary.messageId = previewValue(messageId, 20)

  if (type === 'marmot-init' && Array.isArray(data.relays)) {
    summary.relayCount = data.relays.length
  }

  return summary
}

function getMarmotService() {
  if (marmotService) return marmotService

  const storageRoot = global.userConfig?.storage || config?.storage || defaultStorageDir
  marmotService = new MarmotService({
    storageRoot,
    getConfig: () => config || storedParentConfig || {},
    sendMessage,
    logger: console,
    getPublicGatewayOrigins: collectPublicGatewayOrigins,
    onConversationFileObserved: (payload = {}) => {
      registerConversationFileObservation({
        ...payload,
        source: payload?.source || 'marmot-observed'
      })
    }
  })
  return marmotService
}

const MEDIA_COMMAND_ALIASES = {
  'p2p-create-session': 'media-create-session',
  'p2p-join-session': 'media-join-session',
  'p2p-leave-session': 'media-leave-session',
  'p2p-send-signal': 'media-send-signal'
}

const PLUGIN_WORKER_COMMAND_PERMISSION_MAP = {
  'media-create-session': 'media.session',
  'media-join-session': 'media.session',
  'media-leave-session': 'media.session',
  'media-list-sessions': 'media.session',
  'media-get-session': 'media.session',
  'media-update-stream-metadata': 'media.session',
  'media-get-service-status': 'media.session',
  'media-get-stats': 'media.session',
  'media-send-signal': 'p2p.session',
  'media-start-recording': 'media.record',
  'media-stop-recording': 'media.record',
  'media-list-recordings': 'media.record',
  'media-export-recording': 'media.record',
  'media-transcode-recording': 'media.transcode',
  'p2p-create-session': 'p2p.session',
  'p2p-join-session': 'p2p.session',
  'p2p-leave-session': 'p2p.session',
  'p2p-send-signal': 'p2p.session',
  'nostr-read': 'nostr.read',
  'nostr-query': 'nostr.read',
  'nostr-subscribe': 'nostr.read',
  'nostr-list-relays': 'nostr.read',
  'nostr-publish': 'nostr.publish',
  'nostr-publish-event': 'nostr.publish'
}

function normalizePluginSourceType(value) {
  const sourceType = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return sourceType || 'host'
}

function normalizePluginRequestId(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizePluginPermissionSet(permissions) {
  if (!Array.isArray(permissions)) return new Set()
  return new Set(
    permissions
      .map((permission) => (typeof permission === 'string' ? permission.trim() : ''))
      .filter(Boolean)
  )
}

function getRequiredPluginPermissionForCommand(commandType) {
  return PLUGIN_WORKER_COMMAND_PERMISSION_MAP[commandType] || null
}

function assertPluginMessageAuthorization(message) {
  const commandType = typeof message?.type === 'string' ? message.type.trim() : ''
  const sourceType = normalizePluginSourceType(message?.sourceType || message?.source || 'host')
  const pluginId = normalizePluginRequestId(message?.pluginId)
  const isPluginRequest = sourceType === 'plugin' || Boolean(pluginId)

  if (!isPluginRequest) {
    return { isPluginRequest: false, commandType, sourceType: 'host', pluginId: null, requiredPermission: null }
  }

  if (!pluginId) {
    throw new Error(`Plugin-origin command requires pluginId (${commandType || '<unknown>'})`)
  }

  const requiredPermission = getRequiredPluginPermissionForCommand(commandType)
  if (!requiredPermission) {
    throw new Error(`Plugin command is not allowlisted: ${commandType || '<unknown>'}`)
  }

  const permissionSet = normalizePluginPermissionSet(message?.permissions)
  if (!permissionSet.has(requiredPermission)) {
    throw new Error(`Plugin permission denied for ${commandType}: missing ${requiredPermission}`)
  }

  return {
    isPluginRequest: true,
    commandType,
    sourceType: 'plugin',
    pluginId,
    requiredPermission
  }
}

function normalizeMediaCommandType(type) {
  if (!type || typeof type !== 'string') return null
  if (type.startsWith('media-')) return type
  if (type.startsWith('p2p-')) return MEDIA_COMMAND_ALIASES[type] || null
  return null
}

function extractMessageRequestId(message) {
  return (
    (typeof message?.requestId === 'string' && message.requestId) ||
    (typeof message?.data?.requestId === 'string' && message.data.requestId) ||
    null
  )
}

function getMediaServiceManager() {
  if (mediaServiceManager) return mediaServiceManager
  const storageRoot = global.userConfig?.storage || config?.storage || defaultStorageDir
  mediaServiceManager = new MediaServiceManager({
    storageRoot,
    sendMessage,
    logger: console,
    getConfig: () => config || storedParentConfig || {},
    maxConcurrentSessions: Number(config?.media?.maxConcurrentSessions) || 8,
    maxParticipantsPerSession: Number(config?.media?.maxParticipantsPerSession) || 32,
    transcodeEnabled: Boolean(config?.media?.enableTranscode),
    enableRemoteSignaling: config?.media?.enableRemoteSignaling !== false
  })
  return mediaServiceManager
}

function getPluginMarketplaceService() {
  if (pluginMarketplaceService) return pluginMarketplaceService
  const storageRoot = global.userConfig?.storage || config?.storage || defaultStorageDir
  pluginMarketplaceService = new PluginMarketplaceService({
    logger: console,
    storageRoot
  })
  return pluginMarketplaceService
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
      const requiresAuth = profile.auth_config?.requiresAuth || false
      const writable = r?.writable === true
      let tokenPresent = !!token
      if (!tokenPresent) {
        try {
          const parsedConnectionUrl = new URL(connectionUrl)
          tokenPresent = !!parsedConnectionUrl.searchParams.get('token')
        } catch (_err) {
          tokenPresent = /[?&]token=/.test(connectionUrl)
        }
      }
      const readyForReq = writable && (!requiresAuth || tokenPresent)

      console.log('[Worker][addAuthInfoToRelays]', {
        relayKey: r.relayKey,
        publicIdentifier: profile.public_identifier || null,
        requiresAuth,
        writable,
        readyForReq,
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
        requiresAuth,
        writable,
        readyForReq,
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

async function recoverConversationDriveFile({
  conversationId = null,
  fileHash = null,
  reason = 'conversation-on-demand'
} = {}) {
  const normalizedConversationId = normalizeDriveIdentifier(conversationId)
  const normalizedFileHash =
    typeof fileHash === 'string' && /^[a-fA-F0-9]{64}$/.test(fileHash.trim())
      ? fileHash.trim().toLowerCase()
      : null

  if (!normalizedConversationId || !normalizedFileHash) {
    return { status: 'error', reason: 'invalid-conversation-recovery-input' }
  }

  try {
    const local = await getFile(normalizedConversationId, normalizedFileHash)
    if (local) {
      return {
        status: 'ok',
        reason: 'already-local',
        conversationId: normalizedConversationId,
        fileHash: normalizedFileHash
      }
    }
  } catch (_) {}

  const index = await ensureConversationFileIndex()
  if (!index) {
    return {
      status: 'error',
      reason: 'conversation-file-index-unavailable',
      conversationId: normalizedConversationId,
      fileHash: normalizedFileHash
    }
  }

  const providers = index.getProviders(normalizedConversationId, normalizedFileHash)
  if (!providers.length) {
    return {
      status: 'error',
      reason: 'conversation-file-no-providers',
      conversationId: normalizedConversationId,
      fileHash: normalizedFileHash
    }
  }

  const providerKeys = providers
    .map((provider) => provider?.driveKey)
    .filter((driveKey) => typeof driveKey === 'string' && /^[a-f0-9]{64}$/i.test(driveKey))
    .map((driveKey) => driveKey.toLowerCase())

  if (!providerKeys.length) {
    return {
      status: 'error',
      reason: 'conversation-file-no-provider-keys',
      conversationId: normalizedConversationId,
      fileHash: normalizedFileHash
    }
  }

  try {
    await ensureMirrorsForProviders(new Set(providerKeys), normalizedConversationId)
  } catch (error) {
    console.warn('[Recover] conversation ensureMirrorsForProviders failed', {
      conversationId: normalizedConversationId,
      fileHash: normalizedFileHash,
      error: error?.message || error
    })
  }

  for (const driveKey of providerKeys) {
    try {
      const data = await fetchFileFromDrive(driveKey, normalizedConversationId, normalizedFileHash)
      if (!data) continue
      await storeFile(normalizedConversationId, normalizedFileHash, data, {
        sourceDrive: driveKey,
        recoveredAt: Date.now(),
        reason
      })
      registerConversationFileObservation({
        conversationId: normalizedConversationId,
        fileHash: normalizedFileHash,
        driveKey,
        source: 'recover-conversation-drive-file'
      })
      console.info('[Recover] conversation drive file fetch complete', {
        conversationId: normalizedConversationId,
        fileHash: normalizedFileHash,
        provider: driveKey,
        reason
      })
      return {
        status: 'ok',
        reason: 'fetched',
        conversationId: normalizedConversationId,
        fileHash: normalizedFileHash,
        provider: driveKey
      }
    } catch (error) {
      console.warn('[Recover] conversation provider fetch failed', {
        conversationId: normalizedConversationId,
        fileHash: normalizedFileHash,
        provider: driveKey,
        error: error?.message || error
      })
    }
  }

  return {
    status: 'error',
    reason: 'conversation-file-fetch-failed',
    conversationId: normalizedConversationId,
    fileHash: normalizedFileHash
  }
}

async function recoverRelayDriveFile({
  relayKey = null,
  identifier = null,
  fileHash = null,
  reason = 'on-demand-fetch'
} = {}) {
  if (!fileHash || typeof fileHash !== 'string') {
    return { status: 'error', reason: 'missing-file-hash' }
  }

  let resolvedRelayKey = relayKey
  if (!resolvedRelayKey && identifier) {
    if (/^[a-fA-F0-9]{64}$/.test(identifier)) {
      resolvedRelayKey = identifier.toLowerCase()
    } else {
      try {
        resolvedRelayKey = await getRelayKeyFromPublicIdentifier(identifier)
      } catch (_) {}
    }
  }
  if (!resolvedRelayKey) {
    return await recoverConversationDriveFile({
      conversationId: identifier,
      fileHash,
      reason
    })
  }

  const relayManager = activeRelays.get(resolvedRelayKey)
  if (!relayManager?.relay || typeof relayManager.relay.queryFilekeyIndex !== 'function') {
    const conversationRecovery = await recoverConversationDriveFile({
      conversationId: identifier || resolvedRelayKey,
      fileHash,
      reason
    })
    if (conversationRecovery?.status === 'ok') return conversationRecovery
    return { status: 'error', reason: 'relay-unavailable', relayKey: resolvedRelayKey }
  }

  let resolvedIdentifier = identifier || resolvedRelayKey
  if (!resolvedIdentifier || /^[a-fA-F0-9]{64}$/.test(resolvedIdentifier)) {
    try {
      const profile = await getRelayProfileByKey(resolvedRelayKey)
      if (profile?.public_identifier) {
        resolvedIdentifier = profile.public_identifier
      }
    } catch (_) {}
  }
  if (!resolvedIdentifier) resolvedIdentifier = resolvedRelayKey

  try {
    const local = await getFile(resolvedIdentifier, fileHash)
    if (local) {
      return {
        status: 'ok',
        reason: 'already-local',
        relayKey: resolvedRelayKey,
        identifier: resolvedIdentifier,
        fileHash
      }
    }
  } catch (_) {}

  let fileMap
  try {
    fileMap = await relayManager.relay.queryFilekeyIndex()
  } catch (err) {
    return {
      status: 'error',
      reason: 'filekey-query-failed',
      relayKey: resolvedRelayKey,
      error: err?.message || String(err)
    }
  }

  const driveMap = fileMap?.get?.(fileHash) || null
  if (!driveMap || !(driveMap instanceof Map) || driveMap.size === 0) {
    return {
      status: 'error',
      reason: 'no-providers',
      relayKey: resolvedRelayKey,
      identifier: resolvedIdentifier,
      fileHash
    }
  }

  const providers = Array.from(driveMap.keys()).filter(Boolean)
  if (!providers.length) {
    return {
      status: 'error',
      reason: 'no-provider-keys',
      relayKey: resolvedRelayKey,
      identifier: resolvedIdentifier,
      fileHash
    }
  }

  console.info('[Recover] drive file fetch requested', {
    relayKey: resolvedRelayKey,
    identifier: resolvedIdentifier,
    fileHash,
    providers: providers.length,
    reason
  })

  try {
    await ensureMirrorsForProviders(new Set(providers), resolvedIdentifier)
  } catch (err) {
    console.warn('[Recover] ensureMirrorsForProviders failed', {
      relayKey: resolvedRelayKey,
      identifier: resolvedIdentifier,
      fileHash,
      error: err?.message || err
    })
  }

  for (const driveKey of providers) {
    try {
      let data = await fetchFileFromDrive(driveKey, resolvedIdentifier, fileHash)
      if (!data && resolvedIdentifier !== resolvedRelayKey) {
        data = await fetchFileFromDrive(driveKey, resolvedRelayKey, fileHash)
      }
      if (!data) continue
      await storeFile(resolvedIdentifier, fileHash, data, {
        sourceDrive: driveKey,
        recoveredAt: Date.now(),
        reason
      })
      console.info('[Recover] drive file fetch complete', {
        relayKey: resolvedRelayKey,
        identifier: resolvedIdentifier,
        fileHash,
        provider: driveKey
      })
      return {
        status: 'ok',
        reason: 'fetched',
        relayKey: resolvedRelayKey,
        identifier: resolvedIdentifier,
        fileHash,
        provider: driveKey
      }
    } catch (err) {
      console.warn('[Recover] provider fetch failed', {
        relayKey: resolvedRelayKey,
        identifier: resolvedIdentifier,
        fileHash,
        provider: driveKey,
        error: err?.message || err
      })
    }
  }

  return {
    status: 'error',
    reason: 'fetch-failed',
    relayKey: resolvedRelayKey,
    identifier: resolvedIdentifier,
    fileHash
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
global.recoverRelayDriveFile = recoverRelayDriveFile
global.recoverConversationDriveFile = recoverConversationDriveFile
global.requestRelaySubscriptionRefresh = async (relayKey = null, { reason = 'manual' } = {}) => {
  console.log('[Worker] Subscription refresh requested before relay server ready', {
    relayKey,
    reason
  })
  return { status: 'skipped', reason: 'relay-server-unavailable' }
}
global.onRelayWritable = (payload = {}) => {
  const mode = payload?.mode ? String(payload.mode) : 'unknown'
  const relayKey = payload?.relayKey || null
  console.log('[Worker] Relay writable received; refreshing gateway registry', {
    mode,
    relayKey,
    publicIdentifier: payload?.publicIdentifier || null
  })
  if (relayKey) {
    flushQueuedRelayWriters(relayKey, 'relay-writable').catch((err) => {
      console.warn('[Worker] Failed to flush queued relay writers', {
        relayKey,
        error: err?.message || err
      })
    })
  }
  refreshGatewayRelayRegistry(`relay-writable-${mode}`).catch((err) => {
    console.warn('[Worker] Gateway registry refresh failed after relay-writable:', err?.message || err)
  })
}

function sanitizeArchiveSegment(value) {
  const raw = String(value || '').trim()
  if (!raw) return 'relay'
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function uniqueIdentifiers(values = []) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

async function emitRelayUpdateSnapshot(reason = 'manual') {
  if (!relayServer) return
  try {
    const relays = await relayServer.getActiveRelays()
    const relaysAuth = await addAuthInfoToRelays(relays)
    await syncGatewayPeerMetadata(`relay-update:${reason}`, { relays: relaysAuth })
    sendMessage({
      type: 'relay-update',
      relays: addMembersToRelays(relaysAuth)
    })
  } catch (error) {
    console.warn('[Worker] Failed to emit relay-update snapshot', {
      reason,
      error: error?.message || error
    })
  }
}

async function disconnectRelayForCleanup({ relayKey, publicIdentifier = null, reason = 'leave-group' } = {}) {
  if (!relayKey) {
    return { status: 'skipped', reason: 'missing-relay-key' }
  }
  if (!relayServer) {
    return { status: 'skipped', reason: 'relay-server-unavailable' }
  }

  const relayManagerInstance = activeRelays.get(relayKey)
  if (!relayManagerInstance) {
    return { status: 'skipped', reason: 'relay-not-active' }
  }

  try {
    const result = await relayServer.disconnectRelay(relayKey)
    if (!result?.success) {
      return { status: 'error', reason: result?.error || 'disconnect-failed' }
    }

    detachRelayMirrorHooks(relayManagerInstance)
    try {
      const manager = await ensureBlindPeeringManager()
      if (manager?.started) {
        await manager.removeRelayMirror({
          relayKey,
          publicIdentifier,
          autobase: relayManagerInstance?.relay || null
        }, { reason })
      }
    } catch (mirrorError) {
      console.warn('[Worker] Blind peering mirror removal failed during relay cleanup', {
        relayKey,
        reason,
        error: mirrorError?.message || mirrorError
      })
    }

    return { status: 'ok' }
  } catch (error) {
    if (relayManagerInstance?.relay) {
      attachRelayMirrorHooks(relayKey, relayManagerInstance, blindPeeringManager)
    }
    return { status: 'error', reason: error?.message || String(error) }
  }
}

async function collectRelayFileProviderSnapshot(relayKey) {
  if (!relayKey) return []
  const manager = activeRelays.get(relayKey)
  if (!manager?.relay || typeof manager.relay.queryFilekeyIndex !== 'function') return []
  try {
    const fileMap = await manager.relay.queryFilekeyIndex()
    const entries = []
    for (const [fileHash, providerMap] of fileMap.entries()) {
      const providers = providerMap instanceof Map
        ? Array.from(providerMap.keys()).filter(Boolean)
        : []
      entries.push({ fileHash, providers })
    }
    return entries
  } catch (error) {
    console.warn('[Worker] Failed to collect relay file provider snapshot', {
      relayKey,
      error: error?.message || error
    })
    return []
  }
}

async function recoverRelayFilesFromSnapshot({
  relayKey,
  publicIdentifier = null,
  fileProviders = []
} = {}) {
  const primaryIdentifier = publicIdentifier || relayKey
  if (!primaryIdentifier) return { recoveredCount: 0, failedCount: 0 }

  await ensureRelayFolder(primaryIdentifier)
  let recoveredCount = 0
  let failedCount = 0

  for (const entry of fileProviders) {
    const fileHash = typeof entry?.fileHash === 'string' ? entry.fileHash : null
    const providers = Array.isArray(entry?.providers) ? entry.providers : []
    if (!fileHash) continue

    let hasLocalCopy = false
    try {
      hasLocalCopy = !!(await getFile(primaryIdentifier, fileHash))
      if (!hasLocalCopy && relayKey && relayKey !== primaryIdentifier) {
        hasLocalCopy = !!(await getFile(relayKey, fileHash))
      }
    } catch (_) {
      hasLocalCopy = false
    }
    if (hasLocalCopy) {
      recoveredCount += 1
      continue
    }

    let restored = false
    for (const providerDriveKey of providers) {
      try {
        let data = await fetchFileFromDrive(providerDriveKey, primaryIdentifier, fileHash)
        if (!data && relayKey && relayKey !== primaryIdentifier) {
          data = await fetchFileFromDrive(providerDriveKey, relayKey, fileHash)
        }
        if (!data) continue
        await storeFile(primaryIdentifier, fileHash, data, {
          sourceDrive: providerDriveKey,
          recoveredAt: Date.now(),
          reason: 'leave-group-save-shared-files'
        })
        restored = true
        break
      } catch (_error) {
        // continue to next provider
      }
    }

    if (restored) {
      recoveredCount += 1
    } else {
      failedCount += 1
    }
  }

  return { recoveredCount, failedCount }
}

async function cleanupRelayLocalFilePrefixes(identifiers = []) {
  let deletedCount = 0
  for (const identifier of uniqueIdentifiers(identifiers)) {
    try {
      const result = await deleteRelayFilesByIdentifierPrefix(identifier)
      deletedCount += Number(result?.deletedCount || 0)
    } catch (error) {
      console.warn('[Worker] Failed to delete local relay file prefix', {
        identifier,
        error: error?.message || error
      })
    }
  }
  return { deletedCount }
}

async function archiveOrRemoveRelayStorage({
  relayStoragePath = null,
  relayKey = null,
  publicIdentifier = null,
  saveRelaySnapshot = true
} = {}) {
  if (!relayStoragePath) {
    return { status: 'skipped', archivePath: null }
  }

  if (saveRelaySnapshot) {
    const storageBase = config?.storage || defaultStorageDir
    const archiveRoot = join(storageBase, 'relay-archives')
    const archivePath = join(
      archiveRoot,
      `${sanitizeArchiveSegment(publicIdentifier || relayKey || 'relay')}-${Date.now()}`
    )
    try {
      await fs.mkdir(archiveRoot, { recursive: true })
      await fs.cp(relayStoragePath, archivePath, { recursive: true, force: true })
      await fs.rm(relayStoragePath, { recursive: true, force: true })
      return { status: 'saved', archivePath }
    } catch (error) {
      return {
        status: 'error',
        archivePath: null,
        error: error?.message || String(error)
      }
    }
  }

  try {
    await fs.rm(relayStoragePath, { recursive: true, force: true })
    return { status: 'removed', archivePath: null }
  } catch (error) {
    return {
      status: 'error',
      archivePath: null,
      error: error?.message || String(error)
    }
  }
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

  try {
    const pluginAuthorization = assertPluginMessageAuthorization(message)
    if (pluginAuthorization.isPluginRequest) {
      console.info('[Worker] Authorized plugin-origin command', {
        pluginId: pluginAuthorization.pluginId,
        type: pluginAuthorization.commandType || message.type || null,
        permission: pluginAuthorization.requiredPermission
      })
    }
  } catch (error) {
    const requestId = extractMessageRequestId(message)
    const errorMessage = error?.message || String(error)
    sendWorkerResponse(requestId, {
      success: false,
      error: errorMessage
    })
    sendMessage({
      type: 'plugin-permission-denied',
      command: message?.type || null,
      requestId: requestId || null,
      pluginId: normalizePluginRequestId(message?.pluginId) || null,
      error: errorMessage
    })
    return
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

    case 'get-worker-identity': {
      const pubkeyHex =
        typeof config?.nostr_pubkey_hex === 'string'
          ? config.nostr_pubkey_hex
          : typeof storedParentConfig?.nostr_pubkey_hex === 'string'
            ? storedParentConfig.nostr_pubkey_hex
            : null
      const userKey =
        typeof config?.userKey === 'string'
          ? config.userKey
          : typeof storedParentConfig?.userKey === 'string'
            ? storedParentConfig.userKey
            : null
      sendMessage({
        type: 'worker-identity',
        data: {
          pubkeyHex: pubkeyHex ? String(pubkeyHex) : null,
          userKey: userKey || null
        }
      })
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
      const requestId =
        (typeof message.requestId === 'string' && message.requestId) ||
        (typeof message?.data?.requestId === 'string' && message.data.requestId) ||
        null
      const startedAt = Date.now()
      try {
	        const {
	          relayKey,
	          identifier: idFromMsg,
          publicIdentifier,
          fileHash,
          fileId: fileIdFromMsg,
          metadata,
          buffer,
	          localRelayBaseUrl
	        } = message.data || {}
	        const identifier = idFromMsg || publicIdentifier || relayKey
	        if (!identifier || !fileHash || !buffer) throw new Error('Missing identifier/publicIdentifier, fileHash, or buffer')
	        const resourceScope =
	          typeof metadata?.resourceScope === 'string'
	            ? metadata.resourceScope.trim().toLowerCase()
	            : null
	        const isConversationScope = resourceScope === 'conversation'
	        console.log(`[Upload] begin relayKey=${relayKey} identifier=${identifier} fileHash=${fileHash} metaKeys=${metadata ? Object.keys(metadata) : 'none'} bufLen=${buffer?.length}`)
	        const data = b4a.from(buffer, 'base64')
        const fileId =
          typeof fileIdFromMsg === 'string' && fileIdFromMsg.trim()
            ? fileIdFromMsg.trim()
            : fileHash
        let dedupHit = false
        try {
          dedupHit = await fileExists(identifier, fileHash)
        } catch (_) {}
        await ensureRelayFolder(identifier)
        await storeFile(identifier, fileHash, data, metadata || null)
	        let resolvedRelayKey = relayKey
	        if (!isConversationScope && !resolvedRelayKey && identifier && !/^[a-fA-F0-9]{64}$/.test(identifier)) {
	          try { resolvedRelayKey = await getRelayKeyFromPublicIdentifier(identifier) } catch (_) {}
	        }
	        if (!isConversationScope && resolvedRelayKey) {
	          await appendFilekeyDbEntry(resolvedRelayKey, fileHash)
	          ensureMirrorsForAllRelays().catch(err => console.warn('[Mirror] ensure after upload failed:', err))
	        } else if (!isConversationScope) {
	          console.warn('[Worker] upload-file: could not resolve relayKey for identifier', identifier)
	        }
	        const localUrl = buildLocalDriveFileUrl(localRelayBaseUrl, identifier, fileId)
	        const gatewayOrigins = isConversationScope ? [] : collectPublicGatewayOrigins()
	        const gatewayUrls = gatewayOrigins
	          .map((origin) => buildLocalDriveFileUrl(origin, identifier, fileId))
	          .filter(Boolean)
	        const gatewayUrl = gatewayUrls[0] || localUrl || null
	        const summary = {
	          relayKey: resolvedRelayKey || null,
	          identifier,
	          fileHash,
	          fileId,
	          url: localUrl,
	          gatewayUrl: isConversationScope ? null : gatewayUrl,
	          gatewayUrls: isConversationScope ? [] : gatewayUrls,
	          mime: metadata?.mimeType || metadata?.m || null,
	          size: Number.isFinite(metadata?.size) ? Number(metadata.size) : null,
          dim:
            typeof metadata?.dim === 'string' && metadata.dim
              ? metadata.dim
              : metadata?.dim && Number.isFinite(metadata.dim.width) && Number.isFinite(metadata.dim.height)
                ? `${Math.trunc(metadata.dim.width)}x${Math.trunc(metadata.dim.height)}`
                : null,
	          driveKey: config?.driveKey || null,
	          ownerPubkey: config?.nostr_pubkey_hex || null,
	          dedupHit,
	          elapsedMs: Date.now() - startedAt
	        }
	        if (isConversationScope) {
	          registerConversationFileObservation({
	            conversationId: identifier,
	            fileHash,
	            fileId,
	            driveKey: config?.driveKey || null,
	            ownerPubkey: config?.nostr_pubkey_hex || null,
	            url: localUrl,
	            mime: metadata?.mimeType || metadata?.m || null,
	            size: Number.isFinite(metadata?.size) ? Number(metadata.size) : null,
	            source: 'upload-file'
	          })
	        }
	        console.info('[Upload] complete', summary)
        console.log(`[Upload] complete relayKey=${resolvedRelayKey || relayKey} identifier=${identifier} fileHash=${fileHash}`)
        sendMessage({ type: 'upload-file-complete', relayKey: resolvedRelayKey || null, identifier, fileHash })
        sendWorkerResponse(requestId, {
          success: true,
          data: {
            ...summary,
            sha256: fileHash,
            ox: fileHash,
            metadata: metadata || null
          }
        })
      } catch (err) {
        console.error('[Worker] upload-file error:', err)
        sendWorkerResponse(requestId, {
          success: false,
          error: err?.message || String(err)
        })
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

    case 'media-create-session':
    case 'media-join-session':
    case 'media-leave-session':
    case 'media-list-sessions':
    case 'media-get-session':
    case 'media-update-stream-metadata':
    case 'media-send-signal':
    case 'media-start-recording':
    case 'media-stop-recording':
    case 'media-list-recordings':
    case 'media-export-recording':
    case 'media-transcode-recording':
    case 'media-get-service-status':
    case 'media-get-stats':
    case 'p2p-create-session':
    case 'p2p-join-session':
    case 'p2p-leave-session':
    case 'p2p-send-signal': {
      const requestId = extractMessageRequestId(message)
      const commandType = normalizeMediaCommandType(message.type)
      const payload = message?.data || {}
      try {
        if (!commandType) throw new Error(`Unsupported media command alias: ${message.type}`)
        const manager = getMediaServiceManager()
        const data = await manager.handleCommand(commandType, payload, {
          sourceType: message?.sourceType || message?.source || 'host',
          permissions: Array.isArray(message?.permissions) ? message.permissions : []
        })

        sendWorkerResponse(requestId, { success: true, data })
      } catch (err) {
        const errorMessage = err?.message || String(err)
        sendWorkerResponse(requestId, {
          success: false,
          error: errorMessage
        })
        sendMessage({
          type: 'media-error',
          command: commandType || message.type || null,
          requestId: requestId || null,
          error: errorMessage
        })
      }
      break
    }

    case 'plugin-marketplace-discover': {
      const requestId = extractMessageRequestId(message)
      const payload = message?.data || {}
      try {
        const service = getPluginMarketplaceService()
        const data = await service.discover(payload)
        sendWorkerResponse(requestId, { success: true, data })
      } catch (err) {
        sendWorkerResponse(requestId, {
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'plugin-marketplace-download': {
      const requestId = extractMessageRequestId(message)
      const payload = message?.data || {}
      try {
        const service = getPluginMarketplaceService()
        const data = await service.downloadArchive(payload)
        sendWorkerResponse(requestId, { success: true, data })
      } catch (err) {
        sendWorkerResponse(requestId, {
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'marmot-init':
    case 'marmot-list-conversations':
    case 'marmot-list-invites':
    case 'marmot-create-conversation':
    case 'marmot-invite-members':
    case 'marmot-grant-admin':
    case 'marmot-accept-invite':
    case 'marmot-load-thread':
    case 'marmot-send-message':
    case 'marmot-send-media-message':
    case 'marmot-mark-read':
    case 'marmot-update-conversation-metadata':
    case 'marmot-subscribe-conversation':
    case 'marmot-unsubscribe-conversation': {
      const requestId =
        (typeof message?.requestId === 'string' && message.requestId)
        || (typeof message?.data?.requestId === 'string' && message.data.requestId)
        || null
      const commandType = message.type
      const payload = message?.data || {}
      const commandSummary = summarizeMarmotCommandPayload(commandType, payload)
      const commandStartedAt = Date.now()

      console.info('[Worker][MarmotCommand] start', {
        type: commandType,
        requestId: requestId || null,
        ...commandSummary
      })

      try {
        const service = getMarmotService()
        const data = await service.handleCommand(commandType, payload)
        const elapsedMs = Date.now() - commandStartedAt
        console.info('[Worker][MarmotCommand] success', {
          type: commandType,
          requestId: requestId || null,
          elapsedMs,
          ...summarizeMarmotCommandResult(commandType, data)
        })
        sendWorkerResponse(requestId, { success: true, data })
      } catch (err) {
        const errorMessage = err?.message || String(err)
        const elapsedMs = Date.now() - commandStartedAt
        console.error('[Worker][MarmotCommand] failed', {
          type: commandType,
          requestId: requestId || null,
          elapsedMs,
          ...commandSummary,
          error: errorMessage
        }, err)
        sendWorkerResponse(requestId, {
          success: false,
          error: errorMessage
        })
        sendMessage({ type: 'error', message: `${commandType} failed: ${errorMessage}` })
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

    case 'leave-group': {
      const requestId = extractMessageRequestId(message)
      const data = (message && typeof message === 'object' ? message.data : null) || {}
      const saveRelaySnapshot = data?.saveRelaySnapshot !== false
      const saveSharedFiles = data?.saveSharedFiles !== false

      try {
        const requestedRelayKey =
          normalizeRelayKeyHex(data?.relayKey) ||
          (typeof data?.relayKey === 'string' ? data.relayKey.trim() : null) ||
          null
        const requestedPublicIdentifier =
          typeof data?.publicIdentifier === 'string' && data.publicIdentifier.trim()
            ? data.publicIdentifier.trim()
            : null

        if (!requestedRelayKey && !requestedPublicIdentifier) {
          throw new Error('leave-group requires relayKey or publicIdentifier')
        }

        let profile = null
        if (requestedRelayKey) {
          profile = await getRelayProfileByKey(requestedRelayKey)
        }
        if (!profile && requestedPublicIdentifier) {
          profile = await getRelayProfileByPublicIdentifier(requestedPublicIdentifier)
        }

        let resolvedRelayKey =
          requestedRelayKey ||
          profile?.relay_key ||
          (requestedPublicIdentifier ? await getRelayKeyFromPublicIdentifier(requestedPublicIdentifier) : null) ||
          null
        let resolvedPublicIdentifier =
          requestedPublicIdentifier ||
          profile?.public_identifier ||
          (resolvedRelayKey ? keyToPublic.get(resolvedRelayKey) || null : null)

        if (!profile && resolvedRelayKey) {
          profile = await getRelayProfileByKey(resolvedRelayKey)
        }
        if (!profile && resolvedPublicIdentifier) {
          profile = await getRelayProfileByPublicIdentifier(resolvedPublicIdentifier)
        }
        if (!resolvedRelayKey && profile?.relay_key) {
          resolvedRelayKey = profile.relay_key
        }
        if (!resolvedPublicIdentifier && profile?.public_identifier) {
          resolvedPublicIdentifier = profile.public_identifier
        }

        const fileProviders = saveSharedFiles && resolvedRelayKey
          ? await collectRelayFileProviderSnapshot(resolvedRelayKey)
          : []

        const disconnect = await disconnectRelayForCleanup({
          relayKey: resolvedRelayKey,
          publicIdentifier: resolvedPublicIdentifier,
          reason: 'leave-group'
        })

        let sharedFilesResult = {
          status: saveSharedFiles ? 'saved' : 'removed',
          recoveredCount: 0,
          failedCount: 0,
          deletedCount: 0,
          error: null
        }

        if (saveSharedFiles) {
          try {
            const recovered = await recoverRelayFilesFromSnapshot({
              relayKey: resolvedRelayKey,
              publicIdentifier: resolvedPublicIdentifier,
              fileProviders
            })
            sharedFilesResult.recoveredCount = recovered.recoveredCount
            sharedFilesResult.failedCount = recovered.failedCount
            if (resolvedRelayKey && resolvedPublicIdentifier && resolvedRelayKey !== resolvedPublicIdentifier) {
              const deletedLegacy = await cleanupRelayLocalFilePrefixes([resolvedRelayKey])
              sharedFilesResult.deletedCount = deletedLegacy.deletedCount
            }
          } catch (error) {
            sharedFilesResult = {
              ...sharedFilesResult,
              status: 'error',
              error: error?.message || String(error)
            }
          }
        } else {
          const deleted = await cleanupRelayLocalFilePrefixes([
            resolvedPublicIdentifier,
            resolvedRelayKey
          ])
          sharedFilesResult.deletedCount = deleted.deletedCount
        }

        const relayStoragePath =
          profile?.relay_storage ||
          (resolvedRelayKey ? join(config?.storage || defaultStorageDir, 'relays', resolvedRelayKey) : null)
        const relaySnapshotResult = await archiveOrRemoveRelayStorage({
          relayStoragePath,
          relayKey: resolvedRelayKey,
          publicIdentifier: resolvedPublicIdentifier,
          saveRelaySnapshot
        })

        if (resolvedRelayKey) {
          await removeRelayCorestore(resolvedRelayKey).catch(() => {})
        }

        const authStore = getRelayAuthStore()
        if (resolvedRelayKey) authStore.clearRelayAuth(resolvedRelayKey)
        if (resolvedPublicIdentifier) authStore.clearRelayAuth(resolvedPublicIdentifier)

        if (resolvedRelayKey) {
          await removeRelayProfile(resolvedRelayKey).catch((error) => {
            console.warn('[Worker] Failed to remove relay profile during leave-group', {
              relayKey: resolvedRelayKey,
              error: error?.message || error
            })
          })
          removeRelayMapping(resolvedRelayKey, resolvedPublicIdentifier || null)
        }

        await emitRelayUpdateSnapshot('leave-group')

        const responseData = {
          relayKey: resolvedRelayKey || null,
          publicIdentifier: resolvedPublicIdentifier || null,
          disconnect,
          archiveRelaySnapshot: relaySnapshotResult,
          sharedFiles: sharedFilesResult
        }

        sendWorkerResponse(requestId, { success: true, data: responseData })
        sendMessage({ type: 'leave-group-complete', data: responseData })
      } catch (error) {
        const errorMessage = error?.message || String(error)
        sendWorkerResponse(requestId, { success: false, error: errorMessage })
        sendMessage({ type: 'error', message: `leave-group failed: ${errorMessage}` })
      }
      break
    }

    case 'start-join-flow':
      if (relayServer) {
        const data = (message && typeof message === 'object' ? message.data : null) || {}
        const publicIdentifier = data.publicIdentifier
        const fileSharing = data.fileSharing
        const openJoin = data.openJoin === true
        const isOpen =
          typeof data.isOpen === 'boolean'
            ? data.isOpen
            : openJoin
              ? true
              : undefined
        const inviteToken = typeof data.token === 'string' ? data.token.trim() : null
        let joinBlindPeeringManager = null
        let joinRelayIdentifierForTracking = null
        try {
          let hostPeers = Array.isArray(data.hostPeers) ? data.hostPeers : []
          let coreRefs = Array.isArray(data.cores) ? normalizeCoreRefList(data.cores) : []
          let writerCoreRefs = Array.isArray(data.cores) ? normalizeMirrorWriterCoreRefs(data.cores) : []
          let blindPeer = sanitizeBlindPeerMeta(data.blindPeer)
          let joinRelayKey = normalizeRelayKeyHex(data.relayKey)
          let joinRelayUrl = data.relayUrl || null
          let writerCore = data.writerCore || null
          let writerSecret = data.writerSecret || null
          let writerCoreHex =
            data.writerCoreHex ||
            data.writer_core_hex ||
            data.autobaseLocal ||
            data.autobase_local ||
            null
          let autobaseLocal = data.autobaseLocal || data.autobase_local || null
          let fastForward = data.fastForward || data.fast_forward || null
          if (writerCoreHex && !autobaseLocal) autobaseLocal = writerCoreHex
          if (autobaseLocal && !writerCoreHex) writerCoreHex = autobaseLocal
          const writerCoreKey = writerCoreHex || autobaseLocal || writerCore || null
          if (writerCoreKey) {
            writerCoreRefs = mergeCoreRefLists(writerCoreRefs, [writerCoreKey])
          }
          hostPeers = hostPeers
            .map((key) => String(key || '').trim().toLowerCase())
            .filter(Boolean)

          console.info('[Worker] Start join flow input', {
            publicIdentifier,
            openJoin,
            isOpen,
            hasInviteToken: !!inviteToken,
            relayKey: previewValue(joinRelayKey, 16),
            relayUrl: joinRelayUrl ? String(joinRelayUrl).slice(0, 80) : null,
            hostPeersCount: hostPeers.length,
            hasBlindPeer: !!blindPeer?.publicKey,
            coreRefsCount: coreRefs.length,
            coreRefsPreview: summarizeCoreRefs(coreRefs),
            writerCoreRefsCount: writerCoreRefs.length,
            writerCorePrefix: previewValue(writerCore, 16),
            writerCoreHexPrefix: previewValue(writerCoreHex || autobaseLocal, 16),
            writerSecretLen: writerSecret ? String(writerSecret).length : 0,
            hasFastForward: !!fastForward
          })

          if (openJoin && publicIdentifier) {
            recordOpenJoinContext({
              publicIdentifier,
              fileSharing: fileSharing !== false,
              relayKey: joinRelayKey,
              relayUrl: joinRelayUrl
            })
          }

          if (openJoin && !inviteToken && (!writerCore || !writerSecret)) {
            const relayIdentifier = joinRelayKey || publicIdentifier
            if (relayIdentifier) {
              try {
                await ensurePublicGatewaySettingsLoaded()
                const bootstrapResult = await fetchOpenJoinBootstrap(relayIdentifier, { reason: 'open-join' })
                if (bootstrapResult?.status === 'ok' && bootstrapResult.data) {
                  const bootstrapData = bootstrapResult.data
                  const bootstrapBlindPeer = sanitizeBlindPeerMeta(bootstrapData.blindPeer)
                  const bootstrapCoreRefs = normalizeMirrorCoreRefs(bootstrapData.cores)
                  const bootstrapWriterCoreRefs = normalizeMirrorWriterCoreRefs(bootstrapData.cores)
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
                  if (bootstrapWriterCoreRefs.length) {
                    writerCoreRefs = mergeCoreRefLists(writerCoreRefs, bootstrapWriterCoreRefs)
                  }
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
                    coreRefsPreview: summarizeCoreRefs(coreRefs),
                    writerCoreRefsCount: writerCoreRefs.length,
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

          if ((!hostPeers || hostPeers.length === 0) && (!blindPeer || !blindPeer.publicKey)) {
            const relayIdentifier = joinRelayKey || publicIdentifier
            if (relayIdentifier) {
              try {
                console.log('[Worker] Join flow missing host peers/blind peer; attempting mirror metadata', {
                  publicIdentifier,
                  relayIdentifier,
                  relayKey: previewValue(joinRelayKey, 16),
                  hasInviteToken: !!inviteToken,
                  openJoin,
                  isOpen
                })
                await ensurePublicGatewaySettingsLoaded()
                const mirrorResult = await fetchRelayMirrorMetadata(relayIdentifier, { reason: 'join-flow' })
                if (mirrorResult?.status === 'ok' && mirrorResult.data) {
                  const mirrorData = mirrorResult.data
                  const mirrorBlindPeer = sanitizeBlindPeerMeta(mirrorData.blindPeer)
                  const mirrorCoreRefs = normalizeMirrorCoreRefs(mirrorData.cores)
                  const mirrorWriterCoreRefs = normalizeMirrorWriterCoreRefs(mirrorData.cores)
                  const mirrorRelayKey = normalizeRelayKeyHex(
                    mirrorData.relayKey || mirrorData.relay_key || null
                  )
                  if (!joinRelayKey && mirrorRelayKey) joinRelayKey = mirrorRelayKey
                  if (!blindPeer && mirrorBlindPeer) blindPeer = mirrorBlindPeer
                  if (!coreRefs.length && mirrorCoreRefs.length) coreRefs = mirrorCoreRefs
                  if (mirrorWriterCoreRefs.length) {
                    writerCoreRefs = mergeCoreRefLists(writerCoreRefs, mirrorWriterCoreRefs)
                  }
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
                    relayKey: joinRelayKey ? String(joinRelayKey).slice(0, 16) : null,
                    coreRefsPreview: coreRefs.slice(0, 3),
                    writerCoreRefsCount: writerCoreRefs.length,
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

          if (!openJoin) {
            const poolKey = joinRelayKey || publicIdentifier || null
            if (poolKey) {
              try {
                const pool = await getRelayWriterPool(poolKey)
                const poolCoreRefs = collectClosedJoinPoolCoreRefs(pool?.entries || [])
                if (poolCoreRefs.length) {
                  writerCoreRefs = mergeCoreRefLists(writerCoreRefs, poolCoreRefs)
                  coreRefs = mergeCoreRefLists(coreRefs, poolCoreRefs)
                }
                console.log('[Worker] Closed join pool promotion', {
                  relayKey: previewValue(joinRelayKey, 16),
                  publicIdentifier,
                  poolEntries: Array.isArray(pool?.entries) ? pool.entries.length : 0,
                  poolCoreRefsCount: poolCoreRefs.length,
                  writerCoreRefsCount: writerCoreRefs.length,
                  coreRefsCount: coreRefs.length
                })
              } catch (err) {
                console.warn('[Worker] Closed join pool promotion failed', err?.message || err)
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
                joinBlindPeeringManager = manager
                joinRelayIdentifierForTracking = relayIdentifier
                if (typeof manager.markJoinStart === 'function') {
                  manager.markJoinStart({
                    relayKey: relayIdentifier,
                    publicIdentifier,
                    reason: 'join-flow'
                  })
                }
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
                  reason: 'join-flow',
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
            isOpen,
            hasInviteToken: !!inviteToken,
            relayKey: previewValue(joinRelayKey, 16),
            relayUrl: joinRelayUrl ? String(joinRelayUrl).slice(0, 80) : null,
            hostPeersCount: hostPeers.length,
            hasBlindPeer: !!blindPeer?.publicKey,
            coreRefsCount: coreRefs.length,
            coreRefsPreview: summarizeCoreRefs(coreRefs),
            writerCoreRefsCount: writerCoreRefs.length,
            writerCorePrefix: previewValue(writerCore, 16),
            writerCoreHexPrefix: previewValue(writerCoreHex || autobaseLocal, 16),
            writerSecretLen: writerSecret ? String(writerSecret).length : 0,
            hasFastForward: !!fastForward
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
            writerCoreRefs,
            writerCore,
            writerCoreHex,
            autobaseLocal,
            writerSecret,
            fastForward
          })
          if (joinBlindPeeringManager && joinRelayIdentifierForTracking && typeof joinBlindPeeringManager.markJoinEnd === 'function') {
            joinBlindPeeringManager.markJoinEnd({
              relayKey: joinRelayIdentifierForTracking,
              publicIdentifier,
              reason: 'join-flow',
              status: 'ok'
            })
            joinBlindPeeringManager = null
            joinRelayIdentifierForTracking = null
          }
        } catch (err) {
          if (joinBlindPeeringManager && joinRelayIdentifierForTracking && typeof joinBlindPeeringManager.markJoinEnd === 'function') {
            joinBlindPeeringManager.markJoinEnd({
              relayKey: joinRelayIdentifierForTracking,
              publicIdentifier,
              reason: 'join-flow',
              status: 'error'
            })
            joinBlindPeeringManager = null
            joinRelayIdentifierForTracking = null
          }
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

    case 'provision-writer-for-invitee':
      try {
        const requestData = message?.data || {}
        console.log('[Worker] Provision writer requested', {
          relayKey: previewValue(requestData.relayKey, 16),
          publicIdentifier: requestData.publicIdentifier || null,
          invitee: previewValue(requestData.inviteePubkey, 16),
          useWriterPool: requestData.useWriterPool !== false
        })
        const requestId = message?.requestId
        if (!relayServer?.provisionWriterForInvitee) throw new Error('Relay server unavailable')
        const relayKey = normalizeRelayKeyHex(requestData.relayKey) || requestData.relayKey || null
        let poolResult = null
        let result = null
        if (requestData.useWriterPool !== false) {
          poolResult = await claimClosedJoinWriterPoolEntry({
            relayKey,
            publicIdentifier: requestData.publicIdentifier || null,
            inviteePubkey: requestData.inviteePubkey || null
          })
          if (poolResult?.entry) {
            result = {
              relayKey: relayKey || null,
              ...poolResult.entry
            }
          }
        }
        if (!result) {
          result = await relayServer.provisionWriterForInvitee({
            ...(message.data || {}),
            relayKey,
            reason: requestData.useWriterPool === false ? 'invite-direct' : 'invite-fallback'
          })
        }

        const resolvedRelayKey = result?.relayKey || relayKey || null
        const poolCoreRefs = normalizeCoreRefList([
          ...(poolResult?.pool?.coreRefs || []),
          result?.writerCoreHex || result?.autobaseLocal || result?.writerCore || null
        ])
        const fastForward = resolvedRelayKey ? buildFastForwardCheckpoint(resolvedRelayKey) : null
        const responsePayload = {
          ...(result || {}),
          poolCoreRefs,
          poolAvailable: poolResult?.pool?.available ?? null,
          poolKey: poolResult?.pool?.poolKey ? previewValue(poolResult.pool.poolKey, 16) : null,
          fastForward
        }

        sendMessage({ type: 'provision-writer-for-invitee:result', requestId, data: responsePayload })
        try {
          const writerCoreHex = result?.writerCoreHex || result?.autobaseLocal || null
          console.log('[Worker] Refreshing blind-peer mirrors after invite writer', {
            relayKey: resolvedRelayKey,
            hasWriterCoreHex: !!writerCoreHex
          })
          const manager = await ensureBlindPeeringManager()
          if (manager?.started) {
            const relayManager = resolvedRelayKey ? activeRelays.get(resolvedRelayKey) : null
            if (relayManager?.relay) {
              const storedCoreRefs = await resolveRelayMirrorCoreRefs(
                resolvedRelayKey,
                message?.data?.publicIdentifier || relayManager?.publicIdentifier || null
              )
              manager.ensureRelayMirror({
                relayKey: resolvedRelayKey,
                publicIdentifier: message?.data?.publicIdentifier || relayManager?.publicIdentifier || null,
                autobase: relayManager.relay,
                coreRefs: storedCoreRefs,
                corestore: relayManager.store || null
              })
            } else {
              await seedBlindPeeringMirrors(manager)
            }
            await manager.refreshFromBlindPeers('invite-writer')
            const summary = await rehydrateMirrorsWithRetry(manager, {
              reason: 'invite-writer',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS,
              retries: BLIND_PEER_REHYDRATION_RETRIES,
              backoffMs: BLIND_PEER_REHYDRATION_BACKOFF_MS
            })
            console.log('[Worker] Blind-peer refresh complete after invite writer', {
              relayKey: resolvedRelayKey,
              status: summary?.status ?? null,
              synced: summary?.synced ?? null,
              failed: summary?.failed ?? null
            })
          } else {
            console.log('[Worker] Blind-peer manager not started; skipping invite-writer refresh', {
              relayKey: resolvedRelayKey,
              enabled: manager?.enabled ?? null
            })
          }
        } catch (err) {
          console.warn('[Worker] Blind-peer refresh after invite writer failed', {
            error: err?.message || err
          })
        }
        refreshRelayMirrorMetadata('invite-writer').catch((error) => {
          console.warn('[Worker] Mirror metadata refresh failed after invite writer:', error?.message || error)
        })
        return result
      } catch (err) {
        sendMessage({
          type: 'provision-writer-for-invitee:error',
          requestId: message?.requestId,
          error: err?.message || String(err)
        })
        return { error: err?.message || String(err) }
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

    case 'refresh-relay-subscriptions':
      try {
        const requestId = message?.requestId
        const payload = (message && typeof message === 'object' ? message.data : null) || {}
        const reason = typeof payload.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim()
          : 'manual'
        const publicIdentifier =
          typeof payload.publicIdentifier === 'string' && payload.publicIdentifier.trim()
            ? payload.publicIdentifier.trim()
            : null
        const requestedRelayKeyRaw =
          typeof payload.relayKey === 'string' && payload.relayKey.trim()
            ? payload.relayKey.trim()
            : null
        const requestedRelayKey = normalizeRelayKeyHex(requestedRelayKeyRaw) || requestedRelayKeyRaw || null
        let resolvedRelayKey = normalizeRelayKeyHex(payload.relayKey) || null
        let lookupSource = resolvedRelayKey ? 'payload' : null
        console.log('[Worker] refresh-relay-subscriptions request', {
          reason,
          publicIdentifier,
          requestedRelayKey: requestedRelayKey || null
        })
        if (!resolvedRelayKey && publicIdentifier) {
          try {
            resolvedRelayKey = await getRelayKeyFromPublicIdentifier(publicIdentifier)
            if (resolvedRelayKey) lookupSource = 'profile-map'
          } catch (_err) {
            // fallback below
          }
        }
        if (!resolvedRelayKey && publicIdentifier) {
          for (const [relayKey, manager] of activeRelays.entries()) {
            const managerIdentifier = manager?.publicIdentifier || keyToPublic.get(relayKey) || null
            if (managerIdentifier === publicIdentifier) {
              resolvedRelayKey = relayKey
              lookupSource = 'active-relays'
              break
            }
          }
        }

        if (!resolvedRelayKey) {
          sendMessage({
            type: 'refresh-relay-subscriptions:result',
            requestId,
            data: {
              status: 'skipped',
              reason: 'relay-not-found',
              publicIdentifier,
              relayKey: null,
              requestedRelayKey: requestedRelayKey || null
            }
          })
          break
        }

        if (!relayServer || typeof global.requestRelaySubscriptionRefresh !== 'function') {
          sendMessage({
            type: 'refresh-relay-subscriptions:result',
            requestId,
            data: {
              status: 'skipped',
              reason: 'relay-server-unavailable',
              publicIdentifier,
              relayKey: resolvedRelayKey,
              requestedRelayKey: requestedRelayKey || null,
              resolvedRelayKey,
              lookupSource
            }
          })
          break
        }

        const refreshKey = makeRelaySubscriptionRefreshKey({
          relayKey: resolvedRelayKey,
          publicIdentifier
        })
        const now = Date.now()
        pruneRelaySubscriptionRefreshState(now)
        const inFlight = relaySubscriptionRefreshInFlight.get(refreshKey)
        if (inFlight) {
          const inFlightOutcome = await inFlight
          sendMessage({
            type: 'refresh-relay-subscriptions:result',
            requestId,
            data: {
              status: 'ok',
              publicIdentifier,
              relayKey: inFlightOutcome.finalRelayKey,
              reason,
              result: inFlightOutcome.result || null,
              requestedRelayKey: requestedRelayKey || null,
              resolvedRelayKey,
              lookupSource,
              retried: inFlightOutcome.retried,
              retryRelayKey: inFlightOutcome.retryRelayKey,
              coalesced: true
            }
          })
          break
        }

        const lastRefreshAt = relaySubscriptionRefreshRecent.get(refreshKey)
        if (
          Number.isFinite(lastRefreshAt) &&
          now - lastRefreshAt < RELAY_SUBSCRIPTION_REFRESH_MIN_INTERVAL_MS
        ) {
          sendMessage({
            type: 'refresh-relay-subscriptions:result',
            requestId,
            data: {
              status: 'skipped',
              reason: 'throttled',
              publicIdentifier,
              relayKey: resolvedRelayKey,
              requestedRelayKey: requestedRelayKey || null,
              resolvedRelayKey,
              lookupSource,
              throttleWindowMs: RELAY_SUBSCRIPTION_REFRESH_MIN_INTERVAL_MS,
              lastRefreshAt
            }
          })
          break
        }

        const refreshPromise = (async () => {
          let result = await global.requestRelaySubscriptionRefresh(resolvedRelayKey, {
            reason
          })
          let finalRelayKey = resolvedRelayKey
          let retryRelayKey = null
          let retried = false
          if (result?.status === 'skipped' && result?.reason === 'no-clients' && publicIdentifier) {
            for (const [candidateRelayKey, manager] of activeRelays.entries()) {
              const managerIdentifier = manager?.publicIdentifier || keyToPublic.get(candidateRelayKey) || null
              if (managerIdentifier !== publicIdentifier) continue
              if (candidateRelayKey === resolvedRelayKey) continue
              retryRelayKey = candidateRelayKey
              break
            }
            if (retryRelayKey) {
              retried = true
              console.log('[Worker] refresh-relay-subscriptions retrying with fallback relay key', {
                reason,
                publicIdentifier,
                initialRelayKey: resolvedRelayKey,
                retryRelayKey
              })
              const retryResult = await global.requestRelaySubscriptionRefresh(retryRelayKey, {
                reason: `${reason}:fallback`
              })
              if (retryResult && retryResult.status !== 'skipped') {
                result = retryResult
                finalRelayKey = retryRelayKey
              } else {
                result = retryResult || result
              }
            }
          }
          return {
            result: result || null,
            finalRelayKey,
            retryRelayKey,
            retried
          }
        })()

        relaySubscriptionRefreshInFlight.set(refreshKey, refreshPromise)
        let refreshOutcome = null
        try {
          refreshOutcome = await refreshPromise
        } finally {
          relaySubscriptionRefreshInFlight.delete(refreshKey)
        }
        const completedAt = Date.now()
        relaySubscriptionRefreshRecent.set(refreshKey, completedAt)
        if (refreshOutcome?.finalRelayKey && refreshOutcome.finalRelayKey !== resolvedRelayKey) {
          relaySubscriptionRefreshRecent.set(
            makeRelaySubscriptionRefreshKey({
              relayKey: refreshOutcome.finalRelayKey,
              publicIdentifier
            }),
            completedAt
          )
        }
        pruneRelaySubscriptionRefreshState(completedAt)

        const result = refreshOutcome?.result || null
        const finalRelayKey = refreshOutcome?.finalRelayKey || resolvedRelayKey
        const retryRelayKey = refreshOutcome?.retryRelayKey || null
        const retried = !!refreshOutcome?.retried
        console.log('[Worker] refresh-relay-subscriptions result', {
          reason,
          publicIdentifier,
          requestedRelayKey: requestedRelayKey || null,
          resolvedRelayKey,
          lookupSource,
          retried,
          retryRelayKey,
          finalRelayKey,
          result
        })
        sendMessage({
          type: 'refresh-relay-subscriptions:result',
          requestId,
          data: {
            status: 'ok',
            publicIdentifier,
            relayKey: finalRelayKey,
            reason,
            result: result || null,
            requestedRelayKey: requestedRelayKey || null,
            resolvedRelayKey,
            lookupSource,
            retried,
            retryRelayKey,
            coalesced: false
          }
        })
      } catch (err) {
        sendMessage({
          type: 'refresh-relay-subscriptions:error',
          requestId: message?.requestId,
          error: err?.message || String(err)
        })
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

  if (marmotService?.stop) {
    try {
      await marmotService.stop()
    } catch (err) {
      console.warn('[Worker] Failed to stop marmot service:', err?.message || err)
    }
  }
  marmotService = null

  if (mediaServiceManager?.stop) {
    try {
      await mediaServiceManager.stop()
    } catch (err) {
      console.warn('[Worker] Failed to stop media service manager:', err?.message || err)
    }
  }
  mediaServiceManager = null
  pluginMarketplaceService = null

  if (conversationFileIndex?.close) {
    try {
      await conversationFileIndex.close()
    } catch (err) {
      console.warn('[Worker] Failed to close conversation file index:', err?.message || err)
    }
  }
  conversationFileIndex = null

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
      await blindPeeringManager.clearAllMirrors({ reason: 'shutdown' })
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
	        await ensureConversationFileIndex(userSpecificStorage)

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
	        await ensureConversationFileIndex(config?.storage || global.userConfig?.storage || defaultStorageDir)
	      }

    applyClosedJoinPoolConfig(config)

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
      sendMessage({
        type: 'relay-server-ready',
        ts: Date.now(),
        data: {
          mode: 'hyperswarm'
        }
      })

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
