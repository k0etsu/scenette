import { describe, it, expect } from "vitest";
import {
  computeClockDisplay,
  formatDuration,
  isClockMode,
  isClockTimeFormat,
  localTimezone,
  DEFAULT_CLOCK_DURATION_MS,
} from "../src/clock";

describe("formatDuration", () => {
  it("formats sub-minute, minute, hour and day magnitudes, dropping leading units", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9_000)).toBe("0:09");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration((60 * 60 + 1 * 60 + 1) * 1000)).toBe("1:01:01");
    expect(formatDuration((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000)).toBe("2d 03:04:05");
  });

  it("clamps negatives to zero", () => {
    expect(formatDuration(-5000)).toBe("0:00");
  });
});

describe("computeClockDisplay", () => {
  it("clock mode renders the time of day in the given timezone/format", () => {
    const now = Date.UTC(2026, 0, 1, 13, 5, 9);
    expect(computeClockDisplay({ clockMode: "clock", clockTimezone: "UTC", clockFormat: "24h-seconds" }, now)).toBe(
      "13:05:09"
    );
    expect(computeClockDisplay({ clockMode: "clock", clockTimezone: "UTC", clockFormat: "24h" }, now)).toBe("13:05");
    expect(computeClockDisplay({ clockMode: "clock", clockTimezone: "UTC", clockFormat: "12h-seconds" }, now)).toBe(
      "1:05:09 PM"
    );
  });

  it("clock mode falls back to a valid render for an unknown timezone", () => {
    const now = Date.UTC(2026, 0, 1, 13, 5, 9);
    expect(() => computeClockDisplay({ clockMode: "clock", clockTimezone: "Not/AZone" }, now)).not.toThrow();
  });

  it("countup shows elapsed while running, frozen while paused", () => {
    const running = computeClockDisplay(
      { clockMode: "countup", clockRunning: true, clockAnchorMs: 1000, clockElapsedMs: 0 },
      1000 + 65_000
    );
    expect(running).toBe("1:05");

    const paused = computeClockDisplay(
      { clockMode: "countup", clockRunning: false, clockElapsedMs: 65_000, clockAnchorMs: 1000 },
      999_999_999
    );
    expect(paused).toBe("1:05");
  });

  it("countdown subtracts elapsed from the duration and clamps at zero", () => {
    expect(computeClockDisplay({ clockMode: "countdown", clockDurationMs: 300_000, clockElapsedMs: 0 }, 0)).toBe("5:00");
    expect(
      computeClockDisplay(
        { clockMode: "countdown", clockDurationMs: 300_000, clockRunning: true, clockAnchorMs: 0, clockElapsedMs: 0 },
        65_000
      )
    ).toBe("3:55");
    expect(
      computeClockDisplay({ clockMode: "countdown", clockDurationMs: 300_000, clockElapsedMs: 400_000 }, 0)
    ).toBe("0:00");
  });

  it("countdown defaults to the 5-minute duration when unset", () => {
    expect(computeClockDisplay({ clockMode: "countdown" }, 0)).toBe(formatDuration(DEFAULT_CLOCK_DURATION_MS));
  });

  it("countdown-to counts toward a fixed instant, clamped at zero once passed", () => {
    const now = 1_000_000;
    expect(computeClockDisplay({ clockMode: "countdown-to", clockTargetMs: now + 90_000 }, now)).toBe("1:30");
    expect(computeClockDisplay({ clockMode: "countdown-to", clockTargetMs: now - 5_000 }, now)).toBe("0:00");
  });

  it("defaults to clock mode when no mode is set", () => {
    // 24-hour formatting zero-pads the hour (Intl hour12:false -> "09").
    const now = Date.UTC(2026, 0, 1, 9, 8, 7);
    expect(computeClockDisplay({ clockTimezone: "UTC", clockFormat: "24h-seconds" }, now)).toBe("09:08:07");
  });
});

describe("guards + helpers", () => {
  it("isClockMode / isClockTimeFormat validate their unions", () => {
    expect(isClockMode("countdown-to")).toBe(true);
    expect(isClockMode("nope")).toBe(false);
    expect(isClockTimeFormat("12h-seconds")).toBe(true);
    expect(isClockTimeFormat("13h")).toBe(false);
  });

  it("localTimezone returns a non-empty string", () => {
    expect(typeof localTimezone()).toBe("string");
    expect(localTimezone().length).toBeGreaterThan(0);
  });
});
