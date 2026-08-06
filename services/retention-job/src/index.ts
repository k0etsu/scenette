import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;

const NEVER_USED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_USED_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

interface AssetRow {
  roomId: string;
  assetId: string;
  s3Key?: string;
  uploadedAt: string;
  lastUsedAt?: string;
  keep?: boolean;
}

function isStale(asset: AssetRow, now: number): boolean {
  const uploadedAt = new Date(asset.uploadedAt).getTime();
  const neverUsed = !asset.lastUsedAt;
  const staleUsed = !neverUsed && now - new Date(asset.lastUsedAt!).getTime() > LAST_USED_WINDOW_MS;
  const staleUnused = neverUsed && now - uploadedAt > NEVER_USED_WINDOW_MS;
  return staleUnused || staleUsed;
}

// Runs on a schedule (see infra: EventBridge rule). Deletes assets that are
// either (a) never placed on canvas within 7 days of upload, or (b) unused for
// 60 days since last placement — unless flagged `keep`, which is a permanent
// exemption. See plan.md for the full retention rule.
//
// Two passes over one table scan's worth of data, not a delete-as-you-go
// single pass: duplicateAsset() (control-ui) can leave two asset rows
// pointing at the same s3Key, and the physical S3 object must only be
// deleted once *every* row referencing it is gone -- which isn't knowable
// until every row in the table has been seen at least once. Pass 1 scans
// the whole table, evaluating each row's own staleness (no cross-row info
// needed for that) and counting how many rows reference each s3Key. Pass 2
// deletes the stale rows and, for each one, decrements that s3Key's
// reference count -- only physically deleting the S3 object when the count
// reaches zero, meaning nothing (stale or not) still points at it.
export const handler = async (): Promise<void> => {
  const now = Date.now();

  const staleAssets: AssetRow[] = [];
  const refCountByS3Key = new Map<string, number>();

  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await ddb.send(
      new ScanCommand({ TableName: ASSETS_TABLE, ExclusiveStartKey: lastEvaluatedKey })
    );
    lastEvaluatedKey = LastEvaluatedKey;

    for (const item of Items as AssetRow[]) {
      if (item.s3Key) {
        refCountByS3Key.set(item.s3Key, (refCountByS3Key.get(item.s3Key) ?? 0) + 1);
      }
      if (!item.keep && isStale(item, now)) {
        staleAssets.push(item);
      }
    }
  } while (lastEvaluatedKey);

  for (const asset of staleAssets) {
    await ddb.send(
      new DeleteCommand({ TableName: ASSETS_TABLE, Key: { roomId: asset.roomId, assetId: asset.assetId } })
    );

    // Text assets carry inline content, not an S3 object — nothing to delete there.
    if (!asset.s3Key) continue;

    const remaining = (refCountByS3Key.get(asset.s3Key) ?? 1) - 1;
    refCountByS3Key.set(asset.s3Key, remaining);
    if (remaining <= 0) {
      await s3.send(new DeleteObjectCommand({ Bucket: ASSETS_BUCKET, Key: asset.s3Key }));
    }
  }
};
