import { describe, expect, it } from "vitest";
import {
  deriveCatalogIssues,
  type CatalogIssueBookFacts,
} from "../../shared/catalog-issues";

function book(id: string, overrides: Partial<CatalogIssueBookFacts> = {}): CatalogIssueBookFacts {
  return {
    profileId: "prf-one",
    bookId: id,
    rootId: "root-one",
    title: `Title ${id}`,
    authors: ["Author"],
    identifiers: [],
    contentHash: id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    coverAvailable: true,
    metadataComplete: true,
    sourceAvailable: true,
    lastObservedAt: "2026-09-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("derived catalog issue model", () => {
  it("derives actionable single-book facts with stable signatures", () => {
    const facts = [book("book-one", {
      coverAvailable: false,
      metadataComplete: false,
      sourceAvailable: false,
      parserErrorCode: "epub-invalid-package",
    })];
    const first = deriveCatalogIssues("prf-one", facts);
    const second = deriveCatalogIssues("prf-one", facts);
    expect(first.map(({ type }) => type)).toEqual([
      "metadata-parser-failure", "incomplete-metadata", "unavailable-source", "missing-cover",
    ]);
    expect(first.map(({ signature }) => signature)).toEqual(second.map(({ signature }) => signature));
    expect(first.every((issue) => issue.bookIds[0] === "book-one")).toBe(true);
  });

  it("prefers exact content evidence when the same duplicate group has weaker evidence", () => {
    const sharedHash = "a".repeat(64);
    const issues = deriveCatalogIssues("prf-one", [
      book("one", { title: "Same!", identifiers: ["isbn:1234567890"], contentHash: sharedHash }),
      book("two", { title: "same", identifiers: ["ISBN 1234567890"], contentHash: sharedHash }),
    ]).filter(({ type }) => type === "suspected-duplicate");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      reasonCode: "duplicate-content-hash",
      bookIds: ["one", "two"],
    });
  });

  it("does not cross profile boundaries or merge different editions without evidence", () => {
    const issues = deriveCatalogIssues("prf-one", [
      book("one", { title: "A title", authors: ["One Author"], contentHash: undefined }),
      book("two", { title: "A title", authors: ["Another Author"], contentHash: undefined }),
      book("other", { profileId: "prf-two", title: "A title", authors: ["One Author"] }),
    ]);
    expect(issues.filter(({ type }) => type === "suspected-duplicate")).toHaveLength(0);
  });

  it("surfaces a stable low-confidence provider review issue", () => {
    const issues = deriveCatalogIssues("prf-one", [book("one", { lowConfidenceProviderData: true })]);
    expect(issues).toEqual([
      expect.objectContaining({
        type: "low-confidence-provider-data",
        severity: "warning",
        reasonCode: "provider-candidates-low-confidence",
        bookIds: ["one"],
      }),
    ]);
  });
});
