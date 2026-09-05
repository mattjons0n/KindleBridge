import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase, CatalogDatabaseError } from "../../server/catalog-database.js";
import { MAX_PROFILE_BOOK_ANNOTATIONS_PER_PROFILE } from "../../shared/catalog-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databaseFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-durable-state-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "catalog.sqlite");
  const database = new CatalogDatabase(filename);
  const profile = database.createProfile({ name: "Reader" });
  const root = database.createRoot(profile.id, { label: "Books", path: `/libraries/${profile.id}` });
  return { database, filename, profile, root };
}

function addBook(
  database: CatalogDatabase,
  rootId: string,
  name: string,
  options: { hash?: string; series?: string | null; seriesIndex?: number | null } = {},
) {
  return database.upsertCatalogFile({
    rootId,
    relativePath: `${name}.epub`,
    format: "epub",
    size: 100 + name.length,
    mtimeMs: 1,
    contentHash: options.hash ?? name.padEnd(64, "0").slice(0, 64),
    scanToken: "scan-1",
    metadata: {
      title: name,
      authors: ["Author"],
      authorSort: "Author",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: options.series ?? null,
      seriesIndex: options.seriesIndex ?? null,
      subjects: [],
      identifiers: [],
      metadataComplete: true,
      coverKey: null,
      coverMediaType: null,
    },
  });
}

