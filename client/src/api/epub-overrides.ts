import { AppError } from "../app-error";
import { MAX_BOOK_SOURCE_BYTES } from "../book-limits";
import type { ResolvedConversionOverrides } from "./conversion-overrides";
import type { ConversionCoverMediaType } from "./conversion-overrides";

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const OPF_NAMESPACE = "http://www.idpf.org/2007/opf";

interface ZipEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly centralBytes: Uint8Array;
  readonly localOffset: number;
  readonly compression: number;
  readonly flags: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly modifiedTime: number;
  readonly modifiedDate: number;
  readonly externalAttributes: number;
  localEnd: number;
}

interface ZipArchive {
  readonly bytes: Uint8Array;
  readonly entries: readonly ZipEntry[];
  readonly byName: ReadonlyMap<string, ZipEntry>;
}

interface ReplacementEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly flags: number;
  readonly modifiedTime: number;
  readonly modifiedDate: number;
  readonly externalAttributes: number;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function malformed(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AppError("CONVERSION_INVALID_INPUT", `Cannot apply EPUB metadata overrides: ${message}`, {
    ...(details === undefined ? {} : { details }),
  });
}

function requireRange(bytes: Uint8Array, offset: number, length: number, context: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    malformed(`invalid ${context} bounds`);
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > bytes.byteLength) malformed(`truncated ${context}`);
}

function uint16(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2, "ZIP integer");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4, "ZIP integer");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function write16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, true);
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, true);
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  try {
    if (utf8) return utf8Decoder.decode(bytes);
  } catch {
    malformed("an entry name is not valid UTF-8");
  }
  // EPUB control files and generated cover paths are ASCII. Latin-1 keeps
  // legacy byte names stable enough to preserve all unrelated entries.
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (uint32(bytes, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = uint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  return malformed("the archive has no valid end-of-central-directory record");
}

function parseZip(bytes: Uint8Array): ZipArchive {
  const eocd = findEndOfCentralDirectory(bytes);
  if (uint16(bytes, eocd + 4) !== 0 || uint16(bytes, eocd + 6) !== 0) {
    malformed("multi-disk ZIP archives are unsupported");
  }
  const diskEntries = uint16(bytes, eocd + 8);
  const entryCount = uint16(bytes, eocd + 10);
  const centralSize = uint32(bytes, eocd + 12);
  const centralOffset = uint32(bytes, eocd + 16);
  if (diskEntries !== entryCount || entryCount === 0 || entryCount === 0xffff) {
    malformed("the ZIP entry count is invalid or requires ZIP64");
  }
  if (entryCount > MAX_ZIP_ENTRIES) malformed(`the archive exceeds ${MAX_ZIP_ENTRIES} entries`);
  requireRange(bytes, centralOffset, centralSize, "ZIP central directory");
  if (centralOffset + centralSize !== eocd) malformed("the ZIP central directory is inconsistent");

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(bytes, cursor) !== CENTRAL_SIGNATURE) malformed("a central-directory entry is invalid");
    requireRange(bytes, cursor, 46, "ZIP central-directory header");
    const flags = uint16(bytes, cursor + 8);
    const compression = uint16(bytes, cursor + 10);
    const checksum = uint32(bytes, cursor + 16);
    const compressedSize = uint32(bytes, cursor + 20);
    const uncompressedSize = uint32(bytes, cursor + 24);
    const nameLength = uint16(bytes, cursor + 28);
    const extraLength = uint16(bytes, cursor + 30);
    const commentLength = uint16(bytes, cursor + 32);
    const localOffset = uint32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, cursor, recordLength, "ZIP central-directory entry");
    if (compressedSize === 0xffff_ffff || uncompressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
      malformed("ZIP64 entries are unsupported");
    }
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(nameBytes, (flags & UTF8_FLAG) !== 0);
    if (!name || name.includes("\u0000") || name.startsWith("/") || name.includes("\\")) {
      malformed("an archive entry has an unsafe name");
    }
    if (byName.has(name)) malformed("the archive contains duplicate entry names", { name });
    const entry: ZipEntry = {
      name,
      nameBytes,
      centralBytes: bytes.slice(cursor, cursor + recordLength),
      localOffset,
      compression,
      flags,
      checksum,
      compressedSize,
      uncompressedSize,
      modifiedTime: uint16(bytes, cursor + 12),
      modifiedDate: uint16(bytes, cursor + 14),
      externalAttributes: uint32(bytes, cursor + 38),
      localEnd: 0,
    };
    entries.push(entry);
    byName.set(name, entry);
    cursor += recordLength;
  }
  if (cursor !== eocd) malformed("the ZIP central-directory length is inconsistent");

  const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  if (localOrder[0]?.localOffset !== 0) malformed("the EPUB contains an unsupported archive preamble");
  for (let index = 0; index < localOrder.length; index += 1) {
    const entry = localOrder[index] as ZipEntry;
    if (uint32(bytes, entry.localOffset) !== LOCAL_SIGNATURE) malformed("a local ZIP entry is invalid");
    requireRange(bytes, entry.localOffset, 30, "ZIP local header");
    const localNameLength = uint16(bytes, entry.localOffset + 26);
    const localExtraLength = uint16(bytes, entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
    requireRange(bytes, dataOffset, entry.compressedSize, "ZIP entry data");
    const localName = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
    if (localName.byteLength !== entry.nameBytes.byteLength
      || localName.some((byte, byteIndex) => byte !== entry.nameBytes[byteIndex])) {
      malformed("a local ZIP name disagrees with the central directory");
    }
    entry.localEnd = localOrder[index + 1]?.localOffset ?? centralOffset;
    if (dataOffset + entry.compressedSize > entry.localEnd) malformed("ZIP entry data overlaps another record");
  }
  return { bytes, entries, byName };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function inflateRaw(compressed: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    malformed("this browser cannot inflate the EPUB metadata entries");
  }
  let stream: ReadableStream<Uint8Array>;
  try {
    const compressedStream = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(Uint8Array.from(compressed));
        controller.close();
      },
    });
    stream = compressedStream.pipeThrough(new DecompressionStream("deflate-raw"));
  } catch (error) {
    throw new AppError("CONVERSION_INVALID_INPUT", "Cannot inflate EPUB metadata", { cause: error });
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("EPUB metadata entry limit exceeded");
        malformed(`an EPUB metadata entry exceeds ${maximumBytes} bytes`);
      }
      chunks.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CONVERSION_INVALID_INPUT", "Cannot inflate EPUB metadata", { cause: error });
  }
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

