import { describe, expect, it, vi } from "vitest";
import type { KindleTarget } from "../../client/src/kindle/contracts";
import {
  kindleInventoryToDeviceMetadataCacheEntries,
  loadKindleBridgeDeviceMetadataCache,
  makeKindleBridgeDeviceMetadataCache,
  planKindleBridgeDeviceMetadataCacheWrite,
} from "../../client/src/kindle/device-metadata-cache";
import {
  createKindleBridgeDeviceMetadataCacheFilename,
  encodeKindleBridgeDeviceMetadataCache,
  type KindleBridgeDeviceMetadataCacheEntry,
  type KindleBridgeDeviceMetadataCacheSlot,
} from "../../client/src/kindle/device-metadata-cache-codec";
import { KindleDevice } from "../../client/src/kindle/kindle-device";
import {
  createKindleMetadataCache,
  type KindleMetadataCacheEvidence,
} from "../../client/src/kindle/metadata-cache";
import { makeKindleBookFixture } from "./book-fixture";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";

const MODIFICATION_DATE = "20260830T120000Z";
const CACHE_IDENTITY = Object.freeze({
  key: "b".repeat(64),
  stability: "installation" as const,
});

function device(
  store: FakeKindleObjectStore,
  browserCache = createKindleMetadataCache({ persistence: null, now: () => 1_000 }),
): KindleDevice {
  return new KindleDevice(
    store,
    {
      now: () => new Date("2026-08-30T12:00:00Z"),
      random: () => 0,
    },
    { cache: browserCache, identity: CACHE_IDENTITY },
  );
}

function target(store: FakeKindleObjectStore): KindleTarget {
  return {
    storageId: 1,
    storage: store.storages.get(1)!,
    documentsHandle: 10,
    documents: store.objects.get(10)!,
  };
}

function cacheEntry(
  overrides: Partial<KindleBridgeDeviceMetadataCacheEntry> = {},
): KindleBridgeDeviceMetadataCacheEntry {
  return {
    relativePath: "portable.azw3",
    size: 1_024,
    modificationDate: MODIFICATION_DATE,
    objectFormat: 0x3000,
    metadata: {
      title: "Portable metadata",
      authors: ["Portable Author"],
      identifiers: ["asin:B0PORTABLE"],
      language: "en",
    },
    ...overrides,
  };
}

async function addCacheObject(
  store: FakeKindleObjectStore,
  handle: number,
  slot: KindleBridgeDeviceMetadataCacheSlot,
  generation: number,
  entries: readonly KindleBridgeDeviceMetadataCacheEntry[],
  filename = createKindleBridgeDeviceMetadataCacheFilename(slot),
): Promise<Uint8Array> {
  const data = await encodeKindleBridgeDeviceMetadataCache(
    makeKindleBridgeDeviceMetadataCache(generation, entries),
  );
  store.objects.set(handle, objectInfo(handle, {
    parentHandle: 0,
    filename,
    objectFormat: 0x3000,
    associationType: 0,
    protectionStatus: 0,
    compressedSize: data.byteLength,
    modificationDate: MODIFICATION_DATE,
  }));
  store.objectData.set(handle, data);
  return data;
}

function addBook(
  store: FakeKindleObjectStore,
  handle: number,
  filename: string,
  data: Uint8Array,
  overrides: Partial<ReturnType<typeof objectInfo>> = {},
): void {
  store.objects.set(handle, objectInfo(handle, {
    parentHandle: 10,
    filename,
    compressedSize: data.byteLength,
    modificationDate: MODIFICATION_DATE,
    objectFormat: 0x3000,
    ...overrides,
  }));
  store.objectData.set(handle, data);
}

function browserEvidence(
  relativePath: string,
  size: number,
): KindleMetadataCacheEvidence {
  return {
    identity: CACHE_IDENTITY,
    storageId: 1,
    relativePath,
    metadataAdjusted: false,
    size,
    modificationDate: MODIFICATION_DATE,
  };
}

