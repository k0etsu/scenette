import { ServerMessage } from "@scenette/protocol";

// API Gateway WebSocket connections have a hard 2-hour lifetime and a
// 10-minute idle timeout — a stream can run far longer than that, so this
// reconnects proactively well before the limit. The swap is silent: a new
// connection is opened and confirmed live before the old one is torn down,
// so the last-rendered frame never disappears from the viewer's screen.
const RECONNECT_BEFORE_LIMIT_MS = 100 * 60 * 1000; // reconnect at the 100-minute mark
const RETRY_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export interface ConnectionOptions {
  wsUrl: string;
  roomId: string;
  onMessage: (message: ServerMessage) => void;
  // Fires every time a connection goes live — the first connect and every
  // later reconnect alike — since a fresh connection has no server-side
  // memory of this client and needs a snapshot request either way.
  onOpen: () => void;
}

export class ResilientConnection {
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private closedByUs = false;

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    this.open();
  }

  send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private open(): void {
    const url = `${this.options.wsUrl}?roomId=${encodeURIComponent(this.options.roomId)}`;
    const next = new WebSocket(url);

    next.onopen = () => {
      this.retryAttempt = 0;
      const previous = this.socket;
      this.socket = next;

      // Only tear down the old socket once the new one is confirmed live —
      // this is what keeps the render uninterrupted across a proactive swap.
      previous?.close();
      this.options.onOpen();

      this.scheduleProactiveReconnect();
    };

    next.onmessage = (event) => {
      try {
        this.options.onMessage(JSON.parse(event.data));
      } catch {
        // Malformed frame from the server — ignore rather than crash the render loop.
      }
    };

    next.onclose = () => {
      if (this.socket === next && !this.closedByUs) {
        this.scheduleRetry();
      }
    };

    next.onerror = () => {
      next.close();
    };
  }

  private scheduleProactiveReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_BEFORE_LIMIT_MS);
  }

  private scheduleRetry(): void {
    const delay = RETRY_BACKOFF_MS[Math.min(this.retryAttempt, RETRY_BACKOFF_MS.length - 1)];
    this.retryAttempt += 1;
    setTimeout(() => this.open(), delay);
  }

  stop(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
