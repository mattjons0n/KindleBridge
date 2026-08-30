import { describe, expect, it, vi } from "vitest";
import {
  KindleDevice,
  MTP_ROOT_ASSOCIATION_HANDLE,
} from "../../client/src/kindle/kindle-device";
import {
  createKindleBridgeDeviceMetadataCacheFilename,
  decodeKindleBridgeDeviceMetadataCache,
  parseKindleBridgeDeviceMetadataCacheFilename,
  type KindleBridgeDeviceMetadataCacheSlot,
} from "../../client/src/kindle/device-metadata-cache-codec";
import type { KindleStoredObjectInfo } from "../../client/src/kindle/contracts";
import { makeKindleBookFixture } from "./book-fixture";
import {
  FakeKindleObjectStore,
  objectInfo,
} from "./fake-store";

const FIXED_DATE = new Date("2026-08-30T12:00:00Z");
const BOOK_HANDLE = 11;

function kindle(store: FakeKindleObjectStore): KindleDevice {
  return new KindleDevice(store, {
    now: () => FIXED_DATE,
    random: () => 0,
  });
}

function installBook(
  store: FakeKindleObjectStore,
  title: string,
  modificationDate = "20260830T120000Z",
): Uint8Array {
  const bytes = makeKindleBookFixture({
    exthTitle: title,
    authors: ["Cache Test Author"],
    asin504: "B0CACHEFLOW",
  });
  store.objects.set(BOOK_HANDLE, objectInfo(BOOK_HANDLE, {
    parentHandle: 10,
    filename: "cache-flow.azw3",
    compressedSize: bytes.byteLength,
    modificationDate,
  }));
  store.objectData.set(BOOK_HANDLE, bytes);
  return bytes;
}

function cacheCreateRequests(store: FakeKindleObjectStore) {
  return store.createRequests.filter(
    ({ filename }) => parseKindleBridgeDeviceMetadataCacheFilename(filename) !== null,
  );
}

function cacheObjects(store: FakeKindleObjectStore): KindleStoredObjectInfo[] {
  return [...store.objects.values()].filter(
    ({ filename }) => parseKindleBridgeDeviceMetadataCacheFilename(filename) !== null,
  );
}

async function readCacheSlot(
  store: FakeKindleObjectStore,
  slot: KindleBridgeDeviceMetadataCacheSlot,
) {
  const filename = createKindleBridgeDeviceMetadataCacheFilename(slot);
  const info = [...store.objects.values()].find((candidate) => candidate.filename === filename);
  if (!info) throw new Error(`Expected cache slot ${slot} to exist`);
  const bytes = store.objectData.get(info.handle);
  if (!bytes) throw new Error(`Expected cache slot ${slot} bytes to exist`);
  return {
    info,
    bytes,
    cache: await decodeKindleBridgeDeviceMetadataCache(bytes),
  };
}

async function establishInitialCache(store: FakeKindleObjectStore) {
  const device = kindle(store);
  const onObjectState = vi.fn();
  await device.runSelfTest({ onObjectState });
  const inventory = await device.inventory({
    deviceMetadataCache: "read-write",
    onObjectState,
  });
  expect(inventory.status).toBe("complete");
  return readCacheSlot(store, "a");
}

