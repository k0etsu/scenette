// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UploadIndicator } from "../src/uploadIndicator";

function makeFile(name: string, type: string): File {
  return new File(["data"], name, { type });
}

let root: HTMLElement;
let indicator: UploadIndicator;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom doesn't implement object URLs -- stub the pair the thumbnail
  // path uses so image files exercise the real code path.
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  }));
  root = document.createElement("div");
  document.body.appendChild(root);
  indicator = new UploadIndicator(root);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  root.remove();
});

describe("UploadIndicator", () => {
  it("idles minimized, then expands with a spinner row when an upload starts", () => {
    // Present from construction as the minimized round button -- never
    // hidden outright, so the panel doesn't look broken between uploads.
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(true);

    indicator.begin(makeFile("clip.mp4", "video/mp4"));

    expect(root.classList.contains("upload-indicator-collapsed")).toBe(false);
    const row = root.querySelector(".upload-row")!;
    expect(row.querySelector(".upload-spinner")).not.toBeNull();
    expect(row.querySelector(".upload-row-name")!.textContent).toBe("clip.mp4");
  });

  it("re-expands for a new upload even after being manually minimized", () => {
    indicator.begin(makeFile("a.png", "image/png"));
    root.click();
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(true);

    indicator.begin(makeFile("b.png", "image/png"));
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(false);
  });

  it("uses an object-URL thumbnail for images", () => {
    indicator.begin(makeFile("cat.jpg", "image/jpeg"));
    const thumb = root.querySelector<HTMLImageElement>("img.upload-thumb")!;
    expect(thumb.src).toBe("blob:fake");
  });

  it("marks a row done on success and removes it after the linger period", () => {
    const handle = indicator.begin(makeFile("cat.jpg", "image/jpeg"));
    handle.succeed();

    const status = root.querySelector(".upload-row-status")!;
    expect(status.classList.contains("done")).toBe(true);
    expect(root.querySelector(".upload-spinner")).toBeNull();

    vi.advanceTimersByTime(4000);
    expect(root.querySelector(".upload-row")).toBeNull();
    // Empty again -- back to the idle minimized button (still on screen,
    // never hidden) and the thumbnail URL is released.
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("shows the error message on failure and keeps it up longer", () => {
    const handle = indicator.begin(makeFile("big.mp4", "video/mp4"));
    handle.fail("Storage quota exceeded for this room");

    const status = root.querySelector(".upload-row-status")!;
    expect(status.classList.contains("failed")).toBe(true);
    expect(root.querySelector(".upload-row-error")!.textContent).toBe("Storage quota exceeded for this room");

    // Still visible after the success linger window...
    vi.advanceTimersByTime(4000);
    expect(root.querySelector(".upload-row")).not.toBeNull();
    // ...gone after the failure one.
    vi.advanceTimersByTime(8000);
    expect(root.querySelector(".upload-row")).toBeNull();
  });

  it("tracks concurrent uploads independently", () => {
    const first = indicator.begin(makeFile("a.png", "image/png"));
    indicator.begin(makeFile("b.png", "image/png"));

    first.succeed();
    vi.advanceTimersByTime(4000);

    // The finished row cleared; the in-flight one remains and the card
    // stays expanded (it only re-minimizes once every row is gone).
    const rows = root.querySelectorAll(".upload-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".upload-row-name")!.textContent).toBe("b.png");
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(false);
  });

  it("toggles collapsed each time the card itself is clicked", () => {
    indicator.begin(makeFile("a.png", "image/png"));

    root.click();
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(true);
    expect(root.title).toBe("Expand");

    root.click();
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(false);
    expect(root.title).toBe("Collapse");
  });

  it("a click on the chevron toggles exactly once (bubbles to the card's single listener)", () => {
    indicator.begin(makeFile("a.png", "image/png"));
    root.querySelector<HTMLElement>(".upload-indicator-chevron")!.click();
    expect(root.classList.contains("upload-indicator-collapsed")).toBe(true);
  });

  it("keeps the footer summary line current", () => {
    expect(root.querySelector(".upload-indicator-summary")!.textContent).toBe("no active uploads");
    indicator.begin(makeFile("a.png", "image/png"));
    expect(root.querySelector(".upload-indicator-summary")!.textContent).toBe("uploading 1 file...");
  });
});
