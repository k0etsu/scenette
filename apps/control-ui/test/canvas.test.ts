// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function worldVisibility(container: HTMLElement): string {
  return (container.querySelector('[data-role="world"]') as HTMLElement).style.visibility;
}

// jsdom's getBoundingClientRect always returns all-zero -- this simulates
// the container actually being offset on the page (e.g. behind a sidebar
// and toolbar), the way it would be in a real browser.
function stubBoundingRect(el: HTMLElement, left: number, top: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
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

describe("keyboard delete", () => {
  it("deletes the selected asset on Delete", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(callbacks.onAssetDelete).toHaveBeenCalledWith("a1");
  });

  it("does NOT delete on Backspace -- that's the character-erase key used while typing in text fields", () => {
    // Regression: Backspace used to also delete the selected asset, so
    // backspacing text in the sidebar's name/text fields (or the canvas's
    // own inline text editor) while an asset was selected deleted the
    // asset instead of just erasing a character.
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));
    expect(callbacks.onAssetDelete).not.toHaveBeenCalled();
  });

  it("ignores Delete while focus is inside an input/textarea/contenteditable region", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset());
    canvas.selectAsset("a1");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(callbacks.onAssetDelete).not.toHaveBeenCalled();
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

describe("patchAsset -- text content debouncing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies text patches locally on every call but doesn't send until the debounce settles", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" });
    canvas.patchAsset("a1", { text: "he" });
    canvas.patchAsset("a1", { text: "hel" });

    // Local state reflects the very latest keystroke immediately.
    expect(canvas.get("a1")?.text).toBe("hel");
    // But nothing has gone over the wire yet -- still debouncing.
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    // Exactly one send, carrying the final text, once the debounce settles.
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", { text: "hel" }, expect.any(Number));
  });

  it("restarts the debounce window on every new keystroke", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" });
    vi.advanceTimersByTime(200);
    canvas.patchAsset("a1", { text: "he" });
    vi.advanceTimersByTime(200);

    // Never idle for a full debounce window, so still nothing sent.
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", { text: "he" }, expect.any(Number));
  });

  it("flushPendingTextPatch sends immediately and cancels the pending timer", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "hi" });
    canvas.flushPendingTextPatch("a1");
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", { text: "hi" }, expect.any(Number));

    vi.advanceTimersByTime(250);
    // Nothing further fires later -- the timer was actually cancelled, not
    // just raced by an earlier send.
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
  });

  it("flushPendingTextPatch is a no-op when nothing is pending", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));
    canvas.flushPendingTextPatch("a1");
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });

  it("non-text patches are unaffected and still send immediately", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "", hidden: false }));

    canvas.patchAsset("a1", { text: "typing..." });
    canvas.patchAsset("a1", { hidden: true });

    // The hidden toggle sends right away, independent of the still-pending
    // debounced text patch.
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", { hidden: true }, expect.any(Number));

    vi.advanceTimersByTime(250);
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("a1", { text: "typing..." }, expect.any(Number));
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

  it("hides the handles entirely for a text asset -- it sizes itself to fit its own content instead", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    canvas.selectAsset("t1");
    const handle = container.querySelector('[data-role="resize-handle"][data-corner="nw"]') as HTMLElement;
    expect(handle.style.display).toBe("none");
  });
});

