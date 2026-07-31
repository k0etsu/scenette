import { RoomMembership } from "./auth";

// Shown right after login when the account has access to more than just
// its own personal room (e.g. it's a mod on someone else's room too) --
// previously the app skipped straight into the personal room every time,
// with no way to reach a room you only have mod access to except via a
// bookmarked/shared link. A single-room account (the common case) never
// sees this at all -- see main.ts's caller.
export class RoomPicker {
  constructor(private readonly root: HTMLElement) {}

  // Resolves with the chosen roomId once a row is clicked. The own room is
  // always listed first regardless of where it falls in `rooms`.
  pickRoom(rooms: RoomMembership[], ownRoomId: string): Promise<string> {
    return new Promise((resolve) => {
      const ownRoom = rooms.find((r) => r.roomId === ownRoomId);
      const otherRooms = rooms.filter((r) => r.roomId !== ownRoomId);
      const ordered = ownRoom ? [ownRoom, ...otherRooms] : rooms;

      const rows = ordered
        .map((room) => {
          const isOwn = room.roomId === ownRoomId;
          const title = isOwn ? "Your room" : `${room.ownerUsername ?? room.roomId}'s room`;
          const sub = isOwn ? "" : `<div class="room-picker-row-sub">mod access</div>`;
          return `<button type="button" class="room-picker-row" data-room-id="${room.roomId}">
            <span class="room-picker-row-title">${title}</span>
            ${sub}
          </button>`;
        })
        .join("");

      this.root.innerHTML = `
        <div id="room-picker">
          <h2>Choose a room</h2>
          <div data-role="room-picker-list">${rows}</div>
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
    });
  }

  close(): void {
    this.root.style.display = "none";
    this.root.innerHTML = "";
  }
}
