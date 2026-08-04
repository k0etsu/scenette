import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Asset, Variable, intersects, parseClientMessage } from "@scenette/protocol";
import { getConnectionInfo, sendTo, broadcastToRoom, listPresence } from "./connections";
import {
  getOrCreateRoom,
  listAssets,
  getAsset,
  putAsset,
  moveAsset,
  resizeAsset,
  updateAsset,
  deleteAsset,
  isS3KeyReferencedElsewhere,
  setGlobalVolume,
  setStreamPreviewSettings,
  setVariable,
  deleteVariable,
} from "./roomState";

const s3 = new S3Client({});
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;

// Server-verified rather than trusting whatever the client claims -- the
// client already awaited its own PUT to this exact key before sending
// asset:add, so this HeadObject should always hit. Best-effort: a failure
// here (S3 hiccup) shouldn't block placing the asset, it just means this
// one asset doesn't count toward the room's storage quota until corrected
// some other way.
async function fetchFileSize(s3Key: string): Promise<number | undefined> {
  try {
    const { ContentLength } = await s3.send(new HeadObjectCommand({ Bucket: ASSETS_BUCKET, Key: s3Key }));
    return ContentLength;
  } catch {
    return undefined;
  }
}

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const apiGw = new ApiGatewayManagementApiClient({
    // Execute-api callback URL, not the (possibly custom) domainName -- see
    // connect.ts for why.
    endpoint: process.env.WS_CALLBACK_URL ?? `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });

  try {
    const message = parseClientMessage(event.body ?? "");

    // A connection only ever operates on the room it registered with at
    // $connect — reject anything else rather than trusting the client's
    // claimed roomId for lookups that matter (broadcast fan-out, etc).
    const connection = await getConnectionInfo(connectionId);
    if (!connection || connection.roomId !== message.roomId) {
      await sendTo(apiGw, connectionId, { type: "error", message: "Not connected to this room" });
      return { statusCode: 200, body: "OK" };
    }

    // connect.ts already verified membership for any connection that has a
    // username (an anonymous browser-source connection never gets one) --
    // so a missing username here means this connection is read-only and
    // must never reach a mutating action, regardless of what it claims.
    if (!connection.username && message.action !== "room:snapshot:request") {
      await sendTo(apiGw, connectionId, { type: "error", message: "This connection is read-only" });
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
          globalVolumeSeq: room.globalVolumeSeq,
          streamPreviewSettings: room.streamPreviewSettings,
          streamPreviewSettingsSeq: room.streamPreviewSettingsSeq,
          variables: Object.values(room.variables),
          presence,
        });
        break;
      }

      case "asset:add": {
        // The upload flow only ever mints keys under `${roomId}/` (see
        // services/upload-url), so a client-supplied s3Key pointing outside
        // this room's prefix is either a bug or an attempt to attach (and,
        // via a later asset:delete, destroy) another room's media. Reject it
        // rather than HeadObject/store/broadcast an arbitrary key.
        if (message.asset.s3Key && !message.asset.s3Key.startsWith(`${message.roomId}/`)) {
          await sendTo(apiGw, connectionId, { type: "error", message: "Invalid asset key" });
          return { statusCode: 200, body: "OK" };
        }
        const now = new Date().toISOString();
        const hidden = message.asset.hidden ?? false;
        const fileSize = message.asset.s3Key ? await fetchFileSize(message.asset.s3Key) : undefined;
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
          name: message.asset.name,
          fontFamily: message.asset.fontFamily,
          fontSize: message.asset.fontSize,
          fontWeight: message.asset.fontWeight,
          textAlign: message.asset.textAlign,
          textColor: message.asset.textColor,
          backgroundColor: message.asset.backgroundColor,
          backgroundAlpha: message.asset.backgroundAlpha,
          shadowEnabled: message.asset.shadowEnabled,
          shadowX: message.asset.shadowX,
          shadowY: message.asset.shadowY,
          shadowBlur: message.asset.shadowBlur,
          shadowColor: message.asset.shadowColor,
          outlineEnabled: message.asset.outlineEnabled,
          outlineColor: message.asset.outlineColor,
          outlineWidth: message.asset.outlineWidth,
          fileSize,
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
        const existing = await getAsset(message.roomId, message.assetId);
        await deleteAsset(message.roomId, message.assetId);
        // Only physically delete the S3 object once nothing else still
        // points at it -- duplicateAsset() (control-ui) can leave a second
        // asset row referencing the same s3Key, and deleting the object out
        // from under that still-live duplicate would silently break it.
        if (existing?.s3Key && !(await isS3KeyReferencedElsewhere(message.roomId, existing.s3Key, message.assetId))) {
          await s3.send(new DeleteObjectCommand({ Bucket: ASSETS_BUCKET, Key: existing.s3Key })).catch((err) => {
            // Best-effort -- the asset is already gone from the room either
            // way; a stray S3 object left behind is a retention-job cleanup
            // problem, not a reason to fail this delete for the user.
            console.error("Failed to delete S3 object on asset delete", err);
          });
        }
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:deleted",
          assetId: message.assetId,
        });
        break;
      }

      // Pure relay, no DB write at all -- see AssetStopMessage's protocol
      // doc comment for why playback position is never persisted, only
      // broadcast live to whoever's connected right now.
      case "asset:stop": {
        await broadcastToRoom(apiGw, message.roomId, {
          type: "asset:stopped",
          assetId: message.assetId,
        });
        break;
      }

      case "room:setGlobalVolume": {
        const result = await setGlobalVolume(message.roomId, message.globalVolume, message.seq);
        // "stale" = a newer update already won (see Room.globalVolumeSeq) --
        // silently drop rather than broadcast a value that's already been
        // superseded locally on the sender's own slider.
        if (result === "stale") break;
        await broadcastToRoom(apiGw, message.roomId, {
          type: "room:globalVolumeChanged",
          globalVolume: message.globalVolume,
          seq: message.seq,
        });
        break;
      }

      // Room-scoped, owner-only (see StreamPreviewSettings's protocol doc
      // comment) -- `connection.role` is denormalized onto the connection
      // row at $connect from the membership table (see connect.ts), so this
      // needs no MembershipsTable access of its own.
      case "room:setStreamPreviewSettings": {
        if (connection.role !== "owner") {
          await sendTo(apiGw, connectionId, {
            type: "error",
            message: "Only the room owner can change the stream preview settings",
          });
          break;
        }
        const result = await setStreamPreviewSettings(message.roomId, message.settings, message.seq);
        if (result === "stale") break;
        await broadcastToRoom(apiGw, message.roomId, {
          type: "room:streamPreviewSettingsChanged",
          settings: message.settings,
          seq: message.seq,
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
