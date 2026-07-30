import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { roomIdForConnection, listPresence, sendTo, broadcastToRoom } from "../src/connections";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);
const apiGw = new ApiGatewayManagementApiClient({});

const goneException = Object.assign(new Error("gone"), { name: "GoneException" });

beforeEach(() => {
  ddbMock.reset();
  apiGwMock.reset();
});

describe("roomIdForConnection", () => {
  it("returns the connection's roomId", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { connectionId: "c1", roomId: "r1" } });
    await expect(roomIdForConnection("c1")).resolves.toBe("r1");
  });

  it("returns undefined for an unknown connection", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(roomIdForConnection("unknown")).resolves.toBeUndefined();
  });
});

describe("listPresence", () => {
  it("only includes connections that carry a username (excludes anonymous browser-source connections)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { connectionId: "c1", roomId: "r1", username: "alice", connectedAt: "t1" },
        { connectionId: "c2", roomId: "r1", connectedAt: "t2" }, // anonymous browser-source
        { connectionId: "c3", roomId: "r1", username: "bob", connectedAt: "t3" },
      ],
    });
    const presence = await listPresence("r1");
    expect(presence).toEqual([
      { username: "alice", connectedAt: "t1" },
      { username: "bob", connectedAt: "t3" },
    ]);
  });

  it("returns an empty array for a room with no username-carrying connections", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(listPresence("empty-room")).resolves.toEqual([]);
  });
});

describe("sendTo", () => {
  it("posts the message to the connection", async () => {
    apiGwMock.on(PostToConnectionCommand).resolves({});
    await sendTo(apiGw, "c1", { type: "error", message: "test" });
    expect(apiGwMock.commandCalls(PostToConnectionCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("deletes the connection row on GoneException instead of throwing", async () => {
    apiGwMock.on(PostToConnectionCommand).rejects(goneException);
    ddbMock.on(DeleteCommand).resolves({});
    await expect(sendTo(apiGw, "stale-connection", { type: "error", message: "test" })).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("rethrows any other error", async () => {
    apiGwMock.on(PostToConnectionCommand).rejects(new Error("network blip"));
    await expect(sendTo(apiGw, "c1", { type: "error", message: "test" })).rejects.toThrow("network blip");
  });
});

describe("broadcastToRoom", () => {
  it("sends to every connection in the room", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { connectionId: "c1", roomId: "r1" },
        { connectionId: "c2", roomId: "r1" },
      ],
    });
    apiGwMock.on(PostToConnectionCommand).resolves({});
    await broadcastToRoom(apiGw, "r1", { type: "error", message: "test" });
    expect(apiGwMock.commandCalls(PostToConnectionCommand)).toHaveLength(2);
  });

  it("excludes the given connectionId (e.g. a connection announcing its own presence:joined)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { connectionId: "self", roomId: "r1" },
        { connectionId: "other", roomId: "r1" },
      ],
    });
    apiGwMock.on(PostToConnectionCommand).resolves({});
    await broadcastToRoom(apiGw, "r1", { type: "error", message: "test" }, "self");
    const calls = apiGwMock.commandCalls(PostToConnectionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ConnectionId).toBe("other");
  });
});
