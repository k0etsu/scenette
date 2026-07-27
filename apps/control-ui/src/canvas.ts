import { Asset, AssetPatch, Variable, Viewport, interpolateText } from "@scenette/protocol";
import { ICON_AUDIO_LARGE } from "./icons";

interface Entry {
  el: HTMLElement;
  // The actual visual content (img/video/audio icon/text), one level inside
  // `el`. Blur is applied here rather than on `el` itself -- a CSS filter
  // blurs everything painted for the element it's on, including outline, so
  // applying it to `el` (which also carries the selection outline) blurred
  // the selection indicator right along with the asset, making it useless
  // for judging exactly how blurred the asset itself looks.
  content: HTMLElement;
  asset: Asset;
}

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const CORNER_CURSOR: Record<Corner, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.001;
const MIN_ASSET_SIZE = 20;

// Caps how often a dragged/resized asset's transform is actually sent over
// the network — local rendering stays instant every mousemove regardless
// (see onMouseMove), but broadcasting every single pixel-delta event was
// flooding the WebSocket and, worse, our own echoed update kept arriving
// mid-drag and fighting with continued local movement.
const MOVE_SEND_THROTTLE_MS = 40;

export interface CanvasCallbacks {
  onAssetMove: (assetId: string, x: number, y: number, seq: number) => void;
  onAssetResize: (assetId: string, x: number, y: number, width: number, height: number, seq: number) => void;
  onAssetPatch: (assetId: string, patch: AssetPatch, seq: number) => void;
  onAssetDelete: (assetId: string) => void;
  // worldX/worldY: where a created asset should be placed. screenX/screenY:
  // viewport-relative coordinates for positioning the context menu itself.
  onContextMenu: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
  // Fires on every selection change, including deselection (undefined) and
  // programmatic selection via selectAsset() -- lets the sidebar's
  // properties panel track whatever's selected on the canvas, and vice versa.
  onSelectionChange: (assetId: string | undefined) => void;
}

