// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createYoutubePlayerController } from "../src/youtubePlayer";
import { Asset } from "../src/asset";

const PlayerState = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

class FakePlayer {
  state = PlayerState.CUED;
  volume = 100;
  muted = false;
  currentTime = 0;
  duration = 120;
  seekTo = vi.fn((seconds: number, _allowSeekAhead?: boolean) => {
    this.currentTime = seconds;
  });
  playVideo = vi.fn(() => {
    this.state = PlayerState.PLAYING;
  });
  pauseVideo = vi.fn(() => {
    this.state = PlayerState.PAUSED;
  });
  mute = vi.fn(() => {
    this.muted = true;
  });
  unMute = vi.fn(() => {
    this.muted = false;
  });
  isMuted = vi.fn(() => this.muted);
  setVolume = vi.fn((v: number) => {
    this.volume = v;
  });
  getVolume = vi.fn(() => this.volume);
  getPlayerState = vi.fn(() => this.state);
  getCurrentTime = vi.fn(() => this.currentTime);
  getDuration = vi.fn(() => this.duration);
  destroy = vi.fn(() => {});
}

let lastOptions: any;
let lastInstance: FakePlayer;

class FakeYTPlayerCtor {
  constructor(_container: HTMLElement, options: any) {
    lastOptions = options;
    lastInstance = new FakePlayer();
  }
}

(window as any).YT = { Player: FakeYTPlayerCtor, PlayerState };

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    roomId: "room1",
    assetId: "yt1",
    type: "youtube",
    x: 0,
    y: 0,
    width: 480,
    height: 270,
    rotation: 0,
    zIndex: 0,
    visible: true,
    hidden: false,
    locked: false,
    opacity: 1,
    blur: 0,
    flipX: false,
    flipY: false,
    loop: false,
    muted: false,
    volume: 1,
    paused: false,
    seq: 1,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    keep: false,
    youtubeVideoId: "dQw4w9WgXcQ",
    ...overrides,
  };
}

async function createReadyController() {
  const onEnded = vi.fn();
  const container = document.createElement("div");
  const controller = createYoutubePlayerController(container, "dQw4w9WgXcQ", { onEnded });
  await vi.waitFor(() => expect(lastOptions).toBeDefined());
  lastOptions.events.onReady({ target: lastInstance });
  await controller.ready;
  return {
    controller,
    player: lastInstance,
    onEnded,
    fireStateChange: (data: number) => lastOptions.events.onStateChange({ data }),
  };
}

beforeEach(() => {
  lastOptions = undefined;
  lastInstance = undefined as unknown as FakePlayer;
});

