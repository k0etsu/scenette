// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SoundPanel, SoundCallbacks } from "../src/sound";

function makeCallbacks(overrides: Partial<SoundCallbacks> = {}): SoundCallbacks {
  return {
    onGlobalVolumeChange: vi.fn(),
    onMultipliersChanged: vi.fn(),
    ...overrides,
  };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
  window.localStorage.clear();
});

function globalSlider(): HTMLInputElement {
  return root.querySelector('[data-role="global-slider"]') as HTMLInputElement;
}

function globalLabel(): string {
  return (root.querySelector('[data-role="global-label"]') as HTMLElement).textContent ?? "";
}

describe("SoundPanel local drag", () => {
  it("sends a strictly increasing seq on every drag tick", () => {
    const onGlobalVolumeChange = vi.fn();
    new SoundPanel(root, makeCallbacks({ onGlobalVolumeChange }));

    const slider = globalSlider();
    slider.value = "10";
    slider.dispatchEvent(new Event("input"));
    slider.value = "20";
    slider.dispatchEvent(new Event("input"));

    const calls = vi.mocked(onGlobalVolumeChange).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toBeGreaterThan(calls[0][1]);
  });

  it("updates the label live on every tick", () => {
    new SoundPanel(root, makeCallbacks());
    const slider = globalSlider();
    slider.value = "33";
    slider.dispatchEvent(new Event("input"));
    expect(globalLabel()).toContain("33%");
  });
});

describe("SoundPanel.setGlobalVolume (seq guard -- regression for the jump-back-after-release bug)", () => {
  it("ignores a stale/out-of-order echo whose seq is older than the local drag's latest tick", () => {
    const onMultipliersChanged = vi.fn();
    const panel = new SoundPanel(root, makeCallbacks({ onMultipliersChanged }));
    const slider = globalSlider();

    // Drag to 71% -- this generates and records a seq internally.
    slider.value = "71";
    slider.dispatchEvent(new Event("input"));
    expect(globalLabel()).toContain("71%");

    // A delayed broadcast echo of an EARLIER tick (68%, seq 1) arrives after
    // the 71% tick's own seq has already been recorded -- exactly what was
    // observed via frame-by-frame video inspection of the actual bug.
    panel.setGlobalVolume(0.68, 1);

    // Must NOT have snapped backward to 68%.
    expect(globalLabel()).toContain("71%");
    expect(slider.value).toBe("71");
  });

  it("applies an echo with a newer seq than the local drag", () => {
    const panel = new SoundPanel(root, makeCallbacks());
    const slider = globalSlider();
    slider.value = "50";
    slider.dispatchEvent(new Event("input"));

    panel.setGlobalVolume(0.9, Number.MAX_SAFE_INTEGER);

    expect(slider.value).toBe("90");
    expect(globalLabel()).toContain("90%");
  });

  it("applies the initial snapshot value when nothing has been dragged locally yet", () => {
    const panel = new SoundPanel(root, makeCallbacks());
    panel.setGlobalVolume(0.35, 0);
    expect(globalSlider().value).toBe("35");
  });

  it("recomputes the local preview's multipliers whenever an external update applies", () => {
    const onMultipliersChanged = vi.fn();
    const panel = new SoundPanel(root, makeCallbacks({ onMultipliersChanged }));
    panel.setGlobalVolume(0.6, 100);
    expect(onMultipliersChanged).toHaveBeenCalledWith(0.6, expect.any(Number));
  });
});

describe("local volume", () => {
  it("persists to localStorage and is restored on next construction", () => {
    new SoundPanel(root, makeCallbacks());
    const localSlider = root.querySelector('[data-role="local-slider"]') as HTMLInputElement;
    localSlider.value = "25";
    localSlider.dispatchEvent(new Event("input"));

    document.body.innerHTML = "";
    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    new SoundPanel(root2, makeCallbacks());
    const restoredSlider = root2.querySelector('[data-role="local-slider"]') as HTMLInputElement;
    expect(restoredSlider.value).toBe("25");
  });

  it("does not send any network message for a local-volume-only change", () => {
    const onGlobalVolumeChange = vi.fn();
    new SoundPanel(root, makeCallbacks({ onGlobalVolumeChange }));
    const localSlider = root.querySelector('[data-role="local-slider"]') as HTMLInputElement;
    localSlider.value = "10";
    localSlider.dispatchEvent(new Event("input"));
    expect(onGlobalVolumeChange).not.toHaveBeenCalled();
  });
});
