import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getAccount,
  getEmailOwner,
  createAccount,
  createSession,
  getSessionUsername,
  deleteSession,
  deleteAllSessionsForUser,
  updateAccountPassword,
  updateAccountEmail,
  deleteAccountRow,
  putMembership,
  getMembership,
  listMembers,
  deleteMembership,
  getRoomOwner,
  getOrCreateObsKey,
  regenerateObsKey,
  getRoomIdByObsKey,
  getAnnouncement,
  createInvite,
  getInvite,
  redeemInvite,
  deleteInvite,
  listPendingInvites,
  listAllInvitesForRoom,
  listRoomAssetsForCascade,
  deleteAssetRow,
  deleteRoomRow,
  deleteS3Object,
  createVerification,
  getVerification,
  deleteVerification,
  markEmailVerified,
} from "../src/store";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const conditionalCheckFailed = Object.assign(new Error("conditional check failed"), {
  name: "ConditionalCheckFailedException",
});

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
});

describe("createAccount", () => {
  it("returns true on success", async () => {
    ddbMock.on(PutCommand).resolves({});
    const created = await createAccount({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      email: "alice@example.com",
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
        personalRoomId: "room1",
        createdAt: "t",
      })
    ).rejects.toThrow("network blip");
  });

  it("allows creating an account with no email at all", async () => {
    ddbMock.on(PutCommand).resolves({});
    const created = await createAccount({
      username: "alice",
      passwordHash: "h",
      passwordSalt: "s",
      personalRoomId: "room1",
      createdAt: "t",
    });
    expect(created).toBe(true);
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

describe("getEmailOwner", () => {
  it("returns the username of the account that has the email VERIFIED", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { username: "bob", email: "x@y.com", emailVerified: false },
        { username: "alice", email: "x@y.com", emailVerified: true },
      ],
    });
    await expect(getEmailOwner("x@y.com")).resolves.toBe("alice");
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("byEmail");
  });

  it("returns undefined when the email exists but is unverified on all accounts", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ username: "bob", email: "x@y.com", emailVerified: false }] });
    await expect(getEmailOwner("x@y.com")).resolves.toBeUndefined();
  });

  it("returns undefined when no account has the email", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(getEmailOwner("nobody@y.com")).resolves.toBeUndefined();
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

  it("deleteAllSessionsForUser scans (filtered by username) and deletes every matching row", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { sessionToken: "tok1", username: "alice" },
        { sessionToken: "tok2", username: "alice" },
      ],
    });
    ddbMock.on(DeleteCommand).resolves({});

    await deleteAllSessionsForUser("alice");

    const scanCall = ddbMock.commandCalls(ScanCommand)[0];
    expect(scanCall.args[0].input.FilterExpression).toContain("username");
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls.map((c) => c.args[0].input.Key)).toEqual([{ sessionToken: "tok1" }, { sessionToken: "tok2" }]);
  });

  it("deleteAllSessionsForUser pages through a truncated scan", async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ sessionToken: "tok1", username: "alice" }], LastEvaluatedKey: { sessionToken: "tok1" } })
      .resolvesOnce({ Items: [{ sessionToken: "tok2", username: "alice" }] });
    ddbMock.on(DeleteCommand).resolves({});

    await deleteAllSessionsForUser("alice");

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(2);
  });
});

describe("account mutation helpers (change password/email, delete account)", () => {
  it("updateAccountPassword sends the expected update", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await updateAccountPassword("alice", "newhash", "newsalt");
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input).toMatchObject({
      Key: { username: "alice" },
      UpdateExpression: "SET passwordHash = :h, passwordSalt = :s",
      ExpressionAttributeValues: { ":h": "newhash", ":s": "newsalt" },
    });
  });

  it("updateAccountEmail sets the email and marks it unverified when given a non-empty value", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await updateAccountEmail("alice", "new@example.com");
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input).toMatchObject({
      UpdateExpression: "SET email = :e, emailVerified = :false",
      ExpressionAttributeValues: { ":e": "new@example.com", ":false": false },
    });
  });

  it("updateAccountEmail removes the attribute and clears verified status when given undefined", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await updateAccountEmail("alice", undefined);
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.UpdateExpression).toBe("REMOVE email SET emailVerified = :false");
  });

  it("createVerification writes a token row with an expiry and a ttl", async () => {
    ddbMock.on(PutCommand).resolves({});
    const v = await createVerification("alice", "a@b.com");
    expect(v.username).toBe("alice");
    expect(v.email).toBe("a@b.com");
    expect(typeof v.token).toBe("string");
    expect(Date.parse(v.expiresAt)).toBeGreaterThan(Date.now());
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
    expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("getVerification returns undefined for an unknown token", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getVerification("bogus")).resolves.toBeUndefined();
  });

  it("deleteVerification does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteVerification("tok")).resolves.toBeUndefined();
  });

  it("markEmailVerified assigns a new room on first verification", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const roomId = await markEmailVerified("alice", "new-room");
    expect(roomId).toBe("new-room");
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    // Guarded so a second click can't mint a second room.
    expect(call.args[0].input.ConditionExpression).toBe("attribute_not_exists(personalRoomId)");
  });

  it("markEmailVerified keeps the existing room (no second room) when already verified", async () => {
    // First update (the conditional room assignment) fails: a room exists.
    ddbMock.on(UpdateCommand).rejectsOnce(conditionalCheckFailed).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: { username: "alice", personalRoomId: "existing-room" } });
    const roomId = await markEmailVerified("alice", "ignored-new-room");
    expect(roomId).toBe("existing-room");
  });
});

