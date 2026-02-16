class ControlHttpFallbackHandlers {
  constructor({ app, delegates = {}, logger = console } = {}) {
    this.app = app;
    this.delegates = delegates || {};
    this.logger = logger;
  }

  register() {
    if (!this.app) return;

    this.app.get('/api/v2/discovery/catalog', (req, res) => this.#invoke('discoveryCatalog', req, res));
    this.app.get('/api/v2/mesh/catalog', (req, res) => this.#invoke('discoveryCatalog', req, res));
    this.app.get('/api/v2/mesh/state', (req, res) => this.#invoke('meshStateRead', req, res));
    this.app.post('/api/v2/mesh/state/append', (req, res) => this.#invoke('meshStateAppend', req, res));
    this.app.post('/api/v2/mesh/lease/vote', (req, res) => this.#invoke('meshLeaseVote', req, res));
    this.app.get('/api/v2/relays/:relayKey/policy', (req, res) => this.#invoke('relayPolicyRead', req, res));

    this.app.post('/api/v2/auth/challenge', (req, res) => this.#invoke('authChallenge', req, res));
    this.app.post('/api/v2/auth/session', (req, res) => this.#invoke('authSession', req, res));

    this.app.post('/api/v2/relays/register', (req, res) => this.#invoke('relayRegister', req, res));
    this.app.get('/api/v2/relays/:relayKey/mirror', (req, res) => this.#invoke('mirrorRead', req, res));

    this.app.get('/api/v2/relays/:relayKey/open-join/challenge', (req, res) => this.#invoke('openJoinChallenge', req, res));
    this.app.post('/api/v2/relays/:relayKey/open-join/pool', (req, res) => this.#invoke('openJoinPoolSync', req, res));
    this.app.post('/api/v2/relays/:relayKey/open-join/lease', (req, res) => this.#invoke('openJoinLeaseClaim', req, res));
    this.app.post('/api/v2/relays/:relayKey/open-join/append-cores', (req, res) => this.#invoke('openJoinAppendCores', req, res));

    this.app.post('/api/v2/relays/:relayKey/closed-join/pool', (req, res) => this.#invoke('closedJoinPoolSync', req, res));
    this.app.post('/api/v2/relays/:relayKey/closed-join/lease', (req, res) => this.#invoke('closedJoinLeaseClaim', req, res));
  }

  async #invoke(delegateName, req, res) {
    const delegate = this.delegates?.[delegateName];
    if (typeof delegate !== 'function') {
      return res.status(404).json({ error: `unsupported-control-endpoint:${delegateName}` });
    }

    try {
      await delegate(req, res);
    } catch (error) {
      this.logger?.warn?.('[ControlHttpFallbackHandlers] Delegate failed', {
        delegate: delegateName,
        error: error?.message || error
      });
      if (!res.headersSent) {
        res.status(500).json({ error: error?.message || 'internal-error' });
      }
    }
  }
}

export default ControlHttpFallbackHandlers;
