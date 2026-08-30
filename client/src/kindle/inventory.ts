import type {
  KindleObjectStore,
  KindleOperationOptions,
  KindleStoredObjectInfo,
  KindleTarget,
} from "./contracts";
import {
  parseKindleBookMetadata,
  type KindleBookMetadata,
} from "./book-metadata";
import type { PseudonymousKindleIdentity } from "./device-identity";
import { extractManagedFilenameToken } from "./filenames";
import { hasSufficientKindleObjectDistinguishability } from "./matching";
import type {
  KindleMetadataCache,
  KindleMetadataCacheEntry,
  KindleMetadataCacheEvidence,
  KindleMetadataCacheHit,
} from "./metadata-cache";

const UINT32_MAX = 0xffff_ffff;
const DEFAULT_MAX_OBJECTS = 10_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_FILENAME_LENGTH = 254;
const DEFAULT_MAX_PATH_LENGTH = 2_048;
const DEFAULT_MAX_ISSUES = 64;
const HARD_MAX_OBJECTS = 100_000;
const HARD_MAX_DEPTH = 128;
const HARD_MAX_PATH_LENGTH = 8_192;
const HARD_MAX_ISSUES = 256;
const OBJECT_FORMAT_ASSOCIATION = 0x3001;
// Default to the full supported household-scale enrichment envelope. The
// previous 128-object ceiling made every catalog absence globally unknown on
// otherwise ordinary larger Kindles. Reads remain sequential and bounded by
// the per-object, aggregate-byte, and hard object limits below.
const DEFAULT_MAX_METADATA_OBJECTS = 2_000;
const DEFAULT_MAX_METADATA_OBJECT_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_METADATA_TOTAL_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_METADATA_OBJECTS = 2_000;
const HARD_MAX_METADATA_OBJECT_BYTES = 200 * 1024 * 1024;
const HARD_MAX_METADATA_TOTAL_BYTES = 1024 * 1024 * 1024;
// At most eight local persistence transactions for the 2,000-object envelope,
// while retaining progress if a later Kindle read aborts the inventory.
const METADATA_CACHE_WRITE_BATCH_SIZE = 256;
const KINDLE_READABLE_BOOK_EXTENSIONS = new Set([
  "azw",
  "azw3",
  "azw8",
  "kfx",
  "mobi",
  "prc",
]);
// The current bounded parser understands PalmDB/MOBI metadata. Real KFX and
// AZW8 objects use a different container, so downloading the entire book would
// consume USB time only to fail parsing. They remain visible presence evidence
// and conservatively make metadata-based absence unknown.
const KINDLE_UNSUPPORTED_METADATA_EXTENSIONS = new Set(["azw8", "kfx"]);

export type KindleInventoryStatus = "complete" | "partial";

export type KindleInventoryIssueCode =
  | "handle-limit"
  | "depth-limit"
  | "duplicate-handle"
  | "invalid-handle"
  | "metadata-unavailable"
  | "metadata-inconsistent"
  | "metadata-sanitized"
  | "children-unavailable"
  | "transport-failure";

export interface KindleInventoryIssue {
  readonly code: KindleInventoryIssueCode;
  readonly operation: "list-children" | "read-metadata" | "validate-metadata";
  readonly handle?: number;
  readonly parentHandle?: number;
  readonly depth?: number;
  /** Bounded machine-readable code only; raw device/error text is excluded. */
  readonly detailCode?: string;
}

export interface KindleInventoryObject {
  readonly handle: number;
  readonly storageId: number;
  readonly parentHandle: number;
  readonly objectFormat: number;
  readonly protectionStatus: number;
  readonly associationType: number;
  readonly size: number;
  readonly filename: string;
  /** Display-only path relative to Documents. Never use it as deletion authority. */
  readonly relativePath: string;
  /** Validated canonical MTP timestamp used only as cache-change evidence. */
  readonly modificationDate?: string;
  readonly depth: number;
  readonly kind: "folder" | "file";
  readonly managedToken?: string;
  readonly metadataAdjusted: boolean;
  /** Parsed read-only book metadata. Present only after a successful bounded read. */
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly identifiers?: readonly string[];
  readonly language?: string;
  readonly bookMetadataState?: KindleInventoryObjectMetadataState;
}

