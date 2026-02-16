import { randomBytes } from 'node:crypto';

class RelayAuthorityPolicyService {
  constructor({ logger = console, store = null, defaultGatewayPubkey = null } = {}) {
    this.logger = logger;
    this.store = store;
    this.defaultGatewayPubkey = defaultGatewayPubkey || null;
    this.inMemoryPolicies = new Map();
  }

  normalizePolicy(relayKey, policy = {}) {
    const validators = Array.isArray(policy.validators)
      ? policy.validators
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.trim() : null;
            if (!pubkey) return null;
            const weight = Number.isFinite(Number(entry.weight)) && Number(entry.weight) > 0
              ? Math.round(Number(entry.weight))
              : 1;
            return { pubkey, weight };
          })
          .filter(Boolean)
      : [];

    const defaultValidators = validators.length
      ? validators
      : (this.defaultGatewayPubkey ? [{ pubkey: this.defaultGatewayPubkey, weight: 1 }] : []);

    const minQuorumWeight = Number.isFinite(Number(policy.minQuorumWeight)) && Number(policy.minQuorumWeight) > 0
      ? Math.round(Number(policy.minQuorumWeight))
      : 1;

    return {
      relayKey,
      policyVersion: Number.isFinite(Number(policy.policyVersion)) ? Math.max(1, Math.round(Number(policy.policyVersion))) : 1,
      issuedAt: Number.isFinite(Number(policy.issuedAt)) ? Math.round(Number(policy.issuedAt)) : Date.now(),
      expiresAt: Number.isFinite(Number(policy.expiresAt)) ? Math.round(Number(policy.expiresAt)) : null,
      validators: defaultValidators,
      minQuorumWeight,
      ownerSigners: Array.isArray(policy.ownerSigners) ? policy.ownerSigners : [],
      signatureBundle: Array.isArray(policy.signatureBundle) ? policy.signatureBundle : []
    };
  }

  async getPolicy(relayKey) {
    if (!relayKey) return null;

    if (typeof this.store?.getRelayPolicy === 'function') {
      const stored = await this.store.getRelayPolicy(relayKey);
      if (stored) return this.normalizePolicy(relayKey, stored);
    }

    const memory = this.inMemoryPolicies.get(relayKey);
    if (memory) return this.normalizePolicy(relayKey, memory);

    return this.normalizePolicy(relayKey, {});
  }

  async setPolicy(relayKey, policy = {}) {
    if (!relayKey) throw new Error('relayKey is required');
    const normalized = this.normalizePolicy(relayKey, policy);
    this.inMemoryPolicies.set(relayKey, normalized);
    if (typeof this.store?.storeRelayPolicy === 'function') {
      await this.store.storeRelayPolicy(relayKey, normalized);
    }
    return normalized;
  }

  buildSlotKey({ relayKey, writerCoreKey, purpose }) {
    const normalizedPurpose = purpose === 'closed-join' ? 'closed-join' : 'open-join';
    return `${relayKey}:${writerCoreKey}:${normalizedPurpose}`;
  }

  async issueLocalCertificate({ relayKey, writerCoreKey, purpose, leaseId = null, proposerPubkey = null } = {}) {
    const policy = await this.getPolicy(relayKey);
    const slotKey = this.buildSlotKey({ relayKey, writerCoreKey, purpose });
    const selectedValidators = policy.validators || [];
    const selectedPubkeys = selectedValidators.map((entry) => entry.pubkey);
    const quorumWeight = selectedValidators.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0);

    return {
      leaseId: leaseId || randomBytes(16).toString('hex'),
      slotKey,
      policyVersion: policy.policyVersion,
      policyHash: randomBytes(16).toString('hex'),
      quorumWeight,
      requiredQuorumWeight: policy.minQuorumWeight,
      voterPubkeys: selectedPubkeys,
      voterSigs: selectedPubkeys.map((pubkey) => `local-${pubkey.slice(0, 12)}`),
      fencingToken: randomBytes(16).toString('hex'),
      relayKey,
      writerCoreKey,
      purpose: purpose === 'closed-join' ? 'closed-join' : 'open-join',
      proposerPubkey: proposerPubkey || this.defaultGatewayPubkey || null,
      issuedAt: Date.now()
    };
  }

  validateCertificate(certificate = {}, policy = null) {
    if (!certificate || typeof certificate !== 'object') return false;
    const activePolicy = policy || this.inMemoryPolicies.get(certificate.relayKey);
    if (!activePolicy) return false;

    const validators = new Map((activePolicy.validators || []).map((entry) => [entry.pubkey, Number(entry.weight) || 0]));
    const voterPubkeys = Array.isArray(certificate.voterPubkeys) ? certificate.voterPubkeys : [];
    let weight = 0;
    for (const pubkey of voterPubkeys) {
      if (!validators.has(pubkey)) return false;
      weight += validators.get(pubkey);
    }

    return weight >= (activePolicy.minQuorumWeight || 1);
  }
}

export default RelayAuthorityPolicyService;
