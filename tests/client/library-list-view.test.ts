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
  it("offers an accessible grid/list toggle and keeps selection controls list-only", () => {
    const grid = render(renderLibraryResults(readyState(), snapshot()));
    expect(grid.querySelector('[data-ui-action="set-library-layout"][data-layout="grid"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(grid.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-label")).toBe("List view");
    expect(grid.querySelector('[data-ui-action="toggle-book-selection"]')).toBeNull();
    expect(grid.querySelectorAll('[data-ui-action="remove-book-from-kindle"]')).toHaveLength(BOOKS.length);

    const list = render(renderLibraryResults(readyState(), snapshot({ layout: "list" })));
    expect(list.querySelector('[data-ui-action="set-library-layout"][data-layout="list"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(list.querySelectorAll('[data-ui-action="toggle-book-selection"]')).toHaveLength(BOOKS.length);
    expect(list.querySelector('[role="toolbar"][aria-label="Selected book actions"]')).not.toBeNull();
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
});
