import { createHash } from "node:crypto";
import { Dirent } from "node:fs";
import { symlink, mkdir, mkdtemp, readFile, rename, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractedBookMetadata } from "../../server/book-metadata.js";
import {
  DEFAULT_METADATA_LIMITS,
  extractAzw3Metadata,
  extractEpubMetadata,
  MetadataError,
} from "../../server/book-metadata.js";
import { CatalogDatabase, CatalogDatabaseError } from "../../server/catalog-database.js";
import { CatalogIndexer, quickSourceFingerprint, type ScannerEvent } from "../../server/catalog-indexer.js";
import { createCatalogService, type CatalogService } from "../../server/catalog-service.js";
import { CoverCache, CoverCacheError } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { sanitizeServerLogContext, structuredServerLog } from "../../server/logging.js";
import { CATALOG_SCHEMA_VERSION, migrateCatalogDatabase } from "../../server/migrations.js";
import { AllowedRootPolicy, RootPolicyError } from "../../server/root-policy.js";
import {
  MAX_CATALOG_FILTER_VALUE_BYTES,
  MAX_CATALOG_PROFILE_FIELD_BYTES,
  MAX_CATALOG_PROFILES,
  MAX_CATALOG_ROOT_FIELD_BYTES,
  MAX_CATALOG_ROOT_MEMBERSHIPS,
  MAX_CATALOG_ROOTS,
  MAX_CATALOG_ROOTS_PER_PROFILE,
  METADATA_CLAIM_BITMAP_BASE64_LENGTH,
} from "../../shared/catalog-contracts.js";

