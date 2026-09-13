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

/** Load the {rev,data,at,by} document exactly as data.mjs stores it. */
export const STORE_NAME = 'onpoint-manager';
export const STORE_KEY = 'shop-data';
export async function openStore() {
  const { getStore } = await blobs();
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}
export async function loadShopData(_env) {
  const store = await openStore();
  const doc = await store.get(STORE_KEY, { type: 'json' });
  if (!doc || !doc.data) throw new Error('No shop data saved yet (open the app once so it writes the first document)');
  return doc.data;
}
/** Read-modify-write with the same rev rule data.mjs enforces; retries on a race. */
export async function updateShopData(mutate, by = 'phone-agent') {
  const store = await openStore();
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = (await store.get(STORE_KEY, { type: 'json' })) || { rev: 0, data: {} };
    const data = mutate(JSON.parse(JSON.stringify(cur.data || {})));
    const next = { rev: (cur.rev || 0) + 1, data, at: Date.now(), by };
    // no compare-and-swap on Blobs; re-read to confirm nobody moved rev under us
    await store.setJSON(STORE_KEY, next);
    const check = await store.get(STORE_KEY, { type: 'json' });
    if (check && check.rev === next.rev && check.by === by) return next;
  }
  throw new Error('shop data write kept colliding');
}

/** Same, but for a saved snapshot on disk (tests, local dev). */
export function loadShopDataFromObject(obj) {
  return obj?.data ?? obj;
}

