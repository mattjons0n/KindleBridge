import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database";
import { prepareCatalogRebuild, verifyCatalogDatabase } from "../../server/maintenance";
import { CATALOG_SCHEMA_VERSION } from "../../server/migrations";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-bridge-maintenance-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("catalog maintenance", () => {
  it("verifies integrity, foreign keys, and the supported migration version", async () => {
    const databasePath = path.join(await temporaryDirectory(), "catalog.sqlite");
    const database = new CatalogDatabase(databasePath);
    database.close();

    expect(verifyCatalogDatabase(databasePath)).toEqual({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      integrity: "ok",
    });
  });

  it("verifies a cold WAL catalog without writing sidecars to read-only storage", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "catalog.sqlite");
    const database = new CatalogDatabase(databasePath);
    database.close();
    const before = await readdir(directory);

    await chmod(databasePath, 0o444);
    await chmod(directory, 0o555);
    try {
      expect(verifyCatalogDatabase(databasePath)).toEqual({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        integrity: "ok",
      });
      expect(await readdir(directory)).toEqual(before);
    } finally {
      await chmod(directory, 0o755);
      await chmod(databasePath, 0o644);
    }
  });

  it("rejects missing, corrupt, and newer-schema databases", async () => {
    const directory = await temporaryDirectory();
    expect(() => verifyCatalogDatabase(path.join(directory, "missing.sqlite"))).toThrow("does not exist");

    const corruptPath = path.join(directory, "corrupt.sqlite");
    await writeFile(corruptPath, "not a sqlite database");
    expect(() => verifyCatalogDatabase(corruptPath)).toThrow();

    const futurePath = path.join(directory, "future.sqlite");
    const future = new DatabaseSync(futurePath);
    future.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, name, applied_at) VALUES (${CATALOG_SCHEMA_VERSION + 1}, 'future', '2026-08-30T00:00:00.000Z');`);
    future.close();
    expect(() => verifyCatalogDatabase(futurePath)).toThrow("is not supported");
  });

  it("clears only rebuildable rows while retaining configuration, identity, and delivery evidence", async () => {
    const databasePath = path.join(await temporaryDirectory(), "catalog.sqlite");
    const database = new CatalogDatabase(databasePath);
    const profile = database.createProfile({ name: "Household" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/books" });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "Ada.epub",
      format: "epub",
      size: 12,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-1",
      metadata: {
        title: "Ada",
        authors: ["Example Author"],
        authorSort: "Author, Example",
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: [],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    const managedToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    database.createDelivery("maintenance-delivery", {
      profileId: profile.id,
      bookId: indexed.bookId,
      deviceKey: "device-key",
      managedToken,
      status: "delivered",
    });
    database.close();

    expect(prepareCatalogRebuild(databasePath)).toEqual({ profiles: 1, roots: 1, deliveries: 1 });

    const reopened = new CatalogDatabase(databasePath);
    expect(reopened.listProfiles()).toHaveLength(1);
    expect(reopened.listRoots(profile.id)).toHaveLength(1);
    expect(reopened.listBooks(profile.id).total).toBe(0);
    expect(reopened.database.prepare("SELECT count(*) AS count FROM catalog_book_identities").get()!.count).toBe(1);
    expect(reopened.database.prepare("SELECT count(*) AS count FROM deliveries").get()!.count).toBe(1);
    reopened.close();
  });
});
