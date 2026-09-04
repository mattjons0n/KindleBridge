import {
  validateKindleReadingEvidence,
  type KindleReadingEvidence,
  type KindleReadingSidecarFormat,
} from "./reading-state";

const SIGNATURE = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26);
const SUPPORTED_CONTAINER_VERSION = 1;
const DATATYPE_BOOLEAN = 0;
const DATATYPE_INT = 1;
const DATATYPE_LONG = 2;
const DATATYPE_UTF = 3;
const DATATYPE_DOUBLE = 4;
const DATATYPE_SHORT = 5;
const DATATYPE_FLOAT = 6;
const DATATYPE_BYTE = 7;
const DATATYPE_CHAR = 9;
const DATATYPE_OBJECT_BEGIN = -2;
const DATATYPE_OBJECT_END = -1;

const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOP_LEVEL_OBJECTS = 256;
const DEFAULT_MAX_OBJECTS = 4_096;
const DEFAULT_MAX_VALUES = 32_768;
const DEFAULT_MAX_OBJECT_VALUES = 4_096;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const HARD_MAX_TOP_LEVEL_OBJECTS = 2_048;
const HARD_MAX_OBJECTS = 65_536;
const HARD_MAX_VALUES = 262_144;
const HARD_MAX_OBJECT_VALUES = 65_536;
const HARD_MAX_DEPTH = 64;
const HARD_MAX_STRING_BYTES = 256 * 1024;
const HARD_MAX_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_TIMESTAMP_MILLISECONDS = 253_402_300_799_999;

export type KindleKrdsReadingErrorCode =
  | "KRDS_READING_INPUT_LIMIT"
  | "KRDS_READING_INVALID_SIGNATURE"
  | "KRDS_READING_UNSUPPORTED_VERSION"
  | "KRDS_READING_TRUNCATED"
  | "KRDS_READING_TYPE_INVALID"
  | "KRDS_READING_OBJECT_LIMIT"
  | "KRDS_READING_VALUE_LIMIT"
  | "KRDS_READING_DEPTH_LIMIT"
  | "KRDS_READING_STRING_LIMIT"
  | "KRDS_READING_DECODED_TOTAL_LIMIT"
  | "KRDS_READING_CONFLICT";

export class KindleKrdsReadingError extends Error {
  readonly code: KindleKrdsReadingErrorCode;

  constructor(code: KindleKrdsReadingErrorCode, message: string) {
    super(message);
    this.name = "KindleKrdsReadingError";
    this.code = code;
  }
}

export interface KindleKrdsReadingParserOptions {
  readonly maxInputBytes?: number;
  readonly maxTopLevelObjects?: number;
  readonly maxObjects?: number;
  readonly maxValues?: number;
  readonly maxObjectValues?: number;
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
  readonly maxDecodedBytes?: number;
}

interface ResolvedLimits {
  readonly maxInputBytes: number;
  readonly maxTopLevelObjects: number;
  readonly maxObjects: number;
  readonly maxValues: number;
  readonly maxObjectValues: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxDecodedBytes: number;
}

interface DecodeBudget {
  objects: number;
  values: number;
  decodedBytes: number;
  readonly limits: ResolvedLimits;
}

interface KrdsBoolean { readonly kind: "boolean"; readonly value: boolean }
interface KrdsInt { readonly kind: "int"; readonly value: number }
interface KrdsLong { readonly kind: "long"; readonly value: bigint }
interface KrdsDouble { readonly kind: "double"; readonly value: number }
interface KrdsShort { readonly kind: "short"; readonly value: number }
interface KrdsFloat { readonly kind: "float"; readonly value: number }
interface KrdsByte { readonly kind: "byte"; readonly value: number }
interface KrdsString { readonly kind: "string"; readonly value: string }
interface KrdsChar { readonly kind: "char"; readonly value: string }
interface KrdsObject {
  readonly kind: "object";
  readonly name: string;
  readonly values: readonly KrdsValue[];
}

type KrdsValue =
  | KrdsBoolean
  | KrdsInt
  | KrdsLong
  | KrdsDouble
  | KrdsShort
  | KrdsFloat
  | KrdsByte
  | KrdsString
  | KrdsChar
  | KrdsObject;

