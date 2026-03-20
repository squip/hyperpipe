import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

const root = document.querySelector('#allowlist-admin-root');

if (!root) {
  throw new Error('Allowlist admin root element is missing.');
}

const OPERATOR_PUBKEY = normalizePubkey(root.dataset.operatorPubkey);
const RELAY = typeof root.dataset.relay === 'string' ? root.dataset.relay.trim() : '';
const PURPOSE = typeof root.dataset.purpose === 'string' ? root.dataset.purpose.trim() : 'gateway:allowlist-admin';

const state = {
  token: null,
  tokenExpiresAt: null,
  operatorPubkey: OPERATOR_PUBKEY,
  signerState: detectSignerState(),
  saving: false,
  loading: false,
  draftPubkeys: [],
  serverPubkeys: [],
  metadata: {
    source: null,
    updatedAt: null,
    updatedBy: null,
    lastError: null
  }
};

renderShell();
bindEvents();
render();

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function normalizePrivateKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function uniqueSortedPubkeys(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizePubkey(value))
      .filter(Boolean)
  )).sort();
}

function formatTimestamp(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return 'Never';
  try {
    return new Date(Number(timestamp)).toLocaleString();
  } catch (_) {
    return 'Unknown';
  }
}

function detectSignerState() {
  const signer = window.nostr;
  if (signer && typeof signer.signEvent === 'function') {
    return 'ready';
  }
  return 'missing';
}

function isDirty() {
  return JSON.stringify(state.draftPubkeys) !== JSON.stringify(state.serverPubkeys);
}

