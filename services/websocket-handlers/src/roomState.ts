import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Asset, AssetPatch, Variable, VariableType, Viewport, intersects } from "@scenette/protocol";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;

// v1 has no room-creation flow yet (that lands with the control-ui/auth
// work) — a room is lazily created on first use with a default 1080p
// viewport at the origin. TODO(v1): replace with an explicit create-room
// step once accounts/ownership exist.
const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1920, height: 1080 };

export interface Room extends Viewport {
  // Master multiplier broadcast to every client (control-ui AND
  // browser-source) -- distinct from control-ui's own purely-local volume
  // knob, which never touches the server at all.
  globalVolume: number;
  // Same rationale as Asset.seq -- the global-volume slider fires on every
  // drag tick, each a separate message/Lambda invocation with no ordering
  // guarantee, so this guards against an earlier-sent-but-later-processed
  // tick's write clobbering a later tick's already-applied value.
  globalVolumeSeq: number;
  variables: Record<string, Variable>;
}

export async function getOrCreateRoom(roomId: string): Promise<Room> {
  const { Item } = await ddb.send(new GetCommand({ TableName: ROOMS_TABLE, Key: { roomId } }));
  if (Item) {
    return {
      roomId,
      x: Item.x,
      y: Item.y,
      width: Item.width,
      height: Item.height,
      globalVolume: Item.globalVolume ?? 1,
      globalVolumeSeq: Item.globalVolumeSeq ?? 0,
      variables: Item.variables ?? {},
    };
  }

  const room: Room = { roomId, ...DEFAULT_VIEWPORT, globalVolume: 1, globalVolumeSeq: 0, variables: {} };
  await ddb.send(
    new PutCommand({
      TableName: ROOMS_TABLE,
      Item: { ...room, createdAt: new Date().toISOString() },
      ConditionExpression: "attribute_not_exists(roomId)",
    })
  ).catch((err: unknown) => {
    // Lost a race with another client creating the same room concurrently — fine, it exists now.
    if (!(err instanceof Error && err.name === "ConditionalCheckFailedException")) throw err;
  });

  return room;
}

export async function setGlobalVolume(roomId: string, globalVolume: number, seq: number): Promise<"stale" | undefined> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ROOMS_TABLE,
        Key: { roomId },
        UpdateExpression: "SET globalVolume = :v, globalVolumeSeq = :seq",
        ConditionExpression: "attribute_not_exists(globalVolumeSeq) OR globalVolumeSeq < :seq",
        ExpressionAttributeValues: { ":v": globalVolume, ":seq": seq },
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return "stale";
    throw err;
  }
  return undefined;
}

// Upsert: creates a new variable, or edits an existing one's value/type
// (its createdAt is preserved across edits, so the list order the sidebar
// sorts by doesn't reshuffle every time someone bumps a counter).
export async function setVariable(
  roomId: string,
  key: string,
  type: VariableType,
  value: string
): Promise<Variable> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: ROOMS_TABLE, Key: { roomId }, ProjectionExpression: "variables" })
  );
  const existing = Item?.variables?.[key] as Variable | undefined;
  const variable: Variable = { key, type, value, createdAt: existing?.createdAt ?? new Date().toISOString() };

  await ddb.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET variables.#key = :v",
      ExpressionAttributeNames: { "#key": key },
      ExpressionAttributeValues: { ":v": variable },
    })
  );
  return variable;
}

export async function deleteVariable(roomId: string, key: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "REMOVE variables.#key",
      ExpressionAttributeNames: { "#key": key },
    })
  );
}

export async function listAssets(roomId: string): Promise<Asset[]> {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: ASSETS_TABLE,
      KeyConditionExpression: "roomId = :roomId",
      ExpressionAttributeValues: { ":roomId": roomId },
    })
  );
  return Items as Asset[];
}

export async function getAsset(roomId: string, assetId: string): Promise<Asset | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: ASSETS_TABLE, Key: { roomId, assetId } })
  );
  return Item as Asset | undefined;
}

export async function putAsset(asset: Asset): Promise<void> {
  await ddb.send(new PutCommand({ TableName: ASSETS_TABLE, Item: asset }));
}

