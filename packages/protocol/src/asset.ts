import { ClockFields } from "./clock";

export type AssetType = "image" | "gif" | "video" | "audio" | "text" | "clock" | "youtube";

// Clock-type assets additionally carry the ClockFields (mode/target/timezone/
// etc., all optional) -- they're ignored for every other type, exactly like
// the text-style fields below.
export interface Asset extends ClockFields {
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
  // youtube assets only: the parsed 11-character YouTube video ID (not a
  // raw URL) -- set once at creation (see extractYoutubeVideoId), never
  // patched in place. Deterministically rebuilds the embed URL client-side
  // rather than trusting a stored URL that could point anywhere.
  youtubeVideoId?: string;
  // User-assigned label shown in the objects list/properties header, purely
  // for finding the asset in a busy room -- distinct from `text` (a text
  // asset's own rendered content). Falls back to a derived label (filename,
  // truncated text, or the raw assetId) when unset.
  name?: string;
  // Text-asset styling -- ignored for every other asset type. All optional
  // so existing rooms' stored assets (and a plain asset:add with no
  // overrides) fall back to the CANVAS/BROWSER_SOURCE-shared defaults in
  // textStyle.ts rather than needing a migration.
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  textAlign?: "left" | "center" | "right";
  textColor?: string;
  backgroundColor?: string;
  backgroundAlpha?: number; // 0-1
  shadowEnabled?: boolean;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  outlineEnabled?: boolean;
  outlineColor?: string;
  outlineWidth?: number;
  // Bytes, server-verified via an S3 HeadObject right after asset:add (see
  // message.ts) rather than trusted from the client -- used to enforce the
  // per-room storage quota (see upload-url). Absent for text assets and for
  // any asset added before this field existed.
  fileSize?: number;
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
