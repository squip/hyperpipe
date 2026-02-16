import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';

import {
  assert,
  ensureDir,
  findOpenPort,
  randomHex,
  requestJson,
  sanitizeIdentifier,
  waitFor,
  writeJsonFile,
  writeTextFile
} from './utils.mjs';

const GATEWAY_ALIAS = {
  a: 'gateway-a',
  b: 'gateway-b'
};

function normalizeGatewayAlias(value) {
  if (value === 'a' || value === 'gateway-a') return 'a';
  if (value === 'b' || value === 'gateway-b') return 'b';
  throw new Error(`Unknown gateway alias: ${value}`);
}

class DockerGatewayCluster {
  constructor({
    repoRoot,
    outputDir,
    composeFile,
    projectName,
    logger = null,
    minQuorum = 2,
    federationId = null,
    gatewayIds = null,
    gatewayPorts = null,
    trustPolicies = null,
    trustContexts = null
  }) {
    this.repoRoot = resolve(repoRoot);
    this.outputDir = resolve(outputDir);
    this.composeFile = composeFile
      ? resolve(composeFile)
      : resolve(this.repoRoot, 'public-gateway/e2e/docker/docker-compose.live.yml');
    this.projectName = sanitizeIdentifier(projectName, `ht-live-${randomHex(4)}`);
    this.logger = typeof logger === 'function' ? logger : null;
    this.minQuorum = Number.isFinite(Number(minQuorum)) ? Math.max(1, Math.round(Number(minQuorum))) : 2;
    this.federationId = federationId || `hypertuna-live-${randomHex(4)}`;
    this.gatewayIds = gatewayIds || {
      a: randomHex(32),
      b: randomHex(32)
    };
    this.gatewayPorts = {
      a: Number(gatewayPorts?.a) || null,
      b: Number(gatewayPorts?.b) || null
    };
    this.trustPolicies = trustPolicies || {
      a: {
        explicitAllowlist: [this.gatewayIds.a, this.gatewayIds.b],
        requireFollowedByMe: false,
        requireMutualFollow: false,
        minTrustedAttestations: 0,
        acceptedAttestorPubkeys: [],
        maxDescriptorAgeMs: 6 * 60 * 60 * 1000
      },
      b: {
        explicitAllowlist: [this.gatewayIds.a, this.gatewayIds.b],
        requireFollowedByMe: false,
        requireMutualFollow: false,
        minTrustedAttestations: 0,
        acceptedAttestorPubkeys: [],
        maxDescriptorAgeMs: 6 * 60 * 60 * 1000
      }
    };
    this.trustContexts = trustContexts || {
      a: { followsByMe: [], followersOfMe: [], attestations: [] },
      b: { followsByMe: [], followersOfMe: [], attestations: [] }
    };
    this.envPath = join(this.outputDir, 'docker.env');
    this.resolvedComposePath = join(this.outputDir, 'docker-compose.resolved.yml');
    this.started = false;
  }

  log(message, data = null) {
    if (!this.logger) return;
    this.logger(data ? `${message} ${JSON.stringify(data)}` : message);
  }

  gatewayBaseUrl(alias) {
    const id = normalizeGatewayAlias(alias);
    const port = this.gatewayPorts[id];
    if (!port) throw new Error(`Gateway port not initialized: ${id}`);
    return `http://127.0.0.1:${port}`;
  }

  internalGatewayBaseUrl(alias) {
    const id = normalizeGatewayAlias(alias);
    return `http://${GATEWAY_ALIAS[id]}:4430`;
  }

