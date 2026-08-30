import { describe, expect, it, vi } from "vitest";
import {
  decodeContainer,
  decodeContainerParameters,
  encodeDataContainer,
  encodeResponseContainer,
} from "../../client/src/mtp/codec";
import {
  MTP_ROOT_PARENT,
  MtpAssociationType,
  MtpContainerType,
  MtpFilesystemType,
  MtpObjectFormat,
  MtpOperationCode,
  MtpResponseCode,
  MtpStorageAccessCapability,
  MtpStorageType,
} from "../../client/src/mtp/constants";
import {
  decodeObjectInfo,
  encodeObjectHandles,
  encodeObjectInfo,
  encodeStorageIds,
  encodeStorageInfo,
  makeUploadObjectInfo,
} from "../../client/src/mtp/datasets";
import {
  MtpObjectStore,
  MtpObjectStoreError,
  MtpPartialObjectError,
} from "../../client/src/mtp/object-store";
import { MtpSession } from "../../client/src/mtp/session";
import { FakeMtpBulkTransport, splitContainerStream } from "./fake-transport";

const STORAGE_ID = 0x0001_0001;
const DOCUMENTS_HANDLE = 0x0000_0042;
const CREATED_HANDLE = 0x1234_abcd;

function ok(transactionId: number, parameters: readonly number[] = []): Uint8Array {
  return encodeResponseContainer(MtpResponseCode.OK, transactionId, parameters);
}

function data(operationCode: number, transactionId: number, payload: Uint8Array): Uint8Array {
  return encodeDataContainer(operationCode, transactionId, payload);
}

async function openStore(reads: readonly Uint8Array[]) {
  const transport = new FakeMtpBulkTransport([ok(0), ...reads]);
  const session = new MtpSession(transport, {
    commandTimeoutMs: 200,
    inactivityTimeoutMs: 50,
  });
  await session.open();
  return { transport, session, store: new MtpObjectStore(session) };
}

function writtenContainers(transport: FakeMtpBulkTransport) {
  return splitContainerStream(transport.allWrittenBytes())
    .map((bytes) => decodeContainer(bytes));
}

describe("MtpObjectStore read operations", () => {
  it("enumerates storage, root handles, and complete object metadata", async () => {
    const storageInfo = {
      storageType: MtpStorageType.FixedRAM,
      filesystemType: MtpFilesystemType.GenericHierarchical,
      accessCapability: MtpStorageAccessCapability.ReadWrite,
      maxCapacity: 32_000_000_000n,
      freeSpaceInBytes: 12_000_000_000n,
      freeSpaceInImages: 0xffff_ffff,
      storageDescription: "Internal Storage",
      volumeLabel: "Kindle",
    } as const;
    const objectInfo = {
      ...makeUploadObjectInfo({
        storageId: STORAGE_ID,
        parentHandle: MTP_ROOT_PARENT,
        objectFormat: MtpObjectFormat.Association,
        compressedSize: 0,
        filename: "Documents",
      }),
      associationType: MtpAssociationType.GenericFolder,
    };
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetStorageIDs, 1, encodeStorageIds([STORAGE_ID])), ok(1),
      data(MtpOperationCode.GetStorageInfo, 2, encodeStorageInfo(storageInfo)), ok(2),
      data(MtpOperationCode.GetObjectHandles, 3, encodeObjectHandles([DOCUMENTS_HANDLE])), ok(3),
      data(MtpOperationCode.GetObjectInfo, 4, encodeObjectInfo(objectInfo)), ok(4),
    ]);

    await expect(store.listStorageIds()).resolves.toEqual([STORAGE_ID]);
    await expect(store.getStorageInfo(STORAGE_ID)).resolves.toEqual(storageInfo);
    await expect(store.listObjectHandles({
      storageId: STORAGE_ID,
      associationHandle: MTP_ROOT_PARENT,
    })).resolves.toEqual([DOCUMENTS_HANDLE]);
    await expect(store.getObjectInfo(DOCUMENTS_HANDLE)).resolves.toEqual({
      handle: DOCUMENTS_HANDLE,
      ...objectInfo,
    });

    const commands = writtenContainers(transport)
      .filter((container) => container.type === MtpContainerType.Command);
    expect(commands.map(({ code }) => code)).toEqual([
      MtpOperationCode.OpenSession,
      MtpOperationCode.GetStorageIDs,
      MtpOperationCode.GetStorageInfo,
      MtpOperationCode.GetObjectHandles,
      MtpOperationCode.GetObjectInfo,
    ]);
    expect(decodeContainerParameters(commands[3].payload)).toEqual([
      STORAGE_ID,
      0,
      MTP_ROOT_PARENT,
    ]);
  });

  it("reads exact bytes including NULs and enforces a caller read limit", async () => {
    const payload = Uint8Array.of(0, 0xff, 1, 2, 0, 3);
    const first = await openStore([
      data(MtpOperationCode.GetObject, 1, payload), ok(1),
    ]);
    await expect(first.store.readObject(7, { maxBytes: payload.byteLength }))
      .resolves.toEqual(payload);

    const second = await openStore([
      data(MtpOperationCode.GetObject, 1, payload), ok(1),
    ]);
    await expect(second.store.readObject(7, { maxBytes: payload.byteLength - 1 }))
      .rejects.toMatchObject({ code: "MTP_READ_LIMIT_EXCEEDED" });
  });

  it("rejects an oversized object-handle dataset from its header before inventory allocation", async () => {
    const { store } = await openStore([
      data(
        MtpOperationCode.GetObjectHandles,
        1,
        encodeObjectHandles([1, 2, 3]),
      ),
      ok(1),
    ]);

    await expect(store.listObjectHandles({
      storageId: STORAGE_ID,
      associationHandle: DOCUMENTS_HANDLE,
      maxHandles: 2,
    })).rejects.toMatchObject({
      code: "MTP_HANDLE_LIMIT_EXCEEDED",
    });
  });
});