async function readEntry(archive: ZipArchive, entry: ZipEntry, maximumBytes: number): Promise<Uint8Array> {
  if ((entry.flags & ENCRYPTED_FLAG) !== 0) malformed("encrypted EPUB entries are unsupported");
  if (entry.uncompressedSize > maximumBytes) malformed(`an EPUB metadata entry exceeds ${maximumBytes} bytes`);
  const localNameLength = uint16(archive.bytes, entry.localOffset + 26);
  const localExtraLength = uint16(archive.bytes, entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = archive.bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  let output: Uint8Array;
  if (entry.compression === 0) output = Uint8Array.from(compressed);
  else if (entry.compression === 8) output = await inflateRaw(compressed, maximumBytes);
  else malformed(`unsupported compression method ${entry.compression} in EPUB metadata`);
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.checksum) {
    malformed("an EPUB metadata entry failed size or checksum validation");
  }
  return output;
}

function parseXml(bytes: Uint8Array, context: string): XMLDocument {
  let text: string;
  try {
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    } else if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    } else {
      text = utf8Decoder.decode(bytes);
    }
  } catch {
    malformed(`${context} is not valid UTF-8 or UTF-16 XML`);
  }
  if (/<!DOCTYPE\b/iu.test(text)) malformed(`${context} contains an unsupported document type`);
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) malformed(`${context} is malformed XML`);
  if (document.getElementsByTagName("*").length > 100_000) {
    malformed(`${context} exceeds the 100000-element editing limit`);
  }
  return document;
}

function elementsByLocalName(parent: ParentNode, name: string): Element[] {
  return Array.from(parent.querySelectorAll("*")).filter((element) => element.localName === name);
}

function firstByLocalName(parent: ParentNode, name: string): Element {
  return elementsByLocalName(parent, name)[0] ?? malformed(`the EPUB has no ${name} element`);
}

function safeArchivePath(value: string): string {
  const path = value.trim();
  if (
    path.length === 0
    || path.length > 2_048
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => part === ".." || part === "")
  ) {
    malformed("the EPUB package path is unsafe");
  }
  return path;
}

