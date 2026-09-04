// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import { bookActionCapabilities, bulkBookActionCapabilities } from "../../client/src/book-action-capabilities";
import type { CatalogBook, CatalogProfile, CatalogRoot } from "../../client/src/catalog-client";
import { EMPTY_CATALOG_FILTERS, initialLibraryFilters } from "../../client/src/library-prototype";
import { buildSendQueueReview } from "../../client/src/send-queue";
import { initialAppState, type AppState } from "../../client/src/state";

const profile: CatalogProfile = { id: "p", name: "Home", description: "Home", initial: "H", sourceLabel: "Books", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 1 };
const root: CatalogRoot = { id: "r", profileId: "p", label: "Books", path: "/libraries/books", recursive: true, watch: true, enabled: true, status: "watching" };
const book: CatalogBook = { id: "b", profileId: "p", rootId: "r", sourceFilename: "book.epub", title: "Book", authors: ["Author"], authorSort: "Author", subjects: [], identifiers: [], format: "EPUB", size: 1_000, addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", metadataComplete: true, available: true };

function snapshot(status: "confirmed" | "possible" | "not-on-kindle"): CatalogBrowserSnapshot {
  return {
    loadState: "ready", profiles: [profile], rootsByProfile: new Map([["p", [root]]]), filters: initialLibraryFilters("p"), facets: EMPTY_CATALOG_FILTERS,
    page: { items: [book], total: 1, limit: 24, offset: 0 }, booksState: "ready", stale: false, liveUpdatesConnected: true,
    settingsSaving: false, settingsRefreshing: false, settingsConflict: false, settingsDirty: false, rescanningRootIds: new Set(), sendBusy: false,
    kindleStatus: new Map([["b", status]]), kindleStatusCountsByProfile: new Map([["p", { confirmed: status === "confirmed" ? 1 : 0, possible: status === "possible" ? 1 : 0, notOnKindle: status === "not-on-kindle" ? 1 : 0, unknown: 0 }]]),
    kindleInventory: { deviceLabel: "Kindle", scannedAt: "2026-01-01T00:00:00Z", completeness: "complete", total: status === "not-on-kindle" ? 0 : 1, truncated: false, matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 }, items: status === "not-on-kindle" ? [] : [{ id: "mtp", filename: "book.azw3", size: 900, managed: false, bookId: "b", match: status === "confirmed" ? "confirmed" : "possible" }] },
    kindleInventoryOffset: 0, layout: "grid", selectedBookIds: new Set(), bulkActionBusy: false,
    sendQueueState: "ready", sendQueueOpen: false, sendQueueBusy: false,
    seriesState: "idle", seriesQuery: "", seriesSort: "name",
    smartShelves: [], smartShelvesState: "ready", shelfManagerOpen: false, annotations: new Map(),
    healthState: "ready", healthBooks: new Map(), healthFilter: { type: "all", severity: "all", ignored: false },
    metadataLookupState: "ready", metadataLookupBusy: false, activityOpen: false, activityEvents: [],
  };
}

const ready: AppState = {
  ...initialAppState(),
  device: { kind: "ready" as const, details: { vendorId: 0x1949, productId: 0x9981 } },
  selfTest: { kind: "passed" as const, byteLength: 1_012 },
  catalogInventoryState: "ready" as const,
};

