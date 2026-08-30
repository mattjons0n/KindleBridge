import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOG_MIGRATIONS,
  CATALOG_SCHEMA_VERSION,
  migrateCatalogDatabase,
} from "../../server/migrations";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-bridge-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createVersionFixture(databasePath: string, version: number): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;`);
  for (const migration of CATALOG_MIGRATIONS.slice(0, version)) {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, "2026-08-30T00:00:00.000Z");
  }
  return database;
}

describe("catalog migrations", () => {
  it("upgrades genuine v1 through v5 schemas to the current version", async () => {
    const directory = await temporaryDirectory();
    for (let version = 1; version <= 5; version += 1) {
      const database = createVersionFixture(path.join(directory, `v${version}.sqlite`), version);
      database.prepare("INSERT INTO profiles(id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .run(`profile-${version}`, `Version ${version}`, "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z");

      expect(migrateCatalogDatabase(database)).toBe(CATALOG_SCHEMA_VERSION);
      expect(database.prepare("SELECT name FROM profiles").get()).toEqual({ name: `Version ${version}` });
      expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: CATALOG_SCHEMA_VERSION });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_book_identities'").get())
        .toEqual({ name: "catalog_book_identities" });
      database.close();
    }
  });

  it("prefers the live source while deduplicating legacy identity aliases and then enforces uniqueness", async () => {
    const databasePath = path.join(await temporaryDirectory(), "identity-aliases.sqlite");
    const database = createVersionFixture(databasePath, 9);
    database.prepare(
      `INSERT INTO library_roots(id, path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("root-identity", "/libraries/identity", "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z");
    database.prepare(
      `INSERT INTO source_files(
         id, root_id, relative_path, format, size, mtime_ms, content_hash,
         scan_token, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "source-original",
      "root-identity",
      "B.epub",
      "epub",
      12,
      1,
      "a".repeat(64),
      "scan-live",
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO books(id, root_id, source_file_id, title, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "book-original",
      "root-identity",
      "source-original",
      "Original",
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    );
    const insertIdentity = database.prepare(
      `INSERT INTO catalog_book_identities(
         root_id, relative_path, content_hash, size, book_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Deliberately make the stale alias newer: the live source path must win
    // before the new one-row-per-book invariant is installed.
    insertIdentity.run(
      "root-identity",
      "A.epub",
      "a".repeat(64),
      12,
      "book-original",
      "2026-08-30T02:00:00.000Z",
    );
    insertIdentity.run(
      "root-identity",
      "B.epub",
      "a".repeat(64),
      12,
      "book-original",
      "2026-08-30T01:00:00.000Z",
    );

    expect(migrateCatalogDatabase(database)).toBe(CATALOG_SCHEMA_VERSION);
    expect(database.prepare(
      `SELECT relative_path, book_id FROM catalog_book_identities
       WHERE root_id = ? ORDER BY relative_path`,
    ).all("root-identity")).toEqual([
      { relative_path: "B.epub", book_id: "book-original" },
    ]);
    expect(() => insertIdentity.run(
      "root-identity",
      "C.epub",
      "a".repeat(64),
      12,
      "book-original",
      "2026-08-30T03:00:00.000Z",
    )).toThrow();
    database.close();
  });

  it("upgrades retained v12 scan requests as pending monotonic fences", async () => {
    const databasePath = path.join(await temporaryDirectory(), "scan-fence.sqlite");
    const database = createVersionFixture(databasePath, 12);
    const timestamp = "2026-08-30T00:00:00.000Z";
    database.prepare(
      `INSERT INTO library_roots(id, path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("root-scan-fence", "/libraries/scan-fence", timestamp, timestamp);
    database.prepare(
      `INSERT INTO scan_requests(root_id, generation, reason, requested_at)
       VALUES (?, ?, ?, ?)`,
    ).run("root-scan-fence", 7, "manual", timestamp);

    expect(migrateCatalogDatabase(database)).toBe(CATALOG_SCHEMA_VERSION);
    expect(database.prepare(
      "SELECT generation, reason, pending FROM scan_requests WHERE root_id = ?",
    ).get("root-scan-fence")).toEqual({ generation: 7, reason: "manual", pending: 1 });
    database.close();
  });

  it("rolls back all statements and the version marker when a migration fails", async () => {
    const databasePath = path.join(await temporaryDirectory(), "rollback.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, name, applied_at) VALUES
        (1, 'v1', '2026-08-30T00:00:00.000Z'),
        (2, 'v2', '2026-08-30T00:00:00.000Z'),
        (3, 'v3', '2026-08-30T00:00:00.000Z'),
        (4, 'v4', '2026-08-30T00:00:00.000Z'),
        (5, 'v5', '2026-08-30T00:00:00.000Z'),
        (6, 'v6', '2026-08-30T00:00:00.000Z'),
        (7, 'v7', '2026-08-30T00:00:00.000Z');
      CREATE TABLE library_roots(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE source_files(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE books(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, source_file_id TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    `);

    expect(() => migrateCatalogDatabase(database)).toThrow();
    expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get()).toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_book_identities'").get())
      .toBeUndefined();
    database.close();
  });

  it("refuses a database created by a newer image before changing it", async () => {
    const databasePath = path.join(await temporaryDirectory(), "future.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, name, applied_at) VALUES (${CATALOG_SCHEMA_VERSION + 1}, 'future', '2026-08-30T00:00:00.000Z');`);
    expect(() => migrateCatalogDatabase(database)).toThrow("is not supported by this image");
    expect(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: CATALOG_SCHEMA_VERSION + 1 });
    database.close();
  });

  it("serializes concurrent process starters and records every migration once", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "concurrent.sqlite");
    const workerPath = path.join(directory, "migration-worker.mjs");
    const migrationsUrl = pathToFileURL(path.resolve("server/migrations.ts")).href;
    await writeFile(workerPath, `
      import { parentPort, workerData } from "node:worker_threads";
      import { DatabaseSync } from "node:sqlite";
      import { migrateCatalogDatabase } from ${JSON.stringify(migrationsUrl)};
      const database = new DatabaseSync(workerData.databasePath);
      database.exec("PRAGMA busy_timeout = 5000");
      try { parentPort.postMessage({ version: migrateCatalogDatabase(database) }); }
      catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
      finally { database.close(); }
    `);
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ version?: number; error?: string }>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { databasePath } });
      worker.once("message", resolve);
      worker.once("error", reject);
    })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ version: CATALOG_SCHEMA_VERSION })));

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count, count(DISTINCT version) AS distinct_count FROM schema_migrations").get())
      .toEqual({ count: CATALOG_SCHEMA_VERSION, distinct_count: CATALOG_SCHEMA_VERSION });
    database.close();
  });
});