function fail(code: KindleKrdsReadingErrorCode, message: string): never {
  throw new KindleKrdsReadingError(code, message);
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

function resolveLimits(options: KindleKrdsReadingParserOptions): ResolvedLimits {
  return {
    maxInputBytes: boundedInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, 1, HARD_MAX_INPUT_BYTES, "maxInputBytes"),
    maxTopLevelObjects: boundedInteger(options.maxTopLevelObjects, DEFAULT_MAX_TOP_LEVEL_OBJECTS, 1, HARD_MAX_TOP_LEVEL_OBJECTS, "maxTopLevelObjects"),
    maxObjects: boundedInteger(options.maxObjects, DEFAULT_MAX_OBJECTS, 1, HARD_MAX_OBJECTS, "maxObjects"),
    maxValues: boundedInteger(options.maxValues, DEFAULT_MAX_VALUES, 1, HARD_MAX_VALUES, "maxValues"),
    maxObjectValues: boundedInteger(options.maxObjectValues, DEFAULT_MAX_OBJECT_VALUES, 1, HARD_MAX_OBJECT_VALUES, "maxObjectValues"),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, HARD_MAX_DEPTH, "maxDepth"),
    maxStringBytes: boundedInteger(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 1, HARD_MAX_STRING_BYTES, "maxStringBytes"),
    maxDecodedBytes: boundedInteger(options.maxDecodedBytes, DEFAULT_MAX_DECODED_BYTES, 1, HARD_MAX_DECODED_BYTES, "maxDecodedBytes"),
  };
}

function reserveDecoded(budget: DecodeBudget, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.limits.maxDecodedBytes - budget.decodedBytes) {
    fail("KRDS_READING_DECODED_TOTAL_LIMIT", "KRDS decoded data exceeds its aggregate limit.");
  }
  budget.decodedBytes += amount;
}

function reserveValue(budget: DecodeBudget): void {
  if (budget.values >= budget.limits.maxValues) {
    fail("KRDS_READING_VALUE_LIMIT", "KRDS data has too many values.");
  }
  budget.values += 1;
  reserveDecoded(budget, 16);
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #budget: DecodeBudget;
  #offset = 0;

  constructor(bytes: Uint8Array, budget: DecodeBudget) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#budget = budget;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength;
  }

  ensure(length: number): void {
    const end = this.#offset + length;
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(end) || end < this.#offset || end > this.#bytes.byteLength) {
      fail("KRDS_READING_TRUNCATED", "KRDS data is truncated.");
    }
  }

  signature(): void {
    this.ensure(SIGNATURE.byteLength);
    if (!SIGNATURE.every((byte, index) => this.#bytes[this.#offset + index] === byte)) {
      fail("KRDS_READING_INVALID_SIGNATURE", "KRDS signature is invalid.");
    }
    this.#offset += SIGNATURE.byteLength;
  }

  peekInt8(): number {
    this.ensure(1);
    return this.#view.getInt8(this.#offset);
  }

  int8(): number {
    const value = this.peekInt8();
    this.#offset += 1;
    return value;
  }

  int16(): number {
    this.ensure(2);
    const value = this.#view.getInt16(this.#offset, false);
    this.#offset += 2;
    return value;
  }

  uint16(): number {
    this.ensure(2);
    const value = this.#view.getUint16(this.#offset, false);
    this.#offset += 2;
    return value;
  }

  int32(): number {
    this.ensure(4);
    const value = this.#view.getInt32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  int64(): bigint {
    this.ensure(8);
    const value = this.#view.getBigInt64(this.#offset, false);
    this.#offset += 8;
    return value;
  }

  float32(): number {
    this.ensure(4);
    const value = this.#view.getFloat32(this.#offset, false);
    this.#offset += 4;
    if (!Number.isFinite(value)) fail("KRDS_READING_TYPE_INVALID", "KRDS float is not finite.");
    return value;
  }

  float64(): number {
    this.ensure(8);
    const value = this.#view.getFloat64(this.#offset, false);
    this.#offset += 8;
    if (!Number.isFinite(value)) fail("KRDS_READING_TYPE_INVALID", "KRDS double is not finite.");
    return value;
  }

  utf(): string {
    const empty = this.int8();
    if (empty !== 0 && empty !== 1) fail("KRDS_READING_TYPE_INVALID", "KRDS UTF empty marker is invalid.");
    if (empty === 1) return "";
    const length = this.uint16();
    if (length > this.#budget.limits.maxStringBytes) {
      fail("KRDS_READING_STRING_LIMIT", "KRDS string exceeds its byte limit.");
    }
    reserveDecoded(this.#budget, length);
    this.ensure(length);
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(
        this.#bytes.subarray(this.#offset, this.#offset + length),
      );
    } catch {
      fail("KRDS_READING_TYPE_INVALID", "KRDS string is not valid UTF-8.");
    }
    this.#offset += length;
    return value;
  }

  value(depth = 0, explicitType?: number): KrdsValue {
    if (depth > this.#budget.limits.maxDepth) {
      fail("KRDS_READING_DEPTH_LIMIT", "KRDS object nesting exceeds its depth limit.");
    }
    reserveValue(this.#budget);
    const datatype = explicitType ?? this.int8();
    if (datatype === DATATYPE_BOOLEAN) {
      const raw = this.int8();
      if (raw !== 0 && raw !== 1) fail("KRDS_READING_TYPE_INVALID", "KRDS boolean value is invalid.");
      return Object.freeze({ kind: "boolean", value: raw === 1 });
    }
    if (datatype === DATATYPE_INT) return Object.freeze({ kind: "int", value: this.int32() });
    if (datatype === DATATYPE_LONG) return Object.freeze({ kind: "long", value: this.int64() });
    if (datatype === DATATYPE_UTF) return Object.freeze({ kind: "string", value: this.utf() });
    if (datatype === DATATYPE_DOUBLE) return Object.freeze({ kind: "double", value: this.float64() });
    if (datatype === DATATYPE_SHORT) return Object.freeze({ kind: "short", value: this.int16() });
    if (datatype === DATATYPE_FLOAT) return Object.freeze({ kind: "float", value: this.float32() });
    if (datatype === DATATYPE_BYTE) return Object.freeze({ kind: "byte", value: this.int8() });
    if (datatype === DATATYPE_CHAR) {
      this.ensure(1);
      const byte = this.#bytes[this.#offset++]!;
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.of(byte));
      } catch {
        fail("KRDS_READING_TYPE_INVALID", "KRDS character is not valid UTF-8.");
      }
      return Object.freeze({ kind: "char", value });
    }
    if (datatype === DATATYPE_OBJECT_BEGIN) {
      if (this.#budget.objects >= this.#budget.limits.maxObjects) {
        fail("KRDS_READING_OBJECT_LIMIT", "KRDS data has too many objects.");
      }
      this.#budget.objects += 1;
      const name = this.utf();
      if (name.length === 0) fail("KRDS_READING_TYPE_INVALID", "KRDS object name is empty.");
      const values: KrdsValue[] = [];
      while (this.peekInt8() !== DATATYPE_OBJECT_END) {
        if (values.length >= this.#budget.limits.maxObjectValues) {
          fail("KRDS_READING_VALUE_LIMIT", "KRDS object has too many values.");
        }
        values.push(this.value(depth + 1));
      }
      this.int8();
      return Object.freeze({ kind: "object", name, values: Object.freeze(values) });
    }
    fail("KRDS_READING_TYPE_INVALID", "KRDS datatype is unsupported or misplaced.");
  }
}

