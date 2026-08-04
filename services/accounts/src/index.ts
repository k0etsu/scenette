import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "./passwords";
import { deleteAccountCascade } from "./cascade";
import { sendVerificationEmail } from "./email";
import { setSessionCookie, clearSessionCookie, readSessionToken } from "./cookies";
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
  getOrCreateObsKey,
  regenerateObsKey,
  getRoomIdByObsKey,
  updateAccountPassword,
  deleteAllSessionsForUser,
  updateAccountEmail,
  createVerification,
  getVerification,
  deleteVerification,
  markEmailVerified,
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

function json(statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(cookies ? { cookies } : {}),
  };
}

async function requireSession(headers: Record<string, string | undefined>): Promise<string | undefined> {
  const token = readSessionToken(headers);
  if (!token) return undefined;
  return getSessionUsername(token);
}

// A minimal self-contained confirmation page for the emailed verify link
// (which is opened directly in a browser, not via the SPA). Only static,
// non-user-controlled text is interpolated -- no XSS surface.
function html(statusCode: number, title: string, message: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body:
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
      `<h1>${title}</h1><p>${message}</p></body></html>`,
  };
}

// The origin this API is reached at, taken from the request itself so the
// verify link is correct on both the execute-api domain and the custom
// api.<zone> domain without a config value to keep in sync.
function apiBaseUrl(event: Parameters<APIGatewayProxyHandlerV2>[0]): string {
  return `https://${event.requestContext.domainName}`;
}

async function startEmailVerification(username: string, email: string, baseUrl: string): Promise<void> {
  const verification = await createVerification(username, email);
  try {
    await sendVerificationEmail(email, username, verification.token, baseUrl);
  } catch (err) {
    // A send failure must not fail the user's request -- the token row is
    // already written, so the user can just resend. Logged for visibility.
    console.error("Failed to send verification email", err);
  }
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
      const created = await createAccount({
        username,
        passwordHash: hash,
        passwordSalt: salt,
        email: email || undefined,
        emailVerified: false,
        createdAt: new Date().toISOString(),
      });
      if (!created) {
        return json(409, { error: "username already taken" });
      }

      // No personal room yet -- a room (and its owner membership) is created
      // only when an email is verified (see GET /auth/verify). Registration
      // logs straight in so an unverified user can still act as a mod on
      // rooms they're invited to. If an email was supplied now, kick off
      // verification immediately.
      if (email) {
        await startEmailVerification(username, email as string, apiBaseUrl(event));
      }

      const sessionToken = await createSession(username);
      return json(
        201,
        { username, email: email || undefined, emailVerified: false, personalRoomId: undefined },
        [setSessionCookie(sessionToken)]
      );
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
      return json(
        200,
        {
          username,
          personalRoomId: account.personalRoomId,
          email: account.email,
          emailVerified: account.emailVerified ?? false,
        },
        [setSessionCookie(sessionToken)]
      );
    }

    case "GET /auth/session": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Account no longer exists" });

      return json(200, {
        username,
        personalRoomId: account.personalRoomId,
        email: account.email,
        emailVerified: account.emailVerified ?? false,
      });
    }

    case "POST /auth/logout": {
      const token = readSessionToken(event.headers ?? {});
      if (token) await deleteSession(token);
      return json(200, { ok: true }, [clearSessionCookie()]);
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
      return json(200, { ok: true }, [setSessionCookie(sessionToken)]);
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
      // Setting a (non-empty) email starts verification -- the address is
      // unverified until the mailed link is clicked, which is what unlocks
      // the account's own room.
      if (email) {
        await startEmailVerification(username, email as string, apiBaseUrl(event));
      }
      return json(200, { ok: true });
    }

    // Opened directly from the emailed link (a browser GET, not an SPA fetch)
    // -- responds with a small HTML confirmation page. Verifying an email is
    // what first creates the account's personal room + owner membership.
    case "GET /auth/verify": {
      const token = event.queryStringParameters?.token;
      if (!token) return html(400, "Invalid link", "This verification link is missing its token.");

      const verification = await getVerification(token);
      if (!verification || Date.parse(verification.expiresAt) < Date.now()) {
        return html(400, "Link expired", "This verification link is invalid or has expired. Request a new one from scenette.");
      }

      const account = await getAccount(verification.username);
      if (!account) return html(400, "Invalid link", "That account no longer exists.");
      // Guard a stale link left over from before the user changed their email
      // again -- only the current pending address can be verified.
      if (account.email !== verification.email) {
        await deleteVerification(token);
        return html(400, "Link expired", "This link was for a different email address. Request a new one from scenette.");
      }

      const roomId = await markEmailVerified(verification.username, randomUUID());
      await putMembership({ accountId: verification.username, roomId, role: "owner" });
      await deleteVerification(token);
      return html(200, "Email verified", "Your email is verified and your room is ready. Head back to scenette to start using it.");
    }

    case "POST /auth/resend-verification": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const account = await getAccount(username);
      // Deliberately generic response whether or not a resend actually
      // happened -- never reveals whether an account has a pending email.
      if (account?.email && !account.emailVerified) {
        await startEmailVerification(username, account.email, apiBaseUrl(event));
      }
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
      return json(200, { ok: true }, [clearSessionCookie()]);
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

    // Any member (owner or mod) of the room can see whose room it is -- used
    // for the room header ("<owner>'s room").
    case "GET /auth/rooms/{roomId}/owner": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership) return json(403, { error: "Not a member of this room" });

      return json(200, { ownerUsername: await getRoomOwner(roomId) });
    }

    // Owner-only: mints (lazily, once) and returns the room's opaque obsKey so
    // the owner can build the browser-source URL. A mod deliberately can't
    // reach this -- that's what stops them lifting the OBS URL for a room
    // that isn't theirs.
    case "GET /auth/rooms/{roomId}/obs-url": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can get the browser source URL" });
      }

      return json(200, { obsKey: await getOrCreateObsKey(roomId) });
    }

    // Owner-only: rotate the obsKey, revoking whatever URL was in use before.
    // POST (a state change) as opposed to the idempotent GET above.
    case "POST /auth/rooms/{roomId}/obs-url": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      if (!roomId) return json(400, { error: "Missing roomId" });

      const membership = await getMembership(username, roomId);
      if (!membership || membership.role !== "owner") {
        return json(403, { error: "Only the room owner can regenerate the browser source URL" });
      }

      return json(200, { obsKey: await regenerateObsKey(roomId) });
    }

    // Public (no session): browser-source, which is anonymous, exchanges the
    // opaque obsKey it was given for the roomId it needs to connect. Having a
    // valid obsKey is the capability -- it's 128 bits of randomness, so not
    // guessable, and a resolved roomId grants no control (writes still require
    // an authenticated member connection).
    case "GET /rooms/resolve": {
      const obsKey = event.queryStringParameters?.obs;
      if (!obsKey) return json(400, { error: "Missing obs" });
      const roomId = await getRoomIdByObsKey(obsKey);
      if (!roomId) return json(404, { error: "Unknown browser source key" });
      return json(200, { roomId });
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
