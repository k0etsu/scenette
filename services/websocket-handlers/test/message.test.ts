import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { handler } from "../src/message";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);

beforeEach(() => {
  ddbMock.reset();
  apiGwMock.reset();
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
  return { roomId: "r1", x: 0, y: 0, width: 1920, height: 1080, globalVolume: 1, globalVolumeSeq: 0, variables: {} };
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
