// agent-core.mjs — the vendor-independent brain: system prompt, tool schemas,
// and tool handlers. The Netlify function (agent.mjs) only adapts Vapi's webhook
// envelope to these calls; a Retell or LiveKit adapter would call the same code.

import {
  normalizeShop, shopStatus, hoursText, hourLabel, findMenuItems, isEightySixed, priceText, menuText, menuNotes, squash, updateShopData,
} from './shop-data.mjs';
import { languageName, voiceSupportsMultilingual } from './voices.mjs';
import { makeSink } from './order-sink.mjs';

// ------------------------------------------------------------------ prompt
export function buildSystemPrompt(shop, at = new Date()) {
  const st = shopStatus(shop, at);
  const a = shop.agent;
  const wait = shop.wait.pickupMin;
  const priceRule = {
    always: 'State the price of each item as you add it.',
    'on-request': 'Do NOT volunteer prices. Only give a price if the caller asks for one, then answer plainly.',
    never: 'Never quote prices; if asked, say the total will be at the counter.',
  }[a.quotePrices] ?? 'Only give a price if the caller asks.';

  const out86 = [...shop.eightySix.categories].filter(Boolean);
  const catOut = (m) => shop.eightySix.categories.has(lc(m.category)) || [...shop.eightySix.categories].some((c) => c && lc(m.category).includes(c));
  const outItems = shop.menu.filter((m) => isEightySixed(shop, m) && !catOut(m)).map((m) => m.name);

  // Vapi's docs are emphatic: an assistant will not use a second language unless
  // the prompt names it. A multilingual transcriber alone does nothing.
  const langs = (a.languages || ['en']).filter(Boolean);
  const extra = langs.filter((l) => l !== 'en');
  const langRule = extra.length
    ? `\n\nLANGUAGES: You speak ${['English', ...extra.map(languageName)].join(', ')}. If the caller speaks one of these, answer in that language for the rest of the call and take the whole order in it — menu item names stay as they are on the menu. If they speak a language not on that list, say in English that you'll get someone, and use transfer_to_staff.`
    : '';

  return `You are the phone host for ${shop.profile.name}${shop.profile.address ? ` (${shop.profile.address})` : ''}. You answer the phone, take orders${a.delivery ? ' for pickup or delivery' : ' for pickup'}, and answer questions. You sound like a friendly, competent person who works there — brief, warm, natural. This is a voice call: keep every reply short (one or two sentences), never read lists unless asked, never use markdown, and say numbers the way a person would ("eighteen fifty", "about forty-five minutes").

CURRENT STATUS (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][st.dow]} ${hourLabel(st.hour)}): ${st.open ? `OPEN, closes at ${st.closesAt}${st.minutesToClose <= 45 ? ` — only ${st.minutesToClose} minutes left` : ''}` : (st.today.closed ? 'CLOSED ALL DAY today' : `CLOSED right now — opens ${st.opensAt}`)}.${st.temporary ? ` TODAY'S HOURS ARE DIFFERENT FROM USUAL${st.today.name ? ` (${st.today.name})` : ''} — quote today's, not the normal ones.` : ''}
${st.paused ? `\n*** PHONE ORDERS ARE PAUSED RIGHT NOW${a.pause.reason ? ` (${a.pause.reason})` : ''}. Do NOT take an order, and do not promise a time. Tell the caller we're not taking phone orders at the moment and they can try again shortly.${a.pausedAnswersQuestions ? ' You may still answer questions about the menu and hours.' : ' Offer to put them through to someone.'} ***\n` : ''}
HOURS: ${hoursText(shop)}.
CURRENT WAIT: ${wait === null ? 'not set by the kitchen — use get_wait_time before promising any time, and if it is still unknown say you can\'t promise a time tonight' : `${wait} minutes for pickup (set by the kitchen${shop.wait.updatedAt ? ' ' + shop.wait.updatedAt : ''})`}.
${out86.length ? `WHOLE CATEGORIES OUT TODAY: ${out86.join(', ')}.\n` : ''}${outItems.length ? `ITEMS OUT TODAY (86'd): ${outItems.join(', ')}.\n` : ''}${shop.clover?.added?.length ? `(the register has ${shop.clover.added.join(', ')} marked out)\n` : ''}${shop.eightySix.low?.length ? `RUNNING LOW (may run out during the call — fine to sell, don't promise): ${shop.eightySix.low.join(', ')}.\n` : ''}DELIVERY: ${a.delivery ? `yes — we deliver. For delivery orders get the street address${a.deliveryNotes ? ' (' + a.deliveryNotes + ')' : ''}.` : 'no in-house delivery — pickup only from the shop.'}
RULES
1. Pizza sizes are 12-inch medium, 16-inch large, 18-inch XL, plus Detroit style and a 12-inch gluten-free. If a caller says "small" for a pizza, that's the medium. A "pepperoni pizza" (or any plain topping pizza) is a Cheese Pizza with that topping added — the named specialties are the ones in the Specialty Pizza list. Topping prices depend on the size — the place_order tool prices them; you don't have to.
1b. Be honest about the wait. Quote the kitchen's current wait exactly, even when it is long (a 75-minute wait on a summer Saturday is normal — say it plainly and offer to place the order anyway). Never shave the number. To-go orders are NOT jumped ahead of the queue; do not offer to rush anything.
2. ${priceRule}
3. Anything on the 86 list is out — do not take it. Offer the closest thing we do have. Use check_availability if unsure; the list above is current as of the start of this call.
4. Only sell what is on the menu. If a caller asks for something not on it, say we don't do that and offer an alternative. Use lookup_menu to confirm names, sizes and options rather than guessing.
5. Take the order item by item: size, quantity, any changes. Repeat the full order back once before placing it, then call place_order. Get the caller's first name and a callback number before placing (the caller ID is usually right — confirm it, don't re-ask digit by digit).
6. After place_order: if the result says the kitchen has it, say so and give the pickup time. If it says staff will key it in, say "you're all set, it'll be ready in about N minutes" — do NOT claim the kitchen already has the ticket.
7. Hand off to a person (use transfer_to_staff, or transferCall if available) when: the caller asks for a person twice; a large or catering order (more than ${a.maxPizzasPerCall} pizzas); a complaint about a previous order; anything about a refund, payment problem, an allergy question you cannot answer from the menu description, ${a.delivery ? '' : 'a delivery request (we do not deliver in-house), '}or anything you are not sure about. Before transferring say "let me grab someone for you". If nobody picks up, take a message with flag_for_staff.
8. Within ${a.minutesBeforeCloseCutoff} minutes of close, tell the caller we are about to close and only take the order if it is simple; after close, give tomorrow's hours and do not take an order.
9. Never make up specials, deals, or ingredients. If you don't know, say so and offer to have someone call back.
10. ${a.upsell ? 'You may suggest one add-on (a drink or a side) once, casually — never push.' : 'Do not upsell.'}
${langRule}${menuNotes(shop.raw) ? `\nMENU NOTES: ${menuNotes(shop.raw)}` : ''}${a.extraNotes ? `\nSHOP NOTES: ${a.extraNotes}` : ''}${shop.profile.brandNotes ? `\nABOUT US: ${shop.profile.brandNotes}` : ''}

