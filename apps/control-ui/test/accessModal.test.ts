// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Member, Invite } from "../src/auth";

vi.mock("../src/auth", () => ({
  listMembers: vi.fn(),
  revokeMember: vi.fn(),
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  revokeInvite: vi.fn(),
}));

import { AccessModal } from "../src/accessModal";
import * as auth from "../src/auth";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
  vi.clearAllMocks();
});

function member(accountId: string, role: Member["role"]): Member {
  return { accountId, roomId: "room1", role };
}

function invite(inviteToken: string, createdAt = "2026-01-01T00:00:00.000Z"): Invite {
  return { inviteToken, createdAt };
}

function statusText(): string {
  return (root.querySelector('[data-role="status"]') as HTMLElement).textContent ?? "";
}

describe("open()", () => {
  it("loads and renders members and invites", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member("alice", "owner"), member("bob", "mod")]);
    vi.mocked(auth.listInvites).mockResolvedValue([invite("tok1")]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    expect(root.querySelectorAll(".access-row")).toHaveLength(3); // 2 members + 1 invite
    expect(root.style.display).toBe("flex");
  });

  it("shows an empty state for no members/invites", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    expect(root.querySelectorAll(".access-empty")).toHaveLength(2);
  });

  it("shows an error message if loading fails, rather than throwing", async () => {
    vi.mocked(auth.listMembers).mockRejectedValue(new Error("network blip"));
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await expect(modal.open("https://api.example.com", "room1")).resolves.toBeUndefined();
    expect(statusText()).toContain("network blip");
  });
});

describe("members list", () => {
  it("does not show a revoke button for the owner's own row", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member("alice", "owner")]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    const membersList = root.querySelector('[data-role="members-list"]')!;
    expect(membersList.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows a revoke button for a mod", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member("bob", "mod")]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    const membersList = root.querySelector('[data-role="members-list"]')!;
    expect(membersList.querySelectorAll("button")).toHaveLength(1);
  });

  it("revoking a member removes their row locally without re-querying the server", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member("alice", "owner"), member("bob", "mod")]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);
    vi.mocked(auth.revokeMember).mockResolvedValue(undefined);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");
    vi.mocked(auth.listMembers).mockClear();

    const membersList = root.querySelector('[data-role="members-list"]')!;
    (membersList.querySelector("button") as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.revokeMember).toHaveBeenCalledWith("https://api.example.com", "room1", "bob");
    // Regression: previously re-fetched from a GSI that might not have
    // caught up yet, which looked like the modal not updating.
    expect(auth.listMembers).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".access-row")).toHaveLength(1);
  });

  it("shows an error and keeps the row if revoking a member fails, instead of silently doing nothing", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member("bob", "mod")]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);
    vi.mocked(auth.revokeMember).mockRejectedValue(new Error("CORS blocked"));

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    const membersList = root.querySelector('[data-role="members-list"]')!;
    (membersList.querySelector("button") as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(statusText()).toContain("CORS blocked");
    expect(root.querySelectorAll(".access-row")).toHaveLength(1);
  });
});

describe("invites list", () => {
  it("creating an invite appends it locally without re-querying the server", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);
    vi.mocked(auth.createInvite).mockResolvedValue(invite("newtok", "2026-02-02T00:00:00.000Z"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");
    vi.mocked(auth.listInvites).mockClear();

    (root.querySelector('[data-role="create-invite"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Regression: previously re-fetched pending invites via a GSI query
    // immediately after the write, which occasionally raced the GSI's
    // propagation lag and looked like the modal not updating.
    expect(auth.listInvites).not.toHaveBeenCalled();
    const row = root.querySelector(".access-row-sub") as HTMLElement;
    expect(row.textContent).not.toContain("Invalid Date");
  });

  it("shows an error if creating an invite fails", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);
    vi.mocked(auth.createInvite).mockRejectedValue(new Error("Only the room owner can create invites"));

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    (root.querySelector('[data-role="create-invite"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(statusText()).toContain("Only the room owner can create invites");
  });

  it("revoking an invite removes its row locally without re-querying the server", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([invite("tok1")]);
    vi.mocked(auth.revokeInvite).mockResolvedValue(undefined);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");
    vi.mocked(auth.listInvites).mockClear();

    const invitesList = root.querySelector('[data-role="invites-list"]')!;
    const revokeButton = invitesList.querySelectorAll("button")[1] as HTMLElement; // [Copy, Revoke]
    revokeButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.revokeInvite).toHaveBeenCalledWith("https://api.example.com", "room1", "tok1");
    expect(auth.listInvites).not.toHaveBeenCalled();
    // Both lists are now empty: members was empty from the start, invites
    // just emptied out from the revoke.
    expect(root.querySelectorAll(".access-empty")).toHaveLength(2);
  });
});

describe("close behavior", () => {
  it("closes on the close button", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");
    (root.querySelector('[data-role="close"]') as HTMLElement).click();

    expect(root.style.display).toBe("none");
  });

  it("closes when clicking the backdrop but not the content box", async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([]);
    vi.mocked(auth.listInvites).mockResolvedValue([]);

    const modal = new AccessModal(root);
    await modal.open("https://api.example.com", "room1");

    root.querySelector(".access-modal-content")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.style.display).toBe("flex");

    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.style.display).toBe("none");
  });
});
