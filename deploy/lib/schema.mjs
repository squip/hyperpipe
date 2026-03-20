import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { schnorr } from '@noble/curves/secp256k1';
import { parseEnvText } from './env-file.mjs';

export const PROFILE_NAMES = ['open', 'allowlist', 'wot', 'allowlist+wot'];

export const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.damus.io/',
  'wss://relay.primal.net/',
  'wss://nos.lol/'
];

export const ENV_SECTIONS = [
  {
    comment: 'Deploy metadata',
    keys: ['DEPLOY_PROFILE', 'GATEWAY_HOST', 'LETSENCRYPT_EMAIL']
  },
  {
    comment: 'Gateway base configuration',
    keys: [
      'GATEWAY_PUBLIC_URL',
      'GATEWAY_REGISTRATION_SECRET',
      'GATEWAY_DISCOVERY_ENABLED',
      'GATEWAY_DISCOVERY_OPEN_ACCESS',
      'GATEWAY_DISCOVERY_DISPLAY_NAME',
      'GATEWAY_DISCOVERY_REGION',
      'GATEWAY_NOSTR_DISCOVERY_RELAYS',
      'GATEWAY_REGISTRATION_REDIS',
      'GATEWAY_REGISTRATION_REDIS_PREFIX',
      'GATEWAY_DEFAULT_TOKEN_TTL',
      'STORAGE_DIR'
    ]
  },
  {
    comment: 'Gateway auth configuration',
    keys: [
      'GATEWAY_AUTH_HOST_POLICY',
      'GATEWAY_AUTH_MEMBER_DELEGATION',
      'GATEWAY_AUTH_OPERATOR_PUBKEY',
      'GATEWAY_AUTH_ALLOWLIST_PUBKEYS',
      'GATEWAY_AUTH_ALLOWLIST_FILE',
      'GATEWAY_AUTH_ALLOWLIST_REFRESH_MS',
      'GATEWAY_AUTH_WOT_ROOT_PUBKEY',
      'GATEWAY_AUTH_WOT_MAX_DEPTH',
      'GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2',
      'GATEWAY_AUTH_WOT_RELAYS',
      'GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS',
      'GATEWAY_AUTH_WOT_REFRESH_MS'
    ]
  },
  {
    comment: 'Relay host and dispatcher',
    keys: [
      'GATEWAY_FEATURE_HYPERBEE_RELAY',
      'GATEWAY_RELAY_STORAGE',
      'GATEWAY_RELAY_NAMESPACE',
      'GATEWAY_RELAY_REPLICATION_TOPIC',
      'GATEWAY_RELAY_ADMIN_PUBLIC_KEY',
      'GATEWAY_RELAY_ADMIN_SECRET_KEY',
      'GATEWAY_FEATURE_RELAY_DISPATCHER',
      'GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT',
      'GATEWAY_DISPATCHER_MAX_CONCURRENT',
      'GATEWAY_DISPATCHER_INFLIGHT_WEIGHT',
      'GATEWAY_DISPATCHER_LATENCY_WEIGHT',
      'GATEWAY_DISPATCHER_FAILURE_WEIGHT',
      'GATEWAY_DISPATCHER_REASSIGN_LAG',
      'GATEWAY_DISPATCHER_CIRCUIT_BREAKER_THRESHOLD',
      'GATEWAY_DISPATCHER_CIRCUIT_BREAKER_TIMEOUT_MS'
    ]
  },
  {
    comment: 'Blind peer settings',
    keys: [
      'GATEWAY_BLINDPEER_ENABLED',
      'GATEWAY_BLINDPEER_STORAGE',
      'GATEWAY_BLINDPEER_PORT',
      'GATEWAY_BLINDPEER_MAX_BYTES',
      'GATEWAY_BLINDPEER_GC_INTERVAL_MS',
      'GATEWAY_BLINDPEER_TRUSTED_PATH'
    ]
  },
  {
    comment: 'Operational settings',
    keys: [
      'GATEWAY_OPEN_JOIN_POOL_TTL',
      'GATEWAY_METRICS_ENABLED',
      'GATEWAY_LOG_DIR',
      'GATEWAY_LOG_PREFIX',
      'GATEWAY_LOG_ROTATE_MS',
      'GATEWAY_LOG_RETENTION_MS'
    ]
  }
];

