import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';

import { readEnvFile, serializeSectionedEnv, writeEnvFile } from './env-file.mjs';
import {
  DEFAULT_DISCOVERY_RELAYS,
  ENV_SECTIONS,
  PROFILE_NAMES,
  buildRuntimeConfig,
  defaultPolicyColumnForConfig,
  deriveProfile,
  summarizeConfigChanges,
  validateConfig
} from './schema.mjs';
import { buildAuthMarkdownReport, runDeepAuthValidation } from './deep-auth.mjs';

const DEFAULT_SCOPE = 'gateway:relay-register';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEPLOY_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ENV_FILE = join(DEPLOY_DIR, '.env');
const DEFAULT_ENV_DIR = join(DEPLOY_DIR, 'environments');
const COMPOSE_FILE = join(DEPLOY_DIR, 'docker-compose.yml');
const DEFAULT_SECRET_PATH = '/.well-known/hypertuna-gateway-secret';

function log(io, message) {
  io?.stdout?.write?.(`${message}\n`);
}

function logError(io, message) {
  io?.stderr?.write?.(`${message}\n`);
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveEnvFilePath(selection) {
  if (!selection) return DEFAULT_ENV_FILE;
  const value = String(selection).trim();
  if (!value) return DEFAULT_ENV_FILE;
  if (isAbsolute(value)) return value;
  if (value.includes('/') || value.endsWith('.env')) {
    return resolve(process.cwd(), value);
  }
  return join(DEFAULT_ENV_DIR, `${value}.env`);
}

export function parseCsvOption(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value || '').trim());
}

function isValidHost(value) {
  return Boolean(String(value || '').trim()) && !/[/:]/u.test(String(value || '').trim());
}

function isHex64(value) {
  return /^[0-9a-f]{64}$/iu.test(String(value || '').trim());
}

async function promptText(rl, label, defaultValue, validator, { allowEmpty = false } = {}) {
  const printableDefault = defaultValue === '' ? '' : ` [${defaultValue}]`;
  while (true) {
    const answer = (await rl.question(`${label}${printableDefault}: `)).trim();
    const resolved = answer || defaultValue || '';
    if (allowEmpty && resolved === '') return '';
    const validation = validator ? validator(resolved) : true;
    if (validation === true) return resolved;
    logError(process, typeof validation === 'string' ? validation : `Invalid value for ${label}`);
  }
}

async function promptProfile(rl, defaultProfile) {
  const fallback = PROFILE_NAMES.includes(defaultProfile) ? defaultProfile : 'open';
  log(process, 'Select deployment profile:');
  PROFILE_NAMES.forEach((profile, index) => {
    log(process, `  ${index + 1}. ${profile}${profile === fallback ? ' (default)' : ''}`);
  });
  while (true) {
    const raw = (await rl.question(`Profile [${fallback}]: `)).trim().toLowerCase();
    if (!raw) return fallback;
    const numeric = Number.parseInt(raw, 10);
    if (Number.isFinite(numeric) && PROFILE_NAMES[numeric - 1]) {
      return PROFILE_NAMES[numeric - 1];
    }
    if (PROFILE_NAMES.includes(raw)) return raw;
    logError(process, `Choose one of: ${PROFILE_NAMES.join(', ')}`);
  }
}

function validatePortString(value) {
  const num = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(num) || num <= 0 || num > 65535) {
    return 'Enter a valid port between 1 and 65535';
  }
  return true;
}

function validatePositiveInteger(value) {
  return /^\d+$/u.test(String(value || '').trim()) && Number.parseInt(String(value || '').trim(), 10) > 0
    ? true
    : 'Enter a positive integer';
}

function validateRelayList(value) {
  const items = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!items.length) return 'Provide at least one ws/wss relay URL';
  for (const item of items) {
    try {
      const parsed = new URL(item);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return 'Relay URLs must use ws:// or wss://';
      }
    } catch {
      return 'Relay URLs must be valid ws:// or wss:// URLs';
    }
  }
  return true;
}

function validatePubkeyCsv(value, { allowEmpty = false } = {}) {
  const items = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!items.length) return allowEmpty ? true : 'Provide at least one 64-character hex pubkey';
  return items.every((entry) => isHex64(entry)) ? true : 'Pubkeys must be 64-character hex strings';
}

