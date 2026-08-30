import type { KindleBookMetadata } from "./book-metadata";
import { isCacheableKindleModificationDate } from "./modification-date-diagnostics";

/**
 * Reserved only for Kindle Bridge-owned cache objects. Future codec versions
 * can use the same namespace without being mistaken for a household ebook.
 */
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE =
  ".kindle-bridge-device-metadata-cache-";
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC =
  "KINDLE-BRIDGE-DEVICE-METADATA-CACHE";
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION = 1 as const;
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION = 1 as const;
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS = ["a", "b"] as const;

export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_ENTRIES = 2_000;
export const KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_ENTRIES = 4_000;

const CHECKSUM_ALGORITHM = "SHA-256";
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const MAX_RELATIVE_PATH_BYTES = 2_048;
const MAX_PATH_SEGMENT_BYTES = 1_024;
const MAX_MODIFICATION_DATE_BYTES = 96;
const MAX_TITLE_BYTES = 4_096;
const MAX_METADATA_VALUE_BYTES = 4_096;
const MAX_LANGUAGE_BYTES = 128;
const MAX_METADATA_VALUES = 64;
const MAX_METADATA_TEXT_BYTES = 16_384;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CACHE_FILENAME_V1_PATTERN =
  /^\.kindle-bridge-device-metadata-cache-v1-([ab])\.json$/u;

export type KindleBridgeDeviceMetadataCacheCodecErrorCode =
  | "KINDLE_DEVICE_CACHE_INPUT_LIMIT"
  | "KINDLE_DEVICE_CACHE_ENTRY_LIMIT"
  | "KINDLE_DEVICE_CACHE_FIELD_LIMIT"
  | "KINDLE_DEVICE_CACHE_INVALID_UTF8"
  | "KINDLE_DEVICE_CACHE_INVALID_JSON"
  | "KINDLE_DEVICE_CACHE_INVALID_SCHEMA"
  | "KINDLE_DEVICE_CACHE_INVALID_PATH"
  | "KINDLE_DEVICE_CACHE_DUPLICATE_PATH"
  | "KINDLE_DEVICE_CACHE_UNSUPPORTED_VERSION"
  | "KINDLE_DEVICE_CACHE_CHECKSUM_UNAVAILABLE"
  | "KINDLE_DEVICE_CACHE_CHECKSUM_MISMATCH"
  | "KINDLE_DEVICE_CACHE_NON_CANONICAL";

export class KindleBridgeDeviceMetadataCacheCodecError extends Error {
  readonly code: KindleBridgeDeviceMetadataCacheCodecErrorCode;

  constructor(code: KindleBridgeDeviceMetadataCacheCodecErrorCode, message: string) {
    super(message);
    this.name = "KindleBridgeDeviceMetadataCacheCodecError";
    this.code = code;
  }
}

/**
 * Portable change evidence deliberately excludes session-scoped MTP handles,
 * storage IDs, device serials, and browser-installation identity. The cache
 * lives on the Kindle, so a clear relative path can be checked against the
 * current live hierarchy by any browser installation.
 */
export interface KindleBridgeDeviceMetadataCacheEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly modificationDate: string;
  readonly objectFormat: number;
  readonly metadata: KindleBookMetadata;
}

export interface KindleBridgeDeviceMetadataCache {
  readonly version: 1;
  readonly parserRevision: 1;
  readonly generation: number;
  readonly entries: readonly KindleBridgeDeviceMetadataCacheEntry[];
}

export type KindleBridgeDeviceMetadataCacheSlot =
  (typeof KINDLE_BRIDGE_DEVICE_METADATA_CACHE_SLOTS)[number];

export interface KindleBridgeDeviceMetadataCacheCodecOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  /** Pass `null` to exercise the explicit no-integrity-codec failure path. */
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest"> | null;
}

interface ResolvedCodecOptions {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest">;
}

interface CanonicalMetadata {
  readonly title?: string;
  readonly authors: readonly string[];
  readonly identifiers: readonly string[];
  readonly language?: string;
}

interface CanonicalEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly modificationDate: string;
  readonly objectFormat: number;
  readonly metadata: CanonicalMetadata;
}

