import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE!;
const EMAIL_VERIFICATIONS_TABLE = process.env.EMAIL_VERIFICATIONS_TABLE!;
const INVITES_TABLE = process.env.INVITES_TABLE!;

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24 hours -- a stale link just needs a resend, not indefinite validity

export interface Account {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  email: string;
  // Explicitly false (not just falsy) for a brand-new registration; a
  // pre-existing account from before email verification existed has no
  // `emailVerified` attribute at all (undefined), which login.ts treats as
  // grandfathered-in rather than locking out every account that predates
  // this feature.
  emailVerified: boolean;
  personalRoomId: string;
  createdAt: string;
}

export interface Membership {
  accountId: string; // = username, for this lightweight system
  roomId: string;
  role: "owner" | "mod";
}

export async function getAccount(username: string): Promise<Account | undefined> {
  const { Item } = await ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { username } }));
  return Item as Account | undefined;
}

export async function createAccount(account: Account): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: ACCOUNTS_TABLE,
        Item: account,
        ConditionExpression: "attribute_not_exists(username)",
      })
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function createSession(username: string): Promise<string> {
  const sessionToken = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: { sessionToken, username, ttl: now + SESSION_TTL_SECONDS },
    })
  );
  return sessionToken;
}

export async function getSessionUsername(sessionToken: string): Promise<string | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionToken } })
  );
  return Item?.username;
}

export async function deleteSession(sessionToken: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: SESSIONS_TABLE, Key: { sessionToken } }));
}

// Opaque token, not signed -- same rationale as session tokens (see
// SessionsTable's CDK comment): validity is just "does this row still
// exist", so nothing to verify cryptographically and nothing to rotate a
// signing secret for.
export async function createVerification(username: string): Promise<string> {
  const token = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: EMAIL_VERIFICATIONS_TABLE,
      Item: { token, username, ttl: now + VERIFICATION_TTL_SECONDS },
    })
  );
  return token;
}

export async function getVerificationUsername(token: string): Promise<string | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: EMAIL_VERIFICATIONS_TABLE, Key: { token } })
  );
  return Item?.username;
}

export async function deleteVerification(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: EMAIL_VERIFICATIONS_TABLE, Key: { token } }));
}

export async function markEmailVerified(username: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { username },
      UpdateExpression: "SET emailVerified = :v",
      ExpressionAttributeValues: { ":v": true },
    })
  );
}

export async function putMembership(membership: Membership): Promise<void> {
  await ddb.send(new PutCommand({ TableName: MEMBERSHIPS_TABLE, Item: membership }));
}

export async function listMemberships(accountId: string): Promise<Membership[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: MEMBERSHIPS_TABLE,
      KeyConditionExpression: "accountId = :accountId",
      ExpressionAttributeValues: { ":accountId": accountId },
    })
  );
  return Items as Membership[];
}

export async function getMembership(accountId: string, roomId: string): Promise<Membership | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: MEMBERSHIPS_TABLE, Key: { accountId, roomId } })
  );
  return Item as Membership | undefined;
}

export async function listMembers(roomId: string): Promise<Membership[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items as Membership[];
}

export async function deleteMembership(accountId: string, roomId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: MEMBERSHIPS_TABLE, Key: { accountId, roomId } }));
}

// A mod's own membership row only has their own accountId/role -- nothing
// identifying whose room it actually is. Used to label a room list ("<X>'s
// room") for a mod with access to more than just their own personal room.
export async function getRoomOwner(roomId: string): Promise<string | undefined> {
  const members = await listMembers(roomId);
  return members.find((m) => m.role === "owner")?.accountId;
}

export interface Invite {
  inviteToken: string;
  roomId: string;
  createdBy: string;
  createdAt: string;
  // Both unset until redeemed -- a pending invite has neither.
  redeemedBy?: string;
  redeemedAt?: string;
}

export async function createInvite(roomId: string, createdBy: string): Promise<Invite> {
  const invite: Invite = { inviteToken: randomUUID(), roomId, createdBy, createdAt: new Date().toISOString() };
  await ddb.send(new PutCommand({ TableName: INVITES_TABLE, Item: invite }));
  return invite;
}

export async function getInvite(inviteToken: string): Promise<Invite | undefined> {
  const { Item } = await ddb.send(new GetCommand({ TableName: INVITES_TABLE, Key: { inviteToken } }));
  return Item as Invite | undefined;
}

// Single-use: a conditional write rejects a second redemption of the same
// token outright (covers a race between two concurrent redeem attempts, not
// just sequential reuse) rather than relying on an application-level check
// after a plain read.
export async function redeemInvite(inviteToken: string, redeemedBy: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: INVITES_TABLE,
        Key: { inviteToken },
        UpdateExpression: "SET redeemedBy = :u, redeemedAt = :now",
        ConditionExpression: "attribute_exists(inviteToken) AND attribute_not_exists(redeemedBy)",
        ExpressionAttributeValues: { ":u": redeemedBy, ":now": new Date().toISOString() },
      })
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function deleteInvite(inviteToken: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: INVITES_TABLE, Key: { inviteToken } }));
}

export async function listPendingInvites(roomId: string): Promise<Invite[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: INVITES_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      FilterExpression: "attribute_not_exists(redeemedBy)",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items as Invite[];
}
