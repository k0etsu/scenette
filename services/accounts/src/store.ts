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
import { S3Client, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID, randomBytes } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE!;
const INVITES_TABLE = process.env.INVITES_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;
const EMAIL_VERIFICATIONS_TABLE = process.env.EMAIL_VERIFICATIONS_TABLE!;

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface Account {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  // Optional contact address. A newly-set email is always unverified
  // (emailVerified reset to false, see updateAccountEmail) until the user
  // clicks the link mailed to it.
  email?: string;
  // Verifying an email is the gate to owning a room: an account only gets a
  // personalRoomId (and its owner membership) once emailVerified flips true
  // for the first time -- see markEmailVerified. Mods on someone else's room
  // never need this. Absent (undefined) on rows created before verification
  // existed -- treated as unverified.
  emailVerified?: boolean;
  // Only set once the account's email has been verified -- undefined for a
  // brand-new (or never-verified) account, which therefore owns no room yet.
  personalRoomId?: string;
  createdAt: string;
}

export interface EmailVerification {
  token: string;
  username: string;
  email: string;
  expiresAt: string;
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

// Setting an email always marks it unverified -- the address only becomes
// verified once the mailed link is clicked (see markEmailVerified). Clearing
// it (empty -> REMOVE) likewise drops verified status. A REMOVE is used
// rather than writing `undefined`, which DynamoDB rejects outright.
export async function updateAccountEmail(username: string, email: string | undefined): Promise<void> {
  await ddb.send(
    email
      ? new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { username },
          UpdateExpression: "SET email = :e, emailVerified = :false",
          ExpressionAttributeValues: { ":e": email, ":false": false },
        })
      : new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { username },
          UpdateExpression: "REMOVE email SET emailVerified = :false",
          ExpressionAttributeValues: { ":false": false },
        })
  );
}

export async function createVerification(username: string, email: string): Promise<EmailVerification> {
  const now = Date.now();
  const verification: EmailVerification = {
    token: randomUUID(),
    username,
    email,
    expiresAt: new Date(now + VERIFICATION_TTL_SECONDS * 1000).toISOString(),
  };
  await ddb.send(
    new PutCommand({
      TableName: EMAIL_VERIFICATIONS_TABLE,
      Item: { ...verification, ttl: Math.floor(now / 1000) + VERIFICATION_TTL_SECONDS },
    })
  );
  return verification;
}

export async function getVerification(token: string): Promise<EmailVerification | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: EMAIL_VERIFICATIONS_TABLE, Key: { token } })
  );
  return Item as EmailVerification | undefined;
}

export async function deleteVerification(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: EMAIL_VERIFICATIONS_TABLE, Key: { token } }));
}

// No by-username index (verifications are looked up by token everywhere else,
// and there are at most a handful per user) -- a Scan is fine for the one
// account-deletion cascade that needs this, same rationale as
// deleteAllSessionsForUser.
export async function deleteAllVerificationsForUser(username: string): Promise<void> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await ddb.send(
      new ScanCommand({
        TableName: EMAIL_VERIFICATIONS_TABLE,
        FilterExpression: "username = :u",
        ExpressionAttributeValues: { ":u": username },
        ExclusiveStartKey,
      })
    );
    for (const item of Items) {
      await ddb.send(new DeleteCommand({ TableName: EMAIL_VERIFICATIONS_TABLE, Key: { token: item.token } }));
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

// Flips the account to verified and, the first time only, assigns its
// personalRoomId. The conditional guard makes room assignment idempotent --
// a second click of the same (or a re-sent) link won't mint a second room.
// Returns the room id the account owns afterward. Callers pair this with a
// putMembership(owner) to actually create the room's ownership record.
export async function markEmailVerified(username: string, newRoomId: string): Promise<string> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { username },
        UpdateExpression: "SET emailVerified = :true, personalRoomId = :room",
        ConditionExpression: "attribute_not_exists(personalRoomId)",
        ExpressionAttributeValues: { ":true": true, ":room": newRoomId },
      })
    );
    return newRoomId;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      // A room already exists (a prior verification) -- just (re)assert
      // verified status and keep the existing room.
      await ddb.send(
        new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { username },
          UpdateExpression: "SET emailVerified = :true",
          ExpressionAttributeValues: { ":true": true },
        })
      );
      const account = await getAccount(username);
      return account!.personalRoomId!;
    }
    throw err;
  }
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

// The browser-source URL is keyed on this opaque, unguessable obsKey rather
// than the roomId itself -- a mod (who necessarily knows the roomId from their
// own control-ui URL) must not be able to derive or obtain the OBS URL and
// pass someone else's room off as their own. Only the owner can mint/read it
// (see the owner-gated route), and browser-source resolves obsKey -> roomId
// via the byObsKey GSI. Created lazily on first request; if_not_exists keeps
// it stable across repeated requests (and upserts the room row if the WS layer
// hasn't lazily created it yet).
export async function getOrCreateObsKey(roomId: string): Promise<string> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET obsKey = if_not_exists(obsKey, :new)",
      ExpressionAttributeValues: { ":new": randomBytes(16).toString("base64url") },
      ReturnValues: "ALL_NEW",
    })
  );
  return Attributes!.obsKey as string;
}

// Unconditionally rotates the obsKey, revoking any URL that used the old one
// (the byObsKey GSI drops the old value the moment this write lands, so
// GET /rooms/resolve on the stale key immediately 404s). Owner-initiated --
// see the owner-gated route.
export async function regenerateObsKey(roomId: string): Promise<string> {
  const obsKey = randomBytes(16).toString("base64url");
  await ddb.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET obsKey = :new",
      ExpressionAttributeValues: { ":new": obsKey },
    })
  );
  return obsKey;
}

export async function getRoomIdByObsKey(obsKey: string): Promise<string | undefined> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: ROOMS_TABLE,
      IndexName: "byObsKey",
      KeyConditionExpression: "obsKey = :o",
      ExpressionAttributeValues: { ":o": obsKey },
    })
  );
  return (Items[0] as { roomId?: string } | undefined)?.roomId;
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

// The dashboard announcement is a single admin-managed S3 object -- an admin
// overwrites it to change the message with no redeploy. Returns null when
// absent/unreadable so the dashboard just shows nothing.
const ANNOUNCEMENT_KEY = "admin/announcement.txt";

export async function getAnnouncement(): Promise<string | null> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: ANNOUNCEMENT_KEY }));
    const text = (await Body?.transformToString())?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}
