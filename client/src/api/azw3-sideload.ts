export interface KindleSideloadMetadata {
  readonly documentType: "PDOC";
  readonly embeddedCover: boolean;
}

export interface PreparedKindleSideload {
  readonly bytes: Uint8Array;
  readonly metadata: KindleSideloadMetadata;
}

const PALMDB_RECORD_COUNT_OFFSET = 76;
const PALMDB_FIRST_RECORD_OFFSET = 78;
const PALMDB_RECORD_ENTRY_BYTES = 8;
const PALMDOC_HEADER_BYTES = 16;
const PALMDOC_TEXT_LENGTH_OFFSET = 4;
const PALMDOC_TEXT_RECORD_COUNT_OFFSET = 8;
const PALMDOC_RECORD_SIZE_OFFSET = 10;
const MOBI_BOOK_TYPE_OFFSET = 8;
const MOBI_VERSION_OFFSET = 20;
const EXTH_HEADER_BYTES = 12;
const FIRST_IMAGE_RECORD_OFFSET = 0x6c;
const MAX_COVER_RECORD_BYTES = 12 * 1024 * 1024;
const MAX_COVER_DIMENSION = 8_192;
const MAX_COVER_PIXELS = 40_000_000;
const MAX_DECODED_TEXT_BYTES = 128 * 1024 * 1024;
const MAX_EXTH_RECORDS = 10_000;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}

function requireRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > bytes.byteLength
  ) {
    throw new Error(`Invalid AZW3 ${label}`);
  }
}

function plausibleDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_COVER_DIMENSION
    && height <= MAX_COVER_DIMENSION
    && height <= Math.floor(MAX_COVER_PIXELS / width);
}

function plausibleJpeg(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let cursor = 2;
  while (cursor < bytes.byteLength) {
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.byteLength) return false;
    const marker = bytes[cursor] as number;
    cursor += 1;
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > bytes.byteLength) return false;
    const segmentLength = view.getUint16(cursor, false);
    if (segmentLength < 2 || cursor + segmentLength > bytes.byteLength) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return segmentLength >= 7
        && plausibleDimensions(view.getUint16(cursor + 5, false), view.getUint16(cursor + 3, false));
    }
    cursor += segmentLength;
  }
  return false;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number)
    | ((bytes[offset + 1] as number) << 8)
    | ((bytes[offset + 2] as number) << 16);
}

/** Header-only plausibility check. Image pixels are never decoded here. */
function plausibleCoverRecord(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 10 || bytes.byteLength > MAX_COVER_RECORD_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
    && view.getUint32(8, false) === 13
    && ascii(bytes, 12, 4) === "IHDR"
  ) {
    return plausibleDimensions(view.getUint32(16, false), view.getUint32(20, false));
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return plausibleDimensions(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (plausibleJpeg(bytes, view)) return true;
  if (
    bytes.byteLength < 20
    || ascii(bytes, 0, 4) !== "RIFF"
    || ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return false;
  }
  const riffEnd = Math.min(bytes.byteLength, view.getUint32(4, true) + 8);
  let cursor = 12;
  while (cursor + 8 <= riffEnd) {
    const kind = ascii(bytes, cursor, 4);
    const chunkLength = view.getUint32(cursor + 4, true);
    const payload = cursor + 8;
    const chunkEnd = payload + chunkLength;
    if (chunkEnd < payload || chunkEnd > riffEnd) return false;
    if (kind === "VP8X" && chunkLength >= 10) {
      return plausibleDimensions(
        1 + readUint24LittleEndian(bytes, payload + 4),
        1 + readUint24LittleEndian(bytes, payload + 7),
      );
    }
    if (
      kind === "VP8 "
      && chunkLength >= 10
      && bytes[payload + 3] === 0x9d
      && bytes[payload + 4] === 0x01
      && bytes[payload + 5] === 0x2a
    ) {
      return plausibleDimensions(
        view.getUint16(payload + 6, true) & 0x3fff,
        view.getUint16(payload + 8, true) & 0x3fff,
      );
    }
    if (kind === "VP8L" && chunkLength >= 5 && bytes[payload] === 0x2f) {
      const dimensions = view.getUint32(payload + 1, true);
      return plausibleDimensions(1 + (dimensions & 0x3fff), 1 + ((dimensions >>> 14) & 0x3fff));
    }
    cursor = chunkEnd + (chunkLength & 1);
  }
  return false;
}

function decodePalmDocRecord(input: Uint8Array, maximumOutput: number): Uint8Array {
  const output: number[] = [];
  let cursor = 0;
  while (cursor < input.byteLength && output.length < maximumOutput) {
    const byte = input[cursor++] as number;
    if (byte === 0 || (byte >= 9 && byte <= 0x7f)) {
      output.push(byte);
      continue;
    }
    if (byte >= 1 && byte <= 8) {
      if (cursor + byte > input.byteLength) throw new Error("Invalid AZW3 PalmDOC literal run");
      for (let index = 0; index < byte && output.length < maximumOutput; index += 1) {
        output.push(input[cursor + index] as number);
      }
      cursor += byte;
      continue;
    }
    if (byte >= 0x80 && byte <= 0xbf) {
      if (cursor >= input.byteLength) throw new Error("Invalid AZW3 PalmDOC back-reference");
      const pair = ((byte & 0x3f) << 8) | (input[cursor++] as number);
      const distance = pair >>> 3;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > output.length) {
        throw new Error("Invalid AZW3 PalmDOC back-reference distance");
      }
      for (let index = 0; index < length && output.length < maximumOutput; index += 1) {
        output.push(output[output.length - distance] as number);
      }
      continue;
    }
    output.push(0x20, byte ^ 0x80);
  }
  return Uint8Array.from(output.slice(0, maximumOutput));
}

