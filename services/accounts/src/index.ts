import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "./passwords";
import {
  getAccount,
  createAccount,
  createSession,
  getSessionUsername,
  deleteSession,
  putMembership,
  listMemberships,
  getMembership,
} from "./store";

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

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
      if (typeof username !== "string" || username.length < MIN_USERNAME_LENGTH) {
        return json(400, { error: `username must be at least ${MIN_USERNAME_LENGTH} characters` });
      }
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return json(400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const { hash, salt } = await hashPassword(password);
      const personalRoomId = randomUUID();
      const created = await createAccount({
        username,
        passwordHash: hash,
        passwordSalt: salt,
        personalRoomId,
        createdAt: new Date().toISOString(),
      });
      if (!created) {
        return json(409, { error: "username already taken" });
      }

      await putMembership({ accountId: username, roomId: personalRoomId, role: "owner" });
      const sessionToken = await createSession(username);
      return json(201, { sessionToken, username, personalRoomId });
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
      return json(200, { sessionToken, username, personalRoomId: account.personalRoomId });
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
      return json(200, { rooms: memberships });
    }

    case "POST /auth/rooms/{roomId}/grant": {
      const grantor = await requireSession(event.headers ?? {});
      if (!grantor) return json(401, { error: "Invalid or missing session" });

      const roomId = event.pathParameters?.roomId;
      const granteeUsername = body.username;
      if (!roomId || typeof granteeUsername !== "string") {
        return json(400, { error: "Missing roomId or username" });
      }

      // Only the room's owner can grant access to others.
      const grantorMembership = await getMembership(grantor, roomId);
      if (!grantorMembership || grantorMembership.role !== "owner") {
        return json(403, { error: "Only the room owner can grant access" });
      }

      const granteeAccount = await getAccount(granteeUsername);
      if (!granteeAccount) return json(404, { error: "No such username" });

      await putMembership({ accountId: granteeUsername, roomId, role: "mod" });
      return json(200, { ok: true });
    }

    default:
      return json(404, { error: "Unknown route" });
  }
};
