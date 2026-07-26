import { Asset, AssetType } from "./asset";
import { Variable, VariableType } from "./variables";

// ---- Client -> server (sent over the $default WebSocket route) ----

export interface SnapshotRequestMessage {
  action: "room:snapshot:request";
  roomId: string;
}

export interface AssetAddMessage {
  action: "asset:add";
  roomId: string;
  asset: {
    assetId: string;
    type: AssetType;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    zIndex?: number;
    s3Key?: string;
    text?: string;
    // Optional so a plain new upload/text-add can omit them (server
    // defaults apply) while a client-side "duplicate" can carry over the
    // source asset's full styling/playback state in one message.
    opacity?: number;
    blur?: number;
    flipX?: boolean;
    flipY?: boolean;
    locked?: boolean;
    hidden?: boolean;
    loop?: boolean;
    muted?: boolean;
    volume?: number;
    paused?: boolean;
  };
}

// Patch-style: only changed fields are sent/applied, covering every asset
// property that isn't part of the specialized (high-frequency, throttled)
// move/resize messages. Kept as one generic message rather than one per
// control (opacity, blur, flip, lock, loop, mute, volume, pause, text edit)
// since these are all occasional, low-frequency edits with identical
// handling needs.
export interface AssetPatch {
  text?: string;
  hidden?: boolean;
  locked?: boolean;
  opacity?: number;
  blur?: number;
  flipX?: boolean;
  flipY?: boolean;
  zIndex?: number;
  rotation?: number;
  loop?: boolean;
  muted?: boolean;
  volume?: number;
  paused?: boolean;
}

export interface AssetUpdateMessage {
  action: "asset:update";
  roomId: string;
  assetId: string;
  patch: AssetPatch;
  seq: number;
}

export interface AssetMoveMessage {
  action: "asset:move";
  roomId: string;
  assetId: string;
  x: number;
  y: number;
  rotation?: number;
  // See Asset.seq — a client-assigned monotonic counter so the server (and
  // every downstream receiver) can reject anything older than what's
  // already been applied, regardless of network/Lambda delivery order.
  seq: number;
}

// Carries x/y alongside width/height (not just a size delta) because
// dragging the NW/NE/SW corners of a selection changes the asset's position
// as well as its dimensions — only the SE corner leaves x/y untouched.
export interface AssetResizeMessage {
  action: "asset:resize";
  roomId: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  seq: number;
}

export interface AssetDeleteMessage {
  action: "asset:delete";
  roomId: string;
  assetId: string;
}

// Global volume is a room-level master multiplier applied on top of each
// asset's own volume, broadcast to every client (control-ui AND
// browser-source) -- it's what viewers actually hear. Local volume (see
// control-ui's sound.ts) is a separate, purely client-side multiplier layered
// on top of that for the person sitting at the control UI, so they can turn
// their own monitoring up/down without affecting the stream -- it's never
// sent over the wire at all, hence no message type for it here.
export interface RoomSetGlobalVolumeMessage {
  action: "room:setGlobalVolume";
  roomId: string;
  globalVolume: number;
}

// Upsert -- covers both creating a new variable and editing an existing
// one's value/type (key is immutable once created; renaming means
// delete + re-create).
export interface VariableSetMessage {
  action: "variable:set";
  roomId: string;
  key: string;
  type: VariableType;
  value: string;
}

export interface VariableDeleteMessage {
  action: "variable:delete";
  roomId: string;
  key: string;
}

export type ClientMessage =
  | SnapshotRequestMessage
  | AssetAddMessage
  | AssetMoveMessage
  | AssetResizeMessage
  | AssetUpdateMessage
  | AssetDeleteMessage
  | RoomSetGlobalVolumeMessage
  | VariableSetMessage
  | VariableDeleteMessage;

// ---- Server -> client (broadcast or direct reply) ----

// One entry per connected control-ui session (not per unique account -- the
// same account open in two tabs shows as two rows, matching what's actually
// connected rather than deduplicating identity). Anonymous browser-source
// connections never appear here at all -- see connect.ts, which only
// attaches a username when a valid session token was presented.
export interface PresenceEntry {
  username: string;
  connectedAt: string;
}

