import { forwardRequestToPeer } from './HyperswarmClient.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

class P2PGatewayControlClient {
  constructor({ connectionPool, peerPublicKey, logger = console } = {}) {
    this.connectionPool = connectionPool;
    this.peerPublicKey = typeof peerPublicKey === 'string' ? peerPublicKey.trim() : null;
    this.logger = logger;
    if (!this.connectionPool) {
      throw new Error('P2PGatewayControlClient requires connectionPool');
    }
    if (!this.peerPublicKey) {
      throw new Error('P2PGatewayControlClient requires peerPublicKey');
    }
  }

  async request(methodName, payload = {}, options = {}) {
    if (!methodName || typeof methodName !== 'string') {
      throw new Error('methodName is required for P2P control request');
    }

    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.round(Number(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;

    const request = {
      method: 'POST',
      path: `/rpc/${methodName}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-control-timeout-ms': String(timeoutMs)
      },
      body: Buffer.from(JSON.stringify(payload || {}), 'utf8')
    };

    const response = await forwardRequestToPeer(
      { publicKey: this.peerPublicKey },
      request,
      this.connectionPool
    );

    const text = Buffer.from(response?.body || Buffer.alloc(0)).toString('utf8');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = { raw: text };
      }
    }

    const statusCode = Number(response?.statusCode) || 500;
    if (statusCode >= 400) {
      const error = new Error(parsed?.error || `P2P status ${statusCode}`);
      error.statusCode = statusCode;
      error.payload = parsed;
      throw error;
    }

    return parsed;
  }
}

export default P2PGatewayControlClient;