export const FIELD_CLASSIFICATIONS = {
  GATEWAY_HOST: 'prompted',
  LETSENCRYPT_EMAIL: 'prompted',
  DEPLOY_PROFILE: 'prompted',
  GATEWAY_DISCOVERY_DISPLAY_NAME: 'prompted',
  GATEWAY_DISCOVERY_REGION: 'prompted_optional',
  GATEWAY_NOSTR_DISCOVERY_RELAYS: 'prompted',
  GATEWAY_AUTH_ALLOWLIST_PUBKEYS: 'prompted_profile',
  GATEWAY_AUTH_OPERATOR_PUBKEY: 'prompted_profile',
  GATEWAY_AUTH_ALLOWLIST_FILE: 'derived',
  GATEWAY_AUTH_ALLOWLIST_REFRESH_MS: 'derived',
  GATEWAY_AUTH_WOT_ROOT_PUBKEY: 'prompted_profile_optional',
  GATEWAY_AUTH_WOT_MAX_DEPTH: 'prompted_profile',
  GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2: 'prompted_profile',
  GATEWAY_AUTH_WOT_RELAYS: 'prompted_profile',
  GATEWAY_PUBLIC_URL: 'derived',
  GATEWAY_REGISTRATION_REDIS_PREFIX: 'derived',
  GATEWAY_REGISTRATION_SECRET: 'generated',
  GATEWAY_RELAY_NAMESPACE: 'generated',
  GATEWAY_RELAY_REPLICATION_TOPIC: 'generated',
  GATEWAY_RELAY_ADMIN_PUBLIC_KEY: 'generated',
  GATEWAY_RELAY_ADMIN_SECRET_KEY: 'generated',
  GATEWAY_BLINDPEER_PORT: 'generated'
};

function loadProfilePreset(profile) {
  const raw = readFileSync(new URL(`../profiles/${profile}.env`, import.meta.url), 'utf8');
  return parseEnvText(raw);
}

const PROFILE_PRESETS = Object.fromEntries(
  PROFILE_NAMES.map((profile) => [profile, loadProfilePreset(profile)])
);

const BASE_DEFAULTS = {
  GATEWAY_DISCOVERY_ENABLED: 'true',
  GATEWAY_DISCOVERY_DISPLAY_NAME: '',
  GATEWAY_DISCOVERY_REGION: '',
  GATEWAY_NOSTR_DISCOVERY_RELAYS: DEFAULT_DISCOVERY_RELAYS.join(','),
  GATEWAY_REGISTRATION_REDIS: 'redis://redis:6379',
  GATEWAY_DEFAULT_TOKEN_TTL: '3600',
  STORAGE_DIR: '/data',
  GATEWAY_AUTH_ALLOWLIST_FILE: '',
  GATEWAY_AUTH_ALLOWLIST_REFRESH_MS: '5000',
  GATEWAY_FEATURE_HYPERBEE_RELAY: 'true',
  GATEWAY_RELAY_STORAGE: '/data/gateway-relay',
  GATEWAY_FEATURE_RELAY_DISPATCHER: 'false',
  GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT: 'true',
  GATEWAY_DISPATCHER_MAX_CONCURRENT: '3',
  GATEWAY_DISPATCHER_INFLIGHT_WEIGHT: '25',
  GATEWAY_DISPATCHER_LATENCY_WEIGHT: '1',
  GATEWAY_DISPATCHER_FAILURE_WEIGHT: '500',
  GATEWAY_DISPATCHER_REASSIGN_LAG: '500',
  GATEWAY_DISPATCHER_CIRCUIT_BREAKER_THRESHOLD: '5',
  GATEWAY_DISPATCHER_CIRCUIT_BREAKER_TIMEOUT_MS: '60000',
  GATEWAY_BLINDPEER_ENABLED: 'true',
  GATEWAY_BLINDPEER_STORAGE: '/data/blind-peer',
  GATEWAY_BLINDPEER_MAX_BYTES: String(25 * 1024 ** 3),
  GATEWAY_BLINDPEER_GC_INTERVAL_MS: '300000',
  GATEWAY_BLINDPEER_TRUSTED_PATH: '/data/blind-peer/trusted-peers.json',
  GATEWAY_OPEN_JOIN_POOL_TTL: '0',
  GATEWAY_METRICS_ENABLED: 'true',
  GATEWAY_LOG_DIR: '/app/public-gateway/logs',
  GATEWAY_LOG_PREFIX: 'public-gateway',
  GATEWAY_LOG_ROTATE_MS: '1200000',
  GATEWAY_LOG_RETENTION_MS: '604800000'
};

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHost(value) {
  const trimmed = normalizeString(value).replace(/^https?:\/\//iu, '').replace(/\/+$/u, '');
  return trimmed;
}

function normalizeCsv(input) {
  return String(input || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function csvToString(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))).join(',');
}

