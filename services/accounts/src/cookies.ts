// Session-cookie helpers, shared by the accounts HTTP handler (which sets and
// clears the cookie) and the other services that only read it -- upload-url
// and the websocket $connect handler, via the same cross-service relative
// import used for the store.
//
// The session token lives in an HttpOnly cookie (never readable by page JS),
// shared across the control-ui, HTTP API, and WS API via a common
// registrable-domain cookie. SameSite=Lax is enough because all three are
// same-site subdomains of the one zone.
// Env-scoped cookie NAME. The cookie's Domain is .hanzomon.co so it can span
// each env's control-ui / api / ws subdomains -- but that same Domain means
// dev (dev.hanzomon.co) and prod (hanzomon.co) share one cookie jar for the
// registrable domain, so a shared name would make each env's login silently
// overwrite the other's (whichever wrote last wins; the other env then
// receives a token its SessionsTable doesn't know → 401 / anonymous WS). A
// per-env name lets both coexist. Falls back to the bare name locally, where
// there's only one env and no Domain is set.
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? "scenette_session";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches the session TTL
// Derived from the (already per-env) session cookie name rather than its own
// env var -- no CDK change needed, and it inherits the same dev/prod
// jar-collision avoidance the session cookie already has.
const DISCORD_STATE_COOKIE = `${SESSION_COOKIE}_discord_state`;
const DISCORD_STATE_COOKIE_MAX_AGE = 5 * 60; // just long enough for the round trip through Discord's consent screen
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

// The Discord OAuth "state" round-trips through Discord's own consent
// screen, so it has to survive as a cookie (not server-side state) between
// GET /auth/discord/login and GET /auth/discord/callback -- same mechanism
// as the session cookie, just much shorter-lived and cleared immediately
// after the callback reads it.
export function setDiscordStateCookie(state: string): string {
  return `${DISCORD_STATE_COOKIE}=${state}; ${cookieAttrs()}; Max-Age=${DISCORD_STATE_COOKIE_MAX_AGE}`;
}

export function clearDiscordStateCookie(): string {
  return `${DISCORD_STATE_COOKIE}=; ${cookieAttrs()}; Max-Age=0`;
}

// Reads a named cookie from either delivery mechanism:
//  - HTTP API (payload format 2.0) parses request cookies into a top-level
//    `cookies` array and does NOT populate the Cookie header.
//  - WebSocket $connect delivers them in the Cookie header instead.
// Checking both keeps one helper correct for every caller.
function readCookie(
  source: { cookies?: string[]; headers?: Record<string, string | undefined> },
  name: string
): string | undefined {
  for (const c of source.cookies ?? []) {
    const eq = c.indexOf("=");
    if (eq !== -1 && c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  const cookieHeader = source.headers?.cookie ?? source.headers?.Cookie;
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function readSessionToken(source: {
  cookies?: string[];
  headers?: Record<string, string | undefined>;
}): string | undefined {
  return readCookie(source, SESSION_COOKIE);
}

export function readDiscordStateCookie(source: {
  cookies?: string[];
  headers?: Record<string, string | undefined>;
}): string | undefined {
  return readCookie(source, DISCORD_STATE_COOKIE);
}