// The editing surface: a world-space plane containing the (fixed, per the
// plan — never user-movable) viewport rectangle and freely-draggable,
// resizable asset elements above it. Zoom/pan is local-only view state (see
// plan Q8: not synced between collaborators), so none of it is sent over
// the wire — only asset transforms are.
//
// Mouse bindings: left click selects/drags assets (or drags a corner handle
// to resize the selected one), middle click pans, scroll wheel zooms
// (anchored to the cursor), right click opens the create-asset context menu.
export class CanvasView {
  private readonly entries = new Map<string, Entry>();
  private readonly world: HTMLElement;
  private readonly viewportRect: HTMLElement;
  private readonly handles: Record<Corner, HTMLElement>;
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };

  private pan = { x: 0, y: 0 };
  private zoom = 1;

  private selectedAssetId?: string;
  private dragging?: { assetId: string } | { panning: true } | { resizing: { assetId: string; corner: Corner } };
  private lastMoveSentAt = 0;

  // Room-level master (synced, affects browser-source too) and this user's
  // own local-only monitoring level -- see sound.ts. Multiplied together
  // with each video asset's own volume to get what actually plays in this
  // preview; browser-source only ever applies globalVolume, never local.
  private globalVolume = 1;
  private localVolume = 1;
  private variables: Record<string, Variable> = {};

  // A high-polling-rate mouse can fire mousemove far more often than the
  // screen actually repaints (well past 60/sec) — writing to el.style on
  // every single event forces the browser to do that many layout/paint
  // passes, which is what made dragging feel laggy in practice even though
  // the network side was already throttled. Coalescing the DOM write to
  // once per animation frame (in-memory position still updates every
  // event, so nothing is lost) fixes that independently of network timing.
  private pendingRender?: () => void;
  private rafScheduled = false;

  // Wall-clock-based, NOT a simple session-local counter starting at 0 --
  // that was the original (buggy) design: server-stored seq persists across
  // page reloads and across every other collaborator's session, so a fresh
  // session's counter restarting at 0/1/2... is almost always *lower* than
  // whatever's already stored, which made the server's conditional write
  // (correctly) reject every move as stale forever after a refresh. Basing
  // it on Date.now() means any new session's clock already exceeds
  // whatever a previous session left behind. The `lastSeqValue` guard on
  // top just guarantees strict monotonicity even if two sends from this
  // session land in the same millisecond (the server's check is a strict
  // `<`, so a tied value would otherwise be wrongly rejected too).
  private lastSeqValue = 0;
  // Public: the sidebar's properties-panel edits (numeric X/Y/W/H fields,
  // toggles, etc.) aren't part of a mouse gesture but still need to go
  // through the same seq-guarded path as a drag for consistent stale/
  // out-of-order protection.
  nextSeq(): number {
    const now = Date.now();
    this.lastSeqValue = now > this.lastSeqValue ? now : this.lastSeqValue + 1;
    return this.lastSeqValue;
  }

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

    this.handles = {} as Record<Corner, HTMLElement>;
    for (const corner of CORNERS) {
      const handle = document.createElement("div");
      handle.dataset.role = "resize-handle";
      handle.dataset.corner = corner;
      handle.style.position = "absolute";
      handle.style.width = "10px";
      handle.style.height = "10px";
      handle.style.background = "white";
      handle.style.border = "2px solid #4da3ff";
      handle.style.borderRadius = "2px";
      handle.style.boxSizing = "border-box";
      handle.style.cursor = CORNER_CURSOR[corner];
      handle.style.display = "none";
      handle.style.zIndex = "1000";
      handle.addEventListener("mousedown", (event) => this.onHandleMouseDown(event, corner));
      this.world.appendChild(handle);
      this.handles[corner] = handle;
    }

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

  // Deliberately touches only video elements' .volume, not a full
  // applyTransform() over every entry -- the sound panel's sliders fire
  // live on every drag tick, and re-running position/blur/etc for every
  // non-video asset on each tick would be pure waste. Also deliberately
  // uses applyVolume (not the full syncMediaState) for the same reason
  // syncGlobalVolume does in browser-source's render.ts: routing a
  // volume-only change through the play/pause branch meant a volume drag
  // could re-issue .play() dozens of times a second on a video that was
  // merely mid-buffer (media.paused momentarily true while asset.paused is
  // false), each call interrupting the previous one's promise and racing
  // the forced-mute/restore -- which is what made playback go unresponsive
  // while someone was just touching the volume slider.
  setVolumeMultipliers(globalVolume: number, localVolume: number): void {
    this.globalVolume = globalVolume;
    this.localVolume = localVolume;
    for (const entry of this.entries.values()) {
      if (entry.asset.type === "video") {
        applyVolume(entry.content as HTMLVideoElement, this.effectiveVolume(entry.asset));
      }
    }
  }

  setVariables(variables: Record<string, Variable>): void {
    this.variables = variables;
    this.reapplyText();
  }

  upsertVariable(variable: Variable): void {
    this.variables = { ...this.variables, [variable.key]: variable };
    this.reapplyText();
  }

  removeVariable(key: string): void {
    const next = { ...this.variables };
    delete next[key];
    this.variables = next;
    this.reapplyText();
  }

  private reapplyText(): void {
    for (const entry of this.entries.values()) {
      if (entry.asset.type === "text") {
        const interpolated = interpolateText(entry.asset.text ?? "", this.variables);
        if (entry.content.textContent !== interpolated) entry.content.textContent = interpolated;
      }
    }
  }

  private effectiveVolume(asset: Asset): number {
    return Math.min(1, Math.max(0, asset.volume * this.globalVolume * this.localVolume));
  }

  get(assetId: string): Asset | undefined {
    return this.entries.get(assetId)?.asset;
  }

  getAllAssets(): Asset[] {
    return [...this.entries.values()].map((entry) => entry.asset);
  }

  getSelectedAssetId(): string | undefined {
    return this.selectedAssetId;
  }

  // Public counterpart to clicking an asset directly -- lets the sidebar's
  // object list drive canvas selection.
  selectAsset(assetId: string | undefined): void {
    if (assetId === this.selectedAssetId) return;
    this.selectedAssetId = assetId;
    this.refreshSelection();
    this.callbacks.onSelectionChange(assetId);
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
      const { el, content } = this.createElement(asset);
      entry = { el, content, asset };
      this.entries.set(asset.assetId, entry);
      this.world.appendChild(el);
    }
    entry.asset = asset;
    this.applyTransform(entry, asset);
    if (asset.assetId === this.selectedAssetId) this.positionHandles();
  }

  // Applies a move/resize that originated from the network (another
  // collaborator, or the server's echo of our own throttled send) —
  // distinct from the instant local application during an active drag in
  // onMouseMove. If this asset is the one currently being manipulated
  // locally, the update is dropped: local optimistic state is authoritative
  // mid-gesture, and applying a slightly-stale echo would fight with
  // continued mouse movement.
  applyRemoteMove(assetId: string, x: number, y: number, rotation: number, visible: boolean, seq: number): void {
    if (this.dragging && "assetId" in this.dragging && this.dragging.assetId === assetId) return;
    const entry = this.entries.get(assetId);
    if (!entry) return;
    // Defense in depth beyond the server's own conditional-write ordering
    // guard: even a write that won the race server-side could still arrive
    // at this specific connection after a chronologically later message,
    // purely due to network/API Gateway delivery timing.
    if (seq < entry.asset.seq) return;
    this.upsert({ ...entry.asset, x, y, rotation, visible, seq });
  }

  applyRemoteResize(
    assetId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    visible: boolean,
    seq: number
  ): void {
    if (this.dragging && "resizing" in this.dragging && this.dragging.resizing.assetId === assetId) return;
    const entry = this.entries.get(assetId);
    if (!entry) return;
    if (seq < entry.asset.seq) return;
    this.upsert({ ...entry.asset, x, y, width, height, visible, seq });
  }

  // Applies a patch that originated from the network (a collaborator's
  // properties-panel edit, or the server's echo of our own) -- covers text
  // content, hidden/locked/opacity/blur/flip, z-index, rotation, and
  // video/audio playback state. Property edits aren't part of an active
  // mouse gesture the way move/resize are, so there's no "currently
  // manipulating this locally" guard to check here.
  applyRemoteUpdate(assetId: string, patch: AssetPatch, visible: boolean, seq: number): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    if (seq < entry.asset.seq) return;
    this.upsert({ ...entry.asset, ...patch, visible, seq });
  }

  // Programmatic counterparts to mouse drag/resize, for the sidebar's
  // numeric X/Y/width/height fields -- goes through the same seq-guarded
  // send path as a drag for consistent stale/out-of-order protection.
  setAssetPosition(assetId: string, x: number, y: number): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    const seq = this.nextSeq();
    entry.asset = { ...entry.asset, x, y, seq };
    this.applyTransform(entry, entry.asset);
    if (assetId === this.selectedAssetId) this.positionHandles();
    this.callbacks.onAssetMove(assetId, x, y, seq);
  }

  setAssetSize(assetId: string, width: number, height: number): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    const w = Math.max(MIN_ASSET_SIZE, width);
    const h = Math.max(MIN_ASSET_SIZE, height);
    const seq = this.nextSeq();
    entry.asset = { ...entry.asset, width: w, height: h, seq };
    this.applyTransform(entry, entry.asset);
    if (assetId === this.selectedAssetId) this.positionHandles();
    this.callbacks.onAssetResize(assetId, entry.asset.x, entry.asset.y, w, h, seq);
  }

  patchAsset(assetId: string, patch: AssetPatch): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    const seq = this.nextSeq();
    entry.asset = { ...entry.asset, ...patch, seq };
    this.applyTransform(entry, entry.asset);
    if (assetId === this.selectedAssetId) this.positionHandles();
    this.callbacks.onAssetPatch(assetId, patch, seq);
  }

  remove(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry) {
      entry.el.remove();
      this.entries.delete(assetId);
    }
    if (this.selectedAssetId === assetId) {
      this.selectedAssetId = undefined;
      this.positionHandles();
      this.callbacks.onSelectionChange(undefined);
    }
  }

  private applyTransform(entry: Entry, asset: Asset): void {
    const { el, content } = entry;
    el.style.left = `${asset.x}px`;
    el.style.top = `${asset.y}px`;
    el.style.width = `${asset.width}px`;
    el.style.height = `${asset.height}px`;
    el.style.transform = `rotate(${asset.rotation}deg) scale(${asset.flipX ? -1 : 1}, ${asset.flipY ? -1 : 1})`;
    el.style.zIndex = String(asset.zIndex);
    el.style.outline = asset.assetId === this.selectedAssetId ? "2px solid #4da3ff" : "none";
    el.style.cursor = asset.locked ? "default" : "grab";
    // Blur lives on `content`, one level inside `el` -- `el` itself carries
    // the selection outline, and a CSS filter blurs everything painted for
    // the element it's on, so applying it to `el` blurred the outline too.
    content.style.filter = asset.blur > 0 ? `blur(${asset.blur}px)` : "";
    if (asset.type === "text") {
      const interpolated = interpolateText(asset.text ?? "", this.variables);
      if (content.textContent !== interpolated) content.textContent = interpolated;
    }
    // The editor's own preview never actually played video -- only
    // browser-source synced .loop/.muted/.volume/.play()/.pause() from the
    // asset's playback fields. Audio has no real media element here (the
    // canvas shows a placeholder icon; actual audio only plays for viewers
    // via browser-source), so only video needs this.
    if (asset.type === "video") {
      syncMediaState(content as HTMLVideoElement, asset, this.effectiveVolume(asset));
    }
    // The canvas always shows every asset regardless of the true `visible`
    // flag (viewport-intersection + hidden) -- unlike browser-source, the
    // editor needs an omniscient view so things can be found/edited even
    // off-screen or manually hidden. `hidden` still gets a visual cue
    // (extra dimming on top of the asset's own opacity) so it's obvious
    // which assets won't actually show up for viewers.
    el.style.opacity = String(asset.hidden ? asset.opacity * 0.4 : asset.opacity);
  }

  private createElement(asset: Asset): { el: HTMLElement; content: HTMLElement } {
    let content: HTMLElement;
    switch (asset.type) {
      case "image":
      case "gif": {
        const img = document.createElement("img");
        if (asset.s3Key) img.src = this.mediaUrl(asset.s3Key);
        img.draggable = false;
        content = img;
        break;
      }
      case "video": {
        const video = document.createElement("video");
        if (asset.s3Key) video.src = this.mediaUrl(asset.s3Key);
        video.controls = false;
        // Unlike <img>, a <video> is natively draggable by default in most
        // browsers (e.g. dragging out its current frame as a thumbnail) --
        // that native drag-and-drop hijacks the mouse mid-gesture, which
        // looks exactly like our own drag breaking after one tick.
        video.draggable = false;
        content = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("div");
        audio.style.display = "flex";
        audio.style.alignItems = "center";
        audio.style.justifyContent = "center";
        audio.innerHTML = ICON_AUDIO_LARGE;
        content = audio;
        break;
      }
      case "text": {
        content = document.createElement("div");
        content.textContent = asset.text ?? "";
        break;
      }
    }
    content.dataset.assetType = asset.type;
    content.style.width = "100%";
    content.style.height = "100%";

    const el = document.createElement("div");
    el.dataset.assetId = asset.assetId;
    el.style.position = "absolute";
    el.style.cursor = "grab";
    el.appendChild(content);
    el.addEventListener("mousedown", (event) => this.onAssetMouseDown(event, asset.assetId));
    return { el, content };
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
      // Deliberately does NOT deselect on an empty-canvas click -- selection
      // only ever changes by picking a different asset (or an explicit
      // delete), so the properties panel stays put while adjusting pan/zoom
      // or clicking around the canvas.
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
        this.positionHandles();
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
    if (this.selectedAssetId !== assetId) {
      this.selectedAssetId = assetId;
      this.refreshSelection();
      this.callbacks.onSelectionChange(assetId);
    }
    // Selection always works, even on a locked asset (so it can be viewed/
    // unlocked via the properties panel) -- only the drag itself is blocked.
    const entry = this.entries.get(assetId);
    if (!entry?.asset.locked) {
      this.dragging = { assetId };
    }
  }

  private onHandleMouseDown(event: MouseEvent, corner: Corner): void {
    if (event.button !== 0 || !this.selectedAssetId) return;
    const entry = this.entries.get(this.selectedAssetId);
    if (entry?.asset.locked) return;
    event.stopPropagation();
    this.dragging = { resizing: { assetId: this.selectedAssetId, corner } };
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.dragging) return;

    if ("panning" in this.dragging) {
      this.pan.x += event.movementX;
      this.pan.y += event.movementY;
      this.scheduleRender(() => {
        this.applyWorldTransform();
        this.positionHandles();
      });
      return;
    }

    // Screen-space mouse movement divided by zoom gives world-space delta —
    // deliberately independent of any container geometry (getBoundingClientRect
    // et al.), which keeps this correct under any layout and testable headlessly.
    const dx = event.movementX / this.zoom;
    const dy = event.movementY / this.zoom;

    if ("resizing" in this.dragging) {
      const entry = this.entries.get(this.dragging.resizing.assetId);
      if (!entry) return;
      entry.asset = this.applyResizeDelta(entry.asset, this.dragging.resizing.corner, dx, dy);
      this.scheduleRender(() => {
        this.applyTransform(entry, entry.asset);
        this.positionHandles();
      });

      const now = performance.now();
      if (now - this.lastMoveSentAt >= MOVE_SEND_THROTTLE_MS) {
        this.lastMoveSentAt = now;
        entry.asset = { ...entry.asset, seq: this.nextSeq() };
        this.callbacks.onAssetResize(
          entry.asset.assetId,
          entry.asset.x,
          entry.asset.y,
          entry.asset.width,
          entry.asset.height,
          entry.asset.seq
        );
      }
      return;
    }

    const entry = this.entries.get(this.dragging.assetId);
    if (!entry) return;
    entry.asset = { ...entry.asset, x: entry.asset.x + dx, y: entry.asset.y + dy };
    this.scheduleRender(() => {
      this.applyTransform(entry, entry.asset);
      this.positionHandles();
    });

    const now = performance.now();
    if (now - this.lastMoveSentAt >= MOVE_SEND_THROTTLE_MS) {
      this.lastMoveSentAt = now;
      entry.asset = { ...entry.asset, seq: this.nextSeq() };
      this.callbacks.onAssetMove(entry.asset.assetId, entry.asset.x, entry.asset.y, entry.asset.seq);
    }
  }

  // Resizes from `corner`, keeping the *opposite* corner fixed exactly —
  // computed from the opposite corner's absolute position rather than by
  // independently adjusting x and width, so clamping to MIN_ASSET_SIZE
  // never causes the fixed corner to visibly drift.
  private applyResizeDelta(asset: Asset, corner: Corner, dx: number, dy: number): Asset {
    const anchorX = corner === "ne" || corner === "se" ? asset.x : asset.x + asset.width;
    const anchorY = corner === "sw" || corner === "se" ? asset.y : asset.y + asset.height;

    const rawWidth = corner === "ne" || corner === "se" ? asset.width + dx : asset.width - dx;
    const rawHeight = corner === "sw" || corner === "se" ? asset.height + dy : asset.height - dy;
    const width = Math.max(MIN_ASSET_SIZE, rawWidth);
    const height = Math.max(MIN_ASSET_SIZE, rawHeight);

    const x = corner === "ne" || corner === "se" ? anchorX : anchorX - width;
    const y = corner === "sw" || corner === "se" ? anchorY : anchorY - height;

    return { ...asset, x, y, width, height };
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
    if (this.dragging) {
      // Always flush the exact final transform on release, bypassing the
      // throttle — otherwise the last few pixels of a gesture could be lost
      // if the mouse-up lands inside the throttle window.
      if ("assetId" in this.dragging) {
        const entry = this.entries.get(this.dragging.assetId);
        if (entry) {
          entry.asset = { ...entry.asset, seq: this.nextSeq() };
          this.callbacks.onAssetMove(entry.asset.assetId, entry.asset.x, entry.asset.y, entry.asset.seq);
        }
      } else if ("resizing" in this.dragging) {
        const entry = this.entries.get(this.dragging.resizing.assetId);
        if (entry) {
          entry.asset = { ...entry.asset, seq: this.nextSeq() };
          this.callbacks.onAssetResize(
            entry.asset.assetId,
            entry.asset.x,
            entry.asset.y,
            entry.asset.width,
            entry.asset.height,
            entry.asset.seq
          );
        }
      }
    }
    this.dragging = undefined;
  }

  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return { x: (screenX - this.pan.x) / this.zoom, y: (screenY - this.pan.y) / this.zoom };
  }

  private refreshSelection(): void {
    for (const entry of this.entries.values()) {
      entry.el.style.outline = entry.asset.assetId === this.selectedAssetId ? "2px solid #4da3ff" : "none";
    }
    this.positionHandles();
  }

  // Handles are children of `world`, so they already pan with it — but
  // world's CSS scale(zoom) would also scale their own 10px size along with
  // it, making them balloon at high zoom / vanish at low zoom. Countering
  // with scale(1/zoom) keeps them a constant apparent size on screen,
  // matching a typical canvas editor's resize-handle behavior.
  private positionHandles(): void {
    const entry = this.selectedAssetId ? this.entries.get(this.selectedAssetId) : undefined;
    if (!entry || entry.asset.locked) {
      for (const corner of CORNERS) this.handles[corner].style.display = "none";
      return;
    }

    const { x, y, width, height, rotation } = entry.asset;
    // Corner offsets from the asset's center, rotated by the asset's own
    // rotation -- otherwise the handles stay in an axis-aligned bounding
    // box while the asset itself visibly rotates, drifting away from its
    // actual corners instead of tracking them.
    const cx = x + width / 2;
    const cy = y + height / 2;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotate = (dx: number, dy: number) => ({
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    });
    const positions: Record<Corner, { x: number; y: number }> = {
      nw: rotate(-width / 2, -height / 2),
      ne: rotate(width / 2, -height / 2),
      sw: rotate(-width / 2, height / 2),
      se: rotate(width / 2, height / 2),
    };
    for (const corner of CORNERS) {
      const handle = this.handles[corner];
      const pos = positions[corner];
      handle.style.display = "block";
      handle.style.left = `${pos.x}px`;
      handle.style.top = `${pos.y}px`;
      handle.style.transform = `translate(-50%, -50%) scale(${1 / this.zoom})`;
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

// See setVolumeMultipliers -- volume-only updates must never touch
// loop/play/pause/mute, only used from there.
function applyVolume(media: HTMLVideoElement, effectiveVolume: number): void {
  if (media.volume !== effectiveVolume) media.volume = effectiveVolume;
}

// Only touches properties that actually differ from the asset's target
// state -- re-assigning .loop/.volume unconditionally is harmless, but
// calling .play()/.pause() when already in that state can cause an
// audible/visible stutter on some browsers.
function syncMediaState(media: HTMLVideoElement, asset: Asset, effectiveVolume: number): void {
  if (media.loop !== asset.loop) media.loop = asset.loop;
  applyVolume(media, effectiveVolume);
  if (asset.paused && !media.paused) {
    media.pause();
    media.muted = asset.muted;
  } else if (!asset.paused && media.paused) {
    // A freshly-added video's very first .play() call can be rejected by
    // the browser's autoplay policy (no user gesture directly on this
    // element) with no automatic retry -- previously that left the asset
    // stuck paused until the page was reloaded. Muted autoplay is allowed
    // essentially everywhere, so force-mute just for this call and restore
    // the asset's real mute state once playback has actually started.
    const wantMuted = asset.muted;
    media.muted = true;
    media
      .play()
      .then(() => {
        media.muted = wantMuted;
      })
      .catch(() => {
        media.muted = wantMuted;
      });
  } else if (media.muted !== asset.muted) {
    media.muted = asset.muted;
  }
}