function validateReadableBookContent(
  bytes: Uint8Array,
  view: DataView,
  recordOffsets: readonly number[],
  record0: number,
  mobi: number,
): void {
  if (ascii(bytes, 60, 8) !== "BOOKMOBI") throw new Error("Invalid AZW3 PalmDB book type");
  const compression = view.getUint16(record0, false);
  const textLength = view.getUint32(record0 + PALMDOC_TEXT_LENGTH_OFFSET, false);
  const textRecordCount = view.getUint16(record0 + PALMDOC_TEXT_RECORD_COUNT_OFFSET, false);
  const recordSize = view.getUint16(record0 + PALMDOC_RECORD_SIZE_OFFSET, false);
  if (textLength === 0) throw new Error("Invalid AZW3: PalmDOC text length is zero");
  if (textLength > MAX_DECODED_TEXT_BYTES) {
    throw new Error("AZW3 decoded text exceeds the 128 MiB browser limit");
  }
  if (textRecordCount === 0 || textRecordCount >= recordOffsets.length) {
    throw new Error("Invalid AZW3 PalmDOC text record count");
  }
  if (recordSize === 0 || textLength > textRecordCount * recordSize) {
    throw new Error("Invalid AZW3 PalmDOC record size");
  }
  if (view.getUint32(mobi + MOBI_BOOK_TYPE_OFFSET, false) !== 2) {
    throw new Error("Invalid AZW3 MOBI book type");
  }
  if (view.getUint32(mobi + MOBI_VERSION_OFFSET, false) !== 8) {
    throw new Error("Invalid AZW3: MOBI header is not KF8 version 8");
  }

  let remaining = textLength;
  let readableMarkup = false;
  for (let index = 1; index <= textRecordCount; index += 1) {
    const start = recordOffsets[index] as number;
    const end = recordOffsets[index + 1] ?? bytes.byteLength;
    if (end <= start) throw new Error("Invalid AZW3 empty text record");
    const expected = Math.min(recordSize, remaining);
    const record = bytes.subarray(start, end);
    if (compression === 1) {
      if (record.byteLength < expected) throw new Error("Truncated AZW3 uncompressed text record");
      readableMarkup ||= record.subarray(0, expected).includes(0x3c);
    } else if (compression === 2) {
      const decoded = decodePalmDocRecord(record, expected);
      if (decoded.byteLength !== expected) throw new Error("Truncated AZW3 PalmDOC text record");
      readableMarkup ||= decoded.includes(0x3c);
    } else {
      throw new Error(`Unsupported AZW3 PalmDOC compression: ${compression}`);
    }
    remaining -= expected;
  }
  if (remaining !== 0 || !readableMarkup) throw new Error("AZW3 contains no readable book content");

}

/**
 * Prepares boko's KF8/AZW3 output for a modern USB-sideloaded Kindle.
 *
 * Current MTP Kindles do not expose the legacy system/thumbnails directory.
 * They will, however, generate a library tile from the embedded cover when
 * EXTH 501 identifies the sideload as a personal document (PDOC). EBOK and
 * PDOC are both four bytes, so this is an offset-preserving metadata edit.
 */
