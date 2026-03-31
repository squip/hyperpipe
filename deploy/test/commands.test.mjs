import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { schnorr } from '@noble/curves/secp256k1';

import { readEnvFile } from '../lib/env-file.mjs';
import {
  resolveEnvFilePath,
  runApplyCommand,
  runAttestOperatorCommand,
  runCheckCommand,
  runInitCommand,
  runSmokeCommand
} from '../lib/commands.mjs';
import { verifyOperatorAttestation } from '@hyperpipe/bridge/public-gateway/OperatorAttestation';

const OPERATOR_SECRET_HEX = '7'.repeat(64);
const OPERATOR_PUBKEY = Buffer.from(
  schnorr.getPublicKey(Buffer.from(OPERATOR_SECRET_HEX, 'hex'))
).toString('hex');
const DEPLOY_DIR = dirname(new URL('../lib/commands.mjs', import.meta.url).pathname);
const DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE = join(DEPLOY_DIR, '..', 'artifacts', 'operator-attestation-request.json');
const DEFAULT_OPERATOR_ATTESTATION_FILE = join(DEPLOY_DIR, '..', 'artifacts', 'operator-attestation.json');

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
  dockerInfoStderr = 'daemon unavailable',
  composeConfigOk = true,
  composeUpOk = true,
  containerStates = { gateway: 'running' }
} = {}) {
  const calls = [];
  const execStub = async (command, args) => {
    calls.push({ command, args });

    if (command === 'sudo') {
      command = args[0];
      args = args.slice(1);
    }

    if (command === 'docker' && args[0] === '--version') {
      return dockerOk ? execResult(true, 'Docker version 26.0.0') : execResult(false, '', 'docker missing');
    }
    if (command === 'docker' && args[0] === 'compose' && args[1] === 'version') {
      return composeOk ? execResult(true, 'Docker Compose version v2.29.0') : execResult(false, '', 'compose missing');
    }
    if (command === 'docker-compose' && args[0] === 'version') {
      return composeOk ? execResult(true, 'docker-compose version 1.29.2') : execResult(false, '', 'compose missing');
    }
    if (command === 'docker' && args[0] === 'info') {
      return dockerInfoOk ? execResult(true, 'Docker info') : execResult(false, '', dockerInfoStderr);
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
  assert.equal(secondConfig.DEPLOY_EXPOSURE_MODE, 'https-acme');
  assert.equal(secondConfig.GATEWAY_REGISTRATION_SECRET, firstConfig.GATEWAY_REGISTRATION_SECRET);
  assert.equal(secondConfig.GATEWAY_RELAY_NAMESPACE, firstConfig.GATEWAY_RELAY_NAMESPACE);
  assert.equal(secondConfig.GATEWAY_RELAY_REPLICATION_TOPIC, firstConfig.GATEWAY_RELAY_REPLICATION_TOPIC);
  assert.equal(secondConfig.GATEWAY_RELAY_ADMIN_PUBLIC_KEY, firstConfig.GATEWAY_RELAY_ADMIN_PUBLIC_KEY);
  assert.equal(secondConfig.GATEWAY_RELAY_ADMIN_SECRET_KEY, firstConfig.GATEWAY_RELAY_ADMIN_SECRET_KEY);
});

test('runInitCommand supports http exposure mode without letsencrypt email', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'open',
    exposureMode: 'http',
    host: '203.0.113.10',
    displayName: 'IP Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const config = await readEnvFile(envFile);
  assert.equal(config.DEPLOY_EXPOSURE_MODE, 'http');
  assert.equal(config.LETSENCRYPT_EMAIL, '');
  assert.equal(config.GATEWAY_PUBLIC_URL, 'http://203.0.113.10');
});

test('runInitCommand generates an operator attestation request when enabled', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  t.after(async () => {
    await rm(DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE, { force: true });
    await rm(DEFAULT_OPERATOR_ATTESTATION_FILE, { force: true });
  });

  const result = await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'wot',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    operatorPubkey: OPERATOR_PUBKEY,
    enableOperatorAttestation: true,
    wotMaxDepth: '2',
    wotMinFollowersDepth2: '2',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  assert.equal(result.config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE, '/app/public-gateway/artifacts/operator-attestation.json');
  const requestRaw = await readFile(DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE, 'utf8');
  const request = JSON.parse(requestRaw);
  assert.equal(request.payload.operatorPubkey, OPERATOR_PUBKEY);
  assert.equal(request.payload.publicUrl, 'https://example.com');
  assert.match(io.stdoutText, /Verified operator identity is enabled/u);
});

