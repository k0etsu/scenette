import { PresenceEntry } from "@scenette/protocol";
import { ICON_EXPAND, ICON_REFRESH } from "./icons";

export interface ConnectedUsersCallbacks {
  // Re-requests a fresh room snapshot from the server -- an authoritative
  // resync beyond the automatic once-a-minute elapsed-time redraw below.
  onRefresh: () => void;
}

export class ConnectedUsersPanel {
  private presence: PresenceEntry[] = [];
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private readonly tickInterval: ReturnType<typeof setInterval>;

  constructor(private readonly root: HTMLElement, private readonly callbacks: ConnectedUsersCallbacks) {
    root.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-icon-button" data-role="expand">${ICON_EXPAND}</span>
        <span data-role="title">connected users - 0</span>
        <button type="button" class="sidebar-icon-button" data-role="refresh">${ICON_REFRESH}</button>
      </div>
      <div class="presence-list"></div>
    `;
    this.title = root.querySelector('[data-role="title"]')!;
    this.list = root.querySelector(".presence-list")!;

    root.querySelector('[data-role="refresh"]')!.addEventListener("click", () => this.callbacks.onRefresh());
    const expandButton = root.querySelector<HTMLElement>('[data-role="expand"]')!;
    expandButton.addEventListener("click", () => {
      const collapsed = root.classList.toggle("panel-collapsed");
      expandButton.title = collapsed ? "Expand" : "Collapse";
    });

    // Elapsed-time labels ("47 hours") go stale without a periodic redraw
    // even though presence itself only changes on join/leave -- this is a
    // purely client-side recompute, no network round-trip needed.
    this.tickInterval = setInterval(() => this.renderList(), 60_000);
  }

  setPresence(presence: PresenceEntry[]): void {
    this.presence = presence;
    this.render();
  }

  addPresence(entry: PresenceEntry): void {
    this.presence = [...this.presence, entry];
    this.render();
  }

  // Matches on both username AND connectedAt -- the same account open in
  // two tabs shows as two rows, and a disconnect on one must only remove
  // that specific session, not both.
  removePresence(username: string, connectedAt: string): void {
    this.presence = this.presence.filter((p) => !(p.username === username && p.connectedAt === connectedAt));
    this.render();
  }

  dispose(): void {
    clearInterval(this.tickInterval);
  }

  private render(): void {
    this.title.textContent = `connected users - ${this.presence.length}`;
    this.renderList();
  }

  private renderList(): void {
    this.list.innerHTML = "";
    for (const entry of this.presence) {
      const row = document.createElement("div");
      row.className = "presence-row";

      const name = document.createElement("span");
      name.textContent = entry.username;

      const elapsed = document.createElement("span");
      elapsed.className = "presence-elapsed";
      elapsed.textContent = formatElapsed(Date.now() - new Date(entry.connectedAt).getTime());

      row.append(name, elapsed);
      this.list.appendChild(row);
    }
  }
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
