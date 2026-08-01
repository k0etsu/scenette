import { ICON_EXPAND, ICON_SETTINGS } from "./icons";

const STORAGE_KEY = "scenette.streamPreview";

type Platform = "twitch" | "youtube";

interface StreamPreviewSettings {
  platform: Platform;
  twitchChannel: string;
  youtubeChannelId: string;
}

const DEFAULT_SETTINGS: StreamPreviewSettings = { platform: "twitch", twitchChannel: "", youtubeChannelId: "" };

// Twitch/YouTube's embedded player always preserves its own ~16:9 aspect
// ratio internally (letterboxing to fit whatever size iframe it's given,
// the same way a plain <video> would) -- there's no way to tell it to
// stretch or crop instead. Assumed here so the iframe can be deliberately
// oversized in applyRect() to compensate.
const VIDEO_ASPECT = 16 / 9;

// A real broadcast's encoded aspect ratio isn't always *exactly* 16:9 (and
// Twitch's own player page reserves a sliver of its own layout/padding
// around the video canvas that isn't part of the video itself), so sizing
// purely off VIDEO_ASPECT still left a visible sliver of the dashed
// viewport border showing on one edge. This adds a fixed overscan margin
// on top of the computed cover size so the video always bleeds slightly
// past every edge instead of landing exactly (or slightly short of) flush
// -- trading an imperceptible extra crop for a guaranteed full fill.
const OVERSCAN = 1.08;

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

// A purely local alignment aid, never synced to collaborators or broadcast
// to browser-source (only asset transforms are shared room state -- see
// plan). Renders the actual live Twitch/YouTube page as a translucent
// overlay positioned exactly over the room's viewport rect, tracking
// pan/zoom, so placing an asset can be judged against real on-screen
// stream content instead of guessing blindly.
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
  private readonly iframe: HTMLIFrameElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly overlay: HTMLElement,
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
    this.overlay.style.overflow = "hidden";
    this.overlay.style.display = "none";
    this.iframe = document.createElement("iframe");
    // Sized precisely by applyRect() on every rect update, not left at a
    // flat 100%/100% -- see applyRect() for why (filling an arbitrary-
    // aspect-ratio rect with a fixed-16:9 video needs deliberate
    // oversizing, not a plain 100% fit, or a gap is left on one axis).
    this.iframe.style.position = "absolute";
    this.iframe.style.top = "50%";
    this.iframe.style.left = "50%";
    this.iframe.style.transform = "translate(-50%, -50%)";
    this.iframe.style.border = "none";
    this.iframe.allow = "autoplay";
    this.overlay.appendChild(this.iframe);

    this.render();
  }

  // Called from CanvasView's onViewportTransformChanged callback -- pan,
  // zoom, and viewport-rect changes all funnel through the same hook, so
  // this is the one place the overlay's position/size needs to be kept in
  // sync from.
  setScreenRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.lastScreenRect = rect;
    if (this.embedCheckbox.checked) this.applyRect(rect);
  }

  private applyRect(rect: { left: number; top: number; width: number; height: number }): void {
    this.overlay.style.left = `${rect.left}px`;
    this.overlay.style.top = `${rect.top}px`;
    this.overlay.style.width = `${rect.width}px`;
    this.overlay.style.height = `${rect.height}px`;

    // The video itself always keeps VIDEO_ASPECT regardless of the iframe
    // box's own shape (see VIDEO_ASPECT's comment) -- to make it actually
    // fill `rect` (an object-fit: cover effect, which doesn't exist for
    // iframes since we don't control the document inside one) rather than
    // letterboxing with a visible gap, the iframe is deliberately made
    // larger than the rect on whichever axis wouldn't otherwise be
    // covered, then centered and clipped by the overlay's overflow:hidden.
    const rectAspect = rect.width / rect.height;
    if (rectAspect > VIDEO_ASPECT) {
      // rect is wider than the video -- height is the binding constraint,
      // so stretch height until the video's own 16:9 width covers rect's
      // full width too, then overscan both axes by the same margin so the
      // result still fills exactly (scaling only one axis by OVERSCAN
      // would distort the crop's aspect ratio).
      this.iframe.style.width = `${OVERSCAN * 100}%`;
      this.iframe.style.height = `${(rectAspect / VIDEO_ASPECT) * OVERSCAN * 100}%`;
    } else {
      this.iframe.style.height = `${OVERSCAN * 100}%`;
      this.iframe.style.width = `${(VIDEO_ASPECT / rectAspect) * OVERSCAN * 100}%`;
    }
  }

  private render(): void {
    const on = this.embedCheckbox.checked;
    this.overlay.style.display = on ? "block" : "none";
    this.overlay.style.opacity = String(Number(this.opacitySlider.value) / 100);
    // Unchecked ("interactive" off) lets clicks/drags fall through to the
    // canvas underneath, which is the default -- otherwise the overlay
    // would block every mouse interaction with the actual editing surface.
    this.overlay.style.pointerEvents = this.interactiveCheckbox.checked ? "auto" : "none";

    if (!on) return;
    if (this.lastScreenRect) this.applyRect(this.lastScreenRect);

    const url = embedUrl(this.settings);
    if (url && this.lastAssignedSrc !== url) {
      this.iframe.src = url;
      this.lastAssignedSrc = url;
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