const temporaryDirectories: string[] = [];
const services: CatalogService[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.close();
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function metadata(title = "A Test Book", cover = false): ExtractedBookMetadata {
  return {
    title,
    authors: ["Ada Author"],
    authorSort: "Author, Ada",
    language: "en",
    publisher: "Test Press",
    publishedAt: "2024-03-01",
    series: "Tests",
    subjects: ["Technology"],
    identifiers: ["urn:test:1"],
    metadataComplete: true,
    cover: cover ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : null,
    coverMediaType: cover ? "image/jpeg" : null,
  };
}

function catalogMetadata(title = "A Test Book") {
  const extracted = metadata(title);
  return { ...extracted, cover: undefined, coverKey: null };
}

describe("catalog database", () => {
  it("upgrades retained version-5 rows through the current schema without losing cover state", async () => {
    const directory = await temporaryDirectory();
    const database = new DatabaseSync(path.join(directory, "upgrade.sqlite"));
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, name, applied_at) VALUES
        (1, 'v1', '2025-01-01T00:00:00.000Z'),
        (2, 'v2', '2025-01-01T00:00:00.000Z'),
        (3, 'v3', '2025-01-01T00:00:00.000Z'),
        (4, 'v4', '2025-01-01T00:00:00.000Z'),
        (5, 'v5', '2025-01-01T00:00:00.000Z');
      CREATE TABLE library_roots(id TEXT PRIMARY KEY) STRICT;
      INSERT INTO library_roots(id) VALUES ('root-retained');
      CREATE TABLE configuration_writes(
        idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        profile_id TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE deliveries(book_id TEXT NOT NULL, result_json TEXT) STRICT;
      CREATE TABLE scan_requests(
        root_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
        reason TEXT NOT NULL, requested_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE source_files(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL) STRICT;
      INSERT INTO source_files(id, root_id, relative_path, content_hash, size) VALUES
        ('source-cover', 'root-retained', 'with.epub', '${"a".repeat(64)}', 10),
        ('source-plain', 'root-retained', 'without.epub', '${"b".repeat(64)}', 11);
      CREATE TABLE books(
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, source_file_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Legacy title',
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors_json)),
        author_sort TEXT, language TEXT, publisher TEXT, published_at TEXT, series TEXT,
        subjects_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(subjects_json)),
        identifiers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(identifiers_json)),
        metadata_complete INTEGER NOT NULL DEFAULT 0 CHECK(metadata_complete IN (0, 1)),
        cover_media_type TEXT, cover_cache_key TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        book_id UNINDEXED, title, authors, subjects, publisher, series, identifiers,
        source_filename, tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO books(id, root_id, source_file_id, cover_cache_key, updated_at) VALUES
        ('with-cover', 'root-retained', 'source-cover', 'v1-retained.jpg', '2025-01-01T00:00:00.000Z'),
        ('without-cover', 'root-retained', 'source-plain', NULL, '2025-01-01T00:00:00.000Z');
    `);

    expect(migrateCatalogDatabase(database)).toBe(CATALOG_SCHEMA_VERSION);
    expect(database.prepare("SELECT id, cover_expected FROM books ORDER BY id").all()).toEqual([
      { id: "with-cover", cover_expected: 1 },
      { id: "without-cover", cover_expected: 1 },
    ]);
    expect(database.prepare("SELECT last_deep_scan_at FROM library_roots").get()).toEqual({ last_deep_scan_at: null });
    expect(database.prepare("SELECT book_id, relative_path FROM catalog_book_identities ORDER BY book_id").all()).toEqual([
      { book_id: "with-cover", relative_path: "with.epub" },
      { book_id: "without-cover", relative_path: "without.epub" },
    ]);
    database.close();
  });

  it("applies versioned migrations and preserves durable rows across catalog rebuild and restart", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    expect(database.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    const profile = database.createProfile({ name: "Household" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/books" });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "Ada.epub",
      format: "epub",
      size: 12,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-1",
      metadata: catalogMetadata(),
    });
    const retainedManagedToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    database.createDelivery("delivery-1", {
      profileId: profile.id,
      bookId: indexed.bookId,
      deviceKey: "device-hash",
      status: "delivered",
      managedToken: retainedManagedToken,
    });
    database.clearRebuildableCatalog();
    expect(database.listBooks(profile.id).total).toBe(0);
    expect(database.listProfiles()).toHaveLength(1);
    expect(database.listRoots(profile.id)).toHaveLength(1);
    expect(database.getDelivery(database.database.prepare("SELECT id FROM deliveries").get()!.id as string)).not.toBeNull();
    const rebuilt = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "Ada.epub",
      format: "epub",
      size: 12,
      mtimeMs: 2,
      contentHash: "a".repeat(64),
      scanToken: "scan-rebuilt",
      metadata: catalogMetadata(),
    });
    expect(rebuilt.bookId).toBe(indexed.bookId);
    expect(database.getMatchIndex(profile.id).entries[0]?.deliveries).toHaveLength(1);
    database.close();
    database = new CatalogDatabase(filename);
    expect(database.listProfiles()[0]?.name).toBe("Household");
    expect(database.database.prepare("SELECT count(*) count FROM deliveries").get()!.count).toBe(1);
    database.close();
  });

  it("keeps a renamed book's identity when an unrelated file reoccupies its old path before rebuild", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Renamed identity" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/renamed" });
    const originalHash = "a".repeat(64);
    const unrelatedHash = "b".repeat(64);
    const original = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "A.epub",
      format: "epub",
      size: 12,
      mtimeMs: 1,
      contentHash: originalHash,
      scanToken: "scan-1",
      metadata: catalogMetadata("Original at A"),
    });
    const retainedManagedToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    const retainedDelivery = database.createDelivery("renamed-delivery", {
      profileId: profile.id,
      bookId: original.bookId,
      deviceKey: "device-hash",
      status: "delivered",
      artifactHash: "c".repeat(64),
      filename: `renamed-${retainedManagedToken}.azw3`,
      size: 12,
      objectIdentity: "persistent-object-1",
      managedToken: retainedManagedToken,
    }).record;

    const renamed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "B.epub",
      format: "epub",
      size: 12,
      mtimeMs: 2,
      contentHash: originalHash,
      scanToken: "scan-2",
      retainedRelativePaths: new Set(),
      metadata: catalogMetadata("Original at B"),
    });
    expect(renamed.bookId).toBe(original.bookId);
    expect(database.database.prepare(
      `SELECT relative_path FROM catalog_book_identities
       WHERE root_id = ? AND book_id = ? ORDER BY relative_path`,
    ).all(root.id, original.bookId)).toEqual([{ relative_path: "B.epub" }]);

    // Model a stopped service while an unrelated file takes A, followed by a
    // full derived-catalog rebuild that happens to encounter A before B.
    database.close();
    database = new CatalogDatabase(filename);
    database.clearRebuildableCatalog();
    const unrelatedAtOldPath = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "A.epub",
      format: "epub",
      size: 12,
      mtimeMs: 3,
      contentHash: unrelatedHash,
      scanToken: "scan-rebuilt",
      metadata: catalogMetadata("Unrelated at A"),
    });
    const rebuiltOriginal = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "B.epub",
      format: "epub",
      size: 12,
      mtimeMs: 3,
      contentHash: originalHash,
      scanToken: "scan-rebuilt",
      retainedRelativePaths: new Set(["A.epub"]),
      metadata: catalogMetadata("Original at B"),
    });

    expect(unrelatedAtOldPath.bookId).not.toBe(original.bookId);
    expect(rebuiltOriginal.bookId).toBe(original.bookId);
    const rebuiltMatch = database.getMatchIndex(profile.id).entries.find(
      (entry) => entry.bookId === original.bookId,
    );
    expect(rebuiltMatch).toMatchObject({
      managedToken: retainedManagedToken,
      deliveries: [{
        managedToken: retainedManagedToken,
        status: "delivered",
      }],
    });
    expect(rebuiltMatch?.deliveries[0]).toMatchObject({
      filename: retainedDelivery.filename,
      objectIdentity: retainedDelivery.objectIdentity,
    });
    expect(database.database.prepare(
      `SELECT relative_path, book_id, content_hash FROM catalog_book_identities
       WHERE root_id = ? ORDER BY relative_path`,
    ).all(root.id)).toEqual([
      { relative_path: "A.epub", book_id: unrelatedAtOldPath.bookId, content_hash: unrelatedHash },
      { relative_path: "B.epub", book_id: original.bookId, content_hash: originalHash },
    ]);
    expect(database.database.prepare(
      `SELECT count(*) AS count, count(DISTINCT book_id) AS distinct_count
       FROM catalog_book_identities WHERE root_id = ?`,
    ).get(root.id)).toEqual({ count: 2, distinct_count: 2 });
    database.close();
  });

  it("deduplicates a shared root while enforcing profile-scoped book access", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const first = database.createProfile({ name: "First" });
    const second = database.createProfile({ name: "Second" });
    const firstRoot = database.createRoot(first.id, { label: "First label", path: "/library/shared" });
    const secondRoot = database.createRoot(second.id, { label: "Second label", path: "/library/shared" });
    expect(secondRoot.id).toBe(firstRoot.id);
    expect(database.database.prepare("SELECT count(*) count FROM library_roots").get()!.count).toBe(1);
    const indexed = database.upsertCatalogFile({
      rootId: firstRoot.id,
      relativePath: "shared.epub",
      format: "epub",
      size: 20,
      mtimeMs: 2,
      contentHash: "b".repeat(64),
      scanToken: "scan",
      metadata: catalogMetadata("Shared"),
    });
    expect(database.getBook(first.id, indexed.bookId)?.profileId).toBe(first.id);
    expect(database.getBook(second.id, indexed.bookId)?.profileId).toBe(second.id);
    database.updateRoot(first.id, firstRoot.id, { enabled: false });
    expect(database.getBook(first.id, indexed.bookId)).toBeNull();
    expect(database.getBook(second.id, indexed.bookId)?.profileId).toBe(second.id);
    expect(database.listScanRoots()[0]?.profileIds).toEqual([second.id]);
    database.updateRoot(first.id, firstRoot.id, { enabled: true });
    const isolated = database.createProfile({ name: "Isolated" });
    expect(database.getBook(isolated.id, indexed.bookId)).toBeNull();
    database.close();
  });

  it("versions cover URLs when replacement bytes change a stable book ID's cover", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Cover versions" });
    const root = database.createRoot(profile.id, { label: "Covers", path: "/library/covers" });
    const firstCoverKey = `v1-${"1".repeat(64)}.jpg`;
    const secondCoverKey = `v1-${"2".repeat(64)}.jpg`;
    const first = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "replaceable.epub",
      format: "epub",
      size: 20,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-1",
      metadata: { ...catalogMetadata("First cover"), coverKey: firstCoverKey, coverMediaType: "image/jpeg" },
    });
    const firstUrl = database.getBook(profile.id, first.bookId)?.coverUrl;
    expect(firstUrl).toContain(`?v=${firstCoverKey}`);

    const replacement = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "replaceable.epub",
      format: "epub",
      size: 21,
      mtimeMs: 2,
      contentHash: "b".repeat(64),
      scanToken: "scan-2",
      metadata: { ...catalogMetadata("Replacement cover"), coverKey: secondCoverKey, coverMediaType: "image/jpeg" },
    });
    const replacementUrl = database.getBook(profile.id, replacement.bookId)?.coverUrl;
    expect(replacement.bookId).toBe(first.bookId);
    expect(replacementUrl).toContain(`?v=${secondCoverKey}`);
    expect(replacementUrl).not.toBe(firstUrl);
    database.close();
  });

  it("keeps disabled profile/root settings and delivery history while excluding every catalog view", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Toggleable" });
    const root = database.createRoot(profile.id, { label: "Toggleable shelf", path: "/library/toggle" });
    const retainedCoverKey = `v1-${"8".repeat(64)}.jpg`;
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "toggle.epub",
      format: "epub",
      size: 20,
      mtimeMs: 2,
      contentHash: "8".repeat(64),
      scanToken: "scan",
      metadata: {
        ...catalogMetadata("Toggle me"),
        coverKey: retainedCoverKey,
        coverMediaType: "image/jpeg",
      },
    });
    const currentManagedToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    const delivery = database.createDelivery("toggle-delivery", {
      profileId: profile.id,
      bookId: indexed.bookId,
      deviceKey: "device-key",
      status: "delivered",
      managedToken: currentManagedToken,
    }).record;
    for (const status of ["queued", "sending", "failed"] as const) {
      database.createDelivery(`toggle-${status}`, {
        profileId: profile.id,
        bookId: indexed.bookId,
        deviceKey: `device-${status}`,
        status,
      });
    }
    expect(database.getMatchIndex(profile.id).entries[0]?.deliveries.map((item) => item.status)).toEqual([
      "delivered",
    ]);

    database.updateRoot(profile.id, root.id, { enabled: false });
    expect(database.listRoots(profile.id)).toEqual([expect.objectContaining({ id: root.id, enabled: false })]);
    expect(database.getProfile(profile.id)).toMatchObject({
      enabled: true,
      rootCount: 1,
      availableRootCount: 0,
      bookCount: 0,
      sourceLabel: "Toggleable shelf",
    });
    expect(database.listBooks(profile.id).total).toBe(0);
    expect(database.getBook(profile.id, indexed.bookId)).toBeNull();
    expect(database.getBookSource(profile.id, indexed.bookId)).toBeNull();
    expect(Object.values(database.getFilters(profile.id)).every((values) => values.length === 0)).toBe(true);
    expect(database.getMatchIndex(profile.id).entries).toEqual([]);
    expect(database.getDelivery(delivery.id)?.bookId).toBe(indexed.bookId);
    expect(database.referencedCoverKeys()).toEqual(new Set([retainedCoverKey]));
    expect(database.listScanRoots()).toEqual([]);
    expect(database.statusCounts().configured).toBe(0);

    database.updateRoot(profile.id, root.id, { enabled: true });
    expect(database.getBook(profile.id, indexed.bookId)?.title).toBe("Toggle me");
    database.updateProfile(profile.id, { enabled: false });
    expect(database.listProfiles()).toEqual([
      expect.objectContaining({
        id: profile.id,
        enabled: false,
        rootCount: 1,
        availableRootCount: 0,
        bookCount: 0,
        sourceLabel: "Toggleable shelf",
      }),
    ]);
    expect(database.listRoots(profile.id)).toEqual([expect.objectContaining({ id: root.id, enabled: true })]);
    expect(database.listBooks(profile.id).total).toBe(0);
    expect(database.getBook(profile.id, indexed.bookId)).toBeNull();
    expect(database.getBookSource(profile.id, indexed.bookId)).toBeNull();
    expect(Object.values(database.getFilters(profile.id)).every((values) => values.length === 0)).toBe(true);
    expect(() => database.getMatchIndex(profile.id)).toThrow(CatalogDatabaseError);
    expect(database.getDelivery(delivery.id)?.status).toBe("delivered");
    expect(database.referencedCoverKeys()).toEqual(new Set([retainedCoverKey]));
    expect(database.listScanRoots()).toEqual([]);
    expect(database.statusCounts().configured).toBe(0);

    database.updateProfile(profile.id, { enabled: true });
    expect(database.getBook(profile.id, indexed.bookId)?.id).toBe(indexed.bookId);
    database.close();
  });

  it("reports all configured memberships while availability counts only enabled healthy sources", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Health" });
    const healthy = database.createRoot(profile.id, { label: "Healthy", path: "/library/healthy" });
    const disabled = database.createRoot(profile.id, { label: "Disabled", path: "/library/disabled" });
    database.setRootStatus(healthy.id, "scanning", null);
    database.updateRoot(profile.id, disabled.id, { enabled: false });

    expect(database.listRoots(profile.id)).toHaveLength(2);
    expect(database.getProfile(profile.id)).toMatchObject({
      rootCount: 2,
      availableRootCount: 1,
    });
    expect(database.statusCounts()).toMatchObject({ configured: 1, available: 1 });

    database.updateProfile(profile.id, { enabled: false });
    expect(database.getProfile(profile.id)).toMatchObject({
      enabled: false,
      rootCount: 2,
      availableRootCount: 0,
    });
    database.updateProfile(profile.id, { enabled: true });

    database.updateRoot(profile.id, healthy.id, { enabled: false });
    expect(database.getProfile(profile.id)).toMatchObject({ rootCount: 2, availableRootCount: 0, sourceLabel: "Disabled" });
    expect(database.statusCounts()).toMatchObject({ configured: 0, available: 0 });
    database.close();
  });

  it("rotates match authority when different source bytes replace the same stable path", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Versioned identity" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/versioned" });
    const original = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "slot.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-original",
      metadata: catalogMetadata("Original book"),
    });
    const originalToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    const historicDelivery = database.createDelivery("versioned-delivery", {
      profileId: profile.id,
      bookId: original.bookId,
      deviceKey: "device-key",
      status: "delivered",
      managedToken: originalToken,
      size: 123,
    }).record;
    expect(database.getMatchIndex(profile.id).entries[0]!.deliveries).toHaveLength(1);

    const replacement = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "slot.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: "b".repeat(64),
      scanToken: "scan-replacement",
      metadata: catalogMetadata("Replacement book"),
    });
    const replacementMatch = database.getMatchIndex(profile.id).entries[0]!;
    expect(replacement.bookId).toBe(original.bookId);
    expect(replacementMatch.managedToken).not.toBe(originalToken);
    expect(replacementMatch.deliveries).toEqual([]);
    expect(replacementMatch.staleManagedTokens).toEqual([originalToken]);
    expect(database.getDelivery(historicDelivery.id)).not.toBeNull();
    database.close();
  });

  it("rejects conflicting scan options when a second profile attaches an existing global root", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const first = database.applyProfileConfiguration(
      null,
      {
        profile: { name: "First" },
        roots: [{ label: "Shared", path: "/library/global", recursive: true, watch: true }],
      },
      "global-first",
    );

    expect(() =>
      database.applyProfileConfiguration(
        null,
        {
          profile: { name: "Conflicting second" },
          roots: [{ label: "Shared", path: "/library/global", recursive: false, watch: true }],
        },
        "global-conflict-recursive",
      ),
    ).toThrow(CatalogDatabaseError);
    expect(() =>
      database.applyProfileConfiguration(
        null,
        {
          profile: { name: "Conflicting watcher" },
          roots: [{ label: "Shared", path: "/library/global", recursive: true, watch: false }],
        },
        "global-conflict-watch",
      ),
    ).toThrow(CatalogDatabaseError);
    expect(database.listProfiles()).toHaveLength(1);

    const second = database.applyProfileConfiguration(
      null,
      {
        profile: { name: "Compatible second" },
        roots: [{ label: "Same global root", path: "/library/global", recursive: true, watch: true }],
      },
      "global-compatible",
    );
    expect(second.configuration.roots[0]?.id).toBe(first.configuration.roots[0]?.id);
    expect(database.database.prepare("SELECT count(*) AS count FROM library_roots").get()!.count).toBe(1);
    database.close();
  });

  it("rejects nested and overlapping roots while still allowing an exact shared root", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const first = database.createProfile({ name: "First" });
    const second = database.createProfile({ name: "Second" });
    const root = database.createRoot(first.id, { label: "Books", path: "/libraries/books" });
    expect(() => database.createRoot(first.id, { label: "Nested", path: "/libraries/books/nested" }))
      .toThrow(CatalogDatabaseError);
    expect(() => database.createRoot(first.id, { label: "Parent", path: "/libraries" }))
      .toThrow(CatalogDatabaseError);
    expect(database.createRoot(second.id, { label: "Shared", path: "/libraries/books" }).id).toBe(root.id);
    database.close();
  });

  it("supports filename FTS, year facets, pagination and profile-rechecked include/exclude sets", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Search" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/search" });
    const first = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "hidden-filename-token.epub",
      format: "epub",
      size: 10,
      mtimeMs: 1,
      contentHash: "c".repeat(64),
      scanToken: "scan",
      metadata: catalogMetadata("Alpha"),
    });
    const second = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "second.epub",
      format: "epub",
      size: 20,
      mtimeMs: 2,
      contentHash: "d".repeat(64),
      scanToken: "scan",
      metadata: { ...catalogMetadata("Beta"), publishedAt: "2023" },
    });
    expect(database.listBooks(profile.id, { q: "filename-token" }).items[0]?.id).toBe(first.bookId);
    expect(database.listBooks(profile.id, { year: "2024" }).total).toBe(1);
    expect(database.getFilters(profile.id).years).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "2024", count: 1 })]),
    );
    expect(database.getFilters(profile.id).roots).toEqual([
      expect.objectContaining({ value: root.id, label: "Books", count: 2 }),
    ]);
    expect(database.listBooks(profile.id, { includeBookIds: [second.bookId] }).items.map((book) => book.id)).toEqual([
      second.bookId,
    ]);
    expect(database.listBooks(profile.id, { excludeBookIds: [first.bookId] }).items.map((book) => book.id)).toEqual([
      second.bookId,
    ]);
    database.close();
  });

  it("persists and generation-guards scan requests across restarts", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Queue" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/queue" });
    const first = database.requestRootScan(root.id, "watch-event");
    const second = database.requestRootScan(root.id, "manual");
    expect(second).toBe(first + 1);
    expect(database.rootScanRequest(root.id)).toEqual({ generation: second, reason: "manual" });
    database.acknowledgeRootScan(root.id, first);
    expect(database.pendingRootScanIds()).toEqual([root.id]);
    database.close();
    database = new CatalogDatabase(filename);
    expect(database.pendingRootScanIds()).toEqual([root.id]);
    expect(database.rootScanRequest(root.id)).toEqual({ generation: second, reason: "manual" });
    database.acknowledgeRootScan(root.id, second);
    expect(database.pendingRootScanIds()).toEqual([]);
    database.close();
  });

  it("makes delivery and configuration writes idempotent and rolls back invalid atomic replacement", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const created = database.applyProfileConfiguration(
      null,
      { profile: { name: "Configured" }, roots: [{ label: "One", path: "/library/one" }] },
      "config-key",
    );
    const replay = database.applyProfileConfiguration(
      null,
      { profile: { name: "Configured" }, roots: [{ label: "One", path: "/library/one" }] },
      "config-key",
    );
    expect(replay.configuration.profile.id).toBe(created.configuration.profile.id);
    expect(() =>
      database.applyProfileConfiguration(
        created.configuration.profile.id,
        {
          profile: { name: "Changed" },
          roots: [
            { label: "Duplicate", path: "/library/same" },
            { label: "Duplicate again", path: "/library/same" },
          ],
        },
        "bad-key",
      ),
    ).toThrow(CatalogDatabaseError);
    expect(database.getProfile(created.configuration.profile.id)?.name).toBe("Configured");
    database.close();
  });

  it("transactionally enforces household profile and per-profile root ceilings", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profiles = Array.from({ length: MAX_CATALOG_PROFILES }, (_, index) =>
      database.createProfile({ name: `Profile ${index.toString().padStart(3, "0")}` }),
    );

    expect(() => database.createProfile({ name: "One too many" })).toThrow(
      expect.objectContaining({ code: "too_large" }),
    );
    expect(() =>
      database.applyProfileConfiguration(
        null,
        { profile: { name: "Configuration overflow" }, roots: [] },
        "profile-overflow",
      ),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(database.database.prepare("SELECT count(*) AS count FROM profiles").get()!.count).toBe(
      MAX_CATALOG_PROFILES,
    );

    const profile = profiles[0]!;
    for (let index = 0; index < MAX_CATALOG_ROOTS_PER_PROFILE; index += 1) {
      database.createRoot(profile.id, {
        label: `Root ${index.toString().padStart(3, "0")}`,
        path: `/library/capped/${index.toString().padStart(3, "0")}`,
      });
    }
    expect(() =>
      database.createRoot(profile.id, { label: "One too many", path: "/library/capped/overflow" }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() =>
      database.applyProfileConfiguration(
        profile.id,
        {
          profile: { name: profile.name },
          roots: Array.from({ length: MAX_CATALOG_ROOTS_PER_PROFILE + 1 }, (_, index) => ({
            label: `Replacement ${index}`,
            path: `/library/replacement/${index.toString().padStart(3, "0")}`,
          })),
        },
        "root-overflow",
      ),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(database.listRoots(profile.id)).toHaveLength(MAX_CATALOG_ROOTS_PER_PROFILE);
    database.close();
  }, 20_000);

  it("preflights oversized profile and root collections before preparing row materializers", async () => {
    const directory = await temporaryDirectory();
    const timestamp = "2026-01-01T00:00:00.000Z";

    const profileDatabase = new CatalogDatabase(path.join(directory, "profile-preflight.sqlite"));
    const insertProfile = profileDatabase.database.prepare(
      `INSERT INTO profiles(id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
    );
    profileDatabase.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index <= MAX_CATALOG_PROFILES; index += 1) {
      insertProfile.run(`prf_preflight_${index}`, `Profile ${index}`, timestamp, timestamp);
    }
    profileDatabase.database.exec("COMMIT");
    const profileSql: string[] = [];
    const profilePrepare = profileDatabase.database.prepare.bind(profileDatabase.database);
    const profileSpy = vi.spyOn(profileDatabase.database, "prepare").mockImplementation((sql: string) => {
      profileSql.push(sql);
      return profilePrepare(sql);
    });
    expect(() => profileDatabase.listProfiles()).toThrow(expect.objectContaining({ code: "too_large" }));
    profileSpy.mockRestore();
    expect(profileSql.some((sql) => sql.includes("SELECT p.*"))).toBe(false);
    profileDatabase.close();

    const rootDatabase = new CatalogDatabase(path.join(directory, "root-preflight.sqlite"));
    const profile = rootDatabase.createProfile({ name: "Root preflight" });
    const insertRoot = rootDatabase.database.prepare(
      `INSERT INTO library_roots(id, path, recursive, watch, status, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'pending', ?, ?)`,
    );
    const insertMembership = rootDatabase.database.prepare(
      `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    rootDatabase.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index <= MAX_CATALOG_ROOTS_PER_PROFILE; index += 1) {
      const id = `root_preflight_${index}`;
      insertRoot.run(id, `/library/preflight/${index}`, timestamp, timestamp);
      insertMembership.run(profile.id, id, `Root ${index}`, timestamp, timestamp);
    }
    rootDatabase.database.exec("COMMIT");
    const rootSql: string[] = [];
    const rootPrepare = rootDatabase.database.prepare.bind(rootDatabase.database);
    const rootSpy = vi.spyOn(rootDatabase.database, "prepare").mockImplementation((sql: string) => {
      rootSql.push(sql);
      return rootPrepare(sql);
    });
    expect(() => rootDatabase.listRoots(profile.id)).toThrow(expect.objectContaining({ code: "too_large" }));
    rootSpy.mockRestore();
    expect(rootSql.some((sql) => sql.includes("SELECT r.*"))).toBe(false);
    rootDatabase.close();
  });

  it("transactionally enforces global distinct-root and membership ceilings", async () => {
    const directory = await temporaryDirectory();
    const timestamp = "2026-01-01T00:00:00.000Z";

    const rootDatabase = new CatalogDatabase(path.join(directory, "root-cap.sqlite"));
    const rootProfiles = Array.from({ length: 11 }, (_, index) =>
      rootDatabase.createProfile({ name: `Root owner ${index}` }),
    );
    const insertRoot = rootDatabase.database.prepare(
      `INSERT INTO library_roots(id, path, recursive, watch, status, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'pending', ?, ?)`,
    );
    const insertMembership = rootDatabase.database.prepare(
      `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    rootDatabase.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < MAX_CATALOG_ROOTS; index += 1) {
      const id = `root_global_${index.toString().padStart(4, "0")}`;
      insertRoot.run(id, `/library/global/${index.toString().padStart(4, "0")}`, timestamp, timestamp);
      insertMembership.run(rootProfiles[Math.floor(index / 100)]!.id, id, `Root ${index}`, timestamp, timestamp);
    }
    rootDatabase.database.exec("COMMIT");
    expect(() =>
      rootDatabase.createRoot(rootProfiles[10]!.id, { label: "Overflow", path: "/library/global-overflow" }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(rootDatabase.database.prepare("SELECT count(*) AS count FROM library_roots").get()!.count).toBe(
      MAX_CATALOG_ROOTS,
    );
    rootDatabase.close();

    const membershipDatabase = new CatalogDatabase(path.join(directory, "membership-cap.sqlite"));
    const membershipProfiles = Array.from({ length: 21 }, (_, index) =>
      membershipDatabase.createProfile({ name: `Membership owner ${index}` }),
    );
    const addRoot = membershipDatabase.database.prepare(
      `INSERT INTO library_roots(id, path, recursive, watch, status, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'pending', ?, ?)`,
    );
    const addMembership = membershipDatabase.database.prepare(
      `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    membershipDatabase.database.exec("BEGIN IMMEDIATE");
    for (let rootIndex = 0; rootIndex < MAX_CATALOG_ROOTS_PER_PROFILE; rootIndex += 1) {
      const id = `root_shared_${rootIndex.toString().padStart(3, "0")}`;
      addRoot.run(id, `/library/shared/${rootIndex.toString().padStart(3, "0")}`, timestamp, timestamp);
      for (let profileIndex = 0; profileIndex < 20; profileIndex += 1) {
        addMembership.run(
          membershipProfiles[profileIndex]!.id,
          id,
          `Shared ${rootIndex}`,
          timestamp,
          timestamp,
        );
      }
    }
    membershipDatabase.database.exec("COMMIT");
    expect(membershipDatabase.database.prepare("SELECT count(*) AS count FROM profile_roots").get()!.count).toBe(
      MAX_CATALOG_ROOT_MEMBERSHIPS,
    );
    expect(() =>
      membershipDatabase.createRoot(membershipProfiles[20]!.id, {
        label: "Overflow membership",
        path: "/library/shared/000",
      }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(membershipDatabase.database.prepare("SELECT count(*) AS count FROM profile_roots").get()!.count).toBe(
      MAX_CATALOG_ROOT_MEMBERSHIPS,
    );
    membershipDatabase.close();
  }, 20_000);

  it("rolls back aggregate-sized profile and valid root updates that cross collection budgets", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const originalProfile = database.createProfile({ name: "Stable profile", description: "Keep me" });
    expect(() =>
      database.updateProfile(originalProfile.id, { description: "p".repeat(MAX_CATALOG_PROFILE_FIELD_BYTES) }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(database.getProfile(originalProfile.id)?.description).toBe("Keep me");

    const profiles = [originalProfile];
    for (let index = 1; index < 10; index += 1) {
      profiles.push(database.createProfile({ name: `Root profile ${index}` }));
    }
    const timestamp = "2026-01-01T00:00:00.000Z";
    const insertRoot = database.database.prepare(
      `INSERT INTO library_roots(id, path, recursive, watch, status, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'pending', ?, ?)`,
    );
    const insertMembership = database.database.prepare(
      `INSERT INTO profile_roots(profile_id, root_id, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const rootIds: string[] = [];
    database.database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < MAX_CATALOG_ROOTS; index += 1) {
      const id = `root_budget_${index.toString().padStart(4, "0")}`;
      const prefix = `/library/budget/${index.toString().padStart(4, "0")}-`;
      const rootPath = index === 0 ? "/library/short" : prefix + "x".repeat(3_700 - prefix.length);
      rootIds.push(id);
      insertRoot.run(id, rootPath, timestamp, timestamp);
      insertMembership.run(profiles[Math.floor(index / 100)]!.id, id, `Root ${index}`, timestamp, timestamp);
    }
    database.database.exec("COMMIT");
    const fieldBytes = (): number =>
      Number(
        (
          database.database
            .prepare(
              `SELECT coalesce(sum(
                 length(CAST(pr.profile_id AS BLOB)) + length(CAST(r.id AS BLOB))
                 + length(CAST(pr.label AS BLOB)) + length(CAST(r.path AS BLOB))
                 + length(CAST(r.status AS BLOB))
                 + coalesce(length(CAST(r.sentinel_path AS BLOB)), 0)
                 + coalesce(length(CAST(r.mount_identity AS BLOB)), 0)
                 + coalesce(length(CAST(r.last_scan_at AS BLOB)), 0)
                 + coalesce(length(CAST(r.last_error_code AS BLOB)), 0)
                 + coalesce(length(CAST(r.last_deep_scan_at AS BLOB)), 0)
                 + length(CAST(pr.created_at AS BLOB)) + length(CAST(pr.updated_at AS BLOB))
               ), 0) AS bytes
               FROM profile_roots pr JOIN library_roots r ON r.id = pr.root_id`,
            )
            .get() as { bytes: number }
        ).bytes,
      );
    let padding = MAX_CATALOG_ROOT_FIELD_BYTES - fieldBytes() - 2_048;
    expect(padding).toBeGreaterThan(0);
    const updateSentinel = database.database.prepare("UPDATE library_roots SET sentinel_path = ? WHERE id = ?");
    for (let index = 1; padding > 0; index += 1) {
      const length = Math.min(1_024, padding);
      updateSentinel.run("s".repeat(length), rootIds[index]!);
      padding -= length;
    }
    expect(fieldBytes()).toBe(MAX_CATALOG_ROOT_FIELD_BYTES - 2_048);

    const overflowPrefix = "/overflow/";
    const validMaximumPath = overflowPrefix + "y".repeat(4_096 - overflowPrefix.length);
    expect(() => database.updateRoot(originalProfile.id, rootIds[0]!, { path: validMaximumPath })).toThrow(
      expect.objectContaining({ code: "too_large" }),
    );
    expect(database.getRoot(originalProfile.id, rootIds[0]!)?.path).toBe("/library/short");
    expect(fieldBytes()).toBe(MAX_CATALOG_ROOT_FIELD_BYTES - 2_048);
    database.close();
  }, 20_000);

  it("truncates hostile filter suggestions in SQL while exact typed filters remain usable", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Bounded facets" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/facets" });
    const longValue = (prefix: string, book: number, index: number): string => {
      const start = `${prefix}-${book}-${index.toString().padStart(3, "0")}-`;
      return start + "x".repeat(2_000 - start.length);
    };
    const exactAuthor = longValue("author", 2, 99);
    for (let book = 0; book < 3; book += 1) {
      database.upsertCatalogFile({
        rootId: root.id,
        relativePath: `hostile-${book}.epub`,
        format: "epub",
        size: 10,
        mtimeMs: book,
        contentHash: String(book).repeat(64),
        scanToken: "facets",
        metadata: {
          ...catalogMetadata(`Hostile facets ${book}`),
          authors: Array.from({ length: 100 }, (_, index) => longValue("author", book, index)),
          subjects: Array.from({ length: 100 }, (_, index) => longValue("subject", book, index)),
          language: longValue("language", book, 0),
          publisher: longValue("publisher", book, 0),
          series: longValue("series", book, 0),
        },
      });
    }

    const preparedSql: string[] = [];
    const originalPrepare = database.database.prepare.bind(database.database);
    const prepareSpy = vi.spyOn(database.database, "prepare").mockImplementation((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });
    const filters = database.getFilters(profile.id);
    prepareSpy.mockRestore();
    const retainedBytes = Object.values(filters)
      .flat()
      .reduce(
        (total, value) => total + Buffer.byteLength(value.value) + Buffer.byteLength(value.label ?? ""),
        0,
      );
    expect(filters.authors.length).toBeGreaterThan(0);
    expect(filters.authors.length).toBeLessThan(300);
    expect(filters.subjects.length).toBeGreaterThan(0);
    expect(filters.subjects.length).toBeLessThan(300);
    expect(retainedBytes).toBeLessThanOrEqual(MAX_CATALOG_FILTER_VALUE_BYTES);
    expect(preparedSql).toHaveLength(8);
    expect(preparedSql.every((sql) => sql.includes("WHERE retained_bytes <= ?2") && sql.includes("LIMIT ?3"))).toBe(
      true,
    );
    expect(database.listBooks(profile.id, { author: exactAuthor }).total).toBe(1);
    database.close();
  }, 20_000);

  it("preflights match-index book and delivery-history ceilings before loading rows", async () => {
    const directory = await temporaryDirectory();
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Bounded match index" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/library/bounded" });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "bounded.epub",
      format: "epub",
      size: 10,
      mtimeMs: 1,
      contentHash: "e".repeat(64),
      scanToken: "bounded",
      metadata: catalogMetadata("Bounded"),
    });

    expect(() => database.getMatchIndex(profile.id, { maxEntries: 0 })).toThrow(
      expect.objectContaining({ code: "too_large" }),
    );

    const token = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    database.createDelivery("bounded-delivery", {
      profileId: profile.id,
      bookId: indexed.bookId,
      deviceKey: "opaque-device",
      status: "delivered",
      managedToken: token,
    });
    expect(() => database.getMatchIndex(profile.id, { maxEntries: 1, maxDeliveries: 0 })).toThrow(
      expect.objectContaining({ code: "too_large" }),
    );
    database.close();
  });
});

