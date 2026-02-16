import {
  normalizeManifest,
  signFederationManifest,
  verifyFederationManifest,
  isManifestExpired,
  findGatewayInManifest
} from '../../../shared/public-gateway/FederationManifest.mjs';

const DEFAULT_MANIFEST_TTL_MS = 60 * 60 * 1000;

function parseJsonEnv(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

class FederationManifestService {
  constructor({ config = {}, logger = console } = {}) {
    this.config = config || {};
    this.logger = logger;
    this.publicKey = this.config?.publicKeyPem || process.env.GATEWAY_FEDERATION_PUBLIC_KEY || null;
    this.privateKey = this.config?.privateKeyPem || process.env.GATEWAY_FEDERATION_PRIVATE_KEY || null;
    this.gatewayId = this.config?.gatewayId || process.env.GATEWAY_FEDERATION_GATEWAY_ID || null;
    this.cachedManifest = null;
  }

  loadManifest() {
    if (this.cachedManifest) {
      return this.cachedManifest;
    }

    const explicit = this.config?.manifest || parseJsonEnv(process.env.GATEWAY_FEDERATION_MANIFEST_JSON);
    if (explicit) {
      const normalized = normalizeManifest(explicit);
      if (normalized.signature && this.publicKey && verifyFederationManifest(normalized, this.publicKey)) {
        this.cachedManifest = normalized;
        return this.cachedManifest;
      }

      if (!normalized.signature && this.privateKey) {
        this.cachedManifest = signFederationManifest(normalized, this.privateKey);
        return this.cachedManifest;
      }

      this.cachedManifest = normalized;
      return this.cachedManifest;
    }

    const manifest = this.#buildDefaultManifest();
    this.cachedManifest = this.privateKey
      ? signFederationManifest(manifest, this.privateKey)
      : manifest;
    return this.cachedManifest;
  }

  getManifest() {
    const manifest = this.loadManifest();
    if (isManifestExpired(manifest)) {
      this.cachedManifest = this.rotateManifest({ epochBump: true });
    }
    return this.cachedManifest;
  }

  verifyManifest(manifest) {
    const normalized = normalizeManifest(manifest);
    if (!normalized.signature) return false;
    if (!this.publicKey) return false;
    if (isManifestExpired(normalized)) return false;
    return verifyFederationManifest(normalized, this.publicKey);
  }

  rotateManifest({ epochBump = false } = {}) {
    const current = this.cachedManifest || this.loadManifest();
    const now = Date.now();
    const ttlMs = Number.isFinite(Number(this.config?.manifestTtlMs)) && Number(this.config.manifestTtlMs) > 0
      ? Math.round(Number(this.config.manifestTtlMs))
      : DEFAULT_MANIFEST_TTL_MS;

    const next = normalizeManifest({
      ...current,
      epoch: epochBump ? Number(current.epoch || 0) + 1 : current.epoch || 0,
      issuedAt: now,
      expiresAt: now + ttlMs
    });

    this.cachedManifest = this.privateKey
      ? signFederationManifest(next, this.privateKey)
      : next;
    return this.cachedManifest;
  }

  getGateway(gatewayId = this.gatewayId) {
    const manifest = this.getManifest();
    return findGatewayInManifest(manifest, gatewayId);
  }

  #buildDefaultManifest() {
    const federationId = this.config?.federationId
      || process.env.GATEWAY_FEDERATION_ID
      || 'hypertuna-federation';
    const topic = this.config?.controlTopic || process.env.GATEWAY_FEDERATION_CONTROL_TOPIC || 'hypertuna-gateway-control-v2';
    const protocol = this.config?.controlProtocol || 'gateway-control-v2';
    const gatewayId = this.gatewayId || process.env.GATEWAY_SWARM_PUBLIC_KEY || 'local-gateway';
    const swarmPublicKey = this.config?.swarmPublicKey || process.env.GATEWAY_SWARM_PUBLIC_KEY || gatewayId;
    const controlBase = this.config?.controlBaseUrl || process.env.GATEWAY_PUBLIC_URL || null;
    const bridgeBase = this.config?.bridgeBaseUrl || process.env.GATEWAY_PUBLIC_URL || null;
    const now = Date.now();
    const ttlMs = Number.isFinite(Number(this.config?.manifestTtlMs)) && Number(this.config.manifestTtlMs) > 0
      ? Math.round(Number(this.config.manifestTtlMs))
      : DEFAULT_MANIFEST_TTL_MS;

    const gatewayEntry = {
      id: gatewayId,
      swarmPublicKey,
      role: 'voter',
      weight: 1,
      controlP2P: {
        topic,
        protocol
      }
    };

    if (typeof controlBase === 'string' && controlBase.trim()) {
      gatewayEntry.controlHttp = { baseUrl: controlBase.trim() };
    }
    if (typeof bridgeBase === 'string' && bridgeBase.trim()) {
      gatewayEntry.bridgeHttp = { baseUrl: bridgeBase.trim() };
    }

    return normalizeManifest({
      federationId,
      epoch: 1,
      minQuorum: 1,
      issuedAt: now,
      expiresAt: now + ttlMs,
      gateways: [gatewayEntry]
    });
  }
}

export default FederationManifestService;
