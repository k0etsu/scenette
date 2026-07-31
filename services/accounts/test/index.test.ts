import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

vi.mock("../src/store", () => ({
  getAccount: vi.fn(),
  createAccount: vi.fn(),
  createSession: vi.fn(),
  getSessionUsername: vi.fn(),
  deleteSession: vi.fn(),
  putMembership: vi.fn(),
  listMemberships: vi.fn(),
  getMembership: vi.fn(),
  listMembers: vi.fn(),
  deleteMembership: vi.fn(),
  createVerification: vi.fn(),
  getVerificationUsername: vi.fn(),
  deleteVerification: vi.fn(),
  markEmailVerified: vi.fn(),
  createInvite: vi.fn(),
  getInvite: vi.fn(),
  redeemInvite: vi.fn(),
  deleteInvite: vi.fn(),
  listPendingInvites: vi.fn(),
}));
vi.mock("../src/email", () => ({
  sendVerificationEmail: vi.fn(),
}));

import { handler } from "../src/index";
import * as store from "../src/store";
import * as email from "../src/email";

function event(routeKey: string, opts: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    routeKey,
    headers: {},
    ...opts,
  } as APIGatewayProxyEventV2;
}

function authedEvent(
  routeKey: string,
  username: string,
  opts: Partial<APIGatewayProxyEventV2> = {}
): APIGatewayProxyEventV2 {
  vi.mocked(store.getSessionUsername).mockResolvedValue(username);
  return event(routeKey, { headers: { authorization: "Bearer faketoken" }, ...opts });
}

