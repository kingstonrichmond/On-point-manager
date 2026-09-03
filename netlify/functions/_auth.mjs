// Shared gate for every function on this site.
//
// Two shared codes, not per-person accounts — shared tablets, floury hands and
// staff turnover all argue against usernames. The app hides tabs based on the
// role it gets back, but that is convenience only. THIS FILE is what actually
// enforces anything.
//
// Set both in Netlify: Site settings > Environment variables.
//   OPP_ADMIN_CODE   the owner code
//   OPP_STAFF_CODE   the code the crew's tablets use
//
// If neither is set the site stays open, exactly as it behaves today, and the
// app shows its "not enforced yet" banner. That's deliberate: a missing env var
// should never lock Chris out of his own shop mid-shift. Set them to turn the
// lock on.

function timingSafeEqual(a, b) {
  // Not a security boundary on its own — the codes are short and shared — but
  // there's no reason to leak length/prefix through response timing.
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

// Returns { enforced, role, who }.
//   enforced false -> no codes configured; let everything through (role "admin")
//   role ""        -> a code was required and the one supplied was wrong/missing
export function checkAuth(req) {
  const adminCode = process.env.OPP_ADMIN_CODE || "";
  const staffCode = process.env.OPP_STAFF_CODE || "";
  const enforced = !!(adminCode || staffCode);

  const get = (name) => {
    try {
      if (req && req.headers && typeof req.headers.get === "function") return req.headers.get(name) || "";
      if (req && req.headers) return req.headers[name] || req.headers[name.toLowerCase()] || "";
    } catch (e) {}
    return "";
  };

  const supplied = get("x-opp-key");
  const who = String(get("x-opp-who") || "").slice(0, 40);

  if (!enforced) return { enforced: false, role: "admin", who };
  if (adminCode && timingSafeEqual(supplied, adminCode)) return { enforced: true, role: "admin", who };
  if (staffCode && timingSafeEqual(supplied, staffCode)) return { enforced: true, role: "staff", who };
  return { enforced: true, role: "", who };
}

// The app watches for this header to learn which code it handed over. No header
// at all means an old function is still deployed and nothing is enforced.
export function authHeaders(auth) {
  return auth && auth.enforced ? { "x-opp-role": auth.role } : {};
}

export function denied() {
  return new Response(JSON.stringify({ error: "Not authorized." }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// Same three helpers for the older callback-style functions (chat.js).
export function deniedLambda(headers) {
  return {
    statusCode: 401,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify({ error: { message: "Not authorized." } })
  };
}
