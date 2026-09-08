// clover-orders.mjs — read open tickets out of Clover.
//
// This is READ ONLY and nothing in the kitchen depends on it. It exists to (a)
// show a live ticket board next to the hand-entered Order Queue in Live Ops and
// (b) suggest a wait time so the Today tab isn't blank on a Saturday.
//
// What Clover gives us:
//   GET /v3/merchants/{mId}/orders?expand=lineItems&filter=createdTime>={ms}
//   - order.state: "open" | "locked" | null | ... — a NULL state order cannot be
//     retrieved from the list endpoint at all, which is the one real unknown here
//     (see tools/clover-orders-probe.mjs — ring in a test order and find out).
//   - order.total is in CENTS
//   - lineItems.elements[]: { name, price, note, modifications }
//
// THE HONEST LIMIT, restated so nobody forgets it later: Clover exposes no
// kitchen-display state. Nothing here knows what's fired, bumped, or in the
// window. "Open" means Clover still calls the order open, which is a proxy for
// "probably not handed to the customer yet" and nothing stronger.

const UA = 'AllDayOps-PhoneHost/1.0 (+https://alldayops.app)';

function base(env) {
  return (env.CLOVER_BASE_URL || 'https://api.clover.com').replace(/\/$/, '');
}

export function ordersConfigured(env = process.env) {
  return !!(env.CLOVER_API_TOKEN && env.CLOVER_MERCHANT_ID);
}

async function cloverGet(env, path, params = {}) {
  const url = new URL(`${base(env)}/v3/merchants/${env.CLOVER_MERCHANT_ID}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.CLOVER_API_TOKEN}`, accept: 'application/json', 'user-agent': UA },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Clover rejected the token (${res.status}) — the token needs READ ORDERS as well as read inventory`);
  if (res.status === 429) throw new Error('Clover rate limit (429)');
  if (!res.ok) throw new Error(`Clover ${path} failed (${res.status})`);
  return res.json();
}

/** Orders created in the last `hours`. Clover pages at 100 by default. */
export async function fetchRecentOrders(env = process.env, hours = 4) {
  const since = Date.now() - hours * 3600_000;
  const out = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const page = await cloverGet(env, '/orders', {
      expand: 'lineItems',
      filter: `createdTime>=${since}`,
      limit: 200,
      offset,
    });
    const rows = page?.elements ?? [];
    out.push(...rows);
    if (rows.length < 200) break;
  }
  return out;
}

// Clover's own vocabulary is inconsistent across accounts, so treat anything not
// obviously finished as still in the kitchen, and let the age cutoff clear
// stragglers a shop forgot to close.
const DONE_STATES = new Set(['paid', 'closed', 'refunded', 'cancelled', 'canceled', 'voided']);

export function isOpenTicket(order, maxAgeMin = 180) {
  if (order.deleted) return false;
  const state = String(order.state ?? '').toLowerCase();
  if (DONE_STATES.has(state)) return false;
  const age = (Date.now() - (order.createdTime || 0)) / 60000;
  if (age > maxAgeMin) return false; // a "still open" 4-hour-old ticket is a data artifact, not food
  return true;
}

const PIZZA_WORDS = /(pizza|pie|calzone|detroit|sicilian|slice)/i;

/** Clover order → the shape the board and the estimator use. */
export function normalizeTicket(order, shop = null) {
  const items = (order.lineItems?.elements ?? []).filter((li) => !li.refunded).map((li) => ({
    name: li.name || 'Item',
    note: li.note || '',
    mods: (li.modifications?.elements ?? []).map((m) => m.name).filter(Boolean),
    price: li.price ?? null,
  }));

  // "Is this a pizza" decides the oven load, so prefer the shop's own menu
  // categories when we have them and fall back to the name.
  const isPizza = (name) => {
    if (shop) {
      const m = shop.menu.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (m) return /pizza|calzone/i.test(m.category);
    }
    return PIZZA_WORDS.test(name);
  };

  const pizzas = items.filter((i) => isPizza(i.name)).length;
  return {
    id: order.id,
    createdTime: order.createdTime || null,
    ageMin: order.createdTime ? Math.max(0, Math.round((Date.now() - order.createdTime) / 60000)) : null,
    state: order.state ?? null,
    title: order.title || order.orderType?.label || '',
    note: order.note || '',
    total: order.total ?? null, // cents
    items,
    itemCount: items.length,
    pizzas,
    otherItems: items.length - pizzas,
  };
}

/**
 * Everything the board needs, plus diagnostics — because the first question
 * this has to answer isn't "how busy is it", it's "does Clover even show me a
 * ticket at the moment it's rung in".
 */
export async function loadTickets(env = process.env, shop = null, { hours = 4, maxAgeMin = 180 } = {}) {
  const orders = await fetchRecentOrders(env, hours);
  const open = orders.filter((o) => isOpenTicket(o, maxAgeMin));
  const tickets = open.map((o) => normalizeTicket(o, shop)).sort((a, b) => (a.createdTime ?? 0) - (b.createdTime ?? 0));

  const states = {};
  orders.forEach((o) => { const k = String(o.state ?? 'null'); states[k] = (states[k] || 0) + 1; });
  const newest = orders.reduce((n, o) => Math.max(n, o.createdTime || 0), 0);

  return {
    tickets,
    diagnostics: {
      ordersReturned: orders.length,
      openCount: tickets.length,
      states,
      newestOrderAgeMin: newest ? Math.round((Date.now() - newest) / 60000) : null,
      windowHours: hours,
      checkedAt: new Date().toISOString(),
    },
  };
}
