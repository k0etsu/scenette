// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamPreviewPanel } from "../src/streamPreview";

let root: HTMLElement;
let overlay: HTMLElement;
let settingsModal: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  root = document.createElement("div");
  overlay = document.createElement("div");
  settingsModal = document.createElement("div");
  document.body.append(root, overlay, settingsModal);
});

function checkbox(role: string): HTMLInputElement {
  return root.querySelector(`[data-role="${role}"]`) as HTMLInputElement;
}

const rect = { left: 10, top: 20, width: 300, height: 200 };

describe("StreamPreviewPanel -- visibility and positioning", () => {
  it("starts with the overlay hidden", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    expect(overlay.style.display).toBe("none");
  });

  it("draws a border on the overlay itself, box-sizing: border-box, so it's a self-consistent boundary", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    // Regression: previously relied on canvas.ts's own dashed viewport-rect
    // line (a *different* element) to visually confirm the overlay's
    // bounds -- any mismatch between that element's border-box math and
    // this one's made the preview look like it didn't fill (or overflowed
    // past) the "real" boundary. Drawing the border directly on this same
    // element, with border-box so the border doesn't add extra size beyond
    // the rect, removes that cross-element alignment risk entirely.
    expect(overlay.style.boxSizing).toBe("border-box");
    expect(overlay.style.border).not.toBe("");
  });

  it("shows the overlay once embed is checked", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));
    expect(overlay.style.display).toBe("block");
  });

  it("positions the overlay from setScreenRect only while embed is on", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);

    panel.setScreenRect(rect);
    // Not shown yet -- position updates are still tracked internally but
    // shouldn't matter until the overlay actually becomes visible.
    expect(overlay.style.left).toBe("");

    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));
    panel.setScreenRect(rect);

    expect(overlay.style.left).toBe("10px");
    expect(overlay.style.top).toBe("20px");
    expect(overlay.style.width).toBe("300px");
    expect(overlay.style.height).toBe("200px");
  });

  it("applies whatever rect was last set the moment embed is turned on", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    panel.setScreenRect(rect);

    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    expect(overlay.style.left).toBe("10px");
  });
});

describe("StreamPreviewPanel -- interactive and opacity", () => {
  it("defaults to pointer-events none (click-through) so the canvas stays usable", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("switches to pointer-events auto when interactive is checked", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("interactive").checked = true;
    checkbox("interactive").dispatchEvent(new Event("change"));
    expect(overlay.style.pointerEvents).toBe("auto");
  });

  it("maps the 0-100 opacity slider to a 0-1 CSS opacity", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    const slider = root.querySelector('[data-role="opacity"]') as HTMLInputElement;
    slider.value = "40";
    slider.dispatchEvent(new Event("input"));
    expect(overlay.style.opacity).toBe("0.4");
  });

  it("does not reassign iframe.src on a later render (e.g. an opacity change), which would reload and pause the embed", () => {
    const srcSetterSpy = vi.spyOn(window.HTMLIFrameElement.prototype, "src", "set");
    new StreamPreviewPanel(root, overlay, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
    (settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement).value = "shroud";
    settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));

    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));
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

const NATIVE_WIDTH = 1920; // must match streamPreview.ts's own NATIVE_WIDTH/HEIGHT
const NATIVE_HEIGHT = 1080;

function scaleOf(iframe: HTMLIFrameElement): number {
  const match = iframe.style.transform.match(/scale\(([\d.]+)\)/);
  return match ? parseFloat(match[1]) : NaN;
}