test('runAttestOperatorCommand signs an attestation artifact that verifies cleanly', async (t) => {
  const dir = await createTempDir(t);
  const io = createIo();
  const requestPath = join(dir, 'operator-attestation-request.json');
  const outputPath = join(dir, 'operator-attestation.json');
  await writeFile(requestPath, JSON.stringify({
    version: 1,
    payload: {
      purpose: 'gateway-operator-attestation',
      operatorPubkey: OPERATOR_PUBKEY,
      gatewayId: '2'.repeat(64),
      publicUrl: 'https://gateway.example'
    }
  }, null, 2));

  const result = await runAttestOperatorCommand({
    request: requestPath,
    out: outputPath,
    expiresDays: '365',
    operatorSecret: OPERATOR_SECRET_HEX
  }, io);

  const verification = verifyOperatorAttestation(result.attestation, {
    expectedOperatorPubkey: OPERATOR_PUBKEY,
    expectedGatewayId: '2'.repeat(64),
    expectedPublicUrl: 'https://gateway.example',
    schnorrImpl: schnorr
  });
  assert.equal(verification.ok, true);
  const fileStats = await stat(outputPath);
  assert.ok(fileStats.size > 0);
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

test('runCheckCommand validates operator attestation artifacts and warns near expiry', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  t.after(async () => {
    await rm(DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE, { force: true });
    await rm(DEFAULT_OPERATOR_ATTESTATION_FILE, { force: true });
  });

  const initResult = await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'wot',
    host: 'example.com',
    email: 'admin@example.com',
    displayName: 'Example Public Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    operatorPubkey: OPERATOR_PUBKEY,
    enableOperatorAttestation: true,
    wotMaxDepth: '2',
    wotMinFollowersDepth2: '2',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  await runAttestOperatorCommand({
    request: DEFAULT_OPERATOR_ATTESTATION_REQUEST_FILE,
    out: DEFAULT_OPERATOR_ATTESTATION_FILE,
    operatorSecret: OPERATOR_SECRET_HEX,
    expiresDays: '20'
  }, io);

  const execStub = createExecStub();
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(initResult.config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE, '/app/public-gateway/artifacts/operator-attestation.json');
  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /Operator attestation expires within 30 days/u);
});

test('runCheckCommand surfaces docker socket permission errors clearly', async (t) => {
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

  const execStub = createExecStub({
    dockerInfoOk: false,
    dockerInfoStderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
  });
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Docker daemon socket is not accessible to the current user/u);
  assert.match(result.errors.join('\n'), /--sudo-docker/u);
});

test('runCheckCommand supports a sudo docker wrapper when requested', async (t) => {
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
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    sudoDocker: true
  }, io, execStub);

  assert.equal(result.ok, true);
  const sudoCalls = execStub.calls.filter((entry) => entry.command === 'sudo');
  assert.ok(sudoCalls.length > 0);
  assert.ok(sudoCalls.some((entry) => entry.args[0] === 'docker'));
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
  assert.ok(
    execStub.calls.some(
      ({ command, args }) => command === 'docker' && args[0] === 'compose' && args.some((arg) => String(arg).endsWith('/deploy/docker-compose.https-acme.yml'))
    )
  );
});

test('runCheckCommand selects the http compose override for http exposure mode', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'open',
    exposureMode: 'http',
    host: '203.0.113.10',
    displayName: 'IP Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const execStub = createExecStub();
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(result.ok, true);
  assert.ok(
    execStub.calls.some(
      ({ command, args }) => command === 'docker' && args[0] === 'compose' && args.some((arg) => String(arg).endsWith('/deploy/docker-compose.http.yml'))
    )
  );
});

