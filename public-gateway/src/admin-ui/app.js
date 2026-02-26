import {
  addAllow,
  addBan,
  createInvite,
  getAuthToken,
  initializeSession,
  loadAdminSnapshot,
  logout,
  removeAllow,
  removeBan,
  republishMetadata,
  runBlindPeerGc,
  searchProfiles,
  setAuthToken,
  setUnauthorizedHandler,
  updatePolicy
} from './api.js';
import { derivePubkeyFromNsecHex, loginOperator } from './auth.js';
import { appState, resetAppData } from './state.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { renderUserAuthorization } from './views/user-authorization.js';
import { normalizeHex64, shortPubkey } from './utils.js';

const ROUTE_TITLES = {
  dashboard: 'Gateway Dashboard',
  settings: 'Settings',
  'user-authorization': 'User Authorization'
};

const els = {
  loginPanel: document.getElementById('login-panel'),
  appShell: document.getElementById('app-shell'),
  loginNsec: document.getElementById('login-nsec'),
  loginDerivedPubkey: document.getElementById('login-derived-pubkey'),
  loginStatus: document.getElementById('login-status'),
  btnLogin: document.getElementById('btn-login'),
  btnRefreshAll: document.getElementById('btn-refresh-all'),
  btnLogout: document.getElementById('btn-logout'),
  btnNavToggle: document.getElementById('btn-nav-toggle'),
  sidebar: document.getElementById('sidebar'),
  topbarTitle: document.getElementById('topbar-title'),
  viewContainer: document.getElementById('view-container'),
  toast: document.getElementById('toast')
};

function toast(message, isError = false) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  els.toast.classList.toggle('is-error', isError);
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    els.toast.classList.add('hidden');
    els.toast.classList.remove('is-error');
  }, 3000);
}

function setBusy(isBusy) {
  appState.busy = isBusy === true;
  const disabled = appState.busy;
  [els.btnLogin, els.btnRefreshAll, els.btnLogout].forEach((button) => {
    if (button) button.disabled = disabled;
  });
}

async function withBusy(work) {
  if (appState.busy) return;
  setBusy(true);
  try {
    await work();
  } catch (error) {
    toast(error?.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function setLoggedIn(loggedIn) {
  if (loggedIn) {
    els.loginPanel.classList.add('hidden');
    els.appShell.classList.remove('hidden');
  } else {
    els.loginPanel.classList.remove('hidden');
    els.appShell.classList.add('hidden');
  }
}

function updateRouteUi() {
  const route = appState.route;
  const title = ROUTE_TITLES[route] || 'Gateway Admin';
  if (els.topbarTitle) {
    els.topbarTitle.textContent = title;
  }

  const navButtons = document.querySelectorAll('[data-route]');
  navButtons.forEach((button) => {
    const active = button.getAttribute('data-route') === route;
    button.classList.toggle('is-active', active);
  });
}

async function refreshAll() {
  const snapshot = await loadAdminSnapshot();
  appState.data.overview = snapshot.overview;
  appState.data.policy = snapshot.policy;
  appState.data.allowList = snapshot.allowList;
  appState.data.banList = snapshot.banList;
  appState.data.invites = snapshot.invites;
  appState.data.activity = snapshot.activity;
  appState.data.profilesByPubkey = snapshot.profilesByPubkey;
  renderCurrentRoute();
}

function onUnauthorized() {
  setAuthToken(null);
  appState.token = null;
  resetAppData();
  setLoggedIn(false);
  els.loginStatus.textContent = 'Session expired. Please sign in again.';
}

setUnauthorizedHandler(onUnauthorized);

function closeSidebarOnMobile() {
  if (!els.sidebar) return;
  els.sidebar.classList.remove('is-open');
}

function renderCurrentRoute() {
  updateRouteUi();

  const runMutation = async (task, message) => {
    await withBusy(async () => {
      await task();
      if (message) toast(message);
      await refreshAll();
    });
  };

  if (appState.route === 'dashboard') {
    renderDashboard(els.viewContainer, {
      overview: appState.data.overview,
      activity: appState.data.activity,
      onRunGc: () => runMutation(
        async () => {
          await runBlindPeerGc('admin-ui-dashboard');
        },
        'Blind-peer garbage collection started'
      )
    });
    return;
  }

  if (appState.route === 'settings') {
    renderSettings(els.viewContainer, {
      policy: appState.data.policy,
      onSubmit: async (values) => runMutation(
        async () => {
          await updatePolicy(values);
          await republishMetadata('admin-ui-settings-submit');
        },
        'Settings submitted'
      )
    });
    return;
  }

  renderUserAuthorization(els.viewContainer, {
    activeTab: appState.userAuthorizationTab,
    allowList: appState.data.allowList,
    banList: appState.data.banList,
    invites: appState.data.invites,
    profilesByPubkey: appState.data.profilesByPubkey,
    onTabChange: (tabId) => {
      appState.userAuthorizationTab = tabId;
      renderCurrentRoute();
    },
    onSearchProfiles: async (query) => await searchProfiles(query),
    onAddAllow: async (pubkey) => runMutation(
      async () => {
        await addAllow(pubkey);
      },
      `Added ${shortPubkey(pubkey)} to allow-list`
    ),
    onRemoveAllow: async (pubkey) => runMutation(
      async () => {
        await removeAllow(pubkey);
      },
      `Removed ${shortPubkey(pubkey)} from allow-list`
    ),
    onAddBan: async (pubkey) => runMutation(
      async () => {
        await addBan(pubkey);
      },
      `Added ${shortPubkey(pubkey)} to ban-list`
    ),
    onRemoveBan: async (pubkey) => runMutation(
      async () => {
        await removeBan(pubkey);
      },
      `Removed ${shortPubkey(pubkey)} from ban-list`
    ),
    onCreateInvite: async (pubkey) => runMutation(
      async () => {
        await createInvite(pubkey);
      },
      `Invite sent to ${shortPubkey(pubkey)}`
    ),
    onSubmitChanges: async () => runMutation(
      async () => {
        await republishMetadata('admin-ui-user-authorization-submit');
      },
      'User authorization changes submitted'
    ),
    onError: (error) => {
      toast(error?.message || String(error), true);
    }
  });
}

function bindNavigation() {
  const navButtons = document.querySelectorAll('[data-route]');
  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const route = button.getAttribute('data-route');
      if (!route) return;
      appState.route = route;
      renderCurrentRoute();
      closeSidebarOnMobile();
    });
  });
}

