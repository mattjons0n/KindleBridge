import { describe, expect, it } from "vitest";
import {
  KindleDevice,
  MTP_OBJECT_FORMAT_ASSOCIATION,
} from "../../client/src/kindle/kindle-device";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";
import {
  krdsContainer,
  lpr,
  readingKrdsFixture,
  timerModel,
} from "./krds-fixtures";

function device(store: FakeKindleObjectStore): KindleDevice {
  return new KindleDevice(store, {
    now: () => new Date("2026-09-03T12:00:00Z"),
    random: () => 0,
  });
}

function addReadingSidecars(
  store: FakeKindleObjectStore,
  bookExtension: "azw3" | "kfx" | "mobi" = "azw3",
  sidecars: readonly { readonly extension: string; readonly bytes: Uint8Array }[] = [
    { extension: "azw3f", bytes: readingKrdsFixture(0.42, Date.UTC(2026, 8, 3, 12)) },
    { extension: "azw3r", bytes: krdsContainer(lpr(Date.UTC(2026, 8, 3, 13))) },
  ],
): void {
  store.objects.set(11, objectInfo(11, {
    parentHandle: 10,
    filename: `Exact Book.${bookExtension}`,
    compressedSize: 900_000_000,
  }));
  store.objects.set(12, objectInfo(12, {
    parentHandle: 10,
    objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
    associationType: 1,
    filename: "Exact Book.sdr",
  }));
  sidecars.forEach(({ extension, bytes }, index) => {
    const handle = 13 + index;
    store.objects.set(handle, objectInfo(handle, {
      parentHandle: 12,
      filename: `device-generated-${index}.${extension}`,
      compressedSize: bytes.byteLength,
    }));
    store.objectData.set(handle, bytes);
  });
}