describe("createYoutubePlayerController", () => {
  it("never autoplays via the constructor -- sync() is the sole play/pause driver", async () => {
    await createReadyController();
    expect(lastOptions.videoId).toBe("dQw4w9WgXcQ");
    expect(lastOptions.playerVars.autoplay).toBe(0);
  });

  it("queues sync() calls made before the player is ready, and applies them once ready", async () => {
    const container = document.createElement("div");
    const controller = createYoutubePlayerController(container, "dQw4w9WgXcQ");
    controller.sync(makeAsset({ paused: false, muted: false }), 0.5);
    await vi.waitFor(() => expect(lastOptions).toBeDefined());
    expect(lastInstance.playVideo).not.toHaveBeenCalled();

    lastOptions.events.onReady({ target: lastInstance });

    expect(lastInstance.playVideo).toHaveBeenCalled();
    expect(lastInstance.setVolume).toHaveBeenCalledWith(50);
  });

  it("force-mutes a fresh play attempt and restores the real mute state once PLAYING fires", async () => {
    const { controller, player, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ paused: false, muted: false }), 1);

    expect(player.mute).toHaveBeenCalled();
    expect(player.playVideo).toHaveBeenCalled();
    expect(player.unMute).not.toHaveBeenCalled();

    fireStateChange(PlayerState.PLAYING);

    expect(player.unMute).toHaveBeenCalled();
  });

  it("does not need to unmute afterward when the asset itself wants muted", async () => {
    const { controller, player, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ paused: false, muted: true }), 1);
    expect(player.mute).toHaveBeenCalled();

    fireStateChange(PlayerState.PLAYING);

    expect(player.unMute).not.toHaveBeenCalled();
  });

  it("does not call playVideo/mute/unMute again once already playing and settled", async () => {
    const { controller, player, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ paused: false, muted: false }), 1);
    fireStateChange(PlayerState.PLAYING);
    player.playVideo.mockClear();
    player.mute.mockClear();
    player.unMute.mockClear();

    controller.sync(makeAsset({ paused: false, muted: false }), 1);

    expect(player.playVideo).not.toHaveBeenCalled();
    expect(player.mute).not.toHaveBeenCalled();
    expect(player.unMute).not.toHaveBeenCalled();
  });

  it("calls pauseVideo when asset.paused becomes true while playing", async () => {
    const { controller, player, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ paused: false }), 1);
    fireStateChange(PlayerState.PLAYING);

    controller.sync(makeAsset({ paused: true }), 1);

    expect(player.pauseVideo).toHaveBeenCalled();
  });

  it("converts 0-1 effective volume to a 0-100 setVolume call, and skips redundant calls once rounded", async () => {
    const { controller, player } = await createReadyController();
    controller.sync(makeAsset(), 0.73);
    expect(player.setVolume).toHaveBeenCalledWith(73);
    player.setVolume.mockClear();

    controller.sync(makeAsset(), 0.734); // rounds to the same 73

    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it("seeks to 0 and replays on ENDED when the asset is set to loop", async () => {
    const { controller, player, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ loop: true }), 1);

    fireStateChange(PlayerState.ENDED);

    expect(player.seekTo).toHaveBeenCalledWith(0, true);
    expect(player.playVideo).toHaveBeenCalled();
  });

  it("fires onEnded instead of replaying when the asset is not set to loop", async () => {
    const { controller, player, onEnded, fireStateChange } = await createReadyController();
    controller.sync(makeAsset({ loop: false }), 1);

    fireStateChange(PlayerState.ENDED);

    expect(onEnded).toHaveBeenCalled();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("seekToStart seeks to 0 and pauses", async () => {
    const { controller, player } = await createReadyController();
    controller.seekToStart();
    expect(player.seekTo).toHaveBeenCalledWith(0, true);
    expect(player.pauseVideo).toHaveBeenCalled();
  });

  it("seekToStart before the player is ready does nothing (no throw)", () => {
    const controller = createYoutubePlayerController(document.createElement("div"), "dQw4w9WgXcQ");
    expect(() => controller.seekToStart()).not.toThrow();
  });

  it("seekTo jumps to the given position without touching play/pause", async () => {
    const { controller, player } = await createReadyController();
    controller.sync(makeAsset({ paused: false }), 1);
    player.pauseVideo.mockClear();
    player.playVideo.mockClear();

    controller.seekTo(42);

    expect(player.seekTo).toHaveBeenCalledWith(42, true);
    expect(player.pauseVideo).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
  });

  it("seekTo before the player is ready does nothing (no throw)", () => {
    const controller = createYoutubePlayerController(document.createElement("div"), "dQw4w9WgXcQ");
    expect(() => controller.seekTo(10)).not.toThrow();
  });

  it("getCurrentTime/getDuration read through to the player once ready", async () => {
    const { controller, player } = await createReadyController();
    player.currentTime = 30;
    player.duration = 180;

    expect(controller.getCurrentTime()).toBe(30);
    expect(controller.getDuration()).toBe(180);
  });

  it("getCurrentTime/getDuration return 0 before the player is ready", () => {
    const controller = createYoutubePlayerController(document.createElement("div"), "dQw4w9WgXcQ");
    expect(controller.getCurrentTime()).toBe(0);
    expect(controller.getDuration()).toBe(0);
  });

  it("destroy() calls the underlying player's destroy", async () => {
    const { controller, player } = await createReadyController();
    controller.destroy();
    expect(player.destroy).toHaveBeenCalled();
  });

  it("destroy() called after construction but before onReady fires destroys the player once onReady does fire", async () => {
    const container = document.createElement("div");
    const controller = createYoutubePlayerController(container, "dQw4w9WgXcQ");
    await vi.waitFor(() => expect(lastOptions).toBeDefined());
    const target = lastInstance;

    controller.destroy(); // player was constructed, but onReady hasn't fired yet
    lastOptions.events.onReady({ target });

    expect(target.destroy).toHaveBeenCalled();
  });

  it("destroy() called before ready skips constructing a player at all", async () => {
    const container = document.createElement("div");
    const controller = createYoutubePlayerController(container, "dQw4w9WgXcQ");
    controller.destroy();
    // Give the loadYoutubeApi()/ready promise chain every chance it would
    // otherwise need to construct a player -- it never does.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lastOptions).toBeUndefined();
  });
});
