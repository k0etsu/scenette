// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamPreviewPanel, StreamPreviewCallbacks } from "../src/streamPreview";

let root: HTMLElement;
let overlay: HTMLElement;
let borderEl: HTMLElement;
let settingsModal: HTMLElement;
let canvasInner: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  overlay = document.createElement("div");
  borderEl = document.createElement("div");
  settingsModal = document.createElement("div");
  canvasInner = document.createElement("div");
  document.body.append(root, overlay, borderEl, settingsModal, canvasInner);
});

function makeCallbacks(overrides: Partial<StreamPreviewCallbacks> = {}): StreamPreviewCallbacks {
  return { onSettingsChange: vi.fn(), ...overrides };
}

function makePanel(callbacks: StreamPreviewCallbacks = makeCallbacks()): StreamPreviewPanel {
  return new StreamPreviewPanel(root, overlay, borderEl, settingsModal, canvasInner, callbacks);
}

function checkbox(role: string): HTMLInputElement {
  return root.querySelector(`[data-role="${role}"]`) as HTMLInputElement;
}

function enableEmbed(): void {
  checkbox("embed").checked = true;
  checkbox("embed").dispatchEvent(new Event("change"));
}

function iframeEl(): HTMLIFrameElement {
  return overlay.querySelector("iframe") as HTMLIFrameElement;
}

function placeholderEl(): HTMLElement {
  return overlay.children[0].children[0] as HTMLElement; // wrapper > placeholder (first child)
}

// Only the room owner can reach the settings modal at all (see setIsOwner) --
// tests that need to configure a channel must opt into ownership first.
function configureTwitchChannel(panel: StreamPreviewPanel, channel: string): void {
  panel.setIsOwner(true);
  root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
  (settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement).value = channel;
  settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));
}

const rect = { left: 10, top: 20, width: 960, height: 540 };

describe("StreamPreviewPanel -- visibility", () => {
  it("shows both the overlay and the border immediately on construction, before embed is ever touched", () => {
    // Regression: confirmed against a recording of the reference tool --
    // the placeholder + boundary are visible with "embed" unchecked too,
    // not only once it's checked. Only the iframe-vs-placeholder choice
    // inside the (always-visible) area responds to that checkbox.
    makePanel();
    expect(overlay.style.display).toBe("block");
    expect(borderEl.style.display).toBe("block");
  });

  it("stays visible after embed is checked and then unchecked again", () => {
    makePanel();
    enableEmbed();
    checkbox("embed").checked = false;
    checkbox("embed").dispatchEvent(new Event("change"));
    expect(overlay.style.display).toBe("block");
    expect(borderEl.style.display).toBe("block");
  });

  it("hides both via visibility until the first setScreenRect call, so neither paints at an unpositioned default before CanvasView's first (already-centered) rect arrives", () => {
    // Regression: CanvasView used to fire its first rect synchronously
    // during construction at the uncentered pan:0/zoom:1 transform, and
    // this panel applied whatever rect it was given immediately -- so the
    // boundary rendered at the top-left corner for a frame before jumping
    // to center. CanvasView no longer fires that premature rect, but
    // hiding here too means this panel is correct even if some other
    // caller ever calls setScreenRect before a real rect is known.
    const panel = makePanel();
    expect(overlay.style.visibility).toBe("hidden");
    expect(borderEl.style.visibility).toBe("hidden");

    panel.setScreenRect(rect);
    expect(overlay.style.visibility).toBe("visible");
    expect(borderEl.style.visibility).toBe("visible");
  });
});

describe("StreamPreviewPanel -- placeholder vs iframe", () => {
  it("shows the placeholder (not the iframe) by default, with embed unchecked", () => {
    makePanel();
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
    expect(placeholderEl().querySelector("svg")).not.toBeNull();
  });

  it("still shows the placeholder when embed is checked but no channel is configured", () => {
    makePanel();
    enableEmbed();
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
  });

  it("switches to the iframe (hiding the placeholder) once a channel is configured AND embed is checked", () => {
    const panel = makePanel();
    configureTwitchChannel(panel, "shroud");
    enableEmbed();
    expect(iframeEl().style.display).toBe("block");
    expect(placeholderEl().style.display).toBe("none");
  });

  it("goes back to the placeholder if embed is unchecked again, even with a channel configured", () => {
    const panel = makePanel();
    configureTwitchChannel(panel, "shroud");
    enableEmbed();
    checkbox("embed").checked = false;
    checkbox("embed").dispatchEvent(new Event("change"));
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
  });

  it("the placeholder sits before the iframe in DOM order, so a configured embed naturally covers it", () => {
    makePanel();
    const wrapper = overlay.children[0];
    expect(wrapper.children[0]).toBe(placeholderEl());
    expect(wrapper.children[1].tagName).toBe("IFRAME");
  });
});

