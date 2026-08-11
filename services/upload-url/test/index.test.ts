import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn().mockResolvedValue({}) }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
}));
// Resolves every non-literal hostname to a fixed public IP -- these tests
// aren't exercising real DNS, just resolveSafeUrl's IP-range check, and the
// sandbox has no network access to actually resolve cdn.example.com anyway.
vi.mock("dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

import { getSessionUsername, getMembership } from "../../accounts/src/store";
import { sumRoomStorageBytes } from "../../websocket-handlers/src/roomState";
import { handler } from "../src/index";

function event(
  routeKey: string,
  opts: {
    query?: Record<string, string>;
    body?: string;
    headers?: Record<string, string>;
    cookies?: string[];
  } = {}
): APIGatewayProxyEventV2 {
  return {
    routeKey,
    queryStringParameters: opts.query,
    body: opts.body,
    headers: opts.headers ?? {},
    cookies: opts.cookies ?? [],
  } as unknown as APIGatewayProxyEventV2;
}

function jsonBody(res: Awaited<ReturnType<typeof handler>>): any {
  return JSON.parse((res as { body: string }).body);
}

const validQuery = { roomId: "r1", fileName: "photo.png", contentType: "image/png" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /assets/upload-url -- auth", () => {
  it("rejects a request with no session cookie", async () => {
    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
    expect(getMembership).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid/expired session token", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue(undefined);
    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=bogus"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects an authenticated account with no membership in the room", async () => {
    vi.mocked(getSessionUsername).mockResolvedValue("bob");
    vi.mocked(getMembership).mockResolvedValue(undefined);

    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=tok"] }),
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
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toMatchObject({ uploadUrl: "https://s3.example.com/presigned-put", type: "image" });
  });
});

// Test env sets ROOM_STORAGE_QUOTA_BYTES=1000 -- see vitest.config.mts.
describe("GET /assets/upload-url -- storage quota", () => {
  beforeEach(() => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
  });

  it("allows an upload when the room is under quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(999);
    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects an upload once the room is exactly at quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(1000);
    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatch(/quota/i);
  });

  it("rejects an upload when the room is already over quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(5000);
    const res: any = await handler(
      event("GET /assets/upload-url", { query: validQuery, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(413);
  });
});

describe("POST /assets/upload-from-url", () => {
  const body = JSON.stringify({ roomId: "r1", url: "https://cdn.example.com/emote/4x.gif" });

  beforeEach(() => {
    vi.mocked(getSessionUsername).mockResolvedValue("alice");
    vi.mocked(getMembership).mockResolvedValue({ accountId: "alice", roomId: "r1", role: "owner" });
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(res: {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }): void {
    const headers = new Headers(res.headers ?? {});
    const chunks = res.body ? [res.body] : [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: res.status ?? 200,
        ok: (res.status ?? 200) < 300,
        headers,
        body: {
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of chunks) yield chunk;
          },
        },
      })
    );
  }

  it("requires a roomId and url", async () => {
    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-member", async () => {
    vi.mocked(getMembership).mockResolvedValue(undefined);
    const res: any = await handler(
      event("POST /assets/upload-from-url", { body, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(403);
  });

  it("rejects a non-http(s) URL scheme", async () => {
    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1", url: "file:///etc/passwd" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/http/i);
  });

  it("fetches the URL and uploads it to S3, inferring the asset type from Content-Type", async () => {
    mockFetchOnce({
      headers: { "content-type": "image/gif", "content-length": "4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const res: any = await handler(
      event("POST /assets/upload-from-url", { body, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toMatchObject({ type: "gif" });
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putInput = s3Send.mock.calls[0][0].input;
    expect(putInput.ContentType).toBe("image/gif");
    expect(putInput.Key).toMatch(/^r1\//);
  });

  it("falls back to inferring the type from the URL extension when Content-Type is generic", async () => {
    mockFetchOnce({
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1", url: "https://cdn.example.com/emote/4x.gif" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toMatchObject({ type: "gif" });
  });

  it("rejects an unrecognized content type with no usable extension", async () => {
    mockFetchOnce({ headers: { "content-type": "text/html" }, body: new Uint8Array([1]) });

    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1", url: "https://example.com/page" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );

    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/unrecognized/i);
  });

  it("rejects once the room is already at quota", async () => {
    vi.mocked(sumRoomStorageBytes).mockResolvedValue(1000);
    const res: any = await handler(
      event("POST /assets/upload-from-url", { body, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(413);
  });

  it("rejects a response over the byte cap via Content-Length", async () => {
    mockFetchOnce({ headers: { "content-type": "image/gif", "content-length": String(100 * 1024 * 1024) } });
    const res: any = await handler(
      event("POST /assets/upload-from-url", { body, cookies: ["scenette_session=tok"] }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/too large/i);
  });

  it("rejects a URL that resolves to a private/loopback address", async () => {
    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1", url: "http://127.0.0.1/secret" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/not allowed/i);
  });

  it("rejects the cloud metadata address", async () => {
    const res: any = await handler(
      event("POST /assets/upload-from-url", {
        body: JSON.stringify({ roomId: "r1", url: "http://169.254.169.254/latest/meta-data/" }),
        cookies: ["scenette_session=tok"],
      }),
      {} as any,
      undefined as any
    );
    expect(res.statusCode).toBe(400);
    expect(jsonBody(res).error).toMatch(/not allowed/i);
  });
});

describe("unknown route", () => {
  it("returns 404", async () => {
    const res: any = await handler(event("DELETE /nope"), {} as any, undefined as any);
    expect(res.statusCode).toBe(404);
  });
});
