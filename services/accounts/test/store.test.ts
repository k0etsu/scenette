import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  getAccount,
  createAccount,
  createSession,
  getSessionUsername,
  deleteSession,
  createVerification,
  getVerificationUsername,
  deleteVerification,
  markEmailVerified,
  putMembership,
  getMembership,
  listMembers,
  deleteMembership,
  getRoomOwner,
  createInvite,
  getInvite,
  redeemInvite,
  deleteInvite,
  listPendingInvites,
} from "../src/store";

const ddbMock = mockClient(DynamoDBDocumentClient);

const conditionalCheckFailed = Object.assign(new Error("conditional check failed"), {
  name: "ConditionalCheckFailedException",
});

beforeEach(() => {
  ddbMock.reset();
});

describe("createAccount", () => {
  it("returns true on success", async () => {
    ddbMock.on(PutCommand).resolves({});
    const created = await createAccount({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      email: "alice@example.com",
      emailVerified: false,
      personalRoomId: "room1",
      createdAt: "t",
    });
    expect(created).toBe(true);
  });

  it("returns false (not throw) when the username is already taken", async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed);
    const created = await createAccount({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      email: "alice@example.com",
      emailVerified: false,
      personalRoomId: "room1",
      createdAt: "t",
    });
    expect(created).toBe(false);
  });

  it("rethrows any other error", async () => {
    ddbMock.on(PutCommand).rejects(new Error("network blip"));
    await expect(
      createAccount({
        username: "alice",
        passwordHash: "h",
        passwordSalt: "s",
        email: "alice@example.com",
        emailVerified: false,
        personalRoomId: "room1",
        createdAt: "t",
      })
    ).rejects.toThrow("network blip");
  });
});

describe("getAccount", () => {
  it("returns the account when found", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { username: "alice", email: "alice@example.com" } });
    const account = await getAccount("alice");
    expect(account?.username).toBe("alice");
  });

  it("returns undefined when not found", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getAccount("missing")).resolves.toBeUndefined();
  });
});

describe("sessions", () => {
  it("creates a session and can look up its username", async () => {
    ddbMock.on(PutCommand).resolves({});
    const token = await createSession("alice");
    expect(typeof token).toBe("string");

    ddbMock.on(GetCommand).resolves({ Item: { sessionToken: token, username: "alice" } });
    await expect(getSessionUsername(token)).resolves.toBe("alice");
  });

  it("deleteSession does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteSession("some-token")).resolves.toBeUndefined();
  });
});

describe("email verification tokens", () => {
  it("creates a verification token and can resolve it back to the username", async () => {
    ddbMock.on(PutCommand).resolves({});
    const token = await createVerification("alice");
    expect(typeof token).toBe("string");

    ddbMock.on(GetCommand).resolves({ Item: { token, username: "alice" } });
    await expect(getVerificationUsername(token)).resolves.toBe("alice");
  });

  it("returns undefined for an unknown/expired token", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getVerificationUsername("bogus")).resolves.toBeUndefined();
  });

  it("deleteVerification does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteVerification("some-token")).resolves.toBeUndefined();
  });

  it("markEmailVerified sends the expected update", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await markEmailVerified("alice");
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      Key: { username: "alice" },
      UpdateExpression: "SET emailVerified = :v",
      ExpressionAttributeValues: { ":v": true },
    });
  });
});

describe("memberships", () => {
  it("putMembership does not throw", async () => {
    ddbMock.on(PutCommand).resolves({});
    await expect(putMembership({ accountId: "alice", roomId: "room1", role: "owner" })).resolves.toBeUndefined();
  });

  it("getMembership returns undefined when not found", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getMembership("alice", "room1")).resolves.toBeUndefined();
  });

  it("listMembers queries the byRoom index", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { accountId: "alice", roomId: "room1", role: "owner" },
        { accountId: "bob", roomId: "room1", role: "mod" },
      ],
    });
    const members = await listMembers("room1");
    expect(members).toHaveLength(2);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("byRoom");
  });

  it("deleteMembership does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteMembership("bob", "room1")).resolves.toBeUndefined();
  });

  it("getRoomOwner returns the accountId of the owner-role row", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { accountId: "bob", roomId: "room1", role: "mod" },
        { accountId: "alice", roomId: "room1", role: "owner" },
      ],
    });
    await expect(getRoomOwner("room1")).resolves.toBe("alice");
  });

  it("getRoomOwner returns undefined if no membership row has role owner", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ accountId: "bob", roomId: "room1", role: "mod" }],
    });
    await expect(getRoomOwner("room1")).resolves.toBeUndefined();
  });
});

describe("invites", () => {
  it("createInvite generates a token and stores the invite", async () => {
    ddbMock.on(PutCommand).resolves({});
    const invite = await createInvite("room1", "alice");
    expect(invite.roomId).toBe("room1");
    expect(invite.createdBy).toBe("alice");
    expect(typeof invite.inviteToken).toBe("string");
  });

  it("getInvite returns undefined for an unknown token", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getInvite("bogus")).resolves.toBeUndefined();
  });

  it("redeemInvite returns true on first redemption", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(redeemInvite("tok1", "bob")).resolves.toBe(true);
  });

  it("redeemInvite returns false (not throw) when already redeemed", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed);
    await expect(redeemInvite("tok1", "bob")).resolves.toBe(false);
  });

  it("redeemInvite rethrows any other error", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("network blip"));
    await expect(redeemInvite("tok1", "bob")).rejects.toThrow("network blip");
  });

  it("deleteInvite does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteInvite("tok1")).resolves.toBeUndefined();
  });

  it("listPendingInvites queries the byRoom index with a not-yet-redeemed filter", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ inviteToken: "tok1", roomId: "room1", createdBy: "alice", createdAt: "t" }],
    });
    const invites = await listPendingInvites("room1");
    expect(invites).toHaveLength(1);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("byRoom");
    expect(call.args[0].input.FilterExpression).toContain("redeemedBy");
  });
});
