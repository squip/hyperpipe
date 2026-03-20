import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

const root = document.querySelector('#allowlist-admin-root');
const configNode = document.querySelector('#access-manager-config');

if (!root) {
  throw new Error('Access manager root element is missing.');
}

if (!configNode) {
  throw new Error('Access manager config is missing.');
}

const config = parseConfig(configNode.textContent || '{}');
const TAB_LABELS = {
  allowlist: 'Allow List',
  wot: 'Web of Trust',
  blocklist: 'Block List'
};
const PROFILE_TIMEOUT_MS = 4500;
const INITIAL_ACTIVE_TAB = firstEnabledTabForConfig(config);

const state = {
  token: null,
  tokenExpiresAt: null,
  authBusy: false,
  signerState: detectSignerState(),
  operatorInput: normalizePubkey(config.operatorPubkey) || '',
  privateKeyInput: '',
  authPanelOpen: true,
  activeTab: INITIAL_ACTIVE_TAB,
  banner: null,
  allowlist: createListState(config.allowlistEnabled),
  blocklist: createListState(config.blocklistEnabled),
  wot: {
    enabled: !!config.wotEnabled,
    loading: false,
    loaded: false,
    entries: [],
    meta: {
      rootPubkey: null,
      maxDepth: null,
      minFollowersDepth2: null,
      loadedAt: null,
      expiresAt: null,
      relayUrls: [],
      lastError: null
    }
  },
  profileCache: new Map()
};

renderShell();
bindEvents();
render();

function parseConfig(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return {
      operatorPubkey: normalizePubkey(parsed.operatorPubkey) || '',
      relay: typeof parsed.relay === 'string' ? parsed.relay.trim() : '',
      purpose: typeof parsed.purpose === 'string' && parsed.purpose.trim()
        ? parsed.purpose.trim()
        : 'gateway:allowlist-admin',
      hostPolicy: typeof parsed.hostPolicy === 'string' ? parsed.hostPolicy.trim().toLowerCase() : 'open',
      allowlistEnabled: parsed.allowlistEnabled === true,
      blocklistEnabled: parsed.blocklistEnabled === true,
      wotEnabled: parsed.wotEnabled === true,
      discoveryRelayUrls: Array.from(new Set(
        (Array.isArray(parsed.discoveryRelayUrls) ? parsed.discoveryRelayUrls : [])
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      ))
    };
  } catch (error) {
    throw new Error(`Invalid access manager config: ${error?.message || error}`);
  }
}

function createListState(enabled) {
  return {
    enabled: !!enabled,
    loading: false,
    saving: false,
    inputValue: '',
    draftPubkeys: [],
    serverPubkeys: [],
    meta: {
      source: null,
      updatedAt: null,
      updatedBy: null,
      lastError: null
    }
  };
}

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

function normalizeImageUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.startsWith('data:')) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeProfilePayload(value = {}) {
  const displayName = [
    value.display_name,
    value.displayName,
    value.name,
    value.nip05
  ].find((entry) => typeof entry === 'string' && entry.trim());
  const subtitle = [
    value.nip05,
    value.name && displayName !== value.name ? value.name : null,
    value.about
  ].find((entry) => typeof entry === 'string' && entry.trim());
  return {
    displayName: displayName ? displayName.trim() : null,
    subtitle: subtitle ? subtitle.trim() : null,
    picture: normalizeImageUrl(value.picture || value.image || value.avatar || ''),
    about: typeof value.about === 'string' && value.about.trim() ? value.about.trim() : null
  };
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

function shortPubkey(pubkey) {
  return typeof pubkey === 'string' && pubkey.length >= 16
    ? `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`
    : pubkey;
}

function countLabel(count, noun = 'pubkey') {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
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

function firstEnabledTabForConfig(currentConfig) {
  if (currentConfig.allowlistEnabled) return 'allowlist';
  if (currentConfig.wotEnabled) return 'wot';
  if (currentConfig.blocklistEnabled) return 'blocklist';
  return 'allowlist';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function firstEnabledTab() {
  const tabs = getEnabledTabs();
  return tabs[0]?.key || 'allowlist';
}

function getEnabledTabs() {
  const tabs = [];
  if (state.allowlist.enabled) tabs.push({ key: 'allowlist', label: TAB_LABELS.allowlist });
  if (state.wot.enabled) tabs.push({ key: 'wot', label: TAB_LABELS.wot });
  if (state.blocklist.enabled) tabs.push({ key: 'blocklist', label: TAB_LABELS.blocklist });
  return tabs;
}

function setBanner(message, tone = 'info') {
  if (!message) {
    state.banner = null;
    renderBanner();
    return;
  }
  state.banner = { message, tone };
  renderBanner();
}

function getProfile(pubkey) {
  return state.profileCache.get(pubkey) || null;
}

function setProfile(pubkey, value) {
  state.profileCache.set(pubkey, value);
}

function listStateFor(kind) {
  if (kind === 'allowlist') return state.allowlist;
  if (kind === 'blocklist') return state.blocklist;
  return null;
}

function isDirty(kind) {
  const current = listStateFor(kind);
  if (!current) return false;
  return JSON.stringify(current.draftPubkeys) !== JSON.stringify(current.serverPubkeys);
}

function renderShell() {
  root.innerHTML = `
    <div class="access-shell">
      <header class="access-hero">
        <div class="access-hero__copy">
          <p class="eyebrow">Public Gateway</p>
          <h1>Access Manager</h1>
          <p class="muted">Manage your Allow List, Web of Trust, and Block List without restarting the gateway container.</p>
        </div>
        <div class="access-hero__actions">
          <button class="button-ghost" type="button" data-action="toggle-auth-panel">Authenticate</button>
        </div>
      </header>
      <div id="status-banner" class="status-banner"></div>
      <section id="auth-panel"></section>
      <section id="tabs-region"></section>
      <section id="content-region"></section>
    </div>
  `;
}

function bindEvents() {
  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  root.addEventListener('keydown', handleKeyDown);
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'toggle-auth-panel') {
    state.authPanelOpen = !state.authPanelOpen;
    renderAuthPanel();
    renderHeader();
    return;
  }
  if (action === 'sign-out') {
    state.token = null;
    state.tokenExpiresAt = null;
    state.authPanelOpen = true;
    setBanner('Signed out of the access manager.', 'info');
    render();
    return;
  }
  if (action === 'authenticate-signer') {
    void authenticateWithSigner();
    return;
  }
  if (action === 'authenticate-private-key') {
    void authenticateWithPrivateKey();
    return;
  }
  if (action === 'clear-private-key') {
    state.privateKeyInput = '';
    renderAuthPanel();
    return;
  }
  if (action === 'switch-tab') {
    const tab = target.dataset.tab;
    if (tab && tab !== state.activeTab) {
      state.activeTab = tab;
      renderTabs();
      renderContent();
      void ensureProfilesLoaded(activeTabPubkeys());
    }
    return;
  }
  if (action === 'reload-list') {
    const kind = target.dataset.list;
    if (kind) {
      void loadList(kind);
    }
    return;
  }
  if (action === 'save-list') {
    const kind = target.dataset.list;
    if (kind) {
      void saveList(kind);
    }
    return;
  }
  if (action === 'add-pubkey') {
    const kind = target.dataset.list;
    if (kind) {
      addDraftPubkey(kind);
    }
    return;
  }
  if (action === 'remove-pubkey') {
    const kind = target.dataset.list;
    const pubkey = target.dataset.pubkey;
    if (kind && pubkey) {
      removeDraftPubkey(kind, pubkey);
    }
    return;
  }
  if (action === 'reload-wot') {
    void loadWot();
    return;
  }
  if (action === 'queue-block') {
    const pubkey = normalizePubkey(target.dataset.pubkey);
    if (pubkey) {
      queuePubkeyForBlocklist(pubkey);
    }
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

  if (target.id === 'operator-pubkey-input') {
    state.operatorInput = target.value.trim().toLowerCase();
    return;
  }
  if (target.id === 'private-key-input') {
    state.privateKeyInput = target.value.trim().toLowerCase();
    return;
  }
  const kind = target.dataset.listInput;
  if (kind === 'allowlist' || kind === 'blocklist') {
    const current = listStateFor(kind);
    if (current) current.inputValue = target.value.trim().toLowerCase();
  }
}

function handleKeyDown(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  const kind = target.dataset.listInput;
  if ((kind === 'allowlist' || kind === 'blocklist') && event.key === 'Enter') {
    event.preventDefault();
    addDraftPubkey(kind);
  }
}

function render() {
  renderHeader();
  renderBanner();
  renderAuthPanel();
  renderTabs();
  renderContent();
  if (state.token) {
    void ensureProfilesLoaded(activeTabPubkeys());
  }
}

function renderHeader() {
  const actions = root.querySelector('.access-hero__actions');
  if (!actions) return;
  const authenticated = !!state.token;
  actions.innerHTML = `
    <div class="hero-status">
      <span class="signer-status" data-state="${state.signerState}">
        ${state.signerState === 'ready' ? 'Browser signer detected' : 'Browser signer unavailable'}
      </span>
      ${authenticated ? `<span class="session-pill">Operator session active</span>` : ''}
    </div>
    <button class="button-ghost" type="button" data-action="toggle-auth-panel">
      ${authenticated ? 'Session' : 'Authenticate'}
    </button>
  `;
}

function renderBanner() {
  const banner = document.querySelector('#status-banner');
  if (!banner) return;
  if (!state.banner?.message) {
    banner.textContent = '';
    banner.removeAttribute('data-tone');
    banner.style.display = 'none';
    return;
  }
  banner.textContent = state.banner.message;
  banner.dataset.tone = state.banner.tone || 'info';
  banner.style.display = 'block';
}

function renderAuthPanel() {
  const panel = document.querySelector('#auth-panel');
  if (!panel) return;
  const authenticated = !!state.token;
  const hidden = authenticated && !state.authPanelOpen;
  panel.className = hidden ? 'panel-sheet hidden' : 'panel-sheet';
  if (hidden) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = `
    <section class="gateway-card session-card">
      <div class="gateway-card__header">
        <div>
          <p class="eyebrow">Access Manager Session</p>
          <h2>${authenticated ? 'Operator session' : 'Operator authentication'}</h2>
          <p class="muted">
            ${authenticated
              ? 'Your admin token stays in browser memory only and expires automatically.'
              : 'Use a browser signer when possible. The private-key fallback is available if a signer is not installed.'}
          </p>
        </div>
        ${authenticated ? '<button class="button-ghost" type="button" data-action="sign-out">Sign out</button>' : ''}
      </div>
      <div class="session-grid">
        <label>
          Operator pubkey
          <input id="operator-pubkey-input" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(state.operatorInput)}">
        </label>
        <div class="session-meta">
          <div class="meta-row"><span>Gateway policy</span><span>${escapeHtml(config.hostPolicy)}</span></div>
          <div class="meta-row"><span>Session expires</span><span>${authenticated ? escapeHtml(formatTimestamp(state.tokenExpiresAt)) : 'Not authenticated'}</span></div>
        </div>
      </div>
      <div class="button-row session-actions">
        <button class="button-primary" type="button" data-action="authenticate-signer" ${state.authBusy || state.signerState !== 'ready' ? 'disabled' : ''}>
          ${state.authBusy ? 'Authenticating…' : 'Authenticate with signer'}
        </button>
      </div>
      <details class="advanced-panel"${state.privateKeyInput ? ' open' : ''}>
        <summary>Advanced fallback: sign with the operator private key</summary>
        <div class="field-stack">
          <p class="muted">Preferred flow: use a browser signer. The private-key fallback is never persisted and is cleared after successful authentication.</p>
          <label>
            Operator private key
            <textarea id="private-key-input" rows="3" autocomplete="off" spellcheck="false" placeholder="64-char hex private key">${escapeHtml(state.privateKeyInput)}</textarea>
          </label>
          <div class="button-row">
            <button class="button-secondary" type="button" data-action="authenticate-private-key" ${state.authBusy ? 'disabled' : ''}>Authenticate with private key</button>
            <button class="button-ghost" type="button" data-action="clear-private-key">Clear</button>
          </div>
        </div>
      </details>
    </section>
  `;
}

function renderTabs() {
  const region = document.querySelector('#tabs-region');
  if (!region) return;
  if (!state.token) {
    region.innerHTML = '';
    return;
  }
  const tabs = getEnabledTabs();
  region.innerHTML = `
    <div class="tabs-shell">
      <div class="tab-strip" role="tablist" aria-label="Access manager lists">
        ${tabs.map((tab) => `
          <button
            class="tab-button${tab.key === state.activeTab ? ' is-active' : ''}"
            type="button"
            role="tab"
            aria-selected="${tab.key === state.activeTab ? 'true' : 'false'}"
            data-action="switch-tab"
            data-tab="${tab.key}"
          >${escapeHtml(tab.label)}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderContent() {
  const region = document.querySelector('#content-region');
  if (!region) return;
  if (!state.token) {
    region.innerHTML = `
      <section class="gateway-card placeholder-card">
        <div class="gateway-card__header">
          <h2>Authenticate to manage gateway access</h2>
          <p class="muted">Once authenticated as the configured operator, you can manage the live lists and inspect the current Web of Trust graph.</p>
        </div>
      </section>
    `;
    return;
  }

  if (state.activeTab === 'allowlist' && state.allowlist.enabled) {
    region.innerHTML = renderListPanel('allowlist', {
      title: TAB_LABELS.allowlist,
      description: 'Review the live Allow List and add or remove users manually.'
    });
    return;
  }

  if (state.activeTab === 'blocklist' && state.blocklist.enabled) {
    region.innerHTML = renderListPanel('blocklist', {
      title: TAB_LABELS.blocklist,
      description: 'Review the live Block List and deny access across all host policy modes.'
    });
    return;
  }

  if (state.activeTab === 'wot' && state.wot.enabled) {
    region.innerHTML = renderWotPanel();
    return;
  }

  region.innerHTML = `
    <section class="gateway-card placeholder-card">
      <div class="gateway-card__header">
        <h2>This tab is unavailable</h2>
        <p class="muted">The active gateway policy does not expose this list in the current deployment.</p>
      </div>
    </section>
  `;
}

function renderListPanel(kind, { title, description }) {
  const current = listStateFor(kind);
  const listRows = current.draftPubkeys.length
    ? current.draftPubkeys.map((pubkey) => renderPubkeyRow(pubkey, {
      actionLabel: 'Remove',
      action: 'remove-pubkey',
      actionKind: kind,
      badges: kind === 'blocklist' ? [{ label: 'Denied', tone: 'danger' }] : []
    })).join('')
    : '<div class="empty-state">This list is empty.</div>';

  return `
    <section class="gateway-card list-card">
      <div class="gateway-card__header card-header--split">
        <div>
          <p class="eyebrow">${escapeHtml(title)}</p>
          <h2>${escapeHtml(title)}</h2>
          <p class="muted">${escapeHtml(description)}</p>
        </div>
        <div class="count-pill">${countLabel(current.draftPubkeys.length)}</div>
      </div>
      <div class="gateway-card__body">
        <div class="meta-grid">
          <div class="meta-row"><span>Source</span><span>${escapeHtml(current.meta.source || 'Unknown')}</span></div>
          <div class="meta-row"><span>Updated at</span><span>${escapeHtml(formatTimestamp(current.meta.updatedAt))}</span></div>
          <div class="meta-row"><span>Updated by</span><span>${escapeHtml(shortPubkey(current.meta.updatedBy || 'Unknown'))}</span></div>
        </div>
        ${current.meta.lastError ? `<div class="inline-note inline-note--warning">${escapeHtml(current.meta.lastError)}</div>` : ''}
        <div class="list-toolbar">
          <label>
            Add pubkey
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              data-list-input="${kind}"
              placeholder="64-char hex pubkey"
              value="${escapeHtml(current.inputValue)}"
            >
          </label>
          <div class="button-row">
            <button class="button-secondary" type="button" data-action="add-pubkey" data-list="${kind}" ${current.loading || current.saving ? 'disabled' : ''}>Add pubkey</button>
            <button class="button-primary" type="button" data-action="save-list" data-list="${kind}" ${current.loading || current.saving || !isDirty(kind) ? 'disabled' : ''}>${current.saving ? `Saving ${TAB_LABELS[kind]}…` : `Save ${TAB_LABELS[kind]}`}</button>
            <button class="button-ghost" type="button" data-action="reload-list" data-list="${kind}" ${current.loading || current.saving ? 'disabled' : ''}>Reload</button>
          </div>
        </div>
        <div class="entry-list">${listRows}</div>
      </div>
    </section>
  `;
}

function renderWotPanel() {
  const entries = state.wot.entries;
  const approvedCount = entries.filter((entry) => entry.approved).length;
  const body = entries.length
    ? entries.map((entry) => renderWotRow(entry)).join('')
    : '<div class="empty-state">No Web of Trust entries are currently loaded.</div>';
  return `
    <section class="gateway-card list-card">
      <div class="gateway-card__header card-header--split">
        <div>
          <p class="eyebrow">${escapeHtml(TAB_LABELS.wot)}</p>
          <h2>${escapeHtml(TAB_LABELS.wot)}</h2>
          <p class="muted">Read-only snapshot ranked by proximity. Use the Block action to queue a pubkey for the Block List draft.</p>
        </div>
        <div class="count-stack">
          <div class="count-pill">${countLabel(entries.length)}</div>
          <div class="count-pill count-pill--secondary">${approvedCount} approved</div>
        </div>
      </div>
      <div class="gateway-card__body">
        <div class="meta-grid">
          <div class="meta-row"><span>Root</span><span>${escapeHtml(shortPubkey(state.wot.meta.rootPubkey || 'Unknown'))}</span></div>
          <div class="meta-row"><span>Max depth</span><span>${escapeHtml(state.wot.meta.maxDepth ?? 'Unknown')}</span></div>
          <div class="meta-row"><span>Depth-2 follower threshold</span><span>${escapeHtml(state.wot.meta.minFollowersDepth2 ?? 'Unknown')}</span></div>
          <div class="meta-row"><span>Loaded at</span><span>${escapeHtml(formatTimestamp(state.wot.meta.loadedAt))}</span></div>
        </div>
        ${state.wot.meta.lastError ? `<div class="inline-note inline-note--warning">${escapeHtml(state.wot.meta.lastError)}</div>` : ''}
        <div class="button-row">
          <button class="button-ghost" type="button" data-action="reload-wot" ${state.wot.loading ? 'disabled' : ''}>${state.wot.loading ? 'Refreshing…' : 'Refresh Web of Trust'}</button>
        </div>
        <div class="entry-list">${body}</div>
      </div>
    </section>
  `;
}

function renderPubkeyRow(pubkey, {
  actionLabel,
  action,
  actionKind,
  badges = []
} = {}) {
  const profile = getProfile(pubkey);
  const identity = renderIdentity(pubkey, profile, badges);
  return `
    <article class="entry-row">
      ${identity}
      <div class="entry-actions">
        <button class="button-danger" type="button" data-action="${action}" data-list="${actionKind}" data-pubkey="${pubkey}">${escapeHtml(actionLabel)}</button>
      </div>
    </article>
  `;
}

function renderWotRow(entry) {
  const draftBlocked = state.blocklist.draftPubkeys.includes(entry.pubkey);
  const savedBlocked = state.blocklist.serverPubkeys.includes(entry.pubkey);
  const canBlock = state.blocklist.enabled && !draftBlocked && !savedBlocked;
  const badges = [
    { label: `Depth ${entry.depth ?? 'N/A'}` },
    { label: `${entry.followerCount} followers` },
    { label: entry.approved ? 'Approved' : 'Outside threshold', tone: entry.approved ? 'success' : 'warning' }
  ];
  if (entry.isOperator) badges.push({ label: 'Operator', tone: 'success' });
  if (entry.isRoot) badges.push({ label: 'Root', tone: 'success' });
  if (savedBlocked || draftBlocked) badges.push({ label: 'On Block List', tone: 'danger' });
  return `
    <article class="entry-row">
      ${renderIdentity(entry.pubkey, getProfile(entry.pubkey), badges)}
      <div class="entry-actions">
        <button
          class="${canBlock ? 'button-danger' : 'button-ghost'}"
          type="button"
          data-action="queue-block"
          data-pubkey="${entry.pubkey}"
          ${canBlock ? '' : 'disabled'}
        >${savedBlocked || draftBlocked ? 'On Block List' : (state.blocklist.enabled ? 'Block' : 'Block List disabled')}</button>
      </div>
    </article>
  `;
}

function renderIdentity(pubkey, profileState, badges = []) {
  const profile = profileState?.status === 'ready' ? profileState.profile : null;
  const displayName = profile?.displayName || shortPubkey(pubkey);
  const subtitle = profile?.subtitle || pubkey;
  const avatar = profile?.picture
    ? `<img class="identity-avatar__image" src="${escapeHtml(profile.picture)}" alt="">`
    : `<span class="identity-avatar__fallback">${escapeHtml((displayName || '?').slice(0, 1).toUpperCase())}</span>`;
  return `
    <div class="identity">
      <div class="identity-avatar">${avatar}</div>
      <div class="identity-copy">
        <div class="identity-title">${escapeHtml(displayName)}</div>
        <div class="identity-subtitle">
          <code>${escapeHtml(shortPubkey(pubkey))}</code>
          ${subtitle && subtitle !== pubkey ? `<span>${escapeHtml(subtitle)}</span>` : ''}
        </div>
        ${badges.length ? `
          <div class="badge-row">
            ${badges.map((badge) => `<span class="badge${badge.tone ? ` badge--${badge.tone}` : ''}">${escapeHtml(badge.label)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
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
  } catch {
    payload = { raw: text };
  }
  if (response.status === 401 && state.token) {
    state.token = null;
    state.tokenExpiresAt = null;
    state.authPanelOpen = true;
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
      ['relay', config.relay],
      ['purpose', config.purpose]
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
  const requestedPubkey = normalizePubkey(state.operatorInput);
  if (!requestedPubkey || requestedPubkey !== config.operatorPubkey) {
    setBanner('The operator pubkey must match the configured gateway operator.', 'error');
    return;
  }
  state.authBusy = true;
  renderAuthPanel();
  try {
    const challenge = await requestAdminChallenge(requestedPubkey);
    const unsignedEvent = buildUnsignedAuthEvent(requestedPubkey, challenge.challenge);
    const signedEvent = await signEventWithSigner(unsignedEvent, requestedPubkey);
    const verification = await verifyAdminEvent(signedEvent);
    state.token = verification.token;
    state.tokenExpiresAt = verification.expiresAt || null;
    state.authPanelOpen = false;
    setBanner('Authenticated as the operator. Loading access lists…', 'success');
    await loadAllAccessData();
  } catch (error) {
    setBanner(error?.message || 'Failed to authenticate with browser signer.', 'error');
  } finally {
    state.authBusy = false;
    render();
  }
}

async function authenticateWithPrivateKey() {
  const requestedPubkey = normalizePubkey(state.operatorInput);
  if (!requestedPubkey || requestedPubkey !== config.operatorPubkey) {
    setBanner('The operator pubkey must match the configured gateway operator.', 'error');
    return;
  }
  state.authBusy = true;
  renderAuthPanel();
  try {
    const challenge = await requestAdminChallenge(requestedPubkey);
    const unsignedEvent = buildUnsignedAuthEvent(requestedPubkey, challenge.challenge);
    const signedEvent = await signEventWithPrivateKey(unsignedEvent, state.privateKeyInput, requestedPubkey);
    const verification = await verifyAdminEvent(signedEvent);
    state.token = verification.token;
    state.tokenExpiresAt = verification.expiresAt || null;
    state.privateKeyInput = '';
    state.authPanelOpen = false;
    setBanner('Authenticated with the local private-key fallback. Loading access lists…', 'success');
    await loadAllAccessData();
  } catch (error) {
    setBanner(error?.message || 'Failed to authenticate with the private-key fallback.', 'error');
  } finally {
    state.authBusy = false;
    render();
  }
}

async function loadAllAccessData() {
  const tasks = [];
  if (state.allowlist.enabled) tasks.push(loadList('allowlist'));
  if (state.blocklist.enabled) tasks.push(loadList('blocklist'));
  if (state.wot.enabled) tasks.push(loadWot());
  await Promise.all(tasks);
}

async function loadList(kind) {
  const current = listStateFor(kind);
  if (!state.token || !current?.enabled) return;
  current.loading = true;
  renderContent();
  try {
    const response = await apiFetch(`/api/admin/${kind}`, { method: 'GET' });
    current.serverPubkeys = uniqueSortedPubkeys(response.pubkeys);
    current.draftPubkeys = [...current.serverPubkeys];
    current.meta = {
      source: response.source || null,
      updatedAt: response.updatedAt || null,
      updatedBy: response.updatedBy || null,
      lastError: response.lastError || null
    };
    if (response.lastError) {
      setBanner(`${TAB_LABELS[kind]} loaded with a warning: ${response.lastError}`, 'info');
    }
    void ensureProfilesLoaded(current.draftPubkeys);
  } catch (error) {
    if (error.status !== 401) {
      setBanner(error?.message || `Failed to load ${TAB_LABELS[kind]}.`, 'error');
    }
  } finally {
    current.loading = false;
    renderContent();
  }
}

async function saveList(kind) {
  const current = listStateFor(kind);
  if (!state.token || !current?.enabled) return;
  current.saving = true;
  renderContent();
  try {
    const response = await apiFetch(`/api/admin/${kind}`, {
      method: 'PUT',
      body: JSON.stringify({ pubkeys: current.draftPubkeys })
    });
    current.serverPubkeys = uniqueSortedPubkeys(response.pubkeys);
    current.draftPubkeys = [...current.serverPubkeys];
    current.meta = {
      source: response.source || null,
      updatedAt: response.updatedAt || null,
      updatedBy: response.updatedBy || null,
      lastError: response.lastError || null
    };
    setBanner(`${TAB_LABELS[kind]} saved. New gateway auth decisions will use this list immediately.`, 'success');
    void ensureProfilesLoaded(current.draftPubkeys);
  } catch (error) {
    if (error.status !== 401) {
      setBanner(error?.message || `Failed to save ${TAB_LABELS[kind]}.`, 'error');
    }
  } finally {
    current.saving = false;
    renderContent();
  }
}

async function loadWot() {
  if (!state.token || !state.wot.enabled) return;
  state.wot.loading = true;
  renderContent();
  try {
    const response = await apiFetch('/api/admin/wot', { method: 'GET' });
    state.wot.entries = Array.isArray(response.pubkeys) ? response.pubkeys : [];
    state.wot.meta = {
      rootPubkey: normalizePubkey(response.rootPubkey) || null,
      maxDepth: Number.isFinite(Number(response.maxDepth)) ? Number(response.maxDepth) : null,
      minFollowersDepth2: Number.isFinite(Number(response.minFollowersDepth2)) ? Number(response.minFollowersDepth2) : null,
      loadedAt: Number.isFinite(Number(response.loadedAt)) ? Number(response.loadedAt) : null,
      expiresAt: Number.isFinite(Number(response.expiresAt)) ? Number(response.expiresAt) : null,
      relayUrls: Array.isArray(response.relayUrls) ? response.relayUrls : [],
      lastError: response.lastError || null
    };
    state.wot.loaded = true;
    void ensureProfilesLoaded(state.wot.entries.map((entry) => entry.pubkey));
  } catch (error) {
    if (error.status !== 401) {
      setBanner(error?.message || 'Failed to load the Web of Trust snapshot.', 'error');
    }
  } finally {
    state.wot.loading = false;
    renderContent();
  }
}

function addDraftPubkey(kind) {
  const current = listStateFor(kind);
  if (!current) return;
  const normalized = normalizePubkey(current.inputValue);
  if (!normalized) {
    setBanner('Pubkeys must be 64-char lowercase hex strings.', 'error');
    return;
  }
  current.draftPubkeys = uniqueSortedPubkeys([...current.draftPubkeys, normalized]);
  current.inputValue = '';
  setBanner(null);
  renderContent();
  void ensureProfilesLoaded(current.draftPubkeys);
}

function removeDraftPubkey(kind, pubkey) {
  const current = listStateFor(kind);
  if (!current) return;
  current.draftPubkeys = current.draftPubkeys.filter((entry) => entry !== pubkey);
  renderContent();
}

function queuePubkeyForBlocklist(pubkey) {
  if (!state.blocklist.enabled) {
    setBanner('Block List management is not enabled for this deployment.', 'error');
    return;
  }
  state.blocklist.draftPubkeys = uniqueSortedPubkeys([...state.blocklist.draftPubkeys, pubkey]);
  if (!state.blocklist.serverPubkeys.includes(pubkey)) {
    setBanner('Added to the Block List draft. Save the Block List to apply the change.', 'success');
  }
  renderContent();
}

function activeTabPubkeys() {
  if (state.activeTab === 'allowlist') return state.allowlist.draftPubkeys;
  if (state.activeTab === 'blocklist') return state.blocklist.draftPubkeys;
  if (state.activeTab === 'wot') return state.wot.entries.map((entry) => entry.pubkey);
  return [];
}

function createSubId(prefix = 'kind0') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function selectPreferredEvent(existing, next) {
  if (!existing) return next;
  const existingCreatedAt = Number(existing.created_at) || 0;
  const nextCreatedAt = Number(next.created_at) || 0;
  if (nextCreatedAt > existingCreatedAt) return next;
  if (nextCreatedAt < existingCreatedAt) return existing;
  return String(next.id || '').localeCompare(String(existing.id || '')) > 0 ? next : existing;
}

async function fetchRelayProfiles(relayUrl, authors, timeoutMs = PROFILE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    const subId = createSubId('kind0');
    const events = [];
    let settled = false;
    let socket = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(['CLOSE', subId]));
        }
      } catch (_) {}
      try {
        socket?.close?.();
      } catch (_) {}
      resolvePromise({ relayUrl, events });
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      socket = new WebSocket(relayUrl);
    } catch (_) {
      finish();
      return;
    }

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify([
          'REQ',
          subId,
          {
            kinds: [0],
            authors,
            limit: Math.max(authors.length * 2, authors.length)
          }
        ]));
      } catch (_) {
        finish();
      }
    });

    socket.addEventListener('message', (message) => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(message.data));
      } catch (_) {
        return;
      }
      if (!Array.isArray(parsed) || parsed.length < 2) return;
      const [type, incomingSubId, payload] = parsed;
      if (incomingSubId !== subId) return;
      if (type === 'EVENT' && payload && typeof payload === 'object') {
        const pubkey = normalizePubkey(payload.pubkey);
        if (pubkey && authors.includes(pubkey)) {
          events.push(payload);
        }
        return;
      }
      if (type === 'EOSE' || type === 'CLOSED') {
        finish();
      }
    });

    socket.addEventListener('error', finish);
    socket.addEventListener('close', finish);
  });
}

async function fetchLatestProfiles(relayUrls, authors) {
  const normalizedAuthors = uniqueSortedPubkeys(authors);
  if (!normalizedAuthors.length || !relayUrls.length) {
    return new Map();
  }
  const results = await Promise.all(
    relayUrls.map((relayUrl) => fetchRelayProfiles(relayUrl, normalizedAuthors))
  );
  const latest = new Map();
  for (const result of results) {
    for (const event of result.events) {
      const pubkey = normalizePubkey(event?.pubkey);
      if (!pubkey) continue;
      latest.set(pubkey, selectPreferredEvent(latest.get(pubkey), event));
    }
  }
  return latest;
}

async function ensureProfilesLoaded(pubkeys) {
  const targets = uniqueSortedPubkeys(pubkeys).filter((pubkey) => {
    const profile = getProfile(pubkey);
    return !profile || (profile.status !== 'loading' && profile.status !== 'ready' && profile.status !== 'missing');
  });
  if (!targets.length || !config.discoveryRelayUrls.length) return;

  for (const pubkey of targets) {
    setProfile(pubkey, { status: 'loading' });
  }
  renderContent();

  try {
    const latest = await fetchLatestProfiles(config.discoveryRelayUrls, targets);
    for (const pubkey of targets) {
      const event = latest.get(pubkey);
      if (!event) {
        setProfile(pubkey, { status: 'missing' });
        continue;
      }
      let content = {};
      try {
        content = event.content ? JSON.parse(event.content) : {};
      } catch {
        content = {};
      }
      setProfile(pubkey, {
        status: 'ready',
        profile: normalizeProfilePayload(content)
      });
    }
  } catch (_) {
    for (const pubkey of targets) {
      if (getProfile(pubkey)?.status === 'loading') {
        setProfile(pubkey, { status: 'error' });
      }
    }
  } finally {
    renderContent();
  }
}
