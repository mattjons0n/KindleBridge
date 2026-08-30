const PALMDB_NAME_BYTES = 32;
const PALMDB_TYPE_CREATOR_OFFSET = 60;
const PALMDB_RECORD_COUNT_OFFSET = 76;
const PALMDB_FIRST_RECORD_OFFSET = 78;
const PALMDB_RECORD_ENTRY_BYTES = 8;
const PALMDOC_HEADER_BYTES = 16;
const MOBI_SIGNATURE_BYTES = 4;
const MOBI_HEADER_LENGTH_OFFSET = 4;
const MOBI_ENCODING_OFFSET = 12;
const MOBI_FULL_NAME_OFFSET = 0x54;
const MOBI_FULL_NAME_LENGTH_OFFSET = 0x58;
const MOBI_EXTH_FLAGS_OFFSET = 0x80;
const MOBI_EXTH_FLAG = 0x40;
const EXTH_HEADER_BYTES = 12;

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXTH_RECORDS = 4_096;
const DEFAULT_MAX_FIELD_BYTES = 4_096;
const DEFAULT_MAX_AUTHORS = 64;
const DEFAULT_MAX_IDENTIFIERS = 64;
const HARD_MAX_INPUT_BYTES = 200 * 1024 * 1024;
const HARD_MAX_EXTH_RECORDS = 65_535;
const HARD_MAX_FIELD_BYTES = 64 * 1024;
const HARD_MAX_VALUES = 1_024;

export type KindleBookMetadataErrorCode =
  | "KINDLE_METADATA_INPUT_LIMIT"
  | "KINDLE_METADATA_INVALID_PALMDB"
  | "KINDLE_METADATA_INVALID_MOBI"
  | "KINDLE_METADATA_INVALID_EXTH"
  | "KINDLE_METADATA_FIELD_LIMIT";

export class KindleBookMetadataError extends Error {
  readonly code: KindleBookMetadataErrorCode;

  constructor(code: KindleBookMetadataErrorCode, message: string) {
    super(message);
    this.name = "KindleBookMetadataError";
    this.code = code;
  }
}

export interface KindleBookMetadata {
  readonly title?: string;
  readonly authors: readonly string[];
  /** Type-qualified values such as `isbn:...`, `asin:...`, and `source:...`. */
  readonly identifiers: readonly string[];
  readonly language?: string;
}

export interface KindleBookMetadataParserOptions {
  readonly maxInputBytes?: number;
  readonly maxExthRecords?: number;
  readonly maxFieldBytes?: number;
  readonly maxAuthors?: number;
  readonly maxIdentifiers?: number;
}

interface ResolvedParserLimits {
  readonly maxInputBytes: number;
  readonly maxExthRecords: number;
  readonly maxFieldBytes: number;
  readonly maxAuthors: number;
  readonly maxIdentifiers: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function resolveLimits(options: KindleBookMetadataParserOptions): ResolvedParserLimits {
  return {
    maxInputBytes: boundedInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      1,
      HARD_MAX_INPUT_BYTES,
      "maxInputBytes",
    ),
    maxExthRecords: boundedInteger(
      options.maxExthRecords,
      DEFAULT_MAX_EXTH_RECORDS,
      1,
      HARD_MAX_EXTH_RECORDS,
      "maxExthRecords",
    ),
    maxFieldBytes: boundedInteger(
      options.maxFieldBytes,
      DEFAULT_MAX_FIELD_BYTES,
      1,
      HARD_MAX_FIELD_BYTES,
      "maxFieldBytes",
    ),
    maxAuthors: boundedInteger(
      options.maxAuthors,
      DEFAULT_MAX_AUTHORS,
      1,
      HARD_MAX_VALUES,
      "maxAuthors",
    ),
    maxIdentifiers: boundedInteger(
      options.maxIdentifiers,
      DEFAULT_MAX_IDENTIFIERS,
      1,
      HARD_MAX_VALUES,
      "maxIdentifiers",
    ),
  };
}

function metadataError(
  code: KindleBookMetadataErrorCode,
  message: string,
): KindleBookMetadataError {
  return new KindleBookMetadataError(code, message);
}

function checkedEnd(
  start: number,
  length: number,
  outerEnd: number,
  code: KindleBookMetadataErrorCode,
  label: string,
): number {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    throw metadataError(code, `Invalid ${label} bounds.`);
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end < start || end > outerEnd) {
    throw metadataError(code, `Invalid ${label} bounds.`);
  }
  return end;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function decoderFor(codepage: number): TextDecoder {
  if (codepage === 65001) return new TextDecoder("utf-8");
  // MOBI codepage 1252 is the other common value. Unknown legacy values are
  // decoded conservatively as Windows-1252 rather than executing any codec.
  return new TextDecoder("windows-1252");
}

