export type AssetType = "image" | "gif" | "video" | "audio" | "text";

export interface Asset {
  roomId: string;
  assetId: string;
  type: AssetType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  visible: boolean;
  // Media assets reference their S3 object; text assets carry inline content instead.
  s3Key?: string;
  text?: string;
  uploadedAt: string;
  lastUsedAt?: string;
  keep: boolean;
}

export interface Viewport {
  roomId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
