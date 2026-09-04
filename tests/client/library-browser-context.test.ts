// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { CatalogApi, CatalogEvent, CatalogProfile } from "../../client/src/catalog-client";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import {
  LIBRARY_BROWSER_CONTEXT_STORAGE_KEY,
  readLibraryBrowserContext,
  writeLibraryBrowserContext,
} from "../../client/src/library-browser-context";
import { initialLibraryFilters } from "../../client/src/library-prototype";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe("versioned per-profile browser context", () => {
  it("round-trips independent profile state and safely defaults corrupt input", () => {
    const storage = memoryStorage();
    writeLibraryBrowserContext(storage, { filters: { ...initialLibraryFilters("one"), query: "dune", author: "Frank Herbert", sort: "series-index", offset: 24 }, layout: "list", density: "compact", scrollY: 812, activeShelfId: "builtin-favorites", sendQueueOpen: true, shelfManagerOpen: true, seriesSort: "count", healthFilter: { type: "suspected-duplicate", severity: "warning", ignored: true } });
    writeLibraryBrowserContext(storage, { filters: { ...initialLibraryFilters("two"), sort: "series" }, layout: "grid", density: "comfortable", scrollY: 11 });

    expect(readLibraryBrowserContext(storage, "one")).toMatchObject({ layout: "list", density: "compact", scrollY: 812, activeShelfId: "builtin-favorites", sendQueueOpen: true, shelfManagerOpen: true, seriesSort: "count", healthFilter: { type: "suspected-duplicate", severity: "warning", ignored: true }, filters: { profileId: "one", query: "dune", author: "Frank Herbert", sort: "series-index", offset: 24 } });
    expect(readLibraryBrowserContext(storage, "two")).toMatchObject({ layout: "grid", density: "comfortable", scrollY: 11, filters: { profileId: "two", sort: "series" } });

    const corrupt = memoryStorage({ [LIBRARY_BROWSER_CONTEXT_STORAGE_KEY]: "{not json" });
    expect(readLibraryBrowserContext(corrupt, "one")).toMatchObject({ layout: "grid", density: "comfortable", scrollY: 0, filters: { query: "", offset: 0 } });

    const payload = JSON.parse(storage.values.get(LIBRARY_BROWSER_CONTEXT_STORAGE_KEY)!) as { entries: Array<Record<string, unknown>> };
    payload.entries[0]!.healthFilter = { type: "invented", severity: "fatal", ignored: "yes" };
    storage.values.set(LIBRARY_BROWSER_CONTEXT_STORAGE_KEY, JSON.stringify(payload));
    expect(readLibraryBrowserContext(storage, "two").healthFilter).toEqual({ type: "all", severity: "all", ignored: false });

    writeLibraryBrowserContext(storage, { filters: initialLibraryFilters("three"), layout: "grid", density: "comfortable", scrollY: 0, activeShelfId: "bad\nshelf" });
    expect(readLibraryBrowserContext(storage, "three").activeShelfId).toBeUndefined();
  });

  it("restores and updates context through CatalogBrowser without making persistence authoritative", async () => {
    const storage = memoryStorage();
    writeLibraryBrowserContext(storage, { filters: { ...initialLibraryFilters("p"), query: "remembered", sort: "author" }, layout: "list", density: "compact", scrollY: 420 });
    storage.setItem("kindle-bridge.active-profile", "p");
    const profile: CatalogProfile = { id: "p", name: "Home", description: "Home", initial: "H", sourceLabel: "Books", enabled: true, rootCount: 0, availableRootCount: 0, bookCount: 0 };
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      listRoots: vi.fn().mockResolvedValue([]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 }),
      subscribeEvents: vi.fn().mockReturnValue(() => undefined),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, storage);
    await browser.start();

    expect(browser.snapshot).toMatchObject({ layout: "list", density: "compact", contextScrollY: 420, filters: { profileId: "p", query: "remembered", sort: "author" } });
    browser.setLayout("grid");
    browser.setDensity("comfortable");
    browser.setScrollPosition(77);
    expect(readLibraryBrowserContext(storage, "p")).toMatchObject({ layout: "grid", density: "comfortable", scrollY: 77 });
    browser.dispose();
  });

  it("restores a replacement profile's saved non-All view outside a Settings refresh", async () => {
    const storage = memoryStorage();
    const first: CatalogProfile = { id: "one", name: "One", description: "One", initial: "O", sourceLabel: "One", enabled: true, rootCount: 0, availableRootCount: 0, bookCount: 0 };
    const second: CatalogProfile = { id: "two", name: "Two", description: "Two", initial: "T", sourceLabel: "Two", enabled: true, rootCount: 0, availableRootCount: 0, bookCount: 0 };
    storage.setItem("kindle-bridge.active-profile", first.id);
    writeLibraryBrowserContext(storage, {
      filters: { ...initialLibraryFilters(second.id), view: "recent", sort: "recent" },
      layout: "list",
      density: "compact",
      scrollY: 120,
    });
    let profiles: readonly CatalogProfile[] = [first, second];
    let emitEvent: ((event: CatalogEvent) => void) | undefined;
    const api = {
      getStatus: vi.fn().mockResolvedValue({ available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" }),
      listProfiles: vi.fn(async () => profiles),
      listRoots: vi.fn().mockResolvedValue([]),
      getFilters: vi.fn().mockResolvedValue({ authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] }),
      listBooks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 }),
      subscribeEvents: vi.fn((onEvent: (event: CatalogEvent) => void, _onError: unknown, opened: () => void) => {
        emitEvent = onEvent;
        opened();
        return () => undefined;
      }),
    } as unknown as CatalogApi;
    const browser = new CatalogBrowser(api, {}, () => undefined, storage);
    await browser.start();
    expect(browser.snapshot.filters.profileId).toBe(first.id);

    profiles = [second];
    emitEvent?.({ id: "profile-one-deleted", type: "profile.deleted", at: "2026-09-04T12:00:00Z", profileId: first.id });
    await vi.waitFor(() => expect(browser.snapshot.filters.profileId).toBe(second.id));

    expect(browser.snapshot.filters.view).toBe("recent");
    expect(browser.snapshot.layout).toBe("list");
    expect(browser.snapshot.density).toBe("compact");
    browser.dispose();
  });
});
