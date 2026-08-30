import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import initBoko, { book_info, convert } from "../../client/vendor/boko/boko.js";
import { prepareKindleSideload } from "../../client/src/api/azw3-sideload";

const MEBIBYTE = 1024 * 1024;

interface CentralClaim {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

function centralOnlyArchive(claims: readonly CentralClaim[]): Uint8Array {
  const central = claims.map((claim) => {
    const name = Buffer.from(claim.name);
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(claim.compressedSize, 20);
    entry.writeUInt32LE(claim.uncompressedSize, 24);
    entry.writeUInt16LE(name.length, 28);
    name.copy(entry, 46);
    return entry;
  });
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(claims.length, 8);
  end.writeUInt16LE(claims.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  return Buffer.concat([centralBytes, end]);
}

function entryCountOnlyArchive(entryCount: number): Uint8Array {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  return end;
}

interface ZipPayload {
  readonly archiveBytes: Buffer;
  readonly checksum: number;
  readonly compressionMethod: 0 | 8;
  readonly uncompressedSize: number;
}

interface ZipEntryInput {
  readonly name: string;
  readonly data: string | Buffer | ZipPayload;
}

function deflatedPayload(data: Buffer): ZipPayload {
  return {
    archiveBytes: deflateRawSync(data, { level: 1 }),
    checksum: crc32(data),
    compressionMethod: 8,
    uncompressedSize: data.byteLength,
  };
}

function isZipPayload(data: ZipEntryInput["data"]): data is ZipPayload {
  return !(typeof data === "string" || Buffer.isBuffer(data));
}

function zipArchive(entries: readonly ZipEntryInput[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = isZipPayload(entry.data)
      ? entry.data
      : (() => {
          const bytes = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
          return {
            archiveBytes: bytes,
            checksum: crc32(bytes),
            compressionMethod: 0 as const,
            uncompressedSize: bytes.byteLength,
          };
        })();

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(payload.compressionMethod, 8);
    local.writeUInt32LE(payload.checksum, 14);
    local.writeUInt32LE(payload.archiveBytes.byteLength, 18);
    local.writeUInt32LE(payload.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, payload.archiveBytes);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(payload.compressionMethod, 10);
    central.writeUInt32LE(payload.checksum, 16);
    central.writeUInt32LE(payload.archiveBytes.byteLength, 20);
    central.writeUInt32LE(payload.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + payload.archiveBytes.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function epubFixture(input: {
  readonly chapter?: string;
  readonly extraEntries?: readonly ZipEntryInput[];
  readonly extraManifest?: string;
  readonly spine?: string;
} = {}): Uint8Array {
  const chapter = input.chapter ??
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head>` +
    `<body><p>A structurally valid test book.</p></body></html>`;
  const spine = input.spine ?? `<itemref idref="chapter"/>`;
  return zipArchive([
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
        `<rootfiles><rootfile full-path="OEBPS/content.opf" ` +
        `media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: "OEBPS/content.opf",
      data:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">` +
        `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:identifier id="book-id">urn:uuid:boko-resource-limit-fixture</dc:identifier>` +
        `<dc:title>Boko resource-limit fixture</dc:title><dc:language>en</dc:language>` +
        `</metadata><manifest>` +
        `<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>` +
        (input.extraManifest ?? "") +
        `</manifest><spine>${spine}</spine></package>`,
    },
    { name: "OEBPS/chapter.xhtml", data: chapter },
    ...(input.extraEntries ?? []),
  ]);
}

function oversizedAzw3Fixture(): {
  readonly archive: Uint8Array;
  readonly compressedAssetBytes: number;
  readonly inflatedAssetBytes: number;
} {
  // Three independently addressable, valid SVG images force more than 200 MiB
  // of raw AZW3 resource records while keeping the EPUB source small. Level-1
  // DEFLATE stays comfortably below boko's 1000:1 archive-ratio ceiling.
  const bytesPerImage = 68 * MEBIBYTE;
  const svg = Buffer.alloc(bytesPerImage, 0x61);
  const prefix = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--`,
    "utf8",
  );
  const suffix = Buffer.from(`--><rect width="1" height="1"/></svg>`, "utf8");
  prefix.copy(svg, 0);
  suffix.copy(svg, svg.length - suffix.length);

  const payload = deflatedPayload(svg);
  const names = ["large-1.svg", "large-2.svg", "large-3.svg"];
  const archive = epubFixture({
    extraManifest: names
      .map((name, index) => `<item id="image-${index}" href="${name}" media-type="image/svg+xml"/>`)
      .join(""),
    extraEntries: names.map((name) => ({ name: `OEBPS/${name}`, data: payload })),
  });

  return {
    archive,
    compressedAssetBytes: payload.archiveBytes.byteLength * names.length,
    inflatedAssetBytes: payload.uncompressedSize * names.length,
  };
}

interface ConversionAttempt {
  readonly error: string | undefined;
  readonly output: Uint8Array | undefined;
}

function attemptConversion(epub: Uint8Array, to = "azw3"): ConversionAttempt {
  try {
    return { error: undefined, output: convert(epub, "epub", to) };
  } catch (error) {
    return { error: String(error), output: undefined };
  }
}

function conversionFailure(epub: Uint8Array, to = "azw3"): string {
  const attempt = attemptConversion(epub, to);
  return attempt.error ?? "hostile EPUB unexpectedly produced conversion output";
}

function bookInfoFailure(epub: Uint8Array): string {
  try {
    book_info(epub, "epub");
    return "hostile EPUB unexpectedly produced book metadata";
  } catch (error) {
    return String(error);
  }
}

describe("vendored boko WebAssembly", () => {
  beforeAll(async () => {
    const wasm = await readFile(fileURLToPath(new URL("../../client/vendor/boko/boko_bg.wasm", import.meta.url)));
    await initBoko(wasm);
  });

  it("converts a real EPUB to a structurally recognizable AZW3", async () => {
    const epub = await readFile(fileURLToPath(new URL("../fixtures/epictetus.epub", import.meta.url)));

    const metadata = JSON.parse(String(book_info(epub, "epub"))) as { title: string; chapters: number };
    const converted = convert(epub, "epub", "azw3");
    const prepared = prepareKindleSideload(converted);
    const azw3 = prepared.bytes;

    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.chapters).toBeGreaterThan(0);
    expect(new TextDecoder("ascii").decode(azw3.subarray(60, 68))).toBe("BOOKMOBI");
    expect(azw3.byteLength).toBeGreaterThan(10_000);
    expect(prepared.metadata).toEqual({
      documentType: "PDOC",
      embeddedCover: true,
    });
    expect(new TextDecoder("ascii").decode(azw3)).toContain("PDOC");
    const changedOffsets = [...converted.keys()].filter((index) => converted[index] !== azw3[index]);
    // EBOK -> PDOC changes three byte values; the third character is O in both.
    expect(changedOffsets).toHaveLength(3);
    expect(new TextDecoder("ascii").decode(
      converted.subarray(changedOffsets[0], changedOffsets.at(-1)! + 1),
    )).toBe("EBOK");
    expect(new TextDecoder("ascii").decode(
      azw3.subarray(changedOffsets[0], changedOffsets.at(-1)! + 1),
    )).toBe("PDOC");
  });

  it("rejects an excessive entry count in the actual WASM artifact before conversion output", () => {
    expect(conversionFailure(entryCountOnlyArchive(20_001))).toContain(
      "archive entry count exceeds the 20000 entry limit",
    );
  });

  it("rejects excessive aggregate inflated bytes in the actual WASM artifact before conversion output", () => {
    const claim: CentralClaim = {
      name: "asset.bin",
      compressedSize: 128 * 1024,
      uncompressedSize: 100 * 1024 * 1024,
    };
    expect(conversionFailure(centralOnlyArchive([claim, claim, claim]))).toContain(
      "aggregate inflated size exceeds the 268435456 byte limit",
    );
  });

  it("rejects a wide-flat XHTML DOM in the actual WASM normalization path", () => {
    const wideChapter =
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Wide</title></head><body>` +
      "<i></i>".repeat(100_001) +
      `</body></html>`;
    const epub = epubFixture({ chapter: wideChapter });

    // EPUB -> AZW3 normally preserves raw XHTML, so KFX is intentional: it
    // proves that the vendored artifact reaches and bounds the real DOM/IR path.
    expect(conversionFailure(epub, "kfx")).toContain(
      "document DOM node count exceeds the 100000 node limit",
    );
  });

