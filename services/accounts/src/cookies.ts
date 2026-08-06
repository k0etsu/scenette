// Session-cookie helpers, shared by the accounts HTTP handler (which sets and
// clears the cookie) and the other services that only read it -- upload-url
// and the websocket $connect handler, via the same cross-service relative
// import used for the store.
//
// The session token lives in an HttpOnly cookie (never readable by page JS),
// shared across the control-ui, HTTP API, and WS API via a common
// registrable-domain cookie. SameSite=Lax is enough because all three are
// same-site subdomains of the one zone.
const SESSION_COOKIE = "scenette_session";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches the session TTL
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN; // e.g. ".hanzomon.co"; unset locally

function cookieAttrs(): string {
  const attrs = ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  return attrs.join("; ");
}

export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs()}; Max-Age=${SESSION_COOKIE_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs()}; Max-Age=0`;
}

// Reads the session token from either delivery mechanism:
//  - HTTP API (payload format 2.0) parses request cookies into a top-level
//    `cookies` array and does NOT populate the Cookie header.
//  - WebSocket $connect delivers them in the Cookie header instead.
// Checking both keeps one helper correct for every caller.
export function readSessionToken(source: {
  cookies?: string[];
  headers?: Record<string, string | undefined>;
}): string | undefined {
  for (const c of source.cookies ?? []) {
    const eq = c.indexOf("=");
    if (eq !== -1 && c.slice(0, eq).trim() === SESSION_COOKIE) return c.slice(eq + 1).trim();
  }
  const cookieHeader = source.headers?.cookie ?? source.headers?.Cookie;
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
