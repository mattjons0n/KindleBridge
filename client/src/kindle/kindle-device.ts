import type {
  KindleCreatedObject,
  KindleObjectStore,
  KindleOperationOptions,
  KindleStoredObjectInfo,
  KindleTarget,
} from "./contracts";
import { KindleDeviceError } from "./errors";
import {
  createCollisionResistantFilename,
  createManagedCollisionResistantFilename,
  createSelfTestFilename,
  filenamesEqual,
  normalizeManagedFilenameToken,
} from "./filenames";
import {
  buildKindleInventory,
  type KindleDeviceMetadataCacheWriteOutcome,
  type KindleInventoryFolderSeed,
  type KindleInventoryDeviceMetadataCacheDiagnostics,
  type KindleInventoryMetadataCacheContext,
  type KindleInventoryOptions,
  type KindleInventorySnapshot,
} from "./inventory";
import {
  isKindleDeviceMetadataCacheTransportFailure,
  kindleInventoryToDeviceMetadataCacheEntries,
  loadKindleBridgeDeviceMetadataCache,
  makeKindleBridgeDeviceMetadataCache,
  planKindleBridgeDeviceMetadataCacheWrite,
  type LoadedKindleBridgeDeviceMetadataCache,
} from "./device-metadata-cache";
import {
  encodeKindleBridgeDeviceMetadataCache,
  type KindleBridgeDeviceMetadataCacheSlot,
} from "./device-metadata-cache-codec";
import { KINDLE_SELF_TEST_PAYLOAD } from "./self-test-payload";
import {
  describeStructuredFailure,
  findTransportDiagnostic,
} from "../error-diagnostics";

export const MTP_OBJECT_FORMAT_UNDEFINED = 0x3000;
export const MTP_OBJECT_FORMAT_ASSOCIATION = 0x3001;
export const MTP_OBJECT_FORMAT_TEXT = 0x3004;
export const MTP_ROOT_ASSOCIATION_HANDLE = 0xffff_ffff;
export const MTP_ACCESS_READ_WRITE = 0x0000;
const MAX_ROOT_OBJECT_HANDLES = 256;
const MAX_DOCUMENT_CHILD_HANDLES = 10_000;

export interface KindleDeviceOptions {
  now?: () => Date;
  random?: () => number;
}

export interface KindleSelfTestResult {
  filename: string;
  handle: number;
  bytesVerified: number;
  cleanedUp: true;
}

export interface KindleBookTransferResult {
  filename: string;
  handle: number;
  size: number;
  storageId: number;
  parentHandle: number;
  verified: true;
  managedToken?: string;
}

export interface KindleTransferProgress {
  bytesTransferred: number;
  totalBytes: number;
}

export interface KindleSendOptions extends KindleOperationOptions {
  readonly onProgress?: (progress: KindleTransferProgress) => void;
  /** Stable catalog-derived token embedded in the derivative filename. */
  readonly managedToken?: string;
}

interface ObjectExpectation {
  handle: number;
  storageId: number;
  parentHandle: number;
  filename: string;
  size: number;
}

interface DeviceMetadataCacheWriteResult {
  readonly outcome: KindleDeviceMetadataCacheWriteOutcome;
  readonly candidateEntryCount: number;
  readonly writtenEntryCount: number;
  readonly byteCount: number;
  readonly slot?: KindleBridgeDeviceMetadataCacheSlot;
}

type RootFilenamePreflight =
  | { readonly outcome: "available" }
  | { readonly outcome: "name-conflict" }
  | { readonly outcome: "capacity" }
  | { readonly outcome: "unavailable" };

interface GeneratedFilenamePreflight {
  readonly filename: string;
  readonly children: readonly KindleStoredObjectInfo[];
}

interface RootInspection {
  readonly documents?: KindleStoredObjectInfo;
  readonly objects: readonly KindleStoredObjectInfo[];
}

