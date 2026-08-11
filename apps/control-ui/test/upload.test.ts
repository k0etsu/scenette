// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

import { uploadFile, uploadFromUrl } from "../src/upload";

function makeFile(): File {
  // audio takes the DEFAULT_AUDIO_SIZE early-return path in
  // detectDimensions, so this test doesn't also need to mock
  // Image/HTMLVideoElement decoding.
  return new File([new Uint8Array([1, 2, 3])], "clip.mp3", { type: "audio/mpeg" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/assets/upload-url")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ uploadUrl: "https://s3.example.com/put", s3Key: "k", assetId: "a1", type: "audio" }),
        });
      }
      // The presigned S3 PUT itself.
      return Promise.resolve({ ok: true });
    })
  );
});

describe("uploadFile -- auth", () => {
  it("requests the presigned URL with credentials so the session cookie is sent (no Bearer header)", async () => {
    await uploadFile("https://api.example.com", "room1", makeFile());

    const presignCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/assets/upload-url"));
    expect(presignCall?.[1]).toMatchObject({ credentials: "include" });
    expect((presignCall?.[1] as RequestInit | undefined)?.headers).toBeUndefined();
  });
});

describe("uploadFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/assets/upload-from-url")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ s3Key: "room1/a1/emote.gif", assetId: "a1", type: "audio" }),
          });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      })
    );
  });

  it("posts the room and source URL with credentials, and resolves the hosted asset URL for dimensions", async () => {
    // type: "audio" (see the mock above) takes detectDimensionsFromUrl's
    // early-return path, so this doesn't also need to mock Image decoding.
    const result = await uploadFromUrl("https://api.example.com", "room1", "https://cdn.example.com/e.gif", "assets.example.com");

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.example.com/assets/upload-from-url");
    expect(call[1]).toMatchObject({ credentials: "include", method: "POST" });
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      roomId: "room1",
      url: "https://cdn.example.com/e.gif",
    });
    expect(result).toMatchObject({ assetId: "a1", s3Key: "room1/a1/emote.gif", type: "audio" });
  });

  it("surfaces the server's error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Could not fetch that URL: URL host is not allowed" }),
      })
    );

    await expect(uploadFromUrl("https://api.example.com", "room1", "http://127.0.0.1/x", "assets.example.com")).rejects.toThrow(
      /URL host is not allowed/
    );
  });
});