describe("MtpObjectStore create and scoped delete", () => {
  it("sends ObjectInfo, streams exact object bytes, reports written progress, and deletes its handle", async () => {
    const payload = Uint8Array.of(0x41, 0, 0xf0, 0x9f, 0x98, 0x80, 0xff);
    const objectInfo = makeUploadObjectInfo({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      objectFormat: MtpObjectFormat.Text,
      compressedSize: payload.byteLength,
      filename: "kindle-webusb-poc.txt",
      modificationDate: "20260826T010203Z",
    });
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      ok(3),
      data(MtpOperationCode.GetObjectInfo, 4, encodeObjectInfo(objectInfo)), ok(4),
      data(MtpOperationCode.GetObject, 5, payload), ok(5),
      ok(6),
      data(MtpOperationCode.GetObjectHandles, 7, encodeObjectHandles([])), ok(7),
    ]);
    const progress = vi.fn();
    const objectStates = vi.fn();

    const created = await store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: objectInfo.filename,
      objectFormat: MtpObjectFormat.Text,
      size: payload.byteLength,
      data: payload,
      modificationDate: objectInfo.modificationDate,
      chunkSize: 3,
      onProgress: progress,
      onObjectState: objectStates,
    });
    expect(created).toEqual({
      handle: CREATED_HANDLE,
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: objectInfo.filename,
      size: payload.byteLength,
    });
    expect(store.createdHandles.has(CREATED_HANDLE)).toBe(true);
    await expect(store.getObjectInfo(CREATED_HANDLE)).resolves.toEqual({
      handle: CREATED_HANDLE,
      ...objectInfo,
    });
    await expect(store.readObject(CREATED_HANDLE)).resolves.toEqual(payload);
    await store.deleteObject(CREATED_HANDLE);
    expect(store.createdHandles.has(CREATED_HANDLE)).toBe(false);
    expect(progress.mock.calls.map(([entry]) => entry)).toEqual([
      { bytesTransferred: 3, totalBytes: 7 },
      { bytesTransferred: 6, totalBytes: 7 },
      { bytesTransferred: 7, totalBytes: 7 },
    ]);
    expect(objectStates.mock.calls.map(([entry]) => entry.stage)).toEqual([
      "send-object-info-intent",
      "handle-assigned",
      "cleanup-succeeded",
    ]);
    expect(objectStates.mock.calls[0]?.[0]).not.toHaveProperty("data");

    const containers = writtenContainers(transport);
    const commands = containers.filter(({ type }) => type === MtpContainerType.Command);
    expect(commands.map(({ code, transactionId }) => ({ code, transactionId }))).toEqual([
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
      { code: MtpOperationCode.GetObjectHandles, transactionId: 1 },
      { code: MtpOperationCode.SendObjectInfo, transactionId: 2 },
      { code: MtpOperationCode.SendObject, transactionId: 3 },
      { code: MtpOperationCode.GetObjectInfo, transactionId: 4 },
      { code: MtpOperationCode.GetObject, transactionId: 5 },
      { code: MtpOperationCode.DeleteObject, transactionId: 6 },
      { code: MtpOperationCode.GetObjectHandles, transactionId: 7 },
    ]);
    expect(decodeContainerParameters(commands[2].payload)).toEqual([
      STORAGE_ID,
      DOCUMENTS_HANDLE,
    ]);
    expect(decodeContainerParameters(commands[6].payload)).toEqual([CREATED_HANDLE, 0]);

    const outgoingData = containers.filter(({ type }) => type === MtpContainerType.Data);
    expect(outgoingData).toHaveLength(2);
    expect(decodeObjectInfo(outgoingData[0].payload)).toEqual(objectInfo);
    expect(outgoingData[1].payload).toEqual(payload);
  });

  it("removes the exact created handle after a synchronized SendObject failure", async () => {
    const incomplete = encodeResponseContainer(MtpResponseCode.IncompleteTransfer, 3);
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      incomplete,
      ok(4),
      data(MtpOperationCode.GetObjectHandles, 5, encodeObjectHandles([])), ok(5),
    ]);

    let caught: unknown;
    try {
      await store.createObject({
        storageId: STORAGE_ID,
        parentHandle: DOCUMENTS_HANDLE,
        filename: "partial.txt",
        size: 3,
        data: Uint8Array.of(1, 2, 3),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MtpPartialObjectError);
    expect(caught).toMatchObject({
      handle: CREATED_HANDLE,
      filename: "partial.txt",
      cleanupAttempted: true,
      cleanupSucceeded: true,
    });
    expect(store.createdHandles.size).toBe(0);

    const commands = writtenContainers(transport)
      .filter(({ type }) => type === MtpContainerType.Command);
    const deleteCommand = commands.find(({ code }) => code === MtpOperationCode.DeleteObject);
    expect(deleteCommand?.code).toBe(MtpOperationCode.DeleteObject);
    expect(decodeContainerParameters(deleteCommand!.payload)).toEqual([CREATED_HANDLE, 0]);
  });

  it("reports exact manual-cleanup metadata when a timeout faults the session", async () => {
    const { store } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      // No SendObject response: the fake waits until the inactivity timeout.
    ]);

    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "stranded.txt",
      size: 1,
      data: Uint8Array.of(1),
    })).rejects.toMatchObject({
      name: "MtpPartialObjectError",
      handle: CREATED_HANDLE,
      filename: "stranded.txt",
      cleanupAttempted: true,
      cleanupSucceeded: false,
    });
    expect(store.createdHandles.has(CREATED_HANDLE)).toBe(true);
  });

  it("retains recovery authority when DeleteObject is accepted but exact-handle absence is not verified", async () => {
    const { store } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      ok(3),
      ok(4),
      data(MtpOperationCode.GetObjectHandles, 5, encodeObjectHandles([CREATED_HANDLE])), ok(5),
    ]);
    const objectStates = vi.fn();
    await store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "still-present.txt",
      size: 1,
      data: Uint8Array.of(1),
      onObjectState: objectStates,
    });

    await expect(store.deleteObject(CREATED_HANDLE)).rejects.toMatchObject({
      code: "MTP_OBJECT_DELETE_UNVERIFIED",
    });
    expect(store.createdHandles.has(CREATED_HANDLE)).toBe(true);
    expect(objectStates.mock.calls.map(([event]) => event.stage)).toEqual([
      "send-object-info-intent",
      "handle-assigned",
    ]);
  });

  it("records a metadata-only intent before an ambiguous SendObjectInfo timeout", async () => {
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
    ]);
    const objectStates = vi.fn();

    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "unknown-handle.txt",
      size: 3,
      data: Uint8Array.of(7, 8, 9),
      onObjectState: objectStates,
    })).rejects.toBeDefined();

    expect(objectStates).toHaveBeenCalledOnce();
    expect(objectStates).toHaveBeenCalledWith({
      stage: "send-object-info-intent",
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "unknown-handle.txt",
      size: 3,
    });
    expect(objectStates.mock.calls[0]?.[0]).not.toHaveProperty("handle");
    expect(writtenContainers(transport).some(({ code }) => code === MtpOperationCode.SendObjectInfo)).toBe(true);
  });

  it("refuses to delete any handle not created by this object-store instance", async () => {
    const { store, transport } = await openStore([]);
    const writesBefore = transport.writes.length;
    await expect(store.deleteObject(0xdead_beef)).rejects.toBeInstanceOf(MtpObjectStoreError);
    await expect(store.deleteObject(0xffff_ffff)).rejects.toMatchObject({
      code: "MTP_OBJECT_NOT_OWNED",
    });
    expect(transport.writes).toHaveLength(writesBefore);
  });

  it("never deletes a reserved handle returned by a malformed SendObjectInfo response", async () => {
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, 0xffff_ffff]),
    ]);
    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "reserved.txt",
      size: 0,
      data: new Uint8Array(),
    })).rejects.toMatchObject({ code: "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE" });

    const commands = writtenContainers(transport)
      .filter(({ type }) => type === MtpContainerType.Command);
    expect(commands.map(({ code }) => code)).toEqual([
      MtpOperationCode.OpenSession,
      MtpOperationCode.GetObjectHandles,
      MtpOperationCode.SendObjectInfo,
    ]);
    expect(store.createdHandles.size).toBe(0);
  });

  it("cleans up when SendObjectInfo returns a mismatched destination", async () => {
    const { store } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID + 1, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      ok(3),
      data(MtpOperationCode.GetObjectHandles, 4, encodeObjectHandles([])), ok(4),
    ]);
    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "mismatch.txt",
      size: 0,
      data: new Uint8Array(),
    })).rejects.toMatchObject({
      name: "MtpPartialObjectError",
      cleanupSucceeded: true,
      handle: CREATED_HANDLE,
    });
  });

  it("never deletes a pre-existing unowned handle returned by SendObjectInfo", async () => {
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([CREATED_HANDLE])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
    ]);

    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "must-not-delete-existing.txt",
      size: 1,
      data: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE" });

    const codes = writtenContainers(transport)
      .filter(({ type }) => type === MtpContainerType.Command)
      .map(({ code }) => code);
    expect(codes).toEqual([
      MtpOperationCode.OpenSession,
      MtpOperationCode.GetObjectHandles,
      MtpOperationCode.SendObjectInfo,
    ]);
    expect(codes).not.toContain(MtpOperationCode.DeleteObject);
    expect(store.createdHandles.size).toBe(0);
  });

  it("never reuses or deletes a live handle already owned by this session", async () => {
    const { store, transport } = await openStore([
      data(MtpOperationCode.GetObjectHandles, 1, encodeObjectHandles([])), ok(1),
      ok(2, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
      ok(3),
      data(MtpOperationCode.GetObjectHandles, 4, encodeObjectHandles([CREATED_HANDLE])), ok(4),
      ok(5, [STORAGE_ID, DOCUMENTS_HANDLE, CREATED_HANDLE]),
    ]);
    await store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "first-live.txt",
      size: 1,
      data: Uint8Array.of(1),
    });

    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "second-must-not-overwrite.txt",
      size: 1,
      data: Uint8Array.of(2),
    })).rejects.toMatchObject({ code: "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE" });

    const codes = writtenContainers(transport)
      .filter(({ type }) => type === MtpContainerType.Command)
      .map(({ code }) => code);
    expect(codes.filter((code) => code === MtpOperationCode.SendObject)).toHaveLength(1);
    expect(codes).not.toContain(MtpOperationCode.DeleteObject);
    expect(store.createdHandles).toEqual(new Set([CREATED_HANDLE]));
  });

  it("validates filenames and known payload lengths before creating an object", async () => {
    const { store, transport } = await openStore([]);
    const writesBefore = transport.writes.length;
    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "../unsafe.txt",
      size: 1,
      data: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: "MTP_UNSAFE_FILENAME" });
    await expect(store.createObject({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      filename: "wrong-size.txt",
      size: 2,
      data: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: "MTP_OBJECT_DATA_SIZE_MISMATCH" });
    expect(transport.writes).toHaveLength(writesBefore);
  });
});
