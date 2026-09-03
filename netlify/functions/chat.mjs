// Proxies requests to the Anthropic API so the API key never reaches the
// browser. Requires ANTHROPIC_API_KEY in Netlify: Site settings > Environment
// variables.
//
// REPLACES the old chat.js — delete that file when you add this one, or Netlify
// will have two functions claiming the same /chat route.
//
// Two changes from the old version, both about the key:
//   1. A valid app code is now required. Without this, anyone who found the URL
//      could spend the API budget.
//   2. CORS is same-origin instead of "*". The app is served from this same
//      site, so it never needed to be callable from other websites.

import { checkAuth, authHeaders, denied } from "./_auth.mjs";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": new URL(req.url).origin,
        "Access-Control-Allow-Headers": "Content-Type, x-opp-key, x-opp-who",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);

  if (req.method !== "POST") {
    return json({ error: { message: "Use POST. This endpoint is alive." } }, 405, ah);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({
      error: {
        message:
          "ANTHROPIC_API_KEY is not set on this Netlify site. Add it under Site settings > Environment variables, then redeploy.",
      },
    }, 500, ah);
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: { message: "Request body was not valid JSON." } }, 400, ah);
  }

  // A stray max_tokens of 200000 from a bad client shouldn't be able to run up
  // the bill. The app never asks for more than a couple thousand.
  if (payload && typeof payload === "object") {
    const asked = Number(payload.max_tokens);
    payload.max_tokens = Number.isFinite(asked) ? Math.min(asked, 4096) : 1024;
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();

    // Pass the upstream status through so the app can show the real problem
    // (401 = bad key, 404 = bad model name, 429 = rate limit, 400 = bad request).
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...ah },
    });
  } catch (e) {
    return json({
      error: { message: "Netlify function could not reach the Anthropic API: " + (e.message || String(e)) },
    }, 502, ah);
  }
};
