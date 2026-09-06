import { checkAuth, authHeaders, denied } from "./_auth.mjs";

// Answers one question: what public address is this request coming from?
//
// The app can't see a wifi network's name, but every device on the shop's
// wifi reaches the internet through the same connection, so they all show up
// here with the same address. The owner registers that address from a tablet
// in the shop (Settings → Time clock), and the time clock only records a
// punch when the device asking matches. A phone on cellular data shows up
// with a different address and is told to clock in on a shop tablet.
//
// This is a fence, not a lock — it keeps honest people honest. It also breaks
// the day the internet provider hands the shop a new address, which is why
// the app fails OPEN when it can't tell (function missing, no connection) and
// only blocks when it positively sees a mismatch. Re-registering takes one tap.

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export default async (req, context) => {
  const auth = checkAuth(req);
  if (auth.enforced && !auth.role) return denied();
  const ah = authHeaders(auth);

  const fromHeader = (name) => {
    try { return req.headers.get(name) || ""; } catch (e) { return ""; }
  };
  const ip =
    (context && context.ip) ||
    fromHeader("x-nf-client-connection-ip") ||
    (fromHeader("x-forwarded-for").split(",")[0] || "").trim() ||
    "";

  if (!ip) return json({ error: "Couldn't read the connection address." }, 500, ah);
  return json({ ip, at: Date.now() }, 200, ah);
};
