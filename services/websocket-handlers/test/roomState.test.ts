import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  getOrCreateRoom,
  setGlobalVolume,
  setVariable,
  deleteVariable,
  getAsset,
  moveAsset,
  resizeAsset,
  updateAsset,
  sumRoomStorageBytes,
  isS3KeyReferencedElsewhere,
} from "../src/roomState";

const ddbMock = mockClient(DynamoDBDocumentClient);

// What a real DynamoDB conditional-write rejection actually looks like --
// every staleness guard in roomState.ts distinguishes this from any other
// error by name, so tests need the same shape rather than a plain Error.
const conditionalCheckFailed = Object.assign(new Error("conditional check failed"), {
  name: "ConditionalCheckFailedException",
});

beforeEach(() => {
  ddbMock.reset();
});

describe("getOrCreateRoom", () => {
  it("maps an existing room item, defaulting missing volume/variables fields", () => {
    ddbMock.on(GetCommand).resolves({ Item: { roomId: "r1", x: 0, y: 0, width: 1920, height: 1080 } });
    return getOrCreateRoom("r1").then((room) => {
      expect(room).toEqual({
        roomId: "r1",
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        globalVolume: 1,
        globalVolumeSeq: 0,
        variables: {},
      });
    });
  });

  it("preserves an existing room's actual globalVolume/globalVolumeSeq/variables", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        roomId: "r1",
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        globalVolume: 0.5,
        globalVolumeSeq: 42,
        variables: { kills: { key: "kills", type: "number", value: "4", createdAt: "t" } },
      },
    });
    const room = await getOrCreateRoom("r1");
    expect(room.globalVolume).toBe(0.5);
    expect(room.globalVolumeSeq).toBe(42);
    expect(room.variables.kills.value).toBe("4");
  });

  it("creates a default room (1080p viewport, volume 1, no variables) when none exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    const room = await getOrCreateRoom("new-room");
    expect(room).toEqual({
      roomId: "new-room",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      globalVolume: 1,
      globalVolumeSeq: 0,
      variables: {},
    });
  });

  it("tolerates losing the create race to a concurrent client", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed);
    await expect(getOrCreateRoom("new-room")).resolves.toMatchObject({ roomId: "new-room" });
  });
});

describe("setGlobalVolume", () => {
  it("succeeds and returns undefined when the write isn't stale", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(setGlobalVolume("r1", 0.7, 100)).resolves.toBeUndefined();
  });

  it("returns 'stale' instead of throwing when a newer seq already won", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed);
    await expect(setGlobalVolume("r1", 0.7, 5)).resolves.toBe("stale");
  });

  it("rethrows any other error", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("network blip"));
    await expect(setGlobalVolume("r1", 0.7, 100)).rejects.toThrow("network blip");
  });
});

describe("setVariable", () => {
  it("assigns a fresh createdAt for a brand-new variable", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { variables: {} } });
    ddbMock.on(UpdateCommand).resolves({});
    const variable = await setVariable("r1", "kills", "number", "0");
    expect(variable.key).toBe("kills");
    expect(variable.value).toBe("0");
    expect(typeof variable.createdAt).toBe("string");
  });

  it("preserves the original createdAt when editing an existing variable's value", async () => {
    const originalCreatedAt = "2026-01-01T00:00:00.000Z";
    ddbMock.on(GetCommand).resolves({
      Item: { variables: { kills: { key: "kills", type: "number", value: "3", createdAt: originalCreatedAt } } },
    });
    ddbMock.on(UpdateCommand).resolves({});
    const variable = await setVariable("r1", "kills", "number", "4");
    expect(variable.value).toBe("4");
    expect(variable.createdAt).toBe(originalCreatedAt);
  });
});

describe("deleteVariable", () => {
  it("does not throw for a normal removal", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(deleteVariable("r1", "kills")).resolves.toBeUndefined();
  });
});

describe("getAsset", () => {
  it("returns undefined when the asset doesn't exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getAsset("r1", "missing")).resolves.toBeUndefined();
  });
});

const viewport = { roomId: "r1", x: 0, y: 0, width: 1920, height: 1080 };

function existingAsset(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    roomId: "r1",
    assetId: "a1",
    type: "image",
    x: 100,
    y: 100,
    width: 50,
    height: 50,
    rotation: 0,
    zIndex: 0,
    visible: true,
    hidden: false,
    locked: false,
    opacity: 1,
    blur: 0,
    flipX: false,
    flipY: false,
    loop: true,
    muted: false,
    volume: 1,
    paused: false,
    seq: 10,
    ...overrides,
  };
}

