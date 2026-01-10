// ./relay-worker/hypertuna-relay-manager-adapter.mjs
// Adapter to integrate legacy RelayManager functionality into Pear worker

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import nodeCrypto from 'node:crypto';
import hypercoreCrypto from 'hypercore-crypto';
import Corestore from 'corestore';
import HypercoreId from 'hypercore-id-encoding';
import { NostrUtils } from './nostr-utils.js';
import b4a from 'b4a';
import { getRelayCorestore } from './hyperdrive-manager.mjs';

// Import the legacy modules (adapted to run in a pure Node/Electron environment)
import { RelayManager } from './hypertuna-relay-manager-bare.mjs';
import { 
    initRelayProfilesStorage, 
    getAllRelayProfiles, 
    getRelayProfileByKey,
    calculateAuthorizedUsers, // NEW IMPORT
    saveRelayProfile, 
    removeRelayProfile,
importLegacyRelayProfiles,
updateRelayMemberSets,
calculateMembers
} from './hypertuna-relay-profile-manager-bare.mjs';

import { ChallengeManager } from './challenge-manager.mjs';
import { normalizeRelayIdentifier } from './relay-identifier-utils.mjs';


// Store active relay managers
const activeRelays = new Map();
const virtualRelayKeys = new Set();
const AUTO_CONNECT_REHYDRATION_TIMEOUT_MS = 60000;

// Store relay members keyed by relay key or public identifier
const relayMembers = new Map();
const relayMemberAdds = new Map();
const relayMemberRemoves = new Map();

// Mapping between public identifiers and internal relay keys
const publicToKey = new Map();
const keyToPublic = new Map();

function parseRelayMetadataEvent(event) {
    if (!event) return null;

    const tags = Array.isArray(event.tags) ? event.tags : [];
    const findTagValue = (key) => {
        const tag = tags.find((t) => t[0] === key && t.length > 1);
        return tag ? tag[1] : null;
    };

    const metadata = {
        name: findTagValue('name'),
        description: findTagValue('about'),
        avatarUrl: null,
        isPublic: null,
        createdAt: event.created_at || null,
        updatedAt: event.created_at ? event.created_at * 1000 : null,
        identifier: findTagValue('d') || null,
        eventId: event.id || null
    };

    const pictureTag = tags.find((t) => t[0] === 'picture' && t.length > 1 && typeof t[1] === 'string');
    if (pictureTag) {
        metadata.avatarUrl = pictureTag[1];
    }

    if (tags.some((t) => t[0] === 'public')) {
        metadata.isPublic = true;
    } else if (tags.some((t) => t[0] === 'private')) {
        metadata.isPublic = false;
    }

    return metadata;
}

function decodeWriterKey(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            return HypercoreId.decode(trimmed);
        } catch (_) {
            if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
                return Buffer.from(trimmed, 'hex');
            }
        }
    }
    return null;
}

function normalizeCoreRef(value) {
    if (!value) return null;
    if (value && typeof value === 'object') {
        if (value.key) return normalizeCoreRef(value.key);
        if (value.core) return normalizeCoreRef(value.core);
    }
    const decoded = decodeWriterKey(value);
    if (!decoded) return null;
    try {
        return HypercoreId.encode(decoded);
    } catch (_) {
        return null;
    }
}

function normalizeCoreRefs(coreRefs) {
    if (!Array.isArray(coreRefs)) return [];
    const normalized = [];
    const seen = new Set();
    for (const ref of coreRefs) {
        const normalizedRef = normalizeCoreRef(ref);
        if (!normalizedRef || seen.has(normalizedRef)) continue;
        seen.add(normalizedRef);
        normalized.push(normalizedRef);
    }
    return normalized;
}

function mergeCoreRefLists(...lists) {
    const merged = [];
    const seen = new Set();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const ref of list) {
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            merged.push(ref);
        }
    }
    return merged;
}

let localCorestoreCounter = 0;

function ensureLocalCorestoreId(store) {
    if (!store) return null;
    if (!store.__ht_id) {
        localCorestoreCounter += 1;
        store.__ht_id = `local-corestore-${localCorestoreCounter}`;
    }
    return store.__ht_id;
}

function createLocalCorestore(storageDir, relayKey = null) {
    if (!storageDir) return null;
    const store = new Corestore(storageDir);
    ensureLocalCorestoreId(store);
    store.__ht_storage_path = storageDir;
    if (relayKey) {
        store.__ht_relay_key = relayKey;
    }
    return store;
}

function sanitizeBlindPeerMeta(blindPeer) {
    if (!blindPeer || typeof blindPeer !== 'object') return null;
    const entry = {};
    if (blindPeer.publicKey) entry.publicKey = String(blindPeer.publicKey);
    if (blindPeer.encryptionKey) entry.encryptionKey = String(blindPeer.encryptionKey);
    if (blindPeer.replicationTopic) entry.replicationTopic = String(blindPeer.replicationTopic);
    if (Number.isFinite(blindPeer.maxBytes)) entry.maxBytes = blindPeer.maxBytes;
    return Object.keys(entry).length ? entry : null;
}

function collectActiveWriterSample(relayManager, limit = 4) {
    const writers = relayManager?.relay?.activeWriters;
    if (!writers || typeof writers[Symbol.iterator] !== 'function') {
        return [];
    }
    const sample = [];
    for (const writer of writers) {
        const key = writer?.core?.key || writer?.key || writer;
        if (key && b4a.isBuffer(key)) {
            sample.push(b4a.toString(key, 'hex').slice(0, 16));
        }
        if (sample.length >= limit) break;
    }
    return sample;
}

function validateWriterSecret(writerSecret, { writerCore = null, expectedWriterKey = null } = {}) {
    if (!writerSecret) {
        return { valid: false, expectedWriterKey: expectedWriterKey || null };
    }

    let expectedKey = expectedWriterKey || null;
    if (!expectedKey && writerCore) {
        expectedKey = decodeWriterKey(writerCore);
    }
    if (!expectedKey) {
        return { valid: false, expectedWriterKey: null };
    }

    const secretHex = String(writerSecret).trim();
    if (!/^[0-9a-fA-F]+$/.test(secretHex)) {
        return { valid: false, expectedWriterKey: expectedKey };
    }

    let secretKey = null;
    try {
        secretKey = Buffer.from(secretHex, 'hex');
    } catch (_) {
        return { valid: false, expectedWriterKey: expectedKey };
    }

    if (!secretKey || secretKey.length < 32) {
        return { valid: false, expectedWriterKey: expectedKey };
    }

    const seedCandidates = [];
    if (secretKey.length >= 32) seedCandidates.push(secretKey.subarray(0, 32));

    for (const seed of seedCandidates) {
        try {
            const candidate = hypercoreCrypto.keyPair(seed);
            if (candidate?.publicKey && b4a.equals(candidate.publicKey, expectedKey)) {
                return { valid: true, expectedWriterKey: expectedKey };
            }
        } catch (_) {
            // try next seed
        }
    }

    if (secretKey.length === 64) {
        const candidate = { publicKey: expectedKey, secretKey };
        if (hypercoreCrypto.validateKeyPair(candidate)) {
            return { valid: true, expectedWriterKey: expectedKey };
        }
    }

    return { valid: false, expectedWriterKey: expectedKey };
}

function snapshotWriterMaterial(source = {}) {
    return {
        writer_secret: source.writer_secret ?? source.writerSecret ?? null,
        writer_core: source.writer_core ?? source.writerCore ?? null,
        writer_core_hex: source.writer_core_hex ?? source.writerCoreHex ?? null,
        autobase_local: source.autobase_local ?? source.autobaseLocal ?? null
    };
}

function logWriterMaterialChange({ stage, relayKey, before, after, extra = {} } = {}) {
    console.log('[RelayAdapter][WriterMaterial] change', {
        stage,
        relayKey,
        before: before || null,
        after: after || null,
        ...extra
    });
}

function resolveCoreKeyMaterial(core) {
    if (!core) {
        return {
            coreKey: null,
            signerKey: null,
            coreKeyHex: null,
            signerKeyHex: null,
            writerKey: null,
            writerCore: null,
            writerCoreSource: null,
            coreMatchesSigner: null
        };
    }

    const coreKey = decodeWriterKey(core.key || null);
    const signerKey = decodeWriterKey(core.keyPair?.publicKey || null);
    const coreKeyHex = coreKey ? b4a.toString(coreKey, 'hex') : null;
    const signerKeyHex = signerKey ? b4a.toString(signerKey, 'hex') : null;
    const writerKey = signerKey || coreKey || null;
    let writerCore = null;
    if (writerKey) {
        try {
            writerCore = HypercoreId.encode(writerKey);
        } catch (_) {
            writerCore = null;
        }
    }
    const writerCoreSource = signerKey ? 'signer' : coreKey ? 'core' : null;
    const coreMatchesSigner = coreKey && signerKey ? b4a.equals(coreKey, signerKey) : null;

    return {
        coreKey,
        signerKey,
        coreKeyHex,
        signerKeyHex,
        writerKey,
        writerCore,
        writerCoreSource,
        coreMatchesSigner
    };
}

function buildWriterCandidateFromCore(core, label) {
    if (!core) return null;
    const keyInfo = resolveCoreKeyMaterial(core);
    const autobaseLocal = keyInfo.coreKeyHex;
    const secretKey = core.keyPair?.secretKey || core.secretKey || null;
    const writerSecret = secretKey
        ? (typeof secretKey === 'string' ? secretKey : b4a.toString(secretKey, 'hex'))
        : null;

    if (keyInfo.coreKeyHex && keyInfo.signerKeyHex && keyInfo.coreMatchesSigner === false) {
        console.warn('[RelayAdapter][WriterMaterial] Core key differs from signer key', {
            label,
            coreKeyHex: keyInfo.coreKeyHex,
            signerKeyHex: keyInfo.signerKeyHex
        });
    } else if (!keyInfo.coreKeyHex && keyInfo.signerKeyHex) {
        console.warn('[RelayAdapter][WriterMaterial] Missing core key for writer candidate', {
            label,
            signerKeyHex: keyInfo.signerKeyHex
        });
    }

    return {
        label,
        writerSecret,
        writerCore: keyInfo.writerCore,
        autobaseLocal,
        coreKeyHex: keyInfo.coreKeyHex,
        signerKeyHex: keyInfo.signerKeyHex,
        writerCoreSource: keyInfo.writerCoreSource,
        coreMatchesSigner: keyInfo.coreMatchesSigner
    };
}

