import type { KindleBookMetadata } from "./book-metadata";
import type { PseudonymousKindleIdentity } from "./device-identity";

const DATABASE_NAME = "kindle-bridge-kindle-metadata-cache";
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "book-metadata-v1";
const LAST_USED_INDEX_NAME = "last-used-at";
const CACHE_KEY_DOMAIN = "kindle-bridge-book-metadata-cache-key-v1";

const CACHE_RECORD_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4_000;
const HARD_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
const HARD_MAX_AGE_MS = 5 * 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_000;
const HARD_MAX_OPERATION_TIMEOUT_MS = 30_000;
const MAX_BATCH_ENTRIES = 2_000;
const MAX_RELATIVE_PATH_LENGTH = 2_048;
const MAX_MODIFICATION_DATE_LENGTH = 96;
const MAX_TITLE_LENGTH = 4_096;
const MAX_METADATA_VALUE_LENGTH = 4_096;
const MAX_LANGUAGE_LENGTH = 128;
const MAX_METADATA_VALUES = 64;
const MAX_METADATA_TEXT_LENGTH = 16_384;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const UINT32_MAX = 0xffff_ffff;
const MTP_DATE_TIME_PATTERN = /^\d{8}T\d{6}(?:\.\d{1,9})?(?:Z|[+-]\d{4})?$/u;

export const KINDLE_METADATA_CACHE_RECORD_VERSION = CACHE_RECORD_VERSION;

/**
 * Evidence read from the current live MTP hierarchy. Cache lookup is disabled
 * when any field is missing or malformed. `modificationDate` must be the exact,
 * stable device value (or a deterministic canonical form of it), not the scan
 * time. This intentionally makes devices that omit modification timestamps use
 * the safe no-cache path.
 */
export interface KindleMetadataCacheEvidence {
  readonly identity: PseudonymousKindleIdentity;
  readonly storageId: number;
  readonly relativePath: string;
  /** Required literal guard: sanitized or truncated paths are never cache keys. */
  readonly metadataAdjusted: false;
  readonly size: number;
  readonly modificationDate: string;
}

export interface KindleMetadataCacheEntry {
  readonly evidence: KindleMetadataCacheEvidence;
  readonly metadata: KindleBookMetadata;
}

/**
 * A hit is only a hint that avoids reparsing bytes. It must never independently
 * authorize Send, deletion, a green check, or proof that an object is present.
 * Those decisions continue to require the current live hierarchy and the
 * existing strong-match rules.
 */
export interface KindleMetadataCacheHit {
  readonly provenance: "browser-metadata-cache";
  readonly authoritative: false;
  readonly storedAt: number;
  readonly metadata: KindleBookMetadata;
}

/**
 * Versioned on-disk representation used by the IndexedDB adapter. The key is a
 * SHA-256 digest of pseudonymous device identity plus live object evidence; no
 * serial number, path, filename, size, or timestamp is persisted in cleartext.
 */
export interface KindleMetadataCacheStoredRecord {
  readonly version: 1;
  readonly cacheKey: string;
  readonly storedAt: number;
  readonly lastUsedAt: number;
  readonly metadataState: "enriched" | "empty";
  readonly title?: string;
  readonly authors: readonly string[];
  readonly identifiers: readonly string[];
  readonly language?: string;
}

