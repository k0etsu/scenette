import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

// TODO: this is the $default route handler — real room-state mutations
// (asset move/add/remove, viewport-intersection visibility toggling) belong
// here. For now it just re-broadcasts the incoming payload to every other
// connection in the same room, which is enough to prove the fan-out wiring.
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const domain = event.requestContext.domainName;
  const stage = event.requestContext.stage;

  const { Items: connections = [] } = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: "byRoom",
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": await roomIdFor(connectionId) },
    })
  );

  const apiGw = new ApiGatewayManagementApiClient({
    endpoint: `https://${domain}/${stage}`,
  });

  await Promise.all(
    connections
      .filter((c) => c.connectionId !== connectionId)
      .map((c) =>
        apiGw
          .send(
            new PostToConnectionCommand({
              ConnectionId: c.connectionId,
              Data: Buffer.from(event.body ?? ""),
            })
          )
          .catch(async (err) => {
            // Stale connection (client disconnected without a clean $disconnect) — clean it up.
            if (err.name === "GoneException") {
              await ddb.send(
                new DeleteCommand({
                  TableName: CONNECTIONS_TABLE,
                  Key: { connectionId: c.connectionId },
                })
              );
            }
          })
      )
  );

  return { statusCode: 200, body: "OK" };
};

async function roomIdFor(connectionId: string): Promise<string> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      KeyConditionExpression: "connectionId = :id",
      ExpressionAttributeValues: { ":id": connectionId },
    })
  );
  return Items?.[0]?.roomId;
}
