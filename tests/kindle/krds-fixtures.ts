import { concatBytes } from "./kfx-fixtures";

const encoder = new TextEncoder();
const SIGNATURE = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26);

function i32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, false);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, false);
  return bytes;
}

function f64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

function rawUtf(value: string): Uint8Array {
  if (value.length === 0) return Uint8Array.of(1);
  const encoded = encoder.encode(value);
  if (encoded.byteLength > 0xffff) throw new RangeError("fixture string too long");
  return concatBytes(Uint8Array.of(0, encoded.byteLength >>> 8, encoded.byteLength & 0xff), encoded);
}

export function krdsInt(value: number): Uint8Array {
  return concatBytes(Uint8Array.of(1), i32(value));
}

export function krdsLong(value: bigint | number): Uint8Array {
  return concatBytes(Uint8Array.of(2), i64(BigInt(value)));
}

export function krdsDouble(value: number): Uint8Array {
  return concatBytes(Uint8Array.of(4), f64(value));
}

export function krdsString(value: string): Uint8Array {
  return concatBytes(Uint8Array.of(3), rawUtf(value));
}

export function krdsObject(name: string, ...values: readonly Uint8Array[]): Uint8Array {
  return concatBytes(Uint8Array.of(0xfe), rawUtf(name), ...values, Uint8Array.of(0xff));
}

export function krdsContainer(...objects: readonly Uint8Array[]): Uint8Array {
  return concatBytes(SIGNATURE, krdsInt(1), krdsInt(objects.length), ...objects);
}

export function timerModel(progressFraction: number): Uint8Array {
  return krdsObject(
    "timer.model",
    krdsLong(1),
    krdsLong(60_000),
    krdsLong(250),
    krdsDouble(progressFraction),
    krdsObject(
      "timer.average.calculator",
      krdsInt(0),
      krdsInt(0),
      krdsInt(0),
      krdsInt(0),
    ),
  );
}

export function lpr(timestampMilliseconds: number): Uint8Array {
  return krdsObject("lpr", krdsInt(2), krdsString("position-opaque"), krdsLong(timestampMilliseconds));
}

export function readingKrdsFixture(
  progressFraction = 0.42,
  timestampMilliseconds = Date.UTC(2026, 8, 3, 12, 0, 0),
): Uint8Array {
  return krdsContainer(timerModel(progressFraction), lpr(timestampMilliseconds));
}
