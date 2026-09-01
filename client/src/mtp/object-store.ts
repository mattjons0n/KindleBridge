import {
  MTP_ALL_ASSOCIATIONS,
  MTP_ALL_OBJECT_FORMATS,
  MTP_ROOT_PARENT,
  MtpAssociationType,
  MtpObjectFormat,
  MtpOperationCode,
} from "./constants";
import {
  type MtpObjectInfo,
  type MtpStorageInfo,
  type MtpStoredObjectInfo,
  decodeObjectHandles,
  decodeObjectInfo,
  decodeStorageIds,
  decodeStorageInfo,
  encodeObjectInfo,
  formatMtpDateTime,
  makeUploadObjectInfo,
} from "./datasets";
import {
  type MtpOperationOptions,
  type MtpOutgoingData,
  type MtpSession,
  MtpSessionError,
  type MtpTransactionResult,
  outgoingDataFromBytes,
} from "./session";
import {
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES,
  decodeKindleBridgeDeviceMetadataCache,
  isKindleBridgeDeviceMetadataCacheFilename,
  type KindleBridgeDeviceMetadataCache,
} from "../kindle/device-metadata-cache-codec";
import type {
  KindleBridgeMetadataCacheObjectSnapshot,
  KindleStoredObjectInfo,
} from "../kindle/contracts";

const UINT32_MAX = 0xffff_ffff;
const MTP_MAX_DATA_PAYLOAD_LENGTH = UINT32_MAX - 12;
const DEFAULT_UPLOAD_CHUNK_SIZE = 256 * 1024;
const DEFAULT_MAX_OBJECT_HANDLES = 100_000;
const MAX_STORAGE_IDS_DATA_BYTES = 4 + 64 * 4;
const MAX_STORAGE_INFO_DATA_BYTES = 2_048;
const MAX_OBJECT_INFO_DATA_BYTES = 2_048;
const MAX_CLEANUP_VERIFICATION_HANDLES = 10_000;
const MAX_CREATE_PARENT_HANDLES = 10_000;
const MAX_CACHE_ROOT_HANDLES = 256;
const KINDLE_BOOK_EXTENSIONS = new Set(["azw", "azw3", "azw8", "kfx", "mobi", "prc"]);

export interface MtpListObjectHandlesRequest {
  readonly storageId: number;
  readonly objectFormat?: number;
  readonly associationHandle?: number;
  /** Operation-specific allocation guard for untrusted device datasets. */
  readonly maxHandles?: number;
}

export interface MtpTransferProgress {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
}

export interface MtpObjectCreationMetadata {
  readonly storageId: number;
  readonly parentHandle: number;
  readonly filename: string;
  readonly size: number;
}

export type MtpObjectCreationState =
  | ({ readonly stage: "send-object-info-intent" } & MtpObjectCreationMetadata)
  | ({ readonly stage: "handle-assigned"; readonly handle: number } & MtpObjectCreationMetadata)
  | ({ readonly stage: "cleanup-succeeded"; readonly handle: number } & MtpObjectCreationMetadata)
  | ({ readonly stage: "verified"; readonly handle: number } & MtpObjectCreationMetadata);

export type MtpObjectData = Uint8Array | Blob | AsyncIterable<Uint8Array>;

export interface MtpCreateObjectRequest {
  readonly storageId: number;
  readonly parentHandle: number;
  readonly filename: string;
  readonly objectFormat?: number;
  readonly size: number;
  readonly data: MtpObjectData;
  readonly captureDate?: Date | string;
  readonly modificationDate?: Date | string;
  readonly keywords?: string;
  readonly chunkSize?: number;
  readonly onProgress?: (progress: MtpTransferProgress) => void;
  /**
   * Synchronous safety hook used to persist metadata-only recovery state.
   * The intent callback runs after local validation but before SendObjectInfo
   * can reach the wire. A thrown callback aborts the operation.
   */
  readonly onObjectState?: (state: MtpObjectCreationState) => void;
}

export interface MtpCreatedObject {
  readonly handle: number;
  readonly storageId: number;
  readonly parentHandle: number;
  readonly filename: string;
  readonly size: number;
}

export interface MtpReadObjectOptions extends MtpOperationOptions {
  readonly maxBytes?: number;
}

