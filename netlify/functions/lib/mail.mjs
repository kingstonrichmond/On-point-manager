// mail.mjs — one transactional email, one fetch. No mail library.
//
//   MAIL_API_KEY     the provider's API key
//   MAIL_PROVIDER    resend | postmark | sendgrid   (default resend; a key that
//                    starts with "re_" is Resend either way)
//   MAIL_FROM        "allday <reports@alldayops.app>" — must be a sender the
//                    provider has verified
//   SUPPORT_EMAIL    where reports go
//
// Returns { ok: true, id } or { ok: false, error }. Never throws: a report that
// can't be sent is still saved, and the caller says so.
export function mailConfigured(env = process.env) {
  return !!(env.MAIL_API_KEY && env.SUPPORT_EMAIL);
}

export function providerFor(env = process.env) {
  const p = String(env.MAIL_PROVIDER || '').toLowerCase();
  if (p === 'postmark' || p === 'sendgrid' || p === 'resend') return p;
  return 'resend';
}

const parseFrom = (s) => {
  const m = String(s || '').match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  return m ? { name: (m[1] || '').trim(), email: m[2].trim() } : { name: '', email: String(s || '').trim() };
};

export async function sendMail(env, { to, replyTo, subject, text }, fetchFn = fetch) {
  if (!mailConfigured(env)) return { ok: false, error: 'No mail sender configured (MAIL_API_KEY / SUPPORT_EMAIL).' };
  const from = env.MAIL_FROM || 'allday <onboarding@resend.dev>';
  const provider = providerFor(env);
  let url, headers, body;
  if (provider === 'postmark') {
    url = 'https://api.postmarkapp.com/email';
    headers = { 'X-Postmark-Server-Token': env.MAIL_API_KEY, 'content-type': 'application/json', accept: 'application/json' };
    body = { From: from, To: to, ReplyTo: replyTo || undefined, Subject: subject, TextBody: text, MessageStream: 'outbound' };
  } else if (provider === 'sendgrid') {
    const f = parseFrom(from);
    url = 'https://api.sendgrid.com/v3/mail/send';
    headers = { authorization: 'Bearer ' + env.MAIL_API_KEY, 'content-type': 'application/json' };
    body = { personalizations: [{ to: [{ email: to }] }], from: { email: f.email, name: f.name || undefined }, reply_to: replyTo ? { email: replyTo } : undefined, subject, content: [{ type: 'text/plain', value: text }] };
  } else {
    url = 'https://api.resend.com/emails';
    headers = { authorization: 'Bearer ' + env.MAIL_API_KEY, 'content-type': 'application/json' };
    body = { from, to: [to], reply_to: replyTo || undefined, subject, text };
  }
  try {
    const r = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const raw = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, error: `${provider} ${r.status}: ${raw.slice(0, 300)}` };
    let id = null; try { const j = JSON.parse(raw); id = j.id ?? j.MessageID ?? null; } catch {}
    return { ok: true, id, provider };
  } catch (e) {
    return { ok: false, error: `${provider}: ${e.message}` };
  }
}
