import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';

import { stableStringify } from '../../../shared/public-gateway/RelayAuthorityTypes.mjs';

class FederatedEventLog extends EventEmitter {
  constructor({
    logger = console,
    maxInMemoryEvents = 20_000,
    validateExternalEvent = null
  } = {}) {
    super();
    this.logger = logger;
    this.maxInMemoryEvents = Number.isFinite(Number(maxInMemoryEvents)) && Number(maxInMemoryEvents) > 0
      ? Math.round(Number(maxInMemoryEvents))
      : 20_000;
    this.events = [];
    this.sequence = 0;
    this.eventIds = new Set();
    this.latestBySource = new Map();
    this.validateExternalEvent = typeof validateExternalEvent === 'function'
      ? validateExternalEvent
      : null;
  }

  #appendNormalized(event) {
    this.sequence = event.sequence;
    this.events.push(event);
    this.eventIds.add(event.id);
    const sourceGatewayId = typeof event?.metadata?.sourceGatewayId === 'string'
      ? event.metadata.sourceGatewayId
      : null;
    if (sourceGatewayId) {
      this.latestBySource.set(sourceGatewayId, {
        sequence: event.sequence,
        eventId: event.id,
        timestamp: event.timestamp
      });
    }
    if (this.events.length > this.maxInMemoryEvents) {
      const removed = this.events.splice(0, this.events.length - this.maxInMemoryEvents);
      for (const entry of removed) {
        if (entry?.id) this.eventIds.delete(entry.id);
      }
    }
    this.emit('append', event);
    return event;
  }

  append(eventType, payload = {}, metadata = {}) {
    if (!eventType || typeof eventType !== 'string') {
      throw new Error('eventType is required');
    }

    const event = {
      id: randomBytes(16).toString('hex'),
      sequence: this.sequence + 1,
      eventType,
      payload: payload || {},
      metadata: metadata || {},
      timestamp: Date.now()
    };
    event.digest = createHash('sha256').update(stableStringify({
      eventType: event.eventType,
      payload: event.payload,
      metadata: event.metadata,
      timestamp: event.timestamp
    })).digest('hex');

    return this.#appendNormalized(event);
  }

  appendExternal(input = {}, metadata = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('external event is required');
    }
    if (!input.eventType || typeof input.eventType !== 'string') {
      throw new Error('external eventType is required');
    }

    const eventId = typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : randomBytes(16).toString('hex');

    if (this.eventIds.has(eventId)) {
      return null;
    }

    if (this.validateExternalEvent) {
      const result = this.validateExternalEvent(input);
      if (result === false) {
        this.logger?.debug?.('[FederatedEventLog] external event rejected by validator', {
          eventId,
          eventType: input?.eventType
        });
        return null;
      }
    }

    const event = {
      id: eventId,
      sequence: this.sequence + 1,
      eventType: input.eventType,
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
      metadata: {
        ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        replicated: true
      },
      timestamp: Number.isFinite(Number(input.timestamp))
        ? Math.round(Number(input.timestamp))
        : Date.now()
    };
    event.digest = typeof input.digest === 'string' && input.digest.trim()
      ? input.digest.trim()
      : createHash('sha256').update(stableStringify({
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata,
          timestamp: event.timestamp
        })).digest('hex');

    return this.#appendNormalized(event);
  }

  list({ sinceSequence = 0, limit = 500 } = {}) {
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(5_000, Math.round(Number(limit)))
      : 500;
    return this.events
      .filter((event) => event.sequence > sinceSequence)
      .slice(0, max);
  }

  latest() {
    return this.events.length ? this.events[this.events.length - 1] : null;
  }

  checkpoint() {
    const latest = this.latest();
    return {
      sequence: latest?.sequence || 0,
      eventId: latest?.id || null,
      timestamp: latest?.timestamp || null,
      bySource: Object.fromEntries(this.latestBySource.entries())
    };
  }
}

export default FederatedEventLog;
