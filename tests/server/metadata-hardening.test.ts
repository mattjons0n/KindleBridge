import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_METADATA_LIMITS,
  MetadataError,
  extractAzw3Metadata,
  extractEpubMetadata,
  inspectRasterImage,
} from "../../server/book-metadata.js";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogIndexer } from "../../server/catalog-indexer.js";
import { CoverCache } from "../../server/cover-cache.js";
import { MetadataWorkerPool } from "../../server/metadata-worker-pool.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";
import { makeKindleBookFixture } from "../kindle/book-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("metadata ingestion hardening", () => {
  it("keeps the server source limit aligned with the browser's 200 MiB boundary", () => {
    expect(DEFAULT_METADATA_LIMITS.maxBookBytes).toBe(200 * 1024 * 1024);
  });

  it("keeps EPUB catalog eligibility inside the browser converter's archive envelope", () => {
    expect(DEFAULT_METADATA_LIMITS).toMatchObject({
      maxArchiveEntries: 20_000,
      maxCentralDirectoryBytes: 24 * 1024 * 1024,
      maxArchiveUncompressedBytes: 256 * 1024 * 1024,
      maxArchiveEntryBytes: 128 * 1024 * 1024,
      maxArchiveNameBytes: 8 * 1024 * 1024,
      maxArchiveEntryNameBytes: 2_048,
      maxCompressionRatio: 1_000,
    });
  });

  it("rejects EPUB per-entry and aggregate-name claims outside the converter envelope", () => {
    const oneEntry = zipArchive([{ name: "asset.bin", data: Buffer.from("1234") }]);
    expect(() => extractEpubMetadata(oneEntry, "fallback", { maxArchiveEntryBytes: 3 })).toThrow(
      expect.objectContaining({ code: "archive_limit" }),
    );
    expect(() => extractEpubMetadata(oneEntry, "fallback", { maxArchiveEntryNameBytes: 8 })).toThrow(
      expect.objectContaining({ code: "archive_limit" }),
    );

    const severalNames = zipArchive([
      { name: "first.bin", data: Buffer.alloc(0) },
      { name: "second.bin", data: Buffer.alloc(0) },
    ]);
    expect(() => extractEpubMetadata(severalNames, "fallback", { maxArchiveNameBytes: 10 })).toThrow(
      expect.objectContaining({ code: "archive_limit" }),
    );
  });

  it("records an oversized source error before hashing or invoking a parser", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-source-limit-test-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    const oversized = path.join(source, "oversized.epub");
    await writeFile(oversized, "");
    await truncate(oversized, DEFAULT_METADATA_LIMITS.maxBookBytes + 1);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Limit" });
    database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let parserCalls = 0;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => {
        parserCalls += 1;
        throw new Error("parser must not run");
      },
    );
    try {
      await indexer.start();
      const row = database.database
        .prepare("SELECT content_hash, last_error_code FROM source_files")
        .get() as { content_hash: string; last_error_code: string };
      expect(parserCalls).toBe(0);
      expect(row.last_error_code).toBe("book_too_large");
      expect(row.content_hash).toMatch(/^rejected:book_too_large:/u);
      expect(database.listBooks(profile.id).total).toBe(0);
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("rejects oversized raster dimensions for PNG, JPEG, GIF, and WebP without decoding pixels", () => {
    const images = [
      pngHeader(101, 2),
      jpegHeader(101, 2),
      gifHeader(101, 2),
      webpHeader(101, 2),
    ];
    for (const image of images) {
      expect(inspectRasterImage(image)).toMatchObject({ width: 101, height: 2 });
      const metadata = extractEpubMetadata(epubWithCover(image), "fallback", {
        maxCoverWidth: 100,
        maxCoverHeight: 100,
        maxCoverPixels: 10_000,
      });
      expect(metadata.title).toBe("Dimension Test");
      expect(metadata.cover).toBeNull();
      expect(metadata.coverMediaType).toBeNull();
    }
  });

  it("applies a separate pixel-count ceiling even when each dimension is allowed", () => {
    const image = pngHeader(20, 20);
    const metadata = extractEpubMetadata(epubWithCover(image), "fallback", {
      maxCoverWidth: 100,
      maxCoverHeight: 100,
      maxCoverPixels: 399,
    });
    expect(metadata.cover).toBeNull();
  });

  it("follows a bounded EPUB2 guide cover XHTML page to its embedded raster", () => {
    const cover = pngHeader(320, 480);
    const epub = zipArchive([
      {
        name: "META-INF/container.xml",
        data: Buffer.from('<container><rootfile full-path="OPS/package.opf"/></container>'),
      },
      {
        name: "OPS/package.opf",
        data: Buffer.from(
          '<package><metadata><title>EPUB2 Guide Cover</title><creator>Cover Author</creator></metadata>' +
            '<manifest><item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="cover-image" href="Images/cover.png" media-type="image/png"/></manifest>' +
            '<guide><reference type="cover" href="Text/cover.xhtml"/></guide></package>',
        ),
      },
      {
        name: "OPS/Text/cover.xhtml",
        data: Buffer.from('<html><body><img alt="Cover" src="../Images/cover.png"/></body></html>'),
      },
      { name: "OPS/Images/cover.png", data: cover },
    ]);

    const metadata = extractEpubMetadata(epub, "fallback");

    expect(metadata.cover).toEqual(cover);
    expect(metadata.coverMediaType).toBe("image/png");
  });

  it("rejects encrypted EPUB content while allowing standard font obfuscation only for fonts", () => {
    expect(() =>
      extractEpubMetadata(
        encryptedEpub("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OPS/chapter.xhtml"),
        "fallback",
      ),
    ).toThrow(expect.objectContaining({ code: "drm_unsupported" }));

    for (const algorithm of [
      "http://www.idpf.org/2008/embedding",
      "http://ns.adobe.com/pdf/enc#RC",
    ]) {
      expect(extractEpubMetadata(encryptedEpub(algorithm, "OPS/font.otf"), "fallback").title).toBe(
        "Encryption Test",
      );
    }

    expect(() =>
      extractEpubMetadata(
        encryptedEpub("http://www.idpf.org/2008/embedding", "OPS/chapter.xhtml"),
        "fallback",
      ),
    ).toThrow(expect.objectContaining({ code: "drm_unsupported" }));
  });

  it("rejects AZW3 sources with a non-zero PalmDOC encryption word", () => {
    const azw3 = makeKindleBookFixture({
      exthTitle: "Encrypted AZW3",
      authors: ["Test Author"],
    });
    const view = new DataView(azw3.buffer, azw3.byteOffset, azw3.byteLength);
    const recordZero = view.getUint32(78, false);
    view.setUint16(recordZero + 12, 2, false);

    expect(() => extractAzw3Metadata(Buffer.from(azw3), "fallback")).toThrow(
      expect.objectContaining({ code: "drm_unsupported" }),
    );
  });

  it("rejects legacy or non-readable BOOKMOBI containers before cataloging them as AZW3", () => {
    const fixture = makeKindleBookFixture({ exthTitle: "Readable KF8", authors: ["Author"] });
    expect(() => extractAzw3Metadata(Buffer.from(fixture), "fallback")).not.toThrow();
    const recordZero = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength).getUint32(78, false);

    const noText = fixture.slice();
    new DataView(noText.buffer).setUint32(recordZero + 4, 0, false);
    expect(() => extractAzw3Metadata(Buffer.from(noText), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/text length/u) }),
    );

    const noTextRecords = fixture.slice();
    new DataView(noTextRecords.buffer).setUint16(recordZero + 8, 0, false);
    expect(() => extractAzw3Metadata(Buffer.from(noTextRecords), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/record count/u) }),
    );

    const invalidRecordSize = fixture.slice();
    new DataView(invalidRecordSize.buffer).setUint16(recordZero + 10, 0, false);
    expect(() => extractAzw3Metadata(Buffer.from(invalidRecordSize), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/record size/u) }),
    );

    const legacy = fixture.slice();
    new DataView(legacy.buffer).setUint32(recordZero + 16 + 20, 6, false);
    expect(() => extractAzw3Metadata(Buffer.from(legacy), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/KF8 version 8/u) }),
    );

    const unreadable = fixture.slice();
    const textRecord = new DataView(unreadable.buffer).getUint32(86, false);
    unreadable.fill(0, textRecord);
    expect(() => extractAzw3Metadata(Buffer.from(unreadable), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/no readable book content/u) }),
    );

    const huffClaim = fixture.slice();
    new DataView(huffClaim.buffer).setUint16(recordZero, 17_480, false);
    expect(() => extractAzw3Metadata(Buffer.from(huffClaim), "fallback")).toThrow(
      expect.objectContaining({
        code: "unsupported_compression",
        message: expect.stringMatching(/17480/u),
      }),
    );

    const expandedText = fixture.slice();
    new DataView(expandedText.buffer).setUint32(recordZero + 4, 128 * 1024 * 1024 + 1, false);
    expect(() => extractAzw3Metadata(Buffer.from(expandedText), "fallback")).toThrow(
      expect.objectContaining({ code: "metadata_limit", message: expect.stringMatching(/128 MiB/u) }),
    );

    const excessiveExth = fixture.slice();
    const excessiveExthView = new DataView(excessiveExth.buffer);
    const mobi = recordZero + 16;
    excessiveExthView.setUint32(
      mobi + 128,
      excessiveExthView.getUint32(mobi + 128, false) | 0x40,
      false,
    );
    const exth = mobi + excessiveExthView.getUint32(mobi + 4, false);
    excessiveExthView.setUint32(exth + 8, 10_001, false);
    expect(() => extractAzw3Metadata(Buffer.from(excessiveExth), "fallback")).toThrow(
      expect.objectContaining({ code: "invalid_azw3", message: expect.stringMatching(/EXTH header/u) }),
    );
  });

  it("quarantines changed rejected sources and reparses unchanged errors until the same book recovers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-source-recovery-test-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    const bookPath = path.join(source, "recoverable.epub");
    await writeFile(bookPath, "initial-valid-source");

    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Recovery" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let parserCalls = 0;
    let parserMode: "valid" | "drm" = "valid";
    let title = "Initially valid";
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => {
        parserCalls += 1;
        if (parserMode === "drm") {
          throw new MetadataError("drm_unsupported", "Encrypted content is unsupported.");
        }
        return extractedMetadata(title);
      },
    );

    try {
      await indexer.start();
      const original = database.listBooks(profile.id).items[0];
      expect(original).toMatchObject({ title: "Initially valid", available: true });
      expect(parserCalls).toBe(1);

      parserMode = "drm";
      await writeFile(bookPath, "changed-and-now-encrypted-source");
      await indexer.scanNow(root.id);
      const rejected = database.getBook(profile.id, original!.id);
      const rejectedSource = database.database
        .prepare("SELECT available, last_error_code FROM source_files WHERE root_id = ? AND relative_path = ?")
        .get(root.id, "recoverable.epub") as { available: number; last_error_code: string };
      expect(rejected).toMatchObject({
        id: original!.id,
        title: "Initially valid",
        available: false,
      });
      expect(rejectedSource).toEqual({ available: 0, last_error_code: "drm_unsupported" });
      expect(database.getBookSource(profile.id, original!.id)?.book.available).toBe(false);
      expect(parserCalls).toBe(2);

      // The bytes and stat tuple are unchanged, but an error row must never use
      // the successful-source shortcut or clear the error without parsing.
      await indexer.scanNow(root.id);
      expect(parserCalls).toBe(3);
      expect(database.getBook(profile.id, original!.id)?.available).toBe(false);
      expect(
        database.database
          .prepare("SELECT last_error_code FROM source_files WHERE root_id = ? AND relative_path = ?")
          .get(root.id, "recoverable.epub"),
      ).toEqual({ last_error_code: "drm_unsupported" });

      // A fixed parser/source can recover even if filesystem size and mtime did
      // not change since the last rejected scan. The durable book ID is reused.
      parserMode = "valid";
      title = "Recovered metadata";
      await indexer.scanNow(root.id);
      expect(parserCalls).toBe(4);
      expect(database.getBook(profile.id, original!.id)).toMatchObject({
        id: original!.id,
        title: "Recovered metadata",
        available: true,
      });
      expect(
        database.database
          .prepare("SELECT available, last_error_code FROM source_files WHERE root_id = ? AND relative_path = ?")
          .get(root.id, "recoverable.epub"),
      ).toEqual({ available: 1, last_error_code: null });

      // The same quarantine path applies before parser invocation to an
      // oversized replacement, and a later small replacement still recovers.
      await truncate(bookPath, DEFAULT_METADATA_LIMITS.maxBookBytes + 1);
      await indexer.scanNow(root.id);
      expect(parserCalls).toBe(4);
      expect(database.getBook(profile.id, original!.id)?.available).toBe(false);
      expect(
        database.database
          .prepare("SELECT available, last_error_code FROM source_files WHERE root_id = ? AND relative_path = ?")
          .get(root.id, "recoverable.epub"),
      ).toEqual({ available: 0, last_error_code: "book_too_large" });

      await indexer.scanNow(root.id);
      expect(parserCalls).toBe(4);
      expect(database.getBook(profile.id, original!.id)?.available).toBe(false);

      title = "Recovered after oversize";
      await writeFile(bookPath, "small-valid-again");
      await indexer.scanNow(root.id);
      expect(parserCalls).toBe(5);
      expect(database.getBook(profile.id, original!.id)).toMatchObject({
        id: original!.id,
        title: "Recovered after oversize",
        available: true,
      });
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("requeues an in-progress write and preserves the prior good row until the source is stable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-source-growth-test-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const bookPath = path.join(source, "growing.epub");
    await mkdir(source, { recursive: true });
    await writeFile(bookPath, "alpha");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Growth race" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let growDuringParse = false;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (snapshotFilename) => {
        const snapshotted = await readFile(snapshotFilename, "utf8");
        if (growDuringParse) {
          growDuringParse = false;
          await appendFile(bookPath, "-growth");
        }
        return extractedMetadata(snapshotted);
      },
    );

    try {
      await indexer.start();
      const original = database.listBooks(profile.id).items[0]!;
      await writeFile(bookPath, "bravo");
      growDuringParse = true;
      await indexer.scanNow(root.id);
      expect(database.getBook(profile.id, original.id)).toMatchObject({
        id: original.id,
        title: "alpha",
        available: true,
      });
      expect(database.database.prepare("SELECT content_hash, last_error_code FROM source_files").get()).toEqual({
        content_hash: createHash("sha256").update("alpha").digest("hex"),
        last_error_code: null,
      });
      expect(database.listRoots(profile.id)[0]).toMatchObject({ status: "error", lastErrorCode: "unstable_source" });

      await indexer.scanNow(root.id);
      expect(database.getBook(profile.id, original.id)).toMatchObject({
        id: original.id,
        title: "bravo-growth",
        available: true,
      });
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("rejects an atomic path replacement after parsing the descriptor-bound snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-source-replace-test-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const bookPath = path.join(source, "replaced.epub");
    const replacementPath = path.join(source, "replacement.tmp");
    await mkdir(source, { recursive: true });
    await writeFile(bookPath, "alpha");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Replacement race" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let replaceDuringParse = false;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (snapshotFilename) => {
        const snapshotted = await readFile(snapshotFilename, "utf8");
        if (replaceDuringParse) {
          replaceDuringParse = false;
          await rename(replacementPath, bookPath);
        }
        return extractedMetadata(snapshotted);
      },
    );

    try {
      await indexer.start();
      const original = database.listBooks(profile.id).items[0]!;
      await writeFile(bookPath, "bravo");
      await writeFile(replacementPath, "charlie");
      replaceDuringParse = true;
      await indexer.scanNow(root.id);
      expect(database.getBook(profile.id, original.id)).toMatchObject({ title: "alpha", available: true });
      expect(database.database.prepare("SELECT last_error_code FROM source_files").get()).toEqual({
        last_error_code: null,
      });

      await indexer.scanNow(root.id);
      expect(database.getBook(profile.id, original.id)).toMatchObject({
        id: original.id,
        title: "charlie",
        available: true,
      });
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("rejects a final symlink swap instead of committing metadata from another path state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-source-symlink-test-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "library");
    const source = path.join(allowed, "books");
    const bookPath = path.join(source, "swapped.epub");
    const targetPath = path.join(source, "target.bin");
    await mkdir(source, { recursive: true });
    await writeFile(bookPath, "alpha");
    await writeFile(targetPath, "symlink target");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Symlink race" });
    const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    let swapDuringParse = false;
    const indexer = new CatalogIndexer(
      database,
      await AllowedRootPolicy.create([allowed]),
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async (snapshotFilename) => {
        const snapshotted = await readFile(snapshotFilename, "utf8");
        if (swapDuringParse) {
          swapDuringParse = false;
          await rm(bookPath);
          await symlink(targetPath, bookPath);
        }
        return extractedMetadata(snapshotted);
      },
    );

    try {
      await indexer.start();
      const original = database.listBooks(profile.id).items[0]!;
      await writeFile(bookPath, "bravo");
      swapDuringParse = true;
      await indexer.scanNow(root.id);
      expect(database.getBook(profile.id, original.id)).toMatchObject({ title: "alpha", available: true });
      expect(database.database.prepare("SELECT last_error_code FROM source_files").get()).toEqual({
        last_error_code: null,
      });
    } finally {
      await indexer.stop();
      database.close();
    }
  });

  it("terminates a wedged parser and replaces its worker for the next source", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-metadata-worker-test-"));
    temporaryDirectories.push(directory);
    const moduleFilename = path.join(directory, "extractor.mjs");
    await writeFile(
      moduleFilename,
      "export async function extractBookMetadata() { while (true) {} }\n",
    );
    const pool = new MetadataWorkerPool({
      size: 1,
      timeoutMs: 250,
      moduleUrl: pathToFileURL(moduleFilename).href,
    });
    try {
      await expect(pool.extract(path.join(directory, "wedged.epub"), "epub")).rejects.toMatchObject({
        code: "metadata_timeout",
      });

      await writeFile(
        moduleFilename,
        `export async function extractBookMetadata() {
          return {
            title: "Recovered", authors: [], authorSort: null, language: null,
            publisher: null, publishedAt: null, series: null, subjects: [],
            identifiers: [], metadataComplete: false, cover: null, coverMediaType: null
          };
        }\n`,
      );
      await expect(pool.extract(path.join(directory, "next.epub"), "epub")).resolves.toMatchObject({
        title: "Recovered",
        cover: null,
      });
    } finally {
      await pool.close();
    }
  });
});

