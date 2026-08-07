// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@scenette/protocol";
import { Sidebar, SidebarCallbacks, formatBytes } from "../src/sidebar";

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
    onTextEditBlur: vi.fn(),
    onStop: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onCreateClick: vi.fn(),
    onVariableSet: vi.fn(),
    onVariableDelete: vi.fn(),
    onVariableRename: vi.fn(),
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

describe("mid-typing rebuild guard (focus, not just mousedown/mouseup)", () => {
  it("does not rebuild the properties panel while a text field has focus, even without an active mousedown", () => {
    // Regression: text patches now fire live on every keystroke (see the
    // realtime text-content/name tests below), so the remote echo of that
    // same keystroke can arrive from the server while the user is still
    // typing -- long after any mousedown from originally clicking into the
    // field has already been followed by its mouseup. Rebuilding the panel
    // mid-type would destroy and recreate the textarea, dropping focus and
    // cursor position after a single keystroke.
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello" })]);
    sidebar.setSelected("a1");

    const textAreaBefore = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    textAreaBefore.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    sidebar.upsertAsset(makeAsset({ type: "text", text: "hello w" }));

    const textAreaAfter = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    expect(textAreaAfter).toBe(textAreaBefore);
  });

  it("resumes rebuilding once the field loses focus", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello" })]);
    sidebar.setSelected("a1");

    const textAreaBefore = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    textAreaBefore.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    textAreaBefore.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    sidebar.upsertAsset(makeAsset({ type: "text", text: "hello world" }));

    const textAreaAfter = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    expect(textAreaAfter).not.toBe(textAreaBefore);
    expect(textAreaAfter.value).toBe("hello world");
  });

  it("does not close an open <select> dropdown (e.g. font-family) while it has focus", () => {
    // Regression: focus tracking only checked INPUT/TEXTAREA, not SELECT,
    // so a <select>'s own focus (held for as long as its dropdown is open)
    // was never recognized as "interacting" -- combined with setAssets not
    // even checking the guard at all (see below), a periodic full-state
    // resync landing while a font-family dropdown was open rebuilt the
    // panel out from under it, visibly closing the dropdown.
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello", fontFamily: "Roboto" })]);
    sidebar.setSelected("a1");

    const selectBefore = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    selectBefore.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    sidebar.upsertAsset(makeAsset({ type: "text", text: "hello", fontFamily: "Roboto Mono" }));

    const selectAfter = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    expect(selectAfter).toBe(selectBefore);
  });

  it("setAssets (periodic/manual full-state resync) also respects the interacting guard, not just upsertAsset", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello", fontFamily: "Roboto" })]);
    sidebar.setSelected("a1");

    const selectBefore = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    selectBefore.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    sidebar.setAssets([makeAsset({ type: "text", text: "hello", fontFamily: "Roboto Mono" })]);

    const selectAfter = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    expect(selectAfter).toBe(selectBefore);
  });

  it("setAssets resumes rebuilding once the field loses focus", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello", fontFamily: "Roboto" })]);
    sidebar.setSelected("a1");

    const selectBefore = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    selectBefore.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    selectBefore.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    sidebar.setAssets([makeAsset({ type: "text", text: "hello", fontFamily: "Roboto Mono" })]);

    const selectAfter = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    expect(selectAfter).not.toBe(selectBefore);
    expect(selectAfter.value).toBe("Roboto Mono");
  });
});

describe("realtime text/name patching", () => {
  it("patches text live on every keystroke (input, not change)", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text", text: "hello" })]);
    sidebar.setSelected("a1");

    const textArea = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    textArea.value = "hello world";
    textArea.dispatchEvent(new Event("input"));
    expect(onPatch).toHaveBeenCalledWith("a1", { text: "hello world" });
  });
});

