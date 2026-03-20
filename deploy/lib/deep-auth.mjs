import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { schnorr } from '@noble/curves/secp256k1';

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/iu.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export async function readAuthManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.accounts) || typeof manifest.policyMatrix !== 'object') {
    throw new Error('invalid-auth-manifest');
  }
  return manifest;
}

async function postJson(url, payload, timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text().catch(() => '');
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: {
        error: isTimeout ? 'request-timeout' : 'request-failed',
        message: error?.message || String(error)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeGatewayAccount({
  gatewayOrigin,
  account,
  scope = 'gateway:relay-register',
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch
}) {
  const challenge = await postJson(`${gatewayOrigin}/api/auth/challenge`, {
    pubkey: account.pubkeyHex,
    scope
  }, timeoutMs, fetchImpl);

  if (!challenge.ok) {
    return {
      challenge,
      verify: null,
      allowed: false,
      classification: challenge.body?.error === 'request-timeout' ? 'challenge-timeout' : 'challenge-error'
    };
  }

  const challengeId = typeof challenge.body?.challengeId === 'string' ? challenge.body.challengeId.trim() : '';
  const nonce = typeof challenge.body?.nonce === 'string' ? challenge.body.nonce : '';
  if (!challengeId || !nonce) {
    return {
      challenge,
      verify: null,
      allowed: false,
      classification: 'challenge-invalid'
    };
  }

  const secretBytes = hexToBytes(account.secretHex);
  if (!secretBytes) {
    throw new Error(`invalid-secretHex-for-role:${account.role || 'unknown'}`);
  }
  const signature = Buffer.from(await schnorr.sign(new TextEncoder().encode(nonce), secretBytes)).toString('hex');
  const verify = await postJson(`${gatewayOrigin}/api/auth/verify`, {
    challengeId,
    pubkey: account.pubkeyHex,
    signature,
    scope
  }, timeoutMs, fetchImpl);

  let classification = 'verify-error';
  if (verify.status === 200 && typeof verify.body?.token === 'string') {
    classification = 'approved';
  } else if (verify.status === 403) {
    classification = 'denied';
  } else if (verify.status === 401) {
    classification = 'invalid-signature-or-challenge';
  } else if (verify.status === 0 && verify.body?.error === 'request-timeout') {
    classification = 'verify-timeout';
  }

  return {
    challenge,
    verify,
    allowed: classification === 'approved',
    classification
  };
}

export function buildAuthMarkdownReport(report) {
  const lines = [
    '# Gateway Auth Validation Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Gateway origin: ${report.gatewayOrigin}`,
    `- Policy column: ${report.policyColumn}`,
    `- Scope: ${report.scope}`,
    `- Manifest: ${report.manifestPath}`,
    `- Success: ${report.ok ? 'true' : 'false'}`,
    '',
    '| Role | Expected | Actual | Status | Classification |',
    '| ---- | -------- | ------ | ------ | -------------- |'
  ];
  for (const row of report.results) {
    lines.push(`| ${row.role} | ${row.expected} | ${row.actual} | ${row.status} | ${row.classification} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runDeepAuthValidation({
  manifestPath,
  gatewayOrigin,
  policyColumn,
  scope = 'gateway:relay-register',
  timeoutMs = 30_000,
  roles = null,
  outPath = null,
  fetchImpl = globalThis.fetch
}) {
  const manifest = await readAuthManifest(manifestPath);
  const selectedRoles = Array.isArray(roles) && roles.length ? new Set(roles) : null;
  const accounts = manifest.accounts.filter((account) => {
    if (!account || typeof account !== 'object') return false;
    return !selectedRoles || selectedRoles.has(String(account.role || ''));
  });

  const results = [];
  const failures = [];
  for (const account of accounts) {
    const role = String(account.role || '').trim();
    const expected = manifest.policyMatrix?.[role]?.[policyColumn]?.result || null;
    if (!expected) continue;
    const outcome = await probeGatewayAccount({
      gatewayOrigin,
      account,
      scope,
      timeoutMs,
      fetchImpl
    });
    const row = {
      role,
      expected,
      actual: outcome.allowed ? 'ALLOW' : 'DENY',
      status: outcome.verify?.status ?? outcome.challenge?.status ?? 0,
      classification: outcome.classification,
      challenge: outcome.challenge,
      verify: outcome.verify
    };
    results.push(row);
    if (row.actual !== expected) failures.push(row);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath,
    gatewayOrigin,
    policyColumn,
    scope,
    ok: failures.length === 0,
    results,
    failures
  };

  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(outPath.replace(/\.json$/iu, '.md'), buildAuthMarkdownReport(report), 'utf8');
  }

  return report;
}
