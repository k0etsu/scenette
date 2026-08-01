import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { handler } from "../src/index";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(DeleteCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
});

function scanReturns(items: Record<string, unknown>[]): void {
  ddbMock.on(ScanCommand).resolves({ Items: items });
}

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe("retention-job -- staleness rules", () => {
  it("deletes a never-used asset once it's older than 7 days, including its S3 object", async () => {
    scanReturns([{ roomId: "r1", assetId: "a1", s3Key: "k1", uploadedAt: iso(8 * DAY_MS) }]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe("k1");
  });

  it("keeps a never-used asset within the 7-day window", async () => {
    scanReturns([{ roomId: "r1", assetId: "a1", s3Key: "k1", uploadedAt: iso(6 * DAY_MS) }]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("deletes an asset unused for over 60 days since lastUsedAt", async () => {
    scanReturns([
      { roomId: "r1", assetId: "a1", s3Key: "k1", uploadedAt: iso(90 * DAY_MS), lastUsedAt: iso(61 * DAY_MS) },
    ]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("keeps an asset used within the last 60 days", async () => {
    scanReturns([
      { roomId: "r1", assetId: "a1", s3Key: "k1", uploadedAt: iso(90 * DAY_MS), lastUsedAt: iso(59 * DAY_MS) },
    ]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("never deletes an asset flagged keep, regardless of staleness", async () => {
    scanReturns([
      { roomId: "r1", assetId: "a1", s3Key: "k1", uploadedAt: iso(90 * DAY_MS), lastUsedAt: iso(200 * DAY_MS), keep: true },
    ]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("never calls S3 delete for a stale text asset (no s3Key)", async () => {
    scanReturns([{ roomId: "r1", assetId: "t1", uploadedAt: iso(8 * DAY_MS) }]);
    await handler();
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});

describe("retention-job -- shared s3Key (duplicateAsset) safety", () => {
  it("deletes the stale row but keeps the S3 object when a fresh duplicate still references it", async () => {
    scanReturns([
      { roomId: "r1", assetId: "stale", s3Key: "shared-key", uploadedAt: iso(8 * DAY_MS) },
      { roomId: "r1", assetId: "fresh-copy", s3Key: "shared-key", uploadedAt: iso(1 * DAY_MS), lastUsedAt: iso(0) },
    ]);
    await handler();

    // Regression: deleting the S3 object here would silently break the
    // still-live duplicate that shares this exact key.
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ roomId: "r1", assetId: "stale" });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("deletes the S3 object once every asset sharing that key goes stale in the same run", async () => {
    scanReturns([
      { roomId: "r1", assetId: "a1", s3Key: "shared-key", uploadedAt: iso(8 * DAY_MS) },
      { roomId: "r1", assetId: "a1-copy", s3Key: "shared-key", uploadedAt: iso(9 * DAY_MS) },
    ]);
    await handler();

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(2);
    // Exactly one physical delete despite two rows referencing the same key.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe("shared-key");
  });
});

describe("retention-job -- pagination", () => {
  it("accumulates staleness/refcounts correctly across multiple Scan pages", async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ roomId: "r1", assetId: "stale", s3Key: "shared-key", uploadedAt: iso(8 * DAY_MS) }],
        LastEvaluatedKey: { roomId: "r1", assetId: "stale" },
      })
      .resolvesOnce({
        // The still-fresh reference to the same key arrives on the SECOND
        // page -- the S3 object must survive even though the first page
        // alone would have looked like the last reference.
        Items: [
          { roomId: "r1", assetId: "fresh-copy", s3Key: "shared-key", uploadedAt: iso(1 * DAY_MS), lastUsedAt: iso(0) },
        ],
      });

    await handler();

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });
});