function collectWriterMaterialCandidates(relayManager) {
    const candidates = [];
    const addCandidate = (core, label) => {
        const candidate = buildWriterCandidateFromCore(core, label);
        if (candidate) candidates.push(candidate);
    };
    addCandidate(relayManager?.relay?.localWriter?.core || null, 'localWriter');
    addCandidate(relayManager?.relay?.local || null, 'local');
    const relayCore = relayManager?.relay?.core || null;
    if (relayCore && relayCore !== relayManager?.relay?.local) {
        addCandidate(relayCore, 'relayCore');
    }
    return candidates;
}

function selectValidWriterMaterial(candidates, { relayKey = null, stage = null } = {}) {
    const inspected = [];
    let selected = null;
    let fallback = null;

    for (const candidate of candidates) {
        if (!candidate) continue;
        if (!fallback && candidate.autobaseLocal) fallback = candidate;
        const validation = validateWriterSecret(candidate.writerSecret, {
            writerCore: candidate.writerCore || candidate.autobaseLocal
        });
        inspected.push({
            label: candidate.label,
            writerCore: candidate.writerCore,
            autobaseLocal: candidate.autobaseLocal,
            writerCoreSource: candidate.writerCoreSource,
            coreKeyHex: candidate.coreKeyHex,
            signerKeyHex: candidate.signerKeyHex,
            coreMatchesSigner: candidate.coreMatchesSigner,
            hasWriterSecret: !!candidate.writerSecret,
            writerSecretLen: candidate.writerSecret ? candidate.writerSecret.length : 0,
            valid: validation.valid
        });
        if (validation.valid && !selected) {
            selected = candidate;
        }
    }

    if (stage) {
        console.log('[RelayAdapter][WriterMaterial] candidate selection', {
            stage,
            relayKey,
            inspected,
            selected: selected ? selected.label : null,
            fallback: fallback ? fallback.label : null
        });
    }

    return { selected, fallback, inspected };
}

function applyJoinMetadata(profile, {
    writerSecret = null,
    writerCore = null,
    expectedWriterKey = null,
    relayManager = null,
    blindPeer = null,
    coreRefs = null
} = {}) {
    const updated = { ...profile };
    const localKeyHex = relayManager?.relay?.local?.key
        ? b4a.toString(relayManager.relay.local.key, 'hex')
        : null;
    const expectedHexFull = expectedWriterKey
        ? b4a.toString(expectedWriterKey, 'hex')
        : null;
    const normalizedRefs = normalizeCoreRefs(coreRefs);
    const existingRefs = normalizeCoreRefs(profile.core_refs || profile.coreRefs);
    const mergedRefs = mergeCoreRefLists(existingRefs, normalizedRefs);
    const blindPeerMeta = sanitizeBlindPeerMeta(blindPeer);

    const existingExpectedKey = decodeWriterKey(
        profile.writer_core ||
        profile.writerCore ||
        profile.writer_core_hex ||
        profile.autobase_local ||
        null
    );
    const existingWriterValid = validateWriterSecret(profile.writer_secret || profile.writerSecret, {
        expectedWriterKey: existingExpectedKey
    }).valid;
    const incomingWriterValid = validateWriterSecret(writerSecret, {
        writerCore,
        expectedWriterKey
    }).valid;

    const shouldUpdateWriterMaterial = incomingWriterValid && !existingWriterValid;

    const beforeWriterSnapshot = shouldUpdateWriterMaterial ? snapshotWriterMaterial(profile) : null;

    if (writerSecret && shouldUpdateWriterMaterial) updated.writer_secret = writerSecret;
    if (writerCore && shouldUpdateWriterMaterial) updated.writer_core = writerCore;
    if (!writerCore && localKeyHex && shouldUpdateWriterMaterial) updated.writer_core_hex = localKeyHex;
    if (localKeyHex && shouldUpdateWriterMaterial) updated.autobase_local = localKeyHex;
    if (blindPeerMeta) updated.blind_peer = blindPeerMeta;
    if (mergedRefs.length) updated.core_refs = mergedRefs;

    if (
        (writerSecret && shouldUpdateWriterMaterial) ||
        (writerCore && shouldUpdateWriterMaterial) ||
        (!writerCore && localKeyHex && shouldUpdateWriterMaterial) ||
        (localKeyHex && shouldUpdateWriterMaterial) ||
        blindPeerMeta ||
        mergedRefs.length
    ) {
        updated.updated_at = new Date().toISOString();
    }

    if (shouldUpdateWriterMaterial && !writerCore && expectedHexFull && !localKeyHex) {
        console.warn('[RelayAdapter][WriterMaterial] Skipping writer_core_hex update; core key unavailable', {
            relayKey: profile.relay_key || profile.relayKey || relayManager?.relay?.key || null,
            expectedWriterHex: expectedHexFull
        });
    }

    if (shouldUpdateWriterMaterial) {
        const afterWriterSnapshot = snapshotWriterMaterial(updated);
        logWriterMaterialChange({
            stage: 'join-metadata-update',
            relayKey: profile.relay_key || profile.relayKey || relayManager?.relay?.key || null,
            before: beforeWriterSnapshot,
            after: afterWriterSnapshot,
            extra: {
                incomingWriterValid,
                existingWriterValid,
                expectedWriterKey: expectedHexFull,
                localKeyHex
            }
        });
    }

    return updated;
}

function extractLocalWriterProfileFields(relayManager) {
    const core = relayManager?.relay?.localWriter?.core
        || relayManager?.relay?.local
        || relayManager?.relay?.core
        || null;
    if (!core) {
        return { writerSecret: null, writerCore: null, autobaseLocal: null };
    }

    const keyInfo = resolveCoreKeyMaterial(core);
    const autobaseLocal = keyInfo.coreKeyHex;
    const writerCore = keyInfo.writerCore;

    const secretKey = core.keyPair?.secretKey || core.secretKey || null;
    const writerSecret = secretKey
        ? (typeof secretKey === 'string' ? secretKey : b4a.toString(secretKey, 'hex'))
        : null;

    return {
        writerSecret,
        writerCore,
        autobaseLocal,
        coreKeyHex: keyInfo.coreKeyHex,
        signerKeyHex: keyInfo.signerKeyHex,
        writerCoreSource: keyInfo.writerCoreSource,
        coreMatchesSigner: keyInfo.coreMatchesSigner
    };
}

