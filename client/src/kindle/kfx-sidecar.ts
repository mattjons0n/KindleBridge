import { isFatalTransportFailure } from "../error-diagnostics";
import type { KindleBookMetadata } from "./book-metadata";
import type {
  KindleObjectStore,
  KindleOperationOptions,
  KindleStoredObjectInfo,
} from "./contracts";
import { filenamesEqual } from "./filenames";
import type { KindleInventoryObject } from "./inventory";
import {
  parseKindleKfxMetadata,
  type KindleKfxMetadataParserOptions,
} from "./kfx-metadata";

const UINT32_MAX = 0xffff_ffff;
const OBJECT_FORMAT_ASSOCIATION = 0x3001;
const DEFAULT_MAX_BOOKS = 2_000;
const DEFAULT_MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_CHILD_OBJECTS = 32;
const DEFAULT_MAX_FILENAME_LENGTH = 254;
const HARD_MAX_BOOKS = 2_000;
const HARD_MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const HARD_MAX_CHILD_OBJECTS = 256;

export interface KindleKfxSidecarMetadataOptions extends KindleKfxMetadataParserOptions {
  readonly maxBooks?: number;
  readonly maxSidecarBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxChildObjects?: number;
}

export type KindleKfxSidecarSkipReason =
  | "book-limit"
  | "object-size"
  | "total-bytes";

export type KindleKfxSidecarMetadataOutcome =
  | {
    readonly state: "enriched";
    readonly metadata: KindleBookMetadata;
    readonly readBytes: number;
    readonly budgetedBytes: number;
  }
  | {
    readonly state: "failed";
  }
  | {
    readonly state: "skipped";
    readonly reason: KindleKfxSidecarSkipReason;
  };

export interface KindleKfxSidecarMetadataResult {
  readonly byBookHandle: ReadonlyMap<number, KindleKfxSidecarMetadataOutcome>;
}

interface ResolvedLimits {
  readonly maxBooks: number;
  readonly maxSidecarBytes: number;
  readonly maxTotalBytes: number;
  readonly maxChildObjects: number;
  readonly parser: KindleKfxMetadataParserOptions;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function resolveLimits(options: KindleKfxSidecarMetadataOptions): ResolvedLimits {
  const maxSidecarBytes = boundedInteger(
    options.maxSidecarBytes,
    DEFAULT_MAX_SIDECAR_BYTES,
    1,
    HARD_MAX_SIDECAR_BYTES,
    "kfxSidecarMetadata.maxSidecarBytes",
  );
  return {
    maxBooks: boundedInteger(options.maxBooks, DEFAULT_MAX_BOOKS, 1, HARD_MAX_BOOKS, "kfxSidecarMetadata.maxBooks"),
    maxSidecarBytes,
    maxTotalBytes: boundedInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      1,
      HARD_MAX_TOTAL_BYTES,
      "kfxSidecarMetadata.maxTotalBytes",
    ),
    maxChildObjects: boundedInteger(
      options.maxChildObjects,
      DEFAULT_MAX_CHILD_OBJECTS,
      1,
      HARD_MAX_CHILD_OBJECTS,
      "kfxSidecarMetadata.maxChildObjects",
    ),
    parser: Object.freeze({
      ...(options.maxInputBytes === undefined ? { maxInputBytes: maxSidecarBytes } : { maxInputBytes: options.maxInputBytes }),
      ...(options.maxEntities === undefined ? {} : { maxEntities: options.maxEntities }),
      ...(options.maxFields === undefined ? {} : { maxFields: options.maxFields }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.maxStringBytes === undefined ? {} : { maxStringBytes: options.maxStringBytes }),
      ...(options.maxDecodedBytes === undefined ? {} : { maxDecodedBytes: options.maxDecodedBytes }),
      ...(options.maxAuthors === undefined ? {} : { maxAuthors: options.maxAuthors }),
      ...(options.maxIdentifiers === undefined ? {} : { maxIdentifiers: options.maxIdentifiers }),
    }),
  };
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "MTP_OPERATION_ABORTED";
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < UINT32_MAX;
}

function exactLeaf(value: string): boolean {
  return value.length > 0
    && value.length <= DEFAULT_MAX_FILENAME_LENGTH
    && !/[\u0000-\u001f\u007f/\\]/u.test(value);
}

export function exactKindleSidecarName(
  filename: string,
  supportedBookExtensions: ReadonlySet<string>,
): string | undefined {
  if (!exactLeaf(filename)) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  const extension = filename.slice(dot + 1).toLocaleLowerCase("en-US");
  if (!supportedBookExtensions.has(extension)) return undefined;
  return `${filename.slice(0, dot)}.sdr`;
}

function exactChildInfo(
  info: KindleStoredObjectInfo,
  handle: number,
  storageId: number,
  parentHandle: number,
): boolean {
  return info.handle === handle
    && isUint32(handle)
    && info.storageId === storageId
    && info.parentHandle === parentHandle
    && exactLeaf(info.filename)
    && Number.isSafeInteger(info.compressedSize)
    && info.compressedSize >= 0;
}

