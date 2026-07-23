import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { Asset, Viewport, intersects } from "@scenette/protocol";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;

// v1 has no room-creation flow yet (that lands with the control-ui/auth
// work) — a room is lazily created on first use with a default 1080p
// viewport at the origin. TODO(v1): replace with an explicit create-room
// step once accounts/ownership exist.
const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1920, height: 1080 };

export async function getOrCreateViewport(roomId: string): Promise<Viewport> {
  const { Item } = await ddb.send(new GetCommand({ TableName: ROOMS_TABLE, Key: { roomId } }));
  if (Item) {
    return { roomId, x: Item.x, y: Item.y, width: Item.width, height: Item.height };
  }

  const viewport: Viewport = { roomId, ...DEFAULT_VIEWPORT };
  await ddb.send(
    new PutCommand({
      TableName: ROOMS_TABLE,
      Item: { ...viewport, createdAt: new Date().toISOString() },
      ConditionExpression: "attribute_not_exists(roomId)",
    })
  ).catch((err: unknown) => {
    // Lost a race with another client creating the same room concurrently — fine, it exists now.
    if (!(err instanceof Error && err.name === "ConditionalCheckFailedException")) throw err;
  });

  return viewport;
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
  viewport: Viewport
): Promise<{ visible: boolean; rotation: number } | undefined> {
  const existing = await getAsset(roomId, assetId);
  if (!existing) return undefined;

  const nextRotation = rotation ?? existing.rotation;
  const visible = intersects(
    { x, y, width: existing.width, height: existing.height },
    viewport
  );

  await ddb.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { roomId, assetId },
      UpdateExpression:
        "SET #x = :x, #y = :y, rotation = :rotation, visible = :visible, lastUsedAt = :now",
      ExpressionAttributeNames: { "#x": "x", "#y": "y" },
      ExpressionAttributeValues: {
        ":x": x,
        ":y": y,
        ":rotation": nextRotation,
        ":visible": visible,
        ":now": new Date().toISOString(),
      },
    })
  );

  return { visible, rotation: nextRotation };
}

export async function resizeAsset(
  roomId: string,
  assetId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: Viewport
): Promise<{ visible: boolean } | undefined> {
  const existing = await getAsset(roomId, assetId);
  if (!existing) return undefined;

  const visible = intersects({ x, y, width, height }, viewport);

  await ddb.send(
    new UpdateCommand({
      TableName: ASSETS_TABLE,
      Key: { roomId, assetId },
      UpdateExpression:
        "SET #x = :x, #y = :y, width = :width, height = :height, visible = :visible, lastUsedAt = :now",
      ExpressionAttributeNames: { "#x": "x", "#y": "y" },
      ExpressionAttributeValues: {
        ":x": x,
        ":y": y,
        ":width": width,
        ":height": height,
        ":visible": visible,
        ":now": new Date().toISOString(),
      },
    })
  );

  return { visible };
}

export async function deleteAsset(roomId: string, assetId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: ASSETS_TABLE, Key: { roomId, assetId } }));
}
