import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE!;
const INVITES_TABLE = process.env.INVITES_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface Account {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  // Optional -- email verification (and the requirement to provide one at
  // all) has been removed to keep registration/testing simple without
  // needing SES set up. Kept purely as an optional contact field.
  email?: string;
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

// No index by username -- sessions are looked up by token on every other
// path, so a GSI just for this one (account-deletion) cascade wasn't worth
// the extra table cost. A full-table Scan is fine at this system's scale
// and this only ever runs once, on account deletion, not a hot path.
export async function deleteAllSessionsForUser(username: string): Promise<void> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await ddb.send(
      new ScanCommand({
        TableName: SESSIONS_TABLE,
        FilterExpression: "username = :u",
        ExpressionAttributeValues: { ":u": username },
        ExclusiveStartKey,
      })
    );
    for (const item of Items) {
      await ddb.send(new DeleteCommand({ TableName: SESSIONS_TABLE, Key: { sessionToken: item.sessionToken } }));
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

export async function updateAccountPassword(username: string, passwordHash: string, passwordSalt: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { username },
      UpdateExpression: "SET passwordHash = :h, passwordSalt = :s",
      ExpressionAttributeValues: { ":h": passwordHash, ":s": passwordSalt },
    })
  );
}

// email omitted (not `undefined`) clears the stored field entirely --
// DynamoDB rejects `undefined` attribute values outright, and an explicit
// "REMOVE" keeps a since-cleared email from lingering as a stale value.
export async function updateAccountEmail(username: string, email: string | undefined): Promise<void> {
  await ddb.send(
    email
      ? new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { username },
          UpdateExpression: "SET email = :e",
          ExpressionAttributeValues: { ":e": email },
        })
      : new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { username },
          UpdateExpression: "REMOVE email",
        })
  );
}

export async function deleteAccountRow(username: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ACCOUNTS_TABLE, Key: { username } }));
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

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface Invite {
  inviteToken: string;
  roomId: string;
  createdBy: string;
  createdAt: string;
  // A leaked-but-unredeemed invite link should not work forever. Absent on
  // rows created before expiry existed -- those are grandfathered in as
  // non-expiring by the redeem path.
  expiresAt?: string;
  // Both unset until redeemed -- a pending invite has neither.
  redeemedBy?: string;
  redeemedAt?: string;
}

export async function createInvite(roomId: string, createdBy: string): Promise<Invite> {
  const now = Date.now();
  const invite: Invite = {
    inviteToken: randomUUID(),
    roomId,
    createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_SECONDS * 1000).toISOString(),
  };
  await ddb.send(
    new PutCommand({
      TableName: INVITES_TABLE,
      // ttl (epoch seconds) drives DynamoDB's automatic expiry sweep;
      // expiresAt (ISO) is what the redeem path checks synchronously, since
      // the sweep can lag hours behind the real expiry time.
      Item: { ...invite, ttl: Math.floor(now / 1000) + INVITE_TTL_SECONDS },
    })
  );
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

// Unlike listPendingInvites, includes already-redeemed ones too -- used
// only for wiping every trace of a room being deleted, not for showing a
// still-usable invite list.
export async function listAllInvitesForRoom(roomId: string): Promise<Invite[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: INVITES_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items as Invite[];
}

// ---- Room/asset cascade helpers, for deleting an account's owned room(s)
// entirely (see index.ts's DELETE /auth/account). Deliberately minimal --
// only the fields this cascade actually needs, not the full Asset shape
// websocket-handlers works with.
interface CascadeAssetRow {
  assetId: string;
  s3Key?: string;
}

export async function listRoomAssetsForCascade(roomId: string): Promise<CascadeAssetRow[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: ASSETS_TABLE,
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items as CascadeAssetRow[];
}

export async function deleteAssetRow(roomId: string, assetId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ASSETS_TABLE, Key: { roomId, assetId } }));
}

export async function deleteRoomRow(roomId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ROOMS_TABLE, Key: { roomId } }));
}

// Best-effort -- called once per distinct s3Key while wiping a whole room,
// so a stray object left behind on a transient S3 failure is a
// retention-job cleanup problem, not a reason to fail the entire account
// deletion for the user (same rationale as message.ts's asset:delete path).
export async function deleteS3Object(s3Key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: ASSETS_BUCKET, Key: s3Key })).catch((err) => {
    console.error("Failed to delete S3 object during account deletion cascade", err);
  });
}
