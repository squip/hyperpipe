import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseEnvText } from '../lib/env-file.mjs';
import {
  PROFILE_NAMES,
  buildOperatorAttestationRequestFromConfig,
  buildRuntimeConfig,
  defaultPolicyColumnForConfig,
  deriveGatewayIdFromSeed,
  validateConfig
} from '../lib/schema.mjs';

const OPERATOR_PUBKEY = '1'.repeat(64);
const ALLOWLIST_PUBKEYS = ['2'.repeat(64), '3'.repeat(64)].join(',');

function baseAnswers(overrides = {}) {
  return {
    GATEWAY_HOST: 'example.com',
    LETSENCRYPT_EMAIL: 'admin@example.com',
    GATEWAY_DISCOVERY_DISPLAY_NAME: 'Example Public Gateway',
    GATEWAY_NOSTR_DISCOVERY_RELAYS: 'wss://relay.damus.io/,wss://relay.primal.net/',
    ...overrides
  };
}

test('checked-in profile env files match supported profile names', async () => {
  for (const profile of PROFILE_NAMES) {
    const raw = await readFile(new URL(`../profiles/${profile}.env`, import.meta.url), 'utf8');
    const parsed = parseEnvText(raw);
    assert.equal(parsed.DEPLOY_PROFILE, profile);
    assert.equal(parsed.GATEWAY_AUTH_HOST_POLICY, profile);
  }
});

test('open profile config validates and clears profile-specific auth settings', () => {
  const config = buildRuntimeConfig({
    profile: 'open',
    answers: baseAnswers(),
    existing: {}
  });

  const validation = validateConfig(config);
  assert.deepEqual(validation.errors, []);
  assert.equal(config.GATEWAY_AUTH_HOST_POLICY, 'open');
  assert.equal(config.DEPLOY_EXPOSURE_MODE, 'https-acme');
  assert.equal(config.GATEWAY_DISCOVERY_OPEN_ACCESS, 'true');
  assert.equal(config.GATEWAY_AUTH_ALLOWLIST_PUBKEYS, '');
  assert.equal(config.GATEWAY_AUTH_OPERATOR_PUBKEY, '');
  assert.equal(config.GATEWAY_AUTH_WOT_ROOT_PUBKEY, '');
  assert.equal(config.GATEWAY_AUTH_WOT_RELAYS, '');
  assert.equal(config.GATEWAY_PUBLIC_URL, 'https://example.com');
  assert.match(config.GATEWAY_DISCOVERY_KEY_SEED, /^[0-9a-f]{64}$/u);
});

test('http exposure mode derives an http public URL and does not require letsencrypt email', () => {
  const config = buildRuntimeConfig({
    profile: 'open',
    answers: {
      ...baseAnswers({
        GATEWAY_HOST: '203.0.113.10',
        LETSENCRYPT_EMAIL: '',
        DEPLOY_EXPOSURE_MODE: 'http'
      })
    },
    existing: {}
  });

  const validation = validateConfig(config);
  assert.deepEqual(validation.errors, []);
  assert.equal(config.DEPLOY_EXPOSURE_MODE, 'http');
  assert.equal(config.LETSENCRYPT_EMAIL, '');
  assert.equal(config.GATEWAY_PUBLIC_URL, 'http://203.0.113.10');
});

test('https-acme exposure rejects raw IP hosts', () => {
  const config = buildRuntimeConfig({
    profile: 'open',
    answers: {
      ...baseAnswers({
        GATEWAY_HOST: '203.0.113.10'
      })
    },
    existing: {}
  });

  const validation = validateConfig(config);
  assert.match(
    validation.errors.join('\n'),
    /https-acme exposure requires GATEWAY_HOST to be a real hostname/
  );
});

