import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const ASSETS_TABLE = process.env.ASSETS_TABLE!;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;

const NEVER_USED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_USED_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

// Runs on a schedule (see infra: EventBridge rule). Deletes assets that are
// either (a) never placed on canvas within 7 days of upload, or (b) unused for
// 60 days since last placement — unless flagged `keep`, which is a permanent
// exemption. See plan.md for the full retention rule.
export const handler = async (): Promise<void> => {
  const now = Date.now();
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const { Items = [], LastEvaluatedKey } = await ddb.send(
      new ScanCommand({ TableName: ASSETS_TABLE, ExclusiveStartKey: lastEvaluatedKey })
    );
    lastEvaluatedKey = LastEvaluatedKey;

    for (const asset of Items) {
      if (asset.keep) continue;

      const uploadedAt = new Date(asset.uploadedAt).getTime();
      const neverUsed = !asset.lastUsedAt;
      const staleUsed =
        !neverUsed && now - new Date(asset.lastUsedAt).getTime() > LAST_USED_WINDOW_MS;
      const staleUnused = neverUsed && now - uploadedAt > NEVER_USED_WINDOW_MS;

      if (staleUnused || staleUsed) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: ASSETS_BUCKET, Key: asset.s3Key })
        );
        await ddb.send(
          new DeleteCommand({ TableName: ASSETS_TABLE, Key: { assetId: asset.assetId } })
        );
      }
    }
  } while (lastEvaluatedKey);
};
