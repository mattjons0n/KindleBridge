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
import type {
  KindleBridgeDeviceMetadataCache,
  KindleBridgeDeviceMetadataCacheEntry,
} from "./device-metadata-cache-codec";
import { extractManagedFilenameToken } from "./filenames";
import { hasSufficientKindleObjectDistinguishability } from "./matching";
import type {
  KindleMetadataCache,
  KindleMetadataCacheEntry,
  KindleMetadataCacheEvidence,
} from "./metadata-cache";
import {
  isCanonicalMtpModificationDate,
  type KindleModificationDateProbe,
  type KindleModificationDateProbeCandidate,
  type KindleModificationDateProbeSummary,
} from "./modification-date-diagnostics";
import { isFatalTransportFailure } from "../error-diagnostics";

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
  /** Portable hits read from a validated cache object on this Kindle. */
  readonly deviceCacheHitObjectCount?: number;
  /** Same-origin browser cache hits used after portable-cache misses. */
  readonly browserCacheHitObjectCount?: number;
  /** Successfully returned bytes. */
  readonly readByteCount: number;
  /** Sum of declared object sizes reserved against the total read budget. */
  readonly budgetedByteCount: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly KindleMetadataTruncationReason[];
}

export type KindleBrowserMetadataCacheLookupOutcome =
  | "disabled"
  | "not-needed"
  | "completed"
  | "failed";

export type KindleBrowserMetadataCacheWriteOutcome =
  | "disabled"
  | "no-candidates"
  | "accepted-all"
  | "accepted-partial"
  | "failed";

export type KindleDeviceMetadataCacheSlotLoadOutcome =
  | "disabled"
  | "absent"
  | "loaded"
  | "blocked"
  | "unavailable";

export type KindleDeviceMetadataCacheLoadOutcome =
  | "disabled"
  | "root-unavailable"
  | "none"
  | "loaded"
  | "blocked"
  | "generation-conflict";

export type KindleDeviceMetadataCacheWriteOutcome =
  | "not-requested"
  | "not-authorized"
  | "skipped-incomplete-inventory"
  | "skipped-metadata-disabled"
  | "skipped-cache-load-unavailable"
  | "unchanged"
  | "written"
  | "skipped-no-safe-slot"
  | "skipped-encode-failed"
  | "skipped-storage-unavailable"
  | "skipped-storage-read-only"
  | "skipped-insufficient-space"
  | "skipped-replacement-failed"
  | "skipped-root-name-conflict"
  | "skipped-root-capacity"
  | "skipped-root-unavailable"
  | "create-failed-cleaned";

export interface KindleInventoryDeviceMetadataCacheDiagnostics {
  readonly mode: "disabled" | "read-only" | "read-write";
  readonly loadOutcome: KindleDeviceMetadataCacheLoadOutcome;
  readonly rootHandleCount: number;
  readonly unreadableRootObjectCount: number;
  readonly slots: Readonly<Record<"a" | "b", {
    readonly outcome: KindleDeviceMetadataCacheSlotLoadOutcome;
    readonly entryCount: number;
  }>>;
  readonly activeEntryCount: number;
  readonly generationAmbiguous: boolean;
  readonly writeCandidateEntryCount: number;
  readonly writeOutcome: KindleDeviceMetadataCacheWriteOutcome;
  readonly writtenEntryCount: number;
  /** Encoded cache payload size; zero when encoding was not reached. */
  readonly cachePayloadByteCount: number;
  readonly writeSlot?: "a" | "b";
}

/**
 * Bounded cache telemetry plus explicit development timestamp evidence.
 * Exact modification-date values are intentionally included; paths, book
 * metadata, identities, and device handles remain outside the debug log.
 */