export interface KindleMetadataCachePersistence {
  readMany(cacheKeys: readonly string[]): Promise<ReadonlyMap<string, unknown>>;
  putMany(
    records: readonly KindleMetadataCacheStoredRecord[],
    limits: {
      readonly maxEntries: number;
      readonly expireBefore: number;
    },
  ): Promise<void>;
  deleteMany(cacheKeys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface KindleMetadataCacheOptions {
  /** Pass `null` to force the bounded memory-only implementation. */
  readonly persistence?: KindleMetadataCachePersistence | null;
  /** Used only when `persistence` is omitted. Pass `null` to disable IndexedDB. */
  readonly indexedDB?: IDBFactory | null;
  /** Used for SHA-256 evidence keys. Pass `null` to exercise the no-cache path. */
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest"> | null;
  readonly maxEntries?: number;
  readonly maxAgeMs?: number;
  /** Bounds each IndexedDB operation before the cache degrades to memory-only. */
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
}

export interface KindleMetadataCache {
  lookup(evidence: KindleMetadataCacheEvidence): Promise<KindleMetadataCacheHit | undefined>;
  lookupMany(
    evidence: readonly KindleMetadataCacheEvidence[],
  ): Promise<readonly (KindleMetadataCacheHit | undefined)[]>;
  remember(entry: KindleMetadataCacheEntry): Promise<boolean>;
  /** Returns the number of valid input entries accepted by the bounded cache. */
  rememberMany(entries: readonly KindleMetadataCacheEntry[]): Promise<number>;
  clear(): Promise<void>;
}

interface ResolvedCacheOptions {
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly operationTimeoutMs: number;
  readonly now: () => number;
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest">;
  readonly persistence?: KindleMetadataCachePersistence;
}

interface EvidenceDescriptor {
  readonly cacheKey: string;
  readonly persistent: boolean;
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

function defaultIndexedDb(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

function defaultSubtleCrypto(): Pick<SubtleCrypto, "digest"> | undefined {
  try {
    return globalThis.crypto?.subtle;
  } catch {
    return undefined;
  }
}

function validClock(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDeviceIdentity(identity: unknown): identity is PseudonymousKindleIdentity {
  if (!identity || typeof identity !== "object") return false;
  const candidate = identity as Partial<PseudonymousKindleIdentity>;
  return typeof candidate.key === "string"
    && /^[a-f0-9]{64}$/u.test(candidate.key)
    && (candidate.stability === "installation" || candidate.stability === "session");
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_RELATIVE_PATH_LENGTH) {
    return false;
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
  if (/\p{Cc}/u.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validModificationDate(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_MODIFICATION_DATE_LENGTH
    && MTP_DATE_TIME_PATTERN.test(value);
}

function validEvidence(evidence: unknown): evidence is KindleMetadataCacheEvidence {
  if (!evidence || typeof evidence !== "object") return false;
  const candidate = evidence as Partial<KindleMetadataCacheEvidence>;
  return validDeviceIdentity(candidate.identity)
    && Number.isInteger(candidate.storageId)
    && (candidate.storageId ?? 0) > 0
    && (candidate.storageId ?? UINT32_MAX) < UINT32_MAX
    && Number.isSafeInteger(candidate.size)
    && (candidate.size ?? -1) >= 0
    && (candidate.size ?? UINT32_MAX + 1) <= UINT32_MAX
    && candidate.metadataAdjusted === false
    && validRelativePath(candidate.relativePath)
    && validModificationDate(candidate.modificationDate);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value);
}

function copyMetadata(value: unknown): KindleBookMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<KindleBookMetadata>;
  if (candidate.title !== undefined && !validText(candidate.title, MAX_TITLE_LENGTH)) return undefined;
  if (!Array.isArray(candidate.authors) || candidate.authors.length > MAX_METADATA_VALUES) return undefined;
  if (!Array.isArray(candidate.identifiers) || candidate.identifiers.length > MAX_METADATA_VALUES) return undefined;
  if (candidate.language !== undefined && !validText(candidate.language, MAX_LANGUAGE_LENGTH)) return undefined;

  const authors: string[] = [];
  for (const author of candidate.authors) {
    if (!validText(author, MAX_METADATA_VALUE_LENGTH)) return undefined;
    authors.push(author);
  }
  const identifiers: string[] = [];
  for (const identifier of candidate.identifiers) {
    if (!validText(identifier, MAX_METADATA_VALUE_LENGTH)) return undefined;
    identifiers.push(identifier);
  }
  const totalTextLength = (candidate.title?.length ?? 0)
    + (candidate.language?.length ?? 0)
    + authors.reduce((sum, item) => sum + item.length, 0)
    + identifiers.reduce((sum, item) => sum + item.length, 0);
  if (totalTextLength > MAX_METADATA_TEXT_LENGTH) return undefined;

  return Object.freeze({
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    authors: Object.freeze(authors),
    identifiers: Object.freeze(identifiers),
    ...(candidate.language === undefined ? {} : { language: candidate.language }),
  });
}

function metadataState(metadata: KindleBookMetadata): "enriched" | "empty" {
  return metadata.title !== undefined
      || metadata.authors.length > 0
      || metadata.identifiers.length > 0
      || metadata.language !== undefined
    ? "enriched"
    : "empty";
}

function recordMetadata(record: KindleMetadataCacheStoredRecord): KindleBookMetadata | undefined {
  return copyMetadata({
    ...(record.title === undefined ? {} : { title: record.title }),
    authors: record.authors,
    identifiers: record.identifiers,
    ...(record.language === undefined ? {} : { language: record.language }),
  });
}

function isValidStoredRecord(
  value: unknown,
  expectedKey: string,
  now: number,
  maxAgeMs: number,
): value is KindleMetadataCacheStoredRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<KindleMetadataCacheStoredRecord>;
  if (record.version !== CACHE_RECORD_VERSION
      || record.cacheKey !== expectedKey
      || !/^[a-f0-9]{64}$/u.test(record.cacheKey)
      || !validClock(record.storedAt ?? -1)
      || !validClock(record.lastUsedAt ?? -1)
      || (record.lastUsedAt ?? -1) < (record.storedAt ?? 0)
      || (record.lastUsedAt ?? 0) > now + FUTURE_CLOCK_TOLERANCE_MS
      || now - (record.lastUsedAt ?? 0) > maxAgeMs
      || (record.metadataState !== "enriched" && record.metadataState !== "empty")) {
    return false;
  }
  const metadata = recordMetadata(record as KindleMetadataCacheStoredRecord);
  return metadata !== undefined && metadataState(metadata) === record.metadataState;
}

function makeStoredRecord(
  cacheKey: string,
  metadata: KindleBookMetadata,
  now: number,
  storedAt = now,
): KindleMetadataCacheStoredRecord {
  return Object.freeze({
    version: CACHE_RECORD_VERSION,
    cacheKey,
    storedAt,
    lastUsedAt: now,
    metadataState: metadataState(metadata),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    authors: metadata.authors,
    identifiers: metadata.identifiers,
    ...(metadata.language === undefined ? {} : { language: metadata.language }),
  });
}

function makeHit(record: KindleMetadataCacheStoredRecord): KindleMetadataCacheHit {
  const metadata = recordMetadata(record);
  if (!metadata) throw new TypeError("Cannot create a metadata cache hit from an invalid record");
  return Object.freeze({
    provenance: "browser-metadata-cache",
    authoritative: false,
    storedAt: record.storedAt,
    metadata,
  });
}

function requestError<T>(request: IDBRequest<T>, fallback: string): Error {
  return request.error ?? new Error(fallback);
}

class IndexedDbMetadataCachePersistence implements KindleMetadataCachePersistence {
  readonly #factory: IDBFactory;
  #databasePromise?: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
  }

  async #database(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let abandoned = false;
      try {
        request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          database.deleteObjectStore(OBJECT_STORE_NAME);
        }
        const store = database.createObjectStore(OBJECT_STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex(LAST_USED_INDEX_NAME, "lastUsedAt");
      };
      request.onblocked = () => {
        abandoned = true;
        reject(new Error("Kindle metadata cache database upgrade was blocked"));
      };
      request.onerror = () => reject(requestError(request, "Could not open Kindle metadata cache database"));
      request.onsuccess = () => {
        const database = request.result;
        if (abandoned) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
    return this.#databasePromise;
  }

  async readMany(cacheKeys: readonly string[]): Promise<ReadonlyMap<string, unknown>> {
    if (cacheKeys.length === 0) return new Map();
    const database = await this.#database();
    return new Promise<ReadonlyMap<string, unknown>>((resolve, reject) => {
      const values = new Map<string, unknown>();
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
        const store = transaction.objectStore(OBJECT_STORE_NAME);
        for (const cacheKey of cacheKeys) {
          const request = store.get(cacheKey);
          request.onsuccess = () => {
            if (request.result !== undefined) values.set(cacheKey, request.result);
          };
        }
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(values);
      transaction.onerror = () => reject(transaction.error ?? new Error("Kindle metadata cache read failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Kindle metadata cache read was aborted"));
    });
  }

  async putMany(
    records: readonly KindleMetadataCacheStoredRecord[],
    limits: { readonly maxEntries: number; readonly expireBefore: number },
  ): Promise<void> {
    if (records.length === 0) return;
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
        const store = transaction.objectStore(OBJECT_STORE_NAME);
        for (const record of records) store.put(record);
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          let remainingOverflow = Math.max(0, countRequest.result - limits.maxEntries);
          const cursorRequest = store.index(LAST_USED_INDEX_NAME).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              if (remainingOverflow > 0) {
                const fallbackCursorRequest = store.openCursor();
                fallbackCursorRequest.onsuccess = () => {
                  const fallbackCursor = fallbackCursorRequest.result;
                  if (!fallbackCursor || remainingOverflow <= 0) return;
                  fallbackCursor.delete();
                  remainingOverflow -= 1;
                  fallbackCursor.continue();
                };
              }
              return;
            }
            const lastUsedAt = Number((cursor.value as Partial<KindleMetadataCacheStoredRecord>).lastUsedAt);
            const expired = Number.isFinite(lastUsedAt) && lastUsedAt < limits.expireBefore;
            if (expired || remainingOverflow > 0) {
              cursor.delete();
              if (remainingOverflow > 0) remainingOverflow -= 1;
            }
            if (remainingOverflow > 0 || expired) cursor.continue();
          };
        };
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Kindle metadata cache write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Kindle metadata cache write was aborted"));
    });
  }

  async deleteMany(cacheKeys: readonly string[]): Promise<void> {
    if (cacheKeys.length === 0) return;
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
        const store = transaction.objectStore(OBJECT_STORE_NAME);
        for (const cacheKey of cacheKeys) store.delete(cacheKey);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Kindle metadata cache deletion failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Kindle metadata cache deletion was aborted"));
    });
  }

  async clear(): Promise<void> {
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
        transaction.objectStore(OBJECT_STORE_NAME).clear();
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Kindle metadata cache clear failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Kindle metadata cache clear was aborted"));
    });
  }
}

