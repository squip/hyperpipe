#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import { readCliGatewayConfig, gatewayRequest } from './_gateway-client.mjs';
import { runConfigWizard, buildEnvMap } from './lib/config-wizard.mjs';
import {
  serializeEnv,
  writeRenderedFile,
  renderComposeTemplate,
  renderEnvExample
} from './lib/template-renderer.mjs';
import { runCompose, waitForGatewayHealth } from './lib/docker-compose-runner.mjs';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_GATEWAY_DIR = resolve(BIN_DIR, '..');
const RUNTIME_DIR = resolve(PUBLIC_GATEWAY_DIR, 'deploy', 'runtime');
const COMPOSE_FILE = resolve(RUNTIME_DIR, 'docker-compose.yml');
const ENV_FILE = resolve(RUNTIME_DIR, '.env');
const CONFIG_FILE = resolve(RUNTIME_DIR, 'config.json');
const ENV_EXAMPLE_FILE = resolve(RUNTIME_DIR, '.env.example');

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function loadStoredConfig() {
  if (!await fileExists(CONFIG_FILE)) return {};
  try {
    return await readJson(CONFIG_FILE);
  } catch (_) {
    return {};
  }
}

async function ensureRuntime() {
  await mkdir(RUNTIME_DIR, { recursive: true });
}

async function writeRuntimeConfig(config, envMap) {
  await ensureRuntime();
  await renderComposeTemplate({ profile: config.profile, outputPath: COMPOSE_FILE });
  await renderEnvExample({ profile: config.profile, outputPath: ENV_EXAMPLE_FILE });
  await writeRenderedFile(ENV_FILE, serializeEnv(envMap));
  await writeFile(CONFIG_FILE, JSON.stringify({
    ...config,
    runtime: {
      composeFile: COMPOSE_FILE,
      envFile: ENV_FILE,
      updatedAt: Date.now()
    }
  }, null, 2), 'utf8');
}

