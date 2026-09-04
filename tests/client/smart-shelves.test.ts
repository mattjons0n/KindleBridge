import { describe, expect, it } from "vitest";
import type { SmartShelf } from "../../shared/catalog-contracts";
import { initialLibraryFilters } from "../../client/src/library-prototype";
import {
  BUILT_IN_SMART_SHELVES,
  libraryFiltersToSmartShelfQuery,
  orderedPinnedSmartShelves,
  smartShelfQueryToLibraryFilters,
} from "../../client/src/smart-shelves";

describe("smart-shelf client projections", () => {
  it("saves only reusable query state, never page or scroll position", () => {
    const filters = {
      ...initialLibraryFilters("prf-one"),
      query: "dragons",
      author: "An Author",
      kindle: "not-on-kindle" as const,
      sort: "title" as const,
      offset: 480,
      limit: 24,
    };
    const query = libraryFiltersToSmartShelfQuery(filters);
    expect(query).toEqual({
      version: 1,
      catalog: { q: "dragons", author: "An Author", sort: "title", order: "asc" },
      kindleStatus: "not-on-kindle",
    });
    expect(JSON.stringify(query)).not.toContain("offset");
    expect(JSON.stringify(query)).not.toContain("limit");
    const restored = smartShelfQueryToLibraryFilters("prf-one", query);
    expect(restored).toMatchObject({ query: "dragons", author: "An Author", kindle: "not-on-kindle", offset: 0 });
  });

  it("exposes a deliberately small immutable built-in set", () => {
    expect(BUILT_IN_SMART_SHELVES.map(({ name }) => name)).toEqual([
      "Recently added", "Not on Kindle", "Favorites", "Want to read", "Missing cover",
    ]);
    expect(BUILT_IN_SMART_SHELVES).toHaveLength(5);
    expect(BUILT_IN_SMART_SHELVES.at(-1)?.query).toEqual({ version: 1, catalog: { coverAvailable: false } });
    expect(BUILT_IN_SMART_SHELVES.some(({ name }) => /progress/iu.test(name))).toBe(false);
  });

  it("preserves series ordering and converts view-only shortcuts into reusable constraints", () => {
    for (const sort of ["series", "series-index"] as const) {
      const query = libraryFiltersToSmartShelfQuery({ ...initialLibraryFilters("prf-one"), sort });
      expect(query.catalog).toMatchObject({ sort, order: "asc" });
      expect(smartShelfQueryToLibraryFilters("prf-one", query).sort).toBe(sort);
    }
    expect(libraryFiltersToSmartShelfQuery({ ...initialLibraryFilters("prf-one"), view: "on-kindle" }).kindleStatus)
      .toBe("confirmed");
    expect(libraryFiltersToSmartShelfQuery({ ...initialLibraryFilters("prf-one"), view: "recent", sort: "title" }).catalog)
      .toMatchObject({ sort: "recent", order: "desc" });
    const unknown = { version: 1 as const, kindleStatus: "unknown" as const };
    expect(smartShelfQueryToLibraryFilters("prf-one", unknown).kindle).toBe("unknown");
    expect(libraryFiltersToSmartShelfQuery({ ...initialLibraryFilters("prf-one"), kindle: "unknown" }).kindleStatus)
      .toBe("unknown");
  });

  it("orders only pinned user shelves by bounded rank", () => {
    const shelf = (id: string, pinnedRank: number | null): SmartShelf => ({
      id,
      profileId: "prf-one",
      name: id,
      query: { version: 1 },
      pinnedRank,
      revision: 1,
      serverCount: 0,
      createdAt: "x",
      updatedAt: "x",
    });
    expect(orderedPinnedSmartShelves([shelf("second", 1), shelf("hidden", null), shelf("first", 0)])
      .map(({ id }) => id)).toEqual(["first", "second"]);
  });
});
