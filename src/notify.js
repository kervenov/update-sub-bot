// Funnels every unexpected error to the admin Telegram chat.
// Routine, expected errors (rotate.js failure paths) are NOT reported here —
// they already produce their own user-facing messages. This reporter is for
// the leaks: parse errors, config IO failures, handler bugs, uncaught
// exceptions, unhandled rejections.

const TG_LIMIT = 3500;

function truncate(s, max = TG_LIMIT) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function makeErrorReporter(notifyAdmins) {
  return async function report(source, err) {
    try {
      const name = err?.name || 'Error';
      const msg = err?.message || String(err);
      const causeMsg = err?.cause?.message || (typeof err?.cause === 'string' ? err.cause : null);
      const stack = err?.stack || '';

      const lines = [`🐛 [${source}] ${name}: ${msg}`];
      if (causeMsg && causeMsg !== msg) lines.push(`cause: ${causeMsg}`);
      if (stack) {
        lines.push('');
        lines.push(stack);
      }

      await notifyAdmins(truncate(lines.join('\n')));
    } catch (e) {
      console.error('[notify] failed to deliver error to admins:', e);
    }
  };
}
