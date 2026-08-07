import { describe, it, expect, vi, afterEach } from "vitest";
import { readSessionToken, setSessionCookie, clearSessionCookie } from "../src/cookies";

describe("readSessionToken", () => {
  it("reads from the HTTP API `cookies` array (payload format 2.0)", () => {
    // Regression: API Gateway HTTP API delivers cookies here, NOT in a header,
    // so reading only the header silently 401'd every authenticated request.
    expect(readSessionToken({ cookies: ["scenette_session=abc123"] })).toBe("abc123");
    expect(readSessionToken({ cookies: ["other=x", "scenette_session=abc123", "z=y"] })).toBe("abc123");
  });

  it("reads from the Cookie header (WebSocket $connect)", () => {
    expect(readSessionToken({ headers: { cookie: "scenette_session=abc123" } })).toBe("abc123");
    expect(readSessionToken({ headers: { Cookie: "a=b; scenette_session=abc123; c=d" } })).toBe("abc123");
  });

  it("returns undefined when the session cookie is absent from both", () => {
    expect(readSessionToken({})).toBeUndefined();
    expect(readSessionToken({ cookies: ["other=x"], headers: { cookie: "z=y" } })).toBeUndefined();
  });
});

describe("setSessionCookie / clearSessionCookie", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax cookie", () => {
    const c = setSessionCookie("tok");
    expect(c).toContain("scenette_session=tok");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

describe("env-scoped cookie name (dev/prod collision fix)", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.SESSION_COOKIE_NAME;
  });

  it("uses SESSION_COOKIE_NAME when set, so dev and prod cookies don't collide", async () => {
    vi.resetModules();
    process.env.SESSION_COOKIE_NAME = "scenette_session_dev";
    const cookies = await import("../src/cookies");

    expect(cookies.setSessionCookie("tok")).toContain("scenette_session_dev=tok");
    // Reads its own env's name...
    expect(cookies.readSessionToken({ cookies: ["scenette_session_dev=mine"] })).toBe("mine");
    // ...and ignores the other env's cookie sharing the same .hanzomon.co jar.
    expect(cookies.readSessionToken({ cookies: ["scenette_session_prod=theirs"] })).toBeUndefined();
  });
});
