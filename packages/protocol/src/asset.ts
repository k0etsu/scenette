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
  // Final, server-computed "should this actually render" flag — the AND of
  // geometric intersection with the viewport AND the manual `hidden`
  // override below. Consumers (browser-source, other clients) only ever
  // need to check this one field, never intersects() themselves.
  visible: boolean;
  // Manual show/hide independent of position — lets a streamer stash
  // something without moving it out of the viewport. Layered on top of,
  // not instead of, the original pure-geometry visibility model.
  hidden: boolean;
  // Prevents drag/resize via mouse. Editing via the properties panel is
  // still allowed -- this only guards the canvas mouse interactions.
  locked: boolean;
  opacity: number; // 0-1
  blur: number; // px, 0 = none
  flipX: boolean;
  flipY: boolean;
  // Playback state for video/audio assets only; ignored for other types.
  loop: boolean;
  muted: boolean;
  volume: number; // 0-1
  paused: boolean;
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
