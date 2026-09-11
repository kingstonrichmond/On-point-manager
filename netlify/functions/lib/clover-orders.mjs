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
// window. And at On Point "open" means even less than that: the shop works
// paper slips, nobody ever closes a ticket, so every order is open forever,
// while prepaid online orders are "paid" the moment they ring in. So neither
// state feeds the estimate. The CLOCK does — an order that arrived inside the
// last `wipMinutes` is the work in progress, whatever Clover calls it
// (isRecentArrival). isOpenTicket stays for the diagnostics readout only.
//
// And not every line is kitchen work. Slices and garlic knots never print to
// the kitchen ticket; the front handles them. What decides is Clover's own
// printer routing — item tags (label/printer groups) or, failing that, a
// category allowlist the owner ticks once. See kitchenFilter.

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

/** Everything that rang in inside the window, whatever Clover calls its state. */
export function isRecentArrival(order, wipMinutes = 45, now = Date.now()) {
  if (order.deleted) return false;
  const t = Number(order.createdTime) || 0;
  return t > 0 && now - t <= wipMinutes * 60_000;
}

/**
 * Clover inventory: item id → its categories and tags. Tags are how Clover
 * routes printing (label/printer groups), so an item carrying the kitchen
 * printer's tag is kitchen work by the shop's own definition — maintained by
 * the owner as part of running the register, not by a list in here.
 *   GET /v3/merchants/{mId}/items?expand=categories,tags
 */
export async function fetchInventory(env = process.env) {
  const byId = {};
  const categories = new Set();
  const tags = new Set();
  for (let offset = 0; offset < 5000; offset += 1000) {
    const page = await cloverGet(env, '/items', { expand: 'categories,tags', limit: 1000, offset });
    const rows = page?.elements ?? [];
    rows.forEach((it) => {
      const cats = (it.categories?.elements ?? []).map((c) => c.name).filter(Boolean);
      const tg = (it.tags?.elements ?? []).map((t) => t.name).filter(Boolean);
      cats.forEach((c) => categories.add(c));
      tg.forEach((t) => tags.add(t));
      byId[it.id] = { name: it.name || '', categories: cats, tags: tg };
    });
    if (rows.length < 1000) break;
  }
  return { byId, categories: [...categories].sort(), tags: [...tags].sort(), fetchedAt: new Date().toISOString() };
}

/**
 * Which order lines are kitchen work. In order of preference:
 *   tag         cfg.kitchenTag names a tag Clover actually returned → only
 *               lines whose item carries it count
 *   categories  cfg.countCategories lists Clover categories → only those count
 *   all         nothing configured → everything counts; the number is merely
 *               conservative, never broken
 * A line with no inventory item behind it (custom item, unknown id) counts in
 * every mode — better to over-count a mystery line than to silently drop it.
 */
export function kitchenFilter(cfg = {}, inventory = null) {
  const lc = (s) => String(s || '').trim().toLowerCase();
  const byId = inventory?.byId || {};
  const tag = lc(cfg.kitchenTag);
  const tagKnown = !!tag && (inventory?.tags || []).some((t) => lc(t) === tag);
  const cats = Array.isArray(cfg.countCategories) && cfg.countCategories.length ? new Set(cfg.countCategories.map(lc)) : null;
  const mode = tagKnown ? 'tag' : cats ? 'categories' : 'all';
  const counts = (li) => {
    if (mode === 'all') return true;
    const inv = li?.item?.id ? byId[li.item.id] : null;
    if (!inv) return true;
    if (mode === 'tag') return inv.tags.some((t) => lc(t) === tag);
    return inv.categories.some((c) => cats.has(lc(c)));
  };
  return { mode, tag: cfg.kitchenTag || '', tagMissing: !!tag && !tagKnown, categories: cats ? [...cats] : null, counts };
}

const PIZZA_WORDS = /(pizza|pie|calzone|detroit|sicilian|slice)/i;

/** Clover order → the shape the board and the estimator use. `kitchen` is a
 *  kitchenFilter(); without one every line counts. */
export function normalizeTicket(order, shop = null, kitchen = null) {
  const counts = kitchen?.counts || (() => true);
  const items = (order.lineItems?.elements ?? []).filter((li) => !li.refunded).map((li) => ({
    name: li.name || 'Item',
    note: li.note || '',
    mods: (li.modifications?.elements ?? []).map((m) => m.name).filter(Boolean),
    price: li.price ?? null,
    kitchen: !!counts(li),
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

  // Only kitchen lines feed the load. The rest are on the ticket for the
  // board to show, greyed, and for nothing else.
  const kitchenItems = items.filter((i) => i.kitchen);
  const pizzas = kitchenItems.filter((i) => isPizza(i.name)).length;
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
    otherItems: kitchenItems.length - pizzas,
    kitchenItems: kitchenItems.length,
    frontItems: items.length - kitchenItems.length,
  };
}

/**
 * Everything the board needs, plus diagnostics — because the first question
 * this has to answer isn't "how busy is it", it's "does Clover even show me a
 * ticket at the moment it's rung in". The board and the estimate read the SAME
 * `tickets` — the recent arrivals — so the count on screen and the number
 * behind the suggestion can never disagree.
 */
export async function loadTickets(env = process.env, shop = null, { hours = 4, wipMinutes = 45, kitchen = null } = {}) {
  const orders = await fetchRecentOrders(env, Math.max(hours, Math.ceil(wipMinutes / 60)));
  const now = Date.now();
  const recent = orders.filter((o) => isRecentArrival(o, wipMinutes, now));
  const tickets = recent.map((o) => normalizeTicket(o, shop, kitchen)).sort((a, b) => (a.createdTime ?? 0) - (b.createdTime ?? 0));

  const states = {};
  orders.forEach((o) => { const k = String(o.state ?? 'null'); states[k] = (states[k] || 0) + 1; });
  const newest = orders.reduce((n, o) => Math.max(n, o.createdTime || 0), 0);

  return {
    tickets,
    diagnostics: {
      ordersReturned: orders.length,
      inWindow: tickets.length,
      openCount: orders.filter((o) => isOpenTicket(o)).length, // what Clover calls open — means nothing here, shown so nobody wonders
      states,
      newestOrderAgeMin: newest ? Math.round((now - newest) / 60000) : null,
      windowHours: hours,
      wipMinutes,
      checkedAt: new Date().toISOString(),
    },
  };
}
