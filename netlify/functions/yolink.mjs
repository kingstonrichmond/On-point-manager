import { getStore } from "@netlify/blobs";
import { checkAuth, authHeaders, denied } from "./_auth.mjs";

// Walk-in / freezer temperatures from YoLink.
//
// Credentials live in Netlify environment variables, never in the repo and
// never in the browser:
//   YOLINK_UAID    - User Access Id   (YoLink app -> Account -> Advanced
//   YOLINK_SECRET  - Secret Key        Settings -> User Access Credentials)
//
// YoLink rate-limits the UAC API (roughly 100 calls per 5 minutes, and 6 per
// device per minute), and every tablet in the shop hits this endpoint. So the
// results are cached in Blobs and shared: ten tablets polling still costs one
// upstream refresh. The sensors themselves only report every so often anyway,
// so a short cache loses nothing real.
//
// Auth also protects that rate limit: without a code, anyone hitting this URL
// with ?force=1 in a loop could burn the shop's YoLink quota and blank out the
// temperature readings during service.

const HOST = "https://api.yosmart.com";
const TOKEN_KEY = "yolink-token";
const CACHE_KEY = "yolink-cache";
const CACHE_SECONDS = 120;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

const cToF = (c) => (typeof c === "number" ? Math.round((c * 9) / 5 + 32) : null);

async function getToken(store) {
  const uaid = process.env.YOLINK_UAID;
  const secret = process.env.YOLINK_SECRET;
  if (!uaid || !secret) {
    const e = new Error(
      "YoLink isn't set up yet — add YOLINK_UAID and YOLINK_SECRET in Netlify under Site configuration → Environment variables."
    );
    e.setup = true;
    throw e;
  }

  const cached = await store.get(TOKEN_KEY, { type: "json" }).catch(() => null);
  if (cached && cached.token && cached.expires > Date.now() + 60000) return cached.token;

  const res = await fetch(HOST + "/open/yolink/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: uaid,
      client_secret: secret,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      "YoLink rejected the credentials (" +
        res.status +
        (body.message ? ": " + body.message : "") +
        "). Check YOLINK_UAID and YOLINK_SECRET."
    );
  }
  const expires = Date.now() + (Number(body.expires_in) || 7200) * 1000;
  await store.setJSON(TOKEN_KEY, { token: body.access_token, expires }).catch(() => {});
  return body.access_token;
}

async function call(token, payload) {
  const res = await fetch(HOST + "/open/yolink/v2/api", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ ...payload, time: Date.now() }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.code && body.code !== "000000") {
    throw new Error("YoLink API said " + body.code + (body.desc ? " (" + body.desc + ")" : ""));
  }
  if (!res.ok) throw new Error("YoLink HTTP " + res.status);
  return body.data || {};
}

// Anything that reports a temperature is fair game — the THSensor is the usual
// one, but leak sensors and hubs report temperature too.
const TEMP_TYPES = ["THSensor", "LeakSensor", "Thermostat"];

export default async (req) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);

  let store;
  try {
    store = getStore({ name: "onpoint-yolink", consistency: "strong" });
  } catch (e) {
    return json({ error: "Storage unavailable: " + e.message }, 500, ah);
  }

  const url = new URL(req.url);
  // Only an owner should be able to skip the shared cache and force an upstream
  // refresh — that's the call that eats the YoLink rate limit.
  const force = url.searchParams.get("force") === "1" && auth.role === "admin";

  const cached = await store.get(CACHE_KEY, { type: "json" }).catch(() => null);
  const fresh = cached && Date.now() - cached.at < CACHE_SECONDS * 1000;
  if (cached && fresh && !force) {
    return json({ sensors: cached.sensors, at: cached.at, cached: true }, 200, ah);
  }

  try {
    const token = await getToken(store);
    const list = await call(token, { method: "Home.getDeviceList" });
    const devices = (list.devices || []).filter((d) => TEMP_TYPES.indexOf(d.type) !== -1);

    const sensors = [];
    for (const d of devices) {
      try {
        const state = await call(token, {
          method: d.type + ".getState",
          targetDevice: d.deviceId,
          token: d.token,
        });
        const s = state.state || {};
        const t = typeof s.temperature === "number" ? s.temperature : null;
        sensors.push({
          id: d.deviceId,
          name: d.name || d.modelName || "Sensor",
          type: d.type,
          tempF: cToF(t),
          tempC: t,
          humidity: typeof s.humidity === "number" ? Math.round(s.humidity) : null,
          battery: typeof s.battery === "number" ? s.battery : null,
          online: s.online !== false,
          reportedAt: state.reportAt || state.time || null,
        });
      } catch (e) {
        sensors.push({
          id: d.deviceId,
          name: d.name || "Sensor",
          type: d.type,
          tempF: null,
          error: e.message,
        });
      }
    }

    const at = Date.now();
    await store.setJSON(CACHE_KEY, { at, sensors }).catch(() => {});
    return json({ sensors, at, cached: false }, 200, ah);
  } catch (e) {
    // Serve whatever we had rather than showing nothing during an outage.
    if (cached) {
      return json({
        sensors: cached.sensors,
        at: cached.at,
        cached: true,
        stale: true,
        error: e.message,
      }, 200, ah);
    }
    return json({ error: e.message, setup: !!e.setup }, e.setup ? 200 : 502, ah);
  }
};
