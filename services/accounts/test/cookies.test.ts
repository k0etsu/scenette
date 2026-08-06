import { describe, it, expect } from "vitest";
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
