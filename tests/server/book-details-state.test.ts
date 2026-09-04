import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only book details", () => {
  it("returns source provenance and only the latest device-anonymous verified delivery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-book-details-"));
    temporaryDirectories.push(directory);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    try {
      const profile = database.createProfile({ name: "Reader" });
      const root = database.createRoot(profile.id, { label: "Read-only NAS", path: "/libraries/reader" });
      const indexed = database.upsertCatalogFile({
        rootId: root.id,
        relativePath: "series/Book.epub",
        format: "epub",
        size: 321,
        mtimeMs: 1,
        contentHash: "a".repeat(64),
        scanToken: "scan-1",
        metadata: {
          title: "Book",
          authors: ["Author"],
          authorSort: "Author",
          language: "en",
          publisher: null,
          publishedAt: null,
          series: null,
          seriesIndex: null,
          subjects: [],
          identifiers: [],
          metadataComplete: true,
          coverKey: null,
          coverMediaType: null,
        },
      });
      const token = database.getMatchIndex(profile.id).entries[0]!.managedToken;
      const older = database.createDelivery("details-old", {
        profileId: profile.id,
        bookId: indexed.bookId,
        deviceKey: "must-never-leave-details",
        status: "delivered",
        filename: "Book-old.azw3",
        size: 400,
        managedToken: "kb-00000000000000000000",
      }).record;
      const newest = database.createDelivery("details-new", {
        profileId: profile.id,
        bookId: indexed.bookId,
        deviceKey: "also-private",
        status: "delivered",
        filename: "Book-current.azw3",
        size: 420,
        managedToken: token,
      }).record;
      database.database.prepare("UPDATE deliveries SET updated_at = ? WHERE id = ?").run("2026-09-03T10:00:00.000Z", older.id);
      database.database.prepare("UPDATE deliveries SET updated_at = ? WHERE id = ?").run("2026-09-04T10:00:00.000Z", newest.id);

      const details = database.getBookDetailsState(profile.id, indexed.bookId)!;
      expect(details.source).toMatchObject({
        rootId: root.id,
        rootLabel: "Read-only NAS",
        rootPath: "/libraries/reader",
        relativePath: "series/Book.epub",
        available: true,
      });
      expect(details.latestVerifiedDelivery).toEqual({
        filename: "Book-current.azw3",
        size: 420,
        deliveredAt: "2026-09-04T10:00:00.000Z",
        currentPresentation: true,
      });
      const serialized = JSON.stringify(details);
      expect(serialized).not.toContain("deviceKey");
      expect(serialized).not.toContain("must-never-leave-details");
      expect(serialized).not.toContain("also-private");
      expect(serialized).not.toContain("Book-old.azw3");
    } finally {
      database.close();
    }
  });
});
