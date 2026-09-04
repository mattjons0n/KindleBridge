import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-health-state-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "catalog.sqlite");
  const database = new CatalogDatabase(filename);
  const profile = database.createProfile({ name: "Health" });
  const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/health" });
  const addBook = (name: string, complete: boolean, cover: boolean) => database.upsertCatalogFile({
    rootId: root.id,
    relativePath: `${name}.epub`,
    format: "epub",
    size: 100,
    mtimeMs: 1,
    contentHash: "a".repeat(64),
    scanToken: "scan-health",
    retainedRelativePaths: new Set(["Missing.epub", "Covered.epub", "One.epub", "Two.epub", "Atomic.epub"]),
    metadata: {
      title: name,
      authors: complete ? ["Author"] : [],
      authorSort: null,
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      seriesIndex: null,
      subjects: [],
      identifiers: [],
      metadataComplete: complete,
      coverKey: cover ? `${name}.png` : null,
      coverMediaType: cover ? "image/png" : null,
    },
  });
  return { database, filename, profile, root, addBook };
}

describe("catalog health and durable metadata lookup state", () => {
  it("reports a root-level outage even when no source row was ever indexed", async () => {
    const state = await fixture();
    state.database.database
      .prepare("UPDATE library_roots SET status = 'unavailable', last_error_code = 'mount_unavailable' WHERE id = ?")
      .run(state.root.id);
    expect(state.database.listCatalogIssues(state.profile.id, { type: "unavailable-source" }).items).toEqual([
      expect.objectContaining({
        rootIds: [state.root.id],
        sourceIds: [],
        displayLabels: ["Books"],
        currentAvailable: false,
      }),
    ]);
    state.database.close();
  });

  it("derives bounded health, persists optimistic dispositions, and applies missing-cover filters everywhere", async () => {
    const state = await fixture();
    let database = state.database;
    const missing = state.addBook("Missing", false, false);
    state.addBook("Covered", true, true);

    const health = database.listCatalogIssues(state.profile.id);
    expect(health.counts.byType).toMatchObject({
      "missing-cover": 1,
      "incomplete-metadata": 1,
      "suspected-duplicate": 1,
    });
    expect(database.resolveBookSelection(state.profile.id, { coverAvailable: false }).bookIds).toEqual([missing.bookId]);
    const shelf = database.createSmartShelf(state.profile.id, {
      name: "Missing covers",
      query: { version: 1, catalog: { coverAvailable: false } },
    }, "health-shelf").shelf;
    expect(shelf.serverCount).toBe(1);

    const issue = health.items.find((item) => item.type === "missing-cover")!;
    const duplicate = health.items.find((item) => item.type === "suspected-duplicate")!;
    const preferred = database.setCatalogDuplicatePreference(state.profile.id, duplicate.signature, {
      expectedRevision: 0,
      preferredBookId: missing.bookId,
    }).issue;
    expect(preferred.disposition).toMatchObject({ preferredBookId: missing.bookId, revision: 1 });
    expect(() => database.setCatalogDuplicatePreference(state.profile.id, duplicate.signature, {
      expectedRevision: 1,
      preferredBookId: "book_not_in_group",
    })).toThrow(/not part/u);
    const ignored = database.setCatalogIssueIgnored(state.profile.id, issue.signature, 0, true).issue;
    expect(ignored.disposition).toMatchObject({ ignored: true, revision: 1 });
    expect(() => database.setCatalogIssueIgnored(state.profile.id, issue.signature, 0, false)).toThrow(/changed/u);
    const retried = database.recordCatalogIssueRetry(state.profile.id, issue.signature, 1).issue;
    expect(retried.disposition).toMatchObject({ ignored: true, revision: 2, retryCount: 1 });

    database.close();
    database = new CatalogDatabase(state.filename);
    expect(database.getCatalogIssue(state.profile.id, issue.signature)?.disposition).toMatchObject({
      ignored: true,
      revision: 2,
      retryCount: 1,
    });
    database.deleteProfile(state.profile.id);
    expect(database.database.prepare("SELECT count(*) AS count FROM catalog_issue_dispositions").get()).toEqual({ count: 0 });
    database.close();
  });

  it("prunes retired issue dispositions before the durable ceiling blocks a current issue", async () => {
    const state = await fixture();
    state.addBook("Missing", false, false);
    const current = state.database
      .listCatalogIssues(state.profile.id, { type: "missing-cover" })
      .items[0]!;
    state.database.database.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 20000
       )
       INSERT INTO catalog_issue_dispositions(
         profile_id, issue_signature, issue_type, ignored, revision, retry_count,
         last_retry_at, created_at, updated_at
       )
       SELECT ?, printf('issue-%016x', value), 'missing-cover', 1, 1, 0,
         NULL, '2026-01-01T00:00:00.000Z', printf('2026-01-01T%02d:%02d:00.000Z', value / 60, value % 60)
       FROM sequence`,
    ).run(state.profile.id);

    expect(state.database.setCatalogIssueIgnored(state.profile.id, current.signature, 0, true).issue.disposition)
      .toMatchObject({ ignored: true, revision: 1 });
    expect(state.database.database
      .prepare("SELECT count(*) AS count FROM catalog_issue_dispositions WHERE profile_id = ?")
      .get(state.profile.id)).toEqual({ count: 5_001 });
    expect(state.database.listCatalogIssues(state.profile.id, { type: "missing-cover" }).items[0]?.disposition)
      .toMatchObject({ ignored: true, revision: 1 });
    state.database.close();
  });

  it("keeps bulk lookups review-only, restart-safe, idempotent, and recoverable", async () => {
    const state = await fixture();
    let database = state.database;
    const one = state.addBook("One", true, false);
    const two = state.addBook("Two", true, false);
    const created = database.createMetadataLookupJob(state.profile.id, {
      provider: "open-library",
      bookIds: [one.bookId, two.bookId],
    }, "lookup-create-1");
    expect(created).toMatchObject({ applied: true, job: { status: "queued", revision: 1, pending: 2 } });
    expect(database.createMetadataLookupJob(state.profile.id, {
      provider: "open-library",
      bookIds: [one.bookId, two.bookId],
    }, "lookup-create-1")).toMatchObject({ applied: false, job: { id: created.job.id } });

    const running = database.controlMetadataLookupJob(state.profile.id, created.job.id, "resume", 1).job;
    const claims = database.claimMetadataLookupEntries(state.profile.id, created.job.id);
    expect(claims).toHaveLength(2);
    expect(claims[0]?.terms).toMatchObject({ title: "One", author: "Author" });
    database.completeMetadataLookupEntry(state.profile.id, created.job.id, one.bookId, [{
      provider: "open-library",
      candidateId: "/works/OL1W",
      confidence: "low",
      metadata: { title: "Provider One" },
    }], null);
    const completed = database.completeMetadataLookupEntry(
      state.profile.id,
      created.job.id,
      two.bookId,
      [],
      "provider-unavailable",
    );
    expect(completed).toMatchObject({ status: "completed", pending: 0, ready: 1, failed: 1 });
    expect(database.listMetadataLookupJobs(state.profile.id).items[0]).toMatchObject({
      entriesIncluded: false,
      entries: [],
      total: 2,
      ready: 1,
      failed: 1,
    });
    expect(database.getBookMetadataState(state.profile.id, one.bookId)).toMatchObject({
      revision: 0,
      book: { title: "One", metadataEdited: false },
    });
    expect(database.listCatalogIssues(state.profile.id, { type: "low-confidence-provider-data" }).items)
      .toEqual([expect.objectContaining({ bookIds: [one.bookId] })]);
    database.importBookMetadata(state.profile.id, one.bookId, {
      expectedRevision: 0,
      expectedContentHash: "a".repeat(64),
      changes: { title: "Provider One" },
    }, null, {
      jobId: created.job.id,
      provider: "open-library",
      candidateId: "/works/OL1W",
    });
    expect(database.listCatalogIssues(state.profile.id, { type: "low-confidence-provider-data" }).items).toEqual([]);
    expect(database.getMetadataLookupJob(state.profile.id, created.job.id)?.entries[0]?.acceptedAt).toMatch(/^\d{4}-/u);

    const interrupted = database.createMetadataLookupJob(state.profile.id, {
      provider: "open-library",
      bookIds: [one.bookId],
    }, "lookup-create-2").job;
    database.controlMetadataLookupJob(state.profile.id, interrupted.id, "resume", interrupted.revision);
    database.claimMetadataLookupEntries(state.profile.id, interrupted.id, 1);
    database.close();
    database = new CatalogDatabase(state.filename);
    expect(database.getMetadataLookupJob(state.profile.id, interrupted.id)).toMatchObject({
      status: "paused",
      pending: 1,
      entries: [{ status: "pending", attempts: 1 }],
    });
    expect(database.getMetadataLookupJob(state.profile.id, created.job.id)).toMatchObject({
      status: "completed",
      entries: [expect.objectContaining({
        acceptedAt: expect.any(String),
        candidates: [expect.objectContaining({ candidateId: "/works/OL1W" })],
      }), expect.anything()],
    });
    expect(running.status).toBe("running");
    database.close();
  });

  it("commits selected metadata and cover rows atomically", async () => {
    const state = await fixture();
    const book = state.addBook("Atomic", true, false);
    const asset = {
      assetKey: `${"b".repeat(64)}.png`,
      checksum: "b".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 68,
      width: 1,
      height: 1,
      sourceKind: "provider" as const,
      provider: "open-library" as const,
      providerReference: "42",
      sourceUrl: "https://covers.openlibrary.org/b/id/42-L.jpg?default=false",
    };
    expect(() => state.database.importBookMetadata(state.profile.id, book.bookId, {
      expectedRevision: 0,
      expectedContentHash: "f".repeat(64),
      changes: { title: "Must not commit" },
    }, asset)).toThrow(/source changed/u);
    expect(state.database.database.prepare("SELECT count(*) AS count FROM metadata_cover_assets").get()).toEqual({ count: 0 });

    const imported = state.database.importBookMetadata(state.profile.id, book.bookId, {
      expectedRevision: 0,
      expectedContentHash: "a".repeat(64),
      changes: { title: "Provider title", publisher: "Provider Press" },
    }, asset).state;
    expect(imported).toMatchObject({
      revision: 1,
      book: { title: "Provider title", publisher: "Provider Press", coverEdited: true },
      sourceMetadata: { title: "Atomic" },
    });
    expect(state.database.database.prepare("SELECT count(*) AS count FROM metadata_cover_assets").get()).toEqual({ count: 1 });
    state.database.close();
  });
});
