#!/usr/bin/env node
import http from 'node:http';

const DEFAULT_PORT = Number(process.env.HYT_CLOSED_JOIN_SIM_PORT || process.env.CLOSED_JOIN_SIM_PORT || 17665);
const DEFAULT_TOKEN = process.env.HYT_CLOSED_JOIN_SIM_TOKEN || null;
const ENDPOINT_PATH = '/__closed_join_sim__';

const args = process.argv.slice(2);
const action = args[0] || 'help';

const readFlag = (flag) => {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
};

const hasFlag = (flag) => args.includes(flag);

const readBoolFlag = (flag) => {
  const value = readFlag(flag);
  if (value == null) return null;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  return null;
};

const port = Number(readFlag('--port') || DEFAULT_PORT);
const token = readFlag('--token') || DEFAULT_TOKEN;
const jsonOutput = hasFlag('--json');
const targetOverride = readFlag('--target');

const help = () => {
  const text = `
Closed-join simulator CLI

Usage:
  node hypertuna-desktop/bin/closed-join-sim.mjs <command> [options]

Commands:
  ping
  expected-logs
  print-invite
  send-invite --invitee <pubkey> [--name <name>] [--about <about>]
  approve --requester <pubkey>
  join
  e2e-run [--invitees <n>] [--group-prefix <name>] [--public] [--mode <open|closed>]
  e2e-matrix [--invitees <n>] [--group-prefix <name>] [--public]

Options:
  --port <port>     CLI server port (default: ${DEFAULT_PORT})
  --token <token>   Optional auth token (HYT_CLOSED_JOIN_SIM_TOKEN)
  --target <name>   Override target window global (default depends on command)
  --mode <name>     Join mode for e2e-run (open|closed, default: closed)
  --multi-group     Create a new group per invitee (default is single shared group)
  --disable-autostart <true|false>  Toggle worker autostart during e2e-run (default: true)
  --json            Output raw JSON response

Notes:
  - The app must be running with HYT_CLOSED_JOIN_SIM=1 (and optional port/token env vars).
  - __HYT_E2E__ is auto-enabled via ?closedJoinE2E=1 when HYT_CLOSED_JOIN_SIM=1.
  - For __HYT_CLOSED_JOIN_SIM__, open a group page with ?closedJoinSim=1.
`;
  console.log(text.trim());
};

if (action === 'help' || action === '--help' || action === '-h') {
  help();
  process.exit(0);
}

const payloadForAction = () => {
  switch (action) {
    case 'ping':
      return { action: 'ping', args: [], target: targetOverride || '__HYT_CLOSED_JOIN_SIM__' };
    case 'expected-logs':
      return { action: 'expectedLogs', args: [], target: targetOverride || '__HYT_CLOSED_JOIN_SIM__' };
    case 'print-invite':
      return { action: 'printInvite', args: [], target: targetOverride || '__HYT_CLOSED_JOIN_SIM__' };
    case 'send-invite': {
      const invitee = readFlag('--invitee');
      if (!invitee) {
        throw new Error('send-invite requires --invitee <pubkey>');
      }
      const name = readFlag('--name');
      const about = readFlag('--about');
      return {
        action: 'sendClosedInvite',
        args: [invitee, { name, about }],
        target: targetOverride || '__HYT_CLOSED_JOIN_SIM__'
      };
    }
    case 'approve': {
      const requester = readFlag('--requester');
      if (!requester) {
        throw new Error('approve requires --requester <pubkey>');
      }
      return { action: 'runApprovalFlow', args: [requester], target: targetOverride || '__HYT_CLOSED_JOIN_SIM__' };
    }
    case 'join':
      return { action: 'startJoinFromInvite', args: [], target: targetOverride || '__HYT_CLOSED_JOIN_SIM__' };
    case 'e2e-run': {
      const invitees = Number(readFlag('--invitees') || 5);
      const groupPrefix = readFlag('--group-prefix') || 'ClosedJoinE2E';
      const isPublic = hasFlag('--public');
      const singleGroup = !hasFlag('--multi-group');
      const disableAutostart = readBoolFlag('--disable-autostart');
      const modeRaw = String(readFlag('--mode') || 'closed').trim().toLowerCase();
      const mode = modeRaw === 'open' ? 'open' : 'closed';
      return {
        action: 'runClosedJoinE2E',
        args: [
          {
            mode,
            inviteeCount: Number.isFinite(invitees) && invitees > 0 ? Math.trunc(invitees) : 5,
            groupPrefix,
            isPublic,
            singleGroup,
            disableAutostart: disableAutostart ?? undefined
          }
        ],
        target: targetOverride || '__HYT_E2E__'
      };
    }
    case 'e2e-matrix': {
      const invitees = Number(readFlag('--invitees') || 2);
      const groupPrefix = readFlag('--group-prefix') || 'JoinMatrixE2E';
      const isPublic = hasFlag('--public');
      const singleGroup = !hasFlag('--multi-group');
      const disableAutostart = readBoolFlag('--disable-autostart');
      return {
        action: 'runJoinMatrixE2E',
        args: [
          {
            inviteeCount: Number.isFinite(invitees) && invitees > 0 ? Math.trunc(invitees) : 2,
            groupPrefix,
            isPublic,
            singleGroup,
            disableAutostart: disableAutostart ?? undefined
          }
        ],
        target: targetOverride || '__HYT_E2E__'
      };
    }
    default:
      throw new Error(`Unknown command: ${action}`);
  }
};

const post = async (payload) => {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  };
  if (token) headers['x-hyt-sim-token'] = token;

  const options = {
    hostname: '127.0.0.1',
    port,
    path: ENDPOINT_PATH,
    method: 'POST',
    headers
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          parsed = { ok: false, error: data || `status ${res.statusCode}` };
        }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

(async () => {
  try {
    const payload = payloadForAction();
    const { status, data } = await post(payload);
    if (jsonOutput) {
      console.log(JSON.stringify({ status, ...data }, null, 2));
    } else if (data?.ok) {
      console.log('[closed-join-sim] ok', data.result ?? '');
    } else {
      console.error('[closed-join-sim] failed', data?.error || `status ${status}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('[closed-join-sim] error', error?.message || error);
    process.exitCode = 1;
  }
})();
