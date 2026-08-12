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
    onAssetStop: vi.fn(),
    onAssetSeek: vi.fn(),
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

  it("removes the media-controls widget too -- it lives outside `container`, so wiping container's innerHTML alone wouldn't reach it", () => {
    const { canvas, container } = setup();
    expect(container.parentElement!.querySelector('[data-role="media-controls"]')).not.toBeNull();
    canvas.dispose();
    expect(container.parentElement!.querySelector('[data-role="media-controls"]')).toBeNull();
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

describe("setAssets -- guarded reconciliation (regression: periodic/manual full-state resync)", () => {
  it("ignores an incoming entry whose seq is older than what's already applied", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ x: 0, y: 0, seq: 10 }));
    canvas.setAssets([makeAsset({ x: 999, y: 999, seq: 5 })]);
    expect(canvas.get("a1")).toMatchObject({ x: 0, y: 0, seq: 10 });
  });

  it("applies an incoming entry whose seq is newer (or equal) to what's already applied", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ x: 0, y: 0, seq: 5 }));
    canvas.setAssets([makeAsset({ x: 50, y: 60, seq: 10 })]);
    expect(canvas.get("a1")).toMatchObject({ x: 50, y: 60, seq: 10 });
  });

  it("always adds a brand-new assetId regardless of seq -- nothing local to protect", () => {
    const { canvas } = setup();
    canvas.setAssets([makeAsset({ assetId: "a1", seq: 1 })]);
    expect(canvas.get("a1")).toMatchObject({ seq: 1 });
  });

  it("skips an asset currently being dragged, even if the incoming seq is newer", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ x: 0, y: 0, seq: 5 }));
    const el = container.querySelector('[data-asset-id="a1"]') as HTMLElement;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    canvas.setAssets([makeAsset({ x: 999, y: 999, seq: 999 })]);

    expect(canvas.get("a1")).toMatchObject({ x: 0, y: 0, seq: 5 });
  });

  it("skips an asset currently being resized, even if the incoming seq is newer", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ width: 100, height: 100, seq: 5 }));
    canvas.selectAsset("a1");
    const handle = container.querySelector('[data-role="resize-handle"][data-corner="nw"]') as HTMLElement;
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    canvas.setAssets([makeAsset({ width: 5, height: 5, seq: 999 })]);

    expect(canvas.get("a1")).toMatchObject({ width: 100, height: 100, seq: 5 });
  });

  it("skips an asset currently being inline-text-edited, even if the incoming seq is newer", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello", seq: 5 }));
    const div = container.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    canvas.setAssets([makeAsset({ assetId: "t1", type: "text", text: "reverted!", seq: 999 })]);

    expect(canvas.get("t1")?.text).toBe("hello");
  });

  it("resumes accepting resync entries for that asset once inline editing ends (blur)", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello", seq: 5 }));
    const div = container.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.dispatchEvent(new FocusEvent("blur"));

    canvas.setAssets([makeAsset({ assetId: "t1", type: "text", text: "synced", seq: 999 })]);

    expect(canvas.get("t1")?.text).toBe("synced");
  });

  it("still removes an asset absent from the incoming list even though the guard skipped applying it", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "a1", x: 0, y: 0, seq: 5 }));
    const el = container.querySelector('[data-asset-id="a1"]') as HTMLElement;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));

    // a1 isn't in this snapshot at all -- the drag guard only protects
    // against *overwriting* it with stale data, not against a legitimate
    // deletion, so removal still proceeds independent of the guard above.
    canvas.setAssets([]);

    expect(canvas.get("a1")).toBeUndefined();
  });
});

describe("text variable interpolation", () => {
  const v = (key: string, value: string) => ({ key, type: "number" as const, value, createdAt: "t" });

  it("shows the interpolated value when not editing", () => {
    const { canvas, container } = setup();
    canvas.setVariables({ kills: v("kills", "5") });
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "kills: {kills}", seq: 5 }));
    const div = container.querySelector('[data-asset-type="text"]') as HTMLElement;
    expect(div.textContent).toBe("kills: 5");
  });

  it("keeps the raw {variable} template while inline-editing, even as variables change (reapplyText guard)", () => {
    const { canvas, container } = setup();
    canvas.setVariables({ kills: v("kills", "5") });
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "kills: {kills}", seq: 5 }));
    const div = container.querySelector('[data-asset-type="text"]') as HTMLElement;

    // Double-click to edit -> the editor shows the raw template, not "kills: 5".
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(div.textContent).toBe("kills: {kills}");

    // A variable change (or the periodic room:snapshot resync, which calls
    // setVariables) must NOT clobber the in-edit template with the value.
    canvas.setVariables({ kills: v("kills", "9") });
    expect(div.textContent).toBe("kills: {kills}");
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