export async function listExactKindleSidecarChildren(
  store: KindleObjectStore,
  storageId: number,
  parentHandle: number,
  maxChildObjects: number,
  operationOptions: KindleOperationOptions,
): Promise<readonly KindleStoredObjectInfo[]> {
  const handles = await store.listObjectHandles({
    storageId,
    associationHandle: parentHandle,
    maxHandles: maxChildObjects,
  }, operationOptions);
  const unique = new Set<number>();
  const children: KindleStoredObjectInfo[] = [];
  for (const handle of handles) {
    if (!isUint32(handle) || unique.has(handle)) throw new Error("Invalid Kindle sidecar child handle set.");
    unique.add(handle);
    const info = await store.getObjectInfo(handle, operationOptions);
    if (!exactChildInfo(info, handle, storageId, parentHandle)) {
      throw new Error("Kindle sidecar child metadata is inconsistent.");
    }
    children.push(info);
  }
  return Object.freeze(children);
}

export function findExactKindleSiblingSidecar(
  objects: readonly KindleInventoryObject[],
  book: KindleInventoryObject,
  supportedBookExtensions: ReadonlySet<string>,
): KindleInventoryObject | undefined {
  const expectedSidecar = book.kind === "file" && !book.metadataAdjusted
    ? exactKindleSidecarName(book.filename, supportedBookExtensions)
    : undefined;
  if (expectedSidecar === undefined) return undefined;
  const claimingBooks = objects.filter((candidate) => {
    if (
      candidate.kind !== "file"
      || candidate.metadataAdjusted
      || candidate.storageId !== book.storageId
      || candidate.parentHandle !== book.parentHandle
    ) {
      return false;
    }
    const candidateSidecar = exactKindleSidecarName(candidate.filename, supportedBookExtensions);
    return candidateSidecar !== undefined && filenamesEqual(candidateSidecar, expectedSidecar);
  });
  if (claimingBooks.length !== 1 || claimingBooks[0]!.handle !== book.handle) return undefined;
  const matches = objects.filter((candidate) => (
    candidate.kind === "folder"
    && !candidate.metadataAdjusted
    && candidate.storageId === book.storageId
    && candidate.parentHandle === book.parentHandle
    && candidate.associationType === 1
    && filenamesEqual(candidate.filename, expectedSidecar)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function exactlyOneNamed(
  objects: readonly KindleStoredObjectInfo[],
  filename: string,
  association: boolean,
): KindleStoredObjectInfo | undefined {
  const matches = objects.filter((object) => (
    filenamesEqual(object.filename, filename)
    && (object.objectFormat === OBJECT_FORMAT_ASSOCIATION) === association
    && object.associationType === (association ? 1 : 0)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Resolves only `<book stem>.sdr/assets/metadata.kfx` through freshly listed
 * parent handles. It is intentionally separate from normal hierarchy walking,
 * which continues to prune every `.sdr` directory.
 */
export async function readKindleKfxSidecarMetadata(
  store: KindleObjectStore,
  objects: readonly KindleInventoryObject[],
  options: KindleKfxSidecarMetadataOptions,
  operationOptions: KindleOperationOptions = {},
): Promise<KindleKfxSidecarMetadataResult> {
  const limits = resolveLimits(options);
  const byBookHandle = new Map<number, KindleKfxSidecarMetadataOutcome>();
  const supportedBookExtensions = new Set(["kfx", "azw8"]);
  let attemptedBooks = 0;
  let budgetedBytes = 0;

  for (const book of objects) {
    const sidecar = findExactKindleSiblingSidecar(objects, book, supportedBookExtensions);
    if (sidecar === undefined) continue;
    operationOptions.signal?.throwIfAborted();
    if (attemptedBooks >= limits.maxBooks) {
      byBookHandle.set(book.handle, Object.freeze({ state: "skipped", reason: "book-limit" }));
      continue;
    }
    attemptedBooks += 1;

    try {
      const sidecarChildren = await listExactKindleSidecarChildren(
        store,
        book.storageId,
        sidecar.handle,
        limits.maxChildObjects,
        operationOptions,
      );
      const assets = exactlyOneNamed(sidecarChildren, "assets", true);
      if (assets === undefined) throw new Error("Exact KFX assets folder is absent or ambiguous.");
      const assetChildren = await listExactKindleSidecarChildren(
        store,
        book.storageId,
        assets.handle,
        limits.maxChildObjects,
        operationOptions,
      );
      const metadata = exactlyOneNamed(assetChildren, "metadata.kfx", false);
      if (metadata === undefined) throw new Error("Exact KFX metadata sidecar is absent or ambiguous.");
      if (metadata.compressedSize < 1 || metadata.compressedSize > limits.maxSidecarBytes) {
        byBookHandle.set(book.handle, Object.freeze({ state: "skipped", reason: "object-size" }));
        continue;
      }
      if (metadata.compressedSize > limits.maxTotalBytes - budgetedBytes) {
        byBookHandle.set(book.handle, Object.freeze({ state: "skipped", reason: "total-bytes" }));
        continue;
      }
      budgetedBytes += metadata.compressedSize;
      const bytes = await store.readObject(metadata.handle, {
        ...operationOptions,
        maxBytes: metadata.compressedSize,
      });
      if (bytes.byteLength !== metadata.compressedSize) {
        throw new Error("KFX metadata sidecar size changed during its bounded read.");
      }
      const parsed = parseKindleKfxMetadata(bytes, limits.parser);
      byBookHandle.set(book.handle, Object.freeze({
        state: "enriched",
        metadata: parsed,
        readBytes: bytes.byteLength,
        budgetedBytes: metadata.compressedSize,
      }));
    } catch (error) {
      if (isAbort(error, operationOptions.signal)) throw error;
      if (isFatalTransportFailure(error)) throw error;
      byBookHandle.set(book.handle, Object.freeze({ state: "failed" }));
    }
  }

  return Object.freeze({ byBookHandle });
}