MENU (in-store prices; anything marked 86'd is out today)
${menuText(shop, { withPrices: true })}
`;
}

const HELLO = { es: 'Hola', pt: 'Olá', fr: 'Bonjour', it: 'Ciao', zh: '你好', vi: 'Xin chào', ru: 'Здравствуйте', pl: 'Cześć', ar: 'مرحبا' };

export function greeting(shop, at = new Date()) {
  const st = shopStatus(shop, at);
  const a = shop.agent;

  // Most specific state first. Each is blank by default and falls through to
  // the generated line, so a shop only writes the ones it cares about.
  if (st.paused) {
    if (a.greetingPaused) return a.greetingPaused;
    return `Thanks for calling ${shop.profile.name}. We're not taking phone orders at the moment — the kitchen is backed up. ${a.pausedAnswersQuestions ? "I can still answer questions, or you're welcome to try again in a bit." : "Please try again in a little while."}`;
  }
  const t = shop.tempHours?.active;
  if (t && t.greeting) return t.greeting;
  if (st.open && a.greetingOpen) return a.greetingOpen;
  if (!st.open && a.greetingClosed) return a.greetingClosed;
  if (a.greeting) return a.greeting; // the old single-greeting setting still works
  // One short hello per extra language is enough to tell a caller they can
  // switch, without turning the greeting into a phone-tree announcement.
  const extra = (shop.agent.languages || ['en']).filter((l) => l !== 'en' && HELLO[l]);
  const hello = extra.length ? ` ${extra.map((l) => HELLO[l]).join(', ')}.` : '';
  return st.open
    ? `Thanks for calling ${shop.profile.name}, this is the phone assistant.${hello} Pickup order, or a question?`
    : `Thanks for calling ${shop.profile.name}. We're closed right now${st.opensAt ? ` — we open at ${st.opensAt}` : ' today'}. I can still answer questions if you have any.`;
}

