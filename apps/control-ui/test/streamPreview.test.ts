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

const OVERSCAN = 1.08; // must match streamPreview.ts's own OVERSCAN constant

describe("StreamPreviewPanel -- fills the rect despite the video's fixed 16:9 aspect", () => {
  it("overscans both axes by the same margin when the rect is already exactly 16:9", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    panel.setScreenRect({ left: 0, top: 0, width: 1920, height: 1080 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    // Regression: sizing exactly to 100%/100% still left a sliver of the
    // dashed viewport border visible in practice (a real broadcast's
    // encoded aspect isn't always precisely 16:9, and Twitch's own player
    // page reserves a bit of its own layout around the video canvas) --
    // this deliberately bleeds past every edge instead.
    expect(parseFloat(iframe.style.width)).toBeCloseTo(OVERSCAN * 100, 5);
    expect(parseFloat(iframe.style.height)).toBeCloseTo(OVERSCAN * 100, 5);
  });

  it("oversizes height (not width) when the rect is wider than 16:9, so no horizontal gap is left", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    // 32:9 rect -- twice as wide as the video's own aspect.
    panel.setScreenRect({ left: 0, top: 0, width: 1600, height: 450 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(parseFloat(iframe.style.width)).toBeCloseTo(OVERSCAN * 100, 5);
    expect(parseFloat(iframe.style.height)).toBeCloseTo(2 * OVERSCAN * 100, 5);
  });

  it("oversizes width (not height) when the rect is taller/narrower than 16:9 (e.g. a square viewport)", () => {
    const panel = new StreamPreviewPanel(root, overlay, settingsModal);
    checkbox("embed").checked = true;
    checkbox("embed").dispatchEvent(new Event("change"));

    panel.setScreenRect({ left: 0, top: 0, width: 1000, height: 1000 });
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(parseFloat(iframe.style.height)).toBeCloseTo(OVERSCAN * 100, 5);
    expect(parseFloat(iframe.style.width)).toBeCloseTo((16 / 9) * OVERSCAN * 100, 1);
  });

  it("keeps the iframe centered via a translate transform, independent of rect size", () => {
    new StreamPreviewPanel(root, overlay, settingsModal);
    const iframe = overlay.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.top).toBe("50%");
    expect(iframe.style.left).toBe("50%");
    expect(iframe.style.transform).toBe("translate(-50%, -50%)");
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
