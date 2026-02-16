const CONTROL_METHODS = Object.freeze({
  MESH_CATALOG_READ: 'gateway.control.mesh.catalog.read',
  MESH_STATE_READ: 'gateway.control.mesh.state.read',
  MESH_STATE_APPEND: 'gateway.control.mesh.state.append',
  MESH_LEASE_VOTE: 'gateway.control.mesh.lease.vote',
  AUTH_CHALLENGE: 'gateway.control.auth.challenge',
  AUTH_SESSION: 'gateway.control.auth.session',
  RELAY_AUTHORITY_READ: 'gateway.control.relay.authority.read',
  RELAY_AUTHORITY_UPSERT: 'gateway.control.relay.authority.upsert',
  BRIDGE_BUNDLE_READ: 'gateway.control.bridge.bundle.read',
  BRIDGE_BUNDLE_PUSH: 'gateway.control.bridge.bundle.push',
  RELAY_POLICY_READ: 'gateway.control.relay.policy.read',
  RELAY_REGISTER: 'gateway.control.relay.register',
  MIRROR_READ: 'gateway.control.mirror.read',
  OPEN_JOIN_CHALLENGE: 'gateway.control.open_join.challenge',
  OPEN_JOIN_POOL_SYNC: 'gateway.control.open_join.pool_sync',
  OPEN_JOIN_LEASE_CLAIM: 'gateway.control.open_join.lease_claim',
  OPEN_JOIN_APPEND_CORES: 'gateway.control.open_join.append_cores',
  CLOSED_JOIN_POOL_SYNC: 'gateway.control.closed_join.pool_sync',
  CLOSED_JOIN_LEASE_CLAIM: 'gateway.control.closed_join.lease_claim'
});

const READ_METHODS = new Set([
  CONTROL_METHODS.MESH_CATALOG_READ,
  CONTROL_METHODS.MESH_STATE_READ,
  CONTROL_METHODS.RELAY_AUTHORITY_READ,
  CONTROL_METHODS.BRIDGE_BUNDLE_READ,
  CONTROL_METHODS.RELAY_POLICY_READ,
  CONTROL_METHODS.MIRROR_READ,
  CONTROL_METHODS.OPEN_JOIN_CHALLENGE
]);

const WRITE_METHODS = new Set([
  CONTROL_METHODS.AUTH_CHALLENGE,
  CONTROL_METHODS.AUTH_SESSION,
  CONTROL_METHODS.MESH_STATE_APPEND,
  CONTROL_METHODS.MESH_LEASE_VOTE,
  CONTROL_METHODS.RELAY_AUTHORITY_UPSERT,
  CONTROL_METHODS.BRIDGE_BUNDLE_PUSH,
  CONTROL_METHODS.RELAY_REGISTER,
  CONTROL_METHODS.OPEN_JOIN_POOL_SYNC,
  CONTROL_METHODS.OPEN_JOIN_LEASE_CLAIM,
  CONTROL_METHODS.OPEN_JOIN_APPEND_CORES,
  CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC,
  CONTROL_METHODS.CLOSED_JOIN_LEASE_CLAIM
]);

function encodeRelayKey(relayKey) {
  if (!relayKey || typeof relayKey !== 'string') {
    throw new Error('relayKey is required for control method');
  }
  return encodeURIComponent(relayKey.trim());
}

function resolveHttpFallbackRequest(method, payload = {}) {
  switch (method) {
    case CONTROL_METHODS.MESH_CATALOG_READ:
      return { method: 'GET', path: '/api/v2/mesh/catalog', body: null };
    case CONTROL_METHODS.MESH_STATE_READ: {
      const params = [];
      if (Number.isFinite(Number(payload?.sinceSequence))) {
        params.push(`sinceSequence=${encodeURIComponent(Math.max(0, Math.trunc(Number(payload.sinceSequence))))}`);
      }
      if (Number.isFinite(Number(payload?.limit))) {
        params.push(`limit=${encodeURIComponent(Math.max(1, Math.trunc(Number(payload.limit))))}`);
      }
      const suffix = params.length ? `?${params.join('&')}` : '';
      return {
        method: 'GET',
        path: `/api/v2/mesh/state${suffix}`,
        body: null
      };
    }
    case CONTROL_METHODS.MESH_STATE_APPEND:
      return { method: 'POST', path: '/api/v2/mesh/state/append', body: payload };
    case CONTROL_METHODS.MESH_LEASE_VOTE:
      return { method: 'POST', path: '/api/v2/mesh/lease/vote', body: payload };
    case CONTROL_METHODS.AUTH_CHALLENGE:
      return { method: 'POST', path: '/api/v2/auth/challenge', body: payload };
    case CONTROL_METHODS.AUTH_SESSION:
      return { method: 'POST', path: '/api/v2/auth/session', body: payload };
    case CONTROL_METHODS.RELAY_AUTHORITY_READ:
      return {
        method: 'GET',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/authority`,
        body: null
      };
    case CONTROL_METHODS.RELAY_AUTHORITY_UPSERT:
      return {
        method: 'PUT',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/authority`,
        body: payload
      };
    case CONTROL_METHODS.BRIDGE_BUNDLE_READ:
      return {
        method: 'POST',
        path: `/api/v2/bridge/relays/${encodeRelayKey(payload.relayKey)}/bundle/read`,
        body: payload
      };
    case CONTROL_METHODS.BRIDGE_BUNDLE_PUSH:
      return {
        method: 'POST',
        path: `/api/v2/bridge/relays/${encodeRelayKey(payload.relayKey)}/bundle/push`,
        body: payload
      };
    case CONTROL_METHODS.RELAY_POLICY_READ:
      return {
        method: 'GET',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/policy`,
        body: null
      };
    case CONTROL_METHODS.RELAY_REGISTER:
      return { method: 'POST', path: '/api/v2/relays/register', body: payload };
    case CONTROL_METHODS.MIRROR_READ:
      return {
        method: 'GET',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/mirror`,
        body: null
      };
    case CONTROL_METHODS.OPEN_JOIN_CHALLENGE: {
      const purpose = typeof payload?.purpose === 'string' ? payload.purpose.trim() : null;
      const suffix = purpose ? `?purpose=${encodeURIComponent(purpose)}` : '';
      return {
        method: 'GET',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/open-join/challenge${suffix}`,
        body: null
      };
    }
    case CONTROL_METHODS.OPEN_JOIN_POOL_SYNC:
      return {
        method: 'POST',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/open-join/pool`,
        body: payload
      };
    case CONTROL_METHODS.OPEN_JOIN_LEASE_CLAIM:
      return {
        method: 'POST',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/open-join/lease`,
        body: payload
      };
    case CONTROL_METHODS.OPEN_JOIN_APPEND_CORES:
      return {
        method: 'POST',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/open-join/append-cores`,
        body: payload
      };
    case CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC:
      return {
        method: 'POST',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/closed-join/pool`,
        body: payload
      };
    case CONTROL_METHODS.CLOSED_JOIN_LEASE_CLAIM:
      return {
        method: 'POST',
        path: `/api/v2/relays/${encodeRelayKey(payload.relayKey)}/closed-join/lease`,
        body: payload
      };
    default:
      throw new Error(`Unsupported control method: ${method}`);
  }
}

export {
  CONTROL_METHODS,
  READ_METHODS,
  WRITE_METHODS,
  resolveHttpFallbackRequest
};