describe("StreamPreviewPanel -- positioning (single uniform scale, 1920x1080 native)", () => {
  const NATIVE_WIDTH = 1920;

  function wrapperTransform(): string {
    return (overlay.children[0] as HTMLElement).style.transform;
  }

  function borderWrapperTransform(): string {
    return (borderEl.children[0] as HTMLElement).style.transform;
  }

  it("positions the overlay and border at the same left/top from setScreenRect, regardless of embed state", () => {
    const panel = makePanel();

    panel.setScreenRect(rect);

    expect(overlay.style.left).toBe("10px");
    expect(overlay.style.top).toBe("20px");
    expect(borderEl.style.left).toBe("10px");
    expect(borderEl.style.top).toBe("20px");
  });

  it("scales both the overlay wrapper and the border wrapper by the same factor: rect.width / 1920", () => {
    const panel = makePanel();
    panel.setScreenRect({ left: 0, top: 0, width: 960, height: 540 });

    expect(wrapperTransform()).toBe("scale(0.5)");
    expect(borderWrapperTransform()).toBe("scale(0.5)");
  });

  it("scales to exactly 1 when the rect is already native-sized (1920x1080)", () => {
    const panel = makePanel();
    panel.setScreenRect({ left: 0, top: 0, width: NATIVE_WIDTH, height: 1080 });
    expect(wrapperTransform()).toBe("scale(1)");
  });

  it("never resizes the iframe's own CSS width/height -- always the fixed native size regardless of rect", () => {
    const panel = makePanel();
    enableEmbed();
    // Regression: resizing the iframe's own CSS box directly made Twitch's
    // page re-layout at that (often tiny) size -- its chrome (the
    // "channel is offline" card, control bar icons) has some minimum size
    // it won't shrink below, so at a small on-screen size that chrome
    // visually dominated a now-tiny video instead of shrinking
    // proportionally with it, unlike the reference tool.
    for (const r of [
      { left: 0, top: 0, width: 1920, height: 1080 },
      { left: 0, top: 0, width: 300, height: 169 },
      { left: 0, top: 0, width: 4000, height: 2250 },
    ]) {
      panel.setScreenRect(r);
      expect(iframeEl().style.width).toBe("100%");
      expect(iframeEl().style.height).toBe("100%");
    }
  });
});

