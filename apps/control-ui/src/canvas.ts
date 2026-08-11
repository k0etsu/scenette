import {
  Asset,
  AssetPatch,
  Variable,
  Viewport,
  computeClockDisplay,
  interpolateText,
  resolveTextStyle,
  textStyleToCss,
  createYoutubePlayerController,
  YoutubePlayerController,
} from "@scenette/protocol";
import { ICON_AUDIO_LARGE } from "./icons";

// How often clock assets re-render their computed time in the editor preview.
// 250ms comfortably keeps a seconds display current without the cost of a
// full requestAnimationFrame loop (browser-source uses rAF since it's a
// dedicated always-visible overlay; the editor doesn't need that cadence).
const CLOCK_TICK_INTERVAL_MS = 250;

// A youtube asset's embed is held at this fixed native pixel size and only
// ever CSS-scaled (never resized directly) to fit the asset's actual box --
// same fixed-native-size + transform:scale() technique streamPreview.ts
// already uses for the room-wide stream embed, and for the same reason:
// keeping the iframe's own real pixel dimensions constant means YouTube's
// auto-quality heuristic (which partly follows the player's actual size,
// not its visual CSS size) isn't misled into serving a low-resolution
// stream just because the asset happens to be displayed small on the
// canvas. 1280x720 (720p) rather than streamPreview.ts's 1920x1080 --
// this is a single embedded asset, not the whole stream frame.
const YOUTUBE_NATIVE_WIDTH = 1280;
const YOUTUBE_NATIVE_HEIGHT = 720;

interface Entry {
  el: HTMLElement;
  // The actual visual content (img/video/audio icon/text), one level inside
  // `el`. Blur is applied here rather than on `el` itself -- a CSS filter
  // blurs everything painted for the element it's on, including outline, so
  // applying it to `el` (which also carries the selection outline) blurred
  // the selection indicator right along with the asset, making it useless
  // for judging exactly how blurred the asset itself looks.
  content: HTMLElement;
  // The actual playable element for video/audio -- for video this is the
  // same element as `content`; for audio, `content` stays the visible icon
  // placeholder and `media` is a separate, invisible <audio> element that
  // drives real local playback (so a mod editing the room can hear what's
  // playing, matching video). Undefined for every other asset type.
  media?: HTMLMediaElement;
  // youtube assets only -- the live YouTube IFrame Player controller (see
  // packages/protocol/src/youtubePlayer.ts), playing in the editor for the
  // same reason audio now does: a mod needs to know what's actually
  // playing, not just see a placeholder.
  ytController?: YoutubePlayerController;
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
export const MIN_ASSET_SIZE = 20;
// Leaves ~15% of the container's width free on each side, so the viewport
// rect reads as centered rather than edge-to-edge.
const VIEWPORT_WIDTH_FRACTION = 0.7;

// Caps how often a dragged/resized asset's transform is actually sent over
// the network — local rendering stays instant every mousemove regardless
// (see onMouseMove), but broadcasting every single pixel-delta event was
// flooding the WebSocket and, worse, our own echoed update kept arriving
// mid-drag and fighting with continued local movement.
const MOVE_SEND_THROTTLE_MS = 40;

// Caps how often a text asset's content is actually sent over the network
// while typing -- see sendTextPatchThrottled's own doc comment for why this
// exists at all. Deliberately looser than MOVE_SEND_THROTTLE_MS: a typed
// keystroke is naturally much less frequent than a mousemove tick, so this
// mainly matters for fast typists/paste bursts rather than every edit.
const TEXT_SEND_THROTTLE_MS = 100;

// Builds an AssetPatch carrying every currently-patchable field's live
// value from `asset`, rather than just whichever field(s) a particular
// local edit actually changed -- see patchAsset's own doc comment for why.
function fullAssetPatch(asset: Asset): AssetPatch {
  return {
    text: asset.text,
    name: asset.name,
    hidden: asset.hidden,
    locked: asset.locked,
    opacity: asset.opacity,
    blur: asset.blur,
    flipX: asset.flipX,
    flipY: asset.flipY,
    zIndex: asset.zIndex,
    rotation: asset.rotation,
    loop: asset.loop,
    muted: asset.muted,
    volume: asset.volume,
    paused: asset.paused,
    // Text auto-fit's current box size -- see AssetPatch's own doc comment
    // for why this rides along in the same patch/seq as whatever edit
    // caused it, rather than a separate asset:resize message. Harmless to
    // include for a non-text asset (unused there) or when unchanged
    // (redundant re-send of the same value already stored).
    width: asset.width,
    height: asset.height,
    fontFamily: asset.fontFamily,
    fontSize: asset.fontSize,
    fontWeight: asset.fontWeight,
    textAlign: asset.textAlign,
    textColor: asset.textColor,
    backgroundColor: asset.backgroundColor,
    backgroundAlpha: asset.backgroundAlpha,
    shadowEnabled: asset.shadowEnabled,
    shadowX: asset.shadowX,
    shadowY: asset.shadowY,
    shadowBlur: asset.shadowBlur,
    shadowColor: asset.shadowColor,
    outlineEnabled: asset.outlineEnabled,
    outlineColor: asset.outlineColor,
    outlineWidth: asset.outlineWidth,
  };
}

export interface CanvasCallbacks {
  onAssetMove: (assetId: string, x: number, y: number, seq: number) => void;
  onAssetResize: (assetId: string, x: number, y: number, width: number, height: number, seq: number) => void;
  onAssetPatch: (assetId: string, patch: AssetPatch, seq: number) => void;
  onAssetDelete: (assetId: string) => void;
  // Fires from stopAsset() alongside (not instead of) the ordinary
  // onAssetPatch({ paused: true }) it also triggers -- lets the caller
  // relay an asset:stop so every other connected client/browser-source
  // resets its own local playback position too, not just this browser's.
  // See AssetStopMessage's protocol doc comment for why this is a
  // separate, unpersisted broadcast rather than part of AssetPatch.
  onAssetStop: (assetId: string) => void;
  // worldX/worldY: where a created asset should be placed. screenX/screenY:
  // viewport-relative coordinates for positioning the context menu itself.
  onContextMenu: (worldX: number, worldY: number, screenX: number, screenY: number) => void;
  // Fires on every selection change, including deselection (undefined) and
  // programmatic selection via selectAsset() -- lets the sidebar's
  // properties panel track whatever's selected on the canvas, and vice versa.
  onSelectionChange: (assetId: string | undefined) => void;
  // Fires whenever pan/zoom/the viewport rect itself changes (including
  // once synchronously during construction) -- lets a caller (the
  // stream-preview overlay) keep something positioned exactly over the
  // viewport rect on screen without polling every frame. Passes the rect
  // directly rather than expecting the callback to call back into the
  // CanvasView instance, which wouldn't exist yet on that first call.
  onViewportTransformChanged?: (rect: { left: number; top: number; width: number; height: number }) => void;
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
  private readonly mediaControls: HTMLElement;
  private readonly mediaControlsLoopButton: HTMLButtonElement;
  private readonly mediaControlsPlayButton: HTMLButtonElement;
  private readonly mediaControlsPauseButton: HTMLButtonElement;
  private readonly mediaControlsStopButton: HTMLButtonElement;
  private readonly mediaControlsMutedCheckbox: HTMLInputElement;
  private readonly mediaControlsVolumeSlider: HTMLInputElement;
  private readonly mediaControlsVolumeLabel: HTMLElement;
  private viewport: Viewport = { roomId: "", x: 0, y: 0, width: 1920, height: 1080 };

