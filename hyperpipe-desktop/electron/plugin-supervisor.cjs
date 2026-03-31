const path = require('path');
const { promises: fs, existsSync, createReadStream } = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const STATE_VERSION = 1;
const INVOKE_TIMEOUT_MS = 30_000;
const MAX_AUDIT_ENTRIES = 500;
const INVOKE_RATE_LIMIT_PER_MINUTE = 240;
const MAX_LISTINGS_PER_DISCOVERY = 500;
const ARCHIVE_INSTALL_TIMEOUT_MS = 30_000;
const ARCHIVE_LIST_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_SIZE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 4_000;
const MAX_EXTRACTED_FILE_COUNT = 4_000;
const MAX_EXTRACTED_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ARCHIVE_PATH_LENGTH = 512;
const BLOCKED_ARCHIVE_SEGMENTS = new Set(['.git', '.hg', '.svn']);
const DISALLOWED_ARCHIVE_ENTRY_TYPES = new Set(['l', 'h', 'b', 'c', 'p', 's']);
const PLUGIN_WORKER_COMMAND_PERMISSION_MAP = {
  'media-create-session': 'media.session',
  'media-join-session': 'media.session',
  'media-leave-session': 'media.session',
  'media-list-sessions': 'media.session',
  'media-get-session': 'media.session',
  'media-update-stream-metadata': 'media.session',
  'media-get-service-status': 'media.session',
  'media-get-stats': 'media.session',
  'media-send-signal': 'p2p.session',
  'media-start-recording': 'media.record',
  'media-stop-recording': 'media.record',
  'media-list-recordings': 'media.record',
  'media-export-recording': 'media.record',
  'media-transcode-recording': 'media.transcode',
  'p2p-create-session': 'p2p.session',
  'p2p-join-session': 'p2p.session',
  'p2p-leave-session': 'p2p.session',
  'p2p-send-signal': 'p2p.session',
  'nostr-read': 'nostr.read',
  'nostr-query': 'nostr.read',
  'nostr-subscribe': 'nostr.read',
  'nostr-list-relays': 'nostr.read',
  'nostr-publish': 'nostr.publish',
  'nostr-publish-event': 'nostr.publish'
};

function now() {
  return Date.now();
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function deepClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function createRequestId(prefix = 'plugin-invoke') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function sanitizePluginId(value) {
  const id = asString(value).toLowerCase();
  if (!/^[a-z0-9]+([.-][a-z0-9]+)+$/.test(id)) return '';
  return id;
}

function normalizeSourceType(value) {
  const sourceType = asString(value).toLowerCase();
  return sourceType || 'host';
}

function isRouteScopedToPlugin(routePath, pluginId) {
  if (!routePath || !pluginId) return false;
  const expectedPrefix = `/plugins/${pluginId}`;
  return routePath === expectedPrefix || routePath.startsWith(`${expectedPrefix}/`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function isLikelyPluginArchive(filePath) {
  const normalized = asString(filePath).toLowerCase();
  return normalized.endsWith('.htplugin.tgz') || normalized.endsWith('.tgz');
}

function isValidSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function normalizeArchiveEntryPath(rawPath) {
  let normalized = asString(rawPath).replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function assertArchiveRelativePath(relativePath, label = 'Archive path') {
  const normalized = normalizeArchiveEntryPath(relativePath);
  if (!normalized) {
    throw new Error(`${label} is empty`);
  }
  if (normalized.includes('\0')) {
    throw new Error(`${label} contains NUL byte`);
  }
  if (normalized.length > MAX_ARCHIVE_PATH_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_ARCHIVE_PATH_LENGTH} characters`);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} must be a relative path`);
  }
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`${label} contains disallowed path segment "${segment}"`);
    }
    if (BLOCKED_ARCHIVE_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`${label} contains blocked segment "${segment}"`);
    }
  }
  return normalized;
}

function createSha256Hash() {
  return crypto.createHash('sha256');
}

