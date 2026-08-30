import type {
  KindleBridgeMetadataCacheObjectSnapshot,
  KindleObjectStore,
  KindleOperationOptions,
  KindleStoredObjectInfo,
  KindleTarget,
} from "./contracts";
import {
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_ENTRIES,
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION,
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS,
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION,
  createKindleBridgeDeviceMetadataCacheFilename,
  parseKindleBridgeDeviceMetadataCacheFilename,
  type KindleBridgeDeviceMetadataCache,
  type KindleBridgeDeviceMetadataCacheEntry,
  type KindleBridgeDeviceMetadataCacheSlot,
} from "./device-metadata-cache-codec";
import { filenamesEqual } from "./filenames";
import type {
  KindleInventoryDeviceMetadataCacheContext,
  KindleInventorySnapshot,
} from "./inventory";
import { MTP_ROOT_PARENT } from "../mtp/constants";
import { isFatalTransportFailure } from "../error-diagnostics";

const MAX_ROOT_OBJECT_HANDLES = 256;

export interface LoadedKindleBridgeDeviceMetadataCache {
  readonly rootObjects: readonly KindleStoredObjectInfo[];
  readonly snapshotsBySlot: ReadonlyMap<
    KindleBridgeDeviceMetadataCacheSlot,
    KindleBridgeMetadataCacheObjectSnapshot
  >;
  readonly blockedSlots: ReadonlySet<KindleBridgeDeviceMetadataCacheSlot>;
  readonly active?: {
    readonly slot: KindleBridgeDeviceMetadataCacheSlot;
    readonly snapshot: KindleBridgeMetadataCacheObjectSnapshot;
  };
  readonly generationAmbiguous: boolean;
  readonly context?: KindleInventoryDeviceMetadataCacheContext;
}

export interface KindleBridgeDeviceMetadataCacheWritePlan {
  readonly slot: KindleBridgeDeviceMetadataCacheSlot;
  readonly filename: string;
  readonly generation: number;
  readonly replace?: KindleBridgeMetadataCacheObjectSnapshot;
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code
    : undefined;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === "AbortError")
    || safeErrorCode(error) === "MTP_OPERATION_ABORTED";
}

function isTransportFailure(error: unknown): boolean {
  return isFatalTransportFailure(error);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactSlotForFilename(
  filename: string,
): KindleBridgeDeviceMetadataCacheSlot | undefined {
  return parseKindleBridgeDeviceMetadataCacheFilename(filename) ?? undefined;
}

/**
 * Performs one bounded root discovery. Invalid or ambiguous namespace objects
 * block only their exact slot and are never deletion candidates.
 */
export async function loadKindleBridgeDeviceMetadataCache(
  store: KindleObjectStore,
  target: KindleTarget,
  options: KindleOperationOptions = {},
  rootSeed?: readonly KindleStoredObjectInfo[],
): Promise<LoadedKindleBridgeDeviceMetadataCache> {
  let handles: readonly number[];
  try {
    handles = await store.listObjectHandles({
      storageId: target.storageId,
      associationHandle: MTP_ROOT_PARENT,
      maxHandles: MAX_ROOT_OBJECT_HANDLES,
    }, options);
  } catch (error) {
    if (isAbort(error, options.signal) || isTransportFailure(error)) throw error;
    return Object.freeze({
      rootObjects: Object.freeze([]),
      snapshotsBySlot: new Map(),
      blockedSlots: new Set(KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS),
      generationAmbiguous: false,
    });
  }

  const seedByHandle = new Map(rootSeed?.map((info) => [info.handle, info] as const) ?? []);
  const seedMatches = seedByHandle.size === handles.length
    && handles.every((handle) => seedByHandle.has(handle));
  const rootObjects: KindleStoredObjectInfo[] = [];
  if (seedMatches) {
    for (const handle of handles) rootObjects.push(seedByHandle.get(handle)!);
  } else {
    for (const handle of handles) {
      try {
        rootObjects.push(await store.getObjectInfo(handle, options));
      } catch (error) {
        if (isAbort(error, options.signal) || isTransportFailure(error)) throw error;
        // A disappearing or malformed unrelated root object disables neither
        // the live Documents hierarchy nor a separately validated cache slot.
      }
    }
  }

  const slotCandidates = new Map<KindleBridgeDeviceMetadataCacheSlot, KindleStoredObjectInfo[]>();
  for (const slot of KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS) {
    const expected = createKindleBridgeDeviceMetadataCacheFilename(slot);
    slotCandidates.set(slot, rootObjects.filter((info) => filenamesEqual(info.filename, expected)));
  }

  const snapshotsBySlot = new Map<
    KindleBridgeDeviceMetadataCacheSlot,
    KindleBridgeMetadataCacheObjectSnapshot
  >();
  const blockedSlots = new Set<KindleBridgeDeviceMetadataCacheSlot>();
  for (const slot of KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS) {
    const candidates = slotCandidates.get(slot) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length !== 1 || exactSlotForFilename(candidates[0]!.filename) !== slot) {
      blockedSlots.add(slot);
      continue;
    }
    try {
      const candidate = candidates[0]!;
      const snapshot = await store.inspectKindleBridgeMetadataCacheObject(
        candidate.handle,
        options,
      );
      options.signal?.throwIfAborted();
      if (
        snapshot.info.handle !== candidate.handle
        || snapshot.info.storageId !== target.storageId
        || exactSlotForFilename(snapshot.info.filename) !== slot
      ) {
        blockedSlots.add(slot);
        continue;
      }
      snapshotsBySlot.set(slot, snapshot);
    } catch (error) {
      if (isAbort(error, options.signal) || isTransportFailure(error)) throw error;
      blockedSlots.add(slot);
    }
  }

  const valid = [...snapshotsBySlot.entries()]
    .sort(([leftSlot, left], [rightSlot, right]) => (
      left.cache.generation === right.cache.generation
        ? leftSlot.localeCompare(rightSlot)
        : left.cache.generation > right.cache.generation ? -1 : 1
    ));
  const first = valid[0];
  const second = valid[1];
  const generationAmbiguous = first !== undefined
    && second !== undefined
    && first[1].cache.generation === second[1].cache.generation
    && !equalBytes(first[1].data, second[1].data);
  const active = first === undefined || generationAmbiguous
    ? undefined
    : Object.freeze({ slot: first[0], snapshot: first[1] });
  const context = valid.length === 0 || generationAmbiguous
    ? undefined
    : Object.freeze({ caches: Object.freeze(valid.map(([, snapshot]) => snapshot.cache)) });

  return Object.freeze({
    rootObjects: Object.freeze(rootObjects.slice()),
    snapshotsBySlot,
    blockedSlots,
    ...(active === undefined ? {} : { active }),
    generationAmbiguous,
    ...(context === undefined ? {} : { context }),
  });
}

