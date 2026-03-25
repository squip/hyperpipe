import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';

import { schnorr } from '@noble/curves/secp256k1';
import { readEnvFile, serializeSectionedEnv, writeEnvFile } from './env-file.mjs';
import {
  DEFAULT_DISCOVERY_RELAYS,
  ENV_SECTIONS,
  EXPOSURE_MODE_NAMES,
  PROFILE_NAMES,
  buildOperatorAttestationRequestFromConfig,
  buildRuntimeConfig,
  defaultPolicyColumnForConfig,
  deriveExposureMode,
  deriveProfile,
  deriveGatewayIdFromSeed,
  normalizeExposureMode,
  summarizeConfigChanges,
  validateOperatorAttestationForConfig,
  validateConfig
} from './schema.mjs';
import { buildAuthMarkdownReport, runDeepAuthValidation } from './deep-auth.mjs';
import { signOperatorAttestationRequest } from '../../shared/public-gateway/OperatorAttestation.mjs';

const DEFAULT_SCOPE = 'gateway:relay-register';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEPLOY_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ENV_FILE = join(DEPLOY_DIR, '.env');
const DEFAULT_ENV_DIR = join(DEPLOY_DIR, 'environments');
const ARTIFACTS_DIR = join(DEPLOY_DIR, 'artifacts');
const DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE = join(ARTIFACTS_DIR, 'operator-attestation-request.json');
const DEFAULT_OPERATOR_ATTESTATION_FILE = join(ARTIFACTS_DIR, 'operator-attestation.json');
const BASE_COMPOSE_FILE = join(DEPLOY_DIR, 'docker-compose.yml');
const HTTPS_ACME_COMPOSE_FILE = join(DEPLOY_DIR, 'docker-compose.https-acme.yml');
const HTTP_COMPOSE_FILE = join(DEPLOY_DIR, 'docker-compose.http.yml');
const SITE_COMPOSE_FILE = join(DEPLOY_DIR, 'docker-compose.site.yml');
const DEFAULT_SECRET_PATH = '/.well-known/hyperpipe-gateway-secret';

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

async function ensureArtifactsDir() {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

function renderOperatorAttestationInstructions({ requestPath, outputPath }) {
  return [
    'Verified operator identity is enabled.',
    `Unsigned request template: ${requestPath}`,
    `Expected signed artifact: ${outputPath}`,
    'Next steps:',
    `1. Copy ${requestPath} to a trusted local machine that holds the operator nsec.`,
    `2. Run: gateway-deploy attest-operator --request ${requestPath} --out ${outputPath}`,
    `3. Copy ${outputPath} back into deploy/artifacts/ on the gateway host.`,
    '4. Then run gateway-deploy check and gateway-deploy apply.'
  ].join('\n');
}

function normalizeBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return !!fallback;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value || '').trim());
}

function isValidHost(value) {
  return Boolean(String(value || '').trim()) && !/[/:]/u.test(String(value || '').trim());
}

