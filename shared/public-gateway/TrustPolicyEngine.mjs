function normalizeList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => (typeof value === 'string' ? value.trim() : null))
    .filter(Boolean)));
}

function normalizeTrustPolicy(policy = {}) {
  return {
    explicitAllowlist: normalizeList(policy.explicitAllowlist),
    requireFollowedByMe: policy.requireFollowedByMe !== false,
    requireMutualFollow: policy.requireMutualFollow === true,
    minTrustedAttestations: Number.isFinite(Number(policy.minTrustedAttestations))
      ? Math.max(0, Math.round(Number(policy.minTrustedAttestations)))
      : 0,
    acceptedAttestorPubkeys: normalizeList(policy.acceptedAttestorPubkeys),
    maxDescriptorAgeMs: Number.isFinite(Number(policy.maxDescriptorAgeMs)) && Number(policy.maxDescriptorAgeMs) > 0
      ? Math.round(Number(policy.maxDescriptorAgeMs))
      : 6 * 60 * 60 * 1000
  };
}

class TrustPolicyEngine {
  constructor({ policy = {}, logger = console } = {}) {
    this.logger = logger;
    this.policy = normalizeTrustPolicy(policy);
  }

  updatePolicy(policy = {}) {
    this.policy = normalizeTrustPolicy(policy);
    return this.policy;
  }

  evaluateGateway(descriptor = {}, context = {}) {
    const policy = this.policy;
    const gatewayPubkey = typeof descriptor.gatewayPubkey === 'string'
      ? descriptor.gatewayPubkey.trim()
      : null;

    if (!gatewayPubkey) {
      return { trusted: false, reason: 'missing-gateway-pubkey' };
    }

    const now = Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now();
    const issuedAt = Number(descriptor.issuedAt);
    const expiresAt = Number(descriptor.expiresAt);

    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return { trusted: false, reason: 'descriptor-expired' };
    }

    if (Number.isFinite(issuedAt) && (now - issuedAt) > policy.maxDescriptorAgeMs) {
      return { trusted: false, reason: 'descriptor-too-old' };
    }

    if (policy.explicitAllowlist.length && !policy.explicitAllowlist.includes(gatewayPubkey)) {
      return { trusted: false, reason: 'not-in-explicit-allowlist' };
    }

    const followsByMe = context.followsByMe instanceof Set
      ? context.followsByMe
      : new Set(Array.isArray(context.followsByMe) ? context.followsByMe : []);

    const followersOfMe = context.followersOfMe instanceof Set
      ? context.followersOfMe
      : new Set(Array.isArray(context.followersOfMe) ? context.followersOfMe : []);

    if (policy.requireFollowedByMe && !followsByMe.has(gatewayPubkey)) {
      return { trusted: false, reason: 'not-followed-by-me' };
    }

    if (policy.requireMutualFollow && (!followsByMe.has(gatewayPubkey) || !followersOfMe.has(gatewayPubkey))) {
      return { trusted: false, reason: 'mutual-follow-required' };
    }

    const acceptedAttestors = policy.acceptedAttestorPubkeys.length
      ? new Set(policy.acceptedAttestorPubkeys)
      : null;

    const attestations = Array.isArray(context.attestations) ? context.attestations : [];
    const trustedAttestations = attestations.filter((entry) => {
      const target = typeof entry?.targetPubkey === 'string' ? entry.targetPubkey.trim() : null;
      const attestor = typeof entry?.attestorPubkey === 'string' ? entry.attestorPubkey.trim() : null;
      if (!target || !attestor) return false;
      if (target !== gatewayPubkey) return false;
      if (acceptedAttestors && !acceptedAttestors.has(attestor)) return false;
      return true;
    });

    if (policy.minTrustedAttestations > 0 && trustedAttestations.length < policy.minTrustedAttestations) {
      return { trusted: false, reason: 'insufficient-trusted-attestations' };
    }

    return {
      trusted: true,
      reason: 'trusted',
      evidence: {
        followsByMe: followsByMe.has(gatewayPubkey),
        followedByGateway: followersOfMe.has(gatewayPubkey),
        trustedAttestations: trustedAttestations.length
      }
    };
  }

  filterTrustedGateways(descriptors = [], context = {}) {
    const trusted = [];
    const rejected = [];

    for (const descriptor of descriptors || []) {
      const result = this.evaluateGateway(descriptor, context);
      if (result.trusted) {
        trusted.push({ descriptor, evaluation: result });
      } else {
        rejected.push({ descriptor, evaluation: result });
      }
    }

    return { trusted, rejected };
  }
}

export {
  TrustPolicyEngine,
  normalizeTrustPolicy
};
