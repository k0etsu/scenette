import { AssetType } from "@scenette/protocol";

export interface UploadResult {
  assetId: string;
  s3Key: string;
  type: AssetType;
  width: number;
  height: number;
}

const DEFAULT_AUDIO_SIZE = { width: 200, height: 60 };
const FALLBACK_MEDIA_SIZE = { width: 320, height: 240 };
const METADATA_LOAD_TIMEOUT_MS = 4000;

export async function uploadFile(httpApiUrl: string, roomId: string, file: File): Promise<UploadResult> {
  const presignRes = await fetch(
    `${httpApiUrl}/assets/upload-url?roomId=${encodeURIComponent(roomId)}` +
      `&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type)}`
  );
  if (!presignRes.ok) {
    throw new Error(`Failed to get upload URL: ${presignRes.status} ${await presignRes.text()}`);
  }
  const { uploadUrl, s3Key, assetId, type } = (await presignRes.json()) as {
    uploadUrl: string;
    s3Key: string;
    assetId: string;
    type: AssetType;
  };

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload to S3 failed: ${putRes.status}`);
  }

  const { width, height } = await detectDimensions(file, type);
  return { assetId, s3Key, type, width, height };
}

// Best-effort — if the browser can't decode the file fast enough (or at
// all, e.g. a corrupt upload) this falls back to a reasonable default
// rather than blocking asset placement indefinitely.
async function detectDimensions(file: File, type: AssetType): Promise<{ width: number; height: number }> {
  if (type === "audio") return DEFAULT_AUDIO_SIZE;

  const objectUrl = URL.createObjectURL(file);
  try {
    if (type === "image" || type === "gif") {
      return await withTimeout(loadImageDimensions(objectUrl), FALLBACK_MEDIA_SIZE);
    }
    if (type === "video") {
      return await withTimeout(loadVideoDimensions(objectUrl), FALLBACK_MEDIA_SIZE);
    }
    return FALLBACK_MEDIA_SIZE;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = url;
  });
}

function loadVideoDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => reject(new Error("Failed to decode video"));
    video.src = url;
  });
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), METADATA_LOAD_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}