export type KindleInventoryObjectMetadataState =
  | "enriched"
  | "empty"
  | "managed-token"
  | "failed"
  | "skipped-unsupported-format"
  | "skipped-object-size"
  | "skipped-object-count"
  | "skipped-total-bytes"
  | "skipped-transport";

export type KindleMetadataTruncationReason =
  | "unsupported-format"
  | "object-size"
  | "object-count"
  | "total-bytes"
  | "transport-failure";

export interface KindleInventoryMetadataSummary {
  readonly status: "disabled" | "complete" | "partial";
  readonly eligibleObjectCount: number;
  readonly attemptedObjectCount: number;
  readonly parsedObjectCount: number;
  readonly enrichedObjectCount: number;
  readonly failedObjectCount: number;
  readonly skippedObjectCount: number;
  /** Successfully parsed eligible objects lacking safe independent match evidence. */
  readonly indistinguishableObjectCount: number;
  /** Objects already carrying strong Kindle Bridge filename-token evidence. */
  readonly managedObjectCount?: number;
  /** Objects whose parsed fields were reused after a live path/size/time match. */
  readonly cacheHitObjectCount?: number;
  /** Successfully returned bytes. */
  readonly readByteCount: number;
  /** Sum of declared object sizes reserved against the total read budget. */
  readonly budgetedByteCount: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly KindleMetadataTruncationReason[];
}

export interface KindleInventorySnapshot {
  readonly status: KindleInventoryStatus;
  readonly storageId: number;
  readonly documentsHandle: number;
  readonly objects: readonly KindleInventoryObject[];
  readonly issues: readonly KindleInventoryIssue[];
  /** Includes issues omitted from the bounded `issues` array. */
  readonly issueCount: number;
  readonly scannedObjectCount: number;
  /** Separate from hierarchy `status`; metadata failures never prove a book absent. */
  readonly bookMetadata?: KindleInventoryMetadataSummary;
}

/**
 * Current-session object metadata captured by KindleDevice's collision scan.
 * Inventory still re-lists the live child handles and uses this seed only when
 * the handle set is unchanged, so stale or cross-session data cannot establish
 * a complete hierarchy by itself.
 */
export interface KindleInventoryFolderSeed {
  readonly parentHandle: number;
  readonly children: readonly KindleStoredObjectInfo[];
}

export interface KindleInventoryMetadataCacheContext {
  readonly cache: KindleMetadataCache;
  readonly identity: PseudonymousKindleIdentity;
}