describe("patchAsset -- text edits: throttled send + full-object patch", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends every patchable field's current value, not just the text field that changed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "hello", hidden: true, opacity: 0.5, fontSize: 24 }));

    canvas.patchAsset("a1", { text: "hello!" });

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    const [, sentPatch] = vi.mocked(callbacks.onAssetPatch).mock.calls[0];
    expect(sentPatch).toMatchObject({ text: "hello!", hidden: true, opacity: 0.5, fontSize: 24 });
  });

  it("sends the very first text patch immediately (leading edge)", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" });

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("a1", expect.objectContaining({ text: "h" }), expect.any(Number));
  });

  it("coalesces keystrokes within the throttle window into a single trailing send carrying the latest text", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" }); // leading send at t=0
    now = 30;
    canvas.patchAsset("a1", { text: "he" }); // within the window -- schedules a trailing send
    now = 60;
    canvas.patchAsset("a1", { text: "hel" }); // still within the window -- no additional timer

    // Local state already reflects every keystroke; only the leading send
    // has gone over the wire so far.
    expect(canvas.get("a1")?.text).toBe("hel");
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("a1", expect.objectContaining({ text: "hel" }), expect.any(Number));
  });

  it("sends immediately again once the throttle window has fully elapsed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" });
    now = 150;
    canvas.patchAsset("a1", { text: "he" });

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
  });

  it("flushPendingTextPatch sends immediately and cancels the trailing timer", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));

    canvas.patchAsset("a1", { text: "h" });
    now = 30;
    canvas.patchAsset("a1", { text: "he" }); // schedules a trailing send

    canvas.flushPendingTextPatch("a1");
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("a1", expect.objectContaining({ text: "he" }), expect.any(Number));

    vi.advanceTimersByTime(200);
    // Nothing further fires later -- the timer was actually cancelled, not
    // just raced by the earlier flush.
    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
  });

  it("flushPendingTextPatch is a no-op when nothing is pending", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "" }));
    canvas.flushPendingTextPatch("a1");
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });

  it("a non-text patch still sends only the fields it actually changed, and isn't subject to the text throttle", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ type: "text", text: "hello", hidden: false, width: 100, height: 100 }));
    // Matches the stored size (jsdom's real offsetWidth/Height default to 0
    // otherwise) so patchAsset's own text-auto-fit re-measurement is a
    // no-op here, same as it would be in a real browser where nothing
    // text/font-related changed -- this test is about the hidden/locked
    // fields specifically, not auto-fit.
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: 100, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: 100, configurable: true });

    canvas.patchAsset("a1", { hidden: true });
    now = 10;
    canvas.patchAsset("a1", { locked: true });

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(2);
    expect(callbacks.onAssetPatch).toHaveBeenNthCalledWith(1, "a1", { hidden: true }, expect.any(Number));
    expect(callbacks.onAssetPatch).toHaveBeenNthCalledWith(2, "a1", { locked: true }, expect.any(Number));
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

  it("syncs the stored width/height to the measured content size once its natural size differs, folded into the same patch (not a separate resize message)", () => {
    const { canvas, callbacks } = setup();
    // Starts with a stored size that's very unlikely to match jsdom's
    // actual (stubbed) layout box for "hi" -- see below.
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 999, height: 999 }));
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: 40, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: 30, configurable: true });

    canvas.patchAsset("t1", { fontSize: 32 });

    // Regression: this used to be a separate asset:resize message with its
    // own seq -- two messages sharing one seq-gated conditional write per
    // asset (roomState.ts) with no ordering guarantee across their own
    // Lambda invocations meant EITHER message could lose a race against the
    // other regardless of which was sent/generated "later". Folding the
    // corrected size into the SAME patch/seq as the font change that caused
    // it removes the race entirely -- see AssetPatch's own doc comment.
    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ fontSize: 32, width: 40, height: 30 }),
      expect.any(Number)
    );
    expect(canvas.get("t1")).toMatchObject({ width: 40, height: 30 });
  });

  it("does not fold width/height into the patch when the measured size hasn't actually changed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: 40, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: 30, configurable: true });

    canvas.patchAsset("t1", { fontSize: 32 });

    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("t1", { fontSize: 32 }, expect.any(Number));
  });
});

