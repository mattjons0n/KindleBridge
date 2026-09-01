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
  MAX_MATCH_INDEX_DELIVERIES,
  MAX_MATCH_INDEX_ENTRIES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  type BookFormat,
  type BookPage,
  type BookSetQuery,
  type CatalogBook,
  type CatalogFilters,
  type CatalogProfile,
  type CatalogRoot,
  type DeliveryInput,
  type DeliveryRecord,
  type MatchIndexEntry,
  type MetadataClaimSummary,
  type ProfileInput,
  type ProfileConfiguration,
  type ProfileConfigurationInput,
  type ProfileMatchIndex,
  type RootInput,
  type RootStatus,
} from "../shared/catalog-contracts.js";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CONFIGURATION_WRITES_PER_PROFILE,
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

export interface ExtractedBookInput {
  title: string;
  authors: string[];
  authorSort: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  series: string | null;
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
  title: string;
  authors_json: string;
  author_sort: string | null;
  identifiers_json: string;
  format: string;
  size: number;
  content_hash: string;
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
    subjects: parseStringArray(row.subjects_json),
    identifiers: parseStringArray(row.identifiers_json),
    format: String(row.format) as BookFormat,
    size: Number(row.size),
    contentHash: String(row.content_hash),
    sourceFilename: String(row.relative_path).split(/[\\/]/u).at(-1) ?? String(row.relative_path),
    addedAt: String(row.added_at),
    updatedAt: String(row.updated_at),
    metadataComplete: bool(row.metadata_complete),
    available: bool(row.available),
    coverUrl: hasCover
      ? `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/cover?v=${encodeURIComponent(String(row.cover_cache_key))}`
      : null,
    sourceUrl: `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(id)}/source`,
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
    b.published_at, b.series, b.subjects_json, b.identifiers_json, b.metadata_complete,
    b.available, b.added_at, b.updated_at, b.cover_cache_key,
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
    this.schemaVersion = migrateCatalogDatabase(this.database);
    if (this.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      throw new CatalogDatabaseError("invalid_state", "The catalog database schema is not supported.");
    }
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
               AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
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
           sf.last_error_code, b.cover_cache_key, b.cover_expected
         FROM source_files sf LEFT JOIN books b ON b.source_file_id = sf.id
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
      const values: SqlValue[] = [
        input.rootId,
        sourceId,
        metadata.title,
        JSON.stringify(metadata.authors),
        metadata.authorSort,
        metadata.language,
        metadata.publisher,
        metadata.publishedAt,
        metadata.series,
        JSON.stringify(metadata.subjects),
        JSON.stringify(metadata.identifiers),
        metadata.metadataComplete ? 1 : 0,
        metadata.coverMediaType,
        metadata.coverKey,
        (metadata.coverExpected ?? metadata.coverKey !== null) ? 1 : 0,
        timestamp,
        bookId,
      ];
      if (existing?.book_id) {
        this.database
          .prepare(
            `UPDATE books SET root_id = ?, source_file_id = ?, title = ?, authors_json = ?,
               author_sort = ?, language = ?, publisher = ?, published_at = ?, series = ?, subjects_json = ?,
               identifiers_json = ?, metadata_complete = ?, cover_media_type = ?, cover_cache_key = ?, cover_expected = ?, available = 1,
               updated_at = ? WHERE id = ?`,
          )
          .run(...values);
      } else {
        this.database
          .prepare(
            `INSERT INTO books(
               root_id, source_file_id, title, authors_json, author_sort, language, publisher,
               published_at, series, subjects_json, identifiers_json, metadata_complete, cover_media_type,
               cover_cache_key, cover_expected, updated_at, id, available, added_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(...values, timestamp);
      }

      this.database.prepare("DELETE FROM books_fts WHERE book_id = ?").run(bookId);
      this.database
        .prepare(
          `INSERT INTO books_fts(book_id, title, authors, subjects, publisher, series, identifiers, source_filename)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bookId,
          metadata.title,
          metadata.authors.join(" "),
          metadata.subjects.join(" "),
          metadata.publisher ?? "",
          metadata.series ?? "",
          metadata.identifiers.join(" "),
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
        `SELECT DISTINCT cover_cache_key FROM books
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

  getBookSource(profileId: string, bookId: string): BookSourceRecord | null {
    const row = this.database
      .prepare(
        `SELECT b.*, sf.format, sf.size, sf.content_hash,
           pr.profile_id, r.path AS root_path, sf.relative_path
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN library_roots r ON r.id = b.root_id
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
    const sort = sortColumns[query.sort ?? "title"];
    const descendingByDefault = ["recent", "published", "added", "updated"].includes(query.sort ?? "");
    const order = query.order ? (query.order === "desc" ? "DESC" : "ASC") : descendingByDefault ? "DESC" : "ASC";
    return {
      predicate: where.join(" AND "),
      ftsJoin,
      values,
      limit,
      offset,
      orderBy: `${sort} ${order}, b.id ASC`,
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
             + length(CAST(b.subjects_json AS BLOB)) + length(CAST(b.identifiers_json AS BLOB))
             + length(CAST(sf.format AS BLOB)) + length(CAST(sf.content_hash AS BLOB))
             + length(CAST(sf.relative_path AS BLOB)) + length(CAST(b.added_at AS BLOB))
             + length(CAST(b.updated_at AS BLOB))
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
          startBook: (row, managedToken) => {
            const relativePath = String(row.relative_path);
            current = {
              bookId: String(row.id),
              title: String(row.title),
              authors: parseStringArray(row.authors_json),
              authorSort: stringOrNull(row.author_sort),
              identifiers: parseStringArray(row.identifiers_json),
              sourceFormat: String(row.format) as BookFormat,
              sourceSize: Number(row.size),
              contentHash: String(row.content_hash),
              sourceFilename: relativePath.split(/[\\/]/u).at(-1) ?? relativePath,
              managedToken,
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
               AND d.managed_token = kindle_bridge_managed_token(db.id, dsf.content_hash)
           ) AS delivery_count,
           (SELECT coalesce(sum(
               length(CAST(b.id AS BLOB)) + length(CAST(b.title AS BLOB))
               + length(CAST(b.authors_json AS BLOB))
               + coalesce(length(CAST(b.author_sort AS BLOB)), 0)
               + length(CAST(b.identifiers_json AS BLOB))
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
               AND d.managed_token = kindle_bridge_managed_token(db.id, dsf.content_hash)
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
               AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
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
                   AND d.managed_token = kindle_bridge_managed_token(db.id, dsf.content_hash)
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
      startBook: (row, managedToken) => {
        if (!firstBook) sink.raw(",");
        firstBook = false;
        firstDelivery = true;
        const relativePath = String(row.relative_path);
        sink.raw('{"bookId":');
        sink.string(String(row.id));
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
        sink.raw(',"sourceFilename":');
        sink.string(relativePath.split(/[\\/]/u).at(-1) ?? relativePath);
        sink.raw(',"managedToken":');
        sink.string(managedToken);
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
      startBook(row: MatchBookRow, managedToken: string): void;
      delivery(row: MatchDeliveryRow): void;
      endBook(): void;
    },
  ): void {
    const books = this.database
      .prepare(
        `SELECT b.id, b.title, b.authors_json, b.author_sort, b.identifiers_json,
           sf.format, sf.size, sf.content_hash, sf.relative_path
         FROM books b
         JOIN source_files sf ON sf.id = b.source_file_id
         JOIN profile_roots pr ON pr.root_id = b.root_id AND pr.enabled = 1
         JOIN profiles p ON p.id = pr.profile_id AND p.enabled = 1
         WHERE pr.profile_id = ? AND b.available = 1 AND sf.available = 1 ORDER BY b.id`,
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
           AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
         ORDER BY d.book_id, d.updated_at, d.id`,
      )
      .iterate(profileId) as IterableIterator<MatchDeliveryRow>)[Symbol.iterator]();
    let delivery = deliveryIterator.next();
    for (const book of books) {
      const bookId = String(book.id);
      const managedToken = managedTokenForBook(bookId, String(book.content_hash));
      while (!delivery.done && String(delivery.value.book_id) < bookId) delivery = deliveryIterator.next();
      visitor.startBook(book, managedToken);
      while (!delivery.done && String(delivery.value.book_id) === bookId) {
        // The SQL predicate already excludes stale source-version evidence;
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
             AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
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
           AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
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
           AND d.managed_token = kindle_bridge_managed_token(b.id, sf.content_hash)
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
