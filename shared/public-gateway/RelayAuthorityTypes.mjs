import { createHash } from 'node:crypto';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeStringList(values = []) {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next === undefined) continue;
      sorted[key] = stableValue(next);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hashPolicyPayload(policy = {}) {
  return createHash('sha256').update(stableStringify({
    relayKey: policy.relayKey,
    ownerNostrPubkey: policy.ownerNostrPubkey,
    policyVersion: policy.policyVersion,
    validators: policy.validators,
    minQuorumWeight: policy.minQuorumWeight,
    bridgeRules: policy.bridgeRules,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt || null
  })).digest('hex');
}

function normalizeRelayAuthorityPolicy(input = {}) {
  const validators = Array.isArray(input.validators)
    ? input.validators
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const gatewayPubkey = normalizeString(entry.gatewayPubkey || entry.pubkey);
          if (!gatewayPubkey) return null;
          const weight = Number.isFinite(Number(entry.weight)) && Number(entry.weight) > 0
            ? Math.round(Number(entry.weight))
            : 1;
          const caps = normalizeStringList(entry.caps || entry.capabilities || []);
          return {
            gatewayPubkey,
            weight,
            caps: caps.length ? caps : ['open-join', 'closed-join', 'mirror', 'bridge-source']
          };
        })
        .filter(Boolean)
    : [];

  const policy = {
    relayKey: normalizeString(input.relayKey),
    ownerNostrPubkey: normalizeString(input.ownerNostrPubkey),
    policyVersion: Number.isFinite(Number(input.policyVersion)) && Number(input.policyVersion) > 0
      ? Math.round(Number(input.policyVersion))
      : 1,
    validators,
    minQuorumWeight: Number.isFinite(Number(input.minQuorumWeight)) && Number(input.minQuorumWeight) > 0
      ? Math.round(Number(input.minQuorumWeight))
      : 1,
    bridgeRules: {
      allowAnyValidatedSource: input?.bridgeRules?.allowAnyValidatedSource === true,
      allowedGatewayPubkeys: normalizeStringList(input?.bridgeRules?.allowedGatewayPubkeys || []),
      maxBundleAgeMs: Number.isFinite(Number(input?.bridgeRules?.maxBundleAgeMs))
        ? Math.max(1_000, Math.round(Number(input.bridgeRules.maxBundleAgeMs)))
        : (15 * 60 * 1000)
    },
    issuedAt: Number.isFinite(Number(input.issuedAt))
      ? Math.round(Number(input.issuedAt))
      : Date.now(),
    expiresAt: Number.isFinite(Number(input.expiresAt))
      ? Math.round(Number(input.expiresAt))
      : null,
    ownerSig: normalizeString(input.ownerSig),
    signatureBundle: Array.isArray(input.signatureBundle) ? input.signatureBundle : []
  };

  if (!policy.bridgeRules.allowAnyValidatedSource && !policy.bridgeRules.allowedGatewayPubkeys.length) {
    policy.bridgeRules.allowedGatewayPubkeys = validators.map((entry) => entry.gatewayPubkey);
  }

  policy.policyHash = hashPolicyPayload(policy);
  return policy;
}

function resolvePolicyValidatorSet(policy = {}, { capability = null } = {}) {
  const validators = Array.isArray(policy.validators) ? policy.validators : [];
  if (!capability) return validators;
  return validators.filter((entry) => Array.isArray(entry.caps) && entry.caps.includes(capability));
}

function resolvePolicyQuorumWeight(policy = {}, { capability = null } = {}) {
  const validators = resolvePolicyValidatorSet(policy, { capability });
  const fallback = Number.isFinite(Number(policy.minQuorumWeight)) && Number(policy.minQuorumWeight) > 0
    ? Math.round(Number(policy.minQuorumWeight))
    : 1;
  if (!validators.length) return fallback;
  const totalWeight = validators.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0);
  return Math.max(1, Math.min(fallback, totalWeight || fallback));
}

export {
  hashPolicyPayload,
  normalizeRelayAuthorityPolicy,
  resolvePolicyQuorumWeight,
  resolvePolicyValidatorSet,
  stableStringify
};
