// agent-core.mjs — the vendor-independent brain: system prompt, tool schemas,
// and tool handlers. The Netlify function (agent.mjs) only adapts Vapi's webhook
// envelope to these calls; a Retell or LiveKit adapter would call the same code.

import {
  normalizeShop, shopStatus, hoursText, hourLabel, findMenuItems, isEightySixed, priceText, menuText,
} from './shop-data.mjs';
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
  const outItems = shop.menu.filter((m) => isEightySixed(shop, m)).map((m) => m.name);

  return `You are the phone host for ${shop.profile.name}${shop.profile.address ? ` (${shop.profile.address})` : ''}. You answer the phone, take pickup orders, and answer questions. You sound like a friendly, competent person who works there — brief, warm, natural. This is a voice call: keep every reply short (one or two sentences), never read lists unless asked, never use markdown, and say numbers the way a person would ("eighteen fifty", "about forty-five minutes").

CURRENT STATUS (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][st.dow]} ${hourLabel(st.hour)}): ${st.open ? `OPEN, closes at ${st.closesAt}${st.minutesToClose <= 45 ? ` — only ${st.minutesToClose} minutes left` : ''}` : `CLOSED right now — opens ${st.opensAt}`}.
HOURS: ${hoursText(shop)}.
CURRENT WAIT: ${wait === null ? 'not set by the kitchen — use get_wait_time before promising any time, and if it is still unknown say you can\'t promise a time tonight' : `${wait} minutes for pickup (set by the kitchen${shop.wait.updatedAt ? ' ' + shop.wait.updatedAt : ''})`}.
${out86.length ? `WHOLE CATEGORIES OUT TODAY: ${out86.join(', ')}.\n` : ''}${outItems.length ? `ITEMS OUT TODAY (86'd): ${outItems.join(', ')}.\n` : ''}
RULES
1. Be honest about the wait. Quote the kitchen's current wait exactly, even when it is long (a 75-minute wait on a summer Saturday is normal — say it plainly and offer to place the order anyway). Never shave the number. To-go orders are NOT jumped ahead of the queue; do not offer to rush anything.
2. ${priceRule}
3. Anything on the 86 list is out — do not take it. Offer the closest thing we do have. Use check_availability if unsure; the list above is current as of the start of this call.
4. Only sell what is on the menu. If a caller asks for something not on it, say we don't do that and offer an alternative. Use lookup_menu to confirm names, sizes and options rather than guessing.
5. Take the order item by item: size, quantity, any changes. Repeat the full order back once before placing it, then call place_order. Get the caller's first name and a callback number before placing (the caller ID is usually right — confirm it, don't re-ask digit by digit).
6. After place_order: if the result says the kitchen has it, say so and give the pickup time. If it says staff will key it in, say "you're all set, it'll be ready in about N minutes" — do NOT claim the kitchen already has the ticket.
7. Hand off to a person (use transfer_to_staff, or transferCall if available) when: the caller asks for a person twice; a large or catering order (more than ${a.maxPizzasPerCall} pizzas); a complaint about a previous order; anything about a refund, payment problem, an allergy question you cannot answer from the menu description, a delivery request${a.delivery ? '' : ' (we do not deliver in-house)'}, or anything you are not sure about. Before transferring say "let me grab someone for you". If nobody picks up, take a message with flag_for_staff.
8. Within ${a.minutesBeforeCloseCutoff} minutes of close, tell the caller we are about to close and only take the order if it is simple; after close, give tomorrow's hours and do not take an order.
9. Never make up specials, deals, or ingredients. If you don't know, say so and offer to have someone call back.
10. ${a.upsell ? 'You may suggest one add-on (a drink or a side) once, casually — never push.' : 'Do not upsell.'}
${a.extraNotes ? `\nSHOP NOTES: ${a.extraNotes}` : ''}${shop.profile.brandNotes ? `\nABOUT US: ${shop.profile.brandNotes}` : ''}

