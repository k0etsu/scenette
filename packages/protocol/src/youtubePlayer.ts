import { Asset } from "./asset";

// The one deliberate exception to this package's otherwise pure,
// environment-agnostic functions: canvas.ts (control-ui's editor) and
// render.ts (browser-source's actual output) both need identical YouTube
// IFrame Player control logic, matching the existing precedent that already
// puts resolveTextStyle/textStyleToCss/computeClockDisplay here specifically
// because those two files need to agree exactly. This file does real DOM/
// window.YT work, unlike every other file in this package.

// Minimal local typings for the handful of IFrame Player API pieces this
// module actually uses -- avoids taking a dependency on @types/youtube for
// what's a small, stable surface. See
// https://developers.google.com/youtube/iframe_api_reference
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

interface YTPlayerOptions {
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: YTPlayer }) => void;
    onStateChange?: (event: { data: number }) => void;
  };
}

interface YTNamespace {
  Player: new (container: HTMLElement, options: YTPlayerOptions) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

// Module-level cache -- injects the API script at most once regardless of
// how many youtube assets end up wanting a player concurrently, and every
// caller shares the same resolved namespace.
let apiReadyPromise: Promise<YTNamespace> | undefined;

function loadYoutubeApi(): Promise<YTNamespace> {
  if (apiReadyPromise) return apiReadyPromise;
  apiReadyPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    // Chains onto whatever's already registered (harmless if nothing is)
    // rather than clobbering it -- some other part of the page could in
    // principle also be waiting on this same global callback.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiReadyPromise;
}

export interface YoutubePlayerCallbacks {
  // Fired when playback reaches the end while the asset is NOT set to loop
  // -- mirrors the native "ended" handling canvas.ts/render.ts already do
  // for video/audio elements (see their own doc comments for the full
  // mechanism this exists to avoid): the caller is responsible for either
  // patching { paused: true } (control-ui, which can reach the server) or
  // applying its own local suppression (browser-source, which is
  // read-only). This module never assumes which.
  onEnded?: () => void;
}

export interface YoutubePlayerController {
  // Resolves once the underlying YT.Player is actually constructed and
  // ready -- most callers won't need this directly since sync() is safe to
  // call beforehand, but it's exposed for cleanup ordering / tests.
  ready: Promise<YTPlayer>;
  // Reconciles the player's actual state toward `asset`'s playback fields,
  // only touching what differs -- same discipline as canvas.ts/render.ts's
  // own syncMediaState, for the same reason (redundant .playVideo()/
  // .pauseVideo() calls can visibly stutter). Safe to call before the
  // player is ready: the latest call's arguments are queued and replayed
  // once onReady fires, since (unlike a native <video>/<audio> element) the
  // player has no synchronous existence to control immediately.
  sync(asset: Asset, effectiveVolume: number): void;
  // The youtube counterpart to resetting a native element's .currentTime to
  // 0 (see canvas.ts's stopAsset / render.ts's stop()) -- pairs with the
  // caller's own { paused: true } patch/broadcast, exactly like the native
  // Stop button already does for video/audio.
  seekToStart(): void;
  // Jumps to an arbitrary position without touching play/pause -- the
  // youtube counterpart to setting a native element's .currentTime
  // directly, for the seek slider (see canvas.ts's media-controls widget).
  // A no-op before the player is ready, same as seekToStart.
  seekTo(seconds: number): void;
  // Best-effort reads of the player's own live state, for the seek
  // slider's position/duration display -- 0 before the player is ready,
  // matching a native element's .currentTime defaulting to 0 before
  // metadata loads (callers already treat "not ready" as "nothing to show").
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

export function createYoutubePlayerController(
  container: HTMLElement,
  videoId: string,
  callbacks: YoutubePlayerCallbacks = {}
): YoutubePlayerController {
  let player: YTPlayer | undefined;
  let playerState: YTNamespace["PlayerState"] | undefined;
  let pendingSync: { asset: Asset; effectiveVolume: number } | undefined;
  let lastAsset: Asset | undefined;
  // Set only while a forced-mute autoplay attempt is in flight -- mirrors
  // syncMediaState's own "force-mute just for this call, restore once
  // playback has actually started" trick, needed because a fresh player's
  // very first playVideo() can otherwise be silently blocked by the same
  // autoplay policy native <video>/<audio> already has to work around.
  let pendingUnmute = false;
  let destroyed = false;

  function applySync(asset: Asset, effectiveVolume: number): void {
    if (!player || !playerState) {
      pendingSync = { asset, effectiveVolume };
      return;
    }
    const volumePercent = Math.round(effectiveVolume * 100);
    if (Math.round(player.getVolume()) !== volumePercent) player.setVolume(volumePercent);

    const state = player.getPlayerState();
    const isPlaying = state === playerState.PLAYING || state === playerState.BUFFERING;
    if (asset.paused && isPlaying) {
      player.pauseVideo();
      if (player.isMuted() !== asset.muted) (asset.muted ? player.mute() : player.unMute());
    } else if (!asset.paused && !isPlaying) {
      const wantMuted = asset.muted;
      if (!player.isMuted()) player.mute();
      pendingUnmute = !wantMuted;
      player.playVideo();
    } else if (player.isMuted() !== asset.muted) {
      (asset.muted ? player.mute() : player.unMute());
    }
  }

  function handleStateChange(event: { data: number }): void {
    if (!player || !playerState) return;
    if (event.data === playerState.PLAYING && pendingUnmute) {
      pendingUnmute = false;
      player.unMute();
    }
    if (event.data === playerState.ENDED) {
      if (lastAsset?.loop) {
        player.seekTo(0, true);
        player.playVideo();
      } else {
        callbacks.onEnded?.();
      }
    }
  }

  const ready = loadYoutubeApi().then(
    (YT) =>
      new Promise<YTPlayer>((resolve) => {
        // destroy() was already called before the API even finished
        // loading (e.g. the asset was deleted moments after being added) --
        // nothing left to construct a player for.
        if (destroyed) return;
        playerState = YT.PlayerState;
        new YT.Player(container, {
          videoId,
          // Never autoplay via the constructor itself -- sync() (called
          // with whatever queued state exists the moment onReady fires) is
          // the single source of truth for play/pause, exactly like a
          // freshly-created native <video>/<audio> element only starts
          // playing once syncMediaState says so.
          playerVars: { autoplay: 0, controls: 0, enablejsapi: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: (event) => {
              if (destroyed) {
                event.target.destroy();
                return;
              }
              player = event.target;
              if (pendingSync) {
                const { asset, effectiveVolume } = pendingSync;
                pendingSync = undefined;
                applySync(asset, effectiveVolume);
              }
              resolve(event.target);
            },
            onStateChange: handleStateChange,
          },
        });
      })
  );

  return {
    ready,
    sync(asset, effectiveVolume) {
      lastAsset = asset;
      applySync(asset, effectiveVolume);
    },
    seekToStart() {
      if (!player) return;
      player.seekTo(0, true);
      player.pauseVideo();
    },
    seekTo(seconds) {
      player?.seekTo(seconds, true);
    },
    getCurrentTime() {
      return player?.getCurrentTime() ?? 0;
    },
    getDuration() {
      return player?.getDuration() ?? 0;
    },
    destroy() {
      destroyed = true;
      player?.destroy();
      player = undefined;
    },
  };
}
