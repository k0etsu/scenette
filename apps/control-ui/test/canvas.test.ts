// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@scenette/protocol";
import { CanvasView, CanvasCallbacks } from "../src/canvas";

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
    // Kept true in every test asset unless a test specifically cares about
    // paused/play transitions -- jsdom's HTMLMediaElement.play() rejects
    // with a "not implemented" error, and only the paused(false)-while-
    // media.paused(true) branch calls it.
    paused: true,
    seq: 1,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    keep: false,
    ...overrides,
  };
}

function makeCallbacks(overrides: Partial<CanvasCallbacks> = {}): CanvasCallbacks {
  return {
    onAssetMove: vi.fn(),
    onAssetResize: vi.fn(),
    onAssetPatch: vi.fn(),
    onAssetDelete: vi.fn(),
    onContextMenu: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides,
  };
}

function setup(callbackOverrides: Partial<CanvasCallbacks> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const callbacks = makeCallbacks(callbackOverrides);
  const canvas = new CanvasView(container, callbacks, "assets.example.com");
  return { container, callbacks, canvas };
}

// jsdom never lays elements out, so clientWidth/clientHeight are always 0
// unless stubbed -- this simulates the container actually having on-screen
// size, the way it would in a real browser.
function stubClientSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
}

function worldTransform(container: HTMLElement): string {
  return (container.querySelector('[data-role="world"]') as HTMLElement).style.transform;
}

// The initial center-on-load is deferred to the next animation frame (see
// canvas.ts) so the forced clientWidth read doesn't block the page's first
// paint -- tests need to let that frame run before asserting the result.
function flushFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("dispose", () => {
  it("stops responding to window mouseup after dispose (no leaked listener on a room switch)", () => {
    const { canvas, callbacks, container } = setup();
    canvas.upsert(makeAsset({ assetId: "a1", x: 0, y: 0 }));
    canvas.selectAsset("a1");

    // Start a drag via a container mousedown, then dispose mid-gesture --
    // simulates switching rooms while a drag was in flight.
    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
    canvas.dispose();
    vi.mocked(callbacks.onAssetMove).mockClear();

    // Regression: previously this window listener was bound with an
    // inline closure canvas.dispose() had no reference to, so it kept
    // firing (and, worse, accumulated a second copy) after a second
    // CanvasView was constructed on the same container.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(callbacks.onAssetMove).not.toHaveBeenCalled();
  });

  it("clears the container so a second CanvasView on it starts clean", () => {
    const { canvas, container } = setup();
    expect(container.querySelectorAll('[data-role="world"]')).toHaveLength(1);
    canvas.dispose();
    expect(container.children).toHaveLength(0);
  });

  it("a second CanvasView constructed after dispose doesn't double-fire on window events", () => {
    const { canvas: first, callbacks: firstCallbacks, container } = setup();
    first.dispose();

    const secondCallbacks = makeCallbacks();
    new CanvasView(container, secondCallbacks, "assets.example.com");

    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0, button: 1 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }));

    // Only the second (still-live) instance's callbacks should ever have a
    // chance to fire -- the first was disposed, so its onContextMenu et al.
    // must never be invoked again regardless of what happens on `window`.
    expect(firstCallbacks.onContextMenu).not.toHaveBeenCalled();
  });
});

describe("nextSeq", () => {
  it("is strictly increasing across calls", () => {
    const { canvas } = setup();
    const a = canvas.nextSeq();
    const b = canvas.nextSeq();
    const c = canvas.nextSeq();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe("selectAsset", () => {
  it("fires onSelectionChange with the new id", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");
    expect(callbacks.onSelectionChange).toHaveBeenCalledWith("a1");
    expect(canvas.getSelectedAssetId()).toBe("a1");
  });

  it("does not fire again when selecting the already-selected id", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");
    vi.mocked(callbacks.onSelectionChange).mockClear();
    canvas.selectAsset("a1");
    expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
  });
});

describe("setAssets / upsert / get / getAllAssets", () => {
  it("adds every asset in the list", () => {
    const { canvas } = setup();
    canvas.setAssets([makeAsset({ assetId: "a1" }), makeAsset({ assetId: "a2" })]);
    expect(canvas.getAllAssets().map((a) => a.assetId).sort()).toEqual(["a1", "a2"]);
  });

  it("removes assets that are no longer present on a subsequent setAssets call", () => {
    const { canvas } = setup();
    canvas.setAssets([makeAsset({ assetId: "a1" }), makeAsset({ assetId: "a2" })]);
    canvas.setAssets([makeAsset({ assetId: "a1" })]);
    expect(canvas.getAllAssets().map((a) => a.assetId)).toEqual(["a1"]);
    expect(canvas.get("a2")).toBeUndefined();
  });

  it("upsert overwrites an existing asset's fields", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ x: 10 }));
    canvas.upsert(makeAsset({ x: 20 }));
    expect(canvas.get("a1")?.x).toBe(20);
  });
});

