import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

const DEFAULT_ROTATE_MS = 30 * 60 * 1000;
const DEFAULT_RETENTION_MS = 5 * 60 * 60 * 1000;
const DEFAULT_PREFIX = 'public-gateway';

let activeInstance = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function resolveDefaultLogDir() {
  const cwd = process.cwd();
  return basename(cwd) === 'public-gateway'
    ? join(cwd, 'logs')
    : join(cwd, 'public-gateway', 'logs');
}

function normalizeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
}

function normalizeWriteArgs(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    return { chunk, encoding: undefined, cb: encoding };
  }
  return { chunk, encoding, cb };
}

async function cleanupOldLogs({ logDir, prefix, retentionMs }) {
  try {
    const entries = await readdir(logDir);
    const cutoff = Date.now() - retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith('.log')) return;
      const filePath = join(logDir, entry);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch (_) {
        // Ignore missing or transient file errors.
      }
    }));
  } catch (_) {
    // Ignore cleanup errors to avoid crashing the gateway.
  }
}

function installStdoutLogRotation(options = {}) {
  if (activeInstance) return activeInstance;

  const logDir = options.logDir || resolveDefaultLogDir();
  const rotateMs = normalizeNumber(options.rotateMs, DEFAULT_ROTATE_MS);
  const retentionMs = normalizeNumber(options.retentionMs, DEFAULT_RETENTION_MS);
  const prefix = options.prefix || DEFAULT_PREFIX;

  let currentStream = null;
  let rotateTimer = null;
  let cleanupTimer = null;

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  const safeWrite = (target, chunk, encoding) => {
    if (!target) return;
    try {
      if (typeof chunk === 'string' && encoding) {
        target.write(chunk, encoding);
      } else {
        target.write(chunk);
      }
    } catch (_) {
      // Ignore write errors to keep stdout/stderr flowing.
    }
  };

  const rotate = async () => {
    try {
      await mkdir(logDir, { recursive: true });
      const filePath = join(logDir, `${prefix}-${formatTimestamp(new Date())}.log`);
      const nextStream = createWriteStream(filePath, { flags: 'a' });
      const previous = currentStream;
      currentStream = nextStream;
      if (previous) previous.end();
      await cleanupOldLogs({ logDir, prefix, retentionMs });
    } catch (error) {
      stderrWrite(`[PublicGateway] Failed to rotate log file: ${error?.message || error}\n`);
    }
  };

  process.stdout.write = (chunk, encoding, cb) => {
    const { chunk: payload, encoding: enc, cb: callback } = normalizeWriteArgs(chunk, encoding, cb);
    const result = stdoutWrite(payload, enc, callback);
    safeWrite(currentStream, payload, enc);
    return result;
  };

  process.stderr.write = (chunk, encoding, cb) => {
    const { chunk: payload, encoding: enc, cb: callback } = normalizeWriteArgs(chunk, encoding, cb);
    const result = stderrWrite(payload, enc, callback);
    safeWrite(currentStream, payload, enc);
    return result;
  };

  rotate().catch(() => {});
  rotateTimer = setInterval(() => rotate().catch(() => {}), rotateMs);
  rotateTimer.unref?.();

  cleanupTimer = setInterval(
    () => cleanupOldLogs({ logDir, prefix, retentionMs }),
    retentionMs
  );
  cleanupTimer.unref?.();

  const stop = () => {
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    if (currentStream) {
      currentStream.end();
      currentStream = null;
    }
  };

  process.on('exit', stop);
  activeInstance = { stop };
  return activeInstance;
}

export { installStdoutLogRotation };
