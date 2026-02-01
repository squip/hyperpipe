import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { schnorr } from '@noble/curves/secp256k1';
import HypercoreId from 'hypercore-id-encoding';

import {
  EnhancedHyperswarmPool,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  requestFileFromPeer
} from '../../shared/public-gateway/HyperswarmClient.mjs';
import { computeSecretHash } from '../../shared/public-gateway/GatewayDiscovery.mjs';
import {
  verifySignature,
  verifyClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';
import {
  metricsMiddleware,
  sessionGauge,
  peerGauge,
  requestCounter,
  relayEventCounter,
  relayReqCounter,
  relayErrorCounter,
  relayTokenIssueCounter,
  relayTokenRefreshCounter,
  relayTokenRevocationCounter,
  blindPeerActiveGauge,
  blindPeerTrustedPeersGauge,
  blindPeerBytesGauge,
  blindPeerGcRunsCounter,
  blindPeerEvictionsCounter,
  blindPeerMirrorStateGauge,
  blindPeerMirrorLagGauge
} from './metrics.mjs';
import MemoryRegistrationStore from './stores/MemoryRegistrationStore.mjs';
import MessageQueue from './utils/MessageQueue.mjs';
import GatewayAdvertiser from './discovery/GatewayAdvertiser.mjs';
import HyperbeeRelayHost from './relay/HyperbeeRelayHost.mjs';
import RelayWebsocketController from './relay/RelayWebsocketController.mjs';
import RelayDispatcherService from './relay/RelayDispatcherService.mjs';
import RelayTokenService from './relay/RelayTokenService.mjs';
import PublicGatewayHyperbeeAdapter from '../../shared/public-gateway/PublicGatewayHyperbeeAdapter.mjs';
import { openHyperbeeReplicationChannel } from '../../shared/public-gateway/hyperbeeReplicationChannel.mjs';
import BlindPeerService from './blind-peer/BlindPeerService.mjs';
import BlindPeerReplicaManager from './blind-peer/BlindPeerReplicaManager.mjs';

const DELEGATION_FALLBACK_MS = 1500;
const OPEN_JOIN_APPEND_CORES_PURPOSE = 'append-cores';

function safeString(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

function hexToBytes(hex) {
  if (typeof hex !== 'string') return null;
  const normalized = hex.trim();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-fA-F]/.test(normalized)) {
    return null;
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

class PublicGatewayService {
  constructor({ config, logger, tlsOptions = null, registrationStore }) {
    this.config = config;
    this.logger = logger;
    this.tlsOptions = tlsOptions;
    this.registrationStore = registrationStore || new MemoryRegistrationStore(config.registration?.cacheTtlSeconds);
    this.sharedSecret = config.registration?.sharedSecret || null;
    this.openJoinConfig = this.#normalizeOpenJoinConfig(config?.openJoin);
    this.openJoinChallenges = new Map();
    this.openJoinLeaseLocks = new Set();
    this.discoveryConfig = config.discovery || {};
    this.explicitSharedSecretVersion = this.discoveryConfig?.sharedSecretVersion || null;
    this.sharedSecretVersion = this.explicitSharedSecretVersion;
    this.secretEndpointPath = this.#normalizeSecretPath(this.discoveryConfig?.secretPath);
    this.wsBaseUrl = this.#computeWsBase(this.config.publicBaseUrl);
    this.gatewayAdvertiser = null;
    if (this.discoveryConfig?.enabled && this.discoveryConfig.openAccess && this.sharedSecret) {
      this.gatewayAdvertiser = new GatewayAdvertiser({
        logger: this.logger,
        discoveryConfig: this.discoveryConfig,
        getSharedSecret: async () => this.sharedSecret,
        getSharedSecretVersion: async () => this.#getSharedSecretVersion(),
        getRelayInfo: async () => this.#getRelayHostInfo(),
        publicUrl: this.config.publicBaseUrl,
        wsUrl: this.wsBaseUrl
      });
    } else if (this.discoveryConfig?.enabled && this.discoveryConfig.openAccess && !this.sharedSecret) {
      this.logger?.warn?.('Gateway discovery enabled but shared secret missing; advertisement disabled');
    }

    this.app = express();
    this.server = null;
    this.wss = null;
    this.featureFlags = {
      hyperbeeRelayEnabled: !!config?.features?.hyperbeeRelayEnabled,
      dispatcherEnabled: config?.features?.dispatcherEnabled === undefined
        ? true
        : !!config?.features?.dispatcherEnabled,
      tokenEnforcementEnabled: !!config?.features?.tokenEnforcementEnabled
    };
    this.internalRelayKey = 'public-gateway:hyperbee';
    this.relayConfig = this.#normalizeRelayConfig(config?.relay);
    this.relayCanonicalPath = this.relayConfig?.canonicalPath || this.#toGatewayPath(this.internalRelayKey);
    this.relayPathAliases = Array.isArray(this.relayConfig?.aliasPaths) ? this.relayConfig.aliasPaths : [];
    this.relayAliasMap = this.#buildRelayAliasMap(this.relayPathAliases, this.internalRelayKey);
    this.relayHost = null;
    this.relayTelemetryUnsub = null;
    this.relayWebsocketController = null;
    this.hyperbeeAdapter = null;
    this.internalRegistrationInterval = null;
    this.dispatcher = this.featureFlags.dispatcherEnabled
      ? new RelayDispatcherService({ logger: this.logger, policy: this.config.dispatcher })
      : null;
    this.tokenService = null;
    this.tokenMetrics = {
      issueCounter: relayTokenIssueCounter,
      refreshCounter: relayTokenRefreshCounter,
      revokeCounter: relayTokenRevocationCounter
    };
    this.connectionPool = new EnhancedHyperswarmPool({
      logger: this.logger,
      onProtocol: this.#onProtocolCreated.bind(this),
      onHandshake: this.#onProtocolHandshake.bind(this),
      onTelemetry: this.#handlePeerTelemetry.bind(this),
      onConnectionClosed: this.#onPoolConnectionClosed.bind(this),
      onHealth: this.#onPoolConnectionHealth.bind(this),
      handshakeBuilder: this.#buildHandshakePayload.bind(this)
    });

    this.sessions = new Map();
    this.healthInterval = null;
    this.pruneInterval = null;
    this.eventCheckTimers = new Map();
    this.delegationFallbackTimers = new Map();
    this.relayPeerIndex = new Map();
    this.peerMetadata = new Map();
    this.peerRawPublicKeys = new Map();
    this.peerHyperbeeReplications = new Map();
    this.publicGatewayStatusUpdatedAt = null;
    this.blindPeerService = null;
    this.blindPeerReplicaManager = null;
    this.dispatcherAssignments = new Map();
    this.dispatcherAssignmentTimers = new Map();
    this.dispatcherListeners = [];
    this.blindPeerMetrics = {
      setActive: (active) => {
        blindPeerActiveGauge.set(active ? 1 : 0);
      },
      setTrustedPeers: (count = 0) => {
        const value = Number(count);
        blindPeerTrustedPeersGauge.set(Number.isFinite(value) && value >= 0 ? value : 0);
      },
      setBytesAllocated: (bytes = 0) => {
        const value = Number(bytes);
        blindPeerBytesGauge.set(Number.isFinite(value) && value >= 0 ? value : 0);
      },
      incrementGcRuns: () => {
        blindPeerGcRunsCounter.inc();
      },
      recordEvictions: ({ reason, count = 1 } = {}) => {
        const label = typeof reason === 'string' && reason.trim().length ? reason.trim() : 'unknown';
        const increment = Number.isFinite(count) && count > 0 ? count : 1;
        blindPeerEvictionsCounter.labels(label).inc(increment);
      },
      updateMirrorState: (records = []) => {
        blindPeerMirrorStateGauge.reset();
        blindPeerMirrorLagGauge.reset();
        for (const record of records || []) {
          const identifier = record?.identifier || 'unknown';
          const owner = record?.ownerPeerKey || record?.ownerAlias || 'unknown';
          const type = record?.type || 'unknown';
          const healthy = record?.healthy === false ? 0 : 1;
          blindPeerMirrorStateGauge.labels(identifier, owner, type).set(healthy);
          if (Number.isFinite(record?.lagMs)) {
            blindPeerMirrorLagGauge.labels(identifier, owner, type).set(record.lagMs);
          } else {
            blindPeerMirrorLagGauge.labels(identifier, owner, type).set(0);
          }
        }
      }
    };

    if (this.dispatcher) {
      const assignmentListener = (event) => this.#handleDispatcherAssignment(event);
      const acknowledgeListener = (event) => this.#handleDispatcherAcknowledge(event);
      const failureListener = (event) => this.#handleDispatcherFailure(event);
      this.dispatcherListeners.push({ event: 'assignment', handler: assignmentListener });
      this.dispatcherListeners.push({ event: 'acknowledge', handler: acknowledgeListener });
      this.dispatcherListeners.push({ event: 'failure', handler: failureListener });
      this.dispatcher.on('assignment', assignmentListener);
      this.dispatcher.on('acknowledge', acknowledgeListener);
      this.dispatcher.on('failure', failureListener);
    }
  }

  async init() {
    this.#setupHttpServer();
    await this.connectionPool.initialize();
    if (this.featureFlags.tokenEnforcementEnabled && this.sharedSecret) {
      this.tokenService = new RelayTokenService({
        registrationStore: this.registrationStore,
        sharedSecret: this.sharedSecret,
        logger: this.logger,
        defaultTtlSeconds: this.config.registration?.defaultTokenTtl,
        refreshWindowSeconds: this.config.registration?.tokenRefreshWindowSeconds
      });
    } else if (this.featureFlags.tokenEnforcementEnabled && !this.sharedSecret) {
      this.logger?.warn?.('Token enforcement enabled but shared secret missing; token service disabled');
    }
    if (this.#isHyperbeeRelayEnabled()) {
      await this.#ensureRelayHost();
    }
    if (this.config?.blindPeer) {
      const blindPeerLogger = this.logger?.child
        ? this.logger.child({ module: 'BlindPeerService' })
        : this.logger;
      this.blindPeerService = new BlindPeerService({
        logger: blindPeerLogger,
        config: this.config.blindPeer,
        connectionPool: this.connectionPool,
        metrics: this.blindPeerMetrics
      });
      await this.blindPeerService.initialize();
      await this.#initializeBlindPeerReplicaManager();
    }
    this.logger.info('PublicGatewayService initialized');
  }

  async start() {
    if (!this.server) {
      throw new Error('Service not initialized');
    }

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener('error', reject);
        this.logger.info({ port: this.config.port, host: this.config.host }, 'Public gateway listening');
        resolve();
      });
    });

    if (this.gatewayAdvertiser) {
      try {
        await this.gatewayAdvertiser.start();
      } catch (error) {
        if (this.logger?.error) {
          this.logger.error({ err: error, stack: error?.stack }, 'Failed to start gateway discovery advertiser');
        }
      }
    }

    this.healthInterval = setInterval(() => this.#collectMetrics(), 10000).unref();
    this.pruneInterval = setInterval(() => this.registrationStore.pruneExpired?.(), 60000).unref();

    await this.blindPeerService?.start();
  }

  async stop() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    for (const timer of this.eventCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.eventCheckTimers.clear();

    for (const timer of this.delegationFallbackTimers.values()) {
      clearTimeout(timer);
    }
    this.delegationFallbackTimers.clear();

    this.sessions.clear();
    sessionGauge.set(0);

    if (this.wss) {
      await new Promise((resolve) => this.wss.close(resolve));
      this.wss = null;
    }

    if (this.server) {
      await new Promise((resolve, reject) => this.server.close(err => err ? reject(err) : resolve()));
      this.server = null;
    }

    if (this.gatewayAdvertiser) {
      await this.gatewayAdvertiser.stop();
    }

    if (this.relayHost) {
      try {
        await this.relayHost.stop();
      } catch (error) {
        this.logger?.error?.('Failed to stop Hyperbee relay host', { error: error?.message });
      }
      if (this.relayTelemetryUnsub) {
        this.relayTelemetryUnsub();
        this.relayTelemetryUnsub = null;
      }
      this.relayHost = null;
      this.relayWebsocketController = null;
    }

    if (this.internalRegistrationInterval) {
      clearInterval(this.internalRegistrationInterval);
      this.internalRegistrationInterval = null;
    }

    await this.blindPeerService?.stop();
    await this.blindPeerReplicaManager?.stop();
    this.blindPeerReplicaManager = null;

    for (const timer of this.dispatcherAssignmentTimers.values()) {
      clearTimeout(timer);
    }
    this.dispatcherAssignmentTimers.clear();
    this.dispatcherAssignments.clear();

    if (Array.isArray(this.dispatcherListeners) && this.dispatcher) {
      for (const listener of this.dispatcherListeners) {
        this.dispatcher.off(listener.event, listener.handler);
      }
    }
    this.dispatcherListeners = [];

    this.peerRawPublicKeys.clear();
    this.peerMetadata.clear();

    await this.connectionPool.destroy();
    await this.registrationStore?.disconnect?.();
  }

  #setupHttpServer() {
    const app = this.app;
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }
      return next();
    });
    app.use(helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));
    app.use(express.json({ limit: '256kb' }));

    if (this.config.rateLimit?.enabled) {
      app.use(rateLimit({
        windowMs: this.config.rateLimit.windowSeconds * 1000,
        limit: this.config.rateLimit.maxRequests
      }));
    }

    if (this.config.metrics?.enabled) {
      app.use(metricsMiddleware(this.config.metrics.path));
    }

    app.get('/api/blind-peer', (req, res) => this.#handleBlindPeerStatus(req, res));
    app.get('/api/blind-peer/replicas', (req, res) => this.#handleBlindPeerReplicas(req, res));
    app.post('/api/blind-peer/gc', (req, res) => this.#handleBlindPeerGc(req, res));
    app.delete('/api/blind-peer/mirrors/:key', (req, res) => this.#handleBlindPeerDelete(req, res));

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    if (this.#shouldExposeSecretEndpoint()) {
      app.get(this.secretEndpointPath, (req, res) => this.#handleSecretRequest(req, res));
    }

    app.get('/drive/:identifier/:file', async (req, res) => {
      const { identifier, file } = req.params;
      try {
        const target = await this.#resolveRelayTarget(identifier);
        if (!target) {
          this.logger.warn?.({ identifier, file }, 'Drive request for unknown relay identifier');
          return res.status(404).json({ error: 'Relay not registered with gateway' });
        }

        const streamResult = await this.#withRelayPeerKey(target.relayKey, async (peerKey) => {
          const peer = { publicKey: peerKey };
          const result = await requestFileFromPeer(peer, target.driveIdentifier, file, this.connectionPool);

          if (!result) {
            const err = new Error('Peer returned empty response');
            err.statusCode = 502;
            err.peerKey = peerKey;
            throw err;
          }

          const status = Number.isInteger(result.statusCode) ? result.statusCode : 200;
          if (status >= 400) {
            const err = new Error(`Peer responded with status ${status}`);
            err.statusCode = status;
            err.peerKey = peerKey;
            throw err;
          }

          return { peerKey, stream: result };
        });

        const { stream: bodyStream, peerKey } = streamResult;
        if (!bodyStream) {
          this.logger.warn?.({ identifier, file, peerKey }, 'Peer returned empty stream for drive request');
          return res.status(404).json({ error: 'File not found' });
        }

        Object.entries(bodyStream.headers || {}).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        });

        const statusCode = Number.isInteger(bodyStream.statusCode) ? bodyStream.statusCode : 200;
        res.status(statusCode);
        bodyStream.pipe(res);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        this.logger.error?.({
          identifier,
          file,
          statusCode,
          error: error?.message || error
        }, 'Drive request failed');
        if (!res.headersSent) {
          res.status(statusCode).json({ error: error?.message || 'Unable to fetch file' });
        } else {
          res.end();
        }
      }
    });

    app.post('/api/relays', (req, res) => this.#handleRelayRegistration(req, res));
    app.delete('/api/relays/:relayKey', (req, res) => this.#handleRelayDeletion(req, res));
    app.get('/api/relays/:relayKey/mirror', (req, res) => this.#handleRelayMirrorMetadata(req, res));
    app.post('/api/relays/:relayKey/open-join/pool', (req, res) => this.#handleOpenJoinPoolUpdate(req, res));
    app.get('/api/relays/:relayKey/open-join/challenge', (req, res) => this.#handleOpenJoinChallenge(req, res));
    app.post('/api/relays/:relayKey/open-join', (req, res) => this.#handleOpenJoinRequest(req, res));
    app.post('/api/relays/:relayKey/open-join/append-cores', (req, res) => this.#handleOpenJoinAppendCores(req, res));

    app.post('/api/relay-tokens/issue', (req, res) => this.#handleTokenIssue(req, res));
    app.post('/api/relay-tokens/refresh', (req, res) => this.#handleTokenRefresh(req, res));
    app.post('/api/relay-tokens/revoke', (req, res) => this.#handleTokenRevoke(req, res));

    const serverFactory = this.tlsOptions ? https.createServer : http.createServer;
    this.server = serverFactory(this.tlsOptions || {}, app);

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.#handleWebSocket(ws, req));
  }

  async #initializeBlindPeerReplicaManager() {
    if (!this.blindPeerService) return;
    if (this.blindPeerReplicaManager) {
      await this.blindPeerReplicaManager.stop();
    }
    const replicaConfig = this.config?.blindPeer?.replica || {};
    const replicaLogger = this.logger?.child
      ? this.logger.child({ module: 'BlindPeerReplicaManager' })
      : this.logger;
    this.blindPeerReplicaManager = new BlindPeerReplicaManager({
      logger: replicaLogger,
      maxReplicas: Number.isFinite(replicaConfig.maxCached) && replicaConfig.maxCached > 0
        ? Math.trunc(replicaConfig.maxCached)
        : 32
    });
    try {
      await this.blindPeerReplicaManager.initialize({
        blindPeerService: this.blindPeerService
      });
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to initialize BlindPeerReplicaManager', {
        error: error?.message || error
      });
    }
  }

  #normalizeRelayConfig(raw = {}) {
    const baseDir = raw?.storageDir
      || process.env.GATEWAY_RELAY_STORAGE
      || resolve(process.env.STORAGE_DIR || process.cwd(), 'gateway-relay');
    const statsIntervalMs = Number(raw?.statsIntervalMs);
    const legacyPath = this.#toGatewayPath(this.internalRelayKey);
    const canonicalPath = this.#normalizePathValue(raw?.canonicalPath)
      || (legacyPath ? this.#normalizePathValue(legacyPath) : 'relay')
      || 'relay';
    const aliasInput = Array.isArray(raw?.aliasPaths) ? raw.aliasPaths : [];
    const aliasSet = new Set();
    const addAlias = (value) => {
      const normalized = this.#normalizePathValue(value);
      if (normalized) {
        aliasSet.add(normalized);
      }
    };
    addAlias(canonicalPath);
    aliasInput.forEach(addAlias);
    if (legacyPath) {
      addAlias(legacyPath);
    }
    return {
      storageDir: baseDir,
      datasetNamespace: raw?.datasetNamespace || 'public-gateway-relay',
      adminPublicKey: raw?.adminPublicKey || process.env.GATEWAY_RELAY_ADMIN_PUBLIC_KEY || null,
      adminSecretKey: raw?.adminSecretKey || process.env.GATEWAY_RELAY_ADMIN_SECRET_KEY || null,
      statsIntervalMs: Number.isFinite(statsIntervalMs) && statsIntervalMs > 0 ? statsIntervalMs : undefined,
      replicationTopic: raw?.replicationTopic || null,
      canonicalPath,
      aliasPaths: Array.from(aliasSet)
    };
  }

  #normalizeOpenJoinConfig(raw = {}) {
    const enabled = raw?.enabled !== false;
    const poolEntryTtlMs = Number(raw?.poolEntryTtlMs);
    const challengeTtlMs = Number(raw?.challengeTtlMs);
    const authWindowSeconds = Number(raw?.authWindowSeconds);
    const maxPoolSize = Number(raw?.maxPoolSize);
    const maxAppendCores = Number(raw?.maxAppendCores);
    const maxRelayCores = Number(raw?.maxRelayCores);
    return {
      enabled,
      poolEntryTtlMs: Number.isFinite(poolEntryTtlMs) && poolEntryTtlMs > 0 ? poolEntryTtlMs : 6 * 60 * 60 * 1000,
      challengeTtlMs: Number.isFinite(challengeTtlMs) && challengeTtlMs > 0 ? challengeTtlMs : 2 * 60 * 1000,
      authWindowSeconds: Number.isFinite(authWindowSeconds) && authWindowSeconds > 0 ? authWindowSeconds : 300,
      maxPoolSize: Number.isFinite(maxPoolSize) && maxPoolSize > 0 ? Math.trunc(maxPoolSize) : 50,
      maxAppendCores: Number.isFinite(maxAppendCores) && maxAppendCores > 0 ? Math.trunc(maxAppendCores) : 64,
      maxRelayCores: Number.isFinite(maxRelayCores) && maxRelayCores > 0 ? Math.trunc(maxRelayCores) : 1024
    };
  }

  #isHexRelayKey(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
  }

  async #resolveRelayAlias(identifier) {
    if (!identifier || typeof this.registrationStore?.resolveRelayAlias !== 'function') return null;
    const candidates = new Set();
    const addCandidate = (value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed) candidates.add(trimmed);
    };

    addCandidate(identifier);
    const normalized = this.#normalizePathValue(identifier);
    if (normalized) {
      addCandidate(normalized);
      const colon = this.#toColonIdentifier(normalized);
      if (colon) addCandidate(colon);
    }

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const mapped = await this.registrationStore.resolveRelayAlias(candidate);
      if (mapped) return mapped;
    }
    return null;
  }

  #collectRelayAliases(registration, relayKey) {
    const aliases = new Set();
    const addAlias = (value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (relayKey && trimmed === relayKey) return;
      aliases.add(trimmed);
    };

    addAlias(registration?.metadata?.identifier);
    addAlias(registration?.identifier);
    addAlias(registration?.publicIdentifier);

    const gatewayPath = this.#normalizePathValue(registration?.metadata?.gatewayPath);
    if (gatewayPath) {
      addAlias(gatewayPath);
      const colon = this.#toColonIdentifier(gatewayPath);
      if (colon) addAlias(colon);
    }

    const pathAliases = Array.isArray(registration?.metadata?.pathAliases)
      ? registration.metadata.pathAliases
      : [];
    for (const rawAlias of pathAliases) {
      const normalizedAlias = this.#normalizePathValue(rawAlias);
      if (!normalizedAlias) continue;
      addAlias(normalizedAlias);
      const colon = this.#toColonIdentifier(normalizedAlias);
      if (colon) addAlias(colon);
    }

    const connectionUrl = registration?.metadata?.connectionUrl;
    if (connectionUrl) {
      try {
        const parsed = new URL(connectionUrl);
        const normalizedPath = this.#normalizePathValue(parsed.pathname);
        if (normalizedPath) {
          addAlias(normalizedPath);
          const colon = this.#toColonIdentifier(normalizedPath);
          if (colon) addAlias(colon);
        }
      } catch (_) {}
    }

    return Array.from(aliases);
  }

  async #storeRelayAliases(relayKey, registration) {
    if (!this.#isHexRelayKey(relayKey)) return;
    if (typeof this.registrationStore?.storeRelayAlias !== 'function') return;
    const aliases = this.#collectRelayAliases(registration, relayKey);
    if (!aliases.length) return;
    for (const alias of aliases) {
      // eslint-disable-next-line no-await-in-loop
      await this.registrationStore.storeRelayAlias(alias, relayKey);
    }
  }

  #pruneOpenJoinChallenges() {
    if (!this.openJoinChallenges?.size) return;
    const now = Date.now();
    for (const [challenge, entry] of this.openJoinChallenges.entries()) {
      if (!entry?.expiresAt || entry.expiresAt <= now) {
        this.openJoinChallenges.delete(challenge);
      }
    }
  }

  #issueOpenJoinChallenge({ relayKey, publicIdentifier, purpose = null }) {
    this.#pruneOpenJoinChallenges();
    const now = Date.now();
    const ttlMs = this.openJoinConfig?.challengeTtlMs || 120000;
    const challenge = randomBytes(16).toString('hex');
    const entry = {
      relayKey,
      publicIdentifier: publicIdentifier || relayKey,
      purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : null,
      issuedAt: now,
      expiresAt: now + ttlMs
    };
    this.openJoinChallenges.set(challenge, entry);
    return { challenge, expiresAt: entry.expiresAt };
  }

  #consumeOpenJoinChallenge(challenge, relayKey, purpose = null) {
    if (!challenge) return null;
    this.#pruneOpenJoinChallenges();
    const entry = this.openJoinChallenges.get(challenge);
    if (!entry) return null;
    if (relayKey && entry.relayKey && relayKey !== entry.relayKey) return null;
    const expectedPurpose = typeof purpose === 'string' && purpose.trim() ? purpose.trim() : null;
    const entryPurpose = typeof entry?.purpose === 'string' && entry.purpose.trim() ? entry.purpose.trim() : null;
    if (entryPurpose || expectedPurpose) {
      if (!expectedPurpose || entryPurpose !== expectedPurpose) return null;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.openJoinChallenges.delete(challenge);
      return null;
    }
    this.openJoinChallenges.delete(challenge);
    return entry;
  }

  async #resolveOpenJoinRegistration(identifier) {
    if (!identifier) return null;
    const aliasRelayKey = this.#resolveRelayKeyFromPath(identifier);
    if (aliasRelayKey) {
      const record = await this.registrationStore.getRelay(aliasRelayKey);
      if (record) return { relayKey: aliasRelayKey, record };
    }

    const mappedRelayKey = await this.#resolveRelayAlias(identifier);
    if (mappedRelayKey && this.#isHexRelayKey(mappedRelayKey)) {
      const record = await this.registrationStore.getRelay(mappedRelayKey);
      if (record) return { relayKey: mappedRelayKey, record };
      return null;
    }

    const target = await this.#resolveRelayTarget(identifier);
    if (target?.relayKey && this.#isHexRelayKey(target.relayKey)) {
      const record = await this.registrationStore.getRelay(target.relayKey);
      if (record) return { relayKey: target.relayKey, record };
    }

    if (!this.#isHexRelayKey(identifier)) {
      return null;
    }

    const direct = await this.registrationStore.getRelay(identifier);
    if (direct) {
      return { relayKey: identifier, record: direct };
    }

    return null;
  }

  async #resolveOpenJoinPool(identifier) {
    if (!identifier || typeof this.registrationStore?.getOpenJoinPool !== 'function') return null;
    const trimmed = typeof identifier === 'string' ? identifier.trim() : null;
    if (!trimmed) return null;
    const normalized = this.#normalizePathValue(trimmed) || trimmed;
    const directCandidate = this.#isHexRelayKey(trimmed)
      ? trimmed
      : (this.#isHexRelayKey(normalized) ? normalized : null);
    const directRelayKey = directCandidate ? directCandidate.toLowerCase() : null;
    if (directRelayKey) {
      const pool = await this.registrationStore.getOpenJoinPool(directRelayKey);
      if (pool) return { relayKey: directRelayKey, pool };
    }
    if (typeof this.registrationStore?.resolveOpenJoinAlias === 'function') {
      const resolvedKey = await this.registrationStore.resolveOpenJoinAlias(normalized);
      const aliasRelayKey = resolvedKey && this.#isHexRelayKey(resolvedKey)
        ? resolvedKey.toLowerCase()
        : null;
      if (aliasRelayKey) {
        const pool = await this.registrationStore.getOpenJoinPool(aliasRelayKey);
        if (pool) return { relayKey: aliasRelayKey, pool };
      }
    }
    return null;
  }

  async #resolveOpenJoinTarget(identifier) {
    const poolResolved = await this.#resolveOpenJoinPool(identifier);
    if (poolResolved) {
      return {
        relayKey: poolResolved.relayKey,
        pool: poolResolved.pool,
        record: null,
        source: 'pool'
      };
    }
    const registration = await this.#resolveOpenJoinRegistration(identifier);
    if (!registration) return null;
    return {
      relayKey: registration.relayKey,
      record: registration.record,
      pool: null,
      source: 'registration'
    };
  }

  #isOpenJoinAllowed(record) {
    return record?.metadata?.isOpen === true;
  }

  #isOpenJoinPoolAllowed(pool) {
    return pool?.metadata?.isOpen === true;
  }

  #buildMirrorMetadataPayload(record, relayKey) {
    const blindPeerInfo = this.blindPeerService?.getAnnouncementInfo?.();
    const cores = Array.isArray(record?.relayCores) ? record.relayCores : [];
    return {
      relayKey,
      publicIdentifier: record?.metadata?.identifier || relayKey,
      cores,
      blindPeer: blindPeerInfo && blindPeerInfo.enabled
        ? {
            publicKey: blindPeerInfo.publicKey || null,
            encryptionKey: blindPeerInfo.encryptionKey || null,
            maxBytes: blindPeerInfo.maxBytes ?? null
          }
        : { enabled: false }
    };
  }

  #buildOpenJoinMirrorPayload(record, relayKey) {
    const base = this.#buildMirrorMetadataPayload(record, relayKey);
    return {
      ...base,
      relayUrl: record?.metadata?.connectionUrl || null
    };
  }

  #buildOpenJoinMirrorPayloadFromPool(pool, relayKey) {
    if (!pool || typeof pool !== 'object') return null;
    const blindPeerInfo = this.blindPeerService?.getAnnouncementInfo?.();
    const relayCores = Array.isArray(pool?.relayCores) ? pool.relayCores : [];
    const metadata = pool?.metadata && typeof pool.metadata === 'object' ? pool.metadata : null;
    const publicIdentifier = pool?.publicIdentifier || metadata?.identifier || relayKey;
    const relayUrl = pool?.relayUrl || metadata?.relayUrl || metadata?.connectionUrl || null;
    return {
      relayKey,
      publicIdentifier: publicIdentifier || relayKey,
      cores: relayCores,
      relayUrl,
      blindPeer: blindPeerInfo && blindPeerInfo.enabled
        ? {
            publicKey: blindPeerInfo.publicKey || null,
            encryptionKey: blindPeerInfo.encryptionKey || null,
            maxBytes: blindPeerInfo.maxBytes ?? null
          }
        : { enabled: false }
    };
  }

  async #storeMirrorMetadataPayload(relayKey, payload) {
    if (!relayKey || !payload || !this.registrationStore?.storeMirrorMetadata) return;
    try {
      await this.registrationStore.storeMirrorMetadata(relayKey, payload);
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to persist mirror metadata payload', {
        relayKey,
        err: error?.message || error
      });
    }
  }

  #extractTagValue(tags, key) {
    if (!Array.isArray(tags)) return null;
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
        return tag[1];
      }
    }
    return null;
  }

  #extractTagValues(tags, key) {
    if (!Array.isArray(tags)) return [];
    const values = [];
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
        values.push(tag[1]);
      }
    }
    return values;
  }

  #normalizeOpenJoinCoreKey(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) {
      try {
        return HypercoreId.encode(value);
      } catch (_) {
        return value.toString('hex');
      }
    }
    if (value instanceof Uint8Array) {
      try {
        return HypercoreId.encode(Buffer.from(value));
      } catch (_) {
        return Buffer.from(value).toString('hex');
      }
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return HypercoreId.encode(HypercoreId.decode(trimmed));
      } catch (_) {
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          try {
            return HypercoreId.encode(Buffer.from(trimmed, 'hex'));
          } catch (_) {
            return null;
          }
        }
        return null;
      }
    }
    if (value && typeof value === 'object') {
      if (value.key) return this.#normalizeOpenJoinCoreKey(value.key);
      if (value.core) return this.#normalizeOpenJoinCoreKey(value.core);
    }
    return null;
  }

  #normalizeOpenJoinCoreEntry(entry) {
    if (!entry) return null;
    const key = this.#normalizeOpenJoinCoreKey(entry);
    if (!key) return null;
    let role = null;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (typeof entry.role === 'string' && entry.role.trim()) {
        role = entry.role.trim();
      }
    }
    return role ? { key, role } : { key };
  }

  #normalizeOpenJoinCoreEntries(entries = [], { maxEntries = null } = {}) {
    const normalized = [];
    let rejected = 0;
    let truncated = 0;
    const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.trunc(maxEntries) : null;
    for (const entry of entries) {
      if (limit && normalized.length >= limit) {
        truncated += 1;
        continue;
      }
      const normalizedEntry = this.#normalizeOpenJoinCoreEntry(entry);
      if (!normalizedEntry) {
        rejected += 1;
        continue;
      }
      normalized.push(normalizedEntry);
    }
    return { entries: normalized, rejected, truncated };
  }

  #mergeOpenJoinCoreEntries(existingEntries = [], incomingEntries = [], { maxTotal = null } = {}) {
    const merged = [];
    const indexByKey = new Map();
    let added = 0;
    let ignored = 0;

    const addEntry = (entry, isIncoming = false) => {
      const normalized = this.#normalizeOpenJoinCoreEntry(entry);
      if (!normalized) return;
      const key = normalized.key;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, merged.length);
        merged.push(normalized);
        if (isIncoming) added += 1;
        return;
      }
      if (isIncoming) ignored += 1;
      const current = merged[existingIndex];
      if (!current.role && normalized.role) {
        merged[existingIndex] = { ...current, role: normalized.role };
      }
    };

    for (const entry of existingEntries) addEntry(entry, false);
    for (const entry of incomingEntries) addEntry(entry, true);

    let trimmed = 0;
    const maxAllowed = Number.isFinite(maxTotal) && maxTotal > 0 ? Math.trunc(maxTotal) : null;
    if (maxAllowed && merged.length > maxAllowed) {
      trimmed = merged.length - maxAllowed;
      merged.splice(0, trimmed);
    }

    return { merged, added, ignored, trimmed };
  }

  async #verifyOpenJoinAuthEvent(event, { challenge, relayKey, publicIdentifier, purpose } = {}) {
    if (!event || typeof event !== 'object') {
      return { ok: false, error: 'missing-auth-event' };
    }

    const createdAt = Number(event.created_at);
    if (!Number.isFinite(createdAt)) {
      return { ok: false, error: 'missing-created-at' };
    }

    const now = Math.floor(Date.now() / 1000);
    const maxSkew = this.openJoinConfig?.authWindowSeconds || 300;
    if (Math.abs(now - createdAt) > maxSkew) {
      return { ok: false, error: 'auth-event-expired' };
    }

    if (event.kind !== 22242) {
      return { ok: false, error: 'invalid-auth-kind' };
    }

    const pubkey = typeof event.pubkey === 'string' ? event.pubkey : null;
    const sig = typeof event.sig === 'string' ? event.sig : null;
    if (!pubkey || !sig) {
      return { ok: false, error: 'missing-auth-signature' };
    }

    const tags = Array.isArray(event.tags) ? event.tags : [];
    const challengeTag = this.#extractTagValue(tags, 'challenge');
    if (!challengeTag || challengeTag !== challenge) {
      return { ok: false, error: 'challenge-mismatch' };
    }

    const expectedPurpose = typeof purpose === 'string' && purpose.trim() ? purpose.trim() : null;
    if (expectedPurpose) {
      const purposeTag = this.#extractTagValue(tags, 'purpose');
      if (!purposeTag || purposeTag !== expectedPurpose) {
        return { ok: false, error: 'purpose-mismatch' };
      }
    }

    const relayTags = this.#extractTagValues(tags, 'relay');
    const expectedRelay = this.config?.publicBaseUrl || null;
    const expectedWs = this.wsBaseUrl || null;
    const relayMatch = relayTags.some((value) => value === expectedRelay || value === expectedWs);
    if (!relayMatch) {
      return { ok: false, error: 'relay-tag-missing' };
    }

    const hTag = this.#extractTagValue(tags, 'h');
    if (publicIdentifier && hTag && hTag !== publicIdentifier) {
      return { ok: false, error: 'identifier-mismatch' };
    }

    const serialized = JSON.stringify([
      0,
      pubkey,
      createdAt,
      event.kind,
      tags,
      typeof event.content === 'string' ? event.content : ''
    ]);
    const computedId = createHash('sha256').update(serialized).digest('hex');
    if (event.id && event.id !== computedId) {
      return { ok: false, error: 'auth-event-id-mismatch' };
    }

    if (!schnorr?.verify) {
      this.logger?.warn?.('[PublicGateway] Schnorr verify unavailable for open join', {
        relayKey,
        publicIdentifier
      });
      return { ok: false, error: 'auth-signature-invalid' };
    }

    const sigBytes = typeof sig === 'string' ? hexToBytes(sig) : sig;
    const pubkeyBytes = typeof pubkey === 'string' ? hexToBytes(pubkey) : pubkey;
    const msgBytes = typeof computedId === 'string' ? hexToBytes(computedId) : computedId;
    if (!sigBytes || !pubkeyBytes || !msgBytes) {
      this.logger?.warn?.('[PublicGateway] Open join auth signature decode failed', {
        relayKey,
        publicIdentifier,
        pubkeyPrefix: pubkey ? pubkey.slice(0, 12) : null,
        sigLength: typeof sig === 'string' ? sig.length : null,
        idPrefix: computedId ? computedId.slice(0, 12) : null
      });
      return { ok: false, error: 'auth-signature-invalid' };
    }

    try {
      const ok = await schnorr.verify(sigBytes, msgBytes, pubkeyBytes);
      if (!ok) {
        this.logger?.warn?.('[PublicGateway] Open join auth signature invalid', {
          relayKey,
          publicIdentifier,
          pubkeyPrefix: pubkey ? pubkey.slice(0, 12) : null,
          idPrefix: computedId ? computedId.slice(0, 12) : null
        });
        return { ok: false, error: 'auth-signature-invalid' };
      }
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Open join auth signature verify error', {
        relayKey,
        publicIdentifier,
        error: error?.message || error
      });
      return { ok: false, error: 'auth-signature-invalid' };
    }

    return { ok: true, pubkey };
  }

  #buildRelayAliasMap(paths = [], relayKey = this.internalRelayKey) {
    const map = new Map();
    if (!relayKey) return map;
    const pathList = Array.isArray(paths) ? [...paths] : [];
    const canonical = this.#normalizePathValue(this.relayCanonicalPath);
    if (canonical) {
      pathList.push(canonical);
    }
    const legacyPath = this.#toGatewayPath(this.internalRelayKey);
    if (legacyPath) {
      pathList.push(legacyPath);
    }
    for (const rawPath of pathList) {
      const normalizedPath = this.#normalizePathValue(rawPath);
      if (!normalizedPath) continue;
      map.set(normalizedPath, relayKey);
      const colonIdentifier = this.#toColonIdentifier(normalizedPath);
      if (colonIdentifier) {
        map.set(colonIdentifier, relayKey);
      }
    }
    return map;
  }

  #resolveRelayKeyFromPath(value) {
    const normalized = this.#normalizePathValue(value);
    if (!normalized) return null;
    return this.relayAliasMap?.get(normalized) || null;
  }

  #isHyperbeeRelayEnabled() {
    return this.featureFlags.hyperbeeRelayEnabled;
  }

  async #ensureRelayHost() {
    if (this.relayHost) return;
    if (!this.relayConfig.adminPublicKey || !this.relayConfig.adminSecretKey) {
      this.logger?.warn?.('Hyperbee relay feature enabled but admin key pair missing');
      return;
    }

    const host = new HyperbeeRelayHost({
      logger: this.logger,
      telemetryIntervalMs: this.relayConfig.statsIntervalMs
    });

    await host.initialize({
      storageDir: this.relayConfig.storageDir,
      datasetNamespace: this.relayConfig.datasetNamespace,
      adminKeyPair: {
        publicKey: this.relayConfig.adminPublicKey,
        secretKey: this.relayConfig.adminSecretKey
      },
      statsIntervalMs: this.relayConfig.statsIntervalMs,
      replicationTopic: this.relayConfig.replicationTopic
    });

    this.relayTelemetryUnsub = host.registerTelemetrySink((event) => {
      this.logger?.debug?.('[HyperbeeRelayHost] Telemetry', event);
    });

    try {
      await host.start();
    } catch (error) {
      this.logger?.error?.('Failed to start Hyperbee relay host', { error: error?.message });
      if (this.relayTelemetryUnsub) {
        this.relayTelemetryUnsub();
        this.relayTelemetryUnsub = null;
      }
      throw error;
    }

    this.relayHost = host;
    this.hyperbeeAdapter = new PublicGatewayHyperbeeAdapter({
      logger: this.logger,
      relayClient: {
        getHyperbee: () => this.relayHost?.getHyperbee?.(),
        getCore: () => this.relayHost?.getCore?.()
      }
    });
    this.logger?.info?.('Hyperbee relay host ready', {
      relayKey: host.getPublicKey()
    });

    this.relayWebsocketController = new RelayWebsocketController({
      relayHost: host,
      hyperbeeAdapter: this.hyperbeeAdapter,
      dispatcher: this.dispatcher,
      logger: this.logger,
      featureFlags: this.featureFlags,
      metrics: {
        eventCounter: relayEventCounter,
        reqCounter: relayReqCounter,
        errorCounter: relayErrorCounter
      },
      legacyForward: (session, message, preferredPeer, context = {}) => this.#forwardLegacyMessage(session, message, preferredPeer, context)
    });

    await this.#ensureInternalRelayRegistration();

    const ttlSeconds = Math.max(Number(this.config.registration?.cacheTtlSeconds) || 300, 60);
    const refreshIntervalMs = Math.max(60000, Math.floor((ttlSeconds * 1000) / 2));
    this.internalRegistrationInterval = setInterval(() => {
      this.#ensureInternalRelayRegistration().catch((error) => {
        this.logger?.debug?.('Failed to refresh internal relay registration', {
          error: error?.message || error
        });
      });
    }, refreshIntervalMs);
    this.internalRegistrationInterval.unref?.();
  }

  async #ensureInternalRelayRegistration() {
    if (!this.relayHost || !this.registrationStore?.upsertRelay) return;

    const timestamp = new Date().toISOString();
    const canonicalGatewayPath = this.#normalizePathValue(this.relayCanonicalPath)
      || this.#toGatewayPath(this.internalRelayKey)
      || this.internalRelayKey.replace(':', '/');
    const aliasSet = new Set(
      (this.relayPathAliases || [])
        .map((value) => this.#normalizePathValue(value))
        .filter(Boolean)
    );
    aliasSet.delete(canonicalGatewayPath);
    const pathAliases = Array.from(aliasSet);

    const registration = {
      relayKey: this.internalRelayKey,
      identifier: this.internalRelayKey,
      peers: [],
      registeredAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        identifier: this.internalRelayKey,
        name: 'Public Gateway Hyperbee',
        description: 'Authoritative public gateway relay dataset',
        requiresAuth: false,
        isPublic: true,
        isGatewayReplica: true,
        gatewayPath: canonicalGatewayPath,
        pathAliases,
        gatewayRelay: this.#getRelayHostInfo()
      }
    };

    await this.registrationStore.upsertRelay(this.internalRelayKey, registration);
  }

  #computeWsBase(baseUrl) {
    if (!baseUrl) return '';
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        this.logger?.warn?.('Unsupported protocol for public gateway base URL', {
          protocol: parsed.protocol,
          baseUrl
        });
        return '';
      }
      return parsed.toString().replace(/\/$/, '');
    } catch (error) {
      this.logger?.warn?.('Failed to compute websocket base from public URL', {
        baseUrl,
        error: error?.message || error
      });
      return '';
    }
  }

  #normalizeSecretPath(secretPath) {
    if (!secretPath) return '/.well-known/hypertuna-gateway-secret';
    if (typeof secretPath !== 'string') return '/.well-known/hypertuna-gateway-secret';
    const trimmed = secretPath.trim();
    if (!trimmed) return '/.well-known/hypertuna-gateway-secret';
    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const parsed = new URL(trimmed);
        return parsed.pathname || '/.well-known/hypertuna-gateway-secret';
      }
    } catch (error) {
      this.logger?.warn?.('Failed to parse discovery secret path as URL', {
        secretPath,
        error: error?.message || error
      });
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  #deriveSharedSecretVersion(secret) {
    if (!secret) return '';
    return computeSecretHash(secret).slice(0, 24);
  }

  #getSharedSecretVersion() {
    if (this.explicitSharedSecretVersion) return this.explicitSharedSecretVersion;
    if (!this.sharedSecretVersion) {
      this.sharedSecretVersion = this.#deriveSharedSecretVersion(this.sharedSecret);
    }
    return this.sharedSecretVersion || '';
  }

  #shouldExposeSecretEndpoint() {
    return Boolean(this.sharedSecret && this.discoveryConfig?.enabled && this.discoveryConfig.openAccess);
  }

  #handleSecretRequest(_req, res) {
    if (!this.#shouldExposeSecretEndpoint()) {
      return res.status(404).json({ error: 'Gateway secret not available' });
    }
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Gateway shared secret not configured' });
    }

    const payload = {
      gatewayId: this.gatewayAdvertiser?.gatewayId || null,
      sharedSecret: this.sharedSecret,
      version: this.#getSharedSecretVersion(),
      hash: computeSecretHash(this.sharedSecret),
      wsUrl: this.wsBaseUrl,
      publicUrl: this.config.publicBaseUrl,
      timestamp: Date.now()
    };

    res.json(payload);
  }

  #handleWebSocket(ws, req) {
    this.#initializeSession(ws, req).catch((error) => {
      this.logger.error?.({
        error: error?.message || 'unknown error',
        stack: error?.stack || null,
        relayKey: error?.relayKey || null
      }, 'Failed to initialize websocket session');
      try {
        ws.close(1011, 'Internal error');
      } catch (_) {}
      ws.terminate();
    });
  }

  async #initializeSession(ws, req) {
    if (!this.sharedSecret) {
      this.logger.error?.('WebSocket rejected: shared secret missing');
      ws.close(1011, 'Gateway not configured');
      ws.terminate();
      return;
    }

    const { relayKey, token } = this.#parseWebSocketRequest(req);

    if (!relayKey) {
      this.logger.warn?.({
        url: req?.url || null
      }, 'WebSocket rejected: invalid relay key');
      ws.close(4404, 'Invalid relay key');
      ws.terminate();
      return;
    }

    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      this.logger.warn?.({ relayKey }, 'WebSocket rejected: relay not registered');
      ws.close(4404, 'Relay not registered');
      ws.terminate();
      return;
    }

    const requiresAuth = registration?.metadata?.requiresAuth !== false;

    let tokenValidation = null;
    if (requiresAuth) {
      if (!token) {
        this.logger.warn?.({ relayKey }, 'WebSocket rejected: token missing');
        ws.close(4403, 'Token required');
        ws.terminate();
        return;
      }

      tokenValidation = await this.#validateToken(token, relayKey);
      if (!tokenValidation) {
        this.logger.warn?.({ relayKey }, 'WebSocket rejected: token validation failed');
        ws.close(4403, 'Invalid token');
        ws.terminate();
        return;
      }
    }

    const { payload: tokenPayload, relayAuthToken, pubkey: tokenPubkey, scope: tokenScope } = tokenValidation || {};

    const metadata = registration?.metadata || {};
    const delegateReqToPeers = metadata?.delegateReqToPeers === true
      || registration?.gatewayReplica?.delegateReqToPeers === true;

    const availablePeers = this.#getUsablePeersFromRegistration(registration);
    this.logger.info?.({
      relayKey,
      peerCount: availablePeers.length,
      peers: availablePeers
    }, 'Initializing websocket session - relay registration fetched');

    const selection = this.#selectPeer({ ...registration, peers: availablePeers });
    const supportsLocal = this.#supportsLocalRelay(registration);

    let peerKey = null;
    let peers = availablePeers;
    let peerIndex = 0;
    const localOnly = !selection && supportsLocal;

    if (selection) {
      peerKey = selection.peerKey;
      peers = selection.peers;
      peerIndex = selection.index >= 0 ? selection.index : 0;
    } else if (!localOnly) {
      this.logger.warn?.({ relayKey }, 'WebSocket rejected: no peers available');
      ws.close(1013, 'No peers available');
      ws.terminate();
      return;
    }

    if (!localOnly && peerKey) {
      try {
        this.logger.info?.({
          relayKey,
          peerKey
        }, 'Attempting hyperswarm connection for websocket session');
        await this.connectionPool.getConnection(peerKey);
        this.logger.info?.({
          relayKey,
          peerKey
        }, 'Hyperswarm connection established for websocket session');
      } catch (err) {
        err.relayKey = relayKey;
        this.logger.error?.({
          relayKey,
          peerKey,
          error: err?.message || 'unknown error'
        }, 'WebSocket rejected: failed to connect to peer');
        throw err;
      }
    } else if (localOnly) {
      this.logger.info?.({ relayKey }, 'WebSocket session using local Hyperbee host');
    }

    const connectionKey = this.#generateConnectionKey();
    const session = {
      connectionKey,
      relayKey,
      ws,
      clientToken: token || null,
      tokenPayload,
      relayAuthToken,
      clientPubkey: tokenPubkey || null,
      clientScope: tokenScope || null,
      peerKey,
      peers,
      peerIndex,
      localOnly,
      delegateReqToPeers,
      messageQueue: new MessageQueue(),
      openedAt: Date.now(),
      subscriptionPeers: new Map(),
      assignPeer: null,
      pendingDelegatedMessages: [],
      delegationReady: delegateReqToPeers === true
    };
    session.assignPeer = (assignedPeer, subscriptionId) => {
      if (session.localOnly) return;
      this.#assignPeerForSubscription(session, assignedPeer, subscriptionId);
    };

    this.sessions.set(connectionKey, session);
    sessionGauge.set(this.sessions.size);

    ws.on('message', (message) => this.#handleClientMessage(session, message));
    ws.on('close', () => this.#cleanupSession(connectionKey));
    ws.on('error', () => this.#cleanupSession(connectionKey));

    this.#startEventChecking(session);

    if (session.delegateReqToPeers) {
      this.#updateSessionsForDelegation({
        peerKey,
        delegate: true
      });
    }

    this.logger.info?.({ relayKey, connectionKey, peerKey }, 'WebSocket session established');
  }

  #generateConnectionKey() {
    return randomBytes(16).toString('hex');
  }

  #handleClientMessage(session, rawMessage) {
    if (!this.sessions.has(session.connectionKey)) {
      return;
    }

    const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
    session.messageQueue.enqueue(payload, async (msg) => {
      if (!this.sessions.has(session.connectionKey)) {
        return;
      }

      const useRelayController = this.#isHyperbeeRelayEnabled() && this.relayWebsocketController;

      if (useRelayController) {
        const handled = await this.relayWebsocketController.handleMessage(session, msg);
        if (handled) return;
      }

      await this.#forwardLegacyMessage(session, msg);
    });
  }

  #cleanupSession(connectionKey) {
    const session = this.sessions.get(connectionKey);
    if (!session) return;

    this.sessions.delete(connectionKey);
    const timer = this.eventCheckTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.eventCheckTimers.delete(connectionKey);
    }

    const fallbackTimer = this.delegationFallbackTimers.get(connectionKey);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.delegationFallbackTimers.delete(connectionKey);
    }

    this.relayWebsocketController?.removeSession(connectionKey);

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(); } catch (_) {}
    }

    sessionGauge.set(this.sessions.size);
  }

  async #forwardLegacyMessage(session, msg, preferredPeer = null, options = {}) {
    const { allowQueue = true, subscriptionId = null, storePending = false } = options || {};
    const serialized = typeof msg === 'string' ? msg : safeString(msg);
    if (!serialized) {
      this.logger.warn?.({ relayKey: session.relayKey }, 'Failed to serialize legacy message');
      return;
    }

    let pendingEntry = null;
    if (Array.isArray(session.pendingDelegatedMessages) && subscriptionId) {
      pendingEntry = session.pendingDelegatedMessages.find((entry) => entry?.subscriptionId === subscriptionId) || null;
    }
    if (storePending && session?.delegateReqToPeers) {
      if (!pendingEntry) {
        if (!Array.isArray(session.pendingDelegatedMessages)) {
          session.pendingDelegatedMessages = [];
        }
        pendingEntry = {
          message: serialized,
          preferredPeer: preferredPeer || null,
          queuedAt: Date.now(),
          subscriptionId
        };
        session.pendingDelegatedMessages.push(pendingEntry);
      } else {
        pendingEntry.preferredPeer = preferredPeer || null;
        pendingEntry.queuedAt = Date.now();
      }
    }

    if (subscriptionId) {
      this.logger.info?.({
        tag: 'DelegationDebug',
        stage: 'forward-invoked',
        relayKey: session.relayKey,
        connectionKey: session.connectionKey,
        subscriptionId,
        delegateReqToPeers: session.delegateReqToPeers === true,
        delegationReady: session.delegationReady === true,
        localOnly: session.localOnly === true,
        peerKey: session.peerKey || null,
        peerCount: Array.isArray(session.peers) ? session.peers.length : 0,
        allowQueue,
        storePending,
        hasPendingEntry: !!pendingEntry,
        pendingDelegatedMessages: Array.isArray(session.pendingDelegatedMessages)
          ? session.pendingDelegatedMessages.length
          : 0
      }, 'DelegationDebug: forwardLegacyMessage invoked');
    }

    if (!session?.peers?.length) {
      if (allowQueue && session?.delegateReqToPeers) {
        if (pendingEntry) {
          pendingEntry.preferredPeer = preferredPeer || null;
          pendingEntry.queuedAt = Date.now();
        } else {
          if (!Array.isArray(session.pendingDelegatedMessages)) {
            session.pendingDelegatedMessages = [];
          }
          session.pendingDelegatedMessages.push({
            message: serialized,
            preferredPeer: preferredPeer || null,
            queuedAt: Date.now(),
            subscriptionId
          });
          pendingEntry = session.pendingDelegatedMessages[session.pendingDelegatedMessages.length - 1];
        }
        if (subscriptionId) {
          this.logger.info?.({
            tag: 'DelegationDebug',
            stage: 'queue-no-peer',
            relayKey: session?.relayKey,
            connectionKey: session?.connectionKey,
            subscriptionId,
            queueLength: session.pendingDelegatedMessages.length,
            allowQueue,
            reason: 'no-peers-available'
          }, 'DelegationDebug: queueing delegated message while peers unavailable');
        }
        this.logger.debug?.({
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        }, 'Queued delegated relay message pending peer availability');
        if (session.delegationReady) {
          this.#scheduleDelegationFallback(session);
        }
      } else if (!allowQueue && session?.delegateReqToPeers) {
        if (pendingEntry) {
          pendingEntry.preferredPeer = preferredPeer || null;
          pendingEntry.queuedAt = Date.now();
        } else {
          if (!Array.isArray(session.pendingDelegatedMessages)) {
            session.pendingDelegatedMessages = [];
          }
          session.pendingDelegatedMessages.unshift({
            message: serialized,
            preferredPeer: preferredPeer || null,
            queuedAt: Date.now(),
            subscriptionId
          });
          pendingEntry = session.pendingDelegatedMessages[0];
        }
        if (subscriptionId) {
          this.logger.info?.({
            tag: 'DelegationDebug',
            stage: 'requeue-no-peer',
            relayKey: session?.relayKey,
            connectionKey: session?.connectionKey,
            subscriptionId,
            queueLength: session.pendingDelegatedMessages.length,
            allowQueue,
            reason: 'no-peers-available'
          }, 'DelegationDebug: re-queueing delegated message without peers');
        }
        this.logger.debug?.({
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        }, 'Re-queued delegated relay message while peers unavailable');
        if (session.delegationReady) {
          this.#scheduleDelegationFallback(session);
        }
      } else {
        if (subscriptionId) {
          this.logger.info?.({
            tag: 'DelegationDebug',
            stage: 'skip-no-peer',
            relayKey: session?.relayKey,
            connectionKey: session?.connectionKey,
            subscriptionId,
            allowQueue,
            delegateReqToPeers: session?.delegateReqToPeers === true
          }, 'DelegationDebug: skipping delegation - peers unavailable and queue disabled');
        }
        this.logger.debug?.({
          relayKey: session?.relayKey
        }, 'Legacy forward skipped - no peers available for relay');
      }
      return;
    }

    try {
      if (subscriptionId) {
        this.logger.info?.({
          tag: 'DelegationDebug',
          stage: 'forward-to-peer',
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          subscriptionId,
          preferredPeer,
          activePeer: session.peerKey || null
        }, 'DelegationDebug: forwarding message to peer');
      }
      const responses = await this.#withPeer(session, async (peerKey) => {
        requestCounter.inc({ relay: session.relayKey });
        return forwardMessageToPeerHyperswarm(
          peerKey,
          session.relayKey,
          serialized,
          session.connectionKey,
          this.connectionPool,
          session.relayAuthToken
        );
      }, { preferredPeer });

      if (!Array.isArray(responses)) return;
      const deliverable = [];
      for (const response of responses) {
        if (!response) continue;
        if (Array.isArray(response) && response[0] === 'ACK') {
          const ackSubscription = response[1] || null;
          this.#handlePeerAck(session, ackSubscription, response.slice(2));
          continue;
        }
        deliverable.push(response);
      }
      if (subscriptionId) {
        this.logger.info?.({
          tag: 'DelegationDebug',
          stage: 'peer-responses',
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          subscriptionId,
          deliverableCount: deliverable.length,
          pendingDelegatedMessages: Array.isArray(session.pendingDelegatedMessages)
            ? session.pendingDelegatedMessages.length
            : 0
        }, 'DelegationDebug: peer responses processed');
      }
      if (deliverable.length && session.ws.readyState === WebSocket.OPEN) {
        for (const response of deliverable) {
          session.ws.send(JSON.stringify(response));
        }
      }
      if (pendingEntry) {
        pendingEntry.preferredPeer = preferredPeer || null;
        pendingEntry.latestSentAt = Date.now();
      }
      if (session.delegateReqToPeers && session.delegationReady && Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
        this.#scheduleDelegationFallback(session);
      }
    } catch (error) {
      if (subscriptionId) {
        this.logger.info?.({
          tag: 'DelegationDebug',
          stage: 'forward-error',
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          subscriptionId,
          error: error?.message || error,
          allowQueue,
          delegateReqToPeers: session?.delegateReqToPeers === true
        }, 'DelegationDebug: forwardLegacyMessage error');
      }
      const awaitingPeer = error?.message === 'delegated-session-awaiting-peer';
      if (allowQueue && awaitingPeer && session?.delegateReqToPeers) {
        if (pendingEntry) {
          pendingEntry.preferredPeer = preferredPeer || null;
          pendingEntry.queuedAt = Date.now();
        } else {
          if (!Array.isArray(session.pendingDelegatedMessages)) {
            session.pendingDelegatedMessages = [];
          }
          session.pendingDelegatedMessages.push({
            message: serialized,
            preferredPeer: preferredPeer || null,
            queuedAt: Date.now(),
            subscriptionId
          });
          pendingEntry = session.pendingDelegatedMessages[session.pendingDelegatedMessages.length - 1];
        }
        this.logger.debug?.({
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        }, 'Queued delegated relay message while awaiting peer');
        if (session.delegationReady) {
          this.#scheduleDelegationFallback(session);
        }
        return;
      }

      this.logger.warn?.({ relayKey: session.relayKey, error: error.message }, 'Forwarding message failed');
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
      } else {
        this.#cleanupSession(session.connectionKey);
      }
      if (session?.delegateReqToPeers && session.delegationReady && Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
        this.#scheduleDelegationFallback(session);
      }
    }
  }

  async #flushPendingDelegatedMessages(session, preferredPeer = null) {
    if (!session || !Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) {
      return;
    }

    const pending = session.pendingDelegatedMessages.splice(0);
    for (const entry of pending) {
      try {
        const targetPeer = entry?.preferredPeer ?? preferredPeer ?? null;
        await this.#forwardLegacyMessage(session, entry.message, targetPeer, {
          allowQueue: false,
          subscriptionId: entry?.subscriptionId || null
        });
        if (targetPeer && entry?.subscriptionId) {
          session.assignPeer?.(targetPeer, entry.subscriptionId);
        }
        if (!session?.peers?.length && session.delegateReqToPeers) {
          this.#scheduleDelegationFallback(session);
          break;
        }
      } catch (error) {
        this.logger.debug?.({
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          error: error?.message || error
        }, 'Failed to flush delegated message to peer');
        if (entry) {
          entry.retryCount = (entry.retryCount || 0) + 1;
          const maxRetries = 5;
          if (entry.retryCount <= maxRetries) {
            session.pendingDelegatedMessages.unshift(entry);
          } else {
            this.logger.warn?.({
              relayKey: session?.relayKey,
              connectionKey: session?.connectionKey,
              subscriptionId: entry?.subscriptionId || null
            }, 'Dropping delegated message after max retries');
          }
        }
        this.#scheduleDelegationFallback(session);
        break;
      }
    }

    if (!session.pendingDelegatedMessages.length) {
      this.#cancelDelegationFallback(session);
    }
  }

  #startEventChecking(session) {
    const run = async () => {
      if (!this.sessions.has(session.connectionKey)) {
        this.eventCheckTimers.delete(session.connectionKey);
        return;
      }

      try {
        if (session.localOnly) {
          await this.#pollLocalHyperbee(session);
        } else {
          const registration = await this.registrationStore.getRelay(session.relayKey);
          if (registration) {
            session.peers = this.#getUsablePeersFromRegistration(registration);
          }

          if (!session.localOnly
            && session.delegateReqToPeers
            && Array.isArray(session.pendingDelegatedMessages)
            && session.pendingDelegatedMessages.length
            && session.peers?.length) {
            await this.#flushPendingDelegatedMessages(session);
          }

          const events = await this.#withPeer(session, async (peerKey) => {
            return getEventsFromPeerHyperswarm(
              peerKey,
              session.relayKey,
              session.connectionKey,
              this.connectionPool,
              session.relayAuthToken
            );
          });

          if (Array.isArray(events) && events.length && session.ws.readyState === WebSocket.OPEN) {
            for (const event of events) {
              if (!event) continue;
              session.ws.send(JSON.stringify(event));
            }
          }
        }
      } catch (error) {
        this.logger.debug?.({ relayKey: session.relayKey, error: error.message }, 'Event polling error');
      } finally {
        const timer = setTimeout(run, 1000);
        timer.unref?.();
        this.eventCheckTimers.set(session.connectionKey, timer);
      }
    };

    const timer = setTimeout(run, 1000);
    timer.unref?.();
    this.eventCheckTimers.set(session.connectionKey, timer);
  }

  async #pollLocalHyperbee(session) {
    if (!this.hyperbeeAdapter?.hasReplica?.()) {
      return;
    }

    const snapshot = this.relayWebsocketController?.getSubscriptionSnapshot?.(session.connectionKey);
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
      return;
    }

    for (const entry of snapshot) {
      const { subscriptionId, filters, lastReturnedAt } = entry;
      try {
        const queryResult = await this.hyperbeeAdapter.query(filters || []);
        const events = Array.isArray(queryResult?.events) ? queryResult.events : [];
        if (!events.length) continue;

        const filtered = events
          .filter((event) => {
            const createdAt = Number(event?.created_at ?? 0);
            if (!Number.isFinite(lastReturnedAt)) return true;
            return createdAt > lastReturnedAt;
          })
          .sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0));

        if (!filtered.length || session.ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        let newestTimestamp = Number.isFinite(lastReturnedAt) ? lastReturnedAt : null;
        for (const event of filtered) {
          const createdAt = Number(event?.created_at ?? 0);
          if (Number.isFinite(createdAt)) {
            newestTimestamp = newestTimestamp === null ? createdAt : Math.max(newestTimestamp, createdAt);
          }
          session.ws.send(JSON.stringify(['EVENT', subscriptionId, event]));
        }

        if (Number.isFinite(newestTimestamp)) {
          this.relayWebsocketController?.updateSubscriptionCursor?.(session.connectionKey, subscriptionId, newestTimestamp);
        }
      } catch (error) {
        this.logger.debug?.({
          relayKey: session.relayKey,
          subscriptionId,
          error: error?.message || error
        }, 'Local Hyperbee poll failed');
      }
    }
  }

  #getPeersFromRegistration(registration) {
    if (!registration) return [];
    const { peers } = registration;
    if (!peers) return [];
    if (Array.isArray(peers)) {
      return peers.filter(Boolean);
    }
    if (peers instanceof Set) {
      return Array.from(peers).filter(Boolean);
    }
    return [];
  }

  #getLivePeersForRelay(relayKey) {
    if (!relayKey) return [];
    const livePeers = [];
    for (const [publicKey, meta] of this.peerMetadata.entries()) {
      if (!publicKey || !meta) continue;
      if (meta.unreachableSince) continue;
      if (!(meta.relays instanceof Set)) continue;
      if (meta.relays.has(relayKey)) {
        livePeers.push(publicKey);
      }
    }
    return livePeers;
  }

  #getUsablePeersFromRegistration(registration) {
    if (!registration) return [];
    const relayKey = registration.relayKey
      || registration.identifier
      || registration.metadata?.identifier
      || null;

    const storedPeers = this.#getPeersFromRegistration(registration);
    const livePeers = relayKey ? this.#getLivePeersForRelay(relayKey) : [];
    const combined = new Set([...storedPeers, ...livePeers]);
    return Array.from(combined).filter((peer) => this.#isPeerUsable(peer));
  }

  #syncSessionsWithRelay(relayKey, registration) {
    if (!relayKey || !this.sessions.size) return;

    const peers = this.#getUsablePeersFromRegistration(registration);
    const peerList = peers.length ? Array.from(new Set(peers)) : [];

    if (peerList.length) {
      const currentIndex = this.relayPeerIndex.get(relayKey) || 0;
      this.relayPeerIndex.set(relayKey, currentIndex % peerList.length);
    } else {
      this.relayPeerIndex.delete(relayKey);
    }

    for (const session of this.sessions.values()) {
      if (!session || session.relayKey !== relayKey) continue;

      const previousPeerKey = session.peerKey || null;
      session.peers = peerList.slice();

      if (session.peers.length) {
        if (!session.peers.includes(previousPeerKey)) {
          session.peerIndex = 0;
          session.peerKey = session.peers[0];
        } else {
          session.peerIndex = session.peers.indexOf(previousPeerKey);
          session.peerKey = previousPeerKey;
        }
        session.localOnly = false;
        if (Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
          this.#cancelDelegationFallback(session);
          this.#flushPendingDelegatedMessages(session).catch((error) => {
            this.logger?.debug?.('Failed to flush pending messages after peer sync', {
              relayKey,
              connectionKey: session.connectionKey,
              error: error?.message || error
            });
          });
        }
      } else {
        session.peerIndex = 0;
        session.peerKey = null;
        session.localOnly = this.#supportsLocalRelay(registration);
      }
    }
  }

  #supportsLocalRelay(registration) {
    if (!registration) return false;
    if (!this.relayHost) return false;
    const metadata = registration.metadata || {};
    const delegateReqToPeers = metadata.delegateReqToPeers === true
      || registration.gatewayReplica?.delegateReqToPeers === true;
    if (delegateReqToPeers) {
      const peerCount = this.#getUsablePeersFromRegistration(registration).length;
      if (peerCount > 0) return false;
    }

    if (registration.relayKey === this.internalRelayKey) return true;
    if (registration.identifier === this.internalRelayKey) return true;
    if (metadata.identifier === this.internalRelayKey) return true;
    return metadata.isGatewayReplica === true;
  }

  #selectPeer(registration) {
    const peers = this.#getUsablePeersFromRegistration(registration);
    if (!peers.length) return null;

    const relayKey = registration.relayKey || registration.identifier || peers[0];
    const currentIndex = this.relayPeerIndex.get(relayKey) || 0;
    const peerKey = peers[currentIndex % peers.length];
    this.relayPeerIndex.set(relayKey, (currentIndex + 1) % peers.length);

    return {
      peerKey,
      peers,
      index: peers.indexOf(peerKey)
    };
  }

  #currentPeer(session) {
    if (!session.peers?.length) return null;
    const idx = session.peerIndex % session.peers.length;
    return session.peers[idx];
  }

  #advancePeer(session) {
    if (!session.peers?.length) return;
    session.peerIndex = (session.peerIndex + 1) % session.peers.length;
    session.peerKey = this.#currentPeer(session);
  }

  async #withRelayPeerKey(relayKey, handler) {
    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      const error = new Error('Relay not registered with gateway');
      error.statusCode = 404;
      throw error;
    }

    const peers = this.#getUsablePeersFromRegistration(registration);
    if (!peers.length) {
      const error = new Error('Relay has no available peers');
      error.statusCode = 503;
      throw error;
    }

    const startIndex = this.relayPeerIndex.get(relayKey) || 0;
    let lastError = null;

    for (let attempt = 0; attempt < peers.length; attempt += 1) {
      const index = (startIndex + attempt) % peers.length;
      const peerKey = peers[index];

      if (!this.#isPeerUsable(peerKey)) {
        this.logger?.debug?.('Skipping unreachable peer for relay request', {
          relayKey,
          peerKey
        });
        continue;
      }

      try {
        await this.connectionPool.getConnection(peerKey);
        this.relayPeerIndex.set(relayKey, (index + 1) % peers.length);
        this.#markPeerReachable(peerKey, { relayKey, timestamp: Date.now() });
        return handler(peerKey, registration);
      } catch (error) {
        lastError = error;
        this.logger.warn?.({
          relayKey,
          peerKey,
          error: error?.message || error
        }, 'Failed to use peer for drive request');
        this.#markPeerUnreachable(peerKey, {
          reason: 'get-connection-failed',
          error: error?.message || error
        });
      }
    }

    if (lastError) {
      throw lastError;
    }

    const error = new Error('No peers available for relay');
    error.statusCode = 503;
    throw error;
  }

  async #resolveRelayTarget(identifier) {
    if (!identifier) return null;

    const aliasRelayKey = this.#resolveRelayKeyFromPath(identifier);
    if (aliasRelayKey) {
      const registration = await this.registrationStore.getRelay(aliasRelayKey);
      if (registration) {
        const driveIdentifier = this.#extractDriveIdentifier(registration, aliasRelayKey);
        if (driveIdentifier) {
          return {
            relayKey: aliasRelayKey,
            driveIdentifier
          };
        }
      }
    }

    const direct = await this.registrationStore.getRelay(identifier);
    if (direct) {
      const driveIdentifier = this.#extractDriveIdentifier(direct, identifier);
      if (!driveIdentifier) return null;
      return {
        relayKey: identifier,
        driveIdentifier
      };
    }

    const allKeys = typeof this.registrationStore.getAllRelayKeys === 'function'
      ? await this.registrationStore.getAllRelayKeys()
      : Array.from(this.registrationStore.items?.keys?.() || []);

    for (const relayKey of allKeys) {
      const registration = await this.registrationStore.getRelay(relayKey);
      if (!registration) continue;

      const driveIdentifier = this.#extractDriveIdentifier(registration, relayKey);
      if (!driveIdentifier) continue;

      if (identifier === driveIdentifier) {
        return { relayKey, driveIdentifier };
      }

      const gatewayPath = this.#toGatewayPath(driveIdentifier);
      if (gatewayPath && identifier === gatewayPath) {
        return { relayKey, driveIdentifier };
      }

      const metadataPath = this.#normalizePathValue(registration?.metadata?.gatewayPath);
      if (metadataPath) {
        if (identifier === metadataPath) {
          return { relayKey, driveIdentifier };
        }
        const colonFromMetadata = this.#toColonIdentifier(metadataPath);
        if (colonFromMetadata && identifier === colonFromMetadata) {
          return { relayKey, driveIdentifier: colonFromMetadata };
        }
      }
      const metadataAliases = Array.isArray(registration?.metadata?.pathAliases)
        ? registration.metadata.pathAliases
        : [];
      for (const alias of metadataAliases) {
        const normalizedAlias = this.#normalizePathValue(alias);
        if (!normalizedAlias) continue;
        if (identifier === normalizedAlias) {
          return { relayKey, driveIdentifier };
        }
        const colonFromAlias = this.#toColonIdentifier(normalizedAlias);
        if (colonFromAlias && identifier === colonFromAlias) {
          return { relayKey, driveIdentifier: colonFromAlias };
        }
      }

      const connectionUrl = registration?.metadata?.connectionUrl;
      if (connectionUrl) {
        try {
          const parsed = new URL(connectionUrl);
          const path = this.#normalizePathValue(parsed.pathname);
          if (path) {
            if (identifier === path) {
              return { relayKey, driveIdentifier };
            }
            const colonPath = this.#toColonIdentifier(path);
            if (colonPath && identifier === colonPath) {
              return { relayKey, driveIdentifier: colonPath };
            }
          }
        } catch (_) {}
      }
    }

    return null;
  }

  #extractDriveIdentifier(registration, fallbackKey) {
    const identifier = registration?.identifier || registration?.publicIdentifier;
    if (typeof identifier === 'string' && identifier.trim()) {
      return identifier.trim();
    }

    const gatewayPath = this.#normalizePathValue(registration?.metadata?.gatewayPath);
    if (gatewayPath) {
      const colon = this.#toColonIdentifier(gatewayPath);
      if (colon) return colon;
    }

    const fallback = typeof fallbackKey === 'string' && fallbackKey.trim()
      ? fallbackKey.trim()
      : null;
    if (fallback && fallback.includes(':')) return fallback;
    if (fallback) {
      const colonFallback = this.#toColonIdentifier(fallback);
      if (colonFallback) return colonFallback;
    }
    return fallback;
  }

  #normalizePathValue(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  #toGatewayPath(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (trimmed.includes('/')) {
      return this.#normalizePathValue(trimmed);
    }
    const idx = trimmed.indexOf(':');
    if (idx !== -1) {
      return `${trimmed.slice(0, idx)}/${trimmed.slice(idx + 1)}`;
    }
    return trimmed;
  }

  #toColonIdentifier(value) {
    if (!value || typeof value !== 'string') return null;
    const normalized = this.#normalizePathValue(value);
    if (!normalized) return null;
    if (normalized.includes(':')) return normalized;
    const idx = normalized.indexOf('/');
    if (idx !== -1) {
      return `${normalized.slice(0, idx)}:${normalized.slice(idx + 1)}`;
    }
    return normalized;
  }

  async #withPeer(session, handler, options = {}) {
    const sessionSupportsDelegation = session?.delegateReqToPeers === true
      && session.localOnly === true
      && Array.isArray(session.peers)
      && session.peers.length > 0;

    if (!session.peers?.length) {
      if (sessionSupportsDelegation) {
        this.logger?.debug?.('Delegated session waiting for peer availability', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey
        });
        throw new Error('delegated-session-awaiting-peer');
      }
      throw new Error('No peers registered for relay');
    }

    let attempts = 0;
    let lastError = null;

    const preferredPeer = options.preferredPeer;
    if (preferredPeer && session.peers.includes(preferredPeer)) {
      session.peerIndex = session.peers.indexOf(preferredPeer);
      session.peerKey = preferredPeer;
    }

    while (attempts < session.peers.length) {
      const peerKey = this.#currentPeer(session);
      if (!peerKey) break;

      if (!this.#isPeerUsable(peerKey)) {
        this.logger?.debug?.('Skipping unreachable peer for session', {
          relayKey: session.relayKey,
          peerKey
        });
        this.#advancePeer(session);
        attempts += 1;
        continue;
      }

      try {
        const result = await handler(peerKey);
        session.peerKey = peerKey;
        this.#markPeerReachable(peerKey, { relayKey: session.relayKey, timestamp: Date.now() });
        this.logger.info?.({
          relayKey: session.relayKey,
          peerKey
        }, 'Peer operation succeeded');
        if (session.delegateReqToPeers) {
          session.localOnly = false;
          this.#cancelDelegationFallback(session);
        }
        return result;
      } catch (error) {
        lastError = error;
        this.logger.warn?.({
          relayKey: session.relayKey,
          peerKey,
          error: error.message
        }, 'Peer operation failed');
        this.logger.info?.({
          relayKey: session.relayKey,
          previousPeer: peerKey
        }, 'Advancing to next peer after failure');
        this.#advancePeer(session);
        attempts += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('No peers available for relay');
  }

  #assignPeerForSubscription(session, peerKey, subscriptionId) {
    if (!peerKey) return;
    if (!Array.isArray(session.peers)) {
      session.peers = [];
    }
    if (!session.peers.includes(peerKey)) {
      session.peers.push(peerKey);
    }
    session.subscriptionPeers?.set?.(subscriptionId, peerKey);
    session.peerIndex = session.peers.indexOf(peerKey);
    session.peerKey = peerKey;
  }

  async #handlePeerTelemetry({ publicKey, payload }) {
    if (!publicKey || !payload) return;

    const metrics = {
      peerId: publicKey,
      latencyMs: Number(payload.latencyMs) || 0,
      inFlightJobs: Number(payload.inFlightJobs) || 0,
      failureRate: Number(payload.failureRate) || 0,
      hyperbeeVersion: payload.hyperbeeVersion,
      hyperbeeLag: payload.hyperbeeLag,
      queueDepth: payload.queueDepth,
      reportedAt: Number(payload.reportedAt) || Date.now(),
      tokenExpiresAt: payload.tokenExpiresAt
    };
    this.dispatcher?.reportPeerMetrics(publicKey, metrics);

    const entry = this.peerMetadata.get(publicKey) || {};
    entry.telemetry = payload;
    entry.lastTelemetryAt = Date.now();
    this.peerMetadata.set(publicKey, entry);

    const handshake = entry.handshake || {};
    const isReplica = handshake.gatewayReplica === true
      || handshake.role === 'gateway-replica'
      || payload.gatewayReplica === true;

    if (isReplica || payload.hyperbeeKey || payload.hyperbeeLag !== undefined) {
      const gatewayRelay = {
        hyperbeeKey: payload.hyperbeeKey || handshake.hyperbeeKey || null,
        discoveryKey: payload.hyperbeeDiscoveryKey || handshake.hyperbeeDiscoveryKey || null,
        replicationTopic: payload.replicationTopic || null
      };

      const replicaMetrics = {
        length: Number(payload.hyperbeeLength) || Number(handshake.hyperbeeLength) || 0,
        contiguousLength: Number(payload.hyperbeeContiguousLength) || Number(handshake.hyperbeeContiguousLength) || 0,
        lag: Number(payload.hyperbeeLag) || Number(handshake.hyperbeeLag) || 0,
        version: Number(payload.hyperbeeVersion) || Number(handshake.hyperbeeVersion) || 0,
        updatedAt: Number(payload.hyperbeeLastUpdatedAt) || Number(payload.reportedAt) || Date.now()
      };

      const delegateReqToPeers = typeof payload.delegateReqToPeers === 'boolean'
        ? payload.delegateReqToPeers
        : (typeof handshake.delegateReqToPeers === 'boolean' ? handshake.delegateReqToPeers : null);

      try {
        await this.#upsertInternalReplicaPeer(publicKey, {
          gatewayRelay,
          replicaMetrics,
          replicaTelemetry: payload,
          delegateReqToPeers
        });
        this.#emitPublicGatewayStatus();
      } catch (error) {
        this.logger?.warn?.('Failed to update replica telemetry for peer', {
          peer: publicKey,
          error: error?.message || error
        });
      }
    }
  }

  #isPeerUsable(peerKey) {
    if (!peerKey || typeof peerKey !== 'string') return false;
    const metadata = this.peerMetadata.get(peerKey);
    if (!metadata) return true;
    if (metadata.unreachableSince) {
      return false;
    }
    return true;
  }

  #markPeerReachable(peerKey, { relayKey = null, timestamp = Date.now(), lastHealthyAt = null } = {}) {
    if (!peerKey) return;
    const entry = this.peerMetadata.get(peerKey) || {};
    entry.lastSeen = timestamp;
    entry.unreachableSince = null;
    entry.lastHealthyAt = lastHealthyAt || entry.lastHealthyAt || timestamp;
    entry.lastDisconnectReason = null;
    entry.lastError = null;
    entry.removalInProgress = false;
    if (!(entry.relays instanceof Set)) {
      entry.relays = new Set(entry.relays || []);
    }
    if (relayKey) {
      entry.relays.add(relayKey);
    }
    this.peerMetadata.set(peerKey, entry);
  }

  #markPeerUnreachable(peerKey, { reason = 'unknown', error = null } = {}) {
    if (!peerKey) return;
    const entry = this.peerMetadata.get(peerKey) || {};
    const timestamp = Date.now();
    entry.unreachableSince = entry.unreachableSince || timestamp;
    entry.lastDisconnectReason = reason;
    if (error) {
      entry.lastError = error instanceof Error ? error.message : error;
    }
    if (entry.removalInProgress) {
      this.peerMetadata.set(peerKey, entry);
      return;
    }
    entry.removalInProgress = true;
    this.peerMetadata.set(peerKey, entry);
    this.#purgePeerFromSessions(peerKey);
    void this.#removePeerFromAllRegistrations(peerKey, {
      reason,
      error,
      timestamp,
      candidateRelays: entry.relays instanceof Set ? Array.from(entry.relays) : null
    }).finally(() => {
      const current = this.peerMetadata.get(peerKey);
      if (current) {
        current.removalInProgress = false;
        this.peerMetadata.set(peerKey, current);
      }
    });
  }

  #purgePeerFromSessions(peerKey) {
    for (const session of this.sessions.values()) {
      if (!Array.isArray(session.peers) || !session.peers.length) continue;
      const originalLength = session.peers.length;
      session.peers = session.peers.filter((value) => value !== peerKey);
      if (session.subscriptionPeers instanceof Map) {
        for (const [subscriptionId, assignedPeer] of session.subscriptionPeers.entries()) {
          if (assignedPeer === peerKey) {
            session.subscriptionPeers.delete(subscriptionId);
          }
        }
      }
      if (originalLength !== session.peers.length) {
        session.peerIndex = session.peerIndex || 0;
        if (session.peerKey === peerKey) {
          session.peerIndex = 0;
          session.peerKey = this.#currentPeer(session);
        } else if (session.peerIndex >= session.peers.length) {
          session.peerIndex = 0;
        }
      }
    }
  }

  async #listAllRelayKeys() {
    if (typeof this.registrationStore.getAllRelayKeys === 'function') {
      try {
        const keys = await this.registrationStore.getAllRelayKeys();
        if (Array.isArray(keys)) {
          return keys;
        }
      } catch (error) {
        this.logger?.debug?.('Failed to list relay keys via store implementation', {
          error: error?.message || error
        });
      }
    }

    if (this.registrationStore?.items instanceof Map) {
      return Array.from(this.registrationStore.items.keys());
    }

    return [];
  }

  async #removePeerFromAllRegistrations(peerKey, { reason = 'unknown', error = null, candidateRelays = null } = {}) {
    if (!peerKey) return;
    let relayKeys = Array.isArray(candidateRelays) && candidateRelays.length
      ? Array.from(new Set(candidateRelays))
      : null;
    if (!relayKeys) {
      relayKeys = await this.#listAllRelayKeys();
    }

    if (!Array.isArray(relayKeys) || !relayKeys.length) return;

    const removedRelays = [];
    for (const relayKey of relayKeys) {
      const metadataEntry = this.peerMetadata.get(peerKey);
      if (!metadataEntry?.unreachableSince) {
        this.logger?.debug?.('Peer removal aborted – peer reachable again', {
          peer: peerKey,
          relayKey,
          reason
        });
        break;
      }

      try {
        const registration = await this.registrationStore.getRelay(relayKey);
        if (!registration) continue;

        const peers = this.#getPeersFromRegistration(registration);
        if (!peers.includes(peerKey)) continue;

        const updatedPeers = peers.filter((value) => value !== peerKey);
        const metadata = { ...(registration.metadata || {}) };

        if (metadata.peerStates && typeof metadata.peerStates === 'object') {
          const peerStates = { ...metadata.peerStates };
          delete peerStates[peerKey];
          metadata.peerStates = peerStates;
        }

        const record = {
          ...registration,
          peers: updatedPeers,
          metadata,
          updatedAt: Date.now()
        };

        await this.registrationStore.upsertRelay(relayKey, record);
        await this.#storeMirrorMetadataPayload(relayKey, this.#buildMirrorMetadataPayload(record, relayKey));
        this.#syncSessionsWithRelay(relayKey, record);

        if (!updatedPeers.length) {
          this.relayPeerIndex.delete(relayKey);
        } else {
          const nextIndex = (this.relayPeerIndex.get(relayKey) || 0) % updatedPeers.length;
          this.relayPeerIndex.set(relayKey, nextIndex);
        }

        this.logger?.info?.('Removed unreachable peer from relay registration', {
          relayKey,
          peer: peerKey,
          reason
        });
        removedRelays.push(relayKey);
      } catch (removalError) {
        this.logger?.warn?.('Failed to remove unreachable peer from relay registration', {
          relayKey,
          peer: peerKey,
          error: removalError?.message || removalError
        });
      }
    }

    if (!removedRelays.length) {
      return;
    }

    const entry = this.peerMetadata.get(peerKey);
    if (entry?.relays instanceof Set) {
      removedRelays.forEach((relayKey) => entry.relays.delete(relayKey));
      this.peerMetadata.set(peerKey, entry);
    }
  }

  #shouldPrunePeerOnDisconnect(reason) {
    if (!reason) return true;
    const transientReasons = new Set(['manual-destroy', 'duplicate-replacement']);
    return !transientReasons.has(reason);
  }

  #onPoolConnectionClosed({ publicKey, reason, error }) {
    if (!publicKey) return;
    const entry = this.peerMetadata.get(publicKey) || {};
    entry.lastDisconnectAt = Date.now();
    entry.lastDisconnectReason = reason || 'unknown';
    if (error) {
      entry.lastError = error instanceof Error ? error.message : error;
    }
    this.peerMetadata.set(publicKey, entry);

    if (this.#shouldPrunePeerOnDisconnect(reason)) {
      if (reason === 'health-check-failed' && entry.unreachableSince) {
        return;
      }
      this.#markPeerUnreachable(publicKey, { reason, error });
    }
  }

  #onPoolConnectionHealth({ publicKey, healthy, lastHealthyAt, error }) {
    if (!publicKey) return;
    if (healthy) {
      this.#markPeerReachable(publicKey, {
        timestamp: lastHealthyAt || Date.now(),
        lastHealthyAt: lastHealthyAt || Date.now()
      });
      return;
    }
    this.#markPeerUnreachable(publicKey, {
      reason: 'health-check-failed',
      error: error?.message || error
    });
  }

  #getRelayHostInfo() {
    if (!this.relayHost) {
      return null;
    }
    const registrationConfig = this.config.registration || {};
    const dispatcherConfig = this.config.dispatcher || {};
    const sanitizePositive = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return null;
      return Math.round(num);
    };
    const dispatcherInfo = {
      maxConcurrentJobsPerPeer: sanitizePositive(dispatcherConfig.maxConcurrentJobsPerPeer),
      inFlightWeight: sanitizePositive(dispatcherConfig.inFlightWeight),
      latencyWeight: sanitizePositive(dispatcherConfig.latencyWeight),
      failureWeight: sanitizePositive(dispatcherConfig.failureWeight),
      reassignOnLagBlocks: sanitizePositive(dispatcherConfig.reassignOnLagBlocks),
      circuitBreakerThreshold: sanitizePositive(dispatcherConfig.circuitBreakerThreshold),
      circuitBreakerDurationMs: sanitizePositive(dispatcherConfig.circuitBreakerDurationMs)
    };
    const hasDispatcher = Object.values(dispatcherInfo).some((value) => value !== null);

    const canonicalGatewayPath = this.#normalizePathValue(this.relayCanonicalPath)
      || this.#toGatewayPath(this.internalRelayKey)
      || null;
    const aliasSet = new Set(
      (this.relayPathAliases || [])
        .map((value) => this.#normalizePathValue(value))
        .filter(Boolean)
    );
    if (canonicalGatewayPath) {
      aliasSet.delete(canonicalGatewayPath);
    }

    return {
      hyperbeeKey: this.relayHost.getPublicKey(),
      discoveryKey: this.relayHost.getDiscoveryKey(),
      replicationTopic: this.relayConfig?.replicationTopic || null,
      defaultTokenTtl: sanitizePositive(registrationConfig.defaultTokenTtl),
      tokenRefreshWindowSeconds: sanitizePositive(registrationConfig.tokenRefreshWindowSeconds),
      dispatcher: hasDispatcher ? dispatcherInfo : null,
      gatewayPath: canonicalGatewayPath || null,
      pathAliases: Array.from(aliasSet)
    };
  }

  #getBlindPeerSummary(statusOverride = null) {
    const status = statusOverride || this.blindPeerService?.getStatus?.() || null;
    const trustedPeers = this.blindPeerService?.getTrustedPeers?.() || [];
    return {
      enabled: !!status?.enabled,
      running: !!status?.running,
      storageUsageBytes: status?.digest?.bytesAllocated ?? null,
      trustedPeerCount: status?.trustedPeerCount ?? trustedPeers.length,
      publicKey: status?.publicKey || this.blindPeerService?.getPublicKeyHex?.() || null,
      encryptionKey: status?.encryptionKey || this.blindPeerService?.getEncryptionKeyHex?.() || null,
      trustedPeers,
      hygiene: status?.hygiene || null,
      metadataTracked: status?.metadata?.trackedCores ?? null,
      ownership: status?.ownership || null,
      dispatcherAssignments: status?.dispatcherAssignments
        || this.blindPeerService?.getDispatcherAssignmentsSnapshot?.()
        || this.#getDispatcherAssignmentsSnapshot()
    };
  }

  #coerceTimestamp(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  #emitPublicGatewayStatus() {
    this.publicGatewayStatusUpdatedAt = Date.now();
    if (!this.logger?.debug) return;

    let relayCount;
    const storeItems = this.registrationStore?.items;
    if (storeItems && typeof storeItems.size === 'number') {
      relayCount = storeItems.size;
    }

    const peerCount = (() => {
      try {
        return this.connectionPool?.connections?.size;
      } catch (_) {
        return undefined;
      }
    })();

    this.logger.debug({
      relayCount,
      peerCount,
      updatedAt: this.publicGatewayStatusUpdatedAt
    }, '[PublicGateway] Replica status updated');
  }

  #handleDispatcherAssignment({ jobId, peerId, assignedAt, job }) {
    const relayKey = job?.relayKey || job?.requester?.relayKey || null;
    const filters = Array.isArray(job?.filters) ? job.filters : [];
    const entry = {
      jobId,
      peerKey: peerId || null,
      relayKey,
      filters,
      status: 'assigned',
      assignedAt: assignedAt || Date.now(),
      requester: job?.requester || null
    };
    this.dispatcherAssignments.set(jobId, entry);
    if (peerId) {
      this.blindPeerService?.addTrustedPeer(peerId);
    }
    this.blindPeerService?.recordDispatcherAssignment?.({
      jobId,
      peerKey: peerId || null,
      relayKey,
      filters,
      requester: job?.requester || null
    });
    this.#emitPublicGatewayStatus();
  }

  #handleDispatcherAcknowledge({ jobId, peerId, outcome, job }) {
    this.#completeDispatcherAssignment(jobId, 'acknowledged', {
      peerKey: peerId || null,
      outcome,
      job
    });
  }

  #handleDispatcherFailure({ jobId, peerId, reason, job }) {
    this.#completeDispatcherAssignment(jobId, 'failed', {
      peerKey: peerId || null,
      reason,
      job
    });
  }

  #completeDispatcherAssignment(jobId, status, details = {}) {
    if (!jobId) return;
    const existing = this.dispatcherAssignments.get(jobId) || {
      jobId,
      relayKey: details?.job?.relayKey || details?.job?.requester?.relayKey || null,
      peerKey: details?.peerKey || null,
      filters: Array.isArray(details?.job?.filters) ? details.job.filters : [],
      assignedAt: Date.now(),
      requester: details?.job?.requester || null
    };
    existing.status = status;
    existing.completedAt = Date.now();
    existing.details = details || null;
    this.dispatcherAssignments.set(jobId, existing);

    this.blindPeerService?.clearDispatcherAssignment?.(jobId, {
      status,
      details,
      assignment: existing
    });

    this.#scheduleDispatcherAssignmentCleanup(jobId);
    this.#emitPublicGatewayStatus();
  }

  #scheduleDispatcherAssignmentCleanup(jobId, delayMs = 120000) {
    if (!jobId) return;
    if (this.dispatcherAssignmentTimers.has(jobId)) {
      clearTimeout(this.dispatcherAssignmentTimers.get(jobId));
    }
    const timer = setTimeout(() => {
      this.dispatcherAssignmentTimers.delete(jobId);
      this.dispatcherAssignments.delete(jobId);
      this.#emitPublicGatewayStatus();
    }, delayMs);
    timer.unref?.();
    this.dispatcherAssignmentTimers.set(jobId, timer);
  }

  #getDispatcherAssignmentsSnapshot() {
    return Array.from(this.dispatcherAssignments.values())
      .sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0));
  }

  #handleBlindPeerStatus(req, res) {
    try {
      const query = req?.query || {};
      const toBool = (value) => {
        if (value === undefined || value === null) return false;
        const str = String(value).trim().toLowerCase();
        return str === '1' || str === 'true' || str === 'yes';
      };
      const parseLimit = (value, fallback) => {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
      };

      const includeDetail = toBool(query.detail);
      const ownerLimit = parseLimit(query.owners, includeDetail ? 50 : 10);
      const coresPerOwner = parseLimit(query.coresPerOwner, 25);
      const mirrorLimit = parseLimit(query.mirrors, includeDetail ? 100 : 25);
      const includeMirrorCores = toBool(query.mirrorCores);

      const status = this.blindPeerService?.getStatus?.({
        ownerLimit,
        includeCores: includeDetail,
        coresPerOwner,
        mirrorLimit,
        includeMirrorCores
      }) || { enabled: false };
      const summary = this.#getBlindPeerSummary(status);

      const response = {
        status,
        summary,
        configured: !!this.config?.blindPeer?.enabled
      };

      if (includeDetail) {
        response.detail = {
          ownership: status?.ownership || null,
          mirrors: status?.mirrors || null
        };
      } else {
        response.mirrors = status?.mirrors || null;
      }

      res.json(response);
    } catch (error) {
      this.logger?.error?.('[PublicGateway] Failed to compose blind-peer status response', {
        err: error?.message || error
      });
      res.status(500).json({ error: 'blind-peer-status-unavailable' });
    }
  }

  #handleBlindPeerReplicas(req, res) {
    if (!this.blindPeerService) {
      return res.status(503).json({ error: 'blind-peer-disabled' });
    }
    const query = req?.query || {};
    const toBool = (value) => {
      if (value === undefined || value === null) return false;
      const str = String(value).trim().toLowerCase();
      return str === '1' || str === 'true' || str === 'yes';
    };
    const parseLimit = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
    };
    try {
      const includeCores = toBool(query.cores);
      const limit = parseLimit(query.limit, 100);
      let replicas = null;
      if (this.blindPeerReplicaManager) {
        replicas = this.blindPeerReplicaManager.getReplicaSnapshot({
          includeInternals: includeCores,
          limit
        });
      } else {
        replicas = this.blindPeerService?.getMirrorReadinessSnapshot?.({
          includeCores,
          limit
        }) || [];
      }
      res.json({ replicas });
    } catch (error) {
      this.logger?.error?.('[PublicGateway] Failed to compose blind-peer replica response', {
        err: error?.message || error
      });
      res.status(500).json({ error: 'blind-peer-replicas-unavailable' });
    }
  }

  async #handleBlindPeerGc(req, res) {
    if (!this.blindPeerService) {
      return res.status(503).json({ error: 'blind-peer-disabled' });
    }
    const reasonRaw = req?.body?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim().length
      ? reasonRaw.trim()
      : 'manual';
    try {
      const result = await this.blindPeerService.runHygiene(reason);
      res.json({ ok: true, result });
    } catch (error) {
      this.logger?.error?.('[PublicGateway] Manual blind peer GC failed', {
        err: error?.message || error
      });
      res.status(500).json({ error: 'blind-peer-gc-failed', message: error?.message || String(error) });
    }
  }

  async #handleBlindPeerDelete(req, res) {
    if (!this.blindPeerService) {
      return res.status(503).json({ error: 'blind-peer-disabled' });
    }
    const keyParam = req?.params?.key;
    if (!keyParam || typeof keyParam !== 'string' || !keyParam.trim()) {
      return res.status(400).json({ error: 'core-key-required' });
    }
    const reasonParam = typeof req?.query?.reason === 'string' ? req.query.reason
      : (typeof req?.body?.reason === 'string' ? req.body.reason : null);
    const reason = reasonParam && reasonParam.trim().length ? reasonParam.trim() : 'manual';
    try {
      await this.blindPeerService.deleteMirror(keyParam, { reason });
      res.json({ ok: true, key: keyParam });
    } catch (error) {
      const isInputError = error?.message === 'invalid-core-key';
      if (isInputError) {
        return res.status(400).json({ error: 'invalid-core-key', message: 'Provided blind peer core key is invalid' });
      }
      this.logger?.warn?.('[PublicGateway] Blind peer mirror deletion failed', {
        key: keyParam,
        reason,
        err: error?.message || error
      });
      res.status(500).json({ error: 'blind-peer-delete-failed', message: error?.message || String(error) });
    }
  }

  #verifySignedPayload(payload, signature) {
    if (!this.sharedSecret) return false;
    if (!payload || typeof payload !== 'object' || !signature) return false;
    try {
      return verifySignature(payload, signature, this.sharedSecret);
    } catch (error) {
      this.logger?.warn?.('Signed payload verification failed', { error: error?.message || error });
      return false;
    }
  }

  async #handleTokenIssue(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    const relayAuthToken = payload?.relayAuthToken;
    if (!relayKey || !relayAuthToken) {
      return res.status(400).json({ error: 'relayKey and relayAuthToken are required' });
    }
    const relayKeyType = this.#isHexRelayKey(relayKey) ? 'hex' : 'alias';
    this.logger?.info?.('[PublicGateway] Relay token issue request', {
      relayKey,
      relayKeyType
    });

    try {
      const result = await this.tokenService.issueToken(relayKey, {
        relayAuthToken,
        pubkey: payload?.pubkey || null,
        scope: payload?.scope,
        ttlSeconds: payload?.ttlSeconds
      });
      this.tokenMetrics.issueCounter.inc({ result: 'success' });
      return res.json(result);
    } catch (error) {
      this.logger?.error?.('Failed to issue relay token', {
        relayKey,
        relayKeyType,
        error: error?.message || error
      });
      this.tokenMetrics.issueCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to issue token' });
    }
  }

  async #handleTokenRefresh(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    const token = payload?.token;
    if (!relayKey || !token) {
      return res.status(400).json({ error: 'relayKey and token are required' });
    }
    const relayKeyType = this.#isHexRelayKey(relayKey) ? 'hex' : 'alias';
    this.logger?.info?.('[PublicGateway] Relay token refresh request', {
      relayKey,
      relayKeyType
    });

    try {
      const result = await this.tokenService.refreshToken(relayKey, {
        token,
        ttlSeconds: payload?.ttlSeconds
      });
      this.tokenMetrics.refreshCounter.inc({ result: 'success' });
      return res.json(result);
    } catch (error) {
      this.logger?.warn?.('Failed to refresh relay token', {
        relayKey,
        relayKeyType,
        error: error?.message || error
      });
      this.tokenMetrics.refreshCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to refresh token' });
    }
  }

  async #handleTokenRevoke(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    if (!relayKey) {
      return res.status(400).json({ error: 'relayKey is required' });
    }
    const relayKeyType = this.#isHexRelayKey(relayKey) ? 'hex' : 'alias';
    this.logger?.info?.('[PublicGateway] Relay token revoke request', {
      relayKey,
      relayKeyType
    });

    try {
      const result = await this.tokenService.revokeToken(relayKey, { reason: payload?.reason });
      this.tokenMetrics.revokeCounter.inc({ result: 'success' });
      const disconnected = this.#broadcastTokenRevocation(relayKey, {
        reason: payload?.reason || null,
        sequence: result?.sequence || null
      });
      return res.json({ status: 'revoked', disconnected, sequence: result?.sequence || null });
    } catch (error) {
      this.logger?.warn?.('Failed to revoke relay token', {
        relayKey,
        relayKeyType,
        error: error?.message || error
      });
      this.tokenMetrics.revokeCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to revoke token' });
    }
  }

  #broadcastTokenRevocation(relayKey, { reason, sequence } = {}) {
    let disconnected = 0;
    for (const [connectionKey, session] of this.sessions.entries()) {
      if (session.relayKey !== relayKey) continue;
      disconnected += 1;
      if (session.ws?.readyState === WebSocket.OPEN) {
        const controlFrame = ['TOKEN', 'REVOKED', {
          reason: reason || 'revoked',
          sequence: sequence || null
        }];
        try {
          session.ws.send(JSON.stringify(controlFrame));
        } catch (error) {
          this.logger?.debug?.('Failed to send token revocation control frame', {
            relayKey,
            error: error?.message || error
          });
        }
        try {
          session.ws.close(4403, 'Token revoked');
        } catch (_) {}
      }
      this.#cleanupSession(connectionKey);
    }
    return disconnected;
  }

  async #handleGatewayHyperswarmRegistration(peerKey, request) {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET';
    if (method !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'method-not-allowed' }))
      };
    }

    let payload = {};
    if (request?.body && request.body.length) {
      try {
        payload = JSON.parse(Buffer.from(request.body).toString());
      } catch (error) {
        this.logger.warn?.({
          peer: peerKey,
          error: error?.message || error
        }, 'Failed to parse Hyperswarm registration payload');
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'invalid-json' }))
        };
      }
    }

    if (!payload || typeof payload !== 'object') {
      payload = {};
    }

    payload.publicKey = payload.publicKey || peerKey;

    const now = Date.now();
    const relays = Array.isArray(payload.relays) ? payload.relays : [];

    for (const entry of relays) {
      let relayKey = null;
      let relayPayload = entry;
      if (typeof entry === 'string') {
        relayKey = entry;
        relayPayload = { identifier: entry };
      } else if (entry && typeof entry === 'object') {
        relayKey = entry.identifier || entry.relayKey || null;
      }
      if (!relayKey) continue;

      try {
        await this.#mergeRelayRegistration(relayKey, peerKey, relayPayload, payload.gatewayReplica, now);
      } catch (error) {
        this.logger.error?.({
          relayKey,
          peer: peerKey,
          error: error?.message || error
        }, 'Failed to merge relay registration from peer');
      }
    }

    if (payload.gatewayReplica && typeof payload.gatewayReplica === 'object') {
      const gatewayRelay = {
        hyperbeeKey: payload.gatewayReplica.hyperbeeKey || null,
        discoveryKey: payload.gatewayReplica.discoveryKey || null,
        replicationTopic: payload.gatewayReplica.replicationTopic || null
      };
      const replicaMetrics = {
        length: Number(payload.gatewayReplica.length) || 0,
        contiguousLength: Number(payload.gatewayReplica.contiguousLength) || 0,
        lag: Number(payload.gatewayReplica.lag) || 0,
        version: Number(payload.gatewayReplica.version) || 0,
        updatedAt: Number(payload.gatewayReplica.updatedAt) || now
      };
      const replicaTelemetry = payload.gatewayReplica.telemetry || null;
      const delegateReqToPeers = typeof payload.gatewayReplica.delegateReqToPeers === 'boolean'
        ? payload.gatewayReplica.delegateReqToPeers
        : null;

      await this.#upsertInternalReplicaPeer(peerKey, {
        gatewayRelay,
        replicaMetrics,
        replicaTelemetry,
        delegateReqToPeers
      });
    }

    if (payload?.publicKey) {
      this.#rememberPeerRawKey(peerKey, payload.publicKey);
    }

    const peerEntry = this.peerMetadata.get(peerKey) || {};
    peerEntry.registration = payload;
    peerEntry.lastRegistrationAt = now;
    this.peerMetadata.set(peerKey, peerEntry);
    this.#markPeerReachable(peerKey, { timestamp: now });

    const rawPeerKey = this.#getPeerRawKey(peerKey);
    const trustedInput = rawPeerKey || peerKey;
    if (!trustedInput) {
      this.logger?.warn?.('[PublicGateway] Unable to add trusted peer (no key resolved)', {
        peer: peerKey,
        payloadKeys: Object.keys(payload || {})
      });
    } else {
      this.logger?.info?.('[PublicGateway] Registering trusted peer', {
        peer: peerKey,
        usedRawKey: Buffer.isBuffer(trustedInput)
      });
      this.blindPeerService?.addTrustedPeer(trustedInput);
    }

    this.#emitPublicGatewayStatus();

    const blindPeerInfo = this.blindPeerService?.getAnnouncementInfo?.();
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        status: 'ok',
        hyperbee: this.#getRelayHostInfo(),
        blindPeer: blindPeerInfo && blindPeerInfo.enabled ? blindPeerInfo : { enabled: false }
      }))
    };
  }

  async #mergeRelayRegistration(relayKey, peerKey, relayPayload = {}, globalReplicaPayload = null, now = Date.now()) {
    if (!relayKey || !peerKey) return;

    const existing = await this.registrationStore.getRelay(relayKey);
    const peers = new Set(Array.isArray(existing?.peers) ? existing.peers : []);
    peers.add(peerKey);

    const metadata = { ...(existing?.metadata || {}) };
    metadata.identifier = metadata.identifier || relayKey;

    const maybeString = (value) => (typeof value === 'string' && value.trim().length ? value.trim() : null);

    const name = maybeString(relayPayload?.name);
    if (name) metadata.name = name;

    if (relayPayload?.description !== undefined) {
      const desc = maybeString(relayPayload.description);
      metadata.description = desc || null;
    }

    const avatar = maybeString(relayPayload?.avatarUrl);
    if (avatar !== null) {
      metadata.avatarUrl = avatar;
    } else if (relayPayload?.avatarUrl === null) {
      metadata.avatarUrl = null;
    }

    const gatewayPath = maybeString(relayPayload?.gatewayPath);
    if (gatewayPath) {
      metadata.gatewayPath = gatewayPath;
    }

    const payloadAliases = Array.isArray(relayPayload?.pathAliases)
      ? relayPayload.pathAliases
      : [];
    if (payloadAliases.length) {
      const aliasSet = new Set(
        (Array.isArray(metadata.pathAliases) ? metadata.pathAliases : [])
          .map((alias) => this.#normalizePathValue(alias))
          .filter(Boolean)
      );
      for (const alias of payloadAliases) {
        const normalizedAlias = this.#normalizePathValue(alias);
        if (normalizedAlias) {
          aliasSet.add(normalizedAlias);
        }
      }
      metadata.pathAliases = Array.from(aliasSet);
    }

    if (typeof relayPayload?.isPublic === 'boolean') {
      metadata.isPublic = relayPayload.isPublic;
    }

    if (typeof relayPayload?.isGatewayReplica === 'boolean') {
      metadata.isGatewayReplica = relayPayload.isGatewayReplica;
    }

    const incomingTimestamp = this.#coerceTimestamp(relayPayload?.metadataUpdatedAt);
    const existingTimestamp = this.#coerceTimestamp(metadata.metadataUpdatedAt);
    if (incomingTimestamp !== null) {
      if (existingTimestamp === null || incomingTimestamp >= existingTimestamp) {
        metadata.metadataUpdatedAt = incomingTimestamp;
      }
    }

    if (relayPayload?.metadataEventId) {
      metadata.metadataEventId = relayPayload.metadataEventId;
    }

    if (relayPayload?.gatewayRelay && typeof relayPayload.gatewayRelay === 'object') {
      metadata.gatewayRelay = {
        ...(metadata.gatewayRelay || {}),
        ...relayPayload.gatewayRelay
      };
    }

    if (relayPayload?.replicaMetrics && typeof relayPayload.replicaMetrics === 'object') {
      metadata.replicaMetrics = {
        ...(metadata.replicaMetrics || {}),
        ...relayPayload.replicaMetrics,
        peerId: peerKey,
        updatedAt: now
      };
    }

    if (relayPayload?.replicaTelemetry && typeof relayPayload.replicaTelemetry === 'object') {
      metadata.replicaTelemetry = relayPayload.replicaTelemetry;
    }

    if (typeof relayPayload?.delegateReqToPeers === 'boolean') {
      metadata.delegateReqToPeers = relayPayload.delegateReqToPeers;
    }

    const trustedInfo = this.blindPeerService?.getTrustedPeerInfo?.(peerKey) || null;

    metadata.blindPeerTrusted = !!trustedInfo;
    metadata.blindPeerTrustedSince = trustedInfo?.trustedSince || null;
    metadata.lastPeerUpdateAt = now;
    const peerStates = { ...(metadata.peerStates || {}) };
    const existingState = peerStates[peerKey] || {};
    peerStates[peerKey] = {
      ...existingState,
      lastSeen: now,
      lastHealthyAt: existingState.lastHealthyAt || now,
      unreachableSince: null,
      blindPeerTrusted: !!trustedInfo,
      blindPeerTrustedSince: trustedInfo?.trustedSince || null
    };
    metadata.peerStates = peerStates;

    const relayCores = Array.isArray(relayPayload?.relayCores)
      ? relayPayload.relayCores
          .filter((entry) => entry && typeof entry === 'object' && entry.key)
          .map((entry) => ({
            key: entry.key,
            role: typeof entry.role === 'string' ? entry.role : null
          }))
      : (existing?.relayCores || null);

    const record = {
      relayKey,
      peers: Array.from(peers),
      metadata,
      relayCores,
      registeredAt: existing?.registeredAt || now,
      updatedAt: now
    };

    if (metadata.isGatewayReplica) {
      const gatewayReplica = { ...(existing?.gatewayReplica || {}) };
      gatewayReplica.peerId = peerKey;
      gatewayReplica.updatedAt = now;

      if (metadata.gatewayRelay) {
        Object.assign(gatewayReplica, metadata.gatewayRelay);
      }

      if (globalReplicaPayload && typeof globalReplicaPayload === 'object') {
        if (globalReplicaPayload.hyperbeeKey) {
          gatewayReplica.hyperbeeKey = globalReplicaPayload.hyperbeeKey;
        }
        if (globalReplicaPayload.discoveryKey) {
          gatewayReplica.discoveryKey = globalReplicaPayload.discoveryKey;
        }
        if (typeof globalReplicaPayload.delegateReqToPeers === 'boolean') {
          gatewayReplica.delegateReqToPeers = globalReplicaPayload.delegateReqToPeers;
        }
        if (globalReplicaPayload.telemetry && typeof globalReplicaPayload.telemetry === 'object') {
          gatewayReplica.telemetry = globalReplicaPayload.telemetry;
        }

        const replicaMetrics = {};
        const toNumber = (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : null;
        };
        const lengthVal = toNumber(globalReplicaPayload.length);
        if (lengthVal !== null) replicaMetrics.length = lengthVal;
        const contiguousVal = toNumber(globalReplicaPayload.contiguousLength);
        if (contiguousVal !== null) replicaMetrics.contiguousLength = contiguousVal;
        const lagVal = toNumber(globalReplicaPayload.lag);
        if (lagVal !== null) replicaMetrics.lag = lagVal;
        const versionVal = toNumber(globalReplicaPayload.version);
        if (versionVal !== null) replicaMetrics.version = versionVal;
        const updatedVal = toNumber(globalReplicaPayload.updatedAt);
        if (updatedVal !== null) replicaMetrics.updatedAt = updatedVal;

        if (Object.keys(replicaMetrics).length) {
          gatewayReplica.metrics = {
            ...(gatewayReplica.metrics || {}),
            ...replicaMetrics,
            peerId: peerKey,
            reportedAt: now
          };
        }
      }

      if (metadata.replicaMetrics) {
        gatewayReplica.metrics = {
          ...(gatewayReplica.metrics || {}),
          ...metadata.replicaMetrics
        };
      }

    if (metadata.replicaTelemetry) {
      gatewayReplica.telemetry = metadata.replicaTelemetry;
    }

    record.gatewayReplica = gatewayReplica;
  } else if (existing?.gatewayReplica) {
    record.gatewayReplica = existing.gatewayReplica;
  }

    const peerMirrorSummary = this.blindPeerService?.getPeerMirrorSummary?.(peerKey, {
      includeCores: false
    });
    if (peerMirrorSummary) {
      metadata.blindPeerMirrors = peerMirrorSummary;
      metadata.blindPeerMirrorCount = peerMirrorSummary.totalCores ?? null;
      metadata.blindPeerMirrorAnnouncedCount = peerMirrorSummary.announcedCount ?? null;
      metadata.blindPeerMirrorLastSeen = peerMirrorSummary.lastSeen || null;
      metadata.blindPeerMirrorPriorityMax = peerMirrorSummary.priorityMax ?? null;
      metadata.blindPeerMirrorPriorityMin = peerMirrorSummary.priorityMin ?? null;
    }

    record.blindPeer = this.#getBlindPeerSummary();
    await this.registrationStore.upsertRelay(relayKey, record);
    await this.#storeMirrorMetadataPayload(relayKey, this.#buildMirrorMetadataPayload(record, relayKey));
    this.#storeRelayAliases(relayKey, record).catch((error) => {
      this.logger?.warn?.('[PublicGateway] Failed to store relay aliases', {
        relayKey,
        error: error?.message || error
      });
    });
    this.#syncSessionsWithRelay(relayKey, record);
    this.#markPeerReachable(peerKey, { relayKey, timestamp: now });
    const rawPeerKey = this.#getPeerRawKey(peerKey);
    const trustedInput = rawPeerKey || peerKey;
    if (!trustedInput) {
      this.logger?.warn?.('[PublicGateway] Unable to trust relay peer (missing key)', {
        peer: peerKey,
        relayKey
      });
    } else {
      this.logger?.info?.('[PublicGateway] Trusting relay peer for registration record', {
        peer: peerKey,
        relayKey,
        usedRawKey: Buffer.isBuffer(trustedInput)
      });
      this.blindPeerService?.addTrustedPeer(trustedInput);
    }
  }

  async #upsertInternalReplicaPeer(peerKey, { gatewayRelay = {}, replicaMetrics = null, replicaTelemetry = null, delegateReqToPeers = null } = {}) {
    const relayKey = this.internalRelayKey;
    const payload = {
      identifier: relayKey,
      isGatewayReplica: true,
      gatewayRelay,
      replicaMetrics,
      replicaTelemetry,
      delegateReqToPeers
    };
    await this.#mergeRelayRegistration(relayKey, peerKey, payload, {
      hyperbeeKey: gatewayRelay?.hyperbeeKey,
      discoveryKey: gatewayRelay?.discoveryKey,
      length: replicaMetrics?.length,
      contiguousLength: replicaMetrics?.contiguousLength,
      lag: replicaMetrics?.lag,
      version: replicaMetrics?.version,
      updatedAt: replicaMetrics?.updatedAt,
      telemetry: replicaTelemetry,
      delegateReqToPeers
    });
  }

  async #handleRelayRegistration(req, res) {
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Registration disabled' });
    }

    const { registration, signature } = req.body || {};
    if (!registration || !signature) {
      return res.status(400).json({ error: 'Missing registration payload or signature' });
    }

    if (!registration.relayKey) {
      return res.status(400).json({ error: 'relayKey is required' });
    }
    const relayKeyType = this.#isHexRelayKey(registration.relayKey) ? 'hex' : 'alias';

    const relayCoreMetadata = Array.isArray(registration.relayCores)
      ? registration.relayCores
          .filter((entry) => entry && typeof entry === 'object' && entry.key)
          .map((entry) => ({
            key: entry.key,
            role: typeof entry.role === 'string' ? entry.role : null
          }))
      : null;

    const valid = verifySignature(registration, signature, this.sharedSecret);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      const upsertPayload = relayCoreMetadata ? { ...registration, relayCores: relayCoreMetadata } : registration;
      await this.registrationStore.upsertRelay(registration.relayKey, upsertPayload);
      await this.#storeMirrorMetadataPayload(
        registration.relayKey,
        this.#buildMirrorMetadataPayload(upsertPayload, registration.relayKey)
      );
      this.#storeRelayAliases(registration.relayKey, upsertPayload).catch((error) => {
        this.logger?.warn?.({
          relayKey: registration.relayKey,
          error: error?.message || error
        }, '[PublicGateway] Failed to store relay aliases');
      });
      this.logger.info?.({ relayKey: registration.relayKey, relayKeyType }, 'Relay registration accepted');
      const hyperbeeInfo = this.#getRelayHostInfo();
      return res.json({
        status: 'ok',
        hyperbee: hyperbeeInfo
      });
    } catch (error) {
      this.logger.error?.({ relayKey: registration.relayKey, error: error.message }, 'Failed to persist relay registration');
      return res.status(500).json({ error: 'Failed to persist registration' });
    }
  }

  async #handleRelayDeletion(req, res) {
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Registration disabled' });
    }

    const relayKey = req.params?.relayKey;
    if (!relayKey) {
      return res.status(400).json({ error: 'relayKey param is required' });
    }

    const signature = req.headers['x-signature'];
    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    const valid = verifySignature({ relayKey }, signature, this.sharedSecret);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      await this.registrationStore.removeRelay(relayKey);
      this.logger.info?.({ relayKey }, 'Relay unregistered');
      return res.json({ status: 'ok' });
    } catch (error) {
      this.logger.error?.({ relayKey, error: error.message }, 'Failed to unregister relay');
      return res.status(500).json({ error: 'Failed to unregister relay' });
    }
  }

  async #handleRelayMirrorMetadata(req, res) {
    const identifier = req.params?.relayKey;
    if (!identifier) {
      return res.status(400).json({ error: 'relayKey is required' });
    }
    try {
      const trimmedIdentifier = typeof identifier === 'string' ? identifier.trim() : null;
      const identifierType = this.#isHexRelayKey(trimmedIdentifier)
        ? 'hex'
        : (trimmedIdentifier ? 'alias' : 'unknown');
      this.logger?.info?.('[PublicGateway] Mirror metadata request', {
        identifier: trimmedIdentifier,
        identifierType
      });
      const resolved = trimmedIdentifier
        ? await this.#resolveOpenJoinRegistration(trimmedIdentifier)
        : null;
      let relayKey = resolved?.relayKey || null;
      let record = resolved?.record || null;

      if (!relayKey && this.#isHexRelayKey(trimmedIdentifier)) {
        relayKey = trimmedIdentifier.toLowerCase();
      }

      if (!record) {
        const poolResolved = trimmedIdentifier
          ? await this.#resolveOpenJoinPool(trimmedIdentifier)
          : null;
        if (poolResolved?.pool) {
          const poolRelayKey = poolResolved.relayKey || relayKey || trimmedIdentifier;
          const poolPayload = this.#buildOpenJoinMirrorPayloadFromPool(
            poolResolved.pool,
            poolRelayKey || trimmedIdentifier
          );
          if (poolPayload) {
            this.logger?.info?.('[PublicGateway] Mirror metadata resolved from open join pool', {
              identifier: trimmedIdentifier,
              relayKey: poolRelayKey || trimmedIdentifier,
              coreCount: Array.isArray(poolPayload.cores) ? poolPayload.cores.length : 0
            });
            await this.#storeMirrorMetadataPayload(poolRelayKey || trimmedIdentifier, poolPayload);
            return res.json(poolPayload);
          }
        }

        if (!relayKey && trimmedIdentifier && typeof this.registrationStore?.resolveOpenJoinAlias === 'function') {
          const aliasRelayKey = await this.registrationStore.resolveOpenJoinAlias(trimmedIdentifier);
          relayKey = this.#isHexRelayKey(aliasRelayKey) ? aliasRelayKey.toLowerCase() : aliasRelayKey;
        }

        let cached = null;
        if (typeof this.registrationStore?.getMirrorMetadata === 'function') {
          if (relayKey) {
            cached = await this.registrationStore.getMirrorMetadata(relayKey);
          }
          if (!cached && trimmedIdentifier && trimmedIdentifier !== relayKey) {
            cached = await this.registrationStore.getMirrorMetadata(trimmedIdentifier);
          }
        }
        if (cached && typeof cached === 'object') {
          const cachedRelayKey = this.#isHexRelayKey(cached.relayKey) ? cached.relayKey.toLowerCase() : null;
          const canonicalRelayKey = relayKey || cachedRelayKey || null;
          const blindPeerInfo = this.blindPeerService?.getAnnouncementInfo?.();
          const publicIdentifier =
            cached.publicIdentifier ||
            (resolved?.record?.metadata?.identifier ?? null) ||
            trimmedIdentifier ||
            canonicalRelayKey;
          const payload = {
            ...cached,
            relayKey: canonicalRelayKey || cached.relayKey || trimmedIdentifier || null,
            publicIdentifier,
            blindPeer: blindPeerInfo && blindPeerInfo.enabled
              ? {
                  publicKey: blindPeerInfo.publicKey || null,
                  encryptionKey: blindPeerInfo.encryptionKey || null,
                  maxBytes: blindPeerInfo.maxBytes ?? null
                }
              : (cached.blindPeer || { enabled: false })
          };
          this.logger?.info?.('[PublicGateway] Mirror metadata resolved from cache', {
            identifier: trimmedIdentifier,
            relayKey: payload.relayKey,
            publicIdentifier,
            coreCount: Array.isArray(payload.cores) ? payload.cores.length : 0,
            blindPeerEnabled: !!payload.blindPeer?.publicKey || payload.blindPeer?.enabled === true
          });
          const storeKey = canonicalRelayKey || relayKey || cached.relayKey || trimmedIdentifier;
          await this.#storeMirrorMetadataPayload(storeKey, payload);
          return res.json(payload);
        }
        this.logger?.info?.('[PublicGateway] Mirror metadata not found', {
          identifier: trimmedIdentifier
        });
        return res.status(404).json({ error: 'relay-not-found' });
      }
      const payload = this.#buildMirrorMetadataPayload(record, relayKey || trimmedIdentifier);
      if (relayKey) {
        payload.relayKey = relayKey;
      }
      this.logger?.info?.('[PublicGateway] Mirror metadata resolved from registration', {
        identifier: trimmedIdentifier,
        relayKey: payload.relayKey || relayKey || trimmedIdentifier,
        publicIdentifier: payload.publicIdentifier || null,
        coreCount: Array.isArray(payload.cores) ? payload.cores.length : 0,
        blindPeerEnabled: !!payload.blindPeer?.publicKey || payload.blindPeer?.enabled === true
      });
      await this.#storeMirrorMetadataPayload(relayKey || trimmedIdentifier, payload);
      return res.json(payload);
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to fetch relay mirror metadata', {
        relayKey: identifier,
        err: error?.message || error
      });
      return res.status(500).json({ error: 'relay-mirror-metadata-unavailable' });
    }
  }

  async #handleOpenJoinPoolUpdate(req, res) {
    if (!this.openJoinConfig?.enabled) {
      return res.status(503).json({ error: 'open-join-disabled' });
    }
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'registration-disabled' });
    }

    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey || req.params?.relayKey;
    if (!relayKey) {
      return res.status(400).json({ error: 'relayKey is required' });
    }
    const relayKeyType = this.#isHexRelayKey(relayKey) ? 'hex' : 'alias';
    this.logger?.info?.('[PublicGateway] Open join pool update request', {
      relayKey,
      relayKeyType
    });

    const payloadMetadata = payload?.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : null;
    const payloadPublicIdentifier = typeof payload?.publicIdentifier === 'string'
      ? payload.publicIdentifier
      : null;
    const payloadRelayUrl = typeof payload?.relayUrl === 'string'
      ? payload.relayUrl
      : null;
    const payloadRelayCores = Array.isArray(payload?.relayCores)
      ? payload.relayCores
      : [];
    const payloadAliases = Array.isArray(payload?.aliases)
      ? payload.aliases
      : [];

    const record = await this.registrationStore.getRelay(relayKey);
    const recordMetadata = record?.metadata && typeof record.metadata === 'object'
      ? record.metadata
      : null;

    if (!record && payloadMetadata?.isOpen !== true) {
      return res.status(404).json({ error: 'relay-not-found' });
    }

    if (record && !this.#isOpenJoinAllowed(record)) {
      return res.status(409).json({ error: 'relay-not-open' });
    }

    const entriesRaw = Array.isArray(payload?.entries) ? payload.entries : [];
    const now = Date.now();
    const ttlMs = this.openJoinConfig?.poolEntryTtlMs || 6 * 60 * 60 * 1000;
    const maxPool = this.openJoinConfig?.maxPoolSize || 50;
    const targetSizeRaw = Number(payload?.targetSize);
    const targetSize = Number.isFinite(targetSizeRaw) && targetSizeRaw > 0
      ? Math.min(Math.trunc(targetSizeRaw), maxPool)
      : maxPool;

    const poolMetadata = payloadMetadata || (recordMetadata
      ? {
          identifier: recordMetadata.identifier || null,
          isOpen: recordMetadata.isOpen ?? null,
          isPublic: recordMetadata.isPublic ?? null,
          isHosted: recordMetadata.isHosted ?? null,
          isJoined: recordMetadata.isJoined ?? null,
          metadataUpdatedAt: recordMetadata.metadataUpdatedAt ?? null,
          gatewayPath: recordMetadata.gatewayPath || null,
          relayUrl: recordMetadata.connectionUrl || recordMetadata.relayUrl || null
        }
      : null);
    const poolPublicIdentifier = payloadPublicIdentifier
      || poolMetadata?.identifier
      || recordMetadata?.identifier
      || relayKey;
    const poolRelayUrl = payloadRelayUrl
      || poolMetadata?.relayUrl
      || recordMetadata?.connectionUrl
      || recordMetadata?.relayUrl
      || null;
    const poolRelayCores = payloadRelayCores.length
      ? payloadRelayCores
      : (Array.isArray(record?.relayCores) ? record.relayCores : []);
    const aliasSet = new Set();
    const addAlias = (value) => {
      const normalized = this.#normalizePathValue(value);
      if (!normalized) return;
      aliasSet.add(normalized);
    };
    for (const alias of payloadAliases) {
      addAlias(alias);
    }
    addAlias(poolPublicIdentifier);
    const gatewayPath = poolMetadata?.gatewayPath || recordMetadata?.gatewayPath || null;
    const normalizedGatewayPath = this.#normalizePathValue(gatewayPath);
    if (normalizedGatewayPath) {
      addAlias(normalizedGatewayPath);
      const colonAlias = this.#toColonIdentifier(normalizedGatewayPath);
      if (colonAlias) addAlias(colonAlias);
    }
    const poolAliases = Array.from(aliasSet);

    const normalizeEntry = (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const writerCore = typeof entry.writerCore === 'string' ? entry.writerCore : null;
      const writerSecret = typeof entry.writerSecret === 'string' ? entry.writerSecret : null;
      if (!writerCore || !writerSecret) return null;
      const issuedAt = Number.isFinite(entry.issuedAt) ? Math.trunc(entry.issuedAt) : now;
      const expiresAt = Number.isFinite(entry.expiresAt) ? Math.trunc(entry.expiresAt) : (issuedAt + ttlMs);
      if (expiresAt <= now) return null;
      const writerCoreHex = typeof entry.writerCoreHex === 'string'
        ? entry.writerCoreHex
        : (typeof entry.writer_core_hex === 'string' ? entry.writer_core_hex : null);
      const autobaseLocal = typeof entry.autobaseLocal === 'string'
        ? entry.autobaseLocal
        : (typeof entry.autobase_local === 'string' ? entry.autobase_local : null);
      const normalized = { writerCore, writerSecret, issuedAt, expiresAt };
      if (writerCoreHex) normalized.writerCoreHex = writerCoreHex;
      if (autobaseLocal) normalized.autobaseLocal = autobaseLocal;
      return normalized;
    };

    const sanitizeEntries = (entries) => {
      const sanitized = [];
      for (const entry of entries) {
        const normalized = normalizeEntry(entry);
        if (!normalized) continue;
        sanitized.push(normalized);
        if (sanitized.length >= maxPool) break;
      }
      return sanitized;
    };

    const existingPool = await this.registrationStore.getOpenJoinPool?.(relayKey);
    const existingEntries = sanitizeEntries(Array.isArray(existingPool?.entries) ? existingPool.entries : []);
    const incomingEntries = sanitizeEntries(entriesRaw);
    const existingCount = existingEntries.length;
    const incomingCount = incomingEntries.length;
    const rejectedCount = Math.max(entriesRaw.length - incomingCount, 0);

    this.logger?.info?.('[PublicGateway] Open join pool update received', {
      relayKey,
      received: entriesRaw.length,
      existing: existingCount,
      incoming: incomingCount,
      rejected: rejectedCount,
      publicIdentifier: poolPublicIdentifier || null,
      relayUrl: poolRelayUrl || null,
      relayCores: poolRelayCores.length,
      aliases: poolAliases.length,
      metadataUpdatedAt: poolMetadata?.metadataUpdatedAt ?? null,
      recordFound: !!record,
      targetSize,
      maxPool,
      ttlMs,
      updatedAt: payload?.updatedAt || null
    });

    const merged = new Map();
    const mergeEntry = (entry) => {
      const current = merged.get(entry.writerCore);
      if (!current) {
        merged.set(entry.writerCore, entry);
        return;
      }
      const currentExpires = Number.isFinite(current.expiresAt) ? current.expiresAt : 0;
      const incomingExpires = Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0;
      if (incomingExpires > currentExpires) {
        merged.set(entry.writerCore, {
          ...current,
          ...entry,
          issuedAt: entry.issuedAt,
          expiresAt: entry.expiresAt,
          writerSecret: entry.writerSecret
        });
        return;
      }
      const mergedEntry = { ...current };
      if (!mergedEntry.writerCoreHex && entry.writerCoreHex) mergedEntry.writerCoreHex = entry.writerCoreHex;
      if (!mergedEntry.autobaseLocal && entry.autobaseLocal) mergedEntry.autobaseLocal = entry.autobaseLocal;
      merged.set(entry.writerCore, mergedEntry);
    };

    for (const entry of existingEntries) mergeEntry(entry);
    for (const entry of incomingEntries) mergeEntry(entry);

    let mergedEntries = Array.from(merged.values());
    mergedEntries.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
    if (mergedEntries.length > maxPool) {
      mergedEntries = mergedEntries.slice(0, maxPool);
    }
    const mergedCount = mergedEntries.length;

    const updatedAt = incomingEntries.length
      ? (payload?.updatedAt || now)
      : (existingPool?.updatedAt || payload?.updatedAt || now);

    this.logger?.info?.('[PublicGateway] Open join pool merge result', {
      relayKey,
      existing: existingCount,
      incoming: incomingCount,
      merged: mergedCount,
      publicIdentifier: poolPublicIdentifier || null,
      targetSize,
      maxPool
    });

    await this.registrationStore.storeOpenJoinPool(relayKey, {
      entries: mergedEntries,
      updatedAt,
      publicIdentifier: poolPublicIdentifier || null,
      relayUrl: poolRelayUrl || null,
      relayCores: poolRelayCores,
      metadata: poolMetadata,
      aliases: poolAliases
    });
    if (poolAliases.length && typeof this.registrationStore?.storeOpenJoinAliases === 'function') {
      await this.registrationStore.storeOpenJoinAliases(relayKey, poolAliases);
    }
    const mirrorPayload = this.#buildOpenJoinMirrorPayloadFromPool({
      publicIdentifier: poolPublicIdentifier || null,
      relayUrl: poolRelayUrl || null,
      relayCores: poolRelayCores,
      metadata: poolMetadata
    }, relayKey);
    if (mirrorPayload) {
      await this.#storeMirrorMetadataPayload(relayKey, mirrorPayload);
    }

    const total = mergedEntries.length;
    const needed = Math.max(targetSize - total, 0);

    this.logger?.info?.('[PublicGateway] Open join pool updated', {
      relayKey,
      received: entriesRaw.length,
      stored: incomingEntries.length,
      total,
      targetSize,
      existing: existingCount,
      merged: mergedCount,
      needed,
      updatedAt,
      publicIdentifier: poolPublicIdentifier || null,
      relayCores: poolRelayCores.length,
      aliases: poolAliases.length
    });

    return res.json({
      status: 'ok',
      relayKey,
      stored: incomingEntries.length,
      total,
      targetSize,
      needed
    });
  }

  async #handleOpenJoinChallenge(req, res) {
    if (!this.openJoinConfig?.enabled) {
      return res.status(503).json({ error: 'open-join-disabled' });
    }
    const identifier = req.params?.relayKey;
    if (!identifier) {
      return res.status(400).json({ error: 'relayKey is required' });
    }
    const rawPurpose = typeof req.query?.purpose === 'string' ? req.query.purpose.trim() : null;
    const purpose = rawPurpose || null;
    if (purpose && purpose !== OPEN_JOIN_APPEND_CORES_PURPOSE) {
      return res.status(400).json({ error: 'invalid-purpose' });
    }

    try {
      const resolved = await this.#resolveOpenJoinTarget(identifier);
      if (!resolved) {
        return res.status(404).json({ error: 'relay-not-found' });
      }
      const { relayKey, record, pool } = resolved;
      const relayKeyType = this.#isHexRelayKey(relayKey) ? 'hex' : 'alias';
      const identifierType = this.#isHexRelayKey(identifier) ? 'hex' : 'alias';
      const isAllowed = record ? this.#isOpenJoinAllowed(record) : this.#isOpenJoinPoolAllowed(pool);
      if (!isAllowed) {
        return res.status(403).json({ error: 'relay-not-open' });
      }

      const publicIdentifier =
        record?.metadata?.identifier
        || pool?.publicIdentifier
        || pool?.metadata?.identifier
        || relayKey;
      const { challenge, expiresAt } = this.#issueOpenJoinChallenge({ relayKey, publicIdentifier, purpose });
      this.logger?.info?.('[PublicGateway] Open join challenge issued', {
        relayKey,
        publicIdentifier,
        expiresAt,
        source: record ? 'registration' : 'pool',
        purpose,
        challengePrefix: challenge ? challenge.slice(0, 12) : null
      });
      return res.json({
        relayKey,
        publicIdentifier,
        challenge,
        expiresAt,
        purpose,
        gateway: this.config?.publicBaseUrl || null
      });
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to issue open join challenge', {
        identifier,
        err: error?.message || error
      });
      return res.status(500).json({ error: 'open-join-challenge-unavailable' });
    }
  }

  async #handleOpenJoinRequest(req, res) {
    if (!this.openJoinConfig?.enabled) {
      return res.status(503).json({ error: 'open-join-disabled' });
    }

    const identifier = req.params?.relayKey;
    if (!identifier) {
      return res.status(400).json({ error: 'relayKey is required' });
    }

    const authEvent = req.body?.authEvent || req.body?.event || null;
    if (!authEvent || typeof authEvent !== 'object') {
      return res.status(400).json({ error: 'missing-auth-event' });
    }

    try {
      const resolved = await this.#resolveOpenJoinTarget(identifier);
      if (!resolved) {
        return res.status(404).json({ error: 'relay-not-found' });
      }
      const { relayKey, record, pool } = resolved;
      const isAllowed = record ? this.#isOpenJoinAllowed(record) : this.#isOpenJoinPoolAllowed(pool);
      if (!isAllowed) {
        return res.status(403).json({ error: 'relay-not-open' });
      }

      const challengeTag = this.#extractTagValue(authEvent.tags, 'challenge');
      if (!challengeTag) {
        return res.status(400).json({ error: 'missing-challenge' });
      }
      const challengeEntry = this.#consumeOpenJoinChallenge(challengeTag, relayKey);
      if (!challengeEntry) {
        return res.status(401).json({ error: 'invalid-challenge' });
      }

      const publicIdentifier =
        challengeEntry?.publicIdentifier
        || record?.metadata?.identifier
        || pool?.publicIdentifier
        || pool?.metadata?.identifier
        || relayKey;
      const verification = await this.#verifyOpenJoinAuthEvent(authEvent, {
        challenge: challengeTag,
        relayKey,
        publicIdentifier
      });
      if (!verification.ok) {
        return res.status(401).json({ error: verification.error || 'auth-invalid' });
      }

      let poolBefore = null;
      try {
        poolBefore = await this.registrationStore.getOpenJoinPool?.(relayKey);
      } catch (_) {
        poolBefore = null;
      }
      const poolBeforeCount = Array.isArray(poolBefore?.entries) ? poolBefore.entries.length : 0;

      if (this.openJoinLeaseLocks.has(relayKey)) {
        this.logger?.warn?.('[PublicGateway] Open join lease busy', {
          relayKey,
          relayKeyType,
          identifierType,
          publicIdentifier,
          poolBefore: poolBeforeCount
        });
        return res.status(429).json({ error: 'open-join-busy' });
      }
      this.openJoinLeaseLocks.add(relayKey);
      let lease = null;
      try {
        lease = await this.registrationStore.takeOpenJoinLease(relayKey);
      } finally {
        this.openJoinLeaseLocks.delete(relayKey);
      }

      let poolAfter = null;
      try {
        poolAfter = await this.registrationStore.getOpenJoinPool?.(relayKey);
      } catch (_) {
        poolAfter = null;
      }
      const poolAfterCount = Array.isArray(poolAfter?.entries) ? poolAfter.entries.length : 0;

      if (!lease) {
        this.logger?.warn?.('[PublicGateway] Open join lease unavailable', {
          relayKey,
          relayKeyType,
          identifierType,
          publicIdentifier,
          identifier,
          poolBefore: poolBeforeCount,
          poolAfter: poolAfterCount
        });
        return res.status(409).json({ error: 'open-join-empty' });
      }

      const mirrorPayload = record
        ? this.#buildOpenJoinMirrorPayload(record, relayKey)
        : this.#buildOpenJoinMirrorPayloadFromPool(pool, relayKey);
      const writerCoreHex = typeof lease.writerCoreHex === 'string'
        ? lease.writerCoreHex
        : (typeof lease.writer_core_hex === 'string' ? lease.writer_core_hex : null);
      const autobaseLocal = typeof lease.autobaseLocal === 'string'
        ? lease.autobaseLocal
        : (typeof lease.autobase_local === 'string' ? lease.autobase_local : null);
      const resolvedAutobaseLocal = autobaseLocal || writerCoreHex || null;
      this.logger?.info?.('[PublicGateway] Open join lease issued', {
        relayKey,
        relayKeyType,
        identifierType,
        publicIdentifier,
        source: record ? 'registration' : 'pool',
        poolBefore: poolBeforeCount,
        poolAfter: poolAfterCount,
        writerCore: lease.writerCore ? lease.writerCore.slice(0, 16) : null,
        writerCoreHex: writerCoreHex ? String(writerCoreHex).slice(0, 16) : null,
        issuedAt: lease.issuedAt || null,
        expiresAt: lease.expiresAt || null
      });
      return res.json({
        relayKey,
        publicIdentifier,
        writerCore: lease.writerCore,
        writerCoreHex,
        autobaseLocal: resolvedAutobaseLocal,
        writerSecret: lease.writerSecret,
        issuedAt: lease.issuedAt || null,
        expiresAt: lease.expiresAt || null,
        ...(mirrorPayload || {})
      });
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Open join request failed', {
        identifier,
        err: error?.message || error
      });
      return res.status(500).json({ error: 'open-join-failed' });
    }
  }

  async #handleOpenJoinAppendCores(req, res) {
    if (!this.openJoinConfig?.enabled) {
      return res.status(503).json({ error: 'open-join-disabled' });
    }

    const identifier = req.params?.relayKey;
    if (!identifier) {
      return res.status(400).json({ error: 'relayKey is required' });
    }

    const authEvent = req.body?.authEvent || req.body?.event || null;
    if (!authEvent || typeof authEvent !== 'object') {
      return res.status(400).json({ error: 'missing-auth-event' });
    }

    const rawCores = Array.isArray(req.body?.cores)
      ? req.body.cores
      : (Array.isArray(req.body?.relayCores) ? req.body.relayCores : []);
    const maxAppend = this.openJoinConfig?.maxAppendCores || 64;
    const normalized = this.#normalizeOpenJoinCoreEntries(rawCores, { maxEntries: maxAppend });
    const rejected = normalized.rejected + normalized.truncated;
    if (!normalized.entries.length) {
      return res.status(400).json({ error: 'missing-cores', rejected });
    }

    try {
      const resolved = await this.#resolveOpenJoinTarget(identifier);
      if (!resolved) {
        return res.status(404).json({ error: 'relay-not-found' });
      }
      const { relayKey, record, pool } = resolved;
      const isAllowed = record ? this.#isOpenJoinAllowed(record) : this.#isOpenJoinPoolAllowed(pool);
      if (!isAllowed) {
        return res.status(403).json({ error: 'relay-not-open' });
      }

      const challengeTag = this.#extractTagValue(authEvent.tags, 'challenge');
      if (!challengeTag) {
        return res.status(400).json({ error: 'missing-challenge' });
      }
      const challengeEntry = this.#consumeOpenJoinChallenge(
        challengeTag,
        relayKey,
        OPEN_JOIN_APPEND_CORES_PURPOSE
      );
      if (!challengeEntry) {
        return res.status(401).json({ error: 'invalid-challenge' });
      }

      const publicIdentifier =
        challengeEntry?.publicIdentifier
        || record?.metadata?.identifier
        || pool?.publicIdentifier
        || pool?.metadata?.identifier
        || relayKey;
      const verification = await this.#verifyOpenJoinAuthEvent(authEvent, {
        challenge: challengeTag,
        relayKey,
        publicIdentifier,
        purpose: OPEN_JOIN_APPEND_CORES_PURPOSE
      });
      if (!verification.ok) {
        return res.status(401).json({ error: verification.error || 'auth-invalid' });
      }

      const poolRecord = pool || await this.registrationStore.getOpenJoinPool?.(relayKey);
      if (!poolRecord) {
        return res.status(409).json({ error: 'open-join-pool-unavailable' });
      }

      const existingCores = Array.isArray(poolRecord.relayCores) ? poolRecord.relayCores : [];
      const mergeResult = this.#mergeOpenJoinCoreEntries(existingCores, normalized.entries, {
        maxTotal: this.openJoinConfig?.maxRelayCores || null
      });
      const updatedAt = Date.now();
      const updatedPool = {
        entries: Array.isArray(poolRecord.entries) ? poolRecord.entries : [],
        updatedAt,
        publicIdentifier: poolRecord.publicIdentifier || publicIdentifier || null,
        relayUrl: typeof poolRecord.relayUrl === 'string' ? poolRecord.relayUrl : null,
        relayCores: mergeResult.merged,
        metadata: poolRecord.metadata && typeof poolRecord.metadata === 'object' ? poolRecord.metadata : null,
        aliases: Array.isArray(poolRecord.aliases) ? poolRecord.aliases : []
      };

      await this.registrationStore.storeOpenJoinPool(relayKey, updatedPool);
      if (updatedPool.aliases.length && typeof this.registrationStore?.storeOpenJoinAliases === 'function') {
        await this.registrationStore.storeOpenJoinAliases(relayKey, updatedPool.aliases);
      }

      const mirrorPayload = this.#buildOpenJoinMirrorPayloadFromPool(updatedPool, relayKey);
      if (mirrorPayload) {
        await this.#storeMirrorMetadataPayload(relayKey, mirrorPayload);
      }

      this.logger?.info?.('[PublicGateway] Open join core append', {
        relayKey,
        publicIdentifier,
        received: rawCores.length,
        added: mergeResult.added,
        ignored: mergeResult.ignored,
        rejected,
        trimmed: mergeResult.trimmed,
        total: mergeResult.merged.length
      });

      return res.json({
        status: 'ok',
        relayKey,
        publicIdentifier,
        added: mergeResult.added,
        ignored: mergeResult.ignored,
        rejected,
        trimmed: mergeResult.trimmed,
        total: mergeResult.merged.length,
        updatedAt
      });
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Open join core append failed', {
        identifier,
        err: error?.message || error
      });
      return res.status(500).json({ error: 'open-join-append-failed' });
    }
  }

  #parseWebSocketRequest(req) {
    const base = this.config.publicBaseUrl || 'https://hypertuna.com';
    const parsed = new URL(req.url, base);
    let relayKey = this.#resolveRelayKeyFromPath(parsed.pathname);
    if (!relayKey) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      relayKey = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0] || null;
    }
    const token = parsed.searchParams.get('token');
    return { relayKey, token };
  }

  async #validateToken(token, relayKey) {
    if (this.tokenService) {
      try {
        return await this.tokenService.verifyToken(token, relayKey);
      } catch (error) {
        this.logger.warn?.({
          relayKey,
          error: error?.message || error
        }, 'Token verification failed');
        return null;
      }
    }

    const payload = verifyClientToken(token, this.sharedSecret);
    if (!payload) {
      this.logger.warn?.({ relayKey }, 'Token verification failed - signature mismatch');
      return null;
    }

    if (payload.relayKey && payload.relayKey !== relayKey) {
      this.logger.warn?.({
        relayKey,
        tokenRelayKey: payload.relayKey
      }, 'Token verification failed - relay mismatch');
      return null;
    }

    if (payload.expiresAt && payload.expiresAt < Date.now()) {
      this.logger.warn?.({
        relayKey,
        expiresAt: payload.expiresAt
      }, 'Token verification failed - token expired');
      return null;
    }

    if (!payload.relayAuthToken || typeof payload.relayAuthToken !== 'string') {
      this.logger.warn?.({ relayKey }, 'Token verification failed - missing relay auth token');
      return null;
    }

    return {
      payload,
      relayAuthToken: payload.relayAuthToken,
      pubkey: payload.pubkey || null,
      scope: payload.scope || null
    };
  }

  #normalizePeerRawKey(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) {
      return value.length === 32 ? Buffer.from(value) : null;
    }
    if (value instanceof Uint8Array) {
      const buffer = Buffer.from(value);
      return buffer.length === 32 ? buffer : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const buffer = Buffer.from(trimmed, 'hex');
        return buffer.length === 32 ? buffer : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  #rememberPeerRawKey(peerKey, rawValue) {
    const normalized = this.#normalizePeerRawKey(rawValue) || this.#normalizePeerRawKey(peerKey);
    if (!normalized) return;
    this.peerRawPublicKeys.set(peerKey, normalized);
    this.logger?.debug?.('[PublicGateway] Remembered peer raw key', {
      peer: peerKey,
      sourceType: rawValue ? (Buffer.isBuffer(rawValue) ? 'buffer' : rawValue instanceof Uint8Array ? 'uint8array' : typeof rawValue) : 'string',
      byteLength: normalized.length
    });
  }

  #getPeerRawKey(peerKey) {
    const stored = this.peerRawPublicKeys.get(peerKey);
    if (stored) return Buffer.from(stored);
    const normalized = this.#normalizePeerRawKey(peerKey);
    return normalized ? Buffer.from(normalized) : null;
  }

  #forgetPeerRawKey(peerKey) {
    this.peerRawPublicKeys.delete(peerKey);
  }

  #onProtocolCreated({ publicKey, protocol, context = {} }) {
    if (!protocol || !publicKey) return;

    const rawKeyCandidate = context?.peerInfo?.publicKey
      || context?.connection?.stream?.remotePublicKey
      || context?.connection?.remotePublicKey;
    this.#rememberPeerRawKey(publicKey, rawKeyCandidate);

    protocol.handle('/gateway/register', async (request) => {
      try {
        return await this.#handleGatewayHyperswarmRegistration(publicKey, request);
      } catch (error) {
        this.logger.error?.({
          peer: publicKey,
          error: error?.message || error
        }, 'Hyperswarm registration handler failed');
        return {
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'registration-failed' }))
        };
      }
    });

    const cleanup = () => {
      this.peerMetadata.delete(publicKey);
      this.#detachHyperbeeReplication(publicKey);
      // Trusted peers persist until explicit revocation logic runs.
    };
    protocol.once('close', cleanup);
    protocol.once('destroy', cleanup);
  }

  #buildHandshakePayload({ isServer }) {
    const payload = {
      role: 'gateway',
      isGateway: true,
      gatewayReplica: false,
      dispatcherEnabled: !!this.featureFlags?.dispatcherEnabled,
      hyperbeeRelayEnabled: this.#isHyperbeeRelayEnabled(),
      isServer: !!isServer
    };

    if (typeof this.relayHost?.getPublicKey === 'function') {
      payload.hyperbeeKey = this.relayHost.getPublicKey();
    }
    if (typeof this.relayHost?.getDiscoveryKey === 'function') {
      payload.hyperbeeDiscoveryKey = this.relayHost.getDiscoveryKey();
    }

    const core = typeof this.relayHost?.getCore === 'function' ? this.relayHost.getCore() : null;
    if (core) {
      const length = typeof core.length === 'number' ? core.length : 0;
      const contiguous = typeof core.contiguousLength === 'number' ? core.contiguousLength : length;
      payload.hyperbeeLength = length;
      payload.hyperbeeContiguousLength = contiguous;
      payload.hyperbeeLag = Math.max(0, length - contiguous);
      payload.hyperbeeUpdatedAt = core?.header?.timestamp || null;
    }

    const hyperbee = this.hyperbeeAdapter?.hyperbee || null;
    if (hyperbee) {
      payload.hyperbeeVersion = hyperbee.version || 0;
    }

    const blindPeerInfo = this.blindPeerService?.getAnnouncementInfo?.();
    if (blindPeerInfo?.enabled) {
      payload.blindPeerEnabled = true;
      payload.blindPeerPublicKey = blindPeerInfo.publicKey || null;
      payload.blindPeerEncryptionKey = blindPeerInfo.encryptionKey || null;
      payload.blindPeerMaxBytes = blindPeerInfo.maxBytes ?? null;
    } else {
      payload.blindPeerEnabled = false;
    }

    return payload;
  }

  #onProtocolHandshake({ publicKey, protocol, handshake, stage = 'open' }) {
    if (!publicKey || !handshake) return;

    this.logger.debug?.({
      peer: publicKey,
      stage,
      role: handshake?.role ?? 'unknown',
      isGateway: handshake?.isGateway ?? 'unknown'
    }, '[PublicGateway] Hyperswarm handshake event');

    const entry = this.peerMetadata.get(publicKey) || {};
    entry.handshake = handshake;
    entry.lastHandshakeAt = Date.now();
    this.peerMetadata.set(publicKey, entry);
    this.#markPeerReachable(publicKey, { timestamp: entry.lastHandshakeAt });

    const isReplica = handshake.gatewayReplica === true
      || handshake.role === 'gateway-replica'
      || handshake.gatewayReplica === 'true'
      || handshake.gatewayReplica === 1;

    if (isReplica) {
      const gatewayRelay = {
        hyperbeeKey: handshake.hyperbeeKey || null,
        discoveryKey: handshake.hyperbeeDiscoveryKey || null
      };
      const replicaMetrics = {
        length: Number(handshake.hyperbeeLength) || 0,
        contiguousLength: Number(handshake.hyperbeeContiguousLength) || 0,
        lag: Number(handshake.hyperbeeLag) || 0,
        version: Number(handshake.hyperbeeVersion) || 0,
        updatedAt: Number(handshake.hyperbeeUpdatedAt) || Date.now()
      };
      const replicaTelemetry = handshake.telemetry && typeof handshake.telemetry === 'object'
        ? handshake.telemetry
        : null;
      const delegateReqToPeers = typeof handshake.delegateReqToPeers === 'boolean'
        ? handshake.delegateReqToPeers
        : null;

      this.#upsertInternalReplicaPeer(publicKey, {
        gatewayRelay,
        replicaMetrics,
        replicaTelemetry,
        delegateReqToPeers
      }).then(() => {
        this.#emitPublicGatewayStatus();
      }).catch((error) => {
        this.logger?.warn?.('Failed to apply replica data from handshake', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      this.#attachHyperbeeReplication(publicKey, protocol, handshake).catch((error) => {
        this.logger?.warn?.('[PublicGateway] Failed to initialise replication channel', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      if (delegateReqToPeers === true) {
        this.#updateSessionsForDelegation({
          peerKey: publicKey,
          delegate: true
        });
      }

      this.#promoteDelegatedSessions(publicKey).catch((error) => {
        this.logger?.warn?.('Failed to promote delegated sessions to peer', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      this.dispatcher?.reportPeerMetrics(publicKey, {
        peerId: publicKey,
        latencyMs: Number(handshake.latencyMs) || 0,
        inFlightJobs: Number(handshake.inFlightJobs) || 0,
        failureRate: Number(handshake.failureRate) || 0,
        hyperbeeVersion: Number(handshake.hyperbeeVersion) || 0,
        hyperbeeLag: Number(handshake.hyperbeeLag) || 0,
        queueDepth: Number(handshake.queueDepth) || 0,
        reportedAt: Date.now()
      });
    }
  }

  #collectMetrics() {
    sessionGauge.set(this.sessions.size);
    peerGauge.set(this.connectionPool.connections.size);
  }

  async #promoteDelegatedSessions(peerKey) {
    if (!peerKey || !this.sessions.size) return;

    for (const session of this.sessions.values()) {
      if (!session || session.relayKey !== this.internalRelayKey) continue;
      if (!session?.delegateReqToPeers) continue;
      if (session.localOnly !== true) continue;
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) continue;
      if (!session.peers || !Array.isArray(session.peers)) {
        session.peers = [];
      }
      if (!session.peers.includes(peerKey)) {
        session.peers.push(peerKey);
      }

      session.peerKey = peerKey;
      session.peerIndex = session.peers.indexOf(peerKey);

      session.localOnly = false;
      session.delegationReady = true;
      await this.#flushPendingDelegatedMessages(session, peerKey);

      const snapshots = this.relayWebsocketController?.getSubscriptionSnapshot(session.connectionKey) || [];
      if (!snapshots.length) {
        continue;
      }

      for (const snapshot of snapshots) {
        if (!snapshot?.subscriptionId || !Array.isArray(snapshot.filters)) continue;

        const filters = snapshot.filters.map((filter) => this.#cloneDelegatedFilter(filter, snapshot.lastReturnedAt)).filter(Boolean);
        if (!filters.length) continue;

        const frame = ['REQ', snapshot.subscriptionId, ...filters];
        try {
          await this.#forwardLegacyMessage(session, JSON.stringify(frame), peerKey, {
            subscriptionId: snapshot.subscriptionId
          });
          session.assignPeer?.(peerKey, snapshot.subscriptionId);
        } catch (error) {
          this.logger?.warn?.('Failed to delegate subscription to peer', {
            relayKey: session.relayKey,
            connectionKey: session.connectionKey,
            subscriptionId: snapshot.subscriptionId,
            peerKey,
            error: error?.message || error
          });
        }
      }
    }
  }

  #cloneDelegatedFilter(filter, lastReturnedAt = null) {
    if (!filter || typeof filter !== 'object') return null;
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(filter));
    } catch (_) {
      clone = { ...filter };
      for (const key of Object.keys(clone)) {
        if (Array.isArray(clone[key])) {
          clone[key] = [...clone[key]];
        }
      }
    }

    if (Number.isFinite(lastReturnedAt)) {
      const exclusiveCursor = lastReturnedAt + 1;
      const existingSince = Number(clone.since);
      if (!Number.isFinite(existingSince) || existingSince < exclusiveCursor) {
        clone.since = exclusiveCursor;
      }
      if (Number.isFinite(clone.until) && clone.until < clone.since) {
        delete clone.until;
      }
    }

    return clone;
  }

  #scheduleDelegationFallback(session) {
    if (!session || session.delegateReqToPeers !== true) return;
    if (session.delegationReady !== true) return;
    if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
    const connectionKey = session.connectionKey;
    if (this.delegationFallbackTimers.has(connectionKey)) return;
    this.logger.info?.({
      tag: 'DelegationDebug',
      stage: 'fallback-scheduled',
      relayKey: session.relayKey,
      connectionKey,
      pendingDelegatedMessages: session.pendingDelegatedMessages.length
    }, 'DelegationDebug: scheduling delegation fallback');
    const timer = setTimeout(async () => {
      this.delegationFallbackTimers.delete(connectionKey);
      if (!this.sessions.has(connectionKey)) return;
      if (session.delegateReqToPeers !== true) return;
      if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
      this.logger.info?.({
        tag: 'DelegationDebug',
        stage: 'fallback-firing',
        relayKey: session.relayKey,
        connectionKey,
        pendingDelegatedMessages: session.pendingDelegatedMessages.length
      }, 'DelegationDebug: delegation fallback timer firing');
      this.logger?.debug?.('[PublicGateway] Delegation fallback triggered', {
        relayKey: session.relayKey,
        connectionKey
      });
      await this.#fallbackToLocal(session);
    }, DELEGATION_FALLBACK_MS);
    timer.unref?.();
    this.delegationFallbackTimers.set(connectionKey, timer);
  }

  #cancelDelegationFallback(session) {
    if (!session) return;
    const connectionKey = session.connectionKey;
    const timer = this.delegationFallbackTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.delegationFallbackTimers.delete(connectionKey);
    }
  }

  #removePendingDelegatedMessage(session, subscriptionId = null) {
    if (!session || !Array.isArray(session.pendingDelegatedMessages)) return;
    if (!session.pendingDelegatedMessages.length) return;
    if (subscriptionId === null || subscriptionId === undefined) {
      session.pendingDelegatedMessages.shift();
      return;
    }
    const originalLength = session.pendingDelegatedMessages.length;
    session.pendingDelegatedMessages = session.pendingDelegatedMessages.filter((entry) => entry?.subscriptionId !== subscriptionId);
    if (session.pendingDelegatedMessages.length !== originalLength) {
      this.logger?.debug?.('[PublicGateway] Removed pending delegated message after peer ack', {
        relayKey: session.relayKey,
        connectionKey: session.connectionKey,
        subscriptionId
      });
    }
  }

  #handlePeerAck(session, subscriptionId = null, ackPayload = []) {
    if (!session) return;
    this.logger?.debug?.('[PublicGateway] Received delegated subscription ACK from peer', {
      relayKey: session.relayKey,
      connectionKey: session.connectionKey,
      subscriptionId,
      payload: ackPayload
    });
    this.logger.info?.({
      tag: 'DelegationDebug',
      stage: 'peer-ack',
      relayKey: session.relayKey,
      connectionKey: session.connectionKey,
      subscriptionId,
      payload: Array.isArray(ackPayload) && ackPayload.length ? ackPayload : null,
      pendingDelegatedMessages: Array.isArray(session.pendingDelegatedMessages)
        ? session.pendingDelegatedMessages.length
        : 0
    }, 'DelegationDebug: peer ACK received');
    session.delegationReady = true;
    session.localOnly = false;
    this.#removePendingDelegatedMessage(session, subscriptionId);
    this.#cancelDelegationFallback(session);
    if (Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
      this.#flushPendingDelegatedMessages(session).catch((error) => {
        this.logger?.debug?.('[PublicGateway] Failed to flush pending delegated messages after ack', {
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          error: error?.message || error
        });
      });
    }
  }

  async #fallbackToLocal(session) {
    if (!session) return;
    if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
    this.#cancelDelegationFallback(session);
    this.logger?.info?.('[PublicGateway] Delegation fallback to local processing', {
      relayKey: session.relayKey,
      connectionKey: session.connectionKey,
      queued: session.pendingDelegatedMessages.length
    });
    const pending = session.pendingDelegatedMessages.splice(0);
    session.localOnly = true;
    for (const entry of pending) {
      try {
        await this.relayWebsocketController?.handleMessage(session, entry.message);
      } catch (error) {
        this.logger?.warn?.('[PublicGateway] Delegation fallback handling failed', {
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          error: error?.message || error
        });
      }
    }
  }

  #updateSessionsForDelegation({ peerKey = null, delegate = false } = {}) {
    if (!delegate) return;
    for (const session of this.sessions.values()) {
      if (!session || session.relayKey !== this.internalRelayKey) continue;
      if (!Array.isArray(session.peers)) {
        session.peers = [];
      }
      if (peerKey && !session.peers.includes(peerKey)) {
        session.peers.push(peerKey);
      }
      if (!session.delegateReqToPeers) {
        session.delegateReqToPeers = true;
      }
      if (session.localOnly && session.peers.length) {
        session.localOnly = false;
      }
      const wasReady = session.delegationReady === true;
      session.delegationReady = true;
      this.logger.info?.({
        tag: 'DelegationDebug',
        stage: 'delegation-enabled',
        relayKey: session.relayKey,
        connectionKey: session.connectionKey,
        peerKey,
        wasReady,
        pendingDelegatedMessages: Array.isArray(session.pendingDelegatedMessages)
          ? session.pendingDelegatedMessages.length
          : 0
      }, 'DelegationDebug: delegation enabled for session');
      if (Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
        this.#cancelDelegationFallback(session);
        if (!wasReady) {
          this.#flushPendingDelegatedMessages(session, peerKey).catch((error) => {
            this.logger?.debug?.('[PublicGateway] Failed to flush pending delegated messages after enabling delegation', {
              relayKey: session.relayKey,
              connectionKey: session.connectionKey,
              error: error?.message || error
            });
          });
        }
      } else {
        this.#cancelDelegationFallback(session);
      }
    }
  }

  async #attachHyperbeeReplication(publicKey, protocol, handshake = {}) {
    if (!this.relayHost?.getCore || typeof this.relayHost.getCore !== 'function') return;
    if (!protocol) return;

    const hostKey = this.relayHost.getPublicKey?.();
    if (hostKey && handshake?.hyperbeeKey && handshake.hyperbeeKey !== hostKey) {
      this.logger?.debug?.('[PublicGateway] Replica handshake hyperbee key mismatch, skipping replication', {
        peer: publicKey,
        expected: hostKey,
        received: handshake.hyperbeeKey
      });
      return;
    }

    const core = this.relayHost.getCore();
    if (!core) {
      this.logger?.warn?.('[PublicGateway] Hyperbee relay core unavailable for replication', { peer: publicKey });
      return;
    }

    if (this.peerHyperbeeReplications.has(publicKey)) {
      this.logger?.debug?.('[PublicGateway] Replication already active for peer', { peer: publicKey });
      return;
    }

    const isInitiator = protocol?.mux?.stream?.isInitiator === true;
    const discoveryKey = this.relayHost.getDiscoveryKey?.();

    try {
      const { channel, stream, remoteHandshake } = await openHyperbeeReplicationChannel({
        protocol,
        hyperbeeKey: hostKey,
        discoveryKey,
        isInitiator,
        role: 'gateway',
        replicationMode: 'upload',
        logger: this.logger
      });

      this.logger?.info?.('[PublicGateway] Outbound Hyperbee replication channel ready', {
        peer: publicKey,
        hyperbeeKey: hostKey,
        isInitiator,
        remoteHandshake
      });

      if (remoteHandshake?.version && remoteHandshake.version !== 1) {
        this.logger?.warn?.('[PublicGateway] Remote replication channel version mismatch', {
          peer: publicKey,
          expected: 1,
          received: remoteHandshake.version
        });
      }

      let replication;
      try {
        replication = core.replicate(isInitiator, {
          live: true,
          download: false,
          upload: true
        });
      } catch (error) {
        try {
          channel.close();
        } catch (_) {}
        throw error;
      }

      replication.on('handshake', () => {
        this.logger?.debug?.('[PublicGateway] Hyperbee replication handshake (outbound)', {
          peer: publicKey,
          isInitiator,
          localLength: core.length,
          remoteLength: core.remoteLength
        });
      });

      replication.on('error', (error) => {
        this.logger?.warn?.('[PublicGateway] Hyperbee replication error (outbound)', {
          peer: publicKey,
          error: error?.message || error
        });
      });
      replication.once('close', () => {
        this.logger?.debug?.('[PublicGateway] Hyperbee replication stream closed (outbound)', {
          peer: publicKey,
          isInitiator
        });
      });

      stream.pipe(replication).pipe(stream);

      this.peerHyperbeeReplications.set(publicKey, { replication, stream, channel, remoteHandshake });

      channel.fullyClosed().then(() => {
        const entry = this.peerHyperbeeReplications.get(publicKey);
        if (entry?.channel === channel) {
          this.peerHyperbeeReplications.delete(publicKey);
        }
      }).catch(() => {});
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to attach Hyperbee replication stream', {
        peer: publicKey,
        error: error?.message || error
      });
    }
  }

  #detachHyperbeeReplication(publicKey) {
    if (!this.peerHyperbeeReplications.has(publicKey)) return;
    const entry = this.peerHyperbeeReplications.get(publicKey);
    try {
      entry?.replication?.end?.();
      entry?.replication?.destroy?.();
    } catch (_) {}
    try {
      entry?.stream?.destroy?.();
    } catch (_) {}
    try {
      entry?.channel?.close?.();
    } catch (_) {}
    this.peerHyperbeeReplications.delete(publicKey);
  }
}

export default PublicGatewayService;
