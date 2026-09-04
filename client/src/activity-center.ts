import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { AppState, DeviceDetails } from "./state";

export const KINDLE_BRIDGE_ACTIVITY_VERSION = 1;
export const MAX_ACTIVITY_EVENTS = 100;
export const KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY = "kindle-bridge-activity-v1";
const MAX_ACTIVITY_STORAGE_BYTES = 96 * 1024;

export type KindleBridgeActivityPhase =
  | "disconnected"
  | "connecting"
  | "checking-safe-writes"
  | "reading-books"
  | "comparing-library"
  | "ready"
  | "transferring"
  | "removing"
  | "updating"
  | "needs-attention";

export type KindleBridgeActivityKind =
  | "device-phase"
  | "catalog-health"
  | "catalog-scan"
  | "queue-change"
  | "transfer-result"
  | "removal-result"
  | "update-result"
  | "provider-result"
  | "failure";

export interface KindleBridgeActivityEvent {
  readonly version: 1;
  readonly id: string;
  readonly kind: KindleBridgeActivityKind;
  readonly at: string;
  readonly tone: "neutral" | "success" | "warning" | "error";
  readonly title: string;
  readonly detail?: string;
  readonly phase?: KindleBridgeActivityPhase;
  readonly profileId?: string;
  readonly bookId?: string;
  readonly action?: "retry" | "retry-transfer" | "open-queue" | "open-attention" | "reconnect" | "rescan" | "open-settings";
  /** New books observed in the latest coalesced source-scan window. */
  readonly newlyIndexed?: number;
  readonly acknowledged: boolean;
}

export interface KindleBridgeActivityHistory {
  readonly events: readonly KindleBridgeActivityEvent[];
  readonly phase: KindleBridgeActivityPhase;
  readonly needsAttention: number;
}

export interface KindleBridgeActivityCenterStatus {
  readonly phase: KindleBridgeActivityPhase;
  readonly deviceLabel: string;
  readonly lastInventoryAt?: string;
  readonly inventoryCompleteness?: "complete" | "partial" | "last-seen";
  readonly freeBytes?: bigint;
  readonly capacityBytes?: bigint;
  readonly currentTitle?: string;
  readonly currentProgress?: number;
  readonly batchPosition?: number;
  readonly batchTotal?: number;
  readonly queueCount: number;
  readonly queuedSourceBytes: number;
  /** Source bytes are only an estimate because browser conversion may change size. */
  readonly approximateQueueCapacity: "fits" | "may-not-fit" | "unknown";
  readonly sourceWarnings: number;
  readonly scanningRoots: number;
  readonly indexedBooks: number;
  readonly newlyIndexed: number;
  readonly replacementCleanupCount: number;
  /**
   * Non-terminal server-owned work survives browser reloads. This is derived
   * from the durable job listing (not browser activity history) so a paused or
   * restarted lookup remains visible and reopenable.
   */
  readonly metadataLookupJob?: {
    readonly id: string;
    readonly provider: "open-library" | "google-books";
    readonly status: "queued" | "running" | "paused";
    readonly total: number;
    readonly pending: number;
    readonly ready: number;
    readonly failed: number;
    readonly noResults: number;
  };
}

export interface KindleBridgeActivityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KINDS = new Set<KindleBridgeActivityKind>([
  "device-phase", "catalog-health", "catalog-scan", "queue-change", "transfer-result", "removal-result",
  "update-result", "provider-result", "failure",
]);
const PHASES = new Set<KindleBridgeActivityPhase>([
  "disconnected", "connecting", "checking-safe-writes", "reading-books", "comparing-library",
  "ready", "transferring", "removing", "updating", "needs-attention",
]);
const TONES = new Set(["neutral", "success", "warning", "error"] as const);
const ACTIONS = new Set(["retry", "retry-transfer", "open-queue", "open-attention", "reconnect", "rescan", "open-settings"] as const);
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 240;
const MAX_DETAIL_LENGTH = 1_000;
const EVENT_KEYS = new Set([
  "version", "id", "kind", "at", "tone", "title", "detail", "phase", "profileId", "bookId", "action", "newlyIndexed",
  "acknowledged",
]);