describe("text asset auto-resize during active typing is folded into the same patch, not a separate resize message (regression)", () => {
  // Every asset:move/resize/update shares one seq-gated conditional write
  // server-side (roomState.ts). A separate asset:resize message -- whether
  // sent immediately, deferred to the text throttle's flush, or ordered
  // before/after the text patch it accompanied -- always had a DIFFERENT
  // seq than that patch, and no ordering guarantee exists between two
  // separate WebSocket messages' own Lambda invocations. Whichever message
  // ended up with the "earlier" seq could lose a race against the other
  // and get silently rejected as stale, permanently losing either the size
  // correction (box never grows in browser-source/other collaborators) or,
  // worse, the edit itself (a font change silently reverting). Folding the
  // size correction into the exact same patch/seq as whatever caused it is
  // the only way to remove the race for real -- see canvas.ts's
  // measureTextAutoFit/AssetPatch's own doc comments for the full history.
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stubMeasuredSize(width: number, height: number): void {
    const content = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    Object.defineProperty(content, "offsetWidth", { value: width, configurable: true });
    Object.defineProperty(content, "offsetHeight", { value: height, configurable: true });
  }

  it("does not send anything for a keystroke within the throttle window", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(40, 30);
    canvas.patchAsset("t1", { text: "hi" }); // leading send, t=0 -- no size change yet
    vi.mocked(callbacks.onAssetPatch).mockClear();

    now = 30;
    stubMeasuredSize(90, 30); // grows on this keystroke
    canvas.patchAsset("t1", { text: "hi there" }); // within the window -- deferred

    // Applied locally right away...
    expect(canvas.get("t1")).toMatchObject({ width: 90, height: 30 });
    // ...but not sent -- still within the text throttle window.
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
  });

  it("sends the corrected width/height as part of the same text patch once the throttle flushes", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(40, 30);
    canvas.patchAsset("t1", { text: "hi" });
    vi.mocked(callbacks.onAssetPatch).mockClear();

    now = 30;
    stubMeasuredSize(90, 30);
    canvas.patchAsset("t1", { text: "hi there" });

    vi.advanceTimersByTime(100); // past the trailing send's own window

    expect(callbacks.onAssetPatch).toHaveBeenCalledTimes(1);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ text: "hi there", width: 90, height: 30 }),
      expect.any(Number)
    );
    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
  });

  it("flushPendingTextPatch (blur) also flushes the corrected size immediately, in the same patch", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(40, 30);
    canvas.patchAsset("t1", { text: "hi" });
    vi.mocked(callbacks.onAssetPatch).mockClear();

    now = 30;
    stubMeasuredSize(90, 30);
    canvas.patchAsset("t1", { text: "hi there" });

    canvas.flushPendingTextPatch("t1");

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ text: "hi there", width: 90, height: 30 }),
      expect.any(Number)
    );
  });

  it("re-measures right before the flush, not just whatever was last measured mid-keystroke", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(40, 30);
    canvas.patchAsset("t1", { text: "hi" });
    vi.mocked(callbacks.onAssetPatch).mockClear();

    now = 30;
    stubMeasuredSize(90, 30);
    canvas.patchAsset("t1", { text: "hi there" });
    // Content grows further after the last patchAsset call but before the
    // throttle actually flushes (e.g. a re-render or late DOM settling) --
    // sendFullTextPatch's own re-measure should pick this up too.
    stubMeasuredSize(150, 30);

    vi.advanceTimersByTime(100);

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ width: 150, height: 30 }),
      expect.any(Number)
    );
  });

  it("does not include width/height in the patch when the measured size never actually changed", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(40, 30);
    canvas.patchAsset("t1", { text: "hi" });
    vi.mocked(callbacks.onAssetPatch).mockClear();

    now = 30;
    canvas.patchAsset("t1", { text: "hi!" }); // measured size still 40x30 -- unchanged

    vi.advanceTimersByTime(100);

    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("t1", expect.objectContaining({ text: "hi!" }), expect.any(Number));
    const [, sentPatch] = vi.mocked(callbacks.onAssetPatch).mock.calls[0];
    expect(sentPatch).toMatchObject({ width: 40, height: 30 }); // fullAssetPatch always includes current (unchanged) size
  });

  it("a font-size change (not text) folds the corrected size into the same patch and sends immediately, unaffected by the text throttle", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hi", width: 40, height: 30 }));
    stubMeasuredSize(60, 45);

    canvas.patchAsset("t1", { fontSize: 32 });

    expect(callbacks.onAssetResize).not.toHaveBeenCalled();
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ fontSize: 32, width: 60, height: 45 }),
      expect.any(Number)
    );
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

  it("applies the same multipliers to an audio asset's real (hidden) <audio> element", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "au1", type: "audio", volume: 0.8 }));
    canvas.setVolumeMultipliers(0.5, 0.5);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio.volume).toBeCloseTo(0.2, 5); // 0.8 * 0.5 * 0.5
  });
});