describe("StreamPreviewPanel -- interactive and opacity", () => {
  it("defaults to pointer-events none (click-through) so the canvas stays usable", () => {
    makePanel();
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("switches to pointer-events auto when interactive is checked", () => {
    makePanel();
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    expect(overlay.style.pointerEvents).toBe("auto");
  });

  it("disables pointer-events on canvas-inner when interactive is checked, so clicks reach the embed instead of being swallowed by it", () => {
    // Regression: #canvas-inner sits above the overlay in z-index (so
    // assets visually cover the embed), which also makes it the topmost
    // element hit-tested for clicks across the whole canvas area -- setting
    // pointer-events: auto on the overlay alone did nothing, because
    // canvas-inner still intercepted the click first.
    makePanel();
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    expect(canvasInner.style.pointerEvents).toBe("none");
  });

  it("restores canvas-inner's pointer-events when interactive is unchecked again", () => {
    makePanel();
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    checkbox("interactive").checked = false;
    checkbox("interactive").dispatchEvent(new Event("change"));
    expect(canvasInner.style.pointerEvents).toBe("");
  });

  it("maps the 0-100 opacity slider to a 0-1 CSS opacity on the overlay only", () => {
    makePanel();
    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "40";
    slider.dispatchEvent(new Event("input"));
    expect(overlay.style.opacity).toBe("0.4");
  });

  it("never applies opacity or pointer-events to the border -- it's a fixed alignment aid, not dimmable or clickable", () => {
    makePanel();
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "10";
    slider.dispatchEvent(new Event("input"));

    expect(borderEl.style.opacity).toBe("");
    expect(borderEl.style.pointerEvents).toBe("");
  });

  it("does not reassign iframe.src on a later render (e.g. an opacity change), which would reload and pause the embed", () => {
    const srcSetterSpy = vi.spyOn(window.HTMLIFrameElement.prototype, "src", "set");
    const panel = makePanel();
    configureTwitchChannel(panel, "shroud");

    enableEmbed();
    const assignCountAfterFirstLoad = srcSetterSpy.mock.calls.length;
    expect(assignCountAfterFirstLoad).toBeGreaterThan(0);

    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "50";
    slider.dispatchEvent(new Event("input"));

    // Regression: previously compared the freshly-computed URL against
    // `iframe.src` read back from the DOM -- a real embed page rewrites
    // that after load (session params, redirects), so the comparison
    // always looked like a "new" URL and reassigned src on every render,
    // reloading (and pausing) the embed on every single opacity tick.
    expect(srcSetterSpy.mock.calls.length).toBe(assignCountAfterFirstLoad);
    srcSetterSpy.mockRestore();
  });
});

describe("StreamPreviewPanel -- always-on-top border strips", () => {
  const THICKNESS = 6; // must match streamPreview.ts's own BORDER_STRIP_THICKNESS

  it("renders exactly four border strips (top/bottom/left/right)", () => {
    makePanel();
    const strips = borderEl.querySelectorAll(".stream-preview-border-strip");
    expect(strips).toHaveLength(4);
  });

  it("top/bottom strips extend past both corners (left/right offset outward by the strip thickness)", () => {
    // Regression: top/bottom strips previously spanned flush left:0/right:0,
    // leaving a THICKNESSxTHICKNESS gap at each corner where no strip
    // covered the boundary. They now extend past the corners by the same
    // negative offset as their own edge.
    makePanel();
    const strips = [...borderEl.querySelectorAll<HTMLElement>(".stream-preview-border-strip")];
    const topOrBottom = strips.filter((s) => s.style.height === `${THICKNESS}px`);
    expect(topOrBottom).toHaveLength(2);
    for (const strip of topOrBottom) {
      expect(strip.style.left).toBe(`-${THICKNESS}px`);
      expect(strip.style.right).toBe(`-${THICKNESS}px`);
    }
  });

  it("left/right strips stay flush (top:0 / bottom:0), so the two strip pairs never overlap at the corners", () => {
    // Overlap would double up backdrop-filter: invert() on that patch,
    // which cancels back out to no visible effect -- only one pair may
    // extend into the corner, and it's top/bottom (see the test above).
    makePanel();
    const strips = [...borderEl.querySelectorAll<HTMLElement>(".stream-preview-border-strip")];
    const leftOrRight = strips.filter((s) => s.style.width === `${THICKNESS}px`);
    expect(leftOrRight).toHaveLength(2);
    for (const strip of leftOrRight) {
      expect(strip.style.top).toBe("0px");
      expect(strip.style.bottom).toBe("0px");
    }
  });

  it("positions every strip entirely outside its own edge (negative offset), so only its inner edge touches the boundary", () => {
    // Regression: strips were previously inset flush with the edge (0, not
    // negative), meaning their own width/height ate into the visible
    // placeholder/embed area instead of only marking the boundary from
    // outside it.
    makePanel();
    const strips = [...borderEl.querySelectorAll<HTMLElement>(".stream-preview-border-strip")];
    const edgeOffsets = strips.map((s) => {
      const isTopOrBottom = s.style.height === `${THICKNESS}px`;
      return isTopOrBottom
        ? [s.style.top, s.style.bottom].find((v) => v === `-${THICKNESS}px`)
        : [s.style.left, s.style.right].find((v) => v === `-${THICKNESS}px`);
    });
    expect(edgeOffsets).toEqual([`-${THICKNESS}px`, `-${THICKNESS}px`, `-${THICKNESS}px`, `-${THICKNESS}px`]);
  });
});

describe("StreamPreviewPanel -- room-scoped settings, owner-only", () => {
  it("defaults to read-only: settings gear hidden (via visibility, not display) and platform select disabled", () => {
    // visibility (not display) -- the button's layout space must stay
    // reserved either way, so the header title stays centered regardless
    // of ownership (see setIsOwner's doc comment).
    makePanel();
    expect(root.querySelector<HTMLElement>('[data-role="settings"]')!.style.visibility).toBe("hidden");
    expect((root.querySelector('[data-role="platform"]') as HTMLSelectElement).disabled).toBe(true);
  });

  it("setIsOwner(true) reveals the settings gear and enables the platform select", () => {
    const panel = makePanel();
    panel.setIsOwner(true);
    expect(root.querySelector<HTMLElement>('[data-role="settings"]')!.style.visibility).toBe("visible");
    expect((root.querySelector('[data-role="platform"]') as HTMLSelectElement).disabled).toBe(false);
  });

  it("setIsOwner(false) after being true hides/disables again", () => {
    const panel = makePanel();
    panel.setIsOwner(true);
    panel.setIsOwner(false);
    expect(root.querySelector<HTMLElement>('[data-role="settings"]')!.style.visibility).toBe("hidden");
    expect((root.querySelector('[data-role="platform"]') as HTMLSelectElement).disabled).toBe(true);
  });

  it("a non-owner's platform select is disabled, so a change event never fires the callback", () => {
    const onSettingsChange = vi.fn();
    makePanel(makeCallbacks({ onSettingsChange }));
    const platformSelect = root.querySelector('[data-role="platform"]') as HTMLSelectElement;
    // Simulates a change event slipping through despite the disabled
    // attribute (defensive: the handler itself also checks isOwner).
    platformSelect.value = "youtube";
    platformSelect.dispatchEvent(new Event("change"));
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("the owner changing the platform select fires onSettingsChange with the updated settings", () => {
    const onSettingsChange = vi.fn();
    const panel = makePanel(makeCallbacks({ onSettingsChange }));
    panel.setIsOwner(true);

    const platformSelect = root.querySelector('[data-role="platform"]') as HTMLSelectElement;
    platformSelect.value = "youtube";
    platformSelect.dispatchEvent(new Event("change"));

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "youtube" }),
      expect.any(Number)
    );
  });

  it("the owner saving the settings modal fires onSettingsChange with both channels", () => {
    const onSettingsChange = vi.fn();
    const panel = makePanel(makeCallbacks({ onSettingsChange }));
    configureTwitchChannel(panel, "shroud");

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ twitchChannel: "shroud" }),
      expect.any(Number)
    );
  });

  it("openSettings does nothing for a non-owner even if the (hidden) button is somehow clicked", () => {
    makePanel();
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
    expect(settingsModal.style.display).not.toBe("flex");
  });
});