// ------------------------------------------------------------------ tools
// OpenAI/Vapi-style function schemas. Kept small: the fewer tools, the fewer
// wrong tool calls at voice latency.
export const TOOLS = [
  {
    name: 'lookup_menu',
    description: 'Search the menu by name or category. Returns matching items with sizes, in-store prices, description, add-ons, and whether each is available today.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What the caller asked for, e.g. "buffalo chicken pizza", "grinders", "gluten free"' } }, required: ['query'] },
  },
  {
    name: 'check_availability',
    description: 'Check whether specific items (or a whole category) are 86\'d / sold out right now.',
    parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, description: 'Item or category names to check' } }, required: ['items'] },
  },
  {
    name: 'get_wait_time',
    description: 'Get the kitchen\'s current quoted wait for pickup orders, and whether the shop is open.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'place_order',
    description: 'Place a pickup or delivery order once the caller has confirmed the full order read-back. Prices are computed from the menu; do not pass prices.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        callback_phone: { type: 'string', description: 'Digits only if possible' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Menu item name as close to the menu as possible' },
              size: { type: 'string', description: 'Size label if the item has sizes' },
              qty: { type: 'integer', minimum: 1 },
              mods: { type: 'array', items: { type: 'string' }, description: 'Add-ons / removals, e.g. "extra cheese", "no onions"' },
              notes: { type: 'string' },
            },
            required: ['name', 'qty'],
          },
        },
        order_type: { type: 'string', enum: ['pickup', 'delivery'], description: 'Default pickup' },
        delivery_address: { type: 'string', description: 'Street address, required for delivery' },
        notes: { type: 'string', description: 'Anything for the kitchen' },
        requested_time: { type: 'string', description: '"asap" or a time like "6:30pm"' },
      },
      required: ['customer_name', 'callback_phone', 'items'],
    },
  },
  {
    name: 'transfer_to_staff',
    description: 'Hand the call to a person at the counter. Call this only after telling the caller you are transferring them.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'flag_for_staff',
    description: 'Leave a note for staff when a transfer is not possible or the caller wants a callback (complaint, catering inquiry, question you could not answer).',
    parameters: { type: 'object', properties: { reason: { type: 'string' }, callback_phone: { type: 'string' }, customer_name: { type: 'string' } }, required: ['reason'] },
  },
];

// ------------------------------------------------------------------ handlers
const lc = (s) => String(s ?? '').trim().toLowerCase();

function itemSummary(shop, m) {
  return {
    name: m.name,
    category: m.category,
    available: !isEightySixed(shop, m),
    sizes: m.sizes.length ? m.sizes.map((s) => ({ size: s.label, price: s.price })) : undefined,
    price: m.sizes.length ? undefined : m.price,
    description: m.description || undefined,
    add_ons: m.options.length ? m.options.map((o) => (o.price ? `${o.name} (+$${o.price.toFixed(2)})` : o.name)) : undefined,
  };
}

const SIZE_WORDS = { small: 'medium', med: 'medium', medium: 'medium', lg: 'large', large: 'large', xl: 'xl', 'extra large': 'xl', 'x large': 'xl', extralarge: 'xl', detroit: 'detroit', square: 'detroit', 'gluten free': 'gluten', gf: 'gluten', gluten: 'gluten', fries: 'with fries', 'with fries': 'with fries', chicken: 'with chicken', 'with chicken': 'with chicken', regular: 'regular', plain: 'regular', alone: 'alone' };

function matchSize(sizes, want) {
  const w = squash(want);
  if (!w) return null;
  const canon = SIZE_WORDS[w] || w;
  return sizes.find((x) => squash(x.label) === w)
    || sizes.find((x) => squash(x.label).includes(canon))
    || sizes.find((x) => squash(x.label).includes(w))
    || (canon === 'alone' || canon === 'regular' ? sizes[0] : null);
}

