import { describe, expect, it } from "vitest";
import type { CatalogBook } from "../../client/src/catalog-client";
import {
  allMissingKindleSeriesBooks,
  buildCatalogSeriesGroups,
  canonicalSeriesKey,
  nextMissingKindleSeriesBook,
} from "../../client/src/series-browser";

function book(id: string, series: string | undefined, seriesIndex?: number): CatalogBook {
  return {
    id,
    profileId: "prf-one",
    rootId: "root-one",
    sourceFilename: `${id}.epub`,
    title: `Title ${id}`,
    authors: ["Author"],
    authorSort: "Author",
    series,
    seriesIndex,
    subjects: [],
    identifiers: [],
    format: "EPUB",
    size: 100,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadataComplete: true,
    available: true,
  };
}

describe("series browsing domain", () => {
  it("groups Unicode/case/punctuation variants without losing a display name", () => {
    expect(canonicalSeriesKey("  L’Épée—Noire! ")).toBe("l epee noire");
    const groups = buildCatalogSeriesGroups([
      book("a", "L’Épée Noire", 1),
      book("b", "l epee-noire", 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.books.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("orders decimal volumes before unnumbered entries and reports conservative sequence hints", () => {
    const group = buildCatalogSeriesGroups([
      book("unnumbered", "Saga"),
      book("three-a", "Saga", 3),
      book("one", "Saga", 1),
      book("two-half", "Saga", 2.5),
      book("three-b", "Saga", 3),
      book("invalid", "Saga", -1),
    ])[0]!;

    expect(group.books.map(({ id }) => id)).toEqual([
      "one", "two-half", "three-a", "three-b", "invalid", "unnumbered",
    ]);
    expect(group.duplicateIndices).toEqual([3]);
    expect(group.missingIntegerIndices).toEqual([2]);
    expect(group.unnumberedCount).toBe(2);
  });

  it("queues only books with authoritative current not-on-Kindle evidence", () => {
    const group = buildCatalogSeriesGroups([
      book("one", "Saga", 1),
      book("two", "Saga", 2),
      book("three", "Saga", 3),
      { ...book("four", "Saga", 4), available: false },
    ])[0]!;
    const statuses = new Map([
      ["one", "confirmed"],
      ["two", "possible"],
      ["three", "not-on-kindle"],
      ["four", "not-on-kindle"],
    ] as const);
    expect(nextMissingKindleSeriesBook(group, statuses)?.id).toBe("three");
    expect(allMissingKindleSeriesBooks(group, statuses).map(({ id }) => id)).toEqual(["three"]);
  });
});
