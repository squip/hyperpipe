#!/usr/bin/env node

import { parseArgs } from 'node:util';

import {
  runApplyCommand,
  runAttestOperatorCommand,
  runCheckCommand,
  runInitCommand,
  runSmokeCommand,
  usage
} from '../lib/commands.mjs';

function toOptionBag(values) {
  return {
    deployEnv: values['deploy-env'],
    profile: values.profile,
    exposureMode: values['exposure-mode'],
    host: values.host,
    email: values.email,
    displayName: values['display-name'],
    region: values.region,
    discoveryRelays: values['discovery-relays'],
    blindpeerPort: values['blindpeer-port'],
    allowlistPubkeys: values['allowlist-pubkeys'],
    blocklistPubkeys: values['blocklist-pubkeys'],
    operatorPubkey: values['operator-pubkey'],
    enableOperatorAttestation: values['enable-operator-attestation'] === true,
    wotRootPubkey: values['wot-root-pubkey'],
    wotMaxDepth: values['wot-max-depth'],
    wotMinFollowersDepth2: values['wot-min-followers-depth2'],
    authRelays: values['auth-relays'],
    nonInteractive: values['non-interactive'] === true,
    sudoDocker: values['sudo-docker'] === true,
    gatewayOrigin: values['gateway-origin'],
    authManifest: values['auth-manifest'],
    policyColumn: values['policy-column'],
    out: values.out,
    request: values.request,
    expiresDays: values['expires-days'],
    operatorSecret: values['operator-secret'],
    timeoutMs: values['timeout-ms'],
    scope: values.scope
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'deploy-env': { type: 'string' },
      profile: { type: 'string' },
      'exposure-mode': { type: 'string' },
      host: { type: 'string' },
      email: { type: 'string' },
      'display-name': { type: 'string' },
      region: { type: 'string' },
      'discovery-relays': { type: 'string' },
      'blindpeer-port': { type: 'string' },
      'allowlist-pubkeys': { type: 'string' },
      'blocklist-pubkeys': { type: 'string' },
      'operator-pubkey': { type: 'string' },
      'enable-operator-attestation': { type: 'boolean' },
      'wot-root-pubkey': { type: 'string' },
      'wot-max-depth': { type: 'string' },
      'wot-min-followers-depth2': { type: 'string' },
      'auth-relays': { type: 'string' },
      'non-interactive': { type: 'boolean' },
      'sudo-docker': { type: 'boolean' },
      'gateway-origin': { type: 'string' },
      'auth-manifest': { type: 'string' },
      'policy-column': { type: 'string' },
      out: { type: 'string' },
      request: { type: 'string' },
      'expires-days': { type: 'string' },
      'operator-secret': { type: 'string' },
      'timeout-ms': { type: 'string' },
      scope: { type: 'string' }
    }
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const options = toOptionBag(values);

  if (command === 'init') {
    await runInitCommand(options);
    return;
  }
  if (command === 'check') {
    const result = await runCheckCommand(options);
    if (!result.ok) process.exit(1);
    return;
  }
  if (command === 'apply') {
    await runApplyCommand(options);
    return;
  }
  if (command === 'smoke') {
    await runSmokeCommand(options);
    return;
  }
  if (command === 'attest-operator') {
    await runAttestOperatorCommand(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
