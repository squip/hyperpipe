import { EventEmitter } from 'node:events';

class NostrGatewayDirectory extends EventEmitter {
  constructor({ logger = console, fetchEvents = null, now = () => Date.now() } = {}) {
    super();
    this.logger = logger;
    this.fetchEvents = typeof fetchEvents === 'function' ? fetchEvents : null;
    this.now = now;
    this.descriptors = new Map();
    this.attestations = [];
  }

  upsertDescriptor(descriptor = {}) {
    const gatewayPubkey = typeof descriptor.gatewayPubkey === 'string' ? descriptor.gatewayPubkey.trim() : null;
    if (!gatewayPubkey) return false;
    const normalized = {
      gatewayPubkey,
      issuedAt: Number.isFinite(Number(descriptor.issuedAt)) ? Math.round(Number(descriptor.issuedAt)) : this.now(),
      expiresAt: Number.isFinite(Number(descriptor.expiresAt)) ? Math.round(Number(descriptor.expiresAt)) : (this.now() + 60_000),
      controlP2P: descriptor.controlP2P && typeof descriptor.controlP2P === 'object'
        ? {
          topic: typeof descriptor.controlP2P.topic === 'string' ? descriptor.controlP2P.topic.trim() : null,
          protocol: typeof descriptor.controlP2P.protocol === 'string' ? descriptor.controlP2P.protocol.trim() : null,
          swarmPublicKey: typeof descriptor.controlP2P.swarmPublicKey === 'string'
            ? descriptor.controlP2P.swarmPublicKey.trim()
            : null
        }
        : null,
      controlHttp: descriptor.controlHttp && typeof descriptor.controlHttp === 'object'
        ? { baseUrl: typeof descriptor.controlHttp.baseUrl === 'string' ? descriptor.controlHttp.baseUrl.trim() : null }
        : null,
      bridgeHttp: descriptor.bridgeHttp && typeof descriptor.bridgeHttp === 'object'
        ? { baseUrl: typeof descriptor.bridgeHttp.baseUrl === 'string' ? descriptor.bridgeHttp.baseUrl.trim() : null }
        : null,
      stateFeeds: Array.isArray(descriptor.stateFeeds) ? descriptor.stateFeeds : [],
      capabilities: Array.isArray(descriptor.capabilities) ? descriptor.capabilities : [],
      descriptorVersion: Number.isFinite(Number(descriptor.descriptorVersion)) ? Math.round(Number(descriptor.descriptorVersion)) : 1,
      signature: typeof descriptor.signature === 'string' ? descriptor.signature : null,
      sourceEventId: descriptor.sourceEventId || null
    };

    this.descriptors.set(gatewayPubkey, normalized);
    this.emit('descriptor', normalized);
    return true;
  }

  addAttestation(attestation = {}) {
    const normalized = {
      attestorPubkey: typeof attestation.attestorPubkey === 'string' ? attestation.attestorPubkey.trim() : null,
      targetPubkey: typeof attestation.targetPubkey === 'string' ? attestation.targetPubkey.trim() : null,
      issuedAt: Number.isFinite(Number(attestation.issuedAt)) ? Math.round(Number(attestation.issuedAt)) : this.now(),
      expiresAt: Number.isFinite(Number(attestation.expiresAt)) ? Math.round(Number(attestation.expiresAt)) : null,
      score: Number.isFinite(Number(attestation.score)) ? Number(attestation.score) : 1,
      sourceEventId: attestation.sourceEventId || null
    };
    if (!normalized.attestorPubkey || !normalized.targetPubkey) return false;
    this.attestations.push(normalized);
    this.emit('attestation', normalized);
    return true;
  }

  listDescriptors({ includeExpired = false } = {}) {
    const now = this.now();
    const values = Array.from(this.descriptors.values());
    if (includeExpired) return values;
    return values.filter((descriptor) => !Number.isFinite(Number(descriptor.expiresAt)) || Number(descriptor.expiresAt) > now);
  }

  listAttestations({ targetPubkey = null, includeExpired = false } = {}) {
    const now = this.now();
    return this.attestations.filter((attestation) => {
      if (targetPubkey && attestation.targetPubkey !== targetPubkey) return false;
      if (includeExpired) return true;
      if (!Number.isFinite(Number(attestation.expiresAt))) return true;
      return Number(attestation.expiresAt) > now;
    });
  }

  async refresh() {
    if (!this.fetchEvents) return { descriptors: 0, attestations: 0 };
    const events = await this.fetchEvents();
    const list = Array.isArray(events) ? events : [];
    let descriptorCount = 0;
    let attestationCount = 0;

    for (const event of list) {
      const kind = event?.kind;
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : null;
      if (!payload) continue;
      if (kind === 'gateway-descriptor') {
        if (this.upsertDescriptor({ ...payload, sourceEventId: event.id || null })) {
          descriptorCount += 1;
        }
      } else if (kind === 'gateway-attestation') {
        if (this.addAttestation({ ...payload, sourceEventId: event.id || null })) {
          attestationCount += 1;
        }
      }
    }

    return { descriptors: descriptorCount, attestations: attestationCount };
  }

  buildCatalog({ includeExpired = false } = {}) {
    const descriptors = this.listDescriptors({ includeExpired });
    const attestations = this.listAttestations({ includeExpired });
    return {
      generatedAt: this.now(),
      descriptors,
      attestations
    };
  }
}

export default NostrGatewayDirectory;