function decodeField(
  bytes: Uint8Array,
  start: number,
  length: number,
  decoder: TextDecoder,
  limits: ResolvedParserLimits,
): string {
  if (length > limits.maxFieldBytes) {
    throw metadataError("KINDLE_METADATA_FIELD_LIMIT", "Kindle metadata field exceeds its byte limit.");
  }
  return normalizeText(decoder.decode(bytes.subarray(start, start + length)));
}

function addUnique(values: string[], value: string, limit: number, label: string): void {
  if (value.length === 0 || values.includes(value)) return;
  if (values.length >= limit) {
    throw metadataError("KINDLE_METADATA_FIELD_LIMIT", `Kindle metadata has too many ${label}.`);
  }
  values.push(value);
}

function parsePalmDbBounds(bytes: Uint8Array, view: DataView): {
  record0: number;
  record0End: number;
} {
  if (bytes.byteLength < PALMDB_FIRST_RECORD_OFFSET + PALMDB_RECORD_ENTRY_BYTES) {
    throw metadataError("KINDLE_METADATA_INVALID_PALMDB", "Kindle file has a truncated PalmDB header.");
  }
  if (ascii(bytes, PALMDB_TYPE_CREATOR_OFFSET, 8) !== "BOOKMOBI") {
    throw metadataError("KINDLE_METADATA_INVALID_PALMDB", "Kindle file is not a BOOKMOBI PalmDB.");
  }
  const recordCount = view.getUint16(PALMDB_RECORD_COUNT_OFFSET, false);
  if (recordCount < 1) {
    throw metadataError("KINDLE_METADATA_INVALID_PALMDB", "Kindle file has no PalmDB records.");
  }
  const tableEnd = checkedEnd(
    PALMDB_FIRST_RECORD_OFFSET,
    recordCount * PALMDB_RECORD_ENTRY_BYTES,
    bytes.byteLength,
    "KINDLE_METADATA_INVALID_PALMDB",
    "PalmDB record table",
  );
  const record0 = u32(view, PALMDB_FIRST_RECORD_OFFSET);
  const record0End = recordCount > 1
    ? u32(view, PALMDB_FIRST_RECORD_OFFSET + PALMDB_RECORD_ENTRY_BYTES)
    : bytes.byteLength;
  if (record0 < tableEnd || record0End <= record0 || record0End > bytes.byteLength) {
    throw metadataError("KINDLE_METADATA_INVALID_PALMDB", "Kindle file has invalid record-0 bounds.");
  }
  return { record0, record0End };
}

interface ParsedExth {
  readonly title?: string;
  readonly authors: readonly string[];
  readonly identifiers: readonly string[];
  readonly language?: string;
}

function parseExth(
  bytes: Uint8Array,
  view: DataView,
  exth: number,
  record0End: number,
  decoder: TextDecoder,
  limits: ResolvedParserLimits,
): ParsedExth {
  checkedEnd(
    exth,
    EXTH_HEADER_BYTES,
    record0End,
    "KINDLE_METADATA_INVALID_EXTH",
    "EXTH header",
  );
  if (ascii(bytes, exth, 4) !== "EXTH") {
    throw metadataError("KINDLE_METADATA_INVALID_EXTH", "Kindle file declares EXTH metadata without an EXTH header.");
  }
  const exthLength = u32(view, exth + 4);
  if (exthLength < EXTH_HEADER_BYTES) {
    throw metadataError("KINDLE_METADATA_INVALID_EXTH", "Kindle file has an invalid EXTH length.");
  }
  const exthEnd = checkedEnd(
    exth,
    exthLength,
    record0End,
    "KINDLE_METADATA_INVALID_EXTH",
    "EXTH block",
  );
  const recordCount = u32(view, exth + 8);
  if (
    recordCount > limits.maxExthRecords
    || recordCount > Math.floor((exthLength - EXTH_HEADER_BYTES) / 8)
  ) {
    throw metadataError("KINDLE_METADATA_INVALID_EXTH", "Kindle file has an invalid EXTH record count.");
  }

  let cursor = exth + EXTH_HEADER_BYTES;
  let title: string | undefined;
  let language: string | undefined;
  const authors: string[] = [];
  const identifiers: string[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    checkedEnd(
      cursor,
      8,
      exthEnd,
      "KINDLE_METADATA_INVALID_EXTH",
      "EXTH record header",
    );
    const type = u32(view, cursor);
    const length = u32(view, cursor + 4);
    if (length < 8) {
      throw metadataError("KINDLE_METADATA_INVALID_EXTH", "Kindle file has an invalid EXTH record length.");
    }
    const recordEnd = checkedEnd(
      cursor,
      length,
      exthEnd,
      "KINDLE_METADATA_INVALID_EXTH",
      "EXTH record",
    );
    const contentStart = cursor + 8;
    const contentLength = length - 8;

    if (type === 100 || type === 104 || type === 112 || type === 113
      || type === 503 || type === 504 || type === 524) {
      const value = decodeField(bytes, contentStart, contentLength, decoder, limits);
      if (type === 100) addUnique(authors, value, limits.maxAuthors, "authors");
      if (type === 104 && value.length > 0) {
        addUnique(identifiers, `isbn:${value}`, limits.maxIdentifiers, "identifiers");
      }
      if (type === 112 && value.length > 0) {
        addUnique(identifiers, `source:${value}`, limits.maxIdentifiers, "identifiers");
      }
      if ((type === 113 || type === 504) && value.length > 0) {
        addUnique(identifiers, `asin:${value}`, limits.maxIdentifiers, "identifiers");
      }
      if (type === 503 && value.length > 0) title = value;
      if (type === 524 && value.length > 0) language = value;
    }
    cursor = recordEnd;
  }
  return {
    ...(title === undefined ? {} : { title }),
    authors: Object.freeze(authors),
    identifiers: Object.freeze(identifiers),
    ...(language === undefined ? {} : { language }),
  };
}