export function normalizeProfile(value) {
  const trimmed = normalizeString(value).toLowerCase();
  return PROFILE_NAMES.includes(trimmed) ? trimmed : '';
}

export function deriveProfile(config = {}) {
  const explicit = normalizeProfile(config.DEPLOY_PROFILE);
  if (explicit) return explicit;
  const policy = normalizeString(config.GATEWAY_AUTH_HOST_POLICY).toLowerCase();
  return normalizeProfile(policy);
}

export function profilePreset(profile) {
  const normalized = normalizeProfile(profile) || 'open';
  return { ...PROFILE_PRESETS[normalized] };
}

function generateHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function generateIdentifier(prefix) {
  return `${prefix}-${generateHex(6)}`;
}

function deriveDisplayName(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return 'Public Gateway';
  return `${normalizedHost} Public Gateway`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizeString(value));
}

function isHex64(value) {
  return /^[0-9a-f]{64}$/iu.test(normalizeString(value));
}

function isPositiveIntegerString(value, { allowZero = false } = {}) {
  const text = normalizeString(value);
  if (!/^\d+$/u.test(text)) return false;
  if (allowZero) return true;
  return Number(text) > 0;
}

function isTruthyFalsey(value) {
  return ['true', 'false'].includes(normalizeString(value).toLowerCase());
}

function isValidPublicUrl(value) {
  const text = normalizeString(value);
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isValidHost(value) {
  const text = normalizeHost(value);
  return Boolean(text) && !/[\/\s]/u.test(text);
}

function isValidWsRelayList(value) {
  const entries = normalizeCsv(value);
  if (!entries.length) return false;
  return entries.every((entry) => {
    try {
      const parsed = new URL(entry);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  });
}

function isValidPubkeyList(value) {
  const entries = normalizeCsv(value);
  return entries.length > 0 && entries.every((entry) => isHex64(entry));
}

function maybeEmptyPubkey(value) {
  const text = normalizeString(value);
  return text === '' || isHex64(text);
}

function normalizeNumberString(value, fallback) {
  const text = normalizeString(value);
  if (!/^\d+$/u.test(text)) return String(fallback);
  return String(Number.parseInt(text, 10));
}

export function createGeneratedValues(existing = {}) {
  const relayAdminSecretKey = isHex64(existing.GATEWAY_RELAY_ADMIN_SECRET_KEY)
    ? existing.GATEWAY_RELAY_ADMIN_SECRET_KEY
    : generateHex(32);
  const relayAdminPublicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(relayAdminSecretKey, 'hex'))).toString('hex');
  return {
    GATEWAY_REGISTRATION_SECRET: isHex64(existing.GATEWAY_REGISTRATION_SECRET)
      ? existing.GATEWAY_REGISTRATION_SECRET
      : generateHex(32),
    GATEWAY_RELAY_NAMESPACE: normalizeString(existing.GATEWAY_RELAY_NAMESPACE) || generateIdentifier('gateway-relay'),
    GATEWAY_RELAY_REPLICATION_TOPIC: normalizeString(existing.GATEWAY_RELAY_REPLICATION_TOPIC) || generateIdentifier('gateway-network'),
    GATEWAY_RELAY_ADMIN_SECRET_KEY: relayAdminSecretKey,
    GATEWAY_RELAY_ADMIN_PUBLIC_KEY: relayAdminPublicKey,
    GATEWAY_BLINDPEER_PORT: normalizeNumberString(existing.GATEWAY_BLINDPEER_PORT, 31000)
  };
}

