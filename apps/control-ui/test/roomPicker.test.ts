// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RoomPicker, RoomPickerCallbacks } from "../src/roomPicker";
import { RoomMembership } from "../src/auth";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function makeCallbacks(overrides: Partial<RoomPickerCallbacks> = {}): RoomPickerCallbacks {
  return { onLogout: vi.fn(), ...overrides };
}

function rows(): HTMLElement[] {
  return [...root.querySelectorAll(".room-picker-row")] as HTMLElement[];
}

describe("RoomPicker", () => {
  it("lists the own room first, labeled 'Your room', regardless of input order", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    const rooms: RoomMembership[] = [
      { roomId: "room2", role: "mod", ownerUsername: "alice" },
      { roomId: "room1", role: "owner", ownerUsername: "bob" },
    ];
    picker.pickRoom(rooms, "room1");

    const titles = rows().map((r) => r.querySelector(".room-picker-row-title")?.textContent);
    expect(titles).toEqual(["Your room", "alice's room"]);
  });

  it("shows the room as visible with the rows rendered", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    picker.pickRoom([{ roomId: "room1", role: "owner", ownerUsername: "alice" }], "room1");

    expect(root.style.display).toBe("flex");
    expect(rows()).toHaveLength(1);
  });

  it("labels a mod-access room by its owner's username", () => {
    const picker = new RoomPicker(root, makeCallbacks());
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
    const picker = new RoomPicker(root, makeCallbacks());
    picker.pickRoom(
      [
        { roomId: "room1", role: "owner", ownerUsername: "alice" },
        { roomId: "room2", role: "mod" },
      ],
      "room1"
    );

    expect(rows()[1].querySelector(".room-picker-row-title")?.textContent).toBe("room2's room");
  });

  it("shows a verify-email prompt (with resend) instead of an own room when unverified, and still lists mod rooms", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    const onResend = vi.fn();
    picker.pickRoom(
      [{ roomId: "room2", role: "mod", ownerUsername: "carol" }],
      undefined,
      { hasEmail: true, onResend }
    );

    // No "Your room" row -- a verify prompt takes its place.
    const prompt = root.querySelector('[data-role="verify-prompt"]');
    expect(prompt).not.toBeNull();
    const titles = rows().map((r) => r.querySelector(".room-picker-row-title")?.textContent);
    expect(titles).toEqual(["carol's room"]);

    (root.querySelector('[data-role="resend-verification"]') as HTMLButtonElement).click();
    expect(onResend).toHaveBeenCalledOnce();
  });

  it("prompts to add an email (no resend button) when unverified and no email is set", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    picker.pickRoom([], undefined, { hasEmail: false, onResend: vi.fn() });

    expect(root.querySelector('[data-role="verify-prompt"]')).not.toBeNull();
    expect(root.querySelector('[data-role="resend-verification"]')).toBeNull();
  });

  it("showLoading renders the dashboard shell immediately", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    picker.showLoading();
    expect(root.style.display).toBe("flex");
    expect(root.querySelector(".room-picker-loading")?.textContent).toContain("Loading");
  });

  it("renders an announcement (escaped) when one is provided, and omits it otherwise", () => {
    const withRooms: RoomMembership[] = [{ roomId: "room1", role: "owner", ownerUsername: "alice" }];
    const p1 = new RoomPicker(root, makeCallbacks());
    p1.pickRoom(withRooms, "room1", undefined, "Re-copy your <b>OBS</b> URL");
    const banner = root.querySelector(".room-picker-announcement") as HTMLElement;
    expect(banner).not.toBeNull();
    // Escaped -- the tag is text, not a real element.
    expect(banner.querySelector("b")).toBeNull();
    expect(banner.textContent).toContain("Re-copy your <b>OBS</b> URL");

    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    const p2 = new RoomPicker(root, makeCallbacks());
    p2.pickRoom(withRooms, "room1", undefined, null);
    expect(root.querySelector(".room-picker-announcement")).toBeNull();
  });

  it("shows a 'Rooms you moderate' divider above mod-access rooms, but not when there are none", () => {
    const picker = new RoomPicker(root, makeCallbacks());
    picker.pickRoom(
      [
        { roomId: "room1", role: "owner", ownerUsername: "alice" },
        { roomId: "room2", role: "mod", ownerUsername: "bob" },
      ],
      "room1"
    );
    expect(root.querySelectorAll(".room-picker-section-label")).toHaveLength(1);

    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    const soloPicker = new RoomPicker(root, makeCallbacks());
    soloPicker.pickRoom([{ roomId: "room1", role: "owner", ownerUsername: "alice" }], "room1");
    expect(root.querySelectorAll(".room-picker-section-label")).toHaveLength(0);
  });

  it("resolves with the clicked room's id and hides itself", async () => {
    const picker = new RoomPicker(root, makeCallbacks());
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

  it("fires onLogout when the log out button is clicked, without resolving pickRoom", async () => {
    const onLogout = vi.fn();
    const picker = new RoomPicker(root, makeCallbacks({ onLogout }));
    const promise = picker.pickRoom([{ roomId: "room1", role: "owner", ownerUsername: "alice" }], "room1");

    (root.querySelector('[data-role="logout"]') as HTMLElement).click();

    expect(onLogout).toHaveBeenCalledTimes(1);
    // Logging out is a terminal action handled entirely by the callback
    // (main.ts reloads the page) -- the picker itself has no "cancelled"
    // state, so the promise is simply left unresolved.
    const raced = await Promise.race([promise.then(() => "resolved"), Promise.resolve("not resolved")]);
    expect(raced).toBe("not resolved");
  });
});
