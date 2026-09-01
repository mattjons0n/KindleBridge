import type { MtpObjectCreationState } from "../mtp/object-store";
import type { KindleBridgeDeviceMetadataCache } from "./device-metadata-cache-codec";

export interface KindleOperationOptions {
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  /** Metadata-only lifecycle events; never contains the object's bytes. */
  onObjectState?: (state: MtpObjectCreationState) => void;
}

export interface KindleReadObjectOptions extends KindleOperationOptions {
  maxBytes?: number;
}

export interface KindleStorageInfo {
  storageType: number;
  filesystemType: number;
  /** MTP value 0 is read/write; other standardized values are read-only. */
  accessCapability: number;
  maxCapacity: bigint;
  freeSpaceInBytes: bigint;
  freeSpaceInImages: number;
  storageDescription: string;
  volumeLabel: string;
}

export interface KindleStoredObjectInfo {
  handle: number;
  storageId: number;
  objectFormat: number;
  protectionStatus: number;
  compressedSize: number;
  parentHandle: number;
  associationType: number;
  filename: string;
  /** Raw MTP modification timestamp; consumers must validate before trusting it. */
  modificationDate: string;
}

export interface KindleCreateObjectRequest {
  storageId: number;
  parentHandle: number;
  filename: string;
  objectFormat: number;
  size: number;
  data: Uint8Array | Blob | AsyncIterable<Uint8Array>;
  modificationDate?: Date;
  captureDate?: Date;
  onProgress?: (progress: {
    bytesTransferred: number;
    totalBytes: number;
  }) => void;
  onObjectState?: (state: MtpObjectCreationState) => void;
}

export interface KindleCreatedObject {
  handle: number;
  storageId: number;
  parentHandle: number;
  filename: string;
  size: number;
}

/**
 * Exact, read-before-delete authority for a small application-owned object
 * discovered in an earlier MTP session. The caller must supply the complete
 * metadata snapshot and exact bytes it already validated.
 */
export interface KindleBridgeMetadataCacheObjectSnapshot {
  readonly info: KindleStoredObjectInfo;
  readonly data: Uint8Array;
  readonly cache: KindleBridgeDeviceMetadataCache;
}

/**
 * Adapter-friendly subset of MtpObjectStore used by Kindle-specific policy.
 * MtpObjectStore is assignable to this interface without a runtime wrapper.
 */
export interface KindleObjectStore {
  listStorageIds(options?: KindleOperationOptions): Promise<readonly number[]>;
  getStorageInfo(
    storageId: number,
    options?: KindleOperationOptions,
  ): Promise<KindleStorageInfo>;
  listObjectHandles(
    query: {
      storageId: number;
      objectFormat?: number;
      associationHandle?: number;
      /** Bounds the returned handle dataset before it is allocated. */
      maxHandles?: number;
    },
    options?: KindleOperationOptions,
  ): Promise<readonly number[]>;
  getObjectInfo(
    handle: number,
    options?: KindleOperationOptions,
  ): Promise<KindleStoredObjectInfo>;
  createObject(
    request: KindleCreateObjectRequest,
    options?: KindleOperationOptions,
  ): Promise<KindleCreatedObject>;
  readObject(
    handle: number,
    options?: KindleReadObjectOptions,
  ): Promise<Uint8Array>;
  /** The concrete store must reject handles it did not create this session. */
  deleteObject(handle: number, options?: KindleOperationOptions): Promise<void>;
  /**
   * Deletes one pre-existing Kindle book only when its complete live ObjectInfo
   * still exactly matches the current-inventory snapshot supplied by policy.
   * Associations and application cache objects must always be rejected.
   */
  deleteExistingKindleBookObject(
    snapshot: KindleStoredObjectInfo,
    options?: KindleOperationOptions,
  ): Promise<void>;
  /** Reads and validates a bounded, root-level Kindle Bridge cache candidate. */
  inspectKindleBridgeMetadataCacheObject(
    handle: number,
    options?: KindleOperationOptions,
  ): Promise<KindleBridgeMetadataCacheObjectSnapshot>;
  /**
   * Consumes a session-bound snapshot and deletes only that still-identical,
   * strictly validated Kindle Bridge cache object.
   */
  deleteKindleBridgeMetadataCacheObject(
    snapshot: KindleBridgeMetadataCacheObjectSnapshot,
    options?: KindleOperationOptions,
  ): Promise<void>;
}

export interface KindleTarget {
  storageId: number;
  storage: KindleStorageInfo;
  documentsHandle: number;
  documents: KindleStoredObjectInfo;
}
