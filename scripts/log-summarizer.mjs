#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const DEFAULT_OUT_DIR = 'log-summaries';

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function coerceLevel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number') {
    if (value >= 60) return 'fatal';
    if (value >= 50) return 'error';
    if (value >= 40) return 'warn';
    if (value >= 30) return 'info';
    if (value >= 20) return 'debug';
    return 'trace';
  }
  return null;
}

function parseTimestamp(value) {
  if (!value) return { ts: null, iso: null };
  if (typeof value === 'number') {
    const ts = value > 1e12 ? value : value * 1000;
    const iso = new Date(ts).toISOString();
    return { ts, iso };
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return { ts: parsed, iso: new Date(parsed).toISOString() };
    }
  }
  return { ts: null, iso: null };
}

function parseLineTimestamp(line) {
  const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
  if (!match) return { ts: null, iso: null };
  return parseTimestamp(match[1]);
}

function normalizeTraceId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'null' || lowered === 'undefined' || lowered === 'none') return null;
  return trimmed;
}

function extractInviteTraceIdFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.inviteTraceId,
    obj.invite_trace_id,
    obj?.data?.inviteTraceId,
    obj?.data?.invite_trace_id,
    obj?.payload?.inviteTraceId,
    obj?.payload?.invite_trace_id,
    obj?.context?.inviteTraceId,
    obj?.context?.invite_trace_id
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTraceId(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function extractEmbeddedJson(line) {
  if (typeof line !== 'string') return null;
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = line.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractInviteTraceId(obj, line) {
  const fromObject = extractInviteTraceIdFromObject(obj);
  if (fromObject) return fromObject;
  if (typeof line === 'string') {
    const jsonMatch = line.match(/"inviteTraceId"\s*:\s*"([^"]+)"/);
    if (jsonMatch) {
      const normalized = normalizeTraceId(jsonMatch[1]);
      if (normalized) return normalized;
    }
    const match = line.match(/inviteTraceId\s*[:=]\s*([a-zA-Z0-9\-_.]+)/);
    if (match) {
      const normalized = normalizeTraceId(match[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractContext(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  const context = obj.context && typeof obj.context === 'object' ? obj.context : {};
  return {
    publicIdentifier: obj.publicIdentifier || data.publicIdentifier || payload.publicIdentifier || context.publicIdentifier || null,
    relayKey: obj.relayKey || data.relayKey || payload.relayKey || context.relayKey || null,
    relayUrl: obj.relayUrl || data.relayUrl || payload.relayUrl || context.relayUrl || null,
    mode: obj.mode || data.mode || payload.mode || context.mode || null,
    status: obj.status || data.status || payload.status || context.status || null,
    mirrorSource: obj.mirrorSource || data.mirrorSource || payload.mirrorSource || context.mirrorSource || null,
    mirrorSnapshotFingerprint: obj.mirrorSnapshotFingerprint || data.mirrorSnapshotFingerprint || payload.mirrorSnapshotFingerprint || context.mirrorSnapshotFingerprint || null
  };
}

function looksLikeJson(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

const CRITICAL_PATTERNS = [
  /\[CJTRACE\]/i,
  /join-auth/i,
  /invite proof/i,
  /invite mirror/i,
  /mirror metadata/i,
  /blind[-\s]?peer/i,
  /downgrade-announce/i,
  /announce/i,
  /pin\b/i,
  /mirror core/i,
  /hydration/i,
  /rehydrat/i,
  /relay core/i
];

const ERROR_PATTERNS = [/\berror\b/i, /\bwarn\b/i, /\bfailed\b/i, /exception/i, /stack/i];

function isCriticalLine(line, obj, level) {
  const msg = obj?.msg || obj?.message || line || '';
  if (level === 'error' || level === 'fatal' || level === 'warn') return true;
  if (obj && obj.error) return true;
  if (ERROR_PATTERNS.some((re) => re.test(msg))) return true;
  return CRITICAL_PATTERNS.some((re) => re.test(msg));
}

function normalizeEvent({ line, obj, file }) {
  const level = coerceLevel(obj?.level || obj?.severity || obj?.lvl);
  const msg = obj?.msg || obj?.message || line;
  const { ts, iso } = parseTimestamp(obj?.time || obj?.timestamp || obj?.ts || obj?.date);
  const fallbackTs = ts ? { ts, iso } : parseLineTimestamp(line);
  const inviteTraceId = extractInviteTraceId(obj, line);
  const context = extractContext(obj);
  const moduleName = obj?.module || obj?.name || obj?.logger || null;
  const error = obj?.error || obj?.err || null;
  return {
    file,
    ts: fallbackTs.ts,
    iso: fallbackTs.iso,
    level: level || null,
    module: moduleName,
    msg: typeof msg === 'string' ? msg : safeString(msg),
    inviteTraceId: inviteTraceId || null,
    context,
    error
  };
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error !== 'object') return { message: String(error) };
  return {
    message: error.message || String(error),
    name: error.name || null,
    code: error.code || null,
    stack: error.stack || null,
    cause: error.cause ? (error.cause.message || String(error.cause)) : null
  };
}

function hashError(error) {
  const payload = JSON.stringify(error || {});
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function formatTimelineLine(event) {
  const ts = event.iso || 'n/a';
  const level = event.level || 'info';
  const moduleName = event.module ? `[${event.module}]` : '';
  const trace = event.inviteTraceId ? ` trace=${event.inviteTraceId}` : '';
  return `${ts} ${level.toUpperCase()}${moduleName}${trace} ${event.msg}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT_DIR, run: null, files: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--run') {
      args.run = argv[i + 1];
      i += 1;
      continue;
    }
    args.files.push(token);
  }
  return args;
}

async function processFile(file, state) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    state.totalLines += 1;
    if (!line) continue;
    let obj = null;
    if (looksLikeJson(line)) {
      try {
        obj = JSON.parse(line);
        state.jsonLines += 1;
      } catch {
        obj = null;
      }
    }
    const embedded = obj ? extractEmbeddedJson(obj?.msg || obj?.message || '') : extractEmbeddedJson(line);
    if (!obj && embedded) {
      obj = embedded;
    } else if (obj && embedded && typeof embedded === 'object') {
      const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
      obj = { ...obj, data: { ...embedded, ...data } };
    }
    const level = coerceLevel(obj?.level || obj?.severity || obj?.lvl);
    const inviteTraceId = extractInviteTraceId(obj, line);
    const critical = inviteTraceId || isCriticalLine(line, obj, level);
    if (!critical) continue;

    const event = normalizeEvent({ line, obj, file });
    state.keptLines += 1;
    if (event.level === 'warn') state.warnLines += 1;
    if (event.level === 'error' || event.level === 'fatal') state.errorLines += 1;
    if (event.error) {
      const normalizedError = normalizeError(event.error);
      const key = hashError(normalizedError);
      const entry = state.errorIndex.get(key) || { count: 0, error: normalizedError, traces: new Set(), files: new Set() };
      entry.count += 1;
      if (event.inviteTraceId) entry.traces.add(event.inviteTraceId);
      entry.files.add(file);
      state.errorIndex.set(key, entry);
    }

    const traceKey = event.inviteTraceId || null;
    if (traceKey) {
      let trace = state.traces.get(traceKey);
      if (!trace) {
        trace = {
          traceId: traceKey,
          files: new Set(),
          events: [],
          milestones: [],
          context: {}
        };
        state.traces.set(traceKey, trace);
      }
      trace.files.add(file);
      trace.events.push(event);
      const ctx = event.context || {};
      if (ctx.publicIdentifier && !trace.context.publicIdentifier) trace.context.publicIdentifier = ctx.publicIdentifier;
      if (ctx.relayKey && !trace.context.relayKey) trace.context.relayKey = ctx.relayKey;
      if (ctx.relayUrl && !trace.context.relayUrl) trace.context.relayUrl = ctx.relayUrl;
      if (ctx.mirrorSource && !trace.context.mirrorSource) trace.context.mirrorSource = ctx.mirrorSource;
      if (ctx.mirrorSnapshotFingerprint && !trace.context.mirrorSnapshotFingerprint) trace.context.mirrorSnapshotFingerprint = ctx.mirrorSnapshotFingerprint;

      const msg = event.msg || '';
      if (/invite proof generated/i.test(msg)) trace.milestones.push({ type: 'invite-proof-generated', ts: event.ts, iso: event.iso });
      if (/invite mirror readiness/i.test(msg)) trace.milestones.push({ type: 'invite-mirror-readiness', ts: event.ts, iso: event.iso });
      if (/mirror metadata response/i.test(msg)) trace.milestones.push({ type: 'mirror-metadata-response', ts: event.ts, iso: event.iso });
      if (/join flow success/i.test(msg) || /join-auth-success/i.test(msg)) trace.milestones.push({ type: 'join-auth-success', ts: event.ts, iso: event.iso });
      if (/join flow error/i.test(msg) || /join-auth-error/i.test(msg)) trace.milestones.push({ type: 'join-auth-error', ts: event.ts, iso: event.iso });
      if (/downgrade announce/i.test(msg)) trace.milestones.push({ type: 'downgrade-announce', ts: event.ts, iso: event.iso });
      continue;
    }

    state.untraced.push(event);
  }
}

function buildSummary(state, runId, args) {
  const traces = Array.from(state.traces.values()).map((trace) => {
    const events = trace.events;
    const first = events.length ? events[0] : null;
    const last = events.length ? events[events.length - 1] : null;
    const hasSuccess = events.some((e) => /join-auth-success|join flow success/i.test(e.msg || ''));
    const hasError = events.some((e) => /join-auth-error|join flow error/i.test(e.msg || ''));
    const hasDowngrade = events.some((e) => /downgrade announce/i.test(e.msg || ''));
    return {
      traceId: trace.traceId,
      publicIdentifier: trace.context.publicIdentifier || null,
      relayKey: trace.context.relayKey || null,
      relayUrl: trace.context.relayUrl || null,
      mirrorSource: trace.context.mirrorSource || null,
      mirrorSnapshotFingerprint: trace.context.mirrorSnapshotFingerprint || null,
      events: events.length,
      start: first?.iso || null,
      end: last?.iso || null,
      hasJoinSuccess: hasSuccess,
      hasJoinError: hasError,
      hasDowngradeAnnounce: hasDowngrade
    };
  });

  return {
    runId,
    generatedAt: nowIso(),
    inputFiles: args.files,
    totals: {
      lines: state.totalLines,
      jsonLines: state.jsonLines,
      keptLines: state.keptLines,
      traces: traces.length,
      warnings: state.warnLines,
      errors: state.errorLines,
      untraced: state.untraced.length
    },
    traces
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.files.length) {
    console.error('Usage: node scripts/log-summarizer.mjs [--out dir] [--run name] <logfile...>');
    process.exit(1);
  }

  const runId = args.run || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outBase = path.resolve(args.out, runId);
  const traceDir = path.join(outBase, 'traces');
  ensureDir(traceDir);

  const state = {
    totalLines: 0,
    jsonLines: 0,
    keptLines: 0,
    warnLines: 0,
    errorLines: 0,
    traces: new Map(),
    untraced: [],
    errorIndex: new Map()
  };

  for (const file of args.files) {
    if (!fs.existsSync(file)) {
      console.warn(`Skipping missing file: ${file}`);
      continue;
    }
    await processFile(file, state);
  }

  for (const trace of state.traces.values()) {
    trace.events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const timeline = trace.events.map(formatTimelineLine).join('\n');
    const summary = {
      traceId: trace.traceId,
      publicIdentifier: trace.context.publicIdentifier || null,
      relayKey: trace.context.relayKey || null,
      relayUrl: trace.context.relayUrl || null,
      mirrorSource: trace.context.mirrorSource || null,
      mirrorSnapshotFingerprint: trace.context.mirrorSnapshotFingerprint || null,
      files: Array.from(trace.files),
      events: trace.events.length,
      milestones: trace.milestones
    };
    const tracePath = path.join(traceDir, `${trace.traceId}.json`);
    const timelinePath = path.join(traceDir, `${trace.traceId}.timeline.txt`);
    fs.writeFileSync(tracePath, JSON.stringify(summary, null, 2));
    fs.writeFileSync(timelinePath, timeline);
  }

  if (state.untraced.length) {
    state.untraced.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const untracedTimeline = state.untraced.map(formatTimelineLine).join('\n');
    fs.writeFileSync(path.join(outBase, 'untraced.timeline.txt'), untracedTimeline);
  }

  const errorIndex = Array.from(state.errorIndex.entries()).map(([key, entry]) => ({
    id: key,
    count: entry.count,
    error: entry.error,
    traces: Array.from(entry.traces),
    files: Array.from(entry.files)
  }));
  fs.writeFileSync(path.join(outBase, 'error-index.json'), JSON.stringify(errorIndex, null, 2));

  const summary = buildSummary(state, runId, args);
  fs.writeFileSync(path.join(outBase, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`Log summary written to ${outBase}`);
}

main().catch((error) => {
  console.error('Log summarizer failed:', error);
  process.exit(1);
});