describe("applyRemoteMove / applyRemoteResize / applyRemoteUpdate (seq guard)", () => {
  it("applies a move with a newer seq", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ x: 0, y: 0, seq: 5 }));
    canvas.applyRemoteMove("a1", 50, 60, 0, true, 10);
    expect(canvas.get("a1")).toMatchObject({ x: 50, y: 60, seq: 10 });
  });

  it("drops a move whose seq is older than what's already applied", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ x: 0, y: 0, seq: 10 }));
    canvas.applyRemoteMove("a1", 999, 999, 0, true, 5);
    // Position/seq unchanged -- the stale update never applied.
    expect(canvas.get("a1")).toMatchObject({ x: 0, y: 0, seq: 10 });
  });

  it("drops a resize whose seq is older than what's already applied", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ width: 100, height: 100, seq: 10 }));
    canvas.applyRemoteResize("a1", 0, 0, 5, 5, true, 5);
    expect(canvas.get("a1")).toMatchObject({ width: 100, height: 100, seq: 10 });
  });

  it("applies a resize with a newer seq", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ width: 100, height: 100, seq: 5 }));
    canvas.applyRemoteResize("a1", 1, 2, 30, 40, true, 10);
    expect(canvas.get("a1")).toMatchObject({ x: 1, y: 2, width: 30, height: 40, seq: 10 });
  });

  it("drops a patch whose seq is older than what's already applied", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ opacity: 1, seq: 10 }));
    canvas.applyRemoteUpdate("a1", { opacity: 0.2 }, true, 5);
    expect(canvas.get("a1")).toMatchObject({ opacity: 1, seq: 10 });
  });

  it("applies a patch with a newer seq", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ opacity: 1, seq: 5 }));
    canvas.applyRemoteUpdate("a1", { opacity: 0.2 }, true, 10);
    expect(canvas.get("a1")).toMatchObject({ opacity: 0.2, seq: 10 });
  });

  it("ignores an unknown assetId without throwing", () => {
    const { canvas } = setup();
    expect(() => canvas.applyRemoteMove("missing", 1, 1, 0, true, 1)).not.toThrow();
    expect(() => canvas.applyRemoteResize("missing", 1, 1, 1, 1, true, 1)).not.toThrow();
    expect(() => canvas.applyRemoteUpdate("missing", {}, true, 1)).not.toThrow();
  });
});

