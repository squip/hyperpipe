#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(thisFile), '..');

const port = Number.isFinite(Number(process.env.PORT))
  ? Math.max(1, Math.trunc(Number(process.env.PORT)))
  : 4430;
const host = typeof process.env.HOST === 'string' && process.env.HOST.trim()
  ? process.env.HOST.trim()
  : '127.0.0.1';
const publicUrl = typeof process.env.GATEWAY_PUBLIC_URL === 'string' && process.env.GATEWAY_PUBLIC_URL.trim()
  ? process.env.GATEWAY_PUBLIC_URL.trim()
  : `http://${host}:${port}`;
const gatewayId = typeof process.env.GATEWAY_NOSTR_PUBKEY === 'string' && process.env.GATEWAY_NOSTR_PUBKEY.trim()
  ? process.env.GATEWAY_NOSTR_PUBKEY.trim()
  : `local-gateway-${host}-${port}`;
const manifestJson = process.env.GATEWAY_FEDERATION_MANIFEST_JSON || JSON.stringify({
  federationId: 'hypertuna-local-http',
  epoch: 1,
  minQuorum: 1,
  issuedAt: Date.now(),
  expiresAt: Date.now() + (24 * 60 * 60 * 1000),
  gateways: [{
    id: gatewayId,
    swarmPublicKey: gatewayId,
    role: 'voter',
    weight: 1,
    controlP2P: {
      topic: 'hypertuna-gateway-control-v2',
      protocol: 'gateway-control-v2'
    },
    controlHttp: {
      baseUrl: publicUrl
    },
    bridgeHttp: {
      baseUrl: publicUrl
    }
  }]
});

const env = {
  ...process.env,
  PORT: String(port),
  HOST: host,
  GATEWAY_TLS_ENABLED: 'false',
  GATEWAY_PUBLIC_URL: publicUrl,
  GATEWAY_NOSTR_PUBKEY: gatewayId,
  GATEWAY_FEDERATION_GATEWAY_ID: gatewayId,
  GATEWAY_FEDERATION_MANIFEST_JSON: manifestJson
};

console.log('[LocalGateway] Starting public gateway without TLS', {
  host,
  port,
  publicUrl,
  gatewayId
});

const child = spawn(process.execPath, ['src/index.mjs'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = Number.isFinite(Number(code)) ? Number(code) : 1;
});
