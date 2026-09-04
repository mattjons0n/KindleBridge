import type { KindleBookMetadata } from "./book-metadata";

const CONT_MAGIC = "CONT";
const ENTITY_MAGIC = "ENTY";
const ION_MAGIC = Uint8Array.of(0xe0, 0x01, 0x00, 0xea);
const COMMON_HEADER_BYTES = 10;
const CONTAINER_DESCRIPTOR_OFFSET = 18;
const ENTITY_DESCRIPTOR_BYTES = 24;
const SUPPORTED_BLOCK_VERSION = 1;

const DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ENTITIES = 256;
const DEFAULT_MAX_FIELDS = 4_096;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 1024 * 1024;
const DEFAULT_MAX_AUTHORS = 64;
const DEFAULT_MAX_IDENTIFIERS = 64;

const HARD_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const HARD_MAX_ENTITIES = 2_048;
const HARD_MAX_FIELDS = 65_536;
const HARD_MAX_DEPTH = 64;
const HARD_MAX_STRING_BYTES = 256 * 1024;
const HARD_MAX_DECODED_BYTES = 8 * 1024 * 1024;
const HARD_MAX_VALUES = 1_024;

// Calibre's KFX metadata reader names these numeric symbols Pxxx. Kindle
// Bridge deliberately supports only the small matching-relevant subset.
const P_LANGUAGE = 10;
const P_TITLE = 153;
const P_AUTHOR = 222;
const P_METADATA_ENTITY = 258;
const P_METADATA_GROUP = 491;
const P_METADATA_KEY = 492;
const P_METADATA_VALUE = 307;

export type KindleKfxMetadataErrorCode =
  | "KFX_METADATA_INPUT_LIMIT"
  | "KFX_METADATA_INVALID_CONTAINER"
  | "KFX_METADATA_UNSUPPORTED_VERSION"
  | "KFX_METADATA_ENTITY_LIMIT"
  | "KFX_METADATA_INVALID_ENTITY"
  | "KFX_METADATA_INVALID_ION"
  | "KFX_METADATA_DEPTH_LIMIT"
  | "KFX_METADATA_FIELD_LIMIT"
  | "KFX_METADATA_STRING_LIMIT"
  | "KFX_METADATA_DECODED_TOTAL_LIMIT"
  | "KFX_METADATA_CONFLICT";

export class KindleKfxMetadataError extends Error {
  readonly code: KindleKfxMetadataErrorCode;

  constructor(code: KindleKfxMetadataErrorCode, message: string) {
    super(message);
    this.name = "KindleKfxMetadataError";
    this.code = code;
  }
}

export interface KindleKfxMetadataParserOptions {
  readonly maxInputBytes?: number;
  readonly maxEntities?: number;
  readonly maxFields?: number;
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
  readonly maxDecodedBytes?: number;
  readonly maxAuthors?: number;
  readonly maxIdentifiers?: number;
}

interface ResolvedLimits {
  readonly maxInputBytes: number;
  readonly maxEntities: number;
  readonly maxFields: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxAuthors: number;
  readonly maxIdentifiers: number;
}

interface DecodeBudget {
  fields: number;
  decodedBytes: number;
  readonly limits: ResolvedLimits;
}

interface IonSymbol {
  readonly kind: "symbol";
  readonly value: number;
}

type IonValue = boolean | number | string | IonSymbol | readonly IonValue[] | ReadonlyMap<number, IonValue>;

interface EntityDescriptor {
  readonly id: number;
  readonly type: number;
  readonly start: number;
  readonly end: number;
}

