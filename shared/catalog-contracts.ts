export const CATALOG_API_PREFIX = "/api" as const;
/** Upper bound for ordinary catalog JSON responses. */
export const MAX_CATALOG_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Hard ceiling for the non-paginated household profile collection. */
export const MAX_CATALOG_PROFILES = 100;
/** Raw UTF-8 response-field budget for the complete profile collection. */
export const MAX_CATALOG_PROFILE_FIELD_BYTES = 512 * 1024;
/** Hard ceiling for distinct configured source roots across the service. */
export const MAX_CATALOG_ROOTS = 1_000;
/** Hard ceiling for source-root memberships in one profile. */
export const MAX_CATALOG_ROOTS_PER_PROFILE = 100;
/** Hard ceiling for all profile-to-root memberships across the service. */
export const MAX_CATALOG_ROOT_MEMBERSHIPS = 2_000;
/** Raw UTF-8 response-field budget for source-root collection responses. */
export const MAX_CATALOG_ROOT_FIELD_BYTES = 4 * 1024 * 1024;
/** Pre-materialization ceiling for UTF-8 bytes retained in filter values. */
export const MAX_CATALOG_FILTER_VALUE_BYTES = 1 * 1024 * 1024;
/** Pre-materialization ceiling for the complete non-paginated filter value set. */
export const MAX_CATALOG_FILTER_VALUES = 4_000;
/** Upper bound for the complete profile match-index JSON response. */
export const MAX_MATCH_INDEX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Hard profile-size ceiling for the non-paginated match-index endpoint. */
export const MAX_MATCH_INDEX_ENTRIES = 20_000;
/** Hard delivered-history ceiling before match-index generation fails closed. */
export const MAX_MATCH_INDEX_DELIVERIES = 40_000;
/** Bounded prior presentation identities retained per active catalog book. */
export const MAX_STALE_MANAGED_TOKENS_PER_BOOK = 16;
/** Fixed bitmap width for cross-profile metadata-claim collisions. */
export const METADATA_CLAIM_BITMAP_BYTES = Math.ceil(MAX_MATCH_INDEX_ENTRIES / 8);
export const METADATA_CLAIM_BITMAP_BASE64_LENGTH = 4 * Math.ceil(METADATA_CLAIM_BITMAP_BYTES / 3);
/** Maximum durable Send-later entries retained by one profile. */
export const MAX_SEND_QUEUE_ENTRIES_PER_PROFILE = 1_000;
/** Maximum opaque book IDs accepted by one queue mutation. */
export const MAX_SEND_QUEUE_MUTATION_BOOK_IDS = 500;
/** Maximum IDs materialized by the non-paginated filtered selection route. */
export const MAX_BOOK_SELECTION_IDS = 5_000;
/** Maximum user-created smart shelves retained by one profile. */
export const MAX_SMART_SHELVES_PER_PROFILE = 100;
/** Intentionally small sidebar pin budget. */
export const MAX_PINNED_SMART_SHELVES_PER_PROFILE = 8;
/** Durable favorite/want-to-read records retained by one profile. */
export const MAX_PROFILE_BOOK_ANNOTATIONS_PER_PROFILE = 20_000;
/** Exact UTF-8 ceiling for a canonical persisted shelf query. */
export const MAX_SMART_SHELF_QUERY_BYTES = 8 * 1024;
/** Maximum smart-shelf display-name length. */
export const MAX_SMART_SHELF_NAME_LENGTH = 80;
/** Hard ceiling for one series' all-volume quality analysis. */
export const MAX_SERIES_DETAIL_BOOKS = 20_000;
/** Provider suggestions returned by one explicit metadata search. */
export const MAX_METADATA_CANDIDATES = 12;
/** Explicit fields accepted by one provider metadata import. */
export const MAX_METADATA_IMPORT_FIELDS = 12;
/** Explicit upper bound for one review-only bulk provider lookup. */
export const MAX_METADATA_LOOKUP_JOB_BOOKS = 100;
/** Durable bulk lookup history retained per profile. */
export const MAX_METADATA_LOOKUP_JOBS_PER_PROFILE = 100;

