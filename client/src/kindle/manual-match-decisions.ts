import type { PseudonymousKindleIdentity } from "./device-identity";

const DATABASE_NAME = "kindle-bridge-manual-match-decisions";
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "decisions-v1";
const UPDATED_AT_INDEX = "updated-at";
const KEY_DOMAIN = "kindle-bridge-manual-match-decision-v2";

const RECORD_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4_000;
const HARD_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_AGE_MS = 2 * 366 * 24 * 60 * 60 * 1_000;
const HARD_MAX_AGE_MS = 5 * 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_000;
const HARD_MAX_OPERATION_TIMEOUT_MS = 30_000;
const MAX_IDENTIFIER_VALUES = 64;
const MAX_TEXT_LENGTH = 4_096;
const MAX_PATH_LENGTH = 2_048;
const MAX_PROFILE_OR_BOOK_ID_LENGTH = 256;
const UINT32_MAX = 0xffff_ffff;

export type KindleManualMatchDecision = "same-book" | "not-this-book";

/**
 * Current, browser-local evidence for one catalog-book/device-object pair.
 * A stored choice is useful only if this complete tuple can be reproduced by
 * a fresh live inventory. It never authorizes deletion by itself.
 */
export interface KindleManualMatchEvidence {
  readonly identity: PseudonymousKindleIdentity;
  readonly storageId: number;
  readonly profileId: string;
  readonly bookId: string;
  /**
   * Effective source-plus-overlay identity. This changes when either the
   * immutable source bytes or the catalog presentation changes, so a choice
   * made for an older edition/presentation cannot claim the new one.
   */
  readonly catalogPresentationVersion: string;
  readonly relativePath: string;
  readonly metadataAdjusted: false;
  readonly objectFormat: number;
  readonly size: number;
  readonly modificationDate?: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly identifiers?: readonly string[];
}

export interface KindleManualMatchDecisionHit {
  readonly decision: KindleManualMatchDecision;
  readonly provenance: "manual-live-evidence";
  readonly authoritativeForPresence: true;
  readonly authoritativeForDeletion: false;
  readonly updatedAt: number;
}

export interface KindleManualMatchDecisionRecord {
  readonly version: 1;
  readonly decisionKey: string;
  readonly profileId: string;
  readonly bookId: string;
  readonly decision: KindleManualMatchDecision;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KindleManualMatchDecisionPersistence {
  read(decisionKey: string): Promise<unknown>;
  put(
    record: KindleManualMatchDecisionRecord,
    limits: { readonly maxEntries: number; readonly expireBefore: number },
  ): Promise<void>;
  delete(decisionKey: string): Promise<void>;
  clearProfile(profileId: string): Promise<void>;
}

export interface KindleManualMatchDecisionStore {
  lookup(evidence: KindleManualMatchEvidence): Promise<KindleManualMatchDecisionHit | undefined>;
  remember(evidence: KindleManualMatchEvidence, decision: KindleManualMatchDecision): Promise<boolean>;
  forget(evidence: KindleManualMatchEvidence): Promise<void>;
  clearProfile(profileId: string): Promise<void>;
}

export interface KindleManualMatchDecisionStoreOptions {
  /** Pass null to force bounded memory-only operation. */
  readonly persistence?: KindleManualMatchDecisionPersistence | null;
  /** Used only when persistence is omitted. Pass null to disable IndexedDB. */
  readonly indexedDB?: IDBFactory | null;
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest"> | null;
  readonly maxEntries?: number;
  readonly maxAgeMs?: number;
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
}

interface ResolvedOptions {
  readonly persistence?: KindleManualMatchDecisionPersistence;
  readonly subtleCrypto?: Pick<SubtleCrypto, "digest">;
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly operationTimeoutMs: number;
  readonly now: () => number;
}

interface KeyDescriptor {
  readonly decisionKey: string;
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

function validText(value: unknown, maximum = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value);
}

function validIdentity(value: unknown): value is PseudonymousKindleIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<PseudonymousKindleIdentity>;
  return typeof identity.key === "string"
    && /^[a-f0-9]{64}$/u.test(identity.key)
    && (identity.stability === "installation" || identity.stability === "session");
}

