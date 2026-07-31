// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectedUsersPanel, ConnectedUsersCallbacks } from "../src/connectedUsers";

function makeCallbacks(overrides: Partial<ConnectedUsersCallbacks> = {}): ConnectedUsersCallbacks {
  return {
    onRefresh: vi.fn(),
    ...overrides,
  };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  vi.useRealTimers();
});

function title(): string {
  return (root.querySelector('[data-role="title"]') as HTMLElement).textContent ?? "";
}

function rows(): HTMLElement[] {
  return [...root.querySelectorAll(".presence-row")] as HTMLElement[];
}

describe("presence count and list", () => {
  it("shows a count of 0 with no rows initially", () => {
    new ConnectedUsersPanel(root, makeCallbacks());
    expect(title()).toBe("connected users - 0");
    expect(rows()).toHaveLength(0);
  });

  it("setPresence populates the count and rows", () => {
    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    panel.setPresence([
      { username: "alice", connectedAt: new Date().toISOString() },
      { username: "bob", connectedAt: new Date().toISOString() },
    ]);
    expect(title()).toBe("connected users - 2");
    expect(rows()).toHaveLength(2);
    panel.dispose();
  });

  it("addPresence appends a row and increments the count", () => {
    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    panel.setPresence([{ username: "alice", connectedAt: new Date().toISOString() }]);
    panel.addPresence({ username: "bob", connectedAt: new Date().toISOString() });
    expect(title()).toBe("connected users - 2");
    panel.dispose();
  });

  it("removePresence matches on username AND connectedAt, not username alone", () => {
    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    // Same account connected from two tabs -- two distinct sessions.
    panel.setPresence([
      { username: "alice", connectedAt: "2026-01-01T00:00:00.000Z" },
      { username: "alice", connectedAt: "2026-01-01T00:05:00.000Z" },
    ]);
    expect(title()).toBe("connected users - 2");

    // Only the first tab disconnects.
    panel.removePresence("alice", "2026-01-01T00:00:00.000Z");

    expect(title()).toBe("connected users - 1");
    expect(rows()).toHaveLength(1);
    panel.dispose();
  });

  it("removePresence for a non-matching connectedAt removes nothing", () => {
    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    panel.setPresence([{ username: "alice", connectedAt: "2026-01-01T00:00:00.000Z" }]);
    panel.removePresence("alice", "some-other-timestamp");
    expect(title()).toBe("connected users - 1");
    panel.dispose();
  });
});

describe("refresh and expand", () => {
  it("fires onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    new ConnectedUsersPanel(root, makeCallbacks({ onRefresh }));
    (root.querySelector('[data-role="refresh"]') as HTMLElement).click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("toggles the collapsed class on the expand button", () => {
    new ConnectedUsersPanel(root, makeCallbacks());
    const expandButton = root.querySelector('[data-role="expand"]') as HTMLElement;
    expandButton.click();
    expect(root.classList.contains("panel-collapsed")).toBe(true);
    expandButton.click();
    expect(root.classList.contains("panel-collapsed")).toBe(false);
  });
});

describe("elapsed time formatting", () => {
  it("redraws elapsed-time labels on the periodic tick without a new presence update", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T01:00:00.000Z");
    vi.setSystemTime(now);

    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    panel.setPresence([{ username: "alice", connectedAt: "2026-01-01T00:00:00.000Z" }]);
    expect(rows()[0].textContent).toContain("hour");

    // Advance time (and the panel's own 60s redraw interval) without any
    // new presence message -- the elapsed label should update purely from
    // the periodic tick.
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    vi.advanceTimersByTime(60_000);

    expect(rows()[0].textContent).toContain("2 hours");
    panel.dispose();
  });

  it("keeps counting in hours past a day, rather than switching to a days unit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T05:00:00.000Z"));

    const panel = new ConnectedUsersPanel(root, makeCallbacks());
    panel.setPresence([{ username: "alice", connectedAt: "2026-01-01T00:00:00.000Z" }]);

    expect(rows()[0].textContent).toContain("53 hours");
    panel.dispose();
  });
});
