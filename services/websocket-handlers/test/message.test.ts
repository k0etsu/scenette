import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { handler } from "../src/message";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);
const s3Mock = mockClient(S3Client);

beforeEach(() => {
  ddbMock.reset();
  apiGwMock.reset();
  s3Mock.reset();
});

function event(body: unknown): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: { connectionId: "c1", domainName: "api.example.com", stage: "dev" },
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return { connectionId: "c1", roomId: "r1", connectedAt: "t", ...overrides };
}

function roomRow() {
  return {
    roomId: "r1",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    globalVolume: 1,
    globalVolumeSeq: 0,
    streamPreviewSettings: { platform: "twitch", twitchChannel: "", youtubeChannelId: "" },
    streamPreviewSettingsSeq: 0,
    variables: {},
  };
}

const assetAddMessage = {
  action: "asset:add",
  roomId: "r1",
  asset: { assetId: "a1", type: "image", x: 0, y: 0, width: 100, height: 100 },
};

describe("message handler -- write-action gate", () => {
  it("allows a member (connection with a username) to perform a write action", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event(assetAddMessage), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand).some((c) => c.args[0].input.TableName?.includes("assets"))).toBe(true);
  });

  it("rejects a write action from an anonymous (no-username) connection -- the browser-source page", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow() });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event(assetAddMessage), {} as any, undefined as any);

    expect(res.statusCode).toBe(200); // WS responses are always 200; the rejection is the error frame sent back
    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload).toEqual({ type: "error", message: "This connection is read-only" });
    // Regression: connect.ts already verified membership for any
    // username-bearing connection -- an anonymous one reaching here must
    // never be allowed to mutate room state just by sending the action.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("still allows an anonymous connection to request a room:snapshot (read-only, not blocked)", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow() });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event({ action: "room:snapshot:request", roomId: "r1" }), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload.type).toBe("room:snapshot");
    // Test env sets ROOM_STORAGE_QUOTA_BYTES=1000 -- see vitest.config.mts.
    expect(payload.storageQuotaBytes).toBe(1000);
  });

  it("rejects a message whose roomId doesn't match the connection's actual room", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(
      event({ ...assetAddMessage, roomId: "some-other-room" }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload).toEqual({ type: "error", message: "Not connected to this room" });
  });
});

