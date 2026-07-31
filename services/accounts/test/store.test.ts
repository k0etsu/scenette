import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
});
