// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@scenette/protocol";
import { Renderer } from "../src/render";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    roomId: "room1",
    assetId: "a1",
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 0,
    visible: true,
    hidden: false,
    locked: false,
    opacity: 1,
    blur: 0,
    flipX: false,
    flipY: false,
    loop: true,
    muted: false,
    volume: 1,
    // Kept true unless a test cares about play/pause -- jsdom's
    // HTMLMediaElement.play() rejects with "not implemented", and only
    // the paused(false)-while-media.paused(true) branch calls it.
    paused: true,
    seq: 1,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    keep: false,
    ...overrides,
  };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

describe("visibility and geometry", () => {
  it("hides an element whose asset.visible is false", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ visible: false }));
    const el = root.firstElementChild as HTMLElement;
    expect(el.style.display).toBe("none");
  });

  it("shows a visible element", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ visible: true }));
    const el = root.firstElementChild as HTMLElement;
    expect(el.style.display).toBe("block");
  });

  it("removes the element on remove()", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset());
    renderer.remove("a1");
    expect(root.children).toHaveLength(0);
    expect(renderer.get("a1")).toBeUndefined();
  });

  it("setAssets removes elements no longer present", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.setAssets([makeAsset({ assetId: "a1" }), makeAsset({ assetId: "a2" })]);
    renderer.setAssets([makeAsset({ assetId: "a1" })]);
    expect(renderer.get("a2")).toBeUndefined();
    expect(root.children).toHaveLength(1);
  });
});

describe("pointer-events -- this is a pure output surface, nothing should ever interact with playback directly", () => {
  it("disables pointer events on a video element", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video" }));
    expect((root.querySelector("video") as HTMLElement).style.pointerEvents).toBe("none");
  });

  it("disables pointer events on an audio element", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "audio" }));
    expect((root.querySelector("audio") as HTMLElement).style.pointerEvents).toBe("none");
  });

  it("disables pointer events on the youtube wrapper", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    const wrapper = root.querySelector('[data-asset-type="youtube"]')!.firstElementChild as HTMLElement;
    expect(wrapper.style.pointerEvents).toBe("none");
  });
});

describe("stop()", () => {
  it("resets a video's currentTime to 0", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video" }));
    const video = root.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 30, writable: true });

    renderer.stop("a1");

    expect(video.currentTime).toBe(0);
  });

  it("resets an audio asset's currentTime too -- unlike control-ui's own preview, browser-source actually plays audio", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "audio" }));
    const audio = root.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 15, writable: true });

    renderer.stop("a1");

    expect(audio.currentTime).toBe(0);
  });

  it("does nothing for an unknown assetId", () => {
    const renderer = new Renderer(root, "assets.example.com");
    expect(() => renderer.stop("missing")).not.toThrow();
  });

  it("does nothing for a non-media asset type (e.g. image)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "image" }));
    expect(() => renderer.stop("a1")).not.toThrow();
  });
});

describe("seek()", () => {
  it("sets a video's currentTime to the given position", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video" }));
    const video = root.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 0, writable: true });

    renderer.seek("a1", 42.5);

    expect(video.currentTime).toBe(42.5);
  });

  it("sets an audio asset's currentTime too", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "audio" }));
    const audio = root.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 0, writable: true });

    renderer.seek("a1", 10);

    expect(audio.currentTime).toBe(10);
  });

  it("does nothing for an unknown assetId", () => {
    const renderer = new Renderer(root, "assets.example.com");
    expect(() => renderer.seek("missing", 5)).not.toThrow();
  });

  it("does nothing for a non-media asset type (e.g. image)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "image" }));
    expect(() => renderer.seek("a1", 5)).not.toThrow();
  });

  it("does not throw for a youtube asset (player not necessarily ready yet)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => renderer.seek("a1", 5)).not.toThrow();
  });
});

function flushFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("tick() width/height smoothing (regression: text box visibly lagging behind its own content)", () => {
  it("snaps a text asset's width/height immediately instead of smoothing it like a drag", async () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "text", width: 40, height: 30 }));
    await flushFrame(); // let the constructor's own initial tick pass

    // A big single jump, the same shape as a coalesced auto-fit resize
    // following several keystrokes -- see control-ui's autoSizeText.
    renderer.upsert(makeAsset({ type: "text", width: 200, height: 90 }));
    await flushFrame();

    const el = root.firstElementChild as HTMLElement;
    expect(el.style.width).toBe("200px");
    expect(el.style.height).toBe("90px");
  });

  it("still smooths width/height for a genuinely dragged/resized asset type (e.g. image), not an instant snap", async () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "image", width: 40, height: 30 }));
    await flushFrame();

    renderer.upsert(makeAsset({ type: "image", width: 200, height: 90 }));
    await flushFrame();

    const el = root.firstElementChild as HTMLElement;
    const width = parseFloat(el.style.width);
    const height = parseFloat(el.style.height);
    // Regression guard the other direction: a single frame at
    // SMOOTHING_FACTOR shouldn't already be at the target -- if it is,
    // smoothing silently stopped applying to non-text assets too.
    expect(width).toBeGreaterThan(40);
    expect(width).toBeLessThan(200);
    expect(height).toBeGreaterThan(30);
    expect(height).toBeLessThan(90);
  });
});

describe("text interpolation", () => {
  it("renders {key} substituted with the variable's value", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.setVariables({ kills: { key: "kills", type: "number", value: "4", createdAt: "t" } });
    renderer.upsert(makeAsset({ type: "text", text: "Kills: {kills}" }));
    expect((root.firstElementChild as HTMLElement).textContent).toBe("Kills: 4");
  });

  it("re-renders on upsertVariable without needing the asset to be re-sent", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "text", text: "Kills: {kills}" }));
    expect((root.firstElementChild as HTMLElement).textContent).toBe("Kills: {kills}");
    renderer.upsertVariable({ key: "kills", type: "number", value: "7", createdAt: "t" });
    expect((root.firstElementChild as HTMLElement).textContent).toBe("Kills: 7");
  });

  it("reverts to the literal key on removeVariable", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.setVariables({ kills: { key: "kills", type: "number", value: "4", createdAt: "t" } });
    renderer.upsert(makeAsset({ type: "text", text: "Kills: {kills}" }));
    renderer.removeVariable("kills");
    expect((root.firstElementChild as HTMLElement).textContent).toBe("Kills: {kills}");
  });
});

describe("global volume (regression: playback going unresponsive during a volume drag)", () => {
  it("applies asset.volume * globalVolume to the media element", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video", volume: 0.8 }));
    renderer.setGlobalVolume(0.5, 1);
    const video = root.querySelector("video") as HTMLVideoElement;
    expect(video.volume).toBeCloseTo(0.4, 5);
  });

  it("clamps into [0, 1]", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video", volume: 1 }));
    renderer.setGlobalVolume(3, 1);
    const video = root.querySelector("video") as HTMLVideoElement;
    expect(video.volume).toBe(1);
  });

  it("ignores a stale/out-of-order seq (the jump-back-after-release bug)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video", volume: 1 }));
    renderer.setGlobalVolume(0.71, 100);
    renderer.setGlobalVolume(0.68, 5); // a delayed echo of an earlier, lower-seq tick
    const video = root.querySelector("video") as HTMLVideoElement;
    expect(video.volume).toBeCloseTo(0.71, 5);
  });

  it("never calls .play()/.pause() on a volume-only change (the playback-thrashing bug)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "video", paused: true }));
    const video = root.querySelector("video") as HTMLVideoElement;
    const playSpy = vi.spyOn(video, "play");
    const pauseSpy = vi.spyOn(video, "pause");
    renderer.setGlobalVolume(0.3, 1);
    renderer.setGlobalVolume(0.6, 2);
    renderer.setGlobalVolume(0.9, 3);
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("also applies to audio assets", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "audio", volume: 0.5 }));
    renderer.setGlobalVolume(0.5, 1);
    const audio = root.querySelector("audio") as HTMLAudioElement;
    expect(audio.volume).toBeCloseTo(0.25, 5);
  });
});

