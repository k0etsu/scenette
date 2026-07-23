import { Asset, Viewport } from "@scenette/protocol";

// Renders viewport-relative coordinates: an asset at world position (x,y)
// is drawn at (x - viewport.x, y - viewport.y) so the OBS canvas only ever
// shows the fixed viewport window, regardless of where the room's assets
// sit in the wider world/canvas space.
interface Entry {
  el: HTMLElement;
  asset: Asset;
}

export class Renderer {
  private readonly entries = new Map<string, Entry>();
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };

  constructor(private readonly root: HTMLElement) {}

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.root.style.width = `${viewport.width}px`;
    this.root.style.height = `${viewport.height}px`;
    // Re-apply every asset's position in case the viewport itself moved
    // (shouldn't happen in v1 — it's static — but keeps this correct if that changes).
    for (const entry of this.entries.values()) {
      this.applyTransform(entry.el, entry.asset);
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
      entry = { el, asset };
      this.entries.set(asset.assetId, entry);
      this.root.appendChild(el);
    }
    entry.asset = asset;
    this.applyTransform(entry.el, asset);
  }

  remove(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry) {
      entry.el.remove();
      this.entries.delete(assetId);
    }
  }

  private applyTransform(el: HTMLElement, asset: Asset): void {
    const left = asset.x - this.viewport.x;
    const top = asset.y - this.viewport.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${asset.width}px`;
    el.style.height = `${asset.height}px`;
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
        img.src = asset.s3Key ? mediaUrl(asset.s3Key) : "";
        el = img;
        break;
      }
      case "video": {
        const video = document.createElement("video");
        video.src = asset.s3Key ? mediaUrl(asset.s3Key) : "";
        video.autoplay = true;
        video.loop = true;
        video.muted = false;
        el = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("audio");
        audio.src = asset.s3Key ? mediaUrl(asset.s3Key) : "";
        audio.autoplay = true;
        audio.loop = true;
        el = audio;
        break;
      }
      case "text": {
        el = document.createElement("div");
        break;
      }
    }
    el.dataset.assetType = asset.type;
    el.style.position = "absolute";
    el.style.objectFit = "contain";
    return el;
  }
}

function elementTypeOf(el: HTMLElement): string | undefined {
  return el.dataset.assetType;
}

// TODO(v1): the CloudFront distribution domain isn't wired through yet —
// this needs to become a build-time/runtime config value once control-ui's
// upload flow exists and there's a real asset to point at.
function mediaUrl(s3Key: string): string {
  return `/${s3Key}`;
}
