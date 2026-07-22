import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { Asset, intersects, parseClientMessage } from "@scenette/protocol";
import { roomIdForConnection, sendTo, broadcastToRoom } from "./connections";
import { getOrCreateViewport, listAssets, putAsset, moveAsset, deleteAsset } from "./roomState";

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const apiGw = new ApiGatewayManagementApiClient({
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  try {
    const message = parseClientMessage(event.body ?? "");

    // A connection only ever operates on the room it registered with at
    // $connect — reject anything else rather than trusting the client's
    // claimed roomId for lookups that matter (broadcast fan-out, etc).
    const connectedRoomId = await roomIdForConnection(connectionId);
    if (!connectedRoomId || connectedRoomId !== message.roomId) {
      await sendTo(apiGw, connectionId, { type: "error", message: "Not connected to this room" });
      return { statusCode: 200, body: "OK" };
    }

    const viewport = await getOrCreateViewport(message.roomId);

    switch (message.action) {
      case "room:snapshot:request": {
        const assets = await listAssets(message.roomId);
        await sendTo(apiGw, connectionId, {
          type: "room:snapshot",
          assets,
          viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
        });
        break;
      }

      case "asset:add": {
        const now = new Date().toISOString();
        const asset: Asset = {
          roomId: message.roomId,
          assetId: message.asset.assetId,
          type: message.asset.type,
          x: message.asset.x,
          y: message.asset.y,
          width: message.asset.width,
          height: message.asset.height,
          rotation: message.asset.rotation ?? 0,
          zIndex: message.asset.zIndex ?? 0,
          visible: intersects(message.asset, viewport),
          s3Key: message.asset.s3Key,
          text: message.asset.text,
          uploadedAt: now,
          lastUsedAt: now,
          keep: false,
        };
        await putAsset(asset);
        await broadcastToRoom(apiGw, message.roomId, { type: "asset:added", asset });
        break;
      }

      case "asset:move": {
        const result = await moveAsset(
          message.roomId,
          message.assetId,
          message.x,
          message.y,
          message.rotation,
          viewport
        );
        if (!result) {
          await sendTo(apiGw, connectionId, { type: "error", message: "Unknown assetId" });
          break;
        }
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:moved",
          assetId: message.assetId,
          x: message.x,
          y: message.y,
          rotation: result.rotation,
          visible: result.visible,
        });
        break;
      }

      case "asset:delete": {
        await deleteAsset(message.roomId, message.assetId);
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:deleted",
          assetId: message.assetId,
        });
        break;
      }
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Invalid message";
    await sendTo(apiGw, connectionId, { type: "error", message: reason });
    return { statusCode: 200, body: "OK" };
  }
};
