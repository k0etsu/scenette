import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { PresenceEntry, ServerMessage } from "@scenette/protocol";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

export interface ConnectionInfo {
  roomId: string;
  // Absent for an anonymous browser-source connection -- connect.ts already
  // verified membership for any connection that DOES have a username, so
  // message.ts only needs to check for its presence (not re-check
  // membership itself) to gate write actions to actual members.
  username?: string;
}

export async function getConnectionInfo(connectionId: string): Promise<ConnectionInfo | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
  if (!Item) return undefined;
  return { roomId: Item.roomId, username: Item.username };
}

// One row per connected control-ui session -- anonymous browser-source
// connections have no `username` attribute at all (see connect.ts) and are
// filtered out here rather than ever being counted/listed as a "user".
export async function listPresence(roomId: string): Promise<PresenceEntry[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items.filter((c) => typeof c.username === "string").map((c) => ({
    username: c.username,
    connectedAt: c.connectedAt,
  }));
}

export async function sendTo(
  apiGw: ApiGatewayManagementApiClient,
  connectionId: string,
  message: ServerMessage
): Promise<void> {
  try {
    await apiGw.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      })
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "GoneException") {
      // Client disconnected without a clean $disconnect — clean up the stale row.
      await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }));
      return;
    }
    throw err;
  }
}

export async function broadcastToRoom(
  apiGw: ApiGatewayManagementApiClient,
  roomId: string,
  message: ServerMessage,
  excludeConnectionId?: string
): Promise<void> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );

  await Promise.all(
    Items.filter((c) => c.connectionId !== excludeConnectionId).map((c) =>
      sendTo(apiGw, c.connectionId, message)
    )
  );
}
