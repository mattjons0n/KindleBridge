import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const CATALOG_SCHEMA_VERSION = 17;
/** Bounded replay window for Settings/configuration mutations per profile. */
export const MAX_CONFIGURATION_WRITES_PER_PROFILE = 1_000;
/** Unreferenced stable identities retained per root after confirmed scans. */
export const MAX_UNREFERENCED_IDENTITIES_PER_ROOT = 20_000;
/** Exact raw UTF-8 budget for unreferenced stable identities in one root. */
export const MAX_UNREFERENCED_IDENTITY_BYTES_PER_ROOT = 32 * 1024 * 1024;
/** Bounded replay window for queue-add and shelf-create operations. */
export const MAX_DURABLE_MUTATION_REPLAYS_PER_PROFILE = 1_000;

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
  {
    version: 14,
    name: "durable non-destructive metadata and cover overlays",
    sql: `
      ALTER TABLE books ADD COLUMN series_index REAL;
      ALTER TABLE books ADD COLUMN description TEXT;
      ALTER TABLE books ADD COLUMN presentation_version TEXT;
      ALTER TABLE books ADD COLUMN cover_storage TEXT NOT NULL DEFAULT 'cache'
        CHECK(cover_storage IN ('cache', 'override'));
      ALTER TABLE books ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0
        CHECK(metadata_revision >= 0);
      ALTER TABLE books ADD COLUMN metadata_edited INTEGER NOT NULL DEFAULT 0
        CHECK(metadata_edited IN (0, 1));
      ALTER TABLE books ADD COLUMN cover_edited INTEGER NOT NULL DEFAULT 0
        CHECK(cover_edited IN (0, 1));
      UPDATE books
        SET presentation_version = coalesce(
          (SELECT sf.content_hash FROM source_files sf WHERE sf.id = books.source_file_id),
          ''
        );

      -- This table is rebuildable source evidence. It exists separately so a
      -- scan can refresh the file-derived values without overwriting a user's
      -- durable overlay or losing the values needed by Reset.
      CREATE TABLE book_source_metadata (
        book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors_json)),
        author_sort TEXT,
        language TEXT,
        publisher TEXT,
        published_at TEXT,
        series TEXT,
        series_index REAL,
        description TEXT,
        subjects_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(subjects_json)),
        identifiers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(identifiers_json)),
        metadata_complete INTEGER NOT NULL DEFAULT 0 CHECK(metadata_complete IN (0, 1)),
        cover_media_type TEXT,
        cover_cache_key TEXT,
        cover_expected INTEGER NOT NULL DEFAULT 0 CHECK(cover_expected IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO book_source_metadata(
        book_id, title, authors_json, author_sort, language, publisher, published_at,
        series, series_index, description, subjects_json, identifiers_json,
        metadata_complete, cover_media_type, cover_cache_key, cover_expected, updated_at
      )
      SELECT b.id, b.title, b.authors_json, b.author_sort, b.language, b.publisher, b.published_at,
        b.series, b.series_index, b.description, b.subjects_json, b.identifiers_json,
        b.metadata_complete, b.cover_media_type, b.cover_cache_key, b.cover_expected, b.updated_at
      FROM books b;

      -- No foreign key to the rebuildable books table: stable book IDs and
      -- their edits intentionally survive an explicit catalog rebuild.
      CREATE TABLE book_metadata_overrides (
        book_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        source_content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        title_set INTEGER NOT NULL DEFAULT 0 CHECK(title_set IN (0, 1)),
        title TEXT,
        authors_set INTEGER NOT NULL DEFAULT 0 CHECK(authors_set IN (0, 1)),
        authors_json TEXT CHECK(authors_json IS NULL OR json_valid(authors_json)),
        author_sort_set INTEGER NOT NULL DEFAULT 0 CHECK(author_sort_set IN (0, 1)),
        author_sort TEXT,
        language_set INTEGER NOT NULL DEFAULT 0 CHECK(language_set IN (0, 1)),
        language TEXT,
        publisher_set INTEGER NOT NULL DEFAULT 0 CHECK(publisher_set IN (0, 1)),
        publisher TEXT,
        published_at_set INTEGER NOT NULL DEFAULT 0 CHECK(published_at_set IN (0, 1)),
        published_at TEXT,
        series_set INTEGER NOT NULL DEFAULT 0 CHECK(series_set IN (0, 1)),
        series TEXT,
        series_index_set INTEGER NOT NULL DEFAULT 0 CHECK(series_index_set IN (0, 1)),
        series_index REAL,
        description_set INTEGER NOT NULL DEFAULT 0 CHECK(description_set IN (0, 1)),
        description TEXT,
        subjects_set INTEGER NOT NULL DEFAULT 0 CHECK(subjects_set IN (0, 1)),
        subjects_json TEXT CHECK(subjects_json IS NULL OR json_valid(subjects_json)),
        identifiers_set INTEGER NOT NULL DEFAULT 0 CHECK(identifiers_set IN (0, 1)),
        identifiers_json TEXT CHECK(identifiers_json IS NULL OR json_valid(identifiers_json)),
        cover_asset_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE metadata_cover_assets (
        asset_key TEXT PRIMARY KEY,
        checksum TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL CHECK(media_type IN ('image/jpeg', 'image/png', 'image/webp')),
        byte_length INTEGER NOT NULL CHECK(byte_length > 0),
        width INTEGER NOT NULL CHECK(width > 0),
        height INTEGER NOT NULL CHECK(height > 0),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('upload', 'provider')),
        provider TEXT CHECK(provider IS NULL OR provider IN ('google-books', 'open-library')),
        provider_reference TEXT,
        source_url TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX book_metadata_overrides_hash_idx
        ON book_metadata_overrides(source_content_hash);
      CREATE INDEX book_metadata_overrides_cover_idx
        ON book_metadata_overrides(cover_asset_key);

      DROP TABLE books_fts;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        book_id UNINDEXED,
        title,
        authors,
        subjects,
        publisher,
        series,
        identifiers,
        description,
        source_filename,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO books_fts(
        book_id, title, authors, subjects, publisher, series, identifiers, description, source_filename
      )
      SELECT b.id, b.title,
        replace(replace(b.authors_json, '[', ' '), ']', ' '),
        replace(replace(b.subjects_json, '[', ' '), ']', ' '),
        coalesce(b.publisher, ''), coalesce(b.series, ''),
        replace(replace(b.identifiers_json, '[', ' '), ']', ' '),
        coalesce(b.description, ''), sf.relative_path
      FROM books b JOIN source_files sf ON sf.id = b.source_file_id;
    `,
  },
  {
    version: 15,
    name: "durable cover provider credentials",
    sql: `
      CREATE TABLE cover_provider_credentials (
        provider TEXT PRIMARY KEY CHECK(provider IN ('google-books')),
        api_key TEXT,
        configuration_state TEXT NOT NULL DEFAULT 'never-configured' CHECK(
          configuration_state IN ('never-configured', 'configured', 'removed')
        ),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        last_tested_at TEXT,
        last_test_status TEXT CHECK(last_test_status IS NULL OR last_test_status IN ('working', 'error')),
        last_test_error_code TEXT CHECK(
          last_test_error_code IS NULL OR last_test_error_code IN (
            'invalid-or-restricted-key', 'quota-exhausted', 'timeout', 'provider-unavailable'
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (configuration_state = 'configured' AND api_key IS NOT NULL)
          OR (
            configuration_state IN ('never-configured', 'removed')
            AND api_key IS NULL AND last_tested_at IS NULL
            AND last_test_status IS NULL AND last_test_error_code IS NULL
          )
        )
      ) STRICT;
    `,
  },
  {
    version: 16,
    name: "profile send queue, smart shelves, and personal annotations",
    sql: `
      CREATE TABLE send_queue_state (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      -- No books foreign key: user intent must survive a rebuild, a missing
      -- mount, and retirement of a rebuildable source row.
      CREATE TABLE send_queue_entries (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank >= 0),
        queued_content_hash TEXT NOT NULL,
        queued_presentation_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, book_id)
      ) STRICT;
      CREATE INDEX send_queue_rank_idx
        ON send_queue_entries(profile_id, rank, created_at, book_id);

      CREATE TABLE smart_shelves (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
        query_version INTEGER NOT NULL CHECK(query_version = 1),
        query_json TEXT NOT NULL CHECK(
          json_valid(query_json)
          AND json_extract(query_json, '$.version') = query_version
          AND length(CAST(query_json AS BLOB)) <= 8192
        ),
        pinned_rank INTEGER CHECK(pinned_rank IS NULL OR pinned_rank >= 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX smart_shelves_profile_name_idx
        ON smart_shelves(profile_id, name COLLATE NOCASE);
      CREATE INDEX smart_shelves_profile_pin_idx
        ON smart_shelves(profile_id, pinned_rank, name, id);

      -- Like queue entries, annotations intentionally reference stable opaque
      -- book identity rather than rebuildable book rows.
      CREATE TABLE profile_book_annotations (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
        want_to_read INTEGER NOT NULL DEFAULT 0 CHECK(want_to_read IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, book_id)
      ) STRICT;
      CREATE INDEX profile_book_annotations_favorite_idx
        ON profile_book_annotations(profile_id, favorite, book_id);
      CREATE INDEX profile_book_annotations_want_idx
        ON profile_book_annotations(profile_id, want_to_read, book_id);

      CREATE TABLE durable_mutation_replays (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK(operation IN ('send-queue-add', 'smart-shelf-create')),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        resource_id TEXT,
        result_revision INTEGER NOT NULL CHECK(result_revision >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, operation, idempotency_key)
      ) STRICT;
      CREATE INDEX durable_mutation_replays_retention_idx
        ON durable_mutation_replays(profile_id, created_at DESC, idempotency_key DESC);
    `,
  },
  {
    version: 17,
    name: "catalog health issue dispositions",
    sql: `
      -- Issue rows are derived from the current catalog. Only bounded user
      -- disposition and retry state is durable, and it deliberately survives
      -- rebuildable book/source rows disappearing.
      CREATE TABLE catalog_issue_dispositions (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        issue_signature TEXT NOT NULL CHECK(
          length(issue_signature) = 22 AND issue_signature GLOB 'issue-[0-9a-f]*'
        ),
        issue_type TEXT NOT NULL CHECK(issue_type IN (
          'missing-cover', 'incomplete-metadata', 'metadata-parser-failure',
          'low-confidence-provider-data', 'unavailable-source', 'suspected-duplicate'
        )),
        ignored INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0, 1)),
        preferred_book_id TEXT CHECK(
          preferred_book_id IS NULL OR (length(preferred_book_id) BETWEEN 6 AND 100)
        ),
        revision INTEGER NOT NULL CHECK(revision > 0),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
        last_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, issue_signature)
      ) STRICT;
      CREATE INDEX catalog_issue_dispositions_profile_updated_idx
        ON catalog_issue_dispositions(profile_id, updated_at DESC, issue_signature);

      CREATE TABLE cover_provider_mutation_replays (
        provider TEXT NOT NULL CHECK(provider IN ('google-books')),
        operation TEXT NOT NULL CHECK(operation IN ('save', 'remove')),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK(result_revision > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY(provider, operation, idempotency_key)
      ) STRICT;
      CREATE INDEX cover_provider_mutation_replays_retention_idx
        ON cover_provider_mutation_replays(provider, created_at DESC, idempotency_key DESC);

      CREATE TABLE metadata_lookup_jobs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('google-books', 'open-library')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'paused', 'completed', 'cancelled')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX metadata_lookup_jobs_profile_updated_idx
        ON metadata_lookup_jobs(profile_id, updated_at DESC, id);

      -- Book IDs are intentionally stable opaque identities without a foreign
      -- key to the rebuildable catalog. A missing source becomes a bounded
      -- per-entry failure, while already reviewed results survive restarts.
      CREATE TABLE metadata_lookup_entries (
        job_id TEXT NOT NULL REFERENCES metadata_lookup_jobs(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank >= 0),
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'searching', 'ready', 'no-results', 'failed', 'cancelled'
        )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        candidates_json TEXT NOT NULL DEFAULT '[]' CHECK(
          json_valid(candidates_json) AND json_type(candidates_json) = 'array'
          AND length(CAST(candidates_json AS BLOB)) <= 2097152
        ),
        error_code TEXT CHECK(error_code IS NULL OR error_code IN (
          'book-unavailable', 'provider-unavailable', 'provider-not-configured',
          'provider-response-too-large', 'invalid-provider-response'
        )),
        accepted_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, book_id),
        UNIQUE(job_id, rank)
      ) STRICT;
      CREATE INDEX metadata_lookup_entries_status_idx
        ON metadata_lookup_entries(job_id, status, rank, book_id);

      CREATE TABLE metadata_lookup_job_replays (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES metadata_lookup_jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, idempotency_key)
      ) STRICT;
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
