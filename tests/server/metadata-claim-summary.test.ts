import { describe, expect, it } from "vitest";
import {
  summarizeGlobalMetadataClaims,
  type MetadataClaimBook,
} from "../../server/metadata-claim-summary.js";
import { METADATA_CLAIM_BITMAP_BYTES } from "../../shared/catalog-contracts.js";

function book(overrides: Partial<MetadataClaimBook> = {}): MetadataClaimBook {
  return {
    bookId: "book-active",
    title: "The Left Hand of Darkness",
    authors: ["Ursula K. Le Guin"],
    identifiers: ["ISBN:9780441478125"],
    hasKnownArtifactSize: true,
    ...overrides,
  };
}

function bit(bitmap: string, position: number): boolean {
  const bytes = Buffer.from(bitmap, "base64");
  return ((bytes[position >>> 3] ?? 0) & (1 << (position & 7))) !== 0;
}

describe("global metadata claimant summary", () => {
  it("returns one fixed-width bitmap and keeps globally unique books unmarked", () => {
    const summary = summarizeGlobalMetadataClaims(
      [book(), book({ bookId: "book-second", title: "A Wizard of Earthsea" })],
      [book({ bookId: "book-other", title: "The Dispossessed" })],
    );

    expect(summary.complete).toBe(true);
    expect(Buffer.from(summary.collisionBitmap, "base64")).toHaveLength(METADATA_CLAIM_BITMAP_BYTES);
    expect(bit(summary.collisionBitmap, 0)).toBe(false);
    expect(bit(summary.collisionBitmap, 1)).toBe(false);
  });

  it("marks normalized title/author collisions across either strong metadata tier", () => {
    const summary = summarizeGlobalMetadataClaims([book()], [
      book({
        bookId: "book-other",
        title: "  The LEFT hand—of darkness ",
        authors: ["Ursula K Le Guin"],
        identifiers: ["ASIN:B000FC1HBY"],
        hasKnownArtifactSize: true,
      }),
    ]);

    // Different catalog identifiers and sizes are deliberately still a
    // collision: the browser-only object can carry the other identifier or
    // have the other artifact size when the active book confirms by its tier.
    expect(summary.complete).toBe(true);
    expect(bit(summary.collisionBitmap, 0)).toBe(true);
  });

  it("marks disjoint catalog authors because one Kindle object can list both", () => {
    const summary = summarizeGlobalMetadataClaims([
      book({ authors: ["Alice Example"] }),
    ], [book({
      bookId: "book-other",
      authors: ["Bob Example"],
      identifiers: ["ASIN:B000OTHER"],
      hasKnownArtifactSize: false,
    })]);
    expect(summary.complete).toBe(true);
    expect(bit(summary.collisionBitmap, 0)).toBe(true);
  });

  it("does not count a shared-profile membership for the same book twice", () => {
    const summary = summarizeGlobalMetadataClaims([book()], [book()]);
    expect(summary.complete).toBe(true);
    expect(bit(summary.collisionBitmap, 0)).toBe(false);
  });

  it("ignores same-title rows that cannot make a strong metadata claim", () => {
    const summary = summarizeGlobalMetadataClaims([book()], [book({
      bookId: "book-title-only",
      identifiers: [],
      hasKnownArtifactSize: false,
    })]);
    expect(summary.complete).toBe(true);
    expect(bit(summary.collisionBitmap, 0)).toBe(false);
  });

  it("fails closed at catalog, atom, normalization, and comparison bounds", () => {
    expect(summarizeGlobalMetadataClaims([book()], [book({ bookId: "other" })], {
      maxGlobalBooks: 0,
    }).complete).toBe(false);
    expect(summarizeGlobalMetadataClaims([book()], [], { maxActiveAtoms: 0 }).complete).toBe(false);
    expect(summarizeGlobalMetadataClaims([book()], [], { maxNormalizedCodeUnits: 1 }).complete).toBe(false);
    expect(summarizeGlobalMetadataClaims([book()], [book({ bookId: "other" })], {
      maxComparisons: 0,
    }).complete).toBe(false);
    expect(summarizeGlobalMetadataClaims([book()], [], { maxElapsedMs: 0 }).complete).toBe(false);
  });
});