  private pan = { x: 0, y: 0 };
  private zoom = 1;
  // Zoom/pan is local-only view state (never synced -- see the class
  // comment), so there's no server value to restore on load. Instead, the
  // very first setViewport() of this CanvasView's lifetime (room entry, or
  // a full page refresh -- which constructs a brand-new CanvasView) centers
  // the view on the room's viewport rect. Later setViewport calls within
  // the same instance (e.g. the connected-users panel's manual resync
  // button) leave the user's own pan/zoom alone.
  private hasCenteredViewport = false;

  private selectedAssetId?: string;
  private dragging?: { assetId: string } | { panning: true } | { resizing: { assetId: string; corner: Corner } };
  private lastMoveSentAt = 0;
  // Set for the duration of an active inline text edit (beginInlineTextEdit
  // -> stopEditing), so a periodic/manual full-state resync (see setAssets)
  // never reverts mid-edit content between keystrokes -- mirrors `dragging`
  // above, which protects an active mouse gesture the same way.
  private inlineEditingAssetId?: string;

  // Updated on every plain mousemove over the canvas (not just while
  // dragging) so a toolbar/paste-triggered upload -- which has no click
  // event of its own to read a position from -- can still place the new
  // asset near wherever the user was last actually pointing, instead of
  // always falling back to the viewport center. Undefined until the mouse
  // has entered this container at least once (e.g. right after a room
  // switch, before the pointer has crossed back over the canvas).
  private lastMouseWorld?: { x: number; y: number };

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
  // Drives the per-clock-asset time re-render (see tickClocks); cleared in dispose().
  private clockTimer?: ReturnType<typeof setInterval>;
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
    this.world.dataset.role = "world";
    this.world.style.position = "absolute";
    this.world.style.transformOrigin = "0 0";
    // Hidden until the first real centerOnViewport() runs (see setViewport()
    // below) -- otherwise this paints for a frame at the default pan:0/
    // zoom:1 transform (viewport rect pinned to the world's top-left
    // origin) before the deferred centering pass repositions it, which
    // showed up as a visible top-left-then-jump-to-center flash on every
    // page load/refresh. visibility (unlike display) doesn't affect layout,
    // so this doesn't interfere with the container-size read centering
    // depends on.
    this.world.style.visibility = "hidden";
    this.container.appendChild(this.world);

    this.viewportRect = document.createElement("div");
    this.viewportRect.dataset.role = "viewport-rect";
    this.viewportRect.style.position = "absolute";
    this.viewportRect.style.boxSizing = "border-box";
    this.viewportRect.style.pointerEvents = "none";
    // No visible border -- the stream-preview panel's own always-on-top
    // boundary (see streamPreview.ts's #stream-preview-border) is now the
    // one visual indicator of the viewport rect, superseding this
    // element's old dashed line. This div is kept (rather than removed
    // entirely) purely to track the rect's position/size in the DOM in
    // case something else needs it later; it paints nothing itself.
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

    // Floating playback control for the selected video/audio asset --
    // mirrors the sidebar's own Playback section (same underlying
    // patchAsset/stopAsset calls, so both surfaces always agree on state;
    // see updateMediaControls) but stays visible right next to the asset
    // itself rather than requiring a glance over at the sidebar.
    //
    // Deliberately NOT a child of `world` (unlike the resize handles above)
    // -- #stream-preview-border's always-on-top viewport boundary strips
    // (z-index 20, backdrop-filter: invert()) are a *sibling* of this
    // container in the DOM (see index.html), one stacking-context level up,
    // so no z-index set in here could ever render above them: a strip that
    // happened to cross the widget inverted whatever of it was underneath.
    // Appending to the container's own parent instead puts this at that
    // same sibling level, where a z-index above 20 actually wins. That
    // means it no longer inherits `world`'s pan/zoom CSS transform for
    // free, so its position is now recomputed manually in screen space via
    // worldToScreen() in updateMediaControls -- also the reason it no
    // longer needs the handles' scale(1/zoom) counter-scaling trick;
    // screen-space coordinates are already zoom-invariant.
    this.mediaControls = document.createElement("div");
    this.mediaControls.dataset.role = "media-controls";
    this.mediaControls.className = "media-controls-widget";
    this.mediaControls.style.position = "absolute";
    this.mediaControls.style.display = "none";
    this.mediaControls.style.zIndex = "30";
    this.mediaControls.innerHTML = `
      <div class="media-controls-row">
        <button type="button" data-role="mc-loop" class="sidebar-flip-button">loop</button>
        <button type="button" data-role="mc-play" class="sidebar-flip-button">play</button>
        <button type="button" data-role="mc-pause" class="sidebar-flip-button">pause</button>
        <button type="button" data-role="mc-stop" class="sidebar-flip-button">stop</button>
      </div>
      <div class="media-controls-row">
        <label class="prop-checkbox"><input type="checkbox" data-role="mc-muted" /> mute</label>
        <span data-role="mc-volume-label"></span>
        <input type="range" data-role="mc-volume" min="0" max="100" />
      </div>
    `;
    this.container.parentElement!.appendChild(this.mediaControls);

    const mc = <T extends HTMLElement>(role: string) => this.mediaControls.querySelector<T>(`[data-role="${role}"]`)!;
    this.mediaControlsLoopButton = mc("mc-loop");
    this.mediaControlsPlayButton = mc("mc-play");
    this.mediaControlsPauseButton = mc("mc-pause");
    this.mediaControlsStopButton = mc("mc-stop");
    this.mediaControlsMutedCheckbox = mc("mc-muted");
    this.mediaControlsVolumeSlider = mc("mc-volume");
    this.mediaControlsVolumeLabel = mc("mc-volume-label");