interface ZipEntry {
  name: string;
  data: Buffer;
}

function epubWithCover(cover: Buffer): Buffer {
  return zipArchive([
    {
      name: "META-INF/container.xml",
      data: Buffer.from('<container><rootfile full-path="OPS/book.opf"/></container>'),
    },
    {
      name: "OPS/book.opf",
      data: Buffer.from(
        '<package><metadata><title>Dimension Test</title><creator>Test Author</creator></metadata>' +
          '<manifest><item id="cover" href="cover.bin" media-type="image/png" properties="cover-image"/></manifest>' +
          "</package>",
      ),
    },
    { name: "OPS/cover.bin", data: cover },
  ]);
}

function encryptedEpub(algorithm: string, resource: string): Buffer {
  return zipArchive([
    {
      name: "META-INF/container.xml",
      data: Buffer.from('<container><rootfile full-path="OPS/book.opf"/></container>'),
    },
    {
      name: "META-INF/encryption.xml",
      data: Buffer.from(
        `<encryption><EncryptedData><EncryptionMethod Algorithm="${algorithm}"/>` +
          `<CipherData><CipherReference URI="${resource}"/></CipherData></EncryptedData></encryption>`,
      ),
    },
    {
      name: "OPS/book.opf",
      data: Buffer.from(
        '<package><metadata><title>Encryption Test</title><creator>Test Author</creator></metadata><manifest>' +
          '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="font" href="font.otf" media-type="application/vnd.ms-opentype"/>' +
          "</manifest></package>",
      ),
    },
    { name: "OPS/chapter.xhtml", data: Buffer.from("encrypted chapter") },
    { name: "OPS/font.otf", data: Buffer.from("obfuscated font") },
  ]);
}