  it("rejects deep MathML before recursive canonical-tree allocation in actual WASM", () => {
    const depth = 128;
    const chapter =
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>` +
      `<math xmlns="http://www.w3.org/1998/Math/MathML">` +
      "<mrow>".repeat(depth) +
      `<mi>x</mi>` +
      "</mrow>".repeat(depth) +
      `</math></body></html>`;

    expect(conversionFailure(epubFixture({ chapter }), "kfx")).toContain(
      "document MathML: nesting exceeds the 128 level limit",
    );
  });

  it("caps synthesized XHTML before a 32 MiB N+1 write in actual WASM", () => {
    // Quotes are valid raw XML text but synthesize as six-byte &quot; entities.
    // Seven MiB stays under the importer text/XHTML envelope while
    // forcing normalized output beyond 32 MiB. Store it uncompressed so the
    // archive-ratio guard does not reject the fixture first.
    const chapter =
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>` +
      '"'.repeat(7 * MEBIBYTE) +
      `</p></body></html>`;
    // EPUB -> KFX exercises the guarded DOM/IR import. Feeding that real KFX
    // back into AZW3 forces boko's normalized XHTML route (binary sources
    // cannot use raw XHTML passthrough).
    const kfx = convert(epubFixture({ chapter }), "epub", "kfx");
    let attempt: ConversionAttempt;
    try {
      attempt = { error: undefined, output: convert(kfx, "kfx", "azw3") };
    } catch (error) {
      attempt = { error: String(error), output: undefined };
    }
    expect(attempt.error).toContain(
      "normalized content: synthesized document exceeds the 33554432 byte limit",
    );
    expect(attempt.output).toBeUndefined();
  }, 60_000);

  it("rejects a 4,097-entry OPF spine in the actual WASM artifact before retaining it", () => {
    const epub = epubFixture({
      spine: `<itemref idref="chapter"/>`.repeat(4_097),
    });

    expect(bookInfoFailure(epub)).toContain(
      "EPUB spine chapter count exceeds the 4096 chapter limit",
    );
  });

  it("rejects AZW3 output beyond 200 MiB in the actual WASM artifact without returning partial bytes", () => {
    const fixture = oversizedAzw3Fixture();
    expect(fixture.inflatedAssetBytes).toBe(204 * MEBIBYTE);
    expect(fixture.inflatedAssetBytes).toBeLessThan(256 * MEBIBYTE);
    expect(fixture.inflatedAssetBytes / fixture.compressedAssetBytes).toBeLessThan(1_000);
    expect(fixture.archive.byteLength).toBeLessThan(200 * MEBIBYTE);

    const attempt = attemptConversion(fixture.archive);
    expect(attempt.error).toContain("AZW3 output exceeds the 209715200 byte limit");
    expect(attempt.output).toBeUndefined();
  }, 60_000);
});
