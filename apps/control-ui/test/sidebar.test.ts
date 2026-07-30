// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@scenette/protocol";
import { Sidebar, SidebarCallbacks } from "../src/sidebar";

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
    paused: true,
    seq: 1,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    keep: false,
    ...overrides,
  };
}

function makeCallbacks(overrides: Partial<SidebarCallbacks> = {}): SidebarCallbacks {
  return {
    onSelect: vi.fn(),
    onToggleHidden: vi.fn(),
    onToggleLocked: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onPatch: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onCreateClick: vi.fn(),
    ...overrides,
  };
}

let objectsPanel: HTMLElement;
let propertiesPanel: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  objectsPanel = document.createElement("div");
  propertiesPanel = document.createElement("div");
  document.body.append(objectsPanel, propertiesPanel);
});

describe("objects-list eye/lock buttons (stale-closure regression)", () => {
  it("alternates hidden true/false across two clicks when the map is optimistically updated in between, even on the original (now-detached) button", () => {
    const onToggleHidden = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onToggleHidden }));
    sidebar.setAssets([makeAsset({ hidden: false })]);

    // Capture the button from the FIRST render -- renderObjectsList always
    // rebuilds unconditionally, so after the optimistic upsertAsset() below
    // a brand-new button replaces this one in the DOM. Clicking this same
    // (now-detached) reference again is what actually distinguishes "reads
    // fresh state at click time" from "closed over the value from when this
    // button was created".
    const originalEyeButton = objectsPanel.querySelector('[title="Hide from viewers"]') as HTMLButtonElement;
    expect(originalEyeButton).toBeTruthy();

    originalEyeButton.click();
    expect(onToggleHidden).toHaveBeenNthCalledWith(1, "a1", true);

    // Mimics main.ts's real wiring: onToggleHidden synchronously applies
    // the change and re-syncs the sidebar, rather than waiting on a network
    // round trip.
    sidebar.upsertAsset(makeAsset({ hidden: true }));

    originalEyeButton.click();
    expect(onToggleHidden).toHaveBeenNthCalledWith(2, "a1", false);
  });

  it("does the same for the lock button", () => {
    const onToggleLocked = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onToggleLocked }));
    sidebar.setAssets([makeAsset({ locked: false })]);

    const originalLockButton = objectsPanel.querySelector('[title="Lock (prevent drag/resize)"]') as HTMLButtonElement;
    originalLockButton.click();
    expect(onToggleLocked).toHaveBeenNthCalledWith(1, "a1", true);

    sidebar.upsertAsset(makeAsset({ locked: true }));

    originalLockButton.click();
    expect(onToggleLocked).toHaveBeenNthCalledWith(2, "a1", false);
  });
});

describe("properties-panel toggle buttons (stale-closure regression)", () => {
  it("alternates hidden true/false across two clicks on the same (now-detached) button", () => {
    const onToggleHidden = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onToggleHidden }));
    sidebar.setAssets([makeAsset({ hidden: false })]);
    sidebar.setSelected("a1");

    const originalButton = propertiesPanel.querySelector('[data-role="toggle-hidden"]') as HTMLButtonElement;
    originalButton.click();
    expect(onToggleHidden).toHaveBeenNthCalledWith(1, "a1", true);

    sidebar.upsertAsset(makeAsset({ hidden: true }));

    originalButton.click();
    expect(onToggleHidden).toHaveBeenNthCalledWith(2, "a1", false);
  });

  it("does the same for flip-x", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ flipX: false })]);
    sidebar.setSelected("a1");

    const originalButton = propertiesPanel.querySelector('[data-role="flip-x"]') as HTMLButtonElement;
    originalButton.click();
    expect(onPatch).toHaveBeenNthCalledWith(1, "a1", { flipX: true });

    sidebar.upsertAsset(makeAsset({ flipX: true }));

    originalButton.click();
    expect(onPatch).toHaveBeenNthCalledWith(2, "a1", { flipX: false });
  });
});

describe("mid-drag rebuild guard (`interacting`)", () => {
  it("does not rebuild the properties panel while a slider is mid-drag (mousedown, no mouseup yet)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ rotation: 0 })]);
    sidebar.setSelected("a1");

    const rangeBefore = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    rangeBefore.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    sidebar.upsertAsset(makeAsset({ rotation: 45 }));

    const rangeAfter = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    expect(rangeAfter).toBe(rangeBefore);
  });

  it("resumes rebuilding once the mouse is released", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ rotation: 0 })]);
    sidebar.setSelected("a1");

    const rangeBefore = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    rangeBefore.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));

    sidebar.upsertAsset(makeAsset({ rotation: 45 }));

    const rangeAfter = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    expect(rangeAfter).not.toBe(rangeBefore);
    expect((rangeAfter as HTMLInputElement).value).toBe("45");
  });
});

describe("bindSlider", () => {
  it("live-updates the paired number input and sends a patch on every drag tick", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ opacity: 1 })]);
    sidebar.setSelected("a1");

    const range = propertiesPanel.querySelector('[data-role="opacity"]') as HTMLInputElement;
    const number = propertiesPanel.querySelector('[data-role="opacity-number"]') as HTMLInputElement;

    range.value = "40";
    range.dispatchEvent(new Event("input"));

    expect(number.value).toBe("40");
    expect(onPatch).toHaveBeenCalledWith("a1", { opacity: 0.4 });
  });

  it("clamps a typed value in the number input to the slider's range", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ blur: 0 })]);
    sidebar.setSelected("a1");

    const number = propertiesPanel.querySelector('[data-role="blur-number"]') as HTMLInputElement;
    number.value = "999";
    number.dispatchEvent(new Event("input"));

    expect(onPatch).toHaveBeenCalledWith("a1", { blur: 20 });
  });

  it("rotation slider/number run -180..180, normalized for display", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    // 350 degrees is equivalent to -10 -- should display normalized, not raw.
    sidebar.setAssets([makeAsset({ rotation: 350 })]);
    sidebar.setSelected("a1");

    const range = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLInputElement;
    const number = propertiesPanel.querySelector('[data-role="rotation-number"]') as HTMLInputElement;
    expect(range.value).toBe("-10");
    expect(number.value).toBe("-10");
  });
});

describe("setAssets / selection lifecycle", () => {
  it("clears selection when the previously-selected asset is no longer present", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ assetId: "a1" })]);
    sidebar.setSelected("a1");
    expect(propertiesPanel.style.display).toBe("flex");

    sidebar.setAssets([makeAsset({ assetId: "a2" })]);
    expect(propertiesPanel.style.display).toBe("none");
  });

  it("sorts the objects list by zIndex descending", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([
      makeAsset({ assetId: "low", zIndex: 0 }),
      makeAsset({ assetId: "high", zIndex: 5 }),
      makeAsset({ assetId: "mid", zIndex: 2 }),
    ]);
    const rows = [...objectsPanel.querySelectorAll(".object-row")];
    expect(rows).toHaveLength(3);
  });
});
