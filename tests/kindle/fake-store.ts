import type {
  KindleCreateObjectRequest,
  KindleCreatedObject,
  KindleBridgeMetadataCacheObjectSnapshot,
  KindleObjectStore,
  KindleOperationOptions,
  KindleReadObjectOptions,
  KindleStorageInfo,
  KindleStoredObjectInfo,
} from "../../client/src/kindle/contracts";
import {
  MTP_ACCESS_READ_WRITE,
  MTP_OBJECT_FORMAT_ASSOCIATION,
  MTP_ROOT_ASSOCIATION_HANDLE,
} from "../../client/src/kindle/kindle-device";
import {
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES,
  decodeKindleBridgeDeviceMetadataCache,
  isKindleBridgeDeviceMetadataCacheFilename,
} from "../../client/src/kindle/device-metadata-cache-codec";

export function storageInfo(
  overrides: Partial<KindleStorageInfo> = {},
): KindleStorageInfo {
  return {
    storageType: 3,
    filesystemType: 2,
    accessCapability: MTP_ACCESS_READ_WRITE,
    maxCapacity: 32_000_000n,
    freeSpaceInBytes: 16_000_000n,
    freeSpaceInImages: 0xffff_ffff,
    storageDescription: "Internal storage",
    volumeLabel: "Kindle",
    ...overrides,
  };
}

export function objectInfo(
  handle: number,
  overrides: Partial<KindleStoredObjectInfo> = {},
): KindleStoredObjectInfo {
  return {
    handle,
    storageId: 1,
    objectFormat: 0x3000,
    protectionStatus: 0,
    compressedSize: 0,
    parentHandle: 0,
    associationType: 0,
    filename: `object-${handle}`,
    modificationDate: "20260829T120000Z",
    ...overrides,
  };
}

export class FakeKindleObjectStore implements KindleObjectStore {
  readonly storages = new Map<number, KindleStorageInfo>();
  readonly objects = new Map<number, KindleStoredObjectInfo>();
  readonly objectData = new Map<number, Uint8Array>();
  readonly ownedHandles = new Set<number>();
  readonly deletedHandles: number[] = [];
  readonly conditionallyDeletedHandles: number[] = [];
  readonly createRequests: KindleCreateObjectRequest[] = [];
  readonly childListFailures = new Map<number, unknown>();
  readonly metadataFailures = new Map<number, unknown>();
  readonly metadataRequests: number[] = [];
  readonly readFailures = new Map<number, unknown>();
  readonly readRequests: Array<{ handle: number; maxBytes?: number }> = [];
  nextHandle = 100;
  corruptReadback = false;
  failDelete = false;
  readonly validatedCacheSnapshots = new WeakMap<object, { readonly sessionOwned: boolean }>();
  metadataMutation?: (
    info: KindleStoredObjectInfo,
  ) => KindleStoredObjectInfo;

  constructor() {
    this.storages.set(1, storageInfo());
    this.objects.set(
      10,
      objectInfo(10, {
        storageId: 1,
        objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
        associationType: 1,
        parentHandle: 0,
        filename: "Documents",
      }),
    );
  }

  async listStorageIds(
    _options?: KindleOperationOptions,
  ): Promise<readonly number[]> {
    return [...this.storages.keys()];
  }

  async getStorageInfo(
    storageId: number,
    _options?: KindleOperationOptions,
  ): Promise<KindleStorageInfo> {
    const storage = this.storages.get(storageId);
    if (!storage) throw new Error(`Unknown storage ${storageId}`);
    return storage;
  }

  async listObjectHandles(
    query: {
      storageId: number;
      objectFormat?: number;
      associationHandle?: number;
      maxHandles?: number;
    },
    _options?: KindleOperationOptions,
  ): Promise<readonly number[]> {
    const listFailure = query.associationHandle === undefined
      ? undefined
      : this.childListFailures.get(query.associationHandle);
    if (listFailure) throw listFailure;
    const handles = [...this.objects.values()]
      .filter((info) => info.storageId === query.storageId)
      .filter(
        (info) =>
          query.objectFormat === undefined ||
          info.objectFormat === query.objectFormat,
      )
      .filter(
        (info) =>
          query.associationHandle === undefined ||
          info.parentHandle === query.associationHandle
          || (query.associationHandle === MTP_ROOT_ASSOCIATION_HANDLE && info.parentHandle === 0),
      )
      .map(({ handle }) => handle);
    if (query.maxHandles !== undefined && handles.length > query.maxHandles) {
      throw Object.assign(new Error("simulated bounded handle dataset"), {
        code: "MTP_HANDLE_LIMIT_EXCEEDED",
      });
    }
    return handles;
  }

