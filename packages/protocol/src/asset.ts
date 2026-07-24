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
  // Monotonically increasing per-client counter attached to every move/resize.
  // WebSocket messages for rapid successive edits aren't guaranteed to be
  // processed/delivered in order (separate Lambda invocations per message,
  // no ordering guarantee across them) -- without this, an out-of-order
  // arrival visibly renders a stale intermediate position, which looks like
  // the drag "replaying" itself. Both the server (conditional write) and
  // every receiving client (compares against the last-applied seq) reject
  // anything not strictly newer than what's already been applied.
  seq: number;
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
