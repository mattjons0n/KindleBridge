import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { BookFormat } from "../shared/catalog-contracts.js";

const MAX_AZW3_DECODED_TEXT_BYTES = 128 * 1024 * 1024;

export interface ExtractedBookMetadata {
  title: string;
  authors: string[];
  authorSort: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  series: string | null;
  subjects: string[];
  identifiers: string[];
  metadataComplete: boolean;
  cover: Buffer | null;
  coverMediaType: string | null;
}

export interface MetadataLimits {
  maxBookBytes: number;
  maxArchiveEntries: number;
  maxCentralDirectoryBytes: number;
  maxArchiveUncompressedBytes: number;
  maxArchiveEntryBytes: number;
  maxArchiveNameBytes: number;
  maxArchiveEntryNameBytes: number;
  maxXmlBytes: number;
  maxCoverBytes: number;
  maxCoverWidth: number;
  maxCoverHeight: number;
  maxCoverPixels: number;
  maxCompressionRatio: number;
}

export const DEFAULT_METADATA_LIMITS: Readonly<MetadataLimits> = {
  // Keep the catalog and browser transfer boundaries identical. The browser
  // rejects sources above 200 MiB, so indexing a larger source would create a
  // catalog entry that can never be sent.
  maxBookBytes: 200 * 1024 * 1024,
  maxArchiveEntries: 20_000,
  maxCentralDirectoryBytes: 24 * 1024 * 1024,
  // Keep catalog eligibility inside the stricter browser-local boko envelope.
  // Otherwise a book can be indexed as available but deterministically fail
  // before the one-click conversion begins.
  maxArchiveUncompressedBytes: 256 * 1024 * 1024,
  maxArchiveEntryBytes: 128 * 1024 * 1024,
  maxArchiveNameBytes: 8 * 1024 * 1024,
  maxArchiveEntryNameBytes: 2_048,
  maxXmlBytes: 4 * 1024 * 1024,
  maxCoverBytes: 12 * 1024 * 1024,
  maxCoverWidth: 8_192,
  maxCoverHeight: 8_192,
  maxCoverPixels: 40_000_000,
  maxCompressionRatio: 1_000,
};

export type MetadataErrorCode =
  | "book_too_large"
  | "invalid_epub"
  | "invalid_azw3"
  | "archive_limit"
  | "metadata_limit"
  | "metadata_timeout"
  | "drm_unsupported"
  | "unsupported_compression";

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;

  constructor(
    code: MetadataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
  }
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export async function extractBookMetadata(
  filename: string,
  format: BookFormat,
  limitOverrides: Partial<MetadataLimits> = {},
): Promise<ExtractedBookMetadata> {
  const limits = { ...DEFAULT_METADATA_LIMITS, ...limitOverrides };
  const details = await stat(filename);
  if (!details.isFile()) {
    throw new MetadataError(format === "epub" ? "invalid_epub" : "invalid_azw3", "Book source is not a file.");
  }
  if (details.size > limits.maxBookBytes) {
    throw new MetadataError("book_too_large", "Book exceeds the configured metadata extraction limit.");
  }
  const data = await readFile(filename);
  const fallbackTitle = path.basename(filename, path.extname(filename));
  return format === "epub"
    ? extractEpubMetadata(data, fallbackTitle, limits)
    : extractAzw3Metadata(data, fallbackTitle, limits);
}

