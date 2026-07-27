import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
// Relative cross-service import rather than a "@scenette/accounts" package
// specifier: that package has no build step (its package.json only runs
// `tsc --noEmit` for type-checking) and no main/exports field, so there's no
// compiled entry point for normal module resolution to find. esbuild (via
// CDK's NodejsFunction) bundles TypeScript source directly regardless of
// which workspace it lives in, so a relative path into the sibling
// service's src works fine without needing to turn accounts into a real
// published package.
import { getSessionUsername } from "../../accounts/src/store";
import { broadcastToRoom } from "./connections";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

// TODO: once the real OAuth broker lands, validate a proper session there
// too -- for now this only understands the lightweight username/password
// accounts service's opaque session tokens.
//
// An anonymous browser-source connection (no token) is still allowed to
// connect read-only, but never gets a `username` attribute -- that's what
// keeps it out of the connected-users presence list/count, which only ever
// shows people actually sitting at the control UI.
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const roomId = event.queryStringParameters?.roomId;
  const token = event.queryStringParameters?.token;

  if (!roomId) {
    return { statusCode: 400, body: "Missing roomId query parameter" };
  }

  const username = token ? await getSessionUsername(token) : undefined;
  const connectedAt = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        roomId,
        connectedAt,
        ...(username ? { username } : {}),
      },
    })
  );

  if (username) {
    const apiGw = new ApiGatewayManagementApiClient({
      endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
    });
    // Exclude this connection itself: from API Gateway's Management API
    // perspective a connection isn't fully "active" until $connect returns,
    // so PostToConnection targeting it (from within its own $connect
    // invocation) fails with GoneException -- which sendTo() treats as "this
    // client disconnected" and deletes the connections-table row it just
    // wrote, wiping out its own room association before this handler even
    // returns. The connecting client doesn't need to hear about its own
    // join anyway; it'll see itself in the presence list it requests right
    // after via room:snapshot.
    await broadcastToRoom(
      apiGw,
      roomId,
      { type: "presence:joined", entry: { username, connectedAt } },
      connectionId
    );
  }

  return { statusCode: 200, body: "Connected" };
};