function isInt(value: KrdsValue | undefined, expected?: number): value is KrdsInt {
  return value?.kind === "int" && (expected === undefined || value.value === expected);
}

function longMilliseconds(value: KrdsValue | undefined): number | undefined {
  if (value?.kind !== "long" || value.value < 0n || value.value > BigInt(MAX_TIMESTAMP_MILLISECONDS)) return undefined;
  return Number(value.value);
}

function allObjects(values: readonly KrdsValue[]): readonly KrdsObject[] {
  const result: KrdsObject[] = [];
  const visit = (value: KrdsValue): void => {
    if (value.kind !== "object") return;
    result.push(value);
    for (const child of value.values) visit(child);
  };
  for (const value of values) visit(value);
  return result;
}

function parseContainer(bytes: Uint8Array, limits: ResolvedLimits): readonly KrdsValue[] {
  if (bytes.byteLength > limits.maxInputBytes) {
    fail("KRDS_READING_INPUT_LIMIT", "KRDS sidecar exceeds its input limit.");
  }
  const budget: DecodeBudget = { objects: 0, values: 0, decodedBytes: 0, limits };
  const reader = new Reader(bytes, budget);
  reader.signature();
  const version = reader.value();
  if (!isInt(version, SUPPORTED_CONTAINER_VERSION)) {
    fail("KRDS_READING_UNSUPPORTED_VERSION", "KRDS container version is not supported.");
  }
  const count = reader.value();
  if (!isInt(count) || count.value < 0 || count.value > limits.maxTopLevelObjects) {
    fail("KRDS_READING_OBJECT_LIMIT", "KRDS top-level object count is invalid or exceeds its limit.");
  }
  const values: KrdsValue[] = [];
  const names = new Set<string>();
  for (let index = 0; index < count.value; index += 1) {
    const value = reader.value();
    if (value.kind !== "object") fail("KRDS_READING_TYPE_INVALID", "KRDS top-level value is not an object.");
    if (names.has(value.name)) fail("KRDS_READING_CONFLICT", "KRDS contains a duplicate top-level object.");
    names.add(value.name);
    values.push(value);
  }
  if (!reader.done) fail("KRDS_READING_CONFLICT", "KRDS sidecar has trailing data.");
  return Object.freeze(values);
}

