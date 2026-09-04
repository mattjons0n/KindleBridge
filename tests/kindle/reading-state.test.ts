import { describe, expect, it } from "vitest";
import {
  associateKindleReadingEvidence,
  filterBookIdsByReadingStatus,
  retireKindleReadingEvidence,
  unknownKindleReadingEvidence,
  validateKindleReadingEvidence,
  type KindleReadingEvidence,
} from "../../client/src/kindle/reading-state";

describe("Kindle reading-state evidence", () => {
  it("never turns a near-end percentage into authoritative Read", () => {
    expect(validateKindleReadingEvidence({
      status: "read",
      progressPercent: 100,
      provenance: "azw3r",
      freshness: "live",
      explicitState: false,
    })).toBeUndefined();
    expect(validateKindleReadingEvidence({
      status: "in-progress",
      progressPercent: 100,
      provenance: "azw3r",
      freshness: "live",
      explicitState: false,
    })).toMatchObject({ status: "in-progress", progressPercent: 100 });
  });

  it("accepts bounded explicit states and rejects contradictory values", () => {
    expect(validateKindleReadingEvidence({
      status: "read",
      progressPercent: 100,
      lastReadAt: "2026-09-03T12:00:00Z",
      provenance: "yjf",
      freshness: "live",
      explicitState: true,
    })).toMatchObject({ status: "read", explicitState: true });
    expect(validateKindleReadingEvidence({
      status: "unread",
      progressPercent: 1,
      provenance: "mbp1",
      freshness: "live",
      explicitState: true,
    })).toBeUndefined();
    expect(unknownKindleReadingEvidence("mbs")).toEqual({
      status: "unknown", provenance: "mbs", freshness: "live", explicitState: false,
    });
  });

  it("associates evidence only to one strongly matched current object", () => {
    const evidence: KindleReadingEvidence = {
      status: "in-progress",
      progressPercent: 45,
      provenance: "azw3f",
      freshness: "live",
      explicitState: false,
    };
    expect(associateKindleReadingEvidence({
      bookId: "book-one", match: "confirmed", duplicateBookClaim: false, evidence,
    })).toEqual({ bookId: "book-one", evidence });
    expect(associateKindleReadingEvidence({
      bookId: "book-one", match: "possible", duplicateBookClaim: false, evidence,
    })).toBeUndefined();
    expect(associateKindleReadingEvidence({
      bookId: "book-one", match: "confirmed", duplicateBookClaim: true, evidence,
    })).toBeUndefined();
  });

  it("filters opaque catalog IDs without exposing progress to the backend", () => {
    const evidence = new Map<string, KindleReadingEvidence>([
      ["one", { status: "read", provenance: "yjf", freshness: "live", explicitState: true }],
      ["two", { status: "in-progress", progressPercent: 20, provenance: "azw3r", freshness: "live", explicitState: false }],
    ]);
    expect(filterBookIdsByReadingStatus(["one", "two", "three"], evidence, "read")).toEqual(["one"]);
    expect(filterBookIdsByReadingStatus(["one", "two", "three"], evidence, "unknown")).toEqual(["three"]);
    expect(retireKindleReadingEvidence(evidence).get("two")?.freshness).toBe("last-seen");
  });
});
