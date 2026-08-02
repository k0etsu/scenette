import {
  listMemberships,
  listMembers,
  deleteMembership,
  listRoomAssetsForCascade,
  deleteAssetRow,
  deleteRoomRow,
  listAllInvitesForRoom,
  deleteInvite,
  deleteS3Object,
  deleteAllSessionsForUser,
  deleteAccountRow,
} from "./store";

// Deletes an account entirely: every room it owns (assets, S3 objects,
// memberships, invites, the room row itself), its own membership rows on
// rooms it's only a mod on elsewhere, every session, and finally the
// account row. Order matters -- the account row is deleted last so a
// crash partway through leaves a still-lookupable (if partially cleaned
// up) account rather than an orphaned one nothing can reference anymore.
export async function deleteAccountCascade(username: string): Promise<void> {
  const memberships = await listMemberships(username);

  for (const membership of memberships) {
    if (membership.role === "owner") {
      await deleteOwnedRoom(membership.roomId);
    } else {
      // Just a mod elsewhere -- only this one membership row needs to go,
      // the room itself belongs to (and stays with) someone else.
      await deleteMembership(username, membership.roomId);
    }
  }

  await deleteAllSessionsForUser(username);
  await deleteAccountRow(username);
}

async function deleteOwnedRoom(roomId: string): Promise<void> {
  const assets = await listRoomAssetsForCascade(roomId);

  // Every asset in this room is being deleted together, so (unlike a
  // single asset:delete, which has to check whether some other still-live
  // asset references the same s3Key) any distinct key here can just be
  // deleted once with no further reference-counting.
  const s3Keys = new Set(assets.map((a) => a.s3Key).filter((key): key is string => Boolean(key)));
  for (const s3Key of s3Keys) {
    await deleteS3Object(s3Key);
  }
  for (const asset of assets) {
    await deleteAssetRow(roomId, asset.assetId);
  }

  const invites = await listAllInvitesForRoom(roomId);
  for (const invite of invites) {
    await deleteInvite(invite.inviteToken);
  }

  // Every membership row pointing at this room -- including the owner's
  // own -- not just the caller's, so a mod who had access loses it the
  // instant the room disappears rather than being left with a dangling
  // reference to a room that no longer exists.
  const members = await listMembers(roomId);
  for (const member of members) {
    await deleteMembership(member.accountId, roomId);
  }

  await deleteRoomRow(roomId);
}