async function recoverLocalWriterMaterial({ relayKey, profile, config, preferBootstrapLocal = false }) {
    const attempts = [];
    if (profile?.relay_storage) {
        const localStore = createLocalCorestore(profile.relay_storage, relayKey);
        if (localStore) {
            attempts.push({ source: 'local-storage', store: localStore });
        }
    }

    const sharedStore = getRelayCorestore(relayKey, { storageBase: config?.storage || null });
    if (sharedStore && typeof sharedStore.get === 'function') {
        attempts.push({ source: 'shared-storage', store: sharedStore });
    }

    const profileAutobaseKey = decodeWriterKey(profile?.autobase_local || null);
    const profileCoreHexKey = decodeWriterKey(profile?.writer_core_hex || null);
    const profileWriterCoreKey = decodeWriterKey(profile?.writer_core || profile?.writerCore || null);
    let localKey = profileAutobaseKey || profileCoreHexKey || null;
    const profileLocalKey = localKey;
    const legacyWriterCoreKey = !localKey && profileWriterCoreKey ? profileWriterCoreKey : null;

    if (!localKey) {
        console.warn('[RelayAdapter][WriterMaterial] No autobase local key stored; will rely on bootstrap lookup', {
            relayKey,
            hasWriterCore: !!profileWriterCoreKey,
            hasWriterCoreHex: !!profileCoreHexKey
        });
    }

    for (const attempt of attempts) {
        const relayCorestore = attempt.store;
        if (!relayCorestore || typeof relayCorestore.get !== 'function') continue;

        let resolvedLocalKey = localKey;
        if (preferBootstrapLocal || !resolvedLocalKey) {
            const bootstrapKey = decodeWriterKey(relayKey);
            if (bootstrapKey) {
                try {
                    const bootstrapCore = relayCorestore.get({ key: bootstrapKey, compat: false, active: false });
                    await bootstrapCore.ready();
                    const storedLocal = await bootstrapCore.getUserData('autobase/local');
                    if (storedLocal) {
                        const bootstrapHex = b4a.toString(storedLocal, 'hex');
                        const profileHex = resolvedLocalKey ? b4a.toString(resolvedLocalKey, 'hex') : null;
                        if (!resolvedLocalKey || !b4a.equals(storedLocal, resolvedLocalKey)) {
                            console.warn('[RelayAdapter] Autobase local key mismatch; preferring bootstrap local', {
                                relayKey,
                                source: attempt.source,
                                preferBootstrapLocal,
                                profileAutobaseLocal: profileHex,
                                bootstrapAutobaseLocal: bootstrapHex
                            });
                        }
                        resolvedLocalKey = storedLocal;
                    }
                } catch (error) {
                    console.warn('[RelayAdapter] Failed to read autobase/local metadata for writer recovery', {
                        relayKey,
                        source: attempt.source,
                        error: error?.message || error
                    });
                }
            }
        }

        if (!resolvedLocalKey && legacyWriterCoreKey) {
            resolvedLocalKey = legacyWriterCoreKey;
            console.warn('[RelayAdapter][WriterMaterial] Falling back to writer_core as autobase local key (legacy profile)', {
                relayKey,
                source: attempt.source,
                writerCoreHex: b4a.toString(legacyWriterCoreKey, 'hex')
            });
        }

        if (!resolvedLocalKey) continue;

        try {
            const localCore = relayCorestore.get({ key: resolvedLocalKey, compat: false, active: false });
            await localCore.ready();
            const secretKey = localCore?.keyPair?.secretKey || localCore?.secretKey || null;
            if (!secretKey) {
                continue;
            }
            const writerSecret = typeof secretKey === 'string' ? secretKey : b4a.toString(secretKey, 'hex');
            const autobaseLocal = b4a.toString(resolvedLocalKey, 'hex');
            const keyInfo = resolveCoreKeyMaterial(localCore);
            let writerCore = keyInfo.writerCore;
            let writerCoreSource = keyInfo.writerCoreSource;
            let signerKeyHex = keyInfo.signerKeyHex;

            if (!writerCore && secretKey) {
                const secretBuf = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey);
                if (secretBuf.length >= 32) {
                    try {
                        const candidate = hypercoreCrypto.keyPair(secretBuf.subarray(0, 32));
                        if (candidate?.publicKey) {
                            writerCore = HypercoreId.encode(candidate.publicKey);
                            signerKeyHex = b4a.toString(candidate.publicKey, 'hex');
                            writerCoreSource = 'derived-secret';
                        }
                    } catch (_) {
                        // ignore
                    }
                }
            }

            const usedLegacyWriterCore = legacyWriterCoreKey && resolvedLocalKey
                ? b4a.equals(resolvedLocalKey, legacyWriterCoreKey)
                : false;
            console.log('[RelayAdapter][WriterMaterial] Recovered local writer core material', {
                relayKey,
                source: attempt.source,
                resolvedLocalKey: autobaseLocal,
                coreKeyHex: keyInfo.coreKeyHex,
                signerKeyHex,
                writerCoreSource,
                coreMatchesSigner: keyInfo.coreMatchesSigner,
                usedLegacyWriterCore
            });
            return {
                writerSecret,
                writerCore,
                autobaseLocal,
                source: attempt.source,
                corestore: relayCorestore,
                preferBootstrapLocal,
                profileAutobaseLocal: profileLocalKey ? b4a.toString(profileLocalKey, 'hex') : null,
                coreKeyHex: keyInfo.coreKeyHex,
                signerKeyHex,
                writerCoreSource,
                coreMatchesSigner: keyInfo.coreMatchesSigner,
                usedLegacyWriterCore
            };
        } catch (error) {
            console.warn('[RelayAdapter] Failed to recover local writer material from corestore', {
                relayKey,
                source: attempt.source,
                error: error?.message || error
            });
        }
    }

    return null;
}

export async function getRelayMetadata(relayKey, publicIdentifier = null) {
    const manager = activeRelays.get(relayKey);
    if (!manager || typeof manager.queryEvents !== 'function') {
        return null;
    }

    try {
        const filter = { kinds: [39000], limit: 50 };
        if (publicIdentifier) {
            filter['#d'] = [publicIdentifier];
        }

        const events = await manager.queryEvents(filter);
        if (!Array.isArray(events) || events.length === 0) {
            return null;
        }

        events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
        const latest = events[0];
        const parsed = parseRelayMetadataEvent(latest);
        if (parsed && !parsed.identifier && publicIdentifier) {
            parsed.identifier = publicIdentifier;
        }
        return parsed;
    } catch (error) {
        console.error(`[RelayAdapter] Failed to load metadata for relay ${relayKey}:`, error);
        return null;
    }
}

function getGatewayWebsocketProtocol(config) {
    return config?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss';
}

function buildGatewayWebsocketBase(config) {
    const protocol = getGatewayWebsocketProtocol(config);
    const host = config?.proxy_server_address || 'localhost';
    return `${protocol}://${host}`;
}

export function setRelayMapping(relayKey, publicIdentifier) {
    if (!relayKey) return;
    if (publicIdentifier) {
        publicToKey.set(publicIdentifier, relayKey);
        keyToPublic.set(relayKey, publicIdentifier);
    } else {
        const existing = keyToPublic.get(relayKey);
        if (existing) publicToKey.delete(existing);
        keyToPublic.delete(relayKey);
    }
}

export function removeRelayMapping(relayKey, publicIdentifier) {
    const pid = publicIdentifier || keyToPublic.get(relayKey);
    if (pid) publicToKey.delete(pid);
    if (relayKey) keyToPublic.delete(relayKey);
}

export async function loadRelayKeyMappings() {
    await ensureProfilesInitialized(globalUserKey);
    publicToKey.clear();
    keyToPublic.clear();
    const profiles = await getAllRelayProfiles(globalUserKey);
    for (const p of profiles) {
        if (p.relay_key && p.public_identifier) {
            publicToKey.set(p.public_identifier, p.relay_key);
            keyToPublic.set(p.relay_key, p.public_identifier);
        }
    }
    return { publicToKey, keyToPublic };
}

export function setRelayMembers(relayKey, members = [], adds = null, removes = null) {
    relayMembers.set(relayKey, members);
    if (adds) relayMemberAdds.set(relayKey, adds);
    if (removes) relayMemberRemoves.set(relayKey, removes);
}

export function registerVirtualRelay(relayKey, manager, options = {}) {
    if (!relayKey) {
        throw new Error('relayKey is required to register a virtual relay');
    }
    if (!manager || typeof manager.handleMessage !== 'function') {
        throw new Error('manager with handleMessage implementation is required for virtual relay');
    }

    const {
        publicIdentifier = relayKey,
        members = [],
        metadata = {},
        logger = console
    } = options;

    const existing = activeRelays.get(relayKey);
    if (existing && existing !== manager) {
        try {
            existing.close?.();
        } catch (error) {
            logger?.warn?.('[RelayAdapter][VirtualRelay] Failed to close existing manager', {
                relayKey,
                error: error?.message
            });
        }
    }

    activeRelays.set(relayKey, manager);
    virtualRelayKeys.add(relayKey);

    setRelayMapping(relayKey, publicIdentifier);
    setRelayMembers(relayKey, members);
    relayMemberAdds.set(relayKey, []);
    relayMemberRemoves.set(relayKey, []);
    if (publicIdentifier && publicIdentifier !== relayKey) {
        setRelayMembers(publicIdentifier, members);
        relayMemberAdds.set(publicIdentifier, []);
        relayMemberRemoves.set(publicIdentifier, []);
    }

    logger?.info?.('[RelayAdapter][VirtualRelay] Registered virtual relay', {
        relayKey,
        publicIdentifier,
        metadata
    });

    return {
        relayKey,
        publicIdentifier,
        metadata
    };
}

export async function unregisterVirtualRelay(relayKey, options = {}) {
    if (!relayKey) return;

    const { publicIdentifier = keyToPublic.get(relayKey), logger = console } = options;

    const manager = activeRelays.get(relayKey);
    if (manager) {
        try {
            await manager.close?.();
        } catch (error) {
            logger?.warn?.('[RelayAdapter][VirtualRelay] Failed to close virtual relay manager', {
                relayKey,
                error: error?.message
            });
        }
        activeRelays.delete(relayKey);
    }

    if (virtualRelayKeys.has(relayKey)) {
        virtualRelayKeys.delete(relayKey);
    }

    removeRelayMapping(relayKey, publicIdentifier);
    relayMembers.delete(relayKey);
    relayMemberAdds.delete(relayKey);
    relayMemberRemoves.delete(relayKey);
    if (publicIdentifier) {
        relayMembers.delete(publicIdentifier);
        relayMemberAdds.delete(publicIdentifier);
        relayMemberRemoves.delete(publicIdentifier);
    }

    logger?.info?.('[RelayAdapter][VirtualRelay] Unregistered virtual relay', {
        relayKey,
        publicIdentifier
    });
}

// Store config reference
let globalConfig = null;
let globalUserKey = null;

// Initialize profile storage on module load
let profilesInitialized = false;

async function ensureProfilesInitialized(userKey = null) {
    if (!profilesInitialized) {
        await initRelayProfilesStorage(userKey || globalUserKey);
        profilesInitialized = true;
    }
}

/**
 * Create a new relay
 * @param {Object} options - Creation options
 * @param {string} options.name - Relay name
 * @param {string} options.description - Relay description
 * @param {string} options.storageDir - Optional storage directory
 * @param {Object} options.config - Configuration object
 * @returns {Promise<Object>} - Result object with relay information
 */