export function prepareKindleSideload(input: Uint8Array): PreparedKindleSideload {
  const bytes = input.slice();
  requireRange(bytes, PALMDB_RECORD_COUNT_OFFSET, 2, "PalmDB header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordCount = view.getUint16(PALMDB_RECORD_COUNT_OFFSET, false);
  if (recordCount === 0) throw new Error("Invalid AZW3: no PalmDB records");

  const recordTableBytes = recordCount * PALMDB_RECORD_ENTRY_BYTES;
  requireRange(bytes, PALMDB_FIRST_RECORD_OFFSET, recordTableBytes, "record table");
  const recordTableEnd = PALMDB_FIRST_RECORD_OFFSET + recordTableBytes;
  const recordOffsets: number[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = view.getUint32(PALMDB_FIRST_RECORD_OFFSET + index * PALMDB_RECORD_ENTRY_BYTES, false);
    if (
      offset < recordTableEnd
      || offset >= bytes.byteLength
      || (index > 0 && offset <= (recordOffsets[index - 1] as number))
    ) {
      throw new Error("Invalid AZW3 record offsets");
    }
    recordOffsets.push(offset);
  }
  const record0 = recordOffsets[0] as number;
  const record0End = recordOffsets[1] ?? bytes.byteLength;
  if (record0End <= record0 || record0End > bytes.byteLength) {
    throw new Error("Invalid AZW3 record-0 bounds");
  }
  requireRange(bytes, record0, PALMDOC_HEADER_BYTES, "PalmDOC header");
  if (view.getUint16(record0 + 12, false) !== 0) {
    throw new Error("Encrypted AZW3 sources are not supported");
  }

  const mobi = record0 + PALMDOC_HEADER_BYTES;
  requireRange(bytes, mobi, 8, "MOBI header");
  if (ascii(bytes, mobi, 4) !== "MOBI") {
    throw new Error("Invalid AZW3 MOBI header");
  }
  const mobiHeaderLength = view.getUint32(mobi + 4, false);
  if (mobiHeaderLength < 116 || mobi + mobiHeaderLength > record0End) {
    throw new Error("Invalid AZW3 MOBI header bounds");
  }
  validateReadableBookContent(bytes, view, recordOffsets, record0, mobi);
  const exth = mobi + mobiHeaderLength;
  requireRange(bytes, exth, EXTH_HEADER_BYTES, "EXTH header");
  if (exth + EXTH_HEADER_BYTES > record0End || ascii(bytes, exth, 4) !== "EXTH") {
    throw new Error("AZW3 output has no EXTH metadata");
  }

  const exthLength = view.getUint32(exth + 4, false);
  const exthEnd = exth + exthLength;
  if (exthLength < EXTH_HEADER_BYTES || exthEnd > record0End) {
    throw new Error("Invalid AZW3 EXTH bounds");
  }
  const exthRecordCount = view.getUint32(exth + 8, false);
  if (exthRecordCount > MAX_EXTH_RECORDS) {
    throw new Error("AZW3 EXTH record count exceeds the 10000-record limit");
  }
  if (exthRecordCount > Math.floor((exthLength - EXTH_HEADER_BYTES) / 8)) {
    throw new Error("Invalid AZW3 EXTH record count");
  }

  let cursor = exth + EXTH_HEADER_BYTES;
  let documentTypeOffset: number | undefined;
  let coverOffset: number | undefined;
  let thumbnailOffset: number | undefined;
  let thumbnailUri = false;

  for (let index = 0; index < exthRecordCount; index += 1) {
    if (cursor + 8 > exthEnd) throw new Error("Truncated AZW3 EXTH record");
    const type = view.getUint32(cursor, false);
    const length = view.getUint32(cursor + 4, false);
    if (length < 8 || cursor + length > exthEnd) {
      throw new Error("Invalid AZW3 EXTH record bounds");
    }
    const valueOffset = cursor + 8;
    const valueLength = length - 8;
    if (type === 201 && valueLength === 4 && coverOffset === undefined) {
      coverOffset = view.getUint32(valueOffset, false);
    }
    if (type === 202 && valueLength === 4 && thumbnailOffset === undefined) {
      thumbnailOffset = view.getUint32(valueOffset, false);
    }
    if (
      type === 129
      && valueLength <= 128
      && ascii(bytes, valueOffset, valueLength).startsWith("kindle:embed:")
    ) {
      thumbnailUri = true;
    }
    if (type === 501) {
      if (valueLength !== 4) throw new Error("Invalid AZW3 document-type metadata");
      documentTypeOffset = valueOffset;
    }
    cursor += length;
  }

  if (documentTypeOffset === undefined) {
    throw new Error("AZW3 output has no Kindle document-type metadata");
  }
  const documentType = ascii(bytes, documentTypeOffset, 4);
  if (documentType !== "EBOK" && documentType !== "PDOC") {
    throw new Error(`Unsupported Kindle document type: ${documentType}`);
  }
  bytes.set(new TextEncoder().encode("PDOC"), documentTypeOffset);

  const firstImageRecord = view.getUint32(record0 + FIRST_IMAGE_RECORD_OFFSET, false);
  const plausibleReferencedImage = (relativeOffset: number | undefined): boolean => {
    if (relativeOffset === undefined || firstImageRecord === 0xffff_ffff) return false;
    const recordIndex = firstImageRecord + relativeOffset;
    if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || recordIndex >= recordOffsets.length) return false;
    const start = recordOffsets[recordIndex] as number;
    const end = recordOffsets[recordIndex + 1] ?? bytes.byteLength;
    return end > start && plausibleCoverRecord(bytes.subarray(start, end));
  };

  return {
    bytes,
    metadata: {
      documentType: "PDOC",
      embeddedCover:
        thumbnailUri
        && plausibleReferencedImage(coverOffset)
        && plausibleReferencedImage(thumbnailOffset),
    },
  };
}