  async getObjectInfo(
    handle: number,
    _options?: KindleOperationOptions,
  ): Promise<KindleStoredObjectInfo> {
    this.metadataRequests.push(handle);
    const failure = this.metadataFailures.get(handle);
    if (failure) throw failure;
    const info = this.objects.get(handle);
    if (!info) throw new Error(`Unknown object ${handle}`);
    return info;
  }

  async createObject(
    request: KindleCreateObjectRequest,
    _options?: KindleOperationOptions,
  ): Promise<KindleCreatedObject> {
    this.createRequests.push(request);
    const metadata = {
      storageId: request.storageId,
      parentHandle: request.parentHandle,
      filename: request.filename,
      size: request.size,
    };
    request.onObjectState?.({
      stage: "send-object-info-intent",
      ...metadata,
    });
    const handle = this.nextHandle++;
    request.onObjectState?.({ stage: "handle-assigned", handle, ...metadata });
    let data: Uint8Array;
    if (request.data instanceof Uint8Array) {
      data = request.data.slice();
    } else if (request.data instanceof Blob) {
      data = new Uint8Array(await request.data.arrayBuffer());
    } else {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of request.data) {
        chunks.push(chunk);
        size += chunk.byteLength;
      }
      data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    request.onProgress?.({
      bytesTransferred: data.byteLength,
      totalBytes: request.size,
    });

    let info = objectInfo(handle, {
      storageId: request.storageId,
      parentHandle: request.parentHandle === MTP_ROOT_ASSOCIATION_HANDLE ? 0 : request.parentHandle,
      filename: request.filename,
      objectFormat: request.objectFormat,
      compressedSize: request.size,
    });
    info = this.metadataMutation?.(info) ?? info;
    this.objects.set(handle, info);
    this.objectData.set(handle, data);
    this.ownedHandles.add(handle);
    return {
      handle,
      storageId: request.storageId,
      parentHandle: request.parentHandle,
      filename: request.filename,
      size: request.size,
    };
  }

