import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

vi.mock("../../accounts/src/store", () => ({
  getSessionUsername: vi.fn(),
  getMembership: vi.fn(),
}));
vi.mock("../../websocket-handlers/src/roomState", () => ({
  sumRoomStorageBytes: vi.fn(),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/presigned-put"),
}));

import { getSessionUsername, getMembership } from "../../accounts/src/store";
import { sumRoomStorageBytes } from "../../websocket-handlers/src/roomState";
import { handler } from "../src/index";

function event(query: Record<string, string>, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    queryStringParameters: query,
    headers,
  } as unknown as APIGatewayProxyEventV2;
}

function jsonBody(res: Awaited<ReturnType<typeof handler>>): any {
  return JSON.parse((res as { body: string }).body);
}

const validQuery = { roomId: "r1", fileName: "photo.png", contentType: "image/png" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upload-url handler -- auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res: any = await handler(event(validQuery), {} as any, undefined as any);
    expect(res.statusCode).toBe(401);
    expect(getMembership).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid/expired session token", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue(undefined);
    const res: any = await handler(
      event(validQuery, { authorization: "Bearer bogus" }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects an authenticated account with no membership in the room", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("bob");
    vi.mocked(getMembership).mockResolvedValue(undefined);

    const res: any = await handler(
      event(validQuery, { authorization: "Bearer tok" }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(403);
    expect(getMembership).toHaveBeenCalledWith("bob", "r1");
  });

  it("issues a presigned URL for an authenticated member", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(0);

    const res: any = await handler(
      event(validQuery, { authorization: "Bearer tok" }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toMatchObject({ uploadUrl: "https://s3.example.com/presigned-put", type: "image" });
  });
});

// Test env sets ROOM_STORAGE_QUOTA_BYTES=1000 -- see vitest.config.mts.
describe("upload-url handler -- storage quota", () => {
  beforeEach(() => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
  });

  it("allows an upload when the room is under quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(999);
    const res: any = await handler(event(validQuery, { authorization: "Bearer tok" }), {} as any, undefined as any);
    expect(res.statusCode).toBe(200);
  });

  it("rejects an upload once the room is exactly at quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(1000);
    const res: any = await handler(event(validQuery, { authorization: "Bearer tok" }), {} as any, undefined as any);
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatch(/quota/i);
  });

  it("rejects an upload when the room is already over quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(5000);
    const res: any = await handler(event(validQuery, { authorization: "Bearer tok" }), {} as any, undefined as any);
    expect(res.statusCode).toBe(413);
  });
});