export async function createRelay(options = {}) {
    const { name, description, isPublic = false, isOpen = false, storageDir, config } = options;
    
    // Store config and user key globally if provided
    if (config) {
        globalConfig = config;
        globalUserKey = config.userKey;
    }
    
    try {
        await ensureProfilesInitialized(globalUserKey);
        
        // Generate relay key components
        const timestamp = Date.now();
        const userStorageBase = join(config.storage || './data', 'relays');
        const defaultStorageDir = storageDir || join(userStorageBase, `relay-${timestamp}`);
        
        // Ensure storage directory exists
        await fs.mkdir(defaultStorageDir, { recursive: true });
        
        // Create relay manager instance
        const relayManager = new RelayManager(defaultStorageDir, null);
        await relayManager.initialize();

        const relayKey = relayManager.getPublicKey();
        activeRelays.set(relayKey, relayManager);

        const localWriterInfo = extractLocalWriterProfileFields(relayManager);
        const writerCandidates = collectWriterMaterialCandidates(relayManager);
        const writerSelection = selectValidWriterMaterial(writerCandidates, {
            relayKey,
            stage: 'create-relay'
        });
        const selectedWriterInfo = writerSelection.selected || null;
        const fallbackWriterInfo = writerSelection.fallback || null;
        
        // Generate public identifier
        const npub = config.nostr_npub || (config.nostr_pubkey_hex ? 
            NostrUtils.hexToNpub(config.nostr_pubkey_hex) : null);
        
        const publicIdentifier = npub && name ? 
            generatePublicIdentifier(npub, name) : null;
        
        // Auth token will be generated and added in pear-relay-server.mjs
        // to ensure a single, consistent token source.
        const authToken = null; // No token generated here.
        const auth_adds = []; // Initially empty.
        
        // Create relay profile with both internal and public identifiers
        const profileInfo = {
            name: name || `Relay ${relayKey.substring(0, 8)}`,
            description: description || `Created on ${new Date().toLocaleString()}`,
            nostr_pubkey_hex: config.nostr_pubkey_hex || generateHexKey(),
            admin_pubkey: config.nostr_pubkey_hex || null,
            members: config.nostr_pubkey_hex ? [config.nostr_pubkey_hex] : [],
            member_adds: config.nostr_pubkey_hex ? [{ pubkey: config.nostr_pubkey_hex, ts: Date.now() }] : [],
            member_removes: [],
            relay_nostr_id: null,
            relay_key: relayKey, // Internal key
            public_identifier: publicIdentifier, // New public-facing identifier
            relay_storage: defaultStorageDir,
            created_at: new Date().toISOString(),
            auto_connect: true,
            is_active: true,
            isPublic,
            isOpen,
            auth_config: {
                requiresAuth: true,
                tokenProtected: true,
                authorizedUsers: auth_adds, // This will be recalculated by saveRelayProfile
                auth_adds: auth_adds,
                auth_removes: []
            }
        };

        const beforeWriterSnapshot = snapshotWriterMaterial(profileInfo);

        if (selectedWriterInfo?.writerSecret) {
            profileInfo.writer_secret = selectedWriterInfo.writerSecret;
            if (selectedWriterInfo.writerCore) {
                profileInfo.writer_core = selectedWriterInfo.writerCore;
            } else if (selectedWriterInfo.autobaseLocal) {
                profileInfo.writer_core_hex = selectedWriterInfo.autobaseLocal;
            }
        } else if (fallbackWriterInfo?.autobaseLocal) {
            profileInfo.writer_core_hex = fallbackWriterInfo.autobaseLocal;
        }
        if (selectedWriterInfo?.autobaseLocal) {
            profileInfo.autobase_local = selectedWriterInfo.autobaseLocal;
        } else if (fallbackWriterInfo?.autobaseLocal) {
            profileInfo.autobase_local = fallbackWriterInfo.autobaseLocal;
        }

        const afterWriterSnapshot = snapshotWriterMaterial(profileInfo);
        logWriterMaterialChange({
            stage: 'create-relay-profile',
            relayKey,
            before: beforeWriterSnapshot,
            after: afterWriterSnapshot,
            extra: {
                selectedWriter: selectedWriterInfo ? selectedWriterInfo.label : null,
                selectedWriterMeta: selectedWriterInfo
                    ? {
                        writerCore: selectedWriterInfo.writerCore,
                        autobaseLocal: selectedWriterInfo.autobaseLocal,
                        coreKeyHex: selectedWriterInfo.coreKeyHex,
                        signerKeyHex: selectedWriterInfo.signerKeyHex,
                        writerCoreSource: selectedWriterInfo.writerCoreSource,
                        coreMatchesSigner: selectedWriterInfo.coreMatchesSigner
                    }
                    : null,
                fallbackWriter: fallbackWriterInfo ? fallbackWriterInfo.label : null,
                fallbackWriterMeta: fallbackWriterInfo
                    ? {
                        writerCore: fallbackWriterInfo.writerCore,
                        autobaseLocal: fallbackWriterInfo.autobaseLocal,
                        coreKeyHex: fallbackWriterInfo.coreKeyHex,
                        signerKeyHex: fallbackWriterInfo.signerKeyHex,
                        writerCoreSource: fallbackWriterInfo.writerCoreSource,
                        coreMatchesSigner: fallbackWriterInfo.coreMatchesSigner
                    }
                    : null,
                extractedLocalWriter: snapshotWriterMaterial(localWriterInfo),
                extractedLocalWriterMeta: localWriterInfo
                    ? {
                        coreKeyHex: localWriterInfo.coreKeyHex,
                        signerKeyHex: localWriterInfo.signerKeyHex,
                        writerCoreSource: localWriterInfo.writerCoreSource,
                        coreMatchesSigner: localWriterInfo.coreMatchesSigner
                    }
                    : null
            }
        });

        if (!selectedWriterInfo?.writerSecret) {
            console.warn('[RelayAdapter] Writer material not persisted (invalid or missing); relying on recovery', {
                relayKey,
                selectedWriter: selectedWriterInfo ? selectedWriterInfo.label : null,
                fallbackWriter: fallbackWriterInfo ? fallbackWriterInfo.label : null
            });
        }
        
        // Save relay profile
        const saved = await saveRelayProfile(profileInfo);
        if (!saved) {
            console.log('[RelayAdapter] Warning: Failed to save relay profile');
        }

        // Import auth data to the auth store
        if (authToken && config.nostr_pubkey_hex) {
            const { getRelayAuthStore } = await import('./relay-auth-store.mjs');
            const authStore = getRelayAuthStore();
            
            authStore.addAuth(relayKey, config.nostr_pubkey_hex, authToken);
            if (publicIdentifier) {
                authStore.addAuth(publicIdentifier, config.nostr_pubkey_hex, authToken);
            }
            
            console.log('[RelayAdapter] Added auth token to auth store');
        }

        // Load members into in-memory map
        setRelayMembers(relayKey, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        if (publicIdentifier) {
            setRelayMembers(publicIdentifier, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        }
        
        console.log('[RelayAdapter] Created relay:', relayKey);
        const gatewayBase = buildGatewayWebsocketBase(config);
        console.log(`[RelayAdapter] Connect at: ${gatewayBase}/${relayKey}`);
        
        // Build the authenticated relay URL
        const identifierPath = publicIdentifier ? 
            publicIdentifier.replace(':', '/') : 
            relayKey;
        const baseUrl = `${gatewayBase}/${identifierPath}`;
        const authenticatedUrl = authToken ? `${baseUrl}?token=${authToken}` : baseUrl;
        
        // Send relay initialized message for newly created relay
        if (global.sendMessage) {
            console.log(`[RelayAdapter] createRelay() -> Sending relay-initialized for ${relayKey} with URL ${authenticatedUrl}`);
            global.sendMessage({
                type: 'relay-initialized',
                relayKey: relayKey, // Internal key for worker
                publicIdentifier: publicIdentifier, // Public identifier for external use
                gatewayUrl: authenticatedUrl,
                name: profileInfo.name,
                isNew: true,
                timestamp: new Date().toISOString()
            });
        }
        
        return {
            success: true,
            relayKey,
            publicIdentifier,
            connectionUrl: baseUrl, // Base URL without token
            authToken: authToken, // Return the token separately
            relayUrl: authenticatedUrl, // Full authenticated URL
            profile: profileInfo,
            storageDir: defaultStorageDir
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error creating relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Helper function to generate public identifier
function generatePublicIdentifier(npub, relayName) {
    const camelCaseName = relayName
        .split(' ')
        .map((word, index) => {
            if (index === 0) {
                return word.toLowerCase();
            }
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join('');
    
    return `${npub}:${camelCaseName}`;
}

function emitRelayLoadingEvent({ relayKey, publicIdentifier = null, name = '' }, stage = 'connecting', extra = {}) {
    if (!global.sendMessage) return;
    try {
        const payload = {
            type: 'relay-loading',
            relayKey,
            publicIdentifier,
            name,
            stage,
            timestamp: new Date().toISOString()
        };
        if (typeof extra.totalRelays === 'number') {
            payload.total = extra.totalRelays;
        }
        if (typeof extra.count === 'number') {
            payload.count = extra.count;
        }
        global.sendMessage({
            ...payload
        });
    } catch (error) {
        console.warn('[RelayAdapter] Failed to emit relay-loading event:', error?.message || error);
    }
}

/**
 * Join an existing relay
 * @param {Object} options - Join options
 * @param {string} options.relayKey - The relay key to join
 * @param {string} options.name - Optional name for the relay
 * @param {string} options.description - Optional description
 * @param {string} options.storageDir - Optional storage directory
 * @param {Object} options.config - Configuration object
 * @param {boolean} options.fromAutoConnect - Whether called from auto-connect
 * @returns {Promise<Object>} - Result object with relay information
 */
export async function joinRelay(options = {}) {
    const {
        relayKey,
        name,
        description,
        publicIdentifier,
        authToken = null,
        storageDir,
        config,
        fromAutoConnect = false,
        writerSecret = null,
        writerCore = null,
        expectedWriterKey: expectedWriterOverride = null,
        blindPeer = null,
        coreRefs = null,
        suppressInitMessage = false,
        useSharedCorestore = false,
        corestore = null
    } = options;
    
    // Store config globally if provided
    if (config) {
        globalConfig = config;
        globalUserKey = config.userKey;
    }
    
    if (!relayKey) {
        return {
            success: false,
            error: 'Relay key is required'
        };
    }

    let writerKeyPair = null;
    let expectedWriterKey = null;
    let expectedWriterHex = null;
    if (writerSecret) {
        try {
            const secretKey = Buffer.from(String(writerSecret), 'hex');
            if (writerCore) {
                try {
                    expectedWriterKey = HypercoreId.decode(String(writerCore));
                } catch {
                    if (/^[0-9a-fA-F]{64}$/.test(String(writerCore))) {
                        expectedWriterKey = Buffer.from(String(writerCore), 'hex');
                    }
                }
            }
            if (expectedWriterKey) {
                expectedWriterHex = b4a.toString(expectedWriterKey, 'hex');
                console.log('[RelayAdapter] Invite writer core decoded', {
                    relayKey,
                    writerCore: String(writerCore).slice(0, 16),
                    expectedWriterHex: expectedWriterHex.slice(0, 16),
                    expectedLen: expectedWriterKey.length
                });
            }

            const seedCandidates = [];
            if (secretKey.length >= 32) seedCandidates.push(secretKey.subarray(0, 32));
            if (secretKey.length === 64 && expectedWriterKey) {
                const secretTail = secretKey.subarray(32, 64);
                const tailMatches = b4a.equals(secretTail, expectedWriterKey);
                console.log('[RelayAdapter] Invite writer secret inspection', {
                    relayKey,
                    secretLen: secretKey.length,
                    tailMatchesCore: tailMatches,
                    expectedWriterHex: expectedWriterHex?.slice(0, 16) || null
                });
            }

            let derivedPair = null;
            for (const seed of seedCandidates) {
                try {
                    const candidate = hypercoreCrypto.keyPair(seed);
                    if (!candidate?.publicKey || !candidate?.secretKey) continue;
                    if (expectedWriterKey && !b4a.equals(candidate.publicKey, expectedWriterKey)) {
                        console.warn('[RelayAdapter] Invite writer keypair mismatch with provided writerCore; retrying with alternate seed');
                        continue;
                    }
                    derivedPair = { publicKey: candidate.publicKey, secretKey: candidate.secretKey };
                    break;
                } catch (err) {
                    // try next seed form
                }
            }

            if (!derivedPair && expectedWriterKey && secretKey.length === 64) {
                const candidate = { publicKey: expectedWriterKey, secretKey };
                if (hypercoreCrypto.validateKeyPair(candidate)) {
                    derivedPair = candidate;
                    console.warn('[RelayAdapter] Using invite secretKey directly (validated against writerCore)');
                } else {
                    console.warn('[RelayAdapter] Invite writer secretKey does not validate against writerCore; skipping keyPair injection');
                }
            }

            if (derivedPair) {
                writerKeyPair = derivedPair;
                console.log('[RelayAdapter] Decoded invite writer keypair for relay', {
                    relayKey,
                    hasExpectedCore: !!expectedWriterKey,
                    secretLen: secretKey.length,
                    derivedPublicHex: b4a.toString(derivedPair.publicKey, 'hex').slice(0, 16),
                    expectedWriterHex: expectedWriterHex?.slice(0, 16) || null
                });
            } else {
                console.warn('[RelayAdapter] Provided writerSecret but failed to decode/derive writerCore/publicKey; skipping keyPair injection');
            }
        } catch (err) {
            console.warn('[RelayAdapter] Failed to build writer keyPair from invite', err?.message || err);
        }
    } else {
        console.log('[RelayAdapter] No writerSecret supplied for joinRelay', { relayKey, publicIdentifier });
    }

    if (!expectedWriterKey && expectedWriterOverride) {
        const decodedExpected = decodeWriterKey(expectedWriterOverride);
        if (decodedExpected) {
            expectedWriterKey = decodedExpected;
            expectedWriterHex = b4a.toString(expectedWriterKey, 'hex');
            console.log('[RelayAdapter] Using stored expected writer key', {
                relayKey,
                expectedWriterHex: expectedWriterHex.slice(0, 16)
            });
        } else {
            console.warn('[RelayAdapter] Failed to decode stored expected writer key', {
                relayKey
            });
        }
    }

    try {
        await ensureProfilesInitialized(globalUserKey);
        
        // Check if already connected
        if (activeRelays.has(relayKey)) {
            console.log(`[RelayAdapter] Already connected to relay ${relayKey}`);

            // Load profile to determine auth token
            let userAuthToken = null;
            let profileInfo = await getRelayProfileByKey(relayKey);
            if (profileInfo?.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                const userAuth = profileInfo.auth_config.authorizedUsers.find(
                    u => u.pubkey === config.nostr_pubkey_hex
                );
                userAuthToken = userAuth?.token || null;
            }

            if (authToken) {
                userAuthToken = authToken;
            }

            const identifierPath = profileInfo?.public_identifier ?
                profileInfo.public_identifier.replace(':', '/') :
                relayKey;
            const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
            const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;

            // Still send initialized message since the UI might be waiting
            if (global.sendMessage && !suppressInitMessage) {
                console.log(`[RelayAdapter] [1] joinRelay() ->Sending relay-initialized for ${relayKey} with URL ${connectionUrl}`);
                global.sendMessage({
                    type: 'relay-initialized',
                    relayKey: relayKey,
                    publicIdentifier: profileInfo?.public_identifier,
                    gatewayUrl: connectionUrl,
                    connectionUrl,
                    alreadyActive: true,
                    requiresAuth: profileInfo?.auth_config?.requiresAuth || false,
                    userAuthToken: userAuthToken,
                    timestamp: new Date().toISOString()
                });
            } else if (global.sendMessage && suppressInitMessage) {
                console.log('[RelayAdapter] Suppressing relay-initialized (already active)', {
                    relayKey
                });
            }
            
            return {
                success: false,
                error: 'Already connected to this relay'
            };
        }
        
        // Set default storage directory
        const defaultStorageDir = storageDir || join(config.storage || './data', 'relays', relayKey);
        
        // Ensure storage directory exists
        await fs.mkdir(defaultStorageDir, { recursive: true });

        let relayCorestore = corestore;
        if (!relayCorestore && useSharedCorestore) {
            relayCorestore = getRelayCorestore(relayKey, { storageBase: config?.storage || null });
        }
        if (relayCorestore) {
            console.log('[RelayAdapter] Using shared corestore for relay', {
                relayKey,
                storageDir: defaultStorageDir,
                corestoreId: relayCorestore.__ht_id || null,
                corestorePath: relayCorestore.__ht_storage_path || null
            });
        } else {
            console.log('[RelayAdapter] Using relay-local corestore', {
                relayKey,
                storageDir: defaultStorageDir
            });
        }
        
        // Create relay manager instance
        if (writerKeyPair) {
            console.log('[RelayAdapter] Using invite-provided writer keypair for relay', relayKey);
        }

        const relayManager = new RelayManager(defaultStorageDir, relayKey, {
            keyPair: writerKeyPair,
            expectedWriterKey,
            corestore: relayCorestore
        });
        await relayManager.initialize();
        
        activeRelays.set(relayKey, relayManager);
        
        // Check if profile already exists
        let profileInfo = await getRelayProfileByKey(relayKey);
        
        if (!profileInfo) {
            // Create new profile
            profileInfo = {
                name: name || `Joined Relay ${relayKey.substring(0, 8)}`,
                description: description || `Relay joined on ${new Date().toLocaleString()}`,
                nostr_pubkey_hex: config.nostr_pubkey_hex || generateHexKey(),
                admin_pubkey: config.nostr_pubkey_hex || null,
                members: config.nostr_pubkey_hex ? [config.nostr_pubkey_hex] : [],
                member_adds: config.nostr_pubkey_hex ? [{ pubkey: config.nostr_pubkey_hex, ts: Date.now() }] : [],
                member_removes: [],
                relay_nostr_id: null,
                relay_key: relayKey,
                public_identifier: publicIdentifier || null,
                relay_storage: defaultStorageDir,
                joined_at: new Date().toISOString(),
                auto_connect: true,
                is_active: true
            };

            profileInfo = applyJoinMetadata(profileInfo, {
                writerSecret,
                writerCore,
                expectedWriterKey,
                relayManager,
                blindPeer,
                coreRefs
            });
            console.log('[RelayAdapter] Stored join metadata for new relay profile', {
                relayKey,
                hasWriterSecret: !!writerSecret,
                hasWriterCore: !!writerCore,
                hasBlindPeer: !!blindPeer,
                coreRefsCount: Array.isArray(coreRefs) ? coreRefs.length : 0,
                autobaseLocal: profileInfo.autobase_local ? profileInfo.autobase_local.slice(0, 16) : null
            });

            await saveRelayProfile(profileInfo);
        } else {
            // Update existing profile
            profileInfo.relay_storage = defaultStorageDir;
            profileInfo.last_joined_at = new Date().toISOString();
            profileInfo.is_active = true;
            if (name) profileInfo.name = name;
            if (description) profileInfo.description = description;
            if (publicIdentifier && !profileInfo.public_identifier) {
                profileInfo.public_identifier = publicIdentifier;
            }

            profileInfo = applyJoinMetadata(profileInfo, {
                writerSecret,
                writerCore,
                expectedWriterKey,
                relayManager,
                blindPeer,
                coreRefs
            });
            console.log('[RelayAdapter] Stored join metadata for existing relay profile', {
                relayKey,
                hasWriterSecret: !!writerSecret,
                hasWriterCore: !!writerCore,
                hasBlindPeer: !!blindPeer,
                coreRefsCount: Array.isArray(coreRefs) ? coreRefs.length : 0,
                autobaseLocal: profileInfo.autobase_local ? profileInfo.autobase_local.slice(0, 16) : null
            });

            await saveRelayProfile(profileInfo);
        }

        // Load members into in-memory map
        setRelayMembers(relayKey, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        if (profileInfo.public_identifier) {
            setRelayMembers(profileInfo.public_identifier, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        }
        
        const postJoinCoreRefs = normalizeCoreRefs(profileInfo.core_refs || profileInfo.coreRefs);
        let postJoinSync = null;
        if (typeof global.syncActiveRelayCoreRefs === 'function' && postJoinCoreRefs.length) {
            try {
                postJoinSync = await global.syncActiveRelayCoreRefs({
                    relayKey,
                    publicIdentifier: profileInfo.public_identifier || publicIdentifier,
                    coreRefs: postJoinCoreRefs,
                    reason: 'post-join'
                });
            } catch (error) {
                console.warn('[RelayAdapter] Post-join writer sync failed', {
                    relayKey,
                    error: error?.message || error
                });
            }
        }

        const writerSample = collectActiveWriterSample(relayManager);
        const activeWriters = relayManager?.relay?.activeWriters;
        const writerCount = typeof activeWriters?.size === 'number'
            ? activeWriters.size
            : Array.isArray(activeWriters)
                ? activeWriters.length
                : null;
        console.log('[RelayAdapter] Writer set before subscriptions', {
            relayKey,
            writerCount,
            writerSample,
            coreRefsCount: postJoinCoreRefs.length,
            writerSyncStatus: postJoinSync?.writerSummary?.status ?? null,
            writerAdded: postJoinSync?.writerSummary?.added ?? 0
        });

        if (postJoinSync?.writerSummary?.added > 0 && typeof global.requestRelaySubscriptionRefresh === 'function') {
            try {
                const refreshSummary = await global.requestRelaySubscriptionRefresh({
                    relayKey,
                    reason: 'post-join-writer-sync'
                });
                console.log('[RelayAdapter] Subscription refresh scheduled', {
                    relayKey,
                    status: refreshSummary?.status ?? null,
                    updated: refreshSummary?.updated ?? null,
                    failed: refreshSummary?.failed ?? null
                });
            } catch (error) {
                console.warn('[RelayAdapter] Subscription refresh failed', {
                    relayKey,
                    error: error?.message || error
                });
            }
        }

        console.log('[RelayAdapter] Joined relay:', relayKey);
        
        // Send relay initialized message for joined relay ONLY if not from auto-connect
        if (!fromAutoConnect && global.sendMessage && !suppressInitMessage) {
            const identifierPath = profileInfo.public_identifier ? profileInfo.public_identifier.replace(':', '/') : relayKey;
            const gatewayBase = buildGatewayWebsocketBase(config);
            const baseGw = `${gatewayBase}/${identifierPath}`;
            const gw = authToken ? `${baseGw}?token=${authToken}` : baseGw;
            console.log(`[RelayAdapter] [3] joinRelay -> Sending relay-initialized for ${relayKey} with URL ${gw}`);
            global.sendMessage({
                type: 'relay-initialized',
                relayKey: relayKey,
                publicIdentifier: profileInfo.public_identifier,
                gatewayUrl: gw,
                name: profileInfo.name,
                connectionUrl: gw,
                isJoined: true,
                timestamp: new Date().toISOString()
            });
        } else if (!fromAutoConnect && global.sendMessage && suppressInitMessage) {
            console.log('[RelayAdapter] Suppressing relay-initialized (join flow)', {
                relayKey,
                publicIdentifier: profileInfo.public_identifier || null
            });
        }
        
        const identifierPathReturn = profileInfo.public_identifier ? profileInfo.public_identifier.replace(':', '/') : relayKey;
        const gatewayBaseReturn = buildGatewayWebsocketBase(config);
        const returnBase = `${gatewayBaseReturn}/${identifierPathReturn}`;
        return {
            success: true,
            relayKey,
            publicIdentifier: profileInfo.public_identifier || null,
            connectionUrl: authToken ? `${returnBase}?token=${authToken}` : returnBase,
            profile: profileInfo,
            storageDir: defaultStorageDir
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error joining relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Disconnect from a relay
 * @param {string} relayKey - The relay key to disconnect from
 * @returns {Promise<Object>} - Result object
 */
export async function disconnectRelay(relayKey) {
    if (!relayKey) {
        return {
            success: false,
            error: 'Relay key is required'
        };
    }
    
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        return {
            success: false,
            error: 'Relay not active'
        };
    }
    
    try {
        await ensureProfilesInitialized();
        
        // Close the relay
        await relayManager.close();
        activeRelays.delete(relayKey);
        
        // Update profile
        relayMembers.delete(relayKey);
        const profileInfo = await getRelayProfileByKey(relayKey);
        if (profileInfo && profileInfo.public_identifier) {
            relayMembers.delete(profileInfo.public_identifier);
        }
        // Update profile
        if (profileInfo) {
            profileInfo.last_disconnected_at = new Date().toISOString();
            profileInfo.is_active = false;
            await saveRelayProfile(profileInfo);
        }
        
        console.log('[RelayAdapter] Disconnected from relay:', relayKey);
        
        return {
            success: true,
            message: `Disconnected from relay ${relayKey}`
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error disconnecting relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get all relay profiles
 * @returns {Promise<Array>} - Array of relay profiles
 */
export async function getRelayProfiles() {
    await ensureProfilesInitialized(globalUserKey);
    return getAllRelayProfiles(globalUserKey);
}

/**
 * Auto-connect to stored relays
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} - Array of connected relay keys
 */
export async function autoConnectStoredRelays(config) {
    try {
        // Extract user key from config
        const userKey = config.userKey;
        await ensureProfilesInitialized(userKey);
        
        console.log('[RelayAdapter] Starting auto-connection to stored relays for user:', userKey);
        
        const relayProfiles = await getAllRelayProfiles(userKey);
        if (!relayProfiles || relayProfiles.length === 0) {
            console.log('[RelayAdapter] No stored relay profiles found');
            
            // Notify that there are no relays to initialize
            if (global.sendMessage) {
                global.sendMessage({
                    type: 'all-relays-initialized',
                    count: 0,
                    message: 'No stored relays to initialize'
                });
            }
            return [];
        }
        
        console.log(`[RelayAdapter] Found ${relayProfiles.length} stored relay profiles`);
        
        // Import auth store for loading auth configurations
        const { getRelayAuthStore } = await import('./relay-auth-store.mjs');
        const authStore = getRelayAuthStore();

        if (global.sendMessage) {
            try {
                global.sendMessage({
                    type: 'relay-loading',
                    stage: 'relay-count',
                    total: relayProfiles.length,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.warn('[RelayAdapter] Failed to emit relay-count event:', error?.message || error);
            }
        }

        const connectedRelays = [];
        const failedRelays = [];

        const connectTasks = relayProfiles.map((profile) =>
            connectStoredRelayProfile(profile, config, authStore, { totalRelays: relayProfiles.length })
        );

        const settledResults = await Promise.allSettled(connectTasks);

        for (const outcome of settledResults) {
            if (outcome.status === 'fulfilled') {
                const info = outcome.value || {};
                if (info.success) {
                    if (info.relayKey) {
                        connectedRelays.push(info.relayKey);
                    }
                } else if (info.skipped) {
                    console.log(`[RelayAdapter] Auto-connect skipped for ${info.relayKey}: ${info.reason || 'auto-connect disabled'}`);
                } else if (info.relayKey) {
                    failedRelays.push({
                        relayKey: info.relayKey,
                        error: info.error || 'Unknown error'
                    });
                }
            } else {
                const reason = outcome.reason || {};
                failedRelays.push({
                    relayKey: reason.relayKey || null,
                    error: reason.error || reason.message || String(reason)
                });
            }
        }

        console.log(`[RelayAdapter] Auto-connection complete:`);
        console.log(`[RelayAdapter] - Connected: ${connectedRelays.length} relays`);
        console.log(`[RelayAdapter] - Failed: ${failedRelays.length} relays`);

        const authProtectedCount = relayProfiles.filter(p => p.auth_config?.requiresAuth).length;
        console.log(`[RelayAdapter] - Auth-protected: ${authProtectedCount} relays`);

        if (global.sendMessage) {
            global.sendMessage({
                type: 'all-relays-initialized',
                count: connectedRelays.length,
                connected: connectedRelays,
                failed: failedRelays,
                total: relayProfiles.length,
                authProtectedCount,
                timestamp: new Date().toISOString()
            });
        }

        return connectedRelays;
        
    } catch (error) {
        console.error('[RelayAdapter] Error during auto-connection:', error);
        
        // Send error message
        if (global.sendMessage) {
            global.sendMessage({
                type: 'relay-auto-connect-error',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        
        return [];
    }
}

async function connectStoredRelayProfile(profile, config, authStore, options = {}) {
    const relayKey = profile?.relay_key;
    if (!relayKey) {
        return { success: false, relayKey: null, error: 'Missing relay key' };
    }

    const publicIdentifier = profile.public_identifier || null;
    const displayName = profile.name || `Relay ${relayKey.substring(0, 8)}`;
    const isAlreadyActive = activeRelays.has(relayKey);

    emitRelayLoadingEvent({
        relayKey,
        publicIdentifier,
        name: displayName
    }, isAlreadyActive ? 'already-active' : 'connecting', options);

    try {
        if (isAlreadyActive) {
            console.log(`[RelayAdapter] Relay ${relayKey} already active, syncing metadata`);

            if (profile.auth_config && profile.auth_config.requiresAuth) {
                const authData = {};
                const authorizedUsers = calculateAuthorizedUsers(
                    profile.auth_config.auth_adds || [],
                    profile.auth_config.auth_removes || []
                );
                authorizedUsers.forEach(user => {
                    authData[user.pubkey] = {
                        token: user.token,
                        createdAt: Date.now(),
                        lastUsed: Date.now()
                    };
                });

                authStore.importRelayAuth(relayKey, authData);

                const canonicalPublicIdentifier = publicIdentifier ? normalizeRelayIdentifier(publicIdentifier) : null;
                if (canonicalPublicIdentifier) {
                    authStore.importRelayAuth(canonicalPublicIdentifier, authData);
                }
            }

            let userAuthToken = null;
            if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                const authorizedUsers = calculateAuthorizedUsers(
                    profile.auth_config.auth_adds || [],
                    profile.auth_config.auth_removes || []
                );
                const userAuth = authorizedUsers.find(u => u.pubkey === config.nostr_pubkey_hex);
                userAuthToken = userAuth?.token || null;
            }

            const identifierPath = publicIdentifier ? publicIdentifier.replace(':', '/') : relayKey;
            const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
            const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;

            if (global.sendMessage) {
                global.sendMessage({
                    type: 'relay-initialized',
                    relayKey,
                    publicIdentifier,
                    gatewayUrl: connectionUrl,
                    name: profile.name,
                    connectionUrl,
                    alreadyActive: true,
                    requiresAuth: profile.auth_config?.requiresAuth || false,
                    userAuthToken,
                    timestamp: new Date().toISOString()
                });
            }

            return { success: true, relayKey, alreadyActive: true };
        }

        if (profile.auto_connect === false) {
            emitRelayLoadingEvent({ relayKey, publicIdentifier, name: displayName }, 'skipped', options);
            return {
                success: false,
                relayKey,
                skipped: true,
                reason: 'auto-connect-disabled'
            };
        }

        if (profile.auth_config && profile.auth_config.requiresAuth) {
            console.log(`[RelayAdapter] Loading auth configuration for relay ${relayKey}`);

            const authorizedUsers = calculateAuthorizedUsers(
                profile.auth_config.auth_adds || [],
                profile.auth_config.auth_removes || []
            );
            const authData = {};
            authorizedUsers.forEach(user => {
                authData[user.pubkey] = {
                    token: user.token,
                    createdAt: Date.now(),
                    lastUsed: Date.now()
                };
            });

            authStore.importRelayAuth(relayKey, authData);

            const canonicalPublicIdentifier = publicIdentifier ? normalizeRelayIdentifier(publicIdentifier) : null;
            if (canonicalPublicIdentifier) {
                authStore.importRelayAuth(canonicalPublicIdentifier, authData);
            }
        }

        setRelayMembers(
            relayKey,
            profile.members || [],
            profile.member_adds || [],
            profile.member_removes || []
        );

        if (publicIdentifier) {
            setRelayMembers(
                publicIdentifier,
                profile.members || [],
                profile.member_adds || [],
                profile.member_removes || []
            );
        }

        let storedWriterSecret = profile.writer_secret || profile.writerSecret || null;
        let storedWriterCore =
            profile.writer_core ||
            profile.writerCore ||
            profile.writer_core_hex ||
            profile.autobase_local ||
            null;
        let storedExpectedWriter =
            profile.autobase_local ||
            profile.writer_core_hex ||
            profile.writer_core ||
            null;
        let storedBlindPeer = profile.blind_peer || profile.blindPeer || null;
        const initialCoreRefs = normalizeCoreRefs(profile.core_refs || profile.coreRefs);

        const expectedWriterKey = decodeWriterKey(storedWriterCore || storedExpectedWriter || null);
        let storedWriterValid = false;
        let storedWriterInvalid = false;
        if (storedWriterSecret) {
            storedWriterValid = validateWriterSecret(storedWriterSecret, {
                expectedWriterKey,
                writerCore: storedWriterCore || storedExpectedWriter || null
            }).valid;
            if (!storedWriterValid) {
                const beforeWriterSnapshot = snapshotWriterMaterial(profile);
                const afterWriterSnapshot = {
                    ...beforeWriterSnapshot,
                    writer_secret: null
                };
                logWriterMaterialChange({
                    stage: 'auto-connect-invalid-stored-writer',
                    relayKey,
                    before: beforeWriterSnapshot,
                    after: afterWriterSnapshot,
                    extra: {
                        expectedWriterKey: expectedWriterKey ? b4a.toString(expectedWriterKey, 'hex') : null
                    }
                });
                console.warn('[RelayAdapter] Stored writer secret invalid; discarding before auto-connect', {
                    relayKey
                });
                storedWriterInvalid = true;
                storedWriterSecret = null;
            }
        }

        let recoveredCorestore = null;
        if (!storedWriterSecret) {
            const recovered = await recoverLocalWriterMaterial({
                relayKey,
                profile,
                config,
                preferBootstrapLocal: storedWriterInvalid
            });
            if (recovered?.writerSecret) {
                const recoveredValid = validateWriterSecret(recovered.writerSecret, {
                    expectedWriterKey: decodeWriterKey(recovered.writerCore || recovered.autobaseLocal || null)
                }).valid;
                if (recoveredValid) {
                    const beforeWriterSnapshot = snapshotWriterMaterial(profile);
                    storedWriterSecret = recovered.writerSecret;
                    storedWriterCore = recovered.writerCore || recovered.autobaseLocal || storedWriterCore;
                    storedExpectedWriter = recovered.autobaseLocal || storedExpectedWriter;
                    storedWriterValid = true;
                    recoveredCorestore = recovered.source === 'local-storage' ? recovered.corestore : null;

                    const updatedProfile = { ...profile };
                    updatedProfile.writer_secret = recovered.writerSecret;
                    if (recovered.writerCore && recovered.writerCore !== updatedProfile.writer_core) {
                        updatedProfile.writer_core = recovered.writerCore;
                    } else if (recovered.autobaseLocal && !updatedProfile.writer_core_hex) {
                        updatedProfile.writer_core_hex = recovered.autobaseLocal;
                    }
                    if (recovered.autobaseLocal && recovered.autobaseLocal !== updatedProfile.autobase_local) {
                        updatedProfile.autobase_local = recovered.autobaseLocal;
                    }
                    updatedProfile.updated_at = new Date().toISOString();
                    await saveRelayProfile(updatedProfile);
                    profile = updatedProfile;
                    const afterWriterSnapshot = snapshotWriterMaterial(updatedProfile);
                    logWriterMaterialChange({
                        stage: 'auto-connect-recovered-writer',
                        relayKey,
                        before: beforeWriterSnapshot,
                        after: afterWriterSnapshot,
                        extra: {
                            source: recovered.source || null,
                            preferBootstrapLocal: recovered.preferBootstrapLocal,
                            profileAutobaseLocal: recovered.profileAutobaseLocal,
                            recoveredCoreKeyHex: recovered.coreKeyHex || null,
                            recoveredSignerKeyHex: recovered.signerKeyHex || null,
                            recoveredWriterCoreSource: recovered.writerCoreSource || null,
                            recoveredCoreMatchesSigner: recovered.coreMatchesSigner,
                            usedLegacyWriterCore: recovered.usedLegacyWriterCore || false
                        }
                    });
                    console.log('[RelayAdapter] Restored local writer secret for auto-connect', {
                        relayKey,
                        writerCore: recovered.writerCore ? recovered.writerCore.slice(0, 16) : null,
                        autobaseLocal: recovered.autobaseLocal ? recovered.autobaseLocal.slice(0, 16) : null,
                        source: recovered.source || null
                    });
                } else {
                    console.warn('[RelayAdapter] Recovered writer secret failed validation; skipping', {
                        relayKey,
                        source: recovered.source || null
                    });
                }
            }
        }

        let mirrorFetchStatus = 'skipped';
        if (typeof global.fetchAndApplyRelayMirrorMetadata === 'function') {
            try {
                const mirrorResult = await global.fetchAndApplyRelayMirrorMetadata({
                    relayKey,
                    publicIdentifier,
                    reason: 'auto-connect'
                });
                mirrorFetchStatus = mirrorResult?.status || 'error';
            } catch (error) {
                mirrorFetchStatus = 'error';
                console.warn('[RelayAdapter] Auto-connect: mirror metadata fetch failed', {
                    relayKey,
                    error: error?.message || error
                });
            }
        }

        if (mirrorFetchStatus === 'ok') {
            const refreshedProfile = await getRelayProfileByKey(relayKey);
            if (refreshedProfile) {
                profile = refreshedProfile;
                storedBlindPeer = profile.blind_peer || profile.blindPeer || storedBlindPeer;
            }
        }

        const storedCoreRefs = normalizeCoreRefs(profile.core_refs || profile.coreRefs);
        let mergedCoreRefs = storedCoreRefs;
        if (typeof global.resolveRelayMirrorCoreRefs === 'function') {
            mergedCoreRefs = await global.resolveRelayMirrorCoreRefs(
                relayKey,
                publicIdentifier,
                storedCoreRefs
            );
        }

        const cachedCoreRefs = typeof global.getRelayMirrorCoreRefsCache === 'function'
            ? await global.getRelayMirrorCoreRefsCache(relayKey)
            : [];
        const allowPrefetch = !!storedBlindPeer
            && (mirrorFetchStatus === 'ok' || cachedCoreRefs.length > 0);

        const prefersLocalCorestore = storedWriterValid && !!profile.relay_storage;
        let relayCorestore = null;
        if (storedBlindPeer) {
            if (prefersLocalCorestore) {
                relayCorestore = recoveredCorestore || createLocalCorestore(profile.relay_storage, relayKey);
            } else {
                relayCorestore = getRelayCorestore(relayKey, { storageBase: config?.storage || null });
            }
        }

        if (storedBlindPeer && mergedCoreRefs.length && allowPrefetch) {
            const manager = global.blindPeeringManager || null;
            if (manager?.started) {
                console.log('[RelayAdapter] Auto-connect: prefetching relay cores from blind-peer mirror', {
                    relayKey,
                    publicIdentifier,
                    coreRefsCount: mergedCoreRefs.length,
                    mirrorKey: storedBlindPeer?.publicKey ? String(storedBlindPeer.publicKey).slice(0, 16) : null,
                    mirrorStatus: mirrorFetchStatus
                });
                if (storedBlindPeer?.publicKey) {
                    manager.markTrustedMirrors([String(storedBlindPeer.publicKey)]);
                }
                manager.ensureRelayMirror({
                    relayKey,
                    publicIdentifier,
                    coreRefs: mergedCoreRefs,
                    corestore: relayCorestore
                });
                await manager.refreshFromBlindPeers('auto-connect');
                if (typeof manager.primeRelayCoreRefs === 'function' && mergedCoreRefs.length) {
                    const primeSummary = await manager.primeRelayCoreRefs({
                        relayKey,
                        publicIdentifier,
                        coreRefs: mergedCoreRefs,
                        timeoutMs: AUTO_CONNECT_REHYDRATION_TIMEOUT_MS,
                        reason: 'auto-connect',
                        corestore: relayCorestore
                    });
                    console.log('[RelayAdapter] Auto-connect: core prefetch completed', {
                        relayKey,
                        status: primeSummary?.status ?? null,
                        synced: primeSummary?.synced ?? null,
                        failed: primeSummary?.failed ?? null,
                        connected: primeSummary?.connected ?? null
                    });
                }
                const rehydrateSummary = await manager.rehydrateMirrors({
                    reason: 'auto-connect',
                    timeoutMs: AUTO_CONNECT_REHYDRATION_TIMEOUT_MS
                });
                console.log('[RelayAdapter] Auto-connect: rehydration completed', {
                    relayKey,
                    status: rehydrateSummary?.status ?? null,
                    synced: rehydrateSummary?.synced ?? null,
                    failed: rehydrateSummary?.failed ?? null
                });
            } else {
                console.warn('[RelayAdapter] Auto-connect: blind-peering manager unavailable; skipping mirror rehydration', {
                    relayKey
                });
            }
        } else if (storedBlindPeer && !allowPrefetch) {
            console.warn('[RelayAdapter] Auto-connect: mirror metadata unavailable; skipping prefetch to avoid shrinking core refs', {
                relayKey,
                publicIdentifier,
                initialCoreRefs: initialCoreRefs.length,
                storedCoreRefs: storedCoreRefs.length,
                mirrorStatus: mirrorFetchStatus
            });
        }

        const joinResult = await joinRelay({
            relayKey,
            name: profile.name,
            description: profile.description,
            storageDir: profile.relay_storage,
            config,
            fromAutoConnect: true,
            writerSecret: storedWriterSecret,
            writerCore: storedWriterCore,
            expectedWriterKey: storedExpectedWriter,
            blindPeer: storedBlindPeer,
            coreRefs: mergedCoreRefs,
            useSharedCorestore: !prefersLocalCorestore && !!relayCorestore,
            corestore: relayCorestore
        });

        if (!joinResult.success) {
            console.error(`[RelayAdapter] Failed to connect to relay ${relayKey}: ${joinResult.error}`);
            if (global.sendMessage) {
                global.sendMessage({
                    type: 'relay-initialization-failed',
                    relayKey,
                    error: joinResult.error,
                    timestamp: new Date().toISOString()
                });
            }
            emitRelayLoadingEvent({ relayKey, publicIdentifier, name: displayName }, 'relay-error', options);
            return {
                success: false,
                relayKey,
                error: joinResult.error
            };
        }

        profile.auto_connected = true;
        profile.last_connected_at = new Date().toISOString();
        await saveRelayProfile(profile);

        let userAuthToken = null;
        if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
            const authorizedUsers = calculateAuthorizedUsers(
                profile.auth_config.auth_adds || [],
                profile.auth_config.auth_removes || []
            );
            const userAuth = authorizedUsers.find(u => u.pubkey === config.nostr_pubkey_hex);
            userAuthToken = userAuth?.token || null;
        }

        const identifierPath = publicIdentifier ? publicIdentifier.replace(':', '/') : relayKey;
        const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
        const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;

        if (global.sendMessage) {
            global.sendMessage({
                type: 'relay-initialized',
                relayKey,
                publicIdentifier,
                gatewayUrl: connectionUrl,
                name: displayName,
                connectionUrl,
                requiresAuth: profile.auth_config?.requiresAuth || false,
                userAuthToken,
                timestamp: new Date().toISOString()
            });
        }

        emitRelayLoadingEvent({ relayKey, publicIdentifier, name: displayName }, 'initialized', options);

        return { success: true, relayKey };
    } catch (error) {
        console.error(`[RelayAdapter] Error auto-connecting to ${relayKey}:`, error);
        if (global.sendMessage) {
            global.sendMessage({
                type: 'relay-initialization-failed',
                relayKey,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        emitRelayLoadingEvent({ relayKey, publicIdentifier, name: displayName }, 'relay-error', { ...options, count: options.totalRelays });
        return {
            success: false,
            relayKey,
            error: error.message
        };
    }
}

/**
 * Handle relay messages
 * @param {string} relayKey - The relay key
 * @param {Array} message - The NOSTR message
 * @param {Function} sendResponse - Response callback
 * @param {string} connectionKey - Connection identifier
 * @returns {Promise<void>}
 */
export async function handleRelayMessage(relayKey, message, sendResponse, connectionKey, clientId = null) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.handleMessage(message, sendResponse, connectionKey, clientId);
}

/**
 * Handle relay subscription
 * @param {string} relayKey - The relay key
 * @param {string} connectionKey - Connection identifier
 * @returns {Promise<Array>}
 */
export async function handleRelaySubscription(relayKey, connectionKey) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.handleSubscription(connectionKey);
}

/**
 * Update relay subscription
 */
export async function updateRelaySubscriptions(relayKey, connectionKey, activeSubscriptionsUpdated) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.updateSubscriptions(connectionKey, activeSubscriptionsUpdated);
  }

export async function getRelaySubscriptions(relayKey, connectionKey) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }

    return relayManager.getSubscriptions(connectionKey);
}

export async function getRelayClientSubscriptions(relayKey, clientId) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }

    return relayManager.getClientSubscriptions(clientId);
}

export async function updateRelayClientSubscriptions(relayKey, clientId, subscriptionObject) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }

    return relayManager.updateClientSubscriptions(clientId, subscriptionObject);
}

export async function rehydrateRelaySubscriptions(relayKey, fromKey, toKey, { clientId = null } = {}) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }

    const existing = await relayManager.getSubscriptions(fromKey);
    if (!existing || !existing.subscriptions) {
      return {
        ok: false,
        reason: 'no-subscriptions',
        subscriptionCount: 0
      };
    }

    const subscriptionCount = Object.keys(existing.subscriptions).length;
    if (subscriptionCount === 0) {
      return {
        ok: false,
        reason: 'empty-subscriptions',
        subscriptionCount
      };
    }

    const updated = {
      ...existing,
      connection: toKey
    };

    const timestamps = Object.values(updated.subscriptions || {})
      .map((subscription) => subscription?.last_returned_event_timestamp)
      .filter((value) => typeof value === 'number');
    const lastReturned = timestamps.length ? Math.max(...timestamps) : null;

    await relayManager.updateSubscriptions(toKey, updated);
    if (clientId) {
      await relayManager.updateClientSubscriptions(clientId, {
        ...updated,
        clientId
      });
    }

    return {
      ok: true,
      subscriptionCount,
      lastReturned
    };
}

/**
 * Get the members list for a relay
 * @param {string} relayKey - Relay key
 * @returns {Promise<Array<string>>} - Array of pubkeys
 */
export async function getRelayMembers(relayKey) {
    await ensureProfilesInitialized(globalUserKey);
    if (relayMembers.has(relayKey)) return relayMembers.get(relayKey);

    const profile = await getRelayProfileByKey(relayKey);
    if (profile) {
        const members = calculateMembers(profile.member_adds || [], profile.member_removes || []);
        setRelayMembers(relayKey, members, profile.member_adds || [], profile.member_removes || []);
        if (profile.public_identifier) {
            setRelayMembers(profile.public_identifier, members, profile.member_adds || [], profile.member_removes || []);
        }
        return members;
    }
    return [];
}

/**
 * Get active relays information with full details
 * @returns {Promise<Array>} - Array of active relay information
 */
export async function getActiveRelays() {
    await ensureProfilesInitialized();
    
    const activeRelayList = [];
    const profiles = await getAllRelayProfiles();
    
    for (const [key, manager] of activeRelays.entries()) {
        // Get peer count if available
        let peerCount = 0;
        if (manager && manager.peers && manager.peers.size) {
            peerCount = manager.peers.size;
        }

        // Find the profile for this relay
        const profile = profiles.find(p => p.relay_key === key);

        const identifierPath = profile?.public_identifier
            ? profile.public_identifier.replace(':', '/')
            : key;

        activeRelayList.push({
            relayKey: key,
            publicIdentifier: profile?.public_identifier || null,
            peerCount,
            name: profile?.name || `Relay ${key.substring(0, 8)}`,
            description: profile?.description || '',
            connectionUrl: `${buildGatewayWebsocketBase(globalConfig || { proxy_server_address: 'localhost', proxy_websocket_protocol: 'wss' })}/${identifierPath}`,
            createdAt: profile?.created_at || profile?.joined_at || null,
            isActive: true,
            isOpen: profile?.isOpen === true,
            isPublic: profile?.isPublic === true
        });
    }
    
    return activeRelayList;
}

/**
 * Cleanup all active relays
 * @returns {Promise<void>}
 */
export async function cleanupRelays() {
    console.log('[RelayAdapter] Cleaning up all active relays...');
    
    for (const [key, manager] of activeRelays.entries()) {
        try {
            await manager.close();
            console.log(`[RelayAdapter] Closed relay: ${key}`);
        } catch (error) {
            console.error(`[RelayAdapter] Error closing relay ${key}:`, error);
        }
    }
    
    activeRelays.clear();
}

// Helper function to generate hex keys
function generateHexKey() {
    return nodeCrypto.randomBytes(32).toString('hex');
}

// Export the active relays map for direct access if needed
export {
    activeRelays,
    relayMembers,
    relayMemberAdds,
    relayMemberRemoves,
    publicToKey,
    keyToPublic,
    virtualRelayKeys
};
