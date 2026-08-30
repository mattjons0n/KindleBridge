import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const CATALOG_SCHEMA_VERSION = 13;
/** Bounded replay window for Settings/configuration mutations per profile. */
export const MAX_CONFIGURATION_WRITES_PER_PROFILE = 1_000;
/** Unreferenced stable identities retained per root after confirmed scans. */
export const MAX_UNREFERENCED_IDENTITIES_PER_ROOT = 20_000;
/** Exact raw UTF-8 budget for unreferenced stable identities in one root. */
export const MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT = 32 * 1024 * 1024;

/** Exported for deterministic migration-fixture construction in tests/tools. */
export const CATALOG_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "durable configuration and delivery history",
    sql: `
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE library_roots (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        recursive INTEGER NOT NULL DEFAULT 1 CHECK(recursive IN (0, 1)),
        watch INTEGER NOT NULL DEFAULT 1 CHECK(watch IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN (
            'pending', 'scanning', 'available', 'watching', 'unavailable',
            'permission_denied', 'paused', 'error'
          )),
        sentinel_path TEXT,
        mount_identity TEXT,
        successful_scan_count INTEGER NOT NULL DEFAULT 0 CHECK(successful_scan_count >= 0),
        empty_scan_streak INTEGER NOT NULL DEFAULT 0 CHECK(empty_scan_streak >= 0),
        last_scan_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE profile_roots (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, root_id)
      ) STRICT;

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        device_key TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('queued', 'converting', 'sending', 'delivered', 'failed')),
        artifact_hash TEXT,
        filename TEXT,
        size INTEGER,
        object_persistent_id TEXT,
        managed_token TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE configuration_writes (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX profile_roots_root_idx ON profile_roots(root_id);
      CREATE INDEX deliveries_profile_created_idx ON deliveries(profile_id, created_at DESC);
      CREATE INDEX deliveries_book_idx ON deliveries(profile_id, book_id);
    `,
  },
  {
    version: 2,
    name: "rebuildable source and book catalog",
    sql: `
      CREATE TABLE source_files (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('epub', 'azw3')),
        size INTEGER NOT NULL CHECK(size >= 0),
        mtime_ms REAL NOT NULL,
        content_hash TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0, 1)),
        scan_token TEXT NOT NULL,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(root_id, relative_path)
      ) STRICT;

      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        source_file_id TEXT NOT NULL UNIQUE REFERENCES source_files(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors_json)),
        author_sort TEXT,
        language TEXT,
        publisher TEXT,
        published_at TEXT,
        series TEXT,
        subjects_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(subjects_json)),
        identifiers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(identifiers_json)),
        metadata_complete INTEGER NOT NULL DEFAULT 0 CHECK(metadata_complete IN (0, 1)),
        cover_media_type TEXT,
        cover_cache_key TEXT,
        available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0, 1)),
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX source_files_root_scan_idx ON source_files(root_id, scan_token);
      CREATE INDEX source_files_hash_idx ON source_files(content_hash);
      CREATE INDEX books_root_available_idx ON books(root_id, available);
      CREATE INDEX books_title_idx ON books(title COLLATE NOCASE);
      CREATE INDEX books_author_idx ON books(author_sort COLLATE NOCASE);
    `,
  },
  {
    version: 3,
    name: "full text book index",
    sql: `
      CREATE VIRTUAL TABLE books_fts USING fts5(
        book_id UNINDEXED,
        title,
        authors,
        subjects,
        publisher,
        series,
        identifiers,
        source_filename,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 4,
    name: "durable scan requests",
    sql: `
      CREATE TABLE scan_requests (
        root_id TEXT PRIMARY KEY REFERENCES library_roots(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
        reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 64),
        requested_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: "persisted bounded source fingerprints",
    sql: `
      ALTER TABLE source_files ADD COLUMN quick_fingerprint TEXT;
    `,
  },
  {
    version: 6,
    name: "durable deep reconciliation cadence",
    sql: `
      ALTER TABLE library_roots ADD COLUMN last_deep_scan_at TEXT;
    `,
  },
  {
    version: 7,
    name: "recoverable derived-cover writes",
    sql: `
      ALTER TABLE books ADD COLUMN cover_expected INTEGER NOT NULL DEFAULT 0
        CHECK(cover_expected IN (0, 1));
      -- Legacy NULL keys are ambiguous: they can mean either no embedded cover
      -- or a failed cache write. Re-enrich each retained v6 row once; the next
      -- successful upsert records the definitive expected state.
      UPDATE books SET cover_expected = 1;
    `,
  },
  {
    version: 8,
    name: "stable catalog identities across rebuild",
    sql: `
      CREATE TABLE catalog_book_identities (
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        book_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(root_id, relative_path)
      ) STRICT;
      CREATE INDEX catalog_book_identities_hash_idx
        ON catalog_book_identities(root_id, content_hash, size);
      INSERT INTO catalog_book_identities(root_id, relative_path, content_hash, size, book_id, updated_at)
        SELECT b.root_id, sf.relative_path, sf.content_hash, sf.size, b.id, b.updated_at
        FROM books b JOIN source_files sf ON sf.id = b.source_file_id;
    `,
  },
  {
    version: 9,
    name: "persistent maintenance markers",
    sql: `
      CREATE TABLE catalog_maintenance_markers (
        key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 10,
    name: "unique stable catalog identity per root book",
    sql: `
      DELETE FROM catalog_book_identities
      WHERE rowid IN (
        SELECT identity_rowid FROM (
          SELECT h.rowid AS identity_rowid,
            row_number() OVER (
              PARTITION BY h.root_id, h.book_id
              ORDER BY
                CASE WHEN EXISTS (
                  SELECT 1 FROM books b
                  JOIN source_files sf ON sf.id = b.source_file_id
                  WHERE b.id = h.book_id
                    AND b.root_id = h.root_id
                    AND sf.root_id = h.root_id
                    AND sf.relative_path = h.relative_path
                ) THEN 0 ELSE 1 END,
                h.updated_at DESC,
                h.relative_path ASC
            ) AS duplicate_rank
          FROM catalog_book_identities h
        )
        WHERE duplicate_rank > 1
      );
      CREATE UNIQUE INDEX catalog_book_identities_root_book_idx
        ON catalog_book_identities(root_id, book_id);
    `,
  },
  {
    version: 11,
    name: "bounded configuration replay and delivery payload cleanup",
    sql: `
      DELETE FROM configuration_writes
      WHERE rowid IN (
        SELECT write_rowid FROM (
          SELECT rowid AS write_rowid,
            row_number() OVER (
              PARTITION BY profile_id
              ORDER BY created_at DESC, idempotency_key DESC
            ) AS retention_rank
          FROM configuration_writes
        )
        WHERE retention_rank > ${MAX_CONFIGURATION_WRITES_PER_PROFILE}
      );
      UPDATE deliveries SET result_json = NULL WHERE result_json IS NOT NULL;
    `,
  },
  {
    version: 12,
    name: "bounded stable identity retention",
    sql: `
      CREATE TABLE catalog_rebuild_pending_roots (
        root_id TEXT PRIMARY KEY REFERENCES library_roots(id) ON DELETE CASCADE,
        marked_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO catalog_rebuild_pending_roots(root_id, marked_at)
        SELECT r.id, 'legacy-rebuild-gap'
        FROM library_roots r
        WHERE EXISTS (
          SELECT 1 FROM catalog_book_identities h WHERE h.root_id = r.id
        ) AND NOT EXISTS (
          SELECT 1 FROM source_files sf WHERE sf.root_id = r.id
        );
      DELETE FROM catalog_book_identities
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
        )
        WHERE retention_rank > ${MAX_UNREFERENCED_IDENTITIES_PER_ROOT}
           OR retained_bytes > ${MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT}
      );
    `,
  },
  {
    version: 13,
    name: "monotonic durable scan fencing",
    sql: `
      ALTER TABLE scan_requests ADD COLUMN pending INTEGER NOT NULL DEFAULT 1
        CHECK(pending IN (0, 1));
    `,
  },
];

export function migrateCatalogDatabase(database: DatabaseSync): number {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const existingRow = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  const existingVersion = Number(existingRow?.version ?? 0);
  if (!Number.isInteger(existingVersion) || existingVersion < 0 || existingVersion > CATALOG_SCHEMA_VERSION) {
    throw new Error(`Catalog schema version ${existingVersion} is not supported by this image.`);
  }

  for (const migration of CATALOG_MIGRATIONS) {
    // BEGIN IMMEDIATE is the process-wide migration lock. Re-checking while
    // holding it prevents two concurrently starting containers from both
    // applying the same schema change after one waited for the other.
    database.exec("BEGIN IMMEDIATE");
    try {
      const applied = database
        .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (!applied) {
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const row = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}