interface CanonicalEnvelope {
  readonly magic: typeof KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC;
  readonly version: 1;
  readonly parserRevision: 1;
  readonly generation: number;
  readonly checksumAlgorithm: typeof CHECKSUM_ALGORITHM;
  readonly checksum: string;
  readonly entries: readonly CanonicalEntry[];
}

const textEncoder = new TextEncoder();

function codecError(
  code: KindleBridgeDeviceMetadataCacheCodecErrorCode,
  message: string,
): KindleBridgeDeviceMetadataCacheCodecError {
  return new KindleBridgeDeviceMetadataCacheCodecError(code, message);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function defaultSubtleCrypto(): Pick<SubtleCrypto, "digest"> | undefined {
  try {
    return globalThis.crypto?.subtle;
  } catch {
    return undefined;
  }
}

function resolveOptions(options: KindleBridgeDeviceMetadataCacheCodecOptions): ResolvedCodecOptions {
  const subtleCrypto = options.subtleCrypto === null
    ? undefined
    : options.subtleCrypto ?? defaultSubtleCrypto();
  return {
    maxBytes: boundedInteger(
      options.maxBytes,
      KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_BYTES,
      128,
      KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_BYTES,
      "maxBytes",
    ),
    maxEntries: boundedInteger(
      options.maxEntries,
      KINDLE_BRIDGE_DEVICE_METADATA_CACHE_DEFAULT_MAX_ENTRIES,
      1,
      KINDLE_BRIDGE_DEVICE_METADATA_CACHE_HARD_MAX_ENTRIES,
      "maxEntries",
    ),
    ...(subtleCrypto === undefined ? {} : { subtleCrypto }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalText(
  value: unknown,
  maximumBytes: number,
  label: string,
): { readonly value: string; readonly byteLength: number } {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `${label} must be non-empty Unicode text.`);
  }
  const normalized = value.normalize("NFC");
  if (/\p{Cc}/u.test(normalized)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `${label} contains control characters.`);
  }
  // Avoid encoding a hostile in-memory string that is obviously beyond a
  // UTF-8 byte ceiling. A valid scalar needs at most four bytes per surrogate
  // pair and at least one byte per UTF-16 code unit.
  if (normalized.length > maximumBytes * 2) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `${label} exceeds its byte limit.`);
  }
  const byteLength = textEncoder.encode(normalized).byteLength;
  if (byteLength > maximumBytes) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `${label} exceeds its byte limit.`);
  }
  return { value: normalized, byteLength };
}

