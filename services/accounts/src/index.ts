import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "./passwords";
import { deleteAccountCascade } from "./cascade";
import {
  getAccount,
  createAccount,
  createSession,
  getSessionUsername,
  deleteSession,
  putMembership,
  listMemberships,
  getMembership,
  listMembers,
  deleteMembership,
  getRoomOwner,
  updateAccountPassword,
  deleteAllSessionsForUser,
  updateAccountEmail,
  createInvite,
  getInvite,
  redeemInvite,
  deleteInvite,
  listPendingInvites,
} from "./store";

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;
// Constrain usernames to a safe, predictable set rather than accepting any
// string >= 3 chars: keeps HTML/control characters out of a value that other
// users see (members/presence lists) and bounds the length.
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
// Deliberately loose (just "has an @ and something on both sides with a
// dot") -- only applied if an email is actually provided, since it's an
// optional contact field, not a required/verified one.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function requireSession(headers: Record<string, string | undefined>): Promise<string | undefined> {
  const auth = headers.authorization ?? headers.Authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token) return undefined;
  return getSessionUsername(token);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};

  switch (event.routeKey) {
    case "POST /auth/register": {
      const username = body.username;
      const password = body.password;
      const email = body.email;
      if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
        return json(400, {
          error: "username must be 3-30 characters, using only letters, numbers, and _ . -",
        });
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return json(400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      // Optional -- only validated (loosely) if actually provided.
      if (email !== undefined && (typeof email !== "string" || (email !== "" && !EMAIL_PATTERN.test(email)))) {
        return json(400, { error: "email must be a valid address" });
      }

      const { hash, salt } = await hashPassword(password);
      const personalRoomId = randomUUID();
      const created = await createAccount({
        username,
        passwordHash: hash,
        passwordSalt: salt,
        email: email || undefined,
        personalRoomId,
        createdAt: new Date().toISOString(),
      });
      if (!created) {
        return json(409, { error: "username already taken" });
      }

      await putMembership({ accountId: username, roomId: personalRoomId, role: "owner" });

      // No email verification step anymore -- log straight in, same
      // response shape as POST /auth/login.
      const sessionToken = await createSession(username);
      return json(201, { sessionToken, username, personalRoomId, email: email || undefined });
    }

    case "POST /auth/login": {
      const username = body.username;
      const password = body.password;
      if (typeof username !== "string" || typeof password !== "string") {
        return json(400, { error: "Missing username or password" });
      }

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Invalid username or password" });

      const valid = await verifyPassword(password, account.passwordSalt, account.passwordHash);
      if (!valid) return json(401, { error: "Invalid username or password" });

      const sessionToken = await createSession(username);
      return json(200, { sessionToken, username, personalRoomId: account.personalRoomId, email: account.email });
    }

    case "GET /auth/session": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Account no longer exists" });

      return json(200, { username, personalRoomId: account.personalRoomId, email: account.email });
    }

    case "POST /auth/logout": {
      const auth = (event.headers ?? {}).authorization ?? (event.headers ?? {}).Authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
      if (token) await deleteSession(token);
      return json(200, { ok: true });
    }

    case "POST /auth/change-password": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const currentPassword = body.currentPassword;
      const newPassword = body.newPassword;
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return json(400, { error: "Missing currentPassword or newPassword" });
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return json(400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Account no longer exists" });

      const valid = await verifyPassword(currentPassword, account.passwordSalt, account.passwordHash);
      if (!valid) return json(401, { error: "Current password is incorrect" });

      const { hash, salt } = await hashPassword(newPassword);
      await updateAccountPassword(username, hash, salt);
      // Changing a password revokes every existing session -- a token stolen
      // before the change (the whole reason a user changes a password after a
      // suspected compromise) stops working immediately. A fresh session is
      // then issued so the user who initiated the change stays logged in on
      // this device only.
      await deleteAllSessionsForUser(username);
      const sessionToken = await createSession(username);
      return json(200, { ok: true, sessionToken });
    }

    case "POST /auth/change-email": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const email = body.email;
      // Empty string clears it -- see updateAccountEmail.
      if (email !== undefined && (typeof email !== "string" || (email !== "" && !EMAIL_PATTERN.test(email)))) {
        return json(400, { error: "email must be a valid address" });
      }

      await updateAccountEmail(username, (email as string | undefined) || undefined);
      return json(200, { ok: true });
    }

    // Irreversible: wipes every room this account owns (assets, S3 objects,
    // memberships, invites, the room row itself), its own membership on any
    // room it's only a mod on elsewhere, every session, and the account row
    // -- see cascade.ts for the full cascade.
    case "DELETE /auth/account": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const password = body.password;
      if (typeof password !== "string") return json(400, { error: "Missing password" });

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Account no longer exists" });

      const valid = await verifyPassword(password, account.passwordSalt, account.passwordHash);
      if (!valid) return json(401, { error: "Incorrect password" });

      await deleteAccountCascade(username);
      return json(200, { ok: true });
    }

    case "GET /auth/rooms": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const memberships = await listMemberships(username);
      // Own membership rows never need a lookup -- the session's own
      // username already is the owner. Only a "mod" row (access to someone
      // else's room) needs listMembers()'s owner scan, since that's the
      // only case where the room isn't self-evidently "yours".
      const rooms = await Promise.all(
        memberships.map(async (m) => ({
          roomId: m.roomId,
          role: m.role,
          ownerUsername: m.role === "owner" ? username : await getRoomOwner(m.roomId),
        }))
      );
      return json(200, { rooms });
    }

    case "GET /auth/rooms/{roomId}/members": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can view members" });
      }

      const members = await listMembers(roomId);
      return json(200, { members });
    }

    case "DELETE /auth/rooms/{roomId}/members/{username}": {
      const requester = await requireSession(event.headers ?? {});
      if (!requester) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      const targetUsername = event.pathParameters?.username;
      if (!roomId || !targetUsername) return json(400, { error: "Missing roomId or username" });

      const requesterMembership = await getMembership(requester, roomId);
      if (!requesterMembership || requesterMembership.role !== "owner") {
        return json(403, { error: "Only the room owner can revoke access" });
      }

      const targetMembership = await getMembership(targetUsername, roomId);
      // Revoking is just deleting the membership row (see plan) -- but the
      // owner's own row is what makes them the owner in the first place, so
      // this route specifically refuses to ever delete a role: "owner" row,
      // regardless of who's asking.
      if (targetMembership?.role === "owner") {
        return json(400, { error: "Cannot revoke the room owner's own access" });
      }

      await deleteMembership(targetUsername, roomId);
      return json(200, { ok: true });
    }

    case "POST /auth/rooms/{roomId}/invites": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can create invites" });
      }

      const invite = await createInvite(roomId, username);
      return json(201, { inviteToken: invite.inviteToken, createdAt: invite.createdAt });
    }

    case "GET /auth/rooms/{roomId}/invites": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can view invites" });
      }

      const invites = await listPendingInvites(roomId);
      return json(200, { invites: invites.map((i) => ({ inviteToken: i.inviteToken, createdAt: i.createdAt })) });
    }

    case "DELETE /auth/rooms/{roomId}/invites/{inviteToken}": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      const inviteToken = event.pathParameters?.inviteToken;
      if (!roomId || !inviteToken) return json(400, { error: "Missing roomId or inviteToken" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can revoke invites" });
      }

      await deleteInvite(inviteToken);
      return json(200, { ok: true });
    }

    // Deliberately does NOT require the caller to already know the room --
    // the invite token itself is the authorization; any logged-in account
    // (new or existing) that presents a valid, not-yet-redeemed token gets
    // attached as a mod. "Creating a new account" is just the normal
    // register+verify+login flow beforehand -- this route only ever does
    // the room-attachment half.
    case "POST /auth/invites/{inviteToken}/redeem": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const inviteToken = event.pathParameters?.inviteToken;
      if (!inviteToken) return json(400, { error: "Missing inviteToken" });

      const invite = await getInvite(inviteToken);
      if (!invite) return json(404, { error: "Invalid or already-used invite link" });
      // Grandfather in pre-expiry invites (no expiresAt) as non-expiring.
      if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) {
        return json(404, { error: "This invite link has expired" });
      }

      const redeemed = await redeemInvite(inviteToken, username);
      if (!redeemed) return json(409, { error: "This invite has already been used" });

      // Guard against downgrading the room's own owner if they happen to
      // redeem their own invite link (e.g. testing it, or clicking an old
      // one by mistake) -- everyone else just gets/reaffirms "mod".
      const existingMembership = await getMembership(username, invite.roomId);
      if (existingMembership?.role !== "owner") {
        await putMembership({ accountId: username, roomId: invite.roomId, role: "mod" });
      }
      return json(200, { roomId: invite.roomId });
    }

    default:
      return json(404, { error: "Unknown route" });
  }
};
