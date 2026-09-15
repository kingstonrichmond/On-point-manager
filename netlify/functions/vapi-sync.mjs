// vapi-sync.mjs — POST /vapi-sync — push what the app says to the phone.
//
// The number runs a STATIC Vapi assistant (the per-call assistant-request path
// was abandoned in September when Vapi refused it), so a greeting edited in
// Setup, a pause, a wait change or an 86 would change nothing on the phone
// until this: the app calls it after any change the phone should know about,
// and it PATCHes the assistant from the shop document. Needs VAPI_API_KEY and
// VAPI_ASSISTANT_ID; without them it says so and Setup shows it plainly.
//
// Auth: same _auth.mjs as everything else; staff pausing the phone must reach
// it too.

import { checkAuth, authHeaders, denied } from './_auth.mjs';
import { loadShopData, normalizeShop } from './lib/shop-data.mjs';
import { assistantPatch } from './lib/vapi-adapter.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

export async function vapiPatch(env, patch, fetchFn = fetch) {
  const url = `${env.VAPI_API_BASE || 'https://api.vapi.ai'}/assistant/${encodeURIComponent(env.VAPI_ASSISTANT_ID)}`;
  try {
    const r = await fetchFn(url, { method: 'PATCH', headers: { authorization: 'Bearer ' + env.VAPI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const raw = await r.text().catch(() => '');
    if (!r.ok) {
      let msg = raw.slice(0, 400);
      try { const j = JSON.parse(raw); msg = Array.isArray(j.message) ? j.message.join('; ') : (j.message || j.error || msg); } catch {}
      return { ok: false, status: r.status, error: `Vapi said ${r.status}: ${msg}` };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: 'Could not reach Vapi: ' + e.message };
  }
}

export async function syncAssistant(env, shop, fetchFn = fetch) {
  if (!env.VAPI_API_KEY || !env.VAPI_ASSISTANT_ID) {
    return { ok: false, configured: false, error: 'VAPI_API_KEY and VAPI_ASSISTANT_ID are not set in Netlify, so changes made here stay here.' };
  }
  const patch = assistantPatch(shop, env);
  let r = await vapiPatch(env, patch, fetchFn);
  let note = null;
  // A voice that doesn't take a speed shouldn't block the greeting from landing.
  if (!r.ok && patch.voice && patch.voice.speed !== undefined && /speed/i.test(r.error || '')) {
    const { speed, ...voice } = patch.voice;
    r = await vapiPatch(env, { ...patch, voice }, fetchFn);
    if (r.ok) note = 'This voice does not take a speed setting; everything else landed.';
  }
  return { ok: r.ok, configured: true, at: new Date().toISOString(), assistantId: env.VAPI_ASSISTANT_ID, error: r.ok ? null : r.error, note, fields: Object.keys(patch) };
}

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, ah);
  const env = process.env;
  let shop;
  try { shop = normalizeShop(await loadShopData(env)); }
  catch (e) { return json({ ok: false, configured: true, error: 'Shop data unavailable: ' + e.message }, 503, ah); }
  return json(await syncAssistant(env, shop), 200, ah);
};
