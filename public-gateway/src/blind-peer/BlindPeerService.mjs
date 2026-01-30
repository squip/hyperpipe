import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import hypercoreCrypto from 'hypercore-crypto';
import HypercoreId from 'hypercore-id-encoding';

const DEFAULT_STORAGE_SUBDIR = 'blind-peer-data';
const CJTRACE_TAG = '[CJTRACE]';
const DEFAULT_MIRROR_STALE_THRESHOLD_MS = 10 * 60 * 1000;

async function loadBlindPeerModule() {
  const mod = await import('blind-peer');
  return mod?.default || mod;
}

async function loadBlindPeeringModule() {
  const mod = await import('blind-peering');
  return mod?.default || mod;
}

function serializeError(error) {
  if (!error || typeof error !== 'object') {
    return { message: error ? String(error) : null };
  }
  return {
    message: error.message || String(error),
    name: error.name || null,
    code: error.code || null,
    stack: error.stack || null,
    cause: error.cause ? (error.cause.message || String(error.cause)) : null,
    errors: Array.isArray(error.errors)
      ? error.errors.map((entry) => entry?.message || String(entry))
      : null
  };
}

function toKeyString(value) {
  if (!value) return null;
  try {
    if (typeof value === 'string') {
      return HypercoreId.encode(HypercoreId.decode(value));
    }
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return HypercoreId.encode(buf);
  } catch (_) {
    if (typeof value === 'string') return value.trim() || null;
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    return null;
  }
}

