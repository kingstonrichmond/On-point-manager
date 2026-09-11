// agent.mjs — the All Day Ops phone-agent endpoint.
//
//   GET  /agent                 → read-only snapshot (menu w/ in-store prices, 86 board,
//                                 hours, wait, profile) for ANY voice vendor
//   GET  /agent?assistant=vapi  → a ready-to-import Vapi assistant JSON for this shop
//   POST /agent                 → Vapi server URL: assistant-request / tool-calls /
//                                 end-of-call-report
//
// Auth: one secret per shop in env AGENT_SECRET. Accepted as `x-vapi-secret`
// (what Vapi sends when you set the server credential), `x-agent-token`, or
// `Authorization: Bearer …`. Follows the same "open if unset" rule as _auth.mjs
// so a missing var can't kill the phones mid-shift — but it logs loudly.
//
// Lives next to data.mjs / chat.mjs. Netlify Functions 2.0 (default export,
// Request → Response). `path` gives it the clean URL /agent.

import { loadShopData, normalizeShop } from './lib/shop-data.mjs';
import { buildVapiAssistant, handleToolCalls, summarizeCallReport } from './lib/vapi-adapter.mjs';

export const config = { path: '/agent' };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// Vapi's dashboard has nowhere to put a plain shared secret — its credential
// screens are OAuth client-credentials forms — so the secret can ride in the
// URL instead: one long Server URL pasted once, no credential screen. `k` is
// checked LAST, after the headers, so nothing that already works changes. It's
// short and doesn't say what it is. Never log the URL.
function authorized(req, env, url) {
  const secret = env.AGENT_SECRET;
  if (!secret) { console.warn('AGENT_SECRET not set — /agent is OPEN'); return true; }
  const h = req.headers;
  const given = h.get('x-vapi-secret') || h.get('x-agent-token')
    || (h.get('authorization') || '').replace(/^Bearer\s+/i, '')
    || (url && url.searchParams.get('k')) || '';
  return given === secret;
}

export default async (req, context) => {
  const env = process.env;
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'access-control-allow-origin': env.AGENT_CORS_ORIGIN || '', 'access-control-allow-headers': 'authorization,x-agent-token,content-type' } });
  const url = new URL(req.url);
  if (!authorized(req, env, url)) return json({ error: 'unauthorized' }, 401);

  let shop;
  try {
    shop = normalizeShop(await loadShopData(env));
  } catch (e) {
    console.error('shop data load failed', e);
    return json({ error: 'shop data unavailable', detail: e.message }, 503);
  }

  // Hand out the same door we were let in through: an assistant built from a
  // ?k= request points its tools at a ?k= URL, or every tool call would 401.
  const k = url.searchParams.get('k');
  const serverUrl = `${url.origin}/agent${k ? '?k=' + encodeURIComponent(k) : ''}`;

  if (req.method === 'GET') {
    if (url.searchParams.get('assistant') === 'vapi') return json(buildVapiAssistant(shop, env, { serverUrl }));
    return json(snapshot(shop));
  }

  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const message = body?.message ?? body;
  const type = message?.type;

  switch (type) {
    case 'assistant-request':
      // Vapi asks us, per inbound call, which assistant to run → fresh prompt every call
      return json({ assistant: buildVapiAssistant(shop, env, { serverUrl }) });

    case 'tool-calls':
      return json(await handleToolCalls(message, { shop, env }));

    case 'end-of-call-report':
      await saveCall(env, summarizeCallReport(message));
      return json({ ok: true });

    default:
      return json({ ok: true, ignored: type ?? 'unknown' });
  }
};

/** Vendor-neutral read-only view. Any voice platform can be pointed at this. */
function snapshot(shop) {
  const { isEightySixed, shopStatus, hoursText } = shopFns;
  return {
    shop: shop.profile,
    status: shopStatus(shop),
    hoursText: hoursText(shop),
    hours: shop.hours,
    wait: shop.wait,
    eightySix: { items: [...shop.eightySix.items], categories: [...shop.eightySix.categories], notes: shop.eightySix.notes },
    menu: shop.menu.map((m) => ({ ...m, available: !isEightySixed(shop, m), unavailable: undefined })),
    agent: { quotePrices: shop.agent.quotePrices, delivery: shop.agent.delivery, transferNumber: shop.agent.transferNumber ? '(set)' : '' },
    generatedAt: new Date().toISOString(),
  };
}
import * as shopFns from './lib/shop-data.mjs';

const CALL_KEEP_DAYS = 7;
const CALL_KEEP_MAX = 500;

async function saveCall(env, rec) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(env.OPP_BLOB_STORE || 'opp');
    const key = env.OPP_BLOB_KEY || 'data';
    const doc = (await store.get(key, { type: 'json' })) ?? { rev: 0, data: {} };
    const data = doc.data ?? {};
    // Age out, then cap. A slow week used to keep months of transcripts and
    // recordings on the board simply because 500 hadn't been reached; the call
    // log only ever looks back a month, and the blob is read whole on every
    // sync. Seven days is the window that matters, 500 is the ceiling that
    // stops a busy Saturday from bloating the document.
    const cutoff = Date.now() - CALL_KEEP_DAYS * 86400_000;
    // An undated record can't be aged, so keep it and let the ceiling bound it
    // — dropping calls on a missing timestamp would lose the whole log if the
    // vendor ever changed the field.
    const recent = (c) => { const t = Date.parse(c?.at); return Number.isNaN(t) || t >= cutoff; };
    const prior = (Array.isArray(data.phoneCalls) ? data.phoneCalls : []).filter((c) => c.id !== rec.id && recent(c));
    const calls = [...prior, rec].slice(-CALL_KEEP_MAX);
    await store.setJSON(key, { rev: (doc.rev ?? 0) + 1, data: { ...data, phoneCalls: calls } });
  } catch (e) {
    console.error('saveCall failed', e.message);
  }
}
