import { describe, expect, it, vi } from "vitest";
import {
  ConnectedKindle,
  type DeviceRuntimeHooks,
  openKindle,
} from "../../client/src/device-runtime";
import { KINDLE_SELF_TEST_PAYLOAD } from "../../client/src/kindle/self-test-payload";
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
  encodeDeviceInfo,
  encodeObjectHandles,
  encodeObjectInfo,
  encodeStorageIds,
  encodeStorageInfo,
  makeUploadObjectInfo,
} from "../../client/src/mtp/datasets";
import type { DeviceDetails } from "../../client/src/state";
import {
  FakeUsbDevice,
  FakeUsbManager,
} from "../usb/fakes";

const STORAGE_ID = 0x0001_0001;
const DOCUMENTS_HANDLE = 0x0000_0042;
const MTP_SERIAL = "MTP-SERIAL-000042";
const IDENTITY_SECRET = new Uint8Array(32).fill(0x42);

const DEVICE_INFO = {
  standardVersion: 100,
  vendorExtensionId: 6,
  vendorExtensionVersion: 100,
  vendorExtensionDescription: "microsoft.com: 1.0;",
  functionalMode: 0,
  operationsSupported: [
    MtpOperationCode.GetDeviceInfo,
    MtpOperationCode.OpenSession,
    MtpOperationCode.CloseSession,
    MtpOperationCode.GetStorageIDs,
    MtpOperationCode.GetStorageInfo,
    MtpOperationCode.GetObjectHandles,
    MtpOperationCode.GetObjectInfo,
  ],
  eventsSupported: [],
  devicePropertiesSupported: [],
  captureFormats: [],
  imageFormats: [],
  manufacturer: "Amazon MTP",
  model: "Kindle integration fixture",
  deviceVersion: "1.0",
  serialNumber: MTP_SERIAL,
} as const;

const STORAGE_INFO = {
  storageType: MtpStorageType.FixedRAM,
  filesystemType: MtpFilesystemType.GenericHierarchical,
  accessCapability: MtpStorageAccessCapability.ReadWrite,
  maxCapacity: 32_000_000_000n,
  freeSpaceInBytes: 12_000_000_000n,
  freeSpaceInImages: 0xffff_ffff,
  storageDescription: "Internal Storage",
  volumeLabel: "Kindle",
} as const;

const DOCUMENTS_INFO = {
  ...makeUploadObjectInfo({
    storageId: STORAGE_ID,
    parentHandle: MTP_ROOT_PARENT,
    objectFormat: MtpObjectFormat.Association,
    compressedSize: 0,
    filename: "Documents",
  }),
  associationType: MtpAssociationType.GenericFolder,
} as const;

function ok(
  transactionId: number,
  responseCode = MtpResponseCode.OK,
): Uint8Array {
  return encodeResponseContainer(responseCode, transactionId);
}

function data(
  operationCode: number,
  transactionId: number,
  payload: Uint8Array,
): Uint8Array {
  return encodeDataContainer(operationCode, transactionId, payload);
}

function queueIncoming(device: FakeUsbDevice, ...phases: readonly Uint8Array[]): void {
  for (const phase of phases) {
    const copy = phase.slice();
    device.inResults.push({
      status: "ok",
      data: new DataView(copy.buffer),
    });
  }
}

function writtenCommands(device: FakeUsbDevice) {
  return device.writes
    .filter((bytes) => bytes.byteLength >= 12)
    .map((bytes) => decodeContainer(bytes))
    .filter((container) => container.type === MtpContainerType.Command);
}

function commandSummary(device: FakeUsbDevice): Array<{
  code: number;
  transactionId: number;
}> {
  return writtenCommands(device).map(({ code, transactionId }) => ({
    code,
    transactionId,
  }));
}

function deviceInfoExchange(): Uint8Array[] {
  return [
    data(MtpOperationCode.GetDeviceInfo, 0, encodeDeviceInfo(DEVICE_INFO)),
    ok(0),
  ];
}