function jsonBody(res: Awaited<ReturnType<typeof handler>>): any {
  return JSON.parse((res as { body: string }).body);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /auth/register", () => {
  const validBody = JSON.stringify({ username: "alice", email: "alice@example.com", password: "password123" });

  it("rejects a too-short username", async () => {
    const res: any = await handler(
      event("POST /auth/register", { body: JSON.stringify({ username: "ab", email: "a@b.com", password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/username/);
  });

  it("rejects a too-short password", async () => {
    const res: any = await handler(
      event("POST /auth/register", { body: JSON.stringify({ username: "alice", email: "a@b.com", password: "short" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/password/);
  });

  it("rejects an invalid email", async () => {
    const res: any = await handler(
      event("POST /auth/register", { body: JSON.stringify({ username: "alice", email: "not-an-email", password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/email/);
  });

  it("creates an unverified account, sends a verification email, and returns no sessionToken", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(true);
    vi.mocked(store.createVerification).mockResolvedValue("tok123");

    const res: any = await handler(event("POST /auth/register", { body: validBody }), {} as any, undefined as any);

    expect(store.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", email: "alice@example.com", emailVerified: false })
    );
    expect(store.putMembership).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "alice", role: "owner" })
    );
    expect(email.sendVerificationEmail).toHaveBeenCalledWith("alice@example.com", "alice", "tok123");
    expect(res.statusCode).toBe(201);
    const body = jsonBody(res);
    expect(body.sessionToken).toBeUndefined();
    expect(body.username).toBe("alice");
  });

  it("returns 409 when the username is already taken", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(false);
    const res: any = await handler(event("POST /auth/register", { body: validBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(409);
  });

  it("still returns 201 even if sending the verification email fails", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(true);
    vi.mocked(store.createVerification).mockResolvedValue("tok123");
    vi.mocked(email.sendVerificationEmail).mockRejectedValue(new Error("SES down"));

    const res: any = await handler(event("POST /auth/register", { body: validBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /auth/login", () => {
  const loginBody = JSON.stringify({ username: "alice", password: "password123" });

  it("rejects an unknown username", async () => {
    vi.mocked(store.getAccount).mockResolvedValue(undefined);
    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
  });

  it("blocks login when emailVerified is explicitly false", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      email: "alice@example.com",
      emailVerified: false,
      personalRoomId: "room1",
      createdAt: "t",
    });

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(403);
    expect(jsonBody(res).unverified).toBe(true);
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it("allows login for a verified account", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      email: "alice@example.com",
      emailVerified: true,
      personalRoomId: "room1",
      createdAt: "t",
    });
    vi.mocked(store.createSession).mockResolvedValue("session-token");

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).sessionToken).toBe("session-token");
  });

  it("grandfathers in a legacy account with no emailVerified attribute at all", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      // emailVerified deliberately omitted -- simulates a pre-existing
      // DynamoDB row from before this field existed.
      personalRoomId: "room1",
      createdAt: "t",
    } as any);
    vi.mocked(store.createSession).mockResolvedValue("session-token");

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(200);
  });

  it("rejects an incorrect password", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("the-real-password");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      email: "alice@example.com",
      emailVerified: true,
      personalRoomId: "room1",
      createdAt: "t",
    });

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /auth/verify", () => {
  it("returns 400 html when the token query param is missing", async () => {
    const res: any = await handler(
      event("GET /auth/verify", { queryStringParameters: undefined }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers["Content-Type"]).toMatch(/text\/html/);
  });

  it("returns 400 html for an unknown/expired token", async () => {
    vi.mocked(store.getVerificationUsername).mockResolvedValue(undefined);
    const res: any = await handler(
      event("GET /auth/verify", { queryStringParameters: { token: "bogus" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
  });

  it("marks the account verified, deletes the token, and returns 200 html on success", async () => {
    vi.mocked(store.getVerificationUsername).mockResolvedValue("alice");
    const res: any = await handler(
      event("GET /auth/verify", { queryStringParameters: { token: "tok123" } }),
      {} as any,
      undefined as any
    );
    expect(store.markEmailVerified).toHaveBeenCalledWith("alice");
    expect(store.deleteVerification).toHaveBeenCalledWith("tok123");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/text\/html/);
  });
});

describe("POST /auth/resend-verification", () => {
  it("returns the same generic response for an unknown username (no enumeration)", async () => {
    vi.mocked(store.getAccount).mockResolvedValue(undefined);
    const res: any = await handler(
      event("POST /auth/resend-verification", { body: JSON.stringify({ username: "ghost" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("does not resend for an already-verified account", async () => {
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      email: "alice@example.com",
      emailVerified: true,
      personalRoomId: "room1",
      createdAt: "t",
    });
    const res: any = await handler(
      event("POST /auth/resend-verification", { body: JSON.stringify({ username: "alice" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("sends a new verification email for an unverified account", async () => {
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      email: "alice@example.com",
      emailVerified: false,
      personalRoomId: "room1",
      createdAt: "t",
    });
    vi.mocked(store.createVerification).mockResolvedValue("newtoken");

    const res: any = await handler(
      event("POST /auth/resend-verification", { body: JSON.stringify({ username: "alice" }) }),
      {} as any,
      undefined as any
    );
    expect(email.sendVerificationEmail).toHaveBeenCalledWith("alice@example.com", "alice", "newtoken");
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /auth/rooms/{roomId}/members", () => {
  it("requires a session", async () => {
    const res: any = await handler(
      event("GET /auth/rooms/{roomId}/members", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("requires the requester to be the room owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "bob", roomId: "room1", role: "mod" });
    const res: any = await handler(
      authedEvent("GET /auth/rooms/{roomId}/members", "bob", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns the member list for the owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "alice", roomId: "room1", role: "owner" });
    vi.mocked(store.listMembers).mockResolvedValue([
      { accountId: "alice", roomId: "room1", role: "owner" },
      { accountId: "bob", roomId: "room1", role: "mod" },
    ]);
    const res: any = await handler(
      authedEvent("GET /auth/rooms/{roomId}/members", "alice", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).members).toHaveLength(2);
  });
});

describe("DELETE /auth/rooms/{roomId}/members/{username}", () => {
  it("requires the requester to be the room owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "bob", roomId: "room1", role: "mod" });
    const res: any = await handler(
      authedEvent("DELETE /auth/rooms/{roomId}/members/{username}", "bob", {
        pathParameters: { roomId: "room1", username: "carol" },
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses to revoke the room owner's own membership row", async () => {
    vi.mocked(store.getMembership).mockImplementation(async (accountId) =>
      accountId === "alice" ? { accountId: "alice", roomId: "room1", role: "owner" } : undefined
    );
    const res: any = await handler(
      authedEvent("DELETE /auth/rooms/{roomId}/members/{username}", "alice", {
        pathParameters: { roomId: "room1", username: "alice" },
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(store.deleteMembership).not.toHaveBeenCalled();
  });

  it("revokes a mod's access for the owner", async () => {
    vi.mocked(store.getMembership).mockImplementation(async (accountId) =>
      accountId === "alice"
        ? { accountId: "alice", roomId: "room1", role: "owner" }
        : { accountId: "bob", roomId: "room1", role: "mod" }
    );
    const res: any = await handler(
      authedEvent("DELETE /auth/rooms/{roomId}/members/{username}", "alice", {
        pathParameters: { roomId: "room1", username: "bob" },
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.deleteMembership).toHaveBeenCalledWith("bob", "room1");
  });
});

describe("POST /auth/rooms/{roomId}/invites", () => {
  it("requires the requester to be the room owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "bob", roomId: "room1", role: "mod" });
    const res: any = await handler(
      authedEvent("POST /auth/rooms/{roomId}/invites", "bob", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(403);
  });

  it("creates an invite for the owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "alice", roomId: "room1", role: "owner" });
    vi.mocked(store.createInvite).mockResolvedValue({
      inviteToken: "tok1",
      roomId: "room1",
      createdBy: "alice",
      createdAt: "t",
    });
    const res: any = await handler(
      authedEvent("POST /auth/rooms/{roomId}/invites", "alice", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(201);
    // Regression: the response previously omitted createdAt, which made the
    // client render `new Date(undefined)` as "Invalid Date" in the modal.
    expect(jsonBody(res)).toEqual({ inviteToken: "tok1", createdAt: "t" });
  });
});

describe("GET /auth/rooms/{roomId}/invites", () => {
  it("returns only pending invites for the owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "alice", roomId: "room1", role: "owner" });
    vi.mocked(store.listPendingInvites).mockResolvedValue([
      { inviteToken: "tok1", roomId: "room1", createdBy: "alice", createdAt: "t" },
    ]);
    const res: any = await handler(
      authedEvent("GET /auth/rooms/{roomId}/invites", "alice", { pathParameters: { roomId: "room1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).invites).toEqual([{ inviteToken: "tok1", createdAt: "t" }]);
  });
});

describe("DELETE /auth/rooms/{roomId}/invites/{inviteToken}", () => {
  it("requires the requester to be the room owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "bob", roomId: "room1", role: "mod" });
    const res: any = await handler(
      authedEvent("DELETE /auth/rooms/{roomId}/invites/{inviteToken}", "bob", {
        pathParameters: { roomId: "room1", inviteToken: "tok1" },
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(403);
  });

  it("revokes the invite for the owner", async () => {
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "alice", roomId: "room1", role: "owner" });
    const res: any = await handler(
      authedEvent("DELETE /auth/rooms/{roomId}/invites/{inviteToken}", "alice", {
        pathParameters: { roomId: "room1", inviteToken: "tok1" },
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.deleteInvite).toHaveBeenCalledWith("tok1");
  });
});

describe("POST /auth/invites/{inviteToken}/redeem", () => {
  it("requires a session", async () => {
    const res: any = await handler(
      event("POST /auth/invites/{inviteToken}/redeem", { pathParameters: { inviteToken: "tok1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown invite token", async () => {
    vi.mocked(store.getInvite).mockResolvedValue(undefined);
    const res: any = await handler(
      authedEvent("POST /auth/invites/{inviteToken}/redeem", "bob", { pathParameters: { inviteToken: "bogus" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the invite was already redeemed", async () => {
    vi.mocked(store.getInvite).mockResolvedValue({
      inviteToken: "tok1",
      roomId: "room1",
      createdBy: "alice",
      createdAt: "t",
    });
    vi.mocked(store.redeemInvite).mockResolvedValue(false);
    const res: any = await handler(
      authedEvent("POST /auth/invites/{inviteToken}/redeem", "bob", { pathParameters: { inviteToken: "tok1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(409);
    expect(store.putMembership).not.toHaveBeenCalled();
  });

  it("attaches the redeemer as a mod and returns the roomId", async () => {
    vi.mocked(store.getInvite).mockResolvedValue({
      inviteToken: "tok1",
      roomId: "room1",
      createdBy: "alice",
      createdAt: "t",
    });
    vi.mocked(store.redeemInvite).mockResolvedValue(true);
    vi.mocked(store.getMembership).mockResolvedValue(undefined);
    const res: any = await handler(
      authedEvent("POST /auth/invites/{inviteToken}/redeem", "bob", { pathParameters: { inviteToken: "tok1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).roomId).toBe("room1");
    expect(store.putMembership).toHaveBeenCalledWith({ accountId: "bob", roomId: "room1", role: "mod" });
  });

  it("does not downgrade the room owner if they redeem their own invite", async () => {
    vi.mocked(store.getInvite).mockResolvedValue({
      inviteToken: "tok1",
      roomId: "room1",
      createdBy: "alice",
      createdAt: "t",
    });
    vi.mocked(store.redeemInvite).mockResolvedValue(true);
    vi.mocked(store.getMembership).mockResolvedValue({ accountId: "alice", roomId: "room1", role: "owner" });
    const res: any = await handler(
      authedEvent("POST /auth/invites/{inviteToken}/redeem", "alice", { pathParameters: { inviteToken: "tok1" } }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.putMembership).not.toHaveBeenCalled();
  });
});
