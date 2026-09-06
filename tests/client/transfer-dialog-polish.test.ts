// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CatalogBrowserSnapshot, CatalogKindleInventory } from "../../client/src/catalog-browser";
import type { CatalogBook } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { renderLibraryPrototype } from "../../client/src/library-prototype-view";
import { initialAppState, type AppState } from "../../client/src/state";

const BOOKS: CatalogBook[] = Array.from({ length: 7 }, (_, index) => ({
  id: `book_${index + 1}`,
  profileId: "prf_reader",
  rootId: "root_books",
  sourceFilename: `book-${index + 1}.epub`,
  title: `Book title ${index + 1}`,
  authors: ["Test Author"],
  authorSort: "Author, Test",
  subjects: [],
  identifiers: [],
  format: "epub",
  size: 1_024,
  contentHash: `${index}`.repeat(64),
  addedAt: "2026-09-06T09:00:00Z",
  updatedAt: "2026-09-06T09:00:00Z",
  metadataComplete: true,
  available: true,
}));

const INVENTORY: CatalogKindleInventory = {
  deviceLabel: "Kindle",
  scannedAt: "2026-09-06T09:10:00Z",
  completeness: "complete",
  total: 0,
  truncated: false,
  matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
  items: [],
};

function snapshot(overrides: Partial<CatalogBrowserSnapshot> = {}): CatalogBrowserSnapshot {
  return {
    loadState: "ready",
    profiles: [{ id: "prf_reader", name: "My books", description: "Library", initial: "M", sourceLabel: "Books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 7 }],
    rootsByProfile: new Map(),
    filters: initialLibraryFilters("prf_reader"),
    facets: EMPTY_CATALOG_FILTERS,
    page: { items: BOOKS, total: 7, offset: 0, limit: 24 },
    booksState: "ready",
    stale: false,
    liveUpdatesConnected: true,
    settingsSaving: false,
    settingsRefreshing: false,
    settingsConflict: false,
    settingsDirty: false,
    rescanningRootIds: new Set(),
    sendBusy: false,
    kindleStatus: new Map(BOOKS.map(({ id }) => [id, "not-on-kindle"])),
    kindleStatusCountsByProfile: new Map([["prf_reader", { confirmed: 0, possible: 0, notOnKindle: 7, unknown: 0 }]]),
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

function render(overrides: Partial<CatalogBrowserSnapshot>): HTMLElement {
  const state: AppState = {
    ...initialAppState(),
    device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
    selfTest: { kind: "passed", byteLength: 1_012 },
    catalogInventoryState: "ready",
  };
  const root = document.createElement("div");
  root.innerHTML = renderLibraryPrototype(state, snapshot(overrides));
  return root;
}

function batch(overrides: Partial<CatalogBrowserSnapshot> = {}): Partial<CatalogBrowserSnapshot> {
  return {
    pendingBookId: BOOKS[2]!.id,
    pendingBook: BOOKS[2],
    sendBusy: true,
    bulkActionBusy: true,
    sendPhase: "sending",
    sendProgress: 75,
    batchTransfer: { id: "batch_1", position: 3, total: 7, verifiedBooks: BOOKS.slice(0, 2), retryBooks: [] },
    ...overrides,
  };
}

describe("clear batch transfer feedback", () => {
  it("shows the current book and combined progress without technical steps or completed-book clutter", () => {
    const root = render(batch({ sendMessage: "Collision-safe WebUSB/MTP transfer" }));
    const dialog = root.querySelector(".library-send-sheet")!;
    expect(dialog.querySelector(".library-sheet-eyebrow")?.textContent).toBe("Book 3 of 7");
    expect(dialog.querySelector("h2")?.textContent).toBe("Book title 3");
    expect(dialog.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("39");
    expect(dialog.querySelector(".library-batch-progress-detail")?.textContent).toContain("2 of 7 books sent");
    expect(dialog.querySelector(".library-batch-book-results")).toBeNull();
    expect(dialog.textContent).not.toMatch(/Check source|boko|WebUSB|MTP|personal document|Original protected/);
    expect(dialog.querySelector<HTMLButtonElement>('[data-ui-action="close-send"]')?.disabled).toBe(true);
    expect(root.querySelector('.library-modal-backdrop[data-ui-action="close-send"]')).toBeNull();
  });

  it.each(["verifying", "complete"] as const)("keeps final reconciliation visible and locked during %s updates", (phase) => {
    const root = render(batch({
      pendingBookId: BOOKS[6]!.id,
      pendingBook: BOOKS[6],
      sendPhase: phase,
      sendProgress: 100,
      batchTransfer: { id: "batch_1", position: 7, total: 7, verifiedBooks: BOOKS, retryBooks: [] },
    }));
    const dialog = root.querySelector(".library-send-sheet")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Book title 7");
    expect(dialog.textContent).toContain("Updating your library…");
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toContain("updating your library");
    expect(dialog.querySelector<HTMLButtonElement>('[data-ui-action="close-send"]')?.disabled).toBe(true);
    expect(dialog.querySelector(".library-confirm-send")).toBeNull();
    expect(dialog.querySelector(".library-batch-book-results")).toBeNull();
  });

  it("shows every verified book and permits dismissal only after the final result", () => {
    const root = render(batch({
      sendBusy: false,
      bulkActionBusy: false,
      sendPhase: "complete",
      sendProgress: 100,
      batchTransfer: { id: "batch_1", position: 7, total: 7, verifiedBooks: BOOKS, retryBooks: [] },
    }));
    const dialog = root.querySelector(".library-send-sheet")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("7 books sent");
    expect(dialog.querySelector(".library-batch-progress-detail")?.textContent).toContain("7 of 7 books sent");
    expect(dialog.querySelectorAll(".library-batch-book-list li")).toHaveLength(7);
    for (const { title } of BOOKS) expect(dialog.querySelector(".library-batch-book-list")?.textContent).toContain(title);
    expect(dialog.querySelector<HTMLButtonElement>(".library-confirm-send")?.disabled).toBe(false);
    expect(dialog.querySelector(".library-confirm-send")?.textContent).toBe("Done");
    expect(root.querySelector('.library-modal-backdrop[data-ui-action="close-send"]')).not.toBeNull();
  });

  it("distinguishes successful books from a failed book and preserves the names selected for retry", () => {
    const root = render(batch({
      sendBusy: false,
      bulkActionBusy: false,
      sendPhase: "failed",
      sendMessage: "Failed on “Book title 3”: USB stalled",
      batchTransfer: { id: "batch_1", position: 3, total: 7, verifiedBooks: BOOKS.slice(0, 2), failedBook: BOOKS[2], retryBooks: BOOKS.slice(2) },
    }));
    const dialog = root.querySelector(".library-send-sheet")!;
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("29");
    expect(dialog.querySelectorAll(".library-batch-book-list li")).toHaveLength(2);
    expect(dialog.querySelector(".library-batch-failure")?.textContent).toContain("Book title 3");
    expect(dialog.querySelector(".library-transfer-status.failed")?.textContent).toContain("USB stalled");
    expect(dialog.querySelectorAll(".library-batch-retry li")).toHaveLength(5);
    expect(dialog.querySelector(".library-confirm-send")?.textContent).toBe("Review 5 selected");
  });
});

describe("readable removal consent", () => {
  const pendingRemoval = {
    profileId: "prf_reader",
    targets: [
      { itemId: "mtp_1", bookId: "book_1", title: "Book title 1", filename: "Book title 1 - <exact-file> & edition.azw3", size: 1024 },
      { itemId: "mtp_2", bookId: "book_2", title: "Book title 2", filename: "Book title 2 - other-edition.azw3", size: 2048 },
    ],
  };

  it("keeps exact filenames and sizes available before the destructive confirmation", () => {
    const dialog = render({ pendingRemoval }).querySelector('.library-remove-sheet[role="alertdialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Remove 2 books from this Kindle?");
    expect(dialog.textContent).toContain("Library originals are not changed.");
    expect(dialog.querySelector(".library-remove-list-heading")?.textContent).toBe("2 exact matched files");
    expect(dialog.querySelectorAll(".library-remove-targets li")).toHaveLength(2);
    expect(dialog.querySelector(".library-remove-targets small")?.textContent).toBe(pendingRemoval.targets[0]!.filename);
    expect(dialog.querySelector(".library-remove-targets")?.textContent).toContain("1.02 KB");
    expect(dialog.querySelector("exact-file")).toBeNull();
    expect(dialog.getAttribute("aria-describedby")).toContain("remove-kindle-warning");
    expect(dialog.querySelector<HTMLButtonElement>('[data-ui-action="confirm-remove-from-kindle"]')?.disabled).toBe(false);
  });

  it("keeps removal disabled when comparison authority is unavailable or deletion is underway", () => {
    const stale = render({ pendingRemoval, kindleInventory: { ...INVENTORY, completeness: "last-seen" } });
    expect(stale.querySelector<HTMLButtonElement>('[data-ui-action="confirm-remove-from-kindle"]')?.disabled).toBe(true);
    const busy = render({ pendingRemoval, bulkActionBusy: true });
    expect(busy.querySelector<HTMLButtonElement>('[data-ui-action="confirm-remove-from-kindle"]')?.disabled).toBe(true);
    expect(busy.querySelector<HTMLButtonElement>('button[data-ui-action="cancel-remove-from-kindle"]')?.disabled).toBe(true);
  });
});
