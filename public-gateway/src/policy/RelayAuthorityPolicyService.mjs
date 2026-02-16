import { randomBytes } from 'node:crypto';

import {
  hashPolicyPayload,
  normalizeRelayAuthorityPolicy,
  resolvePolicyQuorumWeight
} from '../../../shared/public-gateway/RelayAuthorityTypes.mjs';

class RelayAuthorityPolicyService {
  constructor({ logger = console, store = null, defaultGatewayPubkey = null } = {}) {
    this.logger = logger;
    this.store = store;
    this.defaultGatewayPubkey = defaultGatewayPubkey || null;
    this.inMemoryPolicies = new Map();
  }

  normalizePolicy(relayKey, policy = {}) {
    const normalized = normalizeRelayAuthorityPolicy({
      ...policy,
      relayKey
    });

    if (!normalized.validators.length && this.defaultGatewayPubkey) {
      normalized.validators = [{
        gatewayPubkey: this.defaultGatewayPubkey,
        weight: 1,
        caps: ['open-join', 'closed-join', 'mirror', 'bridge-source']
      }];
    }

    normalized.policyHash = hashPolicyPayload(normalized);
    return normalized;
  }

  async getPolicy(relayKey, { includeDefault = true } = {}) {
    if (!relayKey) return null;

    if (typeof this.store?.getRelayPolicy === 'function') {
      const stored = await this.store.getRelayPolicy(relayKey);
      if (stored) return this.normalizePolicy(relayKey, stored);
    }

    const memory = this.inMemoryPolicies.get(relayKey);
    if (memory) return this.normalizePolicy(relayKey, memory);

    if (!includeDefault) {
      return null;
    }

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
    const selectedValidators = Array.isArray(policy.validators) ? policy.validators : [];
    const selectedPubkeys = selectedValidators
      .map((entry) => entry.gatewayPubkey || entry.pubkey)
      .filter(Boolean);
    const quorumWeight = selectedValidators.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0);
    const minQuorumWeight = resolvePolicyQuorumWeight(policy, { capability: purpose === 'closed-join' ? 'closed-join' : 'open-join' });

    return {
      leaseId: leaseId || randomBytes(16).toString('hex'),
      slotKey,
      policyVersion: policy.policyVersion,
      policyHash: policy.policyHash || hashPolicyPayload(policy),
      quorumWeight,
      requiredQuorumWeight: minQuorumWeight,
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

  verifyOwnerSignature(policy = {}) {
    // Current implementation is policy-agnostic to signature algorithm; we require signature presence.
    return typeof policy?.ownerSig === 'string' && policy.ownerSig.trim().length > 0;
  }

  validateCertificate(certificate = {}, policy = null) {
    if (!certificate || typeof certificate !== 'object') return false;
    const activePolicy = policy || this.inMemoryPolicies.get(certificate.relayKey);
    if (!activePolicy) return false;

    const validators = new Map(
      (activePolicy.validators || [])
        .map((entry) => [entry.gatewayPubkey || entry.pubkey, Number(entry.weight) || 0])
    );
    const voterPubkeys = Array.isArray(certificate.voterPubkeys)
      ? certificate.voterPubkeys
      : (Array.isArray(certificate.voterGatewayIds) ? certificate.voterGatewayIds : []);
    let weight = 0;
    for (const pubkey of voterPubkeys) {
      if (!validators.has(pubkey)) return false;
      weight += validators.get(pubkey);
    }

    const requiredWeight = resolvePolicyQuorumWeight(activePolicy, {
      capability: certificate?.purpose === 'closed-join' ? 'closed-join' : 'open-join'
    });
    return weight >= requiredWeight;
  }
}

export default RelayAuthorityPolicyService;