async function sha256ForFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createSha256Hash();
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', (error) => reject(error));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function listFilesRecursive(rootDir) {
  const stack = [''];
  const files = [];
  while (stack.length) {
    const relative = stack.pop();
    const currentPath = path.join(rootDir, relative);
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRelative);
        continue;
      }
      if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function sha256ForDirectory(rootDir) {
  const hash = createSha256Hash();
  const files = await listFilesRecursive(rootDir);
  for (const relativePath of files) {
    const data = await fs.readFile(path.join(rootDir, relativePath));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fallbackNormalizeManifest(raw = {}) {
  const id = sanitizePluginId(raw.id);
  const contributions = raw && typeof raw.contributions === 'object' ? raw.contributions : {};
  const navItems = ensureArray(contributions.navItems).map((entry) => ({
    id: asString(entry?.id),
    title: asString(entry?.title),
    description: asString(entry?.description),
    icon: asString(entry?.icon),
    routePath: asString(entry?.routePath),
    order: Number.isFinite(entry?.order) ? Number(entry.order) : 100
  }));
  const routes = ensureArray(contributions.routes).map((entry) => ({
    id: asString(entry?.id),
    title: asString(entry?.title),
    description: asString(entry?.description),
    path: asString(entry?.path),
    iframeSrc: asString(entry?.iframeSrc),
    moduleId: asString(entry?.moduleId),
    timeoutMs: Number.isFinite(entry?.timeoutMs) ? Number(entry.timeoutMs) : undefined
  }));
  const mediaFeatures = ensureArray(contributions.mediaFeatures).map((entry) => ({
    id: asString(entry?.id),
    name: asString(entry?.name),
    description: asString(entry?.description),
    maxBitrateKbps: Number.isFinite(entry?.maxBitrateKbps) ? Number(entry.maxBitrateKbps) : undefined,
    maxSessions: Number.isFinite(entry?.maxSessions) ? Number(entry.maxSessions) : undefined,
    supportsRecording: entry?.supportsRecording === true,
    supportsTranscode: entry?.supportsTranscode === true
  }));

  return {
    id,
    name: asString(raw.name),
    version: asString(raw.version),
    engines: {
      hyperpipe: asString(raw?.engines?.hyperpipe),
      worker: asString(raw?.engines?.worker),
      renderer: asString(raw?.engines?.renderer),
      mediaApi: asString(raw?.engines?.mediaApi)
    },
    entrypoints: {
      runner: asString(raw?.entrypoints?.runner)
    },
    permissions: ensureArray(raw.permissions).map((entry) => asString(entry)).filter(Boolean),
    contributions: {
      navItems,
      routes,
      mediaFeatures
    },
    integrity: {
      bundleSha256: asString(raw?.integrity?.bundleSha256).toLowerCase(),
      sourceSha256: asString(raw?.integrity?.sourceSha256).toLowerCase()
    },
    source: {
      hyperdriveUrl: asString(raw?.source?.hyperdriveUrl),
      path: asString(raw?.source?.path)
    },
    marketplace: {
      publisherPubkey: asString(raw?.marketplace?.publisherPubkey).toLowerCase(),
      tags: ensureArray(raw?.marketplace?.tags).map((entry) => asString(entry)).filter(Boolean)
    }
  };
}

function fallbackValidateManifest(raw = {}) {
  const manifest = fallbackNormalizeManifest(raw);
  const errors = [];
  if (!manifest.id) errors.push('Manifest id is required');
  if (!manifest.name) errors.push('Manifest name is required');
  if (!manifest.version) errors.push('Manifest version is required');
  if (!manifest.engines.hyperpipe) errors.push('Manifest engines.hyperpipe is required');
  if (!manifest.engines.worker) errors.push('Manifest engines.worker is required');
  if (!manifest.engines.renderer) errors.push('Manifest engines.renderer is required');
  if (!manifest.engines.mediaApi) errors.push('Manifest engines.mediaApi is required');

  const routePaths = new Set();
  for (const route of manifest.contributions.routes) {
    if (!route.id) errors.push('Route id is required');
    if (!route.path) errors.push(`Route ${route.id || '<unknown>'} path is required`);
    if (route.path && !isRouteScopedToPlugin(route.path, manifest.id)) {
      errors.push(`Route ${route.path} must be under /plugins/${manifest.id}`);
    }
    if (route.path && routePaths.has(route.path)) {
      errors.push(`Duplicate route path ${route.path}`);
    }
    routePaths.add(route.path);
  }

  for (const navItem of manifest.contributions.navItems) {
    if (!navItem.id) errors.push('Nav item id is required');
    if (!navItem.title) errors.push(`Nav item ${navItem.id || '<unknown>'} title is required`);
    if (!navItem.routePath) errors.push(`Nav item ${navItem.id || '<unknown>'} routePath is required`);
    if (navItem.routePath && !isRouteScopedToPlugin(navItem.routePath, manifest.id)) {
      errors.push(`Nav item route ${navItem.routePath} must be under /plugins/${manifest.id}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest
  };
}

function isApproved(plugin) {
  return plugin && plugin.approvedVersion && plugin.approvedVersion === plugin.version;
}

function isEnabled(plugin) {
  return plugin && plugin.enabled === true && isApproved(plugin);
}

class PluginSupervisor {
  constructor({ storagePath, logger = console, sharedRoot = null } = {}) {
    if (!storagePath || typeof storagePath !== 'string') {
      throw new Error('PluginSupervisor requires storagePath');
    }

    this.logger = logger;
    this.storagePath = storagePath;
    this.sharedRoot = typeof sharedRoot === 'string' && sharedRoot
      ? sharedRoot
      : path.join(__dirname, '..', '..', 'hyperpipe-bridge');
    this.pluginsRoot = path.join(storagePath, 'plugins');
    this.registryPath = path.join(this.pluginsRoot, 'registry.json');
    this.runnerPath = path.join(__dirname, 'plugin-runner.cjs');

    this.state = {
      version: STATE_VERSION,
      plugins: {}
    };
    this.contracts = null;
    this.pluginRunners = new Map();
    this.rendererEmitter = null;
  }

  setRendererEmitter(emitter) {
    this.rendererEmitter = typeof emitter === 'function' ? emitter : null;
  }

  async init() {
    await fs.mkdir(this.pluginsRoot, { recursive: true });
    await this.loadState();
    await this.syncRunners();
  }

  async getContracts() {
    if (this.contracts) return this.contracts;
    try {
      const url = pathToFileURL(path.join(this.sharedRoot, 'plugins', 'index.mjs')).href;
      this.contracts = await import(url);
    } catch (error) {
      this.logger.warn('[PluginSupervisor] Failed to load shared plugin contracts; falling back', error?.message || error);
      this.contracts = null;
    }
    return this.contracts;
  }

  async validateManifest(rawManifest = {}) {
    const contracts = await this.getContracts();
    if (contracts && typeof contracts.validatePluginManifest === 'function') {
      return contracts.validatePluginManifest(rawManifest, { strict: false });
    }
    return fallbackValidateManifest(rawManifest);
  }

  normalizePluginRecord(manifest, source = 'install') {
    const nowTs = now();
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      tier: 'restricted',
      status: source === 'discover' ? 'discovered' : 'installed',
      enabled: false,
      approvedVersion: null,
      approvedAt: null,
      rejectedVersion: null,
      rejectedAt: null,
      installedAt: source === 'discover' ? null : nowTs,
      discoveredAt: source === 'discover' ? nowTs : null,
      updatedAt: nowTs,
      permissions: ensureArray(manifest.permissions),
      contributions: deepClone(manifest.contributions || {}),
      engines: deepClone(manifest.engines || {}),
      entrypoints: deepClone(manifest.entrypoints || {}),
      integrity: deepClone(manifest.integrity || {}),
      source: deepClone(manifest.source || {}),
      marketplace: deepClone(manifest.marketplace || {}),
      trust: {
        score: 0,
        flagged: false,
        recommendCount: 0,
        installCount: 0
      },
      audit: []
    };
  }

  async loadState() {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid plugin registry state');
      this.state = {
        version: Number(parsed.version) || STATE_VERSION,
        plugins: parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {}
      };
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.logger.warn('[PluginSupervisor] Failed to read plugin state, resetting', error?.message || error);
      }
      this.state = {
        version: STATE_VERSION,
        plugins: {}
      };
      await this.saveState();
    }
  }

  async saveState() {
    await fs.mkdir(this.pluginsRoot, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getPlugin(pluginId) {
    const normalizedPluginId = sanitizePluginId(pluginId);
    if (!normalizedPluginId) return null;
    return this.state.plugins[normalizedPluginId] || null;
  }

  getPluginInstallDir(pluginId, version) {
    return path.join(this.pluginsRoot, pluginId, version);
  }

  getRequiredPermissionForWorkerCommand(commandType) {
    return PLUGIN_WORKER_COMMAND_PERMISSION_MAP[asString(commandType)] || null;
  }

  authorizePluginWorkerCommand({
    pluginId,
    commandType,
    sourceType = 'plugin'
  } = {}) {
    const normalizedSourceType = normalizeSourceType(sourceType);
    if (normalizedSourceType !== 'plugin') {
      return { success: false, error: `Invalid sourceType for plugin authorization: ${normalizedSourceType}` };
    }

    const requiredPermission = this.getRequiredPermissionForWorkerCommand(commandType);
    if (!requiredPermission) {
      return {
        success: false,
        error: `Plugin command is not allowlisted: ${asString(commandType) || '<unknown>'}`
      };
    }

    const normalizedPluginId = sanitizePluginId(pluginId);
    if (!normalizedPluginId) {
      return { success: false, error: 'pluginId is required for plugin-origin worker commands' };
    }

    const plugin = this.getPlugin(normalizedPluginId);
    if (!plugin) {
      return { success: false, error: `Plugin not found: ${normalizedPluginId}` };
    }
    if (!isApproved(plugin)) {
      this.recordAudit(plugin.id, 'worker-command-denied', {
        commandType: asString(commandType),
        reason: 'not-approved'
      }, 'warn');
      return { success: false, error: `Plugin ${plugin.id} is not approved` };
    }
    if (plugin.enabled !== true) {
      this.recordAudit(plugin.id, 'worker-command-denied', {
        commandType: asString(commandType),
        reason: 'not-enabled'
      }, 'warn');
      return { success: false, error: `Plugin ${plugin.id} is not enabled` };
    }

    const permissionSet = new Set(ensureArray(plugin.permissions).map((value) => asString(value)));
    if (!permissionSet.has(requiredPermission)) {
      this.recordAudit(plugin.id, 'worker-command-denied', {
        commandType: asString(commandType),
        reason: 'missing-permission',
        requiredPermission
      }, 'warn');
      return {
        success: false,
        error: `Plugin ${plugin.id} is missing required permission: ${requiredPermission}`
      };
    }

    return {
      success: true,
      pluginId: plugin.id,
      permissions: Array.from(permissionSet).filter(Boolean),
      requiredPermission,
      plugin: this.toPublicPlugin(plugin)
    };
  }

  async assertArchiveStat(archivePath) {
    const archive = asString(archivePath);
    if (!archive) throw new Error('archivePath is required');
    if (!isLikelyPluginArchive(archive)) {
      throw new Error('Plugin archive must end with .htplugin.tgz or .tgz');
    }
    let stats = null;
    try {
      stats = await fs.stat(archive);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`Plugin archive not found: ${archive}`);
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw new Error('Plugin archive must be a file');
    }
    if (stats.size <= 0) {
      throw new Error('Plugin archive is empty');
    }
    if (stats.size > MAX_ARCHIVE_SIZE_BYTES) {
      throw new Error(`Plugin archive exceeds ${MAX_ARCHIVE_SIZE_BYTES} bytes`);
    }
    return {
      archivePath: archive,
      sizeBytes: stats.size
    };
  }

  async listArchiveEntries(archivePath) {
    try {
      const { stdout } = await execFileAsync(
        'tar',
        ['-tzf', archivePath],
        {
          timeout: ARCHIVE_LIST_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024
        }
      );
      return String(stdout)
        .split(/\r?\n/)
        .map((line) => normalizeArchiveEntryPath(line))
        .filter(Boolean);
    } catch (error) {
      throw new Error(`Failed to inspect plugin archive entries: ${error?.message || error}`);
    }
  }

  assertArchiveEntriesSafe(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('Plugin archive does not contain any files');
    }
    if (entries.length > MAX_ARCHIVE_ENTRY_COUNT) {
      throw new Error(`Plugin archive exceeds ${MAX_ARCHIVE_ENTRY_COUNT} entries`);
    }
    for (const entryPath of entries) {
      assertArchiveRelativePath(entryPath, `Archive entry "${entryPath}"`);
    }
  }

  async assertArchiveEntryTypesSafe(archivePath) {
    try {
      const { stdout } = await execFileAsync(
        'tar',
        ['-tvzf', archivePath],
        {
          timeout: ARCHIVE_LIST_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024
        }
      );
      const lines = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        const entryType = line[0];
        if (DISALLOWED_ARCHIVE_ENTRY_TYPES.has(entryType)) {
          throw new Error(`Archive contains unsupported entry type "${entryType}"`);
        }
      }
    } catch (error) {
      throw new Error(`Failed to inspect plugin archive entry types: ${error?.message || error}`);
    }
  }

  async assertInsideDirectory(targetPath, parentDirectory, label) {
    const resolvedTarget = await fs.realpath(targetPath);
    const resolvedParent = await fs.realpath(parentDirectory);
    if (resolvedTarget !== resolvedParent && !resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)) {
      throw new Error(`${label} is outside archive extraction directory`);
    }
  }

  async scanDirectorySafety(rootDir, {
    maxFileCount = MAX_EXTRACTED_FILE_COUNT,
    maxTotalBytes = MAX_EXTRACTED_TOTAL_BYTES,
    maxSingleFileBytes = MAX_SINGLE_FILE_BYTES
  } = {}) {
    const summary = {
      fileCount: 0,
      totalBytes: 0
    };

    const stack = [''];
    while (stack.length) {
      const relativeDir = stack.pop();
      const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
      const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
      for (const entry of entries) {
        const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const normalizedRelative = assertArchiveRelativePath(childRelative, `Extracted entry "${childRelative}"`);
        const absolutePath = path.join(rootDir, normalizedRelative);
        const stats = await fs.lstat(absolutePath);

        if (stats.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed in plugin archives (${normalizedRelative})`);
        }
        if (stats.isDirectory()) {
          stack.push(normalizedRelative);
          continue;
        }
        if (!stats.isFile()) {
          throw new Error(`Unsupported file type in archive (${normalizedRelative})`);
        }

        summary.fileCount += 1;
        if (summary.fileCount > maxFileCount) {
          throw new Error(`Plugin archive exceeds ${maxFileCount} extracted files`);
        }
        if (stats.size > maxSingleFileBytes) {
          throw new Error(`Extracted file exceeds ${maxSingleFileBytes} bytes (${normalizedRelative})`);
        }
        summary.totalBytes += stats.size;
        if (summary.totalBytes > maxTotalBytes) {
          throw new Error(`Plugin archive exceeds ${maxTotalBytes} extracted bytes`);
        }
      }
    }

    return summary;
  }

  async extractArchiveToTemp(archivePath) {
    const archive = asString(archivePath);
    if (!archive) throw new Error('archivePath is required');

    const tmpRoot = path.join(this.pluginsRoot, '.tmp');
    await fs.mkdir(tmpRoot, { recursive: true });
    const extractionDir = await fs.mkdtemp(path.join(tmpRoot, 'archive-'));
    try {
      await execFileAsync(
        'tar',
        ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extractionDir],
        {
          timeout: ARCHIVE_INSTALL_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024
        }
      );
    } catch (error) {
      throw new Error(`Failed to extract plugin archive: ${error?.message || error}`);
    }
    return extractionDir;
  }

  async findManifestInDirectory(directoryPath) {
    const rootManifest = path.join(directoryPath, 'manifest.json');
    if (await pathExists(rootManifest)) {
      return {
        manifestPath: rootManifest,
        packageRoot: directoryPath
      };
    }

    const queue = [{ dir: directoryPath, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (depth > 3) continue;
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'manifest.json') {
          return {
            manifestPath: fullPath,
            packageRoot: dir
          };
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }

    return null;
  }

  async computeBundleDigest(manifest, packageRoot) {
    const runnerEntrypoint = asString(manifest?.entrypoints?.runner);
    if (runnerEntrypoint) {
      const normalizedEntrypoint = assertArchiveRelativePath(
        runnerEntrypoint,
        'Manifest entrypoints.runner'
      );
      const entrypointPath = path.join(packageRoot, normalizedEntrypoint);
      if (!(await pathExists(entrypointPath))) {
        throw new Error(`Manifest entrypoint not found in package: ${normalizedEntrypoint}`);
      }
      const stats = await fs.stat(entrypointPath);
      if (!stats.isFile()) {
        throw new Error(`Manifest entrypoint must reference a file: ${normalizedEntrypoint}`);
      }
      if (stats.size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`Manifest entrypoint exceeds ${MAX_SINGLE_FILE_BYTES} bytes`);
      }
      return {
        bundleSha256: await sha256ForFile(entrypointPath),
        bundleTarget: normalizedEntrypoint,
        bundleMode: 'entrypoint-file'
      };
    }

    const distDirectory = path.join(packageRoot, 'dist');
    if (!(await pathExists(distDirectory))) {
      throw new Error('Plugin archive must include entrypoints.runner or a dist/ directory');
    }
    await this.scanDirectorySafety(distDirectory);
    return {
      bundleSha256: await sha256ForDirectory(distDirectory),
      bundleTarget: 'dist/',
      bundleMode: 'dist-directory'
    };
  }

  validateManifestIntegrity({ manifest, bundleSha256, sourceSha256, hasSourceDir }) {
    const declaredBundleSha256 = asString(manifest?.integrity?.bundleSha256).toLowerCase();
    const declaredSourceSha256 = asString(manifest?.integrity?.sourceSha256).toLowerCase();

    if (!isValidSha256Hex(declaredBundleSha256)) {
      throw new Error('Manifest integrity.bundleSha256 must be a 64-character sha256 hex string');
    }
    if (declaredBundleSha256 !== bundleSha256) {
      throw new Error('Manifest integrity.bundleSha256 does not match bundle hash');
    }

    if (hasSourceDir) {
      if (!isValidSha256Hex(declaredSourceSha256)) {
        throw new Error('Manifest integrity.sourceSha256 must be provided when src/ is present');
      }
      if (declaredSourceSha256 !== sourceSha256) {
        throw new Error('Manifest integrity.sourceSha256 does not match src/ content hash');
      }
    } else if (declaredSourceSha256 && !isValidSha256Hex(declaredSourceSha256)) {
      throw new Error('Manifest integrity.sourceSha256 must be a 64-character sha256 hex string');
    }

    return {
      bundleSha256,
      sourceSha256: hasSourceDir ? sourceSha256 : declaredSourceSha256,
      declaredBundleSha256,
      declaredSourceSha256,
      verified: {
        bundleSha256: true,
        sourceSha256: true
      }
    };
  }

  async writeManifestToDisk(plugin) {
    if (!plugin) return;
    const pluginDir = path.join(this.pluginsRoot, plugin.id, plugin.version);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'manifest.json'),
      JSON.stringify({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        engines: plugin.engines,
        entrypoints: plugin.entrypoints,
        permissions: plugin.permissions,
        contributions: plugin.contributions,
        integrity: plugin.integrity,
        source: plugin.source,
        marketplace: plugin.marketplace
      }, null, 2),
      'utf8'
    );
  }

  recordAudit(pluginId, action, details = {}, level = 'info') {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return;
    const entry = {
      ts: now(),
      action,
      level,
      details: deepClone(details)
    };
    plugin.audit = ensureArray(plugin.audit);
    plugin.audit.push(entry);
    if (plugin.audit.length > MAX_AUDIT_ENTRIES) {
      plugin.audit = plugin.audit.slice(-MAX_AUDIT_ENTRIES);
    }
    plugin.updatedAt = now();
  }

  emitPluginStateEvent(pluginId, eventType, payload = {}) {
    if (!this.rendererEmitter || !pluginId || !eventType) return;
    this.rendererEmitter('plugin-event', {
      pluginId,
      eventType,
      payload: deepClone(payload)
    });
  }

  toPublicPlugin(plugin) {
    if (!plugin) return null;
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      tier: plugin.tier,
      status: plugin.status,
      enabled: plugin.enabled,
      approvedVersion: plugin.approvedVersion,
      rejectedVersion: plugin.rejectedVersion || null,
      rejectedAt: plugin.rejectedAt || null,
      permissions: deepClone(plugin.permissions),
      contributions: deepClone(plugin.contributions),
      engines: deepClone(plugin.engines),
      integrity: deepClone(plugin.integrity),
      source: deepClone(plugin.source),
      marketplace: deepClone(plugin.marketplace),
      trust: deepClone(plugin.trust),
      installedAt: plugin.installedAt,
      discoveredAt: plugin.discoveredAt,
      updatedAt: plugin.updatedAt
    };
  }

  listPlugins() {
    return Object.values(this.state.plugins)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
      .map((plugin) => this.toPublicPlugin(plugin));
  }

  getUiContributions() {
    const routeMap = new Map();
    const navItems = [];
    const activePlugins = [];
    const collisions = [];
    const blockedContributions = [];

    const recordBlockedContribution = ({
      plugin,
      contributionType,
      contributionId = null,
      path = null,
      reason,
      requiredPermission = null,
      conflictWith = null
    }) => {
      if (!plugin || !reason) return;
      blockedContributions.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        version: plugin.version,
        tier: plugin.tier,
        contributionType,
        contributionId: contributionId || null,
        path: path || null,
        reason,
        requiredPermission: requiredPermission || null,
        conflictWith: conflictWith || null
      });
    };

    for (const plugin of Object.values(this.state.plugins)) {
      const approved = isApproved(plugin);
      const enabled = plugin?.enabled === true;
      const active = approved && enabled;
      if (active) {
        activePlugins.push(this.toPublicPlugin(plugin));
      }

      const permissions = new Set(
        ensureArray(plugin.permissions).map((value) => asString(value)).filter(Boolean)
      );
      const hasRoutePermission = permissions.has('renderer.route');
      const hasNavPermission = permissions.has('renderer.nav');

      for (const route of ensureArray(plugin?.contributions?.routes)) {
        const routeId = asString(route?.id) || null;
        const routePath = asString(route?.path) || null;
        if (!active) {
          recordBlockedContribution({
            plugin,
            contributionType: 'route',
            contributionId: routeId,
            path: routePath,
            reason: approved ? 'plugin-not-enabled' : 'plugin-not-approved'
          });
          continue;
        }
        if (!hasRoutePermission) {
          recordBlockedContribution({
            plugin,
            contributionType: 'route',
            contributionId: routeId,
            path: routePath,
            reason: 'missing-permission',
            requiredPermission: 'renderer.route'
          });
          continue;
        }
        if (!routePath) {
          recordBlockedContribution({
            plugin,
            contributionType: 'route',
            contributionId: routeId,
            path: routePath,
            reason: 'invalid-route-path'
          });
          continue;
        }
        if (!isRouteScopedToPlugin(routePath, plugin.id)) {
          recordBlockedContribution({
            plugin,
            contributionType: 'route',
            contributionId: routeId,
            path: routePath,
            reason: 'invalid-route-namespace'
          });
          continue;
        }
        if (routeMap.has(routePath)) {
          const conflictWith = routeMap.get(routePath).pluginId;
          collisions.push({
            path: routePath,
            pluginId: plugin.id,
            conflictWith
          });
          recordBlockedContribution({
            plugin,
            contributionType: 'route',
            contributionId: routeId,
            path: routePath,
            reason: 'route-collision',
            conflictWith
          });
          continue;
        }

        routeMap.set(routePath, {
          pluginId: plugin.id,
          pluginName: plugin.name,
          version: plugin.version,
          tier: plugin.tier,
          permission: 'renderer.route',
          ...deepClone(route),
          path: routePath
        });
      }

      for (const navItem of ensureArray(plugin?.contributions?.navItems)) {
        const navItemId = asString(navItem?.id) || null;
        const routePath = asString(navItem?.routePath) || null;
        if (!active) {
          recordBlockedContribution({
            plugin,
            contributionType: 'nav-item',
            contributionId: navItemId,
            path: routePath,
            reason: approved ? 'plugin-not-enabled' : 'plugin-not-approved'
          });
          continue;
        }
        if (!hasNavPermission) {
          recordBlockedContribution({
            plugin,
            contributionType: 'nav-item',
            contributionId: navItemId,
            path: routePath,
            reason: 'missing-permission',
            requiredPermission: 'renderer.nav'
          });
          continue;
        }
        if (!navItemId) {
          recordBlockedContribution({
            plugin,
            contributionType: 'nav-item',
            contributionId: navItemId,
            path: routePath,
            reason: 'invalid-nav-id'
          });
          continue;
        }
        if (!routePath) {
          recordBlockedContribution({
            plugin,
            contributionType: 'nav-item',
            contributionId: navItemId,
            path: routePath,
            reason: 'invalid-nav-route'
          });
          continue;
        }
        if (!isRouteScopedToPlugin(routePath, plugin.id)) {
          recordBlockedContribution({
            plugin,
            contributionType: 'nav-item',
            contributionId: navItemId,
            path: routePath,
            reason: 'invalid-nav-namespace'
          });
          continue;
        }

        navItems.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          version: plugin.version,
          tier: plugin.tier,
          permission: 'renderer.nav',
          ...deepClone(navItem),
          id: navItemId,
          routePath
        });
      }
    }

    navItems.sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100));
    blockedContributions.sort((a, b) => {
      const pluginA = `${a.pluginName || a.pluginId || ''}`.toLowerCase();
      const pluginB = `${b.pluginName || b.pluginId || ''}`.toLowerCase();
      if (pluginA !== pluginB) return pluginA.localeCompare(pluginB);
      const typeA = asString(a.contributionType);
      const typeB = asString(b.contributionType);
      if (typeA !== typeB) return typeA.localeCompare(typeB);
      const idA = `${asString(a.contributionId)}${asString(a.path)}`.toLowerCase();
      const idB = `${asString(b.contributionId)}${asString(b.path)}`.toLowerCase();
      return idA.localeCompare(idB);
    });

    return {
      plugins: activePlugins,
      routes: Array.from(routeMap.values()),
      navItems,
      collisions,
      blockedContributions
    };
  }

  applyMarketplaceSignals(plugin, payload = {}) {
    const social = payload && typeof payload === 'object'
      ? (payload.social && typeof payload.social === 'object' ? payload.social : payload)
      : {};
    const recommendCount = Number(social.recommendCount);
    const installCount = Number(social.installCount);
    const flagCount = Number(social.flagCount);
    const score = Number(social.score);

    plugin.trust = plugin.trust && typeof plugin.trust === 'object'
      ? plugin.trust
      : { score: 0, flagged: false, recommendCount: 0, installCount: 0 };

    if (Number.isFinite(recommendCount)) plugin.trust.recommendCount = Math.max(0, recommendCount);
    if (Number.isFinite(installCount)) plugin.trust.installCount = Math.max(0, installCount);
    if (Number.isFinite(score)) {
      plugin.trust.score = score;
    } else {
      plugin.trust.score = (plugin.trust.recommendCount || 0) + (plugin.trust.installCount || 0) - (Number.isFinite(flagCount) ? flagCount : 0);
    }
    if (Number.isFinite(flagCount)) {
      plugin.trust.flagCount = Math.max(0, flagCount);
      plugin.trust.flagged = flagCount > 0;
    }
  }

  async discoverFromMarketplaceListings({ listings = [], source = 'nostr-marketplace' } = {}) {
    const normalizedListings = ensureArray(listings).slice(0, MAX_LISTINGS_PER_DISCOVERY);
    const discovered = [];
    const skipped = [];

    for (const listing of normalizedListings) {
      const manifest = listing && typeof listing === 'object'
        ? (listing.manifest && typeof listing.manifest === 'object' ? listing.manifest : null)
        : null;
      if (!manifest) {
        skipped.push({
          reason: 'missing-manifest',
          listing
        });
        continue;
      }
      const marketplaceEntry = listing?.metadata && typeof listing.metadata === 'object'
        ? listing.metadata
        : null;
      const response = await this.discoverPlugin({
        manifest,
        source,
        marketplace: marketplaceEntry,
        social: listing?.metadata?.social || listing?.social || null
      });
      if (response.success) {
        discovered.push(response.plugin);
      } else {
        skipped.push({
          reason: response.error || 'discover-failed',
          manifestId: manifest?.id || null
        });
      }
    }

    return {
      success: true,
      discovered,
      skipped,
      totalListings: normalizedListings.length
    };
  }

  async discoverPlugin(payload = {}) {
    const validation = await this.validateManifest(payload.manifest || payload);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; '), errors: validation.errors };
    }

    const manifest = validation.manifest;
    let plugin = this.getPlugin(manifest.id);
    const previousVersion = plugin?.version || null;
    if (!plugin) {
      plugin = this.normalizePluginRecord(manifest, 'discover');
      this.state.plugins[plugin.id] = plugin;
    } else {
      plugin.name = manifest.name;
      plugin.version = manifest.version;
      plugin.engines = deepClone(manifest.engines);
      plugin.entrypoints = deepClone(manifest.entrypoints);
      plugin.permissions = deepClone(manifest.permissions);
      plugin.contributions = deepClone(manifest.contributions);
      plugin.integrity = deepClone(manifest.integrity);
      plugin.source = deepClone(manifest.source);
      plugin.marketplace = deepClone(manifest.marketplace);
      plugin.updatedAt = now();
      if (!plugin.discoveredAt) plugin.discoveredAt = now();
      if (previousVersion && previousVersion !== manifest.version) {
        plugin.approvedVersion = null;
        plugin.approvedAt = null;
        plugin.rejectedVersion = null;
        plugin.rejectedAt = null;
      }
    }

    if (payload?.marketplace && typeof payload.marketplace === 'object') {
      plugin.marketplace = {
        ...(plugin.marketplace && typeof plugin.marketplace === 'object' ? plugin.marketplace : {}),
        ...deepClone(payload.marketplace)
      };
    }
    this.applyMarketplaceSignals(plugin, payload?.social || null);

    this.recordAudit(plugin.id, 'discover', {
      source: payload.source || 'unknown',
      version: plugin.version
    });
    await this.saveState();
    this.emitPluginStateEvent(plugin.id, 'plugin-discovered', {
      source: payload.source || 'unknown',
      version: plugin.version
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async installPlugin(payload = {}) {
    const validation = await this.validateManifest(payload.manifest || payload);
    if (!validation.valid) {
      return { success: false, error: validation.errors.join('; '), errors: validation.errors };
    }

    const manifest = validation.manifest;
    let plugin = this.getPlugin(manifest.id);
    const installedAt = now();
    if (!plugin) {
      plugin = this.normalizePluginRecord(manifest, 'install');
      this.state.plugins[plugin.id] = plugin;
    } else {
      const previousVersion = plugin.version;
      plugin.name = manifest.name;
      plugin.version = manifest.version;
      plugin.permissions = deepClone(manifest.permissions);
      plugin.contributions = deepClone(manifest.contributions);
      plugin.engines = deepClone(manifest.engines);
      plugin.entrypoints = deepClone(manifest.entrypoints);
      plugin.integrity = deepClone(manifest.integrity);
      plugin.source = deepClone(manifest.source);
      plugin.marketplace = deepClone(manifest.marketplace);
      plugin.status = 'installed';
      plugin.enabled = false;
      plugin.installedAt = installedAt;
      plugin.updatedAt = installedAt;
      plugin.rejectedVersion = null;
      plugin.rejectedAt = null;
      if (previousVersion !== plugin.version) {
        plugin.approvedVersion = null;
        plugin.approvedAt = null;
      }
    }

    await this.writeManifestToDisk(plugin);
    this.recordAudit(plugin.id, 'install', {
      version: plugin.version
    });
    await this.saveState();
    await this.syncRunners();
    this.emitPluginStateEvent(plugin.id, 'plugin-installed', {
      version: plugin.version
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async prepareArchivePackage(payload = {}) {
    const archivePath = typeof payload === 'string' ? payload : payload?.archivePath;
    const archiveInfo = await this.assertArchiveStat(archivePath);
    const archiveEntries = await this.listArchiveEntries(archiveInfo.archivePath);
    this.assertArchiveEntriesSafe(archiveEntries);
    await this.assertArchiveEntryTypesSafe(archiveInfo.archivePath);

    const extractionDir = await this.extractArchiveToTemp(archiveInfo.archivePath);
    await this.scanDirectorySafety(extractionDir);
    const manifestLocation = await this.findManifestInDirectory(extractionDir);
    if (!manifestLocation) {
      throw new Error('Plugin archive does not contain manifest.json');
    }

    await this.assertInsideDirectory(manifestLocation.manifestPath, extractionDir, 'Manifest path');
    await this.assertInsideDirectory(manifestLocation.packageRoot, extractionDir, 'Plugin package root');

    const manifestStats = await fs.stat(manifestLocation.manifestPath);
    if (manifestStats.size > MAX_MANIFEST_BYTES) {
      throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }

    let manifestPayload = null;
    try {
      const manifestRaw = await fs.readFile(manifestLocation.manifestPath, 'utf8');
      manifestPayload = JSON.parse(manifestRaw);
    } catch (error) {
      throw new Error(`Failed to parse plugin manifest: ${error?.message || error}`);
    }
    if (!manifestPayload || typeof manifestPayload !== 'object') {
      throw new Error('Plugin archive manifest is invalid');
    }

    const validation = await this.validateManifest(manifestPayload);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
    const manifest = validation.manifest;

    const packageScan = await this.scanDirectorySafety(manifestLocation.packageRoot);
    const srcDir = path.join(manifestLocation.packageRoot, 'src');
    const hasSourceDir = await pathExists(srcDir);
    const sourceSha256 = hasSourceDir ? await sha256ForDirectory(srcDir) : '';
    const bundleDigest = await this.computeBundleDigest(manifest, manifestLocation.packageRoot);
    const archiveSha256 = await sha256ForFile(archiveInfo.archivePath);
    const integrity = this.validateManifestIntegrity({
      manifest,
      bundleSha256: bundleDigest.bundleSha256,
      sourceSha256,
      hasSourceDir
    });

    manifest.integrity = {
      ...(manifest.integrity && typeof manifest.integrity === 'object' ? manifest.integrity : {}),
      bundleSha256: integrity.bundleSha256,
      sourceSha256: integrity.sourceSha256
    };

    return {
      archivePath: archiveInfo.archivePath,
      archiveSizeBytes: archiveInfo.sizeBytes,
      archiveEntryCount: archiveEntries.length,
      archiveSha256,
      bundleSha256: bundleDigest.bundleSha256,
      bundleTarget: bundleDigest.bundleTarget,
      bundleMode: bundleDigest.bundleMode,
      extractionDir,
      manifest,
      manifestPath: manifestLocation.manifestPath,
      packageRoot: manifestLocation.packageRoot,
      packageScan,
      sourceSha256: integrity.sourceSha256,
      hasSourceDir,
      integrity
    };
  }

  async previewPluginArchive(payload = {}) {
    let prepared = null;
    try {
      prepared = await this.prepareArchivePackage(payload);
      return {
        success: true,
        archive: {
          path: prepared.archivePath,
          sizeBytes: prepared.archiveSizeBytes,
          entryCount: prepared.archiveEntryCount,
          sha256: prepared.archiveSha256
        },
        manifest: deepClone(prepared.manifest),
        packageStats: deepClone(prepared.packageScan),
        integrity: {
          computedBundleSha256: prepared.bundleSha256,
          computedSourceSha256: prepared.sourceSha256,
          declaredBundleSha256: prepared.integrity.declaredBundleSha256,
          declaredSourceSha256: prepared.integrity.declaredSourceSha256,
          sourceDirectoryPresent: prepared.hasSourceDir,
          bundleTarget: prepared.bundleTarget,
          bundleMode: prepared.bundleMode
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error)
      };
    } finally {
      if (prepared?.extractionDir) {
        await fs.rm(prepared.extractionDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async installPluginArchive(payload = {}) {
    const sourceLabel = asString(payload?.source || 'local-archive');
    let prepared = null;
    try {
      prepared = await this.prepareArchivePackage(payload);
      const manifest = prepared.manifest;

      const installResponse = await this.installPlugin({
        manifest
      });
      if (!installResponse.success) {
        return installResponse;
      }

      const installDir = this.getPluginInstallDir(manifest.id, manifest.version);
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.mkdir(installDir, { recursive: true });
      await fs.cp(prepared.packageRoot, installDir, { recursive: true, force: true });

      const plugin = this.getPlugin(manifest.id);
      if (plugin) {
        plugin.integrity = {
          ...(plugin.integrity && typeof plugin.integrity === 'object' ? plugin.integrity : {}),
          bundleSha256: prepared.bundleSha256,
          sourceSha256: prepared.sourceSha256
        };
        plugin.source = {
          ...(plugin.source && typeof plugin.source === 'object' ? plugin.source : {}),
          archivePath: prepared.archivePath,
          archiveSha256: prepared.archiveSha256
        };
      }

      this.recordAudit(manifest.id, 'install-archive', {
        source: sourceLabel,
        archivePath: prepared.archivePath,
        archiveSha256: prepared.archiveSha256,
        archiveEntryCount: prepared.archiveEntryCount,
        archiveSizeBytes: prepared.archiveSizeBytes,
        bundleSha256: prepared.bundleSha256,
        bundleTarget: prepared.bundleTarget
      });
      await this.saveState();
      await this.syncRunners();
      this.emitPluginStateEvent(manifest.id, 'plugin-archive-installed', {
        version: manifest.version,
        archivePath: prepared.archivePath
      });
      return {
        success: true,
        plugin: this.toPublicPlugin(this.getPlugin(manifest.id))
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error)
      };
    } finally {
      if (prepared?.extractionDir) {
        await fs.rm(prepared.extractionDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async approveVersion({ pluginId, version } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    if (version && asString(version) !== plugin.version) {
      return {
        success: false,
        error: `Cannot approve ${version}; installed version is ${plugin.version}`
      };
    }

    plugin.approvedVersion = plugin.version;
    plugin.approvedAt = now();
    plugin.rejectedVersion = null;
    plugin.rejectedAt = null;
    plugin.status = plugin.enabled ? 'enabled' : 'approved';
    this.recordAudit(plugin.id, 'approve-version', {
      version: plugin.version
    });
    await this.saveState();
    this.emitPluginStateEvent(plugin.id, 'plugin-approved', {
      version: plugin.version
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async rejectVersion({ pluginId, version, reason } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    if (version && asString(version) !== plugin.version) {
      return {
        success: false,
        error: `Cannot reject ${version}; installed version is ${plugin.version}`
      };
    }

    plugin.enabled = false;
    if (plugin.approvedVersion === plugin.version) {
      plugin.approvedVersion = null;
      plugin.approvedAt = null;
    }
    plugin.rejectedVersion = plugin.version;
    plugin.rejectedAt = now();
    plugin.status = 'blocked';
    plugin.updatedAt = now();
    this.recordAudit(plugin.id, 'reject-version', {
      version: plugin.version,
      reason: asString(reason)
    }, 'warn');
    await this.saveState();
    await this.syncRunners();
    this.emitPluginStateEvent(plugin.id, 'plugin-rejected', {
      version: plugin.version,
      reason: asString(reason)
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async elevateTier({ pluginId, tier } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    const normalizedTier = asString(tier).toLowerCase();
    if (!['restricted', 'elevated'].includes(normalizedTier)) {
      return { success: false, error: 'Tier must be restricted or elevated' };
    }
    plugin.tier = normalizedTier;
    plugin.updatedAt = now();
    this.recordAudit(plugin.id, 'set-tier', { tier: normalizedTier });
    await this.saveState();
    this.emitPluginStateEvent(plugin.id, 'plugin-tier-updated', { tier: normalizedTier });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async enablePlugin({ pluginId } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    if (!isApproved(plugin)) {
      return { success: false, error: 'Plugin version must be approved before enabling' };
    }
    plugin.enabled = true;
    plugin.status = 'enabled';
    plugin.updatedAt = now();
    this.recordAudit(plugin.id, 'enable');
    await this.saveState();
    await this.syncRunners();
    this.emitPluginStateEvent(plugin.id, 'plugin-enabled', {
      version: plugin.version
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async disablePlugin({ pluginId } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    plugin.enabled = false;
    plugin.status = 'disabled';
    plugin.updatedAt = now();
    this.recordAudit(plugin.id, 'disable');
    await this.saveState();
    await this.syncRunners();
    this.emitPluginStateEvent(plugin.id, 'plugin-disabled', {
      version: plugin.version
    });
    return { success: true, plugin: this.toPublicPlugin(plugin) };
  }

  async uninstallPlugin({ pluginId } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    const removed = { id: plugin.id, version: plugin.version };
    await this.stopRunner(plugin.id);
    delete this.state.plugins[plugin.id];
    await this.saveState();
    this.emitPluginStateEvent(removed.id, 'plugin-uninstalled', {
      version: removed.version
    });
    return { success: true };
  }

  getAudit(pluginId, limit = 200) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    const entries = ensureArray(plugin.audit).slice(-Math.max(1, Number(limit) || 200));
    return { success: true, entries: deepClone(entries) };
  }

  async startRunner(plugin) {
    if (!plugin || this.pluginRunners.has(plugin.id)) return { success: true, alreadyRunning: true };
    if (!existsSync(this.runnerPath)) {
      this.recordAudit(plugin.id, 'runner-skip', { reason: 'missing-runner' }, 'warn');
      return { success: false, error: 'plugin-runner.cjs not found' };
    }

    const pluginDir = path.join(this.pluginsRoot, plugin.id, plugin.version);
    const entrypoint = asString(plugin?.entrypoints?.runner);
    const entryPath = entrypoint ? path.join(pluginDir, entrypoint) : '';
    if (!entrypoint || !existsSync(entryPath)) {
      this.recordAudit(plugin.id, 'runner-skip', { reason: 'missing-entrypoint', entrypoint }, 'warn');
      return { success: true, skipped: true };
    }

    const child = spawn(process.execPath, [this.runnerPath], {
      cwd: pluginDir,
      env: {
        ...process.env,
        PLUGIN_ID: plugin.id,
        PLUGIN_VERSION: plugin.version,
        PLUGIN_ENTRYPOINT_PATH: entryPath
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    const runnerState = {
      child,
      startedAt: now(),
      invokeWindowStartedAt: now(),
      invokeCount: 0,
      pending: new Map()
    };
    this.pluginRunners.set(plugin.id, runnerState);

    child.on('message', (message) => {
      this.handleRunnerMessage(plugin.id, message);
    });

    child.on('error', (error) => {
      this.recordAudit(plugin.id, 'runner-error', { error: error?.message || String(error) }, 'error');
    });

    child.on('exit', (code, signal) => {
      const pending = Array.from(runnerState.pending.values());
      runnerState.pending.clear();
      for (const entry of pending) {
        clearTimeout(entry.timeoutId);
        entry.resolve({ success: false, error: `Runner exited (${code ?? signal ?? 'unknown'})` });
      }
      this.pluginRunners.delete(plugin.id);
      this.recordAudit(plugin.id, 'runner-exit', { code, signal }, code === 0 ? 'info' : 'warn');
    });

    if (child.stdout) {
      child.stdout.on('data', (buf) => {
        this.recordAudit(plugin.id, 'runner-stdout', { data: String(buf) });
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (buf) => {
        this.recordAudit(plugin.id, 'runner-stderr', { data: String(buf) }, 'warn');
      });
    }

    return { success: true };
  }

  async stopRunner(pluginId) {
    const runner = this.pluginRunners.get(pluginId);
    if (!runner) return { success: true, alreadyStopped: true };
    const child = runner.child;
    this.pluginRunners.delete(pluginId);

    const pending = Array.from(runner.pending.values());
    runner.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timeoutId);
      entry.resolve({ success: false, error: 'Plugin runner stopped' });
    }

    if (!child || child.killed) return { success: true };
    try {
      child.send({ type: 'plugin-runner-stop' });
    } catch (_) {}

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
    }, 1500);

    await new Promise((resolve) => {
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    return { success: true };
  }

  async syncRunners() {
    const desired = new Set();
    for (const plugin of Object.values(this.state.plugins)) {
      if (!isEnabled(plugin)) continue;
      desired.add(plugin.id);
      await this.startRunner(plugin);
    }

    for (const [pluginId] of this.pluginRunners.entries()) {
      if (!desired.has(pluginId)) {
        await this.stopRunner(pluginId);
      }
    }
  }

  handleRunnerMessage(pluginId, message) {
    if (!message || typeof message !== 'object') return;
    const runner = this.pluginRunners.get(pluginId);

    if (message.type === 'plugin-runner-response') {
      const requestId = asString(message.requestId);
      if (!runner || !requestId) return;
      const pending = runner.pending.get(requestId);
      if (!pending) return;
      runner.pending.delete(requestId);
      clearTimeout(pending.timeoutId);
      pending.resolve({
        success: message.success !== false,
        data: message.data ?? null,
        error: message.error || null
      });
      return;
    }

    if (message.type === 'plugin-event') {
      this.recordAudit(pluginId, 'runner-event', {
        eventType: message.eventType || null,
        payload: message.payload || null
      });
      if (this.rendererEmitter) {
        this.rendererEmitter('plugin-event', {
          pluginId,
          eventType: message.eventType || null,
          payload: message.payload || null
        });
      }
      return;
    }

    if (message.type === 'plugin-runner-status') {
      this.recordAudit(pluginId, 'runner-status', {
        phase: message.phase || null,
        hasEntrypoint: message.hasEntrypoint === true,
        error: message.error || null
      });
    }
  }

  assertInvokeRateLimit(pluginId) {
    const runner = this.pluginRunners.get(pluginId);
    if (!runner) return;
    const nowTs = now();
    if (nowTs - runner.invokeWindowStartedAt >= 60_000) {
      runner.invokeWindowStartedAt = nowTs;
      runner.invokeCount = 0;
    }
    runner.invokeCount += 1;
    if (runner.invokeCount > INVOKE_RATE_LIMIT_PER_MINUTE) {
      throw new Error(`Plugin invoke rate limit exceeded (${INVOKE_RATE_LIMIT_PER_MINUTE}/min)`);
    }
  }

  async invokePlugin({ pluginId, payload = null, timeoutMs = INVOKE_TIMEOUT_MS } = {}) {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return { success: false, error: 'Plugin not found' };
    if (!isEnabled(plugin)) return { success: false, error: 'Plugin is not enabled/approved' };

    const runner = this.pluginRunners.get(plugin.id);
    if (!runner || !runner.child) {
      return { success: false, error: 'Plugin runner is not active' };
    }

    try {
      this.assertInvokeRateLimit(plugin.id);
    } catch (error) {
      return { success: false, error: error.message };
    }

    const requestId = createRequestId();
    const safeTimeoutMs = Math.max(1000, Math.min(Number(timeoutMs) || INVOKE_TIMEOUT_MS, 120_000));
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        runner.pending.delete(requestId);
        resolve({ success: false, error: `Plugin invoke timeout after ${safeTimeoutMs}ms` });
      }, safeTimeoutMs);

      runner.pending.set(requestId, { resolve, timeoutId });
      try {
        runner.child.send({
          type: 'plugin-runner-invoke',
          requestId,
          payload
        });
      } catch (error) {
        clearTimeout(timeoutId);
        runner.pending.delete(requestId);
        resolve({ success: false, error: error?.message || String(error) });
      }
    });
  }

  async stopAll() {
    const ids = Array.from(this.pluginRunners.keys());
    for (const pluginId of ids) {
      await this.stopRunner(pluginId);
    }
  }
}

module.exports = {
  PluginSupervisor
};