function activityNeedsAttention(event: KindleBridgeActivityEvent): boolean {
  return !event.acknowledged
    && (event.kind === "failure" || event.tone === "warning" || event.tone === "error");
}

function compareActivityRecency(
  left: KindleBridgeActivityEvent,
  right: KindleBridgeActivityEvent,
): number {
  return Date.parse(right.at) - Date.parse(left.at) || right.id.localeCompare(left.id);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value);
}

function safeDetail(value: unknown): value is string {
  return safeText(value, MAX_DETAIL_LENGTH)
    && !/\bBearer\s+[A-Za-z0-9._~+/=-]{3,}/iu.test(value)
    && !/\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret)\s*[:=]\s*\S+/iu.test(value);
}

function safeOptionalId(value: unknown): value is string | undefined {
  return value === undefined || safeText(value, MAX_ID_LENGTH);
}

export function parseKindleBridgeActivityEvent(value: unknown): KindleBridgeActivityEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !EVENT_KEYS.has(key))) return undefined;
  const item = value as Partial<KindleBridgeActivityEvent>;
  if (item.version !== KINDLE_BRIDGE_ACTIVITY_VERSION
      || !safeText(item.id, MAX_ID_LENGTH)
      || !KINDS.has(item.kind as KindleBridgeActivityKind)
      || !safeText(item.at, 64)
      || Number.isNaN(Date.parse(item.at))
      || !TONES.has(item.tone as KindleBridgeActivityEvent["tone"])
      || !safeText(item.title, MAX_TITLE_LENGTH)
      || (item.detail !== undefined && !safeDetail(item.detail))
      || (item.phase !== undefined && !PHASES.has(item.phase))
      || !safeOptionalId(item.profileId)
      || !safeOptionalId(item.bookId)
      || (item.action !== undefined && !ACTIONS.has(item.action))
      || (item.newlyIndexed !== undefined && (!Number.isSafeInteger(item.newlyIndexed) || item.newlyIndexed < 0 || item.newlyIndexed > 10_000))
      || typeof item.acknowledged !== "boolean") {
    return undefined;
  }
  return Object.freeze({
    version: KINDLE_BRIDGE_ACTIVITY_VERSION,
    id: item.id,
    kind: item.kind as KindleBridgeActivityKind,
    at: new Date(item.at).toISOString(),
    tone: item.tone as KindleBridgeActivityEvent["tone"],
    title: item.title,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    ...(item.profileId === undefined ? {} : { profileId: item.profileId }),
    ...(item.bookId === undefined ? {} : { bookId: item.bookId }),
    ...(item.action === undefined ? {} : { action: item.action }),
    ...(item.newlyIndexed === undefined ? {} : { newlyIndexed: item.newlyIndexed }),
    acknowledged: item.acknowledged,
  });
}

export function buildKindleBridgeActivityHistory(
  values: readonly unknown[],
  fallbackPhase: KindleBridgeActivityPhase = "disconnected",
): KindleBridgeActivityHistory {
  const byId = new Map<string, KindleBridgeActivityEvent>();
  for (const value of values) {
    const event = parseKindleBridgeActivityEvent(value);
    if (!event) continue;
    const current = byId.get(event.id);
    if (!current || Date.parse(event.at) >= Date.parse(current.at)) byId.set(event.id, event);
  }
  const sorted = [...byId.values()].sort(compareActivityRecency);
  const currentPhase = sorted.find((event) => event.kind === "device-phase")?.phase ?? fallbackPhase;
  const unresolved = sorted.filter(activityNeedsAttention);
  // Keep unresolved warnings and failures ahead of routine history when
  // applying the hard ceiling. Once acknowledged (or replaced by a newer
  // coalesced status), an entry returns to normal recency-based retention.
  const retained = unresolved.length >= MAX_ACTIVITY_EVENTS
    ? unresolved.slice(0, MAX_ACTIVITY_EVENTS)
    : [
        ...unresolved,
        ...sorted.filter((event) => !activityNeedsAttention(event))
          .slice(0, MAX_ACTIVITY_EVENTS - unresolved.length),
      ];
  const events = Object.freeze(retained.sort(compareActivityRecency));
  // Navigation shortcuts on successful/neutral history entries are useful,
  // but they are not failures. Only unresolved warnings, errors, and explicit
  // failure outcomes light the quiet top-bar attention state.
  const needsAttention = events.filter(activityNeedsAttention).length;
  return Object.freeze({
    events,
    phase: needsAttention > 0 && currentPhase === "ready" ? "needs-attention" : currentPhase,
    needsAttention,
  });
}

