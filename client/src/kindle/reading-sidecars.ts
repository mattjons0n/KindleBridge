import { isFatalTransportFailure } from "../error-diagnostics";
import { parseRecordedKindleReadingFile, type KindleRecordedReadingFile } from "./recorded-reading-data";
import type { KindleObjectStore, KindleOperationOptions, KindleStoredObjectInfo } from "./contracts";
import type { KindleInventoryObject } from "./inventory";
import {
  findExactKindleSiblingSidecar,
  listExactKindleSidecarChildren,
} from "./kfx-sidecar";
import {
  parseKindleKrdsReadingEvidence,
  type KindleKrdsReadingParserOptions,
} from "./krds-reading-state";
import {
  validateKindleReadingEvidence,
  type KindleReadingEvidence,
  type KindleReadingSidecarFormat,
} from "./reading-state";

const OBJECT_FORMAT_ASSOCIATION = 0x3001;
const DEFAULT_MAX_BOOKS = 2_000;
const DEFAULT_MAX_SIDECAR_OBJECTS = 4_000;
const DEFAULT_MAX_CHILD_OBJECTS = 32;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HARD_MAX_BOOKS = 10_000;
const HARD_MAX_SIDECAR_OBJECTS = 20_000;
const HARD_MAX_CHILD_OBJECTS = 256;
const HARD_MAX_DEPTH = 1;
const HARD_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const BOOK_SIDECAR_FORMATS = new Map<string, ReadonlySet<KindleReadingSidecarFormat>>([
  ["azw3", new Set(["azw3f", "azw3r"])],
  ["azw8", new Set(["yjf", "yjr"])],
  ["kfx", new Set(["yjf", "yjr"])],
  ["azw", new Set(["mbs", "mbp1"])],
  ["mobi", new Set(["mbs", "mbp1"])],
  ["prc", new Set(["mbs", "mbp1"])],
]);
const SUPPORTED_BOOK_EXTENSIONS = new Set(BOOK_SIDECAR_FORMATS.keys());
const PROVENANCE_ORDER: readonly KindleReadingSidecarFormat[] = Object.freeze([
  "azw3f", "yjf", "mbs", "azw3r", "yjr", "mbp1",
]);
const ALL_SIDECAR_FORMATS = new Set<KindleReadingSidecarFormat>(PROVENANCE_ORDER);

export interface KindleReadingSidecarOptions {
  /** Read-only observations for the details drawer; never creates semantic reading evidence. */
  readonly recordedOnly?: boolean;
  /** Optional narrower format gate so physical acceptance can happen format by format. */
  readonly formats?: readonly KindleReadingSidecarFormat[];
  readonly maxBooks?: number;
  readonly maxSidecarObjects?: number;
  readonly maxChildObjects?: number;
  /** Direct `.sdr` children only until a deeper path is physically documented. */
  readonly maxDepth?: number;
  readonly maxObjectBytes?: number;
  readonly maxTotalBytes?: number;
  readonly parser?: KindleKrdsReadingParserOptions;
}

export interface KindleReadingSidecarResult {
  readonly evidenceByBookHandle: ReadonlyMap<number, KindleReadingEvidence>;
  readonly recordedByBookHandle: ReadonlyMap<number, readonly KindleRecordedReadingFile[]>;
}

