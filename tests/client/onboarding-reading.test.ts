// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CatalogApi, CatalogProfile } from "../../client/src/catalog-client";
import { CatalogBrowser, type CatalogKindleInventory } from "../../client/src/catalog-browser";
import { EMPTY_CATALOG_FILTERS } from "../../client/src/library-prototype";
import { renderBookReading, renderOnboarding } from "../../client/src/library-prototype-view";
import { initialAppState } from "../../client/src/state";
import { catalogReadingEvidence, completedReadingBookIds } from "../../client/src/catalog-reading";
import { DEFAULT_KINDLE_READING_PRESENTATION_GATE } from "../../client/src/kindle/reading-reconciliation";
import { ACCEPTED_KINDLE_READING_SIDECARS } from "../../client/src/kindle/reading-rollout";

const profile: CatalogProfile = { id: "prf_12345678", name: "Reader", description: "", initial: "R", enabled: true, rootCount: 1, availableRootCount: 1, sourceLabel: "Books", bookCount: 1 };
const bookId = "book_12345678";
function apiFixture(profiles: CatalogProfile[] = []) {
  let dismissed = false;
  let savedRead = false;
  const api = {
    getStatus: vi.fn(async () => ({ settingsMode: "read-write" })),
    listProfiles: vi.fn(async () => profiles),
    listRoots: vi.fn(async () => []),
    listBooks: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 24 })),
    queryBooks: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 24 })),
    getFilters: vi.fn(async () => EMPTY_CATALOG_FILTERS),
    getOnboardingState: vi.fn(async () => ({ dismissed })),
    setOnboardingDismissed: vi.fn(async (value: boolean) => ({ dismissed: dismissed = value })),
    subscribeEvents: vi.fn((_event, _error, opened) => { opened?.(); return () => {}; }),
    getBookAnnotation: vi.fn(async () => ({ profileId: profile.id, bookId, readBook: savedRead, favorite: true, wantToRead: false, revision: savedRead ? 1 : 0, createdAt: null, updatedAt: null })),
    updateBookAnnotation: vi.fn(async () => { savedRead = true; return { profileId: profile.id, bookId, readBook: true, favorite: true, wantToRead: false, revision: 1, createdAt: null, updatedAt: null }; }),
  };
  return { api: api as unknown as CatalogApi, mocks: api };
}
function inventory(): CatalogKindleInventory {
  return { deviceLabel: "Kindle", scannedAt: "2026-09-05T12:00:00Z", completeness: "complete", truncated: false, total: 1,
    matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
    items: [{ id: "mtp-00000001", filename: "book.azw3", size: 100, managed: true, bookId, match: "confirmed",
      readingEvidence: { status: "read", explicitState: true, provenance: "azw3r", freshness: "live", progressPercent: 100 } }] };
}

describe("onboarding and reading integration", () => {
  it("offers empty-install setup, remembers skip across browsers, and allows reopening", async () => {
    const { api } = apiFixture();
    const first = new CatalogBrowser(api, {}, () => {}, undefined);
    await first.start();
    expect(first.snapshot.onboarding?.step).toBe("welcome");
    expect(renderOnboarding(first.snapshot, initialAppState())).toContain("Skip for now");
    await first.advanceOnboarding();
    expect(first.snapshot.onboarding?.step).toBe("library");
    await first.dismissOnboarding();
    expect(first.snapshot.onboarding).toBeUndefined();
    const second = new CatalogBrowser(api, {}, () => {}, undefined);
    await second.start();
    expect(second.snapshot.onboarding).toBeUndefined();
    await second.openOnboarding();
    expect(second.snapshot.onboarding?.step).toBe("welcome");
    first.dispose(); second.dispose();
  });
  it("does not nag configured installs and leaves skip failures visible", async () => {
    const { api, mocks } = apiFixture([profile]);
    const browser = new CatalogBrowser(api, {}, () => {}, undefined);
    await browser.start();
    expect(browser.snapshot.onboarding).toBeUndefined();
    await browser.openOnboarding();
    mocks.setOnboardingDismissed.mockRejectedValueOnce(new Error("Server unavailable"));
    await browser.dismissOnboarding();
    expect(browser.snapshot.onboarding?.error).toContain("Server unavailable");
    browser.dispose();
  });
  it("does not auto-open read-only setup or enable unvalidated reading formats", async () => {
    const { api, mocks } = apiFixture();
    mocks.getStatus.mockResolvedValue({ settingsMode: "read-only" });
    const browser = new CatalogBrowser(api, {}, () => {}, undefined);
    await browser.start();
    expect(browser.snapshot.onboarding).toBeUndefined();
    expect(browser.snapshot.readingEnabled).toBe(false);
    expect(ACCEPTED_KINDLE_READING_SIDECARS).toBe(false);
    expect(DEFAULT_KINDLE_READING_PRESENTATION_GATE.enabled).toBe(false);
    expect(renderBookReading(bookId, browser.snapshot)).toBe("");
    browser.dispose();
  });
  it("rejects ambiguous, incomplete, last-seen and percentage-only completion", () => {
    const live = inventory();
    expect(completedReadingBookIds(catalogReadingEvidence(live))).toEqual([bookId]);
    expect(catalogReadingEvidence({ ...live, items: [...live.items, { ...live.items[0], id: "mtp-00000002" }] }).size).toBe(0);
    expect(catalogReadingEvidence({ ...live, completeness: "last-seen" }).size).toBe(0);
    expect(catalogReadingEvidence({ ...live, matching: { status: "partial", matchedProfiles: 0, failedProfiles: 1 } }).size).toBe(0);
    const percent = { ...live, items: [{ ...live.items[0], readingEvidence: { ...live.items[0].readingEvidence!, status: "in-progress" as const, explicitState: false } }] };
    expect(completedReadingBookIds(catalogReadingEvidence(percent))).toEqual([]);
  });
  it("saves only explicit Read membership, filters before pagination, and labels disconnect evidence", async () => {
    const { api, mocks } = apiFixture([profile]);
    const browser = new CatalogBrowser(api, {}, () => {}, undefined, { readingPresentationGate: { version: 1, enabled: true } });
    await browser.start();
    browser.setKindleInventory(inventory());
    await vi.waitFor(() => expect(mocks.updateBookAnnotation).toHaveBeenCalledTimes(1));
    expect(mocks.updateBookAnnotation).toHaveBeenCalledWith(profile.id, bookId, { expectedRevision: 0, readBook: true }, expect.any(AbortSignal));
    const html = renderBookReading(bookId, browser.snapshot);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('reading state: Read');
    await browser.setReadingFilter("read");
    expect(mocks.queryBooks).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ includeBookIds: [bookId], offset: 0 }), expect.any(AbortSignal));
    browser.setKindleInventory(undefined);
    expect(renderBookReading(bookId, browser.snapshot)).toContain("Last seen:");
    expect(renderBookReading("book_unknown1", browser.snapshot)).not.toContain('role="progressbar"');
    expect(mocks.updateBookAnnotation).toHaveBeenCalledTimes(1);
    browser.clearFilters();
    expect(browser.snapshot.readingFilter).toBe("any");
    await browser.applySmartShelf("builtin-read-books");
    expect(mocks.listBooks).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ readBook: true }), expect.any(AbortSignal));
    browser.dispose();
  });
});