test('allowlist profile requires allowlist pubkeys and validates when present', () => {
  const invalidConfig = buildRuntimeConfig({
    profile: 'allowlist',
    answers: baseAnswers(),
    existing: {}
  });
  const invalidValidation = validateConfig(invalidConfig);
  assert.match(
    invalidValidation.errors.join('\n'),
    /GATEWAY_AUTH_ALLOWLIST_PUBKEYS/
  );

  const validConfig = buildRuntimeConfig({
    profile: 'allowlist',
    answers: baseAnswers({
      GATEWAY_AUTH_ALLOWLIST_PUBKEYS: ALLOWLIST_PUBKEYS
    }),
    existing: {}
  });
  const validValidation = validateConfig(validConfig);
  assert.deepEqual(validValidation.errors, []);
  assert.equal(validConfig.GATEWAY_AUTH_HOST_POLICY, 'allowlist');
  assert.equal(validConfig.GATEWAY_DISCOVERY_OPEN_ACCESS, 'false');
  assert.equal(validConfig.GATEWAY_AUTH_ALLOWLIST_FILE, '/data/config/allowlist.json');
  assert.equal(validConfig.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS, '5000');
});

test('operator attestation request is derived from stable discovery seed and public URL', () => {
  const config = buildRuntimeConfig({
    profile: 'wot',
    answers: {
      ...baseAnswers({
        GATEWAY_AUTH_OPERATOR_PUBKEY: OPERATOR_PUBKEY,
        GATEWAY_AUTH_WOT_MAX_DEPTH: '2',
        GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2: '2',
        ENABLE_OPERATOR_ATTESTATION: 'true'
      })
    },
    existing: {}
  });

  const request = buildOperatorAttestationRequestFromConfig(config);
  assert.equal(config.GATEWAY_AUTH_OPERATOR_ATTESTATION_FILE, '/app/public-gateway/artifacts/operator-attestation.json');
  assert.equal(request.payload.operatorPubkey, OPERATOR_PUBKEY);
  assert.equal(request.payload.publicUrl, 'https://example.com');
  assert.equal(request.payload.gatewayId, deriveGatewayIdFromSeed(config.GATEWAY_DISCOVERY_KEY_SEED));
});

test('wot profile defaults root and auth relays and picks the correct default policy column', () => {
  const config = buildRuntimeConfig({
    profile: 'wot',
    answers: baseAnswers({
      GATEWAY_AUTH_OPERATOR_PUBKEY: OPERATOR_PUBKEY,
      GATEWAY_AUTH_WOT_MAX_DEPTH: '2',
      GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2: '2'
    }),
    existing: {}
  });

  const validation = validateConfig(config);
  assert.deepEqual(validation.errors, []);
  assert.equal(config.GATEWAY_AUTH_WOT_ROOT_PUBKEY, OPERATOR_PUBKEY);
  assert.equal(config.GATEWAY_AUTH_WOT_RELAYS, config.GATEWAY_NOSTR_DISCOVERY_RELAYS);
  assert.equal(defaultPolicyColumnForConfig(config), 'wotDepth2Threshold');
});

test('allowlist+wot profile validates the union of allowlist and wot settings', () => {
  const config = buildRuntimeConfig({
    profile: 'allowlist+wot',
    answers: baseAnswers({
      GATEWAY_AUTH_ALLOWLIST_PUBKEYS: ALLOWLIST_PUBKEYS,
      GATEWAY_AUTH_OPERATOR_PUBKEY: OPERATOR_PUBKEY,
      GATEWAY_AUTH_WOT_MAX_DEPTH: '2',
      GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2: '1',
      GATEWAY_AUTH_WOT_RELAYS: 'wss://relay.primal.net/,wss://nos.lol/'
    }),
    existing: {}
  });

  const validation = validateConfig(config);
  assert.deepEqual(validation.errors, []);
  assert.equal(config.GATEWAY_AUTH_HOST_POLICY, 'allowlist+wot');
  assert.equal(config.GATEWAY_AUTH_ALLOWLIST_FILE, '/data/config/allowlist.json');
  assert.equal(defaultPolicyColumnForConfig(config), 'allowlistPlusWot');
});

test('validation rejects mismatched profile and host policy', () => {
  const config = buildRuntimeConfig({
    profile: 'open',
    answers: baseAnswers(),
    existing: {}
  });
  config.GATEWAY_AUTH_HOST_POLICY = 'wot';

  const validation = validateConfig(config);
  assert.match(
    validation.errors.join('\n'),
    /GATEWAY_AUTH_HOST_POLICY must match DEPLOY_PROFILE/
  );
});
