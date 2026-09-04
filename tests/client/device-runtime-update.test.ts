import { describe, expect, it, vi } from "vitest";
import {
  ConnectedKindle,
  type KindleManagedUpdateOptions,
  type PreparedKindleManagedUpdate,
} from "../../client/src/device-runtime";
import {
  buildKindleInventory,
  type KindleStoredObjectInfo,
  type KindleTarget,
} from "../../client/src/kindle";
import { readReplacementCleanupRecords } from "../../client/src/replacement-cleanup-journal";

const STORAGE_ID = 0x10001;
const DOCUMENTS_HANDLE = 42;
const OLD_HANDLE = 10;
const NEW_HANDLE = 20;
const OLD_TOKEN = "kb-0123456789abcdefabcd";
const NEW_TOKEN = "kb-fedcba9876543210abcd";
const OLD_FILENAME = `Old-${OLD_TOKEN}-20260903T120000Z-000001.azw3`;
const NEW_FILENAME = `New-${NEW_TOKEN}-20260903T120100Z-000002.azw3`;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function objectInfo(
  handle: number,
  filename: string,
  size: number,
  overrides: Partial<KindleStoredObjectInfo> = {},
): KindleStoredObjectInfo {
  return {
    handle,
    storageId: STORAGE_ID,
    objectFormat: 0x3000,
    protectionStatus: 0,
    compressedSize: size,
    parentHandle: DOCUMENTS_HANDLE,
    associationType: 0,
    filename,
    modificationDate: "20260903T120000",
    ...overrides,
  };
}

const prepared: PreparedKindleManagedUpdate = {
  blob: new Blob([new Uint8Array(120)]),
  originalFilename: "New.epub",
  artifactHash: "a".repeat(64),
  managedToken: NEW_TOKEN,
  sourceFormat: "epub",
  hasPresentationEdits: true,
};

interface HarnessOptions {
  readonly oldFilename?: string;
  readonly freeBytes?: bigint;
  readonly uploadError?: Error;
  readonly malformedNew?: Partial<KindleStoredObjectInfo>;
  readonly deleteError?: Error;
  readonly developmentProbe?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const objects = new Map<number, KindleStoredObjectInfo>();
  const objectBytes = new Map<number, Uint8Array>();
  const oldFilename = options.oldFilename ?? OLD_FILENAME;
  objects.set(OLD_HANDLE, objectInfo(OLD_HANDLE, oldFilename, 100));
  objectBytes.set(OLD_HANDLE, Uint8Array.from({ length: 100 }, (_, index) => index));
  const storage = {
    storageType: 3,
    filesystemType: 2,
    accessCapability: 0,
    maxCapacity: 10_000n,
    freeSpaceInBytes: options.freeBytes ?? 5_000n,
    freeSpaceInImages: 0,
    storageDescription: "Kindle",
    volumeLabel: "Kindle",
  };
  const target: KindleTarget = {
    storageId: STORAGE_ID,
    storage,
    documentsHandle: DOCUMENTS_HANDLE,
    documents: objectInfo(DOCUMENTS_HANDLE, "Documents", 0, {
      objectFormat: 0x3001,
      parentHandle: 0xffff_ffff,
      associationType: 1,
    }),
  };
  const store = {
    listObjectHandles: vi.fn(async (query: { associationHandle?: number }) => {
      order.push("list-parent");
      return query.associationHandle === DOCUMENTS_HANDLE ? [...objects.keys()] : [];
    }),
    getObjectInfo: vi.fn(async (handle: number) => {
      order.push(`get:${handle}`);
      const object = objects.get(handle);
      if (!object) throw new Error("Object not found");
      return { ...object };
    }),
    getStorageInfo: vi.fn(async () => {
      order.push("free-space");
      return storage;
    }),
    deleteExistingKindleBookObject: vi.fn(async (snapshot: KindleStoredObjectInfo) => {
      order.push("delete-old");
      if (options.deleteError) throw options.deleteError;
      expect(objects.get(snapshot.handle)).toEqual(snapshot);
      objects.delete(snapshot.handle);
      objectBytes.delete(snapshot.handle);
    }),
    readObjectRange: vi.fn(async ({ handle, offset, length }: { handle: number; offset: number; length: number }) => (
      (objectBytes.get(handle) ?? new Uint8Array()).slice(offset, offset + length)
    )),
    readObject: vi.fn(async (handle: number) => (objectBytes.get(handle) ?? new Uint8Array()).slice()),
  };
  const kindle = {
    store,
    currentTarget: target,
    runSelfTest: vi.fn(async () => ({
      filename: "self-test.txt",
      handle: 99,
      bytesVerified: 10,
      cleanedUp: true as const,
    })),
    inventory: vi.fn(async (inventoryOptions = {}) => {
      order.push("inventory");
      return buildKindleInventory(store as never, target, inventoryOptions);
    }),
    sendAzW3: vi.fn(async (blob: Blob, _filename: string, sendOptions: { managedToken?: string }) => {
      order.push("upload-new");
      if (options.uploadError) throw options.uploadError;
      expect(sendOptions.managedToken).toBe(NEW_TOKEN);
      objects.set(NEW_HANDLE, objectInfo(
        NEW_HANDLE,
        NEW_FILENAME,
        blob.size,
        { modificationDate: "20260903T120100", ...options.malformedNew },
      ));
      objectBytes.set(NEW_HANDLE, new Uint8Array(await blob.arrayBuffer()));
      return {
        handle: NEW_HANDLE,
        storageId: STORAGE_ID,
        parentHandle: DOCUMENTS_HANDLE,
        filename: NEW_FILENAME,
        size: blob.size,
        verified: true as const,
        managedToken: NEW_TOKEN,
      };
    }),
  };
  const connection = new ConnectedKindle(
    { vendorId: 0x1949, productId: 0x9981 } as never,
    {
      vendorId: 0x1949,
      productId: 0x9981,
      documentsHandle: DOCUMENTS_HANDLE,
      operationsSupported: [0x101b],
    },
    { close: vi.fn(async () => undefined) } as never,
    { isOpen: true, close: vi.fn(async () => undefined) } as never,
    kindle as never,
    { release: vi.fn(async () => undefined) } as never,
    "device-key",
    undefined,
    options.developmentProbe ?? false,
  );
  await connection.runSelfTest();
  await connection.refreshInventory({ bookMetadata: false, deviceMetadataCache: false });
  order.length = 0;
  return { connection, kindle, store, objects, order };
}