describe("Kindle-resident metadata cache", () => {
  it("uses an exact portable hit only after live enumeration and avoids reading the book", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({
      exthTitle: "Bytes that should not be read",
      authors: ["Live Author"],
    });
    addBook(store, 11, "portable.azw3", book);
    await addCacheObject(store, 20, "a", 1, [cacheEntry({ size: book.byteLength })]);

    const inventory = await device(store).inventory();

    expect(inventory.objects).toEqual([
      expect.objectContaining({
        handle: 11,
        title: "Portable metadata",
        authors: ["Portable Author"],
        identifiers: ["asin:B0PORTABLE"],
        bookMetadataState: "enriched",
      }),
    ]);
    expect(inventory.bookMetadata).toMatchObject({
      attemptedObjectCount: 0,
      parsedObjectCount: 0,
      cacheHitObjectCount: 1,
      deviceCacheHitObjectCount: 1,
      readByteCount: 0,
      budgetedByteCount: 0,
    });
    expect(store.readRequests.filter(({ handle }) => handle === 11)).toEqual([]);
  });

  it("rejects a portable hit when the current live path is duplicated", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({ exthTitle: "Live duplicate path" });
    addBook(store, 11, "portable.azw3", book);
    addBook(store, 12, "portable.azw3", book);
    await addCacheObject(store, 20, "a", 1, [cacheEntry({ size: book.byteLength })]);

    const inventory = await device(store).inventory();

    expect(inventory.objects.filter(({ title }) => title === "Live duplicate path")).toHaveLength(2);
    expect(inventory.bookMetadata).toMatchObject({
      attemptedObjectCount: 2,
      parsedObjectCount: 2,
      readByteCount: book.byteLength * 2,
    });
    expect(inventory.bookMetadata).not.toHaveProperty("deviceCacheHitObjectCount");
    expect(store.readRequests.filter(({ handle }) => handle === 11 || handle === 12)).toEqual([
      { handle: 11, maxBytes: book.byteLength },
      { handle: 12, maxBytes: book.byteLength },
    ]);
  });

  it("does not let the browser fallback reintroduce a duplicate-path cache hit", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({ exthTitle: "Fresh duplicate bytes" });
    addBook(store, 11, "duplicate.azw3", book);
    addBook(store, 12, "duplicate.azw3", book);
    const browserCache = createKindleMetadataCache({ persistence: null, now: () => 2_000 });
    await browserCache.rememberMany([{
      evidence: browserEvidence("duplicate.azw3", book.byteLength),
      metadata: {
        title: "Stale shared browser value",
        authors: ["Wrong shared author"],
        identifiers: [],
      },
    }]);
    const lookupMany = vi.spyOn(browserCache, "lookupMany");
    const rememberMany = vi.spyOn(browserCache, "rememberMany");

    const inventory = await device(store, browserCache).inventory({ deviceMetadataCache: false });

    expect(inventory.objects.filter(({ title }) => title === "Fresh duplicate bytes")).toHaveLength(2);
    expect(inventory.bookMetadata).toMatchObject({
      attemptedObjectCount: 2,
      parsedObjectCount: 2,
      readByteCount: book.byteLength * 2,
    });
    expect(inventory.bookMetadata).not.toHaveProperty("browserCacheHitObjectCount");
    expect(lookupMany).not.toHaveBeenCalled();
    expect(rememberMany).not.toHaveBeenCalled();
  });

  it("does not export one parsed object from an ambiguous live path", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({ exthTitle: "Only one parse succeeds" });
    addBook(store, 11, "duplicate.azw3", book);
    addBook(store, 12, "duplicate.azw3", book);
    store.readFailures.set(12, new Error("simulated parse read failure"));

    const inventory = await device(store).inventory({ deviceMetadataCache: false });

    expect(inventory.objects.find(({ handle }) => handle === 11)?.bookMetadataState).toBe("enriched");
    expect(inventory.objects.find(({ handle }) => handle === 12)?.bookMetadataState).toBe("failed");
    expect(kindleInventoryToDeviceMetadataCacheEntries(inventory)).toEqual([]);
  });

  it.each([
    {
      evidence: "path",
      diagnostic: "pathMissObjectCount",
      change: (entry: KindleBridgeDeviceMetadataCacheEntry) => ({
        ...entry,
        relativePath: "different.azw3",
      }),
    },
    {
      evidence: "size",
      diagnostic: "sizeMismatchObjectCount",
      change: (entry: KindleBridgeDeviceMetadataCacheEntry) => ({
        ...entry,
        size: entry.size + 1,
      }),
    },
    {
      evidence: "modification timestamp",
      diagnostic: "modificationDateMismatchObjectCount",
      change: (entry: KindleBridgeDeviceMetadataCacheEntry) => ({
        ...entry,
        modificationDate: "20260830T120001Z",
      }),
    },
    {
      evidence: "object format",
      diagnostic: "formatMismatchObjectCount",
      change: (entry: KindleBridgeDeviceMetadataCacheEntry) => ({
        ...entry,
        objectFormat: 0x3004,
      }),
    },
  ])("falls back to a bounded live read when portable $evidence differs", async ({ change, diagnostic }) => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({
      exthTitle: "Fresh live metadata",
      authors: ["Fresh Author"],
      asin504: "B0FRESHLIVE",
    });
    addBook(store, 11, "portable.azw3", book);
    const exact = cacheEntry({ size: book.byteLength });
    await addCacheObject(store, 20, "a", 1, [change(exact)]);

    const inventory = await device(store).inventory();

    expect(inventory.objects[0]).toMatchObject({
      handle: 11,
      title: "Fresh live metadata",
      authors: ["Fresh Author"],
      identifiers: ["asin:B0FRESHLIVE"],
    });
    expect(inventory.bookMetadata).toMatchObject({
      attemptedObjectCount: 1,
      parsedObjectCount: 1,
      readByteCount: book.byteLength,
      budgetedByteCount: book.byteLength,
    });
    expect(inventory.bookMetadata).not.toHaveProperty("deviceCacheHitObjectCount");
    expect(inventory.metadataCacheDiagnostics?.portable).toMatchObject({
      available: true,
      candidateObjectCount: 1,
      [diagnostic]: 1,
    });
    expect(store.readRequests.filter(({ handle }) => handle === 11)).toEqual([
      { handle: 11, maxBytes: book.byteLength },
    ]);
  });

  it("never resurrects a portable entry absent from the current live hierarchy", async () => {
    const store = new FakeKindleObjectStore();
    await addCacheObject(store, 20, "a", 1, [cacheEntry()]);

    const inventory = await device(store).inventory();

    expect(inventory).toMatchObject({
      status: "complete",
      scannedObjectCount: 0,
      objects: [],
      bookMetadata: {
        eligibleObjectCount: 0,
        attemptedObjectCount: 0,
        parsedObjectCount: 0,
        readByteCount: 0,
      },
    });
    expect(store.readRequests.filter(({ handle }) => handle !== 20)).toEqual([]);
  });

  it("prefers a device hit and asks the browser cache only for remaining live misses", async () => {
    const store = new FakeKindleObjectStore();
    const first = makeKindleBookFixture({ exthTitle: "First bytes" });
    const second = makeKindleBookFixture({ exthTitle: "Second bytes" });
    addBook(store, 11, "portable.azw3", first);
    addBook(store, 12, "browser.azw3", second);
    await addCacheObject(store, 20, "a", 2, [cacheEntry({ size: first.byteLength })]);

    const browserCache = createKindleMetadataCache({ persistence: null, now: () => 2_000 });
    await browserCache.rememberMany([
      {
        evidence: browserEvidence("portable.azw3", first.byteLength),
        metadata: {
          title: "Browser value must lose",
          authors: ["Browser Author"],
          identifiers: [],
        },
      },
      {
        evidence: browserEvidence("browser.azw3", second.byteLength),
        metadata: {
          title: "Browser fallback",
          authors: ["Cached Browser Author"],
          identifiers: ["asin:B0BROWSER"],
        },
      },
    ]);
    const lookupMany = vi.spyOn(browserCache, "lookupMany");

    const inventory = await device(store, browserCache).inventory();

    expect(inventory.objects.find(({ handle }) => handle === 11)).toMatchObject({
      title: "Portable metadata",
      authors: ["Portable Author"],
    });
    expect(inventory.objects.find(({ handle }) => handle === 12)).toMatchObject({
      title: "Browser fallback",
      authors: ["Cached Browser Author"],
    });
    expect(inventory.bookMetadata).toMatchObject({
      attemptedObjectCount: 0,
      cacheHitObjectCount: 2,
      deviceCacheHitObjectCount: 1,
      browserCacheHitObjectCount: 1,
      readByteCount: 0,
    });
    expect(lookupMany).toHaveBeenCalledOnce();
    expect(lookupMany.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ relativePath: "browser.azw3" }),
    ]);
    expect(store.readRequests.filter(({ handle }) => handle === 11 || handle === 12)).toEqual([]);
  });

  it("loads both valid slots, selects the highest generation, and plans bounded A/B replacement", async () => {
    const store = new FakeKindleObjectStore();
    await addCacheObject(store, 20, "a", 3, [cacheEntry()]);
    await addCacheObject(store, 21, "b", 4, [cacheEntry({
      metadata: {
        title: "Newer generation",
        authors: ["Portable Author"],
        identifiers: [],
      },
    })]);

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));
    const plan = planKindleBridgeDeviceMetadataCacheWrite(loaded);

    expect(loaded.generationAmbiguous).toBe(false);
    expect(loaded).toMatchObject({
      rootDiscoveryOutcome: "complete",
      slotDiagnostics: {
        a: { outcome: "loaded", entryCount: 1 },
        b: { outcome: "loaded", entryCount: 1 },
      },
    });
    expect(loaded.active).toMatchObject({
      slot: "b",
      snapshot: { info: { handle: 21 }, cache: { generation: 4 } },
    });
    expect([...loaded.snapshotsBySlot.keys()]).toEqual(["a", "b"]);
    expect(plan).toMatchObject({
      slot: "a",
      filename: createKindleBridgeDeviceMetadataCacheFilename("a"),
      generation: 5,
      replace: { info: { handle: 20 }, cache: { generation: 3 } },
    });
  });

  it("refuses a write plan when equal generations contain different validated bytes", async () => {
    const store = new FakeKindleObjectStore();
    await addCacheObject(store, 20, "a", 7, [cacheEntry()]);
    await addCacheObject(store, 21, "b", 7, [cacheEntry({
      metadata: {
        title: "Conflicting value",
        authors: ["Portable Author"],
        identifiers: ["asin:B0PORTABLE"],
      },
    })]);

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));

    expect(loaded.generationAmbiguous).toBe(true);
    expect(loaded.slotDiagnostics).toEqual({
      a: { outcome: "loaded", entryCount: 1 },
      b: { outcome: "loaded", entryCount: 1 },
    });
    expect(loaded.active).toBeUndefined();
    expect(loaded.context).toBeUndefined();
    expect(planKindleBridgeDeviceMetadataCacheWrite(loaded)).toBeUndefined();
  });

  it("blocks a malformed inactive slot instead of overwriting or deleting it", async () => {
    const store = new FakeKindleObjectStore();
    await addCacheObject(store, 21, "b", 4, [cacheEntry()]);
    const malformed = new TextEncoder().encode("{");
    store.objects.set(20, objectInfo(20, {
      parentHandle: 0,
      filename: createKindleBridgeDeviceMetadataCacheFilename("a"),
      compressedSize: malformed.byteLength,
    }));
    store.objectData.set(20, malformed);

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));

    expect(loaded.active?.slot).toBe("b");
    expect(loaded.blockedSlots.has("a")).toBe(true);
    expect(loaded.slotDiagnostics).toEqual({
      a: { outcome: "blocked", entryCount: 0 },
      b: { outcome: "loaded", entryCount: 1 },
    });
    expect(planKindleBridgeDeviceMetadataCacheWrite(loaded)).toBeUndefined();
    expect(store.deletedHandles).toEqual([]);
    expect(store.createRequests).toEqual([]);
  });

  it("treats case-ambiguous duplicate slot names as blocked and non-actionable", async () => {
    const store = new FakeKindleObjectStore();
    const bytes = await addCacheObject(store, 20, "a", 1, [cacheEntry()]);
    store.objects.set(21, objectInfo(21, {
      parentHandle: 0,
      filename: createKindleBridgeDeviceMetadataCacheFilename("a").toUpperCase(),
      compressedSize: bytes.byteLength,
    }));
    store.objectData.set(21, bytes.slice());

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));

    expect(loaded.snapshotsBySlot.has("a")).toBe(false);
    expect(loaded.blockedSlots.has("a")).toBe(true);
    expect(loaded.slotDiagnostics.a).toEqual({ outcome: "blocked", entryCount: 0 });
    expect(planKindleBridgeDeviceMetadataCacheWrite(loaded)).toBeUndefined();
    expect(store.deletedHandles).toEqual([]);
  });

  it("reports a bounded unavailable state for a nonfatal root discovery failure", async () => {
    const store = new FakeKindleObjectStore();
    store.listObjectHandles = vi.fn().mockRejectedValue(new Error("private device failure"));

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));

    expect(loaded).toMatchObject({
      rootDiscoveryOutcome: "unavailable",
      rootHandleCount: 0,
      unreadableRootObjectCount: 0,
      slotDiagnostics: {
        a: { outcome: "unavailable", entryCount: 0 },
        b: { outcome: "unavailable", entryCount: 0 },
      },
    });
    expect(loaded.context).toBeUndefined();
  });

  it("propagates a wrapped fatal session failure instead of treating cache discovery as optional", async () => {
    const store = new FakeKindleObjectStore();
    const fatalCause = Object.assign(new Error("MTP stream faulted"), { fatal: true });
    const wrapped = Object.assign(new Error("bounded root list failed"), {
      code: "MTP_HANDLE_LIMIT_EXCEEDED",
      cause: fatalCause,
    });
    store.listObjectHandles = vi.fn().mockRejectedValue(wrapped);

    await expect(loadKindleBridgeDeviceMetadataCache(store, target(store))).rejects.toBe(wrapped);
  });

  it.each([
    {
      mismatch: "selected storage",
      mutate: (snapshot: Awaited<ReturnType<FakeKindleObjectStore["inspectKindleBridgeMetadataCacheObject"]>>) => ({
        ...snapshot,
        info: { ...snapshot.info, storageId: 2 },
      }),
    },
    {
      mismatch: "exact slot",
      mutate: (snapshot: Awaited<ReturnType<FakeKindleObjectStore["inspectKindleBridgeMetadataCacheObject"]>>) => ({
        ...snapshot,
        info: {
          ...snapshot.info,
          filename: createKindleBridgeDeviceMetadataCacheFilename("b"),
        },
      }),
    },
  ])("blocks a fresh inspection that no longer belongs to the $mismatch", async ({ mutate }) => {
    const store = new FakeKindleObjectStore();
    await addCacheObject(store, 20, "a", 1, [cacheEntry()]);
    const inspect = store.inspectKindleBridgeMetadataCacheObject.bind(store);
    store.inspectKindleBridgeMetadataCacheObject = vi.fn(async (handle, options) => mutate(
      await inspect(handle, options),
    ));

    const loaded = await loadKindleBridgeDeviceMetadataCache(store, target(store));

    expect(loaded.snapshotsBySlot.has("a")).toBe(false);
    expect(loaded.blockedSlots.has("a")).toBe(true);
    expect(loaded.active).toBeUndefined();
    expect(loaded.context).toBeUndefined();
    expect(planKindleBridgeDeviceMetadataCacheWrite(loaded)).toBeUndefined();
  });
});