export function extractEpubMetadata(
  data: Buffer,
  fallbackTitle: string,
  limitOverrides: Partial<MetadataLimits> = {},
): ExtractedBookMetadata {
  const limits = { ...DEFAULT_METADATA_LIMITS, ...limitOverrides };
  if (data.length > limits.maxBookBytes) {
    throw new MetadataError("book_too_large", "Book exceeds the configured metadata extraction limit.");
  }
  const archive = new BoundedZipArchive(data, limits);
  const containerXml = archive.readText("META-INF/container.xml", limits.maxXmlBytes);
  assertSafeXml(containerXml, "invalid_epub");
  const rootfileTag = firstStartTag(containerXml, "rootfile");
  const packagePath = rootfileTag ? attribute(rootfileTag, "full-path") : null;
  if (!packagePath) {
    throw new MetadataError("invalid_epub", "EPUB container has no package document.");
  }
  const normalizedPackagePath = normalizeArchivePath(packagePath);
  const packageXml = archive.readText(normalizedPackagePath, limits.maxXmlBytes);
  assertSafeXml(packageXml, "invalid_epub");
  assertSupportedEpubEncryption(archive, normalizedPackagePath, packageXml, limits);

  const rawTitle = firstTagText(packageXml, "title");
  const title = cleanText(rawTitle) || cleanText(fallbackTitle) || "Untitled";
  const creatorTags = pairedTags(packageXml, "creator");
  const authors = uniqueStrings(creatorTags.map((tag) => cleanText(tag.body)).filter(Boolean));
  const authorSort =
    creatorTags.map((tag) => attribute(tag.attributes, "file-as")).find((value) => cleanText(value)) ??
    authors[0] ??
    null;
  const language = cleanText(firstTagText(packageXml, "language")) || null;
  const publisher = cleanText(firstTagText(packageXml, "publisher")) || null;
  const publishedAt = cleanText(firstTagText(packageXml, "date")) || null;
  const subjects = uniqueStrings(pairedTags(packageXml, "subject").map((tag) => cleanText(tag.body)).filter(Boolean));
  const identifiers = uniqueStrings(
    pairedTags(packageXml, "identifier").map((tag) => cleanText(tag.body)).filter(Boolean),
  );
  const series = extractEpubSeries(packageXml);
  const cover = extractEpubCover(archive, normalizedPackagePath, packageXml, limits);

  return {
    title,
    authors,
    authorSort: cleanText(authorSort) || null,
    language,
    publisher,
    publishedAt,
    series,
    subjects,
    identifiers,
    metadataComplete: Boolean(rawTitle && authors.length > 0),
    cover: cover?.data ?? null,
    coverMediaType: cover?.mediaType ?? null,
  };
}

