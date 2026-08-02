import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/store", () => ({
  listMemberships: vi.fn(),
  listMembers: vi.fn(),
  deleteMembership: vi.fn(),
  listRoomAssetsForCascade: vi.fn(),
  deleteAssetRow: vi.fn(),
  deleteRoomRow: vi.fn(),
  listAllInvitesForRoom: vi.fn(),
  deleteInvite: vi.fn(),
  deleteS3Object: vi.fn(),
  deleteAllSessionsForUser: vi.fn(),
  deleteAccountRow: vi.fn(),
}));

import { deleteAccountCascade } from "../src/cascade";
import * as store from "../src/store";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.listMembers).mockResolvedValue([]);
  vi.mocked(store.listRoomAssetsForCascade).mockResolvedValue([]);
  vi.mocked(store.listAllInvitesForRoom).mockResolvedValue([]);
});

describe("deleteAccountCascade", () => {
  it("just deletes the membership row for a room the account only mods, without touching the room itself", async () => {
    vi.mocked(store.listMemberships).mockResolvedValue([{ accountId: "bob", roomId: "someone-elses-room", role: "mod" }]);

    await deleteAccountCascade("bob");

    expect(store.deleteMembership).toHaveBeenCalledWith("bob", "someone-elses-room");
    expect(store.deleteRoomRow).not.toHaveBeenCalled();
    expect(store.listRoomAssetsForCascade).not.toHaveBeenCalled();
    expect(store.deleteAllSessionsForUser).toHaveBeenCalledWith("bob");
    expect(store.deleteAccountRow).toHaveBeenCalledWith("bob");
  });

  it("wipes every asset, its S3 object, invites, and every membership for a room the account owns", async () => {
    vi.mocked(store.listMemberships).mockResolvedValue([{ accountId: "alice", roomId: "room1", role: "owner" }]);
    vi.mocked(store.listRoomAssetsForCascade).mockResolvedValue([
      { assetId: "a1", s3Key: "key1" },
      { assetId: "a2", s3Key: "key1" }, // duplicate asset (duplicateAsset()) sharing the same key
      { assetId: "a3" }, // text asset, no s3Key at all
    ]);
    vi.mocked(store.listAllInvitesForRoom).mockResolvedValue([
      { inviteToken: "tok1", roomId: "room1", createdBy: "alice", createdAt: "t" },
    ]);
    vi.mocked(store.listMembers).mockResolvedValue([
      { accountId: "alice", roomId: "room1", role: "owner" },
      { accountId: "carol", roomId: "room1", role: "mod" },
    ]);

    await deleteAccountCascade("alice");

    // Each distinct s3Key deleted exactly once, not once per asset row.
    expect(store.deleteS3Object).toHaveBeenCalledTimes(1);
    expect(store.deleteS3Object).toHaveBeenCalledWith("key1");

    expect(store.deleteAssetRow).toHaveBeenCalledWith("room1", "a1");
    expect(store.deleteAssetRow).toHaveBeenCalledWith("room1", "a2");
    expect(store.deleteAssetRow).toHaveBeenCalledWith("room1", "a3");

    expect(store.deleteInvite).toHaveBeenCalledWith("tok1");

    // Every membership for the room, including a mod who isn't the caller
    // -- not just the owner's own row.
    expect(store.deleteMembership).toHaveBeenCalledWith("alice", "room1");
    expect(store.deleteMembership).toHaveBeenCalledWith("carol", "room1");

    expect(store.deleteRoomRow).toHaveBeenCalledWith("room1");
    expect(store.deleteAllSessionsForUser).toHaveBeenCalledWith("alice");
    expect(store.deleteAccountRow).toHaveBeenCalledWith("alice");
  });

  it("handles an account with both an owned room and a separate mod membership", async () => {
    vi.mocked(store.listMemberships).mockResolvedValue([
      { accountId: "alice", roomId: "own-room", role: "owner" },
      { accountId: "alice", roomId: "bobs-room", role: "mod" },
    ]);

    await deleteAccountCascade("alice");

    expect(store.deleteRoomRow).toHaveBeenCalledWith("own-room");
    expect(store.deleteMembership).toHaveBeenCalledWith("alice", "bobs-room");
    // The mod-access room itself is never touched.
    expect(store.deleteRoomRow).not.toHaveBeenCalledWith("bobs-room");
  });

  it("deletes the account row last, after every other cleanup step", async () => {
    const order: string[] = [];
    vi.mocked(store.listMemberships).mockResolvedValue([{ accountId: "alice", roomId: "room1", role: "owner" }]);
    vi.mocked(store.deleteRoomRow).mockImplementation(async () => {
      order.push("deleteRoomRow");
    });
    vi.mocked(store.deleteAllSessionsForUser).mockImplementation(async () => {
      order.push("deleteAllSessionsForUser");
    });
    vi.mocked(store.deleteAccountRow).mockImplementation(async () => {
      order.push("deleteAccountRow");
    });

    await deleteAccountCascade("alice");

    expect(order).toEqual(["deleteRoomRow", "deleteAllSessionsForUser", "deleteAccountRow"]);
  });
});