function isValidIpv4(value) {
  const text = String(value || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d+$/u.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidAcmeHost(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || isValidIpv4(text) || !text.includes('.')) return false;
  return text.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
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

async function promptYesNo(rl, label, defaultValue = false) {
  const printableDefault = defaultValue ? 'Y/n' : 'y/N';
  while (true) {
    const answer = (await rl.question(`${label} [${printableDefault}]: `)).trim().toLowerCase();
    if (!answer) return !!defaultValue;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    logError(process, 'Enter yes or no');
  }
}

async function promptHiddenText(label, { io = process } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} requires a TTY`);
  }
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    const stdout = io.stdout || process.stdout;
    let value = '';
    const onData = (chunk) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('operator-secret-entry-cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdout.write('\n');
          cleanup();
          resolvePromise(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };
    stdout.write(`${label}: `);
    stdin.resume();
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.on('data', onData);
  });
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

async function promptExposureMode(rl, defaultMode) {
  const fallback = EXPOSURE_MODE_NAMES.includes(defaultMode) ? defaultMode : 'https-acme';
  log(process, 'Select exposure mode:');
  log(process, `  1. https-acme${fallback === 'https-acme' ? ' (default)' : ''}`);
  log(process, `  2. http${fallback === 'http' ? ' (default)' : ''}`);
  while (true) {
    const raw = (await rl.question(`Exposure mode [${fallback}]: `)).trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === '1') return 'https-acme';
    if (raw === '2') return 'http';
    if (EXPOSURE_MODE_NAMES.includes(raw)) return raw;
    logError(process, `Choose one of: ${EXPOSURE_MODE_NAMES.join(', ')}`);
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
    const exposureMode = initialOptions.exposureMode || await promptExposureMode(
      rl,
      existing.DEPLOY_EXPOSURE_MODE || deriveExposureMode(existing) || 'https-acme'
    );
    const hostLabel = exposureMode === 'http' ? 'Gateway public host or IPv4' : 'Gateway domain';
    const hostValidator = exposureMode === 'http'
      ? ((value) => isValidHost(value) || 'Enter a hostname or IPv4 address without protocol or path')
      : ((value) => isValidAcmeHost(value) || 'Enter a domain hostname that can receive a Let’s Encrypt certificate');
    const host = initialOptions.host || await promptText(
      rl,
      hostLabel,
      existing.GATEWAY_HOST || '',
      hostValidator
    );
    const email = exposureMode === 'https-acme'
      ? (initialOptions.email || await promptText(
        rl,
        'Let’s Encrypt email',
        existing.LETSENCRYPT_EMAIL || '',
        (value) => isValidEmail(value) || 'Enter a valid email address'
      ))
      : (initialOptions.email || existing.LETSENCRYPT_EMAIL || '');
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
      DEPLOY_EXPOSURE_MODE: exposureMode,
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

    if (answers.GATEWAY_AUTH_OPERATOR_PUBKEY) {
      const existingEnabled = Boolean(existing.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE);
      const enableAttestation = initialOptions.enableOperatorAttestation ?? await promptYesNo(
        rl,
        'Enable verified operator identity via offline attestation',
        existingEnabled
      );
      answers.ENABLE_OPERATOR_ATTESTATION = enableAttestation ? 'true' : 'false';
    } else {
      answers.ENABLE_OPERATOR_ATTESTATION = 'false';
    }

    if (exposureMode === 'http') {
      log(process, 'Warning: http exposure leaves gateway and admin traffic unencrypted.');
    }

    return answers;
  } finally {
    rl.close();
  }
}

function normalizeNonInteractiveAnswers(existing, options) {
  const profile = options.profile || existing.DEPLOY_PROFILE || existing.GATEWAY_AUTH_HOST_POLICY || 'open';
  const exposureMode = options.exposureMode || existing.DEPLOY_EXPOSURE_MODE || deriveExposureMode(existing) || 'https-acme';
  const answers = {
    DEPLOY_PROFILE: profile,
    DEPLOY_EXPOSURE_MODE: exposureMode,
    GATEWAY_HOST: options.host || existing.GATEWAY_HOST || '',
    LETSENCRYPT_EMAIL: exposureMode === 'https-acme'
      ? (options.email || existing.LETSENCRYPT_EMAIL || '')
      : (options.email || existing.LETSENCRYPT_EMAIL || ''),
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
  answers.ENABLE_OPERATOR_ATTESTATION = normalizeBooleanOption(
    options.enableOperatorAttestation,
    Boolean(existing.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE)
  )
    && Boolean(String(answers.GATEWAY_AUTH_OPERATOR_PUBKEY || '').trim())
    ? 'true'
    : 'false';
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
    `Exposure: ${deriveExposureMode(config)}`,
    `Public URL: ${config.GATEWAY_PUBLIC_URL}`,
    `Gateway ID: ${deriveGatewayIdFromSeed(config.GATEWAY_DISCOVERY_KEY_SEED)}`
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

async function writeOperatorAttestationRequestArtifact(config) {
  if (!config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE) {
    return null;
  }
  await ensureArtifactsDir();
  const request = buildOperatorAttestationRequestFromConfig(config);
  await writeFile(DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return {
    requestPath: DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE,
    outputPath: DEFAULT_OPERATOR_ATTESTATION_FILE,
    request
  };
}

function assertValidExposureModeOption(exposureMode) {
  if (!exposureMode) return;
  if (!normalizeExposureMode(exposureMode)) {
    throw new Error(`Invalid exposure mode: ${exposureMode}. Expected one of: https-acme, http`);
  }
}

function applyCommandOverrides(config = {}, options = {}) {
  const exposureMode = normalizeExposureMode(options.exposureMode);
  if (!exposureMode) return { ...config };
  const next = { ...config, DEPLOY_EXPOSURE_MODE: exposureMode };
  const host = String(next.GATEWAY_HOST || '').trim();
  if (host) {
    next.GATEWAY_PUBLIC_URL = `${exposureMode === 'http' ? 'http' : 'https'}://${host}`;
  }
  if (exposureMode === 'http') {
    next.LETSENCRYPT_EMAIL = '';
  }
  return next;
}