describe("profile-scoped durable library state", () => {
  it("persists completed-book membership and setup dismissal without altering other annotations", async () => {
    const fixture = await databaseFixture();
    let database = fixture.database;
    const book = addBook(database, fixture.root.id, "finished");
    const other = database.createProfile({ name: "Other reader" });
    database.database.prepare("UPDATE onboarding_state SET dismissed = 1 WHERE id = 1").run();
    const first = database.updateProfileBookAnnotation(fixture.profile.id, book.bookId, { expectedRevision: 0, readBook: true });
    expect(first.annotation.readBook).toBe(true);
    const favorite = database.updateProfileBookAnnotation(fixture.profile.id, book.bookId, { expectedRevision: 1, favorite: true });
    expect(favorite.annotation.readBook).toBe(true);
    expect(database.listBooks(fixture.profile.id, { readBook: true }).total).toBe(1);
    expect(database.listBooks(other.id, { readBook: true }).total).toBe(0);
    database.close();
    database = new CatalogDatabase(fixture.filename);
    try {
      expect(database.database.prepare("SELECT dismissed FROM onboarding_state").get()?.dismissed).toBe(1);
      expect(database.getProfileBookAnnotation(fixture.profile.id, book.bookId)).toMatchObject({ readBook: true, favorite: true });
      expect(database.listBooks(fixture.profile.id, { readBook: true }).items[0]?.id).toBe(book.bookId);
    } finally { database.close(); }
  });
  it("retains every schema-v17 intent record across restarts and a rebuildable catalog loss", async () => {
    const fixture = await databaseFixture();
    let database = fixture.database;
    const alpha = addBook(database, fixture.root.id, "alpha", { hash: "a".repeat(64) });
    const bravo = addBook(database, fixture.root.id, "bravo", { hash: "a".repeat(64) });
    database.initializeCoverProviderCredentials();
    database.setCoverProviderCredential("google-books", "durable-provider-key", 0, "durable-provider-save");
    const asset = {
      assetKey: `${"c".repeat(64)}.png`,
      checksum: "c".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 68,
      width: 1,
      height: 1,
      sourceKind: "provider" as const,
      provider: "open-library" as const,
      providerReference: "42",
      sourceUrl: "https://covers.openlibrary.org/b/id/42-L.jpg?default=false",
    };
    database.importBookMetadata(fixture.profile.id, alpha.bookId, {
      expectedRevision: 0,
      expectedContentHash: "a".repeat(64),
      changes: { title: "Durable alpha" },
    }, asset);
    database.addSendQueueEntries(fixture.profile.id, [alpha.bookId, bravo.bookId], 0, "durable-all-queue");
    const shelf = database.createSmartShelf(fixture.profile.id, {
      name: "Durable shelf",
      query: { version: 1, catalog: { coverAvailable: false } },
      pinned: true,
    }, "durable-all-shelf").shelf;
    database.updateProfileBookAnnotation(fixture.profile.id, bravo.bookId, {
      expectedRevision: 0,
      favorite: true,
    });
    const duplicate = database.listCatalogIssues(fixture.profile.id, { type: "suspected-duplicate" }).items[0]!;
    database.setCatalogDuplicatePreference(fixture.profile.id, duplicate.signature, {
      expectedRevision: 0,
      preferredBookId: alpha.bookId,
    });
    const missing = database.listCatalogIssues(fixture.profile.id, { type: "missing-cover" }).items[0]!;
    database.setCatalogIssueIgnored(fixture.profile.id, missing.signature, 0, true);
    const job = database.createMetadataLookupJob(fixture.profile.id, {
      provider: "open-library",
      bookIds: [bravo.bookId],
    }, "durable-all-lookup").job;
    database.controlMetadataLookupJob(fixture.profile.id, job.id, "resume", job.revision);
    database.claimMetadataLookupEntries(fixture.profile.id, job.id, 1);
    database.completeMetadataLookupEntry(fixture.profile.id, job.id, bravo.bookId, [{
      provider: "open-library",
      candidateId: "/works/OL42W",
      confidence: "low",
      metadata: { title: "Maybe bravo" },
    }], null);
    const managedToken = database.getMatchIndex(fixture.profile.id).entries.find(
      (entry) => entry.bookId === alpha.bookId,
    )!.managedToken;
    const delivery = database.createDelivery("durable-all-delivery", {
      profileId: fixture.profile.id,
      bookId: alpha.bookId,
      deviceKey: "durable-device",
      managedToken,
      status: "delivered",
    }).record;

    database.close();
    database = new CatalogDatabase(fixture.filename);
    database.close();
    database = new CatalogDatabase(fixture.filename);
    expect(database.getProfile(fixture.profile.id)?.name).toBe("Reader");
    expect(database.getRoot(fixture.profile.id, fixture.root.id)?.label).toBe("Books");
    expect(database.getBookMetadataState(fixture.profile.id, alpha.bookId)).toMatchObject({
      revision: 1,
      book: { title: "Durable alpha", coverEdited: true },
    });
    expect(database.getDelivery(delivery.id)?.bookId).toBe(alpha.bookId);
    expect(database.getCoverProviderCredential("google-books")?.apiKey).toBe("durable-provider-key");
    expect(database.getSendQueue(fixture.profile.id).total).toBe(2);
    expect(database.getSmartShelf(fixture.profile.id, shelf.id)?.name).toBe("Durable shelf");
    expect(database.getProfileBookAnnotation(fixture.profile.id, bravo.bookId).favorite).toBe(true);
    expect(database.getCatalogIssue(fixture.profile.id, duplicate.signature)?.disposition.preferredBookId).toBe(alpha.bookId);
    expect(database.getCatalogIssue(fixture.profile.id, missing.signature)?.disposition.ignored).toBe(true);
    expect(database.getMetadataLookupJob(fixture.profile.id, job.id)).toMatchObject({
      status: "completed",
      entries: [{ status: "ready", acceptedAt: null }],
    });

    database.clearRebuildableCatalog();
    expect(database.listBooks(fixture.profile.id).total).toBe(0);
    expect(database.getSendQueue(fixture.profile.id).entries.every(({ sourceState }) => sourceState === "missing-or-retired"))
      .toBe(true);
    for (const table of [
      "profiles",
      "library_roots",
      "deliveries",
      "book_metadata_overrides",
      "metadata_cover_assets",
      "cover_provider_credentials",
      "cover_provider_mutation_replays",
      "send_queue_entries",
      "smart_shelves",
      "profile_book_annotations",
      "catalog_issue_dispositions",
      "metadata_lookup_jobs",
      "metadata_lookup_entries",
    ]) {
      expect((database.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count)
        .toBeGreaterThan(0);
    }
    expect(database.getCatalogIssue(fixture.profile.id, duplicate.signature)).toBeNull();

    const restoredAlpha = addBook(database, fixture.root.id, "alpha", { hash: "a".repeat(64) });
    const restoredBravo = addBook(database, fixture.root.id, "bravo", { hash: "a".repeat(64) });
    expect([restoredAlpha.bookId, restoredBravo.bookId]).toEqual([alpha.bookId, bravo.bookId]);
    expect(database.getBookMetadataState(fixture.profile.id, alpha.bookId)).toMatchObject({
      revision: 1,
      book: { title: "Durable alpha", coverEdited: true },
    });
    expect(database.getSendQueue(fixture.profile.id).entries.every(({ sourceState }) => sourceState === "ready")).toBe(true);
    expect(database.getCatalogIssue(fixture.profile.id, duplicate.signature)?.disposition.preferredBookId).toBe(alpha.bookId);
    expect(database.getCatalogIssue(fixture.profile.id, missing.signature)?.disposition.ignored).toBe(true);
    database.close();
  });

  it("retains queue snapshots and annotations through restart and a rebuild", async () => {
    const fixture = await databaseFixture();
    let database = fixture.database;
    const alpha = addBook(database, fixture.root.id, "alpha", { hash: "a".repeat(64) });
    const bravo = addBook(database, fixture.root.id, "bravo", { hash: "b".repeat(64) });

    const added = database.addSendQueueEntries(
      fixture.profile.id,
      [alpha.bookId, bravo.bookId],
      0,
      "queue-add-1",
    );
    expect(added).toMatchObject({ applied: true, queue: { revision: 1, total: 2 } });
    expect(database.addSendQueueEntries(
      fixture.profile.id,
      [alpha.bookId, bravo.bookId],
      0,
      "queue-add-1",
    )).toMatchObject({ applied: false, queue: { revision: 1, total: 2 } });
    expect(() => database.addSendQueueEntries(
      fixture.profile.id,
      [alpha.bookId],
      0,
      "queue-add-1",
    )).toThrow(CatalogDatabaseError);

    const reordered = database.replaceSendQueue(fixture.profile.id, [bravo.bookId, alpha.bookId], 1);
    expect(reordered.queue.entries.map((entry) => entry.bookId)).toEqual([bravo.bookId, alpha.bookId]);
    expect(reordered.queue.revision).toBe(2);
    expect(database.updateProfileBookAnnotation(fixture.profile.id, alpha.bookId, {
      expectedRevision: 0,
      favorite: true,
    }).annotation).toMatchObject({ favorite: true, wantToRead: false, revision: 1 });

    database.close();
    database = new CatalogDatabase(fixture.filename);
    expect(database.getSendQueue(fixture.profile.id)).toMatchObject({ revision: 2, total: 2 });
    expect(database.getProfileBookAnnotation(fixture.profile.id, alpha.bookId)).toMatchObject({
      favorite: true,
      revision: 1,
    });

    database.clearRebuildableCatalog();
    expect(database.getSendQueue(fixture.profile.id).entries.map((entry) => entry.sourceState)).toEqual([
      "missing-or-retired",
      "missing-or-retired",
    ]);
    expect(database.getProfileBookAnnotation(fixture.profile.id, alpha.bookId).favorite).toBe(true);

    const restoredAlpha = addBook(database, fixture.root.id, "alpha", { hash: "a".repeat(64) });
    const restoredBravo = addBook(database, fixture.root.id, "bravo", { hash: "b".repeat(64) });
    expect(restoredAlpha.bookId).toBe(alpha.bookId);
    expect(restoredBravo.bookId).toBe(bravo.bookId);
    expect(database.getSendQueue(fixture.profile.id).entries.map((entry) => entry.sourceState)).toEqual([
      "ready",
      "ready",
    ]);

    database.database.prepare("UPDATE books SET presentation_version = ? WHERE id = ?")
      .run("c".repeat(64), alpha.bookId);
    expect(database.getSendQueue(fixture.profile.id).entries.find((entry) => entry.bookId === alpha.bookId)?.sourceState)
      .toBe("presentation-changed");
    database.database.prepare("UPDATE books SET available = 0 WHERE id = ?").run(alpha.bookId);
    expect(database.getSendQueue(fixture.profile.id).entries.find((entry) => entry.bookId === alpha.bookId)?.sourceState)
      .toBe("source-unavailable");
    database.close();
  });

  it("can reorder a valid queue larger than the bounded add batch", async () => {
    const { database, profile, root } = await databaseFixture();
    const bookIds = Array.from({ length: 501 }, (_, index) => addBook(
      database,
      root.id,
      `bulk-${index.toString().padStart(3, "0")}`,
      { hash: index.toString(16).padStart(64, "0") },
    ).bookId);
    database.addSendQueueEntries(profile.id, bookIds.slice(0, 500), 0, "large-queue-a");
    database.addSendQueueEntries(profile.id, bookIds.slice(500), 1, "large-queue-b");
    const reordered = database.replaceSendQueue(profile.id, [...bookIds].reverse(), 2).queue;
    expect(reordered).toMatchObject({ revision: 3, total: 501 });
    expect(reordered.entries.map(({ bookId }) => bookId)).toEqual([...bookIds].reverse());
    database.close();
  });

  it("bounds durable personal annotations without materializing empty intent", async () => {
    const { database, profile, root } = await databaseFixture();
    const book = addBook(database, root.id, "bounded-annotation");
    expect(database.updateProfileBookAnnotation(profile.id, book.bookId, {
      expectedRevision: 0,
      favorite: false,
    })).toMatchObject({ applied: false, annotation: { revision: 0 } });
    expect(database.database.prepare(
      "SELECT count(*) AS count FROM profile_book_annotations WHERE profile_id = ?",
    ).get(profile.id)).toEqual({ count: 0 });

    database.database.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
       )
       INSERT INTO profile_book_annotations(
         profile_id, book_id, favorite, want_to_read, revision, created_at, updated_at
       )
       SELECT ?, printf('book_retained_%08d', value), 1, 0, 1,
         '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z' FROM sequence`,
    ).run(MAX_PROFILE_BOOK_ANNOTATIONS_PER_PROFILE, profile.id);
    expect(() => database.updateProfileBookAnnotation(profile.id, book.bookId, {
      expectedRevision: 0,
      wantToRead: true,
    })).toThrowError(expect.objectContaining({ code: "too_large" }));
    database.close();
  });

  it("supports optimistic shelves, pin ordering, personal filters, bounded selection, and profile cascade", async () => {
    const { database, profile, root } = await databaseFixture();
    const alpha = addBook(database, root.id, "alpha");
    const bravo = addBook(database, root.id, "bravo");
    const other = database.createProfile({ name: "Other" });

    database.updateProfileBookAnnotation(profile.id, alpha.bookId, {
      expectedRevision: 0,
      favorite: true,
      wantToRead: true,
    });
    expect(database.resolveBookSelection(profile.id, { favorite: true }).bookIds).toEqual([alpha.bookId]);
    expect(() => database.resolveBookSelection(profile.id, {}, 1)).toThrowError(
      expect.objectContaining({ code: "selection_too_large" }),
    );

    const first = database.createSmartShelf(profile.id, {
      name: "Favorites",
      query: { version: 1, personal: { favorite: true } },
      pinned: true,
    }, "shelf-create-1");
    expect(first.shelf).toMatchObject({ revision: 1, pinnedRank: 0, serverCount: 1 });
    expect(database.createSmartShelf(profile.id, {
      name: "Favorites",
      query: { version: 1, personal: { favorite: true } },
      pinned: true,
    }, "shelf-create-1")).toMatchObject({ applied: false, shelf: { id: first.shelf.id } });
    const second = database.createSmartShelf(profile.id, {
      name: "All EPUB",
      query: { version: 1, catalog: { format: "epub" } },
      pinned: true,
    }, "shelf-create-2").shelf;
    const reordered = database.reorderPinnedSmartShelves(profile.id, {
      shelves: [
        { id: second.id, expectedRevision: second.revision },
        { id: first.shelf.id, expectedRevision: first.shelf.revision },
      ],
    });
    expect(reordered.shelves.filter((shelf) => shelf.pinnedRank !== null).map((shelf) => shelf.id))
      .toEqual([second.id, first.shelf.id]);
    expect(() => database.updateSmartShelf(profile.id, first.shelf.id, {
      expectedRevision: 1,
      name: "Stale rename",
    })).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => database.getProfileBookAnnotation(other.id, alpha.bookId)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );

    database.deleteProfile(profile.id);
    for (const table of ["send_queue_entries", "smart_shelves", "profile_book_annotations", "durable_mutation_replays"]) {
      expect(database.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(database.getProfile(other.id)?.name).toBe("Other");
    expect(bravo.bookId).toMatch(/^book_/u);
    database.close();
  });

  it("orders canonical series predictably across page boundaries and reports conservative hints", async () => {
    const { database, profile, root } = await databaseFixture();
    addBook(database, root.id, "unnumbered", { series: "L’Épée—Noire" });
    addBook(database, root.id, "three-a", { series: "l epee noire", seriesIndex: 3 });
    addBook(database, root.id, "one", { series: "L'Epee Noire", seriesIndex: 1 });
    addBook(database, root.id, "two-half", { series: "L Epee Noire", seriesIndex: 2.5 });
    addBook(database, root.id, "three-b", { series: "L Epee Noire", seriesIndex: 3 });
    addBook(database, root.id, "invalid", { series: "L Epee Noire", seriesIndex: -1 });

    const summaries = database.listSeries(profile.id);
    expect(summaries).toMatchObject({ total: 1, items: [{ key: "l epee noire", bookCount: 6, unnumberedCount: 2 }] });
    const firstPage = database.getSeries(profile.id, "l epee noire", { limit: 3, offset: 0 })!;
    const secondPage = database.getSeries(profile.id, "l epee noire", { limit: 3, offset: 3 })!;
    expect([...firstPage.books.items, ...secondPage.books.items].map((book) => book.title)).toEqual([
      "one", "two-half", "three-a", "three-b", "invalid", "unnumbered",
    ]);
    expect(firstPage).toMatchObject({ duplicateIndices: [3], missingIntegerIndices: [2], unnumberedCount: 2 });
    database.close();
  });
});
