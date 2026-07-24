import { Asset, AssetType } from "./asset";

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
  };
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

export type ClientMessage =
  | SnapshotRequestMessage
  | AssetAddMessage
  | AssetMoveMessage
  | AssetResizeMessage
  | AssetDeleteMessage;

// ---- Server -> client (broadcast or direct reply) ----

export type ServerMessage =
  | { type: "room:snapshot"; assets: Asset[]; viewport: { x: number; y: number; width: number; height: number } }
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
  | { type: "asset:deleted"; assetId: string }
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

    case "asset:delete": {
      if (typeof msg.assetId !== "string") throw new Error("Missing assetId");
      return { action: "asset:delete", roomId: msg.roomId, assetId: msg.assetId };
    }

    default:
      throw new Error(`Unknown action: ${String(msg.action)}`);
  }
}

function isAssetType(value: unknown): value is AssetType {
  return value === "image" || value === "gif" || value === "video" || value === "audio" || value === "text";
}
