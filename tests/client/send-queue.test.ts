import { describe, expect, it } from "vitest";
import type { CatalogBook, SendQueue } from "../../shared/catalog-contracts";
import {
  buildSendQueueReview,
  queueBookIdsAfterBatch,
  reorderedQueueBookIds,
} from "../../client/src/send-queue";

function catalogBook(id: string, format: "epub" | "azw3" = "epub"): CatalogBook {
  return {
    id,
    profileId: "prf-one",
    rootId: "root-one",
    sourceFilename: `${id}.${format}`,
    title: `Title ${id}`,
    authors: ["Author"],
    authorSort: "Author",
    language: "en",
    publisher: null,
    publishedAt: null,
    series: null,
    seriesIndex: null,
    description: null,
    subjects: [],
    identifiers: [],
    format,
    size: id === "one" ? 1_000 : 2_000,
    contentHash: "a".repeat(64),
    presentationVersion: "b".repeat(64),
    metadataComplete: true,
    available: true,
    coverUrl: null,
    sourceUrl: `/api/profiles/prf-one/books/${id}/source`,
    metadataRevision: 0,
    metadataEdited: false,
    coverEdited: false,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function queue(): SendQueue {
  return {
    profileId: "prf-one",
    revision: 2,
    total: 3,
    totalSourceBytes: 3_000,
    entries: [
      { profileId: "prf-one", bookId: "one", rank: 0, queuedContentHash: "a".repeat(64), queuedPresentationVersion: "b".repeat(64), createdAt: "x", updatedAt: "x", book: catalogBook("one"), sourceState: "ready" },
      { profileId: "prf-one", bookId: "two", rank: 1, queuedContentHash: "a".repeat(64), queuedPresentationVersion: "b".repeat(64), createdAt: "x", updatedAt: "x", book: catalogBook("two", "azw3"), sourceState: "ready" },
      { profileId: "prf-one", bookId: "stale", rank: 2, queuedContentHash: "a".repeat(64), queuedPresentationVersion: "b".repeat(64), createdAt: "x", updatedAt: "x", book: null, sourceState: "missing-or-retired" },
    ],
  };
}

describe("Send-later queue review", () => {
  it("explains current transfer eligibility without dropping stale entries", () => {
    const review = buildSendQueueReview({
      queue: queue(),
      kindleStatusByBookId: new Map([["one", "not-on-kindle"], ["two", "possible"]]),
      currentComparisonComplete: true,
      freeBytes: 2_999n,
    });
    expect(review.items).toHaveLength(3);
    expect(review.eligibleBookIds).toEqual(["one"]);
    expect(review.items[1]?.reason).toBe("Resolve the possible Kindle match first");
    expect(review.items[2]?.reason).toBe("The queued catalog book no longer exists");
    expect(review.conversionSizeUncertain).toBe(true);
    expect(review.fitsApproximateFreeSpace).toBe(false);
  });

  it("retains only unsent entries after a partial batch and supports stable reorder", () => {
    expect(queueBookIdsAfterBatch(queue(), new Set(["one"]))).toEqual(["two", "stale"]);
    expect(reorderedQueueBookIds(queue(), "stale", 0)).toEqual(["stale", "one", "two"]);
    expect(() => reorderedQueueBookIds(queue(), "missing", 0)).toThrow(/not in the current queue/u);
  });
});