function validEvidence(value: unknown): value is KindleManualMatchEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<KindleManualMatchEvidence>;
  if (!validIdentity(evidence.identity)
      || !validText(evidence.profileId, MAX_PROFILE_OR_BOOK_ID_LENGTH)
      || !validText(evidence.bookId, MAX_PROFILE_OR_BOOK_ID_LENGTH)
      || typeof evidence.catalogPresentationVersion !== "string"
      || !/^[a-f0-9]{64}$/u.test(evidence.catalogPresentationVersion)
      || !validText(evidence.relativePath, MAX_PATH_LENGTH)
      || evidence.relativePath.startsWith("/")
      || evidence.relativePath.endsWith("/")
      || evidence.relativePath.includes("\\")
      || evidence.relativePath.split("/").some((part) => part === "." || part === ".." || part.length === 0)
      || evidence.metadataAdjusted !== false
      || !Number.isInteger(evidence.storageId)
      || (evidence.storageId ?? 0) <= 0
      || (evidence.storageId ?? UINT32_MAX) >= UINT32_MAX
      || !Number.isInteger(evidence.objectFormat)
      || (evidence.objectFormat ?? -1) < 0
      || (evidence.objectFormat ?? UINT32_MAX + 1) > 0xffff
      || !Number.isSafeInteger(evidence.size)
      || (evidence.size ?? -1) < 0
      || (evidence.size ?? UINT32_MAX + 1) > UINT32_MAX
      || (evidence.modificationDate !== undefined && !validText(evidence.modificationDate, 96))
      || (evidence.title !== undefined && !validText(evidence.title))
      || (evidence.authors !== undefined && !validTextArray(evidence.authors))
      || (evidence.identifiers !== undefined && !validTextArray(evidence.identifiers))) {
    return false;
  }
  return true;
}

function validTextArray(value: readonly string[]): boolean {
  return value.length <= MAX_IDENTIFIER_VALUES && value.every((entry) => validText(entry));
}

