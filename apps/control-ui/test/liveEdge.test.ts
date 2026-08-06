import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveEdgeMonitor, LivePlayer, DRIFT_THRESHOLD_S, POLL_INTERVAL_MS } from "../src/liveEdge";

const PLAYING = 1;
const PAUSED = 2;

function makePlayer(overrides: Partial<LivePlayer> = {}): LivePlayer & { seekTo: ReturnType<typeof vi.fn> } {
  return {
    getDuration: () => 1000,
    getCurrentTime: () => 1000 - DRIFT_THRESHOLD_S - 10,
    getPlayerState: () => PLAYING,
    seekTo: vi.fn(),
    ...overrides,
  };
}

let monitor: LiveEdgeMonitor;

beforeEach(() => {
  vi.useFakeTimers();
  monitor = new LiveEdgeMonitor();
});

afterEach(() => {
  monitor.stop();
  vi.useRealTimers();
});

describe("LiveEdgeMonitor", () => {
  it("seeks a playing player back to the live head once drift exceeds the threshold", () => {
    const player = makePlayer();
    monitor.start(player);

    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(player.seekTo).toHaveBeenCalledWith(1000, true);
  });

  it("leaves a healthy player (small natural drift) alone", () => {
    const player = makePlayer({ getCurrentTime: () => 1000 - 5 });
    monitor.start(player);

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("never seeks while the player is not actively playing (paused drift is deliberate)", () => {
    const player = makePlayer({ getPlayerState: () => PAUSED });
    monitor.start(player);

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("stop() ends polling entirely", () => {
    const player = makePlayer();
    monitor.start(player);
    monitor.stop();

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("restarting replaces the previous poll instead of stacking a second one", () => {
    const first = makePlayer();
    const second = makePlayer();
    monitor.start(first);
    monitor.start(second);

    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(first.seekTo).not.toHaveBeenCalled();
    expect(second.seekTo).toHaveBeenCalledTimes(1);
  });
});
