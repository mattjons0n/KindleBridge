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
/** Fixed bitmap width for cross-profile metadata-claim collisions. */
export const METADATA_CLAIM_BITMAP_BYTES = Math.ceil(MAX_MATCH_INDEX_ENTRIES / 8);
export const METADATA_CLAIM_BITMAP_BASE64_LENGTH = 4 * Math.ceil(METADATA_CLAIM_BITMAP_BYTES / 3);

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
export type CatalogSort = "recent" | "title" | "author" | "published" | "size" | "added" | "updated";
export type SortOrder = "asc" | "desc";

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
  subjects: string[];
  identifiers: string[];
  format: BookFormat;
  size: number;
  contentHash: string;
  sourceFilename: string;
  addedAt: string;
  updatedAt: string;
  metadataComplete: boolean;
  available: boolean;
  coverUrl: string | null;
  sourceUrl: string;
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
  | "delivery.updated";

export interface CatalogEvent {
  id: string;
  type: CatalogEventType;
  at: string;
  profileId?: string;
  rootId?: string;
  bookId?: string;
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
  year?: string;
  format?: BookFormat;
  rootId?: string;
  metadata?: "complete" | "partial";
  available?: boolean;
  sort?: CatalogSort;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

export interface BookSetQuery extends BookQuery {
  includeBookIds?: string[];
  excludeBookIds?: string[];
}

export interface MatchIndexEntry {
  bookId: string;
  title: string;
  authors: string[];
  authorSort: string | null;
  identifiers: string[];
  sourceFormat: BookFormat;
  sourceSize: number;
  contentHash: string;
  sourceFilename: string;
  managedToken: string;
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
