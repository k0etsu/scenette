import { Asset, Viewport } from "@scenette/protocol";

interface Entry {
  el: HTMLElement;
  asset: Asset;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.001;

// Caps how often a dragged asset's position is actually sent over the
// network — local rendering stays instant every mousemove regardless (see
// onMouseMove), but broadcasting every single pixel-delta event was
// flooding the WebSocket and, worse, our own echoed move kept arriving
// mid-drag and fighting with continued local movement, which is what made
// dragging feel laggy/rubber-banded.
const MOVE_SEND_THROTTLE_MS = 40;

export interface CanvasCallbacks {
  onAssetMove: (assetId: string, x: number, y: number) => void;
  onAssetDelete: (assetId: string) => void;
  // worldX/worldY: where a created asset should be placed. screenX/screenY:
  // viewport-relative coordinates for positioning the context menu itself.
  onContextMenu: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
}

// The editing surface: a world-space plane containing the (fixed, per the
// plan — never user-movable) viewport rectangle and freely-draggable asset
// elements above it. Zoom/pan is local-only view state (see plan Q8: not
// synced between collaborators), so none of it is sent over the wire —
// only asset positions are.
//
// Mouse bindings: left click selects/drags assets, middle click pans,
// scroll wheel zooms (anchored to the cursor), right click opens the
// create-asset context menu.
export class CanvasView {
  private readonly entries = new Map<string, Entry>();
  private readonly world: HTMLElement;
  private readonly viewportRect: HTMLElement;
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };

  private pan = { x: 0, y: 0 };
  private zoom = 1;

  private selectedAssetId?: string;
  private dragging?: { assetId: string } | { panning: true };
  private lastMoveSentAt = 0;

  // A high-polling-rate mouse can fire mousemove far more often than the
  // screen actually repaints (well past 60/sec) — writing to el.style on
  // every single event forces the browser to do that many layout/paint
  // passes, which is what made dragging feel laggy in practice even though
  // the network side was already throttled. Coalescing the DOM write to
  // once per animation frame (in-memory position still updates every
  // event, so nothing is lost) fixes that independently of network timing.
  private pendingRender?: () => void;
  private rafScheduled = false;

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

  // Applies a move that originated from the network (another collaborator,
  // or the server's echo of our own throttled send) — distinct from the
  // instant local application during an active drag in onMouseMove. If this
  // asset is the one currently being dragged locally, the update is
  // dropped: local optimistic state is authoritative mid-drag, and applying
  // a slightly-stale echoed position would fight with continued mousemove
  // deltas.
  applyRemoteMove(assetId: string, x: number, y: number, rotation: number, visible: boolean): void {
    if (this.dragging && "assetId" in this.dragging && this.dragging.assetId === assetId) return;
    const entry = this.entries.get(assetId);
    if (!entry) return;
    this.upsert({ ...entry.asset, x, y, rotation, visible });
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
        img.draggable = false;
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
      if (event.button === 1) {
        // Middle click pans regardless of what's under the cursor (even an
        // asset) — browsers auto-scroll on middle-click by default, so this
        // must be prevented or panning fights with that native behavior.
        event.preventDefault();
        this.dragging = { panning: true };
        return;
      }
      if (event.button === 0 && (event.target === this.container || event.target === this.world)) {
        this.selectedAssetId = undefined;
        this.refreshSelectionOutlines();
      }
    });

    window.addEventListener("mousemove", (event) => this.onMouseMove(event));
    window.addEventListener("mouseup", () => this.onMouseUp());

    this.container.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const rect = this.container.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const world = this.screenToWorld(screenX, screenY);
      this.callbacks.onContextMenu(world.x, world.y, screenX, screenY);
    });

    this.container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = this.container.getBoundingClientRect();
        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;

        // Cursor-centered zoom: find the world point currently under the
        // cursor, change zoom, then solve for the pan that keeps that same
        // world point under the same screen position.
        const worldUnderCursor = this.screenToWorld(screenX, screenY);
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * (1 - event.deltaY * ZOOM_STEP)));
        this.pan.x = screenX - worldUnderCursor.x * nextZoom;
        this.pan.y = screenY - worldUnderCursor.y * nextZoom;
        this.zoom = nextZoom;
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
    // Only left click selects/drags — middle click (panning) and right
    // click (context menu) both need to fall through to the container's
    // own handlers rather than being captured here.
    if (event.button !== 0) return;
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
      this.scheduleRender(() => this.applyWorldTransform());
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
    this.scheduleRender(() => this.applyTransform(entry.el, entry.asset));

    const now = performance.now();
    if (now - this.lastMoveSentAt >= MOVE_SEND_THROTTLE_MS) {
      this.lastMoveSentAt = now;
      this.callbacks.onAssetMove(entry.asset.assetId, entry.asset.x, entry.asset.y);
    }
  }

  private scheduleRender(render: () => void): void {
    this.pendingRender = render;
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.pendingRender?.();
      this.pendingRender = undefined;
    });
  }

  private onMouseUp(): void {
    if (this.dragging && "assetId" in this.dragging) {
      // Always flush the exact final position on release, bypassing the
      // throttle — otherwise the last few pixels of a drag could be lost if
      // the mouse-up lands inside the throttle window.
      const entry = this.entries.get(this.dragging.assetId);
      if (entry) {
        this.callbacks.onAssetMove(entry.asset.assetId, entry.asset.x, entry.asset.y);
      }
    }
    this.dragging = undefined;
  }

  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return { x: (screenX - this.pan.x) / this.zoom, y: (screenY - this.pan.y) / this.zoom };
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
  // CloudFront distribution from the one serving this app itself.
  private mediaUrl(s3Key: string): string {
    return `https://${this.assetsDomain}/${s3Key}`;
  }
}
