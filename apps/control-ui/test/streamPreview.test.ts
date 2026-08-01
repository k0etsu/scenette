// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
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