// ---------- helpers ----------
const lc = (s) => String(s ?? '').trim().toLowerCase();
/** lowercase + drop punctuation so "dels" finds "Del's" and "mozz sticks" finds "Mozz. Sticks" */
// Said out loud, not read off a screen. The phone reads this menu aloud, and the
// abbreviations that belong on a 64-pixel price column are wrong in a sentence:
// "w/ marinara" becomes "w slash marinara", 18" XL becomes "ex el", 3pc becomes
// "three p c", and an address ending in RI becomes "are eye".
//
// Expanded HERE, at the boundary, and not in the shop's own menu text: the screen
// still wants the short forms, the live document is never rewritten, and anything
// added later — or imported from the register — is covered without anyone
// remembering to spell it out. Item names on tickets stay canonical, because
// priceLine takes them from the menu record rather than from what was spoken.
const SPOKEN = [
  [/\bBBQ\b/gi, 'barbecue'],
  [/\bXL\b/gi, 'extra large'],
  // Upper case only, so these can't fire inside an ordinary word.
  [/\bGF\b/g, 'gluten free'],
  [/\bSM\b/g, 'small'], [/\bMED\b/g, 'medium'], [/\bLG\b/g, 'large'], [/\bREG\b/g, 'regular'],
  [/\bRI\b/g, 'Rhode Island'],
  [/\bw\/\s*/gi, 'with '],
  // No word boundary between a digit and a letter, so these need the digit.
  [/(\d)\s*"/g, '$1 inch'],
  [/(\d)\s*oz\b/gi, '$1 ounce'],
  [/(\d)\s*pc\b/gi, '$1 piece'],
  [/(\d)\s*ct\b/gi, '$1 count'],
  [/(\d+)\s*x\s*(\d+)/gi, '$1 by $2'],
  [/\bmtn\b/gi, 'Mountain'],
  [/\s*&\s*/g, ' and '],
  // A dash between numbers or days is a range; an em dash in prose is a pause,
  // so "herbs — try it with tomatoes" must not become "herbs to try it".
  // An en dash is a range wherever it sits — "11am–9pm", "Mon–Wed", "1.50–3.00".
  [/([A-Za-z0-9])\s*–\s*([A-Za-z0-9])/g, '$1 to $2'],
  [/(\d)\s*—\s*(\d)/g, '$1 to $2'],
  [/\s*—\s*/g, ', '],
  [/\s*·\s*/g, ', '],
];
export function sayable(text) {
  let out = String(text ?? '');
  for (const [re, to] of SPOKEN) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}
// Matching runs through the same expansion, so "barbecue chicken" and "BBQ
// Chicken" are the same thing to the order taker — which also means a caller who
// says it the long way now matches, not just the assistant reading it back.
export const squash = (s) => lc(sayable(s)).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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

const money = (v) => num(String(v ?? '').replace(/[^0-9.]/g, ''));
const splitList = (str) => String(str || '').split(/,\s*/).map((x) => x.trim()).filter(Boolean);

/** The real All Day Ops menu (data.menu with info/pizzaSizes/specialty/...) → flat items. */
function normalizeAllDayOpsMenu(m) {
  const out = [];
  const add = (o) => out.push({ id: o.id, name: o.name, category: o.category, description: o.description || '', sizes: o.sizes || [], price: o.price ?? null, options: o.options || [], tags: o.tags || [], unavailable: false, kind: o.kind || 'item' });

  // Build-your-own pizza. Topping price depends on size: toppingTiers.prices align with pizzaSizes.
  const pizzaSizes = arr(m.pizzaSizes);
  const base = arr(m.pizzaBasePrices).map(money);
  const tierIndexFor = (label) => {
    const l = lc(label);
    const i = pizzaSizes.findIndex((p) => lc(p) === l);
    if (i >= 0) return i;
    if (/gluten/.test(l)) return 0; // GF is 12" — medium topping prices
    return 0;
  };
  const toppingOptions = arr(m.toppingTiers).flatMap((t) => splitList(t.items).map((name) => ({ name, tier: t.tier, prices: arr(t.prices).map(money), price: money(arr(t.prices)[0]) })));
  const gfPrice = money((String(m.glutenFree || '').match(/\$\s*([0-9.]+)/) || [])[1]);
  const pizzaSizeList = pizzaSizes.map((label, i) => ({ label, price: base[i] ?? null, tierIndex: i }));
  if (gfPrice !== null) pizzaSizeList.splice(3, 0, { label: '12" Gluten Free', price: gfPrice, tierIndex: 0 });
  if (pizzaSizes.length) add({ id: 'pizza-cheese', name: 'Cheese Pizza', category: 'Pizza', description: 'Build your own — pick a size, add toppings', sizes: pizzaSizeList, options: toppingOptions, kind: 'pizza' });

  // Specialty pizzas: one price list shared by all
  const spSizes = arr(m.specialtySizes).map((label, i) => ({ label, price: money(arr(m.specialtyPrices)[i]), tierIndex: tierIndexFor(label) }));
  arr(m.specialty).forEach((sp) => add({ id: sp.id, name: `${sp.name} Pizza`, category: 'Specialty Pizza', description: sp.ingredients, sizes: spSizes, options: toppingOptions, kind: 'pizza' }));

  // Calzones
  if (m.calzone) {
    add({ id: 'calzone-cheese', name: 'Cheese Calzone', category: 'Calzones', description: (m.calzone.note || '') + (m.calzone.toppingsEach ? ` Toppings ${m.calzone.toppingsEach} each.` : ''), price: money(m.calzone.cheesePrice), options: toppingOptions.map((o) => ({ ...o, price: null, prices: undefined })), kind: 'calzone' });
    add({ id: 'calzone-specialty', name: 'Specialty Calzone', category: 'Calzones', description: 'Any specialty pizza made as a calzone, with marinara', price: money(m.calzone.specialtyPrice), kind: 'calzone' });
  }

  const simple = (list, category, extra = {}) => arr(list).forEach((it) => add({ id: it.id, name: it.name, category, description: it.ingredients || '', price: money(it.price), ...extra(it) }));
  simple(m.appetizers, 'Appetizers', () => ({}));

  // Tenders & wings: "...with fries" rows are a variant of the row above them
  const flavors = splitList(m.wingFlavors).map((name) => ({ name, price: null }));
  let last = null;
  arr(m.tendersWings).forEach((it) => {
    if (/^\s*\.\.\./.test(it.name) && last) { last.sizes = [{ label: 'alone', price: last.price }, { label: 'with fries', price: money(it.price) }]; last.price = null; return; }
    last = { id: it.id, name: it.name.replace(/\s*w\/.*$/, ''), category: 'Tenders & Wings', description: it.name.includes('w/') ? 'comes ' + it.name.slice(it.name.indexOf('w/')) : '', price: money(it.price), options: /wing/i.test(it.name) ? flavors : [], sizes: [] };
    add(last); last = out[out.length - 1];
  });

  arr(m.salads).forEach((it) => add({ id: it.id, name: it.name, category: 'Salads', description: it.ingredients || '', sizes: it.withChicken ? [{ label: 'regular', price: money(it.price) }, { label: 'with chicken', price: money(it.withChicken) }] : [], price: it.withChicken ? null : money(it.price), options: splitList(String(m.dressings || '').replace(/\(.*$/, '')).map((name) => ({ name: name + ' dressing', price: null })) }));
  simple(m.sandwiches?.items, 'Grinders & Wraps', () => ({}));
  arr(m.iceCream).forEach((it) => add({ id: it.id, name: it.name, category: 'Ice Cream', price: money(it.price), options: splitList(m.iceCreamFlavors).map((name) => ({ name, price: null })) }));
  simple(m.chipsCookies, 'Chips & Cookies', () => ({}));
  simple(m.drinks, 'Drinks', () => ({}));
  return out;
}

/** Free-text menu facts worth putting in the prompt (sauces, dressings, the info note). */
export function menuNotes(data) {
  const m = data?.menu || {};
  const bits = [];
  if (m.info?.note) bits.push(m.info.note);
  if (m.glutenFree) bits.push(m.glutenFree);
  if (m.calzone?.note) bits.push(m.calzone.note);
  if (m.wingFlavors) bits.push('Wing flavors: ' + m.wingFlavors + '.');
  if (m.dressings) bits.push('Dressings: ' + m.dressings + '.');
  if (m.iceCreamFlavors) bits.push('Ice cream flavors: ' + m.iceCreamFlavors + '.');
  if (m.sandwiches?.note) bits.push(m.sandwiches.note);
  return sayable(bits.join(' '));
}

function normalizeMenu(data) {
  const src = firstOf(data, ['menu', 'menuItems', 'items']);
  if (src && typeof src === 'object' && !Array.isArray(src) && (src.pizzaSizes || src.specialty || src.appetizers)) return normalizeAllDayOpsMenu(src);
  const out = [];
  if (Array.isArray(src)) src.forEach((it, i) => out.push(normalizeMenuItem(it, i)));
  else if (src && typeof src === 'object') {
    if (Array.isArray(src.items)) src.items.forEach((it, i) => out.push(normalizeMenuItem(it, i)));
    else if (Array.isArray(src.sections)) src.sections.forEach((sec) => arr(sec.items).forEach((it, i) => out.push(normalizeMenuItem(it, out.length + i, sec.name ?? sec.title))));
    else Object.entries(src).forEach(([cat, items]) => arr(items).forEach((it, i) => out.push(normalizeMenuItem(it, out.length + i, cat))));
  }
  return out;
}

// Category words a manager might 86 as a group on the board ("grinders", "wings", "salads").
const CATEGORY_WORDS = {
  'pizza': 'Pizza', 'pizzas': 'Pizza', 'specialty': 'Specialty Pizza', 'specialty pizzas': 'Specialty Pizza', 'specialties': 'Specialty Pizza',
  'calzone': 'Calzones', 'calzones': 'Calzones', 'apps': 'Appetizers', 'appetizers': 'Appetizers',
  'wings': 'Tenders & Wings', 'tenders': 'Tenders & Wings', 'chicken tenders': 'Tenders & Wings', 'tenders and wings': 'Tenders & Wings',
  'salads': 'Salads', 'salad': 'Salads', 'grinders': 'Grinders & Wraps', 'grinder': 'Grinders & Wraps', 'subs': 'Grinders & Wraps', 'sandwiches': 'Grinders & Wraps', 'wraps': 'Grinders & Wraps',
  'ice cream': 'Ice Cream', 'drinks': 'Drinks', 'soda': 'Drinks', 'cookies': 'Chips & Cookies', 'chips': 'Chips & Cookies', 'desserts': 'Chips & Cookies',
};

// An 86'd INGREDIENT takes off everything made with it. Out of eggplant means
// Moussaka and Mom's Veggie are gone too, and nobody should have to find them.
// It's a rule, not forty rows: one flag off and the whole lot comes back.
//
// Matching is on whole words in the item's name and its ingredient line, and the
// FORMS are resolved once against the real menu: if the word as typed appears on
// some item ("olives" on Mom's Veggie), only that exact form counts, so "olives"
// never catches "olive oil". Only when nothing matches as typed does it try the
// singular/plural. Anything the shop decides is a false hit lives in
// data.prep.ingredientExcept and stays excluded next time too.
// Apostrophes are dropped, not spaced, so "Mom's Veggie" normalizes to
// "moms veggie" rather than "mom s veggie" — otherwise an exclusion typed by
// hand never lines up with the one the × button writes.
const norm86 = (s) => String(s ?? '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const hay86 = (item) => ' ' + norm86(`${item.name} ${item.description || ''}`) + ' ';
const hasForm = (h, f) => f.length >= 3 && h.includes(' ' + f + ' ');
/** Everything a rule could mean, most literal first. */
function termForms(term) {
  const t = norm86(term);
  if (t.length < 3) return [];
  const out = [t];
  if (t.length > 4 && t.endsWith('es')) out.push(t.slice(0, -2));
  if (t.length > 3 && t.endsWith('s')) out.push(t.slice(0, -1));
  if (!t.endsWith('s')) { out.push(t + 's'); out.push(t + 'es'); }
  return [...new Set(out)];
}
/** The forms actually used, decided by what the menu really says. */
export function resolveTermForms(term, menu) {
  const forms = termForms(term);
  if (!forms.length) return [];
  const hays = arr(menu).map(hay86);
  const exact = forms[0];
  if (hays.some((h) => hasForm(h, exact))) return [exact];
  // Nothing on the menu says it, in any form: no cascade. The caller then treats
  // the flag as the plain item it names, which is what it did before ingredient
  // rules existed — 86ing a word that isn't on the menu must not silently do
  // nothing.
  return forms.filter((f) => hays.some((h) => hasForm(h, f)));
}
/** Does this ingredient rule take this item off? */
export function ingredientTakesOff(rule, item) {
  if (!rule || !Array.isArray(rule.forms) || !rule.forms.length) return false;
  const n = norm86(item.name);
  if ((rule.except || []).some((x) => norm86(x) === n)) return false;
  const h = hay86(item);
  return rule.forms.some((f) => hasForm(h, f));
}
/** The items a rule would take off, for the board's preview. */
export function ingredientHits(term, menu, except = []) {
  const rule = { forms: resolveTermForms(term, menu), except };
  return arr(menu).filter((m) => ingredientTakesOff(rule, m));
}

function normalizeEightySix(data, menu) {
  const items = new Set();
  const categories = new Set();
  const low = [];
  const notes = [];
  const ingredients = [];
  const exceptMap = (data?.prep?.ingredientExcept && typeof data.prep.ingredientExcept === 'object') ? data.prep.ingredientExcept : {};
  const exceptFor = (term) => arr(exceptMap[norm86(term)]).map(String);
  const flagItem = (name, note) => {
    const key = lc(name);
    const cat = CATEGORY_WORDS[key] || CATEGORY_WORDS[key.replace(/^all\s+/, '')];
    if (cat) categories.add(lc(cat)); else items.add(key);
    if (note) notes.push(`${name}: ${note}`);
  };
  // The real board: data.prep.lowStock — status "86" means out, "low" means running low
  arr(data?.prep?.lowStock).forEach((f) => {
    if (!f || !f.item) return;
    if (f.status === 'low') { low.push(f.item); return; }
    if (f.status !== '86') return;
    // An ingredient rule cascades; anything else is the single item or category
    // it names, exactly as before.
    if (f.kind === 'ingredient') {
      const forms = resolveTermForms(f.item, menu);
      if (forms.length) {
        ingredients.push({ term: String(f.item), forms, except: exceptFor(f.item) });
        if (f.notes) notes.push(`${f.item}: ${f.notes}`);
        return;
      }
    }
    flagItem(f.item, f.notes);
  });
  // Generic fallbacks (other data shapes)
  const src = firstOf(data, ['eightySix', 'eightysix', 'e86', 'board86', 'outOfStock']);
  const push = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') return flagItem(entry);
    if (entry.active === false || entry.done === true || entry.restored === true) return;
    const name = firstOf(entry, ['name', 'item', 'id', 'text']);
    const cat = firstOf(entry, ['category', 'section']);
    if (entry.type === 'category' || entry.wholeCategory === true || (cat && !name)) categories.add(lc(cat ?? name));
    else if (name) flagItem(name, entry.note ?? entry.reason);
  };
  if (Array.isArray(src)) src.forEach(push);
  else if (src && typeof src === 'object') { arr(src.items).forEach(push); arr(src.categories).forEach((c) => categories.add(lc(typeof c === 'string' ? c : c?.name))); }
  menu.forEach((m) => { if (m.unavailable) items.add(lc(m.name)); });
  return { items, categories, low, notes, ingredients };
}

// The shop's normal quote. Nobody has to set a wait on a quiet day — the phone
// says twenty minutes unless the Today box has been nudged off it.
export const DEFAULT_WAIT_MIN = 20;
function normalizeWait(data) {
  const src = firstOf(data, ['wait', 'waitTime', 'quotedWait', 'currentWait']);
  if (src === undefined) return { pickupMin: DEFAULT_WAIT_MIN, deliveryMin: null, updatedAt: null, source: 'default' };
  if (typeof src === 'number') return { pickupMin: src, deliveryMin: null, updatedAt: null, source: 'manual' };
  const pickup = num(firstOf(src, ['pickupMin', 'pickup', 'minutes', 'min']));
  return {
    pickupMin: pickup === null ? DEFAULT_WAIT_MIN : pickup,
    deliveryMin: num(firstOf(src, ['deliveryMin', 'delivery'])),
    updatedAt: firstOf(src, ['updatedAt', 'at', 'ts']) ?? null,
    source: pickup === null ? 'default' : (src.by === 'stream' ? 'stream' : 'manual'),
  };
}

function normalizeProfile(data) {
  const p = data?.shopProfile ?? {};
  const info = data?.menu?.info ?? {};
  return {
    name: p.name ?? data?.shopName ?? 'the shop',
    phone: p.phone ?? info.phone ?? '',
    address: p.address ?? info.address ?? p.location ?? '',
    brandNotes: p.brandNotes ?? p.notes ?? '',
    timezone: p.timezone ?? 'America/New_York',
  };
}

// Voice and language live in the shop data, not env vars, so changing either is
// a tap in Settings and takes effect on the NEXT CALL — no redeploy, because the
// assistant is rebuilt per call from assistant-request.
export const DEFAULT_VOICE = { provider: 'vapi', voiceId: 'Elliot', version: 2, language: 'auto' };

function normalizeVoice(v) {
  if (!v) return { ...DEFAULT_VOICE };
  if (typeof v === 'string') return { ...DEFAULT_VOICE, voiceId: v };
  const out = { provider: v.provider || 'vapi', voiceId: v.voiceId || v.id || DEFAULT_VOICE.voiceId };
  // Vapi's own voices need version 2 for the 40-language auto mode
  if (out.provider === 'vapi') { out.version = num(v.version, 2); out.language = v.language || 'auto'; }
  for (const k of ['model', 'speed', 'stability', 'similarityBoost', 'style', 'useSpeakerBoost', 'language']) {
    if (v[k] !== undefined && out[k] === undefined) out[k] = v[k];
  }
  return out;
}

const todayISOin = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date());

function normalizePause(p) {
  if (!p || typeof p !== 'object') return { on: false, until: null, reason: '' };
  const until = p.until ? String(p.until) : null;
  // an expired pause is simply not a pause
  const expired = until && Date.parse(until) && Date.parse(until) < Date.now();
  return { on: !!p.on && !expired, until: expired ? null : until, reason: p.reason ?? '' };
}

/**
 * Temporary hours for a single day — "we're not opening till four today".
 * Carries its own date so it lapses on its own; yesterday's late open must never
 * silently govern today.
 */
function normalizeTempHours(data, tz) {
  const t = data?.tempHours ?? {};
  const today = todayISOin(tz);
  const active = t.today && t.today.date === today ? {
    date: t.today.date,
    open: num(t.today.open),
    close: num(t.today.close),
    closed: !!t.today.closed,
    greeting: t.today.greeting ?? '',
    note: t.today.note ?? '',
    name: t.today.name ?? '',
  } : null;
  return {
    active,
    presets: arr(t.presets).map((p, i) => ({
      id: String(p.id ?? `tp${i}`),
      name: p.name ?? 'Special hours',
      open: num(p.open),
      close: num(p.close),
      closed: !!p.closed,
      greeting: p.greeting ?? '',
    })),
  };
}

function normalizeLink(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}
function linkFromNote(note) {
  const m = String(note || '').match(/order online at\s+([a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?)/i);
  return m ? `https://${m[1].replace(/[.,;]+$/, '')}` : '';
}
function normalizeDeliveryMode(v, data) {
  if (v === 'link' || v === 'in-house' || v === 'none') return v;
  if (v === true) return 'in-house';
  if (v === false) return 'none';
  // unset: if the menu mentions delivery AND an online-ordering link, it's a link job
  const note = data?.menu?.info?.note || '';
  if (/deliver/i.test(note) && linkFromNote(note)) return 'link';
  if (/deliver/i.test(note)) return 'in-house';
  return 'none';
}

function normalizeAgentSettings(data) {
  const a = data?.phoneAgent ?? data?.agent ?? {};
  return {
    quotePrices: a.quotePrices ?? 'on-request', // Chris: don't volunteer the price unless asked
    greeting: a.greeting ?? '',
    // Separate greetings for each state. Blank means "use the generated one".
    greetingOpen: a.greetingOpen ?? '',
    greetingClosed: a.greetingClosed ?? '',
    greetingPaused: a.greetingPaused ?? '',
    // Kill switch. `until` is an ISO time it lifts on its own — a pause nobody
    // remembers to undo is worse than never pausing, so there is always an
    // expiry unless the shop deliberately chooses "until I turn it back on".
    pause: normalizePause(a.pause),
    // When paused: still answer questions, just don't take orders. Set false to
    // hand every caller straight to a person instead.
    pausedAnswersQuestions: a.pausedAnswersQuestions !== false,
    extraNotes: a.extraNotes ?? a.notes ?? '',
    upsell: a.upsell ?? false,
    // Delivery is a MODE, not a yes/no:
    //   'link'     — no in-house drivers; delivery is via the online-ordering page,
    //                so the agent texts the caller the link (On Point's case)
    //   'in-house' — the agent takes delivery orders itself (address required)
    //   'none'     — pickup only
    // Legacy true/false still works (true → in-house, false → none).
    delivery: normalizeDeliveryMode(a.delivery, data),
    deliveryNotes: a.deliveryNotes ?? '',
    // Where "order online" points. Defaults to whatever the menu's info note says
    // ("Order online at oppgansett.com").
    orderLink: normalizeLink(a.orderLink) || linkFromNote(data?.menu?.info?.note),
    // Deliberately NOT defaulting to the shop line: if that line forwards to the
    // agent, transferring to it would loop. Set phoneAgent.transferNumber to a
    // counter cell / second line.
    transferNumber: a.transferNumber ?? '',
    transferRules: arr(a.transferRules),
    maxPizzasPerCall: num(a.maxPizzasPerCall, 10),
    voice: normalizeVoice(a.voice),
    // Model is data too, for the same reason as the voice: a wrong identifier
    // must be fixable from a phone, not a redeploy.
    modelProvider: a.modelProvider || 'anthropic',
    model: a.model || 'claude-haiku-4-5',
    // ['en'] means English only. Adding a language turns on multilingual STT and
    // tells the model, in the prompt, that it may answer in that language —
    // Vapi's docs are explicit that a model won't do it without being told.
    languages: (arr(a.languages).length ? arr(a.languages) : ['en']).map((x) => String(x).toLowerCase()),
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
    tempHours: normalizeTempHours(data, normalizeProfile(data).timezone),
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

/** Today's hours, with any temporary override winning over the weekly ones. */
export function hoursToday(shop, at = new Date()) {
  const { dow } = nowInShop(shop, at);
  const t = shop.tempHours?.active;
  if (t && (t.closed || (t.open !== null && t.close !== null))) {
    return { open: t.open, close: t.close, closed: t.closed, temporary: true, name: t.name, greeting: t.greeting, note: t.note };
  }
  return { ...shop.hours.days[dow], temporary: false };
}

export function shopStatus(shop, at = new Date()) {
  const { dow, hour } = nowInShop(shop, at);
  const d = hoursToday(shop, at);
  const open = !d.closed && hour >= d.open && hour < d.close;
  const minutesToClose = open ? Math.round((d.close - hour) * 60) : 0;
  const paused = !!shop.agent?.pause?.on;
  return {
    open, dow, hour, today: d, minutesToClose,
    opensAt: d.closed ? null : hourLabel(d.open),
    closesAt: d.closed ? null : hourLabel(d.close),
    temporary: !!d.temporary,
    paused,
    // "taking orders" is the question that actually matters — open AND not paused
    takingOrders: open && !paused,
  };
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
  // Full day names and "to" rather than "Mon–Wed": this line gets read aloud
  // every time somebody asks what time we close.
  return sayable(rows.map((r) => `${r.start === r.end ? names[r.start] : names[r.start] + ' to ' + names[r.end]} ${r.label}`).join('; '));
}

// ---------- availability ----------
export function isEightySixed(shop, item) {
  const n = squash(item.name), c = lc(item.category);
  // Out of an ingredient means out of everything made with it.
  for (const rule of (shop.eightySix.ingredients || [])) if (ingredientTakesOff(rule, item)) return true;
  for (const x of shop.eightySix.items) {
    const q = squash(x);
    if (!q) continue;
    const q1 = q.replace(/s$/, '');
    if (n === q || n.startsWith(q + ' ') || n.includes(q1 + ' ') || n.endsWith(q1) || n === q + ' pizza' || (q.length > 4 && n.includes(q) && !/pizza|calzone|grinder|salad|wrap/.test(q))) return true;
  }
  if (shop.eightySix.categories.has(c)) return true;
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
      const bits = [sayable(m.name)];
      if (withPrices) bits.push(`(${sayable(priceText(m))})`);
      if (m.description) bits.push(`— ${sayable(m.description)}`);
      if (m.options.length) bits.push(`[add-ons: ${m.options.map((o) => sayable(o.name) + (o.price ? ` +$${o.price.toFixed(2)}` : '')).join(', ')}]`);
      lines.push(`- ${out ? '86\'d TODAY: ' : ''}${bits.join(' ')}`);
    }
  }
  return lines.join('\n');
}
