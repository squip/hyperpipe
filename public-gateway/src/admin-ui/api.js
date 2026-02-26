import { normalizeHex64, normalizeRelayUrl } from './utils.js';

const session = {
  token: null,
  onUnauthorized: null
};

export function setAuthToken(token) {
  session.token = typeof token === 'string' && token.length ? token : null;
}

export function getAuthToken() {
  return session.token;
}

export function setUnauthorizedHandler(handler) {
  session.onUnauthorized = typeof handler === 'function' ? handler : null;
}

async function refreshSession() {
  const headers = {
    'content-type': 'application/json'
  };
  if (session.token) {
    headers.authorization = `Bearer ${session.token}`;
  }
  const response = await fetch('/api/admin/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ adminSession: true })
  });
  if (!response.ok) {
    throw new Error('session-refresh-failed');
  }
  const payload = await response.json().catch(() => null);
  if (payload?.token) {
    session.token = payload.token;
  }
  return payload;
}

async function request(path, {
  method = 'GET',
  body = null,
  retry = true,
  headers = {}
} = {}) {
  const baseHeaders = {
    'content-type': 'application/json',
    ...headers
  };
  if (session.token) {
    baseHeaders.authorization = `Bearer ${session.token}`;
  }

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: baseHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 401 && retry) {
    try {
      await refreshSession();
      return await request(path, { method, body, retry: false, headers });
    } catch (_error) {
      if (typeof session.onUnauthorized === 'function') {
        session.onUnauthorized();
      }
      throw new Error('unauthorized');
    }
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload?.error || `http-${response.status}`);
  }

  return payload;
}

function uniquePubkeysFromSnapshot({ allow = [], ban = [], invites = [] } = {}) {
  const set = new Set();
  for (const pubkey of Array.isArray(allow) ? allow : []) {
    const normalized = normalizeHex64(pubkey);
    if (normalized) set.add(normalized);
  }
  for (const pubkey of Array.isArray(ban) ? ban : []) {
    const normalized = normalizeHex64(pubkey);
    if (normalized) set.add(normalized);
  }
  for (const invite of Array.isArray(invites) ? invites : []) {
    const normalized = normalizeHex64(invite?.pubkey);
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

export async function initializeSession() {
  await refreshSession();
  return session.token;
}

export async function searchProfiles(query, limit) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];
  const params = new URLSearchParams({ q: normalizedQuery });
  if (Number.isFinite(limit) && limit > 0) {
    const resolvedLimit = Math.min(Math.trunc(limit), 25);
    params.set('limit', String(resolvedLimit));
  }
  const payload = await request(`/api/admin/profiles/search?${params.toString()}`);
  return Array.isArray(payload?.profiles) ? payload.profiles : [];
}

export async function resolveProfiles(pubkeys = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(pubkeys) ? pubkeys : [])
        .map((entry) => normalizeHex64(entry))
        .filter((entry) => !!entry)
    )
  ).slice(0, 200);

  if (!normalized.length) {
    return {
      profiles: [],
      missing: []
    };
  }

  const params = new URLSearchParams({
    pubkeys: normalized.join(',')
  });
  const payload = await request(`/api/admin/profiles/resolve?${params.toString()}`);
  return {
    profiles: Array.isArray(payload?.profiles) ? payload.profiles : [],
    missing: Array.isArray(payload?.missing) ? payload.missing : []
  };
}

