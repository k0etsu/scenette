import { StreamPreviewSettings } from "@scenette/protocol";
import { ICON_EXPAND, ICON_SETTINGS, ICON_VIDEO } from "./icons";

type Platform = StreamPreviewSettings["platform"];

const DEFAULT_SETTINGS: StreamPreviewSettings = { platform: "twitch", twitchChannel: "", youtubeChannelId: "" };

export interface StreamPreviewCallbacks {
  // Fires only when the room's owner actually saves a channel change (see
  // openSettings()) -- never for a mod, who can't reach this at all (the
  // settings gear is hidden and the platform select disabled for them, see
  // setIsOwner). The caller is responsible for actually sending this over
  // the wire (room:setStreamPreviewSettings) with the given seq.
  onSettingsChange: (settings: StreamPreviewSettings, seq: number) => void;
}

// The reference tool hardcodes its embed area at exactly 1920x1080 rather
// than fitting/cropping to whatever aspect ratio the room's own viewport
// happens to be -- rooms are always created at this same 1920x1080 (see
// roomState.ts's DEFAULT_VIEWPORT), so a single uniform scale factor
// (rect.width / NATIVE_WIDTH) gives an exact 1:1 correspondence between
// screen pixels and the video/placeholder/border's own native pixels, with
// no aspect-ratio-mismatch cases to reconcile at all.
const NATIVE_WIDTH = 1920;
const NATIVE_HEIGHT = 1080;

// Native-space thickness of the always-on-top boundary line (scales down
// with everything else via the wrapper's transform, same as the reference
// tool's own fixed-px strips inside its identically-scaled wrapper).
const BORDER_STRIP_THICKNESS = 6;