export function extractAzw3Metadata(
  data: Buffer,
  fallbackTitle: string,
  limitOverrides: Partial<MetadataLimits> = {},
): ExtractedBookMetadata {
  const limits = { ...DEFAULT_METADATA_LIMITS, ...limitOverrides };
  if (data.length > limits.maxBookBytes) {
    throw new MetadataError("book_too_large", "Book exceeds the configured metadata extraction limit.");
  }
  if (data.length < 86 || data.subarray(60, 68).toString("ascii") !== "BOOKMOBI") {
    throw new MetadataError("invalid_azw3", "AZW3 has an invalid Palm database header.");
  }
  const recordCount = data.readUInt16BE(76);
  if (recordCount < 1 || recordCount > 65_535 || 78 + recordCount * 8 > data.length) {
    throw new MetadataError("invalid_azw3", "AZW3 record table is invalid.");
  }
  const offsets: number[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = data.readUInt32BE(78 + index * 8);
    if (offset < 78 + recordCount * 8 || offset >= data.length || (index > 0 && offset <= offsets[index - 1])) {
      throw new MetadataError("invalid_azw3", "AZW3 record offsets are invalid.");
    }
    offsets.push(offset);
  }
  const record = (index: number): Buffer | null => {
    if (index < 0 || index >= offsets.length) {
      return null;
    }
    return data.subarray(offsets[index], index + 1 < offsets.length ? offsets[index + 1] : data.length);
  };
  const recordZero = record(0) as Buffer;
  const mobiStart = 16;
  if (recordZero.length < mobiStart + 132 || recordZero.subarray(mobiStart, mobiStart + 4).toString("ascii") !== "MOBI") {
    throw new MetadataError("invalid_azw3", "AZW3 has no valid MOBI header.");
  }
  // PalmDOC bytes 12..13 are the encryption word. Values 1 and 2 are
  // Mobipocket DRM variants; unknown non-zero values are equally unsafe to
  // index as transferable sources because this application has no DRM path.
  if (recordZero.readUInt16BE(12) !== 0) {
    throw new MetadataError("drm_unsupported", "Encrypted AZW3 sources are not supported.");
  }
  const mobiLength = readU32(recordZero, mobiStart + 4, "invalid_azw3");
  if (mobiLength < 116 || mobiStart + mobiLength > recordZero.length) {
    throw new MetadataError("invalid_azw3", "AZW3 MOBI header length is invalid.");
  }
  validateAzw3BookContent(recordZero, record, offsets.length, mobiStart);
  const textEncoding = readU32(recordZero, mobiStart + 12, "invalid_azw3");
  const decode = (value: Buffer): string =>
    cleanText(value.toString(textEncoding === 65001 ? "utf8" : "latin1").replace(/\0+$/u, ""));
  const exth = parseExth(recordZero, mobiStart, mobiLength);
  const exthStrings = (type: number): string[] =>
    (exth.get(type) ?? []).map((item) => decode(item)).filter(Boolean);

  const fullNameOffset = readU32(recordZero, mobiStart + 84, "invalid_azw3");
  const fullNameLength = readU32(recordZero, mobiStart + 88, "invalid_azw3");
  const headerTitle =
    fullNameLength > 0 && fullNameLength <= limits.maxXmlBytes && fullNameOffset + fullNameLength <= recordZero.length
      ? decode(recordZero.subarray(fullNameOffset, fullNameOffset + fullNameLength))
      : "";
  const title = exthStrings(503)[0] || headerTitle || cleanText(fallbackTitle) || "Untitled";
  const authors = uniqueStrings(exthStrings(100));
  const publisher = exthStrings(101)[0] || null;
  const subjects = uniqueStrings(exthStrings(105));
  const publishedAt = exthStrings(106)[0] || null;
  const language = exthStrings(524)[0] || null;
  const identifiers = uniqueStrings([
    ...exthStrings(104).map((value) => `isbn:${value}`),
    ...exthStrings(112).map((value) => `source:${value}`),
    ...exthStrings(113).map((value) => `asin:${value}`),
    ...exthStrings(504).map((value) => `asin:${value}`),
  ]);
  const series = exthStrings(508)[0] || null;
  const coverOffsetBytes = exth.get(201)?.[0] ?? exth.get(202)?.[0];
  let cover: { data: Buffer; mediaType: string } | null = null;
  if (coverOffsetBytes && coverOffsetBytes.length >= 4 && recordZero.length >= 112) {
    // The first-image index is at PalmDOC record-0 offset 0x6c. `mobiStart`
    // points 16 bytes later, so reading mobiStart + 0x6c would select the wrong
    // MOBI field and silently lose otherwise valid covers.
    const firstImageRecord = readU32(recordZero, 0x6c, "invalid_azw3");
    const coverRecord = firstImageRecord + coverOffsetBytes.readUInt32BE(0);
    const candidate = record(coverRecord);
    if (candidate && candidate.length <= limits.maxCoverBytes) {
      const image = inspectRasterImage(candidate);
      if (image && rasterWithinLimits(image, limits)) {
        cover = { data: Buffer.from(candidate), mediaType: image.mediaType };
      }
    }
  }

  return {
    title,
    authors,
    authorSort: authors[0] ?? null,
    language,
    publisher,
    publishedAt,
    series,
    subjects,
    identifiers,
    metadataComplete: Boolean((exthStrings(503)[0] || headerTitle) && authors.length > 0),
    cover: cover?.data ?? null,
    coverMediaType: cover?.mediaType ?? null,
  };
}

function decodePalmDocRecord(input: Buffer, maximumOutput: number): Buffer {
  const output = Buffer.alloc(maximumOutput);
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset < input.length && outputOffset < maximumOutput) {
    const byte = input[inputOffset++] as number;
    if (byte === 0 || (byte >= 9 && byte <= 0x7f)) {
      output[outputOffset++] = byte;
      continue;
    }
    if (byte >= 1 && byte <= 8) {
      if (inputOffset + byte > input.length) {
        throw new MetadataError("invalid_azw3", "AZW3 PalmDOC literal run is truncated.");
      }
      const copied = Math.min(byte, maximumOutput - outputOffset);
      input.copy(output, outputOffset, inputOffset, inputOffset + copied);
      outputOffset += copied;
      inputOffset += byte;
      continue;
    }
    if (byte >= 0x80 && byte <= 0xbf) {
      if (inputOffset >= input.length) {
        throw new MetadataError("invalid_azw3", "AZW3 PalmDOC back-reference is truncated.");
      }
      const pair = ((byte & 0x3f) << 8) | (input[inputOffset++] as number);
      const distance = pair >>> 3;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > outputOffset) {
        throw new MetadataError("invalid_azw3", "AZW3 PalmDOC back-reference is invalid.");
      }
      for (let index = 0; index < length && outputOffset < maximumOutput; index += 1) {
        output[outputOffset] = output[outputOffset - distance] as number;
        outputOffset += 1;
      }
      continue;
    }
    output[outputOffset++] = 0x20;
    if (outputOffset < maximumOutput) output[outputOffset++] = byte ^ 0x80;
  }
  return output.subarray(0, outputOffset);
}

