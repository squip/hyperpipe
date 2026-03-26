const { app, BrowserWindow, dialog, ipcMain, net, session } = require('electron');
const path = require('path');
const { promises: fs, existsSync } = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { PluginSupervisor } = require('./plugin-supervisor.cjs');
const {
  buildHtmlSourceViewerDocument,
  buildHtmlSourceViewerWindowOptions,
  buildHtmlViewerWindowOptions,
  createHtmlViewerPartition,
  isAllowedHtmlViewerUrl
} = require('./html-viewer.cjs');

const execFileAsync = promisify(execFile);
const APP_DISPLAY_NAME = 'Hyperpipe';

if (typeof app.setName === 'function') {
  app.setName(APP_DISPLAY_NAME);
}

let mainWindow = null;
let workerProcess = null;
let pendingWorkerMessages = [];
let pendingWorkerRequests = new Map();
let gatewayStatusCache = null;
let gatewayLogsCache = [];
let publicGatewayConfigCache = null;
let publicGatewayStatusCache = null;
let currentWorkerUserKey = null;
let pluginSupervisor = null;

function parseBooleanEnvFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return null;
}

function arePluginsEnabled() {
  const explicitFlag = parseBooleanEnvFlag(process.env.HYPERPIPE_FEATURE_PLUGINS_ENABLED);
  if (explicitFlag !== null) return explicitFlag;

  const viteFlag = parseBooleanEnvFlag(process.env.VITE_FEATURE_PLUGINS_ENABLED);
  if (viteFlag !== null) return viteFlag;

  return false;
}

function isHex64(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}

function normalizeWorkerConfigPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const base = payload.type === 'config' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : payload;
  const normalized = { ...base };

  // Allow camelCase keys from newer renderers, but keep snake_case as canonical for the worker.
  if (!normalized.nostr_pubkey_hex && normalized.nostrPubkeyHex) {
    normalized.nostr_pubkey_hex = normalized.nostrPubkeyHex;
  }
  if (!normalized.nostr_nsec_hex && normalized.nostrNsecHex) {
    normalized.nostr_nsec_hex = normalized.nostrNsecHex;
  }
  if (!normalized.userKey && normalized.user_key) {
    normalized.userKey = normalized.user_key;
  }

  return normalized;
}

function validateWorkerConfigPayload(payload) {
  if (!payload) return null;
  if (!isHex64(payload.nostr_pubkey_hex) || !isHex64(payload.nostr_nsec_hex)) {
    return 'Invalid worker config: expected nostr_pubkey_hex and nostr_nsec_hex (64-char hex)';
  }
  if (!payload.userKey || typeof payload.userKey !== 'string') {
    return 'Invalid worker config: userKey is required for per-account isolation';
  }
  return null;
}

function sendWorkerConfigToProcess(proc, payload) {
  if (!proc || typeof proc.send !== 'function') {
    return { success: false, error: 'Worker IPC channel unavailable' };
  }
  try {
    proc.send({ type: 'config', data: payload });
    // Safety resend (mirrors legacy renderer behavior) in case IPC ordering is delayed.
    setTimeout(() => {
      if (!workerProcess || workerProcess !== proc) return;
      try {
        proc.send({ type: 'config', data: payload });
      } catch (_) {}
    }, 1000);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to send config to worker', error);
    return { success: false, error: error.message };
  }
}

