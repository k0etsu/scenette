// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { RoomPicker } from "../src/roomPicker";
import { RoomMembership } from "../src/auth";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function rows(): HTMLElement[] {
  return [...root.querySelectorAll(".room-picker-row")] as HTMLElement[];
}

describe("RoomPicker", () => {
  it("lists the own room first, labeled 'Your room', regardless of input order", () => {
    const picker = new RoomPicker(root);
    const rooms: RoomMembership[] = [
      { roomId: "room2", role: "mod", ownerUsername: "alice" },
      { roomId: "room1", role: "owner", ownerUsername: "bob" },
    ];
    picker.pickRoom(rooms, "room1");

    const titles = rows().map((r) => r.querySelector(".room-picker-row-title")?.textContent);
    expect(titles).toEqual(["Your room", "alice's room"]);
  });

  it("shows the room as visible with the rows rendered", () => {
    const picker = new RoomPicker(root);
    picker.pickRoom([{ roomId: "room1", role: "owner", ownerUsername: "alice" }], "room1");

    expect(root.style.display).toBe("flex");
    expect(rows()).toHaveLength(1);
  });

  it("labels a mod-access room by its owner's username", () => {
    const picker = new RoomPicker(root);
    picker.pickRoom(
      [
        { roomId: "room1", role: "owner", ownerUsername: "alice" },
        { roomId: "room2", role: "mod", ownerUsername: "carol" },
      ],
      "room1"
    );

    const subRows = rows();
    expect(subRows[1].querySelector(".room-picker-row-title")?.textContent).toBe("carol's room");
    expect(subRows[1].querySelector(".room-picker-row-sub")?.textContent).toBe("mod access");
  });

  it("falls back to the raw roomId if ownerUsername is somehow missing", () => {
    const picker = new RoomPicker(root);
    picker.pickRoom(
      [
        { roomId: "room1", role: "owner", ownerUsername: "alice" },
        { roomId: "room2", role: "mod" },
      ],
      "room1"
    );

    expect(rows()[1].querySelector(".room-picker-row-title")?.textContent).toBe("room2's room");
  });

  it("resolves with the clicked room's id and hides itself", async () => {
    const picker = new RoomPicker(root);
    const promise = picker.pickRoom(
      [
        { roomId: "room1", role: "owner", ownerUsername: "alice" },
        { roomId: "room2", role: "mod", ownerUsername: "bob" },
      ],
      "room1"
    );

    rows()[1].click();

    await expect(promise).resolves.toBe("room2");
    expect(root.style.display).toBe("none");
    expect(root.innerHTML).toBe("");
  });
});