function validateAzw3BookContent(
  recordZero: Buffer,
  record: (index: number) => Buffer | null,
  recordCount: number,
  mobiStart: number,
): void {
  const compression = recordZero.readUInt16BE(0);
  const textLength = recordZero.readUInt32BE(4);
  const textRecordCount = recordZero.readUInt16BE(8);
  const textRecordSize = recordZero.readUInt16BE(10);
  if (textLength === 0) {
    throw new MetadataError("invalid_azw3", "AZW3 PalmDOC text length is zero.");
  }
  if (textLength > MAX_AZW3_DECODED_TEXT_BYTES) {
    throw new MetadataError("metadata_limit", "AZW3 decoded text exceeds the 128 MiB limit.");
  }
  if (textRecordCount === 0 || textRecordCount >= recordCount) {
    throw new MetadataError("invalid_azw3", "AZW3 PalmDOC text record count is invalid.");
  }
  if (textRecordSize === 0 || textLength > textRecordCount * textRecordSize) {
    throw new MetadataError("invalid_azw3", "AZW3 PalmDOC record size is invalid.");
  }
  if (readU32(recordZero, mobiStart + 8, "invalid_azw3") !== 2) {
    throw new MetadataError("invalid_azw3", "AZW3 MOBI book type is invalid.");
  }
  if (readU32(recordZero, mobiStart + 20, "invalid_azw3") !== 8) {
    throw new MetadataError("invalid_azw3", "AZW3 MOBI header is not KF8 version 8.");
  }

  let remaining = textLength;
  let readable = false;
  for (let index = 1; index <= textRecordCount; index += 1) {
    const source = record(index);
    if (!source || source.length === 0) {
      throw new MetadataError("invalid_azw3", "AZW3 text record is missing or empty.");
    }
    const expected = Math.min(textRecordSize, remaining);
    if (compression === 1) {
      if (source.length < expected) {
        throw new MetadataError("invalid_azw3", "AZW3 uncompressed text record is truncated.");
      }
      readable ||= source.subarray(0, expected).includes(0x3c);
    } else if (compression === 2) {
      const decoded = decodePalmDocRecord(source, expected);
      if (decoded.length !== expected) {
        throw new MetadataError("invalid_azw3", "AZW3 PalmDOC text record is truncated.");
      }
      readable ||= decoded.includes(0x3c);
    } else {
      throw new MetadataError("unsupported_compression", `Unsupported AZW3 PalmDOC compression: ${compression}.`);
    }
    remaining -= expected;
  }
  if (remaining !== 0 || !readable) {
    throw new MetadataError("invalid_azw3", "AZW3 contains no readable book content.");
  }

}

class BoundedZipArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly data: Buffer;
  private readonly limits: MetadataLimits;

  constructor(
    data: Buffer,
    limits: MetadataLimits,
  ) {
    this.data = data;
    this.limits = limits;
    if (data.length < 22 || data.length > limits.maxBookBytes) {
      throw new MetadataError("invalid_epub", "EPUB archive size is invalid.");
    }
    const searchStart = Math.max(0, data.length - 65_557);
    let eocd = -1;
    for (let offset = data.length - 22; offset >= searchStart; offset -= 1) {
      if (data.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0 || eocd + 22 > data.length) {
      throw new MetadataError("invalid_epub", "EPUB archive has no central directory.");
    }
    const disk = data.readUInt16LE(eocd + 4);
    const centralDisk = data.readUInt16LE(eocd + 6);
    const entriesOnDisk = data.readUInt16LE(eocd + 8);
    const entryCount = data.readUInt16LE(eocd + 10);
    const centralSize = data.readUInt32LE(eocd + 12);
    const centralOffset = data.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0) {
      throw new MetadataError("invalid_epub", "Multi-disk and empty EPUB archives are not supported.");
    }
    if (
      entryCount > limits.maxArchiveEntries ||
      centralSize > limits.maxCentralDirectoryBytes ||
      centralOffset + centralSize > eocd
    ) {
      throw new MetadataError("archive_limit", "EPUB central directory exceeds configured limits.");
    }
    let cursor = centralOffset;
    let totalUncompressed = 0;
    let totalNameBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) {
        throw new MetadataError("invalid_epub", "EPUB central directory entry is invalid.");
      }
      const flags = data.readUInt16LE(cursor + 8);
      const method = data.readUInt16LE(cursor + 10);
      const compressedSize = data.readUInt32LE(cursor + 20);
      const uncompressedSize = data.readUInt32LE(cursor + 24);
      const nameLength = data.readUInt16LE(cursor + 28);
      const extraLength = data.readUInt16LE(cursor + 30);
      const commentLength = data.readUInt16LE(cursor + 32);
      const localHeaderOffset = data.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (nameLength === 0 || next > data.length) {
        throw new MetadataError("invalid_epub", "EPUB entry name is invalid.");
      }
      if (nameLength > limits.maxArchiveEntryNameBytes) {
        throw new MetadataError("archive_limit", "EPUB entry name exceeds conversion limits.");
      }
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new MetadataError("archive_limit", "ZIP64 EPUB archives are not supported.");
      }
      totalNameBytes += nameLength;
      totalUncompressed += uncompressedSize;
      if (
        totalNameBytes > limits.maxArchiveNameBytes ||
        totalUncompressed > limits.maxArchiveUncompressedBytes ||
        uncompressedSize > limits.maxArchiveEntryBytes ||
        (compressedSize === 0 && uncompressedSize > 0) ||
        (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio)
      ) {
        throw new MetadataError("archive_limit", "EPUB expansion exceeds configured limits.");
      }
      const name = normalizeArchivePath(data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
      if (this.entries.has(name)) {
        throw new MetadataError("invalid_epub", "EPUB contains duplicate entry names.");
      }
      this.entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = next;
    }
    if (cursor > centralOffset + centralSize) {
      throw new MetadataError("invalid_epub", "EPUB central directory length is invalid.");
    }
  }

  entry(name: string): ZipEntry | null {
    return this.entries.get(normalizeArchivePath(name)) ?? null;
  }

  readText(name: string, maximumBytes: number): string {
    return this.read(name, maximumBytes).toString("utf8");
  }

  read(name: string, maximumBytes: number): Buffer {
    const entry = this.entry(name);
    if (!entry) {
      throw new MetadataError("invalid_epub", "EPUB references a missing archive entry.");
    }
    if (entry.flags & 0x1 || entry.uncompressedSize > maximumBytes) {
      throw new MetadataError("metadata_limit", "EPUB entry exceeds extraction limits.");
    }
    const offset = entry.localHeaderOffset;
    if (offset + 30 > this.data.length || this.data.readUInt32LE(offset) !== 0x04034b50) {
      throw new MetadataError("invalid_epub", "EPUB local entry header is invalid.");
    }
    const nameLength = this.data.readUInt16LE(offset + 26);
    const extraLength = this.data.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < offset || dataEnd > this.data.length) {
      throw new MetadataError("invalid_epub", "EPUB entry data is truncated.");
    }
    const compressed = this.data.subarray(dataStart, dataEnd);
    let output: Buffer;
    if (entry.method === 0) {
      output = Buffer.from(compressed);
    } else if (entry.method === 8) {
      try {
        output = inflateRawSync(compressed, { maxOutputLength: maximumBytes });
      } catch {
        throw new MetadataError("invalid_epub", "EPUB entry cannot be decompressed safely.");
      }
    } else {
      throw new MetadataError("unsupported_compression", "EPUB uses an unsupported compression method.");
    }
    if (output.length !== entry.uncompressedSize || output.length > maximumBytes) {
      throw new MetadataError("metadata_limit", "EPUB entry size does not match its bounded declaration.");
    }
    return output;
  }
}

function normalizeArchivePath(input: string): string {
  if (input.includes("\0") || input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/u.test(input)) {
    throw new MetadataError("invalid_epub", "EPUB contains an unsafe archive path.");
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new MetadataError("invalid_epub", "EPUB contains an unsafe archive path.");
  }
  return normalized;
}

function resolveArchiveHref(packagePath: string, href: string): string {
  const withoutFragment = href.split("#", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new MetadataError("invalid_epub", "EPUB contains an invalid encoded resource path.");
  }
  const combined = path.posix.join(path.posix.dirname(packagePath), decoded);
  return normalizeArchivePath(combined);
}