function toDerivedValues(config) {
  return {
    GATEWAY_PUBLIC_URL: `https://${normalizeHost(config.GATEWAY_HOST)}`,
    GATEWAY_REGISTRATION_REDIS_PREFIX: `public-gateway:${normalizeHost(config.GATEWAY_HOST)}:`
  };
}

export function buildRuntimeConfig({ profile, answers = {}, existing = {} }) {
  const normalizedProfile = normalizeProfile(profile || answers.DEPLOY_PROFILE || existing.DEPLOY_PROFILE) || 'open';
  const preset = profilePreset(normalizedProfile);
  const generated = createGeneratedValues(existing);

  const host = normalizeHost(answers.GATEWAY_HOST || existing.GATEWAY_HOST);
  const email = normalizeString(answers.LETSENCRYPT_EMAIL || existing.LETSENCRYPT_EMAIL);
  const discoveryRelays = csvToString(
    normalizeCsv(answers.GATEWAY_NOSTR_DISCOVERY_RELAYS || existing.GATEWAY_NOSTR_DISCOVERY_RELAYS || BASE_DEFAULTS.GATEWAY_NOSTR_DISCOVERY_RELAYS)
  );
  const displayName = normalizeString(
    answers.GATEWAY_DISCOVERY_DISPLAY_NAME ||
    existing.GATEWAY_DISCOVERY_DISPLAY_NAME ||
    deriveDisplayName(host)
  );
  const region = normalizeString(answers.GATEWAY_DISCOVERY_REGION ?? existing.GATEWAY_DISCOVERY_REGION ?? '');
  const wotRelays = csvToString(
    normalizeCsv(
      answers.GATEWAY_AUTH_WOT_RELAYS ||
      existing.GATEWAY_AUTH_WOT_RELAYS ||
      discoveryRelays
    )
  );

  const merged = {
    ...BASE_DEFAULTS,
    ...preset,
    ...generated,
    GATEWAY_HOST: host,
    LETSENCRYPT_EMAIL: email,
    GATEWAY_DISCOVERY_DISPLAY_NAME: displayName,
    GATEWAY_DISCOVERY_REGION: region,
    GATEWAY_NOSTR_DISCOVERY_RELAYS: discoveryRelays
  };

  merged.DEPLOY_PROFILE = normalizedProfile;
  merged.GATEWAY_BLINDPEER_PORT = normalizeNumberString(
    answers.GATEWAY_BLINDPEER_PORT || existing.GATEWAY_BLINDPEER_PORT || generated.GATEWAY_BLINDPEER_PORT,
    31000
  );
  merged.GATEWAY_AUTH_ALLOWLIST_PUBKEYS = csvToString(
    normalizeCsv(answers.GATEWAY_AUTH_ALLOWLIST_PUBKEYS || existing.GATEWAY_AUTH_ALLOWLIST_PUBKEYS)
  );
  merged.GATEWAY_AUTH_OPERATOR_PUBKEY = normalizeString(
    answers.GATEWAY_AUTH_OPERATOR_PUBKEY || existing.GATEWAY_AUTH_OPERATOR_PUBKEY
  ).toLowerCase();
  merged.GATEWAY_AUTH_ALLOWLIST_FILE = normalizeString(
    existing.GATEWAY_AUTH_ALLOWLIST_FILE
    || (normalizedProfile === 'allowlist' || normalizedProfile === 'allowlist+wot'
      ? '/data/config/allowlist.json'
      : '')
  );
  merged.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS = normalizeNumberString(
    answers.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS || existing.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS || BASE_DEFAULTS.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS,
    5000
  );
  merged.GATEWAY_AUTH_WOT_ROOT_PUBKEY = normalizeString(
    answers.GATEWAY_AUTH_WOT_ROOT_PUBKEY || existing.GATEWAY_AUTH_WOT_ROOT_PUBKEY || merged.GATEWAY_AUTH_OPERATOR_PUBKEY
  ).toLowerCase();
  merged.GATEWAY_AUTH_WOT_MAX_DEPTH = normalizeNumberString(
    answers.GATEWAY_AUTH_WOT_MAX_DEPTH || existing.GATEWAY_AUTH_WOT_MAX_DEPTH || preset.GATEWAY_AUTH_WOT_MAX_DEPTH,
    1
  );
  merged.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 = normalizeNumberString(
    answers.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 || existing.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 || preset.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2,
    0
  );
  merged.GATEWAY_AUTH_WOT_RELAYS = normalizedProfile === 'wot' || normalizedProfile === 'allowlist+wot'
    ? wotRelays
    : '';
  merged.GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS = normalizeNumberString(
    answers.GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS || existing.GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS || preset.GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS,
    30000
  );
  merged.GATEWAY_AUTH_WOT_REFRESH_MS = normalizeNumberString(
    answers.GATEWAY_AUTH_WOT_REFRESH_MS || existing.GATEWAY_AUTH_WOT_REFRESH_MS || preset.GATEWAY_AUTH_WOT_REFRESH_MS,
    600000
  );

  Object.assign(merged, toDerivedValues(merged));

  if (normalizedProfile === 'open') {
    merged.GATEWAY_DISCOVERY_OPEN_ACCESS = 'true';
    merged.GATEWAY_AUTH_ALLOWLIST_PUBKEYS = '';
    merged.GATEWAY_AUTH_ALLOWLIST_FILE = '';
    merged.GATEWAY_AUTH_OPERATOR_PUBKEY = '';
    merged.GATEWAY_AUTH_WOT_ROOT_PUBKEY = '';
    merged.GATEWAY_AUTH_WOT_RELAYS = '';
  } else if (normalizedProfile === 'allowlist') {
    merged.GATEWAY_DISCOVERY_OPEN_ACCESS = 'false';
    merged.GATEWAY_AUTH_WOT_ROOT_PUBKEY = '';
    merged.GATEWAY_AUTH_WOT_RELAYS = '';
  } else {
    merged.GATEWAY_DISCOVERY_OPEN_ACCESS = 'false';
    if (normalizedProfile === 'wot') {
      merged.GATEWAY_AUTH_ALLOWLIST_FILE = '';
    }
  }

  return merged;
}

