// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/auth", () => ({
  getStoredToken: vi.fn(),
}));

import { getStoredToken } from "../src/auth";
import { uploadFile } from "../src/upload";

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
  it("sends the stored session token as a Bearer header when requesting the presigned URL", async () => {
    vi.mocked(getStoredToken).mockReturnValue("tok123");

    await uploadFile("https://api.example.com", "room1", makeFile());

    const presignCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/assets/upload-url"));
    expect(presignCall?.[1]).toMatchObject({ headers: { Authorization: "Bearer tok123" } });
  });

  it("throws without calling fetch at all when there is no stored session", async () => {
    vi.mocked(getStoredToken).mockReturnValue(null);

    await expect(uploadFile("https://api.example.com", "room1", makeFile())).rejects.toThrow("Not logged in");
    expect(fetch).not.toHaveBeenCalled();
  });
});
