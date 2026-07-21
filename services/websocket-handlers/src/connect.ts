import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

// TODO: validate the caller's session JWT (issued by the auth-broker) here once
// auth is wired up. For an anonymous browser-source connection, roomId alone
// is sufficient (read-only); an editor connection additionally needs a valid
// session mapping to a membership row for this room.
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const roomId = event.queryStringParameters?.roomId;

  if (!roomId) {
    return { statusCode: 400, body: "Missing roomId query parameter" };
  }

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        roomId,
        connectedAt: new Date().toISOString(),
      },
    })
  );

  return { statusCode: 200, body: "Connected" };
};
