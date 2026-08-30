import { describe, expect, it } from "vitest";
import {
  hasSufficientKindleObjectDistinguishability,
  matchCatalogBookToKindle,
  type KindleCatalogMatchInput,
  type KindleObjectMatchInput,
} from "../../client/src/kindle/matching";

const BOOK: KindleCatalogMatchInput = {
  title: "The Left Hand of Darkness",
  authors: ["Ursula K. Le Guin"],
  identifiers: ["isbn:978-0-441-47812-5"],
  sourceFilename: "The Left Hand of Darkness.epub",
  expectedArtifactSize: 1_024,
  managedToken: "kb-0123456789abcdefabcd",
};

function object(
  handle: number,
  overrides: Partial<KindleObjectMatchInput> = {},
): KindleObjectMatchInput {
  return {
    handle,
    filename: `object-${handle}.azw3`,
    size: 1_024,
    ...overrides,
  };
}

describe("Kindle inventory matching", () => {
  it("uses a prior persistent object identity before lower evidence", () => {
    const book = {
      ...BOOK,
      deliveries: [{ persistentObjectId: "mtp-puid-42" }],
    };
    const result = matchCatalogBookToKindle(book, [
      object(1, { persistentObjectId: "mtp-puid-42" }),
      object(2, {
        filename: "copy-kb-0123456789abcdefabcd.azw3",
        managedToken: BOOK.managedToken,
      }),
    ], "complete");

    expect(result).toMatchObject({
      status: "confirmed",
      evidence: "delivery-persistent-id",
      matchedObject: { handle: 1 },
      ambiguous: false,
    });
  });

  it("confirms a stable managed token and exact artifact size even if delivery recording failed", () => {
    const result = matchCatalogBookToKindle(BOOK, [
      object(7, {
        filename: "book-kb-0123456789abcdefabcd-20260829T120000Z-000000.azw3",
      }),
    ], "complete");

    expect(result).toMatchObject({
      status: "confirmed",
      evidence: "managed-token-size",
      matchedObject: { handle: 7 },
    });
  });

  it("reconstructs a confirmed match from the stable filename token after delivery-record failure", () => {
    const reloadedBook = {
      title: BOOK.title,
      authors: BOOK.authors,
      managedToken: BOOK.managedToken,
      // The backend delivery POST failed, so no delivery or artifact-size row exists.
      deliveries: [],
    };
    const result = matchCatalogBookToKindle(reloadedBook, [
      object(8, {
        filename: "book-kb-0123456789abcdefabcd-20260829T120000Z-000000.azw3",
        size: 9_999,
      }),
    ], "complete");

    expect(result).toMatchObject({
      status: "confirmed",
      evidence: "managed-token",
      matchedObject: { handle: 8 },
      ambiguous: false,
    });
  });

  it("keeps duplicate stable filename tokens ambiguous after reconnect", () => {
    const book = { managedToken: BOOK.managedToken, deliveries: [] };
    const result = matchCatalogBookToKindle(book, [
      object(9, { managedToken: BOOK.managedToken }),
      object(10, { managedToken: BOOK.managedToken }),
    ], "complete");

    expect(result).toMatchObject({
      status: "possible",
      evidence: "managed-token",
      ambiguous: true,
    });
    expect(result.candidates.map(({ handle }) => handle)).toEqual([9, 10]);
  });

  it("does not trust a token recovered from sanitized or truncated metadata", () => {
    const result = matchCatalogBookToKindle(
      { managedToken: BOOK.managedToken },
      [object(11, {
        filename: "book-kb-0123456789abcdefabcd.azw3",
        metadataAdjusted: true,
      })],
      "complete",
    );

    expect(result).toMatchObject({ status: "absent", evidence: "none" });
  });

  it("never confirms duplicate strongest evidence", () => {
    const deliveries = [{
      managedToken: BOOK.managedToken,
      artifactSize: 1_024,
    }];
    const result = matchCatalogBookToKindle({ ...BOOK, deliveries }, [
      object(1, { managedToken: BOOK.managedToken }),
      object(2, { managedToken: BOOK.managedToken }),
    ], "complete");

    expect(result).toMatchObject({
      status: "possible",
      evidence: "delivery-managed-token-size",
      ambiguous: true,
    });
    expect(result.candidates.map(({ handle }) => handle)).toEqual([1, 2]);
    expect(result).not.toHaveProperty("matchedObject");
  });

  it("confirms exact identifier, normalized title, and author evidence", () => {
    const result = matchCatalogBookToKindle({
      title: BOOK.title,
      authors: BOOK.authors,
      identifiers: BOOK.identifiers,
    }, [object(3, {
      title: "The Left Hand of Darkness",
      authors: ["Ursula K Le Guin"],
      identifiers: ["9780441478125"],
    })], "complete");

    expect(result).toMatchObject({
      status: "confirmed",
      evidence: "identifier-title-author",
      matchedObject: { handle: 3 },
    });
  });

  it.each([
    { title: "Преступление и наказание", author: "Фёдор Достоевский" },
    { title: "三体", author: "刘慈欣" },
    { title: "موسم الهجرة إلى الشمال", author: "الطيب صالح" },
  ])("preserves non-Latin title and author evidence: $title", ({ title, author }) => {
    const candidate = object(30, {
      title,
      authors: [author],
      identifiers: ["isbn:9780000000030"],
    });
    expect(hasSufficientKindleObjectDistinguishability(candidate)).toBe(true);
    expect(matchCatalogBookToKindle({
      title,
      authors: [author],
      identifiers: ["9780000000030"],
    }, [candidate], "complete")).toMatchObject({
      status: "confirmed",
      evidence: "identifier-title-author",
      matchedObject: { handle: 30 },
    });
  });

  it("keeps identifier-only overlap possible when title or author cannot corroborate it", () => {
    const result = matchCatalogBookToKindle({
      title: BOOK.title,
      authors: BOOK.authors,
      identifiers: BOOK.identifiers,
    }, [object(31, {
      title: "Conflicting metadata",
      authors: [],
      identifiers: ["isbn:9780441478125"],
    })], "complete");

    expect(result).toMatchObject({
      status: "possible",
      evidence: "identifier",
      candidates: [{ handle: 31 }],
      ambiguous: true,
    });
  });

  it("does not re-confirm an old managed content token through generic metadata", () => {
    const result = matchCatalogBookToKindle(BOOK, [object(32, {
      managedToken: "kb-fedcba9876543210abcd",
      title: BOOK.title,
      authors: BOOK.authors,
      identifiers: BOOK.identifiers,
    })], "complete");

    expect(result).toMatchObject({ status: "absent", evidence: "none" });
  });

  it.each([
    { managedToken: "not-a-managed-token", metadataAdjusted: false },
    { managedToken: "kb-fedcba9876543210abcd", metadataAdjusted: true },
  ])("does not give invalid or adjusted token text negative authority: %o", (tokenState) => {
    const result = matchCatalogBookToKindle(BOOK, [object(33, {
      ...tokenState,
      title: BOOK.title,
      authors: BOOK.authors,
      identifiers: BOOK.identifiers,
    })], "complete");

    expect(result).toMatchObject({ status: "confirmed", evidence: "identifier-title-author" });
  });

  it("downgrades strong evidence when inventory is partial", () => {
    const result = matchCatalogBookToKindle(BOOK, [
      object(4, { managedToken: BOOK.managedToken }),
    ], "partial");

    expect(result).toMatchObject({
      status: "possible",
      evidence: "managed-token-size",
      ambiguous: true,
    });
  });

  it("uses filename similarity only as possible evidence", () => {
    const result = matchCatalogBookToKindle({
      title: BOOK.title,
      sourceFilename: BOOK.sourceFilename,
    }, [object(5, {
      filename: "The-Left-Hand-of-Darkness-20260829T120000Z-000000.azw3",
      size: 999,
    })], "complete");

    expect(result).toMatchObject({
      status: "possible",
      evidence: "filename-similarity",
    });
  });

  it("reports absent only after a complete scan", () => {
    expect(matchCatalogBookToKindle(BOOK, [], "complete")).toMatchObject({
      status: "absent",
      evidence: "none",
      ambiguous: false,
    });
    expect(matchCatalogBookToKindle(BOOK, [], "partial")).toMatchObject({
      status: "possible",
      evidence: "inventory-partial",
      ambiguous: true,
    });
  });
});