function fail(code: KindleKfxMetadataErrorCode, message: string): never {
  throw new KindleKfxMetadataError(code, message);
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

function resolveLimits(options: KindleKfxMetadataParserOptions): ResolvedLimits {
  return {
    maxInputBytes: boundedInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 1, HARD_MAX_INPUT_BYTES, "maxInputBytes"),
    maxEntities: boundedInteger(options.maxEntities, DEFAULT_MAX_ENTITIES, 1, HARD_MAX_ENTITIES, "maxEntities"),
    maxFields: boundedInteger(options.maxFields, DEFAULT_MAX_FIELDS, 1, HARD_MAX_FIELDS, "maxFields"),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, HARD_MAX_DEPTH, "maxDepth"),
    maxStringBytes: boundedInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 1, HARD_MAX_STRING_BYTES, "maxStringBytes"),
    maxDecodedBytes: boundedInteger(options.maxDecodedBytes, DEFAULT_MAX_DECODED_BYTES, 1, HARD_MAX_DECODED_BYTES, "maxDecodedBytes"),
    maxAuthors: boundedInteger(options.maxAuthors, DEFAULT_MAX_AUTHORS, 1, HARD_MAX_VALUES, "maxAuthors"),
    maxIdentifiers: boundedInteger(options.maxIdentifiers, DEFAULT_MAX_IDENTIFIERS, 1, HARD_MAX_VALUES, "maxIdentifiers"),
  };
}

function checkedEnd(
  start: number,
  length: number,
  outerEnd: number,
  code: KindleKfxMetadataErrorCode,
  label: string,
): number {
  const end = start + length;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(length)
    || start < 0
    || length < 0
    || !Number.isSafeInteger(end)
    || end < start
    || end > outerEnd
  ) {
    fail(code, `Invalid ${label} bounds.`);
  }
  return end;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]!);
  return value;
}

function matches(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset < 0 || offset + expected.byteLength > bytes.byteLength) return false;
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function safeU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("KFX_METADATA_INVALID_CONTAINER", "KFX entity bounds exceed the safe integer range.");
  }
  return Number(value);
}

function parseContainer(bytes: Uint8Array, limits: ResolvedLimits): readonly EntityDescriptor[] {
  if (bytes.byteLength < CONTAINER_DESCRIPTOR_OFFSET || ascii(bytes, 0, 4) !== CONT_MAGIC) {
    fail("KFX_METADATA_INVALID_CONTAINER", "KFX metadata does not have a complete CONT header.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== SUPPORTED_BLOCK_VERSION) {
    fail("KFX_METADATA_UNSUPPORTED_VERSION", "KFX CONT version is not supported.");
  }
  const headerLength = view.getUint32(6, true);
  if (headerLength < CONTAINER_DESCRIPTOR_OFFSET + ION_MAGIC.byteLength || headerLength > bytes.byteLength) {
    fail("KFX_METADATA_INVALID_CONTAINER", "KFX CONT header length is invalid.");
  }

  const descriptors: EntityDescriptor[] = [];
  const descriptorKeys = new Set<string>();
  let offset = CONTAINER_DESCRIPTOR_OFFSET;
  while (!matches(bytes, offset, ION_MAGIC)) {
    if (offset + ENTITY_DESCRIPTOR_BYTES > headerLength) {
      fail("KFX_METADATA_INVALID_CONTAINER", "KFX CONT descriptor table has no bounded terminator.");
    }
    if (descriptors.length >= limits.maxEntities) {
      fail("KFX_METADATA_ENTITY_LIMIT", "KFX metadata has too many entities.");
    }
    const id = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const relativeStart = safeU64(view, offset + 8);
    const length = safeU64(view, offset + 16);
    const start = checkedEnd(headerLength, relativeStart, bytes.byteLength, "KFX_METADATA_INVALID_CONTAINER", "entity offset");
    const end = checkedEnd(start, length, bytes.byteLength, "KFX_METADATA_INVALID_CONTAINER", "entity");
    if (length < COMMON_HEADER_BYTES + ION_MAGIC.byteLength) {
      fail("KFX_METADATA_INVALID_ENTITY", "KFX entity is too short.");
    }
    const key = `${type}:${id}`;
    if (descriptorKeys.has(key)) {
      fail("KFX_METADATA_CONFLICT", "KFX metadata contains a duplicate entity descriptor.");
    }
    descriptorKeys.add(key);
    descriptors.push(Object.freeze({ id, type, start, end }));
    offset += ENTITY_DESCRIPTOR_BYTES;
  }
  if (offset + ION_MAGIC.byteLength > headerLength) {
    fail("KFX_METADATA_INVALID_CONTAINER", "KFX CONT descriptor terminator is outside its header.");
  }

  const ordered = [...descriptors].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      fail("KFX_METADATA_CONFLICT", "KFX entity byte ranges overlap.");
    }
  }
  return Object.freeze(descriptors);
}

