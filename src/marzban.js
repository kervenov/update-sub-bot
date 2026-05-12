import { request } from 'undici';
import { config } from './config.js';
import { getMarzbanCredentials } from './configStore.js';

export class MarzbanCredentialsMissingError extends Error {
  constructor() {
    super('Marzban credentials not configured. Use /setmarzban <username> <password> in Telegram.');
    this.name = 'MarzbanCredentialsMissingError';
  }
}

// Auth rejected by Marzban (HTTP 401/403). User must re-enter credentials.
export class MarzbanAuthError extends Error {
  constructor(statusCode, body) {
    super(`Marzban auth rejected (${statusCode}): ${truncate(body)}`);
    this.name = 'MarzbanAuthError';
    this.statusCode = statusCode;
  }
}

// Network/transport problem or 5xx — Marzban itself is unreachable or sick.
// Callers (rotation flow) should treat this as transient and surface it
// distinctly from "credentials wrong" or "validation error".
export class MarzbanUnavailableError extends Error {
  constructor(message, { cause, statusCode } = {}) {
    super(message);
    this.name = 'MarzbanUnavailableError';
    if (cause) this.cause = cause;
    if (statusCode) this.statusCode = statusCode;
  }
}

// kept exported for callers that used to flush the cache; now a no-op since
// every getToken() call hits /api/admin/token afresh.
export function invalidateToken() {}

// --- Resilience layer ---------------------------------------------------
// Marzban can be flaky (TM blocks, panel restarts, slow upstream). Every
// outbound call goes through this wrapper so timeouts + transient retries
// are handled in exactly one place.

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1500];

const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function isRetryableNetworkError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  if (err.name === 'AbortError') return true;
  return false;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function truncate(text, max = 200) {
  if (!text) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Single network attempt with hard timeout. Returns { statusCode, text }.
async function attemptRequest(url, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { statusCode, body } = await request(url, {
      ...init,
      signal: ac.signal,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
    const text = await body.text();
    return { statusCode, text };
  } finally {
    clearTimeout(timer);
  }
}

// Performs an HTTP call with retry-on-transient and uniform error mapping.
// Returns { statusCode, text } when the server responds (any status). Throws
// MarzbanUnavailableError only when the panel never gave us a clean answer
// after all retries.
async function resilientRequest(url, init, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await attemptRequest(url, init);
      if (isRetryableStatus(res.statusCode) && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1500);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isRetryableNetworkError(err) || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1500);
    }
  }
  const reason = lastErr?.code || lastErr?.cause?.code || lastErr?.name || lastErr?.message || 'unknown';
  throw new MarzbanUnavailableError(
    `Marzban unreachable on ${label} after ${MAX_ATTEMPTS} attempts (${reason})`,
    { cause: lastErr },
  );
}

async function getToken() {
  const { username, password } = await getMarzbanCredentials();
  if (!username || !password) throw new MarzbanCredentialsMissingError();

  const body = new URLSearchParams({
    username,
    password,
    grant_type: 'password',
  }).toString();

  const { statusCode, text } = await resilientRequest(
    `${config.marzban.baseUrl}/api/admin/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
    '/api/admin/token',
  );

  if (statusCode === 401 || statusCode === 403) {
    throw new MarzbanAuthError(statusCode, text);
  }
  if (statusCode !== 200) {
    // anything else after retries (e.g. a final 5xx that exhausted retries)
    // is treated as the panel being unhealthy.
    throw new MarzbanUnavailableError(
      `Marzban auth endpoint returned ${statusCode}: ${truncate(text)}`,
      { statusCode },
    );
  }

  try {
    return JSON.parse(text).access_token;
  } catch (err) {
    throw new MarzbanUnavailableError(
      `Marzban auth response was not valid JSON: ${truncate(text)}`,
      { cause: err },
    );
  }
}

async function authedRequest(pathname, init = {}) {
  const token = await getToken();
  const { statusCode, text } = await resilientRequest(
    `${config.marzban.baseUrl}${pathname}`,
    {
      ...init,
      headers: {
        ...(init.headers || {}),
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    },
    pathname,
  );

  if (statusCode === 401 || statusCode === 403) {
    throw new MarzbanAuthError(statusCode, text);
  }
  if (statusCode >= 500) {
    throw new MarzbanUnavailableError(
      `Marzban ${statusCode} on ${pathname}: ${truncate(text)}`,
      { statusCode },
    );
  }
  if (statusCode >= 400) {
    // 4xx other than auth — request shape problem, surface verbatim.
    throw new Error(`marzban ${statusCode} on ${pathname}: ${truncate(text)}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MarzbanUnavailableError(
      `Marzban returned non-JSON on ${pathname}: ${truncate(text)}`,
      { cause: err },
    );
  }
}