function resolveOptions(options: KindleMetadataCacheOptions): ResolvedCacheOptions {
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, HARD_MAX_ENTRIES, "maxEntries");
  const maxAgeMs = boundedInteger(options.maxAgeMs, DEFAULT_MAX_AGE_MS, 1, HARD_MAX_AGE_MS, "maxAgeMs");
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    1,
    HARD_MAX_OPERATION_TIMEOUT_MS,
    "operationTimeoutMs",
  );
  const now = options.now ?? Date.now;
  const subtleCrypto = options.subtleCrypto === null
    ? undefined
    : options.subtleCrypto ?? defaultSubtleCrypto();
  let persistence = options.persistence === null ? undefined : options.persistence;
  if (options.persistence === undefined) {
    const factory = options.indexedDB === null ? undefined : options.indexedDB ?? defaultIndexedDb();
    persistence = factory ? new IndexedDbMetadataCachePersistence(factory) : undefined;
  }
  return {
    maxEntries,
    maxAgeMs,
    operationTimeoutMs,
    now,
    ...(subtleCrypto === undefined ? {} : { subtleCrypto }),
    ...(persistence === undefined ? {} : { persistence }),
  };
}

class BrowserKindleMetadataCache implements KindleMetadataCache {
  readonly #maxEntries: number;
  readonly #maxAgeMs: number;
  readonly #operationTimeoutMs: number;
  readonly #now: () => number;
  readonly #subtleCrypto?: Pick<SubtleCrypto, "digest">;
  readonly #memory = new Map<string, KindleMetadataCacheStoredRecord>();
  #persistence?: KindleMetadataCachePersistence;

