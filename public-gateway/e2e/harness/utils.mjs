import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureDir(path) {
  await fs.mkdir(path, { recursive: true });
  return path;
}

async function writeTextFile(path, value) {
  await ensureDir(dirname(path));
  await fs.writeFile(path, String(value ?? ''), 'utf8');
}

async function writeJsonFile(path, value) {
  await ensureDir(dirname(path));
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitFor(fn, {
  timeoutMs = 30_000,
  intervalMs = 200,
  label = 'condition'
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError ? ` (${lastError?.message || String(lastError)})` : '';
  throw new Error(`timeout waiting for ${label}${detail}`);
}

async function requestJson(url, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = 10_000
} = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(headers || {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal
    });
    const raw = await response.text().catch(() => '');
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = { raw };
      }
    }
    if (!response.ok) {
      const detail = typeof data?.error === 'string'
        ? data.error
        : (typeof data?.raw === 'string' ? data.raw.slice(0, 240) : null);
      const error = new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` (${detail})` : ''}`);
      error.statusCode = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function findOpenPort({ host = '127.0.0.1', preferredPort } = {}) {
  if (Number.isFinite(Number(preferredPort)) && Number(preferredPort) > 0) {
    const candidate = Math.round(Number(preferredPort));
    const free = await isPortFree(candidate, host);
    if (free) return candidate;
  }

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
  });
}

async function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

function quantile(values = [], q = 0.95) {
  const list = Array.isArray(values)
    ? values.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)).sort((a, b) => a - b)
    : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const idx = Math.min(list.length - 1, Math.max(0, Math.floor((list.length - 1) * q)));
  return list[idx];
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function sanitizeIdentifier(input, fallback = null) {
  if (typeof input !== 'string') return fallback;
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export {
  assert,
  ensureDir,
  findOpenPort,
  isPortFree,
  parseBoolean,
  quantile,
  randomHex,
  requestJson,
  sanitizeIdentifier,
  sleep,
  waitFor,
  writeJsonFile,
  writeTextFile
};
