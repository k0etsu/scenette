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
  getRoomOwner: vi.fn(),
  updateAccountPassword: vi.fn(),
  updateAccountEmail: vi.fn(),
  createInvite: vi.fn(),
  getInvite: vi.fn(),
  redeemInvite: vi.fn(),
  deleteInvite: vi.fn(),
  listPendingInvites: vi.fn(),
}));
vi.mock("../src/cascade", () => ({
  deleteAccountCascade: vi.fn(),
}));

import { handler } from "../src/index";
import * as store from "../src/store";
import * as cascade from "../src/cascade";

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

  it("rejects an invalid email when one is provided", async () => {
    const res: any = await handler(
      event("POST /auth/register", { body: JSON.stringify({ username: "alice", email: "not-an-email", password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/email/);
  });

  it("allows registering with no email at all -- it's optional", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(true);
    vi.mocked(store.createSession).mockResolvedValue("session-token");

    const res: any = await handler(
      event("POST /auth/register", { body: JSON.stringify({ username: "alice", password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(201);
    expect(store.createAccount).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", email: undefined }));
  });

  it("creates the account, its personal room membership, and logs straight in -- no verification step", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(true);
    vi.mocked(store.createSession).mockResolvedValue("session-token");

    const res: any = await handler(event("POST /auth/register", { body: validBody }), {} as any, undefined as any);

    expect(store.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", email: "alice@example.com" })
    );
    expect(store.putMembership).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "alice", role: "owner" })
    );
    expect(res.statusCode).toBe(201);
    const body = jsonBody(res);
    expect(body.sessionToken).toBe("session-token");
    expect(body.username).toBe("alice");
  });

  it("returns 409 when the username is already taken", async () => {
    vi.mocked(store.createAccount).mockResolvedValue(false);
    const res: any = await handler(event("POST /auth/register", { body: validBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /auth/login", () => {
  const loginBody = JSON.stringify({ username: "alice", password: "password123" });

  it("rejects an unknown username", async () => {
    vi.mocked(store.getAccount).mockResolvedValue(undefined);
    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
  });

  it("logs in successfully with no email-verification gate", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      email: "alice@example.com",
      personalRoomId: "room1",
      createdAt: "t",
    });
    vi.mocked(store.createSession).mockResolvedValue("session-token");

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res).sessionToken).toBe("session-token");
  });

  it("logs in an account with no email at all", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      personalRoomId: "room1",
      createdAt: "t",
    });
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
      personalRoomId: "room1",
      createdAt: "t",
    });

    const res: any = await handler(event("POST /auth/login", { body: loginBody }), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /auth/change-password", () => {
  it("requires a session", async () => {
    const res: any = await handler(
      event("POST /auth/change-password", { body: JSON.stringify({ currentPassword: "a", newPassword: "b" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects a too-short new password", async () => {
    const res: any = await handler(
      authedEvent("POST /auth/change-password", "alice", {
        body: JSON.stringify({ currentPassword: "password123", newPassword: "short" }),
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects an incorrect current password", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("the-real-password");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      personalRoomId: "room1",
      createdAt: "t",
    });
    const res: any = await handler(
      authedEvent("POST /auth/change-password", "alice", {
        body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "newpassword123" }),
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
    expect(store.updateAccountPassword).not.toHaveBeenCalled();
  });

  it("updates the password hash/salt on success", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      personalRoomId: "room1",
      createdAt: "t",
    });
    const res: any = await handler(
      authedEvent("POST /auth/change-password", "alice", {
        body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword123" }),
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.updateAccountPassword).toHaveBeenCalledWith("alice", expect.any(String), expect.any(String));
  });
});

describe("POST /auth/change-email", () => {
  it("requires a session", async () => {
    const res: any = await handler(
      event("POST /auth/change-email", { body: JSON.stringify({ email: "a@b.com" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid email", async () => {
    const res: any = await handler(
      authedEvent("POST /auth/change-email", "alice", { body: JSON.stringify({ email: "not-an-email" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(store.updateAccountEmail).not.toHaveBeenCalled();
  });

  it("updates the email on success", async () => {
    const res: any = await handler(
      authedEvent("POST /auth/change-email", "alice", { body: JSON.stringify({ email: "new@example.com" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.updateAccountEmail).toHaveBeenCalledWith("alice", "new@example.com");
  });

  it("clears the email when given an empty string", async () => {
    const res: any = await handler(
      authedEvent("POST /auth/change-email", "alice", { body: JSON.stringify({ email: "" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(store.updateAccountEmail).toHaveBeenCalledWith("alice", undefined);
  });
});

describe("DELETE /auth/account", () => {
  it("requires a session", async () => {
    const res: any = await handler(
      event("DELETE /auth/account", { body: JSON.stringify({ password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects an incorrect password without running the cascade", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("the-real-password");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      personalRoomId: "room1",
      createdAt: "t",
    });
    const res: any = await handler(
      authedEvent("DELETE /auth/account", "alice", { body: JSON.stringify({ password: "wrong" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
    expect(cascade.deleteAccountCascade).not.toHaveBeenCalled();
  });

  it("runs the cascade on a correct password", async () => {
    const { hashPassword } = await import("../src/passwords");
    const { hash, salt } = await hashPassword("password123");
    vi.mocked(store.getAccount).mockResolvedValue({
      username: "alice",
      passwordHash: hash,
      passwordSalt: salt,
      personalRoomId: "room1",
      createdAt: "t",
    });
    const res: any = await handler(
      authedEvent("DELETE /auth/account", "alice", { body: JSON.stringify({ password: "password123" }) }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
    expect(cascade.deleteAccountCascade).toHaveBeenCalledWith("alice");
  });
});

describe("GET /auth/rooms", () => {
  it("requires a session", async () => {
    const res: any = await handler(event("GET /auth/rooms"), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
  });

  it("labels the caller's own room with their own username, without a lookup", async () => {
    vi.mocked(store.listMemberships).mockResolvedValue([{ accountId: "alice", roomId: "room1", role: "owner" }]);

    const res: any = await handler(authedEvent("GET /auth/rooms", "alice"), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toEqual({ rooms: [{ roomId: "room1", role: "owner", ownerUsername: "alice" }] });
    // Regression: an owner row is self-evidently the caller's own room --
    // spending a getRoomOwner scan on it would be pure waste.
    expect(store.getRoomOwner).not.toHaveBeenCalled();
  });

  it("looks up the owner's username for a mod-access room", async () => {
    vi.mocked(store.listMemberships).mockResolvedValue([
      { accountId: "bob", roomId: "room1", role: "owner" },
      { accountId: "bob", roomId: "room2", role: "mod" },
    ]);
    vi.mocked(store.getRoomOwner).mockResolvedValue("alice");

    const res: any = await handler(authedEvent("GET /auth/rooms", "bob"), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toEqual({
      rooms: [
        { roomId: "room1", role: "owner", ownerUsername: "bob" },
        { roomId: "room2", role: "mod", ownerUsername: "alice" },
      ],
    });
    expect(store.getRoomOwner).toHaveBeenCalledWith("room2");
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