describe("text assets size themselves to fit their content", () => {
  it("does not force an explicit width/height on the text element -- it shrink-wraps instead", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello", width: 200, height: 50 }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.style.width).toBe("");
    expect(div.style.height).toBe("");
  });

  it("does not force an explicit width/height on the outer (positioned/draggable) element either", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello", width: 200, height: 50 }));
    const el = container.querySelector('[data-asset-id="t1"]') as HTMLElement;
    expect(el.style.width).toBe("");
    expect(el.style.height).toBe("");
  });

  it("still applies an explicit width/height for every other asset type", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "i1", type: "image", width: 200, height: 50 }));
    const div = document.querySelector('[data-asset-type="image"]') as HTMLElement;
    expect(div.style.width).toBe("100%"); // fills `el`, which carries the actual px size
  });

  it("syncs the stored width/height to the measured content size once its natural size differs, via the normal resize path", () => {
    const { canvas, callbacks } = setup();
    // Starts with a stored size that's very unlikely to match jsdom's
    // actual (stubbed) layout box for "hi" -- see below.
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 999, height: 999 }));
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: 40, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: 30, configurable: true });

    canvas.patchAsset("t1", { fontSize: 32 });

    expect(callbacks.onAssetResize).toHaveBeenCalledWith("t1", 0, 0, 40, 30, expect.any(Number));
    expect(canvas.get("t1")).toMatchObject({ width: 40, height: 30 });
  });

  it("does not re-trigger a resize when the measured size hasn't actually changed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: 40, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: 30, configurable: true });

    canvas.patchAsset("t1", { fontSize: 32 });

    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
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

describe("double-click to edit text inline", () => {
  it("makes the text element contentEditable on double-click", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.contentEditable).not.toBe("true");
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(div.contentEditable).toBe("true");
  });

  it("updates the local asset immediately on every input event, but debounces the network send", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));

    expect(canvas.get("t1")?.text).toBe("edited");
    // Not sent yet -- still debouncing (see patchAsset's TEXT_PATCH_DEBOUNCE_MS).
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
    // Still mid-edit -- blur (not this input event) is what ends editing.
    expect(div.contentEditable).toBe("true");
  });

  it("patches a multi-line edit as a single string with real newline characters preserved, once the debounce flushes", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    // Simulates the result of onKeyDown's execCommand("insertText", ...,
    // "\n") -- a literal newline character in the text node, not a <br>/
    // <div> boundary.
    div.textContent = "hellow\nthere\nwhy isn't this working";
    div.dispatchEvent(new Event("input"));
    div.dispatchEvent(new FocusEvent("blur")); // flush the debounced send

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      { text: "hellow\nthere\nwhy isn't this working" },
      expect.any(Number)
    );
  });

  it("does not send a patch on an input event where the text didn't actually change", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.dispatchEvent(new Event("input"));
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });

  it("blur flushes the still-pending debounced patch exactly once", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled(); // still debouncing

    div.dispatchEvent(new FocusEvent("blur"));
    expect(div.contentEditable).not.toBe("true");
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("t1", { text: "edited" }, expect.any(Number));
  });

  it("Escape blurs to end editing without reverting the (already-saved) text", () => {
    // Regression: previously reverted to the pre-edit text on Escape, back
    // when edits only committed on blur/Enter -- now that every keystroke
    // already patches (debounced) in real time, there's nothing to revert
    // to; Escape just ends the editing session by calling .blur(), same as
    // clicking away does.
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));
    vi.mocked(callbacks.onAssetPatch).mockClear();

    const blurSpy = vi.spyOn(div, "blur");
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(blurSpy).toHaveBeenCalled();
    expect(div.textContent).toBe("edited");
    expect(canvas.get("t1")?.text).toBe("edited");
  });

  it("Enter inserts a literal newline character rather than committing/blurring or letting the browser insert a <div>/<br>", () => {
    // Regression: a plain contentEditable div's *default* Enter behavior
    // inserts a new element boundary (<div>/<br>), not a "\n" text node --
    // content.textContent (what onInput patches, and what every other
    // consumer of asset.text reads) just concatenates text nodes with no
    // regard for element boundaries, so lines typed that way rendered fine
    // in this specific live DOM but silently lost their line breaks the
    // instant the text left it (sidebar, browser-source, collaborators).
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    // Collapse the (select-all-on-open) selection to just after "hello" so
    // the inserted newline lands at the end, not replacing the selection.
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // jsdom has no execCommand at all -- stub it to do what a real
    // browser's "insertText" actually does (splice the given string into
    // the current selection, then fire a real "input" event, same as any
    // other edit), so this test exercises the same input->onInput->patch
    // path production code relies on rather than special-casing Enter.
    document.execCommand = vi.fn((command: string, _ui: boolean, value: string) => {
      if (command === "insertText") {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const insertRange = sel.getRangeAt(0);
          insertRange.deleteContents();
          const node = document.createTextNode(value);
          insertRange.insertNode(node);
          insertRange.setStartAfter(node);
          insertRange.setEndAfter(node);
          sel.removeAllRanges();
          sel.addRange(insertRange);
        }
        div.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    });

    const blurSpy = vi.spyOn(div, "blur");
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    div.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "\n");
    expect(div.textContent).toBe("hello\n");
    // Applied locally right away; the network send is still debounced since
    // this didn't blur.
    expect(canvas.get("t1")?.text).toBe("hello\n");
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
    expect(div.contentEditable).toBe("true");
  });

  it("does not start a canvas drag from a mousedown while the text is being edited", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    vi.mocked(callbacks.onSelectionChange).mockClear();
    div.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    // A drag-starting mousedown always fires onSelectionChange on first
    // selection -- since the asset was already selected by upsert/dblclick
    // in this flow, the clean check is just that no new drag state broke
    // anything: moving the mouse must not move the (still-being-edited) asset.
    window.dispatchEvent(new MouseEvent("mousemove", { movementX: 50, movementY: 50 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(callbacks.onAssetMove).not.toHaveBeenCalled();
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

  it("hides the world until the first centering pass completes, so the pan:0/zoom:1 default transform is never actually painted", async () => {
    // Regression: the world painted at the default top-left transform for
    // one frame before the deferred centering pass repositioned it, which
    // showed up as a visible top-left-then-jump-to-center flash on every
    // page load/refresh.
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);
    expect(worldVisibility(container)).toBe("hidden");

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    expect(worldVisibility(container)).toBe("hidden");
    await flushFrame();
    expect(worldVisibility(container)).toBe("visible");
  });

  it("still reveals the world (rather than leaving it stuck hidden) when the container has no laid-out size yet", async () => {
    const { canvas, container } = setup();
    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1920, height: 1080 });
    await flushFrame();
    expect(worldVisibility(container)).toBe("visible");
  });
});