describe("KindleDevice on-device metadata cache integration", () => {
  it("requires both a successful current-session self-test and a recovery callback before writing", async () => {
    const withoutSelfTest = new FakeKindleObjectStore();
    installBook(withoutSelfTest, "No self-test");
    await kindle(withoutSelfTest).inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    });
    expect(cacheCreateRequests(withoutSelfTest)).toEqual([]);

    const withoutCallback = new FakeKindleObjectStore();
    installBook(withoutCallback, "No callback");
    const testedDevice = kindle(withoutCallback);
    await testedDevice.runSelfTest({ onObjectState: vi.fn() });
    const createsAfterSelfTest = withoutCallback.createRequests.length;
    const deletesAfterSelfTest = withoutCallback.deletedHandles.length;
    await testedDevice.inventory({ deviceMetadataCache: "read-write" });
    expect(withoutCallback.createRequests).toHaveLength(createsAfterSelfTest);
    expect(withoutCallback.deletedHandles).toHaveLength(deletesAfterSelfTest);
    expect(cacheCreateRequests(withoutCallback)).toEqual([]);

    const afterFailedSelfTest = new FakeKindleObjectStore();
    const failedDevice = kindle(afterFailedSelfTest);
    afterFailedSelfTest.corruptReadback = true;
    await expect(failedDevice.runSelfTest({ onObjectState: vi.fn() })).rejects.toMatchObject({
      code: "MTP_READBACK_MISMATCH",
    });
    afterFailedSelfTest.corruptReadback = false;
    const createsAfterFailure = afterFailedSelfTest.createRequests.length;
    await failedDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    });
    expect(afterFailedSelfTest.createRequests).toHaveLength(createsAfterFailure);
    expect(cacheCreateRequests(afterFailedSelfTest)).toEqual([]);
  });

  it("does not write when the selected storage is no longer writable", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Storage capability changed");
    const selectedStorage = store.storages.get(1)!;
    let storageReadCount = 0;
    store.getStorageInfo = vi.fn(async () => {
      storageReadCount += 1;
      // The third read is updateDeviceMetadataCache's auxiliary capacity
      // refresh, after the self-test and inventory target checks.
      return storageReadCount === 3
        ? { ...selectedStorage, accessCapability: 1 }
        : selectedStorage;
    });
    const device = kindle(store);
    const onObjectState = vi.fn();

    await device.runSelfTest({ onObjectState });
    const inventory = await device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    expect(inventory.status).toBe("complete");
    expect(storageReadCount).toBe(3);
    expect(cacheCreateRequests(store)).toEqual([]);
  });

  it("keeps a complete live inventory when optional cache bytes do not fit", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Cache does not fit");
    const selectedStorage = store.storages.get(1)!;
    let storageReadCount = 0;
    store.getStorageInfo = vi.fn(async () => {
      storageReadCount += 1;
      return storageReadCount === 3
        ? { ...selectedStorage, freeSpaceInBytes: 0n }
        : selectedStorage;
    });
    const device = kindle(store);
    const onObjectState = vi.fn();

    await device.runSelfTest({ onObjectState });
    await expect(device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    })).resolves.toMatchObject({ status: "complete" });

    expect(cacheCreateRequests(store)).toEqual([]);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
  });

  it("does not create a 257th root object beyond the strict discovery bound", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Root remains bounded");
    for (let index = 0; index < 255; index += 1) {
      const handle = 1_000 + index;
      store.objects.set(handle, objectInfo(handle, {
        parentHandle: 0,
        filename: `unrelated-root-${index}.dat`,
      }));
    }
    const device = kindle(store);
    const onObjectState = vi.fn();

    await device.runSelfTest({ onObjectState });
    await expect(device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    })).resolves.toMatchObject({ status: "complete" });

    expect([...store.objects.values()].filter(({ parentHandle }) => parentHandle === 0)).toHaveLength(256);
    expect(cacheCreateRequests(store)).toEqual([]);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
  });

  it("cleans a new slot that does not satisfy strict reconnect validation", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Device normalized cache format");
    store.metadataMutation = (info) => (
      parseKindleBridgeDeviceMetadataCacheFilename(info.filename) === null
        ? info
        : { ...info, objectFormat: 0x3004 }
    );
    const device = kindle(store);
    const onObjectState = vi.fn();

    await device.runSelfTest({ onObjectState });
    const inventory = await device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    const assigned = onObjectState.mock.calls
      .map(([state]) => state)
      .find((state) => state.stage === "handle-assigned"
        && parseKindleBridgeDeviceMetadataCacheFilename(state.filename) !== null);
    expect(inventory.status).toBe("complete");
    expect(assigned).toBeDefined();
    expect(store.deletedHandles).toContain(assigned!.handle);
    expect(cacheObjects(store)).toEqual([]);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(onObjectState.mock.calls.some(([state]) => (
      state.stage === "verified"
      && parseKindleBridgeDeviceMetadataCacheFilename(state.filename) !== null
    ))).toBe(false);
  });

  it("creates slot A at the storage root and verifies its exact encoded bytes by readback", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "First cached metadata");
    const device = kindle(store);
    const onObjectState = vi.fn();

    await device.runSelfTest({ onObjectState });
    const inventory = await device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    expect(inventory.status).toBe("complete");
    expect(cacheCreateRequests(store)).toHaveLength(1);
    const cacheRequest = cacheCreateRequests(store)[0]!;
    expect(cacheRequest).toMatchObject({
      parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
      filename: createKindleBridgeDeviceMetadataCacheFilename("a"),
      objectFormat: 0x3000,
    });
    expect(cacheRequest.data).toBeInstanceOf(Uint8Array);

    const slotA = await readCacheSlot(store, "a");
    expect(slotA.info.parentHandle).toBe(0);
    expect(slotA.bytes).toEqual(cacheRequest.data);
    expect(slotA.cache).toMatchObject({
      version: 1,
      parserRevision: 1,
      generation: 1,
      entries: [{
        relativePath: "cache-flow.azw3",
        objectFormat: 0x3000,
      }],
    });
    expect(slotA.cache.entries[0]?.metadata).toMatchObject({
      title: "First cached metadata",
      authors: ["Cache Test Author"],
      identifiers: ["asin:B0CACHEFLOW"],
    });
    expect(store.readRequests).toContainEqual({
      handle: slotA.info.handle,
      maxBytes: slotA.bytes.byteLength,
    });
    expect(onObjectState.mock.calls.some(([state]) => (
      state.stage === "verified" && state.filename === slotA.info.filename
    ))).toBe(true);
  });

  it("uses the validated slot on the next unchanged inventory without another book read or write", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Unchanged cached metadata");
    await establishInitialCache(store);

    const nextDevice = kindle(store);
    const onObjectState = vi.fn();
    await nextDevice.runSelfTest({ onObjectState });
    const createCount = store.createRequests.length;
    const deleteCount = store.deletedHandles.length;
    store.readRequests.length = 0;

    const inventory = await nextDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    expect(inventory).toMatchObject({
      status: "complete",
      bookMetadata: {
        deviceCacheHitObjectCount: 1,
        attemptedObjectCount: 0,
        readByteCount: 0,
      },
    });
    expect(inventory.objects[0]).toMatchObject({ title: "Unchanged cached metadata" });
    expect(store.readRequests.filter(({ handle }) => handle === BOOK_HANDLE)).toEqual([]);
    expect(store.readRequests.some(({ handle }) => handle !== BOOK_HANDLE)).toBe(true);
    expect(store.createRequests).toHaveLength(createCount);
    expect(store.deletedHandles).toHaveLength(deleteCount);
    expect(cacheObjects(store)).toHaveLength(1);
  });

  it("rotates changed metadata from slot A to B without modifying or deleting the book", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Before metadata change");
    const slotA = await establishInitialCache(store);

    const changedBytes = installBook(
      store,
      "After metadata change",
      "20260830T120001Z",
    );
    const nextDevice = kindle(store);
    const onObjectState = vi.fn();
    await nextDevice.runSelfTest({ onObjectState });
    const deletedBeforeInventory = [...store.deletedHandles];
    await nextDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    const slotB = await readCacheSlot(store, "b");
    expect(slotA.cache.generation).toBe(1);
    expect(slotB.cache).toMatchObject({ generation: 2, parserRevision: 1 });
    expect(slotB.cache.entries[0]?.metadata.title).toBe("After metadata change");
    expect(cacheCreateRequests(store).map(({ filename }) => filename)).toEqual([
      createKindleBridgeDeviceMetadataCacheFilename("a"),
      createKindleBridgeDeviceMetadataCacheFilename("b"),
    ]);
    expect(store.objects.has(slotA.info.handle)).toBe(true);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(store.objectData.get(BOOK_HANDLE)).toEqual(changedBytes);
    expect(store.deletedHandles).toEqual(deletedBeforeInventory);
    expect(store.deletedHandles).not.toContain(BOOK_HANDLE);
    expect(store.deletedHandles).not.toContain(slotA.info.handle);
  });

  it("never mutates the metadata cache for read-only mode or a partial live hierarchy", async () => {
    const readOnlyStore = new FakeKindleObjectStore();
    installBook(readOnlyStore, "Read-only cache mode");
    const readOnlyDevice = kindle(readOnlyStore);
    const readOnlyCallback = vi.fn();
    await readOnlyDevice.runSelfTest({ onObjectState: readOnlyCallback });
    const readOnlyCreateCount = readOnlyStore.createRequests.length;
    const readOnlyDeleteCount = readOnlyStore.deletedHandles.length;
    const complete = await readOnlyDevice.inventory({
      deviceMetadataCache: "read-only",
      onObjectState: readOnlyCallback,
    });
    expect(complete.status).toBe("complete");
    expect(readOnlyStore.createRequests).toHaveLength(readOnlyCreateCount);
    expect(readOnlyStore.deletedHandles).toHaveLength(readOnlyDeleteCount);
    expect(cacheCreateRequests(readOnlyStore)).toEqual([]);

    const partialStore = new FakeKindleObjectStore();
    partialStore.objects.set(11, objectInfo(11, { parentHandle: 10, filename: "one.txt" }));
    partialStore.objects.set(12, objectInfo(12, { parentHandle: 10, filename: "two.txt" }));
    const partialDevice = kindle(partialStore);
    const partialCallback = vi.fn();
    await partialDevice.runSelfTest({ onObjectState: partialCallback });
    const partialCreateCount = partialStore.createRequests.length;
    const partialDeleteCount = partialStore.deletedHandles.length;
    const partial = await partialDevice.inventory({
      maxObjects: 1,
      deviceMetadataCache: "read-write",
      onObjectState: partialCallback,
    });
    expect(partial.status).toBe("partial");
    expect(partialStore.createRequests).toHaveLength(partialCreateCount);
    expect(partialStore.deletedHandles).toHaveLength(partialDeleteCount);
    expect(cacheCreateRequests(partialStore)).toEqual([]);
  });

  it("deletes only the newly created slot when exact cache readback mismatches", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Valid slot A");
    const slotA = await establishInitialCache(store);
    installBook(store, "Slot B should fail", "20260830T120001Z");

    const nextDevice = kindle(store);
    const onObjectState = vi.fn();
    await nextDevice.runSelfTest({ onObjectState });
    const deletesBeforeInventory = store.deletedHandles.length;
    const originalReadObject = store.readObject.bind(store);
    store.readObject = vi.fn(async (handle, options) => {
      const bytes = await originalReadObject(handle, options);
      const filename = store.objects.get(handle)?.filename;
      if (filename === createKindleBridgeDeviceMetadataCacheFilename("b")) {
        const corrupted = bytes.slice();
        if (corrupted.byteLength > 0) corrupted[0] ^= 0xff;
        return corrupted;
      }
      return bytes;
    });

    const inventory = await nextDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    });

    expect(inventory.status).toBe("complete");
    const assignedSlotB = onObjectState.mock.calls
      .map(([state]) => state)
      .find((state) => (
        state.stage === "handle-assigned"
        && state.filename === createKindleBridgeDeviceMetadataCacheFilename("b")
      ));
    expect(assignedSlotB).toBeDefined();
    expect(store.deletedHandles.slice(deletesBeforeInventory)).toEqual([assignedSlotB!.handle]);
    expect(store.objects.has(assignedSlotB!.handle)).toBe(false);
    expect(store.objects.has(slotA.info.handle)).toBe(true);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(store.deletedHandles).not.toContain(slotA.info.handle);
    expect(store.deletedHandles).not.toContain(BOOK_HANDLE);
    expect(cacheObjects(store).map(({ filename }) => filename)).toEqual([
      createKindleBridgeDeviceMetadataCacheFilename("a"),
    ]);
  });

  it("successfully retires the inactive slot during a third-generation B-to-A rotation", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Generation one");
    const oldSlotA = await establishInitialCache(store);

    installBook(store, "Generation two", "20260830T120001Z");
    const secondDevice = kindle(store);
    await secondDevice.runSelfTest({ onObjectState: vi.fn() });
    await secondDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    });
    const slotB = await readCacheSlot(store, "b");

    installBook(store, "Generation three", "20260830T120002Z");
    const thirdDevice = kindle(store);
    await thirdDevice.runSelfTest({ onObjectState: vi.fn() });
    await thirdDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    });
    const newSlotA = await readCacheSlot(store, "a");

    expect(newSlotA.info.handle).not.toBe(oldSlotA.info.handle);
    expect(newSlotA.cache).toMatchObject({ generation: 3 });
    expect(newSlotA.cache.entries[0]?.metadata.title).toBe("Generation three");
    expect(slotB.cache).toMatchObject({ generation: 2 });
    expect(store.objects.has(oldSlotA.info.handle)).toBe(false);
    expect(store.objects.has(slotB.info.handle)).toBe(true);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(store.deletedHandles).toContain(oldSlotA.info.handle);
    expect(store.deletedHandles).not.toContain(slotB.info.handle);
    expect(store.deletedHandles).not.toContain(BOOK_HANDLE);
    expect(cacheObjects(store)).toHaveLength(2);
  });

  it("propagates cancellation during A/B rotation without touching either cache slot or the book", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Generation one");
    await establishInitialCache(store);

    installBook(store, "Generation two", "20260830T120001Z");
    const secondDevice = kindle(store);
    await secondDevice.runSelfTest({ onObjectState: vi.fn() });
    await secondDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    });
    expect(cacheObjects(store)).toHaveLength(2);

    installBook(store, "Generation three", "20260830T120002Z");
    const thirdDevice = kindle(store);
    await thirdDevice.runSelfTest({ onObjectState: vi.fn() });
    store.deleteKindleBridgeMetadataCacheObject = vi.fn(async () => {
      throw new DOMException("Cache rotation cancelled", "AbortError");
    });

    await expect(thirdDevice.inventory({
      deviceMetadataCache: "read-write",
      onObjectState: vi.fn(),
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(cacheObjects(store)).toHaveLength(2);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(store.deletedHandles).not.toContain(BOOK_HANDLE);
  });

  it("propagates a fatal cache-upload cause even when an adapter reports exact cleanup", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Fatal cache upload");
    const device = kindle(store);
    const onObjectState = vi.fn();
    await device.runSelfTest({ onObjectState });
    const fatalCause = Object.assign(new Error("MTP stream faulted"), { fatal: true });
    const partial = Object.assign(new Error("cache upload cleaned"), {
      handle: 501,
      filename: createKindleBridgeDeviceMetadataCacheFilename("a"),
      cleanupAttempted: true,
      cleanupSucceeded: true,
      cause: fatalCause,
    });
    store.createObject = vi.fn().mockRejectedValue(partial);

    await expect(device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    })).rejects.toBe(partial);

    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(cacheObjects(store)).toEqual([]);
  });

  it("propagates a fatal strict-readback failure after deleting only the new slot", async () => {
    const store = new FakeKindleObjectStore();
    installBook(store, "Fatal strict readback");
    const device = kindle(store);
    const onObjectState = vi.fn();
    await device.runSelfTest({ onObjectState });
    const fatal = Object.assign(new Error("strict readback faulted the MTP stream"), {
      fatal: true,
    });
    store.inspectKindleBridgeMetadataCacheObject = vi.fn().mockRejectedValue(fatal);

    await expect(device.inventory({
      deviceMetadataCache: "read-write",
      onObjectState,
    })).rejects.toBe(fatal);

    const assigned = onObjectState.mock.calls
      .map(([state]) => state)
      .find((state) => state.stage === "handle-assigned"
        && parseKindleBridgeDeviceMetadataCacheFilename(state.filename) !== null);
    expect(assigned).toBeDefined();
    expect(store.deletedHandles).toContain(assigned!.handle);
    expect(store.objects.has(BOOK_HANDLE)).toBe(true);
    expect(cacheObjects(store)).toEqual([]);
  });
});
