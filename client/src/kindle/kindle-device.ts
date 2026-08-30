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
  type KindleInventoryOptions,
  type KindleInventorySnapshot,
} from "./inventory";
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

export class KindleDevice {
  readonly store: KindleObjectStore;
  private target?: KindleTarget;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly createdHandles = new Map<number, string>();

  constructor(store: KindleObjectStore, options: KindleDeviceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
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
    const required = bigintSize(requiredBytes);
    const storageIds = await this.store.listStorageIds(options);
    let writableCount = 0;
    let documentsCount = 0;
    const candidates: KindleTarget[] = [];

    for (const storageId of storageIds) {
      const storage = await this.store.getStorageInfo(storageId, options);
      if (storage.accessCapability !== MTP_ACCESS_READ_WRITE) continue;
      writableCount += 1;

      const documents = await this.findDocuments(storageId, options);
      if (!documents) continue;
      documentsCount += 1;
      if (storage.freeSpaceInBytes < required) continue;

      candidates.push({
        storageId,
        storage,
        documentsHandle: documents.handle,
        documents,
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
    this.target = candidates[0];
    return this.target;
  }

  async runSelfTest(
    options: KindleOperationOptions = {},
  ): Promise<KindleSelfTestResult> {
    const payload = KINDLE_SELF_TEST_PAYLOAD.slice();
    const target = await this.ensureTarget(payload.byteLength, options);
    const filename = await this.unusedGeneratedFilename(
      () => createSelfTestFilename(this.now(), this.random),
      target,
      options,
    );

    let handle: number | undefined;
    let primaryFailure: unknown;
    try {
      const created = await this.store.createObject(
        {
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          objectFormat: MTP_OBJECT_FORMAT_TEXT,
          size: payload.byteLength,
          data: payload,
          modificationDate: this.now(),
          onObjectState: options.onObjectState,
        },
        options,
      );
      handle = created.handle;
      this.recordCreated(created);
      await this.verifyObject(
        {
          handle,
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          size: payload.byteLength,
        },
        options,
      );

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
    const target = await this.ensureTarget(0, options);
    return buildKindleInventory(this.store, target, options);
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
    const filename = await this.unusedGeneratedFilename(
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
      await this.verifyObject(
        {
          handle: created.handle,
          storageId: target.storageId,
          parentHandle: target.documentsHandle,
          filename,
          size: blob.size,
        },
        options,
      );
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

  private async findDocuments(
    storageId: number,
    options: KindleOperationOptions,
  ): Promise<KindleStoredObjectInfo | undefined> {
    const rootHandles = await this.store.listObjectHandles(
      {
        storageId,
        associationHandle: MTP_ROOT_ASSOCIATION_HANDLE,
        maxHandles: MAX_ROOT_OBJECT_HANDLES,
      },
      options,
    );
    for (const handle of rootHandles) {
      const info = await this.store.getObjectInfo(handle, options);
      if (
        info.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION &&
        filenamesEqual(info.filename, "Documents")
      ) {
        return info;
      }
    }
    return undefined;
  }

  private async unusedGeneratedFilename(
    generate: () => string,
    target: KindleTarget,
    options: KindleOperationOptions,
  ): Promise<string> {
    const existingNames = await this.childFilenames(target, options);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generate();
      if (![...existingNames].some((name) => filenamesEqual(name, candidate))) {
        return candidate;
      }
    }
    throw new KindleDeviceError(
      "MTP_FILENAME_COLLISION",
      "Could not produce an unused filename after eight attempts; no object was overwritten.",
      { documentsHandle: target.documentsHandle },
    );
  }

  private async childFilenames(
    target: KindleTarget,
    options: KindleOperationOptions,
  ): Promise<Set<string>> {
    const handles = await this.store.listObjectHandles(
      {
        storageId: target.storageId,
        associationHandle: target.documentsHandle,
        maxHandles: MAX_DOCUMENT_CHILD_HANDLES,
      },
      options,
    );
    const names = new Set<string>();
    for (const handle of handles) {
      names.add((await this.store.getObjectInfo(handle, options)).filename);
    }
    return names;
  }

  private recordCreated(created: KindleCreatedObject): void {
    this.createdHandles.set(created.handle, created.filename);
  }

  private async verifyObject(
    expected: ObjectExpectation,
    options: KindleOperationOptions,
  ): Promise<void> {
    const actual = await this.store.getObjectInfo(expected.handle, options);
    const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
    if (actual.storageId !== expected.storageId) {
      mismatches.storageId = {
        expected: expected.storageId,
        actual: actual.storageId,
      };
    }
    if (actual.parentHandle !== expected.parentHandle) {
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