/**
 * Parses only bounded PalmDB/MOBI/EXTH metadata from bytes already read from a
 * Kindle. The input is never modified and no decompression or active content is
 * performed.
 */
export function parseKindleBookMetadata(
  bytes: Uint8Array,
  options: KindleBookMetadataParserOptions = {},
): KindleBookMetadata {
  const limits = resolveLimits(options);
  if (bytes.byteLength > limits.maxInputBytes) {
    throw metadataError("KINDLE_METADATA_INPUT_LIMIT", "Kindle file exceeds the metadata parser byte limit.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { record0, record0End } = parsePalmDbBounds(bytes, view);
  const mobi = record0 + PALMDOC_HEADER_BYTES;
  checkedEnd(
    mobi,
    MOBI_SIGNATURE_BYTES + 4,
    record0End,
    "KINDLE_METADATA_INVALID_MOBI",
    "MOBI header",
  );
  if (ascii(bytes, mobi, MOBI_SIGNATURE_BYTES) !== "MOBI") {
    throw metadataError("KINDLE_METADATA_INVALID_MOBI", "Kindle file has no MOBI header.");
  }
  const mobiHeaderLength = u32(view, mobi + MOBI_HEADER_LENGTH_OFFSET);
  if (mobiHeaderLength < 24) {
    throw metadataError("KINDLE_METADATA_INVALID_MOBI", "Kindle file has an invalid MOBI header length.");
  }
  checkedEnd(
    mobi,
    mobiHeaderLength,
    record0End,
    "KINDLE_METADATA_INVALID_MOBI",
    "MOBI header",
  );

  checkedEnd(
    mobi + MOBI_ENCODING_OFFSET,
    4,
    record0End,
    "KINDLE_METADATA_INVALID_MOBI",
    "MOBI encoding",
  );
  const codepage = u32(view, mobi + MOBI_ENCODING_OFFSET);
  const decoder = decoderFor(codepage);

  let mobiTitle: string | undefined;
  if (record0 + MOBI_FULL_NAME_LENGTH_OFFSET + 4 <= record0End) {
    const titleOffset = u32(view, record0 + MOBI_FULL_NAME_OFFSET);
    const titleLength = u32(view, record0 + MOBI_FULL_NAME_LENGTH_OFFSET);
    if (titleLength > 0) {
      const titleStart = record0 + titleOffset;
      checkedEnd(
        titleStart,
        titleLength,
        record0End,
        "KINDLE_METADATA_INVALID_MOBI",
        "MOBI full name",
      );
      mobiTitle = decodeField(bytes, titleStart, titleLength, decoder, limits) || undefined;
    }
  }

  let exth: ParsedExth = {
    authors: Object.freeze([]),
    identifiers: Object.freeze([]),
  };
  if (record0 + MOBI_EXTH_FLAGS_OFFSET + 4 <= record0End) {
    const flags = u32(view, record0 + MOBI_EXTH_FLAGS_OFFSET);
    if ((flags & MOBI_EXTH_FLAG) !== 0) {
      exth = parseExth(
        bytes,
        view,
        mobi + mobiHeaderLength,
        record0End,
        decoder,
        limits,
      );
    }
  }

  const databaseTitle = decodeField(
    bytes,
    0,
    Math.min(PALMDB_NAME_BYTES, bytes.byteLength),
    decoder,
    limits,
  ) || undefined;
  const title = exth.title ?? mobiTitle ?? databaseTitle;
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    authors: exth.authors,
    identifiers: exth.identifiers,
    ...(exth.language === undefined ? {} : { language: exth.language }),
  });
}
