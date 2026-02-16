import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify
} from 'node:crypto';

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('Expected non-empty base64url string');
  }
  return Buffer.from(value, 'base64url');
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] === undefined) return acc;
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function normalizeGateway(value = {}) {
  const gateway = {
    id: typeof value.id === 'string' ? value.id.trim() : '',
    swarmPublicKey: typeof value.swarmPublicKey === 'string' ? value.swarmPublicKey.trim() : '',
    role: value.role === 'observer' ? 'observer' : 'voter',
    weight: Number.isFinite(Number(value.weight)) && Number(value.weight) > 0
      ? Math.round(Number(value.weight))
      : 1,
    controlP2P: {
      topic: typeof value?.controlP2P?.topic === 'string'
        ? value.controlP2P.topic.trim()
        : '',
      protocol: typeof value?.controlP2P?.protocol === 'string'
        ? value.controlP2P.protocol.trim()
        : 'gateway-control-v2'
    }
  };

  const controlBase = typeof value?.controlHttp?.baseUrl === 'string'
    ? value.controlHttp.baseUrl.trim()
    : '';
  if (controlBase) {
    gateway.controlHttp = { baseUrl: controlBase };
  }

  const bridgeBase = typeof value?.bridgeHttp?.baseUrl === 'string'
    ? value.bridgeHttp.baseUrl.trim()
    : '';
  if (bridgeBase) {
    gateway.bridgeHttp = { baseUrl: bridgeBase };
  }

  return gateway;
}

function normalizeManifest(manifest = {}) {
  const gatewaysRaw = Array.isArray(manifest.gateways) ? manifest.gateways : [];
  const gateways = gatewaysRaw
    .map(normalizeGateway)
    .filter((entry) => entry.id && entry.swarmPublicKey);

  return {
    federationId: typeof manifest.federationId === 'string' ? manifest.federationId.trim() : '',
    epoch: Number.isFinite(Number(manifest.epoch)) ? Math.max(0, Math.round(Number(manifest.epoch))) : 0,
    minQuorum: Number.isFinite(Number(manifest.minQuorum)) ? Math.max(1, Math.round(Number(manifest.minQuorum))) : 1,
    issuedAt: Number.isFinite(Number(manifest.issuedAt)) ? Math.round(Number(manifest.issuedAt)) : Date.now(),
    expiresAt: Number.isFinite(Number(manifest.expiresAt)) ? Math.round(Number(manifest.expiresAt)) : (Date.now() + 60_000),
    gateways,
    signature: typeof manifest.signature === 'string' ? manifest.signature.trim() : ''
  };
}

function manifestPayload(manifest = {}) {
  const normalized = normalizeManifest(manifest);
  return {
    federationId: normalized.federationId,
    epoch: normalized.epoch,
    minQuorum: normalized.minQuorum,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt,
    gateways: normalized.gateways
  };
}

function manifestPayloadBuffer(manifest = {}) {
  return Buffer.from(stableStringify(manifestPayload(manifest)), 'utf8');
}

function coercePrivateKey(privateKey) {
  if (!privateKey) {
    throw new Error('Manifest private key is required');
  }
  if (typeof privateKey === 'object' && privateKey.type === 'private') {
    return privateKey;
  }
  if (typeof privateKey !== 'string') {
    throw new Error('Manifest private key must be a PEM string or KeyObject');
  }
  return createPrivateKey(privateKey);
}

function coercePublicKey(publicKey) {
  if (!publicKey) {
    throw new Error('Manifest public key is required');
  }
  if (typeof publicKey === 'object' && publicKey.type === 'public') {
    return publicKey;
  }
  if (typeof publicKey !== 'string') {
    throw new Error('Manifest public key must be a PEM string or KeyObject');
  }
  return createPublicKey(publicKey);
}

function signFederationManifest(manifest = {}, privateKey) {
  const normalized = normalizeManifest(manifest);
  const payload = manifestPayloadBuffer(normalized);
  const signature = sign(null, payload, coercePrivateKey(privateKey));
  return {
    ...normalized,
    signature: base64UrlEncode(signature)
  };
}

function verifyFederationManifest(manifest = {}, publicKey) {
  const normalized = normalizeManifest(manifest);
  if (!normalized.signature) return false;
  if (!normalized.federationId || !normalized.gateways.length) return false;
  const payload = manifestPayloadBuffer(normalized);
  const signature = base64UrlDecode(normalized.signature);
  return verify(null, payload, coercePublicKey(publicKey), signature);
}

function isManifestExpired(manifest = {}, now = Date.now()) {
  const expiresAt = Number(manifest?.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now;
}

function findGatewayInManifest(manifest = {}, gatewayId = null) {
  if (!gatewayId) return null;
  const normalized = normalizeManifest(manifest);
  return normalized.gateways.find((entry) => entry.id === gatewayId) || null;
}

export {
  findGatewayInManifest,
  isManifestExpired,
  manifestPayload,
  normalizeManifest,
  signFederationManifest,
  verifyFederationManifest
};
