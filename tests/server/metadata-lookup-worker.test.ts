import { describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { CoverProviderError } from "../../server/cover-providers.js";
import { MetadataLookupWorker } from "../../server/metadata-lookup-worker.js";

describe("bounded metadata lookup worker", () => {
  it("makes overlapping callers wait instead of hot-polling an unchanged running job", async () => {
    const database = new CatalogDatabase(":memory:");
    const profile = database.createProfile({ name: "Concurrent" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/concurrent" });
    const addBook = (relativePath: string, hashByte: string) => database.upsertCatalogFile({
      rootId: root.id,
      relativePath,
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: hashByte.repeat(64),
      scanToken: "scan",
      metadata: {
        title: relativePath,
        authors: ["Source Author"],
        authorSort: null,
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
    }).bookId;
    const firstBook = addBook("first.epub", "d");
    const secondBook = addBook("second.epub", "e");
    const createRunningJob = (bookId: string, key: string) => {
      const created = database.createMetadataLookupJob(profile.id, {
        provider: "open-library",
        bookIds: [bookId],
      }, key).job;
      database.controlMetadataLookupJob(profile.id, created.id, "resume", created.revision);
      return database.getMetadataLookupJob(profile.id, created.id)!;
    };
    const firstJob = createRunningJob(firstBook, "concurrent-first");
    const secondJob = createRunningJob(secondBook, "concurrent-second");
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = {
      searchMetadata: vi.fn(async () => {
        await providerGate;
        return [];
      }),
    };
    const worker = new MetadataLookupWorker(database, provider, vi.fn(async () => undefined));
    const firstRun = worker.runStep(profile.id, firstJob.id);
    await vi.waitFor(() => expect(provider.searchMetadata).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const secondRun = worker.runStep(profile.id, secondJob.id).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(provider.searchMetadata).toHaveBeenCalledTimes(1);

    releaseProvider();
    await firstRun;
    const secondSnapshot = await secondRun;
    expect(secondSnapshot).toMatchObject({ id: secondJob.id, status: "running", pending: 1 });
    expect(provider.searchMetadata).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("backs off transient provider failures and stops at durable review-ready candidates", async () => {
    const database = new CatalogDatabase(":memory:");
    const profile = database.createProfile({ name: "Bulk" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/bulk" });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan",
      metadata: {
        title: "Source title",
        authors: ["Source Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        seriesIndex: null,
        subjects: [],
        identifiers: ["ISBN:9780000000001"],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    const job = database.createMetadataLookupJob(profile.id, {
      provider: "open-library",
      bookIds: [indexed.bookId],
    }, "worker-job").job;
    database.controlMetadataLookupJob(profile.id, job.id, "resume", job.revision);
    let calls = 0;
    const provider = {
      searchMetadata: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new CoverProviderError("provider_unavailable", "retry");
        return [{
          provider: "open-library" as const,
          candidateId: "/works/OL1W",
          confidence: "high" as const,
          metadata: { title: "Reviewed title" },
        }];
      }),
    };
    const delay = vi.fn(async () => undefined);
    const completed = await new MetadataLookupWorker(database, provider, delay).runStep(profile.id, job.id);

    expect(provider.searchMetadata).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(250);
    expect(completed).toMatchObject({ status: "completed", ready: 1, failed: 0 });
    expect(completed.entries[0]?.candidates[0]?.metadata).toMatchObject({ title: "Reviewed title" });
    expect(database.getBookMetadataState(profile.id, indexed.bookId)).toMatchObject({
      revision: 0,
      book: { title: "Source title", metadataEdited: false },
    });
    database.close();
  });

  it("maps generic and non-retryable provider failures to the fixed durable vocabulary", async () => {
    const database = new CatalogDatabase(":memory:");
    const profile = database.createProfile({ name: "Failure mapping" });
    const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/failures" });
    const addBook = (title: string, key: string) => database.upsertCatalogFile({
      rootId: root.id,
      relativePath: `${key}.epub`,
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: key.repeat(64),
      scanToken: "scan",
      metadata: {
        title,
        authors: ["Source Author"],
        authorSort: null,
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
    const genericBook = addBook("Generic failure", "b");
    const genericJob = database.createMetadataLookupJob(profile.id, {
      provider: "open-library",
      bookIds: [genericBook.bookId],
    }, "generic-failure").job;
    database.controlMetadataLookupJob(profile.id, genericJob.id, "resume", genericJob.revision);
    const genericProvider = { searchMetadata: vi.fn(async () => { throw new Error("network detail"); }) };
    await new MetadataLookupWorker(database, genericProvider, vi.fn(async () => undefined))
      .runStep(profile.id, genericJob.id);
    expect(genericProvider.searchMetadata).toHaveBeenCalledTimes(3);
    expect(database.getMetadataLookupJob(profile.id, genericJob.id)?.entries[0]).toMatchObject({
      status: "failed",
      errorCode: "provider-unavailable",
    });
    const failedJob = database.getMetadataLookupJob(profile.id, genericJob.id)!;
    database.controlMetadataLookupJob(profile.id, genericJob.id, "retry", failedJob.revision);
    const recoveredProvider = { searchMetadata: vi.fn(async () => [{
      provider: "open-library" as const,
      candidateId: "/works/OL2W",
      confidence: "medium" as const,
      metadata: { title: "Recovered" },
    }]) };
    await new MetadataLookupWorker(database, recoveredProvider, vi.fn(async () => undefined))
      .runStep(profile.id, genericJob.id);
    expect(recoveredProvider.searchMetadata).toHaveBeenCalledOnce();
    expect(database.getMetadataLookupJob(profile.id, genericJob.id)).toMatchObject({
      status: "completed",
      entries: [{ status: "ready", errorCode: null }],
    });

    const missingKeyBook = addBook("No key", "c");
    const missingKeyJob = database.createMetadataLookupJob(profile.id, {
      provider: "google-books",
      bookIds: [missingKeyBook.bookId],
    }, "missing-key").job;
    database.controlMetadataLookupJob(profile.id, missingKeyJob.id, "resume", missingKeyJob.revision);
    const missingKeyProvider = {
      searchMetadata: vi.fn(async () => {
        throw new CoverProviderError("provider_not_configured", "secret detail");
      }),
    };
    await new MetadataLookupWorker(database, missingKeyProvider, vi.fn(async () => undefined))
      .runStep(profile.id, missingKeyJob.id);
    expect(missingKeyProvider.searchMetadata).toHaveBeenCalledTimes(1);
    expect(database.getMetadataLookupJob(profile.id, missingKeyJob.id)?.entries[0]).toMatchObject({
      status: "failed",
      errorCode: "provider-not-configured",
    });
    database.close();
  });
});
