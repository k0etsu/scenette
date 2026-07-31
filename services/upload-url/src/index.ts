import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { AssetType } from "@scenette/protocol";
// Relative cross-service import -- see connect.ts's comment on the same
// pattern for why (accounts has no build step / compiled entry point for
// normal module resolution to find; esbuild bundles the TS source directly).
import { getSessionUsername, getMembership } from "../../accounts/src/store";

const s3 = new S3Client({});
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;
const URL_EXPIRY_SECONDS = 300;

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

// TODO: the plan calls for a per-room storage quota; nothing enforces one
// yet — a presigned PUT (unlike a presigned POST) can't carry a
// content-length condition, so quota enforcement needs to happen as a
// separate check against a running per-room usage total, not as part of
// this URL itself.
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