describe("account row deletion", () => {
  it("deleteAccountRow does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteAccountRow("alice")).resolves.toBeUndefined();
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

describe("browser-source obsKey", () => {
  it("getOrCreateObsKey upserts with if_not_exists (stable across calls) and returns it", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { roomId: "room1", obsKey: "existing-key" } });
    const key = await getOrCreateObsKey("room1");
    expect(key).toBe("existing-key");
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call.args[0].input.UpdateExpression).toBe("SET obsKey = if_not_exists(obsKey, :new)");
    expect(call.args[0].input.ReturnValues).toBe("ALL_NEW");
  });

  it("regenerateObsKey overwrites unconditionally (revoking the old key) and returns the new one", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const key = await regenerateObsKey("room1");
    expect(typeof key).toBe("string");
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    // No if_not_exists -- a straight overwrite, so the prior key stops resolving.
    expect(call.args[0].input.UpdateExpression).toBe("SET obsKey = :new");
  });

  it("getRoomIdByObsKey resolves via the byObsKey GSI", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ roomId: "room1", obsKey: "k" }] });
    await expect(getRoomIdByObsKey("k")).resolves.toBe("room1");
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("byObsKey");
  });

  it("getRoomIdByObsKey returns undefined for an unknown key", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(getRoomIdByObsKey("nope")).resolves.toBeUndefined();
  });
});

describe("announcement", () => {
  it("returns the trimmed S3 object contents when present", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: () => Promise.resolve("  hello world  ") },
    } as any);
    await expect(getAnnouncement()).resolves.toBe("hello world");
  });

  it("returns null when the object is absent/unreadable", async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
    await expect(getAnnouncement()).resolves.toBeNull();
  });

  it("returns null for an empty/whitespace-only announcement", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: () => Promise.resolve("   \n  ") },
    } as any);
    await expect(getAnnouncement()).resolves.toBeNull();
  });
});

describe("invites", () => {
  it("createInvite generates a token, an expiry, and a ttl for the sweep", async () => {
    ddbMock.on(PutCommand).resolves({});
    const invite = await createInvite("room1", "alice");
    expect(invite.roomId).toBe("room1");
    expect(invite.createdBy).toBe("alice");
    expect(typeof invite.inviteToken).toBe("string");
    expect(Date.parse(invite.expiresAt!)).toBeGreaterThan(Date.now());
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
    expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
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

  it("listAllInvitesForRoom queries the byRoom index with no redeemed/pending filter", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { inviteToken: "tok1", roomId: "room1", createdBy: "alice", createdAt: "t" },
        { inviteToken: "tok2", roomId: "room1", createdBy: "alice", createdAt: "t", redeemedBy: "bob", redeemedAt: "t2" },
      ],
    });
    const invites = await listAllInvitesForRoom("room1");
    expect(invites).toHaveLength(2);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe("byRoom");
    expect(call.args[0].input.FilterExpression).toBeUndefined();
  });
});

describe("room/asset cascade helpers (account deletion)", () => {
  it("listRoomAssetsForCascade queries by roomId", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "room1", assetId: "a1", s3Key: "key1" },
        { roomId: "room1", assetId: "a2" },
      ],
    });
    const assets = await listRoomAssetsForCascade("room1");
    expect(assets).toHaveLength(2);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ":roomId": "room1" });
  });

  it("deleteAssetRow does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteAssetRow("room1", "a1")).resolves.toBeUndefined();
  });

  it("deleteRoomRow does not throw", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await expect(deleteRoomRow("room1")).resolves.toBeUndefined();
  });

  it("deleteS3Object issues a DeleteObjectCommand for the given key", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await deleteS3Object("some/key.png");
    const call = s3Mock.commandCalls(DeleteObjectCommand)[0];
    expect(call.args[0].input.Key).toBe("some/key.png");
  });

  it("deleteS3Object swallows a failure rather than throwing (best-effort)", async () => {
    s3Mock.on(DeleteObjectCommand).rejects(new Error("access denied"));
    await expect(deleteS3Object("some/key.png")).resolves.toBeUndefined();
  });
});
