import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { schnorr } from '@noble/curves/secp256k1';

import { readEnvFile } from '../lib/env-file.mjs';
import {
  resolveEnvFilePath,
  runApplyCommand,
  runCheckCommand,
  runInitCommand,
  runSmokeCommand
} from '../lib/commands.mjs';

const OPERATOR_SECRET_HEX = '7'.repeat(64);
const OPERATOR_PUBKEY = Buffer.from(
  schnorr.getPublicKey(Buffer.from(OPERATOR_SECRET_HEX, 'hex'))
).toString('hex');

function createIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write: (chunk) => void stdout.push(String(chunk)) },
    stderr: { write: (chunk) => void stderr.push(String(chunk)) },
    get stdoutText() {
      return stdout.join('');
    },
    get stderrText() {
      return stderr.join('');
    }
  };
}

function execResult(ok, stdout = '', stderr = '') {
  return {
    ok,
    code: ok ? 0 : 1,
    stdout,
    stderr
  };
}

function createExecStub({
  dockerOk = true,
  composeOk = true,
  dockerInfoOk = true,
  composeConfigOk = true,
  composeUpOk = true,
  containerStates = { gateway: 'running' }
} = {}) {
  const calls = [];
  const execStub = async (command, args) => {
    calls.push({ command, args });

    if (command === 'docker' && args[0] === 'version') {
      return dockerOk ? execResult(true, 'Docker version 26.0.0') : execResult(false, '', 'docker missing');
    }
    if (command === 'docker' && args[0] === 'compose' && args[1] === 'version') {
      return composeOk ? execResult(true, 'Docker Compose version v2.29.0') : execResult(false, '', 'compose missing');
    }
    if (command === 'docker-compose' && args[0] === 'version') {
      return composeOk ? execResult(true, 'docker-compose version 1.29.2') : execResult(false, '', 'compose missing');
    }
    if (command === 'docker' && args[0] === 'info') {
      return dockerInfoOk ? execResult(true, 'Docker info') : execResult(false, '', 'daemon unavailable');
    }
    if (command === 'docker' && args[0] === 'compose' && args.includes('config')) {
      return composeConfigOk ? execResult(true, 'services: {}') : execResult(false, '', 'invalid compose');
    }
    if (command === 'docker' && args[0] === 'compose' && args.includes('up')) {
      return composeUpOk ? execResult(true, 'up') : execResult(false, '', 'up failed');
    }
    if (command === 'docker' && args[0] === 'compose' && args.includes('ps') && args.includes('-q')) {
      return execResult(true, Object.keys(containerStates).join('\n'));
    }
    if (command === 'docker' && args[0] === 'inspect') {
      const id = args.at(-1);
      return execResult(true, `/${id} ${containerStates[id] || 'running'}`);
    }

    return execResult(false, '', `Unexpected command: ${command} ${args.join(' ')}`);
  };

  execStub.calls = calls;
  return execStub;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function createTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-deploy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('resolveEnvFilePath maps named environments into deploy/environments', () => {
  const envPath = resolveEnvFilePath('production');
  assert.match(envPath, /deploy\/environments\/production\.env$/u);
});

test('runInitCommand writes an env file and preserves generated values on rerun', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'wot',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    operatorPubkey: OPERATOR_PUBKEY,
    wotMaxDepth: '2',
    wotMinFollowersDepth2: '2',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const firstConfig = await readEnvFile(envFile);

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'wot',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Updated Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    operatorPubkey: OPERATOR_PUBKEY,
    wotMaxDepth: '2',
    wotMinFollowersDepth2: '2',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const secondConfig = await readEnvFile(envFile);
  assert.equal(secondConfig.GATEWAY_DISCOVERY_DISPLAY_NAME, 'Updated Public Gateway');
  assert.equal(secondConfig.GATEWAY_REGISTRATION_SECRET, firstConfig.GATEWAY_REGISTRATION_SECRET);
  assert.equal(secondConfig.GATEWAY_RELAY_NAMESPACE, firstConfig.GATEWAY_RELAY_NAMESPACE);
  assert.equal(secondConfig.GATEWAY_RELAY_REPLICATION_TOPIC, firstConfig.GATEWAY_RELAY_REPLICATION_TOPIC);
  assert.equal(secondConfig.GATEWAY_RELAY_ADMIN_PUBLIC_KEY, firstConfig.GATEWAY_RELAY_ADMIN_PUBLIC_KEY);
  assert.equal(secondConfig.GATEWAY_RELAY_ADMIN_SECRET_KEY, firstConfig.GATEWAY_RELAY_ADMIN_SECRET_KEY);
});

