import {
  Asset,
  Variable,
  Viewport,
  computeClockDisplay,
  interpolateText,
  resolveTextStyle,
  textStyleToCss,
  createYoutubePlayerController,
  YoutubePlayerController,
} from "@scenette/protocol";

// Same fixed-native-size + CSS-scale technique as control-ui's canvas.ts --
// see its own YOUTUBE_NATIVE_WIDTH doc comment for the full rationale
// (keeping the player's real pixel size constant so YouTube's auto-quality
// heuristic isn't misled by a small on-screen display size).
const YOUTUBE_NATIVE_WIDTH = 1280;
const YOUTUBE_NATIVE_HEIGHT = 720;

// Renders viewport-relative coordinates: an asset at world position (x,y)
// is drawn at (x - viewport.x, y - viewport.y) so the OBS canvas only ever
// shows the fixed viewport window, regardless of where the room's assets
// sit in the wider world/canvas space.
interface Entry {
  el: HTMLElement;
  asset: Asset; // latest known true state (the interpolation target)
  rendered: { x: number; y: number; width: number; height: number }; // what's actually on screen right now
  // Set by the "ended" listener (see createElement) when a non-looping
  // video/audio naturally finishes -- this connection is read-only (no
  // session, blocked from asset:update server-side, see
  // services/websocket-handlers/src/message.ts), so unlike control-ui it
  // can never send the corrected `paused: true` itself. Suppresses
  // syncMediaState's play-branch locally until the server's own paused/loop
  // state actually catches up (via some other connection's patch) or loop
  // gets turned on, preventing the browser's native "play() on an ended
  // element restarts it from 0" behavior from looping the asset forever.
  endedWhileNotLooping?: boolean;
  // youtube assets only -- the fixed-1280x720 wrapper (a child of `el`,
  // CSS-scaled to fit the asset's rendered/interpolated box) and the live
  // player controller. See canvas.ts's identical technique.
  ytWrapper?: HTMLElement;
  ytController?: YoutubePlayerController;
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
  // Room-level master volume (see sound.ts in control-ui) -- unlike
  // control-ui's own preview, there's no "local" knob here at all: this is
  // what viewers actually hear, full stop.
  private globalVolume = 1;
  // Guards against an out-of-order broadcast (the slider fires on every
  // drag tick, each a separate message with no ordering guarantee) undoing
  // a later tick's already-applied value.
  private globalVolumeSeq = 0;
  private variables: Record<string, Variable> = {};

  constructor(private readonly root: HTMLElement, private readonly assetsDomain: string) {
    // Runs forever, not just while geometry is actively interpolating.
    // jsdom-based tests can't catch this class of bug (it doesn't do real
    // paint/compositing), but a page with no ongoing requestAnimationFrame
    // activity risks having non-geometric style changes (opacity/blur/
    // rotation/flip -- anything applied outside the interpolation path)
    // never actually get flushed to a captured frame, since some browser/
    // CEF (OBS's renderer) power-saving heuristics assume "no rAF = nothing
    // visually changing = safe to skip compositing." A continuous rAF loop
    // guarantees every applied style change gets composited on the very
    // next frame regardless of the specific capture pipeline's heuristics.
    // The idempotent per-frame paint() calls are cheap (pure style writes,
    // no layout reads), so this isn't a meaningful CPU cost for what's a
    // single always-visible overlay page.
    requestAnimationFrame(() => this.tick());
  }

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

  setGlobalVolume(globalVolume: number, seq: number): void {
    if (seq < this.globalVolumeSeq) return;
    this.globalVolumeSeq = seq;
    this.globalVolume = globalVolume;
    for (const entry of this.entries.values()) {
      if (entry.asset.type === "video" || entry.asset.type === "audio") {
        // Only ever touches .volume -- see applyVolume for why this must
        // NOT go through the full syncMediaState (loop/play/pause/mute).
        applyVolume(entry.el as HTMLMediaElement, this.effectiveVolume(entry.asset));
      } else if (entry.ytController) {
        // No equivalent volume-only fast path needed here -- the
        // controller's own sync() already only touches what actually
        // differs (see youtubePlayer.ts), so it doesn't have the native
        // syncMediaState play()-during-buffering race this volume-only
        // path exists to avoid for video/audio.
        entry.ytController.sync(entry.asset, this.effectiveVolume(entry.asset));
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
        if (entry.el.textContent !== interpolated) entry.el.textContent = interpolated;
      }
    }
  }