async function collectInteractiveAnswers(existing, initialOptions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const profile = initialOptions.profile || await promptProfile(rl, existing.DEPLOY_PROFILE || existing.GATEWAY_AUTH_HOST_POLICY || 'open');
    const host = initialOptions.host || await promptText(
      rl,
      'Gateway host/domain',
      existing.GATEWAY_HOST || '',
      (value) => isValidHost(value) || 'Enter a hostname without protocol or path'
    );
    const email = initialOptions.email || await promptText(
      rl,
      'Let’s Encrypt email',
      existing.LETSENCRYPT_EMAIL || '',
      (value) => isValidEmail(value) || 'Enter a valid email address'
    );
    const displayName = initialOptions.displayName || await promptText(
      rl,
      'Discovery display name',
      existing.GATEWAY_DISCOVERY_DISPLAY_NAME || `${host} Public Gateway`,
      (value) => value.trim() ? true : 'Display name is required'
    );
    const region = initialOptions.region ?? await promptText(
      rl,
      'Discovery region (optional)',
      existing.GATEWAY_DISCOVERY_REGION || '',
      null,
      { allowEmpty: true }
    );
    const discoveryRelays = initialOptions.discoveryRelays || await promptText(
      rl,
      'Discovery relays (comma-separated ws/wss URLs)',
      existing.GATEWAY_NOSTR_DISCOVERY_RELAYS || DEFAULT_DISCOVERY_RELAYS.join(','),
      validateRelayList
    );
    const blindpeerPort = initialOptions.blindpeerPort || await promptText(
      rl,
      'Blind-peer UDP port',
      existing.GATEWAY_BLINDPEER_PORT || '31000',
      validatePortString
    );

    const answers = {
      DEPLOY_PROFILE: profile,
      GATEWAY_HOST: host,
      LETSENCRYPT_EMAIL: email,
      GATEWAY_DISCOVERY_DISPLAY_NAME: displayName,
      GATEWAY_DISCOVERY_REGION: region,
      GATEWAY_NOSTR_DISCOVERY_RELAYS: discoveryRelays,
      GATEWAY_BLINDPEER_PORT: blindpeerPort
    };

    answers.GATEWAY_AUTH_BLOCKLIST_PUBKEYS = initialOptions.blocklistPubkeys ?? await promptText(
      rl,
      'Blocklist pubkeys (optional, comma-separated 64-char hex values)',
      existing.GATEWAY_AUTH_BLOCKLIST_PUBKEYS || '',
      (value) => validatePubkeyCsv(value, { allowEmpty: true }),
      { allowEmpty: true }
    );

    if (profile === 'open') {
      answers.GATEWAY_AUTH_OPERATOR_PUBKEY = initialOptions.operatorPubkey ?? await promptText(
        rl,
        'Operator pubkey for Access Manager (optional)',
        existing.GATEWAY_AUTH_OPERATOR_PUBKEY || '',
        (value) => value === '' || isHex64(value) || 'Enter a 64-character hex pubkey or leave blank',
        { allowEmpty: true }
      );
    }

    if (profile === 'allowlist' || profile === 'allowlist+wot') {
      answers.GATEWAY_AUTH_ALLOWLIST_PUBKEYS = initialOptions.allowlistPubkeys || await promptText(
        rl,
        'Allowlist pubkeys (comma-separated 64-char hex values)',
        existing.GATEWAY_AUTH_ALLOWLIST_PUBKEYS || '',
        (value) => validatePubkeyCsv(value)
      );
      if (profile === 'allowlist') {
        answers.GATEWAY_AUTH_OPERATOR_PUBKEY = initialOptions.operatorPubkey ?? await promptText(
          rl,
          'Operator pubkey for /admin/allowlist (optional)',
          existing.GATEWAY_AUTH_OPERATOR_PUBKEY || '',
          (value) => value === '' || isHex64(value) || 'Enter a 64-character hex pubkey or leave blank',
          { allowEmpty: true }
        );
      }
    }

    if (profile === 'wot' || profile === 'allowlist+wot') {
      answers.GATEWAY_AUTH_OPERATOR_PUBKEY = initialOptions.operatorPubkey || await promptText(
        rl,
        'WoT operator pubkey',
        existing.GATEWAY_AUTH_OPERATOR_PUBKEY || '',
        (value) => isHex64(value) || 'Enter a 64-character hex pubkey'
      );
      answers.GATEWAY_AUTH_WOT_ROOT_PUBKEY = initialOptions.wotRootPubkey ?? await promptText(
        rl,
        'WoT root pubkey (optional; defaults to operator)',
        existing.GATEWAY_AUTH_WOT_ROOT_PUBKEY || answers.GATEWAY_AUTH_OPERATOR_PUBKEY,
        (value) => value === '' || isHex64(value) || 'Enter a 64-character hex pubkey or leave blank',
        { allowEmpty: true }
      );
      answers.GATEWAY_AUTH_WOT_MAX_DEPTH = initialOptions.wotMaxDepth || await promptText(
        rl,
        'WoT max depth',
        existing.GATEWAY_AUTH_WOT_MAX_DEPTH || '1',
        validatePositiveInteger
      );
      answers.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 = initialOptions.wotMinFollowersDepth2 || await promptText(
        rl,
        'WoT min followers at depth 2',
        existing.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 || '0',
        (value) => /^\d+$/u.test(value) ? true : 'Enter zero or a positive integer'
      );
      answers.GATEWAY_AUTH_WOT_RELAYS = initialOptions.authRelays || await promptText(
        rl,
        'WoT relays (comma-separated ws/wss URLs)',
        existing.GATEWAY_AUTH_WOT_RELAYS || discoveryRelays,
        validateRelayList
      );
    }

    return answers;
  } finally {
    rl.close();
  }
}

