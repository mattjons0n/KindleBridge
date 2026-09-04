import {
  CatalogApiError,
  type CatalogApi,
  type CatalogBook,
  type CatalogBookQuery,
  type CatalogBookDetailsData,
  type CatalogBookMetadataState,
  type CatalogBookPage,
  type BookMetadataOverrides,
  type CatalogEvent,
  type CatalogFilters,
  type CatalogHealthIssue,
  type CatalogHealthPage,
  type CatalogIssueSeverity,
  type CatalogIssueType,
  type CatalogKindleStatus,
  type CatalogKindleStatusCounts,
  type CatalogProfile,
  type CatalogRoot,
  type CatalogSendQueue,
  type CatalogSeriesDetail,
  type CatalogSeriesSummaryPage,
  type CatalogServiceStatus,
  type CoverProvider,
  type CoverProviderCredentialState,
  type CoverSearchCandidate,
  type CatalogMetadataCandidate,
  type MetadataCandidateSearchTerms,
  type MetadataLookupJob,
  type MetadataLookupJobPage,
  type ProfileBookAnnotation,
  type SmartShelf,
  type SmartShelfQuery,
} from "./catalog-client";
import {
  catalogQuery,
  clearCatalogFilters,
  EMPTY_CATALOG_FILTERS,
  initialLibraryFilters,
  type LibraryFilters,
  type LibraryLayout,
  type LibraryProfileId,
  type LibraryView,
} from "./library-prototype";
import {
  createPrototypeFolder,
  createPrototypeLibrary,
  normalizeLibraryDraft,
  profileInput,
  rootInput,
  settingsDraftFromProfile,
  validateLibraryDraft,
  type LibrarySettingsDraft,
} from "./library-settings-prototype";
import {
  readLibraryBrowserContext,
  writeLibraryBrowserContext,
  type LibraryDensity,
} from "./library-browser-context";
import { buildSendQueueReview, reorderedQueueBookIds } from "./send-queue";
import {
  BUILT_IN_SMART_SHELVES,
  libraryFiltersToSmartShelfQuery,
  orderedPinnedSmartShelves,
  smartShelfQueryToLibraryFilters,
} from "./smart-shelves";
import {
  appendKindleBridgeActivity,
  buildKindleBridgeActivityHistory,
  persistKindleBridgeActivity,
  readKindleBridgeActivity,
  type KindleBridgeActivityEvent,
} from "./activity-center";
import type { MetadataCandidateField } from "./metadata-candidates";
import type { KindleMatchEvidence } from "./kindle";
import type {
  CatalogManagedUpdateRequest,
  CatalogManagedUpdateResult,
} from "./catalog-managed-update";
import type { LibraryRouteState } from "./library-route";
import {
  MAX_BOOK_SELECTION_IDS,
  MAX_METADATA_LOOKUP_JOBS_PER_PROFILE,
  MAX_PINNED_SMART_SHELVES_PER_PROFILE,
} from "../../shared/catalog-contracts.js";

export type CatalogLoadState = "idle" | "loading" | "ready" | "error";

export interface CatalogBrowserSnapshot {
  readonly loadState: CatalogLoadState;
  readonly serviceStatus?: CatalogServiceStatus;
  readonly profiles: readonly CatalogProfile[];
  readonly rootsByProfile: ReadonlyMap<string, readonly CatalogRoot[]>;
  readonly filters: LibraryFilters;
  readonly facets: CatalogFilters;
  readonly page?: CatalogBookPage;
  readonly booksState: CatalogLoadState;
  readonly error?: string;
  readonly stale: boolean;
  readonly liveUpdatesConnected: boolean;
  readonly settingsLibraryId?: string;
  readonly settingsDraft?: LibrarySettingsDraft;
  readonly settingsSaving: boolean;
  readonly settingsRefreshing: boolean;
  readonly settingsConflict: boolean;
  readonly settingsDirty: boolean;
  readonly settingsError?: string;
  readonly confirmDeleteLibraryId?: string;
  readonly rescanningRootIds: ReadonlySet<string>;
  readonly pendingBookId?: string;
  /** Immutable card snapshot retained while a live catalog refresh changes pages. */
  readonly pendingBook?: CatalogBook;
  readonly sendBusy: boolean;
  readonly sendPhase?: CatalogTransferPhase;
  readonly sendProgress?: number;
  readonly sendMessage?: string;
  readonly batchTransfer?: CatalogBatchTransferState;
  readonly announcement?: string;
  readonly kindleStatus: ReadonlyMap<string, CatalogKindleStatus>;
  readonly kindleStatusCountsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts>;
  readonly kindleInventory?: CatalogKindleInventory;
  readonly kindleInventoryOffset: number;
  readonly layout: LibraryLayout;
  readonly density?: LibraryDensity;
  /** Restored only when switching profiles/startup, not after ordinary renders. */
  readonly contextScrollY?: number;
  readonly contextRestoreToken?: number;
  readonly selectedBookIds: ReadonlySet<string>;
  readonly bulkActionBusy: boolean;
  readonly bulkActionError?: string;
  readonly pendingRemoval?: CatalogRemoveRequest;
  readonly pendingUpdate?: CatalogManagedUpdateState;
  readonly metadataEditor?: CatalogMetadataEditorState;
  readonly bookDetails?: CatalogBookDetailsState;
  readonly coverProviderSettings?: CatalogCoverProviderSettingsState;
  readonly matchReview?: CatalogMatchReviewState;
  readonly sendQueue?: CatalogSendQueue;
  readonly sendQueueState: CatalogLoadState;
  readonly sendQueueOpen: boolean;
  readonly sendQueueBusy: boolean;
  readonly sendQueueError?: string;
  readonly seriesState: CatalogLoadState;
  readonly seriesPage?: CatalogSeriesSummaryPage;
  readonly seriesDetail?: CatalogSeriesDetail;
  readonly seriesQuery: string;
  readonly seriesSort: "name" | "count";
  readonly smartShelves: readonly SmartShelf[];
  readonly smartShelvesState: CatalogLoadState;
  readonly activeShelf?: { readonly id: string; readonly name: string; readonly query: SmartShelfQuery; readonly builtIn: boolean };
  readonly shelfManagerOpen: boolean;
  readonly annotations: ReadonlyMap<string, ProfileBookAnnotation>;
  readonly healthState: CatalogLoadState;
  readonly healthPage?: CatalogHealthPage;
  readonly healthBooks: ReadonlyMap<string, CatalogBook>;
  readonly healthFilter: {
    readonly type: CatalogIssueType | "all";
    readonly severity: CatalogIssueSeverity | "all";
    readonly ignored: boolean;
  };
  readonly healthBusySignature?: string;
  readonly healthError?: string;
  readonly healthOffset?: number;
  readonly metadataLookupState: CatalogLoadState;
  readonly metadataLookupJobs?: MetadataLookupJobPage;
  readonly activeMetadataLookupJob?: MetadataLookupJob;
  readonly metadataLookupBusy: boolean;
  readonly metadataLookupError?: string;
  readonly activityOpen: boolean;
  readonly activityEvents: readonly KindleBridgeActivityEvent[];
}

export type CatalogManualMatchChoice = "same-book" | "not-this-book" | "undo";

export type CatalogMatchComparison = "match" | "different" | "unavailable" | "not-compared";

export interface CatalogMatchEvidenceBreakdown {
  readonly tier: KindleMatchEvidence | "prior-presentation" | "reconciliation-incomplete";
  readonly inventoryCompleteness: KindleInventoryCompleteness;
  readonly ambiguous: boolean;
  readonly candidateCount: number;
  readonly comparisons: {
    readonly title: CatalogMatchComparison;
    readonly authors: CatalogMatchComparison;
    readonly identifiers: CatalogMatchComparison;
    readonly filename: CatalogMatchComparison;
    readonly size: CatalogMatchComparison;
  };
  readonly strongerProofUnavailable: string;
}

export interface CatalogManualMatchCandidate {
  readonly profileId: string;
  readonly bookId: string;
  readonly reason: string;
  readonly evidence: CatalogMatchEvidenceBreakdown;
  readonly decision?: Exclude<CatalogManualMatchChoice, "undo">;
}

export interface CatalogPossibleMatchReview {
  readonly profileId: string;
  readonly bookId: string;
  readonly reason: string;
  readonly evidence: CatalogMatchEvidenceBreakdown;
}

export interface CatalogMatchReviewState {
  readonly itemId: string;
  readonly requestedBookId?: string;
  readonly explanation?: CatalogPossibleMatchReview;
  readonly loadState: CatalogLoadState;
  readonly books: ReadonlyMap<string, CatalogBook>;
  readonly busy: boolean;
  readonly error?: string;
}

export interface CatalogCoverProviderSettingsState {
  readonly loadState: CatalogLoadState;
  readonly googleBooks?: CoverProviderCredentialState;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly error?: string;
}

export interface CatalogBookDetailsState {
  readonly profileId: string;
  readonly bookId: string;
  readonly loadState: CatalogLoadState;
  readonly book?: CatalogBook;
  readonly data?: CatalogBookDetailsData | CatalogBookMetadataState;
  readonly error?: string;
}

export interface CatalogMetadataEditorState {
  readonly profileId: string;
  readonly bookId: string;
  readonly title: string;
  readonly loadState: CatalogLoadState;
  readonly data?: CatalogBookMetadataState;
  /** Unsaved form values survive cover searches/uploads that re-render the dialog. */
  readonly draftOverrides: BookMetadataOverrides;
  readonly busy: boolean;
  readonly error?: string;
  readonly coverSearch: {
    readonly provider: CoverProvider;
    readonly query: string;
    readonly loadState: CatalogLoadState;
    readonly items: readonly CoverSearchCandidate[];
    readonly error?: string;
  };
  readonly metadataSearch: {
    readonly provider: CoverProvider;
    readonly terms: MetadataCandidateSearchTerms;
    readonly loadState: CatalogLoadState;
    readonly items: readonly CatalogMetadataCandidate[];
    readonly selectedCandidateId?: string;
    readonly selectedFields: ReadonlySet<MetadataCandidateField>;
    readonly includeCover: boolean;
    /** Present only while reviewing a durable bulk-lookup result. */
    readonly lookupJobId?: string;
    readonly error?: string;
  };
}

export type CatalogTransferPhase = "preparing" | "converting" | "validating" | "sending" | "verifying" | "complete" | "failed";

export interface CatalogTransferUpdate {
  readonly phase: CatalogTransferPhase;
  readonly progress?: number;
  readonly message?: string;
}

export interface CatalogBatchTransferBook {
  readonly id: string;
  readonly title: string;
}

export interface CatalogSendBatchContext {
  readonly id: string;
  /** One-based position in the immutable batch order. */
  readonly position: number;
  readonly total: number;
}

export interface CatalogBatchTransferState extends CatalogSendBatchContext {
  readonly verifiedBooks: readonly CatalogBatchTransferBook[];
  readonly retryBooks: readonly CatalogBatchTransferBook[];
  readonly failedBook?: CatalogBatchTransferBook;
}

export interface CatalogSendBatchResult {
  readonly id: string;
  readonly total: number;
  readonly succeeded: readonly CatalogBatchTransferBook[];
  readonly unsent: readonly CatalogBatchTransferBook[];
  readonly failed?: CatalogBatchTransferBook & { readonly message: string };
}

export type KindleInventoryCompleteness = "complete" | "partial" | "last-seen";

export interface CatalogKindleInventoryItem {
  readonly id: string;
  readonly filename: string;
  readonly title?: string;
  readonly author?: string;
  readonly format?: string;
  readonly size: number;
  readonly path?: string;
  readonly managed: boolean;
  readonly bookId?: string;
  readonly match: "confirmed" | "possible" | "unmatched";
  /** Exact prior Kindle Bridge presentation; removable, but never green/current. */
  readonly stalePresentation?: boolean;
  /** Exact live object facts shown in the review surface, never deletion authority. */
  readonly objectFormat?: number;
  readonly modificationDate?: string;
  readonly candidates?: readonly CatalogManualMatchCandidate[];
}

export interface CatalogKindleInventory {
  readonly deviceLabel: string;
  readonly scannedAt: string;
  readonly completeness: KindleInventoryCompleteness;
  readonly items: readonly CatalogKindleInventoryItem[];
  /** Catalog-side yellow states, including the important zero-device-candidate case. */
  readonly possibleMatches?: readonly CatalogPossibleMatchReview[];
  readonly total: number;
  /** Read-only book-object enrichment; independent from hierarchy completeness. */
  readonly metadata?: {
    readonly status: "disabled" | "complete" | "partial";
    readonly eligible: number;
    readonly enriched: number;
    readonly failed: number;
    readonly skipped: number;
    readonly truncated: boolean;
  };
  /** Whether the currently visible profile's compact match index participated. */
  readonly matching?: {
    readonly status: "complete" | "partial" | "unavailable";
    readonly matchedProfiles: number;
    readonly failedProfiles: number;
    /** Other enabled household profiles are reconciled only when selected. */
    readonly deferredProfiles?: number;
  };
  /** True only when hierarchy enumeration hit its object-handle bound. */
  readonly truncated: boolean;
}

export function catalogPossibleMatchReviewId(bookId: string): string {
  return `catalog-possible:${bookId}`;
}

export interface CatalogSendRequest {
  readonly profileId: string;
  readonly book: CatalogBook;
  readonly batch?: CatalogSendBatchContext;
}

export interface CatalogRemoveTarget {
  readonly itemId: string;
  readonly bookId: string;
  readonly title: string;
  readonly filename: string;
  readonly size: number;
}

export interface CatalogRemoveRequest {
  readonly profileId: string;
  readonly targets: readonly CatalogRemoveTarget[];
}

export interface CatalogManagedUpdateState {
  readonly book: CatalogBook;
  readonly priorFilename: string;
  readonly result?: CatalogManagedUpdateResult;
  readonly error?: string;
}

export interface CatalogHardwareHooks {
  readonly onConnectRequested?: () => void | Promise<void>;
  readonly onDisconnectRequested?: () => void | Promise<void>;
  readonly onSendRequested?: (request: CatalogSendRequest) => void | Promise<void>;
  /** Finalizes one browser-orchestrated batch after its last success or first failure. */
  readonly onSendBatchFinished?: (result: CatalogSendBatchResult) => void | Promise<void>;
  readonly onRemoveRequested?: (request: CatalogRemoveRequest) => void | Promise<void>;
  readonly onUpdateRequested?: (request: CatalogManagedUpdateRequest) => Promise<CatalogManagedUpdateResult>;
  readonly onCatalogChanged?: (event: CatalogEvent) => void | Promise<void>;
  /** Reconcile the newly visible profile first when a Kindle is already connected. */
  readonly onActiveProfileChanged?: (profileId: string) => void | Promise<void>;
  readonly onManualMatchDecision?: (request: {
    readonly profileId: string;
    readonly bookId: string;
    readonly itemId: string;
    readonly decision: CatalogManualMatchChoice;
  }) => void | Promise<void>;
}

export type CatalogRenderScope = "all" | "results" | "device" | "results-and-device";

export interface CatalogBrowserOptions {
  /** Aggregate deadline for one startup, profile, page, Settings-load, or event refresh. */
  readonly requestTimeoutMs?: number;
  /** Aggregate deadline for a Settings mutation plus its authoritative refresh. */
  readonly settingsMutationTimeoutMs?: number;
}

const ACTIVE_PROFILE_KEY = "kindle-bridge.active-profile";
const CATALOG_PAGE_LIMITS = [24, 12, 6, 3, 1] as const;
const DEFAULT_BROWSER_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_SETTINGS_MUTATION_TIMEOUT_MS = 45_000;

interface CatalogOperationLease {
  readonly signal: AbortSignal;
  wait<T>(promise: Promise<T>): Promise<T>;
  abort(reason?: unknown): void;
  dispose(): void;
}

function browserTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return timeout;
}

function operationAbortReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new DOMException(fallback, "AbortError");
}

async function waitForCatalogOperation<T>(
  signal: AbortSignal,
  label: string,
  promise: Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw operationAbortReason(signal, `${label} aborted`);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const retire = (): void => {
      if (settled) return;
      settled = true;
      reject(operationAbortReason(signal, `${label} aborted`));
    };
    signal.addEventListener("abort", retire, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", retire);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", retire);
        reject(error);
      },
    );
  });
}

function createCatalogOperation(label: string, timeoutMs: number): CatalogOperationLease {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    controller.abort(new CatalogApiError(
      408,
      "CATALOG_REQUEST_TIMEOUT",
      `${label} timed out. Try again.`,
    ));
  }, timeoutMs);
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    wait: <T>(promise: Promise<T>) => waitForCatalogOperation(controller.signal, label, promise),
    abort: (reason = new DOMException(`${label} was superseded`, "AbortError")) => {
      clearTimer();
      controller.abort(reason);
    },
    dispose: clearTimer,
  };
}

function createLinkedCatalogOperation(parent: CatalogOperationLease, label: string): CatalogOperationLease {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(operationAbortReason(parent.signal, `${label} parent aborted`));
  };
  if (parent.signal.aborted) abortFromParent();
  else parent.signal.addEventListener("abort", abortFromParent, { once: true });
  const unlink = (): void => parent.signal.removeEventListener("abort", abortFromParent);
  return {
    signal: controller.signal,
    wait: <T>(promise: Promise<T>) => waitForCatalogOperation(controller.signal, label, promise),
    abort: (reason = new DOMException(`${label} was superseded`, "AbortError")) => {
      unlink();
      controller.abort(reason);
    },
    dispose: unlink,
  };
}

function responseExceededCatalogLimit(error: unknown): boolean {
  if (!(error instanceof CatalogApiError) || error.status !== 413) return false;
  return error.code === "response_too_large"
    || error.code === "CATALOG_RESPONSE_TOO_LARGE";
}

async function fetchAdaptiveCatalogPage(
  fetchPage: (query: ReturnType<typeof catalogQuery>) => Promise<CatalogBookPage>,
  query: ReturnType<typeof catalogQuery>,
): Promise<CatalogBookPage> {
  const requestedLimit = Math.max(1, Math.min(200, query.limit ?? CATALOG_PAGE_LIMITS[0]));
  const limits = [
    requestedLimit,
    ...CATALOG_PAGE_LIMITS.filter((candidate) => candidate < requestedLimit),
  ];
  for (const [index, limit] of limits.entries()) {
    try {
      return await fetchPage({ ...query, limit });
    } catch (error) {
      if (!responseExceededCatalogLimit(error) || index === limits.length - 1) throw error;
    }
  }
  throw new Error("The catalog page could not be loaded within its response limit.");
}

