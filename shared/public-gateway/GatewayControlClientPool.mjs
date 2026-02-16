import { randomBytes } from 'node:crypto';

import HttpGatewayControlClient from './HttpGatewayControlClient.mjs';
import P2PGatewayControlClient from './P2PGatewayControlClient.mjs';
import { READ_METHODS } from './ControlPlaneMethods.mjs';

const DEFAULT_HEDGE_DELAY_MS = 120;

function nowMs() {
  return Date.now();
}

function normalizeGatewayMap(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  const entries = {};
  for (const [id, source] of Object.entries(raw)) {
    if (!source || typeof source !== 'object') continue;
    const gatewayId = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : id;
    const health = source.health === 'offline' ? 'offline' : (source.health === 'degraded' ? 'degraded' : 'healthy');
    entries[gatewayId] = {
      id: gatewayId,
      swarmPublicKey: typeof source.swarmPublicKey === 'string' ? source.swarmPublicKey.trim() : null,
      controlTopic: typeof source.controlTopic === 'string' ? source.controlTopic.trim() : null,
      baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim() : null,
      wsUrl: typeof source.wsUrl === 'string' ? source.wsUrl.trim() : null,
      health,
      latencyMs: Number.isFinite(Number(source.latencyMs)) ? Number(source.latencyMs) : null,
      lastSeenAt: Number.isFinite(Number(source.lastSeenAt)) ? Number(source.lastSeenAt) : null
    };
  }
  return entries;
}

class GatewayControlClientPool {
  constructor({
    gateways = {},
    preferredGatewayIds = [],
    connectionPool = null,
    fetchImpl = globalThis.fetch,
    logger = console,
    hedgeDelayMs = DEFAULT_HEDGE_DELAY_MS,
    preferP2P = true
  } = {}) {
    this.connectionPool = connectionPool;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.preferP2P = preferP2P !== false;
    this.hedgeDelayMs = Number.isFinite(Number(hedgeDelayMs)) && Number(hedgeDelayMs) > 0
      ? Math.round(Number(hedgeDelayMs))
      : DEFAULT_HEDGE_DELAY_MS;
    this.gatewayStats = new Map();
    this.updateGateways({ gateways, preferredGatewayIds });
  }

  updateGateways({ gateways = null, preferredGatewayIds = null } = {}) {
    if (gateways) {
      this.gateways = normalizeGatewayMap(gateways);
    } else if (!this.gateways) {
      this.gateways = {};
    }
    if (Array.isArray(preferredGatewayIds)) {
      this.preferredGatewayIds = preferredGatewayIds
        .map((value) => (typeof value === 'string' ? value.trim() : null))
        .filter(Boolean);
    } else if (!this.preferredGatewayIds) {
      this.preferredGatewayIds = [];
    }
  }

  getGatewaySnapshot() {
    return {
      gateways: { ...this.gateways },
      preferredGatewayIds: [...this.preferredGatewayIds]
    };
  }

  async request(methodName, payload = {}, options = {}) {
    const isRead = READ_METHODS.has(methodName);
    const candidates = this.#resolveCandidates(options);
    if (!candidates.length) {
      throw new Error('No gateways available for control request');
    }

    const requestPayload = { ...(payload || {}) };
    const shouldAttachRequestId = !isRead;
    if (shouldAttachRequestId && !requestPayload.requestId) {
      requestPayload.requestId = randomBytes(8).toString('hex');
    }

    if (isRead && options.hedged !== false && candidates.length > 1) {
      return this.#hedgedRead(methodName, requestPayload, candidates, options);
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        return await this.#requestGateway(candidate, methodName, requestPayload, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Control request failed');
  }

  #gatewayScore(gateway) {
    const stat = this.gatewayStats.get(gateway.id) || {};
    const failures = Number.isFinite(stat.failures) ? stat.failures : 0;
    const latency = Number.isFinite(stat.latencyMs)
      ? stat.latencyMs
      : (Number.isFinite(gateway.latencyMs) ? gateway.latencyMs : 250);
    const healthPenalty = gateway.health === 'offline' ? 10_000 : gateway.health === 'degraded' ? 500 : 0;
    return failures * 1_000 + latency + healthPenalty;
  }

