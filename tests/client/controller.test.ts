// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppController,
  type AppControllerDependencies,
  type BrowserLifecycleSource,
  type ConnectedKindlePort,
} from "../../client/src/controller";
import type { CatalogApi, CatalogBook, CatalogEvent } from "../../client/src/catalog-client";
import {
  deriveGateStatuses,
  initialAppState,
  persistPendingObjectCleanup,
  readPendingObjectCleanup,
  type PendingObjectCleanup,
} from "../../client/src/state";
import type { UsbDeviceLike } from "../../client/src/usb";
import { acquireKindleDeviceLease, createManagedFilenameToken } from "../../client/src/kindle";
import { readPendingDeliveries } from "../../client/src/delivery-journal";
import { METADATA_CLAIM_BITMAP_BYTES } from "../../shared/catalog-contracts";

function claimantSummary(collisions: readonly number[] = [], complete = true): {
  complete: boolean;
  collisionBitmap: string;
} {
  const bytes = new Uint8Array(METADATA_CLAIM_BITMAP_BYTES);
  for (const position of collisions) {
    bytes[position >>> 3] = (bytes[position >>> 3] ?? 0) | (1 << (position & 7));
  }
  return { complete, collisionBitmap: btoa(String.fromCharCode(...bytes)) };
}

function fakeDevice(): UsbDeviceLike {
  return {
    vendorId: 0x1949,
    productId: 0x9981,
    manufacturerName: "Amazon",
    productName: "Kindle",
    configurations: [],
    opened: false,
    open: vi.fn(), close: vi.fn(), selectConfiguration: vi.fn(), claimInterface: vi.fn(),
    releaseInterface: vi.fn(), selectAlternateInterface: vi.fn(), transferIn: vi.fn(),
    transferOut: vi.fn(), clearHalt: vi.fn(),
  };
}

