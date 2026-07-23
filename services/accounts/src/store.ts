import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE!;

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface Account {
  username: string;
  passwordHash: string;
  passwordSalt: string;
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