  async readObject(
    handle: number,
    options: KindleReadObjectOptions = {},
  ): Promise<Uint8Array> {
    this.readRequests.push({
      handle,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    const failure = this.readFailures.get(handle);
    if (failure) throw failure;
    const data = this.objectData.get(handle);
    if (!data) throw new Error(`No data for ${handle}`);
    if (options.maxBytes !== undefined && data.byteLength > options.maxBytes) {
      throw Object.assign(new Error("simulated bounded object read"), {
        code: "MTP_READ_LIMIT_EXCEEDED",
      });
    }
    const result = data.slice();
    if (this.corruptReadback && result.byteLength) result[0] ^= 0xff;
    return result;
  }

  async deleteObject(
    handle: number,
    _options?: KindleOperationOptions,
  ): Promise<void> {
    if (!this.ownedHandles.has(handle)) {
      throw new Error(`Refusing to delete unowned handle ${handle}`);
    }
    if (this.failDelete) throw new Error("simulated delete failure");
    const info = this.objects.get(handle);
    this.deletedHandles.push(handle);
    this.objects.delete(handle);
    this.objectData.delete(handle);
    this.ownedHandles.delete(handle);
    const request = this.createRequests.find((entry) => entry.filename === info?.filename);
    if (request && info) {
      request.onObjectState?.({
        stage: "cleanup-succeeded",
        handle,
        storageId: request.storageId,
        parentHandle: request.parentHandle,
        filename: request.filename,
        size: request.size,
      });
    }
  }

  async deleteExistingKindleBookObject(
    snapshot: KindleStoredObjectInfo,
    _options?: KindleOperationOptions,
  ): Promise<void> {
    const current = this.objects.get(snapshot.handle);
    const extension = snapshot.filename.split(".").at(-1)?.toLocaleLowerCase("en-US");
    if (
      !current
      || JSON.stringify(current) !== JSON.stringify(snapshot)
      || snapshot.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
      || snapshot.associationType !== 0
      || snapshot.protectionStatus !== 0
      || isKindleBridgeDeviceMetadataCacheFilename(snapshot.filename)
      || !extension
      || !new Set(["azw", "azw3", "azw8", "kfx", "mobi", "prc"]).has(extension)
    ) {
      throw Object.assign(new Error(`Conditional book deletion mismatch for ${snapshot.handle}`), {
        code: "MTP_OBJECT_DELETE_MISMATCH",
      });
    }
    const siblings = [...this.objects.values()].filter((info) => (
      info.storageId === snapshot.storageId && info.parentHandle === snapshot.parentHandle
    ));
    if (!siblings.some(({ handle }) => handle === snapshot.handle)) {
      throw Object.assign(new Error(`Conditional book parent mismatch for ${snapshot.handle}`), {
        code: "MTP_OBJECT_DELETE_MISMATCH",
      });
    }
    if (this.failDelete) throw new Error("simulated delete failure");
    this.conditionallyDeletedHandles.push(snapshot.handle);
    this.deletedHandles.push(snapshot.handle);
    this.objects.delete(snapshot.handle);
    this.objectData.delete(snapshot.handle);
  }

  async inspectKindleBridgeMetadataCacheObject(
    handle: number,
    _options?: KindleOperationOptions,
  ): Promise<KindleBridgeMetadataCacheObjectSnapshot> {
    const info = await this.getObjectInfo(handle);
    const rootHandles = await this.listObjectHandles({
      storageId: info.storageId,
      associationHandle: MTP_ROOT_ASSOCIATION_HANDLE,
      maxHandles: 256,
    });
    if (
      !rootHandles.includes(handle)
      || (info.parentHandle !== 0 && info.parentHandle !== MTP_ROOT_ASSOCIATION_HANDLE)
      || info.objectFormat !== 0x3000
      || info.protectionStatus !== 0
      || info.associationType !== 0
      || !isKindleBridgeDeviceMetadataCacheFilename(info.filename)
      || info.compressedSize < 1
      || info.compressedSize > KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES
    ) {
      throw new Error(`Invalid cache candidate ${handle}`);
    }
    const data = await this.readObject(handle, { maxBytes: info.compressedSize });
    if (data.byteLength !== info.compressedSize) throw new Error(`Cache size mismatch ${handle}`);
    const cache = await decodeKindleBridgeDeviceMetadataCache(data);
    const snapshot = Object.freeze({ info: Object.freeze({ ...info }), data: data.slice(), cache });
    this.validatedCacheSnapshots.set(snapshot, { sessionOwned: this.ownedHandles.has(handle) });
    return snapshot;
  }

  async deleteKindleBridgeMetadataCacheObject(
    snapshot: KindleBridgeMetadataCacheObjectSnapshot,
    _options?: KindleOperationOptions,
  ): Promise<void> {
    const capability = this.validatedCacheSnapshots.get(snapshot);
    if (!capability) {
      throw new Error("Refusing forged or consumed cache snapshot");
    }
    this.validatedCacheSnapshots.delete(snapshot);
    if (this.failDelete) throw new Error("simulated delete failure");
    const current = this.objects.get(snapshot.info.handle);
    const currentData = this.objectData.get(snapshot.info.handle);
    if (!current || !currentData || JSON.stringify(current) !== JSON.stringify(snapshot.info)) {
      throw new Error(`Exact metadata mismatch for handle ${snapshot.info.handle}`);
    }
    if (currentData.byteLength !== snapshot.data.byteLength
      || currentData.some((byte, index) => byte !== snapshot.data[index])) {
      throw new Error(`Exact byte mismatch for handle ${snapshot.info.handle}`);
    }
    this.deletedHandles.push(snapshot.info.handle);
    this.objects.delete(snapshot.info.handle);
    this.objectData.delete(snapshot.info.handle);
    this.ownedHandles.delete(snapshot.info.handle);
  }
}