class FakeBrowserLifecycle implements BrowserLifecycleSource {
  visibilityState: DocumentVisibilityState = "visible";
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: "pagehide" | "pageshow" | "visibilitychange", listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.#emit("visibilitychange");
  }

  restoreFromBfcache(): void {
    this.#emit("pageshow", true);
  }

  #emit(type: "pagehide" | "pageshow" | "visibilitychange", persisted = false): void {
    const event = new Event(type);
    if (type !== "visibilitychange") Object.defineProperty(event, "persisted", { value: persisted });
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function harness(
  autoStartCatalog = false,
  dependencyOverrides: Partial<AppControllerDependencies> = {},
  configureCatalogApi?: (api: CatalogApi) => void,
) {
  const device = fakeDevice();
  const details = {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: "Kindle",
    model: "Kindle 11th generation",
    configurationValue: 1,
    interfaceNumber: 1,
    alternateSetting: 0,
    bulkInEndpoint: 1,
    bulkOutEndpoint: 2,
    operationsSupported: [0x1001, 0x1002, 0x1004],
    storageId: 0x10001,
    documentsHandle: 0x37,
  };
  let closed = false;
  let handle = 20;
  let selfTestPassed = false;
  const inventory = {
    status: "complete" as const,
    storageId: 0x10001,
    documentsHandle: 0x37,
    objects: [],
    issues: [],
    issueCount: 0,
    scannedObjectCount: 0,
    bookMetadata: {
      status: "complete" as const,
      eligibleObjectCount: 0,
      attemptedObjectCount: 0,
      parsedObjectCount: 0,
      enrichedObjectCount: 0,
      failedObjectCount: 0,
      skippedObjectCount: 0,
      indistinguishableObjectCount: 0,
      readByteCount: 0,
      budgetedByteCount: 0,
      truncated: false,
      truncationReasons: [],
    },
  };
  const connection: ConnectedKindlePort = {
    device,
    details,
    identityKey: "opaque-device-key",
    get closed() { return closed; },
    get readyForSend() { return selfTestPassed && !closed; },
    get latestInventory() { return inventory; },
    runSelfTest: vi.fn(async (options) => {
      const metadata = { storageId: 0x10001, parentHandle: 0x37, filename: "kindle-poc-byte-test.txt", size: 1037 };
      const created = ++handle;
      options?.onObjectState?.({ stage: "send-object-info-intent", ...metadata });
      options?.onObjectState?.({ stage: "handle-assigned", handle: created, ...metadata });
      options?.onObjectState?.({ stage: "cleanup-succeeded", handle: created, ...metadata });
      selfTestPassed = true;
      return { filename: metadata.filename, handle: created, bytesVerified: metadata.size, cleanedUp: true as const };
    }),
    prepareAfterConnect: vi.fn(async (options) => {
      const result = await connection.runSelfTest(options?.selfTest);
      return { selfTest: result, inventory, inventoryRefresh: "complete" as const };
    }),
    refreshInventory: vi.fn(async () => inventory),
    sendAzW3: vi.fn(async (blob, filename, options) => {
      const metadata = { storageId: 0x10001, parentHandle: 0x37, filename, size: blob.size };
      const created = ++handle;
      options?.onObjectState?.({ stage: "send-object-info-intent", ...metadata });
      options?.onObjectState?.({ stage: "handle-assigned", handle: created, ...metadata });
      options?.onProgress?.({ bytesTransferred: blob.size, totalBytes: blob.size });
      options?.onObjectState?.({ stage: "verified", handle: created, ...metadata });
      return { ...metadata, handle: created, verified: true as const };
    }),
    sendAzW3AndRefreshInventory: vi.fn(async (blob, filename, options) => ({
      transfer: await connection.sendAzW3(blob, filename, options),
      inventory,
      inventoryRefresh: "complete" as const,
    })),
    disconnect: vi.fn(async () => { closed = true; }),
    closeAfterPhysicalDisconnect: vi.fn(async () => { closed = true; }),
  };
  const requestDevice = vi.fn(async () => device);
  const openDevice: AppControllerDependencies["openDevice"] = vi.fn(async (_device, hooks) => {
    const base = { vendorId: device.vendorId, productId: device.productId, productName: "Kindle" };
    hooks.onDescriptor(base, { vendorId: device.vendorId, maskedSerialNumber: "******1234" });
    hooks.onUsbOpen(details);
    hooks.onMtpReading(details);
    return connection;
  });
  const convert = vi.fn<AppControllerDependencies["convert"]>(async () => ({
    filename: "book.azw3",
    blob: new Blob([new Uint8Array(512)]),
    metadata: { title: "Book", authors: ["Author"], language: "en", chapters: 2, toc_entries: 2 },
    diagnostics: { engine: "boko-wasm" as const, runsLocally: true as const, inputBytes: 10, outputBytes: 512, kindleDocumentType: "PDOC" as const, embeddedCover: true },
  }));
  const sourceBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const book: CatalogBook = {
    id: "book-1",
    profileId: "profile-1",
    rootId: "root-1",
    title: "Book",
    authors: ["Author"],
    authorSort: "Author",
    subjects: [],
    identifiers: [],
    format: "EPUB",
    size: sourceBytes.byteLength,
    contentHash: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceFilename: "book.epub",
    addedAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    metadataComplete: true,
    available: true,
  };
  let catalogEventListener: ((event: CatalogEvent) => void) | undefined;
  const catalogApi = {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: "read-write" })),
    listProfiles: vi.fn(async () => [{
      id: "profile-1", name: "Library", description: "", initial: "L", sourceLabel: "Books",
      enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
    }]),
    listRoots: vi.fn(async () => [{
      id: "root-1",
      profileId: "profile-1",
      label: "Books",
      path: "/libraries/books",
      recursive: true,
      watch: true,
      enabled: true,
      status: "available",
    }]),
    getFilters: vi.fn(async () => ({
      authors: [], languages: [], subjects: [], publishers: [], series: [],
      formats: [], roots: [], years: [], metadata: [],
    })),
    listBooks: vi.fn(async () => ({ items: [book], total: 1, limit: 24, offset: 0 })),
    getBook: vi.fn(async () => book),
    getBookSource: vi.fn(async () => ({
      blob: new Blob([Uint8Array.from(sourceBytes)]),
      contentLength: sourceBytes.byteLength,
      etag: `"sha256-${book.contentHash}"`,
    })),
    getMatchIndex: vi.fn(async () => ({
      profileId: "profile-1",
      generatedAt: "2026-08-29T00:00:00.000Z",
      entries: [{
        bookId: book.id,
        sourceFilename: book.sourceFilename,
        sourceFormat: book.format,
        sourceSize: book.size,
        contentHash: book.contentHash!,
        identifiers: book.identifiers,
        title: book.title,
        authors: book.authors,
        deliveries: [],
      }],
    })),
    createDelivery: vi.fn(async () => ({})),
    subscribeEvents: vi.fn((listener: (event: CatalogEvent) => void, _onError?: () => void, onOpen?: () => void) => {
      catalogEventListener = listener;
      onOpen?.();
      return () => undefined;
    }),
  } as unknown as CatalogApi;
  configureCatalogApi?.(catalogApi);
  const browserLifecycle = new FakeBrowserLifecycle();
  let currentTime = 0;
  const dependencies: AppControllerDependencies = {
    requestDevice,
    openDevice,
    convert,
    download: vi.fn(),
    copyText: vi.fn(async () => undefined),
    now: () => currentTime,
    catalogApi,
    autoStartCatalog,
    browserLifecycle,
    ...dependencyOverrides,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const controller = new AppController(root, dependencies, {
    ...initialAppState(), secureContext: true, webUsbAvailable: true,
  });
  return {
    root,
    controller,
    requestDevice,
    openDevice,
    convert,
    connection,
    catalogApi,
    book,
    sourceBytes,
    browserLifecycle,
    advanceTime(milliseconds: number) { currentTime += milliseconds; },
    emitCatalogEvent(event: CatalogEvent) {
      if (!catalogEventListener) throw new Error("Catalog event stream is not connected");
      catalogEventListener(event);
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("AppController local conversion flow", () => {
  it("keeps the diagnostic POC connection gated on local conversion", async () => {
    const app = harness();
    await app.controller.connect("poc");
    expect(app.requestDevice).not.toHaveBeenCalled();
    expect(app.controller.state.activeError?.code).toBe("INVALID_STATE");
  });

  it("connects from the catalog without a selected book and runs the byte test automatically", async () => {
    const app = harness();
    await app.controller.connect();
    expect(app.requestDevice).toHaveBeenCalledOnce();
    expect(app.connection.runSelfTest).toHaveBeenCalledOnce();
    expect(app.connection.refreshInventory).toHaveBeenCalledOnce();
    expect(app.connection.refreshInventory).toHaveBeenCalledWith(expect.objectContaining({
      deviceMetadataCache: "read-write",
      onObjectState: expect.any(Function),
    }));
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed", byteLength: 1037 },
    });
  });

  it("journals an interrupted root-cache write and reruns the safe sequence after acknowledgement", async () => {
    const app = harness();
    vi.mocked(app.connection.refreshInventory).mockImplementationOnce(async (options) => {
      const metadata = {
        storageId: 0x10001,
        parentHandle: 0xffff_ffff,
        filename: ".kindle-bridge-device-metadata-cache-v1-a.json",
        size: 1_024,
      };
      options?.onObjectState?.({ stage: "send-object-info-intent", ...metadata });
      options?.onObjectState?.({ stage: "handle-assigned", handle: 0x606, ...metadata });
      throw Object.assign(new Error("cache readback could not be verified"), {
        code: "MTP_OBJECT_VERIFICATION_FAILED",
      });
    });

    await app.controller.connect();

    expect(app.controller.state.pendingObjectCleanup).toMatchObject({
      purpose: "metadata-cache",
      stage: "handle-assigned",
      parentHandle: 0xffff_ffff,
      handle: 0x606,
    });
    expect(readPendingObjectCleanup()).toEqual(app.controller.state.pendingObjectCleanup);
    expect(app.root.querySelector(".recovery-notice")?.textContent).toContain(
      "Inspect the Kindle storage root",
    );

    await app.controller.confirmCleanupInspection();

    expect(app.connection.runSelfTest).toHaveBeenCalledTimes(2);
    expect(app.connection.refreshInventory).toHaveBeenCalledTimes(2);
    expect(readPendingObjectCleanup()).toBeUndefined();
    expect(app.controller.state).toMatchObject({
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
      pendingObjectCleanup: undefined,
    });
  });

  it("reports each automatic post-connect phase without calling inventory work a safe-write check", async () => {
    const app = harness();
    let finishSelfTest!: () => void;
    let finishInventory!: () => void;
    vi.mocked(app.connection.runSelfTest).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishSelfTest = resolve; });
      return {
        filename: "kindle-poc-byte-test.txt",
        handle: 101,
        bytesVerified: 1037,
        cleanedUp: true as const,
      };
    });
    vi.mocked(app.connection.refreshInventory).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishInventory = resolve; });
      return app.connection.latestInventory!;
    });

    const connecting = app.controller.connect();
    await vi.waitFor(() => expect(app.controller.state.postConnectStage).toBe("safe-write"));
    expect(app.root.querySelector(".library-device-button")?.textContent).toContain("Checking safe writes");

    finishSelfTest();
    await vi.waitFor(() => expect(app.controller.state.postConnectStage).toBe("inventory"));
    const inventoryCopy = app.root.querySelector(".library-device-button")?.textContent ?? "";
    expect(inventoryCopy).toContain("Reading Kindle Documents");
    expect(inventoryCopy).not.toContain("Checking safe writes");

    finishInventory();
    await connecting;
    expect(app.controller.state.postConnectStage).toBe("idle");
  });

  it("bounds USB open and Documents discovery even when an adapter ignores abort", async () => {
    const app = harness(false, { openDeviceTimeoutMs: 15 });
    let resolveLate!: (connection: ConnectedKindlePort) => void;
    let openSignal!: AbortSignal;
    let lateHooks!: Parameters<AppControllerDependencies["openDevice"]>[1];
    vi.mocked(app.openDevice).mockImplementationOnce((_device, hooks, signal) => {
      lateHooks = hooks;
      openSignal = signal;
      return new Promise<ConnectedKindlePort>((resolve) => { resolveLate = resolve; });
    });

    await app.controller.connect();

    expect(openSignal.aborted).toBe(true);
    expect(app.controller.state).toMatchObject({
      usbAccessProven: false,
      mtpReadProven: false,
      device: { kind: "error", error: { code: "USB_OPEN_TIMEOUT" } },
      selfTest: { kind: "not-run" },
      catalogInventoryState: "idle",
    });

    // A non-cooperative adapter can still invoke callbacks or resolve later;
    // neither may revive the retired session, and the connection is closed.
    lateHooks.onUsbOpen(app.connection.details);
    expect(app.controller.state.device.kind).toBe("error");
    resolveLate(app.connection);
    await vi.waitFor(() => expect(app.connection.disconnect).toHaveBeenCalledOnce());
    expect(app.controller.state.device.kind).toBe("error");
  });

  it("keeps a proven Kindle connection ready when catalog matching indexes are temporarily unavailable", async () => {
    const app = harness();
    vi.mocked(app.catalogApi.getMatchIndex).mockRejectedValueOnce(new Error("catalog offline"));

    await app.controller.connect();

    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed", byteLength: 1037 },
    });
    expect(app.connection.disconnect).not.toHaveBeenCalled();
    expect(app.connection.readyForSend).toBe(true);
  });

  it("does not let an unidentified catalog connection poison later POC identity checks", async () => {
    const app = harness();
    app.controller.selectEpub(new File(["epub bytes"], "book.epub", { type: "application/epub+zip" }));
    await app.controller.convert();

    const anonymousCatalogConnection: ConnectedKindlePort = {
      ...app.connection,
      identityKey: undefined,
      disconnect: vi.fn(async () => undefined),
      closeAfterPhysicalDisconnect: vi.fn(async () => undefined),
    };
    vi.mocked(app.openDevice)
      .mockResolvedValueOnce(anonymousCatalogConnection)
      .mockResolvedValueOnce(app.connection);

    await app.controller.connect("catalog");
    expect(app.controller.state.device.kind).toBe("ready");
    await app.controller.disconnect();
    expect(anonymousCatalogConnection.disconnect).toHaveBeenCalledOnce();

    await app.controller.connect("poc");
    expect(app.openDevice).toHaveBeenCalledTimes(2);
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed", byteLength: 1037 },
      activeError: undefined,
    });
    expect(app.controller.state.activeError?.code).not.toBe("USB_DEVICE_IDENTITY_UNAVAILABLE");
  });

  it("deduplicates repeated Disconnect requests and blocks reconnect until USB cleanup settles", async () => {
    const app = harness();
    await app.controller.connect();
    const baseDisconnect = vi.mocked(app.connection.disconnect).getMockImplementation();
    if (!baseDisconnect) throw new Error("Missing disconnect implementation");
    let releaseCleanup!: () => void;
    vi.mocked(app.connection.disconnect).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseCleanup = resolve; });
      await baseDisconnect();
    });

    const first = app.controller.disconnect();
    await vi.waitFor(() => expect(app.controller.state.device.kind).toBe("recovering"));
    const repeated = app.controller.disconnect();
    expect(repeated).toBe(first);

    await app.controller.connect();
    expect(app.requestDevice).toHaveBeenCalledOnce();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
    expect(app.controller.state).toMatchObject({
      device: { kind: "recovering" },
      activeError: { code: "INVALID_STATE" },
    });

    releaseCleanup();
    await Promise.all([first, repeated]);
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
    expect(app.controller.state).toMatchObject({
      device: { kind: "disconnected" },
      catalogInventoryState: "idle",
      activeError: undefined,
    });
  });

  it("imports another tab's durable interrupted-object journal after acquiring the device lease", async () => {
    const waitingTab = harness();
    const writerTab = harness();
    await writerTab.controller.connect();
    vi.mocked(writerTab.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename, options) => {
      options?.onObjectState?.({
        stage: "send-object-info-intent",
        storageId: 0x10001,
        parentHandle: 0x37,
        filename,
        size: blob.size,
      });
      throw new Error("writer tab terminated after object intent");
    });
    await expect(
      writerTab.controller.sendCatalogBook({ profileId: "profile-1", book: writerTab.book }),
    ).rejects.toThrow("writer tab terminated");
    expect(writerTab.controller.state.pendingObjectCleanup).toMatchObject({
      purpose: "catalog",
      stage: "send-object-info-intent",
    });
    expect(waitingTab.controller.state.pendingObjectCleanup).toBeUndefined();
    await writerTab.controller.disconnect();

    await waitingTab.controller.connect();

    expect(waitingTab.controller.state.pendingObjectCleanup).toMatchObject({
      purpose: "catalog",
      stage: "send-object-info-intent",
    });
    expect(waitingTab.connection.prepareAfterConnect).not.toHaveBeenCalled();
    expect(waitingTab.connection.runSelfTest).not.toHaveBeenCalled();
    expect(waitingTab.connection.refreshInventory).toHaveBeenCalledOnce();
    expect(vi.mocked(waitingTab.connection.refreshInventory).mock.calls[0]?.[0]).not.toHaveProperty(
      "deviceMetadataCache",
    );
    expect(vi.mocked(waitingTab.connection.refreshInventory).mock.calls[0]?.[0]).not.toHaveProperty(
      "onObjectState",
    );
    await expect(
      waitingTab.controller.sendCatalogBook({ profileId: "profile-1", book: waitingTab.book }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(waitingTab.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("automatically rebuilds catalog Send authority after exact recovery acknowledgement on a live connection", async () => {
    const pending: PendingObjectCleanup = {
      version: 1,
      purpose: "catalog",
      stage: "handle-assigned",
      filename: "Book-kb-interrupted.azw3",
      vendorId: 0x1949,
      productId: 0x9981,
      storageId: 0x10001,
      parentHandle: 0x37,
      size: 512,
      handle: 0x404,
      operationId: "mtp-interrupted-catalog-send",
      recordedAt: 42,
    };
    expect(persistPendingObjectCleanup(pending)).toBe(true);
    const app = harness(true);
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());

    await app.controller.connect("catalog");

    expect(app.connection.refreshInventory).toHaveBeenCalledOnce();
    expect(app.connection.prepareAfterConnect).not.toHaveBeenCalled();
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "not-run" },
      pendingObjectCleanup: pending,
    });
    const acknowledge = app.root.querySelector<HTMLButtonElement>(
      'button[data-action="confirm-cleanup-inspection"]',
    );
    expect(acknowledge).not.toBeNull();

    acknowledge!.click();
    await vi.waitFor(() => expect(app.controller.state.catalogInventoryState).toBe("ready"));

    expect(readPendingObjectCleanup()).toBeUndefined();
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
      pendingObjectCleanup: undefined,
      activeError: undefined,
    });
    expect(app.connection.prepareAfterConnect).not.toHaveBeenCalled();
    expect(app.connection.runSelfTest).toHaveBeenCalledOnce();
    expect(app.connection.refreshInventory).toHaveBeenCalledTimes(2);
    expect(app.requestDevice).toHaveBeenCalledOnce();
    expect(app.root.querySelector('.recovery-notice')).toBeNull();
    expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(false);
  });

  it("does not clear recovery while the live read-only inventory operation owns the MTP session", async () => {
    const pending: PendingObjectCleanup = {
      version: 1,
      purpose: "catalog",
      stage: "send-object-info-intent",
      filename: "Book-kb-pending-intent.azw3",
      vendorId: 0x1949,
      productId: 0x9981,
      storageId: 0x10001,
      parentHandle: 0x37,
      size: 512,
      operationId: "mtp-pending-inventory",
      recordedAt: 43,
    };
    expect(persistPendingObjectCleanup(pending)).toBe(true);
    const app = harness();
    let releaseInventory!: () => void;
    vi.mocked(app.connection.refreshInventory).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseInventory = resolve; });
      return app.connection.latestInventory!;
    });

    const connecting = app.controller.connect("catalog");
    await vi.waitFor(() => expect(app.connection.refreshInventory).toHaveBeenCalledOnce());
    await app.controller.confirmCleanupInspection();

    expect(readPendingObjectCleanup()).toEqual(pending);
    expect(app.controller.state.pendingObjectCleanup).toEqual(pending);
    expect(app.controller.state.activeError).toMatchObject({ code: "INVALID_STATE" });
    expect(app.connection.prepareAfterConnect).not.toHaveBeenCalled();

    releaseInventory();
    await connecting;
  });

  it("keeps the durable recovery journal across reload when exact-handle deletion cannot be verified", async () => {
    const app = harness();
    vi.mocked(app.connection.runSelfTest).mockImplementationOnce(async (options) => {
      const metadata = {
        storageId: 0x10001,
        parentHandle: 0x37,
        filename: "kindle-poc-byte-test-unverified.txt",
        size: 1037,
      };
      options?.onObjectState?.({ stage: "send-object-info-intent", ...metadata });
      options?.onObjectState?.({ stage: "handle-assigned", handle: 0x505, ...metadata });
      throw Object.assign(new Error("DeleteObject returned OK, but the exact handle remained"), {
        code: "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
        details: {
          createdHandle: 0x505,
          filename: metadata.filename,
          cleanupAttempted: true,
          cleanupSucceeded: false,
        },
      });
    });

    await app.controller.connect();

    expect(app.controller.state.pendingObjectCleanup).toMatchObject({
      filename: "kindle-poc-byte-test-unverified.txt",
      handle: 0x505,
      stage: "handle-assigned",
    });
    expect(readPendingObjectCleanup()).toEqual(app.controller.state.pendingObjectCleanup);

    const reloaded = harness();
    expect(reloaded.controller.state.pendingObjectCleanup).toEqual(
      app.controller.state.pendingObjectCleanup,
    );
  });

  it("cannot acknowledge another tab's recovery journal while that tab holds the Kindle writer lease", async () => {
    const lockName = "kindle-bridge:test-recovery-ack";
    const writerLease = await acquireKindleDeviceLease({ lockManager: null, lockName });
    const pending: PendingObjectCleanup = {
      version: 1,
      purpose: "catalog",
      stage: "handle-assigned",
      filename: "Book-kb-active-writer.azw3",
      vendorId: 0x1949,
      productId: 0x9981,
      storageId: 0x10001,
      parentHandle: 0x37,
      size: 512,
      handle: 0x404,
      operationId: "mtp-active-writer",
      recordedAt: 42,
    };
    expect(persistPendingObjectCleanup(pending)).toBe(true);
    const waitingTab = harness(false, {
      acquireRecoveryLease: () => acquireKindleDeviceLease({ lockManager: null, lockName }),
    });

    await waitingTab.controller.confirmCleanupInspection();

    expect(readPendingObjectCleanup()).toEqual(pending);
    expect(waitingTab.controller.state.pendingObjectCleanup).toEqual(pending);
    expect(waitingTab.controller.state.activeError).toMatchObject({ code: "KINDLE_DEVICE_BUSY" });

    await writerLease.release();
    await waitingTab.controller.confirmCleanupInspection();
    expect(readPendingObjectCleanup()).toBeUndefined();
    expect(waitingTab.controller.state.pendingObjectCleanup).toBeUndefined();
  });

  it("keeps Send blocked when the byte test passes but automatic inventory fails", async () => {
    const app = harness(true);
    vi.mocked(app.connection.refreshInventory).mockRejectedValueOnce(
      Object.assign(new Error("inventory unavailable"), { code: "MTP_TIMEOUT" }),
    );
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());

    await app.controller.connect();

    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed" },
      catalogInventoryState: "failed",
    });
    const send = app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    );
    expect(send?.disabled).toBe(true);
    expect(send?.textContent).toContain("Inventory unavailable");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("inventory and catalog comparison are not ready"),
    });
    expect(app.catalogApi.getBook).not.toHaveBeenCalled();
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("keeps the safe-write proof distinct when a fatal inventory fault retires the session", async () => {
    const app = harness();
    vi.mocked(app.connection.refreshInventory).mockRejectedValueOnce(
      Object.assign(new Error("The MTP transport lost synchronization."), {
        code: "MTP_TRANSPORT_ERROR",
      }),
    );

    await app.controller.connect();

    expect(app.controller.state).toMatchObject({
      device: { kind: "error" },
      selfTest: { kind: "passed", byteLength: 1037 },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
      activeError: {
        code: "MTP_TRANSPORT_ERROR",
        message: expect.stringContaining("inventory/comparison failed after the safe-write check passed"),
      },
    });
    expect(app.controller.state.activeError?.message).not.toContain("Safe-write check failed");
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
  });

  it("rejects a direct Send call unless the current comparison proves the book absent", async () => {
    const app = harness();
    vi.mocked(app.connection.refreshInventory).mockResolvedValueOnce({
        status: "complete",
        storageId: 0x10001,
        documentsHandle: 0x37,
        objects: [],
        issues: [],
        issueCount: 0,
        scannedObjectCount: 0,
        bookMetadata: {
          status: "partial",
          eligibleObjectCount: 1,
          attemptedObjectCount: 1,
          parsedObjectCount: 0,
          enrichedObjectCount: 0,
          failedObjectCount: 1,
          skippedObjectCount: 0,
          indistinguishableObjectCount: 0,
          readByteCount: 0,
          budgetedByteCount: 0,
          truncated: false,
          truncationReasons: [],
        },
      });

    await app.controller.connect();
    expect(app.controller.state.catalogInventoryState).toBe("ready");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("presence could not be verified"),
    });
    expect(app.catalogApi.getBookSource).not.toHaveBeenCalled();
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("does not publish Send readiness until the current inventory finishes catalog reconciliation", async () => {
    const app = harness();
    let releaseProfiles!: () => void;
    vi.mocked(app.catalogApi.listProfiles).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseProfiles = resolve; });
      return [{
        id: "profile-1", name: "Library", description: "", initial: "L", sourceLabel: "Books",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      }];
    });

    const connecting = app.controller.connect();
    await vi.waitFor(() => expect(app.controller.state.postConnectStage).toBe("reconciliation"));
    expect(app.controller.state.selfTest.kind).toBe("passed");
    expect(app.root.querySelector(".library-device-button")?.textContent).toContain("Comparing Kindle with library");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();

    releaseProfiles();
    await connecting;
    expect(app.controller.state).toMatchObject({
      selfTest: { kind: "passed" },
      catalogInventoryState: "ready",
    });
  });

  it("fails closed for the visible profile without allocating another profile index as a fallback", async () => {
    const app = harness(true);
    vi.mocked(app.catalogApi.listProfiles).mockResolvedValue([
      {
        id: "profile-1", name: "Library", description: "", initial: "L", sourceLabel: "Books",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
      {
        id: "profile-2", name: "Other", description: "", initial: "O", sourceLabel: "Other books",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
    ]);
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(async (profileId) => {
      if (profileId === "profile-1") throw new Error("active profile index unavailable");
      return { profileId, generatedAt: "2026-08-30T00:00:00.000Z", entries: [] };
    });
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());

    await app.controller.connect();

    expect(app.controller.state.catalogInventoryState).toBe("failed");
    expect(app.controller.latestCatalogInventory?.matching).toMatchObject({
      status: "unavailable",
      matchedProfiles: 0,
      failedProfiles: 1,
      deferredProfiles: 1,
    });
    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(true);
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    await expect(app.controller.sendCatalogBook({
      profileId: "profile-2",
      book: { ...app.book, profileId: "profile-2" },
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("reconciles only the active profile so a hanging background library cannot delay Connect", async () => {
    const app = harness(true);
    const profiles = ["profile-1", "profile-2", "profile-3", "profile-4"].map((id, index) => ({
      id,
      name: `Library ${index + 1}`,
      description: "",
      initial: "L",
      sourceLabel: `Books ${index + 1}`,
      enabled: true,
      rootCount: 1,
      availableRootCount: 1,
      bookCount: 0,
    }));
    vi.mocked(app.catalogApi.listProfiles).mockResolvedValue(profiles);
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(async (profileId) => {
      if (profileId !== "profile-1") return new Promise(() => undefined);
      return {
        profileId,
        generatedAt: "2026-08-30T00:00:00.000Z",
        entries: [{
          bookId: app.book.id,
          sourceFilename: app.book.sourceFilename,
          sourceFormat: app.book.format,
          sourceSize: app.book.size,
          contentHash: app.book.contentHash!,
          identifiers: [],
          title: app.book.title,
          authors: app.book.authors,
          deliveries: [],
        }],
      };
    });
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());

    await app.controller.connect();

    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    expect(app.controller.latestCatalogInventory?.matching).toMatchObject({
      status: "complete",
      matchedProfiles: 1,
      failedProfiles: 0,
      deferredProfiles: 3,
    });
    await vi.waitFor(() => expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(false));
  });

  it("keeps the active profile authoritative when household profile discovery fails transiently", async () => {
    const app = harness(true);
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());
    vi.mocked(app.catalogApi.listProfiles).mockRejectedValueOnce(
      new Error("profile list temporarily unavailable"),
    );

    await app.controller.connect();

    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    expect(app.controller.latestCatalogInventory?.matching).toEqual({
      status: "complete",
      matchedProfiles: 1,
      failedProfiles: 0,
    });
    expect(app.controller.state.catalogInventoryState).toBe("ready");
    expect(app.root.querySelector(".library-matching-notice")).toBeNull();
    expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(false);
  });

  it("keeps cross-profile metadata claims possible while source-scoped managed evidence stays confirmed", async () => {
    const sourceBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const metadataHash = createHash("sha256").update(sourceBytes).digest("hex");
    const managedHash = "b".repeat(64);
    const managedToken = await createManagedFilenameToken("book-managed", managedHash);
    const metadataBook: CatalogBook = {
      id: "book-1",
      profileId: "profile-1",
      rootId: "root-1",
      title: "Shared household title",
      authors: ["Shared Author"],
      authorSort: "Shared Author",
      subjects: [],
      identifiers: ["isbn:9780000000001"],
      format: "EPUB",
      size: sourceBytes.byteLength,
      contentHash: metadataHash,
      sourceFilename: "shared.epub",
      addedAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      metadataComplete: true,
      available: true,
    };
    const managedBook: CatalogBook = {
      ...metadataBook,
      id: "book-managed",
      title: "Managed title",
      authors: ["Managed Author"],
      authorSort: "Managed Author",
      identifiers: [],
      contentHash: managedHash,
      sourceFilename: "managed.epub",
    };
    const profiles = [
      {
        id: "profile-1", name: "First library", description: "", initial: "F", sourceLabel: "First",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 2,
      },
      {
        id: "profile-2", name: "Other library", description: "", initial: "O", sourceLabel: "Other",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
    ];
    let metadataCollision = true;
    const app = harness(true, {}, (api) => {
      vi.mocked(api.listProfiles).mockResolvedValue(profiles);
      vi.mocked(api.listBooks).mockResolvedValue({
        items: [metadataBook, managedBook], total: 2, limit: 24, offset: 0,
      });
      vi.mocked(api.getMatchIndex).mockImplementation(async (profileId) => ({
        profileId,
        generatedAt: "2026-08-30T00:00:00.000Z",
        metadataClaims: claimantSummary(metadataCollision ? [0] : []),
        entries: profileId === "profile-1" ? [
          {
            bookId: metadataBook.id,
            sourceFilename: metadataBook.sourceFilename,
            sourceFormat: metadataBook.format,
            sourceSize: metadataBook.size,
            contentHash: metadataBook.contentHash!,
            identifiers: metadataBook.identifiers,
            title: metadataBook.title,
            authors: metadataBook.authors,
            deliveries: [],
          },
          {
            bookId: managedBook.id,
            sourceFilename: managedBook.sourceFilename,
            sourceFormat: managedBook.format,
            sourceSize: managedBook.size,
            contentHash: managedBook.contentHash!,
            managedToken,
            identifiers: managedBook.identifiers,
            title: managedBook.title,
            authors: managedBook.authors,
            deliveries: [],
          },
        ] : [{
          bookId: "other-profile-claim",
          sourceFilename: metadataBook.sourceFilename,
          sourceFormat: metadataBook.format,
          sourceSize: metadataBook.size,
          contentHash: "c".repeat(64),
          identifiers: metadataBook.identifiers,
          title: metadataBook.title,
          authors: ["Other Author"],
          deliveries: [],
        }],
      }));
    });
    const inventory = {
      status: "complete" as const,
      storageId: 0x10001,
      documentsHandle: 0x37,
      objects: [
        {
          handle: 41,
          storageId: 0x10001,
          parentHandle: 0x37,
          objectFormat: 0xb00a,
          protectionStatus: 0,
          associationType: 0,
          size: metadataBook.size,
          filename: "shared-unmanaged.azw3",
          relativePath: "shared-unmanaged.azw3",
          depth: 1,
          kind: "file" as const,
          title: metadataBook.title,
          authors: [...metadataBook.authors, "Other Author"],
          identifiers: metadataBook.identifiers,
          metadataAdjusted: false,
          bookMetadataState: "enriched" as const,
        },
        {
          handle: 42,
          storageId: 0x10001,
          parentHandle: 0x37,
          objectFormat: 0xb00a,
          protectionStatus: 0,
          associationType: 0,
          size: managedBook.size,
          filename: `managed-${managedToken}.azw3`,
          relativePath: `managed-${managedToken}.azw3`,
          depth: 1,
          kind: "file" as const,
          managedToken,
          metadataAdjusted: false,
          bookMetadataState: "enriched" as const,
        },
      ],
      issues: [],
      issueCount: 0,
      scannedObjectCount: 2,
      bookMetadata: {
        status: "complete" as const,
        eligibleObjectCount: 2,
        attemptedObjectCount: 2,
        parsedObjectCount: 2,
        enrichedObjectCount: 2,
        failedObjectCount: 0,
        skippedObjectCount: 0,
        indistinguishableObjectCount: 0,
        readByteCount: 32,
        budgetedByteCount: 32,
        truncated: false,
        truncationReasons: [],
      },
    };
    vi.mocked(app.connection.refreshInventory).mockResolvedValueOnce(inventory);
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-managed"]')).not.toBeNull());

    await app.controller.connect();

    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    expect(app.root.querySelector('[data-book-id="book-1"] .library-kindle-check')?.getAttribute("aria-label"))
      .toBe("Possible Kindle match");
    expect(app.root.querySelector('[data-book-id="book-managed"] .library-kindle-check')?.getAttribute("aria-label"))
      .toBe("Already on this Kindle");
    expect(app.controller.latestCatalogInventory?.items.find(({ id }) => id === "mtp-00000029")?.match)
      .toBe("possible");
    expect(app.controller.latestCatalogInventory?.items.find(({ id }) => id === "mtp-0000002a")?.match)
      .toBe("confirmed");

    metadataCollision = false;
    app.emitCatalogEvent({
      id: "global-claimant-retired",
      type: "catalog.changed",
      at: "2026-08-30T00:01:00.000Z",
      profileId: "profile-2",
    });
    await vi.waitFor(() => {
      expect(vi.mocked(app.catalogApi.getMatchIndex)).toHaveBeenCalledTimes(2);
      expect(app.root.querySelector('[data-book-id="book-1"] .library-kindle-check')?.getAttribute("aria-label"))
        .toBe("Already on this Kindle");
    });
  });

  it("reconciles the remembered profile when catalog startup finishes after a fast Kindle connect", async () => {
    window.localStorage.setItem("kindle-bridge.active-profile", "profile-2");
    let releaseCatalogBootstrap!: () => void;
    const catalogBootstrap = new Promise<void>((resolve) => { releaseCatalogBootstrap = resolve; });
    let releaseFirstIndex!: () => void;
    const firstIndex = new Promise<void>((resolve) => { releaseFirstIndex = resolve; });
    let profileRequest = 0;
    const profiles = [
      {
        id: "profile-1", name: "First library", description: "", initial: "F", sourceLabel: "First",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
      {
        id: "profile-2", name: "Remembered library", description: "", initial: "R", sourceLabel: "Remembered",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
    ];
    const app = harness(true, {}, (api) => {
      vi.mocked(api.listProfiles).mockImplementation(async () => {
        profileRequest += 1;
        if (profileRequest === 1) await catalogBootstrap;
        return profiles;
      });
      vi.mocked(api.getMatchIndex).mockImplementation(async (profileId) => {
        if (profileId === "profile-1") await firstIndex;
        return {
          profileId,
          generatedAt: "2026-08-30T00:00:00.000Z",
          entries: [],
        };
      });
    });

    const connecting = app.controller.connect();
    await vi.waitFor(() => expect(vi.mocked(app.catalogApi.getMatchIndex)).toHaveBeenCalledWith(
      "profile-1",
      expect.any(AbortSignal),
    ));
    releaseCatalogBootstrap();
    await vi.waitFor(() => expect(app.root.querySelector("#library-heading")?.textContent).toBe("Remembered library"));
    await vi.waitFor(() => expect(vi.mocked(app.catalogApi.listBooks).mock.calls.some(
      ([profileId]) => profileId === "profile-2",
    )).toBe(true));
    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    releaseFirstIndex();
    await connecting;

    await vi.waitFor(() => expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId))
      .toContain("profile-2"));
    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.at(-1)?.[0]).toBe("profile-2");
  });

  it("fails closed when the active match index exceeds the aggregate browser budget", async () => {
    const app = harness(true, {
      catalogReconciliationLimits: {
        entries: 1,
        deliveries: 10,
        stringValues: 100,
        stringCodeUnits: 10_000,
      },
    });
    vi.mocked(app.catalogApi.listProfiles).mockResolvedValue([
      {
        id: "profile-2", name: "Other", description: "", initial: "O", sourceLabel: "Other books",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
      {
        id: "profile-1", name: "Library", description: "", initial: "L", sourceLabel: "Books",
        enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1,
      },
    ]);
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(async (profileId) => ({
      profileId,
      generatedAt: "2026-08-30T00:00:00.000Z",
      entries: ["one", "two"].map((suffix) => ({
        bookId: `${app.book.id}-${suffix}`,
        sourceFilename: app.book.sourceFilename,
        sourceFormat: app.book.format,
        sourceSize: app.book.size,
        contentHash: app.book.contentHash!,
        identifiers: [],
        title: app.book.title,
        authors: ["Author"],
        deliveries: [],
      })),
    }));
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());

    await app.controller.connect();

    expect(vi.mocked(app.catalogApi.getMatchIndex).mock.calls.map(([profileId]) => profileId)).toEqual([
      "profile-1",
    ]);
    expect(app.controller.latestCatalogInventory?.matching).toMatchObject({
      status: "unavailable",
      matchedProfiles: 0,
      failedProfiles: 1,
      deferredProfiles: 1,
    });
    expect(app.controller.state.catalogInventoryState).toBe("failed");
    expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(true);
  });

  it("reports the exact safe-write failure and never reaches either book-transfer path", async () => {
    const app = harness();
    vi.mocked(app.connection.runSelfTest).mockRejectedValueOnce(
      new Error("Exact-byte comparison failed."),
    );

    await app.controller.connect("catalog");

    const automaticFailure = "Safe-write check failed. No book has been sent. Exact-byte comparison failed.";
    expect(app.controller.state.activeError?.message).toBe(automaticFailure);
    expect(app.controller.state.selfTest).toMatchObject({
      kind: "failed",
      error: { message: automaticFailure },
    });
    expect(app.connection.sendAzW3).not.toHaveBeenCalled();
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toThrow(
      "Safe-write check failed. No book has been sent. Reconnect the Kindle and let the automatic check pass.",
    );
    expect(app.connection.sendAzW3).not.toHaveBeenCalled();
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("runs the complete converted-artifact path without a conversion server", async () => {
    const app = harness();
    app.controller.selectEpub(new File(["epub bytes"], "book.epub", { type: "application/epub+zip" }));
    await app.controller.convert();
    expect(app.convert).toHaveBeenCalledOnce();
    expect(app.controller.state.conversion).toMatchObject({ kind: "ready", validated: true });

    await app.controller.connect("poc");
    expect(app.requestDevice).toHaveBeenCalledOnce();
    expect(app.controller.state).toMatchObject({ usbAccessProven: true, mtpReadProven: true, device: { kind: "ready" } });

    // The exact-byte check is part of the connection flow; the manual
    // diagnostics button remains available for an explicit repeat.
    expect(app.controller.state.selfTest).toMatchObject({ kind: "passed", byteLength: 1037 });

    await app.controller.sendIntegrated();
    expect(app.connection.sendAzW3).toHaveBeenCalledWith(
      expect.any(Blob), "book.azw3", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(app.controller.state.integratedTransfer).toMatchObject({ kind: "verified", artifactId: expect.any(String) });

    app.controller.confirmIntegratedOpened();
    expect(app.controller.state.integratedTransfer).toMatchObject({ physicalOpenConfirmed: true });
    expect(deriveGateStatuses(app.controller.state)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed"]);
  });

  it("enforces one browser-local conversion pipeline across POC Convert and catalog Send", async () => {
    const catalogFirst = harness();
    await catalogFirst.controller.connect();
    catalogFirst.controller.selectEpub(new File(["epub bytes"], "manual.epub", { type: "application/epub+zip" }));
    const baseCatalogConvert = vi.mocked(catalogFirst.convert).getMockImplementation() as
      | AppControllerDependencies["convert"]
      | undefined;
    if (!baseCatalogConvert) throw new Error("Missing converter implementation");
    let releaseCatalogConversion!: () => void;
    vi.mocked(catalogFirst.convert).mockImplementationOnce(async (file: File, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => { releaseCatalogConversion = resolve; });
      return baseCatalogConvert(file, signal);
    });

    const sending = catalogFirst.controller.sendCatalogBook({ profileId: "profile-1", book: catalogFirst.book });
    await vi.waitFor(() => expect(catalogFirst.convert).toHaveBeenCalledOnce());
    await catalogFirst.controller.convert();
    expect(catalogFirst.convert).toHaveBeenCalledOnce();
    expect(catalogFirst.controller.state.activeError?.code).toBe("CONVERSION_BUSY");
    releaseCatalogConversion();
    await sending;

    const pocFirst = harness();
    await pocFirst.controller.connect();
    pocFirst.controller.selectEpub(new File(["epub bytes"], "manual.epub", { type: "application/epub+zip" }));
    const basePocConvert = vi.mocked(pocFirst.convert).getMockImplementation() as
      | AppControllerDependencies["convert"]
      | undefined;
    if (!basePocConvert) throw new Error("Missing converter implementation");
    let releasePocConversion!: () => void;
    vi.mocked(pocFirst.convert).mockImplementationOnce(async (file: File, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => { releasePocConversion = resolve; });
      return basePocConvert(file, signal);
    });

    const converting = pocFirst.controller.convert();
    await vi.waitFor(() => expect(pocFirst.convert).toHaveBeenCalledOnce());
    await expect(
      pocFirst.controller.sendCatalogBook({ profileId: "profile-1", book: pocFirst.book }),
    ).rejects.toMatchObject({ code: "CONVERSION_BUSY" });
    expect(pocFirst.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
    releasePocConversion();
    await converting;
  });

  it("surfaces conversion failures without unlocking the Kindle", async () => {
    const app = harness();
    app.convert.mockRejectedValueOnce(new Error("malformed EPUB"));
    app.controller.selectEpub(new File(["bad"], "bad.epub"));
    await app.controller.convert();
    expect(app.controller.state.conversion).toMatchObject({ kind: "error" });
    expect(app.controller.state.activeError?.message).toContain("malformed EPUB");
    expect(deriveGateStatuses(app.controller.state)[0]).toBe("failed");
  });

  it("sends a catalog source in one action, records it idempotently, and keeps the session open", async () => {
    const app = harness();
    await app.controller.connect();

    await app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });

    expect(app.catalogApi.getBookSource).toHaveBeenCalledWith(
      "profile-1", "book-1", expect.any(AbortSignal),
    );
    expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledWith(
      expect.any(Blob),
      "book.azw3",
      expect.objectContaining({ managedToken: expect.stringMatching(/^kb-[a-f0-9]{20}$/u) }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        aggregateTimeoutMs: expect.any(Number),
        deviceMetadataCache: "read-write",
        onObjectState: expect.any(Function),
      }),
    );
    expect(app.catalogApi.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-1",
        bookId: "book-1",
        status: "delivered",
        artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(app.connection.disconnect).not.toHaveBeenCalled();
    expect(app.controller.state.device.kind).toBe("ready");
    expect(new Uint8Array(await new Blob([Uint8Array.from(app.sourceBytes)]).arrayBuffer())).toEqual(app.sourceBytes);
  });

  it("does not use an absence verdict for a source version replaced before catalog invalidation arrives", async () => {
    const app = harness();
    await app.controller.connect();
    const replacement = {
      ...app.book,
      size: app.book.size + 1,
      contentHash: "f".repeat(64),
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    vi.mocked(app.catalogApi.getBook).mockResolvedValueOnce(replacement);

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({
      code: "CATALOG_SOURCE_CHANGED",
      message: expect.stringContaining("changed after Kindle comparison"),
    });
    expect(app.catalogApi.getBookSource).not.toHaveBeenCalled();
    expect(app.convert).not.toHaveBeenCalled();
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("releases the Kindle after a verified transfer when delivery recording never settles", async () => {
    const app = harness(false, { postUploadCatalogTimeoutMs: 15 });
    await app.controller.connect();
    vi.mocked(app.catalogApi.createDelivery).mockImplementation(() => new Promise(() => undefined));

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).resolves.toBeUndefined();

    expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
    expect(readPendingDeliveries()).toHaveLength(1);
    await app.controller.disconnect();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a verified duplicate guard when the delivery journal Web Lock rejects", async () => {
    const app = harness();
    await app.controller.connect();
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: vi.fn(async () => { throw new Error("Web Locks failed"); }) },
    });
    try {
      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).resolves.toBeUndefined();
      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
    } finally {
      if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("does not hold the Kindle lease when the delivery journal Web Lock never settles", async () => {
    const app = harness();
    await app.controller.connect();
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const request = vi.fn(() => new Promise<never>(() => undefined));
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    try {
      const startedAt = performance.now();
      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).resolves.toBeUndefined();

      expect(performance.now() - startedAt).toBeLessThan(2_500);
      expect(request).toHaveBeenCalledWith(
        "kindle-bridge:pending-deliveries",
        expect.objectContaining({ mode: "exclusive", signal: expect.any(AbortSignal) }),
        expect.any(Function),
      );
      expect(app.controller.state.device.kind).toBe("ready");
      expect(app.connection.disconnect).not.toHaveBeenCalled();
      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
    } finally {
      if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("releases a connected Kindle when initial catalog matching never settles", async () => {
    const app = harness(false, { connectCatalogTimeoutMs: 15 });
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(() => new Promise(() => undefined));

    await expect(app.controller.connect()).resolves.toBeUndefined();
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed" },
      catalogInventoryState: "failed",
    });
    await app.controller.disconnect();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["book", "source"] as const)(
    "bounds a never-settling pre-upload catalog %s request before MTP write",
    async (phase) => {
      const app = harness(false, { preUploadCatalogTimeoutMs: 15 });
      await app.controller.connect();
      if (phase === "book") {
        vi.mocked(app.catalogApi.getBook).mockImplementation(() => new Promise(() => undefined));
      } else {
        vi.mocked(app.catalogApi.getBookSource).mockImplementation(() => new Promise(() => undefined));
      }

      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).rejects.toMatchObject({ code: "CATALOG_REQUEST_FAILED" });
      expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
      await app.controller.disconnect();
      expect(app.connection.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("keeps a maximum-size source viable past two minutes and still aborts at the ten-minute bound", async () => {
    vi.useFakeTimers();
    try {
      const app = harness();
      await app.controller.connect();
      let sourceSignal: AbortSignal | undefined;
      vi.mocked(app.catalogApi.getBookSource).mockImplementation((_profileId, _bookId, signal) => {
        sourceSignal = signal;
        return new Promise(() => undefined);
      });
      const sending = app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });
      const rejected = expect(sending).rejects.toMatchObject({ code: "CATALOG_REQUEST_FAILED" });
      for (let index = 0; index < 8 && !sourceSignal; index += 1) await Promise.resolve();
      expect(sourceSignal).toBeDefined();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sourceSignal?.aborted).toBe(false);
      expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(480_000);
      await rejected;
      expect(sourceSignal?.aborted).toBe(true);
      expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
      await app.controller.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the controller's degraded terminal message in the one-click Send sheet", async () => {
    const app = harness(true, { postUploadCatalogTimeoutMs: 20 });
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());
    await app.controller.connect();
    await vi.waitFor(() => expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(false));
    vi.mocked(app.catalogApi.createDelivery).mockRejectedValue(new Error("catalog unavailable"));
    vi.mocked(app.catalogApi.getMatchIndex).mockRejectedValue(new Error("match index unavailable"));

    app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.click();

    await vi.waitFor(() => expect(app.root.querySelector(".library-transfer-status")?.textContent)
      .toContain("live catalog matching will retry"));
    expect(app.root.textContent).toContain("The transfer of “Book” was verified");
    expect(app.root.textContent).not.toContain("is on the connected Kindle");
  });

  it("bounds post-upload match reconciliation when the catalog request ignores abort", async () => {
    const app = harness(false, { postUploadCatalogTimeoutMs: 15 });
    await app.controller.connect();
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(() => new Promise(() => undefined));

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).resolves.toBeUndefined();

    expect(app.controller.state.catalogInventoryState).toBe("failed");
    await app.controller.disconnect();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
  });

  it("does not let reconciliation finishing after its deadline restore Send authority", async () => {
    const app = harness(false, { postUploadCatalogTimeoutMs: 15 });
    await app.controller.connect();
    vi.mocked(app.catalogApi.getMatchIndex).mockResolvedValue({
      profileId: "profile-1",
      generatedAt: "2026-08-30T00:00:00.000Z",
      entries: [{
        bookId: app.book.id,
        title: app.book.title,
        authors: app.book.authors,
        identifiers: app.book.identifiers,
        sourceFormat: app.book.format,
        sourceSize: app.book.size,
        contentHash: app.book.contentHash!,
        sourceFilename: app.book.sourceFilename,
        deliveries: [],
      }],
    });
    let releaseDigest!: () => void;
    let digestSpy: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename, options) => {
      const managedToken = options?.managedToken;
      if (!managedToken) throw new Error("Expected a managed token");
      digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(
        () => new Promise<ArrayBuffer>((resolve) => {
          releaseDigest = () => resolve(new Uint8Array(32).buffer);
        }),
      );
      const object = {
        handle: 97,
        storageId: 0x10001,
        parentHandle: 0x37,
        objectFormat: 0xb00a,
        protectionStatus: 0,
        associationType: 0,
        size: blob.size,
        filename: `Book-${managedToken}.azw3`,
        relativePath: `Book-${managedToken}.azw3`,
        depth: 1,
        kind: "file" as const,
        managedToken,
        metadataAdjusted: false,
      };
      return {
        transfer: { ...object, verified: true as const },
        inventory: {
          status: "complete" as const,
          storageId: object.storageId,
          documentsHandle: object.parentHandle,
          objects: [object],
          issues: [],
          issueCount: 0,
          scannedObjectCount: 1,
        },
        inventoryRefresh: "complete" as const,
      };
    });

    try {
      const sending = app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });
      await vi.waitFor(() => expect(digestSpy).toHaveBeenCalledOnce());
      await expect(sending).resolves.toBeUndefined();
      expect(app.controller.state.catalogInventoryState).toBe("failed");

      releaseDigest();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(app.controller.state.catalogInventoryState).toBe("failed");
      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally {
      digestSpy?.mockRestore();
    }
  });

  it("retires a post-upload faulted session without inviting a duplicate retry", async () => {
    const app = harness(false, { postUploadCatalogTimeoutMs: 15 });
    await app.controller.connect();
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename) => ({
      transfer: {
        storageId: 0x10001,
        parentHandle: 0x37,
        filename,
        size: blob.size,
        handle: 98,
        verified: true,
      },
      inventoryRefresh: "failed",
      inventoryErrorCode: "MTP_INVALID_CONTAINER",
      connectionFaulted: true,
    }));

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).resolves.toBeUndefined();

    expect(app.catalogApi.createDelivery).toHaveBeenCalledOnce();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
    expect(app.controller.state.device).toMatchObject({
      kind: "error",
      error: { code: "MTP_TRANSPORT_ERROR" },
    });
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "MTP_SELF_TEST_REQUIRED" });
  });

  it("retires the session and releases its lease when the upload command itself fails fatally", async () => {
    const app = harness();
    await app.controller.connect();
    const fatal = Object.assign(new Error("bulk endpoint desynchronized during upload"), {
      code: "MTP_TRANSPORT_ERROR",
      fatal: true,
    });
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockRejectedValueOnce(fatal);

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "MTP_TRANSPORT_ERROR" });

    expect(app.connection.disconnect).toHaveBeenCalledOnce();
    expect(app.controller.state.device).toMatchObject({
      kind: "error",
      error: { code: "MTP_TRANSPORT_ERROR" },
    });
    expect(app.controller.state.catalogInventoryState).toBe("idle");
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "MTP_SELF_TEST_REQUIRED" });
    expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
  });

  it("never greens a replacement catalog version from a stale post-upload fallback", async () => {
    const app = harness(true);
    const initialIndex = {
      profileId: "profile-1",
      generatedAt: "2026-08-30T00:00:00.000Z",
      entries: [{
        bookId: app.book.id,
        sourceFilename: app.book.sourceFilename,
        sourceFormat: app.book.format,
        sourceSize: app.book.size,
        contentHash: app.book.contentHash!,
        identifiers: app.book.identifiers,
        title: app.book.title,
        authors: app.book.authors,
        deliveries: [],
      }],
    };
    vi.mocked(app.catalogApi.getMatchIndex)
      .mockResolvedValueOnce(initialIndex)
      .mockRejectedValue(new Error("post-upload match index unavailable"));
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')).not.toBeNull());
    await app.controller.connect();

    let releaseUpload!: () => void;
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename, options) => {
      const managedToken = options?.managedToken;
      if (!managedToken) throw new Error("Expected a managed filename token");
      await new Promise<void>((resolve) => { releaseUpload = resolve; });
      const object = {
        handle: 90,
        storageId: 0x10001,
        parentHandle: 0x37,
        objectFormat: 0xb00a,
        protectionStatus: 0,
        associationType: 0,
        size: blob.size,
        filename: `Book-${managedToken}-verified.azw3`,
        relativePath: `Book-${managedToken}-verified.azw3`,
        depth: 1,
        kind: "file" as const,
        managedToken,
        metadataAdjusted: false,
      };
      return {
        transfer: {
          storageId: object.storageId,
          parentHandle: object.parentHandle,
          filename: object.filename,
          size: object.size,
          handle: object.handle,
          verified: true,
        },
        inventory: {
          status: "complete",
          storageId: object.storageId,
          documentsHandle: object.parentHandle,
          objects: [object],
          issues: [],
          issueCount: 0,
          scannedObjectCount: 1,
        },
        inventoryRefresh: "complete",
      };
    });

    const sending = app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });
    await vi.waitFor(() => expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce());
    const replacement: CatalogBook = {
      ...app.book,
      title: "Book — replacement bytes",
      contentHash: "f".repeat(64),
      updatedAt: "2026-08-30T00:01:00.000Z",
    };
    vi.mocked(app.catalogApi.listBooks).mockResolvedValue({ items: [replacement], total: 1, limit: 24, offset: 0 });
    vi.mocked(app.catalogApi.getBook).mockResolvedValue(replacement);
    app.emitCatalogEvent({
      id: "event-replacement",
      type: "book.updated",
      at: replacement.updatedAt,
      profileId: replacement.profileId,
      bookId: replacement.id,
    });
    await vi.waitFor(() => expect(app.root.querySelector('[data-book-id="book-1"]')?.textContent).toContain("replacement bytes"));

    releaseUpload();
    await sending;
    await vi.waitFor(() => expect(app.controller.state.catalogInventoryState).toBe("failed"));

    const card = app.root.querySelector<HTMLElement>('[data-book-id="book-1"]');
    expect(card?.querySelector('.library-kindle-check[aria-label="Already on this Kindle"]')).toBeNull();
    expect(app.controller.latestCatalogInventory?.items[0]).toMatchObject({ match: "unmatched" });
    expect(app.controller.latestCatalogInventory?.items[0]?.bookId).toBeUndefined();
    expect(app.controller.latestCatalogInventory?.matching?.status).toBe("unavailable");
  });

  it.each(["failed", "omitted"] as const)(
    "blocks an immediate duplicate when the post-send inventory refresh is %s",
    async (refreshCase) => {
      const app = harness();
      vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename) => ({
        transfer: {
          storageId: 0x10001,
          parentHandle: 0x37,
          filename,
          size: blob.size,
          handle: 96,
          verified: true,
        },
        ...(refreshCase === "omitted" ? {
          inventory: {
            status: "complete" as const,
            storageId: 0x10001,
            documentsHandle: 0x37,
            objects: [],
            issues: [],
            issueCount: 0,
            scannedObjectCount: 0,
          },
          inventoryRefresh: "complete" as const,
        } : {
          inventoryRefresh: "failed" as const,
        }),
      }));
      await app.controller.connect();

      await app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });
      expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();

      await expect(
        app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
      ).rejects.toMatchObject({
        code: "INVALID_STATE",
        message: expect.stringContaining("inventory and catalog comparison are not ready"),
      });
      expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
    },
  );

  it("keeps a successful Send visibly possible when duplicate managed-token objects are ambiguous", async () => {
    const app = harness(true);
    vi.mocked(app.catalogApi.getMatchIndex).mockResolvedValue({
      profileId: "profile-1",
      generatedAt: "2026-08-30T00:00:00.000Z",
      entries: [{
        bookId: app.book.id,
        sourceFilename: app.book.sourceFilename,
        sourceFormat: app.book.format,
        sourceSize: app.book.size,
        contentHash: app.book.contentHash!,
        identifiers: app.book.identifiers,
        title: app.book.title,
        authors: app.book.authors,
        deliveries: [],
      }],
    });
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, _filename, options) => {
      const managedToken = options?.managedToken;
      if (!managedToken) throw new Error("Expected a managed filename token");
      const object = (handle: number, suffix: string) => ({
        handle,
        storageId: 0x10001,
        parentHandle: 0x37,
        objectFormat: 0xb00a,
        protectionStatus: 0,
        associationType: 0,
        size: blob.size,
        filename: `Book-${managedToken}-${suffix}.azw3`,
        relativePath: `Books/Book-${managedToken}-${suffix}.azw3`,
        depth: 2,
        kind: "file" as const,
        managedToken,
        metadataAdjusted: false,
      });
      const first = object(70, "first");
      const duplicate = object(71, "duplicate");
      return {
        transfer: {
          storageId: first.storageId,
          parentHandle: first.parentHandle,
          filename: first.filename,
          size: first.size,
          handle: first.handle,
          verified: true,
        },
        inventory: {
          status: "complete",
          storageId: first.storageId,
          documentsHandle: first.parentHandle,
          objects: [first, duplicate],
          issues: [],
          issueCount: 0,
          scannedObjectCount: 2,
        },
        inventoryRefresh: "complete",
      };
    });

    await vi.waitFor(() => {
      expect(app.root.querySelector('[data-book-id="book-1"] [data-ui-action="send-book"]')).not.toBeNull();
    });
    await app.controller.connect();
    await vi.waitFor(() => expect(app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    )?.disabled).toBe(false));
    const sendButton = app.root.querySelector<HTMLButtonElement>(
      '[data-book-id="book-1"] [data-ui-action="send-book"]',
    );
    sendButton?.click();

    await vi.waitFor(() => {
      expect(app.root.querySelector(".library-transfer-status strong")?.textContent).toContain("Complete");
    });
    expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
    expect(app.controller.latestCatalogInventory?.items).toHaveLength(2);
    expect(app.controller.latestCatalogInventory?.items.every(({ match }) => match === "possible")).toBe(true);
    const card = app.root.querySelector<HTMLElement>('[data-book-id="book-1"]');
    expect(card?.textContent).toContain("Possible Kindle match");
    expect(card?.querySelector('.library-kindle-check[aria-label="Already on this Kindle"]')).toBeNull();
    expect(card?.querySelector<HTMLButtonElement>('[data-ui-action="send-book"]')).toMatchObject({
      disabled: true,
      textContent: "Possible match",
    });
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("may already be on the connected Kindle"),
    });
    expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])("blocks a retry when a partial raw inventory contains %i exact managed-token object(s)", async (count) => {
    const app = harness();
    const managedToken = await createManagedFilenameToken(app.book.id, app.book.contentHash!);
    const objects = Array.from({ length: count }, (_, index) => ({
      handle: 80 + index,
      storageId: 0x10001,
      parentHandle: 0x37,
      objectFormat: 0xb00a,
      protectionStatus: 0,
      associationType: 0,
      size: 512,
      filename: `Book-${managedToken}-${index}.azw3`,
      relativePath: `Book-${managedToken}-${index}.azw3`,
      depth: 1,
      kind: "file" as const,
      managedToken,
      metadataAdjusted: false,
    }));
    const partialInventory = {
      status: "partial" as const,
      storageId: 0x10001,
      documentsHandle: 0x37,
      objects,
      issues: [{ code: "children-unavailable" as const, operation: "list-children" as const }],
      issueCount: 1,
      scannedObjectCount: objects.length,
    };
    const guardedConnection: ConnectedKindlePort = {
      ...app.connection,
      get closed() { return app.connection.closed; },
      get readyForSend() { return app.connection.readyForSend; },
      latestInventory: partialInventory,
      refreshInventory: vi.fn(async () => partialInventory),
      sendAzW3AndRefreshInventory: vi.fn(app.connection.sendAzW3AndRefreshInventory),
    };
    vi.mocked(app.openDevice).mockResolvedValueOnce(guardedConnection);
    await app.controller.connect();

    await expect(app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book })).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("inventory and catalog comparison are not ready"),
    });
    expect(guardedConnection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
    expect(app.catalogApi.createDelivery).not.toHaveBeenCalled();
  });

  it("never reuses Kindle A raw inventory for Kindle B after B inventory fails", async () => {
    const app = harness(true);
    const managedToken = await createManagedFilenameToken(app.book.id, app.book.contentHash!);
    const kindleAInventory = {
      status: "complete" as const,
      storageId: 0x10001,
      documentsHandle: 0x37,
      objects: [{
        handle: 91,
        storageId: 0x10001,
        parentHandle: 0x37,
        objectFormat: 0xb00a,
        protectionStatus: 0,
        associationType: 0,
        size: 512,
        filename: `Book-${managedToken}.azw3`,
        relativePath: `Book-${managedToken}.azw3`,
        depth: 1,
        kind: "file" as const,
        managedToken,
        metadataAdjusted: false,
      }],
      issues: [],
      issueCount: 0,
      scannedObjectCount: 1,
    };
    vi.mocked(app.connection.refreshInventory).mockResolvedValueOnce(kindleAInventory);
    vi.mocked(app.catalogApi.getMatchIndex).mockResolvedValue({
      profileId: "profile-1",
      generatedAt: "2026-08-30T00:00:00.000Z",
      entries: [{
        bookId: app.book.id,
        sourceFilename: app.book.sourceFilename,
        sourceFormat: app.book.format,
        sourceSize: app.book.size,
        contentHash: app.book.contentHash!,
        managedToken,
        identifiers: app.book.identifiers,
        title: app.book.title,
        authors: app.book.authors,
        deliveries: [],
      }],
    });
    await vi.waitFor(() => expect(app.catalogApi.subscribeEvents).toHaveBeenCalledOnce());
    await app.controller.connect();
    expect(app.controller.latestCatalogInventory).toMatchObject({
      completeness: "complete",
      items: [expect.objectContaining({ filename: `Book-${managedToken}.azw3` })],
    });
    await app.controller.disconnect();
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");

    const kindleBDevice = fakeDevice();
    let kindleBClosed = false;
    let kindleBSelfTestPassed = false;
    const kindleBConnection: ConnectedKindlePort = {
      device: kindleBDevice,
      details: { ...app.connection.details, productName: "Kindle B", model: "Travel Kindle" },
      identityKey: "opaque-device-key-b",
      get closed() { return kindleBClosed; },
      get readyForSend() { return kindleBSelfTestPassed && !kindleBClosed; },
      get latestInventory() { return undefined; },
      runSelfTest: vi.fn(async () => {
        kindleBSelfTestPassed = true;
        return { filename: "kindle-poc-byte-test.txt", handle: 101, bytesVerified: 1037, cleanedUp: true as const };
      }),
      prepareAfterConnect: vi.fn(async (options) => ({
        selfTest: await kindleBConnection.runSelfTest(options?.selfTest),
        inventoryRefresh: "failed" as const,
        inventoryErrorCode: "MTP_TIMEOUT",
      })),
      refreshInventory: vi.fn(async () => { throw new Error("inventory unavailable"); }),
      sendAzW3: vi.fn(async () => { throw new Error("must not send"); }),
      sendAzW3AndRefreshInventory: vi.fn(async () => { throw new Error("must not send"); }),
      disconnect: vi.fn(async () => { kindleBClosed = true; }),
      closeAfterPhysicalDisconnect: vi.fn(async () => { kindleBClosed = true; }),
    };
    vi.mocked(app.openDevice).mockResolvedValueOnce(kindleBConnection);
    await app.controller.connect();
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready", details: { model: "Travel Kindle" } },
      selfTest: { kind: "passed" },
      catalogInventoryState: "failed",
    });
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");

    const matchRequestsBeforeEvent = vi.mocked(app.catalogApi.getMatchIndex).mock.calls.length;
    const bookRequestsBeforeEvent = vi.mocked(app.catalogApi.listBooks).mock.calls.length;
    app.emitCatalogEvent({
      id: "event-after-kindle-b-inventory-failure",
      type: "catalog.changed",
      at: "2026-08-30T00:00:00.000Z",
      profileId: "profile-1",
    });
    await vi.waitFor(() => {
      expect(app.catalogApi.listBooks).toHaveBeenCalledTimes(bookRequestsBeforeEvent + 1);
    });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(app.catalogApi.getMatchIndex).toHaveBeenCalledTimes(matchRequestsBeforeEvent);
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");

    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("inventory and catalog comparison are not ready"),
    });
    expect(app.catalogApi.getBook).not.toHaveBeenCalled();
    expect(kindleBConnection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("reconciles a catalog event received while a manual self-test owns the MTP session", async () => {
    const app = harness(true);
    await vi.waitFor(() => expect(app.catalogApi.subscribeEvents).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(app.catalogApi.listBooks).toHaveBeenCalledOnce());
    await app.controller.connect();
    const initialMatchRequests = vi.mocked(app.catalogApi.getMatchIndex).mock.calls.length;
    const initialBookRequests = vi.mocked(app.catalogApi.listBooks).mock.calls.length;
    let releaseSelfTest!: () => void;
    vi.mocked(app.connection.runSelfTest).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseSelfTest = resolve; });
      return {
        filename: "kindle-poc-byte-test.txt",
        handle: 44,
        bytesVerified: 1037,
        cleanedUp: true,
      };
    });

    const selfTest = app.controller.runSelfTest();
    await vi.waitFor(() => expect(app.connection.runSelfTest).toHaveBeenCalledTimes(2));
    app.emitCatalogEvent({
      id: "event-during-self-test",
      type: "catalog.changed",
      at: "2026-08-30T00:00:00.000Z",
      profileId: "profile-1",
    });
    await vi.waitFor(() => {
      expect(app.catalogApi.listBooks).toHaveBeenCalledTimes(initialBookRequests + 1);
    });
    // Let the event refresh reach the controller hook while the self-test is
    // still deliberately blocked. Reconciliation must wait for MTP to go idle.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(app.catalogApi.getMatchIndex).toHaveBeenCalledTimes(initialMatchRequests);

    releaseSelfTest();
    await selfTest;
    await vi.waitFor(() => {
      expect(app.catalogApi.getMatchIndex).toHaveBeenCalledTimes(initialMatchRequests + 1);
    });
  });

  it("bounds live-event catalog reconciliation when an index request ignores abort", async () => {
    const app = harness(true, { connectedCatalogTimeoutMs: 15 });
    await vi.waitFor(() => expect(app.catalogApi.listBooks).toHaveBeenCalledOnce());
    await app.controller.connect();
    const initialMatchRequests = vi.mocked(app.catalogApi.getMatchIndex).mock.calls.length;
    const initialBookRequests = vi.mocked(app.catalogApi.listBooks).mock.calls.length;
    vi.mocked(app.catalogApi.getMatchIndex).mockImplementation(() => new Promise(() => undefined));

    app.emitCatalogEvent({
      id: "event-with-stalled-index",
      type: "catalog.changed",
      at: "2026-08-30T00:00:00.000Z",
      profileId: "profile-1",
    });

    await vi.waitFor(() => {
      expect(app.catalogApi.listBooks).toHaveBeenCalledTimes(initialBookRequests + 1);
      expect(app.catalogApi.getMatchIndex).toHaveBeenCalledTimes(initialMatchRequests + 1);
      expect(app.controller.state.catalogInventoryState).toBe("failed");
    });
    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed" },
    });
    await app.controller.disconnect();
    expect(app.connection.disconnect).toHaveBeenCalledOnce();
  });

  it("invalidates retained device authority after a BFCache restore", async () => {
    const app = harness();
    await app.controller.connect();
    expect(app.controller.state.selfTest.kind).toBe("passed");
    expect(app.controller.latestCatalogInventory?.completeness).toBe("complete");

    app.browserLifecycle.restoreFromBfcache();
    await vi.waitFor(() => expect(app.connection.disconnect).toHaveBeenCalledOnce());

    expect(app.controller.state).toMatchObject({
      usbAccessProven: false,
      mtpReadProven: false,
      device: { kind: "error", error: { code: "USB_SESSION_STALE" } },
      selfTest: { kind: "not-run" },
      activeError: {
        code: "USB_SESSION_STALE",
        details: { reason: "bfcache-restore" },
      },
    });
    expect(app.controller.state.activeError?.message).toContain("back/forward cache");
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "MTP_SELF_TEST_REQUIRED" });
    expect(app.connection.sendAzW3AndRefreshInventory).not.toHaveBeenCalled();
  });

  it("keeps a retained connection through a short observable hidden interval", async () => {
    const app = harness();
    await app.controller.connect();

    app.browserLifecycle.setVisibility("hidden");
    app.advanceTime(59_999);
    app.browserLifecycle.setVisibility("visible");
    await Promise.resolve();

    expect(app.controller.state).toMatchObject({
      device: { kind: "ready" },
      selfTest: { kind: "passed" },
      activeError: undefined,
    });
    expect(app.connection.disconnect).not.toHaveBeenCalled();
  });

  it("aborts an in-flight Send after a long hidden gap and closes MTP only after the operation drains", async () => {
    const app = harness();
    await app.controller.connect();
    let releaseSend!: () => void;
    let operationSignal: AbortSignal | undefined;
    vi.mocked(app.connection.sendAzW3AndRefreshInventory).mockImplementationOnce(async (blob, filename, options) => {
      operationSignal = options?.signal;
      await new Promise<void>((resolve) => { releaseSend = resolve; });
      return {
        transfer: {
          storageId: 0x10001,
          parentHandle: 0x37,
          filename,
          size: blob.size,
          handle: 99,
          verified: true,
        },
        inventoryRefresh: "failed",
      };
    });

    const sending = app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book });
    await vi.waitFor(() => expect(app.connection.sendAzW3AndRefreshInventory).toHaveBeenCalledOnce());
    app.browserLifecycle.setVisibility("hidden");
    app.advanceTime(60_000);
    app.browserLifecycle.setVisibility("visible");

    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toMatchObject({ code: "USB_SESSION_STALE" });
    expect(app.connection.disconnect).not.toHaveBeenCalled();
    expect(app.controller.state).toMatchObject({
      device: { kind: "error", error: { code: "USB_SESSION_STALE" } },
      selfTest: { kind: "not-run" },
      activeError: {
        code: "USB_SESSION_STALE",
        details: { reason: "visibility-gap", hiddenMilliseconds: 60_000 },
      },
    });
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");

    releaseSend();
    await expect(sending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(app.connection.disconnect).toHaveBeenCalledOnce());
    expect(app.catalogApi.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "delivered", bookId: "book-1" }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(app.controller.latestCatalogInventory?.completeness).toBe("last-seen");
    await expect(
      app.controller.sendCatalogBook({ profileId: "profile-1", book: app.book }),
    ).rejects.toMatchObject({ code: "MTP_SELF_TEST_REQUIRED" });
  });
});