describe("path and metadata safety", () => {
  it("emits bounded structured logs without paths, credentials, serials, or book bytes", () => {
    const chunks: string[] = [];
    structuredServerLog({ write: (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; } } as Pick<NodeJS.WriteStream, "write">, "error", "catalog test", {
      databasePath: "/private/library/catalog.sqlite",
      password: "correct horse battery staple",
      serial: "device-serial",
      bookBytes: "private book content",
      port: 8080,
    });
    const record = JSON.parse(chunks.join("")) as { event: string; context: Record<string, unknown> };
    expect(record.event).toBe("catalog_test");
    expect(record.context).toMatchObject({
      databasePath: "[redacted]",
      password: "[redacted]",
      serial: "[redacted]",
      bookBytes: "[redacted]",
      port: 8080,
    });
    expect(JSON.stringify(sanitizeServerLogContext({ sourceFilename: "secret.epub" }))).not.toContain("secret.epub");
  });

  it("rejects non-absolute/outside roots and symlinks escaping an allowed source", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "allowed");
    const outside = path.join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(path.join(outside, "escape.epub"), "outside");
    await symlink(path.join(outside, "escape.epub"), path.join(allowed, "escape.epub"));
    const policy = await AllowedRootPolicy.create([allowed]);
    await expect(policy.validateConfiguredRoot("relative/path")).rejects.toMatchObject({ code: "path_not_absolute" });
    await expect(policy.validateConfiguredRoot(outside)).rejects.toMatchObject({ code: "path_not_allowed" });
    await expect(policy.resolveSource(allowed, "escape.epub")).rejects.toBeInstanceOf(RootPolicyError);
  });

  it("extracts real EPUB metadata and rejects archive traversal and expansion limits", async () => {
    const fixture = await readFile(path.resolve("tests/fixtures/epictetus.epub"));
    const extracted = extractEpubMetadata(fixture, "fallback");
    expect(extracted.title).toBeTruthy();
    expect(extracted.authors.length).toBeGreaterThan(0);
    const unsafe = zipArchive([
      { name: "META-INF/container.xml", data: `<container><rootfile full-path="../book.opf"/></container>` },
      { name: "book.opf", data: `<package><metadata><title>Unsafe</title></metadata></package>` },
    ]);
    expect(() => extractEpubMetadata(unsafe, "fallback")).toThrow(MetadataError);
    const bomb = zipArchive([{ name: "META-INF/container.xml", data: "x".repeat(2_000) }]);
    expect(() => extractEpubMetadata(bomb, "fallback", { maxArchiveUncompressedBytes: 100 })).toThrow(
      MetadataError,
    );
  });

  it("extracts bounded AZW3 EXTH metadata and rejects malformed record tables", () => {
    const fixture = minimalAzw3("Azw Title", "Azw Author");
    const extracted = extractAzw3Metadata(fixture, "fallback");
    expect(extracted.title).toBe("Azw Title");
    expect(extracted.authors).toEqual(["Azw Author"]);
    expect(extracted.identifiers).toEqual([
      "isbn:9780000000001",
      "source:household-library",
      "asin:B000SERVER",
      "asin:B0SERVER504",
    ]);
    expect(() => extractAzw3Metadata(Buffer.alloc(90), "fallback")).toThrow(MetadataError);
  });

  it("writes deterministic derived covers atomically and rebuilds after cache loss", async () => {
    const directory = await temporaryDirectory();
    const cache = new CoverCache(directory);
    await cache.initialize();
    const hash = "e".repeat(64);
    const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const key = await cache.store(hash, cover, "image/jpeg");
    expect(key).toBe(`v1-${hash}.jpg`);
    expect(await cache.has(key)).toBe(true);
    expect(await cache.read(key)).toEqual(cover);
    await rm(cache.pathForKey(key));
    expect(await cache.has(key)).toBe(false);
    await expect(cache.read(key)).rejects.toBeTruthy();
    expect(await cache.store(hash, cover, "image/jpeg")).toBe(key);
  });

  it("retains referenced and recent covers while pruning only expired unreferenced cache objects", async () => {
    const directory = await temporaryDirectory();
    const cache = new CoverCache(directory);
    await cache.initialize();
    const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const referenced = await cache.store("1".repeat(64), cover, "image/jpeg");
    const expired = await cache.store("2".repeat(64), cover, "image/jpeg");
    const recent = await cache.store("3".repeat(64), cover, "image/jpeg");
    const nowMs = Date.now();
    await utimes(cache.pathForKey(referenced), new Date(nowMs - 20_000), new Date(nowMs - 20_000));
    await utimes(cache.pathForKey(expired), new Date(nowMs - 20_000), new Date(nowMs - 20_000));

    expect(await cache.pruneUnused(new Set([referenced]), 10_000, nowMs)).toEqual({ removed: 1, retained: 2 });
    expect(await cache.read(referenced)).toEqual(cover);
    await expect(cache.read(expired)).rejects.toBeTruthy();
    expect(await cache.read(recent)).toEqual(cover);
  });

  it("prunes expired unreferenced covers at indexer startup and on a bounded interval", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    await mkdir(allowed, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Cover retention" });
    const root = database.createRoot(profile.id, { label: "Disabled history", path: allowed });
    const cache = new CoverCache(path.join(directory, "cache"));
    await cache.initialize();
    const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const referenced = await cache.store("4".repeat(64), cover, "image/jpeg");
    const expired = await cache.store("5".repeat(64), cover, "image/jpeg");
    const old = new Date(Date.now() - 10_000);
    await utimes(cache.pathForKey(referenced), old, old);
    await utimes(cache.pathForKey(expired), old, old);
    database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "retained.epub",
      format: "epub",
      size: 4,
      mtimeMs: 1,
      contentHash: "4".repeat(64),
      scanToken: "retained",
      metadata: { ...catalogMetadata("Retained"), coverKey: referenced, coverMediaType: "image/jpeg" },
    });
    database.updateRoot(profile.id, root.id, { enabled: false });
    const prune = vi.spyOn(cache, "pruneUnused");
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      {
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
        coverRetentionMs: 1,
        coverPruneIntervalMs: 10,
      },
    );

    await indexer.start();
    expect(await cache.read(referenced)).toEqual(cover);
    await expect(cache.read(expired)).rejects.toBeTruthy();
    await waitUntil(() => prune.mock.calls.length >= 2);

    await indexer.stop();
    database.close();
  });

  it("forces scanner retirement at its shutdown deadline when derived-cache work never settles", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    await mkdir(allowed, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const cache = new CoverCache(path.join(directory, "cache"));
    let pruneCalls = 0;
    vi.spyOn(cache, "pruneUnused").mockImplementation(() => {
      pruneCalls += 1;
      if (pruneCalls === 1) return Promise.resolve({ removed: 0, retained: 0 });
      return new Promise<{ removed: number; retained: number }>(() => undefined);
    });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      {
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
        coverPruneIntervalMs: 5,
        shutdownTimeoutMs: 20,
      },
    );

    await indexer.start();
    await waitUntil(() => pruneCalls >= 2);
    const retired = await Promise.race([
      indexer.stop().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(retired).toBe(true);
    database.close();
  });
});

