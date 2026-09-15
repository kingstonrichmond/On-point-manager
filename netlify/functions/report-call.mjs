// report-call.mjs — POST /report-call — "Report this call", one tap on the row.
//
// The client sends { callId, at, reason, note, urgent } and nothing else. This
// pulls the call record itself (the synced document, then the archive month),
// builds one plain-text email with the shop's identity, the call, the order it
// made, what the phone was told at the time, and the transcript; sends it with
// Reply-To set to the shop's email; writes c.report onto the call record; and
// files a copy in the central reports store. If the send fails, the report is
// still saved — the row says "couldn't send yet" and the next report retries.
//
// Auth: same _auth.mjs as everything else; staff can report a call.

import { checkAuth, authHeaders, denied } from './_auth.mjs';
import { loadShopData, normalizeShop, updateShopData } from './lib/shop-data.mjs';
import { openCallsStore, monthOf, monthCalls, patchArchivedCall } from './lib/calls-store.mjs';
import { REPORT_REASONS, reportSubject, reportText } from './lib/report.mjs';
import { sendMail, mailConfigured } from './lib/mail.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

export const REPORTS_STORE = 'onpoint-reports';

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, ah);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Body wasn\'t valid JSON.' }, 400, ah); }
  const callId = String(body?.callId || '').trim();
  const reason = String(body?.reason || '').trim();
  if (!callId) return json({ error: 'callId is required.' }, 400, ah);
  if (!REPORT_REASONS.includes(reason)) return json({ error: 'reason must be one of: ' + REPORT_REASONS.join(' / ') }, 400, ah);
  const note = String(body?.note || '').slice(0, 2000);
  const urgent = !!body?.urgent;
  const env = process.env;

  let data, shop;
  try { data = await loadShopData(env); shop = normalizeShop(data); }
  catch (e) { return json({ error: 'Shop data unavailable: ' + e.message }, 503, ah); }

  // the call: the document first, then the archive month it would be in
  let call = (Array.isArray(data.phoneCalls) ? data.phoneCalls : []).find((c) => c && c.id === callId) || null;
  let month = null;
  if (!call) {
    try {
      const store = await openCallsStore();
      month = monthOf(body?.at);
      call = ((await monthCalls(store, month)) || []).find((c) => c && c.id === callId) || null;
    } catch { /* archive optional */ }
  }
  if (!call) return json({ error: 'That call isn\'t on file.' }, 404, ah);
  const order = (Array.isArray(data.phoneOrders) ? data.phoneOrders : []).find((o) => o && o.callId === callId) || null;

  const by = auth.who || (typeof body?.by === 'string' ? body.by.slice(0, 40) : '') || '';
  const report = { at: new Date().toISOString(), by, reason, note, urgent };
  const subject = reportSubject(shop, report, call);
  const text = reportText({ shop, call, order, report, by });

  // send
  let sent = { ok: false, error: 'No mail sender configured (MAIL_API_KEY / SUPPORT_EMAIL).' };
  if (mailConfigured(env)) sent = await sendMail(env, { to: env.SUPPORT_EMAIL, replyTo: shop.profile?.email || undefined, subject, text });
  if (sent.ok) report.sentAt = new Date().toISOString(); else report.error = sent.error;

  // save — onto the call in the document (if it's there) and in the archive
  try {
    await updateShopData((d) => {
      const list = Array.isArray(d.phoneCalls) ? d.phoneCalls : [];
      const idx = list.findIndex((c) => c && c.id === callId);
      if (idx !== -1) list[idx] = { ...list[idx], report };
      return { ...d, phoneCalls: list };
    }, by || 'report');
  } catch (e) { console.error('report: document write failed', e.message); }
  try {
    const store = await openCallsStore();
    await patchArchivedCall(store, month || monthOf(call.at), callId, { report });
  } catch (e) { console.error('report: archive write failed', e.message); }
  // and a copy in the central store, keyed so a support view can list by shop and time
  try {
    const { getStore } = await import('@netlify/blobs');
    const rs = getStore({ name: REPORTS_STORE, consistency: 'strong' });
    await rs.setJSON(`reports/${report.at}-${callId}`, { shop: shop.profile?.name || '', shopEmail: shop.profile?.email || '', callId, call: { at: call.at, from: call.from, durationSec: call.durationSec, summary: call.summary, mood: call.mood ?? null }, report, subject, mail: sent });
  } catch (e) { console.error('report: central store write failed', e.message); }

  return json({ ok: true, report, sent: sent.ok, subject, mailError: sent.ok ? null : sent.error }, 200, ah);
};
