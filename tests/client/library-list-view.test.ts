// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CatalogBrowserSnapshot, CatalogKindleInventory } from "../../client/src/catalog-browser";
import type { CatalogBook, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { renderLibraryPrototype, renderLibraryResults } from "../../client/src/library-prototype-view";
import { initialAppState, type AppState } from "../../client/src/state";

const PROFILE: CatalogProfile = {
  id: "prf_household",
  name: "Household library",
  description: "Home collection",
  initial: "H",
  sourceLabel: "books",
  enabled: true,
  rootCount: 1,
  availableRootCount: 1,
  bookCount: 3,
};

const ROOT: CatalogRoot = {
  id: "root_books",
  profileId: PROFILE.id,
  label: "books",
  path: "/libraries/books",
  recursive: true,
  watch: true,
  enabled: true,
  status: "watching",
};

function book(id: string, title: string): CatalogBook {
  return {
    id,
    profileId: PROFILE.id,
    rootId: ROOT.id,
    sourceFilename: `${id}.epub`,
    title,
    authors: ["Test Author"],
    authorSort: "Author, Test",
    language: "en",
    subjects: ["Testing"],
    identifiers: [],
    format: "epub",
    size: 1_024,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    addedAt: "2026-08-31T08:00:00Z",
    updatedAt: "2026-08-31T08:00:00Z",
    metadataComplete: true,
    available: true,
  };
}

const CONFIRMED = book("book_confirmed", "Confirmed book");
const ABSENT = book("book_absent", "Book to send");
const POSSIBLE = book("book_possible", "Possible book");
const BOOKS = [CONFIRMED, ABSENT, POSSIBLE] as const;

const INVENTORY: CatalogKindleInventory = {
  deviceLabel: "Current Kindle",
  scannedAt: "2026-08-31T08:05:00Z",
  completeness: "complete",
  total: 2,
  truncated: false,
  metadata: { status: "complete", eligible: 2, enriched: 2, failed: 0, skipped: 0, truncated: false },
  matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
  items: [
    { id: "mtp-confirmed", filename: "Confirmed book.azw3", size: 900, managed: false, bookId: CONFIRMED.id, match: "confirmed" },
    { id: "mtp-possible", filename: "Possible book.azw3", size: 901, managed: false, bookId: POSSIBLE.id, match: "possible" },
  ],
};

function snapshot(overrides: Partial<CatalogBrowserSnapshot> = {}): CatalogBrowserSnapshot {
  return {
    loadState: "ready",
    serviceStatus: { available: true, state: "ready", settingsMode: "read-write", database: "ready", cache: "ready" },
    profiles: [PROFILE],
    rootsByProfile: new Map([[PROFILE.id, [ROOT]]]),
    filters: initialLibraryFilters(PROFILE.id),
    facets: EMPTY_CATALOG_FILTERS,
    page: { items: BOOKS, total: BOOKS.length, limit: 24, offset: 0 },
    booksState: "ready",
    stale: false,
    liveUpdatesConnected: true,
    settingsSaving: false,
    settingsRefreshing: false,
    settingsConflict: false,
    settingsDirty: false,
    rescanningRootIds: new Set(),
    sendBusy: false,
    kindleStatus: new Map([
      [CONFIRMED.id, "confirmed"],
      [ABSENT.id, "not-on-kindle"],
      [POSSIBLE.id, "possible"],
    ]),
    kindleStatusCountsByProfile: new Map([[PROFILE.id, { confirmed: 1, possible: 1, notOnKindle: 1, unknown: 0 }]]),
    kindleInventory: INVENTORY,
    kindleInventoryOffset: 0,
    layout: "grid",
    selectedBookIds: new Set(),
    bulkActionBusy: false,
    sendQueueState: "ready",
    sendQueueOpen: false,
    sendQueueBusy: false,
    seriesState: "idle",
    seriesQuery: "",
    seriesSort: "name",
    smartShelves: [],
    smartShelvesState: "ready",
    shelfManagerOpen: false,
    annotations: new Map(),
    healthState: "ready",
    healthBooks: new Map(),
    healthFilter: { type: "all", severity: "all", ignored: false },
    metadataLookupState: "ready",
    metadataLookupBusy: false,
    activityOpen: false,
    activityEvents: [],
    ...overrides,
  };
}

function readyState(): AppState {
  return {
    ...initialAppState(),
    device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
    selfTest: { kind: "passed", byteLength: 1_012 },
    catalogInventoryState: "ready",
  };
}

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("library list view and Kindle actions", () => {
  it("explains that a disconnected Kindle-dependent shelf needs a fresh comparison", () => {
    const root = render(renderLibraryResults(initialAppState(), snapshot({
      page: { items: [], total: 0, limit: 24, offset: 0 },
      filters: { ...initialLibraryFilters(PROFILE.id), kindle: "not-on-kindle" },
      activeShelf: {
        id: "builtin-not-on-kindle",
        name: "Not on Kindle",
        query: { version: 1, kindleStatus: "not-on-kindle" },
        builtIn: true,
      },
      kindleStatus: new Map(),
      kindleStatusCountsByProfile: new Map(),
      kindleInventory: undefined,
    })));
    expect(root.querySelector(".library-empty-state")?.textContent).toContain("Connect to compare");
    expect(root.querySelector(".library-empty-state")?.textContent).not.toContain("No books found");
  });

  it("keeps the library usable while explaining and disabling an unsupported Kindle connection", () => {
    const state: AppState = {
      ...initialAppState(),
      secureContext: false,
      webUsbAvailable: true,
      device: { kind: "disconnected" },
    };
    const root = render(renderLibraryPrototype(state, snapshot()));
    expect(root.querySelector(".library-compatibility-notice")?.textContent).toContain("trusted HTTPS or localhost");
    expect(root.querySelector<HTMLButtonElement>('.library-device-button[data-ui-action="connect-catalog-device"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="open-send-queue"]')?.disabled).toBe(false);
    expect(root.querySelector("#library-search")).not.toBeNull();
  });

  it("shows the bounded newly-indexed count in the quiet activity center", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      activityOpen: true,
      activityEvents: [{
        version: 1,
        id: "scan-complete",
        kind: "catalog-scan",
        at: "2026-09-04T08:00:00.000Z",
        tone: "success",
        title: "Library index updated",
        profileId: PROFILE.id,
        newlyIndexed: 2,
        acknowledged: false,
      }],
    })));
    expect(root.querySelector(".activity-current")?.textContent).toContain("2 newly indexed");
  });

  it("surfaces restart-safe metadata work in Activity with its exact Needs Attention action", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      activityOpen: true,
      metadataLookupJobs: {
        items: [{
          id: "lookup-paused",
          profileId: PROFILE.id,
          provider: "google-books",
          status: "paused",
          revision: 4,
          entriesIncluded: false,
          entries: [],
          total: 10,
          pending: 3,
          ready: 5,
          noResults: 1,
          failed: 1,
          cancelled: 0,
          createdAt: "2026-09-04T08:00:00.000Z",
          updatedAt: "2026-09-04T08:05:00.000Z",
        }],
        total: 1,
        limit: 100,
        offset: 0,
      },
    })));
    const job = root.querySelector(".activity-metadata-job");
    expect(job?.textContent).toContain("Google Books · paused");
    expect(job?.textContent).toContain("5 ready · 3 pending · 1 failed · 1 without results");
    expect(job?.querySelector('[data-ui-action="open-activity-metadata-job"]')?.getAttribute("data-job-id"))
      .toBe("lookup-paused");
  });

  it("states Kindle-only source and deletion status without authorizing a fuzzy candidate", () => {
    const deviceOnly = {
      id: "mtp-device-only",
      filename: "Only on Kindle.azw3",
      size: 901,
      managed: false,
      match: "unmatched" as const,
    };
    const unassociated = render(renderLibraryPrototype(readyState(), snapshot({
      kindleInventory: { ...INVENTORY, total: 1, items: [deviceOnly] },
      matchReview: {
        itemId: deviceOnly.id,
        loadState: "ready",
        books: new Map(),
        busy: false,
      },
    })));
    expect(unassociated.querySelector(".match-review-source-removal")?.textContent)
      .toContain("No catalog source is associated with this Kindle file");
    const deviceOnlyRemove = unassociated.querySelector<HTMLButtonElement>('.match-review-source-removal [data-ui-action="remove-book-from-kindle"]');
    expect(deviceOnlyRemove?.disabled).toBe(true);
    expect(deviceOnlyRemove?.title).toContain("never enough authority to delete");

    const fuzzy = { ...INVENTORY.items[1]!, candidates: [] };
    const possible = render(renderLibraryPrototype(readyState(), snapshot({
      kindleInventory: { ...INVENTORY, total: 1, items: [fuzzy] },
      matchReview: {
        itemId: fuzzy.id,
        requestedBookId: POSSIBLE.id,
        loadState: "ready",
        books: new Map([[POSSIBLE.id, POSSIBLE]]),
        busy: false,
      },
    })));
    expect(possible.querySelector(".match-review-source-removal")?.textContent)
      .toContain("Possible catalog source: Possible book");
    expect(possible.querySelector<HTMLButtonElement>('.match-review-source-removal [data-ui-action="remove-book-from-kindle"]')?.disabled)
      .toBe(true);
  });

  it("offers an accessible grid/list toggle and keeps selection controls list-only", () => {
    const grid = render(renderLibraryResults(readyState(), snapshot()));
    expect(grid.querySelector('[data-ui-action="set-library-layout"][data-layout="grid"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(grid.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-label")).toBe("List view");
    expect(grid.querySelector('[data-ui-action="set-library-density"][data-density="compact"]')?.getAttribute("aria-label")).toBe("Compact density");
    expect(grid.querySelector('[data-ui-action="toggle-book-selection"]')).toBeNull();
    expect(grid.querySelectorAll('[data-ui-action="open-book-details"]')).toHaveLength(BOOKS.length * 2);
    expect(grid.querySelectorAll('[data-ui-action="remove-book-from-kindle"]')).toHaveLength(BOOKS.length);

    const list = render(renderLibraryResults(readyState(), snapshot({ layout: "list" })));
    expect(list.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(list.querySelectorAll('[data-ui-action="toggle-book-selection"]')).toHaveLength(BOOKS.length);
    expect(list.querySelector('[role="toolbar"][aria-label="Selected book actions"]')).not.toBeNull();
  });

  it("renders effective, source, and current-device evidence in one read-only details drawer", () => {
    const detailBook = { ...CONFIRMED, publisher: "Example Press", series: "Example Series", description: "A useful description.", metadataEdited: true };
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      bookDetails: {
        profileId: PROFILE.id,
        bookId: CONFIRMED.id,
        loadState: "ready",
        book: detailBook,
        data: {
          book: detailBook,
          sourceMetadata: {
            title: "Original title", authors: ["Test Author"], authorSort: "Author, Test", language: "en",
            publisher: "Source press", publishedAt: null, series: "Example Series", seriesIndex: null,
            description: "Original description", subjects: ["Testing"], identifiers: [],
          },
          sourceCoverUrl: null,
          overrides: { publisher: "Example Press" },
          revision: 1,
          basedOnContentHash: detailBook.contentHash!,
          sourceChanged: false,
          coverOverride: null,
          source: {
            rootId: ROOT.id,
            rootLabel: "Read-only NAS",
            rootPath: "/libraries/books",
            rootStatus: "watching",
            rootLastScanAt: "2026-08-31T08:00:00Z",
            relativePath: "series/Confirmed book.epub",
            available: true,
          },
          latestVerifiedDelivery: {
            filename: "Confirmed book.azw3",
            size: 900,
            deliveredAt: "2026-08-31T08:04:00Z",
            currentPresentation: true,
          },
        },
      },
    })));
    const dialog = root.querySelector<HTMLElement>('.library-book-details-sheet[role="dialog"]');
    expect(dialog?.textContent).toContain("Confirmed book");
    expect(dialog?.textContent).toContain("Example Press");
    expect(dialog?.textContent).toContain("/libraries/books");
    expect(dialog?.textContent).toContain("series/Confirmed book.epub");
    expect(dialog?.textContent).toContain("Confirmed on this Kindle");
    expect(dialog?.textContent).toContain("Confirmed book.azw3");
    expect(dialog?.textContent).toContain("Last verified transfer");
    expect(dialog?.textContent).toContain("Matches the current catalog presentation");
    expect(dialog?.querySelector('[data-ui-action="book-details-filter"][data-filter-key="series"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-ui-action="close-book-details"]')).not.toBeNull();
  });

  it("enables bulk removal only for exact confirmed objects while retaining bulk Send", () => {
    const root = render(renderLibraryResults(readyState(), snapshot({
      layout: "list",
      selectedBookIds: new Set(BOOKS.map(({ id }) => id)),
    })));

    const bulkSend = root.querySelector<HTMLButtonElement>('[data-ui-action="bulk-send-to-kindle"]');
    const bulkRemove = root.querySelector<HTMLButtonElement>('[data-ui-action="bulk-remove-from-kindle"]');
    expect(bulkSend).toMatchObject({ disabled: false });
    expect(bulkSend?.dataset.bookCount).toBe("1");
    expect(bulkRemove).toMatchObject({ disabled: false });
    expect(bulkRemove?.dataset.bookCount).toBe("1");

    expect(root.querySelector<HTMLButtonElement>('[data-book-id="book_confirmed"] [data-ui-action="remove-book-from-kindle"]')?.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-book-id="book_possible"] [data-ui-action="remove-book-from-kindle"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-book-id="book_absent"] [data-ui-action="remove-book-from-kindle"]')?.disabled).toBe(true);

    const withoutWriteProof = render(renderLibraryResults({ ...readyState(), selfTest: { kind: "not-run" } }, snapshot({
      layout: "list",
      selectedBookIds: new Set(BOOKS.map(({ id }) => id)),
    })));
    expect(withoutWriteProof.querySelector<HTMLButtonElement>('[data-ui-action="bulk-send-to-kindle"]'))
      .toMatchObject({ disabled: true });
    expect(withoutWriteProof.querySelector<HTMLButtonElement>('[data-ui-action="bulk-remove-from-kindle"]'))
      .toMatchObject({ disabled: true });
  });

  it("confirms the exact Kindle filenames without opening a separate removal panel", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      pendingRemoval: {
        profileId: PROFILE.id,
        targets: [
          { itemId: "mtp-confirmed", bookId: CONFIRMED.id, title: CONFIRMED.title, filename: "Confirmed book (device copy).azw3", size: 900 },
        ],
      },
    })));

    const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Confirmed book (device copy).azw3");
    expect(dialog?.textContent).toContain("Library originals are not changed");
    expect(dialog?.querySelector('[data-ui-action="cancel-remove-from-kindle"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-ui-action="confirm-remove-from-kindle"]')?.textContent).toContain("Remove file");
    expect(root.querySelector(".library-device-contents")).toBeNull();
  });

  it("counts books and exact files separately when one book has duplicate device copies", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      pendingRemoval: {
        profileId: PROFILE.id,
        targets: [
          { itemId: "mtp-confirmed-a", bookId: CONFIRMED.id, title: CONFIRMED.title, filename: "Confirmed book.azw3", size: 900 },
          { itemId: "mtp-confirmed-b", bookId: CONFIRMED.id, title: CONFIRMED.title, filename: "Confirmed book copy.azw3", size: 901 },
        ],
      },
    })));

    const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.querySelector("h2")?.textContent).toContain(`“${CONFIRMED.title}”`);
    expect(dialog?.textContent).toContain("2 exact matched files");
    expect(dialog?.querySelector('[data-ui-action="confirm-remove-from-kindle"]')?.textContent).toContain("Remove 2 files");
  });

  it("disables Kindle action controls consistently while a single send is active", () => {
    const root = render(renderLibraryResults(readyState(), snapshot({ layout: "list", sendBusy: true })));

    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="set-library-layout"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-ui-action="toggle-book-selection"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-book-id="book_confirmed"] [data-ui-action="remove-book-from-kindle"]')?.disabled).toBe(true);
  });

  it("shows the persistent queue count, stale eligibility, and explicitly approximate capacity", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      sendQueueOpen: true,
      sendQueue: {
        profileId: PROFILE.id,
        revision: 4,
        entries: [{
          profileId: PROFILE.id,
          bookId: ABSENT.id,
          rank: 0,
          queuedContentHash: ABSENT.contentHash!,
          queuedPresentationVersion: "presentation-v1",
          createdAt: "2026-09-03T08:00:00Z",
          updatedAt: "2026-09-03T08:00:00Z",
          book: ABSENT,
          sourceState: "source-changed",
        }],
        total: 1,
        totalSourceBytes: ABSENT.size,
      },
    })));

    expect(root.querySelector('[data-ui-action="open-send-queue"] strong')?.textContent).toBe("1");
    const dialog = root.querySelector<HTMLElement>('.library-queue-sheet[role="dialog"]');
    expect(dialog?.textContent).toContain("Source changed after it was queued");
    expect(dialog?.textContent).toContain("Approximate transfer size");
    expect(dialog?.textContent).toContain("estimate, not a reservation");
    expect(dialog?.querySelector<HTMLButtonElement>('[data-ui-action="send-queued-books"]')?.disabled).toBe(true);
  });

  it("projects write-proof and busy gates into queue rows and activity retries", () => {
    const queued = {
      profileId: PROFILE.id,
      revision: 4,
      entries: [{
        profileId: PROFILE.id,
        bookId: ABSENT.id,
        rank: 0,
        queuedContentHash: ABSENT.contentHash!,
        queuedPresentationVersion: "presentation-v1",
        createdAt: "2026-09-03T08:00:00Z",
        updatedAt: "2026-09-03T08:00:00Z",
        book: ABSENT,
        sourceState: "ready" as const,
      }],
      total: 1,
      totalSourceBytes: ABSENT.size,
    };
    const activityEvents = [{
      version: 1 as const,
      id: "batch-failure",
      kind: "failure" as const,
      at: "2026-09-04T08:00:00.000Z",
      tone: "error" as const,
      title: "Kindle batch stopped",
      action: "retry-transfer" as const,
      acknowledged: false,
    }];
    const withoutProof = render(renderLibraryPrototype(
      { ...readyState(), selfTest: { kind: "not-run" } },
      snapshot({
        layout: "list",
        selectedBookIds: new Set([ABSENT.id]),
        sendQueueOpen: true,
        sendQueue: queued,
        activityOpen: true,
        activityEvents,
      }),
    ));
    const queuedRow = withoutProof.querySelector<HTMLElement>(`[data-queue-book-id="${ABSENT.id}"]`);
    expect(queuedRow?.textContent).toContain("Complete the Kindle safety and inventory checks first");
    expect(withoutProof.querySelector<HTMLButtonElement>('[data-ui-action="send-queued-books"]')?.disabled).toBe(true);
    expect(withoutProof.querySelector<HTMLButtonElement>('[data-event-action="retry-transfer"]')?.disabled).toBe(true);

    const ready = render(renderLibraryPrototype(
      readyState(),
      snapshot({
        layout: "list",
        selectedBookIds: new Set([ABSENT.id]),
        sendQueueOpen: true,
        sendQueue: queued,
        activityOpen: true,
        activityEvents,
      }),
    ));
    expect(ready.querySelector(`[data-queue-book-id="${ABSENT.id}"]`)?.textContent).toContain("Ready · browser copy will be converted");
    expect(ready.querySelector<HTMLButtonElement>('[data-ui-action="send-queued-books"]')?.disabled).toBe(false);
    expect(ready.querySelector<HTMLButtonElement>('[data-event-action="retry-transfer"]')?.disabled).toBe(false);

    const busy = render(renderLibraryPrototype(
      readyState(),
      snapshot({ sendQueueOpen: true, sendQueue: queued, sendQueueBusy: true }),
    ));
    expect(busy.querySelector(`[data-queue-book-id="${ABSENT.id}"]`)?.textContent).toContain("Another Kindle action is in progress");
    expect(busy.querySelector<HTMLButtonElement>('[data-ui-action="send-queued-books"]')?.disabled).toBe(true);
  });

  it("exposes built-in and pinned smart shelves without implying reading progress", () => {
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      shelfManagerOpen: true,
      activeShelf: {
        id: "builtin-missing-cover",
        name: "Missing cover",
        query: { version: 1, catalog: { coverAvailable: false } },
        builtIn: true,
      },
      smartShelves: [{
        id: "shelf-weekend",
        profileId: PROFILE.id,
        name: "Weekend",
        query: { version: 1, catalog: { language: "en" } },
        pinnedRank: 0,
        revision: 1,
        serverCount: 2,
        createdAt: "2026-09-03T08:00:00Z",
        updatedAt: "2026-09-03T08:00:00Z",
      }],
    })));

    const rail = root.querySelector<HTMLElement>('[aria-label="Smart shelves"]');
    expect(rail?.textContent).toContain("Missing cover");
    expect(rail?.textContent).toContain("Weekend");
    expect(rail?.textContent).not.toContain("Series in progress");
    expect(root.querySelector('[data-shelf-id="builtin-missing-cover"]')?.getAttribute("aria-current")).toBe("page");
    const dialog = root.querySelector<HTMLElement>('.library-shelf-sheet[role="dialog"]');
    expect(dialog?.textContent).toContain("Save current view");
    expect(dialog?.textContent).toContain("do not infer reading progress");
  });

  it("orders series volumes and exposes gap hints with fresh-comparison queue actions", () => {
    const first = {
      ...ABSENT,
      id: "series-one",
      title: "Volume One",
      series: "Sample Saga",
      seriesIndex: 1,
      description: "The opening volume in the saga.",
      coverUrl: `/api/profiles/${PROFILE.id}/books/series-one/cover`,
    };
    const third = { ...POSSIBLE, id: "series-three", title: "Volume Three", series: "Sample Saga", seriesIndex: 3 };
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      filters: { ...initialLibraryFilters(PROFILE.id), view: "series" },
      seriesState: "ready",
      seriesDetail: {
        key: "sample saga",
        name: "Sample Saga",
        books: { items: [first, third], total: 2, limit: 1_000, offset: 0 },
        duplicateIndices: [],
        missingIntegerIndices: [2],
        unnumberedCount: 0,
      },
      kindleStatus: new Map([
        [first.id, "not-on-kindle"],
        [third.id, "possible"],
      ]),
    })));

    const detail = root.querySelector<HTMLElement>(".series-detail");
    expect(detail?.textContent).toContain("Numbering gaps: 2");
    expect([...detail!.querySelectorAll(".series-book-title strong")].map((element) => element.textContent)).toEqual(["Volume One", "Volume Three"]);
    expect(detail?.querySelectorAll(".series-book-cover")).toHaveLength(2);
    expect(detail?.querySelector('.series-book-cover img[src*="series-one/cover"]')).not.toBeNull();
    expect(detail?.textContent).toContain("The opening volume in the saga.");
    expect(detail?.textContent).toContain("No description available.");
    expect(detail?.textContent).toContain("Source available · books");
    expect(detail?.querySelectorAll('[data-ui-action="edit-book-metadata"]')).toHaveLength(2);
    expect(detail?.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="next"]')?.disabled).toBe(false);
    expect(detail?.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="all"]')?.textContent).toContain("1 missing");

    const queueUnavailable = render(renderLibraryPrototype(readyState(), snapshot({
      filters: { ...initialLibraryFilters(PROFILE.id), view: "series" },
      seriesState: "ready",
      sendQueueState: "loading",
      seriesDetail: {
        key: "sample saga",
        name: "Sample Saga",
        books: { items: [first], total: 1, limit: 1_000, offset: 0 },
        duplicateIndices: [],
        missingIntegerIndices: [],
        unnumberedCount: 0,
      },
      kindleStatus: new Map([[first.id, "not-on-kindle"]]),
    })));
    expect(queueUnavailable.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="next"]')?.disabled).toBe(true);
    expect(queueUnavailable.querySelector<HTMLButtonElement>('[data-ui-action="add-book-to-queue"]')?.disabled).toBe(true);
  });

  it("never enables a zero-missing series batch but keeps explicit queueing available before comparison", () => {
    const unknown = { ...ABSENT, id: "series-unknown", title: "Unresolved volume", series: "Sample Saga", seriesIndex: 2 };
    const detail = {
      key: "sample saga",
      name: "Sample Saga",
      books: { items: [unknown], total: 1, limit: 1_000, offset: 0 },
      duplicateIndices: [],
      missingIntegerIndices: [],
      unnumberedCount: 0,
    };
    const compared = render(renderLibraryPrototype(readyState(), snapshot({
      filters: { ...initialLibraryFilters(PROFILE.id), view: "series" },
      seriesState: "ready",
      seriesDetail: detail,
      kindleStatus: new Map([[unknown.id, "unknown"]]),
    })));

    expect(compared.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="next"]')?.disabled).toBe(true);
    const comparedAll = compared.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="all"]');
    expect(comparedAll?.disabled).toBe(true);
    expect(comparedAll?.textContent).toContain("0 missing");
    expect(compared.querySelector<HTMLButtonElement>('[data-ui-action="add-book-to-queue"]')?.disabled).toBe(true);

    const notCompared = render(renderLibraryPrototype(readyState(), snapshot({
      filters: { ...initialLibraryFilters(PROFILE.id), view: "series" },
      seriesState: "ready",
      seriesDetail: detail,
      kindleInventory: undefined,
      kindleStatusCountsByProfile: new Map(),
      kindleStatus: new Map([[unknown.id, "unknown"]]),
    })));
    expect(notCompared.textContent).toContain("Kindle absence is not known yet.");
    expect(notCompared.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="next"]')?.disabled).toBe(false);
    const notComparedAll = notCompared.querySelector<HTMLButtonElement>('[data-ui-action="queue-series"][data-mode="all"]');
    expect(notComparedAll?.disabled).toBe(false);
    expect(notComparedAll?.textContent).toContain("1 eligible");
  });

  it("identifies root-only and file-only Needs Attention issues with current source context", () => {
    const disposition = { ignored: false, preferredBookId: null, revision: 0, retryCount: 0, lastRetryAt: null };
    const issues = [{
      version: 1 as const,
      signature: "issue-1111111111111111",
      profileId: PROFILE.id,
      type: "unavailable-source" as const,
      severity: "warning" as const,
      reasonCode: "source-unavailable",
      bookIds: [],
      sourceIds: [],
      rootIds: [ROOT.id],
      displayLabels: ["Household books mount"],
      currentAvailable: false,
      lastObservedAt: "2026-09-04T08:00:00Z",
      disposition,
    }, {
      version: 1 as const,
      signature: "issue-2222222222222222",
      profileId: PROFILE.id,
      type: "metadata-parser-failure" as const,
      severity: "error" as const,
      reasonCode: "epub-invalid-container",
      bookIds: [],
      sourceIds: ["source_broken"],
      rootIds: [ROOT.id],
      displayLabels: ["nested/broken-book.epub"],
      currentAvailable: true,
      lastObservedAt: "2026-09-04T08:01:00Z",
      disposition,
    }];
    const root = render(renderLibraryPrototype(readyState(), snapshot({
      filters: { ...initialLibraryFilters(PROFILE.id), view: "attention" },
      healthPage: {
        items: issues,
        total: 2,
        limit: 100,
        offset: 0,
        counts: {
          total: 2,
          active: 2,
          ignored: 0,
          byType: {
            "missing-cover": 0,
            "incomplete-metadata": 0,
            "metadata-parser-failure": 1,
            "low-confidence-provider-data": 0,
            "unavailable-source": 1,
            "suspected-duplicate": 0,
          },
          bySeverity: { info: 0, warning: 1, error: 1 },
        },
      },
    })));

    const cards = root.querySelectorAll<HTMLElement>(".attention-issue");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("Household books mount");
    expect(cards[0]?.textContent).toContain("Current source unavailable");
    expect(cards[1]?.textContent).toContain("nested/broken-book.epub");
    expect(cards[1]?.textContent).toContain("Current source available");
    for (const card of cards) {
      expect(card.textContent).toContain("books");
      expect(card.textContent).toContain("/libraries/books");
    }
  });
});
