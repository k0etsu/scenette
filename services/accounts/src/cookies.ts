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

export function readSessionToken(headers: Record<string, string | undefined>): string | undefined {
  const cookieHeader = headers.cookie ?? headers.Cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