function generateWorkerRequestId() {
  return `worker-req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function emitRendererEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch (error) {
    console.warn(`[Main] Failed to emit renderer event on ${channel}:`, error?.message || error);
  }
}

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..');
const DESKTOP_USER_DATA_DIR = 'hyperpipe-desktop';
const userDataPath = path.join(app.getPath('appData'), DESKTOP_USER_DATA_DIR);
app.setPath('userData', userDataPath);
const storagePath = path.join(userDataPath, 'hyperpipe-data');
const logFilePath = path.join(storagePath, 'desktop-console.log');
const gatewaySettingsPath = path.join(storagePath, 'hyperpipe-hyperpipe-gateway-settings.json');
const publicGatewaySettingsPath = path.join(storagePath, 'hyperpipe-public-hyperpipe-gateway-settings.json');
const LOG_APPEND_EMFILE_RETRIES = 4;
const LOG_APPEND_EMFILE_BASE_DELAY_MS = 25;
let logAppendChain = Promise.resolve();
const DEFAULT_CERT_ALLOWLIST = new Set(['relay.nostr.band', 'relay.damus.io', 'nos.lol']);
const envAllowlist = (process.env.NOSTR_CERT_ALLOWLIST || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
for (const host of envAllowlist) {
  DEFAULT_CERT_ALLOWLIST.add(host);
}

function getSharedRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'shared');
  }
  return path.join(REPO_ROOT, 'shared');
}

function resolveExistingRoot(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function getWorkerRoot() {
  if (app.isPackaged) {
    return resolveExistingRoot([
      path.join(process.resourcesPath, 'hyperpipe-worker')
    ]);
  }
  return resolveExistingRoot([
    path.join(REPO_ROOT, 'hyperpipe-worker')
  ]);
}

function getRendererIndexPath() {
  return path.join(APP_ROOT, 'dist', 'index.html');
}

function getRuntimeIconPath() {
  const iconRoot = app.isPackaged ? path.join(APP_ROOT, 'dist') : path.join(APP_ROOT, 'public');
  return path.join(iconRoot, 'pwa-512x512.png');
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    const { hostname } = new URL(url);
    if (DEFAULT_CERT_ALLOWLIST.has(hostname) || Array.from(DEFAULT_CERT_ALLOWLIST).some((allowed) => allowed.startsWith('.') ? hostname.endsWith(allowed) : hostname === allowed)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch (err) {
    console.warn('[Main] Failed to evaluate certificate exception for URL', url, err);
  }

  callback(false);
});


async function ensureStorageDir() {
  try {
    await fs.mkdir(storagePath, { recursive: true });
  } catch (error) {
    console.error('[Main] Failed to create storage directory', error);
  }
}

async function ensurePluginSupervisor() {
  if (!arePluginsEnabled()) {
    throw new Error('Plugins are disabled');
  }
  if (pluginSupervisor) return pluginSupervisor;
  pluginSupervisor = new PluginSupervisor({
    storagePath,
    logger: console,
    sharedRoot: getSharedRoot()
  });
  pluginSupervisor.setRendererEmitter((channel, payload) => {
    emitRendererEvent(channel, payload);
  });
  await pluginSupervisor.init();
  return pluginSupervisor;
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getReferencePluginPaths() {
  const referenceRoot = path.join(getSharedRoot(), 'plugins', 'reference');
  return {
    referenceRoot,
    catalogPath: path.join(referenceRoot, 'catalog.json'),
    cliPath: path.join(getSharedRoot(), 'plugins', 'sdk', 'htplugin-cli.mjs')
  };
}

async function loadReferencePluginDefinitions() {
  const paths = getReferencePluginPaths();
  let catalog = [];
  try {
    const raw = await fs.readFile(paths.catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    catalog = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`Failed to read reference plugin catalog: ${error?.message || error}`);
  }

  const warnings = [];
  const plugins = [];
  for (const entry of catalog) {
    const item = asObject(entry);
    if (!item) continue;
    const pluginId = asString(item.id).toLowerCase();
    const slug = asString(item.slug);
    if (!pluginId || !slug) {
      warnings.push('Catalog entry missing id/slug');
      continue;
    }

    const pluginDir = path.join(paths.referenceRoot, slug);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    let manifest = null;
    try {
      const rawManifest = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      warnings.push(`Failed to load manifest for ${pluginId}: ${error?.message || error}`);
      continue;
    }
    const manifestObj = asObject(manifest) || {};
    const contributions = asObject(manifestObj.contributions) || {};
    plugins.push({
      id: pluginId,
      slug,
      name: asString(item.name) || asString(manifestObj.name) || pluginId,
      version: asString(manifestObj.version) || '0.0.0',
      summary: asString(item.summary) || 'First-party reference plugin.',
      majorCapability: asString(item.majorCapability) || 'Reference capability',
      permissions: toArray(manifestObj.permissions).map((value) => asString(value)).filter(Boolean),
      navItemCount: toArray(contributions.navItems).length,
      routeCount: toArray(contributions.routes).length,
      mediaFeatureCount: toArray(contributions.mediaFeatures).length,
      pluginDir
    });
  }

  return {
    plugins,
    warnings,
    referenceRoot: paths.referenceRoot,
    cliPath: paths.cliPath
  };
}

function toPublicReferencePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return null;
  return {
    id: asString(plugin.id).toLowerCase(),
    slug: asString(plugin.slug),
    name: asString(plugin.name),
    version: asString(plugin.version),
    summary: asString(plugin.summary),
    majorCapability: asString(plugin.majorCapability),
    permissions: Array.isArray(plugin.permissions)
      ? plugin.permissions.map((value) => asString(value)).filter(Boolean)
      : [],
    navItemCount: Number(plugin.navItemCount) || 0,
    routeCount: Number(plugin.routeCount) || 0,
    mediaFeatureCount: Number(plugin.mediaFeatureCount) || 0
  };
}

async function packageReferencePlugin(plugin) {
  const pluginId = asString(plugin?.id).toLowerCase();
  const pluginVersion = asString(plugin?.version) || '0.0.0';
  const pluginDir = asString(plugin?.pluginDir);
  const { cliPath } = getReferencePluginPaths();
  if (!pluginId || !pluginDir) {
    throw new Error('Reference plugin metadata is incomplete');
  }
  if (!existsSync(cliPath)) {
    throw new Error(`Reference plugin CLI not found: ${cliPath}`);
  }

  const outputRoot = path.join(storagePath, 'plugin-reference-cache');
  await fs.mkdir(outputRoot, { recursive: true });
  const archivePath = path.join(outputRoot, `${pluginId}-${pluginVersion}.htplugin.tgz`);

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, 'pack', pluginDir, '--output', archivePath, '--json'],
      {
        cwd: pluginDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1'
        },
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    stdout = String(result?.stdout || '');
    stderr = String(result?.stderr || '');
  } catch (error) {
    const out = String(error?.stdout || '');
    const err = String(error?.stderr || '');
    const details = [out, err].filter(Boolean).join('\n');
    throw new Error(
      `Failed to package reference plugin ${pluginId}: ${error?.message || error}${details ? `\n${details}` : ''}`
    );
  }

  let archiveMeta = null;
  try {
    const parsed = JSON.parse(stdout);
    archiveMeta = asObject(parsed?.archive);
  } catch (_) {
    archiveMeta = null;
  }
  if (!existsSync(archivePath)) {
    throw new Error(`Reference plugin archive was not created: ${archivePath}`);
  }
  const archiveStats = await fs.stat(archivePath);
  return {
    archivePath,
    archive: archiveMeta
      ? {
          sizeBytes: Number(archiveMeta.sizeBytes) || archiveStats.size,
          sha256: asString(archiveMeta.sha256) || null
        }
      : {
          sizeBytes: archiveStats.size,
          sha256: null
        },
    stderr
  };
}

function findReferencePluginById(plugins, pluginId) {
  const normalizedPluginId = asString(pluginId).toLowerCase();
  if (!normalizedPluginId) return null;
  if (!Array.isArray(plugins)) return null;
  return plugins.find((plugin) => asString(plugin?.id).toLowerCase() === normalizedPluginId) || null;
}

function normalizeHex64(value) {
  const normalized = asString(value).toLowerCase();
  return isHex64(normalized) ? normalized : '';
}

function evaluateMarketplacePublisherVerification(listing) {
  const listingObj = listing && typeof listing === 'object' ? listing : {};
  const manifest = listingObj?.manifest && typeof listingObj.manifest === 'object'
    ? listingObj.manifest
    : {};
  const metadata = listingObj?.metadata && typeof listingObj.metadata === 'object'
    ? listingObj.metadata
    : {};
  const manifestPublisherPubkey = normalizeHex64(
    manifest?.marketplace?.publisherPubkey || manifest?.publisherPubkey
  );
  const listingPublisherPubkey = normalizeHex64(
    metadata?.pubkey || metadata?.publisherPubkey || listingObj?.publisherPubkey
  );

  if (manifestPublisherPubkey && listingPublisherPubkey) {
    if (manifestPublisherPubkey === listingPublisherPubkey) {
      return {
        status: 'verified',
        manifestPublisherPubkey,
        listingPublisherPubkey,
        canInstallByDefault: true,
        reason: 'manifest-and-listing-publisher-match'
      };
    }
    return {
      status: 'mismatch',
      manifestPublisherPubkey,
      listingPublisherPubkey,
      canInstallByDefault: false,
      reason: 'manifest-and-listing-publisher-mismatch'
    };
  }

  return {
    status: 'unverified',
    manifestPublisherPubkey: manifestPublisherPubkey || null,
    listingPublisherPubkey: listingPublisherPubkey || null,
    canInstallByDefault: true,
    reason: manifestPublisherPubkey || listingPublisherPubkey
      ? 'publisher-pubkey-invalid'
      : 'publisher-pubkey-missing'
  };
}

function withMarketplacePublisherVerification(listing) {
  if (!listing || typeof listing !== 'object') return listing;
  const verification = evaluateMarketplacePublisherVerification(listing);
  const metadata = listing?.metadata && typeof listing.metadata === 'object'
    ? listing.metadata
    : {};
  return {
    ...listing,
    metadata: {
      ...metadata,
      publisherVerification: verification
    },
    verification
  };
}

function normalizeCommandType(value) {
  return asString(value);
}

function normalizeCommandSourceType(value, fallback = 'host') {
  const sourceType = asString(value).toLowerCase();
  return sourceType || fallback;
}

async function authorizePluginWorkerMessage(rawMessage, { defaultSourceType = 'host' } = {}) {
  if (!rawMessage || typeof rawMessage !== 'object') {
    return { success: false, error: 'Invalid worker message payload' };
  }

  const message = { ...rawMessage };
  const commandType = normalizeCommandType(message.type);
  if (!commandType) {
    return { success: false, error: 'Worker message type is required' };
  }

  const sourceType = normalizeCommandSourceType(
    message.sourceType || message.source || '',
    defaultSourceType
  );
  const pluginId = asString(message.pluginId).toLowerCase();
  const isPluginRequest = sourceType === 'plugin' || Boolean(pluginId);

  if (!isPluginRequest) {
    message.sourceType = 'host';
    delete message.pluginId;
    delete message.requiredPermission;
    if (Array.isArray(message.permissions) && message.permissions.length) {
      delete message.permissions;
    }
    return { success: true, message };
  }

  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }

  const supervisor = await ensurePluginSupervisor();
  const authorization = supervisor.authorizePluginWorkerCommand({
    pluginId,
    commandType,
    sourceType: 'plugin'
  });
  if (!authorization.success) {
    return {
      success: false,
      error: authorization.error || 'Plugin worker authorization failed'
    };
  }

  message.sourceType = 'plugin';
  message.pluginId = authorization.pluginId;
  message.permissions = authorization.permissions;
  message.requiredPermission = authorization.requiredPermission;
  return {
    success: true,
    message,
    authorization
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLogLineWithBackoff(line) {
  const payload = typeof line === 'string' ? line : String(line ?? '');
  if (!payload) return;

  await ensureStorageDir();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.appendFile(logFilePath, payload, 'utf8');
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      const shouldRetry =
        (code === 'EMFILE' || code === 'ENFILE') && attempt < LOG_APPEND_EMFILE_RETRIES;
      if (!shouldRetry) throw error;
      const backoffMs = LOG_APPEND_EMFILE_BASE_DELAY_MS * Math.pow(2, attempt);
      await delay(backoffMs);
    }
  }
}

function createWindow() {
  const runtimeIconPath = getRuntimeIconPath();
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1022,
    show: false,
    backgroundColor: '#000000',
    ...(process.platform === 'linux' || process.platform === 'win32'
      ? { icon: runtimeIconPath }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    if (pendingWorkerMessages.length) {
      pendingWorkerMessages.forEach((message) => {
        mainWindow.webContents.send('worker-message', message);
        const messageType = typeof message?.type === 'string' ? message.type : '';
        if (messageType.startsWith('media-') || messageType.startsWith('p2p-')) {
          mainWindow.webContents.send('media-event', message);
        }
      });
      pendingWorkerMessages = [];
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.RENDERER_URL;
  if (devUrl) {
    const loadDev = (url) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(url).catch((err) => {
        console.warn('[Main] loadURL error:', err?.message || err);
      });
    };
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.warn(`[Main] Renderer load failed (${errorCode}): ${errorDescription} ${validatedURL ? `(${validatedURL})` : ''}. Retrying...`);
      setTimeout(() => loadDev(devUrl), 750);
    });
    loadDev(devUrl);
  } else {
    const rendererPath = getRendererIndexPath();
    mainWindow.loadFile(rendererPath);
  }
}

function configureHtmlViewerNavigation(viewerWindow, initialUrl) {
  if (!viewerWindow || viewerWindow.isDestroyed()) return;
  let initialLoadComplete = false;

  viewerWindow.webContents.setWindowOpenHandler(({ url }) => {
    openHtmlViewerWindow({
      url,
      parentWindow: viewerWindow
    }).catch((error) => {
      console.warn('[Main] Failed to open HTML popup window', error);
    });
    return { action: 'deny' };
  });

  viewerWindow.webContents.once('did-finish-load', () => {
    initialLoadComplete = true;
  });

  viewerWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (!initialLoadComplete || !nextUrl || nextUrl === initialUrl) return;
    event.preventDefault();
    openHtmlViewerWindow({
      url: nextUrl,
      parentWindow: viewerWindow
    }).catch((error) => {
      console.warn('[Main] Failed to open navigated HTML window', error);
    });
  });
}

async function openHtmlViewerWindow({ url, title, parentWindow } = {}) {
  if (!isAllowedHtmlViewerUrl(url)) {
    return { success: false, error: 'Blocked unsupported HTML viewer URL' };
  }

  const partition = createHtmlViewerPartition();
  const viewerSession = session.fromPartition(partition);
  viewerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof viewerSession.setPermissionCheckHandler === 'function') {
    viewerSession.setPermissionCheckHandler(() => false);
  }

  const viewerWindow = new BrowserWindow({
    ...buildHtmlViewerWindowOptions(partition),
    ...(parentWindow && !parentWindow.isDestroyed() ? { parent: parentWindow } : {})
  });

  viewerWindow.removeMenu?.();
  if (title) {
    viewerWindow.setTitle(String(title));
  }
  viewerWindow.once('ready-to-show', () => {
    if (!viewerWindow.isDestroyed()) {
      viewerWindow.show();
    }
  });

  configureHtmlViewerNavigation(viewerWindow, url);

  try {
    await viewerWindow.loadURL(url);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to load HTML viewer URL', error);
    if (!viewerWindow.isDestroyed()) {
      viewerWindow.close();
    }
    return { success: false, error: error?.message || String(error) };
  }
}

async function openHtmlSourceViewer({ title, source, url } = {}) {
  let resolvedSource = typeof source === 'string' ? source : '';
  const sourceUrl = typeof url === 'string' ? url : '';

  if (!resolvedSource) {
    if (!isAllowedHtmlViewerUrl(sourceUrl)) {
      return { success: false, error: 'Blocked unsupported HTML source URL' };
    }

    try {
      const response = await net.fetch(sourceUrl);
      const finalUrl = typeof response.url === 'string' ? response.url : sourceUrl;
      if (!isAllowedHtmlViewerUrl(finalUrl)) {
        return { success: false, error: 'Blocked unsupported redirected HTML source URL' };
      }
      if (!response.ok) {
        return {
          success: false,
          error: `Failed to fetch HTML source (${response.status})`
        };
      }
      resolvedSource = await response.text();
    } catch (error) {
      console.error('[Main] Failed to fetch HTML source', error);
      return { success: false, error: error?.message || String(error) };
    }
  }

  const viewerWindow = new BrowserWindow(buildHtmlSourceViewerWindowOptions());
  viewerWindow.removeMenu?.();
  if (title) {
    viewerWindow.setTitle(String(title));
  }
  viewerWindow.once('ready-to-show', () => {
    if (!viewerWindow.isDestroyed()) {
      viewerWindow.show();
    }
  });
  viewerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewerWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const html = buildHtmlSourceViewerDocument({
    title: title || 'HTML Source',
    url: sourceUrl,
    source: resolvedSource
  });
  const dataUrl = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;

  try {
    await viewerWindow.loadURL(dataUrl);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to load HTML source viewer', error);
    if (!viewerWindow.isDestroyed()) {
      viewerWindow.close();
    }
    return { success: false, error: error?.message || String(error) };
  }
}

async function startWorkerProcess(workerConfig = null) {
  const normalizedConfig = normalizeWorkerConfigPayload(workerConfig);
  const validationError = validateWorkerConfigPayload(normalizedConfig);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const nextUserKey = normalizedConfig?.userKey || null;

  if (workerProcess) {
    // If the running worker belongs to a different user, restart it for the new account.
    if (nextUserKey && currentWorkerUserKey && nextUserKey !== currentWorkerUserKey) {
      await stopWorkerProcess();
    } else if (normalizedConfig) {
      const configResult = sendWorkerConfigToProcess(workerProcess, normalizedConfig);
      if (!configResult.success) {
        return { success: false, error: configResult.error || 'Failed to send config to running worker' };
      }
      currentWorkerUserKey = nextUserKey;
      return { success: true, alreadyRunning: true, configSent: true };
    } else {
      return { success: true, alreadyRunning: true, configSent: false };
    }
  }

  const workerRoot = getWorkerRoot();
  const workerEntry = path.join(workerRoot, 'index.js');

  if (!existsSync(workerEntry)) {
    const error = 'Relay worker entry not found in the worker package';
    console.error('[Main] ' + error);
    return { success: false, error };
  }

  try {
    await ensureStorageDir();

    // IMPORTANT: STORAGE_DIR is the base; worker will scope by USER_KEY to avoid double-nesting.
    workerProcess = spawn(process.execPath, [workerEntry], {
      cwd: workerRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        APP_DIR: workerRoot,
        STORAGE_DIR: storagePath,
        USER_KEY: nextUserKey
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    currentWorkerUserKey = nextUserKey;

    pendingWorkerMessages = [];
    gatewayStatusCache = null;
    gatewayLogsCache = [];

    workerProcess.on('message', (message) => {
      resolveWorkerRequest(message);
      if (message && typeof message === 'object') {
        if (message.type === 'gateway-status') {
          gatewayStatusCache = message.status || null;
        } else if (message.type === 'gateway-log') {
          if (message.entry) {
            gatewayLogsCache.push(message.entry);
            if (gatewayLogsCache.length > 500) {
              gatewayLogsCache = gatewayLogsCache.slice(-500);
            }
          }
        } else if (message.type === 'gateway-logs') {
          gatewayLogsCache = Array.isArray(message.logs) ? message.logs.slice(-500) : [];
        } else if (message.type === 'gateway-stopped') {
          gatewayStatusCache = message.status || { running: false };
        } else if (message.type === 'public-gateway-status') {
          publicGatewayStatusCache = message.state || null;
        } else if (message.type === 'public-gateway-config') {
          publicGatewayConfigCache = message.config || null;
        }
      }

      if (mainWindow) {
        mainWindow.webContents.send('worker-message', message);
        const messageType = typeof message?.type === 'string' ? message.type : '';
        if (messageType.startsWith('media-') || messageType.startsWith('p2p-')) {
          mainWindow.webContents.send('media-event', message);
        }
      } else {
        pendingWorkerMessages.push(message);
      }
    });

    workerProcess.on('error', (error) => {
      console.error('[Main] Worker error', error);
      rejectPendingWorkerRequests(error?.message || 'Worker process error');
      if (mainWindow) {
        mainWindow.webContents.send('worker-error', error.message);
      }
    });

    workerProcess.on('exit', (code, signal) => {
      console.log(`[Main] Worker exited with code=${code} signal=${signal}`);
      rejectPendingWorkerRequests(`Worker exited with code=${code ?? 'unknown'}`);
      workerProcess = null;
      pendingWorkerMessages = [];
      gatewayStatusCache = null;
      gatewayLogsCache = [];
      publicGatewayStatusCache = null;
      publicGatewayConfigCache = null;
      if (mainWindow) {
        mainWindow.webContents.send('worker-exit', code ?? signal ?? 0);
      }
    });

    if (workerProcess.stdout) {
      workerProcess.stdout.on('data', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('worker-stdout', data.toString());
        }
      });
    }

    if (workerProcess.stderr) {
      workerProcess.stderr.on('data', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('worker-stderr', data.toString());
        }
      });
    }

    if (mainWindow && pendingWorkerMessages.length) {
      for (const message of pendingWorkerMessages) {
        mainWindow.webContents.send('worker-message', message);
        const messageType = typeof message?.type === 'string' ? message.type : '';
        if (messageType.startsWith('media-') || messageType.startsWith('p2p-')) {
          mainWindow.webContents.send('media-event', message);
        }
      }
      pendingWorkerMessages = [];
    }

    let configSent = false;
    if (normalizedConfig) {
      const configResult = sendWorkerConfigToProcess(workerProcess, normalizedConfig);
      if (!configResult.success) {
        try {
          workerProcess.kill();
        } catch (_) {}
        workerProcess = null;
        return { success: false, error: configResult.error || 'Failed to send config to worker' };
      }
      configSent = true;
    }

    return { success: true, configSent };
  } catch (error) {
    console.error('[Main] Failed to start worker', error);
    workerProcess = null;
    return { success: false, error: error.message };
  }
}

async function stopWorkerProcess() {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  try {
    workerProcess.removeAllListeners();
    workerProcess.kill();
    rejectPendingWorkerRequests('Worker stopped');
    workerProcess = null;
    pendingWorkerMessages = [];
    currentWorkerUserKey = null;
    gatewayStatusCache = null;
    gatewayLogsCache = [];
    publicGatewayConfigCache = null;
    publicGatewayStatusCache = null;
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to stop worker', error);
    return { success: false, error: error.message };
  }
}

function resolveWorkerRequest(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type !== 'worker-response') return false;
  const requestId = typeof message.requestId === 'string' ? message.requestId : null;
  if (!requestId) return false;
  const pending = pendingWorkerRequests.get(requestId);
  if (!pending) return false;
  pendingWorkerRequests.delete(requestId);
  clearTimeout(pending.timeoutId);
  pending.resolve({
    success: message.success !== false,
    data: message.data ?? null,
    error: message.error || null,
    requestId
  });
  return true;
}

function rejectPendingWorkerRequests(reason = 'Worker unavailable') {
  const entries = Array.from(pendingWorkerRequests.values());
  pendingWorkerRequests.clear();
  for (const pending of entries) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ success: false, error: reason });
  }
}

function sendGatewayCommand(type, payload = {}) {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  try {
    workerProcess.send({ type, ...payload });
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to send gateway command', error);
    return { success: false, error: error.message };
  }
}

async function sendWorkerRequestAwait(payload, defaultTimeoutMs = 30000) {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  const baseMessage =
    payload && typeof payload === 'object' && payload.message && typeof payload.message === 'object'
      ? payload.message
      : payload;
  if (!baseMessage || typeof baseMessage !== 'object') {
    return { success: false, error: 'Invalid worker message payload' };
  }

  const timeoutMsRaw =
    payload && typeof payload === 'object' && Number.isFinite(payload.timeoutMs)
      ? Number(payload.timeoutMs)
      : defaultTimeoutMs;
  const timeoutMs = Math.max(1000, Math.min(timeoutMsRaw, 300000));
  const requestId =
    typeof baseMessage.requestId === 'string' && baseMessage.requestId
      ? baseMessage.requestId
      : generateWorkerRequestId();
  const messageToSend = { ...baseMessage, requestId };

  if (pendingWorkerRequests.has(requestId)) {
    return { success: false, error: `Duplicate worker requestId: ${requestId}` };
  }

  return await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!pendingWorkerRequests.has(requestId)) return;
      pendingWorkerRequests.delete(requestId);
      resolve({ success: false, error: `Worker reply timeout after ${timeoutMs}ms`, requestId });
    }, timeoutMs);

    pendingWorkerRequests.set(requestId, { resolve, timeoutId });

    try {
      workerProcess.send(messageToSend);
    } catch (error) {
      clearTimeout(timeoutId);
      pendingWorkerRequests.delete(requestId);
      resolve({ success: false, error: error.message, requestId });
    }
  });
}

ipcMain.handle('start-worker', async (_event, config) => {
  return startWorkerProcess(config);
});

ipcMain.handle('stop-worker', async () => {
  return stopWorkerProcess();
});

ipcMain.handle('send-to-worker', async (_event, message) => {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  const authorization = await authorizePluginWorkerMessage(message, {
    defaultSourceType: 'host'
  });
  if (!authorization.success) {
    return {
      success: false,
      error: authorization.error || 'Worker command authorization failed'
    };
  }

  try {
    workerProcess.send(authorization.message);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to send message to worker', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('send-to-worker-await', async (_event, payload) => {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  const hasMessageWrapper = normalizedPayload.message && typeof normalizedPayload.message === 'object';
  const rawMessage = hasMessageWrapper ? normalizedPayload.message : normalizedPayload;
  const authorization = await authorizePluginWorkerMessage(rawMessage, {
    defaultSourceType: 'host'
  });
  if (!authorization.success) {
    return {
      success: false,
      error: authorization.error || 'Worker command authorization failed'
    };
  }

  if (hasMessageWrapper) {
    return sendWorkerRequestAwait(
      {
        ...normalizedPayload,
        message: authorization.message
      },
      30000
    );
  }
  return sendWorkerRequestAwait(authorization.message, 30000);
});

ipcMain.handle('media-command', async (_event, payload) => {
  const command = payload && typeof payload === 'object' ? payload : {};
  const type = typeof command.type === 'string' ? command.type : '';
  if (!type || (!type.startsWith('media-') && !type.startsWith('p2p-'))) {
    return { success: false, error: 'Invalid media command type' };
  }

  const authorization = await authorizePluginWorkerMessage(
    {
      type,
      data: command.data || {},
      sourceType: command.sourceType || 'host',
      pluginId: command.pluginId
    },
    {
      defaultSourceType: 'host'
    }
  );
  if (!authorization.success) {
    return {
      success: false,
      error: authorization.error || 'Media command authorization failed'
    };
  }

  const response = await sendWorkerRequestAwait(
    {
      message: authorization.message,
      timeoutMs: Number.isFinite(command.timeoutMs) ? Number(command.timeoutMs) : 45000
    },
    45000
  );
  return response;
});

ipcMain.handle('plugin-list', async () => {
  if (!arePluginsEnabled()) {
    return { success: true, plugins: [] };
  }
  const supervisor = await ensurePluginSupervisor();
  return { success: true, plugins: supervisor.listPlugins() };
});

ipcMain.handle('plugin-get-ui-contributions', async () => {
  if (!arePluginsEnabled()) {
    return {
      success: true,
      plugins: [],
      navItems: [],
      routes: [],
      collisions: [],
      blockedContributions: []
    };
  }
  const supervisor = await ensurePluginSupervisor();
  const data = supervisor.getUiContributions();
  return { success: true, ...data };
});

ipcMain.handle('plugin-reference-list', async () => {
  if (!arePluginsEnabled()) {
    return { success: true, plugins: [], warnings: [] };
  }
  try {
    const definitions = await loadReferencePluginDefinitions();
    return {
      success: true,
      plugins: definitions.plugins
        .map((plugin) => toPublicReferencePlugin(plugin))
        .filter((plugin) => plugin && plugin.id),
      warnings: definitions.warnings
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error)
    };
  }
});

ipcMain.handle('plugin-reference-install', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const request = payload && typeof payload === 'object' ? payload : {};
  const pluginId = asString(request.pluginId).toLowerCase();
  if (!pluginId) {
    return {
      success: false,
      error: 'pluginId is required'
    };
  }

  try {
    const definitions = await loadReferencePluginDefinitions();
    const referencePlugin = findReferencePluginById(definitions.plugins, pluginId);
    if (!referencePlugin) {
      return {
        success: false,
        error: `Reference plugin not found: ${pluginId}`
      };
    }

    const requestedVersion = asString(request.version);
    if (requestedVersion && requestedVersion !== referencePlugin.version) {
      return {
        success: false,
        error: `Reference plugin ${pluginId} is available as ${referencePlugin.version}; requested ${requestedVersion}`
      };
    }

    const packaged = await packageReferencePlugin(referencePlugin);
    const supervisor = await ensurePluginSupervisor();
    const installResult = await supervisor.installPluginArchive({
      archivePath: packaged.archivePath,
      source: 'first-party-reference'
    });

    if (!installResult?.success) {
      return installResult;
    }

    return {
      success: true,
      plugin: installResult.plugin || null,
      referencePlugin: toPublicReferencePlugin(referencePlugin),
      archive: packaged.archive,
      warnings: definitions.warnings
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error)
    };
  }
});

ipcMain.handle('plugin-discover', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.discoverPlugin(payload || {});
});

ipcMain.handle('plugin-install', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.installPlugin(payload || {});
});

ipcMain.handle('plugin-install-archive', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.installPluginArchive(payload || {});
});

ipcMain.handle('plugin-preview-archive', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.previewPluginArchive(payload || {});
});

ipcMain.handle('plugin-uninstall', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.uninstallPlugin(payload || {});
});

ipcMain.handle('plugin-enable', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.enablePlugin(payload || {});
});

ipcMain.handle('plugin-disable', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.disablePlugin(payload || {});
});

ipcMain.handle('plugin-approve-version', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.approveVersion(payload || {});
});

ipcMain.handle('plugin-reject-version', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.rejectVersion(payload || {});
});

ipcMain.handle('plugin-elevate-tier', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.elevateTier(payload || {});
});

ipcMain.handle('plugin-get-audit', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: true, entries: [] };
  }
  const supervisor = await ensurePluginSupervisor();
  const pluginId = typeof payload === 'string' ? payload : payload?.pluginId;
  const limit = typeof payload?.limit === 'number' ? payload.limit : 200;
  return supervisor.getAudit(pluginId, limit);
});

ipcMain.handle('plugin-invoke', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  return supervisor.invokePlugin(payload || {});
});

ipcMain.handle('plugin-marketplace-discover', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  const discoveryPayload = payload && typeof payload === 'object' ? payload : {};
  const workerDiscovery = await sendWorkerRequestAwait(
    {
      message: {
        type: 'plugin-marketplace-discover',
        data: discoveryPayload
      },
      timeoutMs: Number.isFinite(discoveryPayload.timeoutMs) ? Number(discoveryPayload.timeoutMs) : 60_000
    },
    60_000
  );

  if (!workerDiscovery?.success) {
    return {
      success: false,
      error: workerDiscovery?.error || 'Marketplace discovery failed'
    };
  }

  const listings = (Array.isArray(workerDiscovery?.data?.listings) ? workerDiscovery.data.listings : [])
    .map((listing) => withMarketplacePublisherVerification(listing));
  const ingest = await supervisor.discoverFromMarketplaceListings({
    listings,
    source: 'nostr-marketplace'
  });

  if (!ingest.success) {
    return ingest;
  }

  return {
    success: true,
    listings,
    warnings: Array.isArray(workerDiscovery?.data?.warnings) ? workerDiscovery.data.warnings : [],
    relays: Array.isArray(workerDiscovery?.data?.relays) ? workerDiscovery.data.relays : [],
    ...ingest
  };
});

ipcMain.handle('plugin-marketplace-install', async (_event, payload) => {
  if (!arePluginsEnabled()) {
    return { success: false, error: 'Plugins are disabled' };
  }
  const supervisor = await ensurePluginSupervisor();
  const installPayload = payload && typeof payload === 'object' ? payload : {};
  const listing = installPayload.listing && typeof installPayload.listing === 'object'
    ? installPayload.listing
    : null;
  const manifest = listing?.manifest && typeof listing.manifest === 'object'
    ? listing.manifest
    : null;
  if (!listing || !manifest) {
    return {
      success: false,
      error: 'Marketplace install requires listing.manifest'
    };
  }

  const verification = evaluateMarketplacePublisherVerification(listing);
  const allowPublisherMismatch = installPayload.allowPublisherMismatch === true;
  if (verification.status === 'mismatch' && !allowPublisherMismatch) {
    return {
      success: false,
      error: [
        'Publisher mismatch detected between listing and manifest.',
        `listing=${verification.listingPublisherPubkey || 'unknown'}`,
        `manifest=${verification.manifestPublisherPubkey || 'unknown'}`
      ].join(' '),
      requiresOverride: true,
      verification
    };
  }

  const listingWithVerification = withMarketplacePublisherVerification(listing);
  const discoverResult = await supervisor.discoverPlugin({
    manifest,
    source: 'nostr-marketplace',
    marketplace:
      listingWithVerification?.metadata && typeof listingWithVerification.metadata === 'object'
        ? listingWithVerification.metadata
        : null,
    social: listingWithVerification?.metadata?.social || listingWithVerification?.social || null
  });
  if (!discoverResult.success) {
    return {
      ...discoverResult,
      verification
    };
  }

  const timeoutMs = Number.isFinite(installPayload.timeoutMs) ? Number(installPayload.timeoutMs) : 120_000;
  const workerDownload = await sendWorkerRequestAwait(
    {
      message: {
        type: 'plugin-marketplace-download',
        data: {
          listing: listingWithVerification,
          bundleUrl: asString(installPayload.bundleUrl),
          archiveUrl: asString(installPayload.archiveUrl),
          maxBytes: Number.isFinite(installPayload.maxBytes) ? Number(installPayload.maxBytes) : undefined
        }
      },
      timeoutMs
    },
    timeoutMs
  );

  if (!workerDownload?.success) {
    return {
      success: false,
      error: workerDownload?.error || 'Failed to download marketplace plugin archive',
      verification
    };
  }

  const archivePath = asString(workerDownload?.data?.archivePath);
  if (!archivePath) {
    return {
      success: false,
      error: 'Marketplace download did not return an archive path',
      verification
    };
  }

  const installResult = await supervisor.installPluginArchive({
    archivePath,
    source: 'nostr-marketplace'
  });
  if (!installResult.success) {
    return {
      ...installResult,
      verification
    };
  }

  return {
    success: true,
    plugin: installResult.plugin,
    download: workerDownload.data || null,
    verification,
    overrideAccepted: verification.status === 'mismatch' ? allowPublisherMismatch : false
  };
});

ipcMain.handle('gateway-start', async (_event, options) => {
  return sendGatewayCommand('start-gateway', { options });
});

ipcMain.handle('gateway-stop', async () => {
  return sendGatewayCommand('stop-gateway');
});

ipcMain.handle('gateway-get-status', async () => {
  if (workerProcess) {
    workerProcess.send({ type: 'get-gateway-status' });
  }
  return { success: true, status: gatewayStatusCache };
});

ipcMain.handle('gateway-get-logs', async () => {
  if (workerProcess) {
    workerProcess.send({ type: 'get-gateway-logs' });
  }
  return { success: true, logs: gatewayLogsCache };
});

ipcMain.handle('public-gateway-get-config', async () => {
  if (workerProcess) {
    workerProcess.send({ type: 'get-public-gateway-config' });
  } else if (!publicGatewayConfigCache) {
    try {
      await ensureStorageDir();
      const data = await fs.readFile(publicGatewaySettingsPath, 'utf8');
      publicGatewayConfigCache = JSON.parse(data);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        console.warn('[Main] Failed to read public gateway settings:', error?.message || error);
      }
    }
  }
  return { success: true, config: publicGatewayConfigCache };
});

ipcMain.handle('public-gateway-set-config', async (_event, config) => {
  if (workerProcess) {
    return sendGatewayCommand('set-public-gateway-config', { config });
  }

  try {
    await ensureStorageDir();
    await fs.writeFile(publicGatewaySettingsPath, JSON.stringify(config || {}, null, 2), 'utf8');
    publicGatewayConfigCache = config || null;
    if (mainWindow) {
      mainWindow.webContents.send('worker-message', { type: 'public-gateway-config', config: publicGatewayConfigCache });
    }
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write public gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('public-gateway-get-status', async () => {
  if (workerProcess) {
    workerProcess.send({ type: 'get-public-gateway-status' });
  }
  return { success: true, status: publicGatewayStatusCache };
});

ipcMain.handle('public-gateway-generate-token', async (_event, payload) => {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }
  return sendGatewayCommand('generate-public-gateway-token', payload || {});
});

ipcMain.handle('public-gateway-refresh-relay', async (_event, data) => {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }
  const relayKey = typeof data === 'string' ? data : data?.relayKey;
  return sendGatewayCommand('refresh-public-gateway-relay', { relayKey });
});

ipcMain.handle('public-gateway-refresh-all', async () => {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }
  return sendGatewayCommand('refresh-public-gateway-all');
});

ipcMain.handle('read-config', async () => {
  try {
    await ensureStorageDir();
    const configPath = path.join(storagePath, 'relay-config.json');
    const data = await fs.readFile(configPath, 'utf8');
    return { success: true, data: JSON.parse(data) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-config', async (_event, config) => {
  try {
    await ensureStorageDir();
    const configPath = path.join(storagePath, 'relay-config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write config', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-gateway-settings', async () => {
  try {
    await ensureStorageDir();
    const data = await fs.readFile(gatewaySettingsPath, 'utf8');
    return { success: true, data: JSON.parse(data) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { success: true, data: null };
    }
    console.error('[Main] Failed to read gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-gateway-settings', async (_event, settings) => {
  try {
    await ensureStorageDir();
    await fs.writeFile(gatewaySettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-public-gateway-settings', async () => {
  try {
    await ensureStorageDir();
    const data = await fs.readFile(publicGatewaySettingsPath, 'utf8');
    return { success: true, data: JSON.parse(data) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { success: true, data: null };
    }
    console.error('[Main] Failed to read public gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-public-gateway-settings', async (_event, settings) => {
  try {
    await ensureStorageDir();
    await fs.writeFile(publicGatewaySettingsPath, JSON.stringify(settings || {}, null, 2), 'utf8');
    publicGatewayConfigCache = settings || null;
    if (mainWindow) {
      mainWindow.webContents.send('worker-message', { type: 'public-gateway-config', config: publicGatewayConfigCache });
    }
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write public gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-storage-path', async () => {
  await ensureStorageDir();
  return storagePath;
});

ipcMain.handle('get-log-file-path', async () => {
  await ensureStorageDir();
  return logFilePath;
});

ipcMain.handle('append-log-line', async (_event, line) => {
  const writeTask = logAppendChain.then(() => appendLogLineWithBackoff(line));
  logAppendChain = writeTask.catch(() => {});
  try {
    await writeTask;
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to append log', error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('read-file-buffer', async (_event, filePath) => {
  try {
    const data = await fs.readFile(filePath);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return { success: true, data: buffer };
  } catch (error) {
    console.error('[Main] Failed to read file buffer', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-save-dialog', async (_event, payload) => {
  try {
    const defaultFileName =
      payload && typeof payload === 'object' && typeof payload.defaultFileName === 'string'
        ? payload.defaultFileName.trim()
        : '';
    const result = await dialog.showSaveDialog(mainWindow || undefined, {
      defaultPath: defaultFileName
        ? path.join(app.getPath('downloads'), defaultFileName)
        : undefined
    });
    return {
      canceled: !!result.canceled,
      filePath: result.filePath || undefined
    };
  } catch (error) {
    console.error('[Main] Failed to show save dialog', error);
    return {
      canceled: true
    };
  }
});

ipcMain.handle('open-html-viewer-window', async (_event, payload) => {
  const request = payload && typeof payload === 'object' ? payload : {};
  return openHtmlViewerWindow({
    url: typeof request.url === 'string' ? request.url : '',
    title: typeof request.title === 'string' ? request.title : '',
    parentWindow: BrowserWindow.fromWebContents(_event.sender) || mainWindow
  });
});

ipcMain.handle('open-html-source-viewer', async (_event, payload) => {
  const request = payload && typeof payload === 'object' ? payload : {};
  return openHtmlSourceViewer({
    title: typeof request.title === 'string' ? request.title : '',
    url: typeof request.url === 'string' ? request.url : '',
    source: typeof request.source === 'string' ? request.source : ''
  });
});

app.whenReady().then(async () => {
  await ensureStorageDir();
  if (arePluginsEnabled()) {
    await ensurePluginSupervisor();
  }
  if (process.platform === 'darwin' && app.dock && existsSync(getRuntimeIconPath())) {
    app.dock.setIcon(getRuntimeIconPath());
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (pluginSupervisor) {
      pluginSupervisor.stopAll().catch((error) => {
        console.warn('[Main] Failed to stop plugin supervisor on shutdown', error?.message || error);
      });
    }
    if (workerProcess) {
      try {
        workerProcess.kill();
      } catch (error) {
        console.error('[Main] Error while killing worker on shutdown', error);
      }
      workerProcess = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (pluginSupervisor) {
    pluginSupervisor.stopAll().catch((error) => {
      console.warn('[Main] Failed to stop plugin supervisor before quit', error?.message || error);
    });
  }
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch (error) {
      console.error('[Main] Error while stopping worker before quit', error);
    }
    workerProcess = null;
  }
});
