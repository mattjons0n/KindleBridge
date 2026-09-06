// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookMetadataState, CatalogMetadataCandidate, MetadataCandidateImportInput, MetadataLookupJob } from "../../client/src/catalog-client";
import { renderNeedsAttention } from "../../client/src/library-health-view";

async function setup(readOnly = false) {
  const books = new Map<string, CatalogBook>(["one", "two"].map((id) => [id, {
    id, profileId: "profile", rootId: "root", sourceFilename: `${id}.epub`, title: `Book ${id}`,
    authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 100,
    contentHash: `${id}-hash`, presentationVersion: `${id}-presentation`, metadataRevision: 2,
    metadataComplete: true, available: true, addedAt: "2026-01-01", updatedAt: "2026-01-01",
  }]));
  const state = (id: string): CatalogBookMetadataState => ({
    book: books.get(id)!, revision: 2, overrides: {}, basedOnContentHash: books.get(id)!.contentHash!, sourceChanged: false,
    sourceCoverUrl: null, coverOverride: null,
    sourceMetadata: { title: `Book ${id}`, authors: ["Author"], authorSort: "Author", language: null, publisher: null, publishedAt: null, series: null, seriesIndex: null, description: null, subjects: [], identifiers: [] },
  });
  const candidates = (id: string): CatalogMetadataCandidate[] => [
    { provider: "hardcover", candidateId: `${id}-chronological`, confidence: "high", metadata: { title: `Book ${id}`, authors: ["Author"], series: "Chronological", seriesIndex: 1.5 } },
    { provider: "hardcover", candidateId: `${id}-publication`, confidence: "medium", metadata: { title: `Book ${id}`, authors: ["Author"], series: "Publication", seriesIndex: 0 } },
  ];
  let job: MetadataLookupJob = {
    id: "job", profileId: "profile", provider: "hardcover", status: "completed", revision: 1,
    total: 2, pending: 0, ready: 2, noResults: 0, failed: 0, cancelled: 0, entriesIncluded: true,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    entries: ["one", "two"].map((bookId, rank) => ({ jobId: "job", bookId, rank, status: "ready", attempts: 1, candidates: candidates(bookId), errorCode: null, acceptedAt: null, updatedAt: "2026-01-01" })),
  };
  const getBookMetadata = vi.fn(async (_profile: string, id: string) => state(id));
  const importBookMetadata = vi.fn(async (_profile: string, id: string, input: MetadataCandidateImportInput) => {
    const candidate = candidates(id).find((item) => item.candidateId === input.candidateId)!;
    const saved: CatalogBookMetadataState = { ...state(id), book: { ...books.get(id)!, series: candidate.metadata.series!, seriesIndex: candidate.metadata.seriesIndex!, metadataRevision: 3 }, revision: 3 };
    books.set(id, saved.book);
    job = { ...job, entries: job.entries.map((entry) => entry.bookId === id ? { ...entry, acceptedAt: "2026-09-06" } : entry) };
    return saved;
  });
  const api = {
    getStatus: vi.fn(async () => ({ available: true, state: "ready", settingsMode: readOnly ? "read-only" : "read-write", database: "ready", cache: "ready" })),
    listProfiles: vi.fn(async () => [{ id: "profile", name: "Library", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 2 }]),
    listRoots: vi.fn(async () => [{ id: "root", profileId: "profile", label: "Books", path: "/libraries/books", enabled: true, status: "watching" }]),
    getFilters: vi.fn(async () => ({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] })),
    listBooks: vi.fn(async () => ({ items: [...books.values()], total: 2, limit: 24, offset: 0 })),
    getBook: vi.fn(async (_profile: string, id: string) => books.get(id)!),
    getBookMetadata, importBookMetadata,
    listMetadataLookupJobs: vi.fn(async () => ({ items: [job], total: 1, limit: 20, offset: 0 })),
    getMetadataLookupJob: vi.fn(async () => job),
    subscribeEvents: vi.fn(() => () => {}),
  } as unknown as CatalogApi;
  const browser = new CatalogBrowser(api, {}, () => {}, undefined);
  await browser.start();
  await browser.openMetadataLookupJob("job");
  return { browser, api, books, getBookMetadata, importBookMetadata, state };
}

