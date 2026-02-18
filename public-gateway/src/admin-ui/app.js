import { schnorr } from '@noble/curves/secp256k1.js';

const state = {
  token: null,
  busy: false
};

const els = {
  loginPanel: document.getElementById('login-panel'),
  dashboard: document.getElementById('dashboard'),
  loginPubkey: document.getElementById('login-pubkey'),
  loginNsec: document.getElementById('login-nsec'),
  loginStatus: document.getElementById('login-status'),
  btnLogin: document.getElementById('btn-login'),
  btnRefreshAll: document.getElementById('btn-refresh-all'),
  btnLogout: document.getElementById('btn-logout'),
  overviewJson: document.getElementById('overview-json'),
  metricsJson: document.getElementById('metrics-json'),
  policyValue: document.getElementById('policy-value'),
  policyInviteOnly: document.getElementById('policy-invite-only'),
  policyRelays: document.getElementById('policy-relays'),
  btnPolicySave: document.getElementById('btn-policy-save'),
  allowInput: document.getElementById('allow-input'),
  btnAllowAdd: document.getElementById('btn-allow-add'),
  allowList: document.getElementById('allow-list'),
  banInput: document.getElementById('ban-input'),
  btnBanAdd: document.getElementById('btn-ban-add'),
  banList: document.getElementById('ban-list'),
  joinRequests: document.getElementById('join-requests'),
  inviteInput: document.getElementById('invite-input'),
  btnInviteCreate: document.getElementById('btn-invite-create'),
  invites: document.getElementById('invites'),
  btnRepublish: document.getElementById('btn-republish'),
  btnGc: document.getElementById('btn-gc'),
  activity: document.getElementById('activity'),
  toast: document.getElementById('toast')
};

function toast(message, isError = false) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  els.toast.style.background = isError ? '#6d1c1c' : '#13263f';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 3200);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function normalizeHex64(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null;
  return normalized;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

async function buildAuthEvent({ pubkey, nonce, scope, nsecHex }) {
  const createdAt = Math.floor(Date.now() / 1000);
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ];
  const payload = [0, pubkey, createdAt, 22242, tags, ''];
  const id = await sha256Hex(JSON.stringify(payload));
  const event = {
    id,
    kind: 22242,
    pubkey,
    created_at: createdAt,
    tags,
    content: ''
  };

  const maybeNostr = window?.nostr;
  if ((!nsecHex || !nsecHex.length) && maybeNostr?.signEvent) {
    const signed = await maybeNostr.signEvent(event);
    if (!signed?.sig) throw new Error('nostr-signature-failed');
    return signed;
  }

  const priv = hexToBytes(nsecHex);
  const msg = hexToBytes(id);
  if (!priv || !msg) {
    throw new Error('invalid-nsec-hex');
  }
  const sig = await schnorr.sign(msg, priv);
  return {
    ...event,
    sig: bytesToHex(sig)
  };
}

async function refreshSession() {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch('/api/admin/auth/refresh', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ adminSession: true })
  });
  if (!response.ok) {
    throw new Error('session-refresh-failed');
  }
  const payload = await response.json();
  if (payload?.token) state.token = payload.token;
}

async function api(path, { method = 'GET', body = null, retry = true } = {}) {
  const headers = {
    'content-type': 'application/json'
  };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 401 && retry) {
    try {
      await refreshSession();
      return api(path, { method, body, retry: false });
    } catch (_) {
      setLoggedIn(false);
      throw new Error('unauthorized');
    }
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload?.error || `http-${response.status}`);
  }

  return payload;
}

function setLoggedIn(loggedIn) {
  if (loggedIn) {
    els.loginPanel.classList.add('hidden');
    els.dashboard.classList.remove('hidden');
  } else {
    els.loginPanel.classList.remove('hidden');
    els.dashboard.classList.add('hidden');
  }
}

function renderList(container, items, renderItem) {
  container.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No entries.';
    li.className = 'muted';
    container.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.appendChild(renderItem(item));
    container.appendChild(li);
  }
}

function buildEntryRow(label, actions = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'line';
  const left = document.createElement('span');
  left.textContent = label;
  wrapper.appendChild(left);
  const right = document.createElement('div');
  right.className = 'row';
  right.style.margin = '0';
  for (const action of actions) {
    right.appendChild(action);
  }
  if (actions.length) {
    wrapper.appendChild(right);
  }
  return wrapper;
}

async function login() {
  const pubkey = normalizeHex64(els.loginPubkey.value);
  const nsecHex = normalizeHex64(els.loginNsec.value);
  if (!pubkey) {
    throw new Error('invalid-pubkey');
  }
  if (!nsecHex && !window?.nostr?.signEvent) {
    throw new Error('invalid-nsec-hex');
  }

  els.loginStatus.textContent = 'Requesting challenge...';
  const challenge = await fetch('/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pubkey,
      scope: 'gateway:operator'
    })
  }).then(async (response) => {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'challenge-failed');
    return payload;
  });

  els.loginStatus.textContent = 'Signing challenge...';
  const authEvent = await buildAuthEvent({
    pubkey,
    nonce: challenge.nonce,
    scope: 'gateway:operator',
    nsecHex
  });

  els.loginStatus.textContent = 'Verifying...';
  const verify = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      authEvent,
      adminSession: true
    })
  }).then(async (response) => {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'verify-failed');
    return payload;
  });

  if (!verify?.token) {
    throw new Error('token-missing');
  }
  state.token = verify.token;
  setLoggedIn(true);
  els.loginStatus.textContent = '';
  toast('Signed in');
  await refreshAll();
}