function updateDerivedPubkeyPreview() {
  const nsecHex = els.loginNsec.value;
  const normalized = normalizeHex64(nsecHex);
  if (!normalized) {
    els.loginDerivedPubkey.textContent = '-';
    return;
  }
  try {
    const pubkey = derivePubkeyFromNsecHex(normalized);
    appState.auth.derivedPubkey = pubkey;
    els.loginDerivedPubkey.textContent = pubkey;
  } catch (_error) {
    els.loginDerivedPubkey.textContent = '-';
  }
}

function bindGlobalActions() {
  els.loginNsec.addEventListener('input', updateDerivedPubkeyPreview);
  els.loginNsec.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      withBusy(loginFlow);
    }
  });

  els.btnLogin.addEventListener('click', () => withBusy(loginFlow));
  els.btnRefreshAll.addEventListener('click', () => withBusy(refreshAll));
  els.btnLogout.addEventListener('click', () => withBusy(async () => {
    await logout();
    setAuthToken(null);
    appState.token = null;
    resetAppData();
    setLoggedIn(false);
    els.loginStatus.textContent = 'Logged out';
    toast('Logged out');
  }));

  if (els.btnNavToggle && els.sidebar) {
    els.btnNavToggle.addEventListener('click', () => {
      els.sidebar.classList.toggle('is-open');
    });
  }
}

async function loginFlow() {
  const nsecHex = normalizeHex64(els.loginNsec.value);
  if (!nsecHex) {
    throw new Error('invalid-nsec-hex');
  }

  const login = await loginOperator({
    nsecHex,
    setStatus: (message) => {
      els.loginStatus.textContent = message;
    }
  });

  setAuthToken(login.token);
  appState.token = login.token;
  appState.auth.derivedPubkey = login.pubkey;
  els.loginDerivedPubkey.textContent = login.pubkey;
  els.loginStatus.textContent = '';
  setLoggedIn(true);
  toast('Signed in');
  await refreshAll();
}

async function bootstrap() {
  bindNavigation();
  bindGlobalActions();
  setLoggedIn(false);
  updateDerivedPubkeyPreview();

  try {
    await initializeSession();
    appState.token = getAuthToken();
    setLoggedIn(true);
    await refreshAll();
  } catch (_error) {
    setAuthToken(null);
    appState.token = null;
    els.loginStatus.textContent = 'Session not active';
  }
}

bootstrap().catch((error) => {
  toast(error?.message || String(error), true);
});