describe("right-click context menu", () => {
  it("reports the click in viewport (page) coordinates, not container-relative ones, for #context-menu's own position:fixed CSS", () => {
    // Regression: the container-relative screenX/screenY computed for the
    // world-space math (screenToWorld, defined in the container's own
    // local coordinate space) were also passed straight through as the
    // menu's on-page position -- but #context-menu is position: fixed,
    // which is positioned against the viewport, not this container. That
    // made the menu render offset from the actual click by exactly the
    // container's own on-page position (the sidebar's width, the
    // toolbar's height).
    const onContextMenu = vi.fn();
    const { container } = setup({ onContextMenu });
    stubBoundingRect(container, 280, 48);

    container.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 500, clientY: 400 })
    );

    expect(onContextMenu).toHaveBeenCalledWith(220, 352, 500, 400);
  });
});

describe("onViewportTransformChanged / getViewportScreenRect", () => {
  it("does not fire during construction -- that transform is the pre-centering default and was never meant to be observed", () => {
    // Regression: this used to fire synchronously during construction with
    // the uncentered pan:0/zoom:1 rect, before the deferred first
    // centerOnViewport() pass (see setViewport() below) had run. The
    // stream-preview panel applies whatever rect it's given immediately, so
    // that premature callback positioned its always-on-top boundary at the
    // top-left corner for a frame before centering moved it -- visible as a
    // flash on every page load, even though this.world itself was already
    // correctly hidden until centering completed.
    const onViewportTransformChanged = vi.fn();
    setup({ onViewportTransformChanged });
    expect(onViewportTransformChanged).not.toHaveBeenCalled();
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
