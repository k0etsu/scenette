// YouTube's live embed drifts ever further behind the live edge over a
// long session: the player is DVR-enabled, so every buffering stall (or a
// background-throttled tab) leaves the playhead where it stopped, and the
// player never catches back up to the live head on its own. There is no
// viewer-side latency setting to fix this declaratively -- the stream's
// latency class (normal/low/ultra-low) is chosen by the broadcaster
// (https://support.google.com/youtube/answer/7444635) and the IFrame API
// exposes no latency control (https://developers.google.com/youtube/iframe_api_reference).
// The one lever it does expose is seekTo(): for a live stream getDuration()
// is the elapsed stream time, i.e. the live head, so seeking there snaps
// playback back to the live edge.
export interface LivePlayer {
  getDuration(): number;
  getCurrentTime(): number;
  getPlayerState(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}

// YT.PlayerState.PLAYING -- resync only during active playback: while
// paused the drift is deliberate (the user paused), and while buffering a
// seek would only thrash an already-struggling player.
const PLAYING = 1;

// Comfortably above the few seconds a healthy player naturally trails the
// live head (well under this even on a normal-latency stream), so a resync
// only ever fires on genuine accumulated drift, never in a tug-of-war with
// the player's own normal buffering position.
export const DRIFT_THRESHOLD_S = 30;
export const POLL_INTERVAL_MS = 10_000;

// Polls a live player's playhead and snaps it back to the live head
// whenever it has fallen more than DRIFT_THRESHOLD_S behind. Player access
// is behind the LivePlayer interface (not YT.Player directly) so the drift
// logic is testable without YouTube's real API script.
export class LiveEdgeMonitor {
  private timer?: ReturnType<typeof setInterval>;

  start(player: LivePlayer): void {
    this.stop();
    this.timer = setInterval(() => {
      if (player.getPlayerState() !== PLAYING) return;
      const drift = player.getDuration() - player.getCurrentTime();
      if (drift > DRIFT_THRESHOLD_S) player.seekTo(player.getDuration(), true);
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