describe("patchAsset -- volume-only video patches bypass syncMediaState (regression)", () => {
  // jsdom's HTMLMediaElement.play() returns undefined, not a real Promise --
  // syncMediaState's .then()/.catch() chain on it throws unless stubbed.
  // Stubbed on the prototype (not the individual video element) since
  // upsert() with paused: false already triggers a real play() attempt
  // before there's any element instance to spy on yet.
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  // jsdom's HTMLMediaElement never actually plays, so a video created with
  // paused: false already starts life with the real element's .paused
  // permanently stuck at jsdom's default (true) -- exactly the same
  // asset.paused/media.paused disagreement the real bug depends on (there
  // it's caused by momentary buffering instead), letting these tests tell
  // "did this patch touch play/pause at all" apart from "did it actually
  // succeed at reconciling them" (jsdom can never do the latter).
  it("does not call .play()/.pause() on a volume-only patch, even though asset.paused disagrees with the element's real paused state", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false, volume: 0.5 }));
    const video = document.querySelector("video") as HTMLVideoElement;
    // Clears the upsert's own initial play() attempt so only the patchAsset
    // call below counts.
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    const pauseSpy = vi.spyOn(video, "pause");

    canvas.patchAsset("v1", { volume: 0.9 });

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(video.volume).toBeCloseTo(0.9, 5);
  });

  it("still goes through the normal play/pause sync for a patch that includes any other field alongside volume", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false, volume: 0.5 }));
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();

    canvas.patchAsset("v1", { volume: 0.9, muted: true });

    // Confirms this is genuinely the volume-only fast path being skipped,
    // not that .play() is simply never called at all in this setup.
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("a volume-only patch on an audio asset also takes the fast path, against the real <audio> element", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "au1", type: "audio", paused: false, volume: 0.5 }));
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();

    canvas.patchAsset("au1", { volume: 0.9 });

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.volume).toBeCloseTo(0.9, 5);
    expect(canvas.get("au1")?.volume).toBe(0.9);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("au1", { volume: 0.9 }, expect.any(Number));
  });

  it("a volume-only patch on a non-media asset is unaffected (no media element to fast-path around)", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "im1", type: "image", volume: 0.5 }));
    canvas.patchAsset("im1", { volume: 0.9 });
    expect(canvas.get("im1")?.volume).toBe(0.9);
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("im1", { volume: 0.9 }, expect.any(Number));
  });
});

describe("youtube asset", () => {
  function ytWrapper(): HTMLElement {
    return document.querySelector('[data-asset-type="youtube"]') as HTMLElement;
  }

  it("renders a fixed 1280x720 wrapper regardless of the asset's own box size, with a mount child filling it", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", width: 320, height: 180, youtubeVideoId: "dQw4w9WgXcQ" }));
    const wrapper = ytWrapper();
    expect(wrapper.style.width).toBe("1280px");
    expect(wrapper.style.height).toBe("720px");
    expect(wrapper.children).toHaveLength(1); // the mount div the YT player attaches into
  });

  it("disables pointer events on the wrapper -- regression: the YT iframe is a separate browsing context, so mouse events over it never bubble up to el's own mousedown listener, making the asset unclickable/undraggable", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(ytWrapper().style.pointerEvents).toBe("none");
  });

  it("resizes freely via corner-drag, exactly like every other asset type -- the box shape is never constrained", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", x: 0, y: 0, width: 320, height: 180, youtubeVideoId: "dQw4w9WgXcQ" }));
    canvas.selectAsset("yt1");
    const handle = container.querySelector('[data-role="resize-handle"][data-corner="se"]') as HTMLElement;

    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mousemove", { movementX: 160, movementY: 5 }));
    window.dispatchEvent(new MouseEvent("mouseup"));

    const asset = canvas.get("yt1")!;
    expect(asset.width).toBeCloseTo(480, 1);
    expect(asset.height).toBeCloseTo(185, 1); // dx and dy applied independently, same as video/image
  });

  it("letterboxes (uniform scale, contain-style) rather than stretching non-uniformly when the box isn't 16:9", () => {
    const { canvas } = setup();
    // A box twice as wide as the native ratio would call for at that
    // height -- 180px tall wants a 320px-wide 16:9 box, so height is the
    // binding (smaller) constraint, exactly like CSS object-fit: contain.
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", width: 640, height: 180, youtubeVideoId: "dQw4w9WgXcQ" }));
    const wrapper = ytWrapper();
    const scale = 180 / 720; // 0.25 -- the binding axis
    const offsetX = (640 - 1280 * scale) / 2; // 160
    expect(wrapper.style.transform).toBe(`translate(${offsetX}px, 0px) scale(${scale})`);
  });

  it("centers the letterboxed content within the box on both axes", () => {
    const { canvas } = setup();
    // width is the binding constraint here (320 -> exactly matches a
    // 180-tall 16:9 box already, but shrink height further to force
    // vertical centering with offsetY > 0 while offsetX stays 0).
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", width: 320, height: 360, youtubeVideoId: "dQw4w9WgXcQ" }));
    const wrapper = ytWrapper();
    const scale = 320 / 1280; // 0.25 -- width is binding
    const offsetY = (360 - 720 * scale) / 2; // 90
    expect(wrapper.style.transform).toBe(`translate(0px, ${offsetY}px) scale(${scale})`);
  });

  it("recomputes the letterboxed scale when the asset is resized", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", width: 1280, height: 720, youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(ytWrapper().style.transform).toBe("translate(0px, 0px) scale(1)");

    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", width: 256, height: 144, youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(ytWrapper().style.transform).toBe("translate(0px, 0px) scale(0.2)");
  });

  it("stopAsset patches paused: true and does not throw even though the player isn't necessarily ready yet", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", paused: false, youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => canvas.stopAsset("yt1")).not.toThrow();
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("yt1", { paused: true }, expect.any(Number));
  });

  it("applyRemoteStop does not throw for a youtube asset", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => canvas.applyRemoteStop("yt1")).not.toThrow();
  });

  it("remove() destroys the youtube player controller without throwing", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    expect(() => canvas.remove("yt1")).not.toThrow();
  });
});