interface ResolvedLimits {
  readonly maxBooks: number;
  readonly maxSidecarObjects: number;
  readonly maxChildObjects: number;
  readonly maxDepth: number;
  readonly maxObjectBytes: number;
  readonly maxTotalBytes: number;
  readonly parser: KindleKrdsReadingParserOptions;
  readonly formats: ReadonlySet<KindleReadingSidecarFormat>;
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

function resolveLimits(options: KindleReadingSidecarOptions): ResolvedLimits {
  const maxObjectBytes = boundedInteger(
    options.maxObjectBytes,
    DEFAULT_MAX_OBJECT_BYTES,
    1,
    HARD_MAX_OBJECT_BYTES,
    "readingSidecars.maxObjectBytes",
  );
  const formats = options.formats ?? PROVENANCE_ORDER;
  if (formats.length > ALL_SIDECAR_FORMATS.size || formats.some((format) => !ALL_SIDECAR_FORMATS.has(format))) {
    throw new RangeError("readingSidecars.formats contains an unsupported or duplicate format");
  }
  const uniqueFormats = new Set(formats);
  if (uniqueFormats.size !== formats.length) {
    throw new RangeError("readingSidecars.formats contains an unsupported or duplicate format");
  }
  return {
    maxBooks: boundedInteger(options.maxBooks, DEFAULT_MAX_BOOKS, 1, HARD_MAX_BOOKS, "readingSidecars.maxBooks"),
    maxSidecarObjects: boundedInteger(
      options.maxSidecarObjects,
      DEFAULT_MAX_SIDECAR_OBJECTS,
      1,
      HARD_MAX_SIDECAR_OBJECTS,
      "readingSidecars.maxSidecarObjects",
    ),
    maxChildObjects: boundedInteger(
      options.maxChildObjects,
      DEFAULT_MAX_CHILD_OBJECTS,
      1,
      HARD_MAX_CHILD_OBJECTS,
      "readingSidecars.maxChildObjects",
    ),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, HARD_MAX_DEPTH, "readingSidecars.maxDepth"),
    maxObjectBytes,
    maxTotalBytes: boundedInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      1,
      HARD_MAX_TOTAL_BYTES,
      "readingSidecars.maxTotalBytes",
    ),
    parser: Object.freeze({
      ...(options.parser ?? {}),
      maxInputBytes: Math.min(options.parser?.maxInputBytes ?? maxObjectBytes, maxObjectBytes),
    }),
    formats: uniqueFormats,
  };
}

function leafExtension(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLocaleLowerCase("en-US");
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "MTP_OPERATION_ABORTED";
}

function candidatesFor(
  children: readonly KindleStoredObjectInfo[],
  formats: ReadonlySet<KindleReadingSidecarFormat>,
): readonly { readonly info: KindleStoredObjectInfo; readonly format: KindleReadingSidecarFormat }[] | undefined {
  const candidates: Array<{ readonly info: KindleStoredObjectInfo; readonly format: KindleReadingSidecarFormat }> = [];
  const seen = new Set<KindleReadingSidecarFormat>();
  for (const info of children) {
    const extension = leafExtension(info.filename) as KindleReadingSidecarFormat | undefined;
    if (
      extension === undefined
      || !formats.has(extension)
      || info.objectFormat === OBJECT_FORMAT_ASSOCIATION
      || info.associationType !== 0
    ) {
      continue;
    }
    if (seen.has(extension)) return undefined;
    seen.add(extension);
    candidates.push(Object.freeze({ info, format: extension }));
  }
  candidates.sort((left, right) => PROVENANCE_ORDER.indexOf(left.format) - PROVENANCE_ORDER.indexOf(right.format));
  return Object.freeze(candidates);
}

function combineEvidence(evidence: readonly KindleReadingEvidence[]): KindleReadingEvidence | undefined {
  if (evidence.length === 0) return undefined;
  const progress = new Set(evidence.flatMap((item) => (
    item.progressPercent === undefined ? [] : [item.progressPercent]
  )));
  if (progress.size > 1) return undefined;
  const progressPercent = progress.values().next().value as number | undefined;
  const timestamps = evidence.flatMap((item) => (
    item.lastReadAt === undefined ? [] : [Date.parse(item.lastReadAt)]
  ));
  const lastReadAt = timestamps.length === 0
    ? undefined
    : new Date(Math.max(...timestamps)).toISOString();
  const provenance = evidence.find((item) => item.progressPercent !== undefined)?.provenance
    ?? evidence[0]!.provenance;
  return validateKindleReadingEvidence({
    status: progressPercent !== undefined && progressPercent > 0 ? "in-progress" : "unknown",
    ...(progressPercent === undefined ? {} : { progressPercent }),
    ...(lastReadAt === undefined ? {} : { lastReadAt }),
    provenance,
    freshness: "live",
    explicitState: false,
  });
}

/**
 * Reads only documented direct KRDS children of an exact current-inventory
 * `<book stem>.sdr`. No sidecar content, path, or history leaves the browser.
 */
