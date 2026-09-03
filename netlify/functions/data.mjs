import { getStore } from "@netlify/blobs";
import { checkAuth, authHeaders, denied } from "./_auth.mjs";

// Shared shop data for the On Point manager app.
//
// Every device reads and writes the same blob. Each write carries the revision
// it was based on; if the stored revision has moved on, we reject with 409 and
// hand back the current document so the client can merge and retry. That's what
// stops one tablet's stale copy from wiping another's prep checkmarks.
//
// "strong" consistency matters here: two people tapping seconds apart must each
// see the other's write immediately, not eventually.
//
// Auth: this blob holds staff phone numbers, time-clock PINs and tip history,
// so nothing gets in or out without a valid code once codes are configured.
// See _auth.mjs.

const KEY = "shop-data";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    },
  });

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);

  let store;
  try {
    store = getStore({ name: "onpoint-manager", consistency: "strong" });
  } catch (e) {
    return json({ error: "Storage unavailable: " + e.message }, 500, ah);
  }

  if (req.method === "GET") {
    try {
      const doc = await store.get(KEY, { type: "json" });
      if (!doc) return json({ rev: 0, data: null }, 200, ah);
      return json({ rev: doc.rev || 0, data: doc.data, at: doc.at || null }, 200, ah);
    } catch (e) {
      return json({ error: "Read failed: " + e.message }, 500, ah);
    }
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: "Body wasn't valid JSON." }, 400, ah);
    }
    if (!body || typeof body !== "object" || !("data" in body)) {
      return json({ error: "Expected { data, baseRev }." }, 400, ah);
    }

    try {
      const cur = (await store.get(KEY, { type: "json" })) || { rev: 0, data: null };
      const curRev = cur.rev || 0;
      const baseRev = Number(body.baseRev);

      // First write ever, or a client that's caught up. Anything else is a
      // conflict and the client gets the current doc to merge against.
      if (curRev !== 0 && Number.isFinite(baseRev) && baseRev !== curRev) {
        return json({ conflict: true, rev: curRev, data: cur.data }, 409, ah);
      }

      const next = {
        rev: curRev + 1,
        data: body.data,
        at: Date.now(),
        // Prefer the identity the tablet is signed in as over whatever the body
        // claims, so an edit can't be attributed to someone else.
        by: auth.who || (typeof body.by === "string" ? body.by.slice(0, 40) : ""),
      };
      await store.setJSON(KEY, next);
      return json({ rev: next.rev, at: next.at }, 200, ah);
    } catch (e) {
      return json({ error: "Write failed: " + e.message }, 500, ah);
    }
  }

  return json({ error: "Use GET or POST." }, 405, ah);
};