export async function loadAdminSnapshot() {
  const [overview, policyPayload, allowPayload, banPayload, invitesPayload, activityPayload] = await Promise.all([
    request('/api/admin/overview'),
    request('/api/gateway/policy'),
    request('/api/gateway/allow-list'),
    request('/api/gateway/ban-list'),
    request('/api/admin/invites'),
    request('/api/admin/activity?limit=50')
  ]);

  const policy = {
    policy: policyPayload?.policy || 'OPEN',
    inviteOnly: policyPayload?.inviteOnly === true,
    discoveryRelays: Array.from(
      new Set(
        (Array.isArray(policyPayload?.discoveryRelays) ? policyPayload.discoveryRelays : [])
          .map((entry) => normalizeRelayUrl(entry) || String(entry || '').trim())
          .filter(Boolean)
      )
    )
  };

  const allowList = Array.isArray(allowPayload?.allowList) ? allowPayload.allowList : [];
  const banList = Array.isArray(banPayload?.banList) ? banPayload.banList : [];
  const invites = Array.isArray(invitesPayload?.invites) ? invitesPayload.invites : [];
  const activity = Array.isArray(activityPayload?.activity) ? activityPayload.activity : [];

  const pubkeys = uniquePubkeysFromSnapshot({
    allow: allowList,
    ban: banList,
    invites
  });
  const resolvedProfiles = await resolveProfiles(pubkeys);

  const profilesByPubkey = {};
  for (const profile of resolvedProfiles.profiles || []) {
    const normalized = normalizeHex64(profile?.pubkey);
    if (!normalized) continue;
    profilesByPubkey[normalized] = profile;
  }

  return {
    overview,
    policy,
    allowList,
    banList,
    invites,
    activity,
    profilesByPubkey
  };
}

export async function updatePolicy({ policy, inviteOnly, discoveryRelays }) {
  const normalizedPolicy = String(policy || '').trim().toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const normalizedRelays = Array.from(
    new Set(
      (Array.isArray(discoveryRelays) ? discoveryRelays : [])
        .map((entry) => normalizeRelayUrl(entry) || String(entry || '').trim())
        .filter(Boolean)
    )
  );
  return await request('/api/gateway/policy', {
    method: 'POST',
    body: {
      policy: normalizedPolicy,
      inviteOnly: inviteOnly === true,
      discoveryRelays: normalizedRelays
    }
  });
}

export async function addAllow(pubkey) {
  const normalized = normalizeHex64(pubkey);
  if (!normalized) {
    throw new Error('invalid-pubkey');
  }
  return await request('/api/gateway/allow-list', {
    method: 'POST',
    body: { pubkey: normalized }
  });
}

export async function removeAllow(pubkey) {
  const normalized = normalizeHex64(pubkey);
  if (!normalized) {
    throw new Error('invalid-pubkey');
  }
  return await request(`/api/gateway/allow-list/${encodeURIComponent(normalized)}`, {
    method: 'DELETE'
  });
}

export async function addBan(pubkey) {
  const normalized = normalizeHex64(pubkey);
  if (!normalized) {
    throw new Error('invalid-pubkey');
  }
  return await request('/api/gateway/ban-list', {
    method: 'POST',
    body: { pubkey: normalized }
  });
}

export async function removeBan(pubkey) {
  const normalized = normalizeHex64(pubkey);
  if (!normalized) {
    throw new Error('invalid-pubkey');
  }
  return await request(`/api/gateway/ban-list/${encodeURIComponent(normalized)}`, {
    method: 'DELETE'
  });
}

export async function createInvite(pubkey) {
  const normalized = normalizeHex64(pubkey);
  if (!normalized) {
    throw new Error('invalid-pubkey');
  }
  return await request('/api/gateway/invites', {
    method: 'POST',
    body: {
      pubkey: normalized
    }
  });
}

export async function republishMetadata(reason = 'admin-ui-submit') {
  return await request('/api/admin/actions/republish-metadata', {
    method: 'POST',
    body: {
      reason
    }
  });
}

export async function runBlindPeerGc(reason = 'admin-ui-dashboard') {
  return await request('/api/admin/actions/blind-peer-gc', {
    method: 'POST',
    body: {
      reason
    }
  });
}

export async function logout() {
  try {
    await request('/api/admin/auth/logout', {
      method: 'POST',
      retry: false
    });
  } finally {
    session.token = null;
  }
}
