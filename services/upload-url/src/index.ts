import type { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import * as dns from "dns/promises";
import * as net from "net";
import { AssetType } from "@scenette/protocol";
// Relative cross-service import -- see connect.ts's comment on the same
// pattern for why (accounts has no build step / compiled entry point for
// normal module resolution to find; esbuild bundles the TS source directly).
import { getSessionUsername, getMembership } from "../../accounts/src/store";
import { readSessionToken } from "../../accounts/src/cookies";
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

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function requireMember(
  event: Parameters<APIGatewayProxyHandlerV2>[0],
  roomId: string | undefined
): Promise<{ username: string } | APIGatewayProxyStructuredResultV2> {
  const token = readSessionToken(event);
  const username = token ? await getSessionUsername(token) : undefined;
  if (!username) return { statusCode: 401, body: "Invalid or missing session" };
  if (!roomId) return { statusCode: 400, body: "Missing roomId" };
  const membership = await getMembership(username, roomId);
  if (!membership) return { statusCode: 403, body: "Not a member of this room" };
  return { username };
}

function isMemberResult(
  result: { username: string } | APIGatewayProxyStructuredResultV2
): result is APIGatewayProxyStructuredResultV2 {
  return "statusCode" in result;
}

// A presigned PUT (unlike a presigned POST) can't carry a content-length
// condition, so there's no way to reject *this specific* upload up front
// based on its own size -- it isn't known until the client actually PUTs
// the file. Enforcement is therefore coarse: once a room's already-stored
// total is at or over quota, every further upload is refused outright,
// rather than trying to predict whether one more file would tip it over.
async function handlePresignUpload(
  event: Parameters<APIGatewayProxyHandlerV2>[0]
): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters ?? {};
  const { roomId, fileName, contentType } = params;

  const membership = await requireMember(event, roomId);
  if (isMemberResult(membership)) return membership;

  if (!fileName || !contentType) {
    return { statusCode: 400, body: "Missing fileName or contentType" };
  }

  const usedBytes = await sumRoomStorageBytes(roomId!);
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

  return json(200, { uploadUrl, s3Key, assetId, type });
}

// ---- Upload-by-pasted-URL (e.g. right-click "Copy image" on a page whose
// browser clipboard integration only offers a flattened static PNG, losing
// a GIF's animation -- see control-ui's paste handler). The Lambda fetches
// the URL itself and uploads the original bytes to S3, so the client never
// needs CORS access to the third-party host.

const MAX_FETCH_BYTES = 50 * 1024 * 1024; // Generous for a pasted image/gif/short clip.
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const EXTENSION_TO_TYPE: Record<string, "image" | "gif" | "video" | "audio"> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "gif",
  ".mp4": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
};

const CANONICAL_CONTENT_TYPE: Record<"image" | "gif" | "video" | "audio", string> = {
  image: "image/png",
  gif: "image/gif",
  video: "video/mp4",
  audio: "audio/mpeg",
};

// Blocks loopback/private/link-local/CGNAT ranges -- in particular
// 169.254.169.254, the cloud instance-metadata address, which is exactly
// the kind of target an SSRF-via-pasted-URL is trying to reach.
function isDisallowedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isDisallowedIp(lower.slice(7));
    return false;
  }
  return true; // Couldn't classify -- fail closed.
}

// Validates scheme/credentials and resolves+checks every A/AAAA record for
// the host. Re-run on every redirect hop by fetchExternalMedia below, since
// an open redirect on an otherwise-fine host could otherwise point the
// second request at an internal address after the first check passed.
async function resolveSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }
  if (url.username || url.password) {
    throw new Error("URL must not contain credentials");
  }
  const addresses = net.isIP(url.hostname)
    ? [url.hostname]
    : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isDisallowedIp)) {
    throw new Error("URL host is not allowed");
  }
  return url;
}

function inferAsset(contentType: string, url: URL): { type: "image" | "gif" | "video" | "audio"; contentType: string } | undefined {
  const normalized = contentType.split(";")[0]!.trim().toLowerCase();
  const mapped = CONTENT_TYPE_MAP[normalized];
  if (mapped && mapped !== "text" && mapped !== "clock") return { type: mapped, contentType: normalized };
  const ext = url.pathname.slice(url.pathname.lastIndexOf(".")).toLowerCase();
  const fallbackType = EXTENSION_TO_TYPE[ext];
  if (!fallbackType) return undefined;
  return { type: fallbackType, contentType: CANONICAL_CONTENT_TYPE[fallbackType] };
}

function fileNameFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  return last.length > 0 ? last : "pasted-file";
}

// Byte cap is enforced twice: against Content-Length up front (cheap,
// avoids even starting a huge download) and again while actually reading
// the stream (a lying/absent Content-Length can't be trusted alone).
async function fetchExternalMedia(rawUrl: string): Promise<{ bytes: Buffer; contentType: string; finalUrl: URL }> {
  let target = rawUrl;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) throw new Error("Too many redirects");
    const url = await resolveSafeUrl(target);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      target = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetching URL failed: ${res.status}`);

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > MAX_FETCH_BYTES) throw new Error("File is too large");
    if (!res.body) throw new Error("Empty response body");

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_FETCH_BYTES) throw new Error("File is too large");
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") ?? "", finalUrl: url };
  }
}

async function handleUploadFromUrl(
  event: Parameters<APIGatewayProxyHandlerV2>[0]
): Promise<APIGatewayProxyResultV2> {
  let body: { roomId?: string; url?: string };
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: "Invalid JSON body" };
  }
  const { roomId, url: sourceUrl } = body;

  const membership = await requireMember(event, roomId);
  if (isMemberResult(membership)) return membership;

  if (!sourceUrl) return { statusCode: 400, body: "Missing url" };

  const usedBytes = await sumRoomStorageBytes(roomId!);
  if (usedBytes >= ROOM_STORAGE_QUOTA_BYTES) {
    return {
      statusCode: 413,
      body: `Storage quota exceeded for this room (${usedBytes} / ${ROOM_STORAGE_QUOTA_BYTES} bytes used)`,
    };
  }

  let fetched: Awaited<ReturnType<typeof fetchExternalMedia>>;
  try {
    fetched = await fetchExternalMedia(sourceUrl);
  } catch (err) {
    return json(400, { error: `Could not fetch that URL: ${err instanceof Error ? err.message : String(err)}` });
  }

  const asset = inferAsset(fetched.contentType, fetched.finalUrl);
  if (!asset) {
    return json(400, { error: `Unrecognized media type${fetched.contentType ? `: ${fetched.contentType}` : ""}` });
  }

  const assetId = randomUUID();
  const safeFileName = fileNameFromUrl(fetched.finalUrl)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 200);
  const s3Key = `${roomId}/${assetId}/${safeFileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: s3Key,
      Body: fetched.bytes,
      ContentType: asset.contentType,
    })
  );

  return json(200, { assetId, s3Key, type: asset.type });
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  switch (event.routeKey) {
    case "GET /assets/upload-url":
      return handlePresignUpload(event);
    case "POST /assets/upload-from-url":
      return handleUploadFromUrl(event);
    default:
      return { statusCode: 404, body: "Unknown route" };
  }
};