describe("media-controls widget", () => {
  // See the previous describe block's beforeEach for why this is needed --
  // jsdom's HTMLMediaElement.play() isn't a real Promise, which throws
  // inside syncMediaState's .then()/.catch() chain unless stubbed. Applied
  // to every test in this block for simplicity, even though only some of
  // them actually transition paused true -> false.
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function widget(container: HTMLElement) {
    // Lives as a sibling of `container` now, not a descendant -- see
    // CanvasView's constructor doc comment on mediaControls for why.
    const root = container.parentElement!.querySelector('[data-role="media-controls"]') as HTMLElement;
    return {
      root,
      loop: root.querySelector('[data-role="mc-loop"]') as HTMLButtonElement,
      play: root.querySelector('[data-role="mc-play"]') as HTMLButtonElement,
      pause: root.querySelector('[data-role="mc-pause"]') as HTMLButtonElement,
      stop: root.querySelector('[data-role="mc-stop"]') as HTMLButtonElement,
      muted: root.querySelector('[data-role="mc-muted"]') as HTMLInputElement,
      volume: root.querySelector('[data-role="mc-volume"]') as HTMLInputElement,
      volumeLabel: root.querySelector('[data-role="mc-volume-label"]') as HTMLElement,
      seek: root.querySelector('[data-role="mc-seek"]') as HTMLInputElement,
      seekLabel: root.querySelector('[data-role="mc-seek-label"]') as HTMLElement,
    };
  }

  it("is hidden when nothing is selected", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    expect(widget(container).root.style.display).toBe("none");
  });

  it("lives outside `container`, at a z-index above the stream-preview boundary strips (z-index 20), so they can never invert it", () => {
    // Regression: as a child of `world` (inside `container`), no z-index
    // set on the widget itself could ever outrank a sibling of `container`
    // -- #stream-preview-border's always-on-top boundary strips, one
    // stacking-context level up -- so a strip crossing the widget's screen
    // position visibly inverted whatever of it was underneath.
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    canvas.selectAsset("v1");
    const root = widget(container).root;
    expect(container.contains(root)).toBe(false);
    expect(container.parentElement!.contains(root)).toBe(true);
    expect(Number(root.style.zIndex)).toBeGreaterThan(20);
  });

  it("is hidden for a selected asset type that has no playback (e.g. image)", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "i1", type: "image" }));
    canvas.selectAsset("i1");
    expect(widget(container).root.style.display).toBe("none");
  });

  it("shows for a selected youtube asset too", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "yt1", type: "youtube", youtubeVideoId: "dQw4w9WgXcQ" }));
    canvas.selectAsset("yt1");
    expect(widget(container).root.style.display).toBe("block");
  });

  it("shows and reflects state for a selected video asset, and stays in sync with the sidebar's own patchAsset calls", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", loop: false, paused: true, muted: false, volume: 0.5 }));
    canvas.selectAsset("v1");

    const w = widget(container);
    expect(w.root.style.display).toBe("block");
    expect(w.loop.classList.contains("active")).toBe(false);
    expect(w.play.classList.contains("active")).toBe(false);
    expect(w.pause.classList.contains("active")).toBe(true);
    expect(w.muted.checked).toBe(false);
    expect(w.volume.value).toBe("50");
    expect(w.volumeLabel.textContent).toBe("volume: 50%");

    // Simulates a change made via the sidebar's own controls (which call
    // the same canvas.patchAsset) -- the widget must pick it up too, since
    // both surfaces read from this exact same Entry.
    canvas.patchAsset("v1", { loop: true, muted: true, volume: 0.2 });
    expect(w.loop.classList.contains("active")).toBe(true);
    expect(w.muted.checked).toBe(true);
    expect(w.volume.value).toBe("20");
    expect(w.volumeLabel.textContent).toBe("volume: 20%");
  });

  it("hides again once the asset is deselected", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    canvas.selectAsset("v1");
    expect(widget(container).root.style.display).toBe("block");
    canvas.selectAsset(undefined);
    expect(widget(container).root.style.display).toBe("none");
  });

  it("loop/play/pause/mute/volume buttons patch the selected asset", () => {
    const { canvas, container, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", loop: false, paused: true, muted: false }));
    canvas.selectAsset("v1");
    const w = widget(container);

    w.loop.click();
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("v1", { loop: true }, expect.any(Number));

    w.play.click();
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("v1", { paused: false }, expect.any(Number));

    w.pause.click();
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("v1", { paused: true }, expect.any(Number));

    w.muted.checked = true;
    w.muted.dispatchEvent(new Event("change"));
    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("v1", { muted: true }, expect.any(Number));

    w.volume.value = "77";
    w.volume.dispatchEvent(new Event("input"));
    const [, sentPatch] = vi.mocked(callbacks.onAssetPatch).mock.calls.at(-1)!;
    expect(sentPatch).toMatchObject({ volume: 0.77 });
  });

  it("the stop button pauses and resets the video to the start of its timeline", () => {
    const { canvas, container, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false }));
    canvas.selectAsset("v1");
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 42, writable: true });

    widget(container).stop.click();

    expect(callbacks.onAssetPatch).toHaveBeenLastCalledWith("v1", { paused: true }, expect.any(Number));
    expect(video.currentTime).toBe(0);
    // Broadcasts the stop so other clients/browser-source reset their own
    // playback position too, not just this browser's -- see
    // CanvasCallbacks.onAssetStop's doc comment.
    expect(callbacks.onAssetStop).toHaveBeenCalledWith("v1");
  });
});

