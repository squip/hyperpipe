const electronAPI = window.electronAPI || null;
let logFilePath = null;
const LOG_FLUSH_INTERVAL_MS = 120;
const LOG_FLUSH_EAGER_COUNT = 40;
const MAX_PENDING_LOG_LINES = 1500;
let pendingLogLines = [];
let droppedLogLines = 0;
let flushTimer = null;
let flushInFlight = false;

if (electronAPI?.getLogFilePath) {
  electronAPI.getLogFilePath().then((path) => {
    logFilePath = path;
  }).catch(() => {
    logFilePath = null;
  });
}

function getCallingScript() {
  const err = new Error();
  const stack = err.stack ? err.stack.split('\n') : [];
  for (const line of stack) {
    if (line.includes('console-file-logger')) continue;
    const match = line.match(/(?:\(|@)([^:\)]+\.js)/);
    if (match) {
      const parts = match[1].split(/[\\/]/);
      return parts[parts.length - 1] || 'unknown';
    }
  }
  return 'unknown';
}

function scheduleFlush(delayMs = LOG_FLUSH_INTERVAL_MS) {
  if (!electronAPI?.appendLogLine) return;
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushBufferedLogs();
  }, delayMs);
}

async function flushBufferedLogs() {
  if (!electronAPI?.appendLogLine) return;
  if (flushInFlight) return;
  if (!pendingLogLines.length && droppedLogLines === 0) return;

  flushInFlight = true;
  const lines = pendingLogLines.join('');
  pendingLogLines = [];
  const dropped = droppedLogLines;
  droppedLogLines = 0;
  const droppedLine =
    dropped > 0
      ? `[${new Date().toISOString()}] [WARN] [console-file-logger.js] Dropped ${dropped} lines due log backpressure\n`
      : '';

  try {
    await electronAPI.appendLogLine(`${lines}${droppedLine}`);
  } catch (_) {
    // Ignore append failures to avoid recursive logging loops.
  } finally {
    flushInFlight = false;
    if (pendingLogLines.length > 0 || droppedLogLines > 0) {
      scheduleFlush(0);
    }
  }
}

function enqueueLogLine(line) {
  if (!electronAPI?.appendLogLine) return;
  if (pendingLogLines.length >= MAX_PENDING_LOG_LINES) {
    droppedLogLines += 1;
    scheduleFlush(0);
    return;
  }
  pendingLogLines.push(line);
  if (pendingLogLines.length >= LOG_FLUSH_EAGER_COUNT) {
    scheduleFlush(0);
  } else {
    scheduleFlush(LOG_FLUSH_INTERVAL_MS);
  }
}

function writeLog(level, args) {
  const message = args.map(arg => {
    try {
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    } catch {
      return '[Unserializable]';
    }
  }).join(' ');

  const script = getCallingScript();
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${script}] ${message}\n`;

  enqueueLogLine(line);
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    writeLog(level, args);
    original(...args);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!electronAPI?.appendLogLine) return;
    if (!pendingLogLines.length && droppedLogLines === 0) return;
    const lines = pendingLogLines.join('');
    pendingLogLines = [];
    const dropped = droppedLogLines;
    droppedLogLines = 0;
    const droppedLine =
      dropped > 0
        ? `[${new Date().toISOString()}] [WARN] [console-file-logger.js] Dropped ${dropped} lines due log backpressure\n`
        : '';
    electronAPI.appendLogLine(`${lines}${droppedLine}`).catch(() => {});
  });
}

export { logFilePath };
