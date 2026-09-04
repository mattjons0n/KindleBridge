import { describe, expect, it } from "vitest";
import {
  KindleDevice,
  MTP_OBJECT_FORMAT_ASSOCIATION,
} from "../../client/src/kindle/kindle-device";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";
import { matchingKfxMetadataFixture } from "./kfx-fixtures";

function device(store: FakeKindleObjectStore): KindleDevice {
  return new KindleDevice(store, {
    now: () => new Date("2026-09-03T12:00:00Z"),
    random: () => 0,
  });
}

function addKfxSidecar(store: FakeKindleObjectStore): Uint8Array {
  const metadata = matchingKfxMetadataFixture();
  store.objects.set(11, objectInfo(11, {
    parentHandle: 10,
    filename: "Exact Book.azw8",
    compressedSize: 900_000_000,
  }));
  store.objects.set(12, objectInfo(12, {
    parentHandle: 10,
    objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
    associationType: 1,
    filename: "Exact Book.sdr",
  }));
  store.objects.set(13, objectInfo(13, {
    parentHandle: 12,
    objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
    associationType: 1,
    filename: "assets",
  }));
  store.objects.set(14, objectInfo(14, {
    parentHandle: 13,
    filename: "metadata.kfx",
    compressedSize: metadata.byteLength,
  }));
  store.objectData.set(14, metadata);
  return metadata;
}

