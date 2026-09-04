import { describe, expect, it, vi } from "vitest";
import type {
  CatalogApi,
  CatalogBook,
  CatalogProfile,
  CatalogRoot,
  CatalogSendQueue,
  MetadataLookupJob,
  SmartShelf,
} from "../../client/src/catalog-client";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import { writeLibraryBrowserContext } from "../../client/src/library-browser-context";
import { initialLibraryFilters } from "../../client/src/library-prototype";

const profile: CatalogProfile = {
  id: "profile-one", name: "Home", description: "Home", initial: "H", sourceLabel: "Books",
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 3,
};
const root: CatalogRoot = {
  id: "root-one", profileId: profile.id, label: "Books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};

function book(id: string): CatalogBook {
  return {
    id, profileId: profile.id, rootId: root.id, sourceFilename: `${id}.epub`, title: `Book ${id}`,
    authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 100,
    contentHash: id.padEnd(64, "0").slice(0, 64), presentationVersion: id.padEnd(64, "1").slice(0, 64),
    addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    metadataComplete: true, available: true,
  };
}

describe("CatalogBrowser persistent send queue", () => {
  it("idempotently keeps a direct edited-book update failure in Send later", async () => {
    const edited = {
      ...book("a"),
      metadataEdited: true,
      metadataRevision: 1,
    };
    let queue: CatalogSendQueue = {
      profileId: profile.id,
      revision: 0,
      entries: [],
      total: 0,
      totalSourceBytes: 0,
    };
    const addSendQueueEntries = vi.fn(async (_profileId: string, input: { bookIds: readonly string[] }) => {
      if (!queue.entries.some(({ bookId }) => bookId === edited.id)) {
        queue = {
          profileId: profile.id,
          revision: queue.revision + 1,
          entries: [{
            profileId: profile.id,
            bookId: edited.id,
            rank: 0,
            queuedContentHash: edited.contentHash!,
            queuedPresentationVersion: edited.presentationVersion!,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            book: edited,
            sourceState: "ready" as const,
          }],
          total: 1,
          totalSourceBytes: edited.size,
        };
      }
      expect(input.bookIds).toEqual([edited.id]);
      return queue;
    });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [edited], total: 1, limit: 24, offset: 0 }),
      getSendQueue: vi.fn(async () => queue),
      addSendQueueEntries,
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const onUpdateRequested = vi.fn(async () => { throw new Error("cable interrupted"); });
    const browser = new CatalogBrowser(api, { onUpdateRequested }, () => undefined, {
      getItem: () => null,
      setItem: () => undefined,
    });
    await browser.start();
    await vi.waitFor(() => expect(browser.snapshot.sendQueueState).toBe("ready"));
    browser.setKindleStatuses(new Map([[edited.id, "possible"]]), new Map([
      [profile.id, { confirmed: 0, possible: 1, notOnKindle: 0, unknown: 0 }],
    ]));
    browser.setKindleInventory({
      deviceLabel: "Kindle",
      scannedAt: "2026-01-01T00:00:00Z",
      completeness: "complete",
      items: [{
        id: "mtp-00000029",
        filename: "Book-a-kb-0123456789abcdefabcd.azw3",
        size: 100,
        managed: true,
        bookId: edited.id,
        match: "possible",
        stalePresentation: true,
      }],
      total: 1,
      truncated: false,
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
    });

    browser.requestBookUpdate(edited.id);
    await browser.confirmBookUpdate();

    expect(onUpdateRequested).toHaveBeenCalledOnce();
    expect(addSendQueueEntries).toHaveBeenCalledOnce();
    expect(browser.snapshot.sendQueue?.entries.map(({ bookId }) => bookId)).toEqual([edited.id]);
    expect(browser.snapshot.pendingUpdate?.error).toContain("remains in Send later for retry");
    expect(browser.snapshot.activityEvents[0]).toMatchObject({ action: "open-queue" });

    // Repeating the preservation step through another failed update sees the
    // existing durable queue entry and does not issue a duplicate mutation.
    browser.cancelBookUpdate();
    browser.requestBookUpdate(edited.id);
    await browser.confirmBookUpdate();
    expect(addSendQueueEntries).toHaveBeenCalledOnce();
    browser.dispose();
  });

  it("applies a durable unknown-status shelf instead of silently showing every book", async () => {
    const books = [book("known"), book("unknown")];
    const queryBooks = vi.fn(async (_profileId: string, query: { includeBookIds?: readonly string[] }) => {
      const items = books.filter(({ id }) => query.includeBookIds?.includes(id));
      return { items, total: items.length, limit: 24, offset: 0 };
    });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: books, total: 2, limit: 24, offset: 0 }),
      queryBooks,
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves: vi.fn().mockResolvedValue([{
        id: "unknown-shelf", profileId: profile.id, name: "Not compared",
        query: { version: 1, kindleStatus: "unknown" }, pinnedRank: null, revision: 1,
        serverCount: 2, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });
    await browser.start();
    await vi.waitFor(() => expect(browser.snapshot.smartShelvesState).toBe("ready"));
    browser.setKindleStatuses(new Map([["known", "confirmed"], ["unknown", "unknown"]]), new Map([
      [profile.id, { confirmed: 1, possible: 0, notOnKindle: 0, unknown: 1 }],
    ]));
    queryBooks.mockClear();

    await browser.applySmartShelf("unknown-shelf");

    expect(browser.snapshot.filters.kindle).toBe("unknown");
    expect(queryBooks).toHaveBeenCalledWith(profile.id, expect.objectContaining({ includeBookIds: ["unknown"] }), expect.any(AbortSignal));
    expect(browser.snapshot.page?.items.map(({ id }) => id)).toEqual(["unknown"]);

    await browser.applyLibraryRoute({
      version: 1,
      profileId: profile.id,
      activeShelfId: "unknown-shelf",
      filters: browser.snapshot.filters,
      layout: browser.snapshot.layout,
      density: browser.snapshot.density ?? "comfortable",
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });

    expect(browser.snapshot.activeShelf?.id).toBe("unknown-shelf");
    browser.dispose();
  });

  it("rechecks each entry and removes verified successes in one final queue mutation", async () => {
    const books = [book("a"), book("b"), book("c")];
    let queue: CatalogSendQueue = {
      profileId: profile.id,
      revision: 1,
      entries: books.map((item, rank) => ({
        profileId: profile.id,
        bookId: item.id,
        rank,
        queuedContentHash: item.contentHash!,
        queuedPresentationVersion: item.presentationVersion!,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        book: item,
        sourceState: "ready",
      })),
      total: 3,
      totalSourceBytes: 300,
    };
    const replaceSendQueue = vi.fn(async (_profileId: string, input: { expectedRevision: number; bookIds: string[] }) => {
      queue = {
        ...queue,
        revision: queue.revision + 1,
        entries: queue.entries.filter(({ bookId }) => input.bookIds.includes(bookId)),
        total: input.bookIds.length,
        totalSourceBytes: input.bookIds.length * 100,
      };
      return queue;
    });
    const queryBooks = vi.fn(async (_profileId: string, query: { includeBookIds?: readonly string[] }) => {
      const items = books.filter(({ id }) => query.includeBookIds?.includes(id));
      return { items, total: items.length, limit: 200, offset: 0 };
    });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: books, total: 3, limit: 24, offset: 0 }),
      queryBooks,
      getSendQueue: vi.fn(async () => queue),
      replaceSendQueue,
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const onSendRequested = vi.fn(async ({ book: item }: { book: CatalogBook }) => {
      if (item.id === "b") throw new Error("cable interrupted");
    });
    const onSendBatchFinished = vi.fn().mockResolvedValue(undefined);
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    };
    const browser = new CatalogBrowser(api, { onSendRequested, onSendBatchFinished }, () => undefined, storage);
    await browser.start();
    await vi.waitFor(() => expect(browser.snapshot.sendQueueState).toBe("ready"));
    browser.setKindleStatuses(new Map(books.map(({ id }) => [id, "not-on-kindle"] as const)), new Map([
      [profile.id, { confirmed: 0, possible: 0, notOnKindle: 3, unknown: 0 }],
    ]));
    browser.setKindleInventory({
      deviceLabel: "Kindle", scannedAt: "2026-01-01T00:00:00Z", completeness: "complete",
      items: [], total: 0, truncated: false, matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
    });

    await browser.sendQueuedBooks();

    expect(onSendRequested.mock.calls.map(([request]) => request.book.id)).toEqual(["a", "b"]);
    expect(queryBooks.mock.calls.map(([, query]) => query.includeBookIds)).toEqual([["a"], ["b"]]);
    expect(replaceSendQueue).toHaveBeenCalledTimes(1);
    expect(replaceSendQueue.mock.calls[0]?.[1].bookIds).toEqual(["b", "c"]);
    expect(browser.snapshot.sendQueue?.entries.map(({ bookId }) => bookId)).toEqual(["b", "c"]);
    expect([...browser.snapshot.selectedBookIds]).toEqual(["b", "c"]);
    expect(onSendBatchFinished).toHaveBeenCalledOnce();
    expect(browser.snapshot.activityEvents[0]).toMatchObject({
      kind: "failure",
      action: "open-queue",
    });
    expect(browser.snapshot.activityEvents[0]?.detail).toContain("Book b");
    expect([...stored.values()].some((value) => value.includes("Book b") && value.includes("open-queue"))).toBe(true);
    browser.dispose();
  });

  it("refreshes an active personal shelf after its manual annotation changes", async () => {
    const item = book("favorite");
    const listBooks = vi.fn().mockResolvedValue({ items: [item], total: 1, limit: 24, offset: 0 });
    const getBookAnnotation = vi.fn().mockResolvedValue({
      profileId: profile.id,
      bookId: item.id,
      favorite: true,
      wantToRead: false,
      revision: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const updateBookAnnotation = vi.fn().mockResolvedValue({
      profileId: profile.id,
      bookId: item.id,
      favorite: false,
      wantToRead: false,
      revision: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks,
      getBookAnnotation,
      updateBookAnnotation,
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });
    await browser.start();
    await browser.applySmartShelf("builtin-favorites");
    listBooks.mockClear();

    await browser.toggleBookAnnotation(item.id, "favorite");

    expect(updateBookAnnotation).toHaveBeenCalledWith(profile.id, item.id, {
      expectedRevision: 2,
      favorite: false,
    });
    expect(listBooks).toHaveBeenCalledOnce();
    expect(listBooks.mock.calls[0]?.[1]).toMatchObject({ favorite: true });
    browser.dispose();
  });

  it("reports queue hydration failure and releases the queue operation", async () => {
    const addSendQueueEntries = vi.fn();
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 }),
      queryBooks: vi.fn().mockRejectedValue(new Error("catalog hydration unavailable")),
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      addSendQueueEntries,
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });
    await browser.start();
    await vi.waitFor(() => expect(browser.snapshot.sendQueueState).toBe("ready"));

    await expect(browser.addBookToSendQueue("not-visible")).resolves.toBeUndefined();

    expect(addSendQueueEntries).not.toHaveBeenCalled();
    expect(browser.snapshot.sendQueueBusy).toBe(false);
    expect(browser.snapshot.sendQueueError).toContain("catalog hydration unavailable");
    expect(browser.snapshot.activityEvents[0]).toMatchObject({
      kind: "failure",
      action: "open-queue",
    });
    browser.dispose();
  });

  it("rejects adding a visible row beyond the bounded 5,000-book selection", async () => {
    const visible = book("visible");
    const selection = Array.from({ length: 5_000 }, (_, index) => `selected-${index}`);
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [visible], total: 1, limit: 24, offset: 0 }),
      resolveBookSelection: vi.fn().mockResolvedValue({ bookIds: selection, total: selection.length, ceiling: 5_000 }),
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });
    await browser.start();
    browser.setLayout("list");
    await browser.selectAllFiltered();

    browser.toggleBookSelection(visible.id, true);

    expect(browser.snapshot.selectedBookIds.size).toBe(5_000);
    expect(browser.snapshot.selectedBookIds.has(visible.id)).toBe(false);
    expect(browser.snapshot.bulkActionError).toContain("at most 5,000 books");
    browser.dispose();
  });

  it("loads configured Google Books state before creating a bulk job after reload", async () => {
    let createdJob: MetadataLookupJob | undefined;
    const listCoverProviderCredentials = vi.fn().mockResolvedValue([{
      provider: "google-books",
      configured: true,
      maskedKey: "••••••••",
      revision: 2,
      status: "working",
      lastTestedAt: "2026-09-04T10:00:00Z",
      errorCode: null,
    }]);
    const createMetadataLookupJob = vi.fn(async () => {
      createdJob = {
        id: "job-google",
        profileId: profile.id,
        provider: "google-books",
        status: "queued",
        revision: 1,
        entriesIncluded: true,
        entries: [],
        total: 1,
        pending: 1,
        ready: 0,
        noResults: 0,
        failed: 0,
        cancelled: 0,
        createdAt: "2026-09-04T10:00:00Z",
        updatedAt: "2026-09-04T10:00:00Z",
      };
      return createdJob;
    });
    const listMetadataLookupJobs = vi.fn(async () => ({
      items: createdJob ? [{ ...createdJob, entriesIncluded: false, entries: [] }] : [],
      total: createdJob ? 1 : 0,
      limit: 20,
      offset: 0,
    }));
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [book("a")], total: 1, limit: 24, offset: 0 }),
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves: vi.fn().mockResolvedValue([]),
      listCoverProviderCredentials,
      createMetadataLookupJob,
      listMetadataLookupJobs,
      getMetadataLookupJob: vi.fn(async () => createdJob!),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });

    await browser.start();
    expect(browser.snapshot.coverProviderSettings?.loadState).toBe("idle");
    await browser.createMetadataLookupJob("google-books", ["a"]);

    expect(listCoverProviderCredentials).toHaveBeenCalledOnce();
    expect(createMetadataLookupJob).toHaveBeenCalledWith(
      profile.id,
      { provider: "google-books", bookIds: ["a"] },
      expect.any(String),
    );
    expect(browser.snapshot.activeMetadataLookupJob?.id).toBe("job-google");
    browser.dispose();
  });

  it("loads the complete bounded metadata-job history so older paused work remains actionable", async () => {
    const jobs: MetadataLookupJob[] = Array.from({ length: 25 }, (_, index) => ({
      id: `job-${index}`,
      profileId: profile.id,
      provider: "open-library",
      status: index === 24 ? "paused" : "completed",
      revision: 1,
      entriesIncluded: false,
      entries: [],
      total: 1,
      pending: index === 24 ? 1 : 0,
      ready: index === 24 ? 0 : 1,
      noResults: 0,
      failed: 0,
      cancelled: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    const listMetadataLookupJobs = vi.fn(async (
      _profileId: string,
      query: { readonly limit?: number; readonly offset?: number },
    ) => {
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 20;
      return { items: jobs.slice(offset, offset + limit), total: jobs.length, limit, offset };
    });
    const getMetadataLookupJob = vi.fn(async (_profileId: string, jobId: string) => ({
      ...jobs.find(({ id }) => id === jobId)!,
      entriesIncluded: true,
    }));
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 }),
      listMetadataLookupJobs,
      getMetadataLookupJob,
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves: vi.fn().mockResolvedValue([]),
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });

    await browser.start();
    await vi.waitFor(() => expect(browser.snapshot.metadataLookupState).toBe("ready"));

    expect(listMetadataLookupJobs.mock.calls.map(([, query]) => query.offset)).toEqual([0, 20]);
    expect(browser.snapshot.metadataLookupJobs?.items).toHaveLength(25);
    expect(browser.snapshot.metadataLookupJobs?.items.at(-1)?.id).toBe("job-24");

    await browser.loadMetadataLookupJobs("job-24");

    expect(browser.snapshot.activeMetadataLookupJob).toMatchObject({ id: "job-24", status: "paused", entriesIncluded: true });
    expect(getMetadataLookupJob).toHaveBeenCalledWith(profile.id, "job-24", expect.any(AbortSignal));
    browser.dispose();
  });

  it("keeps a valid URL route authoritative over a slower saved-shelf restore", async () => {
    let resolveShelves!: (value: readonly never[]) => void;
    const listSmartShelves = vi.fn(() => new Promise<readonly never[]>((resolve) => {
      resolveShelves = resolve;
    }));
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    };
    writeLibraryBrowserContext(storage, {
      filters: { ...initialLibraryFilters(profile.id), query: "saved shelf query" },
      layout: "grid",
      density: "comfortable",
      scrollY: 0,
      activeShelfId: "builtin-favorites",
    });
    const listBooks = vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks,
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves,
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, storage);
    await browser.start();

    await browser.applyLibraryRoute({
      version: 1,
      profileId: profile.id,
      filters: { ...initialLibraryFilters(profile.id), query: "url query" },
      layout: "list",
      density: "compact",
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    resolveShelves([]);
    await vi.waitFor(() => expect(browser.snapshot.smartShelvesState).toBe("ready"));

    expect(browser.snapshot.filters.query).toBe("url query");
    expect(browser.snapshot.layout).toBe("list");
    expect(browser.snapshot.activeShelf).toBeUndefined();
    expect(listBooks).toHaveBeenLastCalledWith(
      profile.id,
      expect.objectContaining({ q: "url query" }),
      expect.any(AbortSignal),
    );
    browser.dispose();
  });

  it("defers a routed shelf until profile shelves load, then restores saved and personal presets", async () => {
    const customShelf: SmartShelf = {
      id: "shelf-custom", profileId: profile.id, name: "Favorite author",
      query: { version: 1, catalog: { author: "Author" }, personal: { wantToRead: true } },
      pinnedRank: 0, revision: 1, serverCount: 3,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    let resolveShelves!: (value: readonly SmartShelf[]) => void;
    const listSmartShelves = vi.fn(() => new Promise<readonly SmartShelf[]>((resolve) => {
      resolveShelves = resolve;
    }));
    const listBooks = vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 });
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([root]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks,
      getSendQueue: vi.fn().mockResolvedValue({ profileId: profile.id, revision: 0, entries: [], total: 0, totalSourceBytes: 0 }),
      listSmartShelves,
      subscribeEvents: vi.fn((_event: unknown, _error: unknown, opened: () => void) => {
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, { getItem: () => null, setItem: () => undefined });
    await browser.start();

    await browser.applyLibraryRoute({
      version: 1,
      profileId: profile.id,
      activeShelfId: customShelf.id,
      filters: { ...initialLibraryFilters(profile.id), query: "routed refinement" },
      layout: "grid",
      density: "comfortable",
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    expect(browser.snapshot.activeShelf).toBeUndefined();

    resolveShelves([customShelf]);
    await vi.waitFor(() => expect(browser.snapshot.activeShelf?.id).toBe(customShelf.id));
    expect(listBooks).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({
      q: "routed refinement",
      author: "Author",
      wantToRead: true,
    }), expect.any(AbortSignal));

    await browser.applyLibraryRoute({
      version: 1,
      profileId: profile.id,
      activeShelfId: "builtin-favorites",
      filters: initialLibraryFilters(profile.id),
      layout: "grid",
      density: "comfortable",
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    expect(browser.snapshot.activeShelf?.id).toBe("builtin-favorites");
    expect(listBooks).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ favorite: true }), expect.any(AbortSignal));

    await browser.applyLibraryRoute({
      version: 1,
      profileId: profile.id,
      activeShelfId: "builtin-want-to-read",
      filters: initialLibraryFilters(profile.id),
      layout: "grid",
      density: "comfortable",
      overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    expect(browser.snapshot.activeShelf?.id).toBe("builtin-want-to-read");
    expect(listBooks).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ wantToRead: true }), expect.any(AbortSignal));
    browser.dispose();
  });
});
