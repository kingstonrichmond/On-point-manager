// calls.mjs — GET /calls — the call archive, by month.
//
// Deliberately NOT part of the synced shop document. That document keeps a
// week of calls (every tablet reads it whole on every sync); older calls are
// read from here on demand when the Calls list is set to "All". No params
// lists the months with counts; ?month=YYYY-MM returns that month's records.
//
// Auth: the tablets' patched fetch already sends x-opp-key on every
// /.netlify/functions/ call, so this uses the same _auth.mjs as data.mjs.
// NO custom `path` on purpose — the key is only attached under that prefix.

import { checkAuth, authHeaders, denied } from './_auth.mjs';
import { openCallsStore, listMonths, monthCalls } from './lib/calls-store.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);
  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, ah);

  let store;
  try { store = await openCallsStore(); } catch (e) { return json({ error: 'Storage unavailable: ' + e.message }, 500, ah); }

  const month = new URL(req.url).searchParams.get('month');
  try {
    if (month) {
      const calls = await monthCalls(store, month);
      if (!calls) return json({ error: 'month must look like 2026-09' }, 400, ah);
      return json({ month, calls }, 200, ah);
    }
    return json({ months: await listMonths(store) }, 200, ah);
  } catch (e) {
    return json({ error: 'Read failed: ' + e.message }, 500, ah);
  }
};
