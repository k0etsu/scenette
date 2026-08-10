import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

// SKIP_EMAIL_VERIFICATION is read once at module load (see src/index.ts), so
// this suite sets the env var and re-imports the module fresh -- it can't
// share a module instance with test/index.test.ts, which relies on the flag
// being off.
vi.mock("../src/store", () => ({
  getAccount: vi.fn(),
  getEmailOwner: vi.fn(),
  createAccount: vi.fn(),
  createSession: vi.fn(),
  getSessionUsername: vi.fn(),
  touchSession: vi.fn(),
  deleteSession: vi.fn(),
  putMembership: vi.fn(),
  listMemberships: vi.fn(),
  getMembership: vi.fn(),
  listMembers: vi.fn(),
  deleteMembership: vi.fn(),
  getRoomOwner: vi.fn(),
  getOrCreateObsKey: vi.fn(),
  regenerateObsKey: vi.fn(),
  getRoomIdByObsKey: vi.fn(),
  getAnnouncement: vi.fn(),
  updateAccountPassword: vi.fn(),
  deleteAllSessionsForUser: vi.fn(),
  updateAccountEmail: vi.fn(),
  createVerification: vi.fn(),
  getVerification: vi.fn(),
  deleteVerification: vi.fn(),
  markEmailVerified: vi.fn(),
  createInvite: vi.fn(),
  getInvite: vi.fn(),
  redeemInvite: vi.fn(),
  deleteInvite: vi.fn(),
  listPendingInvites: vi.fn(),
}));
vi.mock("../src/cascade", () => ({
  deleteAccountCascade: vi.fn(),
}));
vi.mock("../src/email", () => ({
  sendVerificationEmail: vi.fn(),
}));

function event(routeKey: string, opts: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    routeKey,
    headers: {},
    requestContext: { domainName: "api.test.example.com" },
    ...opts,
  } as APIGatewayProxyEventV2;
}

function authedEvent(
  routeKey: string,
  username: string,
  store: typeof import("../src/store"),
  opts: Partial<APIGatewayProxyEventV2> = {}
): APIGatewayProxyEventV2 {
  vi.mocked(store.getSessionUsername).mockResolvedValue(username);
  return event(routeKey, { cookies: ["scenette_session=faketoken"], ...opts });
}

function jsonBody(res: any): any {
  return JSON.parse(res.body);
}

describe("SKIP_EMAIL_VERIFICATION=true", () => {
  const originalEnv = process.env.SKIP_EMAIL_VERIFICATION;

  beforeEach(async () => {
    process.env.SKIP_EMAIL_VERIFICATION = "true";
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.SKIP_EMAIL_VERIFICATION = originalEnv;
  });

  it("register grants the room immediately instead of mailing a verification link", async () => {
    const { handler } = await import("../src/index");
    const store = await import("../src/store");
    const email = await import("../src/email");

    vi.mocked(store.createAccount).mockResolvedValue(true);
    vi.mocked(store.createSession).mockResolvedValue("session-token");
    vi.mocked(store.markEmailVerified).mockResolvedValue("room-123");

    const res: any = await handler(
      event("POST /auth/register", {
        body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "password123" }),
      }),
      {} as any,
      undefined as any
    );

    expect(store.markEmailVerified).toHaveBeenCalledWith("alice", expect.any(String));
    expect(store.putMembership).toHaveBeenCalledWith({ accountId: "alice", roomId: "room-123", role: "owner" });
    expect(store.createVerification).not.toHaveBeenCalled();
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(201);
    const body = jsonBody(res);
    expect(body.emailVerified).toBe(true);
    expect(body.personalRoomId).toBe("room-123");
  });

  it("change-email grants the room immediately", async () => {
    const { handler } = await import("../src/index");
    const store = await import("../src/store");
    const email = await import("../src/email");

    vi.mocked(store.getEmailOwner).mockResolvedValue(undefined);
    vi.mocked(store.markEmailVerified).mockResolvedValue("room-456");

    const res: any = await handler(
      authedEvent("POST /auth/change-email", "bob", store, {
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
      {} as any,
      undefined as any
    );

    expect(store.markEmailVerified).toHaveBeenCalledWith("bob", expect.any(String));
    expect(store.putMembership).toHaveBeenCalledWith({ accountId: "bob", roomId: "room-456", role: "owner" });
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("resend-verification grants the room immediately instead of resending", async () => {
    const { handler } = await import("../src/index");
    const store = await import("../src/store");
    const email = await import("../src/email");

    vi.mocked(store.getAccount).mockResolvedValue({
      username: "carol",
      email: "carol@example.com",
      emailVerified: false,
      passwordHash: "h",
      passwordSalt: "s",
      createdAt: new Date().toISOString(),
    } as any);
    vi.mocked(store.markEmailVerified).mockResolvedValue("room-789");

    const res: any = await handler(
      authedEvent("POST /auth/resend-verification", "carol", store),
      {} as any,
      undefined as any
    );

    expect(store.markEmailVerified).toHaveBeenCalledWith("carol", expect.any(String));
    expect(store.putMembership).toHaveBeenCalledWith({ accountId: "carol", roomId: "room-789", role: "owner" });
    expect(store.createVerification).not.toHaveBeenCalled();
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});