describe("setAssetPosition / setAssetSize / patchAsset", () => {
  it("setAssetPosition applies optimistically and calls onAssetMove with a fresh seq", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ seq: 1 }));
    canvas.setAssetPosition("a1", 111, 222);
    expect(canvas.get("a1")).toMatchObject({ x: 111, y: 222 });
    expect(callbacks.onAssetMove).toHaveBeenCalledWith("a1", 111, 222, expect.any(Number));
    const seqArg = vi.mocked(callbacks.onAssetMove).mock.calls[0][3];
    expect(seqArg).toBeGreaterThan(1);
  });

  it("setAssetSize clamps below the minimum asset size", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.setAssetSize("a1", 5, 5);
    expect(canvas.get("a1")).toMatchObject({ width: 20, height: 20 });
    expect(callbacks.onAssetResize).toHaveBeenCalledWith("a1", expect.any(Number), expect.any(Number), 20, 20, expect.any(Number));
  });

  it("patchAsset merges the patch and calls onAssetPatch", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ hidden: false }));
    canvas.patchAsset("a1", { hidden: true });
    expect(canvas.get("a1")?.hidden).toBe(true);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", { hidden: true }, expect.any(Number));
  });

  it("does nothing for an unknown assetId", () => {
    const { canvas, callbacks } = setup();
    canvas.setAssetPosition("missing", 1, 1);
    canvas.setAssetSize("missing", 1, 1);
    canvas.patchAsset("missing", { hidden: true });
    expect(callbacks.onAssetMove).not.toHaveBeenCalled();
    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("clears selection and fires onSelectionChange(undefined) when the selected asset is removed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");
    vi.mocked(callbacks.onSelectionChange).mockClear();
    canvas.remove("a1");
    expect(canvas.getSelectedAssetId()).toBeUndefined();
    expect(callbacks.onSelectionChange).toHaveBeenCalledWith(undefined);
    expect(canvas.get("a1")).toBeUndefined();
  });

  it("does not touch selection when removing a different, unselected asset", () => {
    const { canvas, callbacks } = setup();
    canvas.setAssets([makeAsset({ assetId: "a1" }), makeAsset({ assetId: "a2" })]);
    canvas.selectAsset("a1");
    vi.mocked(callbacks.onSelectionChange).mockClear();
    canvas.remove("a2");
    expect(canvas.getSelectedAssetId()).toBe("a1");
    expect(callbacks.onSelectionChange).not.toHaveBeenCalled();
  });
});

describe("selection handles rotate with the asset", () => {
  it("tracks the asset's actual rotated corners, not an axis-aligned bounding box", () => {
    const { canvas, container } = setup();
    // A 50x50 square centered at (125, 125), rotated 90 degrees -- maps
    // onto itself with corner labels shifted a quarter-turn.
    canvas.upsert(makeAsset({ x: 100, y: 100, width: 50, height: 50, rotation: 90 }));
    canvas.selectAsset("a1");

    const handle = (corner: string) =>
      container.querySelector(`[data-role="resize-handle"][data-corner="${corner}"]`) as HTMLElement;

    expect(parseFloat(handle("nw").style.left)).toBeCloseTo(150, 5);
    expect(parseFloat(handle("nw").style.top)).toBeCloseTo(100, 5);
    expect(parseFloat(handle("ne").style.left)).toBeCloseTo(150, 5);
    expect(parseFloat(handle("ne").style.top)).toBeCloseTo(150, 5);
    expect(parseFloat(handle("sw").style.left)).toBeCloseTo(100, 5);
    expect(parseFloat(handle("sw").style.top)).toBeCloseTo(100, 5);
    expect(parseFloat(handle("se").style.left)).toBeCloseTo(100, 5);
    expect(parseFloat(handle("se").style.top)).toBeCloseTo(150, 5);
  });

  it("hides the handles entirely for a locked asset", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ locked: true }));
    canvas.selectAsset("a1");
    const handle = container.querySelector('[data-role="resize-handle"][data-corner="nw"]') as HTMLElement;
    expect(handle.style.display).toBe("none");
  });
});

describe("volume multipliers", () => {
  it("applies asset volume * global * local to a video's actual element volume", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", volume: 0.8 }));
    canvas.setVolumeMultipliers(0.5, 0.5);
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.volume).toBeCloseTo(0.2, 5); // 0.8 * 0.5 * 0.5
  });

  it("clamps the effective volume into [0, 1]", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", volume: 1 }));
    canvas.setVolumeMultipliers(2, 2); // would be 4 without clamping
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.volume).toBe(1);
  });

  it("never touches a video's paused state when only volume changes", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: true }));
    const video = document.querySelector('video') as HTMLVideoElement;
    const playSpy = vi.spyOn(video, "play");
    canvas.setVolumeMultipliers(0.3, 1);
    canvas.setVolumeMultipliers(0.6, 1);
    canvas.setVolumeMultipliers(0.9, 1);
    expect(playSpy).not.toHaveBeenCalled();
  });
});