function canonicalEvidence(evidence: KindleManualMatchEvidence): string {
  return JSON.stringify({
    domain: KEY_DOMAIN,
    identity: evidence.identity.key,
    storageId: evidence.storageId,
    profileId: evidence.profileId,
    bookId: evidence.bookId,
    catalogPresentationVersion: evidence.catalogPresentationVersion,
    relativePath: evidence.relativePath,
    objectFormat: evidence.objectFormat,
    size: evidence.size,
    modificationDate: evidence.modificationDate ?? null,
    title: evidence.title ?? null,
    authors: [...(evidence.authors ?? [])],
    identifiers: [...(evidence.identifiers ?? [])],
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function evidenceKey(
  evidence: KindleManualMatchEvidence,
  subtleCrypto: Pick<SubtleCrypto, "digest"> | undefined,
): Promise<KeyDescriptor | undefined> {
  if (!validEvidence(evidence) || !subtleCrypto) return undefined;
  const digest = await subtleCrypto.digest("SHA-256", new TextEncoder().encode(canonicalEvidence(evidence)));
  return {
    decisionKey: bytesToHex(new Uint8Array(digest)),
    persistent: evidence.identity.stability === "installation",
  };
}

function validRecord(
  value: unknown,
  expectedKey: string,
  now: number,
  maxAgeMs: number,
): value is KindleManualMatchDecisionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<KindleManualMatchDecisionRecord>;
  return record.version === RECORD_VERSION
    && record.decisionKey === expectedKey
    && /^[a-f0-9]{64}$/u.test(record.decisionKey)
    && validText(record.profileId, MAX_PROFILE_OR_BOOK_ID_LENGTH)
    && validText(record.bookId, MAX_PROFILE_OR_BOOK_ID_LENGTH)
    && (record.decision === "same-book" || record.decision === "not-this-book")
    && Number.isSafeInteger(record.createdAt)
    && Number.isSafeInteger(record.updatedAt)
    && (record.createdAt ?? -1) >= 0
    && (record.updatedAt ?? -1) >= (record.createdAt ?? 0)
    && (record.updatedAt ?? 0) <= now + 5 * 60 * 1_000
    && now - (record.updatedAt ?? 0) <= maxAgeMs;
}

function requestError<T>(request: IDBRequest<T>, fallback: string): Error {
  return request.error ?? new Error(fallback);
}

class IndexedDbDecisionPersistence implements KindleManualMatchDecisionPersistence {
  readonly #factory: IDBFactory;
  #databasePromise?: Promise<IDBDatabase>;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
  }

  async #database(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(OBJECT_STORE_NAME)) database.deleteObjectStore(OBJECT_STORE_NAME);
        const store = database.createObjectStore(OBJECT_STORE_NAME, { keyPath: "decisionKey" });
        store.createIndex(UPDATED_AT_INDEX, "updatedAt");
      };
      request.onblocked = () => reject(new Error("Manual-match database upgrade was blocked"));
      request.onerror = () => reject(requestError(request, "Could not open manual-match database"));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
    return this.#databasePromise;
  }

  async read(decisionKey: string): Promise<unknown> {
    const database = await this.#database();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
      const request = transaction.objectStore(OBJECT_STORE_NAME).get(decisionKey);
      request.onerror = () => reject(requestError(request, "Could not read manual-match decision"));
      request.onsuccess = () => resolve(request.result);
    });
  }

  async put(
    record: KindleManualMatchDecisionRecord,
    limits: { readonly maxEntries: number; readonly expireBefore: number },
  ): Promise<void> {
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      store.put(record);
      const index = store.index(UPDATED_AT_INDEX);
      const expired = index.openCursor(IDBKeyRange.upperBound(limits.expireBefore, true));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      const all = index.openKeyCursor();
      const keys: IDBValidKey[] = [];
      all.onsuccess = () => {
        const cursor = all.result;
        if (!cursor) {
          for (let indexPosition = 0; indexPosition < keys.length - limits.maxEntries; indexPosition += 1) {
            store.delete(keys[indexPosition]!);
          }
          return;
        }
        keys.push(cursor.primaryKey);
        cursor.continue();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist manual-match decision"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Manual-match decision transaction aborted"));
      transaction.oncomplete = () => resolve();
    });
  }

  async delete(decisionKey: string): Promise<void> {
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      transaction.objectStore(OBJECT_STORE_NAME).delete(decisionKey);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete manual-match decision"));
      transaction.oncomplete = () => resolve();
    });
  }

  async clearProfile(profileId: string): Promise<void> {
    const database = await this.#database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if ((cursor.value as Partial<KindleManualMatchDecisionRecord>)?.profileId === profileId) cursor.delete();
        cursor.continue();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear manual-match decisions"));
      transaction.oncomplete = () => resolve();
    });
  }
}

function defaultIndexedDb(): IDBFactory | undefined {
  try { return globalThis.indexedDB; } catch { return undefined; }
}

