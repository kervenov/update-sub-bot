import { request } from 'undici';
import { config } from './config.js';
import { getMarzbanCredentials } from './configStore.js';

export class MarzbanCredentialsMissingError extends Error {
  constructor() {
    super('Marzban credentials not configured. Use /setmarzban <username> <password> in Telegram.');
    this.name = 'MarzbanCredentialsMissingError';
  }
}

// kept exported for callers that used to flush the cache; now a no-op since
// every getToken() call hits /api/admin/token afresh.
export function invalidateToken() {}

async function getToken() {
  const { username, password } = await getMarzbanCredentials();
  if (!username || !password) throw new MarzbanCredentialsMissingError();

  const body = new URLSearchParams({
    username,
    password,
    grant_type: 'password',
  }).toString();

  const { statusCode, body: resBody } = await request(`${config.marzban.baseUrl}/api/admin/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resBody.text();
  if (statusCode !== 200) {
    throw new Error(`marzban auth failed (${statusCode}): ${text}`);
  }
  return JSON.parse(text).access_token;
}

async function authedRequest(pathname, init = {}) {
  const token = await getToken();
  const { statusCode, body } = await request(`${config.marzban.baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  const text = await body.text();
  if (statusCode >= 400) {
    throw new Error(`marzban ${statusCode} on ${pathname}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
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