export function planKindleBridgeDeviceMetadataCacheWrite(
  loaded: LoadedKindleBridgeDeviceMetadataCache,
): KindleBridgeDeviceMetadataCacheWritePlan | undefined {
  if (loaded.generationAmbiguous) return undefined;
  const activeGeneration = loaded.active?.snapshot.cache.generation ?? 0;
  if (activeGeneration >= Number.MAX_SAFE_INTEGER) return undefined;
  const slot: KindleBridgeDeviceMetadataCacheSlot = loaded.active?.slot === "a" ? "b" : "a";
  if (loaded.blockedSlots.has(slot)) return undefined;
  return Object.freeze({
    slot,
    filename: createKindleBridgeDeviceMetadataCacheFilename(slot),
    generation: activeGeneration + 1,
    ...(loaded.snapshotsBySlot.get(slot) === undefined
      ? {}
      : { replace: loaded.snapshotsBySlot.get(slot)! }),
  });
}

/** Builds portable entries only from exact objects in this live inventory. */
export function kindleInventoryToDeviceMetadataCacheEntries(
  inventory: KindleInventorySnapshot,
): readonly KindleBridgeDeviceMetadataCacheEntry[] {
  const candidates: KindleBridgeDeviceMetadataCacheEntry[] = [];
  const pathCounts = new Map<string, number>();
  for (const object of inventory.objects) {
    if (object.kind !== "file" || object.metadataAdjusted || object.relativePath.length === 0) continue;
    const pathKey = object.relativePath.toLocaleLowerCase("en-US");
    pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
  }
  for (const object of inventory.objects) {
    if (
      object.kind !== "file"
      || object.metadataAdjusted
      || object.modificationDate === undefined
      || (object.bookMetadataState !== "enriched" && object.bookMetadataState !== "empty")
      || object.authors === undefined
      || object.identifiers === undefined
    ) {
      continue;
    }
    const pathKey = object.relativePath.toLocaleLowerCase("en-US");
    if (pathCounts.get(pathKey) !== 1) continue;
    candidates.push(Object.freeze({
      relativePath: object.relativePath,
      size: object.size,
      modificationDate: object.modificationDate,
      objectFormat: object.objectFormat,
      metadata: Object.freeze({
        ...(object.title === undefined ? {} : { title: object.title }),
        authors: Object.freeze([...object.authors]),
        identifiers: Object.freeze([...object.identifiers]),
        ...(object.language === undefined ? {} : { language: object.language }),
      }),
    }));
  }
  return Object.freeze(candidates
    .slice(0, KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_ENTRIES));
}

export function makeKindleBridgeDeviceMetadataCache(
  generation: number,
  entries: readonly KindleBridgeDeviceMetadataCacheEntry[],
): KindleBridgeDeviceMetadataCache {
  return Object.freeze({
    version: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION,
    parserRevision: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION,
    generation,
    entries,
  });
}

export { isTransportFailure as isKindleDeviceMetadataCacheTransportFailure };