export function validateConfig(config = {}) {
  const errors = [];
  const warnings = [];
  const normalized = {};

  for (const [key, value] of Object.entries(config)) {
    normalized[key] = typeof value === 'string' ? value.trim() : value;
  }

  const profile = deriveProfile(normalized);
  if (!profile) {
    errors.push('DEPLOY_PROFILE or GATEWAY_AUTH_HOST_POLICY must be one of: open, allowlist, wot, allowlist+wot');
    return { errors, warnings, profile: null, normalized };
  }
  if (normalizeProfile(normalized.GATEWAY_AUTH_HOST_POLICY) !== profile) {
    errors.push('GATEWAY_AUTH_HOST_POLICY must match DEPLOY_PROFILE');
  }

  if (!isValidHost(normalized.GATEWAY_HOST)) {
    errors.push('GATEWAY_HOST must be a hostname without protocol or path');
  }
  if (!isValidEmail(normalized.LETSENCRYPT_EMAIL)) {
    errors.push('LETSENCRYPT_EMAIL must be a valid email address');
  }
  if (!isValidPublicUrl(normalized.GATEWAY_PUBLIC_URL)) {
    errors.push('GATEWAY_PUBLIC_URL must be an https URL');
  }
  if (!normalizeString(normalized.GATEWAY_DISCOVERY_DISPLAY_NAME)) {
    errors.push('GATEWAY_DISCOVERY_DISPLAY_NAME is required');
  }
  if (!isValidWsRelayList(normalized.GATEWAY_NOSTR_DISCOVERY_RELAYS)) {
    errors.push('GATEWAY_NOSTR_DISCOVERY_RELAYS must be a comma-separated list of ws/wss URLs');
  }
  if (!isHex64(normalized.GATEWAY_REGISTRATION_SECRET)) {
    errors.push('GATEWAY_REGISTRATION_SECRET must be a 64-character hex string');
  }
  if (!normalizeString(normalized.GATEWAY_RELAY_NAMESPACE)) {
    errors.push('GATEWAY_RELAY_NAMESPACE is required');
  }
  if (!normalizeString(normalized.GATEWAY_RELAY_REPLICATION_TOPIC)) {
    errors.push('GATEWAY_RELAY_REPLICATION_TOPIC is required');
  }
  if (!isHex64(normalized.GATEWAY_RELAY_ADMIN_PUBLIC_KEY)) {
    errors.push('GATEWAY_RELAY_ADMIN_PUBLIC_KEY must be a 64-character hex string');
  }
  if (!isHex64(normalized.GATEWAY_RELAY_ADMIN_SECRET_KEY)) {
    errors.push('GATEWAY_RELAY_ADMIN_SECRET_KEY must be a 64-character hex string');
  }
  if (!isPositiveIntegerString(normalized.GATEWAY_BLINDPEER_PORT)) {
    errors.push('GATEWAY_BLINDPEER_PORT must be a positive integer');
  }
  if (!isTruthyFalsey(normalized.GATEWAY_DISCOVERY_OPEN_ACCESS)) {
    errors.push('GATEWAY_DISCOVERY_OPEN_ACCESS must be true or false');
  }
  if (!isPositiveIntegerString(normalized.GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS)) {
    errors.push('GATEWAY_AUTH_WOT_LOAD_TIMEOUT_MS must be a positive integer');
  }
  if (!isPositiveIntegerString(normalized.GATEWAY_AUTH_WOT_REFRESH_MS)) {
    errors.push('GATEWAY_AUTH_WOT_REFRESH_MS must be a positive integer');
  }
  if (!isPositiveIntegerString(normalized.GATEWAY_AUTH_ALLOWLIST_REFRESH_MS)) {
    errors.push('GATEWAY_AUTH_ALLOWLIST_REFRESH_MS must be a positive integer');
  }

  if (profile === 'open') {
    if (normalizeString(normalized.GATEWAY_DISCOVERY_OPEN_ACCESS).toLowerCase() !== 'true') {
      errors.push('Open profile requires GATEWAY_DISCOVERY_OPEN_ACCESS=true');
    }
    if (normalizeString(normalized.GATEWAY_AUTH_ALLOWLIST_PUBKEYS) || normalizeString(normalized.GATEWAY_AUTH_OPERATOR_PUBKEY)) {
      warnings.push('Open profile ignores allowlist and WoT auth settings');
    }
  }

  if (profile !== 'open' && normalizeString(normalized.GATEWAY_DISCOVERY_OPEN_ACCESS).toLowerCase() !== 'false') {
    errors.push(`${profile} profile requires GATEWAY_DISCOVERY_OPEN_ACCESS=false`);
  }

  if (profile === 'allowlist' || profile === 'allowlist+wot') {
    if (!isValidPubkeyList(normalized.GATEWAY_AUTH_ALLOWLIST_PUBKEYS)) {
      errors.push('Allowlist-based profiles require GATEWAY_AUTH_ALLOWLIST_PUBKEYS to be a comma-separated list of 64-character hex pubkeys');
    }
    if (!normalizeString(normalized.GATEWAY_AUTH_ALLOWLIST_FILE)) {
      errors.push('Allowlist-based profiles require GATEWAY_AUTH_ALLOWLIST_FILE so the live allowlist store can be enabled');
    }
  }

  if (profile === 'wot' || profile === 'allowlist+wot') {
    if (!isHex64(normalized.GATEWAY_AUTH_OPERATOR_PUBKEY)) {
      errors.push('WoT-based profiles require GATEWAY_AUTH_OPERATOR_PUBKEY as a 64-character hex pubkey');
    }
    if (!maybeEmptyPubkey(normalized.GATEWAY_AUTH_WOT_ROOT_PUBKEY)) {
      errors.push('GATEWAY_AUTH_WOT_ROOT_PUBKEY must be blank or a 64-character hex pubkey');
    }
    if (!isPositiveIntegerString(normalized.GATEWAY_AUTH_WOT_MAX_DEPTH)) {
      errors.push('GATEWAY_AUTH_WOT_MAX_DEPTH must be a positive integer');
    }
    if (!isPositiveIntegerString(normalized.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2, { allowZero: true })) {
      errors.push('GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 must be zero or a positive integer');
    }
    if (!isValidWsRelayList(normalized.GATEWAY_AUTH_WOT_RELAYS)) {
      errors.push('WoT-based profiles require GATEWAY_AUTH_WOT_RELAYS to be a comma-separated list of ws/wss URLs');
    }
  }

  if (normalizeString(normalized.GATEWAY_AUTH_WOT_ROOT_PUBKEY) && normalizeString(normalized.GATEWAY_AUTH_WOT_ROOT_PUBKEY) !== normalizeString(normalized.GATEWAY_AUTH_OPERATOR_PUBKEY) && !isHex64(normalized.GATEWAY_AUTH_WOT_ROOT_PUBKEY)) {
    errors.push('GATEWAY_AUTH_WOT_ROOT_PUBKEY must be a 64-character hex pubkey');
  }

  return { errors, warnings, profile, normalized };
}

export function defaultPolicyColumnForConfig(config = {}) {
  const profile = deriveProfile(config);
  if (profile === 'open') return 'open';
  if (profile === 'allowlist') return 'allowlist';
  if (profile === 'allowlist+wot') return 'allowlistPlusWot';
  const maxDepth = Number.parseInt(normalizeString(config.GATEWAY_AUTH_WOT_MAX_DEPTH || '1'), 10);
  const minFollowers = Number.parseInt(normalizeString(config.GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2 || '0'), 10);
  if (profile === 'wot' && (maxDepth > 1 || minFollowers > 0)) {
    return 'wotDepth2Threshold';
  }
  return 'wotDepth1';
}

export function summarizeConfigChanges({ nextConfig, existing = {} }) {
  const provided = [];
  const generated = [];
  const derived = [];

  for (const [key, value] of Object.entries(nextConfig)) {
    const classification = FIELD_CLASSIFICATIONS[key];
    if (classification === 'generated' && !normalizeString(existing[key])) {
      generated.push(key);
    } else if (classification === 'derived') {
      derived.push(key);
    } else if (classification && normalizeString(value) && normalizeString(value) !== normalizeString(existing[key])) {
      provided.push(key);
    }
  }

  return { provided, generated, derived };
}
