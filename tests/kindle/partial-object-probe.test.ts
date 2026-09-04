import { describe, expect, it } from "vitest";
import { MtpOperationCode } from "../../client/src/mtp/constants";
import {
  KindlePartialObjectProbeError,
  kindleAdvertisesPartialObject,
  presentKindlePartialObjectProbeResult,
  runKindlePartialObjectProbe,
} from "../../client/src/kindle/partial-object-probe";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";

const HANDLE = 0x1234;

function probeStore(size = 10_000): FakeKindleObjectStore {
  const store = new FakeKindleObjectStore();
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  store.objects.set(HANDLE, objectInfo(HANDLE, {
    parentHandle: 10,
    filename: "probe.azw3",
    compressedSize: bytes.byteLength,
  }));
  store.objectData.set(HANDLE, bytes);
  return store;
}

describe("development GetPartialObject probe", () => {
  it("requires the exact advertised operation before issuing a range read", async () => {
    const store = probeStore();

    expect(kindleAdvertisesPartialObject([MtpOperationCode.GetObject])).toBe(false);
    await expect(runKindlePartialObjectProbe(store, [
      MtpOperationCode.GetObject,
      // The explicitly forbidden GetObjectPropList opcode must not be mistaken
      // for the standard bounded-range operation.
      0x9805,
    ], {
      handle: HANDLE,
      objectSize: 10_000,
    })).rejects.toBeInstanceOf(KindlePartialObjectProbeError);
    expect(store.rangeReadRequests).toEqual([]);
  });

  it("checks overlapping and repeated bounded ranges without returning sampled bytes", async () => {
    const store = probeStore();

    const result = await runKindlePartialObjectProbe(
      store,
      [MtpOperationCode.GetPartialObject, 0x9805],
      { handle: HANDLE, objectSize: 10_000, sampleBytes: 4_096 },
    );

    expect(store.rangeReadRequests).toEqual([
      { handle: HANDLE, offset: 0, length: 4_096 },
      { handle: HANDLE, offset: 2_048, length: 4_096 },
      { handle: HANDLE, offset: 2_952, length: 4_096 },
      { handle: HANDLE, offset: 5_904, length: 4_096 },
      { handle: HANDLE, offset: 5_904, length: 4_096 },
      { handle: HANDLE, offset: 10_000, length: 1 },
      { handle: HANDLE, offset: 10_001, length: 1 },
    ]);
    expect(result).toMatchObject({
      operationCode: MtpOperationCode.GetPartialObject,
      operationAdvertised: true,
      objectSize: 10_000,
      sampleBytes: 4_096,
      overlapBytesVerified: 2_048,
      repeatBytesVerified: 4_096,
      wholeObjectComparison: "matched",
      referenceBytesRead: 10_000,
      eofBehavior: "zero-byte-success",
      totalBytesRead: 30_480,
    });
    expect(result).not.toHaveProperty("bytes");
    expect(JSON.stringify(result)).not.toContain("probe.azw3");
    expect(presentKindlePartialObjectProbeResult(result)).toMatchObject({
      verdict: "advertised-and-consistent",
      operation: "GetPartialObject (0x101b)",
      rangeCount: 7,
      requestedRangeBytes: 20_482,
      returnedRangeBytes: 20_480,
      wholeObjectComparison: "matched",
    });
    expect(presentKindlePartialObjectProbeResult(result)).not.toHaveProperty("samples");
  });

  it("rejects in-bounds short reads and inconsistent repeated samples", async () => {
    const shortStore = probeStore(16);
    await expect(runKindlePartialObjectProbe(
      shortStore,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 32, sampleBytes: 8 },
    )).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_SHORT_READ" });

    let reads = 0;
    const changingStore = {
      readObjectRange: async ({ length }: { readonly length: number }) => {
        reads += 1;
        return new Uint8Array(length).fill(reads === 4 ? 1 : 0);
      },
    };
    await expect(runKindlePartialObjectProbe(
      changingStore,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 10_000, sampleBytes: 4_096 },
    )).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_MISMATCH" });
  });

  it("rejects nonempty EOF results and a bounded whole-object reference mismatch", async () => {
    const eofStore = {
      readObjectRange: async ({ offset, length }: { readonly offset: number; readonly length: number }) => (
        offset === 32 ? new Uint8Array([1]) : new Uint8Array(length)
      ),
    };
    await expect(runKindlePartialObjectProbe(
      eofStore,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 32, sampleBytes: 8 },
    )).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_EOF_MISMATCH" });

    const referenceStore = {
      readObjectRange: async ({ offset, length }: { readonly offset: number; readonly length: number }) => (
        offset >= 32 ? new Uint8Array() : new Uint8Array(length)
      ),
      readObject: async () => new Uint8Array(32).fill(1),
    };
    await expect(runKindlePartialObjectProbe(
      referenceStore,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 32, sampleBytes: 8 },
    )).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_REFERENCE_MISMATCH" });
  });

  it("enforces the fixed sample and unsigned object bounds before reading", async () => {
    const store = probeStore();

    await expect(runKindlePartialObjectProbe(
      store,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 10_000, sampleBytes: 65_537 },
    )).rejects.toBeInstanceOf(RangeError);
    await expect(runKindlePartialObjectProbe(
      store,
      [MtpOperationCode.GetPartialObject],
      { handle: HANDLE, objectSize: 0 },
    )).rejects.toBeInstanceOf(RangeError);
    expect(store.rangeReadRequests).toEqual([]);
  });
});