export interface KindleInventoryMetadataCacheDiagnostics {
  readonly evidence: {
    /** Supported, unmanaged Kindle-book objects considered for parsed metadata reuse. */
    readonly candidateObjectCount: number;
    readonly validModificationDateObjectCount: number;
    readonly unusableModificationDateObjectCount: number;
    readonly missingModificationDateObjectCount: number;
    readonly invalidModificationDateObjectCount: number;
    /** Exclusion counts can overlap; reusableEvidenceObjectCount passes every guard. */
    readonly metadataAdjustedObjectCount: number;
    readonly emptyPathObjectCount: number;
    readonly ambiguousPathObjectCount: number;
    readonly reusableEvidenceObjectCount: number;
  };
  readonly hits: {
    readonly deviceObjectCount: number;
    readonly browserObjectCount: number;
  };
  readonly portable: {
    readonly available: boolean;
    readonly candidateObjectCount: number;
    readonly pathMissObjectCount: number;
    readonly sizeMismatchObjectCount: number;
    readonly formatMismatchObjectCount: number;
    readonly modificationDateMismatchObjectCount: number;
    readonly metadataConflictObjectCount: number;
  };
  readonly browser: {
    readonly available: boolean;
    readonly lookupOutcome: KindleBrowserMetadataCacheLookupOutcome;
    readonly lookupCandidateObjectCount: number;
    readonly writeOutcome: KindleBrowserMetadataCacheWriteOutcome;
    readonly writeCandidateObjectCount: number;
    readonly writeAttemptedObjectCount: number;
    readonly writeAcceptedObjectCount: number;
  };
  readonly modificationDateProbe?: KindleModificationDateProbeSummary;
  readonly device?: KindleInventoryDeviceMetadataCacheDiagnostics;
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
  readonly metadataCacheDiagnostics?: KindleInventoryMetadataCacheDiagnostics;
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
  readonly modificationDateProbe?: KindleModificationDateProbe;
}

