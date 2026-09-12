// catalog.mjs — GET /catalog — what the register's menu actually looks like.
//
// Phase 1 of the Clover → menu sync: read-only. It fetches the whole catalog
// (items, prices in cents, availability, modifier groups with their prices,
// tags, item groups), answers the six shape questions from the data, and
// hands back a report a person can copy. Nothing here touches data.menu.
//
// Owner only: this is the entire register. A staff key gets 403, not 401 —
// the tablets' fetch patch logs a device out on any 401, and a staff tablet
// asking for this by accident is not a reason to sign it out.
//
// Cached in its own blob for an hour, OUTSIDE the synced shop document, for
// the same reason the tickets cache is: it must never churn the doc on every
// tablet. ?fresh=1 bypasses the cache. Never logs the token.

import { checkAuth, authHeaders } from './_auth.mjs';
import { openStore } from './lib/shop-data.mjs';
import { ordersConfigured } from './lib/clover-orders.mjs';
import { fetchCatalog, catalogSummary, reportText } from './lib/clover-catalog.mjs';

const CACHE_KEY = 'clover-catalog';
const CACHE_MS = 60 * 60_000;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return json({ error: 'Not authorized.' }, 401);
  if (auth.enforced && auth.role !== 'admin') return json({ error: 'Owner only.' }, 403, authHeaders(auth));
  const ah = authHeaders(auth);
  const env = process.env;

  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, ah);
  if (!ordersConfigured(env)) {
    return json({ enabled: false, reason: 'Clover is not connected. Add CLOVER_API_TOKEN and CLOVER_MERCHANT_ID (the token needs Read Inventory).' }, 200, ah);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('fresh') === '1';
  let store = null;
  try { store = await openStore(); } catch { /* cache optional */ }

  if (!force && store) {
    try {
      const c = await store.get(CACHE_KEY, { type: 'json' });
      if (c && Date.now() - c.at < CACHE_MS) return json({ ...c.body, cached: true }, 200, ah);
    } catch { /* ignore */ }
  }

  let catalog;
  try {
    catalog = await fetchCatalog(env);
  } catch (e) {
    console.error('catalog fetch failed', e.message);
    return json({ enabled: true, error: e.message }, 200, ah);
  }
  const summary = catalogSummary(catalog);
  const body = { enabled: true, fetchedAt: catalog.fetchedAt, catalog, summary, report: reportText(summary) };
  try { await store?.setJSON(CACHE_KEY, { at: Date.now(), body }); } catch { /* ignore */ }
  return json({ ...body, cached: false }, 200, ah);
};