function renderShell() {
  root.innerHTML = `
    <div class="allowlist-shell">
      <section class="gateway-card">
        <header class="gateway-card__header">
          <p class="eyebrow">Public Gateway</p>
          <h1>Allowlist Pubkeys</h1>
          <p class="muted">Edit the live allowlist without restarting the gateway container.</p>
        </header>
        <div id="status-banner" class="status-banner"></div>
        <div class="gateway-card__body gateway-grid">
          <section class="gateway-panel">
            <div class="gateway-panel__header">
              <div>
                <h2>Operator Authentication</h2>
                <p class="muted">Authenticate as the configured operator using a browser signer or an advanced local private-key fallback.</p>
              </div>
              <div id="signer-status" class="signer-status" data-state="missing">Browser signer unavailable</div>
            </div>
            <div class="field-stack">
              <label>
                Operator pubkey
                <input id="operator-pubkey-input" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(state.operatorPubkey || '')}">
              </label>
              <div class="button-row">
                <button id="authenticate-button" class="button-primary" type="button">Authenticate with signer</button>
                <button id="reload-button" class="button-ghost hidden" type="button">Reload from server</button>
              </div>
            </div>
            <div class="advanced-panel">
              <details id="private-key-details">
                <summary>Advanced fallback: sign with the operator private key</summary>
                <div class="field-stack">
                  <p class="muted">Preferred flow: use a NIP-07 browser signer. Only use the private-key fallback when a signer is unavailable.</p>
                  <label>
                    Operator private key
                    <textarea id="private-key-input" rows="3" autocomplete="off" spellcheck="false" placeholder="64-char hex private key"></textarea>
                  </label>
                  <div class="button-row">
                    <button id="private-key-auth-button" class="button-secondary" type="button">Authenticate with private key</button>
                    <button id="private-key-clear-button" class="button-ghost" type="button">Clear</button>
                  </div>
                </div>
              </details>
            </div>
          </section>

          <section id="editor-panel" class="gateway-panel hidden">
            <div class="gateway-panel__header">
              <div>
                <h2>Live Allowlist</h2>
                <p class="muted">Changes apply to new gateway auth checks immediately after a successful save.</p>
              </div>
              <div id="allowlist-count" class="count-pill">0 pubkeys</div>
            </div>
            <div class="meta-grid">
              <div class="meta-row"><span>Source</span><span id="meta-source">Unknown</span></div>
              <div class="meta-row"><span>Updated at</span><span id="meta-updated-at">Never</span></div>
              <div class="meta-row"><span>Updated by</span><span id="meta-updated-by">Unknown</span></div>
            </div>
            <div class="list-stack section-gap">
              <div class="field-stack">
                <label>
                  Add pubkey
                  <input id="pubkey-input" type="text" autocomplete="off" spellcheck="false" placeholder="64-char hex pubkey">
                </label>
                <div class="button-row">
                  <button id="add-pubkey-button" class="button-secondary" type="button">Add pubkey</button>
                  <button id="save-button" class="button-primary" type="button">Save allowlist</button>
                </div>
              </div>
              <div id="pubkey-list" class="pubkey-list"></div>
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function bindEvents() {
  document.querySelector('#authenticate-button')?.addEventListener('click', authenticateWithSigner);
  document.querySelector('#private-key-auth-button')?.addEventListener('click', authenticateWithPrivateKey);
  document.querySelector('#private-key-clear-button')?.addEventListener('click', clearPrivateKeyFallback);
  document.querySelector('#reload-button')?.addEventListener('click', loadAllowlist);
  document.querySelector('#add-pubkey-button')?.addEventListener('click', addDraftPubkey);
  document.querySelector('#save-button')?.addEventListener('click', saveAllowlist);
  document.querySelector('#pubkey-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addDraftPubkey();
    }
  });
  document.querySelector('#pubkey-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-pubkey]');
    if (!button) return;
    removeDraftPubkey(button.getAttribute('data-remove-pubkey'));
  });
}

function render() {
  const banner = document.querySelector('#status-banner');
  const signerStatus = document.querySelector('#signer-status');
  const editorPanel = document.querySelector('#editor-panel');
  const reloadButton = document.querySelector('#reload-button');
  const saveButton = document.querySelector('#save-button');
  const addButton = document.querySelector('#add-pubkey-button');
  const authButton = document.querySelector('#authenticate-button');
  const privateKeyAuthButton = document.querySelector('#private-key-auth-button');
  const list = document.querySelector('#pubkey-list');
  const count = document.querySelector('#allowlist-count');
  const source = document.querySelector('#meta-source');
  const updatedAt = document.querySelector('#meta-updated-at');
  const updatedBy = document.querySelector('#meta-updated-by');

  const authenticated = !!state.token;
  const dirty = isDirty();

  if (signerStatus) {
    signerStatus.dataset.state = state.signerState;
    signerStatus.textContent = state.signerState === 'ready'
      ? 'Browser signer detected'
      : 'Browser signer unavailable';
  }

  if (editorPanel) {
    editorPanel.classList.toggle('hidden', !authenticated);
  }
  if (reloadButton) {
    reloadButton.classList.toggle('hidden', !authenticated);
    reloadButton.disabled = state.loading || state.saving;
  }
  if (authButton) {
    authButton.disabled = state.loading || state.saving || state.signerState !== 'ready';
  }
  if (privateKeyAuthButton) {
    privateKeyAuthButton.disabled = state.loading || state.saving;
  }
  if (saveButton) {
    saveButton.disabled = !authenticated || state.loading || state.saving || !dirty;
    saveButton.textContent = state.saving ? 'Saving…' : 'Save allowlist';
  }
  if (addButton) {
    addButton.disabled = !authenticated || state.loading || state.saving;
  }
  if (count) {
    count.textContent = `${state.draftPubkeys.length} ${state.draftPubkeys.length === 1 ? 'pubkey' : 'pubkeys'}`;
  }
  if (source) {
    source.textContent = state.metadata.source || 'Unknown';
  }
  if (updatedAt) {
    updatedAt.textContent = formatTimestamp(state.metadata.updatedAt);
  }
  if (updatedBy) {
    updatedBy.textContent = state.metadata.updatedBy || 'Unknown';
  }

  if (banner && !banner.dataset.tone) {
    banner.style.display = 'none';
  } else if (banner) {
    banner.style.display = 'block';
  }

  if (!list) return;
  if (!authenticated) {
    list.innerHTML = '';
    return;
  }
  if (state.draftPubkeys.length === 0) {
    list.innerHTML = '<div class="empty-state">The live allowlist is empty.</div>';
    return;
  }
  list.innerHTML = state.draftPubkeys.map((pubkey) => `
    <div class="pubkey-row">
      <code>${escapeHtml(pubkey)}</code>
      <button class="button-danger" type="button" data-remove-pubkey="${pubkey}">Remove</button>
    </div>
  `).join('');
}

function setBanner(message, tone = 'info') {
  const banner = document.querySelector('#status-banner');
  if (!banner) return;
  if (!message) {
    banner.textContent = '';
    banner.removeAttribute('data-tone');
    banner.style.display = 'none';
    return;
  }
  banner.textContent = message;
  banner.dataset.tone = tone;
  banner.style.display = 'block';
}

function clearPrivateKeyFallback() {
  const privateKeyInput = document.querySelector('#private-key-input');
  const details = document.querySelector('#private-key-details');
  if (privateKeyInput) {
    privateKeyInput.value = '';
  }
  if (details) {
    details.open = false;
  }
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('content-type', 'application/json');
  if (state.token) {
    headers.set('authorization', `Bearer ${state.token}`);
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { raw: text };
  }
  if (response.status === 401 && state.token) {
    state.token = null;
    state.tokenExpiresAt = null;
    setBanner('Admin session expired. Authenticate again to continue.', 'error');
    render();
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function requestAdminChallenge(pubkey) {
  return apiFetch('/api/admin/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ pubkey })
  });
}

function buildUnsignedAuthEvent(pubkey, challenge) {
  return {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    pubkey,
    tags: [
      ['challenge', challenge],
      ['relay', RELAY],
      ['purpose', PURPOSE]
    ],
    content: ''
  };
}

async function signEventWithSigner(event, expectedPubkey) {
  if (!window.nostr || typeof window.nostr.signEvent !== 'function') {
    throw new Error('Browser signer is unavailable.');
  }
  if (typeof window.nostr.getPublicKey === 'function') {
    const signerPubkey = normalizePubkey(await window.nostr.getPublicKey());
    if (signerPubkey && signerPubkey !== expectedPubkey) {
      throw new Error('The active browser signer does not match the configured operator pubkey.');
    }
  }
  const signed = await window.nostr.signEvent({ ...event });
  const pubkey = normalizePubkey(signed?.pubkey);
  if (!pubkey || pubkey !== expectedPubkey) {
    throw new Error('The signed event pubkey does not match the configured operator.');
  }
  return signed;
}

async function signEventWithPrivateKey(event, privateKey, expectedPubkey) {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  if (!normalizedPrivateKey) {
    throw new Error('Operator private key must be a 64-char hex string.');
  }
  const derivedPubkey = bytesToHex(secp256k1.getPublicKey(normalizedPrivateKey, true)).slice(2);
  if (derivedPubkey !== expectedPubkey) {
    throw new Error('The provided private key does not match the configured operator pubkey.');
  }
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  const signature = bytesToHex(await schnorr.sign(id, normalizedPrivateKey));
  return {
    ...event,
    id,
    sig: signature
  };
}

async function verifyAdminEvent(authEvent) {
  return apiFetch('/api/admin/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ authEvent })
  });
}

async function authenticateWithSigner() {
  const operatorInput = document.querySelector('#operator-pubkey-input');
  const requestedPubkey = normalizePubkey(operatorInput?.value);
  if (!requestedPubkey || requestedPubkey !== OPERATOR_PUBKEY) {
    setBanner('The operator pubkey must match the configured gateway operator.', 'error');
    return;
  }
  state.loading = true;
  render();
  try {
    const challenge = await requestAdminChallenge(requestedPubkey);
    const unsignedEvent = buildUnsignedAuthEvent(requestedPubkey, challenge.challenge);
    const signedEvent = await signEventWithSigner(unsignedEvent, requestedPubkey);
    const verification = await verifyAdminEvent(signedEvent);
    state.token = verification.token;
    state.tokenExpiresAt = verification.expiresAt || null;
    setBanner('Authenticated as operator. Live allowlist loaded from the gateway.', 'success');
    await loadAllowlist();
  } catch (error) {
    setBanner(error?.message || 'Failed to authenticate with browser signer.', 'error');
  } finally {
    state.loading = false;
    render();
  }
}

async function authenticateWithPrivateKey() {
  const operatorInput = document.querySelector('#operator-pubkey-input');
  const privateKeyInput = document.querySelector('#private-key-input');
  const requestedPubkey = normalizePubkey(operatorInput?.value);
  if (!requestedPubkey || requestedPubkey !== OPERATOR_PUBKEY) {
    setBanner('The operator pubkey must match the configured gateway operator.', 'error');
    return;
  }
  state.loading = true;
  render();
  try {
    const challenge = await requestAdminChallenge(requestedPubkey);
    const unsignedEvent = buildUnsignedAuthEvent(requestedPubkey, challenge.challenge);
    const signedEvent = await signEventWithPrivateKey(unsignedEvent, privateKeyInput?.value || '', requestedPubkey);
    const verification = await verifyAdminEvent(signedEvent);
    state.token = verification.token;
    state.tokenExpiresAt = verification.expiresAt || null;
    setBanner('Authenticated with the local private-key fallback.', 'success');
    await loadAllowlist();
  } catch (error) {
    setBanner(error?.message || 'Failed to authenticate with private key.', 'error');
  } finally {
    state.loading = false;
    clearPrivateKeyFallback();
    render();
  }
}

async function loadAllowlist() {
  if (!state.token) return;
  state.loading = true;
  render();
  try {
    const response = await apiFetch('/api/admin/allowlist', { method: 'GET' });
    state.serverPubkeys = uniqueSortedPubkeys(response.pubkeys);
    state.draftPubkeys = [...state.serverPubkeys];
    state.metadata = {
      source: response.source || null,
      updatedAt: response.updatedAt || null,
      updatedBy: response.updatedBy || null,
      lastError: response.lastError || null
    };
    if (response.lastError) {
      setBanner(`Allowlist loaded with a warning: ${response.lastError}`, 'info');
    }
  } catch (error) {
    if (error.status !== 401) {
      setBanner(error?.message || 'Failed to load the live allowlist.', 'error');
    }
  } finally {
    state.loading = false;
    render();
  }
}

function addDraftPubkey() {
  const input = document.querySelector('#pubkey-input');
  const normalized = normalizePubkey(input?.value);
  if (!normalized) {
    setBanner('Pubkeys must be 64-char lowercase hex strings.', 'error');
    return;
  }
  state.draftPubkeys = uniqueSortedPubkeys([...state.draftPubkeys, normalized]);
  if (input) {
    input.value = '';
    input.focus();
  }
  setBanner(null);
  render();
}

function removeDraftPubkey(pubkey) {
  state.draftPubkeys = state.draftPubkeys.filter((entry) => entry !== pubkey);
  render();
}

async function saveAllowlist() {
  if (!state.token) {
    setBanner('Authenticate as the operator before saving.', 'error');
    return;
  }
  state.saving = true;
  render();
  try {
    const response = await apiFetch('/api/admin/allowlist', {
      method: 'PUT',
      body: JSON.stringify({ pubkeys: state.draftPubkeys })
    });
    state.serverPubkeys = uniqueSortedPubkeys(response.pubkeys);
    state.draftPubkeys = [...state.serverPubkeys];
    state.metadata = {
      source: response.source || null,
      updatedAt: response.updatedAt || null,
      updatedBy: response.updatedBy || null,
      lastError: response.lastError || null
    };
    setBanner('Allowlist saved. New gateway auth decisions will use this list immediately.', 'success');
  } catch (error) {
    if (error.status !== 401) {
      setBanner(error?.message || 'Failed to save the live allowlist.', 'error');
    }
  } finally {
    state.saving = false;
    render();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
