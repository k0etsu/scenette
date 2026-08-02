import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

vi.mock("../../accounts/src/store", () => ({
  getSessionUsername: vi.fn(),
  getMembership: vi.fn(),
}));

import { getSessionUsername, getMembership } from "../../accounts/src/store";
import { handler } from "../src/connect";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);

beforeEach(() => {
  ddbMock.reset();
  apiGwMock.reset();
  vi.clearAllMocks();
});

function event(query: Record<string, string>): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: { connectionId: "c1", domainName: "api.example.com", stage: "dev" },
    queryStringParameters: query,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

function putConnectedAt(): string | undefined {
  const call = ddbMock.commandCalls(PutCommand)[0];
  return call?.args[0].input.Item?.connectedAt as string | undefined;
}

describe("connect handler -- connectedAt", () => {
  it("stamps its own current time when the client sends no connectedAt (first-ever connect)", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue(undefined);
    ddbMock.on(PutCommand).resolves({});

    const before = Date.now();
    await handler(event({ roomId: "r1" }), {} as any, {} as any);
    const after = Date.now();

    const stamped = Date.parse(putConnectedAt()!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("preserves the client-supplied connectedAt on a reconnect, instead of resetting it to now", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "mod" });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    // Regression: a proactive reconnect (or a drop-and-retry) used to open a
    // brand-new $connect and always stamp `new Date()`, so the
    // connected-users list reset to "just now" on every silent reconnect
    // even though the user never actually left.
    const originalJoinTime = "2026-01-01T00:00:00.000Z";
    await handler(
      event({ roomId: "r1", token: "tok", connectedAt: originalJoinTime }),
      {} as any,
      {} as any
    );

    expect(putConnectedAt()).toBe(originalJoinTime);
  });

  it("falls back to now for a malformed connectedAt", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue(undefined);
    ddbMock.on(PutCommand).resolves({});

    const before = Date.now();
    await handler(event({ roomId: "r1", connectedAt: "not-a-date" }), {} as any, {} as any);
    const after = Date.now();

    const stamped = Date.parse(putConnectedAt()!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("falls back to now for a future-dated connectedAt (rejects an attempt to fake a longer session)", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue(undefined);
    ddbMock.on(PutCommand).resolves({});

    const future = new Date(Date.now() + 60_000).toISOString();
    const before = Date.now();
    await handler(event({ roomId: "r1", connectedAt: future }), {} as any, {} as any);
    const after = Date.now();

    const stamped = Date.parse(putConnectedAt()!);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe("connect handler -- membership enforcement", () => {
  it("rejects an authenticated connection with no membership in the room", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("bob");
    vi.mocked(getMembership).mockResolvedValue(undefined);

    const res = await handler(event({ roomId: "r1", token: "tok" }), {} as any, {} as any);

    expect(res).toEqual({ statusCode: 403, body: "Not a member of this room" });
    expect(getMembership).toHaveBeenCalledWith("bob", "r1");
    // Regression: previously any logged-in account could join and fully
    // read/write any room just by knowing its roomId -- no row should ever
    // get written for a rejected connection.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("accepts an authenticated connection that IS a member (owner or mod)", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    const res = await handler(event({ roomId: "r1", token: "tok" }), {} as any, {} as any);

    expect(res).toEqual({ statusCode: 200, body: "Connected" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it("accepts an anonymous (no-token) connection without checking membership -- the browser-source page", async () => {
    ddbMock.on(PutCommand).resolves({});

    const res = await handler(event({ roomId: "r1" }), {} as any, {} as any);

    expect(res).toEqual({ statusCode: 200, body: "Connected" });
    expect(getMembership).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it("denormalizes the membership row's role onto the connection row", async () => {
    // message.ts has no MembershipsTable grant of its own -- it trusts this
    // stamped-at-connect value instead of re-querying per message (see
    // connections.ts's ConnectionInfo.role doc comment).
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    apiGwMock.on(PostToConnectionCommand).resolves({});

    await handler(event({ roomId: "r1", token: "tok" }), {} as any, {} as any);

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item?.role).toBe("owner");
  });

  it("stamps no role at all for an anonymous connection", async () => {
    ddbMock.on(PutCommand).resolves({});

    await handler(event({ roomId: "r1" }), {} as any, {} as any);

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item?.role).toBeUndefined();
  });
});