function toPeerKeyBuffer(key) {
  if (!key) return null;
  if (Buffer.isBuffer(key)) {
    return key.length ? Buffer.from(key) : null;
  }
  if (key instanceof Uint8Array) {
    return key.length ? Buffer.from(key) : null;
  }
  if (typeof key === 'string') {
    const trimmed = key.trim();
    if (!trimmed) return null;
    try {
      const decoded = HypercoreId.decode(trimmed);
      return decoded.length ? Buffer.from(decoded) : null;
    } catch (_) {
      const isHex = /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0;
      if (!isHex) return null;
      try {
        const buffer = Buffer.from(trimmed, 'hex');
        return buffer.length ? buffer : null;
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function sanitizePeerKey(key) {
  const buffer = toPeerKeyBuffer(key);
  if (buffer) {
    try {
      return HypercoreId.encode(buffer);
    } catch (_) {
      return buffer.toString('hex');
    }
  }
  if (typeof key === 'string') {
    const trimmed = key.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function sanitizeRelayKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function decodeKey(key) {
  const buffer = toPeerKeyBuffer(key);
  return buffer ? Buffer.from(buffer) : null;
}

export default class BlindPeerService extends EventEmitter {
  constructor({ logger, config, metrics } = {}) {
    super();
    this.logger = logger || console;
    this.config = config || {};
    this.metrics = metrics || {
      setActive: () => {},
      setTrustedPeers: () => {},
      setBytesAllocated: () => {},
      incrementGcRuns: () => {},
      recordEvictions: () => {}
    };

    this.initialized = false;
    this.running = false;
    this.storageDir = this.config.storageDir || null;
    this.trustedPeers = new Set();
    this.trustedPeerMeta = new Map();
    this.trustedPeersPersistPath = this.config.trustedPeersPersistPath
      ? resolve(this.config.trustedPeersPersistPath)
      : null;
    this.trustedPeersLoaded = false;
    this.blindPeer = null;
    this.blindPeering = null;
    this.blindPeeringSwarm = null;
    this.blindPeeringStore = null;
    this.blindPeeringSwarmLogInterval = null;
    this.blindPeeringMirrorKey = null;
    this.blindPeeringClientKey = null;
    this.blindPeeringTopicKey = null;
    this.blindPeeringKeyPath = this.config?.blindPeeringKeyPath
      ? resolve(this.config.blindPeeringKeyPath)
      : null;
    this.cleanupInterval = null;
    this.hygieneInterval = null;
    this.hygieneRunning = false;
    this.hygieneStats = {
      totalRuns: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastResult: null,
      lastError: null,
      lastBytesFreed: 0,
      lastEvictions: 0
    };
    this.coreMetadata = new Map();
    this.coreDiagnosticsPrev = new Map();
    this.dispatcherAssignments = new Map();
    this.dispatcherAssignmentTimers = new Map();
    this.metadataPersistPath = this.config.metadataPersistPath
      ? resolve(this.config.metadataPersistPath)
      : null;
    this.metadataDirty = false;
    this.metadataSaveTimer = null;
    const readinessCandidate = this.config?.mirror?.staleThresholdMs ?? this.config?.mirrorStaleThresholdMs;
    const readinessValue = Number(readinessCandidate);
    this.mirrorStaleThresholdMs = Number.isFinite(readinessValue) && readinessValue > 0
      ? Math.trunc(readinessValue)
      : DEFAULT_MIRROR_STALE_THRESHOLD_MS;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.config.enabled) {
      this.logger?.debug?.('[BlindPeer] Service disabled by configuration');
      this.initialized = true;
      this.metrics.setActive?.(0);
      this.#updateMetrics();
      return;
    }

    await this.#loadTrustedPeersFromDisk();
    await this.#ensureStorageDir();
    this.#ensureMetadataPersistPath();
    await this.#loadCoreMetadataFromDisk();
    this.initialized = true;
    this.logger?.info?.(this.getStatus(), '[BlindPeer] Initialized');
  }

  async start() {
    if (!this.initialized) await this.initialize();
    if (!this.config.enabled) return false;
    if (this.running) return true;

    await this.#createBlindPeer();
    this.running = true;
    this.metrics.setActive?.(1);
    const announcement = this.getAnnouncementInfo();
    this.logger?.info?.(announcement, '[BlindPeer] Service started');
    this.logger?.info?.(announcement, `${CJTRACE_TAG} blind peer announcement`);
    this.cleanupInterval = setInterval(() => this.#updateMetrics(), 30000).unref();
    // TODO: allow dynamic tuning once session bridging supplements the hygiene scheduler.
    this.#startHygieneLoop();
    return true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.blindPeeringSwarmLogInterval) {
      clearInterval(this.blindPeeringSwarmLogInterval);
      this.blindPeeringSwarmLogInterval = null;
    }

    if (this.hygieneInterval) {
      clearInterval(this.hygieneInterval);
      this.hygieneInterval = null;
    }
    this.hygieneRunning = false;

    if (this.blindPeer?.close) {
      try {
        await this.blindPeer.close();
      } catch (error) {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Error while stopping blind-peer instance');
      }
    }

    this.blindPeer = null;
    if (this.blindPeering?.close) {
      try {
        await this.blindPeering.close();
      } catch (error) {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Failed to close blind-peering client');
      }
    }
    this.blindPeering = null;
    if (this.blindPeeringSwarm) {
      try {
        await this.blindPeeringSwarm.destroy();
      } catch (error) {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Failed to close blind-peering swarm');
      }
    }
    this.blindPeeringSwarm = null;
    if (this.blindPeeringStore) {
      try {
        this.logger?.info?.({
          storeClosed: this.blindPeeringStore?.closed ?? null,
          storeClosing: this.blindPeeringStore?.closing ?? null
        }, '[BlindPeer] Closing blind-peering corestore');
        await this.blindPeeringStore.close();
      } catch (error) {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Failed to close blind-peering corestore');
      }
    }
    this.blindPeeringStore = null;
    this.blindPeeringMirrorKey = null;
    this.blindPeeringClientKey = null;
    this.#updateMetrics();
    this.metrics.setActive?.(0);
    for (const timer of this.dispatcherAssignmentTimers.values()) {
      clearTimeout(timer);
    }
    this.dispatcherAssignmentTimers.clear();
    this.dispatcherAssignments.clear();
    if (this.metadataSaveTimer) {
      clearTimeout(this.metadataSaveTimer);
      this.metadataSaveTimer = null;
    }
    await this.#persistCoreMetadata(true);
    this.logger?.info?.('[BlindPeer] Service stopped');
  }

  addTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    if (this.trustedPeers.has(sanitized)) {
      this.logger?.debug?.( { peerKey: sanitized }, '[BlindPeer] Trusted peer add skipped (already trusted)');
      return false;
    }
    this.logger?.info?.( {
      inputType: peerKey instanceof Uint8Array ? 'uint8array' : Buffer.isBuffer(peerKey) ? 'buffer' : typeof peerKey,
      peerKey: sanitized
    }, '[BlindPeer] Adding trusted peer');
    this.trustedPeers.add(sanitized);
    const now = Date.now();
    this.trustedPeerMeta.set(sanitized, {
      trustedSince: now
    });

    if (this.blindPeer?.addTrustedPubKey) {
      try {
        this.blindPeer.addTrustedPubKey(sanitized);
        this.logger?.debug?.( { peerKey: sanitized }, '[BlindPeer] Delegated peer to blind-peer instance');
      } catch (error) {
        this.logger?.warn?.( {
          peerKey: sanitized,
          err: error?.message || error
        }, '[BlindPeer] Failed to add trusted peer to running service');
      }
    }

    this.logger?.debug?.( { peerKey: sanitized }, '[BlindPeer] Trusted peer added');
    this.#updateTrustedPeers();
    if (this.trustedPeersPersistPath) {
      this.#persistTrustedPeers().catch((error) => {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Failed to persist trusted peers');
      });
    }
    return true;
  }

  removeTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    const removed = this.trustedPeers.delete(sanitized);
    if (removed) {
      this.logger?.info?.( { peerKey: sanitized }, '[BlindPeer] Removing trusted peer');
      this.trustedPeerMeta.delete(sanitized);
      this.#updateTrustedPeers();
      if (this.trustedPeersPersistPath) {
        this.#persistTrustedPeers().catch((error) => {
          this.logger?.warn?.( {
            err: error?.message || error
          }, '[BlindPeer] Failed to persist trusted peers');
        });
      }
    }
    return removed;
  }

  recordDispatcherAssignment({ jobId, peerKey, relayKey, filters = [], requester = null } = {}) {
    if (!jobId) return null;
    const sanitizedPeer = sanitizePeerKey(peerKey);
    const sanitizedRelay = sanitizeRelayKey(relayKey);
    const entry = {
      jobId,
      peerKey: sanitizedPeer,
      relayKey: sanitizedRelay,
      filters: Array.isArray(filters) ? filters : [],
      requester: requester || null,
      status: 'assigned',
      assignedAt: Date.now(),
      completedAt: null
    };
    if (!sanitizedPeer && sanitizedRelay) {
      entry.requester = entry.requester || {};
    }
    if (sanitizedPeer) {
      this.addTrustedPeer(sanitizedPeer);
    }
    if (this.dispatcherAssignmentTimers.has(jobId)) {
      clearTimeout(this.dispatcherAssignmentTimers.get(jobId));
      this.dispatcherAssignmentTimers.delete(jobId);
    }
    this.dispatcherAssignments.set(jobId, entry);
    return entry;
  }

  clearDispatcherAssignment(jobId, { status = 'completed', details = null } = {}) {
    if (!jobId) return null;
    const entry = this.dispatcherAssignments.get(jobId);
    if (!entry) return null;
    entry.status = status;
    entry.completedAt = Date.now();
    entry.details = details;
    this.dispatcherAssignments.set(jobId, entry);
    this.#scheduleDispatcherAssignmentCleanup(jobId);
    return entry;
  }

  getDispatcherAssignmentsSnapshot() {
    return Array.from(this.dispatcherAssignments.values())
      .sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0));
  }

  async mirrorCore(coreOrKey, options = {}) {
    if (!this.running || !this.blindPeer) {
      this.logger?.debug?.( { core: !!coreOrKey }, '[BlindPeer] mirrorCore skipped (service inactive)');
      return { status: 'inactive' };
    }

    const core = coreOrKey && typeof coreOrKey === 'object' && typeof coreOrKey.key === 'object'
      ? coreOrKey
      : null;

    const key = core ? core.key : decodeKey(coreOrKey);
    if (!key) {
      this.logger?.warn?.({
        inputType: typeof coreOrKey,
        inputPreview: typeof coreOrKey === 'string' ? coreOrKey.slice(0, 64) : null
      }, '[BlindPeer] mirrorCore invalid key');
      throw new Error('Invalid core key provided to mirrorCore');
    }

    const announce = options.announce === true;
    const priority = options.priority ?? 0;
    const referrerKey = options.referrer ? decodeKey(options.referrer) : null;
    const referrerString = options.referrer ? toKeyString(options.referrer) : null;
    const request = {
      key,
      announce,
      priority,
      referrer: referrerKey
    };
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : null;

    try {
      let record = null;
      const mode = typeof this.blindPeer?.addCore === 'function'
        ? 'blindPeer.addCore'
        : 'blindPeering.addCore';
      if (typeof this.blindPeer?.addCore === 'function') {
        record = await this.blindPeer.addCore(request);
      } else {
        const blindPeering = await this.#ensureBlindPeeringClient({ reason: 'mirror-core' });
        if (!blindPeering || !this.blindPeeringStore) {
          this.logger?.warn?.( {
            key: toKeyString(key),
            announce,
            priority,
            mode
          }, '[BlindPeer] mirrorCore skipped (blind-peering unavailable)');
          return { status: 'unavailable' };
        }
        if (this.blindPeeringStore?.closed || this.blindPeeringStore?.closing) {
          this.logger?.warn?.({
            key: toKeyString(key),
            announce,
            priority,
            mode,
            storeClosed: this.blindPeeringStore?.closed ?? null,
            storeClosing: this.blindPeeringStore?.closing ?? null
          }, '[BlindPeer] mirrorCore skipped (blind-peering store closed)');
          return { status: 'store-closed' };
        }
        const core = this.blindPeeringStore.get({ key });
        await core.ready();
        await blindPeering.addCore(core, core.key, {
          announce,
          priority,
          referrer: referrerString || null,
          pick: 1
        });
        if (this.config?.blindPeeringCloseCores !== false) {
          core.close().catch(() => {});
        }
      }
      this.logger?.info?.({
        key: toKeyString(key),
        announce,
        priority,
        mirrorKey: this.blindPeeringMirrorKey || null,
        clientKey: this.blindPeeringClientKey || null
      }, '[BlindPeer] Core mirror requested');
      this.logger?.info?.({
        key: toKeyString(key)?.slice(0, 16) || null,
        announce,
        priority,
        hasMetadata: !!metadata,
        metadataIdentifier: metadata?.identifier || null,
        metadataType: metadata?.type || null,
        metadataRole: metadata?.role || null,
        metadataRoles: Array.isArray(metadata?.roles) ? metadata.roles.slice(0, 10) : null
      }, `${CJTRACE_TAG} blind peer mirror core`);
      if (metadata) {
        this.#recordCoreMetadata(key, {
          priority,
          announce,
          ...metadata
        });
      } else {
        this.#touchCoreMetadata(key, {
          priority,
          announce
        });
      }
      this.#updateMetrics();
      this.#logCoreDiagnostics({
        key,
        context: 'mirror-core',
        identifier: metadata?.identifier || null,
        reason: options?.reason || null,
        type: metadata?.type || null,
        role: metadata?.role || null,
        priority,
        announce
      }).catch(() => {});
      return { status: 'accepted', record };
    } catch (error) {
      this.logger?.warn?.({
        key: toKeyString(key),
        announce,
        priority,
        mirrorKey: this.blindPeeringMirrorKey || null,
        clientKey: this.blindPeeringClientKey || null,
        mode: typeof this.blindPeer?.addCore === 'function'
          ? 'blindPeer.addCore'
          : 'blindPeering.addCore',
        blindPeerMethods: {
          addCore: typeof this.blindPeer?.addCore === 'function',
          ready: typeof this.blindPeer?.ready === 'function',
          listen: typeof this.blindPeer?.listen === 'function'
        },
        error: serializeError(error)
      }, '[BlindPeer] Failed to mirror core');
      throw error;
    }
  }

  async mirrorAutobase(autobase, options = {}) {
    if (!this.running || !this.blindPeer) return { status: 'inactive' };
    if (!autobase || typeof autobase !== 'object') {
      throw new Error('Invalid autobase instance provided');
    }

    const targetKey = options.target ? decodeKey(options.target) : null;
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : null;
    try {
      const result = await this.blindPeer.addAutobase(autobase, targetKey);
      this.logger?.info?.( {
        target: toKeyString(targetKey),
        writers: Array.isArray(autobase.writers) ? autobase.writers.length : null
      }, '[BlindPeer] Autobase mirrored');
      this.logger?.info?.( {
        target: toKeyString(targetKey)?.slice(0, 16) || null,
        writers: Array.isArray(autobase.writers) ? autobase.writers.length : null,
        metadataIdentifier: metadata?.identifier || null,
        metadataType: metadata?.type || null
      }, `${CJTRACE_TAG} blind peer mirror autobase`);
      if (metadata?.coreKey) {
        const resolvedKey = metadata.coreKey;
        this.#recordCoreMetadata(resolvedKey, {
          priority: metadata.priority ?? 1,
          ownerPeerKey: metadata.ownerPeerKey,
          type: metadata.type || 'autobase',
          identifier: metadata.identifier || null,
          announce: metadata.announce === true
        });
      }
      this.#updateMetrics();
      return { status: 'accepted', result };
    } catch (error) {
      this.logger?.warn?.({
        target: toKeyString(targetKey),
        err: error?.message || error,
        name: error?.name || null,
        code: error?.code || null,
        stack: error?.stack || null,
        cause: error?.cause?.message || error?.cause || null
      }, '[BlindPeer] Failed to mirror autobase');
      throw error;
    }
  }

  pinMirrorCores(coreRefs = [], options = {}) {
    const refs = Array.isArray(coreRefs) ? coreRefs : [coreRefs];
    if (!refs.length) {
      return { status: 'skipped', reason: 'no-cores', pinned: 0 };
    }

    const identifier = typeof options.identifier === 'string' ? options.identifier.trim() : null;
    const announce = options.announce === true;
    const priority = Number.isFinite(options.priority) ? Math.trunc(options.priority) : 5;
    const type = typeof options.type === 'string' && options.type.trim()
      ? options.type.trim()
      : 'relay-mirror';
    const reason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : 'manual';

    let pinned = 0;
    let invalid = 0;
    const pinnedKeys = [];
    const pinnedEntries = [];
    const roleTally = new Map();
    for (const entry of refs) {
      const keyInput = entry && typeof entry === 'object'
        ? (entry.key || entry.core || entry)
        : entry;
      const role = entry && typeof entry === 'object' && typeof entry.role === 'string'
        ? entry.role.trim()
        : null;
      const decoded = decodeKey(keyInput);
      if (!decoded) {
        invalid += 1;
        continue;
      }
      this.#recordCoreMetadata(decoded, {
        identifier,
        priority,
        announce,
        pinned: true,
        type,
        role: role || null,
        lastActive: Date.now()
      });
      pinned += 1;
      const keyStr = toKeyString(decoded);
      pinnedKeys.push(keyStr);
      pinnedEntries.push({ key: keyStr, role: role || null });
      if (role) {
        roleTally.set(role, (roleTally.get(role) || 0) + 1);
      }
    }

    if (pinned > 0) {
      this.logger?.info?.({
        identifier,
        reason,
        requested: refs.length,
        pinned,
        invalid,
        priority,
        announce,
        roleTally: roleTally.size ? Object.fromEntries(roleTally.entries()) : null,
        pinnedEntries
      }, '[BlindPeer] Mirror cores pinned');
      this.#updateMetrics();
      this.#logPinnedCoreDiagnostics({
        entries: pinnedEntries,
        identifier,
        reason,
        type,
        priority,
        announce
      }).catch(() => {});
    } else if (invalid > 0) {
      this.logger?.warn?.( {
        identifier,
        reason,
        requested: refs.length,
        pinned,
        invalid,
        priority,
        announce
      }, '[BlindPeer] Mirror cores pin skipped (invalid keys)');
    } else {
      this.logger?.warn?.( {
        identifier,
        reason,
        requested: refs.length,
        pinned,
        invalid,
        priority,
        announce
      }, '[BlindPeer] Mirror cores pin skipped');
    }

    return {
      status: pinned > 0 ? 'ok' : 'skipped',
      identifier,
      requested: refs.length,
      pinned,
      invalid,
      keys: pinnedKeys,
      pinnedEntries
    };
  }

  async runHygiene(reason = 'manual') {
    return this.#runHygieneCycle(reason);
  }

  async deleteMirror(coreKey, { reason = 'manual' } = {}) {
    if (!this.running || !this.blindPeer) {
      throw new Error('Blind peer service inactive');
    }
    const keyInput = typeof coreKey === 'string' ? coreKey.trim() : coreKey;
    if (!keyInput) {
      throw new Error('coreKey is required');
    }
    const decoded = decodeKey(keyInput);
    if (!decoded) {
      throw new Error('invalid-core-key');
    }
    try {
      await this.blindPeer.db.deleteCore(decoded);
      this.#removeCoreMetadata(decoded);
      try {
        await this.blindPeer.flush();
      } catch (flushError) {
        this.logger?.debug?.( {
          err: flushError?.message || flushError
        }, '[BlindPeer] Flush after delete failed');
      }
      this.logger?.info?.( {
        key: toKeyString(decoded),
        reason
      }, '[BlindPeer] Mirror deleted via admin request');
      this.#updateMetrics();
      return true;
    } catch (error) {
      this.logger?.warn?.( {
        key: toKeyString(decoded) || keyInput,
        reason,
        err: error?.message || error
      }, '[BlindPeer] Failed to delete mirror via admin request');
      throw error;
    }
  }

  getPublicKeyHex() {
    return this.blindPeer ? toKeyString(this.blindPeer.publicKey) : null;
  }

  getEncryptionKeyHex() {
    return this.blindPeer ? toKeyString(this.blindPeer.encryptionPublicKey) : null;
  }

  getCorestore() {
    return this.blindPeer?.store || null;
  }

  isTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    return this.trustedPeers.has(sanitized);
  }

  getTrustedPeerInfo(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return null;
    const meta = this.trustedPeerMeta.get(sanitized);
    if (!meta) return null;
    return {
      key: sanitized,
      trustedSince: meta.trustedSince || null
    };
  }

  getTrustedPeers() {
    const peers = [];
    for (const key of this.trustedPeers) {
      const info = this.getTrustedPeerInfo(key) || { key, trustedSince: null };
      peers.push(info);
    }
    return peers;
  }

  getStatus(options = {}) {
    const ownerLimit = Number.isFinite(options.ownerLimit) && options.ownerLimit > 0
      ? Math.trunc(options.ownerLimit)
      : 10;
    const coresPerOwner = Number.isFinite(options.coresPerOwner) && options.coresPerOwner > 0
      ? Math.trunc(options.coresPerOwner)
      : 0;
    const includeCores = options.includeCores === true && coresPerOwner !== 0;
    const mirrorLimit = Number.isFinite(options.mirrorLimit) && options.mirrorLimit > 0
      ? Math.trunc(options.mirrorLimit)
      : 50;
    const includeMirrorCores = options.includeMirrorCores === true;
    return {
      enabled: !!this.config.enabled,
      running: this.running,
      trustedPeerCount: this.trustedPeers.size,
      storageDir: this.storageDir,
      digest: this.blindPeer?.digest || null,
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex(),
      trustedPeers: this.getTrustedPeers(),
      hygiene: this.#getHygieneSummary(),
      metadata: {
        trackedCores: this.coreMetadata.size
      },
      ownership: this.getOwnershipSnapshot({
        ownerLimit,
        includeCores,
        coresPerOwner: includeCores ? coresPerOwner : 0
      }),
      mirrors: this.getMirrorReadinessSnapshot({
        includeCores: includeMirrorCores,
        limit: mirrorLimit
      }),
      dispatcherAssignments: this.getDispatcherAssignmentsSnapshot(),
      config: {
        maxBytes: this.config.maxBytes,
        gcIntervalMs: this.config.gcIntervalMs,
        dedupeBatchSize: this.config.dedupeBatchSize,
        staleCoreTtlMs: this.config.staleCoreTtlMs
      }
    };
  }

  getAnnouncementInfo() {
    if (!this.config.enabled || !this.blindPeer) {
      return {
        enabled: false
      };
    }

    return {
      enabled: true,
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex(),
      maxBytes: this.config.maxBytes,
      trustedPeerCount: this.trustedPeers.size
    };
  }

  #ensureBlindPeeringKeyPath() {
    if (this.blindPeeringKeyPath) return this.blindPeeringKeyPath;
    if (!this.storageDir) return null;
    this.blindPeeringKeyPath = resolve(this.storageDir, 'blind-peering-client-keypair.json');
    return this.blindPeeringKeyPath;
  }

  async #loadBlindPeeringKeyPair() {
    const keyPath = this.#ensureBlindPeeringKeyPath();
    if (!keyPath) return null;
    try {
      const raw = await readFile(keyPath, 'utf8');
      const parsed = JSON.parse(raw);
      const publicKey = parsed?.publicKey ? Buffer.from(parsed.publicKey, 'hex') : null;
      const secretKey = parsed?.secretKey ? Buffer.from(parsed.secretKey, 'hex') : null;
      if (publicKey && secretKey) {
        const candidate = { publicKey, secretKey };
        if (hypercoreCrypto?.validateKeyPair?.(candidate)) {
          this.logger?.info?.( {
            path: keyPath,
            publicKey: toKeyString(publicKey)
          }, '[BlindPeer] Loaded blind-peering client keypair');
          return candidate;
        }
      }
      this.logger?.warn?.( {
        path: keyPath
      }, '[BlindPeer] Invalid blind-peering keypair on disk, regenerating');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.( {
          path: keyPath,
          err: error?.message || error
        }, '[BlindPeer] Failed to read blind-peering keypair');
      }
    }

    try {
      const candidate = hypercoreCrypto?.keyPair ? hypercoreCrypto.keyPair() : null;
      if (candidate?.publicKey && candidate?.secretKey) {
        await mkdir(dirname(keyPath), { recursive: true });
        await writeFile(keyPath, JSON.stringify({
          publicKey: Buffer.from(candidate.publicKey).toString('hex'),
          secretKey: Buffer.from(candidate.secretKey).toString('hex')
        }), 'utf8');
        this.logger?.info?.( {
          path: keyPath,
          publicKey: toKeyString(candidate.publicKey)
        }, '[BlindPeer] Generated blind-peering client keypair');
        return candidate;
      }
    } catch (error) {
      this.logger?.warn?.( {
        path: keyPath,
        err: error?.message || error
      }, '[BlindPeer] Failed to generate blind-peering keypair');
    }

    return null;
  }

  #ensureMetadataPersistPath() {
    if (this.metadataPersistPath) return this.metadataPersistPath;
    if (!this.storageDir) return null;
    this.metadataPersistPath = resolve(this.storageDir, 'blind-peer-metadata.json');
    return this.metadataPersistPath;
  }

  async #loadCoreMetadataFromDisk() {
    const path = this.#ensureMetadataPersistPath();
    if (!path) return;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return;
      this.coreMetadata.clear();
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object' || !entry.key) continue;
        const owners = new Map();
        if (Array.isArray(entry.owners)) {
          for (const owner of entry.owners) {
            if (!owner) continue;
            const ownerId = owner.ownerId || owner.ownerPeerKey || owner.alias || `owner:${owners.size}`;
            owners.set(ownerId, {
              ownerPeerKey: sanitizePeerKey(owner.ownerPeerKey) || null,
              type: owner.type || null,
              identifier: typeof owner.identifier === 'string' ? owner.identifier : null,
              priority: this.#normalizeMetadataPriority(owner.priority),
              lastSeen: Number.isFinite(owner.lastSeen) ? Math.trunc(owner.lastSeen) : null
            });
          }
        }
        const identifiers = new Set();
        if (Array.isArray(entry.identifiers)) {
          for (const id of entry.identifiers) {
            if (typeof id === 'string' && id.trim()) {
              identifiers.add(id.trim());
            }
          }
        }
        const record = {
          key: entry.key,
          owners,
          identifiers,
          primaryIdentifier: typeof entry.primaryIdentifier === 'string' ? entry.primaryIdentifier : null,
          type: typeof entry.type === 'string' ? entry.type : null,
          roles: new Set(Array.isArray(entry.roles) ? entry.roles.filter((role) => typeof role === 'string' && role.trim()).map((role) => role.trim()) : []),
          firstSeen: Number.isFinite(entry.firstSeen) ? Math.trunc(entry.firstSeen) : Date.now(),
          lastUpdated: Number.isFinite(entry.lastUpdated) ? Math.trunc(entry.lastUpdated) : Date.now(),
          priority: this.#normalizeMetadataPriority(entry.priority),
          announce: entry.announce === true,
          pinned: entry.pinned === true,
          lastActive: Number.isFinite(entry.lastActive) ? Math.trunc(entry.lastActive) : Date.now()
        };
        if (record.primaryIdentifier) {
          record.identifiers.add(record.primaryIdentifier);
        }
        this.coreMetadata.set(record.key, record);
      }
      this.metadataDirty = false;
      this.logger?.debug?.( {
        entries: this.coreMetadata.size,
        path
      }, '[BlindPeer] Loaded metadata snapshot');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.( {
          path,
          err: error?.message || error
        }, '[BlindPeer] Failed to load metadata snapshot');
      }
    }
  }

  async #persistCoreMetadata(force = false) {
    const path = this.#ensureMetadataPersistPath();
    if (!path) return;
    if (!force && !this.metadataDirty) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      const entries = [];
      for (const entry of this.coreMetadata.values()) {
        entries.push({
          key: entry.key,
          primaryIdentifier: entry.primaryIdentifier || null,
          type: entry.type || null,
          roles: Array.from(entry.roles || []),
          announce: entry.announce === true,
          pinned: entry.pinned === true,
          priority: this.#normalizeMetadataPriority(entry.priority),
          firstSeen: entry.firstSeen || null,
          lastUpdated: entry.lastUpdated || null,
          lastActive: entry.lastActive || null,
          identifiers: Array.from(entry.identifiers || []),
          owners: Array.from(entry.owners.entries()).map(([ownerId, ownerInfo]) => ({
            ownerId,
            ownerPeerKey: ownerInfo.ownerPeerKey || null,
            type: ownerInfo.type || null,
            identifier: ownerInfo.identifier || null,
            priority: this.#normalizeMetadataPriority(ownerInfo.priority),
            lastSeen: ownerInfo.lastSeen || null
          }))
        });
      }
      const payload = JSON.stringify({ entries }, null, 2);
      await writeFile(path, payload, 'utf8');
      this.metadataDirty = false;
    } catch (error) {
      this.logger?.warn?.( {
        path,
        err: error?.message || error
      }, '[BlindPeer] Failed to persist metadata snapshot');
    }
  }

  #scheduleCoreMetadataPersist() {
    if (this.metadataSaveTimer) return;
    this.metadataSaveTimer = setTimeout(() => {
      this.metadataSaveTimer = null;
      this.#persistCoreMetadata().catch((error) => {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Metadata snapshot task failed');
      });
    }, 5000);
    this.metadataSaveTimer.unref?.();
  }

  #markCoreMetadataDirty() {
    this.metadataDirty = true;
    this.#scheduleCoreMetadataPersist();
  }

  #scheduleDispatcherAssignmentCleanup(jobId, delayMs = 120000) {
    if (!jobId) return;
    if (this.dispatcherAssignmentTimers.has(jobId)) {
      clearTimeout(this.dispatcherAssignmentTimers.get(jobId));
      this.dispatcherAssignmentTimers.delete(jobId);
    }
    const timer = setTimeout(() => {
      this.dispatcherAssignmentTimers.delete(jobId);
      this.dispatcherAssignments.delete(jobId);
    }, delayMs);
    timer.unref?.();
    this.dispatcherAssignmentTimers.set(jobId, timer);
  }

  #startHygieneLoop() {
    const intervalMs = Number(this.config.gcIntervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    if (this.hygieneInterval) {
      clearInterval(this.hygieneInterval);
      this.hygieneInterval = null;
    }

    const runner = () => {
      if (!this.running) return;
      this.#runHygieneCycle('timer').catch((error) => {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Hygiene cycle threw');
      });
    };

    this.hygieneInterval = setInterval(runner, intervalMs);
    this.hygieneInterval.unref?.();

    const initialDelay = Math.min(10_000, Math.max(1_000, Math.round(intervalMs / 2)));
    setTimeout(() => {
      if (!this.running) return;
      this.#runHygieneCycle('startup').catch((error) => {
        this.logger?.warn?.( {
          err: error?.message || error
        }, '[BlindPeer] Initial hygiene run failed');
      });
    }, initialDelay).unref?.();
  }

  async #runHygieneCycle(reason = 'timer') {
    if (!this.running || !this.blindPeer) {
      return { status: 'inactive' };
    }
    if (this.hygieneRunning) {
      this.logger?.debug?.( { reason }, '[BlindPeer] Hygiene run skipped (already running)');
      return { status: 'skipped', reason: 'running' };
    }

    const startedAt = Date.now();
    const staleThreshold = this.config.staleCoreTtlMs > 0
      ? startedAt - this.config.staleCoreTtlMs
      : null;
    const dedupeLimit = Number.isFinite(this.config.dedupeBatchSize)
      ? Math.max(0, this.config.dedupeBatchSize)
      : 100;

    this.hygieneRunning = true;
    let scanned = 0;
    let dedupeDecisions = 0;
    let staleCandidates = 0;
    const evictionPlans = new Map();
    const dedupeByIdentifier = new Map();

    try {
      for await (const record of this.blindPeer.db.createGcCandidateReadStream()) {
        scanned += 1;
        const candidate = this.#buildCandidate(record);
        if (!candidate) continue;

        if (candidate.identifier && dedupeDecisions < dedupeLimit) {
          const existing = dedupeByIdentifier.get(candidate.identifier);
          if (!existing) {
            dedupeByIdentifier.set(candidate.identifier, candidate);
          } else {
            if (existing.pinned && candidate.pinned) {
              continue;
            }
            const choice = this.#choosePreferredReplica(existing, candidate);
            if (choice === 'replace') {
              evictionPlans.set(existing.keyStr, {
                reason: 'duplicate',
                bytesAllocated: existing.bytesAllocated
              });
              dedupeByIdentifier.set(candidate.identifier, candidate);
              dedupeDecisions += 1;
            } else if (choice === 'keep') {
              evictionPlans.set(candidate.keyStr, {
                reason: 'duplicate',
                bytesAllocated: candidate.bytesAllocated
              });
              dedupeDecisions += 1;
            }
          }
        }

        if (this.#isRecordStale(candidate, staleThreshold) && !evictionPlans.has(candidate.keyStr)) {
          evictionPlans.set(candidate.keyStr, {
            reason: 'stale',
            bytesAllocated: candidate.bytesAllocated
          });
          staleCandidates += 1;
        }
      }
    } catch (error) {
      this.logger?.warn?.( {
        reason,
        err: error?.message || error
      }, '[BlindPeer] Hygiene scan failed');
      this.hygieneStats.totalRuns += 1;
      this.hygieneStats.lastRunAt = startedAt;
      this.hygieneStats.lastDurationMs = Date.now() - startedAt;
      this.hygieneStats.lastError = {
        message: error?.message || String(error),
        stack: error?.stack || null
      };
      this.hygieneRunning = false;
      this.metrics.incrementGcRuns?.();
      return { status: 'error', error };
    }

    let totalEvictions = 0;
    let bytesFreed = 0;
    const reasonTally = new Map();

    for (const [keyStr, plan] of evictionPlans) {
      const keyBuf = decodeKey(keyStr);
      if (!keyBuf) continue;
      try {
        await this.blindPeer.db.deleteCore(keyBuf);
        totalEvictions += 1;
        bytesFreed += Number(plan.bytesAllocated) || 0;
        const label = plan.reason || 'unknown';
        reasonTally.set(label, (reasonTally.get(label) || 0) + 1);
        this.#removeCoreMetadata(keyBuf);
        this.logger?.info?.( {
          key: keyStr,
          reason: label,
          bytesFreed: plan.bytesAllocated ?? null
        }, '[BlindPeer] Hygiene eviction applied');
      } catch (error) {
        this.logger?.warn?.( {
          key: keyStr,
          reason: plan.reason,
          err: error?.message || error
        }, '[BlindPeer] Hygiene eviction failed');
      }
    }

    try {
      await this.blindPeer.flush();
    } catch (error) {
      this.logger?.warn?.( {
        reason,
        err: error?.message || error
      }, '[BlindPeer] Hygiene flush failed');
    }

    this.hygieneStats.totalRuns += 1;
    this.hygieneStats.lastRunAt = startedAt;
    this.hygieneStats.lastDurationMs = Date.now() - startedAt;
    this.hygieneStats.lastError = null;
    this.hygieneStats.lastBytesFreed = bytesFreed;
    this.hygieneStats.lastEvictions = totalEvictions;
    this.hygieneStats.lastResult = {
      reason,
      scanned,
      totalEvictions,
      bytesFreed,
      duplicatesProcessed: dedupeDecisions,
      staleCandidates,
      evictionReasons: Object.fromEntries(reasonTally)
    };

    this.metrics.incrementGcRuns?.();
    for (const [evictionReason, count] of reasonTally.entries()) {
      this.metrics.recordEvictions?.({ reason: evictionReason, count });
    }
    this.#updateMetrics();

    this.logger?.info?.( {
      reason,
      scanned,
      totalEvictions,
      bytesFreed,
      duplicatesProcessed: dedupeDecisions,
      staleCandidates,
      ownersTracked: this.coreMetadata.size,
      evictionReasons: Object.fromEntries(reasonTally)
    }, '[BlindPeer] Hygiene cycle completed');

    this.hygieneRunning = false;
    return { status: 'ok', ...this.hygieneStats.lastResult };
  }

  #buildCandidate(record) {
    if (!record) return null;
    const keyStr = toKeyString(record.key);
    if (!keyStr) return null;
    let metadata = this.coreMetadata.get(keyStr);
    if (!metadata) {
      metadata = this.#touchCoreMetadata(record.key, { priority: record?.priority ?? 0 });
    }

    const priority = this.#normalizeMetadataPriority(
      metadata?.priority,
      record?.priority
    );
    const identifier = this.#selectMetadataIdentifier(metadata);
    const announced = (metadata?.announce === true) || (record?.announce === true);
    const pinned = metadata?.pinned === true;
    return {
      keyStr,
      metadata,
      identifier,
      priority,
      announced,
      pinned,
      lastActive: this.#extractLastActive(record, metadata),
      bytesAllocated: Number(record?.bytesAllocated) || 0
    };
  }

  #selectMetadataIdentifier(metadata) {
    if (!metadata) return null;
    if (metadata.primaryIdentifier && typeof metadata.primaryIdentifier === 'string') {
      const trimmed = metadata.primaryIdentifier.trim();
      if (trimmed) return trimmed;
    }
    if (metadata.identifiers instanceof Set) {
      for (const id of metadata.identifiers) {
        if (typeof id === 'string' && id.trim().length) {
          return id.trim();
        }
      }
    }
    return null;
  }

  #extractLastActive(record, metadata = null) {
    if (metadata?.lastActive) {
      return metadata.lastActive;
    }
    if (!record) return null;
    const active = Number(record.active);
    if (Number.isFinite(active) && active > 0) return active;
    const updated = Number(record.updated);
    if (Number.isFinite(updated) && updated > 0) return updated;
    return null;
  }

  #isRecordStale(candidate, staleThreshold) {
    if (!candidate || !staleThreshold || staleThreshold <= 0) return false;
    if (candidate.announced) return false;
    if (candidate.pinned) return false;
    const priority = Number(candidate.priority ?? 0);
    if (priority > 0) return false;
    if (!candidate.lastActive) return false;
    return candidate.lastActive < staleThreshold;
  }

  #choosePreferredReplica(existing, challenger) {
    if (!existing) return 'replace';
    if (!challenger) return 'keep';

    if (challenger.pinned && !existing.pinned) return 'replace';
    if (!challenger.pinned && existing.pinned) return 'keep';

    if (challenger.announced && !existing.announced) return 'replace';
    if (!challenger.announced && existing.announced) return 'keep';

    const existingPriority = Number(existing.priority ?? 0);
    const challengerPriority = Number(challenger.priority ?? 0);
    if (challengerPriority > existingPriority) return 'replace';
    if (challengerPriority < existingPriority) return 'keep';

    const existingActive = Number(existing.lastActive ?? 0);
    const challengerActive = Number(challenger.lastActive ?? 0);
    if (challengerActive > existingActive) return 'replace';
    if (challengerActive < existingActive) return 'keep';

    const challengerBytes = Number(challenger.bytesAllocated ?? 0);
    const existingBytes = Number(existing.bytesAllocated ?? 0);
    if (challengerBytes < existingBytes) return 'replace';
    return 'keep';
  }

  #normalizeMetadataPriority(...values) {
    let result = null;
    for (const value of values) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      result = result === null ? num : Math.max(result, num);
    }
    return result;
  }

  #recordCoreMetadata(coreKey, metadata = {}) {
    const entry = this.#touchCoreMetadata(coreKey, metadata);
    if (!entry) return null;

    const ownerKey = sanitizePeerKey(metadata.ownerPeerKey);
    const identifierKey = typeof metadata.identifier === 'string' ? metadata.identifier.trim() || null : null;
    const ownerId = ownerKey || (identifierKey ? `identifier:${identifierKey}` : 'anonymous');
    const ownerInfo = {
      ownerPeerKey: ownerKey,
      type: metadata.type || null,
      identifier: identifierKey,
      priority: this.#normalizeMetadataPriority(metadata.priority),
      lastSeen: metadata.lastSeenAt && Number.isFinite(metadata.lastSeenAt)
        ? Math.trunc(metadata.lastSeenAt)
        : Date.now(),
      announce: metadata.announce === true
    };
    entry.owners.set(ownerId, ownerInfo);

    if (ownerInfo.identifier) {
      entry.identifiers.add(ownerInfo.identifier);
      if (!entry.primaryIdentifier) {
        entry.primaryIdentifier = ownerInfo.identifier;
      }
    }

    if (metadata.announce === true) {
      entry.announce = true;
    }

    if (Number.isFinite(metadata.priority)) {
      entry.priority = this.#normalizeMetadataPriority(entry.priority, metadata.priority);
    }

    if (metadata.pinned === true) {
      entry.pinned = true;
    }

    entry.lastUpdated = Date.now();
    entry.lastActive = Date.now();

    this.coreMetadata.set(entry.key, entry);
    this.#markCoreMetadataDirty();
    return entry;
  }

  #touchCoreMetadata(coreKey, metadata = {}) {
    const keyBuf = coreKey?.key ? coreKey.key : coreKey;
    const keyStr = toKeyString(decodeKey(keyBuf) || keyBuf);
    if (!keyStr) return null;

    const existing = this.coreMetadata.get(keyStr);
    const roleValue = typeof metadata.role === 'string' ? metadata.role.trim() : null;
    const rolesValue = Array.isArray(metadata.roles) ? metadata.roles : null;
    const now = Date.now();
    if (existing) {
      existing.lastUpdated = now;
      if (Number.isFinite(metadata.priority)) {
        existing.priority = this.#normalizeMetadataPriority(existing.priority, metadata.priority);
      }
      if (metadata.announce === true) {
        existing.announce = true;
      }
      if (metadata.pinned === true) {
        existing.pinned = true;
      }
      if (typeof metadata.type === 'string' && metadata.type.trim()) {
        existing.type = metadata.type.trim();
      }
      if (roleValue) {
        if (!existing.roles) existing.roles = new Set();
        existing.roles.add(roleValue);
      }
      if (rolesValue) {
        if (!existing.roles) existing.roles = new Set();
        rolesValue.forEach((role) => {
          if (typeof role === 'string' && role.trim()) {
            existing.roles.add(role.trim());
          }
        });
      }
      if (Number.isFinite(metadata.lastActive)) {
        const activeVal = Math.trunc(metadata.lastActive);
        if (!existing.lastActive || activeVal > existing.lastActive) {
          existing.lastActive = activeVal;
        }
      } else if (!existing.lastActive) {
        existing.lastActive = now;
      }
      this.#markCoreMetadataDirty();
      return existing;
    }

    const entry = {
      key: keyStr,
      owners: new Map(),
      identifiers: new Set(),
      primaryIdentifier: typeof metadata.identifier === 'string' ? metadata.identifier.trim() || null : null,
      type: typeof metadata.type === 'string' ? metadata.type.trim() : null,
      roles: new Set(),
      firstSeen: now,
      lastUpdated: now,
      priority: this.#normalizeMetadataPriority(metadata.priority),
      announce: metadata.announce === true,
      pinned: metadata.pinned === true,
      lastActive: Number.isFinite(metadata.lastActive) ? Math.trunc(metadata.lastActive) : now
    };
    if (roleValue) entry.roles.add(roleValue);
    if (rolesValue) {
      rolesValue.forEach((role) => {
        if (typeof role === 'string' && role.trim()) {
          entry.roles.add(role.trim());
        }
      });
    }
    if (entry.primaryIdentifier) {
      entry.identifiers.add(entry.primaryIdentifier);
    }
    this.coreMetadata.set(keyStr, entry);
    this.#markCoreMetadataDirty();
    return entry;
  }

  #removeCoreMetadata(coreKey) {
    const keyBuf = coreKey?.key ? coreKey.key : coreKey;
    const keyStr = toKeyString(decodeKey(keyBuf) || keyBuf);
    if (!keyStr) return false;
    const removed = this.coreMetadata.delete(keyStr);
    if (removed) {
      this.#markCoreMetadataDirty();
    }
    return removed;
  }

  #onBlindPeerAddCore(record, stream, context = {}) {
    if (!record?.key) {
      this.logger?.warn?.( {
        hasRecord: !!record,
        sourceEvent: context?.event || null,
        isTrusted: context?.isTrusted ?? null
      }, '[BlindPeer] add-core missing key');
      return;
    }
    const ownerPeerKey = stream?.remotePublicKey ? toKeyString(stream.remotePublicKey) : null;
    const identifier = record?.referrer ? toKeyString(record.referrer) : null;

    const metadataEntry = this.#recordCoreMetadata(record.key, {
      ownerPeerKey,
      priority: record?.priority,
      identifier,
      announce: record?.announce === true,
      type: context?.isNew ? 'new-core' : null,
      lastSeenAt: Date.now()
    });

    if (this.logger?.debug) {
      this.logger.debug({
        key: toKeyString(record.key),
        ownerPeerKey,
        identifier,
        priority: record?.priority ?? null,
        announce: record?.announce === true,
        sourceEvent: context?.event || null,
        isTrusted: context?.isTrusted ?? null
      }, '[BlindPeer] Mirror recorded');
    }

    const roleList = metadataEntry?.roles instanceof Set
      ? Array.from(metadataEntry.roles)
      : Array.isArray(metadataEntry?.roles)
        ? metadataEntry.roles
        : [];
    if (record?.announce === true && this.logger?.info) {
      this.logger.info({
        key: toKeyString(record.key)?.slice(0, 16) || null,
        ownerPeerKey: ownerPeerKey ? ownerPeerKey.slice(0, 16) : null,
        identifier: identifier ? identifier.slice(0, 16) : null,
        priority: record?.priority ?? null,
        announce: true,
        roleCount: roleList.length || null,
        roles: roleList.length ? roleList.slice(0, 10) : null,
        sourceEvent: context?.event || null,
        isTrusted: context?.isTrusted ?? null
      }, `${CJTRACE_TAG} blind peer mirror add`);
    } else if (this.logger?.info && (context?.isTrusted === false || record?.announce !== true)) {
      this.logger.info({
        key: toKeyString(record.key)?.slice(0, 16) || null,
        ownerPeerKey: ownerPeerKey ? ownerPeerKey.slice(0, 16) : null,
        identifier: identifier ? identifier.slice(0, 16) : null,
        priority: record?.priority ?? null,
        announce: record?.announce === true,
        roleCount: roleList.length || null,
        roles: roleList.length ? roleList.slice(0, 10) : null,
        sourceEvent: context?.event || null,
        isTrusted: context?.isTrusted ?? null
      }, `${CJTRACE_TAG} blind peer add-core`);
    }

    this.emit('mirror-added', {
      coreKey: toKeyString(record.key),
      ownerPeerKey,
      identifier,
      type: metadataEntry?.type || context?.type || null,
      priority: record?.priority ?? metadataEntry?.priority ?? null,
      announce: record?.announce === true || metadataEntry?.announce === true,
      lastSeenAt: Date.now(),
      healthy: true,
      metadataSummary: this.#summarizeMetadata(metadataEntry)
    });
  }

  #onBlindPeerDeleteCore(info = {}, { stream } = {}) {
    if (!info?.key) return;
    const keyStr = toKeyString(info.key);
    const metadataEntry = this.coreMetadata.get(keyStr) || null;
    this.#removeCoreMetadata(info.key);
    if (this.logger?.debug) {
      this.logger.debug({
        key: keyStr,
        ownerPeerKey: stream?.remotePublicKey ? toKeyString(stream.remotePublicKey) : null,
        existing: info?.existing ?? null
      }, '[BlindPeer] Mirror removed');
    }

    this.emit('mirror-removed', {
      coreKey: keyStr,
      ownerPeerKey: stream?.remotePublicKey ? toKeyString(stream.remotePublicKey) : null,
      identifier: metadataEntry?.primaryIdentifier || null,
      metadataSummary: this.#summarizeMetadata(metadataEntry)
    });
  }

  #collectOwnershipMap() {
    const owners = new Map();
    for (const entry of this.coreMetadata.values()) {
      const entryPriority = this.#normalizeMetadataPriority(entry.priority);
      const entryAnnounced = entry.announce === true;
      const entryLastActive = entry.lastActive || entry.lastUpdated || entry.firstSeen || Date.now();

      for (const [ownerId, ownerInfo] of entry.owners.entries()) {
        const key = ownerInfo.ownerPeerKey || ownerId;
        let owner = owners.get(key);
        if (!owner) {
          owner = {
            ownerId: key,
            peerKey: ownerInfo.ownerPeerKey || null,
            alias: ownerInfo.ownerPeerKey ? null : ownerId,
            totalCores: 0,
            announcedCount: 0,
            lastSeen: 0,
            priorityMax: null,
            priorityMin: null,
            cores: []
          };
          owners.set(key, owner);
        }

        const effectivePriority = this.#normalizeMetadataPriority(ownerInfo.priority, entryPriority);
        if (effectivePriority !== null) {
          owner.priorityMax = owner.priorityMax === null
            ? effectivePriority
            : Math.max(owner.priorityMax, effectivePriority);
          owner.priorityMin = owner.priorityMin === null
            ? effectivePriority
            : Math.min(owner.priorityMin, effectivePriority);
        }

        owner.totalCores += 1;
        if (entryAnnounced) owner.announcedCount += 1;

        const lastSeenCandidate = ownerInfo.lastSeen || entryLastActive;
        owner.lastSeen = Math.max(owner.lastSeen || 0, lastSeenCandidate || 0);

        owner.cores.push({
          key: entry.key,
          identifier: entry.primaryIdentifier || null,
          priority: effectivePriority,
          announced: entryAnnounced,
          lastActive: entryLastActive,
          lastUpdated: entry.lastUpdated || entryLastActive,
          firstSeen: entry.firstSeen || null,
          type: ownerInfo.type || null
        });
      }
    }
    return owners;
  }

  getOwnershipSnapshot({ includeCores = false, ownerLimit = 10, coresPerOwner = 0 } = {}) {
    const ownersMap = this.#collectOwnershipMap();
    const ownersArray = Array.from(ownersMap.values()).map((owner) => {
      const base = {
        peerKey: owner.peerKey,
        alias: owner.alias,
        totalCores: owner.totalCores,
        announcedCount: owner.announcedCount,
        lastSeen: owner.lastSeen || null,
        priorityMax: owner.priorityMax,
        priorityMin: owner.priorityMin,
        ownerId: owner.ownerId
      };

      if (!Number.isFinite(base.priorityMax)) base.priorityMax = null;
      if (!Number.isFinite(base.priorityMin)) base.priorityMin = null;

      if (includeCores) {
        const limit = Number.isFinite(coresPerOwner) && coresPerOwner > 0
          ? Math.trunc(coresPerOwner)
          : owner.cores.length;
        const sortedCores = owner.cores
          .slice()
          .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        base.cores = sortedCores.slice(0, limit).map((core) => ({
          key: core.key,
          identifier: core.identifier,
          priority: core.priority,
          announced: core.announced,
          lastActive: core.lastActive || null,
          lastUpdated: core.lastUpdated || null,
          firstSeen: core.firstSeen || null,
          type: core.type
        }));
      }

      return base;
    });

    ownersArray.sort((a, b) => {
      if (b.totalCores !== a.totalCores) return b.totalCores - a.totalCores;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });

    const limitedOwners = Number.isFinite(ownerLimit) && ownerLimit > 0
      ? ownersArray.slice(0, Math.trunc(ownerLimit))
      : ownersArray;

    const sanitizedOwners = limitedOwners.map((owner) => {
      const result = {
        peerKey: owner.peerKey,
        alias: owner.alias,
        totalCores: owner.totalCores,
        announcedCount: owner.announcedCount,
        lastSeen: owner.lastSeen,
        priorityMax: owner.priorityMax,
        priorityMin: owner.priorityMin
      };
      if (includeCores) {
        result.cores = owner.cores;
      }
      return result;
    });

    return {
      ownerCount: ownersArray.length,
      owners: sanitizedOwners
    };
  }

  getPeerMirrorSummary(peerKey, { includeCores = true, coresPerOwner = 25 } = {}) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return null;
    const ownersMap = this.#collectOwnershipMap();
    const owner = ownersMap.get(sanitized);
    if (!owner) return null;

    const result = {
      peerKey: owner.peerKey || sanitized,
      alias: owner.alias,
      totalCores: owner.totalCores,
      announcedCount: owner.announcedCount,
      lastSeen: owner.lastSeen || null,
      priorityMax: owner.priorityMax,
      priorityMin: owner.priorityMin
    };

    if (!Number.isFinite(result.priorityMax)) result.priorityMax = null;
    if (!Number.isFinite(result.priorityMin)) result.priorityMin = null;

    if (includeCores) {
      const limit = Number.isFinite(coresPerOwner) && coresPerOwner > 0
        ? Math.trunc(coresPerOwner)
        : owner.cores.length;
      const sorted = owner.cores
        .slice()
        .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      result.cores = sorted.slice(0, limit).map((core) => ({
        key: core.key,
        identifier: core.identifier,
        priority: core.priority,
        announced: core.announced,
        lastActive: core.lastActive || null,
        lastUpdated: core.lastUpdated || null,
        firstSeen: core.firstSeen || null,
        type: core.type
      }));
    }

    return result;
  }

  getMirrorReadinessSnapshot({ includeCores = false, limit = 50, staleThresholdMs } = {}) {
    const now = Date.now();
    const thresholdValue = Number.isFinite(staleThresholdMs) && staleThresholdMs > 0
      ? Math.trunc(staleThresholdMs)
      : this.mirrorStaleThresholdMs;
    const readiness = new Map();

    for (const entry of this.coreMetadata.values()) {
      const identifier = this.#selectMetadataIdentifier(entry) || entry.key;
      const entryLastActive = entry.lastActive || entry.lastUpdated || entry.firstSeen || now;
      for (const [ownerId, ownerInfo] of entry.owners.entries()) {
        const ownerKey = ownerInfo.ownerPeerKey || ownerId;
        const mapKey = `${identifier}:${ownerKey}`;
        let record = readiness.get(mapKey);
        if (!record) {
          record = {
            identifier,
            ownerPeerKey: ownerInfo.ownerPeerKey || null,
            ownerAlias: ownerInfo.ownerPeerKey ? null : ownerId,
            type: ownerInfo.type || entry.type || null,
            totalCores: 0,
            announcedCount: 0,
            priorityMax: null,
            priorityMin: null,
            lastActive: 0,
            lastUpdated: 0,
            cores: [],
          };
          readiness.set(mapKey, record);
        }

        const effectivePriority = this.#normalizeMetadataPriority(
          ownerInfo.priority ?? entry.priority
        );
        record.coreKeys = record.coreKeys || new Set();
        record.announcedKeys = record.announcedKeys || new Set();
        if (entry.key) {
          record.coreKeys.add(entry.key);
          if (entry.announce === true || ownerInfo.announce === true) {
            record.announcedKeys.add(entry.key);
          }
        }
        record.totalCores = record.coreKeys.size;
        record.announcedCount = record.announcedKeys.size;
        record.lastActive = Math.max(record.lastActive || 0, entryLastActive || 0);
        record.lastUpdated = Math.max(record.lastUpdated || 0, entry.lastUpdated || 0);
        if (Number.isFinite(effectivePriority)) {
          record.priorityMax = record.priorityMax === null
            ? effectivePriority
            : Math.max(record.priorityMax, effectivePriority);
          record.priorityMin = record.priorityMin === null
            ? effectivePriority
            : Math.min(record.priorityMin, effectivePriority);
        }
        if (includeCores) {
          record.cores.push({
            key: entry.key,
            priority: effectivePriority,
            announced: entry.announce === true,
            lastActive: entry.lastActive || null,
            lastUpdated: entry.lastUpdated || null,
            firstSeen: entry.firstSeen || null
          });
        }
      }
    }

    const snapshot = [];
    for (const record of readiness.values()) {
      const referenceTs = record.lastActive || record.lastUpdated || null;
      const lagMs = referenceTs ? Math.max(0, now - referenceTs) : null;
      const healthy = lagMs === null ? false : lagMs <= thresholdValue;
      const firstCoreKey = record.coreKeys instanceof Set
        ? (record.coreKeys.values().next().value || null)
        : null;
      const payload = {
        identifier: record.identifier,
        ownerPeerKey: record.ownerPeerKey,
        ownerAlias: record.ownerAlias,
        type: record.type,
        totalCores: record.coreKeys instanceof Set ? record.coreKeys.size : record.totalCores,
        announcedCount: record.announcedCount,
        priorityMax: record.priorityMax,
        priorityMin: record.priorityMin,
        lastActive: referenceTs,
        lastUpdated: record.lastUpdated || null,
        lagMs,
        healthy
      };
      if (firstCoreKey) {
        payload.coreKey = firstCoreKey;
      }
      if (includeCores) {
        payload.cores = record.cores
          .slice()
          .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      }
      snapshot.push(payload);
    }

    snapshot.sort((a, b) => {
      if (b.totalCores !== a.totalCores) return b.totalCores - a.totalCores;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });

    if (Number.isFinite(limit) && limit > 0 && snapshot.length > limit) {
      return snapshot.slice(0, Math.trunc(limit));
    }
    return snapshot;
  }

  #getHygieneSummary() {
    return {
      intervalMs: this.config.gcIntervalMs,
      running: this.hygieneRunning,
      totalRuns: this.hygieneStats.totalRuns,
      lastRunAt: this.hygieneStats.lastRunAt,
      lastDurationMs: this.hygieneStats.lastDurationMs,
      lastEvictions: this.hygieneStats.lastEvictions,
      lastBytesFreed: this.hygieneStats.lastBytesFreed,
      lastResult: this.hygieneStats.lastResult,
      lastError: this.hygieneStats.lastError
    };
  }

  #summarizeMetadata(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const roles = entry.roles instanceof Set
      ? Array.from(entry.roles)
      : Array.isArray(entry.roles)
        ? entry.roles
        : [];
    return {
      primaryIdentifier: entry.primaryIdentifier || null,
      announce: entry.announce === true,
      priority: this.#normalizeMetadataPriority(entry.priority),
      pinned: entry.pinned === true,
      lastActive: entry.lastActive || null,
      type: entry.type || null,
      ownerCount: entry.owners instanceof Map ? entry.owners.size : null,
      roleCount: roles.length || null,
      roles: roles.length ? roles.slice(0, 10) : null
    };
  }

  #describeCorePeerState(core) {
    const peers = Array.isArray(core?.peers)
      ? core.peers
      : (core?.peers && typeof core.peers[Symbol.iterator] === 'function'
        ? Array.from(core.peers)
        : (core?.replicator?.peers && typeof core.replicator.peers[Symbol.iterator] === 'function'
          ? Array.from(core.replicator.peers)
          : []));
    const peerKeysPreview = [];
    let remoteLength = Number.isFinite(core?.remoteLength) ? core.remoteLength : null;
    let remoteContiguousLength = Number.isFinite(core?.remoteContiguousLength) ? core.remoteContiguousLength : null;
    let lastSeenAt = null;
    for (const peer of peers) {
      if (peerKeysPreview.length < 3) {
        const keyBuf = peer?.remotePublicKey
          || peer?.publicKey
          || peer?.remoteKey
          || peer?.stream?.remotePublicKey
          || peer?.stream?.publicKey
          || peer?.stream?.remoteKey
          || null;
        const keyStr = keyBuf ? toKeyString(keyBuf) : null;
        if (keyStr && !peerKeysPreview.includes(keyStr)) {
          peerKeysPreview.push(keyStr);
        }
      }
      const peerRemoteLength = Number.isFinite(peer?.remoteLength)
        ? peer.remoteLength
        : (Number.isFinite(peer?.remote?.length) ? peer.remote.length : null);
      if (Number.isFinite(peerRemoteLength)) {
        remoteLength = remoteLength === null ? peerRemoteLength : Math.max(remoteLength, peerRemoteLength);
      }
      const peerRemoteContiguous = Number.isFinite(peer?.remoteContiguousLength)
        ? peer.remoteContiguousLength
        : (Number.isFinite(peer?.remote?.contiguousLength) ? peer.remote.contiguousLength : null);
      if (Number.isFinite(peerRemoteContiguous)) {
        remoteContiguousLength = remoteContiguousLength === null
          ? peerRemoteContiguous
          : Math.max(remoteContiguousLength, peerRemoteContiguous);
      }
      const lastSeenCandidates = [
        peer?.lastReceived,
        peer?.lastSent,
        peer?.lastSeen,
        peer?.stats?.lastReceived,
        peer?.stats?.lastSent,
        peer?.stats?.lastSeen,
        peer?.stream?.lastReceived,
        peer?.stream?.lastSent
      ].filter((value) => Number.isFinite(value));
      if (lastSeenCandidates.length) {
        const candidate = Math.max(...lastSeenCandidates);
        lastSeenAt = lastSeenAt === null ? candidate : Math.max(lastSeenAt, candidate);
      }
    }
    return {
      peerCount: peers.length,
      peerKeysPreview,
      remoteLength,
      remoteContiguousLength,
      lastSeenAt
    };
  }

  async #describeCoreDiagnostics(coreKey) {
    const decoded = decodeKey(coreKey);
    const key = decoded ? toKeyString(decoded) : null;
    if (!decoded || !key) return { key, status: 'invalid-key' };
    const store = this.blindPeer?.store || this.blindPeeringStore || null;
    const storeLabel = store === this.blindPeeringStore
      ? 'blind-peering'
      : (store ? 'blind-peer' : null);
    if (!store || typeof store.get !== 'function') {
      return { key, status: 'store-unavailable', store: storeLabel };
    }
    try {
      const core = store.get({ key: decoded, valueEncoding: 'binary' });
      if (typeof core?.ready === 'function') {
        try {
          await core.ready();
        } catch (error) {
          this.logger?.debug?.( {
            key,
            store: storeLabel,
            err: error?.message || error
          }, '[BlindPeer] Core diagnostics ready() failed');
        }
      }
      const info = typeof core?.info === 'function' ? await core.info().catch(() => null) : null;
      const peerState = this.#describeCorePeerState(core);
      return {
        key,
        status: 'ok',
        store: storeLabel,
        localLength: info?.length ?? core?.length ?? null,
        contiguousLength: info?.contiguousLength ?? core?.contiguousLength ?? null,
        byteLength: info?.byteLength ?? core?.byteLength ?? null,
        fork: info?.fork ?? core?.fork ?? null,
        writable: core?.writable ?? null,
        ...peerState
      };
    } catch (error) {
      this.logger?.warn?.( {
        key,
        store: storeLabel,
        err: error?.message || error
      }, '[BlindPeer] Core diagnostics failed');
      return { key, status: 'error', store: storeLabel, error: error?.message || String(error) };
    }
  }

  async #logCoreDiagnostics({
    key,
    context = 'unknown',
    identifier = null,
    reason = null,
    type = null,
    role = null,
    priority = null,
    announce = null
  } = {}) {
    const diagnostics = await this.#describeCoreDiagnostics(key);
    if (!diagnostics) return;
    const keyPreview = diagnostics.key ? diagnostics.key.slice(0, 16) : null;
    const hasLocalData = Number.isFinite(diagnostics.localLength) ? diagnostics.localLength > 0 : null;
    const hasPeers = Number.isFinite(diagnostics.peerCount) ? diagnostics.peerCount > 0 : null;
    const prevSnapshot = this.coreDiagnosticsPrev?.get(diagnostics.key) || null;
    const prevRemoteLength = Number.isFinite(prevSnapshot?.remoteLength) ? prevSnapshot.remoteLength : null;
    const prevPeerCount = Number.isFinite(prevSnapshot?.peerCount) ? prevSnapshot.peerCount : null;
    const remoteLengthDelta = Number.isFinite(diagnostics.remoteLength) && Number.isFinite(prevRemoteLength)
      ? diagnostics.remoteLength - prevRemoteLength
      : null;
    const peerCountDelta = Number.isFinite(diagnostics.peerCount) && Number.isFinite(prevPeerCount)
      ? diagnostics.peerCount - prevPeerCount
      : null;
    this.logger?.info?.({
      context,
      identifier,
      reason,
      type,
      role,
      priority,
      announce,
      key: keyPreview,
      status: diagnostics.status || null,
      store: diagnostics.store || null,
      localLength: diagnostics.localLength ?? null,
      contiguousLength: diagnostics.contiguousLength ?? null,
      byteLength: diagnostics.byteLength ?? null,
      fork: diagnostics.fork ?? null,
      remoteLength: diagnostics.remoteLength ?? null,
      prevRemoteLength,
      remoteLengthDelta,
      remoteContiguousLength: diagnostics.remoteContiguousLength ?? null,
      peerCount: diagnostics.peerCount ?? null,
      prevPeerCount,
      peerCountDelta,
      lastSeenAt: diagnostics.lastSeenAt ?? null,
      lastDownloadedAt: diagnostics.lastSeenAt ?? null,
      hasLocalData,
      hasPeers,
      mirrorKey: this.blindPeeringMirrorKey || null,
      clientKey: this.blindPeeringClientKey || null
    }, `${CJTRACE_TAG} blind peer core diagnostics`);
    if (this.coreDiagnosticsPrev && diagnostics.key) {
      this.coreDiagnosticsPrev.set(diagnostics.key, {
        remoteLength: Number.isFinite(diagnostics.remoteLength) ? diagnostics.remoteLength : null,
        peerCount: Number.isFinite(diagnostics.peerCount) ? diagnostics.peerCount : null,
        updatedAt: Date.now()
      });
    }
  }

  async #logPinnedCoreDiagnostics({
    entries = [],
    identifier = null,
    reason = null,
    type = null,
    priority = null,
    announce = null
  } = {}) {
    if (!entries.length) return;
    for (const entry of entries) {
      await this.#logCoreDiagnostics({
        key: entry.key,
        context: 'pin-mirror',
        identifier,
        reason,
        type,
        role: entry.role || null,
        priority,
        announce
      });
    }
  }

  async #createBlindPeer() {
    if (this.blindPeer) return this.blindPeer;
    const BlindPeer = await loadBlindPeerModule();
    const storage = await this.#ensureStorageDir();

    this.blindPeer = new BlindPeer(storage, {
      maxBytes: this.config.maxBytes,
      enableGc: true,
      trustedPubKeys: Array.from(this.trustedPeers)
    });

    this.logger?.info?.( {
      constructor: this.blindPeer?.constructor?.name || null,
      hasAddCore: typeof this.blindPeer?.addCore === 'function',
      hasReady: typeof this.blindPeer?.ready === 'function',
      hasListen: typeof this.blindPeer?.listen === 'function',
      hasClose: typeof this.blindPeer?.close === 'function',
      hasDb: !!this.blindPeer?.db
    }, '[BlindPeer] Capability snapshot');

    this.blindPeer.on('add-core', (record, isTrusted, stream) => {
      this.#onBlindPeerAddCore(record, stream, { event: 'add-core', isTrusted });
      this.#updateMetrics();
    });
    this.blindPeer.on('add-new-core', (record, isTrusted, stream) => {
      this.#onBlindPeerAddCore(record, stream, { event: 'add-new-core', isNew: true, isTrusted });
      this.#updateMetrics();
    });
    this.blindPeer.on('downgrade-announce', ({ record, remotePublicKey } = {}) => {
      if (!this.logger?.info) return;
      this.logger.info({
        key: record?.key ? toKeyString(record.key).slice(0, 16) : null,
        ownerPeerKey: remotePublicKey ? toKeyString(remotePublicKey).slice(0, 16) : null,
        announce: record?.announce === true,
        priority: record?.priority ?? null
      }, `${CJTRACE_TAG} blind peer downgrade announce`);
    });
    if (typeof this.blindPeer.on === 'function') {
      this.blindPeer.on('error', (error) => {
        this.logger?.warn?.( {
          error: serializeError(error)
        }, '[BlindPeer] Underlying daemon error');
      });
    }
    this.blindPeer.on('delete-core', (stream, info) => {
      this.#onBlindPeerDeleteCore(info, { stream });
      this.#updateMetrics();
    });
    this.blindPeer.on('gc-done', (stats) => {
      this.logger?.debug?.( {
        bytesCleared: stats?.bytesCleared ?? null
      }, '[BlindPeer] Underlying daemon GC completed');
      this.#updateMetrics();
    });

    if (typeof this.blindPeer.listen === 'function') {
      await this.blindPeer.listen();
    } else if (typeof this.blindPeer.ready === 'function') {
      await this.blindPeer.ready();
    }

    this.logger?.info?.( {
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex()
    }, '[BlindPeer] Listening');

    return this.blindPeer;
  }

  async #ensureBlindPeeringClient({ reason = 'mirror-core' } = {}) {
    if (this.blindPeering) return this.blindPeering;
    if (!this.config.enabled) return null;
    if (!this.blindPeer) {
      this.logger?.warn?.( { reason }, '[BlindPeer] Blind-peering client init skipped (service not started)');
      return null;
    }

    const mirrorKey = this.getPublicKeyHex();
    if (!mirrorKey) {
      this.logger?.warn?.( { reason }, '[BlindPeer] Blind-peering client init skipped (missing mirror key)');
      return null;
    }

    let BlindPeering = null;
    try {
      BlindPeering = await loadBlindPeeringModule();
    } catch (error) {
      this.logger?.warn?.( {
        err: error?.message || error,
        reason
      }, '[BlindPeer] Failed to load blind-peering module');
      return null;
    }
    const clientStorageDir = this.config?.blindPeeringStorageDir
      ? resolve(this.config.blindPeeringStorageDir)
      : this.storageDir
        ? resolve(this.storageDir, 'blind-peering-client')
        : null;

    const store = new Corestore(clientStorageDir || undefined);
    try {
      await store.ready();
      this.logger?.info?.({
        storageDir: clientStorageDir,
        storeClosed: store?.closed ?? null,
        storeClosing: store?.closing ?? null
      }, '[BlindPeer] Blind-peering corestore ready');
    } catch (error) {
      this.logger?.warn?.( {
        err: error?.message || error,
        storageDir: clientStorageDir
      }, '[BlindPeer] Failed to ready blind-peering corestore');
    }

    const persistedKeyPair = await this.#loadBlindPeeringKeyPair();
    const swarmOptions = persistedKeyPair?.publicKey && persistedKeyPair?.secretKey
      ? { keyPair: persistedKeyPair }
      : {};
    const swarm = new Hyperswarm(swarmOptions);
    if (swarm && !swarm.__ht_blindpeer_swarm_log) {
      swarm.__ht_blindpeer_swarm_log = true;
      swarm.on('error', (error) => {
        this.logger?.warn?.( {
          err: error?.message || error,
          name: error?.name || null,
          code: error?.code || null,
          stack: error?.stack || null
        }, '[BlindPeer] Hyperswarm error');
      });
      swarm.on('connection', (socket, details = {}) => {
        const remotePublicKey = details?.publicKey || details?.remotePublicKey || socket?.remotePublicKey || socket?.publicKey;
        const remoteKey = toKeyString(remotePublicKey);
        const topicKey = details?.topic ? toKeyString(details.topic) : null;
        this.logger?.info?.( {
          remoteKey,
          topic: topicKey,
          initiator: details?.initiator ?? null,
          client: details?.client ?? null,
          server: details?.server ?? null
        }, `${CJTRACE_TAG} blind peering swarm connection`);
        if (socket && !socket.__ht_blindpeer_disconnect_log) {
          socket.__ht_blindpeer_disconnect_log = true;
          const logDisconnect = (event, error) => {
            if (socket.__ht_blindpeer_disconnected) return;
            socket.__ht_blindpeer_disconnected = true;
            this.logger?.info?.( {
              remoteKey,
              topic: topicKey,
              event,
              error: error?.message || error || null
            }, `${CJTRACE_TAG} blind peering swarm disconnect`);
          };
          socket.on('close', () => logDisconnect('close'));
          socket.on('end', () => logDisconnect('end'));
          socket.on('error', (error) => logDisconnect('error', error));
        }
      });
    }
    if (swarm && !swarm.__ht_blindpeer_conn_log) {
      swarm.__ht_blindpeer_conn_log = true;
      swarm.on('connection', (socket, details = {}) => {
        const remotePublicKey = details?.publicKey || details?.remotePublicKey || socket?.remotePublicKey || socket?.publicKey;
        const remoteKey = toKeyString(remotePublicKey);
        const topicKey = details?.topic ? toKeyString(details.topic) : null;
        this.logger?.info?.( {
          remoteKey,
          topic: topicKey,
          initiator: details?.initiator ?? null,
          client: details?.client ?? null,
          server: details?.server ?? null
        }, `${CJTRACE_TAG} blind peering swarm connection`);
        if (socket && !socket.__ht_blindpeer_disconnect_log) {
          socket.__ht_blindpeer_disconnect_log = true;
          const logDisconnect = (event, error) => {
            if (socket.__ht_blindpeer_disconnected) return;
            socket.__ht_blindpeer_disconnected = true;
            this.logger?.info?.( {
              remoteKey,
              topic: topicKey,
              event,
              error: error?.message || error || null
            }, `${CJTRACE_TAG} blind peering swarm disconnect`);
          };
          socket.on('close', () => logDisconnect('close'));
          socket.on('end', () => logDisconnect('end'));
          socket.on('error', (error) => logDisconnect('error', error));
        }
      });
    }

    if (persistedKeyPair?.publicKey && swarm?.dht?.defaultKeyPair) {
      const current = swarm.dht.defaultKeyPair?.publicKey || null;
      const expected = persistedKeyPair.publicKey;
      if (!current || !Buffer.from(current).equals(Buffer.from(expected))) {
        try {
          swarm.dht.defaultKeyPair = persistedKeyPair;
          this.logger?.info?.( {
            publicKey: toKeyString(expected)
          }, '[BlindPeer] Blind-peering client DHT keypair overridden');
        } catch (error) {
          this.logger?.warn?.( {
            err: error?.message || error
          }, '[BlindPeer] Failed to override blind-peering DHT keypair');
        }
      }
    }

    const clientDhtKey = swarm?.dht?.defaultKeyPair?.publicKey || null;
    const clientSwarmKey = swarm?.keyPair?.publicKey || null;
    const clientKey = toKeyString(persistedKeyPair?.publicKey || clientDhtKey || clientSwarmKey);
    const clientDhtKeyEncoded = toKeyString(clientDhtKey);
    const clientSwarmKeyEncoded = toKeyString(clientSwarmKey);

    if (clientKey) {
      this.addTrustedPeer(clientKey);
    } else {
      this.logger?.warn?.( { reason }, '[BlindPeer] Unable to determine blind-peering client key for trust');
    }

    try {
      this.blindPeering = new BlindPeering(swarm, store, {
        mirrors: [mirrorKey],
        pick: 1
      });
    } catch (error) {
      this.logger?.error?.( {
        err: error?.message || error,
        name: error?.name || null,
        code: error?.code || null,
        stack: error?.stack || null,
        mirrorKey,
        reason
      }, '[BlindPeer] Failed to initialize blind-peering client');
      throw error;
    }

    const blindPeeringTopic = this.blindPeering?.topic || this.blindPeering?.topicKey || null;
    const blindPeeringTopicKey = toKeyString(blindPeeringTopic);
    this.blindPeeringTopicKey = blindPeeringTopicKey;
    const swarmKeyPairPublicKey = toKeyString(swarm?.keyPair?.publicKey || persistedKeyPair?.publicKey || null);
    this.logger?.info?.({
      mirrorKey,
      mirrors: [mirrorKey],
      pick: 1,
      topic: blindPeeringTopicKey,
      swarmKeyPairPublicKey,
      hasPersistedKeyPair: Boolean(persistedKeyPair?.publicKey && persistedKeyPair?.secretKey),
      swarmOptionsHasKeyPair: Boolean(swarmOptions?.keyPair),
      reason
    }, `${CJTRACE_TAG} blind peering swarm config`);
    this.logger?.info?.({
      blindPeeringKeys: this.blindPeering ? Object.keys(this.blindPeering) : [],
      swarmKeys: swarm ? Object.keys(swarm) : []
    }, `${CJTRACE_TAG} blind peering swarm object keys`);
    const swarmDiscovery = swarm?._discovery || null;
    const swarmDiscoveryTopics = swarmDiscovery?.topics ? Array.from(swarmDiscovery.topics) : [];
    this.logger?.info?.({
      discoveryKeys: swarmDiscovery ? Object.keys(swarmDiscovery) : [],
      topicCount: swarmDiscoveryTopics.length,
      topics: swarmDiscoveryTopics.map((topic) => toKeyString(topic))
    }, `${CJTRACE_TAG} blind peering swarm discovery`);
    const swarmDiscoveryHandles = swarmDiscovery?.handles || swarmDiscovery?.sessions || null;
    const handleKeys = swarmDiscoveryHandles instanceof Map
      ? Array.from(swarmDiscoveryHandles.keys()).map((key) => toKeyString(key))
      : Array.isArray(swarmDiscoveryHandles)
        ? swarmDiscoveryHandles.map((entry) => toKeyString(entry?.topic || entry))
        : [];
    this.logger?.info?.({
      discoveryHandleType: swarmDiscoveryHandles
        ? (swarmDiscoveryHandles.constructor?.name || typeof swarmDiscoveryHandles)
        : null,
      discoveryHandleCount: swarmDiscoveryHandles instanceof Map
        ? swarmDiscoveryHandles.size
        : Array.isArray(swarmDiscoveryHandles)
          ? swarmDiscoveryHandles.length
          : null,
      discoveryHandles: handleKeys
    }, `${CJTRACE_TAG} blind peering swarm discovery handles`);

    this.blindPeeringSwarm = swarm;
    this.blindPeeringStore = store;
    this.blindPeeringMirrorKey = mirrorKey;
    this.blindPeeringClientKey = clientKey;

    this.logger?.info?.( {
      mirrorKey,
      clientKey,
      clientDhtKey: clientDhtKeyEncoded,
      clientSwarmKey: clientSwarmKeyEncoded,
      storageDir: clientStorageDir,
      reason
    }, '[BlindPeer] Blind-peering client ready');
    this.logger?.info?.( {
      mirrorKey,
      clientKey,
      clientDhtKey: clientDhtKeyEncoded,
      clientSwarmKey: clientSwarmKeyEncoded,
      storageDir: clientStorageDir,
      reason
    }, `${CJTRACE_TAG} blind peering client ready`);

    if (!this.blindPeeringSwarmLogInterval) {
      this.blindPeeringSwarmLogInterval = setInterval(() => {
        const hasConnections = swarm && Object.prototype.hasOwnProperty.call(swarm, 'connections');
        const connectionsValue = hasConnections ? swarm.connections : null;
        const connectionsType = connectionsValue
          ? (connectionsValue.constructor?.name || typeof connectionsValue)
          : (hasConnections ? 'null' : 'absent');
        const connectionCount = Number.isFinite(connectionsValue?.size)
          ? connectionsValue.size
          : (Array.isArray(connectionsValue) ? connectionsValue.length : null);
        const hasPeers = swarm && Object.prototype.hasOwnProperty.call(swarm, 'peers');
        const peersValue = hasPeers ? swarm.peers : null;
        const peersType = peersValue
          ? (peersValue.constructor?.name || typeof peersValue)
          : (hasPeers ? 'null' : 'absent');
        const peerCount = Number.isFinite(peersValue?.size)
          ? peersValue.size
          : (Array.isArray(peersValue) ? peersValue.length : null);
        this.logger?.info?.({
          mirrorKey,
          clientKey,
          topic: this.blindPeeringTopicKey || null,
          connectionCount,
          hasConnections,
          connectionsType,
          peerCount,
          hasPeers,
          peersType,
          reason: 'interval'
        }, `${CJTRACE_TAG} blind peering swarm status`);
      }, 30000).unref();
    }

    return this.blindPeering;
  }

  async #ensureStorageDir() {
    if (!this.storageDir) {
      this.storageDir = resolve(process.cwd(), DEFAULT_STORAGE_SUBDIR);
    }
    await mkdir(this.storageDir, { recursive: true });
    return this.storageDir;
  }

  #updateMetrics() {
    const bytes = this.blindPeer?.digest?.bytesAllocated ?? 0;
    this.metrics.setBytesAllocated?.(bytes);
    this.#updateTrustedPeers();
    const snapshot = this.getMirrorReadinessSnapshot({
      includeCores: false,
      limit: Number.POSITIVE_INFINITY
    });
    this.metrics.updateMirrorState?.(snapshot);
  }

  #updateTrustedPeers() {
    this.metrics.setTrustedPeers?.(this.trustedPeers.size);
  }

  async #loadTrustedPeersFromDisk() {
    if (!this.trustedPeersPersistPath || this.trustedPeersLoaded) return;
    try {
      const raw = await readFile(this.trustedPeersPersistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const key = sanitizePeerKey(entry?.key);
          if (!key) continue;
          this.trustedPeers.add(key);
          const trustedSince = Number(entry?.trustedSince);
          this.trustedPeerMeta.set(key, {
            trustedSince: Number.isFinite(trustedSince) ? trustedSince : Date.now()
          });
        }
      }
      this.logger?.info?.( {
        count: this.trustedPeers.size,
        path: this.trustedPeersPersistPath
      }, '[BlindPeer] Loaded trusted peers from disk');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.( {
          path: this.trustedPeersPersistPath,
          err: error?.message || error
        }, '[BlindPeer] Failed to load trusted peers from disk');
      }
    } finally {
      this.trustedPeersLoaded = true;
    }
  }

  async #persistTrustedPeers() {
    if (!this.trustedPeersPersistPath) return;
    const payload = this.getTrustedPeers();
    try {
      await mkdir(dirname(this.trustedPeersPersistPath), { recursive: true });
      await writeFile(
        this.trustedPeersPersistPath,
        JSON.stringify(payload, null, 2),
        'utf8'
      );
    } catch (error) {
      throw error;
    }
  }
}
