// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

import { checkSession, listRooms, onSessionExpired } from "../src/auth";

function mockFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level handler between tests so a stale one doesn't fire.
  onSessionExpired(() => {});
});

describe("session-expired kick-to-login", () => {
  it("checkSession fires the handler on a 401 (lapsed session mid-use)", async () => {
    const onExpired = vi.fn();
    onSessionExpired(onExpired);
    mockFetch(401, { error: "Invalid or missing session" });

    const result = await checkSession("https://api.example.com");

    expect(result).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("checkSession does NOT fire the handler on a valid session", async () => {
    const onExpired = vi.fn();
    onSessionExpired(onExpired);
    mockFetch(200, { username: "alice", emailVerified: true });

    const result = await checkSession("https://api.example.com");

    expect(result).toMatchObject({ username: "alice" });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("checkSession does NOT fire the handler on a transient 5xx (not a logout)", async () => {
    const onExpired = vi.fn();
    onSessionExpired(onExpired);
    mockFetch(503);

    const result = await checkSession("https://api.example.com");

    expect(result).toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("an authed action (listRooms) fires the handler on a 401 before throwing", async () => {
    const onExpired = vi.fn();
    onSessionExpired(onExpired);
    mockFetch(401, { error: "Invalid or missing session" });

    await expect(listRooms("https://api.example.com")).rejects.toThrow();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
