import express from 'express';
import { config } from './config.js';
import { rotate } from './rotate.js';

export function createApi({ notifyAdmins }) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${config.api.token}`;
    if (auth !== expected) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/alert/blocked', async (req, res) => {
    const { currentIp, reason } = req.body || {};
    console.log(`[api] alert from ${currentIp || 'unknown'} (${reason || 'no reason'})`);

    try {
      const result = await rotate({
        trigger: `alert from ${currentIp || 'unknown'}${reason ? ` — ${reason}` : ''}`,
        notifyAdmins,
      });
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
      const status = err.code === 'POOL_EMPTY' ? 409 : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  app.use((err, _req, res, _next) => {
    console.error('[api] unhandled', err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