const FONT_OBFUSCATION_ALGORITHMS = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

const FONT_MEDIA_TYPES = new Set([
  "application/font-sfnt",
  "application/font-woff",
  "application/vnd.ms-opentype",
  "application/x-font-opentype",
  "application/x-font-ttf",
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
]);

function assertSupportedEpubEncryption(
  archive: BoundedZipArchive,
  packagePath: string,
  packageXml: string,
  limits: MetadataLimits,
): void {
  if (!archive.entry("META-INF/encryption.xml")) return;
  const encryptionXml = archive.readText("META-INF/encryption.xml", limits.maxXmlBytes);
  assertSafeXml(encryptionXml, "invalid_epub");
  const encryptedResources = pairedTags(encryptionXml, "EncryptedData");
  if (encryptedResources.length === 0) {
    throw new MetadataError("drm_unsupported", "EPUB encryption metadata cannot be verified.");
  }
  const manifestFonts = new Set(
    startTags(packageXml, "item")
      .filter((attributes) => isFontManifestItem(attributes))
      .map((attributes) => attribute(attributes, "href"))
      .filter((href): href is string => Boolean(href))
      .map((href) => resolveArchiveHref(packagePath, href)),
  );

  for (const encrypted of encryptedResources) {
    const method = firstStartTag(encrypted.body, "EncryptionMethod");
    const reference = firstStartTag(encrypted.body, "CipherReference");
    const algorithm = method ? attribute(method, "Algorithm") : null;
    const rawUri = reference ? attribute(reference, "URI") : null;
    let resourcePath: string | null = null;
    if (rawUri) {
      try {
        resourcePath = normalizeArchivePath(decodeURIComponent(rawUri.split("#", 1)[0] ?? ""));
      } catch {
        resourcePath = null;
      }
    }
    if (
      !algorithm ||
      !FONT_OBFUSCATION_ALGORITHMS.has(algorithm) ||
      !resourcePath ||
      !manifestFonts.has(resourcePath) ||
      !archive.entry(resourcePath)
    ) {
      throw new MetadataError("drm_unsupported", "EPUB contains unsupported encrypted content.");
    }
  }
}

function isFontManifestItem(attributes: string): boolean {
  const mediaType = attribute(attributes, "media-type")?.toLocaleLowerCase();
  if (mediaType && FONT_MEDIA_TYPES.has(mediaType)) return true;
  const href = attribute(attributes, "href")?.split(/[?#]/u, 1)[0]?.toLocaleLowerCase();
  return Boolean(href && /\.(?:otf|ttf|woff2?)$/u.test(href));
}

function assertSafeXml(xml: string, code: "invalid_epub"): void {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new MetadataError(code, "External XML declarations are not accepted.");
  }
}

function pairedTags(xml: string, localName: string): Array<{ attributes: string; body: string }> {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
    "giu",
  );
  return Array.from(xml.matchAll(expression), (match) => ({ attributes: match[1] ?? "", body: match[2] ?? "" }));
}

function firstTagText(xml: string, localName: string): string {
  return pairedTags(xml, localName)[0]?.body ?? "";
}