function packagePath(container: XMLDocument): string {
  const rootfile = elementsByLocalName(container, "rootfile")[0]
    ?? malformed("META-INF/container.xml has no rootfile");
  return safeArchivePath(rootfile.getAttribute("full-path") ?? "");
}

function removeDirectChildren(parent: Element, localName: string): void {
  Array.from(parent.children)
    .filter((element) => element.localName === localName)
    .forEach((element) => element.remove());
}

function createDc(document: XMLDocument, localName: string, value: string, id?: string): Element {
  const element = document.createElementNS(DC_NAMESPACE, `dc:${localName}`);
  if (id) element.setAttribute("id", id);
  element.textContent = value;
  return element;
}

function createMeta(document: XMLDocument, metadata: Element): Element {
  return document.createElementNS(metadata.namespaceURI || OPF_NAMESPACE, "meta");
}

function removeMetaByProperty(metadata: Element, properties: ReadonlySet<string>): void {
  Array.from(metadata.children)
    .filter((element) => element.localName === "meta" && properties.has(element.getAttribute("property") ?? ""))
    .forEach((element) => element.remove());
}

function ensureElementId(element: Element, preferred: string): string {
  const existing = element.getAttribute("id")?.trim();
  if (existing) return existing;
  element.setAttribute("id", preferred);
  return preferred;
}

function addFileAs(document: XMLDocument, metadata: Element, targetId: string, value: string | null): void {
  Array.from(metadata.children)
    .filter((element) => (
      element.localName === "meta"
      && element.getAttribute("property") === "file-as"
      && element.getAttribute("refines") === `#${targetId}`
    ))
    .forEach((element) => element.remove());
  if (value === null) return;
  const meta = createMeta(document, metadata);
  meta.setAttribute("refines", `#${targetId}`);
  meta.setAttribute("property", "file-as");
  meta.textContent = value;
  metadata.append(meta);
}

function setScalar(
  document: XMLDocument,
  metadata: Element,
  localName: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  removeDirectChildren(metadata, localName);
  if (value !== null) metadata.append(createDc(document, localName, value));
}

function applyMetadata(document: XMLDocument, overrides: ResolvedConversionOverrides): void {
  const metadata = firstByLocalName(document, "metadata");
  if (overrides.title !== undefined) {
    removeDirectChildren(metadata, "title");
    metadata.append(createDc(document, "title", overrides.title, "kindle-bridge-title"));
  }
  if (overrides.titleSort !== undefined) {
    const title = Array.from(metadata.children).find((element) => element.localName === "title")
      ?? malformed("the EPUB has no title to receive the title-sort override");
    addFileAs(document, metadata, ensureElementId(title, "kindle-bridge-title"), overrides.titleSort);
  }
  if (overrides.authors !== undefined) {
    removeDirectChildren(metadata, "creator");
    overrides.authors.forEach((author, index) => {
      metadata.append(createDc(document, "creator", author, `kindle-bridge-author-${index + 1}`));
    });
  }
  if (overrides.authorSort !== undefined) {
    const author = Array.from(metadata.children).find((element) => element.localName === "creator");
    if (!author) {
      if (overrides.authorSort !== null) malformed("the EPUB has no author to receive the author-sort override");
    } else {
      addFileAs(document, metadata, ensureElementId(author, "kindle-bridge-author-1"), overrides.authorSort);
    }
  }
  setScalar(document, metadata, "language", overrides.language);
  setScalar(document, metadata, "publisher", overrides.publisher);
  setScalar(document, metadata, "date", overrides.publishedAt);
  setScalar(document, metadata, "description", overrides.description);
  setScalar(document, metadata, "rights", overrides.rights);

  if (overrides.subjects !== undefined) {
    removeDirectChildren(metadata, "subject");
    overrides.subjects.forEach((subject) => metadata.append(createDc(document, "subject", subject)));
  }
  if (overrides.identifiers !== undefined) {
    removeDirectChildren(metadata, "identifier");
    overrides.identifiers.forEach((identifier, index) => {
      metadata.append(createDc(document, "identifier", identifier, `kindle-bridge-id-${index + 1}`));
    });
    if (overrides.identifiers.length > 0) {
      document.documentElement.setAttribute("unique-identifier", "kindle-bridge-id-1");
    } else {
      document.documentElement.removeAttribute("unique-identifier");
    }
  }
  if (overrides.series !== undefined) {
    removeMetaByProperty(metadata, new Set(["belongs-to-collection", "collection-type", "group-position"]));
    if (overrides.series !== null) {
      const series = createMeta(document, metadata);
      series.setAttribute("id", "kindle-bridge-series");
      series.setAttribute("property", "belongs-to-collection");
      series.textContent = overrides.series;
      metadata.append(series);
      const type = createMeta(document, metadata);
      type.setAttribute("refines", "#kindle-bridge-series");
      type.setAttribute("property", "collection-type");
      type.textContent = "series";
      metadata.append(type);
      if (overrides.seriesIndex !== null && overrides.seriesIndex !== undefined) {
        const position = createMeta(document, metadata);
        position.setAttribute("refines", "#kindle-bridge-series");
        position.setAttribute("property", "group-position");
        position.textContent = String(overrides.seriesIndex);
        metadata.append(position);
      }
    }
  } else if (overrides.seriesIndex !== undefined) {
    const collections = Array.from(metadata.children).filter((element) => (
      element.localName === "meta" && element.getAttribute("property") === "belongs-to-collection"
    ));
    const existingSeries = collections.find((collection) => {
      const id = collection.getAttribute("id")?.trim();
      return id && Array.from(metadata.children).some((element) => (
        element.localName === "meta"
        && element.getAttribute("property") === "collection-type"
        && element.getAttribute("refines") === `#${id}`
        && element.textContent?.trim() === "series"
      ));
    }) ?? collections[0];
    if (!existingSeries) {
      if (overrides.seriesIndex !== null) malformed("a series position override requires a series name");
      return;
    }
    const seriesId = ensureElementId(existingSeries, "kindle-bridge-series");
    Array.from(metadata.children)
      .filter((element) => (
        element.localName === "meta"
        && element.getAttribute("property") === "group-position"
        && element.getAttribute("refines") === `#${seriesId}`
      ))
      .forEach((element) => element.remove());
    if (overrides.seriesIndex !== null) {
      const position = createMeta(document, metadata);
      position.setAttribute("refines", `#${seriesId}`);
      position.setAttribute("property", "group-position");
      position.textContent = String(overrides.seriesIndex);
      metadata.append(position);
    }
  }
}

