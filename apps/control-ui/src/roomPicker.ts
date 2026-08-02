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

export class RoomPicker {
  constructor(private readonly root: HTMLElement, private readonly callbacks: RoomPickerCallbacks) {}

  // Resolves with the chosen roomId once a row is clicked. The own room is
  // always listed first, in its own group, regardless of where it falls in
  // `rooms` -- any mod-access rooms are grouped separately below it.
  // Logging out is a terminal action (main.ts reloads the page) rather than
  // something this promise ever resolves with -- callbacks.onLogout() fires
  // directly instead.
  pickRoom(rooms: RoomMembership[], ownRoomId: string): Promise<string> {
    return new Promise((resolve) => {
      const ownRoom = rooms.find((r) => r.roomId === ownRoomId);
      const modRooms = rooms.filter((r) => r.roomId !== ownRoomId);

      const rowHtml = (room: RoomMembership, isOwn: boolean): string => {
        const title = isOwn ? "Your room" : `${room.ownerUsername ?? room.roomId}'s room`;
        const sub = isOwn ? "" : `<div class="room-picker-row-sub">mod access</div>`;
        return `<button type="button" class="room-picker-row" data-room-id="${room.roomId}">
          <span class="room-picker-row-title">${title}</span>
          ${sub}
        </button>`;
      };

      // Falls back to the raw (unordered, ungrouped) list in the unexpected
      // case where the account's own room isn't in `rooms` at all.
      const rowsHtml = ownRoom
        ? rowHtml(ownRoom, true) +
          (modRooms.length > 0
            ? `<div class="room-picker-section-label">Rooms you moderate</div>` +
              modRooms.map((r) => rowHtml(r, false)).join("")
            : "")
        : rooms.map((r) => rowHtml(r, false)).join("");

      this.root.innerHTML = `
        <div id="room-picker">
          <div class="room-picker-header">
            <h2>Choose a room</h2>
            <div class="room-picker-header-buttons">
              <button type="button" data-role="settings" class="room-picker-logout">Settings</button>
              <button type="button" data-role="logout" class="room-picker-logout">Log out</button>
            </div>
          </div>
          <div data-role="room-picker-list">${rowsHtml}</div>
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