describe("Hardcover reviewed bulk series", () => {
  it("requires a choice per book, applies distinct series, and retains only failed selections for retry", async () => {
    const { browser, importBookMetadata } = await setup();
    try {
      const element = document.createElement("div");
      element.innerHTML = renderNeedsAttention(browser.snapshot);
      const selectors = [...element.querySelectorAll<HTMLSelectElement>('[data-ui-action="select-hardcover-bulk-series"]')];
      expect(selectors).toHaveLength(2);
      expect(selectors.every((select) => select.value === "" && select.options.length === 3)).toBe(true);
      expect(element.textContent).toContain("Publication · Volume 0");
      expect(element.querySelector<HTMLButtonElement>('[data-ui-action="apply-hardcover-bulk-series"]')!.disabled).toBe(true);
      browser.selectHardcoverBulkSeries("one", "one-chronological");
      browser.selectHardcoverBulkSeries("two", "two-publication");
      const original = importBookMetadata.getMockImplementation()!;
      importBookMetadata.mockImplementation(async (...args) => { if (args[1] === "two") throw new Error("Try again later"); return original(...args); });
      await browser.applyHardcoverBulkSeries();
      expect(importBookMetadata).toHaveBeenNthCalledWith(1, "profile", "one", expect.objectContaining({ candidateId: "one-chronological", lookupJobId: "job", selectedFields: ["series", "seriesIndex"], includeCover: false, expectedRevision: 2, expectedContentHash: "one-hash" }), expect.any(AbortSignal));
      expect(importBookMetadata).toHaveBeenNthCalledWith(2, "profile", "two", expect.objectContaining({ candidateId: "two-publication" }), expect.any(AbortSignal));
      expect([...browser.snapshot.hardcoverBulkReview!.selections.keys()]).toEqual(["two"]);
      expect(browser.snapshot.hardcoverBulkReview!.errors.get("two")).toBe("Try again later");
      expect(browser.snapshot.hardcoverBulkReview!.summary).toContain("1 of 2 books updated");
      importBookMetadata.mockImplementation(original);
      await browser.applyHardcoverBulkSeries();
      expect(importBookMetadata).toHaveBeenCalledTimes(3);
      expect(browser.snapshot.hardcoverBulkReview!.selections.size).toBe(0);
      expect(browser.snapshot.hardcoverBulkReview!.summary).toBe("1 of 1 book updated.");
    } finally { browser.dispose(); }
  });

  it("does not replace an explicitly cleared override unless opted in, and rejects unseen changes", async () => {
    const { browser, books, state, getBookMetadata, importBookMetadata } = await setup();
    try {
      getBookMetadata.mockImplementation(async (_profile, id) => ({ ...state(id), overrides: { series: null, seriesIndex: null } }));
      browser.selectHardcoverBulkSeries("one", "one-chronological");
      await browser.applyHardcoverBulkSeries();
      expect(importBookMetadata).not.toHaveBeenCalled();
      expect(browser.snapshot.hardcoverBulkReview!.errors.get("one")).toContain("Replace existing series");
      browser.selectHardcoverBulkSeries("one", "one-chronological", true);
      books.set("one", { ...books.get("one")!, series: "Someone else's edit", metadataRevision: 8 });
      await browser.applyHardcoverBulkSeries();
      expect(importBookMetadata).not.toHaveBeenCalled();
      expect(browser.snapshot.hardcoverBulkReview!.errors.get("one")).toContain("changed after you selected");
      browser.selectHardcoverBulkSeries("one", "one-chronological", true);
      await browser.applyHardcoverBulkSeries();
      expect(importBookMetadata).toHaveBeenCalledOnce();
    } finally { browser.dispose(); }
  });

  it("does not allow a selection or import in read-only Settings mode", async () => {
    const { browser, importBookMetadata } = await setup(true);
    try {
      browser.selectHardcoverBulkSeries("one", "one-chronological", true);
      await browser.applyHardcoverBulkSeries();
      expect(browser.snapshot.hardcoverBulkReview).toBeUndefined();
      expect(importBookMetadata).not.toHaveBeenCalled();
    } finally { browser.dispose(); }
  });

  it("stops before applying an in-flight review when the browser is disposed", async () => {
    const { browser, getBookMetadata, importBookMetadata } = await setup();
    getBookMetadata.mockImplementation(() => new Promise(() => {}));
    browser.selectHardcoverBulkSeries("one", "one-chronological");
    browser.selectHardcoverBulkSeries("two", "two-publication");
    const applying = browser.applyHardcoverBulkSeries();
    await vi.waitFor(() => expect(getBookMetadata).toHaveBeenCalledOnce());
    browser.dispose();
    await applying;
    expect(importBookMetadata).not.toHaveBeenCalled();
    expect(getBookMetadata).toHaveBeenCalledOnce();
  });
});
