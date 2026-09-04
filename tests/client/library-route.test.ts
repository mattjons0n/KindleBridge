import { describe, expect, it } from "vitest";
import { decodeLibraryRoute, encodeLibraryRoute } from "../../client/src/library-route";
import { initialLibraryFilters } from "../../client/src/library-prototype";

describe("versioned library route codec", () => {
  it("lets a bare legacy library URL keep the saved per-profile context", () => {
    expect(decodeLibraryRoute("#library")).toBeUndefined();
  });

  it("round-trips profile, browsing context, and one overlay", () => {
    const hash = encodeLibraryRoute({
      version: 1,
      profileId: "profile-wife",
      activeShelfId: "shelf-holiday",
      filters: {
        ...initialLibraryFilters("profile-wife"),
        view: "on-kindle",
        query: "Alchemy of Secrets",
        author: "Stephanie Garber",
        sort: "series-index",
        offset: 48,
      },
      layout: "list",
      density: "compact",
      overlays: { bookId: "book-42", sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
    expect(hash).toContain("v=1");
    expect(decodeLibraryRoute(hash)).toMatchObject({
      profileId: "profile-wife",
      activeShelfId: "shelf-holiday",
      filters: { view: "on-kindle", query: "Alchemy of Secrets", author: "Stephanie Garber", sort: "series-index", offset: 48 },
      layout: "list",
      density: "compact",
      overlays: { bookId: "book-42", sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false },
    });
  });

  it("keeps shelf identity bounded and scoped to a non-Settings profile route", () => {
    expect(decodeLibraryRoute("#library?v=1&p=profile-one&view=all&shelf=builtin-favorites")?.activeShelfId)
      .toBe("builtin-favorites");
    expect(decodeLibraryRoute("#library?v=1&view=all&shelf=builtin-favorites")?.activeShelfId).toBeUndefined();
    expect(decodeLibraryRoute("#library?v=1&p=profile-one&view=settings&shelf=builtin-favorites")?.activeShelfId).toBeUndefined();
    expect(decodeLibraryRoute(`#library?v=1&p=profile-one&view=all&shelf=${"x".repeat(101)}`)?.activeShelfId).toBeUndefined();
    expect(decodeLibraryRoute("#library?v=1&p=profile-one&view=all&shelf=bad%0Aid")?.activeShelfId).toBeUndefined();
  });

  it("keeps Settings but never draft contents, and normalizes stacked overlays", () => {
    const settings = decodeLibraryRoute("#library?v=1&p=profile-one&view=settings&book=book&series=saga&queue=1&shelves=1&activity=1");
    expect(settings).toMatchObject({ filters: { view: "settings" }, overlays: { sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false } });
    expect(settings?.overlays.bookId).toBeUndefined();
    expect(settings?.overlays.seriesKey).toBeUndefined();

    const encodedSettings = encodeLibraryRoute({
      version: 1,
      profileId: "profile-one",
      filters: { ...initialLibraryFilters("profile-one"), view: "settings" },
      layout: "grid",
      density: "comfortable",
      overlays: { bookId: "book", seriesKey: "saga", sendQueueOpen: true, shelfManagerOpen: true, activityOpen: true },
    });
    expect(encodedSettings).not.toMatch(/(?:book|series|queue|shelves|activity)=/u);

    const stacked = decodeLibraryRoute("#library?v=1&p=profile-one&view=all&book=book&series=saga&queue=1&shelves=1&activity=1");
    expect(stacked?.overlays).toEqual({ bookId: "book", sendQueueOpen: false, shelfManagerOpen: false, activityOpen: false });
    expect(decodeLibraryRoute("#library?v=99&p=profile-one")).toBeUndefined();
  });

  it("round-trips one possible-match review without stacking another surface", () => {
    const route = decodeLibraryRoute(encodeLibraryRoute({
      version: 1,
      profileId: "profile-one",
      filters: initialLibraryFilters("profile-one"),
      layout: "grid",
      density: "comfortable",
      overlays: {
        matchItemId: "mtp-42",
        matchBookId: "book-42",
        seriesKey: "ignored-series",
        sendQueueOpen: true,
        shelfManagerOpen: true,
        activityOpen: true,
      },
    }));
    expect(route?.overlays).toEqual({
      matchItemId: "mtp-42",
      matchBookId: "book-42",
      sendQueueOpen: false,
      shelfManagerOpen: false,
      activityOpen: false,
    });
  });
});