function normalizeNonInteractiveAnswers(existing, options) {
  const profile = options.profile || existing.DEPLOY_PROFILE || existing.GATEWAY_AUTH_HOST_POLICY || 'open';
  const answers = {
    DEPLOY_PROFILE: profile,
    GATEWAY_HOST: options.host || existing.GATEWAY_HOST || '',
    LETSENCRYPT_EMAIL: options.email || existing.LETSENCRYPT_EMAIL || '',
    GATEWAY_DISCOVERY_DISPLAY_NAME: options.displayName || existing.GATEWAY_DISCOVERY_DISPLAY_NAME || '',
    GATEWAY_DISCOVERY_REGION: options.region ?? existing.GATEWAY_DISCOVERY_REGION ?? '',
    GATEWAY_NOSTR_DISCOVERY_RELAYS: options.discoveryRelays || existing.GATEWAY_NOSTR_DISCOVERY_RELAYS || DEFAULT_DISCOVERY_RELAYS.join(','),
      GATEWAY_BLINDPEER_PORT: options.blindpeerPort || existing.GATEWAY_BLINDPEER_PORT || '31000',
      GATEWAY_AUTH_ALLOWLIST_PUBKEYS: options.allowlistPubkeys || existing.GATEWAY_AUTH_ALLOWLIST_PUBKEYS || '',
      GATEWAY_AUTH_BLOCKLIST_PUBKEYS: options.blocklistPubkeys || existing.GATEWAY_AUTH_BLOCKLIST_PUBKEYS || '',
      GATEWAY_AUTH_OPERATOR_PUBKEY: options.operatorPubkey || existing.GATEWAY_AUTH_OPERATOR_PUBKEY || '',
    GATEWAY_AUTH_WOT_ROOT_PUBKEY: options.wotRootPubkey ?? existing.GATEWAY_AUTH_WOT_ROOT_PUBKEY ?? '',
    GATEWAY_AUTH_WOT_MAX_DEPTH: options.wotMaxDepth || existing.GATEWAY_AUTH_WOT_MAX_DEPTH || '1',
    GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2: options.wotMinFollowersDepth2 || existing.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 || '0',
    GATEWAY_AUTH_WOT_RELAYS: options.authRelays || existing.GATEWAY_AUTH_WOT_RELAYS || options.discoveryRelays || existing.GATEWAY_NOSTR_DISCOVERY_RELAYS || DEFAULT_DISCOVERY_RELAYS.join(',')
  };
  return answers;
}

export async function readSelectedEnv(envFile) {
  if (await fileExists(envFile)) {
    return readEnvFile(envFile);
  }
  return {};
}