function embedUrl(settings: StreamPreviewSettings): string | undefined {
  if (settings.platform === "twitch") {
    if (!settings.twitchChannel) return undefined;
    // parent must match the actual serving hostname exactly or Twitch
    // refuses to render the embed -- read live rather than hardcoded so
    // this works the same on dev.hanzomon.co, hanzomon.co, and localhost.
    //
    // Known Twitch-side limitation, not fixable here: channels streaming at
    // the 1440p "Enhanced Broadcasting" tier can fail inside this embed with
    // "Player stopping playback - error MasterPlaylist:4 (ErrorInvalidData
    // code 0 - Failed to parse HLS master playlist)", thrown from Twitch's
    // own amazon-ivs-wasmworker. Confirmed this isn't about our iframe/
    // parent/URL construction -- the same channel fails identically when
    // player.twitch.tv is opened directly in a bare tab, while a channel
    // streaming at a lower resolution works fine through the exact same
    // embed. Nothing to do on our end until Twitch fixes their embed player.
    return `https://player.twitch.tv/?channel=${encodeURIComponent(settings.twitchChannel)}&parent=${window.location.hostname}&muted=true`;
  }
  if (!settings.youtubeChannelId) return undefined;
  // Resolves to whatever's currently live on that channel with no need to
  // know the specific video ID -- falls back to the channel page if
  // nothing's live, so this doubles as a no-API-key live/offline signal.
  return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(settings.youtubeChannelId)}`;
}

// Positioned entirely *outside* the wrapper's own edge (a negative offset
// equal to the strip's own thickness) rather than inset flush with it, so
// only the strip's innermost edge ever touches the boundary line -- the
// rest of its width/height extends outward into the space beyond the
// viewport, never covering any of the actual placeholder/embed content.
//
// Top/bottom strips additionally extend left/right past both corners (by
// the same thickness) so they meet the left/right strips' outer edges with
// no gap; left/right strips are left un-extended (top/bottom flush at 0) so
// the two pairs never overlap each other -- an overlap would double up the
// backdrop-filter: invert() and cancel back out to no visible effect there.
function makeBorderStrip(edge: "top" | "bottom" | "left" | "right"): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "stream-preview-border-strip";
  if (edge === "top" || edge === "bottom") {
    strip.style.left = `-${BORDER_STRIP_THICKNESS}px`;
    strip.style.right = `-${BORDER_STRIP_THICKNESS}px`;
    strip.style[edge] = `-${BORDER_STRIP_THICKNESS}px`;
    strip.style.height = `${BORDER_STRIP_THICKNESS}px`;
  } else {
    strip.style.top = "0";
    strip.style.bottom = "0";
    strip.style[edge] = `-${BORDER_STRIP_THICKNESS}px`;
    strip.style.width = `${BORDER_STRIP_THICKNESS}px`;
  }
  return strip;
}

// The viewport-rect placeholder + boundary line are *always* visible
// (confirmed against the reference tool -- both show regardless of the
// "embed" checkbox's state), tracking pan/zoom continuously; the "embed"
// checkbox only chooses what's composited into that area: the generic
// placeholder icon, or the actual live Twitch/YouTube page.
//
// Which channel is configured (`this.settings`) is room state, not a local
// preference -- every connected client sees the same platform/channel, and
// only the room's owner may change it (see setIsOwner). This used to be
// per-browser localStorage, which meant every mod could silently diverge on
// their own separate channel for what's supposed to be one shared alignment
// aid. The "embed"/"interactive"/opacity controls stay purely local though
// (never synced) -- they're just this one browser's own viewing preference,
// not something collaborators need to agree on.
export class StreamPreviewPanel {
  private settings: StreamPreviewSettings = DEFAULT_SETTINGS;
  // Starts false (read-only) until the caller confirms ownership via
  // setIsOwner -- safer default than briefly allowing an edit that then
  // gets rejected server-side once the room's real membership is known.
  private isOwner = false;
  private lastScreenRect?: { left: number; top: number; width: number; height: number };
  // Tracked separately from iframe.src -- both Twitch's and YouTube's
  // embed pages rewrite the URL after load (session params, redirects),
  // so reading iframe.src back and comparing against a freshly-computed
  // url is never equal after the first load. That made every render()
  // (including one fired by every opacity-slider "input" event) look like
  // a genuinely new URL and reassign iframe.src, reloading -- and pausing
  // -- the embed on every single drag tick.
  private lastAssignedSrc?: string;
  // Same wall-clock-based monotonic pattern as sound.ts's SoundPanel --
  // see nextSeq()'s own comment for the full rationale (server-stored seq
  // persists across reloads/sessions, so a fresh session's counter
  // restarting at 0 would almost always lose the server's staleness check).
  private lastSeq = 0;

  private readonly embedCheckbox: HTMLInputElement;
  private readonly interactiveCheckbox: HTMLInputElement;
  private readonly opacitySlider: HTMLInputElement;
  private readonly platformSelect: HTMLSelectElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly wrapper: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly iframe: HTMLIFrameElement;
  private readonly borderWrapper: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly overlay: HTMLElement,
    private readonly borderEl: HTMLElement,
    private readonly settingsModal: HTMLElement,
    private readonly canvasInner: HTMLElement,
    private readonly callbacks: StreamPreviewCallbacks
  ) {
    root.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-icon-button" data-role="expand">${ICON_EXPAND}</span>
        <span>Stream Preview</span>
        <button type="button" class="sidebar-icon-button" data-role="settings" title="Configure channels">${ICON_SETTINGS}</button>
      </div>
      <div class="stream-preview-row">
        <label><input type="checkbox" data-role="embed" /> embed</label>
        <label><input type="checkbox" data-role="interactive" /> interactive</label>
        <select data-role="platform">
          <option value="twitch">Twitch</option>
          <option value="youtube">YouTube</option>
        </select>
      </div>
      <div class="prop-slider-row">
        <label class="prop-label">Opacity:</label>
      </div>
      <input type="range" data-role="opacity" min="0" max="100" value="100" />
    `;

    const expandButton = root.querySelector<HTMLElement>('[data-role="expand"]')!;
    expandButton.addEventListener("click", () => {
      const collapsed = root.classList.toggle("panel-collapsed");
      expandButton.title = collapsed ? "Expand" : "Collapse";
    });

    this.embedCheckbox = root.querySelector('[data-role="embed"]')!;
    this.interactiveCheckbox = root.querySelector('[data-role="interactive"]')!;
    this.opacitySlider = root.querySelector('[data-role="opacity"]')!;
    this.platformSelect = root.querySelector('[data-role="platform"]')!;
    this.platformSelect.value = this.settings.platform;
    this.settingsButton = root.querySelector('[data-role="settings"]')!;
    // Read-only until setIsOwner(true) confirms this connection is the
    // room's owner -- see the class doc for why the channel itself is
    // room-owned, unlike embed/interactive/opacity.
    this.platformSelect.disabled = true;
    // visibility, not display -- see setIsOwner's comment on why this
    // button's layout space must stay reserved regardless of ownership.
    this.settingsButton.style.visibility = "hidden";

    this.embedCheckbox.addEventListener("change", () => this.render());
    this.interactiveCheckbox.addEventListener("change", () => this.render());
    this.opacitySlider.addEventListener("input", () => this.render());
    this.platformSelect.addEventListener("change", () => {
      if (!this.isOwner) return; // defensive -- disabled should already prevent this
      this.settings = { ...this.settings, platform: this.platformSelect.value as Platform };
      this.callbacks.onSettingsChange(this.settings, this.nextSeq());
      this.render();
    });

    this.settingsButton.addEventListener("click", () => this.openSettings());

    // Bound once here (not per-open) -- settingsModal itself is a
    // persistent element that survives openSettings()'s innerHTML rebuild,
    // so re-adding this on every open would stack duplicate listeners.
    this.settingsModal.addEventListener("click", (event) => {
      if (event.target === this.settingsModal) this.closeSettings();
    });

    this.overlay.style.position = "absolute";
    // Always visible once positioned -- see the class doc. Only the
    // iframe-vs-placeholder choice inside it (see render()) responds to the
    // "embed" checkbox. Hidden (visibility, not display -- see borderEl's
    // comment below) until the first setScreenRect() call so this never
    // paints at whatever default top:0/left:0 static position it'd
    // otherwise fall back to before CanvasView's first real (already-
    // centered) rect arrives.
    this.overlay.style.display = "block";
    this.overlay.style.visibility = "hidden";

    // A single fixed-native-size wrapper holds the placeholder and the
    // iframe as plain 100%-filling children; only the wrapper itself is
    // ever transformed (scaled), so there's exactly one place doing any
    // size math instead of separately fitting each child.
    this.wrapper = document.createElement("div");
    this.wrapper.style.position = "absolute";
    this.wrapper.style.top = "0";
    this.wrapper.style.left = "0";
    this.wrapper.style.width = `${NATIVE_WIDTH}px`;
    this.wrapper.style.height = `${NATIVE_HEIGHT}px`;
    this.wrapper.style.transformOrigin = "0 0";
    this.overlay.appendChild(this.wrapper);

    // Shown whenever "embed" is unchecked, or checked with no channel
    // configured for the current platform -- sits *below* the iframe in
    // DOM order (plain stacking, no z-index needed) so a configured embed
    // always covers it, and #stream-preview-overlay's own z-index (below
    // #canvas-inner's) means canvas assets already cover it too. No border
    // of its own -- #stream-preview-border's always-on-top strips are the
    // one and only boundary indicator, so it doesn't visually double up.
    this.placeholder = document.createElement("div");
    this.placeholder.style.position = "absolute";
    this.placeholder.style.inset = "0";
    this.placeholder.style.boxSizing = "border-box";
    this.placeholder.style.background = "#1a1b20";
    this.placeholder.style.display = "flex";
    this.placeholder.style.alignItems = "center";
    this.placeholder.style.justifyContent = "center";
    this.placeholder.style.color = "rgba(245, 240, 225, 0.6)";
    // Reuses the same outline used for video assets elsewhere in the app
    // (icons.ts's ICON_VIDEO) rather than inventing a new graphic, just
    // scaled way up -- it doesn't need to represent this specific tool,
    // only read as "a video will go here" at a glance.
    this.placeholder.innerHTML = ICON_VIDEO.replace(/width="14"/, 'width="140"').replace(/height="14"/, 'height="140"');
    this.wrapper.appendChild(this.placeholder);

    this.iframe = document.createElement("iframe");
    // Fixed native size, never resized directly -- Twitch's page treats
    // the iframe's own box as its real viewport and re-flows its own
    // responsive CSS at that size; its chrome (the "channel is offline"
    // card, control bar icons) doesn't shrink below some minimum, so at a
    // small on-screen size that chrome would visually dominate a now-tiny
    // video instead of shrinking proportionally with it. Keeping the
    // iframe's own box at a constant native size means Twitch always
    // renders its normal, fully-proportioned desktop UI; the wrapper's
    // transform (a paint-time-only operation that never triggers Twitch's
    // own internal re-layout) uniformly shrinks the *entire* already-
    // rendered result -- video and chrome together -- to fit the screen.
    this.iframe.style.position = "absolute";
    this.iframe.style.inset = "0";
    this.iframe.style.width = "100%";
    this.iframe.style.height = "100%";
    this.iframe.style.border = "none";
    this.iframe.style.display = "none";
    this.iframe.allow = "autoplay";
    this.wrapper.appendChild(this.iframe);

    // The always-on-top boundary line -- a separate element (not nested
    // under #stream-preview-overlay, which sits below canvas assets) so it
    // can render *above* assets too, matching the reference tool's
    // backdrop-invert strips at the top of the whole stacking order. Mirrors
    // the same fixed-native-size + single-scale-transform approach as the
    // overlay's own wrapper, so the two always land in perfect agreement.
    this.borderEl.style.position = "absolute";
    this.borderEl.style.display = "block";
    // Regression: CanvasView used to fire onViewportTransformChanged
    // synchronously during construction with the *uncentered* default
    // rect (pan:0/zoom:1), before its own deferred first-centering pass
    // completed -- setScreenRect() applied that rect immediately, so this
    // boundary (and the overlay above) rendered pinned to the top-left
    // corner for a frame before jumping to center. CanvasView no longer
    // fires that premature callback, but hiding here too (rather than
    // relying solely on the caller) means this element is correct by
    // construction even if some other caller ever calls setScreenRect
    // before a real rect is known. Revealed in applyRect() below.
    this.borderEl.style.visibility = "hidden";
    this.borderWrapper = document.createElement("div");
    this.borderWrapper.style.position = "absolute";
    this.borderWrapper.style.top = "0";
    this.borderWrapper.style.left = "0";
    this.borderWrapper.style.width = `${NATIVE_WIDTH}px`;
    this.borderWrapper.style.height = `${NATIVE_HEIGHT}px`;
    this.borderWrapper.style.transformOrigin = "0 0";
    this.borderEl.appendChild(this.borderWrapper);
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      this.borderWrapper.appendChild(makeBorderStrip(edge));
    }

    this.render();
  }

  // Called from CanvasView's onViewportTransformChanged callback -- pan,
  // zoom, and viewport-rect changes all funnel through the same hook, so
  // this is the one place the overlay/border's position/scale need to be
  // kept in sync from. Always applied -- the placeholder + boundary are
  // visible regardless of the "embed" checkbox (see the class doc).
  setScreenRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.lastScreenRect = rect;
    this.applyRect(rect);
  }

  private applyRect(rect: { left: number; top: number; width: number; height: number }): void {
    // A single scalar, not separately fitting width and height -- see
    // NATIVE_WIDTH's comment for why that's deliberate (rooms are always
    // created at exactly this same 1920x1080, so there's no aspect-ratio
    // mismatch to reconcile with a "cover"/"contain" scale in the first
    // place, just a uniform zoom factor).
    const scale = rect.width / NATIVE_WIDTH;

    this.overlay.style.left = `${rect.left}px`;
    this.overlay.style.top = `${rect.top}px`;
    this.wrapper.style.transform = `scale(${scale})`;
    this.overlay.style.visibility = "visible";

    this.borderEl.style.left = `${rect.left}px`;
    this.borderEl.style.top = `${rect.top}px`;
    this.borderWrapper.style.transform = `scale(${scale})`;
    this.borderEl.style.visibility = "visible";
  }

  private render(): void {
    // Overlay and border are always visible (see class doc) -- only their
    // opacity/pointer-events (overlay only; the border is never dimmable
    // or clickable) and the iframe-vs-placeholder choice below respond to
    // the controls.
    this.overlay.style.opacity = String(Number(this.opacitySlider.value) / 100);
    // Unchecked ("interactive" off) lets clicks/drags fall through to the
    // canvas underneath, which is the default -- otherwise the overlay
    // would block every mouse interaction with the actual editing surface.
    const interactive = this.interactiveCheckbox.checked;
    this.overlay.style.pointerEvents = interactive ? "auto" : "none";
    // #canvas-inner sits *above* the overlay in stacking order (z-index 10
    // vs. 1, so canvas assets visually cover the embed -- see index.html),
    // which means it's also the topmost element hit-tested for clicks
    // across the *entire* canvas area, not just where assets actually are.
    // With interactive checked, setting the overlay's own pointer-events to
    // auto alone did nothing: canvas-inner still received every click first
    // and swallowed it before it could reach the iframe underneath. Toggling
    // canvas-inner's pointer-events to none lets clicks pass through it to
    // the overlay/iframe below while interactive mode is on, without
    // touching z-index (so assets still visually cover the embed as before).
    this.canvasInner.style.pointerEvents = interactive ? "none" : "";

    if (this.lastScreenRect) this.applyRect(this.lastScreenRect);

    const url = this.embedCheckbox.checked ? embedUrl(this.settings) : undefined;
    if (url) {
      this.iframe.style.display = "block";
      this.placeholder.style.display = "none";
      if (this.lastAssignedSrc !== url) {
        this.iframe.src = url;
        this.lastAssignedSrc = url;
      }
    } else {
      this.iframe.style.display = "none";
      this.placeholder.style.display = "flex";
    }
  }

  // Wall-clock-based, not a simple session-local counter -- see
  // CanvasView.nextSeq()'s comment for the full rationale (a fresh
  // session's counter restarting at 0 would almost always be lower than
  // whatever the server already has stored, permanently rejecting every
  // save after a page refresh).
  private nextSeq(): number {
    const now = Date.now();
    this.lastSeq = now > this.lastSeq ? now : this.lastSeq + 1;
    return this.lastSeq;
  }

  // Applied only from a later room:streamPreviewSettingsChanged broadcast
  // (including this browser's own echo) within the SAME room -- guarded the
  // same way as SoundPanel.setGlobalVolume so an out-of-order arrival can't
  // stomp a more recent local edit. Never called for a room's initial
  // snapshot -- see enterRoom() below for why that needs to bypass this
  // guard entirely rather than reuse it.
  applySettings(settings: StreamPreviewSettings, seq: number): void {
    if (seq < this.lastSeq) return;
    this.lastSeq = seq;
    this.settings = settings;
    this.platformSelect.value = settings.platform;
    this.render();
  }

  // Called once per room entry (this room's initial room:snapshot), not for
  // a later live broadcast -- this panel is a singleton that survives every
  // room switch (see the class doc), so without this its state from the
  // PREVIOUS room leaked into the next one: `lastSeq` doesn't reset between
  // rooms, so the new room's real (lower) stored seq could get silently
  // rejected as "stale" by applySettings' guard, permanently stuck showing
  // the old room's channel; the embed checkbox stayed however it was left in
  // the last room instead of defaulting off; and the iframe kept its
  // previous room's already-loaded src (lastAssignedSrc suppresses a
  // reassignment that looks like "no change", even though the room changed).
  enterRoom(settings: StreamPreviewSettings, seq: number): void {
    this.lastSeq = seq;
    this.settings = settings;
    this.platformSelect.value = settings.platform;
    this.lastAssignedSrc = undefined;
    this.embedCheckbox.checked = false;
    this.interactiveCheckbox.checked = false;
    this.opacitySlider.value = "100";
    this.render();
  }

  // Controls whether this connection may actually change the channel --
  // only the room's owner can (see the class doc). Mods still see and use
  // whatever channel is currently configured; they just can't change it.
  setIsOwner(isOwner: boolean): void {
    this.isOwner = isOwner;
    this.platformSelect.disabled = !isOwner;
    // visibility (not display) -- keeps this button's layout space
    // reserved so the header title stays centered between the expand icon
    // and this slot regardless of ownership, rather than the title visibly
    // drifting off-center when the third element disappears entirely.
    this.settingsButton.style.visibility = isOwner ? "visible" : "hidden";
  }

  private openSettings(): void {
    if (!this.isOwner) return; // defensive -- the button is hidden for a non-owner
    this.settingsModal.innerHTML = `
      <div class="stream-settings-content">
        <div class="sidebar-header">
          <span>Stream Preview Settings</span>
          <button type="button" data-role="close" class="sidebar-icon-button">✕</button>
        </div>
        <label class="prop-label">Twitch channel (username)</label>
        <input type="text" data-role="twitch-channel" placeholder="e.g. shroud" value="${escapeAttr(this.settings.twitchChannel)}" />
        <label class="prop-label">YouTube channel ID</label>
        <input type="text" data-role="youtube-channel" placeholder="UCxxxxxxxxxxxxxxxxxxxxxx" value="${escapeAttr(this.settings.youtubeChannelId)}" />
        <div class="access-status">YouTube needs the channel's ID (starts with UC), not its @handle.</div>
        <button type="button" data-role="save" class="toolbar-button">Save</button>
      </div>
    `;
    this.settingsModal.style.display = "flex";

    this.settingsModal.querySelector('[data-role="close"]')!.addEventListener("click", () => this.closeSettings());
    this.settingsModal.querySelector('[data-role="save"]')!.addEventListener("click", () => {
      const twitchChannel = (this.settingsModal.querySelector('[data-role="twitch-channel"]') as HTMLInputElement).value.trim();
      const youtubeChannelId = (this.settingsModal.querySelector('[data-role="youtube-channel"]') as HTMLInputElement).value.trim();
      this.settings = { ...this.settings, twitchChannel, youtubeChannelId };
      this.callbacks.onSettingsChange(this.settings, this.nextSeq());
      this.render();
      this.closeSettings();
    });
  }

  private closeSettings(): void {
    this.settingsModal.style.display = "none";
    this.settingsModal.innerHTML = "";
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
