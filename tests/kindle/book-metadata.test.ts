import { describe, expect, it } from "vitest";
import {
  KindleBookMetadataError,
  parseKindleBookMetadata,
} from "../../client/src/kindle/book-metadata";
import { makeKindleBookFixture } from "./book-fixture";

describe("bounded Kindle PalmDB/MOBI/EXTH metadata parsing", () => {
  it("extracts the preferred title, every author, identifiers 113/504, and language", () => {
    const bytes = makeKindleBookFixture({
      mobiTitle: "MOBI fallback",
      exthTitle: "The Left Hand of Darkness",
      authors: ["Ursula K. Le Guin", "A Second Contributor"],
      isbn: "978-0-441-47812-5",
      source: "urn:uuid:source-id",
      asin113: "B000FC1HBY",
      asin504: "B0DIFFERENT",
      language: "en-US",
    });
    const before = bytes.slice();

    expect(parseKindleBookMetadata(bytes)).toEqual({
      title: "The Left Hand of Darkness",
      authors: ["Ursula K. Le Guin", "A Second Contributor"],
      identifiers: [
        "isbn:978-0-441-47812-5",
        "source:urn:uuid:source-id",
        "asin:B000FC1HBY",
        "asin:B0DIFFERENT",
      ],
      language: "en-US",
    });
    expect(bytes).toEqual(before);
  });

  it("falls back to the MOBI full-name field when EXTH has no title", () => {
    const bytes = makeKindleBookFixture({
      databaseTitle: "Database fallback",
      mobiTitle: "MOBI full name",
    });

    expect(parseKindleBookMetadata(bytes)).toEqual({
      title: "MOBI full name",
      authors: [],
      identifiers: [],
    });
  });

  it("rejects input, EXTH count, field, and record bounds without allocating from them", () => {
    const source = makeKindleBookFixture({ authors: ["Author"] });
    expect(() => parseKindleBookMetadata(source, {
      maxInputBytes: source.byteLength - 1,
    })).toThrowError(expect.objectContaining({ code: "KINDLE_METADATA_INPUT_LIMIT" }));

    const hostileCount = source.slice();
    const exth = 88 + 16 + 0xe4;
    new DataView(hostileCount.buffer).setUint32(exth + 8, 0xffff_ffff, false);
    expect(() => parseKindleBookMetadata(hostileCount)).toThrowError(
      expect.objectContaining({ code: "KINDLE_METADATA_INVALID_EXTH" }),
    );

    const longField = makeKindleBookFixture({ authors: ["A".repeat(32)] });
    expect(() => parseKindleBookMetadata(longField, { maxFieldBytes: 16 })).toThrowError(
      expect.objectContaining({ code: "KINDLE_METADATA_FIELD_LIMIT" }),
    );

    const invalidRecord = source.slice();
    new DataView(invalidRecord.buffer).setUint32(exth + 12 + 4, 0xffff_ffff, false);
    expect(() => parseKindleBookMetadata(invalidRecord)).toThrowError(
      expect.objectContaining({ code: "KINDLE_METADATA_INVALID_EXTH" }),
    );
  });

  it("uses a stable typed error for non-Kindle bytes", () => {
    try {
      parseKindleBookMetadata(new Uint8Array(128));
      throw new Error("expected parser to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(KindleBookMetadataError);
      expect(error).toMatchObject({ code: "KINDLE_METADATA_INVALID_PALMDB" });
    }
  });
});