    // Every handler reads the selected asset fresh from `this.entries` at
    // click/input time rather than closing over anything captured when the
    // widget was built (it's built exactly once, in this constructor, and
    // then reused for whichever asset happens to be selected) -- same
    // "fresh lookup, not a stale closure" pattern as the sidebar's own
    // buttons.
    this.mediaControlsLoopButton.addEventListener("click", () => {
      const entry = this.selectedEntry();
      if (entry) this.patchAsset(entry.asset.assetId, { loop: !entry.asset.loop });
    });
    this.mediaControlsPlayButton.addEventListener("click", () => {
      const entry = this.selectedEntry();
      if (entry) this.patchAsset(entry.asset.assetId, { paused: false });
    });
    this.mediaControlsPauseButton.addEventListener("click", () => {
      const entry = this.selectedEntry();
      if (entry) this.patchAsset(entry.asset.assetId, { paused: true });
    });
    this.mediaControlsStopButton.addEventListener("click", () => {
      const entry = this.selectedEntry();
      if (entry) this.stopAsset(entry.asset.assetId);
    });
    this.mediaControlsMutedCheckbox.addEventListener("change", () => {
      const entry = this.selectedEntry();
      if (entry) this.patchAsset(entry.asset.assetId, { muted: this.mediaControlsMutedCheckbox.checked });
    });
    this.mediaControlsVolumeSlider.addEventListener("input", () => {
      const entry = this.selectedEntry();
      if (entry) this.patchAsset(entry.asset.assetId, { volume: Number(this.mediaControlsVolumeSlider.value) / 100 });
    });

    // Suppressed here: this fires at the default pan:0/zoom:1 transform,
    // before the deferred first centerOnViewport() pass (see setViewport()
    // below) has had a chance to run. Firing onViewportTransformChanged with
    // that rect anyway made the stream-preview panel's always-on-top
    // boundary -- a *separate* element from this.world, so hiding the world
    // alone (see setViewport()'s comment) didn't cover it -- position itself
    // at the top-left corner for a frame before jumping to center, matching
    // the reported flash exactly. The callback fires normally from every
    // subsequent applyWorldTransform() call, including the one inside
    // centerOnViewport() itself, so real consumers still get their first
    // rect -- just the already-centered one, never this transient one.
    this.applyWorldTransform(true);
    this.bindContainerEvents();
    this.bindKeyboard();

    this.clockTimer = setInterval(() => this.tickClocks(), CLOCK_TICK_INTERVAL_MS);
  }

  // Advances every clock asset's displayed time. The content element shrink-
  // wraps its text (no fixed width, like a text asset), so updating textContent
  // is enough to keep it visually sized; re-measuring only matters for the
  // selection handles, so that's done just for the currently-selected clock.
  // Purely local -- never sends a patch (a ticking clock costs no network
  // traffic; only its config is ever synced).
  private tickClocks(): void {
    for (const entry of this.entries.values()) {
      if (entry.asset.type !== "clock") continue;
      const display = computeClockDisplay(entry.asset, Date.now());
      if (entry.content.textContent !== display) entry.content.textContent = display;
    }
    if (this.selectedAssetId) {
      const entry = this.entries.get(this.selectedAssetId);
      if (entry?.asset.type === "clock") {
        const w = Math.max(MIN_ASSET_SIZE, entry.content.offsetWidth);
        const h = Math.max(MIN_ASSET_SIZE, entry.content.offsetHeight);
        if (Math.abs(w - entry.asset.width) >= 1 || Math.abs(h - entry.asset.height) >= 1) {
          entry.asset = { ...entry.asset, width: w, height: h };
          this.positionHandles();
        }
      }
    }
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.viewportRect.style.left = `${viewport.x}px`;
    this.viewportRect.style.top = `${viewport.y}px`;
    this.viewportRect.style.width = `${viewport.width}px`;
    this.viewportRect.style.height = `${viewport.height}px`;

    if (!this.hasCenteredViewport) {
      this.hasCenteredViewport = true;
      // Deferred to the next frame rather than run synchronously here:
      // this is typically the very first geometry read (container.
      // clientWidth) of the page's lifetime, landing in the same task that
      // just flipped the app view from display:none to visible and is
      // about to insert every asset element. Reading layout geometry mid-
      // task forces the browser to synchronously compute layout for that
      // whole newly-visible subtree before it can continue -- a forced
      // reflow that blocked the initial paint and showed up as a
      // noticeable delay before anything appeared on screen. Waiting a
      // frame lets that first layout/paint happen on its own schedule; the
      // repositioning that follows is a single already-cheap read+write.
      requestAnimationFrame(() => this.centerOnViewport());
    }
  }

