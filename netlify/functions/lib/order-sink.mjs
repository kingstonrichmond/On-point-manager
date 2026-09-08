// order-sink.mjs — where a finished phone order goes.
//
// Every adapter implements:  submit(order, ctx) → { ok, ref, message, injected }
//   injected=true  means the POS/kitchen has the ticket (Stream / Checkmate)
//   injected=false means it landed somewhere a human has to key it in (dashboard)
// The agent's confirmation script reads `injected`, so it never tells a caller
// "the kitchen has it" when it doesn't.
//
// Order shape (produced by agent-core placeOrder):
// {
//   id, createdAt, shop, channel:'phone', caller:{ phone, name },
//   type:'pickup'|'delivery', requestedAt:'asap'|ISO, quotedWaitMin,
//   items:[{ name, size, qty, mods:[...], notes, unitPrice, lineTotal }],
//   subtotal, notes, payment:'pay-at-pickup', transcriptRef
// }

async function blobs() { return import('@netlify/blobs'); }

// ---------- 1. Dashboard adapter — works day one, no partner access needed ----------
// Writes the order into the All Day Ops data document under data.phoneOrders so it
// shows on the Today tab / an Orders panel; staff key it into Clover. Uses the same
// revision-checked write pattern as data.mjs (read rev → write rev+1, retry on race).
export const dashboardSink = {
  name: 'dashboard',
  async submit(order, ctx = {}) {
    const env = ctx.env ?? process.env;
    const { getStore } = await blobs();
    const store = getStore(env.OPP_BLOB_STORE || 'opp');
    const key = env.OPP_BLOB_KEY || 'data';
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = (await store.get(key, { type: 'json' })) ?? { rev: 0, data: {} };
      const data = doc.data ?? {};
      const list = Array.isArray(data.phoneOrders) ? data.phoneOrders : [];
      // keep the log bounded — last 300 orders
      const next = [...list.filter((o) => o.id !== order.id), { ...order, status: 'new', keyedIntoPos: false }].slice(-300);
      const updated = { rev: (doc.rev ?? 0) + 1, data: { ...data, phoneOrders: next } };
      try {
        await store.setJSON(key, updated, { onlyIfMatch: doc.etag }); // etag support varies; falls back to plain write
        return { ok: true, ref: order.id, injected: false, message: 'Order saved to the All Day Ops board' };
      } catch (e) {
        if (attempt === 3) throw e;
      }
    }
    return { ok: false, ref: null, injected: false, message: 'Could not save order' };
  },
};

// ---------- 2. Stream adapter (streamorders.com) — STUB until partner docs arrive ----------
// Stream is already installed at On Point and injects 3rd-party orders into Clover +
// the kitchen sticky printer. Loman is listed as a Stream "Voice AI" partner, so this
// is exactly the path Loman uses. Partner docs: stream-partner-docs.vercel.app (gated).
export const streamSink = {
  name: 'stream',
  async submit(order, ctx = {}) {
    const env = ctx.env ?? process.env;
    if (!env.STREAM_API_KEY || !env.STREAM_LOCATION_ID) {
      return { ok: false, ref: null, injected: false, message: 'Stream not configured (STREAM_API_KEY / STREAM_LOCATION_ID)' };
    }
    // Expected shape once docs are in hand — a POST of a normalized order with
    // external id, customer, fulfillment, line items w/ modifiers, totals.
    const body = toGenericOrder(order, env.STREAM_LOCATION_ID);
    const res = await fetch(env.STREAM_API_URL || 'https://api.streamorders.com/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.STREAM_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, ref: null, injected: false, message: `Stream rejected the order (${res.status})` };
    const j = await res.json().catch(() => ({}));
    return { ok: true, ref: j.id ?? order.id, injected: true, message: 'Order sent to the kitchen via Stream' };
  },
};

// ---------- 3. ItsaCheckmate adapter — the scaling path (50+ POS via one API) ----------
// Docs: https://openapi-itsacheckmate.readme.io/reference/getting-started
// OAuth2 bearer; endpoints: locations, menu (+menu-update webhooks), orders/submit.
// Developer pricing listed as $0.12/transaction (cap wording unclear on their page).
export const checkmateSink = {
  name: 'checkmate',
  async submit(order, ctx = {}) {
    const env = ctx.env ?? process.env;
    if (!env.CHECKMATE_CLIENT_ID || !env.CHECKMATE_CLIENT_SECRET || !env.CHECKMATE_LOCATION_ID) {
      return { ok: false, ref: null, injected: false, message: 'Checkmate not configured' };
    }
    const base = env.CHECKMATE_API_URL || 'https://api.itsacheckmate.com';
    const tok = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.CHECKMATE_CLIENT_ID, client_secret: env.CHECKMATE_CLIENT_SECRET }),
    }).then((r) => r.json());
    const res = await fetch(`${base}/locations/${env.CHECKMATE_LOCATION_ID}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify(toGenericOrder(order, env.CHECKMATE_LOCATION_ID)),
    });
    if (!res.ok) return { ok: false, ref: null, injected: false, message: `Checkmate rejected the order (${res.status})` };
    const j = await res.json().catch(() => ({}));
    return { ok: true, ref: j.id ?? order.id, injected: true, message: 'Order sent to the POS via Checkmate' };
  },
};

// ---------- 4. Fan-out: try the POS path, ALWAYS keep the dashboard copy ----------
export function makeSink(env = process.env) {
  const primary = { stream: streamSink, checkmate: checkmateSink, dashboard: dashboardSink }[env.ORDER_SINK || 'dashboard'] ?? dashboardSink;
  return {
    name: primary.name,
    async submit(order, ctx = {}) {
      const results = [];
      let pos = null;
      if (primary !== dashboardSink) {
        try { pos = await primary.submit(order, ctx); } catch (e) { pos = { ok: false, injected: false, message: e.message }; }
        results.push({ sink: primary.name, ...pos });
      }
      let dash;
      try { dash = await dashboardSink.submit({ ...order, posResult: pos }, ctx); } catch (e) { dash = { ok: false, injected: false, message: e.message }; }
      results.push({ sink: 'dashboard', ...dash });
      const ok = (pos?.ok) || dash.ok;
      return { ok, injected: !!pos?.ok, ref: pos?.ref ?? dash.ref ?? order.id, message: pos?.ok ? pos.message : dash.message, results };
    },
  };
}

// Normalized order → a generic aggregator payload. Both Stream and Checkmate will want
// roughly this; field names get mapped once their docs are in hand.
export function toGenericOrder(order, locationId) {
  return {
    external_id: order.id,
    location_id: locationId,
    source: 'phone-agent',
    placed_at: order.createdAt,
    fulfillment: { type: order.type, requested_at: order.requestedAt, quoted_wait_minutes: order.quotedWaitMin },
    customer: { name: order.caller?.name ?? '', phone: order.caller?.phone ?? '' },
    items: order.items.map((it) => ({
      name: it.name,
      size: it.size ?? null,
      quantity: it.qty,
      unit_price: it.unitPrice,
      modifiers: (it.mods ?? []).map((m) => ({ name: m })),
      special_instructions: it.notes ?? '',
    })),
    subtotal: order.subtotal,
    notes: order.notes ?? '',
    payment: { method: order.payment ?? 'pay-at-pickup' },
  };
}