describe("bookActionCapabilities", () => {
  it("projects the same safe send and remove policy for every view", () => {
    expect(bookActionCapabilities(book, ready, snapshot("not-on-kindle"))).toMatchObject({
      send: { enabled: true, label: "Send to Kindle" },
      remove: { enabled: false },
    });
    expect(bookActionCapabilities(book, ready, snapshot("confirmed"))).toMatchObject({
      send: { enabled: false, label: "✓ On Kindle" },
      remove: { enabled: true },
    });
    expect(bookActionCapabilities(book, ready, snapshot("possible"))).toMatchObject({
      send: { enabled: false, label: "Possible match" },
      remove: { enabled: false },
      matchReview: { enabled: true, decisionEnabled: true },
    });
    expect(bulkBookActionCapabilities([book], new Set([book.id]), ready, snapshot("not-on-kindle"))).toMatchObject({
      send: { enabled: true, count: 1 },
      remove: { enabled: false, count: 0 },
    });
    expect(bulkBookActionCapabilities([book], new Set([book.id]), ready, snapshot("confirmed"))).toMatchObject({
      send: { enabled: false, count: 0 },
      remove: { enabled: true, count: 1 },
    });
  });

  it("blocks every mutable Kindle action while another action is active", () => {
    const busy = { ...snapshot("confirmed"), sendBusy: true };
    expect(bookActionCapabilities(book, ready, busy)).toMatchObject({
      select: { enabled: false }, edit: { enabled: false }, send: { enabled: false }, remove: { enabled: false },
    });
    expect(bookActionCapabilities(book, ready, { ...snapshot("possible"), sendQueueBusy: true }).matchReview)
      .toMatchObject({ enabled: false, decisionEnabled: false });
  });

  it("keeps a partial-inventory explanation available without enabling a match decision", () => {
    const partial = snapshot("possible");
    const actions = bookActionCapabilities(book, ready, {
      ...partial,
      kindleInventory: { ...partial.kindleInventory!, completeness: "partial" },
    });
    expect(actions.matchReview).toMatchObject({ enabled: true, decisionEnabled: false });
    expect(actions.matchReview.decisionReason).toContain("complete the current Kindle comparison");
  });

  it.each([
    ["disconnected", { ...ready, device: { kind: "disconnected" as const } }, snapshot("not-on-kindle")],
    ["connecting", { ...ready, device: { kind: "requesting-permission" as const } }, snapshot("not-on-kindle")],
    ["recovery", { ...ready, device: { kind: "recovering" as const, details: { vendorId: 0x1949, productId: 0x9981 } } }, snapshot("not-on-kindle")],
    ["partial inventory", ready, { ...snapshot("not-on-kindle"), kindleInventory: { ...snapshot("not-on-kindle").kindleInventory!, completeness: "partial" as const } }],
    ["possible match", ready, snapshot("possible")],
    ["missing write proof", { ...ready, selfTest: { kind: "not-run" as const } }, snapshot("not-on-kindle")],
    ["send busy", ready, { ...snapshot("not-on-kindle"), sendBusy: true }],
    ["bulk busy", ready, { ...snapshot("not-on-kindle"), bulkActionBusy: true }],
    ["queue busy", ready, { ...snapshot("not-on-kindle"), sendQueueBusy: true }],
    ["unavailable source", ready, { ...snapshot("not-on-kindle"), rootsByProfile: new Map([["p", [{ ...root, status: "unavailable" as const }]]]) }],
  ] as const)("gives Send later the exact shared Send decision for %s", (_label, state, browser) => {
    const actions = bookActionCapabilities(book, state, browser);
    const review = buildSendQueueReview({
      queue: {
        profileId: profile.id,
        revision: 1,
        entries: [{ bookId: book.id, sourceState: "ready", book }],
        totalSourceBytes: book.size,
      },
      kindleStatusByBookId: browser.kindleStatus,
      currentComparisonComplete: true,
      actionCapabilitiesByBookId: new Map([[book.id, actions]]),
    });
    expect(review.items[0]?.transferEligible).toBe(actions.send.enabled);
    expect(review.items[0]?.reason).toBe(actions.send.reason);
  });

  it.each([
    ["source-changed", "Source changed after it was queued; review and re-add it"],
    ["presentation-changed", "Metadata or cover changed after it was queued; review and re-add it"],
  ] as const)("blocks a %s queue entry even when the current book could be sent", (sourceState, reason) => {
    const actions = bookActionCapabilities(book, ready, snapshot("not-on-kindle"));
    expect(actions.send.enabled).toBe(true);
    const review = buildSendQueueReview({
      queue: {
        profileId: profile.id,
        revision: 1,
        entries: [{ bookId: book.id, sourceState, book }],
        totalSourceBytes: book.size,
      },
      kindleStatusByBookId: new Map([[book.id, "not-on-kindle"]]),
      currentComparisonComplete: true,
      actionCapabilitiesByBookId: new Map([[book.id, actions]]),
    });
    expect(review.items[0]).toMatchObject({ transferEligible: false, reason });
  });

  it("fails closed across connection, recovery, inventory, source, and proof boundaries", () => {
    const cases: readonly [string, AppState, CatalogBrowserSnapshot][] = [
      ["disconnected", { ...ready, device: { kind: "disconnected" } }, snapshot("not-on-kindle")],
      ["connecting", { ...ready, device: { kind: "requesting-permission" } }, snapshot("not-on-kindle")],
      ["recovery", { ...ready, device: { kind: "recovering", details: { vendorId: 0x1949, productId: 0x9981 } } }, snapshot("not-on-kindle")],
      ["replacement cleanup", { ...ready, pendingReplacementCleanups: [{} as never] }, snapshot("not-on-kindle")],
      ["partial inventory", ready, { ...snapshot("not-on-kindle"), kindleInventory: { ...snapshot("not-on-kindle").kindleInventory!, completeness: "partial" } }],
      ["missing write proof", { ...ready, selfTest: { kind: "not-run" } }, snapshot("not-on-kindle")],
      ["busy", ready, { ...snapshot("not-on-kindle"), bulkActionBusy: true }],
      ["unavailable source", ready, { ...snapshot("not-on-kindle"), rootsByProfile: new Map([["p", [{ ...root, status: "unavailable" }]]]) }],
    ];
    for (const [label, state, browser] of cases) {
      const actions = bookActionCapabilities(book, state, browser);
      expect(actions.send.enabled, `${label}: send`).toBe(false);
      expect(actions.remove.enabled, `${label}: remove`).toBe(false);
    }
  });

  it("offers guarded Update only for one exact stale managed edited EPUB presentation", () => {
    const edited = {
      ...book,
      metadataEdited: true,
      metadataRevision: 3,
      contentHash: "a".repeat(64),
      presentationVersion: "b".repeat(64),
    };
    const prior = snapshot("possible");
    const exactPrior: CatalogBrowserSnapshot = {
      ...prior,
      page: { items: [edited], total: 1, limit: 24, offset: 0 },
      kindleInventory: {
        ...prior.kindleInventory!,
        items: [{ id: "mtp", filename: "prior.azw3", size: 900, managed: true, stalePresentation: true, bookId: "b", match: "possible" }],
      },
    };
    expect(bookActionCapabilities(edited, ready, exactPrior).update).toMatchObject({
      enabled: true,
      priorFilename: "prior.azw3",
    });
    expect(bookActionCapabilities({ ...edited, format: "AZW3" }, ready, exactPrior).update).toMatchObject({ enabled: false });
    expect(bookActionCapabilities({ ...edited, presentationVersion: undefined }, ready, exactPrior).update).toMatchObject({ enabled: false });
  });
});
