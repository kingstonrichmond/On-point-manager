import { getStore } from "@netlify/blobs";

// Guide photos live here instead of in the repo, so nobody has to commit a file
// to change a wall guide. Keys are stable slugs; the app cache-busts with a ?v=
// timestamp when a photo is replaced, which lets us cache hard.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  let store;
  try {
    store = getStore({ name: "onpoint-media", consistency: "strong" });
  } catch (e) {
    return json({ error: "Storage unavailable: " + e.message }, 500);
  }

  const url = new URL(req.url);
  const key = (url.searchParams.get("key") || "").trim();

  if (req.method === "GET") {
    if (!key) {
      try {
        const { blobs } = await store.list();
        return json({ keys: (blobs || []).map((b) => b.key) });
      } catch (e) {
        return json({ error: "List failed: " + e.message }, 500);
      }
    }
    try {
      const res = await store.getWithMetadata(key, { type: "text" });
      if (!res || !res.data) return json({ error: "Not found" }, 404);
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
        },
      });
    } catch (e) {
      return json({ error: "Not found" }, 404);
    }
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: "Body wasn't valid JSON." }, 400);
    }
    if (!body || !body.key || !body.data) {
      return json({ error: "Expected { key, data, contentType }." }, 400);
    }
    const k = String(body.key).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
    if (!k) return json({ error: "Bad key." }, 400);
    // If CAM_TOKEN is configured, camera frames must carry it. Guide photos are
    // uploaded from the browser and aren't covered by it.
    const camToken = process.env.CAM_TOKEN;
    if (camToken && k.indexOf("cam-") === 0 && body.token !== camToken) {
      return json({ error: "Camera token missing or wrong." }, 403);
    }
    try {
      const at = Date.now();
      await store.set(k, String(body.data), {
        metadata: { contentType: String(body.contentType || "image/jpeg"), at },
      });
      return json({ key: k, at });
    } catch (e) {
      return json({ error: "Write failed: " + e.message }, 500);
    }
  }

  if (req.method === "DELETE") {
    if (!key) return json({ error: "Expected ?key=" }, 400);
    try {
      await store.delete(key);
      return json({ key, deleted: true });
    } catch (e) {
      return json({ error: "Delete failed: " + e.message }, 500);
    }
  }

  return json({ error: "Use GET, POST or DELETE." }, 405);
};
