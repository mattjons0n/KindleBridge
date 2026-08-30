import { describe, expect, it } from "vitest";
import {
  createCollisionResistantFilename,
  createManagedCollisionResistantFilename,
  createManagedFilenameToken,
  extractManagedFilenameToken,
  filenamesEqual,
  sanitizeKindleFilename,
} from "../../client/src/kindle/filenames";

describe("Kindle filenames", () => {
  it("removes paths, unsafe characters, and non-ASCII ambiguity", () => {
    expect(sanitizeKindleFilename("../../Caf\u00e9: My/Book.epub", "azw3")).toBe(
      "Book.azw3",
    );
    expect(sanitizeKindleFilename("Caf\u00e9: My Book.epub", ".AZW3")).toBe(
      "Cafe-My-Book.azw3",
    );
  });

  it("replaces reserved or empty stems", () => {
    expect(sanitizeKindleFilename("CON.epub", "azw3")).toBe("book.azw3");
    expect(sanitizeKindleFilename("\u65e5\u672c\u8a9e.epub", "azw3")).toBe("book.azw3");
  });

  it("adds a deterministic collision-resistant suffix within the limit", () => {
    const result = createCollisionResistantFilename(
      "A very long book title that should be truncated safely.epub",
      "azw3",
      {
        now: new Date("2026-08-26T12:34:56.789Z"),
        random: () => 0,
        maxLength: 48,
      },
    );

    expect(result).toBe("A-very-long-book-ti-20260826T123456Z-000000.azw3");
    expect(result).toHaveLength(48);
  });

  it("compares collisions case-insensitively after normalization", () => {
    expect(filenamesEqual("CAF\u00c9.AZW3", "cafe\u0301.azw3")).toBe(true);
  });

  it("derives a stable opaque managed token and round-trips it through a filename", async () => {
    const token = await createManagedFilenameToken("book_f8484ee7-d3d7-459d-8e25-a41c8cfa2c32", "a".repeat(64));
    const repeated = await createManagedFilenameToken("book_f8484ee7-d3d7-459d-8e25-a41c8cfa2c32", "a".repeat(64));
    const filename = createManagedCollisionResistantFilename(
      "The Left Hand of Darkness.epub",
      "azw3",
      token,
      {
        now: new Date("2026-08-29T12:34:56Z"),
        random: () => 0,
      },
    );

    expect(token).toMatch(/^kb-[0-9a-f]{20}$/u);
    expect(repeated).toBe(token);
    await expect(createManagedFilenameToken(
      "book_f8484ee7-d3d7-459d-8e25-a41c8cfa2c32",
      "b".repeat(64),
    )).resolves.not.toBe(token);
    expect(filename).toBe(
      `The-Left-Hand-of-Darkness-${token}-20260829T123456Z-000000.azw3`,
    );
    expect(extractManagedFilenameToken(filename)).toBe(token);
  });

  it("refuses conflicting managed tokens in one filename", () => {
    expect(extractManagedFilenameToken(
      "book-kb-0123456789abcdefabcd-kb-fedcba9876543210fedc.azw3",
    )).toBeUndefined();
  });
});