describe("StreamPreviewPanel -- applySettings (live broadcast within the same room)", () => {
  it("updates the settings, platform select, and embed URL", () => {
    const panel = makePanel();
    panel.applySettings({ platform: "youtube", twitchChannel: "", youtubeChannelId: "UCabc123" }, 1);

    expect((root.querySelector('[data-role="platform"]') as HTMLSelectElement).value).toBe("youtube");

    enableEmbed();
    expect(iframeEl().src).toContain("youtube.com/embed/live_stream?channel=UCabc123");
  });

  it("ignores a stale (older) seq than what's already applied", () => {
    const panel = makePanel();
    panel.applySettings({ platform: "youtube", twitchChannel: "", youtubeChannelId: "UCabc123" }, 100);
    panel.applySettings({ platform: "twitch", twitchChannel: "late-echo", youtubeChannelId: "" }, 5);

    expect((root.querySelector('[data-role="platform"]') as HTMLSelectElement).value).toBe("youtube");
  });

  it("applies a newer seq even if it arrives after a locally-initiated change (e.g. this browser's own echo)", () => {
    const panel = makePanel();
    panel.applySettings({ platform: "twitch", twitchChannel: "first", youtubeChannelId: "" }, 1);
    panel.applySettings({ platform: "twitch", twitchChannel: "second", youtubeChannelId: "" }, 2);

    configureTwitchChannel(panel, "third");
    enableEmbed();
    expect(iframeEl().src).toContain("channel=third");
  });

  // Regression: main.ts routes every room:snapshot AFTER the first through
  // applySettings (only the first per entry goes through enterRoom). The
  // periodic snapshot poll therefore lands here every few seconds, so
  // applySettings must NOT touch the local-only embed toggle -- otherwise a
  // poll would silently uncheck "embed" and tear down the iframe moments
  // after the user turned it on. enterRoom owns that reset; applySettings
  // leaves it alone.
  it("does not disturb a user-enabled embed toggle (so periodic poll snapshots don't tear down the iframe)", () => {
    const panel = makePanel();
    panel.applySettings({ platform: "twitch", twitchChannel: "chan", youtubeChannelId: "" }, 1);
    enableEmbed();
    expect(checkbox("embed").checked).toBe(true);
    expect(iframeEl().style.display).toBe("block");

    // A later poll snapshot for the same room arrives via applySettings.
    panel.applySettings({ platform: "twitch", twitchChannel: "chan", youtubeChannelId: "" }, 2);

    expect(checkbox("embed").checked).toBe(true);
    expect(iframeEl().style.display).toBe("block");
  });
});

