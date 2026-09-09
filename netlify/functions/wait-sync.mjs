// wait-sync.mjs — POST /wait-sync — push a new quoted wait (or a pause) to every
// channel that can take a phone order, and say plainly which ones still need a
// human to go tap it.
//
// The shop quotes a wait in three places and they drift apart constantly: the
// phone assistant, Stream's dashboard, and Clover Online Ordering. Somebody sets
// 45 minutes on the Today tab, the website keeps saying 20, and the counter eats
// the difference. This endpoint is the one place that fans the number out.
//
// DESIGN RULE, same as order-sink's: never report a push we didn't make.
// Each target comes back as { target, manual, message }.
//   manual:false  we actually set it, and the message says so
//   manual:true   we could not, and the message says WHERE TO GO TAP IT
// WaitSyncStrip on the Today tab renders exactly that, so a wrong "✓" here is a
// wait nobody fixes. When in doubt, report manual.
//
// What each target can actually do today:
//   phone       automatic. The Vapi assistant is rebuilt per call from the shop
//               document (see agent.mjs assistant-request), so writing the wait
//               IS the push — it lands on the next call, no API involved.
//   stream      attempted only when Stream is configured. The order path in
//               order-sink.mjs is still a stub pending partner docs, and the
//               prep-time endpoint is likewise unconfirmed — so anything but a
//               2xx is reported as manual rather than swallowed.
//   clover-olo  always manual. Clover exposes no API for the online-ordering
//               prep time (same wall clover-orders.mjs hits from the read side);
//               it lives in the Orders app on the device.
//
// Auth: gated with _auth.mjs like every other function here. Without it anyone
// who can reach the site could set the shop's quoted wait or pause phone orders.
// Any valid role passes — the crew sets waits, not just the owner.
//
// Fire-and-forget from the app: the tablet has already written data.wait itself
// and does not wait on this response. Nothing in the kitchen depends on it.

import { checkAuth, authHeaders, denied } from './_auth.mjs';
import { updateShopData } from './lib/shop-data.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

const WAIT_MAX = 120;

/** Accept only what the app is documented to send, and clamp it. */
function readState(body) {
  const raw = body?.pickupMin;
  const n = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  const pickupMin = n === null || !Number.isFinite(n) ? null : Math.max(0, Math.min(WAIT_MAX, Math.round(n)));
  const pausedUntil = typeof body?.pausedUntil === 'string' && !Number.isNaN(Date.parse(body.pausedUntil))
    ? body.pausedUntil
    : null;
  return { pickupMin, paused: !!body?.paused, pausedUntil };
}

/** "45 minutes", or what the pause means, in the words the message needs. */
function describe(state) {
  if (state.paused) {
    const until = state.pausedUntil
      ? new Date(state.pausedUntil).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
      : null;
    return until ? `phone orders paused until ${until}` : 'phone orders paused';
  }
  if (state.pickupMin === null) return 'no wait set';
  return `${state.pickupMin} minutes`;
}

// ---------- phone: nothing to push, the document IS the source ----------
function syncPhone(state) {
  return {
    target: 'phone',
    manual: false,
    message: state.paused
      ? 'Phone assistant stops taking orders on the next call.'
      : `Phone assistant quotes ${describe(state)} on the next call.`,
  };
}

// ---------- stream ----------
const STREAM_MANUAL = 'Stream: open the Stream dashboard and set the prep time there.';

async function syncStream(state, env) {
  if (!env.STREAM_API_KEY || !env.STREAM_LOCATION_ID) {
    return { target: 'stream', manual: true, message: STREAM_MANUAL };
  }
  // Endpoint shape is a guess until the partner docs land — same footing as the
  // order stub in order-sink.mjs. STREAM_WAIT_URL overrides it without a deploy.
  const url = env.STREAM_WAIT_URL
    || `${(env.STREAM_API_URL || 'https://api.streamorders.com/v1/orders').replace(/\/orders\/?$/, '')}/locations/${env.STREAM_LOCATION_ID}/prep-time`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.STREAM_API_KEY}` },
      body: JSON.stringify({
        location_id: env.STREAM_LOCATION_ID,
        prep_time_minutes: state.pickupMin,
        accepting_orders: !state.paused,
        paused_until: state.pausedUntil,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { target: 'stream', manual: true, message: `${STREAM_MANUAL} (Stream returned ${res.status})` };
    }
    return {
      target: 'stream',
      manual: false,
      message: state.paused ? 'Stream set to not accepting orders.' : `Stream prep time set to ${describe(state)}.`,
    };
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? 'timed out' : e?.message || String(e);
    return { target: 'stream', manual: true, message: `${STREAM_MANUAL} (couldn't reach Stream — ${why})` };
  }
}

// ---------- clover online ordering ----------
// No API. Not "not built yet" — Clover doesn't expose the OLO prep time at all,
// so this stays honest rather than pretending a push happened.
function syncCloverOlo(state) {
  return {
    target: 'clover-olo',
    manual: true,
    message: state.paused
      ? 'Clover: open the Orders app on the Clover station and pause online ordering.'
      : `Clover: open the Orders app on the Clover station and set online ordering to ${describe(state)}.`,
  };
}

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);
  const env = process.env;

  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, ah);

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Body wasn't valid JSON." }, 400, ah);
  }
  const state = readState(body);

  // One slow channel must not lose the others.
  const results = [
    syncPhone(state),
    await syncStream(state, env).catch((e) => ({ target: 'stream', manual: true, message: `${STREAM_MANUAL} (${e.message})` })),
    syncCloverOlo(state),
  ];
  const waitSync = { at: new Date().toISOString(), results };

  // Write the outcome where the tablets already look. The app POSTs data.wait
  // itself at the same moment; this lands after (the pushes above take real
  // time) and updateShopData re-reads and retries on a collision, so the two
  // writes settle rather than clobber. Worst case a strip is one sync stale.
  try {
    await updateShopData((data) => ({ ...data, waitSync }), 'wait-sync');
  } catch (e) {
    console.error('wait-sync could not record the outcome', e);
    return json({ ...waitSync, recorded: false, error: e.message }, 200, ah);
  }

  return json({ ...waitSync, recorded: true }, 200, ah);
};