export function priceLine(shop, line) {
  const matches = findMenuItems(shop, line.name, 3);
  if (!matches.length) return { ok: false, error: `"${line.name}" is not on the menu` };
  const m = matches[0];
  if (isEightySixed(shop, m)) return { ok: false, error: `${m.name} is 86'd today` };
  let unit = m.price;
  let size = line.size ?? null;
  let tierIndex = 0;
  if (m.sizes.length) {
    const s = matchSize(m.sizes, line.size) || (m.sizes.length === 1 ? m.sizes[0] : null) || (!line.size && m.sizes[0]?.label === 'alone' ? m.sizes[0] : null);
    if (!s) return { ok: false, error: `${m.name} needs a size: ${m.sizes.map((x) => x.label).join(', ')}` };
    unit = s.price; size = s.label; tierIndex = s.tierIndex ?? 0;
  }
  const mods = (line.mods ?? []).map(String);
  let modTotal = 0;
  for (const mod of mods) {
    const q = squash(mod);
    if (/^(no|without|hold|light|easy|less|half|side of|on the side)\b/.test(q)) continue; // removals never cost
    const mult = /^(extra|double)\b/.test(q) ? 2 : /^triple\b/.test(q) ? 3 : 1;
    const bare = q.replace(/^(extra|double|triple|add|with)\s+/, '');
    const find = (t) => m.options.find((x) => squash(x.name) === t) || m.options.find((x) => squash(x.name) === t.replace(/s$/, '')) || m.options.find((x) => t.includes(squash(x.name)) && squash(x.name).length > 3);
    const exact = find(q); // "extra cheese" is its own menu option — match it whole before stripping "extra"
    const o = exact || find(bare);
    if (!o) continue;
    const p = Array.isArray(o.prices) && o.prices[tierIndex] !== undefined && o.prices[tierIndex] !== null ? o.prices[tierIndex] : o.price;
    if (p) modTotal += p * (exact ? 1 : mult);
  }
  const qty = Math.max(1, Number(line.qty) || 1);
  const unitPrice = (unit ?? 0) + modTotal;
  return { ok: true, item: { name: m.name, size, qty, mods, notes: line.notes ?? '', unitPrice: round2(unitPrice), lineTotal: round2(unitPrice * qty), priced: unit !== null } };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function createHandlers({ shop, env = process.env, sink = makeSink(env), call = {}, now = () => new Date() }) {
  return {
    async lookup_menu({ query }) {
      const found = findMenuItems(shop, query, 6);
      if (!found.length) return { found: [], note: 'Nothing on the menu matches. Tell the caller we do not do that and offer something close.' };
      return { found: found.map((m) => itemSummary(shop, m)) };
    },

    async check_availability({ items }) {
      return {
        results: (items ?? []).map((q) => {
          const cat = [...shop.eightySix.categories].find((c) => c && (lc(q).includes(c) || c.includes(lc(q))));
          if (cat) return { query: q, available: false, reason: `all ${cat} are out today` };
          const m = findMenuItems(shop, q, 1)[0];
          if (!m) return { query: q, available: false, reason: 'not on the menu' };
          return { query: q, item: m.name, available: !isEightySixed(shop, m) };
        }),
      };
    },

    async get_wait_time() {
      const st = shopStatus(shop, now());
      if (st.paused) return { open: st.open, paused: true, instruction: 'Phone orders are paused. Do not quote a wait or take an order.' };
      return {
        open: st.open,
        hours_are_temporary_today: st.temporary,
        closes_at: st.closesAt,
        minutes_to_close: st.minutesToClose,
        pickup_wait_minutes: shop.wait.pickupMin,
        wait_known: shop.wait.pickupMin !== null,
        instruction: shop.wait.pickupMin === null
          ? 'The kitchen has not set a wait. Do not promise a time; say you will note "as soon as possible" and they can call back for a status.'
          : `Quote ${shop.wait.pickupMin} minutes exactly.`,
      };
    },

    async place_order(args) {
      const st = shopStatus(shop, now());
      if (st.paused) return { ok: false, error: 'Phone orders are paused right now. Do not take the order — say we are not taking phone orders at the moment and they can try again shortly.' };
      if (!st.open) return { ok: false, error: 'Shop is closed; do not place the order. Give the next opening time.' };
      const lines = [], problems = [];
      for (const l of args.items ?? []) {
        const r = priceLine(shop, l);
        if (r.ok) lines.push(r.item); else problems.push(r.error);
      }
      if (problems.length) return { ok: false, error: problems.join('; '), instruction: 'Fix these with the caller, then call place_order again.' };
      if (!lines.length) return { ok: false, error: 'No items' };
      const type = args.order_type === 'delivery' ? 'delivery' : 'pickup';
      if (type === 'delivery' && !shop.agent.delivery) return { ok: false, error: 'We do not deliver in-house. Offer pickup.' };
      if (type === 'delivery' && !String(args.delivery_address || '').trim()) return { ok: false, error: 'Delivery needs a street address. Ask for it, then call place_order again.' };
      const pizzas = lines.filter((l) => /pizza|pie/i.test(l.name)).reduce((n, l) => n + l.qty, 0);
      if (pizzas > shop.agent.maxPizzasPerCall) return { ok: false, error: `That is ${pizzas} pizzas — over the ${shop.agent.maxPizzasPerCall}-pizza limit for the phone assistant. Transfer to staff.` };
      const subtotal = round2(lines.reduce((n, l) => n + l.lineTotal, 0));
      const order = {
        id: `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: now().toISOString(),
        shop: shop.profile.name,
        channel: 'phone',
        caller: { name: args.customer_name ?? '', phone: digits(args.callback_phone) || digits(call.from) || '' },
        type,
        address: type === 'delivery' ? String(args.delivery_address).trim() : '',
        requestedAt: args.requested_time && !/asap/i.test(args.requested_time) ? args.requested_time : 'asap',
        quotedWaitMin: shop.wait.pickupMin,
        items: lines,
        subtotal,
        notes: args.notes ?? '',
        payment: 'pay-at-pickup',
        callId: call.id ?? null,
      };
      const res = await sink.submit(order, { env });
      if (!res.ok) return { ok: false, error: 'Could not save the order. Apologize and transfer to staff so they can take it.' };
      return {
        ok: true,
        order_id: order.id,
        subtotal,
        items: lines.map((l) => `${l.qty} ${l.size ? l.size + ' ' : ''}${l.name}${l.mods.length ? ' (' + l.mods.join(', ') + ')' : ''}`),
        kitchen_has_ticket: res.injected,
        ready_in_minutes: shop.wait.pickupMin,
        order_type: type,
        say: res.injected
          ? `Say: the kitchen has it, ${type === 'delivery' ? 'it\'ll be on its way in about' : 'it\'ll be ready in about'} ${shop.wait.pickupMin ?? 'a few'} minutes, under the name ${args.customer_name}.`
          : `Say: you're all set, ${type === 'delivery' ? 'it\'ll be on its way in about' : 'it\'ll be ready in about'} ${shop.wait.pickupMin ?? 'a few'} minutes, under the name ${args.customer_name}. Do NOT say the kitchen already has the ticket.`,
      };
    },

    async transfer_to_staff({ reason }) {
      const to = shop.agent.transferNumber;
      await logFlag(env, { kind: 'transfer', reason, call });
      if (!to) return { ok: false, error: 'No transfer number configured. Use flag_for_staff to take a message instead.' };
      // Vapi executes the actual transfer through its native transferCall tool; this
      // result tells the model to invoke it. Other vendors map this to their own primitive.
      return { ok: true, transfer_to: to, instruction: 'Now call transferCall (native) to connect the caller.' };
    },

    async flag_for_staff({ reason, callback_phone, customer_name }) {
      await logFlag(env, { kind: 'message', reason, phone: digits(callback_phone) || digits(call.from) || '', name: customer_name ?? '', call });
      return { ok: true, say: 'Tell the caller someone will call them back.' };
    },
  };
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

async function logFlag(env, entry) {
  try {
    await updateShopData((data) => {
      const flags = [...(Array.isArray(data.phoneFlags) ? data.phoneFlags : []), { id: `fl-${Date.now().toString(36)}`, at: new Date().toISOString(), done: false, kind: entry.kind, reason: entry.reason, phone: entry.phone ?? '', name: entry.name ?? '', call: { id: entry.call?.id ?? null, from: entry.call?.from ?? null } }].slice(-200);
      return { ...data, phoneFlags: flags };
    });
  } catch (e) {
    console.error('flag log failed', e.message);
  }
}

/** Run one tool call by name. Unknown tools return an error the model can read. */
export async function runTool(handlers, name, args) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try { return await fn(args ?? {}); } catch (e) { return { error: e.message }; }
}

export { normalizeShop };