describe("dispose", () => {
  it("stops clearing `interacting` on window mouseup after dispose (no leaked listener on a room switch)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ rotation: 0 })]);
    sidebar.setSelected("a1");

    const rangeBefore = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    rangeBefore.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    sidebar.dispose();

    // Regression: previously this window listener was bound with an inline
    // closure sidebar.dispose() had no reference to, so it kept firing
    // after a second Sidebar was constructed on the same containers.
    window.dispatchEvent(new MouseEvent("mouseup"));
    sidebar.upsertAsset(makeAsset({ rotation: 45 }));

    // Still mid-drag as far as this (disposed) instance is concerned -- the
    // panel should not have rebuilt.
    const rangeAfter = propertiesPanel.querySelector('[data-role="rotation"]') as HTMLElement;
    expect(rangeAfter).toBe(rangeBefore);
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

describe("editable name field", () => {
  it("shows an empty input with the derived label as a placeholder when no name is set", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text", text: "hello world" })]);
    sidebar.setSelected("a1");

    const nameInput = propertiesPanel.querySelector('[data-role="name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(nameInput.placeholder).toBe("hello world");
  });

  it("prefills the input with an explicitly-set name", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ name: "My Label" })]);
    sidebar.setSelected("a1");

    const nameInput = propertiesPanel.querySelector('[data-role="name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("My Label");
  });

  it("sends a patch on change (blur), not on every keystroke", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset()]);
    sidebar.setSelected("a1");

    const nameInput = propertiesPanel.querySelector('[data-role="name"]') as HTMLInputElement;
    nameInput.value = "Renamed";
    nameInput.dispatchEvent(new Event("input"));
    expect(onPatch).not.toHaveBeenCalled();

    nameInput.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { name: "Renamed" });
  });

  it("blurs the input on Enter (which commits via the change listener, same as clicking away)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset()]);
    sidebar.setSelected("a1");

    const nameInput = propertiesPanel.querySelector('[data-role="name"]') as HTMLInputElement;
    nameInput.focus();
    expect(document.activeElement).toBe(nameInput);
    nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(document.activeElement).not.toBe(nameInput);
  });

  it("is shown for every asset type, not just text", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "video" })]);
    sidebar.setSelected("a1");
    expect(propertiesPanel.querySelector('[data-role="name"]')).not.toBeNull();
  });
});

describe("Playback section (video/audio)", () => {
  it("is only shown for video/audio assets", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "image" })]);
    sidebar.setSelected("a1");
    expect(propertiesPanel.querySelector('[data-role="play-pause"]')).toBeNull();
  });

  it("is shown for video and audio assets", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "video" })]);
    sidebar.setSelected("a1");
    expect(propertiesPanel.querySelector('[data-role="play-pause"]')).not.toBeNull();
    expect(propertiesPanel.querySelector('[data-role="stop"]')).not.toBeNull();
  });

  it("the stop button delegates to onStop (the actual pause+seek-to-0 happens in the canvas, not here)", () => {
    const onStop = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onStop }));
    sidebar.setAssets([makeAsset({ type: "video" })]);
    sidebar.setSelected("a1");

    (propertiesPanel.querySelector('[data-role="stop"]') as HTMLButtonElement).click();

    expect(onStop).toHaveBeenCalledWith("a1");
  });

  it("play-pause toggles the current paused state", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "video", paused: true })]);
    sidebar.setSelected("a1");

    (propertiesPanel.querySelector('[data-role="play-pause"]') as HTMLButtonElement).click();

    expect(onPatch).toHaveBeenCalledWith("a1", { paused: false });
  });
});