describe("exact bounded Kindle reading sidecars", () => {
  it("is default-off and leaves normal .sdr pruning untouched", async () => {
    const store = new FakeKindleObjectStore();
    addReadingSidecars(store);

    const snapshot = await device(store).inventory({ bookMetadata: false });

    expect(snapshot.objects.map(({ handle }) => handle)).toEqual([11, 12]);
    expect(snapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(12);
    expect(store.readRequests).toEqual([]);
  });

  it("attaches sanitized browser-only evidence and reads sidecars but never the book", async () => {
    const store = new FakeKindleObjectStore();
    addReadingSidecars(store);
    store.objects.set(20, objectInfo(20, {
      parentHandle: 12,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "assets",
    }));
    const nested = readingKrdsFixture(0.99);
    store.objects.set(21, objectInfo(21, {
      parentHandle: 20,
      filename: "unrelated.azw3f",
      compressedSize: nested.byteLength,
    }));
    store.objectData.set(21, nested);

    const snapshot = await device(store).inventory({
      bookMetadata: false,
      readingSidecars: {},
    });

    const evidence = snapshot.objects.find(({ handle }) => handle === 11)?.readingEvidence;
    expect(evidence).toEqual({
      status: "in-progress",
      progressPercent: 42,
      lastReadAt: "2026-09-03T13:00:00.000Z",
      provenance: "azw3f",
      freshness: "live",
      explicitState: false,
    });
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      "explicitState", "freshness", "lastReadAt", "progressPercent", "provenance", "status",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("position-opaque");
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([13, 14]);
    expect(store.readRequests.some(({ handle }) => handle === 11 || handle === 21)).toBe(false);
    expect(store.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(20);
    expect(store.rangeReadRequests).toEqual([]);
    expect(store.createRequests).toEqual([]);
    expect(store.deletedHandles).toEqual([]);
  });

  it("can gate physical acceptance format by format", async () => {
    const store = new FakeKindleObjectStore();
    addReadingSidecars(store);

    const snapshot = await device(store).inventory({
      bookMetadata: false,
      readingSidecars: { formats: ["azw3f"] },
    });

    expect(snapshot.objects[0]?.readingEvidence).toMatchObject({
      progressPercent: 42,
      provenance: "azw3f",
      explicitState: false,
    });
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([13]);
  });

  it.each([
    ["kfx", "yjf"],
    ["mobi", "mbs"],
  ] as const)("uses the exact %s format allowlist for %s evidence", async (bookExtension, sidecarExtension) => {
    const store = new FakeKindleObjectStore();
    addReadingSidecars(store, bookExtension, [{
      extension: sidecarExtension,
      bytes: readingKrdsFixture(0.25),
    }]);

    const snapshot = await device(store).inventory({ bookMetadata: false, readingSidecars: {} });

    expect(snapshot.objects[0]?.readingEvidence).toMatchObject({
      status: "in-progress",
      progressPercent: 25,
      provenance: sidecarExtension,
      explicitState: false,
    });
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([13]);
  });

  it("rejects wrong-parent, duplicate-folder, duplicate-file, and nested alternatives", async () => {
    const wrongParent = new FakeKindleObjectStore();
    addReadingSidecars(wrongParent);
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
    const wrong = await device(wrongParent).inventory({ bookMetadata: false, readingSidecars: {} });
    expect(wrong.objects.find(({ handle }) => handle === 11)).not.toHaveProperty("readingEvidence");
    expect(wrongParent.readRequests).toEqual([]);

    const duplicateFolder = new FakeKindleObjectStore();
    addReadingSidecars(duplicateFolder);
    duplicateFolder.objects.set(30, objectInfo(30, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "exact book.SDR",
    }));
    const duplicateFolderSnapshot = await device(duplicateFolder).inventory({
      bookMetadata: false,
      readingSidecars: {},
    });
    expect(duplicateFolderSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(duplicateFolder.readRequests).toEqual([]);

    const duplicateBook = new FakeKindleObjectStore();
    addReadingSidecars(duplicateBook);
    duplicateBook.objects.set(31, objectInfo(31, {
      parentHandle: 10,
      filename: "Exact Book.kfx",
      compressedSize: 123,
    }));
    const duplicateBookSnapshot = await device(duplicateBook).inventory({
      bookMetadata: false,
      readingSidecars: {},
    });
    expect(duplicateBookSnapshot.objects.find(({ handle }) => handle === 11)).not.toHaveProperty("readingEvidence");
    expect(duplicateBookSnapshot.objects.find(({ handle }) => handle === 31)).not.toHaveProperty("readingEvidence");
    expect(duplicateBook.readRequests).toEqual([]);

    const duplicateFile = new FakeKindleObjectStore();
    addReadingSidecars(duplicateFile, "azw3", [
      { extension: "azw3f", bytes: readingKrdsFixture(0.2) },
      { extension: "azw3f", bytes: readingKrdsFixture(0.2) },
    ]);
    const duplicateFileSnapshot = await device(duplicateFile).inventory({
      bookMetadata: false,
      readingSidecars: {},
    });
    expect(duplicateFileSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(duplicateFile.readRequests).toEqual([]);

    const nestedOnly = new FakeKindleObjectStore();
    addReadingSidecars(nestedOnly, "azw3", []);
    nestedOnly.objects.set(20, objectInfo(20, {
      parentHandle: 12,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "assets",
    }));
    const nestedBytes = readingKrdsFixture(0.2);
    nestedOnly.objects.set(21, objectInfo(21, {
      parentHandle: 20,
      filename: "lookalike.azw3f",
      compressedSize: nestedBytes.byteLength,
    }));
    nestedOnly.objectData.set(21, nestedBytes);
    const nestedSnapshot = await device(nestedOnly).inventory({ bookMetadata: false, readingSidecars: {} });
    expect(nestedSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(nestedOnly.childListRequests.map(({ associationHandle }) => associationHandle)).not.toContain(20);
    expect(nestedOnly.readRequests).toEqual([]);
  });

  it("preflights object-count, per-object, aggregate, and child-count caps before reading", async () => {
    const objectLimited = new FakeKindleObjectStore();
    addReadingSidecars(objectLimited);
    await device(objectLimited).inventory({
      bookMetadata: false,
      readingSidecars: { maxSidecarObjects: 1 },
    });
    expect(objectLimited.readRequests).toEqual([]);

    const byteLimited = new FakeKindleObjectStore();
    addReadingSidecars(byteLimited);
    await device(byteLimited).inventory({
      bookMetadata: false,
      readingSidecars: { maxObjectBytes: 32 },
    });
    expect(byteLimited.readRequests).toEqual([]);

    const totalLimited = new FakeKindleObjectStore();
    addReadingSidecars(totalLimited);
    await device(totalLimited).inventory({
      bookMetadata: false,
      readingSidecars: { maxTotalBytes: 64 },
    });
    expect(totalLimited.readRequests).toEqual([]);

    const childLimited = new FakeKindleObjectStore();
    addReadingSidecars(childLimited);
    childLimited.objects.set(20, objectInfo(20, { parentHandle: 12, filename: "unrelated.bin" }));
    const childSnapshot = await device(childLimited).inventory({
      bookMetadata: false,
      readingSidecars: { maxChildObjects: 2 },
    });
    expect(childSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(childLimited.readRequests).toEqual([]);
  });

  it("contains malformed and conflicting sidecar evidence without guessing a state", async () => {
    const malformed = new FakeKindleObjectStore();
    addReadingSidecars(malformed, "azw3", [{
      extension: "azw3f",
      bytes: new TextEncoder().encode("not KRDS"),
    }]);
    const malformedSnapshot = await device(malformed).inventory({ bookMetadata: false, readingSidecars: {} });
    expect(malformedSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(malformed.readRequests.some(({ handle }) => handle === 11)).toBe(false);

    const conflict = new FakeKindleObjectStore();
    addReadingSidecars(conflict, "azw3", [
      { extension: "azw3f", bytes: krdsContainer(timerModel(0.2)) },
      { extension: "azw3r", bytes: krdsContainer(timerModel(0.3)) },
    ]);
    const conflictSnapshot = await device(conflict).inventory({ bookMetadata: false, readingSidecars: {} });
    expect(conflictSnapshot.objects[0]).not.toHaveProperty("readingEvidence");
    expect(conflict.readRequests.map(({ handle }) => handle)).toEqual([13, 14]);
  });

  it("propagates abort and fatal transport errors", async () => {
    const aborted = new FakeKindleObjectStore();
    addReadingSidecars(aborted);
    const controller = new AbortController();
    controller.abort();
    await expect(device(aborted).inventory({
      bookMetadata: false,
      readingSidecars: {},
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    const disconnected = new FakeKindleObjectStore();
    addReadingSidecars(disconnected);
    disconnected.childListFailures.set(12, Object.assign(new Error("gone"), {
      code: "USB_DEVICE_DISCONNECTED",
    }));
    await expect(device(disconnected).inventory({
      bookMetadata: false,
      readingSidecars: {},
    })).rejects.toMatchObject({ code: "USB_DEVICE_DISCONNECTED" });
  });
});