test('runCheckCommand reports a missing env file', async () => {
  const io = createIo();
  const result = await runCheckCommand({
    deployEnv: join(tmpdir(), 'missing-gateway.env'),
    skipPortChecks: true
  }, io);

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Env file not found:/u);
});

test('runCheckCommand fails cleanly when Docker is unavailable', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'open',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const execStub = createExecStub({ dockerOk: false });
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Docker CLI is not available/u);
});

test('runCheckCommand surfaces docker compose config failures', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'allowlist',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    allowlistPubkeys: '2'.repeat(64)
  }, io);

  const execStub = createExecStub({ composeConfigOk: false });
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /docker compose config failed:/u);
});

test('runApplyCommand runs docker compose up after a successful check', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'open',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const execStub = createExecStub();
  await runApplyCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.ok(
    execStub.calls.some(
      ({ command, args }) => command === 'docker' && args[0] === 'compose' && args.includes('up')
    )
  );
});

test('runSmokeCommand checks container health and the open-profile secret endpoint', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'open',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const execStub = createExecStub({ containerStates: { 'public-gateway': 'running' } });
  const fetchCalls = [];
  const fetchStub = async (url) => {
    const text = String(url);
    fetchCalls.push(text);
    if (text.endsWith('/health')) return jsonResponse({ status: 'ok' });
    if (text.includes('/.well-known/hypertuna-gateway-secret')) return jsonResponse({ secret: 'ok' });
    throw new Error(`Unexpected fetch URL: ${text}`);
  };

  const result = await runSmokeCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    timeoutMs: '2000'
  }, io, execStub, fetchStub);

  assert.equal(result.health.body.status, 'ok');
  assert.ok(fetchCalls.some((url) => url.endsWith('/health')));
  assert.ok(fetchCalls.some((url) => url.includes('/.well-known/hypertuna-gateway-secret')));
});

test('runSmokeCommand can run deep auth validation from a local manifest', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const manifestPath = join(dir, 'manifest.json');
  const outPath = join(dir, 'auth-report.json');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'wot',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    operatorPubkey: OPERATOR_PUBKEY,
    wotMaxDepth: '1',
    wotMinFollowersDepth2: '0',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  await writeFile(manifestPath, JSON.stringify({
    accounts: [
      {
        role: 'operator',
        pubkeyHex: OPERATOR_PUBKEY,
        secretHex: OPERATOR_SECRET_HEX
      }
    ],
    policyMatrix: {
      operator: {
        wotDepth1: { result: 'ALLOW' }
      }
    }
  }, null, 2));

  const execStub = createExecStub({ containerStates: { 'public-gateway': 'running' } });
  const fetchStub = async (url, options = {}) => {
    const text = String(url);
    if (text.endsWith('/health')) return jsonResponse({ status: 'ok' });
    if (text.endsWith('/api/auth/challenge')) {
      const payload = JSON.parse(String(options.body));
      return jsonResponse({
        challengeId: `challenge-${payload.pubkey}`,
        nonce: `nonce-${payload.pubkey}`
      });
    }
    if (text.endsWith('/api/auth/verify')) {
      const payload = JSON.parse(String(options.body));
      if (payload.pubkey === OPERATOR_PUBKEY && payload.signature) {
        return jsonResponse({ token: 'issued-token' });
      }
      return jsonResponse({ error: 'forbidden' }, 403);
    }
    throw new Error(`Unexpected fetch URL: ${text}`);
  };

  const result = await runSmokeCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    authManifest: manifestPath,
    policyColumn: 'wotDepth1',
    out: outPath,
    timeoutMs: '2000'
  }, io, execStub, fetchStub);

  assert.equal(result.authReport.ok, true);
  assert.equal(result.authReport.results.length, 1);
  assert.equal(result.authReport.results[0].actual, 'ALLOW');
  assert.deepEqual(JSON.parse(await readFile(outPath, 'utf8')).ok, true);
  await stat(outPath.replace(/\.json$/u, '.md'));
});