  constructor(options: ResolvedCacheOptions) {
    this.#maxEntries = options.maxEntries;
    this.#maxAgeMs = options.maxAgeMs;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#now = options.now;
    this.#subtleCrypto = options.subtleCrypto;
    this.#persistence = options.persistence;
  }

  async #describeEvidence(evidence: KindleMetadataCacheEvidence): Promise<EvidenceDescriptor | undefined> {
    if (!validEvidence(evidence) || !this.#subtleCrypto) return undefined;
    const material = new TextEncoder().encode([
      CACHE_KEY_DOMAIN,
      evidence.identity.key,
      evidence.storageId.toString(10),
      evidence.relativePath,
      evidence.size.toString(10),
      evidence.modificationDate,
    ].join("\u0000"));
    try {
      const digest = await this.#subtleCrypto.digest("SHA-256", Uint8Array.from(material).buffer);
      const cacheKey = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (!/^[a-f0-9]{64}$/u.test(cacheKey)) return undefined;
      return {
        cacheKey,
        persistent: evidence.identity.stability === "installation",
      };
    } catch {
      return undefined;
    }
  }

  #disablePersistence(): void {
    this.#persistence = undefined;
  }

  async #withOperationDeadline<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(operation);
    // IndexedDB and WebCrypto promises cannot be cancelled portably. Observe a
    // timed-out operation's eventual settlement so it cannot become an
    // unhandled rejection while inventory immediately takes the safe fallback.
    void pending.catch(() => undefined);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error("Kindle metadata cache operation timed out");
        error.name = "TimeoutError";
        reject(error);
      }, this.#operationTimeoutMs);
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  #pruneMemory(now: number): void {
    const expireBefore = now - this.#maxAgeMs;
    for (const [cacheKey, record] of this.#memory) {
      if (record.lastUsedAt < expireBefore) this.#memory.delete(cacheKey);
    }
    if (this.#memory.size <= this.#maxEntries) return;
    const oldest = [...this.#memory.values()]
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.cacheKey.localeCompare(right.cacheKey));
    for (let index = 0; index < oldest.length - this.#maxEntries; index += 1) {
      this.#memory.delete(oldest[index]!.cacheKey);
    }
  }

  async lookup(evidence: KindleMetadataCacheEvidence): Promise<KindleMetadataCacheHit | undefined> {
    return (await this.lookupMany([evidence]))[0];
  }

  async lookupMany(
    evidence: readonly KindleMetadataCacheEvidence[],
  ): Promise<readonly (KindleMetadataCacheHit | undefined)[]> {
    if (evidence.length > MAX_BATCH_ENTRIES) {
      throw new RangeError(`metadata cache lookup is limited to ${MAX_BATCH_ENTRIES} entries`);
    }
    const now = this.#now();
    if (!validClock(now)) return Object.freeze(evidence.map(() => undefined));
    this.#pruneMemory(now);

    const hits: (KindleMetadataCacheHit | undefined)[] = evidence.map(() => undefined);
    let descriptors: readonly (EvidenceDescriptor | undefined)[];
    try {
      descriptors = await this.#withOperationDeadline(
        () => Promise.all(evidence.map((item) => this.#describeEvidence(item))),
      );
    } catch {
      return Object.freeze(hits);
    }
    const persistentIndexes = new Map<string, number[]>();
    const recordsToTouch = new Map<string, KindleMetadataCacheStoredRecord>();

    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor) continue;
      const memoryRecord = this.#memory.get(descriptor.cacheKey);
      if (memoryRecord && isValidStoredRecord(memoryRecord, descriptor.cacheKey, now, this.#maxAgeMs)) {
        const touched = makeStoredRecord(descriptor.cacheKey, recordMetadata(memoryRecord)!, now, memoryRecord.storedAt);
        this.#memory.set(descriptor.cacheKey, touched);
        hits[index] = makeHit(touched);
        if (descriptor.persistent) recordsToTouch.set(descriptor.cacheKey, touched);
        continue;
      }
      if (memoryRecord) this.#memory.delete(descriptor.cacheKey);
      if (descriptor.persistent && this.#persistence) {
        const indexes = persistentIndexes.get(descriptor.cacheKey) ?? [];
        indexes.push(index);
        persistentIndexes.set(descriptor.cacheKey, indexes);
      }
    }

    if (persistentIndexes.size > 0 && this.#persistence) {
      const persistence = this.#persistence;
      try {
        const stored = await this.#withOperationDeadline(
          () => persistence.readMany([...persistentIndexes.keys()]),
        );
        const keysToDelete: string[] = [];
        for (const [cacheKey, indexes] of persistentIndexes) {
          const value = stored.get(cacheKey);
          if (!isValidStoredRecord(value, cacheKey, now, this.#maxAgeMs)) {
            if (value !== undefined) keysToDelete.push(cacheKey);
            continue;
          }
          const metadata = recordMetadata(value)!;
          const touched = makeStoredRecord(cacheKey, metadata, now, value.storedAt);
          this.#memory.set(cacheKey, touched);
          recordsToTouch.set(cacheKey, touched);
          for (const index of indexes) hits[index] = makeHit(touched);
        }
        if (keysToDelete.length > 0) {
          await this.#withOperationDeadline(() => persistence.deleteMany(keysToDelete));
        }
      } catch {
        this.#disablePersistence();
      }
    }

    if (recordsToTouch.size > 0 && this.#persistence) {
      try {
        const persistence = this.#persistence;
        await this.#withOperationDeadline(() => persistence.putMany(
          [...recordsToTouch.values()],
          {
            maxEntries: this.#maxEntries,
            expireBefore: now - this.#maxAgeMs,
          },
        ));
      } catch {
        this.#disablePersistence();
      }
    }
    this.#pruneMemory(now);
    return Object.freeze(hits);
  }

  async remember(entry: KindleMetadataCacheEntry): Promise<boolean> {
    return (await this.rememberMany([entry])) === 1;
  }

  async rememberMany(entries: readonly KindleMetadataCacheEntry[]): Promise<number> {
    if (entries.length > MAX_BATCH_ENTRIES) {
      throw new RangeError(`metadata cache write is limited to ${MAX_BATCH_ENTRIES} entries`);
    }
    const now = this.#now();
    if (!validClock(now)) return 0;
    let descriptors: readonly (EvidenceDescriptor | undefined)[];
    try {
      descriptors = await this.#withOperationDeadline(
        () => Promise.all(entries.map((entry) => this.#describeEvidence(entry.evidence))),
      );
    } catch {
      return 0;
    }
    const persistentRecords = new Map<string, KindleMetadataCacheStoredRecord>();
    let retained = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const descriptor = descriptors[index];
      const metadata = copyMetadata(entries[index]?.metadata);
      if (!descriptor || !metadata) continue;
      const record = makeStoredRecord(descriptor.cacheKey, metadata, now);
      this.#memory.set(descriptor.cacheKey, record);
      if (descriptor.persistent) persistentRecords.set(descriptor.cacheKey, record);
      retained += 1;
    }
    this.#pruneMemory(now);

    if (persistentRecords.size > 0 && this.#persistence) {
      try {
        const persistence = this.#persistence;
        await this.#withOperationDeadline(() => persistence.putMany(
          [...persistentRecords.values()],
          {
            maxEntries: this.#maxEntries,
            expireBefore: now - this.#maxAgeMs,
          },
        ));
      } catch {
        // The bounded memory copy remains useful for this page session. Never
        // retry a broken persistence backend on every inventory object.
        this.#disablePersistence();
      }
    }
    return retained;
  }

  async clear(): Promise<void> {
    this.#memory.clear();
    if (!this.#persistence) return;
    try {
      const persistence = this.#persistence;
      await this.#withOperationDeadline(() => persistence.clear());
    } catch {
      this.#disablePersistence();
    }
  }
}

/**
 * Creates a local-only, bounded metadata cache. This module contains no HTTP
 * client and never sends device inventory or cached fields to the catalog
 * service. IndexedDB failure degrades to a per-page bounded memory cache.
 */
export function createKindleMetadataCache(
  options: KindleMetadataCacheOptions = {},
): KindleMetadataCache {
  return new BrowserKindleMetadataCache(resolveOptions(options));
}