export type ServerMessage =
  | {
      type: "room:snapshot";
      assets: Asset[];
      viewport: { x: number; y: number; width: number; height: number };
      globalVolume: number;
      variables: Variable[];
      presence: PresenceEntry[];
    }
  | { type: "asset:added"; asset: Asset }
  | {
      type: "asset:moved";
      assetId: string;
      x: number;
      y: number;
      rotation: number;
      visible: boolean;
      seq: number;
    }
  | {
      type: "asset:resized";
      assetId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      visible: boolean;
      seq: number;
    }
  | { type: "asset:updated"; assetId: string; patch: AssetPatch; visible: boolean; seq: number }
  | { type: "asset:deleted"; assetId: string }
  | { type: "room:globalVolumeChanged"; globalVolume: number }
  | { type: "variable:updated"; variable: Variable }
  | { type: "variable:deleted"; key: string }
  | { type: "presence:joined"; entry: PresenceEntry }
  // connectedAt (not just username) disambiguates which of two same-account
  // sessions (e.g. the same user open in two tabs) left, so the other stays
  // listed -- username alone can't tell them apart.
  | { type: "presence:left"; username: string; connectedAt: string }
  | { type: "error"; message: string };

// Untrusted input arrives as raw JSON off the wire — validate the shape
// before trusting any field, per this project's system-boundary rule.
export function parseClientMessage(raw: string): ClientMessage {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Malformed JSON");
  }

  if (typeof body !== "object" || body === null || !("action" in body)) {
    throw new Error("Missing action");
  }

  const msg = body as Record<string, unknown>;
  if (typeof msg.roomId !== "string" || msg.roomId.length === 0) {
    throw new Error("Missing roomId");
  }

  switch (msg.action) {
    case "room:snapshot:request":
      return { action: "room:snapshot:request", roomId: msg.roomId };

    case "asset:add": {
      const asset = msg.asset as Record<string, unknown> | undefined;
      if (!asset || typeof asset !== "object") throw new Error("Missing asset");
      if (typeof asset.assetId !== "string") throw new Error("Missing asset.assetId");
      if (!isAssetType(asset.type)) throw new Error("Invalid asset.type");
      for (const key of ["x", "y", "width", "height"] as const) {
        if (typeof asset[key] !== "number") throw new Error(`Missing/invalid asset.${key}`);
      }
      return {
        action: "asset:add",
        roomId: msg.roomId,
        asset: {
          assetId: asset.assetId,
          type: asset.type,
          x: asset.x as number,
          y: asset.y as number,
          width: asset.width as number,
          height: asset.height as number,
          rotation: typeof asset.rotation === "number" ? asset.rotation : undefined,
          zIndex: typeof asset.zIndex === "number" ? asset.zIndex : undefined,
          s3Key: typeof asset.s3Key === "string" ? asset.s3Key : undefined,
          text: typeof asset.text === "string" ? asset.text : undefined,
          opacity: typeof asset.opacity === "number" ? asset.opacity : undefined,
          blur: typeof asset.blur === "number" ? asset.blur : undefined,
          flipX: typeof asset.flipX === "boolean" ? asset.flipX : undefined,
          flipY: typeof asset.flipY === "boolean" ? asset.flipY : undefined,
          locked: typeof asset.locked === "boolean" ? asset.locked : undefined,
          hidden: typeof asset.hidden === "boolean" ? asset.hidden : undefined,
          loop: typeof asset.loop === "boolean" ? asset.loop : undefined,
          muted: typeof asset.muted === "boolean" ? asset.muted : undefined,
          volume: typeof asset.volume === "number" ? asset.volume : undefined,
          paused: typeof asset.paused === "boolean" ? asset.paused : undefined,
        },
      };
    }

    case "asset:move": {
      if (typeof msg.assetId !== "string") throw new Error("Missing assetId");
      if (typeof msg.x !== "number" || typeof msg.y !== "number") throw new Error("Missing x/y");
      if (typeof msg.seq !== "number") throw new Error("Missing seq");
      return {
        action: "asset:move",
        roomId: msg.roomId,
        assetId: msg.assetId,
        x: msg.x,
        y: msg.y,
        rotation: typeof msg.rotation === "number" ? msg.rotation : undefined,
        seq: msg.seq,
      };
    }

    case "asset:resize": {
      if (typeof msg.assetId !== "string") throw new Error("Missing assetId");
      for (const key of ["x", "y", "width", "height", "seq"] as const) {
        if (typeof msg[key] !== "number") throw new Error(`Missing/invalid ${key}`);
      }
      return {
        action: "asset:resize",
        roomId: msg.roomId,
        assetId: msg.assetId,
        x: msg.x as number,
        y: msg.y as number,
        width: msg.width as number,
        height: msg.height as number,
        seq: msg.seq as number,
      };
    }

    case "asset:update": {
      if (typeof msg.assetId !== "string") throw new Error("Missing assetId");
      if (typeof msg.seq !== "number") throw new Error("Missing seq");
      const rawPatch = msg.patch as Record<string, unknown> | undefined;
      if (!rawPatch || typeof rawPatch !== "object") throw new Error("Missing patch");

      const patch: AssetPatch = {};
      if (typeof rawPatch.text === "string") patch.text = rawPatch.text;
      if (typeof rawPatch.hidden === "boolean") patch.hidden = rawPatch.hidden;
      if (typeof rawPatch.locked === "boolean") patch.locked = rawPatch.locked;
      if (typeof rawPatch.opacity === "number") patch.opacity = rawPatch.opacity;
      if (typeof rawPatch.blur === "number") patch.blur = rawPatch.blur;
      if (typeof rawPatch.flipX === "boolean") patch.flipX = rawPatch.flipX;
      if (typeof rawPatch.flipY === "boolean") patch.flipY = rawPatch.flipY;
      if (typeof rawPatch.zIndex === "number") patch.zIndex = rawPatch.zIndex;
      if (typeof rawPatch.rotation === "number") patch.rotation = rawPatch.rotation;
      if (typeof rawPatch.loop === "boolean") patch.loop = rawPatch.loop;
      if (typeof rawPatch.muted === "boolean") patch.muted = rawPatch.muted;
      if (typeof rawPatch.volume === "number") patch.volume = rawPatch.volume;
      if (typeof rawPatch.paused === "boolean") patch.paused = rawPatch.paused;
      if (Object.keys(patch).length === 0) throw new Error("Empty patch");

      return { action: "asset:update", roomId: msg.roomId, assetId: msg.assetId, patch, seq: msg.seq };
    }

    case "asset:delete": {
      if (typeof msg.assetId !== "string") throw new Error("Missing assetId");
      return { action: "asset:delete", roomId: msg.roomId, assetId: msg.assetId };
    }

    case "room:setGlobalVolume": {
      if (typeof msg.globalVolume !== "number") throw new Error("Missing/invalid globalVolume");
      return { action: "room:setGlobalVolume", roomId: msg.roomId, globalVolume: msg.globalVolume };
    }

    case "variable:set": {
      if (typeof msg.key !== "string" || msg.key.length === 0) throw new Error("Missing key");
      if (!isVariableType(msg.type)) throw new Error("Invalid type");
      if (typeof msg.value !== "string") throw new Error("Missing/invalid value");
      return { action: "variable:set", roomId: msg.roomId, key: msg.key, type: msg.type, value: msg.value };
    }

    case "variable:delete": {
      if (typeof msg.key !== "string" || msg.key.length === 0) throw new Error("Missing key");
      return { action: "variable:delete", roomId: msg.roomId, key: msg.key };
    }

    default:
      throw new Error(`Unknown action: ${String(msg.action)}`);
  }
}

function isAssetType(value: unknown): value is AssetType {
  return value === "image" || value === "gif" || value === "video" || value === "audio" || value === "text";
}

function isVariableType(value: unknown): value is VariableType {
  return value === "number" || value === "text";
}