function bigintSize(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Object size must be a non-negative safe integer.");
  }
  return BigInt(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createdHandleFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = Reflect.get(error, "createdHandle");
  if (typeof direct === "number" && Number.isSafeInteger(direct)) return direct;
  const partialHandle = Reflect.get(error, "handle");
  if (
    typeof partialHandle === "number" &&
    Number.isSafeInteger(partialHandle)
  ) {
    return partialHandle;
  }
  const details = Reflect.get(error, "details");
  if (!details || typeof details !== "object") return undefined;
  const nested = Reflect.get(details, "createdHandle");
  return typeof nested === "number" && Number.isSafeInteger(nested)
    ? nested
    : undefined;
}

function partialUploadOutcome(error: unknown):
  | {
      handle: number;
      filename?: string;
      cleanupAttempted: boolean;
      cleanupSucceeded: boolean;
      cleanupError?: unknown;
    }
  | undefined {
  if (!error || typeof error !== "object") return undefined;
  const handle = Reflect.get(error, "handle");
  const cleanupAttempted = Reflect.get(error, "cleanupAttempted");
  const cleanupSucceeded = Reflect.get(error, "cleanupSucceeded");
  if (
    typeof handle !== "number" ||
    !Number.isSafeInteger(handle) ||
    typeof cleanupAttempted !== "boolean" ||
    typeof cleanupSucceeded !== "boolean"
  ) {
    return undefined;
  }
  const filename = Reflect.get(error, "filename");
  return {
    handle,
    ...(typeof filename === "string" ? { filename } : {}),
    cleanupAttempted,
    cleanupSucceeded,
    cleanupError: Reflect.get(error, "cleanupError"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!error || typeof error !== "object") return false;
  return Reflect.get(error, "code") === "MTP_OPERATION_ABORTED";
}

function cacheWriteResult(
  outcome: KindleDeviceMetadataCacheWriteOutcome,
  candidateEntryCount: number,
  options: {
    readonly writtenEntryCount?: number;
    readonly byteCount?: number;
    readonly slot?: KindleBridgeDeviceMetadataCacheSlot;
  } = {},
): DeviceMetadataCacheWriteResult {
  return Object.freeze({
    outcome,
    candidateEntryCount,
    writtenEntryCount: options.writtenEntryCount ?? 0,
    byteCount: options.byteCount ?? 0,
    ...(options.slot === undefined ? {} : { slot: options.slot }),
  });
}

function deviceCacheDiagnostics(
  mode: KindleInventoryDeviceMetadataCacheDiagnostics["mode"],
  loaded: LoadedKindleBridgeDeviceMetadataCache | undefined,
  write: DeviceMetadataCacheWriteResult,
): KindleInventoryDeviceMetadataCacheDiagnostics {
  if (mode === "disabled" || loaded === undefined) {
    return Object.freeze({
      mode,
      loadOutcome: "disabled",
      rootHandleCount: 0,
      unreadableRootObjectCount: 0,
      slots: Object.freeze({
        a: Object.freeze({ outcome: "disabled", entryCount: 0 }),
        b: Object.freeze({ outcome: "disabled", entryCount: 0 }),
      }),
      activeEntryCount: 0,
      generationAmbiguous: false,
      writeCandidateEntryCount: write.candidateEntryCount,
      writeOutcome: write.outcome,
      writtenEntryCount: write.writtenEntryCount,
      cachePayloadByteCount: write.byteCount,
      ...(write.slot === undefined ? {} : { writeSlot: write.slot }),
    });
  }
  const loadOutcome: KindleInventoryDeviceMetadataCacheDiagnostics["loadOutcome"] =
    loaded.rootDiscoveryOutcome === "unavailable"
      ? "root-unavailable"
      : loaded.generationAmbiguous
        ? "generation-conflict"
        : loaded.active !== undefined
          ? "loaded"
          : loaded.blockedSlots.size > 0
            ? "blocked"
            : "none";
  return Object.freeze({
    mode,
    loadOutcome,
    rootHandleCount: loaded.rootHandleCount,
    unreadableRootObjectCount: loaded.unreadableRootObjectCount,
    slots: loaded.slotDiagnostics,
    activeEntryCount: loaded.active?.snapshot.cache.entries.length ?? 0,
    generationAmbiguous: loaded.generationAmbiguous,
    writeCandidateEntryCount: write.candidateEntryCount,
    writeOutcome: write.outcome,
    writtenEntryCount: write.writtenEntryCount,
    cachePayloadByteCount: write.byteCount,
    ...(write.slot === undefined ? {} : { writeSlot: write.slot }),
  });
}

export class KindleDevice {
  readonly store: KindleObjectStore;
  private target?: KindleTarget;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly createdHandles = new Map<number, string>();
  private inventoryFolderSeed?: KindleInventoryFolderSeed;
  private rootObjectSeed?: {
    readonly storageId: number;
    readonly objects: readonly KindleStoredObjectInfo[];
  };
  private readonly inventoryMetadataCacheContext?: KindleInventoryMetadataCacheContext;
  private selfTestPassed = false;

  constructor(
    store: KindleObjectStore,
    options: KindleDeviceOptions = {},
    inventoryMetadataCacheContext?: KindleInventoryMetadataCacheContext,
  ) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.inventoryMetadataCacheContext = inventoryMetadataCacheContext;
  }

  get currentTarget(): Readonly<KindleTarget> | undefined {
    return this.target;
  }

  get sessionCreatedHandles(): ReadonlyMap<number, string> {
    return new Map(this.createdHandles);
  }

  /** Finds a writable store containing a root Documents association. */
  async inspect(
    requiredBytes = 0,
    options: KindleOperationOptions = {},
  ): Promise<KindleTarget> {
    this.selfTestPassed = false;
    const required = bigintSize(requiredBytes);
    const storageIds = await this.store.listStorageIds(options);
    let writableCount = 0;
    let documentsCount = 0;
    const candidates: Array<KindleTarget & {
      readonly rootObjects: readonly KindleStoredObjectInfo[];
    }> = [];

    for (const storageId of storageIds) {
      const storage = await this.store.getStorageInfo(storageId, options);
      if (storage.accessCapability !== MTP_ACCESS_READ_WRITE) continue;
      writableCount += 1;

      const root = await this.inspectRoot(storageId, options);
      const documents = root.documents;
      if (!documents) continue;
      documentsCount += 1;
      if (storage.freeSpaceInBytes < required) continue;

      candidates.push({
        storageId,
        storage,
        documentsHandle: documents.handle,
        documents,
        rootObjects: root.objects,
      });
    }

    if (writableCount === 0) {
      throw new KindleDeviceError(
        "MTP_STORAGE_NOT_WRITABLE",
        "The Kindle exposes no writable MTP storage.",
        { storageIds: [...storageIds] },
      );
    }
    if (documentsCount === 0) {
      throw new KindleDeviceError(
        "MTP_DOCUMENTS_NOT_FOUND",
        "No root folder association named Documents was found on writable storage.",
        { writableStorageCount: writableCount },
      );
    }
    if (candidates.length === 0) {
      throw new KindleDeviceError(
        "MTP_INSUFFICIENT_SPACE",
        `No writable Documents storage has ${requiredBytes} free bytes.`,
        { requiredBytes },
      );
    }

    candidates.sort((left, right) => {
      if (left.storage.freeSpaceInBytes === right.storage.freeSpaceInBytes) {
        return 0;
      }
      return left.storage.freeSpaceInBytes > right.storage.freeSpaceInBytes
        ? -1
        : 1;
    });
    const selected = candidates[0]!;
    this.target = {
      storageId: selected.storageId,
      storage: selected.storage,
      documentsHandle: selected.documentsHandle,
      documents: selected.documents,
    };
    this.rootObjectSeed = {
      storageId: selected.storageId,
      objects: selected.rootObjects,
    };
    return this.target;
  }

  async runSelfTest(
    options: KindleOperationOptions = {},
  ): Promise<KindleSelfTestResult> {
    this.selfTestPassed = false;
    const payload = KINDLE_SELF_TEST_PAYLOAD.slice();
    const target = await this.ensureTarget(payload.byteLength, options);
    const preflight = await this.unusedGeneratedFilename(
      () => createSelfTestFilename(this.now(), this.random),
      target,
      options,
    );
    const { filename } = preflight;

    let handle: number | undefined;
    let primaryFailure: unknown;
    let verifiedModificationDate: string | undefined;
    const requestedModificationDate = this.now();
    try {
      const created = await this.store.createObject(
        {
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          objectFormat: MTP_OBJECT_FORMAT_TEXT,
          size: payload.byteLength,
          data: payload,
          modificationDate: requestedModificationDate,
          onObjectState: options.onObjectState,
        },
        options,
      );
      handle = created.handle;
      this.recordCreated(created);
      const verified = await this.verifyObject(
        {
          handle,
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          size: payload.byteLength,
        },
        options,
      );
      verifiedModificationDate = verified.modificationDate;

      const readback = await this.store.readObject(handle, {
        ...options,
        maxBytes: payload.byteLength,
      });
      if (!equalBytes(payload, readback)) {
        throw new KindleDeviceError(
          "MTP_READBACK_MISMATCH",
          "The test object did not round-trip byte-for-byte.",
          {
            handle,
            filename,
            expectedBytes: payload.byteLength,
            actualBytes: readback.byteLength,
          },
        );
      }
    } catch (error) {
      primaryFailure = error;
      const partial = partialUploadOutcome(error);
      if (partial?.cleanupSucceeded) {
        handle = undefined;
      } else if (partial?.cleanupAttempted) {
        throw this.cleanupFailure(
          partial.handle,
          partial.filename ?? filename,
          partial.cleanupError ?? error,
          error,
        );
      } else {
        handle ??= createdHandleFromError(error);
      }
    }

    if (handle !== undefined) {
      try {
        await this.deleteCreatedAndVerify(handle, options);
      } catch (cleanupError) {
        throw this.cleanupFailure(handle, filename, cleanupError, primaryFailure);
      }
    }

    if (primaryFailure) throw primaryFailure;
    if (handle === undefined) {
      throw new KindleDeviceError(
        "MTP_OBJECT_VERIFICATION_FAILED",
        "The self-test upload completed without returning an object handle.",
        { filename },
      );
    }

    this.inventoryFolderSeed = {
      parentHandle: target.documentsHandle,
      children: preflight.children,
    };

    this.selfTestPassed = true;
    if (verifiedModificationDate !== undefined) {
      this.inventoryMetadataCacheContext?.modificationDateProbe?.recordSelfTest({
        deviceKey: this.inventoryMetadataCacheContext.identity.key,
        storageId: target.storageId,
        requestedModificationDate,
        returnedModificationDate: verifiedModificationDate,
      });
    }
    return {
      filename,
      handle,
      bytesVerified: payload.byteLength,
      cleanedUp: true,
    };
  }

  async inventory(
    options: KindleInventoryOptions = {},
  ): Promise<KindleInventorySnapshot> {
    const cacheMode: KindleInventoryDeviceMetadataCacheDiagnostics["mode"] =
      options.deviceMetadataCache === false
        ? "disabled"
        : options.deviceMetadataCache === "read-write"
          ? "read-write"
          : "read-only";
    const target = await this.ensureTarget(0, options);
    const folderSeed = this.inventoryFolderSeed;
    this.inventoryFolderSeed = undefined;
    const rootSeed = this.rootObjectSeed?.storageId === target.storageId
      ? this.rootObjectSeed.objects
      : undefined;
    this.rootObjectSeed = undefined;
    const loadedDeviceCache = options.deviceMetadataCache === false
      ? undefined
      : await loadKindleBridgeDeviceMetadataCache(this.store, target, options, rootSeed);
    const inventory = await buildKindleInventory(
      this.store,
      target,
      options,
      folderSeed,
      this.inventoryMetadataCacheContext,
      loadedDeviceCache?.context,
    );
    let cacheWrite = cacheWriteResult("not-requested", 0);
    if (
      options.deviceMetadataCache === "read-write"
      && this.selfTestPassed
      && options.onObjectState !== undefined
      && inventory.status === "complete"
      && inventory.bookMetadata?.status !== "disabled"
      && loadedDeviceCache !== undefined
    ) {
      cacheWrite = await this.updateDeviceMetadataCache(
        target,
        inventory,
        loadedDeviceCache,
        options,
      );
    } else if (options.deviceMetadataCache === "read-write") {
      const outcome: KindleDeviceMetadataCacheWriteOutcome =
        !this.selfTestPassed || options.onObjectState === undefined
          ? "not-authorized"
          : inventory.status !== "complete"
            ? "skipped-incomplete-inventory"
            : inventory.bookMetadata?.status === "disabled"
              ? "skipped-metadata-disabled"
              : "skipped-cache-load-unavailable";
      cacheWrite = cacheWriteResult(outcome, 0);
    }
    const diagnostics = deviceCacheDiagnostics(cacheMode, loadedDeviceCache, cacheWrite);
    return Object.freeze({
      ...inventory,
      ...(inventory.metadataCacheDiagnostics === undefined
        ? {}
        : {
            metadataCacheDiagnostics: Object.freeze({
              ...inventory.metadataCacheDiagnostics,
              device: diagnostics,
            }),
          }),
    });
  }

  async sendAzW3(
    blob: Blob,
    originalFilename: string,
    options: KindleSendOptions = {},
  ): Promise<KindleBookTransferResult> {
    if (blob.size === 0) {
      throw new KindleDeviceError(
        "MTP_INVALID_BOOK",
        "The AZW3 file is empty.",
      );
    }

    const target = await this.ensureTarget(blob.size, options);
    const managedToken = options.managedToken === undefined
      ? undefined
      : normalizeManagedFilenameToken(options.managedToken);
    const preflight = await this.unusedGeneratedFilename(
      () => managedToken === undefined
        ? createCollisionResistantFilename(originalFilename, "azw3", {
            now: this.now(),
            random: this.random,
          })
        : createManagedCollisionResistantFilename(originalFilename, "azw3", managedToken, {
            now: this.now(),
            random: this.random,
          }),
      target,
      options,
    );
    const { filename } = preflight;

    let created: KindleCreatedObject | undefined;
    try {
      created = await this.store.createObject(
        {
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          objectFormat: MTP_OBJECT_FORMAT_UNDEFINED,
          size: blob.size,
          data: blob,
          modificationDate: this.now(),
          onProgress: options.onProgress,
          onObjectState: options.onObjectState,
        },
        options,
      );
      this.recordCreated(created);
      const verifiedInfo = await this.verifyObject(
        {
          handle: created.handle,
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          size: blob.size,
        },
        options,
      );
      this.inventoryFolderSeed = {
        parentHandle: target.documentsHandle,
        children: Object.freeze([...preflight.children, verifiedInfo]),
      };
      options.onObjectState?.({
        stage: "verified",
        handle: created.handle,
        storageId: created.storageId,
        parentHandle: created.parentHandle,
        filename: created.filename,
        size: created.size,
      });
    } catch (error) {
      const partial = partialUploadOutcome(error);
      if (partial?.cleanupSucceeded) throw error;
      if (partial?.cleanupAttempted) {
        throw this.cleanupFailure(
          partial.handle,
          partial.filename ?? filename,
          partial.cleanupError ?? error,
          error,
        );
      }
      const handle = created?.handle ?? createdHandleFromError(error);
      if (handle !== undefined) {
        try {
          await this.deleteCreatedAndVerify(handle, options);
        } catch (cleanupError) {
          throw this.cleanupFailure(handle, filename, cleanupError, error);
        }
      }
      throw error;
    }

    return {
      filename,
      handle: created.handle,
      size: blob.size,
      storageId: target.storageId,
      parentHandle: target.documentsHandle,
      verified: true,
      ...(managedToken === undefined ? {} : { managedToken }),
    };
  }

  private async updateDeviceMetadataCache(
    target: KindleTarget,
    inventory: KindleInventorySnapshot,
    loaded: LoadedKindleBridgeDeviceMetadataCache,
    options: KindleInventoryOptions,
  ): Promise<DeviceMetadataCacheWriteResult> {
    const entries = kindleInventoryToDeviceMetadataCacheEntries(inventory);
    if (loaded.active) {
      try {
        const unchanged = await encodeKindleBridgeDeviceMetadataCache(
          makeKindleBridgeDeviceMetadataCache(
            loaded.active.snapshot.cache.generation,
            entries,
          ),
        );
        options.signal?.throwIfAborted();
        if (equalBytes(unchanged, loaded.active.snapshot.data)) {
          return cacheWriteResult("unchanged", entries.length, {
            byteCount: unchanged.byteLength,
          });
        }
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        // Encoding is optional acceleration. Live inventory remains valid and
        // no device mutation has begun.
        return cacheWriteResult("skipped-encode-failed", entries.length);
      }
    }

    const plan = planKindleBridgeDeviceMetadataCacheWrite(loaded);
    if (!plan) return cacheWriteResult("skipped-no-safe-slot", entries.length);
    let bytes: Uint8Array;
    try {
      bytes = await encodeKindleBridgeDeviceMetadataCache(
        makeKindleBridgeDeviceMetadataCache(plan.generation, entries),
      );
      options.signal?.throwIfAborted();
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      return cacheWriteResult("skipped-encode-failed", entries.length, { slot: plan.slot });
    }

    let refreshedStorage: KindleTarget["storage"];
    try {
      refreshedStorage = await this.store.getStorageInfo(target.storageId, options);
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
      // The live inventory remains valid when the selected storage cannot be
      // refreshed for this optional auxiliary write.
      return cacheWriteResult("skipped-storage-unavailable", entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }
    if (!this.selfTestPassed) {
      return cacheWriteResult("not-authorized", entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }
    if (refreshedStorage.accessCapability !== MTP_ACCESS_READ_WRITE) {
      return cacheWriteResult("skipped-storage-read-only", entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }
    if (refreshedStorage.freeSpaceInBytes < bigintSize(bytes.byteLength)) {
      return cacheWriteResult("skipped-insufficient-space", entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }

    // Rotate A/B slots. If the inactive slot still contains a fully validated
    // older generation, remove only that exact cache while the active verified
    // generation remains available.
    if (plan.replace) {
      options.signal?.throwIfAborted();
      try {
        await this.store.deleteKindleBridgeMetadataCacheObject(plan.replace, options);
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
        return cacheWriteResult("skipped-replacement-failed", entries.length, {
          byteCount: bytes.byteLength,
          slot: plan.slot,
        });
      }
    }

    const rootPreflight = await this.rootFilenamePreflight(
      target.storageId,
      plan.filename,
      options,
    );
    if (rootPreflight.outcome !== "available") {
      const outcome: KindleDeviceMetadataCacheWriteOutcome =
        rootPreflight.outcome === "name-conflict"
          ? "skipped-root-name-conflict"
          : rootPreflight.outcome === "capacity"
            ? "skipped-root-capacity"
            : "skipped-root-unavailable";
      return cacheWriteResult(outcome, entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }

    let created: KindleCreatedObject | undefined;
    try {
      created = await this.store.createObject(
        {
          storageId: target.storageId,
          parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
          filename: plan.filename,
          objectFormat: MTP_OBJECT_FORMAT_UNDEFINED,
          size: bytes.byteLength,
          data: bytes,
          modificationDate: this.now(),
          onObjectState: options.onObjectState,
        },
        options,
      );
      this.recordCreated(created);
      await this.verifyObject(
        {
          handle: created.handle,
          storageId: target.storageId,
          parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
          filename: plan.filename,
          size: bytes.byteLength,
        },
        options,
      );
      // Use the same strict root/format/protection/schema validation required
      // on reconnect before clearing the durable creation journal.
      const strictReadback = await this.store.inspectKindleBridgeMetadataCacheObject(
        created.handle,
        options,
      );
      if (!equalBytes(bytes, strictReadback.data)) {
        throw new KindleDeviceError(
          "MTP_READBACK_MISMATCH",
          "The Kindle metadata cache did not round-trip byte-for-byte.",
          {
            handle: created.handle,
            filename: plan.filename,
            expectedBytes: bytes.byteLength,
            actualBytes: strictReadback.data.byteLength,
          },
        );
      }
      options.signal?.throwIfAborted();
      options.onObjectState?.({
        stage: "verified",
        handle: created.handle,
        storageId: target.storageId,
        parentHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        filename: plan.filename,
        size: bytes.byteLength,
      });
      return cacheWriteResult("written", entries.length, {
        writtenEntryCount: entries.length,
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    } catch (error) {
      const partial = partialUploadOutcome(error);
      if (partial?.cleanupSucceeded) {
        if (isAbort(error, options.signal)) throw error;
        if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
        return cacheWriteResult("create-failed-cleaned", entries.length, {
          byteCount: bytes.byteLength,
          slot: plan.slot,
        });
      }
      if (partial?.cleanupAttempted) {
        throw this.cleanupFailure(
          partial.handle,
          partial.filename ?? plan.filename,
          partial.cleanupError ?? error,
          error,
        );
      }
      const handle = created?.handle ?? createdHandleFromError(error);
      if (handle === undefined) throw error;
      try {
        await this.deleteCreatedAndVerify(handle, options);
      } catch (cleanupError) {
        throw this.cleanupFailure(handle, plan.filename, cleanupError, error);
      }
      if (isAbort(error, options.signal)) throw error;
      if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
      // The new cache was removed exactly. Keep the live inventory and the
      // still-valid prior slot rather than failing the connection.
      return cacheWriteResult("create-failed-cleaned", entries.length, {
        byteCount: bytes.byteLength,
        slot: plan.slot,
      });
    }
  }

  private async rootFilenamePreflight(
    storageId: number,
    filename: string,
    options: KindleOperationOptions,
  ): Promise<RootFilenamePreflight> {
    let handles: readonly number[];
    try {
      handles = await this.store.listObjectHandles({
        storageId,
        associationHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        maxHandles: MAX_ROOT_OBJECT_HANDLES,
      }, options);
      for (const handle of handles) {
        const info = await this.store.getObjectInfo(handle, options);
        if (filenamesEqual(info.filename, filename)) {
          return { outcome: "name-conflict" };
        }
      }
      return handles.length >= MAX_ROOT_OBJECT_HANDLES
        ? { outcome: "capacity" }
        : { outcome: "available" };
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
      return { outcome: "unavailable" };
    }
  }

  private async ensureTarget(
    requiredBytes: number,
    options: KindleOperationOptions,
  ): Promise<KindleTarget> {
    if (!this.target) return this.inspect(requiredBytes, options);
    const storage = await this.store.getStorageInfo(
      this.target.storageId,
      options,
    );
    if (storage.accessCapability !== MTP_ACCESS_READ_WRITE) {
      this.target = undefined;
      return this.inspect(requiredBytes, options);
    }
    if (storage.freeSpaceInBytes < bigintSize(requiredBytes)) {
      throw new KindleDeviceError(
        "MTP_INSUFFICIENT_SPACE",
        `The selected Kindle storage has only ${storage.freeSpaceInBytes} free bytes.`,
        {
          requiredBytes,
          freeSpaceInBytes: storage.freeSpaceInBytes.toString(),
          storageId: this.target.storageId,
        },
      );
    }
    this.target = { ...this.target, storage };
    return this.target;
  }

  private async inspectRoot(
    storageId: number,
    options: KindleOperationOptions,
  ): Promise<RootInspection> {
    const rootHandles = await this.store.listObjectHandles(
      {
        storageId,
        associationHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        maxHandles: MAX_ROOT_OBJECT_HANDLES,
      },
      options,
    );
    const objects: KindleStoredObjectInfo[] = [];
    let documents: KindleStoredObjectInfo | undefined;
    for (const handle of rootHandles) {
      let info: KindleStoredObjectInfo;
      try {
        info = await this.store.getObjectInfo(handle, options);
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        if (isKindleDeviceMetadataCacheTransportFailure(error)) throw error;
        // Cache seeding is optional. One unreadable unrelated root object must
        // not hide an otherwise verified Documents association.
        continue;
      }
      objects.push(info);
      if (
        documents === undefined
        && info.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
        && filenamesEqual(info.filename, "Documents")
      ) {
        documents = info;
      }
    }
    return Object.freeze({
      ...(documents === undefined ? {} : { documents }),
      objects: Object.freeze(objects),
    });
  }

  private async unusedGeneratedFilename(
    generate: () => string,
    target: KindleTarget,
    options: KindleOperationOptions,
  ): Promise<GeneratedFilenamePreflight> {
    const children = await this.childObjects(target, options);
    const existingNames = new Set(children.map(({ filename }) => filename));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generate();
      if (![...existingNames].some((name) => filenamesEqual(name, candidate))) {
        return { filename: candidate, children: Object.freeze(children) };
      }
    }
    throw new KindleDeviceError(
      "MTP_FILENAME_COLLISION",
      "Could not produce an unused filename after eight attempts; no object was overwritten.",
      { documentsHandle: target.documentsHandle },
    );
  }

  private async childObjects(
    target: KindleTarget,
    options: KindleOperationOptions,
  ): Promise<KindleStoredObjectInfo[]> {
    const handles = await this.store.listObjectHandles(
      {
        storageId: target.storageId,
        associationHandle: target.documentsHandle,
        maxHandles: MAX_DOCUMENT_CHILD_HANDLES,
      },
      options,
    );
    const children: KindleStoredObjectInfo[] = [];
    for (const handle of handles) {
      children.push(await this.store.getObjectInfo(handle, options));
    }
    return children;
  }

  private recordCreated(created: KindleCreatedObject): void {
    this.createdHandles.set(created.handle, created.filename);
  }

  private async verifyObject(
    expected: ObjectExpectation,
    options: KindleOperationOptions,
  ): Promise<KindleStoredObjectInfo> {
    const actual = await this.store.getObjectInfo(expected.handle, options);
    const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
    if (actual.storageId !== expected.storageId) {
      mismatches.storageId = {
        expected: expected.storageId,
        actual: actual.storageId,
      };
    }
    const parentMatches = actual.parentHandle === expected.parentHandle
      || (expected.parentHandle === MTP_ROOT_ASSOCIATION_HANDLE && actual.parentHandle === 0);
    if (!parentMatches) {
      mismatches.parentHandle = {
        expected: expected.parentHandle,
        actual: actual.parentHandle,
      };
    }
    if (actual.filename !== expected.filename) {
      mismatches.filename = {
        expected: expected.filename,
        actual: actual.filename,
      };
    }
    if (actual.compressedSize !== expected.size) {
      mismatches.size = {
        expected: expected.size,
        actual: actual.compressedSize,
      };
    }
    if (Object.keys(mismatches).length) {
      throw new KindleDeviceError(
        "MTP_OBJECT_VERIFICATION_FAILED",
        "The uploaded object's metadata does not match the requested book.",
        { handle: expected.handle, mismatches },
      );
    }
    return actual;
  }

  private async deleteCreatedAndVerify(
    handle: number,
    options: KindleOperationOptions,
  ): Promise<void> {
    // MtpObjectStore does not resolve this call or emit cleanup-succeeded until
    // an exact-handle relist has verified absence after DeleteObject.
    await this.store.deleteObject(handle, options);
    this.createdHandles.delete(handle);
  }

  private cleanupFailure(
    handle: number,
    filename: string,
    cleanupError: unknown,
    primaryFailure?: unknown,
  ): KindleDeviceError {
    const originalFailure = primaryFailure
      ? describeStructuredFailure(primaryFailure)
      : undefined;
    const cleanupFailure = describeStructuredFailure(cleanupError);
    const transport = primaryFailure
      ? findTransportDiagnostic(primaryFailure) ?? findTransportDiagnostic(cleanupError)
      : findTransportDiagnostic(cleanupError);
    return new KindleDeviceError(
      "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
      `Removal of the session-created object failed or could not be verified. Manually check only ${filename} (MTP handle ${handle}).`,
      {
        createdHandle: handle,
        filename,
        cleanupError: errorMessage(cleanupError),
        cleanupFailure,
        ...(primaryFailure
          ? {
              originalError: errorMessage(primaryFailure),
              originalFailure,
            }
          : {}),
        ...(transport ?? {}),
        safeNextAction: `Remove exactly ${filename}; do not delete a similarly named object.`,
      },
      { cause: cleanupError },
    );
  }
}