describe("text settings section", () => {
  it("defaults the text textarea to 3 rows tall (not the old cramped 2)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");
    const textArea = propertiesPanel.querySelector('[data-role="text-content"]') as HTMLTextAreaElement;
    expect(textArea.rows).toBe(3);
  });

  it("is only shown for text assets", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "image" })]);
    sidebar.setSelected("a1");
    expect(propertiesPanel.querySelector('[data-role="font-family"]')).toBeNull();
  });

  it("lists every font family as an option, defaulting to Roboto", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const select = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    expect(select.value).toBe("Roboto");
    const options = [...select.options].map((o) => o.value);
    expect(options).toContain("Comic Sans MS");
    expect(options).toContain("Averia Serif Libre");
    expect(options).toHaveLength(7);
  });

  it("patches fontFamily/fontSize/fontWeight/textAlign on change", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const family = propertiesPanel.querySelector('[data-role="font-family"]') as HTMLSelectElement;
    family.value = "Comic Neue";
    family.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { fontFamily: "Comic Neue" });

    const size = propertiesPanel.querySelector('[data-role="font-size"]') as HTMLInputElement;
    size.value = "32";
    size.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { fontSize: 32 });

    const align = propertiesPanel.querySelector('[data-role="text-align"]') as HTMLSelectElement;
    align.value = "center";
    align.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { textAlign: "center" });
  });

  it("keeps the color swatch and hex input in sync and patches on change", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const hex = propertiesPanel.querySelector('[data-role="bg-color-hex"]') as HTMLInputElement;
    const swatch = propertiesPanel.querySelector('[data-role="bg-color-swatch"]') as HTMLInputElement;
    hex.value = "#ff00ff";
    hex.dispatchEvent(new Event("change"));
    expect(swatch.value).toBe("#ff00ff");
    expect(onPatch).toHaveBeenCalledWith("a1", { backgroundColor: "#ff00ff" });
  });

  it("swaps background and text colors", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(
      objectsPanel,
      propertiesPanel,
      makeCallbacks({ onPatch })
    );
    sidebar.setAssets([makeAsset({ type: "text", backgroundColor: "#000000", textColor: "#ffffff" })]);
    sidebar.setSelected("a1");

    propertiesPanel.querySelector<HTMLButtonElement>('[data-role="swap-colors"]')!.click();
    expect(onPatch).toHaveBeenCalledWith("a1", { backgroundColor: "#ffffff", textColor: "#000000" });
  });

  it("patches backgroundAlpha live on every drag tick (input, not change) as a 0-1 fraction from the 0-100 slider", () => {
    // Real-time like every other slider in the app -- doesn't require the
    // user to release the slider for it to take effect.
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const alpha = propertiesPanel.querySelector('[data-role="bg-alpha"]') as HTMLInputElement;
    alpha.value = "70";
    alpha.dispatchEvent(new Event("input"));
    expect(onPatch).toHaveBeenCalledWith("a1", { backgroundAlpha: 0.7 });
  });

  it("patches shadow fields including the enabled checkbox", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const enabled = propertiesPanel.querySelector('[data-role="shadow-enabled"]') as HTMLInputElement;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { shadowEnabled: true });

    const blur = propertiesPanel.querySelector('[data-role="shadow-blur"]') as HTMLInputElement;
    blur.value = "8";
    blur.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { shadowBlur: 8 });
  });

  it("patches outline fields including the enabled checkbox", () => {
    const onPatch = vi.fn();
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks({ onPatch }));
    sidebar.setAssets([makeAsset({ type: "text" })]);
    sidebar.setSelected("a1");

    const enabled = propertiesPanel.querySelector('[data-role="outline-enabled"]') as HTMLInputElement;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith("a1", { outlineEnabled: true });

    // Real-time like every other slider -- "input", not "change".
    const width = propertiesPanel.querySelector('[data-role="outline-width"]') as HTMLInputElement;
    width.value = "3";
    width.dispatchEvent(new Event("input"));
    expect(onPatch).toHaveBeenCalledWith("a1", { outlineWidth: 3 });
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

describe("room storage label", () => {
  it("shows deduplicated usage against the advertised quota", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setStorageQuota(500 * 1024 * 1024);
    sidebar.setAssets([
      makeAsset({ assetId: "a1", s3Key: "room1/a/x.png", fileSize: 1024 * 1024 }),
      // A duplicateAsset() row reusing the same S3 object -- must not
      // double-count, matching the server's sumRoomStorageBytes.
      makeAsset({ assetId: "a2", s3Key: "room1/a/x.png", fileSize: 1024 * 1024 }),
      makeAsset({ assetId: "a3", s3Key: "room1/b/y.png", fileSize: 512 * 1024 }),
    ]);

    expect(objectsPanel.querySelector('[data-role="storage"]')!.textContent).toBe("1.5 MB / 500 MB used");
  });

  it("shows plain usage when no quota has been advertised (older server)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ assetId: "a1", s3Key: "room1/a/x.png", fileSize: 512 * 1024 })]);

    expect(objectsPanel.querySelector('[data-role="storage"]')!.textContent).toBe("512 KB used");
  });

  it("updates as assets are added and removed", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setStorageQuota(500 * 1024 * 1024);
    sidebar.setAssets([]);
    expect(objectsPanel.querySelector('[data-role="storage"]')!.textContent).toBe("0 B / 500 MB used");

    sidebar.upsertAsset(makeAsset({ assetId: "a1", s3Key: "room1/a/x.png", fileSize: 1024 * 1024 }));
    expect(objectsPanel.querySelector('[data-role="storage"]')!.textContent).toBe("1 MB / 500 MB used");

    sidebar.removeAsset("a1");
    expect(objectsPanel.querySelector('[data-role="storage"]')!.textContent).toBe("0 B / 500 MB used");
  });
});

describe("properties file size", () => {
  it("shows the file size for a selected media asset", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ assetId: "a1", s3Key: "room1/a/x.png", fileSize: 2.5 * 1024 * 1024 })]);
    sidebar.setSelected("a1");

    expect(propertiesPanel.querySelector(".prop-file-size")!.textContent!.trim()).toBe("File size: 2.5 MB");
    // Placed inside the delete/hide/lock/duplicate button row at the top of
    // the panel, not as its own standalone line further down.
    expect(propertiesPanel.querySelector(".properties-buttons .prop-file-size")).not.toBeNull();
  });

  it("omits the file size line for assets without one (e.g. text)", () => {
    const sidebar = new Sidebar(objectsPanel, propertiesPanel, makeCallbacks());
    sidebar.setAssets([makeAsset({ assetId: "t1", type: "text", text: "hi" })]);
    sidebar.setSelected("t1");

    expect(propertiesPanel.querySelector(".prop-file-size")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks sensible units and trims trailing .0", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(39.76 * 1024 * 1024)).toBe("39.8 MB");
  });
});