describe("message handler -- room:setStreamPreviewSettings is owner-only", () => {
  const settingsMessage = {
    action: "room:setStreamPreviewSettings",
    roomId: "r1",
    settings: { platform: "twitch", twitchChannel: "shroud", youtubeChannelId: "" },
    seq: 100,
  };

  it("allows the room owner (role denormalized onto the connection row at $connect) to change it", async () => {
    ddbMock
      .on(GetCommand, { Key: { connectionId: "c1" } })
      .resolves({ Item: connectionRow({ username: "alice", role: "owner" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event(settingsMessage), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall.args[0].input.UpdateExpression).toContain("streamPreviewSettings");
  });

  it("rejects a mod (role: 'mod') with an error frame, without writing anything", async () => {
    ddbMock
      .on(GetCommand, { Key: { connectionId: "c1" } })
      .resolves({ Item: connectionRow({ username: "bob", role: "mod" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event(settingsMessage), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload).toEqual({
      type: "error",
      message: "Only the room owner can change the stream preview settings",
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("drops a stale write (an older seq than what's already applied) without broadcasting", async () => {
    ddbMock
      .on(GetCommand, { Key: { connectionId: "c1" } })
      .resolves({ Item: connectionRow({ username: "alice", role: "owner" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error("conditional check failed"), { name: "ConditionalCheckFailedException" })
    );
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(event(settingsMessage), {} as any, undefined as any);

    expect(res.statusCode).toBe(200);
    expect(apiGwMock.commandCalls(PostToConnectionCommand)).toHaveLength(0);
  });
});

describe("message handler -- asset:add server-verifies fileSize", () => {
  it("HeadObjects the uploaded s3Key and stores the real ContentLength as fileSize", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(PutCommand).resolves({});
    apiGwMock.on(PostToConnectionCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 123456 });

    await handler(event({ ...assetAddMessage, asset: { ...assetAddMessage.asset, s3Key: "r1/a1/photo.png" } }), {} as any, undefined as any);

    const headCall = s3Mock.commandCalls(HeadObjectCommand)[0];
    expect(headCall.args[0].input).toMatchObject({ Key: "r1/a1/photo.png" });
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall.args[0].input.Item?.fileSize).toBe(123456);
  });

  it("leaves fileSize undefined (doesn't fail the add) if the HeadObject call errors", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(PutCommand).resolves({});
    apiGwMock.on(PostToConnectionCommand).resolves({});
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));

    const res: any = await handler(
      event({ ...assetAddMessage, asset: { ...assetAddMessage.asset, s3Key: "r1/a1/photo.png" } }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    expect(putCall.args[0].input.Item?.fileSize).toBeUndefined();
  });

  it("skips the HeadObject entirely for a text asset (no s3Key)", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock.on(PutCommand).resolves({});
    apiGwMock.on(PostToConnectionCommand).resolves({});

    await handler(
      event({
        action: "asset:add",
        roomId: "r1",
        asset: { assetId: "t1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" },
      }),
      {} as any,
      undefined as any
    );

    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it("rejects an s3Key that points outside the connection's own room", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res: any = await handler(
      // Connection is in r1, but the key belongs to r2 -- attaching (and
      // later being able to delete) another room's media.
      event({ ...assetAddMessage, asset: { ...assetAddMessage.asset, s3Key: "r2/a1/photo.png" } }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload).toEqual({ type: "error", message: "Invalid asset key" });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("message handler -- asset:stop", () => {
  it("broadcasts asset:stopped with no DB write at all -- playback position is never persisted", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    // broadcastToRoom fans out to every connection the byRoom index returns
    // -- a real (not empty) connections list here is what actually exercises
    // the broadcast payload, unlike other tests in this file that only care
    // whether a broadcast happens without crashing.
    ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: "c2", roomId: "r1" }] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    await handler(event({ action: "asset:stop", roomId: "r1", assetId: "v1" }), {} as any, undefined as any);

    const sent = apiGwMock.commandCalls(PostToConnectionCommand)[0]?.args[0].input;
    const payload = JSON.parse(Buffer.from(sent!.Data as Uint8Array).toString());
    expect(payload).toEqual({ type: "asset:stopped", assetId: "v1" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });
});

describe("message handler -- asset:delete cleans up S3", () => {
  it("deletes the S3 object when no other asset in the room shares its s3Key", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock
      .on(GetCommand, { Key: { roomId: "r1", assetId: "a1" } })
      .resolves({ Item: { roomId: "r1", assetId: "a1", s3Key: "r1/a1/photo.png" } });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] }); // no other asset references this s3Key
    apiGwMock.on(PostToConnectionCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await handler(
      event({ action: "asset:delete", roomId: "r1", assetId: "a1" }),
      {} as any,
      undefined as any
    );

    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe("r1/a1/photo.png");
  });

  it("does NOT delete the S3 object when a duplicate asset still references the same s3Key", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock
      .on(GetCommand, { Key: { roomId: "r1", assetId: "a1" } })
      .resolves({ Item: { roomId: "r1", assetId: "a1", s3Key: "r1/a1/photo.png" } });
    ddbMock.on(DeleteCommand).resolves({});
    // The duplicate ("a1-copy") still references the same s3Key.
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "r1", assetId: "a1", s3Key: "r1/a1/photo.png" },
        { roomId: "r1", assetId: "a1-copy", s3Key: "r1/a1/photo.png" },
      ],
    });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    await handler(
      event({ action: "asset:delete", roomId: "r1", assetId: "a1" }),
      {} as any,
      undefined as any
    );

    // Regression: the room's DDB row for "a1" is gone either way, but the
    // physical S3 object must survive since "a1-copy" still points at it --
    // deleting it here would silently break that still-live duplicate.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("does not touch S3 at all when deleting a text asset (no s3Key)", async () => {
    ddbMock.on(GetCommand, { Key: { connectionId: "c1" } }).resolves({ Item: connectionRow({ username: "alice" }) });
    ddbMock.on(GetCommand, { Key: { roomId: "r1" } }).resolves({ Item: roomRow() });
    ddbMock
      .on(GetCommand, { Key: { roomId: "r1", assetId: "t1" } })
      .resolves({ Item: { roomId: "r1", assetId: "t1", text: "hi" } });
    ddbMock.on(DeleteCommand).resolves({});
    apiGwMock.on(PostToConnectionCommand).resolves({});

    await handler(
      event({ action: "asset:delete", roomId: "r1", assetId: "t1" }),
      {} as any,
      undefined as any
    );

    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    // The only Query here is broadcastToRoom's connections-table fan-out --
    // no s3Key means isS3KeyReferencedElsewhere (an assets-table Query) is
    // never even called.
    expect(ddbMock.commandCalls(QueryCommand).every((c) => c.args[0].input.TableName === "test-connections")).toBe(true);
  });
});