describe("moveAsset", () => {
  it("returns undefined for an unknown asset without attempting a write", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await moveAsset("r1", "missing", 0, 0, undefined, 20, viewport);
    expect(result).toBeUndefined();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("computes visible=true when the moved position is inside the viewport", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset() });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await moveAsset("r1", "a1", 200, 200, undefined, 20, viewport);
    expect(result).toMatchObject({ visible: true });
  });

  it("computes visible=false when the moved position is outside the viewport", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset() });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await moveAsset("r1", "a1", 5000, 5000, undefined, 20, viewport);
    expect(result).toMatchObject({ visible: false });
  });

  it("computes visible=false when the asset is manually hidden, even inside the viewport", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ hidden: true }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await moveAsset("r1", "a1", 200, 200, undefined, 20, viewport);
    expect(result).toMatchObject({ visible: false });
  });

  it("keeps the existing rotation when none is provided", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ rotation: 45 }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await moveAsset("r1", "a1", 200, 200, undefined, 20, viewport);
    expect(result).toMatchObject({ rotation: 45 });
  });

  it("applies a provided rotation", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ rotation: 45 }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await moveAsset("r1", "a1", 200, 200, 90, 20, viewport);
    expect(result).toMatchObject({ rotation: 90 });
  });

  it("returns 'stale' when a newer seq already won, rather than throwing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ seq: 999 }) });
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed);
    const result = await moveAsset("r1", "a1", 200, 200, undefined, 20, viewport);
    expect(result).toBe("stale");
  });
});

describe("resizeAsset", () => {
  it("returns undefined for an unknown asset", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await resizeAsset("r1", "missing", 0, 0, 10, 10, 20, viewport);
    expect(result).toBeUndefined();
  });

  it("computes visible from the new geometry, not the stored one", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ x: 0, y: 0, width: 10, height: 10 }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await resizeAsset("r1", "a1", 5000, 5000, 10, 10, 20, viewport);
    expect(result).toMatchObject({ visible: false });
  });

  it("returns 'stale' on a conditional check failure", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset() });
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed);
    const result = await resizeAsset("r1", "a1", 100, 100, 50, 50, 20, viewport);
    expect(result).toBe("stale");
  });
});

describe("updateAsset", () => {
  it("returns undefined for an unknown asset", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await updateAsset("r1", "missing", { paused: true }, 20, viewport);
    expect(result).toBeUndefined();
  });

  it("recomputes visible=false when the patch sets hidden=true, even though geometry is unchanged and inside the viewport", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ hidden: false }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await updateAsset("r1", "a1", { hidden: true }, 20, viewport);
    expect(result).toMatchObject({ visible: false });
  });

  it("recomputes visible=true when the patch sets hidden=false on an asset inside the viewport", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ hidden: true }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await updateAsset("r1", "a1", { hidden: false }, 20, viewport);
    expect(result).toMatchObject({ visible: true });
  });

  it("leaves hidden as-is (and visible unaffected by it) when the patch doesn't mention hidden", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset({ hidden: false }) });
    ddbMock.on(UpdateCommand).resolves({});
    const result = await updateAsset("r1", "a1", { opacity: 0.5 }, 20, viewport);
    expect(result).toMatchObject({ visible: true });
  });

  it("returns 'stale' on a conditional check failure", async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAsset() });
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed);
    const result = await updateAsset("r1", "a1", { paused: true }, 20, viewport);
    expect(result).toBe("stale");
  });
});

describe("sumRoomStorageBytes", () => {
  it("sums fileSize across assets", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "r1", assetId: "a1", s3Key: "k1", fileSize: 1000 },
        { roomId: "r1", assetId: "a2", s3Key: "k2", fileSize: 2000 },
      ],
    });
    await expect(sumRoomStorageBytes("r1")).resolves.toBe(3000);
  });

  it("counts a shared s3Key's bytes only once (a duplicateAsset() doesn't inflate usage)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "r1", assetId: "a1", s3Key: "k1", fileSize: 1000 },
        { roomId: "r1", assetId: "a1-copy", s3Key: "k1", fileSize: 1000 },
      ],
    });
    await expect(sumRoomStorageBytes("r1")).resolves.toBe(1000);
  });

  it("ignores text assets (no s3Key) and any asset missing a fileSize", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "r1", assetId: "t1", type: "text" },
        { roomId: "r1", assetId: "a1", s3Key: "k1" }, // predates fileSize tracking
      ],
    });
    await expect(sumRoomStorageBytes("r1")).resolves.toBe(0);
  });
});

describe("isS3KeyReferencedElsewhere", () => {
  it("returns true when another asset in the room shares the s3Key", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { roomId: "r1", assetId: "a1", s3Key: "k1" },
        { roomId: "r1", assetId: "a1-copy", s3Key: "k1" },
      ],
    });
    await expect(isS3KeyReferencedElsewhere("r1", "k1", "a1")).resolves.toBe(true);
  });

  it("returns false when the only reference is the asset being excluded", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ roomId: "r1", assetId: "a1", s3Key: "k1" }],
    });
    await expect(isS3KeyReferencedElsewhere("r1", "k1", "a1")).resolves.toBe(false);
  });
});
