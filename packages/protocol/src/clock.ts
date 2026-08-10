// A clock asset renders a *computed* string (the current time, or an elapsed/
// remaining duration) rather than stored text. Every client and the browser
// source compute the display locally from these fields + the current time, so
// a ticking clock costs no per-second network traffic -- only the config
// (mode/target/etc.) is ever synced, exactly like any other asset edit.

export type ClockMode =
  // Stopwatch: counts up from zero while running.
  | "countup"
  // Timer: counts down from clockDurationMs to zero while running.
  | "countdown"
  // Counts down to a fixed wall-clock instant (clockTargetMs). Always "live"
  // -- there's nothing to pause, it's anchored to real time.
  | "countdown-to"
  // Real time-of-day in clockTimezone.
  | "clock";

// Time-of-day formatting (clock mode only). Timers auto-format by magnitude.
export type ClockTimeFormat = "24h" | "24h-seconds" | "12h" | "12h-seconds";

// The clock-specific fields carried on an Asset (all optional, like the text-
// style fields, so a pre-clock stored asset / a plain add falls back to the
// defaults below rather than needing a migration).
export interface ClockFields {
  clockMode?: ClockMode;
  // countup/countdown pause model: elapsed = clockElapsedMs (accumulated while
  // paused) + (running ? now - clockAnchorMs : 0). Start/resume stamps
  // clockAnchorMs = now; pause folds the running span into clockElapsedMs.
  clockRunning?: boolean;
  clockAnchorMs?: number;
  clockElapsedMs?: number;
  // countdown: total duration to count down from.
  clockDurationMs?: number;
  // countdown-to: absolute epoch ms of the target instant.
  clockTargetMs?: number;
  // clock: IANA timezone (e.g. "America/New_York") + display format.
  clockTimezone?: string;
  clockFormat?: ClockTimeFormat;
}

export const DEFAULT_CLOCK_DURATION_MS = 5 * 60 * 1000; // 5:00
export const DEFAULT_CLOCK_FORMAT: ClockTimeFormat = "24h-seconds";

export function isClockMode(value: unknown): value is ClockMode {
  return value === "countup" || value === "countdown" || value === "countdown-to" || value === "clock";
}

export function isClockTimeFormat(value: unknown): value is ClockTimeFormat {
  return value === "24h" || value === "24h-seconds" || value === "12h" || value === "12h-seconds";
}

// The viewer's own timezone, used as the default for a freshly-created clock.
// Wrapped in a try/catch because Intl is technically allowed to throw / be
// absent in exotic runtimes; UTC is a safe, always-valid fallback.
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function elapsedMs(f: ClockFields, nowMs: number): number {
  const base = f.clockElapsedMs ?? 0;
  if (f.clockRunning && typeof f.clockAnchorMs === "number") {
    return base + Math.max(0, nowMs - f.clockAnchorMs);
  }
  return base;
}

// Formats a non-negative duration as (Dd )H:MM:SS, dropping leading units:
// "0:07", "5:00", "1:02:03", "2d 04:00:00". Days/hours only appear once they're
// non-zero so a short timer stays compact.
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

function formatTimeOfDay(nowMs: number, timezone: string, format: ClockTimeFormat): string {
  const hour12 = format === "12h" || format === "12h-seconds";
  const withSeconds = format === "24h-seconds" || format === "12h-seconds";
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12,
    ...(withSeconds ? { second: "2-digit" } : {}),
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone }).format(nowMs);
  } catch {
    // Invalid/unknown timezone -- fall back to the viewer's local zone rather
    // than throwing mid-render.
    return new Intl.DateTimeFormat("en-US", options).format(nowMs);
  }
}

// The single source of truth for what a clock displays, shared by control-ui's
// canvas and the browser source so the editor preview and the live overlay
// always agree. Pure: given the same fields + nowMs, same string.
export function computeClockDisplay(f: ClockFields, nowMs: number): string {
  switch (f.clockMode ?? "clock") {
    case "countup":
      return formatDuration(elapsedMs(f, nowMs));
    case "countdown":
      return formatDuration((f.clockDurationMs ?? DEFAULT_CLOCK_DURATION_MS) - elapsedMs(f, nowMs));
    case "countdown-to":
      return formatDuration((f.clockTargetMs ?? nowMs) - nowMs);
    case "clock":
    default:
      return formatTimeOfDay(nowMs, f.clockTimezone ?? localTimezone(), f.clockFormat ?? DEFAULT_CLOCK_FORMAT);
  }
}