describe("exact bounded KFX sidecar metadata", () => {
  it("remains disabled by default and preserves ordinary .sdr pruning", async () => {
    const store = new FakeKindleObjectStore();
    addKfxSidecar(store);

    const snapshot = await device(store).inventory();

    expect(snapshot.objects.map(({ handle }) => handle)).toEqual([11, 12]);
    expect(snapshot.objects[0]).toMatchObject({
      handle: 11,
      bookMetadataState: "skipped-unsupported-format",
    });
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(12);
    expect(store.readRequests).toEqual([]);
    expect(store.rangeReadRequests).toEqual([]);
  });

  it("reads only the exact metadata.kfx object and never the whole KFX/AZW8 book", async () => {
    const store = new FakeKindleObjectStore();
    const metadata = addKfxSidecar(store);

    const snapshot = await device(store).inventory({ kfxSidecarMetadata: {} });

    expect(snapshot.objects.map(({ handle }) => handle)).toEqual([11, 12]);
    expect(snapshot.objects[0]).toMatchObject({
      handle: 11,
      title: "The Example",
      authors: ["Ada Author", "Ben Writer"],
      identifiers: ["asin:B012345678", "isbn:9781234567890"],
      language: "en",
      bookMetadataState: "enriched",
    });
    expect(snapshot.bookMetadata).toMatchObject({
      attemptedObjectCount: 1,
      parsedObjectCount: 1,
      enrichedObjectCount: 1,
      readByteCount: metadata.byteLength,
      budgetedByteCount: metadata.byteLength,
    });
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).toContain(12);
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).toContain(13);
    expect(store.readRequests).toEqual([{ handle: 14, maxBytes: metadata.byteLength }]);
    expect(store.readRequests.some(({ handle }) => handle === 11)).toBe(false);
    expect(store.rangeReadRequests).toEqual([]);
  });

  it("does not inspect inexact or ambiguous sibling folders", async () => {
    const store = new FakeKindleObjectStore();
    addKfxSidecar(store);
    store.objects.set(12, objectInfo(12, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "Different Book.sdr",
    }));
    store.objects.set(15, objectInfo(15, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "Exact Book.SDR",
    }));
    store.objects.set(16, objectInfo(16, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "exact book.sdr",
    }));

    const snapshot = await device(store).inventory({ kfxSidecarMetadata: {} });

    expect(snapshot.objects.find(({ handle }) => handle === 11)).toMatchObject({
      bookMetadataState: "skipped-unsupported-format",
    });
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(15);
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(16);
    expect(store.readRequests).toEqual([]);
  });

  it("rejects wrong-parent and deeper lookalike paths", async () => {
    const wrongParent = new FakeKindleObjectStore();
    addKfxSidecar(wrongParent);
    wrongParent.objects.set(20, objectInfo(20, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "Other",
    }));
    wrongParent.objects.set(12, objectInfo(12, {
      parentHandle: 20,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "Exact Book.sdr",
    }));
    const wrongParentSnapshot = await device(wrongParent).inventory({ kfxSidecarMetadata: {} });
    expect(wrongParentSnapshot.objects.find(({ handle }) => handle === 11)).toMatchObject({
      bookMetadataState: "skipped-unsupported-format",
    });
    expect(wrongParent.readRequests).toEqual([]);

    const deeper = new FakeKindleObjectStore();
    addKfxSidecar(deeper);
    deeper.objects.delete(14);
    deeper.objectData.delete(14);
    deeper.objects.set(15, objectInfo(15, {
      parentHandle: 13,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "nested",
    }));
    deeper.objects.set(14, objectInfo(14, {
      parentHandle: 15,
      filename: "metadata.kfx",
      compressedSize: matchingKfxMetadataFixture().byteLength,
    }));
    deeper.objectData.set(14, matchingKfxMetadataFixture());
    const deeperSnapshot = await device(deeper).inventory({ kfxSidecarMetadata: {} });
    expect(deeperSnapshot.objects.find(({ handle }) => handle === 11)).toMatchObject({
      bookMetadataState: "skipped-unsupported-format",
    });
    expect(deeper.readRequests).toEqual([]);
    expect(deeper.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(15);
  });

  it("fails closed on ambiguous assets and enforces sidecar byte limits before reading", async () => {
    const ambiguous = new FakeKindleObjectStore();
    addKfxSidecar(ambiguous);
    ambiguous.objects.set(15, objectInfo(15, {
      parentHandle: 12,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "ASSETS",
    }));
    const ambiguousSnapshot = await device(ambiguous).inventory({ kfxSidecarMetadata: {} });
    expect(ambiguousSnapshot.objects[0]).toMatchObject({ bookMetadataState: "skipped-unsupported-format" });
    expect(ambiguous.readRequests).toEqual([]);

    const oversized = new FakeKindleObjectStore();
    addKfxSidecar(oversized);
    const snapshot = await device(oversized).inventory({
      kfxSidecarMetadata: { maxSidecarBytes: 32 },
    });
    expect(snapshot.objects[0]).toMatchObject({ bookMetadataState: "skipped-object-size" });
    expect(oversized.readRequests).toEqual([]);
  });

  it("enforces aggregate and live child-enumeration limits before reading", async () => {
    const totalLimited = new FakeKindleObjectStore();
    addKfxSidecar(totalLimited);
    const totalSnapshot = await device(totalLimited).inventory({
      kfxSidecarMetadata: { maxTotalBytes: 32 },
    });
    expect(totalSnapshot.objects[0]).toMatchObject({ bookMetadataState: "skipped-total-bytes" });
    expect(totalLimited.readRequests).toEqual([]);

    const childLimited = new FakeKindleObjectStore();
    addKfxSidecar(childLimited);
    childLimited.objects.set(15, objectInfo(15, {
      parentHandle: 12,
      filename: "unrelated.bin",
    }));
    const childSnapshot = await device(childLimited).inventory({
      kfxSidecarMetadata: { maxChildObjects: 1 },
    });
    expect(childSnapshot.objects[0]).toMatchObject({ bookMetadataState: "skipped-unsupported-format" });
    expect(childLimited.readRequests).toEqual([]);
  });

  it("contains hostile sidecar parse failures without reading the book object", async () => {
    const store = new FakeKindleObjectStore();
    addKfxSidecar(store);
    const hostile = new TextEncoder().encode("not a KFX container");
    store.objects.set(14, objectInfo(14, {
      parentHandle: 13,
      filename: "metadata.kfx",
      compressedSize: hostile.byteLength,
    }));
    store.objectData.set(14, hostile);

    const snapshot = await device(store).inventory({ kfxSidecarMetadata: {} });

    expect(snapshot.objects[0]).toMatchObject({ bookMetadataState: "skipped-unsupported-format" });
    expect(store.readRequests).toEqual([{ handle: 14, maxBytes: hostile.byteLength }]);
    expect(store.readRequests.some(({ handle }) => handle === 11)).toBe(false);
  });

  it("propagates aborts and fatal transport loss instead of downgrading them", async () => {
    const aborted = new FakeKindleObjectStore();
    addKfxSidecar(aborted);
    const controller = new AbortController();
    controller.abort();
    await expect(device(aborted).inventory({
      signal: controller.signal,
      kfxSidecarMetadata: {},
    })).rejects.toMatchObject({ name: "AbortError" });

    const disconnected = new FakeKindleObjectStore();
    addKfxSidecar(disconnected);
    disconnected.childListFailures.set(12, Object.assign(new Error("gone"), {
      code: "USB_DEVICE_DISCONNECTED",
    }));
    await expect(device(disconnected).inventory({
      kfxSidecarMetadata: {},
    })).rejects.toMatchObject({ code: "USB_DEVICE_DISCONNECTED" });
  });
});