function safeStorageGet(storage: Pick<Storage, "getItem"> | undefined, key: string): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeStorageSet(storage: Pick<Storage, "setItem"> | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Profile persistence is a convenience; catalog access must not depend on it.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function rootsMapWith(
  current: ReadonlyMap<string, readonly CatalogRoot[]>,
  profileId: string,
  roots: readonly CatalogRoot[],
): ReadonlyMap<string, readonly CatalogRoot[]> {
  const next = new Map(current);
  next.set(profileId, roots);
  return next;
}

function settingsDraftFingerprint(draft: LibrarySettingsDraft): string {
  return JSON.stringify({
    id: draft.id,
    persisted: draft.persisted,
    name: draft.name,
    enabled: draft.enabled,
    folders: draft.folders.map((folder) => ({
      id: folder.id,
      persisted: folder.persisted,
      label: folder.label,
      path: folder.path,
      enabled: folder.enabled,
      includeSubfolders: folder.includeSubfolders,
      watchForChanges: folder.watchForChanges,
      sentinel: folder.sentinel,
      mountIdentity: folder.mountIdentity,
    })),
  });
}

function normalizeFacetBackedSelects(filters: LibraryFilters, facets: CatalogFilters): LibraryFilters {
  const valid = (value: string, options: CatalogFilters[keyof CatalogFilters]): string => (
    value === "all" || options.some((option) => option.value === value) ? value : "all"
  );
  const language = valid(filters.language, facets.languages);
  const format = valid(filters.format, facets.formats);
  const rootId = valid(filters.rootId, facets.roots);
  const year = valid(filters.year, facets.years);
  if (language === filters.language && format === filters.format && rootId === filters.rootId && year === filters.year) {
    return filters;
  }
  return { ...filters, language, format, rootId, year, offset: 0 };
}

export class CatalogBrowser {
  readonly #api: CatalogApi;
  readonly #hooks: CatalogHardwareHooks;
  readonly #render: (scope: CatalogRenderScope) => void;
  readonly #storage?: Pick<Storage, "getItem" | "setItem">;
  readonly #requestTimeoutMs: number;
  readonly #settingsMutationTimeoutMs: number;
  #snapshot: CatalogBrowserSnapshot;
  #profileEpoch = 0;
  #bookEpoch = 0;
  #settingsEpoch = 0;
  #profilesReloadEpoch = 0;
  #eventRefreshEpoch = 0;
  #searchTimer?: number;
  #eventTimer?: number;
  #eventRefreshRunning = false;
  #configurationMutationRunning = false;
  #activeEventBatch?: { readonly profileIds: readonly string[]; readonly event: CatalogEvent };
  #pendingEventProfileIds = new Set<string>();
  #latestCatalogEvent?: CatalogEvent;
  #rootDataGenerations = new Map<string, number>();
  #unsubscribeEvents?: () => void;
  #eventStreamExpected = false;
  #settingsIdempotencyKey?: string;
  #settingsIdempotencyFingerprint?: string;
  #settingsDraftDirty = false;
  #settingsExternallyChanged = false;
  #settingsBaselineFingerprint?: string;
  #sendOperationSequence = 0;
  #activeSendOperation?: number;
  #updateOperationSequence = 0;
  #activeUpdateOperation?: number;
  #batchOperationSequence = 0;
  #profileOperation?: CatalogOperationLease;
  #bookOperation?: CatalogOperationLease;
  #settingsLoadOperation?: CatalogOperationLease;
  #settingsMutationOperation?: CatalogOperationLease;
  #eventRefreshOperation?: CatalogOperationLease;
  #rescanOperations = new Map<string, CatalogOperationLease>();
  #metadataEditorEpoch = 0;
  #metadataEditorOperation?: CatalogOperationLease;
  #bookDetailsEpoch = 0;
  #bookDetailsOperation?: CatalogOperationLease;
  #coverProviderEpoch = 0;
  #coverProviderOperation?: CatalogOperationLease;
  #matchReviewEpoch = 0;
  #extrasEpoch = 0;
  #matchReviewOperation?: CatalogOperationLease;
  #queueOperation?: CatalogOperationLease;
  #seriesOperation?: CatalogOperationLease;
  #shelfOperation?: CatalogOperationLease;
  #healthOperation?: CatalogOperationLease;
  #metadataLookupOperation?: CatalogOperationLease;
  #metadataLookupRunEpoch = 0;
  #restoredShelfId?: string;

  constructor(
    api: CatalogApi,
    hooks: CatalogHardwareHooks,
    render: (scope: CatalogRenderScope) => void,
    storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
    options: CatalogBrowserOptions = {},
  ) {
    this.#api = api;
    this.#hooks = hooks;
    this.#render = render;
    this.#storage = storage;
    this.#requestTimeoutMs = browserTimeout(options.requestTimeoutMs, DEFAULT_BROWSER_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.#settingsMutationTimeoutMs = browserTimeout(
      options.settingsMutationTimeoutMs,
      DEFAULT_SETTINGS_MUTATION_TIMEOUT_MS,
      "settingsMutationTimeoutMs",
    );
    this.#snapshot = {
      loadState: "idle",
      profiles: [],
      rootsByProfile: new Map(),
      filters: initialLibraryFilters(),
      facets: EMPTY_CATALOG_FILTERS,
      booksState: "idle",
      stale: false,
      liveUpdatesConnected: false,
      settingsSaving: false,
      settingsRefreshing: false,
      settingsConflict: false,
      settingsDirty: false,
      rescanningRootIds: new Set(),
      sendBusy: false,
      kindleStatus: new Map(),
      kindleStatusCountsByProfile: new Map(),
      kindleInventoryOffset: 0,
      layout: "grid",
      density: "comfortable",
      contextScrollY: 0,
      contextRestoreToken: 0,
      selectedBookIds: new Set(),
      bulkActionBusy: false,
      coverProviderSettings: {
        loadState: "idle",
        editing: false,
        busy: false,
      },
      sendQueueState: "idle",
      sendQueueOpen: false,
      sendQueueBusy: false,
      seriesState: "idle",
      seriesQuery: "",
      seriesSort: "name",
      smartShelves: [],
      smartShelvesState: "idle",
      shelfManagerOpen: false,
      annotations: new Map(),
      healthState: "idle",
      healthBooks: new Map(),
      healthFilter: { type: "all", severity: "all", ignored: false },
      healthOffset: 0,
      metadataLookupState: "idle",
      metadataLookupBusy: false,
      activityOpen: false,
      activityEvents: storage ? readKindleBridgeActivity(storage) : [],
    };
  }

  get snapshot(): CatalogBrowserSnapshot {
    return this.#snapshot;
  }

  async start(): Promise<void> {
    if (this.#snapshot.loadState === "loading" || this.#snapshot.loadState === "ready") return;
    this.#profileOperation?.abort();
    const operation = createCatalogOperation("Catalog startup", this.#requestTimeoutMs);
    this.#profileOperation = operation;
    this.#bookEpoch += 1;
    this.#bookOperation?.abort();
    this.#set({
      loadState: "loading",
      booksState: "loading",
      page: undefined,
      facets: EMPTY_CATALOG_FILTERS,
      error: undefined,
      stale: false,
      pendingBookId: undefined,
      pendingBook: undefined,
      pendingUpdate: undefined,
    }, "all");
    const epoch = ++this.#profileEpoch;
    try {
      const [serviceStatus, profiles] = await operation.wait(Promise.all([
        this.#api.getStatus(operation.signal),
        this.#api.listProfiles(operation.signal),
      ]));
      if (epoch !== this.#profileEpoch) return;
      const remembered = safeStorageGet(this.#storage, ACTIVE_PROFILE_KEY);
      const selected = profiles.find((profile) => profile.id === remembered && profile.enabled)
        ?? profiles.find((profile) => profile.enabled);
      const settingsProfile = selected ?? profiles[0];
      const browsingContext = selected
        ? readLibraryBrowserContext(this.#storage, selected.id)
        : undefined;
      this.#restoredShelfId = browsingContext?.activeShelfId;
      this.#snapshot = {
        ...this.#snapshot,
        loadState: "ready",
        serviceStatus,
        profiles,
        filters: browsingContext?.filters ?? initialLibraryFilters(selected?.id),
        layout: browsingContext?.layout ?? "grid",
        density: browsingContext?.density ?? "comfortable",
        sendQueueOpen: browsingContext?.sendQueueOpen ?? false,
        shelfManagerOpen: browsingContext?.shelfManagerOpen ?? false,
        seriesSort: browsingContext?.seriesSort ?? "name",
        healthFilter: browsingContext?.healthFilter ?? { type: "all", severity: "all", ignored: false },
        healthOffset: 0,
        contextScrollY: browsingContext?.scrollY ?? 0,
        contextRestoreToken: (this.#snapshot.contextRestoreToken ?? 0) + (selected ? 1 : 0),
        settingsLibraryId: settingsProfile?.id,
        error: undefined,
        stale: false,
      };
      this.#render("all");
      this.#openEventStream();
      if (!selected && settingsProfile) {
        this.#snapshot = {
          ...this.#snapshot,
          filters: { ...initialLibraryFilters(), view: "settings" },
          booksState: "idle",
        };
        this.#render("all");
        await this.selectSettingsLibrary(settingsProfile.id, false, operation);
        return;
      }
      if (!selected) {
        const draft = createPrototypeLibrary();
        this.#settingsDraftDirty = true;
        this.#settingsBaselineFingerprint = undefined;
        this.#set({
          filters: { ...this.#snapshot.filters, view: "settings" },
          settingsLibraryId: draft.id,
          settingsDraft: draft,
          settingsDirty: true,
          booksState: "idle",
        }, "all");
        return;
      }
      safeStorageSet(this.#storage, ACTIVE_PROFILE_KEY, selected.id);
      await this.#loadProfile(selected.id, epoch, operation, true);
      if (epoch === this.#profileEpoch) {
        await operation.wait(Promise.resolve(this.#hooks.onActiveProfileChanged?.(selected.id)));
      }
    } catch (error) {
      if (epoch !== this.#profileEpoch) return;
      this.#set({
        loadState: "error",
        booksState: "error",
        error: errorMessage(error, "The catalog service could not be reached."),
      }, "all");
    } finally {
      if (this.#profileOperation === operation) {
        operation.dispose();
        this.#profileOperation = undefined;
      }
    }
  }

  dispose(): void {
    this.#profileEpoch += 1;
    this.#bookEpoch += 1;
    this.#settingsEpoch += 1;
    this.#profilesReloadEpoch += 1;
    this.#eventRefreshEpoch += 1;
    this.#metadataEditorEpoch += 1;
    this.#bookDetailsEpoch += 1;
    this.#coverProviderEpoch += 1;
    this.#matchReviewEpoch += 1;
    this.#extrasEpoch += 1;
    this.#metadataLookupRunEpoch += 1;
    this.#profileOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#bookOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#settingsLoadOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#settingsMutationOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#eventRefreshOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#metadataEditorOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#bookDetailsOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#coverProviderOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#matchReviewOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#queueOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#seriesOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#shelfOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#healthOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#metadataLookupOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    for (const operation of this.#rescanOperations.values()) {
      operation.abort(new DOMException("Catalog browser disposed", "AbortError"));
    }
    this.#profileOperation = undefined;
    this.#bookOperation = undefined;
    this.#settingsLoadOperation = undefined;
    this.#settingsMutationOperation = undefined;
    this.#eventRefreshOperation = undefined;
    this.#metadataEditorOperation = undefined;
    this.#bookDetailsOperation = undefined;
    this.#coverProviderOperation = undefined;
    this.#matchReviewOperation = undefined;
    this.#queueOperation = undefined;
    this.#seriesOperation = undefined;
    this.#shelfOperation = undefined;
    this.#healthOperation = undefined;
    this.#metadataLookupOperation = undefined;
    this.#rescanOperations.clear();
    if (this.#searchTimer !== undefined) window.clearTimeout(this.#searchTimer);
    if (this.#eventTimer !== undefined) window.clearTimeout(this.#eventTimer);
    this.#eventRefreshRunning = false;
    this.#configurationMutationRunning = false;
    this.#activeEventBatch = undefined;
    this.#pendingEventProfileIds.clear();
    this.#latestCatalogEvent = undefined;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
  }

  async retry(): Promise<void> {
    if (this.#kindleActionBusy()) return;
    this.#snapshot = {
      ...this.#snapshot,
      loadState: "idle",
      booksState: "idle",
      page: undefined,
      facets: EMPTY_CATALOG_FILTERS,
      error: undefined,
      stale: false,
      pendingBookId: undefined,
      pendingBook: undefined,
      pendingUpdate: undefined,
      selectedBookIds: new Set(),
      pendingRemoval: undefined,
      bulkActionError: undefined,
    };
    await this.start();
  }

  async selectProfile(profileId: LibraryProfileId): Promise<void> {
    if (this.#kindleActionBusy()) return;
    const profile = this.#snapshot.profiles.find((candidate) => candidate.id === profileId && candidate.enabled);
    if (!profile || profile.id === this.#snapshot.filters.profileId) return;
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    if (this.#snapshot.filters.view === "settings" && !this.#confirmDiscardSettingsChanges()) return;
    this.#persistBrowsingContext();
    const epoch = ++this.#profileEpoch;
    this.#bookEpoch += 1;
    this.#profileOperation?.abort();
    this.#bookOperation?.abort();
    this.#settingsLoadOperation?.abort();
    this.#queueOperation?.abort();
    this.#shelfOperation?.abort();
    this.#healthOperation?.abort();
    this.#metadataLookupOperation?.abort();
    this.#extrasEpoch += 1;
    this.#metadataLookupRunEpoch += 1;
    const operation = createCatalogOperation("Library profile load", this.#requestTimeoutMs);
    this.#profileOperation = operation;
    safeStorageSet(this.#storage, ACTIVE_PROFILE_KEY, profile.id);
    const browsingContext = readLibraryBrowserContext(this.#storage, profile.id);
    this.#restoredShelfId = browsingContext.activeShelfId;
    this.#snapshot = {
      ...this.#snapshot,
      filters: browsingContext.filters,
      layout: browsingContext.layout,
      density: browsingContext.density,
      contextScrollY: browsingContext.scrollY,
      contextRestoreToken: (this.#snapshot.contextRestoreToken ?? 0) + 1,
      sendQueue: undefined,
      sendQueueState: "loading",
      sendQueueOpen: browsingContext.sendQueueOpen ?? false,
      sendQueueBusy: false,
      sendQueueError: undefined,
      smartShelves: [],
      smartShelvesState: "loading",
      activeShelf: undefined,
      shelfManagerOpen: browsingContext.shelfManagerOpen ?? false,
      annotations: new Map(),
      healthState: "loading",
      healthPage: undefined,
      healthBooks: new Map(),
      healthBusySignature: undefined,
      healthError: undefined,
      healthFilter: browsingContext.healthFilter ?? { type: "all", severity: "all", ignored: false },
      healthOffset: 0,
      metadataLookupState: "loading",
      metadataLookupJobs: undefined,
      activeMetadataLookupJob: undefined,
      metadataLookupBusy: false,
      metadataLookupError: undefined,
      seriesDetail: undefined,
      seriesSort: browsingContext.seriesSort ?? "name",
      settingsLibraryId: profile.id,
      settingsDraft: undefined,
      page: undefined,
      facets: EMPTY_CATALOG_FILTERS,
      booksState: "loading",
      error: undefined,
      pendingBookId: undefined,
      pendingBook: undefined,
      pendingUpdate: undefined,
      selectedBookIds: new Set(),
      pendingRemoval: undefined,
      bulkActionError: undefined,
      announcement: undefined,
      bookDetails: undefined,
      matchReview: undefined,
    };
    this.#render("all");
    try {
      await this.#loadProfile(profile.id, epoch, operation);
      if (epoch === this.#profileEpoch) {
        await operation.wait(Promise.resolve(this.#hooks.onActiveProfileChanged?.(profile.id)));
      }
    } catch (error) {
      if (epoch !== this.#profileEpoch) return;
      const message = errorMessage(error, "This library could not be loaded.");
      if (this.#snapshot.page) this.#set({ stale: true, error: message }, "all");
      else this.#set({ booksState: "error", error: message }, "all");
    } finally {
      if (this.#profileOperation === operation) {
        operation.dispose();
        this.#profileOperation = undefined;
      }
    }
  }

  async setView(view: LibraryView): Promise<void> {
    if (this.#kindleActionBusy() && view !== this.#snapshot.filters.view) return;
    if ((this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) && this.#snapshot.filters.view === "settings" && view !== "settings") return;
    const discardingSettings = this.#snapshot.filters.view === "settings"
      && view !== "settings"
      && this.#settingsDraftDirty;
    if (discardingSettings && !this.#confirmDiscardSettingsChanges()) return;
    if (discardingSettings) {
      this.#settingsEpoch += 1;
      this.#settingsLoadOperation?.abort();
      this.#settingsDraftDirty = false;
      this.#settingsBaselineFingerprint = undefined;
    }
    if (view === "settings") this.#persistBrowsingContext();
    if (view !== this.#snapshot.filters.view) {
      this.#bookEpoch += 1;
      this.#bookOperation?.abort();
    }
    const profileId = this.#snapshot.filters.profileId;
    const leavingKindleView = this.#snapshot.filters.view === "on-kindle" && view !== "on-kindle";
    this.#snapshot = {
      ...this.#snapshot,
      filters: { ...this.#snapshot.filters, view, offset: 0, kindle: view === "on-kindle" || leavingKindleView ? "all" : this.#snapshot.filters.kindle },
      activeShelf: view === "settings" || this.#snapshot.filters.view === "settings"
        ? this.#snapshot.activeShelf
        : undefined,
      pendingBookId: undefined,
      pendingBook: undefined,
      selectedBookIds: new Set(),
      pendingRemoval: undefined,
      bulkActionError: undefined,
      bookDetails: undefined,
      matchReview: undefined,
      settingsError: undefined,
      ...(discardingSettings ? { settingsDraft: undefined, settingsDirty: false } : {}),
    };
    if (view === "settings") {
      void this.loadCoverProviderSettings();
      if (profileId) await this.selectSettingsLibrary(profileId);
      else {
        const draft = this.#snapshot.settingsDraft ?? createPrototypeLibrary();
        this.#settingsDraftDirty = true;
        this.#settingsBaselineFingerprint = undefined;
        this.#snapshot = {
          ...this.#snapshot,
          settingsLibraryId: draft.id,
          settingsDraft: draft,
          settingsDirty: true,
        };
        this.#render("all");
      }
      return;
    }
    if (view === "series") {
      this.#persistBrowsingContext(0);
      this.#render("all");
      await this.loadSeries(this.#snapshot.seriesQuery);
      return;
    }
    if (view === "attention") {
      this.#persistBrowsingContext(0);
      this.#render("all");
      await Promise.all([this.loadCatalogHealth(), this.loadMetadataLookupJobs()]);
      return;
    }
    this.#persistBrowsingContext(0);
    this.#render("all");
    await this.reloadBooks();
  }

  /** Restores a validated, versioned library URL without trusting it as catalog data. */
  async applyLibraryRoute(route: LibraryRouteState): Promise<boolean> {
    if (this.#kindleActionBusy()) return false;
    // A decoded URL owns shareable filter/view state. Prevent a slower
    // startup/profile extras request from applying a saved shelf after this
    // route has already been accepted.
    this.#restoredShelfId = undefined;
    const priorProfileId = this.#snapshot.filters.profileId;
    const priorFilters = this.#snapshot.filters;
    const priorLayout = this.#snapshot.layout;
    const priorSelection = this.#snapshot.selectedBookIds;
    if (route.profileId && route.profileId !== this.#snapshot.filters.profileId) {
      await this.selectProfile(route.profileId);
      this.#restoredShelfId = undefined;
    }
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || (route.profileId !== undefined && route.profileId !== profileId)) return false;
    // Shelf IDs in a URL are profile-scoped references, not trusted query
    // payloads. Resolve them only once the selected profile's shelf request
    // has settled, then combine the canonical shelf query with the routed
    // visible filters. Until then no prior shelf remains active.
    this.#restoredShelfId = route.activeShelfId;
    const shelvesSettled = this.#snapshot.smartShelvesState === "ready"
      || this.#snapshot.smartShelvesState === "error";
    const routedBuiltInShelf = shelvesSettled
      ? BUILT_IN_SMART_SHELVES.find(({ id }) => id === route.activeShelfId)
      : undefined;
    const routedCustomShelf = this.#snapshot.smartShelvesState === "ready"
      ? this.#snapshot.smartShelves.find(({ id }) => id === route.activeShelfId)
      : undefined;
    const routedShelf = routedBuiltInShelf ?? routedCustomShelf;
    if (shelvesSettled) this.#restoredShelfId = undefined;
    if (route.filters.view === "settings") {
      await this.setView("settings");
      this.#set({ layout: route.layout, density: route.density }, "all");
      return true;
    }
    this.#bookEpoch += 1;
    this.#bookOperation?.abort();
    this.#metadataLookupRunEpoch += 1;
    const routedFilters = { ...route.filters, profileId };
    const sameBrowsingContext = priorProfileId === profileId
      && priorLayout === route.layout
      && JSON.stringify(priorFilters) === JSON.stringify(routedFilters);
    this.#snapshot = {
      ...this.#snapshot,
      filters: routedFilters,
      layout: route.layout,
      density: route.density,
      sendQueueOpen: route.overlays.sendQueueOpen,
      shelfManagerOpen: route.overlays.shelfManagerOpen,
      activityOpen: route.overlays.activityOpen,
      activeShelf: routedShelf ? {
        id: routedShelf.id,
        name: routedShelf.name,
        query: routedShelf.query,
        builtIn: routedBuiltInShelf !== undefined,
      } : undefined,
      selectedBookIds: sameBrowsingContext ? priorSelection : new Set(),
      pendingRemoval: undefined,
      pendingUpdate: undefined,
      bookDetails: undefined,
      matchReview: undefined,
      seriesDetail: undefined,
      healthOffset: route.filters.offset,
      bulkActionError: undefined,
    };
    this.#persistBrowsingContext(0);
    this.#render("all");
    if (route.filters.view === "series") await this.loadSeries();
    else if (route.filters.view === "attention") {
      await Promise.all([this.loadCatalogHealth(route.filters.offset), this.loadMetadataLookupJobs()]);
    } else await this.reloadBooks();
    return true;
  }

  async loadSeries(query = ""): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.listSeries) return;
    this.#seriesOperation?.abort();
    const operation = createCatalogOperation("Series list", this.#requestTimeoutMs);
    this.#seriesOperation = operation;
    this.#set({ seriesState: "loading", seriesQuery: query, seriesDetail: undefined }, "all");
    try {
      const request = { q: query.trim() || undefined, limit: 200 };
      const first = await operation.wait(this.#api.listSeries(profileId, { ...request, offset: 0 }, operation.signal));
      const maximumSeries = 5_000;
      if (first.total > maximumSeries) {
        throw new Error(`This profile contains more than ${maximumSeries.toLocaleString()} series. Narrow the series search before continuing.`);
      }
      const items = [...first.items];
      for (let offset = first.items.length; offset < first.total;) {
        const next = await operation.wait(this.#api.listSeries(profileId, { ...request, offset }, operation.signal));
        if (next.items.length === 0) throw new Error("The series index changed while it was loading. Try again.");
        items.push(...next.items);
        offset = items.length;
      }
      const page = { ...first, items: items.slice(0, first.total), limit: Math.max(first.limit, first.total), offset: 0 };
      if (profileId !== this.#snapshot.filters.profileId) return;
      this.#set({ seriesState: "ready", seriesPage: page, seriesQuery: query }, "all");
    } catch (error) {
      this.#set({ seriesState: "error", error: errorMessage(error, "Series could not be loaded.") }, "all");
    } finally {
      if (this.#seriesOperation === operation) {
        operation.dispose();
        this.#seriesOperation = undefined;
      }
    }
  }

  setSeriesSort(sort: "name" | "count"): void {
    if (sort !== "name" && sort !== "count") return;
    if (sort === this.#snapshot.seriesSort) return;
    this.#set({ seriesSort: sort }, "all");
    this.#persistBrowsingContext();
  }

  async openSeries(seriesKey: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.getSeries) return;
    this.#seriesOperation?.abort();
    const operation = createCatalogOperation("Series details", this.#requestTimeoutMs);
    this.#seriesOperation = operation;
    this.#set({ seriesState: "loading", seriesDetail: undefined }, "all");
    try {
      const first = await operation.wait(this.#api.getSeries(profileId, seriesKey, { limit: 200, offset: 0 }, operation.signal));
      const maximumBooks = 5_000;
      if (first.books.total > maximumBooks) {
        throw new Error(`This series contains more than ${maximumBooks.toLocaleString()} books and cannot be queued as an exact set. Narrow or split its series metadata first.`);
      }
      const items = [...first.books.items];
      for (let offset = first.books.items.length; offset < first.books.total;) {
        const next = await operation.wait(this.#api.getSeries(profileId, seriesKey, { limit: 200, offset }, operation.signal));
        if (next.books.items.length === 0) throw new Error("The series changed while it was loading. Try again.");
        items.push(...next.books.items);
        offset = items.length;
      }
      const detail: CatalogSeriesDetail = {
        ...first,
        books: { ...first.books, items: items.slice(0, first.books.total), limit: Math.max(first.books.limit, first.books.total), offset: 0 },
      };
      if (profileId !== this.#snapshot.filters.profileId) return;
      this.#set({ seriesState: "ready", seriesDetail: detail }, "all");
    } catch (error) {
      this.#set({ seriesState: "error", error: errorMessage(error, "This series could not be loaded.") }, "all");
    } finally {
      if (this.#seriesOperation === operation) {
        operation.dispose();
        this.#seriesOperation = undefined;
      }
    }
  }

  closeSeries(): void {
    this.#set({ seriesDetail: undefined }, "all");
  }

  async loadCatalogHealth(requestedOffset = this.#snapshot.healthOffset ?? 0): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.listCatalogIssues) {
      this.#set({ healthState: "error", healthError: "This catalog server does not provide a health inbox." }, "all");
      return;
    }
    this.#healthOperation?.abort();
    const operation = createCatalogOperation("Catalog health load", this.#requestTimeoutMs);
    this.#healthOperation = operation;
    const filter = this.#snapshot.healthFilter;
    this.#set({ healthState: "loading", healthError: undefined }, "all");
    try {
      const query = {
        ...(filter.type === "all" ? {} : { type: filter.type }),
        ...(filter.severity === "all" ? {} : { severity: filter.severity }),
        ignored: filter.ignored,
        limit: 100,
      };
      let page = await operation.wait(this.#api.listCatalogIssues(profileId, {
        ...query,
        offset: Math.max(0, Math.floor(requestedOffset)),
      }, operation.signal));
      const maximumOffset = page.total === 0 ? 0 : Math.floor((page.total - 1) / page.limit) * page.limit;
      if (page.offset > maximumOffset) {
        page = await operation.wait(this.#api.listCatalogIssues(profileId, {
          ...query,
          offset: maximumOffset,
        }, operation.signal));
      }
      if (profileId !== this.#snapshot.filters.profileId) return;
      const bookIds = [...new Set(page.items.flatMap(({ bookIds }) => bookIds))].slice(0, 200);
      let books = new Map<string, CatalogBook>();
      try {
        const hydrated = await operation.wait(this.#hydrateBooks(bookIds, operation.signal));
        books = new Map(hydrated.map((book) => [book.id, book] as const));
      } catch {
        // The inbox remains useful with opaque IDs when a source disappeared
        // between issue derivation and this presentation-only hydration.
      }
      if (profileId !== this.#snapshot.filters.profileId) return;
      this.#set({ healthState: "ready", healthPage: page, healthBooks: books, healthOffset: page.offset, healthError: undefined }, "all");
      this.#persistBrowsingContext();
    } catch (error) {
      if (operation.signal.aborted) return;
      this.#set({ healthState: "error", healthError: errorMessage(error, "The Needs attention inbox could not be loaded.") }, "all");
    } finally {
      if (this.#healthOperation === operation) {
        operation.dispose();
        this.#healthOperation = undefined;
      }
    }
  }

  setCatalogHealthFilter(
    key: "type" | "severity" | "ignored",
    value: CatalogIssueType | CatalogIssueSeverity | boolean | "all",
  ): void {
    const current = this.#snapshot.healthFilter;
    const next = key === "ignored"
      ? { ...current, ignored: value === true }
      : key === "type"
        ? { ...current, type: value as CatalogIssueType | "all" }
        : { ...current, severity: value as CatalogIssueSeverity | "all" };
    this.#snapshot = { ...this.#snapshot, healthFilter: next, healthOffset: 0 };
    this.#persistBrowsingContext();
    void this.loadCatalogHealth(0);
  }

  goToCatalogHealthPage(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || this.#snapshot.healthState === "loading") return;
    this.#snapshot = { ...this.#snapshot, healthOffset: offset };
    void this.loadCatalogHealth(offset);
  }

  async setCatalogIssueIgnored(signature: string, ignored: boolean): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const issue = this.#snapshot.healthPage?.items.find((candidate) => candidate.signature === signature);
    if (!profileId || !issue || !this.#api.updateCatalogIssueDisposition || this.#snapshot.healthBusySignature) return;
    this.#set({ healthBusySignature: signature, healthError: undefined }, "all");
    try {
      await this.#api.updateCatalogIssueDisposition(profileId, signature, {
        expectedRevision: issue.disposition.revision,
        ignored,
      });
      this.#recordActivity({
        id: `issue-${signature}-${Date.now().toString(36)}`,
        kind: "catalog-health",
        tone: "neutral",
        title: ignored ? "Catalog issue ignored" : "Catalog issue restored",
        detail: this.#issueLabel(issue),
        profileId,
      });
      this.#snapshot = { ...this.#snapshot, healthBusySignature: undefined };
      await this.loadCatalogHealth();
    } catch (error) {
      this.#set({
        healthBusySignature: undefined,
        healthError: errorMessage(error, "The issue disposition could not be saved."),
      }, "all");
    }
  }

  async retryCatalogIssue(signature: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const issue = this.#snapshot.healthPage?.items.find((candidate) => candidate.signature === signature);
    if (!profileId || !issue || !this.#api.retryCatalogIssue || this.#snapshot.healthBusySignature) return;
    this.#set({ healthBusySignature: signature, healthError: undefined }, "all");
    try {
      const result = await this.#api.retryCatalogIssue(profileId, signature, {
        expectedRevision: issue.disposition.revision,
      });
      const detail = result.acceptedRootIds.length > 0
        ? `${result.acceptedRootIds.length} source ${result.acceptedRootIds.length === 1 ? "scan was" : "scans were"} accepted.`
        : "No source scan could be started right now.";
      this.#recordActivity({
        id: `issue-retry-${signature}-${Date.now().toString(36)}`,
        kind: "catalog-scan",
        tone: result.blockedRootIds.length > 0 ? "warning" : "neutral",
        title: "Catalog issue retry requested",
        detail,
        profileId,
        ...(result.blockedRootIds.length > 0 ? { action: "rescan" as const } : {}),
      });
      this.#set({
        healthBusySignature: undefined,
        announcement: detail,
      }, "all");
      await this.loadCatalogHealth();
    } catch (error) {
      this.#set({
        healthBusySignature: undefined,
        healthError: errorMessage(error, "The source rescan could not be requested."),
      }, "all");
    }
  }

  async setDuplicatePreference(signature: string, preferredBookId: string | null): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const issue = this.#snapshot.healthPage?.items.find((candidate) => candidate.signature === signature);
    if (!profileId || issue?.type !== "suspected-duplicate" || !this.#api.updateCatalogDuplicatePreference
      || this.#snapshot.healthBusySignature) return;
    this.#set({ healthBusySignature: signature, healthError: undefined }, "all");
    try {
      await this.#api.updateCatalogDuplicatePreference(profileId, signature, {
        expectedRevision: issue.disposition.revision,
        preferredBookId,
      });
      this.#snapshot = { ...this.#snapshot, healthBusySignature: undefined };
      await this.loadCatalogHealth();
    } catch (error) {
      this.#set({
        healthBusySignature: undefined,
        healthError: errorMessage(error, "The preferred duplicate could not be saved."),
      }, "all");
    }
  }

  async loadMetadataLookupJobs(openJobId?: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.listMetadataLookupJobs) {
      this.#set({ metadataLookupState: "error", metadataLookupError: "Bulk metadata lookup is unavailable on this server." }, "all");
      return;
    }
    this.#metadataLookupOperation?.abort();
    const operation = createCatalogOperation("Metadata lookup jobs", this.#requestTimeoutMs);
    this.#metadataLookupOperation = operation;
    this.#set({ metadataLookupState: "loading", metadataLookupError: undefined }, "all");
    try {
      const pageSize = 20;
      const firstPage = await operation.wait(this.#api.listMetadataLookupJobs(
        profileId,
        { limit: pageSize, offset: 0 },
        operation.signal,
      ));
      const reachableTotal = Math.min(firstPage.total, MAX_METADATA_LOOKUP_JOBS_PER_PROFILE);
      const offsets = Array.from(
        { length: Math.max(0, Math.ceil(reachableTotal / pageSize) - 1) },
        (_, index) => (index + 1) * pageSize,
      );
      const remainingPages = await operation.wait(Promise.all(offsets.map((offset) => (
        this.#api.listMetadataLookupJobs!(profileId, { limit: pageSize, offset }, operation.signal)
      ))));
      const jobsById = new Map<string, MetadataLookupJob>();
      for (const job of [firstPage, ...remainingPages].flatMap(({ items }) => items)) {
        if (jobsById.size >= MAX_METADATA_LOOKUP_JOBS_PER_PROFILE) break;
        if (!jobsById.has(job.id)) jobsById.set(job.id, job);
      }
      const page: MetadataLookupJobPage = {
        items: [...jobsById.values()],
        total: reachableTotal,
        limit: MAX_METADATA_LOOKUP_JOBS_PER_PROFILE,
        offset: 0,
      };
      let active = this.#snapshot.activeMetadataLookupJob;
      const requestedId = openJobId ?? active?.id;
      if (requestedId && this.#api.getMetadataLookupJob) {
        const summary = page.items.find(({ id }) => id === requestedId);
        if (summary || openJobId) {
          active = await operation.wait(this.#api.getMetadataLookupJob(profileId, requestedId, operation.signal));
        } else active = undefined;
      }
      if (profileId !== this.#snapshot.filters.profileId) return;
      let healthBooks = this.#snapshot.healthBooks;
      if (active?.entries.length) {
        try {
          const hydrated = await operation.wait(this.#hydrateBooks(
            [...new Set(active.entries.map(({ bookId }) => bookId))].slice(0, 100),
            operation.signal,
          ));
          healthBooks = new Map([...healthBooks, ...hydrated.map((book) => [book.id, book] as const)]);
        } catch {
          // Job state remains actionable even if presentation-only book hydration fails.
        }
      }
      if (profileId !== this.#snapshot.filters.profileId) return;
      this.#set({
        metadataLookupState: "ready",
        metadataLookupJobs: page,
        healthBooks,
        ...(active ? { activeMetadataLookupJob: active } : { activeMetadataLookupJob: undefined }),
        metadataLookupError: undefined,
      }, "all");
    } catch (error) {
      if (operation.signal.aborted) return;
      this.#set({ metadataLookupState: "error", metadataLookupError: errorMessage(error, "Metadata lookup jobs could not be loaded.") }, "all");
    } finally {
      if (this.#metadataLookupOperation === operation) {
        operation.dispose();
        this.#metadataLookupOperation = undefined;
      }
    }
  }

  async createMetadataLookupJob(
    provider: CoverProvider,
    requestedBookIds: readonly string[] = [...this.#snapshot.selectedBookIds],
  ): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const bookIds = [...new Set(requestedBookIds)];
    if (!profileId || bookIds.length === 0 || !this.#api.createMetadataLookupJob || this.#snapshot.metadataLookupBusy) return;
    if (bookIds.length > 100) {
      const message = `Metadata lookup accepts at most 100 books; ${bookIds.length} are selected. Narrow the selection and try again.`;
      this.#set({ metadataLookupError: message, announcement: message }, "all");
      return;
    }
    if (provider === "google-books" && !(await this.#googleBooksConfigured())) {
      this.#set({ metadataLookupError: "Add and test a Google Books API key in Settings, or choose Open Library." }, "all");
      return;
    }
    if (profileId !== this.#snapshot.filters.profileId || this.#snapshot.metadataLookupBusy) return;
    this.#set({ metadataLookupBusy: true, metadataLookupError: undefined }, "all");
    try {
      const key = globalThis.crypto?.randomUUID?.() ?? `metadata-job-${Date.now().toString(36)}-${bookIds.length}`;
      const job = await this.#api.createMetadataLookupJob(profileId, { provider, bookIds }, key);
      this.#set({
        activeMetadataLookupJob: job,
        metadataLookupBusy: false,
        announcement: `Metadata lookup created for ${job.total} ${job.total === 1 ? "book" : "books"}.`,
      }, "all");
      this.#recordActivity({
        id: `metadata-job-${job.id}`,
        kind: "provider-result",
        tone: "neutral",
        title: "Metadata lookup created",
        detail: `${job.total} ${job.total === 1 ? "book" : "books"} queued for review-only lookup.`,
        profileId,
      });
      await this.loadMetadataLookupJobs(job.id);
    } catch (error) {
      this.#recordActivity({
        id: `metadata-job-failed-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Metadata lookup could not be created",
        detail: "No book metadata was changed.",
        profileId,
        action: provider === "google-books" ? "open-settings" : "retry",
      });
      this.#set({ metadataLookupBusy: false, metadataLookupError: errorMessage(error, "The metadata lookup could not be created.") }, "all");
    }
  }

  async createMetadataLookupForIssue(signature: string, provider: CoverProvider): Promise<void> {
    const issue = this.#snapshot.healthPage?.items.find((candidate) => candidate.signature === signature);
    if (!issue || issue.disposition.ignored) return;
    await this.createMetadataLookupJob(provider, issue.bookIds);
  }

  async openMetadataLookupJob(jobId: string): Promise<void> {
    if (!jobId) return;
    await this.loadMetadataLookupJobs(jobId);
  }

  closeMetadataLookupJob(): void {
    this.#metadataLookupRunEpoch += 1;
    this.#set({ activeMetadataLookupJob: undefined, metadataLookupError: undefined }, "all");
  }

  async controlMetadataLookupJob(action: "resume" | "pause" | "cancel" | "retry"): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const job = this.#snapshot.activeMetadataLookupJob;
    if (!profileId || !job || !this.#api.controlMetadataLookupJob
      || (this.#snapshot.metadataLookupBusy && action !== "pause" && action !== "cancel")) return;
    this.#metadataLookupRunEpoch += 1;
    this.#set({ metadataLookupBusy: true, metadataLookupError: undefined }, "all");
    try {
      const next = await this.#api.controlMetadataLookupJob(profileId, job.id, action, { expectedRevision: job.revision });
      this.#set({ activeMetadataLookupJob: next, metadataLookupBusy: false }, "all");
      await this.loadMetadataLookupJobs(next.id);
      this.#recordActivity({
        id: `metadata-job-${next.id}-${action}`,
        kind: "provider-result",
        tone: action === "cancel" ? "warning" : "neutral",
        title: action === "pause" ? "Metadata lookup paused" : action === "cancel" ? "Metadata lookup cancelled" : action === "retry" ? "Failed metadata lookups queued again" : "Metadata lookup resumed",
        detail: `${next.total - next.pending} of ${next.total} books checked.`,
        profileId,
      });
      if ((action === "resume" || action === "retry") && next.status === "running") {
        await this.runMetadataLookupJobStep();
      }
    } catch (error) {
      this.#set({ metadataLookupBusy: false, metadataLookupError: errorMessage(error, `The metadata lookup could not ${action}.`) }, "all");
    }
  }

  async runMetadataLookupJobStep(): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const job = this.#snapshot.activeMetadataLookupJob;
    if (!profileId || !job || !this.#api.runMetadataLookupJobStep || this.#snapshot.metadataLookupBusy) return;
    const runEpoch = ++this.#metadataLookupRunEpoch;
    this.#set({ metadataLookupBusy: true, metadataLookupError: undefined }, "all");
    try {
      let next = job;
      let unchangedSteps = 0;
      do {
        const previous = next;
        next = await this.#api.runMetadataLookupJobStep(profileId, job.id);
        if (runEpoch !== this.#metadataLookupRunEpoch || profileId !== this.#snapshot.filters.profileId) return;
        this.#set({ activeMetadataLookupJob: next, metadataLookupBusy: next.status === "running" }, "all");
        if (next.status !== "running" || next.pending <= 0) break;
        const progressed = next.revision !== previous.revision
          || next.pending !== previous.pending
          || next.ready !== previous.ready
          || next.failed !== previous.failed
          || next.noResults !== previous.noResults;
        unchangedSteps = progressed ? 0 : unchangedSteps + 1;
        if (unchangedSteps >= 3) break;
        // A provider worker may already own the server's bounded execution
        // slot. Back off instead of hot-polling, while leaving pause/cancel
        // responsive through the run epoch above.
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 150 * (unchangedSteps + 1)));
      } while (runEpoch === this.#metadataLookupRunEpoch);
      if (runEpoch !== this.#metadataLookupRunEpoch) return;
      this.#set({ activeMetadataLookupJob: next, metadataLookupBusy: false }, "all");
      await this.loadMetadataLookupJobs(next.id);
      if (next.status === "running") {
        this.#set({
          metadataLookupBusy: false,
          metadataLookupError: "The provider worker is busy. Completed suggestions are saved; choose Start lookup to continue the remaining books.",
        }, "all");
        return;
      }
      this.#recordActivity({
        id: `metadata-job-result-${next.id}-${next.revision}`,
        kind: "provider-result",
        tone: next.failed > 0 ? "warning" : "success",
        title: next.failed > 0 ? "Metadata lookup finished with failures" : "Metadata lookup finished",
        detail: `${next.ready} of ${next.total} books have suggestions ready to review.`,
        profileId,
        ...(next.failed > 0 ? { action: "open-attention" as const } : {}),
      });
    } catch (error) {
      if (runEpoch !== this.#metadataLookupRunEpoch) return;
      this.#recordActivity({
        id: `metadata-job-run-failed-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Metadata lookup stopped",
        detail: "Completed suggestions are retained; remaining books can be resumed.",
        profileId,
        action: "open-attention",
      });
      this.#set({ metadataLookupBusy: false, metadataLookupError: errorMessage(error, "The next metadata lookup could not run.") }, "all");
    }
  }

  toggleActivityCenter(open = !this.#snapshot.activityOpen): void {
    this.#set({ activityOpen: open }, "all");
  }

  acknowledgeActivity(id: string): void {
    const next = this.#snapshot.activityEvents.map((event) => event.id === id ? { ...event, acknowledged: true } : event);
    this.#snapshot = { ...this.#snapshot, activityEvents: buildKindleBridgeActivityHistory(next).events };
    if (this.#storage) persistKindleBridgeActivity(this.#storage, this.#snapshot.activityEvents);
    this.#render("all");
  }

  clearActivityHistory(): void {
    this.#snapshot = { ...this.#snapshot, activityEvents: [] };
    if (this.#storage) persistKindleBridgeActivity(this.#storage, []);
    this.#render("all");
  }

  async queueSeriesBooks(mode: "next" | "all"): Promise<void> {
    const detail = this.#snapshot.seriesDetail;
    const profileId = this.#snapshot.filters.profileId;
    const complete = profileId !== undefined
      && this.#snapshot.kindleInventory?.completeness === "complete"
      && this.#snapshot.kindleInventory.matching?.status === "complete"
      && this.#snapshot.kindleStatusCountsByProfile.has(profileId);
    if (
      !detail
      || !profileId
      || this.#kindleActionBusy()
      || this.#snapshot.sendQueueBusy
      || this.#snapshot.sendQueueState !== "ready"
      || !this.#snapshot.sendQueue
    ) return;
    const candidates = detail.books.items.filter((book) => {
      if (!this.#bookSourceAvailable(book)) return false;
      const status = this.#snapshot.kindleStatus.get(book.id);
      return complete ? status === "not-on-kindle" : status !== "confirmed" && status !== "possible";
    });
    await this.#addBooksToSendQueue(mode === "next" ? candidates.slice(0, 1).map(({ id }) => id) : candidates.map(({ id }) => id));
    if (!complete && candidates.length > 0) {
      this.#set({
        announcement: `${mode === "next" ? 1 : candidates.length} explicit series ${mode === "next" ? "book" : "books"} queued. Kindle absence will be checked after connection.`,
      }, "all");
    }
  }

  async applySmartShelf(shelfId: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || this.#kindleActionBusy()) return;
    const builtIn = BUILT_IN_SMART_SHELVES.find(({ id }) => id === shelfId);
    const custom = this.#snapshot.smartShelves.find(({ id }) => id === shelfId);
    const shelf = builtIn ?? custom;
    if (!shelf) return;
    const filters = smartShelfQueryToLibraryFilters(profileId, shelf.query);
    this.#snapshot = {
      ...this.#snapshot,
      filters,
      activeShelf: { id: shelf.id, name: shelf.name, query: shelf.query, builtIn: builtIn !== undefined },
      selectedBookIds: new Set(),
      shelfManagerOpen: false,
    };
    this.#persistBrowsingContext(0);
    this.#render("all");
    await this.reloadBooks();
  }

  clearSmartShelf(): void {
    if (!this.#snapshot.activeShelf) return;
    const profileId = this.#snapshot.filters.profileId;
    this.#snapshot = {
      ...this.#snapshot,
      activeShelf: undefined,
      filters: initialLibraryFilters(profileId),
      selectedBookIds: new Set(),
    };
    this.#persistBrowsingContext(0);
    this.#render("all");
    void this.reloadBooks();
  }

  toggleShelfManager(open = !this.#snapshot.shelfManagerOpen): void {
    this.#set({ shelfManagerOpen: open }, "all");
    this.#persistBrowsingContext();
  }

  async saveCurrentQueryAsShelf(name: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const trimmed = name.trim();
    if (!profileId || !trimmed || !this.#api.createSmartShelf || this.#snapshot.smartShelvesState === "loading") return;
    this.#set({ smartShelvesState: "loading" }, "all");
    try {
      const created = await this.#api.createSmartShelf(profileId, {
        name: trimmed,
        query: this.#currentSmartShelfQuery(),
        pinned: orderedPinnedSmartShelves(this.#snapshot.smartShelves).length < MAX_PINNED_SMART_SHELVES_PER_PROFILE,
      }, globalThis.crypto?.randomUUID?.() ?? `shelf-${Date.now().toString(36)}`);
      this.#set({
        smartShelves: [...this.#snapshot.smartShelves, created],
        smartShelvesState: "ready",
        announcement: `Smart shelf “${created.name}” saved.`,
      }, "all");
    } catch (error) {
      this.#set({ smartShelvesState: "error", error: errorMessage(error, "The smart shelf could not be saved.") }, "all");
    }
  }

  async toggleSmartShelfPinned(shelfId: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const shelf = this.#snapshot.smartShelves.find(({ id }) => id === shelfId);
    if (!profileId || !shelf || !this.#api.updateSmartShelf) return;
    try {
      const updated = await this.#api.updateSmartShelf(profileId, shelfId, {
        expectedRevision: shelf.revision,
        pinned: shelf.pinnedRank === null,
      });
      this.#set({ smartShelves: this.#snapshot.smartShelves.map((candidate) => candidate.id === shelfId ? updated : candidate) }, "all");
    } catch (error) {
      this.#set({ error: errorMessage(error, "The shelf pin could not be changed.") }, "all");
    }
  }

  async renameSmartShelf(shelfId: string, name: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const shelf = this.#snapshot.smartShelves.find(({ id }) => id === shelfId);
    const trimmed = name.trim();
    if (!profileId || !shelf || !trimmed || trimmed === shelf.name || !this.#api.updateSmartShelf) return;
    this.#set({ smartShelvesState: "loading", error: undefined }, "all");
    try {
      const updated = await this.#api.updateSmartShelf(profileId, shelfId, {
        expectedRevision: shelf.revision,
        name: trimmed,
      });
      this.#set({
        smartShelves: this.#snapshot.smartShelves.map((candidate) => candidate.id === shelfId ? updated : candidate),
        smartShelvesState: "ready",
        ...(this.#snapshot.activeShelf?.id === shelfId ? {
          activeShelf: { ...this.#snapshot.activeShelf, name: updated.name, query: updated.query },
        } : {}),
        announcement: `Smart shelf renamed to “${updated.name}”.`,
      }, "all");
    } catch (error) {
      this.#set({ smartShelvesState: "error", error: errorMessage(error, "The smart shelf could not be renamed.") }, "all");
    }
  }

  async updateSmartShelfToCurrentView(shelfId: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const shelf = this.#snapshot.smartShelves.find(({ id }) => id === shelfId);
    if (!profileId || !shelf || !this.#api.updateSmartShelf) return;
    this.#set({ smartShelvesState: "loading", error: undefined }, "all");
    try {
      const updated = await this.#api.updateSmartShelf(profileId, shelfId, {
        expectedRevision: shelf.revision,
        query: this.#currentSmartShelfQuery(),
      });
      this.#set({
        smartShelves: this.#snapshot.smartShelves.map((candidate) => candidate.id === shelfId ? updated : candidate),
        smartShelvesState: "ready",
        ...(this.#snapshot.activeShelf?.id === shelfId ? {
          activeShelf: { ...this.#snapshot.activeShelf, query: updated.query },
        } : {}),
        announcement: `Smart shelf “${updated.name}” now uses the current view.`,
      }, "all");
      this.#persistBrowsingContext();
    } catch (error) {
      this.#set({ smartShelvesState: "error", error: errorMessage(error, "The smart shelf query could not be updated.") }, "all");
    }
  }

  async movePinnedSmartShelf(shelfId: string, direction: -1 | 1): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.reorderPinnedSmartShelves) return;
    const pinned = [...orderedPinnedSmartShelves(this.#snapshot.smartShelves)];
    const index = pinned.findIndex(({ id }) => id === shelfId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= pinned.length) return;
    [pinned[index], pinned[target]] = [pinned[target]!, pinned[index]!];
    this.#set({ smartShelvesState: "loading", error: undefined }, "all");
    try {
      const updated = await this.#api.reorderPinnedSmartShelves(profileId, {
        shelves: pinned.map(({ id, revision }) => ({ id, expectedRevision: revision })),
      });
      this.#set({ smartShelves: updated, smartShelvesState: "ready" }, "all");
    } catch (error) {
      this.#set({ smartShelvesState: "error", error: errorMessage(error, "The pinned shelf order could not be saved.") }, "all");
    }
  }

  async deleteSmartShelf(shelfId: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const shelf = this.#snapshot.smartShelves.find(({ id }) => id === shelfId);
    if (!profileId || !shelf || !this.#api.deleteSmartShelf) return;
    try {
      await this.#api.deleteSmartShelf(profileId, shelfId, shelf.revision);
      const wasActive = this.#snapshot.activeShelf?.id === shelfId;
      this.#set({
        smartShelves: this.#snapshot.smartShelves.filter(({ id }) => id !== shelfId),
        ...(wasActive ? {
          activeShelf: undefined,
          filters: initialLibraryFilters(profileId),
          selectedBookIds: new Set(),
        } : {}),
      }, "all");
      this.#persistBrowsingContext(0);
      if (wasActive) void this.reloadBooks();
    } catch (error) {
      this.#set({ error: errorMessage(error, "The smart shelf could not be deleted.") }, "all");
    }
  }

  async loadCoverProviderSettings(force = false): Promise<void> {
    const current = this.#snapshot.coverProviderSettings;
    if (!this.#api.listCoverProviderCredentials) return;
    if (!force && (current?.loadState === "loading" || current?.loadState === "ready")) return;
    this.#coverProviderOperation?.abort();
    const operation = createCatalogOperation("Cover provider Settings load", this.#requestTimeoutMs);
    this.#coverProviderOperation = operation;
    const epoch = ++this.#coverProviderEpoch;
    this.#set({ coverProviderSettings: { ...current, loadState: "loading", editing: false, busy: false, error: undefined } }, "all");
    try {
      const states = await operation.wait(this.#api.listCoverProviderCredentials(operation.signal));
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: {
          loadState: "ready",
          googleBooks: states.find((state) => state.provider === "google-books"),
          editing: false,
          busy: false,
        },
      }, "all");
    } catch (error) {
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: {
          ...current,
          loadState: "error",
          editing: false,
          busy: false,
          error: errorMessage(error, "Online cover settings could not be loaded."),
        },
      }, "all");
    } finally {
      if (this.#coverProviderOperation === operation) {
        operation.dispose();
        this.#coverProviderOperation = undefined;
      }
    }
  }

  async #googleBooksConfigured(): Promise<boolean> {
    const current = this.#snapshot.coverProviderSettings;
    if (current?.loadState !== "ready") {
      // Provider credentials are service-global and intentionally stay out of
      // browser storage. Resolve the sanitized state lazily so Google Books
      // works after a reload without making the user visit Settings first.
      await this.loadCoverProviderSettings(current?.loadState === "loading");
    }
    return this.#snapshot.coverProviderSettings?.googleBooks?.configured === true;
  }

  editGoogleBooksCredential(): void {
    const current = this.#snapshot.coverProviderSettings;
    if (!current || current.busy || this.#snapshot.serviceStatus?.settingsMode === "read-only") return;
    this.#set({ coverProviderSettings: { ...current, editing: true, error: undefined } }, "all");
  }

  cancelGoogleBooksCredentialEdit(): void {
    const current = this.#snapshot.coverProviderSettings;
    if (!current || current.busy) return;
    this.#set({ coverProviderSettings: { ...current, editing: false, error: undefined } }, "all");
  }

  async saveAndTestGoogleBooksCredential(apiKey: string): Promise<void> {
    const current = this.#snapshot.coverProviderSettings;
    const saved = current?.googleBooks;
    if (!current || current.busy || !current.editing || !this.#api.saveCoverProviderCredential || !this.#api.testCoverProviderCredential) return;
    if (this.#snapshot.serviceStatus?.settingsMode === "read-only") return;
    const key = apiKey.trim();
    if (!key) {
      this.#set({ coverProviderSettings: { ...current, error: "Enter a Google Books API key." } }, "all");
      return;
    }
    this.#coverProviderOperation?.abort();
    const operation = createCatalogOperation("Google Books credential save and test", this.#settingsMutationTimeoutMs);
    this.#coverProviderOperation = operation;
    const epoch = ++this.#coverProviderEpoch;
    this.#set({ coverProviderSettings: { ...current, busy: true, error: undefined } }, "all");
    try {
      const stored = await operation.wait(this.#api.saveCoverProviderCredential("google-books", {
        apiKey: key,
        expectedRevision: saved?.revision ?? 0,
      }, operation.signal));
      const tested = await operation.wait(this.#api.testCoverProviderCredential("google-books", {
        expectedRevision: stored.revision,
      }, operation.signal));
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: {
          loadState: "ready",
          googleBooks: tested,
          editing: tested.status !== "working",
          busy: false,
          ...(tested.status === "working" ? {} : { error: "The key was saved, but Google Books did not accept the test request." }),
        },
        announcement: tested.status === "working" ? "Google Books cover search is ready." : undefined,
      }, "all");
    } catch (error) {
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: {
          ...current,
          loadState: "ready",
          editing: true,
          busy: false,
          error: errorMessage(error, "The Google Books key could not be saved and tested."),
        },
      }, "all");
    } finally {
      if (this.#coverProviderOperation === operation) {
        operation.dispose();
        this.#coverProviderOperation = undefined;
      }
    }
  }

  async removeGoogleBooksCredential(): Promise<void> {
    const current = this.#snapshot.coverProviderSettings;
    const saved = current?.googleBooks;
    if (!current || current.busy || !saved?.configured || !this.#api.removeCoverProviderCredential) return;
    if (this.#snapshot.serviceStatus?.settingsMode === "read-only") return;
    this.#coverProviderOperation?.abort();
    const operation = createCatalogOperation("Google Books credential removal", this.#settingsMutationTimeoutMs);
    this.#coverProviderOperation = operation;
    const epoch = ++this.#coverProviderEpoch;
    this.#set({ coverProviderSettings: { ...current, busy: true, error: undefined } }, "all");
    try {
      const state = await operation.wait(this.#api.removeCoverProviderCredential("google-books", saved.revision, operation.signal));
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: { loadState: "ready", googleBooks: state, editing: false, busy: false },
        announcement: "Google Books API key removed.",
      }, "all");
    } catch (error) {
      if (epoch !== this.#coverProviderEpoch) return;
      this.#set({
        coverProviderSettings: { ...current, busy: false, error: errorMessage(error, "The Google Books key could not be removed.") },
      }, "all");
    } finally {
      if (this.#coverProviderOperation === operation) {
        operation.dispose();
        this.#coverProviderOperation = undefined;
      }
    }
  }

  updateFilter(key: keyof LibraryFilters, value: string | number): void {
    if (this.#kindleActionBusy()) return;
    if (key === "profileId" || key === "view" || key === "limit") return;
    this.#bookEpoch += 1;
    this.#bookOperation?.abort();
    this.#snapshot = {
      ...this.#snapshot,
      filters: { ...this.#snapshot.filters, [key]: value, offset: key === "offset" ? Number(value) : 0 },
      selectedBookIds: new Set(),
      ...(key === "query" ? { kindleInventoryOffset: 0 } : {}),
      error: undefined,
      bookDetails: undefined,
    };
    this.#persistBrowsingContext(0);
    this.#render(key === "query" && this.#snapshot.filters.view === "on-kindle" ? "results-and-device" : "results");
    if (key === "query") {
      if (this.#searchTimer !== undefined) window.clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => { void this.reloadBooks(); }, 250);
    } else {
      void this.reloadBooks();
    }
  }

  clearFilters(): void {
    if (this.#kindleActionBusy()) return;
    this.#bookEpoch += 1;
    this.#bookOperation?.abort();
    this.#snapshot = {
      ...this.#snapshot,
      filters: clearCatalogFilters(this.#snapshot.filters),
      activeShelf: undefined,
      selectedBookIds: new Set(),
      bookDetails: undefined,
    };
    this.#persistBrowsingContext(0);
    this.#render("all");
    void this.reloadBooks();
  }

  goToPage(offset: number): void {
    if (this.#kindleActionBusy()) return;
    this.#bookEpoch += 1;
    this.#bookOperation?.abort();
    this.#snapshot = {
      ...this.#snapshot,
      filters: { ...this.#snapshot.filters, offset: Math.max(0, offset) },
      selectedBookIds: new Set(),
      bookDetails: undefined,
    };
    this.#persistBrowsingContext(0);
    this.#render("results");
    void this.reloadBooks();
  }

  goToKindleInventoryPage(offset: number): void {
    if (this.#kindleActionBusy()) return;
    this.#snapshot = { ...this.#snapshot, kindleInventoryOffset: Math.max(0, offset) };
    this.#render("device");
  }

  async reloadBooks(
    background = false,
    parentOperation?: CatalogOperationLease,
  ): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId) return;
    this.#bookOperation?.abort();
    const operation = parentOperation
      ? createLinkedCatalogOperation(parentOperation, "Catalog page load")
      : createCatalogOperation("Catalog page load", this.#requestTimeoutMs);
    this.#bookOperation = operation;
    const epoch = ++this.#bookEpoch;
    if (!background) this.#set({ booksState: "loading", error: undefined }, "results");
    try {
      const query = this.#currentBookQuery();
      const confirmed = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "confirmed").map(([bookId]) => bookId);
      const possible = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "possible").map(([bookId]) => bookId);
      const absent = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "not-on-kindle").map(([bookId]) => bookId);
      const unknown = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "unknown").map(([bookId]) => bookId);
      const wantsMatchedView = this.#snapshot.filters.view === "on-kindle";
      const wantsOnKindle = this.#snapshot.filters.kindle === "on-kindle";
      const wantsPossible = this.#snapshot.filters.kindle === "possible";
      const wantsAbsent = this.#snapshot.filters.kindle === "not-on-kindle";
      const wantsUnknown = this.#snapshot.filters.kindle === "unknown";
      const hasProfileComparison = this.#snapshot.kindleStatusCountsByProfile.has(profileId);
      const matched = [...new Set([...confirmed, ...possible])];
      const emptyKindleSelection = (wantsMatchedView && matched.length === 0)
        || (wantsOnKindle && confirmed.length === 0)
        || (wantsPossible && possible.length === 0)
        || (wantsAbsent && absent.length === 0)
        || (wantsUnknown && hasProfileComparison && unknown.length === 0);
      const fetchPage = async (request: ReturnType<typeof catalogQuery>): Promise<CatalogBookPage> => {
        if (emptyKindleSelection) {
          return { items: [], total: 0, limit: request.limit ?? 24, offset: request.offset ?? 0 };
        }
        if (wantsMatchedView || wantsOnKindle || wantsPossible || wantsAbsent || (wantsUnknown && hasProfileComparison)) {
          return this.#api.queryBooks(profileId, {
            ...request,
            includeBookIds: wantsMatchedView ? matched : wantsOnKindle ? confirmed : wantsPossible ? possible : wantsAbsent ? absent : unknown,
          }, operation.signal);
        }
        return this.#api.listBooks(profileId, request, operation.signal);
      };
      let page = await operation.wait(fetchAdaptiveCatalogPage(fetchPage, query));
      if (epoch !== this.#bookEpoch || profileId !== this.#snapshot.filters.profileId) return;
      if (page.items.length === 0 && page.total > 0 && page.offset > 0) {
        const limit = Math.max(1, page.limit || query.limit || 24);
        const safeOffset = Math.floor((page.total - 1) / limit) * limit;
        page = await operation.wait(fetchAdaptiveCatalogPage(fetchPage, { ...query, offset: safeOffset, limit }));
        if (epoch !== this.#bookEpoch || profileId !== this.#snapshot.filters.profileId) return;
        this.#snapshot = {
          ...this.#snapshot,
          filters: { ...this.#snapshot.filters, offset: safeOffset },
        };
      }
      if (epoch !== this.#bookEpoch || profileId !== this.#snapshot.filters.profileId) return;
      this.#set({
        filters: {
          ...this.#snapshot.filters,
          offset: page.offset,
          limit: page.limit,
        },
        page,
        selectedBookIds: new Set(this.#snapshot.selectedBookIds),
        booksState: "ready",
        stale: false,
        error: undefined,
      }, "results");
      void this.#loadAnnotations(profileId, page.items, epoch);
      this.#persistBrowsingContext();
    } catch (error) {
      if (epoch !== this.#bookEpoch) return;
      const message = errorMessage(error, "Books could not be loaded.");
      if (this.#snapshot.page) {
        this.#set({ booksState: "ready", stale: true, error: message }, "all");
      } else {
        this.#set({ booksState: "error", error: message }, "results");
      }
    } finally {
      if (this.#bookOperation === operation) {
        operation.dispose();
        this.#bookOperation = undefined;
      }
    }
  }

  async selectSettingsLibrary(
    profileId: string,
    forceReload = false,
    providedOperation?: CatalogOperationLease,
  ): Promise<void> {
    if (this.#snapshot.coverProviderSettings?.loadState === "idle") void this.loadCoverProviderSettings();
    if (!this.#snapshot.profiles.some((candidate) => candidate.id === profileId)) return;
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    if (
      !forceReload
      && profileId === this.#snapshot.settingsLibraryId
      && this.#snapshot.settingsDraft?.id === profileId
    ) {
      this.#render("all");
      return;
    }
    if (!forceReload && profileId !== this.#snapshot.settingsLibraryId && !this.#confirmDiscardSettingsChanges()) return;
    const ownsOperation = providedOperation === undefined;
    if (ownsOperation) this.#settingsLoadOperation?.abort();
    const operation = providedOperation ?? createCatalogOperation("Library Settings load", this.#requestTimeoutMs);
    if (ownsOperation) this.#settingsLoadOperation = operation;
    const epoch = ++this.#settingsEpoch;
    const profilesReloadEpoch = forceReload ? ++this.#profilesReloadEpoch : this.#profilesReloadEpoch;
    const previousActiveProfileId = this.#snapshot.filters.profileId;
    const rootGeneration = this.#rootDataGenerations.get(profileId) ?? 0;
    this.#settingsDraftDirty = false;
    this.#settingsBaselineFingerprint = undefined;
    this.#settingsIdempotencyKey = undefined;
    this.#settingsIdempotencyFingerprint = undefined;
    this.#set({
      settingsLibraryId: profileId,
      settingsDraft: undefined,
      settingsError: undefined,
      settingsDirty: false,
      settingsRefreshing: forceReload,
    }, "all");
    try {
      let freshProfiles: readonly CatalogProfile[];
      let roots: readonly CatalogRoot[];
      if (forceReload) {
        [freshProfiles, roots] = await operation.wait(Promise.all([
          this.#api.listProfiles(operation.signal),
          this.#api.listRoots(profileId, operation.signal),
        ]));
      } else {
        freshProfiles = this.#snapshot.profiles;
        roots = this.#snapshot.rootsByProfile.get(profileId)
          ?? await operation.wait(this.#api.listRoots(profileId, operation.signal));
      }
      if (epoch !== this.#settingsEpoch || this.#snapshot.settingsLibraryId !== profileId) return;
      // A later live configuration refresh owns the newer profile snapshot and
      // will settle this editor once its corresponding roots arrive.
      if (forceReload && profilesReloadEpoch !== this.#profilesReloadEpoch) return;
      const profile = freshProfiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        this.#settingsExternallyChanged = false;
        const activeProfileId = this.#applyProfiles(freshProfiles);
        this.#snapshot = { ...this.#snapshot, settingsRefreshing: false, settingsConflict: false };
        this.#render("all");
        if (activeProfileId && activeProfileId !== previousActiveProfileId) {
          await this.#loadProfile(activeProfileId, this.#profileEpoch, operation, true);
        }
        const fallback = this.#snapshot.settingsLibraryId ?? activeProfileId ?? this.#snapshot.profiles[0]?.id;
        if (fallback) await this.selectSettingsLibrary(fallback, true, operation);
        return;
      }
      const activeProfileId = forceReload
        ? this.#applyProfiles(freshProfiles)
        : this.#snapshot.filters.profileId;
      if (epoch !== this.#settingsEpoch || this.#snapshot.settingsLibraryId !== profileId) return;
      const currentRootGeneration = this.#rootDataGenerations.get(profileId) ?? 0;
      const currentRoots = currentRootGeneration === rootGeneration
        ? roots
        : this.#snapshot.rootsByProfile.get(profileId) ?? roots;
      const draft = settingsDraftFromProfile(profile, currentRoots);
      this.#settingsBaselineFingerprint = settingsDraftFingerprint(draft);
      this.#settingsExternallyChanged = false;
      this.#noteRootDataUpdate(profileId);
      this.#set({
        profiles: freshProfiles,
        rootsByProfile: rootsMapWith(this.#snapshot.rootsByProfile, profileId, currentRoots),
        settingsDraft: draft,
        settingsDirty: false,
        settingsRefreshing: false,
        settingsConflict: false,
      }, "all");
      if (activeProfileId && activeProfileId !== previousActiveProfileId) {
        await this.#loadProfile(activeProfileId, this.#profileEpoch, operation, true);
      }
    } catch (error) {
      if (epoch !== this.#settingsEpoch || this.#snapshot.settingsLibraryId !== profileId) return;
      this.#set({
        settingsRefreshing: false,
        settingsConflict: this.#settingsExternallyChanged,
        settingsError: errorMessage(error, "This library's folders could not be loaded."),
      }, "all");
      if (providedOperation) throw error;
    } finally {
      if (ownsOperation && this.#settingsLoadOperation === operation) {
        operation.dispose();
        this.#settingsLoadOperation = undefined;
      }
    }
  }

  newLibrary(): void {
    if (this.#snapshot.serviceStatus?.settingsMode === "read-only") {
      this.#set({ settingsError: "Settings are locked by this server. New libraries cannot be created here." }, "all");
      return;
    }
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing || !this.#confirmDiscardSettingsChanges()) return;
    const draft = createPrototypeLibrary();
    this.#settingsEpoch += 1;
    this.#settingsLoadOperation?.abort();
    this.#settingsDraftDirty = true;
    this.#settingsExternallyChanged = false;
    this.#settingsBaselineFingerprint = undefined;
    this.#settingsIdempotencyKey = undefined;
    this.#settingsIdempotencyFingerprint = undefined;
    this.#set({
      settingsLibraryId: draft.id,
      settingsDraft: draft,
      settingsDirty: true,
      settingsConflict: false,
      settingsError: undefined,
      confirmDeleteLibraryId: undefined,
      announcement: "New library draft created. Add its container folder path, then save changes.",
    }, "all");
  }

  setSettingsDraft(draft: LibrarySettingsDraft, render = false): void {
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    this.#settingsDraftDirty = this.#settingsBaselineFingerprint === undefined
      || settingsDraftFingerprint(draft) !== this.#settingsBaselineFingerprint;
    this.#snapshot = {
      ...this.#snapshot,
      settingsDraft: draft,
      settingsDirty: this.#settingsDraftDirty,
      settingsError: undefined,
    };
    if (render) this.#render("all");
  }

  addSettingsFolder(): void {
    const draft = this.#snapshot.settingsDraft;
    if (!draft || this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    this.#settingsDraftDirty = true;
    this.#set({
      settingsDraft: { ...draft, folders: [...draft.folders, createPrototypeFolder(draft.folders, draft.id)] },
      settingsDirty: true,
      announcement: "Folder added to this library draft.",
    }, "all");
  }

  removeSettingsFolder(folderId: string): void {
    const draft = this.#snapshot.settingsDraft;
    if (!draft || draft.folders.length <= 1 || this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    this.#settingsDraftDirty = true;
    this.#set({
      settingsDraft: { ...draft, folders: draft.folders.filter((folder) => folder.id !== folderId) },
      settingsDirty: true,
      announcement: "Folder removed from the draft. Save changes to apply it.",
    }, "all");
  }

  async cancelSettingsChanges(): Promise<void> {
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    const profileId = this.#snapshot.settingsLibraryId;
    if (!profileId) return;
    if (!this.#snapshot.settingsDraft?.persisted) {
      const fallback = this.#snapshot.filters.profileId ?? this.#snapshot.profiles[0]?.id;
      this.#settingsDraftDirty = false;
      this.#snapshot = { ...this.#snapshot, settingsDirty: false };
      if (fallback) {
        await this.selectSettingsLibrary(fallback, true);
      } else {
        const draft = createPrototypeLibrary();
        this.#settingsDraftDirty = true;
        this.#settingsBaselineFingerprint = undefined;
        this.#set({
          settingsLibraryId: draft.id,
          settingsDraft: draft,
          settingsDirty: true,
          settingsConflict: false,
          settingsError: undefined,
          announcement: "New library draft reset.",
        }, "all");
      }
      return;
    }
    this.#settingsDraftDirty = false;
    this.#snapshot = { ...this.#snapshot, settingsDirty: false };
    await this.selectSettingsLibrary(profileId, true);
  }

  async saveSettings(): Promise<void> {
    const current = this.#snapshot.settingsDraft;
    if (!current || this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    if (this.#settingsExternallyChanged) {
      this.#set({
        settingsError: "This library changed in another browser. Cancel your draft to load the current server configuration, then reapply your changes.",
      }, "all");
      return;
    }
    if (this.#snapshot.serviceStatus?.settingsMode === "read-only") {
      this.#set({ settingsError: "Settings are locked by this server. Container configuration is read-only." }, "all");
      return;
    }
    const normalized = normalizeLibraryDraft(current);
    const validation = validateLibraryDraft(normalized, this.#snapshot.profiles);
    if (validation) {
      this.#set({ settingsDraft: normalized, settingsError: validation, announcement: undefined }, "all");
      return;
    }
    this.#beginConfigurationMutation();
    this.#set({ settingsDraft: normalized, settingsSaving: true, settingsError: undefined }, "all");
    let savedProfileId = normalized.id;
    const request = {
      profileId: normalized.persisted ? normalized.id : undefined,
      profile: profileInput(normalized),
      roots: normalized.folders.map((folder) => ({ ...rootInput(folder), id: folder.persisted ? folder.id : undefined })),
    };
    const fingerprint = JSON.stringify(request);
    if (this.#settingsIdempotencyFingerprint !== fingerprint) {
      this.#settingsIdempotencyKey = `catalog-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.#settingsIdempotencyFingerprint = fingerprint;
    }
    const settingsEpoch = this.#settingsEpoch;
    this.#settingsMutationOperation?.abort();
    const operation = createCatalogOperation("Saving library Settings", this.#settingsMutationTimeoutMs);
    this.#settingsMutationOperation = operation;
    try {
      const configuration = await operation.wait(this.#api.saveConfiguration(
        request,
        this.#settingsIdempotencyKey as string,
        operation.signal,
      ));
      savedProfileId = configuration.profile.id;
      this.#noteRootDataUpdate(savedProfileId);
      this.#snapshot = {
        ...this.#snapshot,
        rootsByProfile: rootsMapWith(this.#snapshot.rootsByProfile, savedProfileId, configuration.roots),
      };
      const activeProfileId = await this.#reloadProfiles(operation);
      if (activeProfileId === savedProfileId) {
        const activeRootIds = new Set(configuration.roots.filter((root) => root.enabled).map((root) => root.id));
        if (this.#snapshot.filters.rootId !== "all" && !activeRootIds.has(this.#snapshot.filters.rootId)) {
          this.#snapshot = {
            ...this.#snapshot,
            filters: { ...this.#snapshot.filters, rootId: "all", offset: 0 },
          };
        }
      }
      // A configuration edit can affect the active profile directly or through
      // a shared root. Refresh its roots, facets, and page without changing the
      // selected profile.
      if (activeProfileId) {
        await this.#loadProfile(activeProfileId, this.#profileEpoch, operation, true);
      }
      this.#set({
        settingsSaving: false,
        settingsError: undefined,
        announcement: `“${normalized.name}” was saved on the Kindle Bridge server.`,
      }, "all");
      this.#settingsDraftDirty = false;
      this.#settingsExternallyChanged = false;
      this.#snapshot = { ...this.#snapshot, settingsDirty: false, settingsConflict: false };
      await this.selectSettingsLibrary(savedProfileId, true, operation);
      this.#settingsIdempotencyKey = undefined;
      this.#settingsIdempotencyFingerprint = undefined;
    } catch (error) {
      if (settingsEpoch === this.#settingsEpoch) {
        this.#set({
          settingsSaving: false,
          settingsError: errorMessage(error, "The library settings could not be saved."),
        }, "all");
      }
    } finally {
      if (this.#settingsMutationOperation === operation) {
        operation.dispose();
        this.#settingsMutationOperation = undefined;
      }
      this.#finishConfigurationMutation();
    }
  }

  requestDeleteSettings(): void {
    const draft = this.#snapshot.settingsDraft;
    if (this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing || this.#snapshot.settingsConflict) return;
    if (this.#snapshot.serviceStatus?.settingsMode === "read-only") {
      this.#set({ settingsError: "Settings are locked by this server. Libraries cannot be deleted here." }, "all");
      return;
    }
    if (!draft?.persisted) {
      void this.cancelSettingsChanges();
      return;
    }
    this.#set({ confirmDeleteLibraryId: draft.id }, "all");
  }

  cancelDeleteSettings(): void {
    if (this.#snapshot.settingsSaving) return;
    this.#set({ confirmDeleteLibraryId: undefined }, "all");
  }

  async confirmDeleteSettings(): Promise<void> {
    const profileId = this.#snapshot.confirmDeleteLibraryId;
    if (!profileId || this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing || this.#snapshot.settingsConflict) return;
    this.#beginConfigurationMutation();
    this.#set({ settingsSaving: true, settingsError: undefined }, "all");
    const settingsEpoch = this.#settingsEpoch;
    this.#settingsMutationOperation?.abort();
    const operation = createCatalogOperation("Deleting library Settings", this.#settingsMutationTimeoutMs);
    this.#settingsMutationOperation = operation;
    try {
      const previousActiveProfileId = this.#snapshot.filters.profileId;
      await operation.wait(this.#api.deleteProfile(profileId, operation.signal));
      const activeProfileId = await this.#reloadProfiles(operation);
      this.#snapshot = {
        ...this.#snapshot,
        settingsSaving: false,
        confirmDeleteLibraryId: undefined,
        announcement: "Library configuration deleted. Original source files were not changed.",
      };
      this.#settingsDraftDirty = false;
      if (activeProfileId) {
        if (activeProfileId !== previousActiveProfileId) {
          await this.#loadProfile(activeProfileId, this.#profileEpoch, operation, true);
        }
        await this.selectSettingsLibrary(activeProfileId, false, operation);
      } else {
        const draft = createPrototypeLibrary();
        this.#settingsDraftDirty = true;
        this.#settingsBaselineFingerprint = undefined;
        this.#set({
          filters: { ...initialLibraryFilters(), view: "settings" },
          settingsLibraryId: draft.id,
          settingsDraft: draft,
          settingsDirty: true,
        }, "all");
      }
    } catch (error) {
      if (settingsEpoch === this.#settingsEpoch) {
        this.#set({ settingsSaving: false, settingsError: errorMessage(error, "The library could not be deleted.") }, "all");
      }
    } finally {
      if (this.#settingsMutationOperation === operation) {
        operation.dispose();
        this.#settingsMutationOperation = undefined;
      }
      this.#finishConfigurationMutation();
    }
  }

  async rescanRoot(rootId: string): Promise<void> {
    const profileId = this.#snapshot.settingsLibraryId;
    if (!profileId || rootId.startsWith("draft-") || this.#snapshot.settingsSaving || this.#snapshot.settingsRefreshing) return;
    const settingsEpoch = this.#settingsEpoch;
    const operationKey = `${profileId}\0${rootId}`;
    this.#rescanOperations.get(operationKey)?.abort();
    const operation = createCatalogOperation("Starting source scan", this.#requestTimeoutMs);
    this.#rescanOperations.set(operationKey, operation);
    this.#set({
      rescanningRootIds: new Set([...this.#snapshot.rescanningRootIds, rootId]),
      settingsError: undefined,
    }, "all");
    try {
      await operation.wait(this.#api.rescanRoot(profileId, rootId, operation.signal));
      if (settingsEpoch === this.#settingsEpoch && profileId === this.#snapshot.settingsLibraryId) {
        this.#recordActivity({
          id: `catalog-scan-${Date.now().toString(36)}`,
          kind: "catalog-scan",
          tone: "neutral",
          title: "Source scan started",
          detail: "New and changed books will appear after the bounded scan completes.",
          profileId,
        });
        this.#set({
          settingsError: undefined,
          announcement: "Source scan started. New and changed books will appear automatically.",
        }, "all");
      }
    } catch (error) {
      if (settingsEpoch === this.#settingsEpoch && profileId === this.#snapshot.settingsLibraryId) {
        this.#recordActivity({
          id: `catalog-scan-failed-${Date.now().toString(36)}`,
          kind: "failure",
          tone: "error",
          title: "Source scan could not start",
          detail: "Review source availability and try again.",
          profileId,
          action: "open-settings",
        });
        this.#set({ settingsError: errorMessage(error, "The source scan could not be started.") }, "all");
      }
    } finally {
      if (this.#rescanOperations.get(operationKey) === operation) {
        operation.dispose();
        this.#rescanOperations.delete(operationKey);
      }
      const next = new Set(this.#snapshot.rescanningRootIds);
      next.delete(rootId);
      this.#set({ rescanningRootIds: next }, "all");
    }
  }

  setLayout(layout: LibraryLayout): void {
    if (layout !== "grid" && layout !== "list") return;
    if (this.#kindleActionBusy() || layout === this.#snapshot.layout) return;
    this.#set({
      layout,
      selectedBookIds: layout === "list" ? this.#snapshot.selectedBookIds : new Set(),
      bulkActionError: undefined,
    }, "results");
    this.#persistBrowsingContext();
  }

  setDensity(density: LibraryDensity): void {
    if (density !== "comfortable" && density !== "compact") return;
    if (this.#kindleActionBusy() || density === (this.#snapshot.density ?? "comfortable")) return;
    this.#set({ density }, "all");
    this.#persistBrowsingContext();
  }

  setScrollPosition(scrollY: number): void {
    if (!Number.isFinite(scrollY) || scrollY < 0 || !this.#snapshot.filters.profileId) return;
    this.#snapshot = { ...this.#snapshot, contextScrollY: Math.floor(scrollY) };
    this.#persistBrowsingContext();
  }

  toggleBookSelection(bookId: string, selected?: boolean): void {
    if (this.#snapshot.layout !== "list" || this.#kindleActionBusy()) return;
    if (!this.#snapshot.page?.items.some((book) => book.id === bookId)) return;
    const next = new Set(this.#snapshot.selectedBookIds);
    const shouldSelect = selected ?? !next.has(bookId);
    if (shouldSelect && !next.has(bookId) && next.size >= MAX_BOOK_SELECTION_IDS) {
      this.#set({
        bulkActionError: `A selection can contain at most ${MAX_BOOK_SELECTION_IDS.toLocaleString()} books. Clear or narrow it before adding more.`,
      }, "results");
      return;
    }
    if (shouldSelect) next.add(bookId);
    else next.delete(bookId);
    this.#set({ selectedBookIds: next, bulkActionError: undefined }, "results");
  }

  toggleVisibleBookSelection(): void {
    if (this.#snapshot.layout !== "list" || this.#kindleActionBusy()) return;
    const visibleIds = this.#snapshot.page?.items.map((book) => book.id) ?? [];
    if (visibleIds.length === 0) return;
    const next = new Set(this.#snapshot.selectedBookIds);
    const allSelected = visibleIds.every((bookId) => next.has(bookId));
    const additions = allSelected ? 0 : visibleIds.filter((bookId) => !next.has(bookId)).length;
    if (next.size + additions > MAX_BOOK_SELECTION_IDS) {
      this.#set({
        bulkActionError: `A selection can contain at most ${MAX_BOOK_SELECTION_IDS.toLocaleString()} books. Clear or narrow it before selecting this page.`,
      }, "results");
      return;
    }
    for (const bookId of visibleIds) {
      if (allSelected) next.delete(bookId);
      else next.add(bookId);
    }
    this.#set({ selectedBookIds: next, bulkActionError: undefined }, "results");
  }

  clearBookSelection(): void {
    if (this.#kindleActionBusy() || this.#snapshot.selectedBookIds.size === 0) return;
    this.#set({ selectedBookIds: new Set(), bulkActionError: undefined }, "results");
  }

  toggleSendQueue(open = !this.#snapshot.sendQueueOpen): void {
    this.#set({ sendQueueOpen: open, sendQueueError: undefined }, "all");
    this.#persistBrowsingContext();
  }

  async addBookToSendQueue(bookId: string): Promise<void> {
    await this.#addBooksToSendQueue([bookId]);
  }

  async addSelectedBooksToSendQueue(): Promise<void> {
    await this.#addBooksToSendQueue([...this.#snapshot.selectedBookIds]);
  }

  async #addBooksToSendQueue(bookIds: readonly string[]): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const queue = this.#snapshot.sendQueue;
    const uniqueBookIds = [...new Set(bookIds)];
    if (
      !profileId
      || !queue
      || this.#snapshot.sendQueueBusy
      || this.#kindleActionBusy()
      || !this.#api.addSendQueueEntries
    ) return;
    if (uniqueBookIds.length > MAX_BOOK_SELECTION_IDS) {
      this.#set({
        sendQueueError: `At most ${MAX_BOOK_SELECTION_IDS.toLocaleString()} selected books can be added at once.`,
      }, "all");
      return;
    }
    this.#set({ sendQueueBusy: true, sendQueueError: undefined }, "all");
    let next = queue;
    let addedCount = 0;
    let attemptedCount = uniqueBookIds.length;
    try {
      const currentBooks = await this.#hydrateBooks(uniqueBookIds);
      if (profileId !== this.#snapshot.filters.profileId) return;
      const existing = new Set(queue.entries.map(({ bookId }) => bookId));
      const added = currentBooks.filter((book) => {
        const status = this.#snapshot.kindleStatus.get(book.id);
        return !existing.has(book.id)
          && this.#bookSourceAvailable(book)
          && status !== "confirmed"
          && status !== "possible";
      }).map(({ id }) => id);
      attemptedCount = added.length;
      if (added.length === 0) {
        this.#set({
          sendQueueBusy: false,
          announcement: "No selected book is currently eligible for Send later, or they are already queued.",
        }, "all");
        return;
      }
      for (let offset = 0; offset < added.length; offset += 500) {
        const batch = added.slice(offset, offset + 500);
        const idempotencyKey = globalThis.crypto?.randomUUID?.()
          ?? `queue-${Date.now().toString(36)}-${offset.toString(36)}-${batch.length.toString(36)}`;
        next = await this.#api.addSendQueueEntries(profileId, {
          expectedRevision: next.revision,
          bookIds: batch,
        }, idempotencyKey);
        addedCount += batch.length;
        if (profileId === this.#snapshot.filters.profileId) {
          this.#snapshot = { ...this.#snapshot, sendQueue: next, sendQueueState: "ready" };
        }
      }
      if (profileId !== this.#snapshot.filters.profileId) return;
      this.#recordActivity({
        id: `queue-add-${Date.now().toString(36)}`,
        kind: "queue-change",
        tone: "neutral",
        title: "Send later updated",
        detail: `${addedCount} ${addedCount === 1 ? "book was" : "books were"} added.`,
        profileId,
        action: "open-queue",
      });
      this.#set({
        sendQueue: next,
        sendQueueState: "ready",
        sendQueueBusy: false,
        announcement: `${addedCount} ${addedCount === 1 ? "book" : "books"} added to Send later.`,
      }, "all");
    } catch (error) {
      if (profileId !== this.#snapshot.filters.profileId) return;
      const remaining = attemptedCount - addedCount;
      const fallback = addedCount > 0
        ? `${addedCount} books were added, but ${remaining} could not be queued. Review Send later before retrying.`
        : "The books could not be queued.";
      this.#recordActivity({
        id: `queue-add-failed-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: addedCount > 0 ? "Send later was partly updated" : "Send later update failed",
        detail: addedCount > 0 ? `${addedCount} added; ${remaining} remain.` : "No selected books were added.",
        profileId,
        action: "open-queue",
      });
      this.#set({
        sendQueue: next,
        sendQueueBusy: false,
        sendQueueError: addedCount > 0 ? `${fallback} ${errorMessage(error, "")}`.trim() : errorMessage(error, fallback),
        ...(addedCount > 0 ? { announcement: fallback } : {}),
      }, "all");
    }
  }

  async #preserveFailedUpdateInQueue(
    book: CatalogBook,
    updateOperation: number,
  ): Promise<{ readonly preserved: boolean; readonly error?: string }> {
    const queue = this.#snapshot.sendQueue;
    if (queue?.entries.some((entry) => entry.bookId === book.id)) return { preserved: true };
    if (
      !queue
      || this.#snapshot.sendQueueState !== "ready"
      || !this.#api.addSendQueueEntries
      || this.#snapshot.filters.profileId !== book.profileId
    ) {
      return { preserved: false, error: "Send later is unavailable, so the retry could not be saved." };
    }
    try {
      const next = await this.#api.addSendQueueEntries(book.profileId, {
        expectedRevision: queue.revision,
        bookIds: [book.id],
      }, `update-retry-${updateOperation.toString(36)}-${Date.now().toString(36)}`);
      if (this.#snapshot.filters.profileId !== book.profileId) {
        return { preserved: false, error: "The active library changed before the retry could be shown." };
      }
      this.#snapshot = {
        ...this.#snapshot,
        sendQueue: next,
        sendQueueState: "ready",
        sendQueueError: undefined,
      };
      return next.entries.some((entry) => entry.bookId === book.id)
        ? { preserved: true }
        : { preserved: false, error: "The catalog did not retain the edited book in Send later." };
    } catch (error) {
      return {
        preserved: false,
        error: errorMessage(error, "The edited book could not be kept in Send later for retry."),
      };
    }
  }

  async removeBookFromSendQueue(bookId: string): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const queue = this.#snapshot.sendQueue;
    if (!profileId || !queue || this.#snapshot.sendQueueBusy || !this.#api.removeSendQueueEntry) return;
    this.#set({ sendQueueBusy: true, sendQueueError: undefined }, "all");
    try {
      const next = await this.#api.removeSendQueueEntry(profileId, bookId, queue.revision);
      if (profileId === this.#snapshot.filters.profileId) {
        this.#recordActivity({ id: `queue-remove-${Date.now().toString(36)}`, kind: "queue-change", tone: "neutral", title: "Send later updated", detail: "One book was removed.", profileId, action: "open-queue" });
        this.#set({ sendQueue: next, sendQueueBusy: false }, "all");
      }
    } catch (error) {
      this.#set({ sendQueueBusy: false, sendQueueError: errorMessage(error, "The queued book could not be removed.") }, "all");
    }
  }

  async clearSendQueue(): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const queue = this.#snapshot.sendQueue;
    if (!profileId || !queue || queue.entries.length === 0 || this.#snapshot.sendQueueBusy || !this.#api.clearSendQueue) return;
    this.#set({ sendQueueBusy: true, sendQueueError: undefined }, "all");
    try {
      const next = await this.#api.clearSendQueue(profileId, queue.revision);
      if (profileId === this.#snapshot.filters.profileId) {
        this.#recordActivity({ id: `queue-clear-${Date.now().toString(36)}`, kind: "queue-change", tone: "neutral", title: "Send later cleared", detail: `${queue.entries.length} ${queue.entries.length === 1 ? "book was" : "books were"} removed.`, profileId });
        this.#set({ sendQueue: next, sendQueueBusy: false }, "all");
      }
    } catch (error) {
      this.#set({ sendQueueBusy: false, sendQueueError: errorMessage(error, "Send later could not be cleared.") }, "all");
    }
  }

  async moveSendQueueBook(bookId: string, direction: -1 | 1): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    const queue = this.#snapshot.sendQueue;
    if (!profileId || !queue || this.#snapshot.sendQueueBusy || !this.#api.replaceSendQueue) return;
    const index = queue.entries.findIndex((entry) => entry.bookId === bookId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= queue.entries.length) return;
    this.#set({ sendQueueBusy: true, sendQueueError: undefined }, "all");
    try {
      const next = await this.#api.replaceSendQueue(profileId, {
        expectedRevision: queue.revision,
        bookIds: [...reorderedQueueBookIds(queue, bookId, target)],
      });
      if (profileId === this.#snapshot.filters.profileId) this.#set({ sendQueue: next, sendQueueBusy: false }, "all");
    } catch (error) {
      this.#set({ sendQueueBusy: false, sendQueueError: errorMessage(error, "The queue order could not be saved.") }, "all");
    }
  }

  async selectAllFiltered(missingOnly = false): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || !this.#api.resolveBookSelection || this.#kindleActionBusy()) return;
    if (missingOnly && !(this.#snapshot.kindleInventory?.completeness === "complete"
      && this.#snapshot.kindleInventory.matching?.status === "complete"
      && this.#snapshot.kindleStatusCountsByProfile.has(profileId))) {
      this.#set({ announcement: "Connect and complete a fresh Kindle comparison before selecting every missing book." }, "all");
      return;
    }
    this.#set({ bulkActionBusy: true, bulkActionError: undefined }, "all");
    try {
      const selection = await this.#api.resolveBookSelection(profileId, this.#currentBookQuery());
      if (profileId !== this.#snapshot.filters.profileId) return;
      const ids = missingOnly
        ? selection.bookIds.filter((bookId) => this.#snapshot.kindleStatus.get(bookId) === "not-on-kindle")
        : selection.bookIds;
      this.#set({
        selectedBookIds: new Set(ids),
        bulkActionBusy: false,
        announcement: selection.total > selection.bookIds.length
          ? `${ids.length} books selected within the server's ${selection.ceiling}-book safety limit.`
          : `${ids.length} filtered ${missingOnly ? "missing " : ""}${ids.length === 1 ? "book" : "books"} selected.`,
      }, "all");
    } catch (error) {
      this.#set({ bulkActionBusy: false, bulkActionError: errorMessage(error, "The filtered selection could not be resolved.") }, "all");
    }
  }

  async toggleBookAnnotation(bookId: string, field: "favorite" | "wantToRead"): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || this.#kindleActionBusy() || !this.#api.getBookAnnotation || !this.#api.updateBookAnnotation) return;
    this.#set({ bulkActionBusy: true, bulkActionError: undefined }, "all");
    try {
      const current = this.#snapshot.annotations.get(bookId)
        ?? await this.#api.getBookAnnotation(profileId, bookId);
      const next = await this.#api.updateBookAnnotation(profileId, bookId, {
        expectedRevision: current.revision,
        [field]: !current[field],
      });
      if (profileId !== this.#snapshot.filters.profileId) return;
      const annotations = new Map(this.#snapshot.annotations);
      annotations.set(bookId, next);
      this.#set({
        annotations,
        bulkActionBusy: false,
        announcement: `${field === "favorite" ? "Favorite" : "Want to read"} ${next[field] ? "added" : "removed"}.`,
      }, "all");
      if (this.#snapshot.activeShelf?.query.personal?.[field] !== undefined) {
        await this.reloadBooks(true);
      }
    } catch (error) {
      this.#set({ bulkActionBusy: false, bulkActionError: errorMessage(error, "The personal book state could not be saved.") }, "all");
    }
  }

  async sendSelectedBooks(): Promise<void> {
    if (this.#snapshot.layout !== "list" || this.#kindleActionBusy()) return;
    const books = (await this.#hydrateBooks([...this.#snapshot.selectedBookIds])).filter((book) => (
      this.#snapshot.kindleStatus.get(book.id) === "not-on-kindle" && this.#bookSourceAvailable(book)
    ));
    await this.#sendBookBatch(books, false);
  }

  async sendQueuedBooks(): Promise<void> {
    const queue = this.#snapshot.sendQueue;
    if (!queue || this.#kindleActionBusy()) return;
    const currentComparisonComplete = this.#snapshot.kindleInventory?.completeness === "complete"
      && this.#snapshot.kindleInventory.matching?.status === "complete"
      && this.#snapshot.kindleStatusCountsByProfile.has(queue.profileId);
    const review = buildSendQueueReview({
      queue,
      kindleStatusByBookId: this.#snapshot.kindleStatus,
      currentComparisonComplete,
    });
    const eligible = new Set(review.eligibleBookIds);
    const books = queue.entries
      .filter((entry) => eligible.has(entry.bookId) && entry.book !== null)
      .map((entry) => entry.book!);
    if (books.length > 0) this.#set({ sendQueueOpen: false }, "all");
    await this.#sendBookBatch(books, true);
  }

  async #hydrateBooks(bookIds: readonly string[], signal?: AbortSignal): Promise<CatalogBook[]> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || bookIds.length === 0) return [];
    const visible = new Map((this.#snapshot.page?.items ?? []).map((book) => [book.id, book] as const));
    const missing = bookIds.filter((bookId) => !visible.has(bookId));
    for (let offset = 0; offset < missing.length; offset += 200) {
      const ids = missing.slice(offset, offset + 200);
      const page = await this.#api.queryBooks(profileId, { includeBookIds: ids, limit: 200, offset: 0 }, signal);
      for (const book of page.items) visible.set(book.id, book);
    }
    return bookIds.flatMap((bookId) => {
      const book = visible.get(bookId);
      return book ? [book] : [];
    });
  }

  async #sendBookBatch(books: readonly CatalogBook[], dequeueVerified: boolean): Promise<void> {
    if (books.length === 0) {
      this.#set({ announcement: "None of the selected books are currently eligible to send." }, "all");
      return;
    }
    if (!this.#hooks.onSendRequested) {
      this.#set({ announcement: "This build has no Kindle transfer hook configured." }, "all");
      return;
    }

    const batchId = `catalog-batch-${Date.now().toString(36)}-${(++this.#batchOperationSequence).toString(36)}`;
    const verifiedBooks: CatalogBatchTransferBook[] = [];
    let failed: (CatalogBatchTransferBook & { readonly message: string }) | undefined;
    let failedIndex = -1;
    this.#set({
      bulkActionBusy: true,
      bulkActionError: undefined,
      announcement: undefined,
      batchTransfer: {
        id: batchId,
        position: 1,
        total: books.length,
        verifiedBooks: [],
        retryBooks: [],
      },
    }, "all");
    for (let index = 0; index < books.length; index += 1) {
      let book = books[index]!;
      this.#set({
        pendingBookId: book.id,
        pendingBook: book,
        sendBusy: true,
        sendPhase: "preparing",
        sendProgress: 0,
        sendMessage: "Checking the indexed source",
        batchTransfer: {
          id: batchId,
          position: index + 1,
          total: books.length,
          verifiedBooks: [...verifiedBooks],
          retryBooks: [],
        },
      }, "all");
      try {
        if (dequeueVerified) {
          const currentQueue = await this.#api.getSendQueue?.(book.profileId);
          const queuedEntry = currentQueue?.entries.find(({ bookId }) => bookId === book.id);
          if (currentQueue && book.profileId === this.#snapshot.filters.profileId) {
            this.#snapshot = { ...this.#snapshot, sendQueue: currentQueue, sendQueueState: "ready" };
          }
          if (!queuedEntry || queuedEntry.sourceState !== "ready") {
            throw new Error(queuedEntry
              ? "The queued source or presentation changed. Review and re-add this book before sending."
              : "This book is no longer in Send later.");
          }
        }
        const currentPage = await this.#api.queryBooks(book.profileId, {
          includeBookIds: [book.id],
          limit: 1,
          offset: 0,
        });
        const currentBook = currentPage.items.find(({ id }) => id === book.id);
        if (!currentBook || !this.#bookSourceAvailable(currentBook)) {
          throw new Error("The read-only source is no longer available.");
        }
        if (this.#snapshot.kindleStatus.get(book.id) !== "not-on-kindle") {
          throw new Error("A current complete Kindle comparison no longer proves this book is missing.");
        }
        book = currentBook;
        this.#snapshot = { ...this.#snapshot, pendingBook: currentBook };
        await this.#hooks.onSendRequested({
          profileId: book.profileId,
          book,
          batch: { id: batchId, position: index + 1, total: books.length },
        });
        verifiedBooks.push({ id: book.id, title: book.title });
        this.#set({
          sendPhase: "complete",
          sendProgress: 100,
          sendMessage: `“${book.title}” transferred and verified.`,
          batchTransfer: {
            id: batchId,
            position: index + 1,
            total: books.length,
            verifiedBooks: [...verifiedBooks],
            retryBooks: [],
          },
        }, "all");
      } catch (error) {
        failedIndex = index;
        failed = {
          id: book.id,
          title: book.title,
          message: errorMessage(error, "This book could not be sent."),
        };
        break;
      }
    }

    const retryBooks = failedIndex < 0
      ? []
      : books.slice(failedIndex).map(({ id, title }) => ({ id, title }));
    const result: CatalogSendBatchResult = {
      id: batchId,
      total: books.length,
      succeeded: [...verifiedBooks],
      unsent: retryBooks,
      ...(failed === undefined ? {} : { failed }),
    };
    if (failed) {
      this.#set({
        sendPhase: "failed",
        sendMessage: `Failed on “${failed.title}”: ${failed.message} Finalizing the Kindle comparison for ${verifiedBooks.length} verified ${verifiedBooks.length === 1 ? "book" : "books"}.`,
        batchTransfer: {
          id: batchId,
          position: failedIndex + 1,
          total: books.length,
          verifiedBooks: [...verifiedBooks],
          retryBooks,
          failedBook: { id: failed.id, title: failed.title },
        },
      }, "all");
    } else {
      this.#set({
        sendPhase: "verifying",
        sendProgress: 100,
        sendMessage: "All selected books are verified; completing one final library comparison.",
      }, "all");
    }
    try {
      await this.#hooks.onSendBatchFinished?.(result);
    } catch {
      // MTP verification is already authoritative. A batch-finalization hook
      // must never turn verified writes into an ambiguous transfer result.
    }
    if (dequeueVerified && verifiedBooks.length > 0) {
      await this.#dequeueVerifiedBooks(new Set(verifiedBooks.map(({ id }) => id)));
    }

    if (failed) {
      const selectedBookIds = new Set(retryBooks.map(({ id }) => id));
      const verifiedSummary = `${verifiedBooks.length} of ${books.length} ${verifiedBooks.length === 1 ? "book" : "books"} transferred and verified.`;
      const retrySummary = `${retryBooks.length} unsent ${retryBooks.length === 1 ? "book remains" : "books remain"} selected for retry.`;
      const message = `${verifiedSummary} Failed on “${failed.title}”: ${failed.message} ${retrySummary}`;
      this.#recordActivity({
        id: `transfer-batch-failed-${batchId}`,
        kind: "failure",
        tone: "error",
        title: "Kindle batch stopped",
        detail: `Failed on “${failed.title}”. ${verifiedBooks.length} of ${books.length} books transferred and verified; ${retryBooks.length} remain for retry.`,
        ...(books[0] ? { profileId: books[0].profileId } : {}),
        action: dequeueVerified ? "open-queue" : "retry-transfer",
      });
      this.#set({
        bulkActionBusy: false,
        bulkActionError: message,
        sendBusy: false,
        sendPhase: "failed",
        sendProgress: Math.round(100 * verifiedBooks.length / books.length),
        sendMessage: message,
        selectedBookIds,
        batchTransfer: {
          id: batchId,
          position: failedIndex + 1,
          total: books.length,
          verifiedBooks: [...verifiedBooks],
          retryBooks,
          failedBook: { id: failed.id, title: failed.title },
        },
      }, "all");
      return;
    }

    const selectedBookIds = new Set(this.#snapshot.selectedBookIds);
    for (const { id } of verifiedBooks) selectedBookIds.delete(id);
    const summary = `${verifiedBooks.length} of ${books.length} books transferred and verified.`;
    this.#recordActivity({
      id: `transfer-batch-${batchId}`,
      kind: "transfer-result",
      tone: "success",
      title: "Kindle batch verified",
      detail: summary,
      ...(books[0] ? { profileId: books[0].profileId } : {}),
    });
    this.#set({
      bulkActionBusy: false,
      bulkActionError: undefined,
      sendBusy: false,
      sendPhase: "complete",
      sendProgress: 100,
      sendMessage: summary,
      selectedBookIds,
      batchTransfer: {
        id: batchId,
        position: books.length,
        total: books.length,
        verifiedBooks: [...verifiedBooks],
        retryBooks: [],
      },
      announcement: summary,
    }, "all");
  }

  async #dequeueVerifiedBooks(verifiedBookIds: ReadonlySet<string>): Promise<void> {
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId || verifiedBookIds.size === 0 || !this.#api.replaceSendQueue || !this.#api.getSendQueue) return;
    try {
      const current = await this.#api.getSendQueue(profileId);
      const retainedBookIds = current.entries
        .map(({ bookId }) => bookId)
        .filter((bookId) => !verifiedBookIds.has(bookId));
      if (retainedBookIds.length === current.entries.length) return;
      const next = await this.#api.replaceSendQueue(profileId, {
        expectedRevision: current.revision,
        bookIds: retainedBookIds,
      });
      if (profileId === this.#snapshot.filters.profileId) this.#snapshot = { ...this.#snapshot, sendQueue: next };
    } catch (error) {
      // The verified transfer remains successful. Keeping every prior entry
      // is the accurate retry-visible outcome when one coalesced persistence
      // mutation fails; the final reconciliation marks those copies present.
      this.#snapshot = {
        ...this.#snapshot,
        sendQueueError: errorMessage(error, "Verified books could not be removed from Send later."),
      };
    }
  }

  requestBookRemoval(bookId: string): void {
    this.#requestRemoval([bookId]);
  }

  async openMetadataEditor(bookId: string): Promise<void> {
    if (this.#kindleActionBusy()) return;
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId) return;
    let book = this.#snapshot.page?.items.find((candidate) => candidate.id === bookId)
      ?? this.#snapshot.healthBooks.get(bookId);
    if (!book) {
      try {
        book = await this.#api.getBook(profileId, bookId);
      } catch (error) {
        this.#set({ announcement: errorMessage(error, "This book could not be opened for metadata review.") }, "all");
        return;
      }
    }
    if (!this.#api.getBookMetadata) {
      this.#set({ announcement: "This catalog server does not support metadata editing yet." }, "all");
      return;
    }
    this.#metadataEditorOperation?.abort();
    const operation = createCatalogOperation("Book metadata load", this.#requestTimeoutMs);
    this.#metadataEditorOperation = operation;
    const epoch = ++this.#metadataEditorEpoch;
    this.#set({
      metadataEditor: {
        profileId: book.profileId,
        bookId: book.id,
        title: book.title,
        loadState: "loading",
        draftOverrides: {},
        busy: false,
        coverSearch: {
          provider: "open-library",
          query: [book.title, ...book.authors].filter(Boolean).join(" "),
          loadState: "idle",
          items: [],
        },
        metadataSearch: {
          provider: "open-library",
          terms: {
            title: book.title,
            ...(book.authors[0] ? { author: book.authors[0] } : {}),
            ...(book.identifiers[0] ? { identifier: book.identifiers[0] } : {}),
          },
          loadState: "idle",
          items: [],
          selectedFields: new Set(),
          includeCover: false,
        },
      },
      announcement: undefined,
    }, "all");
    try {
      const data = await operation.wait(this.#api.getBookMetadata(book.profileId, book.id, operation.signal));
      if (epoch !== this.#metadataEditorEpoch || this.#snapshot.metadataEditor?.bookId !== book.id) return;
      this.#set({
        metadataEditor: {
          ...this.#snapshot.metadataEditor,
          title: data.book.title,
          loadState: "ready",
          data,
          draftOverrides: { ...data.overrides },
          error: undefined,
        },
      }, "all");
    } catch (error) {
      if (epoch !== this.#metadataEditorEpoch || this.#snapshot.metadataEditor?.bookId !== book.id) return;
      this.#set({
        metadataEditor: {
          ...this.#snapshot.metadataEditor,
          loadState: "error",
          error: errorMessage(error, "This book's editable metadata could not be loaded."),
        },
      }, "all");
    } finally {
      if (this.#metadataEditorOperation === operation) {
        operation.dispose();
        this.#metadataEditorOperation = undefined;
      }
    }
  }

  async openBookDetails(bookId: string): Promise<void> {
    if (this.#kindleActionBusy()) return;
    const profileId = this.#snapshot.filters.profileId;
    if (!profileId) return;
    const visibleBook = this.#snapshot.page?.items.find((candidate) => candidate.id === bookId);
    this.#bookDetailsOperation?.abort();
    const operation = createCatalogOperation("Book details load", this.#requestTimeoutMs);
    this.#bookDetailsOperation = operation;
    const epoch = ++this.#bookDetailsEpoch;
    this.#set({
      bookDetails: {
        profileId,
        bookId,
        loadState: "loading",
        ...(visibleBook ? { book: visibleBook } : {}),
      },
      announcement: undefined,
    }, "all");
    try {
      if (this.#api.getBookDetails) {
        const data = await operation.wait(this.#api.getBookDetails(profileId, bookId, operation.signal));
        if (epoch !== this.#bookDetailsEpoch || this.#snapshot.bookDetails?.bookId !== bookId) return;
        this.#set({ bookDetails: { profileId, bookId, loadState: "ready", book: data.book, data } }, "all");
      } else if (this.#api.getBookMetadata) {
        const data = await operation.wait(this.#api.getBookMetadata(profileId, bookId, operation.signal));
        if (epoch !== this.#bookDetailsEpoch || this.#snapshot.bookDetails?.bookId !== bookId) return;
        this.#set({ bookDetails: { profileId, bookId, loadState: "ready", book: data.book, data } }, "all");
      } else {
        const book = await operation.wait(
          visibleBook ? Promise.resolve(visibleBook) : this.#api.getBook(profileId, bookId, operation.signal),
        );
        if (epoch !== this.#bookDetailsEpoch || this.#snapshot.bookDetails?.bookId !== bookId) return;
        this.#set({ bookDetails: { profileId, bookId, loadState: "ready", book } }, "all");
      }
    } catch (error) {
      if (epoch !== this.#bookDetailsEpoch || this.#snapshot.bookDetails?.bookId !== bookId) return;
      this.#set({
        bookDetails: {
          ...this.#snapshot.bookDetails,
          loadState: visibleBook ? "ready" : "error",
          error: errorMessage(error, "This book's details could not be loaded."),
        },
      }, "all");
    } finally {
      if (this.#bookDetailsOperation === operation) {
        operation.dispose();
        this.#bookDetailsOperation = undefined;
      }
    }
  }

  closeBookDetails(): void {
    this.#bookDetailsEpoch += 1;
    this.#bookDetailsOperation?.abort();
    this.#bookDetailsOperation = undefined;
    this.#set({ bookDetails: undefined }, "all");
  }

  async openMatchReview(itemId: string, requestedBookId?: string): Promise<void> {
    if (this.#kindleActionBusy()) return;
    const inventory = this.#snapshot.kindleInventory;
    const item = inventory?.items.find((candidate) => candidate.id === itemId);
    const activeProfileId = this.#snapshot.filters.profileId;
    const reviewBookId = requestedBookId ?? item?.bookId;
    const recordedExplanation = reviewBookId
      ? inventory?.possibleMatches?.find(({ profileId, bookId }) => (
          bookId === reviewBookId && (!activeProfileId || profileId === activeProfileId)
        ))
      : undefined;
    const catalogOnlyReview = Boolean(
      !item
      && reviewBookId
      && itemId === catalogPossibleMatchReviewId(reviewBookId)
      && this.#snapshot.kindleStatus.get(reviewBookId) === "possible",
    );
    if (!item && !catalogOnlyReview) return;
    const explanation = recordedExplanation ?? (reviewBookId && this.#snapshot.kindleStatus.get(reviewBookId) === "possible"
      ? {
          profileId: activeProfileId ?? "",
          bookId: reviewBookId,
          reason: item?.stalePresentation
            ? "This is an exact older Kindle Bridge presentation, not the book's current metadata and cover version."
            : inventory?.completeness !== "complete"
              ? "The Kindle scan is incomplete, so absence and an exact device candidate cannot be established yet."
              : "Kindle Bridge could not finish an authoritative comparison for this book.",
          evidence: {
            tier: item?.stalePresentation ? "prior-presentation" as const : "reconciliation-incomplete" as const,
            inventoryCompleteness: inventory?.completeness ?? "last-seen" as const,
            ambiguous: !item?.stalePresentation,
            candidateCount: item ? 1 : 0,
            comparisons: {
              title: "not-compared" as const,
              authors: "not-compared" as const,
              identifiers: "not-compared" as const,
              filename: item?.stalePresentation ? "match" as const : "not-compared" as const,
              size: "not-compared" as const,
            },
            strongerProofUnavailable: item?.stalePresentation
              ? "The old embedded identity cannot prove that the current edited presentation is installed."
              : "A complete current inventory and one exact live object are required for stronger proof.",
          },
        } satisfies CatalogPossibleMatchReview
      : undefined);
    const candidates = (item?.candidates ?? []).filter(({ profileId }) => !activeProfileId || profileId === activeProfileId);
    const bookIds = [...new Set([
      ...candidates.map(({ bookId }) => bookId),
      ...(requestedBookId ? [requestedBookId] : []),
      ...(item?.bookId ? [item.bookId] : []),
    ])].slice(0, 32);
    this.#matchReviewOperation?.abort();
    const operation = createCatalogOperation("Possible-match review", this.#requestTimeoutMs);
    this.#matchReviewOperation = operation;
    const epoch = ++this.#matchReviewEpoch;
    this.#set({
      matchReview: {
        itemId,
        ...(requestedBookId ? { requestedBookId } : {}),
        ...(explanation ? { explanation } : {}),
        loadState: bookIds.length > 0 ? "loading" : "ready",
        books: new Map(),
        busy: false,
      },
    }, "all");
    if (bookIds.length === 0) {
      operation.dispose();
      this.#matchReviewOperation = undefined;
      return;
    }
    try {
      const visible = new Map((this.#snapshot.page?.items ?? []).map((book) => [book.id, book] as const));
      const books = await operation.wait(Promise.all(bookIds.map(async (bookId) => {
        const candidate = candidates.find((entry) => entry.bookId === bookId);
        const profileId = candidate?.profileId ?? activeProfileId;
        const cached = visible.get(bookId);
        if (cached) return cached;
        if (!profileId) return undefined;
        try {
          return await this.#api.getBook(profileId, bookId, operation.signal);
        } catch {
          return undefined;
        }
      })));
      if (epoch !== this.#matchReviewEpoch || this.#snapshot.matchReview?.itemId !== itemId) return;
      this.#set({
        matchReview: {
          ...this.#snapshot.matchReview,
          loadState: "ready",
          books: new Map(books.filter((book): book is CatalogBook => book !== undefined).map((book) => [book.id, book] as const)),
        },
      }, "all");
    } catch (error) {
      if (epoch !== this.#matchReviewEpoch || this.#snapshot.matchReview?.itemId !== itemId) return;
      this.#set({
        matchReview: {
          ...this.#snapshot.matchReview,
          loadState: "error",
          error: errorMessage(error, "The match evidence could not be loaded."),
        },
      }, "all");
    } finally {
      if (this.#matchReviewOperation === operation) {
        operation.dispose();
        this.#matchReviewOperation = undefined;
      }
    }
  }

  closeMatchReview(): void {
    if (this.#snapshot.matchReview?.busy) return;
    this.#matchReviewEpoch += 1;
    this.#matchReviewOperation?.abort();
    this.#matchReviewOperation = undefined;
    this.#set({ matchReview: undefined }, "all");
  }

  async decideManualMatch(profileId: string, bookId: string, decision: CatalogManualMatchChoice): Promise<void> {
    const review = this.#snapshot.matchReview;
    const item = this.#snapshot.kindleInventory?.items.find(({ id }) => id === review?.itemId);
    if (!review || review.busy || !item || !this.#hooks.onManualMatchDecision) return;
    if (!(item.candidates ?? []).some((candidate) => candidate.profileId === profileId && candidate.bookId === bookId)) return;
    this.#set({ matchReview: { ...review, busy: true, error: undefined } }, "all");
    try {
      await this.#hooks.onManualMatchDecision({ profileId, bookId, itemId: item.id, decision });
      const current = this.#snapshot.matchReview;
      if (!current || current.itemId !== item.id) return;
      this.#set({ matchReview: { ...current, busy: false, error: undefined } }, "all");
    } catch (error) {
      const current = this.#snapshot.matchReview;
      if (!current || current.itemId !== item.id) return;
      this.#set({
        matchReview: { ...current, busy: false, error: errorMessage(error, "The match choice could not be saved.") },
      }, "all");
    }
  }

  closeMetadataEditor(): void {
    if (this.#snapshot.metadataEditor?.busy) return;
    this.#metadataEditorEpoch += 1;
    this.#metadataEditorOperation?.abort();
    this.#metadataEditorOperation = undefined;
    this.#set({ metadataEditor: undefined }, "all");
  }

  setMetadataCandidateSearchTerms(terms: MetadataCandidateSearchTerms): void {
    const editor = this.#snapshot.metadataEditor;
    if (!editor || editor.busy) return;
    this.#set({
      metadataEditor: {
        ...editor,
        metadataSearch: { ...editor.metadataSearch, terms, error: undefined },
      },
    }, "all");
  }

  async searchBookMetadata(provider: CoverProvider, terms: MetadataCandidateSearchTerms): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const hasTerm = Boolean(terms.title?.trim() || terms.author?.trim() || terms.identifier?.trim());
    if (!editor || editor.busy || !hasTerm || !this.#api.searchBookMetadata) return;
    if (provider === "google-books" && !(await this.#googleBooksConfigured())) {
      const current = this.#snapshot.metadataEditor;
      if (!current || current.bookId !== editor.bookId || current.busy) return;
      this.#set({
        metadataEditor: {
          ...current,
          metadataSearch: {
            ...current.metadataSearch,
            provider,
            terms,
            loadState: "error",
            items: [],
            selectedFields: new Set(),
            includeCover: false,
            error: "Google Books is not configured. Add an API key in Settings or use Open Library.",
          },
        },
      }, "all");
      return;
    }
    const currentEditor = this.#snapshot.metadataEditor;
    if (!currentEditor || currentEditor.bookId !== editor.bookId || currentEditor.busy) return;
    this.#metadataEditorOperation?.abort();
    const operation = createCatalogOperation("Book metadata search", this.#requestTimeoutMs);
    this.#metadataEditorOperation = operation;
    const epoch = ++this.#metadataEditorEpoch;
    this.#set({
      metadataEditor: {
        ...currentEditor,
        metadataSearch: {
          ...currentEditor.metadataSearch,
          provider,
          terms,
          loadState: "loading",
          items: [],
          selectedFields: new Set(),
          includeCover: false,
          error: undefined,
          lookupJobId: undefined,
          selectedCandidateId: undefined,
        },
      },
    }, "all");
    try {
      const result = await operation.wait(this.#api.searchBookMetadata(
        editor.profileId,
        editor.bookId,
        provider,
        terms,
        operation.signal,
      ));
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      this.#set({
        metadataEditor: {
          ...current,
          metadataSearch: {
            ...current.metadataSearch,
            provider: result.provider,
            terms,
            loadState: "ready",
            items: result.items,
            selectedFields: new Set(),
            includeCover: false,
            error: undefined,
          },
        },
      }, "all");
    } catch (error) {
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      this.#set({
        metadataEditor: {
          ...current,
          metadataSearch: {
            ...current.metadataSearch,
            loadState: "error",
            items: [],
            selectedFields: new Set(),
            includeCover: false,
            error: errorMessage(error, `${provider === "google-books" ? "Google Books" : "Open Library"} metadata search failed.`),
          },
        },
      }, "all");
    } finally {
      if (this.#metadataEditorOperation === operation) {
        operation.dispose();
        this.#metadataEditorOperation = undefined;
      }
    }
  }

  selectMetadataCandidate(candidateId: string): void {
    const editor = this.#snapshot.metadataEditor;
    if (!editor || editor.busy || !editor.metadataSearch.items.some((candidate) => candidate.candidateId === candidateId)) return;
    this.#set({
      metadataEditor: {
        ...editor,
        metadataSearch: {
          ...editor.metadataSearch,
          selectedCandidateId: candidateId,
          selectedFields: new Set(),
          includeCover: false,
          error: undefined,
        },
      },
    }, "all");
  }

  setMetadataCandidateField(field: MetadataCandidateField, selected: boolean): void {
    const editor = this.#snapshot.metadataEditor;
    const candidate = editor?.metadataSearch.items.find(({ candidateId }) => candidateId === editor.metadataSearch.selectedCandidateId);
    if (!editor || !candidate || !Object.hasOwn(candidate.metadata, field) || editor.busy) return;
    const selectedFields = new Set(editor.metadataSearch.selectedFields);
    if (selected) selectedFields.add(field);
    else selectedFields.delete(field);
    this.#set({ metadataEditor: { ...editor, metadataSearch: { ...editor.metadataSearch, selectedFields } } }, "all");
  }

  setMetadataCandidateCover(selected: boolean): void {
    const editor = this.#snapshot.metadataEditor;
    const candidate = editor?.metadataSearch.items.find(({ candidateId }) => candidateId === editor.metadataSearch.selectedCandidateId);
    if (!editor || !candidate?.coverCandidateId || editor.busy) return;
    this.#set({ metadataEditor: { ...editor, metadataSearch: { ...editor.metadataSearch, includeCover: selected } } }, "all");
  }

  async importSelectedMetadataCandidate(): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    const search = editor?.metadataSearch;
    const candidate = search?.items.find(({ candidateId }) => candidateId === search.selectedCandidateId);
    if (!editor || !data || !search || !candidate || editor.busy || !this.#api.importBookMetadata) return;
    if (search.selectedFields.size === 0 && !search.includeCover) {
      this.#set({
        metadataEditor: {
          ...editor,
          metadataSearch: { ...search, error: "Choose at least one metadata field or the candidate cover before importing." },
        },
      }, "all");
      return;
    }
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, metadataSearch: { ...search, error: "The current source version is unavailable." } } }, "all");
      return;
    }
    const lookupJobId = search.lookupJobId;
    const revision = data.revision;
    await this.#runMetadataMutation(
      "Importing reviewed metadata",
      (signal) => this.#api.importBookMetadata!(editor.profileId, editor.bookId, {
        provider: candidate.provider,
        candidateId: candidate.candidateId,
        ...(lookupJobId ? { lookupJobId } : {}),
        selectedFields: [...search.selectedFields],
        includeCover: search.includeCover,
        expectedRevision: revision,
        expectedContentHash,
      }, signal),
      "Selected metadata saved without changing the original library file.",
      true,
    );
    const current = this.#snapshot.metadataEditor;
    if (current?.bookId === editor.bookId && current.data && current.data.revision > revision) {
      this.#recordActivity({
        id: `provider-import-${editor.bookId}-${current.data.revision}`,
        kind: "provider-result",
        tone: "success",
        title: "Reviewed metadata imported",
        detail: `Selected ${candidate.provider === "google-books" ? "Google Books" : "Open Library"} fields were saved for “${editor.title}”.`,
        profileId: editor.profileId,
        bookId: editor.bookId,
      });
      this.#set({
        metadataEditor: {
          ...current,
          metadataSearch: {
            ...current.metadataSearch,
            selectedCandidateId: undefined,
            selectedFields: new Set(),
            includeCover: false,
            error: undefined,
          },
        },
      }, "all");
      if (lookupJobId) void this.loadMetadataLookupJobs(lookupJobId);
      void this.loadCatalogHealth();
    } else if (current?.bookId === editor.bookId && current.error) {
      this.#recordActivity({
        id: `provider-import-failed-${editor.bookId}-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Metadata import failed",
        detail: `No reviewed provider fields were applied to “${editor.title}”.`,
        profileId: editor.profileId,
        bookId: editor.bookId,
        action: candidate.provider === "google-books" ? "open-settings" : "open-attention",
      });
    }
  }

  async reviewMetadataLookupCandidate(jobId: string, bookId: string, candidateId: string): Promise<void> {
    const job = this.#snapshot.activeMetadataLookupJob;
    const entry = job?.id === jobId ? job.entries.find((candidate) => candidate.bookId === bookId) : undefined;
    const selected = entry?.candidates.find((candidate) => candidate.candidateId === candidateId);
    if (!job || !entry || !selected) return;
    await this.openMetadataEditor(bookId);
    const editor = this.#snapshot.metadataEditor;
    if (!editor || editor.bookId !== bookId || !editor.data) return;
    this.#set({
      metadataEditor: {
        ...editor,
        metadataSearch: {
          provider: selected.provider,
          terms: editor.metadataSearch.terms,
          loadState: "ready",
          items: entry.candidates,
          selectedCandidateId: selected.candidateId,
          selectedFields: new Set(),
          includeCover: false,
          lookupJobId: job.id,
        },
      },
    }, "all");
  }

  setMetadataEditorDraft(changes: BookMetadataOverrides): void {
    const editor = this.#snapshot.metadataEditor;
    if (!editor || editor.busy) return;
    this.#snapshot = {
      ...this.#snapshot,
      metadataEditor: { ...editor, draftOverrides: changes, error: undefined },
    };
  }

  async saveBookMetadata(): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    if (!editor || !data || editor.busy || !this.#api.updateBookMetadata) return;
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, error: "The current source version is unavailable. Close and reopen the editor before saving." } }, "all");
      return;
    }
    const removedFields = (Object.keys(data.overrides) as Array<keyof BookMetadataOverrides>)
      .filter((field) => !Object.hasOwn(editor.draftOverrides, field));
    if (removedFields.length === 0 && Object.keys(editor.draftOverrides).length === 0 && !data.sourceChanged) {
      this.#set({ announcement: "Metadata already uses the read-only source values." }, "all");
      return;
    }
    await this.#runMetadataMutation(
      "Saving book metadata",
      async (signal) => {
        let current = data;
        if (removedFields.length > 0) {
          if (!this.#api.resetBookMetadata) throw new Error("This catalog server cannot return fields to their source values.");
          current = await this.#api.resetBookMetadata(editor.profileId, editor.bookId, {
            expectedRevision: current.revision,
            expectedContentHash: current.book.contentHash ?? expectedContentHash,
            fields: removedFields,
          }, signal);
        }
        if (Object.keys(editor.draftOverrides).length > 0 || data.sourceChanged) {
          current = await this.#api.updateBookMetadata!(editor.profileId, editor.bookId, {
            expectedRevision: current.revision,
            expectedContentHash: current.book.contentHash ?? expectedContentHash,
            changes: editor.draftOverrides,
          }, signal);
        }
        return current;
      },
      "Metadata saved. The original library file remains unchanged.",
      true,
    );
  }

  async resetBookMetadata(): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    if (!editor || !data || editor.busy || !this.#api.resetBookMetadata) return;
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, error: "The current source version is unavailable. Close and reopen the editor before resetting." } }, "all");
      return;
    }
    await this.#runMetadataMutation(
      "Resetting book metadata",
      (signal) => this.#api.resetBookMetadata!(editor.profileId, editor.bookId, {
        expectedRevision: data.revision,
        expectedContentHash,
      }, signal),
      "Metadata reset to the read-only source values.",
      true,
    );
  }

  async uploadBookCover(image: Blob): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    if (!editor || !data || editor.busy || !this.#api.uploadBookCover) return;
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, error: "The current source version is unavailable. Close and reopen the editor before saving a cover." } }, "all");
      return;
    }
    if (image.size <= 0 || image.size > 12 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(image.type)) {
      this.#set({
        metadataEditor: {
          ...editor,
          error: "Choose a non-empty JPEG, PNG, or WebP image no larger than 12 MiB.",
        },
      }, "all");
      return;
    }
    await this.#runMetadataMutation(
      "Saving custom cover",
      (signal) => this.#api.uploadBookCover!(
        editor.profileId,
        editor.bookId,
        image,
        data.revision,
        expectedContentHash,
        signal,
      ),
      "Custom cover saved without changing the original library file.",
      false,
    );
  }

  async resetBookCover(): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    if (!editor || !data || editor.busy || !data.coverOverride || !this.#api.deleteBookCover) return;
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, error: "The current source version is unavailable. Close and reopen the editor before resetting the cover." } }, "all");
      return;
    }
    await this.#runMetadataMutation(
      "Resetting custom cover",
      (signal) => this.#api.deleteBookCover!(
        editor.profileId,
        editor.bookId,
        data.revision,
        expectedContentHash,
        signal,
      ),
      "Custom cover removed; the source cover is active again.",
      false,
    );
  }

  async searchBookCovers(provider: CoverProvider, query: string): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const normalizedQuery = query.trim();
    if (!editor || editor.busy || !this.#api.searchBookCovers || !normalizedQuery) return;
    if (provider === "google-books" && this.#snapshot.coverProviderSettings?.googleBooks?.configured === false) {
      this.#set({
        metadataEditor: {
          ...editor,
          coverSearch: {
            provider,
            query: normalizedQuery,
            loadState: "error",
            items: [],
            error: "Google Books needs an API key. Add it in Settings, or use Open Library.",
          },
        },
      }, "all");
      return;
    }
    this.#metadataEditorOperation?.abort();
    const operation = createCatalogOperation("Cover search", this.#requestTimeoutMs);
    this.#metadataEditorOperation = operation;
    const epoch = ++this.#metadataEditorEpoch;
    this.#set({
      metadataEditor: {
        ...editor,
        error: undefined,
        coverSearch: { provider, query: normalizedQuery, loadState: "loading", items: [] },
      },
    }, "all");
    try {
      const result = await operation.wait(this.#api.searchBookCovers(
        editor.profileId,
        editor.bookId,
        provider,
        normalizedQuery,
        operation.signal,
      ));
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      this.#set({
        metadataEditor: {
          ...current,
          coverSearch: {
            provider: result.provider,
            query: normalizedQuery,
            loadState: "ready",
            items: result.items,
          },
        },
      }, "all");
    } catch (error) {
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      const unconfiguredGoogleBooks = provider === "google-books"
        && error instanceof CatalogApiError
        && error.code === "provider_not_configured";
      this.#set({
        metadataEditor: {
          ...current,
          coverSearch: {
            provider,
            query: normalizedQuery,
            loadState: "error",
            items: [],
            error: unconfiguredGoogleBooks
              ? "Google Books needs an API key. Add it in Settings, or use Open Library."
              : errorMessage(error, "Cover search failed."),
          },
        },
      }, "all");
    } finally {
      if (this.#metadataEditorOperation === operation) {
        operation.dispose();
        this.#metadataEditorOperation = undefined;
      }
    }
  }

  async importBookCover(candidateId: string): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    const data = editor?.data;
    if (!editor || !data || editor.busy || !this.#api.importBookCover) return;
    const expectedContentHash = data.book.contentHash;
    if (!expectedContentHash) {
      this.#set({ metadataEditor: { ...editor, error: "The current source version is unavailable. Close and reopen the editor before importing a cover." } }, "all");
      return;
    }
    await this.#runMetadataMutation(
      "Importing cover",
      (signal) => this.#api.importBookCover!(editor.profileId, editor.bookId, {
        expectedRevision: data.revision,
        expectedContentHash,
        provider: editor.coverSearch.provider,
        candidateId,
      }, signal),
      "Selected cover saved without changing the original library file.",
      false,
    );
  }

  requestBookUpdate(bookId: string): void {
    if (this.#kindleActionBusy()) return;
    const book = this.#snapshot.page?.items.find((candidate) => candidate.id === bookId)
      ?? (this.#snapshot.bookDetails?.bookId === bookId
        ? this.#snapshot.bookDetails.data?.book ?? this.#snapshot.bookDetails.book
        : undefined)
      ?? this.#snapshot.healthBooks.get(bookId);
    const claims = this.#snapshot.kindleInventory?.items.filter((item) => item.bookId === bookId) ?? [];
    const prior = claims.length === 1
      && claims[0]?.managed === true
      && claims[0].stalePresentation === true
      && claims[0].match === "possible"
      ? claims[0]
      : undefined;
    const versionReady = typeof book?.contentHash === "string"
      && typeof book.presentationVersion === "string"
      && Number.isSafeInteger(book.metadataRevision)
      && (book.metadataRevision ?? -1) >= 0;
    if (!book
      || book.format !== "EPUB"
      || (book.metadataEdited !== true && book.coverEdited !== true)
      || !versionReady
      || !prior) {
      this.#set({
        announcement: "Update is available only for an edited EPUB with exactly one current prior Kindle Bridge-managed copy.",
      }, "all");
      return;
    }
    this.#set({
      pendingUpdate: Object.freeze({ book, priorFilename: prior.filename }),
      announcement: undefined,
      sendPhase: undefined,
      sendProgress: undefined,
      sendMessage: undefined,
      batchTransfer: undefined,
    }, "all");
  }

  cancelBookUpdate(): void {
    if (this.#snapshot.sendBusy) return;
    this.#activeUpdateOperation = undefined;
    this.#set({
      pendingUpdate: undefined,
      sendPhase: undefined,
      sendProgress: undefined,
      sendMessage: undefined,
    }, "all");
  }

  async confirmBookUpdate(): Promise<void> {
    const pending = this.#snapshot.pendingUpdate;
    const book = pending?.book;
    if (!pending || !book || this.#kindleActionBusy()) return;
    if (!this.#hooks.onUpdateRequested) {
      this.#set({
        pendingUpdate: undefined,
        announcement: "This build has no guarded Kindle update hook configured.",
      }, "all");
      return;
    }
    if (!book.contentHash || !book.presentationVersion || !Number.isSafeInteger(book.metadataRevision)) {
      this.#set({
        pendingUpdate: { ...pending, error: "The exact catalog version is unavailable. Refresh before updating." },
      }, "all");
      return;
    }
    const request: CatalogManagedUpdateRequest = {
      profileId: book.profileId,
      bookId: book.id,
      expectedContentHash: book.contentHash,
      expectedPresentationVersion: book.presentationVersion,
      expectedMetadataRevision: book.metadataRevision!,
    };
    const operation = ++this.#updateOperationSequence;
    this.#activeUpdateOperation = operation;
    this.#set({
      pendingUpdate: { ...pending, result: undefined, error: undefined },
      sendBusy: true,
      sendPhase: "preparing",
      sendProgress: 0,
      sendMessage: "Rechecking the edited presentation",
    }, "all");
    try {
      const result = await this.#hooks.onUpdateRequested(request);
      if (this.#activeUpdateOperation !== operation) return;
      this.#activeUpdateOperation = undefined;
      if (result.queueDisposition === "remove") {
        await this.#dequeueVerifiedBooks(new Set([book.id]));
      }
      const complete = result.status === "updated";
      const retryQueue = complete
        ? undefined
        : await this.#preserveFailedUpdateInQueue(book, operation);
      const retryDetail = retryQueue?.preserved
        ? " The edited book remains in Send later for retry."
        : retryQueue?.error ? ` ${retryQueue.error}` : "";
      this.#recordActivity({
        id: `update-${result.operationId}`,
        kind: "update-result",
        tone: complete ? "success" : "warning",
        title: complete ? "Kindle copy updated" : "Kindle update needs attention",
        detail: complete
          ? `“${book.title}” was replaced and verified.`
          : `“${book.title}” kept a verified replacement, but follow-up is required.${retryDetail}`,
        profileId: book.profileId,
        bookId: book.id,
        ...(complete ? {} : { action: retryQueue?.preserved ? "open-queue" as const : "reconnect" as const }),
      });
      this.#set({
        pendingUpdate: { ...pending, result, error: undefined },
        sendBusy: false,
        sendPhase: complete ? "complete" : "failed",
        sendProgress: 100,
        sendMessage: `${result.message}${retryDetail}`,
        ...(retryQueue?.error ? { sendQueueError: retryQueue.error } : {}),
        announcement: complete ? `“${book.title}” was updated on the Kindle and verified.` : undefined,
      }, "all");
    } catch (error) {
      if (this.#activeUpdateOperation !== operation) return;
      this.#activeUpdateOperation = undefined;
      const message = errorMessage(error, "The Kindle copy could not be updated.");
      const retryQueue = await this.#preserveFailedUpdateInQueue(book, operation);
      const retryDetail = retryQueue.preserved
        ? " The edited book remains in Send later for retry."
        : ` ${retryQueue.error ?? "The retry could not be saved in Send later."}`;
      this.#recordActivity({
        id: `update-failed-${Date.now().toString(36)}-${book.id}`,
        kind: "failure",
        tone: "error",
        title: "Kindle update failed",
        detail: `“${book.title}” was not replaced; the prior copy remains the safe copy.${retryDetail}`,
        profileId: book.profileId,
        bookId: book.id,
        action: retryQueue.preserved ? "open-queue" : "reconnect",
      });
      this.#set({
        pendingUpdate: { ...pending, error: `${message}${retryDetail}` },
        sendBusy: false,
        sendPhase: "failed",
        sendMessage: `${message}${retryDetail}`,
        ...(retryQueue.error ? { sendQueueError: retryQueue.error } : {}),
      }, "all");
    }
  }

  async requestSelectedBookRemoval(): Promise<void> {
    if (this.#snapshot.layout !== "list") return;
    const bookIds = [...this.#snapshot.selectedBookIds];
    const books = await this.#hydrateBooks(bookIds);
    this.#requestRemoval(bookIds, books);
  }

  cancelBookRemoval(): void {
    if (this.#snapshot.bulkActionBusy) return;
    this.#set({ pendingRemoval: undefined, bulkActionError: undefined }, "all");
  }

  async confirmBookRemoval(): Promise<void> {
    const request = this.#snapshot.pendingRemoval;
    if (!request || request.targets.length === 0 || this.#kindleActionBusy()) return;
    if (!this.#hooks.onRemoveRequested) {
      this.#set({
        pendingRemoval: undefined,
        announcement: "This build has no Kindle removal hook configured.",
      }, "all");
      return;
    }
    this.#set({ bulkActionBusy: true, bulkActionError: undefined, announcement: undefined }, "all");
    try {
      await this.#hooks.onRemoveRequested(request);
      const removedBookIds = new Set(request.targets.map((target) => target.bookId));
      const selectedBookIds = new Set(this.#snapshot.selectedBookIds);
      for (const bookId of removedBookIds) selectedBookIds.delete(bookId);
      this.#recordActivity({
        id: `removal-${Date.now().toString(36)}`,
        kind: "removal-result",
        tone: "success",
        title: request.targets.length === 1 ? "Kindle copy removed" : "Kindle copies removed",
        detail: request.targets.length === 1
          ? `“${request.targets[0]!.title}” was removed; its library original was unchanged.`
          : `${request.targets.length} exact Kindle files were removed; library originals were unchanged.`,
        profileId: request.profileId,
        ...(request.targets.length === 1 ? { bookId: request.targets[0]!.bookId } : {}),
      });
      this.#set({
        bulkActionBusy: false,
        pendingRemoval: undefined,
        selectedBookIds,
        bulkActionError: undefined,
        announcement: `${request.targets.length} exact Kindle ${request.targets.length === 1 ? "file was" : "files were"} removed. Library originals were not changed.`,
      }, "all");
    } catch (error) {
      this.#recordActivity({
        id: `removal-failed-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Kindle removal failed",
        detail: "No unverified broad deletion was attempted. Review the connected Kindle before retrying.",
        profileId: request.profileId,
        action: "reconnect",
      });
      this.#set({
        bulkActionBusy: false,
        bulkActionError: errorMessage(error, "The selected Kindle files could not all be removed."),
      }, "all");
    }
  }

  openSend(bookId: string): void {
    if (this.#kindleActionBusy()) return;
    const book = this.#snapshot.page?.items.find((candidate) => candidate.id === bookId);
    if (!book) return;
    this.#set({ pendingBookId: book.id, pendingBook: book, announcement: undefined, sendPhase: undefined, sendProgress: undefined, sendMessage: undefined, batchTransfer: undefined }, "all");
    // The card action is the user's explicit Send command. Keep the sheet as
    // live progress/retry UI, but do not require a second confirmation click.
    void this.confirmSend();
  }

  closeSend(): void {
    if (this.#kindleActionBusy()) return;
    this.#activeSendOperation = undefined;
    this.#set({ pendingBookId: undefined, pendingBook: undefined, sendPhase: undefined, sendProgress: undefined, sendMessage: undefined, batchTransfer: undefined, bulkActionError: undefined }, "all");
  }

  async confirmSend(): Promise<void> {
    const book = this.#snapshot.pendingBook;
    const profileId = book?.profileId;
    if (!profileId || !book || this.#kindleActionBusy()) return;
    if (!this.#hooks.onSendRequested) {
      this.#set({
        pendingBookId: undefined,
        pendingBook: undefined,
        announcement: "This build has no Kindle transfer hook configured.",
      }, "all");
      return;
    }
    const operation = ++this.#sendOperationSequence;
    this.#activeSendOperation = operation;
    this.#set({ sendBusy: true, sendPhase: "preparing", sendProgress: 0, sendMessage: "Checking the indexed source", batchTransfer: undefined }, "all");
    try {
      await this.#hooks.onSendRequested({ profileId, book });
      if (this.#activeSendOperation !== operation) return;
      this.#activeSendOperation = undefined;
      // Keep the reconciled status intact: the refreshed inventory is the
      // authority, including Calibre-style association of duplicate copies.
      const terminalMessage = this.#snapshot.sendPhase === "complete"
        ? this.#snapshot.sendMessage
        : undefined;
      this.#recordActivity({
        id: `transfer-${book.id}-${Date.now().toString(36)}`,
        kind: "transfer-result",
        tone: "success",
        title: "Kindle transfer verified",
        detail: `“${book.title}” transferred and verified.`,
        profileId,
        bookId: book.id,
      });
      this.#set({
        sendBusy: false,
        sendPhase: "complete",
        sendProgress: 100,
        sendMessage: terminalMessage ?? "Transfer verified",
        announcement: `The transfer of “${book.title}” was verified. The original source file remains unchanged.`,
      }, "all");
    } catch (error) {
      if (this.#activeSendOperation !== operation) return;
      this.#activeSendOperation = undefined;
      const message = errorMessage(error, "This book could not be sent.");
      this.#recordActivity({
        id: `transfer-failed-${book.id}-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Kindle transfer failed",
        detail: `“${book.title}” was not verified on the Kindle.`,
        profileId,
        bookId: book.id,
        action: "reconnect",
      });
      this.#set({ sendBusy: false, sendPhase: "failed", sendMessage: message, error: message }, "all");
    }
  }

  setTransferUpdate(update: CatalogTransferUpdate): void {
    if (!this.#snapshot.pendingBook && !this.#snapshot.pendingUpdate) return;
    if (
      this.#activeSendOperation === undefined
      && (this.#snapshot.sendPhase === "complete" || this.#snapshot.sendPhase === "failed")
      && update.phase !== "complete"
      && update.phase !== "failed"
    ) return;
    const progress = update.progress === undefined ? this.#snapshot.sendProgress : Math.max(0, Math.min(100, update.progress));
    const terminal = update.phase === "complete" || update.phase === "failed";
    // Progress is presentation state only. Kindle status authority belongs to
    // setKindleStatuses/setKindleInventory after reconciliation.
    this.#set({
      // The awaited hardware hook owns operation lifetime. A controller may
      // publish a terminal presentation update just before its promise settles;
      // keep navigation/close locked until confirmSend observes that settlement.
      sendBusy: this.#snapshot.bulkActionBusy
        ? true
        : this.#activeSendOperation === undefined && this.#activeUpdateOperation === undefined ? !terminal : true,
      sendPhase: update.phase,
      sendProgress: progress,
      sendMessage: update.message,
    }, "all");
  }

  async requestConnect(): Promise<void> {
    if (!this.#hooks.onConnectRequested) {
      this.#set({ announcement: "This build has no WebUSB connection hook configured." }, "all");
      return;
    }
    const profileId = this.#snapshot.filters.profileId;
    this.#recordActivity({
      id: `device-connecting-${Date.now().toString(36)}`,
      kind: "device-phase",
      tone: "neutral",
      title: "Connecting Kindle",
      detail: "Waiting for browser USB permission, safe-write verification, and inventory.",
      phase: "connecting",
      ...(profileId ? { profileId } : {}),
    });
    try {
      await this.#hooks.onConnectRequested();
    } catch (error) {
      this.#recordActivity({
        id: `device-connect-failed-${Date.now().toString(36)}`,
        kind: "failure",
        tone: "error",
        title: "Kindle connection failed",
        detail: "The device did not reach a ready, compared state.",
        ...(profileId ? { profileId } : {}),
        action: "reconnect",
      });
      throw error;
    }
  }

  async requestDisconnect(): Promise<void> {
    if (this.#kindleActionBusy()) return;
    await this.#hooks.onDisconnectRequested?.();
  }

  dismissAnnouncement(): void {
    this.#set({ announcement: undefined }, "all");
  }

  setKindleStatuses(
    entries: ReadonlyMap<string, CatalogKindleStatus>,
    countsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts> = new Map(),
  ): void {
    this.#set({
      kindleStatus: new Map(entries),
      kindleStatusCountsByProfile: new Map(countsByProfile),
    }, "all");
    if (this.#eventStreamExpected && !this.#snapshot.liveUpdatesConnected) this.#downgradeKindleEvidence(false);
    void this.reloadBooks(true);
  }

  setKindleBookStatus(profileId: string, bookId: string, status: CatalogKindleStatus): void {
    const kindleStatus = new Map(this.#snapshot.kindleStatus);
    const previous = kindleStatus.get(bookId);
    kindleStatus.set(bookId, status);
    const kindleStatusCountsByProfile = new Map(this.#snapshot.kindleStatusCountsByProfile);
    const counts = kindleStatusCountsByProfile.get(profileId);
    if (counts && previous !== undefined && previous !== status) {
      const key = (value: CatalogKindleStatus): keyof CatalogKindleStatusCounts => (
        value === "not-on-kindle" ? "notOnKindle" : value
      );
      const previousKey = key(previous);
      const nextKey = key(status);
      const updated = { ...counts };
      updated[previousKey] = Math.max(0, updated[previousKey] - 1);
      updated[nextKey] += 1;
      kindleStatusCountsByProfile.set(profileId, updated);
    } else if (previous === undefined) {
      // Without the prior classification, an incremental count adjustment
      // would be guesswork. Let the visible-page fallback apply until the next
      // full reconciliation supplies authoritative profile totals.
      kindleStatusCountsByProfile.delete(profileId);
    }
    this.#set({ kindleStatus, kindleStatusCountsByProfile }, "all");
    if (this.#eventStreamExpected && !this.#snapshot.liveUpdatesConnected) this.#downgradeKindleEvidence(false);
    void this.reloadBooks(true);
  }

  setKindleInventory(inventory: CatalogKindleInventory | undefined): void {
    const profileId = this.#snapshot.filters.profileId;
    if (!inventory) {
      this.#recordActivity({
        id: `device-disconnected-${Date.now().toString(36)}`,
        kind: "device-phase",
        tone: "neutral",
        title: "Kindle disconnected",
        detail: "Connect by USB when you are ready to compare or transfer books.",
        phase: "disconnected",
        ...(profileId ? { profileId } : {}),
      });
      this.#set({
        kindleInventory: undefined,
        kindleStatus: new Map(),
        kindleStatusCountsByProfile: new Map(),
        pendingRemoval: undefined,
        bulkActionError: undefined,
        matchReview: undefined,
      }, "all");
      void this.reloadBooks(true);
      return;
    }
    const maximumItems = 10_000;
    const items = inventory.items.slice(0, maximumItems).map((item) => ({ ...item }));
    const possibleMatches = inventory.possibleMatches?.slice(0, maximumItems).map((review) => ({ ...review }));
    const retainedMatchReview = this.#snapshot.matchReview
      && (items.some(({ id }) => id === this.#snapshot.matchReview?.itemId)
        || possibleMatches?.some(({ profileId, bookId }) => (
          profileId === this.#snapshot.matchReview?.explanation?.profileId
          && bookId === this.#snapshot.matchReview?.explanation?.bookId
        )))
      ? this.#snapshot.matchReview
      : undefined;
    const statuses = new Map(this.#snapshot.kindleStatus);
    if (inventory.completeness === "last-seen") {
      for (const bookId of statuses.keys()) statuses.set(bookId, "unknown");
    }
    if (inventory.completeness !== "last-seen") {
      for (const item of inventory.items.slice(0, 10_000)) {
        if (!item.bookId || item.match === "unmatched") continue;
        // One exact current copy keeps the book confirmed even when another
        // device item is an exact prior-presentation removal target.
        if (item.match === "confirmed" || statuses.get(item.bookId) !== "confirmed") {
          statuses.set(item.bookId, item.match);
        }
      }
    }
    const countsByProfile = inventory.completeness === "last-seen"
      ? new Map([...this.#snapshot.kindleStatusCountsByProfile].map(([profileId, counts]) => [profileId, {
        confirmed: 0,
        possible: 0,
        unknown: counts.unknown + counts.notOnKindle + counts.possible + counts.confirmed,
        notOnKindle: 0,
      }]))
      : this.#snapshot.kindleStatusCountsByProfile;
    const ready = inventory.completeness === "complete" && inventory.matching?.status === "complete";
    this.#recordActivity({
      id: `device-inventory-${Date.now().toString(36)}`,
      kind: "device-phase",
      tone: ready ? "success" : "neutral",
      title: ready ? "Kindle comparison ready" : "Reading Kindle books",
      detail: ready
        ? `${inventory.total} device ${inventory.total === 1 ? "item was" : "items were"} compared with the current library.`
        : "The current Kindle inventory is still being read or reconciled.",
      phase: ready ? "ready" : "reading-books",
      ...(profileId ? { profileId } : {}),
    });
    this.#set({
      kindleInventory: {
        ...inventory,
        deviceLabel: inventory.deviceLabel.slice(0, 80) || "Connected Kindle",
        items,
        ...(possibleMatches ? { possibleMatches } : {}),
        total: Math.max(inventory.total, inventory.items.length),
        truncated: inventory.truncated || inventory.items.length > maximumItems,
      },
      kindleStatus: statuses,
      kindleStatusCountsByProfile: countsByProfile,
      kindleInventoryOffset: 0,
      matchReview: retainedMatchReview,
    }, "all");
    if (this.#eventStreamExpected && !this.#snapshot.liveUpdatesConnected) this.#downgradeKindleEvidence(false);
    void this.reloadBooks(true);
  }

  #confirmDiscardSettingsChanges(): boolean {
    if (!this.#settingsDraftDirty) return true;
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
    return window.confirm("Discard your unsaved library settings changes?");
  }

  #kindleActionBusy(): boolean {
    return this.#snapshot.sendBusy || this.#snapshot.bulkActionBusy;
  }

  async #runMetadataMutation(
    label: string,
    request: (signal: AbortSignal) => Promise<CatalogBookMetadataState>,
    announcement: string,
    replaceDraft: boolean,
  ): Promise<void> {
    const editor = this.#snapshot.metadataEditor;
    if (!editor || editor.busy) return;
    this.#metadataEditorOperation?.abort();
    const operation = createCatalogOperation(label, this.#settingsMutationTimeoutMs);
    this.#metadataEditorOperation = operation;
    const epoch = ++this.#metadataEditorEpoch;
    this.#set({
      metadataEditor: { ...editor, busy: true, error: undefined },
    }, "all");
    try {
      const data = await operation.wait(request(operation.signal));
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      const page = this.#snapshot.page
        ? {
            ...this.#snapshot.page,
            items: this.#snapshot.page.items.map((book) => book.id === data.book.id ? data.book : book),
          }
        : undefined;
      const kindleStatus = new Map(this.#snapshot.kindleStatus);
      if (kindleStatus.has(data.book.id)) kindleStatus.set(data.book.id, "unknown");
      const kindleStatusCountsByProfile = new Map(this.#snapshot.kindleStatusCountsByProfile);
      kindleStatusCountsByProfile.delete(data.book.profileId);
      this.#set({
        ...(page === undefined ? {} : { page }),
        ...(this.#snapshot.pendingBook?.id === data.book.id ? { pendingBook: data.book } : {}),
        ...(this.#snapshot.pendingUpdate?.book.id === data.book.id ? {
          pendingUpdate: { ...this.#snapshot.pendingUpdate, book: data.book, result: undefined, error: undefined },
        } : {}),
        kindleStatus,
        kindleStatusCountsByProfile,
        metadataEditor: {
          ...current,
          title: data.book.title,
          data,
          draftOverrides: replaceDraft ? { ...data.overrides } : current.draftOverrides,
          busy: false,
          error: undefined,
        },
        ...(this.#snapshot.bookDetails?.bookId === data.book.id ? {
          bookDetails: {
            ...this.#snapshot.bookDetails,
            loadState: "ready" as const,
            book: data.book,
            data,
            error: undefined,
          },
        } : {}),
        announcement,
      }, "all");
      void this.#refreshMetadataAffectedCatalog(data.book.profileId);
    } catch (error) {
      const current = this.#snapshot.metadataEditor;
      if (epoch !== this.#metadataEditorEpoch || current?.bookId !== editor.bookId) return;
      const conflict = error instanceof CatalogApiError && (error.status === 409 || error.status === 412);
      this.#set({
        metadataEditor: {
          ...current,
          busy: false,
          error: conflict
            ? "This book changed after the editor opened. Close and reopen it to load the current source and edits before trying again."
            : errorMessage(error, `${label} failed.`),
        },
      }, "all");
    } finally {
      if (this.#metadataEditorOperation === operation) {
        operation.dispose();
        this.#metadataEditorOperation = undefined;
      }
    }
  }

  async #refreshMetadataAffectedCatalog(profileId: string): Promise<void> {
    try {
      const facets = await this.#api.getFilters(profileId);
      if (profileId === this.#snapshot.filters.profileId) this.#set({ facets }, "all");
      if (profileId === this.#snapshot.filters.profileId) {
        await this.reloadBooks(true);
        await this.#refreshProfileAuxiliarySurfaces(profileId);
      }
    } catch {
      // The successful overlay mutation remains authoritative. The live event
      // stream and the next ordinary page load will retry derived UI data.
    }
  }

  async #refreshProfileAuxiliarySurfaces(profileId: string, event?: CatalogEvent): Promise<void> {
    if (profileId !== this.#snapshot.filters.profileId) return;
    const openSeriesKey = this.#snapshot.seriesDetail?.key;
    const openBookId = this.#snapshot.bookDetails?.bookId;
    await this.#loadProfileExtras(profileId);
    if (profileId !== this.#snapshot.filters.profileId) return;
    if (this.#snapshot.filters.view === "series") {
      await this.loadSeries(this.#snapshot.seriesQuery);
      if (openSeriesKey && profileId === this.#snapshot.filters.profileId) await this.openSeries(openSeriesKey);
    }
    const detailsAffected = openBookId !== undefined
      && (event === undefined || event.bookId === undefined || event.bookId === openBookId || event.rootId !== undefined);
    if (detailsAffected && profileId === this.#snapshot.filters.profileId) await this.openBookDetails(openBookId);
  }

  #bookSourceAvailable(book: CatalogBook): boolean {
    const root = this.#snapshot.rootsByProfile.get(book.profileId)
      ?.find((candidate) => candidate.id === book.rootId);
    return book.available !== false
      && root?.enabled === true
      && ["available", "watching", "paused", "scanning"].includes(root.status);
  }

  #requestRemoval(bookIds: readonly string[], hydratedBooks: readonly CatalogBook[] = []): void {
    if (this.#kindleActionBusy()) return;
    const profileId = this.#snapshot.filters.profileId;
    const inventory = this.#snapshot.kindleInventory;
    if (
      !profileId
      || inventory?.completeness !== "complete"
      || inventory.matching?.status !== "complete"
    ) {
      this.#set({
        bulkActionError: undefined,
        announcement: "Reconnect the Kindle and complete its live comparison before removing books.",
      }, "all");
      return;
    }
    const requestedBookIds = new Set(bookIds);
    const booksById = new Map(
      [...(this.#snapshot.page?.items ?? []), ...hydratedBooks]
        .filter((book) => requestedBookIds.has(book.id))
        .map((book) => [book.id, book] as const),
    );
    const seenItems = new Set<string>();
    const targets: CatalogRemoveTarget[] = [];
    for (const item of inventory.items) {
      if (
        !item.bookId
        || !requestedBookIds.has(item.bookId)
        || (
          item.match !== "confirmed"
          && !(item.stalePresentation === true && item.managed === true && item.match === "possible")
        )
        || seenItems.has(item.id)
      ) continue;
      const book = booksById.get(item.bookId);
      if (!book || book.profileId !== profileId) continue;
      seenItems.add(item.id);
      targets.push(Object.freeze({
        itemId: item.id,
        bookId: book.id,
        title: book.title,
        filename: item.filename,
        size: item.size,
      }));
    }
    if (targets.length === 0) {
      this.#set({
        bulkActionError: undefined,
        announcement: "No selected book has an exact current Kindle association that can be removed safely.",
      }, "all");
      return;
    }
    this.#set({
      pendingRemoval: Object.freeze({ profileId, targets: Object.freeze(targets) }),
      bulkActionError: undefined,
      announcement: undefined,
    }, "all");
  }

  #set(update: Partial<CatalogBrowserSnapshot>, scope: CatalogRenderScope): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    this.#render(scope);
  }

  #issueLabel(issue: CatalogHealthIssue): string {
    return issue.type.replaceAll("-", " ").replace(/^./u, (letter) => letter.toLocaleUpperCase());
  }

  #recordActivity(
    event: Omit<KindleBridgeActivityEvent, "version" | "at" | "acknowledged">,
  ): void {
    const complete: KindleBridgeActivityEvent = Object.freeze({
      version: 1,
      at: new Date().toISOString(),
      acknowledged: false,
      ...event,
    });
    const activityEvents = appendKindleBridgeActivity(this.#snapshot.activityEvents, complete);
    this.#snapshot = { ...this.#snapshot, activityEvents };
    if (this.#storage) persistKindleBridgeActivity(this.#storage, activityEvents);
  }

  #currentSmartShelfQuery(): SmartShelfQuery {
    const visible = libraryFiltersToSmartShelfQuery(this.#snapshot.filters);
    const base = this.#snapshot.activeShelf?.query;
    return {
      version: 1,
      ...((base?.catalog || visible.catalog) ? { catalog: { ...base?.catalog, ...visible.catalog } } : {}),
      ...(base?.personal ? { personal: { ...base.personal } } : {}),
      ...((visible.kindleStatus ?? base?.kindleStatus) === undefined
        ? {}
        : { kindleStatus: visible.kindleStatus ?? base?.kindleStatus }),
    };
  }

  #currentBookQuery(): CatalogBookQuery {
    const shelf = this.#currentSmartShelfQuery();
    return {
      ...catalogQuery(this.#snapshot.filters),
      ...shelf.catalog,
      ...(shelf.personal?.favorite === undefined ? {} : { favorite: shelf.personal.favorite }),
      ...(shelf.personal?.wantToRead === undefined ? {} : { wantToRead: shelf.personal.wantToRead }),
    };
  }

  #persistBrowsingContext(scrollY = this.#snapshot.contextScrollY ?? 0): void {
    if (!this.#snapshot.filters.profileId || this.#snapshot.filters.view === "settings") return;
    writeLibraryBrowserContext(this.#storage, {
      filters: this.#snapshot.filters,
      layout: this.#snapshot.layout,
      density: this.#snapshot.density ?? "comfortable",
      scrollY,
      ...(this.#snapshot.activeShelf ? { activeShelfId: this.#snapshot.activeShelf.id } : {}),
      sendQueueOpen: this.#snapshot.sendQueueOpen,
      shelfManagerOpen: this.#snapshot.shelfManagerOpen,
      seriesSort: this.#snapshot.seriesSort,
      healthFilter: this.#snapshot.healthFilter,
    });
    if (scrollY !== this.#snapshot.contextScrollY) {
      this.#snapshot = { ...this.#snapshot, contextScrollY: scrollY };
    }
  }

  async #loadProfile(
    profileId: string,
    profileEpoch: number,
    operation: CatalogOperationLease,
    propagateErrors = false,
  ): Promise<void> {
    this.#set({ booksState: "loading", error: undefined }, "results");
    this.#bookOperation?.abort();
    const bookEpoch = ++this.#bookEpoch;
    try {
      const initialFilters = this.#snapshot.filters;
      const [roots, facets, pageResult] = await operation.wait(Promise.all([
        this.#api.listRoots(profileId, operation.signal),
        this.#api.getFilters(profileId, operation.signal),
        fetchAdaptiveCatalogPage(
          (query) => this.#api.listBooks(profileId, query, operation.signal),
          catalogQuery(initialFilters),
        ).then(
          (page) => ({ ok: true as const, page }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]));
      if (profileEpoch !== this.#profileEpoch) return;
      const filters = normalizeFacetBackedSelects(this.#snapshot.filters, facets);
      if (bookEpoch !== this.#bookEpoch) {
        const filtersChanged = filters !== this.#snapshot.filters;
        this.#noteRootDataUpdate(profileId);
        this.#set({
          rootsByProfile: rootsMapWith(this.#snapshot.rootsByProfile, profileId, roots),
          filters,
          facets,
        }, "all");
        if (filtersChanged) await operation.wait(this.reloadBooks(true, operation));
        return;
      }
      if (!pageResult.ok) throw pageResult.error;
      const page = filters === this.#snapshot.filters
        ? pageResult.page
        : await operation.wait(fetchAdaptiveCatalogPage(
            (query) => this.#api.listBooks(profileId, query, operation.signal),
            catalogQuery(filters),
          ));
      if (profileEpoch !== this.#profileEpoch || bookEpoch !== this.#bookEpoch) return;
      this.#noteRootDataUpdate(profileId);
      this.#set({
        rootsByProfile: rootsMapWith(this.#snapshot.rootsByProfile, profileId, roots),
        filters: { ...filters, offset: page.offset, limit: page.limit },
        facets,
        page,
        booksState: "ready",
        stale: false,
        error: undefined,
      }, "all");
      void this.#loadAnnotations(profileId, page.items, bookEpoch);
      void this.#loadProfileExtras(profileId);
      void this.loadCatalogHealth();
      void this.loadMetadataLookupJobs();
    } catch (error) {
      if (profileEpoch !== this.#profileEpoch) return;
      const message = errorMessage(error, "This library could not be loaded.");
      if (bookEpoch !== this.#bookEpoch || this.#snapshot.page) {
        this.#set({ stale: true, error: message }, "all");
      } else {
        this.#set({ booksState: "error", error: message }, "all");
      }
      if (propagateErrors && bookEpoch === this.#bookEpoch) throw error;
    }
  }

  async #loadProfileExtras(profileId: string): Promise<void> {
    if (profileId !== this.#snapshot.filters.profileId) return;
    this.#queueOperation?.abort();
    this.#shelfOperation?.abort();
    const queueOperation = createCatalogOperation("Send-later queue load", this.#requestTimeoutMs);
    const shelfOperation = createCatalogOperation("Smart shelves load", this.#requestTimeoutMs);
    this.#queueOperation = queueOperation;
    this.#shelfOperation = shelfOperation;
    const extrasEpoch = ++this.#extrasEpoch;
    this.#set({
      sendQueueState: this.#api.getSendQueue ? "loading" : "error",
      smartShelvesState: this.#api.listSmartShelves ? "loading" : "error",
      sendQueueError: undefined,
    }, "all");
    const [queueResult, shelfResult] = await Promise.all([
      this.#api.getSendQueue
        ? queueOperation.wait(this.#api.getSendQueue(profileId, queueOperation.signal)).then(
            (queue) => ({ ok: true as const, queue }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({ ok: false as const, error: new Error("Queue API unavailable") }),
      this.#api.listSmartShelves
        ? shelfOperation.wait(this.#api.listSmartShelves(profileId, shelfOperation.signal)).then(
            (shelves) => ({ ok: true as const, shelves }),
            (error: unknown) => ({ ok: false as const, error }),
          )
        : Promise.resolve({ ok: false as const, error: new Error("Shelf API unavailable") }),
    ]);
    if (profileId !== this.#snapshot.filters.profileId || extrasEpoch !== this.#extrasEpoch) return;
    const restoredShelfId = this.#restoredShelfId;
    const builtInShelf = BUILT_IN_SMART_SHELVES.find(({ id }) => id === restoredShelfId);
    const customShelf = shelfResult.ok ? shelfResult.shelves.find(({ id }) => id === restoredShelfId) : undefined;
    const restoredShelf = builtInShelf ?? customShelf;
    this.#restoredShelfId = undefined;
    this.#set({
      ...(queueResult.ok
        ? { sendQueue: queueResult.queue, sendQueueState: "ready" as const }
        : { sendQueueState: "error" as const, sendQueueError: errorMessage(queueResult.error, "The send-later queue could not be loaded.") }),
      ...(shelfResult.ok
        ? { smartShelves: shelfResult.shelves, smartShelvesState: "ready" as const }
        : { smartShelvesState: "error" as const }),
      ...(restoredShelf ? {
        activeShelf: {
          id: restoredShelf.id,
          name: restoredShelf.name,
          query: restoredShelf.query,
          builtIn: builtInShelf !== undefined,
        },
      } : restoredShelfId ? { activeShelf: undefined } : {}),
    }, "all");
    if (restoredShelf) void this.reloadBooks(true);
    if (this.#queueOperation === queueOperation) {
      queueOperation.dispose();
      this.#queueOperation = undefined;
    }
    if (this.#shelfOperation === shelfOperation) {
      shelfOperation.dispose();
      this.#shelfOperation = undefined;
    }
  }

  async #loadAnnotations(profileId: string, books: readonly CatalogBook[], bookEpoch: number): Promise<void> {
    if (!this.#api.getBookAnnotation || profileId !== this.#snapshot.filters.profileId) return;
    const pending = books
      .filter((book) => !this.#snapshot.annotations.has(book.id))
      .slice(0, 200);
    if (pending.length === 0) return;
    const results = await Promise.all(pending.map(async (book) => {
      try {
        return await this.#api.getBookAnnotation!(profileId, book.id);
      } catch {
        return undefined;
      }
    }));
    if (profileId !== this.#snapshot.filters.profileId || bookEpoch !== this.#bookEpoch) return;
    const annotations = new Map(this.#snapshot.annotations);
    for (const annotation of results) {
      if (annotation) annotations.set(annotation.bookId, annotation);
    }
    this.#set({ annotations }, "results");
  }

  async #reloadProfiles(operation: CatalogOperationLease): Promise<string | undefined> {
    const reloadEpoch = ++this.#profilesReloadEpoch;
    let profiles: readonly CatalogProfile[];
    try {
      profiles = await operation.wait(this.#api.listProfiles(operation.signal));
    } catch (error) {
      if (reloadEpoch !== this.#profilesReloadEpoch) return this.#snapshot.filters.profileId;
      throw error;
    }
    if (reloadEpoch !== this.#profilesReloadEpoch) return this.#snapshot.filters.profileId;
    return this.#applyProfiles(profiles);
  }

  #applyProfiles(profiles: readonly CatalogProfile[]): string | undefined {
    const previousProfileId = this.#snapshot.filters.profileId;
    const currentId = this.#snapshot.filters.profileId;
    const selected = profiles.find((profile) => profile.id === currentId && profile.enabled)
      ?? profiles.find((profile) => profile.enabled);
    const currentSettingsId = this.#snapshot.settingsLibraryId;
    const settingsProfile = profiles.find((profile) => profile.id === currentSettingsId)
      ?? selected
      ?? profiles[0];
    const currentDraft = this.#snapshot.settingsDraft;
    const persistedDirtyDraftStillExists = currentDraft?.persisted !== true
      || profiles.some((profile) => profile.id === currentDraft.id);
    const preserveUnsavedSettingsDraft = this.#settingsDraftDirty
      && currentDraft !== undefined
      && persistedDirtyDraftStillExists;
    let nextSettingsLibraryId = preserveUnsavedSettingsDraft
      ? currentSettingsId
      : settingsProfile?.id;
    const profileChanged = selected?.id !== previousProfileId;
    const restoredContext = selected && selected.id !== previousProfileId
      ? readLibraryBrowserContext(this.#storage, selected.id)
      : undefined;
    if (profileChanged) this.#restoredShelfId = restoredContext?.activeShelfId;
    const nextFilters = selected
      ? selected.id === previousProfileId
        ? { ...this.#snapshot.filters, profileId: selected.id }
        : {
            ...(restoredContext?.filters ?? initialLibraryFilters(selected.id)),
            // A Settings mutation must not flash the replacement profile's
            // catalog between the profile refresh and draft refresh. Outside
            // Settings, preserve the replacement profile's saved view.
            ...(this.#snapshot.filters.view === "settings" ? { view: "settings" as const } : {}),
          }
      : { ...initialLibraryFilters(), view: "settings" as const };
    if (profileChanged) {
      this.#profileEpoch += 1;
      this.#bookEpoch += 1;
      this.#profileOperation?.abort();
      this.#bookOperation?.abort();
    }
    let nextSettingsDraft = preserveUnsavedSettingsDraft ? currentDraft : undefined;
    let nextSettingsDirty = preserveUnsavedSettingsDraft;
    if (!preserveUnsavedSettingsDraft && settingsProfile) {
      const roots = this.#snapshot.rootsByProfile.get(settingsProfile.id);
      if (roots) nextSettingsDraft = settingsDraftFromProfile(settingsProfile, roots);
    } else if (!preserveUnsavedSettingsDraft && profiles.length === 0 && this.#snapshot.filters.view === "settings") {
      nextSettingsDraft = createPrototypeLibrary();
      nextSettingsLibraryId = nextSettingsDraft.id;
      nextSettingsDirty = true;
    }
    if (!preserveUnsavedSettingsDraft) {
      this.#settingsDraftDirty = nextSettingsDirty;
      this.#settingsBaselineFingerprint = nextSettingsDirty || !nextSettingsDraft
        ? undefined
        : settingsDraftFingerprint(nextSettingsDraft);
    }
    this.#snapshot = {
      ...this.#snapshot,
      profiles,
      filters: nextFilters,
      ...(profileChanged && restoredContext ? {
        layout: restoredContext.layout,
        density: restoredContext.density,
        contextScrollY: restoredContext.scrollY,
        contextRestoreToken: (this.#snapshot.contextRestoreToken ?? 0) + 1,
        sendQueueOpen: restoredContext.sendQueueOpen ?? false,
        shelfManagerOpen: restoredContext.shelfManagerOpen ?? false,
        seriesSort: restoredContext.seriesSort ?? "name",
      } : {}),
      settingsLibraryId: nextSettingsLibraryId,
      settingsDraft: nextSettingsDraft,
      settingsDirty: nextSettingsDirty,
      ...(profileChanged ? {
        page: undefined,
        facets: EMPTY_CATALOG_FILTERS,
        booksState: selected ? "loading" as const : "idle" as const,
        stale: false,
        error: undefined,
        bookDetails: undefined,
        sendQueue: undefined,
        sendQueueState: selected ? "loading" as const : "idle" as const,
        sendQueueBusy: false,
        sendQueueError: undefined,
        smartShelves: [],
        smartShelvesState: selected ? "loading" as const : "idle" as const,
        activeShelf: undefined,
        annotations: new Map(),
        seriesDetail: undefined,
        healthState: selected ? "loading" as const : "idle" as const,
        healthPage: undefined,
        healthBooks: new Map(),
        healthBusySignature: undefined,
        healthError: undefined,
        healthFilter: restoredContext?.healthFilter ?? { type: "all", severity: "all", ignored: false },
        healthOffset: 0,
        metadataLookupState: selected ? "loading" as const : "idle" as const,
        metadataLookupJobs: undefined,
        activeMetadataLookupJob: undefined,
        metadataLookupBusy: false,
        metadataLookupError: undefined,
        sendQueueOpen: restoredContext?.sendQueueOpen ?? false,
        shelfManagerOpen: restoredContext?.shelfManagerOpen ?? false,
        seriesSort: restoredContext?.seriesSort ?? "name",
        ...(this.#kindleActionBusy() ? {} : { pendingBookId: undefined, pendingBook: undefined, pendingUpdate: undefined }),
      } : {}),
      ...(!selected ? { booksState: "idle" as const, page: undefined } : {}),
    };
    if (nextSettingsLibraryId !== currentSettingsId) this.#settingsEpoch += 1;
    if (selected) safeStorageSet(this.#storage, ACTIVE_PROFILE_KEY, selected.id);
    this.#render("all");
    return selected?.id;
  }

  #openEventStream(): void {
    this.#unsubscribeEvents?.();
    this.#eventStreamExpected = true;
    // Until EventSource has actually opened, a same-ID replacement from an
    // ordinary page fetch makes prior Kindle-match authority stale. Fail closed
    // immediately, including during finite SSE lease renewal.
    this.#downgradeKindleEvidence(false);
    this.#unsubscribeEvents = this.#api.subscribeEvents(
      (event) => this.#scheduleEventRefresh(event),
      () => this.#downgradeKindleEvidence(false),
      () => this.#set({ liveUpdatesConnected: true }, "all"),
    );
  }

  #downgradeKindleEvidence(liveUpdatesConnected: boolean): void {
    // Once the event channel is unavailable, a normal search/page request can
    // return a replacement source that retained the same book ID. The prior
    // source-version comparison must therefore stop authorizing a green badge
    // or Send until the reconnect snapshot drives a fresh reconciliation.
    const kindleStatus = new Map(
      [...this.#snapshot.kindleStatus].map(([bookId]) => [bookId, "unknown" as const]),
    );
    const kindleStatusCountsByProfile = new Map(
      [...this.#snapshot.kindleStatusCountsByProfile].map(([profileId, counts]) => [profileId, {
        confirmed: 0,
        possible: 0,
        notOnKindle: 0,
        unknown: counts.confirmed + counts.possible + counts.notOnKindle + counts.unknown,
      }]),
    );
    const kindleInventory = this.#snapshot.kindleInventory
      ? {
          ...this.#snapshot.kindleInventory,
          items: this.#snapshot.kindleInventory.items.map((item) => (
            item.match === "confirmed" ? { ...item, match: "possible" as const } : item
          )),
          matching: {
            status: "unavailable" as const,
            matchedProfiles: 0,
            failedProfiles: Math.max(1, this.#snapshot.profiles.filter((profile) => profile.enabled).length),
          },
        }
      : undefined;
    this.#set({
      liveUpdatesConnected,
      kindleStatus,
      kindleStatusCountsByProfile,
      ...(kindleInventory === undefined ? {} : { kindleInventory }),
    }, "all");
  }

  #scheduleEventRefresh(event: CatalogEvent): void {
    const eventProfileId = event.profileId;
    if (eventProfileId === this.#snapshot.filters.profileId
      && (event.type === "root.scan.started" || event.type === "root.scan.completed" || event.type === "root.unavailable")) {
      const unavailable = event.type === "root.unavailable";
      this.#recordActivity({
        id: `catalog-scan-event-${event.id}`,
        kind: "catalog-scan",
        tone: unavailable ? "warning" : event.type === "root.scan.completed" ? "success" : "neutral",
        title: unavailable ? "Library source unavailable" : event.type === "root.scan.completed" ? "Library index updated" : "Scanning library source",
        detail: unavailable
          ? "Indexed books remain visible, but source bytes are unavailable until the mounted folder returns."
          : event.type === "root.scan.completed"
            ? "New, changed, and removed source entries were reconciled."
            : "The bounded source scan is running in the background.",
        profileId: eventProfileId,
        ...(event.type === "root.scan.started" ? { newlyIndexed: 0 } : {}),
        ...(unavailable ? { action: "open-settings" as const } : {}),
      });
    }
    if (eventProfileId === this.#snapshot.filters.profileId && event.type === "book.added") {
      this.#recordActivity({
        id: `catalog-book-added-${event.id}`,
        kind: "catalog-scan",
        tone: "success",
        title: "New book indexed",
        detail: "A newly discovered source book is now available in this library.",
        profileId: eventProfileId,
        newlyIndexed: 1,
      });
    }
    if (eventProfileId === this.#snapshot.filters.profileId && event.type === "issues.updated") {
      void this.loadCatalogHealth();
      return;
    }
    if (eventProfileId === this.#snapshot.filters.profileId && event.type === "metadata-lookup.updated") {
      void Promise.all([this.loadMetadataLookupJobs(event.jobId), this.loadCatalogHealth()]);
      return;
    }
    if ((event.type === "queue.updated" || event.type === "shelf.updated")
      && eventProfileId !== undefined
      && eventProfileId === this.#snapshot.filters.profileId) {
      void this.#loadProfileExtras(eventProfileId);
      return;
    }
    if (event.type === "annotation.updated"
      && eventProfileId !== undefined
      && eventProfileId === this.#snapshot.filters.profileId) {
      const annotations = new Map(this.#snapshot.annotations);
      if (event.bookId) annotations.delete(event.bookId);
      else annotations.clear();
      this.#snapshot = { ...this.#snapshot, annotations };
      const personalShelf = this.#snapshot.activeShelf?.query.personal;
      if (personalShelf?.favorite !== undefined || personalShelf?.wantToRead !== undefined) {
        void this.reloadBooks(true);
      } else {
        const books = event.bookId
          ? (this.#snapshot.page?.items ?? []).filter(({ id }) => id === event.bookId)
          : this.#snapshot.page?.items ?? [];
        void this.#loadAnnotations(eventProfileId, books, this.#bookEpoch);
      }
      return;
    }
    if (event.type === "delivery.updated" && this.#snapshot.batchTransfer && this.#snapshot.bulkActionBusy) {
      // The controller's batch finalizer loads one authoritative match index
      // after the latest verified device inventory. Processing each delivery
      // hint here would revoke the next book's already-proven absence verdict
      // and perform the same catalog refresh repeatedly.
      return;
    }
    const configurationEvent = /^(?:profile|root)\.(?:created|updated|deleted)$/u.test(event.type);
    const selectedSettingsId = this.#snapshot.settingsLibraryId;
    const selectedSettingsAffected = configurationEvent
      && this.#snapshot.filters.view === "settings"
      && (event.profileId === undefined || event.profileId === selectedSettingsId);
    if (selectedSettingsAffected && !this.#configurationMutationRunning) {
      if (this.#settingsDraftDirty) {
        this.#settingsExternallyChanged = true;
        this.#snapshot = {
          ...this.#snapshot,
          settingsConflict: true,
          settingsError: "This library changed in another browser. Cancel your draft to load the current server configuration before saving.",
        };
      } else {
        this.#settingsExternallyChanged = true;
        this.#snapshot = { ...this.#snapshot, settingsRefreshing: true, settingsConflict: true };
      }
    }
    // Catalog mutations can preserve a book ID while changing its immutable
    // source version. Downgrade every live association before updated cards are
    // rendered; only a fresh controller reconciliation may restore green.
    this.#downgradeKindleEvidence(true);
    if (event.profileId) this.#pendingEventProfileIds.add(event.profileId);
    this.#latestCatalogEvent = event;
    if (this.#eventRefreshRunning) return;
    if (this.#eventTimer !== undefined) window.clearTimeout(this.#eventTimer);
    this.#eventTimer = window.setTimeout(() => {
      this.#eventTimer = undefined;
      void this.#drainEventRefresh();
    }, 180);
  }

  async #drainEventRefresh(): Promise<void> {
    if (this.#eventRefreshRunning || this.#configurationMutationRunning) return;
    const profileIds = [...this.#pendingEventProfileIds];
    const latestEvent = this.#latestCatalogEvent;
    if (!latestEvent) return;
    this.#pendingEventProfileIds.clear();
    this.#latestCatalogEvent = undefined;
    this.#eventRefreshRunning = true;
    this.#activeEventBatch = { profileIds, event: latestEvent };
    try {
      await this.#refreshFromEvents(profileIds, latestEvent);
    } finally {
      this.#eventRefreshRunning = false;
      this.#activeEventBatch = undefined;
      if (this.#latestCatalogEvent && !this.#configurationMutationRunning) void this.#drainEventRefresh();
    }
  }

  async #refreshFromEvents(affectedProfileIds: readonly string[], event: CatalogEvent): Promise<void> {
    const refreshEpoch = ++this.#eventRefreshEpoch;
    this.#eventRefreshOperation?.abort();
    const operation = createCatalogOperation("Live catalog refresh", this.#requestTimeoutMs);
    this.#eventRefreshOperation = operation;
    let activeProfileId: string | undefined;
    let profileEpoch: number | undefined;
    try {
      await this.#reloadProfiles(operation);
      if (refreshEpoch !== this.#eventRefreshEpoch) return;
      activeProfileId = this.#snapshot.filters.profileId;
      profileEpoch = this.#profileEpoch;
      const existingProfileIds = new Set(this.#snapshot.profiles.map((profile) => profile.id));
      const refreshProfileIds = new Set(
        affectedProfileIds.filter((profileId) => existingProfileIds.has(profileId)),
      );
      // Catalog events are hints and can arrive as a rapid cross-profile burst
      // for one shared root. Always refresh the active result set for the batch
      // so the final event cannot debounce away an earlier active-profile update.
      if (activeProfileId) refreshProfileIds.add(activeProfileId);
      if (this.#snapshot.settingsRefreshing && this.#snapshot.settingsLibraryId) {
        refreshProfileIds.add(this.#snapshot.settingsLibraryId);
      }
      if (refreshProfileIds.size === 0) {
        if (this.#snapshot.settingsRefreshing) {
          const freshEmptyDraft = this.#snapshot.profiles.length === 0
            && this.#snapshot.settingsDraft?.persisted === false;
          if (freshEmptyDraft) this.#settingsExternallyChanged = false;
          this.#snapshot = {
            ...this.#snapshot,
            settingsRefreshing: false,
            ...(freshEmptyDraft ? { settingsConflict: false, settingsError: undefined } : {}),
          };
          this.#render("all");
        }
        await operation.wait(Promise.resolve(this.#hooks.onCatalogChanged?.(event)));
        return;
      }
      const [rootEntries, facets, serviceStatus] = await operation.wait(Promise.all([
        Promise.all([...refreshProfileIds].map(async (profileId) => (
          [profileId, await this.#api.listRoots(profileId, operation.signal)] as const
        ))),
        activeProfileId ? this.#api.getFilters(activeProfileId, operation.signal) : Promise.resolve(undefined),
        this.#api.getStatus(operation.signal),
      ]));
      if (refreshEpoch !== this.#eventRefreshEpoch) return;
      const activeProfileStillCurrent = profileEpoch === this.#profileEpoch
        && activeProfileId === this.#snapshot.filters.profileId;
      let rootsByProfile = this.#snapshot.rootsByProfile;
      for (const [profileId, roots] of rootEntries) {
        this.#noteRootDataUpdate(profileId);
        rootsByProfile = rootsMapWith(rootsByProfile, profileId, roots);
      }
      this.#snapshot = {
        ...this.#snapshot,
        rootsByProfile,
        serviceStatus,
        ...(facets === undefined || !activeProfileStillCurrent ? {} : {
          facets,
          filters: normalizeFacetBackedSelects(this.#snapshot.filters, facets),
        }),
        stale: false,
      };
      const selectedProfile = this.#snapshot.profiles.find((profile) => profile.id === this.#snapshot.settingsLibraryId);
      const selectedRoots = selectedProfile ? rootsByProfile.get(selectedProfile.id) : undefined;
      if (
        selectedProfile
        && selectedRoots
        && refreshProfileIds.has(selectedProfile.id)
        && this.#snapshot.filters.view === "settings"
        && !this.#settingsDraftDirty
      ) {
        const draft = settingsDraftFromProfile(selectedProfile, selectedRoots);
        this.#settingsBaselineFingerprint = settingsDraftFingerprint(draft);
        this.#settingsExternallyChanged = false;
        this.#snapshot = {
          ...this.#snapshot,
          settingsDraft: draft,
          settingsDirty: false,
          settingsRefreshing: false,
          settingsConflict: false,
          settingsError: undefined,
        };
      }
      if (!selectedProfile) this.#snapshot = { ...this.#snapshot, settingsRefreshing: false };
      this.#render("all");
      if (activeProfileStillCurrent && activeProfileId) {
        await operation.wait(this.reloadBooks(true, operation));
        await operation.wait(this.#refreshProfileAuxiliarySurfaces(activeProfileId, event));
      }
      if (refreshEpoch !== this.#eventRefreshEpoch) return;
      await operation.wait(Promise.resolve(this.#hooks.onCatalogChanged?.(event)));
    } catch (error) {
      if (refreshEpoch !== this.#eventRefreshEpoch) return;
      if (
        profileEpoch !== undefined
        && (profileEpoch !== this.#profileEpoch || activeProfileId !== this.#snapshot.filters.profileId)
      ) {
        return;
      }
      this.#set({
        stale: true,
        settingsRefreshing: false,
        settingsConflict: this.#settingsExternallyChanged,
        ...(this.#snapshot.filters.view === "settings" ? {
          settingsError: errorMessage(error, "Live library settings refresh failed."),
        } : {}),
        booksState: this.#snapshot.page ? this.#snapshot.booksState : "error",
        error: errorMessage(error, "Live catalog refresh failed."),
      }, "all");
    } finally {
      if (this.#eventRefreshOperation === operation) {
        operation.dispose();
        this.#eventRefreshOperation = undefined;
      }
    }
  }

  #noteRootDataUpdate(profileId: string): void {
    this.#rootDataGenerations.set(profileId, (this.#rootDataGenerations.get(profileId) ?? 0) + 1);
  }

  #beginConfigurationMutation(): void {
    this.#configurationMutationRunning = true;
    this.#eventRefreshEpoch += 1;
    this.#eventRefreshOperation?.abort();
    const active = this.#activeEventBatch;
    if (!active) return;
    for (const profileId of active.profileIds) this.#pendingEventProfileIds.add(profileId);
    this.#latestCatalogEvent ??= active.event;
  }

  #finishConfigurationMutation(): void {
    this.#configurationMutationRunning = false;
    if (this.#latestCatalogEvent && !this.#eventRefreshRunning) void this.#drainEventRefresh();
  }
}
