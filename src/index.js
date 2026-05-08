import { config } from './config.js';
import { createBot } from './bot.js';
import { createApi } from './api.js';

const { bot, notifyAdmins } = createBot();
const app = createApi({ notifyAdmins });

const server = app.listen(config.api.port, '0.0.0.0', () => {
  console.log(`[api] listening on :${config.api.port}`);
});

bot.launch().then(
  () => console.log('[bot] launched'),
  (err) => {
    console.error('[bot] failed to launch', err);
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
