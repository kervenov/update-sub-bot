import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import * as storage from './storage.js';
import * as configStore from './configStore.js';
import * as marzban from './marzban.js';
import { rotate } from './rotate.js';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const BTN = {
  manualUpdate: '🔄 Manual Update',
  list: '📋 List',
  marzban: '🔐 Marzban',
  addCdn: '➕ Add CDN',
  addFwd: '➕ Add Forward',
  rmCdn: '➖ Remove CDN',
  rmFwd: '➖ Remove Forward',
  setMarzban: '🔧 Set Marzban',
  cancel: '❌ Cancel',
};

const mainKeyboard = Markup.keyboard([
  [BTN.manualUpdate],
  [BTN.list, BTN.marzban],
  [BTN.addCdn, BTN.addFwd],
  [BTN.rmCdn, BTN.rmFwd],
  [BTN.setMarzban],
]).resize();

const cancelKeyboard = Markup.keyboard([[BTN.cancel]]).resize();

const pending = new Map();

function isAdmin(ctx) {
  if (config.telegram.adminChatIds.length === 0) return true;
  return config.telegram.adminChatIds.includes(ctx.chat?.id);
}

function renderPool(data) {
  const empty = '_\\(empty\\)_';
  const cdn = data.CDN.length ? data.CDN.map((ip, i) => `${i + 1}\\. \`${ip}\``).join('\n') : empty;
  const fwd = data.forward.length ? data.forward.map((ip, i) => `${i + 1}\\. \`${ip}\``).join('\n') : empty;
  return `*CDN reserve*\n${cdn}\n\n*forward reserve*\n${fwd}`;
}

async function showList(ctx) {
  const data = await storage.getAll();
  await ctx.replyWithMarkdownV2(renderPool(data), mainKeyboard);
}

async function showMarzbanStatus(ctx) {
  const { username } = await configStore.getMarzbanCredentials();
  if (!username) {
    return ctx.reply('Marzban credentials not set. Tap "🔧 Set Marzban" to configure.', mainKeyboard);
  }
  try {
    await marzban.testCredentials();
    await ctx.reply(`✅ Marzban login OK (user: ${username})\nURL: ${config.marzban.baseUrl}`, mainKeyboard);
  } catch (err) {
    await ctx.reply(`❌ Marzban login failed for ${username}: ${err.message}`, mainKeyboard);
  }
}

function parseIps(text) {
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const t of tokens) {
    if (IPV4.test(t)) valid.push(t);
    else invalid.push(t);
  }
  return { valid, invalid };
}

async function applyAdd(ctx, type, ips) {
  const added = [];
  const dup = [];
  let lastPool = [];
  for (const ip of ips) {
    const res = await storage.addIp(type, ip);
    lastPool = res.pool;
    if (res.added) added.push(ip);
    else dup.push(ip);
  }
  const lines = [];
  if (added.length) lines.push(`✅ added to ${type}:\n${added.map((ip) => `• ${ip}`).join('\n')}`);
  if (dup.length) lines.push(`↩️ already in ${type}:\n${dup.map((ip) => `• ${ip}`).join('\n')}`);
  lines.push(`pool size: ${lastPool.length}`);
  await ctx.reply(lines.join('\n\n'), mainKeyboard);
}

async function applyRemove(ctx, type, ip) {
  const { removed, pool } = await storage.removeIp(type, ip);
  await ctx.reply(
    removed ? `removed ${ip} from ${type}. pool size: ${pool.length}` : `${ip} not in ${type} pool`,
    mainKeyboard,
  );
}

async function applySetMarzban(ctx, username, password) {
  bot_telegram_safe_delete(ctx);
  await configStore.setMarzbanCredentials(username, password);
  marzban.invalidateToken();
  try {
    await marzban.testCredentials();
    await ctx.reply(`✅ Marzban credentials saved and verified (user: ${username}).`, mainKeyboard);
  } catch (err) {
    await ctx.reply(`⚠️ Saved credentials but login test failed: ${err.message}`, mainKeyboard);
  }
}

function bot_telegram_safe_delete(ctx) {
  ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}

