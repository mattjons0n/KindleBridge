import { describe, expect, it, vi } from "vitest";
import {
  advancedPartialObjectProbeMetrics,
  advancedPartialObjectProbeTargets,
  exportAdvancedPartialObjectProbeResult,
} from "../../client/src/advanced-partial-object-diagnostic";
import {
  buildKindleInventory,
  type KindleStoredObjectInfo,
  type KindleTarget,
} from "../../client/src/kindle";

const STORAGE_ID = 0x10001;
const DOCUMENTS_HANDLE = 42;

function info(
  handle: number,
  filename: string,
  overrides: Partial<KindleStoredObjectInfo> = {},
): KindleStoredObjectInfo {
  return {
    handle,
    storageId: STORAGE_ID,
    objectFormat: 0x3000,
    protectionStatus: 0,
    compressedSize: 128,
    parentHandle: DOCUMENTS_HANDLE,
    associationType: 0,
    filename,
    modificationDate: "20260903T120000",
    ...overrides,
  };
}

async function inventoryFixture() {
  const objects = new Map<number, KindleStoredObjectInfo>([
    [1, info(1, "Readable.azw3")],
    [2, info(2, "Protected.azw3", { protectionStatus: 1 })],
    [3, info(3, "Folder.sdr", {
      objectFormat: 0x3001,
      associationType: 1,
      compressedSize: 0,
    })],
    [4, info(4, "Nested.azw3", { parentHandle: 3 })],
    [5, info(5, "diagnostic.txt")],
  ]);
  const store = {
    listObjectHandles: vi.fn(async ({ associationHandle }: { associationHandle?: number }) => (
      associationHandle === DOCUMENTS_HANDLE ? [1, 2, 3, 5] : associationHandle === 3 ? [4] : []
    )),
    getObjectInfo: vi.fn(async (handle: number) => ({ ...objects.get(handle)! })),
  };
  const target: KindleTarget = {
    storageId: STORAGE_ID,
    storage: {
      storageType: 3,
      filesystemType: 2,
      accessCapability: 0,
      maxCapacity: 10_000n,
      freeSpaceInBytes: 5_000n,
      freeSpaceInImages: 0,
      storageDescription: "Kindle",
      volumeLabel: "Kindle",
    },
    documentsHandle: DOCUMENTS_HANDLE,
    documents: info(DOCUMENTS_HANDLE, "Documents", {
      objectFormat: 0x3001,
      associationType: 1,
      parentHandle: 0xffff_ffff,
      compressedSize: 0,
    }),
  };
  return buildKindleInventory(store as never, target, {
    bookMetadata: false,
    deviceMetadataCache: false,
  });
}

describe("Advanced partial-object diagnostic presentation", () => {
  it("offers only exact, unprotected readable books directly inside Documents", async () => {
    const inventory = await inventoryFixture();
    expect(advancedPartialObjectProbeTargets(inventory)).toEqual({
      targets: [{ handle: 1, filename: "Readable.azw3", size: 128 }],
      eligibleCount: 1,
      truncated: false,
    });
    expect(advancedPartialObjectProbeTargets({ ...inventory, status: "partial" })).toEqual({
      targets: [], eligibleCount: 0, truncated: false,
    });
  });

  it("exports the fixed byte-free presentation vocabulary only", () => {
    const exported = exportAdvancedPartialObjectProbeResult({
      verdict: "advertised-and-consistent",
      operation: "GetPartialObject (0x101b)",
      objectSize: 1_024,
      rangeCount: 7,
      requestedRangeBytes: 640,
      returnedRangeBytes: 512,
      overlapBytesVerified: 64,
      repeatBytesVerified: 64,
      wholeObjectComparison: "skipped-size-limit",
      referenceBytesRead: 0,
      eofBehavior: "zero-byte-success",
      elapsedMs: 18,
      rawBytes: "must-not-export",
      relativePath: "must-not-export",
    } as never);
    expect(JSON.parse(exported)).toEqual({
      verdict: "advertised-and-consistent",
      operation: "GetPartialObject (0x101b)",
      objectSize: 1_024,
      rangeCount: 7,
      requestedRangeBytes: 640,
      returnedRangeBytes: 512,
      overlapBytesVerified: 64,
      repeatBytesVerified: 64,
      wholeObjectComparison: "skipped-size-limit",
      referenceBytesRead: 0,
      eofBehavior: "zero-byte-success",
      elapsedMs: 18,
    });
    expect(exported).not.toContain("must-not-export");
    expect(advancedPartialObjectProbeMetrics(JSON.parse(exported))).toContainEqual({
      label: "Range bytes",
      value: "512 returned of 640 requested",
    });
  });
});
