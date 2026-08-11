import { describe, it, expect } from "vitest";
import { parseClientMessage, isValidYoutubeVideoId, extractYoutubeVideoId } from "../src/messages";

function send(body: unknown): ReturnType<typeof parseClientMessage> {
  return parseClientMessage(JSON.stringify(body));
}

describe("parseClientMessage", () => {
  it("rejects malformed JSON", () => {
    expect(() => parseClientMessage("{not json")).toThrow("Malformed JSON");
  });

  it("rejects a body with no action", () => {
    expect(() => send({ roomId: "room1" })).toThrow("Missing action");
  });

  it("rejects a missing/empty roomId regardless of action", () => {
    expect(() => send({ action: "room:snapshot:request" })).toThrow("Missing roomId");
    expect(() => send({ action: "room:snapshot:request", roomId: "" })).toThrow("Missing roomId");
  });

  it("rejects an unknown action", () => {
    expect(() => send({ action: "not:a:real:action", roomId: "room1" })).toThrow("Unknown action");
  });

  it("parses room:snapshot:request", () => {
    expect(send({ action: "room:snapshot:request", roomId: "room1" })).toEqual({
      action: "room:snapshot:request",
      roomId: "room1",
    });
  });

  describe("asset:add", () => {
    const base = {
      action: "asset:add",
      roomId: "room1",
      asset: { assetId: "a1", type: "image", x: 1, y: 2, width: 3, height: 4 },
    };

    it("parses the minimal required fields with everything else undefined", () => {
      expect(send(base)).toEqual({
        action: "asset:add",
        roomId: "room1",
        asset: {
          assetId: "a1",
          type: "image",
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          rotation: undefined,
          zIndex: undefined,
          s3Key: undefined,
          text: undefined,
          youtubeVideoId: undefined,
          name: undefined,
          opacity: undefined,
          blur: undefined,
          flipX: undefined,
          flipY: undefined,
          locked: undefined,
          hidden: undefined,
          loop: undefined,
          muted: undefined,
          volume: undefined,
          paused: undefined,
          fontFamily: undefined,
          fontSize: undefined,
          fontWeight: undefined,
          textAlign: undefined,
          textColor: undefined,
          backgroundColor: undefined,
          backgroundAlpha: undefined,
          shadowEnabled: undefined,
          shadowX: undefined,
          shadowY: undefined,
          shadowBlur: undefined,
          shadowColor: undefined,
          outlineEnabled: undefined,
          outlineColor: undefined,
          outlineWidth: undefined,
        },
      });
    });

    it("carries over every optional field when present (the duplicate-asset case)", () => {
      const full = {
        ...base,
        asset: {
          ...base.asset,
          rotation: 45,
          zIndex: 3,
          s3Key: "key.png",
          text: "hello",
          name: "my label",
          opacity: 0.5,
          blur: 2,
          flipX: true,
          flipY: false,
          locked: true,
          hidden: false,
          loop: true,
          muted: false,
          volume: 0.8,
          paused: true,
          fontFamily: "Roboto Mono",
          fontSize: 32,
          fontWeight: "700",
          textAlign: "center",
          textColor: "#112233",
          backgroundColor: "#445566",
          backgroundAlpha: 0.7,
          shadowEnabled: true,
          shadowX: 1,
          shadowY: 2,
          shadowBlur: 3,
          shadowColor: "#000000",
          outlineEnabled: true,
          outlineColor: "#ffffff",
          outlineWidth: 2,
        },
      };
      const result = send(full) as { asset: unknown };
      expect(result.asset).toMatchObject(full.asset);
    });

    it("rejects a missing asset object", () => {
      expect(() => send({ action: "asset:add", roomId: "room1" })).toThrow("Missing asset");
    });

    it("rejects a missing assetId", () => {
      expect(() =>
        send({ action: "asset:add", roomId: "room1", asset: { type: "image", x: 1, y: 2, width: 3, height: 4 } })
      ).toThrow("Missing asset.assetId");
    });

    it("rejects an invalid asset type", () => {
      expect(() => send({ ...base, asset: { ...base.asset, type: "bogus" } })).toThrow("Invalid asset.type");
    });

    it("accepts a youtube asset with a valid video ID", () => {
      const result = send({
        ...base,
        asset: { ...base.asset, type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" },
      }) as { asset: { type: string; youtubeVideoId?: string } };
      expect(result.asset.type).toBe("youtube");
      expect(result.asset.youtubeVideoId).toBe("dQw4w9WgXcQ");
    });

    it("rejects a youtube asset with no video ID", () => {
      expect(() => send({ ...base, asset: { ...base.asset, type: "youtube" } })).toThrow(
        "Missing/invalid asset.youtubeVideoId"
      );
    });

    it("rejects a youtube asset with a malformed video ID", () => {
      expect(() =>
        send({ ...base, asset: { ...base.asset, type: "youtube", youtubeVideoId: "not-11-chars" } })
      ).toThrow("Missing/invalid asset.youtubeVideoId");
    });

    it.each(["x", "y", "width", "height"])("rejects a missing/non-numeric %s", (key) => {
      const asset = { ...base.asset, [key]: undefined };
      expect(() => send({ ...base, asset })).toThrow(`Missing/invalid asset.${key}`);
    });

    it("accepts a clock asset and carries its clock fields", () => {
      const asset = {
        assetId: "c1",
        type: "clock",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        clockMode: "countdown",
        clockRunning: true,
        clockAnchorMs: 123,
        clockElapsedMs: 0,
        clockDurationMs: 300000,
        clockTargetMs: 999,
        clockTimezone: "UTC",
        clockFormat: "24h-seconds",
      };
      const result = send({ action: "asset:add", roomId: "room1", asset });
      expect(result).toMatchObject({
        asset: {
          type: "clock",
          clockMode: "countdown",
          clockRunning: true,
          clockAnchorMs: 123,
          clockDurationMs: 300000,
          clockTargetMs: 999,
          clockTimezone: "UTC",
          clockFormat: "24h-seconds",
        },
      });
    });

    it("drops invalid clock enum values (clockMode/clockFormat)", () => {
      const asset = {
        assetId: "c1",
        type: "clock",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        clockMode: "bogus",
        clockFormat: "13h",
      };
      const result = send({ action: "asset:add", roomId: "room1", asset }) as {
        asset: Record<string, unknown>;
      };
      expect(result.asset.clockMode).toBeUndefined();
      expect(result.asset.clockFormat).toBeUndefined();
    });
  });

  describe("asset:move", () => {
    const base = { action: "asset:move", roomId: "room1", assetId: "a1", x: 10, y: 20, seq: 1 };

    it("parses with optional rotation omitted", () => {
      expect(send(base)).toEqual({ ...base, rotation: undefined });
    });

    it("parses with rotation present", () => {
      expect(send({ ...base, rotation: 90 })).toMatchObject({ rotation: 90 });
    });

    it("rejects a missing seq", () => {
      const { seq, ...withoutSeq } = base;
      expect(() => send(withoutSeq)).toThrow("Missing seq");
    });

    it("rejects a missing assetId", () => {
      const { assetId, ...withoutAssetId } = base;
      expect(() => send(withoutAssetId)).toThrow("Missing assetId");
    });
  });

  describe("asset:resize", () => {
    const base = { action: "asset:resize", roomId: "room1", assetId: "a1", x: 1, y: 2, width: 3, height: 4, seq: 5 };

    it("parses a full resize message", () => {
      expect(send(base)).toEqual(base);
    });

    it.each(["x", "y", "width", "height", "seq"])("rejects a missing/non-numeric %s", (key) => {
      const msg = { ...base, [key]: "not a number" };
      expect(() => send(msg)).toThrow(`Missing/invalid ${key}`);
    });
  });

  describe("asset:update", () => {
    it("parses a patch with only the changed fields", () => {
      const msg = { action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch: { paused: true } };
      expect(send(msg)).toEqual(msg);
    });

    it("carries clock fields in a patch (e.g. start/pause/mode changes)", () => {
      const patch = { clockRunning: false, clockElapsedMs: 4200, clockMode: "countup" };
      const msg = { action: "asset:update", roomId: "room1", assetId: "a1", seq: 2, patch };
      expect(send(msg)).toMatchObject({ patch });
    });

    it("picks out every recognized patch field and drops unrecognized ones", () => {
      const patch = {
        text: "hi",
        name: "my label",
        hidden: true,
        locked: true,
        opacity: 0.5,
        blur: 3,
        flipX: true,
        flipY: true,
        zIndex: 2,
        rotation: 10,
        loop: false,
        muted: true,
        volume: 0.2,
        paused: false,
        fontFamily: "Roboto Mono",
        fontSize: 32,
        fontWeight: "700",
        textAlign: "center",
        textColor: "#112233",
        backgroundColor: "#445566",
        backgroundAlpha: 0.7,
        shadowEnabled: true,
        shadowX: 1,
        shadowY: 2,
        shadowBlur: 3,
        shadowColor: "#000000",
        outlineEnabled: true,
        outlineColor: "#ffffff",
        outlineWidth: 2,
        width: 300,
        height: 150,
        somethingUnknown: "ignored",
      };
      const result = send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch });
      const { somethingUnknown: _ignored, ...expected } = patch;
      expect(result).toEqual({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch: expected });
    });

    it("parses width/height -- a text asset's auto-fit correction folded into the same patch as the edit that caused it", () => {
      const msg = {
        action: "asset:update",
        roomId: "room1",
        assetId: "a1",
        seq: 1,
        patch: { fontSize: 40, width: 200, height: 80 },
      };
      expect(send(msg)).toEqual(msg);
    });

    it("rejects an invalid textAlign value", () => {
      const patch = { textAlign: "diagonal", opacity: 0.5 };
      const result = send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch }) as {
        patch: Record<string, unknown>;
      };
      expect(result.patch).not.toHaveProperty("textAlign");
      expect(result.patch.opacity).toBe(0.5);
    });

    it("drops a colour value carrying an HTML/XSS payload but keeps a valid one", () => {
      const patch = {
        // Would break out of control-ui's value="..." attribute if it ever
        // reached the (innerHTML) properties panel unescaped.
        textColor: '"><img src=x onerror=alert(1)>',
        backgroundColor: "#445566",
      };
      const result = send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch }) as {
        patch: Record<string, unknown>;
      };
      expect(result.patch).not.toHaveProperty("textColor");
      expect(result.patch.backgroundColor).toBe("#445566");
    });

    it("accepts hex, named, and rgb()/hsl() colour values", () => {
      const patch = {
        textColor: "#fff",
        backgroundColor: "rebeccapurple",
        shadowColor: "rgba(1, 2, 3, 0.5)",
        outlineColor: "hsl(120, 50%, 50%)",
      };
      const result = send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch }) as {
        patch: Record<string, unknown>;
      };
      expect(result.patch).toEqual(patch);
    });

    it("rejects an empty patch", () => {
      expect(() =>
        send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch: {} })
      ).toThrow("Empty patch");
    });

    it("rejects a patch with only unrecognized fields (equivalent to empty)", () => {
      expect(() =>
        send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1, patch: { bogus: true } })
      ).toThrow("Empty patch");
    });

    it("rejects a missing patch object", () => {
      expect(() => send({ action: "asset:update", roomId: "room1", assetId: "a1", seq: 1 })).toThrow(
        "Missing patch"
      );
    });
  });

  describe("asset:delete", () => {
    it("parses a delete message", () => {
      expect(send({ action: "asset:delete", roomId: "room1", assetId: "a1" })).toEqual({
        action: "asset:delete",
        roomId: "room1",
        assetId: "a1",
      });
    });

    it("rejects a missing assetId", () => {
      expect(() => send({ action: "asset:delete", roomId: "room1" })).toThrow("Missing assetId");
    });
  });

  describe("asset:stop", () => {
    it("parses a stop message", () => {
      expect(send({ action: "asset:stop", roomId: "room1", assetId: "a1" })).toEqual({
        action: "asset:stop",
        roomId: "room1",
        assetId: "a1",
      });
    });

    it("rejects a missing assetId", () => {
      expect(() => send({ action: "asset:stop", roomId: "room1" })).toThrow("Missing assetId");
    });
  });

  describe("asset:seek", () => {
    it("parses a seek message", () => {
      expect(send({ action: "asset:seek", roomId: "room1", assetId: "a1", positionSeconds: 12.5 })).toEqual({
        action: "asset:seek",
        roomId: "room1",
        assetId: "a1",
        positionSeconds: 12.5,
      });
    });

    it("accepts a position of exactly 0", () => {
      expect(send({ action: "asset:seek", roomId: "room1", assetId: "a1", positionSeconds: 0 })).toMatchObject({
        positionSeconds: 0,
      });
    });

    it("rejects a missing assetId", () => {
      expect(() => send({ action: "asset:seek", roomId: "room1", positionSeconds: 5 })).toThrow("Missing assetId");
    });

    it("rejects a missing positionSeconds", () => {
      expect(() => send({ action: "asset:seek", roomId: "room1", assetId: "a1" })).toThrow(
        "Missing/invalid positionSeconds"
      );
    });

    it("rejects a negative positionSeconds", () => {
      expect(() =>
        send({ action: "asset:seek", roomId: "room1", assetId: "a1", positionSeconds: -1 })
      ).toThrow("Missing/invalid positionSeconds");
    });
  });

  describe("room:setGlobalVolume", () => {
    it("parses a valid message", () => {
      const msg = { action: "room:setGlobalVolume", roomId: "room1", globalVolume: 0.5, seq: 123 };
      expect(send(msg)).toEqual(msg);
    });

    it("rejects a missing globalVolume", () => {
      expect(() => send({ action: "room:setGlobalVolume", roomId: "room1", seq: 1 })).toThrow(
        "Missing/invalid globalVolume"
      );
    });

    it("rejects a missing seq", () => {
      expect(() => send({ action: "room:setGlobalVolume", roomId: "room1", globalVolume: 0.5 })).toThrow(
        "Missing seq"
      );
    });
  });

  describe("room:setStreamPreviewSettings", () => {
    const settings = { platform: "twitch", twitchChannel: "shroud", youtubeChannelId: "" };

    it("parses a valid message", () => {
      const msg = { action: "room:setStreamPreviewSettings", roomId: "room1", settings, seq: 1 };
      expect(send(msg)).toEqual(msg);
    });

    it("rejects a missing seq", () => {
      expect(() =>
        send({ action: "room:setStreamPreviewSettings", roomId: "room1", settings })
      ).toThrow("Missing seq");
    });

    it("rejects a missing settings object", () => {
      expect(() =>
        send({ action: "room:setStreamPreviewSettings", roomId: "room1", seq: 1 })
      ).toThrow("Missing settings");
    });

    it("rejects an invalid platform", () => {
      expect(() =>
        send({
          action: "room:setStreamPreviewSettings",
          roomId: "room1",
          settings: { ...settings, platform: "twitter" },
          seq: 1,
        })
      ).toThrow("Invalid settings.platform");
    });

    it("rejects a missing twitchChannel/youtubeChannelId", () => {
      expect(() =>
        send({
          action: "room:setStreamPreviewSettings",
          roomId: "room1",
          settings: { platform: "twitch", youtubeChannelId: "" },
          seq: 1,
        })
      ).toThrow("Missing/invalid settings.twitchChannel");
    });
  });

  describe("variable:set", () => {
    it("parses a number-type variable", () => {
      const msg = { action: "variable:set", roomId: "room1", key: "kills", type: "number", value: "4" };
      expect(send(msg)).toEqual(msg);
    });

    it("parses a text-type variable", () => {
      const msg = { action: "variable:set", roomId: "room1", key: "greeting", type: "text", value: "hi" };
      expect(send(msg)).toEqual(msg);
    });

    it("rejects an empty key", () => {
      expect(() =>
        send({ action: "variable:set", roomId: "room1", key: "", type: "number", value: "1" })
      ).toThrow("Missing key");
    });

    it("rejects an invalid type", () => {
      expect(() =>
        send({ action: "variable:set", roomId: "room1", key: "k", type: "boolean", value: "1" })
      ).toThrow("Invalid type");
    });

    it("rejects a non-string value", () => {
      expect(() =>
        send({ action: "variable:set", roomId: "room1", key: "k", type: "number", value: 1 })
      ).toThrow("Missing/invalid value");
    });
  });

  describe("variable:delete", () => {
    it("parses a valid message", () => {
      expect(send({ action: "variable:delete", roomId: "room1", key: "kills" })).toEqual({
        action: "variable:delete",
        roomId: "room1",
        key: "kills",
      });
    });

    it("rejects an empty key", () => {
      expect(() => send({ action: "variable:delete", roomId: "room1", key: "" })).toThrow("Missing key");
    });
  });
});

