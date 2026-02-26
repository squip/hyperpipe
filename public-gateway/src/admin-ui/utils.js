export function bytesToHex(bytes) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function normalizeHex64(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null;
  return normalized;
}

export function shortPubkey(value, size = 12) {
  const normalized = normalizeHex64(value);
  if (!normalized) return '-';
  if (normalized.length <= size) return normalized;
  return `${normalized.slice(0, Math.max(6, size - 6))}...${normalized.slice(-6)}`;
}

export function formatDateTime(value) {
  if (!value) return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '-';
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

export function formatDuration(ms) {
  const totalMs = Number(ms);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return '0s';
  let seconds = Math.floor(totalMs / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const chunks = [];
  if (days) chunks.push(`${days}d`);
  if (hours) chunks.push(`${hours}h`);
  if (minutes) chunks.push(`${minutes}m`);
  if (seconds || chunks.length === 0) chunks.push(`${seconds}s`);
  return chunks.slice(0, 3).join(' ');
}

export function normalizeRelayUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return null;
  }
}

export function gatewayDomain(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return '-';
  try {
    const parsed = new URL(origin);
    return parsed.host || origin;
  } catch (_error) {
    return origin;
  }
}

export function statusDotClass(status) {
  if (status === true) return 'status-dot status-online';
  if (status === false) return 'status-dot status-offline';
  return 'status-dot status-unknown';
}

export function normalizeProfileIdentity(profile, pubkey) {
  const fallback = shortPubkey(pubkey);
  const displayName = String(profile?.displayName || profile?.name || '').trim() || fallback;
  const secondary = String(profile?.nip05 || '').trim() || fallback;
  const picture = String(profile?.picture || '').trim() || null;
  return {
    displayName,
    secondary,
    picture
  };
}
