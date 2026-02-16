import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

class FederatedEventLog extends EventEmitter {
  constructor({ logger = console, maxInMemoryEvents = 20_000 } = {}) {
    super();
    this.logger = logger;
    this.maxInMemoryEvents = Number.isFinite(Number(maxInMemoryEvents)) && Number(maxInMemoryEvents) > 0
      ? Math.round(Number(maxInMemoryEvents))
      : 20_000;
    this.events = [];
    this.sequence = 0;
    this.eventIds = new Set();
  }

  #appendNormalized(event) {
    this.sequence = event.sequence;
    this.events.push(event);
    this.eventIds.add(event.id);
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
      timestamp: latest?.timestamp || null
    };
  }
}

export default FederatedEventLog;