function reserveDecoded(budget: DecodeBudget, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.limits.maxDecodedBytes - budget.decodedBytes) {
    fail("KFX_METADATA_DECODED_TOTAL_LIMIT", "KFX decoded metadata exceeds its aggregate limit.");
  }
  budget.decodedBytes += amount;
}

function reserveField(budget: DecodeBudget): void {
  if (budget.fields >= budget.limits.maxFields) {
    fail("KFX_METADATA_FIELD_LIMIT", "KFX metadata has too many decoded fields.");
  }
  budget.fields += 1;
  reserveDecoded(budget, 8);
}

class PackedIonReader {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  readonly #budget: DecodeBudget;
  #offset: number;

  constructor(bytes: Uint8Array, start: number, end: number, budget: DecodeBudget) {
    this.#bytes = bytes;
    this.#offset = start;
    this.#end = end;
    this.#budget = budget;
  }

  get done(): boolean {
    return this.#offset === this.#end;
  }

  ensure(length: number): void {
    checkedEnd(this.#offset, length, this.#end, "KFX_METADATA_INVALID_ION", "PackedIon field");
  }

  byte(): number {
    this.ensure(1);
    return this.#bytes[this.#offset++]!;
  }

  varUInt(): number {
    let value = 0;
    for (let count = 0; count < 8; count += 1) {
      const byte = this.byte();
      if (value > Math.floor((Number.MAX_SAFE_INTEGER - (byte & 0x7f)) / 128)) {
        fail("KFX_METADATA_INVALID_ION", "PackedIon variable integer exceeds the safe range.");
      }
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) !== 0) return value;
    }
    fail("KFX_METADATA_INVALID_ION", "PackedIon variable integer is unterminated.");
  }

  unsigned(length: number): number {
    if (length > 8) fail("KFX_METADATA_INVALID_ION", "PackedIon integer is too wide.");
    this.ensure(length);
    let value = 0;
    for (let count = 0; count < length; count += 1) {
      const byte = this.byte();
      if (value > Math.floor((Number.MAX_SAFE_INTEGER - byte) / 256)) {
        fail("KFX_METADATA_INVALID_ION", "PackedIon integer exceeds the safe range.");
      }
      value = value * 256 + byte;
    }
    return value;
  }

  value(depth = 0): IonValue {
    if (depth > this.#budget.limits.maxDepth) {
      fail("KFX_METADATA_DEPTH_LIMIT", "PackedIon nesting exceeds its depth limit.");
    }
    reserveField(this.#budget);
    const command = this.byte();
    const type = command >>> 4;
    const shortLength = command & 0x0f;
    if (shortLength === 0x0f) fail("KFX_METADATA_INVALID_ION", "PackedIon uses a reserved length marker.");
    const length = shortLength === 0x0e ? this.varUInt() : shortLength;
    const end = checkedEnd(this.#offset, length, this.#end, "KFX_METADATA_INVALID_ION", "PackedIon value");

    if (type === 1) {
      if (length !== 0 && length !== 1) fail("KFX_METADATA_INVALID_ION", "PackedIon boolean length is invalid.");
      const value = length === 1;
      this.#offset = end;
      return value;
    }
    if (type === 2) {
      const value = this.unsigned(length);
      if (this.#offset !== end) fail("KFX_METADATA_INVALID_ION", "PackedIon integer length is inconsistent.");
      return value;
    }
    if (type === 7) {
      const value = this.unsigned(length);
      if (this.#offset !== end) fail("KFX_METADATA_INVALID_ION", "PackedIon symbol length is inconsistent.");
      return Object.freeze({ kind: "symbol", value });
    }
    if (type === 8) {
      if (length > this.#budget.limits.maxStringBytes) {
        fail("KFX_METADATA_STRING_LIMIT", "PackedIon string exceeds its byte limit.");
      }
      reserveDecoded(this.#budget, length);
      this.ensure(length);
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes.subarray(this.#offset, end));
      } catch {
        fail("KFX_METADATA_INVALID_ION", "PackedIon string is not valid UTF-8.");
      }
      this.#offset = end;
      return value;
    }

    const nested = new PackedIonReader(this.#bytes, this.#offset, end, this.#budget);
    if (type === 11 || type === 12) {
      const values: IonValue[] = [];
      while (!nested.done) values.push(nested.value(depth + 1));
      this.#offset = end;
      return Object.freeze(values);
    }
    if (type === 13) {
      const values = new Map<number, IonValue>();
      while (!nested.done) {
        reserveField(this.#budget);
        const key = nested.varUInt();
        if (values.has(key)) fail("KFX_METADATA_CONFLICT", "PackedIon object contains a duplicate property.");
        values.set(key, nested.value(depth + 1));
      }
      this.#offset = end;
      return values;
    }
    if (type === 14) {
      nested.varUInt();
      nested.varUInt();
      const value = nested.value(depth + 1);
      if (!nested.done) fail("KFX_METADATA_INVALID_ION", "PackedIon typed value has trailing bytes.");
      this.#offset = end;
      return value;
    }
    fail("KFX_METADATA_INVALID_ION", "PackedIon value type is not supported by the bounded metadata reader.");
  }
}

function parseEntity(bytes: Uint8Array, descriptor: EntityDescriptor, budget: DecodeBudget): IonValue {
  if (ascii(bytes, descriptor.start, 4) !== ENTITY_MAGIC) {
    fail("KFX_METADATA_INVALID_ENTITY", "KFX entity does not have an ENTY header.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + descriptor.start, descriptor.end - descriptor.start);
  if (view.getUint16(4, true) !== SUPPORTED_BLOCK_VERSION) {
    fail("KFX_METADATA_UNSUPPORTED_VERSION", "KFX ENTY version is not supported.");
  }
  const headerLength = view.getUint32(6, true);
  if (headerLength < COMMON_HEADER_BYTES || headerLength > descriptor.end - descriptor.start) {
    fail("KFX_METADATA_INVALID_ENTITY", "KFX ENTY header length is invalid.");
  }
  const dataStart = descriptor.start + headerLength;
  if (!matches(bytes, dataStart, ION_MAGIC)) {
    fail("KFX_METADATA_INVALID_ION", "KFX entity has no PackedIon marker.");
  }
  const reader = new PackedIonReader(bytes, dataStart + ION_MAGIC.byteLength, descriptor.end, budget);
  const value = reader.value();
  if (!reader.done) fail("KFX_METADATA_INVALID_ION", "KFX entity has trailing PackedIon data.");
  return value;
}

function asObject(value: IonValue | undefined): ReadonlyMap<number, IonValue> | undefined {
  return value instanceof Map ? value : undefined;
}

function asList(value: IonValue | undefined): readonly IonValue[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function normalizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function strings(value: IonValue | undefined): readonly string[] {
  const output: string[] = [];
  for (const item of asList(value)) {
    if (typeof item === "string") {
      const normalized = normalizeText(item);
      if (normalized.length > 0) output.push(normalized);
    }
  }
  return output;
}

function oneDistinct(values: readonly string[], label: string): string | undefined {
  const distinct = new Map(values.map((value) => [value.toLocaleLowerCase("en-US"), value]));
  if (distinct.size > 1) fail("KFX_METADATA_CONFLICT", `KFX metadata has conflicting ${label}.`);
  return distinct.values().next().value as string | undefined;
}

function addUnique(values: string[], value: string, maximum: number, label: string): void {
  const key = value.toLocaleLowerCase("en-US");
  if (values.some((candidate) => candidate.toLocaleLowerCase("en-US") === key)) return;
  if (values.length >= maximum) fail("KFX_METADATA_FIELD_LIMIT", `KFX metadata has too many ${label}.`);
  values.push(value);
}

function nestedMetadata(root: ReadonlyMap<number, IonValue>): readonly ReadonlyMap<number, IonValue>[] {
  const output: ReadonlyMap<number, IonValue>[] = [];
  for (const group of asList(root.get(P_METADATA_GROUP))) {
    const groupObject = asObject(group);
    if (!groupObject) continue;
    for (const value of asList(groupObject.get(P_METADATA_ENTITY))) {
      const metadataObject = asObject(value);
      if (metadataObject) output.push(metadataObject);
    }
  }
  return output;
}

/**
 * Parses the matching-relevant subset of a bounded `metadata.kfx` sidecar.
 * This is intentionally not a general KFX reader and never accepts book bytes.
 */
export function parseKindleKfxMetadata(
  bytes: Uint8Array,
  options: KindleKfxMetadataParserOptions = {},
): KindleBookMetadata {
  const limits = resolveLimits(options);
  if (bytes.byteLength > limits.maxInputBytes) {
    fail("KFX_METADATA_INPUT_LIMIT", "KFX metadata sidecar exceeds its input limit.");
  }
  const descriptors = parseContainer(bytes, limits);
  const budget: DecodeBudget = { fields: 0, decodedBytes: 0, limits };
  const titles: string[] = [];
  const authors: string[] = [];
  const languages: string[] = [];
  const asins: string[] = [];
  const contentIds: string[] = [];
  const isbns: string[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.type !== P_METADATA_ENTITY && descriptor.type !== 490) continue;
    const value = parseEntity(bytes, descriptor, budget);
    const root = asObject(value);
    if (!root) fail("KFX_METADATA_INVALID_ION", "KFX metadata entity is not an object.");
    if (descriptor.type === P_METADATA_ENTITY) {
      titles.push(...strings(root.get(P_TITLE)));
      for (const author of strings(root.get(P_AUTHOR))) addUnique(authors, author, limits.maxAuthors, "authors");
      languages.push(...strings(root.get(P_LANGUAGE)));
      continue;
    }
    for (const item of nestedMetadata(root)) {
      const key = oneDistinct(strings(item.get(P_METADATA_KEY)), "metadata keys")?.toLocaleLowerCase("en-US");
      if (!key) continue;
      const values = strings(item.get(P_METADATA_VALUE));
      if (key === "title") titles.push(...values);
      else if (key === "author" || key === "authors") {
        for (const author of values) addUnique(authors, author, limits.maxAuthors, "authors");
      } else if (key === "language" || key === "languages") languages.push(...values);
      else if (key === "asin") asins.push(...values);
      else if (key === "content_id") contentIds.push(...values);
      else if (key === "isbn") isbns.push(...values);
    }
  }

  const title = oneDistinct(titles, "titles");
  const language = oneDistinct(languages, "languages");
  const asin = oneDistinct(asins, "ASIN identifiers") ?? oneDistinct(contentIds, "content identifiers");
  const identifiers: string[] = [];
  if (asin) addUnique(identifiers, `asin:${asin}`, limits.maxIdentifiers, "identifiers");
  for (const isbn of isbns) addUnique(identifiers, `isbn:${isbn}`, limits.maxIdentifiers, "identifiers");
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    authors: Object.freeze(authors),
    identifiers: Object.freeze(identifiers),
    ...(language === undefined ? {} : { language }),
  });
}