/** Strictly decoded cache files discovered on the selected Kindle storage. */
export interface KindleInventoryDeviceMetadataCacheContext {
  readonly caches: readonly KindleBridgeDeviceMetadataCache[];
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
  /**
   * Portable cache reads are enabled by default. A write request is honored
   * only after this KindleDevice instance has passed its exact-byte self-test.
   */
  readonly deviceMetadataCache?: false | "read-only" | "read-write";
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
  return isFatalTransportFailure(error);
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

function safeModificationDate(value: string): string | undefined {
  return isCanonicalMtpModificationDate(value) ? value : undefined;
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
  deviceCached: number;
  browserCached: number;
  browserWriteCandidates: number;
  browserWriteAttempts: number;
  browserWriteAccepted: number;
  browserWriteFailed: boolean;
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
    ...(counters.deviceCached === 0 ? {} : { deviceCacheHitObjectCount: counters.deviceCached }),
    ...(counters.browserCached === 0 ? {} : { browserCacheHitObjectCount: counters.browserCached }),
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
  livePathCounts: ReadonlyMap<string, number>,
): KindleMetadataCacheEvidence | undefined {
  if (
    !context
    || object.metadataAdjusted
    || object.modificationDate === undefined
    || object.relativePath.length === 0
    || livePathCounts.get(portablePathKey(object.relativePath)) !== 1
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

interface InventoryMetadataCacheHit {
  readonly provenance: "device-metadata-cache" | "browser-metadata-cache";
  readonly authoritative: false;
  readonly metadata: KindleBookMetadata;
}

interface CachedMetadataHitsResult {
  readonly hits: ReadonlyMap<number, InventoryMetadataCacheHit>;
  readonly portableDiagnostics: KindleInventoryMetadataCacheDiagnostics["portable"];
  readonly browserLookupOutcome: KindleBrowserMetadataCacheLookupOutcome;
  readonly browserLookupCandidateObjectCount: number;
}

function deviceCacheEvidenceKey(
  relativePath: string,
  objectFormat: number,
  size: number,
  modificationDate: string,
): string {
  return `${relativePath}\u0000${objectFormat.toString(10)}\u0000${size.toString(10)}\u0000${modificationDate}`;
}

function portablePathKey(relativePath: string): string {
  return relativePath.toLocaleLowerCase("en-US");
}

function liveCachePathCounts(
  objects: readonly KindleInventoryObject[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const object of objects) {
    if (object.kind !== "file" || object.metadataAdjusted || object.relativePath.length === 0) continue;
    const key = portablePathKey(object.relativePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isMetadataCacheDiagnosticCandidate(object: KindleInventoryObject): boolean {
  return isEligibleBookObject(object)
    && hasSupportedEmbeddedMetadata(object.filename)
    && (object.managedToken === undefined || object.metadataAdjusted);
}

function cacheEvidenceDiagnostics(
  objects: readonly KindleInventoryObject[],
  livePathCounts: ReadonlyMap<string, number>,
  modificationDates: {
    readonly missingObjectCount: number;
    readonly invalidObjectCount: number;
  },
): KindleInventoryMetadataCacheDiagnostics["evidence"] {
  let candidateObjectCount = 0;
  let validModificationDateObjectCount = 0;
  let unusableModificationDateObjectCount = 0;
  let metadataAdjustedObjectCount = 0;
  let emptyPathObjectCount = 0;
  let ambiguousPathObjectCount = 0;
  let reusableEvidenceObjectCount = 0;
  for (const object of objects) {
    if (!isMetadataCacheDiagnosticCandidate(object)) continue;
    candidateObjectCount += 1;
    if (object.modificationDate === undefined) unusableModificationDateObjectCount += 1;
    else validModificationDateObjectCount += 1;
    if (object.metadataAdjusted) metadataAdjustedObjectCount += 1;
    if (object.relativePath.length === 0) emptyPathObjectCount += 1;
    const uniquePath = object.relativePath.length > 0
      && livePathCounts.get(portablePathKey(object.relativePath)) === 1;
    if (!object.metadataAdjusted && object.relativePath.length > 0 && !uniquePath) {
      ambiguousPathObjectCount += 1;
    }
    if (
      !object.metadataAdjusted
      && object.modificationDate !== undefined
      && uniquePath
    ) {
      reusableEvidenceObjectCount += 1;
    }
  }
  return Object.freeze({
    candidateObjectCount,
    validModificationDateObjectCount,
    unusableModificationDateObjectCount,
    missingModificationDateObjectCount: modificationDates.missingObjectCount,
    invalidModificationDateObjectCount: modificationDates.invalidObjectCount,
    metadataAdjustedObjectCount,
    emptyPathObjectCount,
    ambiguousPathObjectCount,
    reusableEvidenceObjectCount,
  });
}

function equalBookMetadata(left: KindleBookMetadata, right: KindleBookMetadata): boolean {
  return left.title === right.title
    && left.language === right.language
    && left.authors.length === right.authors.length
    && left.authors.every((value, index) => value === right.authors[index])
    && left.identifiers.length === right.identifiers.length
    && left.identifiers.every((value, index) => value === right.identifiers[index]);
}

interface PortableMetadataHitsResult {
  readonly hits: ReadonlyMap<number, InventoryMetadataCacheHit>;
  readonly diagnostics: KindleInventoryMetadataCacheDiagnostics["portable"];
}

function portableMetadataHits(
  objects: readonly KindleInventoryObject[],
  maximum: number,
  context: KindleInventoryDeviceMetadataCacheContext | undefined,
  livePathCounts: ReadonlyMap<string, number>,
): PortableMetadataHitsResult {
  if (!context || context.caches.length === 0) {
    return Object.freeze({
      hits: new Map(),
      diagnostics: Object.freeze({
        available: false,
        candidateObjectCount: 0,
        pathMissObjectCount: 0,
        sizeMismatchObjectCount: 0,
        formatMismatchObjectCount: 0,
        modificationDateMismatchObjectCount: 0,
        metadataConflictObjectCount: 0,
      }),
    });
  }
  const entries = new Map<string, KindleBridgeDeviceMetadataCacheEntry | null>();
  const entriesByPath = new Map<string, KindleBridgeDeviceMetadataCacheEntry[]>();
  for (const cache of context.caches) {
    for (const entry of cache.entries) {
      const pathEntries = entriesByPath.get(entry.relativePath) ?? [];
      pathEntries.push(entry);
      entriesByPath.set(entry.relativePath, pathEntries);
      const key = deviceCacheEvidenceKey(
        entry.relativePath,
        entry.objectFormat,
        entry.size,
        entry.modificationDate,
      );
      const existing = entries.get(key);
      if (existing === undefined) entries.set(key, entry);
      else if (existing !== null && !equalBookMetadata(existing.metadata, entry.metadata)) {
        // Conflicting valid generations with identical live evidence are
        // ambiguous. Re-read the book rather than choosing either value.
        entries.set(key, null);
      }
    }
  }

  const hits = new Map<number, InventoryMetadataCacheHit>();
  let candidateObjectCount = 0;
  let pathMissObjectCount = 0;
  let sizeMismatchObjectCount = 0;
  let formatMismatchObjectCount = 0;
  let modificationDateMismatchObjectCount = 0;
  let metadataConflictObjectCount = 0;
  for (const object of objects) {
    if (
      hits.size >= maximum
      || !isEligibleBookObject(object)
      || !hasSupportedEmbeddedMetadata(object.filename)
      || (object.managedToken !== undefined && !object.metadataAdjusted)
      || object.metadataAdjusted
      || object.modificationDate === undefined
      || object.relativePath.length === 0
      || livePathCounts.get(portablePathKey(object.relativePath)) !== 1
    ) {
      continue;
    }
    candidateObjectCount += 1;
    const pathEntries = entriesByPath.get(object.relativePath) ?? [];
    if (pathEntries.length === 0) {
      pathMissObjectCount += 1;
      continue;
    }
    const sizeEntries = pathEntries.filter((entry) => entry.size === object.size);
    if (sizeEntries.length === 0) {
      sizeMismatchObjectCount += 1;
      continue;
    }
    const formatEntries = sizeEntries.filter((entry) => entry.objectFormat === object.objectFormat);
    if (formatEntries.length === 0) {
      formatMismatchObjectCount += 1;
      continue;
    }
    const modificationDateEntries = formatEntries.filter((entry) => (
      entry.modificationDate === object.modificationDate
    ));
    if (modificationDateEntries.length === 0) {
      modificationDateMismatchObjectCount += 1;
      continue;
    }
    const entry = entries.get(deviceCacheEvidenceKey(
      object.relativePath,
      object.objectFormat,
      object.size,
      object.modificationDate,
    ));
    if (entry === null) {
      metadataConflictObjectCount += 1;
      continue;
    }
    if (entry === undefined) continue;
    hits.set(object.handle, Object.freeze({
      provenance: "device-metadata-cache",
      authoritative: false,
      metadata: entry.metadata,
    }));
  }
  return Object.freeze({
    hits,
    diagnostics: Object.freeze({
      available: true,
      candidateObjectCount,
      pathMissObjectCount,
      sizeMismatchObjectCount,
      formatMismatchObjectCount,
      modificationDateMismatchObjectCount,
      metadataConflictObjectCount,
    }),
  });
}

async function cachedMetadataHits(
  objects: readonly KindleInventoryObject[],
  maximum: number,
  context: KindleInventoryMetadataCacheContext | undefined,
  deviceContext: KindleInventoryDeviceMetadataCacheContext | undefined,
  livePathCounts: ReadonlyMap<string, number>,
  signal: AbortSignal | undefined,
): Promise<CachedMetadataHitsResult> {
  const portable = portableMetadataHits(
    objects,
    maximum,
    deviceContext,
    livePathCounts,
  );
  const byHandle = new Map(portable.hits);
  if (!context) {
    return Object.freeze({
      hits: byHandle,
      portableDiagnostics: portable.diagnostics,
      browserLookupOutcome: "disabled",
      browserLookupCandidateObjectCount: 0,
    });
  }
  if (byHandle.size >= maximum) {
    return Object.freeze({
      hits: byHandle,
      portableDiagnostics: portable.diagnostics,
      browserLookupOutcome: "not-needed",
      browserLookupCandidateObjectCount: 0,
    });
  }
  const handles: number[] = [];
  const evidence: KindleMetadataCacheEvidence[] = [];
  for (const object of objects) {
    if (
      byHandle.size + evidence.length >= maximum
      || byHandle.has(object.handle)
      || !isEligibleBookObject(object)
      || !hasSupportedEmbeddedMetadata(object.filename)
      || (object.managedToken !== undefined && !object.metadataAdjusted)
    ) {
      continue;
    }
    const candidate = cacheEvidenceFor(object, context, livePathCounts);
    if (!candidate) continue;
    handles.push(object.handle);
    evidence.push(candidate);
  }
  if (evidence.length === 0) {
    return Object.freeze({
      hits: byHandle,
      portableDiagnostics: portable.diagnostics,
      browserLookupOutcome: "not-needed",
      browserLookupCandidateObjectCount: 0,
    });
  }
  try {
    const hits = await context.cache.lookupMany(evidence);
    signal?.throwIfAborted();
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      if (hit?.authoritative === false) byHandle.set(handles[index]!, hit);
    }
    return Object.freeze({
      hits: byHandle,
      portableDiagnostics: portable.diagnostics,
      browserLookupOutcome: "completed",
      browserLookupCandidateObjectCount: evidence.length,
    });
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    // The cache is an optional acceleration only. Corrupt, unavailable, or
    // quota-blocked browser storage must fall back to live bounded reads.
    return Object.freeze({
      hits: byHandle,
      portableDiagnostics: portable.diagnostics,
      browserLookupOutcome: "failed",
      browserLookupCandidateObjectCount: evidence.length,
    });
  }
}

async function enrichBookMetadata(
  store: KindleObjectStore,
  objects: readonly KindleInventoryObject[],
  limits: false | ResolvedInventoryMetadataLimits,
  operationOptions: KindleOperationOptions,
  signal: AbortSignal | undefined,
  cacheContext?: KindleInventoryMetadataCacheContext,
  deviceCacheContext?: KindleInventoryDeviceMetadataCacheContext,
  modificationDates: {
    readonly missingObjectCount: number;
    readonly invalidObjectCount: number;
  } = { missingObjectCount: 0, invalidObjectCount: 0 },
  modificationDateProbe?: KindleModificationDateProbeSummary,
): Promise<{
  readonly objects: readonly KindleInventoryObject[];
  readonly summary: KindleInventoryMetadataSummary;
  readonly cacheDiagnostics: KindleInventoryMetadataCacheDiagnostics;
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
    deviceCached: 0,
    browserCached: 0,
    browserWriteCandidates: 0,
    browserWriteAttempts: 0,
    browserWriteAccepted: 0,
    browserWriteFailed: false,
    readBytes: 0,
    budgetedBytes: 0,
  };
  const reasons = new Set<KindleMetadataTruncationReason>();
  const livePathCounts = liveCachePathCounts(objects);
  const evidenceDiagnostics = cacheEvidenceDiagnostics(
    objects,
    livePathCounts,
    modificationDates,
  );
  if (limits === false) {
    return {
      objects,
      summary: metadataSummary(false, eligibleObjectCount, counters, reasons),
      cacheDiagnostics: Object.freeze({
        evidence: evidenceDiagnostics,
        hits: Object.freeze({ deviceObjectCount: 0, browserObjectCount: 0 }),
        portable: Object.freeze({
          available: deviceCacheContext !== undefined
            && deviceCacheContext.caches.length > 0,
          candidateObjectCount: 0,
          pathMissObjectCount: 0,
          sizeMismatchObjectCount: 0,
          formatMismatchObjectCount: 0,
          modificationDateMismatchObjectCount: 0,
          metadataConflictObjectCount: 0,
        }),
        browser: Object.freeze({
          available: cacheContext !== undefined,
          lookupOutcome: cacheContext === undefined ? "disabled" : "not-needed",
          lookupCandidateObjectCount: 0,
          writeOutcome: cacheContext === undefined ? "disabled" : "no-candidates",
          writeCandidateObjectCount: 0,
          writeAttemptedObjectCount: 0,
          writeAcceptedObjectCount: 0,
        }),
        ...(modificationDateProbe === undefined ? {} : { modificationDateProbe }),
      }),
    };
  }

  const cacheLookup = await cachedMetadataHits(
    objects,
    limits.maxObjects,
    cacheContext,
    deviceCacheContext,
    livePathCounts,
    signal,
  );
  const cacheHits = cacheLookup.hits;
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
    counters.browserWriteAttempts += batch.length;
    try {
      const accepted = await cacheContext.cache.rememberMany(batch);
      signal?.throwIfAborted();
      counters.browserWriteAccepted += accepted;
      if (accepted !== batch.length) cacheWritesEnabled = false;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      // Disable writes for the remainder of this inventory. The cache is an
      // optional accelerator and must not repeatedly delay live device work.
      counters.browserWriteFailed = true;
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
      if (cacheHit.provenance === "device-metadata-cache") counters.deviceCached += 1;
      else counters.browserCached += 1;
      if (hasParsedMetadata(cacheHit.metadata)) counters.enriched += 1;
      const enrichedObject = objectWithParsedMetadata(object, cacheHit.metadata);
      if (!hasSufficientKindleObjectDistinguishability(enrichedObject)) {
        counters.indistinguishable += 1;
      }
      enrichedObjects.push(enrichedObject);
      if (cacheHit.provenance === "device-metadata-cache") {
        const evidence = cacheEvidenceFor(object, cacheContext, livePathCounts);
        if (evidence !== undefined) {
          counters.browserWriteCandidates += 1;
          if (cacheWritesEnabled) {
            cacheEntries.push({ evidence, metadata: cacheHit.metadata });
            await flushCacheEntries();
          }
        }
      }
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
      const evidence = cacheEvidenceFor(object, cacheContext, livePathCounts);
      if (evidence !== undefined) {
        counters.browserWriteCandidates += 1;
        if (cacheWritesEnabled) {
          cacheEntries.push({ evidence, metadata });
          await flushCacheEntries();
        }
      }
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      if (isTransportFailure(error)) throw error;
      counters.failed += 1;
      enrichedObjects.push(Object.freeze({ ...object, bookMetadataState: "failed" }));
    }
  }

  await flushCacheEntries(true);
  const browserWriteOutcome: KindleBrowserMetadataCacheWriteOutcome = cacheContext === undefined
    ? "disabled"
    : counters.browserWriteCandidates === 0
      ? "no-candidates"
      : counters.browserWriteFailed
        ? "failed"
        : counters.browserWriteAccepted === counters.browserWriteAttempts
          && counters.browserWriteAttempts === counters.browserWriteCandidates
          ? "accepted-all"
          : "accepted-partial";
  return {
    objects: Object.freeze(enrichedObjects),
    summary: metadataSummary(true, eligibleObjectCount, counters, reasons),
    cacheDiagnostics: Object.freeze({
      evidence: evidenceDiagnostics,
      hits: Object.freeze({
        deviceObjectCount: counters.deviceCached,
        browserObjectCount: counters.browserCached,
      }),
      portable: cacheLookup.portableDiagnostics,
      browser: Object.freeze({
        available: cacheContext !== undefined,
        lookupOutcome: cacheLookup.browserLookupOutcome,
        lookupCandidateObjectCount: cacheLookup.browserLookupCandidateObjectCount,
        writeOutcome: browserWriteOutcome,
        writeCandidateObjectCount: counters.browserWriteCandidates,
        writeAttemptedObjectCount: counters.browserWriteAttempts,
        writeAcceptedObjectCount: counters.browserWriteAccepted,
      }),
      ...(modificationDateProbe === undefined ? {} : { modificationDateProbe }),
    }),
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
  deviceCacheContext?: KindleInventoryDeviceMetadataCacheContext,
): Promise<KindleInventorySnapshot> {
  const limits = resolveLimits(options);
  const operationOptions: KindleOperationOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
  };
  const objects: KindleInventoryObject[] = [];
  const issues: KindleInventoryIssue[] = [];
  let missingModificationDateObjectCount = 0;
  let invalidModificationDateObjectCount = 0;
  const modificationDateProbeCandidates: KindleModificationDateProbeCandidate[] = [];
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
      if (isMetadataCacheDiagnosticCandidate(object) && modificationDate === undefined) {
        if (info.modificationDate.length === 0) missingModificationDateObjectCount += 1;
        else invalidModificationDateObjectCount += 1;
      }
      if (isMetadataCacheDiagnosticCandidate(object)) {
        modificationDateProbeCandidates.push({
          relativePath: object.relativePath,
          objectFormat: object.objectFormat,
          size: object.size,
          metadataAdjusted: object.metadataAdjusted,
          uniquePath: false,
          rawModificationDate: info.modificationDate,
        });
      }
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

  const probePathCounts = liveCachePathCounts(objects);
  const modificationDateProbe = cacheContext?.modificationDateProbe?.observe({
    deviceKey: cacheContext.identity.key,
    storageId: target.storageId,
    candidates: modificationDateProbeCandidates.map((candidate) => Object.freeze({
      ...candidate,
      uniquePath: candidate.relativePath.length > 0
        && probePathCounts.get(portablePathKey(candidate.relativePath)) === 1,
    })),
  });

  const enrichment = await enrichBookMetadata(
    store,
    objects,
    limits.bookMetadata,
    operationOptions,
    options.signal,
    cacheContext,
    deviceCacheContext,
    {
      missingObjectCount: missingModificationDateObjectCount,
      invalidObjectCount: invalidModificationDateObjectCount,
    },
    modificationDateProbe,
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
    metadataCacheDiagnostics: enrichment.cacheDiagnostics,
  });
}
