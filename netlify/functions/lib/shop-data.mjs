// shop-data.mjs — loads the All Day Ops data document and normalizes the parts
// a phone agent needs into one stable shape, regardless of how the tab code
// stores them. Everything downstream (prompt builder, tools, order sink) reads
// ONLY the normalized shape, so when the real field names are confirmed the
// only file that changes is this one.
//
// Normalized shape:
// {
//   profile:  { name, phone, address, brandNotes, timezone },
//   hours:    { days: [{open, close}] x7 (0=Sun, hours as decimal 24h), shiftChange },
//   menu:     [{ id, name, category, description, sizes:[{label, price}], price, options:[...], tags:[...] }],
//   eightySix:{ items: Set<lowercased names/ids>, categories: Set<lowercased category>, notes: [...] },
//   wait:     { pickupMin, deliveryMin, updatedAt, source },
//   escalation: { transferNumber, rules: [...] },
//   agent:    { quotePrices: 'always'|'on-request'|'never', greeting, extraNotes, upsell:boolean },
//   raw: data
// }

// @netlify/blobs is imported lazily so the pure logic runs in tests without it.
async function blobs() { return import('@netlify/blobs'); }

const DEFAULT_HOURS = [
  { open: 12, close: 21 }, // Sun
  { open: 11, close: 21 }, // Mon
  { open: 11, close: 21 }, // Tue
  { open: 11, close: 21 }, // Wed
  { open: 11, close: 22 }, // Thu
  { open: 11, close: 22 }, // Fri
  { open: 11, close: 22 }, // Sat
];

/** Load the {rev,data} document exactly as data.mjs stores it. */
export async function loadShopData(env = process.env) {
  // These two names must match what data.mjs uses. Until confirmed they are
  // env-configurable so nothing here has to change when we see data.mjs.
  const storeName = env.OPP_BLOB_STORE || 'opp';
  const key = env.OPP_BLOB_KEY || 'data';
  const { getStore } = await blobs();
  const store = getStore(storeName);
  const doc = await store.get(key, { type: 'json' });
  if (!doc) throw new Error(`No shop data at blob store "${storeName}" key "${key}"`);
  return doc.data ?? doc; // data.mjs wraps as {rev,data}; tolerate a bare doc
}

/** Same, but for a saved snapshot on disk (tests, local dev). */
export function loadShopDataFromObject(obj) {
  return obj?.data ?? obj;
}

// ---------- helpers ----------
const lc = (s) => String(s ?? '').trim().toLowerCase();
/** lowercase + drop punctuation so "dels" finds "Del's" and "mozz sticks" finds "Mozz. Sticks" */
export const squash = (s) => lc(s).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const num = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const firstOf = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null);

