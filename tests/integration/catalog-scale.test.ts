import { createHash } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { MAX_MATCH_INDEX_RESPONSE_BYTES } from "../../shared/catalog-contracts.js";
import { cleanupTemporaryDirectories, makeTemporaryDirectory } from "./catalog-test-support.js";

const LARGE_CATALOG_SIZE = 10_000;

// These budgets are intentionally generous for shared/virtualized CI runners. They catch
// accidental table scans or severe regressions without turning ordinary machine variance into noise.
const LARGE_CATALOG_INGEST_BUDGET_MS = 45_000;
const LARGE_CATALOG_QUERY_BUDGET_MS = 5_000;
const LARGE_MATCH_INDEX_BUDGET_MS = 5_000;
const LARGE_CATALOG_TEST_TIMEOUT_MS = 60_000;

function managedToken(bookId: string, contentHash: string): string {
  return `kb-${createHash("sha256")
    .update(`kindle-bridge-managed-file-v2\0${bookId}\0${contentHash}`)
    .digest("hex")
    .slice(0, 20)}`;
}

const temporaryDirectories: string[] = [];
const databases = new Set<CatalogDatabase>();

afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  await cleanupTemporaryDirectories(temporaryDirectories);
});

describe("large catalog performance and deterministic paging", () => {
  it(
    "searches and filters 10,000 indexed books within the documented CI budget",
    async () => {
      const directory = await makeTemporaryDirectory(temporaryDirectories);
      const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
      databases.add(database);
      const profile = database.createProfile({ name: "Large household" });
      const root = database.createRoot(profile.id, { label: "Large shelf", path: "/libraries/large" });

      const ingestStartedAt = performance.now();
      for (let index = 0; index < LARGE_CATALOG_SIZE; index += 1) {
        const sequence = index.toString().padStart(5, "0");
        const needle = index % 100 === 0 ? " Needleterm" : "";
        const relativePath = `shelf-${index % 10}/household-book-${sequence}.epub`;
        database.upsertCatalogFile({
          rootId: root.id,
          relativePath,
          format: index % 2 === 0 ? "epub" : "azw3",
          size: 10_000 + index,
          mtimeMs: index + 1,
          contentHash: createHash("sha256").update(relativePath).digest("hex"),
          scanToken: "large-catalog-generation",
          metadata: {
            title: `Household Book ${sequence}${needle}`,
            authors: [`Author ${(index % 25).toString().padStart(2, "0")}`],
            authorSort: `Author ${(index % 25).toString().padStart(2, "0")}`,
            language: index % 3 === 0 ? "sv" : "en",
            publisher: `Publisher ${index % 8}`,
            publishedAt: `${2020 + (index % 5)}-01-01`,
            series: `Series ${index % 12}`,
            subjects: ["Catalog Scale", `Shelf ${index % 10}`],
            identifiers: [`urn:large:${sequence}`],
            metadataComplete: true,
            coverKey: null,
            coverMediaType: null,
          },
        });
      }
      const ingestElapsedMs = performance.now() - ingestStartedAt;
      expect(ingestElapsedMs, "10,000-row setup exceeded the generous shared-CI ingest budget").toBeLessThan(
        LARGE_CATALOG_INGEST_BUDGET_MS,
      );

      const queryStartedAt = performance.now();
      const search = database.listBooks(profile.id, {
        q: "needleterm",
        sort: "title",
        order: "asc",
        limit: 200,
      });
      const filtered = database.listBooks(profile.id, {
        author: "Author 07",
        year: "2022",
        format: "azw3",
        sort: "title",
        order: "asc",
        limit: 200,
      });
      const firstPage = database.listBooks(profile.id, { sort: "title", order: "asc", limit: 200, offset: 0 });
      const secondPage = database.listBooks(profile.id, {
        sort: "title",
        order: "asc",
        limit: 200,
        offset: 200,
      });
      const repeatedSecondPage = database.listBooks(profile.id, {
        sort: "title",
        order: "asc",
        limit: 200,
        offset: 200,
      });
      const queryElapsedMs = performance.now() - queryStartedAt;

      expect(search.total).toBe(100);
      expect(search.items).toHaveLength(100);
      expect(search.items.every((book) => book.title.includes("Needleterm"))).toBe(true);
      expect(filtered.total).toBe(200);
      expect(filtered.items.every((book) => book.authors[0] === "Author 07")).toBe(true);
      expect(filtered.items.every((book) => book.publishedAt?.startsWith("2022"))).toBe(true);
      expect(filtered.items.every((book) => book.format === "azw3")).toBe(true);
      expect(firstPage.total).toBe(LARGE_CATALOG_SIZE);
      expect(firstPage.items).toHaveLength(200);
      expect(secondPage.items).toHaveLength(200);
      const firstPageIds = new Set(firstPage.items.map((book) => book.id));
      expect(secondPage.items.every((book) => !firstPageIds.has(book.id))).toBe(true);
      expect(secondPage.items.map((book) => book.id)).toEqual(repeatedSecondPage.items.map((book) => book.id));
      expect(
        [...firstPage.items, ...secondPage.items].map((book) => book.title),
      ).toEqual(
        [...firstPage.items, ...secondPage.items]
          .map((book) => book.title)
          .sort((left, right) => left.localeCompare(right)),
      );
      expect(queryElapsedMs, "10,000-row query suite exceeded the generous shared-CI query budget").toBeLessThan(
        LARGE_CATALOG_QUERY_BUDGET_MS,
      );

      const books = database.database
        .prepare(
          `SELECT b.id AS book_id, sf.content_hash
           FROM books b JOIN source_files sf ON sf.id = b.source_file_id
           WHERE b.root_id = ? ORDER BY b.id`,
        )
        .all(root.id) as Array<{ book_id: string; content_hash: string }>;
      const insertDelivery = database.database.prepare(
        `INSERT INTO deliveries(
           id, idempotency_key, request_hash, profile_id, book_id, device_key, status,
           artifact_hash, filename, size, object_persistent_id, managed_token, result_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      const historyBaseTime = Date.UTC(2026, 7, 29, 12, 0, 0);
      database.database.exec("BEGIN IMMEDIATE");
      try {
        books.forEach((book, index) => {
          const sequence = index.toString().padStart(5, "0");
          const currentToken = managedToken(book.book_id, book.content_hash);
          const deliveredAt = new Date(historyBaseTime + index).toISOString();
          insertDelivery.run(
            `delivery-scale-stale-${sequence}`,
            `delivery-scale-stale-${sequence}`,
            `request-stale-${sequence}`,
            profile.id,
            book.book_id,
            `device-${index % 4}`,
            "f".repeat(64),
            `stale-${sequence}.azw3`,
            20_000 + index,
            `stale-object-${sequence}`,
            `kb-stale-${sequence}`,
            deliveredAt,
            deliveredAt,
          );
          insertDelivery.run(
            `delivery-scale-current-${sequence}`,
            `delivery-scale-current-${sequence}`,
            `request-current-${sequence}`,
            profile.id,
            book.book_id,
            `device-${index % 4}`,
            "a".repeat(64),
            `current-${sequence}.azw3`,
            30_000 + index,
            `current-object-${sequence}`,
            currentToken,
            deliveredAt,
            deliveredAt,
          );
          if (index % 100 === 0) {
            const secondDeliveredAt = new Date(historyBaseTime + LARGE_CATALOG_SIZE + index).toISOString();
            insertDelivery.run(
              `delivery-scale-second-${sequence}`,
              `delivery-scale-second-${sequence}`,
              `request-second-${sequence}`,
              profile.id,
              book.book_id,
              "device-second",
              "b".repeat(64),
              `second-${sequence}.azw3`,
              40_000 + index,
              `second-object-${sequence}`,
              currentToken,
              secondDeliveredAt,
              secondDeliveredAt,
            );
          }
        });
        database.database.exec("COMMIT");
      } catch (error) {
        database.database.exec("ROLLBACK");
        throw error;
      }

      const matchStartedAt = performance.now();
      const matchIndex = database.getMatchIndex(profile.id);
      const serializedMatchIndex = JSON.stringify(matchIndex);
      const matchElapsedMs = performance.now() - matchStartedAt;

      expect(matchIndex.entries).toHaveLength(LARGE_CATALOG_SIZE);
      expect(matchIndex.entries.map((entry) => entry.bookId)).toEqual(
        [...matchIndex.entries].map((entry) => entry.bookId).sort(),
      );
      expect(matchIndex.entries.reduce((sum, entry) => sum + entry.deliveries.length, 0)).toBe(10_100);
      expect(
        matchIndex.entries.every((entry) =>
          entry.deliveries.every((delivery) => delivery.managedToken === entry.managedToken)),
      ).toBe(true);
      expect(Buffer.byteLength(serializedMatchIndex)).toBeLessThan(MAX_MATCH_INDEX_RESPONSE_BYTES);
      expect(
        matchElapsedMs,
        "10,000-book match-index generation/serialization exceeded the generous shared-CI budget",
      ).toBeLessThan(LARGE_MATCH_INDEX_BUDGET_MS);
    },
    LARGE_CATALOG_TEST_TIMEOUT_MS,
  );
});