function applyCover(
  document: XMLDocument,
  mediaType: ConversionCoverMediaType,
  coverHref: string,
  existingItem?: Element,
): void {
  const metadata = firstByLocalName(document, "metadata");
  const manifest = firstByLocalName(document, "manifest");
  Array.from(metadata.children)
    .filter((element) => element.localName === "meta" && element.getAttribute("name") === "cover")
    .forEach((element) => element.remove());
  for (const item of Array.from(manifest.children).filter((element) => element.localName === "item")) {
    const properties = (item.getAttribute("properties") ?? "")
      .split(/\s+/u)
      .filter((property) => property && property !== "cover-image");
    if (properties.length > 0) item.setAttribute("properties", properties.join(" "));
    else item.removeAttribute("properties");
  }
  const item = existingItem ?? document.createElementNS(manifest.namespaceURI || OPF_NAMESPACE, "item");
  const itemId = item.getAttribute("id")?.trim() || "kindle-bridge-cover";
  item.setAttribute("id", itemId);
  item.setAttribute("href", coverHref);
  item.setAttribute("media-type", mediaType);
  item.setAttribute("properties", "cover-image");
  if (!existingItem) manifest.append(item);
  const epub2 = createMeta(document, metadata);
  epub2.setAttribute("name", "cover");
  epub2.setAttribute("content", itemId);
  metadata.append(epub2);
}