describe("variable interpolation in text assets", () => {
  it("renders {key} as the variable's value", () => {
    const { canvas } = setup();
    canvas.setVariables({ kills: { key: "kills", type: "number", value: "4", createdAt: "t" } });
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "Kills: {kills}" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.textContent).toBe("Kills: 4");
  });

  it("re-renders already-placed text assets when a variable is upserted", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "Kills: {kills}" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.textContent).toBe("Kills: {kills}");
    canvas.upsertVariable({ key: "kills", type: "number", value: "7", createdAt: "t" });
    expect(div.textContent).toBe("Kills: 7");
  });

  it("reverts to the literal {key} once the variable is removed", () => {
    const { canvas } = setup();
    canvas.setVariables({ kills: { key: "kills", type: "number", value: "4", createdAt: "t" } });
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "Kills: {kills}" }));
    canvas.removeVariable("kills");
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.textContent).toBe("Kills: {kills}");
  });
});

describe("setViewport auto-centering", () => {
  it("centers the viewport rect on first load, leaving ~15% margin on each side", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    // Width-constrained: 2000 * 0.7 / 1400 = 1 (vs. height's 1200/1000 =
    // 1.2), so zoom follows the width margin.
    expect(worldTransform(container)).toBe("translate(300px, 100px) scale(1)");
  });

  it("fits within the container's height when the viewport is tall relative to width", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 3000, 500);

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    // Height-constrained here: 500/1000 = 0.5 vs width's 3000*0.7/1400 =
    // 1.5 -- zoom must follow the smaller (height) value so the rect never
    // overflows the container vertically.
    expect(worldTransform(container)).toBe("translate(1150px, 0px) scale(0.5)");
  });

  it("does not re-center on a later setViewport call within the same instance (e.g. a manual resync)", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);
    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();
    const afterFirstLoad = worldTransform(container);

    // Simulate the container being resized and a second snapshot arriving
    // (e.g. the connected-users panel's refresh button) -- the user's
    // pan/zoom should be left exactly as it was.
    stubClientSize(container, 500, 300);
    canvas.setViewport({ roomId: "room1", x: 100, y: 100, width: 800, height: 600 });
    await flushFrame();

    expect(worldTransform(container)).toBe(afterFirstLoad);
  });

  it("leaves the default pan/zoom when the container has no laid-out size yet", async () => {
    const { canvas, container } = setup();
    // No stubClientSize call -- jsdom reports 0x0, same as an element that
    // hasn't been laid out (e.g. behind display:none) at the moment this fires.
    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1920, height: 1080 });
    await flushFrame();
    expect(worldTransform(container)).toBe("translate(0px, 0px) scale(1)");
  });

  it("defers the geometry read to the next frame instead of forcing a synchronous layout", () => {
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);

    // Regression: this used to run synchronously inside setViewport, right
    // as the app view was switching from display:none to visible -- a
    // forced reflow that blocked the initial paint. Immediately after the
    // call returns, nothing should have been computed yet.
    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    expect(worldTransform(container)).toBe("translate(0px, 0px) scale(1)");
  });
});

describe("onViewportTransformChanged / getViewportScreenRect", () => {
  it("fires once synchronously during construction, before any setViewport call", () => {
    const onViewportTransformChanged = vi.fn();
    setup({ onViewportTransformChanged });
    // Default pan (0,0) / zoom 1 / default 1920x1080 viewport.
    expect(onViewportTransformChanged).toHaveBeenCalledWith({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("getViewportScreenRect reflects the current pan/zoom applied to the viewport rect", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);
    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    // From the auto-centering test: zoom 1, pan (300, 100).
    expect(canvas.getViewportScreenRect()).toEqual({ left: 300, top: 100, width: 1400, height: 1000 });
  });

  it("fires again with the updated rect after auto-centering completes", async () => {
    const onViewportTransformChanged = vi.fn();
    const { canvas, container } = setup({ onViewportTransformChanged });
    stubClientSize(container, 2000, 1200);
    onViewportTransformChanged.mockClear();

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    expect(onViewportTransformChanged).toHaveBeenCalledWith({ left: 300, top: 100, width: 1400, height: 1000 });
  });
});