describe("media-controls widget -- seek slider", () => {
  let now = 0;

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.useFakeTimers();
    // Starts well past the throttle window (not 0) -- lastSeekSentAt also
    // defaults to 0, and a mocked `now` of exactly 0 would make the very
    // first send look like it's still within the window of a send that
    // "already happened" at time 0, which is just a test-mock artifact
    // (real performance.now() is never 0 by the time a user can click
    // anything), not a real throttle-logic bug.
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function widget(container: HTMLElement) {
    const root = container.parentElement!.querySelector('[data-role="media-controls"]') as HTMLElement;
    return {
      seek: root.querySelector('[data-role="mc-seek"]') as HTMLInputElement,
      seekLabel: root.querySelector('[data-role="mc-seek-label"]') as HTMLElement,
    };
  }

  it("reflects the selected video's current position/duration as soon as it's selected", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 25, writable: true, configurable: true });

    canvas.selectAsset("v1");

    const w = widget(container);
    expect(w.seek.value).toBe("25");
    expect(w.seekLabel.textContent).toBe("0:25 / 1:40");
  });

  it("dragging the slider seeks the local video immediately and sends a throttled asset:seek", () => {
    const { canvas, container, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
    canvas.selectAsset("v1");
    const w = widget(container);

    w.seek.value = "50";
    w.seek.dispatchEvent(new Event("input"));

    expect(video.currentTime).toBe(50);
    expect(callbacks.onAssetSeek).toHaveBeenCalledWith("v1", 50);
  });

  it("throttles repeated input events, but the final 'change' on release always sends", () => {
    const { canvas, container, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
    canvas.selectAsset("v1");
    const w = widget(container);

    w.seek.value = "10";
    w.seek.dispatchEvent(new Event("input"));
    expect(callbacks.onAssetSeek).toHaveBeenCalledTimes(1);

    // Still inside the throttle window -- local scrub applies, but no
    // second network send yet.
    now += 10;
    w.seek.value = "12";
    w.seek.dispatchEvent(new Event("input"));
    expect(video.currentTime).toBe(12);
    expect(callbacks.onAssetSeek).toHaveBeenCalledTimes(1);

    // Release: "change" always force-sends the exact drop position,
    // regardless of the throttle window.
    w.seek.value = "15";
    w.seek.dispatchEvent(new Event("change"));
    expect(callbacks.onAssetSeek).toHaveBeenLastCalledWith("v1", 15);
    expect(callbacks.onAssetSeek).toHaveBeenCalledTimes(2);
  });

  it("does not let the periodic position poll clobber the slider mid-drag", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 100, writable: true, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
    canvas.selectAsset("v1");
    const w = widget(container);

    w.seek.value = "40";
    w.seek.dispatchEvent(new Event("input")); // starts the drag

    // The video's real currentTime is now 40 (from the drag itself), but a
    // background poll tick must not overwrite the slider the user is still
    // actively holding, even though it would compute the same value here --
    // the point is the guard, not this specific number.
    vi.advanceTimersByTime(1000);

    expect(w.seek.value).toBe("40");
  });

  it("falls back to 0 when duration hasn't loaded yet (no NaN)", () => {
    const { canvas, container } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    canvas.selectAsset("v1"); // jsdom's fresh <video> has duration NaN by default

    const w = widget(container);
    expect(w.seek.value).toBe("0");
    expect(w.seekLabel.textContent).toBe("0:00 / 0:00");
  });
});