export interface KindleInventoryMetadataOptions {
  readonly maxObjects?: number;
  readonly maxObjectBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface KindleInventoryOptions extends KindleOperationOptions {
  readonly maxObjects?: number;
  readonly maxDepth?: number;
  readonly maxFilenameLength?: number;
  readonly maxPathLength?: number;
  readonly maxIssues?: number;
  /** Enabled with conservative limits by default; `false` performs metadata-only hierarchy enumeration. */
  readonly bookMetadata?: false | KindleInventoryMetadataOptions;
}

interface ResolvedInventoryLimits {
  readonly maxObjects: number;
  readonly maxDepth: number;
  readonly maxFilenameLength: number;
  readonly maxPathLength: number;
  readonly maxIssues: number;
  readonly bookMetadata: false | ResolvedInventoryMetadataLimits;
}

interface ResolvedInventoryMetadataLimits {
  readonly maxObjects: number;
  readonly maxObjectBytes: number;
  readonly maxTotalBytes: number;
}

interface FolderWork {
  readonly handle: number;
  readonly relativePath: string;
  /** True when any parent path component had to be sanitized or truncated. */
  readonly metadataAdjusted: boolean;
  /** Documents is depth 0; its direct children are depth 1. */
  readonly depth: number;
}

interface BoundedText {
  readonly value: string;
  readonly adjusted: boolean;
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

function resolveLimits(options: KindleInventoryOptions): ResolvedInventoryLimits {
  const metadataOptions = options.bookMetadata === false ? false : options.bookMetadata ?? {};
  return {
    maxObjects: boundedInteger(options.maxObjects, DEFAULT_MAX_OBJECTS, 1, HARD_MAX_OBJECTS, "maxObjects"),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, HARD_MAX_DEPTH, "maxDepth"),
    maxFilenameLength: boundedInteger(
      options.maxFilenameLength,
      DEFAULT_MAX_FILENAME_LENGTH,
      16,
      DEFAULT_MAX_FILENAME_LENGTH,
      "maxFilenameLength",
    ),
    maxPathLength: boundedInteger(
      options.maxPathLength,
      DEFAULT_MAX_PATH_LENGTH,
      64,
      HARD_MAX_PATH_LENGTH,
      "maxPathLength",
    ),
    maxIssues: boundedInteger(options.maxIssues, DEFAULT_MAX_ISSUES, 1, HARD_MAX_ISSUES, "maxIssues"),
    bookMetadata: metadataOptions === false ? false : {
      maxObjects: boundedInteger(
        metadataOptions.maxObjects,
        DEFAULT_MAX_METADATA_OBJECTS,
        1,
        HARD_MAX_METADATA_OBJECTS,
        "bookMetadata.maxObjects",
      ),
      maxObjectBytes: boundedInteger(
        metadataOptions.maxObjectBytes,
        DEFAULT_MAX_METADATA_OBJECT_BYTES,
        1,
        HARD_MAX_METADATA_OBJECT_BYTES,
        "bookMetadata.maxObjectBytes",
      ),
      maxTotalBytes: boundedInteger(
        metadataOptions.maxTotalBytes,
        DEFAULT_MAX_METADATA_TOTAL_BYTES,
        1,
        HARD_MAX_METADATA_TOTAL_BYTES,
        "bookMetadata.maxTotalBytes",
      ),
    },
  };
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  if (typeof code !== "string" || !/^[A-Z0-9_]{1,64}$/u.test(code)) return undefined;
  return code;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return safeErrorCode(error) === "MTP_OPERATION_ABORTED";
}

function isTransportFailure(error: unknown): boolean {
  if (error && typeof error === "object" && Reflect.get(error, "fatal") === true) return true;
  const code = safeErrorCode(error);
  return code === "MTP_INVALID_STATE"
    || code === "MTP_TRANSPORT_ERROR"
    || code === "MTP_COMMAND_TIMEOUT"
    || code === "MTP_INACTIVITY_TIMEOUT"
    || code?.startsWith("USB_") === true;
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < UINT32_MAX;
}

function truncateWithoutSplittingSurrogate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const contentLength = Math.max(1, maxLength - 1);
  let end = contentLength;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}\u2026`;
}

function safeFilename(value: string, handle: number, maxLength: number): BoundedText {
  const replaced = value.replace(/[\u0000-\u001f\u007f/\\]/gu, "\ufffd");
  const nonEmpty = replaced.length > 0 ? replaced : `unnamed-${handle.toString(16).padStart(8, "0")}`;
  const bounded = truncateWithoutSplittingSurrogate(nonEmpty, maxLength);
  return {
    value: bounded,
    adjusted: bounded !== value,
  };
}

function safeRelativePath(parent: string, filename: string, maxLength: number): BoundedText {
  const joined = parent.length > 0 ? `${parent}/${filename}` : filename;
  if (joined.length <= maxLength) return { value: joined, adjusted: false };
  const tailLength = Math.max(1, maxLength - 1);
  return {
    value: `\u2026${joined.slice(-tailLength)}`,
    adjusted: true,
  };
}

const MTP_MODIFICATION_DATE_PATTERN = /^\d{8}T\d{6}(?:\.\d{1,9})?(?:Z|[+-]\d{4})?$/u;

function safeModificationDate(value: string): string | undefined {
  return MTP_MODIFICATION_DATE_PATTERN.test(value) ? value : undefined;
}

function metadataIsConsistent(
  info: KindleStoredObjectInfo,
  handle: number,
  storageId: number,
  parentHandle: number,
): boolean {
  return info.handle === handle
    && info.storageId === storageId
    && info.parentHandle === parentHandle
    && Number.isSafeInteger(info.compressedSize)
    && info.compressedSize >= 0;
}

/**
 * Recognizes bounded Kindle ebook containers by their final filename suffix.
 * This is presence evidence only: an extension never makes a match strong by
 * itself, and metadata parsing may still fail conservatively for a container.
 */
function kindleBookExtension(filename: string): string | undefined {
  const leaf = filename.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot === leaf.length - 1) return undefined;
  return leaf.slice(dot + 1).toLocaleLowerCase("en-US");
}

export function isKindleReadableBookFilename(filename: string): boolean {
  const extension = kindleBookExtension(filename);
  return extension !== undefined && KINDLE_READABLE_BOOK_EXTENSIONS.has(extension);
}

function hasSupportedEmbeddedMetadata(filename: string): boolean {
  const extension = kindleBookExtension(filename);
  return extension !== undefined && !KINDLE_UNSUPPORTED_METADATA_EXTENSIONS.has(extension);
}

function isEligibleBookObject(object: KindleInventoryObject): boolean {
  return object.kind === "file" && isKindleReadableBookFilename(object.filename);
}

/**
 * Kindle sidecar folders contain per-book assets rather than independent
 * library books. Keeping the folder in the snapshot preserves the observed
 * hierarchy, while pruning its descendants avoids treating files such as
 * `assets/metadata.kfx` as standalone books. Inspect the device-provided name
 * rather than its bounded display form so truncation cannot hide the suffix.
 */
function isKindleSidecarFolderFilename(filename: string): boolean {
  const leaf = filename.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  return leaf.toLocaleLowerCase("en-US").endsWith(".sdr");
}

interface MetadataCounters {
  attempted: number;
  parsed: number;
  enriched: number;
  failed: number;
  skipped: number;
  indistinguishable: number;
  managed: number;
  cached: number;
  readBytes: number;
  budgetedBytes: number;
}

function metadataSummary(
  enabled: boolean,
  eligibleObjectCount: number,
  counters: MetadataCounters,
  reasons: ReadonlySet<KindleMetadataTruncationReason>,
): KindleInventoryMetadataSummary {
  return Object.freeze({
    status: !enabled
      ? "disabled"
      : counters.failed === 0
          && counters.skipped === 0
          && counters.indistinguishable === 0
        ? "complete"
        : "partial",
    eligibleObjectCount,
    attemptedObjectCount: counters.attempted,
    parsedObjectCount: counters.parsed,
    enrichedObjectCount: counters.enriched,
    failedObjectCount: counters.failed,
    skippedObjectCount: counters.skipped,
    indistinguishableObjectCount: counters.indistinguishable,
    ...(counters.managed === 0 ? {} : { managedObjectCount: counters.managed }),
    ...(counters.cached === 0 ? {} : { cacheHitObjectCount: counters.cached }),
    readByteCount: counters.readBytes,
    budgetedByteCount: counters.budgetedBytes,
    truncated: reasons.size > 0,
    truncationReasons: Object.freeze([...reasons]),
  });
}

function hasParsedMetadata(metadata: KindleBookMetadata): boolean {
  return metadata.title !== undefined
    || metadata.authors.length > 0
    || metadata.identifiers.length > 0
    || metadata.language !== undefined;
}

function objectWithParsedMetadata(
  object: KindleInventoryObject,
  metadata: KindleBookMetadata,
): KindleInventoryObject {
  const hasMetadata = hasParsedMetadata(metadata);
  return Object.freeze({
    ...object,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    authors: metadata.authors,
    identifiers: metadata.identifiers,
    ...(metadata.language === undefined ? {} : { language: metadata.language }),
    bookMetadataState: hasMetadata ? "enriched" : "empty",
  } satisfies KindleInventoryObject);
}

function cacheEvidenceFor(
  object: KindleInventoryObject,
  context: KindleInventoryMetadataCacheContext | undefined,
): KindleMetadataCacheEvidence | undefined {
  if (
    !context
    || object.metadataAdjusted
    || object.modificationDate === undefined
    || object.relativePath.length === 0
  ) {
    return undefined;
  }
  return {
    identity: context.identity,
    storageId: object.storageId,
    relativePath: object.relativePath,
    metadataAdjusted: false,
    size: object.size,
    modificationDate: object.modificationDate,
  };
}

async function cachedMetadataHits(
  objects: readonly KindleInventoryObject[],
  maximum: number,
  context: KindleInventoryMetadataCacheContext | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<number, KindleMetadataCacheHit>> {
  if (!context) return new Map();
  const handles: number[] = [];
  const evidence: KindleMetadataCacheEvidence[] = [];
  for (const object of objects) {
    if (
      evidence.length >= maximum
      || !isEligibleBookObject(object)
      || !hasSupportedEmbeddedMetadata(object.filename)
      || (object.managedToken !== undefined && !object.metadataAdjusted)
    ) {
      continue;
    }
    const candidate = cacheEvidenceFor(object, context);
    if (!candidate) continue;
    handles.push(object.handle);
    evidence.push(candidate);
  }
  if (evidence.length === 0) return new Map();
  try {
    const hits = await context.cache.lookupMany(evidence);
    signal?.throwIfAborted();
    const byHandle = new Map<number, KindleMetadataCacheHit>();
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      if (hit?.authoritative === false) byHandle.set(handles[index]!, hit);
    }
    return byHandle;
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    // The cache is an optional acceleration only. Corrupt, unavailable, or
    // quota-blocked browser storage must fall back to live bounded reads.
    return new Map();
  }
}

async function enrichBookMetadata(
  store: KindleObjectStore,
  objects: readonly KindleInventoryObject[],
  limits: false | ResolvedInventoryMetadataLimits,
  operationOptions: KindleOperationOptions,
  signal: AbortSignal | undefined,
  cacheContext?: KindleInventoryMetadataCacheContext,
): Promise<{
  readonly objects: readonly KindleInventoryObject[];
  readonly summary: KindleInventoryMetadataSummary;
}> {
  const eligibleObjectCount = objects.filter(isEligibleBookObject).length;
  const counters: MetadataCounters = {
    attempted: 0,
    parsed: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    indistinguishable: 0,
    managed: 0,
    cached: 0,
    readBytes: 0,
    budgetedBytes: 0,
  };
  const reasons = new Set<KindleMetadataTruncationReason>();
  if (limits === false) {
    return {
      objects,
      summary: metadataSummary(false, eligibleObjectCount, counters, reasons),
    };
  }

  const cacheHits = await cachedMetadataHits(
    objects,
    limits.maxObjects,
    cacheContext,
    signal,
  );
  const cacheEntries: KindleMetadataCacheEntry[] = [];
  let cacheWritesEnabled = cacheContext !== undefined;
  const flushCacheEntries = async (force = false): Promise<void> => {
    if (
      !cacheWritesEnabled
      || cacheContext === undefined
      || cacheEntries.length === 0
      || (!force && cacheEntries.length < METADATA_CACHE_WRITE_BATCH_SIZE)
    ) {
      return;
    }
    signal?.throwIfAborted();
    const batch = cacheEntries.splice(0, METADATA_CACHE_WRITE_BATCH_SIZE);
    try {
      const accepted = await cacheContext.cache.rememberMany(batch);
      signal?.throwIfAborted();
      if (accepted !== batch.length) cacheWritesEnabled = false;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      // Disable writes for the remainder of this inventory. The cache is an
      // optional accelerator and must not repeatedly delay live device work.
      cacheWritesEnabled = false;
    }
  };
  const enrichedObjects: KindleInventoryObject[] = [];
  for (const object of objects) {
    if (!isEligibleBookObject(object)) {
      enrichedObjects.push(object);
      continue;
    }
    signal?.throwIfAborted();
    // A valid, unadjusted Kindle Bridge token already supplies stronger
    // source-version evidence than embedded title/author metadata. Avoid
    // downloading our own potentially large derivative merely to rediscover
    // weaker fields that cannot improve its match authority.
    if (object.managedToken !== undefined && !object.metadataAdjusted) {
      counters.managed += 1;
      enrichedObjects.push(Object.freeze({ ...object, bookMetadataState: "managed-token" }));
      continue;
    }

    const cacheHit = cacheHits.get(object.handle);
    if (cacheHit !== undefined) {
      counters.cached += 1;
      if (hasParsedMetadata(cacheHit.metadata)) counters.enriched += 1;
      const enrichedObject = objectWithParsedMetadata(object, cacheHit.metadata);
      if (!hasSufficientKindleObjectDistinguishability(enrichedObject)) {
        counters.indistinguishable += 1;
      }
      enrichedObjects.push(enrichedObject);
      continue;
    }

    if (!hasSupportedEmbeddedMetadata(object.filename)) {
      counters.skipped += 1;
      reasons.add("unsupported-format");
      enrichedObjects.push(Object.freeze({
        ...object,
        bookMetadataState: "skipped-unsupported-format",
      }));
      continue;
    }

    let skippedState: KindleInventoryObjectMetadataState | undefined;
    let skipReason: KindleMetadataTruncationReason | undefined;
    if (object.size > limits.maxObjectBytes) {
      skippedState = "skipped-object-size";
      skipReason = "object-size";
    } else if (counters.cached + counters.attempted >= limits.maxObjects) {
      skippedState = "skipped-object-count";
      skipReason = "object-count";
    } else if (object.size > limits.maxTotalBytes - counters.budgetedBytes) {
      skippedState = "skipped-total-bytes";
      skipReason = "total-bytes";
    }
    if (skippedState !== undefined && skipReason !== undefined) {
      counters.skipped += 1;
      reasons.add(skipReason);
      enrichedObjects.push(Object.freeze({ ...object, bookMetadataState: skippedState }));
      continue;
    }

    counters.attempted += 1;
    counters.budgetedBytes += object.size;
    try {
      const bytes = await store.readObject(object.handle, {
        ...operationOptions,
        maxBytes: object.size,
      });
      counters.readBytes += bytes.byteLength;
      const metadata = parseKindleBookMetadata(bytes, {
        maxInputBytes: limits.maxObjectBytes,
      });
      counters.parsed += 1;
      if (hasParsedMetadata(metadata)) counters.enriched += 1;
      const enrichedObject = objectWithParsedMetadata(object, metadata);
      if (!hasSufficientKindleObjectDistinguishability(enrichedObject)) {
        counters.indistinguishable += 1;
      }
      enrichedObjects.push(enrichedObject);
      const evidence = cacheEvidenceFor(object, cacheContext);
      if (cacheWritesEnabled && evidence !== undefined) {
        cacheEntries.push({ evidence, metadata });
        await flushCacheEntries();
      }
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      if (isTransportFailure(error)) throw error;
      counters.failed += 1;
      enrichedObjects.push(Object.freeze({ ...object, bookMetadataState: "failed" }));
    }
  }

  await flushCacheEntries(true);
  return {
    objects: Object.freeze(enrichedObjects),
    summary: metadataSummary(true, eligibleObjectCount, counters, reasons),
  };
}

/**
 * Recursively inventories descendants of Documents and, within independent
 * byte/count budgets, reads supported book objects for matching metadata. All
 * returned strings, paths, counts, and diagnostics are bounded. A partial
 * hierarchy result must never be interpreted as proof that a book is absent.
 */
export async function buildKindleInventory(
  store: KindleObjectStore,
  target: KindleTarget,
  options: KindleInventoryOptions = {},
  folderSeed?: KindleInventoryFolderSeed,
  cacheContext?: KindleInventoryMetadataCacheContext,
): Promise<KindleInventorySnapshot> {
  const limits = resolveLimits(options);
  const operationOptions: KindleOperationOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
  };
  const objects: KindleInventoryObject[] = [];
  const issues: KindleInventoryIssue[] = [];
  const seenHandles = new Set<number>([target.documentsHandle]);
  const queue: FolderWork[] = [{
    handle: target.documentsHandle,
    relativePath: "",
    metadataAdjusted: false,
    depth: 0,
  }];
  let issueCount = 0;
  let stopped = false;

  const addIssue = (issue: KindleInventoryIssue): void => {
    issueCount += 1;
    if (issues.length < limits.maxIssues) issues.push(Object.freeze({ ...issue }));
  };

  while (queue.length > 0 && !stopped) {
    options.signal?.throwIfAborted();
    const folder = queue.shift()!;
    if (folder.depth >= limits.maxDepth) {
      addIssue({
        code: "depth-limit",
        operation: "list-children",
        parentHandle: folder.handle,
        depth: folder.depth,
      });
      continue;
    }

    const remaining = limits.maxObjects - objects.length;
    if (remaining <= 0) {
      addIssue({ code: "handle-limit", operation: "list-children", parentHandle: folder.handle });
      break;
    }

    let childHandles: readonly number[];
    try {
      childHandles = await store.listObjectHandles(
        {
          storageId: target.storageId,
          associationHandle: folder.handle,
          maxHandles: remaining,
        },
        operationOptions,
      );
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      if (isTransportFailure(error)) throw error;
      const detailCode = safeErrorCode(error);
      addIssue({
        code: detailCode === "MTP_HANDLE_LIMIT_EXCEEDED"
          ? "handle-limit"
          : isTransportFailure(error) ? "transport-failure" : "children-unavailable",
        operation: "list-children",
        parentHandle: folder.handle,
        depth: folder.depth,
        ...(detailCode === undefined ? {} : { detailCode }),
      });
      continue;
    }

    let seededInfoByHandle: ReadonlyMap<number, KindleStoredObjectInfo> | undefined;
    if (folder.handle === folderSeed?.parentHandle) {
      const candidate = new Map<number, KindleStoredObjectInfo>();
      let valid = folderSeed.children.length === childHandles.length;
      for (const info of folderSeed.children) {
        if (candidate.has(info.handle)) {
          valid = false;
          break;
        }
        candidate.set(info.handle, info);
      }
      if (valid && childHandles.every((handle) => candidate.has(handle))) {
        seededInfoByHandle = candidate;
      }
    }

    for (const handle of childHandles) {
      if (objects.length >= limits.maxObjects) {
        addIssue({ code: "handle-limit", operation: "read-metadata", parentHandle: folder.handle });
        stopped = true;
        break;
      }
      if (!isUint32(handle)) {
        addIssue({ code: "invalid-handle", operation: "validate-metadata", parentHandle: folder.handle });
        continue;
      }
      if (seenHandles.has(handle)) {
        addIssue({
          code: "duplicate-handle",
          operation: "validate-metadata",
          handle,
          parentHandle: folder.handle,
        });
        continue;
      }
      seenHandles.add(handle);

      let info: KindleStoredObjectInfo;
      try {
        info = seededInfoByHandle?.get(handle)
          ?? await store.getObjectInfo(handle, operationOptions);
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        if (isTransportFailure(error)) throw error;
        const detailCode = safeErrorCode(error);
        addIssue({
          code: isTransportFailure(error) ? "transport-failure" : "metadata-unavailable",
          operation: "read-metadata",
          handle,
          parentHandle: folder.handle,
          ...(detailCode === undefined ? {} : { detailCode }),
        });
        continue;
      }

      if (!metadataIsConsistent(info, handle, target.storageId, folder.handle)) {
        addIssue({
          code: "metadata-inconsistent",
          operation: "validate-metadata",
          handle,
          parentHandle: folder.handle,
        });
        continue;
      }

      const filename = safeFilename(info.filename, handle, limits.maxFilenameLength);
      const path = safeRelativePath(folder.relativePath, filename.value, limits.maxPathLength);
      const locallyAdjusted = filename.adjusted || path.adjusted;
      const metadataAdjusted = folder.metadataAdjusted || locallyAdjusted;
      const modificationDate = safeModificationDate(info.modificationDate);
      if (locallyAdjusted) {
        addIssue({
          code: "metadata-sanitized",
          operation: "validate-metadata",
          handle,
          parentHandle: folder.handle,
        });
      }
      const kind = info.objectFormat === OBJECT_FORMAT_ASSOCIATION ? "folder" : "file";
      const managedToken = kind === "file" ? extractManagedFilenameToken(filename.value) : undefined;
      const object: KindleInventoryObject = Object.freeze({
        handle,
        storageId: info.storageId,
        parentHandle: info.parentHandle,
        objectFormat: info.objectFormat,
        protectionStatus: info.protectionStatus,
        associationType: info.associationType,
        size: info.compressedSize,
        filename: filename.value,
        relativePath: path.value,
        ...(modificationDate === undefined ? {} : { modificationDate }),
        depth: folder.depth + 1,
        kind,
        ...(managedToken === undefined ? {} : { managedToken }),
        metadataAdjusted,
      });
      objects.push(object);
      if (kind === "folder" && !isKindleSidecarFolderFilename(info.filename)) {
        queue.push({
          handle,
          relativePath: path.value,
          metadataAdjusted,
          depth: folder.depth + 1,
        });
      }
    }
  }

  const enrichment = await enrichBookMetadata(
    store,
    objects,
    limits.bookMetadata,
    operationOptions,
    options.signal,
    cacheContext,
  );
  return Object.freeze({
    status: issueCount === 0 ? "complete" : "partial",
    storageId: target.storageId,
    documentsHandle: target.documentsHandle,
    objects: enrichment.objects,
    issues: Object.freeze(issues.slice()),
    issueCount,
    scannedObjectCount: objects.length,
    bookMetadata: enrichment.summary,
  });
}
