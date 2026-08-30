import { describe, expect, it, vi } from "vitest";
import {
  KindleDevice,
  MTP_OBJECT_FORMAT_ASSOCIATION,
  MTP_ROOT_ASSOCIATION_HANDLE,
} from "../../client/src/kindle/kindle-device";
import { KINDLE_SELF_TEST_PAYLOAD } from "../../client/src/kindle/self-test-payload";
import { toAppError } from "../../client/src/app-error";
import { MTP_CONTAINER_HEADER_SIZE } from "../../client/src/mtp/constants";
import { MtpPartialObjectError } from "../../client/src/mtp/object-store";
import { MtpSessionError } from "../../client/src/mtp/session";
import { UsbTransportError } from "../../client/src/usb/errors";
import {
  FakeKindleObjectStore,
  objectInfo,
  storageInfo,
} from "./fake-store";

const FIXED_DATE = new Date("2026-08-26T12:34:56Z");

function kindle(store: FakeKindleObjectStore): KindleDevice {
  return new KindleDevice(store, {
    now: () => FIXED_DATE,
    random: () => 0,
  });
}

describe("KindleDevice policy", () => {
  it("chooses writable storage with enough space and case-insensitive Documents", async () => {
    const store = new FakeKindleObjectStore();
    store.storages.set(1, storageInfo({ accessCapability: 1 }));
    store.storages.set(2, storageInfo({ freeSpaceInBytes: 20_000_000n }));
    store.objects.set(
      20,
      objectInfo(20, {
        storageId: 2,
        objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
        associationType: 1,
        parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        filename: "dOcUmEnTs",
      }),
    );

    await expect(kindle(store).inspect(1_000)).resolves.toMatchObject({
      storageId: 2,
      documentsHandle: 20,
    });
  });

  it("does not accept a plain file named Documents", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(
      10,
      objectInfo(10, {
        parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        filename: "Documents",
        objectFormat: 0x3000,
      }),
    );

    await expect(kindle(store).inspect()).rejects.toMatchObject({
      code: "MTP_DOCUMENTS_NOT_FOUND",
    });
  });

  it("rejects read-only storage", async () => {
    const store = new FakeKindleObjectStore();
    store.storages.set(1, storageInfo({ accessCapability: 1 }));

    await expect(kindle(store).inspect()).rejects.toMatchObject({
      code: "MTP_STORAGE_NOT_WRITABLE",
    });
  });

  it("checks refreshed free space before creating an object", async () => {
    const store = new FakeKindleObjectStore();
    const device = kindle(store);
    await device.inspect();
    store.storages.set(1, storageInfo({ freeSpaceInBytes: 2n }));

    await expect(
      device.sendAzW3(new Blob([new Uint8Array(8)]), "fixture.azw3"),
    ).rejects.toMatchObject({ code: "MTP_INSUFFICIENT_SPACE" });
    expect(store.createRequests).toHaveLength(0);
  });

  it("round-trips exact boundary payload bytes and deletes only its handle", async () => {
    const store = new FakeKindleObjectStore();
    const device = kindle(store);

    const result = await device.runSelfTest();

    expect(KINDLE_SELF_TEST_PAYLOAD.byteLength + MTP_CONTAINER_HEADER_SIZE).toBe(1_024);
    expect(result).toMatchObject({
      handle: 100,
      bytesVerified: KINDLE_SELF_TEST_PAYLOAD.byteLength,
      cleanedUp: true,
    });
    expect(result.filename).toMatch(
      /^kindle-webusb-poc-20260826T123456Z-000000\.txt$/,
    );
    expect(store.createRequests[0]?.data).toEqual(KINDLE_SELF_TEST_PAYLOAD);
    expect(store.deletedHandles).toEqual([100]);
    expect(store.objects.has(100)).toBe(false);
    expect(store.objects.has(10)).toBe(true);
  });

  it("cleans up the exact created handle after a readback mismatch", async () => {
    const store = new FakeKindleObjectStore();
    store.corruptReadback = true;

    await expect(kindle(store).runSelfTest()).rejects.toMatchObject({
      code: "MTP_READBACK_MISMATCH",
    });
    expect(store.deletedHandles).toEqual([100]);
    expect(store.objects.has(10)).toBe(true);
  });

  it("reports exact manual cleanup details when deletion fails", async () => {
    const store = new FakeKindleObjectStore();
    store.corruptReadback = true;
    store.failDelete = true;

    await expect(kindle(store).runSelfTest()).rejects.toMatchObject({
      code: "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
      details: {
        createdHandle: 100,
        filename: "kindle-webusb-poc-20260826T123456Z-000000.txt",
      },
    });
    expect(store.objects.has(100)).toBe(true);
  });

  it("does not delete twice when the MTP store already cleaned a partial upload", async () => {
    const store = new FakeKindleObjectStore();
    const partialError = Object.assign(new Error("partial upload cleaned"), {
      handle: 100,
      filename: "partial.txt",
      cleanupAttempted: true,
      cleanupSucceeded: true,
    });
    store.createObject = vi.fn().mockRejectedValue(partialError);
    store.deleteObject = vi.fn(store.deleteObject.bind(store));

    await expect(kindle(store).runSelfTest()).rejects.toBe(partialError);
    expect(store.deleteObject).not.toHaveBeenCalled();
  });

  it("reports the MTP store's failed bounded cleanup without retrying deletion", async () => {
    const store = new FakeKindleObjectStore();
    const partialError = Object.assign(new Error("partial upload remains"), {
      handle: 321,
      filename: "exact-partial.txt",
      cleanupAttempted: true,
      cleanupSucceeded: false,
      cleanupError: new Error("device disconnected"),
    });
    store.createObject = vi.fn().mockRejectedValue(partialError);
    store.deleteObject = vi.fn(store.deleteObject.bind(store));

    await expect(kindle(store).runSelfTest()).rejects.toMatchObject({
      code: "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
      details: {
        createdHandle: 321,
        filename: "exact-partial.txt",
        cleanupError: "device disconnected",
      },
    });
    expect(store.deleteObject).not.toHaveBeenCalled();
  });

  it("preserves an upload stall's MTP transaction and USB endpoint context through cleanup", async () => {
    const store = new FakeKindleObjectStore();
    const usbFailure = new UsbTransportError(
      "USB_ENDPOINT_STALLED",
      "bulk OUT endpoint stalled",
      {
        endpointNumber: 6,
        direction: "out",
        interfaceNumber: 4,
        configurationValue: 1,
      },
    );
    const uploadFailure = new MtpSessionError(
      "MTP_TRANSPORT_ERROR",
      "SendObject data phase failed",
      {
        context: {
          operationCode: 0x100d,
          expectedTransactionId: 7,
          transportCode: usbFailure.code,
          transportDetails: usbFailure.details,
        },
        cause: usbFailure,
      },
    );
    const cleanupFailure = new MtpSessionError(
      "MTP_INVALID_STATE",
      "The faulted session could not issue DeleteObject",
      {
        context: { operationCode: 0x100b, expectedTransactionId: 8 },
        cause: uploadFailure,
      },
    );
    const partialError = new MtpPartialObjectError({
      handle: 321,
      filename: "stalled-partial.txt",
      cause: uploadFailure,
      cleanupAttempted: true,
      cleanupSucceeded: false,
      cleanupError: cleanupFailure,
    });
    store.createObject = vi.fn().mockRejectedValue(partialError);
    store.deleteObject = vi.fn(store.deleteObject.bind(store));

    let caught: unknown;
    try {
      await kindle(store).runSelfTest();
    } catch (error) {
      caught = toAppError(error);
    }

    expect(caught).toMatchObject({
      code: "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
      details: {
        createdHandle: 321,
        filename: "stalled-partial.txt",
        transportCode: "USB_ENDPOINT_STALLED",
        transportDetails: {
          endpointNumber: 6,
          direction: "out",
          interfaceNumber: 4,
          configurationValue: 1,
        },
        originalFailure: {
          code: "MTP_TRANSPORT_ERROR",
          context: {
            operationCode: 0x100d,
            expectedTransactionId: 7,
            transportCode: "USB_ENDPOINT_STALLED",
          },
        },
        cleanupFailure: {
          code: "MTP_INVALID_STATE",
          context: {
            operationCode: 0x100b,
            expectedTransactionId: 8,
          },
        },
      },
    });
    expect(store.deleteObject).not.toHaveBeenCalled();
  });

  it("uploads an AZW3 with progress and verifies its object metadata", async () => {
    const store = new FakeKindleObjectStore();
    const progress = vi.fn();
    const objectStates = vi.fn();
    const blob = new Blob([Uint8Array.from([1, 2, 3, 4])]);

    const result = await kindle(store).sendAzW3(blob, "My Book.epub", {
      onProgress: progress,
      onObjectState: objectStates,
    });

    expect(result).toEqual({
      filename: "My-Book-20260826T123456Z-000000.azw3",
      handle: 100,
      size: 4,
      storageId: 1,
      parentHandle: 10,
      verified: true,
    });
    expect(progress).toHaveBeenCalledWith({
      bytesTransferred: 4,
      totalBytes: 4,
    });
    expect(store.deletedHandles).toEqual([]);
    expect(objectStates.mock.calls.map(([entry]) => entry.stage)).toEqual([
      "send-object-info-intent",
      "handle-assigned",
      "verified",
    ]);
    expect(objectStates.mock.calls.at(-1)?.[0]).toMatchObject({
      handle: 100,
      filename: result.filename,
      size: 4,
    });
  });

  it("embeds a stable managed token without weakening collision resistance", async () => {
    const store = new FakeKindleObjectStore();
    const managedToken = "kb-0123456789abcdefabcd";

    const result = await kindle(store).sendAzW3(
      new Blob([Uint8Array.from([1, 2, 3, 4])]),
      "Managed Book.epub",
      { managedToken },
    );

    expect(result).toMatchObject({
      filename: "Managed-Book-kb-0123456789abcdefabcd-20260826T123456Z-000000.azw3",
      managedToken,
      verified: true,
    });
  });

  it("supports a current-session self-test followed by multiple sends and inventory refresh", async () => {
    const store = new FakeKindleObjectStore();
    const device = kindle(store);

    await device.runSelfTest();
    const first = await device.sendAzW3(
      new Blob([Uint8Array.from([1])]),
      "First.epub",
      { managedToken: "kb-11111111111111111111" },
    );
    const second = await device.sendAzW3(
      new Blob([Uint8Array.from([2, 3])]),
      "Second.epub",
      { managedToken: "kb-22222222222222222222" },
    );
    const inventory = await device.inventory();

    expect(first.handle).not.toBe(second.handle);
    expect(inventory.status).toBe("complete");
    expect(inventory.objects.filter(({ kind }) => kind === "file")).toEqual([
      expect.objectContaining({
        handle: first.handle,
        managedToken: first.managedToken,
        size: 1,
      }),
      expect.objectContaining({
        handle: second.handle,
        managedToken: second.managedToken,
        size: 2,
      }),
    ]);
    expect(store.deletedHandles).toEqual([100]);
  });

  it("removes a created AZW3 if post-upload metadata verification fails", async () => {
    const store = new FakeKindleObjectStore();
    store.metadataMutation = (info) => ({
      ...info,
      parentHandle: 999,
    });

    await expect(
      kindle(store).sendAzW3(new Blob([new Uint8Array(8)]), "fixture.azw3"),
    ).rejects.toMatchObject({ code: "MTP_OBJECT_VERIFICATION_FAILED" });
    expect(store.deletedHandles).toEqual([100]);
  });

  it("refuses collisions instead of overwriting an existing object", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(
      11,
      objectInfo(11, {
        parentHandle: 10,
        filename: "My-Book-20260826T123456Z-000000.azw3",
        compressedSize: 20,
      }),
    );

    await expect(
      kindle(store).sendAzW3(new Blob([new Uint8Array(8)]), "My Book.epub"),
    ).rejects.toMatchObject({ code: "MTP_FILENAME_COLLISION" });
    expect(store.createRequests).toHaveLength(0);
    expect(store.objects.has(11)).toBe(true);
  });
});