function renderInitSummary(envFile, summary, config) {
  const lines = [
    `Wrote ${envFile}`,
    `Profile: ${config.DEPLOY_PROFILE}`,
    `Public URL: ${config.GATEWAY_PUBLIC_URL}`
  ];
  if (summary.provided.length) {
    lines.push(`Provided/updated: ${summary.provided.join(', ')}`);
  }
  if (summary.generated.length) {
    lines.push(`Generated: ${summary.generated.join(', ')}`);
  }
  if (summary.derived.length) {
    lines.push(`Derived: ${summary.derived.join(', ')}`);
  }
  return lines.join('\n');
}

export async function runInitCommand(options = {}, io = process) {
  const envFile = resolveEnvFilePath(options.deployEnv);
  const existing = await readSelectedEnv(envFile);
  const answers = options.nonInteractive
    ? normalizeNonInteractiveAnswers(existing, options)
    : await collectInteractiveAnswers(existing, options);
  const nextConfig = buildRuntimeConfig({
    profile: answers.DEPLOY_PROFILE,
    answers,
    existing
  });
  const validation = validateConfig(nextConfig);
  if (validation.errors.length) {
    throw new Error(`Generated config is invalid:\n- ${validation.errors.join('\n- ')}`);
  }
  const content = serializeSectionedEnv(ENV_SECTIONS, nextConfig, {
    headerComment: `Generated by gateway-deploy init (${new Date().toISOString()})`
  });
  await writeEnvFile(envFile, content);
  const summary = summarizeConfigChanges({ nextConfig, existing });
  log(io, renderInitSummary(envFile, summary, nextConfig));
  return { envFile, config: nextConfig, summary };
}

export async function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      resolvePromise({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || '').trim());
}

function shouldUseSudoDocker(options = {}) {
  if (options.sudoDocker === true) return true;
  return isTruthyEnv(process.env.GATEWAY_DEPLOY_USE_SUDO_DOCKER);
}

function wrapDockerExec(execImpl, options = {}) {
  if (!shouldUseSudoDocker(options)) return execImpl;
  if (execImpl?.__gatewayDeployDockerWrapped) return execImpl;

  const wrapped = async (command, args, runOptions) => {
    if (command === 'docker' || command === 'docker-compose') {
      return execImpl('sudo', [command, ...args], runOptions);
    }
    return execImpl(command, args, runOptions);
  };
  wrapped.__gatewayDeployDockerWrapped = true;
  return wrapped;
}

export async function resolveComposeCommand(execImpl = runCommand) {
  const dockerCompose = await execImpl('docker', ['compose', 'version']);
  if (dockerCompose.ok) {
    return ['docker', 'compose'];
  }
  const legacyCompose = await execImpl('docker-compose', ['version']);
  if (legacyCompose.ok) {
    return ['docker-compose'];
  }
  return null;
}

function commandOutput(result = {}) {
  return `${result?.stderr || ''}\n${result?.stdout || ''}`.trim();
}

function dockerInfoError(result = {}) {
  const output = commandOutput(result).toLowerCase();
  if (
    output.includes('permission denied while trying to connect to the docker daemon socket')
    || output.includes('dial unix /var/run/docker.sock: connect: permission denied')
  ) {
    return 'Docker daemon socket is not accessible to the current user (rerun with --sudo-docker or fix docker group/socket permissions)';
  }
  return 'Docker daemon is not reachable';
}

async function checkTcpPortInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(750);
    socket.on('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.on('error', (error) => {
      if (error?.code === 'ECONNREFUSED') {
        resolvePromise(false);
      } else {
        resolvePromise(false);
      }
    });
  });
}

async function checkUdpPortBindable(port) {
  return new Promise((resolvePromise) => {
    const socket = dgram.createSocket('udp4');
    const cleanup = (value) => {
      socket.close();
      resolvePromise(value);
    };
    socket.once('error', () => cleanup(false));
    socket.bind(Number(port), '0.0.0.0', () => cleanup(true));
  });
}

async function collectPortWarnings(config) {
  const warnings = [];
  if (await checkTcpPortInUse(80)) warnings.push('Host port 80 appears to be in use');
  if (await checkTcpPortInUse(443)) warnings.push('Host port 443 appears to be in use');
  if (!(await checkUdpPortBindable(config.GATEWAY_BLINDPEER_PORT))) {
    warnings.push(`UDP port ${config.GATEWAY_BLINDPEER_PORT} may already be in use`);
  }
  return warnings;
}

