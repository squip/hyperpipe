const { contextBridge, ipcRenderer } = require('electron');
const { createRequire } = require('module');
const nodeRequire = createRequire(__filename);
const SAFE_MODULE_ALLOWLIST = new Set(['hypercore-crypto']);

function assertAllowedModule(specifier) {
  if (!SAFE_MODULE_ALLOWLIST.has(specifier)) {
    throw new Error(`Module not allowlisted: ${specifier}`);
  }
}

async function importModule(specifier) {
  assertAllowedModule(specifier);
  try {
    return await import(specifier);
  } catch (importError) {
    try {
      return nodeRequire(specifier);
    } catch (requireError) {
      throw importError;
    }
  }
}

function requireModule(specifier) {
  assertAllowedModule(specifier);
  return nodeRequire(specifier);
}

function registerListener(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  startWorker: (config) => ipcRenderer.invoke('start-worker', config),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  sendToWorker: (message) => ipcRenderer.invoke('send-to-worker', message),
  sendToWorkerAwait: (payload) => ipcRenderer.invoke('send-to-worker-await', payload),
  mediaCommand: (payload) => ipcRenderer.invoke('media-command', payload),
  listPlugins: () => ipcRenderer.invoke('plugin-list'),
  discoverPlugin: (payload) => ipcRenderer.invoke('plugin-discover', payload),
  installPlugin: (payload) => ipcRenderer.invoke('plugin-install', payload),
  installPluginArchive: (payload) => ipcRenderer.invoke('plugin-install-archive', payload),
  previewPluginArchive: (payload) => ipcRenderer.invoke('plugin-preview-archive', payload),
  uninstallPlugin: (payload) => ipcRenderer.invoke('plugin-uninstall', payload),
  enablePlugin: (payload) => ipcRenderer.invoke('plugin-enable', payload),
  disablePlugin: (payload) => ipcRenderer.invoke('plugin-disable', payload),
  approvePluginVersion: (payload) => ipcRenderer.invoke('plugin-approve-version', payload),
  rejectPluginVersion: (payload) => ipcRenderer.invoke('plugin-reject-version', payload),
  elevatePluginTier: (payload) => ipcRenderer.invoke('plugin-elevate-tier', payload),
  getPluginAudit: (payload) => ipcRenderer.invoke('plugin-get-audit', payload),
  invokePlugin: (payload) => ipcRenderer.invoke('plugin-invoke', payload),
  discoverMarketplacePlugins: (payload) => ipcRenderer.invoke('plugin-marketplace-discover', payload),
  installMarketplacePlugin: (payload) => ipcRenderer.invoke('plugin-marketplace-install', payload),
  getPluginUIContributions: () => ipcRenderer.invoke('plugin-get-ui-contributions'),
  listReferencePlugins: () => ipcRenderer.invoke('plugin-reference-list'),
  installReferencePlugin: (payload) => ipcRenderer.invoke('plugin-reference-install', payload),
  onWorkerMessage: registerListener('worker-message'),
  onWorkerError: registerListener('worker-error'),
  onWorkerExit: registerListener('worker-exit'),
  onWorkerStdout: registerListener('worker-stdout'),
  onWorkerStderr: registerListener('worker-stderr'),
  onMediaEvent: registerListener('media-event'),
  onPluginEvent: registerListener('plugin-event'),
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),
  readGatewaySettings: () => ipcRenderer.invoke('read-gateway-settings'),
  writeGatewaySettings: (settings) => ipcRenderer.invoke('write-gateway-settings', settings),
  startGateway: (options) => ipcRenderer.invoke('gateway-start', options),
  stopGateway: () => ipcRenderer.invoke('gateway-stop'),
  getGatewayStatus: () => ipcRenderer.invoke('gateway-get-status'),
  getGatewayLogs: () => ipcRenderer.invoke('gateway-get-logs'),
  getPublicGatewayConfig: () => ipcRenderer.invoke('public-gateway-get-config'),
  setPublicGatewayConfig: (config) => ipcRenderer.invoke('public-gateway-set-config', config),
  getPublicGatewayStatus: () => ipcRenderer.invoke('public-gateway-get-status'),
  generatePublicGatewayToken: (payload) => ipcRenderer.invoke('public-gateway-generate-token', payload),
  refreshPublicGatewayRelay: (payload) => ipcRenderer.invoke('public-gateway-refresh-relay', payload),
  refreshPublicGatewayAll: () => ipcRenderer.invoke('public-gateway-refresh-all'),
  readPublicGatewaySettings: () => ipcRenderer.invoke('read-public-gateway-settings'),
  writePublicGatewaySettings: (settings) => ipcRenderer.invoke('write-public-gateway-settings', settings),
  getStoragePath: () => ipcRenderer.invoke('get-storage-path'),
  getLogFilePath: () => ipcRenderer.invoke('get-log-file-path'),
  appendLogLine: (line) => ipcRenderer.invoke('append-log-line', line),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  importModule,
  requireModule
});
