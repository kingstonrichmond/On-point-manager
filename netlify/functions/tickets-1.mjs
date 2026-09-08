// tickets.mjs — GET /tickets — live ticket board + suggested wait.
//
// Deliberately NOT part of the synced shop document. Tickets change every few
// seconds; routing them through data.mjs would churn the blob every poll and
// fight every other tablet's edits (the same reason the YoLink temps were kept
// out of the assistant's context). This is its own endpoint, cached, that the
// Live Ops board polls directly and nothing writes back to.
//
// Auth: the tablets' patched fetch already sends x-opp-key / x-opp-who on every
// /.netlify/functions/ call, so this uses the same _auth.mjs as data.mjs and
// chat.mjs. Nothing new to configure.
//
// Nothing in the kitchen depends on this endpoint. If it 500s, Live Ops shows a
// message and the hand-entered Order Queue below it is untouched.

import { checkAuth, authHeaders, denied } from './_auth.mjs';
import { loadShopData, normalizeShop, openStore } from './lib/shop-data.mjs';
import { loadTickets, ordersConfigured } from './lib/clover-orders.mjs';
import { estimateWait, kitchenConfig, basisLine } from './lib/wait-estimate.mjs';

// NO custom `path` on purpose: the app's patched fetch attaches x-opp-key only
// to /.netlify/functions/* URLs, so this must stay on the default route or every
// tablet call would arrive unauthenticated.

const CACHE_KEY = 'tickets-cache';
const CACHE_MS = 10_000; // ten tablets polling shouldn't be ten Clover calls

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);
  const env = process.env;

  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, ah);

  if (!ordersConfigured(env)) {
    return json({
      enabled: false,
      reason: 'Clover is not connected. Add CLOVER_API_TOKEN and CLOVER_MERCHANT_ID (the token needs Read Orders as well as Read Inventory).',
      tickets: [], estimate: null,
    }, 200, ah);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('fresh') === '1';

  // cache
  let store = null;
  try { store = await openStore(); } catch { /* cache optional */ }
  if (!force && store) {
    try {
      const c = await store.get(CACHE_KEY, { type: 'json' });
      if (c && Date.now() - c.at < CACHE_MS) return json({ ...c.body, cached: true }, 200, ah);
    } catch { /* ignore */ }
  }

  let shop = null;
  try { shop = normalizeShop(await loadShopData(env)); } catch { /* menu is only used to classify pizzas */ }

  let payload;
  try {
    const { tickets, diagnostics } = await loadTickets(env, shop, {
      hours: Number(env.TICKETS_WINDOW_HOURS || 4),
      maxAgeMin: Number(env.TICKETS_MAX_AGE_MIN || 180),
    });
    const cfg = kitchenConfig(shop?.raw);
    const estimate = estimateWait(tickets, cfg);
    payload = {
      enabled: true,
      tickets,
      estimate: { ...estimate, line: basisLine(estimate) },
      kitchen: cfg,
      currentWait: shop?.wait ?? null,
      diagnostics,
    };
  } catch (e) {
    console.error('tickets failed', e);
    return json({ enabled: true, error: e.message, tickets: [], estimate: null }, 200, ah);
  }

  try { await store?.setJSON(CACHE_KEY, { at: Date.now(), body: payload }); } catch { /* ignore */ }
  return json(payload, 200, ah);
};