function defaultSubtleCrypto(): Pick<SubtleCrypto, "digest"> | undefined {
  try { return globalThis.crypto?.subtle; } catch { return undefined; }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Manual-match persistence timed out")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function createKindleManualMatchDecisionStore(
  options: KindleManualMatchDecisionStoreOptions = {},
): KindleManualMatchDecisionStore {
  const factory = options.indexedDB === undefined ? defaultIndexedDb() : options.indexedDB ?? undefined;
  const resolved: ResolvedOptions = {
    persistence: options.persistence === undefined
      ? factory ? new IndexedDbDecisionPersistence(factory) : undefined
      : options.persistence ?? undefined,
    subtleCrypto: options.subtleCrypto === undefined ? defaultSubtleCrypto() : options.subtleCrypto ?? undefined,
    maxEntries: boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, HARD_MAX_ENTRIES, "maxEntries"),
    maxAgeMs: boundedInteger(options.maxAgeMs, DEFAULT_MAX_AGE_MS, 1, HARD_MAX_AGE_MS, "maxAgeMs"),
    operationTimeoutMs: boundedInteger(
      options.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      1,
      HARD_MAX_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs",
    ),
    now: options.now ?? Date.now,
  };
  const memory = new Map<string, KindleManualMatchDecisionRecord>();
  let persistenceHealthy = true;

  const keyFor = (evidence: KindleManualMatchEvidence) => evidenceKey(evidence, resolved.subtleCrypto);
  const trimMemory = (timestamp: number): void => {
    for (const [key, record] of memory) {
      if (timestamp - record.updatedAt > resolved.maxAgeMs) memory.delete(key);
    }
    const ordered = [...memory.values()].sort((left, right) => left.updatedAt - right.updatedAt
      || left.decisionKey.localeCompare(right.decisionKey));
    for (let index = 0; index < ordered.length - resolved.maxEntries; index += 1) {
      memory.delete(ordered[index]!.decisionKey);
    }
  };

  const store: KindleManualMatchDecisionStore = {
    async lookup(evidence: KindleManualMatchEvidence) {
      const descriptor = await keyFor(evidence);
      if (!descriptor) return undefined;
      const timestamp = resolved.now();
      trimMemory(timestamp);
      let record = memory.get(descriptor.decisionKey);
      if (!record && descriptor.persistent && resolved.persistence && persistenceHealthy) {
        try {
          const candidate = await bounded(resolved.persistence.read(descriptor.decisionKey), resolved.operationTimeoutMs);
          if (validRecord(candidate, descriptor.decisionKey, timestamp, resolved.maxAgeMs)) {
            record = candidate;
            memory.set(record.decisionKey, record);
          } else if (candidate !== undefined) {
            await bounded(resolved.persistence.delete(descriptor.decisionKey), resolved.operationTimeoutMs);
          }
        } catch {
          persistenceHealthy = false;
        }
      }
      if (!record || !validRecord(record, descriptor.decisionKey, timestamp, resolved.maxAgeMs)) return undefined;
      if (record.profileId !== evidence.profileId || record.bookId !== evidence.bookId) return undefined;
      return Object.freeze({
        decision: record.decision,
        provenance: "manual-live-evidence" as const,
        authoritativeForPresence: true as const,
        authoritativeForDeletion: false as const,
        updatedAt: record.updatedAt,
      });
    },

    async remember(evidence: KindleManualMatchEvidence, decision: KindleManualMatchDecision) {
      if (decision !== "same-book" && decision !== "not-this-book") return false;
      const descriptor = await keyFor(evidence);
      if (!descriptor) return false;
      const timestamp = resolved.now();
      const prior = memory.get(descriptor.decisionKey);
      const record: KindleManualMatchDecisionRecord = Object.freeze({
        version: RECORD_VERSION,
        decisionKey: descriptor.decisionKey,
        profileId: evidence.profileId,
        bookId: evidence.bookId,
        decision,
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      memory.set(record.decisionKey, record);
      trimMemory(timestamp);
      if (descriptor.persistent && resolved.persistence && persistenceHealthy) {
        try {
          await bounded(resolved.persistence.put(record, {
            maxEntries: resolved.maxEntries,
            expireBefore: timestamp - resolved.maxAgeMs,
          }), resolved.operationTimeoutMs);
        } catch {
          persistenceHealthy = false;
          memory.delete(record.decisionKey);
          return false;
        }
      }
      return true;
    },

    async forget(evidence: KindleManualMatchEvidence) {
      const descriptor = await keyFor(evidence);
      if (!descriptor) return;
      if (descriptor.persistent && resolved.persistence) {
        if (!persistenceHealthy) throw new Error("Manual-match persistence is unavailable");
        try {
          await bounded(resolved.persistence.delete(descriptor.decisionKey), resolved.operationTimeoutMs);
        } catch {
          persistenceHealthy = false;
          throw new Error("The saved manual-match decision could not be removed");
        }
      }
      memory.delete(descriptor.decisionKey);
    },

    async clearProfile(profileId: string) {
      if (!validText(profileId, MAX_PROFILE_OR_BOOK_ID_LENGTH)) return;
      if (resolved.persistence) {
        if (!persistenceHealthy) throw new Error("Manual-match persistence is unavailable");
        try {
          await bounded(resolved.persistence.clearProfile(profileId), resolved.operationTimeoutMs);
        } catch {
          persistenceHealthy = false;
          throw new Error("The saved manual-match decisions could not be cleared");
        }
      }
      for (const [key, record] of memory) {
        if (record.profileId === profileId) memory.delete(key);
      }
    },
  };
  return Object.freeze(store);
}