export async function moveAsset(
  roomId: string,
  assetId: string,
  x: number,
  y: number,
  rotation: number | undefined,
  seq: number,
  viewport: Viewport
): Promise<{ visible: boolean; rotation: number } | "stale" | undefined> {
  const existing = await getAsset(roomId, assetId);
  if (!existing) return undefined;

  const nextRotation = rotation ?? existing.rotation;
  const visible =
    intersects({ x, y, width: existing.width, height: existing.height }, viewport) && !existing.hidden;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { roomId, assetId },
        UpdateExpression:
          "SET #x = :x, #y = :y, rotation = :rotation, visible = :visible, lastUsedAt = :now, seq = :seq",
        // Rejects the write outright if a newer (or equal) seq has already
        // been applied -- an atomic guard against a message that arrived
        // late (WebSocket delivery/Lambda invocation order isn't
        // guaranteed) overwriting a position a client has already moved
        // past. See Asset.seq for the full rationale.
        ConditionExpression: "attribute_not_exists(seq) OR seq < :seq",
        ExpressionAttributeNames: { "#x": "x", "#y": "y" },
        ExpressionAttributeValues: {
          ":x": x,
          ":y": y,
          ":rotation": nextRotation,
          ":visible": visible,
          ":now": new Date().toISOString(),
          ":seq": seq,
        },
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return "stale";
    throw err;
  }

  return { visible, rotation: nextRotation };
}

export async function resizeAsset(
  roomId: string,
  assetId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  seq: number,
  viewport: Viewport
): Promise<{ visible: boolean } | "stale" | undefined> {
  const existing = await getAsset(roomId, assetId);
  if (!existing) return undefined;

  const visible = intersects({ x, y, width, height }, viewport) && !existing.hidden;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { roomId, assetId },
        UpdateExpression:
          "SET #x = :x, #y = :y, width = :width, height = :height, visible = :visible, lastUsedAt = :now, seq = :seq",
        ConditionExpression: "attribute_not_exists(seq) OR seq < :seq",
        ExpressionAttributeNames: { "#x": "x", "#y": "y" },
        ExpressionAttributeValues: {
          ":x": x,
          ":y": y,
          ":width": width,
          ":height": height,
          ":visible": visible,
          ":now": new Date().toISOString(),
          ":seq": seq,
        },
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return "stale";
    throw err;
  }

  return { visible };
}

// Generic patch path for every asset property outside the specialized,
// high-frequency move/resize messages (text content, hidden/locked flags,
// opacity/blur/flip, z-index, rotation, and video/audio playback state).
// Builds its SET clause dynamically from whatever keys are present in
// `patch` rather than needing a dedicated function per property.
export async function updateAsset(
  roomId: string,
  assetId: string,
  patch: AssetPatch,
  seq: number,
  viewport: Viewport
): Promise<{ visible: boolean } | "stale" | undefined> {
  const existing = await getAsset(roomId, assetId);
  if (!existing) return undefined;

  const nextHidden = patch.hidden ?? existing.hidden;
  const visible = intersects(existing, viewport) && !nextHidden;

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":visible": visible,
    ":now": new Date().toISOString(),
    ":seq": seq,
  };
  const setClauses = ["visible = :visible", "lastUsedAt = :now", "seq = :seq"];

  for (const [key, value] of Object.entries(patch)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    setClauses.push(`#${key} = :${key}`);
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ASSETS_TABLE,
        Key: { roomId, assetId },
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ConditionExpression: "attribute_not_exists(seq) OR seq < :seq",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return "stale";
    throw err;
  }

  return { visible };
}

export async function deleteAsset(roomId: string, assetId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ASSETS_TABLE, Key: { roomId, assetId } }));
}

// Sums each *distinct* S3 object's size once, not once per asset row --
// duplicateAsset() (see control-ui) creates a second row that reuses the
// original's s3Key rather than a fresh S3 upload, so counting both rows
// would overstate how many bytes this room is actually costing to store.
export async function sumRoomStorageBytes(roomId: string): Promise<number> {
  const assets = await listAssets(roomId);
  const bytesByS3Key = new Map<string, number>();
  for (const asset of assets) {
    if (asset.s3Key && asset.fileSize) bytesByS3Key.set(asset.s3Key, asset.fileSize);
  }
  return [...bytesByS3Key.values()].reduce((sum, bytes) => sum + bytes, 0);
}

// Whether any OTHER asset in the room still points at this S3 object --
// used before physically deleting it, since two assets can share one
// s3Key (see duplicateAsset()) and deleting the object out from under a
// still-live duplicate would break its playback with no warning.
export async function isS3KeyReferencedElsewhere(
  roomId: string,
  s3Key: string,
  excludeAssetId: string
): Promise<boolean> {
  const assets = await listAssets(roomId);
  return assets.some((a) => a.assetId !== excludeAssetId && a.s3Key === s3Key);
}