function resolvedManifestHref(opfPath: string, href: string): string | undefined {
  const withoutSuffix = href.split(/[?#]/u, 1)[0]?.trim();
  if (!withoutSuffix || withoutSuffix.startsWith("/") || withoutSuffix.includes("\\")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    return undefined;
  }
  const slash = opfPath.lastIndexOf("/");
  const parts = [...(slash < 0 ? [] : opfPath.slice(0, slash).split("/")), ...decoded.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.length > 0 ? normalized.join("/") : undefined;
}

function existingCover(
  document: XMLDocument,
  archive: ZipArchive,
  opfPath: string,
): { readonly item: Element; readonly entry: ZipEntry; readonly href: string } | undefined {
  const metadata = firstByLocalName(document, "metadata");
  const manifest = firstByLocalName(document, "manifest");
  const items = Array.from(manifest.children).filter((element) => element.localName === "item");
  const epub3 = items.find((item) => (
    (item.getAttribute("properties") ?? "").split(/\s+/u).includes("cover-image")
  ));
  const epub2Id = Array.from(metadata.children)
    .find((element) => element.localName === "meta" && element.getAttribute("name") === "cover")
    ?.getAttribute("content")
    ?.trim();
  const item = epub3 ?? (epub2Id ? items.find((candidate) => candidate.getAttribute("id") === epub2Id) : undefined);
  if (!item) return undefined;
  const href = item.getAttribute("href") ?? "";
  const path = resolvedManifestHref(opfPath, href);
  const entry = path ? archive.byName.get(path) : undefined;
  return entry ? { item, entry, href } : undefined;
}

function serializeXml(document: XMLDocument): Uint8Array {
  return utf8Encoder.encode(new XMLSerializer().serializeToString(document));
}

function freshName(
  archive: ZipArchive,
  opfPath: string,
  extension: "jpg" | "png" | "webp",
): { path: string; href: string } {
  const slash = opfPath.lastIndexOf("/");
  const directory = slash < 0 ? "" : opfPath.slice(0, slash + 1);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const basename = `kindle-bridge-cover${suffix === 0 ? "" : `-${suffix}`}.${extension}`;
    const path = `${directory}${basename}`;
    if (!archive.byName.has(path)) return { path, href: basename };
  }
  return malformed("the EPUB has no available replacement-cover path");
}

function replacementFromExisting(entry: ZipEntry, data: Uint8Array): ReplacementEntry {
  return {
    name: entry.name,
    nameBytes: entry.nameBytes,
    data,
    flags: entry.flags & UTF8_FLAG,
    modifiedTime: entry.modifiedTime,
    modifiedDate: entry.modifiedDate,
    externalAttributes: entry.externalAttributes,
  };
}

function replacementForNew(name: string, data: Uint8Array): ReplacementEntry {
  return {
    name,
    nameBytes: utf8Encoder.encode(name),
    data,
    flags: UTF8_FLAG,
    modifiedTime: 0,
    modifiedDate: 0,
    externalAttributes: 0,
  };
}

function localRecord(entry: ReplacementEntry): Uint8Array {
  const output = new Uint8Array(30 + entry.nameBytes.byteLength + entry.data.byteLength);
  write32(output, 0, LOCAL_SIGNATURE);
  write16(output, 4, 20);
  write16(output, 6, entry.flags & ~DATA_DESCRIPTOR_FLAG & ~ENCRYPTED_FLAG);
  write16(output, 8, 0);
  write16(output, 10, entry.modifiedTime);
  write16(output, 12, entry.modifiedDate);
  write32(output, 14, crc32(entry.data));
  write32(output, 18, entry.data.byteLength);
  write32(output, 22, entry.data.byteLength);
  write16(output, 26, entry.nameBytes.byteLength);
  write16(output, 28, 0);
  output.set(entry.nameBytes, 30);
  output.set(entry.data, 30 + entry.nameBytes.byteLength);
  return output;
}

function centralRecord(entry: ReplacementEntry, localOffset: number): Uint8Array {
  const output = new Uint8Array(46 + entry.nameBytes.byteLength);
  write32(output, 0, CENTRAL_SIGNATURE);
  write16(output, 4, 20);
  write16(output, 6, 20);
  write16(output, 8, entry.flags & ~DATA_DESCRIPTOR_FLAG & ~ENCRYPTED_FLAG);
  write16(output, 10, 0);
  write16(output, 12, entry.modifiedTime);
  write16(output, 14, entry.modifiedDate);
  write32(output, 16, crc32(entry.data));
  write32(output, 20, entry.data.byteLength);
  write32(output, 24, entry.data.byteLength);
  write16(output, 28, entry.nameBytes.byteLength);
  write16(output, 30, 0);
  write16(output, 32, 0);
  write16(output, 34, 0);
  write16(output, 36, 0);
  write32(output, 38, entry.externalAttributes);
  write32(output, 42, localOffset);
  output.set(entry.nameBytes, 46);
  return output;
}

function rebuildZip(archive: ZipArchive, replacements: ReadonlyMap<string, ReplacementEntry>): Uint8Array {
  const localOrder = [...archive.entries].sort((left, right) => left.localOffset - right.localOffset);
  const additions = [...replacements.values()].filter((entry) => !archive.byName.has(entry.name));
  const localParts: Array<{ readonly entry: ZipEntry | ReplacementEntry; readonly bytes: Uint8Array }> = [];
  for (const entry of localOrder) {
    const replacement = replacements.get(entry.name);
    localParts.push({
      entry: replacement ?? entry,
      bytes: replacement
        ? localRecord(replacement)
        : archive.bytes.slice(entry.localOffset, entry.localEnd),
    });
  }
  additions.forEach((entry) => localParts.push({ entry, bytes: localRecord(entry) }));

  const localOffsets = new Map<string, number>();
  let localBytes = 0;
  for (const part of localParts) {
    localOffsets.set(part.entry.name, localBytes);
    localBytes += part.bytes.byteLength;
  }
  const centralParts: Uint8Array[] = [];
  for (const entry of archive.entries) {
    const replacement = replacements.get(entry.name);
    const offset = localOffsets.get(entry.name) as number;
    if (replacement) centralParts.push(centralRecord(replacement, offset));
    else {
      const central = entry.centralBytes.slice();
      write32(central, 42, offset);
      centralParts.push(central);
    }
  }
  additions.forEach((entry) => centralParts.push(centralRecord(entry, localOffsets.get(entry.name) as number)));
  const centralBytes = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const entryCount = archive.entries.length + additions.length;
  if (entryCount > MAX_ZIP_ENTRIES) malformed(`the edited archive exceeds ${MAX_ZIP_ENTRIES} entries`);
  const total = localBytes + centralBytes + 22;
  if (total > MAX_BOOK_SOURCE_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "The temporary EPUB derivative exceeds the 200 MB limit", {
      details: { outputBytes: total, maximumBytes: MAX_BOOK_SOURCE_BYTES },
    });
  }
  const output = new Uint8Array(total);
  let cursor = 0;
  localParts.forEach((part) => {
    output.set(part.bytes, cursor);
    cursor += part.bytes.byteLength;
  });
  centralParts.forEach((part) => {
    output.set(part, cursor);
    cursor += part.byteLength;
  });
  write32(output, cursor, EOCD_SIGNATURE);
  write16(output, cursor + 8, entryCount);
  write16(output, cursor + 10, entryCount);
  write32(output, cursor + 12, centralBytes);
  write32(output, cursor + 16, localBytes);
  return output;
}

/** Applies overrides to a bounded, newly allocated EPUB archive. */
export async function createEphemeralEpubDerivative(
  source: Uint8Array,
  overrides: ResolvedConversionOverrides,
): Promise<Uint8Array> {
  const archive = parseZip(source);
  const containerEntry = archive.byName.get("META-INF/container.xml")
    ?? malformed("the archive has no META-INF/container.xml");
  const container = parseXml(await readEntry(archive, containerEntry, MAX_XML_BYTES), "container.xml");
  const opfPath = packagePath(container);
  const opfEntry = archive.byName.get(opfPath) ?? malformed("the package document is absent");
  const packageDocument = parseXml(await readEntry(archive, opfEntry, MAX_XML_BYTES), "package document");

  applyMetadata(packageDocument, overrides);
  const replacements = new Map<string, ReplacementEntry>();
  if (overrides.cover) {
    const currentCover = existingCover(packageDocument, archive, opfPath);
    if (currentCover) {
      // Reusing the exact archive path keeps cover/title-page XHTML and CSS
      // references aligned with the new image. boko classifies all supported
      // cover extensions as image resources and embeds the replacement bytes.
      applyCover(packageDocument, overrides.cover.mediaType, currentCover.href, currentCover.item);
      replacements.set(
        currentCover.entry.name,
        replacementFromExisting(currentCover.entry, overrides.cover.bytes),
      );
    } else {
      const extension = overrides.cover.mediaType === "image/jpeg"
        ? "jpg"
        : overrides.cover.mediaType === "image/png" ? "png" : "webp";
      const cover = freshName(archive, opfPath, extension);
      applyCover(packageDocument, overrides.cover.mediaType, cover.href);
      replacements.set(cover.path, replacementForNew(cover.path, overrides.cover.bytes));
    }
  }
  const opfBytes = serializeXml(packageDocument);
  if (opfBytes.byteLength > MAX_XML_BYTES) malformed(`the edited package document exceeds ${MAX_XML_BYTES} bytes`);
  replacements.set(opfPath, replacementFromExisting(opfEntry, opfBytes));
  return rebuildZip(archive, replacements);
}
