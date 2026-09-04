import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  MAX_CATALOG_FILTER_VALUE_BYTES,
  MAX_CATALOG_FILTER_VALUES,
  MAX_CATALOG_JSON_RESPONSE_BYTES,
  MAX_CATALOG_PROFILE_FIELD_BYTES,
  MAX_CATALOG_PROFILES,
  MAX_CATALOG_ROOT_FIELD_BYTES,
  MAX_CATALOG_ROOT_MEMBERSHIPS,
  MAX_CATALOG_ROOTS,
  MAX_CATALOG_ROOTS_PER_PROFILE,
  MAX_BOOK_SELECTION_IDS,
  MAX_MATCH_INDEX_DELIVERIES,
  MAX_MATCH_INDEX_ENTRIES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  MAX_METADATA_CANDIDATES,
  MAX_METADATA_LOOKUP_JOB_BOOKS,
  MAX_METADATA_LOOKUP_JOBS_PER_PROFILE,
  MAX_PINNED_SMART_SHELVES_PER_PROFILE,
  MAX_PROFILE_BOOK_ANNOTATIONS_PER_PROFILE,
  MAX_SEND_QUEUE_ENTRIES_PER_PROFILE,
  MAX_SEND_QUEUE_MUTATION_BOOK_IDS,
  MAX_SERIES_DETAIL_BOOKS,
  MAX_SMART_SHELF_NAME_LENGTH,
  MAX_SMART_SHELVES_PER_PROFILE,
  MAX_STALE_MANAGED_TOKENS_PER_BOOK,
  type BookFormat,
  type BookCoverOverride,
  type BookMetadataOverrides,
  type BookMetadataPatchInput,
  type BookMetadataResetInput,
  type BookMetadataState,
  type BookDetailsState,
  type BookPage,
  type BookSetQuery,
  type CatalogBook,
  type CatalogFilters,
  type CatalogSeriesDetail,
  type CatalogSeriesSummaryPage,
  type CatalogProfile,
  type CatalogRoot,
  type ConfigurableCoverProvider,
  type CoverProviderCredentialErrorCode,
  type CoverProviderCredentialState,
  type CoverProvider,
  type DeliveryInput,
  type DeliveryRecord,
  type EditableBookMetadata,
  type EditableMetadataField,
  type MatchIndexEntry,
  type CatalogMetadataCandidate,
  type MetadataCandidateSearchTerms,
  type MetadataLookupJob,
  type MetadataLookupJobEntry,
  type MetadataLookupErrorCode,
  type MetadataLookupJobInput,
  type MetadataLookupJobPage,
  type MetadataLookupJobStatus,
  type MetadataClaimSummary,
  type BookSelectionResult,
  type ProfileBookAnnotation,
  type ProfileBookAnnotationPatchInput,
  type ProfileInput,
  type ProfileConfiguration,
  type ProfileConfigurationInput,
  type ProfileMatchIndex,
  type RootInput,
  type RootStatus,
  type SendQueue,
  type SendQueueEntry,
  type SmartShelf,
  type SmartShelfCreateInput,
  type SmartShelfPatchInput,
  type SmartShelfPinnedOrderInput,
  type SmartShelfQuery,
} from "../shared/catalog-contracts.js";
import {
  deriveCatalogIssues,
  MAX_DERIVED_CATALOG_ISSUES,
  type CatalogHealthIssue,
  type CatalogHealthPage,
  type CatalogHealthQuery,
  type CatalogIssueBookFacts,
  type CatalogDuplicatePreferenceInput,
  type CatalogIssueDisposition,
  type CatalogIssueSourceFacts,
  type DerivedCatalogIssue,
} from "../shared/catalog-issues.js";
import { canonicalSeriesKey, MAX_USABLE_SERIES_INDEX, usableSeriesIndex } from "../shared/series.js";
import {
  decodeSmartShelfQuery,
  encodeSmartShelfQuery,
  smartShelfQueryToBookQuery,
  SmartShelfQueryError,
} from "../shared/shelf-query.js";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CONFIGURATION_WRITES_PER_PROFILE,
  MAX_DURABLE_MUTATION_REPLAYS_PER_PROFILE,
  MAX_UNREFERENCED_IDENTITIES_PER_ROOT,
  MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT,
  migrateCatalogDatabase,
} from "./migrations.js";
import {
  DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS,
  incompleteMetadataClaimSummary,
  summarizeGlobalMetadataClaims,
  type MetadataClaimBook,
} from "./metadata-claim-summary.js";

type SqlValue = string | number | bigint | Uint8Array | null;

interface Row {
  [key: string]: unknown;
}

export interface CoverProviderCredentialSnapshot {
  provider: ConfigurableCoverProvider;
  apiKey: string;
  revision: number;
}

export interface ExtractedBookInput {
  title: string;
  authors: string[];
  authorSort: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  series: string | null;
  seriesIndex?: number | null;
  description?: string | null;
  subjects: string[];
  identifiers: string[];
  metadataComplete: boolean;
  coverKey: string | null;
  coverMediaType: string | null;
  coverExpected?: boolean;
}

export interface CatalogFileInput {
  rootId: string;
  relativePath: string;
  format: BookFormat;
  size: number;
  mtimeMs: number;
  contentHash: string;
  /** Versioned bounded sample fingerprint used to avoid full unchanged-source reads. */
  quickFingerprint?: string | null;
  scanToken: string;
  /** Paths confirmed present in the current root generation. They cannot be
   * consumed as rename fallbacks for a newly discovered identical copy. */
  retainedRelativePaths?: ReadonlySet<string>;
  metadata: ExtractedBookInput;
}

export interface SourceFileSnapshot {
  id: string;
  bookId: string | null;
  size: number;
  mtimeMs: number;
  contentHash: string;
  quickFingerprint: string | null;
  available: boolean;
  lastErrorCode: string | null;
  coverKey: string | null;
  coverExpected: boolean;
}

export interface BookSourceRecord {
  book: CatalogBook;
  rootPath: string;
  relativePath: string;
  coverKey: string | null;
  coverMediaType: string | null;
  coverStorage: "cache" | "override";
  sourceCoverKey: string | null;
  sourceCoverMediaType: string | null;
}

export interface MetadataCoverAssetInput {
  assetKey: string;
  checksum: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  width: number;
  height: number;
  sourceKind: "upload" | "provider";
  provider: CoverProvider | null;
  providerReference: string | null;
  sourceUrl: string | null;
}

export interface CoverMutationResult {
  state: BookMetadataState;
  unreferencedAssetKey: string | null;
}

export interface CatalogIssueMutationResult {
  issue: CatalogHealthIssue;
  applied: boolean;
}

interface MetadataLookupAcceptance {
  readonly jobId: string;
  readonly provider: CoverProvider;
  readonly candidateId: string;
}

export interface MetadataLookupClaim {
  jobId: string;
  profileId: string;
  bookId: string;
  provider: CoverProvider;
  terms: MetadataCandidateSearchTerms;
}

export interface ScanRoot {
  id: string;
  path: string;
  recursive: boolean;
  watch: boolean;
  status: RootStatus;
  sentinel: string | null;
  mountIdentity: string | null;
  successfulScanCount: number;
  lastDeepScanAt: string | null;
  profileIds: string[];
}

export interface RootScanRequest {
  generation: number;
  reason: string;
}

/** Durable scan-request generation captured by an indexer before it starts
 * writing one root generation. Every scanner mutation verifies this fence
 * while holding the SQLite writer lock, so a configuration change committed
 * by another service cannot be overwritten by the retired scan. */
export interface RootScanFence {
  rootId: string;
  generation: number;
}

export class StaleCatalogScanError extends Error {
  constructor(readonly rootId: string) {
    super("The catalog scan was superseded by newer durable work.");
    this.name = "StaleCatalogScanError";
  }
}

export class CatalogDatabaseError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "conflict"
      | "invalid_state"
      | "too_large"
      | "selection_too_large"
      | "response_too_large"
      | "match_index_too_large",
    message: string,
  ) {
    super(message);
    this.name = "CatalogDatabaseError";
  }
}

interface MatchIndexLimits {
  maxEntries?: number;
  maxDeliveries?: number;
  maxResponseBytes?: number;
}

interface MatchBookRow extends Row {
  id: string;
  preferred_presentation: number;
  title: string;
  authors_json: string;
  author_sort: string | null;
  identifiers_json: string;
  format: string;
  size: number;
  content_hash: string;
  presentation_version: string;
  relative_path: string;
}

interface MatchDeliveryRow extends Row {
  book_id: string;
  device_key: string;
  artifact_hash: string | null;
  filename: string | null;
  size: number | null;
  object_persistent_id: string | null;
  managed_token: string | null;
  status: string;
  updated_at: string;
}

interface MatchStaleManagedTokenRow extends Row {
  book_id: string;
  managed_token: string;
}

interface MatchDeliveryRetentionRow extends MatchDeliveryRow {
  id: string;
}

interface MetadataClaimRow extends Row {
  id: string;
  title: string;
  authors_json: string;
  identifiers_json: string;
  has_known_artifact_size: number;
}

interface BoundedJsonSink {
  raw(value: string): void;
  string(value: string): void;
  nullableString(value: string | null): void;
  number(value: number | null): void;
}

interface BookQueryPlan {
  predicate: string;
  ftsJoin: string;
  values: SqlValue[];
  limit: number;
  offset: number;
  orderBy: string;
}

// These raw UTF-8 field budgets are intentionally well below the generic
// 32 MiB JSON response cap. Even worst-case JSON escaping (six output bytes
// per input byte) plus fixed object structure remains inside that contract.
const CATALOG_FILTER_FACET_COUNT = 8;
const MAX_METADATA_CLAIM_RAW_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_CLAIM_DELIVERY_ROWS = 500_000;
const MAX_FILTER_FIELD_BYTES_PER_FACET = Math.floor(
  MAX_CATALOG_FILTER_VALUE_BYTES / CATALOG_FILTER_FACET_COUNT,
);
const MAX_FILTER_VALUES_PER_FACET = Math.floor(MAX_CATALOG_FILTER_VALUES / CATALOG_FILTER_FACET_COUNT);

/**
 * Household-safe ceiling for transient and failed delivery attempts. The
 * browser controller records successful transfers as `delivered`; retaining
 * 10,000 other attempts per profile leaves ample diagnostic/idempotency
 * history without allowing currently unused status values to grow forever.
 */
export const MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE = 10_000;
const DELIVERY_HISTORY_MAINTENANCE_KEY = "delivery-history-retention-v1";
const COVER_PROVIDER_KEY_MASK = "••••••••";
const MAX_COVER_PROVIDER_API_KEY_LENGTH = 512;

export interface SendQueueMutationResult {
  queue: SendQueue;
  applied: boolean;
}

export interface SmartShelfMutationResult {
  shelf: SmartShelf;
  applied: boolean;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function now(): string {
  return new Date().toISOString();
}

function nestedPaths(left: string, right: string): boolean {
  if (left === right) return false;
  const relative = path.relative(left, right);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isDeepScanRequestReason(reason: string): boolean {
  return reason === "explicit"
    || reason === "manual"
    || reason === "source_changed"
    || reason === "deep-reconciliation";
}

function isAuthoritativeScanRequestReason(reason: string): boolean {
  return reason === "startup"
    || reason === "startup-followup"
    || reason === "explicit"
    || reason === "manual"
    || reason === "source_changed"
    || reason === "reconciliation"
    || reason === "deep-reconciliation";
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizedCoverProviderApiKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_COVER_PROVIDER_API_KEY_LENGTH
    || /[\u0000-\u0020\u007f]/u.test(normalized)
  ) {
    throw new RangeError("Cover-provider API key is invalid.");
  }
  return normalized;
}

function normalizedShelfName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > MAX_SMART_SHELF_NAME_LENGTH || /[\0\r\n]/u.test(normalized)) {
    throw new RangeError("Smart-shelf name is invalid.");
  }
  return normalized;
}

function mutationRequestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function coverProviderCredentialState(row: Row): CoverProviderCredentialState {
  const provider = String(row.provider) as ConfigurableCoverProvider;
  const configured = typeof row.api_key === "string" && row.api_key.length > 0;
  const testStatus = stringOrNull(row.last_test_status);
  const errorCode = stringOrNull(row.last_test_error_code) as CoverProviderCredentialErrorCode | null;
  return {
    provider,
    configured,
    maskedKey: configured ? COVER_PROVIDER_KEY_MASK : null,
    revision: Number(row.revision),
    status: !configured
      ? "not-configured"
      : testStatus === "working"
        ? "working"
        : testStatus === "error"
          ? "error"
          : "untested",
    lastTestedAt: configured ? stringOrNull(row.last_tested_at) : null,
    errorCode: configured ? errorCode : null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseMetadataCandidates(value: unknown): CatalogMetadataCandidate[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((candidate): candidate is CatalogMetadataCandidate => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const item = candidate as Partial<CatalogMetadataCandidate>;
      return (item.provider === "google-books" || item.provider === "open-library")
        && typeof item.candidateId === "string"
        && (item.confidence === "high" || item.confidence === "medium" || item.confidence === "low")
        && item.metadata !== null && typeof item.metadata === "object" && !Array.isArray(item.metadata);
    });
  } catch {
    return [];
  }
}

function profileInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function mapProfile(row: Row): CatalogProfile {
  const name = String(row.name);
  return {
    id: String(row.id),
    name,
    description: stringOrNull(row.description),
    initial: profileInitial(name),
    sourceLabel: stringOrNull(row.source_label),
    enabled: bool(row.enabled),
    rootCount: Number(row.root_count ?? 0),
    availableRootCount: Number(row.available_root_count ?? 0),
    bookCount: Number(row.book_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRoot(row: Row): CatalogRoot {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    label: String(row.label),
    path: String(row.path),
    recursive: bool(row.recursive),
    watch: bool(row.watch),
    enabled: bool(row.enabled),
    status: String(row.status) as RootStatus,
    sentinel: stringOrNull(row.sentinel_path),
    mountIdentity: stringOrNull(row.mount_identity),
    successfulScanCount: Number(row.successful_scan_count ?? 0),
    lastScanAt: stringOrNull(row.last_scan_at),
    lastErrorCode: stringOrNull(row.last_error_code),
    createdAt: String(row.membership_created_at ?? row.created_at),
    updatedAt: String(row.membership_updated_at ?? row.updated_at),
  };
}

function mapBook(row: Row): CatalogBook {
  const id = String(row.id);
  const profileId = String(row.profile_id);
  const hasCoverMedia = row.cover_media_present === undefined ? row.cover_media_type !== null : bool(row.cover_media_present);
  const hasCover = hasCoverMedia && row.cover_cache_key !== null;
  return {
    id,
    profileId,
    rootId: String(row.root_id),
    title: String(row.title),
    authors: parseStringArray(row.authors_json),
    authorSort: stringOrNull(row.author_sort),
    language: stringOrNull(row.language),
    publisher: stringOrNull(row.publisher),
    publishedAt: stringOrNull(row.published_at),
    series: stringOrNull(row.series),
    seriesIndex: numberOrNull(row.series_index),
    description: stringOrNull(row.description),
    subjects: parseStringArray(row.subjects_json),
    identifiers: parseStringArray(row.identifiers_json),
    format: String(row.format) as BookFormat,
    size: Number(row.size),
    contentHash: String(row.content_hash),
    presentationVersion: stringOrNull(row.presentation_version) ?? String(row.content_hash),
    sourceFilename: String(row.relative_path).split(/[\\/]/u).at(-1) ?? String(row.relative_path),
    addedAt: String(row.added_at),
    updatedAt: String(row.updated_at),
    metadataComplete: bool(row.metadata_complete),
    available: bool(row.available),
    coverUrl: hasCover
      ? `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(String(row.cover_cache_key))}`
      : null,
    sourceUrl: `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/source`,
    metadataEdited: bool(row.metadata_edited),
    coverEdited: bool(row.cover_edited),
    metadataRevision: Number(row.metadata_revision ?? 0),
  };
}

const EDITABLE_METADATA_FIELDS: readonly EditableMetadataField[] = [
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
];

const OVERRIDE_COLUMNS: Readonly<Record<EditableMetadataField, { set: string; value: string }>> = {
  title: { set: "title_set", value: "title" },
  authors: { set: "authors_set", value: "authors_json" },
  authorSort: { set: "author_sort_set", value: "author_sort" },
  language: { set: "language_set", value: "language" },
  publisher: { set: "publisher_set", value: "publisher" },
  publishedAt: { set: "published_at_set", value: "published_at" },
  series: { set: "series_set", value: "series" },
  seriesIndex: { set: "series_index_set", value: "series_index" },
  description: { set: "description_set", value: "description" },
  subjects: { set: "subjects_set", value: "subjects_json" },
  identifiers: { set: "identifiers_set", value: "identifiers_json" },
};

function editableMetadataFromRow(row: Row): EditableBookMetadata {
  return {
    title: String(row.title),
    authors: parseStringArray(row.authors_json),
    authorSort: stringOrNull(row.author_sort),
    language: stringOrNull(row.language),
    publisher: stringOrNull(row.publisher),
    publishedAt: stringOrNull(row.published_at),
    series: stringOrNull(row.series),
    seriesIndex: numberOrNull(row.series_index),
    description: stringOrNull(row.description),
    subjects: parseStringArray(row.subjects_json),
    identifiers: parseStringArray(row.identifiers_json),
  };
}

function overridesFromRow(row: Row | undefined): BookMetadataOverrides {
  if (!row) return {};
  const overrides: BookMetadataOverrides = {};
  for (const field of EDITABLE_METADATA_FIELDS) {
    const columns = OVERRIDE_COLUMNS[field];
    if (!bool(row[columns.set])) continue;
    const raw = row[columns.value];
    if (field === "authors" || field === "subjects" || field === "identifiers") {
      (overrides as Record<string, unknown>)[field] = parseStringArray(raw);
    } else if (field === "seriesIndex") {
      overrides.seriesIndex = numberOrNull(raw);
    } else if (field === "title") {
      overrides.title = String(raw);
    } else {
      (overrides as Record<string, unknown>)[field] = stringOrNull(raw);
    }
  }
  return overrides;
}

function mergeMetadata(source: EditableBookMetadata, overrides: BookMetadataOverrides): EditableBookMetadata {
  return { ...source, ...overrides };
}

function presentationVersionFor(
  sourceHash: string,
  metadata: EditableBookMetadata,
  metadataEdited: boolean,
  coverAssetKey: string | null,
): string {
  if (!metadataEdited && !coverAssetKey) return sourceHash;
  return createHash("sha256")
    .update(stableJson({ version: 1, sourceHash: sourceHash.toLocaleLowerCase(), metadata, coverAssetKey }))
    .digest("hex");
}

function mapCoverOverride(row: Row | undefined): BookCoverOverride | null {
  const assetKey = stringOrNull(row?.asset_present);
  const mediaType = stringOrNull(row?.asset_media_type);
  if (!assetKey || (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp")) {
    return null;
  }
  const sourceKind = stringOrNull(row?.asset_source_kind);
  if (sourceKind !== "upload" && sourceKind !== "provider") return null;
  const provider = stringOrNull(row?.asset_provider);
  return {
    assetKey,
    mediaType,
    byteLength: Number(row?.asset_byte_length),
    width: Number(row?.asset_width),
    height: Number(row?.asset_height),
    sourceKind,
    provider: provider === "google-books" || provider === "open-library" ? provider : null,
    providerReference: stringOrNull(row?.asset_provider_reference),
    sourceUrl: stringOrNull(row?.asset_source_url),
  };
}

const PROFILE_SELECT = `
  SELECT p.*,
    (SELECT count(*) FROM profile_roots pr
      WHERE pr.profile_id = p.id) AS root_count,
    (SELECT count(*) FROM profile_roots pr JOIN library_roots r ON r.id = pr.root_id
      WHERE pr.profile_id = p.id AND p.enabled = 1 AND pr.enabled = 1
        AND r.status IN ('available', 'watching', 'paused', 'scanning')) AS available_root_count,
    (SELECT count(*) FROM books b JOIN profile_roots pr ON pr.root_id = b.root_id
      WHERE pr.profile_id = p.id AND p.enabled = 1 AND pr.enabled = 1) AS book_count,
    (SELECT pr.label FROM profile_roots pr
      WHERE pr.profile_id = p.id
      ORDER BY pr.enabled DESC, pr.label COLLATE NOCASE, pr.root_id
      LIMIT 1) AS source_label
  FROM profiles p
`;

const BOOK_SELECT = `
  SELECT b.*, pr.profile_id, sf.format, sf.size, sf.content_hash, sf.relative_path
  FROM books b
  JOIN source_files sf ON sf.id = b.source_file_id
  JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
  JOIN profiles catalog_profile ON catalog_profile.id = pr.profile_id AND catalog_profile.enabled = 1
`;

const BOOK_PAGE_SELECT = `
  SELECT b.id, b.root_id, b.title, b.authors_json, b.author_sort, b.language, b.publisher,
    b.published_at, b.series, b.series_index, b.description, b.subjects_json, b.identifiers_json, b.metadata_complete,
    b.available, b.added_at, b.updated_at, b.cover_cache_key,
    b.presentation_version, b.metadata_edited, b.cover_edited, b.metadata_revision,
    (b.cover_media_type IS NOT NULL) AS cover_media_present,
    pr.profile_id, sf.format, sf.size, sf.content_hash, sf.relative_path
  FROM books b
  JOIN source_files sf ON sf.id = b.source_file_id
  JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
  JOIN profiles catalog_profile ON catalog_profile.id = pr.profile_id AND catalog_profile.enabled = 1
`;

const ROOT_SELECT = `
  SELECT r.*, pr.profile_id, pr.label, pr.enabled,
    pr.created_at AS membership_created_at, pr.updated_at AS membership_updated_at
  FROM library_roots r JOIN profile_roots pr ON pr.root_id = r.id
`;

export class CatalogDatabase {
  readonly database: DatabaseSync;
  readonly schemaVersion: number;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
    this.database.function(
      "kindle_bridge_managed_token",
      { deterministic: true, directOnly: true },
      (bookId, contentHash) =>
        typeof bookId === "string" && typeof contentHash === "string"
          ? managedTokenForBook(bookId, contentHash)
          : null,
    );
    this.database.function(
      "kindle_bridge_series_key",
      { deterministic: true, directOnly: true },
      (series) => typeof series === "string" ? canonicalSeriesKey(series) : "",
    );
    this.schemaVersion = migrateCatalogDatabase(this.database);
    if (this.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      throw new CatalogDatabaseError("invalid_state", "The catalog database schema is not supported.");
    }
    this.bootstrapSourceMetadata();
    this.recoverInterruptedMetadataLookupJobs();
    // Supported databases created before retention was enforced may already
    // exceed the live ceilings. Normalize them atomically before callers can
    // request a match index; otherwise the fail-closed index preflight could
    // prevent the next Send that would have healed the history on insertion.
    const maintenanceComplete = this.database
      .prepare("SELECT 1 AS complete FROM catalog_maintenance_markers WHERE key = ?")
      .get(DELIVERY_HISTORY_MAINTENANCE_KEY);
    if (!maintenanceComplete) {
      this.transaction(() => {
        // Re-check while holding the process-wide writer lock so concurrent
        // container starts cannot repeat the potentially expensive legacy pass.
        const completedWhileWaiting = this.database
          .prepare("SELECT 1 AS complete FROM catalog_maintenance_markers WHERE key = ?")
          .get(DELIVERY_HISTORY_MAINTENANCE_KEY);
        if (completedWhileWaiting) return;
        this.pruneDeliveryPartitionAcrossProfiles(true, MAX_MATCH_INDEX_DELIVERIES);
        this.pruneDeliveryPartitionAcrossProfiles(false, MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE);
        const profileIds = this.database
          .prepare(
            `SELECT DISTINCT d.profile_id AS id
             FROM deliveries d
             JOIN books b ON b.id = d.book_id
             JOIN source_files sf ON sf.id = b.source_file_id
             JOIN profile_roots pr
               ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
             JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
             WHERE d.status = 'delivered' AND b.available = 1 AND sf.available = 1
               AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
             ORDER BY d.profile_id LIMIT ?`,
          )
          .all(MAX_CATALOG_PROFILES) as Row[];
        for (const row of profileIds) {
          this.compactMatchIndexDeliveries(String(row.id), null, false);
        }
        // Delivery pruning above can make stable identities unreferenced. The
        // same legacy-maintenance transaction closes that newly exposed gap.
        this.pruneUnprotectedCatalogIdentities();
        this.database
          .prepare("INSERT INTO catalog_maintenance_markers(key, completed_at) VALUES (?, ?)")
          .run(DELIVERY_HISTORY_MAINTENANCE_KEY, now());
      });
    }
  }

  close(): void {
    this.database.close();
  }

  initializeCoverProviderCredentials(legacyGoogleBooksApiKey?: string): void {
    const timestamp = now();
    const apiKey = legacyGoogleBooksApiKey === undefined
      ? null
      : normalizedCoverProviderApiKey(legacyGoogleBooksApiKey);
    this.transaction(() => {
      this.database.prepare(
        `INSERT OR IGNORE INTO cover_provider_credentials(
           provider, api_key, configuration_state, revision, created_at, updated_at
         ) VALUES ('google-books', ?, ?, ?, ?, ?)`,
      ).run(apiKey, apiKey === null ? "never-configured" : "configured", apiKey === null ? 0 : 1, timestamp, timestamp);
      if (apiKey !== null) {
        // The explicit state, rather than secret contents, distinguishes a
        // first-start bootstrap from a deliberate removal.
        // Once a user saves or removes a key, an old environment value must
        // never silently reappear on a later restart.
        this.database.prepare(
          `UPDATE cover_provider_credentials
           SET api_key = ?, configuration_state = 'configured', revision = 1, last_tested_at = NULL,
             last_test_status = NULL, last_test_error_code = NULL, updated_at = ?
           WHERE provider = 'google-books' AND configuration_state = 'never-configured'
             AND revision = 0 AND api_key IS NULL`,
        ).run(apiKey, timestamp);
      }
    });
  }

  listCoverProviderCredentialStates(): CoverProviderCredentialState[] {
    return [this.getCoverProviderCredentialState("google-books")];
  }

  getCoverProviderCredentialState(provider: ConfigurableCoverProvider): CoverProviderCredentialState {
    const row = this.database.prepare(
      `SELECT provider, api_key, revision, last_tested_at, last_test_status, last_test_error_code
       FROM cover_provider_credentials WHERE provider = ?`,
    ).get(provider) as Row | undefined;
    if (!row) {
      return {
        provider,
        configured: false,
        maskedKey: null,
        revision: 0,
        status: "not-configured",
        lastTestedAt: null,
        errorCode: null,
      };
    }
    return coverProviderCredentialState(row);
  }

  getCoverProviderCredential(provider: ConfigurableCoverProvider): CoverProviderCredentialSnapshot | null {
    const row = this.database.prepare(
      `SELECT provider, api_key, revision FROM cover_provider_credentials WHERE provider = ?`,
    ).get(provider) as Row | undefined;
    const apiKey = stringOrNull(row?.api_key);
    if (!row || !apiKey) return null;
    return { provider, apiKey, revision: Number(row.revision) };
  }

  setCoverProviderCredential(
    provider: ConfigurableCoverProvider,
    apiKey: string,
    expectedRevision: number,
    idempotencyKey?: string,
  ): CoverProviderCredentialState {
    const normalized = normalizedCoverProviderApiKey(apiKey);
    return this.transaction(() => {
      const requestHash = mutationRequestHash({ apiKey: normalized, expectedRevision });
      const replay = idempotencyKey
        ? this.readCoverProviderMutationReplay(provider, "save", idempotencyKey, requestHash)
        : null;
      if (replay !== null) {
        const state = this.getCoverProviderCredentialState(provider);
        if (state.revision !== replay) {
          throw new CatalogDatabaseError("conflict", "Cover-provider settings changed after this request completed.");
        }
        return state;
      }
      const timestamp = now();
      this.database.prepare(
        `INSERT OR IGNORE INTO cover_provider_credentials(
           provider, api_key, configuration_state, revision, created_at, updated_at
         ) VALUES (?, NULL, 'never-configured', 0, ?, ?)`,
      ).run(provider, timestamp, timestamp);
      const changed = this.database.prepare(
        `UPDATE cover_provider_credentials
         SET api_key = ?, configuration_state = 'configured', revision = revision + 1, last_tested_at = NULL,
           last_test_status = NULL, last_test_error_code = NULL, updated_at = ?
         WHERE provider = ? AND revision = ?`,
      ).run(normalized, timestamp, provider, expectedRevision);
      if (changed.changes !== 1) {
        throw new CatalogDatabaseError("conflict", "Cover-provider settings changed in another browser.");
      }
      if (idempotencyKey) this.writeCoverProviderMutationReplay(provider, "save", idempotencyKey, requestHash, expectedRevision + 1, timestamp);
      return this.getCoverProviderCredentialState(provider);
    });
  }

  removeCoverProviderCredential(
    provider: ConfigurableCoverProvider,
    expectedRevision: number,
    idempotencyKey?: string,
  ): CoverProviderCredentialState {
    return this.transaction(() => {
      const requestHash = mutationRequestHash({ expectedRevision });
      const replay = idempotencyKey
        ? this.readCoverProviderMutationReplay(provider, "remove", idempotencyKey, requestHash)
        : null;
      if (replay !== null) {
        const state = this.getCoverProviderCredentialState(provider);
        if (state.revision !== replay) {
          throw new CatalogDatabaseError("conflict", "Cover-provider settings changed after this request completed.");
        }
        return state;
      }
      const timestamp = now();
      this.database.prepare(
        `INSERT OR IGNORE INTO cover_provider_credentials(
           provider, api_key, configuration_state, revision, created_at, updated_at
         ) VALUES (?, NULL, 'never-configured', 0, ?, ?)`,
      ).run(provider, timestamp, timestamp);
      const changed = this.database.prepare(
        `UPDATE cover_provider_credentials
         SET api_key = NULL, configuration_state = 'removed', revision = revision + 1, last_tested_at = NULL,
           last_test_status = NULL, last_test_error_code = NULL, updated_at = ?
         WHERE provider = ? AND revision = ?`,
      ).run(timestamp, provider, expectedRevision);
      if (changed.changes !== 1) {
        throw new CatalogDatabaseError("conflict", "Cover-provider settings changed in another browser.");
      }
      if (idempotencyKey) this.writeCoverProviderMutationReplay(provider, "remove", idempotencyKey, requestHash, expectedRevision + 1, timestamp);
      return this.getCoverProviderCredentialState(provider);
    });
  }

  private readCoverProviderMutationReplay(
    provider: ConfigurableCoverProvider,
    operation: "save" | "remove",
    idempotencyKey: string,
    requestHash: string,
  ): number | null {
    if (!idempotencyKey || idempotencyKey.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)) {
      throw new RangeError("Idempotency key is invalid.");
    }
    const row = this.database
      .prepare(
        `SELECT request_hash, result_revision FROM cover_provider_mutation_replays
         WHERE provider = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(provider, operation, idempotencyKey) as Row | undefined;
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) {
      throw new CatalogDatabaseError("conflict", "The idempotency key was already used for another provider request.");
    }
    return Number(row.result_revision);
  }

  private writeCoverProviderMutationReplay(
    provider: ConfigurableCoverProvider,
    operation: "save" | "remove",
    idempotencyKey: string,
    requestHash: string,
    resultRevision: number,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO cover_provider_mutation_replays(
           provider, operation, idempotency_key, request_hash, result_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(provider, operation, idempotencyKey, requestHash, resultRevision, timestamp);
    this.database
      .prepare(
        `DELETE FROM cover_provider_mutation_replays WHERE rowid IN (
           SELECT rowid FROM cover_provider_mutation_replays WHERE provider = ?
           ORDER BY created_at DESC, operation DESC, idempotency_key DESC LIMIT -1 OFFSET 1000
         )`,
      )
      .run(provider);
  }

  recordCoverProviderCredentialTest(
    provider: ConfigurableCoverProvider,
    expectedRevision: number,
    errorCode: CoverProviderCredentialErrorCode | null,
  ): CoverProviderCredentialState {
    const timestamp = now();
    const changed = this.database.prepare(
      `UPDATE cover_provider_credentials
       SET last_tested_at = ?, last_test_status = ?, last_test_error_code = ?, updated_at = ?
       WHERE provider = ? AND revision = ? AND api_key IS NOT NULL`,
    ).run(timestamp, errorCode === null ? "working" : "error", errorCode, timestamp, provider, expectedRevision);
    if (changed.changes !== 1) {
      throw new CatalogDatabaseError("conflict", "Cover-provider settings changed while the key was being tested.");
    }
    return this.getCoverProviderCredentialState(provider);
  }

  getSendQueue(profileId: string): SendQueue {
    this.assertDurableProfile(profileId);
    const state = this.database.prepare(
      "SELECT revision FROM send_queue_state WHERE profile_id = ?",
    ).get(profileId) as Row | undefined;
    const rows = this.database.prepare(
      `SELECT profile_id, book_id, rank, queued_content_hash, queued_presentation_version,
         created_at, updated_at
       FROM send_queue_entries WHERE profile_id = ?
       ORDER BY rank, created_at, book_id LIMIT ?`,
    ).all(profileId, MAX_SEND_QUEUE_ENTRIES_PER_PROFILE + 1) as Row[];
    if (rows.length > MAX_SEND_QUEUE_ENTRIES_PER_PROFILE) {
      throw new CatalogDatabaseError("invalid_state", "The Send-later queue exceeds its durable limit.");
    }
    let totalSourceBytes = 0;
    const entries = rows.map((row): SendQueueEntry => {
      const bookId = String(row.book_id);
      const queuedContentHash = String(row.queued_content_hash);
      const queuedPresentationVersion = String(row.queued_presentation_version);
      const book = this.getBook(profileId, bookId);
      if (book) totalSourceBytes += book.size;
      const sourceState: SendQueueEntry["sourceState"] = !book
        ? "missing-or-retired"
        : !book.available
          ? "source-unavailable"
          : book.format !== "epub" && book.format !== "azw3"
            ? "unsupported"
            : book.contentHash !== queuedContentHash
              ? "source-changed"
              : book.presentationVersion !== queuedPresentationVersion
                ? "presentation-changed"
                : "ready";
      return {
        profileId,
        bookId,
        rank: Number(row.rank),
        queuedContentHash,
        queuedPresentationVersion,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        book,
        sourceState,
      };
    });
    if (!Number.isSafeInteger(totalSourceBytes)) {
      throw new CatalogDatabaseError("invalid_state", "The Send-later queue byte total is invalid.");
    }
    return {
      profileId,
      revision: Number(state?.revision ?? 0),
      entries,
      total: entries.length,
      totalSourceBytes,
    };
  }

  addSendQueueEntries(
    profileId: string,
    bookIds: readonly string[],
    expectedRevision: number,
    idempotencyKey: string,
  ): SendQueueMutationResult {
    const ids = this.normalizedMutationBookIds(bookIds);
    if (ids.length === 0) throw new RangeError("At least one book is required.");
    const requestHash = mutationRequestHash({ expectedRevision, bookIds: ids });
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const replay = this.readDurableMutationReplay(profileId, "send-queue-add", idempotencyKey, requestHash);
      if (replay) return { queue: this.getSendQueue(profileId), applied: false };
      const currentRevision = this.ensureSendQueueState(profileId);
      if (currentRevision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The Send-later queue changed in another browser.");
      }
      const existingRows = this.database.prepare(
        "SELECT book_id FROM send_queue_entries WHERE profile_id = ?",
      ).all(profileId) as Row[];
      const existing = new Set(existingRows.map((row) => String(row.book_id)));
      const additions = ids.filter((id) => !existing.has(id));
      if (existing.size + additions.length > MAX_SEND_QUEUE_ENTRIES_PER_PROFILE) {
        throw new CatalogDatabaseError("too_large", "The Send-later queue has reached its per-profile limit.");
      }
      const timestamp = now();
      const highest = this.database.prepare(
        "SELECT coalesce(max(rank), -1) AS rank FROM send_queue_entries WHERE profile_id = ?",
      ).get(profileId) as Row;
      let rank = Number(highest.rank) + 1;
      const insert = this.database.prepare(
        `INSERT INTO send_queue_entries(
           profile_id, book_id, rank, queued_content_hash, queued_presentation_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const bookId of additions) {
        const book = this.getBook(profileId, bookId);
        if (!book) throw new CatalogDatabaseError("not_found", "A selected book is not available to this profile.");
        insert.run(profileId, bookId, rank, book.contentHash, book.presentationVersion, timestamp, timestamp);
        rank += 1;
      }
      const resultRevision = additions.length > 0
        ? this.bumpSendQueueRevision(profileId, expectedRevision, timestamp)
        : expectedRevision;
      this.writeDurableMutationReplay(
        profileId,
        "send-queue-add",
        idempotencyKey,
        requestHash,
        null,
        resultRevision,
        timestamp,
      );
      return { queue: this.getSendQueue(profileId), applied: additions.length > 0 };
    });
  }

  replaceSendQueue(
    profileId: string,
    bookIds: readonly string[],
    expectedRevision: number,
  ): SendQueueMutationResult {
    const ids = this.normalizedMutationBookIds(bookIds, MAX_SEND_QUEUE_ENTRIES_PER_PROFILE);
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const currentRevision = this.ensureSendQueueState(profileId);
      if (currentRevision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The Send-later queue changed in another browser.");
      }
      const existingRows = this.database.prepare(
        `SELECT book_id, rank FROM send_queue_entries WHERE profile_id = ?
         ORDER BY rank, created_at, book_id`,
      ).all(profileId) as Row[];
      const currentIds = existingRows.map((row) => String(row.book_id));
      const changed = currentIds.length !== ids.length || currentIds.some((id, index) => id !== ids[index]);
      if (!changed) return { queue: this.getSendQueue(profileId), applied: false };
      const existing = new Set(currentIds);
      for (const bookId of ids) {
        if (!existing.has(bookId) && !this.getBook(profileId, bookId)) {
          throw new CatalogDatabaseError("not_found", "A selected book is not available to this profile.");
        }
      }
      const timestamp = now();
      this.database.prepare(
        `DELETE FROM send_queue_entries
         WHERE profile_id = ? AND book_id NOT IN (SELECT value FROM json_each(?))`,
      ).run(profileId, JSON.stringify(ids));
      const insert = this.database.prepare(
        `INSERT INTO send_queue_entries(
           profile_id, book_id, rank, queued_content_hash, queued_presentation_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = this.database.prepare(
        "UPDATE send_queue_entries SET rank = ?, updated_at = ? WHERE profile_id = ? AND book_id = ?",
      );
      ids.forEach((bookId, rank) => {
        if (existing.has(bookId)) {
          update.run(rank, timestamp, profileId, bookId);
          return;
        }
        const book = this.getBook(profileId, bookId) as CatalogBook;
        insert.run(profileId, bookId, rank, book.contentHash, book.presentationVersion, timestamp, timestamp);
      });
      this.bumpSendQueueRevision(profileId, expectedRevision, timestamp);
      return { queue: this.getSendQueue(profileId), applied: true };
    });
  }

  removeSendQueueEntry(profileId: string, bookId: string, expectedRevision: number): SendQueueMutationResult {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const currentRevision = this.ensureSendQueueState(profileId);
      if (currentRevision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The Send-later queue changed in another browser.");
      }
      const removed = this.database.prepare(
        "DELETE FROM send_queue_entries WHERE profile_id = ? AND book_id = ?",
      ).run(profileId, bookId);
      if (removed.changes > 0) this.bumpSendQueueRevision(profileId, expectedRevision, now());
      return { queue: this.getSendQueue(profileId), applied: removed.changes > 0 };
    });
  }

  clearSendQueue(profileId: string, expectedRevision: number): SendQueueMutationResult {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const currentRevision = this.ensureSendQueueState(profileId);
      if (currentRevision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The Send-later queue changed in another browser.");
      }
      const removed = this.database.prepare("DELETE FROM send_queue_entries WHERE profile_id = ?").run(profileId);
      if (removed.changes > 0) this.bumpSendQueueRevision(profileId, expectedRevision, now());
      return { queue: this.getSendQueue(profileId), applied: removed.changes > 0 };
    });
  }

  resolveBookSelection(
    profileId: string,
    query: BookSetQuery,
    ceiling = MAX_BOOK_SELECTION_IDS,
  ): BookSelectionResult {
    this.assertDurableProfile(profileId);
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > MAX_BOOK_SELECTION_IDS) {
      throw new RangeError("Book-selection ceiling is invalid.");
    }
    const unpaged: BookSetQuery = { ...query };
    delete unpaged.limit;
    delete unpaged.offset;
    const plan = this.bookQueryPlan(profileId, unpaged);
    const count = this.database.prepare(
      `SELECT count(DISTINCT b.id) AS total FROM books b
       JOIN source_files sf ON sf.id = b.source_file_id
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       ${plan.ftsJoin} WHERE ${plan.predicate}`,
    ).get(...plan.values) as Row;
    const total = Number(count.total ?? 0);
    if (!Number.isSafeInteger(total) || total > ceiling) {
      throw new CatalogDatabaseError(
        "selection_too_large",
        `The filtered selection exceeds the ${ceiling}-book limit. Narrow the filters and try again.`,
      );
    }
    const rows = this.database.prepare(
      `SELECT DISTINCT b.id FROM books b
       JOIN source_files sf ON sf.id = b.source_file_id
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       ${plan.ftsJoin} WHERE ${plan.predicate}
       ORDER BY ${plan.orderBy} LIMIT ?`,
    ).all(...plan.values, ceiling + 1) as Row[];
    if (rows.length !== total) throw new CatalogDatabaseError("invalid_state", "Filtered selection changed unexpectedly.");
    return { profileId, bookIds: rows.map((row) => String(row.id)), total, ceiling };
  }

  listSeries(
    profileId: string,
    options: { q?: string; limit?: number; offset?: number } = {},
  ): CatalogSeriesSummaryPage {
    this.assertDurableProfile(profileId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const search = options.q === undefined ? null : canonicalSeriesKey(options.q);
    if (options.q !== undefined && !search) return { items: [], total: 0, limit, offset };
    const predicate = search === null ? "" : "AND kindle_bridge_series_key(b.series) LIKE '%' || ? || '%'";
    const values: SqlValue[] = search === null ? [profileId] : [profileId, search];
    const from = `FROM books b
      JOIN source_files sf ON sf.id = b.source_file_id
      JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
      JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
      WHERE pr.profile_id = ? AND kindle_bridge_series_key(b.series) <> '' ${predicate}`;
    const count = this.database.prepare(
      `SELECT count(DISTINCT kindle_bridge_series_key(b.series)) AS total ${from}`,
    ).get(...values) as Row;
    const rows = this.database.prepare(
      `SELECT kindle_bridge_series_key(b.series) AS series_key,
         min(trim(b.series)) AS series_name,
         count(*) AS book_count,
         sum(CASE WHEN b.series_index > 0 AND b.series_index <= ${MAX_USABLE_SERIES_INDEX} THEN 1 ELSE 0 END)
           AS numbered_count
       ${from}
       GROUP BY series_key
       ORDER BY series_name COLLATE NOCASE, series_key
       LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset) as Row[];
    return {
      items: rows.map((row) => {
        const bookCount = Number(row.book_count);
        const numberedCount = Number(row.numbered_count ?? 0);
        return {
          key: String(row.series_key),
          name: String(row.series_name),
          bookCount,
          numberedCount,
          unnumberedCount: bookCount - numberedCount,
        };
      }),
      total: Number(count.total ?? 0),
      limit,
      offset,
    };
  }

  getSeries(
    profileId: string,
    seriesKey: string,
    options: { limit?: number; offset?: number } = {},
  ): CatalogSeriesDetail | null {
    this.assertDurableProfile(profileId);
    if (!seriesKey || canonicalSeriesKey(seriesKey) !== seriesKey || seriesKey.length > 500) {
      throw new RangeError("Series key is invalid.");
    }
    const summary = this.database.prepare(
      `SELECT min(trim(b.series)) AS series_name, count(*) AS book_count,
         sum(CASE WHEN b.series_index > 0 AND b.series_index <= ${MAX_USABLE_SERIES_INDEX} THEN 1 ELSE 0 END)
           AS numbered_count
       FROM books b
       JOIN source_files sf ON sf.id = b.source_file_id
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       WHERE pr.profile_id = ? AND kindle_bridge_series_key(b.series) = ?`,
    ).get(profileId, seriesKey) as Row;
    const total = Number(summary.book_count ?? 0);
    if (total === 0) return null;
    if (!Number.isSafeInteger(total) || total > MAX_SERIES_DETAIL_BOOKS) {
      throw new CatalogDatabaseError("too_large", "This series exceeds the bounded detail limit.");
    }
    const indexRows = this.database.prepare(
      `SELECT b.series_index FROM books b
       JOIN source_files sf ON sf.id = b.source_file_id
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       WHERE pr.profile_id = ? AND kindle_bridge_series_key(b.series) = ?
       ORDER BY b.series_index, b.id LIMIT ?`,
    ).all(profileId, seriesKey, MAX_SERIES_DETAIL_BOOKS + 1) as Row[];
    const counts = new Map<number, number>();
    const integerIndices = new Set<number>();
    for (const row of indexRows) {
      const index = usableSeriesIndex(numberOrNull(row.series_index));
      if (index === null) continue;
      counts.set(index, (counts.get(index) ?? 0) + 1);
      if (Number.isInteger(index)) integerIndices.add(index);
    }
    const duplicateIndices = [...counts]
      .filter(([, count]) => count > 1)
      .map(([index]) => index)
      .sort((left, right) => left - right);
    const missingIntegerIndices: number[] = [];
    if (integerIndices.size > 1) {
      const minimum = Math.min(...integerIndices);
      const maximum = Math.max(...integerIndices);
      for (let index = minimum; index <= maximum && missingIntegerIndices.length < 1_000; index += 1) {
        if (!integerIndices.has(index)) missingIntegerIndices.push(index);
      }
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    return {
      key: seriesKey,
      name: String(summary.series_name),
      books: this.listBooks(profileId, {
        seriesKey,
        sort: "series-index",
        order: "asc",
        limit,
        offset,
      }),
      duplicateIndices,
      missingIntegerIndices,
      unnumberedCount: total - Number(summary.numbered_count ?? 0),
    };
  }

  listSmartShelves(profileId: string): SmartShelf[] {
    this.assertDurableProfile(profileId);
    const rows = this.database.prepare(
      `SELECT * FROM smart_shelves WHERE profile_id = ?
       ORDER BY pinned_rank IS NULL, pinned_rank, name COLLATE NOCASE, id
       LIMIT ?`,
    ).all(profileId, MAX_SMART_SHELVES_PER_PROFILE + 1) as Row[];
    if (rows.length > MAX_SMART_SHELVES_PER_PROFILE) {
      throw new CatalogDatabaseError("invalid_state", "The smart-shelf collection exceeds its durable limit.");
    }
    return rows.map((row) => this.mapSmartShelf(row));
  }

  getSmartShelf(profileId: string, shelfId: string): SmartShelf | null {
    this.assertDurableProfile(profileId);
    const row = this.database.prepare(
      "SELECT * FROM smart_shelves WHERE profile_id = ? AND id = ?",
    ).get(profileId, shelfId) as Row | undefined;
    return row ? this.mapSmartShelf(row) : null;
  }

  createSmartShelf(
    profileId: string,
    input: SmartShelfCreateInput,
    idempotencyKey: string,
  ): SmartShelfMutationResult {
    const name = normalizedShelfName(input.name);
    const queryJson = encodeSmartShelfQuery(input.query);
    const pinned = input.pinned ?? false;
    const requestHash = mutationRequestHash({ name, query: JSON.parse(queryJson), pinned });
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const replay = this.readDurableMutationReplay(profileId, "smart-shelf-create", idempotencyKey, requestHash);
      if (replay) {
        const shelf = replay.resourceId ? this.getSmartShelf(profileId, replay.resourceId) : null;
        if (!shelf) throw new CatalogDatabaseError("invalid_state", "The replayed smart shelf no longer exists.");
        return { shelf, applied: false };
      }
      const total = this.database.prepare(
        "SELECT count(*) AS count FROM smart_shelves WHERE profile_id = ?",
      ).get(profileId) as Row;
      if (Number(total.count) >= MAX_SMART_SHELVES_PER_PROFILE) {
        throw new CatalogDatabaseError("too_large", "This profile has reached its smart-shelf limit.");
      }
      this.assertShelfNameAvailable(profileId, name);
      const pinnedRank = pinned ? this.nextPinnedShelfRank(profileId) : null;
      const timestamp = now();
      const shelfId = opaqueId("shelf");
      this.database.prepare(
        `INSERT INTO smart_shelves(
           id, profile_id, name, query_version, query_json, pinned_rank, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?)`,
      ).run(shelfId, profileId, name, queryJson, pinnedRank, timestamp, timestamp);
      this.writeDurableMutationReplay(
        profileId,
        "smart-shelf-create",
        idempotencyKey,
        requestHash,
        shelfId,
        1,
        timestamp,
      );
      return { shelf: this.getSmartShelf(profileId, shelfId) as SmartShelf, applied: true };
    });
  }

  updateSmartShelf(profileId: string, shelfId: string, input: SmartShelfPatchInput): SmartShelfMutationResult {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const current = this.database.prepare(
        "SELECT * FROM smart_shelves WHERE profile_id = ? AND id = ?",
      ).get(profileId, shelfId) as Row | undefined;
      if (!current) throw new CatalogDatabaseError("not_found", "Smart shelf not found.");
      if (Number(current.revision) !== input.expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The smart shelf changed in another browser.");
      }
      const name = input.name === undefined ? String(current.name) : normalizedShelfName(input.name);
      if (name.toLocaleLowerCase() !== String(current.name).toLocaleLowerCase()) {
        this.assertShelfNameAvailable(profileId, name, shelfId);
      }
      const queryJson = input.query === undefined ? String(current.query_json) : encodeSmartShelfQuery(input.query);
      let pinnedRank = current.pinned_rank === null ? null : Number(current.pinned_rank);
      if (input.pinned === false) pinnedRank = null;
      if (input.pinned === true && pinnedRank === null) pinnedRank = this.nextPinnedShelfRank(profileId);
      const changed = name !== String(current.name)
        || queryJson !== String(current.query_json)
        || pinnedRank !== (current.pinned_rank === null ? null : Number(current.pinned_rank));
      if (!changed) return { shelf: this.mapSmartShelf(current), applied: false };
      const timestamp = now();
      const updated = this.database.prepare(
        `UPDATE smart_shelves SET name = ?, query_json = ?, pinned_rank = ?, revision = revision + 1, updated_at = ?
         WHERE profile_id = ? AND id = ? AND revision = ?`,
      ).run(name, queryJson, pinnedRank, timestamp, profileId, shelfId, input.expectedRevision);
      if (updated.changes !== 1) throw new CatalogDatabaseError("conflict", "The smart shelf changed in another browser.");
      return { shelf: this.getSmartShelf(profileId, shelfId) as SmartShelf, applied: true };
    });
  }

  reorderPinnedSmartShelves(
    profileId: string,
    input: SmartShelfPinnedOrderInput,
  ): { shelves: SmartShelf[]; applied: boolean; affectedShelfIds: string[] } {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      if (input.shelves.length > MAX_PINNED_SMART_SHELVES_PER_PROFILE) {
        throw new CatalogDatabaseError("too_large", "Pinned smart-shelf order exceeds its limit.");
      }
      const ids = input.shelves.map((item) => item.id);
      if (new Set(ids).size !== ids.length) throw new RangeError("Pinned smart-shelf order contains duplicates.");
      const rows = this.database.prepare(
        `SELECT id, revision, pinned_rank FROM smart_shelves
         WHERE profile_id = ? AND pinned_rank IS NOT NULL ORDER BY pinned_rank, id`,
      ).all(profileId) as Row[];
      const currentIds = rows.map((row) => String(row.id));
      if (currentIds.length !== ids.length || currentIds.some((id) => !ids.includes(id))) {
        throw new CatalogDatabaseError("conflict", "The pinned smart-shelf set changed in another browser.");
      }
      const expected = new Map(input.shelves.map((item) => [item.id, item.expectedRevision]));
      if (rows.some((row) => expected.get(String(row.id)) !== Number(row.revision))) {
        throw new CatalogDatabaseError("conflict", "A pinned smart shelf changed in another browser.");
      }
      const timestamp = now();
      const affectedShelfIds: string[] = [];
      ids.forEach((id, rank) => {
        const current = rows.find((row) => String(row.id) === id) as Row;
        if (Number(current.pinned_rank) === rank) return;
        const update = this.database.prepare(
          `UPDATE smart_shelves SET pinned_rank = ?, revision = revision + 1, updated_at = ?
           WHERE profile_id = ? AND id = ? AND revision = ?`,
        ).run(rank, timestamp, profileId, id, Number(current.revision));
        if (update.changes !== 1) throw new CatalogDatabaseError("conflict", "A pinned smart shelf changed in another browser.");
        affectedShelfIds.push(id);
      });
      return { shelves: this.listSmartShelves(profileId), applied: affectedShelfIds.length > 0, affectedShelfIds };
    });
  }

  deleteSmartShelf(profileId: string, shelfId: string, expectedRevision: number): boolean {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const result = this.database.prepare(
        "DELETE FROM smart_shelves WHERE profile_id = ? AND id = ? AND revision = ?",
      ).run(profileId, shelfId, expectedRevision);
      if (result.changes > 0) return true;
      const exists = this.database.prepare(
        "SELECT 1 AS present FROM smart_shelves WHERE profile_id = ? AND id = ?",
      ).get(profileId, shelfId);
      if (exists) throw new CatalogDatabaseError("conflict", "The smart shelf changed in another browser.");
      throw new CatalogDatabaseError("not_found", "Smart shelf not found.");
    });
  }

  getProfileBookAnnotation(profileId: string, bookId: string): ProfileBookAnnotation {
    this.assertDurableProfile(profileId);
    const row = this.database.prepare(
      "SELECT * FROM profile_book_annotations WHERE profile_id = ? AND book_id = ?",
    ).get(profileId, bookId) as Row | undefined;
    if (!row) {
      this.assertStableBookScope(profileId, bookId);
      return {
        profileId,
        bookId,
        favorite: false,
        wantToRead: false,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      };
    }
    return this.mapProfileBookAnnotation(row);
  }

  updateProfileBookAnnotation(
    profileId: string,
    bookId: string,
    input: ProfileBookAnnotationPatchInput,
  ): { annotation: ProfileBookAnnotation; applied: boolean } {
    return this.transaction(() => {
      this.assertDurableProfile(profileId);
      const row = this.database.prepare(
        "SELECT * FROM profile_book_annotations WHERE profile_id = ? AND book_id = ?",
      ).get(profileId, bookId) as Row | undefined;
      if (!row) this.assertStableBookScope(profileId, bookId);
      const currentRevision = Number(row?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The book annotation changed in another browser.");
      }
      const favorite = input.favorite ?? (row ? bool(row.favorite) : false);
      const wantToRead = input.wantToRead ?? (row ? bool(row.want_to_read) : false);
      const changed = row
        ? favorite !== bool(row.favorite) || wantToRead !== bool(row.want_to_read)
        : favorite || wantToRead;
      if (!changed) {
        return {
          annotation: row ? this.mapProfileBookAnnotation(row) : this.getProfileBookAnnotation(profileId, bookId),
          applied: false,
        };
      }
      if (!row) {
        const total = this.database.prepare(
          "SELECT count(*) AS count FROM profile_book_annotations WHERE profile_id = ?",
        ).get(profileId) as Row;
        if (Number(total.count) >= MAX_PROFILE_BOOK_ANNOTATIONS_PER_PROFILE) {
          throw new CatalogDatabaseError("too_large", "This profile has reached its personal-annotation limit.");
        }
      }
      const timestamp = now();
      this.database.prepare(
        `INSERT INTO profile_book_annotations(
           profile_id, book_id, favorite, want_to_read, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(profile_id, book_id) DO UPDATE SET
           favorite = excluded.favorite, want_to_read = excluded.want_to_read,
           revision = profile_book_annotations.revision + 1, updated_at = excluded.updated_at`,
      ).run(profileId, bookId, favorite ? 1 : 0, wantToRead ? 1 : 0, timestamp, timestamp);
      return {
        annotation: this.getProfileBookAnnotation(profileId, bookId),
        applied: true,
      };
    });
  }

  private assertDurableProfile(profileId: string): void {
    if (!this.database.prepare("SELECT 1 AS present FROM profiles WHERE id = ?").get(profileId)) {
      throw new CatalogDatabaseError("not_found", "Profile not found.");
    }
  }

  private assertStableBookScope(profileId: string, bookId: string): void {
    const row = this.database.prepare(
      `SELECT 1 AS present FROM profile_roots pr
       JOIN catalog_book_identities identity ON identity.root_id = pr.root_id
       WHERE pr.profile_id = ? AND identity.book_id = ? LIMIT 1`,
    ).get(profileId, bookId);
    if (!row) throw new CatalogDatabaseError("not_found", "Book not found for this profile.");
  }

  private normalizedMutationBookIds(
    bookIds: readonly string[],
    maximum = MAX_SEND_QUEUE_MUTATION_BOOK_IDS,
  ): string[] {
    if (!Array.isArray(bookIds) || bookIds.length > maximum) {
      throw new RangeError("Send-later queue mutation exceeds its book limit.");
    }
    const ids = bookIds.map((value) => {
      if (typeof value !== "string" || !/^book_[A-Za-z0-9_-]{8,80}$/u.test(value)) {
        throw new RangeError("Send-later queue contains an invalid book identifier.");
      }
      return value;
    });
    if (new Set(ids).size !== ids.length) throw new RangeError("Send-later queue mutation contains duplicate books.");
    return ids;
  }

  private ensureSendQueueState(profileId: string): number {
    const timestamp = now();
    this.database.prepare(
      "INSERT OR IGNORE INTO send_queue_state(profile_id, revision, updated_at) VALUES (?, 0, ?)",
    ).run(profileId, timestamp);
    const row = this.database.prepare(
      "SELECT revision FROM send_queue_state WHERE profile_id = ?",
    ).get(profileId) as Row;
    return Number(row.revision);
  }

  private bumpSendQueueRevision(profileId: string, expectedRevision: number, timestamp: string): number {
    const updated = this.database.prepare(
      `UPDATE send_queue_state SET revision = revision + 1, updated_at = ?
       WHERE profile_id = ? AND revision = ?`,
    ).run(timestamp, profileId, expectedRevision);
    if (updated.changes !== 1) throw new CatalogDatabaseError("conflict", "The Send-later queue changed in another browser.");
    return expectedRevision + 1;
  }

  private readDurableMutationReplay(
    profileId: string,
    operation: "send-queue-add" | "smart-shelf-create",
    idempotencyKey: string,
    requestHash: string,
  ): { resourceId: string | null; resultRevision: number } | null {
    const row = this.database.prepare(
      `SELECT request_hash, resource_id, result_revision FROM durable_mutation_replays
       WHERE profile_id = ? AND operation = ? AND idempotency_key = ?`,
    ).get(profileId, operation, idempotencyKey) as Row | undefined;
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) {
      throw new CatalogDatabaseError("conflict", "The idempotency key was already used for another request.");
    }
    return { resourceId: stringOrNull(row.resource_id), resultRevision: Number(row.result_revision) };
  }

  private writeDurableMutationReplay(
    profileId: string,
    operation: "send-queue-add" | "smart-shelf-create",
    idempotencyKey: string,
    requestHash: string,
    resourceId: string | null,
    resultRevision: number,
    timestamp: string,
  ): void {
    if (!idempotencyKey || idempotencyKey.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)) {
      throw new RangeError("Idempotency key is invalid.");
    }
    this.database.prepare(
      `INSERT INTO durable_mutation_replays(
         profile_id, operation, idempotency_key, request_hash, resource_id, result_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(profileId, operation, idempotencyKey, requestHash, resourceId, resultRevision, timestamp);
    this.database.prepare(
      `DELETE FROM durable_mutation_replays
       WHERE profile_id = ? AND rowid IN (
         SELECT rowid FROM durable_mutation_replays WHERE profile_id = ?
         ORDER BY created_at DESC, operation DESC, idempotency_key DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(profileId, profileId, MAX_DURABLE_MUTATION_REPLAYS_PER_PROFILE);
  }

  private assertShelfNameAvailable(profileId: string, name: string, excludingId?: string): void {
    const row = this.database.prepare(
      `SELECT 1 AS present FROM smart_shelves
       WHERE profile_id = ? AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1`,
    ).get(profileId, name, excludingId ?? null, excludingId ?? null);
    if (row) throw new CatalogDatabaseError("conflict", "A smart shelf with that name already exists.");
  }

  private nextPinnedShelfRank(profileId: string): number {
    const count = this.database.prepare(
      "SELECT count(*) AS count FROM smart_shelves WHERE profile_id = ? AND pinned_rank IS NOT NULL",
    ).get(profileId) as Row;
    if (Number(count.count) >= MAX_PINNED_SMART_SHELVES_PER_PROFILE) {
      throw new CatalogDatabaseError("too_large", "This profile has reached its pinned smart-shelf limit.");
    }
    const row = this.database.prepare(
      "SELECT coalesce(max(pinned_rank), -1) AS rank FROM smart_shelves WHERE profile_id = ?",
    ).get(profileId) as Row;
    return Number(row.rank) + 1;
  }

  private mapSmartShelf(row: Row): SmartShelf {
    let query: SmartShelfQuery;
    try {
      query = decodeSmartShelfQuery(String(row.query_json));
    } catch (error) {
      if (error instanceof SmartShelfQueryError) {
        throw new CatalogDatabaseError("invalid_state", "A persisted smart-shelf query is invalid.");
      }
      throw error;
    }
    const serverCount = query.kindleStatus === undefined
      ? this.listBooks(String(row.profile_id), { ...smartShelfQueryToBookQuery(query), limit: 1, offset: 0 }).total
      : null;
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      name: String(row.name),
      query,
      pinnedRank: row.pinned_rank === null ? null : Number(row.pinned_rank),
      revision: Number(row.revision),
      serverCount,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapProfileBookAnnotation(row: Row): ProfileBookAnnotation {
    return {
      profileId: String(row.profile_id),
      bookId: String(row.book_id),
      favorite: bool(row.favorite),
      wantToRead: bool(row.want_to_read),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private bootstrapSourceMetadata(): void {
    this.database.exec(`
      INSERT INTO book_source_metadata(
        book_id, title, authors_json, author_sort, language, publisher, published_at,
        series, series_index, description, subjects_json, identifiers_json,
        metadata_complete, cover_media_type, cover_cache_key, cover_expected, updated_at
      )
      SELECT b.id, b.title, b.authors_json, b.author_sort, b.language, b.publisher, b.published_at,
        b.series, b.series_index, b.description, b.subjects_json, b.identifiers_json,
        b.metadata_complete, b.cover_media_type, b.cover_cache_key, b.cover_expected, b.updated_at
      FROM books b
      WHERE NOT EXISTS (SELECT 1 FROM book_source_metadata sm WHERE sm.book_id = b.id);
    `);
  }

  private recoverInterruptedMetadataLookupJobs(): void {
    this.transaction(() => {
      const timestamp = now();
      this.database
        .prepare(
          `UPDATE metadata_lookup_entries SET status = 'pending', error_code = NULL, updated_at = ?
           WHERE status = 'searching'
             AND job_id IN (SELECT id FROM metadata_lookup_jobs WHERE status = 'running')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE metadata_lookup_jobs SET status = 'paused', revision = revision + 1, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(timestamp);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Must be called from inside BEGIN IMMEDIATE unless the caller embeds the
   * same predicate in its single atomic UPDATE. */
  private assertRootScanFence(fence: RootScanFence): void {
    const request = this.database
      .prepare("SELECT generation FROM scan_requests WHERE root_id = ? AND pending = 1")
      .get(fence.rootId) as Row | undefined;
    if (!request || Number(request.generation) !== fence.generation) {
      throw new StaleCatalogScanError(fence.rootId);
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN DEFERRED");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertProfileCollectionLimits(): void {
    const usage = this.database
      .prepare(
        `SELECT count(*) AS profile_count,
           coalesce(sum(
             length(CAST(id AS BLOB)) + length(CAST(name AS BLOB))
             + coalesce(length(CAST(description AS BLOB)), 0)
             + length(CAST(created_at AS BLOB)) + length(CAST(updated_at AS BLOB))
           ), 0) AS field_bytes
         FROM profiles`,
      )
      .get() as Row;
    if (Number(usage.profile_count) > MAX_CATALOG_PROFILES) {
      throw new CatalogDatabaseError(
        "too_large",
        `The catalog cannot contain more than ${MAX_CATALOG_PROFILES} household profiles.`,
      );
    }
    if (Number(usage.field_bytes) > MAX_CATALOG_PROFILE_FIELD_BYTES) {
      throw new CatalogDatabaseError(
        "too_large",
        `The profile collection exceeds its ${MAX_CATALOG_PROFILE_FIELD_BYTES}-byte field budget.`,
      );
    }
  }

  private assertRootCollectionLimits(profileId?: string): void {
    const fieldBytes = `
      coalesce(length(CAST(pr.profile_id AS BLOB)), 0) + length(CAST(r.id AS BLOB))
      + coalesce(length(CAST(pr.label AS BLOB)), 0) + length(CAST(r.path AS BLOB))
      + length(CAST(r.status AS BLOB))
      + coalesce(length(CAST(r.sentinel_path AS BLOB)), 0)
      + coalesce(length(CAST(r.mount_identity AS BLOB)), 0)
      + coalesce(length(CAST(r.last_scan_at AS BLOB)), 0)
      + coalesce(length(CAST(r.last_error_code AS BLOB)), 0)
      + coalesce(length(CAST(r.last_deep_scan_at AS BLOB)), 0)
      + coalesce(length(CAST(pr.created_at AS BLOB)), 0)
      + coalesce(length(CAST(pr.updated_at AS BLOB)), 0)`;
    if (profileId !== undefined) {
      const usage = this.database
        .prepare(
          `SELECT count(*) AS membership_count,
             coalesce(sum(${fieldBytes}), 0) AS field_bytes
           FROM profile_roots pr JOIN library_roots r ON r.id = pr.root_id
           WHERE pr.profile_id = ?`,
        )
        .get(profileId) as Row;
      if (Number(usage.membership_count) > MAX_CATALOG_ROOTS_PER_PROFILE) {
        throw new CatalogDatabaseError(
          "too_large",
          `A profile cannot contain more than ${MAX_CATALOG_ROOTS_PER_PROFILE} source roots.`,
        );
      }
      if (Number(usage.field_bytes) > MAX_CATALOG_ROOT_FIELD_BYTES) {
        throw new CatalogDatabaseError(
          "too_large",
          `The source-root collection exceeds its ${MAX_CATALOG_ROOT_FIELD_BYTES}-byte field budget.`,
        );
      }
      return;
    }

    const usage = this.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM library_roots) AS root_count,
           (SELECT count(*) FROM profile_roots) AS membership_count,
           (SELECT coalesce(max(profile_count), 0)
              FROM (SELECT count(*) AS profile_count FROM profile_roots GROUP BY profile_id)
           ) AS max_profile_roots,
           (SELECT coalesce(sum(${fieldBytes}), 0)
              FROM library_roots r LEFT JOIN profile_roots pr ON pr.root_id = r.id
           ) AS field_bytes`,
      )
      .get() as Row;
    if (Number(usage.root_count) > MAX_CATALOG_ROOTS) {
      throw new CatalogDatabaseError(
        "too_large",
        `The catalog cannot contain more than ${MAX_CATALOG_ROOTS} distinct source roots.`,
      );
    }
    if (Number(usage.membership_count) > MAX_CATALOG_ROOT_MEMBERSHIPS) {
      throw new CatalogDatabaseError(
        "too_large",
        `The catalog cannot contain more than ${MAX_CATALOG_ROOT_MEMBERSHIPS} profile-to-root memberships.`,
      );
    }
    if (Number(usage.max_profile_roots) > MAX_CATALOG_ROOTS_PER_PROFILE) {
      throw new CatalogDatabaseError(
        "too_large",
        `A profile cannot contain more than ${MAX_CATALOG_ROOTS_PER_PROFILE} source roots.`,
      );
    }
    if (Number(usage.field_bytes) > MAX_CATALOG_ROOT_FIELD_BYTES) {
      throw new CatalogDatabaseError(
        "too_large",
        `The source-root collection exceeds its ${MAX_CATALOG_ROOT_FIELD_BYTES}-byte field budget.`,
      );
    }
  }

  private assertCatalogCollectionLimits(): void {
    this.assertProfileCollectionLimits();
    this.assertRootCollectionLimits();
  }

  private assertRootPathDoesNotOverlap(candidate: string, ignoredRootIds: ReadonlySet<string> = new Set()): void {
    this.assertRootCollectionLimits();
    const rows = this.database.prepare("SELECT id, path FROM library_roots").all() as Row[];
    for (const row of rows) {
      if (ignoredRootIds.has(String(row.id))) continue;
      const existing = String(row.path);
      if (existing === candidate) continue; // Exact paths intentionally share one scan.
      if (nestedPaths(existing, candidate) || nestedPaths(candidate, existing)) {
        throw new CatalogDatabaseError(
          "conflict",
          "Nested or overlapping source roots are not allowed because they would duplicate indexed books.",
        );
      }
    }
  }

  listProfiles(): CatalogProfile[] {
    this.assertCatalogCollectionLimits();
    return (this.database.prepare(`${PROFILE_SELECT} ORDER BY p.name COLLATE NOCASE, p.id`).all() as Row[]).map(
      mapProfile,
    );
  }

  getProfile(id: string): CatalogProfile | null {
    const row = this.database.prepare(`${PROFILE_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    return row ? mapProfile(row) : null;
  }

  createProfile(input: ProfileInput): CatalogProfile {
    const timestamp = now();
    const id = opaqueId("prf");
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO profiles(id, name, description, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.description ?? null, input.enabled === false ? 0 : 1, timestamp, timestamp);
      this.assertProfileCollectionLimits();
    });
    return this.getProfile(id) as CatalogProfile;
  }

  createProfileIdempotent(
    input: ProfileInput,
    idempotencyKey: string,
  ): { profile: CatalogProfile; created: boolean } {
    const result = this.applyProfileConfiguration(
      null,
      { profile: input, roots: [] },
      idempotencyKey,
      "profile_create",
    );
    return { profile: result.configuration.profile, created: result.created };
  }

  updateProfile(id: string, input: Partial<ProfileInput>): CatalogProfile {
    return this.updateProfileMutation(id, input, false).profile;
  }

  updateProfileWithEffects(
    id: string,
    input: Partial<ProfileInput>,
  ): { profile: CatalogProfile; scanRootIds: string[] } {
    return this.updateProfileMutation(id, input, true);
  }

  private updateProfileMutation(
    id: string,
    input: Partial<ProfileInput>,
    writeScanIntent: boolean,
  ): { profile: CatalogProfile; scanRootIds: string[] } {
    return this.transaction(() => {
      // Re-read after BEGIN IMMEDIATE. A second service process may have
      // changed the enabled state while this caller was waiting for the writer
      // lock; using a pre-transaction snapshot could silently undo that change
      // and bypass the false-to-true match-index serviceability check.
      const existing = this.getProfile(id);
      if (!existing) {
        throw new CatalogDatabaseError("not_found", "Profile not found.");
      }
      const enabled = input.enabled ?? existing.enabled;
      const timestamp = now();
      this.database
        .prepare("UPDATE profiles SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(
          input.name ?? existing.name,
          input.description === undefined ? existing.description : input.description,
          enabled ? 1 : 0,
          timestamp,
          id,
        );
      this.assertProfileCollectionLimits();
      if (!existing.enabled && enabled) {
        this.compactMatchIndexDeliveries(id, null, true);
        this.assertMatchIndexServiceable(id);
      }
      const scanRootIds = !existing.enabled && enabled
        ? (this.database
            .prepare(
              `SELECT pr.root_id FROM profile_roots pr
               WHERE pr.profile_id = ? AND pr.enabled = 1
               ORDER BY pr.root_id`,
            )
            .all(id) as Row[]).map((row) => String(row.root_id))
        : [];
      if (writeScanIntent) {
        for (const rootId of scanRootIds) this.ensureRootScanRequest(rootId, "manual", timestamp, true);
      }
      return { profile: this.getProfile(id) as CatalogProfile, scanRootIds };
    });
  }

  deleteProfile(id: string): boolean {
    return this.transaction(() => {
      this.assertCatalogCollectionLimits();
      const result = this.database.prepare("DELETE FROM profiles WHERE id = ?").run(id);
      const orphanRows = this.database
        .prepare(
          `SELECT r.id FROM library_roots r
           WHERE NOT EXISTS (SELECT 1 FROM profile_roots pr WHERE pr.root_id = r.id)`,
        )
        .all() as Row[];
      for (const row of orphanRows) {
        const rootId = String(row.id);
        this.database.prepare("DELETE FROM books_fts WHERE book_id IN (SELECT id FROM books WHERE root_id = ?)").run(rootId);
        this.database.prepare("DELETE FROM library_roots WHERE id = ?").run(rootId);
      }
      if (Number(result.changes) > 0) this.pruneUnprotectedCatalogIdentities();
      return Number(result.changes) > 0;
    });
  }

  listRoots(profileId?: string): CatalogRoot[] {
    this.assertRootCollectionLimits(profileId);
    const rows = profileId
      ? (this.database
          .prepare(`${ROOT_SELECT} WHERE pr.profile_id = ? ORDER BY pr.label COLLATE NOCASE, r.id`)
          .all(profileId) as Row[])
      : (this.database.prepare(`${ROOT_SELECT} ORDER BY pr.profile_id, pr.label COLLATE NOCASE, r.id`).all() as Row[]);
    return rows.map(mapRoot);
  }

  listScanRoots(): ScanRoot[] {
    this.assertRootCollectionLimits();
    const rows = this.database
      .prepare(
        `SELECT r.*, json_group_array(pr.profile_id) AS profile_ids
         FROM library_roots r
         JOIN profile_roots pr ON pr.root_id = r.id
         JOIN profiles p ON p.id = pr.profile_id
         WHERE pr.enabled = 1 AND p.enabled = 1
         GROUP BY r.id ORDER BY r.id`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      path: String(row.path),
      recursive: bool(row.recursive),
      watch: bool(row.watch),
      status: String(row.status) as RootStatus,
      sentinel: stringOrNull(row.sentinel_path),
      mountIdentity: stringOrNull(row.mount_identity),
      successfulScanCount: Number(row.successful_scan_count ?? 0),
      lastDeepScanAt: stringOrNull(row.last_deep_scan_at),
      profileIds: parseStringArray(row.profile_ids),
    }));
  }

  rootHasSources(rootId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS present FROM source_files WHERE root_id = ? LIMIT 1")
      .get(rootId) as Row | undefined;
    return row !== undefined;
  }

  getRoot(profileId: string, id: string): CatalogRoot | null {
    const row = this.database.prepare(`${ROOT_SELECT} WHERE pr.profile_id = ? AND r.id = ?`).get(profileId, id) as
      | Row
      | undefined;
    return row ? mapRoot(row) : null;
  }

  createRoot(profileId: string, input: RootInput): CatalogRoot {
    return this.createRootMutation(profileId, input, false).root;
  }

  createRootWithEffects(
    profileId: string,
    input: RootInput,
  ): { root: CatalogRoot; scanQueued: boolean } {
    return this.createRootMutation(profileId, input, true);
  }

  private createRootMutation(
    profileId: string,
    input: RootInput,
    writeScanIntent: boolean,
  ): { root: CatalogRoot; scanQueued: boolean } {
    return this.transaction(() => {
      // Both the ownership and overlap checks must observe the same writer
      // snapshot as the insert. SQLite cannot express the nested-path rule as
      // a UNIQUE constraint, so a pre-lock check is not sufficient.
      const profile = this.getProfile(profileId);
      if (!profile) {
        throw new CatalogDatabaseError("not_found", "Profile not found.");
      }
      this.assertRootPathDoesNotOverlap(input.path);
      const timestamp = now();
      const shared = this.database.prepare("SELECT * FROM library_roots WHERE path = ?").get(input.path) as
        | Row
        | undefined;
      const id = shared ? String(shared.id) : opaqueId("root");
      if (shared && this.getRoot(profileId, id)) {
        throw new CatalogDatabaseError("conflict", "That source root is already configured for this profile.");
      }
      if (
        shared &&
        (bool(shared.recursive) !== (input.recursive !== false) ||
          bool(shared.watch) !== (input.watch !== false) ||
          stringOrNull(shared.sentinel_path) !== (input.sentinel ?? null) ||
          stringOrNull(shared.mount_identity) !== (input.mountIdentity ?? null))
      ) {
        throw new CatalogDatabaseError(
          "conflict",
          "That shared source root is already configured with different scan options.",
        );
      }
      if (!shared) {
        this.database
          .prepare(
            `INSERT INTO library_roots(
               id, path, recursive, watch, sentinel_path, mount_identity, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            id,
            input.path,
            input.recursive === false ? 0 : 1,
            input.watch === false ? 0 : 1,
            input.sentinel ?? null,
            input.mountIdentity ?? null,
            timestamp,
            timestamp,
          );
      }
      this.database
        .prepare(
          `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(profileId, id, input.label, input.enabled === false ? 0 : 1, timestamp, timestamp);
      this.assertRootCollectionLimits();
      if (profile.enabled && input.enabled !== false && shared) {
        this.compactMatchIndexDeliveries(profileId, null, true);
        this.assertMatchIndexServiceable(profileId);
      }
      const scanQueued = profile.enabled && input.enabled !== false;
      if (writeScanIntent && scanQueued) this.ensureRootScanRequest(id, "manual", timestamp, true);
      return { root: this.getRoot(profileId, id) as CatalogRoot, scanQueued };
    });
  }

  applyProfileConfiguration(
    profileId: string | null,
    input: ProfileConfigurationInput,
    idempotencyKey: string,
    operationScope: "configuration" | "profile_create" = "configuration",
  ): { configuration: ProfileConfiguration; created: boolean; applied: boolean } {
    if (input.roots.length > MAX_CATALOG_ROOTS_PER_PROFILE) {
      throw new CatalogDatabaseError(
        "too_large",
        `A profile configuration cannot contain more than ${MAX_CATALOG_ROOTS_PER_PROFILE} source roots.`,
      );
    }
    // Keep the historical configuration hash stable across schema upgrades;
    // the direct profile-create route adds an operation scope so the same key
    // cannot replay across two semantically different endpoints.
    const requestHashPayload = operationScope === "configuration"
      ? { profileId, input }
      : { operationScope, profileId, input };
    const requestHash = createHash("sha256").update(stableJson(requestHashPayload)).digest("hex");
    const uniquePaths = new Set(input.roots.map((root) => root.path));
    if (uniquePaths.size !== input.roots.length) {
      throw new CatalogDatabaseError("conflict", "A configuration cannot contain duplicate source roots.");
    }
    for (let left = 0; left < input.roots.length; left += 1) {
      for (let right = left + 1; right < input.roots.length; right += 1) {
        const first = input.roots[left]!.path;
        const second = input.roots[right]!.path;
        if (nestedPaths(first, second) || nestedPaths(second, first)) {
          throw new CatalogDatabaseError("conflict", "A configuration cannot contain nested source roots.");
        }
      }
    }
    const result = this.transaction(() => {
      // Re-check the replay ledger only after acquiring the writer lock. Two
      // processes can otherwise both observe a missing key and the loser would
      // surface an internal UNIQUE failure instead of the committed replay.
      const replay = this.database
        .prepare("SELECT * FROM configuration_writes WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | undefined;
      if (replay) {
        if (String(replay.request_hash) !== requestHash) {
          throw new CatalogDatabaseError("conflict", "The idempotency key was already used for another request.");
        }
        const replayProfileId = String(replay.profile_id);
        if (!this.getProfile(replayProfileId)) {
          throw new CatalogDatabaseError("invalid_state", "The saved configuration no longer exists.");
        }
        return { resolvedProfileId: replayProfileId, created: false, applied: false };
      }

      this.assertCatalogCollectionLimits();
      // Recompute removability under the same writer snapshot. A root that was
      // sole-owned before BEGIN may have acquired a second membership while
      // this request waited; ignoring it would permit a nested replacement.
      const removableRootIds = new Set<string>();
      if (profileId) {
        const current = this.database
          .prepare(
            `SELECT pr.root_id,
               (SELECT count(*) FROM profile_roots all_pr WHERE all_pr.root_id = pr.root_id) AS memberships
             FROM profile_roots pr WHERE pr.profile_id = ?`,
          )
          .all(profileId) as Row[];
        for (const row of current) {
          if (Number(row.memberships) === 1) removableRootIds.add(String(row.root_id));
        }
      }
      for (const root of input.roots) {
        const ignored = new Set(removableRootIds);
        if (root.id) ignored.add(root.id);
        this.assertRootPathDoesNotOverlap(root.path, ignored);
      }

      const timestamp = now();
      const existingProfile = profileId ? this.getProfile(profileId) : null;
      if (profileId && !existingProfile) {
        throw new CatalogDatabaseError("not_found", "Profile not found.");
      }
      const resolvedProfileId = profileId ?? opaqueId("prf");
      const profileBecameEnabled = Boolean(
        existingProfile && !existingProfile.enabled && input.profile.enabled !== false,
      );
      let exposesCatalogEvidence = profileBecameEnabled;
      const rootsNeedingScan = new Map<string, "configuration" | "manual">();
      if (existingProfile) {
        this.database
          .prepare("UPDATE profiles SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?")
          .run(
            input.profile.name,
            input.profile.description ?? null,
            input.profile.enabled === false ? 0 : 1,
            timestamp,
            resolvedProfileId,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO profiles(id, name, description, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resolvedProfileId,
            input.profile.name,
            input.profile.description ?? null,
            input.profile.enabled === false ? 0 : 1,
            timestamp,
            timestamp,
          );
      }

      const desiredRootIds = new Set<string>();
      for (const rootInput of input.roots) {
        let rootRow: Row | undefined;
        if (rootInput.id) {
          rootRow = this.database
            .prepare(
              `SELECT r.* FROM library_roots r JOIN profile_roots pr ON pr.root_id = r.id
               WHERE pr.profile_id = ? AND r.id = ?`,
            )
            .get(resolvedProfileId, rootInput.id) as Row | undefined;
          if (!rootRow) {
            throw new CatalogDatabaseError("not_found", "A configured source root was not found for this profile.");
          }
        } else {
          rootRow = this.database.prepare("SELECT * FROM library_roots WHERE path = ?").get(rootInput.path) as
            | Row
            | undefined;
        }

        let rootId = rootRow ? String(rootRow.id) : opaqueId("root");
        const existingMembership = rootRow
          ? (this.database
              .prepare("SELECT enabled FROM profile_roots WHERE profile_id = ? AND root_id = ?")
              .get(resolvedProfileId, rootId) as Row | undefined)
          : undefined;
        if (
          input.profile.enabled !== false
          && rootInput.enabled !== false
          && rootRow
          && (!existingMembership || !bool(existingMembership.enabled))
        ) {
          exposesCatalogEvidence = true;
        }
        const otherMembershipCount = rootRow
          ? Number(
              (
                this.database
                  .prepare("SELECT count(*) AS count FROM profile_roots WHERE root_id = ? AND profile_id <> ?")
                  .get(rootId, resolvedProfileId) as Row
              ).count,
            )
          : 0;
        const pathChanged = Boolean(rootRow && String(rootRow.path) !== rootInput.path);
        const deepScanOptionsChanged = Boolean(
          rootRow &&
            (bool(rootRow.recursive) !== (rootInput.recursive !== false) ||
              stringOrNull(rootRow.sentinel_path) !== (rootInput.sentinel ?? null) ||
              stringOrNull(rootRow.mount_identity) !== (rootInput.mountIdentity ?? null)),
        );
        const watchChanged = Boolean(rootRow && bool(rootRow.watch) !== (rootInput.watch !== false));
        const optionsChanged = deepScanOptionsChanged || watchChanged;
        const membershipBecameEnabled = rootInput.enabled !== false
          && (!existingMembership || !bool(existingMembership.enabled));
        if (rootRow && otherMembershipCount > 0 && (pathChanged || optionsChanged)) {
          throw new CatalogDatabaseError("conflict", "Shared source scan settings cannot be changed from one profile.");
        }
        if (pathChanged) {
          const collision = this.database
            .prepare("SELECT id FROM library_roots WHERE path = ? AND id <> ?")
            .get(rootInput.path, rootId);
          if (collision) {
            throw new CatalogDatabaseError("conflict", "Another source root already uses that path.");
          }
          this.markRootRebuildPending(rootId, timestamp);
          this.database.prepare("DELETE FROM books_fts WHERE book_id IN (SELECT id FROM books WHERE root_id = ?)").run(rootId);
          this.database.prepare("DELETE FROM source_files WHERE root_id = ?").run(rootId);
        }
        if (rootRow) {
          this.database
            .prepare(
              `UPDATE library_roots SET path = ?, recursive = ?, watch = ?, sentinel_path = ?, mount_identity = ?,
                 status = CASE WHEN ? = 1 THEN 'pending' ELSE status END,
                 last_error_code = CASE WHEN ? = 1 THEN NULL ELSE last_error_code END, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              rootInput.path,
              rootInput.recursive === false ? 0 : 1,
              rootInput.watch === false ? 0 : 1,
              rootInput.sentinel ?? null,
              rootInput.mountIdentity ?? null,
              pathChanged || optionsChanged ? 1 : 0,
              pathChanged || optionsChanged ? 1 : 0,
              timestamp,
              rootId,
            );
        } else {
          this.database
            .prepare(
              `INSERT INTO library_roots(
                 id, path, recursive, watch, sentinel_path, mount_identity, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              rootId,
              rootInput.path,
              rootInput.recursive === false ? 0 : 1,
              rootInput.watch === false ? 0 : 1,
              rootInput.sentinel ?? null,
              rootInput.mountIdentity ?? null,
              timestamp,
              timestamp,
            );
        }
        this.database
          .prepare(
            `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, root_id) DO UPDATE SET
               label = excluded.label, enabled = excluded.enabled, updated_at = excluded.updated_at`,
          )
          .run(
            resolvedProfileId,
            rootId,
            rootInput.label,
            rootInput.enabled === false ? 0 : 1,
            timestamp,
            timestamp,
          );
        desiredRootIds.add(rootId);
        const activeMembership = input.profile.enabled !== false && rootInput.enabled !== false;
        if (pathChanged || deepScanOptionsChanged) {
          // Even an inactive root can still have an old scan running in another
          // service. Advance its durable generation now; it will remain queued
          // until a membership becomes active again.
          rootsNeedingScan.set(rootId, "manual");
        } else if (watchChanged) {
          rootsNeedingScan.set(rootId, "configuration");
        }
        if (activeMembership && (profileBecameEnabled || !rootRow || membershipBecameEnabled)) {
          rootsNeedingScan.set(rootId, "manual");
        }
      }

      const currentMemberships = this.database
        .prepare("SELECT root_id FROM profile_roots WHERE profile_id = ?")
        .all(resolvedProfileId) as Row[];
      for (const membership of currentMemberships) {
        const rootId = String(membership.root_id);
        if (!desiredRootIds.has(rootId)) {
          this.database
            .prepare("DELETE FROM profile_roots WHERE profile_id = ? AND root_id = ?")
            .run(resolvedProfileId, rootId);
          const remaining = this.database
            .prepare("SELECT count(*) AS count FROM profile_roots WHERE root_id = ?")
            .get(rootId) as Row;
          if (Number(remaining.count) === 0) {
            this.database
              .prepare("DELETE FROM books_fts WHERE book_id IN (SELECT id FROM books WHERE root_id = ?)")
              .run(rootId);
            this.database.prepare("DELETE FROM library_roots WHERE id = ?").run(rootId);
          }
        }
      }
      this.assertCatalogCollectionLimits();
      if (exposesCatalogEvidence) {
        this.compactMatchIndexDeliveries(resolvedProfileId, null, true);
        this.assertMatchIndexServiceable(resolvedProfileId);
      }
      // Settings state and the work needed to index it commit together. A
      // response loss or process exit after COMMIT can therefore be recovered
      // without incrementing the scan generation on an idempotent replay.
      for (const [rootId, reason] of rootsNeedingScan) {
        // Coalesce with work that is already pending. In particular, a
        // configuration replacement that retires an active scan must wake the
        // same unacknowledged generation rather than manufacture another deep
        // pass over the whole root.
        this.ensureRootScanRequest(rootId, reason, timestamp, true);
      }
      this.database
        .prepare(
          `INSERT INTO configuration_writes(idempotency_key, request_hash, profile_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(idempotencyKey, requestHash, resolvedProfileId, timestamp);
      this.pruneConfigurationWrites(resolvedProfileId, idempotencyKey);
      return { resolvedProfileId, created: !existingProfile, applied: true };
    });

    return {
      configuration: {
        profile: this.getProfile(result.resolvedProfileId) as CatalogProfile,
        roots: this.listRoots(result.resolvedProfileId),
      },
      created: result.created,
      applied: result.applied,
    };
  }

  /** Configuration idempotency is a bounded replay window. Retain the current
   * accepted key and prune older rows deterministically by timestamp and key. */
  private pruneConfigurationWrites(profileId: string, currentIdempotencyKey: string): void {
    const countRow = this.database
      .prepare("SELECT count(*) AS count FROM configuration_writes WHERE profile_id = ?")
      .get(profileId) as Row;
    const count = Number(countRow.count);
    const excess = count - MAX_CONFIGURATION_WRITES_PER_PROFILE;
    if (excess <= 0) return;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(excess)) {
      throw new CatalogDatabaseError("invalid_state", "Configuration replay-history count is invalid.");
    }
    const result = this.database
      .prepare(
        `DELETE FROM configuration_writes
         WHERE idempotency_key IN (
           SELECT idempotency_key FROM configuration_writes
           WHERE profile_id = ? AND idempotency_key <> ?
           ORDER BY created_at ASC, idempotency_key ASC
           LIMIT ?
         )`,
      )
      .run(profileId, currentIdempotencyKey, excess);
    if (Number(result.changes) !== excess) {
      throw new CatalogDatabaseError("invalid_state", "Configuration replay-history retention failed.");
    }
  }

  updateRoot(profileId: string, id: string, input: Partial<RootInput>): CatalogRoot {
    return this.updateRootMutation(profileId, id, input, false).root;
  }

  updateRootWithEffects(
    profileId: string,
    id: string,
    input: Partial<RootInput>,
  ): { root: CatalogRoot; scanReason: "configuration" | "manual" | null } {
    return this.updateRootMutation(profileId, id, input, true);
  }

  private updateRootMutation(
    profileId: string,
    id: string,
    input: Partial<RootInput>,
    writeScanIntent: boolean,
  ): { root: CatalogRoot; scanReason: "configuration" | "manual" | null } {
    try {
      return this.transaction(() => {
        // Re-read membership and root state after acquiring the writer lock so
        // concurrent membership attachment, disablement, or path movement
        // cannot be overwritten from a stale partial-PATCH snapshot.
        const existing = this.getRoot(profileId, id);
        if (!existing) {
          throw new CatalogDatabaseError("not_found", "Source root not found.");
        }
        const pathChanged = input.path !== undefined && input.path !== existing.path;
        if (pathChanged) this.assertRootPathDoesNotOverlap(input.path as string, new Set([id]));
        const deepScanOptionsChanged =
          (input.recursive !== undefined && input.recursive !== existing.recursive) ||
          (input.sentinel !== undefined && input.sentinel !== existing.sentinel) ||
          (input.mountIdentity !== undefined && input.mountIdentity !== existing.mountIdentity);
        const watchChanged = input.watch !== undefined && input.watch !== existing.watch;
        const scanOptionsChanged = deepScanOptionsChanged || watchChanged;
        const membershipCount = this.database
          .prepare("SELECT count(*) AS count FROM profile_roots WHERE root_id = ?")
          .get(id) as Row;
        if (Number(membershipCount.count) > 1 && (pathChanged || scanOptionsChanged)) {
          throw new CatalogDatabaseError("conflict", "Shared source scan settings cannot be changed from one profile.");
        }
        const timestamp = now();
        if (pathChanged) {
          this.markRootRebuildPending(id, timestamp);
          this.database.prepare("DELETE FROM books_fts WHERE book_id IN (SELECT id FROM books WHERE root_id = ?)").run(id);
          this.database.prepare("DELETE FROM source_files WHERE root_id = ?").run(id);
        }
        this.database
          .prepare(
            `UPDATE library_roots SET path = ?, recursive = ?, watch = ?, sentinel_path = ?, mount_identity = ?,
               status = ?, last_error_code = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(
            input.path ?? existing.path,
            input.recursive === undefined ? (existing.recursive ? 1 : 0) : input.recursive ? 1 : 0,
            input.watch === undefined ? (existing.watch ? 1 : 0) : input.watch ? 1 : 0,
            input.sentinel === undefined ? existing.sentinel : input.sentinel,
            input.mountIdentity === undefined ? existing.mountIdentity : input.mountIdentity,
            pathChanged || scanOptionsChanged ? "pending" : existing.status,
            pathChanged || scanOptionsChanged ? null : existing.lastErrorCode,
            timestamp,
            id,
          );
        this.database
          .prepare(
            `UPDATE profile_roots SET label = ?, enabled = ?, updated_at = ?
             WHERE profile_id = ? AND root_id = ?`,
          )
          .run(
            input.label ?? existing.label,
            input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
            timestamp,
            profileId,
            id,
          );
        this.assertRootCollectionLimits();
        const enabled = input.enabled ?? existing.enabled;
        const profile = this.database.prepare("SELECT enabled FROM profiles WHERE id = ?").get(profileId) as
          | Row
          | undefined;
        if (!existing.enabled && enabled) {
          if (profile && bool(profile.enabled)) {
            this.compactMatchIndexDeliveries(profileId, null, true);
            this.assertMatchIndexServiceable(profileId);
          }
        }
        const scanReason = profile && bool(profile.enabled) && enabled
            ? pathChanged || deepScanOptionsChanged || (!existing.enabled && enabled)
              ? "manual" as const
              : watchChanged
                ? "configuration" as const
                : null
            : null;
        const durableScanReason = pathChanged || deepScanOptionsChanged
          ? "manual" as const
          : watchChanged
            ? "configuration" as const
            : scanReason;
        if (writeScanIntent && durableScanReason) {
          this.ensureRootScanRequest(id, durableScanReason, timestamp, true);
        }
        return { root: this.getRoot(profileId, id) as CatalogRoot, scanReason };
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: library_roots.path")) {
        throw new CatalogDatabaseError("conflict", "That source root is already configured for this profile.");
      }
      throw error;
    }
  }

  deleteRoot(profileId: string, id: string): boolean {
    return this.transaction(() => {
      const result = this.database
        .prepare("DELETE FROM profile_roots WHERE profile_id = ? AND root_id = ?")
        .run(profileId, id);
      const remaining = this.database.prepare("SELECT count(*) AS count FROM profile_roots WHERE root_id = ?").get(id) as Row;
      if (Number(remaining.count) === 0) {
        this.database.prepare("DELETE FROM books_fts WHERE book_id IN (SELECT id FROM books WHERE root_id = ?)").run(id);
        this.database.prepare("DELETE FROM library_roots WHERE id = ?").run(id);
      }
      return Number(result.changes) > 0;
    });
  }

  setRootStatus(
    id: string,
    status: RootStatus,
    errorCode: string | null,
    scanned = false,
    fence?: RootScanFence,
  ): void {
    if (fence && fence.rootId !== id) throw new StaleCatalogScanError(fence.rootId);
    const timestamp = now();
    const result = fence
      ? this.database
          .prepare(
            `UPDATE library_roots SET status = ?, last_error_code = ?,
               last_scan_at = CASE WHEN ? = 1 THEN ? ELSE last_scan_at END,
               updated_at = ? WHERE id = ?
               AND EXISTS (
                 SELECT 1 FROM scan_requests sr
                 WHERE sr.root_id = library_roots.id AND sr.generation = ? AND sr.pending = 1
               )`,
          )
          .run(status, errorCode, scanned ? 1 : 0, timestamp, timestamp, id, fence.generation)
      : this.database
          .prepare(
            `UPDATE library_roots SET status = ?, last_error_code = ?,
               last_scan_at = CASE WHEN ? = 1 THEN ? ELSE last_scan_at END,
               updated_at = ? WHERE id = ?`,
          )
          .run(status, errorCode, scanned ? 1 : 0, timestamp, timestamp, id);
    if (fence && Number(result.changes) === 0) throw new StaleCatalogScanError(id);
  }

  findSource(rootId: string, relativePath: string): SourceFileSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT sf.id, sf.size, sf.mtime_ms, sf.content_hash, sf.quick_fingerprint, sf.available, b.id AS book_id,
           sf.last_error_code, coalesce(sm.cover_cache_key, b.cover_cache_key) AS cover_cache_key,
           coalesce(sm.cover_expected, b.cover_expected) AS cover_expected
         FROM source_files sf LEFT JOIN books b ON b.source_file_id = sf.id
         LEFT JOIN book_source_metadata sm ON sm.book_id = b.id
         WHERE sf.root_id = ? AND sf.relative_path = ?`,
      )
      .get(rootId, relativePath) as Row | undefined;
    return row
      ? {
          id: String(row.id),
          bookId: stringOrNull(row.book_id),
          size: Number(row.size),
          mtimeMs: Number(row.mtime_ms),
          contentHash: String(row.content_hash),
          quickFingerprint: stringOrNull(row.quick_fingerprint),
          available: bool(row.available),
          lastErrorCode: stringOrNull(row.last_error_code),
          coverKey: stringOrNull(row.cover_cache_key),
          coverExpected: bool(row.cover_expected),
        }
      : null;
  }

  touchSource(
    sourceId: string,
    scanToken: string,
    quickFingerprint?: string,
    fence?: RootScanFence,
  ): void {
    this.transaction(() => {
      if (fence) this.assertRootScanFence(fence);
      const result = this.database
        .prepare(
          `UPDATE source_files SET available = 1, scan_token = ?, last_error_code = NULL,
             quick_fingerprint = coalesce(?, quick_fingerprint), updated_at = ?
           WHERE id = ?${fence ? " AND root_id = ?" : ""}`,
        )
        .run(scanToken, quickFingerprint ?? null, now(), sourceId, ...(fence ? [fence.rootId] : []));
      if (fence && Number(result.changes) === 0) throw new StaleCatalogScanError(fence.rootId);
      this.database.prepare("UPDATE books SET available = 1 WHERE source_file_id = ?").run(sourceId);
    });
  }

  upsertCatalogFile(input: CatalogFileInput, fence?: RootScanFence): { bookId: string; created: boolean } {
    return this.transaction(() => {
      if (fence) {
        if (fence.rootId !== input.rootId) throw new StaleCatalogScanError(fence.rootId);
        this.assertRootScanFence(fence);
      }
      let existing = this.database
        .prepare(
          `SELECT sf.id AS source_id, b.id AS book_id, b.added_at
           FROM source_files sf LEFT JOIN books b ON b.source_file_id = sf.id
           WHERE sf.root_id = ? AND sf.relative_path = ?`,
        )
        .get(input.rootId, input.relativePath) as Row | undefined;
      if (!existing) {
        // SMB inode identities are not stable. Preserve the source/book ID only
        // when one and only one unmatched file in this generation has the same
        // content hash and size; duplicates remain distinct and unambiguous.
        const renameCandidates: Row[] = [];
        const candidates = this.database
          .prepare(
            `SELECT sf.id AS source_id, sf.relative_path, b.id AS book_id, b.added_at
             FROM source_files sf LEFT JOIN books b ON b.source_file_id = sf.id
             WHERE sf.root_id = ? AND sf.content_hash = ? AND sf.size = ? AND sf.scan_token <> ?
             ORDER BY sf.id`,
          )
          .iterate(input.rootId, input.contentHash, input.size, input.scanToken) as IterableIterator<Row>;
        for (const candidate of candidates) {
          if (input.retainedRelativePaths?.has(String(candidate.relative_path))) continue;
          renameCandidates.push(candidate);
          if (renameCandidates.length === 2) break;
        }
        if (renameCandidates.length === 1) {
          existing = renameCandidates[0];
          this.database
            .prepare("UPDATE source_files SET relative_path = ? WHERE id = ?")
            .run(input.relativePath, String(existing.source_id));
        }
      }
      const timestamp = now();
      const sourceId = existing ? String(existing.source_id) : opaqueId("src");
      let retainedBookId: string | null = null;
      if (!existing?.book_id) {
        const byPath = this.database.prepare(
          `SELECT h.book_id FROM catalog_book_identities h
           WHERE h.root_id = ? AND h.relative_path = ?
             AND NOT EXISTS (SELECT 1 FROM books b WHERE b.id = h.book_id)`,
        ).get(input.rootId, input.relativePath) as Row | undefined;
        retainedBookId = byPath ? String(byPath.book_id) : null;
        if (!retainedBookId) {
          const byHash = this.database.prepare(
            `SELECT DISTINCT h.book_id FROM catalog_book_identities h
             WHERE h.root_id = ? AND h.content_hash = ? AND h.size = ?
               AND NOT EXISTS (SELECT 1 FROM books b WHERE b.id = h.book_id)
             ORDER BY h.book_id LIMIT 2`,
          ).all(input.rootId, input.contentHash, input.size) as Row[];
          if (byHash.length === 1) retainedBookId = String(byHash[0]!.book_id);
        }
      }
      const bookId = existing?.book_id ? String(existing.book_id) : retainedBookId ?? opaqueId("book");
      const created = !existing?.book_id;

      if (existing) {
        this.database
          .prepare(
            `UPDATE source_files SET format = ?, size = ?, mtime_ms = ?, content_hash = ?, quick_fingerprint = ?,
               available = 1, scan_token = ?, last_error_code = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.format,
            input.size,
            input.mtimeMs,
            input.contentHash,
            input.quickFingerprint ?? null,
            input.scanToken,
            timestamp,
            sourceId,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO source_files(
               id, root_id, relative_path, format, size, mtime_ms, content_hash, quick_fingerprint,
               available, scan_token, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            sourceId,
            input.rootId,
            input.relativePath,
            input.format,
            input.size,
            input.mtimeMs,
            input.contentHash,
            input.quickFingerprint ?? null,
            input.scanToken,
            timestamp,
            timestamp,
          );
      }

      const metadata = input.metadata;
      const sourceMetadata: EditableBookMetadata = {
        title: metadata.title,
        authors: metadata.authors,
        authorSort: metadata.authorSort,
        language: metadata.language,
        publisher: metadata.publisher,
        publishedAt: metadata.publishedAt,
        series: metadata.series,
        seriesIndex: metadata.seriesIndex ?? null,
        description: metadata.description ?? null,
        subjects: metadata.subjects,
        identifiers: metadata.identifiers,
      };
      const overrideRow = this.database
        .prepare(
          `SELECT o.*, a.media_type AS override_cover_media_type
           FROM book_metadata_overrides o
           LEFT JOIN metadata_cover_assets a ON a.asset_key = o.cover_asset_key
           WHERE o.book_id = ?`,
        )
        .get(bookId) as Row | undefined;
      const activeOverride = overrideRow && String(overrideRow.source_content_hash) === input.contentHash
        ? overrideRow
        : undefined;
      const overrides = overridesFromRow(activeOverride);
      const effectiveMetadata = mergeMetadata(sourceMetadata, overrides);
      const metadataEdited = Object.keys(overrides).length > 0;
      const overrideCoverKey = activeOverride ? stringOrNull(activeOverride.cover_asset_key) : null;
      const overrideCoverMediaType = activeOverride ? stringOrNull(activeOverride.override_cover_media_type) : null;
      if (overrideCoverKey && !overrideCoverMediaType) {
        throw new CatalogDatabaseError("invalid_state", "A selected durable cover asset is missing from the database.");
      }
      const coverEdited = overrideCoverKey !== null;
      const effectiveCoverKey = overrideCoverKey ?? metadata.coverKey;
      const effectiveCoverMediaType = overrideCoverMediaType ?? metadata.coverMediaType;
      const effectiveMetadataComplete = effectiveMetadata.title.trim().length > 0 && effectiveMetadata.authors.length > 0;
      const presentationVersion = presentationVersionFor(
        input.contentHash,
        effectiveMetadata,
        metadataEdited,
        overrideCoverKey,
      );
      const values: SqlValue[] = [
        input.rootId,
        sourceId,
        effectiveMetadata.title,
        JSON.stringify(effectiveMetadata.authors),
        effectiveMetadata.authorSort,
        effectiveMetadata.language,
        effectiveMetadata.publisher,
        effectiveMetadata.publishedAt,
        effectiveMetadata.series,
        effectiveMetadata.seriesIndex,
        effectiveMetadata.description,
        JSON.stringify(effectiveMetadata.subjects),
        JSON.stringify(effectiveMetadata.identifiers),
        effectiveMetadataComplete ? 1 : 0,
        effectiveCoverMediaType,
        effectiveCoverKey,
        (metadata.coverExpected ?? metadata.coverKey !== null) ? 1 : 0,
        coverEdited ? "override" : "cache",
        Number(overrideRow?.revision ?? 0),
        metadataEdited ? 1 : 0,
        coverEdited ? 1 : 0,
        presentationVersion,
        timestamp,
        bookId,
      ];
      if (existing?.book_id) {
        this.database
          .prepare(
            `UPDATE books SET root_id = ?, source_file_id = ?, title = ?, authors_json = ?,
               author_sort = ?, language = ?, publisher = ?, published_at = ?, series = ?,
               series_index = ?, description = ?, subjects_json = ?, identifiers_json = ?, metadata_complete = ?,
               cover_media_type = ?, cover_cache_key = ?, cover_expected = ?,
               cover_storage = ?, metadata_revision = ?, metadata_edited = ?, cover_edited = ?, presentation_version = ?, available = 1,
               updated_at = ? WHERE id = ?`,
          )
          .run(...values);
      } else {
        this.database
          .prepare(
            `INSERT INTO books(
               root_id, source_file_id, title, authors_json, author_sort, language, publisher,
               published_at, series, series_index, description, subjects_json, identifiers_json, metadata_complete, cover_media_type,
               cover_cache_key, cover_expected, cover_storage, metadata_revision, metadata_edited, cover_edited,
               presentation_version, updated_at, id, available, added_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?,
               1, ?
             )`,
          )
          .run(...values, timestamp);
      }

      this.database
        .prepare(
          `INSERT INTO book_source_metadata(
             book_id, title, authors_json, author_sort, language, publisher, published_at,
             series, series_index, description, subjects_json, identifiers_json,
             metadata_complete, cover_media_type, cover_cache_key, cover_expected, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(book_id) DO UPDATE SET
             title = excluded.title, authors_json = excluded.authors_json, author_sort = excluded.author_sort,
             language = excluded.language, publisher = excluded.publisher, published_at = excluded.published_at,
             series = excluded.series, series_index = excluded.series_index, description = excluded.description,
             subjects_json = excluded.subjects_json, identifiers_json = excluded.identifiers_json,
             metadata_complete = excluded.metadata_complete,
             cover_media_type = excluded.cover_media_type, cover_cache_key = excluded.cover_cache_key,
             cover_expected = excluded.cover_expected, updated_at = excluded.updated_at`,
        )
        .run(
          bookId,
          sourceMetadata.title,
          JSON.stringify(sourceMetadata.authors),
          sourceMetadata.authorSort,
          sourceMetadata.language,
          sourceMetadata.publisher,
          sourceMetadata.publishedAt,
          sourceMetadata.series,
          sourceMetadata.seriesIndex,
          sourceMetadata.description,
          JSON.stringify(sourceMetadata.subjects),
          JSON.stringify(sourceMetadata.identifiers),
          metadata.metadataComplete ? 1 : 0,
          metadata.coverMediaType,
          metadata.coverKey,
          (metadata.coverExpected ?? metadata.coverKey !== null) ? 1 : 0,
          timestamp,
        );

      this.database.prepare("DELETE FROM books_fts WHERE book_id = ?").run(bookId);
      this.database
        .prepare(
          `INSERT INTO books_fts(book_id, title, authors, subjects, publisher, series, identifiers, description, source_filename)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bookId,
          effectiveMetadata.title,
          effectiveMetadata.authors.join(" "),
          effectiveMetadata.subjects.join(" "),
          effectiveMetadata.publisher ?? "",
          effectiveMetadata.series ?? "",
          effectiveMetadata.identifiers.join(" "),
          effectiveMetadata.description ?? "",
          input.relativePath,
        );

      this.database.prepare(
        `DELETE FROM catalog_book_identities
         WHERE root_id = ? AND book_id = ? AND relative_path <> ?`,
      ).run(input.rootId, bookId, input.relativePath);
      this.database.prepare(
        `INSERT INTO catalog_book_identities(root_id, relative_path, content_hash, size, book_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_id, relative_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           size = excluded.size,
           book_id = excluded.book_id,
           updated_at = excluded.updated_at`,
      ).run(input.rootId, input.relativePath, input.contentHash, input.size, bookId, timestamp);

      return { bookId, created };
    });
  }

  recordSourceError(
    input: Omit<CatalogFileInput, "metadata" | "contentHash"> & { contentHash: string; errorCode: string },
    fence?: RootScanFence,
  ): void {
    this.transaction(() => {
      if (fence) {
        if (fence.rootId !== input.rootId) throw new StaleCatalogScanError(fence.rootId);
        this.assertRootScanFence(fence);
      }
      const existing = this.findSource(input.rootId, input.relativePath);
      const timestamp = now();
      if (existing) {
        this.database
          .prepare(
            `UPDATE source_files SET size = ?, mtime_ms = ?, content_hash = ?, quick_fingerprint = ?, format = ?, scan_token = ?,
               available = 0, last_error_code = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.size,
            input.mtimeMs,
            input.contentHash,
            input.quickFingerprint ?? null,
            input.format,
            input.scanToken,
            input.errorCode,
            timestamp,
            existing.id,
          );
        // Keep the stable book ID and last-known metadata as durable history,
        // but never expose a changed source as streamable until parsing succeeds
        // again. A later upsert re-enables this same book ID atomically.
        this.database
          .prepare("UPDATE books SET available = 0, updated_at = ? WHERE source_file_id = ?")
          .run(timestamp, existing.id);
        return;
      }
      this.database
        .prepare(
          `INSERT INTO source_files(
             id, root_id, relative_path, format, size, mtime_ms, content_hash, quick_fingerprint,
             available, scan_token, last_error_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          opaqueId("src"),
          input.rootId,
          input.relativePath,
          input.format,
          input.size,
          input.mtimeMs,
          input.contentHash,
          input.quickFingerprint ?? null,
          input.scanToken,
          input.errorCode,
          timestamp,
          timestamp,
        );
    });
  }

  completeRootScan(
    rootId: string,
    scanToken: string,
    discoveredFileCount: number,
    fence?: RootScanFence,
  ): { confirmed: boolean; unavailableBookIds: string[] } {
    return this.transaction(() => {
      if (fence) {
        if (fence.rootId !== rootId) throw new StaleCatalogScanError(fence.rootId);
        this.assertRootScanFence(fence);
      }
      const state = this.database
        .prepare(
          `SELECT r.empty_scan_streak,
             (SELECT count(*) FROM source_files sf WHERE sf.root_id = r.id AND sf.available = 1) AS available_sources
           FROM library_roots r WHERE r.id = ?`,
        )
        .get(rootId) as Row | undefined;
      if (!state) {
        throw new CatalogDatabaseError("not_found", "Source root not found.");
      }
      if (discoveredFileCount === 0 && Number(state.available_sources) > 0 && Number(state.empty_scan_streak) < 1) {
        this.database
          .prepare("UPDATE library_roots SET empty_scan_streak = 1, updated_at = ? WHERE id = ?")
          .run(now(), rootId);
        return { confirmed: false, unavailableBookIds: [] };
      }
      const rows = this.database
        .prepare(
          `SELECT b.id FROM books b JOIN source_files sf ON sf.id = b.source_file_id
           WHERE sf.root_id = ? AND sf.scan_token <> ? AND sf.available = 1`,
        )
        .all(rootId, scanToken) as Row[];
      // This is a confirmed, successfully enumerated root generation (not a
      // mount-loss path). Retire missing rebuildable rows so churn cannot grow
      // the catalog/FTS/cover reference set forever. Durable identities and
      // delivery evidence intentionally live in separate tables and survive.
      this.database
        .prepare(
          `DELETE FROM books_fts WHERE book_id IN (
             SELECT b.id FROM books b JOIN source_files sf ON sf.id = b.source_file_id
             WHERE sf.root_id = ? AND sf.scan_token <> ?
           )`,
        )
        .run(rootId, scanToken);
      this.database
        .prepare("DELETE FROM source_files WHERE root_id = ? AND scan_token <> ?")
        .run(rootId, scanToken);
      // A rebuild marker protects every durable identity between an explicit
      // cache clear and this first confirmed successful generation. Once the
      // generation is complete, normal bounded identity retention resumes.
      this.database.prepare("DELETE FROM catalog_rebuild_pending_roots WHERE root_id = ?").run(rootId);
      this.pruneUnprotectedCatalogIdentities(rootId);
      this.database
        .prepare(
          `UPDATE library_roots SET successful_scan_count = successful_scan_count + 1,
             empty_scan_streak = 0, updated_at = ? WHERE id = ?`,
        )
        .run(now(), rootId);
      return { confirmed: true, unavailableBookIds: rows.map((row) => String(row.id)) };
    });
  }

  noteRootUnavailable(
    rootId: string,
    fence?: RootScanFence,
  ): { confirmed: boolean; unavailableBookIds: string[] } {
    return this.transaction(() => {
      if (fence) {
        if (fence.rootId !== rootId) throw new StaleCatalogScanError(fence.rootId);
        this.assertRootScanFence(fence);
      }
      const state = this.database
        .prepare(
          `SELECT r.empty_scan_streak,
             (SELECT count(*) FROM source_files sf WHERE sf.root_id = r.id AND sf.available = 1) AS available_sources
           FROM library_roots r WHERE r.id = ?`,
        )
        .get(rootId) as Row | undefined;
      if (!state) {
        return { confirmed: false, unavailableBookIds: [] };
      }
      if (Number(state.available_sources) > 0 && Number(state.empty_scan_streak) < 1) {
        this.database
          .prepare("UPDATE library_roots SET empty_scan_streak = 1, updated_at = ? WHERE id = ?")
          .run(now(), rootId);
        return { confirmed: false, unavailableBookIds: [] };
      }
      const rows = this.database
        .prepare(
          `SELECT b.id FROM books b JOIN source_files sf ON sf.id = b.source_file_id
           WHERE sf.root_id = ? AND sf.available = 1`,
        )
        .all(rootId) as Row[];
      this.database.prepare("UPDATE source_files SET available = 0, updated_at = ? WHERE root_id = ?").run(now(), rootId);
      this.database
        .prepare("UPDATE books SET available = 0 WHERE source_file_id IN (SELECT id FROM source_files WHERE root_id = ?)")
        .run(rootId);
      this.database
        .prepare("UPDATE library_roots SET empty_scan_streak = empty_scan_streak + 1, updated_at = ? WHERE id = ?")
        .run(now(), rootId);
      return { confirmed: true, unavailableBookIds: rows.map((row) => String(row.id)) };
    });
  }

  clearRebuildableCatalog(): void {
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO catalog_rebuild_pending_roots(root_id, marked_at)
           SELECT id, ? FROM library_roots WHERE 1
           ON CONFLICT(root_id) DO UPDATE SET marked_at = excluded.marked_at`,
        )
        .run(now());
      this.database.exec("DELETE FROM books_fts; DELETE FROM books; DELETE FROM source_files;");
    });
  }

  private markRootRebuildPending(rootId: string, timestamp: string): void {
    this.database
      .prepare(
        `INSERT INTO catalog_rebuild_pending_roots(root_id, marked_at) VALUES (?, ?)
         ON CONFLICT(root_id) DO UPDATE SET marked_at = excluded.marked_at`,
      )
      .run(rootId, timestamp);
  }

  referencedCoverKeys(): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT cover_cache_key FROM book_source_metadata
         WHERE cover_cache_key IS NOT NULL AND trim(cover_cache_key) <> ''`,
      )
      .all() as Row[];
    // Mount-loss and parse-error cards retain their last-known rows and covers.
    // A confirmed healthy scan hard-retires missing rebuildable rows, allowing
    // the now-unreferenced derived cover to be collected.
    return new Set(rows.map((row) => String(row.cover_cache_key)));
  }

  requestRootScan(rootId: string, reason: string): number {
    if (!/^[a-z0-9._-]{1,64}$/u.test(reason)) {
      throw new CatalogDatabaseError("invalid_state", "Scan request reason is invalid.");
    }
    return this.transaction(() => this.writeRootScanRequest(rootId, reason, now()));
  }

  /** Write one generation while already holding the catalog writer lock. */
  private writeRootScanRequest(rootId: string, reason: string, requestedAt: string): number {
    if (!/^[a-z0-9._-]{1,64}$/u.test(reason)) {
      throw new CatalogDatabaseError("invalid_state", "Scan request reason is invalid.");
    }
    if (!this.database.prepare("SELECT 1 FROM library_roots WHERE id = ?").get(rootId)) {
      throw new CatalogDatabaseError("not_found", "Source root not found.");
    }
    this.database
      .prepare(
        `INSERT INTO scan_requests(root_id, generation, reason, requested_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(root_id) DO UPDATE SET
           generation = scan_requests.generation + 1,
           reason = excluded.reason,
           requested_at = excluded.requested_at,
           pending = 1`,
      )
      .run(rootId, reason, requestedAt);
    const row = this.database.prepare("SELECT generation FROM scan_requests WHERE root_id = ?").get(rootId) as Row;
    return Number(row.generation);
  }

  /** Ensure work exists while already holding the writer lock. Ordinary wakes
   * preserve an unacknowledged generation; an applied scan-affecting Settings
   * change advances it exactly once, making that row a cross-process fence for
   * every write still attempted by the prior scan. */
  private ensureRootScanRequest(
    rootId: string,
    reason: string,
    requestedAt: string,
    advanceExisting = false,
  ): number {
    if (!/^[a-z0-9._-]{1,64}$/u.test(reason)) {
      throw new CatalogDatabaseError("invalid_state", "Scan request reason is invalid.");
    }
    if (!this.database.prepare("SELECT 1 FROM library_roots WHERE id = ?").get(rootId)) {
      throw new CatalogDatabaseError("not_found", "Source root not found.");
    }
    const existing = this.database
      .prepare("SELECT generation, reason, pending FROM scan_requests WHERE root_id = ?")
      .get(rootId) as Row | undefined;
    if (!existing) {
      this.database
        .prepare("INSERT INTO scan_requests(root_id, generation, reason, requested_at) VALUES (?, 1, ?, ?)")
        .run(rootId, reason, requestedAt);
    } else if (advanceExisting || !bool(existing.pending)) {
      const existingReason = String(existing.reason);
      const existingPending = bool(existing.pending);
      const retainedReason = existingPending
        && isDeepScanRequestReason(existingReason)
        && !isDeepScanRequestReason(reason)
          ? existingReason
          : existingPending
              && isAuthoritativeScanRequestReason(existingReason)
              && !isAuthoritativeScanRequestReason(reason)
              && !isDeepScanRequestReason(reason)
            ? existingReason
            : reason;
      this.database
        .prepare(
          `UPDATE scan_requests SET generation = generation + 1, reason = ?, requested_at = ?, pending = 1
           WHERE root_id = ?`,
        )
        .run(retainedReason, requestedAt, rootId);
    } else if (isDeepScanRequestReason(reason) && !isDeepScanRequestReason(String(existing.reason))) {
      // A configuration change can require stronger verification than an
      // already-pending lightweight reconciliation. Upgrade the reason without
      // advancing the generation so an active retired scan is safely rerun once.
      this.database
        .prepare("UPDATE scan_requests SET reason = ?, requested_at = ? WHERE root_id = ?")
        .run(reason, requestedAt, rootId);
    }
    const row = this.database.prepare("SELECT generation FROM scan_requests WHERE root_id = ?").get(rootId) as Row;
    return Number(row.generation);
  }

  pendingRootScanIds(): string[] {
    return (this.database
      .prepare("SELECT root_id FROM scan_requests WHERE pending = 1 ORDER BY requested_at, root_id")
      .all() as Row[])
      .map((row) => String(row.root_id));
  }

  rootScanRequestGeneration(rootId: string): number | null {
    return this.rootScanRequest(rootId)?.generation ?? null;
  }

  rootScanRequest(rootId: string): RootScanRequest | null {
    const row = this.database
      .prepare("SELECT generation, reason FROM scan_requests WHERE root_id = ? AND pending = 1")
      .get(rootId) as
      | Row
      | undefined;
    return row ? { generation: Number(row.generation), reason: String(row.reason) } : null;
  }

  /** Atomically acquire one pending generation. Advancing on every claim gives
   * concurrent service processes distinct fences; the newest claimant owns the
   * only generation allowed to mutate or acknowledge the root. */
  claimRootScan(rootId: string): RootScanRequest | null {
    return this.transaction(() => {
      const request = this.database
        .prepare("SELECT generation, reason FROM scan_requests WHERE root_id = ? AND pending = 1")
        .get(rootId) as Row | undefined;
      if (!request) return null;
      this.database
        .prepare(
          `UPDATE scan_requests SET generation = generation + 1, requested_at = ?
           WHERE root_id = ? AND pending = 1 AND generation = ?`,
        )
        .run(now(), rootId, Number(request.generation));
      return {
        generation: Number(request.generation) + 1,
        reason: String(request.reason),
      };
    });
  }

  acknowledgeRootScan(
    rootId: string,
    generation: number,
    completedDeepScan = false,
    fence?: RootScanFence,
  ): void {
    this.transaction(() => {
      if (fence) {
        if (fence.rootId !== rootId || fence.generation !== generation) {
          throw new StaleCatalogScanError(fence.rootId);
        }
        this.assertRootScanFence(fence);
      }
      if (completedDeepScan) {
        const timestamp = now();
        this.database
          .prepare("UPDATE library_roots SET last_deep_scan_at = ?, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, rootId);
      }
      this.database
        .prepare("UPDATE scan_requests SET pending = 0 WHERE root_id = ? AND generation <= ? AND pending = 1")
        .run(rootId, generation);
    });
  }

  getBook(profileId: string, bookId: string): CatalogBook | null {
    const row = this.database.prepare(`${BOOK_SELECT} WHERE pr.profile_id = ? AND b.id = ?`).get(profileId, bookId) as
      | Row
      | undefined;
    return row ? mapBook(row) : null;
  }

  listCatalogIssues(profileId: string, query: CatalogHealthQuery = {}): CatalogHealthPage {
    const issues = this.derivedCatalogIssues(profileId);
    // A disposition can outlive its derived issue after metadata is fixed, a
    // source returns, or a duplicate group changes. Retain a useful recent
    // history, but deterministically retire older inactive rows so a long-lived
    // installation never becomes unable to act on new issues.
    this.transaction(() => this.pruneRetiredCatalogIssueDispositions(profileId, issues));
    const dispositionRows = this.database
      .prepare(
        `SELECT issue_signature, ignored, preferred_book_id, revision, retry_count, last_retry_at
         FROM catalog_issue_dispositions WHERE profile_id = ?
         ORDER BY updated_at DESC, issue_signature LIMIT ?`,
      )
      .all(profileId, MAX_DERIVED_CATALOG_ISSUES + 1) as Row[];
    if (dispositionRows.length > MAX_DERIVED_CATALOG_ISSUES) {
      throw new CatalogDatabaseError("too_large", "Catalog issue disposition history exceeds its bounded limit.");
    }
    const dispositions = new Map(dispositionRows.map((row) => [String(row.issue_signature), row]));
    const decorated = issues.map((issue) => this.decorateCatalogIssue(issue, dispositions.get(issue.signature)));
    const byType = {
      "missing-cover": 0,
      "incomplete-metadata": 0,
      "metadata-parser-failure": 0,
      "low-confidence-provider-data": 0,
      "unavailable-source": 0,
      "suspected-duplicate": 0,
    } as Record<CatalogHealthIssue["type"], number>;
    const bySeverity = { info: 0, warning: 0, error: 0 } as Record<CatalogHealthIssue["severity"], number>;
    let ignored = 0;
    for (const issue of decorated) {
      byType[issue.type] += 1;
      bySeverity[issue.severity] += 1;
      if (issue.disposition.ignored) ignored += 1;
    }
    const filtered = decorated.filter((issue) => (
      (query.type === undefined || issue.type === query.type)
      && (query.severity === undefined || issue.severity === query.severity)
      && (query.ignored === undefined || issue.disposition.ignored === query.ignored)
    ));
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
      counts: {
        total: decorated.length,
        active: decorated.length - ignored,
        ignored,
        byType,
        bySeverity,
      },
    };
  }

  getCatalogIssue(profileId: string, signature: string): CatalogHealthIssue | null {
    const issue = this.derivedCatalogIssues(profileId).find((candidate) => candidate.signature === signature);
    if (!issue) return null;
    const row = this.database
      .prepare(
        `SELECT ignored, preferred_book_id, revision, retry_count, last_retry_at
         FROM catalog_issue_dispositions WHERE profile_id = ? AND issue_signature = ?`,
      )
      .get(profileId, signature) as Row | undefined;
    return this.decorateCatalogIssue(issue, row);
  }

  setCatalogIssueIgnored(
    profileId: string,
    signature: string,
    expectedRevision: number,
    ignored: boolean,
  ): CatalogIssueMutationResult {
    const current = this.getCatalogIssue(profileId, signature);
    if (!current) throw new CatalogDatabaseError("not_found", "Catalog issue not found.");
    if (current.disposition.revision !== expectedRevision) {
      throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before saving.");
    }
    if (current.disposition.ignored === ignored) return { issue: current, applied: false };
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT revision FROM catalog_issue_dispositions WHERE profile_id = ? AND issue_signature = ?")
        .get(profileId, signature) as Row | undefined;
      const revision = Number(existing?.revision ?? 0);
      if (revision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before saving.");
      }
      if (!existing) this.assertCatalogIssueDispositionCapacity(profileId);
      const timestamp = now();
      this.database
        .prepare(
          `INSERT INTO catalog_issue_dispositions(
             profile_id, issue_signature, issue_type, ignored, revision, retry_count,
             last_retry_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)
           ON CONFLICT(profile_id, issue_signature) DO UPDATE SET
             issue_type = excluded.issue_type, ignored = excluded.ignored,
             revision = catalog_issue_dispositions.revision + 1, updated_at = excluded.updated_at`,
        )
        .run(profileId, signature, current.type, ignored ? 1 : 0, timestamp, timestamp);
    });
    const updated = this.getCatalogIssue(profileId, signature);
    if (!updated) throw new CatalogDatabaseError("invalid_state", "Catalog issue changed while saving its disposition.");
    return { issue: updated, applied: true };
  }

  recordCatalogIssueRetry(
    profileId: string,
    signature: string,
    expectedRevision: number,
  ): CatalogIssueMutationResult {
    const current = this.getCatalogIssue(profileId, signature);
    if (!current) throw new CatalogDatabaseError("not_found", "Catalog issue not found.");
    if (current.disposition.revision !== expectedRevision) {
      throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before retrying.");
    }
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT revision FROM catalog_issue_dispositions WHERE profile_id = ? AND issue_signature = ?")
        .get(profileId, signature) as Row | undefined;
      const revision = Number(existing?.revision ?? 0);
      if (revision !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before retrying.");
      }
      if (!existing) this.assertCatalogIssueDispositionCapacity(profileId);
      const timestamp = now();
      this.database
        .prepare(
          `INSERT INTO catalog_issue_dispositions(
             profile_id, issue_signature, issue_type, ignored, revision, retry_count,
             last_retry_at, created_at, updated_at
           ) VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?)
           ON CONFLICT(profile_id, issue_signature) DO UPDATE SET
             issue_type = excluded.issue_type,
             revision = catalog_issue_dispositions.revision + 1,
             retry_count = catalog_issue_dispositions.retry_count + 1,
             last_retry_at = excluded.last_retry_at, updated_at = excluded.updated_at`,
        )
        .run(profileId, signature, current.type, timestamp, timestamp, timestamp);
    });
    const updated = this.getCatalogIssue(profileId, signature);
    if (!updated) throw new CatalogDatabaseError("invalid_state", "Catalog issue changed while recording its retry.");
    return { issue: updated, applied: true };
  }

  setCatalogDuplicatePreference(
    profileId: string,
    signature: string,
    input: CatalogDuplicatePreferenceInput,
  ): CatalogIssueMutationResult {
    const current = this.getCatalogIssue(profileId, signature);
    if (!current) throw new CatalogDatabaseError("not_found", "Catalog issue not found.");
    if (current.type !== "suspected-duplicate") {
      throw new CatalogDatabaseError("conflict", "Only duplicate groups accept a preferred presentation.");
    }
    if (current.disposition.revision !== input.expectedRevision) {
      throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before saving.");
    }
    if (input.preferredBookId !== null && !current.bookIds.includes(input.preferredBookId)) {
      throw new CatalogDatabaseError("conflict", "The preferred book is not part of this duplicate group.");
    }
    if (current.disposition.preferredBookId === input.preferredBookId) return { issue: current, applied: false };
    if (input.preferredBookId === null && current.disposition.revision === 0) return { issue: current, applied: false };
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT revision FROM catalog_issue_dispositions WHERE profile_id = ? AND issue_signature = ?")
        .get(profileId, signature) as Row | undefined;
      if (Number(existing?.revision ?? 0) !== input.expectedRevision) {
        throw new CatalogDatabaseError("conflict", "The catalog issue changed; reload before saving.");
      }
      if (!existing) this.assertCatalogIssueDispositionCapacity(profileId);
      const timestamp = now();
      this.database
        .prepare(
          `INSERT INTO catalog_issue_dispositions(
             profile_id, issue_signature, issue_type, ignored, preferred_book_id, revision,
             retry_count, last_retry_at, created_at, updated_at
           ) VALUES (?, ?, ?, 0, ?, 1, 0, NULL, ?, ?)
           ON CONFLICT(profile_id, issue_signature) DO UPDATE SET
             issue_type = excluded.issue_type, preferred_book_id = excluded.preferred_book_id,
             revision = catalog_issue_dispositions.revision + 1, updated_at = excluded.updated_at`,
        )
        .run(profileId, signature, current.type, input.preferredBookId, timestamp, timestamp);
    });
    const updated = this.getCatalogIssue(profileId, signature);
    if (!updated) throw new CatalogDatabaseError("invalid_state", "Duplicate evidence changed while saving its preference.");
    return { issue: updated, applied: true };
  }

  private derivedCatalogIssues(profileId: string): readonly DerivedCatalogIssue[] {
    if (!this.getProfile(profileId)) throw new CatalogDatabaseError("not_found", "Profile not found.");
    const rows = this.database
      .prepare(
        `SELECT b.id AS book_id, b.root_id, b.title, b.authors_json, b.identifiers_json,
           b.cover_media_type, b.cover_cache_key, b.metadata_complete, b.available AS book_available,
           b.added_at, b.updated_at, sf.id AS source_id, sf.relative_path, sf.content_hash,
           sf.available AS source_available, sf.last_error_code
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? ORDER BY b.id LIMIT 100001`,
      )
      .all(profileId) as Row[];
    if (rows.length > 100_000) {
      throw new CatalogDatabaseError("too_large", "Catalog health derivation exceeds its 100,000-book limit.");
    }
    const lookupRows = this.database
      .prepare(
        `SELECT e.book_id, e.candidates_json, e.accepted_at, e.updated_at, e.job_id
         FROM metadata_lookup_entries e
         JOIN metadata_lookup_jobs j ON j.id = e.job_id
         WHERE j.profile_id = ? AND e.status = 'ready'
         ORDER BY e.book_id, e.updated_at DESC, j.rowid DESC, e.job_id DESC
         LIMIT ?`,
      )
      .all(profileId, (MAX_METADATA_LOOKUP_JOBS_PER_PROFILE * MAX_METADATA_LOOKUP_JOB_BOOKS) + 1) as Row[];
    if (lookupRows.length > MAX_METADATA_LOOKUP_JOBS_PER_PROFILE * MAX_METADATA_LOOKUP_JOB_BOOKS) {
      throw new CatalogDatabaseError("too_large", "Metadata lookup evidence exceeds its durable bounds.");
    }
    const lowConfidenceByBook = new Map<string, boolean>();
    for (const row of lookupRows) {
      const bookId = String(row.book_id);
      if (lowConfidenceByBook.has(bookId)) continue;
      const candidates = parseMetadataCandidates(row.candidates_json);
      lowConfidenceByBook.set(
        bookId,
        row.accepted_at === null && candidates.length > 0 && candidates.every(({ confidence }) => confidence === "low"),
      );
    }
    const bookFacts: CatalogIssueBookFacts[] = rows.map((row) => ({
      profileId,
      bookId: String(row.book_id),
      sourceId: String(row.source_id),
      sourceLabel: String(row.relative_path),
      rootId: String(row.root_id),
      title: String(row.title),
      authors: parseStringArray(row.authors_json),
      identifiers: parseStringArray(row.identifiers_json),
      contentHash: stringOrNull(row.content_hash) ?? undefined,
      coverAvailable: row.cover_media_type !== null && row.cover_cache_key !== null,
      metadataComplete: bool(row.metadata_complete),
      sourceAvailable: bool(row.book_available) && bool(row.source_available),
      parserErrorCode: stringOrNull(row.last_error_code) ?? undefined,
      lowConfidenceProviderData: lowConfidenceByBook.get(String(row.book_id)) ?? false,
      firstObservedAt: stringOrNull(row.added_at) ?? undefined,
      lastObservedAt: String(row.updated_at),
    }));
    const sourceRows = this.database
      .prepare(
        `SELECT sf.id AS source_id, sf.root_id, sf.relative_path, sf.available, sf.last_error_code, sf.created_at, sf.updated_at
         FROM source_files sf
         JOIN profile_roots pr ON pr.root_id = sf.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         LEFT JOIN books b ON b.source_file_id = sf.id
         WHERE pr.profile_id = ? AND b.id IS NULL
           AND (sf.available = 0 OR sf.last_error_code IS NOT NULL)
         ORDER BY sf.id LIMIT 100001`,
      )
      .all(profileId) as Row[];
    if (sourceRows.length > 100_000) {
      throw new CatalogDatabaseError("too_large", "Catalog health derivation exceeds its 100,000-source limit.");
    }
    const sourceFacts: CatalogIssueSourceFacts[] = sourceRows.map((row) => ({
      profileId,
      sourceId: String(row.source_id),
      rootId: String(row.root_id),
      displayLabel: String(row.relative_path),
      sourceAvailable: bool(row.available),
      errorCode: stringOrNull(row.last_error_code) ?? undefined,
      firstObservedAt: stringOrNull(row.created_at) ?? undefined,
      lastObservedAt: String(row.updated_at),
    }));
    const rootRows = this.database
      .prepare(
        `SELECT r.id AS root_id, pr.label, r.status, r.last_error_code, r.created_at, r.updated_at
         FROM library_roots r
         JOIN profile_roots pr ON pr.root_id = r.id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ?
           AND r.status IN ('unavailable', 'permission_denied', 'error')
           AND NOT EXISTS (SELECT 1 FROM source_files sf WHERE sf.root_id = r.id)
         ORDER BY r.id LIMIT 100001`,
      )
      .all(profileId) as Row[];
    if (rootRows.length > 100_000) {
      throw new CatalogDatabaseError("too_large", "Catalog health derivation exceeds its 100,000-root limit.");
    }
    for (const row of rootRows) {
      sourceFacts.push({
        profileId,
        rootId: String(row.root_id),
        displayLabel: String(row.label),
        sourceAvailable: false,
        errorCode: stringOrNull(row.last_error_code) ?? undefined,
        firstObservedAt: stringOrNull(row.created_at) ?? undefined,
        lastObservedAt: String(row.updated_at),
      });
    }
    try {
      return deriveCatalogIssues(profileId, bookFacts, sourceFacts);
    } catch (error) {
      if (error instanceof RangeError) throw new CatalogDatabaseError("too_large", error.message);
      throw error;
    }
  }

  private decorateCatalogIssue(issue: DerivedCatalogIssue, row?: Row): CatalogHealthIssue {
    const disposition: CatalogIssueDisposition = {
      ignored: bool(row?.ignored),
      preferredBookId: stringOrNull(row?.preferred_book_id),
      revision: Number(row?.revision ?? 0),
      retryCount: Number(row?.retry_count ?? 0),
      lastRetryAt: stringOrNull(row?.last_retry_at),
    };
    return { ...issue, disposition };
  }

  private assertCatalogIssueDispositionCapacity(profileId: string): void {
    this.pruneRetiredCatalogIssueDispositions(profileId, this.derivedCatalogIssues(profileId), 1);
    const row = this.database
      .prepare("SELECT count(*) AS count FROM catalog_issue_dispositions WHERE profile_id = ?")
      .get(profileId) as Row;
    if (Number(row.count) >= MAX_DERIVED_CATALOG_ISSUES) {
      throw new CatalogDatabaseError("too_large", "Catalog issue disposition history reached its bounded limit.");
    }
  }

  /**
   * Must run inside the caller's writer transaction. Current derived issues
   * are never removed; up to 5,000 most-recent resolved dispositions remain as
   * bounded history, reduced only when current rows need the global ceiling.
   */
  private pruneRetiredCatalogIssueDispositions(
    profileId: string,
    currentIssues: readonly DerivedCatalogIssue[],
    reserveRows = 0,
  ): number {
    const rows = this.database
      .prepare(
        `SELECT issue_signature FROM catalog_issue_dispositions
         WHERE profile_id = ? ORDER BY updated_at DESC, issue_signature DESC
         LIMIT ?`,
      )
      .all(profileId, MAX_DERIVED_CATALOG_ISSUES + 1) as Row[];
    const current = new Set(currentIssues.map(({ signature }) => signature));
    const currentRowCount = rows.reduce(
      (count, row) => count + (current.has(String(row.issue_signature)) ? 1 : 0),
      0,
    );
    const retired = rows.filter((row) => !current.has(String(row.issue_signature)));
    const retainedRetired = Math.max(
      0,
      Math.min(5_000, MAX_DERIVED_CATALOG_ISSUES - reserveRows - currentRowCount),
    );
    const remove = retired.slice(retainedRetired);
    if (remove.length === 0) return 0;
    const statement = this.database.prepare(
      "DELETE FROM catalog_issue_dispositions WHERE profile_id = ? AND issue_signature = ?",
    );
    let removed = 0;
    for (const row of remove) {
      removed += Number(statement.run(profileId, String(row.issue_signature)).changes);
    }
    return removed;
  }

  createMetadataLookupJob(
    profileId: string,
    input: MetadataLookupJobInput,
    idempotencyKey: string,
  ): { job: MetadataLookupJob; applied: boolean } {
    const bookIds = [...new Set(input.bookIds)];
    if (
      input.bookIds.length === 0
      || input.bookIds.length > MAX_METADATA_LOOKUP_JOB_BOOKS
      || bookIds.length !== input.bookIds.length
    ) {
      throw new RangeError(`A metadata lookup job requires 1-${MAX_METADATA_LOOKUP_JOB_BOOKS} unique books.`);
    }
    const requestHash = mutationRequestHash({ provider: input.provider, bookIds });
    return this.transaction(() => {
      if (!this.getProfile(profileId)) throw new CatalogDatabaseError("not_found", "Profile not found.");
      const replay = this.database
        .prepare("SELECT request_hash, job_id FROM metadata_lookup_job_replays WHERE profile_id = ? AND idempotency_key = ?")
        .get(profileId, idempotencyKey) as Row | undefined;
      if (replay) {
        if (String(replay.request_hash) !== requestHash) {
          throw new CatalogDatabaseError("conflict", "Idempotency key was already used for different metadata lookup work.");
        }
        const job = this.getMetadataLookupJob(profileId, String(replay.job_id));
        if (!job) throw new CatalogDatabaseError("invalid_state", "Metadata lookup replay target is unavailable.");
        return { job, applied: false };
      }
      for (const bookId of bookIds) {
        if (!this.getBook(profileId, bookId)) throw new CatalogDatabaseError("not_found", "A selected book was not found.");
      }
      const existing = this.database
        .prepare("SELECT count(*) AS count FROM metadata_lookup_jobs WHERE profile_id = ?")
        .get(profileId) as Row;
      if (Number(existing.count) >= MAX_METADATA_LOOKUP_JOBS_PER_PROFILE) {
        const retired = this.database
          .prepare(
            `SELECT id FROM metadata_lookup_jobs
             WHERE profile_id = ? AND status IN ('completed', 'cancelled')
             ORDER BY updated_at, id LIMIT 1`,
          )
          .get(profileId) as Row | undefined;
        if (!retired) throw new CatalogDatabaseError("too_large", "Too many active metadata lookup jobs exist.");
        this.database.prepare("DELETE FROM metadata_lookup_jobs WHERE id = ?").run(String(retired.id));
      }
      const timestamp = now();
      const jobId = opaqueId("lookup");
      this.database
        .prepare(
          `INSERT INTO metadata_lookup_jobs(id, profile_id, provider, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', 1, ?, ?)`,
        )
        .run(jobId, profileId, input.provider, timestamp, timestamp);
      const insert = this.database.prepare(
        `INSERT INTO metadata_lookup_entries(
           job_id, book_id, rank, status, attempts, candidates_json, error_code, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, '[]', NULL, ?)`,
      );
      bookIds.forEach((bookId, rank) => insert.run(jobId, bookId, rank, timestamp));
      this.database
        .prepare(
          `INSERT INTO metadata_lookup_job_replays(profile_id, idempotency_key, request_hash, job_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(profileId, idempotencyKey, requestHash, jobId, timestamp);
      this.database
        .prepare(
          `DELETE FROM metadata_lookup_job_replays WHERE profile_id = ? AND idempotency_key IN (
             SELECT idempotency_key FROM metadata_lookup_job_replays WHERE profile_id = ?
             ORDER BY created_at DESC, idempotency_key DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(profileId, profileId, MAX_DURABLE_MUTATION_REPLAYS_PER_PROFILE);
      return { job: this.getMetadataLookupJob(profileId, jobId) as MetadataLookupJob, applied: true };
    });
  }

  listMetadataLookupJobs(profileId: string, limit = 20, offset = 0): MetadataLookupJobPage {
    if (!this.getProfile(profileId)) throw new CatalogDatabaseError("not_found", "Profile not found.");
    const totalRow = this.database
      .prepare("SELECT count(*) AS count FROM metadata_lookup_jobs WHERE profile_id = ?")
      .get(profileId) as Row;
    const rows = this.database
      .prepare(
        `SELECT id FROM metadata_lookup_jobs WHERE profile_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(profileId, limit, offset) as Row[];
    return {
      items: rows.map((row) => this.getMetadataLookupJob(profileId, String(row.id), false) as MetadataLookupJob),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  getMetadataLookupJob(profileId: string, jobId: string, includeEntries = true): MetadataLookupJob | null {
    const row = this.database
      .prepare(
        `SELECT j.*,
           count(e.book_id) AS total_count,
           coalesce(sum(CASE WHEN e.status IN ('pending', 'searching') THEN 1 ELSE 0 END), 0) AS pending_count,
           coalesce(sum(CASE WHEN e.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count,
           coalesce(sum(CASE WHEN e.status = 'no-results' THEN 1 ELSE 0 END), 0) AS no_results_count,
           coalesce(sum(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
           coalesce(sum(CASE WHEN e.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
         FROM metadata_lookup_jobs j
         LEFT JOIN metadata_lookup_entries e ON e.job_id = j.id
         WHERE j.profile_id = ? AND j.id = ?
         GROUP BY j.id`,
      )
      .get(profileId, jobId) as Row | undefined;
    if (!row) return null;
    const entryRows = includeEntries
      ? this.database
          .prepare("SELECT * FROM metadata_lookup_entries WHERE job_id = ? ORDER BY rank, book_id")
          .all(jobId) as Row[]
      : [];
    const entries = entryRows.map((entry): MetadataLookupJobEntry => ({
      jobId,
      bookId: String(entry.book_id),
      rank: Number(entry.rank),
      status: String(entry.status) as MetadataLookupJobEntry["status"],
      attempts: Number(entry.attempts),
      candidates: parseMetadataCandidates(entry.candidates_json),
      errorCode: stringOrNull(entry.error_code) as MetadataLookupErrorCode | null,
      acceptedAt: stringOrNull(entry.accepted_at),
      updatedAt: String(entry.updated_at),
    }));
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      provider: String(row.provider) as CoverProvider,
      status: String(row.status) as MetadataLookupJobStatus,
      revision: Number(row.revision),
      entriesIncluded: includeEntries,
      entries,
      total: Number(row.total_count),
      pending: Number(row.pending_count),
      ready: Number(row.ready_count),
      noResults: Number(row.no_results_count),
      failed: Number(row.failed_count),
      cancelled: Number(row.cancelled_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  controlMetadataLookupJob(
    profileId: string,
    jobId: string,
    action: "resume" | "pause" | "cancel" | "retry",
    expectedRevision: number,
  ): { job: MetadataLookupJob; applied: boolean } {
    const applied = this.transaction(() => {
      const row = this.database
        .prepare("SELECT status, revision FROM metadata_lookup_jobs WHERE profile_id = ? AND id = ?")
        .get(profileId, jobId) as Row | undefined;
      if (!row) throw new CatalogDatabaseError("not_found", "Metadata lookup job not found.");
      if (Number(row.revision) !== expectedRevision) {
        throw new CatalogDatabaseError("conflict", "Metadata lookup job changed; reload before continuing.");
      }
      const status = String(row.status) as MetadataLookupJobStatus;
      const target = action === "resume" || action === "retry" ? "running" : action === "pause" ? "paused" : "cancelled";
      if (status === target) return false;
      if (
        status === "cancelled"
        || (action === "retry" && status !== "completed")
        || (action !== "retry" && status === "completed")
        || (action === "pause" && status !== "running")
      ) {
        throw new CatalogDatabaseError("conflict", "Metadata lookup job cannot make that transition.");
      }
      const timestamp = now();
      if (action === "retry") {
        const retried = this.database
          .prepare(
            `UPDATE metadata_lookup_entries SET status = 'pending', candidates_json = '[]',
             error_code = NULL, accepted_at = NULL, updated_at = ? WHERE job_id = ? AND status = 'failed'`,
          )
          .run(timestamp, jobId);
        if (retried.changes === 0) {
          throw new CatalogDatabaseError("conflict", "Metadata lookup job has no failed books to retry.");
        }
      } else if (action === "pause") {
        this.database
          .prepare("UPDATE metadata_lookup_entries SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'searching'")
          .run(timestamp, jobId);
      } else if (action === "cancel") {
        this.database
          .prepare(
            `UPDATE metadata_lookup_entries SET status = 'cancelled', candidates_json = '[]',
             error_code = NULL, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'searching')`,
          )
          .run(timestamp, jobId);
      }
      this.database
        .prepare("UPDATE metadata_lookup_jobs SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(target, timestamp, jobId);
      return true;
    });
    return { job: this.getMetadataLookupJob(profileId, jobId) as MetadataLookupJob, applied };
  }

  claimMetadataLookupEntries(profileId: string, jobId: string, maximum = 2): MetadataLookupClaim[] {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2) throw new RangeError("Lookup claim size is invalid.");
    return this.transaction(() => {
      const job = this.database
        .prepare("SELECT provider, status FROM metadata_lookup_jobs WHERE profile_id = ? AND id = ?")
        .get(profileId, jobId) as Row | undefined;
      if (!job) throw new CatalogDatabaseError("not_found", "Metadata lookup job not found.");
      if (String(job.status) !== "running") throw new CatalogDatabaseError("invalid_state", "Metadata lookup job is not running.");
      const rows = this.database
        .prepare("SELECT book_id FROM metadata_lookup_entries WHERE job_id = ? AND status = 'pending' ORDER BY rank LIMIT ?")
        .all(jobId, maximum) as Row[];
      const timestamp = now();
      const claims: MetadataLookupClaim[] = [];
      let changed = false;
      for (const row of rows) {
        const bookId = String(row.book_id);
        const book = this.getBook(profileId, bookId);
        if (!book) {
          this.database
            .prepare(
              `UPDATE metadata_lookup_entries SET status = 'failed', attempts = attempts + 1,
               candidates_json = '[]', error_code = 'book-unavailable', updated_at = ?
               WHERE job_id = ? AND book_id = ? AND status = 'pending'`,
            )
            .run(timestamp, jobId, bookId);
          changed = true;
          continue;
        }
        this.database
          .prepare(
            `UPDATE metadata_lookup_entries SET status = 'searching', attempts = attempts + 1,
             error_code = NULL, updated_at = ? WHERE job_id = ? AND book_id = ? AND status = 'pending'`,
          )
          .run(timestamp, jobId, bookId);
        const identifier = book.identifiers.find((value) => /isbn/iu.test(value)) ?? book.identifiers[0];
        claims.push({
          jobId,
          profileId,
          bookId,
          provider: String(job.provider) as CoverProvider,
          terms: {
            title: book.title,
            ...(book.authors[0] ? { author: book.authors[0] } : {}),
            ...(identifier ? { identifier: identifier.replace(/^isbn(?:_1[03])?\s*[:=-]?\s*/iu, "") } : {}),
          },
        });
        changed = true;
      }
      if (changed) {
        this.database
          .prepare("UPDATE metadata_lookup_jobs SET revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(timestamp, jobId);
      }
      this.finalizeMetadataLookupJob(jobId, timestamp);
      return claims;
    });
  }

  completeMetadataLookupEntry(
    profileId: string,
    jobId: string,
    bookId: string,
    candidates: readonly CatalogMetadataCandidate[],
    errorCode: MetadataLookupErrorCode | null,
  ): MetadataLookupJob {
    if (candidates.length > MAX_METADATA_CANDIDATES) throw new RangeError("Too many metadata candidates were returned.");
    this.transaction(() => {
      const job = this.database
        .prepare("SELECT provider FROM metadata_lookup_jobs WHERE profile_id = ? AND id = ?")
        .get(profileId, jobId) as Row | undefined;
      if (!job) throw new CatalogDatabaseError("not_found", "Metadata lookup job not found.");
      const entry = this.database
        .prepare("SELECT status FROM metadata_lookup_entries WHERE job_id = ? AND book_id = ?")
        .get(jobId, bookId) as Row | undefined;
      if (!entry) throw new CatalogDatabaseError("not_found", "Metadata lookup entry not found.");
      // Pause/cancel wins over a late provider response.
      if (String(entry.status) !== "searching") return;
      if (candidates.some((candidate) => candidate.provider !== String(job.provider))) {
        throw new CatalogDatabaseError("invalid_state", "Metadata provider returned a cross-provider candidate.");
      }
      const encoded = JSON.stringify(candidates);
      if (Buffer.byteLength(encoded, "utf8") > 2 * 1024 * 1024) {
        throw new CatalogDatabaseError("too_large", "Metadata candidates exceed their durable result limit.");
      }
      const status = errorCode ? "failed" : candidates.length > 0 ? "ready" : "no-results";
      const timestamp = now();
      this.database
        .prepare(
          `UPDATE metadata_lookup_entries SET status = ?, candidates_json = ?, error_code = ?, updated_at = ?
           WHERE job_id = ? AND book_id = ? AND status = 'searching'`,
        )
        .run(status, errorCode ? "[]" : encoded, errorCode, timestamp, jobId, bookId);
      this.database
        .prepare("UPDATE metadata_lookup_jobs SET revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, jobId);
      this.finalizeMetadataLookupJob(jobId, timestamp);
    });
    return this.getMetadataLookupJob(profileId, jobId) as MetadataLookupJob;
  }

  private finalizeMetadataLookupJob(jobId: string, timestamp: string): void {
    const pending = this.database
      .prepare("SELECT 1 AS pending FROM metadata_lookup_entries WHERE job_id = ? AND status IN ('pending', 'searching') LIMIT 1")
      .get(jobId);
    if (!pending) {
      this.database
        .prepare(
          `UPDATE metadata_lookup_jobs SET status = 'completed', revision = revision + 1, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(timestamp, jobId);
    }
  }

  getBookMetadataState(profileId: string, bookId: string): BookMetadataState | null {
    const book = this.getBook(profileId, bookId);
    if (!book) return null;
    const source = this.database
      .prepare(
        `SELECT sm.*, sf.content_hash
         FROM book_source_metadata sm
         JOIN books b ON b.id = sm.book_id
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? AND b.id = ?`,
      )
      .get(profileId, bookId) as Row | undefined;
    if (!source) throw new CatalogDatabaseError("invalid_state", "Book source metadata is unavailable.");
    const override = this.database
      .prepare(
        `SELECT o.*, a.asset_key AS asset_present, a.media_type AS asset_media_type,
           a.byte_length AS asset_byte_length, a.width AS asset_width, a.height AS asset_height,
           a.source_kind AS asset_source_kind, a.provider AS asset_provider,
           a.provider_reference AS asset_provider_reference, a.source_url AS asset_source_url
         FROM book_metadata_overrides o
         LEFT JOIN metadata_cover_assets a ON a.asset_key = o.cover_asset_key
         WHERE o.book_id = ?`,
      )
      .get(bookId) as Row | undefined;
    const coverOverride = mapCoverOverride(override);
    const sourceCoverKey = stringOrNull(source.cover_cache_key);
    const sourceHasCover = sourceCoverKey !== null && stringOrNull(source.cover_media_type) !== null;
    return {
      book,
      sourceMetadata: editableMetadataFromRow(source),
      sourceCoverUrl: sourceHasCover
        ? `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(bookId)}/cover?source=true&v=${encodeURIComponent(sourceCoverKey)}`
        : null,
      overrides: overridesFromRow(override),
      revision: Number(override?.revision ?? 0),
      basedOnContentHash: stringOrNull(override?.source_content_hash) ?? String(source.content_hash),
      sourceChanged: override !== undefined && String(override.source_content_hash) !== String(source.content_hash),
      coverOverride,
    };
  }

  getBookDetailsState(profileId: string, bookId: string): BookDetailsState | null {
    const state = this.getBookMetadataState(profileId, bookId);
    if (!state) return null;
    const source = this.database
      .prepare(
        `SELECT b.root_id, pr.label AS root_label, r.path AS root_path, r.status AS root_status,
           r.last_scan_at AS root_last_scan_at, r.last_error_code AS root_last_error_code,
           sf.relative_path, b.available AS book_available, sf.available AS source_available
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN library_roots r ON r.id = b.root_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? AND b.id = ?`,
      )
      .get(profileId, bookId) as Row | undefined;
    if (!source) throw new CatalogDatabaseError("invalid_state", "Book source provenance is unavailable.");
    const latest = this.database
      .prepare(
        `SELECT filename, size, managed_token, updated_at
         FROM deliveries
         WHERE profile_id = ? AND book_id = ? AND status = 'delivered'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(profileId, bookId) as Row | undefined;
    return {
      ...state,
      source: {
        rootId: String(source.root_id),
        rootLabel: String(source.root_label),
        rootPath: String(source.root_path),
        rootStatus: String(source.root_status) as RootStatus,
        rootLastScanAt: stringOrNull(source.root_last_scan_at),
        rootLastErrorCode: stringOrNull(source.root_last_error_code),
        relativePath: String(source.relative_path),
        available: bool(source.book_available) && bool(source.source_available),
      },
      latestVerifiedDelivery: latest
        ? {
            filename: stringOrNull(latest.filename),
            size: numberOrNull(latest.size),
            deliveredAt: String(latest.updated_at),
            currentPresentation: stringOrNull(latest.managed_token) === managedTokenForBook(
              state.book.id,
              state.book.presentationVersion,
            ),
          }
        : null,
    };
  }

  patchBookMetadata(profileId: string, bookId: string, input: BookMetadataPatchInput): BookMetadataState {
    this.transaction(() => {
      const context = this.metadataMutationContext(profileId, bookId, input.expectedRevision, input.expectedContentHash);
      const merged = { ...overridesFromRow(context.override), ...input.changes };
      this.writeMetadataOverride(bookId, context.rootId, context.contentHash, context.nextRevision, merged, context.coverAssetKey);
      this.refreshEffectiveBook(bookId);
    });
    return this.getBookMetadataState(profileId, bookId) as BookMetadataState;
  }

  /** Apply provider-selected fields and an optional derived cover as one SQLite
   * commit. The caller may stage cover bytes first, but a failed/stale database
   * mutation can never leave a partial metadata-only or cover-only overlay. */
  importBookMetadata(
    profileId: string,
    bookId: string,
    input: BookMetadataPatchInput,
    asset: MetadataCoverAssetInput | null,
    acceptedLookup: MetadataLookupAcceptance | null = null,
  ): CoverMutationResult {
    let previousAssetKey: string | null = null;
    this.transaction(() => {
      const context = this.metadataMutationContext(profileId, bookId, input.expectedRevision, input.expectedContentHash);
      previousAssetKey = context.coverAssetKey;
      if (asset) this.insertMetadataCoverAsset(asset);
      this.writeMetadataOverride(
        bookId,
        context.rootId,
        context.contentHash,
        context.nextRevision,
        { ...overridesFromRow(context.override), ...input.changes },
        asset?.assetKey ?? context.coverAssetKey,
      );
      this.refreshEffectiveBook(bookId);
      if (acceptedLookup) this.acceptMetadataLookupCandidate(profileId, bookId, acceptedLookup);
    });
    const stale = previousAssetKey && asset && previousAssetKey !== asset.assetKey
      && !this.isMetadataCoverReferenced(previousAssetKey)
      ? previousAssetKey
      : null;
    return { state: this.getBookMetadataState(profileId, bookId) as BookMetadataState, unreferencedAssetKey: stale };
  }

  private acceptMetadataLookupCandidate(
    profileId: string,
    bookId: string,
    accepted: MetadataLookupAcceptance,
  ): void {
    const row = this.database
      .prepare(
        `SELECT j.provider, e.status, e.candidates_json
         FROM metadata_lookup_entries e
         JOIN metadata_lookup_jobs j ON j.id = e.job_id
         WHERE j.profile_id = ? AND j.id = ? AND e.book_id = ?`,
      )
      .get(profileId, accepted.jobId, bookId) as Row | undefined;
    const candidates = row ? parseMetadataCandidates(row.candidates_json) : [];
    if (
      !row
      || String(row.status) !== "ready"
      || String(row.provider) !== accepted.provider
      || !candidates.some((candidate) => candidate.provider === accepted.provider
        && candidate.candidateId === accepted.candidateId)
    ) {
      throw new CatalogDatabaseError("conflict", "The reviewed metadata candidate is no longer available.");
    }
    const timestamp = now();
    this.database
      .prepare("UPDATE metadata_lookup_entries SET accepted_at = ?, updated_at = ? WHERE job_id = ? AND book_id = ?")
      .run(timestamp, timestamp, accepted.jobId, bookId);
    this.database
      .prepare("UPDATE metadata_lookup_jobs SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, accepted.jobId);
  }

  resetBookMetadata(profileId: string, bookId: string, input: BookMetadataResetInput): BookMetadataState {
    this.transaction(() => {
      const context = this.metadataMutationContext(profileId, bookId, input.expectedRevision, input.expectedContentHash);
      const retained = overridesFromRow(context.override);
      for (const field of input.fields ?? EDITABLE_METADATA_FIELDS) delete retained[field];
      this.writeMetadataOverride(bookId, context.rootId, context.contentHash, context.nextRevision, retained, context.coverAssetKey);
      this.refreshEffectiveBook(bookId);
    });
    return this.getBookMetadataState(profileId, bookId) as BookMetadataState;
  }

  setBookCover(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    expectedContentHash: string,
    asset: MetadataCoverAssetInput,
  ): CoverMutationResult {
    let previousAssetKey: string | null = null;
    this.transaction(() => {
      const context = this.metadataMutationContext(profileId, bookId, expectedRevision, expectedContentHash);
      previousAssetKey = context.coverAssetKey;
      this.insertMetadataCoverAsset(asset);
      this.writeMetadataOverride(
        bookId,
        context.rootId,
        context.contentHash,
        context.nextRevision,
        overridesFromRow(context.override),
        asset.assetKey,
      );
      this.refreshEffectiveBook(bookId);
    });
    const stale = previousAssetKey && previousAssetKey !== asset.assetKey && !this.isMetadataCoverReferenced(previousAssetKey)
      ? previousAssetKey
      : null;
    return { state: this.getBookMetadataState(profileId, bookId) as BookMetadataState, unreferencedAssetKey: stale };
  }

  private insertMetadataCoverAsset(asset: MetadataCoverAssetInput): void {
    this.database
      .prepare(
        `INSERT INTO metadata_cover_assets(
           asset_key, checksum, media_type, byte_length, width, height, source_kind,
           provider, provider_reference, source_url, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_key) DO NOTHING`,
      )
      .run(
        asset.assetKey,
        asset.checksum,
        asset.mediaType,
        asset.byteLength,
        asset.width,
        asset.height,
        asset.sourceKind,
        asset.provider,
        asset.providerReference,
        asset.sourceUrl,
        now(),
      );
  }

  resetBookCover(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    expectedContentHash: string,
  ): CoverMutationResult {
    let previousAssetKey: string | null = null;
    this.transaction(() => {
      const context = this.metadataMutationContext(profileId, bookId, expectedRevision, expectedContentHash);
      previousAssetKey = context.coverAssetKey;
      this.writeMetadataOverride(
        bookId,
        context.rootId,
        context.contentHash,
        context.nextRevision,
        overridesFromRow(context.override),
        null,
      );
      this.refreshEffectiveBook(bookId);
    });
    const stale = previousAssetKey && !this.isMetadataCoverReferenced(previousAssetKey) ? previousAssetKey : null;
    return { state: this.getBookMetadataState(profileId, bookId) as BookMetadataState, unreferencedAssetKey: stale };
  }

  referencedMetadataCoverKeys(): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT cover_asset_key FROM book_metadata_overrides
         WHERE cover_asset_key IS NOT NULL AND trim(cover_asset_key) <> ''`,
      )
      .all() as Row[];
    return new Set(rows.map((row) => String(row.cover_asset_key)));
  }

  pruneUnreferencedMetadataCoverAssetRows(): number {
    return Number(this.database
      .prepare(
        `DELETE FROM metadata_cover_assets
         WHERE NOT EXISTS (
           SELECT 1 FROM book_metadata_overrides o
           WHERE o.cover_asset_key = metadata_cover_assets.asset_key
         )`,
      )
      .run().changes);
  }

  isMetadataCoverReferenced(assetKey: string): boolean {
    return this.database
      .prepare("SELECT 1 AS referenced FROM book_metadata_overrides WHERE cover_asset_key = ? LIMIT 1")
      .get(assetKey) !== undefined;
  }

  private metadataMutationContext(
    profileId: string,
    bookId: string,
    expectedRevision: number,
    expectedContentHash: string,
  ): { rootId: string; contentHash: string; nextRevision: number; override: Row | undefined; coverAssetKey: string | null } {
    const current = this.database
      .prepare(
        `SELECT b.root_id, sf.content_hash
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? AND b.id = ?`,
      )
      .get(profileId, bookId) as Row | undefined;
    if (!current) throw new CatalogDatabaseError("not_found", "Book not found.");
    const contentHash = String(current.content_hash);
    if (expectedContentHash !== contentHash) {
      throw new CatalogDatabaseError("conflict", "The immutable source changed; reload the metadata editor.");
    }
    const override = this.database.prepare("SELECT * FROM book_metadata_overrides WHERE book_id = ?").get(bookId) as
      | Row
      | undefined;
    const revision = Number(override?.revision ?? 0);
    if (expectedRevision !== revision) {
      throw new CatalogDatabaseError("conflict", "The metadata was edited elsewhere; reload before saving.");
    }
    return {
      rootId: String(current.root_id),
      contentHash,
      nextRevision: revision + 1,
      override,
      coverAssetKey: stringOrNull(override?.cover_asset_key),
    };
  }

  private writeMetadataOverride(
    bookId: string,
    rootId: string,
    contentHash: string,
    revision: number,
    overrides: BookMetadataOverrides,
    coverAssetKey: string | null,
  ): void {
    const value = (field: EditableMetadataField): SqlValue => {
      if (!Object.hasOwn(overrides, field)) return null;
      const raw = overrides[field];
      return field === "authors" || field === "subjects" || field === "identifiers"
        ? JSON.stringify(raw)
        : (raw ?? null) as SqlValue;
    };
    const set = (field: EditableMetadataField): number => Object.hasOwn(overrides, field) ? 1 : 0;
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO book_metadata_overrides(
           book_id, root_id, source_content_hash, revision,
           title_set, title, authors_set, authors_json, author_sort_set, author_sort,
           language_set, language, publisher_set, publisher, published_at_set, published_at,
           series_set, series, series_index_set, series_index, description_set, description,
           subjects_set, subjects_json, identifiers_set, identifiers_json, cover_asset_key,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           root_id = excluded.root_id, source_content_hash = excluded.source_content_hash, revision = excluded.revision,
           title_set = excluded.title_set, title = excluded.title,
           authors_set = excluded.authors_set, authors_json = excluded.authors_json,
           author_sort_set = excluded.author_sort_set, author_sort = excluded.author_sort,
           language_set = excluded.language_set, language = excluded.language,
           publisher_set = excluded.publisher_set, publisher = excluded.publisher,
           published_at_set = excluded.published_at_set, published_at = excluded.published_at,
           series_set = excluded.series_set, series = excluded.series,
           series_index_set = excluded.series_index_set, series_index = excluded.series_index,
           description_set = excluded.description_set, description = excluded.description,
           subjects_set = excluded.subjects_set, subjects_json = excluded.subjects_json,
           identifiers_set = excluded.identifiers_set, identifiers_json = excluded.identifiers_json,
           cover_asset_key = excluded.cover_asset_key, updated_at = excluded.updated_at`,
      )
      .run(
        bookId,
        rootId,
        contentHash,
        revision,
        set("title"), value("title"),
        set("authors"), value("authors"),
        set("authorSort"), value("authorSort"),
        set("language"), value("language"),
        set("publisher"), value("publisher"),
        set("publishedAt"), value("publishedAt"),
        set("series"), value("series"),
        set("seriesIndex"), value("seriesIndex"),
        set("description"), value("description"),
        set("subjects"), value("subjects"),
        set("identifiers"), value("identifiers"),
        coverAssetKey,
        timestamp,
        timestamp,
      );
  }

  private refreshEffectiveBook(bookId: string): void {
    const row = this.database
      .prepare(
        `SELECT sm.*, sf.content_hash, sf.relative_path, o.revision,
           o.source_content_hash AS override_source_content_hash, o.title_set, o.title AS override_title,
           o.authors_set, o.authors_json AS override_authors_json,
           o.author_sort_set, o.author_sort AS override_author_sort,
           o.language_set, o.language AS override_language,
           o.publisher_set, o.publisher AS override_publisher,
           o.published_at_set, o.published_at AS override_published_at,
           o.series_set, o.series AS override_series,
           o.series_index_set, o.series_index AS override_series_index,
           o.description_set, o.description AS override_description,
           o.subjects_set, o.subjects_json AS override_subjects_json,
           o.identifiers_set, o.identifiers_json AS override_identifiers_json,
           o.cover_asset_key, a.media_type AS override_cover_media_type
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN book_source_metadata sm ON sm.book_id = b.id
         LEFT JOIN book_metadata_overrides o ON o.book_id = b.id
         LEFT JOIN metadata_cover_assets a ON a.asset_key = o.cover_asset_key
         WHERE b.id = ?`,
      )
      .get(bookId) as Row | undefined;
    if (!row) throw new CatalogDatabaseError("invalid_state", "Book source metadata is unavailable.");
    const source = editableMetadataFromRow(row);
    const active = stringOrNull(row.override_source_content_hash) === String(row.content_hash);
    const overrideRow: Row | undefined = active
      ? {
          title_set: row.title_set, title: row.override_title,
          authors_set: row.authors_set, authors_json: row.override_authors_json,
          author_sort_set: row.author_sort_set, author_sort: row.override_author_sort,
          language_set: row.language_set, language: row.override_language,
          publisher_set: row.publisher_set, publisher: row.override_publisher,
          published_at_set: row.published_at_set, published_at: row.override_published_at,
          series_set: row.series_set, series: row.override_series,
          series_index_set: row.series_index_set, series_index: row.override_series_index,
          description_set: row.description_set, description: row.override_description,
          subjects_set: row.subjects_set, subjects_json: row.override_subjects_json,
          identifiers_set: row.identifiers_set, identifiers_json: row.override_identifiers_json,
        }
      : undefined;
    const overrides = overridesFromRow(overrideRow);
    const effective = mergeMetadata(source, overrides);
    const metadataEdited = Object.keys(overrides).length > 0;
    const metadataComplete = effective.title.trim().length > 0 && effective.authors.length > 0;
    const coverAssetKey = active ? stringOrNull(row.cover_asset_key) : null;
    const overrideMediaType = active ? stringOrNull(row.override_cover_media_type) : null;
    if (coverAssetKey && !overrideMediaType) {
      throw new CatalogDatabaseError("invalid_state", "A selected durable cover asset is missing from the database.");
    }
    const presentationVersion = presentationVersionFor(
      String(row.content_hash),
      effective,
      metadataEdited,
      coverAssetKey,
    );
    const timestamp = now();
    this.database
      .prepare(
        `UPDATE books SET title = ?, authors_json = ?, author_sort = ?, language = ?, publisher = ?,
           published_at = ?, series = ?, series_index = ?, description = ?, subjects_json = ?, identifiers_json = ?,
           metadata_complete = ?,
           cover_media_type = ?, cover_cache_key = ?, cover_expected = ?, cover_storage = ?,
           metadata_revision = ?, metadata_edited = ?, cover_edited = ?, presentation_version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        effective.title,
        JSON.stringify(effective.authors),
        effective.authorSort,
        effective.language,
        effective.publisher,
        effective.publishedAt,
        effective.series,
        effective.seriesIndex,
        effective.description,
        JSON.stringify(effective.subjects),
        JSON.stringify(effective.identifiers),
        metadataComplete ? 1 : 0,
        coverAssetKey ? overrideMediaType : stringOrNull(row.cover_media_type),
        coverAssetKey ?? stringOrNull(row.cover_cache_key),
        coverAssetKey ? 1 : bool(row.cover_expected) ? 1 : 0,
        coverAssetKey ? "override" : "cache",
        Number(row.revision ?? 0),
        metadataEdited ? 1 : 0,
        coverAssetKey ? 1 : 0,
        presentationVersion,
        timestamp,
        bookId,
      );
    this.database.prepare("DELETE FROM books_fts WHERE book_id = ?").run(bookId);
    this.database
      .prepare(
        `INSERT INTO books_fts(book_id, title, authors, subjects, publisher, series, identifiers, description, source_filename)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bookId,
        effective.title,
        effective.authors.join(" "),
        effective.subjects.join(" "),
        effective.publisher ?? "",
        effective.series ?? "",
        effective.identifiers.join(" "),
        effective.description ?? "",
        String(row.relative_path),
      );
  }

  getBookSource(profileId: string, bookId: string): BookSourceRecord | null {
    const row = this.database
      .prepare(
        `SELECT b.*, sf.format, sf.size, sf.content_hash,
           sm.cover_cache_key AS source_cover_cache_key, sm.cover_media_type AS source_cover_media_type,
           pr.profile_id, r.path AS root_path, sf.relative_path
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN library_roots r ON r.id = b.root_id
         JOIN book_source_metadata sm ON sm.book_id = b.id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? AND b.id = ?`,
      )
      .get(profileId, bookId) as Row | undefined;
    if (!row) {
      return null;
    }
    return {
      book: mapBook(row),
      rootPath: String(row.root_path),
      relativePath: String(row.relative_path),
      coverKey: stringOrNull(row.cover_cache_key),
      coverMediaType: stringOrNull(row.cover_media_type),
      coverStorage: String(row.cover_storage) === "override" ? "override" : "cache",
      sourceCoverKey: stringOrNull(row.source_cover_cache_key),
      sourceCoverMediaType: stringOrNull(row.source_cover_media_type),
    };
  }

  private bookQueryPlan(profileId: string, query: BookSetQuery): BookQueryPlan {
    const where: string[] = ["pr.profile_id = ?"];
    const values: SqlValue[] = [profileId];
    let ftsJoin = "";
    const ftsQuery = query.q ? makeFtsQuery(query.q) : null;
    if (ftsQuery) {
      ftsJoin = " JOIN books_fts ON books_fts.book_id = b.id ";
      where.push("books_fts MATCH ?");
      values.push(ftsQuery);
    }
    if (query.author) {
      where.push("EXISTS (SELECT 1 FROM json_each(b.authors_json) WHERE value = ? COLLATE NOCASE)");
      values.push(query.author);
    }
    if (query.language) {
      where.push("b.language = ? COLLATE NOCASE");
      values.push(query.language);
    }
    if (query.subject) {
      where.push("EXISTS (SELECT 1 FROM json_each(b.subjects_json) WHERE value = ? COLLATE NOCASE)");
      values.push(query.subject);
    }
    if (query.publisher) {
      where.push("b.publisher = ? COLLATE NOCASE");
      values.push(query.publisher);
    }
    if (query.series) {
      where.push("b.series = ? COLLATE NOCASE");
      values.push(query.series);
    }
    if (query.seriesKey) {
      if (canonicalSeriesKey(query.seriesKey) !== query.seriesKey || query.seriesKey.length > 500) {
        throw new RangeError("Series key is invalid.");
      }
      where.push("kindle_bridge_series_key(b.series) = ?");
      values.push(query.seriesKey);
    }
    if (query.year) {
      where.push("substr(b.published_at, 1, 4) = ?");
      values.push(query.year);
    }
    if (query.format) {
      where.push("sf.format = ?");
      values.push(query.format);
    }
    if (query.rootId) {
      where.push("b.root_id = ?");
      values.push(query.rootId);
    }
    if (query.metadata) {
      where.push(`b.metadata_complete = ${query.metadata === "complete" ? 1 : 0}`);
    }
    if (query.available !== undefined) {
      where.push(`b.available = ${query.available ? 1 : 0}`);
    }
    if (query.coverAvailable !== undefined) {
      where.push(query.coverAvailable
        ? "b.cover_media_type IS NOT NULL AND b.cover_cache_key IS NOT NULL"
        : "(b.cover_media_type IS NULL OR b.cover_cache_key IS NULL)");
    }
    if (query.favorite !== undefined) {
      where.push(
        `${query.favorite ? "" : "NOT "}EXISTS (
          SELECT 1 FROM profile_book_annotations annotation
          WHERE annotation.profile_id = pr.profile_id AND annotation.book_id = b.id AND annotation.favorite = 1
        )`,
      );
    }
    if (query.wantToRead !== undefined) {
      where.push(
        `${query.wantToRead ? "" : "NOT "}EXISTS (
          SELECT 1 FROM profile_book_annotations annotation
          WHERE annotation.profile_id = pr.profile_id AND annotation.book_id = b.id AND annotation.want_to_read = 1
        )`,
      );
    }
    if (query.includeBookIds) {
      where.push("b.id IN (SELECT value FROM json_each(?))");
      values.push(JSON.stringify(query.includeBookIds));
    }
    if (query.excludeBookIds) {
      where.push("b.id NOT IN (SELECT value FROM json_each(?))");
      values.push(JSON.stringify(query.excludeBookIds));
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const sortColumns = {
      recent: "b.added_at",
      title: "b.title COLLATE NOCASE",
      author: "coalesce(b.author_sort, b.title) COLLATE NOCASE",
      published: "coalesce(b.published_at, '')",
      added: "b.added_at",
      updated: "b.updated_at",
      size: "sf.size",
    } as const;
    const selectedSort = query.sort ?? "title";
    const descendingByDefault = ["recent", "published", "added", "updated"].includes(query.sort ?? "");
    const order = query.order ? (query.order === "desc" ? "DESC" : "ASC") : descendingByDefault ? "DESC" : "ASC";
    const numberedFirst = `CASE WHEN b.series_index > 0 AND b.series_index <= ${MAX_USABLE_SERIES_INDEX}
      THEN 0 ELSE 1 END ASC`;
    const seriesIndex = `CASE WHEN b.series_index > 0 AND b.series_index <= ${MAX_USABLE_SERIES_INDEX}
      THEN b.series_index END ${order}`;
    const orderBy = selectedSort === "series"
      ? `kindle_bridge_series_key(b.series) ${order}, ${numberedFirst}, ${seriesIndex}, b.title COLLATE NOCASE, b.id`
      : selectedSort === "series-index"
        ? `${numberedFirst}, ${seriesIndex}, b.title COLLATE NOCASE, b.id`
        : `${sortColumns[selectedSort]} ${order}, b.id ASC`;
    return {
      predicate: where.join(" AND "),
      ftsJoin,
      values,
      limit,
      offset,
      orderBy,
    };
  }

  listBooks(profileId: string, query: BookSetQuery = {}): BookPage {
    const plan = this.bookQueryPlan(profileId, query);
    const countRow = this.database
      .prepare(
        `SELECT count(DISTINCT b.id) AS total FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         ${plan.ftsJoin} WHERE ${plan.predicate}`,
      )
      .get(...plan.values) as Row;
    const rows = this.database
      .prepare(`${BOOK_PAGE_SELECT} ${plan.ftsJoin} WHERE ${plan.predicate} ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`)
      .all(...plan.values, plan.limit, plan.offset) as Row[];
    return {
      items: rows.map(mapBook),
      total: Number(countRow.total ?? 0),
      limit: plan.limit,
      offset: plan.offset,
    };
  }

  /** Serialize a coherent page only after its selected rows and exact JSON
   * representation have passed the catalog response ceiling. */
  serializeBookPage(
    profileId: string,
    query: BookSetQuery = {},
    maximumBytes = MAX_CATALOG_JSON_RESPONSE_BYTES,
  ): Buffer {
    return this.readTransaction(() => {
      const plan = this.bookQueryPlan(profileId, query);
      const profile = this.database.prepare("SELECT enabled FROM profiles WHERE id = ?").get(profileId) as Row | undefined;
      if (!profile || !bool(profile.enabled)) throw new CatalogDatabaseError("not_found", "Profile not found.");
      const countRow = this.database
        .prepare(
          `SELECT count(DISTINCT b.id) AS total FROM books b
           JOIN source_files sf ON sf.id = b.source_file_id
           JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
           JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
           ${plan.ftsJoin} WHERE ${plan.predicate}`,
        )
        .get(...plan.values) as Row;
      const total = Number(countRow.total ?? 0);
      this.preflightBookPage(profileId, plan, maximumBytes);
      const byteLength = this.measureBookPageJson(profileId, plan, total, maximumBytes);
      const body = Buffer.allocUnsafe(byteLength);
      let offset = 0;
      this.emitBookPageJson(profileId, plan, total, {
        raw: (value) => {
          offset += writeUtf8(body, offset, value);
        },
        string: (value) => {
          offset = writeJsonString(body, offset, value);
        },
        nullableString: (value) => {
          if (value === null) offset += writeUtf8(body, offset, "null");
          else offset = writeJsonString(body, offset, value);
        },
        number: (value) => {
          offset += writeUtf8(body, offset, jsonNumber(value));
        },
      });
      if (offset !== byteLength) {
        throw new CatalogDatabaseError("invalid_state", "Catalog-page serialization length changed unexpectedly.");
      }
      return body;
    });
  }

  private preflightBookPage(profileId: string, plan: BookQueryPlan, maximumBytes: number): void {
    const pageIds = `SELECT b.id FROM books b
      JOIN source_files sf ON sf.id = b.source_file_id
      JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
      JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
      ${plan.ftsJoin} WHERE ${plan.predicate}
      ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`;
    const preflight = this.database
      .prepare(
        `WITH page_ids AS (${pageIds})
         SELECT coalesce(sum(
             length(CAST(b.id AS BLOB)) + length(CAST(b.root_id AS BLOB))
             + length(CAST(b.title AS BLOB)) + length(CAST(b.authors_json AS BLOB))
             + coalesce(length(CAST(b.author_sort AS BLOB)), 0)
             + coalesce(length(CAST(b.language AS BLOB)), 0)
             + coalesce(length(CAST(b.publisher AS BLOB)), 0)
             + coalesce(length(CAST(b.published_at AS BLOB)), 0)
             + coalesce(length(CAST(b.series AS BLOB)), 0)
             + coalesce(length(CAST(b.series_index AS BLOB)), 0)
             + coalesce(length(CAST(b.description AS BLOB)), 0)
             + length(CAST(b.subjects_json AS BLOB)) + length(CAST(b.identifiers_json AS BLOB))
             + length(CAST(sf.format AS BLOB)) + length(CAST(sf.content_hash AS BLOB))
             + length(CAST(sf.relative_path AS BLOB)) + length(CAST(b.added_at AS BLOB))
             + length(CAST(b.updated_at AS BLOB))
             + coalesce(length(CAST(b.presentation_version AS BLOB)), 0)
             + coalesce(length(CAST(b.cover_cache_key AS BLOB)), 0)
           ), 0) AS raw_bytes,
           sum(CASE WHEN
             json_type(b.authors_json) <> 'array' OR json_type(b.subjects_json) <> 'array'
             OR json_type(b.identifiers_json) <> 'array'
             OR EXISTS (SELECT 1 FROM json_each(b.authors_json) WHERE type <> 'text')
             OR EXISTS (SELECT 1 FROM json_each(b.subjects_json) WHERE type <> 'text')
             OR EXISTS (SELECT 1 FROM json_each(b.identifiers_json) WHERE type <> 'text')
             OR length(CAST(b.id AS BLOB)) > 128 OR length(CAST(b.root_id AS BLOB)) > 128
             OR coalesce(length(CAST(b.cover_cache_key AS BLOB)), 0) > 256
             THEN 1 ELSE 0 END) AS invalid_count
         FROM page_ids page
         JOIN books b ON b.id = page.id
         JOIN source_files sf ON sf.id = b.source_file_id`,
      )
      .get(...plan.values, plan.limit, plan.offset) as Row;
    if (Number(preflight.invalid_count ?? 0) > 0) {
      throw new CatalogDatabaseError("invalid_state", "Catalog-page metadata contains invalid values.");
    }
    const rawBytes = Buffer.byteLength(profileId) + Number(preflight.raw_bytes ?? 0);
    if (!Number.isSafeInteger(rawBytes) || rawBytes > maximumBytes) {
      throw catalogResponseByteLimitError(maximumBytes);
    }
  }

  private measureBookPageJson(
    profileId: string,
    plan: BookQueryPlan,
    total: number,
    maximumBytes: number,
  ): number {
    let byteLength = 0;
    const retain = (additional: number): void => {
      if (!Number.isSafeInteger(additional) || additional < 0 || additional > maximumBytes - byteLength) {
        throw catalogResponseByteLimitError(maximumBytes);
      }
      byteLength += additional;
    };
    this.emitBookPageJson(profileId, plan, total, {
      raw: (value) => retain(Buffer.byteLength(value)),
      string: (value) => retain(jsonStringByteLength(value)),
      nullableString: (value) => retain(value === null ? 4 : jsonStringByteLength(value)),
      number: (value) => retain(Buffer.byteLength(jsonNumber(value))),
    });
    return byteLength;
  }

  private emitBookPageJson(profileId: string, plan: BookQueryPlan, total: number, sink: BoundedJsonSink): void {
    sink.raw('{"items":[');
    let first = true;
    const rows = this.database
      .prepare(`${BOOK_PAGE_SELECT} ${plan.ftsJoin} WHERE ${plan.predicate} ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`)
      .iterate(...plan.values, plan.limit, plan.offset) as IterableIterator<Row>;
    for (const row of rows) {
      if (!first) sink.raw(",");
      first = false;
      const id = String(row.id);
      const relativePath = String(row.relative_path);
      const filename = basenameFromCatalogPath(relativePath);
      const coverKey = stringOrNull(row.cover_cache_key);
      const hasCover = bool(row.cover_media_present) && coverKey !== null;
      sink.raw('{"id":');
      sink.string(id);
      sink.raw(',"profileId":');
      sink.string(profileId);
      sink.raw(',"rootId":');
      sink.string(String(row.root_id));
      sink.raw(',"title":');
      sink.string(String(row.title));
      sink.raw(',"authors":');
      sink.raw(String(row.authors_json));
      sink.raw(',"authorSort":');
      sink.nullableString(stringOrNull(row.author_sort));
      sink.raw(',"language":');
      sink.nullableString(stringOrNull(row.language));
      sink.raw(',"publisher":');
      sink.nullableString(stringOrNull(row.publisher));
      sink.raw(',"publishedAt":');
      sink.nullableString(stringOrNull(row.published_at));
      sink.raw(',"series":');
      sink.nullableString(stringOrNull(row.series));
      sink.raw(',"seriesIndex":');
      sink.number(numberOrNull(row.series_index));
      sink.raw(',"description":');
      sink.nullableString(stringOrNull(row.description));
      sink.raw(',"subjects":');
      sink.raw(String(row.subjects_json));
      sink.raw(',"identifiers":');
      sink.raw(String(row.identifiers_json));
      sink.raw(',"format":');
      sink.string(String(row.format));
      sink.raw(',"size":');
      sink.number(Number(row.size));
      sink.raw(',"contentHash":');
      sink.string(String(row.content_hash));
      sink.raw(',"presentationVersion":');
      sink.string(stringOrNull(row.presentation_version) ?? String(row.content_hash));
      sink.raw(',"sourceFilename":');
      sink.string(filename);
      sink.raw(',"addedAt":');
      sink.string(String(row.added_at));
      sink.raw(',"updatedAt":');
      sink.string(String(row.updated_at));
      sink.raw(',"metadataComplete":');
      sink.raw(bool(row.metadata_complete) ? "true" : "false");
      sink.raw(',"available":');
      sink.raw(bool(row.available) ? "true" : "false");
      sink.raw(',"coverUrl":');
      sink.nullableString(
        hasCover
          ? `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(coverKey)}`
          : null,
      );
      sink.raw(',"sourceUrl":');
      sink.string(`/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/source`);
      sink.raw(',"metadataEdited":');
      sink.raw(bool(row.metadata_edited) ? "true" : "false");
      sink.raw(',"coverEdited":');
      sink.raw(bool(row.cover_edited) ? "true" : "false");
      sink.raw(',"metadataRevision":');
      sink.number(Number(row.metadata_revision ?? 0));
      sink.raw("}");
    }
    sink.raw('],"total":');
    sink.number(total);
    sink.raw(',"limit":');
    sink.number(plan.limit);
    sink.raw(',"offset":');
    sink.number(plan.offset);
    sink.raw("}");
  }

  getFilters(profileId: string): CatalogFilters {
    const boundedFacet = (candidates: string, orderBy: string): Row[] =>
      this.database
        .prepare(
          `WITH candidates(value, label, count) AS (
             ${candidates}
             ORDER BY ${orderBy} LIMIT ?3
           ), ranked AS (
             SELECT value, label, count,
               row_number() OVER (ORDER BY ${orderBy}) AS facet_rank,
               sum(
                 length(CAST(value AS BLOB)) + coalesce(length(CAST(label AS BLOB)), 0)
               ) OVER (ORDER BY ${orderBy} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS retained_bytes
             FROM candidates
           )
           SELECT value, label, count FROM ranked
           WHERE retained_bytes <= ?2 ORDER BY facet_rank`,
        )
        .all(profileId, MAX_FILTER_FIELD_BYTES_PER_FACET, MAX_FILTER_VALUES_PER_FACET) as Row[];
    const plain = (rows: Row[]): Array<{ value: string; count: number }> =>
      rows.map((row) => ({ value: String(row.value), count: Number(row.count) }));
    const array = (column: "authors_json" | "subjects_json"): Row[] =>
      boundedFacet(
        `SELECT min(CAST(j.value AS TEXT)) AS value, NULL AS label, count(DISTINCT b.id) AS count
         FROM books b
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1,
         json_each(b.${column}) j
         WHERE pr.profile_id = ?1 AND typeof(j.value) = 'text' AND trim(j.value) <> ''
         GROUP BY j.value COLLATE NOCASE`,
        "count DESC, value COLLATE NOCASE, value",
      );
    const scalar = (column: "language" | "publisher" | "series"): Row[] =>
      boundedFacet(
        `SELECT min(b.${column}) AS value, NULL AS label, count(*) AS count
         FROM books b
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ?1 AND b.${column} IS NOT NULL AND trim(b.${column}) <> ''
         GROUP BY b.${column} COLLATE NOCASE`,
        "count DESC, value COLLATE NOCASE, value",
      );
    const years = boundedFacet(
      `SELECT substr(b.published_at, 1, 4) AS value, NULL AS label, count(*) AS count
       FROM books b
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       WHERE pr.profile_id = ?1 AND b.published_at GLOB '[0-9][0-9][0-9][0-9]*'
       GROUP BY substr(b.published_at, 1, 4)`,
      "value DESC",
    );
    const formats = boundedFacet(
      `SELECT sf.format AS value, NULL AS label, count(*) AS count FROM books b
       JOIN source_files sf ON sf.id = b.source_file_id
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       WHERE pr.profile_id = ?1 GROUP BY sf.format`,
      "value",
    );
    const roots = boundedFacet(
      `SELECT b.root_id AS value, pr.label AS label, count(*) AS count FROM books b
       JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
       JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
       WHERE pr.profile_id = ?1 GROUP BY b.root_id, pr.label`,
      "label COLLATE NOCASE, label, value",
    );
    return {
      authors: plain(array("authors_json")),
      languages: plain(scalar("language")),
      subjects: plain(array("subjects_json")),
      publishers: plain(scalar("publisher")),
      series: plain(scalar("series")),
      years: plain(years),
      formats: plain(formats),
      roots: roots.map((row) => ({ value: String(row.value), label: String(row.label), count: Number(row.count) })),
    };
  }

  getMatchIndex(profileId: string, limits: MatchIndexLimits = {}): ProfileMatchIndex {
    return this.withMatchIndexDeliveryHealing(profileId, limits, () =>
      this.readTransaction(() => {
        const maximumBytes = this.preflightMatchIndex(profileId, limits);
        const generatedAt = now();
        const metadataClaims = this.buildMetadataClaimSummary(profileId);
        this.measureMatchIndexJson(profileId, generatedAt, metadataClaims, maximumBytes);

        const entries: MatchIndexEntry[] = [];
        let current: MatchIndexEntry | null = null;
        this.walkMatchIndexRows(profileId, {
          startBook: (row, managedToken, staleManagedTokens) => {
            const relativePath = String(row.relative_path);
            current = {
              bookId: String(row.id),
              ...(bool(row.preferred_presentation) ? { preferredPresentation: true as const } : {}),
              title: String(row.title),
              authors: parseStringArray(row.authors_json),
              authorSort: stringOrNull(row.author_sort),
              identifiers: parseStringArray(row.identifiers_json),
              sourceFormat: String(row.format) as BookFormat,
              sourceSize: Number(row.size),
              contentHash: String(row.content_hash),
              presentationVersion: String(row.presentation_version),
              sourceFilename: relativePath.split(/[\\/]/u).at(-1) ?? relativePath,
              managedToken,
              staleManagedTokens: [...staleManagedTokens],
              deliveries: [],
            };
          },
          delivery: (row) => {
            if (!current) throw new CatalogDatabaseError("invalid_state", "Match-index delivery has no book.");
            current.deliveries.push(mapMatchDelivery(row));
          },
          endBook: () => {
            if (!current) throw new CatalogDatabaseError("invalid_state", "Match-index book was not initialized.");
            entries.push(current);
            current = null;
          },
        });
        return { profileId, generatedAt, metadataClaims, entries };
      }),
    );
  }

  /** Build one pre-bounded wire body without retaining all SQLite rows or a
   * second full JSON string. */
  serializeMatchIndex(profileId: string, limits: MatchIndexLimits = {}): Buffer {
    return this.withMatchIndexDeliveryHealing(profileId, limits, () =>
      this.readTransaction(() => {
        const maximumBytes = this.preflightMatchIndex(profileId, limits);
        const generatedAt = now();
        const metadataClaims = this.buildMetadataClaimSummary(profileId);
        const byteLength = this.measureMatchIndexJson(profileId, generatedAt, metadataClaims, maximumBytes);
        const body = Buffer.allocUnsafe(byteLength);
        let offset = 0;
        this.emitMatchIndexJson(profileId, generatedAt, metadataClaims, {
          raw: (value) => {
            offset += writeUtf8(body, offset, value);
          },
          string: (value) => {
            offset = writeJsonString(body, offset, value);
          },
          nullableString: (value) => {
            if (value === null) offset += writeUtf8(body, offset, "null");
            else offset = writeJsonString(body, offset, value);
          },
          number: (value) => {
            offset += writeUtf8(body, offset, jsonNumber(value));
          },
        });
        if (offset !== byteLength) {
          throw new CatalogDatabaseError("invalid_state", "Match-index serialization length changed unexpectedly.");
        }
        return body;
      }),
    );
  }

  private withMatchIndexDeliveryHealing<T>(
    profileId: string,
    limits: MatchIndexLimits,
    operation: () => T,
  ): T {
    try {
      return operation();
    } catch (error) {
      const usesRetentionEnvelope =
        (limits.maxEntries ?? MAX_MATCH_INDEX_ENTRIES) >= MAX_MATCH_INDEX_ENTRIES
        && (limits.maxDeliveries ?? MAX_MATCH_INDEX_DELIVERIES) >= MAX_MATCH_INDEX_DELIVERIES
        && (limits.maxResponseBytes ?? MAX_MATCH_INDEX_RESPONSE_BYTES) >= MAX_MATCH_INDEX_RESPONSE_BYTES;
      if (
        !(error instanceof CatalogDatabaseError)
        || error.code !== "match_index_too_large"
        || !usesRetentionEnvelope
      ) {
        throw error;
      }
      this.transaction(() => {
        this.compactMatchIndexDeliveries(profileId, null, true);
      });
      return operation();
    }
  }

  private assertMatchIndexServiceable(profileId: string): void {
    const maximumBytes = this.preflightMatchIndex(profileId, {});
    this.measureMatchIndexJson(profileId, now(), incompleteMetadataClaimSummary(), maximumBytes);
  }

  private preflightMatchIndex(profileId: string, limits: MatchIndexLimits): number {
    const profile = this.database.prepare("SELECT enabled FROM profiles WHERE id = ?").get(profileId) as Row | undefined;
    if (!profile || !bool(profile.enabled)) throw new CatalogDatabaseError("not_found", "Profile not found.");
    const maximumEntries = limits.maxEntries ?? MAX_MATCH_INDEX_ENTRIES;
    const maximumDeliveries = limits.maxDeliveries ?? MAX_MATCH_INDEX_DELIVERIES;
    const maximumBytes = limits.maxResponseBytes ?? MAX_MATCH_INDEX_RESPONSE_BYTES;
    const preflight = this.database
      .prepare(
        `SELECT
           (SELECT count(*)
              FROM books b
              JOIN source_files sf ON sf.id = b.source_file_id
              JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
              JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
             WHERE pr.profile_id = ? AND b.available = 1 AND sf.available = 1) AS entry_count,
           (SELECT count(*)
              FROM deliveries d
              JOIN books db ON db.id = d.book_id
              JOIN source_files dsf ON dsf.id = db.source_file_id
              JOIN profile_roots dpr
                ON dpr.root_id = db.root_id AND dpr.profile_id = d.profile_id AND dpr.enabled = 1
              JOIN profiles dp ON dp.id = dpr.profile_id AND dp.enabled = 1
             WHERE d.profile_id = ? AND d.status = 'delivered'
               AND db.available = 1 AND dsf.available = 1
               AND d.managed_token = kindle_bridge_managed_token(db.id, db.presentation_version)
           ) AS delivery_count,
           (SELECT coalesce(sum(
               length(CAST(b.id AS BLOB)) + length(CAST(b.title AS BLOB))
               + length(CAST(b.authors_json AS BLOB))
               + coalesce(length(CAST(b.author_sort AS BLOB)), 0)
               + length(CAST(b.identifiers_json AS BLOB))
               + length(CAST(b.presentation_version AS BLOB))
               + length(CAST(sf.format AS BLOB)) + length(CAST(sf.content_hash AS BLOB))
               + length(CAST(sf.relative_path AS BLOB))
             ), 0)
              FROM books b
              JOIN source_files sf ON sf.id = b.source_file_id
              JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
              JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
             WHERE pr.profile_id = ? AND b.available = 1 AND sf.available = 1) AS book_raw_bytes,
           (SELECT coalesce(sum(
               length(CAST(d.device_key AS BLOB))
               + coalesce(length(CAST(d.artifact_hash AS BLOB)), 0)
               + coalesce(length(CAST(d.filename AS BLOB)), 0)
               + coalesce(length(CAST(d.object_persistent_id AS BLOB)), 0)
               + coalesce(length(CAST(d.managed_token AS BLOB)), 0)
               + length(CAST(d.status AS BLOB)) + length(CAST(d.updated_at AS BLOB))
             ), 0)
              FROM deliveries d
              JOIN books db ON db.id = d.book_id
              JOIN source_files dsf ON dsf.id = db.source_file_id
              JOIN profile_roots dpr
                ON dpr.root_id = db.root_id AND dpr.profile_id = d.profile_id AND dpr.enabled = 1
              JOIN profiles dp ON dp.id = dpr.profile_id AND dp.enabled = 1
             WHERE d.profile_id = ? AND d.status = 'delivered'
               AND db.available = 1 AND dsf.available = 1
               AND d.managed_token = kindle_bridge_managed_token(db.id, db.presentation_version)
           ) AS delivery_raw_bytes,
           (SELECT count(*)
              FROM books b
              JOIN source_files sf ON sf.id = b.source_file_id
              JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
              JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
             WHERE pr.profile_id = ? AND b.available = 1 AND sf.available = 1 AND (
               json_type(b.authors_json) <> 'array'
               OR json_type(b.identifiers_json) <> 'array'
               OR EXISTS (SELECT 1 FROM json_each(b.authors_json) WHERE type <> 'text')
               OR EXISTS (SELECT 1 FROM json_each(b.identifiers_json) WHERE type <> 'text')
             )) AS invalid_array_count`,
      )
      .get(profileId, profileId, profileId, profileId, profileId) as Row;
    if (Number(preflight.entry_count) > maximumEntries) {
      throw new CatalogDatabaseError(
        "too_large",
        `The profile match index exceeds the ${maximumEntries.toLocaleString("en-US")} book limit.`,
      );
    }
    if (Number(preflight.delivery_count) > maximumDeliveries) {
      throw new CatalogDatabaseError(
        "too_large",
        `The profile match index exceeds the ${maximumDeliveries.toLocaleString("en-US")} delivery-history limit.`,
      );
    }
    if (Number(preflight.invalid_array_count) > 0) {
      throw new CatalogDatabaseError("invalid_state", "Match-index metadata arrays contain invalid values.");
    }
    // This aggregate is checked before response-bearing text is selected into
    // JavaScript. Each subsequent `.iterate()` step therefore holds at most
    // one raw row whose total UTF-8 payload is already below the wire ceiling.
    const rawBytes =
      Buffer.byteLength(profileId) + Number(preflight.book_raw_bytes) + Number(preflight.delivery_raw_bytes);
    if (!Number.isSafeInteger(rawBytes) || rawBytes > maximumBytes) throw matchIndexByteLimitError(maximumBytes);
    return maximumBytes;
  }

  /**
   * Summarize every other enabled, currently available household claimant
   * without returning its metadata to the browser. All preflights and walks
   * happen inside the caller's match-index read transaction. Any malformed or
   * over-budget global state yields an incomplete fixed-width summary so
   * metadata-only matches fail closed while the active index remains usable.
   */
  private buildMetadataClaimSummary(profileId: string): MetadataClaimSummary {
    const summaryStartedAt = Date.now();
    const remainingSummaryMs = (): number =>
      DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS.maxElapsedMs - (Date.now() - summaryStartedAt);
    const candidateBooksSql = `
      SELECT b.id, b.title, b.authors_json, b.identifiers_json, sf.format, sf.size, sf.content_hash
      FROM books b
      JOIN source_files sf ON sf.id = b.source_file_id
      JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
      JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
      WHERE pr.profile_id <> ? AND b.available = 1 AND sf.available = 1
        AND NOT EXISTS (
          SELECT 1
          FROM profile_roots active_pr
          JOIN profiles active_p ON active_p.id = active_pr.profile_id AND active_p.enabled = 1
          WHERE active_pr.profile_id = ? AND active_pr.root_id = b.root_id AND active_pr.enabled = 1
        )
      GROUP BY b.id
      ORDER BY b.id
      LIMIT ${DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS.maxGlobalBooks + 1}`;
    try {
      const preflight = this.database
        .prepare(
          `WITH candidate_books AS (${candidateBooksSql})
           SELECT count(*) AS claimant_count,
             coalesce(sum(
               length(CAST(id AS BLOB)) + length(CAST(title AS BLOB))
               + length(CAST(authors_json AS BLOB)) + length(CAST(identifiers_json AS BLOB))
               + length(CAST(format AS BLOB)) + length(CAST(size AS BLOB))
               + length(CAST(content_hash AS BLOB))
             ), 0) AS raw_bytes,
             coalesce(sum(CASE
               WHEN json_valid(authors_json) <> 1 OR json_valid(identifiers_json) <> 1 THEN 1
               WHEN json_type(authors_json) <> 'array' OR json_type(identifiers_json) <> 'array' THEN 1
               WHEN EXISTS (SELECT 1 FROM json_each(authors_json) WHERE type <> 'text') THEN 1
               WHEN EXISTS (SELECT 1 FROM json_each(identifiers_json) WHERE type <> 'text') THEN 1
               ELSE 0
             END), 0) AS invalid_array_count
           FROM candidate_books`,
        )
        .get(profileId, profileId) as Row;
      if (remainingSummaryMs() <= 0) return incompleteMetadataClaimSummary();
      const claimantCount = Number(preflight.claimant_count);
      const rawBytes = Number(preflight.raw_bytes);
      if (!Number.isSafeInteger(claimantCount)
        || claimantCount > DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS.maxGlobalBooks
        || !Number.isSafeInteger(rawBytes)
        || rawBytes > MAX_METADATA_CLAIM_RAW_BYTES
        || Number(preflight.invalid_array_count) !== 0) {
        return incompleteMetadataClaimSummary();
      }

      const atomPreflight = this.database
        .prepare(
          `WITH candidate_books AS (${candidateBooksSql})
           SELECT coalesce(sum(
             json_array_length(authors_json) + json_array_length(identifiers_json)
           ), 0) AS atom_count
           FROM candidate_books`,
        )
        .get(profileId, profileId) as Row;
      if (remainingSummaryMs() <= 0) return incompleteMetadataClaimSummary();
      const atomCount = Number(atomPreflight.atom_count);
      if (!Number.isSafeInteger(atomCount)
        || atomCount > DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS.maxGlobalAtoms) {
        return incompleteMetadataClaimSummary();
      }

      const deliveryPreflight = this.database
        .prepare(
          `WITH candidate_books AS (${candidateBooksSql}),
           candidate_delivery_sizes AS (
             SELECT d.id, d.size
             FROM candidate_books cb
             JOIN books b ON b.id = cb.id
             JOIN source_files sf ON sf.id = b.source_file_id
             JOIN deliveries d ON d.book_id = b.id
             JOIN profile_roots dpr
               ON dpr.root_id = b.root_id AND dpr.profile_id = d.profile_id AND dpr.enabled = 1
             JOIN profiles dp ON dp.id = dpr.profile_id AND dp.enabled = 1
             WHERE d.status = 'delivered' AND d.size IS NOT NULL AND d.size >= 0
               AND b.available = 1 AND sf.available = 1
               AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
             ORDER BY d.id
             LIMIT ${MAX_METADATA_CLAIM_DELIVERY_ROWS + 1}
           )
           SELECT count(*) AS delivery_count,
             coalesce(sum(
               length(CAST(id AS BLOB)) + length(CAST(size AS BLOB))
             ), 0) AS raw_bytes
           FROM candidate_delivery_sizes`,
        )
        .get(profileId, profileId) as Row;
      if (remainingSummaryMs() <= 0) return incompleteMetadataClaimSummary();
      const deliveryCount = Number(deliveryPreflight.delivery_count);
      const deliveryRawBytes = Number(deliveryPreflight.raw_bytes);
      if (!Number.isSafeInteger(deliveryCount)
        || deliveryCount > MAX_METADATA_CLAIM_DELIVERY_ROWS
        || !Number.isSafeInteger(deliveryRawBytes)
        || rawBytes + deliveryRawBytes > MAX_METADATA_CLAIM_RAW_BYTES) {
        return incompleteMetadataClaimSummary();
      }

      const activeRows = this.database
        .prepare(
          `SELECT b.id, b.title, b.authors_json, b.identifiers_json,
             sf.format, sf.size, sf.content_hash, sf.relative_path
           FROM books b
           JOIN source_files sf ON sf.id = b.source_file_id
           JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
           JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
           WHERE pr.profile_id = ? AND b.available = 1 AND sf.available = 1
           ORDER BY b.id`,
        )
        .iterate(profileId) as IterableIterator<MatchBookRow>;
      const otherRows = this.database
        .prepare(
          `WITH candidate_books AS (${candidateBooksSql})
           SELECT cb.id, cb.title, cb.authors_json, cb.identifiers_json,
             CASE WHEN lower(cb.format) = 'azw3' AND cb.size >= 0 THEN 1
               WHEN EXISTS (
                 SELECT 1
                 FROM books db
                 JOIN source_files dsf ON dsf.id = db.source_file_id
                 JOIN deliveries d ON d.book_id = db.id
                 JOIN profile_roots dpr
                   ON dpr.root_id = db.root_id AND dpr.profile_id = d.profile_id AND dpr.enabled = 1
                 JOIN profiles dp ON dp.id = dpr.profile_id AND dp.enabled = 1
                 WHERE db.id = cb.id AND d.status = 'delivered'
                   AND d.size IS NOT NULL AND d.size >= 0
                   AND db.available = 1 AND dsf.available = 1
                   AND d.managed_token = kindle_bridge_managed_token(db.id, db.presentation_version)
                 LIMIT 1
               ) THEN 1 ELSE 0 END AS has_known_artifact_size
           FROM candidate_books cb ORDER BY cb.id`,
        )
        .iterate(profileId, profileId) as IterableIterator<MetadataClaimRow>;
      const activeBooks = (function* (): IterableIterator<MetadataClaimBook> {
        for (const row of activeRows) {
          yield {
            bookId: String(row.id),
            title: String(row.title),
            authors: parseStringArray(row.authors_json),
            identifiers: parseStringArray(row.identifiers_json),
            hasKnownArtifactSize: false,
          };
        }
      }());
      const otherBooks = (function* (): IterableIterator<MetadataClaimBook> {
        for (const row of otherRows) {
          yield {
            bookId: String(row.id),
            title: String(row.title),
            authors: parseStringArray(row.authors_json),
            identifiers: parseStringArray(row.identifiers_json),
            hasKnownArtifactSize: bool(row.has_known_artifact_size),
          };
        }
      }());
      return summarizeGlobalMetadataClaims(activeBooks, otherBooks, {
        maxElapsedMs: remainingSummaryMs(),
      });
    } catch {
      return incompleteMetadataClaimSummary();
    }
  }

  private measureMatchIndexJson(
    profileId: string,
    generatedAt: string,
    metadataClaims: MetadataClaimSummary,
    maximumBytes: number,
  ): number {
    let byteLength = 0;
    const retain = (additional: number): void => {
      if (!Number.isSafeInteger(additional) || additional < 0 || additional > maximumBytes - byteLength) {
        throw matchIndexByteLimitError(maximumBytes);
      }
      byteLength += additional;
    };
    this.emitMatchIndexJson(profileId, generatedAt, metadataClaims, {
      raw: (value) => retain(Buffer.byteLength(value)),
      string: (value) => retain(jsonStringByteLength(value)),
      nullableString: (value) => retain(value === null ? 4 : jsonStringByteLength(value)),
      number: (value) => retain(Buffer.byteLength(jsonNumber(value))),
    });
    return byteLength;
  }

  private emitMatchIndexJson(
    profileId: string,
    generatedAt: string,
    metadataClaims: MetadataClaimSummary,
    sink: BoundedJsonSink,
  ): void {
    sink.raw('{"profileId":');
    sink.string(profileId);
    sink.raw(',"generatedAt":');
    sink.string(generatedAt);
    sink.raw(',"metadataClaims":{"complete":');
    sink.raw(metadataClaims.complete ? "true" : "false");
    sink.raw(',"collisionBitmap":');
    sink.string(metadataClaims.collisionBitmap);
    sink.raw("}");
    sink.raw(',"entries":[');
    let firstBook = true;
    let firstDelivery = true;
    this.walkMatchIndexRows(profileId, {
      startBook: (row, managedToken, staleManagedTokens) => {
        if (!firstBook) sink.raw(",");
        firstBook = false;
        firstDelivery = true;
        const relativePath = String(row.relative_path);
        sink.raw('{"bookId":');
        sink.string(String(row.id));
        if (bool(row.preferred_presentation)) sink.raw(',"preferredPresentation":true');
        sink.raw(',"title":');
        sink.string(String(row.title));
        sink.raw(',"authors":');
        sink.raw(String(row.authors_json));
        sink.raw(',"authorSort":');
        sink.nullableString(stringOrNull(row.author_sort));
        sink.raw(',"identifiers":');
        sink.raw(String(row.identifiers_json));
        sink.raw(',"sourceFormat":');
        sink.string(String(row.format));
        sink.raw(',"sourceSize":');
        sink.number(Number(row.size));
        sink.raw(',"contentHash":');
        sink.string(String(row.content_hash));
        sink.raw(',"presentationVersion":');
        sink.string(String(row.presentation_version));
        sink.raw(',"sourceFilename":');
        sink.string(relativePath.split(/[\\/]/u).at(-1) ?? relativePath);
        sink.raw(',"managedToken":');
        sink.string(managedToken);
        sink.raw(',"staleManagedTokens":[');
        for (const [index, token] of staleManagedTokens.entries()) {
          if (index > 0) sink.raw(",");
          sink.string(token);
        }
        sink.raw("]");
        sink.raw(',"deliveries":[');
      },
      delivery: (row) => {
        if (!firstDelivery) sink.raw(",");
        firstDelivery = false;
        emitMatchDeliveryJson(row, sink);
      },
      endBook: () => sink.raw("]}"),
    });
    sink.raw("]}");
  }

  private walkMatchIndexRows(
    profileId: string,
    visitor: {
      startBook(row: MatchBookRow, managedToken: string, staleManagedTokens: readonly string[]): void;
      delivery(row: MatchDeliveryRow): void;
      endBook(): void;
    },
  ): void {
    const books = this.database
      .prepare(
        `WITH preferred_books AS (
           SELECT preferred_book_id AS book_id
           FROM catalog_issue_dispositions
           WHERE profile_id = ?1 AND issue_type = 'suspected-duplicate'
             AND ignored = 0 AND preferred_book_id IS NOT NULL
           GROUP BY preferred_book_id
         )
         SELECT b.id, preferred_books.book_id IS NOT NULL AS preferred_presentation,
           b.title, b.authors_json, b.author_sort, b.identifiers_json,
           b.presentation_version, sf.format, sf.size, sf.content_hash, sf.relative_path
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         LEFT JOIN preferred_books ON preferred_books.book_id = b.id
         WHERE pr.profile_id = ?1 AND b.available = 1 AND sf.available = 1 ORDER BY b.id`,
      )
      .iterate(profileId) as IterableIterator<MatchBookRow>;
    const deliveryIterator = (this.database
      .prepare(
        `SELECT d.book_id, d.device_key, d.status, d.artifact_hash, d.filename, d.size,
           d.object_persistent_id, d.managed_token, d.updated_at
         FROM deliveries d
         JOIN books b ON b.id = d.book_id
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr
           ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE d.profile_id = ? AND d.status = 'delivered'
           AND b.available = 1 AND sf.available = 1
           AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
         ORDER BY d.book_id, d.updated_at, d.id`,
      )
      .iterate(profileId) as IterableIterator<MatchDeliveryRow>)[Symbol.iterator]();
    const staleTokenIterator = (this.database
      .prepare(
        `WITH stale_tokens AS (
           SELECT d.book_id, d.managed_token, max(d.updated_at) AS latest_at
           FROM deliveries d
           JOIN books b ON b.id = d.book_id
           JOIN source_files sf ON sf.id = b.source_file_id
           JOIN profile_roots pr
             ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
           JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
           WHERE d.profile_id = ? AND d.status = 'delivered'
             AND b.available = 1 AND sf.available = 1
             AND d.managed_token <> kindle_bridge_managed_token(b.id, b.presentation_version)
             AND length(d.managed_token) = 23
             AND substr(d.managed_token, 1, 3) = 'kb-'
             AND substr(d.managed_token, 4) NOT GLOB '*[^0-9a-f]*'
           GROUP BY d.book_id, d.managed_token
         ), ranked_tokens AS (
           SELECT book_id, managed_token,
             row_number() OVER (
               PARTITION BY book_id ORDER BY latest_at DESC, managed_token ASC
             ) AS retention_rank
           FROM stale_tokens
         )
         SELECT book_id, managed_token FROM ranked_tokens
         WHERE retention_rank <= ${MAX_STALE_MANAGED_TOKENS_PER_BOOK}
         ORDER BY book_id, retention_rank`,
      )
      .iterate(profileId) as IterableIterator<MatchStaleManagedTokenRow>)[Symbol.iterator]();
    let delivery = deliveryIterator.next();
    let staleToken = staleTokenIterator.next();
    for (const book of books) {
      const bookId = String(book.id);
      const managedToken = managedTokenForBook(bookId, String(book.presentation_version));
      while (!delivery.done && String(delivery.value.book_id) < bookId) delivery = deliveryIterator.next();
      while (!staleToken.done && String(staleToken.value.book_id) < bookId) staleToken = staleTokenIterator.next();
      const staleManagedTokens: string[] = [];
      while (!staleToken.done && String(staleToken.value.book_id) === bookId) {
        staleManagedTokens.push(String(staleToken.value.managed_token));
        staleToken = staleTokenIterator.next();
      }
      visitor.startBook(book, managedToken, staleManagedTokens);
      while (!delivery.done && String(delivery.value.book_id) === bookId) {
        // The SQL predicate already excludes stale presentation evidence;
        // retain this equality as a fail-closed guard around the registered
        // deterministic token function.
        if (String(delivery.value.managed_token) === managedToken) visitor.delivery(delivery.value);
        delivery = deliveryIterator.next();
      }
      visitor.endBook();
    }
  }

  createDelivery(idempotencyKey: string, input: DeliveryInput): { record: DeliveryRecord; created: boolean } {
    const requestHash = createHash("sha256").update(stableJson(input)).digest("hex");
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM deliveries WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | undefined;
      if (existing) {
        if (String(existing.request_hash) !== requestHash) {
          throw new CatalogDatabaseError("conflict", "The idempotency key was already used for another request.");
        }
        return { record: mapDelivery(existing), created: false };
      }
      if (!this.getProfile(input.profileId) || !this.getBook(input.profileId, input.bookId)) {
        throw new CatalogDatabaseError("not_found", "Profile or book not found.");
      }
      const timestamp = now();
      const id = opaqueId("delivery");
      this.database
        .prepare(
          `INSERT INTO deliveries(
             id, idempotency_key, request_hash, profile_id, book_id, device_key, status, artifact_hash,
             filename, size, object_persistent_id, managed_token, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          idempotencyKey,
          requestHash,
          input.profileId,
          input.bookId,
          input.deviceKey,
          input.status,
          input.artifactHash ?? null,
          input.filename ?? null,
          input.size ?? null,
          input.objectIdentity ?? null,
          input.managedToken ?? null,
          timestamp,
          timestamp,
        );

      // Keep both partitions live-bounded even if this database predates the
      // invariant. Excluding `id` guarantees the just-accepted request remains
      // replayable; both positive ceilings leave enough older rows to prune.
      this.pruneDeliveryPartition(input.profileId, id, true, MAX_MATCH_INDEX_DELIVERIES);
      this.pruneDeliveryPartition(
        input.profileId,
        id,
        false,
        MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE,
      );
      this.compactMatchIndexDeliveries(input.profileId, id, true);
      this.assertMatchIndexServiceable(input.profileId);

      const inserted = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
      if (!inserted) {
        throw new CatalogDatabaseError("invalid_state", "The current delivery could not be retained.");
      }
      return { record: mapDelivery(inserted), created: true };
    });
  }

  private pruneDeliveryPartition(
    profileId: string,
    currentDeliveryId: string,
    delivered: boolean,
    maximumRows: number,
  ): void {
    const statusPredicate = delivered ? "status = 'delivered'" : "status <> 'delivered'";
    const countRow = this.database
      .prepare(`SELECT count(*) AS count FROM deliveries WHERE profile_id = ? AND ${statusPredicate}`)
      .get(profileId) as Row;
    const count = Number(countRow.count);
    const excess = count - maximumRows;
    if (excess <= 0) return;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(excess)) {
      throw new CatalogDatabaseError("invalid_state", "Delivery-history retention count is invalid.");
    }

    const result = this.database
      .prepare(
        `DELETE FROM deliveries
         WHERE id IN (
           SELECT id FROM deliveries
           WHERE profile_id = ? AND ${statusPredicate} AND id <> ?
           ORDER BY updated_at ASC, id ASC
           LIMIT ?
         )`,
      )
      .run(profileId, currentDeliveryId, excess);
    if (Number(result.changes) !== excess) {
      throw new CatalogDatabaseError("invalid_state", "Delivery-history retention could not preserve its ceiling.");
    }
    this.pruneUnprotectedCatalogIdentities();
  }

  private pruneDeliveryPartitionAcrossProfiles(delivered: boolean, maximumRows: number): void {
    const statusPredicate = delivered ? "status = 'delivered'" : "status <> 'delivered'";
    const result = this.database
      .prepare(
        `DELETE FROM deliveries
         WHERE id IN (
           SELECT id FROM (
             SELECT id,
               row_number() OVER (
                 PARTITION BY profile_id ORDER BY updated_at DESC, id DESC
               ) AS retention_rank
             FROM deliveries
             WHERE ${statusPredicate}
           ) AS ranked_deliveries
           WHERE retention_rank > ?
         )`,
      )
      .run(maximumRows);
    if (Number(result.changes) > 0) this.pruneUnprotectedCatalogIdentities();
  }

  /**
   * Stable IDs survive healthy source churn, but unreferenced historical paths
   * are a bounded recovery aid rather than an append-only archive. Current
   * books and retained delivery evidence are always protected. Rebuild-pending
   * roots are also excluded so a cache clear cannot erase identity continuity
   * before the replacement scan has committed.
   */
  private pruneUnprotectedCatalogIdentities(rootId?: string): void {
    const rootPredicate = rootId === undefined ? "" : "AND h.root_id = ?";
    const parameters: SqlValue[] = rootId === undefined
      ? [MAX_UNREFERENCED_IDENTITIES_PER_ROOT, MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT]
      : [rootId, MAX_UNREFERENCED_IDENTITIES_PER_ROOT, MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT];
    this.database
      .prepare(
        `DELETE FROM catalog_book_identities
         WHERE rowid IN (
           SELECT identity_rowid FROM (
             SELECT h.rowid AS identity_rowid,
               row_number() OVER (
                 PARTITION BY h.root_id
                 ORDER BY h.updated_at DESC, h.book_id ASC, h.relative_path ASC
               ) AS retention_rank,
               sum(
                 length(CAST(h.root_id AS BLOB))
                 + length(CAST(h.relative_path AS BLOB))
                 + length(CAST(h.content_hash AS BLOB))
                 + length(CAST(h.book_id AS BLOB))
                 + length(CAST(h.updated_at AS BLOB)) + 8
               ) OVER (
                 PARTITION BY h.root_id
                 ORDER BY h.updated_at DESC, h.book_id ASC, h.relative_path ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS retained_bytes
             FROM catalog_book_identities h
             WHERE NOT EXISTS (
                 SELECT 1 FROM books b WHERE b.id = h.book_id AND b.root_id = h.root_id
               )
               AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.book_id = h.book_id)
               AND NOT EXISTS (SELECT 1 FROM book_metadata_overrides o WHERE o.book_id = h.book_id)
               AND NOT EXISTS (SELECT 1 FROM send_queue_entries q WHERE q.book_id = h.book_id)
               AND NOT EXISTS (SELECT 1 FROM profile_book_annotations a WHERE a.book_id = h.book_id)
               AND NOT EXISTS (
                 SELECT 1 FROM catalog_rebuild_pending_roots pending WHERE pending.root_id = h.root_id
               )
               ${rootPredicate}
           )
           WHERE retention_rank > ? OR retained_bytes > ?
         )`,
      )
      .run(...parameters);
  }

  /**
   * Delivery evidence is bounded retention, including its idempotency ledger:
   * exact replays remain stable while their row is retained, while an ancient
   * pruned key is intentionally outside that replay window. Compact only rows
   * that the match serializer can emit, and remove the oldest evidence first.
   */
  private compactMatchIndexDeliveries(
    profileId: string,
    currentDeliveryId: string | null,
    failIfUnserviceable: boolean,
  ): boolean {
    const relevantEvidence = this.database
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM deliveries d
           JOIN books b ON b.id = d.book_id
           JOIN source_files sf ON sf.id = b.source_file_id
           JOIN profile_roots pr
             ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
           JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
           WHERE d.profile_id = ? AND d.status = 'delivered'
             AND b.available = 1 AND sf.available = 1
             AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
           LIMIT 1
         ) AS present`,
      )
      .get(profileId) as Row;
    if (!bool(relevantEvidence.present)) return true;

    const maximumBytes = MAX_MATCH_INDEX_RESPONSE_BYTES;
    const generatedAt = now();
    const initialByteLength = this.measureMatchIndexJson(
      profileId,
      generatedAt,
      incompleteMetadataClaimSummary(),
      Number.MAX_SAFE_INTEGER,
    );
    if (initialByteLength <= maximumBytes) return true;

    const remainingByBook = new Map<string, number>();
    const countRows = this.database
      .prepare(
        `SELECT d.book_id, count(*) AS count
         FROM deliveries d
         JOIN books b ON b.id = d.book_id
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr
           ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE d.profile_id = ? AND d.status = 'delivered'
           AND b.available = 1 AND sf.available = 1
           AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
         GROUP BY d.book_id`,
      )
      .iterate(profileId) as IterableIterator<Row>;
    for (const row of countRows) remainingByBook.set(String(row.book_id), Number(row.count));

    const currentPredicate = currentDeliveryId === null ? "" : "AND d.id <> ?";
    const candidateParameters: SqlValue[] =
      currentDeliveryId === null ? [profileId] : [profileId, currentDeliveryId];
    const candidates = this.database
      .prepare(
        `SELECT d.id, d.book_id, d.device_key, d.status, d.artifact_hash, d.filename, d.size,
           d.object_persistent_id, d.managed_token, d.updated_at
         FROM deliveries d
         JOIN books b ON b.id = d.book_id
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr
           ON pr.root_id = b.root_id AND pr.profile_id = d.profile_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE d.profile_id = ? AND d.status = 'delivered'
           AND b.available = 1 AND sf.available = 1
           AND d.managed_token = kindle_bridge_managed_token(b.id, b.presentation_version)
           ${currentPredicate}
         ORDER BY d.updated_at ASC, d.id ASC`,
      )
      .iterate(...candidateParameters) as IterableIterator<MatchDeliveryRetentionRow>;

    let projectedByteLength = initialByteLength;
    const deletionIds: string[] = [];
    for (const row of candidates) {
      const bookId = String(row.book_id);
      const remaining = remainingByBook.get(bookId);
      if (!Number.isSafeInteger(remaining) || remaining === undefined || remaining <= 0) {
        throw new CatalogDatabaseError("invalid_state", "Match-index delivery retention state is invalid.");
      }
      // A non-empty JSON array has one comma per item after its first. Removing
      // any item while another remains therefore removes its object plus one
      // comma; removing the final item removes only its object.
      projectedByteLength -= matchDeliveryJsonByteLength(row) + (remaining > 1 ? 1 : 0);
      remainingByBook.set(bookId, remaining - 1);
      deletionIds.push(String(row.id));
      if (projectedByteLength <= maximumBytes) break;
    }

    if (projectedByteLength > maximumBytes) {
      if (failIfUnserviceable) throw matchIndexByteLimitError(maximumBytes);
      return false;
    }

    const deleteDelivery = this.database.prepare("DELETE FROM deliveries WHERE id = ?");
    for (const id of deletionIds) {
      const result = deleteDelivery.run(id);
      if (Number(result.changes) !== 1) {
        throw new CatalogDatabaseError("invalid_state", "Match-index delivery compaction changed unexpectedly.");
      }
    }
    if (deletionIds.length > 0) this.pruneUnprotectedCatalogIdentities();
    // Re-run the production serializer's exact measurement. Any accounting
    // drift fails the surrounding transaction closed instead of committing an
    // index that the HTTP endpoint cannot serve.
    this.measureMatchIndexJson(
      profileId,
      generatedAt,
      incompleteMetadataClaimSummary(),
      maximumBytes,
    );
    return true;
  }

  getDelivery(id: string): DeliveryRecord | null {
    const row = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
    return row ? mapDelivery(row) : null;
  }

  statusCounts(): { configured: number; available: number; unavailable: number; errors: number } {
    const row = this.database
      .prepare(
        `SELECT count(*) AS configured,
           sum(CASE WHEN status IN ('available', 'watching', 'paused', 'scanning') THEN 1 ELSE 0 END) AS available,
           sum(CASE WHEN status IN ('unavailable', 'permission_denied') THEN 1 ELSE 0 END) AS unavailable,
           sum(CASE WHEN status = 'error' OR last_error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM library_roots r
         WHERE EXISTS (
           SELECT 1 FROM profile_roots pr JOIN profiles p ON p.id = pr.profile_id
           WHERE pr.root_id = r.id AND pr.enabled = 1 AND p.enabled = 1
         )`,
      )
      .get() as Row;
    return {
      configured: Number(row.configured ?? 0),
      available: Number(row.available ?? 0),
      unavailable: Number(row.unavailable ?? 0),
      errors: Number(row.errors ?? 0),
    };
  }
}

function mapDelivery(row: Row): DeliveryRecord {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    profileId: String(row.profile_id),
    bookId: String(row.book_id),
    deviceKey: String(row.device_key),
    status: String(row.status) as DeliveryRecord["status"],
    artifactHash: stringOrNull(row.artifact_hash),
    filename: stringOrNull(row.filename),
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    objectIdentity: stringOrNull(row.object_persistent_id),
    managedToken: stringOrNull(row.managed_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMatchDelivery(row: MatchDeliveryRow): MatchIndexEntry["deliveries"][number] {
  return {
    deviceKey: String(row.device_key),
    filename: stringOrNull(row.filename),
    artifactHash: stringOrNull(row.artifact_hash),
    artifactSize: row.size === null || row.size === undefined ? null : Number(row.size),
    objectIdentity: stringOrNull(row.object_persistent_id),
    managedToken: stringOrNull(row.managed_token),
    status: String(row.status) as DeliveryRecord["status"],
    deliveredAt: String(row.status) === "delivered" ? String(row.updated_at) : null,
  };
}

function emitMatchDeliveryJson(row: MatchDeliveryRow, sink: BoundedJsonSink): void {
  sink.raw('{"deviceKey":');
  sink.string(String(row.device_key));
  sink.raw(',"filename":');
  sink.nullableString(stringOrNull(row.filename));
  sink.raw(',"artifactHash":');
  sink.nullableString(stringOrNull(row.artifact_hash));
  sink.raw(',"artifactSize":');
  sink.number(row.size === null || row.size === undefined ? null : Number(row.size));
  sink.raw(',"objectIdentity":');
  sink.nullableString(stringOrNull(row.object_persistent_id));
  sink.raw(',"managedToken":');
  sink.nullableString(stringOrNull(row.managed_token));
  sink.raw(',"status":');
  sink.string(String(row.status));
  sink.raw(',"deliveredAt":');
  sink.nullableString(String(row.status) === "delivered" ? String(row.updated_at) : null);
  sink.raw("}");
}

function matchDeliveryJsonByteLength(row: MatchDeliveryRow): number {
  let byteLength = 0;
  emitMatchDeliveryJson(row, {
    raw: (value) => {
      byteLength += Buffer.byteLength(value);
    },
    string: (value) => {
      byteLength += jsonStringByteLength(value);
    },
    nullableString: (value) => {
      byteLength += value === null ? 4 : jsonStringByteLength(value);
    },
    number: (value) => {
      byteLength += Buffer.byteLength(jsonNumber(value));
    },
  });
  return byteLength;
}

function matchIndexByteLimitError(maximumBytes: number): CatalogDatabaseError {
  return new CatalogDatabaseError(
    "match_index_too_large",
    `The requested catalog response exceeds the ${maximumBytes.toLocaleString("en-US")} byte safety limit.`,
  );
}

function catalogResponseByteLimitError(maximumBytes: number): CatalogDatabaseError {
  return new CatalogDatabaseError(
    "response_too_large",
    `The requested catalog response exceeds the ${maximumBytes.toLocaleString("en-US")} byte safety limit.`,
  );
}

function basenameFromCatalogPath(value: string): string {
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separator < 0 ? value : value.slice(separator + 1);
}

function jsonNumber(value: number | null): string {
  return JSON.stringify(value) ?? "null";
}

/** Exact UTF-8 size of JSON.stringify(value), without allocating the escaped string. */
function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function writeUtf8(target: Buffer, offset: number, value: string): number {
  const expected = Buffer.byteLength(value);
  if (expected > target.length - offset) {
    throw new CatalogDatabaseError("invalid_state", "Bounded JSON writer exceeded its measured buffer.");
  }
  const written = target.write(value, offset, expected, "utf8");
  if (written !== expected) {
    throw new CatalogDatabaseError("invalid_state", "Bounded JSON writer produced an incomplete value.");
  }
  return written;
}

const JSON_HEX = "0123456789abcdef";

/** Write JSON.stringify(value) directly, including well-formed lone-surrogate escaping. */
function writeJsonString(target: Buffer, initialOffset: number, value: string): number {
  let offset = initialOffset;
  const ensure = (bytes: number): void => {
    if (bytes > target.length - offset) {
      throw new CatalogDatabaseError("invalid_state", "Bounded JSON writer exceeded its measured buffer.");
    }
  };
  ensure(1);
  target[offset++] = 0x22;
  let runStart = 0;
  const flush = (end: number): void => {
    if (end > runStart) offset += writeUtf8(target, offset, value.slice(runStart, end));
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: number | null = null;
    let unicodeEscape = false;
    if (code === 0x22) escaped = 0x22;
    else if (code === 0x5c) escaped = 0x5c;
    else if (code === 0x08) escaped = 0x62;
    else if (code === 0x09) escaped = 0x74;
    else if (code === 0x0a) escaped = 0x6e;
    else if (code === 0x0c) escaped = 0x66;
    else if (code === 0x0d) escaped = 0x72;
    else if (code <= 0x1f) unicodeEscape = true;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      unicodeEscape = true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      unicodeEscape = true;
    }
    if (escaped === null && !unicodeEscape) continue;
    flush(index);
    if (escaped !== null) {
      ensure(2);
      target[offset++] = 0x5c;
      target[offset++] = escaped;
    } else {
      ensure(6);
      target[offset++] = 0x5c;
      target[offset++] = 0x75;
      target[offset++] = JSON_HEX.charCodeAt((code >>> 12) & 0x0f);
      target[offset++] = JSON_HEX.charCodeAt((code >>> 8) & 0x0f);
      target[offset++] = JSON_HEX.charCodeAt((code >>> 4) & 0x0f);
      target[offset++] = JSON_HEX.charCodeAt(code & 0x0f);
    }
    runStart = index + 1;
  }
  flush(value.length);
  ensure(1);
  target[offset++] = 0x22;
  return offset;
}

function makeFtsQuery(input: string): string | null {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ") : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function managedTokenForBook(bookId: string, contentHash: string): string {
  return `kb-${createHash("sha256")
    .update(`kindle-bridge-managed-file-v2\0${bookId}\0${contentHash.toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 20)}`;
}