MENU (in-store prices; anything marked 86'd is out today)
${menuText(shop, { withPrices: true })}
`;
}

export function greeting(shop, at = new Date()) {
  if (shop.agent.greeting) return shop.agent.greeting;
  const st = shopStatus(shop, at);
  return st.open
    ? `Thanks for calling ${shop.profile.name}, this is the phone assistant. Pickup order, or a question?`
    : `Thanks for calling ${shop.profile.name}. We're closed right now — we open at ${st.opensAt}. I can still answer questions if you have any.`;
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
    description: 'Place a pickup order once the caller has confirmed the full order read-back. Prices are computed from the menu; do not pass prices.',
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

export function priceLine(shop, line) {
  const matches = findMenuItems(shop, line.name, 3);
  if (!matches.length) return { ok: false, error: `"${line.name}" is not on the menu` };
  const m = matches[0];
  if (isEightySixed(shop, m)) return { ok: false, error: `${m.name} is 86'd today` };
  let unit = m.price;
  let size = line.size ?? null;
  if (m.sizes.length) {
    const want = lc(line.size);
    const s = m.sizes.find((x) => lc(x.label) === want) || m.sizes.find((x) => want && lc(x.label).startsWith(want)) || (m.sizes.length === 1 ? m.sizes[0] : null);
    if (!s) return { ok: false, error: `${m.name} needs a size: ${m.sizes.map((x) => x.label).join(', ')}` };
    unit = s.price; size = s.label;
  }
  const mods = (line.mods ?? []).map(String);
  let modTotal = 0;
  for (const mod of mods) {
    const q = lc(mod);
    if (/^(no|without|hold|light|easy|less|half)\b/.test(q)) continue; // removals never cost
    const o = m.options.find((x) => lc(x.name) === q) || m.options.find((x) => new RegExp(`\\b${lc(x.name).replace(/[^a-z0-9 ]/g, '')}\\b`).test(q));
    if (o?.price) modTotal += o.price;
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
      return {
        open: st.open,
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
      if (!st.open) return { ok: false, error: 'Shop is closed; do not place the order. Give tomorrow\'s hours.' };
      const lines = [], problems = [];
      for (const l of args.items ?? []) {
        const r = priceLine(shop, l);
        if (r.ok) lines.push(r.item); else problems.push(r.error);
      }
      if (problems.length) return { ok: false, error: problems.join('; '), instruction: 'Fix these with the caller, then call place_order again.' };
      if (!lines.length) return { ok: false, error: 'No items' };
      const pizzas = lines.filter((l) => /pizza|pie/i.test(l.name)).reduce((n, l) => n + l.qty, 0);
      if (pizzas > shop.agent.maxPizzasPerCall) return { ok: false, error: `That is ${pizzas} pizzas — over the ${shop.agent.maxPizzasPerCall}-pizza limit for the phone assistant. Transfer to staff.` };
      const subtotal = round2(lines.reduce((n, l) => n + l.lineTotal, 0));
      const order = {
        id: `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: now().toISOString(),
        shop: shop.profile.name,
        channel: 'phone',
        caller: { name: args.customer_name ?? '', phone: digits(args.callback_phone) || digits(call.from) || '' },
        type: 'pickup',
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
        say: res.injected
          ? `Say: the kitchen has it, it'll be ready in about ${shop.wait.pickupMin ?? 'a few'} minutes, under the name ${args.customer_name}.`
          : `Say: you're all set, it'll be ready in about ${shop.wait.pickupMin ?? 'a few'} minutes, under the name ${args.customer_name}. Do NOT say the kitchen already has the ticket.`,
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
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(env.OPP_BLOB_STORE || 'opp');
    const key = env.OPP_BLOB_KEY || 'data';
    const doc = (await store.get(key, { type: 'json' })) ?? { rev: 0, data: {} };
    const data = doc.data ?? {};
    const flags = [...(Array.isArray(data.phoneFlags) ? data.phoneFlags : []), { id: `fl-${Date.now().toString(36)}`, at: new Date().toISOString(), done: false, ...entry, call: { id: entry.call?.id ?? null, from: entry.call?.from ?? null } }].slice(-200);
    await store.setJSON(key, { rev: (doc.rev ?? 0) + 1, data: { ...data, phoneFlags: flags } });
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