describe("StreamPreviewPanel -- enterRoom (switching rooms)", () => {
  // Regression: this panel is a singleton that survives every room switch
  // (it's a sibling of #canvas-inner so CanvasView.dispose() never wipes
  // it -- see the class doc). Without a dedicated per-room reset, its state
  // from the PREVIOUS room leaked into the next one in three separate ways,
  // each covered below.
  it("applies the new room's settings even when its stored seq is LOWER than this browser's last-applied seq from a previous room", () => {
    const panel = makePanel();
    // Simulates having already applied a high seq while in a previous room.
    panel.applySettings({ platform: "twitch", twitchChannel: "old-room-channel", youtubeChannelId: "" }, 999);

    // The new room's own stored seq can easily be lower -- seq is a
    // per-room value, not shared across rooms.
    panel.enterRoom({ platform: "twitch", twitchChannel: "new-room-channel", youtubeChannelId: "" }, 5);

    enableEmbed();
    expect(iframeEl().src).toContain("channel=new-room-channel");
  });

  it("defaults the embed checkbox back to unticked", () => {
    const panel = makePanel();
    enableEmbed();
    expect(checkbox("embed").checked).toBe(true);

    panel.enterRoom({ platform: "twitch", twitchChannel: "", youtubeChannelId: "" }, 1);
    expect(checkbox("embed").checked).toBe(false);
  });

  it("resets interactive and opacity back to their defaults too", () => {
    const panel = makePanel();
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "30";
    slider.dispatchEvent(new Event("input"));

    panel.enterRoom({ platform: "twitch", twitchChannel: "", youtubeChannelId: "" }, 1);

    expect(checkbox("interactive").checked).toBe(false);
    expect((root.querySelector('[data-role="opacity"]') as HTMLInputElement).value).toBe("100");
  });

  it("does not carry over the previous room's already-loaded iframe src", () => {
    const panel = makePanel();
    configureTwitchChannel(panel, "old-room-channel");
    enableEmbed();
    expect(iframeEl().src).toContain("channel=old-room-channel");

    panel.enterRoom({ platform: "twitch", twitchChannel: "new-room-channel", youtubeChannelId: "" }, 1);
    enableEmbed(); // enterRoom already unticked it -- re-enable to check the src
    expect(iframeEl().src).toContain("channel=new-room-channel");
  });
});

describe("StreamPreviewPanel -- settings modal", () => {
  it("closes the settings modal on save without leaking a duplicate backdrop-close listener across opens", () => {
    const panel = makePanel();
    panel.setIsOwner(true);

    // Open/save/reopen twice -- if the backdrop-click listener were rebound
    // on every open() (rather than once in the constructor), this wouldn't
    // itself fail, but is exactly the scenario that regression would occur
    // in. Assert the modal is a clean, single-content state after each cycle.
    for (let i = 0; i < 2; i++) {
      root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
      expect(settingsModal.style.display).toBe("flex");
      settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));
      expect(settingsModal.style.display).toBe("none");
      expect(settingsModal.innerHTML).toBe("");
    }
  });

  it("closes when clicking the backdrop but not the content box", () => {
    const panel = makePanel();
    panel.setIsOwner(true);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    settingsModal.querySelector(".stream-settings-content")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("flex");

    settingsModal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("none");
  });
});