describe("StreamPreviewPanel -- fills the rect via transform scale, not by resizing the iframe box", () => {
  it("never changes the iframe's own CSS width/height -- always the fixed native size", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    // Regression: resizing the iframe's own CSS box directly made Twitch's
    // page re-layout at that (often tiny) size -- its chrome (the
    // "channel is offline" card, control bar icons) has some minimum size
    // it won't shrink below, so at a small on-screen size that chrome
    // visually dominated a now-tiny video instead of shrinking
    // proportionally with it, unlike the reference tool. Keeping the
    // iframe's own box at a constant native size (letting Twitch always
    // render its normal, fully-proportioned desktop UI) and scaling the
    // whole already-rendered result via CSS transform instead fixes that,
    // since transform never triggers Twitch's own internal re-layout.
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    for (const rect of [
      { left: 0, top: 0, width: 1920, height: 1080 },
      { left: 0, top: 0, width: 300, height: 169 }, // zoomed way out
      { left: 0, top: 0, width: 4000, height: 2250 }, // zoomed way in
    ]) {
      panel.setScreenRect(rect);
      expect(iframe.style.width).toBe(`${NATIVE_WIDTH}px`);
      expect(iframe.style.height).toBe(`${NATIVE_HEIGHT}px`);
    }
  });

  it("scales to exactly 1 when the rect is already native-sized (16:9, 1920x1080)", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    panel.setScreenRect({ left: 0, top: 0, width: 1920, height: 1080 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(scaleOf(iframe)).toBeCloseTo(1, 5);
  });

  it("scales down proportionally when zoomed out to a small on-screen rect", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    // Half native size, still exactly 16:9.
    panel.setScreenRect({ left: 0, top: 0, width: 960, height: 540 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(scaleOf(iframe)).toBeCloseTo(0.5, 5);
  });

  it("uses the smaller of the two axis ratios (contain, not cover) when the rect's aspect differs from 16:9", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    // Square rect: height ratio (1000/1080 ≈ 0.926) is larger than width
    // ratio (1000/1920 ≈ 0.521) -- width is the binding constraint here,
    // since using the larger (height) ratio would make the video's
    // native-16:9 width exceed the rect's own width, overlapping past its
    // left/right edges. Landing at most slightly short (a thin letterbox
    // on the vertical axis) rather than overlapping is the deliberate
    // choice -- see applyRect()'s comment.
    panel.setScreenRect({ left: 0, top: 0, width: 1000, height: 1000 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    const expectedScale = Math.min(1000 / NATIVE_WIDTH, 1000 / NATIVE_HEIGHT);
    expect(scaleOf(iframe)).toBeCloseTo(expectedScale, 5);
  });

  it("keeps the iframe centered via a translate transform, independent of rect size", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.top).toBe("50%");
    expect(iframe.style.left).toBe("50%");
    expect(iframe.style.transform).toContain("translate(-50%, -50%)");
  });
});

describe("StreamPreviewPanel -- settings persistence", () => {
  it("saves the entered channels to localStorage and loads a Twitch embed URL", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    const twitchInput = settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement;
    twitchInput.value = "shroud";
    settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));

    // Persisted for next load.
    const stored = JSON.parse(window.localStorage.getItem("scenette.streamPreview")!);
    expect(stored.twitchChannel).toBe("shroud");

    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("player.twitch.tv/?channel=shroud");
    expect(iframe.src).toContain(`parent=${window.location.hostname}`);
    void panel;
  });

  it("builds a YouTube live_stream embed URL from the saved channel ID when that platform is selected", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));
    (settingsModal.querySelector('[data-role="youtube-channel"]') as HTMLInputElement).value = "UCabc123";
    settingsModal.querySelector('[data-role="save"]')!.dispatchEvent(new Event("click"));

    const platformSelect = root.querySelector('[data-role="platform"]') as HTMLSelectElement;
    platformSelect.value = "youtube";
    platformSelect.dispatchEvent(new Event("change"));

    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("youtube.com/embed/live_stream?channel=UCabc123");
  });

  it("loads previously-saved settings on construction", () => {
    window.localStorage.setItem(
      "scenette.streamPreview",
      JSON.stringify({ platform: "twitch", twitchChannel: "existing_streamer", youtubeChannelId: "" })
    );
    new StreamPreviewPanel(root, overlay, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    const twitchInput = settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement;
    expect(twitchInput.value).toBe("existing_streamer");
  });

  it("closes the settings modal on save without leaking a duplicate backdrop-close listener across opens", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);

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
    new StreamPreviewPanel(root, overlay, settingsModal);
    root.querySelector('[data-role="settings"]')!.dispatchEvent(new Event("click"));

    settingsModal.querySelector(".stream-settings-content")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("flex");

    settingsModal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(settingsModal.style.display).toBe("none");
  });
});
