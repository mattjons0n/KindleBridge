// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogBrowser, type CatalogBrowserOptions, type CatalogHardwareHooks, type CatalogKindleInventory } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogBookMatchQuery, CatalogEvent, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { bookActionCapabilities } from "../../client/src/book-action-capabilities";
import { booksForKindleView } from "../../client/src/library-prototype";
import { initialAppState, type AppState } from "../../client/src/state";

const profile: CatalogProfile = {
  id: "library-one", name: "Library", description: "Books", initial: "L", sourceLabel: "Books",
  enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 3,
};
const secondProfile: CatalogProfile = { ...profile, id: "library-two", name: "Second library", bookCount: 0 };
const root: CatalogRoot = {
  id: "root-one", profileId: profile.id, label: "Books", path: "/libraries/books",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const initialBooks: CatalogBook[] = ["confirmed", "possible", "absent"].map((id) => ({
  id, profileId: profile.id, rootId: root.id, sourceFilename: `${id}.epub`, title: `Book ${id}`,
  authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "epub", size: 100,
  contentHash: "a".repeat(64), presentationVersion: "a".repeat(64),
  addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", metadataComplete: true, available: true,
}));
const inventory: CatalogKindleInventory = {
  deviceLabel: "Kindle", scannedAt: "2026-01-01T00:00:00Z", completeness: "complete", total: 2, truncated: false,
  matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
  items: [
    { id: "mtp-1", filename: "confirmed.azw3", size: 100, managed: true, bookId: "confirmed", match: "confirmed" },
    { id: "mtp-2", filename: "possible.azw3", size: 100, managed: false, bookId: "possible", match: "possible" },
  ],
};
const readyState: AppState = {
  ...initialAppState(),
  device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
  selfTest: { kind: "passed", byteLength: 1037 }, catalogInventoryState: "ready",
};
const browsers: CatalogBrowser[] = [];
afterEach(() => {
  browsers.splice(0).forEach((browser) => browser.dispose());
  vi.useRealTimers();
});

async function harness(hooks: CatalogHardwareHooks = {}, options: CatalogBrowserOptions = {}) {
  let onEvent!: (event: CatalogEvent) => void;
  let onError!: () => void;
  let books = [...initialBooks];
  const onCatalogChanged = vi.fn(async () => undefined);
  const query = async (profileId: string, input: CatalogBookMatchQuery = {}) => {
    const items = books.filter((book) => book.profileId === profileId
      && (!input.includeBookIds || input.includeBookIds.includes(book.id))
      && (!input.q || book.title.includes(input.q)));
    return { items, total: items.length, limit: input.limit ?? 24, offset: input.offset ?? 0 };
  };
  const api = {
    getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
    listProfiles: vi.fn().mockResolvedValue([profile, secondProfile]),
    listRoots: vi.fn(async (profileId: string) => profileId === profile.id ? [root] : []),
    getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
    listBooks: vi.fn(query), queryBooks: vi.fn(query),
    getSendQueue: vi.fn(async (profileId: string) => ({ profileId, revision: 0, entries: [], total: 0, totalSourceBytes: 0 })),
    listSmartShelves: vi.fn().mockResolvedValue([]),
    rescanRoot: vi.fn(async () => emit("root.scan.started")),
    subscribeEvents: vi.fn((event: typeof onEvent, error: typeof onError, opened: () => void) => {
      onEvent = event; onError = error; opened(); return () => undefined;
    }),
  } as unknown as CatalogApi;
  const render = vi.fn();
  const browser = new CatalogBrowser(api, { onCatalogChanged, ...hooks }, render, { getItem: () => null, setItem: () => undefined }, options);
  browsers.push(browser);
  const emit = (type: string) => onEvent({ id: `${type}-${Date.now()}`, type, profileId: profile.id, rootId: root.id, at: new Date().toISOString() });
  await browser.start();
  browser.setKindleStatuses(new Map([["confirmed", "confirmed"], ["possible", "possible"], ["absent", "not-on-kindle"]]), new Map([
    [profile.id, { confirmed: 1, possible: 1, notOnKindle: 1, unknown: 0 }],
  ]));
  browser.setKindleInventory(inventory);
  await browser.setView("on-kindle");
  return { browser, api, render, emit, failEvents: () => onError(), onCatalogChanged, replaceBooks: (next: CatalogBook[]) => { books = next; } };
}

function visibleIds(browser: CatalogBrowser): string[] {
  const snapshot = browser.snapshot;
  return booksForKindleView(snapshot.page?.items ?? [], snapshot.filters, snapshot.kindleFilterStatuses ?? snapshot.kindleStatus).map(({ id }) => id);
}

describe("catalog scan continuity", () => {
  it("keeps On Kindle browse membership through Check now and returns to fresh matches after comparison", async () => {
    const { browser, api, onCatalogChanged } = await harness();
    expect(visibleIds(browser)).toEqual(["confirmed", "possible"]);
    await browser.setView("settings");
    await browser.rescanRoot(root.id);
    await vi.waitFor(() => expect(onCatalogChanged).toHaveBeenCalled());
    await browser.setView("on-kindle");

    expect(api.rescanRoot).toHaveBeenCalledOnce();
    expect(visibleIds(browser)).toEqual(["confirmed", "possible"]);
    expect(browser.snapshot.kindleFilterStatuses?.get("confirmed")).toBe("confirmed");
    expect(browser.snapshot.kindleStatus.get("confirmed")).toBe("unknown");
    for (const book of browser.snapshot.page!.items) {
      const actions = bookActionCapabilities(book, readyState, browser.snapshot);
      expect(actions.kindleStatus).toBe("unknown");
      expect(actions.send.enabled).toBe(false);
      expect(actions.remove.enabled).toBe(false);
    }

    browser.setKindleStatuses(new Map([["confirmed", "not-on-kindle"], ["possible", "confirmed"], ["absent", "not-on-kindle"]]), new Map([
      [profile.id, { confirmed: 1, possible: 0, notOnKindle: 2, unknown: 0 }],
    ]));
    browser.setKindleInventory({ ...inventory, items: [{ ...inventory.items[1]!, match: "confirmed" }], total: 1 });
    await browser.reloadBooks(true);
    expect(browser.snapshot.kindleFilterStatuses).toBeUndefined();
    expect(visibleIds(browser)).toEqual(["possible"]);
  });

  it("never turns retained filter membership into same-ID replacement or removal authority", async () => {
    const { browser, emit, replaceBooks } = await harness();
    emit("root.scan.started");
    const replacement = { ...initialBooks[0]!, title: "Replacement edition", contentHash: "b".repeat(64), presentationVersion: "b".repeat(64) };
    replaceBooks([replacement, initialBooks[1]!]);
    emit("book.updated");
    await browser.reloadBooks(true);
    expect(visibleIds(browser)).toEqual(["confirmed", "possible"]);
    expect(browser.snapshot.page?.items[0]?.title).toBe("Replacement edition");
    const actions = bookActionCapabilities(replacement, readyState, browser.snapshot);
    expect(actions).toMatchObject({ kindleStatus: "unknown", currentComparison: false, exactKindleAssociation: false });
    expect(actions.send.enabled).toBe(false);
    expect(actions.remove.enabled).toBe(false);
    browser.requestBookRemoval(replacement.id);
    expect(browser.snapshot.pendingRemoval).toBeUndefined();
  });

  it.each(["disconnect", "last-seen", "events-lost", "root-unavailable", "profile-change"] as const)("retires retained membership on %s", async (change) => {
    const { browser, emit, failEvents } = await harness();
    emit("root.scan.started");
    expect(browser.snapshot.kindleFilterStatuses).toBeDefined();
    if (change === "disconnect") browser.setKindleInventory(undefined);
    if (change === "last-seen") browser.setKindleInventory({ ...inventory, completeness: "last-seen" });
    if (change === "events-lost") failEvents();
    if (change === "root-unavailable") emit("root.unavailable");
    if (change === "profile-change") await browser.selectProfile(secondProfile.id);
    await browser.reloadBooks(true);
    expect(browser.snapshot.kindleFilterStatuses).toBeUndefined();
    expect(visibleIds(browser)).toEqual([]);
    if (change === "profile-change") expect(browser.snapshot.filters.profileId).toBe(secondProfile.id);
  });
});

describe("whole-library Kindle summary filters", () => {
  it.each([
    ["on-kindle", "confirmed"],
    ["possible", "possible"],
    ["not-on-kindle", "absent"],
  ] as const)("applies %s to the whole profile with one reload", async (kindle, expectedBookId) => {
    const { browser, api, render } = await harness({}, { readingPresentationGate: { version: 1, enabled: true } });
    await browser.applySmartShelf("builtin-favorites");
    browser.setLayout("list");
    vi.useFakeTimers();
    browser.updateFilter("metadata", "partial");
    browser.updateFilter("author", "A narrower author");
    browser.updateFilter("sort", "title");
    browser.updateFilter("query", "A pending search");
    browser.goToPage(48);
    await browser.setReadingFilter("read");
    vi.mocked(api.queryBooks).mockClear();
    vi.mocked(api.listBooks).mockClear();
    render.mockClear();

    await browser.applyKindleSummaryFilter(kindle);
    await vi.advanceTimersByTimeAsync(300);

    expect(browser.snapshot.filters).toMatchObject({
      profileId: profile.id, view: "all", kindle, offset: 0, sort: "title", query: "", metadata: "all", author: "all",
    });
    expect(browser.snapshot.layout).toBe("list");
    expect(browser.snapshot.activeShelf).toBeUndefined();
    expect(browser.snapshot.readingFilter).toBe("any");
    expect(visibleIds(browser)).toEqual([expectedBookId]);
    expect(api.queryBooks).toHaveBeenCalledOnce();
    expect(api.listBooks).not.toHaveBeenCalled();
    expect(api.queryBooks).toHaveBeenCalledWith(profile.id, expect.objectContaining({
      includeBookIds: [expectedBookId], q: undefined, author: undefined, metadata: undefined, sort: "title", offset: 0,
    }), expect.any(AbortSignal));
    expect(render).toHaveBeenCalledWith("all");
  });

  it("leaves the active transfer and its browsing context intact while busy", async () => {
    let finishSend!: () => void;
    const send = new Promise<void>((resolve) => { finishSend = resolve; });
    const { browser, api } = await harness({ onSendRequested: async () => send });
    await browser.applyKindleSummaryFilter("not-on-kindle");
    browser.openSend("absent");
    expect(browser.snapshot.sendBusy).toBe(true);
    const before = browser.snapshot;
    vi.mocked(api.queryBooks).mockClear();
    await browser.applyKindleSummaryFilter("possible");
    expect(browser.snapshot).toBe(before);
    expect(api.queryBooks).not.toHaveBeenCalled();
    finishSend();
    await vi.waitFor(() => expect(browser.snapshot.sendBusy).toBe(false));
  });

  it("cannot discard an unsaved Settings draft", async () => {
    const { browser, api } = await harness();
    await browser.setView("settings");
    browser.setSettingsDraft({ ...browser.snapshot.settingsDraft!, name: "Unsaved library name" });
    expect(browser.snapshot.settingsDirty).toBe(true);
    const before = browser.snapshot;
    vi.mocked(api.queryBooks).mockClear();
    await browser.applyKindleSummaryFilter("possible");
    expect(browser.snapshot).toBe(before);
    expect(api.queryBooks).not.toHaveBeenCalled();
  });
});