export async function testCredentials() {
  await getToken();
  return true;
}

export async function listHosts() {
  return authedRequest('/api/hosts');
}

export async function updateHostAddress(inboundTag, hostIndex, newAddress) {
  const all = await listHosts();
  const inboundHosts = all[inboundTag];
  if (!Array.isArray(inboundHosts)) throw new Error(`inbound tag '${inboundTag}' not found`);
  if (hostIndex < 0 || hostIndex >= inboundHosts.length) {
    throw new Error(`hostIndex ${hostIndex} out of range for inbound '${inboundTag}' (size ${inboundHosts.length})`);
  }

  const updated = JSON.parse(JSON.stringify(all));
  updated[inboundTag][hostIndex] = { ...inboundHosts[hostIndex], address: newAddress };

  return authedRequest('/api/hosts', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updated),
  });
}

export async function findHostByAddress(address) {
  const all = await listHosts();
  for (const [inboundTag, hosts] of Object.entries(all)) {
    if (!Array.isArray(hosts)) continue;
    const idx = hosts.findIndex((h) => h?.address === address);
    if (idx !== -1) return { inboundTag, hostIndex: idx, host: hosts[idx] };
  }
  return null;
}

// True if `address` matches at least one ENABLED SHADOWSOCKS-* host in
// Marzban. Used by /alert/blocked to reject alerts coming from forward-VPS
// daemons whose IP is no longer the rotated-in active forward (e.g. a stale
// daemon still running on a previously-replaced VPS).
export async function isActiveShadowsocksAddress(address) {
  if (!address) return false;
  const all = await listHosts();
  for (const [tag, hosts] of Object.entries(all)) {
    if (!tag.startsWith('SHADOWSOCKS-')) continue;
    if (!Array.isArray(hosts)) continue;
    for (const h of hosts) {
      if (h?.is_disabled === true) continue;
      if (h?.address === address) return true;
    }
  }
  return false;
}

// Rotate every enabled host's `address` field for the targeted inbounds:
//   SHADOWSOCKS-* (any inbound tag starting with "SHADOWSOCKS-") → newForwardIp
//   VLESS WS                                                     → newCdnIp
//
// Hosts with is_disabled === true are left untouched.
// All other inbounds are passed through unchanged in the PUT body.
//
// Returns: { shadowsocks: { tag: count, ... }, vlessWs: count, skipped: count, oldForwardIps: [...], oldCdnIps: [...] }
export async function rotateBlockedHosts(newForwardIp, newCdnIp) {
  const all = await listHosts();
  const updated = JSON.parse(JSON.stringify(all));

  const summary = {
    shadowsocks: {},
    vlessWs: 0,
    skipped: 0,
    oldForwardIps: new Set(),
    oldCdnIps: new Set(),
  };

  for (const [tag, hosts] of Object.entries(updated)) {
    if (!Array.isArray(hosts)) continue;

    if (tag.startsWith('SHADOWSOCKS-')) {
      let count = 0;
      for (const h of hosts) {
        if (h?.is_disabled === true) {
          summary.skipped += 1;
          continue;
        }
        if (h?.address) summary.oldForwardIps.add(h.address);
        h.address = newForwardIp;
        count += 1;
      }
      if (count > 0) summary.shadowsocks[tag] = count;
      continue;
    }

    if (tag === 'VLESS WS') {
      for (const h of hosts) {
        if (h?.is_disabled === true) {
          summary.skipped += 1;
          continue;
        }
        if (h?.address) summary.oldCdnIps.add(h.address);
        h.address = newCdnIp;
        summary.vlessWs += 1;
      }
      continue;
    }

    // any other inbound: untouched (passed through verbatim)
  }

  await authedRequest('/api/hosts', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updated),
  });

  return {
    shadowsocks: summary.shadowsocks,
    vlessWs: summary.vlessWs,
    skipped: summary.skipped,
    oldForwardIps: [...summary.oldForwardIps],
    oldCdnIps: [...summary.oldCdnIps],
  };
}