export async function runInitCommand(options = {}, io = process) {
  assertValidExposureModeOption(options.exposureMode);
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
  const attestationArtifacts = await writeOperatorAttestationRequestArtifact(nextConfig);
  const summary = summarizeConfigChanges({ nextConfig, existing });
  log(io, renderInitSummary(envFile, summary, nextConfig));
  if (attestationArtifacts) {
    log(io, '');
    log(io, renderOperatorAttestationInstructions(attestationArtifacts));
  }
  return { envFile, config: nextConfig, summary, attestationArtifacts };
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
  const exposureMode = deriveExposureMode(config);
  if (await checkTcpPortInUse(80)) warnings.push('Host port 80 appears to be in use');
  if (exposureMode === 'https-acme' && await checkTcpPortInUse(443)) warnings.push('Host port 443 appears to be in use');
  if (!(await checkUdpPortBindable(config.GATEWAY_BLINDPEER_PORT))) {
    warnings.push(`UDP port ${config.GATEWAY_BLINDPEER_PORT} may already be in use`);
  }
  return warnings;
}

function composeFilesForConfig(config = {}) {
  const files = [];
  const exposureMode = deriveExposureMode(config);
  if (exposureMode === 'http') {
    files.push(BASE_COMPOSE_FILE, HTTP_COMPOSE_FILE);
  } else {
    files.push(BASE_COMPOSE_FILE, HTTPS_ACME_COMPOSE_FILE);
  }
  if (normalizeBooleanOption(config.SITE_ENABLED, false)) {
    files.push(SITE_COMPOSE_FILE);
  }
  return files;
}

function composeArgs(envFile, config, extraArgs) {
  return [
    '--env-file',
    envFile,
    ...composeFilesForConfig(config).flatMap((file) => ['-f', file]),
    ...extraArgs
  ];
}

function resolveOperatorAttestationHostPath(config = {}) {
  const containerPath = String(config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE || '').trim();
  if (!containerPath) return null;
  const prefix = '/app/public-gateway/artifacts/';
  if (containerPath.startsWith(prefix)) {
    return join(ARTIFACTS_DIR, containerPath.slice(prefix.length));
  }
  return isAbsolute(containerPath) ? containerPath : resolve(DEPLOY_DIR, containerPath);
}

