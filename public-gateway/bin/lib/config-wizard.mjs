import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { schnorr } from '@noble/curves/secp256k1';

function normalizeHex64(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null;
  return normalized;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function parseCsv(inputValue) {
  return String(inputValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function promptWithDefault(rl, label, defaultValue) {
  const suffix = defaultValue !== undefined && defaultValue !== null && String(defaultValue).length
    ? ` [${defaultValue}]`
    : '';
  const value = await rl.question(`${label}${suffix}: `);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : (defaultValue ?? '');
}

async function runConfigWizard({ existing = {}, mode = 'init' } = {}) {
  const rl = createInterface({ input, output });
  try {
    output.write(`\nGateway setup wizard (${mode})\n`);
    const profileInput = await promptWithDefault(rl, 'Profile (local|internet)', existing.profile || 'local');
    const profile = profileInput.toLowerCase() === 'internet' ? 'internet' : 'local';

    const bindPort = profile === 'local'
      ? await promptWithDefault(rl, 'Gateway bind port', existing.gatewayBindPort || '4430')
      : '';

    const gatewayHost = profile === 'internet'
      ? await promptWithDefault(rl, 'Gateway host (DNS)', existing.gatewayHost || 'gateway.example.com')
      : '';

    const letsencryptEmail = profile === 'internet'
      ? await promptWithDefault(rl, 'Let\'s Encrypt email', existing.letsencryptEmail || 'admin@example.com')
      : '';

    const defaultPublicUrl = profile === 'internet'
      ? `https://${gatewayHost}`
      : `http://127.0.0.1:${bindPort || '4430'}`;
    const gatewayPublicUrl = await promptWithDefault(rl, 'Gateway public URL', existing.gatewayPublicUrl || defaultPublicUrl);

    const registrationSecret = await promptWithDefault(
      rl,
      'Registration secret (hex)',
      existing.registrationSecret || randomBytes(32).toString('hex')
    );

    const operatorNsecHex = normalizeHex64(await promptWithDefault(
      rl,
      'Operator nsec hex',
      existing.operatorNsecHex || randomBytes(32).toString('hex')
    ));
    if (!operatorNsecHex) {
      throw new Error('operator nsec must be a 64-char hex value');
    }

    const derivedOperatorPubkey = toHex(schnorr.getPublicKey(operatorNsecHex));
    const operatorPubkeyHex = normalizeHex64(await promptWithDefault(
      rl,
      'Operator pubkey hex',
      existing.operatorPubkeyHex || derivedOperatorPubkey
    ));
    if (!operatorPubkeyHex) {
      throw new Error('operator pubkey must be a 64-char hex value');
    }

    const policyRaw = await promptWithDefault(rl, 'Gateway policy (OPEN|CLOSED)', existing.policy || 'OPEN');
    const policy = String(policyRaw || '').trim().toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';

    const inviteOnly = ['1', 'true', 'yes', 'y'].includes(
      String(await promptWithDefault(rl, 'Invite only (true|false)', existing.inviteOnly ? 'true' : 'false')).trim().toLowerCase()
    );

    const allowList = parseCsv(await promptWithDefault(rl, 'Allow-list CSV', (existing.allowList || []).join(',')));
    const banList = parseCsv(await promptWithDefault(rl, 'Ban-list CSV', (existing.banList || []).join(',')));
    const discoveryRelays = parseCsv(await promptWithDefault(
      rl,
      'Discovery relay CSV',
      (existing.discoveryRelays || ['wss://relay.damus.io', 'wss://nos.lol']).join(',')
    ));

    const authJwtSecret = await promptWithDefault(
      rl,
      'Gateway JWT secret',
      existing.authJwtSecret || randomBytes(32).toString('hex')
    );

    const metricsEnabled = ['1', 'true', 'yes', 'y'].includes(
      String(await promptWithDefault(rl, 'Enable metrics (true|false)', existing.metricsEnabled === false ? 'false' : 'true'))
        .trim()
        .toLowerCase()
    );

    return {
      profile,
      gatewayBindPort: bindPort,
      gatewayHost,
      letsencryptEmail,
      gatewayPublicUrl,
      registrationSecret,
      operatorNsecHex,
      operatorPubkeyHex,
      policy,
      inviteOnly,
      allowList,
      banList,
      discoveryRelays,
      authJwtSecret,
      metricsEnabled
    };
  } finally {
    rl.close();
  }
}

function buildEnvMap(config = {}) {
  const profile = config.profile === 'internet' ? 'internet' : 'local';
  const redisPrefix = profile === 'internet'
    ? `public-gateway:${config.gatewayHost}:`
    : 'public-gateway:local:';
  const env = {
    GATEWAY_PROFILE: profile,
    GATEWAY_PUBLIC_URL: config.gatewayPublicUrl,
    GATEWAY_TLS_ENABLED: 'false',
    GATEWAY_METRICS_ENABLED: config.metricsEnabled ? 'true' : 'false',
    GATEWAY_METRICS_PATH: '/metrics',
    GATEWAY_RATELIMIT_ENABLED: 'true',
    GATEWAY_RATELIMIT_WINDOW: '60',
    GATEWAY_RATELIMIT_MAX: '120',
    GATEWAY_REGISTRATION_SECRET: config.registrationSecret,
    GATEWAY_REGISTRATION_REDIS: 'redis://redis:6379',
    GATEWAY_REGISTRATION_REDIS_PREFIX: redisPrefix,
    GATEWAY_REGISTRATION_TTL: '0',
    GATEWAY_MIRROR_METADATA_TTL: '0',
    GATEWAY_OPEN_JOIN_POOL_TTL: '0',
    GATEWAY_FEATURE_HYPERBEE_RELAY: 'true',
    GATEWAY_FEATURE_RELAY_DISPATCHER: 'true',
    GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT: 'true',
    GATEWAY_RELAY_STORAGE: '/data/gateway-relay',
    GATEWAY_BLINDPEER_ENABLED: 'true',
    GATEWAY_BLINDPEER_STORAGE: '/data/blind-peer',
    GATEWAY_ENABLE_MULTI: 'true',
    GATEWAY_OPERATOR_NSEC_HEX: config.operatorNsecHex,
    GATEWAY_OPERATOR_PUBKEY_HEX: config.operatorPubkeyHex,
    GATEWAY_POLICY: config.policy,
    GATEWAY_ALLOW_LIST: (config.allowList || []).join(','),
    GATEWAY_BAN_LIST: (config.banList || []).join(','),
    GATEWAY_DISCOVERY_RELAYS: (config.discoveryRelays || []).join(','),
    GATEWAY_INVITE_ONLY: config.inviteOnly ? 'true' : 'false',
    GATEWAY_AUTH_JWT_SECRET: config.authJwtSecret,
    GATEWAY_AUTH_TOKEN_TTL_SEC: '3600',
    GATEWAY_AUTH_CHALLENGE_TTL_MS: '120000',
    GATEWAY_AUTH_WINDOW_SEC: '300',
    GATEWAY_ADMIN_UI_ENABLED: 'true',
    GATEWAY_ADMIN_UI_PATH: '/admin',
    GATEWAY_ADMIN_SESSION_COOKIE_NAME: 'ht_gateway_admin',
    GATEWAY_ADMIN_SESSION_TTL_SEC: '3600',
    GATEWAY_ADMIN_ACTIVITY_RETENTION: '5000',
    GATEWAY_ADMIN_STATE_REDIS_PREFIX: 'gateway:admin:',
    PG_DEBUG_MULTI_GATEWAY: process.env.PG_DEBUG_MULTI_GATEWAY || '0'
  };

  if (profile === 'local') {
    env.GATEWAY_BIND_PORT = String(config.gatewayBindPort || '4430');
  }

  if (profile === 'internet') {
    env.GATEWAY_HOST = config.gatewayHost;
    env.LETSENCRYPT_EMAIL = config.letsencryptEmail;
  }

  return env;
}

export {
  runConfigWizard,
  buildEnvMap,
  normalizeHex64,
  parseCsv
};