/** Coalesces repetitive progress/health entries while retaining failures. */
export function appendKindleBridgeActivity(
  current: readonly KindleBridgeActivityEvent[],
  value: unknown,
): readonly KindleBridgeActivityEvent[] {
  let event = parseKindleBridgeActivityEvent(value);
  if (!event) return current;
  const eventProfileId = event.profileId;
  if (event.kind === "catalog-scan") {
    const previous = current.find((candidate) => candidate.kind === "catalog-scan"
      && candidate.profileId === eventProfileId);
    // Zero explicitly starts a new window; additions accumulate, and later
    // completion/health summaries carry the current window's count forward.
    const newlyIndexed = event.newlyIndexed === 0
      ? 0
      : event.newlyIndexed !== undefined
        ? Math.min(10_000, event.newlyIndexed + (previous?.newlyIndexed ?? 0))
        : previous?.newlyIndexed;
    if (newlyIndexed !== undefined) event = Object.freeze({ ...event, newlyIndexed });
  }
  const replaceKind = event.kind === "device-phase" || event.kind === "catalog-scan" || event.kind === "queue-change";
  const next = replaceKind
    ? current.filter((candidate) => candidate.kind !== event.kind || candidate.profileId !== eventProfileId)
    : current;
  return buildKindleBridgeActivityHistory([event, ...next]).events;
}

export function acknowledgeKindleBridgeActivity(
  current: readonly KindleBridgeActivityEvent[],
  id: string,
): readonly KindleBridgeActivityEvent[] {
  return Object.freeze(current.map((event) => event.id === id
    ? Object.freeze({ ...event, acknowledged: true })
    : event));
}

/**
 * Reads only the bounded, validated summary vocabulary. Corrupt, old, or
 * unexpectedly large browser state is ignored instead of entering the UI.
 */
export function readKindleBridgeActivity(
  storage: Pick<KindleBridgeActivityStorage, "getItem">,
): readonly KindleBridgeActivityEvent[] {
  try {
    const raw = storage.getItem(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY);
    if (!raw || raw.length > MAX_ACTIVITY_STORAGE_BYTES) return Object.freeze([]);
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return Object.freeze([]);
    return buildKindleBridgeActivityHistory(decoded).events;
  } catch {
    return Object.freeze([]);
  }
}