function parseEnvRaw(raw = '') {
  const out = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function parseCsvRaw(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBooleanRaw(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim().length === 0) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function pickDefinedEntries(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

async function readRuntimeEnv() {
  if (!await fileExists(ENV_FILE)) {
    throw new Error(`Runtime env not found at ${ENV_FILE}. Run \`gateway-admin init\` first.`);
  }
  const raw = await readFile(ENV_FILE, 'utf8');
  return parseEnvRaw(raw);
}

async function loadWizardDefaults() {
  const stored = await loadStoredConfig();
  const runtimeEnv = await readRuntimeEnv().catch(() => null);
  if (!runtimeEnv) return stored;

  const envDerived = pickDefinedEntries({
    profile: runtimeEnv.GATEWAY_PROFILE,
    gatewayBindPort: runtimeEnv.GATEWAY_BIND_PORT,
    gatewayHost: runtimeEnv.GATEWAY_HOST,
    letsencryptEmail: runtimeEnv.LETSENCRYPT_EMAIL,
    gatewayPublicUrl: runtimeEnv.GATEWAY_PUBLIC_URL,
    operatorNsecHex: runtimeEnv.GATEWAY_OPERATOR_NSEC_HEX,
    operatorPubkeyHex: runtimeEnv.GATEWAY_OPERATOR_PUBKEY_HEX,
    relaySeedHex: runtimeEnv.GATEWAY_RELAY_SEED,
    relayNamespace: runtimeEnv.GATEWAY_RELAY_NAMESPACE,
    relayReplicationTopic: runtimeEnv.GATEWAY_RELAY_REPLICATION_TOPIC,
    relayAdminPublicKeyHex: runtimeEnv.GATEWAY_RELAY_ADMIN_PUBLIC_KEY,
    relayAdminSecretKeyHex: runtimeEnv.GATEWAY_RELAY_ADMIN_SECRET_KEY,
    policy: runtimeEnv.GATEWAY_POLICY,
    allowList: parseCsvRaw(runtimeEnv.GATEWAY_ALLOW_LIST),
    banList: parseCsvRaw(runtimeEnv.GATEWAY_BAN_LIST),
    discoveryRelays: parseCsvRaw(runtimeEnv.GATEWAY_DISCOVERY_RELAYS),
    inviteOnly: parseBooleanRaw(runtimeEnv.GATEWAY_INVITE_ONLY, stored.inviteOnly === true),
    authJwtSecret: runtimeEnv.GATEWAY_AUTH_JWT_SECRET,
    relayTokenJwtSecret: runtimeEnv.GATEWAY_RELAY_TOKEN_JWT_SECRET,
    metricsEnabled: parseBooleanRaw(runtimeEnv.GATEWAY_METRICS_ENABLED, stored.metricsEnabled !== false),
    gatewayHostLogPath: runtimeEnv.GATEWAY_HOST_LOG_PATH
  });

  return {
    ...stored,
    ...envDerived
  };
}

function requiredRuntimeFiles() {
  return [COMPOSE_FILE, ENV_FILE, CONFIG_FILE];
}

async function assertRuntimeInitialized() {
  for (const path of requiredRuntimeFiles()) {
    if (!await fileExists(path)) {
      throw new Error(`Missing runtime file: ${path}. Run \`gateway-admin init\`.`);
    }
  }
}

async function runInit(mode = 'init') {
  const existing = await loadWizardDefaults();
  const config = await runConfigWizard({ existing, mode });
  const envMap = buildEnvMap(config);
  await writeRuntimeConfig(config, envMap);
  console.log(`\nRuntime config written to ${RUNTIME_DIR}`);
  console.log(`Compose file: ${COMPOSE_FILE}`);
  console.log(`Env file: ${ENV_FILE}`);
  console.log('Next: gateway-admin deploy up');
}

async function deployUp() {
  await assertRuntimeInitialized();
  const env = await readRuntimeEnv();

  const runUp = async (args = []) => {
    const result = await runCompose({
      runtimeDir: RUNTIME_DIR,
      composeFile: COMPOSE_FILE,
      envFile: ENV_FILE,
      args,
      capture: true
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output.length) {
      console.log(output);
    }
  };

  try {
    await runUp(['up', '-d', '--build']);
  } catch (error) {
    const combined = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`;
    const knownComposeMetadataBug = combined.includes('tmp-compose-build-metadataFile')
      && combined.includes('no such file or directory');
    if (!knownComposeMetadataBug) throw error;
    console.warn('[gateway-admin] Detected docker compose metadata-file bug after build; retrying with `up -d`.');
    await runUp(['up', '-d']);
  }

  const publicUrl = env.GATEWAY_PUBLIC_URL || 'http://127.0.0.1:4430';
  const health = await waitForGatewayHealth(publicUrl, { timeoutMs: 150000, intervalMs: 2500 });
  if (!health.ok) {
    throw new Error(`Gateway failed health check (${health.error || 'timeout'})`);
  }
  console.log(`Gateway healthy after ${health.elapsedMs}ms at ${publicUrl}`);
}

async function deployDown({ removeVolumes = false } = {}) {
  await assertRuntimeInitialized();
  const args = ['down'];
  if (removeVolumes) args.push('-v');
  await runCompose({
    runtimeDir: RUNTIME_DIR,
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    args
  });
}

async function deployRestart() {
  await assertRuntimeInitialized();
  await runCompose({
    runtimeDir: RUNTIME_DIR,
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    args: ['restart']
  });
}

async function deployStatus() {
  await assertRuntimeInitialized();
  const env = await readRuntimeEnv();
  const ps = await runCompose({
    runtimeDir: RUNTIME_DIR,
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    args: ['ps'],
    capture: true
  });
  console.log(ps.stdout || ps.stderr || '');

  const publicUrl = env.GATEWAY_PUBLIC_URL || 'http://127.0.0.1:4430';
  try {
    const response = await fetch(new URL('/health', publicUrl));
    console.log(`Health: ${response.status} ${response.ok ? 'OK' : 'NOT OK'} (${publicUrl}/health)`);
  } catch (error) {
    console.log(`Health: unavailable (${error?.message || error})`);
  }
}

async function deployLogs({ service = null, follow = true } = {}) {
  await assertRuntimeInitialized();
  const args = ['logs'];
  if (follow) args.push('-f');
  if (service) args.push(service);
  await runCompose({
    runtimeDir: RUNTIME_DIR,
    composeFile: COMPOSE_FILE,
    envFile: ENV_FILE,
    args
  });
}

async function showConfig() {
  const config = await loadStoredConfig();
  const env = await readRuntimeEnv().catch(() => ({}));
  const redacted = {
    ...config,
    operatorNsecHex: config.operatorNsecHex ? '<redacted>' : undefined,
    relaySeedHex: config.relaySeedHex ? '<redacted>' : undefined,
    relayAdminSecretKeyHex: config.relayAdminSecretKeyHex ? '<redacted>' : undefined,
    authJwtSecret: config.authJwtSecret ? '<redacted>' : undefined,
    relayTokenJwtSecret: config.relayTokenJwtSecret ? '<redacted>' : undefined,
    envPreview: {
      GATEWAY_PUBLIC_URL: env.GATEWAY_PUBLIC_URL,
      GATEWAY_POLICY: env.GATEWAY_POLICY,
      GATEWAY_ENABLE_MULTI: env.GATEWAY_ENABLE_MULTI,
      GATEWAY_ADMIN_UI_ENABLED: env.GATEWAY_ADMIN_UI_ENABLED,
      GATEWAY_RELAY_NAMESPACE: env.GATEWAY_RELAY_NAMESPACE,
      GATEWAY_RELAY_REPLICATION_TOPIC: env.GATEWAY_RELAY_REPLICATION_TOPIC
    }
  };
  console.log(JSON.stringify(redacted, null, 2));
}

async function runOperator(domain, action, value, argv) {
  let cfg = null;
  try {
    cfg = readCliGatewayConfig();
  } catch (error) {
    const runtimeEnv = await readRuntimeEnv().catch(() => null);
    if (!runtimeEnv) throw error;
    process.env.GATEWAY_API_BASE = process.env.GATEWAY_API_BASE || runtimeEnv.GATEWAY_PUBLIC_URL;
    process.env.GATEWAY_PUBLIC_URL = process.env.GATEWAY_PUBLIC_URL || runtimeEnv.GATEWAY_PUBLIC_URL;
    process.env.GATEWAY_OPERATOR_PUBKEY_HEX = process.env.GATEWAY_OPERATOR_PUBKEY_HEX || runtimeEnv.GATEWAY_OPERATOR_PUBKEY_HEX;
    process.env.GATEWAY_OPERATOR_NSEC_HEX = process.env.GATEWAY_OPERATOR_NSEC_HEX || runtimeEnv.GATEWAY_OPERATOR_NSEC_HEX;
    cfg = readCliGatewayConfig();
  }

  if (domain === 'allow') {
    if (action === 'list') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/policy', method: 'GET' });
      console.log(JSON.stringify({ allowList: result.allowList || [], count: (result.allowList || []).length }, null, 2));
      return;
    }
    if (!value) throw new Error('pubkey is required');
    if (action === 'add') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/allow-list', method: 'POST', body: { pubkey: value.toLowerCase() } });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (action === 'remove') {
      const result = await gatewayRequest({ ...cfg, path: `/api/gateway/allow-list/${encodeURIComponent(value.toLowerCase())}`, method: 'DELETE' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }

  if (domain === 'ban') {
    if (action === 'list') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/ban-list', method: 'GET' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!value) throw new Error('pubkey is required');
    if (action === 'add') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/ban-list', method: 'POST', body: { pubkey: value.toLowerCase() } });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (action === 'remove') {
      const result = await gatewayRequest({ ...cfg, path: `/api/gateway/ban-list/${encodeURIComponent(value.toLowerCase())}`, method: 'DELETE' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }

  if (domain === 'invite') {
    if (action !== 'create' || !value) throw new Error('Usage: gateway-admin operator invite create <pubkey>');
    const result = await gatewayRequest({ ...cfg, path: '/api/gateway/invites', method: 'POST', body: { pubkey: value.toLowerCase() } });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (domain === 'join-requests') {
    if (action === 'list') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/join-requests', method: 'GET' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!value) throw new Error('requestId is required');
    if (action === 'approve' || action === 'reject') {
      const result = await gatewayRequest({
        ...cfg,
        path: `/api/gateway/join-requests/${encodeURIComponent(value)}/${action}`,
        method: 'POST'
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }

  if (domain === 'policy') {
    if (action === 'show') {
      const result = await gatewayRequest({ ...cfg, path: '/api/gateway/policy', method: 'GET' });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (action === 'set') {
      const discovery = argv.discovery ? String(argv.discovery).split(',').map((v) => v.trim()).filter(Boolean) : undefined;
      const result = await gatewayRequest({
        ...cfg,
        path: '/api/gateway/policy',
        method: 'POST',
        body: {
          policy: argv.policy,
          inviteOnly: typeof argv.inviteOnly === 'boolean' ? argv.inviteOnly : undefined,
          discoveryRelays: discovery
        }
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }

  throw new Error('Unsupported operator command');
}

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName('gateway-admin')
    .command('init', 'Run interactive setup wizard', {}, async () => {
      await runInit('init');
    })
    .command('config <action>', 'Show or edit generated config', (cmd) => {
      return cmd.positional('action', {
        choices: ['show', 'edit']
      });
    }, async (argv) => {
      if (argv.action === 'show') {
        await showConfig();
        return;
      }
      await runInit('edit');
    })
    .command('deploy <action>', 'Manage docker stack lifecycle', (cmd) => {
      return cmd
        .positional('action', {
          choices: ['up', 'down', 'restart', 'status', 'logs']
        })
        .option('volumes', {
          type: 'boolean',
          default: false,
          describe: 'Remove volumes when using deploy down'
        })
        .option('service', {
          type: 'string',
          describe: 'Service name for deploy logs'
        })
        .option('follow', {
          type: 'boolean',
          default: true,
          describe: 'Follow logs in deploy logs'
        });
    }, async (argv) => {
      if (argv.action === 'up') return await deployUp();
      if (argv.action === 'down') return await deployDown({ removeVolumes: argv.volumes === true });
      if (argv.action === 'restart') return await deployRestart();
      if (argv.action === 'status') return await deployStatus();
      if (argv.action === 'logs') return await deployLogs({ service: argv.service || null, follow: argv.follow !== false });
      throw new Error(`Unsupported deploy action: ${argv.action}`);
    })
    .command('operator <domain> <action> [value]', 'Run operator management actions', (cmd) => {
      return cmd
        .positional('domain', {
          choices: ['allow', 'ban', 'invite', 'join-requests', 'policy']
        })
        .positional('action', {
          type: 'string'
        })
        .positional('value', {
          type: 'string'
        })
        .option('policy', {
          type: 'string',
          choices: ['OPEN', 'CLOSED']
        })
        .option('invite-only', {
          type: 'boolean'
        })
        .option('discovery', {
          type: 'string',
          describe: 'Comma separated discovery relay urls'
        });
    }, async (argv) => {
      await runOperator(argv.domain, argv.action, argv.value, {
        policy: argv.policy,
        inviteOnly: argv.inviteOnly,
        discovery: argv.discovery
      });
    })
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
