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
import { loadTickets, ordersConfigured, fetchInventory, kitchenFilter } from './lib/clover-orders.mjs';
import { estimateWait, kitchenConfig, basisLine } from './lib/wait-estimate.mjs';

// NO custom `path` on purpose: the app's patched fetch attaches x-opp-key only
// to /.netlify/functions/* URLs, so this must stay on the default route or every
// tablet call would arrive unauthenticated.

const CACHE_KEY = 'tickets-cache';
const CACHE_MS = 10_000; // ten tablets polling shouldn't be ten Clover calls
// The inventory (which items carry which printer tags / categories) changes
// when the owner edits the register, not every minute.
const INV_KEY = 'clover-inventory';
const INV_MS = 10 * 60_000;

// "Report what was found before building on it": a few pizzas and a few
// slices/knots with the tags and categories Clover put on them, so the
// question "is there a kitchen-printer tag, and is it clean" is answered
// from the real register in the diagnostics panel, not assumed.
function sampleItems(inv) {
  if (!inv) return [];
  const all = Object.values(inv.byId || {});
  const pick = (re) => all.filter((i) => re.test(i.name)).slice(0, 3).map((i) => ({ name: i.name, tags: i.tags, categories: i.categories }));
  return [...pick(/pizza|pie\b/i), ...pick(/slice|knot/i)];
}

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
  const cfg = kitchenConfig(shop?.raw);

  // Inventory, cached. If Clover won't give it to us the filter falls back to
  // "everything counts" and says so — a conservative number, never a crash.
  let inventory = null, inventoryError = null;
  try {
    const c = store ? await store.get(INV_KEY, { type: 'json' }) : null;
    if (c && Date.now() - c.at < INV_MS) inventory = c.inv;
    else {
      inventory = await fetchInventory(env);
      try { await store?.setJSON(INV_KEY, { at: Date.now(), inv: inventory }); } catch { /* ignore */ }
    }
  } catch (e) {
    inventoryError = e.message;
    try { const c = store ? await store.get(INV_KEY, { type: 'json' }) : null; if (c) inventory = c.inv; } catch { /* ignore */ }
  }
  const kitchen = kitchenFilter(cfg, inventory);

  let payload;
  try {
    const { tickets, diagnostics } = await loadTickets(env, shop, {
      hours: Number(env.TICKETS_WINDOW_HOURS || 4),
      wipMinutes: cfg.wipMinutes,
      kitchen,
    });
    const estimate = estimateWait(tickets, cfg);
    payload = {
      enabled: true,
      tickets,
      estimate: { ...estimate, line: basisLine(estimate) },
      kitchen: cfg,
      currentWait: shop?.wait ?? null,
      diagnostics: {
        ...diagnostics,
        kitchenFilter: { mode: kitchen.mode, tag: kitchen.tag, tagMissing: kitchen.tagMissing, categories: kitchen.categories },
        tagsSeen: inventory?.tags ?? [],
        categoriesSeen: inventory?.categories ?? [],
        inventoryError,
        sample: sampleItems(inventory),
      },
    };
  } catch (e) {
    console.error('tickets failed', e);
    return json({ enabled: true, error: e.message, tickets: [], estimate: null }, 200, ah);
  }

  try { await store?.setJSON(CACHE_KEY, { at: Date.now(), body: payload }); } catch { /* ignore */ }
  return json(payload, 200, ah);
};