describe("isValidYoutubeVideoId", () => {
  it("accepts an 11-character id from the expected character set", () => {
    expect(isValidYoutubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isValidYoutubeVideoId("a-b_c1D2e3F")).toBe(true);
  });

  it.each([
    ["too short", "short"],
    ["too long", "dQw4w9WgXcQQ"],
    ["disallowed character", "dQw4w9Wg$cQ"],
    ["not a string", 12345],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isValidYoutubeVideoId(value)).toBe(false);
  });
});

describe("extractYoutubeVideoId", () => {
  const id = "dQw4w9WgXcQ";

  it.each([
    ["watch URL", `https://www.youtube.com/watch?v=${id}`],
    ["watch URL without www", `https://youtube.com/watch?v=${id}`],
    ["watch URL with extra query params", `https://www.youtube.com/watch?v=${id}&t=30s&list=PL123`],
    ["http (not https)", `http://www.youtube.com/watch?v=${id}`],
    ["youtu.be short link", `https://youtu.be/${id}`],
    ["youtu.be with query params", `https://youtu.be/${id}?t=30`],
    ["shorts URL", `https://www.youtube.com/shorts/${id}`],
    ["embed URL", `https://www.youtube.com/embed/${id}`],
    ["m.youtube.com watch URL", `https://m.youtube.com/watch?v=${id}`],
  ])("extracts the video id from a %s", (_label, url) => {
    expect(extractYoutubeVideoId(url)).toBe(id);
  });

  it.each([
    ["not a URL at all", "just some text"],
    ["a non-YouTube URL", "https://example.com/watch?v=dQw4w9WgXcQ"],
    ["a YouTube URL with no video id", "https://www.youtube.com/watch"],
    ["a YouTube channel URL", "https://www.youtube.com/@someChannel"],
    ["a malformed video id", `https://www.youtube.com/watch?v=short`],
  ])("returns undefined for %s", (_label, url) => {
    expect(extractYoutubeVideoId(url)).toBeUndefined();
  });
});
