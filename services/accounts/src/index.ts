import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "./passwords";
import { sendVerificationEmail } from "./email";
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
  createVerification,
  getVerificationUsername,
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
// Deliberately loose (just "has an @ and something on both sides with a
// dot") -- the actual proof that an address is real and reachable is the
// verification email landing in it, not this pattern.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function html(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

function verificationPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1f24;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:420px;padding:24px;text-align:center}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
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
      if (typeof username !== "string" || username.length < MIN_USERNAME_LENGTH) {
        return json(400, { error: `username must be at least ${MIN_USERNAME_LENGTH} characters` });
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return json(400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) {
        return json(400, { error: "a valid email address is required" });
      }

      const { hash, salt } = await hashPassword(password);
      const personalRoomId = randomUUID();
      const created = await createAccount({
        username,
        passwordHash: hash,
        passwordSalt: salt,
        email,
        emailVerified: false,
        personalRoomId,
        createdAt: new Date().toISOString(),
      });
      if (!created) {
        return json(409, { error: "username already taken" });
      }

      await putMembership({ accountId: username, roomId: personalRoomId, role: "owner" });

      const token = await createVerification(username);
      try {
        await sendVerificationEmail(email, username, token);
      } catch (err) {
        // The account is already created at this point -- a transient SES
        // failure shouldn't strand the user with no way forward. They can
        // retry via /auth/resend-verification once the underlying issue
        // (if any) clears, rather than getting a 500 for something that
        // already partially succeeded.
        console.error("Failed to send verification email", err);
      }

      // Deliberately no sessionToken -- login is blocked until the email is
      // verified (see POST /auth/login below), so there's nothing to log
      // straight into yet.
      return json(201, {
        username,
        personalRoomId,
        message: "Check your email to verify your account before logging in.",
      });
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

      // Explicitly `=== false` (not just falsy): an account created before
      // email verification existed has no emailVerified attribute at all
      // (undefined), and is grandfathered in as allowed rather than locked
      // out by a feature that didn't exist when it registered.
      if (account.emailVerified === false) {
        return json(403, { error: "Email not verified", unverified: true });
      }

      const sessionToken = await createSession(username);
      return json(200, { sessionToken, username, personalRoomId: account.personalRoomId });
    }

    case "GET /auth/verify": {
      const token = event.queryStringParameters?.token;
      if (!token) return html(400, verificationPage("Invalid link", "This verification link is missing its token."));

      const username = await getVerificationUsername(token);
      if (!username) {
        return html(
          400,
          verificationPage(
            "Link expired",
            "This verification link is invalid or has expired. Request a new one from the login screen."
          )
        );
      }

      await markEmailVerified(username);
      await deleteVerification(token);
      return html(200, verificationPage("Email verified", "You can close this tab and log in now."));
    }

    case "POST /auth/resend-verification": {
      const username = body.username;
      if (typeof username !== "string") return json(400, { error: "Missing username" });

      const account = await getAccount(username);
      // Same response regardless of whether the account exists or is
      // already verified -- avoids letting this endpoint be used to probe
      // which usernames are registered.
      if (account && account.emailVerified === false) {
        const token = await createVerification(username);
        await sendVerificationEmail(account.email, username, token).catch((err) => {
          console.error("Failed to resend verification email", err);
        });
      }
      return json(200, { message: "If that account exists and isn't verified yet, a new email was sent." });
    }

    case "GET /auth/session": {
      const username = await requireSession(event.headers ?? {});
      if (!username) return json(401, { error: "Invalid or missing session" });

      const account = await getAccount(username);
      if (!account) return json(401, { error: "Account no longer exists" });

      return json(200, { username, personalRoomId: account.personalRoomId });
    }

    case "POST /auth/logout": {
      const auth = (event.headers ?? {}).authorization ?? (event.headers ?? {}).Authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
      if (token) await deleteSession(token);
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
