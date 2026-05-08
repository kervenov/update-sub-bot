import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optional(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : v.trim();
}

export const config = {
  marzban: {
    baseUrl: normaliseUrl(required('MARZBAN_URL')),
  },
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    adminChatIds: optional('TELEGRAM_ADMIN_CHAT_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  },
  api: {
    port: Number(optional('API_PORT', '3000')),
    token: required('API_TOKEN'),
  },
};

function normaliseUrl(url) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}