  async #assignPorts() {
    this.gatewayPorts.a = await findOpenPort({ preferredPort: this.gatewayPorts.a || 4630 });
    this.gatewayPorts.b = await findOpenPort({ preferredPort: this.gatewayPorts.b || 4631 });
    if (this.gatewayPorts.a === this.gatewayPorts.b) {
      this.gatewayPorts.b = await findOpenPort({});
    }
  }

  #buildManifest() {
    return {
      federationId: this.federationId,
      epoch: 1,
      minQuorum: this.minQuorum,
      issuedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      gateways: [
        {
          id: this.gatewayIds.a,
          swarmPublicKey: this.gatewayIds.a,
          role: 'voter',
          weight: 1,
          controlP2P: {
            topic: 'hypertuna-gateway-control-v2',
            protocol: 'gateway-control-v2',
            swarmPublicKey: this.gatewayIds.a
          },
          controlHttp: { baseUrl: this.internalGatewayBaseUrl('a') },
          bridgeHttp: { baseUrl: this.internalGatewayBaseUrl('a') }
        },
        {
          id: this.gatewayIds.b,
          swarmPublicKey: this.gatewayIds.b,
          role: 'voter',
          weight: 1,
          controlP2P: {
            topic: 'hypertuna-gateway-control-v2',
            protocol: 'gateway-control-v2',
            swarmPublicKey: this.gatewayIds.b
          },
          controlHttp: { baseUrl: this.internalGatewayBaseUrl('b') },
          bridgeHttp: { baseUrl: this.internalGatewayBaseUrl('b') }
        }
      ]
    };
  }

  async #prepareEnvironment() {
    await ensureDir(this.outputDir);
    await this.#assignPorts();

    const manifest = this.#buildManifest();
    const gatewayManifestJson = {
      a: JSON.stringify(manifest),
      b: JSON.stringify(manifest)
    };

    const env = {
      GW_A_ID: this.gatewayIds.a,
      GW_B_ID: this.gatewayIds.b,
      GW_A_HOST_PORT: String(this.gatewayPorts.a),
      GW_B_HOST_PORT: String(this.gatewayPorts.b),
      GW_A_PUBLIC_URL: this.gatewayBaseUrl('a'),
      GW_B_PUBLIC_URL: this.gatewayBaseUrl('b'),
      GW_A_MANIFEST_JSON: gatewayManifestJson.a,
      GW_B_MANIFEST_JSON: gatewayManifestJson.b,
      GW_A_TRUST_POLICY_JSON: JSON.stringify(this.trustPolicies?.a || {}),
      GW_B_TRUST_POLICY_JSON: JSON.stringify(this.trustPolicies?.b || {}),
      GW_A_TRUST_CONTEXT_JSON: JSON.stringify(this.trustContexts?.a || {}),
      GW_B_TRUST_CONTEXT_JSON: JSON.stringify(this.trustContexts?.b || {})
    };

    this.env = env;
    this.manifest = manifest;

    await this.#persistEnvFile();
    const composeText = await fs.readFile(this.composeFile, 'utf8');
    await writeTextFile(this.resolvedComposePath, composeText);
    await writeJsonFile(join(this.outputDir, 'cluster.json'), {
      projectName: this.projectName,
      env,
      manifest,
      composeFile: this.composeFile,
      outputDir: this.outputDir,
      generatedAt: Date.now()
    });
  }

  async #persistEnvFile() {
    const envText = Object.entries(this.env || {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    await writeTextFile(this.envPath, `${envText}\n`);
  }

  async #runCompose(args, {
    capture = true,
    allowFailure = false
  } = {}) {
    const commandArgs = [
      'compose',
      '-f',
      this.composeFile,
      '--project-name',
      this.projectName,
      '--env-file',
      this.envPath,
      ...args
    ];

    this.log('[DockerGatewayCluster] docker command', { args: commandArgs });

    return new Promise((resolve, reject) => {
      const child = spawn('docker', commandArgs, {
        cwd: this.repoRoot,
        env: process.env,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
      });

      let stdout = '';
      let stderr = '';

      if (capture) {
        child.stdout.on('data', (chunk) => {
          const text = String(chunk || '');
          stdout += text;
        });
        child.stderr.on('data', (chunk) => {
          const text = String(chunk || '');
          stderr += text;
        });
      }

      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0 && !allowFailure) {
          const error = new Error(`docker compose exited with code ${code}`);
          error.stdout = stdout;
          error.stderr = stderr;
          return reject(error);
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  async start() {
    await this.#prepareEnvironment();
    await this.#runCompose(['up', '-d', '--build'], { capture: true });
    this.started = true;
    await this.waitForHealthy();
  }

  async stop({ removeVolumes = true } = {}) {
    if (!this.env) return;
    const args = ['down', '--remove-orphans'];
    if (removeVolumes) args.push('-v');
    await this.#runCompose(args, {
      capture: true,
      allowFailure: true
    }).catch(() => null);
    this.started = false;
  }

  async waitForHealthy({ timeoutMs = 90_000 } = {}) {
    await waitFor(async () => {
      const health = await this.requestGateway('a', '/health', { timeoutMs: 3_000 });
      return health?.status === 'ok' ? health : null;
    }, {
      timeoutMs,
      intervalMs: 400,
      label: 'gateway-a health'
    });

    await waitFor(async () => {
      const health = await this.requestGateway('b', '/health', { timeoutMs: 3_000 });
      return health?.status === 'ok' ? health : null;
    }, {
      timeoutMs,
      intervalMs: 400,
      label: 'gateway-b health'
    });
  }

  async requestGateway(alias, path, options = {}) {
    const url = `${this.gatewayBaseUrl(alias)}${path}`;
    return requestJson(url, options);
  }

  async stopGateway(alias) {
    const id = normalizeGatewayAlias(alias);
    await this.#runCompose(['stop', GATEWAY_ALIAS[id]], { capture: true });
  }

  async startGateway(alias) {
    const id = normalizeGatewayAlias(alias);
    await this.#runCompose(['start', GATEWAY_ALIAS[id]], { capture: true });
    await waitFor(async () => {
      const health = await this.requestGateway(id, '/health', { timeoutMs: 3_000 });
      return health?.status === 'ok';
    }, {
      timeoutMs: 60_000,
      intervalMs: 300,
      label: `${GATEWAY_ALIAS[id]} restart health`
    });
  }

  async restartGateway(alias) {
    const id = normalizeGatewayAlias(alias);
    await this.#runCompose(['restart', GATEWAY_ALIAS[id]], { capture: true });
    await waitFor(async () => {
      const health = await this.requestGateway(id, '/health', { timeoutMs: 3_000 });
      return health?.status === 'ok';
    }, {
      timeoutMs: 60_000,
      intervalMs: 300,
      label: `${GATEWAY_ALIAS[id]} restart health`
    });
  }

  async collectLogs() {
    const outA = await this.#runCompose(['logs', '--no-color', 'gateway-a'], {
      capture: true,
      allowFailure: true
    });
    const outB = await this.#runCompose(['logs', '--no-color', 'gateway-b'], {
      capture: true,
      allowFailure: true
    });

    await writeTextFile(join(this.outputDir, 'gateway-a.log'), `${outA.stdout || ''}${outA.stderr || ''}`);
    await writeTextFile(join(this.outputDir, 'gateway-b.log'), `${outB.stdout || ''}${outB.stderr || ''}`);

    const ps = await this.#runCompose(['ps'], { capture: true, allowFailure: true });
    await writeTextFile(join(this.outputDir, 'docker-ps.txt'), `${ps.stdout || ''}${ps.stderr || ''}`);
  }

  async updateGatewayTrust(alias, {
    trustPolicy = null,
    trustContext = null,
    restart = true
  } = {}) {
    const id = normalizeGatewayAlias(alias);
    if (trustPolicy && typeof trustPolicy === 'object') {
      this.trustPolicies[id] = { ...trustPolicy };
      this.env[id === 'a' ? 'GW_A_TRUST_POLICY_JSON' : 'GW_B_TRUST_POLICY_JSON'] = JSON.stringify(trustPolicy);
    }
    if (trustContext && typeof trustContext === 'object') {
      this.trustContexts[id] = { ...trustContext };
      this.env[id === 'a' ? 'GW_A_TRUST_CONTEXT_JSON' : 'GW_B_TRUST_CONTEXT_JSON'] = JSON.stringify(trustContext);
    }
    await this.#persistEnvFile();
    if (restart) {
      await this.#runCompose(['up', '-d', '--force-recreate', GATEWAY_ALIAS[id]], { capture: true });
      await waitFor(async () => {
        const health = await this.requestGateway(id, '/health', { timeoutMs: 3_000 });
        return health?.status === 'ok';
      }, {
        timeoutMs: 90_000,
        intervalMs: 500,
        label: `${GATEWAY_ALIAS[id]} health after trust update`
      });
    }
  }

  workerGatewayConfig({ transportMode = null } = {}) {
    assert(this.env, 'cluster not initialized');
    const normalizedTransportMode = typeof transportMode === 'string' && transportMode.trim()
      ? transportMode.trim().toLowerCase()
      : 'p2p-first';
    return {
      federationId: this.federationId,
      enabled: true,
      networkMode: 'permissionless-wot',
      selectionMode: 'manual',
      controlTransportMode: normalizedTransportMode,
      selectedGatewayId: this.gatewayIds.a,
      activeGatewayId: this.gatewayIds.a,
      baseUrl: this.gatewayBaseUrl('a'),
      preferredBaseUrl: this.gatewayBaseUrl('a'),
      preferredGatewayIds: [this.gatewayIds.a, this.gatewayIds.b],
      trustPolicy: {
        explicitAllowlist: [this.gatewayIds.a, this.gatewayIds.b],
        requireFollowedByMe: false,
        requireMutualFollow: false,
        minTrustedAttestations: 0,
        acceptedAttestorPubkeys: [],
        maxDescriptorAgeMs: 6 * 60 * 60 * 1000
      },
      gateways: {
        [this.gatewayIds.a]: {
          id: this.gatewayIds.a,
          nostrPubkey: this.gatewayIds.a,
          swarmPublicKey: this.gatewayIds.a,
          controlTopic: 'hypertuna-gateway-control-v2',
          baseUrl: this.gatewayBaseUrl('a'),
          wsUrl: null,
          trust: 'trusted',
          health: 'healthy'
        },
        [this.gatewayIds.b]: {
          id: this.gatewayIds.b,
          nostrPubkey: this.gatewayIds.b,
          swarmPublicKey: this.gatewayIds.b,
          controlTopic: 'hypertuna-gateway-control-v2',
          baseUrl: this.gatewayBaseUrl('b'),
          wsUrl: null,
          trust: 'trusted',
          health: 'healthy'
        }
      }
    };
  }
}

export default DockerGatewayCluster;