export type BookFormat = "epub" | "azw3";
export type RootStatus =
  | "pending"
  | "scanning"
  | "available"
  | "watching"
  | "unavailable"
  | "permission_denied"
  | "paused"
  | "error";
export type DeliveryStatus = "queued" | "converting" | "sending" | "delivered" | "failed";
export type CatalogSort =
  | "recent"
  | "title"
  | "author"
  | "published"
  | "size"
  | "added"
  | "updated"
  | "series"
  | "series-index";
export type SortOrder = "asc" | "desc";
export type SmartShelfKindleStatus = "confirmed" | "possible" | "not-on-kindle" | "unknown";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, string | number | boolean>;
  };
}

export interface CatalogProfile {
  id: string;
  name: string;
  description: string | null;
  initial: string;
  sourceLabel: string | null;
  enabled: boolean;
  rootCount: number;
  availableRootCount: number;
  bookCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogRoot {
  id: string;
  profileId: string;
  label: string;
  path: string;
  recursive: boolean;
  watch: boolean;
  enabled: boolean;
  status: RootStatus;
  sentinel: string | null;
  mountIdentity: string | null;
  successfulScanCount: number;
  lastScanAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogBook {
  id: string;
  profileId: string;
  rootId: string;
  title: string;
  authors: string[];
  authorSort: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  series: string | null;
  seriesIndex: number | null;
  description: string | null;
  subjects: string[];
  identifiers: string[];
  format: BookFormat;
  size: number;
  contentHash: string;
  /** Source bytes plus the active metadata/cover overlay. A changed value
   * requires a fresh browser-local derivative without changing contentHash. */
  presentationVersion: string;
  sourceFilename: string;
  addedAt: string;
  updatedAt: string;
  metadataComplete: boolean;
  available: boolean;
  coverUrl: string | null;
  sourceUrl: string;
  metadataEdited: boolean;
  coverEdited: boolean;
  metadataRevision: number;
}

export interface EditableBookMetadata {
  title: string;
  authors: string[];
  authorSort: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  series: string | null;
  seriesIndex: number | null;
  description: string | null;
  subjects: string[];
  identifiers: string[];
}

export type EditableMetadataField = keyof EditableBookMetadata;

export type BookMetadataOverrides = Partial<EditableBookMetadata>;

export interface BookCoverOverride {
  assetKey: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  width: number;
  height: number;
  sourceKind: "upload" | "provider";
  provider: CoverProvider | null;
  providerReference: string | null;
  sourceUrl: string | null;
}

export interface BookMetadataState {
  book: CatalogBook;
  sourceMetadata: EditableBookMetadata;
  sourceCoverUrl: string | null;
  overrides: BookMetadataOverrides;
  revision: number;
  basedOnContentHash: string;
  sourceChanged: boolean;
  coverOverride: BookCoverOverride | null;
}

/** Server-owned provenance for the immutable source behind one catalog book. */
export interface BookDetailsSource {
  rootId: string;
  rootLabel: string;
  rootPath: string;
  rootStatus: RootStatus;
  rootLastScanAt: string | null;
  rootLastErrorCode: string | null;
  relativePath: string;
  available: boolean;
}

/** A deliberately device-anonymous summary of the newest verified transfer. */
export interface BookVerifiedDeliverySummary {
  filename: string | null;
  size: number | null;
  deliveredAt: string;
  currentPresentation: boolean;
}

/** Dedicated read-only DTO for the Book details drawer. */
export interface BookDetailsState extends BookMetadataState {
  source: BookDetailsSource;
  latestVerifiedDelivery: BookVerifiedDeliverySummary | null;
}

export interface BookMetadataPatchInput {
  expectedRevision: number;
  expectedContentHash: string;
  changes: BookMetadataOverrides;
}

export interface BookMetadataResetInput {
  expectedRevision: number;
  expectedContentHash: string;
  /** Omit to reset every metadata field while retaining a custom cover. */
  fields?: EditableMetadataField[];
}

export type CoverProvider = "google-books" | "open-library";

/** Online cover providers whose credentials can be managed by the service. */
export type ConfigurableCoverProvider = "google-books";

export type CoverProviderCredentialStatus = "not-configured" | "untested" | "working" | "error";

export type CoverProviderCredentialErrorCode =
  | "invalid-or-restricted-key"
  | "quota-exhausted"
  | "timeout"
  | "provider-unavailable";

/** Public Settings state. The saved credential is deliberately never exposed. */
export interface CoverProviderCredentialState {
  provider: ConfigurableCoverProvider;
  configured: boolean;
  /** Fixed display mask; it reveals neither key contents nor key length. */
  maskedKey: string | null;
  revision: number;
  status: CoverProviderCredentialStatus;
  lastTestedAt: string | null;
  errorCode: CoverProviderCredentialErrorCode | null;
}

export interface CoverProviderCredentialInput {
  apiKey: string;
  expectedRevision: number;
}

export interface CoverProviderCredentialTestInput {
  expectedRevision: number;
}

export interface CoverSearchCandidate {
  candidateId: string;
  title: string;
  authors: string[];
  publishedAt: string | null;
  identifiers: string[];
  /** Same-origin, bounded proxy URL; never a third-party hotlink. */
  thumbnailUrl: string;
}

export interface CoverSearchResult {
  provider: CoverProvider;
  items: CoverSearchCandidate[];
}

export interface CoverImportInput {
  expectedRevision: number;
  expectedContentHash: string;
  provider: CoverProvider;
  candidateId: string;
}

export type MetadataCandidateConfidence = "high" | "medium" | "low";

/** A normalized provider suggestion. Provider URLs and source paths are never
 * part of this contract; a later import resolves this bounded server-side
 * candidate by provider and candidateId. */
export interface CatalogMetadataCandidate {
  provider: CoverProvider;
  candidateId: string;
  confidence: MetadataCandidateConfidence;
  metadata: Partial<EditableBookMetadata>;
  coverCandidateId?: string;
}

export interface MetadataCandidateSearchTerms {
  title?: string;
  author?: string;
  identifier?: string;
}

export interface MetadataCandidateSearchResult {
  provider: CoverProvider;
  items: CatalogMetadataCandidate[];
}

export interface MetadataCandidateImportInput {
  provider: CoverProvider;
  candidateId: string;
  /** Present when the reviewed candidate came from a durable bulk lookup. */
  lookupJobId?: string;
  selectedFields: EditableMetadataField[];
  includeCover: boolean;
  expectedRevision: number;
  expectedContentHash: string;
}

export type MetadataLookupJobStatus = "queued" | "running" | "paused" | "completed" | "cancelled";
export type MetadataLookupEntryStatus = "pending" | "searching" | "ready" | "no-results" | "failed" | "cancelled";
export type MetadataLookupErrorCode =
  | "book-unavailable"
  | "provider-unavailable"
  | "provider-not-configured"
  | "provider-response-too-large"
  | "invalid-provider-response";

export interface MetadataLookupJobInput {
  provider: CoverProvider;
  bookIds: string[];
}

export interface MetadataLookupJobControlInput {
  expectedRevision: number;
}

export interface MetadataLookupJobEntry {
  jobId: string;
  bookId: string;
  rank: number;
  status: MetadataLookupEntryStatus;
  attempts: number;
  candidates: CatalogMetadataCandidate[];
  errorCode: MetadataLookupErrorCode | null;
  acceptedAt: string | null;
  updatedAt: string;
}

export interface MetadataLookupJob {
  id: string;
  profileId: string;
  provider: CoverProvider;
  status: MetadataLookupJobStatus;
  revision: number;
  /** Collection listings carry counts only; fetch the individual job for its bounded entries. */
  entriesIncluded: boolean;
  entries: MetadataLookupJobEntry[];
  total: number;
  pending: number;
  ready: number;
  noResults: number;
  failed: number;
  cancelled: number;
  createdAt: string;
  updatedAt: string;
}

export interface MetadataLookupJobPage {
  items: MetadataLookupJob[];
  total: number;
  limit: number;
  offset: number;
}

export interface BookPage {
  items: CatalogBook[];
  total: number;
  limit: number;
  offset: number;
}

export interface FilterValue {
  value: string;
  label?: string;
  count: number;
}

export interface CatalogFilters {
  authors: FilterValue[];
  languages: FilterValue[];
  subjects: FilterValue[];
  publishers: FilterValue[];
  series: FilterValue[];
  years: FilterValue[];
  formats: FilterValue[];
  roots: FilterValue[];
}

export interface DeliveryRecord {
  id: string;
  idempotencyKey: string;
  profileId: string;
  bookId: string;
  deviceKey: string;
  status: DeliveryStatus;
  artifactHash: string | null;
  filename: string | null;
  size: number | null;
  objectIdentity: string | null;
  managedToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogStatus {
  service: "kindle-bridge-catalog";
  version: number;
  live: boolean;
  ready: boolean;
  database: "ready" | "error";
  cache: "ready" | "degraded";
  scanner: "starting" | "ready" | "stopped";
  settingsMode: "read-write" | "read-only";
  roots: {
    configured: number;
    available: number;
    unavailable: number;
    errors: number;
  };
}

export type CatalogEventType =
  | "catalog.ready"
  | "catalog.snapshot"
  | "profile.created"
  | "profile.updated"
  | "profile.deleted"
  | "root.created"
  | "root.updated"
  | "root.deleted"
  | "root.scan.started"
  | "root.scan.completed"
  | "root.unavailable"
  | "book.added"
  | "book.updated"
  | "book.removed"
  | "delivery.updated"
  | "queue.updated"
  | "shelf.updated"
  | "annotation.updated"
  | "issues.updated"
  | "metadata-lookup.updated";

export interface CatalogEvent {
  id: string;
  type: CatalogEventType;
  at: string;
  profileId?: string;
  rootId?: string;
  bookId?: string;
  shelfId?: string;
  jobId?: string;
  data?: Record<string, unknown>;
}

export interface ProfileInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

export interface RootInput {
  id?: string;
  label: string;
  path: string;
  recursive?: boolean;
  watch?: boolean;
  enabled?: boolean;
  sentinel?: string | null;
  mountIdentity?: string | null;
}

export interface BookQuery {
  q?: string;
  author?: string;
  language?: string;
  subject?: string;
  publisher?: string;
  series?: string;
  /** Canonical NFKD/case/punctuation-insensitive series identity. */
  seriesKey?: string;
  year?: string;
  format?: BookFormat;
  rootId?: string;
  metadata?: "complete" | "partial";
  available?: boolean;
  coverAvailable?: boolean;
  /** Profile-owned manual state, kept distinct from Kindle evidence. */
  favorite?: boolean;
  /** Profile-owned manual state, kept distinct from Kindle evidence. */
  wantToRead?: boolean;
  sort?: CatalogSort;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

/** The sole durable smart-shelf query format. Pagination and device identity
 * are deliberately absent; Kindle status is evaluated in the browser against
 * a fresh reconciliation. */
export interface SmartShelfQueryV1 {
  version: 1;
  catalog?: {
    q?: string;
    author?: string;
    language?: string;
    subject?: string;
    publisher?: string;
    series?: string;
    seriesKey?: string;
    year?: string;
    format?: BookFormat;
    rootId?: string;
    metadata?: "complete" | "partial";
    available?: boolean;
    coverAvailable?: boolean;
    sort?: CatalogSort;
    order?: SortOrder;
  };
  personal?: {
    favorite?: boolean;
    wantToRead?: boolean;
  };
  kindleStatus?: SmartShelfKindleStatus;
}

export type SmartShelfQuery = SmartShelfQueryV1;

export interface SendQueueEntry {
  profileId: string;
  bookId: string;
  rank: number;
  queuedContentHash: string;
  queuedPresentationVersion: string;
  createdAt: string;
  updatedAt: string;
  book: CatalogBook | null;
  sourceState:
    | "ready"
    | "source-unavailable"
    | "source-changed"
    | "presentation-changed"
    | "unsupported"
    | "missing-or-retired";
}

export interface SendQueue {
  profileId: string;
  revision: number;
  entries: SendQueueEntry[];
  total: number;
  totalSourceBytes: number;
}

export interface SendQueueAddInput {
  expectedRevision: number;
  bookIds: string[];
}

export interface SendQueueReplaceInput extends SendQueueAddInput {}

export interface BookSelectionResult {
  profileId: string;
  bookIds: string[];
  total: number;
  ceiling: number;
}

export interface SmartShelf {
  id: string;
  profileId: string;
  name: string;
  query: SmartShelfQuery;
  pinnedRank: number | null;
  revision: number;
  serverCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SmartShelfCreateInput {
  name: string;
  query: SmartShelfQuery;
  pinned?: boolean;
}

export interface SmartShelfPatchInput {
  expectedRevision: number;
  name?: string;
  query?: SmartShelfQuery;
  pinned?: boolean;
}

export interface SmartShelfPinnedOrderInput {
  shelves: Array<{ id: string; expectedRevision: number }>;
}

export interface ProfileBookAnnotation {
  profileId: string;
  bookId: string;
  favorite: boolean;
  wantToRead: boolean;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProfileBookAnnotationPatchInput {
  expectedRevision: number;
  favorite?: boolean;
  wantToRead?: boolean;
}

export interface BookSetQuery extends BookQuery {
  includeBookIds?: string[];
  excludeBookIds?: string[];
}

export interface CatalogSeriesSummary {
  key: string;
  name: string;
  bookCount: number;
  numberedCount: number;
  unnumberedCount: number;
}

export interface CatalogSeriesSummaryPage {
  items: CatalogSeriesSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CatalogSeriesDetail {
  key: string;
  name: string;
  books: BookPage;
  duplicateIndices: number[];
  missingIntegerIndices: number[];
  unnumberedCount: number;
}

export interface MatchIndexEntry {
  bookId: string;
  /** Optional catalog-presentation preference; never Kindle deletion authority. */
  preferredPresentation?: true;
  title: string;
  authors: string[];
  authorSort: string | null;
  identifiers: string[];
  sourceFormat: BookFormat;
  sourceSize: number;
  contentHash: string;
  presentationVersion: string;
  sourceFilename: string;
  managedToken: string;
  staleManagedTokens: string[];
  deliveries: Array<{
    deviceKey: string;
    filename: string | null;
    artifactHash: string | null;
    artifactSize: number | null;
    objectIdentity: string | null;
    managedToken: string | null;
    status: DeliveryStatus;
    deliveredAt: string | null;
  }>;
}

export interface ProfileMatchIndex {
  profileId: string;
  generatedAt: string;
  metadataClaims: MetadataClaimSummary;
  entries: MatchIndexEntry[];
}

export interface MetadataClaimSummary {
  /** False means metadata-only matches must remain uncertain. */
  complete: boolean;
  /** Fixed-width base64 bitset; positions follow `entries` order. */
  collisionBitmap: string;
}

export interface ProfileConfigurationInput {
  profile: ProfileInput;
  roots: RootInput[];
}

export interface ProfileConfiguration {
  profile: CatalogProfile;
  roots: CatalogRoot[];
}

export interface DeliveryInput {
  profileId: string;
  bookId: string;
  deviceKey: string;
  status: DeliveryStatus;
  artifactHash?: string | null;
  filename?: string | null;
  size?: number | null;
  objectIdentity?: string | null;
  managedToken?: string | null;
}
