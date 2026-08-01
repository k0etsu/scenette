import { ICON_EXPAND, ICON_SETTINGS, ICON_VIDEO } from "./icons";

const STORAGE_KEY = "scenette.streamPreview";

type Platform = "twitch" | "youtube";

interface StreamPreviewSettings {
  platform: Platform;
  twitchChannel: string;
  youtubeChannelId: string;
}

const DEFAULT_SETTINGS: StreamPreviewSettings = { platform: "twitch", twitchChannel: "", youtubeChannelId: "" };

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

function loadSettings(): StreamPreviewSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function embedUrl(settings: StreamPreviewSettings): string | undefined {
  if (settings.platform === "twitch") {
    if (!settings.twitchChannel) return undefined;
    // parent must match the actual serving hostname exactly or Twitch
    // refuses to render the embed -- read live rather than hardcoded so
    // this works the same on dev.hanzomon.co, hanzomon.co, and localhost.
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

// A purely local alignment aid, never synced to collaborators or broadcast
// to browser-source (only asset transforms are shared room state -- see
// plan). The viewport-rect placeholder + boundary line are *always*
// visible (confirmed against the reference tool -- both show regardless
// of the "embed" checkbox's state), tracking pan/zoom continuously; the
// "embed" checkbox only chooses what's composited into that area: the
// generic placeholder icon, or the actual live Twitch/YouTube page.
export class StreamPreviewPanel {
  private settings: StreamPreviewSettings;
  private lastScreenRect?: { left: number; top: number; width: number; height: number };
  // Tracked separately from iframe.src -- both Twitch's and YouTube's
  // embed pages rewrite the URL after load (session params, redirects),
  // so reading iframe.src back and comparing against a freshly-computed
  // url is never equal after the first load. That made every render()
  // (including one fired by every opacity-slider "input" event) look like
  // a genuinely new URL and reassign iframe.src, reloading -- and pausing
  // -- the embed on every single drag tick.
  private lastAssignedSrc?: string;

  private readonly embedCheckbox: HTMLInputElement;
  private readonly interactiveCheckbox: HTMLInputElement;
  private readonly opacitySlider: HTMLInputElement;
  private readonly platformSelect: HTMLSelectElement;
  private readonly wrapper: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly iframe: HTMLIFrameElement;
  private readonly borderWrapper: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly overlay: HTMLElement,
    private readonly borderEl: HTMLElement,
    private readonly settingsModal: HTMLElement
  ) {
    this.settings = loadSettings();

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

    this.embedCheckbox.addEventListener("change", () => this.render());
    this.interactiveCheckbox.addEventListener("change", () => this.render());
    this.opacitySlider.addEventListener("input", () => this.render());
    this.platformSelect.addEventListener("change", () => {
      this.settings.platform = this.platformSelect.value as Platform;
      this.saveSettings();
      this.render();
    });

    root.querySelector('[data-role="settings"]')!.addEventListener("click", () => this.openSettings());

    // Bound once here (not per-open) -- settingsModal itself is a
    // persistent element that survives openSettings()'s innerHTML rebuild,
    // so re-adding this on every open would stack duplicate listeners.
    this.settingsModal.addEventListener("click", (event) => {
      if (event.target === this.settingsModal) this.closeSettings();
    });

    this.overlay.style.position = "absolute";
    // Always visible -- see the class doc. Only the iframe-vs-placeholder
    // choice inside it (see render()) responds to the "embed" checkbox.
    this.overlay.style.display = "block";

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

    this.borderEl.style.left = `${rect.left}px`;
    this.borderEl.style.top = `${rect.top}px`;
    this.borderWrapper.style.transform = `scale(${scale})`;
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
    this.overlay.style.pointerEvents = this.interactiveCheckbox.checked ? "auto" : "none";

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

  private saveSettings(): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
  }

  private openSettings(): void {
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
      this.settings.twitchChannel = twitchChannel;
      this.settings.youtubeChannelId = youtubeChannelId;
      this.saveSettings();
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
