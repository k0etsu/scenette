import { RoomMembership } from "./auth";

// Shown right after every login/bare visit (unless the URL names an
// explicit room), regardless of how many rooms the account has access to --
// a consistent landing spot rather than sometimes skipping straight into a
// room. Also reachable any time via the in-room "Dashboard" button (see
// main.ts's caller for both cases).
export interface RoomPickerCallbacks {
  onLogout: () => void;
  onSettings: () => void;
}

export interface VerifyPrompt {
  hasEmail: boolean;
  onResend: () => void;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export class RoomPicker {
  constructor(private readonly root: HTMLElement, private readonly callbacks: RoomPickerCallbacks) {}

  // Resolves with the chosen roomId once a row is clicked. The own room is
  // always listed first, in its own group -- any mod-access rooms are grouped
  // separately below it. When the account has no own room yet (email not
  // verified), a prompt to verify is shown in its place instead.
  // Logging out is a terminal action (main.ts reloads the page) rather than
  // something this promise ever resolves with -- callbacks.onLogout() fires
  // directly instead.
  // Renders the dashboard shell immediately (before the room list has loaded)
  // so navigating to the dashboard feels instant rather than blanking out
  // while the room list is fetched.
  showLoading(): void {
    this.root.innerHTML = `
      <div id="room-picker">
        <div class="room-picker-header"><h2>Choose a room</h2></div>
        <div class="room-picker-loading">Loading…</div>
      </div>`;
    this.root.style.display = "flex";
  }

  pickRoom(
    rooms: RoomMembership[],
    ownRoomId: string | undefined,
    verify: VerifyPrompt = { hasEmail: false, onResend: () => {} },
    announcement?: string | null
  ): Promise<string> {
    return new Promise((resolve) => {
      const ownRoom = ownRoomId ? rooms.find((r) => r.roomId === ownRoomId) : undefined;
      const modRooms = rooms.filter((r) => r.roomId !== ownRoomId);

      const rowHtml = (room: RoomMembership, isOwn: boolean): string => {
        const title = isOwn ? "Your room" : `${escapeHtml(room.ownerUsername ?? room.roomId)}'s room`;
        const sub = isOwn ? "" : `<div class="room-picker-row-sub">mod access</div>`;
        return `<button type="button" class="room-picker-row" data-room-id="${escapeHtml(room.roomId)}">
          <span class="room-picker-row-title">${title}</span>
          ${sub}
        </button>`;
      };

      // No own room yet: prompt to verify (add an email in Settings first if
      // there isn't one) rather than showing a "Your room" row.
      const ownSectionHtml = ownRoom
        ? rowHtml(ownRoom, true)
        : `<div class="room-picker-verify" data-role="verify-prompt">
            <div class="room-picker-verify-title">Verify your email to create your own room</div>
            <div class="room-picker-verify-sub">${
              verify.hasEmail
                ? "Check your inbox for the verification link, then reload."
                : "Add an email address in Settings, then verify it."
            }</div>
            ${
              verify.hasEmail
                ? `<button type="button" data-role="resend-verification" class="room-picker-logout">Resend email</button>`
                : ""
            }
          </div>`;

      const modSectionHtml =
        modRooms.length > 0
          ? `<div class="room-picker-section-label">Rooms you moderate</div>` +
            modRooms.map((r) => rowHtml(r, false)).join("")
          : "";

      // Admin-managed announcement (see accounts GET /announcement) -- plain
      // text, escaped, with newlines preserved. Hidden entirely when empty.
      const announcementHtml =
        announcement && announcement.trim()
          ? `<div class="room-picker-announcement">${escapeHtml(announcement.trim())}</div>`
          : "";

      this.root.innerHTML = `
        <div id="room-picker">
          <div class="room-picker-header">
            <h2>Choose a room</h2>
            <div class="room-picker-header-buttons">
              <button type="button" data-role="settings" class="room-picker-logout">Settings</button>
              <button type="button" data-role="logout" class="room-picker-logout">Log out</button>
            </div>
          </div>
          ${announcementHtml}
          <div data-role="room-picker-list">${ownSectionHtml}${modSectionHtml}</div>
        </div>
      `;
      this.root.style.display = "flex";

      this.root.querySelectorAll<HTMLButtonElement>(".room-picker-row").forEach((button) => {
        button.addEventListener("click", () => {
          const roomId = button.dataset.roomId!;
          this.close();
          resolve(roomId);
        });
      });

      this.root.querySelector('[data-role="resend-verification"]')?.addEventListener("click", () => {
        verify.onResend();
      });
      this.root.querySelector('[data-role="logout"]')!.addEventListener("click", () => {
        this.callbacks.onLogout();
      });
      this.root.querySelector('[data-role="settings"]')!.addEventListener("click", () => {
        this.callbacks.onSettings();
      });
    });
  }

  close(): void {
    this.root.style.display = "none";
    this.root.innerHTML = "";
  }
}