/** Returns false when browser persistence is unavailable or refuses the write. */
export function persistKindleBridgeActivity(
  storage: Pick<KindleBridgeActivityStorage, "getItem" | "setItem">,
  values: readonly unknown[],
): boolean {
  try {
    const events = buildKindleBridgeActivityHistory(values).events;
    const raw = JSON.stringify(events);
    if (raw.length > MAX_ACTIVITY_STORAGE_BYTES) return false;
    storage.setItem(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY, raw);
    return storage.getItem(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

export function clearKindleBridgeActivity(
  storage: Pick<KindleBridgeActivityStorage, "getItem" | "removeItem">,
): boolean {
  try {
    storage.removeItem(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY);
    return storage.getItem(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

function stateDeviceDetails(state: AppState): DeviceDetails | undefined {
  return state.device.kind === "disconnected" || state.device.kind === "requesting-permission"
    ? undefined
    : state.device.details;
}

export function projectKindleBridgeActivityCenter(
  state: AppState,
  snapshot: CatalogBrowserSnapshot,
): KindleBridgeActivityCenterStatus {
  const phase: KindleBridgeActivityPhase = snapshot.pendingUpdate && snapshot.sendBusy
    ? "updating"
    : state.activeError || state.device.kind === "error" || (state.pendingReplacementCleanups?.length ?? 0) > 0
    ? "needs-attention"
    : snapshot.sendBusy
      ? "transferring"
      : snapshot.bulkActionBusy && snapshot.pendingRemoval !== undefined
        ? "removing"
        : state.device.kind === "disconnected"
          ? "disconnected"
          : state.device.kind === "requesting-permission" || state.device.kind === "opening"
            ? "connecting"
            : state.postConnectStage === "safe-write" || state.selfTest.kind === "running"
              ? "checking-safe-writes"
              : state.postConnectStage === "inventory" || state.device.kind === "mtp-reading"
                ? "reading-books"
                : state.postConnectStage === "reconciliation" || state.catalogInventoryState === "loading"
                  ? "comparing-library"
                  : state.device.kind === "ready" && state.catalogInventoryState === "ready"
                    ? "ready"
                    : "connecting";
  const details = stateDeviceDetails(state);
  const profile = snapshot.profiles.find(({ id }) => id === snapshot.filters.profileId);
  const roots = snapshot.filters.profileId ? snapshot.rootsByProfile.get(snapshot.filters.profileId) ?? [] : [];
  const sourceWarnings = roots.filter((root) => root.enabled
    && !["available", "watching", "scanning", "paused"].includes(root.status)).length;
  const queueCount = snapshot.sendQueue?.entries.length ?? 0;
  const queuedSourceBytes = snapshot.sendQueue?.totalSourceBytes ?? 0;
  const approximateQueueCapacity = details?.freeBytes === undefined || queueCount === 0
    ? "unknown"
    : details.freeBytes >= BigInt(queuedSourceBytes) ? "fits" : "may-not-fit";
  const newlyIndexed = snapshot.activityEvents.find((event) => event.kind === "catalog-scan"
    && event.profileId === snapshot.filters.profileId)?.newlyIndexed ?? 0;
  const activeLookupStatuses = new Set(["queued", "running", "paused"] as const);
  const durableLookup = [
    snapshot.activeMetadataLookupJob,
    ...(snapshot.metadataLookupJobs?.items ?? []),
  ].find((job) => job !== undefined
    && job.profileId === snapshot.filters.profileId
    && activeLookupStatuses.has(job.status as "queued" | "running" | "paused"));
  return Object.freeze({
    phase,
    deviceLabel: details?.model ?? details?.productName ?? "Kindle",
    ...(snapshot.kindleInventory?.scannedAt ? { lastInventoryAt: snapshot.kindleInventory.scannedAt } : {}),
    ...(snapshot.kindleInventory?.completeness
      ? { inventoryCompleteness: snapshot.kindleInventory.completeness }
      : {}),
    ...(details?.freeBytes === undefined ? {} : { freeBytes: details.freeBytes }),
    ...(details?.capacityBytes === undefined ? {} : { capacityBytes: details.capacityBytes }),
    ...(snapshot.pendingUpdate?.book.title
      ? { currentTitle: snapshot.pendingUpdate.book.title }
      : snapshot.pendingBook?.title ? { currentTitle: snapshot.pendingBook.title } : {}),
    ...(snapshot.sendProgress === undefined ? {} : { currentProgress: snapshot.sendProgress }),
    ...(snapshot.batchTransfer === undefined ? {} : {
      batchPosition: snapshot.batchTransfer.position,
      batchTotal: snapshot.batchTransfer.total,
    }),
    queueCount,
    queuedSourceBytes,
    approximateQueueCapacity,
    sourceWarnings,
    scanningRoots: roots.filter((root) => root.enabled && root.status === "scanning").length,
    indexedBooks: profile?.bookCount ?? 0,
    newlyIndexed,
    replacementCleanupCount: state.pendingReplacementCleanups?.length ?? 0,
    ...(durableLookup ? {
      metadataLookupJob: Object.freeze({
        id: durableLookup.id,
        provider: durableLookup.provider,
        status: durableLookup.status as "queued" | "running" | "paused",
        total: durableLookup.total,
        pending: durableLookup.pending,
        ready: durableLookup.ready,
        failed: durableLookup.failed,
        noResults: durableLookup.noResults,
      }),
    } : {}),
  });
}
