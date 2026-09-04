const STORAGE_KEY = "kindle-bridge.replacement-cleanup-v1";
const MAX_ENTRIES = 16;
const MAX_SERIALIZED_BYTES = 24_000;
const UINT32_MAX = 0xffff_ffff;

export interface ReplacementCleanupObject {
  readonly handle: number;
  readonly storageId: number;
  readonly parentHandle: number;
  readonly filename: string;
  readonly byteLength: number;
  readonly managedToken: string;
  /** Diagnostic comparison key only; it never authorizes deletion. */
  readonly exactIdentity: string;
}

/**
 * Browser-local reminder that a verified replacement and its prior managed
 * copy may coexist. This record is never deletion authority: cleanup must
 * rebuild a complete live inventory and repeat exact ObjectInfo checks.
 */
export interface ReplacementCleanupRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly recordedAt: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly reason: "delivery-recording" | "old-copy-cleanup";
  readonly deviceKey?: string;
  readonly oldCopy: ReplacementCleanupObject;
  readonly newCopy: ReplacementCleanupObject;
}

type ReplacementCleanupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ReplacementCleanupJournalRead =
  | { readonly status: "ok"; readonly records: readonly ReplacementCleanupRecord[] }
  | { readonly status: "invalid" | "unavailable"; readonly records: readonly [] };

function boundedText(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && (pattern === undefined || pattern.test(value));
}

function uint32(value: unknown, allowSentinel = false): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= UINT32_MAX
    && (allowSentinel || (value !== 0 && value !== UINT32_MAX));
}

function validObject(value: unknown): value is ReplacementCleanupObject {
  if (!value || typeof value !== "object") return false;
  const object = value as Partial<ReplacementCleanupObject>;
  return uint32(object.handle)
    && uint32(object.storageId, true)
    && uint32(object.parentHandle)
    && boundedText(object.filename, 254)
    && !/[\\/]/u.test(object.filename)
    && typeof object.byteLength === "number"
    && Number.isSafeInteger(object.byteLength)
    && object.byteLength > 0
    && object.byteLength <= UINT32_MAX
    && boundedText(object.managedToken, 23, /^kb-[a-f0-9]{20}$/u)
    && boundedText(object.exactIdentity, 1_024);
}

export function isReplacementCleanupRecord(value: unknown): value is ReplacementCleanupRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ReplacementCleanupRecord>;
  return record.version === 1
    && boundedText(record.operationId, 96, /^[a-zA-Z0-9._:-]+$/u)
    && typeof record.recordedAt === "number"
    && Number.isSafeInteger(record.recordedAt)
    && record.recordedAt >= 0
    && uint32(record.vendorId, true)
    && uint32(record.productId, true)
    && (record.reason === "delivery-recording" || record.reason === "old-copy-cleanup")
    && (record.deviceKey === undefined || boundedText(record.deviceKey, 256))
    && validObject(record.oldCopy)
    && validObject(record.newCopy)
    && record.oldCopy.handle !== record.newCopy.handle;
}

function storageOrDefault(storage?: ReplacementCleanupStorage): ReplacementCleanupStorage | undefined {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readReplacementCleanupRecords(
  storage?: Pick<Storage, "getItem">,
): readonly ReplacementCleanupRecord[] {
  return readReplacementCleanupJournal(storage).records;
}

export function readReplacementCleanupJournal(
  storage?: Pick<Storage, "getItem">,
): ReplacementCleanupJournalRead {
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(STORAGE_KEY);
    if (!raw) return { status: "ok", records: Object.freeze([]) };
    if (raw.length > MAX_SERIALIZED_BYTES) return { status: "invalid", records: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((record) => !isReplacementCleanupRecord(record))) {
      return { status: "invalid", records: [] };
    }
    return {
      status: "ok",
      records: Object.freeze(parsed.slice(-MAX_ENTRIES)),
    };
  } catch {
    return { status: "unavailable", records: [] };
  }
}

function writeReplacementCleanupRecords(
  records: readonly ReplacementCleanupRecord[],
  storage?: ReplacementCleanupStorage,
): boolean {
  const target = storageOrDefault(storage);
  if (!target) return false;
  try {
    const retained = records.filter(isReplacementCleanupRecord).slice(-MAX_ENTRIES);
    const raw = JSON.stringify(retained);
    if (raw.length > MAX_SERIALIZED_BYTES) return false;
    if (retained.length === 0) {
      target.removeItem(STORAGE_KEY);
      return target.getItem(STORAGE_KEY) === null;
    }
    target.setItem(STORAGE_KEY, raw);
    return target.getItem(STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

export function persistReplacementCleanupRecord(
  record: ReplacementCleanupRecord,
  storage?: ReplacementCleanupStorage,
): boolean {
  if (!isReplacementCleanupRecord(record)) return false;
  const current = readReplacementCleanupRecords(storage);
  return writeReplacementCleanupRecords([
    ...current.filter((candidate) => candidate.operationId !== record.operationId),
    record,
  ], storage);
}

/** Compare-and-remove prevents a retry from clearing a newer replacement task. */
export function acknowledgeReplacementCleanupRecord(
  expected: ReplacementCleanupRecord,
  storage?: ReplacementCleanupStorage,
): boolean {
  if (!isReplacementCleanupRecord(expected)) return false;
  const current = readReplacementCleanupRecords(storage);
  const match = current.find((record) => record.operationId === expected.operationId);
  if (!match || JSON.stringify(match) !== JSON.stringify(expected)) return false;
  return writeReplacementCleanupRecords(
    current.filter((record) => record.operationId !== expected.operationId),
    storage,
  );
}
