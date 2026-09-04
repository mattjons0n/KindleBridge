import { MAX_BOOK_SOURCE_BYTES } from "./book-limits";
import {
  MAX_CATALOG_JSON_RESPONSE_BYTES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  MAX_STALE_MANAGED_TOKENS_PER_BOOK,
  METADATA_CLAIM_BITMAP_BASE64_LENGTH,
  METADATA_CLAIM_BITMAP_BYTES,
} from "../../shared/catalog-contracts.js";
import { normalizeSmartShelfQuery, SmartShelfQueryError } from "../../shared/shelf-query.js";
import type {
  BookCoverOverride,
  BookMetadataPatchInput,
  BookMetadataResetInput,
  BookMetadataOverrides,
  CatalogMetadataCandidate,
  ConfigurableCoverProvider,
  CoverImportInput,
  CoverProvider,
  CoverProviderCredentialInput,
  CoverProviderCredentialState,
  CoverProviderCredentialTestInput,
  CoverSearchCandidate,
  EditableBookMetadata,
  MetadataCandidateImportInput,
  MetadataCandidateSearchResult,
  MetadataCandidateSearchTerms,
  MetadataLookupJob,
  MetadataLookupJobControlInput,
  MetadataLookupJobInput,
  MetadataLookupJobPage,
  BookSelectionResult,
  ProfileBookAnnotation,
  ProfileBookAnnotationPatchInput,
  SendQueueAddInput,
  SmartShelf,
  SmartShelfCreateInput,
  SmartShelfPatchInput,
  SmartShelfPinnedOrderInput,
  SmartShelfQuery,
} from "../../shared/catalog-contracts.js";
import type {
  CatalogHealthIssue,
  CatalogHealthPage,
  CatalogHealthQuery,
  CatalogIssueSeverity,
  CatalogIssueType,
  CatalogIssueDispositionInput,
  CatalogDuplicatePreferenceInput,
  CatalogIssueRetryInput,
  CatalogIssueRetryResult,
} from "../../shared/catalog-issues.js";

export type {
  BookCoverOverride,
  BookMetadataPatchInput,
  BookMetadataResetInput,
  BookMetadataOverrides,
  CatalogMetadataCandidate,
  ConfigurableCoverProvider,
  CoverImportInput,
  CoverProvider,
  CoverProviderCredentialInput,
  CoverProviderCredentialState,
  CoverProviderCredentialTestInput,
  CoverSearchCandidate,
  EditableBookMetadata,
  MetadataCandidateImportInput,
  MetadataCandidateSearchResult,
  MetadataCandidateSearchTerms,
  MetadataLookupJob,
  MetadataLookupJobControlInput,
  MetadataLookupJobInput,
  MetadataLookupJobPage,
  BookSelectionResult,
  ProfileBookAnnotation,
  ProfileBookAnnotationPatchInput,
  SendQueueAddInput,
  SmartShelf,
  SmartShelfCreateInput,
  SmartShelfPatchInput,
  SmartShelfPinnedOrderInput,
  SmartShelfQuery,
} from "../../shared/catalog-contracts.js";
export type {
  CatalogHealthIssue,
  CatalogHealthPage,
  CatalogHealthQuery,
  CatalogIssueSeverity,
  CatalogIssueType,
  CatalogIssueDispositionInput,
  CatalogDuplicatePreferenceInput,
  CatalogIssueRetryInput,
  CatalogIssueRetryResult,
} from "../../shared/catalog-issues.js";

export type CatalogRootStatus =
  | "pending"
  | "available"
  | "watching"
  | "scanning"
  | "unavailable"
  | "permission-denied"
  | "paused"
  | "error"
  | "unknown";

export interface CatalogServiceStatus {
  readonly available: boolean;
  readonly state: "ready" | "indexing" | "degraded" | "unavailable";
  readonly updatedAt?: string;
  readonly message?: string;
  readonly settingsMode: "read-write" | "read-only";
  readonly database: "ready" | "error";
  readonly cache: "ready" | "degraded";
}

export interface CatalogProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly sourceLabel: string;
  readonly enabled: boolean;
  readonly rootCount: number;
  readonly availableRootCount: number;
  readonly bookCount: number;
}

export interface CatalogRoot {
  readonly id: string;
  readonly profileId: string;
  readonly label: string;
  /** Absolute path inside the Kindle Bridge container. */
  readonly path: string;
  readonly recursive: boolean;
  readonly watch: boolean;
  readonly enabled: boolean;
  readonly status: CatalogRootStatus;
  /** Optional relative marker file used to reject an empty/wrong backing mount. */
  readonly sentinel?: string;
  readonly mountIdentity?: string;
  readonly lastScanAt?: string;
  readonly lastErrorCode?: string;
}

export type CatalogBookFormat = "EPUB" | "AZW3" | string;
export type CatalogKindleStatus = "confirmed" | "possible" | "not-on-kindle" | "unknown";
export const MAX_CATALOG_SOURCE_BYTES = MAX_BOOK_SOURCE_BYTES;

export interface CatalogKindleStatusCounts {
  readonly confirmed: number;
  readonly possible: number;
  readonly notOnKindle: number;
  readonly unknown: number;
}

export interface CatalogBook {
  readonly id: string;
  readonly profileId: string;
  readonly rootId: string;
  readonly sourceFilename: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly authorSort: string;
  readonly language?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly series?: string;
  readonly seriesIndex?: number;
  readonly description?: string;
  readonly subjects: readonly string[];
  readonly identifiers: readonly string[];
  readonly format: CatalogBookFormat;
  readonly size: number;
  readonly contentHash?: string;
  readonly presentationVersion?: string;
  readonly addedAt: string;
  readonly updatedAt: string;
  readonly metadataComplete: boolean;
  readonly available: boolean;
  readonly coverUrl?: string;
  readonly sourceUrl?: string;
  readonly metadataEdited?: boolean;
  readonly coverEdited?: boolean;
  readonly metadataRevision?: number;
  /** Optional until the browser's Kindle reconciliation layer supplies it. */
  readonly kindleStatus?: CatalogKindleStatus;
}

export interface CatalogBookMetadataState {
  readonly book: CatalogBook;
  readonly sourceMetadata: EditableBookMetadata;
  readonly sourceCoverUrl: string | null;
  readonly overrides: BookMetadataOverrides;
  readonly revision: number;
  readonly basedOnContentHash: string;
  readonly sourceChanged: boolean;
  readonly coverOverride: BookCoverOverride | null;
}

export interface CatalogBookDetailsData extends CatalogBookMetadataState {
  readonly source: {
    readonly rootId: string;
    readonly rootLabel: string;
    readonly rootPath: string;
    readonly rootStatus: CatalogRootStatus;
    readonly rootLastScanAt?: string;
    readonly rootLastErrorCode?: string;
    readonly relativePath: string;
    readonly available: boolean;
  };
  /** Latest verified transfer only; intentionally contains no device identity. */
  readonly latestVerifiedDelivery?: {
    readonly filename?: string;
    readonly size?: number;
    readonly deliveredAt: string;
    readonly currentPresentation: boolean;
  };
}

export interface CatalogCoverSearchResult {
  readonly provider: CoverProvider;
  readonly items: readonly CoverSearchCandidate[];
}