  #sortedCandidates() {
    const mapValues = Object.values(this.gateways || {});
    const preferred = [];
    const remainder = [];
    const preferredSet = new Set(this.preferredGatewayIds || []);

    for (const gateway of mapValues) {
      if (!gateway?.id) continue;
      if (preferredSet.has(gateway.id)) preferred.push(gateway);
      else remainder.push(gateway);
    }

    const sorter = (a, b) => this.#gatewayScore(a) - this.#gatewayScore(b);
    preferred.sort(sorter);
    remainder.sort(sorter);
    return [...preferred, ...remainder].filter((entry) => entry.health !== 'offline');
  }

  #resolveCandidates(options = {}) {
    const candidates = this.#sortedCandidates();
    if (!candidates.length) return candidates;

    const requestedGatewayId = typeof options?.gatewayId === 'string'
      ? options.gatewayId.trim()
      : null;
    if (!requestedGatewayId) return candidates;

    const requested = candidates.find((entry) => entry.id === requestedGatewayId) || null;
    if (!requested) {
      if (options?.onlyGateway === true) {
        throw new Error(`Requested gateway is unavailable: ${requestedGatewayId}`);
      }
      return candidates;
    }

    if (options?.onlyGateway === true) {
      return [requested];
    }

    return [requested, ...candidates.filter((entry) => entry.id !== requestedGatewayId)];
  }

  async #hedgedRead(methodName, payload, candidates, options) {
    const first = candidates[0];
    const second = candidates[1];
    const firstPromise = this.#requestGateway(first, methodName, payload, options)
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }));

    const secondPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#requestGateway(second, methodName, payload, options)
          .then((value) => resolve({ ok: true, value }))
          .catch((error) => resolve({ ok: false, error }));
      }, this.hedgeDelayMs);
      timer.unref?.();
    });

    const firstResult = await Promise.race([firstPromise, secondPromise]);
    if (firstResult.ok) return firstResult.value;

    const firstDone = await firstPromise;
    if (firstDone.ok) return firstDone.value;

    const secondDone = await secondPromise;
    if (secondDone.ok) return secondDone.value;

    throw firstDone.error || secondDone.error || new Error('Hedged read failed');
  }

  async #requestGateway(gateway, methodName, payload, options = {}) {
    const start = nowMs();
    try {
      const clients = this.#buildClients(gateway, options);
      if (!clients.length) {
        throw new Error(`Gateway ${gateway.id} has no usable control transport`);
      }

      const requestOptions = {
        ...(options || {})
      };
      if (!Number.isFinite(Number(requestOptions.timeoutMs)) || Number(requestOptions.timeoutMs) <= 0) {
        requestOptions.timeoutMs = 60_000;
      }

      let response = null;
      let responseTransport = null;
      let lastError = null;
      const hasHttpFallback = clients.some((client) => client.transport === 'http');
      for (const client of clients) {
        const perTransportOptions = {
          ...requestOptions
        };
        if (client.transport === 'p2p' && hasHttpFallback) {
          const p2pFallbackTimeoutMs = Number.isFinite(Number(options?.p2pFallbackTimeoutMs))
            ? Math.max(500, Math.round(Number(options.p2pFallbackTimeoutMs)))
            : 5_000;
          perTransportOptions.timeoutMs = Math.min(
            Number(perTransportOptions.timeoutMs),
            p2pFallbackTimeoutMs
          );
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          response = await client.request(methodName, payload, perTransportOptions);
          responseTransport = client.transport || null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (response == null) {
        throw lastError || new Error('Control request failed');
      }

      this.#recordGatewayStat(gateway.id, {
        success: true,
        latencyMs: nowMs() - start
      });
      return {
        gatewayId: gateway.id,
        transport: responseTransport || clients[0]?.transport || (gateway.swarmPublicKey && this.connectionPool ? 'p2p' : 'http'),
        data: response
      };
    } catch (error) {
      this.#recordGatewayStat(gateway.id, {
        success: false,
        latencyMs: nowMs() - start
      });
      throw error;
    }
  }

  #buildClients(gateway, options = {}) {
    const clients = [];
    const transportMode = typeof options?.transportMode === 'string'
      ? options.transportMode.trim().toLowerCase()
      : null;
    const httpOnly = transportMode === 'http-required' || transportMode === 'http-only';
    const p2pOnly = transportMode === 'p2p-only';
    const canP2P = !!(gateway.swarmPublicKey && this.connectionPool);
    const canHttp = !!gateway.baseUrl;

    if (httpOnly) {
      if (canHttp) {
        clients.push({
          transport: 'http',
          request: (methodName, payload, requestOptions) => {
            const client = new HttpGatewayControlClient({
              baseUrl: gateway.baseUrl,
              fetchImpl: this.fetch,
              logger: this.logger
            });
            return client.request(methodName, payload, requestOptions);
          }
        });
      }
      return clients;
    }

    if (p2pOnly) {
      if (canP2P) {
        clients.push({
          transport: 'p2p',
          request: (methodName, payload, requestOptions) => {
            const client = new P2PGatewayControlClient({
              connectionPool: this.connectionPool,
              peerPublicKey: gateway.swarmPublicKey,
              logger: this.logger
            });
            return client.request(methodName, payload, requestOptions);
          }
        });
      }
      return clients;
    }

    if (this.preferP2P && canP2P) {
      clients.push({
        transport: 'p2p',
        request: (methodName, payload, requestOptions) => {
          const client = new P2PGatewayControlClient({
            connectionPool: this.connectionPool,
            peerPublicKey: gateway.swarmPublicKey,
            logger: this.logger
          });
          return client.request(methodName, payload, requestOptions);
        }
      });
    }

    if (canHttp) {
      clients.push({
        transport: 'http',
        request: (methodName, payload, requestOptions) => {
          const client = new HttpGatewayControlClient({
            baseUrl: gateway.baseUrl,
            fetchImpl: this.fetch,
            logger: this.logger
          });
          return client.request(methodName, payload, requestOptions);
        }
      });
    }

    if (!this.preferP2P && canP2P) {
      clients.push({
        transport: 'p2p',
        request: (methodName, payload, requestOptions) => {
          const client = new P2PGatewayControlClient({
            connectionPool: this.connectionPool,
            peerPublicKey: gateway.swarmPublicKey,
            logger: this.logger
          });
          return client.request(methodName, payload, requestOptions);
        }
      });
    }

    return clients;
  }

  #recordGatewayStat(gatewayId, { success, latencyMs }) {
    const current = this.gatewayStats.get(gatewayId) || {
      failures: 0,
      successes: 0,
      latencyMs: null,
      lastSeenAt: null
    };

    if (success) {
      current.successes += 1;
      current.failures = Math.max(0, current.failures - 1);
    } else {
      current.failures += 1;
    }

    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      current.latencyMs = Number.isFinite(current.latencyMs)
        ? Math.round((current.latencyMs * 0.7) + (latencyMs * 0.3))
        : Math.round(latencyMs);
    }

    current.lastSeenAt = Date.now();
    this.gatewayStats.set(gatewayId, current);

    if (this.gateways?.[gatewayId]) {
      const nextHealth = current.failures >= 3
        ? 'degraded'
        : 'healthy';
      this.gateways[gatewayId] = {
        ...this.gateways[gatewayId],
        health: nextHealth,
        latencyMs: current.latencyMs,
        lastSeenAt: current.lastSeenAt
      };
    }
  }
}

export default GatewayControlClientPool;
