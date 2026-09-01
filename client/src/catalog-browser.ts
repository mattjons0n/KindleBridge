import {
  CatalogApiError,
  type CatalogApi,
  type CatalogBook,
  type CatalogBookMetadataState,
  type CatalogBookPage,
  type BookMetadataOverrides,
  type CatalogEvent,
  type CatalogFilters,
  type CatalogKindleStatus,
  type CatalogKindleStatusCounts,
  type CatalogProfile,
  type CatalogRoot,
  type CatalogServiceStatus,
  type CoverProvider,
  type CoverSearchCandidate,
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
  readonly selectedBookIds: ReadonlySet<string>;
  readonly bulkActionBusy: boolean;
  readonly bulkActionError?: string;
  readonly pendingRemoval?: CatalogRemoveRequest;
  readonly metadataEditor?: CatalogMetadataEditorState;
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
}

export interface CatalogKindleInventory {
  readonly deviceLabel: string;
  readonly scannedAt: string;
  readonly completeness: KindleInventoryCompleteness;
  readonly items: readonly CatalogKindleInventoryItem[];
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

export interface CatalogHardwareHooks {
  readonly onConnectRequested?: () => void | Promise<void>;
  readonly onDisconnectRequested?: () => void | Promise<void>;
  readonly onSendRequested?: (request: CatalogSendRequest) => void | Promise<void>;
  /** Finalizes one browser-orchestrated batch after its last success or first failure. */
  readonly onSendBatchFinished?: (result: CatalogSendBatchResult) => void | Promise<void>;
  readonly onRemoveRequested?: (request: CatalogRemoveRequest) => void | Promise<void>;
  readonly onCatalogChanged?: (event: CatalogEvent) => void | Promise<void>;
  /** Reconcile the newly visible profile first when a Kindle is already connected. */
  readonly onActiveProfileChanged?: (profileId: string) => void | Promise<void>;
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
  #batchOperationSequence = 0;
  #profileOperation?: CatalogOperationLease;
  #bookOperation?: CatalogOperationLease;
  #settingsLoadOperation?: CatalogOperationLease;
  #settingsMutationOperation?: CatalogOperationLease;
  #eventRefreshOperation?: CatalogOperationLease;
  #rescanOperations = new Map<string, CatalogOperationLease>();
  #metadataEditorEpoch = 0;
  #metadataEditorOperation?: CatalogOperationLease;

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
      selectedBookIds: new Set(),
      bulkActionBusy: false,
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
      this.#snapshot = {
        ...this.#snapshot,
        loadState: "ready",
        serviceStatus,
        profiles,
        filters: initialLibraryFilters(selected?.id),
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
    this.#profileOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#bookOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#settingsLoadOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#settingsMutationOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#eventRefreshOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    this.#metadataEditorOperation?.abort(new DOMException("Catalog browser disposed", "AbortError"));
    for (const operation of this.#rescanOperations.values()) {
      operation.abort(new DOMException("Catalog browser disposed", "AbortError"));
    }
    this.#profileOperation = undefined;
    this.#bookOperation = undefined;
    this.#settingsLoadOperation = undefined;
    this.#settingsMutationOperation = undefined;
    this.#eventRefreshOperation = undefined;
    this.#metadataEditorOperation = undefined;
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
    const epoch = ++this.#profileEpoch;
    this.#bookEpoch += 1;
    this.#profileOperation?.abort();
    this.#bookOperation?.abort();
    this.#settingsLoadOperation?.abort();
    const operation = createCatalogOperation("Library profile load", this.#requestTimeoutMs);
    this.#profileOperation = operation;
    safeStorageSet(this.#storage, ACTIVE_PROFILE_KEY, profile.id);
    this.#snapshot = {
      ...this.#snapshot,
      filters: initialLibraryFilters(profile.id),
      settingsLibraryId: profile.id,
      settingsDraft: undefined,
      page: undefined,
      facets: EMPTY_CATALOG_FILTERS,
      booksState: "loading",
      error: undefined,
      pendingBookId: undefined,
      pendingBook: undefined,
      selectedBookIds: new Set(),
      pendingRemoval: undefined,
      bulkActionError: undefined,
      announcement: undefined,
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
    if (view !== this.#snapshot.filters.view) {
      this.#bookEpoch += 1;
      this.#bookOperation?.abort();
    }
    const profileId = this.#snapshot.filters.profileId;
    const leavingKindleView = this.#snapshot.filters.view === "on-kindle" && view !== "on-kindle";
    this.#snapshot = {
      ...this.#snapshot,
      filters: { ...this.#snapshot.filters, view, offset: 0, kindle: view === "on-kindle" || leavingKindleView ? "all" : this.#snapshot.filters.kindle },
      pendingBookId: undefined,
      pendingBook: undefined,
      selectedBookIds: new Set(),
      pendingRemoval: undefined,
      bulkActionError: undefined,
      settingsError: undefined,
      ...(discardingSettings ? { settingsDraft: undefined, settingsDirty: false } : {}),
    };
    if (view === "settings") {
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
    this.#render("all");
    await this.reloadBooks();
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
    };
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
      selectedBookIds: new Set(),
    };
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
    };
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
      const query = catalogQuery(this.#snapshot.filters);
      const confirmed = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "confirmed").map(([bookId]) => bookId);
      const possible = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "possible").map(([bookId]) => bookId);
      const absent = [...this.#snapshot.kindleStatus].filter(([, status]) => status === "not-on-kindle").map(([bookId]) => bookId);
      const wantsMatchedView = this.#snapshot.filters.view === "on-kindle";
      const wantsOnKindle = this.#snapshot.filters.kindle === "on-kindle";
      const wantsPossible = this.#snapshot.filters.kindle === "possible";
      const wantsAbsent = this.#snapshot.filters.kindle === "not-on-kindle";
      const matched = [...new Set([...confirmed, ...possible])];
      const emptyKindleSelection = (wantsMatchedView && matched.length === 0)
        || (wantsOnKindle && confirmed.length === 0)
        || (wantsPossible && possible.length === 0)
        || (wantsAbsent && absent.length === 0);
      const fetchPage = async (request: ReturnType<typeof catalogQuery>): Promise<CatalogBookPage> => {
        if (emptyKindleSelection) {
          return { items: [], total: 0, limit: request.limit ?? 24, offset: request.offset ?? 0 };
        }
        if (wantsMatchedView || wantsOnKindle || wantsPossible || wantsAbsent) {
          return this.#api.queryBooks(profileId, {
            ...request,
            includeBookIds: wantsMatchedView ? matched : wantsOnKindle ? confirmed : wantsPossible ? possible : absent,
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
      const visibleBookIds = new Set(page.items.map((book) => book.id));
      this.#set({
        filters: {
          ...this.#snapshot.filters,
          offset: page.offset,
          limit: page.limit,
        },
        page,
        selectedBookIds: new Set(
          [...this.#snapshot.selectedBookIds].filter((bookId) => visibleBookIds.has(bookId)),
        ),
        booksState: "ready",
        stale: false,
        error: undefined,
      }, "results");
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
        this.#set({
          settingsError: undefined,
          announcement: "Source scan started. New and changed books will appear automatically.",
        }, "all");
      }
    } catch (error) {
      if (settingsEpoch === this.#settingsEpoch && profileId === this.#snapshot.settingsLibraryId) {
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
  }

  toggleBookSelection(bookId: string, selected?: boolean): void {
    if (this.#snapshot.layout !== "list" || this.#kindleActionBusy()) return;
    if (!this.#snapshot.page?.items.some((book) => book.id === bookId)) return;
    const next = new Set(this.#snapshot.selectedBookIds);
    const shouldSelect = selected ?? !next.has(bookId);
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

  async sendSelectedBooks(): Promise<void> {
    if (this.#snapshot.layout !== "list" || this.#kindleActionBusy()) return;
    const books = (this.#snapshot.page?.items ?? []).filter((book) => (
      this.#snapshot.selectedBookIds.has(book.id)
      && this.#snapshot.kindleStatus.get(book.id) === "not-on-kindle"
      && this.#bookSourceAvailable(book)
    ));
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
      const book = books[index]!;
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

    if (failed) {
      const selectedBookIds = new Set(retryBooks.map(({ id }) => id));
      const verifiedSummary = `${verifiedBooks.length} of ${books.length} ${verifiedBooks.length === 1 ? "book" : "books"} transferred and verified.`;
      const retrySummary = `${retryBooks.length} unsent ${retryBooks.length === 1 ? "book remains" : "books remain"} selected for retry.`;
      const message = `${verifiedSummary} Failed on “${failed.title}”: ${failed.message} ${retrySummary}`;
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

  requestBookRemoval(bookId: string): void {
    this.#requestRemoval([bookId]);
  }

  async openMetadataEditor(bookId: string): Promise<void> {
    if (this.#kindleActionBusy()) return;
    const book = this.#snapshot.page?.items.find((candidate) => candidate.id === bookId);
    if (!book) return;
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
          provider: "google-books",
          query: [book.title, ...book.authors].filter(Boolean).join(" "),
          loadState: "idle",
          items: [],
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

  closeMetadataEditor(): void {
    if (this.#snapshot.metadataEditor?.busy) return;
    this.#metadataEditorEpoch += 1;
    this.#metadataEditorOperation?.abort();
    this.#metadataEditorOperation = undefined;
    this.#set({ metadataEditor: undefined }, "all");
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
      this.#set({
        metadataEditor: {
          ...current,
          coverSearch: {
            provider,
            query: normalizedQuery,
            loadState: "error",
            items: [],
            error: errorMessage(error, "Cover search failed."),
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

  requestSelectedBookRemoval(): void {
    if (this.#snapshot.layout !== "list") return;
    this.#requestRemoval([...this.#snapshot.selectedBookIds]);
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
      this.#set({
        bulkActionBusy: false,
        pendingRemoval: undefined,
        selectedBookIds,
        bulkActionError: undefined,
        announcement: `${request.targets.length} exact Kindle ${request.targets.length === 1 ? "file was" : "files were"} removed. Library originals were not changed.`,
      }, "all");
    } catch (error) {
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
      this.#set({ sendBusy: false, sendPhase: "failed", sendMessage: message, error: message }, "all");
    }
  }

  setTransferUpdate(update: CatalogTransferUpdate): void {
    if (!this.#snapshot.pendingBook) return;
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
        : this.#activeSendOperation === undefined ? !terminal : true,
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
    await this.#hooks.onConnectRequested();
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
    if (!inventory) {
      this.#set({
        kindleInventory: undefined,
        kindleStatus: new Map(),
        kindleStatusCountsByProfile: new Map(),
        pendingRemoval: undefined,
        bulkActionError: undefined,
      }, "all");
      void this.reloadBooks(true);
      return;
    }
    const maximumItems = 10_000;
    const items = inventory.items.slice(0, maximumItems).map((item) => ({ ...item }));
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
    this.#set({
      kindleInventory: {
        ...inventory,
        deviceLabel: inventory.deviceLabel.slice(0, 80) || "Connected Kindle",
        items,
        total: Math.max(inventory.total, inventory.items.length),
        truncated: inventory.truncated || inventory.items.length > maximumItems,
      },
      kindleStatus: statuses,
      kindleStatusCountsByProfile: countsByProfile,
      kindleInventoryOffset: 0,
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
      if (profileId === this.#snapshot.filters.profileId) await this.reloadBooks(true);
    } catch {
      // The successful overlay mutation remains authoritative. The live event
      // stream and the next ordinary page load will retry derived UI data.
    }
  }

  #bookSourceAvailable(book: CatalogBook): boolean {
    const root = this.#snapshot.rootsByProfile.get(book.profileId)
      ?.find((candidate) => candidate.id === book.rootId);
    return book.available !== false
      && root?.enabled === true
      && ["available", "watching", "paused", "scanning"].includes(root.status);
  }

  #requestRemoval(bookIds: readonly string[]): void {
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
      (this.#snapshot.page?.items ?? [])
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
    const nextFilters = selected
      ? selected.id === previousProfileId
        ? { ...this.#snapshot.filters, profileId: selected.id }
        : {
            ...initialLibraryFilters(selected.id),
            // A Settings mutation must not flash the replacement profile's
            // catalog between the profile refresh and draft refresh.
            view: this.#snapshot.filters.view === "settings" ? "settings" as const : "all" as const,
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
      settingsLibraryId: nextSettingsLibraryId,
      settingsDraft: nextSettingsDraft,
      settingsDirty: nextSettingsDirty,
      ...(profileChanged ? {
        page: undefined,
        facets: EMPTY_CATALOG_FILTERS,
        booksState: selected ? "loading" as const : "idle" as const,
        stale: false,
        error: undefined,
        ...(this.#kindleActionBusy() ? {} : { pendingBookId: undefined, pendingBook: undefined }),
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
