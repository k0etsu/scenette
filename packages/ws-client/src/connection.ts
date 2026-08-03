import { ServerMessage } from "@scenette/protocol";

// API Gateway WebSocket connections have a hard 2-hour lifetime and a
// 10-minute idle timeout — both control-ui editing sessions and (especially)
// the browser-source's OBS-embedded connection can outlive that, so this
// reconnects proactively well before the limit. The swap is silent: a new
// connection is opened and confirmed live before the old one is torn down,
// so nothing is ever visibly dropped mid-session.
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
  // Set once and reused across every reconnect (proactive swap or
  // drop-and-retry alike) -- without this, each new underlying WebSocket
  // connection would stamp its own fresh connectedAt server-side, making the
  // connected-users presence list reset to "just now" on every silent
  // reconnect instead of reflecting how long the user has actually been here.
  private readonly sessionStartedAt = new Date().toISOString();

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    this.open();
  }

  send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private open(): void {
    // Auth is via the HttpOnly session cookie sent on the WS upgrade
    // handshake (same-site), not a URL token -- an anonymous browser-source
    // connection simply has no cookie and stays read-only.
    const url = `${this.options.wsUrl}?roomId=${encodeURIComponent(this.options.roomId)}&connectedAt=${encodeURIComponent(this.sessionStartedAt)}`;
    const next = new WebSocket(url);

    next.onopen = () => {
      this.retryAttempt = 0;
      const previous = this.socket;
      this.socket = next;

      // Only tear down the old socket once the new one is confirmed live —
      // this is what keeps the client uninterrupted across a proactive swap.
      previous?.close();
      this.options.onOpen();

      this.scheduleProactiveReconnect();
    };

    next.onmessage = (event) => {
      try {
        this.options.onMessage(JSON.parse(event.data));
      } catch {
        // Malformed frame from the server — ignore rather than crash the caller.
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