export interface CatalogBookPage {
  readonly items: readonly CatalogBook[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CatalogFilterOption {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
}

export interface CatalogFilters {
  readonly authors: readonly CatalogFilterOption[];
  readonly languages: readonly CatalogFilterOption[];
  readonly subjects: readonly CatalogFilterOption[];
  readonly publishers: readonly CatalogFilterOption[];
  readonly series: readonly CatalogFilterOption[];
  readonly formats: readonly CatalogFilterOption[];
  readonly roots: readonly CatalogFilterOption[];
  readonly years: readonly CatalogFilterOption[];
  readonly metadata: readonly CatalogFilterOption[];
}

export type CatalogBookSort =
  | "recent"
  | "title"
  | "author"
  | "published"
  | "size"
  | "added"
  | "updated"
  | "series"
  | "series-index";

export interface CatalogBookQuery {
  readonly q?: string;
  readonly author?: string;
  readonly language?: string;
  readonly subject?: string;
  readonly publisher?: string;
  readonly series?: string;
  readonly seriesKey?: string;
  readonly format?: string;
  readonly rootId?: string;
  readonly year?: string;
  readonly metadata?: string;
  readonly available?: boolean;
  readonly coverAvailable?: boolean;
  readonly favorite?: boolean;
  readonly wantToRead?: boolean;
  readonly sort?: CatalogBookSort;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

export interface CatalogBookMatchQuery extends CatalogBookQuery {
  readonly includeBookIds?: readonly string[];
  readonly excludeBookIds?: readonly string[];
}

export interface CreateCatalogProfileInput {
  readonly name: string;
  readonly description?: string;
  readonly enabled?: boolean;
}

export interface UpdateCatalogProfileInput {
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
}

export interface CreateCatalogRootInput {
  readonly label: string;
  readonly path: string;
  readonly recursive: boolean;
  readonly watch: boolean;
  readonly enabled: boolean;
  readonly sentinel?: string | null;
  readonly mountIdentity?: string | null;
}

export type UpdateCatalogRootInput = Partial<CreateCatalogRootInput>;

export interface SaveCatalogConfigurationInput {
  readonly profileId?: string;
  readonly profile: CreateCatalogProfileInput;
  readonly roots: ReadonlyArray<CreateCatalogRootInput & { readonly id?: string }>;
}

export interface SavedCatalogConfiguration {
  readonly profile: CatalogProfile;
  readonly roots: readonly CatalogRoot[];
}

export interface CatalogEvent {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly profileId?: string;
  readonly rootId?: string;
  readonly bookId?: string;
  readonly shelfId?: string;
  readonly jobId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface CatalogSendQueueEntry {
  readonly profileId: string;
  readonly bookId: string;
  readonly rank: number;
  readonly queuedContentHash: string;
  readonly queuedPresentationVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly book: CatalogBook | null;
  readonly sourceState:
    | "ready"
    | "source-unavailable"
    | "source-changed"
    | "presentation-changed"
    | "unsupported"
    | "missing-or-retired";
}

export interface CatalogSendQueue {
  readonly profileId: string;
  readonly revision: number;
  readonly entries: readonly CatalogSendQueueEntry[];
  readonly total: number;
  readonly totalSourceBytes: number;
}

export interface CatalogSeriesSummary {
  readonly key: string;
  readonly name: string;
  readonly bookCount: number;
  readonly numberedCount: number;
  readonly unnumberedCount: number;
}

export interface CatalogSeriesSummaryPage {
  readonly items: readonly CatalogSeriesSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CatalogSeriesDetail {
  readonly key: string;
  readonly name: string;
  readonly books: CatalogBookPage;
  readonly duplicateIndices: readonly number[];
  readonly missingIntegerIndices: readonly number[];
  readonly unnumberedCount: number;
}

export interface CreateDeliveryInput {
  readonly profileId: string;
  readonly bookId: string;
  readonly deviceKey: string;
  readonly status: string;
  readonly artifactHash: string;
  readonly filename: string;
  readonly size: number;
  readonly objectIdentity?: string;
  readonly managedToken?: string;
}

export interface CatalogMatchDelivery {
  readonly deviceKey: string;
  readonly filename: string;
  readonly artifactHash?: string;
  readonly artifactSize?: number;
  readonly objectIdentity?: string;
  readonly managedToken?: string;
  readonly status: string;
  readonly deliveredAt?: string;
}

export interface CatalogMatchIndexEntry {
  readonly bookId: string;
  /** Optional catalog-presentation preference; never Kindle deletion authority. */
  readonly preferredPresentation?: true;
  readonly sourceFilename: string;
  readonly sourceFormat: CatalogBookFormat;
  readonly sourceSize: number;
  readonly contentHash: string;
  readonly presentationVersion?: string;
  readonly managedToken?: string;
  /** Exact prior KindleBridge presentation identities; removal-only evidence. */
  readonly staleManagedTokens?: readonly string[];
  readonly identifiers: readonly string[];
  readonly title: string;
  readonly authors: readonly string[];
  readonly authorSort?: string;
  readonly deliveries: readonly CatalogMatchDelivery[];
}

export interface CatalogMatchIndex {
  readonly profileId: string;
  readonly generatedAt: string;
  /** Omitted only by legacy/in-process test doubles; HTTP responses require it. */
  readonly metadataClaims?: {
    readonly complete: boolean;
    readonly collisionBitmap: string;
  };
  readonly entries: readonly CatalogMatchIndexEntry[];
}

export interface CatalogBookSource {
  readonly blob: Blob;
  readonly contentLength?: number;
  readonly etag?: string;
  /** Effective source-plus-overlay identity captured by the source response. */
  readonly presentationVersion?: string;
}

export interface CatalogApi {
  getStatus(signal?: AbortSignal): Promise<CatalogServiceStatus>;
  listCoverProviderCredentials?(signal?: AbortSignal): Promise<readonly CoverProviderCredentialState[]>;
  saveCoverProviderCredential?(
    provider: ConfigurableCoverProvider,
    input: CoverProviderCredentialInput,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState>;
  removeCoverProviderCredential?(
    provider: ConfigurableCoverProvider,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState>;
  testCoverProviderCredential?(
    provider: ConfigurableCoverProvider,
    input: CoverProviderCredentialTestInput,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState>;
  listProfiles(signal?: AbortSignal): Promise<readonly CatalogProfile[]>;
  createProfile(
    input: CreateCatalogProfileInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CatalogProfile>;
  updateProfile(profileId: string, input: UpdateCatalogProfileInput, signal?: AbortSignal): Promise<CatalogProfile>;
  deleteProfile(profileId: string, signal?: AbortSignal): Promise<void>;
  listRoots(profileId: string, signal?: AbortSignal): Promise<readonly CatalogRoot[]>;
  createRoot(profileId: string, input: CreateCatalogRootInput, signal?: AbortSignal): Promise<CatalogRoot>;
  updateRoot(profileId: string, rootId: string, input: UpdateCatalogRootInput, signal?: AbortSignal): Promise<CatalogRoot>;
  deleteRoot(profileId: string, rootId: string, signal?: AbortSignal): Promise<void>;
  rescanRoot(profileId: string, rootId: string, signal?: AbortSignal): Promise<void>;
  listBooks(profileId: string, query?: CatalogBookQuery, signal?: AbortSignal): Promise<CatalogBookPage>;
  queryBooks(profileId: string, query?: CatalogBookMatchQuery, signal?: AbortSignal): Promise<CatalogBookPage>;
  resolveBookSelection?(profileId: string, query?: CatalogBookQuery, signal?: AbortSignal): Promise<BookSelectionResult>;
  listSeries?(
    profileId: string,
    query?: { readonly q?: string; readonly limit?: number; readonly offset?: number },
    signal?: AbortSignal,
  ): Promise<CatalogSeriesSummaryPage>;
  getSeries?(
    profileId: string,
    seriesKey: string,
    query?: { readonly limit?: number; readonly offset?: number },
    signal?: AbortSignal,
  ): Promise<CatalogSeriesDetail>;
  getSendQueue?(profileId: string, signal?: AbortSignal): Promise<CatalogSendQueue>;
  addSendQueueEntries?(
    profileId: string,
    input: SendQueueAddInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue>;
  replaceSendQueue?(profileId: string, input: SendQueueAddInput, signal?: AbortSignal): Promise<CatalogSendQueue>;
  removeSendQueueEntry?(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue>;
  clearSendQueue?(profileId: string, expectedRevision: number, signal?: AbortSignal): Promise<CatalogSendQueue>;
  listSmartShelves?(profileId: string, signal?: AbortSignal): Promise<readonly SmartShelf[]>;
  getSmartShelf?(profileId: string, shelfId: string, signal?: AbortSignal): Promise<SmartShelf>;
  createSmartShelf?(
    profileId: string,
    input: SmartShelfCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SmartShelf>;
  updateSmartShelf?(
    profileId: string,
    shelfId: string,
    input: SmartShelfPatchInput,
    signal?: AbortSignal,
  ): Promise<SmartShelf>;
  reorderPinnedSmartShelves?(
    profileId: string,
    input: SmartShelfPinnedOrderInput,
    signal?: AbortSignal,
  ): Promise<readonly SmartShelf[]>;
  deleteSmartShelf?(profileId: string, shelfId: string, expectedRevision: number, signal?: AbortSignal): Promise<void>;
  getBookAnnotation?(profileId: string, bookId: string, signal?: AbortSignal): Promise<ProfileBookAnnotation>;
  updateBookAnnotation?(
    profileId: string,
    bookId: string,
    input: ProfileBookAnnotationPatchInput,
    signal?: AbortSignal,
  ): Promise<ProfileBookAnnotation>;
  getFilters(profileId: string, signal?: AbortSignal): Promise<CatalogFilters>;
  listCatalogIssues?(profileId: string, query?: CatalogHealthQuery, signal?: AbortSignal): Promise<CatalogHealthPage>;
  updateCatalogIssueDisposition?(
    profileId: string,
    signature: string,
    input: CatalogIssueDispositionInput,
    signal?: AbortSignal,
  ): Promise<CatalogHealthIssue>;
  updateCatalogDuplicatePreference?(
    profileId: string,
    signature: string,
    input: CatalogDuplicatePreferenceInput,
    signal?: AbortSignal,
  ): Promise<CatalogHealthIssue>;
  retryCatalogIssue?(
    profileId: string,
    signature: string,
    input: CatalogIssueRetryInput,
    signal?: AbortSignal,
  ): Promise<CatalogIssueRetryResult>;
  listMetadataLookupJobs?(
    profileId: string,
    query?: { readonly limit?: number; readonly offset?: number },
    signal?: AbortSignal,
  ): Promise<MetadataLookupJobPage>;
  getMetadataLookupJob?(profileId: string, jobId: string, signal?: AbortSignal): Promise<MetadataLookupJob>;
  createMetadataLookupJob?(
    profileId: string,
    input: MetadataLookupJobInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MetadataLookupJob>;
  controlMetadataLookupJob?(
    profileId: string,
    jobId: string,
    action: "resume" | "pause" | "cancel" | "retry",
    input: MetadataLookupJobControlInput,
    signal?: AbortSignal,
  ): Promise<MetadataLookupJob>;
  runMetadataLookupJobStep?(profileId: string, jobId: string, signal?: AbortSignal): Promise<MetadataLookupJob>;
  getBook(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBook>;
  getBookDetails?(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookDetailsData>;
  getBookMetadata?(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookMetadataState>;
  updateBookMetadata?(
    profileId: string,
    bookId: string,
    input: BookMetadataPatchInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  resetBookMetadata?(
    profileId: string,
    bookId: string,
    input: BookMetadataResetInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  searchBookMetadata?(
    profileId: string,
    bookId: string,
    provider: CoverProvider,
    terms: MetadataCandidateSearchTerms,
    signal?: AbortSignal,
  ): Promise<MetadataCandidateSearchResult>;
  importBookMetadata?(
    profileId: string,
    bookId: string,
    input: MetadataCandidateImportInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  uploadBookCover?(
    profileId: string,
    bookId: string,
    image: Blob,
    expectedRevision: number,
    expectedContentHash: string,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  deleteBookCover?(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    expectedContentHash: string,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  searchBookCovers?(
    profileId: string,
    bookId: string,
    provider: CoverProvider,
    query: string,
    signal?: AbortSignal,
  ): Promise<CatalogCoverSearchResult>;
  importBookCover?(
    profileId: string,
    bookId: string,
    input: CoverImportInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState>;
  getBookCover?(profileId: string, bookId: string, signal?: AbortSignal): Promise<Blob>;
  getMatchIndex(profileId: string, signal?: AbortSignal): Promise<CatalogMatchIndex>;
  getBookSource(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookSource>;
  createDelivery(input: CreateDeliveryInput, idempotencyKey: string, signal?: AbortSignal): Promise<unknown>;
  saveConfiguration(input: SaveCatalogConfigurationInput, idempotencyKey: string, signal?: AbortSignal): Promise<SavedCatalogConfiguration>;
  subscribeEvents(onEvent: (event: CatalogEvent) => void, onError?: () => void, onOpen?: () => void): () => void;
}

export class CatalogApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface EventSourceLike {
  readonly data?: string;
}

interface EventStreamLike {
  onopen: (() => void) | null;
  onmessage: ((event: EventSourceLike) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface HttpCatalogClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly createEventSource?: (url: string) => EventStreamLike;
  /** Aggregate connection + bounded-body deadline for ordinary API requests. */
  readonly requestTimeoutMs?: number;
  /** Aggregate deadline for a source download, which may legitimately be much larger. */
  readonly sourceRequestTimeoutMs?: number;
  /** Maximum time an EventSource may remain unopened before it is replaced. */
  readonly eventStreamOpenTimeoutMs?: number;
  /** Maximum lifetime of one EventSource transport before an authoritative reconnect. */
  readonly eventStreamLeaseMs?: number;
  /** Delay before replacing an EventSource that failed or missed its open deadline. */
  readonly eventStreamReconnectMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Match the server's practical 10-minute aggregate source deadline so a
// maximum-size 200 MiB book remains viable over a private VPN.
const DEFAULT_SOURCE_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_EVENT_STREAM_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_EVENT_STREAM_LEASE_MS = 5 * 60_000;
const DEFAULT_EVENT_STREAM_RECONNECT_MS = 3_000;

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return timeout;
}

function abortReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new DOMException(fallback, "AbortError");
}

function observe(promise: PromiseLike<unknown> | undefined): void {
  if (!promise) return;
  void Promise.resolve(promise).catch(() => undefined);
}

function cancelResponse(response: Response, reason: unknown): void {
  if (!response.body) return;
  try {
    observe(response.body.cancel(reason));
  } catch {
    // A locked/already-retired response is already owned by its reader.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  try {
    observe(reader.cancel(reason));
  } catch {
    // Cancellation is best-effort after the aggregate request has retired.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A blackholed read can remain pending in a non-cooperative fetch mock. Its
    // rejection is observed and cancellation has already been requested.
  }
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  options: {
    readonly onAbort?: (reason: unknown) => void;
    readonly onLateValue?: (value: T, reason: unknown) => void;
  } = {},
): Promise<T> {
  if (signal.aborted) {
    const reason = abortReason(signal, "Catalog request aborted");
    try {
      options.onAbort?.(reason);
    } catch {
      // Retirement must still reject even if a custom cleanup hook misbehaves.
    }
    promise.then(
      (value) => {
        try {
          options.onLateValue?.(value, reason);
        } catch {
          // A late value is intentionally ignored after its cleanup attempt.
        }
      },
      () => undefined,
    );
    throw reason;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let retiredReason: unknown;
    const retire = (): void => {
      if (settled) return;
      settled = true;
      retiredReason = abortReason(signal, "Catalog request aborted");
      try {
        options.onAbort?.(retiredReason);
      } catch {
        // Retirement must still reject even if a custom cleanup hook misbehaves.
      }
      reject(retiredReason);
    };
    signal.addEventListener("abort", retire, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          try {
            options.onLateValue?.(value, retiredReason);
          } catch {
            // A late value is intentionally ignored after its cleanup attempt.
          }
          return;
        }
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

interface RequestDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

function requestDeadline(parentSignal: AbortSignal | null | undefined, timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parentSignal ? abortReason(parentSignal, "Catalog request aborted") : undefined);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new CatalogApiError(
      408,
      "CATALOG_REQUEST_TIMEOUT",
      "The catalog request timed out. Try again.",
    ));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rootStatus(value: unknown): CatalogRootStatus {
  const normalized = textValue(value).toLocaleLowerCase().replaceAll("_", "-");
  if (normalized === "healthy" || normalized === "ready") return "available";
  if (normalized === "permission-denied" || normalized === "permission denied") return "permission-denied";
  if (["pending", "available", "watching", "scanning", "unavailable", "paused", "error"].includes(normalized)) {
    return normalized as CatalogRootStatus;
  }
  return "unknown";
}

function parseStatus(value: unknown): CatalogServiceStatus {
  const item = record(value);
  const live = typeof item.live === "boolean" ? item.live : undefined;
  const ready = typeof item.ready === "boolean" ? item.ready : undefined;
  const database = item.database === "error" ? "error" as const : "ready" as const;
  const cache = item.cache === "degraded" ? "degraded" as const : "ready" as const;
  const raw = textValue(item.state, textValue(item.status, booleanValue(item.ok, live ?? true) ? "ready" : "unavailable"));
  const state = live === false || database === "error"
    ? "unavailable"
    : cache === "degraded"
      ? "degraded"
    : ready === false
      ? "indexing"
      : raw === "indexing" || raw === "degraded" || raw === "unavailable" ? raw : "ready";
  return {
    available: database === "ready" && booleanValue(item.available, live ?? state !== "unavailable"),
    state,
    updatedAt: optionalText(item.updatedAt ?? item.catalogUpdatedAt),
    message: optionalText(item.message),
    settingsMode: item.settingsMode === "read-only" ? "read-only" : "read-write",
    database,
    cache,
  };
}

function parseProfile(value: unknown): CatalogProfile {
  const item = record(value);
  const name = textValue(item.name, "Library");
  return {
    id: textValue(item.id),
    name,
    description: textValue(item.description, "Household collection"),
    initial: textValue(item.initial, name.slice(0, 1).toLocaleUpperCase() || "L"),
    sourceLabel: textValue(item.sourceLabel, "No folder configured"),
    enabled: booleanValue(item.enabled, true),
    rootCount: numberValue(item.rootCount),
    availableRootCount: numberValue(item.availableRootCount),
    bookCount: numberValue(item.bookCount),
  };
}

function parseRoot(value: unknown): CatalogRoot {
  const item = record(value);
  return {
    id: textValue(item.id),
    profileId: textValue(item.profileId),
    label: textValue(item.label, "Library folder"),
    path: textValue(item.path),
    recursive: booleanValue(item.recursive, true),
    watch: booleanValue(item.watch, true),
    enabled: booleanValue(item.enabled, true),
    status: rootStatus(item.status),
    sentinel: optionalText(item.sentinel),
    mountIdentity: optionalText(item.mountIdentity),
    lastScanAt: optionalText(item.lastScanAt),
    lastErrorCode: optionalText(item.lastErrorCode),
  };
}

function parseBook(value: unknown): CatalogBook {
  const item = record(value);
  const kindle = textValue(item.kindleStatus);
  return {
    id: textValue(item.id),
    profileId: textValue(item.profileId),
    rootId: textValue(item.rootId),
    sourceFilename: textValue(item.sourceFilename),
    title: textValue(item.title, "Untitled"),
    authors: stringArray(item.authors),
    authorSort: textValue(item.authorSort),
    language: optionalText(item.language),
    publisher: optionalText(item.publisher),
    publishedAt: optionalText(item.publishedAt),
    series: optionalText(item.series),
    seriesIndex: typeof item.seriesIndex === "number" && Number.isFinite(item.seriesIndex)
      ? item.seriesIndex
      : undefined,
    description: optionalText(item.description),
    subjects: stringArray(item.subjects),
    identifiers: stringArray(item.identifiers),
    format: textValue(item.format, "EPUB").toLocaleUpperCase(),
    size: numberValue(item.size),
    contentHash: optionalText(item.contentHash),
    presentationVersion: optionalText(item.presentationVersion),
    addedAt: textValue(item.addedAt),
    updatedAt: textValue(item.updatedAt),
    metadataComplete: booleanValue(item.metadataComplete),
    available: booleanValue(item.available, true),
    coverUrl: optionalText(item.coverUrl),
    sourceUrl: optionalText(item.sourceUrl),
    metadataEdited: booleanValue(item.metadataEdited),
    coverEdited: booleanValue(item.coverEdited),
    metadataRevision: numberValue(item.metadataRevision),
    kindleStatus: ["confirmed", "possible", "not-on-kindle", "unknown"].includes(kindle)
      ? kindle as CatalogKindleStatus
      : undefined,
  };
}

const EDITABLE_METADATA_FIELDS = [
  "title",
  "authors",
  "authorSort",
  "language",
  "publisher",
  "publishedAt",
  "series",
  "seriesIndex",
  "description",
  "subjects",
  "identifiers",
] as const;

function parseEditableMetadata(value: unknown): EditableBookMetadata {
  const item = record(value);
  return {
    title: textValue(item.title, "Untitled"),
    authors: [...stringArray(item.authors)],
    authorSort: nullableText(item.authorSort),
    language: nullableText(item.language),
    publisher: nullableText(item.publisher),
    publishedAt: nullableText(item.publishedAt),
    series: nullableText(item.series),
    seriesIndex: nullableNumber(item.seriesIndex),
    description: nullableText(item.description),
    subjects: [...stringArray(item.subjects)],
    identifiers: [...stringArray(item.identifiers)],
  };
}

function parseMetadataOverrides(value: unknown): BookMetadataOverrides {
  const item = record(value);
  const parsed: Record<string, unknown> = {};
  for (const field of EDITABLE_METADATA_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    if (field === "authors" || field === "subjects" || field === "identifiers") {
      parsed[field] = [...stringArray(item[field])];
    } else if (field === "seriesIndex") {
      parsed[field] = nullableNumber(item[field]);
    } else if (field === "title") {
      parsed[field] = textValue(item[field], "Untitled");
    } else {
      parsed[field] = nullableText(item[field]);
    }
  }
  return parsed as BookMetadataOverrides;
}

function parseCoverOverride(value: unknown): BookCoverOverride | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  const mediaType = textValue(item.mediaType);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return null;
  const sourceKind = item.sourceKind === "provider" ? "provider" as const : "upload" as const;
  const provider = item.provider === "google-books" || item.provider === "open-library"
    ? item.provider
    : null;
  return {
    assetKey: textValue(item.assetKey),
    mediaType: mediaType as BookCoverOverride["mediaType"],
    byteLength: numberValue(item.byteLength),
    width: numberValue(item.width),
    height: numberValue(item.height),
    sourceKind,
    provider,
    providerReference: nullableText(item.providerReference),
    sourceUrl: nullableText(item.sourceUrl),
  };
}

function parseBookMetadataState(value: unknown): CatalogBookMetadataState {
  const item = record(value);
  return {
    book: parseBook(item.book),
    sourceMetadata: parseEditableMetadata(item.sourceMetadata),
    sourceCoverUrl: nullableText(item.sourceCoverUrl),
    overrides: parseMetadataOverrides(item.overrides),
    revision: numberValue(item.revision),
    basedOnContentHash: textValue(item.basedOnContentHash),
    sourceChanged: booleanValue(item.sourceChanged),
    coverOverride: parseCoverOverride(item.coverOverride),
  };
}

function parseBookDetailsData(value: unknown): CatalogBookDetailsData {
  const item = record(value);
  const metadata = parseBookMetadataState(item);
  const source = record(item.source);
  const delivery = item.latestVerifiedDelivery === null || item.latestVerifiedDelivery === undefined
    ? undefined
    : record(item.latestVerifiedDelivery);
  return {
    ...metadata,
    source: {
      rootId: textValue(source.rootId),
      rootLabel: textValue(source.rootLabel, "Library folder"),
      rootPath: textValue(source.rootPath),
      rootStatus: rootStatus(source.rootStatus),
      rootLastScanAt: optionalText(source.rootLastScanAt),
      rootLastErrorCode: optionalText(source.rootLastErrorCode),
      relativePath: textValue(source.relativePath),
      available: booleanValue(source.available),
    },
    ...(delivery ? {
      latestVerifiedDelivery: {
        filename: optionalText(delivery.filename),
        size: typeof delivery.size === "number" && Number.isSafeInteger(delivery.size) && delivery.size >= 0
          ? delivery.size
          : undefined,
        deliveredAt: textValue(delivery.deliveredAt),
        currentPresentation: booleanValue(delivery.currentPresentation),
      },
    } : {}),
  };
}

function parseCoverSearchResult(value: unknown): CatalogCoverSearchResult {
  const item = record(value);
  const provider = item.provider === "open-library" ? "open-library" as const : "google-books" as const;
  const items = Array.isArray(item.items) ? item.items.flatMap((entry): CoverSearchCandidate[] => {
    const candidate = record(entry);
    const candidateId = textValue(candidate.candidateId);
    const thumbnailUrl = textValue(candidate.thumbnailUrl);
    if (!candidateId || !thumbnailUrl) return [];
    return [{
      candidateId,
      title: textValue(candidate.title, "Untitled"),
      authors: [...stringArray(candidate.authors)],
      publishedAt: nullableText(candidate.publishedAt),
      identifiers: [...stringArray(candidate.identifiers)],
      thumbnailUrl,
    }];
  }) : [];
  return { provider, items };
}

function parseMetadataCandidate(value: unknown): CatalogMetadataCandidate | null {
  const item = record(value);
  const provider = item.provider === "google-books" || item.provider === "open-library" ? item.provider : null;
  const candidateId = textValue(item.candidateId);
  const confidence = item.confidence === "high" || item.confidence === "medium" || item.confidence === "low"
    ? item.confidence
    : null;
  if (!provider || !candidateId || !confidence) return null;
  const metadata = parseMetadataOverrides(item.metadata);
  if (Object.keys(metadata).length === 0) return null;
  return {
    provider,
    candidateId,
    confidence,
    metadata,
    ...(optionalText(item.coverCandidateId) ? { coverCandidateId: optionalText(item.coverCandidateId)! } : {}),
  };
}

function parseMetadataCandidateSearchResult(value: unknown): MetadataCandidateSearchResult {
  const item = record(value);
  const provider = item.provider === "open-library" ? "open-library" as const : "google-books" as const;
  const items = Array.isArray(item.items)
    ? item.items.flatMap((entry) => {
        const candidate = parseMetadataCandidate(entry);
        return candidate ? [candidate] : [];
      })
    : [];
  return { provider, items };
}

function parseMetadataLookupJob(value: unknown): MetadataLookupJob {
  const item = record(value);
  const provider = item.provider === "open-library" ? "open-library" as const : "google-books" as const;
  const statuses = new Set(["queued", "running", "paused", "completed", "cancelled"]);
  const entryStatuses = new Set(["pending", "searching", "ready", "no-results", "failed", "cancelled"]);
  const errorCodes = new Set([
    "book-unavailable",
    "provider-unavailable",
    "provider-not-configured",
    "provider-response-too-large",
    "invalid-provider-response",
  ]);
  const entries = Array.isArray(item.entries) ? item.entries.flatMap((value) => {
    const entry = record(value);
    const status = textValue(entry.status);
    if (!entryStatuses.has(status)) return [];
    const candidates = Array.isArray(entry.candidates)
      ? entry.candidates.flatMap((candidate) => {
          const parsed = parseMetadataCandidate(candidate);
          return parsed ? [parsed] : [];
        })
      : [];
    const rawErrorCode = nullableText(entry.errorCode);
    return [{
      jobId: textValue(entry.jobId),
      bookId: textValue(entry.bookId),
      rank: numberValue(entry.rank),
      status: status as MetadataLookupJob["entries"][number]["status"],
      attempts: numberValue(entry.attempts),
      candidates,
      errorCode: rawErrorCode !== null && errorCodes.has(rawErrorCode)
        ? rawErrorCode as MetadataLookupJob["entries"][number]["errorCode"]
        : null,
      acceptedAt: nullableText(entry.acceptedAt),
      updatedAt: textValue(entry.updatedAt),
    }];
  }) : [];
  const rawStatus = textValue(item.status);
  return {
    id: textValue(item.id),
    profileId: textValue(item.profileId),
    provider,
    status: statuses.has(rawStatus) ? rawStatus as MetadataLookupJob["status"] : "paused",
    revision: numberValue(item.revision),
    entriesIncluded: item.entriesIncluded !== false,
    entries,
    total: numberValue(item.total, entries.length),
    pending: numberValue(item.pending),
    ready: numberValue(item.ready),
    noResults: numberValue(item.noResults),
    failed: numberValue(item.failed),
    cancelled: numberValue(item.cancelled),
    createdAt: textValue(item.createdAt),
    updatedAt: textValue(item.updatedAt),
  };
}

function parseMetadataLookupJobPage(value: unknown): MetadataLookupJobPage {
  const item = record(value);
  const items = Array.isArray(item.items) ? item.items.map(parseMetadataLookupJob) : [];
  return {
    items,
    total: numberValue(item.total, items.length),
    limit: numberValue(item.limit, items.length || 20),
    offset: numberValue(item.offset),
  };
}

function parseCatalogHealthIssue(value: unknown): CatalogHealthIssue | null {
  const item = record(value);
  const type = textValue(item.type) as CatalogHealthIssue["type"];
  const severity = textValue(item.severity) as CatalogHealthIssue["severity"];
  const signature = textValue(item.signature);
  if (
    numberValue(item.version) !== 1
    || !/^issue-[a-f0-9]{16}$/u.test(signature)
    || ![
      "missing-cover",
      "incomplete-metadata",
      "metadata-parser-failure",
      "low-confidence-provider-data",
      "unavailable-source",
      "suspected-duplicate",
    ].includes(type)
    || !["info", "warning", "error"].includes(severity)
  ) return null;
  const disposition = record(item.disposition);
  return {
    version: 1,
    signature,
    profileId: textValue(item.profileId),
    type,
    severity,
    reasonCode: textValue(item.reasonCode),
    bookIds: [...stringArray(item.bookIds)],
    sourceIds: [...stringArray(item.sourceIds)],
    rootIds: [...stringArray(item.rootIds)],
    displayLabels: [...stringArray(item.displayLabels)],
    currentAvailable: booleanValue(item.currentAvailable),
    ...(optionalText(item.firstObservedAt) ? { firstObservedAt: optionalText(item.firstObservedAt)! } : {}),
    lastObservedAt: textValue(item.lastObservedAt),
    disposition: {
      ignored: booleanValue(disposition.ignored),
      preferredBookId: nullableText(disposition.preferredBookId),
      revision: numberValue(disposition.revision),
      retryCount: numberValue(disposition.retryCount),
      lastRetryAt: nullableText(disposition.lastRetryAt),
    },
  };
}

function emptyCatalogIssueCounts(): CatalogHealthPage["counts"] {
  return {
    total: 0,
    active: 0,
    ignored: 0,
    byType: {
      "missing-cover": 0,
      "incomplete-metadata": 0,
      "metadata-parser-failure": 0,
      "low-confidence-provider-data": 0,
      "unavailable-source": 0,
      "suspected-duplicate": 0,
    },
    bySeverity: { info: 0, warning: 0, error: 0 },
  };
}

function parseCatalogHealthPage(value: unknown): CatalogHealthPage {
  const item = record(value);
  const items = Array.isArray(item.items)
    ? item.items.flatMap((entry) => {
        const issue = parseCatalogHealthIssue(entry);
        return issue ? [issue] : [];
      })
    : [];
  const rawCounts = record(item.counts);
  const rawTypes = record(rawCounts.byType);
  const rawSeverities = record(rawCounts.bySeverity);
  const fallback = emptyCatalogIssueCounts();
  return {
    items,
    total: numberValue(item.total, items.length),
    limit: numberValue(item.limit, items.length || 100),
    offset: numberValue(item.offset),
    counts: {
      total: numberValue(rawCounts.total, fallback.total),
      active: numberValue(rawCounts.active, fallback.active),
      ignored: numberValue(rawCounts.ignored, fallback.ignored),
      byType: {
        "missing-cover": numberValue(rawTypes["missing-cover"]),
        "incomplete-metadata": numberValue(rawTypes["incomplete-metadata"]),
        "metadata-parser-failure": numberValue(rawTypes["metadata-parser-failure"]),
        "low-confidence-provider-data": numberValue(rawTypes["low-confidence-provider-data"]),
        "unavailable-source": numberValue(rawTypes["unavailable-source"]),
        "suspected-duplicate": numberValue(rawTypes["suspected-duplicate"]),
      },
      bySeverity: {
        info: numberValue(rawSeverities.info),
        warning: numberValue(rawSeverities.warning),
        error: numberValue(rawSeverities.error),
      },
    },
  };
}

function parseCoverProviderCredentialState(value: unknown): CoverProviderCredentialState {
  const item = record(value);
  const configured = booleanValue(item.configured);
  const status = item.status === "working" || item.status === "error" || item.status === "untested"
    ? item.status
    : configured ? "untested" : "not-configured";
  const errorCode = item.errorCode === "invalid-or-restricted-key"
    || item.errorCode === "quota-exhausted"
    || item.errorCode === "timeout"
    || item.errorCode === "provider-unavailable"
    ? item.errorCode
    : null;
  return {
    provider: "google-books",
    configured,
    maskedKey: configured ? "••••••••" : null,
    revision: Math.max(0, numberValue(item.revision)),
    status: configured ? status : "not-configured",
    lastTestedAt: configured ? nullableText(item.lastTestedAt) : null,
    errorCode: configured ? errorCode : null,
  };
}

function filterOptions(value: unknown): readonly CatalogFilterOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CatalogFilterOption[] => {
    if (typeof entry === "string") return [{ value: entry, label: entry }];
    const item = record(entry);
    const optionValue = textValue(item.value);
    if (!optionValue) return [];
    return [{ value: optionValue, label: textValue(item.label, optionValue), count: typeof item.count === "number" ? item.count : undefined }];
  });
}

function parseFilters(value: unknown): CatalogFilters {
  const item = record(value);
  return {
    authors: filterOptions(item.authors ?? item.author),
    languages: filterOptions(item.languages ?? item.language),
    subjects: filterOptions(item.subjects ?? item.subject),
    publishers: filterOptions(item.publishers ?? item.publisher),
    series: filterOptions(item.series),
    formats: filterOptions(item.formats ?? item.format),
    roots: filterOptions(item.roots ?? item.rootId),
    years: filterOptions(item.years ?? item.year),
    metadata: filterOptions(item.metadata),
  };
}

function parsePage(value: unknown): CatalogBookPage {
  const item = record(value);
  const items = Array.isArray(item.items) ? item.items.map(parseBook) : [];
  return {
    items,
    total: numberValue(item.total, items.length),
    limit: numberValue(item.limit, items.length || 24),
    offset: numberValue(item.offset),
  };
}

function parseSendQueue(value: unknown): CatalogSendQueue {
  const item = record(value);
  const states = new Set([
    "ready", "source-unavailable", "source-changed", "presentation-changed", "unsupported", "missing-or-retired",
  ]);
  const entries = Array.isArray(item.entries) ? item.entries.map((value): CatalogSendQueueEntry => {
    const entry = record(value);
    const rawState = textValue(entry.sourceState, "missing-or-retired");
    return {
      profileId: textValue(entry.profileId),
      bookId: textValue(entry.bookId),
      rank: numberValue(entry.rank),
      queuedContentHash: textValue(entry.queuedContentHash),
      queuedPresentationVersion: textValue(entry.queuedPresentationVersion),
      createdAt: textValue(entry.createdAt),
      updatedAt: textValue(entry.updatedAt),
      book: entry.book === null ? null : parseBook(entry.book),
      sourceState: states.has(rawState)
        ? rawState as CatalogSendQueueEntry["sourceState"]
        : "missing-or-retired",
    };
  }) : [];
  return {
    profileId: textValue(item.profileId),
    revision: numberValue(item.revision),
    entries,
    total: numberValue(item.total, entries.length),
    totalSourceBytes: numberValue(item.totalSourceBytes),
  };
}

function parseBookSelection(value: unknown): BookSelectionResult {
  const item = record(value);
  const bookIds = [...stringArray(item.bookIds)];
  return {
    profileId: textValue(item.profileId),
    bookIds,
    total: numberValue(item.total, bookIds.length),
    ceiling: numberValue(item.ceiling),
  };
}

function parseSmartShelf(value: unknown): SmartShelf {
  const item = record(value);
  let query: SmartShelfQuery;
  try {
    query = normalizeSmartShelfQuery(item.query);
  } catch (error) {
    if (error instanceof SmartShelfQueryError) {
      throw new CatalogApiError(502, "INVALID_SMART_SHELF", "The catalog returned an invalid smart shelf");
    }
    throw error;
  }
  return {
    id: textValue(item.id),
    profileId: textValue(item.profileId),
    name: textValue(item.name),
    query,
    pinnedRank: nullableNumber(item.pinnedRank),
    revision: numberValue(item.revision),
    serverCount: nullableNumber(item.serverCount),
    createdAt: textValue(item.createdAt),
    updatedAt: textValue(item.updatedAt),
  };
}

function parseBookAnnotation(value: unknown): ProfileBookAnnotation {
  const item = record(value);
  return {
    profileId: textValue(item.profileId),
    bookId: textValue(item.bookId),
    favorite: booleanValue(item.favorite),
    wantToRead: booleanValue(item.wantToRead),
    revision: numberValue(item.revision),
    createdAt: nullableText(item.createdAt),
    updatedAt: nullableText(item.updatedAt),
  };
}

function parseSeriesSummaryPage(value: unknown): CatalogSeriesSummaryPage {
  const item = record(value);
  const items = Array.isArray(item.items) ? item.items.map((value): CatalogSeriesSummary => {
    const series = record(value);
    return {
      key: textValue(series.key),
      name: textValue(series.name),
      bookCount: numberValue(series.bookCount),
      numberedCount: numberValue(series.numberedCount),
      unnumberedCount: numberValue(series.unnumberedCount),
    };
  }) : [];
  return {
    items,
    total: numberValue(item.total, items.length),
    limit: numberValue(item.limit, items.length || 50),
    offset: numberValue(item.offset),
  };
}

function numberArray(value: unknown): readonly number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

function parseSeriesDetail(value: unknown): CatalogSeriesDetail {
  const item = record(value);
  return {
    key: textValue(item.key),
    name: textValue(item.name),
    books: parsePage(item.books),
    duplicateIndices: numberArray(item.duplicateIndices),
    missingIntegerIndices: numberArray(item.missingIntegerIndices),
    unnumberedCount: numberValue(item.unnumberedCount),
  };
}

export function decodeMetadataClaimBitmap(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length !== METADATA_CLAIM_BITMAP_BASE64_LENGTH) return undefined;
  if (!/^[A-Za-z0-9+/]+==$/u.test(value)) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const finalDataValue = alphabet.indexOf(value.at(-3) ?? "");
  // The fixed 2,500-byte payload leaves one source byte in its final base64
  // quartet, so the lower four padding bits must be zero (canonical encoding).
  if (finalDataValue < 0 || (finalDataValue & 0x0f) !== 0) return undefined;
  try {
    const decoded = globalThis.atob(value);
    if (decoded.length !== METADATA_CLAIM_BITMAP_BYTES) return undefined;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function parseMatchIndex(value: unknown): CatalogMatchIndex {
  const item = record(value);
  const rawMetadataClaims = record(item.metadataClaims);
  const collisionBitmap = textValue(rawMetadataClaims.collisionBitmap);
  if (typeof rawMetadataClaims.complete !== "boolean" || !decodeMetadataClaimBitmap(collisionBitmap)) {
    throw new CatalogApiError(
      502,
      "INVALID_MATCH_INDEX_SUMMARY",
      "The catalog match-index metadata summary is invalid",
    );
  }
  const entries = Array.isArray(item.entries) ? item.entries.map((entry): CatalogMatchIndexEntry => {
    const candidate = record(entry);
    const deliveries = Array.isArray(candidate.deliveries) ? candidate.deliveries.map((delivery): CatalogMatchDelivery => {
      const value = record(delivery);
      return {
        deviceKey: textValue(value.deviceKey),
        filename: textValue(value.filename),
        artifactHash: optionalText(value.artifactHash),
        artifactSize: typeof value.artifactSize === "number" ? value.artifactSize : undefined,
        objectIdentity: optionalText(value.objectIdentity),
        managedToken: optionalText(value.managedToken),
        status: textValue(value.status),
        deliveredAt: optionalText(value.deliveredAt),
      };
    }) : [];
    const staleManagedTokens = stringArray(candidate.staleManagedTokens)
      .filter((token) => /^kb-[a-f0-9]{20}$/u.test(token))
      .slice(0, MAX_STALE_MANAGED_TOKENS_PER_BOOK);
    return {
      bookId: textValue(candidate.bookId),
      ...(candidate.preferredPresentation === true ? { preferredPresentation: true as const } : {}),
      sourceFilename: textValue(candidate.sourceFilename),
      sourceFormat: textValue(candidate.sourceFormat).toLocaleUpperCase("en-US"),
      sourceSize: numberValue(candidate.sourceSize),
      contentHash: textValue(candidate.contentHash),
      presentationVersion: optionalText(candidate.presentationVersion),
      managedToken: optionalText(candidate.managedToken),
      staleManagedTokens,
      identifiers: stringArray(candidate.identifiers),
      title: textValue(candidate.title, "Untitled"),
      authors: stringArray(candidate.authors),
      authorSort: optionalText(candidate.authorSort),
      deliveries,
    };
  }) : [];
  return {
    profileId: textValue(item.profileId),
    generatedAt: textValue(item.generatedAt),
    metadataClaims: { complete: rawMetadataClaims.complete, collisionBitmap },
    entries,
  };
}

function listPayload(value: unknown, key: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const nested = record(value)[key];
  return Array.isArray(nested) ? nested : [];
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function clientIdempotencyKey(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid
    ? `${prefix}-${randomUuid}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function eventSourceFactory(url: string): EventStreamLike {
  return new EventSource(url) as unknown as EventStreamLike;
}

interface BoundedBlobPolicy {
  readonly maximumBytes: number;
  readonly tooLargeCode: string;
  readonly lengthMissingCode: string;
  readonly lengthMismatchCode: string;
  readonly description: string;
}

const SOURCE_BLOB_POLICY: BoundedBlobPolicy = {
  maximumBytes: MAX_CATALOG_SOURCE_BYTES,
  tooLargeCode: "REQUEST_TOO_LARGE",
  lengthMissingCode: "CATALOG_SOURCE_LENGTH_MISSING",
  lengthMismatchCode: "CATALOG_SOURCE_LENGTH_MISMATCH",
  description: "catalog source",
};

const COVER_BLOB_POLICY: BoundedBlobPolicy = {
  maximumBytes: 12 * 1024 * 1024,
  tooLargeCode: "COVER_TOO_LARGE",
  lengthMissingCode: "CATALOG_COVER_LENGTH_MISSING",
  lengthMismatchCode: "CATALOG_COVER_LENGTH_MISMATCH",
  description: "book cover",
};

async function boundedBlob(
  response: Response,
  signal: AbortSignal,
  policy: BoundedBlobPolicy,
): Promise<{ blob: Blob; contentLength?: number }> {
  const rawLength = response.headers.get("Content-Length");
  const parsedLength = rawLength === null ? undefined : Number(rawLength);
  const contentLength = parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength >= 0
    ? parsedLength
    : undefined;
  if (contentLength !== undefined && contentLength > policy.maximumBytes) {
    cancelResponse(response, `${policy.description} limit exceeded`);
    throw new CatalogApiError(413, policy.tooLargeCode, `The ${policy.description} exceeds its safe size limit`);
  }

  if (!response.body) {
    // A browser without a readable response body may rely on a trustworthy,
    // already-bounded Content-Length. Refuse an unbounded fallback allocation.
    if (contentLength === undefined) {
      throw new CatalogApiError(502, policy.lengthMissingCode, `The ${policy.description} length is unavailable`);
    }
    const blob = await waitForAbort(response.blob(), signal, {
      onAbort: (reason) => cancelResponse(response, reason),
    });
    if (blob.size > policy.maximumBytes) {
      throw new CatalogApiError(413, policy.tooLargeCode, `The ${policy.description} exceeds its safe size limit`);
    }
    return { blob, contentLength };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    while (true) {
      const read = reader.read();
      const result = await waitForAbort(read, signal, {
        onAbort: (reason) => cancelReader(reader, reason),
      });
      if (result.done) break;
      received += result.value.byteLength;
      if (received > policy.maximumBytes) {
        cancelReader(reader, `${policy.description} limit exceeded`);
        throw new CatalogApiError(413, policy.tooLargeCode, `The ${policy.description} exceeds its safe size limit`);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } finally {
    releaseReader(reader);
  }
  if (contentLength !== undefined && received !== contentLength) {
    throw new CatalogApiError(502, policy.lengthMismatchCode, `The ${policy.description} length did not match its response headers`);
  }
  return {
    blob: new Blob(chunks, { type: response.headers.get("Content-Type") ?? "application/octet-stream" }),
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

async function boundedSourceBlob(response: Response, signal: AbortSignal): Promise<{ blob: Blob; contentLength?: number }> {
  return boundedBlob(response, signal, SOURCE_BLOB_POLICY);
}

interface BoundedJsonPolicy {
  maximumBytes: number;
  tooLargeCode: string;
  bodyUnavailableCode: string;
  description: string;
}

const CATALOG_JSON_POLICY: BoundedJsonPolicy = {
  maximumBytes: MAX_CATALOG_JSON_RESPONSE_BYTES,
  tooLargeCode: "CATALOG_RESPONSE_TOO_LARGE",
  bodyUnavailableCode: "CATALOG_RESPONSE_BODY_UNAVAILABLE",
  description: "catalog response",
};

const MATCH_INDEX_JSON_POLICY: BoundedJsonPolicy = {
  maximumBytes: MAX_MATCH_INDEX_RESPONSE_BYTES,
  tooLargeCode: "MATCH_INDEX_TOO_LARGE",
  bodyUnavailableCode: "MATCH_INDEX_BODY_UNAVAILABLE",
  description: "catalog match index",
};

async function boundedJson(response: Response, policy: BoundedJsonPolicy, signal: AbortSignal): Promise<unknown> {
  const rawLength = response.headers.get("Content-Length");
  const declaredLength = rawLength === null ? undefined : Number(rawLength);
  if (
    declaredLength !== undefined
    && Number.isSafeInteger(declaredLength)
    && declaredLength > policy.maximumBytes
  ) {
    cancelResponse(response, `${policy.description} limit exceeded`);
    throw new CatalogApiError(413, policy.tooLargeCode, `The ${policy.description} exceeds the safe response limit`);
  }
  if (!response.body) {
    throw new CatalogApiError(502, policy.bodyUnavailableCode, `The ${policy.description} is not readable`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    while (true) {
      const read = reader.read();
      const result = await waitForAbort(read, signal, {
        onAbort: (reason) => cancelReader(reader, reason),
      });
      if (result.done) break;
      received += result.value.byteLength;
      if (received > policy.maximumBytes) {
        cancelReader(reader, `${policy.description} limit exceeded`);
        throw new CatalogApiError(413, policy.tooLargeCode, `The ${policy.description} exceeds the safe response limit`);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } finally {
    releaseReader(reader);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CatalogApiError(502, "INVALID_CATALOG_RESPONSE", "The catalog returned invalid JSON");
  }
}

export class HttpCatalogClient implements CatalogApi {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #createEventSource: (url: string) => EventStreamLike;
  readonly #requestTimeoutMs: number;
  readonly #sourceRequestTimeoutMs: number;
  readonly #eventStreamOpenTimeoutMs: number;
  readonly #eventStreamLeaseMs: number;
  readonly #eventStreamReconnectMs: number;

  constructor(options: HttpCatalogClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/api").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#createEventSource = options.createEventSource ?? eventSourceFactory;
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.#sourceRequestTimeoutMs = positiveTimeout(options.sourceRequestTimeoutMs, DEFAULT_SOURCE_REQUEST_TIMEOUT_MS, "sourceRequestTimeoutMs");
    this.#eventStreamOpenTimeoutMs = positiveTimeout(options.eventStreamOpenTimeoutMs, DEFAULT_EVENT_STREAM_OPEN_TIMEOUT_MS, "eventStreamOpenTimeoutMs");
    this.#eventStreamLeaseMs = positiveTimeout(options.eventStreamLeaseMs, DEFAULT_EVENT_STREAM_LEASE_MS, "eventStreamLeaseMs");
    this.#eventStreamReconnectMs = positiveTimeout(options.eventStreamReconnectMs, DEFAULT_EVENT_STREAM_RECONNECT_MS, "eventStreamReconnectMs");
  }

  async getStatus(signal?: AbortSignal): Promise<CatalogServiceStatus> {
    return parseStatus(await this.#json("/status", { signal }));
  }

  async listCoverProviderCredentials(signal?: AbortSignal): Promise<readonly CoverProviderCredentialState[]> {
    return listPayload(
      await this.#json("/settings/cover-providers", { signal }),
      "items",
    ).map(parseCoverProviderCredentialState);
  }

  async saveCoverProviderCredential(
    provider: ConfigurableCoverProvider,
    input: CoverProviderCredentialInput,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState> {
    const request = this.#write("PUT", input, signal);
    (request.headers as Record<string, string>)["Idempotency-Key"] = clientIdempotencyKey("provider-save");
    return parseCoverProviderCredentialState(await this.#json(
      `/settings/cover-providers/${encodePath(provider)}`,
      request,
    ));
  }

  async removeCoverProviderCredential(
    provider: ConfigurableCoverProvider,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState> {
    const params = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return parseCoverProviderCredentialState(await this.#json(
      `/settings/cover-providers/${encodePath(provider)}?${params.toString()}`,
      { method: "DELETE", signal, headers: { "Idempotency-Key": clientIdempotencyKey("provider-remove") } },
    ));
  }

  async testCoverProviderCredential(
    provider: ConfigurableCoverProvider,
    input: CoverProviderCredentialTestInput,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialState> {
    return parseCoverProviderCredentialState(await this.#json(
      `/settings/cover-providers/${encodePath(provider)}/test`,
      this.#write("POST", input, signal),
    ));
  }

  async listProfiles(signal?: AbortSignal): Promise<readonly CatalogProfile[]> {
    return listPayload(await this.#json("/profiles", { signal }), "profiles").map(parseProfile);
  }

  async createProfile(
    input: CreateCatalogProfileInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CatalogProfile> {
    return parseProfile(await this.#json("/profiles", {
      ...this.#write("POST", input, signal),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    }));
  }

  async updateProfile(profileId: string, input: UpdateCatalogProfileInput, signal?: AbortSignal): Promise<CatalogProfile> {
    return parseProfile(await this.#json(`/profiles/${encodePath(profileId)}`, this.#write("PATCH", input, signal)));
  }

  async deleteProfile(profileId: string, signal?: AbortSignal): Promise<void> {
    await this.#json(`/profiles/${encodePath(profileId)}`, { method: "DELETE", signal });
  }

  async listRoots(profileId: string, signal?: AbortSignal): Promise<readonly CatalogRoot[]> {
    const payload = await this.#json(`/profiles/${encodePath(profileId)}/roots`, { signal });
    return listPayload(payload, "roots").map(parseRoot);
  }

  async createRoot(profileId: string, input: CreateCatalogRootInput, signal?: AbortSignal): Promise<CatalogRoot> {
    return parseRoot(await this.#json(`/profiles/${encodePath(profileId)}/roots`, this.#write("POST", input, signal)));
  }

  async updateRoot(profileId: string, rootId: string, input: UpdateCatalogRootInput, signal?: AbortSignal): Promise<CatalogRoot> {
    return parseRoot(await this.#json(`/profiles/${encodePath(profileId)}/roots/${encodePath(rootId)}`, this.#write("PATCH", input, signal)));
  }

  async deleteRoot(profileId: string, rootId: string, signal?: AbortSignal): Promise<void> {
    await this.#json(`/profiles/${encodePath(profileId)}/roots/${encodePath(rootId)}`, { method: "DELETE", signal });
  }

  async rescanRoot(profileId: string, rootId: string, signal?: AbortSignal): Promise<void> {
    await this.#json(`/profiles/${encodePath(profileId)}/roots/${encodePath(rootId)}/rescan`, { method: "POST", signal });
  }

  async listBooks(profileId: string, query: CatalogBookQuery = {}, signal?: AbortSignal): Promise<CatalogBookPage> {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "" && value !== "all") params.set(key, String(value));
    });
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return parsePage(await this.#json(`/profiles/${encodePath(profileId)}/books${suffix}`, { signal }));
  }

  async queryBooks(profileId: string, query: CatalogBookMatchQuery = {}, signal?: AbortSignal): Promise<CatalogBookPage> {
    return parsePage(await this.#json(
      `/profiles/${encodePath(profileId)}/books/query`,
      this.#write("POST", query, signal),
    ));
  }

  async resolveBookSelection(
    profileId: string,
    query: CatalogBookQuery = {},
    signal?: AbortSignal,
  ): Promise<BookSelectionResult> {
    const { limit: _limit, offset: _offset, ...unpaged } = query;
    return parseBookSelection(await this.#json(
      `/profiles/${encodePath(profileId)}/books/selection`,
      this.#write("POST", unpaged, signal),
    ));
  }

  async listSeries(
    profileId: string,
    query: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<CatalogSeriesSummaryPage> {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "") params.set(key, String(value));
    });
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return parseSeriesSummaryPage(await this.#json(
      `/profiles/${encodePath(profileId)}/series${suffix}`,
      { signal },
    ));
  }

  async getSeries(
    profileId: string,
    seriesKey: string,
    query: { readonly limit?: number; readonly offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<CatalogSeriesDetail> {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return parseSeriesDetail(await this.#json(
      `/profiles/${encodePath(profileId)}/series/${encodePath(seriesKey)}${suffix}`,
      { signal },
    ));
  }

  async getSendQueue(profileId: string, signal?: AbortSignal): Promise<CatalogSendQueue> {
    return parseSendQueue(await this.#json(`/profiles/${encodePath(profileId)}/send-queue`, { signal }));
  }

  async addSendQueueEntries(
    profileId: string,
    input: SendQueueAddInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue> {
    return parseSendQueue(await this.#json(`/profiles/${encodePath(profileId)}/send-queue`, {
      ...this.#write("POST", input, signal),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    }));
  }

  async replaceSendQueue(
    profileId: string,
    input: SendQueueAddInput,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue> {
    return parseSendQueue(await this.#json(
      `/profiles/${encodePath(profileId)}/send-queue`,
      this.#write("PATCH", input, signal),
    ));
  }

  async removeSendQueueEntry(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue> {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return parseSendQueue(await this.#json(
      `/profiles/${encodePath(profileId)}/send-queue/${encodePath(bookId)}?${query.toString()}`,
      { method: "DELETE", signal },
    ));
  }

  async clearSendQueue(
    profileId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<CatalogSendQueue> {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return parseSendQueue(await this.#json(
      `/profiles/${encodePath(profileId)}/send-queue?${query.toString()}`,
      { method: "DELETE", signal },
    ));
  }

  async listSmartShelves(profileId: string, signal?: AbortSignal): Promise<readonly SmartShelf[]> {
    return listPayload(
      await this.#json(`/profiles/${encodePath(profileId)}/shelves`, { signal }),
      "items",
    ).map(parseSmartShelf);
  }

  async getSmartShelf(profileId: string, shelfId: string, signal?: AbortSignal): Promise<SmartShelf> {
    return parseSmartShelf(await this.#json(
      `/profiles/${encodePath(profileId)}/shelves/${encodePath(shelfId)}`,
      { signal },
    ));
  }

  async createSmartShelf(
    profileId: string,
    input: SmartShelfCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SmartShelf> {
    return parseSmartShelf(await this.#json(`/profiles/${encodePath(profileId)}/shelves`, {
      ...this.#write("POST", input, signal),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    }));
  }

  async updateSmartShelf(
    profileId: string,
    shelfId: string,
    input: SmartShelfPatchInput,
    signal?: AbortSignal,
  ): Promise<SmartShelf> {
    return parseSmartShelf(await this.#json(
      `/profiles/${encodePath(profileId)}/shelves/${encodePath(shelfId)}`,
      this.#write("PATCH", input, signal),
    ));
  }

  async reorderPinnedSmartShelves(
    profileId: string,
    input: SmartShelfPinnedOrderInput,
    signal?: AbortSignal,
  ): Promise<readonly SmartShelf[]> {
    return listPayload(await this.#json(
      `/profiles/${encodePath(profileId)}/shelves/pinned-order`,
      this.#write("PATCH", input, signal),
    ), "items").map(parseSmartShelf);
  }

  async deleteSmartShelf(
    profileId: string,
    shelfId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    await this.#json(
      `/profiles/${encodePath(profileId)}/shelves/${encodePath(shelfId)}?${query.toString()}`,
      { method: "DELETE", signal },
    );
  }

  async getBookAnnotation(profileId: string, bookId: string, signal?: AbortSignal): Promise<ProfileBookAnnotation> {
    return parseBookAnnotation(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/annotation`,
      { signal },
    ));
  }

  async updateBookAnnotation(
    profileId: string,
    bookId: string,
    input: ProfileBookAnnotationPatchInput,
    signal?: AbortSignal,
  ): Promise<ProfileBookAnnotation> {
    return parseBookAnnotation(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/annotation`,
      this.#write("PATCH", input, signal),
    ));
  }

  async getFilters(profileId: string, signal?: AbortSignal): Promise<CatalogFilters> {
    return parseFilters(await this.#json(`/profiles/${encodePath(profileId)}/filters`, { signal }));
  }

  async listCatalogIssues(
    profileId: string,
    query: CatalogHealthQuery = {},
    signal?: AbortSignal,
  ): Promise<CatalogHealthPage> {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return parseCatalogHealthPage(await this.#json(
      `/profiles/${encodePath(profileId)}/issues${suffix}`,
      { signal },
    ));
  }

  async updateCatalogIssueDisposition(
    profileId: string,
    signature: string,
    input: CatalogIssueDispositionInput,
    signal?: AbortSignal,
  ): Promise<CatalogHealthIssue> {
    const issue = parseCatalogHealthIssue(await this.#json(
      `/profiles/${encodePath(profileId)}/issues/${encodePath(signature)}`,
      this.#write("PATCH", input, signal),
    ));
    if (!issue) throw new CatalogApiError(502, "INVALID_CATALOG_ISSUE", "The catalog returned an invalid issue");
    return issue;
  }

  async retryCatalogIssue(
    profileId: string,
    signature: string,
    input: CatalogIssueRetryInput,
    signal?: AbortSignal,
  ): Promise<CatalogIssueRetryResult> {
    const payload = record(await this.#json(
      `/profiles/${encodePath(profileId)}/issues/${encodePath(signature)}/retry`,
      this.#write("POST", input, signal),
    ));
    const issue = parseCatalogHealthIssue(payload.issue);
    if (!issue) throw new CatalogApiError(502, "INVALID_CATALOG_ISSUE", "The catalog returned an invalid issue");
    return {
      issue,
      acceptedRootIds: [...stringArray(payload.acceptedRootIds)],
      blockedRootIds: [...stringArray(payload.blockedRootIds)],
    };
  }

  async updateCatalogDuplicatePreference(
    profileId: string,
    signature: string,
    input: CatalogDuplicatePreferenceInput,
    signal?: AbortSignal,
  ): Promise<CatalogHealthIssue> {
    const issue = parseCatalogHealthIssue(await this.#json(
      `/profiles/${encodePath(profileId)}/issues/${encodePath(signature)}/preferred-book`,
      this.#write("PATCH", input, signal),
    ));
    if (!issue) throw new CatalogApiError(502, "INVALID_CATALOG_ISSUE", "The catalog returned an invalid issue");
    return issue;
  }

  async listMetadataLookupJobs(
    profileId: string,
    query: { readonly limit?: number; readonly offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<MetadataLookupJobPage> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return parseMetadataLookupJobPage(await this.#json(
      `/profiles/${encodePath(profileId)}/metadata-lookup-jobs${suffix}`,
      { signal },
    ));
  }

  async getMetadataLookupJob(profileId: string, jobId: string, signal?: AbortSignal): Promise<MetadataLookupJob> {
    return parseMetadataLookupJob(await this.#json(
      `/profiles/${encodePath(profileId)}/metadata-lookup-jobs/${encodePath(jobId)}`,
      { signal },
    ));
  }

  async createMetadataLookupJob(
    profileId: string,
    input: MetadataLookupJobInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MetadataLookupJob> {
    return parseMetadataLookupJob(await this.#json(
      `/profiles/${encodePath(profileId)}/metadata-lookup-jobs`,
      {
        ...this.#write("POST", input, signal),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      },
    ));
  }

  async controlMetadataLookupJob(
    profileId: string,
    jobId: string,
    action: "resume" | "pause" | "cancel" | "retry",
    input: MetadataLookupJobControlInput,
    signal?: AbortSignal,
  ): Promise<MetadataLookupJob> {
    return parseMetadataLookupJob(await this.#json(
      `/profiles/${encodePath(profileId)}/metadata-lookup-jobs/${encodePath(jobId)}/${action}`,
      this.#write("POST", input, signal),
    ));
  }

  async runMetadataLookupJobStep(
    profileId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<MetadataLookupJob> {
    return parseMetadataLookupJob(await this.#json(
      `/profiles/${encodePath(profileId)}/metadata-lookup-jobs/${encodePath(jobId)}/run`,
      this.#write("POST", {}, signal),
    ));
  }

  async getBook(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBook> {
    return parseBook(await this.#json(`/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}`, { signal }));
  }

  async getBookDetails(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookDetailsData> {
    return parseBookDetailsData(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/details`,
      { signal },
    ));
  }

  async getBookMetadata(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookMetadataState> {
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/metadata`,
      { signal },
    ));
  }

  async updateBookMetadata(
    profileId: string,
    bookId: string,
    input: BookMetadataPatchInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/metadata`,
      this.#write("PATCH", input, signal),
    ));
  }

  async resetBookMetadata(
    profileId: string,
    bookId: string,
    input: BookMetadataResetInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/metadata/reset`,
      this.#write("POST", input, signal),
    ));
  }

  async searchBookMetadata(
    profileId: string,
    bookId: string,
    provider: CoverProvider,
    terms: MetadataCandidateSearchTerms,
    signal?: AbortSignal,
  ): Promise<MetadataCandidateSearchResult> {
    const params = new URLSearchParams({ provider, limit: "12" });
    if (terms.title) params.set("title", terms.title);
    if (terms.author) params.set("author", terms.author);
    if (terms.identifier) params.set("identifier", terms.identifier);
    return parseMetadataCandidateSearchResult(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/metadata-search?${params.toString()}`,
      { signal },
    ));
  }

  async importBookMetadata(
    profileId: string,
    bookId: string,
    input: MetadataCandidateImportInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/metadata-import`,
      this.#write("POST", input, signal),
    ));
  }

  async uploadBookCover(
    profileId: string,
    bookId: string,
    image: Blob,
    expectedRevision: number,
    expectedContentHash: string,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    const params = new URLSearchParams({
      expectedRevision: String(expectedRevision),
      expectedContentHash,
    });
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/cover?${params.toString()}`,
      {
        method: "PUT",
        signal,
        headers: { "Content-Type": image.type || "application/octet-stream" },
        body: image,
      },
    ));
  }

  async deleteBookCover(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    expectedContentHash: string,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    const params = new URLSearchParams({
      expectedRevision: String(expectedRevision),
      expectedContentHash,
    });
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/cover?${params.toString()}`,
      { method: "DELETE", signal },
    ));
  }

  async searchBookCovers(
    profileId: string,
    bookId: string,
    provider: CoverProvider,
    query: string,
    signal?: AbortSignal,
  ): Promise<CatalogCoverSearchResult> {
    const params = new URLSearchParams({ provider, q: query, limit: "12" });
    return parseCoverSearchResult(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/cover-search?${params.toString()}`,
      { signal },
    ));
  }

  async importBookCover(
    profileId: string,
    bookId: string,
    input: CoverImportInput,
    signal?: AbortSignal,
  ): Promise<CatalogBookMetadataState> {
    return parseBookMetadataState(await this.#json(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/cover-import`,
      this.#write("POST", input, signal),
    ));
  }

  async getBookCover(profileId: string, bookId: string, signal?: AbortSignal): Promise<Blob> {
    return this.#consume(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/cover`,
      { signal },
      async (response, requestSignal) => (await boundedBlob(response, requestSignal, COVER_BLOB_POLICY)).blob,
    );
  }

  async getMatchIndex(profileId: string, signal?: AbortSignal): Promise<CatalogMatchIndex> {
    return this.#consume(`/profiles/${encodePath(profileId)}/match-index`, { signal }, async (response, requestSignal) => (
      parseMatchIndex(await boundedJson(response, MATCH_INDEX_JSON_POLICY, requestSignal))
    ));
  }

  async getBookSource(profileId: string, bookId: string, signal?: AbortSignal): Promise<CatalogBookSource> {
    return this.#consume(
      `/profiles/${encodePath(profileId)}/books/${encodePath(bookId)}/source`,
      { signal },
      async (response, requestSignal) => {
        const source = await boundedSourceBlob(response, requestSignal);
        const presentationVersion = response.headers.get("X-Kindle-Bridge-Presentation-Version");
        return {
          ...source,
          ...(response.headers.get("ETag") ? { etag: response.headers.get("ETag")! } : {}),
          ...(presentationVersion ? { presentationVersion } : {}),
        };
      },
      this.#sourceRequestTimeoutMs,
    );
  }

  async createDelivery(input: CreateDeliveryInput, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.#json("/deliveries", {
      ...this.#write("POST", input, signal),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    });
  }

  async saveConfiguration(input: SaveCatalogConfigurationInput, idempotencyKey: string, signal?: AbortSignal): Promise<SavedCatalogConfiguration> {
    const path = input.profileId
      ? `/profiles/${encodePath(input.profileId)}/configuration`
      : "/profiles/configuration";
    const payload = record(await this.#json(path, {
      ...this.#write(input.profileId ? "PUT" : "POST", { profile: input.profile, roots: input.roots }, signal),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    }));
    return {
      profile: parseProfile(payload.profile),
      roots: listPayload(payload.roots, "roots").map(parseRoot),
    };
  }

  subscribeEvents(onEvent: (event: CatalogEvent) => void, onError?: () => void, onOpen?: () => void): () => void {
    if (typeof EventSource === "undefined" && this.#createEventSource === eventSourceFactory) return () => undefined;
    let active = true;
    let generation = 0;
    let source: EventStreamLike | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connect = (): void => undefined;
    const clearConnectionTimers = (): void => {
      if (openTimer !== undefined) clearTimeout(openTimer);
      if (leaseTimer !== undefined) clearTimeout(leaseTimer);
      openTimer = undefined;
      leaseTimer = undefined;
    };
    const closeCurrent = (): void => {
      clearConnectionTimers();
      const current = source;
      source = undefined;
      if (!current) return;
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.close();
    };
    const scheduleReconnect = (delayMs: number): void => {
      if (!active || reconnectTimer !== undefined) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delayMs);
    };
    const retireConnection = (currentGeneration: number, reconnectDelayMs: number, reportError = true): void => {
      if (!active || currentGeneration !== generation) return;
      if (reportError) onError?.();
      closeCurrent();
      scheduleReconnect(reconnectDelayMs);
    };
    connect = (): void => {
      if (!active) return;
      const currentGeneration = ++generation;
      let next: EventStreamLike;
      try {
        next = this.#createEventSource(`${this.#baseUrl}/events`);
      } catch {
        onError?.();
        scheduleReconnect(this.#eventStreamReconnectMs);
        return;
      }
      source = next;
      openTimer = setTimeout(() => {
        retireConnection(currentGeneration, this.#eventStreamReconnectMs);
      }, this.#eventStreamOpenTimeoutMs);
      next.onopen = () => {
        if (!active || currentGeneration !== generation || source !== next) return;
        if (openTimer !== undefined) clearTimeout(openTimer);
        openTimer = undefined;
        onOpen?.();
        leaseTimer = setTimeout(() => {
          // SSE is deliberately not subject to ordinary request deadlines. Give
          // each transport its own finite lease instead, then reconnect for the
          // server's authoritative snapshot hint if a connection blackholes.
          retireConnection(currentGeneration, 0);
        }, this.#eventStreamLeaseMs);
      };
      next.onmessage = (message) => {
        if (!active || currentGeneration !== generation || source !== next) return;
        try {
          const item = record(JSON.parse(message.data ?? "{}"));
          onEvent({
            id: textValue(item.id),
            type: textValue(item.type, "catalog.changed"),
            at: textValue(item.at, new Date().toISOString()),
            profileId: optionalText(item.profileId),
            rootId: optionalText(item.rootId),
            bookId: optionalText(item.bookId),
            shelfId: optionalText(item.shelfId),
            jobId: optionalText(item.jobId),
            data: record(item.data),
          });
        } catch {
          // Ignore malformed stream entries. A later valid event or reconciliation
          // refreshes the browser without turning untrusted event text into UI.
        }
      };
      next.onerror = () => retireConnection(currentGeneration, this.#eventStreamReconnectMs);
    };
    connect();
    return () => {
      active = false;
      generation += 1;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      closeCurrent();
    };
  }

  #write(method: "POST" | "PUT" | "PATCH", body: unknown, signal?: AbortSignal): RequestInit {
    return { method, signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#consume(path, init, async (response, signal) => {
      if (response.status === 204) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        cancelResponse(response, "catalog response body is not used");
        return undefined;
      }
      return boundedJson(response, CATALOG_JSON_POLICY, signal);
    });
  }

  async #consume<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<T> {
    const deadline = requestDeadline(init.signal, timeoutMs);
    try {
      const response = await this.#request(path, { ...init, signal: deadline.signal }, deadline.signal);
      return await consume(response, deadline.signal);
    } finally {
      deadline.dispose();
    }
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const pendingResponse = this.#fetch(`${this.#baseUrl}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });
    const response = await waitForAbort(pendingResponse, signal, {
      onLateValue: (lateResponse, reason) => cancelResponse(lateResponse, reason),
    });
    if (response.ok) return response;

    let code = "CATALOG_REQUEST_FAILED";
    let message = `Catalog request failed (${response.status})`;
    try {
      const payload = record(await boundedJson(response, CATALOG_JSON_POLICY, signal));
      const error = record(payload.error);
      code = textValue(error.code, code);
      message = textValue(error.message, message);
    } catch {
      if (signal.aborted) throw abortReason(signal, "Catalog request aborted");
      // HTTP status and the generic message are intentionally sufficient. Never
      // include response text because it may contain a configured source path.
    }
    throw new CatalogApiError(response.status, code, message);
  }
}

export function createCatalogClient(options: HttpCatalogClientOptions = {}): CatalogApi {
  return new HttpCatalogClient(options);
}