export type MtpObjectStoreErrorCode =
  | "MTP_DATASET_MISSING"
  | "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE"
  | "MTP_SEND_OBJECT_INFO_MISMATCH"
  | "MTP_UNSAFE_FILENAME"
  | "MTP_OBJECT_NOT_OWNED"
  | "MTP_OBJECT_TOO_LARGE"
  | "MTP_OBJECT_DATA_SIZE_MISMATCH"
  | "MTP_OBJECT_DELETE_UNVERIFIED"
  | "MTP_OBJECT_DELETE_MISMATCH"
  | "MTP_READ_LIMIT_EXCEEDED"
  | "MTP_HANDLE_LIMIT_EXCEEDED";

export class MtpObjectStoreError extends Error {
  readonly code: MtpObjectStoreErrorCode;
  readonly fatal?: true;
  override readonly cause?: unknown;

  constructor(code: MtpObjectStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MtpObjectStoreError";
    this.code = code;
    this.cause = cause;
    if (cause && typeof cause === "object" && Reflect.get(cause, "fatal") === true) {
      this.fatal = true;
    }
  }
}

export class MtpPartialObjectError extends Error {
  readonly handle: number;
  readonly filename: string;
  readonly cleanupAttempted: boolean;
  readonly cleanupSucceeded: boolean;
  readonly cleanupError?: unknown;
  override readonly cause: unknown;

  constructor(options: {
    handle: number;
    filename: string;
    cause: unknown;
    cleanupAttempted: boolean;
    cleanupSucceeded: boolean;
    cleanupError?: unknown;
  }) {
    const cleanupMessage = options.cleanupSucceeded
      ? "the partial object was removed"
      : `manual cleanup may be required for handle 0x${options.handle.toString(16).padStart(8, "0")}`;
    super(`upload of ${options.filename} failed after object creation; ${cleanupMessage}`);
    this.name = "MtpPartialObjectError";
    this.handle = options.handle;
    this.filename = options.filename;
    this.cause = options.cause;
    this.cleanupAttempted = options.cleanupAttempted;
    this.cleanupSucceeded = options.cleanupSucceeded;
    this.cleanupError = options.cleanupError;
  }
}