describe("stopAsset", () => {
  // See "media-controls widget"'s beforeEach for why this is needed.
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("pauses and resets currentTime to 0 for a video asset", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 10, writable: true });

    canvas.stopAsset("v1");

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("v1", { paused: true }, expect.any(Number));
    expect(video.currentTime).toBe(0);
    expect(canvas.get("v1")?.paused).toBe(true);
    expect(callbacks.onAssetStop).toHaveBeenCalledWith("v1");
  });

  it("pauses and resets currentTime to 0 for an audio asset's real (hidden) <audio> element", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "au1", type: "audio", paused: false }));
    const audio = document.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 10, writable: true });

    canvas.stopAsset("au1");

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("au1", { paused: true }, expect.any(Number));
    expect(audio.currentTime).toBe(0);
    expect(callbacks.onAssetStop).toHaveBeenCalledWith("au1");
  });

  it("does nothing for an unknown assetId", () => {
    const { canvas, callbacks } = setup();
    canvas.stopAsset("missing");
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
    expect(callbacks.onAssetStop).not.toHaveBeenCalled();
  });
});

describe("applyRemoteStop", () => {
  it("resets a video's currentTime to 0", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video" }));
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 30, writable: true });

    canvas.applyRemoteStop("v1");

    expect(video.currentTime).toBe(0);
  });

  it("does nothing for an unknown assetId", () => {
    const { canvas } = setup();
    expect(() => canvas.applyRemoteStop("missing")).not.toThrow();
  });

  it("resets an audio asset's real (hidden) <audio> element too", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "au1", type: "audio" }));
    const audio = document.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 30, writable: true });

    canvas.applyRemoteStop("au1");

    expect(audio.currentTime).toBe(0);
  });

  it("does nothing for a text asset (no media element)", () => {
    const { canvas } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text" }));
    expect(() => canvas.applyRemoteStop("t1")).not.toThrow();
  });
});

