import * as storage from './storage.js';
import * as marzban from './marzban.js';
import {
  MarzbanCredentialsMissingError,
  MarzbanAuthError,
  MarzbanUnavailableError,
} from './marzban.js';

// One rotation cycle:
//   1. pop one IP from each reserve pool (forward + CDN)
//   2. PUT updated Marzban hosts (SHADOWSOCKS-* → forward, VLESS WS → CDN)
//   3. notify admins on success / empty-pool / failure
// Errors trigger a rollback that returns popped IPs to their pools.
export async function rotate({ trigger, notifyAdmins }) {
  const newForwardIp = await storage.popNextIp('forward');
  const newCdnIp = await storage.popNextIp('CDN');

  if (!newForwardIp || !newCdnIp) {
    if (newForwardIp) await storage.addIp('forward', newForwardIp);
    if (newCdnIp) await storage.addIp('CDN', newCdnIp);
    const missing = [
      !newForwardIp ? 'forward' : null,
      !newCdnIp ? 'CDN' : null,
    ].filter(Boolean).join(' + ');
    await notifyAdmins(
      `🚨 rotation aborted (${trigger}) — reserve pool empty: ${missing}.\nAdd IPs with /addforward / /addcdn.`,
    );
    const err = new Error(`reserve pool empty: ${missing}`);
    err.code = 'POOL_EMPTY';
    err.missing = missing;
    throw err;
  }

  try {
    const result = await marzban.rotateBlockedHosts(newForwardIp, newCdnIp);

    const ssLines = Object.entries(result.shadowsocks).map(([tag, n]) => `  • ${tag}: ${n} host`);
    const oldFwd = result.oldForwardIps.length ? result.oldForwardIps.join(', ') : '(none)';
    const oldCdn = result.oldCdnIps.length ? result.oldCdnIps.join(', ') : '(none)';

    await notifyAdmins(
      [
        `✅ Marzban hosts updated (${trigger})`,
        ``,
        `forward: ${oldFwd} → ${newForwardIp}`,
        `SHADOWSOCKS-* updated:`,
        ...(ssLines.length ? ssLines : ['  • (no enabled shadowsocks hosts)']),
        ``,
        `CDN: ${oldCdn} → ${newCdnIp}`,
        `VLESS WS updated: ${result.vlessWs} host`,
        ``,
        `skipped (is_disabled=true): ${result.skipped}`,
      ].join('\n'),
    );

    return { ...result, newForwardIp, newCdnIp };
  } catch (err) {
    await storage.addIp('forward', newForwardIp);
    await storage.addIp('CDN', newCdnIp);

    let prefix = '❌ rotation failed';
    if (err instanceof MarzbanUnavailableError) {
      prefix = '⛔ Marzban panel unreachable, rotation aborted';
      err.code = err.code || 'MARZBAN_UNAVAILABLE';
    } else if (err instanceof MarzbanAuthError) {
      prefix = '🔑 Marzban rejected credentials, rotation aborted';
      err.code = err.code || 'MARZBAN_AUTH';
    } else if (err instanceof MarzbanCredentialsMissingError) {
      prefix = '🔧 Marzban credentials not set, rotation aborted';
      err.code = err.code || 'MARZBAN_CREDS_MISSING';
    }

    await notifyAdmins(
      `${prefix} (${trigger}) — ${err.message}\nReturned ${newForwardIp} (forward) and ${newCdnIp} (CDN) to pools.`,
    );
    throw err;
  }
}