describe("scanner and HTTP integration", () => {
  it("falls back to lstat for unknown directory-entry types without following symlinks", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "unknown-types");
    const nested = path.join(source, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "book.epub"), "book source");
    await symlink(path.join("nested", "book.epub"), path.join(source, "linked.epub"));
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Unknown directory types" });
    database.createRoot(profile.id, { label: "NAS books", path: source, watch: false });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => metadata("NAS book"),
    );
    const unknownTypeSpies = [
      vi.spyOn(Dirent.prototype, "isFile").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isDirectory").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isBlockDevice").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isCharacterDevice").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isFIFO").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isSocket").mockReturnValue(false),
      vi.spyOn(Dirent.prototype, "isSymbolicLink").mockReturnValue(false),
    ];

    try {
      try {
        await indexer.start();
      } finally {
        for (const spy of unknownTypeSpies.reverse()) spy.mockRestore();
      }
      expect(database.listBooks(profile.id).items).toEqual([
        expect.objectContaining({ title: "NAS book", sourceFilename: "book.epub", available: true }),
      ]);
      expect(database.database.prepare("SELECT relative_path FROM source_files").all()).toEqual([
        { relative_path: "nested/book.epub" },
      ]);
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("retires an in-flight scan when its final active profile or membership is disabled or deleted", async () => {
    const mutations: Array<{
      name: string;
      retainsRoot: boolean;
      apply(database: CatalogDatabase, profileId: string, rootId: string): void;
    }> = [
      {
        name: "disabled profile",
        retainsRoot: true,
        apply: (database, profileId) => { database.updateProfile(profileId, { enabled: false }); },
      },
      {
        name: "disabled membership",
        retainsRoot: true,
        apply: (database, profileId, rootId) => { database.updateRoot(profileId, rootId, { enabled: false }); },
      },
      {
        name: "deleted profile",
        retainsRoot: false,
        apply: (database, profileId) => { database.deleteProfile(profileId); },
      },
      {
        name: "deleted membership",
        retainsRoot: false,
        apply: (database, profileId, rootId) => { database.deleteRoot(profileId, rootId); },
      },
    ];

    for (const mutation of mutations) {
      const directory = await temporaryDirectory();
      const allowed = path.join(directory, "library");
      const source = path.join(allowed, mutation.name.replaceAll(" ", "-"));
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "a.epub"), "first source bytes");
      await writeFile(path.join(source, "b.epub"), "second source bytes");
      const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
      const profile = database.createProfile({ name: mutation.name });
      const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
      const events: ScannerEvent[] = [];
      let releaseFirstExtraction = (): void => undefined;
      const blockedExtraction = new Promise<void>((resolve) => { releaseFirstExtraction = resolve; });
      let markFirstExtraction = (): void => undefined;
      const firstExtraction = new Promise<void>((resolve) => { markFirstExtraction = resolve; });
      let extractionCount = 0;
      const indexer = new CatalogIndexer(
        database,
        await AllowedRootPolicy.create([allowed]),
        new CoverCache(path.join(directory, "cache")),
        (event) => events.push(event),
        {
          quietWindowMs: 60_000,
          stabilityWindowMs: 0,
          watcherHints: false,
          reconciliationIntervalMs: 60_000,
        },
        async () => {
          extractionCount += 1;
          if (extractionCount === 1) {
            markFirstExtraction();
            await blockedExtraction;
          }
          return metadata(`Book ${extractionCount}`);
        },
      );

      try {
        const starting = indexer.start();
        await firstExtraction;
        events.length = 0;
        mutation.apply(database, profile.id, root.id);
        indexer.pruneInactiveRoots();
        await starting;

        expect(extractionCount, mutation.name).toBe(1);
        expect(events, mutation.name).toEqual([]);
        expect(
          database.database.prepare("SELECT count(*) AS count FROM source_files").get(),
          mutation.name,
        ).toEqual({ count: 0 });
        expect(
          database.database.prepare("SELECT count(*) AS count FROM books").get(),
          mutation.name,
        ).toEqual({ count: 0 });
        if (mutation.retainsRoot) {
          expect(database.listRoots(profile.id)[0], mutation.name).toMatchObject({
            id: root.id,
            status: "paused",
          });
          expect(database.rootScanRequestGeneration(root.id), mutation.name).not.toBeNull();
        } else {
          expect(
            database.database.prepare("SELECT count(*) AS count FROM library_roots WHERE id = ?").get(root.id),
            mutation.name,
          ).toEqual({ count: 0 });
          expect(database.rootScanRequestGeneration(root.id), mutation.name).toBeNull();
        }

        releaseFirstExtraction();
        await Promise.resolve();
        expect(extractionCount, mutation.name).toBe(1);
        expect(events, mutation.name).toEqual([]);
      } finally {
        releaseFirstExtraction();
        await indexer.stop();
        database.close();
      }
    }
  });

  it("retires an old-path scan before a retained root configuration can be repopulated", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const oldSource = path.join(allowed, "old-path");
    const newSource = path.join(allowed, "new-path");
    await mkdir(oldSource, { recursive: true });
    await mkdir(newSource, { recursive: true });
    await writeFile(path.join(oldSource, "old.epub"), "old source bytes");
    await writeFile(path.join(newSource, "new.epub"), "new source bytes");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Retained root" });
    const root = database.createRoot(profile.id, { label: "Books", path: oldSource, watch: false });
    const events: ScannerEvent[] = [];
    let releaseOldExtraction = (): void => undefined;
    const blockedOldExtraction = new Promise<void>((resolve) => { releaseOldExtraction = resolve; });
    let markOldExtraction = (): void => undefined;
    const oldExtractionStarted = new Promise<void>((resolve) => { markOldExtraction = resolve; });
    let extractionCount = 0;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      (event) => events.push(event),
      {
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => {
        extractionCount += 1;
        if (extractionCount === 1) {
          markOldExtraction();
          await blockedOldExtraction;
        }
        return metadata(`Configuration ${extractionCount}`);
      },
    );

    try {
      const starting = indexer.start();
      await oldExtractionStarted;
      events.length = 0;

      database.updateRoot(profile.id, root.id, { path: newSource });
      indexer.pruneInactiveRoots();
      const currentScan = indexer.scanNow(root.id);
      await Promise.all([starting, currentScan]);

      expect(extractionCount).toBe(2);
      expect(database.listRoots(profile.id)[0]).toMatchObject({
        id: root.id,
        path: newSource,
      });
      expect(database.listBooks(profile.id).items).toEqual([
        expect.objectContaining({
          title: "Configuration 2",
          sourceFilename: "new.epub",
          available: true,
        }),
      ]);
      expect(database.database.prepare("SELECT relative_path FROM source_files").all()).toEqual([
        { relative_path: "new.epub" },
      ]);
      expect(events.filter((event) => event.type === "book.added")).toHaveLength(1);
      expect(events.filter((event) => event.type === "root.scan.completed")).toHaveLength(1);
      expect(database.rootScanRequestGeneration(root.id)).toBeNull();

      const settledEvents = [...events];
      releaseOldExtraction();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(extractionCount).toBe(2);
      expect(events).toEqual(settledEvents);
      expect(database.database.prepare("SELECT relative_path FROM source_files").all()).toEqual([
        { relative_path: "new.epub" },
      ]);
    } finally {
      releaseOldExtraction();
      await indexer.stop();
      database.close();
    }
  });

  it("fences an old-path scan across two service connections and preserves the replacement work", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const oldSource = path.join(allowed, "cross-process-old");
    const newSource = path.join(allowed, "cross-process-new");
    await mkdir(oldSource, { recursive: true });
    await mkdir(newSource, { recursive: true });
    await writeFile(path.join(oldSource, "old.epub"), "old cross-process bytes");
    await writeFile(path.join(newSource, "new.epub"), "new cross-process bytes");
    const filename = path.join(directory, "catalog.sqlite");
    const firstDatabase = new CatalogDatabase(filename);
    const profile = firstDatabase.createProfile({ name: "Cross-process fence" });
    const root = firstDatabase.createRootWithEffects(profile.id, {
      label: "Books",
      path: oldSource,
      watch: false,
    }).root;
    const secondDatabase = new CatalogDatabase(filename);
    const policy = await AllowedRootPolicy.create([allowed]);
    const firstEvents: ScannerEvent[] = [];
    let releaseOldExtraction = (): void => undefined;
    const blockedOldExtraction = new Promise<void>((resolve) => { releaseOldExtraction = resolve; });
    let markOldExtraction = (): void => undefined;
    const oldExtractionStarted = new Promise<void>((resolve) => { markOldExtraction = resolve; });
    const firstIndexer = new CatalogIndexer(
      firstDatabase,
      policy,
      new CoverCache(path.join(directory, "cache-first")),
      (event) => firstEvents.push(event),
      {
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => {
        markOldExtraction();
        await blockedOldExtraction;
        return metadata("Old cross-process result");
      },
    );
    const secondIndexer = new CatalogIndexer(
      secondDatabase,
      policy,
      new CoverCache(path.join(directory, "cache-second")),
      () => undefined,
      {
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => metadata("New cross-process result"),
    );

    try {
      const firstStart = firstIndexer.start();
      await oldExtractionStarted;
      firstEvents.length = 0;
      const oldGeneration = firstDatabase.rootScanRequestGeneration(root.id) as number;

      const replacement = secondDatabase.updateRootWithEffects(profile.id, root.id, { path: newSource });
      expect(replacement.scanReason).toBe("manual");
      expect(firstDatabase.rootScanRequest(root.id)).toEqual({ generation: oldGeneration + 1, reason: "manual" });
      releaseOldExtraction();
      await firstStart;

      expect(firstEvents).toEqual([]);
      expect(firstDatabase.database.prepare("SELECT count(*) AS count FROM source_files").get()).toEqual({ count: 0 });
      expect(firstDatabase.rootScanRequest(root.id)).toEqual({ generation: oldGeneration + 1, reason: "manual" });
      expect(firstDatabase.getRoot(profile.id, root.id)).toMatchObject({ path: newSource, status: "pending" });

      await secondIndexer.start();
      expect(firstDatabase.listBooks(profile.id).items).toEqual([
        expect.objectContaining({
          title: "New cross-process result",
          sourceFilename: "new.epub",
          available: true,
        }),
      ]);
      expect(firstDatabase.database.prepare("SELECT relative_path FROM source_files").all()).toEqual([
        { relative_path: "new.epub" },
      ]);
      expect(firstDatabase.rootScanRequest(root.id)).toBeNull();
    } finally {
      releaseOldExtraction();
      await Promise.all([
        firstIndexer.stop().catch(() => undefined),
        secondIndexer.stop().catch(() => undefined),
      ]);
      secondDatabase.close();
      firstDatabase.close();
    }
  });

  it("keeps a shared-root scan alive while removing disabled memberships from later events", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "shared-in-flight");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "a.epub"), "first shared source");
    await writeFile(path.join(source, "b.epub"), "second shared source");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const first = database.createProfile({ name: "First" });
    const second = database.createProfile({ name: "Second" });
    const root = database.createRoot(first.id, { label: "Shared", path: source, watch: false });
    database.createRoot(second.id, { label: "Shared", path: source, watch: false });
    const events: ScannerEvent[] = [];
    let releaseFirstExtraction = (): void => undefined;
    const blockedExtraction = new Promise<void>((resolve) => { releaseFirstExtraction = resolve; });
    let markFirstExtraction = (): void => undefined;
    const firstExtraction = new Promise<void>((resolve) => { markFirstExtraction = resolve; });
    let extractionCount = 0;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      (event) => events.push(event),
      {
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => {
        extractionCount += 1;
        if (extractionCount === 1) {
          markFirstExtraction();
          await blockedExtraction;
        }
        return metadata(`Shared ${extractionCount}`);
      },
    );

    try {
      const starting = indexer.start();
      await firstExtraction;
      events.length = 0;
      database.updateRoot(first.id, root.id, { enabled: false });
      indexer.pruneInactiveRoots();
      let settled = false;
      void starting.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseFirstExtraction();
      await starting;

      expect(extractionCount).toBe(2);
      expect(database.listBooks(first.id).total).toBe(0);
      expect(database.listBooks(second.id).total).toBe(2);
      expect(database.listScanRoots()[0]?.profileIds).toEqual([second.id]);
      expect(database.rootScanRequestGeneration(root.id)).toBeNull();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "book.added", profileId: second.id, rootId: root.id }),
        expect.objectContaining({ type: "root.scan.completed", profileId: second.id, rootId: root.id }),
      ]));
      expect(events.every((event) => event.profileId === second.id)).toBe(true);
    } finally {
      releaseFirstExtraction();
      await indexer.stop();
      database.close();
    }
  });

  it("removes a retired root from the bounded scan-slot queue without stalling later roots", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const roots: Array<{ profileId: string; rootId: string; sourcePath: string; filename: string }> = [];
    for (const name of ["one", "two", "three"]) {
      const sourcePath = path.join(allowed, name);
      const filename = `${name}.epub`;
      await mkdir(sourcePath, { recursive: true });
      await writeFile(path.join(sourcePath, filename), `${name} original bytes`);
      const profile = database.createProfile({ name });
      const root = database.createRoot(profile.id, { label: name, path: sourcePath, watch: false });
      roots.push({ profileId: profile.id, rootId: root.id, sourcePath, filename });
    }
    let blockFirstRoot = false;
    let releaseFirstRoot = (): void => undefined;
    const firstRootBlocked = new Promise<void>((resolve) => { releaseFirstRoot = resolve; });
    let markFirstRoot = (): void => undefined;
    const firstRootStarted = new Promise<void>((resolve) => { markFirstRoot = resolve; });
    const extracted: string[] = [];
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      {
        maxConcurrentScans: 1,
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async (filename) => {
        const sourceFilename = path.basename(filename);
        extracted.push(sourceFilename);
        if (blockFirstRoot && sourceFilename === "one.epub") {
          markFirstRoot();
          await firstRootBlocked;
        }
        return metadata(sourceFilename);
      },
    );

    try {
      await indexer.start();
      extracted.length = 0;
      for (const root of roots) {
        await writeFile(path.join(root.sourcePath, root.filename), `${root.filename} changed bytes with new size`);
      }
      blockFirstRoot = true;
      const firstScan = indexer.scanNow(roots[0]!.rootId);
      await firstRootStarted;
      const retiredScan = indexer.scanNow(roots[1]!.rootId);
      database.updateRoot(roots[1]!.profileId, roots[1]!.rootId, { enabled: false });
      indexer.pruneInactiveRoots();
      const laterScan = indexer.scanNow(roots[2]!.rootId);

      releaseFirstRoot();
      await Promise.all([firstScan, retiredScan, laterScan]);

      expect(extracted).toEqual(["one.epub", "three.epub"]);
      expect(database.listBooks(roots[0]!.profileId).items[0]?.title).toBe("one.epub");
      expect(database.listBooks(roots[2]!.profileId).items[0]?.title).toBe("three.epub");
      expect(database.listRoots(roots[1]!.profileId)[0]).toMatchObject({
        enabled: false,
        status: "paused",
      });
      expect(database.rootScanRequestGeneration(roots[1]!.rootId)).not.toBeNull();
    } finally {
      releaseFirstRoot();
      await indexer.stop();
      database.close();
    }
  });

  it("fails fast on a source-snapshot cache outage while preserving prior catalog rows and retrying with backoff", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "cache-outage");
    const firstPath = path.join(source, "a.epub");
    const secondPath = path.join(source, "b.epub");
    await mkdir(source, { recursive: true });
    await writeFile(firstPath, "first original bytes");
    await writeFile(secondPath, "second original bytes");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Cache outage" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const cache = new CoverCache(path.join(directory, "cache"));
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      {
        quietWindowMs: 5,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => metadata("Original"),
    );

    try {
      await indexer.start();
      const originalBooks = database.listBooks(profile.id, { limit: 20 }).items;
      const originalSources = database.database
        .prepare("SELECT relative_path, content_hash, available FROM source_files ORDER BY relative_path")
        .all();
      expect(originalBooks).toHaveLength(2);

      await writeFile(firstPath, "first changed bytes with a different size");
      await writeFile(secondPath, "second changed bytes with a different size");
      const snapshots = vi
        .spyOn(cache, "createSourceSnapshot")
        .mockRejectedValue(new Error("cache is read-only"));

      await indexer.scanNow(root.id);

      expect(snapshots).toHaveBeenCalledTimes(1);
      expect(database.listBooks(profile.id, { limit: 20 }).items).toEqual(originalBooks);
      expect(
        database.database
          .prepare("SELECT relative_path, content_hash, available FROM source_files ORDER BY relative_path")
          .all(),
      ).toEqual(originalSources);
      expect(database.listRoots(profile.id)[0]).toMatchObject({
        status: "error",
        lastErrorCode: "cache_unavailable",
      });
      expect(database.rootScanRequestGeneration(root.id)).not.toBeNull();

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(snapshots).toHaveBeenCalledTimes(1);
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("remembers a missing derived cover and repairs it when identical source bytes are rescanned", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "cover-repair");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "covered.epub"), "covered source bytes");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Cover repair" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const cache = new CoverCache(path.join(directory, "cache"));
    const storeCover = cache.store.bind(cache);
    let failFirstStore = true;
    const stores = vi.spyOn(cache, "store").mockImplementation(async (...args) => {
      if (failFirstStore) {
        failFirstStore = false;
        throw new CoverCacheError("cache_unavailable", "transient cache failure");
      }
      return storeCover(...args);
    });
    let extractionCount = 0;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      {
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => {
        extractionCount += 1;
        return metadata("Covered", true);
      },
    );

    try {
      await indexer.start();
      const book = database.listBooks(profile.id).items[0]!;
      expect(book.coverUrl).toBeNull();
      expect(
        database.database
          .prepare("SELECT cover_expected, cover_cache_key FROM books WHERE id = ?")
          .get(book.id),
      ).toEqual({ cover_expected: 1, cover_cache_key: null });
      expect(stores).toHaveBeenCalledTimes(1);
      expect(extractionCount).toBe(1);

      await indexer.scanNow(root.id);

      expect(database.listBooks(profile.id).items[0]).toMatchObject({ id: book.id });
      expect(database.listBooks(profile.id).items[0]?.coverUrl).toMatch(/^\/api\/profiles\//u);
      expect(
        database.database
          .prepare("SELECT cover_expected, cover_cache_key FROM books WHERE id = ?")
          .get(book.id),
      ).toEqual({
        cover_expected: 1,
        cover_cache_key: expect.stringMatching(/^v1-[a-f0-9]{64}\.jpg$/u),
      });
      expect(stores).toHaveBeenCalledTimes(2);
      expect(extractionCount).toBe(2);
      expect(database.rootScanRequestGeneration(root.id)).toBeNull();
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("bounds quick-fingerprint source reads independently of source size", async () => {
    let calls = 0;
    let bytes = 0;
    const reader = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        calls += 1;
        bytes += length;
        buffer.fill(position % 251, offset, offset + length);
        return { bytesRead: length };
      },
    };

    const fingerprint = await quickSourceFingerprint(
      reader,
      32 * 1024 * 1024,
      new AbortController().signal,
    );

    expect(fingerprint).toMatch(/^qf1:[a-f0-9]{64}$/u);
    expect(calls).toBeLessThanOrEqual(4);
    expect(bytes).toBeLessThanOrEqual(4 * 4_096);
  });

  it("bounds distinct watcher filename hints and falls back to unknown-dirty", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    await mkdir(allowed, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { maxWatcherDirtyPaths: 1 },
      async () => metadata(),
    );
    const internals = indexer as unknown as {
      noteWatcherDirty(rootId: string, rootRealPath: string, directory: string, filename: string): void;
      watcherDirtyPaths: Map<string, Set<string>>;
      unknownWatcherDirtyRoots: Set<string>;
    };

    internals.noteWatcherDirty("root", allowed, allowed, "first.epub");
    internals.noteWatcherDirty("root", allowed, allowed, "second.epub");

    expect(internals.watcherDirtyPaths.has("root")).toBe(false);
    expect(internals.unknownWatcherDirtyRoots.has("root")).toBe(true);
    await indexer.stop();
    database.close();
  });

  it("generation-guards and replays durable work after restart when requested during an active scan", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "queued.epub"), "fixture bytes");
    const databasePath = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(databasePath);
    const profile = database.createProfile({ name: "Queue" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let extractionCount = 0;
    let indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { quietWindowMs: 60_000, watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => {
        extractionCount += 1;
        if (extractionCount === 1) await firstBlocked;
        return metadata("Queued work");
      },
    );

    const starting = indexer.start();
    await waitUntil(() => extractionCount === 1);
    const activeGeneration = database.rootScanRequestGeneration(root.id);
    expect(activeGeneration).not.toBeNull();
    expect(indexer.requestRescan(root.id)).toBe(true);
    expect(database.rootScanRequestGeneration(root.id)).toBe((activeGeneration as number) + 1);
    releaseFirst();
    await starting;
    await indexer.stop();
    // The newer durable generation fences every late write and completion from
    // the blocked scan; only the retained request may rebuild after restart.
    expect(database.listRoots(profile.id)[0]?.successfulScanCount).toBe(0);
    expect(database.pendingRootScanIds()).toEqual([root.id]);
    database.close();

    database = new CatalogDatabase(databasePath);
    indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => {
        extractionCount += 1;
        return metadata("Queued work");
      },
    );
    await indexer.start();
    expect(database.listRoots(profile.id)[0]?.successfulScanCount).toBe(1);
    expect(database.pendingRootScanIds()).toEqual([]);
    expect(extractionCount).toBe(2);
    expect(database.listBooks(profile.id).items[0]?.title).toBe("Queued work");

    await indexer.stop();
    database.close();
  });

  it("surfaces malformed source counts without failing the healthy root scan", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "malformed.epub"), "not an epub");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Errors" });
    database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const completed: Array<Record<string, unknown> | undefined> = [];
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      (event) => { if (event.type === "root.scan.completed") completed.push(event.data); },
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => { throw new MetadataError("invalid_epub", "Malformed source"); },
    );

    await indexer.start();
    expect(database.listBooks(profile.id).total).toBe(0);
    expect(database.listRoots(profile.id)[0]).toMatchObject({
      status: "paused",
      lastErrorCode: "source_errors:1",
    });
    expect(completed).toContainEqual(expect.objectContaining({ sourceErrors: 1, files: 1 }));
    expect(database.statusCounts()).toMatchObject({ configured: 1, available: 1, errors: 1 });
    expect(database.pendingRootScanIds()).toEqual([]);

    await indexer.stop();
    database.close();
  });

  it("fails bounded entry traversal without invalidating the prior catalog generation", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "entries");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "kept.epub"), "kept source");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Entry bound" });
    const root = database.createRoot(profile.id, { label: "Entries", path: source, watch: false });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000, maxEntriesPerRoot: 1 },
      async () => metadata("Still retained"),
    );

    await indexer.start();
    const book = database.listBooks(profile.id).items[0]!;
    await writeFile(path.join(source, "unrelated.txt"), "extra entry");
    await indexer.scanNow(root.id);

    expect(database.getBook(profile.id, book.id)).toMatchObject({ id: book.id, available: true });
    expect(database.listRoots(profile.id)[0]).toMatchObject({
      status: "error",
      lastErrorCode: "scan_entry_limit",
      successfulScanCount: 1,
    });
    await indexer.stop();
    database.close();
  });

  it("fails bounded directory traversal without invalidating the prior catalog generation", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "directories");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "kept.epub"), "kept source");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Directory bound" });
    const root = database.createRoot(profile.id, { label: "Directories", path: source, watch: false });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000, maxDirectoriesPerRoot: 1 },
      async () => metadata("Still retained"),
    );

    await indexer.start();
    const book = database.listBooks(profile.id).items[0]!;
    await mkdir(path.join(source, "new-directory"));
    await indexer.scanNow(root.id);

    expect(database.getBook(profile.id, book.id)).toMatchObject({ id: book.id, available: true });
    expect(database.listRoots(profile.id)[0]).toMatchObject({
      status: "error",
      lastErrorCode: "scan_directory_limit",
      successfulScanCount: 1,
    });
    await indexer.stop();
    database.close();
  });

  it("reports watcher truncation as paused while scheduled reconciliation continues", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "watch-limit");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "book.epub"), "book source");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Watch bound" });
    database.createRoot(profile.id, { label: "Watch bound", path: source, watch: true });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      {
        quietWindowMs: 5,
        watcherHints: true,
        reconciliationIntervalMs: 20,
        maxWatchDirectories: 1,
      },
      async () => metadata("Watched"),
    );

    await indexer.start();
    expect(database.listRoots(profile.id)[0]).toMatchObject({
      status: "paused",
      lastErrorCode: "watch_directory_limit",
    });
    await waitUntil(() => (database.listRoots(profile.id)[0]?.successfulScanCount ?? 0) >= 2);
    expect(database.listBooks(profile.id).total).toBe(1);

    await indexer.stop();
    database.close();
  });

  it("quarantines a previously indexed file that disappears during hashing without failing its root", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const firstPath = path.join(source, "a.epub");
    const disappearingPath = path.join(source, "b.epub");
    await mkdir(source, { recursive: true });
    await writeFile(firstPath, "first version");
    await writeFile(disappearingPath, "second version");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Per-file failure" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let removeSecondDuringFirstParse = false;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (filename) => {
        if (removeSecondDuringFirstParse && path.basename(filename) === "a.epub") {
          removeSecondDuringFirstParse = false;
          await rm(disappearingPath);
        }
        return metadata(path.basename(filename));
      },
    );

    await indexer.start();
    const before = database.listBooks(profile.id, { limit: 20 }).items;
    const disappearingBook = before.find((book) => book.sourceFilename === "b.epub")!;
    expect(before.every((book) => book.available)).toBe(true);

    await writeFile(firstPath, "changed first version");
    removeSecondDuringFirstParse = true;
    await indexer.scanNow(root.id);

    const after = database.listBooks(profile.id, { limit: 20 }).items;
    expect(after.find((book) => book.sourceFilename === "a.epub")?.available).toBe(true);
    expect(after.find((book) => book.id === disappearingBook.id)).toMatchObject({
      id: disappearingBook.id,
      title: "b.epub",
      available: false,
    });
    expect(
      database.database
        .prepare("SELECT available, last_error_code FROM source_files WHERE root_id = ? AND relative_path = ?")
        .get(root.id, "b.epub"),
    ).toEqual({ available: 0, last_error_code: "source_unavailable" });
    expect(database.listRoots(profile.id)[0]).toMatchObject({
      status: "paused",
      lastErrorCode: "source_errors:1",
    });

    await indexer.stop();
    database.close();
  });

  it("avoids full source snapshots and cover reads for unchanged startup and reconciliation", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const sourcePath = path.join(source, "unchanged.epub");
    await mkdir(source, { recursive: true });
    await writeFile(sourcePath, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const databasePath = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(databasePath);
    const profile = database.createProfile({ name: "Low I/O" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const cache = new CoverCache(path.join(directory, "cache"));
    const snapshots = vi.spyOn(cache, "createSourceSnapshot");
    const coverReads = vi.spyOn(cache, "read");
    const coverStats = vi.spyOn(cache, "has");
    let extractionCount = 0;
    const extractor = async (): Promise<ExtractedBookMetadata> => {
      extractionCount += 1;
      return metadata("Unchanged", true);
    };
    let indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { quietWindowMs: 5, watcherHints: false, reconciliationIntervalMs: 60_000 },
      extractor,
    );

    await indexer.start();
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(extractionCount).toBe(1);
    expect(
      database.database
        .prepare("SELECT quick_fingerprint FROM source_files WHERE root_id = ?")
        .get(root.id)?.quick_fingerprint,
    ).toMatch(/^qf1:[a-f0-9]{64}$/u);
    await indexer.stop();
    database.close();

    database = new CatalogDatabase(databasePath);
    indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { quietWindowMs: 5, watcherHints: false, reconciliationIntervalMs: 15 },
      extractor,
    );
    await indexer.start();
    expect(database.listRoots(profile.id)[0]?.successfulScanCount).toBe(2);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(extractionCount).toBe(1);
    await waitUntil(() => (database.listRoots(profile.id)[0]?.successfulScanCount ?? 0) >= 3);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(extractionCount).toBe(1);
    expect(coverStats).toHaveBeenCalled();
    expect(coverReads).not.toHaveBeenCalled();

    await indexer.stop();
    database.close();
  });

  it("automatically deep-scrubs an unsampled same-stat replacement while routine passes stay bounded", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "deep-reconciliation");
    const sourcePath = path.join(source, "valid.epub");
    const replacementPath = path.join(allowed, "replacement.epub");
    const fixture = await readFile(path.resolve("tests/fixtures/epictetus.epub"));
    // ZIP readers permit a bounded trailing region after EOCD. Keep both books
    // structurally parseable while placing the changed byte outside qf1 ranges.
    const originalBytes = Buffer.concat([fixture, Buffer.alloc(32 * 1024, 0x41)]);
    const replacementBytes = Buffer.from(originalBytes);
    const mutationOffset = fixture.length + 1_024;
    replacementBytes[mutationOffset] = 0x42;
    const lastSampleStart = originalBytes.length - 4_096;
    const sampleStarts = [
      0,
      Math.floor(lastSampleStart / 3),
      Math.floor((lastSampleStart * 2) / 3),
      lastSampleStart,
    ];
    expect(sampleStarts.every((start) => mutationOffset < start || mutationOffset >= start + 4_096)).toBe(true);
    expect(extractEpubMetadata(originalBytes, "valid").title).toBeTruthy();
    expect(extractEpubMetadata(replacementBytes, "valid").title).toBeTruthy();

    const fixedTime = new Date("2026-08-29T09:00:00Z");
    await mkdir(source, { recursive: true });
    await writeFile(sourcePath, originalBytes);
    await utimes(sourcePath, fixedTime, fixedTime);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Deep reconciliation" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const cache = new CoverCache(path.join(directory, "cache"));
    const snapshots = vi.spyOn(cache, "createSourceSnapshot");
    let extractionCount = 0;
    let replacementExtractionStarted!: () => void;
    const replacementExtractionStart = new Promise<void>((resolve) => {
      replacementExtractionStarted = resolve;
    });
    let releaseReplacementExtraction!: () => void;
    const replacementExtractionBlocked = new Promise<void>((resolve) => {
      releaseReplacementExtraction = resolve;
    });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      {
        quietWindowMs: 5,
        watcherHints: false,
        reconciliationIntervalMs: 100,
        // Keep the wall-clock deadline out of this test. We backdate the
        // durable completion clock below, then let the next ordinary scan
        // reschedule the automatic deep pass deterministically.
        deepReconciliationIntervalMs: 60_000,
      },
      async (filename) => {
        extractionCount += 1;
        if (extractionCount === 2) {
          replacementExtractionStarted();
          await replacementExtractionBlocked;
        }
        return extractEpubMetadata(await readFile(filename), path.basename(filename));
      },
    );
    const enqueueDurableScan = vi.spyOn(
      indexer as unknown as {
        enqueueDurableScan(rootId: string, reason: string, forceNewGeneration?: boolean): void;
      },
      "enqueueDurableScan",
    );

    await indexer.start();
    const original = database.listBooks(profile.id).items[0]!;
    const persistedFingerprint = database.database
      .prepare("SELECT quick_fingerprint FROM source_files WHERE id = ?")
      .get(database.findSource(original.rootId, original.sourceFilename)!.id)?.quick_fingerprint;
    expect(persistedFingerprint).toMatch(/^qf1:[a-f0-9]{64}$/u);

    // Make the first automatic deep sweep due without sleeping for a full
    // period. The next ordinary reconciliation completes first, observes the
    // persisted overdue clock, and schedules the deep verification.
    const firstOverdueCompletion = new Date(Date.now() - 120_000).toISOString();
    database.database
      .prepare("UPDATE library_roots SET last_deep_scan_at = ? WHERE id = ?")
      .run(firstOverdueCompletion, root.id);
    await waitUntil(() => {
      const completion = database.listScanRoots()[0]?.lastDeepScanAt;
      return snapshots.mock.calls.length >= 2
        && completion !== null
        && completion !== firstOverdueCompletion;
    });
    expect(extractionCount).toBe(1);
    expect(database.listBooks(profile.id).items[0]?.contentHash).toBe(original.contentHash);

    // Prepare the replacement outside the configured root, restore its mtime,
    // then atomically install it so no scheduled scan observes an intermediate
    // write/utimes state.
    await writeFile(replacementPath, replacementBytes);
    await utimes(replacementPath, fixedTime, fixedTime);
    await rename(replacementPath, sourcePath);
    const replacementFingerprint = await quickSourceFingerprint({
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        replacementBytes.copy(buffer, offset, position, position + length);
        return { bytesRead: length };
      },
    }, replacementBytes.length, new AbortController().signal);
    expect(replacementFingerprint).toBe(persistedFingerprint);

    const scanCountAfterMutation = database.listRoots(profile.id)[0]!.successfulScanCount;
    await waitUntil(() => (
      database.listRoots(profile.id)[0]?.successfulScanCount ?? 0
    ) > scanCountAfterMutation);
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(extractionCount).toBe(1);
    expect(database.listBooks(profile.id).items[0]?.contentHash).toBe(original.contentHash);

    // Backdate the durable clock again. This preserves a guaranteed routine
    // qf1-only pass above while still exercising the automatic due scheduler
    // that must discover bytes outside the quick-fingerprint samples.
    database.database
      .prepare("UPDATE library_roots SET last_deep_scan_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 120_000).toISOString(), root.id);
    await replacementExtractionStart;
    const activeDeepRequest = database.rootScanRequest(root.id);
    expect(activeDeepRequest?.reason).toBe("deep-reconciliation");
    enqueueDurableScan.mockClear();
    await waitUntil(() => enqueueDurableScan.mock.calls.some(([, reason]) => reason === "reconciliation"));
    const requestAfterRoutineTick = database.rootScanRequest(root.id);
    releaseReplacementExtraction();
    expect(requestAfterRoutineTick).toEqual(activeDeepRequest);
    await waitUntil(() => database.listBooks(profile.id).items[0]?.contentHash !== original.contentHash);
    expect(database.listBooks(profile.id).items[0]).toMatchObject({ id: original.id });
    expect(extractionCount).toBe(2);
    expect(snapshots).toHaveBeenCalledTimes(3);

    await indexer.stop();
    database.close();
  });

  it("persists the deep deadline across frequent restarts and resumes an overdue durable sweep", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "restart-cadence");
    const sourcePath = path.join(source, "valid.epub");
    const replacementPath = path.join(allowed, "replacement.epub");
    const databasePath = path.join(directory, "catalog.sqlite");
    const cachePath = path.join(directory, "cache");
    const fixture = await readFile(path.resolve("tests/fixtures/epictetus.epub"));
    const originalBytes = Buffer.concat([fixture, Buffer.alloc(32 * 1024, 0x51)]);
    const replacementBytes = Buffer.from(originalBytes);
    const mutationOffset = fixture.length + 1_024;
    replacementBytes[mutationOffset] = 0x52;
    const lastSampleStart = originalBytes.length - 4_096;
    const sampleStarts = [
      0,
      Math.floor(lastSampleStart / 3),
      Math.floor((lastSampleStart * 2) / 3),
      lastSampleStart,
    ];
    expect(sampleStarts.every((start) => mutationOffset < start || mutationOffset >= start + 4_096)).toBe(true);
    expect(extractEpubMetadata(replacementBytes, "valid").title).toBeTruthy();

    const fixedTime = new Date("2026-08-29T09:30:00Z");
    await mkdir(source, { recursive: true });
    await writeFile(sourcePath, originalBytes);
    await utimes(sourcePath, fixedTime, fixedTime);

    let snapshotCount = 0;
    let extractionCount = 0;
    const makeIndexer = async (database: CatalogDatabase): Promise<CatalogIndexer> => {
      const cache = new CoverCache(cachePath);
      const createSnapshot = cache.createSourceSnapshot.bind(cache);
      vi.spyOn(cache, "createSourceSnapshot").mockImplementation(async (filename) => {
        snapshotCount += 1;
        return createSnapshot(filename);
      });
      return new CatalogIndexer(
        database,
        await AllowedRootPolicy.create([allowed]),
        cache,
        () => undefined,
        {
          quietWindowMs: 60_000,
          watcherHints: false,
          reconciliationIntervalMs: 60_000,
          deepReconciliationIntervalMs: 60_000,
        },
        async (filename) => {
          extractionCount += 1;
          return extractEpubMetadata(await readFile(filename), path.basename(filename));
        },
      );
    };

    let database = new CatalogDatabase(databasePath);
    const profile = database.createProfile({ name: "Restart cadence" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let indexer = await makeIndexer(database);
    await indexer.start();
    const original = database.listBooks(profile.id).items[0]!;
    const firstDeepCompletion = database.listScanRoots()[0]?.lastDeepScanAt;
    expect(firstDeepCompletion).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(snapshotCount).toBe(1);
    expect(extractionCount).toBe(1);
    await indexer.stop();
    database.close();

    await writeFile(replacementPath, replacementBytes);
    await utimes(replacementPath, fixedTime, fixedTime);
    await rename(replacementPath, sourcePath);
    const replacementFingerprint = await quickSourceFingerprint({
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        replacementBytes.copy(buffer, offset, position, position + length);
        return { bytesRead: length };
      },
    }, replacementBytes.length, new AbortController().signal);

    // Restarting repeatedly before the persisted deadline performs only qf1;
    // the unsampled replacement remains intentionally undiscovered for now.
    for (let restart = 0; restart < 2; restart += 1) {
      database = new CatalogDatabase(databasePath);
      expect(database.listScanRoots()[0]?.lastDeepScanAt).toBe(firstDeepCompletion);
      expect(database.findSource(root.id, "valid.epub")?.quickFingerprint).toBe(replacementFingerprint);
      indexer = await makeIndexer(database);
      await indexer.start();
      expect(database.listBooks(profile.id).items[0]?.contentHash).toBe(original.contentHash);
      expect(database.rootScanRequest(root.id)).toBeNull();
      expect(snapshotCount).toBe(1);
      expect(extractionCount).toBe(1);
      await indexer.stop();
      database.close();
    }

    // Backdate only the durable completion clock. This models elapsed wall
    // time deterministically without making the test sleep for a full period.
    database = new CatalogDatabase(databasePath);
    database.database
      .prepare("UPDATE library_roots SET last_deep_scan_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 120_000).toISOString(), root.id);
    database.close();

    // Startup itself still uses qf1. The overdue scheduler durably records the
    // deep request; stopping before its quiet window simulates another restart.
    database = new CatalogDatabase(databasePath);
    indexer = await makeIndexer(database);
    await indexer.start();
    expect(database.listBooks(profile.id).items[0]?.contentHash).toBe(original.contentHash);
    expect(snapshotCount).toBe(1);
    expect(database.rootScanRequest(root.id)?.reason).toBe("deep-reconciliation");
    await indexer.stop();
    database.close();

    // The next process consumes the retained deep generation during startup,
    // detects the unsampled replacement, and advances the persisted deadline.
    database = new CatalogDatabase(databasePath);
    indexer = await makeIndexer(database);
    await indexer.start();
    const replaced = database.listBooks(profile.id).items[0]!;
    expect(replaced.id).toBe(original.id);
    expect(replaced.contentHash).not.toBe(original.contentHash);
    expect(snapshotCount).toBe(2);
    expect(extractionCount).toBe(2);
    expect(database.rootScanRequest(root.id)).toBeNull();
    expect(database.listScanRoots()[0]?.lastDeepScanAt).not.toBe(firstDeepCompletion);

    await indexer.stop();
    database.close();
  });

  it("detects a same-size replacement with restored mtime on a real service restart", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const sourcePath = path.join(source, "same-stat.epub");
    const fixedTime = new Date("2026-08-29T10:00:00Z");
    await mkdir(source, { recursive: true });
    await writeFile(sourcePath, "alpha");
    await utimes(sourcePath, fixedTime, fixedTime);
    const databasePath = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(databasePath);
    const profile = database.createProfile({ name: "Authoritative" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let extractionCount = 0;
    const cache = new CoverCache(path.join(directory, "cache"));
    const snapshots = vi.spyOn(cache, "createSourceSnapshot");
    const extractor = async (filename: string): Promise<ExtractedBookMetadata> => {
      extractionCount += 1;
      return metadata(await readFile(filename, "utf8"));
    };
    let indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      extractor,
    );

    await indexer.start();
    const original = database.listBooks(profile.id).items[0]!;
    const originalStat = await stat(sourcePath);
    expect(original.title).toBe("alpha");
    expect(extractionCount).toBe(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
    await indexer.stop();
    database.close();

    await writeFile(sourcePath, "bravo");
    await utimes(sourcePath, fixedTime, fixedTime);
    expect((await stat(sourcePath)).mtimeMs).toBe(originalStat.mtimeMs);
    database = new CatalogDatabase(databasePath);
    indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      extractor,
    );
    await indexer.start();
    expect(database.listBooks(profile.id).items[0]).toMatchObject({
      id: original.id,
      title: "bravo",
      size: original.size,
    });
    expect(database.listBooks(profile.id).items[0]?.contentHash).not.toBe(original.contentHash);
    expect(extractionCount).toBe(2);
    expect(snapshots).toHaveBeenCalledTimes(2);

    await indexer.stop();
    database.close();
  });

  it("retains consumed watcher hints across a failed scan until recovery is acknowledged", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "hint-recovery");
    const offline = path.join(allowed, "hint-recovery-offline");
    const sourcePath = path.join(source, "book.epub");
    const fixedTime = new Date("2026-08-29T10:30:00Z");
    await mkdir(source, { recursive: true });
    await writeFile(sourcePath, "alpha");
    await utimes(sourcePath, fixedTime, fixedTime);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Hint recovery" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const cache = new CoverCache(path.join(directory, "cache"));
    const snapshots = vi.spyOn(cache, "createSourceSnapshot");
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (filename) => metadata(await readFile(filename, "utf8")),
    );
    const internals = indexer as unknown as {
      noteWatcherDirty(rootId: string, rootRealPath: string, directory: string, filename: string): void;
      watcherDirtyPaths: Map<string, Set<string>>;
      scanById(rootId: string): Promise<void>;
    };

    await indexer.start();
    internals.noteWatcherDirty(root.id, source, source, "book.epub");
    database.requestRootScan(root.id, "reconciliation");
    await writeFile(sourcePath, "bravo");
    await utimes(sourcePath, fixedTime, fixedTime);
    await rename(source, offline);
    await internals.scanById(root.id);

    expect(internals.watcherDirtyPaths.get(root.id)).toEqual(new Set(["book.epub"]));
    expect(database.pendingRootScanIds()).toContain(root.id);
    await rename(offline, source);
    await internals.scanById(root.id);

    expect(database.listBooks(profile.id).items[0]?.title).toBe("bravo");
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(internals.watcherDirtyPaths.has(root.id)).toBe(false);

    await indexer.stop();
    database.close();
  });

  it("deep-hashes a watcher-dirty same-stat replacement without deep-reading unrelated files", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "watched-same-stat");
    const changedPath = path.join(source, "changed.epub");
    const unchangedPath = path.join(source, "unchanged.epub");
    const fixedTime = new Date("2026-08-29T11:00:00Z");
    await mkdir(source, { recursive: true });
    await writeFile(changedPath, "alpha");
    await writeFile(unchangedPath, "other");
    await utimes(changedPath, fixedTime, fixedTime);
    const originalMtime = (await stat(changedPath)).mtimeMs;
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Watcher fingerprint" });
    database.createRoot(profile.id, { label: "Books", path: source, watch: true });
    const cache = new CoverCache(path.join(directory, "cache"));
    const snapshots = vi.spyOn(cache, "createSourceSnapshot");
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      cache,
      () => undefined,
      { quietWindowMs: 20, watcherHints: true, reconciliationIntervalMs: 60_000 },
      async (filename) => metadata(await readFile(filename, "utf8")),
    );

    await indexer.start();
    expect(snapshots).toHaveBeenCalledTimes(2);
    await writeFile(changedPath, "bravo");
    await utimes(changedPath, fixedTime, fixedTime);
    expect((await stat(changedPath)).mtimeMs).toBe(originalMtime);
    await waitUntil(() => database.listBooks(profile.id, { limit: 10 }).items.some(
      (book) => book.sourceFilename === "changed.epub" && book.title === "bravo",
    ));

    const postStartupSnapshots = snapshots.mock.calls.slice(2);
    expect(postStartupSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(postStartupSnapshots.every(([filename]) => filename === changedPath)).toBe(true);
    expect(database.listBooks(profile.id, { limit: 10 }).items.find(
      (book) => book.sourceFilename === "unchanged.epub",
    )?.title).toBe("other");

    await indexer.stop();
    database.close();
  });

  it("closes the first-start watcher blind window with an authoritative follow-up", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "startup-watched");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "enumerated.epub"), "enumerated");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Startup watcher" });
    const root = database.createRoot(profile.id, { label: "Startup watcher", path: source, watch: true });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let noteFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { noteFirstStarted = resolve; });
    let extractionCount = 0;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { quietWindowMs: 60_000, watcherHints: true, reconciliationIntervalMs: 60_000 },
      async (filename) => {
        extractionCount += 1;
        if (extractionCount === 1) {
          noteFirstStarted();
          await firstRelease;
        }
        return metadata(path.basename(filename));
      },
    );
    const starting = indexer.start();

    try {
      await firstStarted;
      // Enumeration already completed, but no watcher can be installed until
      // the blocked metadata pass finishes. This creation is therefore in the
      // exact startup blind window and cannot generate a watcher event.
      await writeFile(path.join(source, "created-in-startup-gap.epub"), "late startup book");
      releaseFirst();
      await starting;

      expect(database.listBooks(profile.id, { limit: 20 }).items.map((book) => book.sourceFilename).sort()).toEqual([
        "created-in-startup-gap.epub",
        "enumerated.epub",
      ]);
      expect(database.listRoots(profile.id)[0]).toMatchObject({
        id: root.id,
        status: "watching",
        successfulScanCount: 2,
      });
    } finally {
      releaseFirst();
      await starting.catch(() => undefined);
      await indexer.stop();
      database.close();
    }
  });

  it("keeps the old watcher live until a long scan installs its replacement", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "watched");
    const existingPath = path.join(source, "existing.epub");
    await mkdir(source, { recursive: true });
    await writeFile(existingPath, "existing");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Watcher gap" });
    const root = database.createRoot(profile.id, { label: "Watched", path: source, watch: true });
    let extractionCount = 0;
    let blockRecovery = false;
    let releaseRecovery!: () => void;
    let noteRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { noteRecoveryStarted = resolve; });
    const recoveryRelease = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { quietWindowMs: 10, watcherHints: true, reconciliationIntervalMs: 60_000 },
      async (filename) => {
        extractionCount += 1;
        if (blockRecovery && path.basename(filename) === "existing.epub") {
          noteRecoveryStarted();
          await recoveryRelease;
        }
        return metadata(path.basename(filename));
      },
    );

    await indexer.start();
    expect(database.listRoots(profile.id)[0]?.status).toBe("watching");
    blockRecovery = true;
    await writeFile(existingPath, "changed existing");
    const scanning = indexer.scanNow(root.id);
    await recoveryStarted;
    await writeFile(path.join(source, "created-during-scan.epub"), "new book");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    blockRecovery = false;
    releaseRecovery();
    await scanning;
    await waitUntil(() => database.listBooks(profile.id).total === 2);

    expect(database.listBooks(profile.id, { limit: 20 }).items.map((book) => book.sourceFilename).sort()).toEqual([
      "created-during-scan.epub",
      "existing.epub",
    ]);
    await waitUntil(() => database.listRoots(profile.id)[0]?.status === "watching");
    expect(database.listRoots(profile.id)[0]?.status).toBe("watching");

    await indexer.stop();
    database.close();
  });

  it("detects the ebook container from bytes instead of trusting the filename extension", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    const fixture = await readFile(path.resolve("tests/fixtures/epictetus.epub"));
    await writeFile(path.join(source, "misnamed.azw3"), fixture);
    await writeFile(path.join(source, "still-downloading.epub.part"), fixture);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Reader" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
    );
    await indexer.start();
    expect(database.listBooks(profile.id).items).toEqual([
      expect.objectContaining({ format: "epub", sourceFilename: "misnamed.azw3" }),
    ]);
    await indexer.stop();
    database.close();
  });

  it("scans one shared root once and confirms mount loss before marking sources unavailable", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "shared");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "one.epub"), "not really epub");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const first = database.createProfile({ name: "First" });
    const second = database.createProfile({ name: "Second" });
    const root = database.createRoot(first.id, { label: "Shared", path: source, watch: false });
    database.createRoot(second.id, { label: "Shared", path: source, watch: false });
    const policy = await AllowedRootPolicy.create([allowed]);
    const cache = new CoverCache(path.join(directory, "cache"));
    let extractionCount = 0;
    const indexer = new CatalogIndexer(
      database,
      policy,
      cache,
      () => undefined,
      { reconciliationIntervalMs: 60_000, watcherHints: false },
      async () => {
        extractionCount += 1;
        return metadata("Shared once");
      },
    );
    await indexer.start();
    expect(extractionCount).toBe(1);
    expect(database.listBooks(first.id).total).toBe(1);
    expect(database.listBooks(second.id).total).toBe(1);
    const stableBookId = database.listBooks(first.id).items[0]?.id;
    await rename(path.join(source, "one.epub"), path.join(source, "renamed.epub"));
    await indexer.scanNow(root.id);
    expect(database.listBooks(first.id).items[0]).toMatchObject({
      id: stableBookId,
      sourceFilename: "renamed.epub",
      available: true,
    });
    await rename(source, `${source}-offline`);
    await indexer.scanNow(root.id);
    expect(database.listBooks(first.id).items[0]?.available).toBe(true);
    await indexer.scanNow(root.id);
    expect(database.listBooks(first.id).items[0]?.available).toBe(false);
    await rename(`${source}-offline`, source);
    await indexer.scanNow(root.id);
    expect(database.listBooks(first.id).items[0]?.available).toBe(true);
    await indexer.stop();
    database.close();
  });

  it("does not let an earlier-sorting identical copy steal the original book ID", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    const bytes = Buffer.from("identical test book bytes");
    await writeFile(path.join(source, "z.epub"), bytes);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Stable duplicates" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (filename) => metadata(path.basename(filename)),
    );
    await indexer.start();
    const original = database.listBooks(profile.id).items[0]!;
    expect(original.sourceFilename).toBe("z.epub");

    await writeFile(path.join(source, "a.epub"), bytes);
    await indexer.scanNow(root.id);

    const books = database.listBooks(profile.id, { sort: "title", order: "asc", limit: 10 }).items;
    expect(books).toHaveLength(2);
    expect(books.find((book) => book.sourceFilename === "z.epub")?.id).toBe(original.id);
    expect(books.find((book) => book.sourceFilename === "a.epub")?.id).not.toBe(original.id);
    await indexer.stop();
    database.close();
  });

  it("serves a profile-scoped hardened API, set queries, source bytes, deliveries, and match tokens", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "fixture.epub"), await readFile(path.resolve("tests/fixtures/epictetus.epub")));
    const service = await createCatalogService({
      databasePath: path.join(directory, "catalog.sqlite"),
      cacheDirectory: path.join(directory, "cache"),
      allowedRootPaths: [allowed],
      http: {
        hostname: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        requireOriginForMutations: true,
        maxMatchIndexEntries: 1,
      },
      scanner: { quietWindowMs: 5, reconciliationIntervalMs: 60_000, watcherHints: false },
    });
    services.push(service);
    const bufferedResponseSpy = vi.spyOn(
      service.http as unknown as {
        acquireBufferedResponse(response: ServerResponse): Promise<() => void>;
      },
      "acquireBufferedResponse",
    );
    const address = await service.start();
    const base = `http://127.0.0.1:${address.port}`;
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(200);
    expect(status.headers.get("permissions-policy")).toBe("usb=(self)");
    expect(status.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    expect((await status.json()).settingsMode).toBe("read-write");
    const missingOrigin = await fetch(`${base}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blocked" }),
    });
    expect(missingOrigin.status).toBe(403);
    const missingProfileKey = await fetch(`${base}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ name: "Direct profile" }),
    });
    expect(missingProfileKey.status).toBe(400);
    const directProfileRequest = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        "Idempotency-Key": "direct-profile-1",
      },
      body: JSON.stringify({ name: "Direct profile" }),
    } as const;
    const directProfile = await fetch(`${base}/api/profiles`, directProfileRequest);
    expect(directProfile.status).toBe(201);
    const directProfileBody = (await directProfile.json()) as { id: string };
    const directProfileReplay = await fetch(`${base}/api/profiles`, directProfileRequest);
    expect(directProfileReplay.status).toBe(200);
    expect((await directProfileReplay.json()) as { id: string }).toMatchObject({ id: directProfileBody.id });
    const directProfileConflict = await fetch(`${base}/api/profiles`, {
      ...directProfileRequest,
      body: JSON.stringify({ name: "Conflicting direct profile" }),
    });
    expect(directProfileConflict.status).toBe(409);
    expect(service.database.listProfiles().filter((profile) => profile.name === "Direct profile")).toHaveLength(1);
    const configurationResponse = await fetch(`${base}/api/profiles/configuration`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        "Idempotency-Key": "settings-1",
      },
      body: JSON.stringify({ profile: { name: "Reader" }, roots: [{ label: "Books", path: source, watch: false }] }),
    });
    expect(configurationResponse.status).toBe(200);
    const configuration = (await configurationResponse.json()) as { profile: { id: string }; roots: Array<{ id: string }> };
    expect(bufferedResponseSpy).toHaveBeenCalledTimes(1);
    for (const endpoint of [
      "/api/profiles",
      "/api/roots",
      `/api/profiles/${configuration.profile.id}/roots`,
      `/api/profiles/${configuration.profile.id}/filters`,
    ]) {
      expect((await fetch(`${base}${endpoint}`)).status).toBe(200);
    }
    expect(bufferedResponseSpy).toHaveBeenCalledTimes(5);
    await waitUntil(() => service.database.listBooks(configuration.profile.id).total > 0);
    const booksResponse = await fetch(`${base}/api/profiles/${configuration.profile.id}/books`);
    const books = (await booksResponse.json()) as {
      items: Array<{ id: string; sourceFilename: string; contentHash: string }>;
      total: number;
    };
    expect(books.total).toBeGreaterThan(0);
    const book = books.items[0]!;
    expect(book.sourceFilename).toBe("fixture.epub");
    const query = await fetch(`${base}/api/profiles/${configuration.profile.id}/books/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ includeBookIds: [book.id] }),
    });
    expect(((await query.json()) as { total: number }).total).toBe(1);
    const representativeBookIds = [
      book.id,
      ...Array.from({ length: 9_999 }, (_, index) => `book_scale_${index.toString(36).padStart(8, "0")}`),
    ];
    const representativeBody = JSON.stringify({ includeBookIds: representativeBookIds });
    expect(Buffer.byteLength(representativeBody)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(representativeBody)).toBeLessThan(1024 * 1024);
    const representativeQuery = await fetch(`${base}/api/profiles/${configuration.profile.id}/books/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: representativeBody,
    });
    expect(representativeQuery.status).toBe(200);
    expect(((await representativeQuery.json()) as { total: number }).total).toBe(1);

    const excessiveBookIds = Array.from(
      { length: 20_001 },
      (_, index) => `book_excess_${index.toString(36).padStart(8, "0")}`,
    );
    const excessiveQuery = await fetch(`${base}/api/profiles/${configuration.profile.id}/books/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ includeBookIds: excessiveBookIds }),
    });
    expect(excessiveQuery.status).toBe(400);
    expect((await excessiveQuery.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_query" },
    });
    const sourceResponse = await fetch(
      `${base}/api/profiles/${configuration.profile.id}/books/${book.id}/source`,
    );
    expect(sourceResponse.status).toBe(200);
    expect(Buffer.from(await sourceResponse.arrayBuffer())).toEqual(await readFile(path.join(source, "fixture.epub")));
    const deliveryBody = {
      profileId: configuration.profile.id,
      bookId: book.id,
      deviceKey: "hashed-device",
      status: "delivered",
      filename: "managed.azw3",
      size: 123,
      objectIdentity: "opaque-object",
    };
    const rejectedDeliveryResult = await fetch(`${base}/api/deliveries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Idempotency-Key": "send-result" },
      body: JSON.stringify({ ...deliveryBody, result: { payload: "unused" } }),
    });
    expect(rejectedDeliveryResult.status).toBe(400);
    expect(
      service.database.database
        .prepare("SELECT count(*) AS count FROM deliveries WHERE idempotency_key = ?")
        .get("send-result"),
    ).toEqual({ count: 0 });
    const delivery = await fetch(`${base}/api/deliveries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Idempotency-Key": "send-1" },
      body: JSON.stringify(deliveryBody),
    });
    expect(delivery.status).toBe(201);
    const replay = await fetch(`${base}/api/deliveries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "Idempotency-Key": "send-1" },
      body: JSON.stringify(deliveryBody),
    });
    expect(replay.status).toBe(200);
    const match = (await (
      await fetch(`${base}/api/profiles/${configuration.profile.id}/match-index`)
    ).json()) as {
      metadataClaims: { complete: boolean; collisionBitmap: string };
      entries: Array<{ bookId: string; managedToken: string }>;
    };
    const expectedToken = `kb-${createHash("sha256")
      .update(`kindle-bridge-managed-file-v2\0${book.id}\0${book.contentHash}`)
      .digest("hex")
      .slice(0, 20)}`;
    expect(match.entries[0]).toMatchObject({ bookId: book.id, managedToken: expectedToken });
    expect(match.metadataClaims).toMatchObject({ complete: true });
    expect(match.metadataClaims.collisionBitmap).toHaveLength(METADATA_CLAIM_BITMAP_BASE64_LENGTH);
    service.database.upsertCatalogFile({
      rootId: configuration.roots[0]!.id,
      relativePath: "second.epub",
      format: "epub",
      size: 12,
      mtimeMs: 1,
      contentHash: "9".repeat(64),
      scanToken: "match-index-limit",
      metadata: catalogMetadata("Second book"),
    });
    const oversizedMatch = await fetch(`${base}/api/profiles/${configuration.profile.id}/match-index`);
    expect(oversizedMatch.status).toBe(413);
    expect((await oversizedMatch.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "too_large" },
    });
    expect(await requestStatus(address.port, "evil.example")).toBe(421);
    expect(await requestStatus(address.port, "evil.example@127.0.0.1")).toBe(400);
  });

  it("streams an immutable verified snapshot when the source path and open inode change before response streaming", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    const sourceRoot = path.join(allowed, "books");
    await mkdir(sourceRoot, { recursive: true });
    const sourceFilename = "Läsning-漢字-📚.epub";
    const sourcePath = path.join(sourceRoot, sourceFilename);
    const replacementPath = path.join(sourceRoot, "replacement.epub");
    const openedPath = path.join(sourceRoot, "opened.epub");
    const trustedBytes = Buffer.alloc(64 * 1024, 0x41);
    const replacementBytes = Buffer.alloc(trustedBytes.length, 0x42);
    await writeFile(sourcePath, trustedBytes);
    await writeFile(replacementPath, replacementBytes);

    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Descriptor binding" });
    const root = database.createRoot(profile.id, { label: "Books", path: sourceRoot, watch: false });
    const sourceDetails = await stat(sourcePath);
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: sourceFilename,
      format: "epub",
      size: trustedBytes.length,
      mtimeMs: sourceDetails.mtimeMs,
      contentHash: createHash("sha256").update(trustedBytes).digest("hex"),
      scanToken: "descriptor-race",
      metadata: catalogMetadata("Descriptor binding"),
    });
    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const coverCache = new CoverCache(path.join(directory, "cache"));
    await coverCache.initialize();
    const events = new CatalogEventHub();
    const indexer = new CatalogIndexer(
      database,
      rootPolicy,
      coverCache,
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => metadata(),
    );
    let substitutions = 0;
    const http = new (class extends CatalogHttpServer {
      protected override async sourceVerifiedForStreaming(): Promise<void> {
        substitutions += 1;
        await rename(sourcePath, openedPath);
        await rename(replacementPath, sourcePath);
        await writeFile(openedPath, Buffer.alloc(trustedBytes.length, 0x43));
      }
    })(database, indexer, rootPolicy, coverCache, events, {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      requireOriginForMutations: true,
      maxConcurrentSourceStreams: 1,
    });

    try {
      const address = await http.listen();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/books/${indexed.bookId}/source`,
      );
      expect(response.status).toBe(200);
      expect(substitutions).toBe(1);
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename=\"Lasning-__-_.epub\"; filename*=UTF-8''L%C3%A4sning-%E6%BC%A2%E5%AD%97-%F0%9F%93%9A.epub",
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(trustedBytes);
      expect(await readFile(sourcePath)).toEqual(replacementBytes);

      const oversizedPath = path.join(sourceRoot, "oversized.epub");
      await writeFile(oversizedPath, Buffer.alloc(0));
      await truncate(oversizedPath, DEFAULT_METADATA_LIMITS.maxBookBytes + 1);
      const oversizedDetails = await stat(oversizedPath);
      const oversized = database.upsertCatalogFile({
        rootId: root.id,
        relativePath: "oversized.epub",
        format: "epub",
        size: oversizedDetails.size,
        mtimeMs: oversizedDetails.mtimeMs,
        contentHash: "f".repeat(64),
        scanToken: "oversized-source-route",
        metadata: catalogMetadata("Oversized source"),
      });
      const oversizedResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/books/${oversized.bookId}/source`,
      );
      expect(oversizedResponse.status).toBe(413);
      expect((await oversizedResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "book_too_large" },
      });
      expect(substitutions).toBe(1);
      const changedResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/books/${indexed.bookId}/source`,
      );
      expect(changedResponse.status).toBe(409);
      expect((await changedResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "source_changed" },
      });
    } finally {
      await http.close();
      await indexer.stop();
      events.close();
      database.close();
    }
  });

  it("blocks settings mutations in read-only mode while leaving explicit rescan policy enabled", async () => {
    const directory = await temporaryDirectory();
    const allowed = path.join(directory, "library");
    await mkdir(allowed);
    const service = await createCatalogService({
      databasePath: path.join(directory, "catalog.sqlite"),
      cacheDirectory: path.join(directory, "cache"),
      allowedRootPaths: [allowed],
      http: {
        hostname: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        settingsMode: "read-only",
        requireOriginForMutations: true,
      },
      scanner: { reconciliationIntervalMs: 60_000 },
    });
    services.push(service);
    const address = await service.start();
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(response.status).toBe(403);
  });

  it("bounds JSON bodies and SSE clients", async () => {
    const hub = new CatalogEventHub(4, 1);
    const first = hub.publish({ type: "book.added", bookId: "book-1" });
    hub.publish({ type: "book.updated", bookId: "book-2" });
    const writes: string[] = [];
    const response = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
      once: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    expect(hub.attach(response, `${first.id}-outside-history`)).toBe(true);
    expect(writes.join("\n")).toContain("book-1");
    expect(writes.join("\n")).toContain("book-2");
    expect(writes.join("\n")).toContain("catalog.snapshot");
    expect(hub.attach({} as ServerResponse)).toBe(false);
    hub.close();

    const boundedHub = new CatalogEventHub(4, 1);
    const destroySlow = vi.fn();
    const slow = {
      writeHead: vi.fn(),
      write: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      once: vi.fn(),
      destroy: destroySlow,
      end: vi.fn(),
      destroyed: false,
      writableEnded: false,
    } as unknown as ServerResponse;
    expect(boundedHub.attach(slow)).toBe(true);
    boundedHub.publish({ type: "book.added", bookId: "bounded" });
    expect(destroySlow).toHaveBeenCalledOnce();
    const healthy = {
      writeHead: vi.fn(), write: vi.fn(() => true), once: vi.fn(), destroy: vi.fn(), end: vi.fn(),
      destroyed: false, writableEnded: false,
    } as unknown as ServerResponse;
    expect(boundedHub.attach(healthy)).toBe(true);
    boundedHub.close();
  });

  it("sends a refresh hint when an SSE client has no cursor", () => {
    const hub = new CatalogEventHub(4, 1);
    const writes: string[] = [];
    const response = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
      once: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      destroyed: false,
      writableEnded: false,
    } as unknown as ServerResponse;

    expect(hub.attach(response)).toBe(true);
    expect(writes.join("\n")).toContain('"type":"catalog.snapshot"');
    hub.close();
  });
});

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

interface ZipFixtureEntry {
  name: string;
  data: string;
}

function zipArchive(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalAzw3(title: string, author: string): Buffer {
  const text = Buffer.from("<html><body>Server fixture content</body></html>");
  const records = [
    { type: 503, data: Buffer.from(title) },
    { type: 100, data: Buffer.from(author) },
    { type: 104, data: Buffer.from("9780000000001") },
    { type: 112, data: Buffer.from("household-library") },
    { type: 113, data: Buffer.from("B000SERVER") },
    { type: 504, data: Buffer.from("B0SERVER504") },
    { type: 524, data: Buffer.from("en") },
  ];
  const exthLength = 12 + records.reduce((total, record) => total + 8 + record.data.length, 0);
  const recordZero = Buffer.alloc(16 + 232 + exthLength);
  recordZero.writeUInt16BE(2, 0);
  recordZero.writeUInt32BE(text.length, 4);
  recordZero.writeUInt16BE(1, 8);
  recordZero.writeUInt16BE(4096, 10);
  recordZero.write("MOBI", 16, "ascii");
  recordZero.writeUInt32BE(232, 20);
  recordZero.writeUInt32BE(2, 24);
  recordZero.writeUInt32BE(65001, 28);
  recordZero.writeUInt32BE(8, 36);
  recordZero.writeUInt32BE(0x40, 16 + 128);
  const exth = 16 + 232;
  recordZero.write("EXTH", exth, "ascii");
  recordZero.writeUInt32BE(exthLength, exth + 4);
  recordZero.writeUInt32BE(records.length, exth + 8);
  let cursor = exth + 12;
  for (const record of records) {
    recordZero.writeUInt32BE(record.type, cursor);
    recordZero.writeUInt32BE(record.data.length + 8, cursor + 4);
    record.data.copy(recordZero, cursor + 8);
    cursor += record.data.length + 8;
  }
  const header = Buffer.alloc(96);
  header.write("BOOKMOBI", 60, "ascii");
  header.writeUInt16BE(2, 76);
  header.writeUInt32BE(header.length, 78);
  header.writeUInt32BE(header.length + recordZero.length, 86);
  return Buffer.concat([header, recordZero, text]);
}

async function requestStatus(port: number, hostHeader: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/status", headers: { Host: hostHeader } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}