export function createBot() {
  const bot = new Telegraf(config.telegram.token);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('not authorised');
      return;
    }
    return next();
  });

  bot.start((ctx) =>
    ctx.reply(
      [
        'update-subscription-bot ready',
        '',
        'Use the keyboard below to manage reserve pools and Marzban credentials.',
      ].join('\n'),
      mainKeyboard,
    ),
  );

  // ---- Buttons ----

  bot.hears(BTN.manualUpdate, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.reply('🔄 Triggering manual rotation...', mainKeyboard);
    try {
      await rotate({
        trigger: `manual update by chat ${ctx.chat.id}`,
        notifyAdmins,
      });
    } catch (err) {
      // notifyAdmins already broadcast the failure; nothing extra to do here.
      console.error('[bot] manual rotation failed', err);
    }
  });

  bot.hears(BTN.list, async (ctx) => {
    pending.delete(ctx.chat.id);
    await showList(ctx);
  });

  bot.hears(BTN.marzban, async (ctx) => {
    pending.delete(ctx.chat.id);
    await showMarzbanStatus(ctx);
  });

  bot.hears(BTN.addCdn, async (ctx) => {
    pending.set(ctx.chat.id, { action: 'addCdn' });
    await ctx.reply(
      'Send IPv4 address(es) to add to the CDN reserve.\nSeparate multiple IPs with commas, spaces, or new lines:',
      cancelKeyboard,
    );
  });

  bot.hears(BTN.addFwd, async (ctx) => {
    pending.set(ctx.chat.id, { action: 'addFwd' });
    await ctx.reply(
      'Send IPv4 address(es) to add to the forward reserve.\nSeparate multiple IPs with commas, spaces, or new lines:',
      cancelKeyboard,
    );
  });

  bot.hears(BTN.rmCdn, async (ctx) => {
    pending.set(ctx.chat.id, { action: 'rmCdn' });
    await ctx.reply('Send the IPv4 to remove from the CDN reserve:', cancelKeyboard);
  });

  bot.hears(BTN.rmFwd, async (ctx) => {
    pending.set(ctx.chat.id, { action: 'rmFwd' });
    await ctx.reply('Send the IPv4 to remove from the forward reserve:', cancelKeyboard);
  });

  bot.hears(BTN.setMarzban, async (ctx) => {
    pending.set(ctx.chat.id, { action: 'setMarzban' });
    await ctx.reply(
      'Send credentials as a single message:\n<username> <password>\n\nThe message will be deleted after.',
      cancelKeyboard,
    );
  });

  bot.hears(BTN.cancel, async (ctx) => {
    pending.delete(ctx.chat.id);
    await ctx.reply('Cancelled.', mainKeyboard);
  });

  // ---- Slash commands (still work as fallback) ----

  bot.command('list', showList);

  const addCmd = (type) => async (ctx) => {
    const rest = ctx.message.text.split(/\s+/).slice(1).join(' ');
    const { valid, invalid } = parseIps(rest);
    if (!valid.length) {
      return ctx.reply(`usage: /add${type.toLowerCase()} <ipv4> [ipv4 ...]`);
    }
    if (invalid.length) {
      await ctx.reply(`⚠️ skipped invalid: ${invalid.join(', ')}`);
    }
    await applyAdd(ctx, type, valid);
  };
  const rmCmd = (type) => async (ctx) => {
    const ip = (ctx.message.text.split(/\s+/)[1] || '').trim();
    if (!IPV4.test(ip)) return ctx.reply(`usage: /remove${type.toLowerCase()} <ipv4>`);
    await applyRemove(ctx, type, ip);
  };
  bot.command('addcdn', addCmd('CDN'));
  bot.command('addforward', addCmd('forward'));
  bot.command('removecdn', rmCmd('CDN'));
  bot.command('removeforward', rmCmd('forward'));

  bot.command('setmarzban', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const username = parts[1];
    const password = parts.slice(2).join(' ');
    if (!username || !password) {
      return ctx.reply('usage: /setmarzban <username> <password>');
    }
    await applySetMarzban(ctx, username, password);
  });

  bot.command('marzban', showMarzbanStatus);

  // ---- Pending-input handler (must be last) ----

  bot.on('text', async (ctx) => {
    const state = pending.get(ctx.chat.id);
    if (!state) return;
    const text = ctx.message.text.trim();

    if (state.action === 'setMarzban') {
      const parts = text.split(/\s+/);
      const username = parts[0];
      const password = parts.slice(1).join(' ');
      if (!username || !password) {
        return ctx.reply('Format: <username> <password>. Try again or tap Cancel.', cancelKeyboard);
      }
      pending.delete(ctx.chat.id);
      await applySetMarzban(ctx, username, password);
      return;
    }

    if (state.action === 'rmCdn' || state.action === 'rmFwd') {
      if (!IPV4.test(text)) {
        return ctx.reply('Invalid IPv4. Try again or tap Cancel.', cancelKeyboard);
      }
      pending.delete(ctx.chat.id);
      const type = state.action === 'rmCdn' ? 'CDN' : 'forward';
      return applyRemove(ctx, type, text);
    }

    if (state.action === 'addCdn' || state.action === 'addFwd') {
      const { valid, invalid } = parseIps(text);
      if (!valid.length) {
        return ctx.reply(
          'No valid IPv4 found. Try again or tap Cancel.\nSeparate multiple IPs with commas, spaces, or new lines.',
          cancelKeyboard,
        );
      }
      pending.delete(ctx.chat.id);
      const type = state.action === 'addCdn' ? 'CDN' : 'forward';
      if (invalid.length) {
        await ctx.reply(`⚠️ skipped invalid: ${invalid.join(', ')}`);
      }
      return applyAdd(ctx, type, valid);
    }
  });

  bot.catch((err, ctx) => {
    console.error('[bot] error in handler', err);
    ctx.reply('internal error — see server logs').catch(() => {});
  });

  async function notifyAdmins(text, opts = {}) {
    const ids = config.telegram.adminChatIds;
    if (ids.length === 0) {
      console.warn('[bot] no admin chat ids configured — alert dropped:', text);
      return;
    }
    await Promise.all(
      ids.map((id) =>
        bot.telegram
          .sendMessage(id, text, opts)
          .catch((err) => console.error(`[bot] sendMessage(${id}) failed`, err)),
      ),
    );
  }

  return { bot, notifyAdmins };
}
