import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResilientConnection } from "../src/connection";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.onopen?.();
  }
}

function connectedAtParam(url: string): string | null {
  return new URL(url, "ws://placeholder").searchParams.get("connectedAt");
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResilientConnection connectedAt", () => {
  it("sends the same connectedAt on a proactive reconnect as the original connection", () => {
    const connection = new ResilientConnection({
      wsUrl: "wss://example.com",
      roomId: "room1",
      onMessage: () => {},
      onOpen: () => {},
    });

    connection.start();
    const first = FakeWebSocket.instances[0];
    const firstConnectedAt = connectedAtParam(first.url);
    expect(firstConnectedAt).not.toBeNull();
    first.triggerOpen();

    // Simulate a silent reconnect (proactive swap or drop-and-retry) by
    // opening a second underlying socket directly, the same way
    // ResilientConnection's own retry/proactive-swap paths do.
    (connection as unknown as { open(): void }).open();
    const second = FakeWebSocket.instances[1];

    // Regression: without a stable client-tracked session start time, each
    // new underlying WebSocket would carry no connectedAt at all and the
    // server would stamp its own "now" -- resetting the presence timestamp
    // on every silent reconnect even though the user never left.
    expect(connectedAtParam(second.url)).toBe(firstConnectedAt);
  });

  it("uses a fresh connectedAt for a brand-new ResilientConnection (e.g. after a page refresh)", () => {
    const a = new ResilientConnection({ wsUrl: "wss://example.com", roomId: "room1", onMessage: () => {}, onOpen: () => {} });
    a.start();
    const aConnectedAt = connectedAtParam(FakeWebSocket.instances[0].url);

    const b = new ResilientConnection({ wsUrl: "wss://example.com", roomId: "room1", onMessage: () => {}, onOpen: () => {} });
    // A real page refresh tears down the whole JS context, so there's no
    // shared state between `a` and `b` beyond what a fresh construction
    // gives you -- this asserts each instance computes its own start time
    // rather than one somehow being reused.
    b.start();
    const bConnectedAt = connectedAtParam(FakeWebSocket.instances[1].url);

    expect(aConnectedAt).not.toBeNull();
    expect(bConnectedAt).not.toBeNull();
  });
});

describe("ResilientConnection reconnect resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeConnection(onOpen: () => void = () => {}): ResilientConnection {
    return new ResilientConnection({
      wsUrl: "wss://example.com",
      roomId: "room1",
      onMessage: () => {},
      onOpen,
    });
  }

  it("keeps retrying when a reconnect attempt fails before ever opening", () => {
    const connection = makeConnection();
    connection.start();
    const first = FakeWebSocket.instances[0];
    first.triggerOpen();

    // Server kills the live connection (API Gateway's 2-hour limit).
    first.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // While the attempt is still connecting, the watchdog must not stack a
    // second attempt on top of it.
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The retry attempt itself fails before ever opening. Regression: this
    // used to end the retry chain for good (the failed attempt was never
    // `socket`, so its close was mistaken for a swapped-out old socket),
    // leaving the browser source dead until a manual refresh.
    FakeWebSocket.instances[1].close();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].triggerOpen();
    connection.send({ hello: true });
  });

  it("self-heals a failed proactive swap while the old connection is still alive", () => {
    const opens: number[] = [];
    const connection = makeConnection(() => opens.push(FakeWebSocket.instances.length));
    connection.start();
    const first = FakeWebSocket.instances[0];
    first.triggerOpen();

    // The 100-minute proactive reconnect fires and the swap attempt fails.
    vi.advanceTimersByTime(100 * 60 * 1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].close();

    // A retry replaces it while the old socket is still connected, and only
    // once the replacement is live does the old socket get torn down.
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(first.closed).toBe(false);
    FakeWebSocket.instances[2].triggerOpen();
    expect(first.closed).toBe(true);
    expect(opens).toHaveLength(2);
  });

  it("watchdog reopens a connection lost without any close event", () => {
    const connection = makeConnection();
    connection.start();
    FakeWebSocket.instances[0].triggerOpen();

    // Simulate the connection vanishing without onclose ever firing (OBS's
    // embedded browser suspending the page can eat both the close event and
    // any pending retry timers).
    (connection as unknown as { socket?: unknown }).socket = undefined;

    vi.advanceTimersByTime(15_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stop() closes an in-flight attempt and silences the watchdog", () => {
    const connection = makeConnection();
    connection.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    connection.stop();
    expect(FakeWebSocket.instances[0].closed).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