function composeArgs(envFile, extraArgs) {
  return ['--env-file', envFile, '-f', COMPOSE_FILE, ...extraArgs];
}

function splitComposeCommand(composeCommand) {
  if (composeCommand.length === 2) {
    return { command: composeCommand[0], baseArgs: [composeCommand[1]] };
  }
  return { command: composeCommand[0], baseArgs: [] };
}

export async function checkPrerequisites({ execImpl = runCommand } = {}) {
  const errors = [];
  const dockerVersion = await execImpl('docker', ['--version']);
  if (!dockerVersion.ok) {
    errors.push('Docker CLI is not available');
  }
  const composeCommand = dockerVersion.ok ? await resolveComposeCommand(execImpl) : null;
  if (!composeCommand) {
    errors.push('Docker Compose plugin or docker-compose binary is not available');
  }
  if (dockerVersion.ok) {
    const dockerInfo = await execImpl('docker', ['info']);
    if (!dockerInfo.ok) {
      errors.push(dockerInfoError(dockerInfo));
    }
  }
  return { errors, composeCommand };
}

export async function runCheckCommand(options = {}, io = process, execImpl = runCommand) {
  const resolvedExec = wrapDockerExec(execImpl, options);
  const envFile = resolveEnvFilePath(options.deployEnv);
  if (!(await fileExists(envFile))) {
    return {
      ok: false,
      errors: [`Env file not found: ${envFile}`],
      warnings: [],
      envFile,
      config: null,
      composeCommand: null
    };
  }

  const config = await readEnvFile(envFile);
  const validation = validateConfig(config);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  const prerequisiteReport = await checkPrerequisites({ execImpl: resolvedExec });
  errors.push(...prerequisiteReport.errors);
  if (!options.skipPortChecks) {
    warnings.push(...(await collectPortWarnings(config)));
  }

  if (prerequisiteReport.composeCommand) {
    const { command, baseArgs } = splitComposeCommand(prerequisiteReport.composeCommand);
    const composeConfig = await resolvedExec(command, [
      ...baseArgs,
      ...composeArgs(envFile, ['config'])
    ]);
    if (!composeConfig.ok) {
      errors.push(`docker compose config failed:\n${composeConfig.stderr || composeConfig.stdout}`.trim());
    }
  }

  if (errors.length) {
    logError(io, `Check failed for ${envFile}`);
    errors.forEach((entry) => logError(io, `- ${entry}`));
  } else {
    log(io, `Check passed for ${envFile}`);
  }
  warnings.forEach((entry) => log(io, `Warning: ${entry}`));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    envFile,
    config,
    composeCommand: prerequisiteReport.composeCommand
  };
}

export async function runApplyCommand(options = {}, io = process, execImpl = runCommand) {
  const resolvedExec = wrapDockerExec(execImpl, options);
  const checkResult = await runCheckCommand(options, io, execImpl);
  if (!checkResult.ok) {
    throw new Error('deploy-check-failed');
  }
  const { command, baseArgs } = splitComposeCommand(checkResult.composeCommand);
  const result = await resolvedExec(command, [
    ...baseArgs,
    ...composeArgs(checkResult.envFile, ['up', '-d', '--build'])
  ]);
  if (!result.ok) {
    throw new Error(`docker compose up failed:\n${result.stderr || result.stdout}`.trim());
  }
  log(io, `Deployment applied with ${checkResult.envFile}`);
  log(io, `Public URL: ${checkResult.config.GATEWAY_PUBLIC_URL}`);
  log(io, 'Next step: run gateway-deploy smoke');
  return { ...checkResult, applyResult: result };
}

