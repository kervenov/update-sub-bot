import { config } from './config.js';
import { createBot } from './bot.js';
import { createApi } from './api.js';

const { bot, notifyAdmins, reportError } = createBot();
const app = createApi({ notifyAdmins, reportError });

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err);
  reportError('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[main] unhandledRejection', err);
  reportError('unhandledRejection', err);
});

const server = app.listen(config.api.port, '0.0.0.0', () => {
  console.log(`[api] listening on :${config.api.port}`);
});

server.on('error', (err) => {
  console.error('[api] server error', err);
  reportError('api/server', err);
});

bot.launch().then(
  () => console.log('[bot] launched'),
  async (err) => {
    console.error('[bot] failed to launch', err);
    await reportError('bot/launch', err);
    process.exit(1);
  },
);

function shutdown(signal) {
  console.log(`[main] ${signal} — shutting down`);
  bot.stop(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