function updateOptions(
  order: string[],
  storage = new MemoryStorage(),
  overrides: Partial<KindleManagedUpdateOptions> = {},
): KindleManagedUpdateOptions {
  return {
    operationId: "replace-book-1",
    replacementCleanupStorage: storage,
    now: () => 123,
    recordVerifiedDelivery: vi.fn(async () => { order.push("record-delivery"); }),
    reconcile: vi.fn(async () => { order.push("reconcile"); }),
    ...overrides,
  };
}

const oldEvidence = {
  handle: OLD_HANDLE,
  filename: OLD_FILENAME,
  byteLength: 100,
  managedToken: OLD_TOKEN,
};

describe("ConnectedKindle managed update transaction", () => {
  it("exposes byte-free Advanced partial-read metrics for one exact unprotected live selection", async () => {
    const { connection, store } = await harness({ developmentProbe: true });
    await expect(connection.runAdvancedPartialObjectProbe(OLD_HANDLE, {
      maxReferenceBytes: 128,
    })).resolves.toMatchObject({
      verdict: "advertised-and-consistent",
      operation: "GetPartialObject (0x101b)",
      objectSize: 100,
      wholeObjectComparison: "matched",
      eofBehavior: "zero-byte-success",
    });
    expect(store.readObjectRange).toHaveBeenCalled();
    await expect(connection.runAdvancedPartialObjectProbe(OLD_HANDLE))
      .rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_ALREADY_RUN" });
  });

  it("uploads and verifies before recording, then exactly deletes and reconciles", async () => {
    const { connection, objects, order } = await harness();
    const result = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order));
    expect(result.status).toBe("updated");
    expect(objects.has(OLD_HANDLE)).toBe(false);
    expect(objects.has(NEW_HANDLE)).toBe(true);
    expect(order.indexOf("upload-new")).toBeLessThan(order.indexOf("record-delivery"));
    expect(order.indexOf("record-delivery")).toBeLessThan(order.indexOf("delete-old"));
    expect(order.at(-1)).toBe("reconcile");
    expect(result.inventory?.objects.map(({ handle }) => handle)).toEqual([NEW_HANDLE]);
  });

  it("retains the old copy when upload fails", async () => {
    const injected = new Error("upload failed");
    const { connection, objects, order, store } = await harness({ uploadError: injected });
    await expect(connection.updateManagedBook(prepared, oldEvidence, updateOptions(order))).rejects.toBe(injected);
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("retains both copies, journals, and reports an explicit state when delivery recording fails", async () => {
    const injected = new Error("record failed");
    const journal = new MemoryStorage();
    const { connection, objects, order, store } = await harness();
    const result = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order, journal, {
      recordVerifiedDelivery: vi.fn(async () => { order.push("record-delivery"); throw injected; }),
    }));
    expect(result).toMatchObject({
      status: "new-copy-kept-old-recording-required",
      deliveryRecordError: injected,
      cleanupRecord: { reason: "delivery-recording" },
    });
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(objects.has(NEW_HANDLE)).toBe(true);
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
    expect(readReplacementCleanupRecords(journal)).toEqual([result.cleanupRecord]);
    expect(order.at(-1)).toBe("reconcile");
  });

  it("retains the old copy when fresh verification rejects the uploaded metadata", async () => {
    const { connection, objects, order, store } = await harness({
      malformedNew: { protectionStatus: 1 },
    });
    await expect(connection.updateManagedBook(prepared, oldEvidence, updateOptions(order)))
      .rejects.toMatchObject({ code: "MTP_OBJECT_VERIFICATION_FAILED" });
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("keeps both verified copies and durably reports exact cleanup when old deletion fails", async () => {
    const cleanupError = new Error("delete failed");
    const journal = new MemoryStorage();
    const { connection, objects, order } = await harness({ deleteError: cleanupError });
    const result = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order, journal));
    expect(result).toMatchObject({
      status: "new-copy-kept-old-cleanup-required",
      cleanupError,
      cleanupRecord: { operationId: "replace-book-1" },
    });
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(objects.has(NEW_HANDLE)).toBe(true);
    expect(readReplacementCleanupRecords(journal)).toEqual([result.cleanupRecord]);
    expect(order.indexOf("record-delivery")).toBeLessThan(order.indexOf("delete-old"));
    expect(order.at(-1)).toBe("reconcile");
  });

  it("cleans a journaled prior copy only after a fresh complete exact revalidation", async () => {
    const journal = new MemoryStorage();
    const { connection, objects, order, store } = await harness({ deleteError: new Error("first delete failed") });
    const update = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order, journal));
    const record = update.cleanupRecord;
    expect(record?.reason).toBe("old-copy-cleanup");
    if (!record) throw new Error("cleanup record was not created");
    store.deleteExistingKindleBookObject.mockImplementation(async (snapshot: KindleStoredObjectInfo) => {
      order.push("recovery-delete-old");
      expect(objects.get(snapshot.handle)).toEqual(snapshot);
      objects.delete(snapshot.handle);
    });
    order.length = 0;

    await expect(connection.cleanupManagedReplacement(record, {
      inventory: { bookMetadata: false, deviceMetadataCache: false },
    })).resolves.toMatchObject({
      status: "cleaned",
      inventory: { status: "complete" },
    });
    expect(order[0]).toBe("inventory");
    expect(order.indexOf("get:20")).toBeLessThan(order.indexOf("recovery-delete-old"));
    expect(order.indexOf("get:10")).toBeLessThan(order.indexOf("recovery-delete-old"));
    expect(order.lastIndexOf("inventory")).toBeGreaterThan(order.indexOf("recovery-delete-old"));
    expect(objects.has(OLD_HANDLE)).toBe(false);
    expect(objects.has(NEW_HANDLE)).toBe(true);
    // The runtime proves device state; only the controller may compare-and-remove the journal.
    expect(readReplacementCleanupRecords(journal)).toEqual([record]);
  });

  it("keeps the prior copy when the verified replacement changes before recovery", async () => {
    const { connection, objects, order, store } = await harness({ deleteError: new Error("first delete failed") });
    const update = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order));
    const record = update.cleanupRecord;
    if (!record) throw new Error("cleanup record was not created");
    objects.set(NEW_HANDLE, objectInfo(NEW_HANDLE, NEW_FILENAME, prepared.blob.size + 1));
    store.deleteExistingKindleBookObject.mockClear();

    await expect(connection.cleanupManagedReplacement(record, {
      inventory: { bookMetadata: false, deviceMetadataCache: false },
    })).rejects.toMatchObject({ code: "OLD_COPY_CHANGED" });
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("verifies an already absent prior identity without issuing another delete", async () => {
    const { connection, objects, order, store } = await harness({ deleteError: new Error("first delete failed") });
    const update = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order));
    const record = update.cleanupRecord;
    if (!record) throw new Error("cleanup record was not created");
    objects.delete(OLD_HANDLE);
    store.deleteExistingKindleBookObject.mockClear();

    await expect(connection.cleanupManagedReplacement(record, {
      inventory: { bookMetadata: false, deviceMetadataCache: false },
    })).resolves.toMatchObject({ status: "already-resolved" });
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("rolls back only the unrecorded replacement while retaining the prior durable copy", async () => {
    const journal = new MemoryStorage();
    const { connection, objects, order, store } = await harness();
    const update = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order, journal, {
      recordVerifiedDelivery: vi.fn(async () => { throw new Error("record failed"); }),
    }));
    const record = update.cleanupRecord;
    if (!record) throw new Error("cleanup record was not created");
    store.deleteExistingKindleBookObject.mockClear();

    await expect(connection.cleanupManagedReplacement(record, {
      inventory: { bookMetadata: false, deviceMetadataCache: false },
    })).resolves.toMatchObject({ status: "rolled-back" });
    expect(objects.has(OLD_HANDLE)).toBe(true);
    expect(objects.has(NEW_HANDLE)).toBe(false);
    expect(store.deleteExistingKindleBookObject).toHaveBeenCalledWith(
      expect.objectContaining({ handle: NEW_HANDLE }),
      expect.any(Object),
    );
  });

  it("keeps an unrecorded replacement when its prior safe copy is no longer exact", async () => {
    const journal = new MemoryStorage();
    const { connection, objects, order, store } = await harness();
    const update = await connection.updateManagedBook(prepared, oldEvidence, updateOptions(order, journal, {
      recordVerifiedDelivery: vi.fn(async () => { throw new Error("record failed"); }),
    }));
    const record = update.cleanupRecord;
    if (!record) throw new Error("cleanup record was not created");
    objects.delete(OLD_HANDLE);
    store.deleteExistingKindleBookObject.mockClear();

    await expect(connection.cleanupManagedReplacement(record, {
      inventory: { bookMetadata: false, deviceMetadataCache: false },
    })).rejects.toMatchObject({ code: "OLD_COPY_CHANGED" });
    expect(objects.has(NEW_HANDLE)).toBe(true);
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("performs no mutation for possible/manual-only evidence or a stale managed object", async () => {
    const manual = await harness({ oldFilename: "Manually copied book.azw3" });
    await expect(manual.connection.updateManagedBook(
      prepared,
      { ...oldEvidence, filename: "Manually copied book.azw3" },
      updateOptions(manual.order),
    )).rejects.toMatchObject({ code: "OLD_COPY_NOT_MANAGED" });
    expect(manual.kindle.sendAzW3).not.toHaveBeenCalled();
    expect(manual.store.deleteExistingKindleBookObject).not.toHaveBeenCalled();

    const stale = await harness();
    stale.objects.set(OLD_HANDLE, objectInfo(OLD_HANDLE, OLD_FILENAME, 101));
    await expect(stale.connection.updateManagedBook(prepared, oldEvidence, updateOptions(stale.order)))
      .rejects.toMatchObject({ code: "OLD_COPY_NOT_MANAGED" });
    expect(stale.kindle.sendAzW3).not.toHaveBeenCalled();
    expect(stale.store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("never falls back to delete-first when coexistence space is insufficient", async () => {
    const { connection, kindle, store, order } = await harness({ freeBytes: 119n });
    await expect(connection.updateManagedBook(prepared, oldEvidence, updateOptions(order)))
      .rejects.toMatchObject({ code: "INSUFFICIENT_COEXISTENCE_SPACE" });
    expect(kindle.sendAzW3).not.toHaveBeenCalled();
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });

  it("blocks edited AZW3 before inventory, transfer, or deletion", async () => {
    const { connection, kindle, store, order } = await harness();
    const inventoryCalls = kindle.inventory.mock.calls.length;
    await expect(connection.updateManagedBook(
      { ...prepared, sourceFormat: "azw3" },
      oldEvidence,
      updateOptions(order),
    )).rejects.toMatchObject({ code: "UNSUPPORTED_EDITED_AZW3" });
    expect(kindle.inventory).toHaveBeenCalledTimes(inventoryCalls);
    expect(kindle.sendAzW3).not.toHaveBeenCalled();
    expect(store.deleteExistingKindleBookObject).not.toHaveBeenCalled();
  });
});