/** "11-9", "11:30-10", "12–9" → {open:11.5, close:22} — mirrors the shop-clock parser idea. */
export function parseHourSpan(s) {
  const m = String(s || '').match(/(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  let open = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  let close = Number(m[3]) + (m[4] ? Number(m[4]) / 60 : 0);
  if (open < 8) open += 12; // "1-9" means 1pm
  if (close <= open) close += 12; // "11-9" means 9pm
  return { open, close };
}

function normalizeHours(data) {
  const src = firstOf(data, ['shopHours', 'hours']);
  let days = DEFAULT_HOURS;
  let shiftChange = 16;
  if (src) {
    const d = firstOf(src, ['days']) ?? src;
    const list = arr(d);
    if (list.length === 7) {
      days = list.map((x, i) => {
        if (typeof x === 'string') return parseHourSpan(x) ?? DEFAULT_HOURS[i];
        return { open: num(x?.open, DEFAULT_HOURS[i].open), close: num(x?.close, DEFAULT_HOURS[i].close), closed: !!x?.closed };
      });
    }
    shiftChange = num(src.shiftChange, 16);
  }
  return { days, shiftChange };
}

function normalizeMenuItem(it, i, categoryHint) {
  if (typeof it === 'string') return { id: `m${i}`, name: it, category: categoryHint || 'Menu', description: '', sizes: [], price: null, options: [], tags: [] };
  const name = firstOf(it, ['name', 'item', 'title']) ?? `Item ${i + 1}`;
  const category = firstOf(it, ['category', 'section', 'group']) ?? categoryHint ?? 'Menu';
  // sizes: [{label,price}] | {Small: 12, Large: 18} | prices:{...}
  let sizes = [];
  const sz = firstOf(it, ['sizes', 'prices', 'variants']);
  if (Array.isArray(sz)) sizes = sz.map((s) => (typeof s === 'string' ? { label: s, price: null } : { label: firstOf(s, ['label', 'name', 'size']) ?? '', price: num(firstOf(s, ['price', 'amount'])) }));
  else if (sz && typeof sz === 'object') sizes = Object.entries(sz).map(([label, price]) => ({ label, price: num(price) }));
  const price = num(firstOf(it, ['price', 'basePrice', 'cost']));
  const options = arr(firstOf(it, ['options', 'toppings', 'modifiers', 'addOns'])).map((o) => (typeof o === 'string' ? { name: o, price: null } : { name: firstOf(o, ['name', 'label']) ?? '', price: num(firstOf(o, ['price', 'amount'])) }));
  const tags = arr(firstOf(it, ['tags', 'labels'])).map(String);
  const available = firstOf(it, ['available', 'inStock', 'active']);
  return {
    id: String(firstOf(it, ['id', 'key']) ?? `m${i}`),
    name: String(name),
    category: String(category),
    description: String(firstOf(it, ['description', 'desc', 'notes', 'build']) ?? ''),
    sizes: sizes.filter((s) => s.label || s.price !== null),
    price,
    options,
    tags,
    unavailable: available === false || it?.eightySix === true || it?.eightySixed === true || it?.soldOut === true,
  };
}

function normalizeMenu(data) {
  const src = firstOf(data, ['menu', 'menuItems', 'items']);
  const out = [];
  if (Array.isArray(src)) src.forEach((it, i) => out.push(normalizeMenuItem(it, i)));
  else if (src && typeof src === 'object') {
    // could be {items:[...]} or {Pizza:[...], Grinders:[...]} (category → items)
    if (Array.isArray(src.items)) src.items.forEach((it, i) => out.push(normalizeMenuItem(it, i)));
    else if (Array.isArray(src.sections)) src.sections.forEach((sec) => arr(sec.items).forEach((it, i) => out.push(normalizeMenuItem(it, out.length + i, sec.name ?? sec.title))));
    else Object.entries(src).forEach(([cat, items]) => arr(items).forEach((it, i) => out.push(normalizeMenuItem(it, out.length + i, cat))));
  }
  return out;
}

function normalizeEightySix(data, menu) {
  const src = firstOf(data, ['eightySix', 'eightysix', 'eighty6', 'e86', 'outOfStock', 'board86', 'sixed']);
  const items = new Set();
  const categories = new Set();
  const notes = [];
  const push = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') { items.add(lc(entry)); return; }
    const name = firstOf(entry, ['name', 'item', 'id', 'text']);
    const cat = firstOf(entry, ['category', 'section']);
    const isCat = entry.type === 'category' || entry.wholeCategory === true || (cat && !name);
    if (entry.active === false || entry.done === true || entry.restored === true) return;
    if (isCat) categories.add(lc(cat ?? name));
    else if (name) items.add(lc(name));
    if (entry.note || entry.reason) notes.push(`${name ?? cat}: ${entry.note ?? entry.reason}`);
  };
  if (Array.isArray(src)) src.forEach(push);
  else if (src && typeof src === 'object') {
    arr(src.items).forEach(push);
    arr(src.categories).forEach((c) => categories.add(lc(typeof c === 'string' ? c : c?.name)));
    if (!src.items && !src.categories) Object.entries(src).forEach(([k, v]) => { if (v === true || v?.active !== false) items.add(lc(k)); });
  }
  // items flagged unavailable on the menu itself count too
  menu.forEach((m) => { if (m.unavailable) items.add(lc(m.name)); });
  return { items, categories, notes };
}

function normalizeWait(data) {
  const src = firstOf(data, ['wait', 'waitTime', 'quotedWait', 'currentWait']);
  if (src === undefined) return { pickupMin: null, deliveryMin: null, updatedAt: null, source: 'none' };
  if (typeof src === 'number') return { pickupMin: src, deliveryMin: null, updatedAt: null, source: 'manual' };
  return {
    pickupMin: num(firstOf(src, ['pickupMin', 'pickup', 'minutes', 'min'])),
    deliveryMin: num(firstOf(src, ['deliveryMin', 'delivery'])),
    updatedAt: firstOf(src, ['updatedAt', 'at', 'ts']) ?? null,
    source: 'manual',
  };
}

function normalizeProfile(data) {
  const p = data?.shopProfile ?? {};
  return {
    name: p.name ?? data?.shopName ?? 'the shop',
    phone: p.phone ?? '',
    address: p.address ?? p.location ?? '',
    brandNotes: p.brandNotes ?? p.notes ?? '',
    timezone: p.timezone ?? 'America/New_York',
  };
}

function normalizeAgentSettings(data) {
  const a = data?.phoneAgent ?? data?.agent ?? {};
  return {
    quotePrices: a.quotePrices ?? 'on-request', // Chris: don't volunteer the price unless asked
    greeting: a.greeting ?? '',
    extraNotes: a.extraNotes ?? a.notes ?? '',
    upsell: a.upsell ?? false,
    delivery: a.delivery ?? false, // On Point is pickup + 3rd-party; no in-house delivery assumed
    transferNumber: a.transferNumber ?? data?.shopProfile?.phone ?? '',
    transferRules: arr(a.transferRules),
    maxPizzasPerCall: num(a.maxPizzasPerCall, 10),
    minutesBeforeCloseCutoff: num(a.minutesBeforeCloseCutoff, 15),
  };
}

/** Build the normalized snapshot the agent reads. */
export function normalizeShop(data) {
  const menu = normalizeMenu(data);
  const eightySix = normalizeEightySix(data, menu);
  return {
    profile: normalizeProfile(data),
    hours: normalizeHours(data),
    menu,
    eightySix,
    wait: normalizeWait(data),
    agent: normalizeAgentSettings(data),
    raw: data,
  };
}

// ---------- time helpers ----------
export function nowInShop(shop, at = new Date()) {
  const tz = shop.profile.timezone || 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24 + Number(get('minute')) / 60;
  return { dow, hour };
}

export function hourLabel(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  const ap = hh >= 12 ? 'pm' : 'am';
  const h12 = ((hh + 11) % 12) + 1;
  return mm ? `${h12}:${String(mm).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

export function shopStatus(shop, at = new Date()) {
  const { dow, hour } = nowInShop(shop, at);
  const d = shop.hours.days[dow];
  const open = !d.closed && hour >= d.open && hour < d.close;
  const minutesToClose = open ? Math.round((d.close - hour) * 60) : 0;
  return { open, dow, hour, today: d, minutesToClose, opensAt: hourLabel(d.open), closesAt: hourLabel(d.close) };
}

export function hoursText(shop) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // collapse runs of identical days: "Mon–Wed 11am–9pm"
  const rows = [];
  shop.hours.days.forEach((d, i) => {
    const label = d.closed ? 'Closed' : `${hourLabel(d.open)}–${hourLabel(d.close)}`;
    const last = rows[rows.length - 1];
    if (last && last.label === label) last.end = i; else rows.push({ start: i, end: i, label });
  });
  return rows.map((r) => `${r.start === r.end ? names[r.start] : names[r.start].slice(0, 3) + '–' + names[r.end].slice(0, 3)} ${r.label}`).join('; ');
}

// ---------- availability ----------
export function isEightySixed(shop, item) {
  const n = lc(item.name), c = lc(item.category);
  if (shop.eightySix.items.has(n) || shop.eightySix.items.has(lc(item.id))) return true;
  if (shop.eightySix.categories.has(c)) return true;
  // fuzzy: "grinders" 86'd should also catch category "Grinders & Subs"
  for (const cat of shop.eightySix.categories) if (cat && c.includes(cat)) return true;
  return false;
}

/** Loose menu lookup: exact → startsWith → all-words-contained. Returns ranked matches. */
export function findMenuItems(shop, query, limit = 5) {
  const q = squash(query);
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const score = (m) => {
    const n = squash(m.name), c = squash(m.category), d = squash(m.description);
    if (n === q) return 100;
    if (n.startsWith(q)) return 80;
    if (n.includes(q)) return 70;
    const hits = words.filter((w) => n.includes(w)).length;
    if (hits === words.length) return 60;
    if (hits) return 30 + hits;
    if (c.includes(q)) return 20;
    if (d.includes(q)) return 10;
    return 0;
  };
  return shop.menu.map((m) => ({ m, s: score(m) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.m);
}

export function priceText(item) {
  if (item.sizes.length) return item.sizes.map((s) => `${s.label} $${s.price?.toFixed(2)}`).join(', ');
  if (item.price !== null) return `$${item.price.toFixed(2)}`;
  return 'price not on file';
}

/** Compact menu text for the system prompt — one line per item, grouped by category. */
export function menuText(shop, { withPrices = true } = {}) {
  const byCat = new Map();
  shop.menu.forEach((m) => { if (!byCat.has(m.category)) byCat.set(m.category, []); byCat.get(m.category).push(m); });
  const lines = [];
  for (const [cat, items] of byCat) {
    const catOut = shop.eightySix.categories.has(lc(cat)) || [...shop.eightySix.categories].some((c) => c && lc(cat).includes(c));
    lines.push(`## ${cat}${catOut ? '  — ALL OUT TODAY (86\'d)' : ''}`);
    for (const m of items) {
      const out = isEightySixed(shop, m);
      const bits = [m.name];
      if (withPrices) bits.push(`(${priceText(m)})`);
      if (m.description) bits.push(`— ${m.description}`);
      if (m.options.length) bits.push(`[add-ons: ${m.options.map((o) => o.name + (o.price ? ` +$${o.price.toFixed(2)}` : '')).join(', ')}]`);
      lines.push(`- ${out ? '86\'d TODAY: ' : ''}${bits.join(' ')}`);
    }
  }
  return lines.join('\n');
}
