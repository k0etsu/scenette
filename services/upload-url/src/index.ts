import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { AssetType } from "@scenette/protocol";
// Relative cross-service import -- see connect.ts's comment on the same
// pattern for why (accounts has no build step / compiled entry point for
// normal module resolution to find; esbuild bundles the TS source directly).
import { getSessionUsername, getMembership } from "../../accounts/src/store";
// Same cross-service pattern -- reuses the byte-accounting logic message.ts
// already needs (server-verified file sizes, deduped by s3Key so a
// duplicateAsset() doesn't double-count) rather than re-implementing it here.
import { sumRoomStorageBytes } from "../../websocket-handlers/src/roomState";

// requestChecksumCalculation defaults to "WHEN_SUPPORTED" as of a recent
// SDK version, which makes PutObjectCommand -- including one only ever
// used to *presign* a URL, never to actually send a request itself --
// bake x-amz-checksum-crc32/x-amz-sdk-checksum-algorithm into the signed
// query string. A real browser's plain `fetch(uploadUrl, { method: "PUT",
// body: file })` (see control-ui's upload.ts) never computes or sends a
// matching checksum, so every presigned URL minted without this override
// gets rejected by S3 ("headers present which were not signed" / 501,
// depending on exactly what's attempted) -- uploads were broken outright.
// "WHEN_REQUIRED" restores the pre-default behavior: only compute/require
// a checksum when a command explicitly asks for one via ChecksumAlgorithm.
const s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;
const URL_EXPIRY_SECONDS = 300;
const ROOM_STORAGE_QUOTA_BYTES = Number(process.env.ROOM_STORAGE_QUOTA_BYTES!);

// image/gif share a content-type prefix but are distinct asset types (gifs
// need loop/no-controls handling downstream) — keep gif as its own explicit
// mapping rather than folding it into the image/* prefix check.
const CONTENT_TYPE_MAP: Record<string, AssetType> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "gif",
  "video/mp4": "video",
  "video/webm": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
};

// A presigned PUT (unlike a presigned POST) can't carry a content-length
// condition, so there's no way to reject *this specific* upload up front
// based on its own size -- it isn't known until the client actually PUTs
// the file. Enforcement is therefore coarse: once a room's already-stored
// total is at or over quota, every further upload is refused outright,
// rather than trying to predict whether one more file would tip it over.
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const params = event.queryStringParameters ?? {};
  const { roomId, fileName, contentType } = params;

  if (!roomId || !fileName || !contentType) {
    return { statusCode: 400, body: "Missing roomId, fileName, or contentType" };
  }

  const auth = event.headers?.authorization ?? event.headers?.Authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  const username = token ? await getSessionUsername(token) : undefined;
  if (!username) {
    return { statusCode: 401, body: "Invalid or missing session" };
  }
  const membership = await getMembership(username, roomId);
  if (!membership) {
    return { statusCode: 403, body: "Not a member of this room" };
  }

  const usedBytes = await sumRoomStorageBytes(roomId);
  if (usedBytes >= ROOM_STORAGE_QUOTA_BYTES) {
    return {
      statusCode: 413,
      body: `Storage quota exceeded for this room (${usedBytes} / ${ROOM_STORAGE_QUOTA_BYTES} bytes used)`,
    };
  }

  const type = CONTENT_TYPE_MAP[contentType];
  if (!type) {
    return { statusCode: 400, body: `Unsupported contentType: ${contentType}` };
  }

  const assetId = randomUUID();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  const s3Key = `${roomId}/${assetId}/${safeFileName}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: ASSETS_BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: URL_EXPIRY_SECONDS }
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadUrl, s3Key, assetId, type }),
  };
};
