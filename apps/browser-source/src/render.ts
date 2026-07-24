import { Asset, Viewport } from "@scenette/protocol";

// Renders viewport-relative coordinates: an asset at world position (x,y)
// is drawn at (x - viewport.x, y - viewport.y) so the OBS canvas only ever
// shows the fixed viewport window, regardless of where the room's assets
// sit in the wider world/canvas space.
interface Entry {
  el: HTMLElement;
  asset: Asset; // latest known true state (the interpolation target)
  rendered: { x: number; y: number; width: number; height: number }; // what's actually on screen right now
}

// Position/size updates arrive discretely (throttled to ~25/sec on the
// sender's end) rather than every frame — snapping straight to each new
// value on arrival looks like exactly what it is, a series of jumps.
// Interpolating the *rendered* position toward the latest target every
// animation frame turns those discrete updates into continuous-looking
// motion without needing more network traffic. Only geometry is smoothed;
// rotation/visibility/z-index apply immediately since there's nothing
// visually jarring about those changing in a single step.
const SMOOTHING_FACTOR = 0.3;
const SNAP_EPSILON = 0.5;

export class Renderer {
  private readonly entries = new Map<string, Entry>();
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };
  private animationRunning = false;

  constructor(private readonly root: HTMLElement, private readonly assetsDomain: string) {}

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.root.style.width = `${viewport.width}px`;
    this.root.style.height = `${viewport.height}px`;
    // Re-apply every asset's position in case the viewport itself moved
    // (shouldn't happen in v1 — it's static — but keeps this correct if that changes).
    for (const entry of this.entries.values()) {
      this.paint(entry);
    }
  }

  get(assetId: string): Asset | undefined {
    return this.entries.get(assetId)?.asset;
  }

  setAssets(assets: Asset[]): void {
    const seen = new Set<string>();
    for (const asset of assets) {
      seen.add(asset.assetId);
      this.upsert(asset);
    }
    for (const [assetId, entry] of this.entries) {
      if (!seen.has(assetId)) {
        entry.el.remove();
        this.entries.delete(assetId);
      }
    }
  }

  upsert(asset: Asset): void {
    let entry = this.entries.get(asset.assetId);
    if (!entry || elementTypeOf(entry.el) !== asset.type) {
      // Type shouldn't change on an existing asset, but rebuild defensively rather
      // than leave a mismatched element (e.g. an <img> meant to be a <video>).
      entry?.el.remove();
      const el = this.createElement(asset);
      entry = { el, asset, rendered: { x: asset.x, y: asset.y, width: asset.width, height: asset.height } };
      this.entries.set(asset.assetId, entry);
      this.root.appendChild(el);
      this.paint(entry); // first appearance snaps immediately, nothing to interpolate from
      return;
    }
    entry.asset = asset;
    this.applyImmediateFields(entry);
    this.ensureAnimating();
  }

  remove(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry) {
      entry.el.remove();
      this.entries.delete(assetId);
    }
  }

  private ensureAnimating(): void {
    if (this.animationRunning) return;
    this.animationRunning = true;
    requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    let anyMoving = false;
    for (const entry of this.entries.values()) {
      const { rendered, asset } = entry;
      const dx = asset.x - rendered.x;
      const dy = asset.y - rendered.y;
      const dw = asset.width - rendered.width;
      const dh = asset.height - rendered.height;

      if (Math.abs(dx) < SNAP_EPSILON && Math.abs(dy) < SNAP_EPSILON && Math.abs(dw) < SNAP_EPSILON && Math.abs(dh) < SNAP_EPSILON) {
        rendered.x = asset.x;
        rendered.y = asset.y;
        rendered.width = asset.width;
        rendered.height = asset.height;
      } else {
        rendered.x += dx * SMOOTHING_FACTOR;
        rendered.y += dy * SMOOTHING_FACTOR;
        rendered.width += dw * SMOOTHING_FACTOR;
        rendered.height += dh * SMOOTHING_FACTOR;
        anyMoving = true;
      }
      this.paint(entry);
    }

    if (anyMoving) {
      requestAnimationFrame(() => this.tick());
    } else {
      // Stop the loop when everything's settled — no point spending CPU/battery
      // animating a static scene, which is exactly what this renders most of the time.
      this.animationRunning = false;
    }
  }

  private paint(entry: Entry): void {
    const { el, asset, rendered } = entry;
    const left = rendered.x - this.viewport.x;
    const top = rendered.y - this.viewport.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;
    el.style.transform = `rotate(${asset.rotation}deg)`;
    el.style.zIndex = String(asset.zIndex);
    el.style.display = asset.visible ? "block" : "none";
  }

  private applyImmediateFields(entry: Entry): void {
    const { el, asset } = entry;
    el.style.transform = `rotate(${asset.rotation}deg)`;
    el.style.zIndex = String(asset.zIndex);
    el.style.display = asset.visible ? "block" : "none";
    if (asset.type === "text" && el.textContent !== asset.text) {
      el.textContent = asset.text ?? "";
    }
  }

  private createElement(asset: Asset): HTMLElement {
    let el: HTMLElement;
    switch (asset.type) {
      case "image":
      case "gif": {
        const img = document.createElement("img");
        img.src = asset.s3Key ? this.mediaUrl(asset.s3Key) : "";
        el = img;
        break;
      }
      case "video": {
        const video = document.createElement("video");
        video.src = asset.s3Key ? this.mediaUrl(asset.s3Key) : "";
        video.autoplay = true;
        video.loop = true;
        video.muted = false;
        el = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("audio");
        audio.src = asset.s3Key ? this.mediaUrl(asset.s3Key) : "";
        audio.autoplay = true;
        audio.loop = true;
        el = audio;
        break;
      }
      case "text": {
        el = document.createElement("div");
        el.textContent = asset.text ?? "";
        break;
      }
    }
    el.dataset.assetType = asset.type;
    el.style.position = "absolute";
    el.style.objectFit = "contain";
    return el;
  }

  // Media lives in the assets bucket/distribution, a completely separate
  // CloudFront distribution from the one serving this app itself.
  private mediaUrl(s3Key: string): string {
    return `https://${this.assetsDomain}/${s3Key}`;
  }
}

function elementTypeOf(el: HTMLElement): string | undefined {
  return el.dataset.assetType;
}