async function fetchJson(url, timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectComposeContainers(composeCommand, envFile, execImpl) {
  const { command, baseArgs } = splitComposeCommand(composeCommand);
  const idsResult = await execImpl(command, [
    ...baseArgs,
    ...composeArgs(envFile, ['ps', '-q'])
  ]);
  if (!idsResult.ok) {
    throw new Error(`docker compose ps failed:\n${idsResult.stderr || idsResult.stdout}`.trim());
  }
  const ids = idsResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const states = [];
  for (const id of ids) {
    const inspect = await execImpl('docker', ['inspect', '-f', '{{.Name}} {{.State.Status}}', id]);
    if (!inspect.ok) {
      throw new Error(`docker inspect failed for ${id}`);
    }
    const [name, status] = inspect.stdout.trim().split(/\s+/u);
    states.push({ id, name, status });
  }
  return states;
}

export async function runSmokeCommand(options = {}, io = process, execImpl = runCommand, fetchImpl = globalThis.fetch) {
  const resolvedExec = wrapDockerExec(execImpl, options);
  const checkResult = await runCheckCommand(options, io, execImpl);
  if (!checkResult.ok) {
    throw new Error('deploy-check-failed');
  }

  const containerStates = await inspectComposeContainers(checkResult.composeCommand, checkResult.envFile, resolvedExec);
  const unhealthy = containerStates.filter((entry) => entry.status !== 'running');
  if (unhealthy.length) {
    throw new Error(`Containers not running: ${unhealthy.map((entry) => `${entry.name}:${entry.status}`).join(', ')}`);
  }
  log(io, `Containers running: ${containerStates.length}`);

  const gatewayOrigin = normalizePublicOrigin(options.gatewayOrigin || checkResult.config.GATEWAY_PUBLIC_URL);
  const health = await fetchJson(`${gatewayOrigin}/health`, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), fetchImpl);
  if (!health.ok || health.body?.status !== 'ok') {
    throw new Error(`Health check failed for ${gatewayOrigin}/health`);
  }
  log(io, `Health check passed: ${gatewayOrigin}/health`);

  const profile = deriveProfile(checkResult.config);
  const shouldCheckSecret = profile === 'open';
  if (shouldCheckSecret) {
    const secretPath = String(checkResult.config.GATEWAY_DISCOVERY_SECRET_PATH || DEFAULT_SECRET_PATH);
    const secretUrl = new URL(secretPath, gatewayOrigin).toString();
    const secretResponse = await fetchJson(secretUrl, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), fetchImpl);
    if (!secretResponse.ok) {
      throw new Error(`Secret endpoint check failed for ${secretUrl}`);
    }
    log(io, `Secret endpoint check passed: ${secretUrl}`);
  }

  let authReport = null;
  if (options.authManifest) {
    const policyColumn = options.policyColumn || defaultPolicyColumnForConfig(checkResult.config);
    authReport = await runDeepAuthValidation({
      manifestPath: resolve(process.cwd(), options.authManifest),
      gatewayOrigin,
      policyColumn,
      scope: options.scope || DEFAULT_SCOPE,
      timeoutMs: Number(options.timeoutMs || 30_000),
      outPath: options.out ? resolve(process.cwd(), options.out) : null,
      fetchImpl
    });
    log(io, buildAuthMarkdownReport(authReport));
    if (!authReport.ok) {
      throw new Error('Deep auth validation failed');
    }
  }

  return {
    ...checkResult,
    gatewayOrigin,
    containerStates,
    health,
    authReport
  };
}

function normalizePublicOrigin(value) {
  const text = String(value || '').trim();
  const parsed = new URL(text);
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.origin;
}

export function usage() {
  return [
    'Usage:',
    '  gateway-deploy <command> [options]',
    '',
    'Commands:',
    '  init    Prompt for required values and write a deploy env file',
    '  check   Validate env, prerequisites, and docker compose config',
    '  apply   Run check, then docker compose up -d --build',
    '  smoke   Run health checks and optional deep auth validation',
    '',
    'Common options:',
    '  --deploy-env <path|name> Env file path, or named env under deploy/environments/',
    '  --profile <name>         Deployment profile: open, allowlist, wot, allowlist+wot',
    '  --non-interactive        Do not prompt during init',
    '  --sudo-docker            Run docker/docker compose through sudo',
    '',
    'Smoke options:',
    '  --gateway-origin <url>   Override public gateway origin',
    '  --auth-manifest <path>   Optional auth manifest for deep auth validation',
    '  --policy-column <name>   Optional manifest policy column override',
    '  --out <path>             Optional auth report JSON output path',
    '  --timeout-ms <number>    HTTP timeout for smoke/auth checks',
    '',
    'Examples:',
    '  gateway-deploy init',
    '  gateway-deploy init --deploy-env production --profile wot',
    '  gateway-deploy check --deploy-env production',
    '  gateway-deploy apply --deploy-env production',
    '  gateway-deploy smoke --deploy-env production --auth-manifest ./manifest.json'
  ].join('\n');
}