function progressFromTimerModel(object: KrdsObject): number | undefined {
  if (object.values.length < 5) fail("KRDS_READING_TYPE_INVALID", "KRDS timer.model is truncated.");
  const [version, totalTime, totalWords, totalPercent, averageCalculator] = object.values;
  if (
    version?.kind !== "long"
    || (version.value !== 1n && version.value !== 2n)
    || totalTime?.kind !== "long"
    || totalTime.value < 0n
    || totalWords?.kind !== "long"
    || totalWords.value < 0n
    || totalPercent?.kind !== "double"
    || totalPercent.value < 0
    || totalPercent.value > 1
    || averageCalculator?.kind !== "object"
    || averageCalculator.name !== "timer.average.calculator"
  ) {
    fail("KRDS_READING_TYPE_INVALID", "KRDS timer.model fields are invalid or unsupported.");
  }
  return Math.round(totalPercent.value * 10_000) / 100;
}

function versionNumber(value: KrdsValue | undefined): number | undefined {
  if (value?.kind === "int") return value.value;
  if (value?.kind !== "long" || value.value < 0n || value.value > 2n) return undefined;
  return Number(value.value);
}

function timestampMilliseconds(value: KrdsValue | undefined, label: string): number | undefined {
  if (value?.kind !== "long") fail("KRDS_READING_TYPE_INVALID", `KRDS ${label} timestamp is not a long.`);
  if (value.value === -1n) return undefined;
  const timestamp = longMilliseconds(value);
  if (timestamp === undefined) fail("KRDS_READING_TYPE_INVALID", `KRDS ${label} timestamp is out of range.`);
  return timestamp;
}

function lprTimestamp(object: KrdsObject): number | undefined {
  if (object.name === "lpr") {
    const [version, position, timestamp] = object.values;
    if (version?.kind === "string") {
      if (object.values.length !== 1) fail("KRDS_READING_CONFLICT", "Old-style KRDS lpr has conflicting trailing values.");
      return undefined;
    }
    const numericVersion = versionNumber(version);
    if (numericVersion === undefined || numericVersion < 0 || numericVersion > 2) {
      fail("KRDS_READING_UNSUPPORTED_VERSION", "KRDS lpr version is not supported.");
    }
    if (position?.kind !== "string") fail("KRDS_READING_TYPE_INVALID", "KRDS lpr position is not a string.");
    return timestampMilliseconds(timestamp, "lpr");
  }
  if (object.name === "updated_lpr") {
    if (object.values[0]?.kind !== "string") {
      fail("KRDS_READING_TYPE_INVALID", "KRDS updated_lpr position is not a string.");
    }
    return timestampMilliseconds(object.values[1], "updated_lpr");
  }
  return undefined;
}

/**
 * Parses only KRDS fields whose semantics are documented for reading progress.
 * Percent can establish `in-progress`, never authoritative Read/Unread.
 */
export function parseKindleKrdsReadingEvidence(
  bytes: Uint8Array,
  provenance: KindleReadingSidecarFormat,
  options: KindleKrdsReadingParserOptions = {},
): KindleReadingEvidence {
  const objects = allObjects(parseContainer(bytes, resolveLimits(options)));
  const progressValues: number[] = [];
  const timestamps: number[] = [];
  for (const object of objects) {
    if (object.name === "timer.model") progressValues.push(progressFromTimerModel(object)!);
    const timestamp = lprTimestamp(object);
    if (timestamp !== undefined) timestamps.push(timestamp);
  }
  const distinctProgress = new Set(progressValues);
  if (distinctProgress.size > 1) {
    fail("KRDS_READING_CONFLICT", "KRDS sidecar has conflicting timer progress values.");
  }
  const progressPercent = progressValues[0];
  const lastReadMilliseconds = timestamps.length === 0 ? undefined : Math.max(...timestamps);
  const evidence = validateKindleReadingEvidence({
    status: progressPercent !== undefined && progressPercent > 0 ? "in-progress" : "unknown",
    ...(progressPercent === undefined ? {} : { progressPercent }),
    ...(lastReadMilliseconds === undefined ? {} : { lastReadAt: new Date(lastReadMilliseconds).toISOString() }),
    provenance,
    freshness: "live",
    explicitState: false,
  });
  if (evidence === undefined) fail("KRDS_READING_TYPE_INVALID", "KRDS evidence did not satisfy the reading-state contract.");
  return evidence;
}
