import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { Asset, Variable, intersects, parseClientMessage } from "@scenette/protocol";
import { roomIdForConnection, sendTo, broadcastToRoom, listPresence } from "./connections";
import {
  getOrCreateRoom,
  listAssets,
  putAsset,
  moveAsset,
  resizeAsset,
  updateAsset,
  deleteAsset,
  setGlobalVolume,
  setVariable,
  deleteVariable,
} from "./roomState";

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

    const room = await getOrCreateRoom(message.roomId);
    const viewport = { roomId: room.roomId, x: room.x, y: room.y, width: room.width, height: room.height };

    switch (message.action) {
      case "room:snapshot:request": {
        const [assets, presence] = await Promise.all([listAssets(message.roomId), listPresence(message.roomId)]);
        await sendTo(apiGw, connectionId, {
          type: "room:snapshot",
          assets,
          viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
          globalVolume: room.globalVolume,
          variables: Object.values(room.variables),
          presence,
        });
        break;
      }

      case "asset:add": {
        const now = new Date().toISOString();
        const hidden = message.asset.hidden ?? false;
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
          visible: intersects(message.asset, viewport) && !hidden,
          hidden,
          locked: message.asset.locked ?? false,
          opacity: message.asset.opacity ?? 1,
          blur: message.asset.blur ?? 0,
          flipX: message.asset.flipX ?? false,
          flipY: message.asset.flipY ?? false,
          loop: message.asset.loop ?? true,
          muted: message.asset.muted ?? false,
          volume: message.asset.volume ?? 1,
          paused: message.asset.paused ?? false,
          s3Key: message.asset.s3Key,
          text: message.asset.text,
          uploadedAt: now,
          lastUsedAt: now,
          keep: false,
          seq: 0,
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
          message.seq,
          viewport
        );
        if (result === undefined) {
          await sendTo(apiGw, connectionId, { type: "error", message: "Unknown assetId" });
          break;
        }
        // "stale" = a newer update already won for this asset (see
        // Asset.seq) -- silently drop rather than error or broadcast,
        // since this is a normal ordering artifact, not a client mistake.
        if (result === "stale") break;
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:moved",
          assetId: message.assetId,
          x: message.x,
          y: message.y,
          rotation: result.rotation,
          visible: result.visible,
          seq: message.seq,
        });
        break;
      }

      case "asset:resize": {
        const result = await resizeAsset(
          message.roomId,
          message.assetId,
          message.x,
          message.y,
          message.width,
          message.height,
          message.seq,
          viewport
        );
        if (result === undefined) {
          await sendTo(apiGw, connectionId, { type: "error", message: "Unknown assetId" });
          break;
        }
        if (result === "stale") break;
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:resized",
          assetId: message.assetId,
          x: message.x,
          y: message.y,
          width: message.width,
          height: message.height,
          visible: result.visible,
          seq: message.seq,
        });
        break;
      }

      case "asset:update": {
        const result = await updateAsset(message.roomId, message.assetId, message.patch, message.seq, viewport);
        if (result === undefined) {
          await sendTo(apiGw, connectionId, { type: "error", message: "Unknown assetId" });
          break;
        }
        if (result === "stale") break;
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:updated",
          assetId: message.assetId,
          patch: message.patch,
          visible: result.visible,
          seq: message.seq,
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

      case "room:setGlobalVolume": {
        await setGlobalVolume(message.roomId, message.globalVolume);
        await broadcastToRoom(apiGw, message.roomId, {
          type: "room:globalVolumeChanged",
          globalVolume: message.globalVolume,
        });
        break;
      }

      case "variable:set": {
        const variable: Variable = await setVariable(message.roomId, message.key, message.type, message.value);
        await broadcastToRoom(apiGw, message.roomId, { type: "variable:updated", variable });
        break;
      }

      case "variable:delete": {
        await deleteVariable(message.roomId, message.key);
        await broadcastToRoom(apiGw, message.roomId, { type: "variable:deleted", key: message.key });
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
