import type { CatalogApi, CreateDeliveryInput } from "./catalog-client";

const STORAGE_KEY = "kindle-bridge.pending-deliveries-v1";
const LOCK_NAME = "kindle-bridge:pending-deliveries";
const MAX_ENTRIES = 20;
const MAX_SERIALIZED_BYTES = 24_000;
const LOCK_ACQUISITION_TIMEOUT_MS = 1_000;

interface JournalLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

let realmLockTail: Promise<void> = Promise.resolve();

async function withJournalLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const manager = typeof navigator === "undefined"
    ? undefined
    : navigator.locks as unknown as JournalLockManager | undefined;
  if (manager) {
    const abort = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const lockRequest = manager.request(
      LOCK_NAME,
      { mode: "exclusive", signal: abort.signal },
      operation,
    );
    // A compliant Web Locks implementation rejects the request on abort. The
    // explicit race also protects the verified-transfer path from a broken or
    // mocked lock manager that ignores AbortSignal entirely.
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const error = new DOMException("Delivery journal lock acquisition timed out", "TimeoutError");
        abort.abort(error);
        reject(error);
      }, LOCK_ACQUISITION_TIMEOUT_MS);
    });
    // The raced request may settle after the timeout; always observe it so a
    // late rejection cannot become an unhandled promise.
    void lockRequest.catch(() => undefined);
    try {
      return await Promise.race([lockRequest, deadline]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (!abort.signal.aborted) abort.abort(new DOMException("Delivery journal operation completed", "AbortError"));
    }
  }

  const previous = realmLockTail;
  let release!: () => void;
  realmLockTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface PendingDeliveryRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly delivery: CreateDeliveryInput;
  readonly recordedAt: number;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is PendingDeliveryRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingDeliveryRecord>;
  const delivery = item.delivery as Partial<CreateDeliveryInput> | undefined;
  return item.version === 1
    && boundedText(item.operationId, 96)
    && Number.isSafeInteger(item.recordedAt)
    && (item.recordedAt ?? -1) >= 0
    && Boolean(delivery)
    && boundedText(delivery?.profileId, 128)
    && boundedText(delivery?.bookId, 128)
    && boundedText(delivery?.deviceKey, 256)
    && boundedText(delivery?.status, 32)
    && typeof delivery?.artifactHash === "string"
    && /^[a-f0-9]{64}$/u.test(delivery.artifactHash)
    && boundedText(delivery?.filename, 254)
    && Number.isSafeInteger(delivery?.size)
    && (delivery?.size ?? -1) >= 0
    && (delivery?.objectIdentity === undefined || boundedText(delivery.objectIdentity, 256))
    && (delivery?.managedToken === undefined || /^kb-[a-f0-9]{20}$/u.test(delivery.managedToken));
}

function storageOrDefault(storage?: Pick<Storage, "getItem" | "setItem">): Pick<Storage, "getItem" | "setItem"> | undefined {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readPendingDeliveries(
  storage?: Pick<Storage, "getItem">,
): readonly PendingDeliveryRecord[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? window.localStorage?.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_SERIALIZED_BYTES) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isRecord).slice(-MAX_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

function write(
  records: readonly PendingDeliveryRecord[],
  storage?: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const target = storageOrDefault(storage);
  if (!target) return false;
  try {
    const raw = JSON.stringify(records.slice(-MAX_ENTRIES));
    if (raw.length > MAX_SERIALIZED_BYTES) return false;
    target.setItem(STORAGE_KEY, raw);
    return target.getItem(STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

export async function queuePendingDelivery(
  record: PendingDeliveryRecord,
  storage?: Pick<Storage, "getItem" | "setItem">,
): Promise<boolean> {
  if (!isRecord(record)) return false;
  try {
    return await withJournalLock(() => {
      const existing = readPendingDeliveries(storage);
      const withoutDuplicate = existing.filter((item) => item.operationId !== record.operationId);
      return write([...withoutDuplicate, record], storage);
    });
  } catch {
    return false;
  }
}

export async function acknowledgePendingDelivery(
  operationId: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): Promise<boolean> {
  if (!boundedText(operationId, 96)) return false;
  try {
    return await withJournalLock(() => write(
      readPendingDeliveries(storage).filter((record) => record.operationId !== operationId),
      storage,
    ));
  } catch {
    return false;
  }
}

export async function flushPendingDeliveries(
  api: Pick<CatalogApi, "createDelivery">,
  storage?: Pick<Storage, "getItem" | "setItem">,
): Promise<{ readonly delivered: number; readonly remaining: number }> {
  const records = readPendingDeliveries(storage);
  let delivered = 0;
  for (const record of records) {
    try {
      await api.createDelivery(record.delivery, record.operationId);
      if (await acknowledgePendingDelivery(record.operationId, storage)) delivered += 1;
    } catch {
      // Leave this exact record in the fresh journal for a later retry. Never
      // rewrite a stale snapshot: another tab or a verified Send may have
      // appended a newer record while the API call was in flight.
    }
  }
  return { delivered, remaining: readPendingDeliveries(storage).length };
}