function startTags(xml: string, localName: string): string[] {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b([^>]*)\\/?\\s*>`, "giu");
  return Array.from(xml.matchAll(expression), (match) => match[1] ?? "");
}

function firstStartTag(xml: string, localName: string): string | null {
  return startTags(xml, localName)[0] ?? null;
}

function attribute(attributes: string, localName: string): string | null {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${escaped}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(attributes);
  return match ? decodeXmlEntities(match[2] ?? "") : null;
}

function cleanText(input: string | null | undefined): string {
  if (!input) {
    return "";
  }
  return decodeXmlEntities(input.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const value = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = cleanText(value);
    const key = normalized.toLocaleLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result.slice(0, 100);
}

function extractEpubSeries(packageXml: string): string | null {
  for (const attributes of startTags(packageXml, "meta")) {
    const name = attribute(attributes, "name")?.toLocaleLowerCase();
    const property = attribute(attributes, "property")?.toLocaleLowerCase();
    if (name === "calibre:series") {
      return cleanText(attribute(attributes, "content")) || null;
    }
    if (property === "belongs-to-collection") {
      const paired = pairedTags(packageXml, "meta").find(
        (tag) => attribute(tag.attributes, "property")?.toLocaleLowerCase() === "belongs-to-collection",
      );
      return cleanText(paired?.body) || null;
    }
  }
  return null;
}

function extractEpubCover(
  archive: BoundedZipArchive,
  packagePath: string,
  packageXml: string,
  limits: MetadataLimits,
): { data: Buffer; mediaType: string } | null {
  const manifest = startTags(packageXml, "item").map((attributes) => ({
    id: attribute(attributes, "id"),
    href: attribute(attributes, "href"),
    properties: attribute(attributes, "properties") ?? "",
    mediaType: attribute(attributes, "media-type"),
  }));
  let coverId: string | null = null;
  for (const attributes of startTags(packageXml, "meta")) {
    if (attribute(attributes, "name")?.toLocaleLowerCase() === "cover") {
      coverId = attribute(attributes, "content");
      break;
    }
  }
  let item = manifest.find((candidate) => candidate.properties.split(/\s+/u).includes("cover-image"));
  item ??= coverId ? manifest.find((candidate) => candidate.id === coverId) : undefined;
  if (!item) {
    const guide = startTags(packageXml, "reference").find(
      (attributes) => attribute(attributes, "type")?.toLocaleLowerCase() === "cover",
    );
    const href = guide ? attribute(guide, "href") : null;
    if (href) {
      item = { id: null, href, properties: "", mediaType: null };
    }
  }
  if (!item?.href) {
    return null;
  }
  const archivePath = resolveArchiveHref(packagePath, item.href);
  const direct = readBoundedRasterCover(archive, archivePath, limits);
  if (direct) return direct;

  // EPUB2 commonly points its guide `type="cover"` at an XHTML wrapper
  // rather than at the raster itself. Follow one bounded local img/SVG-image
  // reference; never execute markup or fetch an external resource.
  const wrapper = archive.entry(archivePath);
  if (!wrapper || wrapper.uncompressedSize > limits.maxXmlBytes) return null;
  let coverMarkup: string;
  try {
    coverMarkup = archive.readText(archivePath, limits.maxXmlBytes);
    assertSafeXml(coverMarkup, "invalid_epub");
  } catch {
    return null;
  }
  const imageAttributes = firstStartTag(coverMarkup, "img") ?? firstStartTag(coverMarkup, "image");
  const imageHref = imageAttributes
    ? attribute(imageAttributes, "src") ?? attribute(imageAttributes, "href")
    : null;
  if (!imageHref || /^(?:data|https?):/iu.test(imageHref.trim())) return null;
  let imagePath: string;
  try {
    imagePath = resolveArchiveHref(archivePath, imageHref);
  } catch {
    return null;
  }
  return readBoundedRasterCover(archive, imagePath, limits);
}

function readBoundedRasterCover(
  archive: BoundedZipArchive,
  archivePath: string,
  limits: MetadataLimits,
): { data: Buffer; mediaType: string } | null {
  const entry = archive.entry(archivePath);
  if (!entry || entry.uncompressedSize > limits.maxCoverBytes) return null;
  const data = archive.read(archivePath, limits.maxCoverBytes);
  const image = inspectRasterImage(data);
  return image && rasterWithinLimits(image, limits) ? { data, mediaType: image.mediaType } : null;
}

function parseExth(recordZero: Buffer, mobiStart: number, mobiLength: number): Map<number, Buffer[]> {
  const result = new Map<number, Buffer[]>();
  if (mobiStart + 132 > recordZero.length || !(recordZero.readUInt32BE(mobiStart + 128) & 0x40)) {
    return result;
  }
  const start = mobiStart + mobiLength;
  if (start + 12 > recordZero.length || recordZero.subarray(start, start + 4).toString("ascii") !== "EXTH") {
    return result;
  }
  const length = readU32(recordZero, start + 4, "invalid_azw3");
  const count = readU32(recordZero, start + 8, "invalid_azw3");
  if (length < 12 || start + length > recordZero.length || count > 10_000) {
    throw new MetadataError("invalid_azw3", "AZW3 EXTH header is invalid.");
  }
  let cursor = start + 12;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 8 > start + length) {
      throw new MetadataError("invalid_azw3", "AZW3 EXTH record is truncated.");
    }
    const type = recordZero.readUInt32BE(cursor);
    const recordLength = recordZero.readUInt32BE(cursor + 4);
    if (recordLength < 8 || cursor + recordLength > start + length) {
      throw new MetadataError("invalid_azw3", "AZW3 EXTH record length is invalid.");
    }
    const values = result.get(type) ?? [];
    if (values.length < 100) {
      values.push(Buffer.from(recordZero.subarray(cursor + 8, cursor + recordLength)));
      result.set(type, values);
    }
    cursor += recordLength;
  }
  return result;
}

function readU32(data: Buffer, offset: number, code: "invalid_azw3"): number {
  if (offset < 0 || offset + 4 > data.length) {
    throw new MetadataError(code, "AZW3 header is truncated.");
  }
  return data.readUInt32BE(offset);
}

export interface RasterImageInfo {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

/**
 * Reads only container headers; it never decodes pixels. A recognized raster
 * without trustworthy positive dimensions is rejected, because passing a tiny
 * compressed image with attacker-controlled dimensions to a later decoder can
 * still cause excessive memory use.
 */
export function inspectRasterImage(data: Buffer): RasterImageInfo | null {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(pngSignature) &&
    data.readUInt32BE(8) === 13 &&
    data.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return positiveRaster("image/png", data.readUInt32BE(16), data.readUInt32BE(20));
  }

  if (data.length >= 10 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) {
    return positiveRaster("image/gif", data.readUInt16LE(6), data.readUInt16LE(8));
  }

  const jpeg = inspectJpeg(data);
  if (jpeg) return jpeg;

  return inspectWebp(data);
}

function positiveRaster(
  mediaType: RasterImageInfo["mediaType"],
  width: number,
  height: number,
): RasterImageInfo | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { mediaType, width, height }
    : null;
}

function rasterWithinLimits(image: RasterImageInfo, limits: MetadataLimits): boolean {
  return (
    image.width <= limits.maxCoverWidth &&
    image.height <= limits.maxCoverHeight &&
    image.height <= Math.floor(limits.maxCoverPixels / image.width)
  );
}

function inspectJpeg(data: Buffer): RasterImageInfo | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let cursor = 2;
  while (cursor < data.length) {
    while (cursor < data.length && data[cursor] === 0xff) cursor += 1;
    if (cursor >= data.length) return null;
    const marker = data[cursor] as number;
    cursor += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > data.length) return null;
    const segmentLength = data.readUInt16BE(cursor);
    if (segmentLength < 2 || cursor + segmentLength > data.length) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return positiveRaster("image/jpeg", data.readUInt16BE(cursor + 5), data.readUInt16BE(cursor + 3));
    }
    cursor += segmentLength;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

function inspectWebp(data: Buffer): RasterImageInfo | null {
  if (
    data.length < 20 ||
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const riffEnd = Math.min(data.length, data.readUInt32LE(4) + 8);
  if (riffEnd < 20) return null;
  let cursor = 12;
  while (cursor + 8 <= riffEnd) {
    const kind = data.subarray(cursor, cursor + 4).toString("ascii");
    const chunkLength = data.readUInt32LE(cursor + 4);
    const payload = cursor + 8;
    const chunkEnd = payload + chunkLength;
    if (chunkEnd < payload || chunkEnd > riffEnd) return null;
    if (kind === "VP8X" && chunkLength >= 10) {
      return positiveRaster(
        "image/webp",
        1 + readUInt24LE(data, payload + 4),
        1 + readUInt24LE(data, payload + 7),
      );
    }
    if (
      kind === "VP8 " &&
      chunkLength >= 10 &&
      data[payload + 3] === 0x9d &&
      data[payload + 4] === 0x01 &&
      data[payload + 5] === 0x2a
    ) {
      return positiveRaster(
        "image/webp",
        data.readUInt16LE(payload + 6) & 0x3fff,
        data.readUInt16LE(payload + 8) & 0x3fff,
      );
    }
    if (kind === "VP8L" && chunkLength >= 5 && data[payload] === 0x2f) {
      const dimensions = data.readUInt32LE(payload + 1);
      return positiveRaster(
        "image/webp",
        1 + (dimensions & 0x3fff),
        1 + ((dimensions >>> 14) & 0x3fff),
      );
    }
    cursor = chunkEnd + (chunkLength & 1);
  }
  return null;
}

function readUInt24LE(data: Buffer, offset: number): number {
  return (data[offset] as number) | ((data[offset + 1] as number) << 8) | ((data[offset + 2] as number) << 16);
}