export async function readKindleReadingSidecars(
  store: KindleObjectStore,
  objects: readonly KindleInventoryObject[],
  options: KindleReadingSidecarOptions,
  operationOptions: KindleOperationOptions = {},
): Promise<KindleReadingSidecarResult> {
  const limits = resolveLimits(options);
  const evidenceByBookHandle = new Map<number, KindleReadingEvidence>();
  const recordedByBookHandle = new Map<number, readonly KindleRecordedReadingFile[]>();
  let inspectedBooks = 0;
  let sidecarObjects = 0;
  let totalBytes = 0;

  for (const book of objects) {
    const bookExtension = book.kind === "file" ? leafExtension(book.filename) : undefined;
    const bookFormats = bookExtension === undefined ? undefined : BOOK_SIDECAR_FORMATS.get(bookExtension);
    if (bookFormats === undefined) continue;
    const formats = new Set([...bookFormats].filter((format) => limits.formats.has(format)));
    if (formats.size === 0) continue;
    const sidecar = findExactKindleSiblingSidecar(objects, book, SUPPORTED_BOOK_EXTENSIONS);
    if (sidecar === undefined) continue;
    operationOptions.signal?.throwIfAborted();
    if (inspectedBooks >= limits.maxBooks) continue;
    inspectedBooks += 1;

    try {
      // The only physically documented KRDS location is one direct child of
      // the exact book's `.sdr`; the depth option is deliberately hard-capped
      // at one so `assets` and unrelated nested folders are never traversed.
      if (limits.maxDepth !== 1) throw new Error("Unsupported reading-sidecar depth.");
      const children = await listExactKindleSidecarChildren(
        store,
        book.storageId,
        sidecar.handle,
        limits.maxChildObjects,
        operationOptions,
      );
      const candidates = candidatesFor(children, formats);
      if (candidates === undefined || candidates.length === 0) continue;
      if (candidates.length > limits.maxSidecarObjects - sidecarObjects) continue;
      let bookBytes = 0;
      let acceptable = true;
      for (const { info } of candidates) {
        if (info.compressedSize < 1 || info.compressedSize > limits.maxObjectBytes) {
          acceptable = false;
          break;
        }
        if (info.compressedSize > limits.maxTotalBytes - totalBytes - bookBytes) {
          acceptable = false;
          break;
        }
        bookBytes += info.compressedSize;
      }
      if (!acceptable) continue;
      sidecarObjects += candidates.length;
      totalBytes += bookBytes;

      const parsed: KindleReadingEvidence[] = [];
      const recorded: KindleRecordedReadingFile[] = [];
      for (const { info, format } of candidates) {
        if (options.recordedOnly) {
          try {
            const before = await store.getObjectInfo(info.handle, operationOptions);
            if (JSON.stringify(before) !== JSON.stringify(info)) throw new Error("Sidecar changed before reading");
            const bytes = await store.readObject(info.handle, { ...operationOptions, maxBytes: info.compressedSize });
            if (bytes.byteLength !== info.compressedSize) throw new Error("Sidecar size changed while reading");
            const after = await store.getObjectInfo(info.handle, operationOptions);
            if (JSON.stringify(after) !== JSON.stringify(info)) throw new Error("Sidecar changed during reading");
            recorded.push(parseRecordedKindleReadingFile(bytes, `${sidecar.relativePath}/${info.filename}`, limits.parser));
          } catch (error) {
            if (isAbort(error, operationOptions.signal) || isFatalTransportFailure(error)) throw error;
            recorded.push({ filename: `${sidecar.relativePath}/${info.filename}`, size: info.compressedSize, fields: [],
              error: error instanceof Error ? error.message.slice(0, 512) : "Could not decode this sidecar" });
          }
          continue;
        }
        const bytes = await store.readObject(info.handle, {
          ...operationOptions,
          maxBytes: info.compressedSize,
        });
        if (bytes.byteLength !== info.compressedSize) {
          throw new Error("KRDS sidecar size changed during its bounded read.");
        }
        parsed.push(parseKindleKrdsReadingEvidence(bytes, format, limits.parser));
      }
      const combined = combineEvidence(parsed);
      if (combined !== undefined) evidenceByBookHandle.set(book.handle, combined);
      if (recorded.length) recordedByBookHandle.set(book.handle, Object.freeze(recorded));
    } catch (error) {
      if (isAbort(error, operationOptions.signal)) throw error;
      if (isFatalTransportFailure(error)) throw error;
      // Malformed, ambiguous, or drifted data intentionally becomes absence
      // of evidence, which the browser model renders as unknown—not unread.
    }
  }

  return Object.freeze({ evidenceByBookHandle, recordedByBookHandle });
}