// Regression coverage for the loop bug: nothing previously marked
// asset.paused true when a non-looping video/audio naturally ended, so the
// next syncMediaState call saw "should still be playing" and called
// .play() again -- which browsers auto-restart from currentTime 0 on an
// already-ended element, reading as an unwanted loop regardless of the
// actual loop setting.
describe("media 'ended' event", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("patches paused: true when a non-looping video ends", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false, loop: false }));
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    const video = document.querySelector("video") as HTMLVideoElement;

    video.dispatchEvent(new Event("ended"));

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("v1", { paused: true }, expect.any(Number));
    expect(canvas.get("v1")?.paused).toBe(true);
  });

  it("patches paused: true when a non-looping audio asset's real element ends", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "au1", type: "audio", paused: false, loop: false }));
    const audio = document.querySelector("audio") as HTMLAudioElement;

    audio.dispatchEvent(new Event("ended"));

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("au1", { paused: true }, expect.any(Number));
    expect(canvas.get("au1")?.paused).toBe(true);
  });

  it("does not patch when the asset is set to loop -- native looping handles it, and 'ended' never even fires for a real looping element", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false, loop: true }));
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    vi.mocked(callbacks.onAssetPatch).mockClear();
    const video = document.querySelector("video") as HTMLVideoElement;

    video.dispatchEvent(new Event("ended"));

    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });

  it("does nothing if the asset was removed before 'ended' fires", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "v1", type: "video", paused: false, loop: false }));
    const video = document.querySelector("video") as HTMLVideoElement;
    canvas.remove("v1");
    vi.mocked(callbacks.onAssetPatch).mockClear();

    expect(() => video.dispatchEvent(new Event("ended"))).not.toThrow();
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
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

  it("patches text live on every input event, not just on blur", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("t1", expect.objectContaining({ text: "edited" }), expect.any(Number));
    // Still mid-edit -- blur (not this input event) is what ends editing.
    expect(div.contentEditable).toBe("true");
  });

  it("patches a multi-line edit as a single string with real newline characters preserved", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    // Simulates the result of onKeyDown's execCommand("insertText", ...,
    // "\n") -- a literal newline character in the text node, not a <br>/
    // <div> boundary.
    div.textContent = "hellow\nthere\nwhy isn't this working";
    div.dispatchEvent(new Event("input"));

    expect(callbacks.onAssetPatch).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ text: "hellow\nthere\nwhy isn't this working" }),
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

  it("sends the asset's full patchable state (not just text) so a rejected/raced send can never lose an unrelated field's data", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello", hidden: true, opacity: 0.4 }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));

    const [, sentPatch] = vi.mocked(callbacks.onAssetPatch).mock.calls[0];
    expect(sentPatch).toMatchObject({ text: "edited", hidden: true, opacity: 0.4 });
  });

  it("blur ends editing without sending an additional patch (the text is already saved from the input listener)", () => {
    const { canvas, callbacks } = setup();
    canvas.upsert(makeAsset({ assetId: "t1", type: "text", text: "hello" }));
    const div = document.querySelector('[data-asset-type="text"]') as HTMLElement;
    div.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    div.textContent = "edited";
    div.dispatchEvent(new Event("input"));
    vi.mocked(callbacks.onAssetPatch).mockClear();

    div.dispatchEvent(new FocusEvent("blur"));
    expect(div.contentEditable).not.toBe("true");
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
  });

  it("Escape blurs to end editing without reverting the (already-saved) text or sending a further patch", () => {
    // Regression: previously reverted to the pre-edit text on Escape, back
    // when edits only committed on blur/Enter -- now that every keystroke
    // already patches in real time, there's nothing to revert to; Escape
    // just ends the editing session.
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
    expect(callbacks.onAssetPatch).not.toHaveBeenCalled();
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
    expect(callbacks.onAssetPatch).toHaveBeenCalledWith("t1", expect.objectContaining({ text: "hello\n" }), expect.any(Number));
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
  it("centers the viewport rect on first load, leaving ~20% margin on each side", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 2000, 1200);

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    // Width-constrained: 2000 * 0.6 / 1400 = 0.8571428571428571 (vs.
    // height's 1200/1000 = 1.2), so zoom follows the width margin.
    expect(worldTransform(container)).toBe("translate(400px, 171.42857142857144px) scale(0.8571428571428571)");
  });

  it("fits within the container's height when the viewport is tall relative to width", async () => {
    const { canvas, container } = setup();
    stubClientSize(container, 3000, 500);

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    // Height-constrained here: 500/1000 = 0.5 vs width's 3000*0.6/1400 =
    // 1.2857142857142856 -- zoom must follow the smaller (height) value so
    // the rect never overflows the container vertically.
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

    // From the auto-centering test: zoom 0.8571428571428571, pan (400, 171.42857142857144).
    expect(canvas.getViewportScreenRect()).toEqual({
      left: 400,
      top: 171.42857142857144,
      width: 1200,
      height: 857.1428571428571,
    });
  });

  it("fires again with the updated rect after auto-centering completes", async () => {
    const onViewportTransformChanged = vi.fn();
    const { canvas, container } = setup({ onViewportTransformChanged });
    stubClientSize(container, 2000, 1200);
    onViewportTransformChanged.mockClear();

    canvas.setViewport({ roomId: "room1", x: 0, y: 0, width: 1400, height: 1000 });
    await flushFrame();

    expect(onViewportTransformChanged).toHaveBeenCalledWith({
      left: 400,
      top: 171.42857142857144,
      width: 1200,
      height: 857.1428571428571,
    });
  });
});