function pngHeader(width: number, height: number): Buffer {
  const result = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function jpegHeader(width: number, height: number): Buffer {
  const result = Buffer.alloc(13);
  result.set([0xff, 0xd8, 0xff, 0xc0], 0);
  result.writeUInt16BE(7, 4);
  result[6] = 8;
  result.writeUInt16BE(height, 7);
  result.writeUInt16BE(width, 9);
  result.set([0xff, 0xd9], 11);
  return result;
}

function gifHeader(width: number, height: number): Buffer {
  const result = Buffer.alloc(10);
  result.write("GIF89a", 0, "ascii");
  result.writeUInt16LE(width, 6);
  result.writeUInt16LE(height, 8);
  return result;
}

function webpHeader(width: number, height: number): Buffer {
  const result = Buffer.alloc(30);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WEBP", 8, "ascii");
  result.write("VP8X", 12, "ascii");
  result.writeUInt32LE(10, 16);
  result.writeUIntLE(width - 1, 24, 3);
  result.writeUIntLE(height - 1, 27, 3);
  return result;
}

function zipArchive(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractedMetadata(title: string) {
  return {
    title,
    authors: ["Test Author"],
    authorSort: "Test Author",
    language: "en",
    publisher: null,
    publishedAt: null,
    series: null,
    subjects: [],
    identifiers: [],
    metadataComplete: true,
    cover: null,
    coverMediaType: null,
  };
}