function boundedPathText(
  value: unknown,
  maximumBytes: number,
  label: string,
): { readonly value: string; readonly byteLength: number } {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `${label} must be non-empty Unicode text.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `${label} contains control characters.`);
  }
  if (value.length > maximumBytes * 2) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `${label} exceeds its byte limit.`);
  }
  const byteLength = textEncoder.encode(value).byteLength;
  if (byteLength > maximumBytes) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `${label} exceeds its byte limit.`);
  }
  // MTP object names are identity evidence. Preserve their original Unicode
  // code points rather than applying display-text normalization.
  return { value, byteLength };
}

function canonicalRelativePath(value: unknown): { readonly value: string; readonly byteLength: number } {
  const path = boundedPathText(value, MAX_RELATIVE_PATH_BYTES, "relativePath");
  if (
    path.value.startsWith("/")
    || path.value.endsWith("/")
    || path.value.includes("\\")
  ) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_PATH", "Cache paths must be relative slash-separated paths.");
  }
  const segments = path.value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_PATH", "Cache paths cannot contain empty, dot, or parent segments.");
  }
  for (const segment of segments) {
    if (textEncoder.encode(segment).byteLength > MAX_PATH_SEGMENT_BYTES) {
      throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", "A cache path segment exceeds its byte limit.");
    }
  }
  const leaf = segments.at(-1)!;
  if (usesKindleBridgeDeviceMetadataCacheFilenameNamespace(leaf)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_PATH", "The app-owned cache namespace cannot be cached as a book.");
  }
  return path;
}

function canonicalMetadata(value: unknown, entryIndex: number): {
  readonly metadata: CanonicalMetadata;
  readonly byteLength: number;
} {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["authors", "identifiers"], ["title", "language"])
    || !Array.isArray(value.authors)
    || !Array.isArray(value.identifiers)
  ) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `Entry ${entryIndex} has invalid metadata.`);
  }
  if (value.authors.length > MAX_METADATA_VALUES || value.identifiers.length > MAX_METADATA_VALUES) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `Entry ${entryIndex} has too many metadata values.`);
  }

  let totalBytes = 0;
  let title: string | undefined;
  if (value.title !== undefined) {
    const canonical = canonicalText(value.title, MAX_TITLE_BYTES, `Entry ${entryIndex} title`);
    title = canonical.value;
    totalBytes += canonical.byteLength;
  }

  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const author of value.authors) {
    const canonical = canonicalText(author, MAX_METADATA_VALUE_BYTES, `Entry ${entryIndex} author`);
    if (seenAuthors.has(canonical.value)) {
      throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `Entry ${entryIndex} contains a duplicate author.`);
    }
    seenAuthors.add(canonical.value);
    authors.push(canonical.value);
    totalBytes += canonical.byteLength;
  }

  const identifiers: string[] = [];
  const seenIdentifiers = new Set<string>();
  for (const identifier of value.identifiers) {
    const canonical = canonicalText(
      identifier,
      MAX_METADATA_VALUE_BYTES,
      `Entry ${entryIndex} identifier`,
    );
    if (seenIdentifiers.has(canonical.value)) {
      throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `Entry ${entryIndex} contains a duplicate identifier.`);
    }
    seenIdentifiers.add(canonical.value);
    identifiers.push(canonical.value);
    totalBytes += canonical.byteLength;
  }
  identifiers.sort(codeUnitCompare);

  let language: string | undefined;
  if (value.language !== undefined) {
    const canonical = canonicalText(value.language, MAX_LANGUAGE_BYTES, `Entry ${entryIndex} language`);
    language = canonical.value;
    totalBytes += canonical.byteLength;
  }
  if (totalBytes > MAX_METADATA_TEXT_BYTES) {
    throw codecError("KINDLE_DEVICE_CACHE_FIELD_LIMIT", `Entry ${entryIndex} metadata exceeds its byte limit.`);
  }

  return {
    metadata: Object.freeze({
      ...(title === undefined ? {} : { title }),
      authors: Object.freeze(authors),
      identifiers: Object.freeze(identifiers),
      ...(language === undefined ? {} : { language }),
    }),
    byteLength: totalBytes,
  };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEntries(
  value: unknown,
  limits: ResolvedCodecOptions,
): readonly CanonicalEntry[] {
  if (!Array.isArray(value)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", "Cache entries must be an array.");
  }
  if (value.length > limits.maxEntries) {
    throw codecError("KINDLE_DEVICE_CACHE_ENTRY_LIMIT", "The on-device metadata cache has too many entries.");
  }

  const entries: CanonicalEntry[] = [];
  const paths = new Set<string>();
  let boundedTextBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["relativePath", "size", "modificationDate", "objectFormat", "metadata"])
      || !Number.isSafeInteger(candidate.size)
      || (candidate.size as number) < 0
      || (candidate.size as number) > UINT32_MAX
      || !Number.isSafeInteger(candidate.objectFormat)
      || (candidate.objectFormat as number) < 0
      || (candidate.objectFormat as number) > UINT16_MAX
    ) {
      throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `Entry ${index} has an invalid schema.`);
    }
    const relativePath = canonicalRelativePath(candidate.relativePath);
    const pathKey = relativePath.value.toLocaleLowerCase("en-US");
    if (paths.has(pathKey)) {
      throw codecError("KINDLE_DEVICE_CACHE_DUPLICATE_PATH", "Cache paths must be unique case-insensitively.");
    }
    paths.add(pathKey);

    const modificationDate = canonicalText(
      candidate.modificationDate,
      MAX_MODIFICATION_DATE_BYTES,
      `Entry ${index} modificationDate`,
    );
    if (!isCacheableKindleModificationDate(modificationDate.value)) {
      throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", `Entry ${index} has an invalid MTP modification date.`);
    }
    const parsedMetadata = canonicalMetadata(candidate.metadata, index);
    boundedTextBytes += relativePath.byteLength + modificationDate.byteLength + parsedMetadata.byteLength;
    if (boundedTextBytes > limits.maxBytes) {
      throw codecError("KINDLE_DEVICE_CACHE_INPUT_LIMIT", "Cache text exceeds the configured file byte limit.");
    }
    entries.push(Object.freeze({
      relativePath: relativePath.value,
      size: candidate.size as number,
      modificationDate: modificationDate.value,
      objectFormat: candidate.objectFormat as number,
      metadata: parsedMetadata.metadata,
    }));
  }
  entries.sort((left, right) => codeUnitCompare(left.relativePath, right.relativePath));
  return Object.freeze(entries);
}

function checksumMaterial(generation: number, entries: readonly CanonicalEntry[]): string {
  return JSON.stringify({
    magic: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC,
    version: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION,
    parserRevision: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION,
    generation,
    checksumAlgorithm: CHECKSUM_ALGORITHM,
    entries,
  });
}

function envelopeText(
  generation: number,
  entries: readonly CanonicalEntry[],
  checksum: string,
): string {
  const envelope: CanonicalEnvelope = {
    magic: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC,
    version: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION,
    parserRevision: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION,
    generation,
    checksumAlgorithm: CHECKSUM_ALGORITHM,
    checksum,
    entries,
  };
  return JSON.stringify(envelope);
}

async function sha256Hex(
  text: string,
  subtleCrypto: Pick<SubtleCrypto, "digest"> | undefined,
): Promise<string> {
  if (!subtleCrypto) {
    throw codecError(
      "KINDLE_DEVICE_CACHE_CHECKSUM_UNAVAILABLE",
      "SHA-256 is required for the on-device metadata cache codec.",
    );
  }
  try {
    const bytes = textEncoder.encode(text);
    const digest = await subtleCrypto.digest("SHA-256", Uint8Array.from(bytes).buffer);
    if (digest.byteLength !== 32) throw new Error("unexpected SHA-256 length");
    return Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    if (error instanceof KindleBridgeDeviceMetadataCacheCodecError) throw error;
    throw codecError(
      "KINDLE_DEVICE_CACHE_CHECKSUM_UNAVAILABLE",
      "SHA-256 could not be computed for the on-device metadata cache.",
    );
  }
}

function equalChecksum(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function usesKindleBridgeDeviceMetadataCacheFilenameNamespace(filename: string): boolean {
  const leaf = filename.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  return leaf.toLocaleLowerCase("en-US")
    .startsWith(KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE);
}

/** Returns the exact root filename owned by one side of the V1 A/B cache. */
export function createKindleBridgeDeviceMetadataCacheFilename(
  slot: KindleBridgeDeviceMetadataCacheSlot,
): string {
  if (slot !== "a" && slot !== "b") {
    throw new RangeError("cache slot must be either 'a' or 'b'");
  }
  return `${KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE}v1-${slot}.json`;
}

/**
 * Parses only either exact current V1 root slot. This deliberately differs from
 * namespace reservation: malformed or future names stay reserved but are not
 * claimed as safe current-generation objects to read or retire.
 */
export function parseKindleBridgeDeviceMetadataCacheFilename(
  filename: string,
): KindleBridgeDeviceMetadataCacheSlot | null {
  const match = CACHE_FILENAME_V1_PATTERN.exec(filename);
  return match ? match[1] as KindleBridgeDeviceMetadataCacheSlot : null;
}

export function isKindleBridgeDeviceMetadataCacheFilename(filename: string): boolean {
  return parseKindleBridgeDeviceMetadataCacheFilename(filename) !== null;
}

/** Encodes one canonical, checksum-protected, portable cache object. */
export async function encodeKindleBridgeDeviceMetadataCache(
  cache: KindleBridgeDeviceMetadataCache,
  options: KindleBridgeDeviceMetadataCacheCodecOptions = {},
): Promise<Uint8Array> {
  const limits = resolveOptions(options);
  if (
    !isRecord(cache)
    || !hasExactKeys(cache, ["version", "parserRevision", "generation", "entries"])
    || cache.version !== KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION
    || cache.parserRevision !== KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION
    || !Number.isSafeInteger(cache.generation)
    || cache.generation < 0
  ) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", "The cache model has an invalid version or schema.");
  }
  const entries = canonicalEntries(cache.entries, limits);
  const checksum = await sha256Hex(checksumMaterial(cache.generation, entries), limits.subtleCrypto);
  const encoded = textEncoder.encode(envelopeText(cache.generation, entries, checksum));
  if (encoded.byteLength > limits.maxBytes) {
    throw codecError("KINDLE_DEVICE_CACHE_INPUT_LIMIT", "The encoded on-device metadata cache is too large.");
  }
  return encoded;
}

/**
 * Decodes only the canonical V1 representation. Unknown fields, alternate JSON
 * whitespace/key order, malformed paths, and checksum failures are rejected.
 */
export async function decodeKindleBridgeDeviceMetadataCache(
  bytes: Uint8Array,
  options: KindleBridgeDeviceMetadataCacheCodecOptions = {},
): Promise<KindleBridgeDeviceMetadataCache> {
  const limits = resolveOptions(options);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxBytes) {
    throw codecError("KINDLE_DEVICE_CACHE_INPUT_LIMIT", "The on-device metadata cache exceeds its byte limit.");
  }

  let text: string;
  try {
    // Treat a BOM as a real code point so it cannot create a second accepted
    // byte representation of the otherwise canonical JSON document.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_UTF8", "The on-device metadata cache is not valid UTF-8.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_JSON", "The on-device metadata cache is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", "The cache envelope must be an object.");
  }
  if (parsed.magic !== KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", "The cache envelope has an invalid magic value.");
  }
  if (parsed.version !== KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION) {
    throw codecError(
      "KINDLE_DEVICE_CACHE_UNSUPPORTED_VERSION",
      "The on-device metadata cache version is not supported.",
    );
  }
  if (
    !hasExactKeys(parsed, [
      "magic",
      "version",
      "parserRevision",
      "generation",
      "checksumAlgorithm",
      "checksum",
      "entries",
    ])
    || parsed.parserRevision !== KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION
    || !Number.isSafeInteger(parsed.generation)
    || (parsed.generation as number) < 0
    || parsed.checksumAlgorithm !== CHECKSUM_ALGORITHM
    || typeof parsed.checksum !== "string"
    || !LOWERCASE_SHA256_PATTERN.test(parsed.checksum)
  ) {
    throw codecError("KINDLE_DEVICE_CACHE_INVALID_SCHEMA", "The cache envelope has an invalid schema.");
  }

  const generation = parsed.generation as number;
  const entries = canonicalEntries(parsed.entries, limits);
  const expectedChecksum = await sha256Hex(checksumMaterial(generation, entries), limits.subtleCrypto);
  if (!equalChecksum(parsed.checksum, expectedChecksum)) {
    throw codecError(
      "KINDLE_DEVICE_CACHE_CHECKSUM_MISMATCH",
      "The on-device metadata cache checksum does not match its contents.",
    );
  }
  const canonicalTextValue = envelopeText(generation, entries, expectedChecksum);
  if (text !== canonicalTextValue) {
    throw codecError(
      "KINDLE_DEVICE_CACHE_NON_CANONICAL",
      "The on-device metadata cache is not in its canonical representation.",
    );
  }

  return Object.freeze({
    version: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_VERSION,
    parserRevision: KINDLE_BRIDGE_DEVICE_METADATA_CACHE_PARSER_REVISION,
    generation,
    entries: Object.freeze(entries.map((entry) => Object.freeze({
      relativePath: entry.relativePath,
      size: entry.size,
      modificationDate: entry.modificationDate,
      objectFormat: entry.objectFormat,
      metadata: entry.metadata,
    }))),
  });
}
