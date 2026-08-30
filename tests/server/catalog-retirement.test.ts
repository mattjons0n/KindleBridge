import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import {
  MAX_UNREFERENCED_IDENTITIES_PER_ROOT,
  MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT,
} from "../../server/migrations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-retirement-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "catalog.sqlite");
}

function metadata(title: string, coverKey: string | null = null) {
  return {
    title,
    authors: ["Ada Author"],
    authorSort: "Author, Ada",
    language: "en",
    publisher: "Test Press",
    publishedAt: "2025-01-01",
    series: null,
    subjects: ["Tests"],
    identifiers: [`urn:test:${title}`],
    metadataComplete: true,
    coverKey,
    coverMediaType: coverKey === null ? null : "image/jpeg",
  };
}

function upsert(
  database: CatalogDatabase,
  rootId: string,
  relativePath: string,
  scanToken: string,
  contentByte: string,
  coverKey: string | null = null,
) {
  return database.upsertCatalogFile({
    rootId,
    relativePath,
    format: "epub",
    size: 100,
    mtimeMs: 1,
    contentHash: contentByte.length === 64 ? contentByte : contentByte.repeat(64),
    scanToken,
    metadata: metadata(relativePath, coverKey),
  });
}

function count(database: CatalogDatabase, table: string): number {
  return Number((database.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function unprotectedIdentityUsage(database: CatalogDatabase, rootId: string): { count: number; bytes: number } {
  const row = database.database
    .prepare(
      `SELECT count(*) AS count,
         coalesce(sum(
           length(CAST(h.root_id AS BLOB))
           + length(CAST(h.relative_path AS BLOB))
           + length(CAST(h.content_hash AS BLOB))
           + length(CAST(h.book_id AS BLOB))
           + length(CAST(h.updated_at AS BLOB)) + 8
         ), 0) AS bytes
       FROM catalog_book_identities h
       WHERE h.root_id = ?
         AND NOT EXISTS (SELECT 1 FROM books b WHERE b.id = h.book_id AND b.root_id = h.root_id)
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.book_id = h.book_id)`,
    )
    .get(rootId) as { count: number; bytes: number };
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

function seedUnprotectedIdentities(
  database: CatalogDatabase,
  rootId: string,
  total: number,
  options: { prefix?: string; pathPadding?: number; firstOlder?: boolean } = {},
): void {
  const prefix = options.prefix ?? "history";
  const padding = "x".repeat(options.pathPadding ?? 0);
  const insert = database.database.prepare(
    `INSERT INTO catalog_book_identities(root_id, relative_path, content_hash, size, book_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  database.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < total; index += 1) {
      const sequence = index.toString().padStart(6, "0");
      insert.run(
        rootId,
        `${prefix}-${sequence}-${padding}.epub`,
        "e".repeat(64),
        index,
        `${prefix}-book-${sequence}`,
        options.firstOlder && index === 0
          ? "2024-01-01T00:00:00.000Z"
          : "2025-01-01T00:00:00.000Z",
      );
    }
    database.database.exec("COMMIT");
  } catch (error) {
    database.database.exec("ROLLBACK");
    throw error;
  }
}

describe("confirmed-scan retirement and stable identity retention", () => {
  it("hard-retires missing rebuildable rows while preserving delivery-backed identity and reappearance evidence", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Healthy scan" });
      const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/healthy" });
      const missing = upsert(database, root.id, "Missing.epub", "scan-old", "a", "missing-cover.jpg");
      upsert(database, root.id, "Keeper.epub", "scan-current", "b", "keeper-cover.jpg");
      const managedToken = database.getMatchIndex(profile.id).entries.find(
        (entry) => entry.bookId === missing.bookId,
      )!.managedToken;
      const delivery = database.createDelivery("missing-delivery", {
        profileId: profile.id,
        bookId: missing.bookId,
        deviceKey: "kindle-device",
        status: "delivered",
        managedToken,
      }).record;

      const completion = database.completeRootScan(root.id, "scan-current", 1);
      expect(completion).toEqual({ confirmed: true, unavailableBookIds: [missing.bookId] });
      expect(count(database, "source_files")).toBe(1);
      expect(count(database, "books")).toBe(1);
      expect(count(database, "books_fts")).toBe(1);
      expect(database.database.prepare("SELECT 1 FROM books_fts WHERE book_id = ?").get(missing.bookId)).toBe(undefined);
      expect(database.database.prepare("SELECT book_id FROM catalog_book_identities WHERE book_id = ?").get(missing.bookId))
        .toEqual({ book_id: missing.bookId });
      expect(database.getDelivery(delivery.id)?.bookId).toBe(missing.bookId);
      expect(database.referencedCoverKeys()).toEqual(new Set(["keeper-cover.jpg"]));
      expect(database.getMatchIndex(profile.id).entries.map((entry) => entry.bookId)).not.toContain(missing.bookId);

      const reappeared = upsert(database, root.id, "Missing.epub", "scan-reappeared", "a", "replacement-cover.jpg");
      expect(reappeared.bookId).toBe(missing.bookId);
      expect(database.getMatchIndex(profile.id).entries.find((entry) => entry.bookId === missing.bookId)).toMatchObject({
        managedToken,
        deliveries: [{ managedToken, status: "delivered" }],
      });
    } finally {
      database.close();
    }
  });

  it("retains last-known rows on confirmed mount loss while excluding them from matching", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Mount loss" });
      const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/mount-loss" });
      const indexed = upsert(database, root.id, "Retained.epub", "scan-1", "c", "retained-cover.jpg");

      expect(database.noteRootUnavailable(root.id)).toEqual({ confirmed: false, unavailableBookIds: [] });
      expect(database.noteRootUnavailable(root.id)).toEqual({ confirmed: true, unavailableBookIds: [indexed.bookId] });
      expect(count(database, "source_files")).toBe(1);
      expect(count(database, "books")).toBe(1);
      expect(count(database, "books_fts")).toBe(1);
      expect(database.referencedCoverKeys()).toEqual(new Set(["retained-cover.jpg"]));
      expect(database.listBooks(profile.id).items[0]).toMatchObject({ id: indexed.bookId, available: false });
      expect(database.getMatchIndex(profile.id).entries).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps rebuildable catalog, FTS, and cover references bounded under successful source churn", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Churn" });
      const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/churn" });
      for (let index = 0; index < 100; index += 1) {
        const token = `scan-${index}`;
        const contentHash = index.toString(16).padStart(64, "0");
        upsert(database, root.id, `Churn-${index}.epub`, token, contentHash, `cover-${index}.jpg`);
        expect(database.completeRootScan(root.id, token, 1).confirmed).toBe(true);
      }

      expect(count(database, "source_files")).toBe(1);
      expect(count(database, "books")).toBe(1);
      expect(count(database, "books_fts")).toBe(1);
      expect(database.getMatchIndex(profile.id).entries).toHaveLength(1);
      expect(database.referencedCoverKeys()).toEqual(new Set(["cover-99.jpg"]));
      expect(count(database, "catalog_book_identities")).toBe(100);
    } finally {
      database.close();
    }
  });

  it("atomically prunes count overflow after a healthy scan with deterministic ties and protected evidence", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Identity count" });
      const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/identity-count" });
      upsert(database, root.id, "Keeper.epub", "scan-current", "a");
      const stale = upsert(database, root.id, "Delivered.epub", "scan-old", "b");
      const managedToken = database.getMatchIndex(profile.id).entries.find(
        (entry) => entry.bookId === stale.bookId,
      )!.managedToken;
      database.createDelivery("identity-protection", {
        profileId: profile.id,
        bookId: stale.bookId,
        deviceKey: "kindle-device",
        status: "delivered",
        managedToken,
      });
      seedUnprotectedIdentities(database, root.id, MAX_UNREFERENCED_IDENTITIES_PER_ROOT + 2, {
        firstOlder: true,
      });
      database.database.exec(`
        CREATE TRIGGER block_identity_prune
        BEFORE DELETE ON catalog_book_identities
        WHEN old.book_id LIKE 'history-book-%'
        BEGIN
          SELECT RAISE(ABORT, 'identity prune blocked');
        END;
      `);

      expect(() => database.completeRootScan(root.id, "scan-current", 1)).toThrow(/identity prune blocked/u);
      expect(database.database.prepare("SELECT id FROM books WHERE id = ?").get(stale.bookId)).toEqual({ id: stale.bookId });
      expect(database.database.prepare("SELECT book_id FROM books_fts WHERE book_id = ?").get(stale.bookId)).toEqual({
        book_id: stale.bookId,
      });
      expect((database.database.prepare("SELECT successful_scan_count FROM library_roots WHERE id = ?").get(root.id) as {
        successful_scan_count: number;
      }).successful_scan_count).toBe(0);

      database.database.exec("DROP TRIGGER block_identity_prune");
      expect(database.completeRootScan(root.id, "scan-current", 1).confirmed).toBe(true);
      expect(unprotectedIdentityUsage(database, root.id).count).toBe(MAX_UNREFERENCED_IDENTITIES_PER_ROOT);
      expect(database.database.prepare("SELECT 1 FROM catalog_book_identities WHERE book_id = ?").get("history-book-000000"))
        .toBe(undefined);
      expect(database.database.prepare("SELECT 1 FROM catalog_book_identities WHERE book_id = ?").get("history-book-000001"))
        .toEqual({ 1: 1 });
      expect(database.database.prepare("SELECT 1 FROM catalog_book_identities WHERE book_id = ?").get("history-book-020001"))
        .toBe(undefined);
      expect(database.database.prepare("SELECT book_id FROM catalog_book_identities WHERE book_id = ?").get(stale.bookId))
        .toEqual({ book_id: stale.bookId });
      expect(database.database.prepare("SELECT id FROM deliveries WHERE book_id = ?").get(stale.bookId)).toBeDefined();

      const reappeared = upsert(database, root.id, "Delivered.epub", "scan-reappeared", "b");
      expect(reappeared.bookId).toBe(stale.bookId);
      expect(database.getMatchIndex(profile.id).entries.find((entry) => entry.bookId === stale.bookId)?.deliveries)
        .toHaveLength(1);
    } finally {
      database.close();
    }
  }, 30_000);

  it("uses the same exact raw-byte budget for live and one-time legacy healing", async () => {
    const filename = await databasePath();
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Identity bytes" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/identity-bytes" });
    upsert(database, root.id, "Keeper.epub", "scan-current", "a");
    seedUnprotectedIdentities(database, root.id, 7_000, { prefix: "wide", pathPadding: 4_900 });
    const before = unprotectedIdentityUsage(database, root.id);
    expect(before.count).toBeLessThan(MAX_UNREFERENCED_IDENTITIES_PER_ROOT);
    expect(before.bytes).toBeGreaterThan(MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT);
    expect(database.completeRootScan(root.id, "scan-current", 1).confirmed).toBe(true);
    const liveHealed = unprotectedIdentityUsage(database, root.id);
    expect(liveHealed.count).toBeLessThan(before.count);
    expect(liveHealed.bytes).toBeLessThanOrEqual(MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT);

    database.database
      .prepare("DELETE FROM catalog_book_identities WHERE root_id = ? AND book_id LIKE 'wide-book-%'")
      .run(root.id);
    seedUnprotectedIdentities(database, root.id, 7_000, { prefix: "wide", pathPadding: 4_900 });
    expect(unprotectedIdentityUsage(database, root.id)).toEqual(before);
    database.database.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
    database.database.exec("DROP TABLE catalog_rebuild_pending_roots");
    database.close();

    database = new CatalogDatabase(filename);
    try {
      const healed = unprotectedIdentityUsage(database, root.id);
      expect(healed).toEqual(liveHealed);
      expect(database.database.prepare("SELECT 1 FROM catalog_book_identities WHERE book_id = ?").get("wide-book-000000"))
        .toEqual({ 1: 1 });
      expect(database.database.prepare("SELECT 1 FROM catalog_book_identities WHERE book_id = ?").get("wide-book-006999"))
        .toBe(undefined);
      database.close();

      database = new CatalogDatabase(filename);
      expect(unprotectedIdentityUsage(database, root.id)).toEqual(healed);
    } finally {
      database.close();
    }
  }, 30_000);

  it("protects stable identities across an explicit rebuild and restart until a confirmed scan", async () => {
    const filename = await databasePath();
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Rebuild" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/rebuild" });
    const original = upsert(database, root.id, "Rebuild.epub", "scan-before", "d");
    database.clearRebuildableCatalog();
    expect(database.database.prepare("SELECT root_id FROM catalog_rebuild_pending_roots WHERE root_id = ?").get(root.id))
      .toEqual({ root_id: root.id });
    database.close();

    database = new CatalogDatabase(filename);
    try {
      expect(database.database.prepare("SELECT book_id FROM catalog_book_identities WHERE root_id = ?").get(root.id))
        .toEqual({ book_id: original.bookId });
      const rebuilt = upsert(database, root.id, "Rebuild.epub", "scan-after", "d");
      expect(rebuilt.bookId).toBe(original.bookId);
      expect(database.completeRootScan(root.id, "scan-after", 1).confirmed).toBe(true);
      expect(database.database.prepare("SELECT root_id FROM catalog_rebuild_pending_roots WHERE root_id = ?").get(root.id))
        .toBe(undefined);
    } finally {
      database.close();
    }
  });
});