  private effectiveVolume(asset: Asset): number {
    return Math.min(1, Math.max(0, asset.volume * this.globalVolume));
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
        entry.ytController?.destroy();
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
      entry?.ytController?.destroy();
      const { el, ytWrapper, ytController } = this.createElement(asset);
      entry = {
        el,
        ytWrapper,
        ytController,
        asset,
        rendered: { x: asset.x, y: asset.y, width: asset.width, height: asset.height },
      };
      this.entries.set(asset.assetId, entry);
      this.root.appendChild(el);
      this.paint(entry); // first appearance snaps immediately, nothing to interpolate from
      return;
    }
    entry.asset = asset;
    this.applyImmediateFields(entry);
  }

  remove(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry) {
      entry.el.remove();
      entry.ytController?.destroy();
      this.entries.delete(assetId);
    }
  }

  // asset:stopped's own effect -- see AssetStopMessage's protocol doc
  // comment for why this is a pure ephemeral broadcast rather than a
  // persisted field: playback position isn't part of Asset at all, so
  // there's nothing for the accompanying asset:updated (paused: true) to
  // carry here. Both video and audio have a real element here, so both
  // actually get reset.
  stop(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    if (entry.asset.type === "video" || entry.asset.type === "audio") {
      (entry.el as HTMLMediaElement).currentTime = 0;
      entry.endedWhileNotLooping = false;
    } else if (entry.asset.type === "youtube") {
      entry.ytController?.seekToStart();
      entry.endedWhileNotLooping = false;
    }
  }

  // asset:seeked's own effect -- same ephemeral shape as stop() above, see
  // AssetSeekMessage's protocol doc comment.
  seek(assetId: string, positionSeconds: number): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    if (entry.asset.type === "video" || entry.asset.type === "audio") {
      (entry.el as HTMLMediaElement).currentTime = positionSeconds;
    } else if (entry.asset.type === "youtube") {
      entry.ytController?.seekTo(positionSeconds);
    }
  }

  private tick(): void {
    for (const entry of this.entries.values()) {
      const { rendered, asset } = entry;
      const dx = asset.x - rendered.x;
      const dy = asset.y - rendered.y;

      if (Math.abs(dx) < SNAP_EPSILON && Math.abs(dy) < SNAP_EPSILON) {
        rendered.x = asset.x;
        rendered.y = asset.y;
      } else {
        rendered.x += dx * SMOOTHING_FACTOR;
        rendered.y += dy * SMOOTHING_FACTOR;
      }

      // Text assets are never resized via a drag gesture (control-ui hides
      // their corner handles entirely) -- their width/height only ever
      // changes as a discrete auto-fit correction following a content/font
      // edit (see control-ui's autoSizeText), not as part of a continuous
      // stream of updates the way an actual dragged resize is. Smoothing
      // that the same way as a drag made the box visibly lag behind the
      // text actually being typed -- clipping mid-word/mid-line until the
      // animation caught up, worse the bigger a single correction was.
      // Snapping instead is correct here: there's no "motion" to smooth,
      // just an occasional correct-size update that should just apply.
      if (asset.type === "text" || asset.type === "clock") {
        rendered.width = asset.width;
        rendered.height = asset.height;
      } else {
        const dw = asset.width - rendered.width;
        const dh = asset.height - rendered.height;
        if (Math.abs(dw) < SNAP_EPSILON && Math.abs(dh) < SNAP_EPSILON) {
          rendered.width = asset.width;
          rendered.height = asset.height;
        } else {
          rendered.width += dw * SMOOTHING_FACTOR;
          rendered.height += dh * SMOOTHING_FACTOR;
        }
      }
      this.paint(entry);
    }

    requestAnimationFrame(() => this.tick());
  }

  private paint(entry: Entry): void {
    const { el, asset, rendered } = entry;
    const left = rendered.x - this.viewport.x;
    const top = rendered.y - this.viewport.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${rendered.width}px`;
    el.style.height = `${rendered.height}px`;
    this.applyImmediateFields(entry);
  }

  private applyImmediateFields(entry: Entry): void {
    const { el, asset } = entry;
    el.style.transform = `rotate(${asset.rotation}deg) scale(${asset.flipX ? -1 : 1}, ${asset.flipY ? -1 : 1})`;
    el.style.zIndex = String(asset.zIndex);
    el.style.display = asset.visible ? "block" : "none";
    el.style.opacity = String(asset.opacity);
    el.style.filter = asset.blur > 0 ? `blur(${asset.blur}px)` : "";
    if (asset.type === "text" || asset.type === "clock") {
      // Clocks recompute their content here every frame (applyImmediateFields
      // runs from paint() on every rAF tick), so the displayed time advances
      // with no per-second network traffic. Text uses variable interpolation.
      const content =
        asset.type === "clock"
          ? computeClockDisplay(asset, Date.now())
          : interpolateText(asset.text ?? "", this.variables);
      if (el.textContent !== content) el.textContent = content;
      Object.assign(el.style, textStyleToCss(resolveTextStyle(asset)));
    }
    if (asset.type === "video" || asset.type === "audio") {
      // See Entry.endedWhileNotLooping's doc comment -- once a non-looping
      // asset has locally ended, skip re-syncing (which would otherwise
      // call .play() again and browser-native-restart it from 0) until the
      // server's own state actually says paused or loop, at which point
      // this stops being relevant and normal syncing resumes.
      if (entry.endedWhileNotLooping && !asset.paused && !asset.loop) return;
      entry.endedWhileNotLooping = false;
      syncMediaState(el as HTMLMediaElement, asset, this.effectiveVolume(asset));
    }
    if (asset.type === "youtube") {
      // Scaled from `rendered`, not `asset`, so the embed grows/shrinks in
      // lockstep with the same drag/resize smoothing every other asset type
      // gets (see tick()). Uniform scale (object-fit: contain's own
      // behavior -- see createElement's `el.style.objectFit = "contain"`
      // for image/video, matching control-ui's canvas.ts) -- the box
      // itself can be any shape, but a non-uniform
      // scale would visibly distort YouTube's iframe UI chrome, unlike a
      // raster image/native video's pixels which stretch cleanly.
      if (entry.ytWrapper) {
        const scale = Math.min(entry.rendered.width / YOUTUBE_NATIVE_WIDTH, entry.rendered.height / YOUTUBE_NATIVE_HEIGHT);
        const offsetX = (entry.rendered.width - YOUTUBE_NATIVE_WIDTH * scale) / 2;
        const offsetY = (entry.rendered.height - YOUTUBE_NATIVE_HEIGHT * scale) / 2;
        entry.ytWrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      }
      // Same ended-suppression concern as native video/audio above -- the
      // controller's onEnded callback (see createElement) sets the same
      // flag.
      if (entry.endedWhileNotLooping && !asset.paused && !asset.loop) return;
      entry.endedWhileNotLooping = false;
      entry.ytController?.sync(asset, this.effectiveVolume(asset));
    }
  }

  private createElement(
    asset: Asset
  ): { el: HTMLElement; ytWrapper?: HTMLElement; ytController?: YoutubePlayerController } {
    let el: HTMLElement;
    let ytWrapper: HTMLElement | undefined;
    let ytController: YoutubePlayerController | undefined;
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
        video.autoplay = !asset.paused;
        // This is a pure output surface -- playback is driven entirely by
        // asset state, never by direct interaction with the element itself.
        // Without this, OBS's browser-source "Interact" mode (or a stray
        // click if the source is ever viewed in a plain browser tab) could
        // toggle play/pause or open native picture-in-picture controls,
        // desyncing what's shown from what asset.paused actually says.
        video.style.pointerEvents = "none";
        el = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("audio");
        audio.src = asset.s3Key ? this.mediaUrl(asset.s3Key) : "";
        audio.autoplay = !asset.paused;
        audio.style.pointerEvents = "none";
        el = audio;
        break;
      }
      case "text": {
        // Layout-only here -- the actual styling (font/colors/shadow/
        // outline) is applied in applyImmediateFields(), which runs
        // immediately after this element is created (see upsert()/paint()).
        //
        // Must match control-ui/src/canvas.ts's text case exactly: white-
        // space: pre (not pre-wrap), no word-break, no overflow:hidden.
        // Text assets auto-size themselves to fit their own content there
        // (see canvas.ts's autoSizeText) rather than wrapping within a
        // fixed box -- only an explicit newline breaks a line, the text's
        // own length determines the width. Rendering this with pre-wrap +
        // word-break (the old fixed-box styling) forced text to wrap
        // mid-word to fit whatever width/height happened to be stored,
        // which visibly diverged from control-ui's own (correctly
        // unwrapped, auto-fit) rendering of the same asset.
        el = document.createElement("div");
        el.textContent = asset.text ?? "";
        el.style.padding = "4px";
        el.style.boxSizing = "border-box";
        el.style.whiteSpace = "pre";
        break;
      }
      case "clock": {
        // Same layout as text (styling + the computed time string are applied
        // in applyImmediateFields, which runs immediately after creation and
        // then every frame). Must match control-ui/src/canvas.ts's clock case.
        el = document.createElement("div");
        el.textContent = computeClockDisplay(asset, Date.now());
        el.style.padding = "4px";
        el.style.boxSizing = "border-box";
        el.style.whiteSpace = "pre";
        break;
      }
      case "youtube": {
        // See YOUTUBE_NATIVE_WIDTH's doc comment -- `el` is a plain
        // positioned/sized box (paint() drives its geometry the same as
        // every other asset type); `ytWrapper` nested inside it stays a
        // fixed native size and is the only thing ever CSS-scaled.
        el = document.createElement("div");
        ytWrapper = document.createElement("div");
        ytWrapper.style.position = "absolute";
        ytWrapper.style.top = "0";
        ytWrapper.style.left = "0";
        ytWrapper.style.width = `${YOUTUBE_NATIVE_WIDTH}px`;
        ytWrapper.style.height = `${YOUTUBE_NATIVE_HEIGHT}px`;
        ytWrapper.style.transformOrigin = "0 0";
        // Same rationale as video/audio's pointer-events above -- this is a
        // pure output surface, nothing should ever interact with the
        // embedded player directly (also matches control-ui's canvas.ts,
        // which needs this for a different reason -- see its own comment).
        ytWrapper.style.pointerEvents = "none";
        const mount = document.createElement("div");
        mount.style.width = "100%";
        mount.style.height = "100%";
        ytWrapper.appendChild(mount);
        el.appendChild(ytWrapper);
        ytController = createYoutubePlayerController(mount, asset.youtubeVideoId ?? "", {
          // Same rationale as the native "ended" listener below.
          onEnded: () => {
            const entry = this.entries.get(asset.assetId);
            if (entry && !entry.asset.loop) entry.endedWhileNotLooping = true;
          },
        });
        break;
      }
    }
    el.dataset.assetType = asset.type;
    el.style.position = "absolute";
    el.style.objectFit = "contain";
    if (asset.type === "video" || asset.type === "audio") {
      // See Entry.endedWhileNotLooping's doc comment for why this is a
      // local-only suppression flag rather than a server patch (this
      // connection is read-only).
      el.addEventListener("ended", () => {
        const entry = this.entries.get(asset.assetId);
        if (entry && !entry.asset.loop) entry.endedWhileNotLooping = true;
      });
    }
    return { el, ytWrapper, ytController };
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

// Deliberately does nothing else -- the global-volume slider fires on
// every drag tick (like the other live sliders), which broadcasts
// room:globalVolumeChanged to every client on every tick. Routing that
// through the full syncMediaState below (which also re-runs the
// play/pause branch) meant a volume drag could re-issue .play() dozens of
// times a second on an asset that was merely mid-buffer (media.paused
// momentarily true while asset.paused is false) -- each call interrupts
// the previous one's promise and races the forced-mute/restore, which is
// what made playback go unresponsive while someone was just touching the
// volume slider. A volume-only update must never touch loop/play/pause/mute.
function applyVolume(media: HTMLMediaElement, effectiveVolume: number): void {
  if (media.volume !== effectiveVolume) media.volume = effectiveVolume;
}

// Only touches properties that actually differ from the asset's target
// state -- re-assigning .loop/.muted/.volume unconditionally is harmless,
// but calling .play()/.pause() when already in that state can cause an
// audible/visible stutter on some browsers.
function syncMediaState(media: HTMLMediaElement, asset: Asset, effectiveVolume: number): void {
  if (media.loop !== asset.loop) media.loop = asset.loop;
  applyVolume(media, effectiveVolume);
  if (asset.paused && !media.paused) {
    media.pause();
    media.muted = asset.muted;
  } else if (!asset.paused && media.paused) {
    // A freshly-added asset's very first .play() call can be rejected by
    // the browser/CEF's autoplay policy (no user gesture -- browser-source
    // has none to offer) with no automatic retry, which previously left the
    // asset stuck paused until the OBS browser source was manually
    // refreshed. Muted autoplay is allowed essentially everywhere, so
    // force-mute just for this call and restore the asset's real mute
    // state once playback has actually started.
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