function requireData(result: MtpTransactionResult): Uint8Array {
  if (!result.data) {
    throw new MtpObjectStoreError(
      "MTP_DATASET_MISSING",
      `MTP operation 0x${result.operationCode.toString(16)} returned no dataset`,
    );
  }
  return result.data;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function assertSpecificObjectHandle(value: number, label: string): void {
  assertUint32(value, label);
  if (value === 0 || value === UINT32_MAX) {
    throw new MtpObjectStoreError(
      "MTP_OBJECT_NOT_OWNED",
      `${label} must identify one concrete object; reserved handle 0x${value.toString(16).padStart(8, "0")} is forbidden`,
    );
  }
}

function normalizeTimestamp(value: Date | string | undefined): string {
  if (value === undefined) return "";
  return value instanceof Date ? formatMtpDateTime(value) : value;
}

function isBlob(value: MtpObjectData): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertSafeFilename(filename: string): void {
  if (
    filename.length === 0
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/u.test(filename)
  ) {
    throw new MtpObjectStoreError(
      "MTP_UNSAFE_FILENAME",
      "MTP object filename must be a non-empty leaf name without control characters or path separators",
    );
  }
  // MTP counts UTF-16 code units, including a terminator, in one byte.
  if (filename.length > 254) {
    throw new MtpObjectStoreError(
      "MTP_UNSAFE_FILENAME",
      "MTP object filename exceeds 254 UTF-16 code units",
    );
  }
}

function isKindleBookFilename(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    && dot < filename.length - 1
    && KINDLE_BOOK_EXTENSIONS.has(filename.slice(dot + 1).toLocaleLowerCase("en-US"));
}

export class MtpObjectStore {
  private readonly session: MtpSession;
  private readonly ownedHandles = new Set<number>();
  private readonly creationStates = new Map<number, {
    readonly metadata: MtpObjectCreationMetadata;
    readonly callback?: (state: MtpObjectCreationState) => void;
  }>();
  private readonly validatedCacheSnapshots = new WeakMap<object, { readonly sessionOwned: boolean }>();

  constructor(session: MtpSession) {
    this.session = session;
  }

  get createdHandles(): ReadonlySet<number> {
    return new Set(this.ownedHandles);
  }

  async listStorageIds(options: MtpOperationOptions = {}): Promise<number[]> {
    const result = await this.session.execute(
      {
        operationCode: MtpOperationCode.GetStorageIDs,
        expectData: true,
        maxDataBytes: MAX_STORAGE_IDS_DATA_BYTES,
        expectedResponseParameterCount: 0,
      },
      options,
    );
    return decodeStorageIds(requireData(result));
  }

  async getStorageInfo(
    storageId: number,
    options: MtpOperationOptions = {},
  ): Promise<MtpStorageInfo> {
    assertUint32(storageId, "storage ID");
    const result = await this.session.execute(
      {
        operationCode: MtpOperationCode.GetStorageInfo,
        parameters: [storageId],
        expectData: true,
        maxDataBytes: MAX_STORAGE_INFO_DATA_BYTES,
        expectedResponseParameterCount: 0,
      },
      options,
    );
    return decodeStorageInfo(requireData(result));
  }

  async listObjectHandles(
    request: MtpListObjectHandlesRequest,
    options: MtpOperationOptions = {},
  ): Promise<number[]> {
    assertUint32(request.storageId, "storage ID");
    const objectFormat = request.objectFormat ?? MTP_ALL_OBJECT_FORMATS;
    const associationHandle = request.associationHandle ?? MTP_ALL_ASSOCIATIONS;
    assertUint32(objectFormat, "object format");
    assertUint32(associationHandle, "association handle");
    const maxHandles = request.maxHandles;
    if (
      maxHandles !== undefined
      && (!Number.isSafeInteger(maxHandles) || maxHandles < 0 || maxHandles > 0x3fff_fffe)
    ) {
      throw new RangeError("maxHandles must be a non-negative bounded integer");
    }
    const effectiveMaxHandles = maxHandles ?? DEFAULT_MAX_OBJECT_HANDLES;
    let result: MtpTransactionResult;
    try {
      result = await this.session.execute(
        {
          operationCode: MtpOperationCode.GetObjectHandles,
          parameters: [request.storageId, objectFormat, associationHandle],
          expectData: true,
          maxDataBytes: 4 + effectiveMaxHandles * 4,
          expectedResponseParameterCount: 0,
        },
        options,
      );
    } catch (error) {
      if (
        error instanceof MtpSessionError
        && error.code === "MTP_INCOMING_DATA_TOO_LARGE"
      ) {
        throw new MtpObjectStoreError(
          "MTP_HANDLE_LIMIT_EXCEEDED",
          `object handle dataset exceeds the ${effectiveMaxHandles}-handle limit`,
          error,
        );
      }
      throw error;
    }
    const handles = decodeObjectHandles(requireData(result));
    if (handles.length > effectiveMaxHandles) {
      throw new MtpObjectStoreError(
        "MTP_HANDLE_LIMIT_EXCEEDED",
        `object handle dataset contains ${handles.length} handles, exceeding the ${effectiveMaxHandles}-handle limit`,
      );
    }
    return handles;
  }

  async getObjectInfo(
    handle: number,
    options: MtpOperationOptions = {},
  ): Promise<MtpStoredObjectInfo> {
    assertSpecificObjectHandle(handle, "object handle");
    const result = await this.session.execute(
      {
        operationCode: MtpOperationCode.GetObjectInfo,
        parameters: [handle],
        expectData: true,
        maxDataBytes: MAX_OBJECT_INFO_DATA_BYTES,
        expectedResponseParameterCount: 0,
      },
      options,
    );
    const info = decodeObjectInfo(requireData(result));
    return { handle, ...info };
  }

  async readObject(
    handle: number,
    options: MtpReadObjectOptions = {},
  ): Promise<Uint8Array> {
    assertSpecificObjectHandle(handle, "object handle");
    const { maxBytes, ...operationOptions } = options;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    let result: MtpTransactionResult;
    try {
      result = await this.session.execute(
        {
          operationCode: MtpOperationCode.GetObject,
          parameters: [handle],
          expectData: true,
          maxDataBytes: maxBytes,
          expectedResponseParameterCount: 0,
        },
        operationOptions,
      );
    } catch (error) {
      if (error instanceof MtpSessionError && error.code === "MTP_INCOMING_DATA_TOO_LARGE") {
        throw new MtpObjectStoreError(
          "MTP_READ_LIMIT_EXCEEDED",
          `object exceeds the ${maxBytes}-byte read limit`,
          error,
        );
      }
      throw error;
    }
    const data = requireData(result);
    if (maxBytes !== undefined && data.byteLength > maxBytes) {
      throw new MtpObjectStoreError(
        "MTP_READ_LIMIT_EXCEEDED",
        `object contains ${data.byteLength} byte(s), exceeding the ${maxBytes}-byte read limit`,
      );
    }
    return data;
  }

  async createObject(
    request: MtpCreateObjectRequest,
    options: MtpOperationOptions = {},
  ): Promise<MtpCreatedObject> {
    assertUint32(request.storageId, "storage ID");
    assertUint32(request.parentHandle, "parent handle");
    assertSafeFilename(request.filename);
    if (!Number.isInteger(request.size) || request.size < 0 || request.size > MTP_MAX_DATA_PAYLOAD_LENGTH) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_TOO_LARGE",
        `object size must be an integer from 0 to ${MTP_MAX_DATA_PAYLOAD_LENGTH}`,
      );
    }
    const chunkSize = request.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive safe integer");
    }
    this.validateKnownDataLength(request.data, request.size);

    // Snapshot the exact destination before the mutating command. A malformed
    // SendObjectInfo response must never lend cleanup authority over an object
    // that was already present (owned by this tab or otherwise).
    const existingParentHandles = new Set(await this.listObjectHandles({
      storageId: request.storageId,
      associationHandle: request.parentHandle,
      maxHandles: MAX_CREATE_PARENT_HANDLES,
    }, options));

    const objectInfo: MtpObjectInfo = makeUploadObjectInfo({
      storageId: request.storageId,
      parentHandle: request.parentHandle,
      objectFormat: request.objectFormat ?? MtpObjectFormat.Undefined,
      compressedSize: request.size,
      filename: request.filename,
      captureDate: normalizeTimestamp(request.captureDate),
      modificationDate: normalizeTimestamp(request.modificationDate),
      keywords: request.keywords,
    });
    const objectInfoBytes = encodeObjectInfo(objectInfo);
    const creationMetadata: MtpObjectCreationMetadata = {
      storageId: request.storageId,
      parentHandle: request.parentHandle,
      filename: request.filename,
      size: request.size,
    };
    request.onObjectState?.({
      stage: "send-object-info-intent",
      ...creationMetadata,
    });
    const infoResponse = await this.session.execute(
      {
        operationCode: MtpOperationCode.SendObjectInfo,
        parameters: [request.storageId, request.parentHandle],
        dataOut: outgoingDataFromBytes(objectInfoBytes),
        expectedResponseParameterCount: 3,
      },
      options,
    );

    if (infoResponse.responseParameters.length !== 3) {
      throw new MtpObjectStoreError(
        "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE",
        `SendObjectInfo returned ${infoResponse.responseParameters.length} parameter(s); expected storage, parent, and handle`,
      );
    }
    const [returnedStorageId, returnedParentHandle, handle] = infoResponse.responseParameters;
    if (handle === 0 || handle === UINT32_MAX) {
      throw new MtpObjectStoreError(
        "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE",
        `SendObjectInfo returned reserved object handle 0x${handle.toString(16).padStart(8, "0")}; no cleanup delete was attempted`,
      );
    }
    if (this.ownedHandles.has(handle) || existingParentHandles.has(handle)) {
      throw new MtpObjectStoreError(
        "MTP_INVALID_SEND_OBJECT_INFO_RESPONSE",
        `SendObjectInfo returned pre-existing handle 0x${handle.toString(16).padStart(8, "0")}; no cleanup delete was attempted`,
      );
    }
    this.ownedHandles.add(handle);
    this.creationStates.set(handle, {
      metadata: creationMetadata,
      callback: request.onObjectState,
    });

    try {
      request.onObjectState?.({
        stage: "handle-assigned",
        handle,
        ...creationMetadata,
      });
    } catch (error) {
      throw await this.cleanupAfterCreateFailure(handle, request.filename, error, options);
    }

    const returnedParentMatches = returnedParentHandle === request.parentHandle
      || (request.parentHandle === MTP_ROOT_PARENT && returnedParentHandle === 0);
    if (returnedStorageId !== request.storageId || !returnedParentMatches) {
      const mismatch = new MtpObjectStoreError(
        "MTP_SEND_OBJECT_INFO_MISMATCH",
        `SendObjectInfo returned storage 0x${returnedStorageId.toString(16)}, parent 0x${returnedParentHandle.toString(16)}, handle 0x${handle.toString(16)}`,
      );
      throw await this.cleanupAfterCreateFailure(handle, request.filename, mismatch, options);
    }

    try {
      await this.session.execute(
        {
          operationCode: MtpOperationCode.SendObject,
          dataOut: this.toOutgoingData(request, chunkSize),
          expectedResponseParameterCount: 0,
        },
        options,
      );
    } catch (error) {
      throw await this.cleanupAfterCreateFailure(handle, request.filename, error, options);
    }

    return {
      handle,
      storageId: returnedStorageId,
      parentHandle: request.parentHandle,
      filename: request.filename,
      size: request.size,
    };
  }

  /** Deletes only a handle returned by SendObjectInfo through this instance. */
  async deleteObject(handle: number, options: MtpOperationOptions = {}): Promise<void> {
    assertSpecificObjectHandle(handle, "object handle");
    if (!this.ownedHandles.has(handle)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_NOT_OWNED",
        `refusing to delete unowned MTP handle 0x${handle.toString(16).padStart(8, "0")}`,
      );
    }
    await this.deleteOwnedObject(handle, options);
  }

  /**
   * Conditional deletion for one user-selected, pre-existing Kindle book.
   * The handle is always concrete; folders, cache files, and any ObjectInfo
   * that changed after the live inventory are rejected before DeleteObject.
   */
  async deleteExistingKindleBookObject(
    snapshot: KindleStoredObjectInfo,
    options: MtpOperationOptions = {},
  ): Promise<void> {
    assertSpecificObjectHandle(snapshot.handle, "object handle");
    assertUint32(snapshot.storageId, "storage ID");
    assertUint32(snapshot.objectFormat, "object format");
    assertSafeFilename(snapshot.filename);
    if (
      snapshot.parentHandle === 0
      || snapshot.parentHandle === UINT32_MAX
      || snapshot.objectFormat === MtpObjectFormat.Association
      || snapshot.associationType !== MtpAssociationType.Undefined
      || snapshot.protectionStatus !== 0
      || !Number.isSafeInteger(snapshot.compressedSize)
      || snapshot.compressedSize < 0
      || !isKindleBookFilename(snapshot.filename)
      || isKindleBridgeDeviceMetadataCacheFilename(snapshot.filename)
    ) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `object 0x${snapshot.handle.toString(16).padStart(8, "0")} is not an unprotected Kindle book file eligible for conditional deletion`,
      );
    }
    assertSpecificObjectHandle(snapshot.parentHandle, "parent handle");

    const current = await this.getObjectInfo(snapshot.handle, options);
    if (!this.sameStoredObjectInfo(current, snapshot)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `book object 0x${snapshot.handle.toString(16).padStart(8, "0")} changed after inventory`,
      );
    }
    const currentParentHandles = await this.listObjectHandles({
      storageId: snapshot.storageId,
      associationHandle: snapshot.parentHandle,
      maxHandles: MAX_CLEANUP_VERIFICATION_HANDLES,
    }, options);
    if (!currentParentHandles.includes(snapshot.handle)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `book object 0x${snapshot.handle.toString(16).padStart(8, "0")} is no longer a child of its inventoried parent`,
      );
    }

    // Narrow the final read/delete race after the parent relist. MTP does not
    // offer an atomic compare-and-delete primitive, so this is the last device
    // command before the exact-handle DeleteObject transaction.
    const finalCurrent = await this.getObjectInfo(snapshot.handle, options);
    if (!this.sameStoredObjectInfo(finalCurrent, snapshot)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `book object 0x${snapshot.handle.toString(16).padStart(8, "0")} changed immediately before deletion`,
      );
    }
    options.signal?.throwIfAborted();
    await this.session.execute(
      {
        operationCode: MtpOperationCode.DeleteObject,
        parameters: [snapshot.handle, MTP_ALL_OBJECT_FORMATS],
        expectedResponseParameterCount: 0,
      },
      options,
    );
    const remainingHandles = await this.listObjectHandles({
      storageId: snapshot.storageId,
      associationHandle: snapshot.parentHandle,
      maxHandles: MAX_CLEANUP_VERIFICATION_HANDLES,
    }, options);
    if (remainingHandles.includes(snapshot.handle)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_UNVERIFIED",
        `book object 0x${snapshot.handle.toString(16).padStart(8, "0")} still exists after exact-handle DeleteObject`,
      );
    }
  }

  async inspectKindleBridgeMetadataCacheObject(
    handle: number,
    options: MtpOperationOptions = {},
  ): Promise<KindleBridgeMetadataCacheObjectSnapshot> {
    const snapshot = await this.readValidatedCacheObject(handle, options);
    this.validatedCacheSnapshots.set(snapshot, { sessionOwned: this.ownedHandles.has(handle) });
    return snapshot;
  }

  async deleteKindleBridgeMetadataCacheObject(
    snapshot: KindleBridgeMetadataCacheObjectSnapshot,
    options: MtpOperationOptions = {},
  ): Promise<void> {
    const capability = this.validatedCacheSnapshots.get(snapshot);
    if (!capability) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        "refusing a forged, foreign-session, or already-consumed cache deletion snapshot",
      );
    }
    this.validatedCacheSnapshots.delete(snapshot);
    const current = await this.readValidatedCacheObject(snapshot.info.handle, options);
    if (!this.sameStoredObjectInfo(current.info, snapshot.info)
      || !equalBytes(current.data, snapshot.data)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `cache object 0x${snapshot.info.handle.toString(16).padStart(8, "0")} changed before conditional deletion`,
      );
    }
    if (capability.sessionOwned) {
      if (!this.ownedHandles.has(snapshot.info.handle)) {
        throw new MtpObjectStoreError(
          "MTP_OBJECT_DELETE_MISMATCH",
          "the session-owned cache deletion capability is no longer current",
        );
      }
      await this.deleteOwnedObject(snapshot.info.handle, options);
      return;
    }
    await this.session.execute(
      {
        operationCode: MtpOperationCode.DeleteObject,
        parameters: [snapshot.info.handle, MTP_ALL_OBJECT_FORMATS],
        expectedResponseParameterCount: 0,
      },
      options,
    );
    const remainingHandles = await this.listObjectHandles({
      storageId: snapshot.info.storageId,
      associationHandle: MTP_ROOT_PARENT,
      maxHandles: MAX_CACHE_ROOT_HANDLES,
    }, options);
    if (remainingHandles.includes(snapshot.info.handle)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_UNVERIFIED",
        `cache object 0x${snapshot.info.handle.toString(16).padStart(8, "0")} still exists after conditional DeleteObject`,
      );
    }
  }

  private async readValidatedCacheObject(
    handle: number,
    options: MtpOperationOptions,
  ): Promise<KindleBridgeMetadataCacheObjectSnapshot> {
    assertSpecificObjectHandle(handle, "object handle");
    const info = await this.getObjectInfo(handle, options);
    const rootHandles = await this.listObjectHandles({
      storageId: info.storageId,
      associationHandle: MTP_ROOT_PARENT,
      maxHandles: MAX_CACHE_ROOT_HANDLES,
    }, options);
    if (
      !rootHandles.includes(handle)
      || (info.parentHandle !== 0 && info.parentHandle !== MTP_ROOT_PARENT)
      || info.objectFormat !== MtpObjectFormat.Undefined
      || info.protectionStatus !== 0
      || info.associationType !== 0
      || !isKindleBridgeDeviceMetadataCacheFilename(info.filename)
      || !Number.isSafeInteger(info.compressedSize)
      || info.compressedSize < 1
      || info.compressedSize > KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES
    ) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `object 0x${handle.toString(16).padStart(8, "0")} is not a bounded root-level Kindle Bridge metadata cache`,
      );
    }
    const data = await this.readObject(handle, {
      ...options,
      maxBytes: info.compressedSize,
    });
    if (data.byteLength !== info.compressedSize) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `cache object 0x${handle.toString(16).padStart(8, "0")} size changed while it was inspected`,
      );
    }
    let cache: KindleBridgeDeviceMetadataCache;
    try {
      cache = await decodeKindleBridgeDeviceMetadataCache(data, {
        maxBytes: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES,
      });
    } catch (error) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_MISMATCH",
        `object 0x${handle.toString(16).padStart(8, "0")} is not a valid Kindle Bridge metadata cache`,
        error,
      );
    }
    return Object.freeze({
      info: Object.freeze({ ...info }),
      data: data.slice(),
      cache,
    });
  }

  private sameStoredObjectInfo(
    left: KindleStoredObjectInfo,
    right: KindleStoredObjectInfo,
  ): boolean {
    return left.handle === right.handle
      && left.storageId === right.storageId
      && left.objectFormat === right.objectFormat
      && left.protectionStatus === right.protectionStatus
      && left.compressedSize === right.compressedSize
      && left.parentHandle === right.parentHandle
      && left.associationType === right.associationType
      && left.filename === right.filename
      && left.modificationDate === right.modificationDate;
  }

  private async deleteOwnedObject(handle: number, options: MtpOperationOptions): Promise<void> {
    const creationState = this.creationStates.get(handle);
    if (!creationState) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_UNVERIFIED",
        `created-object metadata is unavailable for handle 0x${handle.toString(16).padStart(8, "0")}`,
      );
    }
    await this.session.execute(
      {
        operationCode: MtpOperationCode.DeleteObject,
        parameters: [handle, MTP_ALL_OBJECT_FORMATS],
        expectedResponseParameterCount: 0,
      },
      options,
    );
    const remainingHandles = await this.listObjectHandles({
      storageId: creationState.metadata.storageId,
      associationHandle: creationState.metadata.parentHandle,
      maxHandles: MAX_CLEANUP_VERIFICATION_HANDLES,
    }, options);
    if (remainingHandles.includes(handle)) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DELETE_UNVERIFIED",
        `object 0x${handle.toString(16).padStart(8, "0")} still exists after DeleteObject`,
      );
    }
    this.ownedHandles.delete(handle);
    this.creationStates.delete(handle);
    creationState?.callback?.({
      stage: "cleanup-succeeded",
      handle,
      ...creationState.metadata,
    });
  }

  private async cleanupAfterCreateFailure(
    handle: number,
    filename: string,
    cause: unknown,
    options: MtpOperationOptions,
  ): Promise<MtpPartialObjectError> {
    let cleanupError: unknown;
    try {
      await this.deleteOwnedObject(handle, options);
    } catch (error) {
      cleanupError = error;
    }
    return new MtpPartialObjectError({
      handle,
      filename,
      cause,
      cleanupAttempted: true,
      cleanupSucceeded: cleanupError === undefined,
      cleanupError,
    });
  }

  private validateKnownDataLength(data: MtpObjectData, expectedSize: number): void {
    const actualSize = data instanceof Uint8Array
      ? data.byteLength
      : isBlob(data)
        ? data.size
        : undefined;
    if (actualSize !== undefined && actualSize !== expectedSize) {
      throw new MtpObjectStoreError(
        "MTP_OBJECT_DATA_SIZE_MISMATCH",
        `object data contains ${actualSize} byte(s), but size is ${expectedSize}`,
      );
    }
  }

  private toOutgoingData(request: MtpCreateObjectRequest, chunkSize: number): MtpOutgoingData {
    const data = request.data;
    const chunks = data instanceof Uint8Array
      ? this.byteChunks(data, chunkSize)
      : isBlob(data)
        ? this.blobChunks(data, chunkSize)
        : data;
    return {
      length: request.size,
      chunks,
      onProgress: request.onProgress
        ? (bytesTransferred, totalBytes) => request.onProgress?.({ bytesTransferred, totalBytes })
        : undefined,
    };
  }

  private async *byteChunks(data: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      yield data.slice(offset, Math.min(offset + chunkSize, data.byteLength));
    }
  }

  private async *blobChunks(data: Blob, chunkSize: number): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < data.size; offset += chunkSize) {
      const buffer = await data.slice(offset, Math.min(offset + chunkSize, data.size)).arrayBuffer();
      yield new Uint8Array(buffer);
    }
  }
}