  // Picks a zoom that fits the viewport rect within the container -- at
  // most VIEWPORT_WIDTH_FRACTION of the container's width (the ~15% side
  // margins), and never taller than the container itself -- then pans so
  // the rect sits centered both horizontally and vertically.
  private centerOnViewport(): void {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    // Not laid out yet (e.g. hidden by a display:none ancestor) -- nothing
    // sane to compute against, so leave the default pan/zoom in place.
    if (containerWidth <= 0 || containerHeight <= 0) {
      this.world.style.visibility = "visible";
      return;
    }

    const zoomByWidth = (containerWidth * VIEWPORT_WIDTH_FRACTION) / this.viewport.width;
    const zoomByHeight = containerHeight / this.viewport.height;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomByWidth, zoomByHeight)));

    const viewportCenterX = this.viewport.x + this.viewport.width / 2;
    const viewportCenterY = this.viewport.y + this.viewport.height / 2;
    this.pan.x = containerWidth / 2 - viewportCenterX * this.zoom;
    this.pan.y = containerHeight / 2 - viewportCenterY * this.zoom;

    this.applyWorldTransform();
    // Reveal only now that the transform reflects the centered position --
    // this is the frame the user should actually see first.
    this.world.style.visibility = "visible";
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  // See lastMouseWorld's own doc -- undefined if the cursor hasn't crossed
  // over the canvas yet this room (falls back to viewport center at the
  // call site, same as it always did).
  getCursorWorldPosition(): { x: number; y: number } | undefined {
    return this.lastMouseWorld;
  }

  // Deliberately touches only video/audio elements' .volume, not a full
  // applyTransform() over every entry -- the sound panel's sliders fire
  // live on every drag tick, and re-running position/blur/etc for every
  // other asset on each tick would be pure waste. Also deliberately uses
  // applyVolume (not the full syncMediaState) for the same reason
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
      if (entry.media) {
        applyVolume(entry.media, this.effectiveVolume(entry.asset));
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
      // Skip a text asset that's mid inline-edit: its DOM holds the raw
      // {variable} template the user is editing. Substituting the interpolated
      // value in would both show the wrong thing and, on the next keystroke/
      // blur, risk the raw template being lost. applyTransform guards this the
      // same way -- and this fires on every variable change AND every periodic
      // room:snapshot resync (setVariables), so it must guard too.
      if (entry.asset.type === "text" && entry.content.contentEditable !== "true") {
        const interpolated = interpolateText(entry.asset.text ?? "", this.variables);
        if (entry.content.textContent !== interpolated) entry.content.textContent = interpolated;
      }
    }
  }

  private effectiveVolume(asset: Asset): number {
    return Math.min(1, Math.max(0, asset.volume * this.globalVolume * this.localVolume));
  }

  private selectedEntry(): Entry | undefined {
    return this.selectedAssetId ? this.entries.get(this.selectedAssetId) : undefined;
  }

  // Pauses (synced to every client/browser-source, same as the ordinary
  // pause button) and resets the actual local <video>/<audio> element back
  // to the start of its timeline -- and, via onAssetStop, tells every other
  // connected client/browser-source to reset their own local playback
  // position too (see AssetStopMessage's protocol doc comment for why
  // that's a separate broadcast rather than part of the paused patch).
  stopAsset(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    this.patchAsset(assetId, { paused: true });
    if (entry.media) entry.media.currentTime = 0;
    entry.ytController?.seekToStart();
    this.callbacks.onAssetStop(assetId);
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

  // Also the entry point for a periodic/manual full-state resync (see
  // main.ts) -- unlike asset:added or an already seq-checked
  // applyRemoteMove/Resize/Update call, an incoming entry here represents a
  // potentially-stale external snapshot, not a single pre-validated delta.
  // A snapshot arriving mid-gesture is otherwise indistinguishable from a
  // legitimate authoritative update, so this guards every way a local edit
  // could be in flight before the corresponding network round-trip:
  //   1. seq: never let a snapshot go backwards relative to what's already
  //      displayed (same convention as applyRemoteMove/Resize/Update below).
  //   2. an active drag/resize gesture: doesn't bump seq on every
  //      mousemove tick (only on throttled sends), so seq alone can't tell
  //      "stale" from "mid-gesture, not sent yet" -- must check `dragging`.
  //   3. an active inline text edit: same idea, no seq bump per keystroke
  //      until the (also throttled) text send actually flushes.
  // Without all three, a poorly-timed resync could revert someone's own
  // in-progress edit to a stale server copy out from under them.
  setAssets(assets: Asset[]): void {
    const seen = new Set<string>();
    for (const asset of assets) {
      seen.add(asset.assetId);
      const entry = this.entries.get(asset.assetId);
      if (entry && asset.seq < entry.asset.seq) continue;
      if (this.dragging && "assetId" in this.dragging && this.dragging.assetId === asset.assetId) continue;
      if (this.dragging && "resizing" in this.dragging && this.dragging.resizing.assetId === asset.assetId) continue;
      if (this.inlineEditingAssetId === asset.assetId) continue;
      this.upsert(asset);
    }
    for (const [assetId, entry] of this.entries) {
      if (!seen.has(assetId)) {
        entry.el.remove();
        entry.ytController?.destroy();
        this.entries.delete(assetId);
      }
    }
  }

  upsert(asset: Asset): void {
    let entry = this.entries.get(asset.assetId);
    if (!entry) {
      const { el, content, media, ytController } = this.createElement(asset);
      entry = { el, content, media, ytController, asset };
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

  // asset:stopped's own effect -- see AssetStopMessage's protocol doc
  // comment for why this is a pure ephemeral broadcast with no seq/patch
  // of its own: playback position isn't part of Asset at all, so there's
  // no stale-ordering concern the way move/resize/update have (a "stop"
  // one browser thinks is old still resets to the exact same place — 0 —
  // as a "stop" it thinks is current).
  applyRemoteStop(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry?.media) entry.media.currentTime = 0;
    entry?.ytController?.seekToStart();
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
    // Local state/rendering applies immediately regardless of the text
    // throttle below -- only the network send (and the seq that goes with
    // it) is ever delayed, so typing always feels instant to the person
    // doing it.
    entry.asset = { ...entry.asset, ...patch };

    // Volume-only patches (the sidebar/media-controls volume slider sends
    // one of these per "input" tick while being dragged) must never go
    // through the full applyTransform -> syncMediaState path -- see
    // setVolumeMultipliers's own doc comment for why: syncMediaState's
    // play/pause branch can re-issue .play() on a video that's merely
    // mid-buffer (media.paused transiently true while asset.paused is
    // false), and that .play() call can be silently rejected by the
    // browser's autoplay policy since a slider drag isn't a direct user
    // gesture on the video element itself -- permanently desyncing the
    // real element's actual playback from asset.paused (and therefore the
    // play/pause button, which reads asset.paused) until paused is toggled
    // twice more to force a retry. Volume never affects any other rendered
    // aspect, so applyVolume alone is exactly enough here, same as
    // setVolumeMultipliers already does for the sound panel's sliders.
    const isVolumeOnlyMediaPatch = Boolean(entry.media) && Object.keys(patch).length === 1 && "volume" in patch;
    if (isVolumeOnlyMediaPatch) {
      applyVolume(entry.media!, this.effectiveVolume(entry.asset));
    } else {
      this.applyTransform(entry, entry.asset);
    }
    if (assetId === this.selectedAssetId) this.positionHandles();

    // A font/size/weight/text-content change can change the rendered box's
    // natural size just as much (or more) -- re-measure after any local
    // patch on a text asset. Folded directly into the SAME outgoing patch
    // below (as width/height -- see AssetPatch's own doc comment) rather
    // than sent as a separate asset:resize message with its own seq.
    //
    // Regression history: this used to be two separate messages under one
    // shared per-asset seq gate (roomState.ts), and EITHER ordering was
    // unsafe -- sending the resize first (an older design) gave it a lower
    // seq than the patch immediately following it, so an out-of-order
    // Lambda invocation could let the patch commit first and reject the
    // resize as stale, permanently losing the size correction. The
    // "obvious" fix of just swapping the order (resize after patch, so
    // resize gets the later seq) only moved the bug: now the *patch* had
    // the lower seq, so the *font/text change itself* could lose to its own
    // resize correction and silently revert. Two messages sharing one seq
    // gate with no cross-message ordering guarantee can't be made safe by
    // choosing an order -- only combining them into one atomic write fixes
    // it for real, which is what this does.
    const sizePatch =
      entry.asset.type === "text" || entry.asset.type === "clock" ? this.measureTextAutoFit(assetId) : undefined;

    if ("text" in patch) {
      this.sendTextPatchThrottled(assetId);
      return;
    }

    const seq = this.nextSeq();
    entry.asset = { ...entry.asset, seq };
    this.callbacks.onAssetPatch(assetId, sizePatch ? { ...patch, ...sizePatch } : patch, seq);
  }

  // Keyed by assetId (not a single shared record) so throttled edits to two
  // different text assets -- unusual, but possible if the user clicks
  // between them fast enough -- don't interfere with each other.
  private readonly textSendState = new Map<string, { lastSentAt: number; trailingTimer?: ReturnType<typeof setTimeout> }>();

  // Text content edits fire on every keystroke. Sending one asset:update per
  // keystroke with no coalescing at all (the original design) turned out to
  // lose real keystrokes in practice -- a fast typist's messages arrived (or
  // were processed) faster than API Gateway's PostToConnection/Lambda
  // pipeline reliably keeps up with, so some interior updates never reached
  // other clients, not merely raced-and-superseded but genuinely dropped.
  // Coalescing those keystrokes into fewer sends (leading+trailing throttle,
  // same shape as MOVE_SEND_THROTTLE_MS's own scheme) cuts the send volume
  // enough to stop that -- and since sendFullTextPatch() below always sends
  // *this* asset's complete current state rather than a per-keystroke diff,
  // no coalesced-away intermediate keystroke's content is ever actually
  // lost, only its intermediate on-screen appearance to other viewers.
  // Debouncing (waiting for a pause before sending anything) was tried first
  // and rejected -- it made typing invisible to collaborators until the
  // person stopped, which is worse than the bug it fixed.
  private sendTextPatchThrottled(assetId: string): void {
    // -Infinity (not 0) so the very first edit to a given asset always
    // leading-sends immediately regardless of how early it happens --
    // performance.now() is relative to page/worker start, not the epoch, so
    // it can legitimately be near 0 for an edit made right after load.
    const state = this.textSendState.get(assetId) ?? { lastSentAt: -Infinity };
    this.textSendState.set(assetId, state);

    const now = performance.now();
    const elapsed = now - state.lastSentAt;
    if (elapsed >= TEXT_SEND_THROTTLE_MS) {
      if (state.trailingTimer !== undefined) {
        clearTimeout(state.trailingTimer);
        state.trailingTimer = undefined;
      }
      this.sendFullTextPatch(assetId, state);
      return;
    }

    // Already within the throttle window -- a trailing send is already
    // scheduled (or gets one now) for the moment it ends, so this exact
    // keystroke's content is never simply skipped, only delayed slightly.
    if (state.trailingTimer === undefined) {
      state.trailingTimer = setTimeout(() => {
        state.trailingTimer = undefined;
        this.sendFullTextPatch(assetId, state);
      }, TEXT_SEND_THROTTLE_MS - elapsed);
    }
  }

  private sendFullTextPatch(assetId: string, state: { lastSentAt: number }): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    // Re-measures right before sending (not just relying on whatever was
    // last measured mid-keystroke) so the very latest content -- which may
    // have changed again since the last measurement while this send sat in
    // the throttle window -- is what actually determines the box size sent
    // below.
    if (entry.asset.type === "text") this.measureTextAutoFit(assetId);
    const seq = this.nextSeq();
    entry.asset = { ...entry.asset, seq };
    state.lastSentAt = performance.now();
    // The asset's entire current patchable state, not just the text field
    // this particular keystroke changed -- every field of an asset shares
    // one seq-gated conditional write on the server (roomState.ts's
    // updateAsset), so a patch carrying only what changed would lose that
    // data permanently if it lost the seq race and got rejected as stale
    // (message.ts's silent "stale" drop, no retry). Sending everything --
    // including the current width/height, folded in by fullAssetPatch --
    // means a rejected/coalesced-away send is always truly redundant, and
    // there's no separate asset:resize message that could itself lose a
    // race against this one (see AssetPatch's own doc comment for why that
    // used to be exactly the bug here).
    this.callbacks.onAssetPatch(assetId, fullAssetPatch(entry.asset), seq);
  }

  // Bypasses the throttle to flush on session end (blur) -- otherwise the
  // very last keystroke before the user clicks away could sit unsent for up
  // to TEXT_SEND_THROTTLE_MS with no further typing left to eventually carry
  // it, same reasoning as onMouseUp's throttle bypass for move/resize. A
  // no-op if nothing's pending (e.g. blur with no edits made this session).
  // Public: also called from the sidebar's textarea on blur (see main.ts),
  // not just the canvas's own inline editor.
  flushPendingTextPatch(assetId: string): void {
    const state = this.textSendState.get(assetId);
    if (!state?.trailingTimer) return;
    clearTimeout(state.trailingTimer);
    state.trailingTimer = undefined;
    this.sendFullTextPatch(assetId, state);
  }

  // Text assets size themselves to fit their own rendered content (see
  // createElement/applyTransform's shrink-to-fit CSS) rather than being
  // manually resized -- this re-measures the already-repainted content
  // element and, if it changed, applies the corrected size locally right
  // away (so it's always reflected instantly, same as any other local
  // edit) and returns it for the caller to fold into whatever patch it's
  // about to send. Returns undefined when nothing changed (nothing for the
  // caller to add) -- purely local, sends nothing over the network itself.
  //
  // Deliberately does NOT send its own asset:resize message (a previous
  // design did, whether immediately or deferred to a throttled flush) --
  // seq-guarding *which order* two separate messages for the same asset
  // send in can't make them safe against each other, since server-side
  // Lambda invocations for each have no ordering guarantee independent of
  // send order. Whichever of the two got the "later" seq could still lose
  // to the other committing first. Folding the size correction into the
  // SAME patch/seq as whatever caused it (see callers) is what actually
  // fixes that -- see AssetPatch's own doc comment for the full history.
  private measureTextAutoFit(assetId: string): { width: number; height: number } | undefined {
    const entry = this.entries.get(assetId);
    if (!entry || (entry.asset.type !== "text" && entry.asset.type !== "clock")) return undefined;
    const { content, asset } = entry;
    const width = content.offsetWidth;
    const height = content.offsetHeight;
    // Epsilon guard: offsetWidth/Height are whole-pixel snapshots, so an
    // unchanged size can still round a pixel differently between renders --
    // without this, every call would re-trigger applyTransform for no
    // visual change (text isn't sized from asset.width/height).
    if (Math.abs(width - asset.width) < 1 && Math.abs(height - asset.height) < 1) return undefined;

    const w = Math.max(MIN_ASSET_SIZE, width);
    const h = Math.max(MIN_ASSET_SIZE, height);
    entry.asset = { ...entry.asset, width: w, height: h };
    this.applyTransform(entry, entry.asset);
    if (assetId === this.selectedAssetId) this.positionHandles();
    return { width: w, height: h };
  }

  remove(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry) {
      entry.el.remove();
      entry.ytController?.destroy();
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
    // Text and clock assets shrink-wrap to their own content instead (see
    // createElement/autoSizeText) -- forcing a width/height here would
    // fight with that, either clipping long text or leaving dead space.
    if (asset.type !== "text" && asset.type !== "clock") {
      el.style.width = `${asset.width}px`;
      el.style.height = `${asset.height}px`;
    }
    el.style.transform = `rotate(${asset.rotation}deg) scale(${asset.flipX ? -1 : 1}, ${asset.flipY ? -1 : 1})`;
    el.style.zIndex = String(asset.zIndex);
    el.style.outline = asset.assetId === this.selectedAssetId ? "2px solid #4da3ff" : "none";
    el.style.cursor = asset.locked ? "default" : "grab";
    // Blur lives on `content`, one level inside `el` -- `el` itself carries
    // the selection outline, and a CSS filter blurs everything painted for
    // the element it's on, so applying it to `el` blurred the outline too.
    content.style.filter = asset.blur > 0 ? `blur(${asset.blur}px)` : "";
    // See YOUTUBE_NATIVE_WIDTH's doc comment -- content stays a fixed
    // 1280x720 (its real pixel size, for YouTube's benefit) and is instead
    // CSS-scaled to visually fit the asset's actual box. Non-uniform scale
    // (not a single shared factor like streamPreview.ts's room-wide embed)
    // since an individual asset can be resized to any aspect ratio, same as
    // a plain <video>'s content already stretching non-uniformly to fill
    // its box today.
    if (asset.type === "youtube") {
      content.style.transform = `scale(${asset.width / YOUTUBE_NATIVE_WIDTH}, ${asset.height / YOUTUBE_NATIVE_HEIGHT})`;
    }
    if (asset.type === "text" || asset.type === "clock") {
      if (asset.type === "clock") {
        // The live time; advanced continuously by tickClocks, but also set
        // here so a style/config edit repaints immediately.
        const display = computeClockDisplay(asset, Date.now());
        if (content.textContent !== display) content.textContent = display;
      } else if (content.contentEditable !== "true") {
        // While actively being edited (see beginInlineTextEdit), the DOM's
        // own textContent -- the raw template the user is mid-typing -- is
        // authoritative; overwriting it with the *interpolated* display here
        // would both show the wrong thing (substituted values instead of the
        // {variable} placeholder being edited) and reset the caret to the
        // start on every keystroke.
        const interpolated = interpolateText(asset.text ?? "", this.variables);
        if (content.textContent !== interpolated) content.textContent = interpolated;
      }
      // Applied identically in browser-source's render.ts (via the same
      // shared resolveTextStyle/textStyleToCss helpers) so a text/clock asset
      // looks the same in the editor preview as it does to viewers.
      Object.assign(content.style, textStyleToCss(resolveTextStyle(asset)));
    }
    // Real local playback for video and (see Entry.media's doc comment)
    // audio, so a mod editing the room can see/hear what's actually
    // playing rather than relying solely on browser-source's own copy.
    if (entry.media) {
      syncMediaState(entry.media, asset, this.effectiveVolume(asset));
    }
    if (entry.ytController) {
      entry.ytController.sync(asset, this.effectiveVolume(asset));
    }
    // The canvas always shows every asset regardless of the true `visible`
    // flag (viewport-intersection + hidden) -- unlike browser-source, the
    // editor needs an omniscient view so things can be found/edited even
    // off-screen or manually hidden. `hidden` still gets a visual cue
    // (extra dimming on top of the asset's own opacity) so it's obvious
    // which assets won't actually show up for viewers.
    el.style.opacity = String(asset.hidden ? asset.opacity * 0.4 : asset.opacity);
  }

  private createElement(
    asset: Asset
  ): { el: HTMLElement; content: HTMLElement; media?: HTMLMediaElement; ytController?: YoutubePlayerController } {
    let content: HTMLElement;
    let media: HTMLMediaElement | undefined;
    let ytController: YoutubePlayerController | undefined;
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
        media = video;
        break;
      }
      case "audio": {
        // The icon stays the visible content (so an audio asset is still
        // identifiable at a glance) -- a real, invisible <audio> element
        // alongside it is what actually plays (see Entry.media's doc
        // comment).
        const icon = document.createElement("div");
        icon.style.display = "flex";
        icon.style.alignItems = "center";
        icon.style.justifyContent = "center";
        icon.innerHTML = ICON_AUDIO_LARGE;
        content = icon;
        const audio = document.createElement("audio");
        if (asset.s3Key) audio.src = this.mediaUrl(asset.s3Key);
        audio.style.display = "none";
        media = audio;
        break;
      }
      case "text": {
        // Layout-only here (never changes per-edit) -- the actual styling
        // (font/colors/shadow/outline) is applied in applyTransform(),
        // which runs on every render including the one immediately
        // following this element's creation, so setting it twice here
        // would just be overwritten redundantly.
        //
        // Deliberately no explicit width/height (see the skip below, and
        // applyTransform's matching skip) -- text assets size themselves to
        // fit their own content (autoSizeText) rather than being manually
        // resized, so both this and the outer `el` are left to shrink-wrap
        // naturally. white-space: pre (not pre-wrap) means only an explicit
        // newline breaks a line -- the text's own length is what grows the
        // box wider, matching a plain single-line-by-default text field.
        content = document.createElement("div");
        content.textContent = asset.text ?? "";
        content.style.padding = "4px";
        content.style.boxSizing = "border-box";
        content.style.whiteSpace = "pre";
        break;
      }
      case "clock": {
        // Same shrink-wrap layout as text; the computed time string + styling
        // are (re)applied in applyTransform and advanced by tickClocks.
        content = document.createElement("div");
        content.textContent = computeClockDisplay(asset, Date.now());
        content.style.padding = "4px";
        content.style.boxSizing = "border-box";
        content.style.whiteSpace = "pre";
        break;
      }
      case "youtube": {
        // See YOUTUBE_NATIVE_WIDTH's doc comment -- fixed native size, CSS-
        // scaled in applyTransform rather than stretched to fill `el` the
        // normal way (hence excluded from the generic 100% block below).
        const wrapper = document.createElement("div");
        wrapper.style.width = `${YOUTUBE_NATIVE_WIDTH}px`;
        wrapper.style.height = `${YOUTUBE_NATIVE_HEIGHT}px`;
        wrapper.style.transformOrigin = "0 0";
        // The YT iframe is a separate browsing context -- mouse events over
        // it never bubble up to `el`'s own mousedown listener below, which
        // is what drives select/drag/resize, so without this the asset was
        // simply unclickable/undraggable anywhere the iframe covers (i.e.
        // everywhere). Safe to disable entirely: controls: 0 (see
        // createYoutubePlayerController below) already means there's no
        // YouTube UI in there to click on directly -- playback is driven
        // from the sidebar/media-controls widget instead.
        wrapper.style.pointerEvents = "none";
        content = wrapper;
        const mount = document.createElement("div");
        mount.style.width = "100%";
        mount.style.height = "100%";
        wrapper.appendChild(mount);
        ytController = createYoutubePlayerController(mount, asset.youtubeVideoId ?? "", {
          // Same rationale as the native "ended" listener below -- see its
          // comment for the full mechanism.
          onEnded: () => {
            const entry = this.entries.get(asset.assetId);
            if (entry && !entry.asset.loop) this.patchAsset(asset.assetId, { paused: true });
          },
        });
        break;
      }
    }
    content.dataset.assetType = asset.type;
    // Text and clock assets are sized by their own content, not stretched to
    // fill `el` -- see the "text"/"clock" cases above. youtube stays fixed
    // native size -- see the "youtube" case above.
    if (asset.type !== "text" && asset.type !== "clock" && asset.type !== "youtube") {
      content.style.width = "100%";
      content.style.height = "100%";
    }

    const el = document.createElement("div");
    el.dataset.assetId = asset.assetId;
    el.style.position = "absolute";
    el.style.cursor = "grab";
    el.appendChild(content);
    el.addEventListener("mousedown", (event) => this.onAssetMouseDown(event, asset.assetId));
    if (asset.type === "text") {
      content.addEventListener("dblclick", (event) => this.beginInlineTextEdit(event, asset.assetId, content));
    }
    if (media && media !== content) el.appendChild(media);
    if (media) {
      // Nothing anywhere marks asset.paused true when a non-looping
      // video/audio naturally reaches its end -- without this, the next
      // syncMediaState call still sees "should be playing" and calls
      // .play() again, which browsers auto-restart from currentTime 0 on
      // an ended element, reading as an unwanted loop regardless of the
      // actual loop setting. Sending the real paused patch here (rather
      // than just setting a local flag) is what actually fixes it for
      // every connected client/browser-source, not just this one -- see
      // the plan's diagnosis for the full mechanism.
      media.addEventListener("ended", () => {
        const entry = this.entries.get(asset.assetId);
        if (entry && !entry.asset.loop) this.patchAsset(asset.assetId, { paused: true });
      });
    }
    return { el, content, media, ytController };
  }

  // Double-click-to-edit: makes the text element itself the editing
  // surface (rather than popping a separate input/modal) so the in-place
  // font/size/color styling is visible while typing. Every keystroke
  // patches immediately (same real-time behavior as the sidebar's sliders),
  // so there's no separate "commit" step -- Enter inserts a line break
  // (see onKeyDown below for why that can't just be left to the browser's
  // own default behavior) and Escape just ends the editing session (the
  // text is already saved).
  private beginInlineTextEdit(event: MouseEvent, assetId: string, content: HTMLElement): void {
    event.stopPropagation();
    const entry = this.entries.get(assetId);
    if (!entry || entry.asset.locked) return;
    this.inlineEditingAssetId = assetId;

    // Edit the raw template (with any {variable} placeholders intact), not
    // the interpolated display applyTransform normally shows -- otherwise
    // editing would start from the substituted value and silently lose the
    // placeholder syntax.
    content.textContent = entry.asset.text ?? "";
    content.contentEditable = "true";
    content.style.cursor = "text";
    content.focus();
    // Select all existing text so typing immediately replaces it, matching
    // the reference tool's own double-click-to-edit behavior.
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const onInput = () => {
      const next = content.textContent ?? "";
      // patchAsset already re-measures/resizes internally for a text-type
      // asset on every call (deferred while typing -- see its own doc) --
      // a second direct autoSizeText() call here used to be harmless (its
      // measurement was always identical to the one patchAsset had just
      // taken, so the epsilon guard made it a no-op), but calling it
      // undeferred risked sending a second, out-of-order resize outside the
      // throttled flush if that assumption ever broke. Removed as dead
      // weight rather than left as a landmine.
      if (next !== entry.asset.text) this.patchAsset(assetId, { text: next });
    };
    const stopEditing = (): void => {
      content.contentEditable = "false";
      content.style.cursor = "";
      content.removeEventListener("input", onInput);
      content.removeEventListener("blur", onBlur);
      content.removeEventListener("keydown", onKeyDown);
      if (this.inlineEditingAssetId === assetId) this.inlineEditingAssetId = undefined;
    };
    const onBlur = () => {
      stopEditing();
      this.flushPendingTextPatch(assetId);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        content.blur();
      } else if (e.key === "Enter") {
        // A plain contentEditable div's *default* Enter behavior doesn't
        // insert a literal "\n" text node -- browsers insert a new <div>/
        // <br> element boundary instead, purely a visual line break. Since
        // content.textContent (read in onInput above, and by every other
        // consumer of asset.text) just concatenates descendant text nodes
        // with no regard for element boundaries, that meant every line
        // break silently vanished from the *stored* text the instant it
        // left this specific DOM -- rendering correctly here (still the
        // same live DOM with its <br>s intact) but joining every line back
        // together with no separator at all everywhere else (sidebar,
        // browser-source, other collaborators).
        //
        // Regression: a hand-rolled Range/Selection insertion here (read
        // window.getSelection(), manually splice in a text node) silently
        // did nothing on the very first Enter press of an editing session,
        // then worked on every press after that -- some browsers' own
        // native dblclick-selects-word behavior for editable regions
        // appears to still be settling the selection right after this
        // editor opens, racing with a Range object captured a tick too
        // early. execCommand hands the actual text insertion back to the
        // browser's own (always-current) selection/caret handling instead
        // of this code trying to track it -- deprecated, but still the
        // standard, reliable way to do exactly this in a contentEditable
        // region, and it dispatches its own "input" event same as a real
        // keypress would, so onInput() doesn't need calling here directly.
        e.preventDefault();
        document.execCommand("insertText", false, "\n");
      }
    };
    content.addEventListener("input", onInput);
    content.addEventListener("blur", onBlur);
    content.addEventListener("keydown", onKeyDown);
  }

  // Bound once as instance fields (not inline closures) so dispose() has a
  // stable reference to pass to removeEventListener -- container and window
  // both outlive a single CanvasView instance (the container is a static
  // DOM element reused across room switches; window obviously always is),
  // so without this every switch would leave the previous instance's
  // handlers still firing alongside the new one.
  private readonly handleContainerMouseDown = (event: MouseEvent): void => {
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
  };

  private readonly handleWindowMouseMove = (event: MouseEvent): void => this.onMouseMove(event);
  private readonly handleWindowMouseUp = (): void => this.onMouseUp();

  private readonly handleContainerContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const rect = this.container.getBoundingClientRect();
    // Container-relative -- correct input for screenToWorld's pan/zoom math,
    // which is defined in the container's own local coordinate space.
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const world = this.screenToWorld(screenX, screenY);
    // event.clientX/clientY (viewport-relative), not the container-relative
    // screenX/screenY above -- #context-menu is position: fixed, which
    // positions against the viewport, not this container. Passing the
    // container-relative values here made the menu render offset from the
    // actual click by exactly the container's own on-page position (the
    // sidebar's width, the toolbar's height).
    this.callbacks.onContextMenu(world.x, world.y, event.clientX, event.clientY);
  };

  private readonly handleContainerWheel = (event: WheelEvent): void => {
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
  };

  private readonly handleWindowKeyDown = (event: KeyboardEvent): void => {
    // Backspace deliberately excluded -- it's the character-erase key used
    // while typing in the sidebar's name/text fields (and the canvas's own
    // inline text editing), so treating it as "delete asset" too meant
    // backspacing text while an asset was selected also deleted the asset.
    // Only "Delete" is a delete gesture anywhere else in the app.
    if (event.key !== "Delete" || !this.selectedAssetId) return;
    // Ignore while focus is inside a form field/editable region (typing in
    // the properties panel or the canvas's own inline text editor) --
    // otherwise pressing Delete to remove a character forward still deletes
    // the whole asset instead.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.contentEditable === "true")) return;
    this.callbacks.onAssetDelete(this.selectedAssetId);
  };

  private bindContainerEvents(): void {
    this.container.addEventListener("mousedown", this.handleContainerMouseDown);
    window.addEventListener("mousemove", this.handleWindowMouseMove);
    window.addEventListener("mouseup", this.handleWindowMouseUp);
    this.container.addEventListener("contextmenu", this.handleContainerContextMenu);
    this.container.addEventListener("wheel", this.handleContainerWheel, { passive: false });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", this.handleWindowKeyDown);
  }

  // Reverses everything bindContainerEvents()/bindKeyboard() set up, and
  // wipes the container's DOM so a fresh CanvasView on the same container
  // (switching rooms) starts from a clean slate rather than stacking a
  // second `world` div underneath/alongside the old one.
  dispose(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    window.removeEventListener("mousemove", this.handleWindowMouseMove);
    window.removeEventListener("mouseup", this.handleWindowMouseUp);
    window.removeEventListener("keydown", this.handleWindowKeyDown);
    this.container.removeEventListener("mousedown", this.handleContainerMouseDown);
    this.container.removeEventListener("contextmenu", this.handleContainerContextMenu);
    this.container.removeEventListener("wheel", this.handleContainerWheel);
    this.container.innerHTML = "";
    // Not inside `container` (see the constructor's doc comment on
    // mediaControls for why), so wiping container's innerHTML above doesn't
    // reach it -- without this a room switch would leave the previous
    // CanvasView's widget behind, orphaned in the DOM.
    this.mediaControls.remove();
  }

  private onAssetMouseDown(event: MouseEvent, assetId: string): void {
    // Only left click selects/drags — middle click (panning) and right
    // click (context menu) both need to fall through to the container's
    // own handlers rather than being captured here.
    if (event.button !== 0) return;
    // While a text asset's inline editor is active (see the dblclick
    // handler in createElement below), a mousedown is the user placing the
    // text cursor / selecting a range inside it -- must NOT also start a
    // canvas drag, or every click while editing would drag the asset out
    // from under the cursor instead of moving the caret.
    if ((event.target as HTMLElement).contentEditable === "true") return;
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
    const rect = this.container.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    // Bound to window (not just the container), so restrict tracking to
    // while the cursor is actually over the canvas -- otherwise an upload
    // triggered right after moving the mouse over the sidebar/toolbar would
    // place the asset under whatever was last hovered there instead.
    if (screenX >= 0 && screenY >= 0 && screenX <= rect.width && screenY <= rect.height) {
      this.lastMouseWorld = this.screenToWorld(screenX, screenY);
    }

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

  // Inverse of screenToWorld -- see updateMediaControls's own doc comment
  // for why the media-controls widget needs this instead of just inheriting
  // `world`'s CSS transform like the corner handles do.
  private worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return { x: worldX * this.zoom + this.pan.x, y: worldY * this.zoom + this.pan.y };
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
    const entry = this.selectedEntry();
    // Text and clock assets size themselves to fit their own content (see
    // autoSizeText/tickClocks) rather than being manually resized, so they
    // never get corner handles regardless of selection/lock state.
    if (!entry || entry.asset.locked || entry.asset.type === "text" || entry.asset.type === "clock") {
      for (const corner of CORNERS) this.handles[corner].style.display = "none";
    } else {
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
    // Locked only disables drag/resize, not playback -- unlike the corner
    // handles above, this must stay visible/usable for a locked video/audio
    // asset, so it's updated unconditionally here rather than folded into
    // the early-return branch.
    this.updateMediaControls(entry);
  }

  // Keeps the floating media-control widget (see the constructor) showing
  // the selected asset's current loop/paused/muted/volume state, and
  // positioned just above it -- called from every positionHandles() call
  // site (upsert, patchAsset, drag/resize, selection changes, wheel zoom),
  // so it can never drift out of sync with the sidebar, which reads from
  // this exact same Entry.
  private updateMediaControls(entry: Entry | undefined): void {
    const hasPlayback = entry?.asset.type === "video" || entry?.asset.type === "audio" || entry?.asset.type === "youtube";
    if (!entry || !hasPlayback) {
      this.mediaControls.style.display = "none";
      return;
    }
    const { asset } = entry;
    this.mediaControls.style.display = "block";
    this.mediaControlsLoopButton.classList.toggle("active", asset.loop);
    this.mediaControlsPlayButton.classList.toggle("active", !asset.paused);
    this.mediaControlsPauseButton.classList.toggle("active", asset.paused);
    this.mediaControlsMutedCheckbox.checked = asset.muted;
    const volumePercent = Math.round(asset.volume * 100);
    this.mediaControlsVolumeSlider.value = String(volumePercent);
    this.mediaControlsVolumeLabel.textContent = `volume: ${volumePercent}%`;

    // Centered above the asset's own (unrotated) top edge -- simpler than
    // the corner handles' rotation-aware math above, and reads fine for a
    // small control strip that doesn't need to visually track rotation the
    // way corner-drag handles do. In screen space (via worldToScreen), not
    // world space -- this widget lives outside `world` now (see the
    // constructor's doc comment for why), so it no longer inherits the
    // pan/zoom CSS transform for free and has to account for it here
    // instead. That also means the fixed 8px margin below doesn't need
    // dividing by zoom the way the corner handles' scale(1/zoom) trick
    // needed -- screen pixels are already the right unit.
    const anchor = this.worldToScreen(asset.x + asset.width / 2, asset.y);
    this.mediaControls.style.left = `${anchor.x}px`;
    this.mediaControls.style.top = `${anchor.y}px`;
    this.mediaControls.style.transform = "translate(-50%, calc(-100% - 8px))";
  }

  private applyWorldTransform(suppressCallback = false): void {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    if (suppressCallback) return;
    // Passes the rect directly rather than letting the callback call back
    // into this CanvasView instance -- this fires from within the
    // constructor itself (the initial applyWorldTransform() call), before
    // the caller's own `const canvas = new CanvasView(...)` has finished
    // assigning, so a callback that tried to reference that outer `canvas`
    // binding would hit its temporal dead zone.
    this.callbacks.onViewportTransformChanged?.(this.getViewportScreenRect());
  }

  // The viewport rect's on-screen bounding box, in the same coordinate
  // space as the container itself (i.e. suitable for positioning an
  // absolutely-positioned sibling of the container with plain left/top/
  // width/height) -- world-space rect run through the current pan/zoom.
  getViewportScreenRect(): { left: number; top: number; width: number; height: number } {
    return {
      left: this.viewport.x * this.zoom + this.pan.x,
      top: this.viewport.y * this.zoom + this.pan.y,
      width: this.viewport.width * this.zoom,
      height: this.viewport.height * this.zoom,
    };
  }

  // Media lives in the assets bucket/distribution, a completely separate
  // CloudFront distribution from the one serving this app itself.
  private mediaUrl(s3Key: string): string {
    return `https://${this.assetsDomain}/${s3Key}`;
  }
}

// See setVolumeMultipliers -- volume-only updates must never touch
// loop/play/pause/mute, only used from there.
function applyVolume(media: HTMLMediaElement, effectiveVolume: number): void {
  if (media.volume !== effectiveVolume) media.volume = effectiveVolume;
}

// Only touches properties that actually differ from the asset's target
// state -- re-assigning .loop/.volume unconditionally is harmless, but
// calling .play()/.pause() when already in that state can cause an
// audible/visible stutter on some browsers.
function syncMediaState(media: HTMLMediaElement, asset: Asset, effectiveVolume: number): void {
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
