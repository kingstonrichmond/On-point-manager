// calls-store.mjs — every call, by month, in its own blob store that nothing
// ages out. The synced shop document keeps a week of calls because every
// tablet reads it whole on every sync; this is where "as far back as it goes"
// lives. One JSON list per month plus a small index of counts, so the Calls
// list can offer "show earlier — Aug 2026 (412 calls)" without loading it.
export const CALLS_STORE = 'onpoint-calls';
const INDEX_KEY = 'calls/index';
const MONTH_RE = /^\d{4}-\d{2}$/;

export const monthOf = (at) => (/^\d{4}-\d{2}/.test(String(at ?? '')) ? String(at).slice(0, 7) : new Date().toISOString().slice(0, 7));

export async function openCallsStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: CALLS_STORE, consistency: 'strong' });
}

/** Append (or replace, by id) one call record in its month; keep the index current. */
export async function archiveCall(store, rec) {
  const month = monthOf(rec?.at);
  const key = 'calls/' + month;
  const list = (await store.get(key, { type: 'json' })) ?? [];
  const prior = Array.isArray(list) ? list.filter((c) => c && c.id !== rec.id) : [];
  const next = [...prior, rec];
  await store.setJSON(key, next);
  const idx = (await store.get(INDEX_KEY, { type: 'json' })) ?? {};
  const months = { ...(idx.months || {}), [month]: next.length };
  await store.setJSON(INDEX_KEY, { months, updatedAt: new Date().toISOString() });
  return { month, n: next.length };
}

/** Newest first: [{ month: 'YYYY-MM', n }]. Falls back to listing keys if the index is missing. */
export async function listMonths(store) {
  const idx = (await store.get(INDEX_KEY, { type: 'json' })) ?? null;
  let months = idx && idx.months ? Object.entries(idx.months).map(([month, n]) => ({ month, n })) : [];
  if (!months.length && typeof store.list === 'function') {
    const { blobs } = await store.list({ prefix: 'calls/' });
    months = (blobs || []).map((b) => String(b.key || '').slice(6)).filter((k) => MONTH_RE.test(k)).map((month) => ({ month, n: null }));
  }
  return months.filter((m) => MONTH_RE.test(m.month)).sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** The records of one month, oldest first as stored; null for a malformed month. */
export async function monthCalls(store, month) {
  if (!MONTH_RE.test(String(month || ''))) return null;
  const list = (await store.get('calls/' + month, { type: 'json' })) ?? [];
  return Array.isArray(list) ? list : [];
}