async function readJsonFile(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function validateOperatorAttestationArtifact(config, errors, warnings) {
  const containerPath = String(config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE || '').trim();
  if (!containerPath) return;
  const hostPath = resolveOperatorAttestationHostPath(config);
  if (!hostPath || !(await fileExists(hostPath))) {
    errors.push(`Operator attestation artifact not found: ${hostPath || containerPath}`);
    return;
  }
  let attestation;
  try {
    attestation = await readJsonFile(hostPath);
  } catch (error) {
    errors.push(`Failed to read operator attestation artifact: ${error?.message || error}`);
    return;
  }
  const verification = validateOperatorAttestationForConfig(config, attestation);
  if (!verification.ok) {
    errors.push(`Operator attestation invalid: ${verification.error}`);
    return;
  }
  warnings.push(...verification.warnings);
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
  assertValidExposureModeOption(options.exposureMode);
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

  const config = applyCommandOverrides(await readEnvFile(envFile), options);
  const validation = validateConfig(config);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  await validateOperatorAttestationArtifact(config, errors, warnings);

  const prerequisiteReport = await checkPrerequisites({ execImpl: resolvedExec });
  errors.push(...prerequisiteReport.errors);
  if (!options.skipPortChecks) {
      warnings.push(...(await collectPortWarnings(config)));
  }

  if (prerequisiteReport.composeCommand) {
    const { command, baseArgs } = splitComposeCommand(prerequisiteReport.composeCommand);
    const composeConfig = await resolvedExec(command, [
      ...baseArgs,
      ...composeArgs(envFile, config, ['config'])
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
    log(io, `Exposure: ${deriveExposureMode(config)}`);
    log(io, `Public URL: ${config.GATEWAY_PUBLIC_URL}`);
  }
  if (deriveExposureMode(config) === 'http') {
    warnings.push('HTTP exposure mode leaves gateway and admin traffic unencrypted');
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
    ...composeArgs(checkResult.envFile, checkResult.config, ['up', '-d', '--build'])
  ]);
  if (!result.ok) {
    throw new Error(`docker compose up failed:\n${result.stderr || result.stdout}`.trim());
  }
  log(io, `Deployment applied with ${checkResult.envFile}`);
  log(io, `Public URL: ${checkResult.config.GATEWAY_PUBLIC_URL}`);
  log(io, 'Next step: run gateway-deploy smoke');
  return { ...checkResult, applyResult: result };
}

export async function runAttestOperatorCommand(options = {}, io = process) {
  const requestPath = resolve(process.cwd(), options.request || DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE);
  const outPath = resolve(process.cwd(), options.out || DEFAULT_OPERATOR_ATTESTATION_FILE);
  let request;
  try {
    request = await readJsonFile(requestPath);
  } catch (error) {
    throw new Error(`Failed to read attestation request: ${error?.message || error}`);
  }
  const expiresDays = Number.parseInt(String(options.expiresDays || '365'), 10);
  if (!Number.isFinite(expiresDays) || expiresDays <= 0) {
    throw new Error('expiresDays must be a positive integer');
  }
  const secretInput = String(options.operatorSecret || '').trim() || await promptHiddenText(
    'Operator nsec or 32-byte hex secret',
    { io }
  );
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (expiresDays * 24 * 60 * 60 * 1000);
  const attestation = signOperatorAttestationRequest(request, {
    secretInput,
    issuedAt,
    expiresAt,
    schnorrImpl: schnorr
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
  log(io, `Wrote ${outPath}`);
  log(io, `Operator pubkey: ${attestation.payload.operatorPubkey}`);
  log(io, `Gateway ID: ${attestation.payload.gatewayId}`);
  log(io, `Public URL: ${attestation.payload.publicUrl}`);
  log(io, `Expires: ${new Date(attestation.payload.expiresAt).toISOString()}`);
  return { requestPath, outPath, attestation };
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

async function inspectComposeContainers(composeCommand, envFile, config, execImpl) {
  const { command, baseArgs } = splitComposeCommand(composeCommand);
  const idsResult = await execImpl(command, [
    ...baseArgs,
    ...composeArgs(envFile, config, ['ps', '-q'])
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

  const containerStates = await inspectComposeContainers(checkResult.composeCommand, checkResult.envFile, checkResult.config, resolvedExec);
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

  if (normalizeBooleanOption(checkResult.config.SITE_ENABLED, false)) {
    const siteOrigin = siteOriginForConfig(checkResult.config);
    const siteHealth = await fetchJson(`${siteOrigin}/healthz`, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), fetchImpl);
    if (!siteHealth.ok) {
      throw new Error(`Site health check failed for ${siteOrigin}/healthz`);
    }
    log(io, `Site health check passed: ${siteOrigin}/healthz`);
  }

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

function siteOriginForConfig(config = {}) {
  const host = String(config.SITE_HOST || '').trim();
  if (!host) return '';
  const exposureMode = deriveExposureMode(config);
  return `${exposureMode === 'http' ? 'http' : 'https'}://${host}`;
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
    '  attest-operator  Sign an operator attestation request on a trusted machine',
    '',
    'Common options:',
    '  --deploy-env <path|name> Env file path, or named env under deploy/environments/',
    '  --profile <name>         Deployment profile: open, allowlist, wot, allowlist+wot',
    '  --exposure-mode <mode>   Exposure mode: https-acme or http',
    '  --enable-operator-attestation  Generate an offline operator attestation request during init',
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
    'Attestation options:',
    '  --request <path>         Operator attestation request JSON path',
    '  --out <path>             Signed operator attestation JSON output path',
    '  --expires-days <number>  Signed attestation lifetime in days (default 365)',
    '',
    'Examples:',
    '  gateway-deploy init',
    '  gateway-deploy init --deploy-env production --profile wot',
    '  gateway-deploy init --profile open --exposure-mode http --host 203.0.113.10',
    '  gateway-deploy attest-operator --request ./artifacts/operator-attestation-request.json --out ./artifacts/operator-attestation.json',
    '  gateway-deploy check --deploy-env production',
    '  gateway-deploy apply --deploy-env production',
    '  gateway-deploy smoke --deploy-env production --auth-manifest ./manifest.json'
  ].join('\n');
}
