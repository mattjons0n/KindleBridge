import { describe, expect, it } from "vitest";
import type { KindleInventoryObject } from "../../client/src/kindle/inventory";
import {
  DEFAULT_KINDLE_READING_PRESENTATION_GATE,
  clearKindleReadingProjectionForProfile,
  isKindleReadingPresentationEnabled,
  projectKindleReadingEvidence,
  retireKindleReadingProjection,
  selectOpaqueBookIdsByReadingStatus,
  type KindleReadingMatchedItem,
} from "../../client/src/kindle/reading-reconciliation";

const PROFILE_ONE = "prf_12345678";
const PROFILE_TWO = "prf_abcdefgh";
const BOOK_ONE = "book_12345678";
const BOOK_TWO = "book_abcdefgh";
const BOOK_THREE = "book_ABCDEFGH";
const ENABLED = Object.freeze({ version: 1 as const, enabled: true });

function inventoryObject(
  handle: number,
  progressPercent = 42,
  freshness: "live" | "last-seen" = "live",
): KindleInventoryObject {
  return {
    handle,
    storageId: 1,
    parentHandle: 2,
    objectFormat: 0x3000,
    protectionStatus: 0,
    associationType: 0,
    size: 100,
    filename: `${handle}.azw3`,
    relativePath: `${handle}.azw3`,
    depth: 1,
    kind: "file",
    metadataAdjusted: false,
    readingEvidence: {
      status: "in-progress",
      progressPercent,
      provenance: "azw3r",
      freshness,
      explicitState: false,
    },
  };
}

function project(
  objects: readonly KindleInventoryObject[],
  matchedItems: readonly KindleReadingMatchedItem[],
) {
  return projectKindleReadingEvidence({
    profileId: PROFILE_ONE,
    inventoryObjects: objects,
    matchedItems,
    options: { gate: ENABLED },
  });
}

describe("Kindle reading reconciliation", () => {
  it("keeps the internal presentation gate off by default and fails future versions off", () => {
    expect(DEFAULT_KINDLE_READING_PRESENTATION_GATE).toEqual({ version: 1, enabled: false });
    expect(isKindleReadingPresentationEnabled(DEFAULT_KINDLE_READING_PRESENTATION_GATE)).toBe(false);
    expect(isKindleReadingPresentationEnabled({ version: 2, enabled: true })).toBe(false);

    const result = projectKindleReadingEvidence({
      profileId: PROFILE_ONE,
      inventoryObjects: [inventoryObject(10)],
      matchedItems: [{ objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" }],
    });
    expect(result.state).toBe("disabled");
    expect(result.evidenceByBookId.size).toBe(0);
  });

  it("maps only one fresh confirmed unique live item to one opaque book ID", () => {
    const result = project(
      [inventoryObject(10), inventoryObject(11), inventoryObject(12, 50, "last-seen")],
      [
        { objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" },
        { objectHandle: 11, bookId: BOOK_TWO, match: "possible" },
        { objectHandle: 12, bookId: BOOK_THREE, match: "confirmed" },
      ],
    );
    expect([...result.evidenceByBookId]).toEqual([
      [BOOK_ONE, expect.objectContaining({ progressPercent: 42, freshness: "live" })],
    ]);
  });

  it("fails ambiguous book, object, and duplicate inventory claims closed", () => {
    const result = project(
      [inventoryObject(10), inventoryObject(11), inventoryObject(12), inventoryObject(12)],
      [
        { objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" },
        { objectHandle: 11, bookId: BOOK_ONE, match: "possible" },
        { objectHandle: 10, bookId: BOOK_TWO, match: "confirmed" },
        { objectHandle: 12, bookId: BOOK_THREE, match: "confirmed" },
      ],
    );
    expect(result.evidenceByBookId.size).toBe(0);
  });

  it("fails projection bounds closed without retaining partial evidence", () => {
    const result = projectKindleReadingEvidence({
      profileId: PROFILE_ONE,
      inventoryObjects: [inventoryObject(10), inventoryObject(11)],
      matchedItems: [{ objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" }],
      options: { gate: ENABLED, maxObjects: 1 },
    });
    expect(result.state).toBe("limit-exceeded");
    expect(result.evidenceByBookId.size).toBe(0);
  });

  it("retires evidence on disconnect and clears it across profile changes", () => {
    const live = project(
      [inventoryObject(10)],
      [{ objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" }],
    );
    const retired = retireKindleReadingProjection(live);
    expect(retired.state).toBe("last-seen");
    expect(retired.evidenceByBookId.get(BOOK_ONE)?.freshness).toBe("last-seen");

    const switched = clearKindleReadingProjectionForProfile(retired, PROFILE_TWO);
    expect(switched).toMatchObject({ profileId: PROFILE_TWO, state: "empty" });
    expect(switched.evidenceByBookId.size).toBe(0);
  });

  it("filters the complete profile set and returns opaque IDs only", () => {
    const live = project(
      [inventoryObject(10)],
      [{ objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" }],
    );
    const selected = selectOpaqueBookIdsByReadingStatus({
      profileId: PROFILE_ONE,
      allProfileBookIds: [BOOK_ONE, BOOK_TWO, BOOK_THREE, BOOK_TWO],
      projection: live,
      filter: "unknown",
    });
    expect(selected).toEqual([BOOK_TWO, BOOK_THREE]);
    expect(JSON.stringify(selected)).toBe(`["${BOOK_TWO}","${BOOK_THREE}"]`);
    expect(JSON.stringify(selected)).not.toMatch(/progress|timestamp|path|device|sidecar/iu);
  });

  it("rejects cross-profile, non-opaque, and over-limit filter inputs", () => {
    const live = project(
      [inventoryObject(10)],
      [{ objectHandle: 10, bookId: BOOK_ONE, match: "confirmed" }],
    );
    expect(() => selectOpaqueBookIdsByReadingStatus({
      profileId: PROFILE_TWO,
      allProfileBookIds: [BOOK_ONE],
      projection: live,
      filter: "any",
    })).toThrow(/different profile/iu);
    expect(() => selectOpaqueBookIdsByReadingStatus({
      profileId: PROFILE_ONE,
      allProfileBookIds: ["not-an-opaque-id"],
      projection: live,
      filter: "any",
    })).toThrow(/opaque/iu);
    expect(() => selectOpaqueBookIdsByReadingStatus({
      profileId: PROFILE_ONE,
      allProfileBookIds: [BOOK_ONE, BOOK_TWO],
      projection: live,
      filter: "any",
      options: { maxBookIds: 1 },
    })).toThrow(/bounded/iu);
  });
});
