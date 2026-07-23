import { Asset, Viewport } from "@scenette/protocol";

interface Entry {
  el: HTMLElement;
  asset: Asset;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.001;

export interface CanvasCallbacks {
  onAssetMove: (assetId: string, x: number, y: number) => void;
  onAssetDelete: (assetId: string) => void;
}

// The editing surface: a world-space plane containing the (fixed, per the
// plan — never user-movable) viewport rectangle and freely-draggable asset
// elements above it. Zoom/pan is local-only view state (see plan Q8: not
// synced between collaborators), so none of it is sent over the wire —
// only asset positions are.
export class CanvasView {
  private readonly entries = new Map<string, Entry>();
  private readonly world: HTMLElement;
  private readonly viewportRect: HTMLElement;
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };

  private pan = { x: 0, y: 0 };
  private zoom = 1;

  private selectedAssetId?: string;
  private dragging?: { assetId: string } | { panning: true };

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: CanvasCallbacks,
    private readonly assetsDomain: string
  ) {
    this.world = document.createElement("div");
    this.world.style.position = "absolute";
    this.world.style.transformOrigin = "0 0";
    this.container.appendChild(this.world);

    this.viewportRect = document.createElement("div");
    this.viewportRect.dataset.role = "viewport-rect";
    this.viewportRect.style.position = "absolute";
    this.viewportRect.style.border = "2px dashed rgba(255,255,255,0.6)";
    this.viewportRect.style.pointerEvents = "none";
    this.world.appendChild(this.viewportRect);

    this.applyWorldTransform();
    this.bindContainerEvents();
    this.bindKeyboard();
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.viewportRect.style.left = `${viewport.x}px`;
    this.viewportRect.style.top = `${viewport.y}px`;
    this.viewportRect.style.width = `${viewport.width}px`;
    this.viewportRect.style.height = `${viewport.height}px`;
  }

  getViewport(): Viewport {
    return this.viewport;
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
    if (!entry) {
      const el = this.createElement(asset);
      entry = { el, asset };
      this.entries.set(asset.assetId, entry);
      this.world.appendChild(el);
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
    if (this.selectedAssetId === assetId) this.selectedAssetId = undefined;
  }

  private applyTransform(el: HTMLElement, asset: Asset): void {
    el.style.left = `${asset.x}px`;
    el.style.top = `${asset.y}px`;
    el.style.width = `${asset.width}px`;
    el.style.height = `${asset.height}px`;
    el.style.transform = `rotate(${asset.rotation}deg)`;
    el.style.zIndex = String(asset.zIndex);
    el.style.outline = asset.assetId === this.selectedAssetId ? "2px solid #4da3ff" : "none";
  }

  private createElement(asset: Asset): HTMLElement {
    let el: HTMLElement;
    switch (asset.type) {
      case "image":
      case "gif": {
        const img = document.createElement("img");
        if (asset.s3Key) img.src = this.mediaUrl(asset.s3Key);
        el = img;
        break;
      }
      case "video": {
        const video = document.createElement("video");
        if (asset.s3Key) video.src = this.mediaUrl(asset.s3Key);
        video.controls = false;
        el = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("div");
        audio.textContent = "🔊 audio";
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
    el.dataset.assetId = asset.assetId;
    el.style.position = "absolute";
    el.style.cursor = "grab";
    el.addEventListener("mousedown", (event) => this.onAssetMouseDown(event, asset.assetId));
    return el;
  }

  private bindContainerEvents(): void {
    this.container.addEventListener("mousedown", (event) => {
      if (event.target === this.container || event.target === this.world) {
        this.dragging = { panning: true };
        this.selectedAssetId = undefined;
        this.refreshSelectionOutlines();
      }
    });

    window.addEventListener("mousemove", (event) => this.onMouseMove(event));
    window.addEventListener("mouseup", () => {
      this.dragging = undefined;
    });

    this.container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const next = this.zoom * (1 - event.deltaY * ZOOM_STEP);
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        this.applyWorldTransform();
      },
      { passive: false }
    );
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedAssetId) {
        this.callbacks.onAssetDelete(this.selectedAssetId);
      }
    });
  }

  private onAssetMouseDown(event: MouseEvent, assetId: string): void {
    event.stopPropagation();
    this.selectedAssetId = assetId;
    this.refreshSelectionOutlines();
    this.dragging = { assetId };
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.dragging) return;

    if ("panning" in this.dragging) {
      this.pan.x += event.movementX;
      this.pan.y += event.movementY;
      this.applyWorldTransform();
      return;
    }

    const entry = this.entries.get(this.dragging.assetId);
    if (!entry) return;

    // Screen-space mouse movement divided by zoom gives world-space delta —
    // deliberately independent of any container geometry (getBoundingClientRect
    // et al.), which keeps this correct under any layout and testable headlessly.
    const dx = event.movementX / this.zoom;
    const dy = event.movementY / this.zoom;
    entry.asset = { ...entry.asset, x: entry.asset.x + dx, y: entry.asset.y + dy };
    this.applyTransform(entry.el, entry.asset);
    this.callbacks.onAssetMove(entry.asset.assetId, entry.asset.x, entry.asset.y);
  }

  private refreshSelectionOutlines(): void {
    for (const entry of this.entries.values()) {
      entry.el.style.outline = entry.asset.assetId === this.selectedAssetId ? "2px solid #4da3ff" : "none";
    }
  }

  private applyWorldTransform(): void {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }

  // Media lives in the assets bucket/distribution, a completely separate
  // CloudFront distribution from the one serving this app itself — an
  // earlier version of this pointed at "/" + s3Key (relative to control-ui's
  // own origin), which 403'd since that bucket never had the object at all.
  private mediaUrl(s3Key: string): string {
    return `https://${this.assetsDomain}/${s3Key}`;
  }
}
