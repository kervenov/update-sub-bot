import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { rotate } from './rotate.js';
import * as configStore from './configStore.js';
import * as marzban from './marzban.js';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// Coalesce overlapping rotations: if a second alert arrives while the first is
// still running (panel was slow, daemon retried, etc.) we hand back the same
// in-flight promise instead of popping a second pair of IPs.
let activeRotation = null;

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sanitizeReason(reason) {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function sanitizeIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  return IPV4.test(trimmed) ? trimmed : null;
}

export function createApi({ notifyAdmins, reportError }) {
  const report = reportError || (async () => {});
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // JSON body parse failures must return 400, not bubble up as 500.
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      report('api/parse', err);
      return res.status(400).json({ error: 'invalid json' });
    }
    return next(err);
  });

  // Auth: applies to every route below. Health is intentionally also gated
  // because the only callers we expect (forward-vps-daemon, ourselves) all
  // carry the bearer token anyway.
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${config.api.token}`;
    if (typeof auth !== 'string' || !safeEqual(auth, expected)) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/alert/blocked', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const currentIp = sanitizeIp(body.currentIp);
    const reason = sanitizeReason(body.reason);

    console.log(
      `[api] alert from ${currentIp || 'unknown'}${reason ? ` — ${reason}` : ''}`,
    );

    // Stale-daemon guard: only honour alerts whose currentIp is the address
    // of an ENABLED SHADOWSOCKS-* host in Marzban. A leftover daemon on a
    // forward-VPS that was already rotated out would otherwise trigger a
    // second (wrong) rotation.
    let isActiveForward = false;
    try {
      isActiveForward = await marzban.isActiveShadowsocksAddress(currentIp);
    } catch (err) {
      // Cannot verify (panel unreachable / creds wrong). Fail safe: notify
      // admins and refuse to rotate until we can confirm the alert is real.
      console.error('[api] marzban check failed (stale-daemon guard)', err);
      report('api/marzban.isActiveShadowsocksAddress', err);
      try {
        await notifyAdmins(
          [
            `⚠️ Alert from ${currentIp || 'unknown'}${reason ? ` (${reason})` : ''}`,
            `Cannot verify whether this is the active forward IP — Marzban: ${err.message}`,
            `Not auto-rotating. Fix the panel, then use 🔄 Manual Update if rotation is still needed.`,
          ].join('\n'),
        );
      } catch (e) {
        console.error('[api] notifyAdmins failed (marzban-down path)', e);
      }
      return res.status(503).json({ error: 'marzban check failed' });
    }

    if (!isActiveForward) {
      console.log(
        `[api] alert from ${currentIp || 'unknown'} ignored — not the active Shadowsocks forward IP`,
      );
      return res.json({ ok: true, skipped: 'not-active-forward-ip' });
    }

    let autoOn;
    try {
      autoOn = await configStore.getAutoRotate();
    } catch (err) {
      console.error('[api] failed to read auto-rotate flag', err);
      report('api/configStore.getAutoRotate', err);
      // If we can't read config we fail closed: do not rotate, but ack the
      // alert so the daemon does not hammer us.
      return res.status(503).json({ error: 'config unavailable' });
    }

    if (!autoOn) {
      try {
        await notifyAdmins(
          [
            `⚠️ Block alert received but auto-rotation is OFF`,
            `from: ${currentIp || 'unknown'}`,
            reason ? `reason: ${reason}` : null,
            ``,
            `No rotation performed. Tap 🔄 Manual Update to rotate now, or tap the 🔴 Auto: OFF button to turn auto-rotation back on.`,
          ].filter(Boolean).join('\n'),
        );
      } catch (err) {
        console.error('[api] notifyAdmins failed (auto-off path)', err);
      }
      return res.json({ ok: true, skipped: 'auto-rotate-disabled' });
    }

    if (activeRotation) {
      console.log('[api] alert coalesced into in-flight rotation');
      try {
        const result = await activeRotation;
        return res.json({ ok: true, coalesced: true, ...result });
      } catch (err) {
        return respondWithRotationError(res, err);
      }
    }

    const trigger = `alert from ${currentIp || 'unknown'}${reason ? ` — ${reason}` : ''}`;
    activeRotation = rotate({ trigger, notifyAdmins });

    try {
      const result = await activeRotation;
      return res.json({
        ok: true,
        newForwardIp: result.newForwardIp,
        newCdnIp: result.newCdnIp,
        shadowsocks: result.shadowsocks,
        vlessWs: result.vlessWs,
        skipped: result.skipped,
        oldForwardIps: result.oldForwardIps,
        oldCdnIps: result.oldCdnIps,
      });
    } catch (err) {
      // rotate.js already broadcasts a tailored Telegram message for known
      // failure classes (POOL_EMPTY / MARZBAN_*). Anything without a code
      // is unexpected — surface the raw error to chat too.
      if (!err?.code) report('api/rotate', err);
      return respondWithRotationError(res, err);
    } finally {
      activeRotation = null;
    }
  });

  app.use((err, _req, res, _next) => {
    console.error('[api] unhandled', err);
    report('api/unhandled', err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

function respondWithRotationError(res, err) {
  // rotate() already broadcast a Telegram message describing the failure;
  // here we just translate the error class into an HTTP shape the daemon
  // can react to.
  const code = err?.code;
  if (code === 'POOL_EMPTY') {
    return res.status(409).json({ error: err.message, code });
  }
  if (code === 'MARZBAN_UNAVAILABLE') {
    return res.status(502).json({ error: 'marzban unreachable', code });
  }
  if (code === 'MARZBAN_AUTH' || code === 'MARZBAN_CREDS_MISSING') {
    return res.status(503).json({ error: 'marzban credentials problem', code });
  }
  return res.status(500).json({ error: err?.message || 'internal' });
}