async function refreshAll() {
  const [overview, policy, allow, ban, joinRequests, invites, metrics, activity] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/gateway/policy'),
    api('/api/gateway/allow-list'),
    api('/api/gateway/ban-list'),
    api('/api/gateway/join-requests'),
    api('/api/admin/invites'),
    api('/api/admin/metrics/summary'),
    api('/api/admin/activity?limit=50')
  ]);

  els.overviewJson.textContent = JSON.stringify(overview, null, 2);
  els.metricsJson.textContent = JSON.stringify(metrics, null, 2);

  els.policyValue.value = policy?.policy || 'OPEN';
  els.policyInviteOnly.checked = policy?.inviteOnly === true;
  els.policyRelays.value = Array.isArray(policy?.discoveryRelays) ? policy.discoveryRelays.join(',') : '';

  renderList(els.allowList, allow?.allowList || [], (pubkey) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      await api(`/api/gateway/allow-list/${encodeURIComponent(pubkey)}`, { method: 'DELETE' });
      toast('Allow-list updated');
      await refreshAll();
    };
    return buildEntryRow(pubkey, [btn]);
  });

  renderList(els.banList, ban?.banList || [], (pubkey) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      await api(`/api/gateway/ban-list/${encodeURIComponent(pubkey)}`, { method: 'DELETE' });
      toast('Ban-list updated');
      await refreshAll();
    };
    return buildEntryRow(pubkey, [btn]);
  });

  renderList(els.joinRequests, joinRequests?.requests || [], (req) => {
    const actions = [];
    if (req?.status === 'pending') {
      const approve = document.createElement('button');
      approve.className = 'btn btn-primary';
      approve.textContent = 'Approve';
      approve.onclick = async () => {
        await api(`/api/gateway/join-requests/${encodeURIComponent(req.id)}/approve`, { method: 'POST' });
        toast('Join request approved');
        await refreshAll();
      };
      const reject = document.createElement('button');
      reject.className = 'btn btn-danger';
      reject.textContent = 'Reject';
      reject.onclick = async () => {
        await api(`/api/gateway/join-requests/${encodeURIComponent(req.id)}/reject`, { method: 'POST' });
        toast('Join request rejected');
        await refreshAll();
      };
      actions.push(approve, reject);
    }
    const label = `${req.pubkey} (${req.status})`;
    return buildEntryRow(label, actions);
  });

  renderList(els.invites, invites?.invites || [], (invite) => {
    const redeemed = invite?.redeemedAt ? 'redeemed' : 'pending';
    const tokenPrefix = String(invite?.inviteToken || '').slice(0, 12);
    return buildEntryRow(`${invite.pubkey} (${redeemed}) token:${tokenPrefix}`);
  });

  renderList(els.activity, activity?.activity || [], (entry) => {
    const ts = entry?.createdAt ? new Date(entry.createdAt).toLocaleString() : '-';
    return buildEntryRow(`${ts} - ${entry.type}`);
  });
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  try {
    await fn();
  } catch (error) {
    toast(error?.message || String(error), true);
  } finally {
    state.busy = false;
  }
}

function bind() {
  els.btnLogin.onclick = () => withBusy(login);
  els.btnRefreshAll.onclick = () => withBusy(refreshAll);
  els.btnLogout.onclick = () => withBusy(async () => {
    await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {});
    state.token = null;
    setLoggedIn(false);
    toast('Logged out');
  });

  els.btnPolicySave.onclick = () => withBusy(async () => {
    const discoveryRelays = els.policyRelays.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    await api('/api/gateway/policy', {
      method: 'POST',
      body: {
        policy: els.policyValue.value,
        inviteOnly: els.policyInviteOnly.checked,
        discoveryRelays
      }
    });
    toast('Policy updated');
    await refreshAll();
  });

  els.btnAllowAdd.onclick = () => withBusy(async () => {
    const pubkey = normalizeHex64(els.allowInput.value);
    if (!pubkey) throw new Error('invalid-pubkey');
    await api('/api/gateway/allow-list', {
      method: 'POST',
      body: { pubkey }
    });
    els.allowInput.value = '';
    toast('Added to allow-list');
    await refreshAll();
  });

  els.btnBanAdd.onclick = () => withBusy(async () => {
    const pubkey = normalizeHex64(els.banInput.value);
    if (!pubkey) throw new Error('invalid-pubkey');
    await api('/api/gateway/ban-list', {
      method: 'POST',
      body: { pubkey }
    });
    els.banInput.value = '';
    toast('Added to ban-list');
    await refreshAll();
  });

  els.btnInviteCreate.onclick = () => withBusy(async () => {
    const pubkey = normalizeHex64(els.inviteInput.value);
    if (!pubkey) throw new Error('invalid-pubkey');
    const created = await api('/api/gateway/invites', {
      method: 'POST',
      body: { pubkey }
    });
    els.inviteInput.value = '';
    const tokenPreview = String(created?.invite?.inviteToken || '').slice(0, 20);
    toast(`Invite created (${tokenPreview}...)`);
    await refreshAll();
  });

  els.btnRepublish.onclick = () => withBusy(async () => {
    await api('/api/admin/actions/republish-metadata', {
      method: 'POST',
      body: { reason: 'admin-ui' }
    });
    toast('Metadata republished');
    await refreshAll();
  });

  els.btnGc.onclick = () => withBusy(async () => {
    await api('/api/admin/actions/blind-peer-gc', {
      method: 'POST',
      body: { reason: 'admin-ui' }
    });
    toast('Blind-peer GC triggered');
    await refreshAll();
  });
}

async function bootstrap() {
  bind();
  setLoggedIn(false);
  try {
    await refreshSession();
    setLoggedIn(true);
    await refreshAll();
  } catch (_) {
    els.loginStatus.textContent = 'Session not active';
  }
}

bootstrap().catch((error) => {
  toast(error?.message || String(error), true);
});