test('runCheckCommand adds the site overlay when SITE_ENABLED is true', async (t) => {
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

  await writeFile(envFile, `${(await readFile(envFile, 'utf8')).trim()}\nSITE_ENABLED=true\nSITE_HOST=hyperpipe.io\nSITE_WWW_HOST=www.hyperpipe.io\nHYPERPIPE_SITE_ROOT=/srv/hyperpipe-site/current\n`, 'utf8');

  const execStub = createExecStub();
  const result = await runCheckCommand({
    deployEnv: envFile,
    skipPortChecks: true
  }, io, execStub);

  assert.equal(result.ok, true);
  assert.ok(
    execStub.calls.some(
      ({ command, args }) => command === 'docker' && args[0] === 'compose' && args.some((arg) => String(arg).endsWith('/deploy/docker-compose.site.yml'))
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
    if (text.includes('/.well-known/hyperpipe-gateway-secret')) return jsonResponse({ secret: 'ok' });
    throw new Error(`Unexpected fetch URL: ${text}`);
  };

  const result = await runSmokeCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    timeoutMs: '2000'
  }, io, execStub, fetchStub);

  assert.equal(result.health.body.status, 'ok');
  assert.ok(fetchCalls.some((url) => url.endsWith('/health')));
  assert.ok(fetchCalls.some((url) => url.includes('/.well-known/hyperpipe-gateway-secret')));
});

test('runSmokeCommand uses http origin for http exposure mode', async (t) => {
  const dir = await createTempDir(t);
  const envFile = join(dir, 'gateway.env');
  const io = createIo();

  await runInitCommand({
    deployEnv: envFile,
    nonInteractive: true,
    profile: 'allowlist+wot',
    exposureMode: 'http',
    host: '203.0.113.10',
    displayName: 'IP Gateway',
    discoveryRelays: 'wss://relay.damus.io/,wss://relay.primal.net/',
    allowlistPubkeys: '2'.repeat(64),
    operatorPubkey: OPERATOR_PUBKEY,
    wotMaxDepth: '1',
    wotMinFollowersDepth2: '0',
    authRelays: 'wss://relay.damus.io/,wss://relay.primal.net/'
  }, io);

  const execStub = createExecStub({ containerStates: { 'public-gateway': 'running' } });
  const fetchCalls = [];
  const fetchStub = async (url) => {
    const text = String(url);
    fetchCalls.push(text);
    if (text === 'http://203.0.113.10/health') return jsonResponse({ status: 'ok' });
    throw new Error(`Unexpected fetch URL: ${text}`);
  };

  const result = await runSmokeCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    timeoutMs: '2000'
  }, io, execStub, fetchStub);

  assert.equal(result.gatewayOrigin, 'http://203.0.113.10');
  assert.deepEqual(fetchCalls, ['http://203.0.113.10/health']);
});

test('runSmokeCommand checks the static site health endpoint when SITE_ENABLED is true', async (t) => {
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

  await writeFile(envFile, `${(await readFile(envFile, 'utf8')).trim()}\nSITE_ENABLED=true\nSITE_HOST=hyperpipe.io\nSITE_WWW_HOST=www.hyperpipe.io\nHYPERPIPE_SITE_ROOT=/srv/hyperpipe-site/current\n`, 'utf8');

  const execStub = createExecStub({ containerStates: { 'public-gateway': 'running', 'public-site': 'running' } });
  const fetchCalls = [];
  const fetchStub = async (url) => {
    const text = String(url);
    fetchCalls.push(text);
    if (text === 'https://example.com/health') return jsonResponse({ status: 'ok' });
    if (text === 'https://hyperpipe.io/healthz') return jsonResponse({ status: 'ok' });
    if (text.includes('/.well-known/hyperpipe-gateway-secret')) return jsonResponse({ secret: 'ok' });
    throw new Error(`Unexpected fetch URL: ${text}`);
  };

  const result = await runSmokeCommand({
    deployEnv: envFile,
    skipPortChecks: true,
    timeoutMs: '2000'
  }, io, execStub, fetchStub);

  assert.equal(result.health.body.status, 'ok');
  assert.ok(fetchCalls.includes('https://hyperpipe.io/healthz'));
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