// Regression coverage for the loop bug: this connection is read-only (no
// session, blocked from asset:update server-side), so unlike control-ui it
// can never patch the server's stale asset.paused itself when a video/audio
// naturally ends -- it has to suppress the resulting auto-restart locally
// instead (see Entry.endedWhileNotLooping's doc comment in render.ts).
describe("media 'ended' event (loop-bug regression)", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  it("stops re-issuing .play() after a non-looping video ends, even though asset.paused still (incorrectly) says false", () => {
    const renderer = new Renderer(root, "assets.example.com");
    const asset = makeAsset({ type: "video", paused: false, loop: false });
    renderer.upsert(asset);
    const video = root.querySelector("video") as HTMLVideoElement;
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();

    video.dispatchEvent(new Event("ended"));
    // A subsequent resync (e.g. the periodic room:snapshot poll) re-delivers
    // the same stale asset -- this must not call .play() again.
    renderer.upsert({ ...asset });

    expect(playSpy).not.toHaveBeenCalled();
  });

  it("does not suppress when the asset is set to loop", () => {
    const renderer = new Renderer(root, "assets.example.com");
    const asset = makeAsset({ type: "video", paused: false, loop: true });
    renderer.upsert(asset);
    const video = root.querySelector("video") as HTMLVideoElement;
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();

    video.dispatchEvent(new Event("ended"));
    renderer.upsert({ ...asset });

    expect(playSpy).toHaveBeenCalled();
  });

  it("stops suppressing once the server's own state catches up with paused: true", () => {
    const renderer = new Renderer(root, "assets.example.com");
    const asset = makeAsset({ type: "video", paused: false, loop: false });
    renderer.upsert(asset);
    const video = root.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("ended"));

    // The corrected patch arrives (from some other, non-read-only
    // connection) -- paused: true, so this render just applies the pause,
    // no suppression needed or left behind.
    renderer.upsert({ ...asset, paused: true, seq: 2 });
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();

    // A later explicit resume (someone clicks Play again) must work normally.
    renderer.upsert({ ...asset, paused: false, seq: 3 });

    expect(playSpy).toHaveBeenCalled();
  });

  it("stop() clears the suppression so a later resume plays normally", () => {
    const renderer = new Renderer(root, "assets.example.com");
    const asset = makeAsset({ type: "video", paused: false, loop: false });
    renderer.upsert(asset);
    const video = root.querySelector("video") as HTMLVideoElement;
    video.dispatchEvent(new Event("ended"));

    renderer.stop("a1");
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    renderer.upsert({ ...asset, seq: 2 });

    expect(playSpy).toHaveBeenCalled();
  });

  it("also suppresses for a non-looping audio asset", () => {
    const renderer = new Renderer(root, "assets.example.com");
    const asset = makeAsset({ type: "audio", paused: false, loop: false });
    renderer.upsert(asset);
    const audio = root.querySelector("audio") as HTMLAudioElement;
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();

    audio.dispatchEvent(new Event("ended"));
    renderer.upsert({ ...asset });

    expect(playSpy).not.toHaveBeenCalled();
  });
});

describe("youtube asset", () => {
  function ytWrapper(): HTMLElement {
    return root.querySelector('[data-asset-type="youtube"]')!.firstElementChild as HTMLElement;
  }

  it("renders a fixed 1280x720 wrapper nested inside the positioned outer element, regardless of the asset's own box size", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", width: 320, height: 180, youtubeVideoId: "dQw4w9WgXcQ" }));
    const wrapper = ytWrapper();
    expect(wrapper.style.width).toBe("1280px");
    expect(wrapper.style.height).toBe("720px");
  });

  it("CSS-scales the wrapper non-uniformly to fit the rendered (interpolated) box -- snaps immediately on first appearance, nothing to interpolate from yet", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", width: 640, height: 180, youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(ytWrapper().style.transform).toBe("scale(0.5, 0.25)"); // 640/1280, 180/720
  });

  it("stop() does not throw for a youtube asset (player not necessarily ready yet)", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => renderer.stop("a1")).not.toThrow();
  });

  it("remove() destroys the youtube player controller without throwing", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => renderer.remove("a1")).not.toThrow();
    expect(root.children).toHaveLength(0);
  });

  it("setAssets removing a youtube asset destroys its controller without throwing", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.setAssets([makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" })]);
    expect(() => renderer.setAssets([])).not.toThrow();
  });

  it("setGlobalVolume does not throw for a youtube asset", () => {
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => renderer.setGlobalVolume(0.5, 1)).not.toThrow();
  });
});

describe("text asset layout", () => {
  it("uses white-space: pre with no word-break/overflow-hiding, matching control-ui's canvas.ts exactly", () => {
    // Regression: this app's text styling drifted out of sync with
    // canvas.ts's (pre-wrap + word-break + overflow:hidden, from before
    // text assets auto-sized themselves to fit their own content) --
    // since a text asset's stored width/height now comes from control-ui's
    // own unwrapped measurement, rendering it here with anything that
    // forces mid-word wrapping to fit that box made the same asset visibly
    // wrap differently (and look broken) in OBS versus the editor preview.
    const renderer = new Renderer(root, "assets.example.com");
    renderer.upsert(makeAsset({ type: "text", text: "hello" }));
    const el = root.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(el.style.whiteSpace).toBe("pre");
    expect(el.style.wordBreak).toBe("");
    expect(el.style.overflow).toBe("");
  });
});
