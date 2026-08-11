import { ICON_AUDIO, ICON_CHECK_CIRCLE, ICON_CHEVRON_DOWN, ICON_IMAGE, ICON_VIDEO, ICON_X_CIRCLE } from "./icons";

// Finished rows linger briefly so a fast upload's completion is actually
// seen, then clear themselves -- failures stay up longer since the error
// text needs to be read, not just glanced at.
const DONE_ROW_LINGER_MS = 4000;
const FAILED_ROW_LINGER_MS = 12000;

export interface UploadHandle {
  succeed(): void;
  fail(message: string): void;
}

interface Entry {
  row: HTMLElement;
  statusEl: HTMLElement;
  state: "uploading" | "done" | "failed";
  objectUrl?: string;
  removeTimer?: ReturnType<typeof setTimeout>;
}

// Floating card over the canvas showing every in-flight upload (spinner)
// until it lands (check) or fails (cross + error text). Uploads have no
// other visible presence until asset:add round-trips through the server, so
// without this a slow upload looks like the click simply didn't work.
export class UploadIndicator {
  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly entries = new Set<Entry>();

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="upload-indicator-list"></div>
      <div class="upload-indicator-footer">
        <span class="upload-indicator-summary"></span>
        <span class="upload-indicator-chevron">${ICON_CHEVRON_DOWN}</span>
      </div>
    `;
    this.list = root.querySelector(".upload-indicator-list")!;
    this.summary = root.querySelector(".upload-indicator-summary")!;

    // The whole card is the toggle target (matching the reference tool),
    // not just the chevron -- collapsed it shrinks to a small round button
    // in the bottom-right corner (see #upload-indicator's collapsed CSS)
    // whose entire face needs to be clickable, and making only the
    // expanded state's tiny chevron clickable would leave the two states
    // inconsistent. The chevron is purely a visual affordance.
    root.addEventListener("click", () => {
      this.setCollapsed(!root.classList.contains("upload-indicator-collapsed"));
    });

    // Always present, idling as the minimized round button until an upload
    // starts -- rather than appearing/disappearing entirely, which read as
    // the panel being broken when nothing was in flight.
    this.setCollapsed(true);
    this.updateSummary();
  }

  private setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("upload-indicator-collapsed", collapsed);
    this.root.title = collapsed ? "Expand" : "Collapse";
  }

  begin(file: File): UploadHandle {
    const entry: Entry = { row: document.createElement("div"), statusEl: document.createElement("span"), state: "uploading" };
    return this.start(entry, file.name, this.buildThumbnail(file, entry));
  }

  // Same row/spinner UI, for an upload whose bytes never touch the client
  // (see upload.ts's uploadFromUrl) -- there's no File to read a name or
  // build a real thumbnail from, so this shows the URL's last path segment
  // and previews directly from the source URL. Rendering an <img> doesn't
  // need CORS (only pixel readback, e.g. via canvas, would), so this works
  // even though the client can't fetch the URL's bytes itself.
  beginFromUrl(sourceUrl: string): UploadHandle {
    const entry: Entry = { row: document.createElement("div"), statusEl: document.createElement("span"), state: "uploading" };
    return this.start(entry, this.nameFromUrl(sourceUrl), this.buildUrlThumbnail(sourceUrl));
  }

  private start(entry: Entry, name: string, thumbnail: HTMLElement): UploadHandle {
    entry.row.className = "upload-row";
    entry.statusEl.className = "upload-row-status";
    entry.statusEl.innerHTML = '<span class="upload-spinner"></span>';

    const nameEl = document.createElement("span");
    nameEl.className = "upload-row-name";
    nameEl.textContent = name;
    nameEl.title = name;

    entry.row.append(entry.statusEl, thumbnail, nameEl);
    this.list.appendChild(entry.row);
    this.entries.add(entry);
    // A new upload always expands the card so progress is visible without
    // any interaction -- even if the user had minimized it earlier.
    this.setCollapsed(false);
    this.updateSummary();

    return {
      succeed: () => this.finish(entry, "done"),
      fail: (message) => this.finish(entry, "failed", message),
    };
  }

  private nameFromUrl(sourceUrl: string): string {
    try {
      const last = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() ?? "");
      return last.length > 0 ? last : sourceUrl;
    } catch {
      return sourceUrl;
    }
  }

  private buildUrlThumbnail(sourceUrl: string): HTMLElement {
    const img = document.createElement("img");
    img.className = "upload-thumb";
    // Not every pasted URL is actually an image (video/gif URLs still are;
    // audio/video previews just fail to decode) -- fall back to the generic
    // icon rather than leaving a broken-image glyph in a transient row.
    img.onerror = () => img.replaceWith(this.iconThumb());
    img.src = sourceUrl;
    return img;
  }

  private iconThumb(kind: "image" | "video" | "audio" = "image"): HTMLElement {
    const icon = document.createElement("span");
    icon.className = "upload-thumb upload-thumb-icon";
    icon.innerHTML = kind === "video" ? ICON_VIDEO : kind === "audio" ? ICON_AUDIO : ICON_IMAGE;
    return icon;
  }

  // Room switches don't cancel in-flight uploads (handleUpload already
  // captured its room), so entries are left alone -- this only exists so a
  // full teardown can revoke thumbnail object URLs and pending timers.
  dispose(): void {
    for (const entry of this.entries) {
      if (entry.removeTimer) clearTimeout(entry.removeTimer);
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
    this.entries.clear();
    this.list.innerHTML = "";
    this.setCollapsed(true);
    this.updateSummary();
  }

  private buildThumbnail(file: File, entry: Entry): HTMLElement {
    // Only images/gifs get a real pixel preview -- decoding a video for a
    // poster frame isn't worth it for a transient row, and audio has none.
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "upload-thumb";
      entry.objectUrl = URL.createObjectURL(file);
      img.src = entry.objectUrl;
      return img;
    }
    return this.iconThumb(file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image");
  }

  private finish(entry: Entry, state: "done" | "failed", message?: string): void {
    if (entry.state !== "uploading") return;
    entry.state = state;
    entry.statusEl.classList.add(state);
    entry.statusEl.innerHTML = state === "done" ? ICON_CHECK_CIRCLE : ICON_X_CIRCLE;

    if (state === "failed" && message) {
      const error = document.createElement("div");
      error.className = "upload-row-error";
      error.textContent = message;
      entry.row.appendChild(error);
    }

    entry.removeTimer = setTimeout(
      () => this.remove(entry),
      state === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS
    );
    this.updateSummary();
  }

  private remove(entry: Entry): void {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.row.remove();
    this.entries.delete(entry);
    // Back to the idle minimized button once the last lingering row clears
    // -- the card stays on screen, it never fully hides. A user who
    // expanded it manually while idle keeps it open (nothing was removed).
    if (this.entries.size === 0) this.setCollapsed(true);
    this.updateSummary();
  }

  private updateSummary(): void {
    const uploading = [...this.entries].filter((e) => e.state === "uploading").length;
    const failed = [...this.entries].filter((e) => e.state === "failed").length;
    this.summary.textContent =
      uploading > 0
        ? `uploading ${uploading} file${uploading === 1 ? "" : "s"}...`
        : failed > 0
          ? `${failed} upload${failed === 1 ? "" : "s"} failed`
          : this.entries.size > 0
            ? "uploads complete"
            : "no active uploads";
  }
}
