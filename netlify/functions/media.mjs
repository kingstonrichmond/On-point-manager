import { getStore } from "@netlify/blobs";
import { checkAuth, authHeaders, denied } from "./_auth.mjs";

// Guide photos live here instead of in the repo, so nobody has to commit a file
// to change a wall guide. Keys are stable slugs; the app cache-busts with a ?v=
// timestamp when a photo is replaced, which lets us cache hard.
//
// AUTH — this one is not all-or-nothing, on purpose:
//
//   GET (no key)  = list every key in the store  -> code required
//   POST          = upload / overwrite a photo   -> code required
//   DELETE        = remove a photo               -> code required
//   GET ?key=...  = fetch one image              -> OPEN, see below
//
// The app shows photos with <img src="...media?key=guide-dough">. A browser
// loading an <img> will not send our x-opp-key header — there's no way to add
// one to an image request. So requiring a code on keyed GET would blank out
// every wall guide and camera frame in the app.
//
// Leaving it open is a real (small) gap: someone who knows the site URL AND
// guesses an exact key could pull that one image. They cannot list keys, so
// they'd be guessing blind. Nothing here is customer or employee data — it's
// wall guides and kitchen frames.
//
// To close it properly, the app has to stop using <img src> for these and
// instead fetch the bytes (which does carry the header) and render them from an
// object URL. That's an index.html change, not a change here.

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export default async (req) => {
  const auth = checkAuth(req);
  const ah = authHeaders(auth);
  const gate = () => auth.enforced && !auth.role;

  let store;
  try {
    store = getStore({ name: "onpoint-media", consistency: "strong" });
  } catch (e) {
    return json({ error: "Storage unavailable: " + e.message }, 500, ah);
  }

  const url = new URL(req.url);
  const key = (url.searchParams.get("key") || "").trim();

  if (req.method === "GET") {
    if (!key) {
      // Listing every key is exactly how someone would find things to fetch.
      if (gate()) return denied();
      try {
        const { blobs } = await store.list();
        return json({ keys: (blobs || []).map((b) => b.key) }, 200, ah);
      } catch (e) {
        return json({ error: "List failed: " + e.message }, 500, ah);
      }
    }
    // Keyed image read stays open — see the note at the top of this file.
    try {
      const res = await store.getWithMetadata(key, { type: "text" });
      if (!res || !res.data) return json({ error: "Not found" }, 404, ah);
      const ct = (res.metadata && res.metadata.contentType) || "image/jpeg";
      const bytes = Buffer.from(res.data, "base64");
      // Guide photos get a ?v= when they change, so they can cache hard. Camera
      // frames are overwritten in place every few seconds, so they must not.
      const live = key.indexOf("cam-") === 0;
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": ct,
          "cache-control": live
            ? "no-cache, max-age=0, must-revalidate"
            : "public, max-age=31536000, immutable",
          "x-captured-at": String((res.metadata && res.metadata.at) || ""),
          ...ah,
        },
      });
    } catch (e) {
      return json({ error: "Not found" }, 404, ah);
    }
  }

  if (req.method === "POST") {
    // Uploads overwrite by key, so an open POST would let anyone replace a wall
    // guide with anything. Two kinds of writer, two ways to prove it:
    //   - a signed-in tablet uploading a guide photo -> app code
    //   - the bridge PC pushing camera frames        -> CAM_TOKEN in the body
    // The bridge has no app code and never will, so the body has to be read
    // before deciding. (CameraBridge.ps1 puts the token in the JSON body, not
    // in a header — matching that exactly is what keeps the cameras alive.)
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: "Body wasn't valid JSON." }, 400, ah);
    }
    if (!body || !body.key || !body.data) {
      return json({ error: "Expected { key, data, contentType }." }, 400, ah);
    }
    const k = String(body.key).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
    if (!k) return json({ error: "Bad key." }, 400, ah);

    const camToken = process.env.CAM_TOKEN;
    const isCam = k.indexOf("cam-") === 0;

    if (isCam) {
      // A camera frame is accepted if EITHER proof holds:
      //   - it carries the right CAM_TOKEN (how the bridge PC does it), or
      //   - the caller has a valid app code (so you can post one by hand).
      // If CAM_TOKEN isn't configured at all, behavior is unchanged from
      // before: frames go through. Set CAM_TOKEN to close that.
      const tokenOk = !!camToken && body.token === camToken;
      const hasAppCode = auth.enforced && !!auth.role;
      if (camToken && !tokenOk && !hasAppCode) {
        return json({ error: "Camera token missing or wrong." }, 403, ah);
      }
    } else if (gate()) {
      // Anything that isn't a camera frame needs a real app code. A CAM_TOKEN
      // must never be usable to overwrite a wall guide.
      return denied();
    }

    try {
      const at = Date.now();
      await store.set(k, String(body.data), {
        metadata: { contentType: String(body.contentType || "image/jpeg"), at },
      });
      return json({ key: k, at }, 200, ah);
    } catch (e) {
      return json({ error: "Write failed: " + e.message }, 500, ah);
    }
  }

  if (req.method === "DELETE") {
    if (gate()) return denied();
    if (!key) return json({ error: "Expected ?key=" }, 400, ah);
    try {
      await store.delete(key);
      return json({ key, deleted: true }, 200, ah);
    } catch (e) {
      return json({ error: "Delete failed: " + e.message }, 500, ah);
    }
  }

  return json({ error: "Use GET, POST or DELETE." }, 405, ah);
};
