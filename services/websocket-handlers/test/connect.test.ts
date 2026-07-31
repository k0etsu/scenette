import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

vi.mock("../../accounts/src/store", () => ({
  getSessionUsername: vi.fn(),
}));

import { getSessionUsername } from "../../accounts/src/store";
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
