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
