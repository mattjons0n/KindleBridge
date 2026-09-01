// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogApi,
  CatalogBook,
  CatalogBookPage,
  CatalogEvent,
  CatalogFilters,
  CatalogProfile,
  CatalogRoot,
  CatalogServiceStatus,
  SaveCatalogConfigurationInput,
} from "../../client/src/catalog-client";
import { CatalogApiError } from "../../client/src/catalog-client";
import {
  CatalogBrowser,
  type CatalogRemoveRequest,
  type CatalogSendRequest,
} from "../../client/src/catalog-browser";
import { catalogQuery, countLibraryBooks, initialLibraryFilters } from "../../client/src/library-prototype";
import { DebugLog } from "../../client/src/log";
import { initialAppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

const STATUS: CatalogServiceStatus = {
  available: true,
  state: "ready",
  settingsMode: "read-write",
  database: "ready",
  cache: "ready",
};

const PROFILES: CatalogProfile[] = [
  { id: "prf_personal", name: "Your library", description: "Personal collection", initial: "Y", sourceLabel: "husbandlibrary", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 2 },
  { id: "prf_wife", name: "Wife's library", description: "Separate collection", initial: "W", sourceLabel: "wifelibrary", enabled: true, rootCount: 1, availableRootCount: 0, bookCount: 1 },
];

const ROOTS: Record<string, CatalogRoot[]> = {
  prf_personal: [{ id: "root_personal", profileId: "prf_personal", label: "husbandlibrary", path: "/libraries/husbandlibrary", recursive: true, watch: true, enabled: true, status: "available", lastScanAt: "2026-08-29T12:00:00Z" }],
  prf_wife: [{ id: "root_wife", profileId: "prf_wife", label: "wifelibrary", path: "/libraries/wifelibrary", recursive: true, watch: true, enabled: true, status: "unavailable", lastErrorCode: "SOURCE_UNAVAILABLE" }],
};

const BOOKS: CatalogBook[] = [
  { id: "book_time", profileId: "prf_personal", rootId: "root_personal", sourceFilename: "time-machine.epub", title: "The Time Machine", authors: ["H. G. Wells"], authorSort: "Wells, H. G.", language: "en", publisher: "Bridge Press", publishedAt: "1895", series: "Classics", subjects: ["Science fiction"], identifiers: ["urn:isbn:111"], format: "epub", size: 864_000, contentHash: "a".repeat(64), addedAt: "2026-08-28T18:20:00Z", updatedAt: "2026-08-28T18:20:00Z", metadataComplete: true, available: true, coverUrl: "/api/profiles/prf_personal/books/book_time/cover" },
  { id: "book_dorian", profileId: "prf_personal", rootId: "root_personal", sourceFilename: "dorian.epub", title: "The Picture of Dorian Gray", authors: ["Oscar Wilde"], authorSort: "Wilde, Oscar", language: "en", publishedAt: "1890", subjects: ["Gothic"], identifiers: [], format: "epub", size: 940_000, contentHash: "b".repeat(64), addedAt: "2026-08-14T09:05:00Z", updatedAt: "2026-08-14T09:05:00Z", metadataComplete: false, available: true },
  { id: "book_frankenstein", profileId: "prf_wife", rootId: "root_wife", sourceFilename: "frankenstein.epub", title: "Frankenstein", authors: ["Mary Shelley"], authorSort: "Shelley, Mary", language: "en", publishedAt: "1818", subjects: ["Gothic"], identifiers: [], format: "epub", size: 1_600_000, contentHash: "c".repeat(64), addedAt: "2026-08-27T07:45:00Z", updatedAt: "2026-08-27T07:45:00Z", metadataComplete: true, available: false },
];

const FACETS: CatalogFilters = {
  authors: [{ value: "H. G. Wells", label: "H. G. Wells", count: 1 }, { value: "Oscar Wilde", label: "Oscar Wilde", count: 1 }],
  languages: [{ value: "en", label: "English", count: 2 }],
  subjects: [{ value: "Gothic", label: "Gothic", count: 1 }],
  publishers: [{ value: "Bridge Press", label: "Bridge Press", count: 1 }],
  series: [{ value: "Classics", label: "Classics", count: 1 }],
  formats: [{ value: "epub", label: "EPUB", count: 2 }],
  roots: [{ value: "root_personal", label: "husbandlibrary", count: 2 }],
  years: [{ value: "1895", label: "1895", count: 1 }],
  metadata: [],
};

function page(items: readonly CatalogBook[], offset = 0, limit = 24): CatalogBookPage {
  return { items, total: items.length, limit, offset };
}

function handlers(overrides: Partial<AppViewHandlers> = {}): AppViewHandlers {
  return {
    onTargetProfileSaved: vi.fn(), onEpubSelected: vi.fn(), onConvert: vi.fn(), onDownloadConverted: vi.fn(),
    onConnect: vi.fn(), onDisconnect: vi.fn(), onSelfTest: vi.fn(), onSendIntegrated: vi.fn(),
    onIntegratedOpenConfirmed: vi.fn(), onCleanupInspectionConfirmed: vi.fn(), onCopyLog: vi.fn(),
    ...overrides,
  };
}

function fakeApi(options: { readonly status?: CatalogServiceStatus } = {}): CatalogApi & { profiles: CatalogProfile[]; roots: Record<string, CatalogRoot[]> } {
  const api = {
    profiles: PROFILES.map((profile) => ({ ...profile })),
    roots: Object.fromEntries(Object.entries(ROOTS).map(([id, roots]) => [id, roots.map((root) => ({ ...root }))])),
    getStatus: vi.fn(async () => options.status ?? STATUS),
    listProfiles: vi.fn(async function (this: { profiles: CatalogProfile[] }) { return this.profiles; }),
    createProfile: vi.fn(async () => PROFILES[0]),
    updateProfile: vi.fn(async () => PROFILES[0]),
    deleteProfile: vi.fn(async function (this: { profiles: CatalogProfile[] }, profileId: string) { this.profiles = this.profiles.filter((profile) => profile.id !== profileId); }),
    listRoots: vi.fn(async function (this: { roots: Record<string, CatalogRoot[]> }, profileId: string) { return this.roots[profileId] ?? []; }),
    createRoot: vi.fn(async () => ROOTS.prf_personal[0]),
    updateRoot: vi.fn(async () => ROOTS.prf_personal[0]),
    deleteRoot: vi.fn(async () => undefined),
    rescanRoot: vi.fn(async () => undefined),
    listBooks: vi.fn(async (profileId: string, query = {}) => {
      let items = BOOKS.filter((book) => book.profileId === profileId);
      if (query.q) items = items.filter((book) => `${book.title} ${book.authors.join(" ")} ${book.subjects.join(" ")}`.toLocaleLowerCase().includes(query.q!.toLocaleLowerCase()));
      if (query.year) items = items.filter((book) => book.publishedAt?.startsWith(query.year!));
      return page(items, query.offset, query.limit);
    }),
    queryBooks: vi.fn(async (profileId: string, query = {}) => {
      let items = BOOKS.filter((book) => book.profileId === profileId);
      if (query.includeBookIds) items = items.filter((book) => query.includeBookIds!.includes(book.id));
      if (query.excludeBookIds) items = items.filter((book) => !query.excludeBookIds!.includes(book.id));
      return page(items, query.offset, query.limit);
    }),
    getFilters: vi.fn(async () => FACETS),
    getBook: vi.fn(async (_profileId: string, bookId: string) => BOOKS.find((book) => book.id === bookId) ?? BOOKS[0]),
    getMatchIndex: vi.fn(async (profileId: string) => ({ profileId, generatedAt: "2026-08-29T12:00:00Z", entries: [] })),
    getBookSource: vi.fn(async () => ({ blob: new Blob(["epub"]) })),
    createDelivery: vi.fn(async () => ({})),
    saveConfiguration: vi.fn(async function (this: { profiles: CatalogProfile[]; roots: Record<string, CatalogRoot[]> }, input: SaveCatalogConfigurationInput) {
      const id = input.profileId ?? "prf_created";
      const profile: CatalogProfile = { id, name: input.profile.name, description: input.profile.description ?? "Household collection", initial: input.profile.name.slice(0, 1), sourceLabel: input.roots[0]?.label ?? "No folder", enabled: input.profile.enabled ?? true, rootCount: input.roots.length, availableRootCount: 0, bookCount: 0 };
      this.profiles = [...this.profiles.filter((candidate) => candidate.id !== id), profile];
      const roots = input.roots.map((root, index): CatalogRoot => ({ id: root.id ?? `root_created_${index}`, profileId: id, label: root.label, path: root.path, recursive: root.recursive, watch: root.watch, enabled: root.enabled, status: "pending" }));
      this.roots[id] = roots;
      return { profile, roots };
    }),
    subscribeEvents: vi.fn((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return () => undefined;
    }),
  } satisfies CatalogApi & { profiles: CatalogProfile[]; roots: Record<string, CatalogRoot[]> };
  return api;
}

function click(root: HTMLElement, selector: string): void {
  const element = root.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button: ${selector}`);
  element.click();
}

function setInput(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error("Missing input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function loadedView(api = fakeApi(), callbacks = handlers()): Promise<{ root: HTMLElement; view: AppView; api: ReturnType<typeof fakeApi> }> {
  const root = document.createElement("div");
  const view = new AppView(root, initialAppState(), callbacks, new DebugLog(), { catalogApi: api });
  await vi.waitFor(() => expect(root.querySelector("#library-heading")?.textContent).toBe("Your library"));
  return { root, view, api };
}

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("catalog-backed library model", () => {
  it("maps every discovery control, including publication year and pagination, to the API query", () => {
    const query = catalogQuery({ ...initialLibraryFilters("prf_personal"), query: " wells ", author: "H. G. Wells", language: "en", subject: "Science fiction", publisher: "Bridge Press", series: "Classics", format: "epub", rootId: "root_personal", year: "1895", metadata: "complete", sort: "published", offset: 24 });
    expect(query).toMatchObject({ q: "wells", author: "H. G. Wells", language: "en", subject: "Science fiction", publisher: "Bridge Press", series: "Classics", format: "epub", rootId: "root_personal", year: "1895", metadata: "complete", sort: "published", limit: 24, offset: 24 });
  });

  it("keeps Recently added newest-first regardless of the prior sort selector", () => {
    expect(catalogQuery({
      ...initialLibraryFilters("prf_personal"),
      view: "recent",
      sort: "title",
    })).toMatchObject({ sort: "recent", order: "desc" });
  });

  it("locks the Recently added sort control to its newest-first result order", async () => {
    const { root, api } = await loadedView();
    const sort = root.querySelector<HTMLSelectElement>("#library-sort")!;
    sort.value = "title";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.listBooks).mock.calls.at(-1)?.[1]).toMatchObject({ sort: "title", order: "asc" }));

    click(root, 'button[data-ui-view="recent"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>("#library-sort")?.value).toBe("recent"));
    expect(root.querySelector<HTMLSelectElement>("#library-sort")?.disabled).toBe(true);
    expect(vi.mocked(api.listBooks).mock.calls.at(-1)?.[1]).toMatchObject({ sort: "recent", order: "desc" });
  });

  it("does not call unknown Kindle inventory ready to send and scopes summary counts by profile", () => {
    expect(countLibraryBooks(PROFILES[0], page(BOOKS.slice(0, 2)), new Map()).readyToSend).toBe(0);
    const counts = countLibraryBooks(
      PROFILES[0],
      page(BOOKS.slice(0, 2)),
      new Map([
        ["book_time", "confirmed"],
        ["book_dorian", "not-on-kindle"],
        ["book_frankenstein", "confirmed"],
      ]),
      new Map([
        ["prf_personal", { confirmed: 1, possible: 0, notOnKindle: 1, unknown: 0 }],
        ["prf_wife", { confirmed: 1, possible: 0, notOnKindle: 0, unknown: 0 }],
      ]),
    );
    expect(counts).toEqual({ total: 2, onKindle: 1, possible: 0, readyToSend: 1 });
  });

  it("loads profiles and books from the API without rendering the old sample catalog", async () => {
    const { root } = await loadedView();
    expect(root.querySelector('[data-book-id="book_time"]')?.textContent).toContain("The Time Machine");
    expect(root.textContent).not.toContain("Meditations");
    expect(root.querySelector('.library-cover-image img')?.getAttribute("src")).toContain("/api/profiles/prf_personal");
    expect(root.querySelector('[aria-label="Library summary"]')?.textContent).toContain("connect to compare");
  });

  it("keeps compact distinguishable profile names visible in the narrow-screen CSS contract", async () => {
    const { root } = await loadedView();
    const profileNames = [...root.querySelectorAll<HTMLElement>(".library-profile strong")]
      .map((element) => element.textContent?.trim());
    expect(profileNames).toEqual(["Your library", "Wife's library"]);

    const stylesheet = await readFile(path.resolve(process.cwd(), "client/src/styles.css"), "utf8");
    const copyRuleStart = stylesheet.indexOf(".library-profile > span:last-child");
    const copyRule = stylesheet.slice(copyRuleStart, stylesheet.indexOf("}", copyRuleStart) + 1);
    expect(copyRule).toContain("flex: 1 1 auto");
    expect(copyRule).toContain("min-width: 0");
    expect(copyRule).toContain("overflow: hidden");

    const narrowStart = stylesheet.indexOf("@media (max-width: 420px)");
    const narrowEnd = stylesheet.indexOf("@media (prefers-reduced-motion: reduce)", narrowStart);
    const narrowRules = stylesheet.slice(narrowStart, narrowEnd);
    expect(narrowRules).toMatch(/\.library-profile\s*\{[^}]*min-width:\s*0;/u);
    expect(narrowRules).toMatch(/\.library-profile small\s*\{[^}]*display:\s*none;/u);
    expect(narrowRules).not.toMatch(/\.library-profile > span:last-child\s*\{[^}]*display:\s*none;/u);
  });

  it("replaces a failed cached cover request with the generated missing-cover card", async () => {
    const { root } = await loadedView();
    const image = root.querySelector<HTMLImageElement>('[data-book-id="book_time"] img[data-library-cover-image]');
    expect(image).not.toBeNull();

    image!.dispatchEvent(new Event("error"));

    const cover = root.querySelector<HTMLElement>('[data-book-id="book_time"] .library-cover');
    expect(image?.hidden).toBe(true);
    expect(cover?.classList.contains("library-cover-image")).toBe(false);
    expect(cover?.querySelector<HTMLElement>("strong[data-library-cover-fallback]")?.hidden).toBe(false);
    expect(cover?.textContent).toContain("The Time Machine");
  });

  it("switches profile scope and reports unavailable container sources", async () => {
    const { root, api } = await loadedView();
    click(root, 'button[data-ui-profile="prf_wife"]');
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book_frankenstein"]')).not.toBeNull());
    expect(root.querySelector("#library-heading")?.textContent).toBe("Wife's library");
    expect(root.querySelector('[data-book-id="book_time"]')).toBeNull();
    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Library sources unavailable");
    expect(vi.mocked(api.listBooks)).toHaveBeenLastCalledWith("prf_wife", expect.any(Object), expect.any(AbortSignal));
  });

  it("can enter, leave, and re-enter Settings without losing the editor", async () => {
    const { root } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector("#settings-heading")).not.toBeNull());
    click(root, 'button[data-ui-view="all"]');
    await vi.waitFor(() => expect(root.querySelector("#library-heading")?.textContent).toBe("Your library"));
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Your library"));
  });

  it("never reuses a prior profile page when retry falls back to another profile", async () => {
    const api = fakeApi();
    const renders: Array<{ profileId?: string; bookIds: string[] }> = [];
    let browser!: CatalogBrowser;
    browser = new CatalogBrowser(api, {}, () => {
      renders.push({
        profileId: browser.snapshot.filters.profileId,
        bookIds: browser.snapshot.page?.items.map((book) => book.id) ?? [],
      });
    }, undefined);
    await browser.start();
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_time", "book_dorian"]);

    api.profiles = api.profiles.map((profile) => (
      profile.id === "prf_personal" ? { ...profile, enabled: false } : profile
    ));
    vi.mocked(api.listBooks).mockImplementation(async (profileId, query = {}) => {
      if (profileId === "prf_wife") throw new Error("wife catalog unavailable");
      return page(BOOKS.filter((book) => book.profileId === profileId), query.offset, query.limit);
    });

    await browser.retry();

    expect(browser.snapshot.filters.profileId).toBe("prf_wife");
    expect(browser.snapshot.page).toBeUndefined();
    expect(browser.snapshot.facets.authors).toEqual([]);
    expect(browser.snapshot.booksState).toBe("error");
    expect(browser.snapshot.error).toContain("wife catalog unavailable");
    expect(renders.some(({ profileId, bookIds }) => (
      profileId === "prf_wife" && bookIds.some((bookId) => bookId !== "book_frankenstein")
    ))).toBe(false);
    browser.dispose();
  });

  it("requeries the last valid page after live catalog shrink strands an offset", async () => {
    const api = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    await browser.start();
    vi.mocked(api.listBooks).mockImplementation(async (_profileId, query = {}) => (
      (query.offset ?? 0) > 0
        ? { items: [], total: 10, limit: 24, offset: query.offset ?? 0 }
        : { items: BOOKS.slice(0, 2), total: 10, limit: 24, offset: 0 }
    ));

    browser.goToPage(48);
    await vi.waitFor(() => expect(browser.snapshot.filters.offset).toBe(0));

    expect(browser.snapshot.page).toMatchObject({ total: 10, offset: 0 });
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_time", "book_dorian"]);
    expect(vi.mocked(api.listBooks).mock.calls.at(-1)?.[1]).toMatchObject({ offset: 0, limit: 24 });
    browser.dispose();
  });

  it("shows an actionable error if an event-driven profile fallback refresh fails", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const { root } = await loadedView(api);
    api.profiles = api.profiles.map((profile) => (
      profile.id === "prf_personal" ? { ...profile, enabled: false } : profile
    ));
    vi.mocked(api.listRoots).mockImplementation(async (profileId) => {
      if (profileId === "prf_wife") throw new Error("fallback refresh failed");
      return api.roots[profileId] ?? [];
    });

    emitEvent?.({
      id: "event-profile-fallback-error",
      type: "profile.updated",
      at: new Date().toISOString(),
      profileId: "prf_personal",
    });

    await vi.waitFor(() => expect(root.querySelector(".library-error-state")?.textContent).toContain("fallback refresh failed"));
    expect(root.querySelector(".library-loading-state")).toBeNull();
    expect(root.querySelector('[data-book-id="book_time"]')).toBeNull();
  });

  it("shows an active scan as indexing instead of falsely calling the source unavailable", async () => {
    const api = fakeApi();
    api.profiles = api.profiles.map((profile) => profile.id === "prf_personal"
      ? { ...profile, availableRootCount: 0 }
      : profile);
    api.roots.prf_personal = api.roots.prf_personal.map((root) => ({ ...root, status: "scanning" }));

    const { root } = await loadedView(api);

    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Indexing library");
    expect(root.querySelector(".library-topbar-status")?.textContent).not.toContain("sources unavailable");
  });

  it("warns in the normal library view when one or more book files could not be indexed", async () => {
    const api = fakeApi();
    api.roots.prf_personal = api.roots.prf_personal.map((root) => ({
      ...root,
      status: "watching",
      lastErrorCode: "source_errors:2",
    }));

    const { root } = await loadedView(api);

    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Some books could not be indexed");
    expect(root.querySelector(".library-topbar-status")?.textContent).toContain("Review 1 source warning in Settings");
    expect(root.querySelector(".library-topbar-status")?.getAttribute("data-status")).toBe("warning");
  });

  it("disables Send while a root is unavailable even before stale book rows are retired", async () => {
    const api = fakeApi();
    api.roots.prf_personal = api.roots.prf_personal.map((root) => ({ ...root, status: "unavailable" }));
    const { root } = await loadedView(api);
    const send = root.querySelector<HTMLButtonElement>('[data-book-id="book_time"] [data-ui-action="send-book"]');
    expect(send?.disabled).toBe(true);
    expect(send?.textContent).toContain("Source unavailable");
  });

  it("disables book Send while disconnected or when hierarchy inventory is partial", async () => {
    const { root, view } = await loadedView();
    const selector = '[data-book-id="book_time"] [data-ui-action="send-book"]';
    expect(root.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(selector)?.textContent).toContain("Connect to send");

    view.setCatalogKindleStatuses(new Map([["book_time", "not-on-kindle"]]), new Map([
      ["prf_personal", { confirmed: 0, possible: 0, notOnKindle: 1, unknown: 1 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "partial",
      total: 0,
      truncated: false,
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });
    expect(root.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(selector)?.textContent).toContain("Inventory unavailable");
  });

  it("shows and blocks a current unknown Kindle comparison instead of presenting it as absent", async () => {
    const { root, view } = await loadedView();
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "unknown"],
      ["book_dorian", "not-on-kindle"],
    ]), new Map([
      ["prf_personal", { confirmed: 0, possible: 0, notOnKindle: 1, unknown: 1 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 1,
      truncated: false,
      metadata: { status: "partial", eligible: 1, enriched: 0, failed: 1, skipped: 0, truncated: false },
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [{ id: "mtp-unreadable", filename: "unreadable.azw3", size: 100, managed: false, match: "unmatched" }],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });

    const unknownCard = root.querySelector<HTMLElement>('[data-book-id="book_time"]');
    expect(unknownCard?.querySelector('.library-kindle-check[aria-label="Kindle presence could not be verified"]')).not.toBeNull();
    expect(unknownCard?.textContent).toContain("Kindle presence unknown");
    expect(unknownCard?.querySelector<HTMLButtonElement>('[data-ui-action="send-book"]')).toMatchObject({
      disabled: true,
      textContent: "Could not verify",
    });
    const absentButton = root.querySelector<HTMLButtonElement>('[data-book-id="book_dorian"] [data-ui-action="send-book"]');
    expect(absentButton?.disabled).toBe(false);
    expect(absentButton?.textContent).toBe("Send to Kindle");
  });

  it("keeps an ambiguous Kindle match visibly uncertain and blocks Send", async () => {
    const { root, view } = await loadedView();
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "possible"],
      ["book_dorian", "not-on-kindle"],
    ]), new Map([
      ["prf_personal", { confirmed: 0, possible: 1, notOnKindle: 1, unknown: 0 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 1,
      truncated: false,
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [{ id: "mtp-possible", filename: "possible.azw3", size: 100, managed: false, match: "possible" }],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });

    const card = root.querySelector<HTMLElement>('[data-book-id="book_time"]');
    expect(card?.querySelector('.library-kindle-check[aria-label="Possible Kindle match"]')).not.toBeNull();
    expect(card?.querySelector<HTMLButtonElement>('[data-ui-action="send-book"]')).toMatchObject({
      disabled: true,
      textContent: "Possible match",
    });
  });

  it("toggles list selection and sends the eligible selection through the bulk hook", async () => {
    const send = vi.fn(async (_request: CatalogSendRequest) => undefined);
    const { root, view } = await loadedView(fakeApi(), handlers({ onCatalogSendRequested: send }));
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "not-on-kindle"],
      ["book_dorian", "not-on-kindle"],
    ]), new Map([
      ["prf_personal", { confirmed: 0, possible: 0, notOnKindle: 2, unknown: 0 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 0,
      truncated: false,
      metadata: { status: "complete", eligible: 0, enriched: 0, failed: 0, skipped: 0, truncated: false },
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1_012 },
      catalogInventoryState: "ready",
    });

    click(root, '[data-ui-action="set-library-layout"][data-layout="list"]');
    expect(root.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll<HTMLInputElement>('[data-ui-action="toggle-book-selection"]')).toHaveLength(2);

    const first = root.querySelector<HTMLInputElement>('[data-book-id="book_time"] [data-ui-action="toggle-book-selection"]')!;
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector(".library-bulk-selection")?.textContent).toContain("1 selected");

    click(root, '[data-ui-action="set-library-layout"][data-layout="grid"]');
    expect(root.querySelector('[data-ui-action="toggle-book-selection"]')).toBeNull();
    click(root, '[data-ui-action="set-library-layout"][data-layout="list"]');
    expect(root.querySelector(".library-bulk-selection")?.textContent).toContain("0 selected");

    for (const bookId of ["book_time", "book_dorian"]) {
      const checkbox = root.querySelector<HTMLInputElement>(`[data-book-id="${bookId}"] [data-ui-action="toggle-book-selection"]`)!;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const bulkSend = root.querySelector<HTMLButtonElement>('[data-ui-action="bulk-send-to-kindle"]');
    expect(bulkSend).toMatchObject({ disabled: false });
    expect(bulkSend?.dataset.bookCount).toBe("2");
    bulkSend?.click();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([request]) => request.book.id)).toEqual(["book_time", "book_dorian"]);
    await vi.waitFor(() => expect(root.querySelector(".library-toast")?.textContent).toContain("2 books were sent"));
    expect(root.querySelector(".library-bulk-selection")?.textContent).toContain("0 selected");
  });

  it("confirms an exact per-item Kindle filename before invoking the removal hook", async () => {
    const remove = vi.fn(async (_request: CatalogRemoveRequest) => undefined);
    const { root, view } = await loadedView(fakeApi(), handlers({ onCatalogRemoveRequested: remove }));
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "confirmed"],
      ["book_dorian", "possible"],
    ]), new Map([
      ["prf_personal", { confirmed: 1, possible: 1, notOnKindle: 0, unknown: 0 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 2,
      truncated: false,
      metadata: { status: "complete", eligible: 2, enriched: 2, failed: 0, skipped: 0, truncated: false },
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [
        { id: "mtp-exact", filename: "The Time Machine - exact device copy.azw3", size: 812_345, managed: false, bookId: "book_time", match: "confirmed" },
        { id: "mtp-possible", filename: "Dorian Gray - uncertain.azw3", size: 900_000, managed: false, bookId: "book_dorian", match: "possible" },
      ],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1_012 },
      catalogInventoryState: "ready",
    });

    const exactRemove = root.querySelector<HTMLButtonElement>('[data-book-id="book_time"] [data-ui-action="remove-book-from-kindle"]');
    const possibleRemove = root.querySelector<HTMLButtonElement>('[data-book-id="book_dorian"] [data-ui-action="remove-book-from-kindle"]');
    expect(exactRemove).toMatchObject({ disabled: false });
    expect(possibleRemove).toMatchObject({ disabled: true });
    exactRemove?.click();

    const dialog = root.querySelector<HTMLElement>('.library-remove-sheet[role="alertdialog"]');
    expect(dialog?.textContent).toContain("The Time Machine - exact device copy.azw3");
    expect(remove).not.toHaveBeenCalled();
    click(root, '[data-ui-action="confirm-remove-from-kindle"]');

    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith({
      profileId: "prf_personal",
      targets: [{
        itemId: "mtp-exact",
        bookId: "book_time",
        title: "The Time Machine",
        filename: "The Time Machine - exact device copy.azw3",
        size: 812_345,
      }],
    });
    await vi.waitFor(() => expect(root.querySelector('.library-remove-sheet[role="alertdialog"]')).toBeNull());
    expect(root.querySelector(".library-toast")?.textContent).toContain("1 exact Kindle file was removed");
  });

  it("sends publication-year filters to the server", async () => {
    const { root, api } = await loadedView();
    const select = root.querySelector<HTMLSelectElement>("#library-year");
    if (!select) throw new Error("Missing year filter");
    select.value = "1895";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.listBooks).mock.calls.at(-1)?.[1]).toMatchObject({ year: "1895" }));
  });

  it("accepts exact metadata filters even when a value is outside the bounded facet suggestions", async () => {
    const { root, api } = await loadedView();
    const author = root.querySelector<HTMLInputElement>("#library-author");
    expect(author?.getAttribute("list")).toBe("library-author-options");
    setInput(author, "Unlisted Household Author");
    author?.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(vi.mocked(api.listBooks)).toHaveBeenLastCalledWith(
      "prf_personal",
      expect.objectContaining({ author: "Unlisted Household Author" }),
      expect.any(AbortSignal),
    ));
  });

  it("paginates through the backend instead of loading a large catalog into the browser", async () => {
    const api = fakeApi();
    vi.mocked(api.listBooks).mockImplementation(async (_profileId, query = {}) => ({
      items: (query.offset ?? 0) === 0 ? BOOKS.slice(0, 2) : [],
      total: 50,
      limit: query.limit ?? 24,
      offset: query.offset ?? 0,
    }));
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-action="catalog-page"][data-page-offset="24"]');
    await vi.waitFor(() => expect(vi.mocked(api.listBooks)).toHaveBeenCalledWith(
      "prf_personal",
      expect.objectContaining({ limit: 24, offset: 24 }),
      expect.any(AbortSignal),
    ));
  });

  it("reduces an oversized catalog page until valid books remain browsable with stable pagination", async () => {
    const api = fakeApi();
    vi.mocked(api.listBooks).mockImplementation(async (_profileId, query = {}) => {
      const limit = query.limit ?? 24;
      if (limit > 3) {
        throw new CatalogApiError(413, "response_too_large", "Catalog page exceeds its response limit");
      }
      return {
        items: BOOKS.slice(0, Math.min(limit, 2)),
        total: 8,
        limit,
        offset: query.offset ?? 0,
      };
    });

    const { root } = await loadedView(api);
    expect(vi.mocked(api.listBooks).mock.calls.slice(0, 4).map(([, query]) => query?.limit)).toEqual([
      24,
      12,
      6,
      3,
    ]);
    expect(root.querySelector('[data-book-id="book_time"]')).not.toBeNull();
    expect(root.querySelector(".library-error-state")).toBeNull();
    expect(root.querySelector(".library-pagination")?.textContent).toContain("1–2 of 8");

    click(root, 'button[data-ui-action="catalog-page"][data-page-offset="3"]');
    await vi.waitFor(() => expect(vi.mocked(api.listBooks)).toHaveBeenLastCalledWith(
      "prf_personal",
      expect.objectContaining({ limit: 3, offset: 3 }),
      expect.any(AbortSignal),
    ));
  });

  it("uses backend include-ID matching for confirmed and possible books before paginating the On Kindle view", async () => {
    const { root, view, api } = await loadedView();
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "confirmed"],
      ["book_dorian", "possible"],
    ]));
    click(root, 'button[data-ui-view="on-kindle"]');
    await vi.waitFor(() => expect(vi.mocked(api.queryBooks)).toHaveBeenCalledWith("prf_personal", expect.objectContaining({ includeBookIds: ["book_time", "book_dorian"] }), expect.any(AbortSignal)));
    expect(root.querySelector('[data-book-id="book_time"] .library-kindle-check')?.getAttribute("aria-label")).toBe("Already on this Kindle");
    expect(root.querySelector('[data-book-id="book_dorian"] .library-kindle-check')?.getAttribute("aria-label")).toBe("Possible Kindle match");
  });

  it("includes only proven-absent IDs in the Not on Kindle query", async () => {
    const { root, view, api } = await loadedView();
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "unknown"],
      ["book_dorian", "not-on-kindle"],
    ]));
    const select = root.querySelector<HTMLSelectElement>("#library-kindle-filter");
    if (!select) throw new Error("Missing Kindle filter");
    select.value = "not-on-kindle";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.queryBooks)).toHaveBeenCalledWith(
      "prf_personal",
      expect.objectContaining({ includeBookIds: ["book_dorian"] }),
      expect.any(AbortSignal),
    ));
  });

  it("preserves proven absences when current inventory presentation is attached", async () => {
    const { root, view, api } = await loadedView();
    view.setCatalogKindleStatuses(new Map([
      ["book_time", "confirmed"],
      ["book_dorian", "not-on-kindle"],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 1,
      truncated: false,
      items: [{ id: "mtp_1", filename: "time-machine.azw3", size: 10, managed: true, bookId: "book_time", match: "confirmed" }],
    });
    const select = root.querySelector<HTMLSelectElement>("#library-kindle-filter");
    if (!select) throw new Error("Missing Kindle filter");
    select.value = "not-on-kindle";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(vi.mocked(api.queryBooks)).toHaveBeenCalledWith(
      "prf_personal",
      expect.objectContaining({ includeBookIds: ["book_dorian"] }),
      expect.any(AbortSignal),
    ));

    view.setCatalogKindleInventory({
      deviceLabel: "Prior Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "last-seen",
      total: 1,
      truncated: false,
      items: [{ id: "mtp_1", filename: "time-machine.azw3", size: 10, managed: true, bookId: "book_time", match: "confirmed" }],
    });
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book_time"] .library-kindle-check')).toBeNull());
    expect(root.querySelector(".library-stat-row")?.textContent).toContain("0 matched here");
  });
});

describe("real catalog settings and device presentation", () => {
  it("warns before discarding a dirty Settings draft and labels it unsaved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { root } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    setInput(root.querySelector("#settings-library-name"), "Unsaved personal name");
    expect(root.querySelector(".settings-unsaved-chip")?.textContent).toContain("Unsaved changes");

    click(root, 'button[data-settings-library-id="prf_wife"]');
    expect(confirm).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Unsaved personal name");

    confirm.mockReturnValue(true);
    click(root, 'button[data-settings-library-id="prf_wife"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Wife's library"));
  });

  it("disables the complete Settings surface while a configuration save is in flight", async () => {
    const api = fakeApi();
    const originalSave = vi.mocked(api.saveConfiguration).getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(api.saveConfiguration).mockImplementation(async function (...args) {
      await pending;
      return originalSave.apply(api, args);
    });
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    setInput(root.querySelector("#settings-library-name"), "Saved after wait");
    click(root, 'button[data-ui-action="save-library-settings"]');

    await vi.waitFor(() => expect(root.querySelector("form.settings-editor")?.getAttribute("aria-busy")).toBe("true"));
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="new-library"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-settings-library-id="prf_wife"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="add-settings-folder"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="rescan-settings-folder"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="delete-library"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="cancel-library-settings"]')?.disabled).toBe(true);

    release();
    await vi.waitFor(() => expect(root.textContent).toContain("was saved on the Kindle Bridge server"));
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Saved after wait");
  });

  it("does not activate an inactive library merely because its Settings were saved", async () => {
    const { root, api, view } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    click(root, 'button[data-settings-library-id="prf_wife"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Wife's library"));
    setInput(root.querySelector("#settings-library-name"), "Wife's updated library");
    click(root, 'button[data-ui-action="save-library-settings"]');

    await vi.waitFor(() => expect(root.textContent).toContain("was saved on the Kindle Bridge server"));
    expect(view.activeCatalogProfileId).toBe("prf_personal");
    expect(window.localStorage.getItem("kindle-bridge.active-profile")).toBe("prf_personal");
    expect(api.profiles.find((profile) => profile.id === "prf_wife")?.name).toBe("Wife's updated library");
  });

  it("ignores a late folder response after another Settings library is selected", async () => {
    const api = fakeApi();
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    let resolveWifeRoots!: (roots: readonly CatalogRoot[]) => void;
    const wifeRoots = new Promise<readonly CatalogRoot[]>((resolve) => { resolveWifeRoots = resolve; });
    vi.mocked(api.listRoots).mockImplementation(async (profileId) => (
      profileId === "prf_wife" ? wifeRoots : api.roots[profileId] ?? []
    ));

    click(root, 'button[data-settings-library-id="prf_wife"]');
    await vi.waitFor(() => expect(api.listRoots).toHaveBeenCalledWith("prf_wife", expect.any(AbortSignal)));
    click(root, 'button[data-settings-library-id="prf_personal"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Your library"));

    resolveWifeRoots(api.roots.prf_wife);
    await Promise.resolve();
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Your library");
    expect(root.querySelector('.settings-library-option[aria-current="page"]')?.textContent).toContain("Your library");
  });

  it("ignores a late folder response after a new library draft is opened", async () => {
    const api = fakeApi();
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    let resolveWifeRoots!: (roots: readonly CatalogRoot[]) => void;
    const wifeRoots = new Promise<readonly CatalogRoot[]>((resolve) => { resolveWifeRoots = resolve; });
    vi.mocked(api.listRoots).mockImplementation(async (profileId) => (
      profileId === "prf_wife" ? wifeRoots : api.roots[profileId] ?? []
    ));

    click(root, 'button[data-settings-library-id="prf_wife"]');
    await vi.waitFor(() => expect(api.listRoots).toHaveBeenCalledWith("prf_wife", expect.any(AbortSignal)));
    click(root, 'button[data-ui-action="new-library"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("New library"));

    resolveWifeRoots(api.roots.prf_wife);
    await Promise.resolve();
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("New library");
    expect(root.querySelector(".settings-editor")?.textContent).toContain("Create library");
  });

  it("shows a retryable Settings error when roots fail to load", async () => {
    const api = fakeApi();
    vi.mocked(api.listRoots)
      .mockImplementationOnce(async (profileId) => api.roots[profileId] ?? [])
      .mockRejectedValueOnce(new Error("root service unavailable"))
      .mockImplementation(async (profileId) => api.roots[profileId] ?? []);
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    click(root, 'button[data-settings-library-id="prf_wife"]');

    await vi.waitFor(() => expect(root.querySelector(".settings-load-error")?.textContent).toContain("root service unavailable"));
    click(root, 'button[data-ui-action="retry-settings-library"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Wife's library"));
  });

  it("preserves Settings input focus and caret across an ordinary live catalog render", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const { root } = await loadedView(api);
    document.body.append(root);
    click(root, 'button[data-ui-view="settings"]');
    const input = root.querySelector<HTMLInputElement>("#settings-library-name")!;
    input.focus();
    input.setSelectionRange(2, 5);

    emitEvent?.({
      id: "event-focus",
      type: "book.updated",
      at: new Date().toISOString(),
      profileId: "prf_personal",
      bookId: "book_time",
    });

    const replacement = root.querySelector<HTMLInputElement>("#settings-library-name")!;
    expect(document.activeElement).toBe(replacement);
    expect([replacement.selectionStart, replacement.selectionEnd]).toEqual([2, 5]);
  });

  it("preserves an expanded filter and its uncommitted typed value across a live-update render", async () => {
    const api = fakeApi();
    let failEventStream: (() => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((_onEvent, onError, onOpen) => {
      failEventStream = onError;
      onOpen?.();
      return () => undefined;
    });
    const { root } = await loadedView(api);
    document.body.append(root);
    const details = root.querySelector<HTMLDetailsElement>(".library-more-filters")!;
    details.open = true;
    const input = root.querySelector<HTMLInputElement>("#library-subject")!;
    input.value = "unfinished subject";
    input.focus();
    input.setSelectionRange(3, 11);

    failEventStream?.();

    const replacementDetails = root.querySelector<HTMLDetailsElement>(".library-more-filters")!;
    const replacement = root.querySelector<HTMLInputElement>("#library-subject")!;
    expect(replacementDetails.open).toBe(true);
    expect(replacement.value).toBe("unfinished subject");
    expect(document.activeElement).toBe(replacement);
    expect([replacement.selectionStart, replacement.selectionEnd]).toEqual([3, 11]);
  });

  it("clears active catalog data before falling back from a disabled profile", async () => {
    const api = fakeApi();
    let resolveWifeBooks!: (value: CatalogBookPage) => void;
    const wifeBooks = new Promise<CatalogBookPage>((resolve) => { resolveWifeBooks = resolve; });
    vi.mocked(api.listBooks).mockImplementation(async (profileId, query = {}) => {
      if (profileId === "prf_wife") return wifeBooks;
      return page(BOOKS.filter((book) => book.profileId === profileId), query.offset, query.limit);
    });
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    await browser.start();
    await browser.setView("settings");
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_time", "book_dorian"]);
    browser.setSettingsDraft({ ...browser.snapshot.settingsDraft!, enabled: false });

    const saving = browser.saveSettings();
    await vi.waitFor(() => expect(browser.snapshot.filters.profileId).toBe("prf_wife"));
    expect(browser.snapshot.filters.view).toBe("settings");
    expect(browser.snapshot.page).toBeUndefined();
    expect(browser.snapshot.facets.authors).toEqual([]);

    resolveWifeBooks(page([BOOKS[2]!]));
    await saving;
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_frankenstein"]);
    expect(browser.snapshot.settingsLibraryId).toBe("prf_personal");
    expect(browser.snapshot.settingsDraft?.enabled).toBe(false);
    browser.dispose();
  });

  it("keeps the active third profile when an inactive Settings profile is deleted", async () => {
    const api = fakeApi();
    const thirdProfile: CatalogProfile = {
      id: "prf_third",
      name: "Shared research",
      description: "Third active scope",
      initial: "S",
      sourceLabel: "research",
      enabled: true,
      rootCount: 1,
      availableRootCount: 1,
      bookCount: 1,
    };
    const thirdRoot: CatalogRoot = {
      id: "root_third",
      profileId: thirdProfile.id,
      label: "research",
      path: "/libraries/research",
      recursive: true,
      watch: true,
      enabled: true,
      status: "available",
    };
    const thirdBook: CatalogBook = {
      ...BOOKS[0]!,
      id: "book_third",
      profileId: thirdProfile.id,
      rootId: thirdRoot.id,
      title: "Third Profile Book",
      sourceFilename: "third.epub",
    };
    api.profiles.push(thirdProfile);
    api.roots[thirdProfile.id] = [thirdRoot];
    vi.mocked(api.listBooks).mockImplementation(async (profileId, query = {}) => {
      if (profileId === "prf_third") return page([thirdBook], query.offset, query.limit);
      if (profileId === "prf_personal") throw new Error("first profile must not be reloaded");
      return page(BOOKS.filter((book) => book.profileId === profileId), query.offset, query.limit);
    });
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    // Let the initial profile load succeed before installing the deliberate A failure.
    vi.mocked(api.listBooks).mockImplementationOnce(async (_profileId, query = {}) => page(BOOKS.slice(0, 2), query.offset, query.limit));
    await browser.start();
    await browser.selectProfile(thirdProfile.id);
    await browser.setView("settings");
    await browser.selectSettingsLibrary("prf_wife");
    browser.requestDeleteSettings();
    await browser.confirmDeleteSettings();

    expect(browser.snapshot.filters.profileId).toBe(thirdProfile.id);
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual([thirdBook.id]);
    expect(browser.snapshot.settingsLibraryId).toBe(thirdProfile.id);
    expect(browser.snapshot.settingsDraft?.id).toBe(thirdProfile.id);
    browser.dispose();
  });

  it("creates a profile and its roots through one atomic idempotent configuration call", async () => {
    const { root, api } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector("#settings-heading")).not.toBeNull());
    click(root, 'button[data-ui-action="new-library"]');
    setInput(root.querySelector("#settings-library-name"), "Research shelf");
    setInput(root.querySelector("input[data-settings-folder-path]"), "/libraries/research");
    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(vi.mocked(api.saveConfiguration)).toHaveBeenCalledOnce());
    const [input, idempotencyKey] = vi.mocked(api.saveConfiguration).mock.calls[0];
    expect(input).toMatchObject({ profile: { name: "Research shelf" }, roots: [{ path: "/libraries/research", recursive: true, watch: true, enabled: true }] });
    expect(idempotencyKey).toMatch(/^catalog-config-/u);
    await vi.waitFor(() => expect(root.textContent).toContain("was saved on the Kindle Bridge server"));
  });

  it("reuses the same configuration idempotency key when a committed mutation is retried after refresh failure", async () => {
    const api = fakeApi();
    vi.mocked(api.listProfiles)
      .mockImplementationOnce(async () => api.profiles)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockImplementation(async () => api.profiles);
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    click(root, 'button[data-ui-action="new-library"]');
    setInput(root.querySelector("#settings-library-name"), "Retry-safe shelf");
    setInput(root.querySelector("input[data-settings-folder-path]"), "/libraries/retry-safe");

    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("refresh failed"));
    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(vi.mocked(api.saveConfiguration)).toHaveBeenCalledTimes(2));

    const firstKey = vi.mocked(api.saveConfiguration).mock.calls[0]?.[1];
    const secondKey = vi.mocked(api.saveConfiguration).mock.calls[1]?.[1];
    expect(firstKey).toMatch(/^catalog-config-/u);
    expect(secondKey).toBe(firstKey);
  });

  it("preserves unsaved Settings edits and the active profile across scanner events", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const { root, view } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    click(root, 'button[data-settings-library-id="prf_wife"]');
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Wife's library"));
    setInput(root.querySelector("#settings-library-name"), "Unsaved household edit");

    emitEvent?.({
      id: "event-1",
      type: "root.scan.completed",
      at: new Date().toISOString(),
      profileId: "prf_wife",
      rootId: "root_wife",
    });

    await vi.waitFor(() => expect(vi.mocked(api.listRoots).mock.calls.filter(([profileId]) => profileId === "prf_wife").length).toBeGreaterThan(1));
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Unsaved household edit");
    expect(view.activeCatalogProfileId).toBe("prf_personal");
  });

  it("refreshes inactive profile summaries and notifies live Kindle reconciliation on catalog events", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const onCatalogChanged = vi.fn(async () => undefined);
    const { root, view } = await loadedView(api, handlers({ onCatalogChanged }));
    api.profiles = api.profiles.map((profile) => profile.id === "prf_wife" ? { ...profile, bookCount: 7 } : profile);

    emitEvent?.({
      id: "event-inactive",
      type: "book.added",
      at: new Date().toISOString(),
      profileId: "prf_wife",
      bookId: "book-new",
    });

    await vi.waitFor(() => expect(onCatalogChanged).toHaveBeenCalledOnce());
    expect(root.querySelector('[data-ui-profile="prf_wife"]')?.textContent).toContain("7 books");
    expect(view.activeCatalogProfileId).toBe("prf_personal");
  });

  it("removes stale green evidence when live updates fail before a same-ID source replacement is fetched", async () => {
    const api = fakeApi();
    let failEventStream: (() => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((_onEvent, onError, onOpen) => {
      failEventStream = onError;
      onOpen?.();
      return () => undefined;
    });
    const { root, view } = await loadedView(api);
    view.setCatalogKindleStatuses(new Map([[
      "book_time", "confirmed",
    ]]), new Map([[
      "prf_personal", { confirmed: 1, possible: 0, notOnKindle: 1, unknown: 0 },
    ]]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 1,
      truncated: false,
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [{
        id: "mtp_time",
        filename: "time-machine.azw3",
        size: 900_000,
        managed: true,
        bookId: "book_time",
        match: "confirmed",
      }],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });
    expect(root.querySelector('[data-book-id="book_time"] .library-kindle-check[aria-label="Already on this Kindle"]')).not.toBeNull();

    failEventStream?.();
    const replacement = {
      ...BOOKS[0]!,
      title: "The Time Machine — replacement bytes",
      contentHash: "d".repeat(64),
      updatedAt: "2026-08-30T12:00:00Z",
    };
    vi.mocked(api.listBooks).mockResolvedValue(page([replacement]));
    setInput(root.querySelector("#library-search"), "replacement");

    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book_time"]')?.textContent).toContain("replacement bytes"));
    const replacementCard = root.querySelector<HTMLElement>('[data-book-id="book_time"]');
    expect(replacementCard?.querySelector('.library-kindle-check[aria-label="Already on this Kindle"]')).toBeNull();
    expect(replacementCard?.querySelector<HTMLButtonElement>('[data-ui-action="send-book"]')?.disabled).toBe(true);
    expect(replacementCard?.textContent).toContain("Inventory unavailable");
  });

  it("coalesces rapid cross-profile events without losing the active library refresh", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const { root } = await loadedView(api);
    const statusCallsBefore = vi.mocked(api.getStatus).mock.calls.length;
    const added: CatalogBook = {
      ...BOOKS[0]!,
      id: "book_new_shared",
      title: "New shared-root book",
      sourceFilename: "new-shared.epub",
      contentHash: "d".repeat(64),
    };
    vi.mocked(api.listBooks).mockResolvedValue(page([...BOOKS.slice(0, 2), added]));
    const wifeRootCallsBefore = vi.mocked(api.listRoots).mock.calls.filter(([profileId]) => profileId === "prf_wife").length;

    emitEvent?.({ id: "event-active", type: "book.added", at: new Date().toISOString(), profileId: "prf_personal", bookId: added.id });
    emitEvent?.({ id: "event-inactive-last", type: "book.added", at: new Date().toISOString(), profileId: "prf_wife", bookId: "book-wife-new" });

    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book_new_shared"]')).not.toBeNull());
    expect(vi.mocked(api.listRoots).mock.calls.filter(([profileId]) => profileId === "prf_wife").length).toBeGreaterThan(wifeRootCallsBefore);
    expect(vi.mocked(api.getStatus).mock.calls.length).toBeGreaterThan(statusCallsBefore);
  });

  it("does not let delayed event facets from the prior profile overwrite the newly selected profile", async () => {
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const onCatalogChanged = vi.fn(async () => undefined);
    const { root } = await loadedView(api, handlers({ onCatalogChanged }));
    const latePersonalFacets: CatalogFilters = {
      ...FACETS,
      authors: [{ value: "Late Personal Author", label: "Late Personal Author", count: 1 }],
    };
    const wifeFacets: CatalogFilters = {
      ...FACETS,
      authors: [{ value: "Mary Shelley", label: "Mary Shelley", count: 1 }],
      roots: [{ value: "root_wife", label: "wifelibrary", count: 1 }],
    };
    let resolveLatePersonal!: (facets: CatalogFilters) => void;
    const latePersonal = new Promise<CatalogFilters>((resolve) => { resolveLatePersonal = resolve; });
    let markPersonalRequestStarted!: () => void;
    const personalRequestStarted = new Promise<void>((resolve) => { markPersonalRequestStarted = resolve; });
    vi.mocked(api.getFilters).mockImplementation(async (profileId) => {
      if (profileId === "prf_personal") {
        markPersonalRequestStarted();
        return latePersonal;
      }
      return wifeFacets;
    });

    emitEvent?.({
      id: "event-delayed-personal-facets",
      type: "book.changed",
      at: new Date().toISOString(),
      profileId: "prf_personal",
      bookId: "book_time",
    });
    await personalRequestStarted;

    click(root, 'button[data-ui-profile="prf_wife"]');
    await vi.waitFor(() => expect(root.querySelector("#library-heading")?.textContent).toBe("Wife's library"));
    await vi.waitFor(() => {
      expect(root.querySelector('#library-author-options option[value="Mary Shelley"]')).not.toBeNull();
    });

    resolveLatePersonal(latePersonalFacets);
    await vi.waitFor(() => expect(onCatalogChanged).toHaveBeenCalledOnce());
    expect(root.querySelector('#library-author-options option[value="Mary Shelley"]')).not.toBeNull();
    expect(root.querySelector('#library-author-options option[value="Late Personal Author"]')).toBeNull();
  });

  it("does not let a stale Settings profile response overwrite a newer configuration event", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    let resolveStaleProfiles!: (profiles: readonly CatalogProfile[]) => void;
    const staleProfiles = new Promise<readonly CatalogProfile[]>((resolve) => { resolveStaleProfiles = resolve; });
    let profileCalls = 0;
    vi.mocked(api.listProfiles).mockImplementation(async () => {
      profileCalls += 1;
      if (profileCalls === 2) return staleProfiles;
      return api.profiles;
    });
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    await browser.start();
    await browser.setView("settings");

    const staleSelection = browser.selectSettingsLibrary("prf_wife", true);
    await vi.waitFor(() => expect(profileCalls).toBe(2));
    api.profiles = api.profiles.map((profile) => (
      profile.id === "prf_wife" ? { ...profile, name: "Current server name" } : profile
    ));
    emitEvent?.({
      id: "event-current-settings",
      type: "profile.updated",
      at: new Date().toISOString(),
      profileId: "prf_wife",
    });
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(browser.snapshot.settingsDraft?.name).toBe("Current server name"));

    resolveStaleProfiles(PROFILES);
    await staleSelection;
    expect(browser.snapshot.settingsDraft?.name).toBe("Current server name");
    expect(browser.snapshot.settingsConflict).toBe(false);
    browser.dispose();
  });

  it("reconciles a disabled active profile when Cancel force-loads missed server changes", async () => {
    const api = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    await browser.start();
    await browser.setView("settings");
    api.profiles = api.profiles.map((profile) => (
      profile.id === "prf_personal" ? { ...profile, enabled: false } : profile
    ));

    await browser.cancelSettingsChanges();

    expect(browser.snapshot.filters.profileId).toBe("prf_wife");
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_frankenstein"]);
    expect(browser.snapshot.settingsLibraryId).toBe("prf_personal");
    expect(browser.snapshot.settingsDraft?.enabled).toBe(false);
    browser.dispose();
  });

  it("keeps a newer successful book page when the superseded profile source load fails", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    let rejectInitialRoots!: (error: Error) => void;
    const initialRoots = new Promise<readonly CatalogRoot[]>((_resolve, reject) => { rejectInitialRoots = reject; });
    vi.mocked(api.listRoots).mockImplementationOnce(async () => initialRoots);
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    const starting = browser.start();
    await vi.waitFor(() => expect(api.listBooks).toHaveBeenCalledOnce());

    browser.updateFilter("query", "Dorian");
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_dorian"]));
    rejectInitialRoots(new Error("source roots failed after the page changed"));
    await starting;

    expect(browser.snapshot.booksState).toBe("ready");
    expect(browser.snapshot.stale).toBe(true);
    expect(browser.snapshot.error).toContain("source roots failed");
    browser.dispose();
  });

  it("validates container paths before making a mutation request", async () => {
    const { root, api } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector("form.settings-editor")).not.toBeNull());
    setInput(root.querySelector("input[data-settings-folder-path]"), "relative/books");
    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("absolute container path"));
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("rejects an unsafe mount sentinel before making a mutation request", async () => {
    const { root, api } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector("form.settings-editor")).not.toBeNull());
    setInput(root.querySelector("input[data-settings-folder-sentinel]"), "../wrong-volume");
    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("safe relative sentinel"));
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("allows the last configured folder to be disabled without deleting its Settings history", async () => {
    const { root, api } = await loadedView();
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector("form.settings-editor")).not.toBeNull());
    const enabled = root.querySelector<HTMLInputElement>("input[data-settings-folder-enabled]");
    expect(enabled?.checked).toBe(true);
    enabled?.click();
    expect(enabled?.checked).toBe(false);

    click(root, 'button[data-ui-action="save-library-settings"]');
    await vi.waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(vi.mocked(api.saveConfiguration).mock.calls[0]?.[0].roots).toEqual([
      expect.objectContaining({ id: "root_personal", enabled: false }),
    ]);
  });

  it("locks mutations in server-managed read-only mode but leaves source checks available", async () => {
    const api = fakeApi({ status: { ...STATUS, settingsMode: "read-only" } });
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector(".settings-locked-notice")?.textContent).toContain("Settings locked"));
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="new-library"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="save-library-settings"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-ui-action="rescan-settings-folder"]')?.disabled).toBe(false);
  });

  it("surfaces source and watcher warnings even when a folder is not actively watching", async () => {
    const api = fakeApi();
    api.roots.prf_personal = [{
      ...api.roots.prf_personal[0],
      watch: false,
      status: "paused",
      lastErrorCode: "source_errors:1",
    }];
    const { root } = await loadedView(api);
    click(root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(root.querySelector(".settings-health")?.textContent).toContain("source_errors:1"));

    const watcherApi = fakeApi();
    watcherApi.roots.prf_personal = [{
      ...watcherApi.roots.prf_personal[0],
      watch: true,
      status: "paused",
      lastErrorCode: "watch_unavailable",
    }];
    const watcherView = await loadedView(watcherApi);
    click(watcherView.root, 'button[data-ui-view="settings"]');
    await vi.waitFor(() => expect(watcherView.root.querySelector(".settings-health")?.textContent).toContain("scheduled checks continue"));
  });

  it("opens Settings without activating a disabled profile when no library is enabled", async () => {
    const api = fakeApi();
    api.profiles = api.profiles.map((profile) => ({ ...profile, enabled: false }));
    const root = document.createElement("div");
    new AppView(root, initialAppState(), handlers(), new DebugLog(), { catalogApi: api });

    await vi.waitFor(() => expect(root.querySelector("#settings-heading")).not.toBeNull());
    expect(root.querySelector<HTMLInputElement>("#settings-library-name")?.value).toBe("Your library");
    expect(api.listBooks).not.toHaveBeenCalled();
  });

  it("renders bounded current Kindle contents separately from matched catalog books", async () => {
    const { root, view } = await loadedView();
    view.setCatalogKindleInventory({
      deviceLabel: "Travel Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "partial",
      total: 2,
      metadata: { status: "partial", eligible: 1, enriched: 0, failed: 0, skipped: 1, truncated: true },
      matching: { status: "unavailable", matchedProfiles: 0, failedProfiles: 1 },
      truncated: false,
      items: [
        { id: "mtp_1", filename: "time-machine.azw3", title: "The Time Machine", author: "H. G. Wells", format: "AZW3", size: 900_000, path: "/documents/time-machine.azw3", managed: true, bookId: "book_time", match: "confirmed" },
        { id: "mtp_2", filename: "notes.pdf", format: "PDF", size: 42_000, path: "/documents/notes.pdf", managed: false, match: "unmatched" },
      ],
    });
    click(root, 'button[data-ui-view="on-kindle"]');
    await vi.waitFor(() => expect(root.querySelector("#device-contents-title")?.textContent).toContain("Travel Kindle"));
    expect(root.querySelector(".library-inventory-chip")?.textContent).toBe("Last seen");
    expect(root.querySelector('[data-kindle-object-id="mtp_1"]')?.textContent).toContain("Last seen match");
    expect(root.querySelector('[data-kindle-object-id="mtp_2"]')?.textContent).toContain("Last seen unmatched");
    expect(root.textContent).toContain("unread files remain unknown");
    expect(root.querySelector(".library-matching-notice")?.textContent).toContain("no green check is inferred");
  });

  it("reserves Only on Kindle for a current complete hierarchy, metadata pass, and catalog comparison", async () => {
    const { root, view } = await loadedView();
    const inventory = {
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete" as const,
      total: 1,
      truncated: false,
      matching: { status: "complete" as const, matchedProfiles: 1, failedProfiles: 0 },
      items: [{ id: "mtp_unmatched", filename: "unmatched.azw3", size: 42_000, managed: false, match: "unmatched" as const }],
    };
    view.setCatalogKindleInventory({
      ...inventory,
      metadata: { status: "partial", eligible: 1, enriched: 0, failed: 1, skipped: 0, truncated: false },
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });
    click(root, 'button[data-ui-view="on-kindle"]');
    expect(root.querySelector('[data-kindle-object-id="mtp_unmatched"]')?.textContent).toContain("Comparison unavailable");

    view.setCatalogKindleInventory({
      ...inventory,
      metadata: { status: "complete", eligible: 1, enriched: 1, failed: 0, skipped: 0, truncated: false },
    });
    expect(root.querySelector('[data-kindle-object-id="mtp_unmatched"]')?.textContent).toContain("Only on Kindle");
  });

  it("keeps late Kindle-only inventory items searchable and pages the full bounded presentation", async () => {
    const { root, view } = await loadedView();
    const items = Array.from({ length: 550 }, (_, index) => ({
      id: `mtp_${index}`,
      filename: `kindle-only-${index}.azw3`,
      title: index === 549 ? "Tail-only-device-book" : `Device book ${index}`,
      format: "AZW3",
      size: 1_000 + index,
      managed: false,
      match: "unmatched" as const,
    }));
    view.setCatalogKindleInventory({
      deviceLabel: "Large Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: items.length,
      truncated: false,
      items,
    });
    click(root, 'button[data-ui-view="on-kindle"]');
    await vi.waitFor(() => expect(root.querySelector(".library-device-pagination")?.textContent).toContain("1–100 of 550"));

    setInput(root.querySelector("#library-search"), "Tail-only-device-book");
    expect(root.querySelector('[data-kindle-object-id="mtp_549"]')?.textContent).toContain("Tail-only-device-book");
    expect(root.querySelector(".library-device-pagination")).toBeNull();
  });

  it("exposes transfer phases in the real send dialog", async () => {
    const send = vi.fn(async () => new Promise<void>(() => undefined));
    const { root, view } = await loadedView(fakeApi(), handlers({ onCatalogSendRequested: send }));
    view.setCatalogKindleStatuses(new Map([["book_time", "not-on-kindle"]]), new Map([
      ["prf_personal", { confirmed: 0, possible: 0, notOnKindle: 1, unknown: 1 }],
    ]));
    view.setCatalogKindleInventory({
      deviceLabel: "Current Kindle",
      scannedAt: new Date().toISOString(),
      completeness: "complete",
      total: 0,
      truncated: false,
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [],
    });
    view.render({
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1037 },
      catalogInventoryState: "ready",
    });
    click(root, '[data-book-id="book_time"] [data-ui-action="send-book"]');
    view.setCatalogTransferUpdate({ phase: "converting", progress: 37, message: "Converting a browser-local copy" });
    expect(root.querySelector(".library-transfer-status")?.textContent).toContain("Converting a browser-local copy");
    expect(root.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("37");
  });
});

describe("catalog browser request lifecycle", () => {
  it("times out a never-settling startup and allows an immediate retry", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    let startupSignal: AbortSignal | undefined;
    vi.mocked(api.getStatus)
      .mockImplementationOnce((signal) => {
        startupSignal = signal;
        return new Promise<CatalogServiceStatus>(() => undefined);
      })
      .mockResolvedValue(STATUS);
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined, { requestTimeoutMs: 20 });
    const starting = browser.start();

    await vi.advanceTimersByTimeAsync(20);
    await starting;
    expect(startupSignal?.aborted).toBe(true);
    expect(browser.snapshot).toMatchObject({ loadState: "error", booksState: "error" });
    expect(browser.snapshot.error).toContain("timed out");

    await browser.retry();
    expect(browser.snapshot).toMatchObject({ loadState: "ready", booksState: "ready" });
    browser.dispose();
  });

  it("bounds a never-settling page and aborts a superseded filter request", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined, { requestTimeoutMs: 20 });
    await browser.start();
    let neverSignal: AbortSignal | undefined;
    vi.mocked(api.listBooks).mockImplementation(async (_profileId, query = {}, signal) => {
      if (query.author === "Never") {
        neverSignal = signal;
        return new Promise<CatalogBookPage>(() => undefined);
      }
      const items = query.author === "Oscar Wilde" ? [BOOKS[1]!] : BOOKS.slice(0, 2);
      return page(items, query.offset, query.limit);
    });

    browser.updateFilter("author", "Never");
    await vi.advanceTimersByTimeAsync(20);
    expect(neverSignal?.aborted).toBe(true);
    expect(browser.snapshot).toMatchObject({ booksState: "ready", stale: true });
    expect(browser.snapshot.error).toContain("timed out");

    browser.updateFilter("author", "Oscar Wilde");
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_dorian"]);
    expect(browser.snapshot.stale).toBe(false);

    let supersededSignal: AbortSignal | undefined;
    vi.mocked(api.listBooks).mockImplementation(async (_profileId, query = {}, signal) => {
      if (query.author === "Slow") {
        supersededSignal = signal;
        return new Promise<CatalogBookPage>(() => undefined);
      }
      return page([BOOKS[0]!], query.offset, query.limit);
    });
    browser.updateFilter("author", "Slow");
    await Promise.resolve();
    browser.updateFilter("author", "H. G. Wells");
    await vi.advanceTimersByTimeAsync(0);
    expect(supersededSignal?.aborted).toBe(true);
    expect(browser.snapshot.page?.items.map((book) => book.id)).toEqual(["book_time"]);
    browser.dispose();
  });

  it("unlocks a timed-out Settings save and safely reuses its idempotency key", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const originalSave = vi.mocked(api.saveConfiguration).getMockImplementation();
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined, {
      requestTimeoutMs: 20,
      settingsMutationTimeoutMs: 25,
    });
    await browser.start();
    await browser.setView("settings");
    const draft = browser.snapshot.settingsDraft;
    if (!draft) throw new Error("Missing Settings draft");
    browser.setSettingsDraft({ ...draft, name: "Retry-safe Settings" });
    let saveSignal: AbortSignal | undefined;
    vi.mocked(api.saveConfiguration).mockImplementationOnce((_input, _key, signal) => {
      saveSignal = signal;
      return new Promise(() => undefined);
    });
    const saving = browser.saveSettings();

    await vi.advanceTimersByTimeAsync(25);
    await saving;
    expect(saveSignal?.aborted).toBe(true);
    expect(browser.snapshot.settingsSaving).toBe(false);
    expect(browser.snapshot.settingsError).toContain("timed out");
    const firstKey = vi.mocked(api.saveConfiguration).mock.calls[0]?.[1];

    if (!originalSave) throw new Error("Missing Settings save implementation");
    vi.mocked(api.saveConfiguration).mockImplementation(originalSave);
    await browser.saveSettings();
    expect(vi.mocked(api.saveConfiguration).mock.calls[1]?.[1]).toBe(firstKey);
    expect(browser.snapshot.settingsSaving).toBe(false);
    expect(browser.snapshot.settingsError).toBeUndefined();
    browser.dispose();
  });

  it("aborts a superseded Settings folder load instead of only ignoring its late result", async () => {
    const api = fakeApi();
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined, { requestTimeoutMs: 100 });
    await browser.start();
    await browser.setView("settings");
    let wifeSignal: AbortSignal | undefined;
    vi.mocked(api.listRoots).mockImplementation(async (profileId, signal) => {
      if (profileId === "prf_wife") {
        wifeSignal = signal;
        return new Promise<readonly CatalogRoot[]>(() => undefined);
      }
      return api.roots[profileId] ?? [];
    });

    const wifeLoad = browser.selectSettingsLibrary("prf_wife");
    await Promise.resolve();
    await browser.selectSettingsLibrary("prf_personal");
    await wifeLoad;

    expect(wifeSignal?.aborted).toBe(true);
    expect(browser.snapshot.settingsDraft?.id).toBe("prf_personal");
    browser.dispose();
  });

  it("keeps same-ID replacement evidence unknown before initial SSE open and across reconnect", async () => {
    const api = fakeApi();
    let openStream: (() => void) | undefined;
    let failStream: (() => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((_onEvent, onError, onOpen) => {
      openStream = onOpen;
      failStream = onError;
      return () => undefined;
    });
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined);
    await browser.start();

    browser.setKindleStatuses(new Map([
      ["book_time", "confirmed"],
      ["book_dorian", "not-on-kindle"],
    ]), new Map([
      ["prf_personal", { confirmed: 1, possible: 0, notOnKindle: 1, unknown: 0 }],
    ]));
    expect(browser.snapshot.liveUpdatesConnected).toBe(false);
    expect(browser.snapshot.kindleStatus.get("book_time")).toBe("unknown");
    expect(browser.snapshot.kindleStatus.get("book_dorian")).toBe("unknown");

    openStream?.();
    browser.setKindleStatuses(new Map([
      ["book_time", "confirmed"],
      ["book_dorian", "not-on-kindle"],
    ]));
    expect(browser.snapshot.kindleStatus.get("book_time")).toBe("confirmed");
    failStream?.();
    vi.mocked(api.listBooks).mockResolvedValue(page([{
      ...BOOKS[0]!,
      contentHash: "f".repeat(64),
      title: "Same ID, replacement bytes",
    }]));
    await browser.reloadBooks();

    expect(browser.snapshot.liveUpdatesConnected).toBe(false);
    expect(browser.snapshot.page?.items[0]?.title).toContain("replacement bytes");
    expect(browser.snapshot.kindleStatus.get("book_time")).toBe("unknown");
    expect(browser.snapshot.kindleStatus.get("book_dorian")).toBe("unknown");
    browser.dispose();
  });

  it("aborts the actual nested event page fetch at the outer refresh deadline and ignores late bytes", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    vi.mocked(api.subscribeEvents).mockImplementation((onEvent, _onError, onOpen) => {
      emitEvent = onEvent;
      onOpen?.();
      return () => undefined;
    });
    const browser = new CatalogBrowser(api, {}, () => undefined, undefined, { requestTimeoutMs: 20 });
    await browser.start();
    const originalPage = browser.snapshot.page;
    let pageSignal: AbortSignal | undefined;
    let resolveLatePage!: (page: CatalogBookPage) => void;
    vi.mocked(api.listBooks).mockImplementation((_profileId, _query = {}, signal) => {
      pageSignal = signal;
      return new Promise<CatalogBookPage>((resolve) => { resolveLatePage = resolve; });
    });

    emitEvent?.({
      id: "event-nested-page-deadline",
      type: "book.changed",
      at: new Date().toISOString(),
      profileId: "prf_personal",
      bookId: "book_time",
    });
    await vi.advanceTimersByTimeAsync(180);
    expect(pageSignal).toBeDefined();

    await vi.advanceTimersByTimeAsync(20);
    expect(pageSignal?.aborted).toBe(true);
    expect(browser.snapshot.page).toBe(originalPage);
    expect(browser.snapshot.stale).toBe(true);
    expect(browser.snapshot.error).toContain("timed out");

    resolveLatePage(page([{
      ...BOOKS[0]!,
      title: "Late replacement must never render",
      contentHash: "e".repeat(64),
    }]));
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.snapshot.page).toBe(originalPage);
    expect(browser.snapshot.page?.items[0]?.title).not.toContain("Late replacement");
    browser.dispose();
  });
});
