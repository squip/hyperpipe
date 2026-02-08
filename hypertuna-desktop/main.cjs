const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { promises: fs, existsSync } = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let workerProcess = null;
let pendingWorkerMessages = [];
let pendingWorkerRequests = new Map();
let gatewayStatusCache = null;
let gatewayLogsCache = [];
let publicGatewayConfigCache = null;
let publicGatewayStatusCache = null;
let currentWorkerUserKey = null;

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

const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'hypertuna-data');
const logFilePath = path.join(storagePath, 'desktop-console.log');
const gatewaySettingsPath = path.join(storagePath, 'gateway-settings.json');
const publicGatewaySettingsPath = path.join(storagePath, 'public-gateway-settings.json');
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
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1022,
    backgroundColor: '#1F2430',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!pendingWorkerMessages.length) return;
    pendingWorkerMessages.forEach((message) => {
      mainWindow.webContents.send('worker-message', message);
    });
    pendingWorkerMessages = [];
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
    const rendererPath = path.join(__dirname, '..', 'indiepress-dev', 'dist', 'index.html');
    mainWindow.loadFile(rendererPath);
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

  const workerRoot = path.join(__dirname, '..', 'hypertuna-worker');
  const workerEntry = path.join(workerRoot, 'index.js');

  if (!existsSync(workerEntry)) {
    const error = 'Relay worker entry not found in hypertuna-worker/index.js';
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

  try {
    workerProcess.send(message);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to send message to worker', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('send-to-worker-await', async (_event, payload) => {
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
      : 30000;
  const timeoutMs = Math.max(1000, Math.min(timeoutMsRaw, 300000));
  const requestId =
    typeof baseMessage.requestId === 'string' && baseMessage.requestId
      ? baseMessage.requestId
      : `worker-req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
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

app.whenReady().then(async () => {
  await ensureStorageDir();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
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
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch (error) {
      console.error('[Main] Error while stopping worker before quit', error);
    }
    workerProcess = null;
  }
});