function successfulInspectionExchange(): Uint8Array[] {
  return [
    data(MtpOperationCode.GetStorageIDs, 1, encodeStorageIds([STORAGE_ID])),
    ok(1),
    data(MtpOperationCode.GetStorageInfo, 2, encodeStorageInfo(STORAGE_INFO)),
    ok(2),
    data(
      MtpOperationCode.GetObjectHandles,
      3,
      encodeObjectHandles([DOCUMENTS_HANDLE]),
    ),
    ok(3),
    data(MtpOperationCode.GetObjectInfo, 4, encodeObjectInfo(DOCUMENTS_INFO)),
    ok(4),
  ];
}

async function expectedIdentityKey(device: FakeUsbDevice): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(IDENTITY_SECRET).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const material = new TextEncoder().encode(
    `kindle-device-identity-v2\u0000${device.vendorId}\u0000${device.productId}\u0000${MTP_SERIAL}`,
  );
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, material);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("openKindle cross-layer orchestration", () => {
  it("does not open WebUSB when cancellation wins as the device lease settles", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const controller = new AbortController();
    const release = vi.fn(async () => undefined);
    const leaseProvider = {
      acquire: vi.fn(async () => {
        controller.abort(new DOMException("cancelled after lease", "AbortError"));
        return {
          scope: "browser" as const,
          released: false,
          release,
        };
      }),
    };

    await expect(openKindle(device, {
      onDescriptor: () => undefined,
      onUsbOpen: () => undefined,
      onMtpReading: () => undefined,
    }, usb, {
      signal: controller.signal,
      leaseProvider,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(device.calls).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains the cross-tab writer lease until late native USB work really settles", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: false, close: vi.fn(async () => undefined) };
    let resolveNative!: () => void;
    let pending = true;
    const nativeSettled = new Promise<void>((resolve) => { resolveNative = resolve; });
    const transport = {
      close: vi.fn(async () => undefined),
      get hasPendingNativeOperations() { return pending; },
      waitForNativeOperations: vi.fn(async () => {
        await nativeSettled;
        pending = false;
      }),
    };
    const lease = { release: vi.fn(async () => undefined) };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId },
      transport as never,
      session as never,
      {} as never,
      lease as never,
    );

    await connection.disconnect();

    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.waitForNativeOperations).toHaveBeenCalledOnce();
    expect(lease.release).not.toHaveBeenCalled();
    resolveNative();
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledOnce());
  });

  it("bounds the complete exact-byte self-test across collision discovery", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    let abortReason: unknown;
    const kindle = {
      runSelfTest: vi.fn((options: { readonly signal?: AbortSignal } = {}) => new Promise((_, reject) => {
        const abort = (): void => {
          abortReason = options.signal?.reason;
          reject(options.signal?.reason);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      })),
    };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId, documentsHandle: DOCUMENTS_HANDLE },
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );

    const startedAt = performance.now();
    await expect(connection.runSelfTest({ aggregateTimeoutMs: 15 })).rejects.toMatchObject({
      name: "TimeoutError",
    });

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(abortReason).toMatchObject({ name: "TimeoutError" });
    expect(connection.readyForSend).toBe(false);
    await connection.disconnect();
  });

  it("keeps the programmatic partial-object probe opt-in and outside normal runtime work", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    const source = Uint8Array.from({ length: 32 }, (_, index) => index);
    const readObjectRange = vi.fn(async (
      request: { readonly offset: number; readonly length: number },
    ) => source.slice(request.offset, request.offset + request.length));
    const kindle = { store: { readObjectRange } };
    const details = {
      vendorId: device.vendorId,
      productId: device.productId,
      operationsSupported: [MtpOperationCode.GetPartialObject, 0x9805],
    };
    const ordinaryConnection = new ConnectedKindle(
      device,
      details,
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );

    await expect(ordinaryConnection.runDevelopmentPartialObjectProbe({
      handle: 7,
      objectSize: source.byteLength,
      sampleBytes: 8,
    })).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_DISABLED" });
    expect(readObjectRange).not.toHaveBeenCalled();

    const enabledConnection = new ConnectedKindle(
      device,
      details,
      transport as never,
      session as never,
      kindle as never,
      lease as never,
      undefined,
      undefined,
      true,
    );
    await expect(enabledConnection.runDevelopmentPartialObjectProbe({
      handle: 7,
      objectSize: source.byteLength,
      sampleBytes: 8,
    })).resolves.toMatchObject({
      operationCode: MtpOperationCode.GetPartialObject,
      operationAdvertised: true,
      repeatBytesVerified: 8,
    });
    expect(readObjectRange).toHaveBeenCalledTimes(7);
    await expect(enabledConnection.runDevelopmentPartialObjectProbe({
      handle: 7,
      objectSize: source.byteLength,
      sampleBytes: 8,
    })).rejects.toMatchObject({ code: "KINDLE_PARTIAL_OBJECT_PROBE_ALREADY_RUN" });
    await expect(enabledConnection.runDevelopmentPartialObjectProbe({
      handle: 7,
      objectSize: source.byteLength,
      sampleBytes: 8,
    }, { allowRepeat: true })).resolves.toMatchObject({ repeatBytesVerified: 8 });
    expect(readObjectRange).toHaveBeenCalledTimes(14);
  });

  it("refuses a writable Kindle metadata-cache refresh until this connection passes self-test", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    const inventory = {
      status: "complete" as const,
      storageId: STORAGE_ID,
      documentsHandle: DOCUMENTS_HANDLE,
      objects: [],
      issues: [],
      issueCount: 0,
      scannedObjectCount: 0,
    };
    const kindle = {
      runSelfTest: vi.fn(async () => ({
        filename: "kindle-poc-byte-test.txt",
        handle: 70,
        bytesVerified: KINDLE_SELF_TEST_PAYLOAD.byteLength,
        cleanedUp: true as const,
      })),
      inventory: vi.fn(async () => inventory),
    };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId, documentsHandle: DOCUMENTS_HANDLE },
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );

    await expect(connection.refreshInventory({
      deviceMetadataCache: "read-write",
    })).rejects.toMatchObject({ code: "MTP_SELF_TEST_REQUIRED" });
    expect(kindle.inventory).not.toHaveBeenCalled();

    await expect(connection.refreshInventory({
      deviceMetadataCache: "read-only",
    })).resolves.toEqual(inventory);
    await connection.runSelfTest();
    await expect(connection.refreshInventory({
      deviceMetadataCache: "read-write",
    })).resolves.toEqual(inventory);

    await connection.disconnect();
  });

  it("removes selected handles sequentially under one device operation and refreshes inventory once", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    const initialInventory = {
      status: "complete" as const,
      storageId: STORAGE_ID,
      documentsHandle: DOCUMENTS_HANDLE,
      objects: [{ handle: 11 }, { handle: 12 }],
      issues: [],
      issueCount: 0,
      scannedObjectCount: 2,
    } as never;
    const refreshedInventory = {
      status: "complete" as const,
      storageId: STORAGE_ID,
      documentsHandle: DOCUMENTS_HANDLE,
      objects: [],
      issues: [],
      issueCount: 0,
      scannedObjectCount: 0,
    } as never;
    const removals = [
      { handle: 11, storageId: STORAGE_ID, parentHandle: DOCUMENTS_HANDLE, filename: "a.azw3", size: 1, objectFormat: 0x3000, removed: true as const },
      { handle: 12, storageId: STORAGE_ID, parentHandle: DOCUMENTS_HANDLE, filename: "b.mobi", size: 2, objectFormat: 0x3000, removed: true as const },
    ];
    const kindle = {
      runSelfTest: vi.fn(async () => ({
        filename: "kindle-poc-byte-test.txt",
        handle: 70,
        bytesVerified: KINDLE_SELF_TEST_PAYLOAD.byteLength,
        cleanedUp: true as const,
      })),
      inventory: vi.fn()
        .mockResolvedValueOnce(initialInventory)
        .mockResolvedValueOnce(refreshedInventory),
      removeBooks: vi.fn(async () => removals),
    };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId, documentsHandle: DOCUMENTS_HANDLE },
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );

    await connection.runSelfTest();
    await connection.refreshInventory();
    await expect(connection.removeBooksAndRefreshInventory([11, 12])).resolves.toEqual({
      removals,
      inventory: refreshedInventory,
      inventoryRefresh: "complete",
    });
    expect(kindle.removeBooks).toHaveBeenCalledWith(
      initialInventory,
      [11, 12],
      {},
    );
    expect(kindle.inventory).toHaveBeenCalledTimes(2);
    expect(connection.latestInventory).toBe(refreshedInventory);

    await connection.disconnect();
  });

  it("bounds the complete book transaction before an unbounded collision scan can upload", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    let abortReason: unknown;
    const kindle = {
      runSelfTest: vi.fn(async () => ({
        filename: "kindle-poc-byte-test.txt",
        handle: 70,
        bytesVerified: KINDLE_SELF_TEST_PAYLOAD.byteLength,
        cleanedUp: true as const,
      })),
      sendAzW3: vi.fn((_blob: Blob, _filename: string, options: { readonly signal?: AbortSignal } = {}) => (
        new Promise((_, reject) => {
          const abort = (): void => {
            abortReason = options.signal?.reason;
            reject(options.signal?.reason);
          };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        })
      )),
    };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId, documentsHandle: DOCUMENTS_HANDLE },
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );
    await connection.runSelfTest();

    const startedAt = performance.now();
    await expect(connection.sendAzW3AndRefreshInventory(
      new Blob(["book"]),
      "bounded.azw3",
      { aggregateTimeoutMs: 15 },
    )).rejects.toMatchObject({ name: "TimeoutError" });

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(abortReason).toMatchObject({ name: "TimeoutError" });
    expect(kindle.sendAzW3).toHaveBeenCalledOnce();
    await connection.disconnect();
  });

  it("bounds the whole post-upload inventory refresh without making a verified transfer ambiguous", async () => {
    const device = new FakeUsbDevice();
    const session = { isOpen: true, close: vi.fn(async () => undefined) };
    const transport = { close: vi.fn(async () => undefined) };
    const lease = { release: vi.fn(async () => undefined) };
    let inventoryAbort: unknown;
    const kindle = {
      runSelfTest: vi.fn(async () => ({
        filename: "kindle-poc-byte-test.txt",
        handle: 70,
        bytesVerified: KINDLE_SELF_TEST_PAYLOAD.byteLength,
        cleanedUp: true as const,
      })),
      sendAzW3: vi.fn(async (blob: Blob, filename: string) => ({
        storageId: STORAGE_ID,
        parentHandle: DOCUMENTS_HANDLE,
        handle: 71,
        filename,
        size: blob.size,
        verified: true as const,
      })),
      inventory: vi.fn((options: { readonly signal?: AbortSignal } = {}) => new Promise((_, reject) => {
        const signal = options.signal;
        if (!signal) return;
        const rejectAbort = (): void => {
          inventoryAbort = signal.reason;
          reject(signal.reason);
        };
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      })),
    };
    const connection = new ConnectedKindle(
      device,
      { vendorId: device.vendorId, productId: device.productId, documentsHandle: DOCUMENTS_HANDLE },
      transport as never,
      session as never,
      kindle as never,
      lease as never,
    );
    await connection.runSelfTest();

    const startedAt = performance.now();
    const result = await connection.sendAzW3AndRefreshInventory(
      new Blob(["verified bytes"]),
      "bounded.azw3",
      {},
      { aggregateTimeoutMs: 15 },
    );

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result).toMatchObject({
      transfer: { handle: 71, filename: "bounded.azw3", verified: true },
      inventoryRefresh: "failed",
    });
    expect(result.connectionFaulted).toBeUndefined();
    expect(inventoryAbort).toMatchObject({ name: "TimeoutError" });
    expect(connection.readyForSend).toBe(true);

    await connection.disconnect();
    expect(session.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("captures descriptors, opens MTP in protocol order, derives identity, and discovers Documents", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const checkpoints: Array<{
      stage: string;
      usbCalls: string[];
      commands: Array<{ code: number; transactionId: number }>;
      details: DeviceDetails;
      descriptor?: Readonly<Record<string, unknown>>;
    }> = [];
    const hooks: DeviceRuntimeHooks = {
      onDescriptor: (details, descriptor) => checkpoints.push({
        stage: "descriptor",
        usbCalls: [...device.calls],
        commands: commandSummary(device),
        details,
        descriptor,
      }),
      onUsbOpen: (details) => checkpoints.push({
        stage: "usb-open",
        usbCalls: [...device.calls],
        commands: commandSummary(device),
        details,
      }),
      onMtpReading: (details) => checkpoints.push({
        stage: "mtp-reading",
        usbCalls: [...device.calls],
        commands: commandSummary(device),
        details,
      }),
    };
    queueIncoming(
      device,
      ...deviceInfoExchange(),
      ok(0),
      ...successfulInspectionExchange(),
      // Consumed by the explicit disconnect below.
      ok(5),
    );

    const connection = await openKindle(device, hooks, usb, {
      commandTimeoutMs: 500,
      inactivityTimeoutMs: 100,
      identitySecretProvider: {
        async getSecret() {
          return { bytes: IDENTITY_SECRET, stability: "installation" };
        },
      },
    });

    expect(checkpoints.map(({ stage }) => stage)).toEqual([
      "descriptor",
      "usb-open",
      "mtp-reading",
    ]);
    expect(checkpoints[0]).toMatchObject({
      usbCalls: [],
      commands: [],
      details: {
        vendorId: 0x1949,
        productId: 0x9981,
        serialNumber: "********1234",
      },
      descriptor: {
        vendorId: 0x1949,
        productId: 0x9981,
        maskedSerialNumber: "********1234",
        configurations: [{
          configurationValue: 7,
          active: false,
          interfaces: expect.arrayContaining([
            expect.objectContaining({
              interfaceNumber: 4,
              selectedAlternateSetting: 0,
            }),
          ]),
        }],
      },
    });
    expect(checkpoints[1]).toMatchObject({
      usbCalls: [
        "open",
        "configuration:7",
        "claim:4",
        "alternate:4:2",
      ],
      commands: [],
      details: {
        configurationValue: 7,
        interfaceNumber: 4,
        alternateSetting: 2,
        bulkInEndpoint: 5,
        bulkOutEndpoint: 6,
      },
    });
    expect(checkpoints[2]?.commands).toEqual([
      { code: MtpOperationCode.GetDeviceInfo, transactionId: 0 },
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
    ]);
    expect(checkpoints[2]?.details).toMatchObject({
      manufacturerName: "Amazon MTP",
      model: "Kindle integration fixture",
      serialNumber: "********0042",
    });

    expect(commandSummary(device)).toEqual([
      { code: MtpOperationCode.GetDeviceInfo, transactionId: 0 },
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
      { code: MtpOperationCode.GetStorageIDs, transactionId: 1 },
      { code: MtpOperationCode.GetStorageInfo, transactionId: 2 },
      { code: MtpOperationCode.GetObjectHandles, transactionId: 3 },
      { code: MtpOperationCode.GetObjectInfo, transactionId: 4 },
    ]);
    expect(decodeContainerParameters(writtenCommands(device)[1]!.payload)).toEqual([1]);
    expect(connection.details).toMatchObject({
      storageId: STORAGE_ID,
      storageDescription: "Internal Storage",
      capacityBytes: 32_000_000_000n,
      freeBytes: 12_000_000_000n,
      documentsHandle: DOCUMENTS_HANDLE,
    });
    expect(connection.identityKey).toBe(await expectedIdentityKey(device));
    expect(connection.identityKeyStability).toBe("installation");
    expect(connection.identityKey).not.toContain(MTP_SERIAL);

    await connection.disconnect();
    expect(commandSummary(device).at(-1)).toEqual({
      code: MtpOperationCode.CloseSession,
      transactionId: 5,
    });
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
    expect(device.opened).toBe(false);
  });

  it("releases the claimed interface and closes USB when OpenSession fails", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const hookStages: string[] = [];
    queueIncoming(
      device,
      ...deviceInfoExchange(),
      ok(0, MtpResponseCode.GeneralError),
    );

    await expect(openKindle(device, {
      onDescriptor: () => hookStages.push("descriptor"),
      onUsbOpen: () => hookStages.push("usb-open"),
      onMtpReading: () => hookStages.push("mtp-reading"),
    }, usb, {
      commandTimeoutMs: 500,
      inactivityTimeoutMs: 100,
    })).rejects.toMatchObject({
      code: "MTP_RESPONSE_ERROR",
      responseCode: MtpResponseCode.GeneralError,
    });

    expect(hookStages).toEqual(["descriptor", "usb-open"]);
    expect(commandSummary(device)).toEqual([
      { code: MtpOperationCode.GetDeviceInfo, transactionId: 0 },
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
    ]);
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
    expect(device.opened).toBe(false);
  });

  it("closes the open MTP session before releasing USB when Documents inspection fails", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    queueIncoming(
      device,
      ...deviceInfoExchange(),
      ok(0),
      data(MtpOperationCode.GetStorageIDs, 1, encodeStorageIds([STORAGE_ID])),
      ok(1),
      data(MtpOperationCode.GetStorageInfo, 2, encodeStorageInfo(STORAGE_INFO)),
      ok(2),
      data(MtpOperationCode.GetObjectHandles, 3, encodeObjectHandles([])),
      ok(3),
      // Cleanup must use the next in-session transaction ID.
      ok(4),
    );

    await expect(openKindle(device, {
      onDescriptor: () => undefined,
      onUsbOpen: () => undefined,
      onMtpReading: () => undefined,
    }, usb, {
      commandTimeoutMs: 500,
      inactivityTimeoutMs: 100,
    })).rejects.toMatchObject({ code: "MTP_DOCUMENTS_NOT_FOUND" });

    expect(commandSummary(device)).toEqual([
      { code: MtpOperationCode.GetDeviceInfo, transactionId: 0 },
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
      { code: MtpOperationCode.GetStorageIDs, transactionId: 1 },
      { code: MtpOperationCode.GetStorageInfo, transactionId: 2 },
      { code: MtpOperationCode.GetObjectHandles, transactionId: 3 },
      { code: MtpOperationCode.CloseSession, transactionId: 4 },
    ]);
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
    expect(device.opened).toBe(false);
  });

  it("runs the exact-byte self-test before recursive inventory and leaves the session ready", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const fixedNow = new Date("2026-08-29T12:00:00Z");
    const selfTestFilename = "kindle-webusb-poc-20260829T120000Z-000000.txt";
    const selfTestHandle = 100;
    const bookHandle = 0x77;
    const selfTestInfo = makeUploadObjectInfo({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      objectFormat: MtpObjectFormat.Text,
      compressedSize: KINDLE_SELF_TEST_PAYLOAD.byteLength,
      filename: selfTestFilename,
      modificationDate: "20260829T120000Z",
    });
    const bookInfo = makeUploadObjectInfo({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      compressedSize: 2_048,
      filename: "catalog-kb-0123456789abcdefabcd.azw3",
    });
    queueIncoming(
      device,
      ...deviceInfoExchange(),
      ok(0),
      ...successfulInspectionExchange(),
      // Automatic self-test begins immediately after connect.
      data(MtpOperationCode.GetStorageInfo, 5, encodeStorageInfo(STORAGE_INFO)), ok(5),
      data(MtpOperationCode.GetObjectHandles, 6, encodeObjectHandles([])), ok(6),
      // Object-store mutation guard snapshots the parent independently.
      data(MtpOperationCode.GetObjectHandles, 7, encodeObjectHandles([])), ok(7),
      encodeResponseContainer(
        MtpResponseCode.OK,
        8,
        [STORAGE_ID, DOCUMENTS_HANDLE, selfTestHandle],
      ),
      ok(9),
      data(MtpOperationCode.GetObjectInfo, 10, encodeObjectInfo(selfTestInfo)), ok(10),
      data(MtpOperationCode.GetObject, 11, KINDLE_SELF_TEST_PAYLOAD), ok(11),
      ok(12),
      data(MtpOperationCode.GetObjectHandles, 13, encodeObjectHandles([])), ok(13),
      // Inventory starts only after byte verification and exact-handle cleanup.
      data(MtpOperationCode.GetStorageInfo, 14, encodeStorageInfo(STORAGE_INFO)), ok(14),
      // Root cache discovery revalidates the inspection seed without rereading
      // root ObjectInfo when the live handle set is unchanged.
      data(MtpOperationCode.GetObjectHandles, 15, encodeObjectHandles([DOCUMENTS_HANDLE])), ok(15),
      data(MtpOperationCode.GetObjectHandles, 16, encodeObjectHandles([bookHandle])), ok(16),
      data(MtpOperationCode.GetObjectInfo, 17, encodeObjectInfo(bookInfo)), ok(17),
      ok(18),
    );

    const connection = await openKindle(device, {
      onDescriptor: () => undefined,
      onUsbOpen: () => undefined,
      onMtpReading: () => undefined,
    }, usb, {
      commandTimeoutMs: 500,
      inactivityTimeoutMs: 100,
      kindleOptions: {
        now: () => fixedNow,
        random: () => 0,
      },
    });

    const prepared = await connection.prepareAfterConnect({
      // This orchestration test verifies hierarchy/inventory readiness. Book
      // metadata parsing has its own bounded parser/inventory suites.
      inventory: { bookMetadata: false },
    });

    expect(prepared).toMatchObject({
      selfTest: {
        filename: selfTestFilename,
        handle: selfTestHandle,
        cleanedUp: true,
      },
      inventoryRefresh: "complete",
      inventory: {
        status: "complete",
        objects: [{
          handle: bookHandle,
          filename: bookInfo.filename,
          managedToken: "kb-0123456789abcdefabcd",
        }],
      },
    });
    expect(connection.readyForSend).toBe(true);
    expect(connection.closed).toBe(false);

    const codes = commandSummary(device).map(({ code }) => code);
    expect(codes.indexOf(MtpOperationCode.SendObjectInfo))
      .toBeLessThan(codes.lastIndexOf(MtpOperationCode.GetObjectHandles));

    await connection.disconnect();
    expect(connection.closed).toBe(true);
  });

  it("propagates fatal inventory desynchronization and revokes Send readiness", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const fixedNow = new Date("2026-08-29T12:00:00Z");
    const selfTestFilename = "kindle-webusb-poc-20260829T120000Z-000000.txt";
    const selfTestHandle = 100;
    const selfTestInfo = makeUploadObjectInfo({
      storageId: STORAGE_ID,
      parentHandle: DOCUMENTS_HANDLE,
      objectFormat: MtpObjectFormat.Text,
      compressedSize: KINDLE_SELF_TEST_PAYLOAD.byteLength,
      filename: selfTestFilename,
      modificationDate: "20260829T120000Z",
    });
    queueIncoming(
      device,
      ...deviceInfoExchange(),
      ok(0),
      ...successfulInspectionExchange(),
      data(MtpOperationCode.GetStorageInfo, 5, encodeStorageInfo(STORAGE_INFO)), ok(5),
      data(MtpOperationCode.GetObjectHandles, 6, encodeObjectHandles([])), ok(6),
      data(MtpOperationCode.GetObjectHandles, 7, encodeObjectHandles([])), ok(7),
      encodeResponseContainer(MtpResponseCode.OK, 8, [STORAGE_ID, DOCUMENTS_HANDLE, selfTestHandle]),
      ok(9),
      data(MtpOperationCode.GetObjectInfo, 10, encodeObjectInfo(selfTestInfo)), ok(10),
      data(MtpOperationCode.GetObject, 11, KINDLE_SELF_TEST_PAYLOAD), ok(11),
      ok(12),
      data(MtpOperationCode.GetObjectHandles, 13, encodeObjectHandles([])), ok(13),
      // The next root-cache discovery command has started, but its response is not a
      // decodable MTP container. The session must fault rather than return a
      // misleading partial inventory.
      Uint8Array.of(0),
    );
    const connection = await openKindle(device, {
      onDescriptor: () => undefined,
      onUsbOpen: () => undefined,
      onMtpReading: () => undefined,
    }, usb, {
      commandTimeoutMs: 500,
      inactivityTimeoutMs: 100,
      kindleOptions: { now: () => fixedNow, random: () => 0 },
    });

    await expect(connection.prepareAfterConnect()).rejects.toMatchObject({ fatal: true });
    expect(connection.readyForSend).toBe(false);

    await connection.disconnect();
    expect(connection.closed).toBe(true);
    expect(device.opened).toBe(false);
  });
});
