// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamPreviewPanel } from "../src/streamPreview";

let root: HTMLElement;
let overlay: HTMLElement;
let borderEl: HTMLElement;
let settingsModal: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  root = document.createElement("div");
  overlay = document.createElement("div");
  borderEl = document.createElement("div");
  settingsModal = document.createElement("div");
  document.body.append(root, overlay, borderEl, settingsModal);
});

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

function configureTwitchChannel(channel: string): void {
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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    expect(overlay.style.display).toBe("block");
    expect(borderEl.style.display).toBe("block");
  });

  it("stays visible after embed is checked and then unchecked again", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    enableEmbed();
    checkbox("embed").checked = false;
    checkbox("embed").dispatchEvent(new Event("change"));
    expect(overlay.style.display).toBe("block");
    expect(borderEl.style.display).toBe("block");
  });
});

describe("StreamPreviewPanel -- placeholder vs iframe", () => {
  it("shows the placeholder (not the iframe) by default, with embed unchecked", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
    expect(placeholderEl().querySelector("svg")).not.toBeNull();
  });

  it("still shows the placeholder when embed is checked but no channel is configured", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    enableEmbed();
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
  });

  it("switches to the iframe (hiding the placeholder) once a channel is configured AND embed is checked", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    configureTwitchChannel("shroud");
    enableEmbed();
    expect(iframeEl().style.display).toBe("block");
    expect(placeholderEl().style.display).toBe("none");
  });

  it("goes back to the placeholder if embed is unchecked again, even with a channel configured", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    configureTwitchChannel("shroud");
    enableEmbed();
    checkbox("embed").checked = false;
    checkbox("embed").dispatchEvent(new Event("change"));
    expect(placeholderEl().style.display).toBe("flex");
    expect(iframeEl().style.display).toBe("none");
  });

  it("the placeholder sits before the iframe in DOM order, so a configured embed naturally covers it", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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
    const panel = new StreamPreviewPanel(root, overlay, borderEl, settingsModal);

    panel.setScreenRect(rect);

    expect(overlay.style.left).toBe("10px");
    expect(overlay.style.top).toBe("20px");
    expect(borderEl.style.left).toBe("10px");
    expect(borderEl.style.top).toBe("20px");
  });

  it("scales both the overlay wrapper and the border wrapper by the same factor: rect.width / 1920", () => {
    const panel = new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    panel.setScreenRect({ left: 0, top: 0, width: 960, height: 540 });

    expect(wrapperTransform()).toBe("scale(0.5)");
    expect(borderWrapperTransform()).toBe("scale(0.5)");
  });

  it("scales to exactly 1 when the rect is already native-sized (1920x1080)", () => {
    const panel = new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    panel.setScreenRect({ left: 0, top: 0, width: NATIVE_WIDTH, height: 1080 });
    expect(wrapperTransform()).toBe("scale(1)");
  });

  it("never resizes the iframe's own CSS width/height -- always the fixed native size regardless of rect", () => {
    const panel = new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("switches to pointer-events auto when interactive is checked", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    expect(overlay.style.pointerEvents).toBe("auto");
  });

  it("maps the 0-100 opacity slider to a 0-1 CSS opacity on the overlay only", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "40";
    slider.dispatchEvent(new Event("input"));
    expect(overlay.style.opacity).toBe("0.4");
  });

  it("never applies opacity or pointer-events to the border -- it's a fixed alignment aid, not dimmable or clickable", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    configureTwitchChannel("shroud");

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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    const strips = borderEl.querySelectorAll(".stream-preview-border-strip");
    expect(strips).toHaveLength(4);
  });

  it("top/bottom strips extend past both corners (left/right offset outward by the strip thickness)", () => {
    // Regression: top/bottom strips previously spanned flush left:0/right:0,
    // leaving a THICKNESSxTHICKNESS gap at each corner where no strip
    // covered the boundary. They now extend past the corners by the same
    // negative offset as their own edge.
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
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

describe("StreamPreviewPanel -- settings persistence", () => {
  it("saves the entered channels to localStorage and loads a Twitch embed URL", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    configureTwitchChannel("shroud");

    const stored = JSON.parse(window.localStorage.getItem("scenette.streamPreview")!);
    expect(stored.twitchChannel).toBe("shroud");

    enableEmbed();

    expect(iframeEl().src).toContain("player.twitch.tv/?channel=shroud");
    expect(iframeEl().src).toContain(`parent=${window.location.hostname}`);
  });

  it("builds a YouTube live_stream embed URL from the saved channel ID when that platform is selected", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
    (settingsModal.querySelector('[data-role="youtube-channel"]') as HTMLInputElement).value = "UCabc123";
    settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));

    const platformSelect = root.querySelector('[data-role="platform"]') as HTMLSelectElement;
    platformSelect.value = "youtube";
    platformSelect.dispatchEvent(new Event("change"));

    enableEmbed();

    expect(iframeEl().src).toContain("youtube.com/embed/live_stream?channel=UCabc123");
  });

  it("loads previously-saved settings on construction", () => {
    window.localStorage.setItem(
      "scenette.streamPreview",
      JSON.stringify({ platform: "twitch", twitchChannel: "existing_streamer", youtubeChannelId: "" })
    );
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    const twitchInput = settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement;
    expect(twitchInput.value).toBe("existing_streamer");
  });

  it("closes the settings modal on save without leaking a duplicate backdrop-close listener across opens", () => {
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);

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
    new StreamPreviewPanel(root, overlay, borderEl, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    settingsModal.querySelector(".stream-settings-content")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("flex");

    settingsModal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("none");
  });
});
