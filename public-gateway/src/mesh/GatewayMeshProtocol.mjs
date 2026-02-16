import { EventEmitter } from 'node:events';

class GatewayMeshProtocol extends EventEmitter {
  constructor({ logger = console, manifestService = null } = {}) {
    super();
    this.logger = logger;
    this.manifestService = manifestService;
    this.protocols = new Map();
  }

  attachProtocol(peerKey, protocol) {
    if (!peerKey || !protocol) return;
    this.protocols.set(peerKey, protocol);

    const cleanup = () => {
      this.protocols.delete(peerKey);
    };

    protocol.once?.('close', cleanup);
    protocol.once?.('destroy', cleanup);

    this.emit('peer-attached', {
      peerKey,
      protocol
    });
  }

  detachProtocol(peerKey) {
    if (!peerKey) return;
    this.protocols.delete(peerKey);
    this.emit('peer-detached', { peerKey });
  }

  getPeers() {
    return Array.from(this.protocols.keys());
  }

  getPeerCount() {
    return this.protocols.size;
  }

  async broadcastControl(methodName, payload = {}) {
    const peers = Array.from(this.protocols.entries());
    const results = [];
    for (const [peerKey, protocol] of peers) {
      try {
        // RelayProtocol exposes callControlMethod in v2.
        if (typeof protocol?.callControlMethod !== 'function') continue;
        // eslint-disable-next-line no-await-in-loop
        const data = await protocol.callControlMethod(methodName, payload);
        results.push({ peerKey, ok: true, data });
      } catch (error) {
        results.push({ peerKey, ok: false, error: error?.message || String(error) });
      }
    }
    return results;
  }

  buildSignedEnvelope(type, payload = {}, signer = null) {
    const message = {
      type,
      payload,
      timestamp: Date.now(),
      nonce: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    };
    if (typeof signer === 'function') {
      try {
        message.signature = signer(message);
      } catch (error) {
        this.logger?.warn?.('[GatewayMeshProtocol] Failed to sign mesh envelope', {
          error: error?.message || error
        });
      }
    }
    return message;
  }
}

export default GatewayMeshProtocol;
